import {ezypayMode, fail, isEzypayId, type ProviderResult, QUICK_TIMEOUT_MS, secretValue} from '../../platform/payment-providers';

/**
 * Ezypay's RAW payment status, which the kit folds together: its `getEzypayPayment` answers
 * `refunded` for `partially_refunded` too, and only a FULL refund may close a ticket. Read only
 * when the kit says `refunded`. Same rules as the kit: EZYPAY_SECRET_KEY read per call through
 * `secretValue` (`config.ownerSecret`), sent only to Ezypay, a short timeout, the answer's mode
 * must be the keys', nothing of the key or Ezypay's error text in the answer or the log. Server only.
 */
export async function getEzypayRawStatus(paymentId: string): Promise<ProviderResult<{status: string}>> {
  if (!isEzypayId(paymentId)) return fail(422, 'invalid_input');
  const key = secretValue('EZYPAY_SECRET_KEY');
  const mode = ezypayMode();
  if (!key || !mode) return fail(0, 'not_configured');
  let res: Response;
  try {
    res = await fetch(`https://ezypay.ezycourse.com/api/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: {authorization: `Bearer ${key}`, accept: 'application/json'},
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
  } catch {
    console.error('[ezypay-payments] GET /payments/pay_…: unreachable');
    return fail(0, 'unreachable');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body !== 'object') {
    console.error(`[ezypay-payments] GET /payments/pay_…: ${res.status}`);
    return fail(res.status || 502, 'error');
  }
  // The kit's envelope: `{data: {...}}` or the object itself; the payment under `payment`.
  const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
  if (data.mode !== undefined && data.mode !== mode) return fail(502, 'mode_mismatch');
  const payment = data.payment && typeof data.payment === 'object' ? (data.payment as Record<string, unknown>) : null;
  if (!payment || payment.id !== paymentId || typeof payment.status !== 'string') return fail(502, 'bad_response');
  return {ok: true, data: {status: payment.status}};
}
