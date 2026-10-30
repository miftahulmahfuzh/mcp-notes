# Phase 1: Connector core, generic tools, test harness

**Plan set:** `CONNECTORS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-124712-C5N7_code_analyzer.md`
**Satisfies:** R1 (connector core), R2 (`_schema`, `_sql`, instructions paragraph), R5 (unit tests, Docker harness, generic int tests, read-only proof, live check). The user can ask any of the three apps about its tables and run a read-only SELECT against it, and nothing can be written there.
**Depends on:** none
**Difficulty:** HARD
**Package:** `src/connectors`

---

## Goal

After this phase notesd's `/mcp` server carries six new read-only tools (`expenses_schema`, `expenses_sql`, `runs_schema`, `runs_sql`, `seer_schema`, `seer_sql`), backed by one connector per system. Each connector reads its repo's `.env.local` on every call, connects only to the direct (non-pooler) host with `default_transaction_read_only=on`, runs every query inside `BEGIN READ ONLY`, and turns every failure into a short, secret-free tool error. Seer's `lab.sqlite` is read in a separate, killable process. A Docker harness builds one database per system from the sibling repos' own migrations, so phases 2–4 can write their curated tools against it. This phase also writes all 15 tool names and the no-op curated stubs that phases 2–4 replace.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates** (all new files; every name below is exported):

- `src/connectors/names.ts`: `CONNECTOR_SYSTEMS`, `SystemId`, `CONNECTOR_TOOL_NAMES`, `ConnectorToolName`, `ALL_CONNECTOR_TOOL_NAMES`, exactly as the index contract gives them. It also adds `SystemMeta`, `SYSTEM_META: Record<SystemId, SystemMeta>` (`{ id, label, repoDirEnv, defaultRepoDir, caption, hasLab }`), `schemaToolName(id)` and `sqlToolName(id)`.
- `src/connectors/types.ts`: `QueryResult`, `QueryOptions`, `ReadOnlySource`, `Connector`, and `ConnectorError` (constructor `(message: string)`), exactly as the contract gives them. It also adds:
  - `Connectors = Record<SystemId, Connector>`
  - `SystemAbout { summary: string; db: string; lab?: string }`
  - `CONNECTOR_DEFAULT_ROWS = 200`, `CONNECTOR_MAX_ROWS = 1000`, `CONNECTOR_DEFAULT_TIMEOUT_MS = 10_000`
- `src/connectors/errors.ts`: `scrub(text, secrets)`, `reasonOf(err)`, `unreachable(label, reason, secrets?)`, `queryFailed(label, reason, secrets?)`. The last two return a `ConnectorError` whose message is `"<label> is not reachable: …"` or `"<label> query failed: …"`.
- `src/connectors/env.ts`:
  - `SettingsSource`, `CONNECTOR_SETTINGS_FILE`, `connectorSettings(source?)`
  - `expandHome`, `displayPath`, `resolveRepoDir(id, settings)`, `connectorTimeoutMs(settings)`
  - `pickDirectUrl(vars)`, `prepareUrl(url)`, `secretsOf(url)`
  - `DatabaseTarget { url; secrets }`, `loadDatabaseTarget(id, repoDir)`
- `src/connectors/rows.ts`: `clampMaxRows`, `wrapWithLimit`, `stripTrailingSemicolons`, `capRows`, `int8Value`, `toObjects(result): Record<string, unknown>[]`.
- `src/connectors/pg.ts`: `startupOptions(timeoutMs)`, `CONNECTOR_PG_TYPES`, `PgRunOptions { cap; timeoutMs; wrap? }`, `runPgQuery(label, target, sql, params, opts)`.
- `src/connectors/lab.ts`: `LAB_CHILD_SOURCE`, `LabRunOptions { cap; timeoutMs; wrap? }`, `runLabQuery(label, labPath, sql, params, opts)`. Lab params use positional `?`.
- `src/connectors/guard.ts`: `SqlDialect = 'postgres' | 'sqlite'`, `SqlRefused`, `maskSql(sql, dialect)`, `guardSelect(sql, dialect): string` (returns the SQL without trailing `;`, or throws `SqlRefused`).
- `src/connectors/connector.ts`: `ConnectorOptions { repoDir?; labPath?; timeoutMs?; settings? }`, `createConnector(id, options?)`.
- `src/connectors/schema.ts`: `ColumnInfo`, `TableInfo`, `SchemaPart`, `describePgSchema(source, only?)`, `describeLabSchema(lab, only?)`, `registerSchemaTool(server, connector, about)`.
- `src/connectors/sql.ts`: `registerSqlTool(server, connector, about)`.
- `src/connectors/register.ts`: `defaultConnectors(): Connectors`, `registerConnectorTools(server: McpServer, connectors: Connectors): void`.
- Per-system modules:
  - `src/connectors/expenses/index.ts`: `EXPENSES_ABOUT`, `createExpensesConnector(options?)`
  - `src/connectors/runs/index.ts`: `RUNS_ABOUT`, `createRunsConnector(options?)`
  - `src/connectors/seer/index.ts`: `SEER_ABOUT`, `createSeerConnector(options?)`
- Curated stubs, no-op until phases 2–4 replace them:
  - `src/connectors/expenses/curated.ts`: `registerExpensesCurated(server: McpServer, connector: Connector): void`
  - `src/connectors/runs/curated.ts`: `registerRunsCurated(server, connector): void`
  - `src/connectors/seer/curated.ts`: `registerSeerCurated(server, connector): void`
- Test harness, `tests/integration/connectors/harness.ts`. Phases 2–4 use these names; signatures are exact:
  ```ts
  connectorsAdminUrl(): string                         // TEST_CONNECTORS_URL; throws when unset or Neon
  siblingRepo(id: SystemId): string | null              // repo path when its migrations exist, else null
  describeWithRepo(id: SystemId, name: string, fn: () => void): void   // describe.skip with a clear reason when absent
  systemDbName(id: SystemId): string                    // 'connectors_<id>'
  systemDbUrl(id: SystemId): string                     // WRITABLE admin (superuser) URL of that system's database
  truncateSystem(id: SystemId): Promise<void>           // TRUNCATE every public table RESTART IDENTITY CASCADE
  seedSystem(id: SystemId, sql: string, params?: readonly unknown[]): Promise<void>  // writable admin query on that DB
  withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T>            // writable admin client, refuses Neon
  interface ConnectorForOverrides { databaseUrl?: string; envLocal?: string | null; repoDir?: null; labPath?: string; timeoutMs?: number }
  connectorFor(id: SystemId, overrides?: ConnectorForOverrides): Connector  // real read-only connector over a temp repo dir with a generated .env.local
  type LabRow = Record<string, string | number | null>
  interface LabRows { methods?: LabRow[]; trials?: LabRow[]; trial_funding?: LabRow[]; insights?: LabRow[] }
  interface TempLab { path: string; dir: string }
  makeLab(rows?: LabRows): TempLab                      // temp lab.sqlite with meta, methods, trials, trial_funding, insights
  interface ConnectorClient { call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>; callError(name: string, args?: Record<string, unknown>): Promise<string>; listToolNames(): Promise<string[]>; close(): Promise<void> }
  connectorClient(connectors: Partial<Connectors>): Promise<ConnectorClient>  // in-memory MCP client over registerConnectorTools
  cleanupHarness(): void                                 // removes temp dirs made by connectorFor/makeLab
  ```
  The shared non-vitest half is in `tests/integration/connectors/siblings.ts` (`connectorsAdminUrl`, `siblingRepo`, `systemDbName`, `systemDbUrl`, `withAdmin`, `migrationFiles`, `migrationStatements`, `buildSystemDb`). `harness.ts` re-exports the public ones.
- `tests/integration/connectors/globalSetup.ts`: builds `connectors_expenses`, `connectors_runs` and `connectors_seer`.
- Script `npm run test:live:connectors`, env `CONNECTORS_LIVE_TEST=1`, env `TEST_CONNECTORS_URL`.
- Docker container `mcp-notes-pg-connectors` (`pgvector/pgvector:pg16`, **127.0.0.1:55435**).

**Signature changes** (all backward compatible):

- `ToolDeps` (`src/mcp/tools.ts:9`) gains `connectors?: Connectors`.
- `jsonResult(value)` becomes `jsonResult(value, compact = false)`.
- `run(fn)` becomes `run(fn, options: RunOptions = {})`, with `RunOptions { compact?: boolean }`.
- `errorResult(err)` returns the bare message for a `ConnectorError`. Other errors are unchanged.

**Requires (from earlier phases):** none.

**Leaves alone (owned by others):**

- Bodies of `src/connectors/{expenses,runs,seer}/curated.ts` beyond the stub, and any new sibling files in those directories (phases 2, 3, 4).
- `tests/integration/connectors/<id>.curated.int.test.ts` and `tests/unit/connectors/{expenses,runs,seer}*` (phases 2–4).
- `src/chat/**`, `claude/**`, and the README chat-bar and `/n` paragraphs (phase 5).
- `web/**` (phase 6).

**Notes for phases 2–4 (binding; the reconciler aligned phases 2–4 to exactly this):**

- Every curated handler is `run(() => …, { compact: true })`. Rows as arrays plus `compact` keeps results small.
- Keyed rows come from `toObjects(result)` in `src/connectors/rows.ts` (import `from '../rows.js'` inside `src/connectors/<id>/`). A phase may keep a local alias name (`rowsOf`, `rowsToObjects`) but must not re-implement it.
- Errors: a `ConnectorError` renders as its bare message (`"<label> is not reachable: …"` / `"<label> query failed: …"`); any other thrown `Error` renders as `error: <message>`. Tests match with `toContain` or an unanchored regex, so both forms pass.
- Type parsing on `connector.query` results: `int8` → number when safe, else string; `numeric` → number (string if not finite); `date`, `time`, `timestamp`, `timestamptz`, `interval`, `timetz` → the Postgres text (timestamptz in the session zone, e.g. `2026-10-30 12:00:00+07`); `json`/`jsonb` → parsed value (pg's default parser, not overridden); booleans → `true`/`false`. The session runs `TimeZone=Asia/Jakarta`.
- Never end curated SQL with `;` (stripped anyway); every statement must be valid as `SELECT * FROM (<sql>) AS q LIMIT <cap+1>`. Lab SQL uses positional `?` params (`null`, number, string), SQLite dialect, and returns integers as numbers (strings above 2^53).
- Harness helpers are all **synchronous except** `truncateSystem`, `seedSystem`, `withAdmin` and `connectorClient` (Promise-returning). `systemDbUrl(id)` is a sync, writable admin URL; `connectorFor(id, { labPath })` is sync; `makeLab(rows?)` is sync and returns `{ path, dir }` with the tables `meta`, `methods`, `trials`, `trial_funding`, `insights` already created (NOT NULL columns have defaults). Do not `await` the sync ones.
- Each integration file seeds its own data: `await truncateSystem(id)` then seed (via `seedSystem` or `withAdmin(systemDbUrl(id), …)`, both refuse Neon) in `beforeAll`/`beforeEach`, and call `cleanupHarness()` in `afterAll`. Integration files run one at a time but share the per-system databases, so nothing may rely on another file's rows.
- `truncateSystem('seer')` also wipes the roster rows that seer's own migrations insert into `strategies`. Seed your own.

## Deviation from the index (resolved)

The lab reader runs `node:sqlite` `DatabaseSync(path, { readOnly: true })` in a **short-lived child process** (`process.execPath -e <source>`) that is SIGKILLed at the timeout, not in a `worker_threads` worker: `Worker.terminate()` cannot interrupt native code, so a runaway `sqlite3_step` would keep spinning inside notesd. No new dependency, same `lab: ReadOnlySource` interface, read-only open, timeout and row cap; about 40–60 ms of process start per lab query. The index's Decisions row "lab.sqlite driver" already records this.

## Files

| File | Action | What changes |
|---|---|---|
| `src/connectors/names.ts` | create | 15 tool names, system metadata |
| `src/connectors/types.ts` | create | shared shapes, `ConnectorError`, limits |
| `src/connectors/errors.ts` | create | secret scrubbing, error constructors |
| `src/connectors/env.ts` | create | per-call settings, repo dir, `.env.local` parse, direct-host choice |
| `src/connectors/rows.ts` | create | row cap, LIMIT wrap, value helpers |
| `src/connectors/pg.ts` | create | read-only pg runner |
| `src/connectors/lab.ts` | create | read-only lab.sqlite runner (child process) |
| `src/connectors/guard.ts` | create | single-SELECT guard |
| `src/connectors/connector.ts` | create | `createConnector` |
| `src/connectors/schema.ts` | create | `<id>_schema` |
| `src/connectors/sql.ts` | create | `<id>_sql` |
| `src/connectors/register.ts` | create | `registerConnectorTools`, `defaultConnectors` |
| `src/connectors/{expenses,runs,seer}/index.ts` | create | about texts, factories |
| `src/connectors/{expenses,runs,seer}/curated.ts` | create | no-op stubs |
| `src/mcp/tools.ts` | modify (`:1-14`, `:120-136`) | `ToolDeps.connectors`, compact JSON, ConnectorError text |
| `src/mcp/server.ts` | modify (`:1-5`, `:16`) | call `registerConnectorTools` |
| `src/mcp/instructions.ts` | modify (`:1`, `:25-27`) | connectors paragraph |
| `tests/unit/mcp.instructions.test.ts` | modify (`:16`) | paragraph test |
| `vitest.config.ts` | modify (whole file) | live split, connectors globalSetup |
| `scripts/test-int.sh` | modify (whole file) | second container on 55435 |
| `package.json` | modify (`:61`) | `test:live:connectors` |
| `tests/integration/connectors/siblings.ts` | create | migration seeding, admin URLs |
| `tests/integration/connectors/globalSetup.ts` | create | build per-system DBs |
| `tests/integration/connectors/harness.ts` | create | the harness API |
| `tests/integration/connectors/core.int.test.ts` | create | read-only proof, cap, types, timeout, fail-soft, lab |
| `tests/integration/connectors/generic.int.test.ts` | create | `_schema`/`_sql` per system on migrated DBs |
| `tests/integration/connectors/mcp.int.test.ts` | create | real `/mcp`: 6 tools listed, isolation from notes tools |
| `tests/unit/connectors/names.test.ts` | create | names |
| `tests/unit/connectors/guard.test.ts` | create | guard |
| `tests/unit/connectors/rows.test.ts` | create | row cap |
| `tests/unit/connectors/env.test.ts` | create | env loading, scrubbing |
| `tests/unit/connectors/failsoft.test.ts` | create | fail-soft, lab runner |
| `tests/live/connectors.live.test.ts` | create | opt-in live `_schema` |
| `README.md` | modify (`:25`, `:223`, `:289-310`, `:345`, `:387`, `:414`) | Connectors section, tests, config |
| `docs/INSTALL.md` | modify (before `## Uninstall`, `:209`) | "5. Connectors" |

## Implementation Steps

### Step 1: Tool names and system metadata
**File:** `src/connectors/names.ts` (new)
**Code:**
```ts
/**
 * Every connector tool name, written once here. Phase 1 registers the generic `_schema` and
 * `_sql` tools; phases 2-4 register the curated ones; the chat bar (src/chat) imports
 * ALL_CONNECTOR_TOOL_NAMES for its allow list. Adding a fourth system is one more entry in each
 * table below plus one directory under src/connectors.
 */
export const CONNECTOR_SYSTEMS = ['expenses', 'runs', 'seer'] as const;
export type SystemId = (typeof CONNECTOR_SYSTEMS)[number];

export const CONNECTOR_TOOL_NAMES = {
  expenses: ['expenses_schema', 'expenses_sql', 'expenses_spending', 'expenses_get', 'expenses_months'],
  runs: ['runs_schema', 'runs_sql', 'runs_list', 'runs_get', 'runs_review'],
  seer: ['seer_schema', 'seer_sql', 'seer_leaderboard', 'seer_positions', 'seer_sera_best'],
} as const satisfies Record<SystemId, readonly string[]>;

export type ConnectorToolName = (typeof CONNECTOR_TOOL_NAMES)[SystemId][number];

/** All 15 names, flattened in the order above. */
export const ALL_CONNECTOR_TOOL_NAMES: readonly ConnectorToolName[] = CONNECTOR_SYSTEMS.flatMap(
  (id): ConnectorToolName[] => [...CONNECTOR_TOOL_NAMES[id]],
);

export interface SystemMeta {
  id: SystemId;
  /** Used in every error message: "<label> is not reachable: ...". */
  label: string;
  /** Environment / notes .env.local key that overrides the repo directory. */
  repoDirEnv: string;
  /** Default repo directory, ~-relative. */
  defaultRepoDir: string;
  /** Chat bar status caption for this system's tools. */
  caption: string;
  /** True when the system also has a lab.sqlite (Seer). */
  hasLab: boolean;
}

export const SYSTEM_META: Record<SystemId, SystemMeta> = {
  expenses: {
    id: 'expenses',
    label: 'expense-tracking',
    repoDirEnv: 'EXPENSE_TRACKING_DIR',
    defaultRepoDir: '~/expense-tracking',
    caption: 'reading expenses',
    hasLab: false,
  },
  runs: {
    id: 'runs',
    label: 'run-insights',
    repoDirEnv: 'RUN_INSIGHTS_DIR',
    defaultRepoDir: '~/run-insights',
    caption: 'reading runs',
    hasLab: false,
  },
  seer: {
    id: 'seer',
    label: 'seer',
    repoDirEnv: 'SEER_DIR',
    defaultRepoDir: '~/seer',
    caption: 'reading seer',
    hasLab: true,
  },
};

export function schemaToolName(id: SystemId): ConnectorToolName {
  return CONNECTOR_TOOL_NAMES[id][0];
}

export function sqlToolName(id: SystemId): ConnectorToolName {
  return CONNECTOR_TOOL_NAMES[id][1];
}
```
**Impact:** none yet. This is the single source for phases 2–5.

### Step 2: Shared shapes
**File:** `src/connectors/types.ts` (new)
**Code:**
```ts
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
```

### Step 3: Secret scrubbing and error constructors
**File:** `src/connectors/errors.ts` (new)
**Code:**
```ts
import { ConnectorError } from './types.js';

/** Secrets shorter than this are not scrubbed (they would mangle ordinary words). */
const MIN_SECRET_LENGTH = 3;
const MAX_REASON_LENGTH = 300;

/** Replaces every occurrence of every secret with ***, longest first. */
export function scrub(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const secret of ordered) out = out.split(secret).join('***');
  return out;
}

/** A one-line reason from any thrown value. Unwraps AggregateError (pg's dual-stack connect). */
export function reasonOf(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0 && !err.message) return reasonOf(err.errors[0]);
  let message = err instanceof Error ? err.message : String(err);
  if (!message && typeof err === 'object' && err !== null && 'code' in err) message = String((err as { code: unknown }).code);
  message = message.replace(/\s+/g, ' ').trim();
  if (message === '') return 'unknown error';
  return message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}...` : message;
}

