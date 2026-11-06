> Adopted from `.workflows/orchestration/dword-connector/PLAN.md` phase 1. Source: `.workflows/plan/dword-connector/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Connector plumbing

**Plan set:** `DWORD_CONNECTOR_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`
**Satisfies:** R1, R3, R5 — the user-facing thing this phase serves: nothing visible to the user
yet (no skill, no chat wiring land until phases 5/6); this phase makes `dword` exist as a fourth
connector system with working generic `dword_schema`/`dword_sql` tools and a `DWORD_USER_EMAIL`
resolver, so phases 2-4 have solid ground to build on.
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/connectors`, `src/config.ts`

---

## Goal

After this phase, `dword` is a real fourth entry in `CONNECTOR_SYSTEMS`: `dword_schema` and
`dword_sql` work end to end against daily-words' real (or a throwaway) Postgres, exactly like
`expenses`/`runs`/`seer`'s generic tools do today. `DWORD_USER_EMAIL` is a parsed config setting,
and a resolver turns it into dword's `users.id` fresh on every call, refusing clearly when unset
or unmatched. No curated tool, no writer, no skill and no chat wiring exist yet — those are later
phases' jobs.

## Interface Contract

**Creates:**
- `dword` as a new `SystemId` member (`src/connectors/names.ts`)
- `CONNECTOR_TOOL_NAMES.dword = ['dword_schema', 'dword_sql']` (`src/connectors/names.ts`) — only
  the generic pair; phases 3/4 append the four curated names to this array later
- `SYSTEM_META.dword` (`src/connectors/names.ts`)
- `pkg.DWORD_ABOUT`, `pkg.createDwordConnector` (`src/connectors/dword/index.ts`, new file)
- `pkg.resolveDwordUserId` (`src/connectors/dword/user.ts`, new file)
- `DWORD_USER_EMAIL` setting key, `DwordConfig`, `DEFAULT_DWORD_CONFIG`, `parseDword`,
  `config.dword: DwordConfig` (`src/config.ts`)
- `'DAILY_WORDS_DIR'` in `SETTING_KEYS` (`src/connectors/env.ts`)

**Signature changes:** none (this phase only adds; `Connectors`, `SystemAbout`, `ConnectorOptions`
etc. are untouched).

**Requires (from earlier phases):** none — this is the first phase.

**Leaves alone (owned by others):**
- `src/dword/rules.ts`, `src/dword/writer.ts` — phase 2. Phase 1 does not create the `src/dword`
  directory at all; phase 2 is free to create it from scratch.
- Any MCP tool file under `src/mcp/` (`dwordVocabTools.ts`, `dwordJournalTools.ts`) — phases 3/4.
  Phase 1 adds no curated tool names, so `registerDwordCurated` has nothing to call yet; the one
  call into `src/connectors/register.ts` that wires curated tools in is phase 4's job (see the
  index's Decisions table), not phase 1's.
- `claude/skills/v`, `claude/skills/j`, `scripts/install.sh`, `.claude/skills/verify-notesd/
  features/*` — phases 5/6. Phase 1 ships no user-facing capability (no skill, no chat allow-list
  entry), so no feature-map entry is added here — matching the existing precedent that
  `expenses`/`runs`/`seer`'s own generic connectors have no feature-map entry either; only the
  surfaces that reach a user (skills, wall chat) get one, in phases 5/6.
- `src/chat/status.ts`, `src/chat/prompt.ts` — phase 6.

## Files

| File | Action | What changes |
|---|---|---|
| `src/connectors/names.ts` | modify | add `'dword'` to `CONNECTOR_SYSTEMS`; add `dword: ['dword_schema', 'dword_sql']` to `CONNECTOR_TOOL_NAMES`; add `SYSTEM_META.dword` |
| `src/connectors/env.ts` | modify | add `'DAILY_WORDS_DIR'` to `SETTING_KEYS` |
| `src/connectors/register.ts` | modify | add `DWORD_ABOUT` to `ABOUT`, `dword: createDwordConnector()` to `defaultConnectors()` |
| `src/connectors/dword/index.ts` | create | `DWORD_ABOUT` (`SystemAbout`), `createDwordConnector` — thin wrapper mirroring `seer/index.ts` |
| `src/connectors/dword/user.ts` | create | `resolveDwordUserId(connector, email)` — the `DWORD_USER_EMAIL` -> `users.id` resolver |
| `src/config.ts` | modify | `DwordConfig`, `DEFAULT_DWORD_CONFIG`, `parseDword`, `Config.dword`, wired into `loadConfig()` |
| `README.md` | modify | env table rows for `DAILY_WORDS_DIR` and `DWORD_USER_EMAIL` |
| `tests/integration/connectors/generic.int.test.ts` | modify | add a `dword` entry to `EXPECT` so `dword_schema`/`dword_sql` are proven against the throwaway Postgres |
| `tests/unit/connectors/names.test.ts` | modify | update counts/labels/captions now that `dword` exists, with its 2-tool exception |
| `tests/unit/chat-status.test.ts` | modify | update the `ALL_CONNECTOR_TOOL_NAMES` count and the "every connector tool" caption regex |
| `tests/unit/connectors/failsoft.test.ts` | modify | the hand-built `Connectors` literal needs a `dword` entry now that `Connectors = Record<SystemId, Connector>` has four keys |
| `tests/unit/config.test.ts` | modify | add `dword: DEFAULT_DWORD_CONFIG` to the "applies defaults" `toEqual`; add a `loadConfig dword` describe block |
| `tests/unit/connectors/dword.test.ts` | create | unit tests for `resolveDwordUserId` and the `dword/index.ts` wrapper |
| `tests/integration/connectors/siblings.ts`, `tests/integration/connectors/harness.ts` | **no change** | confirmed below — dword's migrations already match the drizzle-journal layout these files already handle for expenses/runs; adding `'dword'` to `SystemId` (done in `names.ts`) is the only change either file needs |

