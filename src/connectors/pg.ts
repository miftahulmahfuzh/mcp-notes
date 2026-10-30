import pg from 'pg';
import type { DatabaseTarget } from './env.js';
import { queryFailed, reasonOf, unreachable } from './errors.js';
import { capRows, int8Value, wrapWithLimit } from './rows.js';
import type { QueryResult } from './types.js';

const { Client, types } = pg;

const OID = {
  INT8: 20,
  NUMERIC: 1700,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  INTERVAL: 1186,
  TIMETZ: 1266,
} as const;

const identity = (value: string): string => value;

function parserFor(oid: number): ((value: string) => unknown) | undefined {
  switch (oid) {
    case OID.INT8:
      return int8Value;
    case OID.NUMERIC:
      return (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : value;
      };
    case OID.DATE:
    case OID.TIME:
    case OID.TIMESTAMP:
    case OID.TIMESTAMPTZ:
    case OID.INTERVAL:
    case OID.TIMETZ:
      return identity;
    default:
      return undefined;
  }
}

/**
 * Per-client parsers: dates and times stay text (Jakarta session), int8 a number when safe, numeric a number.
 * json/jsonb and bool fall through to pg's defaults (parsed JSON, true/false). Phases 2-4 rely on exactly this.
 */
export const CONNECTOR_PG_TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    return parserFor(oid) ?? types.getTypeParser(oid, format ?? 'text');
  },
} as unknown as pg.CustomTypesConfig;

export function startupOptions(timeoutMs: number): string {
  return `-c default_transaction_read_only=on -c statement_timeout=${timeoutMs} -c TimeZone=Asia/Jakarta`;
}

export interface PgRunOptions {
  cap: number;
  timeoutMs: number;
  /** false runs `sql` as given, without the LIMIT wrapper (tests prove the DB refuses writes). Default true. */
  wrap?: boolean;
}

export async function runPgQuery(
  label: string,
  target: DatabaseTarget,
  sql: string,
  params: readonly unknown[],
  opts: PgRunOptions,
): Promise<QueryResult> {
  const client = new Client({
    connectionString: target.url,
    options: startupOptions(opts.timeoutMs),
    application_name: 'mcp-notes-connector',
    connectionTimeoutMillis: Math.min(opts.timeoutMs, 10_000),
    query_timeout: opts.timeoutMs + 2_000,
    types: CONNECTOR_PG_TYPES,
  });
  // A server-side drop after the call returns must never crash notesd.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw unreachable(label, reasonOf(err), target.secrets);
  }
  try {
    await client.query('BEGIN READ ONLY');
    const text = opts.wrap === false ? sql : wrapWithLimit(sql, opts.cap);
    const result = await client.query<unknown[]>({ text, values: [...params], rowMode: 'array' });
    await client.query('ROLLBACK');
    return capRows(
      result.fields.map((f) => f.name),
      result.rows,
      opts.cap,
    );
  } catch (err) {
    throw queryFailed(label, reasonOf(err), target.secrets);
  } finally {
    await client.end().catch(() => {});
  }
}
