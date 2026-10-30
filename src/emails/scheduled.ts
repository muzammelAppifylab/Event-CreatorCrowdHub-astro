/**
 * Emails built from creator copy (PRD US-20, US-21): scheduled reminders,
 * "we're live", the thank-you and broadcasts. The creator's subject and body
 * (with merge tags) lead; the template adds the event facts and the action
 * that fits the moment.
 */
import { eventFacts, joinUrlFor, mergeContextFor } from "./context"
import { badge, button, details, FONT, MARQUEE, outlineButton, renderCreatorCopy, renderLayout, renderText } from "./layout"
import type { CreatorCopy, EmailContent, EmailData } from "./types"

export type CreatorEmailKind = "reminder" | "live_now" | "thank_you" | "broadcast"

interface Options {
  label?: string
  facts: boolean
  primary: [string, string] | null
  secondary: Array<[string, string]>
}

function optionsFor(kind: CreatorEmailKind, data: EmailData): Options {
  const { event, guest } = data
  const join = joinUrlFor(data)
  const manage: [string, string] = ["Manage RSVP", guest.manageUrl]
  switch (kind) {
    case "reminder":
      return { label: "Reminder", facts: true, primary: join ? ["Join the event", join] : ["View event", event.pageUrl], secondary: [manage] }
    case "live_now":
      return {
        label: "Live now",
        facts: false,
        primary: join ? ["Join now", join] : null,
        secondary: event.pollUrl ? [["Live poll", event.pollUrl]] : [],
      }
    case "thank_you":
      return { facts: false, primary: event.thankYouLink ? ["See what's next", event.thankYouLink] : null, secondary: [] }
    case "broadcast":
      return { facts: true, primary: ["View event", event.pageUrl], secondary: [manage] }
  }
}

/** The "Live now" badge is the black label badge (DESIGN: Badges). */
function liveBadge(): string {
  return `<span style="display:inline-block;background:${MARQUEE.ink};color:${MARQUEE.paper};border-radius:999px;padding:4px 12px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;line-height:16px;">Live now</span>`
}

export function creatorEmail(kind: CreatorEmailKind, data: EmailData, copy: CreatorCopy): EmailContent & { unknownTags: string[] } {
  const rendered = renderCreatorCopy(copy, mergeContextFor(data))
  const opts = optionsFor(kind, data)
  const facts = opts.facts ? eventFacts(data, { ticket: kind === "reminder" }) : null
  const subject = rendered.subject || data.event.title

  const blocks = [rendered.html]
  if (facts) blocks.push(details(facts.html))
  if (opts.primary) blocks.push(button(opts.primary[0], opts.primary[1], data.brand))
  if (opts.secondary.length) blocks.push(`<div style="margin:8px 0 16px;">${opts.secondary.map(([l, u]) => outlineButton(l, u)).join("")}</div>`)

  const html = renderLayout({
    brand: data.brand,
    subject,
    preheader: rendered.paragraphs[0]?.slice(0, 120) ?? data.event.title,
    badge: kind === "live_now" ? liveBadge() : opts.label ? badge(opts.label, "neutral") : undefined,
    heading: data.event.title,
    blocks,
    manageUrl: data.guest.manageUrl,
  })
  const text = renderText({
    heading: data.event.title,
    paragraphs: rendered.paragraphs,
    details: facts?.text,
    links: [...(opts.primary ? [opts.primary] : []), ...opts.secondary],
    senderName: data.brand.senderName,
    manageUrl: data.guest.manageUrl,
  })
  return { subject, html, text, unknownTags: rendered.unknownTags }
}

export const reminderEmail = (data: EmailData, copy: CreatorCopy) => creatorEmail("reminder", data, copy)
export const liveNowEmail = (data: EmailData, copy: CreatorCopy) => creatorEmail("live_now", data, copy)
export const thankYouEmail = (data: EmailData, copy: CreatorCopy) => creatorEmail("thank_you", data, copy)
export const broadcastEmail = (data: EmailData, copy: CreatorCopy) => creatorEmail("broadcast", data, copy)