## Confirmation: siblings.ts / harness.ts need no new branch

Read `migrationsMarker()` (`siblings.ts:22-24`) and `migrationFiles()` (`siblings.ts:56-74`): the
non-seer branch reads `<repo>/drizzle/meta/_journal.json` and `<repo>/drizzle/<tag>.sql`, splitting
each file on `--> statement-breakpoint`. Checked directly against the real sibling repo:

```
$ ls ~/daily-words/drizzle
0000_fancy_mulholland_black.sql ... 0010_open_hawkeye.sql  meta/
$ ls ~/daily-words/drizzle/meta
0000_snapshot.json ... 0010_snapshot.json  _journal.json
$ head -c 200 ~/daily-words/drizzle/meta/_journal.json
{ "version": "7", "dialect": "postgresql", "entries": [ { "idx": 0, "version": "7", ... "tag": "0000_fancy_mulholland_black", "breakpoints": true }, ...
```

This is exactly the expenses/runs layout already handled by the non-seer branch of
`migrationsMarker`/`migrationFiles`. `buildSystemDb()` (`siblings.ts:86-105`) and `connectorFor()`
(`harness.ts:76-87`) take a `SystemId` parameter generically and have no system-specific branches
at all. `globalSetup.ts` (`tests/integration/connectors/globalSetup.ts:12`) and
`connectorClient()` (`harness.ts:222-225`) both iterate `CONNECTOR_SYSTEMS`/`Connectors` generically
too. So adding `'dword'` to `CONNECTOR_SYSTEMS` (in `names.ts`, this phase) is the only change any
of these four files needs — no branch, no edit to `siblings.ts` or `harness.ts` themselves.

## Implementation Steps

### Step 1: `dword` as a connector system
**File:** `src/connectors/names.ts` (whole file, 71 lines today)
**Change:** add `'dword'` to `CONNECTOR_SYSTEMS`, its tool-name pair, and its `SYSTEM_META` entry.
**Code:**
```ts
/**
 * Every connector tool name, written once here. Phase 1 registers the generic `_schema` and
 * `_sql` tools; phases 2-4 register the curated ones; the chat bar (src/chat) imports
 * ALL_CONNECTOR_TOOL_NAMES for its allow list. Adding a fourth system is one more entry in each
 * table below plus one directory under src/connectors.
 */
export const CONNECTOR_SYSTEMS = ['expenses', 'runs', 'seer', 'dword'] as const;
export type SystemId = (typeof CONNECTOR_SYSTEMS)[number];

export const CONNECTOR_TOOL_NAMES = {
  expenses: ['expenses_schema', 'expenses_sql', 'expenses_spending', 'expenses_get', 'expenses_months'],
  runs: ['runs_schema', 'runs_sql', 'runs_list', 'runs_get', 'runs_review'],
  seer: ['seer_schema', 'seer_sql', 'seer_leaderboard', 'seer_positions', 'seer_sera_best'],
  // Generic pair only: curated vocab/journal tool names are appended here by phases 3 and 4.
  dword: ['dword_schema', 'dword_sql'],
} as const satisfies Record<SystemId, readonly string[]>;

export type ConnectorToolName = (typeof CONNECTOR_TOOL_NAMES)[SystemId][number];

/** Every name, flattened in the order above (17 once dword's generic pair is in). */
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
  dword: {
    id: 'dword',
    label: 'daily-words',
    repoDirEnv: 'DAILY_WORDS_DIR',
    defaultRepoDir: '~/daily-words',
    caption: 'reading daily-words',
    hasLab: false,
  },
};

export function schemaToolName(id: SystemId): ConnectorToolName {
  return CONNECTOR_TOOL_NAMES[id][0];
}

export function sqlToolName(id: SystemId): ConnectorToolName {
  return CONNECTOR_TOOL_NAMES[id][1];
}
```
**Impact:** `SystemId`, `Connectors` (`Record<SystemId, Connector>`) and the `EXPECT`/literal
records keyed by `SystemId` in tests now require a fourth key — every such spot is listed in
Files above and fixed in later steps. `ALL_CONNECTOR_TOOL_NAMES` grows from 15 to 17 entries.

### Step 2: `DAILY_WORDS_DIR` setting
**File:** `src/connectors/env.ts:13`
**Change:** add the new key to `SETTING_KEYS`.
**Code:**
```ts
const SETTING_KEYS = ['EXPENSE_TRACKING_DIR', 'RUN_INSIGHTS_DIR', 'SEER_DIR', 'DAILY_WORDS_DIR', 'CONNECTOR_TIMEOUT_MS'] as const;
```
**Impact:** `connectorSettings()` now also reads `DAILY_WORDS_DIR` from the real env or
`.env.local`; `resolveRepoDir('dword', ...)` (used by `createConnector('dword', ...)`) picks it up
automatically — no other change in `env.ts` is needed, since `resolveRepoDir`/`loadDatabaseTarget`
are already generic over `SystemId`.

