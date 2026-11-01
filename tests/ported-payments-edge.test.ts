import {beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeDbX} from './fakes-extra';
import {FakeDb} from './ticket-fake-db';

const queued: Array<{kind: string; rsvpId: string; stamp?: string}> = [];
vi.mock('../src/server/jobs/guest-emails', () => ({
  GUEST_EMAIL_LIST: 'rsvp-emails',
  queueGuestEmail: async (kind: string, rsvpId: string, stamp?: string) => void queued.push({kind, rsvpId, stamp}),
  sendGuestEmail: vi.fn(),
}));
const webhooks = vi.hoisted(() => ({dispatchWebhook: vi.fn(async () => 1)}));
vi.mock('../src/server/webhooks', async orig => ({...(await orig<object>()), ...webhooks}));
const payments = vi.hoisted(() => ({findPrice: vi.fn(), createPrice: vi.fn(), createCheckout: vi.fn(), getCheckout: vi.fn()}));
vi.mock('../src/platform/payments', async orig => ({...(await orig<object>()), ...payments}));
const dbHolder = vi.hoisted(() => ({db: null as unknown}));
vi.mock('../src/platform/db', () => ({getDb: () => dbHolder.db}));

import {paymentHooks} from '../src/server/payments-hooks';
import {confirmPaidTicket, markEventOrdersRefundDue, refundedTicket, startTicketCheckout, ticketPriceKey} from '../src/server/ticket-checkout';

const asDb = (db: FakeDb) => db as never;
const hookEvent = {id: 'evt_test', type: 'test', mode: 'test'} as never;
const tick = () => new Promise(r => setTimeout(r, 5));

function setup(over: {capacity?: number | null; seats?: number} = {}) {
  const db = new FakeDbX();
  const event = db.addEvent({capacity: over.capacity ?? null});
  const ticket = db.addTicket(event.id, {priceCents: 2500, currency: 'USD'});
  const rsvp = db.addRsvp(event.id, {ticketTypeId: ticket.id, seats: over.seats ?? 2});
  return {db, event, ticket, rsvp};
}
const paid = (o: {checkoutId: string; amountCents: number; currency: string; rsvpId: string}, over: Record<string, unknown> = {}) =>
  ({id: o.checkoutId, mode: 'test', status: 'paid', price: 'p', quantity: 2, email: 'A@Example.com', amountCents: o.amountCents, currency: o.currency, paidAt: new Date().toISOString(), subscription: null, metadata: {rsvpId: o.rsvpId}, customerRef: null, ...over}) as never;

beforeEach(() => {
  queued.length = 0;
  webhooks.dispatchWebhook.mockClear();
  for (const f of Object.values(payments)) f.mockReset();
});

describe('confirmPaidTicket: amount and currency handling', () => {
  it('compares currency case-insensitively (usd vs USD is fine)', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000, currency: 'USD'});
    expect(await confirmPaidTicket(asDb(db), paid(order, {currency: 'usd'}))).toMatchObject({kind: 'confirmed'});
  });

  it('a different currency with the same amount is refund_due, RSVP stays held, no email', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000, currency: 'USD'});
    expect(await confirmPaidTicket(asDb(db), paid(order, {currency: 'EUR'}))).toMatchObject({kind: 'refund_due', reason: 'amount_mismatch'});
    expect(db.ticketOrder.rows[0]!.status).toBe('refund_due');
    expect(db.rsvp.rows[0]!.status).toBe('awaiting_payment');
    expect(queued).toEqual([]);
    expect(webhooks.dispatchWebhook).not.toHaveBeenCalled();
  });

  it('an overpayment is also a mismatch (never silently accepted)', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paid(order, {amountCents: 5001}))).toMatchObject({kind: 'refund_due', reason: 'amount_mismatch'});
  });

  it('metadata naming a different RSVP is treated as tampering', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paid({...order, rsvpId: 'other-rsvp'}))).toMatchObject({kind: 'refund_due'});
    expect(db.rsvp.rows[0]!.status).toBe('awaiting_payment');
  });

  it('missing metadata.rsvpId does not block a correct payment', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paid(order, {metadata: {}}))).toMatchObject({kind: 'confirmed'});
  });
});

