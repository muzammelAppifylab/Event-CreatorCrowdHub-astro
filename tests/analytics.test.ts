import {describe, expect, it} from 'vitest';

import {
  conversion,
  goingCount,
  normaliseSource,
  pollParticipation,
  revenueByCurrency,
  ratio,
  showRate,
  topSources,
  viewsDayRange,
  zeroFillDays,
} from '../src/server/routes/admin-analytics';
import {BEACON_LIMIT, utcDay, visitorHash} from '../src/server/routes/pageviews';

const base = {salt: 'a'.repeat(64), ip: '203.0.113.7', userAgent: 'UA/1', eventId: 'e1'};

describe('visitorHash', () => {
  it('is a stable sha256 hex that does not contain the ip', async () => {
    const a = await visitorHash(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(await visitorHash(base));
    expect(a).not.toContain('203.0.113.7');
  });
  it('differs per ip, user agent, event and day salt', async () => {
    const a = await visitorHash(base);
    for (const change of [{ip: '203.0.113.8'}, {userAgent: 'UA/2'}, {eventId: 'e2'}, {salt: 'b'.repeat(64)}]) {
      expect(await visitorHash({...base, ...change})).not.toBe(a);
    }
  });
  it('separates fields so concatenations cannot collide', async () => {
    expect(await visitorHash({...base, ip: '1.2.3.4', userAgent: '5x'})).not.toBe(await visitorHash({...base, ip: '1.2.3.45', userAgent: 'x'}));
  });
  it('utcDay is the UTC date', () => expect(utcDay(new Date('2026-10-30T23:59:59-05:00'))).toBe('2026-10-31'));
});

describe('beacon limits', () => {
  // Counted in the database (src/server/rate-attempts.ts; tests/rate-attempts.test.ts).
  it('caps per network and per event, per minute', () => {
    expect(BEACON_LIMIT.perIp).toBeGreaterThan(0);
    expect(BEACON_LIMIT.perEvent).toBeGreaterThan(BEACON_LIMIT.perIp);
    expect(BEACON_LIMIT.windowMs).toBe(60_000);
  });
});

describe('metrics', () => {
  it('normalises sources', () => {
    expect(normaliseSource('  Newsletter ')).toBe('newsletter');
    expect(normaliseSource('')).toBeNull();
    expect(normaliseSource(null)).toBeNull();
    expect(normaliseSource('x'.repeat(100))).toHaveLength(64);
  });
  it('ratio is null with a reason when there is nothing to divide by', () => {
    expect(ratio(1, 0, 'none')).toEqual({value: null, numerator: 1, denominator: 0, reason: 'none'});
    expect(conversion(5, 20).value).toBe(0.25);
  });
  it('show rate waits for the event to end and counts only confirmed going guests', () => {
    const rows = [
      {response: 'going', status: 'confirmed', count: 4, showedUp: 3},
      {response: 'maybe', status: 'confirmed', count: 2, showedUp: 2},
      {response: 'going', status: 'cancelled', count: 1, showedUp: 0},
    ];
    expect(goingCount(rows)).toBe(4);
    expect(showRate(rows, false).value).toBeNull();
    expect(showRate(rows, true).value).toBe(0.75);
    expect(showRate([], true).reason).toBe('No confirmed going guests.');
  });
  it('zero-fills a lifetime of at most 14 days, oldest first, and never inverts', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const range = viewsDayRange({createdAt: new Date('2026-10-28T08:00:00Z'), endAt: new Date('2026-12-01T00:00:00Z')}, now);
    expect(range).toEqual({firstDay: '2026-10-28', lastDay: '2026-10-30'});
    expect(zeroFillDays(range, [{date: '2026-10-29', count: 5}])).toEqual([
      {date: '2026-10-28', views: 0},
      {date: '2026-10-29', views: 5},
      {date: '2026-10-30', views: 0},
    ]);
    const long = viewsDayRange({createdAt: new Date('2026-01-01T00:00:00Z'), endAt: new Date('2027-01-01T00:00:00Z')}, now);
    expect(zeroFillDays(long, [])).toHaveLength(14);
    const future = viewsDayRange({createdAt: new Date('2027-05-01T00:00:00Z'), endAt: new Date('2027-06-01T00:00:00Z')}, now);
    expect(future.firstDay <= future.lastDay).toBe(true);
  });
  it('merges view and RSVP sources, direct included, sorted and capped', () => {
    const rows = topSources(
      [{source: 'Twitter', count: 3}, {source: null, count: 10}, {source: 'twitter', count: 2}],
      [{source: 'twitter', count: 4}, {source: 'mail', count: 1}],
      2
    );
    expect(rows).toEqual([
      {source: null, views: 10, rsvps: 0},
      {source: 'twitter', views: 5, rsvps: 4},
    ]);
  });
});

describe('revenue and poll participation', () => {
  it('sums paid orders per currency, biggest first, and merges case variants', () => {
    expect(
      revenueByCurrency([
        {currency: 'usd', amountCents: 1000, orders: 1},
        {currency: 'EUR', amountCents: 5000, orders: 2},
        {currency: 'USD', amountCents: 500, orders: 1},
      ])
    ).toEqual([
      {currency: 'EUR', amountCents: 5000, orders: 2},
      {currency: 'USD', amountCents: 1500, orders: 2},
    ]);
    expect(revenueByCurrency([])).toEqual([]);
  });
  it('participation is answers over confirmed guests, null without guests', () => {
    expect(pollParticipation(3, 4).value).toBe(0.75);
    expect(pollParticipation(0, 0)).toMatchObject({value: null, reason: 'No confirmed guests.'});
  });
});