export function unreachable(label: string, reason: string, secrets: readonly string[] = []): ConnectorError {
  return new ConnectorError(`${label} is not reachable: ${scrub(reason, secrets)}`);
}

export function queryFailed(label: string, reason: string, secrets: readonly string[] = []): ConnectorError {
  return new ConnectorError(`${label} query failed: ${scrub(reason, secrets)}`);
}
```

### Step 4: Per-call settings and `.env.local` loading
**File:** `src/connectors/env.ts` (new)
**Change:** settings are the four connector keys, read **per call** from the real environment merged over mcp-notes' own `.env.local`; the real environment wins. This matches how INSTALL.md describes every other setting, and a change applies without a restart. The sibling `.env.local` is parsed with dotenv `parse`. `process.env` is never written. The URL is the non-`-pooler` one, chosen by host, not key name.
**Code:**
```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { isPooledUrl, REPO_ROOT } from '../config.js';
import { reasonOf, unreachable } from './errors.js';
import { SYSTEM_META, type SystemId } from './names.js';
import { CONNECTOR_DEFAULT_TIMEOUT_MS } from './types.js';

/** mcp-notes' own .env.local: connector settings may live there, like every other notesd setting. */
export const CONNECTOR_SETTINGS_FILE = path.join(REPO_ROOT, '.env.local');

const SETTING_KEYS = ['EXPENSE_TRACKING_DIR', 'RUN_INSIGHTS_DIR', 'SEER_DIR', 'CONNECTOR_TIMEOUT_MS'] as const;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

export interface SettingsSource {
  /** Default process.env. Never mutated. */
  env?: NodeJS.ProcessEnv;
  /** Default CONNECTOR_SETTINGS_FILE; false skips it. A missing file is not an error. */
  envFile?: string | false;
}

/** The connector keys only, real env over the notes .env.local. Read on every call. */
export function connectorSettings(source: SettingsSource = {}): Record<string, string | undefined> {
  const env = source.env ?? process.env;
  const file = source.envFile ?? CONNECTOR_SETTINGS_FILE;
  let fromFile: Record<string, string> = {};
  if (file !== false && existsSync(file)) {
    try {
      fromFile = parseDotenv(readFileSync(file));
    } catch {
      fromFile = {};
    }
  }
  const out: Record<string, string | undefined> = {};
  for (const key of SETTING_KEYS) {
    const value = env[key]?.trim() || fromFile[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** For messages: home directory shown as ~. Paths are not secrets. */
export function displayPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function resolveRepoDir(id: SystemId, settings: Record<string, string | undefined>): string {
  const meta = SYSTEM_META[id];
  return path.resolve(expandHome(settings[meta.repoDirEnv] ?? meta.defaultRepoDir));
}

export function connectorTimeoutMs(settings: Record<string, string | undefined>): number {
  const raw = settings.CONNECTOR_TIMEOUT_MS;
  if (raw === undefined) return CONNECTOR_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) return CONNECTOR_DEFAULT_TIMEOUT_MS;
  return n;
}

/**
 * The direct (non-pooler) URL among DATABASE_URL / DATABASE_URL_UNPOOLED, chosen by host:
 * Neon poolers reject the startup options that make the session read-only. Falls back to
 * whichever exists.
 */
export function pickDirectUrl(vars: Record<string, string | undefined>): string | undefined {
  const candidates = [vars.DATABASE_URL, vars.DATABASE_URL_UNPOOLED]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v);
  return candidates.find((c) => !isPooledUrl(c)) ?? candidates[0];
}

/**
 * Drops an `options` query parameter (a parsed connection string overrides the client's own
 * `options`, which carry default_transaction_read_only) and spells sslmode=require/prefer as
 * verify-full, which is what pg already does with them, without its deprecation warning.
 */
export function prepareUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.searchParams.delete('options');
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode === 'require' || sslmode === 'prefer') url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

/** Strings that must never appear in an error: the URL, user, password, host. */
export function secretsOf(raw: string): string[] {
  const out = [raw];
  try {
    const url = new URL(raw);
    out.push(url.toString(), url.username, url.password, url.hostname, url.host);
    try {
      out.push(decodeURIComponent(url.username), decodeURIComponent(url.password));
    } catch {
      // undecodable: the encoded forms above are enough
    }
  } catch {
    // not a URL: the raw string is the secret
  }
  return out.filter((s) => s.length > 0);
}

