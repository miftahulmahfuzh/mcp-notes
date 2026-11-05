> Adopted from `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/plan/SEER_ADVERSARIAL_PLAN.md` phase 5. Source: `.workflows/plan/seer-adversarial/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: mcp-notes API, SSE, MCP tools, scorecard, go-live parity

**Plan set:** `SEER_ADVERSARIAL_PLAN.md`
**Analysis:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Satisfies:** R5 — `/api/adversary/*` + SSE `adversary` + MCP tools `adversary_overview`, `adversary_verdicts`, `adversary_scorecard` + the per-objection scorecard + go-live checklist parity with Seer
**Depends on:** Phase 4 (`AppDeps.adversary: AdversaryService | null`, `src/adversary/{service,events,toggle}.ts`). Phase 1's migration 027 must be in the Seer worktree for the integration tests (invariant 8).
**Difficulty:** HARD
**Package:** mcp-notes `src/adversary/` (read side only), `src/http/`, `src/mcp/`

Work only in `/home/miftah/.worktrees/mcp-notes/seer-adversarial`. The Seer worktree
`/home/miftah/.worktrees/seer/seer-adversarial` is read (its migrations build the test schema; its
`web/lib/{metrics,golive}.ts` are the parity reference). Nothing here writes to Seer.

---

## Goal

After this phase notesd serves the Seer Adversarial read model: an overview of every roster original
with its twin and SPY (money-weighted returns since the twin started, objections, coverage
reviewed · absent · paused, both go-live checklists ported from Seer), a method page (growth-of-100
curves with deposits taken out, side-by-side stats, the decision's verdict cards with weight changes and
"held · sell" / "new · skip", the record of objections, the revisions log), the A / C / A+Claude
three-way, and a scorecard (each objection's horizon return against the kept picks; Claude against C on
disagreement nights). The same data reaches Claude through three read-only MCP tools, the toggle and
"Review now" reach phase 4's reviewer, and reviewer events reach the wall as SSE `event: adversary`.

## Decisions taken in this phase

- **Money-weighted return: port Seer's own, not Modified Dietz.** Verified in the Seer worktree:
  Seer *does* compute one, `engine/src/seer_engine/backtest/metrics.py:191` `money_weighted_return`
  (IRR over the opening equity, every dated deposit and the final mark; bisection from `IRR_LOW =
  -0.9999` with `1e-12` relative tolerance, 200 steps, `1e9` cap; Actual/365.25). It is used for
  backtests. `golive.ts` here ports it line for line (`moneyWeightedReturn`, annual). The page shows
  the **same root expressed over the window** (`periodMoneyWeightedReturn`: discount exponents
  `days / window_days` instead of `days / 365.25`, so `1 + period = (1 + annual)^(window_days/365.25)`),
  because an annualised IRR of a 4-session twin overflows Seer's `1e9` cap (pinned by a unit test).
  Deposits are `paper_contributions` rows with `applied_at IS NOT NULL`, summed per `session_date`
  (Seer's `flow_map`), dated on the session they were credited.
- **Go-live checklist: ported EXACTLY from Seer web, and it is NOT money-weighted.** The brief says the
  checklist "already is" money-weighted; the code says otherwise. `web/lib/metrics.ts`
  `strategyMetrics` uses raw `last/first - 1` and raw-equity drawdown, and the leaderboard's "Beats SPY"
  is `spyOverSpan` (SPY's raw equity over the strategy's span). This phase reproduces those five rules
  and their strings exactly (`seer: {label, val, ok}` on every item), so the wall never disagrees with
  seertrade.site. The honest money measures are shown beside it instead: `returns.*` (period MWR) and
  `worst_drop` (Seer engine's funded-run drawdown on the time-weighted index, `metrics.py:308-319`).
  The mismatch is a Seer finding, recorded in **Handoffs**.
- **Twin vs original alignment:** every comparison runs over the twin's own record `[first, last]`
  snapshot (the twin runs one session behind, D1); original and SPY curves are cut to that window.
  "What the twins made beyond their originals" = the twin's final equity minus what the twin's own
  money would have become at the original's time-weighted growth (`shadowEnd`), so a bigger original
  book is not credited for its size.
- **Scorecard horizon:** bracket = the stock's own 5th bar from the decision session (A's 5-session
  time stop, `BRACKET_HORIZON_SESSIONS = 5`); book = the last bar before the original's next decision
  session in `strategy_candidates` (pending until that decision exists). Return = horizon close /
  the close on the decision's `data_date` − 1 (bars are split-adjusted; dividends ignored). Kept = the
  plain mean over the same decision's candidates Claude did not object to (unsure and agree are kept).
  "same" = within ±0.5 points (`SAME_BAND = 0.005`).
- **C vs Claude:** a night counts when both critics read a symbol (C: `news_vetoes` allow/veto, `failed`
  excluded; Claude: a counted verdict) and they disagree on at least one. Baseline = the mean horizon
  return of that night's names neither blocked (fallback: all that night's names). The blocker is right
  when the stock did worse than the baseline, otherwise the critic that let it in is right; every
  disagreement credits exactly one side.
- **Coverage:** computed in SQL with `session_open_utc` as
  `((d + time '09:30') AT TIME ZONE 'America/New_York')` (DST-correct in Postgres; the integration
  test pins C3's two examples and checks them against phase 4's `sessionOpenUtc`).
- **Wire names follow phase 6's `web/src/adversaryApi.ts`** (`OverviewPayload`, `MethodPayload`,
  `ThreeWay`, `AdversaryVerdict`, `ReviewNowResult`, `ChecklistItem` with `state: 'na'`), as a superset.
  The few places where phase 6 assumed a field this data cannot honestly fill are listed in
  **Handoffs** for the reconciler.
- **review-now does not await the pass.** Phase 4 says `reviewNow` is long ("do not await in a request
  handler"); the route starts it, logs a failure, and answers 202 `{started: true, reason}`.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.

**Creates:**
- `src/adversary/readTypes.ts`: every wire type below.
- `src/adversary/golive.ts`: `MAX_DRAWDOWN`, `MIN_PAPER_MONTHS`, `MIN_PROFIT_FACTOR`, `CHECKLIST_RULES`,
  `YEAR_DAYS`, `MONTH_DAYS`, `MIN_PAPER_MONTHS_LABEL`, `MAX_DRAWDOWN_LABEL`, `IRR_LOW`, `Flow`, `Trade`,
  `Gate`, `parseGate`, `tradeStats`, `spyOverSpan`, `seerGateItem`, `seerChecklist`, `checklistItems`,
  `daysBetween`, `cutCurve`, `flowMap`, `twrIndex`, `drawdownOf`, `solveIrr`, `moneyWeightedReturn`,
  `periodMoneyWeightedReturn`, `shadowEnd`.
- `src/adversary/readSql.ts`: `PAGE_ROWS`, `openAt`, `isoOf`, `countedCte`, `verdictColumns`,
  `verdictJson`, `queryAll`, `records`, `strings`, `pairsOf`, `RosterEntry`, `ROSTER_SQL`,
  `toRosterEntry`, `readRoster`, `NEWS_VETO_OBJECTS`, `cadenceOf`, `shortLabel`, `methodOf`, `Pairing`,
  `RosterView`, `pairRoster`, `findPairing`, `criticOf`, `parseSources`, `toVerdictKind`, `toAdversaryVerdict`,
  `AdversaryReadError`, `AdversaryReadErrorCode`, `isSessionDate`, `assertSession`.
- `src/adversary/scorecard.ts`: `BRACKET_HORIZON_SESSIONS`, `SAME_BAND`, `HorizonRow`, `DuelInputRow`,
  `ObjectionScore`, `toHorizonRow`, `horizonReturn`, `outcomeOf`, `scoreObjections`, `summarize`,
  `recordOf`, `scoreDuel`, `loadObjectionScores`, `loadDuel`.
- `src/adversary/read.ts`: `LATEST_VERDICTS`, `MAX_VERDICTS`, `Market`, `readMarket`, `bookFigures`,
  `ownFigures`, `checklistOf`, `DecisionRow`, `toDecisionRow`, `readDecisions`, `coverageState`,
  `stateOf`, `coverageOf`, `summaryOf`, `latestSession`, `buildRow`, `beyondOriginal`, `causeOf`,
  `curvesOf`, `startedOn`, `monthsOnPaper`, `DecisionInput`, `buildDecision`, `ThreeWayInput`,
  `buildThreeWayRows`, class `AdversaryReader` (`overview`, `method`, `decision`, `daily`,
  `scorecard`, `verdicts`).
- `src/http/adversaryApi.ts`: `adversaryApiRoutes`, `AdversaryApiOptions`, `seerUnavailable`.
- `src/mcp/adversaryTools.ts`: `registerAdversaryTools`.
- `src/chat/status.ts`: `ADVERSARY_TOOL_NAMES`, `AdversaryToolName`.
- `tests/fixtures/adversary/seer-seed.sql` (shared by the integration test and the Proof).
- Tests: `tests/unit/adversary/{golive,golive.parity,scorecard,read}.test.ts`,
  `tests/integration/helpers/adversaryFake.ts`, `tests/integration/connectors/adversary.int.test.ts`,
  `tests/integration/adversary.sse.int.test.ts`.

**HTTP routes (all JSON; errors `{ error: '<code>', ... }`):**

| Route | 200 body | Errors |
|---|---|---|
| `GET /api/adversary/overview` | `OverviewPayload` | 503 `seer_unavailable` |
| `GET /api/adversary/methods/:id` | `MethodPayload` (`:id` any case; a twin id means its original) | 400 `invalid_id`, 404 `not_found`, 503 |
| `GET /api/adversary/methods/:id/decisions/:session` | `AdversaryDecision` | 400 `invalid_id` / `invalid_session`, 404 `not_found`, 503 |
| `GET /api/adversary/daily/:id?session=YYYY-MM-DD` | `ThreeWay` (default session: `latestSession`) | 400 `not_bracket` / `invalid_session`, 404 `not_found` (also: no C sibling), 503 |
| `GET /api/adversary/scorecard/:id` | `ScorecardPayload` | 400, 404, 503 |
| `GET /api/adversary/toggle` | phase 4 `ToggleState` `{on, changed_at, host}` | 503 `reviewer_off` |
| `PUT /api/adversary/toggle` `{on: boolean}` | `ToggleState` | 403 `forbidden_origin`, 400 `invalid_json` / issues, 503 `reviewer_off` |
| `POST /api/adversary/review-now` `{strategy_id?}` | 202 `ReviewNowResult` `{started: true, reason}` | 403, 400, 404 `not_found` (unknown strategy), 503 `reviewer_off` / `seer_unavailable` |

`503 seer_unavailable` body: `{ error: 'seer_unavailable', detail: 'not_reachable' | 'not_migrated' | 'query_failed', reason: string }`.

**SSE:** `GET /api/events` also writes `event: adversary` with data
`{ op: 'verdict' | 'mark' | 'toggle' | 'run', strategy_id: string | null, session_date: string | null }`
for every `AdversaryChange` phase 4 emits.

**MCP tools (readOnlyHint):** `adversary_overview` (no input) → `OverviewPayload`;
`adversary_verdicts({strategy?, session?, verdict?, limit?})` → `VerdictList`;
`adversary_scorecard({strategy})` → `ScorecardPayload`.

**Wire types (`src/adversary/readTypes.ts`, phase 6 mirrors them):** the complete file is Step 1.
Summary of the top-level payloads:
```ts
OverviewPayload  { generated_at, started_on, months_on_paper, spy_id, roster: AdversaryMethod[], methods: MethodRow[], cause: Cause, latest: AdversaryVerdict[], last_review: LastReview | null, reviewer: AdversaryStatus | null }
MethodPayload    { method, row: MethodRow, lens_question: null, curves: Curves | null, stats: {original, twin, spy: BookFigures | null}, checklist: Checklists, decision: AdversaryDecision | null, decisions: DecisionSummary[], record: AdversaryRecord, revisions: Revision[], three_way: ThreeWay | null }
AdversaryDecision{ strategy_id, twin_id, session_date, data_date, kind, open_utc, coverage, first_started_at, last_decided_at, models, prompt_versions, lenses, hosts, counts, all_objected, verdicts: AdversaryVerdict[], picks: DecisionPick[] }
ThreeWay         { original, critic: AdversaryMethod, twin, books: {original, critic, twin: BookFigures | null}, sessions, session_date, open_utc, coverage, rows: ThreeWayRow[], grid: DailyGrid, settled: {claude_right, critic_right, disagreements, scored, pending, nights} | null, duel: CriticDuel | null }
ScorecardPayload { strategy_id, engine, record: AdversaryRecord, duel: CriticDuel | null }
VerdictList      { sessions: {strategy_id, session_date, coverage}[], verdicts: AdversaryVerdict[] }
ReviewNowResult  { started: boolean, reason: string | null }
```

**Signature changes:**
- `ToolDeps` (`src/mcp/tools.ts:14`) gains optional `adversary?: AdversaryService | null`.
- `mcpToolDeps(deps, …)` (`src/http/app.ts:62`) also sets `adversary: deps.adversary`.
- `CreateAppOptions` (`src/http/app.ts:41`) gains optional `adversarySeer?: ReadOnlySource` (test seam).
- `allowedChatTools()` returns 44 names (adds the 3 adversary tools).
- `buildInstructions()` gains an `Adversary.` paragraph immediately before `Sessions.` (Sessions stays last).

**Requires (from earlier phases):**
- Phase 4, exactly as its plan's "Public API for phase 5":
  `AppDeps.adversary: AdversaryService | null` (`src/deps.ts`, required; every hand-built AppDeps
  literal already has `adversary: null`); `class AdversaryService` (`src/adversary/service.ts`) with
  `readonly events: AdversaryEvents`, `readonly host: string`,
  `reviewNow(options?: ReviewNowOptions): Promise<RunSummary>` (long-running, serialised),
  `getToggle(): Promise<ToggleState>`, `setToggle(on: boolean, host: string): Promise<ToggleState>`
  (emits op `toggle`), `status(): Promise<AdversaryStatus>` (`running: 'auto' | 'manual' | null`);
  exported types `ReviewNowOptions`, `RunSummary`, `AdversaryStatus` (`service.ts`), `ToggleState`
  (`toggle.ts`), `AdversaryEvents`, `AdversaryChange` (`events.ts`; `on(listener) -> unsubscribe`,
  `emit({op, strategy_id?, session_date?})`, `listenerCount()`), `sessionOpenUtc(sessionDate): Date`
  (`sessions.ts`).
- Phase 1: migration 027 with C1's column names; `strategy_candidates.weight` NULL for bracket rows;
  the append-only trigger allows `UPDATE … SET superseded_by` and does not block `TRUNCATE` (the
  fixture and the connector harness both truncate). Phase 1's exact rule (reconciled): an UPDATE
  passes only when it moves `superseded_by` from NULL to the id of a row with a GREATER id and the
  same `(strategy_id, session_date, symbol)`, changing nothing else; DELETE is refused; TRUNCATE is
  not blocked. The Step 16 fixture's `UPDATE adversary_verdicts SET superseded_by = 2 WHERE id = 1`
  satisfies it (rows 1 and 2 are both `A-GT` / `2026-10-05` / `AAA`, and 2 > 1); any fixture row
  added later must keep to the same rule or the seed raises P0001.
- Phase 2 (run time only): twin rows `<ORIG>-CX` with `twin_of`, decided one session late. Tests seed
  their own twin rows.
- Phase 3 (parity test only, optional): Seer's `gateItem` returns `{label: 'Backtest gate', val: "Can't be run", ok: false}`
  for a twin; the parity test checks it only once `gate.twin` exists in Seer's `metrics.ts`.

**Leaves alone (owned by others):** `web/**` (phase 6); every phase 4 file under `src/adversary/`
(`config/types/sessions/events/toggle/plan/lens/prompt/seerReader/seerWriter/tools/agent/reviewsRepo/service`);
`src/deps.ts`, `src/config.ts`, `src/background.ts`, `src/daemon.ts` (phase 4); the connector guard
(`src/connectors/guard.ts`, `pg.ts`, `sql.ts`); `.claude/skills/verify-notesd/scripts/verify.sh`
(phase 4 adds `--adversary`); README configuration table (phase 7); every Seer file.

## Files

| File | Action | What changes |
|---|---|---|
| `src/adversary/readTypes.ts` | create | wire types |
| `src/adversary/golive.ts` | create | Seer checklist port, MWR port, time-weighted index, shadow growth |
| `src/adversary/readSql.ts` | create | SQL fragments, paging, roster, verdict parsing, errors |
| `src/adversary/scorecard.ts` | create | horizon returns, record, C-vs-Claude duel |
| `src/adversary/read.ts` | create | read model + `AdversaryReader` |
| `src/http/adversaryApi.ts` | create | routes |
| `src/http/app.ts:1-22, 41-51, 62-81, 112-113` | modify | import, option, `mcpToolDeps.adversary`, mount before `staticRoutes` |
| `src/http/api.ts:1-28, 271-302` | modify | SSE relay `event: adversary` |
| `src/mcp/adversaryTools.ts` | create | three tools |
| `src/mcp/tools.ts:14-34` | modify | `ToolDeps.adversary` |
| `src/mcp/server.ts:1-27` | modify | register the tools |
| `src/mcp/instructions.ts:57-58` | modify | `Adversary.` paragraph before `Sessions.` |
| `src/chat/status.ts:42-50, 64-71, 134-145` | modify | names, allow-list, captions |
| `README.md:981-992, 1030, 1067` | modify | MCP and HTTP tables, `/api/events` row |
| `.claude/skills/verify-notesd/features/adversary.md` | modify (phase 4 creates it) | API / MCP / SSE section |
| `.claude/skills/verify-notesd/features/README.md` | modify (phase 4 adds the row) | extend the adversary row's cells with API, MCP, SSE |
| `tests/fixtures/adversary/seer-seed.sql` | create | seeded Seer data after 027 |
| `tests/unit/adversary/golive.test.ts` | create | checklist, MWR, index |
| `tests/unit/adversary/golive.parity.test.ts` | create | constants equal Seer web's (skips without SEER_DIR) |
| `tests/unit/adversary/scorecard.test.ts` | create | horizon, outcomes, duel |
| `tests/unit/adversary/read.test.ts` | create | roster pairing, coverage, decision cards, cause |
| `tests/unit/chat-status.test.ts:7-28` | modify | counts and captions |
| `tests/unit/mcp.instructions.test.ts` (append) | modify | Adversary paragraph |
| `tests/integration/helpers/adversaryFake.ts` | create | fake `AdversaryService` over the real `AdversaryEvents` |
| `tests/integration/connectors/adversary.int.test.ts` | create | reader + HTTP + MCP on the seeded schema |
| `tests/integration/adversary.sse.int.test.ts` | create | SSE relay |

## Implementation Steps

### Step 0: Prerequisites
**File:** none (shell)
**Change:** phase 4 must have landed in this worktree (`ls src/adversary/service.ts src/adversary/events.ts src/adversary/toggle.ts src/adversary/sessions.ts`
prints four files, and `grep -n "adversary: AdversaryService | null" src/deps.ts` matches). Phase 1 must
be in the Seer worktree (`ls /home/miftah/.worktrees/seer/seer-adversarial/db/migrations/027_*.sql`).
If `node_modules` is missing, `npm ci`. Stop if either phase is missing.
**Impact:** none.

### Step 1: Wire types
**File:** `src/adversary/readTypes.ts` (new)
**Code:**
```ts
import type { AdversaryStatus } from './service.js';

/**
 * Wire shapes of GET /api/adversary/* and the adversary_* MCP tools (SEER_ADVERSARIAL_PLAN phase 5).
 * The wall page (phase 6) mirrors them in web/src/adversaryApi.ts; the names follow that file.
 * Every number is computed from Seer's database, never from model prose (brief §5).
 * Fractions: 0.054 = +5.4%. Points: percentage points. Money: USD. Dates: YYYY-MM-DD NYSE sessions.
 * Times: ISO 8601 UTC with milliseconds.
 */

export type Engine = 'bracket' | 'book' | 'benchmark';
export type VerdictKind = 'agree' | 'object' | 'unsure';
/** C's own verdicts (news_vetoes.verdict). `failed` means no trade for C and is not a call. */
export type CVerdict = 'allow' | 'veto' | 'failed';
/** 'na': the rule cannot apply (a twin's backtest, or C's). Never counts as passed. */
export type CheckState = 'pass' | 'fail' | 'na';
export type CheckKey = 'months' | 'beats_spy' | 'profit_factor' | 'max_drawdown' | 'backtest';
/**
 * One decision (strategy, session): 'pending' until the session opens; then 'reviewed' when at least
 * one verdict was decided before the open, else 'paused' when the owner's toggle was off
 * (adversary_marks), else 'absent'. A late verdict leaves the decision absent (D12).
 */
export type CoverageState = 'reviewed' | 'absent' | 'paused' | 'pending';
export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly';
export type ScoreOutcome = 'worse' | 'same' | 'better';

export interface AdversarySource {
  url: string;
  title: string | null;
  publisher: string | null;
  published_at: string | null;
  fetched_at: string | null;
}

export interface AdversaryVerdict {
  id: number;
  /** The ORIGINAL strategy id, never the twin's. */
  strategy_id: string;
  session_date: string;
  symbol: string;
  /** Rank in the decision's candidate list; null when the symbol is not on it. */
  rank: number | null;
  verdict: VerdictKind;
  reason: string;
  sources: AdversarySource[];
  lens: string;
  model: string;
  prompt_version: string;
  host: string;
  started_at: string;
  decided_at: string;
  /** Decided at or after the session's open: kept for the record, never used by the twin. */
  late: boolean;
  /** In a decision of a book: the original's target weight. Null outside a decision and for brackets. */
  weight: number | null;
  /** In a decision of a book: the twin's weight (its own book_targets once it decided, else the pro-rata expectation). */
  twin_weight: number | null;
  twin_weight_source: 'twin_book' | 'expected' | null;
  /** In a decision of a book: the original held it before, so an objection is a sale. Null otherwise. */
  held: boolean | null;
  /** A counted objection only: 'sell' (a held book name) or 'skip' (a new name, or any bracket pick). */
  action: 'sell' | 'skip' | null;
}

/** One original on Seer's roster (never a twin, the benchmark or C). */
export interface AdversaryMethod {
  strategy_id: string;
  /** Its Claude twin: the active one, else the newest retired one; null before phase 2 creates it. */
  twin_id: string | null;
  name: string;
  /** The name's head, 'RAW35 · Momentum' -> 'RAW35' (Seer web shortLabel). */
  short: string;
  sub: string | null;
  engine: 'bracket' | 'book';
  cadence: Cadence | null;
  status: 'active' | 'retired';
  paper_start: string | null;
  paper_end: string | null;
}

/** Seer web's CheckItem for the same rule, byte for byte (web/lib/metrics.ts checklist + gateItem). */
export interface SeerCheck {
  label: string;
  val: string;
  ok: boolean;
}

export interface ChecklistItem {
  rule: 1 | 2 | 3 | 4 | 5;
  key: CheckKey;
  /** Plain words for the page: '18 months on paper', 'beats SPY', 'wins ÷ losses ≥ 1.3', 'worst drop ≤ 25%', '10-year backtest'. */
  label: string;
  state: CheckState;
  /** Display value from DB numbers: '7.0 of 18 mo', '+2.9 pts', '2.04', '11.2%', 'failed', "can't be run". */
  value: string | null;
  /** Rule 1 only: share of the 18 months done, 0..1. */
  progress: number | null;
  seer: SeerCheck;
}

export interface Checklists {
  original: ChecklistItem[];
  /** Empty when the method has no twin yet. */
  twin: ChecklistItem[];
}

/** One book over a window: the twin's record for originals and SPY, or the book's own record. */
export interface BookFigures {
  strategy_id: string;
  from: string;
  to: string;
  sessions: number;
  /** Money-weighted return over the window, deposits included (the period form of Seer's IRR). */
  return: number | null;
  /** Seer's money_weighted_return (annualised IRR) over the same window; null when it overflows. */
  mwr_annual: number | null;
  /** Deposits credited inside (from, to]. */
  deposits_usd: number;
  /** End equity - start equity - deposits. */
  gain_usd: number | null;
  /** Deepest fall of the time-weighted index (deposits taken out), as a fraction. */
  worst_drop: number | null;
  /** Closed trades that exited inside (from, to]. */
  trades: number;
  /** Gross win / gross loss of those trades; 'infinite' with no losing trade; null with none. */
  profit_factor: number | 'infinite' | null;
  /** book_fills.cost_usd inside (from, to]; null for brackets (Seer stores no per-order fee). */
  fees_usd: number | null;
}

/** Money-weighted returns since the twin started. */
export interface Returns {
  original: number | null;
  twin: number | null;
  spy: number | null;
}

export interface Objections {
  /** Counted objections on settled (reviewed) decisions. */
  objected: number;
  /** Counted verdicts on settled decisions (stocks reviewed). */
  reviewed: number;
  /** Objections whose stock did worse than the kept picks over the horizon; null before any is scored. */
  fell_after: number | null;
  scored: number;
  pending: number;
}

export interface Coverage {
  decisions: number;
  reviewed: number;
  absent: number;
  /** Absent decisions that do have a verdict, decided after the open. */
  late: number;
  paused: number;
  pending: number;
}

export interface TwinWindow {
  from: string;
  to: string;
  sessions: number;
}

export interface MethodRow extends AdversaryMethod {
  /** The twin's record; every figure below is over it. Null before the twin has a snapshot. */
  window: TwinWindow | null;
  returns: Returns;
  figures: { original: BookFigures | null; twin: BookFigures | null; spy: BookFigures | null };
  /** Twin's end equity minus what its own money would have made at the original's time-weighted growth. */
  beyond_original_usd: number | null;
  objections: Objections;
  coverage: Coverage;
  checklist: Checklists;
}

export interface Cause {
  twins: number;
  twins_beat_spy: string[];
  originals_beat_spy: string[];
  /** Sum of beyond_original_usd over the active twins. */
  extra_profit_usd: number | null;
  /** Mean of (twin worst drop - original worst drop) x 100; negative = the twins fell less. */
  drawdown_delta_pts: number | null;
}

export interface LastReview {
  strategy_id: string;
  session_date: string;
  /** Distinct symbols with a verdict for that decision. */
  picks: number;
  finished_at: string;
}

export interface OverviewPayload {
  generated_at: string;
  /** Earliest first snapshot among active twins: month N of 18 counts from here. */
  started_on: string | null;
  months_on_paper: number | null;
  spy_id: string | null;
  /** Every original: active in Seer sort order, then retired, newest paper_end first. */
  roster: AdversaryMethod[];
  /** Active originals that have a twin. */
  methods: MethodRow[];
  cause: Cause;
  /** At most 8 counted object/unsure verdicts, newest decided_at first. */
  latest: AdversaryVerdict[];
  last_review: LastReview | null;
  /** Phase 4's reviewer status on this machine; null when NOTESD_ADVERSARY=off. */
  reviewer: AdversaryStatus | null;
}

/** Growth of 100, deposits taken out, one value per date (null where a series has no snapshot). */
export interface Curves {
  dates: string[];
  original: (number | null)[];
  twin: (number | null)[];
  spy: (number | null)[];
}

export interface DecisionSummary {
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  open_utc: string;
  coverage: CoverageState;
  picks: number;
  object: number;
  unsure: number;
  agree: number;
  late: number;
}

export interface DecisionPick {
  rank: number;
  symbol: string;
  weight: number | null;
  held: boolean | null;
  twin_weight: number | null;
  twin_weight_source: 'twin_book' | 'expected' | null;
  /** The counted verdict, else the latest late one, else null (nobody reviewed it). */
  verdict: AdversaryVerdict | null;
}

export interface AdversaryDecision {
  strategy_id: string;
  twin_id: string | null;
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  open_utc: string;
  coverage: CoverageState;
  /** Over counted verdicts only. */
  first_started_at: string | null;
  last_decided_at: string | null;
  models: string[];
  prompt_versions: string[];
  lenses: string[];
  hosts: string[];
  counts: { object: number; unsure: number; agree: number; none: number; late: number };
  /** A book decision whose every target was objected (D6: the twin then does what the original does for an empty decision). */
  all_objected: boolean;
  /** Each pick's shown verdict, in rank order. */
  verdicts: AdversaryVerdict[];
  picks: DecisionPick[];
}

