/**
 * Event descriptions are stored as plain text with a tiny Markdown subset and
 * rendered here to safe HTML. Everything is HTML-escaped FIRST, then only our
 * own tags are added, so no creator- or guest-supplied markup can reach the
 * page (PRD §16 rich-text sanitisation) and we need no sanitizer dependency.
 *
 * Supported: blank-line paragraphs, single line breaks, **bold**, *italic*,
 * [text](https://url), bare https:// links, "- " bullet lists, "1. " numbered
 * lists. Anything else stays literal text.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

/** Only http(s) and mailto survive; javascript:, data: etc. render as text. */
export function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

function link(href: string, label: string) {
  return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`
}

/** Inline formatting on an already-escaped line. */
function inline(escaped: string): string {
  return (
    escaped
      // [label](url): the url was escaped too, so unescape &amp; before validating.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
        const href = safeUrl(url.replace(/&amp;/g, "&"))
        return href ? link(href, label) : match
      })
      // Bare links not already inside an href.
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (match, lead: string, url: string) => {
        const href = safeUrl(url.replace(/&amp;/g, "&"))
        return href ? `${lead}${link(href, url)}` : match
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
  )
}

export function renderDescription(source: string): string {
  const blocks = source.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/)
  return blocks
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n").map((l) => escapeHtml(l.trim()))
      if (lines.every((l) => /^[-*] /.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`
      }
      if (lines.every((l) => /^\d+[.)] /.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+[.)] /, ""))}</li>`).join("")}</ol>`
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`
    })
    .join("")
}

/** Plain-text excerpt for meta descriptions and emails (no markup at all). */
export function descriptionExcerpt(source: string, max = 160): string {
  const text = source
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}