export interface DatabaseTarget {
  url: string;
  secrets: string[];
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Reads <repoDir>/.env.local now (never cached) and picks the direct URL. Throws "not reachable". */
export function loadDatabaseTarget(id: SystemId, repoDir: string): DatabaseTarget {
  const { label } = SYSTEM_META[id];
  if (!isDirectory(repoDir)) throw unreachable(label, `no repository at ${displayPath(repoDir)}`);
  const file = path.join(repoDir, '.env.local');
  if (!existsSync(file)) throw unreachable(label, `no .env.local in ${displayPath(repoDir)}`);
  let vars: Record<string, string>;
  try {
    vars = parseDotenv(readFileSync(file));
  } catch (err) {
    throw unreachable(label, `cannot read ${displayPath(file)}: ${reasonOf(err)}`);
  }
  const raw = pickDirectUrl(vars);
  if (!raw) throw unreachable(label, `${displayPath(file)} has no DATABASE_URL or DATABASE_URL_UNPOOLED`);
  const url = prepareUrl(raw);
  return { url, secrets: [...secretsOf(raw), ...secretsOf(url)] };
}
```

### Step 5: Row helpers
**File:** `src/connectors/rows.ts` (new)
**Code:**
```ts
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
```

### Step 6: Read-only Postgres runner
**File:** `src/connectors/pg.ts` (new)
**Change:** a fresh `pg.Client` per call. Startup `options` set the session read-only, the statement timeout and Jakarta time. The query runs as `BEGIN READ ONLY` → query → `ROLLBACK`. A failure during connect means "not reachable"; any later failure means "query failed". Both messages are scrubbed. A no-op `error` listener means a server-side disconnect can never become an uncaught exception in notesd.
**Code:**
```ts
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
```
**Impact:** none outside connectors.

### Step 7: Read-only lab.sqlite runner (child process)
**File:** `src/connectors/lab.ts` (new)
**Change:** see "Deviation" above. The child gets an empty environment and the request on stdin, and writes one JSON reply. Open failures come back as `stage: 'open'` ("not reachable"); everything else is "query failed".
**Code:**
```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { displayPath } from './env.js';
import { queryFailed, reasonOf, unreachable } from './errors.js';
import { capRows, wrapWithLimit } from './rows.js';
import type { QueryResult } from './types.js';

/**
 * Plain CommonJS, run with `node --no-warnings -e`. Opens the file with readOnly: true (no
 * write lock, safe while Seer's own processes use it), runs one statement, replies on stdout.
 */
export const LAB_CHILD_SOURCE = String.raw`
const chunks = [];
const reply = (v) => process.stdout.write(JSON.stringify(v));
function norm(v) {
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (v instanceof Uint8Array) return '<blob ' + v.length + ' bytes>';
  return v;
}
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let req;
  try {
    req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    reply({ ok: false, stage: 'query', message: 'bad request to the lab reader' });
    return;
  }
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    reply({ ok: false, stage: 'open', message: 'node:sqlite is not available: ' + String((e && e.message) || e) });
    return;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(req.path, { readOnly: true });
  } catch (e) {
    reply({ ok: false, stage: 'open', message: String((e && e.message) || e) });
    return;
  }
  try {
    const stmt = db.prepare(req.sql);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows = stmt.all(...req.params).map((row) => row.map(norm));
    reply({ ok: true, columns, rows });
  } catch (e) {
    reply({ ok: false, stage: 'query', message: String((e && e.message) || e) });
  } finally {
    try { db.close(); } catch (e) {}
  }
});
`;

interface LabReply {
  ok: boolean;
  stage?: 'open' | 'query';
  message?: string;
  columns?: string[];
  rows?: unknown[][];
}

export interface LabRunOptions {
  cap: number;
  timeoutMs: number;
  /** false runs `sql` as given (tests prove the file refuses writes). Default true. */
  wrap?: boolean;
}

export function runLabQuery(
  label: string,
  labPath: string,
  sql: string,
  params: readonly unknown[],
  opts: LabRunOptions,
): Promise<QueryResult> {
  if (!existsSync(labPath)) {
    return Promise.reject(unreachable(label, `no lab database at ${displayPath(labPath)}`));
  }
  return new Promise<QueryResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '-e', LAB_CHILD_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(queryFailed(label, `lab query timed out after ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) =>
      finish(() => reject(unreachable(label, `cannot start the lab reader: ${reasonOf(err)}`))),
    );
    child.on('close', (code) =>
      finish(() => {
        let msg: LabReply;
        try {
          msg = JSON.parse(stdout) as LabReply;
        } catch {
          reject(queryFailed(label, `lab reader exited with ${code}: ${reasonOf(stderr.slice(0, 300))}`));
          return;
        }
        if (!msg.ok) {
          const reason = msg.message ?? 'unknown error';
          reject(
            msg.stage === 'open'
              ? unreachable(label, `cannot open ${displayPath(labPath)}: ${reason}`)
              : queryFailed(label, reason),
          );
          return;
        }
        resolve(capRows(msg.columns ?? [], msg.rows ?? [], opts.cap));
      }),
    );
    // The child may exit before reading stdin (killed): ignore EPIPE.
    child.stdin.on('error', () => {});
    const text = opts.wrap === false ? sql : wrapWithLimit(sql, opts.cap);
    child.stdin.end(JSON.stringify({ path: labPath, sql: text, params: [...params] }));
  });
}
```

### Step 8: SQL guard
**File:** `src/connectors/guard.ts` (new)
**Change:** comments, string literals, dollar quotes and quoted identifiers are masked to spaces, at the same length, before scanning. An unterminated literal or comment is refused. After trailing `;` are removed, any `;` left means more than one statement. The first word must be `SELECT` or `WITH`; a leading `(` is allowed. Only these can embed writes in a single SELECT, and all are refused: data-modifying CTEs, `SELECT INTO`, row locks, and side-effect functions. DDL and utility words named in the brief are refused too. `nextval(` is deliberately **not** refused: the integration test needs it to reach the database and fail there.
**Code:**
```ts
export type SqlDialect = 'postgres' | 'sqlite';

/** The guard's refusal; the _sql tool turns it into "<label> query failed: refused before reaching the database: ...". */
export class SqlRefused extends Error {
  override name = 'SqlRefused';
}

/** Words that write, change schema, or control transactions. None belongs in one read-only SELECT. */
const FORBIDDEN_WORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'into',
  'truncate', 'create', 'alter', 'drop', 'grant', 'revoke', 'copy',
  'vacuum', 'reindex', 'refresh', 'listen', 'unlisten', 'notify',
  'prepare', 'execute', 'deallocate',
  'attach', 'detach', 'pragma',
  'begin', 'commit', 'rollback', 'savepoint', 'checkpoint',
]);

/** Functions with effects outside the query that a read-only transaction does not stop. */
const FORBIDDEN_FUNCTIONS = new Set([
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
  'set_config', 'pg_notify', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export', 'load_extension',
]);
const FORBIDDEN_FUNCTION_PREFIXES = ['pg_advisory_', 'pg_try_advisory_', 'dblink'];

function isForbiddenFunction(word: string): boolean {
  return FORBIDDEN_FUNCTIONS.has(word) || FORBIDDEN_FUNCTION_PREFIXES.some((p) => word.startsWith(p));
}

/** Index just past the closing quote, or -1 when unterminated. Doubled quotes are escapes. */
function scanQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (backslashEscapes && c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Same-length copy of `sql` with comments, literals and quoted identifiers blanked out. */
export function maskSql(sql: string, dialect: SqlDialect): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (dialect === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      if (depth > 0) throw new SqlRefused('unterminated /* comment');
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === "'") {
      const prev = sql[i - 1] ?? '';
      const beforePrev = sql[i - 2] ?? '';
      const escapeString = dialect === 'postgres' && /[eE]/.test(prev) && !IDENT_CHAR.test(beforePrev);
      const j = scanQuoted(sql, i, "'", escapeString);
      if (j === -1) throw new SqlRefused('unterminated string literal');
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '"' || (dialect === 'sqlite' && ch === '`')) {
      const j = scanQuoted(sql, i, ch, false);
      if (j === -1) throw new SqlRefused('unterminated quoted identifier');
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (dialect === 'sqlite' && ch === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close === -1) throw new SqlRefused('unterminated [identifier]');
      out += ' '.repeat(close + 1 - i);
      i = close + 1;
      continue;
    }
    if (dialect === 'postgres' && ch === '$' && !IDENT_CHAR.test(sql[i - 1] ?? '')) {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new SqlRefused('unterminated dollar-quoted string');
        const stop = end + tag.length;
        out += ' '.repeat(stop - i);
        i = stop;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Accepts exactly one read-only SELECT (or WITH ... SELECT) and returns it without trailing
 * semicolons. Throws SqlRefused otherwise. The database is still read-only underneath; this
 * only keeps obvious writes and multi-statements from reaching it.
 */
export function guardSelect(sql: string, dialect: SqlDialect): string {
  const masked = maskSql(sql, dialect);
  let end = masked.length;
  while (end > 0 && /[\s;]/.test(masked[end - 1]!)) end--;
  const body = masked.slice(0, end);
  if (body.trim() === '') throw new SqlRefused('the query is empty');
  if (body.includes(';')) throw new SqlRefused('only one statement is allowed; remove the extra ";"');
  const first = /^[\s(]*([A-Za-z_]+)/.exec(body)?.[1]?.toLowerCase();
  if (first !== 'select' && first !== 'with') {
    throw new SqlRefused(`only SELECT or WITH ... SELECT is allowed, not ${first ? first.toUpperCase() : 'this statement'}`);
  }
  for (const m of body.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
    const word = m[0].toLowerCase();
    if (FORBIDDEN_WORDS.has(word)) {
      throw new SqlRefused(`${word.toUpperCase()} is not allowed: the connectors are read-only`);
    }
    const isCall = /^\s*\(/.test(body.slice((m.index ?? 0) + m[0].length));
    if (isCall && isForbiddenFunction(word)) {
      throw new SqlRefused(`${word}() is not allowed: it has effects outside a read-only query`);
    }
  }
  if (/\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i.test(body)) {
    throw new SqlRefused('row locks (FOR UPDATE / FOR SHARE) are not allowed');
  }
  return sql.slice(0, end).trim();
}
```

### Step 9: The connector factory
**File:** `src/connectors/connector.ts` (new)
**Code:**
```ts
import path from 'node:path';
import { connectorSettings, connectorTimeoutMs, loadDatabaseTarget, resolveRepoDir, type SettingsSource } from './env.js';
import { runLabQuery } from './lab.js';
import { SYSTEM_META, type SystemId } from './names.js';
import { runPgQuery } from './pg.js';
import { clampMaxRows, stripTrailingSemicolons } from './rows.js';
import type { Connector, QueryOptions } from './types.js';

export interface ConnectorOptions {
  /** Fixed repo dir (tests). Default: the settings override or ~/<repo>, resolved on every call. */
  repoDir?: string;
  /** Fixed lab.sqlite path (tests). Default: <repo dir>/lab/lab.sqlite. Seer only. */
  labPath?: string;
  /** Fixed statement timeout (tests). Default: CONNECTOR_TIMEOUT_MS, read on every call. */
  timeoutMs?: number;
  /** Where settings come from. Default: process.env over the notes .env.local. */
  settings?: SettingsSource;
}

/**
 * A connector holds no state: every query re-reads settings and the repo's .env.local, opens
 * one connection (or one lab reader), and closes it. Rotated credentials work without a restart.
 */
export function createConnector(id: SystemId, options: ConnectorOptions = {}): Connector {
  const meta = SYSTEM_META[id];
  const perCall = (): { repoDir: string; timeoutMs: number } => {
    const settings = connectorSettings(options.settings);
    return {
      repoDir: options.repoDir ?? resolveRepoDir(id, settings),
      timeoutMs: options.timeoutMs ?? connectorTimeoutMs(settings),
    };
  };
  const connector: Connector = {
    id,
    label: meta.label,
    async query(sql: string, params: readonly unknown[] = [], queryOptions: QueryOptions = {}) {
      const { repoDir, timeoutMs } = perCall();
      const target = loadDatabaseTarget(id, repoDir);
      return runPgQuery(meta.label, target, stripTrailingSemicolons(sql), params, {
        cap: clampMaxRows(queryOptions.maxRows),
        timeoutMs,
      });
    },
  };
  if (meta.hasLab) {
    connector.lab = {
      async query(sql: string, params: readonly unknown[] = [], queryOptions: QueryOptions = {}) {
        const { repoDir, timeoutMs } = perCall();
        const labPath = options.labPath ?? path.join(repoDir, 'lab', 'lab.sqlite');
        return runLabQuery(meta.label, labPath, stripTrailingSemicolons(sql), params, {
          cap: clampMaxRows(queryOptions.maxRows),
          timeoutMs,
        });
      },
    };
  }
  return connector;
}
```

### Step 10: Per-system modules and curated stubs
**File:** `src/connectors/expenses/index.ts` (new)
```ts
import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

export const EXPENSES_ABOUT: SystemAbout = {
  summary: "the owner's spending in rupiah, parsed from pasted text, with categories and receipt photos",
  db:
    'expense_groups is one purchase or receipt: occurred_on is the calendar day in Asia/Jakarta (WIB), plus title, note and raw_text (the pasted text). ' +
    'expense_items are its line items: amount_idr is whole rupiah (bigint, never negative), category is one of 17 slugs (meals, jajan, dining, snacks, drinks, transport, fuel, parking, bills, internet, utilities, housing, entertainment, cinema, health, grooming, other), sort_order orders them. ' +
    'expense_photos are receipt photos (blob_url, width, height). Totals are never stored: sum expense_items.amount_idr. ' +
    "A month is [YYYY-MM-01, next month's 01) on occurred_on. expense_insights holds the app's cached written summaries (week_text, month_text, two_month_text, generated_at). " +
    'Every table is scoped by user_id; the app has one owner. user, account, session, verificationToken and the share-link tables carry no spending data.',
};

export function createExpensesConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('expenses', options);
}
```
**File:** `src/connectors/runs/index.ts` (new)
```ts
import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

export const RUNS_ABOUT: SystemAbout = {
  summary: "the owner's Apple Watch runs (pace, distance, heart rate, splits), weekly and monthly reviews, and the coach Nina",
  db:
    'runs is one run: occurred_on is the calendar day in Asia/Jakarta (WIB), started_at/ended_at are local wall-clock times, distance_m metres, duration_sec seconds, avg_pace_sec seconds per km, avg_hr/max_hr/resting_hr/end_hr_bpm/hr_1min_post_bpm bpm, elevation_m metres, active_kcal/total_kcal, avg_cadence, intent (easy, tempo, long, race, unspecified), note. ' +
    "Only runs with reviewed_at IS NOT NULL count in the app's lists and totals. " +
    'run_splits: one row per km (time_sec, pace_sec, hr, cadence; partial marks the last partial km). run_zones: heart-rate zones 1-5 (duration_sec, min_bpm, max_bpm). ' +
    "insights is the app's own analysis: scope session/week/month, scope_key = run id / YYYY-Www (ISO week, Monday-Sunday) / YYYY-MM, payload jsonb {headline, verdict, whatHappened, observations[{title, detail, metric}], doNext[], questionForRunner}; several rows per key, the newest created_at wins. " +
    'profiles: max_hr, resting_hr, weight_kg. records and badges: personal bests and awards. nina_* tables: the coach Nina (chat sessions, messages with role runner/nina, memory). Every table is scoped by user_id; the app has one owner.',
};

export function createRunsConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('runs', options);
}
```
**File:** `src/connectors/seer/index.ts` (new)
```ts
import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

export const SEER_ABOUT: SystemAbout = {
  summary: "the owner's quantitative trading lab: paper strategies, positions, trades, a leaderboard, and Sera, the method lab (lab.sqlite)",
  db:
    'strategies: id (e.g. RAW35-FR-GT), name, sub, engine (bracket, book, benchmark), status (active, retired), is_champion, is_benchmark, paper_start/paper_end, promoted_from (the lab method id), params jsonb. ' +
    'equity_snapshots: daily cash_usd and equity_usd per strategy. orders: bracket-engine picks (status pending/open/closed/expired, entry/stop/target prices, fill_price, pnl_usd, mark). ' +
    'book_positions: open holdings of book-engine strategies; book_trades: closed book trades; book_fills: fills. bars: daily prices; fx_rates: usd_idr. sean_*: the owner\'s own real trades. ' +
    'Money is US dollars (numeric); returns are fractions (0.05 = 5%); date columns are NYSE session dates (America/New_York). The leaderboard is not stored: it is computed from equity_snapshots and closed P&L.',
  lab:
    'lab.sqlite is Sera, the method lab. methods: one research idea (id M0001... or H-*, name, family, hypothesis, status idea/registered/rejected/dev-eligible/promoted/test-passed/test-failed/paper/blocked-data, analysis, verdict). ' +
    'trials: one backtest of a candidate variant of a method: n, method_id, candidate_id, window (dev or test), start/end, run_at, total_return, cagr, max_drawdown, profit_factor, trades, sharpe, mar (CAGR over max drawdown), dsr (deflated Sharpe), n_trials_at_run, spy_tr_return/spy_tr_cagr (SPY total-return benchmark), eligible (the verdict frozen at run time), failed (reasons). ' +
    "The lab's best variant per method is its dev trial with the highest mar (ties: lowest n). trial_funding: money-weighted returns under a deposit schedule (mwr, spy_tr_mwr). insights: the lab journal. Returns are fractions; the tables are append-only. Query it with seer_sql source \"lab\" (SQLite dialect).",
};

export function createSeerConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('seer', options);
}
```
**Files:** `src/connectors/expenses/curated.ts`, `src/connectors/runs/curated.ts`, `src/connectors/seer/curated.ts` (new). These are the stubs. Each file is the block below with its own names: `registerExpensesCurated`, `registerRunsCurated`, `registerSeerCurated`; phase 2, 3 or 4 in the comment; and its own tool names.
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Connector } from '../types.js';

/**
 * expense-tracking's curated tools (expenses_spending, expenses_get, expenses_months).
 * Phase 1 stub: registers nothing. Phase 2 replaces this file.
 */
export function registerExpensesCurated(_server: McpServer, _connector: Connector): void {}
```
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Connector } from '../types.js';

/**
 * run-insights' curated tools (runs_list, runs_get, runs_review).
 * Phase 1 stub: registers nothing. Phase 3 replaces this file.
 */
export function registerRunsCurated(_server: McpServer, _connector: Connector): void {}
```
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Connector } from '../types.js';

/**
 * Seer's curated tools (seer_leaderboard, seer_positions, seer_sera_best).
 * Phase 1 stub: registers nothing. Phase 4 replaces this file.
 */
export function registerSeerCurated(_server: McpServer, _connector: Connector): void {}
```

### Step 11: `tools.ts`: ToolDeps, compact JSON, ConnectorError text
**File:** `src/mcp/tools.ts:1-14` and `:120-136`
**Change:** add the import after line 7, `connectors?` to `ToolDeps`, and replace `jsonResult`/`errorResult`/`run` (lines 120–136).
**Code:** add the import after `import { NoteError } from '../notes/types.js';`:
```ts
import { ConnectorError, type Connectors } from '../connectors/types.js';
```
`ToolDeps` becomes:
```ts
export interface ToolDeps {
  service: NotesService;
  dataDir: string;
  /** Read-only use by phase 5's image tools (raw image records); writes still go through `service`. */
  db: Db;
  /** Connectors for the connector tools. Omitted: defaultConnectors() (sibling repos, read per call). Tests inject their own. */
  connectors?: Connectors;
}
```
Lines 120–136 become:
```ts
/** compact: no indentation (connector rows are arrays; indenting them multiplies the size). */
export function jsonResult(value: unknown, compact = false): CallToolResult {
  return { content: [{ type: 'text', text: compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const text =
    err instanceof NoteError
      ? `${err.code}: ${err.message}`
      : err instanceof ConnectorError
        ? err.message
        : `error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

export interface RunOptions {
  /** Compact JSON (connector tools). Default false. */
  compact?: boolean;
}

/** Runs a handler and turns any thrown error into an MCP error result Claude can read. */
export async function run(fn: () => Promise<unknown>, options: RunOptions = {}): Promise<CallToolResult> {
  try {
    return jsonResult(await fn(), options.compact ?? false);
  } catch (err) {
    return errorResult(err);
  }
}
```
**Impact:** existing callers are unchanged: `run(fn)` and `jsonResult(v)` still pretty-print.

### Step 12: `<id>_schema`
**File:** `src/connectors/schema.ts` (new)
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../mcp/tools.js';
import { schemaToolName, sqlToolName } from './names.js';
import { toObjects } from './rows.js';
import { CONNECTOR_MAX_ROWS, type Connector, type ReadOnlySource, type SystemAbout } from './types.js';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  comment?: string;
  primary_key?: true;
}

export interface TableInfo {
  name: string;
  kind: 'table' | 'view' | 'materialized view';
  comment?: string;
  /** Planner estimate; null when the table was never analysed. Postgres only. */
  approx_rows?: number | null;
  columns: ColumnInfo[];
  /** Primary key, unique and foreign key definitions. Postgres only. */
  constraints?: string[];
}

export interface SchemaPart {
  source: 'db' | 'lab';
  about: string;
  tables: TableInfo[];
}

/** One row per table (columns aggregated), so the row cap counts tables, not columns. */
const PG_TABLES_SQL = `
SELECT c.relname AS name,
       CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
       obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS approx_rows,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'name', a.attname,
                  'type', format_type(a.atttypid, a.atttypmod),
                  'nullable', NOT a.attnotnull,
                  'default', pg_get_expr(d.adbin, d.adrelid),
                  'comment', col_description(c.oid, a.attnum)
                ) ORDER BY a.attnum)
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       ), '[]'::json) AS columns,
       COALESCE((
         SELECT json_agg(pg_get_constraintdef(k.oid) ORDER BY k.contype, k.conname)
           FROM pg_constraint k
          WHERE k.conrelid = c.oid AND k.contype IN ('p', 'u', 'f')
       ), '[]'::json) AS constraints
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
 ORDER BY c.relname`;

const LAB_TABLES_SQL = `
SELECT m.name AS table_name, m.type AS kind, p.cid AS cid, p.name AS column_name, p.type AS column_type,
       p."notnull" AS not_null, p.dflt_value AS default_value, p.pk AS pk
  FROM sqlite_master AS m
  JOIN pragma_table_info(m.name) AS p
 WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
 ORDER BY m.name, p.cid`;

interface RawPgColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

function wantedSet(only?: readonly string[]): Set<string> | null {
  return only && only.length > 0 ? new Set(only.map((t) => t.toLowerCase())) : null;
}

export async function describePgSchema(source: ReadOnlySource, only?: readonly string[]): Promise<TableInfo[]> {
  const wanted = wantedSet(only);
  const result = await source.query(PG_TABLES_SQL, [], { maxRows: CONNECTOR_MAX_ROWS });
  return toObjects(result)
    .filter((r) => wanted === null || wanted.has(String(r.name).toLowerCase()))
    .map((r) => {
      const columns = ((r.columns as RawPgColumn[] | null) ?? []).map((c) => {
        const col: ColumnInfo = { name: c.name, type: c.type, nullable: c.nullable };
        if (c.default !== null) col.default = c.default;
        if (c.comment !== null) col.comment = c.comment;
        return col;
      });
      const table: TableInfo = {
        name: String(r.name),
        kind: r.kind as TableInfo['kind'],
        approx_rows: (r.approx_rows as number | null) ?? null,
        columns,
      };
      if (typeof r.comment === 'string') table.comment = r.comment;
      const constraints = (r.constraints as string[] | null) ?? [];
      if (constraints.length > 0) table.constraints = constraints;
      return table;
    });
}

export async function describeLabSchema(lab: ReadOnlySource, only?: readonly string[]): Promise<TableInfo[]> {
  const wanted = wantedSet(only);
  const result = await lab.query(LAB_TABLES_SQL, [], { maxRows: CONNECTOR_MAX_ROWS });
  const tables = new Map<string, TableInfo>();
  for (const r of toObjects(result)) {
    const name = String(r.table_name);
    if (wanted !== null && !wanted.has(name.toLowerCase())) continue;
    let table = tables.get(name);
    if (!table) {
      table = { name, kind: r.kind === 'view' ? 'view' : 'table', columns: [] };
      tables.set(name, table);
    }
    const col: ColumnInfo = {
      name: String(r.column_name),
      type: r.column_type ? String(r.column_type) : 'ANY',
      nullable: Number(r.not_null) === 0,
    };
    if (r.default_value !== null && r.default_value !== undefined) col.default = String(r.default_value);
    if (Number(r.pk) > 0) col.primary_key = true;
    table.columns.push(col);
  }
  return [...tables.values()];
}

async function dbPart(source: ReadOnlySource, about: SystemAbout, tables?: readonly string[]): Promise<SchemaPart> {
  return { source: 'db', about: about.db, tables: await describePgSchema(source, tables) };
}

async function labPart(lab: ReadOnlySource, about: SystemAbout, tables?: readonly string[]): Promise<SchemaPart> {
  return { source: 'lab', about: about.lab ?? '', tables: await describeLabSchema(lab, tables) };
}

function settledPart(r: PromiseSettledResult<SchemaPart>): SchemaPart | { error: string } {
  if (r.status === 'fulfilled') return r.value;
  return { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
}

const tablesField = z
  .array(z.string().min(1))
  .max(100)
  .optional()
  .describe('Only these tables (exact names). Omit for every table.');

export function registerSchemaTool(server: McpServer, connector: Connector, about: SystemAbout): void {
  const name = schemaToolName(connector.id);
  const sqlName = sqlToolName(connector.id);
  const label = connector.label;
  const lab = connector.lab;
  const base = `Tables, columns, types and what they mean in ${label}: ${about.summary}. Read-only, built from the live database`;

  if (lab === undefined) {
    server.registerTool(
      name,
      {
        title: `${label} schema`,
        description: `${base}. Call it before writing a ${sqlName} query; pass tables to keep the answer short. Prefer the curated ${connector.id}_ tools for common questions.`,
        inputSchema: { tables: tablesField },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ tables }) => run(async () => ({ system: label, ...(await dbPart(connector, about, tables)) }), { compact: true }),
    );
    return;
  }

  server.registerTool(
    name,
    {
      title: `${label} schema`,
      description: `${base}, and from lab.sqlite (Sera, the method lab). source "db", "lab" or "both" (default). Call it before writing a ${sqlName} query; pass tables to keep the answer short. Prefer the curated ${connector.id}_ tools for common questions.`,
      inputSchema: {
        tables: tablesField,
        source: z
          .enum(['db', 'lab', 'both'])
          .optional()
          .describe('"db" = the Postgres database, "lab" = lab.sqlite, "both" (default).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tables, source }) =>
      run(
        async () => {
          const which = source ?? 'both';
          if (which === 'db') return { system: label, ...(await dbPart(connector, about, tables)) };
          if (which === 'lab') return { system: label, ...(await labPart(lab, about, tables)) };
          const [db, labResult] = await Promise.allSettled([dbPart(connector, about, tables), labPart(lab, about, tables)]);
          if (db.status === 'rejected' && labResult.status === 'rejected') throw db.reason;
          return { system: label, db: settledPart(db), lab: settledPart(labResult) };
        },
        { compact: true },
      ),
  );
}
```

