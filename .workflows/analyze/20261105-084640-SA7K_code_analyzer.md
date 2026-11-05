# Code Analysis: Seer Adversarial (cross-repo: ~/seer + ~/mcp-notes)

**Type:** Feature Implementation
**Date:** 2026-11-05 08:46 WIB
**Session ID:** 20261105-084640-SA7K (session graph node AK-XY, parent H7-OA)
**Plan:** `.workflows/plan/SEER_ADVERSARIAL_PLAN.md` (7 phases)
**Worktrees:**
- mcp-notes: `/home/miftah/.worktrees/mcp-notes/seer-adversarial`, branch `feature/seer-adversarial`, base `origin/main` @ `5331550` (the commit that landed the design brief)
- seer: `/home/miftah/.worktrees/seer/seer-adversarial`, branch `feature/seer-adversarial`, base `origin/main` @ `a6322d7`

---

## User Input

### Original User Request

```
seer-adversarial feature

Build "Seer Adversarial", a cross-repo feature spanning ~/mcp-notes and ~/seer. The full design brief, the owner decisions (binding) and the verified facts are in /home/miftah/mcp-notes/docs/plans/2026-11-05-seer-adversarial-design.md. Read it first, in full, and treat section 2 as decided: do not re-ask the owner. The agreed UI mock is https://claude.ai/artifact/TLXjXa9jgqGTzMJ5q7osDE (read it with the Artifact tool, action read, for the page layout). Read ~/seer/CLAUDE.md and ~/mcp-notes/CLAUDE.md for each repo rules (Seer: migrations with prose headers, verify-seer, Next.js 16 docs, commit explicit paths; mcp-notes: verify-notesd, one notes service). Plan phases for both repos; the Seer engine changes (twin roster rows, verdict and mark tables, A-GT re-admission, candidate list for bracket strategies, decide-late twins or a fallback cron) and the mcp-notes reviewer, API/MCP and wall page (/adversary, sword button between Chat history and Trash, Alt+Z focus like Projects, ON/OFF toggle). Confirm or reject the decide-late twin recommendation (section 4.1) against the real paper runner and paper_check before planning on it. Parent session: H7-OA.
```

### User-Provided Context
- Design brief (binding owner decisions in §2, verified facts in §3, design in §4, honesty rules in §5):
  `docs/plans/2026-11-05-seer-adversarial-design.md` (in both the checkout and the worktree).
- UI mock: four boards (Overview, Method RAW35, Daily A/C/Claude, Focus with auto-runs off).
  Saved byte-for-byte from artifact version 1793842978-8f4b into
  `docs/plans/seer-adversarial-mock/{Main,Method,Daily,Focus}.dc.html` in the mcp-notes worktree
  (Main = overview, Method = monthly method page, Daily = A vs C vs Claude, Focus = Alt+Z with auto-runs off).
  Numbers marked "sample data" there are illustrative.

### User-Provided Files
- `docs/plans/2026-11-05-seer-adversarial-design.md`
- `~/seer/CLAUDE.md`, `~/mcp-notes/CLAUDE.md`

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Seer engine: twin roster rows, verdict and mark tables, A-GT re-admission, candidate list for bracket strategies, twins that decide late (or a fallback cron) |
| R2 | Confirm or reject the decide-late twin recommendation (§4.1) against the real paper runner and paper_check before planning on it |
| R3 | Seer web: twins on the Leaderboard labelled Paper, never on Today, checklist rule 5 reads "can't be run" for a twin (brief §4.1 "Seer web", owner decision 8) |
| R4 | mcp-notes reviewer: discovery, lease, briefs, data tools, agent, writer, ON/OFF toggle, budget, marks |
| R5 | mcp-notes API/SSE/MCP tools + scorecard + go-live parity |
| R6 | Wall page `/adversary`: sword button between Chat history and Trash (Rail + Sidebar), Alt+Z focus like Projects, ON/OFF toggle, layout per the mock |
| R7 | Make it live: config/README, install, rebuild/restart notesd, first live review (brief §6 phase 6) |

---

## Detailed Requirements Understanding

