import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import type {EventEmail, SendOutcome} from '../../src/server/mailer';
import {enqueueEventCancelledEmails, enqueueGuestEmails} from '../../src/server/jobs/outbox';
import {drainGuestEmailOutbox, OUTBOX_MAX_ATTEMPTS, outboxBackoffMinutes} from '../../src/server/jobs/outbox-drain';
import {resetEvents} from './support/events-fixtures';
import {configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * The guest email outbox (audit H-3, M-21, L-20, L-21) against a real Postgres: one row per email,
 * a drain that sends in bounded rounds, backs off, gives up, gives a rate-limited try back, and
 * hands the provider a stable Idempotency-Key.
 */
const T0 = new Date('2026-11-13T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

let seq = 0;
async function cancelledEventWithGuests(n: number) {
  seq += 1;
  const event = await db.event.create({
    data: {
      slug: `outbox-event-${seq}`,
      title: 'Outbox Workshop',
      startAt: at(10 * 24 * 60),
      endAt: at(10 * 24 * 60 + 120),
      timezone: 'UTC',
      format: 'online',
      joinUrl: 'https://zoom.example/j/1',
      status: 'cancelled',
      pollJoinCode: `O${String(seq).padStart(5, '0')}`,
    },
    select: {id: true},
  });
  await db.rsvp.createMany({
    data: Array.from({length: n}, (_, i) => ({
      eventId: event.id,
      name: `Guest ${i}`,
      email: `g${seq}-${i}@x.com`,
      response: 'going' as const,
      status: i === n - 1 && n > 1 ? ('declined' as const) : ('confirmed' as const),
      ticketCode: `O${seq}${String(i).padStart(6, '0')}`,
      manageToken: `ob-${seq}-${i}-${Math.random()}`,
    })),
  });
  return event.id;
}

function provider(answer: (email: EventEmail, n: number) => SendOutcome = () => 'sent') {
  const calls: EventEmail[] = [];
  return {
    calls,
    deliver: async (email: EventEmail) => {
      calls.push(email);
      return {outcome: answer(email, calls.length)};
    },
  };
}

describe.skipIf(!DATABASE_URL)('guest email outbox (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(resetEvents);

  it('a cancel fan-out is one keyed row per guest still expecting the event; a repeat adds nothing', async () => {
    const eventId = await cancelledEventWithGuests(4); // 3 confirmed + 1 declined
    expect(await enqueueEventCancelledEmails(db as never, eventId, T0)).toBe(3);
    expect(await enqueueEventCancelledEmails(db as never, eventId, T0)).toBe(0);

    const p = provider();
    const run = await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true});
    expect(run).toMatchObject({sent: 3, failed: 0, more: false});
    expect(p.calls).toHaveLength(3);
    // L-21: the outbox row id is the provider's Idempotency-Key.
    const rows = await db.guestEmailOutbox.findMany({select: {id: true, status: true, sentAt: true}});
    expect(new Set(p.calls.map(c => c.idempotencyKey))).toEqual(new Set(rows.map(r => `outbox-${r.id}`)));
    expect(rows.every(r => r.status === 'sent' && r.sentAt)).toBe(true);
    // A second drain finds nothing due.
    expect(await drainGuestEmailOutbox(db as never, at(2), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 0});
    expect(p.calls).toHaveLength(3);
  });

  it('a failed send backs off, is retried with the same key, and gives up after the cap', async () => {
    const eventId = await cancelledEventWithGuests(1);
    await enqueueEventCancelledEmails(db as never, eventId, T0);
    const p = provider(() => 'failed');
    let now = at(1);
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      // Not due before its backoff ends.
      await drainGuestEmailOutbox(db as never, now, {deliver: p.deliver, providerConfigured: true});
      const row = await db.guestEmailOutbox.findFirstOrThrow();
      expect(row.attempts).toBe(attempt);
      if (attempt < OUTBOX_MAX_ATTEMPTS) {
        expect(row.status).toBe('pending');
        const wait = row.nextAttemptAt.getTime() - now.getTime() - outboxBackoffMinutes(attempt) * 60_000;
        expect(wait).toBeGreaterThanOrEqual(0);
        expect(wait).toBeLessThan(5_000);
        await drainGuestEmailOutbox(db as never, new Date(row.nextAttemptAt.getTime() - 1000), {deliver: p.deliver, providerConfigured: true});
        expect(p.calls).toHaveLength(attempt);
        now = row.nextAttemptAt;
      } else {
        expect(row.status).toBe('failed');
      }
    }
    expect(p.calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(new Set(p.calls.map(c => c.idempotencyKey)).size).toBe(1);
    // L-20: one delivery row for the guest, written on the final failure, never one per try.
    const deliveries = await db.messageDelivery.findMany({select: {status: true}});
    expect(deliveries).toEqual([{status: 'failed'}]);
    expect(await drainGuestEmailOutbox(db as never, at(10_000), {deliver: p.deliver, providerConfigured: true})).toMatchObject({sent: 0, failed: 0});
  });

  it('no mail provider: failed once, not retried, one delivery row (L-20)', async () => {
    const eventId = await cancelledEventWithGuests(1);
    await enqueueEventCancelledEmails(db as never, eventId, T0);
    const p = provider(() => 'no_provider');
    expect(await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: false})).toMatchObject({failed: 1});
    expect(await drainGuestEmailOutbox(db as never, at(600), {deliver: p.deliver, providerConfigured: false})).toMatchObject({failed: 0});
    expect(p.calls).toHaveLength(1);
    expect(await db.messageDelivery.count()).toBe(1);
  });

  it('a provider 429 gives the try back, waits seconds, and stops the run', async () => {
    const eventId = await cancelledEventWithGuests(6); // 5 confirmed
    await enqueueEventCancelledEmails(db as never, eventId, T0);
    const p = provider(() => 'rate_limited');
    const run = await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true});
    expect(run.more).toBe(true);
    expect(p.calls).toHaveLength(3); // stopped after three refusals in a row
    const rows = await db.guestEmailOutbox.findMany({select: {attempts: true, status: true}});
    expect(rows.every(r => r.attempts === 0 && r.status === 'pending')).toBe(true);
  });

  it('a run is bounded, and a repeated key is a no-op', async () => {
    await enqueueGuestEmails(
      db as never,
      Array.from({length: 30}, (_, i) => ({key: `broadcast-x-${i}`, kind: 'broadcast' as const})),
      T0,
    );
    await enqueueGuestEmails(db as never, [{key: 'broadcast-x-0', kind: 'broadcast'}], T0);
    expect(await db.guestEmailOutbox.count()).toBe(30);
    // Rows whose message is gone are skipped (no send), and only `limit` rows are handled per run.
    const p = provider();
    const run = await drainGuestEmailOutbox(db as never, at(1), {deliver: p.deliver, providerConfigured: true, limit: 20});
    expect(run).toMatchObject({skipped: 20, more: true});
    expect(p.calls).toHaveLength(0);
    expect(await db.guestEmailOutbox.count({where: {status: 'pending'}})).toBe(10);
  });
});
