import {appConfig} from '../../config/app.config';
import {addMinutes} from '../../domain/time';
import type {PrismaClient} from '../../generated/prisma/client';
import {queueGuestEmail} from './guest-emails';
import {lockEvent} from './shared';
import {promoteWaitlist} from './waitlist';

export const HOLD_SWEEP_LIMIT = 200;

export interface ReleaseResult {
  released: boolean;
  /** Waitlist guests promoted by the freed seats, to email after the commit. */
  promoted: Array<{rsvpId: string; kind: 'confirm' | 'offer_claim'; claimExpiresAt?: Date}>;
}

/**
 * Releases ONE awaiting_payment hold: RSVP -> cancelled, its pending ticket order -> expired,
 * the freed seats go to the waitlist. Conditional (`status = awaiting_payment`), so the sweep, a
 * `checkout.failed` event and a retry can all call it: only the first one releases.
 * Emails (hold expired, the promoted guests) are queued AFTER the commit.
 */
export async function releaseHold(db: PrismaClient, rsvpId: string, now = new Date()): Promise<ReleaseResult> {
  const found = await db.rsvp.findUnique({where: {id: rsvpId}, select: {eventId: true}});
  if (!found) return {released: false, promoted: []};
  const outcome = await db.$transaction(async tx => {
    await lockEvent(tx, found.eventId);
    const flipped = await tx.rsvp.updateMany({
      where: {id: rsvpId, status: 'awaiting_payment'},
      data: {status: 'cancelled', claimExpiresAt: null, waitlistPosition: null},
    });
    if (flipped.count !== 1) return {released: false, promoted: []} as ReleaseResult;
    await tx.ticketOrder.updateMany({where: {rsvpId, status: 'pending'}, data: {status: 'expired'}});
    const promotions = await promoteWaitlist(tx, found.eventId, now);
    return {
      released: true,
      promoted: promotions.map(p => ({rsvpId: p.rsvpId, kind: p.kind, ...(p.kind === 'offer_claim' ? {claimExpiresAt: p.claimExpiresAt} : {})})),
    } as ReleaseResult;
  });
  if (outcome.released) await notifyAfterRelease(rsvpId, outcome.promoted);
  return outcome;
}

export async function notifyAfterRelease(rsvpId: string, promoted: ReleaseResult['promoted']): Promise<void> {
  await queueGuestEmail('hold_expired', rsvpId);
  await notifyPromoted(promoted);
}

/** Emails for waitlist guests a freed seat reached (confirmed outright, or offered a claim). */
export async function notifyPromoted(promoted: ReleaseResult['promoted']): Promise<void> {
  for (const p of promoted) {
    if (p.kind === 'confirm') await queueGuestEmail('confirmation', p.rsvpId);
    else await queueGuestEmail('waitlist_offer', p.rsvpId, String(p.claimExpiresAt?.getTime() ?? ''));
  }
}

/**
 * The ONE sweep for holds that lapsed (docs/porting/payments-jobs.md). A hold lapses
 * `checkoutHoldMinutes` after its pending ticket order was created (the platform checkout's
 * start), else after the RSVP row last changed when no order exists. Bounded per run.
 */
export async function expireCheckoutHolds(db: PrismaClient, now: Date, limit = HOLD_SWEEP_LIMIT): Promise<{released: string[]}> {
  const cutoff = addMinutes(now, -appConfig.checkoutHoldMinutes);
  const [orders, orphans] = await Promise.all([
    db.ticketOrder.findMany({
      where: {status: 'pending', createdAt: {lte: cutoff}, rsvp: {status: 'awaiting_payment'}},
      select: {rsvpId: true},
      orderBy: {createdAt: 'asc'},
      take: limit,
    }),
    // A hold with no pending order (the checkout never started): by the RSVP's own age.
    db.rsvp.findMany({
      where: {status: 'awaiting_payment', updatedAt: {lte: cutoff}, ticketOrders: {none: {status: 'pending'}}},
      select: {id: true},
      orderBy: {updatedAt: 'asc'},
      take: limit,
    }),
  ]);
  const ids = [...new Set([...orders.map(o => o.rsvpId), ...orphans.map(o => o.id)])].slice(0, limit);
  const released: string[] = [];
  for (const id of ids) {
    const result = await releaseHold(db, id, now);
    if (result.released) released.push(id);
  }
  return {released};
}
