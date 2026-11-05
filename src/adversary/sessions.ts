/**
 * Session clock for Seer Adversarial. sessionOpenUtc mirrors seer_engine.dates.session_open_utc
 * (contract C3): a verdict counts only if decided before 09:30 America/New_York on its session
 * date, as UTC. Pinned examples, the same on both sides: 2026-11-04 -> 2026-11-04T14:30:00Z
 * (US winter), 2026-07-01 -> 2026-07-01T13:30:00Z (US summer). Holidays do not matter: Seer only
 * writes candidates for real sessions. The daily cap runs on WIB days (UTC+7, no DST).
 */

const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const WIB_OFFSET_MS = 7 * 3_600_000;

const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function newYorkParts(at: Date): { date: string; hour: number; minute: number } {
  const parts: Record<string, string> = {};
  for (const part of NEW_YORK.formatToParts(at)) parts[part.type] = part.value;
  return {
    date: `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Throws TypeError unless `value` is a real calendar date written YYYY-MM-DD. */
export function assertSessionDate(value: string): void {
  if (!SESSION_DATE.test(value)) throw new TypeError(`not a session date (YYYY-MM-DD): ${value}`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`not a calendar date: ${value}`);
  }
}

/** 09:30 New York time on `sessionDate`, as a UTC instant (13:30Z in US summer, 14:30Z in winter). */
export function sessionOpenUtc(sessionDate: string): Date {
  assertSessionDate(sessionDate);
  const [y, m, d] = sessionDate.split('-').map(Number) as [number, number, number];
  for (const hourUtc of [13, 14]) {
    const at = new Date(Date.UTC(y, m - 1, d, hourUtc, 30));
    const ny = newYorkParts(at);
    if (ny.date === sessionDate && ny.hour === 9 && ny.minute === 30) return at;
  }
  throw new Error(`09:30 in New York has no UTC instant on ${sessionDate}`);
}

/** The UTC calendar date of `at`, YYYY-MM-DD. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `date` plus `days` calendar days (negative goes back). */
export function addDays(date: string, days: number): string {
  assertSessionDate(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The WIB (Asia/Jakarta, UTC+7) calendar date of `at`. */
export function wibDay(at: Date): string {
  return new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 WIB of the WIB day containing `at`, as a UTC instant. */
export function wibDayStartUtc(at: Date): Date {
  return new Date(Date.parse(`${wibDay(at)}T00:00:00Z`) - WIB_OFFSET_MS);
}
