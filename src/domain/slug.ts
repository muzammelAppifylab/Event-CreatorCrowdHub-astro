/**
 * Event slugs for `/e/:slug` (unique per workspace). ASCII only so links
 * survive email clients and social cards untouched.
 */

// Keep in step with slugSchema in src/lib/schemas/common.ts (3–60 chars).
export const MIN_SLUG_LENGTH = 3
export const MAX_SLUG_LENGTH = 60
const FALLBACK_SLUG = "event"

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks: "é" → "e"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "") // the cut may land on a hyphen
  if (!slug) return FALLBACK_SLUG
  // Very short titles ("AI") would fail the 3-char minimum: suffix them.
  return slug.length < MIN_SLUG_LENGTH ? `${slug}-${FALLBACK_SLUG}` : slug
}

/** Appends -2, -3… until `isTaken` says no. The suffix keeps the result within the max length. */
export async function uniqueSlug(base: string, isTaken: (slug: string) => boolean | Promise<boolean>): Promise<string> {
  const root = slugify(base)
  if (!(await isTaken(root))) return root
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = root.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, "") + suffix
    if (!(await isTaken(candidate))) return candidate
  }
}
