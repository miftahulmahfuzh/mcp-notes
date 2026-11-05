# Phase 1: Seer schema, A-GT, candidate list, session open time

**Plan set:** `SEER_ADVERSARIAL_PLAN.md`
**Analysis:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Satisfies:** R1 (part): the Seer schema the twins and the reviewer stand on, plain A back as `A-GT`, the candidate list for bracket methods (and book rank targets), and the session-open cutoff
**Depends on:** none
**Difficulty:** HARD
**Package:** seer `db/`, `engine/` (code root `/home/miftah/.worktrees/seer/seer-adversarial`, branch `feature/seer-adversarial`)

All paths below are relative to the code root `/home/miftah/.worktrees/seer/seer-adversarial` unless they
start with `/`. Line numbers are against `a6322d7` (the worktree base; nothing has landed on it yet).

---

## Goal

After this phase, migration 027 gives Seer's database every table and column of contract C1, with an
append-only trigger on `adversary_verdicts`, and admits `A-GT`: plain Strategy A at real Gotrade fees,
starting on the next paper night. Every paper night writes a ranked candidate list for the decisions
Claude will review, in `strategy_candidates`. Bracket methods get their own top 10 before any news veto
(C-GT included). Books get the targets of their rank and kickoff decisions. Each book preview now says
when that book next ranks. `seer_engine.dates.session_open_utc` gives the honesty cutoff everything later
is measured against. No twin row exists yet; phase 2 creates twins.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `db/migrations/027_adversary.sql`: C1 in full, with these column names and meanings fixed:
  - `strategies.twin_of text NULL REFERENCES strategies(id)`, `CHECK (twin_of IS NULL OR twin_of <> id)`
    (constraint `strategies_twin_of_not_self`), partial unique index `strategies_one_active_twin ON
    strategies (twin_of) WHERE twin_of IS NOT NULL AND status = 'active'`.
  - `strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence,
    created_at)`, PK `(strategy_id, session_date, symbol)`, UNIQUE `(strategy_id, session_date, rank)`,
    CHECKs: `kind IN ('bracket','book')`, `rank >= 1`, `symbol <> ''`, `data_date < session_date`,
    `(kind='bracket' AND weight IS NULL) OR (kind='book' AND weight > 0 AND weight <= 1)`, evidence NULL or
    a jsonb array; index `strategy_candidates_session (session_date, strategy_id)`.
  - `book_previews.next_decision_session date NULL`, `CHECK (next_decision_session IS NULL OR
    next_decision_session > data_date)` (constraint `book_previews_next_after_data`).
  - `adversary_verdicts` exactly as C1 (id bigserial, strategy_id, session_date, symbol, verdict, reason,
    sources, lens, model, prompt_version, host, started_at, decided_at, superseded_by, created_at), index
    `adversary_verdicts_key (strategy_id, session_date, symbol, decided_at)`; the sources CHECK is written
    with a `CASE` so a non-array `sources` is refused rather than raising.
  - trigger `adversary_verdicts_append_only` (BEFORE UPDATE OR DELETE, FOR EACH ROW) on function
    `adversary_verdicts_append_only()`: DELETE is refused. UPDATE is refused unless it only moves
    `superseded_by` from NULL to the id of a LATER row (`id >` old id) with the same `(strategy_id,
    session_date, symbol)`. All refusals are `RAISE EXCEPTION` (SQLSTATE P0001, psycopg
    `errors.RaiseException`), and every message starts `adversary_verdicts`. TRUNCATE is NOT blocked: the
    web demo seeder does `TRUNCATE ... strategies ... CASCADE`.
  - `adversary_marks` and `adversary_leases` exactly as C1.
  - the `A-GT` row (below).
