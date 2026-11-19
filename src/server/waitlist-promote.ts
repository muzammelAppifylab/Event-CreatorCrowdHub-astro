import {seatsRemaining} from '../domain/capacity';
import {planPromotions, type EventKind, type Promotion, type PromotionRefusal, type WaitlistEntry} from '../domain/waitlist';
import type {Db} from './jobs/shared';

/**
 * THE waitlist promotion (US-4), shared by every path that frees or adds seats: a guest's cancel or
 * edit, a released checkout hold, a refund, a capacity raise, a host's "promote", claim expiry.
 * The decision is the pure planner in `src/domain/waitlist.ts`; this module only reads its inputs and
 * writes its result, set-based (one statement per kind of change, never one per row), so a waitlist of
 * thousands fits easily inside the transaction's time limit.
 *
 * Every function here must run INSIDE a transaction that already holds the event row's lock
 * (`lockEvent`), so seat counts and writes can't interleave with another decision.
 */

/** Waitlist rows read per automatic promotion (a bounded read; promotion stops when seats run out anyway). */
export const WAITLIST_LIMIT = 1000;
/** A host's picks may sit far back in the line: read further for them. */
export const HOST_PICK_LIMIT = 5000;

const HELD = ['confirmed', 'awaiting_payment'] as const;

export interface WaitlistRow extends WaitlistEntry {
  ticketTypeId: string | null;
}

/** The line, first in line first (`orderWaitlist`'s order), bounded. */
export function loadWaitlist(tx: Db, eventId: string, take = WAITLIST_LIMIT): Promise<WaitlistRow[]> {
  return tx.rsvp.findMany({
    where: {eventId, status: 'waitlisted', response: 'going'},
    select: {id: true, seats: true, waitlistPosition: true, createdAt: true, claimExpiresAt: true, ticketTypeId: true},
    orderBy: [{waitlistPosition: 'asc'}, {createdAt: 'asc'}, {id: 'asc'}],
    take,
  });
}

/**
 * Closes the gaps in the waitlist in ONE statement: positions 1..n in `orderWaitlist`'s order
 * (position, nulls last, then created, then id). Only rows whose position changes are written.
 */
