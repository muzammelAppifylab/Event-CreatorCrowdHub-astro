import type {PrismaClient} from '../../generated/prisma/client';
import {sha256Hex} from '../../platform/auth/encoding';
import {
  type CheckoutStep,
  createEzypayPrice,
  createStripeCheckout,
  createStripePrice,
  getEzypayPayment,
  getStripeCheckout,
  inCurrentMode,
  isProvider,
  type Mode,
  type Provider,
  providerMode,
  providerReady,
  type ProviderResult,
  startEzypayCheckout,
  type StoredPrice,
  fail,
} from '../../platform/payment-providers';
import type {EmbeddedCheckout} from '../../platform/payments';
import {isUniqueViolation, seatsTakenOf} from '../jobs/shared';
import type {StartTicketCheckout} from '../ticket-checkout';
import {seatsRemaining} from '../../domain/capacity';
import {getEzypayRawStatus} from './ezypay-payments';
import {capturePaypalOrder, createPaypalOrder, getPaypalOrder} from './paypal-orders';
import {getStripeSessionTotal} from './stripe-charges';

/**
 * May an approved PayPal order for this RSVP be captured? Only while the booking can still take
 * the money: the event open and the RSVP holding its seats (`awaiting_payment`), or its hold lapsed
 * (`cancelled`) with the seats still free. Otherwise the order is left uncaptured (PayPal voids it
 * later): nothing is charged that would only become a refund. Best effort without a lock;
 * confirmPaidTicket decides again under the event's lock.
 */
export async function paypalCaptureAllowed(db: PrismaClient, rsvpId: string, now = new Date()): Promise<boolean> {
  const rsvp = await db.rsvp.findUnique({
    where: {id: rsvpId},
    select: {status: true, seats: true, eventId: true, event: {select: {status: true, capacity: true, deletedAt: true}}},
  });
  if (!rsvp || rsvp.event.deletedAt || rsvp.event.status !== 'published') return false;
  if (rsvp.status === 'awaiting_payment') return true;
  if (rsvp.status !== 'cancelled') return false;
  const [taken, claimed] = await Promise.all([
    seatsTakenOf(db, rsvp.eventId),
    db.rsvp.aggregate({_sum: {seats: true}, where: {eventId: rsvp.eventId, status: 'waitlisted', claimExpiresAt: {gt: now}}}),
  ]);
  return rsvp.seats <= seatsRemaining(rsvp.event.capacity, taken + (claimed._sum.seats ?? 0));
}

/**
 * Paid tickets through the OWNER's own payment provider (docs/agent/payments-providers.md), when
 * the owner picked one in Settings -> Payments (`provider_settings`). Without a pick the platform's
 * built-in checkout runs, unchanged (src/server/ticket-checkout.ts).
 *
 * The same guarantees as the built-in path (docs/agent/orders-and-stock.md):
 * - the amount is ALWAYS the ticket type's stored price x the RSVP's seats, read here, never from a
 *   caller; the provider charges a price row this site stored (`provider_prices`), made once per
 *   ticket type, amount, currency, provider and mode;
 * - one checkout row per attempt (`provider_checkouts`), whose id is made from the RSVP and the
 *   attempt (`providerCheckoutId`), so a double click, a retry or a second tab reach the SAME row,
 *   the SAME idempotency key (`checkout:<id>`) and so the SAME provider checkout, never a second charge;
 * - the row's id is also the `ticket_orders.checkout_id`, so `confirmPaidTicket` (capacity,
 *   `refund_due` on a mismatch, emails, webhooks out) handles it exactly like a built-in checkout
 *   (src/server/payments/provider-confirm.ts).
 */

/** `ppc_<32 hex>`: a provider checkout's id (unguessable: made from the RSVP's random id). */
export const PROVIDER_CHECKOUT_ID = /^ppc_[0-9a-f]{32}$/;
export const isProviderCheckoutId = (id: unknown): id is string => typeof id === 'string' && PROVIDER_CHECKOUT_ID.test(id);

/** The owner's pick, or null for the built-in checkout. A value that isn't a provider counts as none. */
export async function pickedProvider(db: PrismaClient): Promise<Provider | null> {
  const row = await db.providerSettings.findUnique({where: {id: 1}, select: {provider: true}});
  return isProvider(row?.provider) ? row.provider : null;
}

