/**
 * Merge tags for reminder and broadcast copy (PRD US-20). Creators type the
 * copy, so rendering must never throw: unknown or misspelled tags render as
 * an empty string and are reported back so the editor can warn.
 *
 * `{{event.join_url}}` renders only for confirmed guests (US-2): the same
 * template can go to a waitlisted or pending guest and must not leak the link.
 *
 * Values (not the template) are HTML-escaped in `html` mode, so a guest named
 * `<script>` can't inject markup into an email.
 */

export type MergeTag =
  | "guest.first_name"
  | "guest.name"
  | "event.title"
  | "event.start_local"
  | "event.join_url"
  | "event.venue"
  | "rsvp.manage_url"
  | "poll.join_url"

export interface MergeContext {
  guest?: { name?: string | null }
  event?: {
    title?: string | null
    /** Already formatted in the event timezone (see `formatInZone`). */
    startLocal?: string | null
    joinUrl?: string | null
    venue?: string | null
  }
  rsvp?: { status?: string | null; manageUrl?: string | null }
  poll?: { joinUrl?: string | null }
}

export interface RenderOptions {
  mode?: "text" | "html"
}

export interface RenderResult {
  output: string
  /** Distinct unknown tag names in order of first appearance. */
  unknownTags: string[]
}

export interface TagInfo {
  tag: MergeTag
  /** What to insert in the editor. */
  token: string
  label: string
  example: string
}

const TAGS: readonly TagInfo[] = [
  { tag: "guest.first_name", token: "{{guest.first_name}}", label: "Guest first name", example: "Sam" },
  { tag: "guest.name", token: "{{guest.name}}", label: "Guest full name", example: "Sam Rivera" },
  { tag: "event.title", token: "{{event.title}}", label: "Event title", example: "Creator Office Hours" },
  { tag: "event.start_local", token: "{{event.start_local}}", label: "Start date and time", example: "Thu 12 Nov 2026, 18:00 GMT" },
  { tag: "event.join_url", token: "{{event.join_url}}", label: "Join link (confirmed guests only)", example: "https://zoom.us/j/123" },
  { tag: "event.venue", token: "{{event.venue}}", label: "Venue", example: "The Studio, 1 High St" },
  { tag: "rsvp.manage_url", token: "{{rsvp.manage_url}}", label: "Manage RSVP link", example: "https://…/r/abc" },
  { tag: "poll.join_url", token: "{{poll.join_url}}", label: "Live poll link", example: "https://…/p/ABC123" },
]

export function listTags(): TagInfo[] {
  return TAGS.map((t) => ({ ...t }))
}

const KNOWN = new Set<string>(TAGS.map((t) => t.tag))
const TAG_PATTERN = /\{\{([^{}]*)\}\}/g

function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}

function valueFor(tag: MergeTag, ctx: MergeContext): string {
  switch (tag) {
    case "guest.first_name":
      return firstName(ctx.guest?.name)
    case "guest.name":
      return ctx.guest?.name?.trim() ?? ""
    case "event.title":
      return ctx.event?.title ?? ""
    case "event.start_local":
      return ctx.event?.startLocal ?? ""
    case "event.join_url":
      return ctx.rsvp?.status === "confirmed" ? (ctx.event?.joinUrl ?? "") : ""
    case "event.venue":
      return ctx.event?.venue ?? ""
    case "rsvp.manage_url":
      return ctx.rsvp?.manageUrl ?? ""
    case "poll.join_url":
      return ctx.poll?.joinUrl ?? ""
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function renderTemplate(template: string, context: MergeContext, options: RenderOptions = {}): RenderResult {
  const unknown: string[] = []
  const output = template.replace(TAG_PATTERN, (_match, raw: string) => {
    const name = raw.trim()
    if (!KNOWN.has(name)) {
      if (!unknown.includes(name)) unknown.push(name)
      return ""
    }
    const value = valueFor(name as MergeTag, context)
    return options.mode === "html" ? escapeHtml(value) : value
  })
  return { output, unknownTags: unknown }
}
