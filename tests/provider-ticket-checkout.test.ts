import {env} from 'cloudflare:workers';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * A ticket checkout at the owner's own provider (src/server/payments/provider-tickets.ts and
 * provider-confirm.ts): the amount comes from the STORED price, the attempt's id is the
 * idempotency key, and a paid checkout goes through the SAME confirmPaidTicket as the built-in one.
 */

const hooks = vi.hoisted(() => ({confirmPaidTicket: vi.fn(async () => ({kind: 'confirmed', rsvpId: 'r'})), refundedTicket: vi.fn(async () => ({closed: true}))}));
vi.mock('../src/server/ticket-checkout', async orig => ({...(await orig<object>()), ...hooks}));
const holds = vi.hoisted(() => ({releaseHold: vi.fn(async () => ({released: true, promoted: []}))}));
vi.mock('../src/server/jobs/holds', async orig => ({...(await orig<object>()), ...holds}));
const store = vi.hoisted(() => ({db: null as unknown}));
vi.mock('../src/platform/db', () => ({getDb: () => store.db}));

import {Hono} from 'hono';

import {resetWebhookLimitForTests, signTimestamped} from '../src/platform/payment-providers';
import {syncProviderCheckout} from '../src/server/payments/provider-confirm';
import {startProviderTicketCheckout} from '../src/server/payments/provider-tickets';
import {providerWebhooks} from '../src/server/routes/provider-webhooks';

const vars = env as Record<string, string | undefined>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const RSVP = '0190aaaa-bbbb-7ccc-8ddd-000000000001';
const TICKET = '0190aaaa-bbbb-7ccc-8ddd-0000000000aa';
const BASE_KEY = 'tkt-0190aaaabbbb7ccc8ddd0000-1500-usd';
const PRICE = {id: 4, key: BASE_KEY, provider: 'stripe', mode: 'test', providerPriceId: 'price_abcdef123', amountMinor: 1500, currency: 'USD', interval: 'one_time', archivedAt: null};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vars.STRIPE_SECRET_KEY = 'sk_test_FAKEFAKEFAKE';
  vars.STRIPE_WEBHOOK_SECRET = 'whsec_fakefakefakefake';
  fetchMock = vi.fn(async () => json(500, {error: {code: 'unexpected'}}));
  vi.stubGlobal('fetch', fetchMock);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete vars.STRIPE_SECRET_KEY;
  delete vars.STRIPE_WEBHOOK_SECRET;
});