export interface PriceSpec {
  /** The `provider_prices.key`. */
  key: string;
  /** What the stored price charges for one unit, minor units. */
  unitMinor: number;
  /** How many units the checkout asks for. */
  quantity: number;
  /** unit x quantity: the order's amount. */
  totalMinor: number;
  currency: string;
}

/**
 * Which stored price sells `seats` of a ticket. Stripe and PayPal take a quantity, so one price per
 * ticket amount serves every seat count. Ezypay's payment has no quantity: its price is the WHOLE
 * order (`-x<seats>` on the key), still made from the stored ticket price.
 */
export function providerPriceSpec(provider: Provider, baseKey: string, priceCents: number, currency: string, seats: number): PriceSpec {
  const cur = currency.toUpperCase();
  const totalMinor = priceCents * seats;
  if (provider === 'ezypay' && seats > 1) return {key: `${baseKey}-x${seats}`, unitMinor: totalMinor, quantity: 1, totalMinor, currency: cur};
  return {key: baseKey, unitMinor: priceCents, quantity: provider === 'ezypay' ? 1 : seats, totalMinor, currency: cur};
}

/** The provider's idempotency key for making a price: the same price again is the same object. */
export const priceIdempotencyKey = (provider: Provider, mode: Mode, key: string) => `price:${provider}:${mode}:${key}`;

/** The provider's idempotency key for one checkout attempt (`docs/agent/payments-providers.md`). */
export const checkoutIdempotencyKey = (checkoutId: string) => `checkout:${checkoutId}`;

/**
 * One attempt's checkout id: the same for every retry of that attempt; a new one once the attempt's
 * order was retired (`attempt` = the RSVP's orders that are no longer pending), or when the
 * purchase changed (provider, mode, price, seats).
 */
export async function providerCheckoutId(input: {rsvpId: string; attempt: number; provider: Provider; mode: Mode; priceKey: string; seats: number}): Promise<string> {
  const hash = await sha256Hex(`provider-ticket|${input.rsvpId}|${input.attempt}|${input.provider}|${input.mode}|${input.priceKey}|${input.seats}`);
  return `ppc_${hash.slice(0, 32)}`;
}

const refuse = (status: 404 | 409 | 422 | 502 | 503, code: string, message: string): StartTicketCheckout => ({ok: false, status, code, message});
const NOT_SET_UP = 'Ticket payments are not set up right now. Try again later.';
const PROVIDER_DOWN = 'The payment could not be started. Try again in a minute.';

export const checkoutPagePath = (id: string) => `/checkout/?id=${encodeURIComponent(id)}`;
export const thanksPagePath = (path: string, id: string) => `${path}${path.includes('?') ? '&' : '?'}checkout=${encodeURIComponent(id)}`;

type PriceRow = {id: number; key: string; provider: string; mode: string; providerPriceId: string; amountMinor: number; currency: string; interval: string; archivedAt: Date | null};
const priceSelect = {id: true, key: true, provider: true, mode: true, providerPriceId: true, amountMinor: true, currency: true, interval: true, archivedAt: true} as const;

export const storedPriceOf = (row: PriceRow): StoredPrice => ({
  provider: row.provider as Provider,
  mode: row.mode as Mode,
  providerPriceId: row.providerPriceId,
  amountMinor: row.amountMinor,
  currency: row.currency,
  interval: 'one_time',
});

/**
 * The stored price for `spec`, made at the provider the first time (one call, with an idempotency
 * key, so two first buyers at once make one price; the unique key keeps one row).
 */
