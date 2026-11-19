import {fail, isStripeId, type ProviderResult, QUICK_TIMEOUT_MS, secretValue, stripeMode} from '../../platform/payment-providers';

/**
 * The one Stripe read the kit doesn't have: a Charge, for the `charge.refunded` webhook
 * (docs/agent/payments-providers.md "never trust the event body: re-read"). Same rules as the
 * kit's own calls: STRIPE_SECRET_KEY read per call through `secretValue` (`config.ownerSecret`),
 * sent only to api.stripe.com, a short timeout, the answer's `livemode` must be the keys' mode, and
 * nothing of the key, the request or Stripe's error text in the answer or the log. Server only.
 */
export interface StripeChargeState {
  chargeId: string;
  paymentIntentId: string | null;
  /** The whole charge was refunded. */
  refunded: boolean;
}

export async function getStripeCharge(chargeId: string): Promise<ProviderResult<StripeChargeState>> {
  if (!isStripeId(chargeId, 'ch') && !isStripeId(chargeId, 'py')) return fail(422, 'invalid_input');
  const key = secretValue('STRIPE_SECRET_KEY');
  const mode = stripeMode();
  if (!key || !mode) return fail(0, 'not_configured');
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`, {
      headers: {authorization: `Bearer ${key}`},
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
  } catch {
    console.error('[stripe-charges] GET /charges/ch_…: unreachable');
    return fail(0, 'unreachable');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    console.error(`[stripe-charges] GET /charges/ch_…: ${res.status}`);
    return fail(res.status || 502, 'error');
  }
  if (body.id !== chargeId) return fail(502, 'bad_response');
  if (typeof body.livemode === 'boolean' && body.livemode !== (mode === 'live')) return fail(502, 'mode_mismatch');
  const pi = typeof body.payment_intent === 'string' && isStripeId(body.payment_intent, 'pi') ? body.payment_intent : null;
  return {ok: true, data: {chargeId, paymentIntentId: pi, refunded: body.refunded === true}};
}
