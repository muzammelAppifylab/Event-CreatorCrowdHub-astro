import {seatsRemaining} from '../domain/capacity';
import type {PrismaClient} from '../generated/prisma/client';
import {siteKeyPost} from '../platform/api';
import {sha256Hex} from '../platform/auth/encoding';
import {
  type Checkout,
  createCheckout,
  createPrice,
  findPrice,
  getCheckout,
  type EmbeddedCheckout,
  type Refund,
} from '../platform/payments';
import {notifyPromoted} from './jobs/holds';
import {isProviderCheckoutId, pickedProvider, resumeProviderOrder, startProviderTicketCheckout} from './payments/provider-tickets';
import {queueGuestEmail} from './jobs/guest-emails';
import {emitCancelledIds, emitSeated, emitWebhook, orderPaidPayload} from './webhook-emit';
import {isUniqueViolation, lockEvent, seatsTakenOf, siteBase} from './jobs/shared';
import {promoteWaitlist} from './jobs/waitlist';

/**
 * Ticket checkout on top of the platform's payments (docs/agent/payments.md,
 * docs/porting/payments-jobs.md).
 *
 * The platform charges a CATALOGUE amount by price KEY, so a ticket type's price is one
 * catalogue price whose key is derived from the ticket type AND its amount
 * (`ticketPriceKey`): changing a ticket's price makes a new key, never a changed one. The
 * quantity is the RSVP's seat count. The platform checkout id is the `ticket_orders` key.
 *
 * Once, and never too many (docs/agent/orders-and-stock.md):
 * - the seats are HELD when the RSVP is made (`awaiting_payment`, counted by the capacity rule
 *   under the event's row lock), confirmed conditionally when the money arrives
 *   (`confirmPaidTicket`) and given back conditionally when the hold lapses or the checkout fails
 *   (`releaseHold` in jobs/holds.ts);
 * - every checkout start carries an idempotency key made from the RSVP and the attempt
 *   (`ticketAttemptKey`), so a double click, a retry or a second tab get the SAME platform
 *   checkout, never a second charge;
 * - a payment that cannot be honoured (paid twice, the hold lapsed and the seats went, the event
 *   closed, the amount differs) is never ignored: the order becomes `refund_due` and the owner is told.
 */

/** Where the buyer is sent after paying / backing out (paths on this site; the platform adds `checkout=<id>`). */
const THANKS_PATH = '/thanks/';
const CHECKOUT_PAGE = '/checkout/';
/** The portal screen that lists orders waiting for a refund. */
const REFUNDS_SCREEN = '/dashboard/refunds';

/** `tkt-<24 hex of the ticket type id>-<cents>-<currency>`: a valid catalogue key (a-z0-9-, under 64). */
export function ticketPriceKey(ticket: {id: string; priceCents: number; currency: string}): string {
  return `tkt-${ticket.id.replace(/-/g, '').toLowerCase().slice(0, 24)}-${ticket.priceCents}-${ticket.currency.toLowerCase()}`;
}

/**
 * The platform idempotency key for one checkout attempt of one RSVP: the same on every retry of
 * that attempt (a double click, a lost answer, a second tab), a new one only once the attempt's
 * order was retired (`attempt` = the RSVP's orders so far) or the purchase itself changed (price
 * key, seats). Made from our own ids, never a random value per try. 52 characters of [a-z0-9-].
 */
export async function ticketAttemptKey(input: {rsvpId: string; attempt: number; priceKey: string; seats: number}): Promise<string> {
  const hash = await sha256Hex(`ticket|${input.rsvpId}|${input.attempt}|${input.priceKey}|${input.seats}`);
  return `tkt-${hash.slice(0, 48)}`;
}

export type StartTicketCheckout =
  | {ok: true; checkoutId: string; redirectUrl: string; embedded: EmbeddedCheckout | null; reused: boolean; paid?: true}
  | {ok: false; status: 404 | 409 | 422 | 502 | 503; code: string; message: string};