export async function ensureProviderPrice(
  db: PrismaClient,
  input: {provider: Provider; mode: Mode; spec: PriceSpec; name: string; ticketTypeId: string},
): Promise<{ok: true; price: PriceRow} | {ok: false; status: 409 | 502 | 503; code: string; message: string}> {
  const {provider, mode, spec} = input;
  const where = {provider_mode_key: {provider, mode, key: spec.key}};
  const matches = (row: PriceRow) => !row.archivedAt && row.amountMinor === spec.unitMinor && row.currency === spec.currency && inCurrentMode(row);
  const found = await db.providerPrice.findUnique({where, select: priceSelect});
  if (found) {
    return matches(found) ? {ok: true, price: found} : {ok: false, status: 409, code: 'ticket_price_mismatch', message: 'This ticket price needs to be updated by the host.'};
  }
  let providerPriceId: string;
  if (provider === 'paypal') {
    // PayPal orders carry their amount: the row is what fixes it (taken from here at checkout).
    providerPriceId = `order:${spec.key}`;
  } else {
    const made = await (provider === 'stripe' ? createStripePrice : createEzypayPrice)({
      name: input.name,
      amountMinor: spec.unitMinor,
      currency: spec.currency,
      interval: 'one_time',
      idempotencyKey: priceIdempotencyKey(provider, mode, spec.key),
    });
    if (!made.ok) return {ok: false, status: made.status === 0 ? 503 : 502, code: 'provider_error', message: made.status === 0 ? NOT_SET_UP : PROVIDER_DOWN};
    // The answer must be the price asked for, in the mode the keys are in.
    if (made.data.amountMinor !== spec.unitMinor || made.data.currency !== spec.currency || made.data.mode !== mode) {
      return {ok: false, status: 502, code: 'provider_error', message: PROVIDER_DOWN};
    }
    providerPriceId = made.data.providerPriceId;
  }
  try {
    const price = await db.providerPrice.create({
      data: {key: spec.key, name: input.name.slice(0, 120), provider, mode, providerPriceId, amountMinor: spec.unitMinor, currency: spec.currency, interval: 'one_time', ticketTypeId: input.ticketTypeId},
      select: priceSelect,
    });
    return {ok: true, price};
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A racing first buyer stored it (the same provider price: same idempotency key).
    const again = await db.providerPrice.findUnique({where, select: priceSelect});
    return again && matches(again) ? {ok: true, price: again} : {ok: false, status: 409, code: 'ticket_price_mismatch', message: 'This ticket price needs to be updated by the host.'};
  }
}

export interface ProviderTicketInput {
  rsvp: {id: string; seats: number};
  ticket: {id: string; name: string; priceCents: number; currency: string};
  eventTitle: string;
  /** `ticketPriceKey(ticket)`. */
  baseKey: string;
  provider: Provider;
  /** The site's own origin (absolute URLs for the provider). */
  origin: string;
  successPath: string;
  /** A path on this site that carries no secret (never the guest's `/r/<token>/` link). */
  cancelPath: string;
}

type CheckoutRow = {id: string; status: string; providerRef: string | null; step: unknown};

async function recordOrder(db: PrismaClient, input: {checkoutId: string; rsvpId: string; amountMinor: number; currency: string; seats: number}) {
  try {
    await db.ticketOrder.create({
      data: {rsvpId: input.rsvpId, checkoutId: input.checkoutId, amountCents: input.amountMinor, currency: input.currency, seats: input.seats, status: 'pending'},
    });
  } catch (error) {
    // A racing start of the same attempt recorded it first.
    if (!isUniqueViolation(error)) throw error;
  }
}

