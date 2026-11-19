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
  /** The ticket type the guest asked for; a limited one caps how many of its seats can be handed out. */
  ticketTypeId?: string | null
}

/** Why a guest the host picked could not be promoted. */
export type PromotionRefusal = "not_waitlisted" | "claim_pending" | "event_full" | "ticket_sold_out"

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
  /**
   * Seats still for sale per LIMITED ticket type (its quantity minus the seats confirmed or awaiting
   * payment on it). A type missing from the map is unlimited. Outstanding claims on a type are
   * subtracted here, like `seatsAvailable`.
   */
  ticketsLeft?: ReadonlyMap<string, number>
  /**
   * The host picked these guests: only they are considered, a lapsed claim may be offered again, and
   * every pick that can't be promoted is reported in `failed`. Without it, every guest who fits is
   * promoted, first in line first.
   */
  only?: ReadonlySet<string>
}

export interface PromotionPlan {
  promotions: Promotion[]
  /** Seats still free after the promotions (and outstanding claims). */
  seatsLeft: number
  /** `only` mode: the picks that could not be promoted, and why. */
  failed: Array<{ rsvpId: string; reason: PromotionRefusal }>
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
  const only = input.only
  const failed: PromotionPlan["failed"] = []
  if (only) {
    const present = new Set(ordered.map((e) => e.id))
    for (const id of only) if (!present.has(id)) failed.push({ rsvpId: id, reason: "not_waitlisted" })
  }

  // Outstanding offers already hold their seats (and their ticket's); lapsed ones are expireClaims()'s job.
  const ticketsLeft = new Map(input.ticketsLeft ?? [])
  const takeTicket = (entry: WaitlistEntry, seats: number) => {
    const id = entry.ticketTypeId
    if (id && ticketsLeft.has(id)) ticketsLeft.set(id, ticketsLeft.get(id)! - seats)
  }
  const ticketRoom = (entry: WaitlistEntry) =>
    entry.ticketTypeId && ticketsLeft.has(entry.ticketTypeId) ? ticketsLeft.get(entry.ticketTypeId)! : Number.POSITIVE_INFINITY
  let held = 0
  for (const e of ordered) {
    if (!hasActiveClaim(e, now)) continue
    held += e.seats
    takeTicket(e, e.seats)
  }
  let seatsLeft = input.seatsAvailable - held

  const promotions: Promotion[] = []
  for (const entry of ordered) {
    if (only) {
      if (!only.has(entry.id)) continue
    } else {
      if (seatsLeft <= 0) break
      if (entry.claimExpiresAt != null) continue // offered already (active or lapsed)
    }
    // A host pick with its own live claim: on a paid event the claim decides; otherwise its held seats count for it.
    const ownHold = hasActiveClaim(entry, now) ? entry.seats : 0
    if (ownHold > 0 && kind === "paid") {
      failed.push({ rsvpId: entry.id, reason: "claim_pending" })
      continue
    }
    if (entry.seats > seatsLeft + ownHold) {
      if (only) failed.push({ rsvpId: entry.id, reason: "event_full" })
      continue // doesn't fit: keep scanning (see header)
    }
    if (entry.seats > ticketRoom(entry) + ownHold) {
      if (only) failed.push({ rsvpId: entry.id, reason: "ticket_sold_out" })
      continue // its ticket type is sold out: a guest on another type may still fit
    }
    seatsLeft = seatsLeft + ownHold - entry.seats
    takeTicket(entry, entry.seats - ownHold)
    promotions.push(
      kind === "free"
        ? { kind: "confirm", rsvpId: entry.id, seats: entry.seats }
        : { kind: "offer_claim", rsvpId: entry.id, seats: entry.seats, claimExpiresAt: addMinutes(now, claimMinutes) },
    )
  }
  return { promotions, seatsLeft: Math.max(0, seatsLeft), failed }
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
  ticketsLeft?: ReadonlyMap<string, number>,
): ClaimExpiryResult {
  const isLapsed = (e: WaitlistEntry) => e.claimExpiresAt != null && e.claimExpiresAt <= now
  const lapsed = orderWaitlist(entries.filter(isLapsed)).map((e) => e.id)
  const remaining = entries.filter((e) => !isLapsed(e))
  const { promotions, seatsLeft } = planPromotions({ entries: remaining, seatsAvailable, kind: "paid", now, claimMinutes, ticketsLeft })
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
