import {
  type CheckoutStep,
  cleanCurrency,
  decimalsOf,
  fail,
  isReturnUrl,
  paypalMode,
  type ProviderResult,
  QUICK_TIMEOUT_MS,
  secretValue,
  TIMEOUT_MS,
  toDecimal,
} from '../../platform/payment-providers';

/**
 * One-time PayPal sales with the OWNER's own PayPal account, through PayPal's Orders v2 API
 * (docs/agent/payments-providers.md: the kit's `paypal.ts` is subscriptions only; "a one-time
 * PayPal sale goes through … the Orders API in your own code, with the amount from your stored row").
 *
 * Same rules as the kit: the keys are the kit's secret names (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET),
 * read per call through `secretValue` (`config.ownerSecret`) and sent only to PayPal's API host for
 * the mode `paypalMode()` gives (PAYPAL_MODE=live → api-m.paypal.com, else the sandbox); every call has
 * a timeout; an answer never carries a key, the request or PayPal's error text (only the HTTP status
 * and PayPal's short error name); anything unexpected fails closed (never "paid"). Server only.
 *
 *   createPaypalOrder()    an order for a STORED amount x quantity, and the buyer's approval page
 *   getPaypalOrder()       the order as PayPal has it now (thanks page, webhooks)
 *   capturePaypalOrder()   take the approved money (once: PayPal-Request-Id `capture:<checkout id>`)
 *   getPaypalCapture()     a capture (refund webhooks point at it)
 *
 * Webhooks are verified with the kit's `verifyPaypalWebhook` (PayPal's own check on the raw body).
 */

const HOSTS = {test: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com'} as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** OAuth tokens per isolate, until a minute before they run out. Never logged or returned. */
const tokens = new Map<string, {token: string; until: number}>();
export const resetPaypalOrderTokensForTests = () => tokens.clear();

async function call<T extends Record<string, unknown>>(url: string, init: RequestInit, label: string, timeoutMs: number): Promise<ProviderResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
  } catch {
    console.error(`[paypal-orders] ${label}: unreachable`);
    return fail(0, 'unreachable');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = (str(body?.name) ?? str(body?.error) ?? 'error').slice(0, 60);
    const issue = str(rec((body?.details as unknown[] | undefined)?.[0])?.issue);
    console.error(`[paypal-orders] ${label}: ${res.status} ${code}${issue ? ` ${issue.slice(0, 60)}` : ''}`);
    return fail(res.status, issue ?? code);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res.status, 'bad_response');
  return {ok: true, data: body as T};
}

async function token(): Promise<{host: string; token: string} | null> {
  const mode = paypalMode();
  const id = secretValue('PAYPAL_CLIENT_ID');
  const secret = secretValue('PAYPAL_CLIENT_SECRET');
  if (!mode || !id || !secret) return null;
  const host = HOSTS[mode];
  const key = `${mode}:${id}`;
  const cached = tokens.get(key);
  if (cached && cached.until > Date.now()) return {host, token: cached.token};
  const res = await call<{access_token?: unknown; expires_in?: unknown}>(
    `${host}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {authorization: `Basic ${btoa(`${id}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded'},
      body: 'grant_type=client_credentials',
    },
    'token',
    QUICK_TIMEOUT_MS,
  );
  const access = res.ok ? str(res.data.access_token) : null;
  if (!access) return null;
  const seconds = res.ok && typeof res.data.expires_in === 'number' ? res.data.expires_in : 300;
  tokens.set(key, {token: access, until: Date.now() + Math.max(0, seconds - 60) * 1000});
  return {host, token: access};
}

async function paypal<T extends Record<string, unknown>>(
  method: 'GET' | 'POST',
  path: string,
  {body, requestId, timeoutMs = TIMEOUT_MS}: {body?: unknown; requestId?: string; timeoutMs?: number} = {},
): Promise<ProviderResult<T>> {
  const auth = await token();
  if (!auth) return fail(0, 'not_configured');
  const headers: Record<string, string> = {authorization: `Bearer ${auth.token}`, accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // PayPal's idempotency key: the same id again returns the first answer, never a second order or capture.
  if (requestId) headers['paypal-request-id'] = requestId.slice(0, 108);
  const label = `${method} ${path.replace(/\/[A-Z0-9]{8,}/g, '/…')}`;
  return call<T>(`${auth.host}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)}, label, timeoutMs);
}

