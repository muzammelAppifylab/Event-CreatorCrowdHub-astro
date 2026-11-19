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

import {syncProviderCheckout} from '../src/server/payments/provider-confirm';
import {startProviderTicketCheckout} from '../src/server/payments/provider-tickets';

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
    json(200, {id: 'cs_test_abcdef123456', status: 'complete', payment_status: 'paid', client_reference_id: row.id, mode: 'payment', payment_intent: 'pi_abcdef123456', livemode: false, ...over});

  it('a paid session confirms the ticket through the shared confirmPaidTicket', async () => {
    fetchMock.mockResolvedValueOnce(session());
    const db = fakeDb();
    const out = await syncProviderCheckout(db as never, row.id);
    expect(out?.status).toBe('paid');
    expect(db.providerCheckout.updateMany).toHaveBeenCalledWith({where: {id: row.id, status: {in: ['open', 'failed']}}, data: {status: 'paid', providerPaymentId: 'pi_abcdef123456'}});
    expect(hooks.confirmPaidTicket).toHaveBeenCalledTimes(1);
    expect((hooks.confirmPaidTicket.mock.calls[0] as unknown[])[1]).toMatchObject({id: row.id, status: 'paid', amountCents: 3000, currency: 'USD', metadata: {rsvpId: RSVP}});
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
