import { describe, expect, it } from "vitest"
import {
  approvalPendingEmail,
  broadcastEmail,
  buttonColors,
  confirmationEmail,
  declinedEmail,
  eventCancelledEmail,
  liveNowEmail,
  reminderEmail,
  thankYouEmail,
  waitlistOfferEmail,
  type EmailData,
} from "./index"

const NOW = new Date("2026-10-20T12:00:00Z")

function data(overrides: { event?: Partial<EmailData["event"]>; guest?: Partial<EmailData["guest"]>; brand?: Partial<EmailData["brand"]> } = {}): EmailData {
  return {
    now: NOW,
    brand: { senderName: "Clara Coaching", replyToEmail: "hello@clara.example", brandColor: null, ...overrides.brand },
    event: {
      title: "Pricing Workshop",
      startAt: new Date("2026-11-01T18:00:00Z"),
      endAt: new Date("2026-11-01T20:00:00Z"),
      timezone: "Europe/London",
      startLocal: "Sun 1 Nov 2026, 18:00 GMT",
      format: "online",
      joinUrl: "https://zoom.example/j/123?pwd=a&b=c",
      pageUrl: "https://events.example/e/pricing-workshop",
      pollUrl: "https://events.example/p/ABC234",
      ...overrides.event,
    },
    guest: {
      rsvpId: "11111111-1111-4111-8111-111111111111",
      name: "Sam Rivera",
      response: "going",
      status: "confirmed",
      ticketCode: "ab12cd34",
      manageUrl: "https://events.example/r/tok123",
      ...overrides.guest,
    },
  }
}

const reminderCopy = { subject: "Tomorrow: {{event.title}}", body: "Hi {{guest.first_name}},\n\nJoin: {{event.join_url}}" }

describe("confirmation email (US-17)", () => {
  it("has the manage link, join link, Google link, poll link and an .ics with UID = rsvp id", () => {
    const email = confirmationEmail(data())
    expect(email.subject).toBe("You're in: Pricing Workshop")
    expect(email.html).toContain("https://events.example/r/tok123")
    expect(email.text).toContain("https://events.example/r/tok123")
    expect(email.html).toContain("https://zoom.example/j/123?pwd=a&amp;b=c")
    expect(email.text).toContain("https://zoom.example/j/123?pwd=a&b=c")
    expect(email.html).toContain("calendar.google.com/calendar/render")
    expect(email.html).toContain("https://events.example/p/ABC234")
    expect(email.attachments).toHaveLength(1)
    const ics = email.attachments![0]!
    expect(ics.filename).toBe("invite.ics")
    expect(ics.contentType).toContain("text/calendar")
    expect(ics.content).toContain("UID:11111111-1111-4111-8111-111111111111@events.ezystudio")
    expect(ics.content).toContain("METHOD:PUBLISH")
  })

  it("never shows the join link to a waitlisted guest, and attaches no calendar file", () => {
    const email = confirmationEmail(data({ guest: { status: "waitlisted", waitlistPosition: 3 } }))
    expect(email.subject).toContain("waitlist")
    expect(email.html).not.toContain("zoom.example")
    expect(email.text).not.toContain("zoom.example")
    expect(email.text).toContain("number 3")
    expect(email.attachments).toBeUndefined()
    expect(email.html).toContain("https://events.example/r/tok123")
  })

  it("routes pending to the approval copy without the join link", () => {
    const email = confirmationEmail(data({ guest: { status: "pending" } }))
    expect(email.subject).toContain("Request received")
    expect(email.html).not.toContain("zoom.example")
  })

  it("shows the ticket code for in-person events only", () => {
    const inPerson = confirmationEmail(data({ event: { format: "in_person", venueName: "The Studio", venueAddress: "1 High St", joinUrl: null } }))
    expect(inPerson.html).toContain("AB12CD34")
    expect(inPerson.text).toContain("Ticket: AB12CD34")
    expect(inPerson.text).toContain("The Studio, 1 High St")
    expect(confirmationEmail(data()).text).not.toContain("Ticket:")
  })

  it("escapes HTML in guest names and creator copy", () => {
    const email = confirmationEmail(data({ guest: { name: "<script>alert(1)</script> Sam" } }), {
      subject: "Hi {{guest.first_name}}",
      body: "<b>bold?</b> Hello {{guest.name}}",
    })
    expect(email.html).not.toContain("<script>")
    expect(email.html).toContain("&lt;script&gt;")
    expect(email.html).not.toContain("<b>bold?</b>")
  })

  it("uses the confirmation rule copy for confirmed guests", () => {
    const email = confirmationEmail(data(), { subject: "Seat saved, {{guest.first_name}}", body: "See you there." })
    expect(email.subject).toBe("Seat saved, Sam")
    expect(email.text).toContain("See you there.")
  })
})

describe("creator emails", () => {
  it("reminder renders tags, links URLs and keeps the manage link", () => {
    const email = reminderEmail(data(), reminderCopy)
    expect(email.subject).toBe("Tomorrow: Pricing Workshop")
    expect(email.text).toContain("Hi Sam,")
    expect(email.html).toContain('<a href="https://zoom.example/j/123?pwd=a&amp;b=c"')
    expect(email.html).toContain("https://events.example/r/tok123")
  })

  it("reminder to a non-confirmed guest drops the join link everywhere", () => {
    const email = reminderEmail(data({ guest: { status: "waitlisted" } }), reminderCopy)
    expect(email.html).not.toContain("zoom.example")
    expect(email.text).not.toContain("zoom.example")
  })

  it("reports unknown tags and renders them empty", () => {
    const email = broadcastEmail(data(), { subject: "Hi {{guest.nickname}}", body: "x" })
    expect(email.subject).toBe("Hi")
    expect(email.unknownTags).toEqual(["guest.nickname"])
  })

  it("live now has the join and poll links; thank you uses the thank-you link", () => {
    const live = liveNowEmail(data(), { subject: "Live", body: "Now" })
    expect(live.html).toContain("Join now")
    expect(live.html).toContain("https://events.example/p/ABC234")
    const thanks = thankYouEmail(data({ event: { thankYouLink: "https://clara.example/offer" } }), { subject: "Thanks", body: "Thanks" })
    expect(thanks.html).toContain("https://clara.example/offer")
  })
})

describe("status emails", () => {
  it("waitlist offer, declined and cancelled all carry their status word", () => {
    expect(waitlistOfferEmail(data({ guest: { status: "waitlisted" } }), "Mon 21 Oct, 12:00").html).toContain("Seat available")
    expect(approvalPendingEmail(data({ guest: { status: "pending" } })).html).toContain("Pending")
    expect(declinedEmail(data({ guest: { status: "declined" } })).html).toContain("Declined")
    const cancelled = eventCancelledEmail(data(), { refund: true })
    expect(cancelled.html).toContain("Cancelled")
    expect(cancelled.text).toContain("refunded")
    expect(cancelled.attachments?.[0]?.content).toContain("METHOD:CANCEL")
  })
})

describe("brand button", () => {
  it("uses ink by default and picks the readable text colour on a brand fill", () => {
    expect(buttonColors({ senderName: "x" })).toEqual({ fill: "#000000", text: "#ffffff" })
    expect(buttonColors({ senderName: "x", brandColor: "#FFE27A" })).toEqual({ fill: "#ffe27a", text: "#000000" })
    expect(buttonColors({ senderName: "x", brandColor: "#2b44ff" }).text).toBe("#ffffff")
    const html = confirmationEmail(data({ brand: { brandColor: "#ffe27a" } })).html
    expect(html).toContain("background:#ffe27a")
  })
})