/** A PayPal order or capture id. */
export const isPaypalOrderId = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9]{8,64}$/.test(v);

/** "14.00" → 1400 (minor units for the currency), or null when it isn't an exact amount. */
export function fromDecimal(value: unknown, currency: string): number | null {
  if (typeof value !== 'string') return null;
  const decimals = decimalsOf(currency);
  const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) return null;
  return Number(m[1]) * 10 ** decimals + Number((fraction.slice(0, decimals) || '').padEnd(decimals, '0') || '0');
}

export interface PaypalOrderInput {
  /** From the site's STORED price row: never from the browser. */
  unitMinor: number;
  quantity: number;
  currency: string;
  /** What the buyer sees on PayPal's page (no email, no personal data). */
  name: string;
  /** Your checkout row id: carried as `custom_id` and `reference_id`, checked on every read. */
  ref: string;
  returnUrl: string;
  cancelUrl: string;
  /** `checkout:<ref>`: the same attempt again is the same order. */
  idempotencyKey: string;
}

/** An order to approve on PayPal's page (a payment window): `step` opens with `openCheckout()`. */
export async function createPaypalOrder(input: PaypalOrderInput): Promise<ProviderResult<{orderId: string; step: CheckoutStep}>> {
  const currency = cleanCurrency(input.currency);
  if (!currency || !Number.isInteger(input.unitMinor) || input.unitMinor <= 0 || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
    return fail(422, 'invalid_input');
  }
  if (!input.ref || input.ref.length > 120 || !input.idempotencyKey || !isReturnUrl(input.returnUrl) || !isReturnUrl(input.cancelUrl)) return fail(422, 'invalid_input');
  const unit = toDecimal(input.unitMinor, currency);
  const total = toDecimal(input.unitMinor * input.quantity, currency);
  const name = input.name.trim().slice(0, 127) || 'Ticket';
  const res = await paypal<{id?: unknown; status?: unknown; links?: unknown}>('POST', '/v2/checkout/orders', {
    requestId: input.idempotencyKey,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: input.ref,
          custom_id: input.ref,
          description: name,
          amount: {currency_code: currency, value: total, breakdown: {item_total: {currency_code: currency, value: total}}},
          items: [{name, quantity: String(input.quantity), unit_amount: {currency_code: currency, value: unit}, category: 'DIGITAL_GOODS'}],
        },
      ],
      payment_source: {
        paypal: {experience_context: {return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING'}},
      },
    },
  });
  if (!res.ok) return res;
  const links = Array.isArray(res.data.links) ? (res.data.links as unknown[]).map(rec) : [];
  const approve = links.find(l => l?.rel === 'payer-action' || l?.rel === 'approve');
  const href = str(approve?.href);
  if (!isPaypalOrderId(res.data.id) || !href) return fail(502, 'bad_response');
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return fail(502, 'bad_response');
  }
  // The buyer is only ever sent to PayPal's own page.
  if (url.protocol !== 'https:' || !/(^|\.)paypal\.com$/.test(url.hostname)) return fail(502, 'bad_response');
  return {
    ok: true,
    data: {orderId: res.data.id, step: {kind: 'window', gateway: 'paypal', checkoutUrl: url.toString(), returnUrl: input.returnUrl, cancelUrl: input.cancelUrl}},
  };
}