### Step 13: `<id>_sql`
**File:** `src/connectors/sql.ts` (new)
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { run } from '../mcp/tools.js';
import { queryFailed } from './errors.js';
import { guardSelect, SqlRefused } from './guard.js';
import { schemaToolName, sqlToolName } from './names.js';
import { CONNECTOR_DEFAULT_ROWS, CONNECTOR_MAX_ROWS, ConnectorError, type Connector, type SystemAbout } from './types.js';

interface SqlArgs {
  sql: string;
  max_rows?: number | undefined;
  source?: 'db' | 'lab' | undefined;
}

const maxRowsField = z
  .number()
  .int()
  .min(1)
  .max(CONNECTOR_MAX_ROWS)
  .optional()
  .describe(`Row cap, 1-${CONNECTOR_MAX_ROWS}. Default ${CONNECTOR_DEFAULT_ROWS}. truncated: true in the result means more rows existed.`);

function sqlHandler(connector: Connector): (args: SqlArgs) => Promise<CallToolResult> {
  return async ({ sql, max_rows, source }) =>
    run(
      async () => {
        const useLab = source === 'lab';
        const target = useLab ? connector.lab : connector;
        if (target === undefined) throw new ConnectorError(`${connector.label} has no lab database`);
        let checked: string;
        try {
          checked = guardSelect(sql, useLab ? 'sqlite' : 'postgres');
        } catch (err) {
          if (err instanceof SqlRefused) throw queryFailed(connector.label, `refused before reaching the database: ${err.message}`);
          throw err;
        }
        return target.query(checked, [], { maxRows: max_rows ?? CONNECTOR_DEFAULT_ROWS });
      },
      { compact: true },
    );
}

export function registerSqlTool(server: McpServer, connector: Connector, about: SystemAbout): void {
  const name = sqlToolName(connector.id);
  const label = connector.label;
  const base =
    `One read-only SELECT (or WITH ... SELECT) against ${label}: ${about.summary}. ` +
    `Use it only when the curated ${connector.id}_ tools do not answer; read ${schemaToolName(connector.id)} first. ` +
    'Writes, DDL and several statements are refused, and the connection itself is read-only. ' +
    'Returns {columns, rows (arrays aligned with columns), row_count, truncated}. Dates come back as text in Asia/Jakarta.';
  const sqlField = z.string().min(1).describe('A single SELECT or WITH ... SELECT. No semicolon-separated statements.');

  if (connector.lab === undefined) {
    server.registerTool(
      name,
      {
        title: `${label} SQL (read-only)`,
        description: `${base} Postgres dialect.`,
        inputSchema: { sql: sqlField, max_rows: maxRowsField },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      sqlHandler(connector),
    );
    return;
  }

  server.registerTool(
    name,
    {
      title: `${label} SQL (read-only)`,
      description: `${base} source "db" (default, Postgres dialect) or "lab" (lab.sqlite, SQLite dialect).`,
      inputSchema: {
        sql: sqlField,
        max_rows: maxRowsField,
        source: z.enum(['db', 'lab']).optional().describe('"db" (default): the Seer Postgres database. "lab": lab.sqlite, the Sera method lab.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    sqlHandler(connector),
  );
}
```

### Step 14: Registration
**File:** `src/connectors/register.ts` (new)
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExpensesCurated } from './expenses/curated.js';
import { createExpensesConnector, EXPENSES_ABOUT } from './expenses/index.js';
import { CONNECTOR_SYSTEMS, type SystemId } from './names.js';
import { registerRunsCurated } from './runs/curated.js';
import { createRunsConnector, RUNS_ABOUT } from './runs/index.js';
import { registerSchemaTool } from './schema.js';
import { registerSeerCurated } from './seer/curated.js';
import { createSeerConnector, SEER_ABOUT } from './seer/index.js';
import { registerSqlTool } from './sql.js';
import type { Connectors, SystemAbout } from './types.js';

const ABOUT: Record<SystemId, SystemAbout> = {
  expenses: EXPENSES_ABOUT,
  runs: RUNS_ABOUT,
  seer: SEER_ABOUT,
};

/** The owner's three repos (~/expense-tracking, ~/run-insights, ~/seer or their overrides), resolved per call. */
export function defaultConnectors(): Connectors {
  return {
    expenses: createExpensesConnector(),
    runs: createRunsConnector(),
    seer: createSeerConnector(),
  };
}

/** Registers <id>_schema and <id>_sql for every system, then each system's curated tools. */
export function registerConnectorTools(server: McpServer, connectors: Connectors): void {
  for (const id of CONNECTOR_SYSTEMS) {
    registerSchemaTool(server, connectors[id], ABOUT[id]);
    registerSqlTool(server, connectors[id], ABOUT[id]);
  }
  registerExpensesCurated(server, connectors.expenses);
  registerRunsCurated(server, connectors.runs);
  registerSeerCurated(server, connectors.seer);
}
```

### Step 15: Wire into the MCP server
**File:** `src/mcp/server.ts:1-5`, `:16`
**Code:** the imports become:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defaultConnectors, registerConnectorTools } from '../connectors/register.js';
import { registerImageTools } from './imageTools.js';
import { buildInstructions } from './instructions.js';
import { registerNoteTools, type ToolDeps } from './tools.js';
```
`createMcpServer` becomes:
```ts
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions() },
  );
  registerNoteTools(server, deps);
  registerImageTools(server, deps);
  // Lazy: nothing is read or connected until a connector tool is called.
  registerConnectorTools(server, deps.connectors ?? defaultConnectors());
  return server;
}
```
**Impact:** `tools/list` gains 6 tools. `tests/integration/mcp.tools.int.test.ts:82` uses `arrayContaining`, so it still passes. The `description.length > 40` loop at `:85` passes, since every new description is longer. `src/http/app.ts` is unchanged; `connectors` is omitted there, so defaults apply.

### Step 16: Instructions paragraph and its test
**File:** `src/mcp/instructions.ts:1` (add import) and `:25-27` (append one element after the `Images.` element, before `];`)
**Code:** at the top of the file:
```ts
import { CONNECTOR_SYSTEMS, CONNECTOR_TOOL_NAMES } from '../connectors/names.js';
```
Add a new last element of `sections`, after the `Images. …` template string:
```ts
    `Connectors. The same server also reads three of the user's own apps, strictly read-only (nothing there can be changed from here): expenses_* is expense-tracking (spending parsed from pasted text, in rupiah, with categories and receipt photos), runs_* is run-insights (Apple Watch runs with pace, distance, heart rate and splits, weekly and monthly reviews, and the coach Nina), seer_* is Seer (a quantitative trading lab: strategies, positions, trades, a leaderboard, and Sera, the method lab, in lab.sqlite). Prefer the curated tools (${CONNECTOR_SYSTEMS.flatMap((id) => CONNECTOR_TOOL_NAMES[id].slice(2)).join(', ')}); use <system>_sql (one read-only SELECT, row-capped; seer_sql takes source "db" or "lab") only when they don't answer, and call <system>_schema before writing SQL so the table and column names are real. Dates are calendar days in Asia/Jakarta (WIB), money is whole rupiah (Seer: US dollars), and run units are the app's own (metres, seconds, sec/km, bpm). If a system is not reachable the tool returns a short error; say so and answer from the rest.`,
