import { describe, expect, it } from "vitest"
import { calendarLink, isManageLink, shareablePageUrl, viewEventUrl } from "./context"
import { broadcastEmail, confirmationEmail, holdExpiredEmail, reminderEmail, type EmailData } from "./index"
import type { EmailEventInfo } from "./types"

const event = (overrides: Partial<EmailEventInfo> = {}): EmailEventInfo => ({
  title: "Studio Night",
  startAt: new Date("2030-01-10T18:00:00Z"),
  endAt: new Date("2030-01-10T21:00:00Z"),
  timezone: "Europe/London",
  startLocal: "Thu 10 Jan 2030, 18:00 GMT",
  format: "online",
  pageUrl: "https://events.example/events/studio-night/",
  ...overrides,
})

const TOKEN_LINK = "https://events.example/r/secret-manage-token/"

describe("calendar links never carry a manage token (L-1 follow-up)", () => {
  it("recognises a manage link", () => {
    expect(isManageLink(TOKEN_LINK)).toBe(true)
    expect(isManageLink("/r/abc/")).toBe(true)
    expect(isManageLink("https://events.example/events/r/")).toBe(false)
    expect(isManageLink("https://events.example/events/studio-night/")).toBe(false)
  })

  it("puts a public event page in the Google Calendar details", () => {
    const url = calendarLink(event())
    expect(url).toContain("calendar.google.com")
    expect(url).toContain(encodeURIComponent("https://events.example/events/studio-night/"))
  })

  it("leaves the details out when pageUrl is a private event's manage link", () => {
    const url = calendarLink(event({ pageUrl: TOKEN_LINK }))
    expect(url).not.toContain("secret-manage-token")
    expect(url).not.toContain("details=")
    expect(shareablePageUrl(event({ pageUrl: TOKEN_LINK }))).toBeNull()
  })

  it("prefers publicPageUrl, and null means none", () => {
    expect(shareablePageUrl(event({ pageUrl: TOKEN_LINK, publicPageUrl: "https://events.example/events/x/" }))).toBe(
      "https://events.example/events/x/",
    )
    expect(shareablePageUrl(event({ pageUrl: "https://events.example/", publicPageUrl: null }))).toBeNull()
    expect(shareablePageUrl(event({ publicPageUrl: TOKEN_LINK }))).toBeNull()
  })

  it("keeps the manage link in the guest's own confirmation, but not in the Google link", () => {
    const data: EmailData = {
      now: new Date("2029-12-01T00:00:00Z"),
      brand: { senderName: "Host" },
      event: event({ pageUrl: TOKEN_LINK }),
      guest: {
        rsvpId: "11111111-1111-4111-8111-111111111111",
        name: "Sam",
        response: "going",
        status: "confirmed",
        manageUrl: TOKEN_LINK,
      },
    }
    const email = confirmationEmail(data)
    expect(email.text).toContain(TOKEN_LINK)
    const google = email.html.match(/https:\/\/calendar\.google\.com[^"]*/)?.[0] ?? ""
    expect(google).not.toBe("")
    expect(google).not.toContain("secret-manage-token")
  })
})

describe("\"View event\" only when there is an event page", () => {
  const HOME = "https://events.example/"
  const PUBLIC = "https://events.example/events/studio-night/"
  const guest = {
    rsvpId: "11111111-1111-4111-8111-111111111111",
    name: "Sam",
    response: "going" as const,
    status: "confirmed" as const,
    manageUrl: TOKEN_LINK,
  }
  const mail = (ev: Partial<EmailEventInfo>, g: Partial<EmailData["guest"]> = {}): EmailData => ({
    now: new Date("2029-12-01T00:00:00Z"),
    brand: { senderName: "Host" },
    event: event(ev),
    guest: { ...guest, ...g },
  })
  const privateEvent = { pageUrl: HOME, publicPageUrl: null }
  const publicEvent = { pageUrl: PUBLIC, publicPageUrl: PUBLIC }

  it("picks the public page or a manage link, never a private event's home page", () => {
    expect(viewEventUrl(event(publicEvent))).toBe(PUBLIC)
    expect(viewEventUrl(event({ pageUrl: TOKEN_LINK, publicPageUrl: null }))).toBe(TOKEN_LINK)
    expect(viewEventUrl(event(privateEvent))).toBeNull()
  })

  const cases: Array<[string, (d: EmailData) => { html: string; text: string }, Partial<EmailData["guest"]>]> = [
    ["reminder", (d) => reminderEmail(d, { subject: "Soon", body: "See you" }), {}],
    ["broadcast", (d) => broadcastEmail(d, { subject: "News", body: "Hello" }), {}],
    ["confirmation", (d) => confirmationEmail(d), {}],
    ["waitlist confirmation", (d) => confirmationEmail(d), { status: "waitlisted" }],
    ["hold expired", (d) => holdExpiredEmail(d), { status: "cancelled" }],
  ]

  for (const [name, build, g] of cases) {
    it(`${name}: no "View event" for a private event, kept for a public one, Manage RSVP kept`, () => {
      const priv = build(mail(privateEvent, g))
      expect(priv.text).not.toContain("View event")
      expect(priv.html).not.toContain("View event")
      const pub = build(mail(publicEvent, g))
      expect(pub.text).toContain("View event")
      expect(pub.text).toContain(PUBLIC)
    })
  }

  it("keeps Manage RSVP in a private event's reminder and broadcast", () => {
    expect(reminderEmail(mail(privateEvent), { subject: "Soon", body: "See you" }).text).toContain("Manage RSVP")
    expect(broadcastEmail(mail(privateEvent), { subject: "News", body: "Hello" }).text).toContain("Manage RSVP")
  })
})