### Step 3: the `dword` connector wrapper
**File:** `src/connectors/dword/index.ts` (new)
**Change:** create, mirroring `src/connectors/seer/index.ts`'s shape exactly.
**Code:**
```ts
import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

/**
 * daily-words' own schema (~/daily-words/src/lib/db/schema.ts), summarised for dword_schema.
 * mcp-notes reads this database read-only through dword_sql, exactly like every other connector's
 * *_sql tool; it never writes through dword_sql. Writes go only through the allow-listed
 * src/dword/writer.ts (phase 2), which resolves the owner's row via DWORD_USER_EMAIL
 * (src/connectors/dword/user.ts) fresh on every call.
 */
export const DWORD_ABOUT: SystemAbout = {
  summary:
    "the owner's vocabulary and wise-words app (daily-words, dword.site): vocab entries with " +
    'origin/translation metadata, journal entries with an insight and a near-duplicate check, ' +
    'one row per Auth.js user',
  db:
    'users: one row per Auth.js account (id uuid, email unique not null — DWORD_USER_EMAIL is resolved against this). ' +
    'vocab_entries: term (always the English headword); source (manual|suggested|shared); status (active|mastered); ' +
    'part_of_speech, pronunciation (British RP), definition, examples (jsonb array of 3 strings, each containing the term); ' +
    "enrichment_status (pending|ready|failed); origin_term/origin_language/origin_context record a non-English lookup's " +
    'foreign word, language and the sentence it was found in, or an attached "as in" sentence for an English term — ' +
    'origin_context may only be set when origin_term is (CHECK vocab_entries_origin_context_needs_term); unique index on ' +
    '(user_id, lower(term)). journal_entries: text, source_note, insight jsonb {meaning, whenItApplies[]}, ' +
    'insight_status (none|pending|ready|failed). journal_entry_embeddings: one row per journal entry, text_sha/norm_sha ' +
    '(sha256 hex of the text and of its normalized form), embedding vector(1536) nullable, model, status (ready|failed) — ' +
    "a row with no embedding is backfilled later by dword itself, never by mcp-notes. Several more tables back dword's own " +
    'web app (accounts, sessions, daily_cards, badges, shares, ...) and are outside this connector\'s write scope.',
};

export function createDwordConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('dword', options);
}
```
**Impact:** none yet — nothing imports this file until Step 5 (`register.ts`).

### Step 4: `DWORD_USER_EMAIL` -> `users.id` resolver
**File:** `src/connectors/dword/user.ts` (new)
**Change:** create the resolver used by phases 3/4's MCP tools (which hold a `Connector`), plus the
two refusal-message builders phase 2's writer re-uses for its own, transport-specific resolution.
**[Reconciled]** Phase 2's writer opens its own raw `pg.Client` for writing (the read-only
`Connector.query()` path refuses non-`SELECT` statements), so it cannot call `resolveDwordUserId`
here directly — a `Connector` and a `pg.Client` have incompatible `query()` return shapes
(array-of-values rows vs. object-keyed rows). Rather than leave two independently-worded refusal
messages, the two message strings are exported as small builder functions so both transports say
the exact same thing. See `DWORD_CONNECTOR_PLAN.md`'s Reconciliation Log.
**Code:**
```ts
import { SYSTEM_META } from '../names.js';
import type { Connector } from '../types.js';
import { ConnectorError } from '../types.js';

const LABEL = SYSTEM_META.dword.label;

/** DWORD_USER_EMAIL is unset or blank. Shared verbatim by src/dword/writer.ts (phase 2). */
export function dwordUserNotConfiguredMessage(): string {
  return `${LABEL} user not configured: set DWORD_USER_EMAIL in .env.local`;
}

/** The configured email has no matching users row. Shared verbatim by src/dword/writer.ts (phase 2). */
export function dwordUserNotFoundMessage(email: string): string {
  return `${LABEL} user ${email} not found`;
}

/**
 * Resolves DWORD_USER_EMAIL (config.dword.userEmail) to dword's users.id. Called fresh on every
 * tool invocation — never cached in Config, the same rule loadDatabaseTarget follows by re-reading
 * <repo>/.env.local on every call. `connector` is whatever dword Connector the caller already holds
 * (createDwordConnector() in production, connectorFor('dword', ...) in tests); its query() opens a
 * fresh read-only connection. Used by phases 3/4's MCP tool files; NOT used by phase 2's writer,
 * which holds a raw pg.Client instead of a Connector and does its own equivalent lookup against
 * that client, reusing the two message builders above so the refusal text is identical either way.
 *
 * Refusals (ConnectorError, no write ever attempted):
 *  - "daily-words user not configured: ..."     DWORD_USER_EMAIL is unset or blank
 *  - "daily-words user <email> not found"       the email has no matching users row
 */
export async function resolveDwordUserId(connector: Connector, email: string | null): Promise<string> {
  if (!email) {
    throw new ConnectorError(dwordUserNotConfiguredMessage());
  }
  const result = await connector.query('SELECT id FROM users WHERE email = $1', [email]);
  const row = result.rows[0];
  if (!row) {
    throw new ConnectorError(dwordUserNotFoundMessage(email));
  }
  return String(row[0]);
}
```
**Impact:** none yet — this phase only adds and unit-tests it (Step 11); phases 3/4's tools call
`resolveDwordUserId` directly, and phase 2's writer calls the two message builders from its own
pg.Client-based equivalent (see phase 2's Interface Contract and Step 2).

### Step 5: register `dword` as a system
**File:** `src/connectors/register.ts` (whole file, 37 lines today)
**Change:** import the new wrapper, add it to `ABOUT` and `defaultConnectors()`. Do **not** add a
curated-registration call (phase 4's job, per the plan index's Decisions table).
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDwordConnector, DWORD_ABOUT } from './dword/index.js';
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
  dword: DWORD_ABOUT,
};

/** The owner's four repos (~/expense-tracking, ~/run-insights, ~/seer, ~/daily-words or their overrides), resolved per call. */
export function defaultConnectors(): Connectors {
  return {
    expenses: createExpensesConnector(),
    runs: createRunsConnector(),
    seer: createSeerConnector(),
    dword: createDwordConnector(),
  };
}