describe('confirmPaidTicket: idempotency and refund_due transitions', () => {
  it.each(['paid', 'refunded', 'refund_due'])('order already %s is a no-op', async status => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000, status});
    expect(await confirmPaidTicket(asDb(db), paid(order))).toEqual({kind: 'already'});
    expect(db.rsvp.rows[0]!.status).toBe('awaiting_payment');
    expect(queued).toEqual([]);
  });

  it('concurrent confirms queue one email and emit order.paid once', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    const results = await Promise.all([confirmPaidTicket(asDb(db), paid(order)), confirmPaidTicket(asDb(db), paid(order))]);
    await tick();
    expect(results.filter(r => r.kind === 'confirmed').length).toBe(1);
    expect(queued.filter(q => q.kind === 'confirmation')).toHaveLength(1);
    expect(webhooks.dispatchWebhook).toHaveBeenCalledTimes(1);
    expect(webhooks.dispatchWebhook).toHaveBeenCalledWith(expect.anything(), 'order.paid', {eventId: rsvp.eventId, rsvpId: rsvp.id}, expect.anything());
  });

  it('an already-confirmed RSVP with a pending order just marks it paid (no second email)', async () => {
    const {db, rsvp} = setup();
    db.rsvp.rows[0]!.status = 'confirmed';
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paid(order))).toEqual({kind: 'already'});
    expect(db.ticketOrder.rows[0]!.status).toBe('paid');
    expect(queued).toEqual([]);
  });

  it('a payment for an RSVP in another state (waitlisted) is refund_due, order not paid', async () => {
    const {db, rsvp} = setup();
    db.rsvp.rows[0]!.status = 'waitlisted';
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paid(order))).toMatchObject({kind: 'refund_due', reason: 'rsvp_waitlisted'});
    expect(db.ticketOrder.rows[0]!.status).toBe('refund_due');
  });

  it('a deleted event is refund_due (event_closed)', async () => {
    const {db, event, rsvp} = setup();
    (event as {deletedAt: Date | null}).deletedAt = new Date();
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paid(order))).toMatchObject({kind: 'refund_due', reason: 'event_closed'});
  });

  it('after a refund_due the same payment event replayed stays refund_due', async () => {
    const {db, event, rsvp} = setup({capacity: 2});
    db.rsvp.rows[0]!.status = 'cancelled';
    db.addRsvp(event.id, {status: 'confirmed', seats: 2});
    const order = db.addOrder(rsvp.id, {amountCents: 5000, status: 'expired'});
    await confirmPaidTicket(asDb(db), paid(order));
    expect(await confirmPaidTicket(asDb(db), paid(order))).toEqual({kind: 'already'});
    expect(db.ticketOrder.rows[0]!.status).toBe('refund_due');
  });

  it('open waitlist claim seats are not free for a late payment', async () => {
    const {db, event, rsvp} = setup({capacity: 3});
    db.rsvp.rows[0]!.status = 'cancelled'; // needs 2 seats
    db.addRsvp(event.id, {status: 'confirmed', seats: 1});
    db.addRsvp(event.id, {status: 'waitlisted', seats: 1, claimExpiresAt: new Date(Date.now() + 3_600_000)});
    const order = db.addOrder(rsvp.id, {amountCents: 5000, status: 'expired'});
    expect(await confirmPaidTicket(asDb(db), paid(order))).toMatchObject({kind: 'refund_due', reason: 'hold_lapsed_no_seats'});
  });
});