**Problem statement.** Every active Seer roster method that is not itself an LLM critic (i.e. not C)
gets a "Claude twin": a separate paper strategy row, simulated by Seer's one simulator, that runs the
original's method but drops the symbols Claude objected to before that decision's session opened. Claude's
verdicts are produced by a background reviewer inside notesd (mcp-notes), written into a narrow set of Seer
tables, and shown on a new wall page. Plain A comes back as `A-GT` so A / C / A+Claude compare three ways.

**Success criteria.**
- Seer: migration 027 lands the schema; every active eligible original has exactly one active twin, created
  and retired automatically; `A-GT` + its twin paper-trade with Gotrade fees; `strategy_candidates` holds
  each bracket original's ranked top 10 nightly; `paper` and `paper_check` pass for twins; Leaderboard shows
  twins as Paper beside originals; Today never shows a twin.
- mcp-notes: the reviewer finds due decisions from Seer's DB, leases each (strategy, session) across two
  hosts, reviews every candidate/target with cited sources, writes verdicts before the session opens, writes
  `paused` marks while the toggle is off, respects caps; `/api/adversary/*`, SSE, MCP tools and the
  `/adversary` page match the mock; verify-notesd and verify-seer prove both sides.

**Key considerations / assumptions** (each decided in the plan index `## Decisions`):
- Honesty rules §5 are invariants: forward only, information cutoff = the session's open, missing/late =
  copy the original, every prompt/model change a dated revision, numbers from the DB.
- Two machines, two daemons, one Seer DB, clocks may differ: lease expiry uses the DB's `now()`.
- The Seer integration tests in mcp-notes rebuild Seer's schema from the sibling repo's migrations at
  `SEER_DIR` (default `~/seer`); until the Seer branch lands, mcp-notes phases must point `SEER_DIR` at the
  Seer worktree for those tests.

---

## R2 verdict: decide-late twins — CONFIRMED, in the one-session-lag form

Read against `~/seer` @ a6322d7:

**How the paper night works today** (`engine/src/seer_engine/commands/paper.py`):
- `run_dates(now)` → `data_date` = last completed session, `session_date = next_session(data_date)`
  (`dates.py:128-132`).
- `plan_night` (`paper.py:247-315`) puts each active, started entry on the step list unless
  `state.last_session >= rd.data_date`, and raises unless `state.pending_session == next_session(state.last_session)`
  (`paper.py:302-309`). `store.write_pending` enforces the same (`paper/store.py:468-486`).
- `_trade` (`paper.py:424-468`): for each step entry, `sessions = sessions(next(last_session), rd.data_date)`;
  deposits accrued once (`accrue_contributions`), then `_step_bracket` / `_step_book` / `_step_benchmark`.
- `_step_bracket` (`paper.py:802-836`): per session s: `view = tonight.view(s)` (= `night_view`, bars/FX after
  s invisible, later splits undone, `paper.py:336-351`), credit deposits, `settle_bracket(s)`, persist,
  `decide_bracket(... s ...)` for `next(s)`, `insert_pending_orders`, `write_pending(next(s))`.
- `_step_book` (`paper.py:839-919`): same shape; `decide_book(view, ...)` for `nxt`, `save_book_decision`,
  preview on the last session only (`save_book_preview`).
- The whole night is ONE transaction (`paper.py:228-231`, `db.transaction`, `db.py:28-44`).
- Catch-up is already exact: `test_catch_up_of_two_sessions_equals_night_by_night`
  (`engine/tests/test_paper_command.py:395-406`).

**paper_check** (`commands/paper_check.py` + pure `paper/replay.py`): one REPEATABLE READ READ ONLY txn,
re-runs `run_rules` over `[paper_start, last_session]` on the current market, plus the decision for
`pending_session` (`replay.py:292-356` `expected_bracket`, `:359-451` `expected_book`). Compares snapshots,
orders keyed `(session_date, symbol)` on `ORDER_FIELDS` (`replay.py:88-103`, no `created_at`), book
positions/fills/trades/targets and `paper_state` cash/equity/pending_session/pending_decision
(`replay.py:620-665`). C's verdicts reach the replay through the same `_bracket_strategy`
(`paper_check.py:38,260`) for `paper_start..next_session(last_session)`.

