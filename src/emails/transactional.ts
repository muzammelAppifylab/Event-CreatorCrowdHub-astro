/**
 * Emails sent when a guest's RSVP changes (PRD US-4, US-5, US-11, US-17):
 * confirmation (status-specific), waitlist offer, approval pending, declined
 * and event cancelled. The confirmation carries the .ics (UID = rsvp id) and
 * a Google Calendar link; the join link and ticket code only when confirmed.
 */
import { buildIcs, icsUid } from "@/domain/ics"
import { calendarLink, eventFacts, firstName, joinUrlFor, mergeContextFor, venueLine } from "./context"
import {
  badge,
  button,
  details,
  esc,
  muted,
  outlineButton,
  paragraph,
  renderCreatorCopy,
  renderLayout,
  renderText,
} from "./layout"
import type { CreatorCopy, EmailAttachment, EmailContent, EmailData } from "./types"

const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1)

/**
 * SEQUENCE must grow every time we re-send a file for the same UID, so a
 * later update or CANCEL replaces the guest's entry. Minutes since a fixed
 * epoch grows without storing a counter.
 */
export function icsSequence(now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH) / 60_000))
}

export function icsAttachment(data: EmailData, method: "PUBLISH" | "CANCEL" = "PUBLISH"): EmailAttachment {
  const { event, guest, brand } = data
  const join = joinUrlFor(data)
  const ics = buildIcs({
    uid: icsUid(guest.rsvpId),
    title: event.title,
    description: [join ? `Join: ${join}` : null, `Manage your RSVP: ${guest.manageUrl}`].filter(Boolean).join("\n"),
    startAt: event.startAt,
    endAt: event.endAt,
    timezone: event.timezone,
    location: venueLine(event) ?? join ?? null,
    url: event.pageUrl,
    organizerName: brand.senderName,
    organizerEmail: brand.replyToEmail ?? null,
    method,
    sequence: icsSequence(data.now),
    now: data.now,
  })
  return {
    filename: method === "CANCEL" ? "cancelled.ics" : "invite.ics",
    content: ics,
    contentType: `text/calendar; charset=utf-8; method=${method}`,
  }
}

interface Composed {
  subject: string
  preheader: string
  badge?: string
  heading: string
  intro: { html: string; text: string[] }
  facts?: ReturnType<typeof eventFacts>
  primary?: [label: string, url: string]
  secondary: Array<[label: string, url: string]>
  note?: string
  attachments?: EmailAttachment[]
}

function compose(data: EmailData, c: Composed): EmailContent {
  const blocks = [c.intro.html]
  if (c.facts) blocks.push(details(c.facts.html))
  if (c.primary) blocks.push(button(c.primary[0], c.primary[1], data.brand))
  if (c.secondary.length) blocks.push(`<div style="margin:8px 0 16px;">${c.secondary.map(([l, u]) => outlineButton(l, u)).join("")}</div>`)
  if (c.note) blocks.push(muted(esc(c.note)))

  const html = renderLayout({
    brand: data.brand,
    subject: c.subject,
    preheader: c.preheader,
    badge: c.badge,
    heading: c.heading,
    blocks,
    manageUrl: data.guest.manageUrl,
  })
  const text = renderText({
    heading: c.heading,
    paragraphs: [...c.intro.text, ...(c.note ? [c.note] : [])],
    details: c.facts?.text,
    links: [...(c.primary ? [c.primary] : []), ...c.secondary],
    senderName: data.brand.senderName,
    manageUrl: data.guest.manageUrl,
  })
  return { subject: c.subject, html, text, ...(c.attachments?.length ? { attachments: c.attachments } : {}) }
}

function plainIntro(...lines: string[]) {
  return { html: lines.map((l) => paragraph(esc(l))).join("\n"), text: lines }
}

/** M13: the marketing-consent confirmation link, only when the mailer set one. */
function consentLinks(data: EmailData): Array<[string, string]> {
  return data.guest.consentUrl ? [[`Yes, send me updates from ${data.brand.senderName}`, data.guest.consentUrl]] : []
}

/**
 * US-17. `custom` is the event's confirmation rule copy; it replaces the
 * default greeting for confirmed guests only, since waitlist and pending
 * guests need their status explained, not a "you're in".
 */
