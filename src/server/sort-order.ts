/** Reordering helpers: organiser-controlled `sortOrder` on ticket types, questions, polls and options. */

/** `ids` must be a non-empty array of strings that is exactly the set of `existing` ids (no duplicates, none missing, none foreign). */
export function validateOrder(ids: unknown, existing: readonly string[]): ids is string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length !== existing.length) return false;
  if (!ids.every(id => typeof id === 'string')) return false;
  const want = new Set(existing);
  const seen = new Set<string>();
  for (const id of ids as string[]) {
    if (!want.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** The next `sortOrder` after the current maximum (or 0 when empty). */
export const nextSortOrder = (max: number | null | undefined) => (max ?? -1) + 1;