```
Also update the doc comment on `buildInstructions`: "Iteration 5 phase 1 appends the connectors paragraph."
**File:** `tests/unit/mcp.instructions.test.ts:16`. Add inside `describe('buildInstructions', …)` after the first `it`:
```ts
  it('has exactly one connectors paragraph: read-only, the three systems, curated tools first', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Connectors.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toMatch(/read-only/);
    for (const word of ['expense-tracking', 'run-insights', 'Seer', 'lab.sqlite', 'Asia/Jakarta', 'rupiah']) expect(p).toContain(word);
    expect(p).toContain('Prefer the curated tools');
    expect(p).toContain("only when they don't answer");
    expect(p).toContain('_schema before writing SQL');
    for (const name of ['expenses_spending', 'runs_review', 'seer_sera_best']) expect(p).toContain(name);
    expect(p).not.toContain('expenses_schema,');
  });
```

### Step 17: Vitest modes
**File:** `vitest.config.ts` (whole file)
**Code:**
```ts
import { defineConfig } from 'vitest/config'

/**
 * The single Vitest config for the repo.
 *
 * - `npm test` (unit): `tests/unit/**` in node, plus `web/src/**\/*.test.tsx`, which opt
 *   into jsdom per file with a `// @vitest-environment jsdom` first-line pragma.
 * - `npm run test:int` (scripts/test-int.sh) sets VITEST_INTEGRATION=1, TEST_DATABASE_URL and
 *   TEST_CONNECTORS_URL, which switches the run to `tests/integration/**` only, against the
 *   Docker Postgres `mcp-notes-pg-test` (notes) and `mcp-notes-pg-connectors` (the three
 *   connector schemas, rebuilt from the sibling repos' migrations by
 *   tests/integration/connectors/globalSetup.ts). Integration files run one at a time because
 *   they share databases and truncate them.
 * - `npm run test:live` sets CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which switches the
 *   run to `tests/live/chat.live.test.ts` only: real Claude and real GLM calls through the Agent
 *   SDK, on the notes Docker Postgres. Opt-in, slow and billed.
 * - `npm run test:live:connectors` sets CONNECTORS_LIVE_TEST=1 (no Docker), which runs only
 *   `tests/live/connectors.live.test.ts`: each <system>_schema tool against the real databases,
 *   read-only. Opt-in.
 * None of the live files is ever part of `npm test` or `test:int`.
 *
 * Do not add a second config file.
 */
const chatLive = process.env.CHAT_LIVE_TEST === '1'
const connectorsLive = process.env.CONNECTORS_LIVE_TEST === '1'
const integration = !connectorsLive && (chatLive || process.env.VITEST_INTEGRATION === '1')

function includeFor(): string[] {
  if (connectorsLive) return ['tests/live/connectors.live.test.ts']
  if (chatLive) return ['tests/live/chat.live.test.ts']
  if (integration) return ['tests/integration/**/*.int.test.ts']
  return ['tests/unit/**/*.test.ts', 'web/src/**/*.test.tsx']
}

function globalSetupFor(): string[] {
  if (connectorsLive) return []
  if (chatLive) return ['tests/integration/globalSetup.ts']
  if (integration) return ['tests/integration/globalSetup.ts', 'tests/integration/connectors/globalSetup.ts']
  return []
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: includeFor(),
    exclude: ['node_modules/**', 'dist/**', 'web/dist/**'],
    globalSetup: globalSetupFor(),
    fileParallelism: !integration,
    testTimeout: chatLive ? 300_000 : connectorsLive ? 60_000 : integration ? 30_000 : 5_000,
    hookTimeout: chatLive || connectorsLive || integration ? 60_000 : 10_000,
  },
})
```

### Step 18: Second Docker container
**File:** `scripts/test-int.sh` (whole file)
**Change:** container startup becomes a function. The connectors container is skipped for `test:live` (`CHAT_LIVE_TEST=1`), which does not need it. Port **55435**: 55432 is seer-pg, 55433 is mcp-notes-pg-test, 55434 is mcp-notes-pg-demo.
**Code:**
```bash
#!/usr/bin/env bash
# Integration tests against real Postgres in Docker.
#
# Starts (or reuses) two containers, waits for them, then runs the integration suite:
#   mcp-notes-pg-test        postgres:16             127.0.0.1:55433  notes schema (drizzle/*.sql)
#   mcp-notes-pg-connectors  pgvector/pgvector:pg16  127.0.0.1:55435  one database per connector,
#                            rebuilt from the sibling repos' migrations by the connectors globalSetup
# Exports TEST_DATABASE_URL and TEST_CONNECTORS_URL. Extra args go to vitest.
#
# Never touches the Neon databases or any other container (seer-pg uses 55432,
# mcp-notes-pg-demo uses 55434).
set -euo pipefail

cd "$(dirname "$0")/.."

PG_PASSWORD=mcpnotes

NOTES_CONTAINER=mcp-notes-pg-test
NOTES_IMAGE=postgres:16
NOTES_PORT=55433
NOTES_DB=mcp_notes_test

CONNECTORS_CONTAINER=mcp-notes-pg-connectors
CONNECTORS_IMAGE=pgvector/pgvector:pg16
CONNECTORS_PORT=55435
CONNECTORS_DB=postgres

if ! command -v docker >/dev/null 2>&1; then
  echo "test-int: docker is not on PATH; integration tests need it." >&2
  exit 1
fi

# ensure_container NAME IMAGE HOST_PORT DB
ensure_container() {
  local name=$1 image=$2 port=$3 db=$4 state ready=0
  # docker inspect prints a blank line on stdout for an unknown container, so the
  # exit status decides "missing", not the output.
  if ! state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)"; then
    state=missing
  fi
  case "$state" in
    true)
      ;;
    false)
      echo "test-int: starting existing container $name"
      docker start "$name" >/dev/null
      ;;
    missing)
      echo "test-int: creating container $name ($image on 127.0.0.1:$port)"
      docker run -d \
        --name "$name" \
        -e POSTGRES_PASSWORD="$PG_PASSWORD" \
        -e POSTGRES_DB="$db" \
        -p "127.0.0.1:$port:5432" \
        "$image" >/dev/null
      ;;
    *)
      echo "test-int: unexpected state '$state' for $name" >&2
      exit 1
      ;;
  esac

  # -h 127.0.0.1 skips the entrypoint's socket-only bootstrap server, so "ready"
  # means the real server is accepting TCP connections.
  for _ in $(seq 1 60); do
    if docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d "$db" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    echo "test-int: $name did not become ready in 60s" >&2
    docker logs --tail 30 "$name" >&2 || true
    exit 1
  fi
}

ensure_container "$NOTES_CONTAINER" "$NOTES_IMAGE" "$NOTES_PORT" "$NOTES_DB"
export TEST_DATABASE_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${NOTES_PORT}/${NOTES_DB}"

if [ "${CHAT_LIVE_TEST:-}" != 1 ]; then
  ensure_container "$CONNECTORS_CONTAINER" "$CONNECTORS_IMAGE" "$CONNECTORS_PORT" "$CONNECTORS_DB"
  export TEST_CONNECTORS_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${CONNECTORS_PORT}/${CONNECTORS_DB}"
fi

export VITEST_INTEGRATION=1
exec node_modules/.bin/vitest run "$@"
```

### Step 19: Live script
**File:** `package.json:61`. Add after the `"test:live"` line:
```json
    "test:live:connectors": "CONNECTORS_LIVE_TEST=1 vitest run",
```

### Step 20: Harness, shared half (no vitest import; also used by globalSetup)
**File:** `tests/integration/connectors/siblings.ts` (new)
**Code:**
```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { connectorSettings, resolveRepoDir } from '../../../src/connectors/env.js';
import { SYSTEM_META, type SystemId } from '../../../src/connectors/names.js';
import { isNeonUrl } from '../../../src/db/client.js';

/**
 * Connector test databases live in the Docker container mcp-notes-pg-connectors
 * (pgvector/pgvector:pg16, 127.0.0.1:55435), one database per system, rebuilt by globalSetup
 * from the sibling repo's own migration files. The sibling repos are only read, never imported.
 */

/** Admin (superuser) URL of the connectors container. Never Neon. */
export function connectorsAdminUrl(): string {
  const url = process.env.TEST_CONNECTORS_URL;
  if (!url) throw new Error('TEST_CONNECTORS_URL is not set. Run integration tests with `npm run test:int`.');
  if (isNeonUrl(url)) throw new Error('TEST_CONNECTORS_URL points at Neon. Connector tests rebuild databases; use the Docker Postgres.');
  return url;
}

function migrationsMarker(id: SystemId, repo: string): string {
  return id === 'seer' ? path.join(repo, 'db', 'migrations') : path.join(repo, 'drizzle', 'meta', '_journal.json');
}

/** The sibling repo's path when its migrations are there, else null. Honours EXPENSE_TRACKING_DIR etc. */
export function siblingRepo(id: SystemId): string | null {
  const repo = resolveRepoDir(id, connectorSettings({ envFile: false }));
  return existsSync(migrationsMarker(id, repo)) ? repo : null;
}

export function systemDbName(id: SystemId): string {
  return `connectors_${id}`;
}

/** WRITABLE admin URL of that system's database: seed with it. Only the connector's own client is read-only. */
export function systemDbUrl(id: SystemId): string {
  const url = new URL(connectorsAdminUrl());
  url.pathname = `/${systemDbName(id)}`;
  return url.toString();
}

/** A writable admin client for setup and seeding. Refuses Neon. */
export async function withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  if (isNeonUrl(url)) throw new Error('refusing to open an admin connection to Neon');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Migration files in apply order: drizzle _journal.json order, or file-name order of db/migrations/*.sql (seer). */
export function migrationFiles(id: SystemId, repo: string): string[] {
  if (id === 'seer') {
    const dir = path.join(repo, 'db', 'migrations');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(dir, f));
  }
  const journal = JSON.parse(readFileSync(path.join(repo, 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const file = path.join(repo, 'drizzle', `${e.tag}.sql`);
      if (!existsSync(file)) throw new Error(`${SYSTEM_META[id].label}: the journal lists ${e.tag} but ${file} is missing`);
      return file;
    });
}

/** Drizzle files split on `--> statement-breakpoint`; seer files run whole (simple protocol, several statements). */
export function migrationStatements(id: SystemId, text: string): string[] {
  if (id === 'seer') return [text];
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Drops and recreates connectors_<id>, then applies every migration. Returns the file count. */
export async function buildSystemDb(id: SystemId, repo: string): Promise<number> {
  const name = systemDbName(id);
  await withAdmin(connectorsAdminUrl(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name}`);
  });
  const files = migrationFiles(id, repo);
  await withAdmin(systemDbUrl(id), async (c) => {
    for (const file of files) {
      for (const statement of migrationStatements(id, readFileSync(file, 'utf8'))) {
        try {
          await c.query(statement);
        } catch (err) {
          throw new Error(`${SYSTEM_META[id].label}: ${path.basename(file)} failed: ${(err as Error).message}`);
        }
      }
    }
  });
  return files.length;
}
```

### Step 21: Connectors globalSetup
**File:** `tests/integration/connectors/globalSetup.ts` (new)
**Code:**
```ts
import { displayPath, connectorSettings, resolveRepoDir } from '../../../src/connectors/env.js';
import { CONNECTOR_SYSTEMS, SYSTEM_META } from '../../../src/connectors/names.js';
import { buildSystemDb, connectorsAdminUrl, siblingRepo, systemDbName } from './siblings.js';

/**
 * Vitest globalSetup for the integration run: rebuild one database per connector from the
 * sibling repo's migrations (read as files, never imported). A missing repo is skipped with a
 * message; its describeWithRepo blocks skip too. A migration that fails is a hard error.
 */
export default async function setup(): Promise<void> {
  connectorsAdminUrl();
  for (const id of CONNECTOR_SYSTEMS) {
    const meta = SYSTEM_META[id];
    const repo = siblingRepo(id);
    if (repo === null) {
      const expected = displayPath(resolveRepoDir(id, connectorSettings({ envFile: false })));
      console.warn(`[connectors] ${meta.label}: no repository with migrations at ${expected} (set ${meta.repoDirEnv}); its integration tests are skipped.`);
      continue;
    }
    const count = await buildSystemDb(id, repo);
    console.log(`[connectors] ${meta.label}: ${systemDbName(id)} built from ${count} migrations in ${displayPath(repo)}`);
  }
}
```

### Step 22: Harness, public API
**File:** `tests/integration/connectors/harness.ts` (new)
**Code:**
```ts
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
```

### Step 23: Core integration tests (no sibling repo needed)
**File:** `tests/integration/connectors/core.int.test.ts` (new)
**Change:** runs against the connectors container's `postgres` database with probe objects. It proves the read-only layers, the cap, type parsing, the timeout, fail-soft and lab behaviour.
**Code:**
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secretsOf } from '../../../src/connectors/env.js';
import { runLabQuery } from '../../../src/connectors/lab.js';
import { runPgQuery, startupOptions } from '../../../src/connectors/pg.js';
import type { QueryResult } from '../../../src/connectors/types.js';
import { cleanupHarness, connectorClient, connectorFor, connectorsAdminUrl, makeLab, withAdmin, type ConnectorClient } from './harness.js';

const admin = connectorsAdminUrl();

async function probeCount(): Promise<number> {
  return withAdmin(admin, async (c) => Number((await c.query('select count(*) as n from mcp_notes_probe')).rows[0].n));
}

beforeAll(async () => {
  await withAdmin(admin, async (c) => {
    await c.query(`
      DROP TABLE IF EXISTS mcp_notes_probe;
      CREATE TABLE mcp_notes_probe (x integer);
      COMMENT ON TABLE mcp_notes_probe IS 'probe table for connector tests';
      COMMENT ON COLUMN mcp_notes_probe.x IS 'a number';
      DROP SEQUENCE IF EXISTS mcp_notes_probe_seq;
      CREATE SEQUENCE mcp_notes_probe_seq;
    `);
  });
});

afterAll(() => cleanupHarness());

describe('read-only, at the database', () => {
  it('every connection is read-only, on Jakarta time, with the statement timeout', async () => {
    const connector = connectorFor('expenses', { databaseUrl: admin, timeoutMs: 4321 });
    const r = await connector.query(
      `select current_setting('default_transaction_read_only'), current_setting('transaction_read_only'), current_setting('TimeZone'), current_setting('statement_timeout')`,
    );
    expect(r.rows[0]).toEqual(['on', 'on', 'Asia/Jakarta', '4321ms']);
  });

  it('an INSERT through the unguarded executor fails inside the database', async () => {
    const target = { url: admin, secrets: secretsOf(admin) };
    await expect(
      runPgQuery('expense-tracking', target, 'insert into mcp_notes_probe values (1)', [], { cap: 10, timeoutMs: 5000, wrap: false }),
    ).rejects.toThrow(/^expense-tracking query failed: cannot execute INSERT in a read-only transaction/);
    expect(await probeCount()).toBe(0);
  });

  it('the session default alone refuses writes, even outside BEGIN READ ONLY', async () => {
    const client = new pg.Client({ connectionString: admin, options: startupOptions(5000) });
    await client.connect();
    try {
      await expect(client.query('insert into mcp_notes_probe values (2)')).rejects.toThrow(/read-only transaction/);
    } finally {
      await client.end();
    }
    expect(await probeCount()).toBe(0);
  });
});

describe('expenses_sql on the probe database', () => {
  let client: ConnectorClient;
  beforeAll(async () => {
    client = await connectorClient({ expenses: connectorFor('expenses', { databaseUrl: admin }) });
  });
  afterAll(async () => client.close());

  it('select nextval(...) passes the guard and fails inside the database', async () => {
    const msg = await client.callError('expenses_sql', { sql: "select nextval('mcp_notes_probe_seq')" });
    expect(msg).toMatch(/^expense-tracking query failed: cannot execute nextval\(\) in a read-only transaction/);
  });

  it('writes and multi-statements are refused before the database', async () => {
    expect(await client.callError('expenses_sql', { sql: 'insert into mcp_notes_probe values (3)' })).toMatch(
      /^expense-tracking query failed: refused before reaching the database: only SELECT/,
    );
    expect(await client.callError('expenses_sql', { sql: 'select 1; drop table mcp_notes_probe' })).toMatch(/only one statement/);
    expect(await probeCount()).toBe(0);
  });

  it('caps rows: default 200, max_rows up to 1000, truncated flag', async () => {
    const sql = 'select g from generate_series(1, 1500) g';
    const def = await client.call<QueryResult>('expenses_sql', { sql });
    expect(def.columns).toEqual(['g']);
    expect([def.row_count, def.truncated]).toEqual([200, true]);
    const max = await client.call<QueryResult>('expenses_sql', { sql, max_rows: 1000 });
    expect([max.row_count, max.truncated]).toEqual([1000, true]);
    const few = await client.call<QueryResult>('expenses_sql', { sql: 'select g from generate_series(1, 5) g;' });
    expect(few).toEqual({ columns: ['g'], rows: [[1], [2], [3], [4], [5]], row_count: 5, truncated: false });
  });

  it('returns dates and times as text, int8 as a number when safe, numeric as a number', async () => {
    const r = await client.call<QueryResult>('expenses_sql', {
      sql: `select '2026-10-30'::date d, '07:15:00'::time t, '2026-10-30 05:00:00+00'::timestamptz ts, 9007199254740993::int8 big, 42::int8 small, 12.50::numeric n`,
    });
    expect(r.rows[0]).toEqual(['2026-10-30', '07:15:00', '2026-10-30 12:00:00+07', '9007199254740993', 42, 12.5]);
  });

  it('expenses_schema reads tables, types and comments', async () => {
    const r = await client.call<{ system: string; tables: { name: string; comment?: string; columns: unknown[] }[] }>(
      'expenses_schema',
      { tables: ['mcp_notes_probe'] },
    );
    expect(r.system).toBe('expense-tracking');
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]).toMatchObject({
      name: 'mcp_notes_probe',
      comment: 'probe table for connector tests',
      columns: [{ name: 'x', type: 'integer', nullable: true, comment: 'a number' }],
    });
  });
});

