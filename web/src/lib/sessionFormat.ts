function short(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
}

/** 950 -> "950", 12345 -> "12.3k", 1500000 -> "1.5M". Zero, negative or not finite -> "0". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${short(n / 1000)}k`;
  if (n < 1_000_000_000) return `${short(n / 1_000_000)}M`;
  return `${short(n / 1_000_000_000)}B`;
}

/** "$1.23"; "<$0.01" for a cost too small to show; null when no cost is recorded. */
export function formatCost(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
