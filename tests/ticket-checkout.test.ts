import {beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeDb} from './ticket-fake-db';

const queued: Array<{kind: string; rsvpId: string}> = [];
vi.mock('../src/server/jobs/guest-emails', () => ({
  GUEST_EMAIL_LIST: 'rsvp-emails',
  queueGuestEmail: async (kind: string, rsvpId: string) => void queued.push({kind, rsvpId}),
  sendGuestEmail: vi.fn(),
}));

const payments = vi.hoisted(() => ({
  findPrice: vi.fn(),
  createPrice: vi.fn(),
  createCheckout: vi.fn(),
  getCheckout: vi.fn(),
}));
vi.mock('../src/platform/payments', async importOriginal => ({...(await importOriginal<object>()), ...payments}));

import {confirmPaidTicket, markEventOrdersRefundDue, refundedTicket, startTicketCheckout, ticketPriceKey} from '../src/server/ticket-checkout';

const asDb = (db: FakeDb) => db as never;
const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

function setup(over: {capacity?: number | null} = {}) {
  const db = new FakeDb();
  const event = db.addEvent({capacity: over.capacity ?? null});
  const ticket = db.addTicket(event.id, {priceCents: 2500});
  const rsvp = db.addRsvp(event.id, {ticketTypeId: ticket.id, seats: 2});
  return {db, event, ticket, rsvp};
}

const paidCheckout = (order: {checkoutId: string; amountCents: number; currency: string; rsvpId: string}, over: Record<string, unknown> = {}) => ({
  id: order.checkoutId,
  mode: 'test',
  status: 'paid',
  price: 'tkt-x',
  quantity: 2,
  email: 'ada@example.com',
  amountCents: order.amountCents,
  currency: order.currency,
  paidAt: new Date().toISOString(),
  subscription: null,
  metadata: {rsvpId: order.rsvpId},
  customerRef: null,
  ...over,
});

beforeEach(() => {
  queued.length = 0;
  for (const fn of Object.values(payments)) fn.mockReset();
});

describe('ticketPriceKey', () => {
  it('is a valid catalogue key, stable, and changes with the amount', () => {
    const t = {id: '8f14e45f-ceea-4e67-a1b2-0123456789ab', priceCents: 2500, currency: 'USD'};
    expect(ticketPriceKey(t)).toBe('tkt-8f14e45fceea4e67a1b20123-2500-usd');
    expect(ticketPriceKey(t)).toMatch(KEY);
    expect(ticketPriceKey({...t, priceCents: 3000})).not.toBe(ticketPriceKey(t));
    expect(ticketPriceKey({...t, priceCents: 15_000_000, currency: 'IDR'})).toMatch(KEY);
  });
});