**Why the brief's literal variant ("decide S, then settle S, in the same night") is rejected:** the state
machine forbids a "settled but undecided" entry (`plan_night` raises, `write_pending` raises), and the replay
always expects the pending decision for `next(last_session)` (`replay.py:345-352`, `:411-445`). Doing it
would change `plan_night`, `write_pending`, the step loops and both `expected_*` functions.

**Why the one-session lag is confirmed:** a twin is stepped exactly like any entry but **as if tonight's data
date were `prev_session(rd.data_date)`**. On the night after session S closes (13:17 WIB), the twin settles
S-1 and decides S on `view(S-1)` with every verdict whose `decided_at < open(S)` — by then S has opened, so
that verdict set is frozen. Consequences:
- No change to the step loops, `plan_night`'s invariant, `write_pending`, or `replay.py`: the twin's record
  is an ordinary record that ends one session earlier.
- Fills come from stored bars, decisions read only through `view(s)` (`decide_bracket` cuts history at
  `data_date`, `bracket.py:199-206`; `decide_book` "nothing dated after data_date", `book.py:238`), so the
  result equals deciding on time. Inputs that could differ when read a night late (`unavailable_symbols`,
  split-undo rounding, rewritten bars) already differ for every catch-up night and for the replay; the
  original handles the unavailable list with `repick` (`paper.py:501-604`), the twin simply sees it earlier.
- paper_check stays stable for twins only because the verdict filter is a pure function of the DB with a
  cutoff in the past: replaying on any later night gives the same set. (A twin deciding on time would read a
  verdict table that keeps changing until the open; C avoids this with `veto` refusing to write after
  `paper_status='success'`, `veto.py:297-302`.)
- No second cron, no race with the 09:41/12:41 UTC retries, and Claude's window runs to the US open
  (21:30 WIB winter, 20:30 WIB summer).
- Cost: a twin's equity, positions and pending orders run one session behind its original. Every comparison
  (Seer leaderboard rank over common sessions already handles it: `compare()` uses shared sessions;
  mcp-notes scorecard) aligns on the twin's last session.

**Fallback cron: not needed.**

---

## Analysis Scope

### Explicitly Mentioned Files
- `docs/plans/2026-11-05-seer-adversarial-design.md`, both CLAUDE.md files, the mock.

### Discovered Related Files — Seer (`~/seer`, paths relative to repo root)

