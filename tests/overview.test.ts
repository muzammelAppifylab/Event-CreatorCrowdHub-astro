import {describe, expect, it} from 'vitest';

import {formatChange} from '../src/portal/overview-format';
import {periodWindows, summarize} from '../src/server/routes/admin-overview';

describe('30-day windows', () => {
  it('splits into the last 30 days and the 30 before, touching but not overlapping', () => {
    const now = new Date('2026-06-30T00:00:00Z');
    const w = periodWindows(now);
    expect(w.current.to).toEqual(now);
    expect(w.current.from).toEqual(new Date('2026-05-31T00:00:00Z'));
    expect(w.previous.to).toEqual(w.current.from);
    expect(w.previous.from).toEqual(new Date('2026-05-01T00:00:00Z'));
  });
  it('formats change', () => {
    expect(formatChange(15, 10)).toBe('+50%');
    expect(formatChange(5, 10)).toBe('-50%');
    expect(formatChange(10, 10)).toBe('0%');
    expect(formatChange(3, 0)).toBe('–');
  });
});

describe('overview summarize', () => {
  it('sums seats for confirmed, guests for waitlisted and pending, per event', () => {
    const r = summarize([
      {eventId: 'a', status: 'confirmed', guests: 2, seats: 5},
      {eventId: 'a', status: 'waitlisted', guests: 3, seats: 3},
      {eventId: 'b', status: 'confirmed', guests: 1, seats: 1},
      {eventId: 'b', status: 'pending', guests: 4, seats: 4},
      {eventId: 'b', status: 'declined', guests: 9, seats: 9},
    ]);
    expect(r.totals).toEqual({going: 6, waitlisted: 3, pending: 4});
    expect(r.perEvent.a).toEqual({going: 5, waitlisted: 3, pending: 0});
    expect(r.perEvent.b).toEqual({going: 1, waitlisted: 0, pending: 4});
  });
  it('is empty for no rows', () => {
    expect(summarize([]).totals).toEqual({going: 0, waitlisted: 0, pending: 0});
  });
});