/**
 * Registers <id>_schema and <id>_sql for every system, then each system's curated tools. dword
 * has no curated tools yet: its curated call (registerDwordCurated, covering both the vocab and
 * journal tools) is added once phases 3 and 4 have both landed (see DWORD_CONNECTOR_PLAN.md's
 * Decisions table) — phase 1 wires in only the generic pair every system gets below.
 */
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
**Impact:** `dword_schema`/`dword_sql` are now registered everywhere `registerConnectorTools` is
called (the live MCP server, the integration harness's `connectorClient`). `defaultConnectors()`
now resolves `~/daily-words` (or `DAILY_WORDS_DIR`) on daemon startup, read-only, same as the
other three — no behavior change for users since nothing calls a dword tool yet.

### Step 6: `DWORD_USER_EMAIL` in config
**File:** `src/config.ts`
**Change:** add a `DwordConfig` shape and parser, mirroring `EmbeddingsConfig`/`parseEmbeddings`
exactly, and wire it into `Config`/`loadConfig()`.

**New interface + default, inserted after `DEFAULT_EMBEDDINGS_CONFIG` (after line 63):**
```ts
/** The dword (daily-words) connector's write identity: src/connectors/dword/user.ts resolves it. */
export interface DwordConfig {
  /** `DWORD_USER_EMAIL`, trimmed; null when unset or blank. Every dword tool then refuses with
   * "daily-words user not configured" instead of writing. Never logged. */
  userEmail: string | null
}

/** What `loadConfig` returns for `dword` without DWORD_USER_EMAIL. Tests build `Config` literals with it. */
export const DEFAULT_DWORD_CONFIG: DwordConfig = { userEmail: null }
```

**New parser, inserted right after `parseEmbeddings` (after line 282):**
```ts
function parseDword(env: Record<string, string | undefined>): DwordConfig {
  const userEmail = env.DWORD_USER_EMAIL?.trim() ?? ''
  return { userEmail: userEmail === '' ? null : userEmail }
}
```

**`Config` interface (full, `src/config.ts:136-153`), one field added:**
```ts
export interface Config {
  /** Runtime connection string: the pooled Neon host in production (see `loadConfig`). */
  databaseUrl: string
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
  /** The chat bar brain (POST /api/chat). */
  chat: ChatConfig
  /** Note embeddings via OpenRouter. `apiKey: null` turns semantic features off. */
  embeddings: EmbeddingsConfig
  /** Claude Code session ingest. `enabled: false` starts nothing (DEFAULT_SESSIONS_CONFIG in tests). */
  sessions: SessionsConfig
  /** Seer Adversarial reviewer. `enabled: false` starts nothing (DEFAULT_ADVERSARY_CONFIG in tests). */
  adversary: AdversaryConfig
  /** The dword (daily-words) connector's write identity. `userEmail: null` means every dword write refuses. */
  dword: DwordConfig
}
```

**`loadConfig()` (full function, `src/config.ts:342-367`), one field added to the return and the
doc comment above it updated:**
```ts
/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Chat keys: CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS, NOTESD_CLAUDE_BIN, LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL. Embeddings key: OPENROUTER_API_KEY (unset or blank: semantic search and
 * the embedding worker are off, `related` answers only from vectors already stored; note writes are
 * unaffected). Sessions keys: CLAUDE_HOME, NOTES_WORKTREES_DIR, NOTESD_SESSIONS,
 * NOTESD_SWARM_SCRIPT. Adversary keys: NOTESD_ADVERSARY, ADVERSARY_DAILY_CAP,
 * ADVERSARY_GATHER_MODEL, ADVERSARY_VERDICT_MODEL, ADVERSARY_GATHER_MAX_TURNS,
 * ADVERSARY_STOCK_TIMEOUT_MS, ADVERSARY_POLL_MS, NOTESD_SEER_DISPATCH. Dword key: DWORD_USER_EMAIL
 * (unset or blank: every dword_vocab_*/dword_journal_* write tool refuses with "daily-words user
 * not configured"; dword_schema/dword_sql are unaffected, since they need no user id). Other keys
 * are ignored. Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port, on a non-loopback host, on a bad chat key, on CHAT_BRAIN=glm without LLM_*,
 * or on a NOTESD_SESSIONS value other than on/off.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fromFile = readEnvFile(options.envFile ?? path.join(REPO_ROOT, '.env.local'))
  const realEnv: Record<string, string | undefined> = options.env ?? process.env
  const env: Record<string, string | undefined> = { ...fromFile, ...realEnv }

  const databaseUrl = pickDatabaseUrl(realEnv, env)
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is not set. Put the Neon connection strings in ${path.join(REPO_ROOT, '.env.local')} ` +
        'or export DATABASE_URL.',
    )
  }

  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR

  return {
    databaseUrl,
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir: path.resolve(expandHome(dataDirRaw)),
    chat: parseChat(env),
    embeddings: parseEmbeddings(env),
    sessions: parseSessions(env),
    adversary: parseAdversary(env),
    dword: parseDword(env),
  }
}
```
**Impact:** `Config` now has a fifth top-level section. Every test that builds a `Config` literal
by hand (`tests/unit/config.test.ts`'s "applies defaults") needs `dword: DEFAULT_DWORD_CONFIG`
added — done in Step 13. No other file reads `config.dword` yet (phase 2's writer and phases 3/4's
tools are its callers).

### Step 7: README env table
**File:** `README.md` (env table, after the `SEER_DIR` row, `README.md:928`)
**Change:** add two rows, following the existing `EXPENSE_TRACKING_DIR` row's format for a plain
directory override and the `NOTESD_SEER_DISPATCH` row's format for a single-concern setting.
**Code:**
```md
| `DAILY_WORDS_DIR` | `~/daily-words` | Where the dword connector finds daily-words' repo and its `.env.local`. Read on every call. |
| `DWORD_USER_EMAIL` | — | The owner's `users.email` in daily-words, resolved fresh to a `users.id` on every dword write. Unset or no matching row: `dword_vocab_add`/`dword_journal_add` refuse with a clear error and write nothing; `dword_schema`/`dword_sql` are unaffected. |
```
**Impact:** documents the two new settings; no code reads `README.md`.

### Step 8: prove the generic tools on a throwaway dword database
**File:** `tests/integration/connectors/generic.int.test.ts` (whole file, 58 lines today)
**Change:** add a `dword` entry to `EXPECT`. `EXPECT: Record<SystemId, Expectation>` now requires
it — without this the file fails to typecheck, not just to test.
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
  dword: {
    tables: ['users', 'vocab_entries', 'journal_entries', 'journal_entry_embeddings'],
    column: { table: 'vocab_entries', name: 'enrichment_status', type: /^text$/ },
    countSql: 'select count(*) as n from users',
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
**Impact:** on a machine with `~/daily-words` present (true on this one; `globalSetup.ts` already
builds `connectors_dword` from its migrations once `dword` is in `CONNECTOR_SYSTEMS`, no change
needed there), this proves `dword_schema`/`dword_sql` work end to end; elsewhere it skips with
`describeWithRepo`'s existing message, same as the other three systems when their repo is absent.

### Step 9: fix the hardcoded tool-name counts
**File:** `tests/unit/connectors/names.test.ts` (whole file, 23 lines today)
**Change:** `CONNECTOR_TOOL_NAMES[id]` is no longer uniformly 5 long (`dword` has 2 today, growing
to 6 once phases 3/4 land their curated tools). **[Reconciled]** The original draft of this test
hardcoded `17` and `{ dword: 2 }` as literals, which would fail the moment phase 3 or phase 4 later
appends a curated name to `CONNECTOR_TOOL_NAMES.dword` — neither of those phases' own "Owns" lists
include this file, so nothing would have fixed it until phase 6. Per the plan index's
Reconciliation Log, this test now derives every count from `CONNECTOR_TOOL_NAMES`/
`ALL_CONNECTOR_TOOL_NAMES` themselves instead of a literal, so it stays green unmodified through
phases 2-5 and needs no handoff note to any later phase.
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES, CONNECTOR_SYSTEMS, CONNECTOR_TOOL_NAMES, schemaToolName, sqlToolName, SYSTEM_META } from '../../../src/connectors/names.js';

describe('connector tool names', () => {
  it('every name is unique, prefixed by its own system id, with schema/sql first', () => {
    const total = CONNECTOR_SYSTEMS.reduce((sum, id) => sum + CONNECTOR_TOOL_NAMES[id].length, 0);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(total);
    expect(new Set(ALL_CONNECTOR_TOOL_NAMES).size).toBe(total);
    for (const id of CONNECTOR_SYSTEMS) {
      expect(CONNECTOR_TOOL_NAMES[id].length).toBeGreaterThanOrEqual(2);
      for (const name of CONNECTOR_TOOL_NAMES[id]) expect(name.startsWith(`${id}_`)).toBe(true);
      expect(CONNECTOR_TOOL_NAMES[id][0]).toBe(`${id}_schema`);
      expect(CONNECTOR_TOOL_NAMES[id][1]).toBe(`${id}_sql`);
      expect(schemaToolName(id)).toBe(`${id}_schema`);
      expect(sqlToolName(id)).toBe(`${id}_sql`);
    }
    expect(ALL_CONNECTOR_TOOL_NAMES.slice(0, 2)).toEqual(['expenses_schema', 'expenses_sql']);
  });

  it('labels and captions match the contract', () => {
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].label)).toEqual(['expense-tracking', 'run-insights', 'seer', 'daily-words']);
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].caption)).toEqual(['reading expenses', 'reading runs', 'reading seer', 'reading daily-words']);
    expect(CONNECTOR_SYSTEMS.filter((id) => SYSTEM_META[id].hasLab)).toEqual(['seer']);
  });
});
```
**Impact:** this test is never-flaky with respect to `dword`'s tool count: it is correct the moment
phase 1 lands (`dword` has 2 names) and stays correct, unmodified, once phase 3 (4 names) and phase
4 (6 names) land — no later phase owes this file an update.

