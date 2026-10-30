const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * just now (< 1 min, or a small future skew) / N min ago (< 60 min) / Today / Yesterday /
 * "Oct 28" (this year) / "Oct 28, 2025" (other years). `lower` lower-cases Today/Yesterday
 * for use mid-sentence ("Last edited A-B32 today.").
 */
export function relativeDate(iso: string, now: Date, lower = false): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const diff = now.getTime() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (t >= startToday.getTime()) return lower ? 'today' : 'Today';
  const startYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (t >= startYesterday.getTime()) return lower ? 'yesterday' : 'Yesterday';
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}