describe('startTicketCheckout', () => {
  it('charges price x seats from the ticket type, creates the price when missing, records a pending order', async () => {
    const {db, rsvp, ticket} = setup();
    payments.findPrice.mockResolvedValue({ok: true, data: null});
    payments.createPrice.mockResolvedValue({ok: true, data: {}});
    payments.createCheckout.mockResolvedValue({ok: true, data: {id: 'pcs_abcdefgh1', mode: 'test', embedded: {kind: 'window', gateway: 'x', checkoutUrl: 'https://p/x', returnUrl: '/thanks/'}}});

    const result = await startTicketCheckout(asDb(db), rsvp.id, {requestUrl: 'https://site.test/x'});

    expect(result).toMatchObject({ok: true, checkoutId: 'pcs_abcdefgh1', redirectUrl: '/checkout/?id=pcs_abcdefgh1', reused: false});
    expect(payments.createPrice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({key: ticketPriceKey(ticket), amountCents: 2500, interval: 'one_time'}));
    expect(payments.createCheckout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({price: ticketPriceKey(ticket), quantity: 2, metadata: expect.objectContaining({rsvpId: rsvp.id})}));
    expect(db.ticketOrder.rows).toHaveLength(1);
    expect(db.ticketOrder.rows[0]).toMatchObject({rsvpId: rsvp.id, checkoutId: 'pcs_abcdefgh1', amountCents: 5000, currency: 'USD', seats: 2, status: 'pending'});
  });

  it('resumes an open checkout instead of starting a second one', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id);
    const embedded = {kind: 'window', gateway: 'x', checkoutUrl: 'https://p/x', returnUrl: '/thanks/'};
    payments.getCheckout.mockResolvedValue({ok: true, data: {status: 'open', embedded}});
    const result = await startTicketCheckout(asDb(db), rsvp.id);
    expect(result).toMatchObject({ok: true, checkoutId: order.checkoutId, reused: true});
    expect(payments.createCheckout).not.toHaveBeenCalled();
  });

  it('retires a closed checkout and starts a new one', async () => {
    const {db, rsvp} = setup();
    const old = db.addOrder(rsvp.id);
    payments.getCheckout.mockResolvedValue({ok: true, data: {status: 'expired', embedded: null}});
    payments.findPrice.mockResolvedValue({ok: true, data: {amountCents: 2500, currency: 'USD'}});
    payments.createCheckout.mockResolvedValue({ok: true, data: {id: 'pcs_newcheck1', mode: 'test', embedded: null}});
    const result = await startTicketCheckout(asDb(db), rsvp.id);
    expect(result).toMatchObject({ok: true, checkoutId: 'pcs_newcheck1'});
    expect(db.ticketOrder.rows.find(o => o.id === old.id)?.status).toBe('expired');
  });

  it('refuses free tickets, wrong status, and a live site that lacks the ticket price', async () => {
    const {db, event, rsvp} = setup();
    const free = db.addTicket(event.id, {priceCents: 0});
    const freeRsvp = db.addRsvp(event.id, {ticketTypeId: free.id});
    expect(await startTicketCheckout(asDb(db), freeRsvp.id)).toMatchObject({ok: false, code: 'no_payment_due'});

    const confirmed = db.addRsvp(event.id, {ticketTypeId: free.id, status: 'confirmed'});
    expect(await startTicketCheckout(asDb(db), confirmed.id)).toMatchObject({ok: false, status: 409});

    payments.findPrice.mockResolvedValue({ok: true, data: null});
    payments.createPrice.mockResolvedValue({ok: false, status: 403, code: 'E_PAYMENTS_EDITOR_ONLY', message: 'editor only'});
    expect(await startTicketCheckout(asDb(db), rsvp.id)).toMatchObject({ok: false, status: 503, code: 'ticket_price_missing'});
    expect(payments.createCheckout).not.toHaveBeenCalled();
  });

  it('never charges when the catalogue amount differs from the ticket price', async () => {
    const {db, rsvp} = setup();
    payments.findPrice.mockResolvedValue({ok: true, data: {amountCents: 100, currency: 'USD'}});
    expect(await startTicketCheckout(asDb(db), rsvp.id)).toMatchObject({ok: false, code: 'ticket_price_mismatch'});
    expect(payments.createCheckout).not.toHaveBeenCalled();
  });
});

