import {beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeDb} from './ticket-fake-db';

const queued: Array<{kind: string; rsvpId: string; stamp?: string}> = [];
vi.mock('../src/server/jobs/guest-emails', () => ({
  GUEST_EMAIL_LIST: 'rsvp-emails',
  queueGuestEmail: async (kind: string, rsvpId: string, stamp?: string) => void queued.push({kind, rsvpId, stamp}),
  queueGuestEmails: async (items: Array<{kind: string; rsvpId: string; stamp?: string}>) => void queued.push(...items.map(({kind, rsvpId, stamp}) => ({kind, rsvpId, stamp}))),
  sendGuestEmail: vi.fn(),
}));
const privacy = vi.hoisted(() => ({
  expiredGuestIds: vi.fn(),
  eraseRsvp: vi.fn(),
  restoredErasedIds: vi.fn(async () => [] as string[]),
  deleteExpiredInvites: vi.fn(async () => 0),
  prunePrivacyAttempts: vi.fn(async () => 0),
}));
vi.mock('../src/server/privacy', async orig => ({...(await orig<object>()), ...privacy}));

import {appConfig} from '../src/config/app.config';
import {expireCheckoutHolds, releaseHold} from '../src/server/jobs/holds';
import {runReminders} from '../src/server/jobs/reminders';
import {RETENTION_BATCH_SIZE, RETENTION_MAX_BATCHES, runRetention} from '../src/server/jobs/retention';
import {runScheduler} from '../src/server/jobs/run';
import {PERMANENT_ERROR_PREFIX} from '../src/server/jobs/shared';
import {eventsWithLapsedClaims, expireEventClaims} from '../src/server/jobs/waitlist';

const asDb = (db: FakeDb) => db as never;
const MIN = 60_000;
const NOW = new Date('2026-11-12T12:00:00Z');
const at = (m: number) => new Date(NOW.getTime() + m * MIN);
const holdMin = appConfig.checkoutHoldMinutes;

beforeEach(() => {
  queued.length = 0;
  privacy.expiredGuestIds.mockReset();
  privacy.eraseRsvp.mockReset();
});

describe('releaseHold', () => {
  it('unknown RSVP and non-awaiting RSVPs are not released and email nothing', async () => {
    const db = new FakeDb();
    const event = db.addEvent();
    const confirmed = db.addRsvp(event.id, {status: 'confirmed'});
    expect(await releaseHold(asDb(db), 'missing', NOW)).toEqual({released: false, promoted: []});
    expect(await releaseHold(asDb(db), confirmed.id, NOW)).toMatchObject({released: false});
    expect(db.rsvp.rows[0]!.status).toBe('confirmed');
    expect(queued).toEqual([]);
  });

  it('concurrent releases free the seat once and queue one hold_expired', async () => {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1});
    const guest = db.addRsvp(event.id);
    db.addOrder(guest.id, {createdAt: at(-100)});
    const [a, b] = await Promise.all([releaseHold(asDb(db), guest.id, NOW), releaseHold(asDb(db), guest.id, NOW)]);
    expect([a.released, b.released].sort()).toEqual([false, true]);
    expect(queued.filter(q => q.kind === 'hold_expired')).toHaveLength(1);
  });

  it('a paid order is not touched by a release (only pending -> expired)', async () => {
    const db = new FakeDb();
    const event = db.addEvent();
    const guest = db.addRsvp(event.id);
    db.addOrder(guest.id, {status: 'paid'});
    await releaseHold(asDb(db), guest.id, NOW);
    expect(db.ticketOrder.rows[0]!.status).toBe('paid');
  });

  it('a cancelled event promotes nobody when a hold is released', async () => {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1, status: 'cancelled'});
    const guest = db.addRsvp(event.id);
    const w = db.addRsvp(event.id, {status: 'waitlisted', waitlistPosition: 1});
    await releaseHold(asDb(db), guest.id, NOW);
    expect(db.rsvp.rows.find(r => r.id === w.id)!.status).toBe('waitlisted');
  });
});