export interface RecordPoint {
  symbol: string;
  session_date: string;
  rank: number;
  /** (stock return - kept picks' mean return) x 100 over the horizon; below 0 means Claude was right. */
  gap_pts: number;
  outcome: ScoreOutcome;
  stock_return: number;
  kept_return: number;
  kept: number;
  horizon_from: string | null;
  horizon_to: string | null;
  sessions: number | null;
  fell: boolean;
}

export interface RecordSummary {
  objections: number;
  scored: number;
  worse: number;
  same: number;
  better: number;
  pending: number;
  /** Scored objections whose stock lost money over the horizon. */
  fell: number;
  mean_gap_pts: number | null;
}

export interface AdversaryRecord {
  /** Plain words: 'the 5 sessions after the decision', 'until the next rebalance'. */
  horizon: string;
  horizon_sessions: number | null;
  same_band_pts: number;
  /** Scored objections, oldest first. */
  points: RecordPoint[];
  /** Objections whose horizon has not passed yet. */
  pending: { symbol: string; session_date: string }[];
  summary: RecordSummary;
}

export interface Revision {
  /** First decided_at with this prompt_version, model and lens. */
  since: string;
  /** Last decided_at of a revision a newer one replaced; null for the newest. */
  until: string | null;
  prompt_version: string;
  model: string;
  lens: string;
  verdicts: number;
  /** No change note is stored anywhere yet (see Handoffs); always null. */
  note: string | null;
}

export interface DuelRow {
  session_date: string;
  symbol: string;
  rank: number;
  c: 'allow' | 'veto';
  claude: VerdictKind;
  blocked_by: 'critic' | 'claude';
  stock_return: number | null;
  baseline: number | null;
  right: 'critic' | 'claude' | null;
}

export interface CriticDuel {
  critic_id: string;
  nights: number;
  disagreements: number;
  scored: number;
  claude_right: number;
  critic_right: number;
  pending: number;
  rows: DuelRow[];
}

export interface ThreeWayRow {
  rank: number;
  symbol: string;
  c: { verdict: CVerdict; reason: string; decided_at: string } | null;
  /** The counted verdict, else the latest late one (late: true). */
  claude: AdversaryVerdict | null;
  /** Did each book place an order for this name for this session? null = that book has not decided it yet (the twin decides one night late). */
  buys: { original: boolean | null; critic: boolean | null; twin: boolean | null };
}

export interface DailyGrid {
  c_veto_claude_object: string[];
  c_veto_claude_keep: string[];
  c_allow_claude_object: string[];
  c_allow_claude_keep: string[];
}

export interface ThreeWay {
  original: AdversaryMethod;
  critic: AdversaryMethod;
  twin_id: string | null;
  /** Each book over its own whole record. */
  books: { original: BookFigures | null; critic: BookFigures | null; twin: BookFigures | null };
  /** Decision sessions with candidates, newest first. */
  sessions: string[];
  session_date: string | null;
  open_utc: string | null;
  coverage: CoverageState | null;
  rows: ThreeWayRow[];
  grid: DailyGrid;
  /** Null until at least one disagreement's horizon has passed. */
  settled: { claude_right: number; critic_right: number; disagreements: number; scored: number; pending: number; nights: number } | null;
  duel: CriticDuel;
}

export interface MethodPayload {
  method: AdversaryMethod;
  row: MethodRow;
  /** The lens is built by phase 4 and not stored in Seer; always null in this phase (see Handoffs). */
  lens_question: string | null;
  curves: Curves | null;
  stats: { original: BookFigures | null; twin: BookFigures | null; spy: BookFigures | null };
  checklist: Checklists;
  /** The newest pending or reviewed decision, else the newest decision. */
  decision: AdversaryDecision | null;
  /** Every decision, newest first. */
  decisions: DecisionSummary[];
  record: AdversaryRecord;
  revisions: Revision[];
  /** Bracket originals with a C sibling only. */
  three_way: ThreeWay | null;
}

export interface ScorecardPayload {
  strategy_id: string;
  engine: 'bracket' | 'book';
  record: AdversaryRecord;
  duel: CriticDuel | null;
}

export interface VerdictList {
  sessions: { strategy_id: string; session_date: string; coverage: CoverageState }[];
  verdicts: AdversaryVerdict[];
}

export interface ReviewNowResult {
  started: boolean;
  reason: string | null;
}
```
**Impact:** none (types only).

### Step 2: Go-live parity and money measures
**File:** `src/adversary/golive.ts` (new)
**Code:**
```ts
/**
 * Go-live parity and money measures for Seer Adversarial, ported from Seer (read, never imported):
 *   ~/seer/web/lib/metrics.ts                     checklist(), gateItem() (phase 3 adds the twin's rule 5)
 *   ~/seer/web/lib/golive.ts                      MAX_DRAWDOWN, MIN_PAPER_MONTHS and their labels
 *   ~/seer/web/app/(app)/leaderboard/view.ts      spyOverSpan()
 *   ~/seer/engine/src/seer_engine/backtest/metrics.py  money_weighted_return(), flow_map(), and the
 *                                                 funded-run drawdown on the time-weighted index
 * strategyMetrics() itself is src/connectors/seer/ranking.ts sinceStartMetrics(), already a port.
 *
 * Seer's web checklist is NOT money-weighted: total return is raw last/first - 1 and the drawdown is on
 * raw equity, deposits included. It is reproduced exactly so the wall never disagrees with Seer; the
 * honest money measures (period money-weighted return, time-weighted drawdown) are separate functions.
 * tests/unit/adversary/golive.parity.test.ts reads Seer's files and fails when these constants drift.
 * Pure: no I/O.
 */
import { byDate, type SinceStart, type Snapshot, type TradeStats } from '../connectors/seer/ranking.js';
import { json } from '../connectors/seer/rows.js';
import type { CheckKey, CheckState, ChecklistItem, SeerCheck } from './readTypes.js';

export const MAX_DRAWDOWN = 0.25;
export const MIN_PAPER_MONTHS = 18;
export const MIN_PROFIT_FACTOR = 1.3;
export const CHECKLIST_RULES = 5;
export const YEAR_DAYS = 365.25;
export const MONTH_DAYS = 30.44;
const DAY_MS = 86_400_000;
const DASH = '—';
const MINUS = '−';

export const MIN_PAPER_MONTHS_LABEL = `≥ ${MIN_PAPER_MONTHS} months forward`;
export const MAX_DRAWDOWN_LABEL = `Max drawdown ≤ ${(Math.abs(MAX_DRAWDOWN) * 100).toFixed(0)}%`;

/** A deposit (or a fee), dated by the NYSE session it was applied on. */
export interface Flow {
  date: string;
  amount: number;
}

/** One closed trade: its exit session (null when Seer stored none) and its P/L in USD. */
export interface Trade {
  date: string | null;
  pnl: number;
}

/** strategies.params->'backtest_gate', plus whether the row is a Claude twin (strategies.twin_of). */
export interface Gate {
  passed: boolean;
  applicable: boolean;
  twin: boolean;
}

/** Seer web lib/strategy.ts parseGate, plus the twin flag. A pass is never assumed. */
export function parseGate(raw: unknown, twin: boolean): Gate {
  const value = json(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { passed: false, applicable: true, twin };
  const g = value as Record<string, unknown>;
  const applicable = g.applicable !== false;
  return { passed: applicable && g.passed === true, applicable, twin };
}

/** Seer's wins / losses split: a win is pnl > 0, a loss pnl <= 0; sums left to right from 0. */
export function tradeStats(pnls: readonly number[]): TradeStats {
  let wins = 0;
  let grossWin = 0;
  let losses = 0;
  for (const p of pnls) {
    if (p > 0) {
      wins += 1;
      grossWin += p;
    } else {
      losses += p;
    }
  }
  return { trades: pnls.length, wins, grossWin, grossLoss: -losses };
}

/** view.ts spyOverSpan: SPY's raw return between the curve's first and last snapshot dates. */
export function spyOverSpan(spy: readonly Snapshot[], curve: readonly Snapshot[]): number | null {
  if (curve.length < 2) return null;
  const c = [...curve].sort(byDate);
  const on = new Map(spy.map((p) => [p.date, p.equity] as const));
  const a = on.get(c[0]!.date);
  const b = on.get(c[c.length - 1]!.date);
  return a === undefined || b === undefined || a === 0 ? null : b / a - 1;
}

/** metrics.ts gateItem with phase 3's twin rule: a twin's backtest can never be run. */
export function seerGateItem(gate: Gate): SeerCheck {
  if (gate.twin) return { label: 'Backtest gate', val: "Can't be run", ok: false };
  return gate.applicable
    ? { label: 'Backtest gate passed', val: gate.passed ? 'Passed' : 'Not passed', ok: gate.passed }
    : { label: 'Backtest gate', val: 'Not applicable', ok: false };
}

/** metrics.ts checklist, line for line: the five go-live rules with Seer's own strings. */
export function seerChecklist(m: SinceStart, spyReturn: number | null, gate: Gate): SeerCheck[] {
  const ret = m.totalReturn ?? 0;
  const p1 = (v: number): string => (v >= 0 ? '+' : MINUS) + Math.abs(v * 100).toFixed(1);
  const pf = m.profitFactor;
  return [
    {
      label: MIN_PAPER_MONTHS_LABEL,
      val: `${(Math.floor(m.months * 10) / 10).toFixed(1)} mo`,
      ok: m.months >= MIN_PAPER_MONTHS,
    },
    {
      label: 'Beats SPY',
      val: spyReturn === null ? DASH : `${p1(ret)} vs ${p1(spyReturn)}`,
      ok: m.totalReturn !== null && spyReturn !== null && ret > spyReturn,
    },
    {
      label: `Profit factor ≥ ${MIN_PROFIT_FACTOR}`,
      val: pf === null ? DASH : pf === Infinity ? '∞' : pf.toFixed(2),
      ok: (pf ?? 0) >= MIN_PROFIT_FACTOR,
    },
    {
      label: MAX_DRAWDOWN_LABEL,
      val: m.maxDrawdown === null ? DASH : `${(m.maxDrawdown * 100).toFixed(1)}%`,
      ok: m.maxDrawdown !== null && m.maxDrawdown <= MAX_DRAWDOWN,
    },
    seerGateItem(gate),
  ];
}

const KEYS: readonly CheckKey[] = ['months', 'beats_spy', 'profit_factor', 'max_drawdown', 'backtest'];

/** The page's checklist: Seer's verdicts (`seer`, `state`) with plain labels and display values. */
export function checklistItems(m: SinceStart, spyReturn: number | null, gate: Gate): ChecklistItem[] {
  const seer = seerChecklist(m, spyReturn, gate);
  const signed = (v: number, dp: number): string => `${v >= 0 ? '+' : MINUS}${Math.abs(v).toFixed(dp)}`;
  const pf = m.profitFactor;
  const page: { label: string; value: string | null; progress: number | null }[] = [
    {
      label: `${MIN_PAPER_MONTHS} months on paper`,
      value: `${(Math.floor(m.months * 10) / 10).toFixed(1)} of ${MIN_PAPER_MONTHS} mo`,
      progress: Math.max(0, Math.min(1, m.months / MIN_PAPER_MONTHS)),
    },
    {
      label: 'beats SPY',
      value: m.totalReturn === null || spyReturn === null ? null : `${signed((m.totalReturn - spyReturn) * 100, 1)} pts`,
      progress: null,
    },
    {
      label: `wins ÷ losses ≥ ${MIN_PROFIT_FACTOR}`,
      value: pf === null ? null : pf === Infinity ? '∞' : pf.toFixed(2),
      progress: null,
    },
    {
      label: `worst drop ≤ ${(MAX_DRAWDOWN * 100).toFixed(0)}%`,
      value: m.maxDrawdown === null ? null : `${(m.maxDrawdown * 100).toFixed(1)}%`,
      progress: null,
    },
    {
      label: '10-year backtest',
      value: gate.twin ? "can't be run" : !gate.applicable ? 'not applicable' : gate.passed ? 'passed' : 'failed',
      progress: null,
    },
  ];
  return seer.map((s, i) => {
    const notApplicable = i === 4 && (gate.twin || !gate.applicable);
    const state: CheckState = notApplicable ? 'na' : s.ok ? 'pass' : 'fail';
    const p = page[i]!;
    return { rule: (i + 1) as ChecklistItem['rule'], key: KEYS[i]!, label: p.label, state, value: p.value, progress: p.progress, seer: s };
  });
}

/** Whole calendar days from a to b (YYYY-MM-DD, parsed as UTC midnights). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

/** The snapshots dated inside [from, to], ascending. */
export function cutCurve(curve: readonly Snapshot[], from: string, to: string): Snapshot[] {
  return curve.filter((s) => s.date >= from && s.date <= to).sort(byDate);
}

/** metrics.py flow_map: total per session (several deposits on one session are summed). */
export function flowMap(flows: readonly Flow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of flows) out.set(f.date, (out.get(f.date) ?? 0) + f.amount);
  return out;
}

/**
 * metrics.py's time-weighted wealth index for a funded run: 1 on the first snapshot, then
 * index *= equity / (previous equity + the deposit credited that session). A session whose base is not
 * positive leaves the index where it was.
 */
export function twrIndex(snaps: readonly Snapshot[], flows: readonly Flow[]): number[] {
  const f = flowMap(flows);
  const out: number[] = [];
  let index = 1;
  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i]!;
    if (i > 0) {
      const base = snaps[i - 1]!.equity + (f.get(cur.date) ?? 0);
      if (base > 0) index *= cur.equity / base;
    }
    out.push(index);
  }
  return out;
}

/** Largest (peak - value) / peak; null for an empty series. */
export function drawdownOf(index: readonly number[]): number | null {
  if (index.length === 0) return null;
  let peak = -Infinity;
  let dd = 0;
  for (const v of index) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd;
}

export const IRR_LOW = -0.9999;
const IRR_TOL = 1e-12;
const IRR_MAX_RATE = 1e9;
const IRR_MAX_STEPS = 200;

function npv(rate: number, times: readonly number[], amounts: readonly number[]): number {
  const base = 1 + rate;
  let total = 0;
  for (let i = 0; i < times.length; i++) total += amounts[i]! * base ** -times[i]!;
  return total;
}

/** metrics.py's bisection, constant for constant: null when the bracket does not close. */
export function solveIrr(times: readonly number[], amounts: readonly number[]): number | null {
  let low = IRR_LOW;
  if (!(npv(low, times, amounts) > 0)) return null;
  let high = 1;
  while (npv(high, times, amounts) >= 0) {
    high *= 2;
    if (high > IRR_MAX_RATE) return null;
  }
  let steps = 0;
  while (high - low > IRR_TOL * (1 + Math.abs(low)) && steps < IRR_MAX_STEPS) {
    const middle = (low + high) / 2;
    if (npv(middle, times, amounts) > 0) low = middle;
    else high = middle;
    steps += 1;
  }
  return (low + high) / 2;
}

interface Cashflows {
  days: number[];
  amounts: number[];
  span: number;
}

/**
 * The opening equity (money in), each positive deposit inside (first, last] (money in), the final mark.
 * Seer raises on a deposit outside the window; callers here pass every deposit of the strategy and
 * this keeps only the ones inside it.
 */
function cashflows(snaps: readonly Snapshot[], flows: readonly Flow[]): Cashflows | null {
  if (snaps.length < 2) return null;
  const first = snaps[0]!;
  const last = snaps[snaps.length - 1]!;
  const span = daysBetween(first.date, last.date);
  if (span <= 0 || !(first.equity > 0) || last.equity < 0) return null;
  const days: number[] = [0];
  const amounts: number[] = [-first.equity];
  const merged = [...flowMap(flows)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [date, amount] of merged) {
    if (!(date > first.date && date <= last.date)) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    days.push(daysBetween(first.date, date));
    amounts.push(-amount);
  }
  days.push(span);
  amounts.push(last.equity);
  return { days, amounts, span };
}

/** metrics.py money_weighted_return: the annual rate (Actual/365.25) a savings account would have paid. */
export function moneyWeightedReturn(snaps: readonly Snapshot[], flows: readonly Flow[]): number | null {
  const cf = cashflows(snaps, flows);
  return cf === null ? null : solveIrr(cf.days.map((d) => d / YEAR_DAYS), cf.amounts);
}

/**
 * The same root expressed over the window: (1 + annual)^(span / 365.25) - 1, solved directly with
 * exponents days / span so a short window never overflows the 1e9 cap the annual form hits.
 */
export function periodMoneyWeightedReturn(snaps: readonly Snapshot[], flows: readonly Flow[]): number | null {
  const cf = cashflows(snaps, flows);
  return cf === null ? null : solveIrr(cf.days.map((d) => d / cf.span), cf.amounts);
}

/**
 * What the twin's own money would have become at the original's time-weighted growth: start from the
 * twin's first equity, add the twin's deposits on each of its sessions, and grow by the original's
 * index step between the same two dates. Null when the original lacks a snapshot on a twin date.
 */
export function shadowEnd(
  original: readonly Snapshot[],
  originalFlows: readonly Flow[],
  twin: readonly Snapshot[],
  twinFlows: readonly Flow[],
): number | null {
  const start = twin[0];
  if (start === undefined) return null;
  const index = twrIndex(original, originalFlows);
  const at = new Map(original.map((s, i) => [s.date, index[i]!] as const));
  const tf = flowMap(twinFlows);
  let value = start.equity;
  for (let i = 1; i < twin.length; i++) {
    const a = at.get(twin[i - 1]!.date);
    const b = at.get(twin[i]!.date);
    if (a === undefined || b === undefined || a === 0) return null;
    value = (value + (tf.get(twin[i]!.date) ?? 0)) * (b / a);
  }
  return value;
}
```
**Impact:** none on existing code (new module; reuses `ranking.ts` types and `rows.ts` `json`).

### Step 3: Shared SQL, roster and verdict parsing
**File:** `src/adversary/readSql.ts` (new)
**Code:**
```ts
/**
 * Shared pieces of the Seer Adversarial read model (phase 5): SQL fragments, paging, the roster and
 * verdict parsing. Every query goes through a connector ReadOnlySource (a READ ONLY transaction on the
 * direct host from SEER_DIR/.env.local, re-read per call). Nothing here writes; phase 4's SeerWriter is
 * the only writer of the adversary tables. Rows are parsed once here and trusted downstream.
 */
import { engineOf, statusOf, type Engine, type StrategyStatus } from '../connectors/seer/ranking.js';
import { bool, json, num, numOrNull, str, strOrNull, toObjects, ymdOrNull, type Row } from '../connectors/seer/rows.js';
import type { ReadOnlySource } from '../connectors/types.js';
import type { AdversaryMethod, AdversarySource, AdversaryVerdict, Cadence, VerdictKind } from './readTypes.js';

/** The connector's row cap (CONNECTOR_MAX_ROWS); queryAll pages past it. */
export const PAGE_ROWS = 1000;
const MAX_PAGES = 100;

/** session_open_utc(d) (C3): 09:30 America/New_York on d, as timestamptz. Postgres applies DST. */
export function openAt(dateExpr: string): string {
  return `(((${dateExpr})::date + time '09:30') AT TIME ZONE 'America/New_York')`;
}

