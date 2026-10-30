import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe } from 'vitest';
import { createConnector } from '../../../src/connectors/connector.js';
import { CONNECTOR_SYSTEMS, SYSTEM_META, type SystemId } from '../../../src/connectors/names.js';
import { registerConnectorTools } from '../../../src/connectors/register.js';
import type { Connector, Connectors } from '../../../src/connectors/types.js';
import { connectorsAdminUrl, siblingRepo, systemDbName, systemDbUrl, withAdmin } from './siblings.js';

/**
 * Connector integration harness. Phases 2-4 import from here and do not edit it.
 * Create connectors and labs inside hooks or tests (describe.skip still runs the callback).
 */
export { connectorsAdminUrl, siblingRepo, systemDbName, systemDbUrl, withAdmin };

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Removes the temp repo dirs and labs this file created. Call in afterAll. */
export function cleanupHarness(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** describe() when the sibling repo is present, else describe.skip with the reason in the name. */
export function describeWithRepo(id: SystemId, name: string, fn: () => void): void {
  if (siblingRepo(id) !== null) {
    describe(name, fn);
    return;
  }
  const meta = SYSTEM_META[id];
  describe.skip(`${name} [skipped: ${meta.label} repository not found; clone it to ${meta.defaultRepoDir} or set ${meta.repoDirEnv}]`, fn);
}

/** Empties every public table of that system's database (seer: also the roster rows its migrations inserted). */
export async function truncateSystem(id: SystemId): Promise<void> {
  await withAdmin(systemDbUrl(id), async (c) => {
    const { rows } = await c.query<{ name: string }>(
      `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname = 'public'`,
    );
    if (rows.length === 0) return;
    await c.query(`TRUNCATE ${rows.map((r) => r.name).join(', ')} RESTART IDENTITY CASCADE`);
  });
}

/** One writable admin query on that system's database. Without params, several statements may be sent at once. */
export async function seedSystem(id: SystemId, sql: string, params: readonly unknown[] = []): Promise<void> {
  await withAdmin(systemDbUrl(id), async (c) => {
    await c.query(sql, [...params]);
  });
}

export interface ConnectorForOverrides {
  /** Written into the generated .env.local as DATABASE_URL_UNPOOLED. Default systemDbUrl(id). */
  databaseUrl?: string;
  /** Raw .env.local contents instead of the generated one; null writes no .env.local. */
  envLocal?: string | null;
  /** null: the connector's repo dir does not exist. */
  repoDir?: null;
  /** lab.sqlite path (seer). Default <temp repo>/lab/lab.sqlite, which does not exist. */
  labPath?: string;
  timeoutMs?: number;
}

/** A real connector (read-only, per-call .env.local) over a temp repo dir. Ignores the notes .env.local. */
export function connectorFor(id: SystemId, overrides: ConnectorForOverrides = {}): Connector {
  const common = { labPath: overrides.labPath, timeoutMs: overrides.timeoutMs, settings: { envFile: false as const } };
  if (overrides.repoDir === null) {
    return createConnector(id, { ...common, repoDir: path.join(tmpdir(), `mcp-notes-missing-${id}-${process.pid}`) });
  }
  const dir = tempDir(`mcp-notes-${id}-repo-`);
  if (overrides.envLocal !== null) {
    const contents = overrides.envLocal ?? `DATABASE_URL_UNPOOLED=${overrides.databaseUrl ?? systemDbUrl(id)}\n`;
    writeFileSync(path.join(dir, '.env.local'), contents);
  }
  return createConnector(id, { ...common, repoDir: dir });
}

export type LabRow = Record<string, string | number | null>;

export interface LabRows {
  methods?: LabRow[];
  trials?: LabRow[];
  trial_funding?: LabRow[];
  insights?: LabRow[];
}

export interface TempLab {
  path: string;
  dir: string;
}

/**
 * Seer's lab tables with the real column names and types (engine/src/seer_engine/lab/store.py),
 * minus CHECKs, UNIQUEs and triggers, and with defaults on NOT NULL columns so a test row only
 * names the columns it cares about.
 */
const LAB_TABLES_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES methods(id),
  source_kind TEXT NOT NULL DEFAULT 'seed',
  source_ref TEXT NOT NULL DEFAULT '',
  hypothesis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idea',
  analysis TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  blocked_on TEXT NOT NULL DEFAULT '',
  source_sha TEXT,
  created TEXT NOT NULL DEFAULT '2026-01-01',
  updated TEXT NOT NULL DEFAULT '2026-01-01'
);
CREATE TABLE trials (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id TEXT NOT NULL REFERENCES methods(id),
  candidate_id TEXT NOT NULL,
  config_digest TEXT NOT NULL DEFAULT '',
  config_text TEXT NOT NULL DEFAULT '',
  rules_id TEXT NOT NULL DEFAULT '',
  allocator_id TEXT NOT NULL DEFAULT '',
  window TEXT NOT NULL DEFAULT 'dev',
  start TEXT NOT NULL DEFAULT '',
  "end" TEXT NOT NULL DEFAULT '',
  store_fingerprint TEXT NOT NULL DEFAULT '',
  git_sha TEXT NOT NULL DEFAULT '',
  run_at TEXT NOT NULL DEFAULT '',
  total_return REAL,
  cagr REAL,
  max_drawdown REAL,
  profit_factor REAL,
  trades INTEGER NOT NULL DEFAULT 0,
  sharpe REAL,
  exposure REAL,
  turnover REAL,
  worst_year INTEGER,
  worst_year_return REAL,
  spy_tr_return REAL,
  spy_tr_cagr REAL,
  mar REAL,
  failed TEXT NOT NULL DEFAULT '',
  eligible INTEGER NOT NULL DEFAULT 0,
  dsr REAL,
  n_trials_at_run INTEGER NOT NULL DEFAULT 0,
  curve_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE trial_funding (
  trial_n INTEGER PRIMARY KEY REFERENCES trials(n),
  mwr REAL,
  spy_tr_mwr REAL,
  deposits_usd REAL NOT NULL DEFAULT 1,
  deposits_n INTEGER NOT NULL DEFAULT 1,
  schedule TEXT NOT NULL DEFAULT 'monthly',
  measured TEXT NOT NULL DEFAULT '2026-01-01'
);
CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'observation',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  method_id TEXT REFERENCES methods(id),
  added TEXT NOT NULL DEFAULT '2026-01-01',
  supersedes INTEGER,
  doc_key TEXT
);
`;

const LAB_INSERT_ORDER = ['methods', 'trials', 'trial_funding', 'insights'] as const;

/** A temp lab.sqlite with the lab tables; rows are inserted in FK order (methods, trials, trial_funding, insights). */
export function makeLab(rows: LabRows = {}): TempLab {
  const dir = tempDir('mcp-notes-lab-');
  const file = path.join(dir, 'lab.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(LAB_TABLES_SQL);
    for (const table of LAB_INSERT_ORDER) {
      for (const row of rows[table] ?? []) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
      }
    }
  } finally {
    db.close();
  }
  return { path: file, dir };
}

export interface ConnectorClient {
  /** Calls a tool and parses its JSON; throws with the tool's text when it returns isError. */
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Calls a tool that must fail and returns its error text. */
  callError(name: string, args?: Record<string, unknown>): Promise<string>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

/**
 * An in-memory MCP client over registerConnectorTools (generic + curated tools). Systems not
 * given get a connector whose repo does not exist.
 */
export async function connectorClient(connectors: Partial<Connectors>): Promise<ConnectorClient> {
  const full = Object.fromEntries(
    CONNECTOR_SYSTEMS.map((id) => [id, connectors[id] ?? connectorFor(id, { repoDir: null })]),
  ) as Connectors;
  const server = new McpServer({ name: 'connectors-test', version: '0.0.0' });
  registerConnectorTools(server, full);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'connectors-test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      if (result.isError) throw new Error(textOf(result));
      return JSON.parse(textOf(result)) as T;
    },
    async callError(name: string, args: Record<string, unknown> = {}): Promise<string> {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      if (!result.isError) throw new Error(`${name} succeeded; expected an error: ${textOf(result).slice(0, 200)}`);
      return textOf(result);
    },
    async listToolNames(): Promise<string[]> {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
}
