import { describe, expect, it } from "vitest"
import { addMinutes, formatInZone, minutesBetween, toUtcBasic, zonedLocalToUtc } from "./time"

describe("time", () => {
  it("adds absolute minutes", () => {
    const d = new Date("2026-11-01T10:00:00Z")
    expect(addMinutes(d, -60).toISOString()).toBe("2026-11-01T09:00:00.000Z")
    expect(minutesBetween(addMinutes(d, -1440), d)).toBe(1440)
  })

  it("formats the RFC 5545 UTC form without milliseconds", () => {
    expect(toUtcBasic(new Date("2026-10-25T01:30:05.123Z"))).toBe("20261025T013005Z")
  })

  it("converts ordinary wall-clock times in summer and winter", () => {
    expect(zonedLocalToUtc("2026-07-01T19:00", "Europe/London").toISOString()).toBe("2026-07-01T18:00:00.000Z")
    expect(zonedLocalToUtc("2026-12-01T19:00", "Europe/London").toISOString()).toBe("2026-12-01T19:00:00.000Z")
  })

  it("resolves the repeated 01:30 on the autumn clock-change day without throwing", () => {
    expect(zonedLocalToUtc("2026-10-25T01:30", "Europe/London").toISOString()).toBe("2026-10-25T01:30:00.000Z")
  })

  it("resolves the missing 01:30 on the spring clock-change day without throwing", () => {
    expect(zonedLocalToUtc("2026-03-29T01:30", "Europe/London").toISOString()).toBe("2026-03-29T00:30:00.000Z")
  })

  it("formats in the event timezone across the DST change", () => {
    expect(formatInZone(new Date("2026-10-25T00:30:00Z"), "Europe/London", "HH:mm")).toBe("01:30")
    expect(formatInZone(new Date("2026-10-25T01:30:00Z"), "Europe/London", "HH:mm")).toBe("01:30")
    expect(formatInZone(new Date("2026-12-01T19:00:00Z"), "Europe/London")).toMatch(/^Tue 1 Dec 2026, 19:00 /)
  })
})
