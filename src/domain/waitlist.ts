/**
 * Waitlist promotion rules (PRD US-4, US-3, §13 scheduler). Pure functions:
 * the server calls them inside the same transaction that locks the event row
 * (like `decideSeat`), then writes the returned status changes.
 *
 * - Free events: freed seats confirm waitlisted guests straight away.
 * - Paid events: guests are offered a claim link that holds the seats until
 *   `claimExpiresAt` (24h by default). Lapsed claims are dropped and the next
 *   guest is offered the seats.
 *
 * Order is FIFO: `waitlistPosition`, then `createdAt`, then `id` so the result
 * is deterministic even with equal timestamps.
 *
 * A party that does not fit the free seats is skipped and the scan continues
 * (a party of 3 at the head does not block a solo guest behind it when only one
 * seat frees up). The skipped party keeps its position, so it is first in
 * line the next time enough seats free up. We chose this over strict
 * head-of-line blocking because an empty seat at a sold-out event is the worst
 * outcome for the creator, and the head party loses nothing it could have used.
 */
import { appConfig } from "../config/app.config"
import { addMinutes } from "./time"

export interface WaitlistEntry {
  id: string
  seats: number
  waitlistPosition: number | null
  createdAt: Date
  /** Paid events only: set while a claim offer is outstanding. */
  claimExpiresAt?: Date | null
}

export type EventKind = "free" | "paid"

export type Promotion =
  | { kind: "confirm"; rsvpId: string; seats: number }
  | { kind: "offer_claim"; rsvpId: string; seats: number; claimExpiresAt: Date }

export interface PromotionInput {
  entries: WaitlistEntry[]
  /**
   * Seats not held by confirmed or awaiting_payment RSVPs
   * (`seatsRemaining()` from capacity.ts). Infinity for unlimited events.
   * Seats held by outstanding claim offers are subtracted here, not by the caller.
   */
  seatsAvailable: number
  kind: EventKind
  now: Date
  claimMinutes?: number
}

export interface PromotionPlan {
  promotions: Promotion[]
  /** Seats still free after the promotions (and outstanding claims). */
  seatsLeft: number
}

export function orderWaitlist<T extends WaitlistEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const pa = a.waitlistPosition ?? Number.POSITIVE_INFINITY
    const pb = b.waitlistPosition ?? Number.POSITIVE_INFINITY
    if (pa !== pb) return pa - pb
    const ca = a.createdAt.getTime()
    const cb = b.createdAt.getTime()
    if (ca !== cb) return ca - cb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export function hasActiveClaim(entry: WaitlistEntry, now: Date): boolean {
  return entry.claimExpiresAt != null && entry.claimExpiresAt > now
}

export function planPromotions(input: PromotionInput): PromotionPlan {
  const { kind, now } = input
  const claimMinutes = input.claimMinutes ?? appConfig.waitlistClaimMinutes
  const ordered = orderWaitlist(input.entries)

  // Outstanding offers already hold their seats; lapsed ones are expireClaims()'s job.
  const held = ordered.filter((e) => hasActiveClaim(e, now)).reduce((sum, e) => sum + e.seats, 0)
  let seatsLeft = Math.max(0, input.seatsAvailable - held)

  const promotions: Promotion[] = []
  for (const entry of ordered) {
    if (seatsLeft <= 0) break
    if (entry.claimExpiresAt != null) continue // offered already (active or lapsed)
    if (entry.seats > seatsLeft) continue // doesn't fit: keep scanning (see header)
    seatsLeft -= entry.seats
    promotions.push(
      kind === "free"
        ? { kind: "confirm", rsvpId: entry.id, seats: entry.seats }
        : { kind: "offer_claim", rsvpId: entry.id, seats: entry.seats, claimExpiresAt: addMinutes(now, claimMinutes) },
    )
  }
  return { promotions, seatsLeft }
}

export interface ClaimExpiryResult {
  /** RSVP ids whose claim lapsed: drop them from the waitlist (status cancelled). */
  lapsed: string[]
  /** Next guests to offer the released seats to. */
  offers: Promotion[]
  seatsLeft: number
}

/**
 * Paid events (US-4): a claim not used by `claimExpiresAt` lapses and the
 * seats go to the next guest. Run by the scheduler every 5 minutes.
 * `seatsAvailable` has the same meaning as in `planPromotions`.
 */
export function expireClaims(
  entries: WaitlistEntry[],
  now: Date,
  seatsAvailable: number,
  claimMinutes: number = appConfig.waitlistClaimMinutes,
): ClaimExpiryResult {
  const isLapsed = (e: WaitlistEntry) => e.claimExpiresAt != null && e.claimExpiresAt <= now
  const lapsed = orderWaitlist(entries.filter(isLapsed)).map((e) => e.id)
  const remaining = entries.filter((e) => !isLapsed(e))
  const { promotions, seatsLeft } = planPromotions({ entries: remaining, seatsAvailable, kind: "paid", now, claimMinutes })
  return { lapsed, offers: promotions, seatsLeft }
}

/**
 * Close gaps after promotions or cancellations: positions become 1..n in
 * FIFO order. Returns only the entries whose position changes, so the caller
 * writes the minimum number of rows.
 */
export function renumberWaitlist(entries: WaitlistEntry[]): Array<{ id: string; waitlistPosition: number }> {
  return orderWaitlist(entries)
    .map((e, i) => ({ id: e.id, waitlistPosition: i + 1, before: e.waitlistPosition }))
    .filter((e) => e.before !== e.waitlistPosition)
    .map(({ id, waitlistPosition }) => ({ id, waitlistPosition }))
}

/** Position for a guest joining the back of the line. */
export function nextWaitlistPosition(entries: WaitlistEntry[]): number {
  return entries.reduce((max, e) => Math.max(max, e.waitlistPosition ?? 0), 0) + 1
}