/** A timestamptz as ISO 8601 UTC with milliseconds, independent of the session TimeZone. */
export function isoOf(expr: string): string {
  return `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * CTE `counted`: per (strategy, session, symbol) the verdict the engine reads (C3): the greatest
 * decided_at before the session's open. superseded_by is history only and is not consulted.
 */
export function countedCte(filter: string): string {
  return `counted AS (
  SELECT DISTINCT ON (v.strategy_id, v.session_date, v.symbol) v.*
  FROM adversary_verdicts v
  WHERE v.decided_at < ${openAt('v.session_date')} AND (${filter})
  ORDER BY v.strategy_id, v.session_date, v.symbol, v.decided_at DESC, v.id DESC
)`;
}

/** The verdict columns every card needs, from table alias `a`. */
export function verdictColumns(a: string): string {
  return `${a}.id, ${a}.strategy_id, ${a}.session_date::text AS session_date, ${a}.symbol, ${a}.verdict, ${a}.reason,
  ${a}.sources, ${a}.lens, ${a}.model, ${a}.prompt_version, ${a}.host,
  ${isoOf(`${a}.started_at`)} AS started_at, ${isoOf(`${a}.decided_at`)} AS decided_at,
  (${a}.decided_at >= ${openAt(`${a}.session_date`)}) AS late`;
}

/** The same columns as one json object, for json_agg inside a one-row query. */
export function verdictJson(a: string): string {
  return `json_build_object(
    'id', ${a}.id, 'strategy_id', ${a}.strategy_id, 'session_date', ${a}.session_date::text, 'symbol', ${a}.symbol,
    'verdict', ${a}.verdict, 'reason', ${a}.reason, 'sources', ${a}.sources, 'lens', ${a}.lens, 'model', ${a}.model,
    'prompt_version', ${a}.prompt_version, 'host', ${a}.host,
    'started_at', ${isoOf(`${a}.started_at`)}, 'decided_at', ${isoOf(`${a}.decided_at`)},
    'late', ${a}.decided_at >= ${openAt(`${a}.session_date`)})`;
}

/**
 * Every row of `sql`, which must end with an ORDER BY that orders rows completely: pages of PAGE_ROWS
 * through LIMIT/OFFSET (each page is its own read-only transaction).
 */
export async function queryAll(db: ReadOnlySource, sql: string, params: readonly unknown[] = []): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await db.query(`${sql}\nLIMIT ${PAGE_ROWS} OFFSET ${page * PAGE_ROWS}`, params, { maxRows: PAGE_ROWS });
    const rows = toObjects(res);
    out.push(...rows);
    if (rows.length < PAGE_ROWS) return out;
  }
  throw new Error(`query returned more than ${MAX_PAGES * PAGE_ROWS} rows`);
}

/** A json array of objects (json_agg output), parsed or text; anything else reads as []. */
export function records(v: unknown): Row[] {
  const raw = json(v);
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Row => x !== null && typeof x === 'object' && !Array.isArray(x));
}

/** A json array of strings; anything else reads as []. */
export function strings(v: unknown): string[] {
  const raw = json(v);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** A json array of [text, number] pairs (dates or symbols with an amount). */
export function pairsOf(v: unknown): [string | null, number][] {
  const raw = json(v);
  if (!Array.isArray(raw)) return [];
  const out: [string | null, number][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    out.push([p[0] === null || p[0] === undefined ? null : String(p[0]), Number(p[1])]);
  }
  return out;
}

/** What the read model needs from a strategies row. */
export interface RosterEntry {
  id: string;
  name: string;
  sub: string;
  engine: Engine;
  isBenchmark: boolean;
  status: StrategyStatus;
  sort: number;
  twinOf: string | null;
  objectName: string | null;
  rulesId: string | null;
  paperStart: string | null;
  paperEnd: string | null;
  /** params->'backtest_gate', unparsed (golive.parseGate reads it). */
  gate: unknown;
}

export const ROSTER_SQL = `SELECT id, name, sub, engine, is_benchmark, status, sort, twin_of, object_name, rules_id,
  paper_start::text AS paper_start, paper_end::text AS paper_end, params->'backtest_gate' AS gate
FROM strategies
ORDER BY sort, id`;

export function toRosterEntry(r: Row): RosterEntry {
  const isBenchmark = bool(r.is_benchmark);
  return {
    id: str(r.id),
    name: str(r.name),
    sub: str(r.sub),
    engine: engineOf(r.engine, isBenchmark),
    isBenchmark,
    status: statusOf(r.status),
    sort: num(r.sort),
    twinOf: strOrNull(r.twin_of),
    objectName: strOrNull(r.object_name),
    rulesId: strOrNull(r.rules_id),
    paperStart: ymdOrNull(r.paper_start),
    paperEnd: ymdOrNull(r.paper_end),
    gate: json(r.gate),
  };
}

export async function readRoster(db: ReadOnlySource): Promise<RosterEntry[]> {
  return toObjects(await db.query(ROSTER_SQL, [], { maxRows: PAGE_ROWS })).map(toRosterEntry);
}

/**
 * RESOLVER keys of LLM critics (Seer's NewsVeto, i.e. C): never reviewed, never twinned (C2), shown only
 * as the three-way's critic. Seer web's checksNews reads the same key. RESOLVER keys are stable forever.
 */
export const NEWS_VETO_OBJECTS: readonly string[] = ['STRATEGY_C'];

/** Display cadence: a bracket decides daily; a book's comes from its own description. */
export function cadenceOf(engine: Engine, sub: string): Cadence | null {
  if (engine === 'bracket') return 'daily';
  if (/quarter/i.test(sub)) return 'quarterly';
  if (/month/i.test(sub)) return 'monthly';
  if (/week/i.test(sub)) return 'weekly';
  if (/\bdaily\b|each day|every day/i.test(sub)) return 'daily';
  return null;
}

/** Seer web lib/strategy.ts shortLabel: the name's head before ' · ', else the id. */
export function shortLabel(name: string, id: string): string {
  const head = (name.split('·')[0] ?? '').trim();
  return head === '' ? id : head;
}

export interface Pairing {
  original: RosterEntry;
  twin: RosterEntry | null;
}

export interface RosterView {
  /** Every original: active by sort then id, then retired by paper_end desc. */
  pairs: Pairing[];
  spy: RosterEntry | null;
  all: RosterEntry[];
}

export function methodOf(p: Pairing): AdversaryMethod {
  const o = p.original;
  return {
    strategy_id: o.id,
    twin_id: p.twin?.id ?? null,
    name: o.name,
    short: shortLabel(o.name, o.id),
    sub: o.sub === '' ? null : o.sub,
    engine: o.engine === 'book' ? 'book' : 'bracket',
    cadence: cadenceOf(o.engine, o.sub),
    status: o.status,
    paper_start: o.paperStart,
    paper_end: o.paperEnd,
  };
}

const bySortThenId = (a: RosterEntry, b: RosterEntry): number =>
  a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isCritic = (r: RosterEntry): boolean => NEWS_VETO_OBJECTS.includes(r.objectName ?? '');

/**
 * Originals are research rows that are not twins and not critics; a retired one is listed only when it
 * traded (paper_end set, Seer's boardStrategies rule). Never hard-codes an id (invariant 5).
 */
export function pairRoster(roster: readonly RosterEntry[]): RosterView {
  const twinsOf = new Map<string, RosterEntry[]>();
  for (const r of roster) {
    if (r.twinOf === null) continue;
    twinsOf.set(r.twinOf, [...(twinsOf.get(r.twinOf) ?? []), r]);
  }
  const twinOf = (id: string): RosterEntry | null => {
    const twins = twinsOf.get(id) ?? [];
    const active = twins.find((t) => t.status === 'active');
    if (active !== undefined) return active;
    const retired = [...twins].sort((a, b) => ((b.paperStart ?? '') < (a.paperStart ?? '') ? -1 : (b.paperStart ?? '') > (a.paperStart ?? '') ? 1 : 0));
    return retired[0] ?? null;
  };
  const originals = roster.filter(
    (r) => !r.isBenchmark && r.twinOf === null && !isCritic(r) && (r.status === 'active' || r.paperEnd !== null),
  );
  const active = originals.filter((r) => r.status === 'active').sort(bySortThenId);
  const retired = originals
    .filter((r) => r.status === 'retired')
    .sort((a, b) => ((b.paperEnd ?? '') < (a.paperEnd ?? '') ? -1 : (b.paperEnd ?? '') > (a.paperEnd ?? '') ? 1 : bySortThenId(a, b)));
  const benchmarks = roster
    .filter((r) => r.isBenchmark)
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || bySortThenId(a, b));
  return {
    pairs: [...active, ...retired].map((original) => ({ original, twin: twinOf(original.id) })),
    spy: benchmarks[0] ?? null,
    all: [...roster],
  };
}

/** The pairing for an id in any case; a twin's id resolves to its original. */
export function findPairing(view: RosterView, id: string): Pairing | null {
  const want = id.trim().toUpperCase();
  const row = view.all.find((r) => r.id.toUpperCase() === want);
  if (row === undefined) return null;
  const originalId = row.twinOf ?? row.id;
  return view.pairs.find((p) => p.original.id === originalId) ?? null;
}

/** The C sibling of a bracket original: a critic on the same rule set (prefer the active one). */
export function criticOf(view: RosterView, original: RosterEntry): RosterEntry | null {
  if (original.engine !== 'bracket') return null;
  const critics = view.all.filter((r) => r.engine === 'bracket' && r.twinOf === null && isCritic(r) && r.rulesId === original.rulesId);
  return critics.find((r) => r.status === 'active') ?? critics[0] ?? null;
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** adversary_verdicts.sources: entries without a url are dropped. */
export function parseSources(v: unknown): AdversarySource[] {
  const out: AdversarySource[] = [];
  for (const s of records(v)) {
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    if (url === '') continue;
    out.push({
      url,
      title: textOrNull(s.title),
      publisher: textOrNull(s.publisher),
      published_at: textOrNull(s.published_at),
      fetched_at: textOrNull(s.fetched_at),
    });
  }
  return out;
}

export function toVerdictKind(v: unknown): VerdictKind | null {
  return v === 'agree' || v === 'object' || v === 'unsure' ? v : null;
}

/** One verdict row (verdictColumns or verdictJson) as a card with no decision context. */
export function toAdversaryVerdict(r: Row, rank: number | null): AdversaryVerdict | null {
  const verdict = toVerdictKind(r.verdict);
  const id = numOrNull(r.id);
  if (verdict === null || id === null) return null;
  return {
    id,
    strategy_id: str(r.strategy_id),
    session_date: str(r.session_date).slice(0, 10),
    symbol: str(r.symbol),
    rank,
    verdict,
    reason: str(r.reason),
    sources: parseSources(r.sources),
    lens: str(r.lens),
    model: str(r.model),
    prompt_version: str(r.prompt_version),
    host: str(r.host),
    started_at: str(r.started_at),
    decided_at: str(r.decided_at),
    late: bool(r.late),
    weight: null,
    twin_weight: null,
    twin_weight_source: null,
    held: null,
    action: null,
  };
}

export type AdversaryReadErrorCode = 'not_found' | 'not_bracket' | 'invalid_session';

/** A read the caller asked wrongly (HTTP 404/400, MCP error text). Message is user-facing. */
export class AdversaryReadError extends Error {
  override name = 'AdversaryReadError';
  constructor(
    readonly code: AdversaryReadErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** A real calendar date written YYYY-MM-DD. */
export function isSessionDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function assertSession(s: string): string {
  if (!isSessionDate(s)) throw new AdversaryReadError('invalid_session', `"${s}" is not a date like 2026-11-04`);
  return s;
}
```
**Impact:** none (new module).

### Step 4: Scorecard
**File:** `src/adversary/scorecard.ts` (new)
**Code:**
```ts
/**
 * Is Claude useful? (brief §4.2 Scorecard). For each counted objection: the stock's return over the
 * method's own horizon against the mean of the picks Claude kept on the same decision; for a bracket
 * method with a C sibling, Claude against C on the nights they disagree. Read-only, from Seer's bars.
 *
 * Horizon: bracket = the stock's own BRACKET_HORIZON_SESSIONS-th bar from the decision session (A's
 * 5-session time stop); book = the last bar before the original's next decision in strategy_candidates
 * (pending until it exists). Return = horizon close / close on the decision's data_date - 1 (bars are
 * split-adjusted; dividends are not counted). "same" = within SAME_BAND.
 */
import { num, numOrNull, round, str, ymdOrNull, type Row } from '../connectors/seer/rows.js';
import type { ReadOnlySource } from '../connectors/types.js';
import { countedCte, queryAll, toVerdictKind, type RosterEntry } from './readSql.js';
import type { AdversaryRecord, CriticDuel, DuelRow, RecordSummary, ScoreOutcome, VerdictKind } from './readTypes.js';

export const BRACKET_HORIZON_SESSIONS = 5;
export const SAME_BAND = 0.005;

const entryLateral = (a: string): string => `LEFT JOIN LATERAL (
  SELECT b.date, b.close FROM bars b
  WHERE b.symbol = ${a}.symbol AND b.date <= ${a}.data_date
  ORDER BY b.date DESC LIMIT 1
) en ON true`;

/** $1 original id, $2 bracket horizon. Every candidate of every decision that has a counted objection. */
const OBJECTION_ROWS_SQL = `WITH ${countedCte('v.strategy_id = $1')},
dec AS (SELECT DISTINCT session_date FROM counted WHERE verdict = 'object'),
nxt AS (
  SELECT d.session_date,
    (SELECT min(c2.session_date) FROM strategy_candidates c2
      WHERE c2.strategy_id = $1 AND c2.session_date > d.session_date) AS next_session
  FROM dec d
),
cand AS (
  SELECT c.session_date, c.data_date, c.kind, c.rank, c.symbol, k.verdict, n.next_session
  FROM strategy_candidates c
  JOIN nxt n ON n.session_date = c.session_date
  LEFT JOIN counted k ON k.session_date = c.session_date AND k.symbol = c.symbol
  WHERE c.strategy_id = $1
)
SELECT cand.session_date::text AS session_date, cand.data_date::text AS data_date, cand.kind, cand.rank, cand.symbol,
  cand.verdict, cand.next_session::text AS next_session,
  en.date::text AS entry_date, en.close AS entry_close,
  ex.date::text AS exit_date, ex.close AS exit_close, ex.n AS exit_n
FROM cand
${entryLateral('cand')}
LEFT JOIN LATERAL (
  SELECT x.date, x.close, x.n FROM (
    SELECT b.date, b.close, (row_number() OVER (ORDER BY b.date))::int AS n
    FROM bars b
    WHERE b.symbol = cand.symbol AND b.date >= cand.session_date
      AND (cand.kind = 'bracket' OR (cand.next_session IS NOT NULL AND b.date < cand.next_session))
  ) x
  WHERE cand.kind <> 'bracket' OR x.n <= $2::int
  ORDER BY x.date DESC
  LIMIT 1
) ex ON true
ORDER BY cand.session_date, cand.rank`;

/** $1 bracket original, $2 its C sibling, $3 horizon. Both critics' calls on nights they disagree. */
const DUEL_ROWS_SQL = `WITH ${countedCte('v.strategy_id = $1')},
nv AS (
  SELECT session_date, symbol, verdict FROM news_vetoes
  WHERE strategy_id = $2 AND verdict IN ('allow', 'veto')
),
both_ AS (
  SELECT c.session_date, c.data_date, c.rank, c.symbol, k.verdict AS claude, nv.verdict AS c_verdict
  FROM strategy_candidates c
  JOIN counted k ON k.session_date = c.session_date AND k.symbol = c.symbol
  JOIN nv ON nv.session_date = c.session_date AND nv.symbol = c.symbol
  WHERE c.strategy_id = $1
),
nights AS (
  SELECT session_date FROM both_ GROUP BY session_date
  HAVING bool_or((c_verdict = 'veto') <> (claude = 'object'))
)
SELECT b.session_date::text AS session_date, b.data_date::text AS data_date, b.rank, b.symbol, b.claude, b.c_verdict,
  en.date::text AS entry_date, en.close AS entry_close,
  ex.date::text AS exit_date, ex.close AS exit_close, ex.n AS exit_n
FROM both_ b
JOIN nights ON nights.session_date = b.session_date
${entryLateral('b')}
LEFT JOIN LATERAL (
  SELECT x.date, x.close, x.n FROM (
    SELECT b2.date, b2.close, (row_number() OVER (ORDER BY b2.date))::int AS n
    FROM bars b2 WHERE b2.symbol = b.symbol AND b2.date >= b.session_date
  ) x
  WHERE x.n <= $3::int
  ORDER BY x.date DESC
  LIMIT 1
) ex ON true
ORDER BY b.session_date, b.rank`;

export interface HorizonRow {
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  rank: number;
  symbol: string;
  /** Claude's counted verdict; null = not reviewed in time (kept). */
  verdict: VerdictKind | null;
  next_session: string | null;
  entry_date: string | null;
  entry_close: number | null;
  exit_date: string | null;
  exit_close: number | null;
  exit_n: number | null;
}

export interface DuelInputRow {
  session_date: string;
  data_date: string;
  rank: number;
  symbol: string;
  claude: VerdictKind;
  c_verdict: 'allow' | 'veto';
  entry_date: string | null;
  entry_close: number | null;
  exit_date: string | null;
  exit_close: number | null;
  exit_n: number | null;
}

export interface ObjectionScore {
  session_date: string;
  symbol: string;
  rank: number;
  from: string | null;
  to: string | null;
  sessions: number | null;
  stock_return: number | null;
  kept_return: number | null;
  kept: number;
  diff: number | null;
  /** null = pending (its horizon, or every kept pick's, has not passed). */
  outcome: ScoreOutcome | null;
  fell: boolean | null;
}

export function toHorizonRow(r: Row): HorizonRow {
  return {
    session_date: str(r.session_date),
    data_date: str(r.data_date),
    kind: str(r.kind) === 'book' ? 'book' : 'bracket',
    rank: num(r.rank),
    symbol: str(r.symbol),
    verdict: toVerdictKind(r.verdict),
    next_session: ymdOrNull(r.next_session),
    entry_date: ymdOrNull(r.entry_date),
    entry_close: numOrNull(r.entry_close),
    exit_date: ymdOrNull(r.exit_date),
    exit_close: numOrNull(r.exit_close),
    exit_n: numOrNull(r.exit_n),
  };
}

function toDuelInputRow(r: Row): DuelInputRow | null {
  const claude = toVerdictKind(r.claude);
  const c = str(r.c_verdict);
  if (claude === null || (c !== 'allow' && c !== 'veto')) return null;
  return {
    session_date: str(r.session_date),
    data_date: str(r.data_date),
    rank: num(r.rank),
    symbol: str(r.symbol),
    claude,
    c_verdict: c,
    entry_date: ymdOrNull(r.entry_date),
    entry_close: numOrNull(r.entry_close),
    exit_date: ymdOrNull(r.exit_date),
    exit_close: numOrNull(r.exit_close),
    exit_n: numOrNull(r.exit_n),
  };
}

/** The horizon return when the horizon has passed, else null; plus the window it covers. */
export function horizonReturn(r: HorizonRow, horizon: number): { ret: number | null; from: string | null; to: string | null; sessions: number | null } {
  const complete = r.kind === 'bracket' ? r.exit_n === horizon : r.next_session !== null && r.exit_date !== null;
  const ok = complete && r.entry_close !== null && r.entry_close > 0 && r.exit_close !== null;
  return {
    ret: ok ? r.exit_close! / r.entry_close! - 1 : null,
    from: r.entry_date,
    to: r.exit_date,
    sessions: r.exit_n,
  };
}

export function outcomeOf(diff: number | null): ScoreOutcome | null {
  if (diff === null) return null;
  if (diff < -SAME_BAND) return 'worse';
  if (diff > SAME_BAND) return 'better';
  return 'same';
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, v) => a + v, 0) / xs.length);

function bySession<T extends { session_date: string }>(rows: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.session_date, [...(groups.get(r.session_date) ?? []), r]);
  return [...groups.values()];
}

export function scoreObjections(rows: readonly HorizonRow[], horizon: number = BRACKET_HORIZON_SESSIONS): ObjectionScore[] {
  const out: ObjectionScore[] = [];
  for (const group of bySession(rows)) {
    const kept = group
      .filter((r) => r.verdict !== 'object')
      .map((r) => horizonReturn(r, horizon).ret)
      .filter((x): x is number => x !== null);
    const keptReturn = mean(kept);
    for (const r of group) {
      if (r.verdict !== 'object') continue;
      const h = horizonReturn(r, horizon);
      const diff = h.ret !== null && keptReturn !== null ? h.ret - keptReturn : null;
      out.push({
        session_date: r.session_date,
        symbol: r.symbol,
        rank: r.rank,
        from: h.from,
        to: h.to,
        sessions: h.sessions,
        stock_return: round(h.ret, 6),
        kept_return: round(keptReturn, 6),
        kept: kept.length,
        diff: round(diff, 6),
        outcome: outcomeOf(diff),
        fell: h.ret === null ? null : h.ret < 0,
      });
    }
  }
  return out;
}

export function summarize(scores: readonly ObjectionScore[]): RecordSummary {
  const scored = scores.filter((s) => s.outcome !== null);
  const gaps = scored.map((s) => (s.diff ?? 0) * 100);
  return {
    objections: scores.length,
    scored: scored.length,
    worse: scored.filter((s) => s.outcome === 'worse').length,
    same: scored.filter((s) => s.outcome === 'same').length,
    better: scored.filter((s) => s.outcome === 'better').length,
    pending: scores.length - scored.length,
    fell: scored.filter((s) => s.fell === true).length,
    mean_gap_pts: round(mean(gaps), 4),
  };
}

export function recordOf(engine: 'bracket' | 'book', scores: readonly ObjectionScore[]): AdversaryRecord {
  return {
    horizon: engine === 'bracket' ? `the ${BRACKET_HORIZON_SESSIONS} sessions after the decision` : 'until the next rebalance',
    horizon_sessions: engine === 'bracket' ? BRACKET_HORIZON_SESSIONS : null,
    same_band_pts: SAME_BAND * 100,
    points: scores.flatMap((s) =>
      s.outcome === null || s.stock_return === null || s.kept_return === null || s.diff === null
        ? []
        : [
            {
              symbol: s.symbol,
              session_date: s.session_date,
              rank: s.rank,
              gap_pts: round(s.diff * 100, 4) ?? 0,
              outcome: s.outcome,
              stock_return: s.stock_return,
              kept_return: s.kept_return,
              kept: s.kept,
              horizon_from: s.from,
              horizon_to: s.to,
              sessions: s.sessions,
              fell: s.fell === true,
            },
          ],
    ),
    pending: scores.filter((s) => s.outcome === null).map((s) => ({ symbol: s.symbol, session_date: s.session_date })),
    summary: summarize(scores),
  };
}

/** Claude against C (see the module doc). Every disagreement credits exactly one side. */
export function scoreDuel(criticId: string, rows: readonly DuelInputRow[], horizon: number = BRACKET_HORIZON_SESSIONS): CriticDuel {
  const out: DuelRow[] = [];
  const asHorizon = (r: DuelInputRow): HorizonRow => ({ ...r, kind: 'bracket', verdict: r.claude, next_session: null });
  const groups = bySession(rows);
  for (const night of groups) {
    const rets = night.map((r) => horizonReturn(asHorizon(r), horizon).ret);
    const neither = night.flatMap((r, i) => (r.c_verdict !== 'veto' && r.claude !== 'object' && rets[i] !== null ? [rets[i]!] : []));
    const all = rets.filter((x): x is number => x !== null);
    const baseline = mean(neither) ?? mean(all);
    night.forEach((r, i) => {
      const cBlocks = r.c_verdict === 'veto';
      const claudeBlocks = r.claude === 'object';
      if (cBlocks === claudeBlocks) return;
      const blockedBy: 'critic' | 'claude' = cBlocks ? 'critic' : 'claude';
      const ret = rets[i] ?? null;
      const right = ret === null || baseline === null ? null : ret < baseline ? blockedBy : blockedBy === 'critic' ? 'claude' : 'critic';
      out.push({
        session_date: r.session_date,
        symbol: r.symbol,
        rank: r.rank,
        c: r.c_verdict,
        claude: r.claude,
        blocked_by: blockedBy,
        stock_return: round(ret, 6),
        baseline: round(baseline, 6),
        right,
      });
    });
  }
  const scored = out.filter((r) => r.right !== null);
  return {
    critic_id: criticId,
    nights: groups.length,
    disagreements: out.length,
    scored: scored.length,
    claude_right: scored.filter((r) => r.right === 'claude').length,
    critic_right: scored.filter((r) => r.right === 'critic').length,
    pending: out.length - scored.length,
    rows: out,
  };
}

export async function loadObjectionScores(db: ReadOnlySource, original: RosterEntry): Promise<ObjectionScore[]> {
  const rows = await queryAll(db, OBJECTION_ROWS_SQL, [original.id, BRACKET_HORIZON_SESSIONS]);
  return scoreObjections(rows.map(toHorizonRow), BRACKET_HORIZON_SESSIONS);
}

export async function loadDuel(db: ReadOnlySource, original: RosterEntry, critic: RosterEntry): Promise<CriticDuel> {
  const rows = await queryAll(db, DUEL_ROWS_SQL, [original.id, critic.id, BRACKET_HORIZON_SESSIONS]);
  return scoreDuel(
    critic.id,
    rows.flatMap((r) => {
      const d = toDuelInputRow(r);
      return d === null ? [] : [d];
    }),
    BRACKET_HORIZON_SESSIONS,
  );
}
```
**Impact:** none (new module).

### Step 5: Read model
**File:** `src/adversary/read.ts` (new)
**Code:**
```ts
/**
 * The Seer Adversarial read model (phase 5): overview, method page, decision cards, the A / C / A+Claude
 * three-way, scorecard and verdict lists, all read-only from Seer's DB through a connector
 * ReadOnlySource. Money-weighted figures and the checklist come from golive.ts (Seer parity); the
 * scorecard from scorecard.ts. Comparisons of a twin with its original and SPY run over the twin's own
 * record, because a twin runs one session behind (D1).
 */
import { CURVES_SQL, parseCurve } from '../connectors/seer/leaderboard.js';
import { byDate, countsFor, sinceStartMetrics, type Snapshot } from '../connectors/seer/ranking.js';
import { bool, fixed, num, numOrNull, round, str, strOrNull, toObjects, type Row } from '../connectors/seer/rows.js';
import type { ReadOnlySource } from '../connectors/types.js';
import * as gl from './golive.js';
import {
  AdversaryReadError,
  PAGE_ROWS,
  assertSession,
  countedCte,
  criticOf,
  findPairing,
  isoOf,
  methodOf,
  openAt,
  pairRoster,
  pairsOf,
  queryAll,
  readRoster,
  records,
  strings,
  toAdversaryVerdict,
  verdictColumns,
  verdictJson,
  type Pairing,
  type RosterEntry,
  type RosterView,
} from './readSql.js';
import type {
  AdversaryDecision,
  AdversaryVerdict,
  Cause,
  ChecklistItem,
  BookFigures,
  Coverage,
  CoverageState,
  CVerdict,
  Curves,
  DailyGrid,
  DecisionPick,
  DecisionSummary,
  LastReview,
  MethodPayload,
  MethodRow,
  OverviewPayload,
  RecordSummary,
  Revision,
  ScorecardPayload,
  ThreeWay,
  ThreeWayRow,
  VerdictKind,
  VerdictList,
} from './readTypes.js';
import { loadDuel, loadObjectionScores, recordOf } from './scorecard.js';
import type { AdversaryStatus } from './service.js';

export const LATEST_VERDICTS = 8;
export const MAX_VERDICTS = 200;

// ------------------------------------------------------------------------------------------- SQL

const FLOWS_SQL = `SELECT strategy_id,
  json_agg(json_build_array(session_date::text, amount_usd) ORDER BY session_date) AS flows
FROM (
  SELECT strategy_id, session_date, sum(amount_usd) AS amount_usd
  FROM paper_contributions
  WHERE applied_at IS NOT NULL
  GROUP BY strategy_id, session_date
) f
GROUP BY strategy_id`;

/** Seer web leaderboard()'s pnls, dated by exit: closed orders (bracket), non-idle book trades (book). */
const TRADES_SQL = `SELECT strategy_id, src,
  json_agg(json_build_array(exit_date::text, pnl_usd) ORDER BY exit_date NULLS FIRST) AS trades
FROM (
  SELECT 'bracket' AS src, strategy_id, exit_date, COALESCE(pnl_usd, 0) AS pnl_usd FROM orders WHERE status = 'closed'
  UNION ALL
  SELECT 'book' AS src, strategy_id, exit_date, pnl_usd FROM book_trades WHERE NOT idle
) x
GROUP BY strategy_id, src`;

const FEES_SQL = `SELECT strategy_id,
  json_agg(json_build_array(session_date::text, cost_usd) ORDER BY session_date) AS fees
FROM (
  SELECT strategy_id, session_date, sum(cost_usd) AS cost_usd FROM book_fills GROUP BY strategy_id, session_date
) f
GROUP BY strategy_id`;

/** $1 strategy id or NULL for all. One row per decision (strategy, session) with its coverage counts. */
const DECISIONS_SQL = `WITH d AS (
  SELECT strategy_id, session_date, min(data_date) AS data_date, min(kind) AS kind, count(*)::int AS picks
  FROM strategy_candidates
  WHERE ($1::text IS NULL OR strategy_id = $1)
  GROUP BY strategy_id, session_date
),
${countedCte('$1::text IS NULL OR v.strategy_id = $1')},
c AS (
  SELECT strategy_id, session_date,
    (count(*) FILTER (WHERE verdict = 'object'))::int AS object,
    (count(*) FILTER (WHERE verdict = 'unsure'))::int AS unsure,
    (count(*) FILTER (WHERE verdict = 'agree'))::int AS agree
  FROM counted
  GROUP BY strategy_id, session_date
),
l AS (
  SELECT v.strategy_id, v.session_date, (count(DISTINCT v.symbol))::int AS late
  FROM adversary_verdicts v
  WHERE ($1::text IS NULL OR v.strategy_id = $1)
    AND v.decided_at >= ${openAt('v.session_date')}
    AND NOT EXISTS (
      SELECT 1 FROM counted k
      WHERE k.strategy_id = v.strategy_id AND k.session_date = v.session_date AND k.symbol = v.symbol)
  GROUP BY v.strategy_id, v.session_date
)
SELECT d.strategy_id, d.session_date::text AS session_date, d.data_date::text AS data_date, d.kind, d.picks,
  ${isoOf(openAt('d.session_date'))} AS open_utc,
  (${openAt('d.session_date')} > now()) AS pending,
  (m.strategy_id IS NOT NULL) AS paused,
  COALESCE(c.object, 0) AS object, COALESCE(c.unsure, 0) AS unsure, COALESCE(c.agree, 0) AS agree,
  COALESCE(l.late, 0) AS late
FROM d
LEFT JOIN c ON c.strategy_id = d.strategy_id AND c.session_date = d.session_date
LEFT JOIN l ON l.strategy_id = d.strategy_id AND l.session_date = d.session_date
LEFT JOIN adversary_marks m ON m.strategy_id = d.strategy_id AND m.session_date = d.session_date
ORDER BY d.strategy_id, d.session_date`;

const LATEST_SQL = `WITH ${countedCte('true')}
SELECT ${verdictColumns('k')}, c.rank
FROM counted k
LEFT JOIN strategy_candidates c ON c.strategy_id = k.strategy_id AND c.session_date = k.session_date AND c.symbol = k.symbol
WHERE k.verdict IN ('object', 'unsure')
ORDER BY k.decided_at DESC, k.id DESC
LIMIT ${LATEST_VERDICTS}`;

const LAST_REVIEW_SQL = `SELECT v.strategy_id, v.session_date::text AS session_date, ${isoOf('v.decided_at')} AS finished_at,
  (SELECT (count(DISTINCT w.symbol))::int FROM adversary_verdicts w
    WHERE w.strategy_id = v.strategy_id AND w.session_date = v.session_date) AS picks
FROM adversary_verdicts v
ORDER BY v.decided_at DESC, v.id DESC
LIMIT 1`;

const picksJson = (sid: string, sess: string): string => `(SELECT json_agg(json_build_object(
    'rank', c.rank, 'symbol', c.symbol, 'weight', c.weight, 'kind', c.kind, 'data_date', c.data_date::text) ORDER BY c.rank)
  FROM strategy_candidates c WHERE c.strategy_id = ${sid} AND c.session_date = ${sess})`;

const verdictsJson = (sid: string, sess: string): string => `(SELECT json_agg(${verdictJson('v')} ORDER BY v.symbol, v.decided_at DESC, v.id DESC)
  FROM adversary_verdicts v WHERE v.strategy_id = ${sid} AND v.session_date = ${sess})`;

const decidedOf = (sid: string, sess: string): string =>
  `(SELECT ps.pending_session >= ${sess} OR ps.last_session >= ${sess} FROM paper_state ps WHERE ps.strategy_id = ${sid})`;

const ordersJson = (sid: string, sess: string): string =>
  `(SELECT json_agg(o.symbol ORDER BY o.slot, o.symbol) FROM orders o WHERE o.strategy_id = ${sid} AND o.session_date = ${sess})`;

/** $1 original, $2 session, $3 twin id or NULL: one row holding the whole decision. */
const DECISION_SQL = `SELECT ${isoOf(openAt('$2::date'))} AS open_utc,
  (${openAt('$2::date')} > now()) AS pending,
  EXISTS (SELECT 1 FROM adversary_marks m WHERE m.strategy_id = $1 AND m.session_date = $2::date) AS paused,
  ${picksJson('$1', '$2::date')} AS picks,
  ${verdictsJson('$1', '$2::date')} AS verdicts,
  (SELECT json_agg(t.symbol ORDER BY t.symbol) FROM book_targets t
    WHERE t.strategy_id = $1 AND t.session_date = (
      SELECT max(p.session_date) FROM book_targets p WHERE p.strategy_id = $1 AND p.session_date < $2::date)) AS held,
  (SELECT json_agg(json_build_array(t.symbol, t.weight) ORDER BY t.rank) FROM book_targets t
    WHERE t.strategy_id = $3::text AND t.session_date = $2::date) AS twin_targets,
  ${decidedOf('$3::text', '$2::date')} AS twin_decided`;

/** $1 original (A), $2 session, $3 C id, $4 twin id or NULL: one row holding the three-way. */
const THREE_WAY_SQL = `SELECT ${isoOf(openAt('$2::date'))} AS open_utc,
  ${picksJson('$1', '$2::date')} AS picks,
  ${verdictsJson('$1', '$2::date')} AS verdicts,
  (SELECT json_agg(json_build_object('symbol', n.symbol, 'rank', n.rank, 'verdict', n.verdict, 'reason', n.reason,
      'decided_at', ${isoOf('n.decided_at')}) ORDER BY n.rank)
    FROM news_vetoes n WHERE n.strategy_id = $3::text AND n.session_date = $2::date) AS c_verdicts,
  ${ordersJson('$1', '$2::date')} AS a_orders,
  ${ordersJson('$3::text', '$2::date')} AS c_orders,
  ${ordersJson('$4::text', '$2::date')} AS twin_orders,
  ${decidedOf('$1', '$2::date')} AS a_decided,
  ${decidedOf('$3::text', '$2::date')} AS c_decided,
  ${decidedOf('$4::text', '$2::date')} AS twin_decided`;

const SESSIONS_SQL = `SELECT DISTINCT session_date::text AS session_date FROM strategy_candidates
WHERE strategy_id = $1
ORDER BY 1 DESC`;

const REVISIONS_SQL = `SELECT prompt_version, model, lens,
  ${isoOf('min(decided_at)')} AS first_decided_at, ${isoOf('max(decided_at)')} AS last_decided_at,
  (count(*))::int AS verdicts
FROM adversary_verdicts
WHERE strategy_id = $1
GROUP BY prompt_version, model, lens
ORDER BY min(decided_at) DESC`;

/**
 * $1 original or NULL, $2 session or NULL, $3 verdict or NULL. Per (strategy, session, symbol) the shown
 * verdict: the counted one, else the latest late one. Without $2, only each strategy's latest session.
 */
const VERDICTS_SQL = `WITH eff AS (
  SELECT DISTINCT ON (v.strategy_id, v.session_date, v.symbol) v.*
  FROM adversary_verdicts v
  WHERE ($1::text IS NULL OR v.strategy_id = $1) AND ($2::date IS NULL OR v.session_date = $2::date)
  ORDER BY v.strategy_id, v.session_date, v.symbol, (v.decided_at < ${openAt('v.session_date')}) DESC, v.decided_at DESC, v.id DESC
),
latest AS (SELECT strategy_id, max(session_date) AS session_date FROM eff GROUP BY strategy_id)
SELECT ${verdictColumns('e')}, c.rank
FROM eff e
LEFT JOIN strategy_candidates c ON c.strategy_id = e.strategy_id AND c.session_date = e.session_date AND c.symbol = e.symbol
WHERE ($2::date IS NOT NULL OR EXISTS (
    SELECT 1 FROM latest l WHERE l.strategy_id = e.strategy_id AND l.session_date = e.session_date))
  AND ($3::text IS NULL OR e.verdict = $3::text)
ORDER BY e.session_date DESC, e.strategy_id, c.rank NULLS LAST, e.symbol`;

// ------------------------------------------------------------------------------------- the market

/** Every strategy's equity curve, applied deposits, dated closed trades (its own engine's) and fees. */
export interface Market {
  curves: Map<string, Snapshot[]>;
  flows: Map<string, gl.Flow[]>;
  trades: Map<string, gl.Trade[]>;
  fees: Map<string, gl.Flow[]>;
}

const dated = (v: unknown): gl.Flow[] => pairsOf(v).flatMap(([date, amount]) => (date === null ? [] : [{ date: date.slice(0, 10), amount }]));

export async function readMarket(db: ReadOnlySource, roster: readonly RosterEntry[]): Promise<Market> {
  const [c, f, t, e] = await Promise.all([
    db.query(CURVES_SQL, [], { maxRows: PAGE_ROWS }),
    db.query(FLOWS_SQL, [], { maxRows: PAGE_ROWS }),
    db.query(TRADES_SQL, [], { maxRows: PAGE_ROWS }),
    db.query(FEES_SQL, [], { maxRows: PAGE_ROWS }),
  ]);
  const curves = new Map<string, Snapshot[]>();
  for (const r of toObjects(c)) {
    const id = strOrNull(r.strategy_id);
    if (id !== null) curves.set(id, parseCurve(r.curve).sort(byDate));
  }
  const flows = new Map<string, gl.Flow[]>();
  for (const r of toObjects(f)) flows.set(str(r.strategy_id), dated(r.flows));
  const engine = new Map(roster.map((r) => [r.id, r.engine] as const));
  const trades = new Map<string, gl.Trade[]>();
  for (const r of toObjects(t)) {
    const id = str(r.strategy_id);
    const eng = engine.get(id);
    if (eng === undefined || !countsFor(eng, str(r.src))) continue;
    trades.set(
      id,
      pairsOf(r.trades).map(([date, pnl]) => ({ date: date === null ? null : date.slice(0, 10), pnl })),
    );
  }
  const fees = new Map<string, gl.Flow[]>();
  for (const r of toObjects(e)) fees.set(str(r.strategy_id), dated(r.fees));
  return { curves, flows, trades, fees };
}

const sum = (xs: readonly number[]): number => xs.reduce((a, v) => a + v, 0);
const inWindow = (date: string | null, from: string, to: string): boolean => date !== null && date > from && date <= to;

/** One book over [from, to] (snapshots inside it; deposits, trades and fees inside (first, last]). */
export function bookFigures(r: RosterEntry, m: Market, from: string, to: string): BookFigures | null {
  const curve = gl.cutCurve(m.curves.get(r.id) ?? [], from, to);
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (first === undefined || last === undefined) return null;
  const flows = (m.flows.get(r.id) ?? []).filter((x) => inWindow(x.date, first.date, last.date));
  const deposits = sum(flows.map((x) => x.amount));
  const stats = gl.tradeStats(
    (m.trades.get(r.id) ?? []).filter((x) => inWindow(x.date, first.date, last.date)).map((x) => x.pnl),
  );
  const fees =
    r.engine === 'bracket'
      ? null
      : fixed(sum((m.fees.get(r.id) ?? []).filter((x) => inWindow(x.date, first.date, last.date)).map((x) => x.amount)), 4);
  return {
    strategy_id: r.id,
    from: first.date,
    to: last.date,
    sessions: curve.length,
    return: round(gl.periodMoneyWeightedReturn(curve, flows), 6),
    mwr_annual: round(gl.moneyWeightedReturn(curve, flows), 6),
    deposits_usd: fixed(deposits, 2),
    gain_usd: curve.length >= 2 ? fixed(last.equity - first.equity - deposits, 2) : null,
    worst_drop: round(gl.drawdownOf(gl.twrIndex(curve, flows)), 6),
    trades: stats.trades,
    profit_factor: stats.trades === 0 ? null : stats.grossLoss === 0 ? 'infinite' : round(stats.grossWin / stats.grossLoss, 4),
    fees_usd: fees,
  };
}

/** A book over its own whole record. */
export function ownFigures(r: RosterEntry, m: Market): BookFigures | null {
  const c = m.curves.get(r.id) ?? [];
  const first = c[0];
  const last = c[c.length - 1];
  return first !== undefined && last !== undefined ? bookFigures(r, m, first.date, last.date) : null;
}

/** Seer's leaderboard checklist for one row, over its whole record (raw equity, as Seer does). */
export function checklistOf(r: RosterEntry, m: Market, spy: RosterEntry | null): ChecklistItem[] {
  const curve = m.curves.get(r.id) ?? [];
  const metrics = sinceStartMetrics(curve, gl.tradeStats((m.trades.get(r.id) ?? []).map((x) => x.pnl)));
  const spyReturn = spy !== null ? gl.spyOverSpan(m.curves.get(spy.id) ?? [], curve) : null;
  return gl.checklistItems(metrics, spyReturn, gl.parseGate(r.gate, r.twinOf !== null));
}

// ------------------------------------------------------------------------------------- decisions

export interface DecisionRow {
  strategy_id: string;
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  picks: number;
  open_utc: string;
  pending: boolean;
  paused: boolean;
  object: number;
  unsure: number;
  agree: number;
  late: number;
}

export function toDecisionRow(r: Row): DecisionRow {
  return {
    strategy_id: str(r.strategy_id),
    session_date: str(r.session_date),
    data_date: str(r.data_date),
    kind: str(r.kind) === 'book' ? 'book' : 'bracket',
    picks: num(r.picks),
    open_utc: str(r.open_utc),
    pending: bool(r.pending),
    paused: bool(r.paused),
    object: num(r.object),
    unsure: num(r.unsure),
    agree: num(r.agree),
    late: num(r.late),
  };
}

export async function readDecisions(db: ReadOnlySource, strategyId: string | null): Promise<DecisionRow[]> {
  return (await queryAll(db, DECISIONS_SQL, [strategyId])).map(toDecisionRow);
}

/** C4's coverage rule, with 'pending' until the session opens. The one place it is spelled. */
export function coverageState(pending: boolean, counted: number, paused: boolean): CoverageState {
  if (pending) return 'pending';
  if (counted > 0) return 'reviewed';
  if (paused) return 'paused';
  return 'absent';
}

export function stateOf(d: DecisionRow): CoverageState {
  return coverageState(d.pending, d.object + d.unsure + d.agree, d.paused);
}

export function coverageOf(rows: readonly DecisionRow[]): Coverage {
  const c: Coverage = { decisions: rows.length, reviewed: 0, absent: 0, late: 0, paused: 0, pending: 0 };
  for (const d of rows) {
    const s = stateOf(d);
    c[s] += 1;
    if (s === 'absent' && d.late > 0) c.late += 1;
  }
  return c;
}

export function summaryOf(d: DecisionRow): DecisionSummary {
  return {
    session_date: d.session_date,
    data_date: d.data_date,
    kind: d.kind,
    open_utc: d.open_utc,
    coverage: stateOf(d),
    picks: d.picks,
    object: d.object,
    unsure: d.unsure,
    agree: d.agree,
    late: d.late,
  };
}

/** The decision a page opens on: the newest pending or reviewed one, else the newest. */
export function latestSession(rows: readonly DecisionRow[]): string | null {
  const newest = [...rows].sort((a, b) => (a.session_date < b.session_date ? 1 : a.session_date > b.session_date ? -1 : 0));
  return (newest.find((d) => d.pending || d.object + d.unsure + d.agree > 0) ?? newest[0])?.session_date ?? null;
}

// ------------------------------------------------------------------------------------- rows

export function beyondOriginal(original: RosterEntry, twin: RosterEntry, m: Market, from: string, to: string): number | null {
  const tc = gl.cutCurve(m.curves.get(twin.id) ?? [], from, to);
  const end = gl.shadowEnd(gl.cutCurve(m.curves.get(original.id) ?? [], from, to), m.flows.get(original.id) ?? [], tc, m.flows.get(twin.id) ?? []);
  const last = tc[tc.length - 1];
  return end === null || last === undefined ? null : fixed(last.equity - end, 2);
}

export function buildRow(pair: Pairing, m: Market, spy: RosterEntry | null, decisions: readonly DecisionRow[], record: RecordSummary): MethodRow {
  const { original, twin } = pair;
  const twinCurve = twin !== null ? m.curves.get(twin.id) ?? [] : [];
  const first = twinCurve[0];
  const last = twinCurve[twinCurve.length - 1];
  const window = first !== undefined && last !== undefined ? { from: first.date, to: last.date, sessions: twinCurve.length } : null;
  const over = (r: RosterEntry | null): BookFigures | null => (r !== null && window !== null ? bookFigures(r, m, window.from, window.to) : null);
  const figures = { original: over(original), twin: over(twin), spy: over(spy) };
  const mine = decisions.filter((d) => d.strategy_id === original.id);
  const settled = mine.filter((d) => stateOf(d) === 'reviewed');
  return {
    ...methodOf(pair),
    window,
    returns: { original: figures.original?.return ?? null, twin: figures.twin?.return ?? null, spy: figures.spy?.return ?? null },
    figures,
    beyond_original_usd: twin !== null && window !== null ? beyondOriginal(original, twin, m, window.from, window.to) : null,
    objections: {
      objected: sum(settled.map((d) => d.object)),
      reviewed: sum(settled.map((d) => d.object + d.unsure + d.agree)),
      fell_after: record.scored > 0 ? record.worse : null,
      scored: record.scored,
      pending: record.pending,
    },
    coverage: coverageOf(mine),
    checklist: { original: checklistOf(original, m, spy), twin: twin !== null ? checklistOf(twin, m, spy) : [] },
  };
}

export function causeOf(rows: readonly MethodRow[]): Cause {
  const beats = (r: number | null, s: number | null): boolean => r !== null && s !== null && r > s;
  const beyond = rows.flatMap((r) => (r.beyond_original_usd === null ? [] : [r.beyond_original_usd]));
  const deltas = rows.flatMap((r) => {
    const t = r.figures.twin?.worst_drop ?? null;
    const o = r.figures.original?.worst_drop ?? null;
    return t === null || o === null ? [] : [(t - o) * 100];
  });
  return {
    twins: rows.length,
    twins_beat_spy: rows.filter((r) => beats(r.returns.twin, r.returns.spy)).map((r) => r.strategy_id),
    originals_beat_spy: rows.filter((r) => beats(r.returns.original, r.returns.spy)).map((r) => r.strategy_id),
    extra_profit_usd: beyond.length > 0 ? fixed(sum(beyond), 2) : null,
    drawdown_delta_pts: deltas.length > 0 ? fixed(sum(deltas) / deltas.length, 2) : null,
  };
}

/** Growth of 100 with deposits taken out, on the twin's dates. */
export function curvesOf(row: MethodRow, m: Market, spy: RosterEntry | null): Curves | null {
  if (row.window === null || row.twin_id === null) return null;
  const { from, to } = row.window;
  const dates = gl.cutCurve(m.curves.get(row.twin_id) ?? [], from, to).map((s) => s.date);
  const series = (id: string | null): (number | null)[] => {
    if (id === null) return dates.map(() => null);
    const curve = gl.cutCurve(m.curves.get(id) ?? [], from, to);
    const index = gl.twrIndex(curve, m.flows.get(id) ?? []);
    const at = new Map(curve.map((s, i) => [s.date, index[i] ?? null] as const));
    return dates.map((d) => {
      const v = at.get(d);
      return v === undefined || v === null ? null : fixed(v * 100, 4);
    });
  };
  return { dates, original: series(row.strategy_id), twin: series(row.twin_id), spy: series(spy?.id ?? null) };
}

export function startedOn(live: readonly Pairing[], m: Market): string | null {
  const starts = live.flatMap((p) => {
    const first = p.twin !== null ? (m.curves.get(p.twin.id) ?? [])[0] : undefined;
    return first !== undefined ? [first.date] : p.twin?.paperStart ? [p.twin.paperStart] : [];
  });
  return starts.sort()[0] ?? null;
}

export function monthsOnPaper(live: readonly Pairing[], m: Market): number | null {
  let best: number | null = null;
  for (const p of live) {
    if (p.twin === null) continue;
    const c = m.curves.get(p.twin.id) ?? [];
    const first = c[0];
    const last = c[c.length - 1];
    if (first === undefined || last === undefined) continue;
    const months = gl.daysBetween(first.date, last.date) / gl.MONTH_DAYS;
    best = best === null ? months : Math.max(best, months);
  }
  return best === null ? null : fixed(best, 2);
}

// ------------------------------------------------------------------------------------- decision cards

interface Effective {
  counted: Map<string, AdversaryVerdict>;
  late: Map<string, AdversaryVerdict>;
}

/** verdictsJson rows (ordered symbol, decided_at DESC): the counted and the latest late verdict per symbol. */
function effective(verdicts: unknown, rankOf: ReadonlyMap<string, number>): Effective {
  const counted = new Map<string, AdversaryVerdict>();
  const late = new Map<string, AdversaryVerdict>();
  for (const raw of records(verdicts)) {
    const v = toAdversaryVerdict(raw, rankOf.get(str(raw.symbol)) ?? null);
    if (v === null) continue;
    const into = v.late ? late : counted;
    if (!into.has(v.symbol)) into.set(v.symbol, v);
  }
  return { counted, late };
}

export interface DecisionInput {
  strategy_id: string;
  twin_id: string | null;
  session_date: string;
  open_utc: string;
  pending: boolean;
  paused: boolean;
  picks: unknown;
  verdicts: unknown;
  held: unknown;
  twin_targets: unknown;
  twin_decided: unknown;
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** The decision's cards: per pick its shown verdict, held·sell / new·skip and the twin's weight. */
export function buildDecision(i: DecisionInput): AdversaryDecision | null {
  const picks = records(i.picks).map((p) => ({
    rank: num(p.rank),
    symbol: str(p.symbol),
    weight: numOrNull(p.weight),
    kind: str(p.kind) === 'book' ? ('book' as const) : ('bracket' as const),
    data_date: str(p.data_date),
  }));
  const head = picks[0];
  if (head === undefined) return null;
  const kind = head.kind;
  const rankOf = new Map(picks.map((p) => [p.symbol, p.rank] as const));
  const { counted, late } = effective(i.verdicts, rankOf);
  const held = new Set(strings(i.held));
  const twinDecided = bool(i.twin_decided);
  const twinTargets = new Map<string, number>();
  for (const [symbol, weight] of pairsOf(i.twin_targets)) if (symbol !== null) twinTargets.set(symbol, weight);
  const objected = (s: string): boolean => counted.get(s)?.verdict === 'object';
  const allObjected = picks.every((p) => objected(p.symbol));
  const keptWeight = picks.reduce((a, p) => (objected(p.symbol) || p.weight === null ? a : a + p.weight), 0);
  const counts = { object: 0, unsure: 0, agree: 0, none: 0, late: 0 };
  const out: DecisionPick[] = picks.map((p) => {
    const c = counted.get(p.symbol) ?? null;
    const l = c === null ? late.get(p.symbol) ?? null : null;
    if (c !== null) counts[c.verdict] += 1;
    else {
      counts.none += 1;
      if (l !== null) counts.late += 1;
    }
    const isHeld = kind === 'book' ? held.has(p.symbol) : null;
    let twinWeight: number | null = null;
    let source: 'twin_book' | 'expected' | null = null;
    if (kind === 'book') {
      if (twinDecided) {
        twinWeight = round(twinTargets.get(p.symbol) ?? 0, 6);
        source = 'twin_book';
      } else if (objected(p.symbol)) {
        twinWeight = 0;
        source = 'expected';
      } else if (!allObjected && p.weight !== null && keptWeight > 0) {
        twinWeight = round(p.weight / keptWeight, 6);
        source = 'expected';
      }
    }
    const shown = c ?? l;
    const action: 'sell' | 'skip' | null = c?.verdict === 'object' ? (isHeld === true ? 'sell' : 'skip') : null;
    const verdict: AdversaryVerdict | null =
      shown === null
        ? null
        : { ...shown, weight: kind === 'book' ? p.weight : null, twin_weight: twinWeight, twin_weight_source: source, held: isHeld, action };
    return { rank: p.rank, symbol: p.symbol, weight: p.weight, held: isHeld, twin_weight: twinWeight, twin_weight_source: source, verdict };
  });
  const used = [...counted.values()];
  return {
    strategy_id: i.strategy_id,
    twin_id: i.twin_id,
    session_date: i.session_date,
    data_date: head.data_date,
    kind,
    open_utc: i.open_utc,
    coverage: coverageState(i.pending, used.length, i.paused),
    first_started_at: used.map((v) => v.started_at).sort()[0] ?? null,
    last_decided_at: used.map((v) => v.decided_at).sort().at(-1) ?? null,
    models: uniq(used.map((v) => v.model)),
    prompt_versions: uniq(used.map((v) => v.prompt_version)),
    lenses: uniq(used.map((v) => v.lens)),
    hosts: uniq(used.map((v) => v.host)),
    counts,
    all_objected: kind === 'book' && allObjected,
    verdicts: out.flatMap((p) => (p.verdict !== null ? [p.verdict] : [])),
    picks: out,
  };
}

export interface ThreeWayInput {
  picks: unknown;
  verdicts: unknown;
  c_verdicts: unknown;
  a_orders: unknown;
  c_orders: unknown;
  twin_orders: unknown;
  a_decided: unknown;
  c_decided: unknown;
  twin_decided: unknown;
  has_twin: boolean;
}

const emptyGrid = (): DailyGrid => ({ c_veto_claude_object: [], c_veto_claude_keep: [], c_allow_claude_object: [], c_allow_claude_keep: [] });

export function buildThreeWayRows(i: ThreeWayInput): { rows: ThreeWayRow[]; grid: DailyGrid } {
  const picks = records(i.picks).map((p) => ({ rank: num(p.rank), symbol: str(p.symbol) }));
  const rankOf = new Map(picks.map((p) => [p.symbol, p.rank] as const));
  const { counted, late } = effective(i.verdicts, rankOf);
  const cBy = new Map<string, { verdict: CVerdict; reason: string; decided_at: string }>();
  for (const r of records(i.c_verdicts)) {
    const v = str(r.verdict);
    if (v === 'allow' || v === 'veto' || v === 'failed') cBy.set(str(r.symbol), { verdict: v, reason: str(r.reason), decided_at: str(r.decided_at) });
  }
  const buys = (present: boolean, decided: unknown, orders: unknown): ((s: string) => boolean | null) => {
    if (!present || !bool(decided)) return () => null;
    const set = new Set(strings(orders));
    return (s) => set.has(s);
  };
  const a = buys(true, i.a_decided, i.a_orders);
  const c = buys(true, i.c_decided, i.c_orders);
  const t = buys(i.has_twin, i.twin_decided, i.twin_orders);
  const grid = emptyGrid();
  const rows: ThreeWayRow[] = picks.map((p) => {
    const claude = counted.get(p.symbol) ?? late.get(p.symbol) ?? null;
    const cv = cBy.get(p.symbol) ?? null;
    if (cv !== null && cv.verdict !== 'failed') {
      const blocks = counted.get(p.symbol)?.verdict === 'object';
      const key = `c_${cv.verdict}_claude_${blocks ? 'object' : 'keep'}` as keyof DailyGrid;
      grid[key].push(p.symbol);
    }
    return { rank: p.rank, symbol: p.symbol, c: cv, claude, buys: { original: a(p.symbol), critic: c(p.symbol), twin: t(p.symbol) } };
  });
  return { rows, grid };
}

// ------------------------------------------------------------------------------------- the reader

/** Read-only access to everything the wall and the MCP tools show. Stateless: one per call is fine. */
export class AdversaryReader {
  constructor(private readonly db: ReadOnlySource) {}

  private async view(): Promise<RosterView> {
    return pairRoster(await readRoster(this.db));
  }

  private pairing(view: RosterView, id: string): Pairing {
    const p = findPairing(view, id);
    if (p === null) throw new AdversaryReadError('not_found', `no Seer Adversarial method "${id}"; adversary_overview lists them`);
    return p;
  }

  async overview(reviewer: AdversaryStatus | null, now: Date = new Date()): Promise<OverviewPayload> {
    const view = await this.view();
    const live = view.pairs.filter((p) => p.original.status === 'active' && p.twin !== null);
    const [market, decisions, latest, last, scores] = await Promise.all([
      readMarket(this.db, view.all),
      readDecisions(this.db, null),
      this.latestVerdicts(),
      this.lastReview(),
      Promise.all(live.map((p) => loadObjectionScores(this.db, p.original))),
    ]);
    const methods = live.map((p, k) => buildRow(p, market, view.spy, decisions, recordOf(methodOf(p).engine, scores[k] ?? []).summary));
    return {
      generated_at: now.toISOString(),
      started_on: startedOn(live, market),
      months_on_paper: monthsOnPaper(live, market),
      spy_id: view.spy?.id ?? null,
      roster: view.pairs.map(methodOf),
      methods,
      cause: causeOf(methods),
      latest,
      last_review: last,
      reviewer,
    };
  }

  async method(id: string): Promise<MethodPayload> {
    const view = await this.view();
    const pair = this.pairing(view, id);
    const method = methodOf(pair);
    const critic = criticOf(view, pair.original);
    const [market, decisions, scores, revisions] = await Promise.all([
      readMarket(this.db, view.all),
      readDecisions(this.db, pair.original.id),
      loadObjectionScores(this.db, pair.original),
      this.revisions(pair.original.id),
    ]);
    const record = recordOf(method.engine, scores);
    const row = buildRow(pair, market, view.spy, decisions, record.summary);
    const latest = latestSession(decisions);
    const [decision, threeWay] = await Promise.all([
      latest !== null ? this.decisionFor(pair, latest) : Promise.resolve(null),
      critic !== null ? this.threeWay(pair, critic, market, decisions, latest) : Promise.resolve(null),
    ]);
    return {
      method,
      row,
      lens_question: null,
      curves: curvesOf(row, market, view.spy),
      stats: row.figures,
      checklist: row.checklist,
      decision,
      decisions: [...decisions].reverse().map(summaryOf),
      record,
      revisions,
      three_way: threeWay,
    };
  }

  async decision(id: string, session: string): Promise<AdversaryDecision> {
    assertSession(session);
    const pair = this.pairing(await this.view(), id);
    const d = await this.decisionFor(pair, session);
    if (d === null) throw new AdversaryReadError('not_found', `${pair.original.id} has no decision for ${session}`);
    return d;
  }

  async daily(id: string, session?: string): Promise<ThreeWay> {
    if (session !== undefined) assertSession(session);
    const view = await this.view();
    const pair = this.pairing(view, id);
    if (pair.original.engine !== 'bracket') {
      throw new AdversaryReadError('not_bracket', `${pair.original.id} is a ${pair.original.engine} method; the three-way is for daily (bracket) methods`);
    }
    const critic = criticOf(view, pair.original);
    if (critic === null) throw new AdversaryReadError('not_found', `${pair.original.id} has no news-veto sibling to compare with`);
    const [market, decisions] = await Promise.all([readMarket(this.db, view.all), readDecisions(this.db, pair.original.id)]);
    const tw = await this.threeWay(pair, critic, market, decisions, session ?? latestSession(decisions));
    if (session !== undefined && tw.rows.length === 0) throw new AdversaryReadError('not_found', `${pair.original.id} has no decision for ${session}`);
    return tw;
  }

  async scorecard(id: string): Promise<ScorecardPayload> {
    const view = await this.view();
    const pair = this.pairing(view, id);
    const engine = methodOf(pair).engine;
    const critic = criticOf(view, pair.original);
    const [scores, duel] = await Promise.all([
      loadObjectionScores(this.db, pair.original),
      critic !== null ? loadDuel(this.db, pair.original, critic) : Promise.resolve(null),
    ]);
    return { strategy_id: pair.original.id, engine, record: recordOf(engine, scores), duel };
  }

  async verdicts(filter: { strategy?: string; session?: string; verdict?: VerdictKind; limit?: number }): Promise<VerdictList> {
    if (filter.session !== undefined) assertSession(filter.session);
    let strategyId: string | null = null;
    if (filter.strategy !== undefined) strategyId = this.pairing(await this.view(), filter.strategy).original.id;
    const limit = Math.max(1, Math.min(MAX_VERDICTS, Math.floor(filter.limit ?? 50)));
    const [res, decisions] = await Promise.all([
      this.db.query(VERDICTS_SQL, [strategyId, filter.session ?? null, filter.verdict ?? null], { maxRows: limit }),
      readDecisions(this.db, strategyId),
    ]);
    const verdicts = toObjects(res).flatMap((r) => {
      const v = toAdversaryVerdict(r, numOrNull(r.rank));
      return v === null ? [] : [v];
    });
    const stateBy = new Map(decisions.map((d) => [`${d.strategy_id}|${d.session_date}`, stateOf(d)] as const));
    const seen = new Set<string>();
    const sessions: VerdictList['sessions'] = [];
    for (const v of verdicts) {
      const key = `${v.strategy_id}|${v.session_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push({ strategy_id: v.strategy_id, session_date: v.session_date, coverage: stateBy.get(key) ?? 'absent' });
    }
    return { sessions, verdicts };
  }

  private async decisionFor(pair: Pairing, session: string): Promise<AdversaryDecision | null> {
    const res = await this.db.query(DECISION_SQL, [pair.original.id, session, pair.twin?.id ?? null], { maxRows: 1 });
    const r = toObjects(res)[0];
    if (r === undefined) return null;
    return buildDecision({
      strategy_id: pair.original.id,
      twin_id: pair.twin?.id ?? null,
      session_date: session,
      open_utc: str(r.open_utc),
      pending: bool(r.pending),
      paused: bool(r.paused),
      picks: r.picks,
      verdicts: r.verdicts,
      held: r.held,
      twin_targets: r.twin_targets,
      twin_decided: r.twin_decided,
    });
  }

  private async threeWay(pair: Pairing, critic: RosterEntry, market: Market, decisions: readonly DecisionRow[], session: string | null): Promise<ThreeWay> {
    const [sessionsRes, duel] = await Promise.all([
      this.db.query(SESSIONS_SQL, [pair.original.id], { maxRows: PAGE_ROWS }),
      loadDuel(this.db, pair.original, critic),
    ]);
    const base = {
      original: methodOf(pair),
      critic: methodOf({ original: critic, twin: null }),
      twin_id: pair.twin?.id ?? null,
      books: {
        original: ownFigures(pair.original, market),
        critic: ownFigures(critic, market),
        twin: pair.twin !== null ? ownFigures(pair.twin, market) : null,
      },
      sessions: toObjects(sessionsRes).map((r) => str(r.session_date)),
      settled:
        duel.scored > 0
          ? { claude_right: duel.claude_right, critic_right: duel.critic_right, disagreements: duel.disagreements, scored: duel.scored, pending: duel.pending, nights: duel.nights }
          : null,
      duel,
    };
    if (session === null) return { ...base, session_date: null, open_utc: null, coverage: null, rows: [], grid: emptyGrid() };
    const res = await this.db.query(THREE_WAY_SQL, [pair.original.id, session, critic.id, pair.twin?.id ?? null], { maxRows: 1 });
    const r = toObjects(res)[0] ?? {};
    const built = buildThreeWayRows({
      picks: r.picks,
      verdicts: r.verdicts,
      c_verdicts: r.c_verdicts,
      a_orders: r.a_orders,
      c_orders: r.c_orders,
      twin_orders: r.twin_orders,
      a_decided: r.a_decided,
      c_decided: r.c_decided,
      twin_decided: r.twin_decided,
      has_twin: pair.twin !== null,
    });
    const d = decisions.find((x) => x.session_date === session);
    return { ...base, session_date: session, open_utc: strOrNull(r.open_utc), coverage: d !== undefined ? stateOf(d) : null, ...built };
  }

  private async latestVerdicts(): Promise<AdversaryVerdict[]> {
    const res = await this.db.query(LATEST_SQL, [], { maxRows: LATEST_VERDICTS });
    return toObjects(res).flatMap((r) => {
      const v = toAdversaryVerdict(r, numOrNull(r.rank));
      return v === null ? [] : [v];
    });
  }

  private async lastReview(): Promise<LastReview | null> {
    const r = toObjects(await this.db.query(LAST_REVIEW_SQL, [], { maxRows: 1 }))[0];
    if (r === undefined) return null;
    return { strategy_id: str(r.strategy_id), session_date: str(r.session_date), picks: num(r.picks), finished_at: str(r.finished_at) };
  }

  private async revisions(strategyId: string): Promise<Revision[]> {
    const rows = toObjects(await this.db.query(REVISIONS_SQL, [strategyId], { maxRows: PAGE_ROWS }));
    return rows.map((r, i) => ({
      since: str(r.first_decided_at),
      until: i === 0 ? null : str(r.last_decided_at),
      prompt_version: str(r.prompt_version),
      model: str(r.model),
      lens: str(r.lens),
      verdicts: num(r.verdicts),
      note: null,
    }));
  }
}
```
**Impact:** none on existing code.

### Step 6: HTTP routes
**File:** `src/http/adversaryApi.ts` (new)
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AdversaryReader } from '../adversary/read.js';
import { AdversaryReadError, findPairing, pairRoster, readRoster } from '../adversary/readSql.js';
import type { ReviewNowResult } from '../adversary/readTypes.js';
import { reasonOf } from '../connectors/errors.js';
import { createSeerConnector } from '../connectors/seer/index.js';
import { ConnectorError, type ReadOnlySource } from '../connectors/types.js';
import type { AppDeps } from '../deps.js';
import { describeIssues } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * /api/adversary/* (SEER_ADVERSARIAL_PLAN phase 5): the read model over Seer's DB, and the toggle and
 * "Review now" of phase 4's reviewer. Reads need no reviewer (they work with NOTESD_ADVERSARY=off);
 * writes to the reviewer are same-origin only. Inputs are validated here once.
 */

export interface AdversaryApiOptions {
  /** Seer's database, read-only. Omitted: the Seer connector (SEER_DIR/.env.local, re-read per query). */
  seer?: ReadOnlySource;
}

const idParam = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const toggleBody = z.object({ on: z.boolean() }).strict();
const reviewNowBody = z.object({ strategy_id: idParam.optional() }).strict();

const REVIEWER_OFF = {
  error: 'reviewer_off',
  message: 'The Seer Adversarial reviewer is not running on this machine (NOTESD_ADVERSARY=off).',
} as const;

export type SeerUnavailableDetail = 'not_reachable' | 'not_migrated' | 'query_failed';

/** The 503 body for a Seer that cannot be read (repo, .env.local, DB, or migration 027 missing). */
export function seerUnavailable(err: ConnectorError): { error: 'seer_unavailable'; detail: SeerUnavailableDetail; reason: string } {
  const m = err.message;
  const detail: SeerUnavailableDetail = / is not reachable: /.test(m) ? 'not_reachable' : /does not exist/.test(m) ? 'not_migrated' : 'query_failed';
  return { error: 'seer_unavailable', detail, reason: m };
}

export function adversaryApiRoutes(deps: Pick<AppDeps, 'adversary'>, options: AdversaryApiOptions = {}): Hono {
  const api = new Hono();
  const seer = options.seer ?? createSeerConnector();
  const reader = new AdversaryReader(seer);
  const reviewer = deps.adversary ?? null;

  function failure(c: Context, err: unknown): Response {
    if (err instanceof AdversaryReadError) return c.json({ error: err.code, message: err.message }, err.code === 'not_found' ? 404 : 400);
    if (err instanceof ConnectorError) return c.json(seerUnavailable(err), 503);
    throw err;
  }

  async function answer(c: Context, fn: () => Promise<unknown>): Promise<Response> {
    try {
      return c.json((await fn()) as Record<string, unknown>);
    } catch (err) {
      return failure(c, err);
    }
  }

  function idOf(c: Context): string | null {
    const p = idParam.safeParse(c.req.param('id'));
    return p.success ? p.data : null;
  }

  api.get('/api/adversary/overview', (c) =>
    answer(c, async () => reader.overview(reviewer !== null ? await reviewer.status().catch(() => null) : null)),
  );

  api.get('/api/adversary/methods/:id', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    return answer(c, () => reader.method(id));
  });

  api.get('/api/adversary/methods/:id/decisions/:session', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    return answer(c, () => reader.decision(id, c.req.param('session')));
  });

  api.get('/api/adversary/daily/:id', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    const session = c.req.query('session');
    return answer(c, () => reader.daily(id, session === undefined || session === '' ? undefined : session));
  });

  api.get('/api/adversary/scorecard/:id', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    return answer(c, () => reader.scorecard(id));
  });

  api.get('/api/adversary/toggle', async (c) => {
    if (reviewer === null) return c.json(REVIEWER_OFF, 503);
    return c.json(await reviewer.getToggle());
  });

  api.put('/api/adversary/toggle', sameOriginOnly, async (c) => {
    if (reviewer === null) return c.json(REVIEWER_OFF, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = toggleBody.safeParse(body);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    return c.json(await reviewer.setToggle(parsed.data.on, reviewer.host));
  });

  /** Starts one manual pass (it runs even while the toggle is off) and answers before it finishes. */
  api.post('/api/adversary/review-now', sameOriginOnly, async (c) => {
    if (reviewer === null) return c.json(REVIEWER_OFF, 503);
    const text = await c.req.text();
    let body: unknown = {};
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }
    const parsed = reviewNowBody.safeParse(body);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    let strategyId: string | undefined;
    if (parsed.data.strategy_id !== undefined) {
      try {
        const pair = findPairing(pairRoster(await readRoster(seer)), parsed.data.strategy_id);
        if (pair === null) return c.json({ error: 'not_found', message: `no Seer Adversarial method "${parsed.data.strategy_id}"` }, 404);
        strategyId = pair.original.id;
      } catch (err) {
        return failure(c, err);
      }
    }
    const status = await reviewer.status().catch(() => null);
    void reviewer
      .reviewNow(strategyId !== undefined ? { strategyId } : {})
      .catch((err: unknown) => console.error(`[notesd] adversary review-now failed: ${reasonOf(err)}`));
    const result: ReviewNowResult = {
      started: true,
      reason: status?.running ? `queued behind the ${status.running} pass already running` : null,
    };
    return c.json(result, 202);
  });

  return api;
}
```
**Impact:** none until mounted (Step 7).

