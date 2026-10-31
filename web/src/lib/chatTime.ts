/**
 * Chat timestamps (R3, invariant 7): stored UTC, shown in Asia/Jakarta (UTC+7, no DST). Pure, so
 * the date-boundary cases are unit-tested: 17:30 UTC is 00:30 the NEXT day in Jakarta.
 */
export const CHAT_TZ = 'Asia/Jakarta';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: CHAT_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

/** A wall-clock reading in Jakarta. `month` is 1-12. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function msOf(t: number | string | Date): number {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/** Jakarta wall clock of an instant; null for an unparseable input. */
export function jakartaParts(t: number | string | Date): WallClock | null {
  const ms = msOf(t);
  if (!Number.isFinite(ms)) return null;
  const p: Record<string, number> = {};
  for (const part of PARTS.formatToParts(ms)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    year: p.year ?? 0,
    month: p.month ?? 0,
    day: p.day ?? 0,
    // Some ICU builds still print midnight as 24 with h23; normalise.
    hour: (p.hour ?? 0) % 24,
    minute: p.minute ?? 0,
    second: p.second ?? 0,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The bubble's timestamp: `HH:mm` on the same Jakarta day as `now`; `D Mon HH:mm` on another day
 * of the same year; `D Mon YYYY HH:mm` in another year. '' for an unparseable time.
 */
export function chatTime(iso: string, now: number | Date = Date.now()): string {
  const t = jakartaParts(iso);
  const n = jakartaParts(now);
  if (!t || !n) return '';
  const hm = `${pad(t.hour)}:${pad(t.minute)}`;
  if (t.year === n.year && t.month === n.month && t.day === n.day) return hm;
  const date = `${t.day} ${MONTHS[t.month - 1] ?? '?'}`;
  return t.year === n.year ? `${date} ${hm}` : `${date} ${t.year} ${hm}`;
}

/** The bubble timestamp's tooltip: full ISO wall time with the offset, e.g. `2026-10-31T00:30:00+07:00 (UTC+7)`. */
export function chatTimeTitle(iso: string): string {
  const t = jakartaParts(iso);
  if (!t) return iso;
  return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}+07:00 (UTC+7)`;
}
