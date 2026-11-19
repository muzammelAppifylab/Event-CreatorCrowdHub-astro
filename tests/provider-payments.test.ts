import {env} from 'cloudflare:workers';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {resetWebhookLimitForTests, signTimestamped} from '../src/platform/payment-providers';

/**
 * The owner's own payment provider for tickets (docs/agent/payments-providers.md): price selection
 * and idempotency keys, the webhook route's gate, and the admin's provider pick (a not-ready
 * provider refused, the read-only demo viewer refused). Every provider call is a mocked `fetch`.
 */

const access = vi.hoisted(() => ({
  viewer: {state: 'user', id: 7, email: '', emailVerified: true, name: 'Admin'} as Record<string, unknown>,
  permissions: ['*'] as string[],
}));
const store = vi.hoisted(() => ({db: null as unknown}));

vi.mock('../src/platform/auth/session', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/auth/session')>('../src/platform/auth/session');
  return {
    ...actual,
    getViewer: async () => access.viewer,
    getAccess: async () => ({roles: [], permissions: access.permissions}),
  };
});
vi.mock('../src/platform/auth', () => ({audit: vi.fn(async () => undefined)}));
vi.mock('../src/platform/db', () => ({getDb: () => store.db}));

import {
  checkoutIdempotencyKey,
  ensureProviderPrice,
  priceIdempotencyKey,
  providerCheckoutId,
  providerPriceSpec,
} from '../src/server/payments/provider-tickets';
import {fromDecimal, paypalOrderState} from '../src/server/payments/paypal-orders';
import {providerAdminRoutes} from '../src/server/routes/provider-admin';
import {providerWebhooks} from '../src/server/routes/provider-webhooks';

const vars = env as Record<string, string | undefined>;
const NAMES = [
  'EZYPAY_SECRET_KEY',
  'EZYPAY_PUBLISHABLE_KEY',
  'EZYPAY_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'PAYPAL_MODE',
  'SITE_PREVIEW',
];
// Obviously fake values in the shapes the kit checks (never real keys).
const STRIPE_TEST = 'sk_test_FAKEFAKEFAKE';
const WHSEC = 'whsec_fakefakefakefake';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const n of NAMES) delete vars[n];
  fetchMock = vi.fn(async () => json(500, {error: {code: 'unexpected'}}));
  vi.stubGlobal('fetch', fetchMock);
  resetWebhookLimitForTests();
  access.permissions = ['*'];
  store.db = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const n of NAMES) delete vars[n];
});

const BASE_KEY = 'tkt-0190aaaabbbb7ccc8ddd0000-1500-usd';
const RSVP = '0190aaaa-bbbb-7ccc-8ddd-000000000001';

describe('which stored price sells a ticket', () => {
  it('Stripe and PayPal: one price per ticket amount, the seats as the quantity', () => {
    for (const p of ['stripe', 'paypal'] as const) {
      expect(providerPriceSpec(p, BASE_KEY, 1500, 'usd', 3)).toEqual({key: BASE_KEY, unitMinor: 1500, quantity: 3, totalMinor: 4500, currency: 'USD'});
    }
  });
  it('Ezypay (no quantity): the whole order is the price, keyed by the seat count', () => {
    expect(providerPriceSpec('ezypay', BASE_KEY, 1500, 'USD', 3)).toEqual({key: `${BASE_KEY}-x3`, unitMinor: 4500, quantity: 1, totalMinor: 4500, currency: 'USD'});
    expect(providerPriceSpec('ezypay', BASE_KEY, 1500, 'USD', 1)).toEqual({key: BASE_KEY, unitMinor: 1500, quantity: 1, totalMinor: 1500, currency: 'USD'});
    expect(`${BASE_KEY}-x99`.length).toBeLessThanOrEqual(64);
  });
});