### Step 7: Mount the routes, give MCP the reviewer
**File:** `src/http/app.ts:1-22` (imports), `:41-51` (`CreateAppOptions`), `:62-81` (`mcpToolDeps`), `:112-113` (mount)
**Change:** four edits.
**Code:** add after `import type { AppDeps } from '../deps.js';` (line 3):
```ts
import type { ReadOnlySource } from '../connectors/types.js';
```
and after `import { apiRoutes } from './api.js';` (line 10):
```ts
import { adversaryApiRoutes } from './adversaryApi.js';
```
Add to `CreateAppOptions`, after `unfinished?: UnfinishedChecker;` (line 50):
```ts
  /** Seer's database for /api/adversary/* (tests). Omitted: the Seer connector from SEER_DIR. */
  adversarySeer?: ReadOnlySource;
```
Replace the `return { … }` of `mcpToolDeps` (lines 68-75) with:
```ts
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    imageEmbedder: deps.imageEmbedder ?? null,
    chatUploads: dbChatUploadSource(deps.db, deps.config.dataDir),
    sessions: sessionsReadDeps(deps, sessionOverrides),
    adversary: deps.adversary,
    ...(wallUrl !== undefined ? { wallUrl } : {}),
    ...(extra.sessionResume !== undefined ? { sessionResume: extra.sessionResume } : {}),
  };
```
Replace lines 112-113:
```ts
  app.route('/', sessionResumeRoutes(deps, { resumer: sessionResume }));
  app.route('/', adversaryApiRoutes(deps, { seer: options.adversarySeer }));
  app.route('/', staticRoutes(deps));
```
and in the `createApp` doc comment (line ~88), insert `adversaryApiRoutes (seer-adversarial phase 5:
the Seer Adversarial read model, toggle and review-now),` before `staticRoutes`.
**Impact:** `/api/adversary/*` is served before the SPA fallback; `/mcp` tools see the reviewer.

