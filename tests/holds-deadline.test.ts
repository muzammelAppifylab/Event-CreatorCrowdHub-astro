import {describe, expect, it, vi} from 'vitest';

import {FakeDb} from './ticket-fake-db';

vi.mock('../src/server/jobs/guest-emails', () => ({
  GUEST_EMAIL_LIST: 'rsvp-emails',
  queueGuestEmail: async () => undefined,
  queueGuestEmails: async () => undefined,
  sendGuestEmail: vi.fn(),
}));

import {appConfig} from '../src/config/app.config';
import {expireCheckoutHolds} from '../src/server/jobs/holds';

const asDb = (db: FakeDb) => db as never;
const NOW = new Date('2026-11-12T12:00:00Z');
const lapsed = (i: number) => new Date(NOW.getTime() - (appConfig.checkoutHoldMinutes + 10 + i) * 60_000);

function threeLapsedHolds() {
  const db = new FakeDb();
  const event = db.addEvent();
  for (let i = 0; i < 3; i++) db.addOrder(db.addRsvp(event.id).id, {createdAt: lapsed(i)});
  return db;
}

describe('expireCheckoutHolds: the scheduler deadline', () => {
  it('releases nothing once the deadline has passed; the next tick picks them up', async () => {
    const db = threeLapsedHolds();
    expect((await expireCheckoutHolds(asDb(db), NOW, undefined, {deadline: Date.now() - 1})).released).toEqual([]);
    expect((await expireCheckoutHolds(asDb(db), NOW)).released).toHaveLength(3);
  });

  it('stops between holds when the deadline is reached mid-sweep', async () => {
    const db = threeLapsedHolds();
    const spy = vi.spyOn(Date, 'now');
    const start = 1_000_000;
    // The first check (before hold 1) is in time; every later one is past the deadline.
    let calls = 0;
    spy.mockImplementation(() => (calls++ < 1 ? start : start + 10));
    try {
      const run = await expireCheckoutHolds(asDb(db), NOW, undefined, {deadline: start + 5});
      expect(run.released).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect((await expireCheckoutHolds(asDb(db), NOW)).released).toHaveLength(2);
  });

  it('without a deadline, releases up to the limit as before', async () => {
    const db = threeLapsedHolds();
    expect((await expireCheckoutHolds(asDb(db), NOW, 2)).released).toHaveLength(2);
  });
});
