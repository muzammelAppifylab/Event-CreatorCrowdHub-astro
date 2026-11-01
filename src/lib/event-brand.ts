/**
 * Creator brand colour → theme (PRD US-33).
 *
 * Primary defaults to ink (black on light, white on dark). Setting a brand
 * colour writes `--brand` / `--brand-foreground` on <html>; theme.css picks
 * them up through `--primary`. The foreground is whichever of ink or paper
 * contrasts more, so text on brand buttons always reaches the best ratio the
 * colour allows. `checkBrandContrast` reports whether that clears WCAG AA.
 */

const INK = "#000000"
const PAPER = "#ffffff"

export const WCAG_AA_TEXT = 4.5
export const WCAG_AA_LARGE = 3

export type FontPreset = "inter" | "serif" | "rounded"

export interface BrandContrastReport {
  /** Text colour to place on the brand fill. */
  foreground: typeof INK | typeof PAPER
  /** Contrast of the chosen foreground on the brand fill. */
  onBrand: number
  /** Contrast of the brand colour used as text/links/focus on white. */
  onPaper: number
  /** Brand fill with its foreground passes AA for body text. */
  fillPassesAA: boolean
  /** Brand as text on white passes AA (US-33 warning trigger). */
  textPassesAA: boolean
}

export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "")
  const hex = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export function checkBrandContrast(brandHex: string): BrandContrastReport {
  const onInk = contrastRatio(brandHex, INK)
  const onPaperText = contrastRatio(brandHex, PAPER)
  const foreground = onInk >= onPaperText ? INK : PAPER
  const onBrand = Math.max(onInk, onPaperText)
  return {
    foreground,
    onBrand,
    onPaper: onPaperText,
    fillPassesAA: onBrand >= WCAG_AA_TEXT,
    textPassesAA: onPaperText >= WCAG_AA_TEXT,
  }
}

/** Apply (or clear, with null) the workspace brand colour. */
export function applyBrand(brandHex: string | null, root: HTMLElement = document.documentElement) {
  const hex = brandHex ? normalizeHex(brandHex) : null
  if (!hex) {
    root.style.removeProperty("--brand")
    root.style.removeProperty("--brand-foreground")
    root.style.removeProperty("--brand-text")
    return null
  }
  const report = checkBrandContrast(hex)
  root.style.setProperty("--brand", hex)
  root.style.setProperty("--brand-foreground", report.foreground)
  if (report.textPassesAA) root.style.setProperty("--brand-text", hex)
  else root.style.removeProperty("--brand-text")
  return report
}

export function applyFontPreset(preset: FontPreset, root: HTMLElement = document.documentElement) {
  if (preset === "inter") root.removeAttribute("data-font-preset")
  else root.setAttribute("data-font-preset", preset)
}

/**
 * Apply the brand the server rendered as `data-brand` / `data-font-preset` on <html> (Base.astro,
 * App.astro). Run on `astro:page-load`: ClientRouter swaps the root attributes (dropping the
 * inline custom properties), so each page applies it again. Idempotent; CSSOM only (CSP).
 */
export function applyPageBrand(root: HTMLElement = document.documentElement) {
  applyBrand(root.dataset.brand ?? null, root)
  // The preset is already `data-font-preset` on <html> (server-rendered); re-assert it so the hook owns the attribute.
  const preset = root.dataset.fontPreset
  if (preset === "serif" || preset === "rounded") applyFontPreset(preset, root)
}

// ------------------------------------------------------------------- logo --

/** Logo uploads: raster images only (SVG always downloads on the platform, so it cannot show in an <img>). */
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"] as const
export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_RULE = "Use a PNG, JPEG, WebP, GIF or AVIF image up to 2 MB."
export const LOGO_FILE_ID = /^file_[0-9a-z]{26}$/

export type LogoUpload = { name: string; contentType: (typeof LOGO_TYPES)[number]; size: number }

/** The same check in the browser (before uploading) and in the route. */
export function parseLogoUpload(raw: unknown): { ok: true; value: LogoUpload } | { ok: false; message: string } {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const name = typeof v.name === "string" ? v.name.trim().slice(0, 200) : ""
  const contentType = typeof v.contentType === "string" ? v.contentType : ""
  const size = typeof v.size === "number" && Number.isFinite(v.size) ? v.size : 0
  if (!name) return { ok: false, message: "Pick an image file." }
  if (!(LOGO_TYPES as readonly string[]).includes(contentType)) return { ok: false, message: LOGO_RULE }
  if (!Number.isInteger(size) || size < 1 || size > LOGO_MAX_BYTES) return { ok: false, message: LOGO_RULE }
  return { ok: true, value: { name, contentType: contentType as LogoUpload["contentType"], size } }
}

/** The stable public link of a stored logo (same shape as `publicFileUrl` in the managed files helper). */
export function logoPath(file: { id: string; name: string } | null): string | null {
  return file ? `/__platform/files/${file.id}/${encodeURIComponent(file.name)}` : null
}