### Step 8: SSE relay
**File:** `src/http/api.ts:22` (imports), `:271-302` (`/api/events`)
**Change:** subscribe to `deps.adversary.events` when the reviewer exists; write `event: adversary`.
**Code:** add after `import type { AppDeps } from '../deps.js';` (line 22):
```ts
import type { AdversaryChange } from '../adversary/events.js';
```
Replace the whole `api.get('/api/events', …)` handler (lines 271-302) with:
```ts
  api.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      const onNote = (event: NoteEvent): void => {
        if (closed) return;
        void stream
          .writeSSE({ event: 'note', data: JSON.stringify({ op: event.op, id: event.id }) })
          .catch(() => undefined);
      };
      const onChat = (change: ChatChange): void => {
        if (closed) return;
        void stream
          .writeSSE({
            event: 'chat',
            data: JSON.stringify({ op: change.op, thread_id: change.thread_id, id: change.id }),
          })
          .catch(() => undefined);
      };
      // Seer Adversarial (phase 5): the reviewer's verdict / mark / toggle / run changes, so the wall refetches.
      const onAdversary = (change: AdversaryChange): void => {
        if (closed) return;
        void stream
          .writeSSE({
            event: 'adversary',
            data: JSON.stringify({ op: change.op, strategy_id: change.strategy_id ?? null, session_date: change.session_date ?? null }),
          })
          .catch(() => undefined);
      };
      const unsubscribeNote = deps.events.on(onNote);
      const unsubscribeChat = history.events.on(onChat);
      const unsubscribeAdversary = deps.adversary !== null ? deps.adversary.events.on(onAdversary) : (): void => undefined;
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(timer);
          unsubscribeNote();
          unsubscribeChat();
          unsubscribeAdversary();
          resolve();
        });
        void stream.write(': connected\n\n').catch(() => undefined);
      });
    }),
  );
```
**Impact:** wall clients receive one more event type; `note` and `chat` events are unchanged.

### Step 9: MCP tools
**File:** `src/mcp/adversaryTools.ts` (new)
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AdversaryReader } from '../adversary/read.js';
import { ADVERSARY_TOOL_NAMES } from '../chat/status.js';
import { createSeerConnector } from '../connectors/seer/index.js';
import { run, type ToolDeps } from './tools.js';

const [OVERVIEW, VERDICTS, SCORECARD] = ADVERSARY_TOOL_NAMES;

const strategyField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/)
  .describe("A Seer strategy id such as 'A-GT' or 'RAW35-FR-GT' (any case). A twin's id ('A-GT-CX') means its original. adversary_overview lists them.");

const OVERVIEW_DESCRIPTION =
  "Seer Adversarial: Claude reviews the picks of every method on Seer's roster before they are bought, and each method has a " +
  "Claude twin, a paper book that runs the same method but drops what Claude objected to. Returns roster (every method, active " +
  'first, then retired), methods (each active method with a twin: returns.original / .twin / .spy, money-weighted with deposits ' +
  "included, over the twin's record since it started; objections.objected / .reviewed / .fell_after (objected stocks that then " +
  'did worse than the kept picks); coverage: decisions reviewed in time, absent (nobody reviewed before the open, or too late), ' +
  "paused (the owner turned automatic reviews off), pending (not open yet); checklist.original / .twin: Seer's five go-live rules " +
  "with Seer's own wording in seer.label / seer.val; a twin's backtest is 'na' because Claude knows how the past turned out), " +
  'cause (twins ahead of SPY, extra_profit_usd beyond the originals, drawdown_delta_pts), latest (the newest objections and ' +
  "can't-tell verdicts with reasons, sources and the host that made them), last_review and reviewer (this machine's reviewer, " +
  'null when it is off). Fractions: 0.054 = +5.4%. Money: USD. Quote the numbers as given; never compute or invent your own.';

const VERDICTS_DESCRIPTION =
  "Claude's verdicts on Seer picks: agree, object, or unsure (Claude could not tell, so the pick is kept). Each has the stock " +
  "(symbol), the decision session it was for, a plain-words reason, numbered sources (url, publisher, fetched_at), the model, " +
  'prompt_version, lens and host, and late: true when it was decided after the session opened (kept for the record, but the twin ' +
  'ignored it). Without session it answers each method\'s latest decision, so "what did Claude object to today?" is ' +
  'verdict "object" with no other filter. sessions[] gives each decision\'s coverage (reviewed, absent, paused, pending).';

const SCORECARD_DESCRIPTION =
  "Whether Claude's objections were right for one method. record.points: for each objection whose horizon has passed, the stock's " +
  "return over the method's own horizon (5 sessions for the daily dip-buy method, until the next rebalance for a book) against " +
  'the average of the picks Claude kept on the same decision; gap_pts below 0 means the dropped stock did worse, i.e. Claude was ' +
  'right; outcome worse / same (within half a point) / better. record.summary counts them; record.pending lists objections still ' +
  "inside their horizon. duel (daily methods with C, Seer's news model): on the nights C and Claude disagreed, who was right, " +
  'judged against the names neither blocked. Few calls cannot tell skill from luck; say so.';

/** Read-only Seer Adversarial tools (phase 5). Seer is read through the connector, per call. */
export function registerAdversaryTools(server: McpServer, deps: Pick<ToolDeps, 'connectors' | 'adversary'>): void {
  const reader = (): AdversaryReader => new AdversaryReader(deps.connectors?.seer ?? createSeerConnector());

  server.registerTool(
    OVERVIEW,
    { title: 'Seer Adversarial overview', description: OVERVIEW_DESCRIPTION, annotations: { readOnlyHint: true } },
    async () =>
      run(async () => reader().overview(deps.adversary ? await deps.adversary.status().catch(() => null) : null), { compact: true }),
  );

  server.registerTool(
    VERDICTS,
    {
      title: "Claude's verdicts on Seer picks",
      description: VERDICTS_DESCRIPTION,
      inputSchema: {
        strategy: strategyField.optional(),
        session: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('The decision session, YYYY-MM-DD (the day the stock would be bought). Omit for each method\'s latest decision.'),
        verdict: z
          .enum(['agree', 'object', 'unsure'])
          .optional()
          .describe("Only this verdict: 'object' (Claude dropped it), 'agree', or 'unsure' (could not tell; kept)."),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many verdicts. Default 50.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ strategy, session, verdict, limit }) =>
      run(
        () =>
          reader().verdicts({
            ...(strategy !== undefined ? { strategy } : {}),
            ...(session !== undefined ? { session } : {}),
            ...(verdict !== undefined ? { verdict } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        { compact: true },
      ),
  );

  server.registerTool(
    SCORECARD,
    {
      title: "Claude's record on one Seer method",
      description: SCORECARD_DESCRIPTION,
      inputSchema: { strategy: strategyField },
      annotations: { readOnlyHint: true },
    },
    async ({ strategy }) => run(() => reader().scorecard(strategy), { compact: true }),
  );
}
```
**Impact:** none until registered (Step 10).

### Step 10: ToolDeps, server registration
**File:** `src/mcp/tools.ts:11-12` (imports) and `:33` (`ToolDeps`)
**Code:** add after `import type { SessionResumer } from '../sessions/resume.js';` (line 12):
```ts
import type { AdversaryService } from '../adversary/service.js';
```
add after `sessionResume?: SessionResumer;` (line 33):
```ts
  /** Seer Adversarial reviewer (phase 4) for adversary_overview's `reviewer`. Omitted or null: reported as null. */
  adversary?: AdversaryService | null;
```
**File:** `src/mcp/server.ts:3-8` (imports) and `:24` (registration)
**Code:** add after `import { registerImageTools } from './imageTools.js';`:
```ts
import { registerAdversaryTools } from './adversaryTools.js';
```
replace line 24-25:
```ts
  registerConnectorTools(server, deps.connectors ?? defaultConnectors());
  // Seer Adversarial (phase 5): read-only, reads Seer through the connector per call.
  registerAdversaryTools(server, deps);
  return server;
```
**Impact:** `/mcp` lists three more tools.

### Step 11: Server instructions
**File:** `src/mcp/instructions.ts:57-58`
**Change:** insert one paragraph between the `Connectors.` and `Sessions.` entries of `sections` (Sessions stays last, pinned by `tests/unit/mcp.instructions.test.ts:134`). Its last sentence explains the wall pill's first-line context `[Seer Adversarial · <strategy_id|overview>]` (phase 6's `adversaryChatMessage` sends it; assigned here by the reconciler, because phase 6 owns no server prompt text). Also update the doc comment above `buildInstructions` to say "seer-adversarial phase 5 inserts the Adversary paragraph before Sessions".
**Code:** the new array entry, placed right after the `Connectors.` template literal's closing `` `, ``:
```ts
    `Adversary. Seer Adversarial is Claude reviewing the picks of every method on Seer's roster before they are bought: each method has a Claude twin, a paper book that runs the same method but drops what Claude objected to, so the owner can see over time whether the twins beat the originals and SPY. adversary_overview returns every method with its original, twin and SPY returns since the twin started (money-weighted, deposits included), objections, coverage (reviewed in time, absent: nobody reviewed it before the session opened, paused: the owner turned automatic reviews off) and both go-live checklists. adversary_verdicts(strategy?, session?, verdict?) lists Claude's verdicts (agree, object, unsure = could not tell, the pick is kept) with reasons, numbered sources and the host that made them; with no session it answers each method's latest decision, so "what did Claude object to today?" is adversary_verdicts with verdict "object". adversary_scorecard(strategy) says whether the objections were right: each objected stock's return over the method's own horizon against the picks it kept, and for the daily dip-buy method Claude against C, the news model, on the nights they disagree. Only verdicts decided before the session opened count; late: true means one came too late and changed nothing. Numbers come from Seer's database: quote them, never invent them, and say when there are still too few calls to tell skill from luck. Strategy ids come from these tools or seer_leaderboard; never invent one. A chat turn whose first line is [Seer Adversarial · <strategy_id|overview>] was asked from that page of the wall (the overview, or that method's page): answer it with the adversary_* tools for that strategy, or for the whole roster on overview.`,
```
**Impact:** every MCP session reads one more paragraph.

### Step 12: Chat allow-list and captions
**File:** `src/chat/status.ts:42-50` (names), `:64-71` (`allowedChatTools`), `:134-145` (`captionForToolUse`)
**Code:** insert after `export type SessionToolName = …;` (line 50):
```ts

/** Read-only Seer Adversarial tools (SEER_ADVERSARIAL_PLAN phase 5): src/mcp/adversaryTools.ts registers them under these names. */
export const ADVERSARY_TOOL_NAMES = ['adversary_overview', 'adversary_verdicts', 'adversary_scorecard'] as const;

export type AdversaryToolName = (typeof ADVERSARY_TOOL_NAMES)[number];
```
Replace the doc comment and body of `allowedChatTools` (lines 56-71):
```ts
/**
 * Exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 15 connector tools and
 * WebSearch + WebFetch (CONNECTORS_PLAN invariant 8, which supersedes CHAT_BAR_BRAIN_PLAN invariant 4;
 * SEMANTIC_SEARCH_PLAN phase 5 adds `related`; WALL_EDITING_PLAN phase 3 adds
 * `attach_image`, `remove_image` and `restore_image`; CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN
 * phase 6 adds `similar_images`; PROJECT_SESSION_GRAPH_PLAN phase 7 adds the session tools;
 * PROJECT_SESSION_GRAPH_PLAN phase 9 adds `session_resume`; SEER_ADVERSARIAL_PLAN phase 5 adds the
 * adversary tools).
 */
export function allowedChatTools(): string[] {
  return [
    ...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...SESSION_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...ADVERSARY_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...ALL_CONNECTOR_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...WEB_TOOL_NAMES,
  ];
}
```
In `captionForToolUse`, insert before `default:` (line 145):
```ts
    case 'adversary_overview':
      return 'reading Seer Adversarial';
    case 'adversary_verdicts':
      return "reading Claude's verdicts";
    case 'adversary_scorecard':
      return "reading Claude's record";
```
**Impact:** the wall chat (Agent SDK) may call the three tools; `tests/unit/chat-status.test.ts` counts change (Step 15).

### Step 13: README tables
**File:** `README.md:981` (MCP table, after the `link_note` row), `:992`, `:1030`, `:1067` (HTTP table, after the hook row)
**Code:** after line 981 add:
```markdown
| `adversary_overview` | Seer Adversarial: every Seer method with its Claude twin and SPY, returns since the twin started (money-weighted, deposits included), objections, coverage (reviewed · absent · paused · pending), both go-live checklists (Seer's five rules and wording; a twin's backtest "can't be run"), the newest objections and the reviewer's status |
| `adversary_verdicts` | Claude's verdicts (`agree`, `object`, `unsure`) with reasons, sources, model, prompt version and host; `late: true` when decided after the open. Optional `strategy`, `session` (default: each method's latest decision), `verdict`, `limit` |
| `adversary_scorecard` | One method's record: each objected stock's return over the method's horizon (5 sessions for a daily method, until the next rebalance for a book) against the kept picks; for a daily method with C, Claude against C on the nights they disagree |
```
Replace line 992's last sentence `The chat bar can use the five session tools too.` with
`The chat bar can use the five session tools and the three adversary tools too.`
Replace line 1030 with:
```markdown
| `GET /api/events` | Server-sent events, `event: note` on every note change, `event: chat {op, thread_id, id}` on every chat change and `event: adversary {op, strategy_id, session_date}` on every Seer Adversarial reviewer change (`op`: `verdict`, `mark`, `toggle`, `run`) |
```
After line 1067 add:
```markdown
| `GET /api/adversary/overview` | Seer Adversarial overview: `roster`, `methods` (returns, objections, coverage, checklists per method), `cause`, `latest`, `last_review`, `reviewer`. 503 `seer_unavailable` (`detail`: `not_reachable`, `not_migrated`, `query_failed`) when Seer cannot be read |
| `GET /api/adversary/methods/:id` | One method (any case; a twin id means its original): curves (growth of 100, deposits taken out), stats, checklists, the current decision's verdict cards, every decision, the objection record, revisions, and the A / C / A+Claude three-way for a daily method |
| `GET /api/adversary/methods/:id/decisions/:session` | One decision's verdict cards: reason, sources, host, `late`, weight → twin weight, `held · sell` / `new · skip`. 404 `not_found`, 400 `invalid_session` |
| `GET /api/adversary/daily/:id?session=` | The three-way for a daily method on one session (default: the latest): A's ranked list with C's and Claude's verdicts, what each book bought, the disagreement grid and who was right so far. 400 `not_bracket` |
| `GET /api/adversary/scorecard/:id` | Each objection's horizon return against the kept picks, and Claude against C |
| `GET/PUT /api/adversary/toggle` | Automatic reviews on or off (`{on}`), shared by both machines; `PUT` is same-origin only. 503 `reviewer_off` when this daemon runs with `NOTESD_ADVERSARY=off` |
| `POST /api/adversary/review-now` | `{strategy_id?}`: start one review pass now, even while automatic reviews are off; 202 `{started, reason}` before it finishes. Same-origin only |
```
**Impact:** docs only.

### Step 14: Feature map entry
**File:** `.claude/skills/verify-notesd/features/adversary.md` (phase 4 creates it with the reviewer section, and the `features/README.md` row; append at the end). Reconciled: never create or replace it here. Phase 5 depends on phase 4, so the file exists; if it does not, phase 4 has not landed and Step 0 stops. In `features/README.md`, edit phase 4's existing row only, to `| Seer Adversarial: reviewer, verdicts in Seer, toggle, budget, read API, MCP, SSE | [adversary.md](adversary.md) | background job (`up --adversary`), Seer DB, API, MCP, SSE |` (phase 6 appends `, wall` to both cells).
**Code:** append:
```markdown

## Read API, MCP tools and SSE (phase 5)

### Sub-features
- `GET /api/adversary/overview`: every Seer original (`roster`), each active one with a twin
  (`methods`) with returns since the twin started (money-weighted, deposits included), objections
  (`objected`, `reviewed`, `fell_after`), coverage (`reviewed`, `absent`, `late`, `paused`,
  `pending`), both checklists (Seer's five rules, Seer's own strings under `seer`; a twin's rule 5 is
  `state: "na"`, `seer.val: "Can't be run"`), `cause`, `latest` (≤ 8), `last_review`, `reviewer`.
- `GET /api/adversary/methods/:id`: curves (growth of 100, deposits taken out), stats, checklists,
  current decision, every decision, record of objections, revisions, three-way (daily methods).
- `GET /api/adversary/methods/:id/decisions/:session`: verdict cards with `late`, weights, `held`, `action`.
- `GET /api/adversary/daily/:id?session=`: A / C / A+Claude rows, `buys`, `grid`, `settled`.
- `GET /api/adversary/scorecard/:id`: horizon record, C-vs-Claude duel.
- `GET/PUT /api/adversary/toggle`, `POST /api/adversary/review-now` (same-origin, 202).
- SSE `event: adversary {op, strategy_id, session_date}` on `/api/events`.
- MCP `adversary_overview`, `adversary_verdicts`, `adversary_scorecard` (read-only; chat may use them).

### How to get to it (user POV)
- Claude Code: "/n what did Claude object to today?" (MCP `adversary_verdicts` with `verdict: "object"`).
- The wall's `/adversary` page (phase 6) reads these routes and refreshes on `event: adversary`.

### Driving it with verify.sh
- `SEER_DIR=<seer checkout with 027> $V up --adversary`, then
  `$V exec RUN --seer "$(cat tests/fixtures/adversary/seer-seed.sql)"`, then
  `$V api RUN GET /api/adversary/overview`, `$V mcp RUN adversary_verdicts '{"verdict":"object"}'`.
  The expected values for that fixture are phase 5's Proof (`.workflows/plan/seer-adversarial/phase-5.md`).
- Seeded sessions are all in the past, so a reviewer pointed at this DB finds nothing due and spends nothing.

### Gotchas
- 503 `seer_unavailable` with `detail: "not_migrated"` means Seer has no migration 027 yet.
- The checklist is Seer's own and is NOT money-weighted (raw equity, as seertrade.site shows it); the
  money-weighted figures are `returns.*` and `figures.*.return`.
- A twin decides one session late, so its `buys` read `null` on the decision night.
```
**Impact:** docs only.

### Step 15: Unit tests
**File:** `tests/unit/chat-status.test.ts:1-28`
**Change:** replace lines 1-28 (imports and the first `it`) with:
```ts
import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES } from '../../src/connectors/names.js';
import { ADVERSARY_TOOL_NAMES, NOTES_TOOL_NAMES, SESSION_TOOL_NAMES, allowedChatTools, captionForToolUse } from '../../src/chat/status.js';

const n = (name: string): string => `mcp__notes__${name}`;

describe('allowedChatTools', () => {
  it('is exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 15 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(19);
    expect(SESSION_TOOL_NAMES).toHaveLength(5);
    expect(ADVERSARY_TOOL_NAMES).toHaveLength(3);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(tools).toHaveLength(19 + 5 + 3 + 15 + 2);
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

  it('captions the adversary tools', () => {
    expect(captionForToolUse(n('adversary_overview'), {})).toBe('reading Seer Adversarial');
    expect(captionForToolUse(n('adversary_verdicts'), { verdict: 'object' })).toBe("reading Claude's verdicts");
    expect(captionForToolUse(n('adversary_scorecard'), { strategy: 'A-GT' })).toBe("reading Claude's record");
  });
```
(the `it('offers no tool that deletes permanently', …)` and the closing `});` of the describe stay as they are).

**File:** `tests/unit/mcp.instructions.test.ts` (append at the end of the file)
**Code:**
```ts
describe('buildInstructions: Seer Adversarial', () => {
  it('has one Adversary paragraph, right before Sessions, naming the three tools and the honesty rules', () => {
    const text = buildInstructions('Asia/Jakarta');
    const paragraphs = text.split('\n\n').filter((p) => p.startsWith('Adversary.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['adversary_overview', 'adversary_verdicts', 'adversary_scorecard', 'money-weighted', 'before the session opened', 'never invent', '[Seer Adversarial · <strategy_id|overview>]']) {
      expect(p).toContain(word);
    }
    const order = text.split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Adversary')).toBe(order.indexOf('Sessions') - 1);
  });
});
```

**File:** `tests/unit/adversary/golive.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import * as gl from '../../../src/adversary/golive.js';
import { sinceStartMetrics } from '../../../src/connectors/seer/ranking.js';

const snap = (date: string, equity: number): { date: string; equity: number } => ({ date, equity });
const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const GATE_PASSED: gl.Gate = { passed: true, applicable: true, twin: false };

describe('Seer checklist parity (web/lib/metrics.ts)', () => {
  it('has the five rules with Seer labels and values, months floored to one decimal', () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2027-07-01', 150)], gl.tradeStats([30, -10]));
    const items = gl.checklistItems(m, 0.2, GATE_PASSED);
    expect(items).toHaveLength(gl.CHECKLIST_RULES);
    expect(items.map((i) => i.seer.label)).toEqual(['≥ 18 months forward', 'Beats SPY', 'Profit factor ≥ 1.3', 'Max drawdown ≤ 25%', 'Backtest gate passed']);
    expect(items.map((i) => i.seer.val)).toEqual(['17.9 mo', '+50.0 vs +20.0', '3.00', '0.0%', 'Passed']);
    expect(items.map((i) => i.state)).toEqual(['fail', 'pass', 'pass', 'pass', 'pass']);
    expect(items[0]!.value).toBe('17.9 of 18 mo');
    expect(items[0]!.progress).toBeCloseTo(m.months / 18, 10);
    expect(items[1]!.value).toBe('+30.0 pts');
  });

  it('writes a loss with the Unicode minus, an empty PF as a dash, no losses as ∞', () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-02-01', 95)], gl.tradeStats([]));
    const seer = gl.seerChecklist(m, 0.02, GATE_PASSED);
    expect(seer[1]).toEqual({ label: 'Beats SPY', val: '−5.0 vs +2.0', ok: false });
    expect(seer[2]).toEqual({ label: 'Profit factor ≥ 1.3', val: '—', ok: false });
    const noLoss = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-02-01', 101)], gl.tradeStats([5, 7]));
    expect(gl.seerChecklist(noLoss, null, GATE_PASSED)[2]).toEqual({ label: 'Profit factor ≥ 1.3', val: '∞', ok: true });
    expect(gl.seerChecklist(noLoss, null, GATE_PASSED)[1]).toEqual({ label: 'Beats SPY', val: '—', ok: false });
  });

  it('passes a drawdown of exactly 25% (≤), measured on raw equity like Seer', () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-01-02', 75), snap('2026-01-05', 100)], gl.tradeStats([]));
    expect(gl.seerChecklist(m, null, GATE_PASSED)[3]).toEqual({ label: 'Max drawdown ≤ 25%', val: '25.0%', ok: true });
  });

  it("rule 5: not passed, not applicable (C), and a twin's backtest that can never be run", () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-02-01', 110)], gl.tradeStats([]));
    const notPassed = gl.checklistItems(m, null, { passed: false, applicable: true, twin: false })[4]!;
    expect(notPassed).toMatchObject({ state: 'fail', value: 'failed', seer: { label: 'Backtest gate passed', val: 'Not passed', ok: false } });
    const na = gl.checklistItems(m, null, { passed: false, applicable: false, twin: false })[4]!;
    expect(na).toMatchObject({ state: 'na', value: 'not applicable', seer: { label: 'Backtest gate', val: 'Not applicable', ok: false } });
    const twin = gl.checklistItems(m, null, gl.parseGate({ passed: true, applicable: true }, true))[4]!;
    expect(twin).toMatchObject({ state: 'na', value: "can't be run", seer: { label: 'Backtest gate', val: "Can't be run", ok: false } });
  });

  it('parseGate never assumes a pass', () => {
    expect(gl.parseGate(null, false)).toEqual({ passed: false, applicable: true, twin: false });
    expect(gl.parseGate('[1]', false)).toEqual({ passed: false, applicable: true, twin: false });
    expect(gl.parseGate({ applicable: false, passed: true }, false)).toEqual({ passed: false, applicable: false, twin: false });
    expect(gl.parseGate('{"passed": true}', false)).toEqual({ passed: true, applicable: true, twin: false });
  });

  it("spyOverSpan reads SPY on the curve's own first and last dates", () => {
    const spy = [snap('2026-01-01', 100), snap('2026-01-02', 104), snap('2026-01-05', 110)];
    expect(gl.spyOverSpan(spy, [snap('2026-01-02', 1), snap('2026-01-05', 2)])).toBeCloseTo(110 / 104 - 1, 12);
    expect(gl.spyOverSpan(spy, [snap('2026-01-03', 1), snap('2026-01-05', 2)])).toBeNull();
    expect(gl.spyOverSpan(spy, [snap('2026-01-05', 2)])).toBeNull();
  });
});

