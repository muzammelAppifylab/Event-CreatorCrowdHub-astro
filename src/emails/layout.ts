/**
 * Shared email layout in the Marquee system (DESIGN.md): ink on paper, a
 * hairline card on a mist canvas, Hanken for everything, every action a pill.
 * The primary pill takes the creator's brand colour with whichever of ink or
 * paper contrasts more (checkBrandContrast), as in the app.
 *
 * Mail clients ignore stylesheets and CSS variables, so values are inlined
 * from the token primitives below and the structure is nested tables.
 * Anything interpolated goes through `esc`; creator copy goes through
 * `renderCreatorCopy`, which escapes the template before merging tags.
 */
import { copy } from "@/config/copy"
import { checkBrandContrast, normalizeHex } from "@/lib/event-brand"
import { escapeHtml, renderTemplate, type MergeContext } from "@/domain/mergeTags"
import type { CreatorCopy, EmailBrand } from "./types"

/** Marquee primitives (src/styles/tokens.css), inlined because email has no variables. */
export const MARQUEE = {
  ink: "#000000",
  paper: "#ffffff",
  mist: "#f6f6f6",
  ash: "#eeeeee",
  concrete: "#d9d9d9",
  slate: "#595959",
  leafSoft: "#dcf6dc",
  leafDeep: "#11650f",
  amberSoft: "#fff1cc",
  amberDeep: "#7a4a00",
  emberSoft: "#fde2de",
  emberDeep: "#8a1a0c",
  periwinkleSoft: "#e3eeff",
  midnight: "#001666",
} as const

export const FONT = "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const MONO = "'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace"

export const esc = escapeHtml

export type BadgeTone = "going" | "maybe" | "waitlist" | "no" | "neutral"

const BADGE_COLORS: Record<BadgeTone, [string, string]> = {
  going: [MARQUEE.leafSoft, MARQUEE.leafDeep],
  maybe: [MARQUEE.amberSoft, MARQUEE.amberDeep],
  waitlist: [MARQUEE.periwinkleSoft, MARQUEE.midnight],
  no: [MARQUEE.emberSoft, MARQUEE.emberDeep],
  neutral: [MARQUEE.ash, MARQUEE.ink],
}

/** Fill and text colour for the primary pill. */
export function buttonColors(brand: EmailBrand): { fill: string; text: string } {
  const hex = brand.brandColor ? normalizeHex(brand.brandColor) : null
  if (!hex) return { fill: MARQUEE.ink, text: MARQUEE.paper }
  return { fill: hex, text: checkBrandContrast(hex).foreground }
}

/** Status word plus colour, never colour alone. */
export function badge(word: string, tone: BadgeTone): string {
  const [bg, fg] = BADGE_COLORS[tone]
  return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:4px 12px;font-family:${FONT};font-size:12px;font-weight:600;line-height:16px;">&#9679;&nbsp;${esc(word)}</span>`
}

export function button(label: string, href: string, brand: EmailBrand): string {
  const { fill, text } = buttonColors(brand)
  // Table-wrapped so Outlook keeps the pill fill; the <a> carries the padding so the whole pill is clickable.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px;"><tr><td style="background:${fill};border-radius:999px;">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${text};text-decoration:none;border-radius:999px;">${esc(label)}</a>` +
    `</td></tr></table>`
}

/** Outline pill for secondary actions (add to calendar, manage RSVP). */
export function outlineButton(label: string, href: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;margin:4px 8px 4px 0;padding:9px 18px;border:1px solid ${MARQUEE.ink};border-radius:999px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${MARQUEE.ink};text-decoration:none;">${esc(label)}</a>`
}

export function paragraph(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${MARQUEE.ink};">${html}</p>`
}

export function muted(html: string): string {
  return `<p style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:20px;color:${MARQUEE.slate};">${html}</p>`
}

export function link(label: string, href: string): string {
  return `<a href="${esc(href)}" style="color:${MARQUEE.ink};text-decoration:underline;">${esc(label)}</a>`
}

/** Label/value rows on a mist panel: when, where, ticket. Values are HTML (escape before passing). */
export function details(rows: Array<[label: string, valueHtml: string]>): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:10px 16px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${MARQUEE.slate};vertical-align:top;width:96px;">${esc(label)}</td>` +
        `<td style="padding:10px 16px;font-family:${FONT};font-size:15px;line-height:22px;color:${MARQUEE.ink};">${value}</td></tr>`
    )
    .join("")
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;background:${MARQUEE.mist};border-radius:12px;">${body}</table>`
}

