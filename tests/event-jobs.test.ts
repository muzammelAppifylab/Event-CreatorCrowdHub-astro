import {beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeDb} from './ticket-fake-db';

const queued: Array<{kind: string; rsvpId: string; stamp?: string}> = [];
vi.mock('../src/server/jobs/guest-emails', () => ({
  GUEST_EMAIL_LIST: 'rsvp-emails',
  queueGuestEmail: async (kind: string, rsvpId: string, stamp?: string) => void queued.push({kind, rsvpId, stamp}),
  queueGuestEmails: async (items: Array<{kind: string; rsvpId: string; stamp?: string}>) => void queued.push(...items.map(({kind, rsvpId, stamp}) => ({kind, rsvpId, stamp}))),
  sendGuestEmail: vi.fn(),
}));

import {appConfig} from '../src/config/app.config';
import {claimDelivery} from '../src/server/jobs/deliveries';
import {expireCheckoutHolds} from '../src/server/jobs/holds';
import {runReminders} from '../src/server/jobs/reminders';
import {runScheduler} from '../src/server/jobs/run';
import {PERMANENT_ERROR_PREFIX} from '../src/server/jobs/shared';

const asDb = (db: FakeDb) => db as never;
const MIN = 60_000;
const NOW = new Date('2026-11-12T12:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);

beforeEach(() => {
  queued.length = 0;
});

describe('claimDelivery (idempotence of reminder sends)', () => {
  it('only the first claim for an (rsvp, rule) wins', async () => {
    const db = new FakeDb();
    expect(await claimDelivery(asDb(db), 'r1', 'rule1', NOW)).toBeTruthy();
    expect(await claimDelivery(asDb(db), 'r1', 'rule1', NOW)).toBeNull();
    expect(await claimDelivery(asDb(db), 'r1', 'rule2', NOW)).toBeTruthy();
    expect(db.messageDelivery.rows).toHaveLength(2);
  });

  it('re-claims a retryable failure and a stale queued claim, never a sent or permanently failed row', async () => {
    const db = new FakeDb();
    const claim = async (status: string, error: string | null, sentAt: Date | null, rule: string) => {
      db.messageDelivery.rows.push({id: `d-${rule}`, rsvpId: 'r1', reminderRuleId: rule, status, error, sentAt});
      return claimDelivery(asDb(db), 'r1', rule, NOW);
    };
    expect(await claim('failed', 'provider timeout', at(-1), 'a')).toBe('d-a');
    expect(await claim('failed', `${PERMANENT_ERROR_PREFIX}bounced`, at(-1), 'b')).toBeNull();
    expect(await claim('sent', null, at(-1), 'c')).toBeNull();
    expect(await claim('queued', null, at(-5), 'd')).toBeNull(); // a run is probably still sending
    expect(await claim('queued', null, at(-30), 'e')).toBe('d-e'); // a crashed run's claim
  });
});

function reminderSetup() {
  const db = new FakeDb();
  const event = db.addEvent({startAt: at(60), endAt: at(180)});
  const rule = {id: 'rule-1h', eventId: event.id, kind: 'reminder', offsetMinutes: -60, enabled: true, subject: 'Starting soon', body: 'See you at {{event.title}}'};
  db.reminderRule.rows.push(rule);
  const guest = db.addRsvp(event.id, {status: 'confirmed', createdAt: at(-1000), confirmedAt: at(-1000)});
  return {db, event, rule, guest};
}

describe('runReminders', () => {
  it('sends a due reminder exactly once across repeated runs', async () => {
    const {db, guest} = reminderSetup();
    const send = vi.fn(async () => true);

    const first = await runReminders(asDb(db), NOW, {send});
    expect(first).toMatchObject({due: 1, sent: 1, failed: 0});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({to: guest.email, content: expect.objectContaining({subject: expect.any(String)})}));

    const second = await runReminders(asDb(db), NOW, {send});
    expect(second.sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.messageDelivery.rows).toHaveLength(1);
    expect(db.messageDelivery.rows[0]).toMatchObject({status: 'sent', reminderRuleId: 'rule-1h'});
  });

  it('two overlapping runs send once', async () => {
    const {db} = reminderSetup();
    const send = vi.fn(async () => true);
    await Promise.all([runReminders(asDb(db), NOW, {send}), runReminders(asDb(db), NOW, {send})]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a failed send is recorded and retried on the next run while still due', async () => {
    const {db} = reminderSetup();
    const down = vi.fn(async () => false);
    expect(await runReminders(asDb(db), NOW, {send: down})).toMatchObject({sent: 0, failed: 1});
    expect(db.messageDelivery.rows[0]).toMatchObject({status: 'failed'});

    const up = vi.fn(async () => true);
    expect(await runReminders(asDb(db), at(2), {send: up})).toMatchObject({sent: 1});
    expect(db.messageDelivery.rows).toHaveLength(1);
    expect(db.messageDelivery.rows[0]!.status).toBe('sent');
  });

  it('a send that throws never stops the batch', async () => {
    const {db, event} = reminderSetup();
    db.addRsvp(event.id, {status: 'confirmed', createdAt: at(-1000), confirmedAt: at(-1000)});
    let calls = 0;
    const send = vi.fn(async () => {
      if (++calls === 1) throw new Error('boom');
      return true;
    });
    expect(await runReminders(asDb(db), NOW, {send})).toMatchObject({due: 2, sent: 1, failed: 1});
  });

  it('only confirmed guests get reminders, and not before the send time', async () => {
    const {db, event} = reminderSetup();
    db.addRsvp(event.id, {status: 'awaiting_payment', createdAt: at(-1000)});
    db.addRsvp(event.id, {status: 'waitlisted', createdAt: at(-1000)});
    const send = vi.fn(async () => true);
    expect(await runReminders(asDb(db), at(-30), {send})).toMatchObject({due: 0});
    expect(await runReminders(asDb(db), NOW, {send})).toMatchObject({due: 1, sent: 1});
  });

  it('sends the thank-you after the event ends, and not for a draft event', async () => {
    const db = new FakeDb();
    const event = db.addEvent({startAt: at(-300), endAt: at(-60)});
    db.reminderRule.rows.push({id: 'ty', eventId: event.id, kind: 'thank_you', offsetMinutes: 30, enabled: true, subject: 'Thanks', body: 'Thank you'});
    db.addRsvp(event.id, {status: 'confirmed', createdAt: at(-1000), confirmedAt: at(-1000)});
    const send = vi.fn(async () => true);
    expect(await runReminders(asDb(db), NOW, {send})).toMatchObject({sent: 1});

    const draftDb = new FakeDb();
    const draft = draftDb.addEvent({startAt: at(-300), endAt: at(-60), status: 'draft'});
    draftDb.reminderRule.rows.push({id: 'ty2', eventId: draft.id, kind: 'thank_you', offsetMinutes: 30, enabled: true, subject: 'Thanks', body: 'Thank you'});
    draftDb.addRsvp(draft.id, {status: 'confirmed', createdAt: at(-1000)});
    expect(await runReminders(asDb(draftDb), NOW, {send})).toMatchObject({due: 0});
  });
});

describe('payment holds sweep', () => {
  const holdMin = appConfig.checkoutHoldMinutes;

  function holdSetup() {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1});
    const ticket = db.addTicket(event.id);
    const guest = db.addRsvp(event.id, {ticketTypeId: ticket.id, status: 'awaiting_payment', updatedAt: at(-500)});
    return {db, event, ticket, guest};
  }

  it('keeps a hold whose checkout is still fresh, whatever the RSVP row age', async () => {
    const {db, guest} = holdSetup();
    db.addOrder(guest.id, {createdAt: at(-10)});
    expect(await expireCheckoutHolds(asDb(db), NOW)).toEqual({released: []});
    expect(db.rsvp.rows[0]!.status).toBe('awaiting_payment');
  });

  it('releases a lapsed hold once: order expired, waitlist offered a claim, hold-expired email queued', async () => {
    const {db, event, ticket, guest} = holdSetup();
    db.addOrder(guest.id, {createdAt: at(-(holdMin + 1))});
    const waiting = db.addRsvp(event.id, {ticketTypeId: ticket.id, status: 'waitlisted', waitlistPosition: 1});

    expect(await expireCheckoutHolds(asDb(db), NOW)).toEqual({released: [guest.id]});
    expect(db.rsvp.rows.find(r => r.id === guest.id)!.status).toBe('cancelled');
    expect(db.ticketOrder.rows[0]!.status).toBe('expired');
    expect(db.rsvp.rows.find(r => r.id === waiting.id)!.claimExpiresAt).toBeInstanceOf(Date);
    expect(queued.map(q => q.kind).sort()).toEqual(['hold_expired', 'waitlist_offer']);

    // Idempotent: a second sweep finds nothing and sends nothing more.
    expect(await expireCheckoutHolds(asDb(db), NOW)).toEqual({released: []});
    expect(queued).toHaveLength(2);
  });

  it('sweeps a hold with no order by the RSVP age, and confirms waitlist guests on a free event', async () => {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1});
    const orphan = db.addRsvp(event.id, {status: 'awaiting_payment', updatedAt: at(-(holdMin + 5))});
    const waiting = db.addRsvp(event.id, {status: 'waitlisted', waitlistPosition: 1});
    expect(await expireCheckoutHolds(asDb(db), NOW)).toEqual({released: [orphan.id]});
    expect(db.rsvp.rows.find(r => r.id === waiting.id)).toMatchObject({status: 'confirmed', waitlistPosition: null});
    expect(queued).toContainEqual(expect.objectContaining({kind: 'confirmation', rsvpId: waiting.id}));
  });
});