describe('timeout and fail-soft', () => {
  it('a slow statement is cancelled by statement_timeout', async () => {
    const connector = connectorFor('expenses', { databaseUrl: admin, timeoutMs: 300 });
    await expect(connector.query('select pg_sleep(2)')).rejects.toThrow(
      /^expense-tracking query failed: canceling statement due to statement timeout/,
    );
  });

  it('missing repo, missing .env.local, no URL and an unreachable DB are short errors; other systems keep working', async () => {
    const working = connectorFor('runs', { databaseUrl: admin });
    const cases: [ReturnType<typeof connectorFor>, RegExp][] = [
      [connectorFor('expenses', { repoDir: null }), /^expense-tracking is not reachable: no repository at /],
      [connectorFor('expenses', { envLocal: null }), /^expense-tracking is not reachable: no \.env\.local in /],
      [connectorFor('expenses', { envLocal: 'OTHER=1\n' }), /^expense-tracking is not reachable: .*has no DATABASE_URL/],
      [connectorFor('expenses', { databaseUrl: 'postgres://someone:hunter22pw@127.0.0.1:1/x' }), /^expense-tracking is not reachable: /],
    ];
    for (const [broken, expected] of cases) {
      const client = await connectorClient({ expenses: broken, runs: working });
      try {
        const msg = await client.callError('expenses_schema');
        expect(msg).toMatch(expected);
        expect(msg).not.toContain('hunter22pw');
        expect(msg).not.toContain('someone');
        const ok = await client.call<{ tables: unknown[] }>('runs_schema', { tables: ['mcp_notes_probe'] });
        expect(ok.tables).toHaveLength(1);
      } finally {
        await client.close();
      }
    }
  });
});

describe('seer lab.sqlite', () => {
  it('seer_sql source lab reads the lab; writes fail in the guard and in the file', async () => {
    const lab = makeLab({
      methods: [{ id: 'M0001', name: 'gap fade', family: 'reversal', hypothesis: 'h', status: 'dev-eligible' }],
      trials: [{ method_id: 'M0001', candidate_id: 'c1', window: 'dev', mar: 1.25, trades: 40 }],
      trial_funding: [{ trial_n: 1, mwr: 0.12, spy_tr_mwr: 0.1 }],
    });
    const seer = connectorFor('seer', { databaseUrl: admin, labPath: lab.path });
    const client = await connectorClient({ seer });
    try {
      const r = await client.call<QueryResult>('seer_sql', { source: 'lab', sql: 'select m.id, t.mar from methods m join trials t on t.method_id = m.id' });
      expect(r.rows).toEqual([['M0001', 1.25]]);
      expect(await client.callError('seer_sql', { source: 'lab', sql: "insert into methods (id) values ('M0002')" })).toMatch(
        /^seer query failed: refused before reaching the database/,
      );
      const schema = await client.call<{ db: { tables: { name: string }[] }; lab: { tables: { name: string }[] } }>('seer_schema', {});
      expect(schema.db.tables.map((t) => t.name)).toContain('mcp_notes_probe');
      expect(schema.lab.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['methods', 'trials', 'trial_funding']));
    } finally {
      await client.close();
    }
    await expect(
      runLabQuery('seer', lab.path, "insert into methods (id) values ('M0003')", [], { cap: 10, timeoutMs: 5000, wrap: false }),
    ).rejects.toThrow(/^seer query failed: attempt to write a readonly database/);
  });

  it('a missing lab file is a short error and the db half of seer_schema still answers', async () => {
    const seer = connectorFor('seer', { databaseUrl: admin });
    const client = await connectorClient({ seer });
    try {
      const schema = await client.call<{ db: { tables: unknown[] }; lab: { error: string } }>('seer_schema', {});
      expect(schema.db.tables.length).toBeGreaterThan(0);
      expect(schema.lab.error).toMatch(/^seer is not reachable: no lab database at /);
    } finally {
      await client.close();
    }
  });
});
```

### Step 24: Generic tools against each migrated schema
**File:** `tests/integration/connectors/generic.int.test.ts` (new)
**Code:**
```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SystemId } from '../../../src/connectors/names.js';
import type { QueryResult } from '../../../src/connectors/types.js';
import { cleanupHarness, connectorClient, connectorFor, describeWithRepo, type ConnectorClient } from './harness.js';

interface Expectation {
  tables: string[];
  column: { table: string; name: string; type: RegExp };
  countSql: string;
}

const EXPECT: Record<SystemId, Expectation> = {
  expenses: {
    tables: ['expense_groups', 'expense_items', 'expense_photos'],
    column: { table: 'expense_items', name: 'amount_idr', type: /^bigint$/ },
    countSql: 'select count(*) as n from expense_groups',
  },
  runs: {
    tables: ['runs', 'run_splits', 'run_zones', 'insights'],
    column: { table: 'runs', name: 'occurred_on', type: /^date$/ },
    countSql: 'select count(*) as n from runs',
  },
  seer: {
    tables: ['strategies', 'orders', 'equity_snapshots', 'book_positions'],
    column: { table: 'equity_snapshots', name: 'equity_usd', type: /^numeric/ },
    countSql: 'select count(*) as n from strategies',
  },
};

afterAll(() => cleanupHarness());

for (const id of Object.keys(EXPECT) as SystemId[]) {
  const e = EXPECT[id];
  describeWithRepo(id, `${id}_schema / ${id}_sql on the migrated schema`, () => {
    let client: ConnectorClient;
    beforeAll(async () => {
      client = await connectorClient({ [id]: connectorFor(id) });
    });
    afterAll(async () => client.close());

    it(`${id}_schema lists the app's tables with their types`, async () => {
      const args = id === 'seer' ? { source: 'db' } : {};
      const r = await client.call<{ tables: { name: string; columns: { name: string; type: string }[] }[] }>(`${id}_schema`, args);
      const names = r.tables.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(e.tables));
      const col = r.tables.find((t) => t.name === e.column.table)?.columns.find((c) => c.name === e.column.name);
      expect(col?.type).toMatch(e.column.type);
    });

    it(`${id}_sql runs a SELECT and refuses a write`, async () => {
      const r = await client.call<QueryResult>(`${id}_sql`, { sql: e.countSql });
      expect(r.columns).toEqual(['n']);
      expect(typeof r.rows[0]![0]).toBe('number');
      const msg = await client.callError(`${id}_sql`, { sql: `delete from ${e.tables[0]}` });
      expect(msg).toMatch(/refused before reaching the database/);
    });
  });
}
```

### Step 25: The real `/mcp` route
**File:** `tests/integration/connectors/mcp.int.test.ts` (new)
**Code:**
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_CONFIG, type Config } from '../../../src/config.js';
import type { AppDeps } from '../../../src/deps.js';
import { createApp } from '../../../src/http/app.js';
import { NoteEvents } from '../../../src/notes/events.js';
import { NotesService } from '../../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl } from '../setup.js';

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-connectors-mcp-'));
const config: Config = { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG };
const events = new NoteEvents();
const service = new NotesService({ db, dataDir, events });
const deps: AppDeps = { config, db, events, service };
const app = createApp(deps);
let client: Client;

function text(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

beforeAll(async () => {
  client = new Client({ name: 'connectors-mcp-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => app.request(String(input), init),
    }),
  );
});

afterAll(async () => {
  await client.close();
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('connector tools on the real /mcp route', () => {
  it('lists the six generic tools next to the notes tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['expenses_schema', 'expenses_sql', 'runs_schema', 'runs_sql', 'seer_schema', 'seer_sql', 'list', 'create']),
    );
    expect(client.getInstructions()).toMatch(/Connectors\./);
  });

  it('an unreachable system is a tool error for that call only; notes tools keep working', async () => {
    const saved = process.env.EXPENSE_TRACKING_DIR;
    process.env.EXPENSE_TRACKING_DIR = join(dataDir, 'no-such-repo');
    try {
      const failed = (await client.callTool({ name: 'expenses_schema', arguments: {} })) as CallToolResult;
      expect(failed.isError).toBe(true);
      expect(text(failed)).toMatch(/^expense-tracking is not reachable: no repository at /);
      const listed = (await client.callTool({ name: 'list', arguments: { limit: 1 } })) as CallToolResult;
      expect(listed.isError).toBeFalsy();
    } finally {
      if (saved === undefined) delete process.env.EXPENSE_TRACKING_DIR;
      else process.env.EXPENSE_TRACKING_DIR = saved;
    }
  });
});
```

