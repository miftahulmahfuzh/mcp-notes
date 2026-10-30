# Plan: Connectors (mcp-notes iteration 5)

**Slug:** connectors
**Date:** 2026-10-30T12:47:12+07:00
**Analysis:** `docs/analyzer/20261030-124712-C5N7_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/connectors`
**Branch:** `feature/connectors` (base: `HEAD` of `main` @ `29259ae`)
**Phases:** 6
**Status:** phases 1, 3 and 6 of 6 complete
**Coordinator:** —

---

## Why

Verbatim from `docs/iterations/05-connectors.md` (full text, including the acceptance prompts, in the analysis document under "Original User Request"). The parts that set what may and may not change:

> Build mcp-notes iteration 5 ("Connectors") from docs/ROADMAP.md. The "Fixed decisions" table in
> docs/ROADMAP.md is binding: do not re-decide anything in it, in particular the "Other systems"
> row (read-only; credentials read at runtime from each repo's `.env.local`; every connection
> `default_transaction_read_only = on`; per system a `schema` tool, a row-limited `sql` tool and a
> few curated tools; Seer also reads `~/seer/lab/lab.sqlite` read-only).

> Read each repo's schema and README to learn what the data means. Do not edit anything in those
> repos, and do not import their code: they are separate projects that change on their own.

> Out of scope: any write to the three systems; changes to the three repos; embeddings and
> semantic search (iteration 6); image sync; connectors to anything else; caching their data in
> the notes database.

