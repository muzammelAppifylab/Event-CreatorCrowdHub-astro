import {describe, expect, it} from 'vitest';

import {summarize} from '../src/server/routes/admin-overview';

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