export async function renumberWaitlist(tx: Db, eventId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE rsvps r SET waitlist_position = s.pos, updated_at = now()
    FROM (
      SELECT id, row_number() OVER (ORDER BY waitlist_position ASC NULLS LAST, created_at ASC, id ASC)::int AS pos
      FROM rsvps WHERE event_id = ${eventId}::uuid AND status = 'waitlisted'
    ) s
    WHERE r.id = s.id AND r.waitlist_position IS DISTINCT FROM s.pos`;
}

export interface SeatSnapshot {
  /** Seats held by going guests who are confirmed or paying. */
  taken: number;
  kind: EventKind;
  /** Seats still for sale per LIMITED ticket type (quantity minus held seats); unlimited types are absent. */
  ticketsLeft: Map<string, number>;
}

/** Seats taken, the event's kind and each limited ticket's remaining quantity: 2 reads (3 with a limited ticket). */
export async function seatSnapshot(tx: Db, eventId: string): Promise<SeatSnapshot> {
  const [types, sum] = await Promise.all([
    tx.ticketType.findMany({where: {eventId}, select: {id: true, quantity: true, priceCents: true}, take: 100}),
    tx.rsvp.aggregate({_sum: {seats: true}, where: {eventId, response: 'going', status: {in: [...HELD]}}}),
  ]);
  const limited = types.filter(t => t.quantity !== null && t.quantity !== undefined);
  const ticketsLeft = new Map<string, number>();
  if (limited.length > 0) {
    const held = await tx.rsvp.groupBy({
      by: ['ticketTypeId'],
      where: {eventId, response: 'going', status: {in: [...HELD]}, ticketTypeId: {in: limited.map(t => t.id)}},
      _sum: {seats: true},
    });
    const byType = new Map(held.map(h => [h.ticketTypeId, h._sum.seats ?? 0]));
    for (const t of limited) ticketsLeft.set(t.id, Math.max(0, t.quantity! - (byType.get(t.id) ?? 0)));
  }
  return {
    taken: sum._sum.seats ?? 0,
    kind: types.some(t => t.priceCents > 0) ? 'paid' : 'free',
    ticketsLeft,
  };
}

/**
 * Writes promotions decided by the planner: one conditional statement for the confirmations and one
 * for the claim offers (every offer of one run shares its deadline). Under the event lock the rows
 * read a moment ago are still waitlisted, so every planned promotion lands.
 */
export async function applyPromotions(tx: Db, eventId: string, promotions: Promotion[], now: Date): Promise<void> {
  const confirm = promotions.filter(p => p.kind === 'confirm').map(p => p.rsvpId);
  const offers = promotions.filter((p): p is Extract<Promotion, {kind: 'offer_claim'}> => p.kind === 'offer_claim');
  if (confirm.length > 0) {
    await tx.rsvp.updateMany({
      where: {id: {in: confirm}, eventId, status: 'waitlisted'},
      data: {status: 'confirmed', confirmedAt: now, waitlistPosition: null, claimExpiresAt: null},
    });
  }
  // Grouped by deadline (one group in practice).
  const byDeadline = new Map<number, string[]>();
  for (const o of offers) byDeadline.set(o.claimExpiresAt.getTime(), [...(byDeadline.get(o.claimExpiresAt.getTime()) ?? []), o.rsvpId]);
  for (const [at, ids] of byDeadline) {
    await tx.rsvp.updateMany({where: {id: {in: ids}, eventId, status: 'waitlisted'}, data: {claimExpiresAt: new Date(at)}});
  }
}

/** Whether the event has any waitlisted row (any response): one indexed EXISTS-style probe. */
export async function hasWaitlisted(tx: Db, eventId: string): Promise<boolean> {
  const row = await tx.rsvp.findFirst({where: {eventId, status: 'waitlisted'}, select: {id: true}});
  return row !== null;
}

export interface PromoteResult {
  promotions: Promotion[];
  /** Host picks (`only`) that could not be promoted, and why. */
  failed: Array<{rsvpId: string; reason: PromotionRefusal}>;
}

/**
 * Hands free seats to the waitlist, first in line first, and closes position gaps. Free events
 * confirm; paid events offer a claim (a seat without payment would be a free ticket). Seats and
 * ticket quantity under outstanding claims stay held. `only` limits it to the host's picks.
 * The caller decides whether the event may promote at all (published, not over) and has locked it.
 */
export async function promoteWaitlist(
  tx: Db,
  event: {id: string; capacity: number | null},
  now: Date,
  options: {only?: ReadonlySet<string>} = {}
): Promise<PromoteResult> {
  const {only} = options;
  // Nobody waitlisted (so no open claims and no gaps to close): one probe on rsvps_event_status_idx
  // instead of the seat reads and the renumber. A host's picks still go to the planner, which says why each failed.
  if (!only && !(await hasWaitlisted(tx, event.id))) return {promotions: [], failed: []};
  const snapshot = await seatSnapshot(tx, event.id);
  const seatsAvailable = seatsRemaining(event.capacity, snapshot.taken);
  let result: PromoteResult = {promotions: [], failed: []};
  // Nothing free and nobody picked: no need to read the line, only to close its gaps.
  if (seatsAvailable > 0 || only) {
    const entries = await loadWaitlist(tx, event.id, only ? HOST_PICK_LIMIT : WAITLIST_LIMIT);
    if (entries.length > 0 || only) {
      const plan = planPromotions({entries, seatsAvailable, kind: snapshot.kind, now, ticketsLeft: snapshot.ticketsLeft, only});
      await applyPromotions(tx, event.id, plan.promotions, now);
      result = {promotions: plan.promotions, failed: plan.failed};
    }
  }
  await renumberWaitlist(tx, event.id);
  return result;
}