| File | Role |
|---|---|
| `db/migrations/001_init.sql:3-12`, `003_paper.sql:6-8`, `006_roster.sql:14-30` | `strategies` columns: id, name, sub, icon, is_champion, is_benchmark, params jsonb, sort, engine, rules_id, paper_start, status, paper_end, promoted_from, object_name, registry_id, gate_note, gate_applicable |
| `db/migrations/004_news_veto.sql:10-24` | `news_vetoes` (strategy_id, session_date, rank, symbol, verdict allow/veto/failed, reason, model, prompt_version, headlines, earnings_date, decided_at), PK (strategy_id, session_date, symbol) — the template for `adversary_verdicts` |
| `db/migrations/008_*` | `book_previews` (display-only "would pick now") |
| `db/migrations/009_*` | `strategies.evidence`/`orders.evidence` |
| `db/migrations/013_roster_first_night.sql:50-51` | retired `A` (not 017) |
| `db/migrations/017_*.sql:66-81` | admitted `C-GT` (`bracket`, `design-v0-gotrade`, `STRATEGY_C`, gate_applicable false); retired C etc. |
| `db/migrations/021_*:97-110`, `022_*:51-63` | admitted RAW35-FR-GT, COSK-FR-GT by migration |
| `db/migrations/026_roster_retire_mom70.sql` | latest (v26); prose header style |
| `engine/src/seer_engine/paper/roster.py` | `RESOLVER` (:558-600), `LAB_PROVENANCE` (:623), `from_row` (:997-1093), `from_rows` (:1096-1106), `SEED_ROWS`, `ROSTER` (:1718), `active()` (:1725), `news_veto()` exactly-one-NewsVeto (:1738-1761), spec/digest (:1793-1878), `PRE_FUNDING_IDS` (:503-519), `BENCHMARK_COST_MODEL` (:531-550) |
| `engine/src/seer_engine/paper/store.py` | `read_roster_rows` (:237-248), `freeze_spec` (:257-287), `check_digest` (:290-302), `retire` (:305-336), `init_paper_state` (:405-442), `write_pending` (:468-486), contributions (:627-725), bracket load/save (:878-947), book targets (:1254-1304), unavailable (:1520), `allowed_between` (:1662-1674) |
| `engine/src/seer_engine/commands/paper.py` | the night (see R2 above); `_bracket_strategy` (:621-631), `_evidence` (:637), `_start` (:721-799) |
| `engine/src/seer_engine/commands/paper_check.py` + `paper/replay.py` | replay check |
| `engine/src/seer_engine/commands/promote.py` | `_check_target` (:390-419), `_insert` (:422-461), `--retire` in same txn (:556-561) |
| `engine/src/seer_engine/commands/veto.py` | C's verdict writer; refuses after paper success (:297-302, :346-348, :401-404); `decided_at` = run start |
| `engine/src/seer_engine/strategies/a.py` | A: close>SMA200, RSI(2)<10, $20M ADV; ranked by RSI asc then symbol, all qualifiers (:105-190) |
| `engine/src/seer_engine/strategies/c.py` | `NewsVeto` (:218-264) wraps candidates with `allowed[next_session(data_date)]`; `max_candidates=10` (:124); `allowed_map` (:418-438) |
| `engine/src/seer_engine/strategies/evidence.py` | `EVIDENCE` keys (:861-876), `_a_facts` (:197-231) |
| `engine/src/seer_engine/paper/bracket.py`, `paper/book.py` | pure settle/decide; `needs_kickoff` (book.py:290), resize-only sessions (book.py:245) |
| `engine/src/seer_engine/sim/costs.py`, `sim/contributions.py:129`, `paper/capital.py:11` | Gotrade fees, OWNER_MONTHLY 5,000,000 IDR on the 25th, PAPER_INITIAL_IDR 10,000,000 |
| `engine/src/seer_engine/dates.py` | `RunDates` (:28), `prev_session` (:96), `run_dates` (:128). **No session-open-time helper exists.** |
| `engine/tests/conftest.py:45-116` | `PG_TEST_URL`, per-test schema, autouse `_isolated_env` (:53-59) |
| `engine/tests/test_paper_roster.py:122,636` | `PINS` digests; `SEED_ROWS` == migration rows |
| `engine/tests/test_sean_mirrors.py`, `test_backtest_metrics.py:113-150` | TS/Python mirror tests |
| `.github/workflows/nightly.yml` | crons `17 6 * * 2-6`, `41 9 * * 2-6`, `41 12 * * 2-6`; steps Migrate → Nightly → Veto → Paper → Paper check → Explain → Sean marks; concurrency `seer-db-writer` |
| `.claude/skills/verify-seer/` | `scripts/verify.sh` (up/doctor/api/ui/shoot/engine/lab/sql/down…; denies `promote`, `backtest*`), `features/README.md` + `engine-night.md`, `leaderboard.md`, `today.md`… |
| `web/lib/data.ts` | `strategies()` (:89-107), `boardStrategies()` (:122-131), `toStrategy` (:66-87; `isPaper: !isBenchmark && !isChampion` :83), `champion()` (:136-137) |
| `web/app/(app)/leaderboard/page.tsx`, `view.ts` | cards and chips (:250-265), `looks()` colours by roster position (view.ts:68-87), `compare()` (:281), `MIN_COMMON_SESSIONS=63`, `scoreOf` (:415-426) |
| `web/app/(app)/page.tsx:22-38,117` | Today shows only the champion |
| `web/lib/metrics.ts:48-106` | `checklist()` five rules; `gateItem` "Backtest gate" / "Not applicable"; `CHECKLIST_RULES = 5` |
| `web/lib/strategy.ts:10,32-51` | `parseGate`, `checksNews` (STRATEGY_C or id C), `shortLabel` (name before " · ") |
| `web/components/PaperChip.tsx` | used on Positions/History only |
| `web/lib/golive.ts:26-46` | MAX_DRAWDOWN 0.25, MIN_PAPER_MONTHS 18 (mirrored in `backtest/metrics.py:40,55`) |
| `web/AGENTS.md` | "This is NOT the Next.js you know": read `node_modules/next/dist/docs/` first |

