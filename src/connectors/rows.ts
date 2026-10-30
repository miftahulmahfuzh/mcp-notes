import { CONNECTOR_DEFAULT_ROWS, CONNECTOR_MAX_ROWS, type QueryResult } from './types.js';

export function clampMaxRows(maxRows?: number): number {
  if (maxRows === undefined || !Number.isFinite(maxRows)) return CONNECTOR_DEFAULT_ROWS;
  return Math.min(CONNECTOR_MAX_ROWS, Math.max(1, Math.floor(maxRows)));
}

/** Newlines keep a trailing `-- comment` in `sql` from swallowing the closing parenthesis. */
export function wrapWithLimit(sql: string, cap: number): string {
  return `SELECT * FROM (\n${sql}\n) AS q LIMIT ${cap + 1}`;
}

export function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/, '');
}

/** Rows were fetched with LIMIT cap+1: one extra row means "truncated". */
export function capRows(columns: string[], rows: unknown[][], cap: number): QueryResult {
  const truncated = rows.length > cap;
  const kept = truncated ? rows.slice(0, cap) : rows;
  return { columns, rows: kept, row_count: kept.length, truncated };
}

/** int8 text -> number when exact, else the text. */
export function int8Value(text: string): number | string {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : text;
}

/** Keyed rows for code that reads columns by name (curated tools). Later duplicate names win. */
export function toObjects(result: QueryResult): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const out: Record<string, unknown> = {};
    result.columns.forEach((name, i) => {
      out[name] = row[i];
    });
    return out;
  });
}
