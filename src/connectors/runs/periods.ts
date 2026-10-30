/**
 * Calendar helpers for the run-insights curated tools: WIB days, ISO weeks, months.
 *
 * run-insights keys its week reviews 'YYYY-Www' (ISO 8601, Monday to Sunday, week 1 holds the
 * year's first Thursday) and its month reviews 'YYYY-MM', both over `runs.occurred_on`, which is
 * an Asia/Jakarta calendar day. Everything here is integer/UTC arithmetic on day strings, so no
 * host timezone can shift a day. Re-implemented here; run-insights code is never imported.
 */

export const WIB_TIME_ZONE = 'Asia/Jakarta';

const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;

export type PeriodScope = 'week' | 'month';

export interface Period {
  scope: PeriodScope;
  /** 'YYYY-Www' or 'YYYY-MM': the app's insights.scope_key for this period. */
  key: string;
  /** First day, inclusive, 'YYYY-MM-DD'. */
  from: string;
  /** Last day, inclusive, 'YYYY-MM-DD'. */
  to: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function toISO(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function utcDay(dateISO: string): Date {
  return new Date(`${dateISO}T00:00:00Z`);
}

/** True for a 'YYYY-MM-DD' string naming a day that exists ('2026-02-30' is false). */
export function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  return toISO(utcDay(value)) === value;
}

/** addDays('2026-10-31', 1) === '2026-11-01'. */
export function addDays(dateISO: string, days: number): string {
  const d = utcDay(dateISO);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}

/** Today's calendar day in WIB, 'YYYY-MM-DD'. */
export function todayInWib(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WIB_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The ISO week key that owns a day: the Thursday of the day's week decides the week-year. */
export function isoWeekKeyOf(dateISO: string): string {
  const d = utcDay(dateISO);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - dow + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.floor((thursday.getTime() - jan1.getTime()) / (7 * 86_400_000)) + 1;
  return `${pad(isoYear, 4)}-W${pad(week)}`;
}

/** First (Monday) and last (Sunday) day of an ISO week key, both inclusive. */
export function isoWeekRange(key: string): { from: string; to: string } {
  const m = WEEK_RE.exec(key);
  if (!m) throw new RangeError(`"${key}" is not an ISO week like 2026-W34`);
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Dow + (week - 1) * 7);
  const from = toISO(monday);
  // Week 53 only exists in some years; '2025-W53' would silently be 2026-W01.
  if (isoWeekKeyOf(from) !== key) throw new RangeError(`${isoYear} has no ISO week ${m[2]}`);
  return { from, to: addDays(from, 6) };
}

/** First and last day of a 'YYYY-MM' month, both inclusive. */
export function monthRange(key: string): { from: string; to: string } {
  if (!MONTH_RE.test(key)) throw new RangeError(`"${key}" is not a month like 2026-08`);
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const next = new Date(Date.UTC(y, m, 1)); // month m is 1-based, so this is the next month's 1st
  return { from: `${key}-01`, to: addDays(toISO(next), -1) };
}

/**
 * Resolves a review period from a key: 'YYYY-Www' (week), 'YYYY-MM' (month), or any 'YYYY-MM-DD'
 * inside the period. No key means the period that contains today (WIB).
 */
export function resolvePeriod(scope: PeriodScope, key: string | undefined, now: Date = new Date()): Period {
  const raw = (key ?? '').trim().toUpperCase() || todayInWib(now);
  if (scope === 'week') {
    let weekKey: string;
    if (WEEK_RE.test(raw)) weekKey = raw;
    else if (isRealDate(raw)) weekKey = isoWeekKeyOf(raw);
    else throw new RangeError(`"${key}" is not an ISO week like 2026-W34 or a date like 2026-08-20`);
    return { scope, key: weekKey, ...isoWeekRange(weekKey) };
  }
  let monthKey: string;
  if (MONTH_RE.test(raw)) monthKey = raw;
  else if (isRealDate(raw)) monthKey = raw.slice(0, 7);
  else throw new RangeError(`"${key}" is not a month like 2026-08 or a date like 2026-08-20`);
  return { scope, key: monthKey, ...monthRange(monthKey) };
}

/** Validates an inclusive day range; `to` defaults to today (WIB). */
export function resolveRange(from: string, to: string | undefined, now: Date = new Date()): { from: string; to: string } {
  const end = to ?? todayInWib(now);
  if (!isRealDate(from)) throw new RangeError(`from "${from}" is not a real day (YYYY-MM-DD)`);
  if (!isRealDate(end)) throw new RangeError(`to "${end}" is not a real day (YYYY-MM-DD)`);
  if (from > end) throw new RangeError(`from ${from} is after to ${end}`);
  return { from, to: end };
}
