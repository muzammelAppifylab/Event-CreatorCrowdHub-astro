/** "+12%", "-5%", "0%", or an en dash when there is no earlier number to compare with. Pure. */
export function formatChange(now: number, before: number): string {
  if (before <= 0) return '–';
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}
