import { NoteError } from './types.js';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Turns a user-supplied date filter into an instant.
 *
 * - `YYYY-MM-DD` is a whole day in the process's local timezone: a `from` bound is that day's
 *   local midnight, a `to` bound is the next day's local midnight (so the day is included).
 * - Anything else must parse as an ISO 8601 datetime. A `to` bound gets 1 ms added so the
 *   given instant is included.
 *
 * Callers compare with `column >= from` and `column < to`.
 */
export function parseDateBound(value: string, bound: 'from' | 'to'): Date {
  const v = value.trim();
  const m = DATE_ONLY.exec(v);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const start = new Date(y, mo, d);
    if (start.getFullYear() !== y || start.getMonth() !== mo || start.getDate() !== d) {
      throw new NoteError('invalid_input', `"${value}" is not a valid date (expected YYYY-MM-DD).`);
    }
    return bound === 'from' ? start : new Date(y, mo, d + 1);
  }
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    throw new NoteError(
      'invalid_input',
      `"${value}" is not a date. Use YYYY-MM-DD or an ISO 8601 datetime like 2026-10-30T14:00:00+07:00.`,
    );
  }
  return new Date(bound === 'from' ? t : t + 1);
}