Acceptance (through `/n` and through the chat bar at http://localhost:7317):

    /n how are my spending this week? don't just tally the numbers and give me your inputs
    /n i did a run yesterday. show me how it went. what are your thoughts on this run?
    /n what are the best sera method that we have found up until now?
    /n compare my running this month with last month
    how much did i spend on meals in october, and which week was the worst?

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Connector core: module per system behind a shared shape; `.env.local` per call, no secret copied anywhere; read-only connection + read-only transaction; timeout, row cap, compact JSON; fail-soft; lab.sqlite read-only | 1 |
| R2 | MCP tools per system: `_schema`, `_sql` (Seer `source` db/lab), curated tools; WIB / integer rupiah / app units; instructions paragraph | 1, 2, 3, 4 |
| R3 | Chat bar allows + captions the new tools; `/n` routes data questions and gives an opinion | 5 |
| R4 | Answer panel never shows raw markdown link syntax | 6 |
| R5 | Unit tests (guard, cap, env, fail-soft), Docker integration per connector seeded from sibling migrations, INSERT proven to fail in the DB, no Neon in tests, opt-in live `_schema` check | 1, 2, 3, 4 |

R2 and R5 span phases 1–4 by construction: phase 1 owns the generic `_schema`/`_sql` tools, the instructions paragraph and the test harness; phases 2–4 each own one system's curated tools and their tests.

## Scope

**In scope:** `src/connectors/**` (new), connector registration in `src/mcp/server.ts`, the instructions paragraph, the chat allow list / captions / system prompt, the `/n` skill, link rendering in the answer panel, the Docker test harness for the three foreign schemas, the opt-in live check, README/INSTALL.

**Out of scope:** everything in the brief's out-of-scope list; any file in `~/expense-tracking`, `~/run-insights`, `~/seer` (read at test time only, never written, never imported as code); the notes DB schema; the look of the panel beyond link styling.

## Contract (binding on every phase; phase 1 implements the shared parts)

### Tool names — `src/connectors/names.ts` (phase 1 writes all 15 up front)

```ts
export const CONNECTOR_SYSTEMS = ['expenses', 'runs', 'seer'] as const;
export type SystemId = (typeof CONNECTOR_SYSTEMS)[number];

export const CONNECTOR_TOOL_NAMES = {
  expenses: ['expenses_schema', 'expenses_sql', 'expenses_spending', 'expenses_get', 'expenses_months'],
  runs: ['runs_schema', 'runs_sql', 'runs_list', 'runs_get', 'runs_review'],
  seer: ['seer_schema', 'seer_sql', 'seer_leaderboard', 'seer_positions', 'seer_sera_best'],
} as const satisfies Record<SystemId, readonly string[]>;

export type ConnectorToolName = (typeof CONNECTOR_TOOL_NAMES)[SystemId][number];
export const ALL_CONNECTOR_TOOL_NAMES: readonly ConnectorToolName[];   // flattened, in the order above
```

| System id | Label (used in errors) | Repo dir (default, env override) | Caption |
|---|---|---|---|
| `expenses` | `expense-tracking` | `~/expense-tracking`, `EXPENSE_TRACKING_DIR` | `reading expenses` |
| `runs` | `run-insights` | `~/run-insights`, `RUN_INSIGHTS_DIR` | `reading runs` |
| `seer` | `seer` | `~/seer`, `SEER_DIR`; lab = `<seer dir>/lab/lab.sqlite` | `reading seer` |

### Connector shape — `src/connectors/types.ts` (phase 1)

```ts
export interface QueryResult {
  columns: string[];          // column names, in order
  rows: unknown[][];          // compact: one array per row, aligned with columns
  row_count: number;          // rows.length
  truncated: boolean;         // true when more rows existed than the cap
}
export interface QueryOptions { maxRows?: number }   // default CONNECTOR_DEFAULT_ROWS, clamped to CONNECTOR_MAX_ROWS

export interface ReadOnlySource {
  /** One trusted, parameterised SELECT (curated tools). Read-only txn, statement timeout, row cap. No guard. */
  query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult>;
}

export interface Connector extends ReadOnlySource {
  id: SystemId;
  label: string;              // 'expense-tracking' | 'run-insights' | 'seer'
  /** Seer only: lab.sqlite opened read-only, queried in a child process with the same timeout/cap. */
  lab?: ReadOnlySource;
}

/** Thrown by every connector failure. message is already user-facing and secret-free:
 *  "<label> is not reachable: <reason>"  (missing repo, missing .env.local, no DB URL, connect/auth/network failure)
 *  "<label> query failed: <reason>"      (SQL error, timeout, read-only violation) */
export class ConnectorError extends Error {}
```

- `CONNECTOR_DEFAULT_ROWS = 200`, `CONNECTOR_MAX_ROWS = 1000`, statement timeout default `10_000` ms (`CONNECTOR_TIMEOUT_MS` env, read per call).
- Each `query` call: read `<repo>/.env.local` with dotenv `parse` (never `process.env` mutation), choose the **non-`-pooler` host** among `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (fallback: whichever exists), open a fresh `pg.Client` with `options: '-c default_transaction_read_only=on -c statement_timeout=<ms> -c TimeZone=Asia/Jakarta'`, run `BEGIN READ ONLY` → query (wrapped `SELECT * FROM (<sql>) AS q LIMIT <cap+1>`) → `ROLLBACK`, close. Type parsing (exact): `date`, `time`, `timestamp`, `timestamptz`, `interval`, `timetz` as their Postgres text (timestamptz in the Jakarta session, e.g. `2026-10-30 12:00:00+07`), `int8` as number when safe else string, `numeric` as number, `json`/`jsonb` parsed (pg default), booleans `true`/`false`.
- `connector.lab.query` (Seer): `node:sqlite` `DatabaseSync(path, { readOnly: true })` in a short-lived child process SIGKILLed at the timeout; positional `?` params (`null`, number, string); same `LIMIT cap+1` wrap; integers as numbers (strings above 2^53).
- `src/connectors/rows.ts` exports `toObjects(result): Record<string, unknown>[]`; curated code uses it (local alias names allowed, re-implementations not).
- Errors never contain the URL, password or user; the error-scrubber replaces any of them with `***`.
- Curated tools return their own JSON objects built from `query` results; they never use the SQL guard.

### Registration (phase 1)

- `src/connectors/register.ts`: `registerConnectorTools(server: McpServer, connectors: Connectors): void` registers, per system, `<id>_schema` and `<id>_sql` (generic, phase 1) and calls that system's curated registrar.
- `src/connectors/<id>/curated.ts` exports `register<Expenses|Runs|Seer>Curated(server: McpServer, connector: Connector): void`. **Phase 1 creates each as a no-op stub; phases 2, 3, 4 replace exactly their own file** (and may add sibling files in their own `src/connectors/<id>/` directory). No phase other than 1 edits `register.ts`, `names.ts`, `server.ts` or `instructions.ts`.
- Curated tool results go through the same helpers (`src/mcp/tools.ts`, edited by phase 1 only): `jsonResult(value, compact = false)`, `run(fn, { compact?: boolean })`, `errorResult(err)`. Every connector tool, generic or curated, uses `run(fn, { compact: true })`. A `ConnectorError` becomes an `isError` result whose text is the bare message; any other `Error` keeps the `error: <message>` form; a `NoteError` keeps `<code>: <message>`.

### Integration harness (phase 1)

- Second Docker container `mcp-notes-pg-connectors`, image `pgvector/pgvector:pg16`, **`127.0.0.1:55435`** (never 55434, which is `mcp-notes-pg-demo`), started/reused by `scripts/test-int.sh`, which exports `TEST_CONNECTORS_URL` (admin URL). It refuses Neon URLs like `tests/integration/setup.ts` does.
- `tests/integration/connectors/harness.ts` (phase 1; shared half in `siblings.ts`) exports exactly:
  ```ts
  connectorsAdminUrl(): string                        // TEST_CONNECTORS_URL; throws when unset or Neon
  siblingRepo(id: SystemId): string | null            // sync
  describeWithRepo(id, name: string, fn: () => void): void   // sync; describe.skip with the reason when the repo is absent
  systemDbName(id): string                            // 'connectors_<id>'
  systemDbUrl(id): string                             // sync; WRITABLE admin URL of that system's database
  truncateSystem(id): Promise<void>                   // TRUNCATE every public table RESTART IDENTITY CASCADE (seer: roster rows too)
  seedSystem(id, sql: string, params?: readonly unknown[]): Promise<void>
  withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T>   // refuses Neon
  connectorFor(id, overrides?: { databaseUrl?: string; envLocal?: string | null; repoDir?: null; labPath?: string; timeoutMs?: number }): Connector  // sync
  makeLab(rows?: { methods?; trials?; trial_funding?; insights? }): { path: string; dir: string }   // sync; tables meta, methods, trials, trial_funding, insights
  connectorClient(connectors: Partial<Connectors>): Promise<ConnectorClient>  // in-memory MCP client over registerConnectorTools
  cleanupHarness(): void
  ```
  Databases are built in globalSetup from the sibling repo's migrations (drizzle `_journal.json` order for expenses/runs, file-name order of `db/migrations/*.sql` for seer).
- Phases 2–4 add `tests/integration/connectors/<id>.curated.int.test.ts`; they do not edit the harness. Each file runs `truncateSystem(id)` then seeds its own rows (via `seedSystem` or `withAdmin`) in `beforeAll`/`beforeEach`, and calls `cleanupHarness()` in `afterAll`. Integration files run one at a time but share the per-system databases, so no file may depend on another's rows; phase 1's generic tests assert types and refusals only, never row counts.
- Tool-list assertions anywhere in phases 1–4 check "the expected names are present and every connector name is in `ALL_CONNECTOR_TOOL_NAMES`", never an exact count, so phases 2–4 land in any order.
- Every phase's verification starts with `npm ci` at the worktree root (worktrees have no `node_modules`; no symlinks).

## Invariants

1. `npm run typecheck`, `npm test` and `npm run test:int` are green at the end of every phase.
2. The ROADMAP "Fixed decisions" table is not re-decided.
3. Nothing in `~/expense-tracking`, `~/run-insights`, `~/seer` is written, and none of their code is imported. Their migrations are read as files by the test harness only.
4. No secret from a sibling `.env.local` is written to this repo, a log line, a note, a tool result or an error message. `.env.local` is read at call time, never at daemon start.
5. Every Postgres connection carries `default_transaction_read_only=on` and every query runs inside `BEGIN READ ONLY`; lab.sqlite is opened `readOnly`. No connector code path issues a write.
6. A connector failure is a tool error for that call only; it never throws out of the MCP handler, never crashes notesd, and never affects the notes tools or the other connectors.
7. No test touches a Neon database except the opt-in live check, which only calls the `_schema` tools.
8. The chat agent's allow list = the 13 notes tools + the 15 connector tools + WebSearch + WebFetch, nothing else (supersedes iteration 4's invariant 4).
9. notesd still binds 127.0.0.1 only.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 ✓ | Connector core, generic tools, test harness | R1, R2, R5 | `src/connectors`, `src/mcp`, `tests`, `scripts` | 39 | — | HARD | `.workflows/plan/connectors/phase-1.md` | P1-NOTES-A012 | — |
| 2 | expense-tracking curated tools | R2, R5 | `src/connectors/expenses` | 8 | 1 | NORMAL | `.workflows/plan/connectors/phase-2.md` | — | — |
| 3 ✓ | run-insights curated tools | R2, R5 | `src/connectors/runs` | 8 | 1 | NORMAL | `.workflows/plan/connectors/phase-3.md` | P1-NOTES-A014 | — |
| 4 | Seer curated tools (db + lab) | R2, R5 | `src/connectors/seer` | 10 | 1 | HARD | `.workflows/plan/connectors/phase-4.md` | — | — |
| 5 | Chat bar + /n for connectors | R3 | `src/chat`, `claude/skills/n` | 7 | 1 | NORMAL | `.workflows/plan/connectors/phase-5.md` | — | — |
| 6 ✓ | Readable links in the answer panel | R4 | `web/src` | 5 | — | EASY | `.workflows/plan/connectors/phase-6.md` | P2-NOTES-C506 | — |

Phase 1 spans R1, R2 and R5 because the generic tools and their tests cannot be built apart from the core they exercise. Phases 2–5 depend on phase 1 only through the contract above (names, `Connector`, `toObjects`, `run`, harness), so they run concurrently in separate sessions; no file is edited by two of them (each of 2–4 writes only `src/connectors/<id>/**` and its own `<id>`-prefixed tests; phase 5 writes `src/chat/**`, `claude/**`, its README hunks and one line of an old plan). Phase 6 shares nothing with the others and may run alongside phase 1.

### Phase 1 — Connector core, generic tools, test harness
**Satisfies:** R1, R2 (`_schema`, `_sql`, instructions paragraph), R5 (unit tests, harness, generic int tests, INSERT-fails proof, live check)
**Owns:** `src/connectors/{names,types,errors,env,rows,pg,lab,guard,connector,schema,sql,register}.ts`, `src/connectors/<id>/index.ts` + stub `curated.ts` for all three systems, `src/mcp/server.ts` (call `registerConnectorTools`), `src/mcp/tools.ts` (sole editor: `ToolDeps.connectors?`, `jsonResult(value, compact)`, `run(fn, { compact })`, bare `ConnectorError` text), `src/mcp/instructions.ts` + `tests/unit/mcp.instructions.test.ts`, `scripts/test-int.sh`, `vitest.config.ts`, `package.json` (scripts only), `tests/integration/connectors/{siblings,harness,globalSetup,core.int.test,generic.int.test,mcp.int.test}.ts`, `tests/unit/connectors/{names,guard,rows,env,failsoft}.test.ts`, `tests/live/connectors.live.test.ts`, README (TOC line, the connectors section with all 15 tool rows including phases 2–4's inputs, Tests, Configuration, MCP-tools intro, Limitations bullet, layout line), `docs/INSTALL.md` ("5. Connectors").
**Does not touch:** `src/connectors/<id>/curated.ts` bodies (stubs only), `src/chat/**`, `claude/**`, `web/**`, README's "Using it from Claude Code" and "The chat bar" (phase 5), the README Roadmap row (completion).
**Exit criteria:** `tools/list` on `/mcp` shows the 6 generic tools (tests assert presence and contract membership, not a count); `_schema` returns tables/columns/types/comments from the live DB (and lab for seer); `_sql` rejects writes and multi-statements before the DB, caps rows, and `select nextval(...)`/an INSERT through the unguarded executor fail inside the DB with a read-only error; missing repo / `.env.local` / unreachable DB give the short error and other tools keep working; `npm run test:live:connectors` exists and is excluded by default.

### Phase 2 — expense-tracking curated tools
**Satisfies:** R2, R5
**Owns:** `src/connectors/expenses/{curated,categories,dates,queries}.ts`, `tests/unit/connectors/expenses.{dates,categories,queries}.test.ts`, `tests/integration/connectors/expenses.curated.int.test.ts`.
**Does not touch:** anything phase 1 owns (README included), `src/connectors/{runs,seer}/**`.
**Exit criteria:** `expenses_spending` (`from`/`to`, optional `categories`, `top` → total, by category with Indonesian label, by day, by ISO week Monday–Sunday with partial flags, largest items), `expenses_get` (`id` → one expense group with items, photo count/urls, note, raw text), `expenses_months` (`months`, `to_month`, `categories` → monthly totals, zero-filled) return correct integers on seeded data; handlers use `run(…, { compact: true })` and phase 1's `toObjects`.

### Phase 3 — run-insights curated tools
**Satisfies:** R2, R5
**Owns:** `src/connectors/runs/{curated,format,periods,queries}.ts`, `tests/unit/connectors/runs.{format,periods,curated}.test.ts`, `tests/integration/connectors/runs.curated.int.test.ts`.
**Does not touch:** anything phase 1 owns (README included), `src/connectors/{expenses,seer}/**`.
**Exit criteria:** `runs_list` (`from`, `to` default today → reviewed runs with key metrics and period totals), `runs_get` (exactly one of `id` or `date`: metrics, splits, zones, the app's latest session insight), `runs_review` (`scope` week|month, `key` week/month/day → latest review + totals for that period) correct on seeded data; units are the app's (metres, seconds, sec/km, bpm), each with a human-readable companion (km, `m:ss /km`); handlers use `run(…, { compact: true })` and phase 1's `toObjects`.

### Phase 4 — Seer curated tools (db + lab)
**Satisfies:** R2, R5
**Owns:** `src/connectors/seer/{curated,rows,ranking,leaderboard,positions,sera}.ts`, `tests/unit/connectors/seer.{ranking,sera,curated}.test.ts`, `tests/integration/connectors/seer.curated.int.test.ts`.
**Does not touch:** anything phase 1 owns (README included), `src/connectors/{expenses,runs}/**`.
**Exit criteria:** `seer_leaderboard` ranks as the app does (common dates, ≥63 shared sessions, annualised Sharpe, tie-breaks; benchmarks and retired not ranked, shown separately), `seer_positions` lists open bracket orders and book positions with marks and unrealised P&L, `seer_sera_best` lists the best variant per method from lab.sqlite with the lab's metrics, correct on seeded Postgres + `makeLab()` lab; handlers use `run(…, { compact: true })` and phase 1's `toObjects`.

### Phase 5 — Chat bar + /n for connectors
**Satisfies:** R3
**Owns:** `src/chat/status.ts`, `src/chat/prompt.ts`, `tests/unit/chat-status.test.ts`, `tests/unit/chat-prompt.test.ts`, `claude/skills/n/SKILL.md`, README (one TOC line under "Using it from Claude Code", the new `/n` subsection "Spending, runs and Seer", the first two paragraphs of "The chat bar"; quoted as phase 1 leaves README), `docs/plans/CHAT_BAR_BRAIN_PLAN.md` invariant 4 note (one line).
**Does not touch:** `src/connectors/**` (imports `names.ts` only: `ALL_CONNECTOR_TOOL_NAMES`, `CONNECTOR_TOOL_NAMES`, `CONNECTOR_SYSTEMS`, `SYSTEM_META`), `src/mcp/**`, `src/chat/agent.ts`, `tests/unit/chat-agent.test.ts`, `web/**`, phase 1's README hunks.
**Exit criteria:** `allowedChatTools()` = 13 notes + 15 connector + 2 web tools; captions "reading expenses" / "reading runs" / "reading seer" (from `SYSTEM_META`) for every connector tool; system prompt names the three systems, says curated first / `_sql` last / `_schema` before SQL, and asks for what the data shows plus an opinion; `/n` routes spending/runs/Seer questions to the connector tools with phases 2–4's real parameters.

### Phase 6 — Readable links in the answer panel
**Satisfies:** R4
**Owns:** `web/src/components/AnswerPanel.tsx`, a link segmenter in `web/src/lib/` with its test, `web/src/styles.css` (link style), `web/src/components/AnswerPanel.test.tsx` (new).
**Does not touch:** `src/**`, `claude/**`.
**Exit criteria:** markdown links `[text](https://…)` render as an underlined `<a>` showing the text, bare `http(s)://` URLs render as underlined links, both open in a new tab with `rel="noreferrer noopener"`, styled in the caption family; raw `[..](..)` never appears; streaming partial links degrade to plain text until complete.

## Reconciliation Log

| # | Conflict | Class | Phases | Resolution |
|---|---|---|---|---|
| 1 | `failsoft.test.ts` asserted exactly the six generic tool names; phases 2–4 add curated tools and would turn phase 1's test red in whichever order they land | Broken-build phase | 1 vs 2, 3, 4 | Phase 1 test now asserts the generic six are present and every registered name is in `ALL_CONNECTOR_TOOL_NAMES` (no count); `mcp.int.test.ts` already used `arrayContaining` |
| 2 | Phases 2–4 required `run(fn)` (pretty JSON); phase 1's contract tells curated tools to use `run(fn, { compact: true })` | Contract drift | 2, 3, 4 vs 1 | All nine curated handlers now pass `{ compact: true }`; Requires sections quote the real `run` signature and error rendering |
| 3 | `rowsOf` (2), `rowsToObjects` (3) and seer `toObjects` (4) re-implemented phase 1's `toObjects` | Duplicate work | 2, 3, 4 vs 1 | Each imports `toObjects` from `../rows.js` under its local name (alias / re-export); definitions removed |
| 4 | Phases 2 and 3 `await`ed `systemDbUrl`/`connectorFor` "whether sync or async"; phase 1 defines them sync | Unmet assumption | 2, 3 vs 1 | Int tests call them synchronously; only `truncateSystem`/`withAdmin` are awaited |
| 5 | Phase 4 guessed `makeLab()` returns a string or `{path}` and re-created the lab tables defensively | Unmet assumption | 4 vs 1 | `seerConnector()` uses `makeLab()` → `{ path, dir }` and phase 1's tables; the local `CREATE TABLE IF NOT EXISTS` block is removed; inserts checked against phase 1's columns |
| 6 | Phases 2–4 seeded through raw `pg.Client` (no Neon refusal) and never cleaned the temp repo dirs `connectorFor`/`makeLab` create | Unmet assumption | 2, 3, 4 vs 1 | Seeding via `withAdmin(systemDbUrl(id), …)` (2, 3) and `seedSystem` (4); `cleanupHarness()` in each `afterAll` |
| 7 | Phase 3 handoff said the connectors container is on 55434 (taken by `mcp-notes-pg-demo`) | Contract drift | 3 vs 1 | Handoff rewritten: 55435; the index contract states "never 55434" |
| 8 | Phases 3–4 assumed type parsing (numeric → number, dates as text, json parsed) that phase 1 only partly stated | Unmet assumption | 3, 4 vs 1 | Verified against phase 1's `parserFor`: all hold (json/bool fall through to pg defaults). Phase 1 contract, its `CONNECTOR_PG_TYPES` comment, phase 4's Requires and the index now state the exact parsing |
| 9 | Shared per-system DBs: phase 4 carried a redundant `TRUNCATE strategies…`, phase 2 asked phase 1's files to truncate too | File collision (shared state) | 1, 2, 3, 4 | Rule: each curated int file truncates then seeds its own rows; phase 1's generic tests assert only types/refusals; phase 4's redundant TRUNCATE removed (its `truncateSystem` already clears the migrations' roster rows) |
| 10 | README: phases 2–4 proposed tool one-liners for phase 1; phase 5 quoted pre-phase-1 README line numbers | File collision | 1, 2, 3, 4, 5 | Phase 1's 15 rows now carry phases 2–4's inputs; phases 2–4 state they never edit README; phase 5 anchors its three hunks on text as phase 1 leaves README (no overlapping hunk) |
| 11 | Phase 5's skill described curated tools by purpose only, attributed the run analysis to Nina, and lacked inputs (`categories` list, `id` xor `date`, `scope`/`key`, Sera filters, eligibility caveat) | Contract drift | 5 vs 2, 3, 4 | Skill routing section rewritten from phases 2–4's schemas; prompt and skill description say "the app's own analyses" |
| 12 | Phase 1's instructions paragraph lacked "`_schema` before SQL", which phase 5's prompt, skill and exit criteria require | Contract drift | 1 vs 5 | Paragraph now ends "…only when they don't answer, and call <system>_schema before writing SQL…"; phase 1's test asserts it |
| 13 | Verification setup inconsistent: phase 1 offered `npm ci` or a symlink, phases 2–6 had none | Contract drift | all | Every phase's Verification starts with `npm ci` at the worktree root |
| 14 | Phase 5 hard-coded the three captions that phase 1's `SYSTEM_META` already defines | Duplicate work | 5 vs 1 | `CONNECTOR_CAPTIONS` derived from `SYSTEM_META[id].caption` |
| 15 | Index contract drifted from phase 1: harness list incomplete (no `seedSystem`, `withAdmin`, `cleanupHarness`, exact shapes), Owns missed `rows.ts`/`connector.ts`/`siblings.ts`, file counts were estimates; phase 1 still carried a "Deviation" request already applied to Decisions | Contract drift | index vs 1 | Index contract, phase table and per-phase Owns/Exit criteria rewritten from the plans; phase 1's Deviation section marked resolved |

Checked with no conflict: `src/mcp/tools.ts`, `register.ts`, `names.ts`, `server.ts`, `instructions.ts`, `vitest.config.ts` are edited by phase 1 only; phases 2, 3, 4, 5 share no file; phase 6 shares no file with any phase; every `Depends on` points backward; no symbol is deleted anywhere; R1–R5 each have an owner.

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| R4: panel renders links vs prompt asks for bare URLs | panel renders markdown links and bare URLs as real links; prompt unchanged for links | 5: user's raw input ("planner's choice, but the panel must never show raw markdown link syntax") — only the panel can guarantee "never", whichever brain (Claude or GLM) answers |
| Which `.env.local` URL a connector uses | the non-`-pooler` host of `DATABASE_URL`/`DATABASE_URL_UNPOOLED`, chosen by host, not by key name | 1: invariant 5 (read-only on the connection) — Neon poolers reject startup `options` (measured in analysis) |
| Driver | `pg` over TCP (already a dependency), fresh client per call | 6: convention + measured: direct Neon hosts accept `options` over TCP |
| Tool prefixes | `expenses_`, `runs_`, `seer_` | 6: convention — short, and they match the captions the brief names |
| Owner scoping in curated tools | no `user_id` filter; each app has one owner | 5: user's raw input ("my own apps") |
| run-insights aggregates | `reviewed_at IS NOT NULL` for lists and totals (matches the app); `runs_get` returns unreviewed runs too, flagged | 6: the app's own convention (`lib/db/schema.ts` header) |
| Sera "best" | best variant per method by the lab's own rule (`ORDER BY mar DESC, n ASC` over dev trials); report stored `eligible` as `eligible_at_run`, plus the hurdles recomputable from stored columns; DSR not re-derived | 5/6: brief names lab.sqlite as the source; re-deriving DSR at current N would port the lab's statistics, beyond "curated read" |
| lab.sqlite driver | `node:sqlite` `DatabaseSync(path, { readOnly: true })`, run in a short-lived child process SIGKILLed at the timeout (phase 1 plan; a `worker_threads` worker cannot be stopped while sqlite is in native code) | 1: invariant 5 + R1 timeout; no new native dependency |
| Curated tool output: pretty JSON via `run(fn)` (phases 2–4 drafts) vs compact via `run(fn, { compact: true })` (phase 1) | compact for every connector tool, generic and curated | 4: R1 "returns rows as compact JSON"; phase 1's `run` options exist for exactly this |
| Row-to-object helper: local copies in phases 2, 3, 4 vs phase 1's `toObjects` | one implementation, `src/connectors/rows.ts` `toObjects`; phases keep local alias names (`rowsOf`, `rowsToObjects`, seer `rows.ts` re-export) so their tests are unchanged | 3: phase 1's code block exports it and its notes bind phases 2–4 to it |
| Phase 1's tool-list tests: exact six names vs presence | presence of the generic six + every registered name in `ALL_CONNECTOR_TOOL_NAMES` (no counts) | 1: invariant 1 (every phase green); phases 2–4 land concurrently in any order |
| Harness shapes guessed by phases 2–4 (sync-or-async, `makeLab` returning a path or `{path}`) | phase 1's exact shapes: `systemDbUrl`, `connectorFor`, `makeLab`, `describeWithRepo` sync; `makeLab` → `{ path, dir }` with the lab tables created; seeding via `seedSystem`/`withAdmin`; `cleanupHarness` in `afterAll` | 3: phase 1's harness code block (the owner) |
| Whose analysis `runs_get` returns: "coach Nina's analyses" (phase 5 draft) vs "the app's own analysis" (phases 1, 3) | the app's own `insights` analysis; Nina is named only as the coach (chat, `nina_*`, via `runs_sql`) | 3: phase 1 `RUNS_ABOUT` and phase 3 tool descriptions |
| Instructions paragraph vs chat prompt/skill wording | all three say: curated tools first, `_sql` only when they don't answer, `_schema` before writing SQL | 2: phase 5 exit criteria ("curated first / `_sql` last / `_schema` before SQL"); phase 1's test keeps its required phrases |
| README rows for the curated tools: phase 1 vs phases 2–4 | phase 1 writes all 15 rows with phases 2–4's real inputs; phases 2–4 never edit README; phase 5 anchors on text as phase 1 leaves it | 3: phase 1's README step (owner of the connectors section) |
| Chat captions: phase 5 literal map vs `SYSTEM_META.caption` | `CONNECTOR_CAPTIONS` derived from `SYSTEM_META` (one source) | 3: phase 1 `names.ts` code block + its handoff to phase 5 |
| Dependency setup in each worktree: `npm ci` vs symlinking `~/mcp-notes/node_modules` | `npm ci` at the worktree root, first step of every phase's verification | 6: convention (lockfile install); concurrent worktrees must not share one `node_modules` |

## Open Questions

(none)

## Rollback

Per phase: revert that phase's commit; phases 2–5 only add files under their own directories or edit files phase 1 does not own (phase 5's README hunks are separate from phase 1's). Whole set: revert the branch merge; nothing is migrated, nothing in the notes DB changes, the sibling repos are untouched.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f docs/plans/CONNECTORS_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows, resumable on any machine:

    /analyze-orchestrator -f docs/plans/CONNECTORS_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan docs/plans/CONNECTORS_PLAN.md