describe('idempotency keys', () => {
  const base = {rsvpId: RSVP, attempt: 0, provider: 'stripe' as const, mode: 'test' as const, priceKey: BASE_KEY, seats: 2};
  it('the same attempt is the same checkout id (and so the same provider checkout)', async () => {
    const a = await providerCheckoutId(base);
    expect(a).toMatch(/^ppc_[0-9a-f]{32}$/);
    expect(await providerCheckoutId({...base})).toBe(a);
    expect(checkoutIdempotencyKey(a)).toBe(`checkout:${a}`);
  });
  it('a new attempt, provider, mode, price or seat count is a new one', async () => {
    const a = await providerCheckoutId(base);
    const others = await Promise.all([
      providerCheckoutId({...base, attempt: 1}),
      providerCheckoutId({...base, provider: 'paypal'}),
      providerCheckoutId({...base, mode: 'live'}),
      providerCheckoutId({...base, priceKey: `${BASE_KEY}x`}),
      providerCheckoutId({...base, seats: 3}),
    ]);
    expect(new Set([a, ...others]).size).toBe(6);
  });
  it('a price is made once per provider, mode and key', () => {
    expect(priceIdempotencyKey('stripe', 'test', BASE_KEY)).toBe(`price:stripe:test:${BASE_KEY}`);
  });
});

describe('ensureProviderPrice', () => {
  const spec = providerPriceSpec('stripe', BASE_KEY, 1500, 'USD', 2);
  const row = {id: 4, key: BASE_KEY, provider: 'stripe', mode: 'test', providerPriceId: 'price_abcdef123', amountMinor: 1500, currency: 'USD', interval: 'one_time', archivedAt: null};

  it('makes the Stripe price from the STORED amount, with the price idempotency key, then stores it', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    fetchMock.mockResolvedValueOnce(json(200, {id: 'price_abcdef123', product: 'prod_abcdef123', unit_amount: 1500, recurring: null, livemode: false}));
    const create = vi.fn(async (_args: {data: Record<string, unknown>}) => row);
    const db = {providerPrice: {findUnique: vi.fn(async () => null), create}};
    const out = await ensureProviderPrice(db as never, {provider: 'stripe', mode: 'test', spec, name: 'Launch - General', ticketTypeId: RSVP});
    expect(out).toEqual({ok: true, price: row});
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/prices');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(`price:stripe:test:${BASE_KEY}`);
    expect(String(init.body)).toContain('unit_amount=1500');
    expect(create.mock.calls[0]![0]).toMatchObject({data: {key: BASE_KEY, provider: 'stripe', mode: 'test', amountMinor: 1500, currency: 'USD'}});
  });

  it('reuses a stored price without calling the provider', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    const db = {providerPrice: {findUnique: vi.fn(async () => row), create: vi.fn()}};
    expect(await ensureProviderPrice(db as never, {provider: 'stripe', mode: 'test', spec, name: 'x', ticketTypeId: RSVP})).toEqual({ok: true, price: row});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a stored row whose amount is not the ticket price (never mis-charges)', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    const db = {providerPrice: {findUnique: vi.fn(async () => ({...row, amountMinor: 999})), create: vi.fn()}};
    const out = await ensureProviderPrice(db as never, {provider: 'stripe', mode: 'test', spec, name: 'x', ticketTypeId: RSVP});
    expect(out).toMatchObject({ok: false, status: 409, code: 'ticket_price_mismatch'});
  });

  it('PayPal orders: the row fixes the amount, nothing is made at PayPal', async () => {
    vars.PAYPAL_CLIENT_ID = 'fake-client';
    vars.PAYPAL_CLIENT_SECRET = 'fake-secret';
    const create = vi.fn(async (args: {data: Record<string, unknown>}) => ({...row, ...args.data, id: 5}));
    const db = {providerPrice: {findUnique: vi.fn(async () => null), create}};
    const out = await ensureProviderPrice(db as never, {provider: 'paypal', mode: 'test', spec: providerPriceSpec('paypal', BASE_KEY, 1500, 'USD', 1), name: 'x', ticketTypeId: RSVP});
    expect(out.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(create.mock.calls[0]![0].data).toMatchObject({providerPriceId: `order:${BASE_KEY}`, amountMinor: 1500});
  });
});