/** Ticket code in mono: guests read it aloud at the door (DESIGN: Mono Means Code). */
export function ticketCode(code: string): string {
  return `<span style="font-family:${MONO};font-size:18px;font-weight:600;letter-spacing:0.12em;">${esc(code.toUpperCase())}</span>`
}

export interface LayoutInput {
  brand: EmailBrand
  subject: string
  /** Inbox preview line. */
  preheader: string
  badge?: string
  heading: string
  /** Pre-rendered HTML blocks, in order. */
  blocks: string[]
  manageUrl?: string | null
}

export function renderLayout(input: LayoutInput): string {
  const { brand } = input
  // Mail clients need an absolute URL; the caller resolves a relative logo against the site address (only absolute https is used; anything else falls back to the sender name).
  const logoSrc = brand.logoUrl && /^https:\/\//i.test(brand.logoUrl) ? brand.logoUrl : null
  const masthead = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="${esc(brand.senderName)}" height="32" style="display:block;height:32px;width:auto;max-width:200px;max-height:32px;border:0;outline:none;">`
    : `<span style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${MARQUEE.ink};">${esc(brand.senderName)}</span>`
  const manage = input.manageUrl
    ? ` ${link("Manage your RSVP", input.manageUrl)}.`
    : ""

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${MARQUEE.mist};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MARQUEE.mist};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${MARQUEE.paper};border:1px solid ${MARQUEE.concrete};border-radius:16px;">
<tr><td style="padding:28px 32px 0;">${masthead}</td></tr>
<tr><td style="padding:28px 32px 0;">
${input.badge ? `<div style="margin:0 0 12px;">${input.badge}</div>` : ""}
<h1 style="margin:0 0 20px;font-family:${FONT};font-size:28px;line-height:32px;font-weight:700;letter-spacing:-0.02em;color:${MARQUEE.ink};">${esc(input.heading)}</h1>
</td></tr>
<tr><td style="padding:0 32px 16px;">
${input.blocks.join("\n")}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:20px 32px;font-family:${FONT};font-size:12px;line-height:18px;color:${MARQUEE.slate};">
Sent by ${esc(brand.senderName)} with ${esc(copy.appName)}. Reply to this email to reach the host.${manage}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

export interface TextInput {
  heading: string
  paragraphs: string[]
  details?: Array<[string, string]>
  links?: Array<[string, string]>
  senderName: string
  manageUrl?: string | null
}

/** Plain-text twin of the layout: same order, no markup. */
export function renderText(input: TextInput): string {
  const lines: string[] = [input.heading, ""]
  for (const p of input.paragraphs) lines.push(p, "")
  if (input.details?.length) {
    for (const [label, value] of input.details) lines.push(`${label}: ${value}`)
    lines.push("")
  }
  if (input.links?.length) {
    for (const [label, url] of input.links) lines.push(`${label}: ${url}`)
    lines.push("")
  }
  if (input.manageUrl) lines.push(`Manage your RSVP: ${input.manageUrl}`)
  lines.push(`Sent by ${input.senderName} with ${copy.appName}. Reply to this email to reach the host.`)
  return lines.join("\n")
}

/* ── Creator copy ───────────────────────────────────────────────────── */

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g

function linkify(escaped: string): string {
  return escaped.replace(URL_PATTERN, (match) => {
    // Keep sentence punctuation out of the link.
    const trail = /[.,;:!?)]+$/.exec(match)?.[0] ?? ""
    const url = trail ? match.slice(0, -trail.length) : match
    return `<a href="${url}" style="color:${MARQUEE.ink};text-decoration:underline;word-break:break-all;">${url}</a>${trail}`
  })
}

/**
 * Creator body (plain text with light markdown: blank-line paragraphs,
 * **bold**, bare URLs) → HTML blocks and text. The template is escaped
 * before tags are merged, so neither the creator's text nor a guest's name
 * can inject markup; merged values are escaped by renderTemplate itself.
 */
export function renderCreatorCopy(copy: CreatorCopy, ctx: MergeContext) {
  const subject = renderTemplate(copy.subject, ctx).output.replace(/[\r\n]+/g, " ").trim()
  const text = renderTemplate(copy.body, ctx).output.trim()
  const merged = renderTemplate(escapeHtml(copy.body), ctx, { mode: "html" })
  const blocks = merged.output
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.trim() !== "")
    .map((p) => paragraph(linkify(p.trim()).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")))
  const unknownTags = [...new Set([...renderTemplate(copy.subject, ctx).unknownTags, ...merged.unknownTags])]
  return { subject, html: blocks.join("\n"), text, paragraphs: text.split(/\n\s*\n/).filter((p) => p.trim() !== ""), unknownTags }
}