export interface PaypalOrderState {
  orderId: string;
  /** `paid` only when PayPal says the capture COMPLETED; `approved` = the buyer approved, not captured yet. */
  status: 'open' | 'approved' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
  ref: string | null;
  captureId: string | null;
  /** What PayPal captured (minor units), when it did. */
  amountMinor: number | null;
  currency: string | null;
}

const CAPTURE_STATUS: Record<string, PaypalOrderState['status']> = {
  COMPLETED: 'paid',
  PENDING: 'open',
  DECLINED: 'failed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
};

/** An order answer → its state. Exported for tests. */
export function paypalOrderState(order: Record<string, unknown>): PaypalOrderState | null {
  if (!isPaypalOrderId(order.id)) return null;
  const unit = rec((order.purchase_units as unknown[] | undefined)?.[0]);
  const capture = rec((rec(unit?.payments)?.captures as unknown[] | undefined)?.[0]);
  const amount = rec(capture?.amount);
  const currency = cleanCurrency(amount?.currency_code);
  const ref = str(unit?.custom_id) ?? str(capture?.custom_id) ?? str(unit?.reference_id);
  let status: PaypalOrderState['status'];
  switch (order.status) {
    case 'COMPLETED':
      status = CAPTURE_STATUS[String(capture?.status)] ?? 'open';
      break;
    case 'APPROVED':
      status = 'approved';
      break;
    case 'VOIDED':
      status = 'failed';
      break;
    default:
      status = 'open';
  }
  return {
    orderId: order.id,
    status,
    ref,
    captureId: isPaypalOrderId(capture?.id) ? capture.id : null,
    amountMinor: currency ? fromDecimal(amount?.value, currency) : null,
    currency,
  };
}

/** The order as PayPal has it now. */
export async function getPaypalOrder(orderId: string): Promise<ProviderResult<PaypalOrderState>> {
  if (!isPaypalOrderId(orderId)) return fail(422, 'invalid_input');
  const res = await paypal<Record<string, unknown>>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, {timeoutMs: QUICK_TIMEOUT_MS});
  if (!res.ok) return res;
  const state = paypalOrderState(res.data);
  return state ? {ok: true, data: state} : fail(502, 'bad_response');
}

/**
 * Takes the money of an APPROVED order. `requestId` (`capture:<checkout id>`) makes a second call
 * (the webhook and the thanks page at once, a retry) return the first capture, never a second one.
 * An order already captured answers PayPal's ORDER_ALREADY_CAPTURED: read it again instead.
 */
export async function capturePaypalOrder(orderId: string, requestId: string): Promise<ProviderResult<PaypalOrderState>> {
  if (!isPaypalOrderId(orderId) || !requestId) return fail(422, 'invalid_input');
  const res = await paypal<Record<string, unknown>>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {body: {}, requestId});
  if (!res.ok) return res.code === 'ORDER_ALREADY_CAPTURED' ? getPaypalOrder(orderId) : res;
  const state = paypalOrderState(res.data);
  return state ? {ok: true, data: state} : fail(502, 'bad_response');
}

export interface PaypalCaptureState {
  captureId: string;
  status: PaypalOrderState['status'];
  orderId: string | null;
  ref: string | null;
}

/** A capture as PayPal has it now (refund webhooks: is it fully refunded?). */
export async function getPaypalCapture(captureId: string): Promise<ProviderResult<PaypalCaptureState>> {
  if (!isPaypalOrderId(captureId)) return fail(422, 'invalid_input');
  const res = await paypal<Record<string, unknown>>('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, {timeoutMs: QUICK_TIMEOUT_MS});
  if (!res.ok) return res;
  const d = res.data;
  if (d.id !== captureId) return fail(502, 'bad_response');
  const orderId = str(rec(rec(d.supplementary_data)?.related_ids)?.order_id);
  return {
    ok: true,
    data: {captureId, status: CAPTURE_STATUS[String(d.status)] ?? 'open', orderId: isPaypalOrderId(orderId) ? orderId : null, ref: str(d.custom_id)},
  };
}