describe('expireCheckoutHolds boundaries', () => {
  it('a hold exactly at the cutoff lapses, one a minute younger does not', async () => {
    const db = new FakeDb();
    const event = db.addEvent();
    const a = db.addRsvp(event.id, {updatedAt: at(0)});
    const b = db.addRsvp(event.id, {updatedAt: at(0)});
    db.addOrder(a.id, {createdAt: at(-holdMin)});
    db.addOrder(b.id, {createdAt: at(-holdMin + 1)});
    expect((await expireCheckoutHolds(asDb(db), NOW)).released).toEqual([a.id]);
  });

  it('is bounded by the limit; the rest lapses on the next sweep', async () => {
    const db = new FakeDb();
    const event = db.addEvent();
    for (let i = 0; i < 5; i++) db.addOrder(db.addRsvp(event.id).id, {createdAt: at(-holdMin - 10 - i)});
    expect((await expireCheckoutHolds(asDb(db), NOW, 2)).released).toHaveLength(2);
    expect((await expireCheckoutHolds(asDb(db), NOW, 10)).released).toHaveLength(3);
    expect((await expireCheckoutHolds(asDb(db), NOW, 10)).released).toHaveLength(0);
  });

  it('never releases a paid (confirmed) guest even with an old pending order row', async () => {
    const db = new FakeDb();
    const event = db.addEvent();
    const g = db.addRsvp(event.id, {status: 'confirmed'});
    db.addOrder(g.id, {createdAt: at(-1000)});
    expect((await expireCheckoutHolds(asDb(db), NOW)).released).toEqual([]);
  });

  it('a hold with both an orphan row and a pending order is released once', async () => {
    const db = new FakeDb();
    const event = db.addEvent();
    const g = db.addRsvp(event.id, {updatedAt: at(-1000)});
    db.addOrder(g.id, {createdAt: at(-1000)});
    expect((await expireCheckoutHolds(asDb(db), NOW)).released).toEqual([g.id]);
    expect(queued.filter(q => q.kind === 'hold_expired')).toHaveLength(1);
  });
});

describe('waitlist claim expiry', () => {
  function claimSetup() {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1});
    const ticket = db.addTicket(event.id);
    const lapsed = db.addRsvp(event.id, {ticketTypeId: ticket.id, status: 'waitlisted', waitlistPosition: 1, claimExpiresAt: at(-1)});
    const next = db.addRsvp(event.id, {ticketTypeId: ticket.id, status: 'waitlisted', waitlistPosition: 2});
    return {db, event, lapsed, next};
  }

  it('lapses the claim, offers the next guest, and a second run changes nothing', async () => {
    const {db, event, lapsed, next} = claimSetup();
    const first = await expireEventClaims(asDb(db), event.id, NOW);
    expect(first.lapsed).toBe(1);
    expect(first.offers.map(o => o.rsvpId)).toEqual([next.id]);
    expect(db.rsvp.rows.find(r => r.id === lapsed.id)).toMatchObject({status: 'cancelled', claimExpiresAt: null, waitlistPosition: null});
    expect(db.rsvp.rows.find(r => r.id === next.id)!.waitlistPosition).toBe(1);
    const second = await expireEventClaims(asDb(db), event.id, at(1));
    expect(second).toEqual({lapsed: 0, offers: []});
  });

  it('a claim that has not yet lapsed is kept and not scanned', async () => {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1});
    db.addRsvp(event.id, {status: 'waitlisted', waitlistPosition: 1, claimExpiresAt: at(30)});
    expect(await eventsWithLapsedClaims(asDb(db), NOW)).toEqual([]);
  });

  it('eventsWithLapsedClaims returns each event once and honours the take bound', async () => {
    const db = new FakeDb();
    const e1 = db.addEvent();
    const e2 = db.addEvent();
    db.addRsvp(e1.id, {status: 'waitlisted', claimExpiresAt: at(-1)});
    db.addRsvp(e1.id, {status: 'waitlisted', claimExpiresAt: at(-2)});
    db.addRsvp(e2.id, {status: 'waitlisted', claimExpiresAt: at(-3)});
    expect((await eventsWithLapsedClaims(asDb(db), NOW)).sort()).toEqual([e1.id, e2.id].sort());
    expect(await eventsWithLapsedClaims(asDb(db), NOW, 1)).toHaveLength(1);
  });

  it('repeated ticks queue the offer once (the fake has no row lock, so overlap is not simulated)', async () => {
    const {db, next} = claimSetup();
    const send = vi.fn(async () => true);
    await runScheduler(asDb(db), NOW, {send});
    await runScheduler(asDb(db), at(1), {send});
    const offers = queued.filter(q => q.kind === 'waitlist_offer' && q.rsvpId === next.id);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.stamp).toBe(String(db.rsvp.rows.find(r => r.id === next.id)!.claimExpiresAt.getTime()));
  });
});

