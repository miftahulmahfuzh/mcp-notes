# Code Analysis: mcp-notes iteration 5 — Connectors

**Type:** Feature Implementation
**Date:** 2026-10-30T12:47:12+07:00
**Session ID:** 20261030-124712-C5N7
**Plan:** `docs/plans/CONNECTORS_PLAN.md` (6 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/connectors`, branch `feature/connectors` (base `HEAD` of `main` @ `29259ae`; local main is 6 commits ahead of `origin/main`)

---

## User Input

### Original User Request

Verbatim from `docs/iterations/05-connectors.md`, everything below its `---` line:

```

Build mcp-notes iteration 5 ("Connectors") from docs/ROADMAP.md. The "Fixed decisions" table in
docs/ROADMAP.md is binding: do not re-decide anything in it, in particular the "Other systems"
row (read-only; credentials read at runtime from each repo's `.env.local`; every connection
`default_transaction_read_only = on`; per system a `schema` tool, a row-limited `sql` tool and a
few curated tools; Seer also reads `~/seer/lab/lab.sqlite` read-only). Iterations 1–4 are on
main (plans: docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md, docs/plans/CHAT_BAR_BRAIN_PLAN.md).

The three systems are my own apps, each with its own Neon database and its own README:
  - ~/expense-tracking: expenses parsed from pasted text, in rupiah, grouped by month, with
    categories and photos (README.md, lib/db/schema.ts).
  - ~/run-insights: Apple Watch runs read from screenshots (pace, distance, heart rate, splits),
    weekly/monthly reviews, and a coach, Nina (README.md, lib/db/schema.ts).
  - ~/seer: a quantitative trading lab. Strategies, positions, trades, a leaderboard, and Sera,
    the method lab, whose experiments live in ~/seer/lab/lab.sqlite (README.md, db/, lab/,
    engine/).
Read each repo's schema and README to learn what the data means. Do not edit anything in those
repos, and do not import their code: they are separate projects that change on their own.

R1 — Connector core. One connector module per system behind a shared shape, so a fourth system
is one more module. Each connector:
  - reads that repo's `.env.local` at call time (not at daemon start, so rotated credentials work
    without a restart) and never copies a secret into this repo, a log, a note or a tool result;
  - opens its Postgres connection with `default_transaction_read_only = on` and also runs every
    query inside a read-only transaction, so a write fails at the database even if a tool were
    wrong;
  - has a statement timeout and a row cap, and returns rows as compact JSON with the column
    names;
  - fails soft: a missing repo, a missing `.env.local` or an unreachable database is a short tool
    error ("expense-tracking is not reachable: …"), never a daemon crash, and the other
    connectors keep working.
Seer's lab.sqlite is opened read-only (`mode=ro`, no write lock taken, safe while Seer's own
processes use the file).