describe('startProviderTicketCheckout (Stripe)', () => {
  function fakeDb() {
    return {
      providerPrice: {findUnique: vi.fn(async () => PRICE), create: vi.fn()},
      ticketOrder: {count: vi.fn(async () => 0), create: vi.fn(async (_args: unknown) => ({}))},
      providerCheckout: {
        createMany: vi.fn(async (_args: unknown) => ({count: 1})),
        findUnique: vi.fn(async (args: {where: {id: string}}) => ({id: args.where.id, status: 'open', providerRef: null, step: null})),
        update: vi.fn(async () => ({})),
      },
    };
  }
  const input = {
    rsvp: {id: RSVP, seats: 2},
    ticket: {id: TICKET, name: 'General', priceCents: 1500, currency: 'USD'},
    eventTitle: 'Launch',
    baseKey: BASE_KEY,
    provider: 'stripe' as const,
    origin: 'https://events.example.com',
    successPath: '/thanks/',
    cancelPath: '/events/launch/',
  };

  it('charges the stored price x seats with the attempt as the idempotency key', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {id: 'cs_test_abcdef123456', url: 'https://checkout.stripe.com/c/pay/cs_test_abcdef123456', livemode: false}));
    const db = fakeDb();
    const out = await startProviderTicketCheckout(db as never, input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.checkoutId).toMatch(/^ppc_[0-9a-f]{32}$/);
    expect(out.redirectUrl).toBe(`/checkout/?id=${out.checkoutId}`);
    expect(out.embedded).toMatchObject({kind: 'window', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_abcdef123456'});

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(`checkout:${out.checkoutId}`);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('line_items[0][price]')).toBe('price_abcdef123');
    expect(body.get('line_items[0][quantity]')).toBe('2');
    expect(body.get('client_reference_id')).toBe(out.checkoutId);
    expect(body.get('success_url')).toContain(`/thanks/?checkout=${out.checkoutId}`);
    expect(body.get('cancel_url')).toBe('https://events.example.com/events/launch/');
    // No email or amount is sent: Stripe charges its own stored price.
    expect([...body.keys()].some(k => /amount|email/.test(k))).toBe(false);

    expect(db.providerCheckout.createMany.mock.calls[0]![0]).toMatchObject({data: [{id: out.checkoutId, rsvpId: RSVP, priceId: 4, amountMinor: 3000, currency: 'USD', seats: 2}], skipDuplicates: true});
    expect(db.ticketOrder.create.mock.calls[0]![0]).toMatchObject({data: {rsvpId: RSVP, checkoutId: out.checkoutId, amountCents: 3000, currency: 'USD', seats: 2, status: 'pending'}});
  });

  it('a racing start of the same attempt joins the open checkout without a second provider call', async () => {
    const db = fakeDb();
    const step = {kind: 'window', gateway: 'stripe', checkoutUrl: 'https://checkout.stripe.com/x', returnUrl: 'https://events.example.com/thanks/'};
    db.providerCheckout.findUnique.mockImplementationOnce(async (args: {where: {id: string}}) => ({id: args.where.id, status: 'open', providerRef: 'cs_test_abcdef123456', step}) as never);
    const out = await startProviderTicketCheckout(db as never, input);
    expect(out).toMatchObject({ok: true, reused: true, embedded: step});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the picked provider has no keys', async () => {
    delete vars.STRIPE_WEBHOOK_SECRET;
    const db = fakeDb();
    expect(await startProviderTicketCheckout(db as never, input)).toMatchObject({ok: false, status: 503, code: 'payments_unavailable'});
    expect(db.providerCheckout.createMany).not.toHaveBeenCalled();
  });
});