### Step 10: fix the chat allow-list count and caption regex
**File:** `tests/unit/chat-status.test.ts`
**Change:** two spots only — the total length math, and the regex that asserts every connector
tool's caption starts with "reading ". Both need `daily-words` added. **[Reconciled]** The total is
derived from `ALL_CONNECTOR_TOOL_NAMES.length` rather than a literal `17`, for the same reason as
Step 9: this file is not in phase 3's or phase 4's "Owns" list, so a hardcoded `17` would break the
moment either phase appends a curated dword tool name, with nothing until phase 6 to fix it. Phase
6 later replaces this whole file anyway (its own Step 4, once the four-way caption split exists) —
until then, this dynamic version stays green unmodified.

**Updated `it` block (replaces the `it('is exactly the 19 notes tools...')` block, `chat-status.test.ts:8-30`):**
```ts
  it('is exactly the notes, session, adversary and connector tools, plus WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(19);
    expect(SESSION_TOOL_NAMES).toHaveLength(5);
    expect(ADVERSARY_TOOL_NAMES).toHaveLength(3);
    expect(tools).toHaveLength(NOTES_TOOL_NAMES.length + SESSION_TOOL_NAMES.length + ADVERSARY_TOOL_NAMES.length + ALL_CONNECTOR_TOOL_NAMES.length + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('mcp__notes__related');
    expect(tools).toContain('mcp__notes__attach_image');
    expect(tools).toContain('mcp__notes__remove_image');
    expect(tools).toContain('mcp__notes__restore_image');
    expect(tools).toContain('mcp__notes__similar_images');
    expect(tools).toContain('mcp__notes__session_resume');
    for (const name of SESSION_TOOL_NAMES) expect(tools).toContain(n(name));
    for (const name of ADVERSARY_TOOL_NAMES) expect(tools).toContain(n(name));
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });
```