export function confirmationEmail(data: EmailData, custom?: CreatorCopy | null): EmailContent {
  const { event, guest } = data
  const name = firstName(guest.name)

  if (guest.status === "waitlisted") {
    const position = guest.waitlistPosition ? ` You're number ${guest.waitlistPosition} in line.` : ""
    return compose(data, {
      subject: `You're on the waitlist: ${event.title}`,
      preheader: "We'll email you the moment a seat opens up.",
      badge: badge("Waitlisted", "waitlist"),
      heading: "You're on the waitlist",
      intro: plainIntro(`Hi ${name}, ${event.title} is full right now.${position}`, "We'll email you the moment a seat opens up."),
      facts: eventFacts(data),
      primary: ["View event", event.pageUrl],
      secondary: consentLinks(data),
    })
  }
  if (guest.status === "pending") return approvalPendingEmail(data)
  if (guest.status === "declined") return declinedEmail(data)
  if (guest.status === "awaiting_payment") {
    return compose(data, {
      subject: `Finish your booking: ${event.title}`,
      preheader: "Your seat is held while you pay.",
      badge: badge("Awaiting payment", "maybe"),
      heading: "Almost there",
      intro: plainIntro(`Hi ${name}, we're holding your seat while you finish paying.`),
      facts: eventFacts(data),
      primary: ["Finish booking", guest.manageUrl],
      secondary: [],
    })
  }

  const isMaybe = guest.response === "maybe"
  const join = joinUrlFor(data)
  const copy = custom && !isMaybe ? renderCreatorCopy(custom, mergeContextFor(data)) : null
  const intro = copy
    ? { html: copy.html, text: copy.paragraphs }
    : isMaybe
      ? plainIntro(`Hi ${name}, you're down as a maybe for ${event.title}.`, "Change your answer any time from the link below.")
      : plainIntro(`Hi ${name}, your place at ${event.title} is confirmed.`)
  const secondary: Array<[string, string]> = [["Google Calendar", calendarLink(event)]]
  if (event.pollUrl) secondary.push(["Live poll", event.pollUrl])
  secondary.push(["Manage RSVP", guest.manageUrl], ...consentLinks(data))

  return compose(data, {
    subject: copy?.subject || (isMaybe ? `You're a maybe: ${event.title}` : `You're in: ${event.title}`),
    preheader: `${event.title}, ${event.startLocal}`,
    badge: isMaybe ? badge("Maybe", "maybe") : badge("Confirmed", "going"),
    heading: isMaybe ? "You're a maybe" : "You're in",
    intro,
    facts: eventFacts(data, { ticket: true }),
    primary: join ? ["Join the event", join] : ["View event", event.pageUrl],
    secondary,
    note: "The calendar file is attached. Show your ticket code at the door if there is one.",
    attachments: [icsAttachment(data)],
  })
}

/** US-4 (paid events): a seat is held for this guest until `claimExpiresLocal`. */
export function waitlistOfferEmail(data: EmailData, claimExpiresLocal: string): EmailContent {
  const { event, guest } = data
  return compose(data, {
    subject: `A seat opened up: ${event.title}`,
    preheader: `Claim it before ${claimExpiresLocal}.`,
    badge: badge("Seat available", "going"),
    heading: "A seat opened up",
    intro: plainIntro(
      `Hi ${firstName(guest.name)}, good news: a seat at ${event.title} is free and it's yours if you want it.`,
      `Claim it before ${claimExpiresLocal}. After that it goes to the next person on the waitlist.`
    ),
    facts: eventFacts(data),
    primary: ["Claim your seat", guest.manageUrl],
    secondary: [],
  })
}

/** US-5: approval mode. Pending never holds a seat, so no ticket or calendar yet. */
export function approvalPendingEmail(data: EmailData): EmailContent {
  const { event, guest, brand } = data
  return compose(data, {
    subject: `Request received: ${event.title}`,
    preheader: "The host reviews every request.",
    badge: badge("Pending", "maybe"),
    heading: "Request received",
    intro: plainIntro(
      `Hi ${firstName(guest.name)}, thanks for asking to join ${event.title}.`,
      `${brand.senderName} reviews every request. We'll email you as soon as they decide.`
    ),
    facts: eventFacts(data),
    secondary: [["Manage RSVP", guest.manageUrl]],
  })
}

