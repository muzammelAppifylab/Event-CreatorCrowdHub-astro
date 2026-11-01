import {describe, expect, it} from 'vitest';

import {
  availabilityOf, canRsvp, countdownParts, ctaLabel, ctaNote, formatClock, formatPrice, formatRange, formatShortWhen,
  guestCopy, paragraphsOf, priceSummary,
} from '../src/lib/guest-format';

const now = new Date('2026-10-20T12:00:00Z');
const end = '2026-11-01T20:00:00Z';
const open = {status: 'published' as const, closed: false, seatsLeft: 5, waitlistEnabled: false};

describe('availabilityOf', () => {
  it('cancelled beats everything', () => expect(availabilityOf({...open, status: 'cancelled', closed: true}, '2020-01-01T00:00:00Z', now)).toEqual({kind: 'cancelled'}));
  it('ended beats closed and full', () => expect(availabilityOf({...open, closed: true, seatsLeft: 0}, '2026-10-01T00:00:00Z', now)).toEqual({kind: 'ended'}));
  it('closed beats full', () => expect(availabilityOf({...open, closed: true, seatsLeft: 0}, end, now)).toEqual({kind: 'closed'}));
  it('full vs waitlist', () => {
    expect(availabilityOf({...open, seatsLeft: 0}, end, now)).toEqual({kind: 'full'});
    expect(availabilityOf({...open, seatsLeft: 0, waitlistEnabled: true}, end, now)).toEqual({kind: 'waitlist'});
  });
  it('open with remaining or unlimited', () => {
    expect(availabilityOf(open, end, now)).toEqual({kind: 'open', remaining: 5});
    expect(availabilityOf({...open, seatsLeft: null}, end, now)).toEqual({kind: 'open', remaining: null});
  });
  it('the end instant is already ended', () => expect(availabilityOf(open, now.toISOString(), now).kind).toBe('ended'));
  it('canRsvp only for open and waitlist', () => {
    expect(canRsvp({kind: 'open', remaining: null})).toBe(true);
    expect(canRsvp({kind: 'waitlist'})).toBe(true);
    for (const kind of ['full', 'closed', 'ended', 'cancelled'] as const) expect(canRsvp({kind})).toBe(false);
  });
});

describe('prices', () => {
  it('formats free, whole and fractional amounts', () => {
    expect(formatPrice(0, 'USD')).toBe('Free');
    expect(formatPrice(4900, 'USD')).toBe('$49');
    expect(formatPrice(4950, 'USD')).toBe('$49.50');
  });
  it('falls back on an unknown currency code', () => expect(formatPrice(1000, 'not a code')).toBe('10.00 not a code'));
  it('priceSummary: free, single, from', () => {
    expect(priceSummary([])).toBe('Free');
    expect(priceSummary([{priceCents: 0, currency: 'USD'}])).toBe('Free');
    expect(priceSummary([{priceCents: 4900, currency: 'USD'}])).toBe('$49');
    expect(priceSummary([{priceCents: 4900, currency: 'USD'}, {priceCents: 2500, currency: 'USD'}])).toBe('From $25');
  });
});

describe('cta', () => {
  const o = {approvalRequired: false, hasTickets: false, capacityLimited: false};
  it('labels', () => {
    expect(ctaLabel({kind: 'open', remaining: null}, o)).toBe('RSVP');
    expect(ctaLabel({kind: 'open', remaining: 3}, {...o, capacityLimited: true})).toBe('Save my seat');
    expect(ctaLabel({kind: 'open', remaining: null}, {...o, hasTickets: true})).toBe('Save my seat');
    expect(ctaLabel({kind: 'open', remaining: null}, {...o, approvalRequired: true})).toBe('Request to join');
    expect(ctaLabel({kind: 'waitlist'}, o)).toBe('Join waitlist');
    expect(ctaLabel({kind: 'full'}, o)).toBe('Full');
    expect(ctaLabel({kind: 'closed'}, o)).toBe('RSVPs closed');
    expect(ctaLabel({kind: 'ended'}, o)).toBe('Event ended');
    expect(ctaLabel({kind: 'cancelled'}, o)).toBe('Cancelled');
  });
  it('notes', () => {
    expect(ctaNote({kind: 'open', remaining: 1}, false)).toBe('1 seat left');
    expect(ctaNote({kind: 'open', remaining: 4}, true)).toBe('4 seats left · The host approves each guest.');
    expect(ctaNote({kind: 'open', remaining: null}, false)).toBe('');
    expect(ctaNote({kind: 'full'}, false)).toContain('no waitlist');
    expect(ctaNote({kind: 'waitlist'}, false)).toContain('email you');
  });
});

describe('countdownParts', () => {
  const H = 3600_000;
  it('days show hours and minutes, no seconds', () => expect(countdownParts(2 * 24 * H + 3 * H + 5 * 60_000 + 9000, true)).toEqual([[2, 'd'], [3, 'h'], [5, 'm']]));
  it('under a day shows hours', () => expect(countdownParts(3 * H, false)).toEqual([[3, 'h'], [0, 'm']]));
  it('last hour has seconds only when asked', () => {
    expect(countdownParts(5 * 60_000 + 7000, true)).toEqual([[5, 'm'], [7, 's']]);
    expect(countdownParts(5 * 60_000 + 7000, false)).toEqual([[5, 'm']]);
  });
  it('zero', () => expect(countdownParts(0, false)).toEqual([[0, 'm']]));
});

describe('date formatting', () => {
  it('formats in the zone', () => {
    expect(formatClock('2026-11-01T18:30:00Z', 'Europe/London')).toBe('18:30');
    expect(formatShortWhen('2026-10-27T18:30:00Z', 'UTC')).toContain('27 Oct');
    expect(formatRange('2026-11-01T18:00:00Z', '2026-11-01T20:00:00Z', 'Europe/London')).toMatch(/^18:00–20:00 GMT/);
    expect(formatRange('2026-11-01T18:00:00Z', undefined, 'UTC')).toMatch(/^18:00 UTC/);
  });
  it('returns empty on a bad zone', () => {
    expect(formatClock('2026-11-01T18:30:00Z', 'Bad/Zone')).toBe('');
    expect(formatRange('2026-11-01T18:30:00Z', undefined, 'Bad/Zone')).toBe('');
  });
  it('paragraphsOf splits on blank lines', () => expect(paragraphsOf('a\nb\n\n  \n\n c ')).toEqual(['a\nb', 'c']));
  it('copy helpers', () => {
    expect(guestCopy.cta.seatsLeft(2)).toBe('2 seats left');
    expect(guestCopy.confirmation.seatsFor('Ada', 2)).toBe('Ada + 2');
    expect(guestCopy.confirmation.seats(1)).toBe('1 seat');
  });
});