**Updated `it` block (replaces `it('captions every connector tool in the contract')`,
`chat-status.test.ts:107-111`):**
```ts
  it('captions every connector tool in the contract', () => {
    for (const name of ALL_CONNECTOR_TOOL_NAMES) {
      expect(captionForToolUse(n(name), {})).toMatch(/^reading (expenses|runs|seer|daily-words)$/);
    }
  });
```
**Impact:** `allowedChatTools()` now includes `mcp__notes__dword_schema` and
`mcp__notes__dword_sql` in its result, but `dword` tools are not yet reachable from the chat bar in
practice — `src/chat/agent.ts`'s system prompt (phase 6) is what actually tells the model these
tools exist and when to use them; an unprompted tool staying in the allow-list is the same
situation `expenses`/`runs`/`seer` are already in today (the allow-list is necessary, not
sufficient, for the model to call a tool).

### Step 11: fix the hand-built `Connectors` literal in fail-soft tests
**File:** `tests/unit/connectors/failsoft.test.ts`
**Change:** `Connectors = Record<SystemId, Connector>` now has four keys; the test's `missing()`
helper and the literal it builds need a fourth one, or the file fails to typecheck.
**Code (replaces the `it('tools return isError results and the server keeps answering')` block,
`failsoft.test.ts:54-82`):**
```ts
  it('tools return isError results and the server keeps answering', async () => {
    const missing = (id: 'expenses' | 'runs' | 'seer' | 'dword') => createConnector(id, { repoDir: path.join(root, `none-${id}`), settings });
    const connectors: Connectors = { expenses: missing('expenses'), runs: missing('runs'), seer: missing('seer'), dword: missing('dword') };
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
      const dwordSchema = (await client.callTool({ name: 'dword_schema', arguments: {} })) as CallToolResult;
      expect(dwordSchema.isError).toBe(true);
      expect(textOf(dwordSchema)).toMatch(/^daily-words is not reachable: /);
      // Robust to phases 2-4 landing in any order: the generic eight are always there, and every
      // registered tool is one of the contract names (curated ones appear as each phase lands).
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(['expenses_schema', 'expenses_sql', 'runs_schema', 'runs_sql', 'seer_schema', 'seer_sql', 'dword_schema', 'dword_sql']),
      );
      for (const name of names) expect(ALL_CONNECTOR_TOOL_NAMES).toContain(name);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await client.close();
      await server.close();
    }
  });
```
**Impact:** proves the same fail-soft contract (`ConnectorError`, no crash, other systems keep
answering) now also holds for `dword`.

### Step 12: unit tests for the new dword files
**File:** `tests/unit/connectors/dword.test.ts` (new)
**Change:** cover `resolveDwordUserId`'s three outcomes and the `dword/index.ts` wrapper's wiring,
without a real database (a fake `Connector`).
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { createDwordConnector, DWORD_ABOUT } from '../../../src/connectors/dword/index.js';
import {
  dwordUserNotConfiguredMessage,
  dwordUserNotFoundMessage,
  resolveDwordUserId,
} from '../../../src/connectors/dword/user.js';
import { ConnectorError, type Connector, type QueryResult } from '../../../src/connectors/types.js';

function fakeConnector(rows: unknown[][]): Connector {
  return {
    id: 'dword',
    label: 'daily-words',
    async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
      expect(sql).toBe('SELECT id FROM users WHERE email = $1');
      expect(params).toEqual([expect.any(String)]);
      return { columns: ['id'], rows, row_count: rows.length, truncated: false };
    },
  };
}

describe('resolveDwordUserId', () => {
  it('refuses when DWORD_USER_EMAIL is unset or blank', async () => {
    const connector = fakeConnector([]);
    await expect(resolveDwordUserId(connector, null)).rejects.toThrow(ConnectorError);
    await expect(resolveDwordUserId(connector, null)).rejects.toThrow(/^daily-words user not configured/);
  });

  it('refuses when the email has no matching row', async () => {
    const connector = fakeConnector([]);
    await expect(resolveDwordUserId(connector, 'nobody@example.com')).rejects.toThrow(
      'daily-words user nobody@example.com not found',
    );
  });

  it('resolves to the row\'s id on a match', async () => {
    const connector = fakeConnector([['11111111-1111-1111-1111-111111111111']]);
    await expect(resolveDwordUserId(connector, 'owner@example.com')).resolves.toBe('11111111-1111-1111-1111-111111111111');
  });
});

describe('createDwordConnector', () => {
  it('wraps createConnector with id "dword" and the daily-words label', () => {
    const connector = createDwordConnector({ repoDir: '/nonexistent' });
    expect(connector.id).toBe('dword');
    expect(connector.label).toBe('daily-words');
    expect(connector.lab).toBeUndefined();
  });
});

describe('dword user refusal messages (shared verbatim with src/dword/writer.ts)', () => {
  it('builds the not-configured and not-found messages resolveDwordUserId throws', () => {
    expect(dwordUserNotConfiguredMessage()).toBe('daily-words user not configured: set DWORD_USER_EMAIL in .env.local');
    expect(dwordUserNotFoundMessage('nobody@example.com')).toBe('daily-words user nobody@example.com not found');
  });
});

