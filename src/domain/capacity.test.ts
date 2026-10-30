import { describe, expect, it } from "vitest"
import { decideSeat, seatsFor, seatsRemaining, type CapacityInput } from "./capacity"

const base: CapacityInput = {
  capacity: 30,
  seatsTaken: 0,
  waitlistEnabled: true,
  approvalRequired: false,
  rsvpDeadline: null,
  now: new Date("2026-11-01T10:00:00Z"),
}

describe("capacity", () => {
  it("counts plus-ones as seats", () => {
    expect(seatsFor(0)).toBe(1)
    expect(seatsFor(2)).toBe(3)
  })

  it("treats null capacity as unlimited", () => {
    expect(seatsRemaining(null, 999)).toBe(Number.POSITIVE_INFINITY)
  })

  it("confirms while seats remain, including the last seat", () => {
    expect(decideSeat({ ...base, seatsTaken: 29 }, 1)).toEqual({ kind: "confirm" })
  })

  it("waitlists when full and waitlist is on", () => {
    expect(decideSeat({ ...base, seatsTaken: 30 }, 1)).toEqual({ kind: "waitlist" })
  })

  it("rejects as full when waitlist is off", () => {
    expect(decideSeat({ ...base, seatsTaken: 30, waitlistEnabled: false }, 1)).toEqual({ kind: "reject", reason: "full" })
  })

  it("blocks a party larger than the whole event", () => {
    expect(decideSeat({ ...base, capacity: 2 }, 3)).toEqual({ kind: "reject", reason: "too_many_seats" })
  })

  it("closes after the RSVP deadline", () => {
    expect(decideSeat({ ...base, rsvpDeadline: new Date("2026-10-31T00:00:00Z") }, 1)).toEqual({ kind: "reject", reason: "closed" })
  })

  it("holds approval-mode RSVPs as pending without taking seats", () => {
    expect(decideSeat({ ...base, approvalRequired: true, seatsTaken: 30 }, 1)).toEqual({ kind: "pending" })
  })
})
