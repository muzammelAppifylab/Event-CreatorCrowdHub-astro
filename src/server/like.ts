/** Escape `\`, `%` and `_` so a user-supplied term matches literally in a LIKE/ILIKE `contains`. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, ch => '\\' + ch);
}
