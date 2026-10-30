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
  pageUrl: string
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
