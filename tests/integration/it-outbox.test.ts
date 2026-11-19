import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {createDb} from '../../src/platform/db';
import type {EventEmail, SendOutcome} from '../../src/server/mailer';
import {enqueueGuestEmails, enqueueGuestNotices, noticeKey, REARM_AFTER_HOURS} from '../../src/server/jobs/outbox';
import {drainGuestEmailOutbox, OUTBOX_LEASE_MINUTES, OUTBOX_MAX_ATTEMPTS, outboxBackoffMinutes} from '../../src/server/jobs/outbox-drain';
import {resetEvents} from './support/events-fixtures';
import {configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * The guest email outbox against a real Postgres, beyond guest-email-outbox.test.ts: host notices
 * (`enqueueGuestNotices`: unnest(...)::text[]/::uuid[] joined to rsvps), key dedupe, the 24 h re-arm
 * rule on created_at AND sent_at, concurrent drains (FOR UPDATE SKIP LOCKED), lease expiry, backoff
 * and give-up, 429 handling, the run deadline, and broadcasts skipping unsubscribed guests.
 */
const T0 = new Date('2026-11-13T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const H = 60;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let seq = 0;
async function eventWithGuests(n: number, status: 'published' | 'cancelled' = 'published') {
  seq += 1;
  const event = await db.event.create({
    data: {
      slug: `itob-event-${seq}`,
      title: 'Outbox Meetup',
      startAt: at(10 * 24 * 60),
      endAt: at(10 * 24 * 60 + 120),
      timezone: 'UTC',
      format: 'online',
      joinUrl: 'https://zoom.example/j/2',
      status,
      pollJoinCode: `I${String(seq).padStart(5, '0')}`,
    },
    select: {id: true},
  });
  await db.rsvp.createMany({
    data: Array.from({length: n}, (_, i) => ({
      eventId: event.id,
      name: `Guest ${i}`,
      email: `itob${seq}-${i}@x.com`,
      response: 'going' as const,
      status: 'confirmed' as const,
      ticketCode: `I${(seq * 1000 + i).toString(36).toUpperCase().padStart(7, '0')}`,
      manageToken: `itob-${seq}-${i}-${Math.random()}`,
    })),
  });
  const rsvps = await db.rsvp.findMany({where: {eventId: event.id}, select: {id: true, email: true}, orderBy: {email: 'asc'}});
  return {eventId: event.id, rsvps};
}

const confirmNotice = (rsvpId: string) => ({kind: 'notice_confirmation' as const, rsvpId, key: noticeKey('notice_confirmation', rsvpId, 'confirmed')});

function provider(answer: (email: EventEmail, n: number) => SendOutcome | Promise<SendOutcome> = () => 'sent', retryAfterSeconds?: number) {
  const calls: EventEmail[] = [];
  return {
    calls,
    deliver: async (email: EventEmail) => {
      calls.push(email);
      const outcome = await answer(email, calls.length);
      return outcome === 'rate_limited' && retryAfterSeconds ? {outcome, retryAfterSeconds} : {outcome};
    },
  };
}

const outbox = () =>
  db.guestEmailOutbox.findMany({
    select: {idempotencyKey: true, kind: true, rsvpId: true, status: true, attempts: true, nextAttemptAt: true, sentAt: true, createdAt: true},
    orderBy: {idempotencyKey: 'asc'},
  });

describe.skipIf(!DATABASE_URL)('guest email outbox: enqueue, drain, concurrency (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(resetEvents);

  describe('enqueueGuestNotices', () => {
    it('one statement inserts one row per key, joined to rsvps: unknown guests are dropped, repeated keys count once', async () => {
      const {rsvps} = await eventWithGuests(3);
      const ghost = '00000000-0000-4000-8000-000000000001';
      const queued = await enqueueGuestNotices(
        db as never,
        [confirmNotice(rsvps[0]!.id), confirmNotice(rsvps[1]!.id), confirmNotice(rsvps[0]!.id), confirmNotice(ghost),
          {kind: 'notice_declined', rsvpId: rsvps[2]!.id, key: noticeKey('notice_declined', rsvps[2]!.id, 'declined')}],
        T0,
      );
      expect(queued).toBe(3);
      const rows = await outbox();
      expect(rows.map(r => r.rsvpId).sort()).toEqual(rsvps.map(r => r.id).sort());
      expect(rows.every(r => r.status === 'pending' && r.attempts === 0 && r.nextAttemptAt.getTime() === T0.getTime())).toBe(true);
      expect(rows.find(r => r.rsvpId === rsvps[2]!.id)?.kind).toBe('notice_declined');

      // A repeat of the same action is a no-op.
      expect(await enqueueGuestNotices(db as never, [confirmNotice(rsvps[0]!.id)], at(5))).toBe(0);
      expect(await enqueueGuestNotices(db as never, [], at(5))).toBe(0);
      expect(await db.guestEmailOutbox.count()).toBe(3);
    });

    it('a key over 200 characters is cut, and the cut key still dedupes', async () => {
      const {rsvps} = await eventWithGuests(1);
      const long = `notice_confirmation-${rsvps[0]!.id}-${'x'.repeat(300)}`;
      expect(await enqueueGuestNotices(db as never, [{kind: 'notice_confirmation', rsvpId: rsvps[0]!.id, key: long}], T0)).toBe(1);
      expect(await enqueueGuestNotices(db as never, [{kind: 'notice_confirmation', rsvpId: rsvps[0]!.id, key: `${long}-other-tail`}], T0)).toBe(0);
      const [row] = await outbox();
      expect(row!.idempotencyKey).toHaveLength(200);
    });

    it('re-arm: a pending row is never re-armed; a finished row only once created_at AND sent_at are older than 24 h', async () => {
      const {rsvps} = await eventWithGuests(1);
      const notice = confirmNotice(rsvps[0]!.id);
      expect(await enqueueGuestNotices(db as never, [notice], T0)).toBe(1);
      // Still pending a day later (never sent): left alone.
      expect(await enqueueGuestNotices(db as never, [notice], at(48 * H))).toBe(0);

      // Sent 23 h after it was queued.
      const sentAt = at(23 * H);
      const p = provider();
      expect(await drainGuestEmailOutbox(db as never, sentAt, {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 1});
      const sent = (await outbox())[0]!;
      expect(sent.status).toBe('sent');

      // 25 h after created_at but only 2 h after sent_at: no re-arm.
      expect(await enqueueGuestNotices(db as never, [notice], at(25 * H))).toBe(0);
      // Just under 24 h after the send: no re-arm.
      const realSent = sent.sentAt!.getTime();
      expect(await enqueueGuestNotices(db as never, [notice], new Date(realSent + REARM_AFTER_HOURS * 3_600_000 - 60_000))).toBe(0);
      expect((await outbox())[0]!.status).toBe('sent');

      // More than 24 h after both: pending again, a fresh try budget, created_at moved.
      const later = new Date(realSent + REARM_AFTER_HOURS * 3_600_000 + 60_000);
      expect(await enqueueGuestNotices(db as never, [notice], later)).toBe(1);
      const rearmed = (await outbox())[0]!;
      expect(rearmed).toMatchObject({status: 'pending', attempts: 0, sentAt: null});
      expect(rearmed.createdAt.getTime()).toBe(later.getTime());
      expect(rearmed.nextAttemptAt.getTime()).toBe(later.getTime());
      // And the re-armed row dedupes again from its new created_at.
      expect(await enqueueGuestNotices(db as never, [notice], new Date(later.getTime() + 25 * 3_600_000))).toBe(0);
    });

    it('re-arm: a failed row (no sent_at) re-arms 24 h after it was queued', async () => {
      const {rsvps} = await eventWithGuests(1);
      const notice = confirmNotice(rsvps[0]!.id);
      await enqueueGuestNotices(db as never, [notice], T0);
      const p = provider(() => 'rejected');
      expect(await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true})).toMatchObject({failed: 1});
      expect((await outbox())[0]!.status).toBe('failed');
      expect(await enqueueGuestNotices(db as never, [notice], at(23 * H))).toBe(0);
      expect(await enqueueGuestNotices(db as never, [notice], at(24 * H + 1))).toBe(1);
      expect((await outbox())[0]).toMatchObject({status: 'pending', attempts: 0});
    });
  });

  describe('enqueueGuestEmails', () => {
    it('keys dedupe within and across calls, and the same 24 h re-arm rule applies on created_at and sent_at', async () => {
      const {rsvps} = await eventWithGuests(1);
      const row = {key: `confirmation-${rsvps[0]!.id}-x`, kind: 'notice_confirmation' as const, rsvpId: rsvps[0]!.id};
      await enqueueGuestEmails(db as never, [row], T0);
      await enqueueGuestEmails(db as never, [row], at(1));
      expect(await db.guestEmailOutbox.count()).toBe(1);

      const p = provider();
      await drainGuestEmailOutbox(db as never, at(20 * H), {deliver: p.deliver, providerConfigured: true});
      expect(p.calls).toHaveLength(1);
      const sentAt = (await outbox())[0]!.sentAt!.getTime();
      // Created > 24 h ago, sent < 24 h ago: still finished.
      await enqueueGuestEmails(db as never, [row], at(30 * H));
      expect((await outbox())[0]!.status).toBe('sent');
      const later = new Date(sentAt + REARM_AFTER_HOURS * 3_600_000 + 1000);
      await enqueueGuestEmails(db as never, [row], later);
      expect((await outbox())[0]).toMatchObject({status: 'pending', attempts: 0, sentAt: null});
      // Re-armed: it is sent again with the same row id (same Idempotency-Key, outside the provider's 24 h memory).
      await drainGuestEmailOutbox(db as never, new Date(later.getTime() + 1000), {deliver: p.deliver, providerConfigured: true});
      expect(p.calls).toHaveLength(2);
      expect(p.calls[0]!.idempotencyKey).toBe(p.calls[1]!.idempotencyKey);
    });

    // A repeated key inside one call must not fail the whole 500-row statement (Postgres 21000).
    it('a key repeated inside one call is queued once (as enqueueGuestNotices does)', async () => {
      await enqueueGuestEmails(
        db as never,
        [{key: 'broadcast-dup-1', kind: 'broadcast'}, {key: 'broadcast-dup-2', kind: 'broadcast'}, {key: 'broadcast-dup-1', kind: 'broadcast'}],
        T0,
      );
      expect(await db.guestEmailOutbox.count()).toBe(2);
    });

    it('more than 500 rows go in several statements, all inserted', async () => {
      await enqueueGuestEmails(
        db as never,
        Array.from({length: 1003}, (_, i) => ({key: `broadcast-bulk-${i}`, kind: 'broadcast' as const})),
        T0,
      );
      expect(await db.guestEmailOutbox.count()).toBe(1003);
    });
  });

  describe('drain', () => {
    it('two drains at once (separate connections) never send a row twice', async () => {
      const {rsvps} = await eventWithGuests(25);
      await enqueueGuestNotices(db as never, rsvps.map(r => confirmNotice(r.id)), T0);
      const db2 = createDb(DATABASE_URL);
      try {
        const p = provider(async () => {
          await sleep(15);
          return 'sent' as const;
        });
        const [a, b] = await Promise.all([
          drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true}),
          drainGuestEmailOutbox(db2 as never, at(1), {deliver: p.deliver, providerConfigured: true}),
        ]);
        expect(a.sent + b.sent).toBe(25);
        expect(p.calls).toHaveLength(25);
        expect(new Set(p.calls.map(c => c.idempotencyKey)).size).toBe(25);
        expect(new Set(p.calls.map(c => c.to)).size).toBe(25);
        const rows = await outbox();
        expect(rows.every(r => r.status === 'sent' && r.attempts === 1)).toBe(true);
      } finally {
        await db2.$disconnect();
      }
    });

    it('a row locked by another transaction is skipped (SKIP LOCKED), not waited on, and sent by the next run', async () => {
      const {rsvps} = await eventWithGuests(3);
      await enqueueGuestNotices(db as never, rsvps.map(r => confirmNotice(r.id)), T0);
      const lockedRsvp = rsvps[0]!.id;
      const db2 = createDb(DATABASE_URL);
      const p = provider();
      try {
        await db2.$transaction(
          async tx => {
            await tx.$queryRaw`SELECT id FROM guest_email_outbox WHERE rsvp_id = ${lockedRsvp}::uuid FOR UPDATE`;
            const started = Date.now();
            const run = await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true});
            expect(Date.now() - started).toBeLessThan(5_000);
            expect(run.sent).toBe(2);
          },
          {timeout: 20_000, maxWait: 10_000},
        );
      } finally {
        await db2.$disconnect();
      }
      expect(p.calls.map(c => c.to)).not.toContain(rsvps[0]!.email);
      expect(await drainGuestEmailOutbox(db as never, at(2), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 1});
      expect(p.calls).toHaveLength(3);
    });

    it('a claim from a crashed run is leased: not due before the lease ends, re-claimed after it', async () => {
      const {rsvps} = await eventWithGuests(1);
      await enqueueGuestNotices(db as never, [confirmNotice(rsvps[0]!.id)], T0);
      const crash = provider(() => {
        throw new Error('worker died mid-send');
      });
      await expect(drainGuestEmailOutbox(db as never, at(1), {deliver: crash.deliver, providerConfigured: true})).rejects.toThrow('worker died');
      const claimed = (await outbox())[0]!;
      expect(claimed).toMatchObject({status: 'pending', attempts: 1});
      const leaseEnd = claimed.nextAttemptAt.getTime();
      expect(leaseEnd - at(1).getTime()).toBeGreaterThanOrEqual(OUTBOX_LEASE_MINUTES * 60_000);
      expect(leaseEnd - at(1).getTime()).toBeLessThan(OUTBOX_LEASE_MINUTES * 60_000 + 5_000);

      const p = provider();
      expect(await drainGuestEmailOutbox(db as never, new Date(leaseEnd - 2_000), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 0});
      expect(p.calls).toHaveLength(0);
      expect(await drainGuestEmailOutbox(db as never, new Date(leaseEnd + 1_000), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 1});
      expect((await outbox())[0]).toMatchObject({status: 'sent', attempts: 2});
      // Same Idempotency-Key as the crashed try: the provider drops a duplicate.
      expect(p.calls[0]!.idempotencyKey).toBe(crash.calls[0]!.idempotencyKey);
    });

    it('a host notice that keeps failing backs off 2, 4, 8 … minutes and gives up after 8 tries', async () => {
      const {rsvps} = await eventWithGuests(1);
      await enqueueGuestNotices(db as never, [confirmNotice(rsvps[0]!.id)], T0);
      const p = provider(() => 'failed');
      let now = at(1);
      for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
        const run = await drainGuestEmailOutbox(db as never, now, {deliver: p.deliver, providerConfigured: true});
        const row = (await outbox())[0]!;
        expect(row.attempts).toBe(attempt);
        if (attempt < OUTBOX_MAX_ATTEMPTS) {
          expect(run).toMatchObject({retrying: 1, failed: 0});
          expect(row.status).toBe('pending');
          const wait = row.nextAttemptAt.getTime() - now.getTime() - outboxBackoffMinutes(attempt) * 60_000;
          expect(wait).toBeGreaterThanOrEqual(0);
          expect(wait).toBeLessThan(5_000);
          now = new Date(row.nextAttemptAt.getTime() + 1);
        } else {
          expect(run).toMatchObject({failed: 1});
          expect(row.status).toBe('failed');
        }
      }
      expect(p.calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
      expect(new Set(p.calls.map(c => c.idempotencyKey)).size).toBe(1);
      expect(await drainGuestEmailOutbox(db as never, at(100_000), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 0, failed: 0});
      expect(outboxBackoffMinutes(20)).toBe(240);
    });

    it('a 429 gives the try back and waits the provider\'s Retry-After seconds', async () => {
      const {rsvps} = await eventWithGuests(2);
      await enqueueGuestNotices(db as never, rsvps.map(r => confirmNotice(r.id)), T0);
      // First answer 429 (Retry-After 30 s), then accepted.
      const p = provider((_e, n) => (n === 1 ? 'rate_limited' : 'sent'), 30);
      const start = at(1);
      const run = await drainGuestEmailOutbox(db as never, start, {deliver: p.deliver, providerConfigured: true});
      expect(run).toMatchObject({sent: 1, retrying: 1});
      const limited = (await outbox()).find(r => r.status === 'pending')!;
      expect(limited.attempts).toBe(0);
      const wait = limited.nextAttemptAt.getTime() - start.getTime();
      expect(wait).toBeGreaterThanOrEqual(30_000);
      expect(wait).toBeLessThan(35_000);
      expect(await drainGuestEmailOutbox(db as never, new Date(start.getTime() + 10_000), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 0});
      expect(await drainGuestEmailOutbox(db as never, new Date(limited.nextAttemptAt.getTime() + 1), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 1});
      expect((await outbox()).every(r => r.status === 'sent' && r.attempts === 1)).toBe(true);
    });

    it('past the deadline no new send starts: the rest of the round is given back untouched', async () => {
      const {rsvps} = await eventWithGuests(5);
      await enqueueGuestNotices(db as never, rsvps.map(r => confirmNotice(r.id)), T0);
      const p = provider(async () => {
        await sleep(400);
        return 'sent' as const;
      });
      const run = await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true, deadline: Date.now() + 200});
      expect(run).toMatchObject({sent: 1, more: true});
      expect(p.calls).toHaveLength(1);
      const rows = await outbox();
      expect(rows.filter(r => r.status === 'sent')).toHaveLength(1);
      expect(rows.filter(r => r.status === 'pending' && r.attempts === 0)).toHaveLength(4);

      // A run that starts past its deadline claims nothing.
      const late = await drainGuestEmailOutbox(db as never, at(2), {deliver: p.deliver, providerConfigured: true, deadline: Date.now() - 1});
      expect(late).toMatchObject({sent: 0, more: true});
      expect((await outbox()).filter(r => r.attempts > 0)).toHaveLength(1);
    });

    it('a broadcast skips a guest who unsubscribed and a guest of another event, and keeps its delivery rows and count', async () => {
      const {eventId, rsvps} = await eventWithGuests(4);
      const other = await eventWithGuests(1);
      await db.rsvp.update({where: {id: rsvps[1]!.id}, data: {unsubscribedAt: T0}});
      const message = await db.message.create({
        data: {eventId, segment: 'all', subject: 'Doors at 7', body: 'See you there.'},
        select: {id: true},
      });
      const targets = [...rsvps.map(r => r.id), other.rsvps[0]!.id];
      await db.messageDelivery.createMany({data: targets.map(rsvpId => ({messageId: message.id, rsvpId}))});
      await enqueueGuestEmails(
        db as never,
        targets.map(rsvpId => ({key: `broadcast-${message.id}-${rsvpId}`, kind: 'broadcast' as const, rsvpId, messageId: message.id})),
        T0,
      );
      const p = provider();
      const run = await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true});
      expect(run).toMatchObject({sent: 3, skipped: 2});
      const to = p.calls.map(c => c.to).sort();
      expect(to).toEqual([rsvps[0]!.email, rsvps[2]!.email, rsvps[3]!.email].sort());
      expect(p.calls.every(c => c.content.subject.includes('Doors at 7'))).toBe(true);

      const deliveries = await db.messageDelivery.findMany({select: {rsvpId: true, status: true}});
      const statusOf = (id: string) => deliveries.find(d => d.rsvpId === id)?.status;
      expect(statusOf(rsvps[0]!.id)).toBe('sent');
      expect(statusOf(rsvps[1]!.id)).toBe('failed');
      expect(statusOf(other.rsvps[0]!.id)).toBe('failed');
      expect((await db.message.findUniqueOrThrow({where: {id: message.id}, select: {sentCount: true}})).sentCount).toBe(3);
    });

    it('a host notice still reaches an unsubscribed guest (the opt-out covers broadcasts only), but not a guest whose status moved on', async () => {
      const {rsvps} = await eventWithGuests(2);
      await db.rsvp.update({where: {id: rsvps[0]!.id}, data: {unsubscribedAt: T0}});
      await db.rsvp.update({where: {id: rsvps[1]!.id}, data: {status: 'declined'}});
      await enqueueGuestNotices(db as never, rsvps.map(r => confirmNotice(r.id)), T0);
      const p = provider();
      expect(await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 1, skipped: 1});
      expect(p.calls.map(c => c.to)).toEqual([rsvps[0]!.email]);
    });
  });
});