describe('money-weighted return (engine backtest/metrics.py money_weighted_return)', () => {
  it('equals CAGR with no deposits', () => {
    const s = [snap('2020-01-01', 100), snap('2022-01-01', 121)];
    const cagr = Math.pow(1.21, gl.YEAR_DAYS / gl.daysBetween('2020-01-01', '2022-01-01')) - 1;
    expect(gl.moneyWeightedReturn(s, [])).toBeCloseTo(cagr, 10);
  });

  it('is zero for a book that earns nothing on its deposits', () => {
    const s = [snap('2026-01-02', 100), snap('2026-12-31', 300)];
    const flows = [{ date: '2026-03-02', amount: 100 }, { date: '2026-06-01', amount: 100 }];
    expect(gl.moneyWeightedReturn(s, flows)).toBeCloseTo(0, 9);
    expect(gl.periodMoneyWeightedReturn(s, flows)).toBeCloseTo(0, 9);
  });

  it('recovers a known rate through a deposit (round trip)', () => {
    const r = 0.1;
    const start = '2024-01-01';
    const t1 = 200;
    const end = 730;
    const final = 100 * (1 + r) ** (end / gl.YEAR_DAYS) + 50 * (1 + r) ** ((end - t1) / gl.YEAR_DAYS);
    const got = gl.moneyWeightedReturn([snap(start, 100), snap(addDays(start, end), final)], [{ date: addDays(start, t1), amount: 50 }]);
    expect(got).toBeCloseTo(r, 9);
  });

  it('ignores deposits outside (first, last] and sums deposits on one session', () => {
    const s = [snap('2026-01-01', 100), snap('2026-03-01', 220)];
    const inside = [{ date: '2026-02-01', amount: 50 }, { date: '2026-02-01', amount: 50 }];
    const withNoise = [...inside, { date: '2026-01-01', amount: 999 }, { date: '2026-03-02', amount: 999 }];
    expect(gl.moneyWeightedReturn(s, withNoise)).toBeCloseTo(gl.moneyWeightedReturn(s, [{ date: '2026-02-01', amount: 100 }])!, 12);
  });

  it('is null when undefined: one snapshot, a zero window, no opening money, a wiped-out book', () => {
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 100)], [])).toBeNull();
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 100), snap('2026-01-01', 110)], [])).toBeNull();
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 0), snap('2026-02-01', 110)], [])).toBeNull();
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 100), snap('2026-02-01', 0)], [])).toBeNull();
  });

  it('the period form is the same root over the window', () => {
    const s = [snap('2026-01-01', 100), snap('2026-03-01', 130)];
    const flows = [{ date: '2026-02-01', amount: 20 }];
    const annual = gl.moneyWeightedReturn(s, flows)!;
    const period = gl.periodMoneyWeightedReturn(s, flows)!;
    expect(period).toBeCloseTo((1 + annual) ** (gl.daysBetween('2026-01-01', '2026-03-01') / gl.YEAR_DAYS) - 1, 9);
  });

  it('the period form survives a short sharp window whose annual rate overflows Seer\'s 1e9 cap', () => {
    const s = [snap('2026-10-01', 100), snap('2026-10-05', 140)];
    expect(gl.moneyWeightedReturn(s, [])).toBeNull();
    expect(gl.periodMoneyWeightedReturn(s, [])).toBeCloseTo(0.4, 9);
  });
});

describe('time-weighted index and shadow growth', () => {
  it('takes the deposit out of the growth (deposit at the start of its session)', () => {
    const curve = [snap('2026-10-02', 606), snap('2026-10-05', 996.6), snap('2026-10-06', 896.94)];
    const idx = gl.twrIndex(curve, [{ date: '2026-10-05', amount: 300 }]);
    expect(idx[0]).toBe(1);
    expect(idx[1]).toBeCloseTo(1.1, 12);
    expect(idx[2]).toBeCloseTo(0.99, 12);
    expect(gl.drawdownOf(idx)).toBeCloseTo(0.1, 12);
    expect(gl.drawdownOf([])).toBeNull();
  });

  it("grows the twin's own money at the original's time-weighted rate", () => {
    const original = [snap('2026-10-02', 606), snap('2026-10-05', 996.6), snap('2026-10-06', 896.94)];
    const twin = [snap('2026-10-02', 600), snap('2026-10-05', 1080), snap('2026-10-06', 1080)];
    const flows = [{ date: '2026-10-05', amount: 300 }];
    expect(gl.shadowEnd(original, flows, twin, flows)).toBeCloseTo(891, 9);
    expect(gl.shadowEnd(original.slice(0, 2), flows, twin, flows)).toBeNull();
  });
});
```

**File:** `tests/unit/adversary/golive.parity.test.ts` (new)
**Code:**
```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as gl from '../../../src/adversary/golive.js';
import { connectorSettings, resolveRepoDir } from '../../../src/connectors/env.js';

/**
 * The go-live numbers are Seer's: when Seer moves one, this fails instead of the wall judging at a
 * bar Seer abandoned (Seer once shipped CHECKS = 6 against a five-rule list; web/lib/metrics.ts
 * CHECKLIST_RULES explains it). Reads the Seer checkout at SEER_DIR (default ~/seer); skips without one.
 */
const seer = resolveRepoDir('seer', connectorSettings({ envFile: false }));
const goliveFile = path.join(seer, 'web', 'lib', 'golive.ts');
const metricsFile = path.join(seer, 'web', 'lib', 'metrics.ts');
const present = existsSync(goliveFile) && existsSync(metricsFile);
const metrics = present ? readFileSync(metricsFile, 'utf8') : '';

describe.skipIf(!present)(`go-live parity with Seer web (${seer})`, () => {
  it('MAX_DRAWDOWN and MIN_PAPER_MONTHS', () => {
    const golive = readFileSync(goliveFile, 'utf8');
    expect(golive).toContain(`export const MAX_DRAWDOWN = ${gl.MAX_DRAWDOWN};`);
    expect(golive).toContain(`export const MIN_PAPER_MONTHS = ${gl.MIN_PAPER_MONTHS};`);
  });

  it('the profit-factor bar, the rule count and rule 5 wording', () => {
    expect(metrics).toContain(`'Profit factor ≥ ${gl.MIN_PROFIT_FACTOR}'`);
    expect(metrics).toContain(`(m.profitFactor ?? 0) >= ${gl.MIN_PROFIT_FACTOR}`);
    expect(metrics).toContain(`export const CHECKLIST_RULES = ${gl.CHECKLIST_RULES};`);
    expect(metrics).toContain("label: 'Backtest gate passed'");
    expect(metrics).toContain("val: 'Not applicable'");
  });

  it.runIf(metrics.includes('gate.twin'))("a twin's rule 5 reads Can't be run (phase 3)", () => {
    expect(metrics).toContain(`val: "Can't be run"`);
  });
});
```

**File:** `tests/unit/adversary/scorecard.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  BRACKET_HORIZON_SESSIONS,
  SAME_BAND,
  horizonReturn,
  outcomeOf,
  recordOf,
  scoreDuel,
  scoreObjections,
  summarize,
  type DuelInputRow,
  type HorizonRow,
} from '../../../src/adversary/scorecard.js';

const h = (over: Partial<HorizonRow> & { symbol: string }): HorizonRow => ({
  session_date: '2026-10-05',
  data_date: '2026-10-02',
  kind: 'bracket',
  rank: 1,
  verdict: null,
  next_session: null,
  entry_date: '2026-10-02',
  entry_close: 100,
  exit_date: '2026-10-09',
  exit_close: 100,
  exit_n: BRACKET_HORIZON_SESSIONS,
  ...over,
});

describe('objection scores', () => {
  it('compares the objected stock with the mean of the kept picks (unsure and agree are kept)', () => {
    const [s] = scoreObjections([
      h({ symbol: 'AAA', rank: 1, verdict: 'object', exit_close: 90 }),
      h({ symbol: 'BBB', rank: 2, verdict: 'agree', exit_close: 104 }),
      h({ symbol: 'CCC', rank: 3, verdict: 'unsure', exit_close: 102 }),
    ]);
    expect(s).toMatchObject({ symbol: 'AAA', stock_return: -0.1, kept: 2, outcome: 'worse', fell: true, from: '2026-10-02', to: '2026-10-09', sessions: 5 });
    expect(s!.kept_return).toBeCloseTo(0.03, 12);
    expect(s!.diff).toBeCloseTo(-0.13, 12);
  });

  it('is pending while a bracket horizon has fewer than 5 bars, or a book has no next decision', () => {
    expect(scoreObjections([h({ symbol: 'A', verdict: 'object', exit_n: 3 }), h({ symbol: 'B', rank: 2 })])[0]!.outcome).toBeNull();
    const book = (over: Partial<HorizonRow> & { symbol: string }): HorizonRow => h({ kind: 'book', exit_n: 2, ...over });
    expect(scoreObjections([book({ symbol: 'X', verdict: 'object' }), book({ symbol: 'Y', rank: 2 })])[0]!.outcome).toBeNull();
    const done = scoreObjections([
      book({ symbol: 'X', verdict: 'object', next_session: '2026-10-15', exit_close: 90 }),
      book({ symbol: 'Y', rank: 2, next_session: '2026-10-15', exit_close: 110 }),
    ])[0]!;
    expect(done.outcome).toBe('worse');
    expect(horizonReturn(book({ symbol: 'Y', next_session: '2026-10-15', exit_close: 110 }), BRACKET_HORIZON_SESSIONS).ret).toBeCloseTo(0.1, 12);
  });

  it('calls a gap within half a point "same"', () => {
    expect(outcomeOf(SAME_BAND - 0.0001)).toBe('same');
    expect(outcomeOf(-SAME_BAND + 0.0001)).toBe('same');
    expect(outcomeOf(SAME_BAND + 0.0001)).toBe('better');
    expect(outcomeOf(null)).toBeNull();
  });

  it('summarizes and builds the record (scored points, pending list)', () => {
    const scores = scoreObjections([
      h({ symbol: 'AAA', verdict: 'object', exit_close: 90 }),
      h({ symbol: 'BBB', rank: 2, verdict: 'object', exit_n: 2 }),
      h({ symbol: 'CCC', rank: 3, exit_close: 103 }),
    ]);
    expect(summarize(scores)).toEqual({ objections: 2, scored: 1, worse: 1, same: 0, better: 0, pending: 1, fell: 1, mean_gap_pts: -13 });
    const rec = recordOf('bracket', scores);
    expect(rec.horizon).toBe('the 5 sessions after the decision');
    expect(rec.points.map((p) => [p.symbol, p.gap_pts])).toEqual([['AAA', -13]]);
    expect(rec.pending).toEqual([{ symbol: 'BBB', session_date: '2026-10-05' }]);
    expect(recordOf('book', []).horizon).toBe('until the next rebalance');
  });
});

describe('Claude against C', () => {
  const d = (over: Partial<DuelInputRow> & { symbol: string; claude: DuelInputRow['claude']; c_verdict: DuelInputRow['c_verdict'] }): DuelInputRow => ({
    session_date: '2026-10-05',
    data_date: '2026-10-02',
    rank: 1,
    entry_date: '2026-10-02',
    entry_close: 100,
    exit_date: '2026-10-09',
    exit_close: 100,
    exit_n: BRACKET_HORIZON_SESSIONS,
    ...over,
  });

  it('credits exactly one side per disagreement, against the names neither blocked', () => {
    const duel = scoreDuel('C-GT', [
      d({ symbol: 'AAA', claude: 'object', c_verdict: 'allow', exit_close: 90 }),
      d({ symbol: 'BBB', rank: 2, claude: 'agree', c_verdict: 'veto', exit_close: 104 }),
      d({ symbol: 'CCC', rank: 3, claude: 'unsure', c_verdict: 'allow', exit_close: 102 }),
    ]);
    expect(duel).toMatchObject({ critic_id: 'C-GT', nights: 1, disagreements: 2, scored: 2, claude_right: 2, critic_right: 0, pending: 0 });
    expect(duel.rows.map((r) => [r.symbol, r.blocked_by, r.right])).toEqual([
      ['AAA', 'claude', 'claude'],
      ['BBB', 'critic', 'claude'],
    ]);
    expect(duel.rows[0]!.baseline).toBeCloseTo(0.02, 12);
  });

  it('falls back to every name of the night when each was blocked by someone, and waits for the horizon', () => {
    // CCC is blocked by both (no disagreement), so no name was blocked by neither: baseline = mean of all three = 0.
    const duel = scoreDuel('C-GT', [
      d({ symbol: 'AAA', claude: 'object', c_verdict: 'allow', exit_close: 90 }),
      d({ symbol: 'BBB', rank: 2, claude: 'agree', c_verdict: 'veto', exit_close: 80 }),
      d({ symbol: 'CCC', rank: 3, claude: 'object', c_verdict: 'veto', exit_close: 130 }),
      d({ symbol: 'DDD', rank: 1, session_date: '2026-10-06', claude: 'object', c_verdict: 'allow', exit_n: 2 }),
    ]);
    expect(duel.rows[0]!.baseline).toBeCloseTo(0, 12);
    expect(duel.rows.map((r) => [r.symbol, r.right])).toEqual([
      ['AAA', 'claude'],
      ['BBB', 'critic'],
      ['DDD', null],
    ]);
    expect(duel).toMatchObject({ nights: 2, disagreements: 3, scored: 2, claude_right: 1, critic_right: 1, pending: 1 });
  });
});
```

**File:** `tests/unit/adversary/read.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  buildDecision,
  buildThreeWayRows,
  causeOf,
  coverageOf,
  latestSession,
  stateOf,
  type DecisionInput,
  type DecisionRow,
} from '../../../src/adversary/read.js';
import { cadenceOf, criticOf, findPairing, pairRoster, type RosterEntry } from '../../../src/adversary/readSql.js';
import type { BookFigures, MethodRow } from '../../../src/adversary/readTypes.js';

const entry = (over: Partial<RosterEntry> & { id: string }): RosterEntry => ({
  name: `${over.id} · Test`,
  sub: '',
  engine: 'book',
  isBenchmark: false,
  status: 'active',
  sort: 0,
  twinOf: null,
  objectName: null,
  rulesId: null,
  paperStart: null,
  paperEnd: null,
  gate: null,
  ...over,
});

const ROSTER: RosterEntry[] = [
  entry({ id: 'SPY-GT', engine: 'benchmark', isBenchmark: true, sort: 1 }),
  entry({ id: 'C-GT', engine: 'bracket', objectName: 'STRATEGY_C', rulesId: 'design-v0-gotrade', sort: 2 }),
  entry({ id: 'A-GT', engine: 'bracket', objectName: 'STRATEGY_A', rulesId: 'design-v0-gotrade', sort: 3 }),
  entry({ id: 'A-GT-CX', engine: 'bracket', twinOf: 'A-GT', sort: 4 }),
  entry({ id: 'RAW', sort: 5 }),
  entry({ id: 'RAW-CX-OLD', twinOf: 'RAW', status: 'retired', paperStart: '2026-09-01', sort: 6 }),
  entry({ id: 'RAW-CX', twinOf: 'RAW', paperStart: '2026-10-01', sort: 7 }),
  entry({ id: 'NEW', sort: 8 }),
  entry({ id: 'OLD', status: 'retired', paperEnd: '2026-09-30', sort: 9 }),
  entry({ id: 'OLDER', status: 'retired', paperEnd: '2026-08-31', sort: 10 }),
  entry({ id: 'GONE', status: 'retired', paperEnd: null, sort: 11 }),
];

describe('roster pairing', () => {
  it('lists originals (never a twin, the benchmark or C): active by sort, then retired that traded, newest first', () => {
    const view = pairRoster(ROSTER);
    expect(view.pairs.map((p) => [p.original.id, p.twin?.id ?? null])).toEqual([
      ['A-GT', 'A-GT-CX'],
      ['RAW', 'RAW-CX'],
      ['NEW', null],
      ['OLD', null],
      ['OLDER', null],
    ]);
    expect(view.spy?.id).toBe('SPY-GT');
  });

  it('finds a method by id in any case, a twin id meaning its original; C and unknown ids are not methods', () => {
    const view = pairRoster(ROSTER);
    expect(findPairing(view, 'a-gt-cx')?.original.id).toBe('A-GT');
    expect(findPairing(view, ' raw ')?.twin?.id).toBe('RAW-CX');
    expect(findPairing(view, 'C-GT')).toBeNull();
    expect(findPairing(view, 'NOPE')).toBeNull();
  });

  it("finds a bracket method's C sibling on the same rule set", () => {
    const view = pairRoster(ROSTER);
    expect(criticOf(view, view.pairs[0]!.original)?.id).toBe('C-GT');
    expect(criticOf(view, view.pairs[1]!.original)).toBeNull();
  });

  it('reads the cadence from the engine and the description', () => {
    expect(cadenceOf('bracket', '')).toBe('daily');
    expect(cadenceOf('book', '20 stocks ... re-picked each quarter')).toBe('quarterly');
    expect(cadenceOf('book', 'Top 20 by rise beyond the market, picked monthly; holds less when jumpy, checked weekly')).toBe('monthly');
    expect(cadenceOf('book', 'rebalanced weekly')).toBe('weekly');
    expect(cadenceOf('book', 'buy and hold')).toBeNull();
  });
});

const dec = (over: Partial<DecisionRow> & { session_date: string }): DecisionRow => ({
  strategy_id: 'A-GT',
  data_date: '2026-10-01',
  kind: 'bracket',
  picks: 3,
  open_utc: '2026-10-05T13:30:00.000Z',
  pending: false,
  paused: false,
  object: 0,
  unsure: 0,
  agree: 0,
  late: 0,
  ...over,
});

describe('coverage', () => {
  it('pending wins until the open; then reviewed, paused, absent', () => {
    expect(stateOf(dec({ session_date: 'x', pending: true, agree: 2 }))).toBe('pending');
    expect(stateOf(dec({ session_date: 'x', agree: 1, paused: true }))).toBe('reviewed');
    expect(stateOf(dec({ session_date: 'x', paused: true }))).toBe('paused');
    expect(stateOf(dec({ session_date: 'x', late: 1 }))).toBe('absent');
  });

  it('counts late only for absent decisions', () => {
    expect(
      coverageOf([
        dec({ session_date: '2026-10-05', object: 1, late: 1 }),
        dec({ session_date: '2026-10-06', late: 1 }),
        dec({ session_date: '2026-10-07', paused: true }),
        dec({ session_date: '2026-10-08' }),
        dec({ session_date: '2099-01-05', pending: true }),
      ]),
    ).toEqual({ decisions: 5, reviewed: 1, absent: 2, late: 1, paused: 1, pending: 1 });
  });

  it('opens on the newest pending or reviewed decision, else the newest', () => {
    expect(latestSession([dec({ session_date: '2026-10-05', agree: 1 }), dec({ session_date: '2026-10-08' })])).toBe('2026-10-05');
    expect(latestSession([dec({ session_date: '2026-10-05', agree: 1 }), dec({ session_date: '2099-01-05', pending: true })])).toBe('2099-01-05');
    expect(latestSession([dec({ session_date: '2026-10-05' }), dec({ session_date: '2026-10-08' })])).toBe('2026-10-08');
    expect(latestSession([])).toBeNull();
  });
});

const v = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1,
  strategy_id: 'RAW',
  session_date: '2026-10-01',
  verdict: 'agree',
  reason: 'fine',
  sources: [{ url: 'https://example.com/a', publisher: 'example.com', fetched_at: '2026-09-30T19:00:00.000Z' }, { title: 'no url' }],
  lens: 'raw@1',
  model: 'claude-opus-5-5',
  prompt_version: 'pv-1',
  host: 'gpd',
  started_at: '2026-09-30T19:50:00.000Z',
  decided_at: '2026-09-30T20:00:00.000Z',
  late: false,
  ...over,
});

const bookDecision = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  strategy_id: 'RAW',
  twin_id: 'RAW-CX',
  session_date: '2026-10-01',
  open_utc: '2026-10-01T13:30:00.000Z',
  pending: false,
  paused: false,
  picks: [
    { rank: 1, symbol: 'XOM', weight: 0.5, kind: 'book', data_date: '2026-09-30' },
    { rank: 2, symbol: 'NVDA', weight: 0.3, kind: 'book', data_date: '2026-09-30' },
    { rank: 3, symbol: 'AMD', weight: 0.2, kind: 'book', data_date: '2026-09-30' },
  ],
  verdicts: [
    v({ id: 8, symbol: 'AMD', verdict: 'agree' }),
    v({ id: 7, symbol: 'NVDA', verdict: 'agree' }),
    v({ id: 6, symbol: 'XOM', verdict: 'object', started_at: '2026-09-30T19:40:00.000Z', decided_at: '2026-09-30T20:05:00.000Z' }),
  ],
  held: ['XOM'],
  twin_targets: null,
  twin_decided: null,
  ...over,
});

describe('decision cards', () => {
  it('a held objected name is a sale; the rest share its weight pro rata until the twin decides', () => {
    const d = buildDecision(bookDecision())!;
    expect(d.coverage).toBe('reviewed');
    expect(d.counts).toEqual({ object: 1, unsure: 0, agree: 2, none: 0, late: 0 });
    expect(d.picks.map((p) => [p.symbol, p.held, p.twin_weight, p.twin_weight_source])).toEqual([
      ['XOM', true, 0, 'expected'],
      ['NVDA', false, 0.6, 'expected'],
      ['AMD', false, 0.4, 'expected'],
    ]);
    expect(d.verdicts[0]).toMatchObject({ symbol: 'XOM', rank: 1, action: 'sell', weight: 0.5, twin_weight: 0 });
    expect(d.verdicts[0]!.sources).toEqual([{ url: 'https://example.com/a', title: null, publisher: 'example.com', published_at: null, fetched_at: '2026-09-30T19:00:00.000Z' }]);
    expect(d.verdicts[1]!.action).toBeNull();
    expect(d).toMatchObject({ first_started_at: '2026-09-30T19:40:00.000Z', last_decided_at: '2026-09-30T20:05:00.000Z', hosts: ['gpd'], all_objected: false });
  });

  it("reads the twin's own weights once it decided", () => {
    const d = buildDecision(bookDecision({ twin_decided: true, twin_targets: [['NVDA', 0.55], ['AMD', 0.45]] }))!;
    expect(d.picks.map((p) => [p.symbol, p.twin_weight, p.twin_weight_source])).toEqual([
      ['XOM', 0, 'twin_book'],
      ['NVDA', 0.55, 'twin_book'],
      ['AMD', 0.45, 'twin_book'],
    ]);
  });

  it('every target objected: no expected weights (D6), flagged', () => {
    const d = buildDecision(bookDecision({ verdicts: ['XOM', 'NVDA', 'AMD'].map((s, k) => v({ id: k + 1, symbol: s, verdict: 'object' })) }))!;
    expect(d.all_objected).toBe(true);
    expect(d.picks.map((p) => p.twin_weight)).toEqual([0, 0, 0]);
    expect(d.verdicts.map((x) => x.action)).toEqual(['sell', 'skip', 'skip']);
  });

  it('a bracket objection is a skip; a late verdict is shown but not counted, and the decision is absent', () => {
    const d = buildDecision({
      strategy_id: 'A-GT',
      twin_id: 'A-GT-CX',
      session_date: '2026-10-06',
      open_utc: '2026-10-06T13:30:00.000Z',
      pending: false,
      paused: false,
      picks: [
        { rank: 1, symbol: 'AAA', weight: null, kind: 'bracket', data_date: '2026-10-05' },
        { rank: 2, symbol: 'DDD', weight: null, kind: 'bracket', data_date: '2026-10-05' },
      ],
      verdicts: [v({ id: 5, strategy_id: 'A-GT', symbol: 'DDD', verdict: 'object', late: true })],
      held: null,
      twin_targets: null,
      twin_decided: true,
    })!;
    expect(d.coverage).toBe('absent');
    expect(d.counts).toEqual({ object: 0, unsure: 0, agree: 0, none: 2, late: 1 });
    expect(d.picks[1]!.verdict).toMatchObject({ id: 5, late: true, action: null, held: null, weight: null, twin_weight: null });
    expect(d.first_started_at).toBeNull();
    expect(buildDecision({ ...bookDecision(), picks: [] })).toBeNull();
  });
});

