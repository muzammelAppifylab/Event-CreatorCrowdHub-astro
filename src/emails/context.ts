/**
 * Shared bits for every template: the merge-tag context and the event facts
 * block. The join link is gated here as well as in renderTemplate, so a
 * template can never show it to a guest who isn't confirmed (US-2).
 */
import { googleCalendarUrl } from "@/domain/ics"
import type { MergeContext } from "@/domain/mergeTags"
import { esc, link, ticketCode } from "./layout"
import type { EmailData, EmailEventInfo, EmailGuestInfo } from "./types"

export function canSeeJoinLink(guest: EmailGuestInfo): boolean {
  return guest.status === "confirmed" && guest.response === "going"
}

export function joinUrlFor(data: EmailData): string | null {
  return canSeeJoinLink(data.guest) && data.event.format !== "in_person" ? (data.event.joinUrl ?? null) : null
}

export function mergeContextFor(data: EmailData): MergeContext {
  const venue = [data.event.venueName, data.event.venueAddress].filter(Boolean).join(", ")
  return {
    guest: { name: data.guest.name },
    event: { title: data.event.title, startLocal: data.event.startLocal, joinUrl: data.event.joinUrl ?? null, venue: venue || null },
    rsvp: { status: canSeeJoinLink(data.guest) ? "confirmed" : data.guest.status === "confirmed" ? "maybe" : data.guest.status, manageUrl: data.guest.manageUrl },
    poll: { joinUrl: data.event.pollUrl ?? null },
  }
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there"
}

export function venueLine(event: EmailEventInfo): string | null {
  const parts = [event.venueName, event.venueAddress].filter((p): p is string => !!p && p.trim() !== "")
  return parts.length ? parts.join(", ") : null
}

/** True for a guest's manage link (`/r/<token>/`): the token is a secret. */
export function isManageLink(url: string): boolean {
  try {
    return /^\/r\//.test(new URL(url, "https://x.invalid").pathname)
  } catch {
    return true
  }
}

/**
 * The event page to put in another service's URL (Google Calendar): the public page, never a
 * manage link (audit L-1 made a private event's pageUrl the guest's `/r/<token>/`). Null = none.
 */
export function shareablePageUrl(event: EmailEventInfo): string | null {
  if (event.publicPageUrl !== undefined) {
    return event.publicPageUrl && !isManageLink(event.publicPageUrl) ? event.publicPageUrl : null
  }
  return isManageLink(event.pageUrl) ? null : event.pageUrl
}

/**
 * The "View event" link, or null when there is no event page the guest can open: a private event
 * sends `pageUrl` = the site home with `publicPageUrl: null`, and a button to the home page is not
 * "View event". A manage link (`/r/<token>/`) works for its guest; otherwise the public page.
 */
export function viewEventUrl(event: EmailEventInfo): string | null {
  if (isManageLink(event.pageUrl)) return event.pageUrl
  return shareablePageUrl(event)
}

export function calendarLink(event: EmailEventInfo): string {
  return googleCalendarUrl({
    title: event.title,
    description: shareablePageUrl(event),
    startAt: event.startAt,
    endAt: event.endAt,
    location: venueLine(event) ?? (event.format === "in_person" ? null : "Online"),
    timezone: event.timezone,
  })
}

/** Ticket codes matter at a door: in-person and hybrid, going and confirmed. */
export function showsTicket(data: EmailData): boolean {
  return (
    data.event.format !== "online" &&
    data.guest.status === "confirmed" &&
    data.guest.response === "going" &&
    !!data.guest.ticketCode
  )
}

/** When / where / ticket rows as [label, html] and [label, text]. */
export function eventFacts(data: EmailData, options: { ticket?: boolean } = {}) {
  const { event } = data
  const html: Array<[string, string]> = [["When", esc(event.startLocal)]]
  const text: Array<[string, string]> = [["When", event.startLocal]]

  const venue = venueLine(event)
  if (event.format !== "online" && venue) {
    html.push(["Where", esc(venue) + (event.mapUrl ? `<br>${link("Open map", event.mapUrl)}` : "")])
    text.push(["Where", event.mapUrl ? `${venue} (${event.mapUrl})` : venue])
  }
  if (event.format !== "in_person") {
    const join = joinUrlFor(data)
    const label = event.format === "hybrid" ? "Online" : "Where"
    if (join) {
      html.push([label, link("Join link", join)])
      text.push([label, join])
    } else {
      const note = canSeeJoinLink(data.guest) ? "Online" : "Online. The join link arrives once you're confirmed."
      html.push([label, esc(note)])
      text.push([label, note])
    }
  }
  if (options.ticket && showsTicket(data)) {
    html.push(["Ticket", ticketCode(data.guest.ticketCode!)])
    text.push(["Ticket", data.guest.ticketCode!.toUpperCase()])
  }
  return { html, text }
}
