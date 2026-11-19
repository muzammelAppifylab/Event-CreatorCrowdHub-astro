import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * Ticket checkout and refunds against the real Postgres: the platform's payment API and its job
 * queue are faked the way they behave (one checkout per idempotency key; job sends refused with
 * `E_JOBS_RATE_LIMITED`, so every webhook emit must land in `webhook_outbox` before the caller's
 * promise resolves, audit L-19). Everything else is the real code: the payment hooks, the RSVP
 * route, the hold sweep, the guest email outbox and the webhook dispatcher.
 */
const platform = vi.hoisted(() => ({
  byKey: new Map<string, string>(),
  creates: 0,
  failCreate: false,
  jobs: [] as Array<{list: string; data: unknown}>,
}));

vi.mock('../../src/platform/payments', async importOriginal => ({
  ...(await importOriginal<object>()),
  findPrice: vi.fn(async () => ({ok: true, data: {amountCents: 2500, currency: 'USD'}})),
  createPrice: vi.fn(),
  getCheckout: vi.fn(async () => ({
    ok: true,
    data: {status: 'open', embedded: {kind: 'window', gateway: 'x', checkoutUrl: 'https://pay.example.com/x', returnUrl: '/thanks/'}},
  })),
  createCheckout: vi.fn(async (_url: unknown, input: {idempotencyKey?: string}) => {
    platform.creates++;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (platform.failCreate) return {ok: false, status: 502, code: 'E_GATEWAY_DOWN', message: 'The payment gateway is down.'};
    const key = input.idempotencyKey ?? `none-${platform.creates}`;
    if (!platform.byKey.has(key)) platform.byKey.set(key, `pcs_itc${String(platform.byKey.size + 1).padStart(8, '0')}`);
    return {ok: true, data: {id: platform.byKey.get(key)!, mode: 'test', embedded: null}};
  }),
}));

vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  return {
    ...real,
    sendJob: vi.fn(async (_url: unknown, list: string, data: unknown) => {
      platform.jobs.push({list, data});
      throw new real.JobRejected('Too many jobs this minute.', 'E_JOBS_RATE_LIMITED', 429);
    }),
  };
});

import type {Checkout, Refund} from '../../src/platform/payments';
import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {expireCheckoutHolds} from '../../src/server/jobs/holds';
import {paymentHooks} from '../../src/server/payments-hooks';
import {setPaidCheckoutHook} from '../../src/server/routes/rsvp';
import {startTicketCheckout} from '../../src/server/ticket-checkout';
import {eventsApp, resetEvents, rsvpBody} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, ownerNotices, resetDatabase} from './support/harness';

const DAY = 86_400_000;
const PRICE = 2500;
let seq = 0;
const next = () => ++seq;

/** Runs code the way a payment event or a job does: its own request scope, its client closed after. */
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return inRequestScope(async () => {
    try {
      return await fn();
    } finally {
      await getDb()?.$disconnect();
    }
  });
}

async function mkEvent(over: Record<string, unknown> = {}) {
  const n = next();
  const start = new Date(Date.now() + 7 * DAY);
  const event = await db.event.create({
    data: {
      slug: `itc-${n}`, title: 'Checkout Night', startAt: start, endAt: new Date(start.getTime() + 3_600_000), timezone: 'UTC',
      format: 'online', status: 'published', pollJoinCode: `C${String(n).padStart(5, '0')}`, capacity: 1, ...over,
    },
  });
  const ticket = await db.ticketType.create({data: {eventId: event.id, name: 'General', priceCents: PRICE, currency: 'USD'}});
  return {event, ticket};
}

async function mkGuest(eventId: string, ticketTypeId: string | null, status: 'awaiting_payment' | 'confirmed' | 'waitlisted' | 'cancelled', over: Record<string, unknown> = {}) {
  const n = next();
  return db.rsvp.create({
    data: {
      eventId, ticketTypeId, name: `Guest${n}`, email: `guest${n}@example.test`, response: 'going', status, seats: 1,
      ticketCode: `I${String(n).padStart(7, '0')}`, manageToken: `itc-manage-${n}-${'x'.repeat(20)}`, ...over,
    },
  });
}

async function mkOrder(rsvpId: string, status: string, over: Record<string, unknown> = {}) {
  const n = next();
  return db.ticketOrder.create({
    data: {rsvpId, checkoutId: `pcs_itcorder${String(n).padStart(6, '0')}`, amountCents: PRICE, currency: 'USD', seats: 1, status, ...over},
  });
}

