import type {PrismaClient} from '../../generated/prisma/client';
import type {Checkout} from '../../platform/payments';
import {releaseHold} from '../jobs/holds';
import {confirmPaidTicket, refundedTicket} from '../ticket-checkout';
import {paypalCaptureAllowed, type ProviderCheckoutState, readProviderCheckout} from './provider-tickets';

/**
 * A provider checkout, brought in step with the PROVIDER and handed to the SAME logic the built-in
 * payment hooks use (src/server/payments-hooks.ts), so capacity, `refund_due` on a mismatch,
 * the confirmation email and the outbound `order.paid` webhook are identical:
 *
 *   paid      -> confirmPaidTicket (idempotent: the thanks page and every webhook may call it)
 *   failed    -> the held seats go back (releaseHold, conditional on the order still pending)
 *   refunded  -> refundedTicket (a full refund closes the order and frees the seat)
 *
 * Callers: `GET /site-api/checkout/ppc_…` (the thanks and checkout pages) and the provider webhooks.
 */

const rowSelect = {
  id: true,
  rsvpId: true,
  provider: true,
  mode: true,
  providerRef: true,
  providerPaymentId: true,
  seats: true,
  amountMinor: true,
  currency: true,
  status: true,
  step: true,
  createdAt: true,
  price: {select: {key: true, providerPriceId: true}},
} as const;

export type SyncedRow = {
  id: string;
  rsvpId: string;
  provider: string;
  mode: string;
  providerRef: string | null;
  providerPaymentId: string | null;
  seats: number;
  amountMinor: number;
  currency: string;
  status: string;
  step: unknown;
  createdAt: Date;
  price: {key: string; providerPriceId: string};
};

export type SyncStatus = 'open' | 'paid' | 'failed' | 'refunded';
export type SyncResult = {row: SyncedRow; status: SyncStatus; unavailable?: true};

const storedStatus = (status: string): SyncStatus => (status === 'paid' || status === 'failed' || status === 'refunded' ? status : 'open');

/** The built-in `Checkout` shape `confirmPaidTicket` takes, from what the PROVIDER said was paid. */
export function checkoutOf(row: SyncedRow, state: ProviderCheckoutState, now = new Date()): Checkout {
  return {
    id: row.id,
    mode: row.mode === 'live' ? 'live' : 'test',
    status: 'paid',
    price: row.price.key,
    quantity: row.seats,
    email: null,
    amountCents: state.amountMinor ?? -1,
    currency: state.currency ?? '',
    paidAt: now.toISOString(),
    subscription: null,
    metadata: {rsvpId: row.rsvpId},
    customerRef: null,
  };
}

/** A FULL refund at the provider: the order closes and the seat goes back (once). */
export async function refundProviderCheckout(db: PrismaClient, row: Pick<SyncedRow, 'id' | 'amountMinor' | 'currency'>, now = new Date()): Promise<void> {
  await db.providerCheckout.updateMany({where: {id: row.id, status: {not: 'refunded'}}, data: {status: 'refunded'}});
  await refundedTicket(db, {checkoutId: row.id, amountCents: row.amountMinor, currency: row.currency, full: true, refundedAt: now.toISOString()}, now);
}

/**
 * Reads the checkout from the provider and records what changed. Without `force`, a row already
 * settled (paid, failed, refunded) is answered from the database (the thanks page reloading costs
 * no call); webhooks pass `force` (a refund arrives after "paid"). `unavailable`: the provider
 * didn't answer or answered something unexpected; nothing was changed (fails closed).
 */
export async function syncProviderCheckout(db: PrismaClient, id: string, {force = false}: {force?: boolean} = {}): Promise<SyncResult | null> {
  const row: SyncedRow | null = await db.providerCheckout.findUnique({where: {id}, select: rowSelect});
  if (!row) return null;
  if (!force && row.status !== 'open') return {row, status: storedStatus(row.status)};
  const read = await readProviderCheckout(row, {mayCapture: () => paypalCaptureAllowed(db, row.rsvpId)});
  if (!read.ok) {
    console.warn(`[provider-checkout] ${row.provider} ${row.id}: could not confirm (${read.code})`.slice(0, 200));
    return {row, status: storedStatus(row.status), unavailable: true};
  }
  const state = read.data;
  switch (state.status) {
    case 'paid':
    case 'partially_refunded': {
      // Already refunded here (a refund event came first): a late "paid" never reopens the ticket.
      if (row.status === 'refunded') return {row, status: 'refunded'};
      await db.providerCheckout.updateMany({
        where: {id, status: {in: ['open', 'failed']}},
        data: {status: 'paid', providerPaymentId: state.paymentId},
      });
      // A partial refund is still a paid booking: confirm it too (or the hold sweep cancels a payer).
      await confirmPaidTicket(db, checkoutOf(row, state));
      return {row, status: 'paid'};
    }
    case 'failed': {
      const flipped = await db.providerCheckout.updateMany({where: {id, status: 'open'}, data: {status: 'failed'}});
      if (flipped.count === 1) {
        // Like the built-in `onCheckoutFailed`: the held seats go back (waitlist promoted, email).
        const order = await db.ticketOrder.findUnique({where: {checkoutId: id}, select: {status: true}});
        if (order?.status === 'pending') await releaseHold(db, row.rsvpId);
      }
      return {row, status: row.status === 'paid' ? 'paid' : 'failed'};
    }
    case 'refunded':
      await refundProviderCheckout(db, row);
      return {row, status: 'refunded'};
    default:
      // open, or approved at PayPal but its capture still pending.
      return {row, status: storedStatus(row.status)};
  }
}

/** What the browser may see (the same shape as the built-in checkout's `publicCheckout`). */
export function publicProviderCheckout(result: SyncResult) {
  const {row, status} = result;
  return {
    id: row.id,
    mode: row.mode === 'live' ? ('live' as const) : ('test' as const),
    // A refunded payment did go through; `failed` covers expired and declined.
    status: status === 'refunded' ? ('paid' as const) : status,
    price: row.price.key,
    quantity: row.seats,
    amountCents: row.amountMinor,
    currency: row.currency,
    paidAt: null,
    subscription: null,
    embedded: status === 'open' && row.step ? row.step : null,
  };
}