describe('runScheduler', () => {
  it('summary counts are consistent and a clean tick has no errors', async () => {
    const db = new FakeDb();
    const summary = await runScheduler(asDb(db), NOW, {send: async () => true});
    expect(summary).toMatchObject({errors: [], waitlist: {lapsed: 0, offered: 0}, holds: {expired: 0}, reminders: {due: 0, sent: 0}});
    expect(summary.ranAt).toBe(NOW.toISOString());
  });

  it('expires a hold and sweeps it in the same tick as sending a reminder', async () => {
    const db = new FakeDb();
    const event = db.addEvent({startAt: at(60), endAt: at(180)});
    db.reminderRule.rows.push({id: 'r1', eventId: event.id, kind: 'reminder', offsetMinutes: -60, enabled: true, subject: 'S', body: 'B'});
    db.addRsvp(event.id, {status: 'confirmed', createdAt: at(-1000), confirmedAt: at(-1000)});
    const held = db.addRsvp(event.id);
    db.addOrder(held.id, {createdAt: at(-holdMin - 1)});
    const send = vi.fn(async () => true);
    const summary = await runScheduler(asDb(db), NOW, {send});
    expect(summary.reminders.sent).toBe(1);
    expect(summary.holds.expired).toBe(1);
    // the hold-expiry sweep never sends mail inline
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an already-passed deadline stops claim handling and the hold sweep (next tick releases them)', async () => {
    const db = new FakeDb();
    const event = db.addEvent();
    db.addRsvp(event.id, {status: 'waitlisted', claimExpiresAt: at(-1)});
    const held = db.addRsvp(event.id);
    db.addOrder(held.id, {createdAt: at(-holdMin - 1)});
    const summary = await runScheduler(asDb(db), NOW, {send: async () => true, deadlineMs: -1});
    expect(summary.waitlist.lapsed).toBe(0);
    expect(summary.holds.expired).toBe(0);
  });
});