describe('DWORD_ABOUT', () => {
  it('names the tables this connector reads and writes', () => {
    expect(DWORD_ABOUT.db).toMatch(/vocab_entries/);
    expect(DWORD_ABOUT.db).toMatch(/journal_entries/);
    expect(DWORD_ABOUT.db).toMatch(/journal_entry_embeddings/);
    expect(DWORD_ABOUT.lab).toBeUndefined();
  });
});
```
**Impact:** pins `resolveDwordUserId`'s exact refusal wording (phase 2's writer and phases 3/4's
tools are expected to surface these messages verbatim to the caller) and that `dword` has no lab,
matching `SYSTEM_META.dword.hasLab = false`.

### Step 13: config tests for `DWORD_USER_EMAIL`
**File:** `tests/unit/config.test.ts`
**Change:** add `dword: DEFAULT_DWORD_CONFIG` to the "applies defaults" expectation (otherwise
`toEqual` fails on the new field), and add a `loadConfig dword` describe block mirroring the
existing `loadConfig embeddings` one.

**Updated import (`config.test.ts:6-15`):**
```ts
import {
  ConfigError,
  DEFAULT_ADVERSARY_CONFIG,
  DEFAULT_CHAT_CONFIG,
  DEFAULT_DWORD_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_PORT,
  DEFAULT_SESSIONS_CONFIG,
  loadConfig,
  REPO_ROOT,
} from '../../src/config.js'
```

**Updated `it` block (replaces `it('applies defaults')`, `config.test.ts:37-51`):**
```ts
  it('applies defaults', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false })
    expect(cfg).toEqual({
      databaseUrl: URL_A,
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      dataDir: path.join(homedir(), 'mcp-notes-data'),
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: DEFAULT_EMBEDDINGS_CONFIG,
      sessions: { claudeHome: path.join(homedir(), '.claude'), worktreesDir: path.join(homedir(), '.worktrees'), enabled: true, swarmScript: path.join(homedir(), '.claude', 'skills', 'swarm', 'swarm.py') },
      adversary: { ...DEFAULT_ADVERSARY_CONFIG, enabled: true, dispatchNightly: true },
      dword: DEFAULT_DWORD_CONFIG,
    })
    expect(cfg.chat).toEqual({ brain: 'claude', maxTurns: 24, timeoutMs: 180_000, claudeBin: 'claude', glm: null })
    expect(cfg.embeddings).toEqual({ apiKey: null })
    expect(cfg.dword).toEqual({ userEmail: null })
  })
```

**New describe block, inserted after `describe('loadConfig embeddings', ...)` (after
`config.test.ts:208`, mirroring its own shape):**
```ts
describe('loadConfig dword', () => {
  function dword(env: Record<string, string>) {
    return loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).dword
  }

  it('is unconfigured without DWORD_USER_EMAIL, or with a blank one', () => {
    expect(dword({})).toEqual({ userEmail: null })
    expect(dword({ DWORD_USER_EMAIL: '' })).toEqual({ userEmail: null })
    expect(dword({ DWORD_USER_EMAIL: '   ' })).toEqual({ userEmail: null })
  })

  it('trims DWORD_USER_EMAIL', () => {
    expect(dword({ DWORD_USER_EMAIL: '  owner@example.com \n' })).toEqual({ userEmail: 'owner@example.com' })
  })

  it('keeps DEFAULT_DWORD_CONFIG unconfigured', () => {
    expect(DEFAULT_DWORD_CONFIG).toEqual({ userEmail: null })
  })
})
```
**Impact:** proves `parseDword` matches `parseEmbeddings`'s exact trim/blank rule, and that the
rest of `loadConfig()`'s contract (everything else unaffected by `DWORD_USER_EMAIL`) still holds.

## Principles applied

- **Boundary discipline:** `DWORD_USER_EMAIL` is parsed once, at config load (`parseDword`), into
  a typed `string | null`; `resolveDwordUserId` is the one place that turns it into a `users.id`,
  fresh per call. No other file re-parses or re-trims the raw env var.
- **Laziness protocol:** the thinnest possible `dword/index.ts` (a `SystemAbout` literal plus a
  one-line wrapper), reusing `createConnector`, `loadDatabaseTarget`, `CONNECTOR_PG_TYPES` exactly
  as `seer/index.ts` does — no new abstraction for a fourth system that fits the existing one.
- **Make illegal states unrepresentable:** `CONNECTOR_TOOL_NAMES` is typed `satisfies Record<SystemId,
  readonly string[]>`, so `dword` with no entry (or a typo'd key) is a compile error, not a runtime
  gap discovered later; the fail-soft and generic test literals being `Record<SystemId, ...>`-typed
  forced the same discipline in tests (Steps 8/11 would not compile otherwise).
- **Prove it works:** Step 8 proves `dword_schema`/`dword_sql` against a real throwaway Postgres
  rebuilt from daily-words' own migrations (no mock schema), the same bar the other three systems
  already clear in this file.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit: `tests/unit/connectors/names.test.ts`, `tests/unit/connectors/