describe('refunds', () => {
  const refund = (checkoutId: string, over: Record<string, unknown> = {}) => ({checkoutId, amountCents: 5000, currency: 'USD', full: true, refundedAt: '', ...over}) as never;

  it('refund_due order closes on full refund; replay is a no-op and promotes nobody twice', async () => {
    const {db, event, rsvp} = setup({capacity: 2});
    db.rsvp.rows[0]!.status = 'confirmed';
    const order = db.addOrder(rsvp.id, {status: 'refund_due'});
    db.addRsvp(event.id, {status: 'waitlisted', seats: 1, waitlistPosition: 1});
    expect(await refundedTicket(asDb(db), refund(order.checkoutId))).toEqual({closed: true});
    expect(db.ticketOrder.rows[0]!.status).toBe('refunded');
    expect(queued).toHaveLength(1);
    expect(await refundedTicket(asDb(db), refund(order.checkoutId))).toEqual({closed: false});
    expect(queued).toHaveLength(1);
  });

  it('unknown checkout is ignored', async () => {
    const {db} = setup();
    expect(await refundedTicket(asDb(db), refund('pcs_nope0001'))).toEqual({closed: false});
  });

  it('refund of a refund_due order whose RSVP stayed cancelled promotes no one', async () => {
    const {db, event, rsvp} = setup({capacity: 2});
    db.rsvp.rows[0]!.status = 'cancelled';
    const order = db.addOrder(rsvp.id, {status: 'refund_due'});
    const w = db.addRsvp(event.id, {status: 'waitlisted', seats: 1, waitlistPosition: 1});
    expect(await refundedTicket(asDb(db), refund(order.checkoutId))).toEqual({closed: true});
    expect(db.rsvp.rows.find(r => r.id === w.id)!.claimExpiresAt).toBeNull();
    expect(queued).toEqual([]);
  });

  it('a refunded order is not re-confirmed by a late paid event', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {status: 'refunded', amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paid(order))).toEqual({kind: 'already'});
    expect(db.rsvp.rows[0]!.status).toBe('awaiting_payment');
  });

  it('markEventOrdersRefundDue is idempotent and only touches paid orders of that event', async () => {
    const {db, event, rsvp} = setup();
    db.addOrder(rsvp.id, {status: 'paid'});
    const otherEvent = db.addEvent();
    const otherRsvp = db.addRsvp(otherEvent.id);
    db.addOrder(otherRsvp.id, {status: 'paid'});
    db.addOrder(db.addRsvp(event.id).id, {status: 'refunded'});
    expect(await markEventOrdersRefundDue(asDb(db), event.id)).toBe(1);
    expect(await markEventOrdersRefundDue(asDb(db), event.id)).toBe(0);
    expect(db.ticketOrder.rows.map(o => o.status)).toEqual(['refund_due', 'paid', 'refunded']);
  });
});

describe('startTicketCheckout amounts', () => {
  it('uppercases currency, multiplies by seats, and keys the price by amount+currency', async () => {
    const {db, rsvp, ticket} = setup({seats: 3});
    ticket.currency = 'usd';
    payments.findPrice.mockResolvedValue({ok: true, data: {amountCents: 2500, currency: 'usd'}});
    payments.createCheckout.mockResolvedValue({ok: true, data: {id: 'pcs_abcdefgh2', mode: 'test', embedded: null}});
    await startTicketCheckout(asDb(db), rsvp.id);
    expect(db.ticketOrder.rows[0]).toMatchObject({amountCents: 7500, currency: 'USD', seats: 3});
    expect(ticketPriceKey(ticket as never)).toMatch(/-2500-usd$/);
  });

  it('refuses when only the currency differs from the catalogue', async () => {
    const {db, rsvp} = setup();
    payments.findPrice.mockResolvedValue({ok: true, data: {amountCents: 2500, currency: 'EUR'}});
    expect(await startTicketCheckout(asDb(db), rsvp.id)).toMatchObject({ok: false, code: 'ticket_price_mismatch'});
    expect(payments.createCheckout).not.toHaveBeenCalled();
  });

  it('a duplicate order write (unique checkoutId) does not throw', async () => {
    const {db, rsvp} = setup();
    payments.findPrice.mockResolvedValue({ok: true, data: {amountCents: 2500, currency: 'USD'}});
    payments.createCheckout.mockResolvedValue({ok: true, data: {id: 'pcs_dup00001', mode: 'test', embedded: null}});
    db.ticketOrder.create = async () => {
      throw Object.assign(new Error('dup'), {code: 'P2002'});
    };
    expect(await startTicketCheckout(asDb(db), rsvp.id)).toMatchObject({ok: true, checkoutId: 'pcs_dup00001'});
  });

  it('maps platform failures: 404 -> 503, 500 -> 502', async () => {
    const {db, rsvp} = setup();
    payments.findPrice.mockResolvedValue({ok: true, data: {amountCents: 2500, currency: 'USD'}});
    payments.createCheckout.mockResolvedValue({ok: false, status: 404, code: 'E_X', message: 'm'});
    expect(await startTicketCheckout(asDb(db), rsvp.id)).toMatchObject({ok: false, status: 503});
    payments.createCheckout.mockResolvedValue({ok: false, status: 500, code: 'E_Y', message: 'm'});
    expect(await startTicketCheckout(asDb(db), rsvp.id)).toMatchObject({ok: false, status: 502});
  });
});