const refuse = (status: 404 | 409 | 422 | 502 | 503, code: string, message: string): StartTicketCheckout => ({ok: false, status, code, message});

/** A same-site path that carries no secret; anything else (or a `/r/` manage link) is dropped. */
const safeCancelPath = (path: string | undefined): string | undefined =>
  path && /^\/(?!\/)[\w\-./]*$/.test(path) && !path.startsWith('/r/') ? path : undefined;

const checkoutPage = (id: string) => `${CHECKOUT_PAGE}?id=${encodeURIComponent(id)}`;
const thanksPage = (path: string, id: string) => `${path}${path.includes('?') ? '&' : '?'}checkout=${encodeURIComponent(id)}`;

/**
 * Starts (or resumes) the platform checkout for a paid RSVP that is `awaiting_payment`.
 * Safe to call again, and at the same moment: while a pending order's checkout is still open it
 * is returned as is, and two starts racing send the same idempotency key, so the platform answers
 * both with ONE checkout (`ticket_orders.checkout_id` is unique: the second insert is a no-op).
 * The public RSVP route calls this right after it creates the RSVP; the amount is ALWAYS
 * recomputed here from the ticket type (price x seats), never taken from a caller.
 */
export async function startTicketCheckout(
  db: PrismaClient,
  rsvpId: string,
  options: {requestUrl?: string | URL; successPath?: string; cancelPath?: string} = {},
): Promise<StartTicketCheckout> {
  const rsvp = await db.rsvp.findUnique({
    where: {id: rsvpId},
    select: {
      id: true, name: true, email: true, seats: true, status: true, eventId: true,
      ticketType: {select: {id: true, name: true, priceCents: true, currency: true, eventId: true}},
      event: {select: {slug: true, title: true, status: true, deletedAt: true}},
    },
  });
  if (!rsvp || rsvp.event.deletedAt) return refuse(404, 'not_found', 'No such booking.');
  if (rsvp.status !== 'awaiting_payment') return refuse(409, 'not_awaiting_payment', 'This booking is not waiting for payment.');
  if (rsvp.event.status !== 'published') return refuse(409, 'event_closed', 'This event is not taking bookings.');
  const ticket = rsvp.ticketType;
  if (!ticket || ticket.eventId !== rsvp.eventId || ticket.priceCents <= 0) return refuse(422, 'no_payment_due', 'This ticket is free.');
  const requestUrl = options.requestUrl ?? siteBase();
  const successPath = options.successPath ?? THANKS_PATH;
  // Never a path with the guest's manage token (`/r/<token>/`): this URL is sent to the payment provider.
  const cancelPath = safeCancelPath(options.cancelPath) ?? `/events/${rsvp.event.slug}/`;

  // The owner's own payment provider (Settings -> Payments), or null for the built-in checkout.
  const [pick, pending] = await Promise.all([
    pickedProvider(db),
    // Resume: one pending order per RSVP. An open checkout is reused; a closed one is retired.
    db.ticketOrder.findFirst({where: {rsvpId, status: 'pending'}, select: {id: true, checkoutId: true}, orderBy: {createdAt: 'desc'}}),
  ]);
  if (pending && isProviderCheckoutId(pending.checkoutId)) {
    const resumed = await resumeProviderOrder(db, pending, pick);
    if (resumed.kind === 'reuse') return {ok: true, checkoutId: pending.checkoutId, redirectUrl: checkoutPage(pending.checkoutId), embedded: resumed.embedded, reused: true};
    // Paid (or approved at PayPal): the thanks page confirms with the provider. Nothing new is charged.
    if (resumed.kind === 'paid') return {ok: true, checkoutId: pending.checkoutId, redirectUrl: thanksPage(successPath, pending.checkoutId), embedded: null, reused: true, paid: true};
    if (resumed.kind === 'unavailable') return refuse(503, 'payments_unavailable', 'The payment provider did not answer. Try again in a minute.');
    // Retired: a new attempt below.
  } else if (pending) {
    const existing = await getCheckout(requestUrl, pending.checkoutId);
    if (existing.ok && existing.data.status === 'open' && existing.data.embedded) {
      return {ok: true, checkoutId: pending.checkoutId, redirectUrl: checkoutPage(pending.checkoutId), embedded: existing.data.embedded, reused: true};
    }
    if (existing.ok && existing.data.status === 'paid') return refuse(409, 'already_paid', 'This booking is already paid.');
    if (existing.ok) await db.ticketOrder.updateMany({where: {id: pending.id, status: 'pending'}, data: {status: 'expired'}});
    // Platform unreachable: keep the order and fall through to a new checkout only when it answered.
    else return refuse(503, 'payments_unavailable', existing.message);
  }

  const key = ticketPriceKey(ticket);
  const seats = rsvp.seats;
  if (pick) {
    return startProviderTicketCheckout(db, {
      rsvp: {id: rsvp.id, seats},
      ticket,
      eventTitle: rsvp.event.title,
      baseKey: key,
      provider: pick,
      origin: new URL(String(requestUrl)).origin,
      successPath,
      cancelPath,
    });
  }
  const price = await findPrice(requestUrl, key);
  if (!price.ok) return refuse(price.status === 0 ? 503 : 502, price.code.toLowerCase(), price.message);
  if (!price.data) {
    // Creating a price works from the editor/Preview only (E_PAYMENTS_EDITOR_ONLY on the live site).
    // The same key and amount again changes nothing, so two first buyers at once are fine.
    const created = await createPrice(requestUrl, {
      key,
      name: `${rsvp.event.title} - ${ticket.name}`.slice(0, 80),
      amountCents: ticket.priceCents,
      currency: ticket.currency,
      interval: 'one_time',
    });
    if (!created.ok) {
      const missing = created.code === 'E_PAYMENTS_EDITOR_ONLY';
      return refuse(
        missing ? 503 : created.status === 0 ? 503 : 502,
        missing ? 'ticket_price_missing' : created.code.toLowerCase(),
        missing ? 'Tickets for this event are not on sale yet. The host needs to publish the ticket price.' : created.message,
      );
    }
  } else if (price.data.amountCents !== ticket.priceCents || price.data.currency.toUpperCase() !== ticket.currency.toUpperCase()) {
    // A price never changes; a mismatch means the key was reused by hand. Refuse rather than mis-charge.
    return refuse(409, 'ticket_price_mismatch', 'This ticket price needs to be updated by the host.');
  }

  // Counted after a closed checkout was retired above, so only a retired attempt gets a new key. A
  // pending order is the attempt in flight (a racing start may have just recorded it): never counted.
  const attempt = await db.ticketOrder.count({where: {rsvpId: rsvp.id, status: {not: 'pending'}}});
  const started = await createCheckout(requestUrl, {
    price: key,
    quantity: seats,
    email: rsvp.email,
    name: rsvp.name,
    successPath,
    cancelPath,
    metadata: {rsvpId: rsvp.id, ticketTypeId: ticket.id, eventId: rsvp.eventId},
    idempotencyKey: await ticketAttemptKey({rsvpId: rsvp.id, attempt, priceKey: key, seats}),
  });
  if (!started.ok) {
    // The same attempt is still starting (a double click): keep it and ask to try again shortly.
    if (started.code === 'E_SITE_PAYMENTS_IN_PROGRESS') return refuse(409, 'checkout_in_progress', 'Your checkout is starting. Try again in a moment.');
    const status = started.status === 404 ? 503 : started.status === 422 ? 422 : started.status === 0 ? 503 : 502;
    return refuse(status, started.code.toLowerCase(), started.message);
  }

  try {
    await db.ticketOrder.create({
      data: {rsvpId: rsvp.id, checkoutId: started.data.id, amountCents: ticket.priceCents * seats, currency: ticket.currency.toUpperCase(), seats, status: 'pending'},
    });
  } catch (error) {
    // A racing start with the same key got the same checkout and recorded it first.
    if (!isUniqueViolation(error)) throw error;
  }
  if (started.data.paid) {
    // This attempt was already paid (its first answer was lost): nothing new was charged. The thanks
    // page confirms the payment (`GET /site-api/checkout/:id` runs `confirmPaidTicket`).
    return {ok: true, checkoutId: started.data.id, redirectUrl: thanksPage(successPath, started.data.id), embedded: null, reused: true, paid: true};
  }
  return {ok: true, checkoutId: started.data.id, redirectUrl: checkoutPage(started.data.id), embedded: started.data.embedded ?? null, reused: false};
}