describe('runScheduler', () => {
  it('lapsed waitlist claims are cancelled and the seat offered to the next guest', async () => {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1});
    const ticket = db.addTicket(event.id);
    const lapsed = db.addRsvp(event.id, {ticketTypeId: ticket.id, status: 'waitlisted', waitlistPosition: 1, claimExpiresAt: at(-5)});
    const next = db.addRsvp(event.id, {ticketTypeId: ticket.id, status: 'waitlisted', waitlistPosition: 2});

    const summary = await runScheduler(asDb(db), NOW, {send: async () => true});

    expect(summary).toMatchObject({waitlist: {lapsed: 1, offered: 1}, errors: []});
    expect(db.rsvp.rows.find(r => r.id === lapsed.id)!.status).toBe('cancelled');
    const offered = db.rsvp.rows.find(r => r.id === next.id)!;
    expect(offered.claimExpiresAt.getTime()).toBe(NOW.getTime() + appConfig.waitlistClaimMinutes * MIN);
    expect(offered.waitlistPosition).toBe(1);
    expect(queued).toEqual([{kind: 'waitlist_offer', rsvpId: next.id, stamp: String(offered.claimExpiresAt.getTime())}]);

    // Repeating the tick changes nothing.
    queued.length = 0;
    expect(await runScheduler(asDb(db), NOW, {send: async () => true})).toMatchObject({waitlist: {lapsed: 0, offered: 0}});
    expect(queued).toEqual([]);
  });

  it('a cancelled event releases lapsed claims without offering the seat', async () => {
    const db = new FakeDb();
    const event = db.addEvent({capacity: 1, status: 'cancelled'});
    db.addRsvp(event.id, {status: 'waitlisted', waitlistPosition: 1, claimExpiresAt: at(-5)});
    const next = db.addRsvp(event.id, {status: 'waitlisted', waitlistPosition: 2});
    const summary = await runScheduler(asDb(db), NOW, {send: async () => true});
    expect(summary.waitlist).toEqual({lapsed: 1, offered: 0});
    expect(db.rsvp.rows.find(r => r.id === next.id)!.claimExpiresAt).toBeNull();
  });

  it('one failing step never stops the others', async () => {
    const db = new FakeDb();
    db.event.findMany = async () => {
      throw new Error('db blip');
    };
    const event2 = db.addEvent();
    const orphan = db.addRsvp(event2.id, {status: 'awaiting_payment', updatedAt: at(-500)});
    const summary = await runScheduler(asDb(db), NOW, {send: async () => true});
    expect(summary.errors).toEqual([expect.stringContaining('reminders: db blip')]);
    expect(summary.holds.expired).toBe(1);
    expect(db.rsvp.rows.find(r => r.id === orphan.id)!.status).toBe('cancelled');
  });
});