### Step 26: Unit tests
**File:** `tests/unit/connectors/names.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES, CONNECTOR_SYSTEMS, CONNECTOR_TOOL_NAMES, schemaToolName, sqlToolName, SYSTEM_META } from '../../../src/connectors/names.js';

describe('connector tool names', () => {
  it('has 15 unique names, five per system, prefixed by the system id', () => {
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(new Set(ALL_CONNECTOR_TOOL_NAMES).size).toBe(15);
    for (const id of CONNECTOR_SYSTEMS) {
      expect(CONNECTOR_TOOL_NAMES[id]).toHaveLength(5);
      for (const name of CONNECTOR_TOOL_NAMES[id]) expect(name.startsWith(`${id}_`)).toBe(true);
      expect(schemaToolName(id)).toBe(`${id}_schema`);
      expect(sqlToolName(id)).toBe(`${id}_sql`);
    }
    expect(ALL_CONNECTOR_TOOL_NAMES.slice(0, 2)).toEqual(['expenses_schema', 'expenses_sql']);
    expect(ALL_CONNECTOR_TOOL_NAMES.at(-1)).toBe('seer_sera_best');
  });

  it('labels and captions match the contract', () => {
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].label)).toEqual(['expense-tracking', 'run-insights', 'seer']);
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].caption)).toEqual(['reading expenses', 'reading runs', 'reading seer']);
    expect(CONNECTOR_SYSTEMS.filter((id) => SYSTEM_META[id].hasLab)).toEqual(['seer']);
  });
});
```
**File:** `tests/unit/connectors/guard.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { guardSelect, maskSql, SqlRefused } from '../../../src/connectors/guard.js';

const accepted = [
  'select 1',
  'SELECT 1;',
  '  with x as (select 1) select * from x  ;  ',
  "select 'insert; drop' as s",
  'select "update" from t',
  'select $$ delete ; $$',
  'select $tag$ ; drop $tag$',
  'select 1 -- drop table x',
  'select /* insert */ 1',
  'select /* outer /* nested */ insert */ 1',
  '(select 1) union (select 2)',
  "select nextval('s')",
  "select replace(name, 'a', 'b') from t",
  "select e'it\\'s; insert'",
  'select x from t where id = $1',
  'select updated_at, deleted_at, created_at from t',
];

const refused: [string, RegExp][] = [
  ['insert into t values (1)', /only SELECT/],
  ['update t set x = 1', /only SELECT/],
  ['delete from t', /only SELECT/],
  ['drop table t', /only SELECT/],
  ['explain analyze select 1', /only SELECT/],
  ['set statement_timeout = 0', /only SELECT/],
  ['begin', /only SELECT/],
  ['vacuum', /only SELECT/],
  ['select 1; select 2', /only one statement/],
  ['select 1; drop table t', /only one statement/],
  ['with x as (insert into t values (1) returning *) select * from x', /INSERT is not allowed/],
  ['with x as (delete from t returning *) select * from x', /DELETE is not allowed/],
  ['select * into newt from t', /INTO is not allowed/],
  ['select * from t for update', /UPDATE is not allowed/],
  ['select * from t for share', /row locks/],
  ['select pg_terminate_backend(123)', /pg_terminate_backend\(\) is not allowed/],
  ["select set_config('a', 'b', false)", /set_config\(\) is not allowed/],
  ['select pg_advisory_lock(1)', /pg_advisory_lock\(\) is not allowed/],
  ["select 'unterminated", /unterminated string/],
  ['select /* open', /unterminated \/\* comment/],
  ['select $a$ open', /unterminated dollar/],
  ['', /empty/],
  ['  ;  ', /empty/],
];

describe('guardSelect (postgres)', () => {
  it.each(accepted)('accepts %s', (sql) => {
    expect(() => guardSelect(sql, 'postgres')).not.toThrow();
  });

  it.each(refused)('refuses %s', (sql, reason) => {
    expect(() => guardSelect(sql, 'postgres')).toThrow(SqlRefused);
    expect(() => guardSelect(sql, 'postgres')).toThrow(reason);
  });

  it('returns the query without trailing semicolons or trailing comments', () => {
    expect(guardSelect('select 1 ; -- bye', 'postgres')).toBe('select 1');
    expect(guardSelect('  select 2;;  ', 'postgres')).toBe('select 2');
  });
});

describe('guardSelect (sqlite)', () => {
  it('accepts sqlite quoting and pragma table functions', () => {
    expect(() => guardSelect('select [insert], `drop` from t', 'sqlite')).not.toThrow();
    expect(() => guardSelect("select * from pragma_table_info('methods')", 'sqlite')).not.toThrow();
  });

  it('refuses attach, pragma and writes', () => {
    expect(() => guardSelect("attach database 'x' as y", 'sqlite')).toThrow(/only SELECT/);
    expect(() => guardSelect('pragma writable_schema = 1', 'sqlite')).toThrow(/only SELECT/);
    expect(() => guardSelect('with a as (select 1) insert into t select * from a', 'sqlite')).toThrow(/INSERT is not allowed/);
  });
});

describe('maskSql', () => {
  it('keeps the length and blanks literals and comments', () => {
    const sql = "select 'x;y' -- c\n, \"q\" /* d */";
    const masked = maskSql(sql, 'postgres');
    expect(masked).toHaveLength(sql.length);
    expect(masked).not.toMatch(/[;'"]|--|\/\*/);
  });
});
```
**File:** `tests/unit/connectors/rows.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { capRows, clampMaxRows, int8Value, stripTrailingSemicolons, toObjects, wrapWithLimit } from '../../../src/connectors/rows.js';

describe('row cap', () => {
  it('clamps max rows to 1..1000 with a default of 200', () => {
    expect(clampMaxRows(undefined)).toBe(200);
    expect(clampMaxRows(0)).toBe(1);
    expect(clampMaxRows(-5)).toBe(1);
    expect(clampMaxRows(5000)).toBe(1000);
    expect(clampMaxRows(12.7)).toBe(12);
    expect(clampMaxRows(Number.NaN)).toBe(200);
  });

  it('wraps the query with LIMIT cap+1 on its own lines', () => {
    expect(wrapWithLimit('select 1 -- c', 5)).toBe('SELECT * FROM (\nselect 1 -- c\n) AS q LIMIT 6');
  });

  it('keeps at most cap rows and flags truncation', () => {
    const rows = [[1], [2], [3]];
    expect(capRows(['x'], rows, 2)).toEqual({ columns: ['x'], rows: [[1], [2]], row_count: 2, truncated: true });
    expect(capRows(['x'], rows, 3)).toEqual({ columns: ['x'], rows, row_count: 3, truncated: false });
    expect(capRows(['x'], [], 3)).toEqual({ columns: ['x'], rows: [], row_count: 0, truncated: false });
  });

  it('int8 is a number when exact, else text; trailing semicolons go; rows become objects', () => {
    expect(int8Value('42')).toBe(42);
    expect(int8Value('9007199254740993')).toBe('9007199254740993');
    expect(stripTrailingSemicolons('select 1 ;; \n')).toBe('select 1');
    expect(toObjects({ columns: ['a', 'b'], rows: [[1, 'x']], row_count: 1, truncated: false })).toEqual([{ a: 1, b: 'x' }]);
  });
});
```
**File:** `tests/unit/connectors/env.test.ts` (new)
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectorSettings,
  connectorTimeoutMs,
  loadDatabaseTarget,
  pickDirectUrl,
  prepareUrl,
  resolveRepoDir,
  secretsOf,
} from '../../../src/connectors/env.js';
import { reasonOf, scrub } from '../../../src/connectors/errors.js';
import { ConnectorError } from '../../../src/connectors/types.js';

const POOLED = 'postgresql://owner:pw-secret@ep-cool-123-pooler.ap-southeast-1.aws.neon.tech/db?sslmode=require';
const DIRECT = 'postgresql://owner:pw-secret@ep-cool-123.ap-southeast-1.aws.neon.tech/db?sslmode=require';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'mcp-notes-conn-env-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pickDirectUrl', () => {
  it('chooses the non-pooler host whatever the key names say', () => {
    expect(pickDirectUrl({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT })).toBe(DIRECT);
    expect(pickDirectUrl({ DATABASE_URL: DIRECT, DATABASE_URL_UNPOOLED: POOLED })).toBe(DIRECT);
    expect(pickDirectUrl({ DATABASE_URL: ` ${POOLED} ` })).toBe(POOLED);
    expect(pickDirectUrl({})).toBeUndefined();
  });
});

describe('prepareUrl', () => {
  it('spells sslmode=require as verify-full and drops options', () => {
    const out = new URL(prepareUrl(`${DIRECT}&options=-c%20default_transaction_read_only%3Doff`));
    expect(out.searchParams.get('sslmode')).toBe('verify-full');
    expect(out.searchParams.has('options')).toBe(false);
    expect(prepareUrl('postgres://u:p@127.0.0.1:5432/x')).toBe('postgres://u:p@127.0.0.1:5432/x');
    expect(prepareUrl('not a url')).toBe('not a url');
  });
});

describe('loadDatabaseTarget', () => {
  it('reads .env.local at call time, never touching process.env', () => {
    const repo = tempDir();
    writeFileSync(path.join(repo, '.env.local'), `DATABASE_URL=${POOLED}\nDATABASE_URL_UNPOOLED=${DIRECT}\n`);
    const before = { ...process.env };
    const target = loadDatabaseTarget('expenses', repo);
    expect(process.env).toEqual(before);
    expect(new URL(target.url).hostname).toBe('ep-cool-123.ap-southeast-1.aws.neon.tech');
    expect(target.secrets).toEqual(expect.arrayContaining(['pw-secret', 'owner', DIRECT]));
    writeFileSync(path.join(repo, '.env.local'), 'DATABASE_URL=postgres://u:rotated@127.0.0.1:1/x\n');
    expect(loadDatabaseTarget('expenses', repo).url).toContain('rotated');
  });

  it('missing repo, missing file and missing keys are "not reachable" errors', () => {
    const repo = tempDir();
    expect(() => loadDatabaseTarget('runs', path.join(repo, 'nope'))).toThrow(/^run-insights is not reachable: no repository at /);
    expect(() => loadDatabaseTarget('runs', repo)).toThrow(/^run-insights is not reachable: no \.env\.local in /);
    writeFileSync(path.join(repo, '.env.local'), 'OTHER=1\n');
    expect(() => loadDatabaseTarget('runs', repo)).toThrow(ConnectorError);
    expect(() => loadDatabaseTarget('runs', repo)).toThrow(/has no DATABASE_URL or DATABASE_URL_UNPOOLED/);
  });
});

describe('settings, read per call', () => {
  it('real env wins over the notes .env.local; only connector keys are read', () => {
    const dir = tempDir();
    const file = path.join(dir, '.env.local');
    writeFileSync(file, 'SEER_DIR=/from/file\nRUN_INSIGHTS_DIR=/runs/file\nDATABASE_URL=postgres://x\n');
    const s = connectorSettings({ env: { SEER_DIR: '/from/env' }, envFile: file });
    expect(s).toEqual({ SEER_DIR: '/from/env', RUN_INSIGHTS_DIR: '/runs/file' });
    expect(connectorSettings({ env: {}, envFile: false })).toEqual({});
  });

  it('resolves repo dirs with ~ and defaults', () => {
    expect(resolveRepoDir('expenses', {})).toBe(path.join(homedir(), 'expense-tracking'));
    expect(resolveRepoDir('seer', { SEER_DIR: '~/x/seer' })).toBe(path.join(homedir(), 'x/seer'));
    expect(resolveRepoDir('runs', { RUN_INSIGHTS_DIR: 'rel/dir' })).toBe(path.resolve('rel/dir'));
  });

  it('parses CONNECTOR_TIMEOUT_MS with a safe default', () => {
    expect(connectorTimeoutMs({})).toBe(10_000);
    expect(connectorTimeoutMs({ CONNECTOR_TIMEOUT_MS: '2500' })).toBe(2500);
    expect(connectorTimeoutMs({ CONNECTOR_TIMEOUT_MS: 'abc' })).toBe(10_000);
    expect(connectorTimeoutMs({ CONNECTOR_TIMEOUT_MS: '5' })).toBe(10_000);
  });
});

