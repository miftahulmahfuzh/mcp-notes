/** One result row keyed by column name. */
export type Row = Record<string, unknown>;

/** Phase 1's compact { columns, rows } -> one object per row, re-exported so seer modules import one place. */
export { toObjects } from '../rows.js';

/** A number from a driver value (number, bigint or numeric string). null/undefined read as 0, like Seer's `n()`. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/** A number, or null when the value is null/undefined/not numeric. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** A date column as YYYY-MM-DD. The connector returns dates as text; a Date is tolerated. */
export function ymdOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Postgres booleans arrive as true/false; SQLite stores them as 0/1. */
export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 1n || v === 't' || v === 'true';
}

/** Rounds a finite number to `dp` decimals. */
export function fixed(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Rounds to `dp` decimals; null and non-finite values become null (JSON has no Infinity). */
export function round(v: number | null, dp: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return fixed(v, dp);
}

/** Shortens long free text for a tool result, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A json/jsonb column, whether the driver already parsed it or left it as text. */
export function json(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v ?? null;
}