describe('confirmPaidTicket', () => {
  it('confirms the RSVP, marks the order paid and queues one confirmation email, once', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000, seats: 2});
    const checkout = paidCheckout(order) as never;

    expect(await confirmPaidTicket(asDb(db), checkout)).toEqual({kind: 'confirmed', rsvpId: rsvp.id});
    expect(db.rsvp.rows[0]).toMatchObject({status: 'confirmed'});
    expect(db.rsvp.rows[0]!.confirmedAt).toBeInstanceOf(Date);
    expect(db.ticketOrder.rows[0]!.status).toBe('paid');
    expect(queued).toEqual([{kind: 'confirmation', rsvpId: rsvp.id}]);

    // The platform event AND the thanks page's confirm: the second call is a no-op.
    expect(await confirmPaidTicket(asDb(db), checkout)).toEqual({kind: 'already'});
    expect(queued).toHaveLength(1);
  });

  it('ignores a checkout that is not a ticket (a different purchase)', async () => {
    const {db} = setup();
    expect(await confirmPaidTicket(asDb(db), paidCheckout({checkoutId: 'pcs_other0001', amountCents: 1, currency: 'USD', rsvpId: 'x'}) as never)).toEqual({kind: 'not_ours'});
  });

  it('marks refund_due when the paid amount is not the order amount', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    const result = await confirmPaidTicket(asDb(db), paidCheckout(order, {amountCents: 100}) as never);
    expect(result).toMatchObject({kind: 'refund_due', reason: 'amount_mismatch'});
    expect(db.rsvp.rows[0]!.status).toBe('awaiting_payment');
    expect(db.ticketOrder.rows[0]!.status).toBe('refund_due');
    expect(queued).toEqual([]);
  });

  it('re-seats a guest whose hold lapsed when seats are still free', async () => {
    const {db, rsvp} = setup({capacity: 10});
    db.rsvp.rows[0]!.status = 'cancelled';
    const order = db.addOrder(rsvp.id, {amountCents: 5000, status: 'expired'});
    expect(await confirmPaidTicket(asDb(db), paidCheckout(order) as never)).toMatchObject({kind: 'confirmed'});
    expect(db.rsvp.rows[0]!.status).toBe('confirmed');
    expect(db.ticketOrder.rows[0]!.status).toBe('paid');
  });

  it('refunds instead of overselling when the hold lapsed and the seats are gone', async () => {
    const {db, event, rsvp} = setup({capacity: 2});
    db.rsvp.rows[0]!.status = 'cancelled';
    db.addRsvp(event.id, {status: 'confirmed', seats: 2});
    const order = db.addOrder(rsvp.id, {amountCents: 5000, status: 'expired'});
    expect(await confirmPaidTicket(asDb(db), paidCheckout(order) as never)).toMatchObject({kind: 'refund_due', reason: 'hold_lapsed_no_seats'});
    expect(db.rsvp.rows[0]!.status).toBe('cancelled');
    expect(db.ticketOrder.rows[0]!.status).toBe('refund_due');
  });

  it('refunds a payment for a cancelled event', async () => {
    const {db, event, rsvp} = setup();
    event.status = 'cancelled';
    const order = db.addOrder(rsvp.id, {amountCents: 5000});
    expect(await confirmPaidTicket(asDb(db), paidCheckout(order) as never)).toMatchObject({kind: 'refund_due', reason: 'event_closed'});
  });
});

describe('refunds', () => {
  it('a full refund closes the order, frees the seat and offers it to the waitlist (paid event)', async () => {
    const {db, event, rsvp} = setup({capacity: 2});
    db.rsvp.rows[0]!.status = 'confirmed';
    const order = db.addOrder(rsvp.id, {status: 'paid', amountCents: 5000});
    const waiting = db.addRsvp(event.id, {status: 'waitlisted', seats: 1, waitlistPosition: 1});

    expect(await refundedTicket(asDb(db), {checkoutId: order.checkoutId, amountCents: 5000, currency: 'USD', full: true, refundedAt: new Date().toISOString()})).toEqual({closed: true});
    expect(db.ticketOrder.rows[0]!.status).toBe('refunded');
    expect(db.rsvp.rows.find(r => r.id === rsvp.id)!.status).toBe('cancelled');
    expect(db.rsvp.rows.find(r => r.id === waiting.id)!.claimExpiresAt).toBeInstanceOf(Date);
    expect(queued).toEqual([{kind: 'waitlist_offer', rsvpId: waiting.id}]);
  });

  it('a partial refund changes nothing', async () => {
    const {db, rsvp} = setup();
    const order = db.addOrder(rsvp.id, {status: 'paid'});
    expect(await refundedTicket(asDb(db), {checkoutId: order.checkoutId, amountCents: 100, currency: 'USD', full: false, refundedAt: ''})).toEqual({closed: false});
    expect(db.ticketOrder.rows[0]!.status).toBe('paid');
  });

  it('cancelling an event makes every paid ticket refund_due', async () => {
    const {db, event, rsvp} = setup();
    db.addOrder(rsvp.id, {status: 'paid'});
    const other = db.addRsvp(event.id);
    db.addOrder(other.id, {status: 'pending'});
    expect(await markEventOrdersRefundDue(asDb(db), event.id)).toBe(1);
    expect(db.ticketOrder.rows.map(o => o.status)).toEqual(['refund_due', 'pending']);
  });
});