const checkoutOf = (order: {checkoutId: string; rsvpId: string}, over: Partial<Checkout> = {}): Checkout => ({
  id: order.checkoutId, mode: 'test', status: 'paid', price: 'tkt-x-2500-usd', quantity: 1, email: 'buyer@example.test',
  amountCents: PRICE, currency: 'USD', paidAt: new Date().toISOString(), subscription: null, metadata: {rsvpId: order.rsvpId}, customerRef: null,
  ...over,
});

const refundOf = (checkoutId: string, full = true): Refund => ({checkoutId, amountCents: full ? PRICE : 100, currency: 'USD', full, refundedAt: new Date().toISOString()});

const paid = (c: Checkout) => inScope(async () => {
  await paymentHooks.onCheckoutPaid!(c, {} as never);
});
const refunded = (r: Refund) => inScope(async () => {
  await paymentHooks.onRefund!(r, {} as never);
});

async function mkEndpoint() {
  return db.webhookEndpoint.create({
    data: {url: 'https://hooks.example.test/in', secret: 's'.repeat(40), events: ['rsvp.created', 'rsvp.updated', 'rsvp.cancelled', 'order.paid']},
  });
}

/** Parked webhook deliveries: event name + the payload's rsvpId. */
async function outbox() {
  const rows = await db.webhookOutbox.findMany({select: {event: true, body: true, attempts: true}});
  return rows.map(r => ({event: r.event, rsvpId: (JSON.stringify(JSON.parse(r.body)).match(/"rsvpId":"([^"]+)"/) ?? [])[1], attempts: r.attempts}));
}

const guestMail = (rsvpId: string) => db.guestEmailOutbox.findMany({where: {rsvpId}, select: {kind: true, status: true}});

describe.skipIf(!DATABASE_URL)('ticket checkout and refunds (integration, real Postgres)', () => {
  beforeAll(() => {
    configureEnv();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    await db.$executeRawUnsafe('TRUNCATE "orders" RESTART IDENTITY CASCADE');
    platform.byKey.clear();
    platform.creates = 0;
    platform.failCreate = false;
    platform.jobs.length = 0;
  });
  afterEach(() => setPaidCheckoutHook(null));

  it('a paid checkout confirms the booking, queues the confirmation email and parks order.paid before the hook returns', async () => {
    const {event, ticket} = await mkEvent();
    await mkEndpoint();
    const rsvp = await mkGuest(event.id, ticket.id, 'awaiting_payment');
    const order = await mkOrder(rsvp.id, 'pending');

    await paid(checkoutOf(order));

    expect((await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}})).status).toBe('confirmed');
    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: order.id}})).status).toBe('paid');
    expect(await db.order.count({where: {checkoutId: order.checkoutId, status: 'paid'}})).toBe(1);
    expect(await guestMail(rsvp.id)).toEqual([{kind: 'confirmation', status: 'pending'}]);
    // The job send was refused: the delivery is in the outbox, written before the hook resolved.
    expect(platform.jobs.some(j => j.list === 'webhook-deliveries')).toBe(true);
    expect(await outbox()).toEqual([{event: 'order.paid', rsvpId: rsvp.id, attempts: 0}]);

    // The thanks page's confirm and the platform event both run the hook: the repeat changes nothing.
    await paid(checkoutOf(order));
    expect(await guestMail(rsvp.id)).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    expect(ownerNotices()).toHaveLength(0);
  });

  it('a payment whose amount is not the order amount becomes refund_due: owner told once, no seat, no email, no order.paid', async () => {
    const {event, ticket} = await mkEvent();
    await mkEndpoint();
    const rsvp = await mkGuest(event.id, ticket.id, 'awaiting_payment');
    const order = await mkOrder(rsvp.id, 'pending');

    await paid(checkoutOf(order, {amountCents: 1}));
    await paid(checkoutOf(order, {amountCents: 1}));

    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: order.id}})).status).toBe('refund_due');
    expect((await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}})).status).toBe('awaiting_payment');
    expect(await guestMail(rsvp.id)).toEqual([]);
    expect(await outbox()).toEqual([]);
    const notices = ownerNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.path).toBe('/dashboard/refunds');
    expect(notices[0]!.subject).toBe('A ticket payment needs a refund');
    expect(JSON.stringify(notices[0])).not.toContain(rsvp.email);
  });

  it('a second paid checkout for one booking is refund_due; refunding it keeps the guest seated and promotes nobody', async () => {
    const {event, ticket} = await mkEvent({capacity: 1});
    await mkEndpoint();
    const rsvp = await mkGuest(event.id, ticket.id, 'confirmed', {confirmedAt: new Date()});
    await mkOrder(rsvp.id, 'paid');
    const dup = await mkOrder(rsvp.id, 'expired');
    const waiting = await mkGuest(event.id, ticket.id, 'waitlisted', {waitlistPosition: 1});

    await paid(checkoutOf(dup));
    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: dup.id}})).status).toBe('refund_due');
    expect(ownerNotices()).toHaveLength(1);

    await refunded(refundOf(dup.checkoutId));

    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: dup.id}})).status).toBe('refunded');
    expect((await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}})).status).toBe('confirmed');
    const w = await db.rsvp.findUniqueOrThrow({where: {id: waiting.id}});
    expect([w.status, w.claimExpiresAt]).toEqual(['waitlisted', null]);
    expect(await guestMail(waiting.id)).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('a full refund of the only paid order frees the seat, offers it to the waitlist and parks rsvp.cancelled; a partial one changes nothing', async () => {
    const {event, ticket} = await mkEvent({capacity: 1});
    await mkEndpoint();
    const rsvp = await mkGuest(event.id, ticket.id, 'confirmed', {confirmedAt: new Date()});
    const order = await mkOrder(rsvp.id, 'paid');
    const waiting = await mkGuest(event.id, ticket.id, 'waitlisted', {waitlistPosition: 1});

    await refunded(refundOf(order.checkoutId, false));
    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: order.id}})).status).toBe('paid');
    expect((await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}})).status).toBe('confirmed');
    expect(await outbox()).toEqual([]);

    await refunded(refundOf(order.checkoutId));

    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: order.id}})).status).toBe('refunded');
    expect((await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}})).status).toBe('cancelled');
    // A paid event offers the freed seat as a claim (a seat without payment would be a free ticket).
    const w = await db.rsvp.findUniqueOrThrow({where: {id: waiting.id}});
    expect(w.status).toBe('waitlisted');
    expect(w.claimExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(await guestMail(waiting.id)).toEqual([{kind: 'waitlist_offer', status: 'pending'}]);
    expect(await outbox()).toEqual([{event: 'rsvp.cancelled', rsvpId: rsvp.id, attempts: 0}]);

    // The platform sends the refund event again: nothing more happens.
    await refunded(refundOf(order.checkoutId));
    expect(await outbox()).toHaveLength(1);
    expect(await guestMail(waiting.id)).toHaveLength(1);
  });

  it('ten RSVPs at once for the last paid seat: exactly one holds it and starts one checkout', async () => {
    const {event, ticket} = await mkEvent({capacity: 1, waitlistEnabled: false});
    setPaidCheckoutHook(async ({origin, rsvp}) => {
      const started = await startTicketCheckout(getDb()!, rsvp.id, {requestUrl: origin});
      return started.ok ? {checkoutUrl: started.redirectUrl} : null;
    });

    const results = await Promise.all(
      Array.from({length: 10}, (_, i) =>
        new Browser(eventsApp, `198.51.100.${40 + i}`).post(`/site-api/rsvp/events/${event.slug}`, rsvpBody(`racer${i}@example.test`, {ticketTypeId: ticket.id})),
      ),
    );

    const won = results.filter(r => r.status === 202);
    expect(won).toHaveLength(1);
    expect(String(won[0]!.json.checkoutUrl)).toMatch(/^\/checkout\/\?id=pcs_/);
    expect(results.filter(r => r.status === 409)).toHaveLength(9);
    const held = await db.rsvp.findMany({where: {eventId: event.id}, select: {id: true, status: true}});
    expect(held).toHaveLength(1);
    expect(held[0]!.status).toBe('awaiting_payment');
    const orders = await db.ticketOrder.findMany({where: {rsvp: {eventId: event.id}}, select: {status: true, amountCents: true, rsvpId: true}});
    expect(orders).toEqual([{status: 'pending', amountCents: PRICE, rsvpId: held[0]!.id}]);
  });

  it('M-1: a checkout that cannot start leaves no booking, so the seat is still free', async () => {
    const {event, ticket} = await mkEvent({capacity: 1, waitlistEnabled: false});
    setPaidCheckoutHook(async ({origin, rsvp}) => {
      const started = await startTicketCheckout(getDb()!, rsvp.id, {requestUrl: origin});
      return started.ok ? {checkoutUrl: started.redirectUrl} : null;
    });
    platform.failCreate = true;
    const first = await new Browser(eventsApp, '198.51.100.60').post(`/site-api/rsvp/events/${event.slug}`, rsvpBody('down@example.test', {ticketTypeId: ticket.id}));
    expect(first.status).toBe(409);
    expect(await db.rsvp.count({where: {eventId: event.id}})).toBe(0);
    expect(await db.ticketOrder.count()).toBe(0);

    platform.failCreate = false;
    const second = await new Browser(eventsApp, '198.51.100.61').post(`/site-api/rsvp/events/${event.slug}`, rsvpBody('up@example.test', {ticketTypeId: ticket.id}));
    expect(second.status).toBe(202);
    expect(await db.rsvp.count({where: {eventId: event.id, status: 'awaiting_payment'}})).toBe(1);
  });

  it('an expired hold is released by the sweep: order expired, seat offered to the waitlist, emails queued, rsvp.cancelled parked', async () => {
    const {event, ticket} = await mkEvent({capacity: 1});
    await mkEndpoint();
    const holder = await mkGuest(event.id, ticket.id, 'awaiting_payment');
    const order = await mkOrder(holder.id, 'pending');
    const waiting = await mkGuest(event.id, ticket.id, 'waitlisted', {waitlistPosition: 1});

    // Not yet lapsed: nothing released.
    expect(await inScope(() => expireCheckoutHolds(db as never, new Date()))).toEqual({released: []});

    const later = new Date(Date.now() + 31 * 60_000);
    expect(await inScope(() => expireCheckoutHolds(db as never, later))).toEqual({released: [holder.id]});

    expect((await db.rsvp.findUniqueOrThrow({where: {id: holder.id}})).status).toBe('cancelled');
    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: order.id}})).status).toBe('expired');
    const w = await db.rsvp.findUniqueOrThrow({where: {id: waiting.id}});
    expect(w.status).toBe('waitlisted');
    expect(w.claimExpiresAt).not.toBeNull();
    expect(await guestMail(holder.id)).toEqual([{kind: 'hold_expired', status: 'pending'}]);
    expect(await guestMail(waiting.id)).toEqual([{kind: 'waitlist_offer', status: 'pending'}]);
    expect(await outbox()).toEqual([{event: 'rsvp.cancelled', rsvpId: holder.id, attempts: 0}]);

    // A second tick finds nothing.
    expect(await inScope(() => expireCheckoutHolds(db as never, later))).toEqual({released: []});
    expect(await outbox()).toHaveLength(1);
  });

  it('money after the hold lapsed: refund_due when the seat was offered on, confirmed again when it is still free', async () => {
    const {event, ticket} = await mkEvent({capacity: 1});
    const late = await mkGuest(event.id, ticket.id, 'awaiting_payment');
    const lateOrder = await mkOrder(late.id, 'pending');
    await mkGuest(event.id, ticket.id, 'waitlisted', {waitlistPosition: 1});
    await inScope(() => expireCheckoutHolds(db as never, new Date(Date.now() + 31 * 60_000)));

    await paid(checkoutOf(lateOrder));
    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: lateOrder.id}})).status).toBe('refund_due');
    expect((await db.rsvp.findUniqueOrThrow({where: {id: late.id}})).status).toBe('cancelled');

    // A second event with no waitlist: the freed seat is still there when the money arrives.
    const other = await mkEvent({capacity: 1});
    await mkEndpoint();
    const g = await mkGuest(other.event.id, other.ticket.id, 'awaiting_payment');
    const o = await mkOrder(g.id, 'pending');
    await inScope(() => expireCheckoutHolds(db as never, new Date(Date.now() + 31 * 60_000)));
    expect((await db.rsvp.findUniqueOrThrow({where: {id: g.id}})).status).toBe('cancelled');
    await paid(checkoutOf(o));
    expect((await db.rsvp.findUniqueOrThrow({where: {id: g.id}})).status).toBe('confirmed');
    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: o.id}})).status).toBe('paid');
    expect((await outbox()).filter(r => r.event === 'order.paid')).toEqual([{event: 'order.paid', rsvpId: g.id, attempts: 0}]);
  });

  it('a failed checkout gives the held seat back at once and parks rsvp.cancelled', async () => {
    const {event, ticket} = await mkEvent({capacity: 1});
    await mkEndpoint();
    const rsvp = await mkGuest(event.id, ticket.id, 'awaiting_payment');
    const order = await mkOrder(rsvp.id, 'pending');

    await inScope(async () => {
      await paymentHooks.onCheckoutFailed!(checkoutOf(order, {status: 'failed', paidAt: null}), {} as never);
    });

    expect((await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}})).status).toBe('cancelled');
    expect((await db.ticketOrder.findUniqueOrThrow({where: {id: order.id}})).status).toBe('expired');
    expect(await db.order.count({where: {checkoutId: order.checkoutId, status: 'failed'}})).toBe(1);
    expect(await guestMail(rsvp.id)).toEqual([{kind: 'hold_expired', status: 'pending'}]);
    expect(await outbox()).toEqual([{event: 'rsvp.cancelled', rsvpId: rsvp.id, attempts: 0}]);
  });
});