describe('runReminders extras', () => {
  function setup(rule: Record<string, unknown> = {}) {
    const db = new FakeDb();
    const event = db.addEvent({startAt: at(60), endAt: at(180)});
    db.reminderRule.rows.push({id: 'r1', eventId: event.id, kind: 'reminder', offsetMinutes: -60, enabled: true, subject: 'S', body: 'B', ...rule});
    const guest = db.addRsvp(event.id, {status: 'confirmed', createdAt: at(-1000), confirmedAt: at(-1000)});
    return {db, event, guest};
  }

  it('a disabled rule sends nothing', async () => {
    const {db} = setup({enabled: false});
    const send = vi.fn(async () => true);
    expect((await runReminders(asDb(db), NOW, {send})).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('a permanently failed delivery is never retried; a transient one is', async () => {
    const {db, guest} = setup();
    db.messageDelivery.rows.push({id: 'd1', rsvpId: guest.id, reminderRuleId: 'r1', status: 'failed', error: `${PERMANENT_ERROR_PREFIX}bounced`, sentAt: at(-100)});
    const send = vi.fn(async () => true);
    expect((await runReminders(asDb(db), NOW, {send})).sent).toBe(0);
    db.messageDelivery.rows[0]!.error = 'timeout';
    expect((await runReminders(asDb(db), NOW, {send})).sent).toBe(1);
    expect(db.messageDelivery.rows[0]!.status).toBe('sent');
  });

  it('a fresh queued claim (another run mid-send) is skipped, a stale one is re-sent', async () => {
    const {db, guest} = setup();
    db.messageDelivery.rows.push({id: 'd1', rsvpId: guest.id, reminderRuleId: 'r1', status: 'queued', error: null, sentAt: at(-2)});
    const send = vi.fn(async () => true);
    expect((await runReminders(asDb(db), NOW, {send})).sent).toBe(0);
    db.messageDelivery.rows[0]!.sentAt = at(-60);
    expect((await runReminders(asDb(db), NOW, {send})).sent).toBe(1);
  });

  it('the budget bounds sends per run; the remainder goes on the next run', async () => {
    const {db, event} = setup();
    for (let i = 0; i < 3; i++) db.addRsvp(event.id, {status: 'confirmed', createdAt: at(-1000), confirmedAt: at(-1000)});
    const send = vi.fn(async () => true);
    expect((await runReminders(asDb(db), NOW, {send, budget: 2})).sent).toBe(2);
    expect((await runReminders(asDb(db), NOW, {send, budget: 10})).sent).toBe(2);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('never sends for a cancelled event or a soft-deleted one', async () => {
    const a = setup();
    a.event.status = 'cancelled';
    const b = setup();
    (b.event as {deletedAt: Date | null}).deletedAt = new Date();
    const send = vi.fn(async () => true);
    expect((await runReminders(asDb(a.db), NOW, {send})).sent).toBe(0);
    expect((await runReminders(asDb(b.db), NOW, {send})).sent).toBe(0);
  });
});

describe('runRetention', () => {
  it('erases a batch and stops when a batch is short', async () => {
    privacy.expiredGuestIds.mockResolvedValueOnce(['a', 'b']);
    privacy.eraseRsvp.mockResolvedValue('erased');
    expect(await runRetention({} as never, NOW)).toMatchObject({erased: 2, skipped: 0});
    expect(privacy.expiredGuestIds).toHaveBeenCalledTimes(1);
  });

  it('skips guests mid-checkout and stops instead of looping when nothing progresses', async () => {
    const ids = Array.from({length: RETENTION_BATCH_SIZE}, (_, i) => `g${i}`);
    privacy.expiredGuestIds.mockResolvedValue(ids);
    privacy.eraseRsvp.mockResolvedValue('checkout_in_progress');
    expect(await runRetention({} as never, NOW)).toMatchObject({erased: 0, skipped: RETENTION_BATCH_SIZE});
    expect(privacy.expiredGuestIds).toHaveBeenCalledTimes(1);
  });

  it('is bounded to RETENTION_MAX_BATCHES batches per run', async () => {
    const ids = Array.from({length: RETENTION_BATCH_SIZE}, (_, i) => `g${i}`);
    privacy.expiredGuestIds.mockResolvedValue(ids);
    privacy.eraseRsvp.mockResolvedValue('erased');
    const r = await runRetention({} as never, NOW);
    expect(privacy.expiredGuestIds).toHaveBeenCalledTimes(RETENTION_MAX_BATCHES);
    expect(r.erased).toBe(RETENTION_MAX_BATCHES * RETENTION_BATCH_SIZE);
  });

  it('not_found rows count as neither erased nor skipped; a second run with nothing due is a no-op', async () => {
    privacy.expiredGuestIds.mockResolvedValueOnce(['x']).mockResolvedValue([]);
    privacy.eraseRsvp.mockResolvedValue('not_found');
    expect(await runRetention({} as never, NOW)).toMatchObject({erased: 0, skipped: 0});
    expect(await runRetention({} as never, NOW)).toMatchObject({erased: 0, skipped: 0});
  });
});