describe('scrubbing', () => {
  it('removes the URL, user, password and host from any message', () => {
    const msg = `password authentication failed for user "owner" at ep-cool-123.ap-southeast-1.aws.neon.tech using ${DIRECT} (pw-secret)`;
    const out = scrub(msg, secretsOf(DIRECT));
    for (const s of ['owner', 'pw-secret', 'ep-cool-123', 'postgresql://']) expect(out).not.toContain(s);
    expect(scrub('ab cd', ['ab'])).toBe('ab cd');
  });

  it('reasonOf unwraps AggregateError and falls back to the error code', () => {
    expect(reasonOf(new AggregateError([new Error('connect ECONNREFUSED ::1:1')], ''))).toBe('connect ECONNREFUSED ::1:1');
    expect(reasonOf(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(reasonOf(new Error('a\n  b'))).toBe('a b');
  });
});
```
**File:** `tests/unit/connectors/failsoft.test.ts` (new)
```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createConnector } from '../../../src/connectors/connector.js';
import { runLabQuery } from '../../../src/connectors/lab.js';
import { ALL_CONNECTOR_TOOL_NAMES } from '../../../src/connectors/names.js';
import { registerConnectorTools } from '../../../src/connectors/register.js';
import { ConnectorError, type Connectors } from '../../../src/connectors/types.js';
import { errorResult } from '../../../src/mcp/tools.js';

const root = mkdtempSync(path.join(tmpdir(), 'mcp-notes-failsoft-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const settings = { envFile: false as const };

function textOf(r: CallToolResult): string {
  const first = r.content[0];
  return first && first.type === 'text' ? first.text : '';
}

describe('fail-soft connectors', () => {
  it('a missing repo rejects with a ConnectorError, not a crash', async () => {
    const c = createConnector('expenses', { repoDir: path.join(root, 'missing'), settings });
    await expect(c.query('select 1')).rejects.toBeInstanceOf(ConnectorError);
    await expect(c.query('select 1')).rejects.toThrow(/^expense-tracking is not reachable: no repository at /);
  });

  it('an unreachable database is "not reachable" and leaks no credential', async () => {
    const repo = path.join(root, 'repo-unreachable');
    mkdirSync(repo);
    writeFileSync(path.join(repo, '.env.local'), 'DATABASE_URL=postgres://alice:s3cretpw@127.0.0.1:1/db\n');
    const c = createConnector('runs', { repoDir: repo, settings, timeoutMs: 2000 });
    const err = await c.query('select 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^run-insights is not reachable: /);
    expect(msg).not.toContain('s3cretpw');
    expect(msg).not.toContain('alice');
  });

  it('errorResult shows a ConnectorError message as is', () => {
    expect(errorResult(new ConnectorError('seer is not reachable: x'))).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'seer is not reachable: x' }],
    });
  });

  it('tools return isError results and the server keeps answering', async () => {
    const missing = (id: 'expenses' | 'runs' | 'seer') => createConnector(id, { repoDir: path.join(root, `none-${id}`), settings });
    const connectors: Connectors = { expenses: missing('expenses'), runs: missing('runs'), seer: missing('seer') };
    const server = new McpServer({ name: 't', version: '0' });
    registerConnectorTools(server, connectors);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tc', version: '0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const schema = (await client.callTool({ name: 'expenses_schema', arguments: {} })) as CallToolResult;
      expect(schema.isError).toBe(true);
      expect(textOf(schema)).toMatch(/^expense-tracking is not reachable: /);
      const write = (await client.callTool({ name: 'seer_sql', arguments: { sql: 'insert into t values (1)' } })) as CallToolResult;
      expect(write.isError).toBe(true);
      expect(textOf(write)).toMatch(/^seer query failed: refused before reaching the database: only SELECT/);
      // Robust to phases 2-4 landing in any order: the generic six are always there, and every
      // registered tool is one of the 15 contract names (curated ones appear as each phase lands).
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(['expenses_schema', 'expenses_sql', 'runs_schema', 'runs_sql', 'seer_schema', 'seer_sql']),
      );
      for (const name of names) expect(ALL_CONNECTOR_TOOL_NAMES).toContain(name);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('lab runner', () => {
  const file = path.join(root, 'lab.sqlite');
  const db = new DatabaseSync(file);
  db.exec('create table t (x integer); insert into t values (1), (2), (3), (9007199254740993);');
  db.close();
  const opts = { cap: 2, timeoutMs: 5000 };

  it('reads read-only with the cap, params and bigint safety', async () => {
    const r = await runLabQuery('seer', file, 'select x from t order by x', [], opts);
    expect(r).toEqual({ columns: ['x'], rows: [[1], [2]], row_count: 2, truncated: true });
    const big = await runLabQuery('seer', file, 'select x from t where x > ?', [3], opts);
    expect(big.rows).toEqual([['9007199254740993']]);
  });

  it('refuses writes at the file', async () => {
    await expect(runLabQuery('seer', file, 'insert into t values (5)', [], { ...opts, wrap: false })).rejects.toThrow(
      /^seer query failed: attempt to write a readonly database/,
    );
  });

  it('a missing file is not reachable', async () => {
    await expect(runLabQuery('seer', path.join(root, 'none.sqlite'), 'select 1', [], opts)).rejects.toThrow(
      /^seer is not reachable: no lab database at /,
    );
  });

  it('kills a runaway query at the timeout', async () => {
    const sql = 'with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c';
    await expect(runLabQuery('seer', file, sql, [], { cap: 2, timeoutMs: 500 })).rejects.toThrow(
      /^seer query failed: lab query timed out after 500 ms/,
    );
  });
});
```
### Step 27: Opt-in live check
**File:** `tests/live/connectors.live.test.ts` (new)
**Code:**
```ts
/**
 * Opt-in live check: each <system>_schema tool against the owner's real databases (and Seer's
 * real lab.sqlite), read-only. Run with `npm run test:live:connectors` (CONNECTORS_LIVE_TEST=1,
 * no Docker). Never part of `npm test`, `npm run test:int` or `npm run test:live`.
 * Calls only the _schema tools. Prints table counts only. Asserts no password reaches a result.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectorSettings, resolveRepoDir } from '../../src/connectors/env.js';
import { CONNECTOR_SYSTEMS, schemaToolName, SYSTEM_META, type SystemId } from '../../src/connectors/names.js';
import { defaultConnectors, registerConnectorTools } from '../../src/connectors/register.js';

const server = new McpServer({ name: 'connectors-live', version: '0.0.0' });
const client = new Client({ name: 'connectors-live-client', version: '0.0.0' });

function repoOf(id: SystemId): string {
  return resolveRepoDir(id, connectorSettings());
}

function passwordsOf(id: SystemId): string[] {
  const file = path.join(repoOf(id), '.env.local');
  if (!existsSync(file)) return [];
  const vars = parse(readFileSync(file));
  return [vars.DATABASE_URL, vars.DATABASE_URL_UNPOOLED].flatMap((u) => {
    try {
      const pw = u ? new URL(u).password : '';
      return pw ? [pw, decodeURIComponent(pw)] : [];
    } catch {
      return [];
    }
  });
}

beforeAll(async () => {
  registerConnectorTools(server, defaultConnectors());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe('live connector schemas (read-only)', () => {
  for (const id of CONNECTOR_SYSTEMS) {
    const hasEnv = existsSync(path.join(repoOf(id), '.env.local'));
    it.skipIf(!hasEnv)(`${schemaToolName(id)} reads ${SYSTEM_META[id].label}'s live schema`, async () => {
      const result = (await client.callTool({ name: schemaToolName(id), arguments: {} })) as CallToolResult;
      const first = result.content[0];
      const text = first && first.type === 'text' ? first.text : '';
      for (const pw of passwordsOf(id)) expect(text.includes(pw)).toBe(false);
      expect(result.isError, text).toBeFalsy();
      const body = JSON.parse(text) as { tables?: unknown[]; db?: { tables?: unknown[] }; lab?: { tables?: unknown[]; error?: string } };
      if (id === 'seer') {
        expect(body.db?.tables?.length ?? 0).toBeGreaterThan(0);
        if (existsSync(path.join(repoOf(id), 'lab', 'lab.sqlite'))) expect(body.lab?.tables?.length ?? 0).toBeGreaterThan(0);
        console.log(`[live] seer: ${body.db?.tables?.length} db tables, ${body.lab?.tables?.length ?? 0} lab tables`);
      } else {
        expect(body.tables?.length ?? 0).toBeGreaterThan(0);
        console.log(`[live] ${SYSTEM_META[id].label}: ${body.tables?.length} tables`);
      }
    });
  }
});
```

### Step 28: README
**File:** `README.md`
- `:25`: after `- [The chat bar](#the-chat-bar)` add `- [Connectors: spending, runs, Seer](#connectors-spending-runs-seer)`.
- `:223`: insert this new section just before `## Install and run` at line 224:
```markdown
## Connectors: spending, runs, Seer

The same `notes` MCP server also reads three of my own apps, read-only, so `/n` and the chat bar
can answer "how much did I spend on meals in October?" or "how did yesterday's run go?" straight
from their data:

| System | Repo | What it holds |
|---|---|---|
| `expenses` | `~/expense-tracking` | Expenses parsed from pasted text, in whole rupiah, with categories and receipt photos |
| `runs` | `~/run-insights` | Apple Watch runs (pace, distance, heart rate, splits), weekly and monthly reviews, the coach Nina |
| `seer` | `~/seer` | The trading lab: strategies, positions, trades, the leaderboard, and Sera's experiments in `lab/lab.sqlite` |

| Tool | What it does |
|---|---|
| `expenses_schema` | Tables, columns, types and what they mean, from the live database |
| `expenses_sql` | One read-only SELECT, row-capped |
| `expenses_spending` | `from`–`to` (WIB days, up to 366): total, by category with its Indonesian label, by day, by ISO week (Monday–Sunday, partial weeks flagged), and the largest items. Optional `categories` (e.g. `["meals"]`) and `top` |
| `expenses_get` | One expense group by `id`: its items in the app's order, photos, note and the original pasted text |
| `expenses_months` | Monthly totals for the last `months` (default 6) ending at `to_month`, zero-filled, each marked complete or in progress. Optional `categories` |
| `runs_schema` | Tables, columns, types and what they mean |
| `runs_sql` | One read-only SELECT, row-capped |
| `runs_list` | Reviewed runs from `from` to `to` (default today) with key metrics and the app's headline per run, plus period totals (distance-weighted pace) |
| `runs_get` | One run by `id`, or every run on a `date`: metrics, per-km splits, heart-rate zones, note, and the app's own latest analysis |
| `runs_review` | The app's latest `week` or `month` review (`key` like `2026-W44`, `2026-10` or any day in it; default the current one) with that period's totals and runs |
| `seer_schema` | Tables and columns of the Seer database and of `lab.sqlite` |
| `seer_sql` | One read-only SELECT against `source` `db` or `lab` |
| `seer_leaderboard` | The leaderboard ranked as the app ranks it, over the common window; the benchmark, retired and too-new strategies listed apart |
| `seer_positions` | Open bracket orders and book positions with marks and unrealised P&L, in USD. Optional `strategy` and `include_pending` |
| `seer_sera_best` | The best dev variant of each Sera method by MAR, with the lab's metrics, hurdles and test trials; eligibility is as of the run date. Optional `status`, `only_eligible`, `limit` |

How it stays safe:

- **Read-only twice.** Every Postgres connection starts with `default_transaction_read_only=on`
  and every query runs inside `BEGIN READ ONLY`, so a write fails at the database even if a tool
  were wrong. `lab.sqlite` is opened read-only in a short-lived reader process (no write lock,
  safe while Seer's own jobs use it). `_sql` also refuses anything but one SELECT before it
  reaches the database.
- **Credentials stay where they are.** Each call reads that repo's `.env.local` (the direct,
  non-pooler `DATABASE_URL*`), so rotated credentials work without a restart. Nothing is copied
  into this repo, a log, a note or a tool result; errors are scrubbed.
- **Limits.** 10 s statement timeout, 200 rows by default, 1000 at most.
- **Fail-soft.** A missing repo, a missing `.env.local` or an unreachable database is a short
  error for that one call ("expense-tracking is not reachable: …"); notes and the other systems
  keep working.
- Dates are calendar days in Asia/Jakarta (WIB), money is whole rupiah (Seer: US dollars), and
  run units are the app's own (metres, seconds, sec/km, bpm). Nothing is cached in the notes
  database.
```
- `:289-297` (Tests): the block becomes:
```markdown
```sh
npm run typecheck
npm test                       # unit tests, server and web (jsdom)
npm run test:int               # integration tests against real Postgres in Docker
npm run test:live:connectors   # opt-in: each *_schema tool against the real databases, read-only
```

`test:int` starts or reuses two containers: `mcp-notes-pg-test` (Postgres 16, port 55433) for the
notes, and `mcp-notes-pg-connectors` (pgvector Postgres 16, port 55435), where it rebuilds one
database per connector from that repo's own migration files (read, never imported; a repo that is
not there is skipped with a message). Neither suite touches a Neon database. `test:live` (chat)
and `test:live:connectors` are opt-in and never part of `npm test` or `test:int`.
```
- `:310` (Configuration table): after the `TEST_DATABASE_URL` row add:
```markdown
| `EXPENSE_TRACKING_DIR`, `RUN_INSIGHTS_DIR`, `SEER_DIR` | `~/expense-tracking`, `~/run-insights`, `~/seer` | Where the connectors find each repo and its `.env.local`. Read on every call. |
| `CONNECTOR_TIMEOUT_MS` | `10000` | Statement timeout per connector query. |
| `TEST_CONNECTORS_URL` | set by `test:int` | Connector test container (admin URL). |
```
- `:345`: before "The server also sends Claude short instructions…" add the line `The 15 connector tools are listed under [Connectors](#connectors-spending-runs-seer).`. Change the instructions sentence to end with: `, and that the connectors are read-only and the curated tools come first.`
- `:387`: replace the `**No connectors yet.**` bullet with `- **Connectors are read-only.** Nothing in expense-tracking, run-insights or Seer can be changed from here, by design.`
- `:414`: the `src/` line becomes `src/            notesd: config, db (Drizzle), notes service, MCP server, HTTP routes, images, chat agent, connectors`

Do not touch the Roadmap table (completion-handler marks iteration 5 done). Do not touch "The chat bar" or "Using it from Claude Code" (phase 5). This step is the only README edit in phases 1–4: the curated-tool rows above already carry phases 2–4's inputs, so phases 2–4 do not edit README. Phase 5 runs after this phase and quotes README as this step leaves it.

### Step 29: INSTALL.md
**File:** `docs/INSTALL.md:209`. Insert before `## Uninstall`:
```markdown
## 5. Connectors

notesd reads expense-tracking, run-insights and Seer read-only (tools `expenses_*`, `runs_*`,
`seer_*`). Nothing to install: each call reads `~/expense-tracking/.env.local`,
`~/run-insights/.env.local` and `~/seer/.env.local` (the direct `DATABASE_URL*` host) and
`~/seer/lab/lab.sqlite`. Credentials are never copied into the unit or this repo.

| Key | Default | Meaning |
|---|---|---|
| `EXPENSE_TRACKING_DIR` | `~/expense-tracking` | Repo dir of expense-tracking. |
| `RUN_INSIGHTS_DIR` | `~/run-insights` | Repo dir of run-insights. |
| `SEER_DIR` | `~/seer` | Repo dir of Seer; the lab is `<dir>/lab/lab.sqlite`. |
| `CONNECTOR_TIMEOUT_MS` | `10000` | Statement timeout per query. |

They are read on every call from the environment, merged over this repo's `.env.local`, so a change
needs no restart. Check the real databases (read-only, schema only) with
`npm run test:live:connectors`.
```

## Verification

**Setup:** the worktree has no `node_modules`. Run `npm ci` at the worktree root before any other command (do not symlink another checkout's `node_modules`: concurrent phase worktrees would share it).

**Build:** `npm run typecheck && npm run build:server`
**Tests:**
- `npm test`: unit, including `tests/unit/connectors/*` and the new instructions test.
- `npm run test:int`: first run pulls `pgvector/pgvector:pg16` and builds `connectors_expenses`, `connectors_runs` and `connectors_seer` from the sibling migrations.
- Optional: `npm run test:live:connectors`.

**Manual check:**
- `docker ps` shows `mcp-notes-pg-connectors` on `127.0.0.1:55435`.
- The globalSetup log prints one "built from N migrations" line per present repo.
- On a running dev daemon, `tools/list` on `/mcp` shows the six generic tools.
- `expenses_schema` returns real tables. `expenses_sql` with `insert …` returns `expense-tracking query failed: refused before reaching the database: …`.

**Exit criteria:**
- `tools/list` on `/mcp` shows the 6 generic tools.
- `_schema` returns tables, columns, types and comments, plus lab tables for seer.
- `_sql` refuses writes and multi-statements before the DB, and caps rows (200/1000, `truncated`).
- `select nextval(...)` via `_sql` and an INSERT via the unguarded executor both fail inside the DB with a read-only error.
- A missing repo, a missing `.env.local` or an unreachable DB gives the short error, and other tools keep working.
- `npm run test:live:connectors` exists and is excluded from `npm test`, `test:int` and `test:live`.
- typecheck, `npm test` and `npm run test:int` are green.

## Handoffs

**For phases 2, 3 and 4:**
- Replace exactly your `src/connectors/<id>/curated.ts`; the signature is fixed.
- Use `run(fn, { compact: true })` from `src/mcp/tools.ts`, and `toObjects` from `src/connectors/rows.ts`.
- `connector.query` already wraps with `LIMIT cap+1`. Pass `{ maxRows: CONNECTOR_MAX_ROWS }` for aggregate queries that must not be truncated.
- Lab SQL uses `?` params and the SQLite dialect.
- For seeding: `seedSystem` / `withAdmin(systemDbUrl(id), …)` give writable admin access, and `truncateSystem` resets the DB.
- Phase 4: use `connectorFor('seer', { labPath: makeLab(rows).path })`. `makeLab` gives `methods`, `trials`, `trial_funding` and `insights` with defaults on NOT NULL columns.

**For phase 5:**
- Import `ALL_CONNECTOR_TOOL_NAMES`, and optionally `SYSTEM_META[id].caption`, from `src/connectors/names.ts`.
- The MCP server prefix is `notes`, so allowed names are `mcp__notes__<tool>`, as with the notes tools.

**Reconciled:**
- The Decisions row "lab.sqlite driver" records the child process (done in the index).
- `docs/plans/CHAT_BAR_BRAIN_PLAN.md` invariant 4 belongs to phase 5.
- `failsoft.test.ts` and `mcp.int.test.ts` assert "the generic six are present and every registered name is a contract name", never an exact count, so phases 2–4 land in any order without editing this phase's tests.

**For completion:** README Roadmap row 5 "planned" → "done".

**Not done (drive-by):** `src/config.ts` has a private `expandHome`, and `env.ts` repeats three lines of it instead of exporting it from config, to stay out of a file this phase does not own.

## Rollback

Revert this phase's commit. Then `docker rm -f mcp-notes-pg-connectors` if the container should go too. Nothing in the notes DB or the sibling repos changes, and the six tools disappear with `src/connectors`. Phases 2–4 cannot land without this phase. Revert them first, or revert the whole set.