describe('three-way rows', () => {
  it('shows C and Claude side by side, what each book bought, and the disagreement grid', () => {
    const { rows, grid } = buildThreeWayRows({
      picks: [{ rank: 1, symbol: 'AAA' }, { rank: 2, symbol: 'BBB' }, { rank: 3, symbol: 'CCC' }, { rank: 4, symbol: 'EEE' }],
      verdicts: [
        v({ id: 2, symbol: 'AAA', verdict: 'object' }),
        v({ id: 3, symbol: 'BBB', verdict: 'agree' }),
        v({ id: 4, symbol: 'CCC', verdict: 'unsure' }),
      ],
      c_verdicts: [
        { symbol: 'AAA', rank: 1, verdict: 'allow', reason: 'r', decided_at: 't' },
        { symbol: 'BBB', rank: 2, verdict: 'veto', reason: 'r', decided_at: 't' },
        { symbol: 'CCC', rank: 3, verdict: 'allow', reason: 'r', decided_at: 't' },
        { symbol: 'EEE', rank: 4, verdict: 'failed', reason: 'timeout', decided_at: 't' },
      ],
      a_orders: ['AAA', 'BBB'],
      c_orders: ['AAA', 'CCC'],
      twin_orders: null,
      a_decided: true,
      c_decided: true,
      twin_decided: null,
      has_twin: true,
    });
    expect(rows.map((r) => [r.symbol, r.c?.verdict ?? null, r.claude?.verdict ?? null, r.buys])).toEqual([
      ['AAA', 'allow', 'object', { original: true, critic: true, twin: null }],
      ['BBB', 'veto', 'agree', { original: true, critic: false, twin: null }],
      ['CCC', 'allow', 'unsure', { original: false, critic: true, twin: null }],
      ['EEE', 'failed', null, { original: false, critic: false, twin: null }],
    ]);
    expect(grid).toEqual({ c_veto_claude_object: [], c_veto_claude_keep: ['BBB'], c_allow_claude_object: ['AAA'], c_allow_claude_keep: ['CCC'] });
  });
});

describe('cause', () => {
  const fig = (id: string, ret: number, dd: number): BookFigures => ({
    strategy_id: id, from: 'a', to: 'b', sessions: 2, return: ret, mwr_annual: null, deposits_usd: 0, gain_usd: 0,
    worst_drop: dd, trades: 0, profit_factor: null, fees_usd: null,
  });
  const row = (id: string, o: number, t: number, s: number, beyond: number | null, odd: number, tdd: number): MethodRow =>
    ({
      strategy_id: id,
      returns: { original: o, twin: t, spy: s },
      figures: { original: fig(id, o, odd), twin: fig(`${id}-CX`, t, tdd), spy: fig('SPY', s, 0) },
      beyond_original_usd: beyond,
    }) as MethodRow;

  it('counts twins and originals ahead of SPY, sums the extra profit, averages the drop change in points', () => {
    expect(causeOf([row('A', -0.01, 0.27, 0.09, 189, 0.1, 0), row('R', 0.0099, 0.005, -0.0196, -2.94, 0, 0)])).toEqual({
      twins: 2,
      twins_beat_spy: ['A', 'R'],
      originals_beat_spy: ['R'],
      extra_profit_usd: 186.06,
      drawdown_delta_pts: -5,
    });
    expect(causeOf([])).toEqual({ twins: 0, twins_beat_spy: [], originals_beat_spy: [], extra_profit_usd: null, drawdown_delta_pts: null });
  });
});
```
**Impact:** `npm test` gains four files and two edited ones.

### Step 16: Seeded Seer fixture
**File:** `tests/fixtures/adversary/seer-seed.sql` (new)
**Code:**
```sql
-- Seer Adversarial phase 5 fixture: a small Seer database AFTER migration 027 (contract C1).
-- Loaded by tests/integration/connectors/adversary.int.test.ts and by phase 5's verify-notesd Proof.
-- Every session it names is in the past, so a reviewer pointed at this database finds nothing due.
-- It empties every public table first (the migrations' own roster rows included).
DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO t FROM pg_tables WHERE schemaname = 'public';
  IF t IS NOT NULL THEN EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE'; END IF;
END $$;

INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, params, sort, engine, rules_id, status,
                        paper_start, paper_end, object_name, gate_note, gate_applicable, twin_of) VALUES
  ('SPY-GT', 'SPY', 'S&P 500, buy and hold, real Gotrade fees', 'landmark', true, true, '{}', 1, 'benchmark', NULL, 'active',
   '2026-10-01', NULL, NULL, NULL, false, NULL),
  ('C-GT', 'C · News veto', 'A''s picks, a news model can veto them, daily', 'gavel', false, false,
   '{"backtest_gate": {"passed": false, "applicable": false}}', 2, 'bracket', 'design-v0-gotrade', 'active',
   '2026-10-02', NULL, 'STRATEGY_C', NULL, false, NULL),
  ('A-GT', 'A · Dip buy', 'Buys a sharp dip in a rising stock, out within 5 days', 'sigma', false, false,
   '{"backtest_gate": {"passed": false, "applicable": true}}', 3, 'bracket', 'design-v0-gotrade', 'active',
   '2026-10-02', NULL, 'STRATEGY_A', NULL, true, NULL),
  ('RAW35-FR-GT', 'RAW35 · Momentum', 'The 35 stocks that rose most beyond the market, re-picked each month', 'zap', false, false,
   '{"backtest_gate": {"passed": true, "applicable": true}}', 5, 'book', 'monthly-hold-frac-gotrade', 'active',
   '2026-10-01', NULL, 'RESIDMOM35', NULL, true, NULL),
  ('MOM70-FR-GT', 'MOM70 · Momentum beside SPY', '70% in the 30 strongest names, 30% in SPY, monthly', 'trending-up', false, false,
   '{}', 7, 'book', 'monthly-hold-frac-gotrade', 'retired', '2026-09-30', '2026-09-30', 'MOMBLEND70', NULL, true, NULL);

INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, params, sort, engine, rules_id, status,
                        paper_start, paper_end, object_name, gate_note, gate_applicable, twin_of) VALUES
  ('A-GT-CX', 'A+Claude · Dip buy', 'Buys a sharp dip in a rising stock, out within 5 days', 'sigma', false, false, '{}', 4,
   'bracket', 'design-v0-gotrade', 'active', '2026-10-05', NULL, 'STRATEGY_A',
   'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'A-GT'),
  ('RAW35-FR-GT-CX', 'RAW35+Claude · Momentum', 'The 35 stocks that rose most beyond the market, re-picked each month', 'zap',
   false, false, '{}', 6, 'book', 'monthly-hold-frac-gotrade', 'active', '2026-10-02', NULL, 'RESIDMOM35',
   'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'RAW35-FR-GT');

INSERT INTO equity_snapshots (strategy_id, date, cash_usd, equity_usd) VALUES
  ('SPY-GT', '2026-09-30', 0, 606), ('SPY-GT', '2026-10-01', 0, 612), ('SPY-GT', '2026-10-02', 0, 600),
  ('SPY-GT', '2026-10-05', 0, 945), ('SPY-GT', '2026-10-06', 0, 963.9), ('SPY-GT', '2026-10-07', 0, 960),
  ('C-GT', '2026-10-01', 0, 600), ('C-GT', '2026-10-02', 0, 590), ('C-GT', '2026-10-05', 0, 890),
  ('C-GT', '2026-10-06', 0, 880), ('C-GT', '2026-10-07', 0, 870),
  ('A-GT', '2026-10-01', 0, 600), ('A-GT', '2026-10-02', 0, 606), ('A-GT', '2026-10-05', 0, 996.6),
  ('A-GT', '2026-10-06', 0, 896.94), ('A-GT', '2026-10-07', 0, 900),
  ('A-GT-CX', '2026-10-02', 0, 600), ('A-GT-CX', '2026-10-05', 0, 1080), ('A-GT-CX', '2026-10-06', 0, 1080),
  ('RAW35-FR-GT', '2026-09-30', 0, 600), ('RAW35-FR-GT', '2026-10-01', 0, 606), ('RAW35-FR-GT', '2026-10-02', 0, 612),
  ('RAW35-FR-GT', '2026-10-05', 0, 918),
  ('RAW35-FR-GT-CX', '2026-10-01', 0, 600), ('RAW35-FR-GT-CX', '2026-10-02', 0, 603);

-- One owner deposit on 2026-10-05 for every book; the twin of RAW35 has not been credited yet (applied_at NULL).
INSERT INTO paper_contributions (strategy_id, due_date, session_date, amount_idr, usd_idr, amount_usd, applied_at) VALUES
  ('SPY-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('C-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('A-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('A-GT-CX', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-07T06:30:00Z'),
  ('RAW35-FR-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('RAW35-FR-GT-CX', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, NULL);

INSERT INTO paper_state (strategy_id, last_session, cash_usd, equity_usd, initial_cash_usd, usd_idr, pending_session, pending_decision) VALUES
  ('SPY-GT', '2026-10-07', 0, 960, 600, 16666.6667, '2026-10-08', false),
  ('C-GT', '2026-10-07', 870, 870, 600, 16666.6667, '2026-10-08', false),
  ('A-GT', '2026-10-07', 900, 900, 600, 16666.6667, '2026-10-08', false),
  ('A-GT-CX', '2026-10-06', 1080, 1080, 600, 16666.6667, '2026-10-07', false),
  ('RAW35-FR-GT', '2026-10-05', 0, 918, 600, 16666.6667, '2026-10-06', false),
  ('RAW35-FR-GT-CX', '2026-10-02', 0, 603, 600, 16666.6667, '2026-10-05', false);

INSERT INTO orders (strategy_id, session_date, slot, symbol, company, last_price, limit_price, tp_price, sl_price, shares,
                    status, fill_date, fill_price, days_held, exit_date, exit_price, exit_reason, pnl_usd) VALUES
  ('A-GT', '2026-10-02', 1, 'ZZZ', 'Zed Corp', 10, 10, 13, 9, 10, 'closed', '2026-10-02', 10, 2, '2026-10-05', 13, 'tp', 30),
  ('A-GT', '2026-10-05', 1, 'AAA', 'Triple A', 100, 99, 104, 95, 1, 'closed', '2026-10-05', 99, 1, '2026-10-06', 89, 'sl', -10),
  ('A-GT', '2026-10-05', 2, 'BBB', 'Bee Inc', 100, 99, 104, 95, 1, 'open', '2026-10-05', 99, 1, NULL, NULL, NULL, NULL),
  ('C-GT', '2026-10-05', 1, 'AAA', 'Triple A', 100, 99, 104, 95, 1, 'pending', NULL, NULL, 0, NULL, NULL, NULL, NULL),
  ('C-GT', '2026-10-05', 2, 'CCC', 'Sea Co', 100, 99, 104, 95, 1, 'pending', NULL, NULL, 0, NULL, NULL, NULL, NULL),
  ('A-GT-CX', '2026-10-05', 1, 'BBB', 'Bee Inc', 100, 99, 119, 95, 1, 'closed', '2026-10-05', 99, 1, '2026-10-05', 119, 'tp', 20),
  ('A-GT-CX', '2026-10-05', 2, 'CCC', 'Sea Co', 100, 99, 104, 95, 1, 'open', '2026-10-05', 99, 1, NULL, NULL, NULL, NULL);

INSERT INTO book_targets (strategy_id, session_date, rank, symbol, weight, last_price) VALUES
  ('RAW35-FR-GT', '2026-09-29', 1, 'XOM', 1.0, 50),
  ('RAW35-FR-GT', '2026-10-01', 1, 'XOM', 0.5, 50),
  ('RAW35-FR-GT', '2026-10-01', 2, 'NVDA', 0.3, 100),
  ('RAW35-FR-GT', '2026-10-01', 3, 'AMD', 0.2, 100),
  ('RAW35-FR-GT-CX', '2026-10-01', 1, 'NVDA', 0.6, 100),
  ('RAW35-FR-GT-CX', '2026-10-01', 2, 'AMD', 0.4, 100);

INSERT INTO book_fills (strategy_id, session_date, seq, symbol, side, shares, price, cash_usd, cost_usd, reason) VALUES
  ('RAW35-FR-GT', '2026-10-01', 1, 'XOM', 'buy', 6, 50, -300, 0.5, 'entry'),
  ('RAW35-FR-GT', '2026-10-01', 2, 'NVDA', 'buy', 1.8, 100, -180, 0.3, 'entry'),
  ('RAW35-FR-GT', '2026-10-01', 3, 'AMD', 'buy', 1.2, 100, -120, 0.2, 'entry'),
  ('RAW35-FR-GT', '2026-10-02', 1, 'XOM', 'sell', 0.2, 51, 10.2, 0.1, 'trim'),
  ('RAW35-FR-GT-CX', '2026-10-02', 1, 'NVDA', 'buy', 3.6, 100, -360, 0.25, 'entry'),
  ('RAW35-FR-GT-CX', '2026-10-02', 2, 'AMD', 'buy', 2.4, 100, -240, 0.15, 'entry');

INSERT INTO bars (symbol, date, open, high, low, close, volume)
SELECT symbol, date::date, close, close, close, close, 1000 FROM (VALUES
  ('AAA', '2026-10-02', 100), ('AAA', '2026-10-05', 98), ('AAA', '2026-10-06', 96), ('AAA', '2026-10-07', 94),
  ('AAA', '2026-10-08', 92), ('AAA', '2026-10-09', 90), ('AAA', '2026-10-12', 200),
  ('BBB', '2026-10-02', 100), ('BBB', '2026-10-05', 101), ('BBB', '2026-10-06', 102), ('BBB', '2026-10-07', 103),
  ('BBB', '2026-10-08', 103.5), ('BBB', '2026-10-09', 104),
  ('CCC', '2026-10-02', 100), ('CCC', '2026-10-05', 100.5), ('CCC', '2026-10-06', 101), ('CCC', '2026-10-07', 101.5),
  ('CCC', '2026-10-08', 101.8), ('CCC', '2026-10-09', 102),
  ('XOM', '2026-09-30', 50), ('XOM', '2026-10-01', 51), ('XOM', '2026-10-14', 45), ('XOM', '2026-10-15', 99),
  ('NVDA', '2026-09-30', 100), ('NVDA', '2026-10-01', 101), ('NVDA', '2026-10-14', 110),
  ('AMD', '2026-09-30', 100), ('AMD', '2026-10-01', 100), ('AMD', '2026-10-14', 100)
) AS b(symbol, date, close);

INSERT INTO news_vetoes (strategy_id, session_date, rank, symbol, verdict, reason, model, prompt_version, headlines, earnings_date, decided_at) VALUES
  ('C-GT', '2026-10-05', 1, 'AAA', 'allow', 'No company-specific event in the window.', 'glm-5.3', 'c-veto-v1', '[]', NULL, '2026-10-05T06:30:00Z'),
  ('C-GT', '2026-10-05', 2, 'BBB', 'veto', 'Earnings released inside the last 3 days.', 'glm-5.3', 'c-veto-v1', '[]', NULL, '2026-10-05T06:30:00Z'),
  ('C-GT', '2026-10-05', 3, 'CCC', 'allow', 'Routine headlines only.', 'glm-5.3', 'c-veto-v1', '[]', NULL, '2026-10-05T06:30:00Z');

INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence) VALUES
  ('A-GT', '2026-10-05', '2026-10-02', 'bracket', 1, 'AAA', NULL, NULL),
  ('A-GT', '2026-10-05', '2026-10-02', 'bracket', 2, 'BBB', NULL, NULL),
  ('A-GT', '2026-10-05', '2026-10-02', 'bracket', 3, 'CCC', NULL, NULL),
  ('A-GT', '2026-10-06', '2026-10-05', 'bracket', 1, 'AAA', NULL, NULL),
  ('A-GT', '2026-10-06', '2026-10-05', 'bracket', 2, 'DDD', NULL, NULL),
  ('A-GT', '2026-10-07', '2026-10-06', 'bracket', 1, 'EEE', NULL, NULL),
  ('A-GT', '2026-10-08', '2026-10-07', 'bracket', 1, 'FFF', NULL, NULL),
  ('RAW35-FR-GT', '2026-10-01', '2026-09-30', 'book', 1, 'XOM', 0.5, NULL),
  ('RAW35-FR-GT', '2026-10-01', '2026-09-30', 'book', 2, 'NVDA', 0.3, NULL),
  ('RAW35-FR-GT', '2026-10-01', '2026-09-30', 'book', 3, 'AMD', 0.2, NULL),
  ('RAW35-FR-GT', '2026-10-15', '2026-10-14', 'book', 1, 'NVDA', 0.5, NULL),
  ('RAW35-FR-GT', '2026-10-15', '2026-10-14', 'book', 2, 'AMD', 0.5, NULL);

-- Session opens (EDT): 2026-10-01/05/06 open at 13:30Z. Verdict 5 is late (13:45Z on 10-06).
INSERT INTO adversary_verdicts (id, strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version,
                                host, started_at, decided_at) VALUES
  (1, 'A-GT', '2026-10-05', 'AAA', 'agree', 'A first look found nothing behind the dip.',
   '[{"url": "https://example.com/aaa-first", "title": "AAA note", "publisher": "example.com", "published_at": "2026-10-04T12:00:00Z", "fetched_at": "2026-10-05T11:55:00Z"}]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T11:50:00Z', '2026-10-05T12:00:00Z'),
  (2, 'A-GT', '2026-10-05', 'AAA', 'object', 'It fell on a lower forecast. That is a re-pricing, not a dip.',
   '[{"url": "https://www.sec.gov/aaa-8k", "title": "8-K", "publisher": "sec.gov", "published_at": "2026-10-04T21:00:00Z", "fetched_at": "2026-10-05T12:55:00Z"}, {"url": "https://www.benzinga.com/aaa", "title": "AAA cuts outlook", "publisher": "benzinga.com", "published_at": "2026-10-04T22:00:00Z", "fetched_at": "2026-10-05T12:56:00Z"}]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T12:50:00Z', '2026-10-05T13:00:00Z'),
  (3, 'A-GT', '2026-10-05', 'BBB', 'agree', 'The dip matches its whole group, the noise this rule buys.',
   '[{"url": "https://example.com/bbb", "title": "Sector recap", "publisher": "example.com", "published_at": null, "fetched_at": "2026-10-05T13:00:00Z"}]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T12:55:00Z', '2026-10-05T13:05:00Z'),
  (4, 'A-GT', '2026-10-05', 'CCC', 'unsure', 'I could not find why it dipped, so the pick stands.', '[]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T13:00:00Z', '2026-10-05T13:10:00Z'),
  (5, 'A-GT', '2026-10-06', 'DDD', 'object', 'Results are due tomorrow, inside the holding window.',
   '[{"url": "https://example.com/ddd", "title": "Earnings date", "publisher": "example.com", "published_at": null, "fetched_at": "2026-10-06T13:30:00Z"}]',
   'a-dip@2', 'claude-opus-5-5', 'pv-a2', 'gpd', '2026-10-06T13:20:00Z', '2026-10-06T13:45:00Z'),
  (6, 'RAW35-FR-GT', '2026-10-01', 'XOM', 'object', 'Its rise is the oil price''s rise, and that push looks spent for the month.',
   '[{"url": "https://www.eia.gov/petroleum", "title": "Weekly petroleum status", "publisher": "eia.gov", "published_at": "2026-09-30T14:00:00Z", "fetched_at": "2026-09-30T19:55:00Z"}]',
   'raw35@1', 'claude-opus-5-5', 'pv-raw1', 'gpd', '2026-09-30T19:50:00Z', '2026-09-30T20:00:00Z'),
  (7, 'RAW35-FR-GT', '2026-10-01', 'NVDA', 'agree', 'The rise rests on orders that run for quarters.',
   '[{"url": "https://example.com/nvda", "title": "Orders", "publisher": "example.com", "published_at": null, "fetched_at": "2026-09-30T20:00:00Z"}]',
   'raw35@1', 'claude-opus-5-5', 'pv-raw1', 'gpd', '2026-09-30T19:55:00Z', '2026-09-30T20:05:00Z'),
  (8, 'RAW35-FR-GT', '2026-10-01', 'AMD', 'agree', 'Nothing one-off behind the move.',
   '[{"url": "https://example.com/amd", "title": "AMD", "publisher": "example.com", "published_at": null, "fetched_at": "2026-09-30T20:05:00Z"}]',
   'raw35@1', 'claude-opus-5-5', 'pv-raw1', 'gpd', '2026-09-30T20:00:00Z', '2026-09-30T20:10:00Z');
UPDATE adversary_verdicts SET superseded_by = 2 WHERE id = 1;
SELECT setval(pg_get_serial_sequence('adversary_verdicts', 'id'), (SELECT max(id) FROM adversary_verdicts));

INSERT INTO adversary_marks (strategy_id, session_date, mark, host) VALUES ('A-GT', '2026-10-07', 'paused', 'lenovo');
```
**Impact:** test data only. It relies on C1's column names and on phase 1's trigger allowing the
`superseded_by` update and `TRUNCATE` (listed under Requires).

### Step 17: Integration tests
**File:** `tests/integration/helpers/adversaryFake.ts` (new)
**Code:**
```ts
import { AdversaryEvents, type AdversaryChange } from '../../../src/adversary/events.js';
import type { AdversaryService, AdversaryStatus, ReviewNowOptions, RunSummary } from '../../../src/adversary/service.js';
import type { ToggleState } from '../../../src/adversary/toggle.js';

/**
 * A stand-in for phase 4's AdversaryService with the real event bus: the API and SSE tests drive
 * the routes, never the reviewer. Records what the routes asked of it.
 */
export interface FakeAdversary {
  service: AdversaryService;
  events: AdversaryEvents;
  toggles: { on: boolean; host: string }[];
  reviews: (ReviewNowOptions | undefined)[];
  emit(change: Omit<AdversaryChange, 'type'>): void;
}

export function fakeAdversary(): FakeAdversary {
  const events = new AdversaryEvents();
  const toggles: { on: boolean; host: string }[] = [];
  const reviews: (ReviewNowOptions | undefined)[] = [];
  let toggle: ToggleState = { on: true, changed_at: null, host: null };
  const summary: RunSummary = {
    trigger: 'manual', host: 'test-host', started_at: '2026-11-05T02:00:00.000Z', finished_at: '2026-11-05T02:00:01.000Z',
    reviewed: 0, reused: 0, drafted: 0, failed: 0, late: 0, skipped_budget: 0, marks: 0, leases_lost: 0, error: null,
  };
  const status = (): AdversaryStatus => ({
    host: 'test-host', auto: toggle, running: null, schema: 'ready', daily_cap: 15, used_today: 0,
    next_poll_at: null, last_run: null, models: { gather: 'sonnet', verdict: 'opus' },
  });
  const service = {
    events,
    host: 'test-host',
    async getToggle(): Promise<ToggleState> {
      return toggle;
    },
    async setToggle(on: boolean, host: string): Promise<ToggleState> {
      toggle = { on, changed_at: '2026-11-05T02:00:00.000Z', host };
      toggles.push({ on, host });
      events.emit({ op: 'toggle' });
      return toggle;
    },
    async status(): Promise<AdversaryStatus> {
      return status();
    },
    async reviewNow(options?: ReviewNowOptions): Promise<RunSummary> {
      reviews.push(options);
      return summary;
    },
  };
  return {
    service: service as unknown as AdversaryService,
    events,
    toggles,
    reviews,
    emit: (change) => events.emit(change),
  };
}
```

**File:** `tests/integration/connectors/adversary.int.test.ts` (new)
**Code:**
```ts
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AdversaryReader } from '../../../src/adversary/read.js';
import { isoOf, openAt } from '../../../src/adversary/readSql.js';
import type {
  AdversaryDecision,
  MethodPayload,
  OverviewPayload,
  ScorecardPayload,
  ThreeWay,
  VerdictList,
} from '../../../src/adversary/readTypes.js';
import { sessionOpenUtc } from '../../../src/adversary/sessions.js';
import { toObjects } from '../../../src/connectors/seer/rows.js';
import type { Connector } from '../../../src/connectors/types.js';
import { adversaryApiRoutes } from '../../../src/http/adversaryApi.js';
import { registerAdversaryTools } from '../../../src/mcp/adversaryTools.js';
import { fakeAdversary, type FakeAdversary } from '../helpers/adversaryFake.js';
import { cleanupHarness, connectorFor, describeWithRepo, seedSystem, truncateSystem } from './harness.js';

const SEED = readFileSync(new URL('../../fixtures/adversary/seer-seed.sql', import.meta.url), 'utf8');
const SAME_ORIGIN = { origin: 'http://localhost' };

describeWithRepo('seer', 'Seer Adversarial read model, API and MCP on a seeded Seer schema', () => {
  let seer: Connector;
  let reader: AdversaryReader;
  let fake: FakeAdversary;
  let app: Hono;

  beforeAll(async () => {
    await truncateSystem('seer');
    await seedSystem('seer', SEED);
    seer = connectorFor('seer');
    reader = new AdversaryReader(seer);
    fake = fakeAdversary();
    app = new Hono();
    app.route('/', adversaryApiRoutes({ adversary: fake.service }, { seer }));
  });

  afterAll(() => cleanupHarness());

  const getJson = async <T>(path: string, status = 200): Promise<T> => {
    const res = await app.request(path);
    expect(res.status, path).toBe(status);
    return (await res.json()) as T;
  };

  it("computes the session open in SQL exactly like phase 4's sessionOpenUtc (C3 pinned examples)", async () => {
    const res = await seer.query(`SELECT ${isoOf(openAt("'2026-11-04'"))} AS winter, ${isoOf(openAt("'2026-07-01'"))} AS summer`);
    const row = toObjects(res)[0]!;
    expect(row).toEqual({ winter: '2026-11-04T14:30:00.000Z', summer: '2026-07-01T13:30:00.000Z' });
    expect(sessionOpenUtc('2026-11-04').toISOString()).toBe(row.winter);
    expect(sessionOpenUtc('2026-07-01').toISOString()).toBe(row.summer);
  });

  it('overview: roster, methods with returns, coverage, checklists, cause, latest, last review', async () => {
    const o = await getJson<OverviewPayload>('/api/adversary/overview');
    expect(o.roster.map((m) => [m.strategy_id, m.twin_id, m.cadence, m.status])).toEqual([
      ['A-GT', 'A-GT-CX', 'daily', 'active'],
      ['RAW35-FR-GT', 'RAW35-FR-GT-CX', 'monthly', 'active'],
      ['MOM70-FR-GT', null, 'monthly', 'retired'],
    ]);
    expect(o.methods.map((m) => m.strategy_id)).toEqual(['A-GT', 'RAW35-FR-GT']);
    const [a, raw] = o.methods;
    expect(a!.window).toEqual({ from: '2026-10-02', to: '2026-10-06', sessions: 3 });
    expect(a!.coverage).toEqual({ decisions: 4, reviewed: 1, absent: 2, late: 1, paused: 1, pending: 0 });
    expect(a!.objections).toEqual({ objected: 1, reviewed: 3, fell_after: 1, scored: 1, pending: 0 });
    expect(a!.returns.twin!).toBeGreaterThan(a!.returns.spy!);
    expect(a!.returns.spy!).toBeGreaterThan(0);
    expect(a!.returns.original!).toBeLessThan(0);
    expect(a!.figures.twin).toMatchObject({ deposits_usd: 300, gain_usd: 180, worst_drop: 0, trades: 1, profit_factor: 'infinite', fees_usd: null });
    expect(a!.figures.original).toMatchObject({ deposits_usd: 300, gain_usd: -9.06, trades: 2, profit_factor: 3, fees_usd: null });
    expect(a!.figures.original!.worst_drop).toBeCloseTo(0.1, 6);
    expect(a!.beyond_original_usd).toBe(189);
    expect(a!.checklist.original.map((i) => i.seer.val)).toEqual(['0.1 mo', '+50.0 vs +56.9', '3.00', '10.0%', 'Not passed']);
    expect(a!.checklist.original.map((i) => i.state)).toEqual(['fail', 'fail', 'pass', 'pass', 'fail']);
    expect(a!.checklist.twin.map((i) => i.state)).toEqual(['fail', 'pass', 'pass', 'pass', 'na']);
    expect(a!.checklist.twin[4]).toMatchObject({ value: "can't be run", seer: { label: 'Backtest gate', val: "Can't be run", ok: false } });
    expect(raw!.coverage).toEqual({ decisions: 2, reviewed: 1, absent: 1, late: 0, paused: 0, pending: 0 });
    expect(raw!.figures.original).toMatchObject({ deposits_usd: 0, gain_usd: 6, fees_usd: 0.1 });
    expect(raw!.figures.twin).toMatchObject({ deposits_usd: 0, gain_usd: 3, fees_usd: 0.4 });
    expect(raw!.beyond_original_usd).toBe(-2.94);
    expect(raw!.checklist.original[4]!.seer.val).toBe('Passed');
    expect(o.cause).toEqual({
      twins: 2,
      twins_beat_spy: ['A-GT', 'RAW35-FR-GT'],
      originals_beat_spy: ['RAW35-FR-GT'],
      extra_profit_usd: 186.06,
      drawdown_delta_pts: -5,
    });
    expect(o.latest.map((v) => [v.id, v.symbol, v.verdict, v.late, v.host])).toEqual([
      [4, 'CCC', 'unsure', false, 'lenovo'],
      [2, 'AAA', 'object', false, 'lenovo'],
      [6, 'XOM', 'object', false, 'gpd'],
    ]);
    expect(o.latest[1]!.sources.map((s) => s.publisher)).toEqual(['sec.gov', 'benzinga.com']);
    expect(o.last_review).toEqual({ strategy_id: 'A-GT', session_date: '2026-10-06', picks: 1, finished_at: '2026-10-06T13:45:00.000Z' });
    expect(o).toMatchObject({ started_on: '2026-10-01', months_on_paper: 0.13, spy_id: 'SPY-GT' });
    expect(o.reviewer).toMatchObject({ host: 'test-host', daily_cap: 15 });
  });

  it('method: curves with deposits taken out, record, revisions, decisions, three-way; a twin id opens its original', async () => {
    const m = await getJson<MethodPayload>('/api/adversary/methods/a-gt-cx');
    expect(m.method.strategy_id).toBe('A-GT');
    expect(m.curves).toEqual({ dates: ['2026-10-02', '2026-10-05', '2026-10-06'], original: [100, 110, 99], twin: [100, 120, 120], spy: [100, 105, 107.1] });
    expect(m.record.points.map((p) => [p.symbol, p.session_date, p.outcome, p.gap_pts])).toEqual([['AAA', '2026-10-05', 'worse', -13]]);
    expect(m.revisions.map((r) => [r.prompt_version, r.verdicts, r.until === null])).toEqual([
      ['pv-a2', 1, true],
      ['pv-a1', 4, false],
    ]);
    expect(m.decisions.map((d) => [d.session_date, d.coverage])).toEqual([
      ['2026-10-08', 'absent'],
      ['2026-10-07', 'paused'],
      ['2026-10-06', 'absent'],
      ['2026-10-05', 'reviewed'],
    ]);
    expect(m.decision?.session_date).toBe('2026-10-05');
    expect(m.three_way?.critic.strategy_id).toBe('C-GT');
    expect(m.three_way?.session_date).toBe('2026-10-05');
    expect(m.lens_question).toBeNull();
  });

  it('decision cards: the counted verdict wins over a superseded one; review header; late verdicts leave it absent', async () => {
    const d = await getJson<AdversaryDecision>('/api/adversary/methods/A-GT/decisions/2026-10-05');
    expect(d).toMatchObject({
      coverage: 'reviewed',
      data_date: '2026-10-02',
      open_utc: '2026-10-05T13:30:00.000Z',
      counts: { object: 1, unsure: 1, agree: 1, none: 0, late: 0 },
      first_started_at: '2026-10-05T12:50:00.000Z',
      last_decided_at: '2026-10-05T13:10:00.000Z',
      models: ['claude-opus-5-5'],
      prompt_versions: ['pv-a1'],
      hosts: ['lenovo'],
    });
    expect(d.verdicts.map((v) => [v.symbol, v.id, v.verdict, v.action])).toEqual([
      ['AAA', 2, 'object', 'skip'],
      ['BBB', 3, 'agree', null],
      ['CCC', 4, 'unsure', null],
    ]);
    const late = await getJson<AdversaryDecision>('/api/adversary/methods/A-GT/decisions/2026-10-06');
    expect(late).toMatchObject({ coverage: 'absent', counts: { object: 0, unsure: 0, agree: 0, none: 2, late: 1 } });
    expect(late.picks[1]!.verdict).toMatchObject({ id: 5, late: true, action: null });
  });

  it("book decision: held · sell, new names keep their pro-rata share, twin weights from the twin's own book", async () => {
    const d = await getJson<AdversaryDecision>('/api/adversary/methods/RAW35-FR-GT/decisions/2026-10-01');
    expect(d.picks.map((p) => [p.symbol, p.held, p.twin_weight, p.twin_weight_source, p.verdict?.action ?? null])).toEqual([
      ['XOM', true, 0, 'twin_book', 'sell'],
      ['NVDA', false, 0.6, 'twin_book', null],
      ['AMD', false, 0.4, 'twin_book', null],
    ]);
  });

  it('three-way: A, C and Claude side by side, what each book bought, grid and who was right', async () => {
    const t = await getJson<ThreeWay>('/api/adversary/daily/A-GT');
    expect(t.sessions).toEqual(['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05']);
    expect(t.session_date).toBe('2026-10-05');
    expect(t.rows.map((r) => [r.symbol, r.c?.verdict, r.claude?.verdict, r.buys])).toEqual([
      ['AAA', 'allow', 'object', { original: true, critic: true, twin: false }],
      ['BBB', 'veto', 'agree', { original: true, critic: false, twin: true }],
      ['CCC', 'allow', 'unsure', { original: false, critic: true, twin: true }],
    ]);
    expect(t.grid).toEqual({ c_veto_claude_object: [], c_veto_claude_keep: ['BBB'], c_allow_claude_object: ['AAA'], c_allow_claude_keep: ['CCC'] });
    expect(t.settled).toEqual({ claude_right: 2, critic_right: 0, disagreements: 2, scored: 2, pending: 0, nights: 1 });
    expect(t.books.original).toMatchObject({ strategy_id: 'A-GT', trades: 2, profit_factor: 3 });
    expect(t.books.twin).toMatchObject({ strategy_id: 'A-GT-CX', trades: 1 });
    expect((await getJson<ThreeWay>('/api/adversary/daily/A-GT?session=2026-10-08')).rows.map((r) => r.symbol)).toEqual(['FFF']);
  });

  it('scorecard: the horizon record for a book and the duel for a daily method', async () => {
    const raw = await getJson<ScorecardPayload>('/api/adversary/scorecard/RAW35-FR-GT');
    expect(raw.duel).toBeNull();
    expect(raw.record.horizon).toBe('until the next rebalance');
    expect(raw.record.points).toEqual([
      expect.objectContaining({ symbol: 'XOM', outcome: 'worse', gap_pts: -15, kept: 2, horizon_from: '2026-09-30', horizon_to: '2026-10-14', fell: true }),
    ]);
    const a = await getJson<ScorecardPayload>('/api/adversary/scorecard/A-GT');
    expect(a.record.points[0]).toMatchObject({ symbol: 'AAA', horizon_to: '2026-10-09', sessions: 5 });
    expect(a.duel).toMatchObject({ critic_id: 'C-GT', disagreements: 2, claude_right: 2, critic_right: 0 });
  });

  it('verdict list: latest decision per method by default; a session and a verdict filter', async () => {
    const objections: VerdictList = await reader.verdicts({ verdict: 'object' });
    expect(objections.verdicts.map((v) => [v.strategy_id, v.session_date, v.symbol, v.late])).toEqual([
      ['A-GT', '2026-10-06', 'DDD', true],
      ['RAW35-FR-GT', '2026-10-01', 'XOM', false],
    ]);
    expect(objections.sessions).toEqual([
      { strategy_id: 'A-GT', session_date: '2026-10-06', coverage: 'absent' },
      { strategy_id: 'RAW35-FR-GT', session_date: '2026-10-01', coverage: 'reviewed' },
    ]);
    const day = await reader.verdicts({ strategy: 'a-gt', session: '2026-10-05' });
    expect(day.verdicts.map((v) => [v.symbol, v.id])).toEqual([['AAA', 2], ['BBB', 3], ['CCC', 4]]);
  });

  it('errors: unknown, malformed, not a daily method, Seer unreachable', async () => {
    expect(await getJson('/api/adversary/methods/NOPE', 404)).toMatchObject({ error: 'not_found' });
    expect(await getJson('/api/adversary/methods/C-GT', 404)).toMatchObject({ error: 'not_found' });
    expect(await getJson('/api/adversary/methods/A-GT/decisions/2026-13-01', 400)).toMatchObject({ error: 'invalid_session' });
    expect(await getJson('/api/adversary/methods/A-GT/decisions/2026-10-09', 404)).toMatchObject({ error: 'not_found' });
    expect(await getJson('/api/adversary/methods/bad%20id', 400)).toMatchObject({ error: 'invalid_id' });
    expect(await getJson('/api/adversary/daily/RAW35-FR-GT', 400)).toMatchObject({ error: 'not_bracket' });
    const down = new Hono();
    down.route('/', adversaryApiRoutes({ adversary: null }, { seer: connectorFor('seer', { repoDir: null }) }));
    const res = await down.request('/api/adversary/overview');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'seer_unavailable', detail: 'not_reachable' });
    const off = await down.request('/api/adversary/toggle');
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: 'reviewer_off' });
  });

  it('toggle and review-now: same-origin only, reach the reviewer, review-now answers 202 before the pass ends', async () => {
    expect(await getJson('/api/adversary/toggle')).toEqual({ on: true, changed_at: null, host: null });
    const json = { 'content-type': 'application/json' };
    expect((await app.request('/api/adversary/toggle', { method: 'PUT', headers: json, body: '{"on":false}' })).status).toBe(403);
    const put = await app.request('/api/adversary/toggle', { method: 'PUT', headers: { ...json, ...SAME_ORIGIN }, body: '{"on":false}' });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ on: false, host: 'test-host' });
    expect(fake.toggles).toEqual([{ on: false, host: 'test-host' }]);
    expect((await app.request('/api/adversary/toggle', { method: 'PUT', headers: { ...json, ...SAME_ORIGIN }, body: '{"on":"no"}' })).status).toBe(400);

    expect((await app.request('/api/adversary/review-now', { method: 'POST', headers: json, body: '{}' })).status).toBe(403);
    const now = await app.request('/api/adversary/review-now', { method: 'POST', headers: { ...json, ...SAME_ORIGIN }, body: '{"strategy_id":"a-gt-cx"}' });
    expect(now.status).toBe(202);
    expect(await now.json()).toEqual({ started: true, reason: null });
    expect(fake.reviews).toEqual([{ strategyId: 'A-GT' }]);
    const all = await app.request('/api/adversary/review-now', { method: 'POST', headers: SAME_ORIGIN });
    expect(all.status).toBe(202);
    expect(fake.reviews[1]).toEqual({});
    const unknown = await app.request('/api/adversary/review-now', { method: 'POST', headers: { ...json, ...SAME_ORIGIN }, body: '{"strategy_id":"NOPE"}' });
    expect(unknown.status).toBe(404);
    const bad = await app.request('/api/adversary/review-now', { method: 'POST', headers: { ...json, ...SAME_ORIGIN }, body: '{"strategy_id":5}' });
    expect(bad.status).toBe(400);
  });

  it('MCP: three read-only tools answer from the same read model', async () => {
    const server = new McpServer({ name: 'adversary-test', version: '0.0.0' });
    registerAdversaryTools(server, { connectors: { seer } as never, adversary: fake.service });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'adversary-test-client', version: '0.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(['adversary_overview', 'adversary_scorecard', 'adversary_verdicts']);
      for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
      const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
      const overview = JSON.parse(text((await client.callTool({ name: 'adversary_overview', arguments: {} })) as CallToolResult)) as OverviewPayload;
      expect(overview.methods.map((x) => x.strategy_id)).toEqual(['A-GT', 'RAW35-FR-GT']);
      const objections = JSON.parse(
        text((await client.callTool({ name: 'adversary_verdicts', arguments: { verdict: 'object' } })) as CallToolResult),
      ) as VerdictList;
      expect(objections.verdicts.map((v) => v.symbol)).toEqual(['DDD', 'XOM']);
      const card = JSON.parse(
        text((await client.callTool({ name: 'adversary_scorecard', arguments: { strategy: 'RAW35-FR-GT' } })) as CallToolResult),
      ) as ScorecardPayload;
      expect(card.record.points[0]).toMatchObject({ symbol: 'XOM', outcome: 'worse' });
      const missing = (await client.callTool({ name: 'adversary_scorecard', arguments: { strategy: 'NOPE' } })) as CallToolResult;
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/not_found/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a decision whose session has not opened is pending and becomes the page default (runs last: adds a row)', async () => {
    await seedSystem(
      'seer',
      `INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence)
       VALUES ('A-GT', '2099-01-05', '2099-01-02', 'bracket', 1, 'FUT', NULL, NULL)`,
    );
    const o = await reader.overview(null);
    expect(o.methods[0]!.coverage).toEqual({ decisions: 5, reviewed: 1, absent: 2, late: 1, paused: 1, pending: 1 });
    const m = await reader.method('A-GT');
    expect(m.decision).toMatchObject({ session_date: '2099-01-05', coverage: 'pending' });
  });
});
```

**File:** `tests/integration/adversary.sse.int.test.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiRoutes } from '../../src/http/api.js';
import { fakeAdversary } from './helpers/adversaryFake.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness({ sseHeartbeatMs: 50 });
});