describe('PayPal order amounts', () => {
  it('reads decimals exactly, never as floats', () => {
    expect(fromDecimal('14.00', 'USD')).toBe(1400);
    expect(fromDecimal('0.10', 'USD')).toBe(10);
    expect(fromDecimal('1400', 'JPY')).toBe(1400);
    expect(fromDecimal('14.005', 'USD')).toBeNull();
    expect(fromDecimal('abc', 'USD')).toBeNull();
  });
  it('is paid only when the capture COMPLETED, with our ref', () => {
    const order = (status: string, capture: string) => ({
      id: 'ORDER12345678',
      status,
      purchase_units: [{custom_id: 'ppc_x', payments: {captures: [{id: 'CAP12345678', status: capture, amount: {currency_code: 'USD', value: '30.00'}}]}}],
    });
    expect(paypalOrderState(order('COMPLETED', 'COMPLETED'))).toMatchObject({status: 'paid', ref: 'ppc_x', captureId: 'CAP12345678', amountMinor: 3000, currency: 'USD'});
    expect(paypalOrderState(order('COMPLETED', 'PENDING'))!.status).toBe('open');
    expect(paypalOrderState(order('APPROVED', 'x'))!.status).toBe('approved');
    expect(paypalOrderState(order('VOIDED', 'x'))!.status).toBe('failed');
    expect(paypalOrderState({id: 'bad id'})).toBeNull();
  });
});

describe('POST /payment-webhooks/*', () => {
  const app = new Hono().route('/payment-webhooks', providerWebhooks);
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    app.request(`/payment-webhooks${path}`, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body});
  const event = JSON.stringify({id: 'evt_abcdef123456', type: 'checkout.session.completed', livemode: false, data: {object: {id: 'cs_test_abcdef123456'}}});

  function fakeDb() {
    const db = {
      providerEvent: {createMany: vi.fn(async () => ({count: 1})), deleteMany: vi.fn(async () => ({count: 1}))},
      providerCheckout: {findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null)},
    };
    store.db = db;
    return db;
  }

  it('answers 404 for a provider it does not know', async () => {
    const res = await post('/square', event);
    expect(res.status).toBe(404);
  });

  it('refuses a bad Stripe signature with 400 and changes nothing', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    vars.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = fakeDb();
    const forged = await signTimestamped(event, 'whsec_not_the_owners_secret');
    expect((await post('/stripe', event, {'stripe-signature': forged})).status).toBe(400);
    expect((await post('/stripe', event)).status).toBe(400);
    expect(db.providerEvent.createMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a stale (replayed) Stripe signature', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    vars.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = fakeDb();
    const old = await signTimestamped(event, WHSEC, Math.floor(Date.now() / 1000) - 10 * 60);
    expect((await post('/stripe', event, {'stripe-signature': old})).status).toBe(400);
    expect(db.providerEvent.createMany).not.toHaveBeenCalled();
  });

  it('takes a good Stripe signature once per event id', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    vars.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = fakeDb();
    const res = await post('/stripe', event, {'stripe-signature': await signTimestamped(event, WHSEC)});
    expect(res.status).toBe(200);
    expect(db.providerEvent.createMany).toHaveBeenCalledWith({data: [{provider: 'stripe', eventId: 'evt_abcdef123456'}], skipDuplicates: true});
    // Not one of this site's checkouts: acknowledged, nothing re-read.
    expect(db.providerCheckout.findUnique).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    db.providerEvent.createMany.mockResolvedValueOnce({count: 0});
    db.providerCheckout.findUnique.mockClear();
    expect((await post('/stripe', event, {'stripe-signature': await signTimestamped(event, WHSEC)})).status).toBe(200);
    expect(db.providerCheckout.findUnique).not.toHaveBeenCalled();
  });

  it('ignores the other mode’s events (a live event on a sandbox copy)', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    vars.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = fakeDb();
    const live = JSON.stringify({id: 'evt_abcdef123456', type: 'checkout.session.completed', livemode: true, data: {object: {id: 'cs_live_abcdef123456'}}});
    expect((await post('/stripe', live, {'stripe-signature': await signTimestamped(live, WHSEC)})).status).toBe(200);
    expect(db.providerEvent.createMany).not.toHaveBeenCalled();
  });

  it('drops a stale PayPal transmission before asking PayPal', async () => {
    vars.PAYPAL_CLIENT_ID = 'fake-client';
    vars.PAYPAL_CLIENT_SECRET = 'fake-secret';
    vars.PAYPAL_WEBHOOK_ID = 'WH-FAKE';
    const db = fakeDb();
    const body = JSON.stringify({id: 'WH-ABCDEF123456', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {id: 'CAP12345678'}});
    const res = await post('/paypal', body, {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/cert.pem',
      'paypal-transmission-id': 'abc',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.providerEvent.createMany).not.toHaveBeenCalled();
  });

  it('refuses an Ezypay post with a bad signature', async () => {
    vars.EZYPAY_SECRET_KEY = 'sk_test_FAKEFAKEFAKE';
    vars.EZYPAY_PUBLISHABLE_KEY = 'pk_test_FAKEFAKEFAKE';
    vars.EZYPAY_WEBHOOK_SECRET = WHSEC;
    const db = fakeDb();
    const body = JSON.stringify({id: 'evt_abcdef123456', type: 'payment.succeeded'});
    expect((await post('/ezypay', body, {'ezy-signature': await signTimestamped(body, 'whsec_wrong_wrong')})).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.providerEvent.createMany).not.toHaveBeenCalled();
  });
});

