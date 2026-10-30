import { describe, expect, it } from "vitest"
import { buildIcs, escapeIcsText, foldLine, googleCalendarUrl, ICS_PRODID, icsUid, type IcsInput } from "./ics"
import { zonedLocalToUtc } from "./time"

const base: IcsInput = {
  uid: icsUid("rsvp-123"),
  title: "Creator Office Hours",
  description: "Bring your questions.",
  startAt: new Date("2026-11-12T18:00:00Z"),
  endAt: new Date("2026-11-12T19:00:00Z"),
  timezone: "Europe/London",
  location: "Online",
  url: "https://clara.example/e/office-hours",
  organizerName: "Clara Coaching",
  organizerEmail: "hello@clara.example",
  sequence: 0,
  now: new Date("2026-11-01T10:00:00Z"),
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length
/** Undo folding (RFC 5545 §3.1) to read logical lines back. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n")

describe("ics", () => {
  it("builds a VCALENDAR with the required properties", () => {
    const lines = unfold(buildIcs(base))
    expect(lines[0]).toBe("BEGIN:VCALENDAR")
    expect(lines).toContain("VERSION:2.0")
    expect(lines).toContain(`PRODID:${ICS_PRODID}`)
    expect(lines).toContain("METHOD:PUBLISH")
    expect(lines).toContain("UID:rsvp-123@events.ezystudio")
    expect(lines).toContain("SEQUENCE:0")
    expect(lines).toContain("DTSTAMP:20261101T100000Z")
    expect(lines).toContain("DTSTART:20261112T180000Z")
    expect(lines).toContain("DTEND:20261112T190000Z")
    expect(lines).toContain("SUMMARY:Creator Office Hours")
    expect(lines).toContain("URL:https://clara.example/e/office-hours")
    expect(lines).toContain('ORGANIZER;CN="Clara Coaching":mailto:hello@clara.example')
    expect(lines).toContain("STATUS:CONFIRMED")
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1)
    expect(lines.at(-2)).toBe("END:VCALENDAR")
    expect(lines.at(-1)).toBe("") // file ends with CRLF
  })

  it("uses CRLF line endings only", () => {
    const ics = buildIcs({ ...base, description: "line one\nline two\r\nline three" })
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/)
    expect(ics.endsWith("\r\n")).toBe(true)
  })

  it("escapes commas, semicolons, backslashes and newlines in text", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne")
    const lines = unfold(buildIcs({ ...base, title: "Q&A; live, now", location: "Room 1\nFloor 2" }))
    expect(lines).toContain("SUMMARY:Q&A\\; live\\, now")
    expect(lines).toContain("LOCATION:Room 1\\nFloor 2")
  })

  it("folds long lines at 75 octets with a leading space", () => {
    const ics = buildIcs({ ...base, description: "x".repeat(300) })
    for (const line of ics.split("\r\n")) expect(utf8Bytes(line)).toBeLessThanOrEqual(75)
    expect(unfold(ics)).toContain(`DESCRIPTION:${"x".repeat(300)}`)
  })

  it("folds by UTF-8 octets without splitting multi-byte characters", () => {
    const text = "Café 🎉 ünïcödé ".repeat(20)
    const folded = foldLine(`DESCRIPTION:${text}`)
    const physical = folded.split("\r\n")
    expect(physical.length).toBeGreaterThan(1)
    for (const line of physical) {
      expect(utf8Bytes(line)).toBeLessThanOrEqual(75)
      expect(line).not.toMatch(/�/)
    }
    expect(physical.slice(1).every((l) => l.startsWith(" "))).toBe(true)
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${text}`)
  })

  it("leaves short lines alone", () => {
    expect(foldLine("SUMMARY:hi")).toBe("SUMMARY:hi")
    expect(foldLine("A".repeat(75))).toBe("A".repeat(75))
    expect(foldLine("A".repeat(76))).toBe(`${"A".repeat(75)}\r\n A`)
  })

  it("emits a CANCEL with STATUS:CANCELLED and the bumped sequence", () => {
    const lines = unfold(buildIcs({ ...base, method: "CANCEL", sequence: 2 }))
    expect(lines).toContain("METHOD:CANCEL")
    expect(lines).toContain("STATUS:CANCELLED")
    expect(lines).toContain("SEQUENCE:2")
    expect(lines).toContain("UID:rsvp-123@events.ezystudio")
  })

  it("omits optional properties when empty", () => {
    const ics = buildIcs({ ...base, description: null, location: null, url: null, organizerEmail: null, timezone: null })
    expect(ics).not.toMatch(/DESCRIPTION|LOCATION|URL:|ORGANIZER|X-WR-TIMEZONE/)
  })

  it("cannot be broken by line breaks or quotes in non-text values", () => {
    const lines = unfold(
      buildIcs({ ...base, uid: "a\r\nX-EVIL:1", organizerName: 'Evil" ;X=1\nY', url: "https://x.example/\nBEGIN:VEVENT" }),
    )
    expect(lines).not.toContain("X-EVIL:1")
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1)
    expect(lines.find((l) => l.startsWith("ORGANIZER"))).toBe('ORGANIZER;CN="Evil ;X=1Y":mailto:hello@clara.example')
  })

  it("writes the DST-day 01:30 Europe/London event as an unambiguous UTC instant", () => {
    const startAt = zonedLocalToUtc("2026-10-25T01:30", "Europe/London")
    const lines = unfold(buildIcs({ ...base, startAt, endAt: new Date(startAt.getTime() + 3_600_000) }))
    expect(lines).toContain("DTSTART:20261025T013000Z")
    expect(lines).toContain("DTEND:20261025T023000Z")
    expect(lines).toContain("X-WR-TIMEZONE:Europe/London")
  })
})

describe("googleCalendarUrl", () => {
  it("builds a prefilled TEMPLATE link", () => {
    const url = googleCalendarUrl({
      title: "Office Hours & Q&A",
      description: "Bring questions, 100% welcome",
      startAt: base.startAt,
      endAt: base.endAt,
      location: "Online",
      timezone: "Europe/London",
    })
    expect(url.startsWith("https://calendar.google.com/calendar/render?")).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get("action")).toBe("TEMPLATE")
    expect(params.get("text")).toBe("Office Hours & Q&A")
    expect(params.get("dates")).toBe("20261112T180000Z/20261112T190000Z")
    expect(params.get("details")).toBe("Bring questions, 100% welcome")
    expect(params.get("location")).toBe("Online")
    expect(params.get("ctz")).toBe("Europe/London")
  })

  it("omits empty optional params", () => {
    const params = new URL(googleCalendarUrl({ title: "T", startAt: base.startAt, endAt: base.endAt })).searchParams
    expect([...params.keys()]).toEqual(["action", "text", "dates"])
  })
})
