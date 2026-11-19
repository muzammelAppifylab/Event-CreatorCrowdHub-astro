import {seatsRemaining} from '../../domain/capacity';
import {expireClaims, type Promotion} from '../../domain/waitlist';
import type {PrismaClient} from '../../generated/prisma/client';
import {
  applyPromotions,
  loadWaitlist,
  promoteWaitlist as promoteFromWaitlist,
  renumberWaitlist,
  seatSnapshot,
  WAITLIST_LIMIT as LIMIT,
} from '../waitlist-promote';
import {emitCancelledIds} from '../webhook-emit';
import {lockEvent, type Db} from './shared';

/** Waitlist rows are read this many at a time per event (a bounded read, never a whole table). */
export const WAITLIST_LIMIT = LIMIT;

/**
 * Seats were freed (a released hold, a refund, a cancellation): give them to the waitlist.
 * Call INSIDE a transaction that already locked the event (`lockEvent`). Returns the promotions
 * so the caller can email them after the commit. A thin wrapper over the shared
 * `promoteWaitlist` in `src/server/waitlist-promote.ts` (set-based writes, ticket limits respected).
 */
export async function promoteWaitlist(tx: Db, eventId: string, now: Date): Promise<Promotion[]> {
  const event = await tx.event.findUnique({where: {id: eventId}, select: {capacity: true, status: true}});
  if (!event || event.status !== 'published') return [];
  return (await promoteFromWaitlist(tx, {id: eventId, capacity: event.capacity}, now)).promotions;
}

export interface ClaimRun {
  lapsed: number;
  offers: Array<{rsvpId: string; claimExpiresAt: Date}>;
}

/**
 * Paid events: a claim not used by `claimExpiresAt` lapses (the guest is dropped from the
 * waitlist) and the freed seats are offered to the next guests. One transaction per event,
 * under the event lock. Idempotent: a second run finds nothing lapsed.
 */
export async function expireEventClaims(db: PrismaClient, eventId: string, now: Date): Promise<ClaimRun> {
  const lapsedIds: string[] = [];
  const run = await db.$transaction(async tx => {
    lapsedIds.length = 0;
    await lockEvent(tx, eventId);
    const event = await tx.event.findUnique({where: {id: eventId}, select: {capacity: true, status: true}});
    if (!event) return {lapsed: 0, offers: []};
    const [entries, snapshot] = await Promise.all([loadWaitlist(tx, eventId), seatSnapshot(tx, eventId)]);
    // A cancelled event releases claims without offering the seats to anyone.
    const available = event.status === 'published' ? seatsRemaining(event.capacity, snapshot.taken) : 0;
    const result = expireClaims(entries, now, available, undefined, snapshot.ticketsLeft);
    if (result.lapsed.length > 0) {
      lapsedIds.push(...result.lapsed);
      // One conditional statement, by the event (not a list of ids sent back to the database):
      // only rows still waitlisted with a claim past due are dropped.
      await tx.rsvp.updateMany({
        where: {eventId, status: 'waitlisted', response: 'going', claimExpiresAt: {lte: now}},
        data: {status: 'cancelled', claimExpiresAt: null, waitlistPosition: null},
      });
    }
    await applyPromotions(tx, eventId, result.offers, now);
    await renumberWaitlist(tx, eventId);
    return {
      lapsed: result.lapsed.length,
      offers: result.offers.flatMap(p => (p.kind === 'offer_claim' ? [{rsvpId: p.rsvpId, claimExpiresAt: p.claimExpiresAt}] : [])),
    };
  });
  await emitCancelledIds(db, eventId, lapsedIds);
  return run;
}

/** Events with a waitlisted guest whose claim lapsed. Bounded; the rest is due again next run. */
export async function eventsWithLapsedClaims(db: Db, now: Date, take = 50): Promise<string[]> {
  const rows = await db.rsvp.findMany({
    where: {status: 'waitlisted', claimExpiresAt: {lte: now}},
    select: {eventId: true},
    distinct: ['eventId'],
    take,
  });
  return rows.map(r => r.eventId);
}
