# Plan: Seer Adversarial

**Slug:** seer-adversarial
**Date:** 2026-11-05 08:46 WIB
**Analysis:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial` (plans, mcp-notes code) and `/home/miftah/.worktrees/seer/seer-adversarial` (Seer code)
**Branch:** `feature/seer-adversarial` in BOTH repos (mcp-notes base `origin/main` @ `5331550`; seer base `origin/main` @ `a6322d7`)
**Phases:** 7
**Status:** planned
**Coordinator:** —

---

## Why

Verbatim from the user (Step 0):

> Build "Seer Adversarial", a cross-repo feature spanning ~/mcp-notes and ~/seer. The full design brief, the owner decisions (binding) and the verified facts are in /home/miftah/mcp-notes/docs/plans/2026-11-05-seer-adversarial-design.md. Read it first, in full, and treat section 2 as decided: do not re-ask the owner. The agreed UI mock is https://claude.ai/artifact/TLXjXa9jgqGTzMJ5q7osDE (read it with the Artifact tool, action read, for the page layout). Read ~/seer/CLAUDE.md and ~/mcp-notes/CLAUDE.md for each repo rules (Seer: migrations with prose headers, verify-seer, Next.js 16 docs, commit explicit paths; mcp-notes: verify-notesd, one notes service). Plan phases for both repos; the Seer engine changes (twin roster rows, verdict and mark tables, A-GT re-admission, candidate list for bracket strategies, decide-late twins or a fallback cron) and the mcp-notes reviewer, API/MCP and wall page (/adversary, sword button between Chat history and Trash, Alt+Z focus like Projects, ON/OFF toggle). Confirm or reject the decide-late twin recommendation (section 4.1) against the real paper runner and paper_check before planning on it. Parent session: H7-OA.

The design brief (`docs/plans/2026-11-05-seer-adversarial-design.md`, §1 "What and why", §2 owner decisions,
§5 honesty rules) is part of this specification; every phase reads it in full. The mock's four boards are
saved at `docs/plans/seer-adversarial-mock/{Main,Method,Daily,Focus}.dc.html` (mcp-notes worktree).

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Seer engine: twin roster rows, verdict and mark tables, A-GT re-admission, candidate list for bracket strategies, decide-late twins | 1, 2 |
| R2 | Confirm or reject decide-late twins against the real paper runner and paper_check | analysis (confirmed, lag form) → implemented in 2 |
| R3 | Seer web: twins on the Leaderboard as Paper next to originals, never on Today, rule 5 "can't be run" | 3 |
| R4 | mcp-notes reviewer: discovery, lease, briefs, data tools, agent, writer, toggle, budget, marks | 4 |
| R5 | mcp-notes `/api/adversary/*` + SSE + MCP tools + scorecard + go-live parity | 5 |
| R6 | Wall page `/adversary`, sword button between Chat history and Trash, Alt+Z focus, ON/OFF toggle | 6 |
| R7 | Make it live: config, README, land Seer, rebuild/restart notesd, first live review | 7 |

## Scope

**In scope:** everything in brief §4 and the R table.
**Out of scope:** a twin for C-GT (C is itself an LLM critic, brief §4.1); any twin backtest (honesty §5);
showing twins on Seer's Today; changing Seer's §1 real-money bar; changing the read-only connector guard;
a fallback cron (not needed, see Decisions D1).

## Invariants

1. Each phase leaves its repo building with its full test suite green (Seer: `ruff check engine`,
   `pytest engine/tests` with `PG_TEST_URL` set, `cd web && npx tsc --noEmit && npm test`; mcp-notes:
   `npm run typecheck && npm test && npm run test:int`).
2. Seer rules bind Seer phases: migrations carry a prose header (see `db/migrations/026_*.sql`); closed records
   frozen; tests never reach production (autouse `_isolated_env`); TS/Python mirrored constants kept equal;
   commit explicit paths only; `verify-seer` proof with its `features/` entry updated in the same commit;
   module docstrings explain *why*; plain language in owner-facing text.
3. mcp-notes rules bind mcp-notes phases: ESM `.js` import suffixes; one config (`vitest.config.ts`); live
   tests opt-in only; `verify-notesd` proof with its `features/` map updated; the connector guard
   (`src/connectors/guard.ts`, `pg.ts`) stays read-only — writes go through the separate writer only.
4. Honesty (brief §5): forward only; a verdict counts only if `decided_at < session_open_utc(session_date)`;
   missing/failed/late = the twin copies the original; past verdicts are never rewritten; page numbers come
   from the DB, never from model prose.
5. Never hard-code roster strategy ids in mcp-notes; read the roster from Seer's `strategies` table.
6. Tests never touch Neon, `~/.claude`, the live daemon on 7317, or `~/mcp-notes-data`.
7. Seer phases (1–3) work and commit ONLY in `/home/miftah/.worktrees/seer/seer-adversarial`
   (branch `feature/seer-adversarial` of `~/seer`). mcp-notes phases (4–7) work in
   `/home/miftah/.worktrees/mcp-notes/seer-adversarial`. Landing Seer on `main` is phase 7's job.
8. Until phase 7 lands Seer, mcp-notes integration tests that rebuild Seer's schema run with
   `SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial` so migration 027 is present.

## Cross-repo contracts (fixed here; phases plan against them)

### C1. Seer migration `db/migrations/027_adversary.sql` (phase 1 writes it)

```sql
ALTER TABLE strategies ADD COLUMN twin_of text NULL REFERENCES strategies(id);
-- at most one ACTIVE twin per original
CREATE UNIQUE INDEX strategies_one_active_twin ON strategies (twin_of) WHERE twin_of IS NOT NULL AND status = 'active';

-- Reviewable decisions, written by `paper` in the night transaction for every ACTIVE NON-TWIN,
-- NON-BENCHMARK original:
--   bracket entries: the ranked top 10 candidates (strategy's own ranking, before any C veto filter)
--                    for session_date = the session being decided (kind 'bracket', weight NULL);
--   book entries:    the targets of a RANK or KICKOFF decision (never a resize-only one) for
--                    session_date = that decision session (kind 'book', rank by weight desc then symbol,
--                    weight = target weight).
CREATE TABLE strategy_candidates (
  strategy_id  text NOT NULL REFERENCES strategies(id),
  session_date date NOT NULL,           -- the decision session
  data_date    date NOT NULL,           -- the night that decided it (prev_session(session_date))
  kind         text NOT NULL CHECK (kind IN ('bracket','book')),
  rank         integer NOT NULL CHECK (rank >= 1),
  symbol       text NOT NULL,
  weight       numeric NULL,
  evidence     jsonb NULL,              -- the facts the rule read (strategies.evidence), NULL if unavailable
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, session_date, symbol),
  UNIQUE (strategy_id, session_date, rank)
);

-- Lets the reviewer look early at a book's next rank decision without porting Seer's cadence logic.
ALTER TABLE book_previews ADD COLUMN next_decision_session date NULL;  -- the next RANK session, or NULL

CREATE TABLE adversary_verdicts (
  id              bigserial PRIMARY KEY,
  strategy_id     text NOT NULL REFERENCES strategies(id),   -- the ORIGINAL, never the twin
  session_date    date NOT NULL,                             -- the decision session (as strategy_candidates)
  symbol          text NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN ('agree','object','unsure')),
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  sources         jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{url,title,publisher,published_at,fetched_at}]
  lens            text NOT NULL,                             -- method brief id@version
  model           text NOT NULL,                             -- exact verdict model id
  prompt_version  text NOT NULL,                             -- hash of lens + system prompt + models
  host            text NOT NULL,
  started_at      timestamptz NOT NULL,
  decided_at      timestamptz NOT NULL,
  superseded_by   bigint NULL REFERENCES adversary_verdicts(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (verdict = 'unsure' OR jsonb_array_length(sources) >= 1),
  CHECK (decided_at >= started_at)
);
CREATE INDEX adversary_verdicts_key ON adversary_verdicts (strategy_id, session_date, symbol, decided_at);
-- append-only: a trigger refuses DELETE, and refuses UPDATE of anything but superseded_by NULL -> id.

CREATE TABLE adversary_marks (
  strategy_id  text NOT NULL REFERENCES strategies(id),   -- the ORIGINAL
  session_date date NOT NULL,
  mark         text NOT NULL CHECK (mark IN ('paused')),
  host         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, session_date)
);

CREATE TABLE adversary_leases (
  strategy_id  text NOT NULL REFERENCES strategies(id),
  session_date date NOT NULL,
  host         text NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (strategy_id, session_date)
);
```
Plus, in the same migration, the `A-GT` row (bracket, `design-v0-gotrade`, plain A's object, status active,
paper_start NULL so it starts on the next paper night). Twin rows are **not** inserted by the migration
(see D4). Exact column defaults/trigger SQL are phase 1's to write; the column names and meanings above are
fixed.

### C2. Twin rows (phase 2 creates them; phase 3 and mcp-notes read them)

- id `<ORIGINAL_ID>-CX` (e.g. `RAW35-FR-GT-CX`, `A-GT-CX`); `twin_of = <ORIGINAL_ID>`.
- name: the original's name with `+Claude` appended to its head (the part before ` · `), e.g.
  `RAW35 · Momentum` → `RAW35+Claude · Momentum`. Same `sub`, `icon`, `engine`, `rules_id`, `object_name`.
- `is_champion = false`, `is_benchmark = false`, `gate_applicable = false`,
  `gate_note = 'Claude twin: no backtest is possible, Claude already knows how the past turned out.'`,
  `promoted_from = NULL`.
- `sort` = the original's `sort` (the engine orders `(sort, id)`, so `<ID>-CX` follows `<ID>`; Seer web's
  `orderTwins` places each twin directly after its original), `registry_id` = the original's.
- Eligible originals: `status='active' AND twin_of IS NULL AND NOT is_benchmark AND engine IN ('bracket','book')`
  and whose object is not a `NewsVeto` (C). Retiring an original retires its twin (`paper_end` = the twin's
  `paper_state.last_session`).
- Created and retired by **`store.ensure_twins(conn)`** (impure, `paper/store.py`) applying the pure planner
  **`roster.plan_twins(rows)`** (`paper/roster.py` must stay pure: `tests/test_strategy_purity.py`). The draft's
  `roster.ensure_twins` is renamed accordingly (Reconciliation Log #2).
- `roster.from_rows` refuses a twin whose id is not `twin_id(original)` or whose `(engine, rules_id, object_name,
  registry_id)` differs from its original's. Seer web's demo twin `F4-MOM12-N20-TREND-CX` (phase 3) satisfies it.

### C3. Verdict application (Seer engine is the authority)

- A twin's decision for session S reads, per symbol, the verdict row of its ORIGINAL with the greatest
  `decided_at` among rows with `session_date = S AND decided_at < session_open_utc(S)`. `superseded_by` is
  history only and is not consulted by the engine.
- `session_open_utc(d)` = 09:30 America/New_York on `d`, as UTC (14:30Z in US winter, 13:30Z in summer).
  Python: `seer_engine.dates.session_open_utc`. mcp-notes mirrors it (`src/adversary/sessions.ts`) with the
  same pinned examples: 2026-11-04 → `2026-11-04T14:30:00Z`, 2026-07-01 → `2026-07-01T13:30:00Z`.
- Bracket twin: the original's ranked picks minus `object` symbols; free slots fill from the next ranked
  pick exactly as the original. `unsure`/missing = keep.
- Book twin: at rank/kickoff sessions only, drop `object` targets and renormalise the rest pro rata; if all
  are objected the twin behaves as the original does for an empty decision. Resize-only sessions re-scale
  the twin's own last rank basket (already filtered). Objected held names are sold through the normal book
  mechanics, paying fees.

### C4. mcp-notes side

- Writer (phase 4) writes ONLY `adversary_verdicts` (INSERT, and UPDATE of `superseded_by`),
  `adversary_marks` (INSERT … ON CONFLICT DO NOTHING) and `adversary_leases` (claim/renew/release), using the
  direct (non-pooler) URL from `SEER_DIR/.env.local`; table-name allow-list enforced in code.
- Lease claim: `INSERT … ON CONFLICT (strategy_id, session_date) DO UPDATE SET host=EXCLUDED.host,
  claimed_at=now(), expires_at=EXCLUDED.expires_at WHERE adversary_leases.expires_at < now() OR
  adversary_leases.host = EXCLUDED.host RETURNING host` — expiry measured by the DB clock only.
- Toggle: mcp-notes `app_settings` key `adversary.auto`, value `{ "on": boolean, "changed_at": ISO, "host": string }`;
  absent = on. Written through `SessionsRepo.putSetting`.
- mcp-notes DB table `adversary_reviews` (migration `drizzle/0011_adversary_reviews.sql`): one row per
  review attempt (strategy_id, session_date, symbol, stage 'draft'|'final', status
  'ok'|'failed'|'skipped_budget'|'late', verdict jsonb NULL, prompt_version, gather/verdict models,
  input/output tokens, cost_usd, turns, error, host, started_at, finished_at). Draft rows hold early
  verdicts from `book_previews`.
- Coverage of a decision (strategy, session): **reviewed** if ≥ 1 verdict with `decided_at < open`;
  else **paused** if an `adversary_marks` row exists; else **absent**.
- Events: an in-process `AdversaryEvents` bus (phase 4) emitting `{ type:'adversary', op:
  'verdict'|'mark'|'toggle'|'run', strategy_id?, session_date? }`; phase 5 relays it on `/api/events` as
  SSE event `adversary`.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Seer schema, A-GT, candidate list, session open time | R1 | seer `db/`, `engine/` | 19 | — | HARD | `.workflows/plan/seer-adversarial/phase-1.md` | — | — |
| 2 | Seer twin machinery: roster twins, lag stepping, verdict filter, paper_check, promote | R1, R2 | seer `engine/` | 21 | 1 | HARD | `.workflows/plan/seer-adversarial/phase-2.md` | — | — |
| 3 | Seer web: twins on Leaderboard as Paper, never Today, rule 5 | R3 | seer `web/` | 16 | 1 | NORMAL | `.workflows/plan/seer-adversarial/phase-3.md` | — | — |
| 4 | mcp-notes reviewer job | R4 | mcp-notes `src/adversary`, `claude/adversary` | ~49 (30 rows) | 1 | HARD | `.workflows/plan/seer-adversarial/phase-4.md` | — | — |
| 5 | mcp-notes API, SSE, MCP tools, scorecard, go-live parity | R5 | mcp-notes `src/http`, `src/mcp`, `src/adversary` | 27 | 4 | HARD | `.workflows/plan/seer-adversarial/phase-5.md` | — | — |
| 6 | Wall page `/adversary` | R6 | mcp-notes `web/` | 31 | 5 | HARD | `.workflows/plan/seer-adversarial/phase-6.md` | — | — |
| 7 | Go live: land Seer, config, install/restart, first review | R7 | both | 2 | 2, 3, 6 | NORMAL | `.workflows/plan/seer-adversarial/phase-7.md` | — | — |

Phases 2 and 3 may run in parallel (both need only phase 1; their files are disjoint). Phase 4 may run in
parallel with 2 and 3 (other repo). Phases 5 and 6 need no phase-2 code: their fixtures and verify seeds
insert their own twin rows (checked, Reconciliation Log #11).

### Phase 1 — Seer schema, A-GT, candidate list, session open time
**Satisfies:** R1
**Owns:** `db/migrations/027_adversary.sql` (C1 in full, incl. A-GT row and the append-only trigger);
`A-GT` in `paper/roster.py` (`SEED_ROWS`, RESOLVER use, Gotrade bracket rules), `PINS`, `EVIDENCE`;
`dates.session_open_utc`; `paper` writing `strategy_candidates` (bracket top 10 and book rank/kickoff
targets) and `book_previews.next_decision_session` (on every preview); store functions for those, plus
`store.is_twin` as a phase-1-only bridge behind `paper._reviewable(conn, e)` (phase 2 replaces it); tests;
`README.md`, `docs/runbooks/paper-trading.md`, verify-seer `features/engine-night.md` (rewritten whole) and
`SKILL.md:202` (23 -> 24 roster strategies).
**Does not touch:** twin rows, twin stepping, verdict reading, paper_check, promote, `web/`.
**Exit criteria:** migrations apply on an empty DB (`verify-seer up --no-web --empty` shows 27 migrations);
a paper night on demo/test data writes candidates for A-GT and C-GT and rank-decision targets for books;
A-GT starts and steps with Gotrade fees; full engine suite green.

### Phase 2 — Seer twin machinery
**Satisfies:** R1, R2
**Owns:** `twin_of` on `StrategyRow` / `Row` / `RosterRow` / `RosterEntry`; twin resolution in
`roster.from_row` (wrapper objects for bracket strategies and book allocators, per C3) and the twin checks in
`from_rows`; `roster.plan_twins(rows)` (pure) + `store.ensure_twins(conn)` (create + retire per C2) called from
`paper` (start of the night transaction) and `promote` (same transaction as the insert);
`paper._reviewable(e)` reading `e.twin_of`, replacing phase 1's `_reviewable(conn, e)`, and the deletion of
phase 1's `store.is_twin` and its test; the one-session lag (D1) in
`commands/paper.py` (`plan_night` / `_trade` / `_start` with twin run dates `prev_session(rd.data_date)`,
twin starts only once `twin_session_date >= original.paper_start`); `store.objected_between` verdict reader
(C3); `paper_check` replaying twins through the same verdict reader and the twin's own last_session;
roster invariant checks; `explain` skips twins; `ensure_twins=False` in the existing test worlds that pin
their own entries (phase 1's new night tests included, through `go()`); tests (incl. "twin with no verdicts
equals its original over the same window", lag catch-up, replay ok, late verdict ignored); edits to phase 1's
`engine-night.md` (never re-created), verify-seer `features/README.md` row, `features/steps/twin-world.py`;
runbook and README sections placed after phase 1's.
**Does not touch:** migration 027 (phase 1), `dates.py`, the candidate writers' bodies (phase 1), `web/` and
`SKILL.md` (phase 3), mcp-notes.
**Exit criteria:** on a fresh test DB, one paper night creates `A-GT-CX`, `RAW35-FR-GT-CX`,
`COSK-FR-GT-CX` (none for C-GT, SPY-GT); twins step one session behind; injected verdicts change exactly
the objected symbols; `paper_check` is ok for every twin; full engine suite green.

### Phase 3 — Seer web
**Satisfies:** R3
**Owns:** `web/lib/data.ts` (select `twin_of`, `Strategy.twinOf`, `champion()` never returns a twin),
leaderboard ordering (twin directly after its original) and a Paper chip on twin cards, `looks()` so a
twin shares its original's colour with a distinct dash and later cards keep theirs, `gateItem` rule 5
"Can't be run" for twins, Today guard, demo seed rows for a twin, tests, verify-seer
`features/leaderboard.md`, `today.md`, `positions-history.md`, `steps/leaderboard-twin.mjs`, and one
`SKILL.md` line ("What a run is").
**Does not touch:** engine, migrations, `features/engine-night.md` and `features/README.md` (phases 1-2).
**Exit criteria:** `npx tsc --noEmit && npm test` green; verify-seer leaderboard shot shows a twin as
Paper beside its original; Today never shows it.

### Phase 4 — mcp-notes reviewer job
**Satisfies:** R4
**Owns:** `src/adversary/*` (config, sessions open-time mirror, seer reader [read-only, through
`src/connectors/pg.ts` style], writer [C4], discovery, lease, briefs/lens builder, data tools as an
in-process SDK MCP server: Seer price context from `bars`, Finnhub, Massive/Polygon, SEC EDGAR,
`fetch_url`; agent two-stage gather/verdict with zod-validated structured output; budget; marks; toggle;
events bus; job loop), `claude/adversary/briefs/*.md`, `src/config.ts`, `src/deps.ts`,
`src/background.ts`, `src/daemon.ts`, `src/db/schema.ts` + `drizzle/0011_adversary_reviews.sql`, unit and
integration tests (fake query fn, no network), `verify.sh` (`NOTESD_ADVERSARY=off` pin, `up --adversary`,
`exec`), and **creates** verify-notesd `features/adversary.md` (reviewer section) plus its
`features/README.md` row. Env keys handed to phase 7: `NOTESD_ADVERSARY` (on), `ADVERSARY_DAILY_CAP` (15),
`ADVERSARY_GATHER_MODEL` (sonnet), `ADVERSARY_VERDICT_MODEL` (opus), `ADVERSARY_GATHER_MAX_TURNS` (20),
`ADVERSARY_STOCK_TIMEOUT_MS` (420000), `ADVERSARY_POLL_MS` (600000).
**Does not touch:** `src/http/*`, `src/mcp/*`, `web/`, the read-only connector guard.
**Exit criteria:** with a fake agent, the job reviews due candidates in a test Seer schema (built from the
Seer worktree's migrations), writes verdicts/marks/leases correctly, respects the toggle, cap and lease
across two simulated hosts; typecheck + unit + int green.

### Phase 5 — mcp-notes API, SSE, MCP tools, scorecard
**Satisfies:** R5
**Owns:** `src/adversary/read.ts` (overview, method detail, decision verdicts, A three-way, revisions,
coverage), `src/adversary/readTypes.ts` (the wire types phase 6 mirrors verbatim),
`src/adversary/scorecard.ts` (per-objection horizon return vs kept picks; C vs Claude on disagreement
nights), `src/adversary/golive.ts` (Seer web's checklist ported EXACTLY — it is not money-weighted, see D17 —
with Seer's money-weighted return shown beside it; rule 5 "can't be run" for twins),
`src/http/adversaryApi.ts` mounted in `app.ts` (GET overview/method/decision/daily/scorecard/toggle; PUT
toggle and POST review-now same-origin only; review-now answers 202 without awaiting the pass), SSE relay
on `/api/events`, `src/mcp/adversaryTools.ts` (`adversary_overview`, `adversary_verdicts`,
`adversary_scorecard`) + the `Adversary.` instructions paragraph (including the wall pill's
`[Seer Adversarial · <id|overview>]` first-line context) + chat allow-list, README HTTP/MCP tables, an
appended API/MCP/SSE section in `features/adversary.md` (phase 4's file) and its README row, tests.
**Does not touch:** `web/`, the reviewer internals beyond calling its public `reviewNow()` and toggle API.
**Exit criteria:** API and MCP return the `readTypes.ts` shapes phase 6 consumes on a seeded
test Seer schema; same-origin guard on writes; SSE event delivered; typecheck + unit + int green.

### Phase 6 — Wall page `/adversary`
**Satisfies:** R6
**Owns:** `View` gains `'adversary'`, route `/adversary` (and `/adversary/<strategy_id>`), Rail and
Sidebar sword button (Phosphor `Sword`, duotone) between Chat history and Trash, heading `Adversary.`,
sidebar roster list (Overview first, retired greyed below), toolbar (Power toggle, Review now, Focus),
Alt+Z / Esc focus via a hook shared with ProjectsPage, overview/method/A pages per the mock, chat pill
"Ask about Seer Adversarial", SSE refresh, `web/src/adversaryApi.ts` (phase 5's `readTypes.ts` verbatim plus
fetchers; no UI for `lens_question` / `Revision.note`, which are always null), web tests, an appended wall
section in verify-notesd `features/adversary.md` and `, wall` on its README row.
**Does not touch:** server code (consumes phase 5's API only; the chat-instructions sentence is phase 5's),
and never creates `features/adversary.md`.
**Exit criteria:** web tests green; verify-notesd Playwright run on a seeded instance shows the four mock
states (overview, method, A three-way, focus with auto-runs off) with screenshots saved.

### Phase 7 — Go live
**Satisfies:** R7
**Owns:** merging Seer `feature/seer-adversarial` into `~/seer` `main` and pushing (after its full suite),
applying migration 027 to Neon (`python -m seer_engine migrate`), README configuration rows for exactly
phase 4's seven keys, one CLAUDE.md Architecture bullet for `src/adversary/*`, `.env.local` keys in
`~/mcp-notes` only if a default forces one, `scripts/install.sh` only if a new step is required (none is),
`npm run db:migrate` (drizzle 0011) BEFORE the build and restart of notesd (after the mcp-notes set lands),
triggering one "Review now" for the next decision and recording what it produced in a go-live note.
**Does not touch:** feature code (fixes found here go back as follow-up tasks, not silent edits).
**Exit criteria:** Seer main has the migration applied on Neon; the next paper night created the twins (or
the phase records when it will); notesd restarted with the reviewer on; at least one verdict or a recorded
reason for none.

## Reconciliation Log

Round 1 (plan-reconciler). Every row is fixed in the plan files named, not only noted here.

| # | Conflict (class) | Phases | Resolution |
|---|---|---|---|
| 1 | File collision: phase 2 Step 8 quoted the BASE `repick` / `_start` book branches of `commands/paper.py`, without phase 1's `_save_book_candidates` call and `save_book_preview(..., next_decision_session=...)` | 1, 2 | Phase 2 Step 8 code blocks rewritten to quote phase 1's post-change code with only `alloc` and `_reviewable(e)` added; `_step_book` / `_step_bracket` instructions name phase 1's lines to keep; the "if phase 1 changed `_trade`" caveat replaced by the fact that phase 1 does not touch `execute`/`plan_night`/`_night`/`_trade` |
| 2 | Duplicate mechanism: phase 1 detects twins with `store.is_twin` (DB read), phase 2 adds `StrategyRow.twin_of` / `RosterEntry.twin_of` | 1, 2 | One mechanism: `RosterEntry.twin_of`. Phase 2 Step 9 rewrites `_reviewable(conn, e)` as `_reviewable(e)`, updates its five call sites, deletes `store.is_twin` and `test_is_twin_reads_the_column` (deletion lands in the last phase that referenced it). Phase 1 marks `is_twin` a bridge. Contracts of both phases updated (D14) |
| 3 | Rename: index `roster.ensure_twins` vs phase 2 `store.ensure_twins` + `roster.plan_twins` (purity test) | index, 1, 2, 6, 7 | Accepted (D15). Index C2, phase 2 Owns, D4, phase 1 Leaves-alone/handoff/migration header, phase 6 seed comment, phase 7 Requires all say `store.ensure_twins` + `roster.plan_twins` |
| 4 | Contract drift: phase 2 said twins write no `next_decision_session`, phase 1 writes it on every preview | 1, 2 | Phase 1's code stands; phase 2's contract sentence rewritten (D16) |
| 5 | Unmet assumption check: append-only trigger must allow the supersede UPDATE and not block TRUNCATE | 1, 4, 5 | Confirmed against phase 1's trigger SQL (BEFORE UPDATE OR DELETE FOR EACH ROW; only `superseded_by` NULL -> a greater id with the same `(strategy_id, session_date, symbol)`, all else unchanged; DELETE refused; TRUNCATE untouched). Phase 4 Requires and phase 5 Requires now state the exact rule; phase 4's `insertVerdict` (insert new, then point old at it) and phase 5's fixture (`superseded_by = 2 WHERE id = 1`, same key, 2 > 1) satisfy it |
| 6 | Contract drift: phase 6's assumed wire types differ from phase 5's `readTypes.ts` (CoverageState `pending`, `profit_factor` `'infinite'`, nullable `buys.*` / `books.twin` / `curves` / `stats.*`, `Objections.scored/pending`, nullable `fetched_at`, always-null `lens_question` and `Revision.note`) | 5, 6 | Producer wins (D20): phase 6 Step 5 is phase 5's types verbatim (plus a local `AdversaryStatus` mirror and `MethodStats`/`ThreeWayBook` aliases); components, fixtures and tests handle the nullable/new states; UI built on `lens_question` / `note` removed |
| 7 | Duplicate creation: `features/adversary.md` | 4, 5, 6 | Phase 4 creates it and the README row; phase 5's fallback "create if missing" removed, it appends a section and extends the row; phase 6 appends the wall section and `, wall` on the row (D22) |
| 8 | Unmet assumption: phase 6 asked phase 5 to add the pill first-line context to the instructions; nobody owned it | 5, 6 | Assigned to phase 5 Step 11 (sentence appended to the `Adversary.` paragraph, unit test checks it); phase 6 Handoff now reads as satisfied (D21) |
| 9 | Contract drift: toggle / review-now calling convention | 4, 5, 6 | Server passes `reviewer.host` to `setToggle(on, host)`; the web PUTs `{on}` only; review-now answers 202 and is never awaited by the route or the page (page refreshes from SSE / poll) (D19) |
| 10 | Gap: phase 7's README rows listed four keys and its completeness check grepped every `ADVERSARY_*` token in `src` (would flag `ADVERSARY_TOGGLE_KEY`, `ADVERSARY_MCP_SERVER`, `ADVERSARY_SUBDIR`, `ADVERSARY_TOOL_NAMES`) | 4, 7 | Phase 7 rows are exactly phase 4's seven `parseAdversary` keys with phase 4's defaults; the check now reads only `env.` keys in `src/config.ts`; C2 explains that `DEFAULT_ADVERSARY_CONFIG` being off is the test default, not the daemon's (D18). `npm run db:migrate` (drizzle 0011) was already before build/restart in C3: confirmed |
| 11 | Gap: CLAUDE.md Architecture bullet for `src/adversary/*` (phase 4 handoff) had no owner | 4, 7 | Assigned to phase 7 Part A, same commit as the README rows; phase 7 Files and Creates updated |
| 12 | Dependency check: do phases 5/6 need phase 2 code? | 5, 6 | No: phase 5's `seer-seed.sql` and phase 6's verify seed insert their own twin rows; they need only 027's column names, reached through 5 -> 4 -> 1. Edges kept minimal: 2->1, 3->1, 4->1, 5->4, 6->5, 7->{2,3,6} |
| 13 | Consistency check (C2): twin naming, icon, sort and the demo twin | 2, 3 | Consistent: phase 2's `twin_row` copies `sort`, `icon`, `sub`, `registry_id`; engine order `(sort, id)` puts `<ID>-CX` after `<ID>`, matching phase 3's `orderTwins`. Phase 3's demo row `F4-MOM12-N20-TREND-CX` has id `twin_id(F4...)`, same engine `book`, rules `monthly-hold`, object `FACTOR`, registry `F4-MOM12-N20-TREND`, sort 3, `+Claude` name, C2 gate note, `gate_applicable` false: it passes phase 2's `_check_twins`. Index C2 now states sort/registry_id |
| 14 | Consistency check: verify-seer counts | 1, 2, 3 | `up --empty`: 27 migrations, `strategies: 24` (phase 1) and unchanged by phase 2 (no migration writes a twin, no night runs there). Phase 1's engine-night gotcha "replay mismatch for all five strategies" became "every seeded paper strategy" in phase 2, because phase 3 adds a sixth demo paper row in parallel |
| 15 | File collision: verify-seer files and Seer docs | 1, 2, 3 | Sequenced: phase 1 rewrites `engine-night.md` and edits `SKILL.md:202`, README, runbook; phase 2 edits phase 1's `engine-night.md` (placement named after phase 1's pytest block, never re-created), `features/README.md`, README and runbook after phase 1's sections (and fixes phase 1's runbook sentence "the twins are a later change"); phase 3 owns `leaderboard.md`, `today.md`, `positions-history.md`, its steps file and a different `SKILL.md` line. Phases 2 and 3 share no file |
| 16 | Unmet assumption: phase 2 Step 13 "any test phase 1 added" was open-ended | 1, 2 | Phase 2 Step 13 names phase 1's seven night tests (all through `go()`, covered by the `:159` edit), notes `test_adversary_schema.py` / `test_paper_candidates.py` run no night, and explains why `test_a_twin_gets_no_list`'s hand-made `A-CX` still passes phase 2's `_check_twins` and `_twin_may_start` |
| 17 | Contract drift: index phase 5 Owns said "money-weighted as Seer computes it" for the checklist | index, 5 | Index text corrected to phase 5's verified finding (D17) |

Round 2 (plan-reconciler, verification of round 1's two contract changes). Checked: phase 2 Step 8/9
call sites against phase 1's quoted `repick` (book + bracket), `_start`, `_step_bracket`, `_step_book` (five
`_reviewable(conn, e)` sites, all matched); no phase 3-7 references `is_twin` or `_reviewable`; phase 6's
created web files (types, components, fixtures, tests) type-checked with `tsc -p tsconfig.web.json` against
phase 5's `readTypes.ts` with no field or nullability error; phase 6's `AdversaryStatus` / `ToggleState`
mirror equals phase 4's `service.ts` / `toggle.ts`; phase 6's verify seed SQL ran clean on Seer migrations
001-026 plus phase 1's 027 (twins `A-GT-CX`, `RAW35-FR-GT-CX`, `COSK-FR-GT-CX`, matching phase 2's eligible set).

| # | Conflict (class) | Phases | Resolution |
|---|---|---|---|
| 18 | Deleted-then-used (residual): phase 1's `test_paper_candidates.py` module docstring names ``is_twin``; phase 2 Step 9 deleted the function and test but not that clause, so its own `grep -rn "is_twin" engine/` check would fail | 1, 2 | Phase 2 Step 9, Files table and test list now also drop the docstring clause |
| 19 | Index state: `**Status:**` still `planned` after round 1 | index | Set to `reconciled` |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| D1. Decide-late twins vs fallback cron (R2) | **Decide-late confirmed, in the one-session-lag form**: a twin is stepped as if tonight's data date were `prev_session(rd.data_date)`; it decides S on the night after S closes from `view(S-1)` with verdicts decided before S's open, and settles S the night after. The brief's literal "decide then settle S in one night" is rejected: `plan_night`/`write_pending` forbid a settled-but-undecided entry and `replay.expected_*` always expects the pending decision. No fallback cron. | 5: user raw input asked to confirm against the real runner; evidence in the analysis "R2 verdict" |
| D2. Where `superseded_by` sits | column on `adversary_verdicts` + append-only trigger; engine ignores it and takes the latest row decided before the open | 4: brief §4.1 "planner decides" + honesty §5 |
| D3. Book reviews at resize-only sessions | not reviewed; objections apply at rank/kickoff sessions only, resize re-scales the twin's already-filtered basket | 4: owner decision 6 says "every rebalance" (= a pick), owner decision 7 budget |
| D4. How twins appear/retire with no manual step | `store.ensure_twins` (applying the pure `roster.plan_twins`) in `paper`'s night transaction (covers migrations) and in `promote`'s transaction (covers Sera promotion); not seeded by migration 027 | 4: owner decision 5 + brief §4.1 "same transaction" |
| D5. Twin start date | the first session the lagged twin can decide that is on/after the original's `paper_start` (i.e. go-live night or later), with `PAPER_INITIAL_IDR` and the owner's deposit schedule from its own `paper_start` | 4: brief §4.1 "whichever is later, same capital and deposits" |
| D6. Book: all targets objected | twin behaves as the original does for an empty decision (its rule set's idle/cash behaviour) | 4: brief §4.1 "decide and document" |
| D7. Candidate list shape | one table `strategy_candidates` for bracket top 10 AND book rank targets, so mcp-notes never ports Seer's cadence | 6: surrounding convention (Seer is the authority on its schedule) |
| D8. Lease location and clock | Seer DB `adversary_leases`, expiry by DB `now()` | 5: brief §4.2 "(and lease rows) to Seer's DB"; risk §7 clocks |
| D9. Toggle storage | mcp-notes `app_settings` `adversary.auto` via `SessionsRepo.putSetting` | 5: brief §4.2 "lives in the shared mcp-notes DB" |
| D10. Default daily cap | 15 deep reviews per WIB day (configurable), A's candidates first, then book decisions by earliest open, previews only with leftover budget; over cap = absent, logged `skipped_budget` | 5: owner decision 7 "about 10 to 15" |
| D11. Models | gather `sonnet`, verdict `opus` (aliases, configurable); exact model ids recorded from the SDK result | 5: owner decision 7 |
| D12. Late verdicts | the writer still writes a verdict that finishes after the open (kept for honesty); the engine ignores it; the page counts it as absent with a "late" note | 1: invariant 4 |
| D13. Landing order | Seer phases commit on Seer's feature branch; phase 7 merges Seer to main first, then notesd restarts; a reviewer started before 027 exists logs and idles | 6: Seer CLAUDE.md "commit and push to main once verified" + one-writer safety |
| D14. How the night knows an entry is a twin | `RosterEntry.twin_of` (phase 2) is the only source; phase 1's `store.is_twin` is a bridge that phase 2 deletes, `_reviewable(conn, e)` becomes `_reviewable(e)` | 3: the plans' code blocks (phase 2's lag, wrappers and `from_rows` checks all need `e.twin_of`; phase 1's handoff names `is_twin` as the stand-in) |
| D15. Where `ensure_twins` lives | `store.ensure_twins(conn)` writes, `roster.plan_twins(rows)` plans (pure) | 1: invariant 1 (suite green) — Seer's `tests/test_strategy_purity.py` fails if `paper/roster.py` touches a connection |
| D16. `next_decision_session` on a twin's preview | written as for every preview (a true cadence fact, display only); the reviewer ignores it because phase 4 reads previews only for reviewable originals (`twin_of IS NULL`) | 3: the plans' code blocks (phase 1 writes it on every preview; phase 4's `PREVIEWS_SQL` filters to reviewable ids) |
| D17. Go-live checklist on the wall | port Seer web's checklist EXACTLY (raw `last/first - 1`, raw-equity drawdown, `spyOverSpan`), which is NOT money-weighted (the brief's §3 claim is wrong); show Seer's own money-weighted return (`money_weighted_return`, period form) and the time-weighted worst drop beside it; record the mismatch as a Seer follow-up | 3: the plans' code blocks (phase 5's verified reading of `web/lib/metrics.ts` and `backtest/metrics.py`) over the brief, plus invariant 4 (page numbers from the DB) — the wall must never disagree with seertrade.site |
| D18. Reviewer on/off defaults | `NOTESD_ADVERSARY` defaults ON at runtime (`parseSwitch`); `DEFAULT_ADVERSARY_CONFIG` (`enabled: false`) is what hand-built test configs use; verify-notesd pins `NOTESD_ADVERSARY=off` except `up --adversary` | 1: invariant 6 (tests never touch Neon / live) + index R4/R7 (reviewer runs for real after phase 7) |
| D19. Toggle and Review now calls | `PUT /api/adversary/toggle {on}`: the server calls `setToggle(on, reviewer.host)` (the web never sends a host); `POST /api/adversary/review-now {strategy_id?}` answers 202 `{started, reason}` and is not awaited by route or page; results arrive by SSE `adversary` / poll | 3: the plans' code blocks (phase 4: "do not await in a request handler"; phase 5's routes) |
| D20. Wall wire types | phase 6's `web/src/adversaryApi.ts` = phase 5's `src/adversary/readTypes.ts` verbatim; `lens_question` and `Revision.note` are always null this set, so the wall shows no lens question and no revision note (a follow-up may persist them in phase 4's tables) | 3: the plans' code blocks of the producer |
| D21. Who explains the pill's `[Seer Adversarial · <id\|overview>]` first line to the chat agent | phase 5, one sentence in the `Adversary.` instructions paragraph | 2: phase exit criteria / ownership (phase 6 "does not touch server code"; phase 5 owns `src/mcp/instructions.ts`) |
| D22. Feature map `features/adversary.md` | phase 4 creates the file and its README row; phases 5 and 6 append sections and extend that one row; nobody re-creates it | 3: the plans' code blocks (phase 4 Step 18 creates; phases 5/6 depend on 4) |

## Open Questions

(none)

## Rollback

- Seer: migration 027 is additive. Back out with a migration 028 that retires `A-GT` and every `*-CX` row
  (status retired, history kept) — closed records are never deleted; the code revert of phases 1–2 must
  come after 028 (an active row whose object no longer resolves stops the night).
- mcp-notes: `NOTESD_ADVERSARY=off` disables the job without a deploy; reverting phases 4–6 is a plain
  revert; `drizzle/0011` is additive.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f /home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/plan/SEER_ADVERSARIAL_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows:

    /analyze-orchestrator -f /home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/plan/SEER_ADVERSARIAL_PLAN.md