R2 — MCP tools, per system, registered on the existing `notes` MCP server so `/n` and the chat
bar get them with no extra registration:
  - `<system>_schema`: tables, columns, types and the comments or meaning a reader needs, built
    from the live database (and for Seer, also lab.sqlite).
  - `<system>_sql`: a single read-only SELECT (or WITH … SELECT), row-limited, for questions the
    curated tools do not cover. For Seer it takes a `source` of `db` or `lab`.
  - A few curated tools per system that answer the common questions in one call, with
    descriptions written for Claude. Pick them from the usage examples and from what each app's
    own UI shows. At least:
      expense-tracking: spending for a date range (totals by category and by day, the largest
        items) and a single expense with its items.
      run-insights: runs in a date range with their key metrics, and one run in full (splits,
        heart rate, the app's own analysis text if it stores one).
      seer: the current leaderboard and open positions, and the best Sera methods so far with
        the metrics the lab uses to rank them.
  Dates use my timezone (WIB, Asia/Jakarta), money stays in rupiah as integers, and units are
  the app's own.
  The MCP server instructions gain one short paragraph on the connectors: they are read-only,
  what each system is, and "prefer the curated tools, use `_sql` only when they don't answer".

R3 — Chat bar and /n. The chat bar agent (src/chat) allows the new tools exactly as it allows
the notes tools, and its status line gets captions for them ("reading expenses", "reading
runs", "reading seer"). The `/n` skill (claude/skills/n/SKILL.md) learns that questions about
spending, runs and Seer go to those tools, and that the answer should say what the data shows
and what Claude thinks about it, not just a tally.

R4 — Fix from iteration 4. Chat bar answers that cite web pages end with raw markdown links
("[BookBrowse summary](https://…)"), because the answer panel renders plain text. Make links
readable in the panel: either the panel turns URLs and markdown links into real, underlined
links in the design's caption style, or the system prompt asks for bare URLs. Planner's choice,
but the panel must never show raw markdown link syntax.

R5 — Tests. Unit tests for the read-only guard (writes and multi-statement SQL rejected before
they reach the database), the row cap, env loading and the fail-soft paths. Integration tests run
each connector against a Docker Postgres seeded from that repo's drizzle migrations (read from
the sibling repo at test time, skipped with a clear message if the repo is absent), plus a
temporary SQLite file for the lab. Prove that an INSERT through `_sql` fails inside the
database, not only in the guard. No test touches the real Neon databases. One opt-in live check
(excluded by default) runs each `_schema` tool against the real databases, read-only.

Acceptance (through `/n` in Claude Code and through the chat bar at http://localhost:7317):
  /n how are my spending this week? don't just tally the numbers and give me your inputs
  /n i did a run yesterday. show me how it went. what are your thoughts on this run?
  /n what are the best sera method that we have found up until now?
  /n compare my running this month with last month
  how much did i spend on meals in october, and which week was the worst?

Out of scope: any write to the three systems; changes to the three repos; embeddings and
semantic search (iteration 6); image sync; connectors to anything else; caching their data in
the notes database.
```

### User-Provided Context
The ROADMAP "Fixed decisions" table (`docs/ROADMAP.md`) is binding, in particular the "Other systems" row:
> Read-only. Credentials read at runtime from `~/expense-tracking/.env.local`, `~/run-insights/.env.local`, `~/seer/.env.local`; every connection `default_transaction_read_only = on`. Per system: `schema` tool, row-limited `sql` tool, a few curated tools. Seer also reads `~/seer/lab/lab.sqlite` read-only.

### User-Provided Files
- `docs/ROADMAP.md`, `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md`, `docs/plans/CHAT_BAR_BRAIN_PLAN.md`
- `~/expense-tracking` (README.md, lib/db/schema.ts), `~/run-insights` (README.md, lib/db/schema.ts), `~/seer` (README.md, db/, lab/, engine/)
- `src/chat`, `claude/skills/n/SKILL.md`

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Connector core: one module per system behind a shared shape; `.env.local` read per call, secrets never copied; read-only connection + read-only transaction; statement timeout, row cap, compact JSON with column names; fail-soft errors; lab.sqlite opened read-only |
| R2 | MCP tools per system on the existing `notes` server: `<system>_schema`, `<system>_sql` (Seer: `source` db/lab), curated tools (minimums listed per system), WIB dates / integer rupiah / app units, one paragraph in the MCP server instructions |
| R3 | Chat bar allows the new tools and captions them ("reading expenses/runs/seer"); `/n` skill routes spending/runs/Seer questions to them and asks for an opinion, not a tally |
| R4 | Answer panel never shows raw markdown link syntax: links become real underlined caption-style links, or the prompt asks for bare URLs (planner's choice) |
| R5 | Tests: unit (guard, row cap, env loading, fail-soft), integration per connector on Docker Postgres seeded from the sibling repo's migrations (skip if absent) + temp SQLite lab, an INSERT through `_sql` proven to fail in the database, no test touches Neon, one opt-in live `_schema` check |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** notesd (one Hono daemon, `src/daemon.ts`) serves a stateless MCP server (`src/mcp/server.ts`, fresh `McpServer` per POST) with 13 note tools. Iteration 5 adds a second family of tools on the same server: read-only access to three foreign Postgres databases (Neon) and one SQLite file, owned by sibling repos that this repo must neither edit nor import. Each system gets a schema-introspection tool, a guarded ad-hoc SQL tool, and 3 curated tools whose SQL mirrors what each app's own UI computes. The chat bar agent (Agent SDK, `src/chat/agent.ts`) currently allows exactly the 13 note tools + WebSearch/WebFetch (`allowedChatTools`, `src/chat/status.ts:32`), so the new tools must be added there with captions. The `/n` skill must learn to route data questions. Separately, the answer panel (`web/src/components/AnswerPanel.tsx`) renders the answer as plain `<p>` text, so markdown links appear raw.

**Success Criteria.**
- 15 new MCP tools (5 per system) listed by `tools/list` on `/mcp`; each answers from live data, read-only, with a short error when the system is unreachable and without affecting other tools.
- No credential string ever appears in a tool result, a log line, a note, or a file in this repo.
- A write cannot succeed even if the guard is bypassed (Postgres: read-only session + `BEGIN READ ONLY`; SQLite: `readOnly` open).
- The chat bar and `/n` answer the five acceptance prompts using these tools.
- The answer panel shows readable links.
- `npm run typecheck`, `npm test`, `npm run test:int` green; live check opt-in only.

**Key Considerations (observed facts that constrain the design).**
1. **Neon poolers reject startup `options`.** Probed during analysis (read-only `SELECT current_setting(...)`, no values printed): with `pg.Client({ options: '-c default_transaction_read_only=on -c statement_timeout=5000' })` all three pooled URLs (`-pooler` host) fail with `unsupported startup parameter in options: statement_timeout. Please use unpooled connection…`; all three unpooled URLs connect and report `default_transaction_read_only=on`, `statement_timeout=5s`, `TimeZone=GMT`. So the connector must pick the **non-pooler host** of `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (by host, as `src/config.ts:118-128` does for notes, in reverse), and connect with plain `pg` over TCP (pg 8.23.1 is already a dependency). pg prints an `sslmode` deprecation warning for `sslmode=require` URLs.
2. **run-insights migrations need pgvector** (`drizzle/0023_dry_kabuki.sql:17` `CREATE EXTENSION IF NOT EXISTS vector`, HNSW indexes in 0023/0026 → pgvector ≥ 0.5). The existing test container `mcp-notes-pg-test` is `postgres:16` (`scripts/test-int.sh:13`), which has no pgvector.
3. **Each app is single-user in practice but every table is scoped by `user_id`.** Curated tools see one owner.
4. **Seer's leaderboard is not stored.** It is computed in TS (`~/seer/web/lib/data.ts:526`, `web/lib/metrics.ts:18`, `web/app/(app)/leaderboard/view.ts:281`, port of `engine/src/seer_engine/paper/compare.py`).
5. **Sera eligibility is not trustworthy as stored**: the frozen `trials.eligible` column records the bar in force on the run date; the live verdict recomputes DSR at the current N (`~/seer/engine/src/seer_engine/lab/store.py:1810`, `:1589`, `DSR_MIN=0.90` at `:167`). The lab's own "best variant per method" orders by MAR (`store.py:1367-1411`; export leaderboard `LEADERBOARD_SQL` `store.py:2925`).
6. **node:sqlite is available** (Node v22.23.1): `new DatabaseSync(path, { readOnly: true })` opened `~/seer/lab/lab.sqlite` during analysis; `journal_mode=delete`; it emits an `ExperimentalWarning`. Its API is synchronous: a long query blocks the event loop unless run off-thread.
7. **Dates:** expense `occurred_on` and run `occurred_on` are Postgres `date` = Asia/Jakarta calendar day; seer `date` columns are NYSE session dates (America/New_York). Neon sessions default to `TimeZone=GMT`.
8. **The `/mcp` server is rebuilt per request** (`src/mcp/server.ts:23-34`), so connector state must not live in the server; credentials read per call fits naturally.

**Assumptions.**
- The three repo roots default to `~/expense-tracking`, `~/run-insights`, `~/seer`; tests need to point them elsewhere, so they are overridable by env.
- No caching of foreign data (out of scope), so each tool call opens and closes its own connection.

---

## Analysis Scope

### Explicitly Mentioned Files
- `docs/ROADMAP.md`, `docs/iterations/05-connectors.md`, `docs/plans/CHAT_BAR_BRAIN_PLAN.md`
- `src/chat/*`, `claude/skills/n/SKILL.md`

### Discovered Related Files (mcp-notes)
- `src/mcp/server.ts` — `createMcpServer` registers `registerNoteTools` + `registerImageTools`; stateless per-POST handling
- `src/mcp/tools.ts` — `ToolDeps {service, dataDir, db}` (:9-14), `jsonResult` (:120, pretty-printed `JSON.stringify(v,null,2)`), `errorResult` (:124), `run` (:130), tool registration idiom `server.registerTool(name, {title, description, inputSchema: zod shape, annotations}, handler)`
- `src/mcp/instructions.ts` — `buildInstructions(timeZone)` returns joined `sections` (8 paragraphs); unit-tested in `tests/unit/mcp.instructions.test.ts`
- `src/mcp/imageTools.ts` — second registration module, same idiom
- `src/http/app.ts` — `/mcp` route behind `loopbackOnly`; `handleMcpRequest(req, deps)`
- `src/config.ts` — `loadConfig` (dotenv parse of `.env.local`, merge with real env), `isPooledUrl` (:110), `pickDatabaseUrl` (:118), `ConfigError`, `expandHome`
- `src/db/client.ts` — `createDb` (Neon websocket pool vs node-postgres), `isNeonUrl`
- `src/daemon.ts` — `startDaemon` wiring; `ToolDeps` built in `src/http/app.ts`/`api.ts` from `AppDeps`
- `src/chat/status.ts` — `NOTES_MCP_SERVER='notes'`, `NOTES_TOOL_NAMES` (13), `allowedChatTools()`, `captionForToolUse(name, input)`
- `src/chat/agent.ts` — `optionsFor` passes `allowedTools: allowedChatTools()` and `tools: [...WEB_TOOL_NAMES]`, `mcpServers: {notes: {type:'http', url, alwaysLoad:true}}`, `permissionMode:'dontAsk'`; captions emitted per top-level `tool_use` (:236-243)
- `src/chat/prompt.ts` — `buildChatSystemPrompt(now, tz)`: 6 sections; section 1 says the agent reaches "the notes only through the notes tools"; section 6 asks for plain prose ("No markdown headings, no tables, no bold…") but says nothing about links
- `web/src/components/AnswerPanel.tsx` — answer body = `text.split('\n\n')` → `<p>{t}</p>`; no link handling
- `web/src/lib/text.ts` — `segmentBody` (tag chips) pattern: split by regex into typed segments; unit-tested in `web/src/lib/text.test.tsx`
- `web/src/styles.css:98-109` — `.answer*` styles; caption style = `font-family: var(--mono); font-size: 10.5px; color: var(--dim)` (`.answer-status`, `.answer-q`)
- `vitest.config.ts` — one config, modes by env: unit / `VITEST_INTEGRATION=1` (`tests/integration/**`, globalSetup migrates notes DB, no file parallelism) / `CHAT_LIVE_TEST=1` (`tests/live/**`)
- `scripts/test-int.sh` — starts/reuses `mcp-notes-pg-test` (`postgres:16`, 127.0.0.1:55433), exports `TEST_DATABASE_URL`, `VITEST_INTEGRATION=1`
- `tests/integration/setup.ts` — `testDatabaseUrl()` refuses Neon URLs; `migrateTestDb`
- `tests/unit/chat-status.test.ts` — asserts exactly 13 notes tools + 2 web tools (will change)
- `tests/unit/chat-agent.test.ts:278` — `expect(o.allowedTools).toEqual(allowedChatTools())`
- `README.md` — sections "MCP tools", configuration table (`:307+`), test commands (`:294`)

### Discovered Related Files (sibling repos — read only, never imported)

**~/expense-tracking** — Neon, driver `@neondatabase/serverless` neon-http; `.env.local` DB keys `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct).
- `lib/db/schema.ts`: Auth.js `user`/`account`/`session`/`verificationToken`; `expense_groups` (:82: `id text`, `user_id`, `title`, `occurred_on date` = Jakarta day, `note`, `raw_text`, `created_at`/`updated_at timestamptz`; idx `(user_id, occurred_on desc)`); `expense_items` (:111: `id`, `group_id` FK cascade, `name`, `amount_idr bigint` whole rupiah ≥0, `category text` (17 slugs, `lib/categories.ts:37-61`: meals, jajan, dining, snacks, drinks, transport, fuel, parking, bills, internet, utilities, housing, entertainment, cinema, health, grooming, other; Indonesian labels in `CATEGORY_META` :89), `sort_order`); `expense_photos` (:129: `blob_url`, `width`, `height`, …); `share_links`, `photo_share_links`; `expense_insights` (:220: one row per user, cached LLM `week_text`, `month_text`, `two_month_text`, `generated_at`, `model`).
- Totals are never stored: always `SUM(expense_items.amount_idr)`.
- Months: `'YYYY-MM'`, half-open `[m-01, next-01)` on `occurred_on` (`lib/format.ts:192`).
- Queries mirrored by curated tools (`lib/db/queries.ts`): `getMonthGroups` :294 (per-group total, item/photo counts), `getMonthlyTotals` :526 (sum by `to_char(occurred_on,'YYYY-MM')`, zero-filled), `getCategoryBreakdown` :581, `getBiggestExpense` :614 (largest item), `getMonthToDatePair` :658, `getGroupDetail` :367 (group + items by `sort_order,id` + photos).
- Migrations: `drizzle/0000_clear_edwin_jarvis.sql`, `0001_tricky_young_avengers.sql`, `0002_f14_category_taxonomy.sql` (data-only UPDATE); `drizzle/meta/_journal.json` lists all 3. Plain SQL, `--> statement-breakpoint` separators, no extensions.

**~/run-insights** — Neon, neon-http; DB keys `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED`.
- `lib/db/schema.ts` re-exports `lib/db/schema/{auth,runs,nina/*,admin,push}.ts`. Units rule (header :26-35): metres, seconds, sec/km, bpm; `runs.reviewed_at IS NOT NULL` gates every aggregate.
- `runs` (`schema/runs.ts:182`): `id`, `user_id`, `occurred_on date` (Jakarta day), `started_at`/`ended_at time` (local wall clock), `activity_type`, `location`, `duration_sec`, `distance_m`, `active_kcal`, `total_kcal`, `elevation_m`, `avg_cadence`, `avg_pace_sec`, `avg_hr`, `max_hr`, `resting_hr`, `intent` (easy/tempo/long/race/unspecified), `end_hr_bpm`, `hr_1min_post_bpm`, `note`, `source`, `reviewed_at`, `corrected_at`, timestamps.
- `run_splits` (:253, PK `(run_id, km)`: `time_sec`, `pace_sec`, `hr`, `cadence`, `partial`), `run_zones` (:276, PK `(run_id, zone)` 1..5: `duration_sec`, `min_bpm`, `max_bpm`), `run_photos` (:290), `extractions` (:140).
- `insights` (:389): `scope` session/week/month, `scope_key` = run id / `YYYY-Www` / `YYYY-MM`, `payload jsonb` = `{headline, verdict, whatHappened, observations[{title,detail,metric}], doNext[], questionForRunner}` (+ `hrMaxUsed`, `hrMaxSource` on session rows) (`lib/llm/schema.ts:33-63`); several rows per key, newest `created_at` wins.
- `profiles` (:42: `max_hr`, `resting_hr`, `weight_kg`…), `records` (:418), `badges` (:441).
- Nina: `nina_chat_sessions`, `nina_messages` (`role` runner/nina, `text`, `run_id`, `sent_at`), `nina_memory_*`, `nina_avatars`/`nina_message_images` (`vector(1536)` columns).
- Queries mirrored: `listRunsWithPhotoCounts` (`lib/db/queries/runs.ts:334`, reviewed only, `ORDER BY occurred_on DESC, started_at DESC`), `getRunDetail` (:268; run + splits by km + zones by zone + photos), `getLatestInsight` (`lib/db/queries/insights.ts:49`), `getRunsInIsoWeek`/`getRunsInMonth` (`rollups.ts:37/54`), ISO weeks Monday–Sunday (`lib/date/ranges.ts:83-115`).
- Migrations: `drizzle/0000_…` … `0037_wild_thunderbird.sql` (38 files, two numbered 0011, no 0014 SQL), `drizzle/meta/_journal.json` gives the order. pgvector required (see Key Consideration 2).

**~/seer** — Neon; web uses `@neondatabase/serverless`, engine uses psycopg. DB keys `DATABASE_URL` (pooled; contains an unquoted `&`, so `.env.local` must be parsed, never sourced — `web/scripts/with-env.mjs:13`), `DATABASE_URL_UNPOOLED`. Lab path override `SEER_LAB_DB` (`store.py:107`).
- Postgres schema = hand-written `db/migrations/001_init.sql` … `023_roster_always_invested.sql`, applied in name order by `web/scripts/migrate.mjs` (records `schema_migrations`). No extensions. Several files are data-only roster inserts.
- `strategies` (id text e.g. `RAW35-FR-GT`, `name`, `sub`, `is_champion`, `is_benchmark`, `params jsonb`, `engine` bracket/book/benchmark, `status` active/retired, `paper_start`, `paper_end`, `promoted_from` = lab method id), `equity_snapshots` (PK strategy_id,date: `cash_usd`, `equity_usd`), `orders` (bracket picks: `status` pending/open/closed/expired, prices `numeric(12,4)`, `pnl_usd`, `mark`), `book_positions` (open book holdings), `book_trades` (closed, `idle`), `book_fills`, `paper_state`, `bars`, `fx_rates` (`usd_idr`), `sean_*` (owner's real trades), `paper_contributions`.
- Money is USD (`numeric`, returned as strings by drivers); returns are fractions; `date` columns are NYSE session dates.
- Leaderboard: `leaderboard()` `web/lib/data.ts:526-543` (equity snapshots + closed P&L from orders∪book_trades) over `boardStrategies()` :122 (active + retired with `paper_end`); `strategyMetrics` `web/lib/metrics.ts:18` (total return, win rate, profit factor, max DD, trades, months); ranking `compare()` `web/app/(app)/leaderboard/view.ts:281`: common dates only, ≥63 shared sessions (:98), greedy drop of low-overlap strategies (:238), annualised Sharpe rf=0 × √252 (:177-202), order Sharpe desc (nulls last) → total return desc → smaller max DD → id (:214). Benchmarks and retired strategies are not ranked. Go-live `checklist()` `metrics.ts:63`.
- Open positions: `positions()` `data.ts:247-262` — bracket `orders.status='open'` with mark `COALESCE(o.mark, latest bars.close, fill_price)`; every `book_positions` row, P&L `value + income - cost`.
- lab.sqlite (schema `engine/src/seer_engine/lab/store.py:561-625` + side tables; `schema_version` 8; append-only triggers): `methods` (415: `id` M0001…/H-*, `name`, `family`, `hypothesis`, `status` idea/rejected/dev-eligible/test-failed/blocked-data, `analysis`, `verdict`), `trials` (1367: `n`, `method_id`, `candidate_id`, `window` dev/test, `start`, `end`, `run_at`, `total_return`, `cagr`, `max_drawdown`, `profit_factor`, `trades`, `sharpe`, `mar`, `dsr`, `n_trials_at_run`, `spy_tr_return`, `spy_tr_cagr`, `eligible`, `failed`, `curve_json`), `insights` (779 journal entries), `trial_funding` (`mwr`, `spy_tr_mwr`), `trial_moments`, `trial_provenance`, `method_folds`, `method_amendments`, `transitions`, `ideas_seen`, `meta`.

---

## Current Dataflow

### Entry Point: MCP tool call

**Location:** `src/http/app.ts` `/mcp` → `handleMcpRequest` (`src/mcp/server.ts:23`)
**Trigger:** HTTP POST from Claude Code (`/n`) or from the chat bar agent's Agent SDK child (`mcpServers.notes`, `src/chat/agent.ts`)
**Validation:** `loopbackOnly` (Host + Origin loopback); zod `inputSchema` per tool
**Next Step:** `createMcpServer(deps)` → `registerNoteTools`, `registerImageTools` → tool handler → `run(fn)` → `jsonResult` / `errorResult`

### Processing Chain (note tools today)
1. `server.registerTool(...)` handler — `src/mcp/tools.ts:138+`; input zod-validated; calls `NotesService`.
2. `run(fn)` — `tools.ts:130`: any throw → `errorResult` (`isError: true`, text `code: message`).
3. Output: one text content block, pretty JSON.

### Chat bar path
1. `POST /api/chat` (`src/http/api.ts`) → `ChatBackend.reply` → `createAgentChatBackend` (`src/chat/agent.ts:262`).
2. `optionsFor` builds SDK options: `allowedTools = allowedChatTools()` (notes 13 + web 2), `permissionMode: 'dontAsk'` — any tool not in the list is denied without prompting.
3. Each top-level `tool_use` → `captionForToolUse(name, input)` (`src/chat/status.ts:52`) → `event: status`; unknown names → null (no caption).
4. Text deltas → `event: delta` → `useChat` → `AnswerPanel` renders `text.split('\n\n')` as `<p>` plain text.

### Data Persistence
None for this iteration's data. The connectors only read foreign DBs; nothing is cached (out of scope).

### Exit Points
MCP tool result JSON; SSE events to the panel.

---

## Key Data Structures

### `ToolDeps` — `src/mcp/tools.ts:9`
`{ service: NotesService; dataDir: string; db: Db }`. Built from `AppDeps` (`src/deps.ts`) per request.

### `Config` — `src/config.ts:59`
`{ databaseUrl, port, host, dataDir, chat }`. No connector keys yet.

### Chat tool names — `src/chat/status.ts:8-34`
`NOTES_MCP_SERVER`, `NOTES_TOOL_NAMES`, `WEB_TOOL_NAMES`, `allowedChatTools()`.

---

## Dependencies

### Configuration / Environment
- mcp-notes `.env.local` (not touched by connectors).
- Sibling `.env.local` files: DB keys `DATABASE_URL`, `DATABASE_URL_UNPOOLED` in all three (names verified; values never printed).
- Existing deps usable: `pg` 8.23.1, `dotenv` 17.4.2 (`parse`), `zod` 4, `@modelcontextprotocol/sdk` 1.32.2; Node 22.23.1 `node:sqlite`, `node:worker_threads`.

### External Services
- Three Neon Postgres endpoints (direct hosts reachable over TCP 5432 from this machine — verified).
- Docker for integration tests (`postgres:16` container today; pgvector image needed for run-insights).

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `createMcpServer` | `src/mcp/server.ts:10` | def (registration point) | mcp |
| `ToolDeps` | `src/mcp/tools.ts:9` | def | mcp |
| `jsonResult` / `errorResult` / `run` | `src/mcp/tools.ts:120-137` | def | mcp |
| `buildInstructions` | `src/mcp/instructions.ts:10` | def | mcp |
| `buildInstructions` test | `tests/unit/mcp.instructions.test.ts:7` | test | tests |
| `isPooledUrl` / `pickDatabaseUrl` | `src/config.ts:110/118` | def (pattern to mirror) | config |
| `NOTES_TOOL_NAMES` / `allowedChatTools` / `captionForToolUse` | `src/chat/status.ts:8/32/52` | def | chat |
| `allowedTools: allowedChatTools()` | `src/chat/agent.ts:285` | call | chat |
| allow-list test | `tests/unit/chat-status.test.ts:6-17` | test | tests |
| captions test | `tests/unit/chat-status.test.ts:19-45` | test | tests |
| agent options test | `tests/unit/chat-agent.test.ts:278` | test | tests |
| `buildChatSystemPrompt` | `src/chat/prompt.ts:12` | def | chat |
| chat prompt test | `tests/unit/chat-prompt.test.ts` | test | tests |
| plan invariant 4 (13+2 tools) | `docs/plans/CHAT_BAR_BRAIN_PLAN.md` | doc | docs |
| `AnswerPanel` body | `web/src/components/AnswerPanel.tsx:37-41` | def | web |
| `segmentBody` (pattern) | `web/src/lib/text.ts:20` | def | web |
| `.answer-body`, `.answer-status` | `web/src/styles.css:102-109` | style | web |
| `/n` skill | `claude/skills/n/SKILL.md` | doc | claude |
| vitest modes | `vitest.config.ts:18-25` | config | root |
| `test-int.sh` container | `scripts/test-int.sh:12-16` | config | scripts |
| `package.json` scripts | `package.json` `test:int`, `test:live` | config | root |
| README tools/config/tests | `README.md:294,307,345+` | doc | root |

---

## Impact Points (files that WILL need changes)

1. `src/connectors/**` (new) — core: env loading, URL choice, pg read-only runner, SQL guard, row cap, SQLite lab runner, fail-soft errors, connector shape, generic `_schema`/`_sql` registration, per-system modules — phase 1; per-system curated tools — phases 2 (expenses), 3 (runs), 4 (seer)
2. `src/mcp/server.ts` — register connector tools — phase 1
3. `src/mcp/instructions.ts` + `tests/unit/mcp.instructions.test.ts` — connectors paragraph — phase 1
4. `src/config.ts` (or a connector-local config) — repo-root overrides, timeouts, caps — phase 1
5. `scripts/test-int.sh`, `vitest.config.ts`, `package.json`, `tests/integration/connectors/**`, `tests/live/connectors.live.test.ts` — Docker pgvector container, sibling-migration seeding, live check — phase 1; per-system curated-tool int tests — phases 2–4
6. `tests/unit/connectors/**` — guard, row cap, env, fail-soft — phase 1
7. `src/chat/status.ts`, `src/chat/prompt.ts`, `tests/unit/chat-status.test.ts`, `tests/unit/chat-prompt.test.ts` — allow list, captions, prompt mention — phase 5
8. `claude/skills/n/SKILL.md` — routing + opinion — phase 5
9. `web/src/components/AnswerPanel.tsx`, `web/src/lib/` (link segmentation), `web/src/styles.css`, web tests — phase 6
10. `README.md`, `docs/INSTALL.md` (configuration + tests) — phase 1 (core/config/tests), phase 5 (chat + `/n`)

**This document describes. The plan files prescribe.**
