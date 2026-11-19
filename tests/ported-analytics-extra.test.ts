import {describe, expect, it} from 'vitest';

import {
  MAX_SOURCES, VIEWS_WINDOW_DAYS, conversion, goingCount, maybeCount, normaliseSource, pollParticipation, ratio, revenueByCurrency,
  showRate, topSources, viewsDayRange, zeroFillDays,
} from '../src/server/routes/admin-analytics';
import {BEACON_LIMIT, visitorHash} from '../src/server/routes/pageviews';

describe('normaliseSource', () => {
  it('trims, lowercases, caps at 64, and maps blank/null to null', () => {
    expect(normaliseSource('  Twitter ')).toBe('twitter');
    expect(normaliseSource('a'.repeat(100))).toHaveLength(64);
    expect(normaliseSource('   ')).toBeNull();
    expect(normaliseSource(null)).toBeNull();
    expect(normaliseSource(undefined)).toBeNull();
  });
});

describe('ratio / conversion / participation', () => {
  it('zero denominator gives null with the reason; otherwise the quotient', () => {
    expect(ratio(3, 0, 'none')).toMatchObject({value: null, reason: 'none'});
    expect(ratio(1, 4, 'x').value).toBe(0.25);
    expect(conversion(5, 0).reason).toBe('No page views recorded yet.');
    expect(conversion(5, 10).value).toBe(0.5);
    expect(pollParticipation(0, 0).value).toBeNull();
    expect(pollParticipation(6, 3).value).toBe(2);
  });
});

describe('going / maybe / show rate', () => {
  const rows = [
    {response: 'going', status: 'confirmed', count: 8, showedUp: 6},
    {response: 'going', status: 'waitlisted', count: 4, showedUp: 0},
    {response: 'maybe', status: 'confirmed', count: 3, showedUp: 3},
    {response: 'not_going', status: 'confirmed', count: 2, showedUp: 0},
  ];
  it('counts only confirmed responses of each kind', () => {
    expect(goingCount(rows)).toBe(8);
    expect(maybeCount(rows)).toBe(3);
  });
  it('show rate ignores maybes and non-confirmed, and waits for the end', () => {
    expect(showRate(rows, true).value).toBe(0.75);
    const before = showRate(rows, false);
    expect(before.value).toBeNull();
    expect(before.reason).toMatch(/after the event/i);
    expect(showRate([], true).value).toBeNull();
  });
});

describe('viewsDayRange / zeroFillDays', () => {
  const day = 86400_000;
  it('a still-running long event shows the last 14 days up to today', () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const r = viewsDayRange({createdAt: new Date(now.getTime() - 60 * day), endAt: new Date(now.getTime() + 5 * day)}, now);
    expect(r.lastDay).toBe('2026-10-30');
    expect(zeroFillDays(r, [])).toHaveLength(VIEWS_WINDOW_DAYS);
  });
  it('an ended event stops at its end day', () => {
    const r = viewsDayRange({createdAt: new Date('2026-10-01T00:00:00Z'), endAt: new Date('2026-10-05T12:00:00Z')}, new Date('2026-10-30T00:00:00Z'));
    expect(r).toEqual({firstDay: '2026-10-01', lastDay: '2026-10-05'});
  });
  it('an event created after it ended (clock skew) never inverts', () => {
    const r = viewsDayRange({createdAt: new Date('2026-10-20T00:00:00Z'), endAt: new Date('2026-10-10T00:00:00Z')}, new Date('2026-10-30T00:00:00Z'));
    expect(r.firstDay <= r.lastDay).toBe(true);
    expect(zeroFillDays(r, []).length).toBeGreaterThanOrEqual(1);
  });
  it('zero fill places counts on the right days and drops days outside the range', () => {
    const out = zeroFillDays({firstDay: '2026-10-01', lastDay: '2026-10-03'}, [{date: '2026-10-02', count: 4}, {date: '2026-09-01', count: 9}]);
    expect(out).toEqual([{date: '2026-10-01', views: 0}, {date: '2026-10-02', views: 4}, {date: '2026-10-03', views: 0}]);
  });
});

describe('topSources', () => {
  it('merges case variants, keeps direct (null) separate, sorts and caps', () => {
    const views = [{source: 'Twitter', count: 5}, {source: 'twitter', count: 2}, {source: null, count: 9}, {source: '', count: 1}];
    const rsvps = [{source: 'twitter', count: 3}, {source: 'mail', count: 1}];
    const rows = topSources(views, rsvps);
    expect(rows[0]).toEqual({source: null, views: 10, rsvps: 0});
    expect(rows[1]).toEqual({source: 'twitter', views: 7, rsvps: 3});
    expect(rows[2]).toEqual({source: 'mail', views: 0, rsvps: 1});
  });
  it('caps at MAX_SOURCES by default', () => {
    const many = Array.from({length: 30}, (_, i) => ({source: `s${i}`, count: i + 1}));
    expect(topSources(many, [])).toHaveLength(MAX_SOURCES);
    expect(topSources(many, [], 3)).toHaveLength(3);
  });
});

describe('revenueByCurrency', () => {
  it('merges case variants, orders biggest first', () => {
    const out = revenueByCurrency([{currency: 'usd', amountCents: 500, orders: 1}, {currency: 'USD', amountCents: 500, orders: 2}, {currency: 'eur', amountCents: 2000, orders: 1}]);
    expect(out).toEqual([{currency: 'EUR', amountCents: 2000, orders: 1}, {currency: 'USD', amountCents: 1000, orders: 3}]);
  });
  it('empty in, empty out', () => expect(revenueByCurrency([])).toEqual([]));
});

// The beacon limiter is in the database now (src/server/rate-attempts.ts, tests/rate-attempts.test.ts).
describe('beacon limits', () => {
  it('beacon limits are sane', () => {
    expect(BEACON_LIMIT.perIp).toBeLessThan(BEACON_LIMIT.perEvent);
    expect(BEACON_LIMIT.windowMs).toBe(60_000);
  });
});

describe('visitorHash', () => {
  const base = {salt: 'f'.repeat(64), ip: '203.0.113.7', userAgent: 'UA', eventId: 'e1'};
  it('is 64 hex chars and does not contain the ip or ua', async () => {
    const h = await visitorHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('203');
  });
  it('is the same under one day salt and differs under the next (random daily salt, L-43)', async () => {
    const a = await visitorHash(base);
    expect(await visitorHash(base)).toBe(a);
    expect(await visitorHash({...base, salt: '0'.repeat(64)})).not.toBe(a);
  });
});