describe('paymentHooks', () => {
  const checkout = (id: string, over: Record<string, unknown> = {}) => ({id, mode: 'test', status: 'paid', price: 'p', quantity: 2, email: 'A@Example.com', amountCents: 5000, currency: 'USD', paidAt: new Date().toISOString(), subscription: null, metadata: {}, customerRef: '7', ...over}) as never;

  it('onCheckoutPaid records the order once and confirms the ticket; replay is harmless', async () => {
    const {db, rsvp} = setup();
    dbHolder.db = db;
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    await paymentHooks.onCheckoutPaid!(checkout(order.checkoutId, {metadata: {rsvpId: rsvp.id}}), hookEvent);
    await paymentHooks.onCheckoutPaid!(checkout(order.checkoutId, {metadata: {rsvpId: rsvp.id}}), hookEvent);
    expect(db.order.rows).toHaveLength(1);
    expect(db.order.rows[0]).toMatchObject({email: 'a@example.com', userId: 7, amountCents: 5000, status: 'paid'});
    expect(db.rsvp.rows[0]!.status).toBe('confirmed');
    expect(queued.filter(q => q.kind === 'confirmation')).toHaveLength(1);
  });

  it('a failed event can be followed by a paid one (failed -> paid) but never paid -> failed', async () => {
    const {db} = setup();
    dbHolder.db = db;
    await paymentHooks.onCheckoutFailed!(checkout('pcs_f0000001', {status: 'failed'}), hookEvent);
    expect(db.order.rows[0]!.status).toBe('failed');
    await paymentHooks.onCheckoutPaid!(checkout('pcs_f0000001'), hookEvent);
    expect(db.order.rows[0]!.status).toBe('paid');
    await paymentHooks.onCheckoutFailed!(checkout('pcs_f0000001', {status: 'failed'}), hookEvent);
    expect(db.order.rows[0]!.status).toBe('paid');
  });

  it('onCheckoutFailed releases the hold of a pending order, once', async () => {
    const {db, rsvp} = setup({capacity: 5});
    dbHolder.db = db;
    const order = db.addOrder(rsvp.id, {status: 'pending'});
    await paymentHooks.onCheckoutFailed!(checkout(order.checkoutId, {status: 'failed'}), hookEvent);
    expect(db.rsvp.rows[0]!.status).toBe('cancelled');
    expect(db.ticketOrder.rows[0]!.status).toBe('expired');
    await paymentHooks.onCheckoutFailed!(checkout(order.checkoutId, {status: 'failed'}), hookEvent);
    expect(queued.filter(q => q.kind === 'hold_expired')).toHaveLength(1);
  });

  it('onCheckoutFailed leaves a paid ticket alone', async () => {
    const {db, rsvp} = setup();
    dbHolder.db = db;
    db.rsvp.rows[0]!.status = 'confirmed';
    const order = db.addOrder(rsvp.id, {status: 'paid'});
    await paymentHooks.onCheckoutFailed!(checkout(order.checkoutId, {status: 'failed'}), hookEvent);
    expect(db.rsvp.rows[0]!.status).toBe('confirmed');
  });

  it('onRefund: partial -> partially_refunded, RSVP kept; full -> refunded + RSVP cancelled', async () => {
    const {db, rsvp} = setup();
    dbHolder.db = db;
    db.rsvp.rows[0]!.status = 'confirmed';
    const order = db.addOrder(rsvp.id, {status: 'paid'});
    db.order.rows.push({id: 'o1', checkoutId: order.checkoutId, status: 'paid'});
    await paymentHooks.onRefund!({checkoutId: order.checkoutId, amountCents: 100, currency: 'USD', full: false, refundedAt: ''} as never, hookEvent);
    expect(db.order.rows[0]!.status).toBe('partially_refunded');
    expect(db.rsvp.rows[0]!.status).toBe('confirmed');
    await paymentHooks.onRefund!({checkoutId: order.checkoutId, amountCents: 5000, currency: 'USD', full: true, refundedAt: ''} as never, hookEvent);
    expect(db.order.rows[0]!.status).toBe('refunded');
    expect(db.ticketOrder.rows[0]!.status).toBe('refunded');
    expect(db.rsvp.rows[0]!.status).toBe('cancelled');
  });

  it('throws when there is no Site Database so the platform retries', async () => {
    dbHolder.db = null;
    await expect(paymentHooks.onCheckoutPaid!(checkout('pcs_x0000001'), hookEvent)).rejects.toThrow(/No Site Database/);
  });
});