/** Starts (or joins) this attempt's checkout at the owner's provider. Called by `startTicketCheckout`. */
export async function startProviderTicketCheckout(db: PrismaClient, input: ProviderTicketInput): Promise<StartTicketCheckout> {
  const {provider, rsvp, ticket} = input;
  const mode = providerMode(provider);
  // Fail closed: the owner's pick can't take money (a key removed, a live key in the Preview).
  if (!mode || !providerReady(provider)) return refuse(503, 'payments_unavailable', NOT_SET_UP);
  const spec = providerPriceSpec(provider, input.baseKey, ticket.priceCents, ticket.currency, rsvp.seats);
  const name = `${input.eventTitle} - ${ticket.name}`.slice(0, 120);
  const priced = await ensureProviderPrice(db, {provider, mode, spec, name, ticketTypeId: ticket.id});
  if (!priced.ok) return refuse(priced.status, priced.code, priced.message);
  const price = priced.price;

  const attempt = await db.ticketOrder.count({where: {rsvpId: rsvp.id, status: {not: 'pending'}}});
  const id = await providerCheckoutId({rsvpId: rsvp.id, attempt, provider, mode, priceKey: spec.key, seats: rsvp.seats});
  await db.providerCheckout.createMany({
    data: [{id, rsvpId: rsvp.id, priceId: price.id, provider, mode, seats: rsvp.seats, amountMinor: spec.totalMinor, currency: spec.currency, status: 'open'}],
    skipDuplicates: true,
  });
  const row: CheckoutRow | null = await db.providerCheckout.findUnique({where: {id}, select: {id: true, status: true, providerRef: true, step: true}});
  if (!row) return refuse(503, 'payments_unavailable', PROVIDER_DOWN);
  const order = {checkoutId: id, rsvpId: rsvp.id, amountMinor: spec.totalMinor, currency: spec.currency, seats: rsvp.seats};
  if (row.status === 'paid') return {ok: true, checkoutId: id, redirectUrl: thanksPagePath(input.successPath, id), embedded: null, reused: true, paid: true};
  if (row.status !== 'open') return refuse(409, 'checkout_closed', 'This checkout has ended. Start the booking again.');
  if (row.providerRef && row.step) {
    // A racing start of this attempt already opened it: the same checkout.
    await recordOrder(db, order);
    return {ok: true, checkoutId: id, redirectUrl: checkoutPagePath(id), embedded: row.step as EmbeddedCheckout, reused: true};
  }

  const successUrl = `${input.origin}${thanksPagePath(input.successPath, id)}`;
  const cancelUrl = `${input.origin}${input.cancelPath}`;
  const idempotencyKey = checkoutIdempotencyKey(id);
  const stored = storedPriceOf(price);
  let started: ProviderResult<{ref: string; step: CheckoutStep}>;
  if (provider === 'stripe') {
    const res = await createStripeCheckout({price: stored, ref: id, successUrl, cancelUrl, quantity: spec.quantity, idempotencyKey});
    started = res.ok ? {ok: true, data: {ref: res.data.sessionId, step: res.data.step}} : res;
  } else if (provider === 'ezypay') {
    const res = await startEzypayCheckout({price: stored, ref: id, successUrl, cancelUrl, method: 'hosted', idempotencyKey});
    started = res.ok ? (res.data.paymentId ? {ok: true, data: {ref: res.data.paymentId, step: res.data.step}} : fail(502, 'bad_response')) : res;
  } else {
    const res = await createPaypalOrder({unitMinor: price.amountMinor, quantity: spec.quantity, currency: price.currency, name, ref: id, returnUrl: successUrl, cancelUrl, idempotencyKey});
    started = res.ok ? {ok: true, data: {ref: res.data.orderId, step: res.data.step}} : res;
  }
  if (!started.ok) {
    if (started.code === 'in_progress') return refuse(409, 'checkout_in_progress', 'Your checkout is starting. Try again in a moment.');
    return refuse(started.status === 0 ? 503 : 502, 'provider_error', started.status === 0 ? NOT_SET_UP : PROVIDER_DOWN);
  }
  await db.providerCheckout.update({
    where: {id},
    data: {providerRef: started.data.ref, step: started.data.step as unknown as object},
  });
  await recordOrder(db, order);
  return {ok: true, checkoutId: id, redirectUrl: checkoutPagePath(id), embedded: started.data.step as EmbeddedCheckout, reused: false};
}

// ---------------------------------------------------------------- reading a checkout back

export type ProviderCheckoutState = {
  status: 'open' | 'approved' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
  /** What the provider says was paid (minor units), when paid. */
  amountMinor: number | null;
  currency: string | null;
  /** What a refund points at: Stripe `pi_…`, PayPal capture id, Ezypay `pay_…`. */
  paymentId: string | null;
};

export type ProviderCheckoutRow = {
  id: string;
  provider: string;
  mode: string;
  providerRef: string | null;
  amountMinor: number;
  currency: string;
  price: {providerPriceId: string};
};

const open: ProviderCheckoutState = {status: 'open', amountMinor: null, currency: null, paymentId: null};

/**
 * The checkout as the PROVIDER has it now (never the URL, never an event body). Its `ref` must be
 * this row. PayPal: an approved order is captured here (once: `capture:<id>`). Fails closed: any
 * error or unexpected answer is `ok: false`, never "paid".
 */
