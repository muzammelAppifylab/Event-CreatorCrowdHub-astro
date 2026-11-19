import { describe, expect, it } from "vitest"
import { appConfig } from "../config/app.config"
import {
  expireClaims,
  nextWaitlistPosition,
  orderWaitlist,
  planPromotions,
  renumberWaitlist,
  type WaitlistEntry,
} from "./waitlist"

const now = new Date("2026-11-01T10:00:00Z")
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000)

function entry(id: string, waitlistPosition: number | null, seats = 1, extra: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return { id, seats, waitlistPosition, createdAt: at(-100 + (waitlistPosition ?? 50)), ...extra }
}

describe("waitlist ordering", () => {
  it("orders by position, then createdAt, then id; unnumbered last", () => {
    const list = [
      entry("d", null),
      entry("c", 2),
      { ...entry("b", 1), createdAt: at(-5) },
      { ...entry("a", 1), createdAt: at(-5) },
    ]
    expect(orderWaitlist(list).map((e) => e.id)).toEqual(["a", "b", "c", "d"])
  })

  it("does not mutate the input", () => {
    const list = [entry("b", 2), entry("a", 1)]
    orderWaitlist(list)
    expect(list.map((e) => e.id)).toEqual(["b", "a"])
  })
})

describe("planPromotions — free events (US-4)", () => {
  it("promotes the earliest waitlisted guest when one seat frees", () => {
    const plan = planPromotions({ entries: [entry("b", 2), entry("a", 1)], seatsAvailable: 1, kind: "free", now })
    expect(plan.promotions).toEqual([{ kind: "confirm", rsvpId: "a", seats: 1 }])
    expect(plan.seatsLeft).toBe(0)
  })

  it("promotes several guests in FIFO order while seats remain", () => {
    const plan = planPromotions({ entries: [entry("a", 1), entry("b", 2), entry("c", 3)], seatsAvailable: 2, kind: "free", now })
    expect(plan.promotions.map((p) => p.rsvpId)).toEqual(["a", "b"])
  })

  it("skips a party that doesn't fit and keeps scanning", () => {
    const plan = planPromotions({ entries: [entry("big", 1, 3), entry("solo", 2, 1)], seatsAvailable: 2, kind: "free", now })
    expect(plan.promotions).toEqual([{ kind: "confirm", rsvpId: "solo", seats: 1 }])
    expect(plan.seatsLeft).toBe(1)
  })

  it("promotes the whole party when it fits exactly", () => {
    const plan = planPromotions({ entries: [entry("pair", 1, 2), entry("solo", 2)], seatsAvailable: 2, kind: "free", now })
    expect(plan.promotions.map((p) => p.rsvpId)).toEqual(["pair"])
  })

  it("returns nothing for an empty waitlist or no seats", () => {
    expect(planPromotions({ entries: [], seatsAvailable: 5, kind: "free", now }).promotions).toEqual([])
    expect(planPromotions({ entries: [entry("a", 1)], seatsAvailable: 0, kind: "free", now }).promotions).toEqual([])
  })

  it("treats negative availability as zero", () => {
    expect(planPromotions({ entries: [entry("a", 1)], seatsAvailable: -2, kind: "free", now })).toEqual({ promotions: [], seatsLeft: 0, failed: [] })
  })

  it("promotes everyone when capacity is unlimited", () => {
    const plan = planPromotions({ entries: [entry("a", 1, 4), entry("b", 2, 5)], seatsAvailable: Number.POSITIVE_INFINITY, kind: "free", now })
    expect(plan.promotions).toHaveLength(2)
  })
})

describe("planPromotions — paid events (US-4)", () => {
  it("offers a claim link that expires after the configured window (24h)", () => {
    const plan = planPromotions({ entries: [entry("a", 1)], seatsAvailable: 1, kind: "paid", now })
    expect(plan.promotions).toEqual([
      { kind: "offer_claim", rsvpId: "a", seats: 1, claimExpiresAt: at(appConfig.waitlistClaimMinutes) },
    ])
    expect(appConfig.waitlistClaimMinutes).toBe(24 * 60)
  })

  it("accepts a custom claim window", () => {
    const plan = planPromotions({ entries: [entry("a", 1)], seatsAvailable: 1, kind: "paid", now, claimMinutes: 60 })
    expect(plan.promotions[0]).toMatchObject({ claimExpiresAt: at(60) })
  })

  it("does not re-offer a guest with an outstanding claim, and holds its seats", () => {
    const entries = [entry("a", 1, 1, { claimExpiresAt: at(30) }), entry("b", 2), entry("c", 3)]
    const plan = planPromotions({ entries, seatsAvailable: 2, kind: "paid", now })
    expect(plan.promotions.map((p) => p.rsvpId)).toEqual(["b"])
    expect(plan.seatsLeft).toBe(0)
  })
})

