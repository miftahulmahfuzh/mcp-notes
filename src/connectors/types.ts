import type { SystemId } from './names.js';

export const CONNECTOR_DEFAULT_ROWS = 200;
export const CONNECTOR_MAX_ROWS = 1000;
/** Statement timeout per query; CONNECTOR_TIMEOUT_MS overrides it (read per call). */
export const CONNECTOR_DEFAULT_TIMEOUT_MS = 10_000;

export interface QueryResult {
  /** Column names, in order. */
  columns: string[];
  /** Compact: one array per row, aligned with columns. */
  rows: unknown[][];
  /** rows.length */
  row_count: number;
  /** True when more rows existed than the cap. */
  truncated: boolean;
}

/** maxRows defaults to CONNECTOR_DEFAULT_ROWS and is clamped to 1..CONNECTOR_MAX_ROWS. */
export interface QueryOptions {
  maxRows?: number;
}

export interface ReadOnlySource {
  /** One trusted, parameterised SELECT (curated tools). Read-only txn, statement timeout, row cap. No guard. */
  query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult>;
}

export interface Connector extends ReadOnlySource {
  id: SystemId;
  /** 'expense-tracking' | 'run-insights' | 'seer' */
  label: string;
  /** Seer only: lab.sqlite opened read-only, queried off the main thread with the same timeout/cap. Params are positional `?`. */
  lab?: ReadOnlySource;
}

export type Connectors = Record<SystemId, Connector>;

/** What a reader needs to know about a system's data, shown by <id>_schema. */
export interface SystemAbout {
  /** One line, used in tool descriptions. */
  summary: string;
  /** Meaning of the Postgres tables: units, date semantics, what is not stored. */
  db: string;
  /** Meaning of lab.sqlite (Seer only). */
  lab?: string;
}

/**
 * Thrown by every connector failure. message is already user-facing and secret-free:
 *  "<label> is not reachable: <reason>"  (missing repo, missing .env.local, no DB URL, connect/auth/network failure)
 *  "<label> query failed: <reason>"      (SQL error, timeout, read-only violation, guard refusal)
 */
export class ConnectorError extends Error {
  override name = 'ConnectorError';
}
