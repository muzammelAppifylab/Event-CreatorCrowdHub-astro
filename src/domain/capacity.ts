/**
 * Capacity rules (PRD US-3, US-5, US-8). Pure functions: the server calls
 * these inside the same transaction that locks the event row
 * (`SELECT … FOR UPDATE`), so two last-seat RSVPs can never both confirm.
 */

export interface CapacityInput {
  /** Null means unlimited. */
  capacity: number | null
  /** Seats already held by confirmed + awaiting_payment RSVPs. */
  seatsTaken: number
  waitlistEnabled: boolean
  approvalRequired: boolean
  rsvpDeadline: Date | null
  now: Date
}

export type SeatDecision =
  | { kind: "confirm" }
  | { kind: "pending" } // approval mode: doesn't hold seats (US-5)
  | { kind: "waitlist" }
  | { kind: "reject"; reason: "full" | "closed" | "too_many_seats" }

export function seatsFor(plusOnes: number) {
  return 1 + plusOnes
}

export function seatsRemaining(capacity: number | null, seatsTaken: number) {
  return capacity === null ? Number.POSITIVE_INFINITY : Math.max(0, capacity - seatsTaken)
}

export function decideSeat(input: CapacityInput, requestedSeats: number): SeatDecision {
  if (input.rsvpDeadline && input.now > input.rsvpDeadline) return { kind: "reject", reason: "closed" }
  if (input.approvalRequired) return { kind: "pending" }

  const remaining = seatsRemaining(input.capacity, input.seatsTaken)
  if (requestedSeats <= remaining) return { kind: "confirm" }
  if (input.capacity !== null && requestedSeats > input.capacity) return { kind: "reject", reason: "too_many_seats" }
  if (input.waitlistEnabled) return { kind: "waitlist" }
  return { kind: "reject", reason: "full" }
}