describe("expireClaims (US-4)", () => {
  it("lapses an expired claim and offers the seat to the next guest", () => {
    const entries = [entry("a", 1, 1, { claimExpiresAt: at(-1) }), entry("b", 2)]
    const result = expireClaims(entries, now, 1)
    expect(result.lapsed).toEqual(["a"])
    expect(result.offers).toEqual([{ kind: "offer_claim", rsvpId: "b", seats: 1, claimExpiresAt: at(24 * 60) }])
  })

  it("treats a claim expiring exactly now as lapsed", () => {
    expect(expireClaims([entry("a", 1, 1, { claimExpiresAt: now })], now, 1).lapsed).toEqual(["a"])
  })

  it("leaves active claims alone and offers nothing extra", () => {
    const entries = [entry("a", 1, 1, { claimExpiresAt: at(10) }), entry("b", 2)]
    expect(expireClaims(entries, now, 1)).toEqual({ lapsed: [], offers: [], seatsLeft: 0 })
  })

  it("reports lapsed claims even when nobody is left to offer", () => {
    expect(expireClaims([entry("a", 1, 2, { claimExpiresAt: at(-5) })], now, 2)).toEqual({ lapsed: ["a"], offers: [], seatsLeft: 2 })
  })

  it("handles an empty list", () => {
    expect(expireClaims([], now, 3)).toEqual({ lapsed: [], offers: [], seatsLeft: 3 })
  })
})

describe("renumberWaitlist", () => {
  it("closes gaps and returns only changed rows", () => {
    const changes = renumberWaitlist([entry("a", 1), entry("c", 4), entry("b", 3)])
    expect(changes).toEqual([
      { id: "b", waitlistPosition: 2 },
      { id: "c", waitlistPosition: 3 },
    ])
  })

  it("numbers entries that had no position", () => {
    expect(renumberWaitlist([entry("a", 1), entry("z", null)])).toEqual([{ id: "z", waitlistPosition: 2 }])
  })

  it("returns nothing when already contiguous or empty", () => {
    expect(renumberWaitlist([entry("a", 1), entry("b", 2)])).toEqual([])
    expect(renumberWaitlist([])).toEqual([])
  })

  it("gives a newcomer the back of the line", () => {
    expect(nextWaitlistPosition([])).toBe(1)
    expect(nextWaitlistPosition([entry("a", 1), entry("b", 7), entry("c", null)])).toBe(8)
  })
})

describe("planPromotions: ticket quantity (audit M-2)", () => {
  const vip = (id: string, pos: number, seats = 1, extra: Partial<WaitlistEntry> = {}) => entry(id, pos, seats, { ticketTypeId: "vip", ...extra })

  it("never hands out more seats of a limited ticket than it has left", () => {
    const plan = planPromotions({
      entries: [vip("a", 1), vip("b", 2), vip("c", 3)],
      seatsAvailable: 10,
      kind: "free",
      now,
      ticketsLeft: new Map([["vip", 1]]),
    })
    expect(plan.promotions.map((p) => p.rsvpId)).toEqual(["a"])
  })

  it("skips a sold-out ticket and keeps scanning for guests on other types", () => {
    const plan = planPromotions({
      entries: [vip("a", 1), entry("b", 2, 1, { ticketTypeId: "general" }), entry("c", 3)],
      seatsAvailable: 2,
      kind: "free",
      now,
      ticketsLeft: new Map([["vip", 0]]),
    })
    expect(plan.promotions.map((p) => p.rsvpId)).toEqual(["b", "c"])
  })

  it("an outstanding claim holds its ticket's quantity too", () => {
    const plan = planPromotions({
      entries: [vip("a", 1, 1, { claimExpiresAt: at(30) }), vip("b", 2)],
      seatsAvailable: 5,
      kind: "paid",
      now,
      ticketsLeft: new Map([["vip", 1]]),
    })
    expect(plan.promotions).toEqual([])
  })

  it("expireClaims passes the ticket limit on to the next offers", () => {
    const result = expireClaims([vip("a", 1, 1, { claimExpiresAt: at(-1) }), vip("b", 2), vip("c", 3)], now, 5, 60, new Map([["vip", 1]]))
    expect(result.lapsed).toEqual(["a"])
    expect(result.offers.map((o) => o.rsvpId)).toEqual(["b"])
  })
})

describe("planPromotions: host picks (only)", () => {
  it("reports picks that are missing, too big or sold out, and promotes the rest", () => {
    const plan = planPromotions({
      entries: [entry("a", 1, 3), entry("b", 2, 1, { ticketTypeId: "vip" }), entry("c", 3), entry("d", 4)],
      seatsAvailable: 2,
      kind: "free",
      now,
      ticketsLeft: new Map([["vip", 0]]),
      only: new Set(["a", "b", "d", "zz"]),
    })
    expect(plan.promotions.map((p) => p.rsvpId)).toEqual(["d"])
    expect(plan.failed).toEqual([
      { rsvpId: "zz", reason: "not_waitlisted" },
      { rsvpId: "a", reason: "event_full" },
      { rsvpId: "b", reason: "ticket_sold_out" },
    ])
  })

  it("re-offers a lapsed claim but refuses a live one on a paid event", () => {
    const plan = planPromotions({
      entries: [entry("a", 1, 1, { claimExpiresAt: at(-5) }), entry("b", 2, 1, { claimExpiresAt: at(30) })],
      seatsAvailable: 3,
      kind: "paid",
      now,
      only: new Set(["a", "b"]),
    })
    expect(plan.promotions.map((p) => p.rsvpId)).toEqual(["a"])
    expect(plan.failed).toEqual([{ rsvpId: "b", reason: "claim_pending" }])
  })
})
