import {type Context, Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';

import type {PrismaClient} from '../../generated/prisma/client';
import {getDb} from '../../platform/db';
import {problem} from '../../platform/guards';
import {
  type ProviderEvent,
  providerMode,
  verifyEzypayWebhook,
  verifyPaypalWebhook,
  verifyStripeWebhook,
  webhookIpAllowed,
} from '../../platform/payment-providers';
import {getPaypalCapture, isPaypalOrderId} from '../payments/paypal-orders';
import {refundProviderCheckout, syncProviderCheckout} from '../payments/provider-confirm';
import {getStripeCharge} from '../payments/stripe-charges';

/**
 * Webhooks from the OWNER's own payment provider (docs/agent/payments-providers.md "Webhooks"):
 *
 *   POST /site-api/payment-webhooks/stripe   Stripe-Signature over the raw body
 *   POST /site-api/payment-webhooks/paypal   PayPal's verify-webhook-signature (stale transmissions dropped first)
 *   POST /site-api/payment-webhooks/ezypay   ezy-signature, then the event re-read from Ezypay
 *
 * Mounted in app.ts BEFORE `sameOrigin` and `csrf` (providers post cross-site with no CSRF token);
 * the signature check is the gate. In order: a per-IP limit (before the body is read), a body limit,
 * the check on the RAW body, the other mode's events ignored, each event id handled once
 * (`provider_events`), then the checkout RE-READ from the provider (never the event body) and
 * recorded by the same logic as the built-in hooks (src/server/payments/provider-confirm.ts).
 * A failed check answers 400 and changes nothing; a failed re-read answers 500 and forgets the
 * event id, so the provider's retry runs it again.
 *
 * Events this app needs (one-time ticket sales):
 *   Stripe   checkout.session.completed, checkout.session.async_payment_succeeded,
 *            checkout.session.async_payment_failed, checkout.session.expired, charge.refunded
 *   PayPal   CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED,
 *            PAYMENT.CAPTURE.REFUNDED, PAYMENT.CAPTURE.REVERSED
 *   Ezypay   payment.succeeded, payment.failed, payment.refunded
 * Anything else is acknowledged and ignored.
 */

type Provider = 'stripe' | 'paypal' | 'ezypay';

const STRIPE_SESSION = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired']);
const PAYPAL_CAPTURE = new Set(['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.PENDING']);
const PAYPAL_REFUND = new Set(['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED']);
const EZYPAY_PAYMENT = new Set(['payment.succeeded', 'payment.failed', 'payment.refunded']);

class RetryLater extends Error {}

/** Brings the checkout the provider object belongs to in step (a re-read inside); unknown ones are not ours. */
async function syncByRef(db: PrismaClient, provider: Provider, providerRef: string | null): Promise<void> {
  if (!providerRef) return;
  const row = await db.providerCheckout.findUnique({where: {provider_providerRef: {provider, providerRef}}, select: {id: true}});
  if (!row) return;
  const synced = await syncProviderCheckout(db, row.id, {force: true});
  if (synced?.unavailable) throw new RetryLater('re-read failed');
}

/** The capture a PayPal refund event is about: the refund's `up` link, or the capture itself. */
function paypalCaptureIdOf(event: ProviderEvent): string | null {
  const links = Array.isArray(event.object?.links) ? (event.object.links as {rel?: unknown; href?: unknown}[]) : [];
  for (const link of links) {
    if (link?.rel !== 'up' || typeof link.href !== 'string') continue;
    const m = /\/v2\/payments\/captures\/([A-Z0-9]{8,64})(?:$|[/?])/.exec(link.href);
    if (m) return m[1]!;
  }
  return event.type === 'PAYMENT.CAPTURE.REVERSED' && isPaypalOrderId(event.objectId) ? event.objectId : null;
}

async function apply(db: PrismaClient, provider: Provider, event: ProviderEvent): Promise<void> {
  if (provider === 'stripe') {
    if (STRIPE_SESSION.has(event.type)) return syncByRef(db, 'stripe', event.objectId);
    if (event.type === 'charge.refunded' && event.objectId) {
      const charge = await getStripeCharge(event.objectId);
      if (!charge.ok) throw new RetryLater('re-read failed');
      if (!charge.data.refunded || !charge.data.paymentIntentId) return; // a partial refund leaves the ticket alone
      const row = await db.providerCheckout.findFirst({
        where: {provider: 'stripe', providerPaymentId: charge.data.paymentIntentId},
        select: {id: true, amountMinor: true, currency: true},
      });
      if (row) await refundProviderCheckout(db, row);
    }
    return;
  }
  if (provider === 'ezypay') {
    // The re-read of the payment decides paid, failed or refunded.
    if (EZYPAY_PAYMENT.has(event.type)) return syncByRef(db, 'ezypay', event.objectId);
    return;
  }
  if (event.type === 'CHECKOUT.ORDER.APPROVED') return syncByRef(db, 'paypal', isPaypalOrderId(event.objectId) ? event.objectId : null);
  if (PAYPAL_CAPTURE.has(event.type) || PAYPAL_REFUND.has(event.type)) {
    const captureId = PAYPAL_CAPTURE.has(event.type) ? (isPaypalOrderId(event.objectId) ? event.objectId : null) : paypalCaptureIdOf(event);
    if (!captureId) return;
    const capture = await getPaypalCapture(captureId);
    if (!capture.ok) throw new RetryLater('re-read failed');
    if (PAYPAL_CAPTURE.has(event.type)) return syncByRef(db, 'paypal', capture.data.orderId);
    if (capture.data.status !== 'refunded') return; // partially refunded: the ticket stays
    const row =
      (await db.providerCheckout.findFirst({where: {provider: 'paypal', providerPaymentId: captureId}, select: {id: true, amountMinor: true, currency: true}})) ??
      (capture.data.orderId
        ? await db.providerCheckout.findUnique({where: {provider_providerRef: {provider: 'paypal', providerRef: capture.data.orderId}}, select: {id: true, amountMinor: true, currency: true}})
        : null);
    if (row) await refundProviderCheckout(db, row);
  }
}

async function handle(c: Context, provider: Provider, event: ProviderEvent | null) {
  if (!event) return c.json({error: 'bad_signature'}, 400);
  // The other copy's event (sandbox vs live): acknowledged, nothing done.
  if (event.mode !== providerMode(provider)) return c.json({ok: true});
  const db = getDb();
  if (!db) return c.json({error: 'retry'}, 503);
  // Once per event id: the primary key refuses a second insert.
  const fresh = await db.providerEvent.createMany({data: [{provider, eventId: event.id.slice(0, 120)}], skipDuplicates: true});
  if (fresh.count === 0) return c.json({ok: true});
  try {
    await apply(db, provider, event);
    return c.json({ok: true});
  } catch (error) {
    if (!(error instanceof RetryLater)) console.error(`[payment-webhooks] ${provider} ${event.type}: ${error instanceof Error ? error.message : 'failed'}`.slice(0, 300));
    // Let the provider's retry run it again.
    await db.providerEvent.deleteMany({where: {provider, eventId: event.id.slice(0, 120)}});
    return c.json({error: 'retry'}, 500);
  }
}

export const providerWebhooks = new Hono()
  // Per-IP limit FIRST, before the body is read: anyone can post here, and a post can cost a call to the provider.
  .use(async (c, next) => (webhookIpAllowed(c.req.header('cf-connecting-ip')) ? next() : c.json({error: 'rate_limited'}, 429)))
  .use(bodyLimit({maxSize: 256 * 1024, onError: c => c.json({error: 'too_large'}, 413)}))
  .post('/stripe', async c => handle(c, 'stripe', await verifyStripeWebhook(await c.req.text(), c.req.header('stripe-signature'))))
  .post('/paypal', async c => handle(c, 'paypal', await verifyPaypalWebhook(c.req.raw.headers, await c.req.text())))
  .post('/ezypay', async c => handle(c, 'ezypay', await verifyEzypayWebhook(await c.req.text(), c.req.header('ezy-signature'))))
  .all('*', c => c.json(problem('not_found', 'No such payment provider.'), 404));
