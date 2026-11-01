import { describe, expect, it } from "vitest"
import { appConfig } from "../config/app.config"
import {
  deliveryKey,
  dueReminders,
  sendTimeFor,
  type DueRemindersInput,
  type ReminderEvent,
  type ReminderRsvp,
  type ReminderRule,
} from "./reminders"
import { zonedLocalToUtc } from "./time"

const start = new Date("2026-11-12T18:00:00Z")
const end = new Date("2026-11-12T19:00:00Z")
const min = (n: number, from = start) => new Date(from.getTime() + n * 60_000)

const event: ReminderEvent = { startAt: start, endAt: end, format: "online", status: "published" }
const [offset24h, offset1h] = appConfig.defaultReminderOffsets
const rules: ReminderRule[] = [
  { id: "r24", kind: "reminder", offsetMinutes: offset24h, enabled: true },
  { id: "r1", kind: "reminder", offsetMinutes: offset1h, enabled: true },
  { id: "live", kind: "live_now", offsetMinutes: 0, enabled: true },
  { id: "thanks", kind: "thank_you", offsetMinutes: 60, enabled: true },
  { id: "conf", kind: "confirmation", offsetMinutes: 0, enabled: true },
]
const guest = (id: string, extra: Partial<ReminderRsvp> = {}): ReminderRsvp => ({
  id,
  status: "confirmed",
  createdAt: min(-7 * 24 * 60),
  ...extra,
})

function run(overrides: Partial<DueRemindersInput>) {
  return dueReminders({ rules, event, rsvps: [guest("g1")], delivered: new Set(), now: start, ...overrides })
}
const pairs = (due: ReturnType<typeof run>) => due.map((d) => `${d.rsvpId}/${d.ruleId}`)

describe("sendTimeFor", () => {
  it("offsets reminders from the start", () => {
    expect(sendTimeFor(rules[0], event)).toEqual(min(-1440))
    expect(sendTimeFor(rules[1], event)).toEqual(min(-60))
  })

  it("sends live_now at the start for online and hybrid only", () => {
    expect(sendTimeFor(rules[2], event)).toEqual(start)
    expect(sendTimeFor(rules[2], { ...event, format: "hybrid" })).toEqual(start)
    expect(sendTimeFor(rules[2], { ...event, format: "in_person" })).toBeNull()
  })

  it("sends thank_you after the end, whatever the offset sign", () => {
    expect(sendTimeFor(rules[3], event)).toEqual(min(60, end))
    expect(sendTimeFor({ ...rules[3], offsetMinutes: -60 }, event)).toEqual(min(60, end))
  })

  it("never schedules confirmation (sent by the RSVP handler)", () => {
    expect(sendTimeFor(rules[4], event)).toBeNull()
  })
})

