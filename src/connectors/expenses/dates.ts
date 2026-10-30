/**
 * Pure calendar helpers for the expenses connector.
 *
 * Every day is a WIB (Asia/Jakarta) calendar day written 'YYYY-MM-DD' (expense_groups.occurred_on
 * is exactly that); every month is 'YYYY-MM'. Arithmetic runs on UTC midnights of those calendar
 * days, so the host timezone never changes an answer. Mirrors ~/expense-tracking/lib/format.ts
 * (copied semantics, not imported). The wall clock enters only through todayWib(now).
 */

export const WIB_TIME_ZONE = 'Asia/Jakarta';
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function toUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A real calendar day as 'YYYY-MM-DD' ('2026-02-30' is not). */
export function isValidDateIso(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  return fromUtcMs(toUtcMs(value)) === value;
}

export function isValidMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_RE.test(value);
}

/** addDays('2026-10-31', 1) === '2026-11-01'. */
export function addDays(iso: string, n: number): string {
  return fromUtcMs(toUtcMs(iso) + n * DAY_MS);
}

/** Number of calendar days from `from` to `to`, both included. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS) + 1;
}

/** 'Mon' … 'Sun'. */
export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(toUtcMs(iso)).getUTCDay()] ?? 'Sun';
}

/** The Monday that starts the ISO week (Monday–Sunday) containing `iso`. */
export function isoWeekMonday(iso: string): string {
  const dow = new Date(toUtcMs(iso)).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

/** ISO 8601 week label, e.g. '2026-W41'. The year is the year of the week's Thursday. */
export function isoWeekKey(iso: string): string {
  const thursday = addDays(isoWeekMonday(iso), 3);
  const year = Number(thursday.slice(0, 4));
  const dayOfYear = Math.round((toUtcMs(thursday) - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
  const week = Math.ceil(dayOfYear / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Today in Asia/Jakarta as 'YYYY-MM-DD'. Pass `now` in tests. */
export function todayWib(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WIB_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** addMonths('2026-01', -1) === '2025-12'. Integer math, no Date. */
export function addMonths(month: string, delta: number): string {
  if (!isValidMonthKey(month)) throw new RangeError(`invalid month "${month}", expected YYYY-MM`);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}