/** US-5: the host declined the request. */
export function declinedEmail(data: EmailData): EmailContent {
  const { event, guest, brand } = data
  return compose(data, {
    subject: `Update on your request: ${event.title}`,
    preheader: "Your request wasn't approved this time.",
    badge: badge("Declined", "no"),
    heading: "Your request wasn't approved",
    intro: plainIntro(
      `Hi ${firstName(guest.name)}, ${brand.senderName} couldn't offer you a place at ${event.title} this time.`,
      "Thanks for your interest. Keep an eye out for future events."
    ),
    secondary: [],
  })
}

/** US-11: sent to every guest still expecting the event. Confirmed guests get a CANCEL .ics. */
export function eventCancelledEmail(data: EmailData, options: { refund?: boolean } = {}): EmailContent {
  const { event, guest, brand } = data
  const lines = [`Hi ${firstName(guest.name)}, ${brand.senderName} has cancelled ${event.title}, planned for ${event.startLocal}.`]
  if (options.refund) lines.push("Your payment will be refunded to the card you used. Refunds can take 5 to 10 days to appear.")
  lines.push("Reply to this email if you have any questions.")
  return compose(data, {
    subject: `Cancelled: ${event.title}`,
    preheader: `${event.title} won't go ahead.`,
    badge: badge("Cancelled", "no"),
    heading: "This event is cancelled",
    intro: plainIntro(...lines),
    secondary: [],
    attachments: guest.status === "confirmed" ? [icsAttachment(data, "CANCEL")] : undefined,
  })
}

/** US-9: checkout wasn't completed in time, so the held seat went back. No charge was made. */
export function holdExpiredEmail(data: EmailData): EmailContent {
  const { event, guest } = data
  return compose(data, {
    subject: `Your seat hold expired: ${event.title}`,
    preheader: "Checkout wasn't completed in time, so the seat was released.",
    badge: badge("Hold expired", "no"),
    heading: "Your seat hold expired",
    intro: plainIntro(
      `Hi ${firstName(guest.name)}, we held a seat at ${event.title} while you checked out, but payment wasn't completed in time.`,
      "The seat has been released and you haven't been charged. If places are still available you can book again from the event page."
    ),
    facts: eventFacts(data),
    primary: ["View event", event.pageUrl],
    secondary: [],
  })
}

/**
 * "Check your email" / "lost my link": the guest's personal link to their RSVP.
 * Sent on request, so it carries no status news and no attachments.
 */
export function manageLinkEmail(data: EmailData): EmailContent {
  const { event, guest } = data
  return compose(data, {
    subject: `Your RSVP link: ${event.title}`,
    preheader: `View or change your RSVP to ${event.title}.`,
    heading: "Your RSVP link",
    intro: plainIntro(
      `Hi ${firstName(guest.name)},`,
      `Here's your link to change your RSVP for ${event.title}. It replaces any earlier link. If you didn't ask for this, ignore it — your RSVP hasn't changed.`
    ),
    facts: eventFacts(data),
    primary: ["View or change your RSVP", guest.manageUrl],
    secondary: [],
  })
}

/** M13: double opt-in. Sent when a guest ticked marketing consent; nothing is sent to them until they confirm. */
export function consentEmail(data: EmailData): EmailContent {
  const { event, guest, brand } = data
  const url = guest.consentUrl ?? guest.manageUrl
  return compose(data, {
    subject: `Confirm: updates from ${brand.senderName}`,
    preheader: `One click to confirm you want updates from ${brand.senderName}.`,
    heading: "Confirm you want updates",
    intro: plainIntro(
      `Hi ${firstName(guest.name)}, you asked for updates from ${brand.senderName} when you RSVP'd to ${event.title}.`,
      "Please confirm it's you. We won't send you anything until you do. If it wasn't you, ignore this email."
    ),
    primary: [`Yes, send me updates from ${brand.senderName}`, url],
    secondary: [],
  })
}