### Discovered Related Files — mcp-notes (paths relative to repo root)

| File | Role |
|---|---|
| `src/chat/agent.ts` | Agent SDK `query()` usage, `QueryFn` seam (:21), `optionsFor` (:322-344), abort relay (:235-237), fallback (:47-55, :203-219) |
| `src/chat/env.ts` | `claudeEnv`, `glmEnv`, `resolveExecutable` |
| `src/sessions/summarize.ts:12,218,251-327` | closest background-agent template (`SUMMARY_MODEL='haiku'`, `findClaudeBin`, timeout/abort) |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:633,1091,2021,6097,10110` | `createSdkMcpServer`, `outputFormat {type:'json_schema'}`, `structured_output`, `tool()` — unused in repo so far. SDK 0.3.311, zod 4.4.3 |
| `src/background.ts:20-134` | `startBackground(deps, options)`; per-job gate; handles with `close()` |
| `src/deps.ts:10-21` | `AppDeps` |
| `src/daemon.ts:25,34,75-139` | build deps, `startBackground(deps, {sessionSummarizer})` |
| `src/config.ts:48-301` | `Config` sub-objects, `DEFAULT_*_CONFIG`, `parseSwitch`, `parsePositiveInt`, `loadConfig` |
| `src/connectors/env.ts:13-130` | `SEER_DIR`, `loadDatabaseTarget` (reads `<dir>/.env.local` each call, prefers direct host), `prepareUrl`, `secretsOf` |
| `src/connectors/pg.ts:47-91` | read-only `pg.Client` per query (`BEGIN READ ONLY`) — no writable client exists |
| `src/connectors/guard.ts`, `sql.ts` | read-only SQL guard; must stay read-only |
| `src/connectors/seer/{index,curated,leaderboard,ranking,positions,sera,rows}.ts` | Seer read connector; `ranking.ts` is a time-weighted port of Seer's view.ts/metrics.ts/compare.py (`MIN_COMMON_SESSIONS=63`, `sinceStartMetrics` :245). **No money-weighted return exists in mcp-notes** except Sera's `trial_funding.mwr` |
| `src/connectors/register.ts:29`, `names.ts:10-14` | connector tool registration and names |
| `src/http/app.ts:89-115` | route mounting order; `staticRoutes` last |
| `src/http/api.ts:31,271-302` | `/api/events` SSE (`note`, `chat`), 25 s heartbeat |
| `src/notes/events.ts`, `src/chat/events.ts` | event bus pattern to copy |
| `src/http/sameOrigin.ts:29` | `sameOriginOnly` |
| `src/mcp/server.ts:13-42`, `src/mcp/tools.ts:14-33,161`, `src/mcp/sessionTools.ts:48-70`, `src/mcp/instructions.ts:29` | MCP registration, `run()`, instructions |
| `src/chat/status.ts` | chat tool allow-list and captions |
| `src/db/schema.ts:21-40,707-711` | schema header list; `app_settings` (key/value jsonb, shared across machines) |
| `src/sessions/repo.ts:867-885`, `src/sessions/types.ts:54` | `getSetting`/`putSetting`; `projects.selected` precedent |
| `drizzle/0010_session_prompts_summary_requests.sql` | latest notes migration (next: 0011) |
| `web/src/types.ts:86` | `View = 'wall'|'bin'|'history'|'projects'` |
| `web/src/lib/route.ts:12-13,62,82` | path constants, route parsing, `hrefForView` |
| `web/src/App.tsx:79-82,99,298-310,382-405,771,810-871,888` | view from URL, focus hides chrome, toggles, URL sync, headings, page switch, ChatBar hidden on pages |
| `web/src/components/Rail.tsx:1,9,62-83`, `Sidebar.tsx:1-5,70-91` | Chat history (`ChatsCircle`) then Trash buttons; `BIN_TIP: Record<View,string>` |
| `web/src/pages/ProjectsPage.tsx:83-106,172-184,192` | Esc / Alt+Z focus effects; focus button; `ProjectChat` pill |
| `web/src/components/Header.tsx`, `lib/filter.ts:88`, `lib/timeline.ts:3`, `lib/projects.ts:6` | headings ending in "." |
| `web/src/components/projectChat/ProjectPillQueryInput.tsx:7,41-52`, `ChatBar.tsx:47-53` | "Ask about …" pill |
| `web/src/api.ts`, `sessionsApi.ts` | API client pattern |
| `web/src/lib/events.ts:23` | shared EventSource `subscribeEvents` |
| `web/src/styles.css:46-48` | `.ibtn`, `.on`, `.hov` |
| `tests/integration/connectors/{globalSetup,siblings,harness}.ts` | rebuilds `connectors_seer` from `SEER_DIR/db/migrations`; `describeWithRepo('seer')` |
| `scripts/test-int.sh` | pgvector containers 55433/55435 |
| `.claude/skills/verify-notesd/` | `verify.sh`, `features/README.md` table + per-feature files |
| `scripts/install.sh:148,181,356-373`, `deploy/notesd.service` | install steps; env keys come from `.env.local` |
| `README.md:762-790,914-937,957-988,1021-1068` | connectors, configuration table, MCP tools, HTTP API |

---

## Current Dataflow

### Seer nightly, session S (bracket original, e.g. C-GT)
1. 06:17 UTC on the night after session D closes: `nightly` writes bars through `data_date = D`;
   `session_date = next(D)` is the session being decided.
2. `veto` (C only): ranks A's candidates on history cut at D, top 10, GLM verdicts into `news_vetoes` for
   `session_date`, `decided_at` = run start; refuses after paper success.
3. `paper` (one txn): settle D for every entry, decide `next(D)` → `orders` (pending) / `book_targets`,
   `paper_state.pending_session`, `book_previews` for books, evidence.
4. `paper_check`: replay per entry, read-only.
5. US open of `next(D)`: 14:30 UTC winter / 13:30 UTC summer. Fills settle on the next night.

### mcp-notes today
- Seer is read only, through `src/connectors/seer/*` with per-query read-only `pg.Client` on the direct host
  from `SEER_DIR/.env.local`.
- Background jobs: embeddings, image ingest, session ingest/summaries in `startBackground`.
- Settings shared across machines: `app_settings` (via `SessionsRepo`).

### Data Persistence (new, planned)
- Seer DB: `strategies.twin_of`, `adversary_verdicts`, `adversary_marks`, `adversary_leases`,
  `strategy_candidates`, `book_previews.next_decision_session`.
- mcp-notes DB: `adversary_reviews` (usage/attempt log + draft verdicts from previews); `app_settings` key
  `adversary.auto`.

---

## Key Data Structures

- `RosterEntry` (`paper/roster.py`): id, engine, obj, params, rules, status… built by `from_row`.
- `Strategy` protocol (`strategies/base.py`): `candidates/picks(history, members, data_date, params)`;
  `NewsVeto` shows the wrapper pattern (`with_allowed`).
- `PaperState` (`paper/store.py`): last_session, pending_session, pending_decision, kickoff_session.
- `RunDates` (`dates.py:28`): data_date, session_date.
- mcp-notes `AppDeps`, `Config`, `NoteEvents`.

---

## Dependencies

- Seer: Python 3.11, psycopg, Neon Postgres; GitHub Actions nightly; `FINNHUB_API_KEY`, `MASSIVE_API_KEY`,
  `EODHD_API_TOKEN` (may have lapsed), `SEC_CONTACT_EMAIL` in `~/seer/.env.local`.
- mcp-notes: Node ≥ 22.22, Claude Agent SDK 0.3.311 (subscription login via `claude` binary), zod 4,
  hono 4, drizzle 0.45, pg 8.

---

## Reference List (sites a new roster row / twin touches)

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `SEED_ROWS` == migration rows | seer `engine/tests/test_paper_roster.py:636` | test | engine |
| `PINS` digests | seer `engine/tests/test_paper_roster.py:122` | test | engine |
| `EVIDENCE` key per object | seer `strategies/evidence.py:861-876` | def | engine |
| `LAB_PROVENANCE` | seer `paper/roster.py:623` (web `lib/sera/paper.ts`, `data/lab.json`) | config | engine/web |
| `roster.news_veto` exactly one NewsVeto | seer `paper/roster.py:1738-1761` | def | engine |
| `strategies` SELECTs | seer `web/lib/data.ts:93-97,125-129` | call | web |
| `champion()` | seer `web/lib/data.ts:136-137` | def | web |
| `checksNews` | seer `web/lib/strategy.ts:49-51` | def | web |
| `looks()` colour by position | seer `web/app/(app)/leaderboard/view.ts:68-87` | def | web |
| `gateItem` / tests pinning "Not applicable" | seer `web/lib/metrics.ts:48-52`, `metrics.test.ts:73-88`, `strategy.test.ts:46` | def/test | web |
| `scripts/seed-demo.mjs:67-85` | seer web demo rows | config | web |
| `View` union / `BIN_TIP` | mcp-notes `web/src/types.ts:86`, `Rail.tsx:9` | def | web |
| `SEER_ABOUT` table list | mcp-notes `src/connectors/seer/index.ts` | doc | connectors |
| `CONNECTOR_TOOL_NAMES` / chat allow-list | mcp-notes `src/connectors/names.ts:10-14`, `src/chat/status.ts` | config | chat |

---

## Impact Points (files that WILL need changes)

Seer:
1. `db/migrations/027_adversary.sql` (new) — schema + `A-GT` + initial twin rows — phase 1 (schema, A-GT), phase 2 (twins via code; no twin INSERT in migration, see Decisions)
2. `engine/src/seer_engine/paper/roster.py`, `strategies/evidence.py`, `engine/tests/test_paper_roster.py` — A-GT (phase 1), twin wrapper/resolution/invariants (phase 2)
3. `engine/src/seer_engine/commands/paper.py`, `paper/store.py` — candidate writer + next_decision_session (phase 1); twin lag stepping, `ensure_twins`, verdict loading (phase 2)
4. `engine/src/seer_engine/dates.py` — `session_open_utc` (phase 1)
5. `engine/src/seer_engine/commands/paper_check.py` — twin replay (phase 2)
6. `engine/src/seer_engine/commands/promote.py` — ensure twins in the promotion txn (phase 2)
7. `web/lib/data.ts`, `web/lib/metrics.ts`, `web/lib/strategy.ts`, `web/app/(app)/leaderboard/*`, `web/scripts/seed-demo.mjs` — phase 3
8. `.claude/skills/verify-seer/features/{engine-night,leaderboard,today}.md`, `README.md`, `docs/runbooks/paper-trading.md` — phases 1–3

mcp-notes:
9. `src/adversary/*` (new), `src/background.ts`, `src/daemon.ts`, `src/deps.ts`, `src/config.ts`, `src/db/schema.ts`, `drizzle/0011_*` — phase 4
10. `claude/adversary/briefs/*.md` (new) — phase 4
11. `src/http/adversaryApi.ts` (new), `src/http/app.ts`, `src/mcp/adversaryTools.ts` (new), `src/mcp/server.ts`, `src/mcp/instructions.ts`, `src/chat/status.ts`, `README.md` — phase 5
12. `web/src/**` (types, route, App, Rail, Sidebar, pages/AdversaryPage, components/adversary/*, adversaryApi.ts, hooks), `.claude/skills/verify-notesd/features/adversary.md` — phase 6
13. `README.md` config table, `.env.local` keys, install/restart, first live review — phase 7

**This document describes. The plan files prescribe.**
