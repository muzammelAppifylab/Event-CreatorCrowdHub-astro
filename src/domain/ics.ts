/**
 * Calendar files for the confirmation page and email (PRD US-17, §13).
 * One VEVENT per RSVP, UID = `${rsvpId}@events.ezystudio`, so re-sending an
 * updated file (higher SEQUENCE) or a CANCEL replaces the guest's existing
 * entry instead of adding a duplicate.
 *
 * Times are written in UTC (`…Z`). That avoids shipping a VTIMEZONE block,
 * which Outlook in particular is picky about, and makes DST irrelevant: the
 * instant is already resolved. The event timezone is passed as
 * X-WR-TIMEZONE so Apple/Google show it as a display hint.
 *
 * RFC 5545 details handled here: CRLF line endings, TEXT escaping of
 * `\ ; ,` and newlines, and folding at 75 octets measured in UTF-8 without
 * splitting a multi-byte character.
 */
import { toUtcBasic } from "./time"

export const ICS_PRODID = "-//EzyStudio//Events//EN"
const MAX_LINE_OCTETS = 75

export interface IcsInput {
  uid: string
  title: string
  description?: string | null
  startAt: Date
  endAt: Date
  timezone?: string | null
  location?: string | null
  url?: string | null
  organizerName?: string | null
  organizerEmail?: string | null
  method?: "PUBLISH" | "CANCEL"
  /** Bump on every change so clients replace the old copy. */
  sequence: number
  /** DTSTAMP: when this file was generated (pass the request time). */
  now: Date
}

export function icsUid(rsvpId: string): string {
  return `${rsvpId}@events.ezystudio`
}

/** TEXT value escaping (RFC 5545 §3.3.11). */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
}

/** Non-TEXT values (URI, cal-address) can't be escaped, only cleaned of line breaks. */
function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ")
}

function utf8Length(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

/** Fold one content line into ≤75-octet physical lines (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  const out: string[] = []
  let current = ""
  let octets = 0
  for (const char of line) {
    const size = utf8Length(char)
    // Continuation lines start with a space, which counts toward the 75.
    if (octets + size > MAX_LINE_OCTETS) {
      out.push(current)
      current = " "
      octets = 1
    }
    current += char
    octets += size
  }
  out.push(current)
  return out.join("\r\n")
}

/** Double-quoted parameter value: no quotes or control chars allowed inside. */
function paramValue(value: string): string {
  return `"${value.replace(/["\r\n\t]/g, "").replace(/[\x00-\x1f\x7f]/g, "")}"`
}

export function buildIcs(input: IcsInput): string {
  const method = input.method ?? "PUBLISH"
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
  ]
  if (input.timezone) lines.push(`X-WR-TIMEZONE:${stripLineBreaks(input.timezone)}`)
  lines.push(
    "BEGIN:VEVENT",
    `UID:${stripLineBreaks(input.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
    `DTSTAMP:${toUtcBasic(input.now)}`,
    `DTSTART:${toUtcBasic(input.startAt)}`,
    `DTEND:${toUtcBasic(input.endAt)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
  )
  if (input.description) lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`)
  if (input.location) lines.push(`LOCATION:${escapeIcsText(input.location)}`)
  if (input.url) lines.push(`URL:${stripLineBreaks(input.url)}`)
  if (input.organizerEmail) {
    const cn = input.organizerName ? `;CN=${paramValue(input.organizerName)}` : ""
    lines.push(`ORGANIZER${cn}:mailto:${stripLineBreaks(input.organizerEmail)}`)
  }
  lines.push(`STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR")
  return lines.map(foldLine).join("\r\n") + "\r\n"
}

export interface GoogleCalendarInput {
  title: string
  description?: string | null
  startAt: Date
  endAt: Date
  location?: string | null
  timezone?: string | null
}

/** "Add to Google Calendar" template link (no OAuth, PRD §13). */
export function googleCalendarUrl(input: GoogleCalendarInput): string {
  const params: Array<[string, string]> = [
    ["action", "TEMPLATE"],
    ["text", input.title],
    ["dates", `${toUtcBasic(input.startAt)}/${toUtcBasic(input.endAt)}`],
  ]
  if (input.description) params.push(["details", input.description])
  if (input.location) params.push(["location", input.location])
  if (input.timezone) params.push(["ctz", input.timezone])
  const query = params
    .map(([k, v]) => `${k}=${k === "dates" ? v : encodeURIComponent(v)}`)
    .join("&")
  return `https://calendar.google.com/calendar/render?${query}`
}