- `A-GT` roster row, byte for byte the same in 027 and `paper/roster.py` `SEED_ROWS`:
  `id='A-GT'`, `name='A · Dip buy'`, `sub='Buys a sharp short drop in a stock above its 200-day average,
  sells within 5 days, daily, real Gotrade fees'`, `icon='sigma'`, `is_champion=false`,
  `is_benchmark=false`, `sort=5`, `engine='bracket'`, `rules_id='design-v0-gotrade'`,
  `object_name='STRATEGY_A'` (plain A's RESOLVER key, verified at `paper/roster.py:560`),
  `registry_id=NULL`, `gate_applicable=true`, `promoted_from=NULL`, `status='active'`,
  `paper_start=NULL`, `params='{}'`, `twin_of=NULL`. Spec digest
  `3db8862e29948b3cad007e404c0b1c59d79b1a9f7bdcc4d3a5eb043a42d4080d` (computed on the worktree base
  without editing code; see Step 3).
- `seer_engine.paper.roster.A_GT_ID = "A-GT"`.
- `seer_engine.dates.session_open_utc(d: date) -> datetime`: 09:30 America/New_York on NYSE session `d`,
  as a UTC-aware datetime. `ValueError` for a day with no session, `TypeError` for a datetime. Pinned:
  `2026-11-04 -> 2026-11-04T14:30:00Z`, `2026-07-01 -> 2026-07-01T13:30:00Z` (C3). Equal to the NYSE
  calendar's `market_open` on every 2026–2027 session (502 of them, measured here).
- `seer_engine.paper.candidates` (new pure module):
  - `CANDIDATE_TOP = 10`, `RANK_SCAN_SESSIONS = 260`
  - `@dataclass(frozen=True, slots=True) class Candidate(rank: int, symbol: str, weight: Decimal | None = None)`
  - `bracket_candidates(obj, params, history, members, data_date, *, top=CANDIDATE_TOP) -> tuple[Candidate, ...]`
  - `book_candidates(targets: Sequence[Target], idle_symbol: str | None) -> tuple[Candidate, ...]`
  - `next_rank_session(rules: TradeRules, data_date: date, *, kickoff: bool) -> date | None`
- `seer_engine.paper.store`:
  - `CANDIDATE_KINDS = ("bracket", "book")`
  - `save_candidates(conn, strategy_id, session_date, data_date, kind, items, *, evidence=None) -> bool`:
    replaces the `(strategy_id, session_date)` list and returns True, or writes nothing and returns False
    when the stored list already equals it (kind, data_date, rank, symbol, weight, evidence)
  - `read_candidates(conn, strategy_id, session_date) -> tuple[Candidate, ...]`
  - `is_twin(conn, strategy_id) -> bool` (`strategies.twin_of IS NOT NULL`; StoreError for no row).
    A bridge for this phase only: phase 2 deletes it once `RosterEntry.twin_of` exists (reconciled).
- `seer_engine.commands.paper`: private helpers `_reviewable(conn, e) -> bool`,
  `_save_bracket_candidates(conn, e, view, data_date) -> None`,
  `_save_book_candidates(conn, e, session, data_date, targets, facts) -> None`.

**Signature changes:**
- `store.save_book_preview(conn, strategy_id, data_date, targets, *, evidence=None)` ->
  `store.save_book_preview(conn, strategy_id, data_date, targets, *, evidence=None, next_decision_session=None)`
  (keyword-only, default None, so every existing caller still works).

**Table writes other phases rely on (written by `paper`, inside the night's one transaction):**
- `strategy_candidates`: one list per `(strategy, session_date)`. `session_date` is the decision session
  and `data_date = prev_session(session_date)` is the night that decided it. Written for every ACTIVE entry
  with `engine IN ('bracket','book')`, `NOT is_benchmark` and `twin_of IS NULL`:
  - `kind='bracket'`: the method's own ranking (`obj.picks`; for a `NewsVeto` it is
    `strategies.c.candidates`, A's ranking cut to C's `max_candidates`, never the allowed subset), first
    10, `weight NULL`, ranks 1..n. Written for every session the entry decides (start, every catch-up
    session, a repick).
  - `kind='book'`: the targets of a rank or kickoff decision only, never a resize-only one, the rules'
    `idle_symbol` dropped, ranked by weight descending then symbol, `weight` = the target weight.
  - `evidence`: the same plain facts `strategies.evidence` stores on orders and targets, or NULL.
  - Rewritten only when it differs. A repick that changes the not-offered list rewrites the list for that
    pending decision. A list equal to the stored one keeps its rows and its `created_at`.
- `book_previews.next_decision_session`: on every preview the night writes, the next RANK session after
  the preview's `data_date`. That is `next_session(data_date)` when tonight's decision is a kickoff, else
  the first `is_rank_session` session after `data_date`, else NULL when none falls within 260 sessions.
  Resize-only sessions are never named.

**Failure semantics (decided here):** computing a candidate list never fails the night and never changes
a decision. If the computation raises, the helper logs one warning (`"<id> <session>: no candidate list
stored tonight (<redacted error>); the decision is unchanged"`), leaves that `(strategy, session)` as it
was, and the night goes on. This is the evidence pattern (`commands/paper.py:637-675`). A DATABASE error on
the write does fail the night, like every other write in the transaction. A savepoint that swallowed it
would hide a missing migration and leave the reviewer blind with no failed step to show for it. Nightly
always runs Migrate before Paper, so in practice this is only a schema bug.

**Requires (from earlier phases):** nothing (first phase).

**Leaves alone (owned by others):**
- twin rows, `store.ensure_twins` (with the pure planner `roster.plan_twins`), twin wrappers in `roster.from_row`, the one-session lag,
  `store.objected_between`, `paper_check` twin replay, `promote` (phase 2). Phase 1 never inserts a row
  with `twin_of` set except inside tests.
- `store.StrategyRow` and the `roster.Row` protocol gain no `twin_of` field here; phase 2 adds it if
  `from_row` needs it (it does: phase 2 adds it). Phase 1 reads `twin_of` only through `store.is_twin`.
- `web/` entirely, `web/scripts/seed-demo.mjs`, `features/leaderboard.md`, `features/today.md` (phase 3).
- everything in `/home/miftah/.worktrees/mcp-notes/seer-adversarial` except this plan file (phases 4–7).

## Files

| File | Action | What changes |
|---|---|---|
| `db/migrations/027_adversary.sql` | create | C1 schema, append-only trigger, `A-GT` row, prose header |
| `engine/src/seer_engine/dates.py` | modify | `session_open_utc` (after `session_close_utc`, line 113); docstring and imports |
| `engine/src/seer_engine/paper/candidates.py` | create | pure candidate list and next-rank-session helpers |
| `engine/src/seer_engine/paper/store.py` | modify | docstring bullet (line 30); `is_twin` (after `read_strategy`, line 255); `save_book_preview` (lines 728-766) gains `next_decision_session`; `CANDIDATE_KINDS`, `save_candidates`, `read_candidates` (new section after `save_book_preview`) |
| `engine/src/seer_engine/paper/roster.py` | modify | `A_GT_ID` (after line 216); `A-GT` `RosterRow` in `SEED_ROWS` (insert at line 1241, after RAW35's row) |
| `engine/src/seer_engine/commands/paper.py` | modify | docstring paragraph (after line 46); import (line 77); `repick` (lines 476-583); new helpers after `_evidence` (line 675); `_start` (lines 721-799); `_step_bracket` (lines 802-836); `_step_book` (lines 839-919) |
| `engine/tests/test_dates.py` | modify | session-open tests (append) |
| `engine/tests/test_paper_candidates.py` | create | pure helpers + store functions |
| `engine/tests/test_adversary_schema.py` | create | migration 027: tables, checks, trigger, leases, A-GT row |
| `engine/tests/test_paper_command.py` | modify | `CONTENT`/`EVERYTHING`/`reset` cover `strategy_candidates`; night tests for candidates, previews, twins, failure, repick, A-GT |
| `engine/tests/test_paper_roster.py` | modify | `A_GT` in ids, sorts, ACTIVE_IDS, PINS, lookbacks, NOT_LAB_DERIVED, active-after-retire, chains; new A-GT test |
| `engine/tests/test_paper_store.py` | modify | roster order list (line 64-69) |
| `engine/tests/test_paper_fnd.py` | modify | FND index 9 -> 10, roster length 23 -> 24 (lines 162-167) |
| `engine/tests/test_migrate.py` | modify | roster order list (lines 291-300) |
| `engine/tests/test_paper_check.py` | modify | `ALL_IDS` (lines 60-63) |
| `README.md` | modify | architecture step 3 (line 358); night table Paper row (line 384); new "Seer Adversarial" subsection after "Scheduled jobs" (before line 406's `---`) |
| `docs/runbooks/paper-trading.md` | modify | new roster subsection (before line 49); Paper step in "The night" diagram (after line 162) |
| `.claude/skills/verify-seer/features/engine-night.md` | modify | counts 26->27 / 23->24; candidate sub-feature and journeys |
| `.claude/skills/verify-seer/SKILL.md` | modify | "23 roster strategies" -> 24 (line 202) |

## Implementation Steps

### Step 1: Migration 027
**File:** `db/migrations/027_adversary.sql` (new)
**Change:** the whole of C1, the trigger, the `A-GT` row. Written so a re-run is harmless (IF NOT EXISTS,
DROP ... IF EXISTS, ON CONFLICT). Both runners (`commands/migrate.py:43` and `web/scripts/migrate.mjs`)
send the file as one simple-protocol query, so the dollar-quoted function body is safe. This is the first
plpgsql in `db/migrations/`.
**Code:**
```sql
-- Seer schema v27: Seer Adversarial -- Claude reviews the roster's picks, and plain A comes back
-- (owner, 2026-11-05).
--
-- WHAT IT IS. Before a roster method's pick is bought, Claude -- running in the owner's notes daemon
-- (mcp-notes), not in this repo -- researches it on the web and says agree, object or can't tell, with
-- a link for every claim. Each eligible method then gets a "Claude twin": a separate paper book that
-- runs the same method but drops what Claude objected to, simulated by Seer's one simulator with the
-- same fees and deposits, so the leaderboard, the go-live checklist and paper_check judge it like any
-- other entry. Over about eighteen months the owner sees whether the twins beat the originals on
-- Seer's own order of cause: beat SPY, make the most money, fall less. The design brief is
-- docs/plans/2026-11-05-seer-adversarial-design.md in the mcp-notes repo.
--
-- WHAT THIS FILE ADDS, AND WHO WRITES EACH PART.
--   strategies.twin_of       set on a twin row, naming its original. At most one ACTIVE twin per
--                            original (strategies_one_active_twin). This file inserts NO twin: the
--                            paper night creates and retires them (paper.store.ensure_twins, a later
--                            change), so a method Sera admits next month gets its twin with no
--                            migration and no manual step.
--   strategy_candidates      written by `paper`, inside the night's one transaction: for each active,
--                            non-twin, non-benchmark bracket method, its OWN ranked top 10 for the
--                            session being decided, BEFORE any news veto (C-GT's list is A's ranking,
--                            exactly what `veto` checks, never only what C let through); for each
--                            book, the targets of a rank or kickoff decision, never of a resize-only
--                            one. This is what Claude reviews, so it never has to re-run Seer's methods.
--   book_previews.next_decision_session
--                            the next RANK session after the preview's data date, so the reviewer can
--                            look early at a monthly book without porting Seer's cadence rules.
--   adversary_verdicts       written ONLY by mcp-notes. One row per review of (ORIGINAL strategy,
--                            decision session, symbol). Append-only, enforced by a trigger: a row is
--                            never deleted and never edited; the one update allowed links it to the
--                            later re-review that supersedes it (superseded_by), so the history stays.
--   adversary_marks          written ONLY by mcp-notes: 'paused' when the owner's ON/OFF toggle was off
--                            for that decision. No verdict and no mark means absent.
--   adversary_leases         written ONLY by mcp-notes: which of the owner's two machines is reviewing
--                            a (strategy, session), expiring by this database's clock.
--
-- THE HONESTY RULE THE TABLES ARE BUILT FOR. A verdict counts only if decided_at is before 09:30 New
-- York on its session (seer_engine.dates.session_open_utc: 14:30 UTC in US winter, 13:30 in summer).
-- Missing, failed or late means the twin copies its original. The engine takes the latest verdict
-- decided before the open and never reads superseded_by, which is history for people, not an input.
-- Claude cannot be backtested -- it already knows how the past went -- so no twin ever gets a backtest.
--
-- A-GT: PLAIN A COMES BACK. No plain A has traded since 013 retired it; C-GT is A's only descendant on
-- the roster. The owner wants A, C and A-with-Claude compared three ways, so A-GT is admitted: Strategy
-- A's own rule (STRATEGY_A, unchanged since it was frozen) under design-v0-gotrade, the rule set C-GT
-- trades -- 4 slots, 5-day brackets, whole shares, Gotrade's measured fees -- on the same 10,000,000
-- IDR start and the same 5,000,000 IDR on the 25th of each month. It is NOT a candidate for real money:
-- its gate failed out of sample (2022-01-03..2026-10-02: -15.0% vs SPY TR +71.9%, PF 0.92, max DD
-- 33.3%), and its row says so. It is here as the baseline.
--
-- WHY A NEW ID AND NOT REVIVING A. A is frozen under design-v0 (a flat 0.1% a side) with its own pinned
-- digest; moving it to Gotrade's fees would change that digest and store.check_digest would refuse its
-- next night. The rule (docs/runbooks/paper-trading.md) is a new entry with a new id and its own clock,
-- as 010, 013, 017, 021 and 022 did. A stays retired and keeps every row it wrote.
--
-- NOT TOUCHED. The section 1 real-money bar. C-GT, its veto and its prompt. Every started entry's spec
-- digest (sort, status and paper_end are outside the spec, and nothing else of theirs moves). The
-- mcp-notes connector's read-only guard: mcp-notes writes the three adversary tables through a separate,
-- narrow writer.
--
-- The A-GT row below is byte for byte paper/roster.py's SEED_ROWS (the migration-equality test,
-- tests/test_paper_roster.py::test_the_migration_rows_equal_the_seed_rows). paper_start, the frozen spec
-- and the paper clock are written by the entry's first night, as for every new entry.

-- ---- twins ------------------------------------------------------------------------------------------

ALTER TABLE strategies ADD COLUMN IF NOT EXISTS twin_of text NULL REFERENCES strategies(id);
ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_twin_of_not_self;
ALTER TABLE strategies ADD CONSTRAINT strategies_twin_of_not_self CHECK (twin_of IS NULL OR twin_of <> id);
CREATE UNIQUE INDEX IF NOT EXISTS strategies_one_active_twin
    ON strategies (twin_of) WHERE twin_of IS NOT NULL AND status = 'active';

-- ---- what Claude reviews ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS strategy_candidates (
  strategy_id  text NOT NULL REFERENCES strategies(id),
  session_date date NOT NULL,                     -- the decision session
  data_date    date NOT NULL,                     -- the night that decided it: prev_session(session_date)
  kind         text NOT NULL CHECK (kind IN ('bracket', 'book')),
  rank         integer NOT NULL CHECK (rank >= 1),
  symbol       text NOT NULL CHECK (symbol <> ''),
  weight       numeric NULL,                      -- a book target's weight; NULL for a bracket candidate
  evidence     jsonb NULL CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'array'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, session_date, symbol),
  UNIQUE (strategy_id, session_date, rank),
  CHECK (data_date < session_date),
  CHECK ((kind = 'bracket' AND weight IS NULL) OR (kind = 'book' AND weight > 0 AND weight <= 1))
);
CREATE INDEX IF NOT EXISTS strategy_candidates_session ON strategy_candidates (session_date, strategy_id);

-- The reviewer's early look at a book's next rank decision.
ALTER TABLE book_previews ADD COLUMN IF NOT EXISTS next_decision_session date NULL;
ALTER TABLE book_previews DROP CONSTRAINT IF EXISTS book_previews_next_after_data;
ALTER TABLE book_previews ADD CONSTRAINT book_previews_next_after_data
    CHECK (next_decision_session IS NULL OR next_decision_session > data_date);

-- ---- what Claude said -----------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adversary_verdicts (
  id              bigserial PRIMARY KEY,
  strategy_id     text NOT NULL REFERENCES strategies(id),   -- the ORIGINAL, never the twin
  session_date    date NOT NULL,                             -- the decision session
  symbol          text NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN ('agree', 'object', 'unsure')),
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
  -- agree and object cite at least one fetched source; a non-array is refused, never an error
  CHECK (CASE
           WHEN jsonb_typeof(sources) <> 'array' THEN false
           WHEN verdict = 'unsure' THEN true
           ELSE jsonb_array_length(sources) >= 1
         END),
  CHECK (decided_at >= started_at)
);
CREATE INDEX IF NOT EXISTS adversary_verdicts_key
    ON adversary_verdicts (strategy_id, session_date, symbol, decided_at);

-- Append-only. A verdict is never deleted and never edited; the one update allowed links it to the
-- later verdict on the same (strategy, session, symbol) that supersedes it, and only once.
CREATE OR REPLACE FUNCTION adversary_verdicts_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'adversary_verdicts is append-only: verdict % cannot be deleted', OLD.id;
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'adversary_verdicts is append-only: verdict % is already superseded by %',
      OLD.id, OLD.superseded_by;
  END IF;
  IF NEW.superseded_by IS NULL
     OR (to_jsonb(NEW) - 'superseded_by') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_by') THEN
    RAISE EXCEPTION 'adversary_verdicts is append-only: the only update allowed sets superseded_by on verdict %',
      OLD.id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM adversary_verdicts n
    WHERE n.id = NEW.superseded_by
      AND n.id > OLD.id
      AND n.strategy_id = OLD.strategy_id
      AND n.session_date = OLD.session_date
      AND n.symbol = OLD.symbol
  ) THEN
    RAISE EXCEPTION 'adversary_verdicts: verdict % can only be superseded by a later verdict on the same strategy, session and symbol',
      OLD.id;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS adversary_verdicts_append_only ON adversary_verdicts;
CREATE TRIGGER adversary_verdicts_append_only
  BEFORE UPDATE OR DELETE ON adversary_verdicts
  FOR EACH ROW EXECUTE FUNCTION adversary_verdicts_append_only();

CREATE TABLE IF NOT EXISTS adversary_marks (
  strategy_id  text NOT NULL REFERENCES strategies(id),   -- the ORIGINAL
  session_date date NOT NULL,
  mark         text NOT NULL CHECK (mark IN ('paused')),
  host         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, session_date)
);

CREATE TABLE IF NOT EXISTS adversary_leases (
  strategy_id  text NOT NULL REFERENCES strategies(id),
  session_date date NOT NULL,
  host         text NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (strategy_id, session_date)
);

-- ---- A-GT ---------------------------------------------------------------------------------------------

INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, sort, engine, rules_id,
                        object_name, registry_id, gate_note, gate_applicable, promoted_from) VALUES
  ('A-GT', 'A · Dip buy', 'Buys a sharp short drop in a stock above its 200-day average, sells within 5 days, daily, real Gotrade fees', 'sigma', false, false, 5, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', NULL, 'Plain Strategy A, back on paper (owner, 2026-11-05) as the baseline that C-GT and the Claude twins are compared against: the same rule, the same 4 slots and 5-day brackets, and the same starting capital, monthly deposits and Gotrade fees as C-GT, with no news check. It is not a candidate for real money: its backtest gate failed out of sample (2022-01-03..2026-10-02), -15.0% vs SPY TR +71.9%, PF 0.92, max DD 33.3%, which is why 013 retired the whole-share A', true, NULL)
ON CONFLICT (id) DO NOTHING;
```
**Impact:** additive. Sort 5 is free; 026 vacated it. The board order becomes SPY-GT, C-GT, COSK, RAW35,
A-GT, then the 19 retired entries. That moves the pinned roster lists in five test files (Steps 9–10).
No existing reader uses `SELECT *` on `book_previews` (checked: `paper/store.py:743-765`,
`web/lib/data.ts:378`, `web/scripts/seed-demo.mjs:416`, `tests/test_paper_evidence.py:101` all name
columns). `paper/replay.py` and `commands/paper_check.py` never read `book_previews`. The web demo
seeder's `TRUNCATE ... strategies RESTART IDENTITY CASCADE` empties the new tables too, which is why no
TRUNCATE trigger is added.

### Step 2: `dates.session_open_utc`
**File:** `engine/src/seer_engine/dates.py:1-20` (docstring, imports) and after `session_close_utc` (line 113)
**Change:** add the cutoff helper. It is wall-clock 09:30 New York, the same rule the mcp-notes mirror
(`src/adversary/sessions.ts`, phase 4) computes without a calendar. The NYSE calendar's own
`market_open` is 09:30 New York on every session, half days included, and a test pins the two equal over
2026–2027.
**Code:** replace lines 1-20 (docstring through `_MAX_YEAR_SCAN = 3`) with:
```python
"""NYSE session arithmetic.

Dates are ``datetime.date`` values (the ET calendar date of a session). The only
timezone-aware datetimes here are UTC "now", session closes from the NYSE calendar,
whose ``market_close`` already accounts for half days and daylight saving time, and
session opens (09:30 New York wall-clock, as UTC).

- ``data_date``: the last completed session, i.e. the latest session whose close plus a
  settle margin is not after now.
- ``session_date``: the session after ``data_date``, which the next picks are for.
- ``session_open_utc(d)``: the information cutoff for session ``d`` (Seer Adversarial, 027). A
  reviewer's verdict on a pick for ``d`` counts only if it was decided before this instant.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

import pandas_market_calendars as mcal

CALENDAR = "NYSE"
DEFAULT_SETTLE = timedelta(hours=1)

#: Where and when every NYSE session opens, half days included.
NEW_YORK = ZoneInfo("America/New_York")
SESSION_OPEN_LOCAL = time(9, 30)

# How many calendar years next_session/prev_session will scan before giving up.
_MAX_YEAR_SCAN = 3
```
and insert after `session_close_utc` (after line 113):
```python
def session_open_utc(d: date) -> datetime:
    """09:30 America/New_York on session ``d``, in UTC: 14:30 UTC in US winter, 13:30 in summer.

    The information cutoff of Seer Adversarial (migration 027): a verdict on a pick for ``d``
    counts only if its ``decided_at`` is before this instant, so a twin's decision can never lean
    on anything learned after the session it trades opened. Wall-clock New York time rather than
    the calendar's ``market_open`` so mcp-notes can mirror it with a time-zone library alone; the
    two are equal on every NYSE session (half days open at 09:30 too), and
    ``tests/test_dates.py`` checks that across 2026-2027.

    ValueError when ``d`` is not an NYSE session, TypeError for a datetime: a cutoff for a day
    with no session would be a cutoff for a decision that cannot exist.
    """
    d = _as_date(d)
    if not is_session(d):
        raise ValueError(f"{d} is not an NYSE session")
    return datetime.combine(d, SESSION_OPEN_LOCAL, tzinfo=NEW_YORK).astimezone(timezone.utc)
```
**Impact:** none on existing callers. `zoneinfo` is stdlib and `strategies/c.py:26` already uses it.

### Step 2b: Session-open tests
**File:** `engine/tests/test_dates.py` (append at end, after `test_run_dates_defaults_to_now`, line 149)
**Change:** pin C3's examples and both DST edges, and check the wall-clock rule against the calendar.
Measured on the worktree base: the calendar's `market_open` equals 09:30 New York on all 502 sessions of
2026–2027.
**Code:**
```python
@pytest.mark.parametrize(
    ("d", "expected"),
    [
        ("2026-11-04", datetime(2026, 11, 4, 14, 30, tzinfo=timezone.utc)),  # plan C3, US winter
        ("2026-07-01", datetime(2026, 7, 1, 13, 30, tzinfo=timezone.utc)),  # plan C3, US summer
        ("2026-10-30", datetime(2026, 10, 30, 13, 30, tzinfo=timezone.utc)),  # last session before DST ends (Nov 1)
        ("2026-11-02", datetime(2026, 11, 2, 14, 30, tzinfo=timezone.utc)),  # first session after
        ("2026-03-06", datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)),  # last session before DST starts (Mar 8)
        ("2026-03-09", datetime(2026, 3, 9, 13, 30, tzinfo=timezone.utc)),  # first session after
        ("2026-11-27", datetime(2026, 11, 27, 14, 30, tzinfo=timezone.utc)),  # a half day opens at 09:30 too
    ],
)
def test_session_open_utc(d, expected):
    got = dates.session_open_utc(D(d))
    assert got == expected
    assert got.tzinfo == timezone.utc


def test_session_open_utc_refuses_a_day_with_no_session():
    with pytest.raises(ValueError, match="not an NYSE session"):
        dates.session_open_utc(D("2026-11-07"))  # a Saturday
    with pytest.raises(ValueError, match="not an NYSE session"):
        dates.session_open_utc(D("2026-11-26"))  # Thanksgiving
    with pytest.raises(TypeError):
        dates.session_open_utc(datetime(2026, 11, 4, tzinfo=timezone.utc))


def test_session_open_utc_is_the_calendars_open_on_every_session():
    """The wall-clock rule mcp-notes mirrors (09:30 New York) is the NYSE calendar's own open."""
    sched = dates._calendar().schedule(start_date="2026-01-01", end_date="2027-12-31")
    assert len(sched) > 500
    for idx, opened in zip(sched.index, sched["market_open"]):
        assert dates.session_open_utc(idx.date()) == opened.to_pydatetime().astimezone(timezone.utc), idx.date()
```
**Impact:** test-only. `test_dates.py` already imports `datetime`, `timezone`, `pytest`, `dates` and `D`.

### Step 3: `A-GT` on the roster
**File:** `engine/src/seer_engine/paper/roster.py:216` (constant) and `:1241` (SEED_ROWS row)
**Change:** state the new id and the seed row. No RESOLVER entry and no EVIDENCE entry: `A-GT` reuses
`STRATEGY_A` (`roster.py:560`) and `strategy_a_evidence` (`strategies/evidence.py:862`). The Gotrade
preset is chosen the way C-GT's is, by `rules_id = BRACKET_GOTRADE_RULES_ID` (`roster.py:221`), which
`rules_for` turns into the `design-v0-gotrade` preset (cadence daily, 4 positions, 5-day time stop,
`cost_model="gotrade"`). The funding plan is in its spec because `A-GT` is not in the closed
`PRE_FUNDING_IDS`. Its digest was computed by building this exact row through `from_row` on the
worktree base without editing any file: `3db8862e29948b3cad007e404c0b1c59d79b1a9f7bdcc4d3a5eb043a42d4080d`.
Display fields are not in the spec, so the digest depends only on id, engine, object, rules, params,
initial_idr and funding. If `test_digests_are_pinned` disagrees, recompute with
`roster.spec_digest(roster.spec(roster.entry("A-GT")))` and pin that. Never change any other pin to make
it pass.
**Code:** insert after line 216 (`MOM70_GT_ID = "MOM70-FR-GT"`):
```python

# 027 (owner, 2026-11-05, Seer Adversarial): plain Strategy A back on paper at Gotrade's real fees, the
# baseline that C-GT and the Claude twins are compared against. The object is STRATEGY_A, unchanged; the
# rule set is the one C-GT trades (design-v0-gotrade). A NEW ID and not a revived A: A is frozen under
# design-v0's flat 0.1% a side, and moving its fees would move its pinned digest.
A_GT_ID = "A-GT"
```
and insert at line 1241, after the closing `),` of the `RAW35_GT_ID` row and before the comment
`# 024, the momentum blend (owner, 2026-10-31). ...`:
```python
    # 027 (owner, 2026-11-05): plain A, back as the baseline of the three-way comparison A / C / A with
    # Claude's objections. It takes sort 5, which 026 vacated. Not a lab entry (A predates the lab), so
    # it has no LAB_PROVENANCE line, and its gate applies and failed -- the row says so.
    RosterRow(
        id=A_GT_ID,
        name="A · Dip buy",
        sub="Buys a sharp short drop in a stock above its 200-day average, sells within 5 days, daily, real Gotrade fees",
        icon="sigma",
        is_champion=False,
        is_benchmark=False,
        sort=5,
        engine="bracket",
        rules_id=BRACKET_GOTRADE_RULES_ID,
        object_name="STRATEGY_A",
        registry_id=None,
        gate_note=(
            "Plain Strategy A, back on paper (owner, 2026-11-05) as the baseline that C-GT and the "
            "Claude twins are compared against: the same rule, the same 4 slots and 5-day brackets, "
            "and the same starting capital, monthly deposits and Gotrade fees as C-GT, with no news "
            "check. It is not a candidate for real money: its backtest gate failed out of sample "
            "(2022-01-03..2026-10-02), -15.0% vs SPY TR +71.9%, PF 0.92, max DD 33.3%, which is why "
            "013 retired the whole-share A"
        ),
    ),
```
**Impact:** `ROSTER`, `ROSTER_IDS` (24 entries), `active()` gains `A-GT` at position 5. `news_veto()` is
unchanged because STRATEGY_A is not a `NewsVeto`. `MAX_LOOKBACK_BARS` stays 781 (A reads 200). `explain`
will also explain A-GT's pending orders, so the paid Explain step makes at most 4 more calls a night (see
Risks).

### Step 4: The pure candidate module
**File:** `engine/src/seer_engine/paper/candidates.py` (new)
**Change:** the pure half of the candidate list. `tests/test_strategy_purity.py` globs `paper/*.py`, so it
is purity-checked automatically. It imports only `dates`, `sim`, `strategies` (the same set `paper/book.py`
and `paper/roster.py` already import).
**Code:**
```python
"""The decisions Seer hands to Claude for review, and when a book next ranks (Seer Adversarial, 027).

Claude reviews a roster method's picks before the session they are for opens and says agree,
object or can't tell (the reviewer lives in the owner's notes daemon, mcp-notes, and reads
Seer's database). It cannot re-run Seer's methods and must not try: a second implementation of a
ranking is a second ranking. So the paper night writes down, beside each decision it takes, what
the method ranked, in ``strategy_candidates``; this module is the pure half of that.

- :func:`bracket_candidates`: a bracket method's OWN ranked picks for ``next_session(data_date)``,
  the first :data:`CANDIDATE_TOP`, **before any news veto**. For C (a ``NewsVeto``) that is
  ``strategies.c.candidates`` -- A's ranking cut to C's own ``max_candidates``, the very list
  ``veto`` checks -- and never the allowed subset: a reviewer shown only what C let through could
  not be compared with C on the nights the two disagree. For every other bracket object it is
  ``obj.picks``. It is computed BESIDE the decision, never instead of it: ``decide_bracket`` is
  called exactly as before, so a list can never move a trade.
- :func:`book_candidates`: the targets of a book's rank or kickoff decision, the rule set's idle
  instrument dropped (it is the runner's residual, not a pick), ranked by weight, largest first,
  then symbol. A resize-only decision is never listed (plan D3): it re-scales a basket already
  reviewed at its rank, and an objection takes effect at the next rank.
- :func:`next_rank_session`: the next session on which a book will choose a new basket, so the
  reviewer can look early at a monthly book from its nightly preview without porting Seer's
  cadence rules.

Pure (tests/test_strategy_purity.py globs ``paper/*.py``): no database, clock, logging or I/O.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence, Set
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from seer_engine import dates
from seer_engine.sim.book import Target
from seer_engine.sim.rules import TradeRules, is_rank_session
from seer_engine.strategies.base import History, Strategy
from seer_engine.strategies.c import NewsVeto
from seer_engine.strategies.c import candidates as c_candidates

#: How many of a bracket method's ranked picks are listed: C's own ``max_candidates``, so A's list
#: and C's list are the same length and the three-way comparison lines up rank for rank.
CANDIDATE_TOP = 10

#: How far :func:`next_rank_session` looks: a year of sessions, more than any cadence's gap.
RANK_SCAN_SESSIONS = 260


@dataclass(frozen=True, slots=True)
class Candidate:
    """One listed pick: its place in the method's ranking and, for a book, its target weight."""

    rank: int
    symbol: str
    weight: Decimal | None = None

    def __post_init__(self) -> None:
        if isinstance(self.rank, bool) or not isinstance(self.rank, int):
            raise TypeError(f"rank must be an int, got {type(self.rank).__name__}")
        if self.rank < 1:
            raise ValueError(f"rank must be >= 1, got {self.rank}")
        if not isinstance(self.symbol, str) or not self.symbol:
            raise ValueError(f"symbol must be a non-empty str, got {self.symbol!r}")
        if self.weight is not None:
            if not isinstance(self.weight, Decimal):
                raise TypeError(f"{self.symbol}: weight must be a Decimal, got {type(self.weight).__name__}")
            if not self.weight.is_finite() or self.weight <= 0:
                raise ValueError(f"{self.symbol}: weight must be a positive finite Decimal, got {self.weight!r}")


def bracket_candidates(
    obj: Strategy,
    params: Any,
    history: Mapping[str, History],
    members: Set[str],
    data_date: date,
    *,
    top: int = CANDIDATE_TOP,
) -> tuple[Candidate, ...]:
    """The first ``top`` of ``obj``'s own ranked picks on ``data_date`` (for its next session).

    ``history`` is cut at ``data_date`` here, as ``paper.bracket.decide_bracket`` cuts it, so
    nothing dated after the night is read. A ``NewsVeto`` lists the candidates its check reviews
    (A's ranking), not the ones it allowed. A symbol ranked twice is listed once, at its first rank.
    """
    if isinstance(top, bool) or not isinstance(top, int) or top < 1:
        raise ValueError(f"top must be a positive int, got {top!r}")
    cut = {s: h.upto(data_date) for s, h in history.items()}
    if isinstance(obj, NewsVeto):
        picks = c_candidates(cut, members, data_date, params)
    else:
        picks = obj.picks(cut, members, data_date, params)
    out: list[Candidate] = []
    seen: set[str] = set()
    for p in picks:
        if p.symbol in seen:
            continue
        seen.add(p.symbol)
        out.append(Candidate(rank=len(out) + 1, symbol=p.symbol))
        if len(out) == top:
            break
    return tuple(out)


def book_candidates(targets: Sequence[Target], idle_symbol: str | None) -> tuple[Candidate, ...]:
    """A rank or kickoff decision's targets as a ranked list: ``idle_symbol`` dropped, the rest by
    weight (largest first), then symbol. Empty when the decision holds nothing but the idle row.

    ValueError when a symbol is targeted twice (that is not a book decision).
    """
    if isinstance(targets, (str, Mapping)) or not isinstance(targets, Sequence):
        raise TypeError(f"targets must be a sequence of Target, got {type(targets).__name__}")
    rows: list[Target] = []
    seen: set[str] = set()
    for t in targets:
        if not isinstance(t, Target):
            raise TypeError(f"targets holds Targets, got {type(t).__name__}")
        if idle_symbol is not None and t.symbol == idle_symbol:
            continue
        if t.symbol in seen:
            raise ValueError(f"{t.symbol} is targeted twice; not a book decision")
        seen.add(t.symbol)
        rows.append(t)
    ranked = sorted(rows, key=lambda t: (-t.weight, t.symbol))
    return tuple(Candidate(rank=i, symbol=t.symbol, weight=t.weight) for i, t in enumerate(ranked, start=1))


def next_rank_session(rules: TradeRules, data_date: date, *, kickoff: bool) -> date | None:
    """The next session after ``data_date`` on which a book under ``rules`` chooses a new basket.

    ``kickoff`` says tonight's decision (for ``next_session(data_date)``) is the book's kickoff,
    a rank taken off the cadence (``paper.book.needs_kickoff``): then that session is the answer.
    Otherwise the first ``is_rank_session`` session after ``data_date``; a resize-only session is
    never one. None when no rank session falls within :data:`RANK_SCAN_SESSIONS` sessions.
    """
    nxt = dates.next_session(data_date)
    if kickoff:
        return nxt
    d = nxt
    for _ in range(RANK_SCAN_SESSIONS):
        if is_rank_session(rules, d):
            return d
        d = dates.next_session(d)
    return None
```
**Impact:** new module; nothing imports it until Step 6.

### Step 5: Store functions
**File:** `engine/src/seer_engine/paper/store.py`
**Change (a):** module docstring, insert after the Evidence bullet (after line 31, the line ending
`compares it, and ``explain`` / the site read it with their own SQL.`):
```python
- Seer Adversarial (migration 027): ``strategy_candidates``, the ranked list each reviewable
  decision is written down with (``save_candidates`` / ``read_candidates``, rewritten only when it
  changes); ``book_previews.next_decision_session``; and ``is_twin``, the one read of
  ``strategies.twin_of`` the night needs. The three ``adversary_*`` tables are mcp-notes' to write;
  nothing here writes them.
```
**Change (b):** import, after line 52 (`from seer_engine.paper.benchmark import BenchmarkState`):
```python
from seer_engine.paper.candidates import Candidate
```
**Change (c):** after `read_strategy` (insert after line 255):
```python
def is_twin(conn: psycopg.Connection, strategy_id: str) -> bool:
    """True when ``strategy_id`` is a Claude twin (``strategies.twin_of`` set, migration 027).

    A twin's decisions are its original's minus Claude's objections; reviewing them again would
    review the review, so the night writes no candidate list for one. StoreError for no row.
    """
    row = conn.execute("SELECT twin_of FROM strategies WHERE id = %s", (strategy_id,)).fetchone()
    if row is None:
        raise StoreError(f"no strategies row {strategy_id!r}")
    return row[0] is not None
```
**Change (d):** replace `save_book_preview` (lines 728-766) with:
```python
def save_book_preview(
    conn: psycopg.Connection,
    strategy_id: str,
    data_date: date,
    targets: Sequence[Target] | None,
    *,
    evidence: Mapping[str, Sequence[str]] | None = None,
    next_decision_session: date | None = None,
) -> None:
    """Replace the strategy's ``book_previews`` with ``targets``, what it would pick from the bars
    of ``data_date`` if it ranked tonight. Display only (008). None or empty leaves no rows.

    ``evidence``: ``{symbol: facts}`` (009); each row stores its symbol's facts, or NULL when the
    symbol is absent (the idle instrument, one the method could not explain) or ``evidence`` is
    None.

    ``next_decision_session`` (027): the next session on which the book will rank
    (``paper.candidates.next_rank_session``), stored on every row so the reviewer can look early at
    the decision this preview anticipates. None stores NULL. It must be a session after
    ``data_date``."""
    _session("data_date", data_date)
    if next_decision_session is not None:
        _session("next_decision_session", next_decision_session)
        if next_decision_session <= data_date:
            raise ValueError(
                f"{strategy_id}: next_decision_session {next_decision_session} is not after the "
                f"preview's data_date {data_date}"
            )
    conn.execute("DELETE FROM book_previews WHERE strategy_id = %s", (strategy_id,))
    rows: list[tuple[Any, ...]] = []
    for rank, t in enumerate(targets or (), start=1):
        if not isinstance(t, Target):
            raise TypeError(f"targets must hold Target values, got {type(t).__name__}")
        rows.append(
            (
                strategy_id,
                data_date,
                rank,
                t.symbol,
                _exact("weight", t.weight, WEIGHT_QUANTUM),
                _exact("last", t.last),
                _evidence_json(evidence, t.symbol),
                next_decision_session,
            )
        )
    if rows:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO book_previews "
                "(strategy_id, data_date, rank, symbol, weight, last, evidence, next_decision_session) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                rows,
            )


# --------------------------------------------------------------------------- candidates (027)

#: ``strategy_candidates.kind``'s CHECK, as a Python value.
CANDIDATE_KINDS: tuple[str, ...] = ("bracket", "book")


def save_candidates(
    conn: psycopg.Connection,
    strategy_id: str,
    session_date: date,
    data_date: date,
    kind: str,
    items: Sequence[Candidate],
    *,
    evidence: Mapping[str, Sequence[str]] | None = None,
) -> bool:
    """Write ``items`` as the ranked list of ``strategy_id``'s decision for ``session_date``.

    ``data_date`` is the night that decided it and must be ``prev_session(session_date)``.
    ``kind`` is ``'bracket'`` (every weight None) or ``'book'`` (every weight a target weight,
    exact at ``WEIGHT_QUANTUM``). Ranks must run 1..n in order and symbols must be unique.
    ``evidence`` is stored per symbol as on ``orders`` (009).

    Returns False and writes nothing when the stored list already equals this one (kind,
    data_date, rank, symbol, weight and evidence), so a re-run night, a catch-up and a repick
    that changes nothing leave the rows and their ``created_at`` alone; otherwise replaces the
    whole list for ``(strategy_id, session_date)`` and returns True. Empty ``items`` clears it.
    """
    _session("session_date", session_date)
    _session("data_date", data_date)
    if dates.next_session(data_date) != session_date:
        raise ValueError(
            f"{strategy_id}: the decision for {session_date} is taken on the night of "
            f"{dates.prev_session(session_date)}, not {data_date}"
        )
    if kind not in CANDIDATE_KINDS:
        raise ValueError(f"{strategy_id}: candidate kind {kind!r} is not one of {CANDIDATE_KINDS}")
    rows: list[tuple[Any, ...]] = []
    wanted: list[tuple[Any, ...]] = []
    seen: set[str] = set()
    for position, c in enumerate(items, start=1):
        if not isinstance(c, Candidate):
            raise TypeError(f"items must hold Candidate values, got {type(c).__name__}")
        if c.rank != position:
            raise ValueError(
                f"{strategy_id} {session_date}: candidate ranks must run 1..n in order; rank "
                f"{c.rank} is at position {position}"
            )
        if c.symbol in seen:
            raise ValueError(f"{strategy_id} {session_date}: {c.symbol} is listed twice")
        seen.add(c.symbol)
        if kind == "bracket":
            if c.weight is not None:
                raise ValueError(f"{strategy_id} {session_date}: a bracket candidate carries no weight")
            weight = None
        else:
            if c.weight is None:
                raise ValueError(f"{strategy_id} {session_date}: a book candidate needs its target weight")
            weight = _exact("weight", c.weight, WEIGHT_QUANTUM)
        facts = _evidence_json(evidence, c.symbol)
        rows.append((strategy_id, session_date, data_date, kind, c.rank, c.symbol, weight, facts))
        wanted.append((kind, data_date, c.rank, c.symbol, weight, None if facts is None else facts.obj))
    stored = conn.execute(
        "SELECT kind, data_date, rank, symbol, weight, evidence FROM strategy_candidates "
        "WHERE strategy_id = %s AND session_date = %s ORDER BY rank",
        (strategy_id, session_date),
    ).fetchall()
    if [tuple(r) for r in stored] == wanted:
        return False
    conn.execute(
        "DELETE FROM strategy_candidates WHERE strategy_id = %s AND session_date = %s",
        (strategy_id, session_date),
    )
    if rows:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO strategy_candidates "
                "(strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                rows,
            )
    return True


def read_candidates(conn: psycopg.Connection, strategy_id: str, session_date: date) -> tuple[Candidate, ...]:
    """The list stored for ``strategy_id``'s decision for ``session_date``, by rank (empty when none)."""
    _date("session_date", session_date)
    rows = conn.execute(
        "SELECT rank, symbol, weight FROM strategy_candidates "
        "WHERE strategy_id = %s AND session_date = %s ORDER BY rank",
        (strategy_id, session_date),
    ).fetchall()
    return tuple(Candidate(rank=int(r[0]), symbol=r[1], weight=r[2]) for r in rows)
```
**Impact:** `save_book_preview` keeps its old behaviour for every caller that does not pass the new
keyword. `paper.candidates` is pure and imports nothing from `store`, so there is no import cycle.

### Step 6: The night writes the lists
**File:** `engine/src/seer_engine/commands/paper.py`

**Change (a):** module docstring, insert after the Evidence paragraph (after line 46, `... the night goes
on.`) and before `Split-cadence rules ...`:
```python
Candidates (migration 027, Seer Adversarial): beside every decision a reviewable entry takes --
active, not a benchmark, not a Claude twin (``store.is_twin``) -- the night writes the ranked list
Claude reviews into ``strategy_candidates`` (``paper.candidates``). A bracket entry lists its own
top 10 for the session it decides, before any news veto (C's list is A's ranking, what ``veto``
checks). A book lists the targets of a rank or kickoff decision, never of a resize-only one. Every
book preview also stores ``next_decision_session``, the next session it ranks. Like evidence, a
list never changes a decision and never fails the night: one that cannot be computed logs a warning
and leaves that decision's list as it was. A database error on the write fails the night like any
other write. The list is rewritten only when it changes (``store.save_candidates``).
```
**Change (b):** import, line 77 `from seer_engine.paper import roster, store, unavailable` becomes:
```python
from seer_engine.paper import candidates, roster, store, unavailable
```
**Change (c):** new helpers, inserted after `_evidence` (after line 675) and before `_resize_only`:
```python
def _reviewable(conn: psycopg.Connection, e: RosterEntry) -> bool:
    """True when the night writes ``e``'s decisions down for Claude's review (027).

    Bracket and book entries that are not benchmarks and not Claude twins. Read from the row
    (``strategies.twin_of``), never from a list of ids: Sera admits and retires methods, and the
    one rule that holds for all of them is the column.
    """
    if e.is_benchmark or e.engine not in ("bracket", "book"):
        return False
    return not store.is_twin(conn, e.id)


def _save_bracket_candidates(conn: psycopg.Connection, e: RosterEntry, view: Market, data_date: date) -> None:
    """Write bracket entry ``e``'s ranked top 10 for ``next_session(data_date)`` on ``view``.

    Computed beside the decision, never feeding it. A list that cannot be computed logs one
    warning and leaves the stored list as it was; the night goes on (the evidence rule).
    """
    session = dates.next_session(data_date)
    try:
        found = candidates.bracket_candidates(
            e.obj, e.params, view.history, view.membership.members_on(data_date), data_date
        )
    except Exception as exc:  # noqa: BLE001 - a candidate list must never fail the night
        log.warning(
            "%s %s: no candidate list stored tonight (%s); the decision is unchanged",
            e.id,
            session,
            _error_text(exc),
        )
        return
    facts = _evidence(e, view, data_date, (c.symbol for c in found))
    store.save_candidates(conn, e.id, session, data_date, "bracket", found, evidence=facts)


def _save_book_candidates(
    conn: psycopg.Connection,
    e: RosterEntry,
    session: date,
    data_date: date,
    targets: Sequence[Target],
    facts: Mapping[str, Facts] | None,
) -> None:
    """Write book entry ``e``'s rank or kickoff ``targets`` for ``session`` as its ranked list.

    The caller decides that the decision is a rank or a kickoff (never resize-only). ``facts`` is
    the evidence already computed for those targets. Same failure rule as the bracket list.
    """
    try:
        found = candidates.book_candidates(targets, e.rules.idle_symbol)
    except Exception as exc:  # noqa: BLE001 - a candidate list must never fail the night
        log.warning(
            "%s %s: no candidate list stored tonight (%s); the decision is unchanged",
            e.id,
            session,
            _error_text(exc),
        )
        return
    store.save_candidates(conn, e.id, session, data_date, "book", found, evidence=facts)
```
**Change (d):** replace `repick` (lines 476-583) with:
```python
def repick(
    conn: psycopg.Connection,
    entries: Sequence[RosterEntry],
    starts: Mapping[str, date | None],
    tonight: _Tonight | None = None,
) -> list[str]:
    """Re-take every waiting decision the not-offered list (014) changes; returns the ids rewritten.

    A listed stock leaves the membership (``store.load_market_window``), and that moves more than
    the decisions holding it: a method that scores stocks against the whole universe ranks the
    rest differently too. So every pending decision taken on bars a listing covers is taken again
    exactly as the night took it -- same bars (``state.last_session``), same settled book, same
    kickoff and split-cadence inputs -- and rewritten only when the result differs from the stored
    one. That is what the replay check computes from the same market, so the two agree, and a
    second run (or the paper night that follows) writes nothing. Only pending decisions are
    touched: nothing that has traded is rewritten.

    A resize-only decision is left alone: it re-scales the basket its last rank chose and cannot
    swap a stock, so a listed stock leaves that book at its next rank.

    The candidate list of a re-taken decision (027) is re-taken with it, so Claude reviews the
    list the decision now stands on; ``store.save_candidates`` writes it only when it changed.
    """
    windows = store.read_unavailable(conn)
    if not windows:
        return []
    todo: list[tuple[RosterEntry, PaperState]] = []
    for e in entries:
        if e.engine not in ("book", "bracket"):
            continue
        state = store.read_paper_state(conn, e.id)
        if state is None or state.pending_session is None:
            continue
        if unavailable.excluded_on(windows, state.last_session):
            todo.append((e, state))
    if not todo:
        return []
    if tonight is None:
        earliest = min(state.last_session for _, state in todo)
        through = max(state.last_session for _, state in todo)
        tonight = _load_tonight(conn, store.market_window_since(earliest), earliest, through)
    done: list[str] = []
    for e, state in todo:
        d, p = state.last_session, state.pending_session
        assert p is not None
        view = tonight.view(d)
        if e.engine == "book":
            if not state.pending_decision:
                continue
            paper_start = starts.get(e.id)
            if paper_start is None:
                raise PaperError(f"strategy {e.id!r} has a pending decision but no paper_start")
            rules = e.rules
            book = store.load_book(conn, e.id, idle_symbol=rules.idle_symbol).book
            kicked = None if state.kickoff_session == p else state.kickoff_session
            kickoff = needs_kickoff(rules, paper_start, p, kicked)
            if _resize_only(rules, p, kickoff):
                continue
            if rules.resize_cadence is None:
                targets, _ = decide_book(view, e.obj, e.params, rules, d, book.held(), force=kickoff)
            else:
                last_rank, marks = _split_inputs(conn, e.id, rules, paper_start, kicked, p, book.positions)
                targets, _ = decide_book(
                    view, e.obj, e.params, rules, d, book.held(), force=kickoff, last_rank=last_rank, marks=marks
                )
            old = store.read_book_targets(conn, e.id, p)
            if _book_key(targets) == _book_key(old):
                continue
            facts = None if targets is None else _evidence(e, view, d, (t.symbol for t in targets))
            store.save_book_decision(conn, e.id, p, targets, evidence=facts)
            if targets is not None and _reviewable(conn, e):
                _save_book_candidates(conn, e, p, d, targets, facts)
            preview, preview_facts = targets, facts
            if preview is None:
                preview, _ = decide_book(view, e.obj, e.params, rules, d, book.held(), force=True)
                preview_facts = None if preview is None else _evidence(e, view, d, (t.symbol for t in preview))
            store.save_book_preview(
                conn,
                e.id,
                d,
                preview,
                evidence=preview_facts,
                next_decision_session=candidates.next_rank_session(rules, d, kickoff=kickoff),
            )
            before, after = [t.symbol for t in old], [t.symbol for t in targets or ()]
        else:
            pf = store.load_portfolio(conn, e.id)
            waiting = [o for o in pf.orders if o.status == "pending" and o.session_date == p]
            pf = replace(pf, orders=tuple(o for o in pf.orders if o not in waiting))
            sized = decide_bracket(
                pf,
                _bracket_strategy(conn, e, p, p),
                e.params,
                view.history,
                view.membership.members_on(d),
                d,
                rules=e.rules,
            )
            # The list moves with the membership even when the orders do not (a listed stock
            # ranked 7th changes no order but leaves the list); it is written only if it changed.
            if _reviewable(conn, e):
                _save_bracket_candidates(conn, e, view, d)
            if _order_key(sized.placed) == _order_key(waiting):
                continue
            conn.execute(
                "DELETE FROM orders WHERE strategy_id = %s AND session_date = %s AND status = 'pending'", (e.id, p)
            )
            facts = _evidence(e, view, d, (o.symbol for o in sized.placed))
            store.insert_pending_orders(conn, e.id, sized.placed, evidence=facts)
            store.write_pending(conn, e.id, p, decision=False)
            before, after = [o.symbol for o in waiting], [o.symbol for o in sized.placed]
        log.info(
            "%s: re-took the decision for %s after the not-offered list changed: out %s, in %s",
            e.id,
            p,
            ", ".join(x for x in before if x not in after) or "-",
            ", ".join(x for x in after if x not in before) or "-",
        )
        done.append(e.id)
    return done
```
**Change (e):** replace `_start` (lines 721-799) with:
```python
def _start(conn: psycopg.Connection, e: RosterEntry, rd: dates.RunDates, tonight: _Tonight) -> None:
    """Start ``e`` tonight.

    ``store.freeze_spec`` writes the frozen spec (C2) and ``paper_start = rd.session_date``;
    ``store.init_paper_state`` writes ``paper_state`` and the day-0 snapshot at
    ``prev_session(paper_start)`` (= ``rd.data_date``); then the decision for ``paper_start`` is
    written and ``paper_state.pending_session`` set to it (every engine, SPY included).

    A split-cadence book (``e.rules.resize_cadence``) gets ``last_rank`` and ``marks`` from
    ``_split_inputs``: at the start there is no rank yet and nothing is held, so they are None and
    ``{}``, and the first decision is a rank (``paper_start`` is a rank session or the kickoff).

    A reviewable entry (027) also writes the first decision's candidate list, and a book's preview
    names its next rank session.
    """
    if _has_paper_rows(conn, e.id):
        raise PaperError(
            f"strategy {e.id!r} has no paper_state but has paper rows; reset its paper clock "
            f"(paper runbook) before it can start"
        )
    view = tonight.view(rd.data_date)
    try:
        usd_idr = view.usd_idr_on(rd.data_date)
    except ValueError as exc:
        raise PaperError(f"no USD/IDR rate on or before {rd.data_date}; cannot start {e.id!r}") from exc
    cash0 = initial_cash_usd(PAPER_INITIAL_IDR, usd_idr)
    paper_start = rd.session_date
    reviewable = _reviewable(conn, e)

    frozen = roster.strategy_params(e)
    store.freeze_spec(
        conn,
        e.id,
        spec=frozen["spec"],
        digest=frozen["digest"],
        backtest_gate=frozen["backtest_gate"],
        paper_start=paper_start,
    )
    store.init_paper_state(conn, e.id, paper_start=paper_start, cash0=cash0, usd_idr=usd_idr)

    if e.engine == "bracket":
        sized = decide_bracket(
            new_portfolio(cash0),
            _bracket_strategy(conn, e, paper_start, paper_start),
            e.params,
            view.history,
            view.membership.members_on(rd.data_date),
            rd.data_date,
            rules=e.rules,
        )
        facts = _evidence(e, view, rd.data_date, (o.symbol for o in sized.placed))
        store.insert_pending_orders(conn, e.id, sized.placed, evidence=facts)
        store.write_pending(conn, e.id, paper_start, decision=False)
        if reviewable:
            _save_bracket_candidates(conn, e, view, rd.data_date)
    elif e.engine == "book":
        kickoff = needs_kickoff(e.rules, paper_start, paper_start, None)
        if e.rules.resize_cadence is None:
            targets, _ = decide_book(view, e.obj, e.params, e.rules, rd.data_date, frozenset(), force=kickoff)
        else:
            last_rank, marks = _split_inputs(conn, e.id, e.rules, paper_start, None, paper_start, ())
            targets, _ = decide_book(
                view,
                e.obj,
                e.params,
                e.rules,
                rd.data_date,
                frozenset(),
                force=kickoff,
                last_rank=last_rank,
                marks=marks,
            )
        if targets is None or _resize_only(e.rules, paper_start, kickoff):
            facts = None
        else:
            facts = _evidence(e, view, rd.data_date, (t.symbol for t in targets))
        store.save_book_decision(conn, e.id, paper_start, targets, evidence=facts)
        if reviewable and targets is not None and not _resize_only(e.rules, paper_start, kickoff):
            _save_book_candidates(conn, e, paper_start, rd.data_date, targets, facts)
        if kickoff:
            store.write_kickoff(conn, e.id, paper_start)
        store.save_book_preview(
            conn,
            e.id,
            rd.data_date,
            targets,
            evidence=facts,
            next_decision_session=candidates.next_rank_session(e.rules, rd.data_date, kickoff=kickoff),
        )
    elif e.engine == "benchmark":
        store.write_pending(conn, e.id, paper_start, decision=False)
    else:
        raise PaperError(f"strategy {e.id!r} has unknown engine {e.engine!r}")
    log.info("%s: paper starts %s with %s USD (USD/IDR %s)", e.id, paper_start, cash0, usd_idr)
```
**Change (f):** replace `_step_bracket` (lines 802-836) with:
```python
def _step_bracket(conn: psycopg.Connection, e: RosterEntry, sessions: Sequence[date], tonight: _Tonight) -> None:
    pf = store.load_portfolio(conn, e.id)
    if not sessions:
        return
    strategy = _bracket_strategy(conn, e, dates.next_session(sessions[0]), dates.next_session(sessions[-1]))
    reviewable = _reviewable(conn, e)
    for s in sessions:
        view = tonight.view(s)
        # Cash AND equity: sizing reads the last snapshot's equity (sim/sizing.py), so a deposit
        # credited to cash alone would sit in the book permanently under-deployed.
        credited = store.apply_contributions(conn, e.id, s)
        if credited:
            pf = replace(pf, cash=pf.cash + credited, equity=pf.equity + credited)
        night = settle_bracket(
            pf,
            s,
            view.bars_on(s, pf.held_symbols()),
            tonight.splits_on(s),
            view.last_bar_date,
            rules=e.rules,
        )
        store.save_bracket_night(conn, e.id, night.portfolio, night.events, night.snapshot)
        sized = decide_bracket(
            night.portfolio,
            strategy,
            e.params,
            view.history,
            view.membership.members_on(s),
            s,
            rules=e.rules,
        )
        facts = _evidence(e, view, s, (o.symbol for o in sized.placed))
        store.insert_pending_orders(conn, e.id, sized.placed, evidence=facts)
        store.write_pending(conn, e.id, dates.next_session(s), decision=False)
        if reviewable:
            # What it ranked for next_session(s), before any veto: what Claude reviews (027).
            _save_bracket_candidates(conn, e, view, s)
        pf = sized.portfolio
        log.info("%s %s: equity %s, %d live order(s)", e.id, s, pf.equity, len(pf.orders))
```
**Change (g):** replace `_step_book` (lines 839-919) with:
```python
def _step_book(
    conn: psycopg.Connection,
    e: RosterEntry,
    sessions: Sequence[date],
    tonight: _Tonight,
    state: PaperState,
    paper_start: date,
) -> None:
    rules = e.rules
    loaded = store.load_book(conn, e.id, idle_symbol=rules.idle_symbol)
    book, targets, idle_added = loaded.book, loaded.targets, loaded.idle_added
    kicked = state.kickoff_session
    reviewable = _reviewable(conn, e)
    for s in sessions:
        view = tonight.view(s)
        # deposit_book raises cash and equity together (phase 6): sim/book.py sizes from equity.
        credited = store.apply_contributions(conn, e.id, s)
        if credited:
            book = deposit_book(book, credited)
        symbols = set(book.held())
        if targets is not None:
            symbols.update(t.symbol for t in targets)
        night = settle_book(
            book,
            s,
            view.bars_on(s, sorted(symbols)),
            targets,
            idle_added,
            rules,
            tonight.dividends_on(s),
            tonight.splits_on(s),
            view.last_bar_date,
        )
        store.save_book_night(
            conn, e.id, night.book, night.fills, night.trades, night.snapshot, executed_targets=night.targets
        )
        book = night.book
        nxt = dates.next_session(s)
        # A book that has never decided ranks on its first session instead of waiting for its
        # cadence (008, paper.book.needs_kickoff); the replay ranks on the stored kickoff too.
        kickoff = needs_kickoff(rules, paper_start, nxt, kicked)
        if rules.resize_cadence is None:
            targets, idle_added = decide_book(view, e.obj, e.params, rules, s, book.held(), force=kickoff)
        else:
            # Split cadences: a resize-only session re-scales the LAST RANK SESSION'S basket, read
            # back from book_targets in this transaction, at the settled book's marks.
            last_rank, marks = _split_inputs(conn, e.id, rules, paper_start, kicked, nxt, book.positions)
            targets, idle_added = decide_book(
                view,
                e.obj,
                e.params,
                rules,
                s,
                book.held(),
                force=kickoff,
                last_rank=last_rank,
                marks=marks,
            )
        # A resize-only decision opens no position, so it has nothing to explain.
        if targets is None or _resize_only(rules, nxt, kickoff):
            facts = None
        else:
            facts = _evidence(e, view, s, (t.symbol for t in targets))
        store.save_book_decision(conn, e.id, nxt, targets, evidence=facts)
        if reviewable and targets is not None and not _resize_only(rules, nxt, kickoff):
            # A rank or kickoff decision: its targets are what Claude reviews (027). A resize-only
            # one re-scales a basket already reviewed at its rank, so it is not listed (plan D3).
            _save_book_candidates(conn, e, nxt, s, targets, facts)
        if kickoff:
            store.write_kickoff(conn, e.id, nxt)
            kicked = nxt
        if s == sessions[-1]:
            # What it would pick if it ranked tonight: display only, never traded or replayed.
            preview, preview_facts = targets, facts
            if preview is None:
                preview, _ = decide_book(view, e.obj, e.params, rules, s, book.held(), force=True)
                preview_facts = None if preview is None else _evidence(e, view, s, (t.symbol for t in preview))
            store.save_book_preview(
                conn,
                e.id,
                s,
                preview,
                evidence=preview_facts,
                next_decision_session=candidates.next_rank_session(rules, s, kickoff=kickoff),
            )
        log.info(
            "%s %s: equity %s, %d position(s)%s",
            e.id,
            s,
            book.equity,
            len(book.positions),
            f", {len(targets)} target(s) for {nxt}" if targets is not None else "",
        )
```
**Impact:** every decision is unchanged (the lists are computed beside it, and no decision input reads
them). New writes: `strategy_candidates` and `book_previews.next_decision_session`. The extra cost is
one more ranking call and one more evidence call per bracket session decided, plus a query per entry per
call site (`is_twin`).

### Step 7: Pure and store tests
**File:** `engine/tests/test_paper_candidates.py` (new)
**Code:**
```python
"""Seer Adversarial (027): the list each reviewable decision is written down with.

- ``paper.candidates`` (pure): a bracket method's own top 10 before any veto, a book's rank targets
  without the idle instrument, ranked by weight; the next session a book ranks.
- ``paper.store``: ``save_candidates`` validates, replaces, and writes nothing when nothing changed;
  ``read_candidates`` gives it back; ``is_twin`` reads ``strategies.twin_of``.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

import pytest

import test_paper_command as tp
from seer_engine.paper import store
from seer_engine.paper.candidates import (
    CANDIDATE_TOP,
    Candidate,
    book_candidates,
    bracket_candidates,
    next_rank_session,
)
from seer_engine.sim import Pick
from seer_engine.sim.book import Target
from seer_engine.sim.rules import MONTHLY_HOLD_FRAC, MONTHLY_RANK_WEEKLY_RESIZE_FRAC
from seer_engine.strategies.a import STRATEGY_A, STRATEGY_A_PARAMS
from seer_engine.strategies.base import history_from_bars
from seer_engine.strategies.c import STRATEGY_C, STRATEGY_C_PARAMS

SESSION = date(2026, 11, 4)
NIGHT = date(2026, 11, 3)  # prev_session(SESSION)


def pick(symbol: str) -> Pick:
    return Pick(symbol, Decimal("10"), Decimal("10"), Decimal("11"), Decimal("9"))


@dataclass(frozen=True, eq=False)
class Ranked:
    """A bracket strategy that ranks fixed symbols, in order, whatever the history."""

    symbols: tuple[str, ...]
    id: str = "RANKED"
    lookback: int = 1

    def picks(self, history, members, data_date, params):
        return [pick(s) for s in self.symbols]

    def prepare(self, history):
        return history

    def picks_prepared(self, prepared, members, data_date, params):
        return self.picks(prepared, members, data_date, params)


def synthetic_history():
    by_symbol = defaultdict(list)
    for b in tp.synthetic_bars():
        by_symbol[b.symbol].append(b)
    return {s: history_from_bars(s, sorted(v, key=lambda b: b.date)) for s, v in by_symbol.items()}


def target(symbol: str, weight: str) -> Target:
    return Target(symbol=symbol, weight=Decimal(weight), last=Decimal("10.0000"))


# ---- pure ----------------------------------------------------------------------------------------


def test_a_bracket_list_is_the_methods_own_ranking_cut_to_ten():
    symbols = tuple(f"S{i:02d}" for i in range(1, 13))
    found = bracket_candidates(Ranked(symbols), None, {}, frozenset(symbols), NIGHT)
    assert CANDIDATE_TOP == 10
    assert found == tuple(Candidate(rank=i, symbol=s) for i, s in enumerate(symbols[:10], start=1))
    assert all(c.weight is None for c in found)


def test_a_symbol_ranked_twice_is_listed_once_at_its_first_rank():
    found = bracket_candidates(Ranked(("X", "Y", "X", "Z")), None, {}, frozenset(), NIGHT)
    assert [(c.rank, c.symbol) for c in found] == [(1, "X"), (2, "Y"), (3, "Z")]


def test_c_lists_a_ranking_before_its_veto_and_a_lists_the_same():
    """On the synthetic world's first night A ranks COST then NVDA (measured 2026-11-05).
    C carries no verdict, so it would buy nothing, yet its list is A's ranking, not the allowed set."""
    history = synthetic_history()
    members = frozenset(tp.STOCKS)
    a = bracket_candidates(STRATEGY_A, STRATEGY_A_PARAMS, history, members, tp.N0)
    c = bracket_candidates(STRATEGY_C, STRATEGY_C_PARAMS, history, members, tp.N0)
    assert [x.symbol for x in a] == ["COST", "NVDA"]
    assert c == a
    assert STRATEGY_C.picks(history, members, tp.N0, STRATEGY_C_PARAMS) == []  # what C itself would buy


def test_a_bracket_list_reads_nothing_after_its_night():
    history = synthetic_history()
    members = frozenset(tp.STOCKS)
    cut = {s: h.upto(tp.N0) for s, h in history.items()}
    assert bracket_candidates(STRATEGY_A, STRATEGY_A_PARAMS, history, members, tp.N0) == bracket_candidates(
        STRATEGY_A, STRATEGY_A_PARAMS, cut, members, tp.N0
    )


def test_a_book_list_drops_the_idle_row_and_ranks_by_weight_then_symbol():
    found = book_candidates(
        [target("MSFT", "0.200000"), target("AAPL", "0.200000"), target("XOM", "0.400000"), target("BIL", "0.200000")],
        "BIL",
    )
    assert found == (
        Candidate(rank=1, symbol="XOM", weight=Decimal("0.400000")),
        Candidate(rank=2, symbol="AAPL", weight=Decimal("0.200000")),
        Candidate(rank=3, symbol="MSFT", weight=Decimal("0.200000")),
    )
    assert book_candidates([target("BIL", "1.000000")], "BIL") == ()
    assert book_candidates([], None) == ()
    with pytest.raises(ValueError, match="targeted twice"):
        book_candidates([target("X", "0.500000"), target("X", "0.500000")], None)


def test_the_next_rank_session_skips_resize_only_sessions_and_honours_a_kickoff():
    # monthly: the first session of October, then of November (2026-11-01 is a Sunday)
    assert next_rank_session(MONTHLY_HOLD_FRAC, date(2026, 9, 24), kickoff=False) == date(2026, 10, 1)
    assert next_rank_session(MONTHLY_HOLD_FRAC, date(2026, 9, 30), kickoff=False) == date(2026, 10, 1)
    assert next_rank_session(MONTHLY_HOLD_FRAC, date(2026, 10, 1), kickoff=False) == date(2026, 11, 2)
    # tonight's decision is the kickoff: that session ranks, off the cadence
    assert next_rank_session(MONTHLY_HOLD_FRAC, date(2026, 9, 23), kickoff=True) == date(2026, 9, 24)
    # monthly rank, weekly resize: Monday 2026-09-28 only re-scales, so it is not the answer
    assert next_rank_session(MONTHLY_RANK_WEEKLY_RESIZE_FRAC, date(2026, 9, 25), kickoff=False) == date(2026, 10, 1)


def test_a_candidate_refuses_a_bad_rank_symbol_or_weight():
    with pytest.raises(ValueError):
        Candidate(rank=0, symbol="X")
    with pytest.raises(TypeError):
        Candidate(rank=True, symbol="X")
    with pytest.raises(ValueError):
        Candidate(rank=1, symbol="")
    with pytest.raises(TypeError):
        Candidate(rank=1, symbol="X", weight=0.5)
    with pytest.raises(ValueError):
        Candidate(rank=1, symbol="X", weight=Decimal("0"))


# ---- store (027) -----------------------------------------------------------------------------------


def stored(pg, sid, session):
    return pg.execute(
        "SELECT kind, data_date, rank, symbol, weight, evidence, created_at FROM strategy_candidates "
        "WHERE strategy_id = %s AND session_date = %s ORDER BY rank",
        (sid, session),
    ).fetchall()


def test_save_candidates_round_trips_and_stores_evidence(pg):
    items = (Candidate(1, "NVDA"), Candidate(2, "COST"))
    facts = {"NVDA": ("It closed at $180.00.",)}
    assert store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", items, evidence=facts) is True
    assert store.read_candidates(pg, "A-GT", SESSION) == items
    rows = stored(pg, "A-GT", SESSION)
    assert [r[:6] for r in rows] == [
        ("bracket", NIGHT, 1, "NVDA", None, ["It closed at $180.00."]),
        ("bracket", NIGHT, 2, "COST", None, None),
    ]
    book = (Candidate(1, "XOM", Decimal("0.050000")), Candidate(2, "CVX", Decimal("0.050000")))
    assert store.save_candidates(pg, "COSK-FR-GT", SESSION, NIGHT, "book", book) is True
    assert store.read_candidates(pg, "COSK-FR-GT", SESSION) == book
    pg.rollback()


def test_an_unchanged_list_is_not_rewritten_and_a_changed_one_is_replaced(pg):
    items = (Candidate(1, "NVDA"), Candidate(2, "COST"))
    assert store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", items) is True
    pg.commit()
    first = stored(pg, "A-GT", SESSION)
    assert store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", items) is False
    pg.commit()
    assert stored(pg, "A-GT", SESSION) == first  # created_at included: nothing was touched
    assert store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", (Candidate(1, "COST"),)) is True
    assert store.read_candidates(pg, "A-GT", SESSION) == (Candidate(1, "COST"),)
    assert store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", ()) is True
    assert store.read_candidates(pg, "A-GT", SESSION) == ()
    pg.rollback()


def test_save_candidates_refuses_a_malformed_list_before_writing(pg):
    ok = (Candidate(1, "NVDA"),)
    with pytest.raises(ValueError, match="night of"):
        store.save_candidates(pg, "A-GT", SESSION, date(2026, 11, 2), "bracket", ok)
    with pytest.raises(ValueError, match="kind"):
        store.save_candidates(pg, "A-GT", SESSION, NIGHT, "veto", ok)
    with pytest.raises(ValueError, match="1..n"):
        store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", (Candidate(2, "NVDA"),))
    with pytest.raises(ValueError, match="twice"):
        store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", (Candidate(1, "X"), Candidate(2, "X")))
    with pytest.raises(ValueError, match="no weight"):
        store.save_candidates(pg, "A-GT", SESSION, NIGHT, "bracket", (Candidate(1, "X", Decimal("0.5")),))
    with pytest.raises(ValueError, match="target weight"):
        store.save_candidates(pg, "COSK-FR-GT", SESSION, NIGHT, "book", ok)
    with pytest.raises(ValueError, match="decimals"):
        store.save_candidates(pg, "COSK-FR-GT", SESSION, NIGHT, "book", (Candidate(1, "X", Decimal("0.1234567")),))
    assert pg.execute("SELECT count(*) FROM strategy_candidates").fetchone()[0] == 0
    pg.rollback()


def test_is_twin_reads_the_column(pg):
    assert store.is_twin(pg, "A-GT") is False
    pg.execute(
        "INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, sort, engine, rules_id, "
        "object_name, gate_note, gate_applicable, twin_of) "
        "SELECT 'A-GT-CX', name, sub, icon, false, false, 90, engine, rules_id, object_name, gate_note, "
        "false, id FROM strategies WHERE id = 'A-GT'"
    )
    assert store.is_twin(pg, "A-GT-CX") is True
    with pytest.raises(store.StoreError, match="no strategies row"):
        store.is_twin(pg, "NOPE")
    pg.rollback()


def test_a_preview_stores_its_next_rank_session(pg):
    store.save_book_preview(
        pg, "COSK-FR-GT", NIGHT, [target("XOM", "0.050000")], next_decision_session=date(2026, 12, 1)
    )
    assert pg.execute(
        "SELECT data_date, symbol, next_decision_session FROM book_previews WHERE strategy_id = 'COSK-FR-GT'"
    ).fetchall() == [(NIGHT, "XOM", date(2026, 12, 1))]
    store.save_book_preview(pg, "COSK-FR-GT", NIGHT, [target("XOM", "0.050000")])
    assert pg.execute("SELECT next_decision_session FROM book_previews").fetchall() == [(None,)]
    with pytest.raises(ValueError, match="not after"):
        store.save_book_preview(pg, "COSK-FR-GT", NIGHT, [target("XOM", "0.050000")], next_decision_session=NIGHT)
    pg.rollback()
```
**Impact:** new tests only. `Pick` is exported from `seer_engine.sim` (`commands/paper.py` imports
`seer_engine.sim`, and `strategies/base.py:21` imports `Pick` from it). `Target(symbol=..., weight=...,
last=...)` is valid with `weight` a multiple of `WEIGHT_QUANTUM` (6 dp).

### Step 8: Migration 027 tests
**File:** `engine/tests/test_adversary_schema.py` (new)
**Code:**
```python
"""Migration 027 (Seer Adversarial): the tables, their checks, the append-only verdicts, A-GT.

Every row in this file is written straight in SQL: the schema is what is under test, and mcp-notes
(not this repo) is the writer of the three adversary tables.
"""

from __future__ import annotations

from datetime import date

import psycopg
import pytest
from psycopg.types.json import Jsonb

SESSION = date(2026, 11, 4)
NIGHT = date(2026, 11, 3)
SOURCES = [
    {
        "url": "https://www.sec.gov/Archives/edgar/data/0000000000/000000000000000000/x8k.htm",
        "title": "Form 8-K",
        "publisher": "SEC",
        "published_at": "2026-11-03T21:05:00Z",
        "fetched_at": "2026-11-04T08:01:00Z",
    }
]


def columns(pg, table):
    return [
        r[0]
        for r in pg.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = %s ORDER BY ordinal_position",
            (table,),
        ).fetchall()
    ]


def verdict(
    pg,
    *,
    symbol="NVDA",
    verdict="object",
    reason="The drop follows a lowered forecast, which is news, not noise.",
    sources=SOURCES,
    started="2026-11-04T08:00:00Z",
    decided="2026-11-04T08:05:00Z",
    strategy="C-GT",
    session=SESSION,
) -> int:
    return pg.execute(
        "INSERT INTO adversary_verdicts (strategy_id, session_date, symbol, verdict, reason, sources, lens, "
        "model, prompt_version, host, started_at, decided_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, 'a-dip@1', 'claude-opus-x', 'pv-1', 'lenovo', %s, %s) RETURNING id",
        (strategy, session, symbol, verdict, reason, Jsonb(sources), started, decided),
    ).fetchone()[0]


def refused(pg, error, sql, params=(), match=None):
    with pytest.raises(error, match=match):
        pg.execute(sql, params)
    pg.rollback()


# ---- shape ---------------------------------------------------------------------------------------


def test_027_adds_every_c1_table_and_column(pg):
    assert columns(pg, "strategy_candidates") == [
        "strategy_id", "session_date", "data_date", "kind", "rank", "symbol", "weight", "evidence", "created_at",
    ]
    assert columns(pg, "adversary_verdicts") == [
        "id", "strategy_id", "session_date", "symbol", "verdict", "reason", "sources", "lens", "model",
        "prompt_version", "host", "started_at", "decided_at", "superseded_by", "created_at",
    ]
    assert columns(pg, "adversary_marks") == ["strategy_id", "session_date", "mark", "host", "created_at"]
    assert columns(pg, "adversary_leases") == ["strategy_id", "session_date", "host", "claimed_at", "expires_at"]
    assert "twin_of" in columns(pg, "strategies")
    assert columns(pg, "book_previews")[-1] == "next_decision_session"


def test_027_admits_a_gt_with_no_clock_and_inserts_no_twin(pg):
    row = pg.execute(
        "SELECT engine, rules_id, object_name, status, paper_start, params, twin_of, is_benchmark, "
        "is_champion, gate_applicable, promoted_from, sort FROM strategies WHERE id = 'A-GT'"
    ).fetchone()
    assert row == ("bracket", "design-v0-gotrade", "STRATEGY_A", "active", None, {}, None, False, False, True, None, 5)
    assert pg.execute("SELECT count(*) FROM strategies WHERE twin_of IS NOT NULL").fetchone()[0] == 0
    # plain A stays retired, on its own flat-fee rule set, with every row it wrote
    assert pg.execute("SELECT status, rules_id FROM strategies WHERE id = 'A'").fetchone() == ("retired", "design-v0")


# ---- twins ---------------------------------------------------------------------------------------


def add_twin(pg, sid, of, status="active"):
    pg.execute(
        "INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, sort, engine, rules_id, "
        "object_name, gate_note, gate_applicable, status, twin_of) "
        "SELECT %s, name, sub, icon, false, false, 90, engine, rules_id, object_name, gate_note, false, %s, id "
        "FROM strategies WHERE id = %s",
        (sid, status, of),
    )


def test_an_original_has_at_most_one_active_twin(pg):
    add_twin(pg, "A-GT-CX", "A-GT")
    pg.commit()
    refused(pg, psycopg.errors.UniqueViolation,
            "INSERT INTO strategies (id, name, sub, icon, sort, engine, rules_id, object_name, gate_note, twin_of) "
            "VALUES ('A-GT-CX2', 'x', 'x', 'x', 91, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', 'x', 'A-GT')")
    # a retired twin beside an active one is history, not a second twin
    add_twin(pg, "A-GT-CX0", "A-GT", status="retired")
    pg.commit()
    assert pg.execute("SELECT count(*) FROM strategies WHERE twin_of = 'A-GT'").fetchone()[0] == 2


def test_a_twin_names_a_real_original_and_never_itself(pg):
    refused(pg, psycopg.errors.CheckViolation, "UPDATE strategies SET twin_of = id WHERE id = 'A-GT'")
    refused(pg, psycopg.errors.ForeignKeyViolation, "UPDATE strategies SET twin_of = 'NOPE' WHERE id = 'A'")


# ---- strategy_candidates -----------------------------------------------------------------------------

INSERT_CANDIDATE = (
    "INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight) "
    "VALUES (%s, %s, %s, %s, %s, %s, %s)"
)


def test_a_candidate_row_is_a_bracket_rank_or_a_weighted_book_target(pg):
    pg.execute(INSERT_CANDIDATE, ("A-GT", SESSION, NIGHT, "bracket", 1, "NVDA", None))
    pg.execute(INSERT_CANDIDATE, ("COSK-FR-GT", SESSION, NIGHT, "book", 1, "XOM", "0.05"))
    pg.commit()
    refused(pg, psycopg.errors.CheckViolation, INSERT_CANDIDATE, ("A-GT", SESSION, NIGHT, "bracket", 2, "AAPL", "0.5"))
    refused(pg, psycopg.errors.CheckViolation, INSERT_CANDIDATE, ("COSK-FR-GT", SESSION, NIGHT, "book", 2, "CVX", None))
    refused(pg, psycopg.errors.CheckViolation, INSERT_CANDIDATE, ("COSK-FR-GT", SESSION, NIGHT, "book", 2, "CVX", "1.5"))
    refused(pg, psycopg.errors.CheckViolation, INSERT_CANDIDATE, ("A-GT", SESSION, NIGHT, "veto", 2, "AAPL", None))
    refused(pg, psycopg.errors.CheckViolation, INSERT_CANDIDATE, ("A-GT", SESSION, NIGHT, "bracket", 0, "AAPL", None))
    refused(pg, psycopg.errors.CheckViolation, INSERT_CANDIDATE, ("A-GT", SESSION, SESSION, "bracket", 2, "AAPL", None))
    refused(pg, psycopg.errors.UniqueViolation, INSERT_CANDIDATE, ("A-GT", SESSION, NIGHT, "bracket", 1, "AAPL", None))
    refused(pg, psycopg.errors.UniqueViolation, INSERT_CANDIDATE, ("A-GT", SESSION, NIGHT, "bracket", 2, "NVDA", None))
    refused(pg, psycopg.errors.ForeignKeyViolation, INSERT_CANDIDATE, ("NOPE", SESSION, NIGHT, "bracket", 1, "NVDA", None))


def test_a_preview_names_a_rank_session_after_its_own_night(pg):
    sql = (
        "INSERT INTO book_previews (strategy_id, data_date, rank, symbol, weight, last, next_decision_session) "
        "VALUES ('COSK-FR-GT', %s, 1, 'XOM', 0.05, 110, %s)"
    )
    pg.execute(sql, (NIGHT, date(2026, 12, 1)))
    pg.rollback()
    refused(pg, psycopg.errors.CheckViolation, sql, (NIGHT, NIGHT))


# ---- adversary_verdicts ----------------------------------------------------------------------------


def test_a_verdict_must_cite_a_source_unless_it_cannot_tell(pg):
    verdict(pg, verdict="unsure", sources=[])
    verdict(pg, symbol="AAPL", verdict="agree")
    pg.commit()
    for v in ("object", "agree"):
        with pytest.raises(psycopg.errors.CheckViolation):
            verdict(pg, symbol="MSFT", verdict=v, sources=[])
        pg.rollback()
    with pytest.raises(psycopg.errors.CheckViolation):  # an object, not an array: refused, not an error
        verdict(pg, symbol="MSFT", verdict="unsure", sources={"url": "https://example.com"})
    pg.rollback()


def test_a_verdict_is_short_plain_ordered_in_time_and_one_of_three(pg):
    verdict(pg, reason="x" * 600)
    pg.commit()
    for kwargs in ({"reason": ""}, {"reason": "x" * 601}, {"verdict": "veto"},
                   {"started": "2026-11-04T08:05:00Z", "decided": "2026-11-04T08:00:00Z"}):
        with pytest.raises(psycopg.errors.CheckViolation):
            verdict(pg, symbol="MSFT", **kwargs)
        pg.rollback()
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        verdict(pg, strategy="NOPE")
    pg.rollback()


def test_a_verdict_is_never_deleted_or_rewritten(pg):
    vid = verdict(pg)
    pg.commit()
    before = pg.execute("SELECT to_jsonb(v) FROM adversary_verdicts v WHERE id = %s", (vid,)).fetchone()
    refused(pg, psycopg.errors.RaiseException, "DELETE FROM adversary_verdicts WHERE id = %s", (vid,), match="append-only")
    for sql in (
        "UPDATE adversary_verdicts SET reason = 'rewritten after the fact' WHERE id = %s",
        "UPDATE adversary_verdicts SET verdict = 'agree' WHERE id = %s",
        "UPDATE adversary_verdicts SET decided_at = decided_at - interval '1 hour' WHERE id = %s",
    ):
        refused(pg, psycopg.errors.RaiseException, sql, (vid,), match="append-only")
    assert pg.execute("SELECT to_jsonb(v) FROM adversary_verdicts v WHERE id = %s", (vid,)).fetchone() == before


def test_a_re_review_supersedes_the_old_verdict_once_and_keeps_it(pg):
    old = verdict(pg, verdict="object")
    new = verdict(pg, verdict="agree", started="2026-11-04T09:00:00Z", decided="2026-11-04T09:04:00Z")
    pg.commit()
    pg.execute("UPDATE adversary_verdicts SET superseded_by = %s WHERE id = %s", (new, old))
    pg.commit()
    assert pg.execute("SELECT id, verdict, superseded_by FROM adversary_verdicts ORDER BY id").fetchall() == [
        (old, "object", new),
        (new, "agree", None),
    ]
    third = verdict(pg, verdict="unsure", sources=[], started="2026-11-04T10:00:00Z", decided="2026-11-04T10:01:00Z")
    pg.commit()
    refused(pg, psycopg.errors.RaiseException,
            "UPDATE adversary_verdicts SET superseded_by = %s WHERE id = %s", (third, old), match="already superseded")


def test_only_a_later_verdict_on_the_same_pick_can_supersede(pg):
    nvda = verdict(pg)
    aapl = verdict(pg, symbol="AAPL")
    later_nvda = verdict(pg, decided="2026-11-04T08:30:00Z")
    pg.commit()
    match = "superseded by a later verdict"
    refused(pg, psycopg.errors.RaiseException,
            "UPDATE adversary_verdicts SET superseded_by = %s WHERE id = %s", (aapl, nvda), match=match)
    refused(pg, psycopg.errors.RaiseException,
            "UPDATE adversary_verdicts SET superseded_by = %s WHERE id = %s", (nvda, later_nvda), match=match)
    refused(pg, psycopg.errors.RaiseException,
            "UPDATE adversary_verdicts SET superseded_by = %s WHERE id = %s", (nvda, nvda), match=match)


# ---- marks and leases ------------------------------------------------------------------------------


def test_a_paused_mark_is_once_per_decision(pg):
    sql = (
        "INSERT INTO adversary_marks (strategy_id, session_date, mark, host) VALUES ('C-GT', %s, %s, 'gpd') "
        "ON CONFLICT (strategy_id, session_date) DO NOTHING"
    )
    assert pg.execute(sql, (SESSION, "paused")).rowcount == 1
    assert pg.execute(sql, (SESSION, "paused")).rowcount == 0
    pg.commit()
    refused(pg, psycopg.errors.CheckViolation, sql, (NIGHT, "absent"))


CLAIM = """
INSERT INTO adversary_leases (strategy_id, session_date, host, expires_at)
VALUES ('C-GT', %(session)s, %(host)s, now() + interval '20 minutes')
ON CONFLICT (strategy_id, session_date) DO UPDATE
  SET host = EXCLUDED.host, claimed_at = now(), expires_at = EXCLUDED.expires_at
  WHERE adversary_leases.expires_at < now() OR adversary_leases.host = EXCLUDED.host
RETURNING host
"""


def claim(pg, host):
    row = pg.execute(CLAIM, {"session": SESSION, "host": host}).fetchone()
    pg.commit()
    return None if row is None else row[0]


def test_contract_c4s_lease_claim_holds_on_this_schema(pg):
    """The claim statement mcp-notes runs (plan C4), against the table 027 makes: one host at a
    time, the holder may renew, and an expired lease -- by this database's clock -- passes on."""
    assert claim(pg, "lenovo") == "lenovo"
    assert claim(pg, "gpd") is None
    assert claim(pg, "lenovo") == "lenovo"
    pg.execute("UPDATE adversary_leases SET expires_at = now() - interval '1 minute'")
    pg.commit()
    assert claim(pg, "gpd") == "gpd"
```
**Impact:** new tests only. They need `PG_TEST_URL` like every DB test.

### Step 9: Pinned roster lists in existing tests
**File:** `engine/tests/test_paper_roster.py`
**Change:** `A-GT` is a sixth active entry at sort 5.
- after line 112 (`MOM70_GT = "MOM70-FR-GT"`), insert:
```python
# 027 (owner, 2026-11-05, Seer Adversarial): plain Strategy A back on paper under design-v0-gotrade, the
# baseline that C-GT and the Claude twins are compared against. It takes sort 5, which 026 vacated.
A_GT = "A-GT"
```
- line 117 `ACTIVE_IDS = (SPY_GT, C_GT, COSK_GT, RAW35_GT)` becomes:
```python
# 027 (owner, 2026-11-05): A-GT joins -- three books, the daily control, plain A and the SPY yardstick.
ACTIVE_IDS = (SPY_GT, C_GT, COSK_GT, RAW35_GT, A_GT)
```
- in `PINS`, after the `MOM70_GT: ...` line (line 168), insert:
```python
    # 027: plain A at Gotrade's fees. ONE new pin and not one moved: A's own digest above is what it
    # always was, because A-GT is a new id under a new rule set and the retired A is not touched.
    A_GT: "3db8862e29948b3cad007e404c0b1c59d79b1a9f7bdcc4d3a5eb043a42d4080d",
```
- replace `test_the_roster_is_the_handover_entries_in_sort_order` (lines 188-196) with:
```python
def test_the_roster_is_the_handover_entries_in_sort_order():
    assert ROSTER_IDS == (
        SPY_GT, C_GT, COSK_GT, RAW35_GT, A_GT,
        "SPY", "A", F4, F1, "C", FND, F4_FR, F1_FR, RM, RMW, RAW, MOM, MVW, RAW_GT, RMW_GT,
        MVW_GT, MOM_GT, ALLIN_GT, MOM70_GT,
    )
    # 025 retired FULL50 (sort 6) to the end at 24 and replaced nothing, so sort 6 is a gap; 026 did the
    # same to MOM70 (sort 5, now 25), and 027 put A-GT in sort 5.
    assert [e.sort for e in ROSTER] == [1, 2, 3, 4, 5, *range(7, 26)]
    assert "B" not in ROSTER_IDS
```
- in `test_lookbacks` (line 357), the first dict line becomes:
```python
        SPY_GT: 1, C_GT: 200, COSK_GT: 781, RAW35_GT: 401, A_GT: 200, MOM_GT: 379, MVW_GT: 253,
```
- in `test_active_drops_retired_entries_and_keeps_order` (line 580):
```python
    assert [e.id for e in active(entries)] == [SPY_GT, C_GT, COSK_GT, A_GT]
```
- line 718 `NOT_LAB_DERIVED = ("SPY", SPY_GT, "A", "C", C_GT)` becomes, with its comment (lines 716-718):
```python
#: And the six that are not: the two benchmark entries, C and its Gotrade successor (the LLM
#: strategy the quant gate does not apply to), and A and A-GT, which predate the lab.
NOT_LAB_DERIVED = ("SPY", SPY_GT, "A", A_GT, "C", C_GT)
```
- in `test_every_active_entry_pays_gotrade_and_nothing_retired_changed`, the pairs tuple (lines 918-920) becomes:
```python
    for old, new in (("SPY", SPY_GT), ("C", C_GT), (RMW, RMW_GT), (RAW, RAW_GT),
                     (MOM, MOM_GT), (MVW, MVW_GT), (RAW_GT, RAW35_GT), (RMW_GT, COSK_GT),
                     (MOM_GT, MOM70_GT), ("A", A_GT)):
```
- append after `test_the_daily_control_stays_and_is_funded_like_the_books` (after line 944):
```python
def test_plain_a_returns_as_a_gt_on_cs_money_and_fees():
    """027: A-GT is A's own rule on C-GT's rule set, start, deposits and fees -- the three-way
    comparison (A, C, A with Claude) is only fair if nothing but the news check and the objections
    differs."""
    a, a_gt, c_gt = entry("A"), entry(A_GT), entry(C_GT)
    assert (a_gt.status, a_gt.engine, a_gt.object_name) == ("active", "bracket", "STRATEGY_A")
    assert a_gt.obj is STRATEGY_A and a_gt.params is STRATEGY_A_PARAMS
    assert a_gt.rules is c_gt.rules and a_gt.rules_id == "design-v0-gotrade" and a_gt.rules.cost_model == "gotrade"
    assert a_gt.registry_id is None and a_gt.lab_provenance is None
    assert a_gt.gate_applicable is True and backtest_gate(a_gt) == {"passed": False}
    s, sc = spec(a_gt), spec(c_gt)
    assert s["params"] == STRATEGY_A_PARAMS.as_dict() == spec(a)["params"]
    assert {k[2:]: v for k, v in sc["params"].items() if k.startswith("a.")} == s["params"]
    assert (s["rules"], s["initial_idr"], s["funding"]) == (sc["rules"], sc["initial_idr"], sc["funding"])
    assert A_GT not in PRE_FUNDING_IDS and "funding" not in spec(a)
    assert spec_digest(s) == PINS[A_GT] != PINS["A"]
    assert a_gt.lookback == a.lookback == 200
    assert news_veto() == c_gt  # A-GT is no news check: the one active NewsVeto is still C-GT
```
**Impact:** test-only; with Step 3 in place every changed assertion is true.

### Step 10: Other pinned roster lists
**File:** `engine/tests/test_paper_store.py:64-69`, the expected list becomes:
```python
    assert [r.id for r in rows] == [
        "SPY-GT", "C-GT", "COSK-FR-GT", "RAW35-FR-GT", "A-GT",
        "SPY", "A", BOOK_ID, TIMING_ID, "C", "FND", f"{BOOK_ID}-FR", f"{TIMING_ID}-FR", "RM-FR",
        "RMW-FR", "RAW-FR", "MOM-FR", "MVW-FR", "RAW-FR-GT", "RMW-FR-GT", "MVW-FR-GT",
        "MOM-FR-GT", "FULL50-FR-GT", "MOM70-FR-GT",
    ]
```
**File:** `engine/tests/test_paper_fnd.py:162,167`:
```python
    assert ROSTER_IDS.index(FND_ID) == 10  # 025, 026: FULL50's and MOM70's slots closed up; 027 put A-GT ahead of it
```
and
```python
    assert len(ROSTER_IDS) == 24
```
**File:** `engine/tests/test_migrate.py:295-300`, the expected list becomes:
```python
    assert [r[0] for r in rows] == [
        "SPY-GT", "C-GT", "COSK-FR-GT", "RAW35-FR-GT", "A-GT",
        "SPY", "A", "F4-MOM12-N20-TREND", "F1-SPY-SMA200-M", "C", "FND",
        "F4-MOM12-N20-TREND-FR", "F1-SPY-SMA200-M-FR", "RM-FR", "RMW-FR",
        "RAW-FR", "MOM-FR", "MVW-FR", "RAW-FR-GT", "RMW-FR-GT", "MVW-FR-GT",
        "MOM-FR-GT", "FULL50-FR-GT", "MOM70-FR-GT",
    ]
```
(`all(r[9:] == ({}, None) for r in rows)` at line 307 stays true: A-GT has `params '{}'` and no clock.)
**File:** `engine/tests/test_paper_check.py:60-63`:
```python
ALL_IDS = ("SPY-GT", "C-GT", "COSK-FR-GT", "RAW35-FR-GT", "A-GT",
           "SPY", "A", "F4-MOM12-N20-TREND", "F1-SPY-SMA200-M", "C", "FND", F4, F1, "RM-FR",
           "RMW-FR", "RAW-FR", "MOM-FR", "MVW-FR", "RAW-FR-GT", "RMW-FR-GT", "MVW-FR-GT", "MOM-FR-GT", "FULL50-FR-GT",
           "MOM70-FR-GT")
```
**Impact:** test-only. `A-GT` is retired inside these files' `world` fixtures (they retire everything and
re-activate their own list), so it is checked as a board row and never stepped there.

### Step 11: Night tests for the candidate list
**File:** `engine/tests/test_paper_command.py`
**Change (a):** `CONTENT` (line 191) gains an entry after `"strategies": ...` (line 207):
```python
    # 027: the list each reviewable decision is written down with (created_at left out: it is a clock).
    "strategy_candidates": (
        "strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence",
        "strategy_id, session_date, rank",
    ),
```
`EVERYTHING` (line 211) gains, after `"runs": "id",`:
```python
    "strategy_candidates": "strategy_id, session_date, rank",
```
`reset` (lines 230-241): the TRUNCATE list includes `strategy_candidates`:
```python
def reset(conn) -> None:
    """The plan index Rollback's "reset the paper clock" (the bars, runs rows and universe stay)."""
    with db.transaction(conn, False):
        conn.execute(
            # paper_contributions too (017): the deposits belong to the clock being reset, so
            # leaving them would re-fund the next run from money the first one already spent.
            # strategy_candidates too (027): the lists belong to the decisions being reset, and
            # keeping them would let a catch-up that wrote nothing look identical to one that did.
            "TRUNCATE paper_state, book_positions, book_targets, book_fills, book_trades, "
            "action_dismissals, orders, equity_snapshots, paper_contributions, strategy_candidates RESTART IDENTITY"
        )
        conn.execute("UPDATE strategies SET paper_start = NULL, params = '{}'::jsonb")
        conn.execute("UPDATE runs SET paper_status = NULL, paper_error = NULL, paper_finished_at = NULL")
```
With this, `test_catch_up_of_two_sessions_equals_night_by_night` and `test_no_look_ahead` also prove that
the lists are the same whether nights run one by one or catch up, and that they read nothing after their
night. `test_same_night_twice_writes_nothing` and `test_dry_run_writes_nothing` prove a re-run and a dry
run write no list.

**Change (b):** append at the end of the file:
```python
# ---- 027: the list Claude reviews, and the preview's next rank session --------------------------

import logging  # noqa: E402

from seer_engine.paper import candidates as cand  # noqa: E402


def stored_candidates(conn, strategy_id: str, session: date):
    return q(
        conn,
        "SELECT kind, data_date, rank, symbol, weight FROM strategy_candidates "
        "WHERE strategy_id = %s AND session_date = %s ORDER BY rank",
        (strategy_id, session),
    )


def test_a_bracket_night_lists_its_own_ranking_before_any_veto(world, tmp_path):
    assert night(world, N0) == 0
    market, _ = bio.load_market(world, cache_dir=tmp_path)
    a = ENTRIES["A"]
    expected = cand.bracket_candidates(a.obj, a.params, market.history, market.membership.members_on(N0), N0)
    assert expected, "the synthetic world gives A candidates on its first night (COST, NVDA measured)"
    want = [("bracket", N0, c.rank, c.symbol, None) for c in expected]
    assert stored_candidates(world, "A", PAPER_START) == want
    assert q(world, "SELECT count(*) FROM strategy_candidates WHERE strategy_id = 'A' AND evidence IS NULL") == [(0,)]
    # C has no stored verdict, so it buys nothing tonight -- and its list is still A's ranking:
    # what the method ranked, not what the veto let through.
    assert q(world, "SELECT count(*) FROM orders WHERE strategy_id = 'C'") == [(0,)]
    assert stored_candidates(world, "C", PAPER_START) == want
    # the benchmark decides nothing a reviewer could object to
    assert q(world, "SELECT count(*) FROM strategy_candidates WHERE strategy_id = 'SPY'") == [(0,)]


def test_a_book_lists_its_rank_and_kickoff_targets_and_never_a_resize(world):
    for d in NIGHTS:
        assert night(world, d) == 0
    books = sorted(i for i in IDS if ENTRIES[i].engine == "book")
    listed = 0
    for sid in books:
        idle = ENTRIES[sid].rules.idle_symbol
        for session in (PAPER_START, OCT1):  # the kickoff, and October's rank session
            targets = q(
                world,
                "SELECT symbol, weight FROM book_targets WHERE strategy_id = %s AND session_date = %s",
                (sid, session),
            )
            want = sorted(((s, w) for s, w in targets if s != idle), key=lambda r: (-r[1], r[0]))
            data = dates.prev_session(session)
            assert stored_candidates(world, sid, session) == [
                ("book", data, i, s, w) for i, (s, w) in enumerate(want, start=1)
            ], (sid, session)
            listed += len(want)
    assert listed > 0
    # RMW-FR re-scales its basket every Monday: 2026-09-28 is a resize-only decision, so no list.
    monday = date(2026, 9, 28)
    assert paper._resize_only(ENTRIES["RMW-FR"].rules, monday, False)
    assert stored_candidates(world, "RMW-FR", monday) == []
    # and a session that is no decision at all lists nothing either
    assert stored_candidates(world, F1, date(2026, 9, 25)) == []


def test_every_preview_names_the_next_session_its_book_ranks(world):
    def nexts():
        return {r[0] for r in q(world, "SELECT DISTINCT next_decision_session FROM book_previews")}

    assert night(world, N0) == 0
    assert nexts() == {PAPER_START}  # the first night's preview IS the kickoff decision
    assert night(world, NIGHTS[1]) == 0
    assert nexts() == {OCT1}  # RMW-FR's Monday resize is not a rank
    for d in NIGHTS[2:]:
        assert night(world, d) == 0
    assert nexts() == {date(2026, 11, 2)}  # after October's rank, November's first session


def test_a_twin_gets_no_list(world):
    """A twin's decisions are its original's minus Claude's objections; listing them would review
    the review. The row is written here by hand -- creating twins is not this change's job."""
    with db.transaction(world, False):
        world.execute(
            "INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, sort, engine, rules_id, "
            "object_name, gate_note, gate_applicable, twin_of) "
            "SELECT 'A-CX', name, sub, icon, false, false, 90, engine, rules_id, object_name, gate_note, "
            "false, id FROM strategies WHERE id = 'A'"
        )
    assert night(world, N0) == 0
    assert stored_candidates(world, "A", PAPER_START)
    assert stored_candidates(world, "A-CX", PAPER_START) == []


def test_a_failing_list_fails_no_night_and_changes_no_decision(world, monkeypatch, caplog):
    def decisions(conn):
        return {k: v for k, v in content(conn).items() if k != "strategy_candidates"}

    for d in NIGHTS[:2]:
        assert night(world, d) == 0
    expected = decisions(world)
    reset(world)

    def boom(*args, **kwargs):
        raise RuntimeError("boom in the list apiKey=sekret")

    monkeypatch.setattr(cand, "bracket_candidates", boom)
    monkeypatch.setattr(cand, "book_candidates", boom)
    with caplog.at_level(logging.WARNING, logger="seer_engine.commands.paper"):
        for d in NIGHTS[:2]:
            assert night(world, d) == 0
    assert decisions(world) == expected
    assert q(world, "SELECT count(*) FROM strategy_candidates") == [(0,)]
    assert "no candidate list stored tonight" in caplog.text
    assert "sekret" not in caplog.text
    for d in NIGHTS[:2]:
        assert paper_run(world, d)[0][0] == "success"


def test_repick_re_takes_the_list_with_the_decision(world):
    from seer_engine.commands import repick

    assert night(world, N0) == 0
    listed = next(
        sym
        for (sym,) in q(
            world,
            "SELECT DISTINCT symbol FROM strategy_candidates WHERE session_date = %s ORDER BY symbol",
            (PAPER_START,),
        )
        if sym in STOCKS
    )
    with db.transaction(world, False):
        world.execute("INSERT INTO unavailable_symbols (symbol, since) VALUES (%s, %s)", (listed, N0))
    assert repick.execute(world) == 0
    assert q(
        world,
        "SELECT count(*) FROM strategy_candidates WHERE session_date = %s AND symbol = %s",
        (PAPER_START, listed),
    ) == [(0,)]
    before = q(world, "SELECT strategy_id, rank, symbol, created_at FROM strategy_candidates ORDER BY 1, 2")
    assert repick.execute(world) == 0  # a second pass changes nothing, so it writes nothing
    assert q(world, "SELECT strategy_id, rank, symbol, created_at FROM strategy_candidates ORDER BY 1, 2") == before


def test_a_gt_starts_steps_and_replays_beside_plain_a(world):
    from seer_engine.commands import paper_check

    with db.transaction(world, False):
        world.execute("UPDATE strategies SET status = 'active' WHERE id = 'A-GT'")
    for d in NIGHTS[:3]:
        assert night(world, d) == 0
    assert q(world, "SELECT paper_start, params->>'digest' FROM strategies WHERE id = 'A-GT'") == [
        (PAPER_START, roster.strategy_params(ENTRIES["A-GT"])["digest"])
    ]
    assert q(world, "SELECT last_session, pending_session FROM paper_state WHERE strategy_id = 'A-GT'") == [
        (NIGHTS[2], dates.next_session(NIGHTS[2]))
    ]
    # the owner's deposit of 2026-09-25 reached it exactly as it reached A
    assert deposits(world, "A-GT") and deposits(world, "A-GT") == deposits(world, "A")
    for d in NIGHTS[:3]:
        s = dates.next_session(d)
        assert [r[2:4] for r in stored_candidates(world, "A-GT", s)] == [r[2:4] for r in stored_candidates(world, "A", s)]
    assert paper_check.execute(world) == 0
```
**Impact:** test-only. `test_repick_re_takes_the_list_with_the_decision` picks a listed symbol that is a
real member (`STOCKS`). On N0 every book's kickoff list holds stocks, so one exists.

### Step 12: Docs and feature map
**File:** `README.md:358` (architecture block), line `   3  each strategy proposes next session's picks` becomes:
```
   3  each strategy proposes next session's picks, and lists its top ones for Claude's review
```
**File:** `README.md:384` (night table), the Paper row becomes:
```
| Paper | Settle, then decide, for every roster strategy, in one transaction, and write down each method's ranked candidates for Claude's review | Night is rolled back; no partial state |
```
**File:** `README.md`, insert before the `---` that ends "How it works" (after the `watch.yml` paragraph, line 404):
```markdown
### Seer Adversarial: what the night hands to Claude

Claude reviews the roster's picks before they are bought (design brief in the mcp-notes repo,
`docs/plans/2026-11-05-seer-adversarial-design.md`). Migration 027 adds what that needs:

| Table | Written by | What it holds |
|---|---|---|
| `strategy_candidates` | `paper`, in the night's transaction | Each bracket method's own top 10 for the session it decides, before any news veto; each book's targets at a rank or kickoff decision |
| `book_previews.next_decision_session` | `paper` | The next session a book ranks, so a monthly book can be reviewed days early |
| `adversary_verdicts` | mcp-notes only | Agree, object or can't tell, with sources. Append-only: a trigger refuses deletes and edits; a re-review supersedes, and the old verdict stays |
| `adversary_marks`, `adversary_leases` | mcp-notes only | "Paused" decisions (auto-reviews switched off), and which machine is reviewing |
| `strategies.twin_of` | the roster | A Claude twin names its original |

A verdict counts only if it was decided before 09:30 New York on its session
(`seer_engine.dates.session_open_utc`). Missing, failed or late means the twin copies its original. The
same migration brings plain A back as `A-GT`, at real Gotrade fees, as the baseline for C-GT and the twins.
```
**File:** `docs/runbooks/paper-trading.md`, insert before line 49 (`### 2026-10-14 — the roster went from twenty names to thirty-five`):
```markdown
### 2026-11-05 — plain A comes back as A-GT; the night writes down what Claude reviews (migration 027)

`A-GT` is Strategy A's own rule under `design-v0-gotrade`, the rule set `C-GT` trades. It has the same
start, the same deposits and the same Gotrade fees, and no news check. It is the baseline for the
three-way comparison A / C / A with Claude's objections. It is not a candidate for real money: A's gate
failed out of sample (-15.0% vs SPY TR +71.9%, PF 0.92, max DD 33.3%). It is a new id because the
retired `A` is frozen at a flat 0.1% a side. `paper_start` is written by its first night.

From the same migration, every paper night writes `strategy_candidates` beside each decision of an
active, non-benchmark, non-twin entry. A bracket method gets its own top 10 for the session it decides,
before any veto (`C-GT`'s list is A's ranking, the list Veto checks). A book gets the targets of a rank or
kickoff decision, never of a resize-only one. Each book preview also records `next_decision_session`.
A list that cannot be computed logs `<id> <date>: no candidate list stored tonight (...)` and never
changes a decision or fails the night. A list is rewritten only when it changes. Claude's verdicts,
"paused" marks and leases (`adversary_*`) are written by mcp-notes, never by this repo.
`adversary_verdicts` refuses deletes and edits. A re-review supersedes the old verdict, and the old one
stays. No twin row is created by 027; the twins are a later change.
```
**File:** `docs/runbooks/paper-trading.md`, in "The night" diagram, insert after line 162
(`│                                tonight (…)", stores NULL and never changes a decision or fails the night`):
```
│                              → the decision's candidate list (027, strategy_candidates): a bracket
│                                method's own top 10 before any veto, a book's rank/kickoff targets;
│                                each book preview names its next rank session; a list error logs
│                                "<id> <date>: no candidate list stored tonight (…)" and changes nothing
```
**File:** `.claude/skills/verify-seer/features/engine-night.md`, replace the whole file with:
````markdown
# The night (engine)

## Sub-features

- `migrate`: applies `db/migrations/*.sql` (shared with web's `db:migrate`).
- `nightly`: fetches the session's bars (Massive), splits, dividends, USD/IDR, writes a `runs` row.
- `veto` / `explain`: the LLM news check and plain-language reasons (never fail the night).
- `paper`: settles and decides every roster strategy after a successful bars run.
  - 027 (Seer Adversarial): beside every decision of an active, non-benchmark, non-twin entry it writes
    `strategy_candidates`. A bracket method gets its own top 10 before any veto. A book gets its rank or
    kickoff targets, never a resize-only decision. `book_previews.next_decision_session` records the
    book's next rank session. A list error logs `no candidate list stored tonight` and never fails the night.
  - 027 also admits `A-GT` (plain A at Gotrade's fees), which starts on its first paper night.
- `paper_check`: replays every paper strategy and asserts the DB agrees (read-only).
- `sean marks`: marks the owner's real holdings to market.
- Schema only, written by mcp-notes: `adversary_verdicts` (append-only by trigger), `adversary_marks`,
  `adversary_leases`, `strategies.twin_of`.

## How to get to it (user POV)

The owner never runs these. GitHub Actions `nightly.yml` runs them at 06:17 UTC Tue–Sat. Their result is what Today, Positions and the Leaderboard show the next morning. The candidate lists are what the Seer Adversarial reviewer in mcp-notes reads to review the next session's picks.

## Driving it with verify.sh

```sh
$V up --no-web --empty                 # migrations only: 24 roster strategies, no sessions
$V doctor RUN                          # "database ok ... (27 migrations, strategies: 24)", "egress ok engine cannot reach api.github.com"
$V engine RUN nightly                  # ERROR MASSIVE_API_KEY is not set (checked ... engine.env); exit 2
$V engine RUN paper_check              # "paper_check: ok (0 of 24 roster strategies started)"; exit 0
$V engine RUN --dry-run paper          # "the bars run for session ... is missing; no paper step after a failed or missing bars run"; exit 1

# 027's schema and A-GT, read back
$V sql RUN "select id, engine, rules_id, object_name, status, paper_start, twin_of from strategies where id = 'A-GT'"
#   A-GT | bracket | design-v0-gotrade | STRATEGY_A | active | (null) | (null)
$V sql RUN "select table_name from information_schema.tables where table_schema = current_schema() and table_name in ('strategy_candidates','adversary_verdicts','adversary_marks','adversary_leases') order by 1"
#   the four tables
$V sql RUN "select tgname from pg_trigger where tgname = 'adversary_verdicts_append_only'"
#   one row

$V up --no-web --empty --net           # MODE=real-external(net=1 llm=0)
$V engine RUN --dry-run nightly        # "nightly failed ...: NightlyError: no SPY bars stored; run `backfill` first"; exit 1
```

Each of these is the correct end state for its DB, not a failure of the harness.

A paper night that writes candidate lists cannot run here (no bars; see Gotchas), so the lists, the
previews' `next_decision_session`, the append-only trigger and A-GT's first nights are proven by the DB
test journeys, with `PG_TEST_URL` set:

```sh
engine/.venv/bin/pytest -n0 engine/tests/test_adversary_schema.py engine/tests/test_paper_candidates.py
engine/.venv/bin/pytest -n0 engine/tests/test_paper_command.py -k "list or preview or twin or a_gt or catch_up or look_ahead"
```

## Gotchas

- On demo data (`up` without `--empty`) `paper_check` runs and reports `replay mismatch` for all five strategies (exit 1): the seeded history is hand-made, not simulated, so it cannot replay. That is the check working. Before 2026-11-03 it crashed instead (`UnknownObject: 'SPY': roster object name None`), because the seeder did not write migration 006's `object_name` column. A crash there now is a regression.
- A full real nightly cannot be produced: it needs a 10-year `backfill` from yfinance first. Mark journeys that need one `inconclusive`. That includes "the night wrote `strategy_candidates`"; use the pytest journeys above.
- `$V sql` is read-only, so the append-only trigger cannot be exercised here: an UPDATE is refused by the read-only transaction before the trigger runs. `test_adversary_schema.py` drives it.
- `--net` reaches Massive with the owner's free-tier key, which the production nightly shares (06:17, 09:41, 12:41 UTC). Keep `--net` drives few and away from those times.
- `veto` / `explain` with `--llm` spend the budget (default 3). On a DB with no candidates they make no call, which proves nothing. Seed state first.
- `backtest*`, `promote` and the store builders are refused (they write tracked reports, the roster or the shared stores).
````
**File:** `.claude/skills/verify-seer/SKILL.md:202`, `... where `paper_check` exits 0 over 23 roster strategies.`
becomes `... where `paper_check` exits 0 over 24 roster strategies.`
**Impact:** docs only.

## Principles applied

- Laziness protocol: `A-GT` reuses the `STRATEGY_A` resolver key, its evidence function and C-GT's `design-v0-gotrade` preset, so it adds no RESOLVER, EVIDENCE or preset entry. A book's list is derived from the targets the night already computed, with no second allocator call. Twin detection is one `store.is_twin` read, and `StrategyRow` and the roster `Row` protocol are left unchanged.
- Make illegal states unrepresentable: the schema refuses what the reviewer and the twins must never see. These are DB CHECKs, not Python checks: a bracket candidate with a weight, a book one without, a list dated on or after its session, a twin of itself, a second active twin, an agree or object with no source, and a preview whose next rank session is not after its night. The append-only rule is a trigger, so mcp-notes (another repo, another language) cannot rewrite history even through a bug.
- Boundary discipline: `save_candidates` validates a list once, where it enters the database (ranks 1..n, unique symbols, `data_date = prev_session(session_date)`, weight exactness). The night's helpers pass typed `Candidate` values and do not re-check.
- Prove it works: proof is the migrated DB read back through verify-seer (`up --empty`, `doctor`, `sql`, `paper_check`), plus real paper nights on the synthetic world reading the rows back. `CONTENT` and `reset` now cover `strategy_candidates`, so the existing catch-up and no-look-ahead tests prove the lists too. Without the reset change they would pass vacuously.
- Test behavior, not implementation: the night tests assert stored rows after `paper.execute`, not calls. The one monkeypatch replaces the pure list function, a dependency, to prove the night survives its failure. The expected bracket list is computed from the same pure function on an independently loaded market, and the pure test pins the measured COST, NVDA.
- Encode lessons in structure: 017's `C`/`C-GT` drift came from a hard-coded id. "Who gets a list" is therefore read from the row (`engine`, `is_benchmark`, `twin_of`) and never from an id list, so a method Sera admits later is listed with no code change.

## Verification

**Build:** `cd /home/miftah/.worktrees/seer/seer-adversarial && engine/.venv/bin/ruff check engine`
(First create the worktree's venv if it is missing: `python3 -m venv engine/.venv && engine/.venv/bin/pip install -e 'engine[dev]'`. The worktree has none; any Python ≥ 3.11 works, and the main checkout's venv is 3.12.7.)

**Tests:**
```sh
docker start seer-pg 2>/dev/null || docker run -d --name seer-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16
export PG_TEST_URL=postgresql://postgres:pg@localhost:55432/postgres
cd /home/miftah/.worktrees/seer/seer-adversarial
engine/.venv/bin/pytest engine/tests                       # full suite, -n auto; CI fails if DB tests skip
cd web && npm ci && npx tsc --noEmit && npm test            # invariant 1; phase 1 touches no web file
```

**Proof:**
- Harness: `.claude/skills/verify-seer` (`V=.claude/skills/verify-seer/scripts/verify.sh`, run from the code root).
- Feature-map entries: `.claude/skills/verify-seer/features/engine-night.md`.
- Journeys:
  1. Migration 027 applies on an empty DB and admits A-GT.
     `$V up --no-web --empty`, then `$V doctor RUN`: passes when it prints `database ok ... (27 migrations, strategies: 24)`.
     `$V sql RUN "select id, engine, rules_id, object_name, status, paper_start, twin_of from strategies where id = 'A-GT'"`:
     passes on exactly one row `A-GT | bracket | design-v0-gotrade | STRATEGY_A | active | (null) | (null)`.
     `$V sql RUN "select count(*) from strategies where twin_of is not null"`: passes on `0`.
  2. The C1 tables and the trigger exist.
     `$V sql RUN "select table_name from information_schema.tables where table_schema = current_schema() and table_name in ('strategy_candidates','adversary_verdicts','adversary_marks','adversary_leases') order by 1"`: passes on 4 rows.
     `$V sql RUN "select column_name from information_schema.columns where table_name = 'book_previews' and column_name = 'next_decision_session'"`: passes on 1 row.
     `$V sql RUN "select tgname from pg_trigger where tgname = 'adversary_verdicts_append_only'"`: passes on 1 row.
     `$V sql RUN "select indexname from pg_indexes where indexname = 'strategies_one_active_twin'"`: passes on 1 row.
  3. The roster still replays. `$V engine RUN paper_check`: passes on `paper_check: ok (0 of 24 roster strategies started)`, exit 0.
  4. Append-only verdicts, checks and the C4 lease claim (the harness `sql` is read-only, so this runs through pytest with `PG_TEST_URL`):
     `engine/.venv/bin/pytest -n0 engine/tests/test_adversary_schema.py -v`: passes when all 13 tests pass. Before this phase, every test in it fails with `UndefinedTable`/`UndefinedColumn`.
  5. A paper night writes the lists (no bars in verify-seer, so this runs through pytest on the synthetic world):
     `engine/.venv/bin/pytest -n0 engine/tests/test_paper_command.py -k "list or preview or twin or a_gt" -v`. Passes when these pass:
     `test_a_bracket_night_lists_its_own_ranking_before_any_veto`, `test_a_book_lists_its_rank_and_kickoff_targets_and_never_a_resize`, `test_every_preview_names_the_next_session_its_book_ranks`, `test_a_twin_gets_no_list`, `test_a_failing_list_fails_no_night_and_changes_no_decision`, `test_repick_re_takes_the_list_with_the_decision`, `test_a_gt_starts_steps_and_replays_beside_plain_a`.
     The end state they read back: `strategy_candidates` holds `A` and `C` lists equal to A's own ranking for 2026-09-24 (COST, NVDA), and C has zero orders. Book lists equal their kickoff and 2026-10-01 targets, and RMW-FR has none for the resize-only 2026-09-28. Previews name 2026-09-24, then 2026-10-01, then 2026-11-02. `A-CX` has no list. A-GT starts 2026-09-24 and `paper_check` exits 0.
  6. The cutoff. `engine/.venv/bin/pytest -n0 engine/tests/test_dates.py -k session_open -v`: passes when 2026-11-04 gives 14:30Z, 2026-07-01 gives 13:30Z, and the helper equals the calendar's `market_open` on every 2026–2027 session.
  7. The pure helpers and store: `engine/.venv/bin/pytest -n0 engine/tests/test_paper_candidates.py -v`: all pass.
- Neighbor check: the night itself. `engine/.venv/bin/pytest -n0 engine/tests/test_paper_command.py engine/tests/test_paper_check.py engine/tests/test_paper_evidence.py engine/tests/test_paper_c.py engine/tests/test_veto_command.py engine/tests/test_paper_roster.py engine/tests/test_migrate.py engine/tests/test_demo.py` all pass. The catch-up, no-look-ahead, dry-run and same-night-twice tests now include `strategy_candidates`.
- Cost: none. Every journey is offline, with no `--llm` and no `--net`.

**Exit criteria:** On an empty DB, `verify-seer up --no-web --empty` shows 27 migrations and 24 strategies. `A-GT` is active with no paper clock. The four C1 tables, `twin_of` and `next_decision_session` exist, and the trigger refuses deletes and edits of a verdict. On the synthetic world, a paper night writes A-GT's, A's and C's ranked lists before any veto, and each book's rank and kickoff targets, but no resize-only list. Previews name the next rank session. A-GT starts, steps with deposits and replays clean. `ruff check engine` and the full `pytest engine/tests` pass with `PG_TEST_URL` set.

## Handoffs

- **Phase 2 (R1, R2):** twin rows and their lifecycle (`store.ensure_twins` (with the pure planner `roster.plan_twins`), called in `paper` and
  `promote`), twin wrappers in `roster.from_row`, the one-session lag, `store.objected_between`, and
  `paper_check` for twins. Phase 1 gives it `strategies.twin_of` with the one-active-twin index,
  `adversary_verdicts`, `dates.session_open_utc`, and `paper._reviewable`, which already returns False for
  any row with `twin_of` set. Phase 2's twin stepping must keep calling the same `_step_*` and `_start`
  bodies (or keep `_reviewable` on their path) so twins stay unlisted. Phase 2 adds `twin_of` to
  `store.StrategyRow`, `_STRATEGY_SQL`, the `roster.Row` protocol and `RosterEntry`, then (reconciled:
  one twin mechanism) rewrites `_reviewable(conn, e)` as `_reviewable(e)` reading `e.twin_of` and
  deletes `store.is_twin` with `test_is_twin_reads_the_column`. `is_twin` is a phase-1-only bridge;
  nothing outside `commands/paper.py` may call it. Phase 1 does not touch `StrategyRow`. `test_a_twin_gets_no_list` inserts a hand-made active twin `A-CX` of the world's `A`, so phase 2's
  `ensure_twins` must accept an existing active twin as the original's twin and not create a second one,
  or the partial unique index refuses it.
- **Phase 3 (R3):** `A-GT` appears on the Leaderboard by itself (it is a non-champion, non-benchmark
  active row), named `A · Dip buy`. `looks()` colours by position, so A-GT now takes the 5th colour.
  `features/leaderboard.md` and the demo seed (`web/scripts/seed-demo.mjs`) belong to phase 3. If the demo
  seed starts writing `strategy_candidates`, `demo.DEMO_TABLES` and `tests/test_demo.py` need it too.
- **Phase 4 (R4):** the reviewer reads `strategy_candidates` (by `session_date`, index
  `strategy_candidates_session`) and `book_previews.next_decision_session`. It writes `adversary_verdicts`
  (INSERT; UPDATE of `superseded_by` only, to a LATER id on the same strategy/session/symbol), `adversary_marks`
  and `adversary_leases`. It mirrors `session_open_utc` with the pinned examples. Its integration
  tests must point `SEER_DIR` at this worktree until phase 7 lands Seer. Verdicts must name ORIGINALS. The
  schema does not stop a verdict filed against a twin id; the engine (phase 2) simply never reads one.
- **Phase 7 (R7):** apply 027 to Neon with `python -m seer_engine migrate`. `A-GT` then starts on the
  first paper night after that.
- **Follow-up (no phase):** the runbook's "These six trade" roster table (`docs/runbooks/paper-trading.md:27-37`)
  and README's "20 migrations" (`README.md:364`) were already stale before this change. They are left
  alone here. `engine/package_readme.md` (store/command docs) is for the readme-updater at completion.

## Risks

- The A-GT pin was computed outside the test suite. If `test_digests_are_pinned` disagrees, recompute
  A-GT's digest alone. Every other pin must stay as it is.
- `test_repick_re_takes_the_list_with_the_decision` and the book-list test depend on the synthetic world
  producing non-empty lists, which was measured for A (COST, NVDA on N0) but not for every book. Both
  tests assert non-vacuity (`listed > 0`, `next(...)`), so a vacuous world fails loudly instead of
  passing.
- Explain cost: A-GT adds up to 4 pending orders a night to the paid Explain step.
- Nightly runtime: one more A ranking and one more evidence pass per bracket session decided (A-GT, C-GT).
  That is small next to the bars load.

## Rollback

Code: revert this phase's commit. Database: 027 is additive. If it has reached Neon, do not drop
anything. Add migration 028 that retires `A-GT` (`status='retired'`, `paper_end` = its
`paper_state.last_session`, as 026 does) and leaves the empty or append-only tables in place. Apply 028
before the code revert, because an active row whose object still resolves keeps stepping until it is
retired. Locally: `DROP TABLE adversary_leases, adversary_marks, adversary_verdicts, strategy_candidates;
DROP FUNCTION adversary_verdicts_append_only(); ALTER TABLE book_previews DROP COLUMN
next_decision_session; ALTER TABLE strategies DROP COLUMN twin_of; DELETE FROM strategies WHERE id =
'A-GT'` (the last only where A-GT never started), then remove `027_adversary.sql` from `schema_migrations`.