describe("dueReminders (US-20)", () => {
  it("defaults to 24h and 1h before", () => {
    expect(appConfig.defaultReminderOffsets).toEqual([-1440, -60])
  })

  it("sends the 24h reminder at its time", () => {
    expect(pairs(run({ now: min(-1440) }))).toEqual(["g1/r24"])
  })

  it("sends up to the window early so a 5-minute cron is never late", () => {
    expect(pairs(run({ now: min(-1444) }))).toEqual(["g1/r24"])
    expect(pairs(run({ now: min(-1446) }))).toEqual([])
    expect(pairs(run({ now: min(-1450), windowMinutes: 10 }))).toEqual(["g1/r24"])
  })

  it("catches up a missed run while it still makes sense", () => {
    expect(pairs(run({ now: min(-600) }))).toEqual(["g1/r24"])
    expect(pairs(run({ now: min(-30), delivered: new Set([deliveryKey("g1", "r24")]) }))).toEqual(["g1/r1"])
  })

  it("drops an unsent earlier reminder once a later one is due (no double email after an outage)", () => {
    expect(pairs(run({ now: min(-30) }))).toEqual(["g1/r1"])
    expect(pairs(run({ now: min(-63) }))).toEqual(["g1/r1"])
    // A disabled later rule doesn't supersede anything.
    const rs = [rules[0], { ...rules[1], enabled: false }]
    expect(pairs(run({ now: min(-30), rules: rs }))).toEqual(["g1/r24"])
  })

  it("never sends a pre-start reminder once the event has started", () => {
    expect(pairs(run({ now: min(1) }))).not.toContain("g1/r24")
    expect(pairs(run({ now: min(1) }))).not.toContain("g1/r1")
  })

  it("sends live_now at the start and not after the end", () => {
    const delivered = new Set([deliveryKey("g1", "r24"), deliveryKey("g1", "r1")])
    expect(pairs(run({ now: start, delivered }))).toEqual(["g1/live"])
    expect(pairs(run({ now: min(5), delivered }))).toEqual(["g1/live"])
    expect(pairs(run({ now: end, delivered }))).toEqual([])
  })

  it("skips live_now for in-person events", () => {
    const delivered = new Set([deliveryKey("g1", "r24"), deliveryKey("g1", "r1")])
    expect(pairs(run({ now: start, delivered, event: { ...event, format: "in_person" } }))).toEqual([])
  })

  it("sends thank_you after the end and gives up after 48h", () => {
    const delivered = new Set(["r24", "r1", "live"].map((r) => deliveryKey("g1", r)))
    expect(pairs(run({ now: min(59, end), delivered }))).toEqual(["g1/thanks"])
    expect(pairs(run({ now: min(60 + 47 * 60, end), delivered }))).toEqual(["g1/thanks"])
    expect(pairs(run({ now: min(60 + 48 * 60, end), delivered }))).toEqual([])
  })

  it("sends to confirmed guests only", () => {
    const rsvps = (["pending", "waitlisted", "declined", "cancelled", "awaiting_payment", "confirmed"] as const).map((status) =>
      guest(status, { status }),
    )
    expect(pairs(run({ now: min(-1440), rsvps }))).toEqual(["confirmed/r24"])
  })

  it("skips rules already past when the guest RSVP'd", () => {
    const late = guest("late", { createdAt: min(-120) })
    expect(pairs(run({ now: min(-60), rsvps: [late] }))).toEqual(["late/r1"])
    expect(pairs(run({ now: min(-1440), rsvps: [late] }))).toEqual([])
    const veryLate = guest("vlate", { createdAt: min(-59) })
    expect(pairs(run({ now: min(-58), rsvps: [veryLate] }))).toEqual([])
  })

  it("uses confirmedAt for guests promoted from the waitlist", () => {
    const promoted = guest("p", { createdAt: min(-3000), confirmedAt: min(-120) })
    expect(pairs(run({ now: min(-50), rsvps: [promoted] }))).toEqual(["p/r1"])
  })

  it("is idempotent: existing deliveries are skipped", () => {
    const rsvps = [guest("g1"), guest("g2")]
    const delivered = new Set([deliveryKey("g1", "r24")])
    expect(pairs(run({ now: min(-1440), rsvps, delivered }))).toEqual(["g2/r24"])
  })

  it("ignores disabled rules", () => {
    expect(run({ now: min(-1440), rules: [{ ...rules[0], enabled: false }] })).toEqual([])
  })

  it("sends nothing for cancelled or draft events", () => {
    expect(run({ now: min(-1440), event: { ...event, status: "cancelled" } })).toEqual([])
    expect(run({ now: min(-1440), event: { ...event, status: "draft" } })).toEqual([])
  })

  it("handles empty rules and guests", () => {
    expect(run({ rules: [] })).toEqual([])
    expect(run({ rsvps: [] })).toEqual([])
  })

  it("returns the send time with each pair", () => {
    expect(run({ now: min(-60) })).toEqual([{ rsvpId: "g1", ruleId: "r1", sendAt: min(-60) }])
  })

  it("uses absolute offsets across the DST change (01:30 Europe/London, 25 Oct 2026)", () => {
    const startAt = zonedLocalToUtc("2026-10-25T01:30", "Europe/London") // 01:30Z (GMT)
    const dstEvent: ReminderEvent = { ...event, startAt, endAt: min(60, startAt) }
    // 24 real hours earlier is 01:30Z on the 24th = 02:30 BST wall-clock.
    expect(sendTimeFor(rules[0], dstEvent)?.toISOString()).toBe("2026-10-24T01:30:00.000Z")
    expect(sendTimeFor(rules[1], dstEvent)?.toISOString()).toBe("2026-10-25T00:30:00.000Z")
    const due = dueReminders({
      rules,
      event: dstEvent,
      rsvps: [guest("g1", { createdAt: new Date("2026-10-01T00:00:00Z") })],
      delivered: new Set(),
      now: new Date("2026-10-25T00:30:00Z"),
    })
    expect(pairs(due)).toEqual(["g1/r1"])
  })
})

describe("STARTER_REMINDER_RULES", () => {
  it("has 24h and 1h reminders that use only known merge tags and mention the poll link", async () => {
    const { STARTER_REMINDER_RULES } = await import("./reminders")
    const { renderTemplate } = await import("./mergeTags")
    const offsets = STARTER_REMINDER_RULES.filter((r) => r.kind === "reminder").map((r) => r.offsetMinutes)
    expect(offsets).toEqual([-1440, -60])
    for (const r of STARTER_REMINDER_RULES) {
      expect(renderTemplate(r.subject, {}).unknownTags).toEqual([])
      expect(renderTemplate(r.body, {}).unknownTags).toEqual([])
    }
    expect(STARTER_REMINDER_RULES.find((r) => r.offsetMinutes === -1440)!.body).toContain("{{poll.join_url}}")
  })
})
