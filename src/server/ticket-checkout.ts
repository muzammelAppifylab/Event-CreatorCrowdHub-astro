import {seatsRemaining} from '../domain/capacity';
import type {PrismaClient} from '../generated/prisma/client';
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
 */

/** Where the buyer is sent after paying / backing out (paths on this site; the platform adds `checkout=<id>`). */
const THANKS_PATH = '/thanks/';
const CHECKOUT_PAGE = '/checkout/';

/** `tkt-<24 hex of the ticket type id>-<cents>-<currency>`: a valid catalogue key (a-z0-9-, under 64). */
export function ticketPriceKey(ticket: {id: string; priceCents: number; currency: string}): string {
  return `tkt-${ticket.id.replace(/-/g, '').toLowerCase().slice(0, 24)}-${ticket.priceCents}-${ticket.currency.toLowerCase()}`;
}

export type StartTicketCheckout =
  | {ok: true; checkoutId: string; redirectUrl: string; embedded: EmbeddedCheckout | null; reused: boolean}
  | {ok: false; status: 404 | 409 | 422 | 502 | 503; code: string; message: string};

const refuse = (status: 404 | 409 | 422 | 502 | 503, code: string, message: string): StartTicketCheckout => ({ok: false, status, code, message});

/** A same-site path that carries no secret; anything else (or a `/r/` manage link) is dropped. */
const safeCancelPath = (path: string | undefined): string | undefined =>
  path && /^\/(?!\/)[\w\-./]*$/.test(path) && !path.startsWith('/r/') ? path : undefined;

const checkoutPage = (id: string) => `${CHECKOUT_PAGE}?id=${encodeURIComponent(id)}`;

/**
 * Starts (or resumes) the platform checkout for a paid RSVP that is `awaiting_payment`.
 * Safe to call again: while a pending order's checkout is still open, it is returned as is.
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

  // Resume: one pending order per RSVP. An open checkout is reused; a closed one is retired.
  const pending = await db.ticketOrder.findFirst({where: {rsvpId, status: 'pending'}, select: {id: true, checkoutId: true}, orderBy: {createdAt: 'desc'}});
  if (pending) {
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
  const price = await findPrice(requestUrl, key);
  if (!price.ok) return refuse(price.status === 0 ? 503 : 502, price.code.toLowerCase(), price.message);
  if (!price.data) {
    // Creating a price works from the editor/Preview only (E_PAYMENTS_EDITOR_ONLY on the live site).
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

  const started = await createCheckout(requestUrl, {
    price: key,
    quantity: rsvp.seats,
    email: rsvp.email,
    name: rsvp.name,
    successPath: options.successPath ?? THANKS_PATH,
    // Never a path with the guest's manage token (`/r/<token>/`): this URL is sent to the payment platform.
    cancelPath: safeCancelPath(options.cancelPath) ?? `/events/${rsvp.event.slug}/`,
    metadata: {rsvpId: rsvp.id, ticketTypeId: ticket.id, eventId: rsvp.eventId},
  });
  if (!started.ok) {
    const status = started.status === 404 ? 503 : started.status === 422 ? 422 : started.status === 0 ? 503 : 502;
    return refuse(status, started.code.toLowerCase(), started.message);
  }

  try {
    await db.ticketOrder.create({
      data: {rsvpId: rsvp.id, checkoutId: started.data.id, amountCents: ticket.priceCents * rsvp.seats, currency: ticket.currency.toUpperCase(), seats: rsvp.seats, status: 'pending'},
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return {ok: true, checkoutId: started.data.id, redirectUrl: checkoutPage(started.data.id), embedded: started.data.embedded ?? null, reused: false};
}

export type PaidOutcome =
  | {kind: 'not_ours'}
  | {kind: 'already'}
  | {kind: 'confirmed'; rsvpId: string}
  | {kind: 'refund_due'; rsvpId: string; reason: string};

/**
 * A paid platform checkout: confirm the RSVP (-> confirmed, order -> paid) and queue the
 * confirmation email. IDEMPOTENT (events and the thanks page's confirm both call it): every
 * write is conditional on the current status, the email is only queued by the call that flipped it.
 * A payment that cannot be honoured (the hold lapsed and the seats went, the event was
 * cancelled, the amount is not the order's) marks the order `refund_due`: the owner refunds it
 * in the dashboard and the `payment.refunded` event closes it (`refundedTicket`).
 */