afterAll(async () => {
  await h.close();
});

describe('GET /api/events relays the Seer Adversarial reviewer', () => {
  it('writes event: adversary for each change and unsubscribes on abort', async () => {
    const fake = fakeAdversary();
    const app = new Hono();
    app.route('/', apiRoutes({ ...h.deps, adversary: fake.service }, { sseHeartbeatMs: 50 }));
    const res = await app.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    expect(fake.events.listenerCount()).toBe(1);

    fake.emit({ op: 'verdict', strategy_id: 'A-GT', session_date: '2026-10-05' });
    const verdict = await readUntil(reader, (t) => t.includes('event: adversary'));
    expect(parseSse(verdict)).toContainEqual({ event: 'adversary', data: { op: 'verdict', strategy_id: 'A-GT', session_date: '2026-10-05' } });

    fake.emit({ op: 'run' });
    const run = await readUntil(reader, (t) => t.includes('"run"'));
    expect(parseSse(run)).toContainEqual({ event: 'adversary', data: { op: 'run', strategy_id: null, session_date: null } });

    await reader.cancel();
    await waitFor(() => fake.events.listenerCount() === 0);
  });

  it('still streams note events when the reviewer is off (adversary: null)', async () => {
    const app = new Hono();
    app.route('/', apiRoutes({ ...h.deps, adversary: null }, { sseHeartbeatMs: 50 }));
    const res = await app.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    const note = await h.notes.create({ body: 'still live #sse', origin: null });
    const text = await readUntil(reader, (t) => t.includes(note.id));
    expect(parseSse(text)).toContainEqual({ event: 'note', data: { op: 'created', id: note.id } });
    await reader.cancel();
  });
});
```
**Impact:** `npm run test:int` gains two files (one in the connectors harness, which rebuilds Seer's
schema from `SEER_DIR`'s migrations).

## Principles applied

- Laziness protocol: no new database client and no new metric code where Seer already has a port; the read model goes through the existing read-only connector (`createSeerConnector`), reuses `ranking.ts` `sinceStartMetrics` for Seer's `strategyMetrics`, `leaderboard.ts` `CURVES_SQL` / `parseCurve`, `rows.ts` helpers and `countsFor`; coverage uses one `coverageState` function for every surface; `controlView`-style wrappers around phase 4's service were dropped in favour of passing its `AdversaryStatus` through.
- Boundary discipline: ids, sessions and bodies are validated once, in `adversaryApi.ts` (zod `idParam`, `toggleBody`, `reviewNowBody`) and the MCP input schemas; Seer rows are parsed once in `readSql.ts` (`toRosterEntry`, `toAdversaryVerdict`, `parseSources`) and trusted by `read.ts` and `scorecard.ts`.
- Make illegal states unrepresentable: a checklist rule that cannot apply is `state: 'na'` rather than `ok: false` plus a flag; `profit_factor` is `number | 'infinite' | null` (no `Infinity` in JSON); `action` is set only on a counted objection; a record point carries non-null numbers only, pending objections live in a separate list.
- Build the lever: one fixture (`tests/fixtures/adversary/seer-seed.sql`) feeds both the integration test and the verify-notesd Proof, so the Proof is rerunnable without hand seeding; the expected numbers are derived once in the plan and asserted in both.
- Encode lessons in structure: Seer once shipped a checklist constant out of step with its rules (`CHECKS = 6` against five rules, `metrics.ts` `CHECKLIST_RULES` doc); `golive.parity.test.ts` reads Seer's `golive.ts` / `metrics.ts` and fails when a mirrored threshold, label or rule count drifts, instead of a comment asking to keep them equal.
- Test behavior, not implementation: integration tests drive the real routes, MCP tools and SQL on a schema built from Seer's own migrations; the only fake is phase 4's service behind the toggle and review-now routes, with its real event bus.
- Prove it works: Proof runs the real daemon against a seeded throwaway Seer database through verify-notesd's `api`, `mcp` and `sql`.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/seer-adversarial && npm run typecheck`
**Tests:**
- `npm test` (unit: `tests/unit/adversary/*.test.ts`, `chat-status`, `mcp.instructions`)
- `SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial npm run test:int` (invariant 8: the Seer
  worktree carries migration 027 until phase 7 lands it). The connectors globalSetup must print
  `seer: connectors_seer built from 27 migrations`; `adversary.int.test.ts` must not be skipped.

**Proof:**
- Harness: `.claude/skills/verify-notesd` (`verify.sh up`, `api`, `mcp`, `sql`, `note`, `down`).
- Feature-map entries: `features/adversary.md` (API / MCP / SSE section added here); neighbor `features/notes.md`.
- Setup (phase 4's `up --adversary` builds a throwaway Seer database `s_<run>` in the verify container
  from `SEER_DIR`'s migrations and points the daemon's `SEER_DIR` at `$RUN_DIR/seer`; nothing real is
  touched). Run from the worktree:
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
  V=.claude/skills/verify-notesd/scripts/verify.sh
  SEER_DIR=/home/miftah/.worktrees/seer/seer-adversarial $V up --adversary   # prints RUN=..., URL=...
  RUN=<the printed id>
  RUN_DIR="$HOME/.local/state/notesd-verify/$RUN"
  PORT="$(cat "$RUN_DIR/port")"
  $V exec "$RUN" --seer "$(cat tests/fixtures/adversary/seer-seed.sql)"   # replaces the migrations' rows with the fixture
  $V doctor "$RUN"
  ```
  Passes when `exec` prints no `ERROR` and `doctor` is all `ok`. Every seeded session is in the past,
  so the reviewer (polling every 5 s in `--adversary` runs) finds nothing due and spends no tokens
  (journey 8 checks this). If `verify.sh` has no `--adversary` / `exec` yet, phase 4 has not landed:
  stop (Step 0).
- Journeys (`tail -n +3` strips the two transcript header lines `$V api` prints before a GET body):
  1. **Overview.** `$V api "$RUN" GET /api/adversary/overview | tail -n +3 | jq -c '{r: [.roster[].strategy_id], m: [.methods[] | {id: .strategy_id, cov: .coverage, obj: .objections.objected, rev: .objections.reviewed}], c: .cause, l: [.latest[].id]}'`
     passes when it prints
     `{"r":["A-GT","RAW35-FR-GT","MOM70-FR-GT"],"m":[{"id":"A-GT","cov":{"decisions":4,"reviewed":1,"absent":2,"late":1,"paused":1,"pending":0},"obj":1,"rev":3},{"id":"RAW35-FR-GT","cov":{"decisions":2,"reviewed":1,"absent":1,"late":0,"paused":0,"pending":0},"obj":1,"rev":3}],"c":{"twins":2,"twins_beat_spy":["A-GT","RAW35-FR-GT"],"originals_beat_spy":["RAW35-FR-GT"],"extra_profit_usd":186.06,"drawdown_delta_pts":-5},"l":[4,2,6]}`.
  2. **Rule 5 for a twin, Seer's checklist strings.** `$V api "$RUN" GET /api/adversary/methods/a-gt-cx | tail -n +3 | jq -c '[.method.strategy_id, .checklist.twin[4].state, .checklist.twin[4].seer.val, [.checklist.original[].seer.val], .curves.twin]'`
     passes when it prints `["A-GT","na","Can't be run",["0.1 mo","+50.0 vs +56.9","3.00","10.0%","Not passed"],[100,120,120]]`.
  3. **Book decision: held · sell, twin weights.** `$V api "$RUN" GET /api/adversary/methods/RAW35-FR-GT/decisions/2026-10-01 | tail -n +3 | jq -c '[.picks[] | [.symbol, .held, .twin_weight, .verdict.action]]'`
     passes when it prints `[["XOM",true,0,"sell"],["NVDA",false,0.6,null],["AMD",false,0.4,null]]`.
  4. **Late verdict counts as absent.** `$V api "$RUN" GET /api/adversary/methods/A-GT/decisions/2026-10-06 | tail -n +3 | jq -c '[.coverage, .counts.late, .picks[1].verdict.late]'`
     passes when it prints `["absent",1,true]`.
  5. **Three-way and scorecard.** `$V api "$RUN" GET /api/adversary/daily/A-GT | tail -n +3 | jq -c '[.session_date, [.rows[] | [.symbol, .c.verdict, .claude.verdict]], .settled.claude_right, .settled.critic_right]'`
     passes when it prints `["2026-10-05",[["AAA","allow","object"],["BBB","veto","agree"],["CCC","allow","unsure"]],2,0]`;
     and `$V api "$RUN" GET /api/adversary/scorecard/RAW35-FR-GT | tail -n +3 | jq -c '[.record.points[0].symbol, .record.points[0].outcome, .record.points[0].gap_pts]'`
     prints `["XOM","worse",-15]`.
  6. **MCP tools.** `$V mcp "$RUN" --list` lists `adversary_overview`, `adversary_verdicts`, `adversary_scorecard`;
     `$V mcp "$RUN" adversary_verdicts '{"verdict":"object"}'` prints JSON whose `verdicts` symbols are `DDD` (with `"late":true`) then `XOM`.
  7. **Toggle through the real reviewer, stored in the run's own database, with the SSE event.**
     ```sh
     EV="$(mktemp)"; ( timeout 8 curl -sN "http://127.0.0.1:$PORT/api/events" > "$EV" ) &
     for i in $(seq 50); do grep -q ': connected' "$EV" && break; sleep 0.1; done
     $V api "$RUN" PUT /api/adversary/toggle '{"on":false}'
     $V api "$RUN" GET /api/adversary/toggle
     $V sql "$RUN" "select value->>'on' as on from app_settings where key = 'adversary.auto'"
     wait; grep -A1 'event: adversary' "$EV"
     $V api "$RUN" PUT /api/adversary/toggle '{"on":true}'
     ```
     passes when the PUT answers `HTTP 200` with `"on":false`, the GET answers `"on":false`, the SQL row reads `false`,
     and the stream file holds `event: adversary` followed by `data: {"op":"toggle",...}`.
  8. **Same-origin guard and review-now.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/adversary/review-now"`
     and the same with `-H 'Origin: http://evil.example'` both print `403`; the same for
     `-X PUT … /api/adversary/toggle -d '{"on":false}'` prints `403`. Then
     `$V api "$RUN" POST /api/adversary/review-now '{"strategy_id":"A-GT"}'` answers `HTTP 202` with `"started":true`,
     and after it `$V sql "$RUN" "select count(*) from adversary_reviews"` reads `0` (nothing was due, no tokens spent).
  9. **Seer unreachable is a 503, not a crash.** `mv "$RUN_DIR/seer/.env.local" "$RUN_DIR/seer/.env.off"; $V api "$RUN" GET /api/adversary/overview | head -3; mv "$RUN_DIR/seer/.env.off" "$RUN_DIR/seer/.env.local"`
     passes when it shows `HTTP 503` and a body with `"error":"seer_unavailable","detail":"not_reachable"`
     (the connector re-reads `.env.local` on every query, so no restart is needed either way).
- Neighbor check: notes and the existing Seer connector still work on the same instance.
  `$V api "$RUN" POST /api/notes '{"body":"neighbor #check"}'` answers 201, `$V api "$RUN" GET /api/tags` lists `check`,
  and `$V mcp "$RUN" seer_leaderboard '{}'` returns JSON whose `not_ranked` includes `SPY-GT`.
- Cleanup: `$V down "$RUN"; rm -f "$EV"` (phase 4's `down` also drops the run's Seer database).
- Cost: none. No journey calls a model (seeded sessions are past; review-now finds nothing due).

**Exit criteria:** typecheck, `npm test` and `SEER_DIR=<seer worktree> npm run test:int` are green with
`adversary.int.test.ts` not skipped; journeys 1-9 print exactly the stated end states on a verify-notesd
instance; `features/adversary.md` carries the API / MCP / SSE section; the README HTTP and MCP tables list
the new routes and tools.

## Handoffs

- **Reconciler / phase 6 (`web/src/adversaryApi.ts`)**: phase 5's shapes are a superset of phase 6's
  assumed ones, with these differences to align on the web side:
  - `CoverageState` adds `'pending'` (a decision whose session has not opened); `Coverage` adds
    `decisions`, `late`, `pending`.
  - `profit_factor` is `number | 'infinite' | null` (phase 6 typed `number | null`); `'infinite'` = no losing trade.
  - `ThreeWayRow.buys.*` are `boolean | null` (`null` = that book has not decided the session yet; the
    twin always decides a night late); `ThreeWay.books.twin` may be `null`; `ThreeWay` also carries
    `original`, `twin_id`, `sessions`, `open_utc`, `coverage`, `grid`, `duel`.
  - `MethodPayload.curves` is `Curves | null` and `stats.*` are `BookFigures | null` (no twin snapshot yet);
    `MethodPayload` also carries `row` and `decisions`; `AdversaryDecision` also carries `strategy_id`,
    `twin_id`, `data_date`, `kind`, `open_utc`, `lenses`, `hosts`, `counts`, `all_objected`, `picks`.
  - `Objections` adds `scored` and `pending`; `fell_after` = objections that did worse than the kept picks.
  - `AdversarySource.fetched_at` is `string | null`.
  - `Revision` adds `lens`, `verdicts`; `note` is always `null` and `lens_question` is always `null`
    (neither is stored anywhere; giving them content needs phase 4 to persist a lens summary and a
    change note per `prompt_version`, a follow-up).
  - `OverviewPayload` adds `months_on_paper`, `spy_id`, `reviewer` (phase 4 `AdversaryStatus`).
  - `ReviewNowResult` matches; review-now is 202.
- **Phase 4**: phase 5 relies on `setToggle` emitting op `toggle` and on `reviewNow` being safe to start
  without awaiting (serialised). It passes `reviewer.host` as `setToggle`'s `host`. The Proof relies on
  phase 4's `verify.sh up --adversary` (Seer DB `s_<run>`, daemon `SEER_DIR=$RUN_DIR/seer`) and
  `verify.sh exec RUN --seer SQL`.
- **Phase 4 / phase 6 (`features/adversary.md`)**: phase 4 creates the file, phase 5 appends the API /
  MCP / SSE section, phase 6 should append the wall section rather than recreate the file.
- **Phase 7**: `POST /api/adversary/review-now` takes `{strategy_id?}` and answers 202 `{started, reason}`;
  `GET /api/adversary/toggle` answers 503 `reviewer_off` when `NOTESD_ADVERSARY=off`.
- **Seer follow-up (outside this plan set, owner decision)**: Seer's leaderboard go-live checklist is
  not deposit-aware: `web/lib/metrics.ts` `strategyMetrics` takes no cashflows, so "Beats SPY" compares
  raw equity growth (deposits included) and the drawdown is on raw equity, while the engine's
  `backtest/metrics.py` already measures funded runs on the time-weighted index and reports
  `money_weighted_return`. The brief's statement that the checklist "already is" money-weighted is
  wrong. This phase mirrors Seer as it is; changing the bar is a Seer change.
- **Connectors (follow-up)**: `SEER_ABOUT.db` in `src/connectors/seer/index.ts` does not describe
  `strategy_candidates`, `adversary_verdicts`, `adversary_marks`, `adversary_leases` or `twin_of`, so
  `seer_sql` users discover them only through `seer_schema`. Not R5; left as a follow-up card.

## Rollback

Revert this phase's commit. It adds no migration and writes nothing to either database; removing it
takes away the `/api/adversary/*` routes, the `event: adversary` relay, the three MCP tools and their
chat allow-list entries, and the README/feature-map text. Phase 4's reviewer keeps running unaffected
(it never depended on these routes).