describe('/payment-settings', () => {
  const app = new Hono().route('/payment-settings', providerAdminRoutes);
  const put = (provider: unknown) =>
    app.request('/payment-settings', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({provider})});
  function fakeDb() {
    const db = {providerSettings: {findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({id: 1}))}};
    store.db = db;
    return db;
  }

  it('shows the read-only demo viewer the choice (booleans only, never a value)', async () => {
    access.permissions = ['site:payments:read'];
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    fakeDb();
    const res = await app.request('/payment-settings');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(STRIPE_TEST);
    const body = JSON.parse(text) as {provider: null; providers: {provider: string; secrets: {name: string; set: boolean}[]; webhookUrl: string}[]};
    expect(body.provider).toBeNull();
    expect(body.providers.map(p => p.provider)).toEqual(['ezypay', 'stripe', 'paypal']);
    const stripe = body.providers.find(p => p.provider === 'stripe')!;
    expect(stripe.secrets).toEqual([
      {name: 'STRIPE_SECRET_KEY', set: true},
      {name: 'STRIPE_WEBHOOK_SECRET', set: false},
    ]);
    expect(stripe.webhookUrl).toMatch(/\/site-api\/payment-webhooks\/stripe$/);
  });

  it('refuses the read-only demo viewer a save (403) and changes nothing', async () => {
    access.permissions = ['site:payments:read'];
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    vars.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = fakeDb();
    expect((await put('stripe')).status).toBe(403);
    expect((await put(null)).status).toBe(403);
    expect(db.providerSettings.upsert).not.toHaveBeenCalled();
  });

  it('refuses a viewer with neither permission even the read', async () => {
    access.permissions = ['site:event:manage'];
    fakeDb();
    expect((await app.request('/payment-settings')).status).toBe(403);
  });

  it('refuses a provider whose keys are not all set, naming the missing secrets', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    const db = fakeDb();
    const res = await put('stripe');
    expect(res.status).toBe(409);
    expect(((await res.json()) as {message: string}).message).toContain('STRIPE_WEBHOOK_SECRET');
    expect(db.providerSettings.upsert).not.toHaveBeenCalled();
  });

  it('saves a ready provider, and null (back to built-in payments)', async () => {
    vars.STRIPE_SECRET_KEY = STRIPE_TEST;
    vars.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = fakeDb();
    expect((await put('stripe')).status).toBe(200);
    expect(db.providerSettings.upsert).toHaveBeenLastCalledWith({where: {id: 1}, create: {id: 1, provider: 'stripe'}, update: {provider: 'stripe'}});
    expect((await put(null)).status).toBe(200);
    expect(db.providerSettings.upsert).toHaveBeenLastCalledWith({where: {id: 1}, create: {id: 1, provider: null}, update: {provider: null}});
  });

  it('refuses a provider it does not know (422)', async () => {
    fakeDb();
    expect((await put('square')).status).toBe(422);
  });
});