export type PaidOutcome =
  | {kind: 'not_ours'}
  | {kind: 'already'}
  | {kind: 'confirmed'; rsvpId: string}
  | {kind: 'refund_due'; rsvpId: string; reason: string};

const REFUND_REASONS: Record<string, string> = {
  amount_mismatch: 'the amount paid is not the order amount',
  event_closed: 'the event is no longer taking bookings',
  hold_lapsed_no_seats: 'the seat hold ran out before the payment and the seats were taken',
  duplicate_payment: 'this booking was already paid by another checkout',
};

/**
 * Tells the site owner that money arrived that must be refunded (kind `notification`, no `to`:
 * the platform sends it to the owner; the site never knows their address). Best effort: the
 * order is already `refund_due` and listed on the Refunds screen, so a lost email loses nothing.
 * No guest name or email in it.
 */
async function tellOwnerRefundDue(info: {checkoutId: string; reason: string; amountCents: number; currency: string; eventTitle: string | null}): Promise<void> {
  const why = REFUND_REASONS[info.reason] ?? `the booking is ${info.reason.replace(/^rsvp_/, '').replace(/_/g, ' ')}`;
  const amount = `${(info.amountCents / 100).toFixed(2)} ${info.currency.toUpperCase()}`;
  const text = [
    `A ticket payment of ${amount}${info.eventTitle ? ` for "${info.eventTitle}"` : ''} arrived but could not be honoured: ${why}.`,
    info.checkoutId.startsWith('ppc_')
      ? `Refund it in your payment provider's dashboard (reference ${info.checkoutId}). The order closes by itself once it is refunded.`
      : `Refund it in the dashboard's Payments tab (checkout ${info.checkoutId}). The order closes by itself once it is refunded.`,
  ].join('\n\n');
  try {
    await siteKeyPost(siteBase(), '/emails', {kind: 'notification', subject: 'A ticket payment needs a refund', text: text.slice(0, 2000), path: REFUNDS_SCREEN});
  } catch (error) {
    console.warn(`[tickets] could not email the owner about ${info.checkoutId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
}

/**
 * A paid platform checkout: confirm the RSVP (-> confirmed, order -> paid) and queue the
 * confirmation email. IDEMPOTENT (events and the thanks page's confirm both call it): every
 * write is conditional on the current status, the email is only queued by the call that flipped it.
 * A payment that cannot be honoured (the hold lapsed and the seats went, the event was
 * cancelled, the amount is not the order's, the booking was already paid by another checkout)
 * marks the order `refund_due` and emails the owner once: the owner refunds it in the dashboard
 * and the `payment.refunded` event closes it (`refundedTicket`).
 */
export async function confirmPaidTicket(db: PrismaClient, checkout: Checkout, now = new Date()): Promise<PaidOutcome> {
  const order = await db.ticketOrder.findUnique({
    where: {checkoutId: checkout.id},
    select: {id: true, rsvpId: true, status: true, amountCents: true, currency: true, seats: true, rsvp: {select: {eventId: true, event: {select: {title: true}}}}},
  });
  if (!order) return {kind: 'not_ours'};
  if (order.status === 'paid' || order.status === 'refunded' || order.status === 'refund_due') return {kind: 'already'};

  const tampered =
    checkout.amountCents !== order.amountCents ||
    checkout.currency.toUpperCase() !== order.currency.toUpperCase() ||
    (checkout.metadata?.rsvpId !== undefined && checkout.metadata.rsvpId !== order.rsvpId);

  // Set only by the call that moved the order to `refund_due`, so the owner is told once.
  let flaggedForRefund = false;
  const outcome = await db.$transaction(async (tx): Promise<PaidOutcome> => {
    await lockEvent(tx, order.rsvp.eventId);
    const fresh = await tx.ticketOrder.findUnique({where: {id: order.id}, select: {status: true}});
    if (!fresh || fresh.status === 'paid' || fresh.status === 'refunded' || fresh.status === 'refund_due') return {kind: 'already'} as PaidOutcome;
    const refundDue = async (reason: string): Promise<PaidOutcome> => {
      const flagged = await tx.ticketOrder.updateMany({where: {id: order.id, status: {in: ['pending', 'expired']}}, data: {status: 'refund_due'}});
      flaggedForRefund = flagged.count === 1;
      return {kind: 'refund_due', rsvpId: order.rsvpId, reason};
    };
    if (tampered) return refundDue('amount_mismatch');

    // One booking, one payment: a second checkout paid for the same RSVP (two tabs, an old
    // checkout paid late) is money to give back, never a silent second charge.
    const otherPaid = await tx.ticketOrder.count({where: {rsvpId: order.rsvpId, status: 'paid', id: {not: order.id}}});
    if (otherPaid > 0) return refundDue('duplicate_payment');

    const rsvp = await tx.rsvp.findUnique({where: {id: order.rsvpId}, select: {status: true, seats: true, event: {select: {status: true, capacity: true, deletedAt: true}}}});
    if (!rsvp || rsvp.event.deletedAt || rsvp.event.status !== 'published') return refundDue('event_closed');

    const markPaid = () => tx.ticketOrder.updateMany({where: {id: order.id, status: {in: ['pending', 'expired']}}, data: {status: 'paid'}});

    if (rsvp.status === 'awaiting_payment') {
      const flipped = await tx.rsvp.updateMany({where: {id: order.rsvpId, status: 'awaiting_payment'}, data: {status: 'confirmed', confirmedAt: now, claimExpiresAt: null, waitlistPosition: null}});
      await markPaid();
      return flipped.count === 1 ? ({kind: 'confirmed', rsvpId: order.rsvpId} as PaidOutcome) : ({kind: 'already'} as PaidOutcome);
    }
    if (rsvp.status === 'confirmed') {
      await markPaid();
      return {kind: 'already'};
    }
    if (rsvp.status === 'cancelled') {
      // The hold lapsed before the money arrived: take the seats again, under the event's lock, only
      // if they are still free (seats offered to the waitlist under an open claim are not free).
      const [taken, claimed] = await Promise.all([
        seatsTakenOf(tx, order.rsvp.eventId),
        tx.rsvp.aggregate({_sum: {seats: true}, where: {eventId: order.rsvp.eventId, status: 'waitlisted', claimExpiresAt: {gt: now}}}),
      ]);
      const free = seatsRemaining(rsvp.event.capacity, taken + (claimed._sum.seats ?? 0));
      if (rsvp.seats > free) return refundDue('hold_lapsed_no_seats');
      const flipped = await tx.rsvp.updateMany({where: {id: order.rsvpId, status: 'cancelled'}, data: {status: 'confirmed', confirmedAt: now, claimExpiresAt: null, waitlistPosition: null}});
      await markPaid();
      return flipped.count === 1 ? ({kind: 'confirmed', rsvpId: order.rsvpId} as PaidOutcome) : ({kind: 'already'} as PaidOutcome);
    }
    return refundDue(`rsvp_${rsvp.status}`);
  });

  if (outcome.kind === 'confirmed') {
    await queueGuestEmail('confirmation', outcome.rsvpId);
    const paid = await db.rsvp.findUnique({where: {id: outcome.rsvpId}, select: {id: true, eventId: true}}).catch(() => null);
    if (paid) await emitWebhook(null, db, 'order.paid', orderPaidPayload(paid));
  }
  if (outcome.kind === 'refund_due') {
    console.warn(`[tickets] order for checkout ${checkout.id} is refund_due (${outcome.reason}): refund it in the dashboard.`);
    if (flaggedForRefund) {
      await tellOwnerRefundDue({
        checkoutId: checkout.id,
        reason: outcome.reason,
        amountCents: checkout.amountCents,
        currency: checkout.currency,
        eventTitle: order.rsvp.event?.title ?? null,
      });
    }
  }
  return outcome;
}

/**
 * The platform refunded the checkout. A FULL refund closes the order and gives the seat back
 * (RSVP -> cancelled, waitlist promoted), unless another order still pays for that booking (a
 * refunded duplicate payment leaves the guest's ticket alone); a partial one leaves the ticket alone.
 */
export async function refundedTicket(db: PrismaClient, refund: Refund, now = new Date()): Promise<{closed: boolean}> {
  if (!refund.full) return {closed: false};
  const order = await db.ticketOrder.findUnique({where: {checkoutId: refund.checkoutId}, select: {id: true, rsvpId: true, rsvp: {select: {eventId: true}}}});
  if (!order) return {closed: false};
  const result = await db.$transaction(async tx => {
    await lockEvent(tx, order.rsvp.eventId);
    const closed = await tx.ticketOrder.updateMany({where: {id: order.id, status: {in: ['paid', 'refund_due', 'pending', 'expired']}}, data: {status: 'refunded'}});
    if (closed.count !== 1) return {closed: false, freed: false, promoted: [] as Awaited<ReturnType<typeof promoteWaitlist>>};
    const stillPaid = await tx.ticketOrder.count({where: {rsvpId: order.rsvpId, status: 'paid'}});
    if (stillPaid > 0) return {closed: true, freed: false, promoted: [] as Awaited<ReturnType<typeof promoteWaitlist>>};
    const freed = await tx.rsvp.updateMany({where: {id: order.rsvpId, status: {in: ['confirmed', 'awaiting_payment']}}, data: {status: 'cancelled', claimExpiresAt: null}});
    const promoted = freed.count === 1 ? await promoteWaitlist(tx, order.rsvp.eventId, now) : [];
    return {closed: true, freed: freed.count === 1, promoted};
  });
  if (result.closed) {
    if (result.freed) await emitCancelledIds(db, order.rsvp.eventId, [order.rsvpId]);
    await emitSeated(db, order.rsvp.eventId, result.promoted);
  }
  if (result.promoted.length > 0) {
    await notifyPromoted(result.promoted.map(p => ({rsvpId: p.rsvpId, kind: p.kind, ...(p.kind === 'offer_claim' ? {claimExpiresAt: p.claimExpiresAt} : {})}))).catch(() => undefined);
  }
  return {closed: result.closed};
}

/**
 * An event was cancelled: every paid ticket becomes `refund_due` (database only, fast, and
 * conditional on `paid`, so a repeat changes nothing). The owner cancelled it, so no email: they
 * refund them from the dashboard; `payment.refunded` then marks them `refunded`.
 * Called by the event-cancel route (whoever owns it). Returns how many orders need a refund.
 */
export async function markEventOrdersRefundDue(db: PrismaClient, eventId: string): Promise<number> {
  const done = await db.ticketOrder.updateMany({where: {status: 'paid', rsvp: {eventId}}, data: {status: 'refund_due'}});
  return done.count;
}
