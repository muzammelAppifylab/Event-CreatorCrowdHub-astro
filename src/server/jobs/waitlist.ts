import {seatsRemaining} from '../../domain/capacity';
import {
  expireClaims,
  planPromotions,
  renumberWaitlist,
  type Promotion,
  type WaitlistEntry,
} from '../../domain/waitlist';
import type {PrismaClient} from '../../generated/prisma/client';
import {lockEvent, seatsTakenOf, type Db} from './shared';

/** Waitlist rows are read this many at a time per event (a bounded read, never a whole table). */
export const WAITLIST_LIMIT = 1000;

const waitlistOf = async (tx: Db, eventId: string): Promise<WaitlistEntry[]> =>
  tx.rsvp.findMany({
    where: {eventId, status: 'waitlisted', response: 'going'},
    select: {id: true, seats: true, waitlistPosition: true, createdAt: true, claimExpiresAt: true},
    orderBy: [{waitlistPosition: 'asc'}, {createdAt: 'asc'}, {id: 'asc'}],
    take: WAITLIST_LIMIT,
  });

/** A paid event offers freed seats as claim links; a free one confirms the next guests outright. */
const eventKindOf = async (tx: Db, eventId: string): Promise<'free' | 'paid'> =>
  (await tx.ticketType.count({where: {eventId, priceCents: {gt: 0}}})) > 0 ? 'paid' : 'free';

/** Writes promotions (already decided by the pure planner). Conditional on still waitlisted. */
async function applyPromotions(tx: Db, promotions: Promotion[], now: Date): Promise<Promotion[]> {
  const applied: Promotion[] = [];
  for (const p of promotions) {
    const result = await tx.rsvp.updateMany({
      where: {id: p.rsvpId, status: 'waitlisted'},
      data:
        p.kind === 'confirm'
          ? {status: 'confirmed', confirmedAt: now, waitlistPosition: null, claimExpiresAt: null}
          : {claimExpiresAt: p.claimExpiresAt},
    });
    if (result.count === 1) applied.push(p);
  }
  return applied;
}

async function renumber(tx: Db, eventId: string): Promise<void> {
  const left = await waitlistOf(tx, eventId);
  for (const change of renumberWaitlist(left)) {
    await tx.rsvp.update({where: {id: change.id}, data: {waitlistPosition: change.waitlistPosition}});
  }
}

/**
 * Seats were freed (a released hold, a refund, a cancellation): give them to the waitlist.
 * Call INSIDE a transaction that already locked the event (`lockEvent`). Returns the promotions
 * so the caller can email them after the commit.
 */
export async function promoteWaitlist(tx: Db, eventId: string, now: Date): Promise<Promotion[]> {
  const event = await tx.event.findUnique({where: {id: eventId}, select: {capacity: true, status: true}});
  if (!event || event.status !== 'published') return [];
  const [entries, taken, kind] = await Promise.all([waitlistOf(tx, eventId), seatsTakenOf(tx, eventId), eventKindOf(tx, eventId)]);
  if (entries.length === 0) return [];
  const plan = planPromotions({entries, seatsAvailable: seatsRemaining(event.capacity, taken), kind, now});
  const applied = await applyPromotions(tx, plan.promotions, now);
  if (applied.some(p => p.kind === 'confirm')) await renumber(tx, eventId);
  return applied;
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
  return db.$transaction(async tx => {
    await lockEvent(tx, eventId);
    const event = await tx.event.findUnique({where: {id: eventId}, select: {capacity: true, status: true}});
    if (!event) return {lapsed: 0, offers: []};
    const [entries, taken] = await Promise.all([waitlistOf(tx, eventId), seatsTakenOf(tx, eventId)]);
    // A cancelled event releases claims without offering the seats to anyone.
    const available = event.status === 'published' ? seatsRemaining(event.capacity, taken) : 0;
    const result = expireClaims(entries, now, available);
    if (result.lapsed.length > 0) {
      await tx.rsvp.updateMany({
        where: {id: {in: result.lapsed}, status: 'waitlisted', claimExpiresAt: {lte: now}},
        data: {status: 'cancelled', claimExpiresAt: null, waitlistPosition: null},
      });
    }
    const offered = await applyPromotions(tx, result.offers, now);
    await renumber(tx, eventId);
    return {
      lapsed: result.lapsed.length,
      offers: offered.flatMap(p => (p.kind === 'offer_claim' ? [{rsvpId: p.rsvpId, claimExpiresAt: p.claimExpiresAt}] : [])),
    };
  });
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