export async function confirmPaidTicket(db: PrismaClient, checkout: Checkout, now = new Date()): Promise<PaidOutcome> {
  const order = await db.ticketOrder.findUnique({
    where: {checkoutId: checkout.id},
    select: {id: true, rsvpId: true, status: true, amountCents: true, currency: true, seats: true, rsvp: {select: {eventId: true}}},
  });
  if (!order) return {kind: 'not_ours'};
  if (order.status === 'paid' || order.status === 'refunded' || order.status === 'refund_due') return {kind: 'already'};

  const tampered =
    checkout.amountCents !== order.amountCents ||
    checkout.currency.toUpperCase() !== order.currency.toUpperCase() ||
    (checkout.metadata?.rsvpId !== undefined && checkout.metadata.rsvpId !== order.rsvpId);

  const outcome = await db.$transaction(async (tx): Promise<PaidOutcome> => {
    await lockEvent(tx, order.rsvp.eventId);
    const fresh = await tx.ticketOrder.findUnique({where: {id: order.id}, select: {status: true}});
    if (!fresh || fresh.status === 'paid' || fresh.status === 'refunded' || fresh.status === 'refund_due') return {kind: 'already'} as PaidOutcome;
    const refundDue = async (reason: string): Promise<PaidOutcome> => {
      await tx.ticketOrder.updateMany({where: {id: order.id, status: {in: ['pending', 'expired']}}, data: {status: 'refund_due'}});
      return {kind: 'refund_due', rsvpId: order.rsvpId, reason};
    };
    if (tampered) return refundDue('amount_mismatch');

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
      // The hold lapsed before the money arrived: seat the guest again only if the seats are still free
      // (seats offered to the waitlist under an open claim are not free).
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
    if (paid) emitWebhook(null, db, 'order.paid', orderPaidPayload(paid));
  }
  if (outcome.kind === 'refund_due') console.warn(`[tickets] order for checkout ${checkout.id} is refund_due (${outcome.reason}): refund it in the dashboard.`);
  return outcome;
}

/**
 * The platform refunded the checkout. A FULL refund closes the order and gives the seat back
 * (RSVP -> cancelled, waitlist promoted); a partial one leaves the ticket alone.
 */
export async function refundedTicket(db: PrismaClient, refund: Refund, now = new Date()): Promise<{closed: boolean}> {
  if (!refund.full) return {closed: false};
  const order = await db.ticketOrder.findUnique({where: {checkoutId: refund.checkoutId}, select: {id: true, rsvpId: true, rsvp: {select: {eventId: true}}}});
  if (!order) return {closed: false};
  const result = await db.$transaction(async tx => {
    await lockEvent(tx, order.rsvp.eventId);
    const closed = await tx.ticketOrder.updateMany({where: {id: order.id, status: {in: ['paid', 'refund_due', 'pending', 'expired']}}, data: {status: 'refunded'}});
    if (closed.count !== 1) return {closed: false, freed: false, promoted: [] as Awaited<ReturnType<typeof promoteWaitlist>>};
    const freed = await tx.rsvp.updateMany({where: {id: order.rsvpId, status: {in: ['confirmed', 'awaiting_payment']}}, data: {status: 'cancelled', claimExpiresAt: null}});
    const promoted = freed.count === 1 ? await promoteWaitlist(tx, order.rsvp.eventId, now) : [];
    return {closed: true, freed: freed.count === 1, promoted};
  });
  if (result.closed) {
    if (result.freed) emitCancelledIds(db, order.rsvp.eventId, [order.rsvpId]);
    emitSeated(db, order.rsvp.eventId, result.promoted);
  }
  if (result.promoted.length > 0) {
    await notifyPromoted(result.promoted.map(p => ({rsvpId: p.rsvpId, kind: p.kind, ...(p.kind === 'offer_claim' ? {claimExpiresAt: p.claimExpiresAt} : {})}))).catch(() => undefined);
  }
  return {closed: result.closed};
}

/**
 * An event was cancelled: every paid ticket becomes `refund_due` (database only, fast). The
 * owner refunds them from the dashboard; `payment.refunded` then marks them `refunded`.
 * Called by the event-cancel route (whoever owns it). Returns how many orders need a refund.
 */
export async function markEventOrdersRefundDue(db: PrismaClient, eventId: string): Promise<number> {
  const done = await db.ticketOrder.updateMany({where: {status: 'paid', rsvp: {eventId}}, data: {status: 'refund_due'}});
  return done.count;
}
