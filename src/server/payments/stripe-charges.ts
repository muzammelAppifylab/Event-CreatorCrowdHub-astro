import {cleanCurrency, fail, isStripeId, type ProviderResult, QUICK_TIMEOUT_MS, secretValue, stripeMode} from '../../platform/payment-providers';

/**
 * The Stripe reads the kit doesn't have (docs/agent/payments-providers.md "never trust the event
 * body: re-read"): a Charge (refund webhooks), a Checkout Session's real total (so
 * confirmPaidTicket's amount check runs on what Stripe charged), and a PaymentIntent's `ref` (a
 * refund that arrives before "paid" was recorded). Same rules as the kit's own calls:
 * STRIPE_SECRET_KEY read per call through `secretValue` (`config.ownerSecret`), sent only to
 * api.stripe.com, a short timeout, the answer's `livemode` must be the keys' mode, and nothing of
 * the key, the request or Stripe's error text in the answer or the log. Server only.
 */

async function stripeGet(path: string, label: string): Promise<ProviderResult<Record<string, unknown>>> {
  const key = secretValue('STRIPE_SECRET_KEY');
  const mode = stripeMode();
  if (!key || !mode) return fail(0, 'not_configured');
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1${path}`, {headers: {authorization: `Bearer ${key}`}, signal: AbortSignal.timeout(QUICK_TIMEOUT_MS)});
  } catch {
    console.error(`[stripe-reads] GET ${label}: unreachable`);
    return fail(0, 'unreachable');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body !== 'object' || Array.isArray(body)) {
    console.error(`[stripe-reads] GET ${label}: ${res.status}`);
    return fail(res.status || 502, 'error');
  }
  if (typeof body.livemode === 'boolean' && body.livemode !== (mode === 'live')) return fail(502, 'mode_mismatch');
  return {ok: true, data: body};
}

const refOf = (v: unknown): string | null => {
  const ref = v && typeof v === 'object' ? (v as Record<string, unknown>).ref : null;
  return typeof ref === 'string' && ref ? ref : null;
};

export interface StripeChargeState {
  chargeId: string;
  paymentIntentId: string | null;
  /** The whole charge was refunded. */
  refunded: boolean;
}

export async function getStripeCharge(chargeId: string): Promise<ProviderResult<StripeChargeState>> {
  if (!isStripeId(chargeId, 'ch') && !isStripeId(chargeId, 'py')) return fail(422, 'invalid_input');
  const res = await stripeGet(`/charges/${encodeURIComponent(chargeId)}`, '/charges/ch_…');
  if (!res.ok) return res;
  const body = res.data;
  if (body.id !== chargeId) return fail(502, 'bad_response');
  const pi = typeof body.payment_intent === 'string' && isStripeId(body.payment_intent, 'pi') ? body.payment_intent : null;
  return {ok: true, data: {chargeId, paymentIntentId: pi, refunded: body.refunded === true}};
}

/** What a Checkout Session actually charged (minor units, upper-case currency). */
export async function getStripeSessionTotal(sessionId: string): Promise<ProviderResult<{amountMinor: number; currency: string; ref: string | null}>> {
  if (!isStripeId(sessionId, 'cs')) return fail(422, 'invalid_input');
  const res = await stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`, '/checkout/sessions/cs_…');
  if (!res.ok) return res;
  const d = res.data;
  const currency = cleanCurrency(d.currency);
  if (d.id !== sessionId || !Number.isInteger(d.amount_total) || !currency) return fail(502, 'bad_response');
  const ref = typeof d.client_reference_id === 'string' && d.client_reference_id ? d.client_reference_id : refOf(d.metadata);
  return {ok: true, data: {amountMinor: d.amount_total as number, currency, ref}};
}

/** The `ref` the kit put on a PaymentIntent (`payment_intent_data[metadata][ref]`). */
export async function getStripePaymentIntentRef(paymentIntentId: string): Promise<ProviderResult<{ref: string | null}>> {
  if (!isStripeId(paymentIntentId, 'pi')) return fail(422, 'invalid_input');
  const res = await stripeGet(`/payment_intents/${encodeURIComponent(paymentIntentId)}`, '/payment_intents/pi_…');
  if (!res.ok) return res;
  if (res.data.id !== paymentIntentId) return fail(502, 'bad_response');
  return {ok: true, data: {ref: refOf(res.data.metadata)}};
}