export async function readProviderCheckout(
  row: ProviderCheckoutRow,
  {mayCapture = async () => true}: {mayCapture?: () => Promise<boolean>} = {},
): Promise<ProviderResult<ProviderCheckoutState>> {
  if (!isProvider(row.provider)) return fail(422, 'wrong_provider');
  if (!row.providerRef) return {ok: true, data: open};
  if (providerMode(row.provider) !== row.mode) return fail(0, 'mode_mismatch');
  if (row.provider === 'stripe') {
    const res = await getStripeCheckout(row.providerRef);
    if (!res.ok) return res;
    if (res.data.ref !== row.id || (res.data.mode !== null && res.data.mode !== 'payment')) return fail(502, 'ref_mismatch');
    if (res.data.status === 'paid') {
      // What Stripe actually charged (the kit doesn't return it), so confirmPaidTicket's amount
      // check compares the real total with the order's.
      const total = await getStripeSessionTotal(row.providerRef);
      if (!total.ok) return total;
      if (total.data.ref !== row.id) return fail(502, 'ref_mismatch');
      return {ok: true, data: {status: 'paid', amountMinor: total.data.amountMinor, currency: total.data.currency, paymentId: res.data.paymentIntentId}};
    }
    return {ok: true, data: res.data.status === 'expired' ? {...open, status: 'failed'} : open};
  }
  if (row.provider === 'ezypay') {
    const res = await getEzypayPayment(row.providerRef);
    if (!res.ok) return res;
    if (res.data.ref !== row.id || (res.data.priceId !== null && res.data.priceId !== row.price.providerPriceId)) return fail(502, 'ref_mismatch');
    let status: ProviderCheckoutState['status'] = res.data.status;
    if (status === 'refunded') {
      // The kit folds `partially_refunded` into `refunded`: only a FULL refund closes the ticket.
      const raw = await getEzypayRawStatus(row.providerRef);
      if (!raw.ok) return raw;
      status = raw.data.status === 'refunded' ? 'refunded' : 'partially_refunded';
    }
    if (status !== 'open' && status !== 'failed' && (res.data.amountMinor === null || !res.data.currency)) return fail(502, 'bad_response');
    return {ok: true, data: {status, amountMinor: res.data.amountMinor, currency: res.data.currency, paymentId: res.data.id}};
  }
  let res = await getPaypalOrder(row.providerRef);
  // Capture only money this booking can still honour: never take it to mark it refund_due at once.
  if (res.ok && res.data.ref === row.id && res.data.status === 'approved' && (await mayCapture())) {
    res = await capturePaypalOrder(row.providerRef, `capture:${row.id}`);
  }
  if (!res.ok) return res;
  if (res.data.ref !== row.id) return fail(502, 'ref_mismatch');
  if (res.data.status === 'paid' && (res.data.amountMinor === null || !res.data.currency)) return fail(502, 'bad_response');
  return {ok: true, data: {status: res.data.status, amountMinor: res.data.amountMinor, currency: res.data.currency, paymentId: res.data.captureId}};
}

/**
 * Resume: the RSVP's pending order is a provider checkout. `reuse` while it is open at the owner's
 * CURRENT pick; `paid` (or PayPal approved) sends the buyer to the thanks page, which confirms;
 * anything else retires the order so a new attempt starts. `unavailable`: the provider didn't answer.
 */
export async function resumeProviderOrder(
  db: PrismaClient,
  pending: {id: string; checkoutId: string},
  pick: Provider | null,
): Promise<{kind: 'reuse'; embedded: EmbeddedCheckout} | {kind: 'paid'} | {kind: 'retired'} | {kind: 'unavailable'}> {
  const row = await db.providerCheckout.findUnique({
    where: {id: pending.checkoutId},
    select: {id: true, provider: true, mode: true, providerRef: true, amountMinor: true, currency: true, status: true, step: true, price: {select: {providerPriceId: true}}},
  });
  const retire = async () => {
    await db.ticketOrder.updateMany({where: {id: pending.id, status: 'pending'}, data: {status: 'expired'}});
    if (row) await db.providerCheckout.updateMany({where: {id: row.id, status: 'open'}, data: {status: 'failed'}});
    return {kind: 'retired'} as const;
  };
  if (!row) return retire();
  if (row.status === 'paid') return {kind: 'paid'};
  // Keys removed since: nothing to ask. A late payment still lands (confirmPaidTicket takes expired orders).
  if (!isProvider(row.provider) || providerMode(row.provider) !== row.mode) return retire();
  const state = await readProviderCheckout(row);
  if (!state.ok) return {kind: 'unavailable'};
  if (state.data.status === 'paid' || state.data.status === 'approved' || state.data.status === 'partially_refunded') return {kind: 'paid'};
  if (state.data.status === 'open' && row.provider === pick && row.providerRef && row.step) return {kind: 'reuse', embedded: row.step as EmbeddedCheckout};
  return retire();
}
