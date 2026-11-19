/**
 * Inputs and outputs for the email templates. Templates are pure functions
 * of plain data (no DB rows, no env), so they run the same in the server,
 * in tests and in an admin preview. Every template returns HTML (inline-CSS
 * tables for mail clients) and a plain-text part.
 */
import type { EventFormat, RsvpStatus } from "@/domain/reminders"

export interface EmailAttachment {
  filename: string
  /** Raw text; the provider encodes it for transport. */
  content: string
  contentType: string
}

export interface EmailContent {
  subject: string
  html: string
  text: string
  attachments?: EmailAttachment[]
  /**
   * Extra mail headers for the provider (audit M-4): `List-Unsubscribe` on every guest email
   * that carries an unsubscribe link (`listUnsubscribeHeaders` in ./layout).
   */
  headers?: Record<string, string>
}

/** The creator's sender identity and brand (Workspace). */
export interface EmailBrand {
  senderName: string
  replyToEmail?: string | null
  logoUrl?: string | null
  /** Hex; null = ink. Button text colour is picked by checkBrandContrast. */
  brandColor?: string | null
}

export interface EmailEventInfo {
  title: string
  startAt: Date
  endAt: Date
  timezone: string
  /** Pre-formatted in the event timezone, e.g. "Thu 12 Nov 2026, 18:00 GMT". */
  startLocal: string
  format: EventFormat
  venueName?: string | null
  venueAddress?: string | null
  mapUrl?: string | null
  /** Private. Templates show it to confirmed guests only (US-2). */
  joinUrl?: string | null
  /**
   * The "View event" link. For a private event it can be the guest's own manage link
   * (`/r/<token>/`), so it must never go into another service's URL (a Google Calendar link,
   * a map): use `publicPageUrl` for those.
   */
  pageUrl: string
  /**
   * The event's public page, safe to hand to another service. Null for a private event (its page
   * answers 404 without an invite). When absent, `pageUrl` is used only if it isn't a manage link.
   */
  publicPageUrl?: string | null
  pollUrl?: string | null
  thankYouLink?: string | null
}

export interface EmailGuestInfo {
  rsvpId: string
  name: string
  response: "going" | "maybe" | "not_going"
  status: RsvpStatus
  ticketCode?: string | null
  manageUrl: string
  waitlistPosition?: number | null
  /**
   * Confirmation email only, when the guest ticked marketing consent: the
   * link that proves they own the inbox (security audit M13). Null otherwise.
   */
  consentUrl?: string | null
  /**
   * The guest's unsubscribe page (`guestEmailLinks` in src/server/privacy.ts): every guest email
   * shows it in the footer and in `List-Unsubscribe` (audit M-4/M-25). When absent, the layout
   * derives it from a `manageUrl` that carries the raw manage token (`/r/<token>/`).
   */
  unsubscribeUrl?: string | null
  /** The guest's own data page (download, erase); derived from a token-bearing `manageUrl` when absent. */
  privacyUrl?: string | null
}

export interface EmailData {
  brand: EmailBrand
  event: EmailEventInfo
  guest: EmailGuestInfo
  /** DTSTAMP and SEQUENCE for calendar files. */
  now: Date
}

/** Creator-written copy (reminder rules, broadcasts) with merge tags. */
export interface CreatorCopy {
  subject: string
  body: string
}
