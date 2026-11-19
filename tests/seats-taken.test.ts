import {describe, expect, it} from 'vitest';

import {seatsTakenWhere} from '../src/server/routes/rsvp';

describe('seatsTakenWhere (M-10: public seats left matches bookings)', () => {
  it('counts held seats and seats under an open paid-waitlist claim, nothing else', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    expect(seatsTakenWhere('e1', now)).toEqual({
      eventId: 'e1',
      response: 'going',
      OR: [{status: {in: ['confirmed', 'awaiting_payment']}}, {status: 'waitlisted', claimExpiresAt: {gt: now}}],
    });
  });
});