failsoft.test.ts`, `tests/unit/connectors/dword.test.ts`, `tests/unit/chat-status.test.ts`,
`tests/unit/config.test.ts`) and `npm run test:int` (integration: `tests/integration/connectors/
generic.int.test.ts`'s new `dword_schema / dword_sql on the migrated schema` block).

**Proof:**
- Harness: `no harness` for this phase specifically — `verify-notesd` drives the running daemon
  over HTTP/MCP/Playwright, and this phase ships no user-reachable surface (no skill, no wall-chat
  wiring) for it to drive; the connector-level proof is the integration test harness
  (`tests/integration/connectors/*`), which is this repo's own purpose-built proof for connector
  plumbing — the same harness `expenses`/`runs`/`seer`'s generic tools are proven with today, with
  no feature-map entry either.
- Feature-map entries: none — no user-facing feature is added by this phase (see Interface
  Contract, "Leaves alone").
- Journeys (each a command, run from the worktree root):
  1. **`dword_schema` lists dword's real tables end to end.**
     ```sh
     npm run test:int -- tests/integration/connectors/generic.int.test.ts -t "dword_schema lists"
     ```
     End state: the test passes — `dword_schema` (called through an in-memory MCP client, exactly
     as the daemon's own MCP server would) returns `users`, `vocab_entries`, `journal_entries`,
     `journal_entry_embeddings` among its tables, and `vocab_entries.enrichment_status` reports type
     `text`. This runs against `connectors_dword`, a throwaway database `globalSetup.ts` rebuilds
     from `~/daily-words/drizzle/*.sql` before the suite starts — never the daemon's own database,
     never daily-words' production Neon.
  2. **`dword_sql` runs a SELECT and refuses a write.**
     ```sh
     npm run test:int -- tests/integration/connectors/generic.int.test.ts -t "dword_sql runs a SELECT"
     ```
     End state: `dword_sql` with `select count(*) as n from users` returns one numeric row; the
     same call with `delete from users` fails before reaching the database, message matching
     `/refused before reaching the database/` — proving the generic SQL guard applies to `dword`
     exactly as it does to the other three systems, with no dword-specific carve-out.
  3. **`resolveDwordUserId` gives the three documented outcomes.**
     ```sh
     npx vitest run tests/unit/connectors/dword.test.ts
     ```
     End state: all three `it`s in `describe('resolveDwordUserId', ...)` pass — unset email throws
     `ConnectorError` matching `/^daily-words user not configured/`; an unmatched email throws
     exactly `daily-words user nobody@example.com not found`; a matching row resolves to its id.
  4. **`DWORD_USER_EMAIL` is parsed and defaulted like every other optional single-string setting.**
     ```sh
     npx vitest run tests/unit/config.test.ts -t "loadConfig dword"
     npx vitest run tests/unit/config.test.ts -t "applies defaults"
     ```
     End state: both pass — `loadConfig({})` gives `dword: { userEmail: null }`; a set, padded
     value comes back trimmed.
- Neighbor check: the existing `expenses`/`runs`/`seer` generic-tool coverage in the same file
  (`generic.int.test.ts`) and the fail-soft suite (`failsoft.test.ts`) are the features most likely
  to break from a shared-type change (`SystemId`, `Connectors`, `CONNECTOR_TOOL_NAMES` all widen).
  Journey: `npm run test:int -- tests/integration/connectors/generic.int.test.ts` and
  `npx vitest run tests/unit/connectors/failsoft.test.ts` both pass unchanged in substance (their
  `expenses`/`runs`/`seer` assertions are untouched by this phase) — proving the widening broke
  nothing for the three systems that already worked.
- Cost: none — every journey above is a local test run against Docker Postgres (`test:int`) or
  pure in-process code (`npx vitest run`); no LLM call, no OpenRouter embedding, no `gh`, no live
  daily-words Neon connection.

**Exit criteria:** `dword_schema` and `dword_sql` answer real queries against a throwaway
dword-shaped Postgres (and, on this machine, against `~/daily-words`'s own migrated shape);
`resolveDwordUserId` resolves a real `users.id` or refuses with one of its two documented
messages; `npm run typecheck`, `npm test` and `npm run test:int` are all green.

## Handoffs

- **Phase 3 or 4 (whichever lands first):** no action needed. `tests/unit/connectors/names.test.ts`
  (Step 9) and `tests/unit/chat-status.test.ts` (Step 10) both derive their counts from
  `CONNECTOR_TOOL_NAMES`/`ALL_CONNECTOR_TOOL_NAMES` at runtime rather than a hardcoded literal (see
  the Reconciliation Log) — appending a curated name to `CONNECTOR_TOOL_NAMES.dword` in either phase
  keeps both files green with no edit to either test file.
- **Phase 4:** the single `registerDwordCurated(server, connectors.dword)` call into
  `src/connectors/register.ts`'s `registerConnectorTools` (per the plan index's Decisions table)
  is left for phase 4 to add; this phase's `register.ts` (Step 5) has no such call and no import
  for it.
- **Phase 2:** `src/dword/rules.ts` and `src/dword/writer.ts` do not exist after this phase; the
  `src/dword` directory itself is not created here, by design, so phase 2 starts it cleanly.
- **R6 (phases 5/6):** no `.claude/skills/verify-notesd/features/dword.md` is created by this
  phase — the feature map only gains an entry once a user-facing surface (a skill or wall chat)
  exists to document.

## Rollback

Revert this phase's commit(s). Every change is additive to a shared file (`names.ts`, `env.ts`,
`register.ts`, `config.ts`, `README.md`) or a brand-new file (`dword/index.ts`, `dword/user.ts`,
`dword.test.ts`); no existing system's behavior is touched. Dropping `'dword'` back out of
`CONNECTOR_SYSTEMS`/`CONNECTOR_TOOL_NAMES`/`SYSTEM_META` and deleting the two new `src/connectors/
dword/*` files returns `expenses`/`runs`/`seer` to exactly their pre-phase state; the test-literal
edits (Steps 9-13) revert along with it since they only added the fourth key/case each required.
Nothing in `~/daily-words` is ever touched (read-only throughout), so there is no data to roll back
there.