describe('syncProviderCheckout', () => {
  const row = {
    id: 'ppc_0123456789abcdef0123456789abcdef',
    rsvpId: RSVP,
    provider: 'stripe',
    mode: 'test',
    providerRef: 'cs_test_abcdef123456',
    providerPaymentId: null,
    seats: 2,
    amountMinor: 3000,
    currency: 'USD',
    status: 'open',
    step: null,
    createdAt: new Date(),
    price: {key: BASE_KEY, providerPriceId: 'price_abcdef123'},
  };
  const fakeDb = (over: Record<string, unknown> = {}) => ({
    providerCheckout: {findUnique: vi.fn(async () => ({...row, ...over})), updateMany: vi.fn(async () => ({count: 1}))},
    ticketOrder: {findUnique: vi.fn(async () => ({status: 'pending'}))},
  });
  const session = (over: Record<string, unknown> = {}) =>
    json(200, {
      id: 'cs_test_abcdef123456',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: row.id,
      mode: 'payment',
      payment_intent: 'pi_abcdef123456',
      amount_total: 3000,
      currency: 'usd',
      livemode: false,
      ...over,
    });

  it('a paid session confirms the ticket through the shared confirmPaidTicket', async () => {
    fetchMock.mockImplementation(async () => session());
    const db = fakeDb();
    const out = await syncProviderCheckout(db as never, row.id);
    expect(out?.status).toBe('paid');
    expect(db.providerCheckout.updateMany).toHaveBeenCalledWith({where: {id: row.id, status: {in: ['open', 'failed']}}, data: {status: 'paid', providerPaymentId: 'pi_abcdef123456'}});
    expect(hooks.confirmPaidTicket).toHaveBeenCalledTimes(1);
    expect((hooks.confirmPaidTicket.mock.calls[0] as unknown[])[1]).toMatchObject({id: row.id, status: 'paid', amountCents: 3000, currency: 'USD', metadata: {rsvpId: RSVP}});
  });

  it('passes what Stripe actually charged, so a different total is caught as a mismatch', async () => {
    fetchMock.mockImplementation(async () => session({amount_total: 100}));
    const db = fakeDb();
    await syncProviderCheckout(db as never, row.id);
    expect((hooks.confirmPaidTicket.mock.calls[0] as unknown[])[1]).toMatchObject({amountCents: 100, currency: 'USD'});
  });

  it('a late "paid" after the refund was recorded never reopens the ticket', async () => {
    fetchMock.mockImplementation(async () => session());
    const db = fakeDb({status: 'refunded'});
    expect((await syncProviderCheckout(db as never, row.id, {force: true}))?.status).toBe('refunded');
    expect(hooks.confirmPaidTicket).not.toHaveBeenCalled();
    expect(db.providerCheckout.updateMany).not.toHaveBeenCalled();
  });

  it('a session carrying another ref changes nothing (fails closed)', async () => {
    fetchMock.mockResolvedValueOnce(session({client_reference_id: 'ppc_ffffffffffffffffffffffffffffffff'}));
    const db = fakeDb();
    const out = await syncProviderCheckout(db as never, row.id);
    expect(out).toMatchObject({status: 'open', unavailable: true});
    expect(hooks.confirmPaidTicket).not.toHaveBeenCalled();
    expect(db.providerCheckout.updateMany).not.toHaveBeenCalled();
  });

  it('an expired session gives the held seats back once', async () => {
    fetchMock.mockResolvedValueOnce(session({status: 'expired', payment_status: 'unpaid'}));
    const db = fakeDb();
    expect((await syncProviderCheckout(db as never, row.id))?.status).toBe('failed');
    expect(holds.releaseHold).toHaveBeenCalledWith(db, RSVP);
  });

  it('a settled row is answered from the database without a provider call', async () => {
    const db = fakeDb({status: 'paid'});
    expect((await syncProviderCheckout(db as never, row.id))?.status).toBe('paid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Ezypay refunds: only a FULL refund closes the ticket', () => {
  const row = {
    id: 'ppc_0123456789abcdef0123456789abcdef',
    rsvpId: RSVP,
    provider: 'ezypay',
    mode: 'test',
    providerRef: 'pay_abcdef123456',
    providerPaymentId: null,
    seats: 2,
    amountMinor: 3000,
    currency: 'USD',
    status: 'open',
    step: null,
    createdAt: new Date(),
    price: {key: BASE_KEY, providerPriceId: 'price_ezy123456'},
  };
  const fakeDb = (over: Record<string, unknown> = {}) => ({
    providerCheckout: {findUnique: vi.fn(async () => ({...row, ...over})), updateMany: vi.fn(async () => ({count: 1}))},
    ticketOrder: {findUnique: vi.fn(async () => ({status: 'pending'}))},
  });
  // The kit and the raw read both GET /payments/{id}: one answer serves both.
  const payment = (status: string) => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      calls.push(url);
      return json(200, {
        data: {mode: 'test', payment: {id: 'pay_abcdef123456', status, metadata: {ref: row.id}, priceId: 'price_ezy123456', currency: 'USD', amountMinor: '3000'}},
      });
    });
    return calls;
  };
  beforeEach(() => {
    vars.EZYPAY_SECRET_KEY = 'sk_test_FAKEFAKEFAKE';
    vars.EZYPAY_PUBLISHABLE_KEY = 'pk_test_FAKEFAKEFAKE';
    vars.EZYPAY_WEBHOOK_SECRET = 'whsec_fakefakefakefake';
  });
  afterEach(() => {
    delete vars.EZYPAY_SECRET_KEY;
    delete vars.EZYPAY_PUBLISHABLE_KEY;
    delete vars.EZYPAY_WEBHOOK_SECRET;
  });

  it('a partial refund on a paid booking leaves the ticket confirmed', async () => {
    const calls = payment('partially_refunded');
    const db = fakeDb({status: 'paid'});
    expect((await syncProviderCheckout(db as never, row.id, {force: true}))?.status).toBe('paid');
    expect(calls.length).toBe(2); // the kit's read, then the raw status
    expect(hooks.refundedTicket).not.toHaveBeenCalled();
  });

  it('a first read that is already partially refunded still confirms the paying guest', async () => {
    payment('partially_refunded');
    const db = fakeDb();
    expect((await syncProviderCheckout(db as never, row.id))?.status).toBe('paid');
    expect(db.providerCheckout.updateMany).toHaveBeenCalledWith({where: {id: row.id, status: {in: ['open', 'failed']}}, data: {status: 'paid', providerPaymentId: 'pay_abcdef123456'}});
    expect(hooks.confirmPaidTicket).toHaveBeenCalledTimes(1);
    expect((hooks.confirmPaidTicket.mock.calls[0] as unknown[])[1]).toMatchObject({amountCents: 3000, currency: 'USD'});
  });

  it('a full refund closes the order and frees the seat', async () => {
    payment('refunded');
    const db = fakeDb({status: 'paid'});
    expect((await syncProviderCheckout(db as never, row.id, {force: true}))?.status).toBe('refunded');
    expect(hooks.refundedTicket).toHaveBeenCalledTimes(1);
    expect((hooks.refundedTicket.mock.calls[0] as unknown[])[1]).toMatchObject({checkoutId: row.id, full: true});
  });
});

describe('Stripe charge.refunded before "paid" was recorded', () => {
  const app = new Hono().route('/payment-webhooks', providerWebhooks);
  const ID = 'ppc_0123456789abcdef0123456789abcdef';
  const event = JSON.stringify({id: 'evt_refund123456', type: 'charge.refunded', livemode: false, data: {object: {id: 'ch_abcdef123456'}}});
  const post = async () =>
    app.request('/payment-webhooks/stripe', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'stripe-signature': await signTimestamped(event, vars.STRIPE_WEBHOOK_SECRET!)},
      body: event,
    });
  const charge = () => json(200, {id: 'ch_abcdef123456', payment_intent: 'pi_abcdef123456', refunded: true, livemode: false});

  it('finds the checkout through the PaymentIntent ref and closes it', async () => {
    resetWebhookLimitForTests();
    fetchMock.mockImplementation(async (url: string) => (url.includes('/charges/') ? charge() : json(200, {id: 'pi_abcdef123456', metadata: {ref: ID}, livemode: false})));
    const findFirst = vi.fn(async (args: {where: Record<string, unknown>}) => (args.where.id === ID ? {id: ID, amountMinor: 3000, currency: 'USD'} : null));
    const db = {
      providerEvent: {createMany: vi.fn(async () => ({count: 1})), deleteMany: vi.fn(async () => ({count: 1}))},
      providerCheckout: {findFirst, findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({count: 1}))},
    };
    store.db = db;
    expect((await post()).status).toBe(200);
    expect(findFirst).toHaveBeenCalledTimes(2); // by payment id (none yet), then by the ref
    expect(db.providerCheckout.updateMany).toHaveBeenCalledWith({where: {id: ID, providerPaymentId: null}, data: {providerPaymentId: 'pi_abcdef123456'}});
    expect(hooks.refundedTicket).toHaveBeenCalledTimes(1);
    expect((hooks.refundedTicket.mock.calls[0] as unknown[])[1]).toMatchObject({checkoutId: ID, full: true});
    expect(db.providerEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('asks Stripe to send it again when the PaymentIntent cannot be read', async () => {
    resetWebhookLimitForTests();
    fetchMock.mockImplementation(async (url: string) => (url.includes('/charges/') ? charge() : json(500, {})));
    const db = {
      providerEvent: {createMany: vi.fn(async () => ({count: 1})), deleteMany: vi.fn(async () => ({count: 1}))},
      providerCheckout: {findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null), updateMany: vi.fn()},
    };
    store.db = db;
    expect((await post()).status).toBe(500);
    expect(db.providerEvent.deleteMany).toHaveBeenCalled();
    expect(hooks.refundedTicket).not.toHaveBeenCalled();
  });
});
