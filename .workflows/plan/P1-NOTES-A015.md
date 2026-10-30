> Adopted from `/home/miftah/.worktrees/mcp-notes/connectors-p4/docs/plans/CONNECTORS_PLAN.md` phase 4. Source: `.workflows/plan/connectors/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Seer curated tools (db + lab)

**Plan set:** `CONNECTORS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-124712-C5N7_code_analyzer.md`
**Satisfies:** R2 (Seer's curated tools: `seer_leaderboard`, `seer_positions`, `seer_sera_best`; app units, USD as stored), R5 (unit tests for the ranking port and the tool layer; Docker integration test on seeded Postgres + temp lab.sqlite)
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/connectors/seer`

---

## Goal

After this phase the `notes` MCP server answers three Seer questions from live data, read-only: the paper-trading leaderboard ranked exactly as the Seer app ranks it (common window, ≥63 shared sessions, greedy drop, annualised Sharpe, the app's tie-breaks), the open positions per strategy with marks and unrealised P&L, and the best Sera variant per method from `lab.sqlite` by the lab's own rule (MAR desc, trial n asc over dev trials). The phase-1 no-op stub `src/connectors/seer/curated.ts` becomes the real registrar. The ranking port is pure, unit-tested, and lives in its own file.

## Interface Contract

**Deletes:** the phase-1 no-op body of `registerSeerCurated` (`src/connectors/seer/curated.ts`). The file is replaced whole; its export name and signature stay.
**Renames:** none
**Creates:**
- `src/connectors/seer/rows.ts`: `Row`, `toObjects` (re-exported from phase 1's `src/connectors/rows.ts`, not re-implemented), `num`, `numOrNull`, `str`, `strOrNull`, `ymdOrNull`, `bool`, `fixed`, `round`, `clip`, `json`
- `src/connectors/seer/ranking.ts`: `MIN_COMMON_SESSIONS`, `MIN_RANKED`, `TRADING_DAYS`, `Snapshot`, `TradeStats`, `NO_TRADES`, `Engine`, `StrategyStatus`, `RankIn`, `CompareWindow`, `Windowed`, `CompareStatus`, `CompareRow`, `Comparison`, `engineOf`, `statusOf`, `countsFor`, `byDate`, `commonDates`, `coversDates`, `windowed`, `selectRanked`, `rankCmp`, `compareStrategies`, `SinceStart`, `sinceStartMetrics`, `spanDays`
- `src/connectors/seer/leaderboard.ts`: `BOARD_STRATEGIES_SQL`, `CURVES_SQL`, `TRADES_SQL`, `RANK_RULE`, `BoardStrategy`, `BoardEntry`, `SeerLeaderboard`, `parseCurve`, `buildLeaderboard`, `seerLeaderboard`
- `src/connectors/seer/positions.ts`: `BRACKET_MAX_DAYS`, `BracketHolding`, `BookHolding`, `PendingBracketOrder`, `PendingBookTarget`, `StrategyPositions`, `SeerPositions`, `PositionsOptions`, `seerPositions`
- `src/connectors/seer/sera.ts`: `METHOD_STATUSES`, `MethodStatus`, `MIN_PROFIT_FACTOR`, `MIN_TRADES`, `HYPOTHESIS_MAX`, `SERA_DEFAULT_LIMIT`, `SERA_MAX_LIMIT`, `BEST_SQL`, `testTrialsSql`, `SeraHurdles`, `seraHurdles`, `SeraTrial`, `SeraBestTrial`, `SeraMethodBest`, `SeraBest`, `SeraOptions`, `seerSeraBest`
- MCP tools `seer_leaderboard`, `seer_positions`, `seer_sera_best` (names exactly as `CONNECTOR_TOOL_NAMES.seer[2..4]`)
- Tests: `tests/unit/connectors/seer.ranking.test.ts`, `tests/unit/connectors/seer.sera.test.ts`, `tests/unit/connectors/seer.curated.test.ts`, `tests/integration/connectors/seer.curated.int.test.ts`

**Signature changes:** none. `registerSeerCurated(server: McpServer, connector: Connector): void` stays as phase 1 declares it.

**Requires (from earlier phases), all from Phase 1:**
- `src/connectors/types.ts` exports `QueryResult { columns; rows; row_count; truncated }`, `QueryOptions { maxRows? }`, `ReadOnlySource { query(sql, params?, options?) }`, `Connector extends ReadOnlySource { id; label; lab? }`, `class ConnectorError extends Error` with a `(message: string)` constructor. Exactly as the plan index contract shows.
- `src/connectors/names.ts` exports `CONNECTOR_TOOL_NAMES` with `seer: ['seer_schema', 'seer_sql', 'seer_leaderboard', 'seer_positions', 'seer_sera_best']`.
- `src/connectors/seer/curated.ts` exists as a stub exporting `registerSeerCurated(server, connector)`, and `src/connectors/register.ts` calls it once per `/mcp` server with the seer `Connector`. This phase replaces only that file's contents.
- The Postgres runner (`connector.query`) runs a parameterised SQL with `$1…` placeholders inside `BEGIN READ ONLY` with `TimeZone=Asia/Jakarta`, wrapped as `SELECT * FROM (<sql>) AS q LIMIT <cap+1>`. Phase 1's parsers (exact): `date`/`time`/`timestamptz` as their Postgres text, `numeric` as number, `int8` as number when safe (else string), `json`/`jsonb` as parsed values (pg's default, not overridden; `rows.json()` also accepts text), booleans as `true`/`false`. A `json_agg` of `numeric` values arrives as JSON numbers.
- `src/connectors/rows.ts` exports `toObjects(result: QueryResult): Record<string, unknown>[]` (Phase 1).
- The lab runner (`connector.lab.query`) runs a parameterised SQL with positional `?` placeholders against `lab.sqlite` opened `readOnly` in a short-lived child process, under the same timeout and row cap, and returns `QueryResult`. It accepts `null`, number and string params, returns integers as numbers (strings above 2^53), and always wraps the SQL as `SELECT * FROM (<sql>) AS q LIMIT <cap+1>`: every lab SQL here is a single SELECT with no trailing `;`, valid as a subquery.
- `src/mcp/tools.ts` exports `run(fn, options?: { compact?: boolean })`; every handler here passes `{ compact: true }`. A thrown `ConnectorError` renders as its bare message, any other `Error` as `error: <message>`; the tests here only use `toContain`.
- `tests/integration/connectors/harness.ts` exports (Phase 1, exact): `describeWithRepo(id, name, fn)` (sync), `seedSystem(id, sql, params?): Promise<void>` (writable admin query; without params several statements may be sent at once), `truncateSystem(id): Promise<void>`, `connectorFor(id, { labPath?: string, … }): Connector` (sync; the seer connector's `lab` reads `labPath`), `makeLab(rows?: LabRows): TempLab` (sync; `TempLab = { path: string; dir: string }`; creates `meta`, `methods`, `trials`, `trial_funding`, `insights` with the real column names and defaults on NOT NULL columns) and `cleanupHarness(): void`.

**Leaves alone (owned by others):** `src/connectors/{names,types,register,env,pg,guard,lab,errors,schema,sql}.ts` and `src/connectors/seer/index.ts` (Phase 1), `src/mcp/**` (Phase 1), `tests/integration/connectors/{harness,globalSetup}.ts` and phase 1's `*.int.test.ts` (Phase 1), `tests/unit/connectors/**` outside `seer.*` (Phase 1), `scripts/**`, `vitest.config.ts`, `package.json`, README, `docs/INSTALL.md` (Phase 1), `src/connectors/expenses/**` (Phase 2), `src/connectors/runs/**` (Phase 3), `src/chat/**` and `claude/**` (Phase 5), `web/**` (Phase 6). Nothing under `~/seer` is written or imported. Its files were read only to mirror semantics.

## Assumptions

1. **Harness lab and connector shape (phase 1, exact).** `makeLab()` returns `{ path, dir }` for a temp lab.sqlite that already has phase 1's `methods`, `trials` and `trial_funding` tables (real column names, defaults on NOT NULL columns). The test writes its own rows into `lab.path` with explicit column lists, then builds `connectorFor('seer', { labPath: lab.path })`, a real seer connector over `systemDbUrl('seer')` whose `lab` reads that file.
2. **truncateSystem('seer')** truncates every public table `RESTART IDENTITY CASCADE`, which also removes the roster rows the seer migrations insert (`003`, `006`, `013`, `017`, `021`–`023`). The seed runs after it and inserts every row the tests read, so no other file's leftovers matter.
3. **One owner.** No `user_id` scoping. Seer has no user column.
4. **Row cap.** `CONNECTOR_MAX_ROWS = 1000`. The live board has thousands of equity snapshots and closed trades, so the leaderboard aggregates per strategy in SQL: one `json_agg` curve row per strategy, and one trade-stats row per (source, strategy). Every result stays far under the cap. Positions and lab queries pass `{ maxRows: 1000 }` and report `truncated`.

## Files

| File | Action | What changes |
|---|---|---|
| `src/connectors/seer/curated.ts` | replace (phase-1 stub, line 1) | registers `seer_leaderboard`, `seer_positions`, `seer_sera_best` with descriptions written for Claude |
| `src/connectors/seer/rows.ts` | create | value coercion/rounding helpers; re-exports phase 1's `toObjects` |
| `src/connectors/seer/ranking.ts` | create | pure TS port of `view.ts` `compare()`/`selectRanked`/`windowed`/`rankCmp` and `metrics.ts` `strategyMetrics` |
| `src/connectors/seer/leaderboard.ts` | create | roster/curve/trade SQL plus `buildLeaderboard` shaping |
| `src/connectors/seer/positions.ts` | create | open bracket orders, book positions, optional pending orders/targets, latest fx |
| `src/connectors/seer/sera.ts` | create | lab.sqlite best-variant-per-method query, test-window trials, recomputed hurdles |
| `tests/unit/connectors/seer.ranking.test.ts` | create | ranking port and `buildLeaderboard` unit tests |
| `tests/unit/connectors/seer.sera.test.ts` | create | `seraHurdles` / `testTrialsSql` unit tests |
| `tests/unit/connectors/seer.curated.test.ts` | create | tool registration, descriptions, fail-soft errors over a stub connector (in-memory MCP) |
| `tests/integration/connectors/seer.curated.int.test.ts` | create | three tools end to end on seeded Docker Postgres + temp lab.sqlite |

## Implementation Steps

### Step 1: Row helpers
**File:** `src/connectors/seer/rows.ts:1` (new)
**Change:** Value coercion and rounding helpers local to the seer directory, plus a re-export of phase 1's `toObjects` so every seer module imports row helpers from one place.
**Code:**
```ts
/** One result row keyed by column name. */
export type Row = Record<string, unknown>;

/** Phase 1's compact { columns, rows } -> one object per row, re-exported so seer modules import one place. */
export { toObjects } from '../rows.js';

/** A number from a driver value (number, bigint or numeric string). null/undefined read as 0, like Seer's `n()`. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/** A number, or null when the value is null/undefined/not numeric. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** A date column as YYYY-MM-DD. The connector returns dates as text; a Date is tolerated. */
export function ymdOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Postgres booleans arrive as true/false; SQLite stores them as 0/1. */
export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 1n || v === 't' || v === 'true';
}

/** Rounds a finite number to `dp` decimals. */
export function fixed(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Rounds to `dp` decimals; null and non-finite values become null (JSON has no Infinity). */
export function round(v: number | null, dp: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return fixed(v, dp);
}

/** Shortens long free text for a tool result, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A json/jsonb column, whether the driver already parsed it or left it as text. */
export function json(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v ?? null;
}
```
**Impact:** none outside the seer directory.

### Step 2: The ranking port (pure)
**File:** `src/connectors/seer/ranking.ts:1` (new)
**Change:** A faithful port of `~/seer/web/app/(app)/leaderboard/view.ts` (`commonDates` :163, `windowed` :181, `rankCmp` :214, `selectRanked` :238, `compare` :281) and `~/seer/web/lib/metrics.ts` `strategyMetrics` :18, plus `engineOf` (`web/lib/strategy.ts:21`), `parseStatus` (`web/lib/data.ts:32`) and `countsFor` (`web/lib/data.ts:509`). One deliberate difference: `strategyMetrics` takes a list of P&Ls, and here it takes per-strategy aggregates (`TradeStats`), because the connector's row cap rules out fetching every closed trade. Win rate and profit factor come out identical: wins are `pnl > 0`, losses are `pnl <= 0`, and a NULL pnl counts as a zero loss in both. `CompareRow` keeps the windowed figures in one nested `windowed` object instead of flat fields, and `Comparison` also returns the window's `dates` so the benchmark can be measured over the same window.
**Code:**
```ts
/**
 * Seer's leaderboard ranking, ported to TypeScript from the Seer web app (read, never imported):
 *   ~/seer/web/app/(app)/leaderboard/view.ts   compare(), selectRanked(), windowed(), rankCmp()
 *   ~/seer/web/lib/metrics.ts                  strategyMetrics()
 * which are themselves a port of ~/seer/engine/src/seer_engine/paper/compare.py. Keep the
 * constants and rules equal to those files; if Seer changes them, change these. Pure: no I/O.
 */

/** compare.py's MIN_COMMON_SESSIONS: one quarter of a 252-session year. */
export const MIN_COMMON_SESSIONS = 63;
/** compare.py's MIN_RANKED: a ranking of one is not a comparison. */
export const MIN_RANKED = 2;
export const TRADING_DAYS = 252;
const DAY_MS = 86_400_000;

export interface Snapshot {
  date: string;
  equity: number;
}

/** A strategy's closed trades, aggregated: count, winners (pnl > 0), gross win, gross loss (positive). */
export interface TradeStats {
  trades: number;
  wins: number;
  grossWin: number;
  grossLoss: number;
}

export const NO_TRADES: TradeStats = { trades: 0, wins: 0, grossWin: 0, grossLoss: 0 };

export type Engine = 'bracket' | 'book' | 'benchmark';
export type StrategyStatus = 'active' | 'retired';

/** What the ranking reads from a roster row. */
export interface RankIn {
  id: string;
  isBenchmark: boolean;
  status: StrategyStatus;
}

export interface CompareWindow {
  from: string;
  to: string;
  sessions: number;
}

export interface Windowed {
  totalReturn: number;
  cagr: number | null;
  maxDrawdown: number;
  sharpe: number | null;
}

/** 'ranked' and 'insufficient' are compare.py's statuses; 'retired' is the app's pre-filter outcome. */
export type CompareStatus = 'ranked' | 'insufficient' | 'retired';

export interface CompareRow<T extends RankIn> {
  strategy: T;
  status: CompareStatus;
  /** The strategy's own snapshots, ascending. */
  curve: Snapshot[];
  /** Figures over the common window; non-null only when status is 'ranked'. */
  windowed: Windowed | null;
}

export interface Comparison<T extends RankIn> {
  /** Null exactly when nothing is ranked. */
  window: CompareWindow | null;
  /** The window's dates (empty when nothing is ranked). */
  dates: string[];
  /** Sessions every live research strategy shares right now, ranked or not. */
  shared: number;
  /** Every research strategy (benchmark excluded), in input order. */
  rows: CompareRow<T>[];
  /** The ranked subset, best first. */
  ranked: CompareRow<T>[];
}

const ENGINES: readonly string[] = ['bracket', 'book', 'benchmark'];

/** web/lib/strategy.ts engineOf. */
export function engineOf(engine: unknown, isBenchmark: boolean): Engine {
  if (typeof engine === 'string' && ENGINES.includes(engine)) return engine as Engine;
  return isBenchmark ? 'benchmark' : 'bracket';
}

/** web/lib/data.ts parseStatus. */
export function statusOf(raw: unknown): StrategyStatus {
  return raw === 'retired' ? 'retired' : 'active';
}

/** web/lib/data.ts countsFor: closed orders count for bracket, non-idle book trades for book, none for the benchmark. */
export function countsFor(engine: Engine, src: string): boolean {
  return engine !== 'benchmark' && src === engine;
}

export const byDate = (a: Snapshot, b: Snapshot): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** Every date all curves have: a set intersection (not [max start, min end]), ascending. */
export function commonDates(curves: Snapshot[][]): string[] {
  const [first, ...rest] = curves;
  if (first === undefined) return [];
  const sets = rest.map((c) => new Set(c.map((p) => p.date)));
  return [...new Set(first.map((p) => p.date))].filter((d) => sets.every((s) => s.has(d))).sort();
}

/** True when the curve has a snapshot on every one of `dates`. */
export function coversDates(curve: Snapshot[], dates: string[]): boolean {
  const have = new Set(curve.map((p) => p.date));
  return dates.every((d) => have.has(d));
}

/** The window's figures for one curve, which must have a snapshot on every date in `dates`. */
export function windowed(curve: Snapshot[], dates: string[]): Windowed {
  const on = new Map(curve.map((p) => [p.date, p.equity] as const));
  const eq = dates.map((d) => {
    const v = on.get(d);
    if (v === undefined) throw new Error(`no snapshot on ${d}`);
    return v;
  });
  const start = eq[0] ?? 0;
  const end = eq[eq.length - 1] ?? 0;

  let peak = start;
  let maxDrawdown = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }

  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const years =
    firstDate !== undefined && lastDate !== undefined
      ? (Date.parse(lastDate) - Date.parse(firstDate)) / DAY_MS / 365.25
      : 0;
  const cagr = years > 0 && start > 0 ? Math.pow(end / start, 1 / years) - 1 : null;

  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) {
    const prev = eq[i - 1]!;
    const cur = eq[i]!;
    if (prev !== 0) rets.push(cur / prev - 1);
  }
  let sharpe: number | null = null;
  if (rets.length >= 2) {
    const mean = rets.reduce((a, v) => a + v, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, v) => a + (v - mean) ** 2, 0) / (rets.length - 1));
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(TRADING_DAYS) : null;
  }

  return { totalReturn: start === 0 ? 0 : end / start - 1, cagr, maxDrawdown, sharpe };
}

/**
 * compare.py's _select: drop curves shorter than minSessions on their own; then, while the
 * intersection is short, drop the strategy whose removal leaves the LONGEST intersection
 * (ties: shortest own curve, then id). Stop when long enough, or when fewer than MIN_RANKED remain.
 */
export function selectRanked(
  curves: Map<string, Snapshot[]>,
  minSessions: number = MIN_COMMON_SESSIONS,
): { ids: Set<string>; dates: string[] } {
  const own = (id: string): Snapshot[] => curves.get(id) ?? [];
  let live = [...curves.keys()].filter((id) => own(id).length >= minSessions).sort();
  while (live.length >= MIN_RANKED) {
    const common = commonDates(live.map(own));
    if (common.length >= minSessions) return { ids: new Set(live), dates: common };
    if (live.length === MIN_RANKED) break;
    let worst = live[0]!;
    let worstKey: [number, number, string] | null = null;
    for (const id of live) {
      const rest = live.filter((o) => o !== id);
      const key: [number, number, string] = [-commonDates(rest.map(own)).length, own(id).length, id];
      if (
        worstKey === null ||
        key[0] < worstKey[0] ||
        (key[0] === worstKey[0] && key[1] < worstKey[1]) ||
        (key[0] === worstKey[0] && key[1] === worstKey[1] && key[2] < worstKey[2])
      ) {
        worst = id;
        worstKey = key;
      }
    }
    live = live.filter((id) => id !== worst);
  }
  return { ids: new Set(), dates: [] };
}

/** Best first: finite Sharpe desc (no Sharpe last), then total return desc, then smaller max DD, then id. */
export function rankCmp<T extends RankIn>(a: CompareRow<T>, b: CompareRow<T>): number {
  const as = a.windowed?.sharpe ?? null;
  const bs = b.windowed?.sharpe ?? null;
  const ag = as === null ? 1 : 0;
  const bg = bs === null ? 1 : 0;
  if (ag !== bg) return ag - bg;
  if (as !== null && bs !== null && as !== bs) return bs - as;
  const ar = a.windowed?.totalReturn ?? 0;
  const br = b.windowed?.totalReturn ?? 0;
  if (ar !== br) return br - ar;
  const ad = a.windowed?.maxDrawdown ?? 0;
  const bd = b.windowed?.maxDrawdown ?? 0;
  if (ad !== bd) return ad - bd;
  return a.strategy.id < b.strategy.id ? -1 : a.strategy.id > b.strategy.id ? 1 : 0;
}

/**
 * view.ts compare(): the benchmark is never compared; a retired strategy is never ranked and
 * never shortens the window; the rest are ranked over the window selectRanked picks.
 */
export function compareStrategies<T extends RankIn>(rows: { strategy: T; curve: Snapshot[] }[]): Comparison<T> {
  const research = rows.filter((r) => !r.strategy.isBenchmark);
  const live = research.filter((r) => r.strategy.status === 'active' && r.curve.length >= 2);
  const curves = new Map(live.map((r) => [r.strategy.id, [...r.curve].sort(byDate)] as const));

  const { ids, dates } = selectRanked(curves, MIN_COMMON_SESSIONS);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const window: CompareWindow | null =
    from !== undefined && to !== undefined ? { from, to, sessions: dates.length } : null;
  const shared = commonDates([...curves.values()]).length;

  const out: CompareRow<T>[] = research.map((r) => {
    const curve = [...r.curve].sort(byDate);
    if (r.strategy.status === 'retired') return { strategy: r.strategy, status: 'retired', curve, windowed: null };
    if (!ids.has(r.strategy.id)) return { strategy: r.strategy, status: 'insufficient', curve, windowed: null };
    return { strategy: r.strategy, status: 'ranked', curve, windowed: windowed(curve, dates) };
  });

  const ranked = out.filter((r) => r.status === 'ranked').sort(rankCmp);
  return { window, dates, shared, rows: out, ranked };
}

export interface SinceStart {
  totalReturn: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  /** Infinity when there are trades and no losing trade (metrics.ts does the same). */
  profitFactor: number | null;
  trades: number;
  months: number;
}

/** metrics.ts strategyMetrics over a strategy's whole record, with trades pre-aggregated. */
export function sinceStartMetrics(curve: Snapshot[], t: TradeStats): SinceStart {
  const snaps = [...curve].sort(byDate);
  let peak = -Infinity;
  let maxDd = 0;
  for (const s of snaps) {
    peak = Math.max(peak, s.equity);
    maxDd = Math.max(maxDd, (peak - s.equity) / peak);
  }
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  return {
    totalReturn: first !== undefined && last !== undefined ? last.equity / first.equity - 1 : null,
    winRate: t.trades ? t.wins / t.trades : null,
    profitFactor: t.trades ? (t.grossLoss === 0 ? Infinity : t.grossWin / t.grossLoss) : null,
    maxDrawdown: snaps.length ? maxDd : null,
    trades: t.trades,
    months:
      first !== undefined && last !== undefined
        ? (Date.parse(last.date) - Date.parse(first.date)) / DAY_MS / 30.44
        : 0,
  };
}

/** Calendar days between a curve's first and last snapshot. */
export function spanDays(curve: Snapshot[]): number {
  const c = [...curve].sort(byDate);
  const first = c[0];
  const last = c[c.length - 1];
  return first !== undefined && last !== undefined
    ? Math.round((Date.parse(last.date) - Date.parse(first.date)) / DAY_MS)
    : 0;
}
```
**Impact:** none. Pure module.

### Step 3: Leaderboard SQL and shaping
**File:** `src/connectors/seer/leaderboard.ts:1` (new)
**Change:** Three read-only queries mirror `leaderboard()` / `boardStrategies()` (`~/seer/web/lib/data.ts:122`, `:526`):
- the roster: live strategies, plus retired ones with `paper_end`
- one equity curve per strategy, aggregated as `json_agg` so the row cap is never hit
- closed-trade stats per (source, strategy): bracket = `orders.status='closed'`, book = `book_trades WHERE NOT idle`

`buildLeaderboard` is pure and unit-tested. Returns are fractions rounded to 4 dp, Sharpe to 2 dp, and USD to 2 dp. An infinite profit factor is reported as the string `'infinite'`, because JSON would turn `Infinity` into `null`.
**Code:**
```ts
import type { ReadOnlySource } from '../types.js';
import {
  byDate,
  compareStrategies,
  countsFor,
  coversDates,
  engineOf,
  MIN_COMMON_SESSIONS,
  NO_TRADES,
  sinceStartMetrics,
  spanDays,
  statusOf,
  windowed,
  type CompareWindow,
  type Engine,
  type RankIn,
  type Snapshot,
  type StrategyStatus,
  type TradeStats,
  type Windowed,
} from './ranking.js';
import { bool, fixed, json, num, round, str, strOrNull, toObjects, ymdOrNull, type Row } from './rows.js';

/** boardStrategies(): every live strategy, then every retired one that actually traded (paper_end set). */
export const BOARD_STRATEGIES_SQL = `SELECT id, name, engine, is_benchmark, status, sort,
  paper_start::text AS paper_start, paper_end::text AS paper_end
FROM strategies
WHERE status <> 'retired' OR paper_end IS NOT NULL
ORDER BY (status = 'retired'), sort, id`;

/** One row per strategy: its whole equity curve as [[date, equity_usd], ...], ascending. */
export const CURVES_SQL = `SELECT strategy_id,
  json_agg(json_build_array(date::text, equity_usd) ORDER BY date) AS curve
FROM equity_snapshots
GROUP BY strategy_id`;

/** Closed-trade stats per source and strategy (leaderboard()'s pnls, aggregated). */
export const TRADES_SQL = `SELECT x.src, x.strategy_id,
  count(*)::int AS trades,
  (count(*) FILTER (WHERE x.pnl_usd > 0))::int AS wins,
  COALESCE(sum(x.pnl_usd) FILTER (WHERE x.pnl_usd > 0), 0) AS gross_win,
  COALESCE(-sum(x.pnl_usd) FILTER (WHERE x.pnl_usd <= 0), 0) AS gross_loss
FROM (
  SELECT 'bracket' AS src, strategy_id, pnl_usd FROM orders WHERE status = 'closed'
  UNION ALL
  SELECT 'book' AS src, strategy_id, pnl_usd FROM book_trades WHERE NOT idle
) x
GROUP BY x.src, x.strategy_id`;

export const RANK_RULE =
  `Ranked like the Seer app: only over the dates every ranked strategy has an equity snapshot (the common window); ` +
  `a ranking needs at least ${MIN_COMMON_SESSIONS} shared sessions, and strategies that overlap too little are dropped ` +
  `one at a time so the rest can still be ranked. Order: annualised Sharpe of daily returns over the window ` +
  `(rf = 0, x sqrt(252)) highest first, no Sharpe last; then window total return; then smaller window max drawdown; then id. ` +
  `The benchmark and retired strategies are never ranked.`;

export interface BoardStrategy extends RankIn {
  name: string;
  engine: Engine;
  paperStart: string | null;
  paperEnd: string | null;
  sort: number;
}

export interface BoardEntry {
  /** 1 = best; null when not ranked. */
  rank: number | null;
  id: string;
  name: string;
  engine: Engine;
  status: StrategyStatus;
  paper_start: string | null;
  paper_end: string | null;
  /** Own equity snapshots (sessions stepped, day 0 included). */
  sessions: number;
  /** Calendar days from the first to the last own snapshot. */
  days: number;
  /** Date of the last own snapshot. */
  as_of: string | null;
  current_equity_usd: number | null;
  /** Over the common window: ranked strategies, and the benchmark when it covers the window. */
  window: { total_return: number | null; cagr: number | null; max_drawdown: number | null; sharpe: number | null } | null;
  /** Over the strategy's whole record (metrics.ts strategyMetrics). */
  since_start: {
    total_return: number | null;
    max_drawdown: number | null;
    win_rate: number | null;
    profit_factor: number | 'infinite' | null;
    trades: number;
    months: number | null;
  };
  not_ranked_reason?: string;
}

export interface SeerLeaderboard {
  /** The common window the ranking used; null when nothing could be ranked. */
  window: CompareWindow | null;
  /** Sessions every live research strategy shares now (says how far off a ranking is when window is null). */
  shared_sessions: number;
  min_common_sessions: number;
  rule: string;
  ranked: BoardEntry[];
  /** Benchmark, retired strategies, and live strategies without enough shared sessions. */
  not_ranked: BoardEntry[];
}

/** Parses CURVES_SQL's curve column ([[date, equity], ...], parsed or text). */
export function parseCurve(v: unknown): Snapshot[] {
  const raw = json(v);
  if (!Array.isArray(raw)) return [];
  const out: Snapshot[] = [];
  for (const p of raw) {
    if (Array.isArray(p) && p.length >= 2) out.push({ date: String(p[0]).slice(0, 10), equity: Number(p[1]) });
  }
  return out;
}

function toBoardStrategy(r: Row): BoardStrategy {
  const isBenchmark = bool(r.is_benchmark);
  return {
    id: str(r.id),
    name: str(r.name),
    engine: engineOf(r.engine, isBenchmark),
    isBenchmark,
    status: statusOf(r.status),
    paperStart: ymdOrNull(r.paper_start),
    paperEnd: ymdOrNull(r.paper_end),
    sort: num(r.sort),
  };
}

/** Live first, then retired; each by sort, then id (boardStrategies order). */
function rosterOrder(a: BoardStrategy, b: BoardStrategy): number {
  const ar = a.status === 'retired' ? 1 : 0;
  const br = b.status === 'retired' ? 1 : 0;
  if (ar !== br) return ar - br;
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function windowFigures(w: Windowed | null): BoardEntry['window'] {
  if (w === null) return null;
  return {
    total_return: round(w.totalReturn, 4),
    cagr: round(w.cagr, 4),
    max_drawdown: round(w.maxDrawdown, 4),
    sharpe: round(w.sharpe, 2),
  };
}

/** Pure: ranks and shapes the board from the roster, the curves and the trade stats. */
export function buildLeaderboard(
  strategies: BoardStrategy[],
  curves: Map<string, Snapshot[]>,
  trades: Map<string, TradeStats>,
): SeerLeaderboard {
  const roster = [...strategies].sort(rosterOrder);
  const curveOf = (id: string): Snapshot[] => [...(curves.get(id) ?? [])].sort(byDate);
  const cmp = compareStrategies(roster.map((strategy) => ({ strategy, curve: curveOf(strategy.id) })));
  const rowById = new Map(cmp.rows.map((r) => [r.strategy.id, r] as const));

  const entry = (st: BoardStrategy, rank: number | null, w: Windowed | null, reason?: string): BoardEntry => {
    const curve = curveOf(st.id);
    const since = sinceStartMetrics(curve, trades.get(st.id) ?? NO_TRADES);
    const last = curve[curve.length - 1];
    const e: BoardEntry = {
      rank,
      id: st.id,
      name: st.name,
      engine: st.engine,
      status: st.status,
      paper_start: st.paperStart,
      paper_end: st.paperEnd,
      sessions: curve.length,
      days: spanDays(curve),
      as_of: last?.date ?? null,
      current_equity_usd: last !== undefined ? fixed(last.equity, 2) : null,
      window: windowFigures(w),
      since_start: {
        total_return: round(since.totalReturn, 4),
        max_drawdown: round(since.maxDrawdown, 4),
        win_rate: round(since.winRate, 4),
        profit_factor: since.profitFactor === Infinity ? 'infinite' : round(since.profitFactor, 2),
        trades: since.trades,
        months: round(since.months, 1),
      },
    };
    if (reason !== undefined) e.not_ranked_reason = reason;
    return e;
  };

  const ranked = cmp.ranked.map((r, i) => entry(r.strategy, i + 1, r.windowed));

  const notRanked: BoardEntry[] = [];
  for (const st of roster) {
    if (st.isBenchmark) {
      const curve = curveOf(st.id);
      const w = cmp.dates.length > 0 && coversDates(curve, cmp.dates) ? windowed(curve, cmp.dates) : null;
      notRanked.push(
        entry(st, null, w, 'benchmark: the yardstick, never ranked; its window figures (when present) cover the same common window, for comparison'),
      );
      continue;
    }
    const row = rowById.get(st.id);
    if (row === undefined || row.status === 'ranked') continue;
    if (row.status === 'retired') {
      const when = st.paperEnd !== null ? ` (last traded ${st.paperEnd})` : '';
      notRanked.push(entry(st, null, null, `retired${when}: record shown, never ranked against live strategies`));
    } else {
      notRanked.push(
        entry(
          st,
          null,
          null,
          `insufficient: fewer than ${MIN_COMMON_SESSIONS} sessions shared with the ranked strategies (${row.curve.length} own sessions)`,
        ),
      );
    }
  }

  return {
    window: cmp.window,
    shared_sessions: cmp.shared,
    min_common_sessions: MIN_COMMON_SESSIONS,
    rule: RANK_RULE,
    ranked,
    not_ranked: notRanked,
  };
}

/** seer_leaderboard: three read-only queries, then the pure ranking. */
export async function seerLeaderboard(db: ReadOnlySource): Promise<SeerLeaderboard> {
  const [s, c, t] = await Promise.all([
    db.query(BOARD_STRATEGIES_SQL, [], { maxRows: 1000 }),
    db.query(CURVES_SQL, [], { maxRows: 1000 }),
    db.query(TRADES_SQL, [], { maxRows: 1000 }),
  ]);
  const strategies = toObjects(s).map(toBoardStrategy);

  const curves = new Map<string, Snapshot[]>();
  for (const r of toObjects(c)) {
    const id = strOrNull(r.strategy_id);
    if (id !== null) curves.set(id, parseCurve(r.curve));
  }

  const engineById = new Map(strategies.map((x) => [x.id, x.engine] as const));
  const trades = new Map<string, TradeStats>();
  for (const r of toObjects(t)) {
    const id = str(r.strategy_id);
    const engine = engineById.get(id);
    if (engine === undefined || !countsFor(engine, str(r.src))) continue;
    trades.set(id, {
      trades: num(r.trades),
      wins: num(r.wins),
      grossWin: num(r.gross_win),
      grossLoss: num(r.gross_loss),
    });
  }

  return buildLeaderboard(strategies, curves, trades);
}
```
**Impact:** none outside the seer directory.

### Step 4: Positions
**File:** `src/connectors/seer/positions.ts:1` (new)
**Change:** Mirrors `positions()` and `pendingOrders()` (`~/seer/web/lib/data.ts:247-288`, `:326-366`) across all strategies at once, grouped by strategy:
- **Bracket orders:** `status='open'`, with mark `COALESCE(o.mark, latest bars.close, fill_price)` and `mark_source` saying which one was used. Unrealised P&L is `(mark − entry) × shares`.
- **Book positions:** P&L is `value + income − cost`.
- **Weight:** of `COALESCE(paper_state.equity_usd, latest snapshot equity)`.

Live strategies are listed even when flat. A retired strategy shows up only if it still holds something. `include_pending` adds pending bracket orders and a book strategy's targets for `paper_state.pending_session` when `pending_decision`. The latest `fx_rates.usd_idr` is returned for context. Money stays in USD. `strategy` filters case-insensitively by id, and an unknown id is a tool error that lists the known ids.
**Code:**
```ts
import type { QueryResult, ReadOnlySource } from '../types.js';
import { engineOf, statusOf, type Engine, type StrategyStatus } from './ranking.js';
import { bool, clip, fixed, num, numOrNull, round, str, strOrNull, toObjects, ymdOrNull, type Row } from './rows.js';

/** Seer design §5: a bracket position is closed by the end of its fifth session (data.ts BRACKET_MAX_DAYS). */
export const BRACKET_MAX_DAYS = 5;
const EXPLANATION_MAX = 200;

const POSITION_STRATEGIES_SQL = `SELECT s.id, s.name, s.engine, s.is_benchmark, s.status, s.sort,
  COALESCE(ps.equity_usd,
    (SELECT e.equity_usd FROM equity_snapshots e WHERE e.strategy_id = s.id ORDER BY e.date DESC LIMIT 1)) AS equity_usd,
  ps.last_session::text AS last_session, ps.pending_session::text AS pending_session, ps.pending_decision
FROM strategies s
LEFT JOIN paper_state ps ON ps.strategy_id = s.id
ORDER BY s.sort, s.id`;

const OPEN_ORDERS_SQL = `SELECT o.strategy_id, o.id, o.slot, o.symbol, o.company, o.shares,
  o.fill_date::text AS fill_date, o.fill_price, o.tp_price, o.sl_price, o.days_held,
  COALESCE(o.mark, lb.close, o.fill_price) AS mark,
  CASE WHEN o.mark IS NOT NULL THEN 'order mark'
       WHEN lb.close IS NOT NULL THEN 'latest close ' || lb.date::text
       ELSE 'fill price' END AS mark_source
FROM orders o
LEFT JOIN LATERAL (
  SELECT b.close, b.date FROM bars b WHERE b.symbol = o.symbol ORDER BY b.date DESC LIMIT 1
) lb ON true
WHERE o.status = 'open' AND ($1::text IS NULL OR o.strategy_id = $1::text)
ORDER BY o.strategy_id, o.days_held DESC, o.slot`;

const BOOK_POSITIONS_SQL = `SELECT p.strategy_id, p.symbol, p.shares, p.mark, p.entry_date::text AS entry_date,
  p.entry_price, p.days_held, p.cost_usd, p.income_usd, p.stop_price, p.take_price, p.exit_pending
FROM book_positions p
WHERE ($1::text IS NULL OR p.strategy_id = $1::text)
ORDER BY p.strategy_id, p.shares * p.mark DESC, p.symbol`;

const PENDING_ORDERS_SQL = `SELECT o.strategy_id, o.id, o.session_date::text AS session_date, o.slot, o.symbol,
  o.company, o.last_price, o.limit_price, o.tp_price, o.sl_price, o.shares, o.explanation
FROM orders o
WHERE o.status = 'pending' AND ($1::text IS NULL OR o.strategy_id = $1::text)
ORDER BY o.strategy_id, o.session_date, o.slot`;

const PENDING_TARGETS_SQL = `SELECT t.strategy_id, t.session_date::text AS session_date, t.rank, t.symbol, t.weight,
  t.last_price, t.limit_price, t.stop_price, t.take_price, t.explanation
FROM paper_state ps
JOIN book_targets t ON t.strategy_id = ps.strategy_id AND t.session_date = ps.pending_session
WHERE ps.pending_decision AND ($1::text IS NULL OR ps.strategy_id = $1::text)
ORDER BY t.strategy_id, t.rank`;

const FX_SQL = `SELECT date::text AS date, usd_idr FROM fx_rates ORDER BY date DESC LIMIT 1`;

export interface BracketHolding {
  order_id: number;
  slot: number;
  symbol: string;
  company: string | null;
  shares: number;
  entry_date: string | null;
  entry_price: number;
  mark: number;
  /** 'order mark' | 'latest close YYYY-MM-DD' | 'fill price' */
  mark_source: string;
  take_profit: number;
  stop_loss: number;
  /** Sessions held so far; the bracket closes by day max_days. */
  day: number;
  max_days: number;
  value_usd: number;
  /** value / the strategy's equity; null when no equity is known. */
  weight: number | null;
  unrealised_pnl_usd: number;
  unrealised_pnl_pct: number;
}

export interface BookHolding {
  kind: 'book' | 'benchmark';
  symbol: string;
  shares: number;
  entry_date: string | null;
  entry_price: number;
  mark: number;
  days_held: number;
  cost_usd: number;
  income_usd: number;
  value_usd: number;
  weight: number | null;
  /** value + income - cost (fees and dividends included). */
  unrealised_pnl_usd: number;
  /** (value + income) / cost - 1. */
  unrealised_pnl_pct: number;
  stop_price: number | null;
  take_price: number | null;
  /** A sell is decided and executes at the next open. */
  exit_pending: boolean;
}

export interface PendingBracketOrder {
  order_id: number;
  session_date: string | null;
  slot: number;
  symbol: string;
  company: string | null;
  last_price: number;
  limit_price: number;
  take_profit: number;
  stop_loss: number;
  shares: number;
  explanation: string | null;
}

export interface PendingBookTarget {
  session_date: string | null;
  rank: number;
  symbol: string;
  /** Target weight of equity, (0, 1]. */
  weight: number;
  last_price: number;
  limit_price: number | null;
  stop_price: number | null;
  take_price: number | null;
  explanation: string | null;
}

export interface StrategyPositions {
  id: string;
  name: string;
  engine: Engine;
  status: StrategyStatus;
  equity_usd: number | null;
  last_session: string | null;
  open_value_usd: number;
  unrealised_pnl_usd: number;
  bracket: BracketHolding[];
  book: BookHolding[];
  pending?: {
    session_date: string | null;
    decision: boolean;
    orders: PendingBracketOrder[];
    targets: PendingBookTarget[];
  };
}

export interface SeerPositions {
  currency: 'USD';
  /** Latest stored USD->IDR rate, for context only; amounts are not converted. */
  fx: { date: string; usd_idr: number } | null;
  strategies: StrategyPositions[];
  /** True when a query hit the row cap (results incomplete). */
  truncated: boolean;
  note: string;
}

export interface PositionsOptions {
  strategy?: string;
  includePending?: boolean;
}

const NOTE =
  'Money is USD as Seer stores it; fx.usd_idr is the latest stored rate, for context. ' +
  'Bracket P&L = (mark - entry) x shares; book P&L = value + income - cost (fees and dividends included). ' +
  'Weights are of the strategy equity (paper state, else its latest snapshot).';

function explanation(v: unknown): string | null {
  const s = strOrNull(v);
  return s === null ? null : clip(s, EXPLANATION_MAX);
}

/** seer_positions: open bracket orders and book positions per strategy, optionally what is pending. */
export async function seerPositions(db: ReadOnlySource, opts: PositionsOptions = {}): Promise<SeerPositions> {
  const all = toObjects(await db.query(POSITION_STRATEGIES_SQL, [], { maxRows: 1000 }));
  all.sort((a, b) => num(a.sort) - num(b.sort) || (str(a.id) < str(b.id) ? -1 : str(a.id) > str(b.id) ? 1 : 0));

  let only: string | null = null;
  const wanted = opts.strategy?.trim() ?? '';
  if (wanted !== '') {
    const hit = all.find((r) => str(r.id).toLowerCase() === wanted.toLowerCase());
    if (hit === undefined) {
      throw new Error(`seer has no strategy "${wanted}"; known ids: ${all.map((r) => str(r.id)).join(', ')}`);
    }
    only = str(hit.id);
  }
  const includePending = opts.includePending === true;
  const params = [only];
  const none: Promise<QueryResult | null> = Promise.resolve(null);

  const [orders, book, fx, pendOrders, pendTargets] = await Promise.all([
    db.query(OPEN_ORDERS_SQL, params, { maxRows: 1000 }),
    db.query(BOOK_POSITIONS_SQL, params, { maxRows: 1000 }),
    db.query(FX_SQL),
    includePending ? db.query(PENDING_ORDERS_SQL, params, { maxRows: 1000 }) : none,
    includePending ? db.query(PENDING_TARGETS_SQL, params, { maxRows: 1000 }) : none,
  ]);

  const meta = new Map<string, Row>(all.map((r) => [str(r.id), r] as const));
  const equityOf = (id: string): number | null => numOrNull(meta.get(id)?.equity_usd);
  const groups = new Map<string, StrategyPositions>();
  const group = (id: string): StrategyPositions => {
    const existing = groups.get(id);
    if (existing !== undefined) return existing;
    const r: Row = meta.get(id) ?? { id };
    const g: StrategyPositions = {
      id,
      name: str(r.name) || id,
      engine: engineOf(r.engine, bool(r.is_benchmark)),
      status: statusOf(r.status),
      equity_usd: round(numOrNull(r.equity_usd), 2),
      last_session: ymdOrNull(r.last_session),
      open_value_usd: 0,
      unrealised_pnl_usd: 0,
      bracket: [],
      book: [],
    };
    if (includePending) {
      g.pending = { session_date: ymdOrNull(r.pending_session), decision: bool(r.pending_decision), orders: [], targets: [] };
    }
    groups.set(id, g);
    return g;
  };

  for (const r of all) {
    const id = str(r.id);
    if (only !== null ? id === only : statusOf(r.status) === 'active') group(id);
  }

  for (const r of toObjects(orders)) {
    const id = str(r.strategy_id);
    const g = group(id);
    const equity = equityOf(id);
    const shares = num(r.shares);
    const entry = num(r.fill_price);
    const mark = num(r.mark);
    const value = shares * mark;
    const pnl = (mark - entry) * shares;
    g.bracket.push({
      order_id: num(r.id),
      slot: num(r.slot),
      symbol: str(r.symbol),
      company: strOrNull(r.company),
      shares,
      entry_date: ymdOrNull(r.fill_date),
      entry_price: entry,
      mark,
      mark_source: str(r.mark_source),
      take_profit: num(r.tp_price),
      stop_loss: num(r.sl_price),
      day: num(r.days_held),
      max_days: BRACKET_MAX_DAYS,
      value_usd: fixed(value, 2),
      weight: equity ? fixed(value / equity, 4) : null,
      unrealised_pnl_usd: fixed(pnl, 2),
      unrealised_pnl_pct: fixed(entry > 0 ? mark / entry - 1 : 0, 4),
    });
    g.open_value_usd += value;
    g.unrealised_pnl_usd += pnl;
  }

  for (const r of toObjects(book)) {
    const id = str(r.strategy_id);
    const g = group(id);
    const equity = equityOf(id);
    const shares = num(r.shares);
    const mark = num(r.mark);
    const cost = num(r.cost_usd);
    const income = num(r.income_usd);
    const value = shares * mark;
    const pnl = value + income - cost;
    g.book.push({
      kind: g.engine === 'benchmark' ? 'benchmark' : 'book',
      symbol: str(r.symbol),
      shares,
      entry_date: ymdOrNull(r.entry_date),
      entry_price: num(r.entry_price),
      mark,
      days_held: num(r.days_held),
      cost_usd: fixed(cost, 2),
      income_usd: fixed(income, 2),
      value_usd: fixed(value, 2),
      weight: equity ? fixed(value / equity, 4) : null,
      unrealised_pnl_usd: fixed(pnl, 2),
      unrealised_pnl_pct: fixed(cost > 0 ? (value + income) / cost - 1 : 0, 4),
      stop_price: numOrNull(r.stop_price),
      take_price: numOrNull(r.take_price),
      exit_pending: bool(r.exit_pending),
    });
    g.open_value_usd += value;
    g.unrealised_pnl_usd += pnl;
  }

  if (pendOrders !== null) {
    for (const r of toObjects(pendOrders)) {
      const g = group(str(r.strategy_id));
      g.pending?.orders.push({
        order_id: num(r.id),
        session_date: ymdOrNull(r.session_date),
        slot: num(r.slot),
        symbol: str(r.symbol),
        company: strOrNull(r.company),
        last_price: num(r.last_price),
        limit_price: num(r.limit_price),
        take_profit: num(r.tp_price),
        stop_loss: num(r.sl_price),
        shares: num(r.shares),
        explanation: explanation(r.explanation),
      });
    }
  }
  if (pendTargets !== null) {
    for (const r of toObjects(pendTargets)) {
      const g = group(str(r.strategy_id));
      g.pending?.targets.push({
        session_date: ymdOrNull(r.session_date),
        rank: num(r.rank),
        symbol: str(r.symbol),
        weight: num(r.weight),
        last_price: num(r.last_price),
        limit_price: numOrNull(r.limit_price),
        stop_price: numOrNull(r.stop_price),
        take_price: numOrNull(r.take_price),
        explanation: explanation(r.explanation),
      });
    }
  }
  for (const g of groups.values()) {
    if (g.pending !== undefined && g.pending.session_date === null) {
      g.pending.session_date = g.pending.orders[0]?.session_date ?? g.pending.targets[0]?.session_date ?? null;
    }
    g.open_value_usd = fixed(g.open_value_usd, 2);
    g.unrealised_pnl_usd = fixed(g.unrealised_pnl_usd, 2);
  }

  const fxRow = toObjects(fx)[0];
  const truncated = [orders, book, pendOrders, pendTargets].some((r) => r !== null && r.truncated);
  return {
    currency: 'USD',
    fx: fxRow !== undefined ? { date: ymdOrNull(fxRow.date) ?? '', usd_idr: num(fxRow.usd_idr) } : null,
    strategies: [...groups.values()],
    truncated,
    note: NOTE,
  };
}
```
**Impact:** none outside the seer directory.

### Step 5: Sera best variant per method (lab.sqlite)
**File:** `src/connectors/seer/sera.ts:1` (new)
**Change:** One window-function query picks each method's best dev trial by the lab's own order. It is `best_dev_eligible`'s `ORDER BY mar DESC, n ASC` over `window = 'dev' AND mar IS NOT NULL` (`~/seer/engine/src/seer_engine/lab/store.py:1367-1411`) and `LEADERBOARD_SQL`'s MAR-first order (`:2925`), applied without the live re-verdict, as the plan's Decisions table settles.
- `only_eligible` restricts the pool to trials whose stored `eligible = 1`.
- `status` filters on the method's status. `limit` caps the methods, which are listed best MAR first.
- A second query fetches all test-window trials for the returned methods.
- **Hurdles** are recomputed from stored columns with the constants Seer uses today: `dev.beats_spy_tr` (`backtest/dev.py:335`: money-weighted when `trial_funding` has both rates, else `total_return > spy_tr_return`), `tuning.MIN_PROFIT_FACTOR = 1.3` and `dev._MIN_TRADES = 100`.
- DSR is not re-derived. `eligible_at_run` is the stored column, and the result says what that means.
- With no `connector.lab`, the call fails soft with a `ConnectorError`.
**Code:**
```ts
import { ConnectorError, type ReadOnlySource } from '../types.js';
import { bool, clip, num, numOrNull, round, str, toObjects, type Row } from './rows.js';

/** lab.sqlite methods.status values (store.py schema CHECK). */
export const METHOD_STATUSES = [
  'idea',
  'registered',
  'rejected',
  'dev-eligible',
  'promoted',
  'test-passed',
  'test-failed',
  'paper',
  'blocked-data',
] as const;
export type MethodStatus = (typeof METHOD_STATUSES)[number];

/** seer_engine.backtest.tuning.MIN_PROFIT_FACTOR. */
export const MIN_PROFIT_FACTOR = 1.3;
/** seer_engine.backtest.dev._MIN_TRADES. */
export const MIN_TRADES = 100;
export const HYPOTHESIS_MAX = 280;
export const SERA_DEFAULT_LIMIT = 25;
export const SERA_MAX_LIMIT = 200;

/** Params: [only_eligible 0|1, status|null, status|null, limit]. */
export const BEST_SQL = `SELECT m.id, m.name, m.family, m.status, m.hypothesis,
  (SELECT count(*) FROM trials d WHERE d.method_id = m.id AND d."window" = 'dev') AS dev_trials,
  r.n, r.candidate_id, r.run_at, r.start, r.end_date, r.total_return, r.cagr, r.max_drawdown,
  r.profit_factor, r.trades, r.sharpe, r.mar, r.dsr, r.n_trials_at_run, r.spy_tr_return,
  r.eligible, r.failed, f.trial_n AS funding_n, f.mwr, f.spy_tr_mwr
FROM (
  SELECT t.n, t.method_id, t.candidate_id, t.run_at, t.start, t."end" AS end_date, t.total_return, t.cagr,
    t.max_drawdown, t.profit_factor, t.trades, t.sharpe, t.mar, t.dsr, t.n_trials_at_run, t.spy_tr_return,
    t.eligible, t.failed,
    ROW_NUMBER() OVER (PARTITION BY t.method_id ORDER BY t.mar DESC, t.n ASC) AS rk
  FROM trials t
  WHERE t."window" = 'dev' AND t.mar IS NOT NULL AND (? = 0 OR t.eligible = 1)
) r
JOIN methods m ON m.id = r.method_id
LEFT JOIN trial_funding f ON f.trial_n = r.n
WHERE r.rk = 1 AND (? IS NULL OR m.status = ?)
ORDER BY r.mar DESC, r.n ASC
LIMIT ?`;

/** Test-window trials of `count` methods (params: the method ids). */
export function testTrialsSql(count: number): string {
  const marks = Array.from({ length: count }, () => '?').join(', ');
  return `SELECT t.method_id, t.n, t.candidate_id, t.run_at, t.start, t."end" AS end_date, t.total_return, t.cagr,
  t.max_drawdown, t.profit_factor, t.trades, t.sharpe, t.mar, t.dsr, t.n_trials_at_run, t.spy_tr_return,
  t.eligible, t.failed
FROM trials t
WHERE t."window" = 'test' AND t.method_id IN (${marks})
ORDER BY t.method_id, t.n`;
}

export interface SeraHurdles {
  beats_spy: boolean;
  beats_spy_basis: 'money-weighted' | 'total return';
  profit_factor_ge_1_3: boolean;
  trades_ge_100: boolean;
}

/** Recomputes three of the lab's hurdles from stored numbers (store.py owner_failures, dev.beats_spy_tr). */
export function seraHurdles(t: {
  total_return: number | null;
  spy_tr_return: number | null;
  profit_factor: number | null;
  trades: number | null;
  mwr: number | null;
  spy_tr_mwr: number | null;
}): SeraHurdles {
  let beats: boolean;
  let basis: SeraHurdles['beats_spy_basis'];
  if (t.mwr !== null && t.spy_tr_mwr !== null) {
    beats = t.mwr > t.spy_tr_mwr;
    basis = 'money-weighted';
  } else {
    beats = t.total_return !== null && t.spy_tr_return !== null && t.total_return > t.spy_tr_return;
    basis = 'total return';
  }
  return {
    beats_spy: beats,
    beats_spy_basis: basis,
    profit_factor_ge_1_3: t.profit_factor !== null && t.profit_factor >= MIN_PROFIT_FACTOR,
    trades_ge_100: t.trades !== null && t.trades >= MIN_TRADES,
  };
}

export interface SeraTrial {
  n: number;
  candidate_id: string;
  run_at: string;
  start: string;
  end: string;
  total_return: number | null;
  cagr: number | null;
  max_drawdown: number | null;
  profit_factor: number | null;
  trades: number;
  sharpe: number | null;
  mar: number | null;
  dsr: number | null;
  n_trials_at_run: number;
  spy_tr_return: number | null;
  /** The lab's stored verdict, judged against the bar and trial count in force on run_at. */
  eligible_at_run: boolean;
  /** The lab's stored failure labels at run time ('' when none). */
  failed_at_run: string;
}

export interface SeraBestTrial extends SeraTrial {
  /** Present when the trial was funded with deposits (trial_funding row). */
  funding: { mwr: number | null; spy_tr_mwr: number | null } | null;
  hurdles: SeraHurdles;
}

export interface SeraMethodBest {
  id: string;
  name: string;
  family: string;
  status: string;
  hypothesis: string;
  dev_trials: number;
  best: SeraBestTrial;
  test_trials: SeraTrial[];
}

export interface SeraBest {
  source: 'lab.sqlite';
  rule: string;
  eligibility_note: string;
  filters: { limit: number; status: MethodStatus | null; only_eligible: boolean };
  methods: SeraMethodBest[];
}

export interface SeraOptions {
  limit?: number;
  status?: MethodStatus;
  onlyEligible?: boolean;
}

const RULE =
  "Best variant per method = the dev-window trial with the highest MAR (CAGR / max drawdown), ties to the lower trial n " +
  "(the lab's own best_dev_eligible order); never chosen on DSR. Methods are listed best MAR first.";
const ELIGIBILITY_NOTE =
  'eligible_at_run is the lab verdict stored when the trial ran: DSR deflates for the number of trials run so far, ' +
  'so a variant eligible then may fail today at a larger trial count. DSR is not re-derived here. ' +
  'hurdles are recomputed from stored numbers against current bars (beats SPY, PF >= 1.3, trades >= 100).';

function trialOf(r: Row): SeraTrial {
  return {
    n: num(r.n),
    candidate_id: str(r.candidate_id),
    run_at: str(r.run_at),
    start: str(r.start),
    end: str(r.end_date),
    total_return: round(numOrNull(r.total_return), 4),
    cagr: round(numOrNull(r.cagr), 4),
    max_drawdown: round(numOrNull(r.max_drawdown), 4),
    profit_factor: round(numOrNull(r.profit_factor), 3),
    trades: num(r.trades),
    sharpe: round(numOrNull(r.sharpe), 3),
    mar: round(numOrNull(r.mar), 3),
    dsr: round(numOrNull(r.dsr), 3),
    n_trials_at_run: num(r.n_trials_at_run),
    spy_tr_return: round(numOrNull(r.spy_tr_return), 4),
    eligible_at_run: bool(r.eligible),
    failed_at_run: str(r.failed),
  };
}

/** seer_sera_best: the best dev variant per method from lab.sqlite, with its test-window trials. */
export async function seerSeraBest(lab: ReadOnlySource | undefined, opts: SeraOptions = {}): Promise<SeraBest> {
  if (lab === undefined) throw new ConnectorError('seer is not reachable: lab.sqlite is not available');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? SERA_DEFAULT_LIMIT), 1), SERA_MAX_LIMIT);
  const status = opts.status ?? null;
  const onlyEligible = opts.onlyEligible === true;

  const best = toObjects(
    await lab.query(BEST_SQL, [onlyEligible ? 1 : 0, status, status, limit], { maxRows: SERA_MAX_LIMIT }),
  );
  best.sort((a, b) => num(b.mar) - num(a.mar) || num(a.n) - num(b.n));

  const tests = new Map<string, SeraTrial[]>();
  const ids = best.map((r) => str(r.id));
  if (ids.length > 0) {
    const rows = toObjects(await lab.query(testTrialsSql(ids.length), ids, { maxRows: 1000 }));
    for (const r of rows) {
      const key = str(r.method_id);
      const list = tests.get(key) ?? [];
      list.push(trialOf(r));
      tests.set(key, list);
    }
  }

  const methods: SeraMethodBest[] = best.map((r) => {
    const funded = r.funding_n !== null && r.funding_n !== undefined;
    const mwr = funded ? numOrNull(r.mwr) : null;
    const spyMwr = funded ? numOrNull(r.spy_tr_mwr) : null;
    return {
      id: str(r.id),
      name: str(r.name),
      family: str(r.family),
      status: str(r.status),
      hypothesis: clip(str(r.hypothesis), HYPOTHESIS_MAX),
      dev_trials: num(r.dev_trials),
      best: {
        ...trialOf(r),
        funding: funded ? { mwr: round(mwr, 4), spy_tr_mwr: round(spyMwr, 4) } : null,
        hurdles: seraHurdles({
          total_return: numOrNull(r.total_return),
          spy_tr_return: numOrNull(r.spy_tr_return),
          profit_factor: numOrNull(r.profit_factor),
          trades: numOrNull(r.trades),
          mwr,
          spy_tr_mwr: spyMwr,
        }),
      },
      test_trials: tests.get(str(r.id)) ?? [],
    };
  });

  return {
    source: 'lab.sqlite',
    rule: RULE,
    eligibility_note: ELIGIBILITY_NOTE,
    filters: { limit, status, only_eligible: onlyEligible },
    methods,
  };
}
```
**Impact:** none outside the seer directory.

### Step 6: Register the three tools
**File:** `src/connectors/seer/curated.ts:1` (replace the phase-1 stub whole)
**Change:** Registers the tools with `readOnlyHint` and descriptions written for Claude. Every handler goes through `run(…, { compact: true })`, so a `ConnectorError` (or the unknown-strategy error) becomes an `isError` result and never throws out of the handler (invariant 6).
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../../mcp/tools.js';
import type { Connector } from '../types.js';
import { seerLeaderboard } from './leaderboard.js';
import { seerPositions } from './positions.js';
import { METHOD_STATUSES, SERA_DEFAULT_LIMIT, SERA_MAX_LIMIT, seerSeraBest } from './sera.js';

const LEADERBOARD_DESCRIPTION =
  "Seer's paper-trading leaderboard, ranked the way the Seer app ranks it. Strategies are compared only over the dates " +
  'every ranked strategy has an equity snapshot (the common window, returned as window.from / window.to / window.sessions); ' +
  'a ranking needs at least 63 shared sessions, and a strategy that overlaps too little is dropped so the rest can still be ranked. ' +
  'Order: annualised Sharpe of daily returns over the window (rf = 0, x sqrt(252)) highest first, no Sharpe last; then window ' +
  'total return; then smaller max drawdown; then id. ranked[] has rank, window figures (total_return, cagr, max_drawdown, sharpe) ' +
  'and since_start figures over the whole record (total_return, max_drawdown, win_rate, profit_factor where "infinite" means ' +
  'no losing trade, trades, months), plus sessions, days, paper_start and current_equity_usd. not_ranked[] holds the benchmark ' +
  '(SPY, the yardstick, with its figures over the same window), retired strategies (record kept, never ranked) and strategies ' +
  'too new to share 63 sessions, each with not_ranked_reason. Returns are fractions (0.12 = +12%); money is USD. Always name the ' +
  'window when you say which strategy leads. If window is null nothing is ranked yet: say so, and use shared_sessions to say how ' +
  'far off a ranking is.';

const POSITIONS_DESCRIPTION =
  'Open paper positions in Seer, grouped by strategy (live strategies are listed even when flat). bracket[] holds open bracket ' +
  "orders: entry, mark (the order's own mark, else the symbol's latest stored close, else the fill price; mark_source says which), " +
  'take_profit / stop_loss, day N of max_days, value, weight of equity, unrealised P&L = (mark - entry) x shares. book[] holds ' +
  'book and benchmark holdings: value, cost, income (dividends), unrealised P&L = value + income - cost (fees included), ' +
  'exit_pending when a sell executes at the next open. Each strategy also has equity_usd, open_value_usd and unrealised_pnl_usd. ' +
  'Money is USD exactly as Seer stores it; fx.usd_idr is the latest stored rate if the user wants rupiah. Pass strategy (an id ' +
  "such as 'RAW35-FR-GT'; seer_leaderboard lists them) for one strategy. include_pending adds what is queued for the next " +
  "session: pending bracket orders, or a book strategy's target weights for its pending decision session.";

const SERA_DESCRIPTION =
  "The best Sera research result per method, read from Seer's lab (lab.sqlite). Each method's best variant is chosen by the " +
  "lab's own rule: the dev-window trial with the highest MAR (CAGR / max drawdown), ties to the earlier trial; never chosen on " +
  'DSR. Methods are listed best MAR first. Per method: name, family, status, hypothesis (shortened), dev_trials (how many dev ' +
  "variants it ran), and best: the trial's candidate_id, run_at, window dates, total_return, cagr, max_drawdown, profit_factor, " +
  "trades, sharpe, mar, dsr, n_trials_at_run, spy_tr_return (SPY total return over the same window), funding (money-weighted " +
  'returns when the trial was funded with deposits) and hurdles recomputed from those numbers (beats SPY, money-weighted when ' +
  'funded; PF >= 1.3; trades >= 100). test_trials[] lists the out-of-sample test-window trials for that method, if any. ' +
  'eligible_at_run is the lab verdict AS OF THE RUN DATE: the deflated Sharpe discounts for how many trials had been run, so a ' +
  'variant eligible then may not clear the bar at today\'s larger trial count, and this tool does not re-derive DSR. Say ' +
  '"eligible when it ran" rather than "eligible". Filters: status (method status), only_eligible (choose each method\'s best ' +
  'among trials stored eligible), limit (default 25). Returns are fractions.';

export function registerSeerCurated(server: McpServer, connector: Connector): void {
  server.registerTool(
    'seer_leaderboard',
    {
      title: 'Seer leaderboard',
      description: LEADERBOARD_DESCRIPTION,
      annotations: { readOnlyHint: true },
    },
    async () => run(() => seerLeaderboard(connector), { compact: true }),
  );

  server.registerTool(
    'seer_positions',
    {
      title: 'Seer open positions',
      description: POSITIONS_DESCRIPTION,
      inputSchema: {
        strategy: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("A strategy id, e.g. 'RAW35-FR-GT' (case-insensitive). Omit for every live strategy."),
        include_pending: z
          .boolean()
          .optional()
          .describe('Also list orders and book targets queued for the next session. Default false.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ strategy, include_pending }) =>
      run(() => seerPositions(connector, { strategy, includePending: include_pending ?? false }), { compact: true }),
  );

  server.registerTool(
    'seer_sera_best',
    {
      title: 'Sera best variant per method',
      description: SERA_DESCRIPTION,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(SERA_MAX_LIMIT)
          .optional()
          .describe(`How many methods to return, best MAR first. Default ${SERA_DEFAULT_LIMIT}.`),
        status: z.enum(METHOD_STATUSES).optional().describe('Only methods in this lab status, e.g. "dev-eligible".'),
        only_eligible: z
          .boolean()
          .optional()
          .describe("Pick each method's best among trials the lab stored as eligible when they ran. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, status, only_eligible }) =>
      run(() => seerSeraBest(connector.lab, { limit, status, onlyEligible: only_eligible ?? false }), { compact: true }),
  );
}
```
**Impact:** `tools/list` on `/mcp` now shows the three seer curated tools next to phase 1's `seer_schema`/`seer_sql`. Phase 5's allow list and captions already name them through `ALL_CONNECTOR_TOOL_NAMES`.

### Step 7: Unit tests for the ranking port and leaderboard shaping
**File:** `tests/unit/connectors/seer.ranking.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { buildLeaderboard, parseCurve, type BoardStrategy } from '../../../src/connectors/seer/leaderboard.js';
import {
  commonDates,
  compareStrategies,
  countsFor,
  engineOf,
  rankCmp,
  selectRanked,
  sinceStartMetrics,
  spanDays,
  windowed,
  type CompareRow,
  type RankIn,
  type Snapshot,
  type TradeStats,
  type Windowed,
} from '../../../src/connectors/seer/ranking.js';

const DAY = 86_400_000;

function sessions(n: number, offset = 0, start = '2026-01-01'): string[] {
  const t0 = Date.parse(start);
  return Array.from({ length: n }, (_, i) => new Date(t0 + (i + offset) * DAY).toISOString().slice(0, 10));
}

function curveOf(dates: string[], f: (i: number) => number): Snapshot[] {
  return dates.map((date, i) => ({ date, equity: f(i) }));
}

/** Low-volatility steady climb: high Sharpe, modest return. */
const smooth = (i: number): number => 10000 + 20 * i + (i % 2) * 5;
/** Higher return, much higher volatility: lower Sharpe. */
const choppy = (i: number): number => 10000 + 40 * i + (i % 2) * 150;

const rank = (id: string, extra: Partial<RankIn> = {}): RankIn => ({ id, isBenchmark: false, status: 'active', ...extra });

describe('commonDates', () => {
  it('is a set intersection, not a range', () => {
    const a = curveOf(['2026-01-01', '2026-01-02', '2026-01-03'], () => 1);
    const b = curveOf(['2026-01-03', '2026-01-01'], () => 1);
    expect(commonDates([a, b])).toEqual(['2026-01-01', '2026-01-03']);
    expect(commonDates([])).toEqual([]);
  });
});

describe('windowed', () => {
  const d3 = ['2026-01-01', '2026-01-02', '2026-01-03'];

  it('annualises the Sharpe of daily returns with rf = 0 and sqrt(252)', () => {
    const w = windowed(curveOf(d3, (i) => [100, 101, 103.02][i]!), d3);
    expect(w.totalReturn).toBeCloseTo(0.0302, 10);
    expect(w.maxDrawdown).toBe(0);
    // returns 0.01, 0.02: mean 0.015, sample sd 0.0070711 -> 2.12132 * sqrt(252)
    expect(w.sharpe).toBeCloseTo(33.6749, 3);
  });

  it('measures max drawdown from the running peak', () => {
    const w = windowed(curveOf(d3, (i) => [100, 110, 99][i]!), d3);
    expect(w.maxDrawdown).toBeCloseTo(0.1, 10);
    expect(w.totalReturn).toBeCloseTo(-0.01, 10);
  });

  it('has no Sharpe for a flat curve or a single return', () => {
    expect(windowed(curveOf(d3, () => 100), d3).sharpe).toBeNull();
    const d2 = d3.slice(0, 2);
    expect(windowed(curveOf(d2, (i) => 100 + i), d2).sharpe).toBeNull();
  });

  it('computes CAGR over calendar years of 365.25 days', () => {
    const d = ['2024-01-01', '2026-01-01'];
    const w = windowed(curveOf(d, (i) => [100, 121][i]!), d);
    expect(w.cagr).toBeCloseTo(Math.pow(1.21, 1 / (731 / 365.25)) - 1, 12);
  });
});

describe('selectRanked', () => {
  it('greedily drops the strategy that overlaps least', () => {
    const out = selectRanked(
      new Map([
        ['A', curveOf(sessions(100), smooth)],
        ['B', curveOf(sessions(100), choppy)],
        ['C', curveOf(sessions(100, 70), smooth)],
      ]),
    );
    expect([...out.ids].sort()).toEqual(['A', 'B']);
    expect(out.dates).toHaveLength(100);
  });

  it('ranks nothing when the last two share too few sessions', () => {
    const out = selectRanked(
      new Map([
        ['A', curveOf(sessions(70), smooth)],
        ['B', curveOf(sessions(70, 40), smooth)],
      ]),
    );
    expect(out.ids.size).toBe(0);
    expect(out.dates).toEqual([]);
  });
});

describe('compareStrategies', () => {
  const d = sessions(70);
  const board = [
    { strategy: rank('SPY', { isBenchmark: true }), curve: curveOf(d, (i) => 10000 + 10 * i) },
    { strategy: rank('F4'), curve: curveOf(d, choppy) },
    { strategy: rank('A'), curve: curveOf(d, smooth) },
    { strategy: rank('NEW'), curve: curveOf(sessions(10, 60), (i) => 10000 + 5 * i) },
    { strategy: rank('OLD', { status: 'retired' }), curve: curveOf(sessions(30), (i) => 10000 - 3 * i) },
  ];

  it('ranks by Sharpe before total return over the common window', () => {
    const c = compareStrategies(board);
    expect(c.window).toEqual({ from: d[0], to: d[69], sessions: 70 });
    expect(c.ranked.map((r) => r.strategy.id)).toEqual(['A', 'F4']);
    expect(c.ranked[1]!.windowed!.totalReturn).toBeGreaterThan(c.ranked[0]!.windowed!.totalReturn);
  });

  it('never compares the benchmark and never ranks retired or too-new strategies', () => {
    const c = compareStrategies(board);
    expect(c.rows.map((r) => [r.strategy.id, r.status])).toEqual([
      ['F4', 'ranked'],
      ['A', 'ranked'],
      ['NEW', 'insufficient'],
      ['OLD', 'retired'],
    ]);
    expect(c.shared).toBe(10);
  });

  it('does not depend on input order', () => {
    expect(compareStrategies([...board].reverse()).ranked.map((r) => r.strategy.id)).toEqual(['A', 'F4']);
  });

  it('has no window below 63 shared sessions', () => {
    const short = sessions(62);
    const c = compareStrategies([
      { strategy: rank('A'), curve: curveOf(short, smooth) },
      { strategy: rank('B'), curve: curveOf(short, choppy) },
    ]);
    expect(c.window).toBeNull();
    expect(c.ranked).toEqual([]);
    expect(c.shared).toBe(62);
  });
});

describe('rankCmp', () => {
  const row = (id: string, w: Partial<Windowed>): CompareRow<RankIn> => ({
    strategy: rank(id),
    status: 'ranked',
    curve: [],
    windowed: { totalReturn: 0, cagr: null, maxDrawdown: 0, sharpe: null, ...w },
  });

  it('breaks ties by return, then smaller drawdown, then id; no Sharpe last', () => {
    const sorted = [
      row('Z', { sharpe: null, totalReturn: 0.5 }),
      row('B', { sharpe: 1, totalReturn: 0.1, maxDrawdown: 0.2 }),
      row('A', { sharpe: 1, totalReturn: 0.1, maxDrawdown: 0.2 }),
      row('C', { sharpe: 1, totalReturn: 0.1, maxDrawdown: 0.1 }),
      row('D', { sharpe: 1, totalReturn: 0.3 }),
      row('E', { sharpe: 2 }),
    ].sort(rankCmp);
    expect(sorted.map((r) => r.strategy.id)).toEqual(['E', 'D', 'C', 'A', 'B', 'Z']);
  });
});

describe('sinceStartMetrics', () => {
  const dates = ['2026-01-01', '2026-01-31', '2026-03-02'];

  it('mirrors strategyMetrics', () => {
    const m = sinceStartMetrics(curveOf(dates, (i) => [100, 120, 90][i]!), { trades: 3, wins: 2, grossWin: 80, grossLoss: 20 });
    expect(m.totalReturn).toBeCloseTo(-0.1, 10);
    expect(m.maxDrawdown).toBeCloseTo(0.25, 10);
    expect(m.winRate).toBeCloseTo(2 / 3, 10);
    expect(m.profitFactor).toBe(4);
    expect(m.trades).toBe(3);
    expect(m.months).toBeCloseTo(60 / 30.44, 10);
  });

  it('reports an infinite profit factor with no losing trade, and nulls with no trades or snapshots', () => {
    expect(sinceStartMetrics([], { trades: 2, wins: 1, grossWin: 100, grossLoss: 0 }).profitFactor).toBe(Infinity);
    const empty = sinceStartMetrics([], { trades: 0, wins: 0, grossWin: 0, grossLoss: 0 });
    expect(empty).toEqual({ totalReturn: null, maxDrawdown: null, winRate: null, profitFactor: null, trades: 0, months: 0 });
  });

  it('spanDays counts calendar days first to last', () => {
    expect(spanDays(curveOf(sessions(70), smooth))).toBe(69);
  });
});

describe('engineOf / countsFor', () => {
  it('match the app', () => {
    expect(engineOf('book', false)).toBe('book');
    expect(engineOf(null, true)).toBe('benchmark');
    expect(engineOf('weird', false)).toBe('bracket');
    expect(countsFor('book', 'book')).toBe(true);
    expect(countsFor('bracket', 'book')).toBe(false);
    expect(countsFor('benchmark', 'book')).toBe(false);
  });
});

describe('buildLeaderboard', () => {
  const d = sessions(70);
  const strategies: BoardStrategy[] = [
    { id: 'OLD', name: 'OLD', engine: 'book', isBenchmark: false, status: 'retired', paperStart: d[0]!, paperEnd: d[29]!, sort: 0 },
    { id: 'SPY', name: 'SPY', engine: 'benchmark', isBenchmark: true, status: 'active', paperStart: d[0]!, paperEnd: null, sort: 1 },
    { id: 'A', name: 'A', engine: 'bracket', isBenchmark: false, status: 'active', paperStart: d[0]!, paperEnd: null, sort: 2 },
    { id: 'F4', name: 'F4', engine: 'book', isBenchmark: false, status: 'active', paperStart: d[0]!, paperEnd: null, sort: 3 },
  ];
  const curves = new Map<string, Snapshot[]>([
    ['SPY', curveOf(d, (i) => 10000 + 10 * i)],
    ['A', curveOf(d, smooth)],
    ['F4', curveOf(d, choppy)],
    ['OLD', curveOf(sessions(30), (i) => 10000 - 3 * i)],
  ]);
  const trades = new Map<string, TradeStats>([
    ['A', { trades: 3, wins: 2, grossWin: 80, grossLoss: 20 }],
    ['F4', { trades: 2, wins: 1, grossWin: 100, grossLoss: 0 }],
  ]);

  it('ranks, then lists the benchmark and retired strategies separately', () => {
    const b = buildLeaderboard(strategies, curves, trades);
    expect(b.window).toEqual({ from: d[0], to: d[69], sessions: 70 });
    expect(b.ranked.map((e) => [e.rank, e.id])).toEqual([
      [1, 'A'],
      [2, 'F4'],
    ]);
    expect(b.ranked[0]!.current_equity_usd).toBe(11385);
    expect(b.ranked[0]!.since_start.profit_factor).toBe(4);
    expect(b.ranked[0]!.since_start.win_rate).toBe(0.6667);
    expect(b.not_ranked.map((e) => e.id)).toEqual(['SPY', 'OLD']);
    expect(b.not_ranked[0]!.window?.total_return).toBeCloseTo(0.069, 4);
    expect(b.not_ranked[0]!.not_ranked_reason).toMatch(/^benchmark/);
    expect(b.not_ranked[1]!.not_ranked_reason).toMatch(/^retired/);
  });

  it('keeps an infinite profit factor readable through JSON', () => {
    const b = JSON.parse(JSON.stringify(buildLeaderboard(strategies, curves, trades))) as ReturnType<typeof buildLeaderboard>;
    expect(b.ranked[1]!.since_start.profit_factor).toBe('infinite');
  });

  it('parses curves whether the driver parsed the json or not', () => {
    expect(parseCurve('[["2026-01-01", 100.5]]')).toEqual([{ date: '2026-01-01', equity: 100.5 }]);
    expect(parseCurve([['2026-01-02', '7']])).toEqual([{ date: '2026-01-02', equity: 7 }]);
    expect(parseCurve(null)).toEqual([]);
  });
});
```

### Step 8: Unit tests for the Sera hurdles
**File:** `tests/unit/connectors/seer.sera.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { seraHurdles, testTrialsSql } from '../../../src/connectors/seer/sera.js';

describe('seraHurdles', () => {
  it('judges SPY money-weighted when both funding rates exist', () => {
    expect(
      seraHurdles({ total_return: 0.2, spy_tr_return: 0.3, profit_factor: 1.1, trades: 50, mwr: 0.1, spy_tr_mwr: 0.05 }),
    ).toEqual({ beats_spy: true, beats_spy_basis: 'money-weighted', profit_factor_ge_1_3: false, trades_ge_100: false });
  });

  it('falls back to total return, with the bars inclusive', () => {
    expect(
      seraHurdles({ total_return: 0.5, spy_tr_return: 0.3, profit_factor: 1.3, trades: 100, mwr: null, spy_tr_mwr: null }),
    ).toEqual({ beats_spy: true, beats_spy_basis: 'total return', profit_factor_ge_1_3: true, trades_ge_100: true });
  });

  it('does not beat SPY on a tie, a missing benchmark, or one funding side only', () => {
    const base = { profit_factor: 2, trades: 200, mwr: null, spy_tr_mwr: null };
    expect(seraHurdles({ ...base, total_return: 0.3, spy_tr_return: 0.3 }).beats_spy).toBe(false);
    expect(seraHurdles({ ...base, total_return: 0.3, spy_tr_return: null }).beats_spy).toBe(false);
    const half = seraHurdles({ ...base, total_return: 0.1, spy_tr_return: 0.3, mwr: 0.5 });
    expect(half).toMatchObject({ beats_spy: false, beats_spy_basis: 'total return' });
  });
});

describe('testTrialsSql', () => {
  it('binds one placeholder per method id', () => {
    expect(testTrialsSql(3)).toContain('IN (?, ?, ?)');
    expect(testTrialsSql(1)).toContain(`t."window" = 'test'`);
  });
});
```

### Step 9: Unit tests for the tool layer (stub connector, in-memory MCP)
**File:** `tests/unit/connectors/seer.curated.test.ts:1` (new)
**Change:** Registers the curated tools on a bare `McpServer` over `InMemoryTransport`, with a stub `Connector`. It needs no DB and does not touch `server.ts`. It checks the tool names against the contract, the DSR wording in the description, the fail-soft errors, and an empty board.
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_TOOL_NAMES } from '../../../src/connectors/names.js';
import { registerSeerCurated } from '../../../src/connectors/seer/curated.js';
import type { SeerLeaderboard } from '../../../src/connectors/seer/leaderboard.js';
import { ConnectorError, type Connector, type QueryResult } from '../../../src/connectors/types.js';

const EMPTY: QueryResult = { columns: [], rows: [], row_count: 0, truncated: false };

function stub(query: Connector['query'], lab?: Connector['lab']): Connector {
  const c: Connector = { id: 'seer', label: 'seer', query };
  if (lab !== undefined) c.lab = lab;
  return c;
}

async function connect(connector: Connector): Promise<Client> {
  const server = new McpServer({ name: 'seer-curated-test', version: '0.0.0' });
  registerSeerCurated(server, connector);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'seer-curated-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function text(result: unknown): string {
  const first = (result as CallToolResult).content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describe('registerSeerCurated', () => {
  it('registers exactly the three curated seer tools from the contract', async () => {
    const client = await connect(stub(async () => EMPTY));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CONNECTOR_TOOL_NAMES.seer.slice(2)].sort());
    const sera = tools.find((t) => t.name === 'seer_sera_best');
    expect(sera?.description).toContain('AS OF THE RUN DATE');
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('returns an empty, unranked board when Seer has no data', async () => {
    const client = await connect(stub(async () => EMPTY));
    const result = (await client.callTool({ name: 'seer_leaderboard', arguments: {} })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const board = JSON.parse(text(result)) as SeerLeaderboard;
    expect(board.window).toBeNull();
    expect(board.ranked).toEqual([]);
    expect(board.not_ranked).toEqual([]);
  });

  it('turns a connector failure into a tool error', async () => {
    const client = await connect(
      stub(async () => {
        throw new ConnectorError('seer is not reachable: no .env.local');
      }),
    );
    const result = (await client.callTool({ name: 'seer_leaderboard', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('seer is not reachable: no .env.local');
  });

  it('fails soft when the lab is not available', async () => {
    const client = await connect(stub(async () => EMPTY));
    const result = (await client.callTool({ name: 'seer_sera_best', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('seer is not reachable: lab.sqlite is not available');
  });

  it('names the known strategies when asked for an unknown one', async () => {
    const strategies: QueryResult = {
      columns: ['id', 'name', 'engine', 'is_benchmark', 'status', 'sort', 'equity_usd', 'last_session', 'pending_session', 'pending_decision'],
      rows: [['A', 'A · Quant', 'bracket', false, 'active', 2, null, null, null, false]],
      row_count: 1,
      truncated: false,
    };
    const client = await connect(stub(async () => strategies));
    const result = (await client.callTool({ name: 'seer_positions', arguments: { strategy: 'NOPE' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('seer has no strategy "NOPE"; known ids: A');
  });
});
```

### Step 10: Integration test on seeded Postgres + temp lab
**File:** `tests/integration/connectors/seer.curated.int.test.ts:1` (new)
**Change:** Truncates and seeds the migrated seer DB with `truncateSystem('seer')` + `seedSystem('seer', SEED_SQL)`, writes lab rows into the file `makeLab()` creates, builds a real connector with `connectorFor('seer', { labPath: lab.path })`, and calls the three tools through an in-memory MCP client. It skips when `~/seer` is absent (`describeWithRepo`).
**Code:**
```ts
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerSeerCurated } from '../../../src/connectors/seer/curated.js';
import type { BoardEntry, SeerLeaderboard } from '../../../src/connectors/seer/leaderboard.js';
import type { SeerPositions, StrategyPositions } from '../../../src/connectors/seer/positions.js';
import type { SeraBest, SeraMethodBest } from '../../../src/connectors/seer/sera.js';
import type { Connector } from '../../../src/connectors/types.js';
import { cleanupHarness, connectorFor, describeWithRepo, makeLab, seedSystem, truncateSystem } from './harness.js';

// ---------------------------------------------------------------- Postgres seed (admin connection)

/** Runs after truncateSystem('seer'), which also removed the migrations' roster rows. */
const SEED_SQL = `
INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, sort, engine, status, paper_start, paper_end) VALUES
  ('SPY',  'SPY',             'S&P 500, buy and hold',  'landmark',    true,  true,  1, 'benchmark', 'active',  '2026-05-01', NULL),
  ('A',    'A · Quant',       'Mean reversion',         'sigma',       false, false, 2, 'bracket',   'active',  '2026-05-01', NULL),
  ('F4',   'F4 · Momentum',   'Top 20 momentum',        'trending-up', false, false, 3, 'book',      'active',  '2026-05-01', NULL),
  ('NEW',  'NEW · Newcomer',  'Ten sessions old',       'sparkle',     false, false, 4, 'book',      'active',  '2026-06-30', NULL),
  ('OLD',  'OLD · Retired',   'Traded, then retired',   'archive',     false, false, 5, 'book',      'retired', '2026-05-01', '2026-05-30'),
  ('GONE', 'GONE · Never ran','Retired before trading', 'x',           false, false, 6, 'book',      'retired', '2026-05-01', NULL);

INSERT INTO equity_snapshots (strategy_id, date, cash_usd, equity_usd)
SELECT 'SPY', DATE '2026-05-01' + i, 0, 10000 + 10 * i FROM generate_series(0, 69) AS i
UNION ALL SELECT 'A', DATE '2026-05-01' + i, 0, 10000 + 20 * i + (i % 2) * 5 FROM generate_series(0, 69) AS i
UNION ALL SELECT 'F4', DATE '2026-05-01' + i, 0, 10000 + 40 * i + (i % 2) * 150 FROM generate_series(0, 69) AS i
UNION ALL SELECT 'NEW', DATE '2026-05-01' + i, 0, 10000 + 5 * i FROM generate_series(60, 69) AS i
UNION ALL SELECT 'OLD', DATE '2026-05-01' + i, 0, 10000 - 3 * i FROM generate_series(0, 29) AS i
UNION ALL SELECT 'GONE', DATE '2026-05-01' + i, 0, 10000 FROM generate_series(0, 5) AS i;

INSERT INTO orders (strategy_id, session_date, slot, symbol, company, last_price, limit_price, tp_price, sl_price, shares,
                    status, fill_date, fill_price, days_held, exit_date, exit_price, exit_reason, pnl_usd, mark) VALUES
  ('A', '2026-06-01', 1, 'C1',   'Closed One',   10, 10,   11, 9,  10, 'closed',  '2026-06-01', 10,  3, '2026-06-04', 15, 'tp',   50,  NULL),
  ('A', '2026-06-02', 1, 'C2',   'Closed Two',   10, 10,   11, 9,  10, 'closed',  '2026-06-02', 10,  2, '2026-06-04', 8,  'sl',   -20, NULL),
  ('A', '2026-06-03', 1, 'C3',   'Closed Three', 10, 10,   11, 9,  10, 'closed',  '2026-06-03', 10,  5, '2026-06-08', 13, 'time', 30,  NULL),
  ('A', '2026-07-06', 1, 'AAPL', 'Apple',        100, 100, 110, 95, 10, 'open',   '2026-07-06', 100, 3, NULL, NULL, NULL, NULL, NULL),
  ('A', '2026-07-07', 2, 'MSFT', 'Microsoft',    40, 40,   44, 38, 5,  'open',    '2026-07-07', 40,  2, NULL, NULL, NULL, NULL, 50),
  ('A', '2026-07-08', 3, 'XYZ',  'Xyz Corp',     20, 20,   22, 19, 3,  'open',    '2026-07-08', 20,  1, NULL, NULL, NULL, NULL, NULL),
  ('A', '2026-07-10', 1, 'PEND', 'Pending Inc',  30, 29.5, 32, 28, 4,  'pending', NULL,         NULL, 0, NULL, NULL, NULL, NULL, NULL);

INSERT INTO bars (symbol, date, open, high, low, close, volume) VALUES
  ('AAPL', '2026-07-08', 104, 106, 103, 105, 1000),
  ('AAPL', '2026-07-09', 108, 111, 107, 110, 1000),
  ('MSFT', '2026-07-09', 45, 46, 44, 45, 1000);

INSERT INTO book_trades (strategy_id, symbol, entry_date, exit_date, entry_price, exit_price, days_held, cost_usd, income_usd,
                         pnl_usd, exit_reason, idle) VALUES
  ('F4', 'W1',    '2026-05-01', '2026-06-01', 10, 20, 21, 1, 0, 100,  'signal', false),
  ('F4', 'W2',    '2026-05-01', '2026-06-01', 10, 10, 21, 0, 0, 0,    'signal', false),
  ('F4', 'IDLE',  '2026-05-01', '2026-06-01', 10, 99, 21, 0, 0, 999,  'signal', true),
  ('A',  'BOOKY', '2026-05-01', '2026-06-01', 10, 20, 21, 0, 0, 1000, 'signal', false);

INSERT INTO book_positions (strategy_id, symbol, shares, mark, entry_date, entry_price, days_held, cost_usd, income_usd,
                            stop_price, take_price, exit_pending) VALUES
  ('F4',  'NVDA', 2,  500, '2026-06-01', 450, 28, 900,  10, NULL, NULL, false),
  ('F4',  'AMD',  1,  150, '2026-06-01', 140, 28, 140,  0,  NULL, NULL, true),
  ('SPY', 'SPY',  10, 600, '2026-05-01', 580, 49, 5800, 0,  NULL, NULL, false);

INSERT INTO paper_state (strategy_id, last_session, cash_usd, equity_usd, initial_cash_usd, usd_idr, pending_session, pending_decision)
VALUES ('F4', '2026-07-09', 10850, 12000, 10000, 16000, '2026-07-10', true);

INSERT INTO book_targets (strategy_id, session_date, rank, symbol, weight, last_price, limit_price, stop_price, take_price, explanation) VALUES
  ('F4', '2026-07-10', 1, 'NVDA', 0.5, 500, NULL, NULL, NULL, 'kept'),
  ('F4', '2026-07-10', 2, 'TSLA', 0.5, 250, NULL, NULL, NULL, 'new'),
  ('F4', '2026-07-01', 1, 'OLDT', 1,   10,  NULL, NULL, NULL, 'stale');

INSERT INTO fx_rates (date, usd_idr) VALUES ('2026-07-08', 16300), ('2026-07-09', 16350);
`;

async function seedPostgres(): Promise<void> {
  await truncateSystem('seer');
  await seedSystem('seer', SEED_SQL);
}

// ---------------------------------------------------------------- lab.sqlite seed (local helper)

/* Lab rows go into the tables phase 1's makeLab() created (the real lab column names, CHECKs and triggers dropped). */

interface LabMethod {
  id: string;
  name: string;
  family: string;
  status: string;
  hypothesis: string;
}

interface LabTrial {
  n: number;
  method_id: string;
  candidate_id: string;
  window: 'dev' | 'test';
  mar: number | null;
  eligible: 0 | 1;
  total_return?: number;
  spy_tr_return?: number;
  profit_factor?: number;
  trades?: number;
  dsr?: number;
  n_trials_at_run?: number;
  failed?: string;
}

const LONG_HYPOTHESIS = `Wider books survive drawdowns better. ${'Momentum across thirty-five names spreads single-name risk. '.repeat(8)}`;

const LAB_METHODS: LabMethod[] = [
  { id: 'M9001', name: 'Momentum width', family: 'momentum', status: 'dev-eligible', hypothesis: LONG_HYPOTHESIS },
  { id: 'M9002', name: 'Value tilt', family: 'value', status: 'rejected', hypothesis: 'Cheap stocks beat expensive ones.' },
  { id: 'M9003', name: 'Idea only', family: 'misc', status: 'idea', hypothesis: 'Not run yet.' },
];

const LAB_TRIALS: LabTrial[] = [
  { n: 9001, method_id: 'M9001', candidate_id: 'M9001-A', window: 'dev', mar: 0.5, eligible: 0 },
  {
    n: 9002, method_id: 'M9001', candidate_id: 'M9001-B', window: 'dev', mar: 0.8, eligible: 1,
    total_return: 0.5, spy_tr_return: 0.3, profit_factor: 1.5, trades: 120, dsr: 0.93, n_trials_at_run: 88,
  },
  { n: 9003, method_id: 'M9001', candidate_id: 'M9001-C', window: 'dev', mar: 0.8, eligible: 1 },
  { n: 9004, method_id: 'M9001', candidate_id: 'M9001-D', window: 'dev', mar: null, eligible: 0 },
  { n: 9005, method_id: 'M9001', candidate_id: 'M9001-B', window: 'test', mar: 0.4, eligible: 0 },
  {
    n: 9006, method_id: 'M9002', candidate_id: 'M9002-A', window: 'dev', mar: 0.9, eligible: 0,
    total_return: 0.2, spy_tr_return: 0.3, profit_factor: 1.1, trades: 50, failed: 'PF >= 1.3; trades >= 100',
  },
  { n: 9007, method_id: 'M9002', candidate_id: 'M9002-B', window: 'dev', mar: 0.3, eligible: 1 },
];

const LAB_FUNDING = [{ trial_n: 9006, mwr: 0.1, spy_tr_mwr: 0.05 }];

function writeLab(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const method = db.prepare(
      `INSERT INTO methods (id, name, family, source_kind, source_ref, hypothesis, status, analysis, verdict, blocked_on, created, updated)
       VALUES (?, ?, ?, 'seed', '', ?, ?, '', '', '', '2026-10-01', '2026-10-01')`,
    );
    for (const m of LAB_METHODS) method.run(m.id, m.name, m.family, m.hypothesis, m.status);
    const trial = db.prepare(
      `INSERT INTO trials (n, method_id, candidate_id, config_digest, config_text, rules_id, allocator_id, window, start, "end",
         store_fingerprint, git_sha, run_at, total_return, cagr, max_drawdown, profit_factor, trades, sharpe, spy_tr_return,
         spy_tr_cagr, mar, failed, eligible, dsr, n_trials_at_run, curve_json)
       VALUES (?, ?, ?, ?, '{}', 'rules', 'alloc', ?, ?, ?, 'fp', 'sha', '2026-10-01 12:00:00', ?, 0.1, 0.2, ?, ?, 1.1, ?,
         0.07, ?, ?, ?, ?, ?, '[]')`,
    );
    for (const t of LAB_TRIALS) {
      trial.run(
        t.n,
        t.method_id,
        t.candidate_id,
        `digest-${t.n}`,
        t.window,
        t.window === 'dev' ? '1996-01-03' : '2015-10-19',
        t.window === 'dev' ? '2015-10-16' : '2024-12-31',
        t.total_return ?? 0.4,
        t.profit_factor ?? 1.4,
        t.trades ?? 150,
        t.spy_tr_return ?? 0.3,
        t.mar,
        t.failed ?? '',
        t.eligible,
        t.dsr ?? 0.91,
        t.n_trials_at_run ?? 80,
      );
    }
    const funding = db.prepare(
      `INSERT INTO trial_funding (trial_n, mwr, spy_tr_mwr, deposits_usd, deposits_n, schedule, measured)
       VALUES (?, ?, ?, 1000, 12, 'monthly', '2026-10-01')`,
    );
    for (const f of LAB_FUNDING) funding.run(f.trial_n, f.mwr, f.spy_tr_mwr);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- seer connector over the seeded DB + temp lab

function seerConnector(): Connector {
  const lab = makeLab(); // phase 1: { path, dir }, tables already created
  writeLab(lab.path);
  return connectorFor('seer', { labPath: lab.path });
}

// ---------------------------------------------------------------- MCP client

async function connect(connector: Connector): Promise<Client> {
  const server = new McpServer({ name: 'seer-curated-int', version: '0.0.0' });
  registerSeerCurated(server, connector);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'seer-curated-int-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function text(result: unknown): string {
  const first = (result as CallToolResult).content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describeWithRepo('seer', 'seer curated tools', () => {
  let client: Client;

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(text(result));
    return JSON.parse(text(result)) as T;
  }

  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError).toBe(true);
    return text(result);
  }

  beforeAll(async () => {
    await seedPostgres();
    client = await connect(seerConnector());
  });

  afterAll(async () => {
    await client?.close();
    cleanupHarness();
  });

  // ------------------------------------------------------------ seer_leaderboard

  it('seer_leaderboard ranks over the common window by Sharpe, like the app', async () => {
    const board = await call<SeerLeaderboard>('seer_leaderboard');
    expect(board.window).toEqual({ from: '2026-05-01', to: '2026-07-09', sessions: 70 });
    expect(board.min_common_sessions).toBe(63);
    expect(board.shared_sessions).toBe(10);
    expect(board.ranked.map((e) => [e.rank, e.id])).toEqual([
      [1, 'A'],
      [2, 'F4'],
    ]);
    const [a, f4] = board.ranked as [BoardEntry, BoardEntry];
    // F4 returned more but is noisier: Sharpe decides.
    expect(f4.window!.total_return!).toBeGreaterThan(a.window!.total_return!);
    expect(a.window!.sharpe!).toBeGreaterThan(f4.window!.sharpe!);
    expect(a).toMatchObject({
      name: 'A · Quant',
      engine: 'bracket',
      paper_start: '2026-05-01',
      sessions: 70,
      days: 69,
      as_of: '2026-07-09',
      current_equity_usd: 11385,
    });
    expect(a.since_start).toMatchObject({ total_return: 0.1385, trades: 3, win_rate: 0.6667, profit_factor: 4 });
    expect(f4.since_start).toMatchObject({ trades: 2, win_rate: 0.5, profit_factor: 'infinite' });
  });

  it('seer_leaderboard lists the benchmark, retired and too-new strategies separately', async () => {
    const board = await call<SeerLeaderboard>('seer_leaderboard');
    const reasons = Object.fromEntries(board.not_ranked.map((e) => [e.id, e.not_ranked_reason ?? '']));
    expect(Object.keys(reasons)).toEqual(['SPY', 'NEW', 'OLD']);
    expect(reasons.SPY).toMatch(/^benchmark/);
    expect(reasons.NEW).toMatch(/^insufficient/);
    expect(reasons.OLD).toMatch(/^retired \(last traded 2026-05-30\)/);
    const spy = board.not_ranked.find((e) => e.id === 'SPY')!;
    expect(spy.window?.total_return).toBe(0.069);
    expect(spy.since_start.trades).toBe(0);
  });

  // ------------------------------------------------------------ seer_positions

  it('seer_positions lists open bracket orders and book positions with marks and P&L', async () => {
    const out = await call<SeerPositions>('seer_positions');
    expect(out.currency).toBe('USD');
    expect(out.fx).toEqual({ date: '2026-07-09', usd_idr: 16350 });
    expect(out.truncated).toBe(false);
    expect(out.strategies.map((s) => s.id)).toEqual(['SPY', 'A', 'F4', 'NEW']);
    const byId = new Map(out.strategies.map((s) => [s.id, s] as const));

    const a = byId.get('A') as StrategyPositions;
    expect(a.pending).toBeUndefined();
    expect(a.equity_usd).toBe(11385);
    expect(a.bracket.map((h) => [h.symbol, h.mark, h.mark_source, h.unrealised_pnl_usd])).toEqual([
      ['AAPL', 110, 'latest close 2026-07-09', 100],
      ['MSFT', 50, 'order mark', 50],
      ['XYZ', 20, 'fill price', 0],
    ]);
    expect(a.bracket[0]).toMatchObject({ value_usd: 1100, day: 3, max_days: 5, weight: 0.0966, unrealised_pnl_pct: 0.1 });
    expect(a.open_value_usd).toBe(1410);
    expect(a.unrealised_pnl_usd).toBe(150);
    expect(a.book).toEqual([]);

    const f4 = byId.get('F4') as StrategyPositions;
    expect(f4.equity_usd).toBe(12000);
    expect(f4.book.map((h) => h.symbol)).toEqual(['NVDA', 'AMD']);
    expect(f4.book[0]).toMatchObject({
      kind: 'book', value_usd: 1000, cost_usd: 900, income_usd: 10, unrealised_pnl_usd: 110, unrealised_pnl_pct: 0.1222, weight: 0.0833,
    });
    expect(f4.book[1]?.exit_pending).toBe(true);

    expect(byId.get('SPY')?.book[0]).toMatchObject({ kind: 'benchmark', symbol: 'SPY', value_usd: 6000, unrealised_pnl_usd: 200 });
    expect(byId.get('NEW')).toMatchObject({ bracket: [], book: [], open_value_usd: 0 });
  });

  it('seer_positions adds pending orders and the pending book decision on request', async () => {
    const out = await call<SeerPositions>('seer_positions', { include_pending: true });
    const byId = new Map(out.strategies.map((s) => [s.id, s] as const));
    expect(byId.get('A')?.pending?.orders.map((o) => [o.symbol, o.limit_price, o.shares])).toEqual([['PEND', 29.5, 4]]);
    expect(byId.get('F4')?.pending).toMatchObject({ session_date: '2026-07-10', decision: true });
    expect(byId.get('F4')?.pending?.targets.map((t) => [t.rank, t.symbol, t.weight])).toEqual([
      [1, 'NVDA', 0.5],
      [2, 'TSLA', 0.5],
    ]);
  });

  it('seer_positions filters to one strategy, case-insensitively, and rejects unknown ids', async () => {
    const one = await call<SeerPositions>('seer_positions', { strategy: 'f4' });
    expect(one.strategies.map((s) => s.id)).toEqual(['F4']);
    expect(await callError('seer_positions', { strategy: 'NOPE' })).toContain('seer has no strategy "NOPE"');
  });

  // ------------------------------------------------------------ seer_sera_best

  const ours = (r: SeraBest): SeraMethodBest[] => r.methods.filter((m) => m.id.startsWith('M90'));

  it('seer_sera_best picks the best dev trial per method by MAR, ties to the lower n', async () => {
    const r = await call<SeraBest>('seer_sera_best');
    expect(r.source).toBe('lab.sqlite');
    expect(r.filters).toEqual({ limit: 25, status: null, only_eligible: false });
    expect(r.eligibility_note).toContain('DSR is not re-derived');
    const methods = ours(r);
    expect(methods.map((m) => [m.id, m.best.candidate_id, m.best.n])).toEqual([
      ['M9002', 'M9002-A', 9006],
      ['M9001', 'M9001-B', 9002],
    ]);

    const [m2, m1] = methods as [SeraMethodBest, SeraMethodBest];
    expect(m1).toMatchObject({ name: 'Momentum width', family: 'momentum', status: 'dev-eligible', dev_trials: 4 });
    expect(m1.hypothesis.length).toBeLessThanOrEqual(280);
    expect(m1.hypothesis.endsWith('…')).toBe(true);
    expect(m1.best).toMatchObject({
      eligible_at_run: true, total_return: 0.5, spy_tr_return: 0.3, profit_factor: 1.5, trades: 120, mar: 0.8, dsr: 0.93,
      n_trials_at_run: 88, start: '1996-01-03', end: '2015-10-16', funding: null,
    });
    expect(m1.best.hurdles).toEqual({
      beats_spy: true, beats_spy_basis: 'total return', profit_factor_ge_1_3: true, trades_ge_100: true,
    });
    expect(m1.test_trials.map((t) => [t.n, t.candidate_id])).toEqual([[9005, 'M9001-B']]);

    expect(m2.best).toMatchObject({ eligible_at_run: false, failed_at_run: 'PF >= 1.3; trades >= 100', funding: { mwr: 0.1, spy_tr_mwr: 0.05 } });
    expect(m2.best.hurdles).toEqual({
      beats_spy: true, beats_spy_basis: 'money-weighted', profit_factor_ge_1_3: false, trades_ge_100: false,
    });
    expect(m2.test_trials).toEqual([]);
  });

  it('seer_sera_best filters by stored eligibility, status and limit', async () => {
    const eligible = ours(await call<SeraBest>('seer_sera_best', { only_eligible: true }));
    expect(eligible.map((m) => [m.id, m.best.candidate_id])).toEqual([
      ['M9001', 'M9001-B'],
      ['M9002', 'M9002-B'],
    ]);
    const rejected = ours(await call<SeraBest>('seer_sera_best', { status: 'rejected' }));
    expect(rejected.map((m) => m.id)).toEqual(['M9002']);
    const one = await call<SeraBest>('seer_sera_best', { limit: 1 });
    expect(one.methods).toHaveLength(1);
  });
});
```
**Impact:** adds a test file to the integration run. It shares the seer test DB with phase 1's generic seer int test, which asserts only types and refusals, never row counts. Files run one at a time (`fileParallelism: false`), and this one truncates before seeding.

## Verification

**Setup:** the worktree has no `node_modules`. Run `npm ci` at the worktree root before any other command.
**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/connectors/seer.*.test.ts`), then `npm run test:int` (includes `tests/integration/connectors/seer.curated.int.test.ts`; it skips with a message when `~/seer` is absent)
**Manual check:** With notesd running against the real `~/seer`:
- Call `seer_leaderboard` through `/n` or the MCP inspector. The ranked order and window should match the Leaderboard page of the Seer app (`npm run dev` in `~/seer/web`, `/leaderboard`).
- `seer_positions` should match the Positions page per strategy.
- `seer_sera_best` should list the same best candidate per method as `lab status`'s best-by-MAR. A method whose stored `eligible` differs from today's live verdict shows that difference only in `eligible_at_run`, which is expected and noted.
- Nothing is written to `~/seer` or `lab.sqlite`: the `lab.sqlite` mtime stays unchanged.
**Exit criteria:**
- `tools/list` shows `seer_leaderboard`, `seer_positions` and `seer_sera_best`.
- On seeded data, `seer_leaderboard` ranks A over F4 over the 70-session window by Sharpe. It lists SPY, NEW and OLD under `not_ranked` with reasons and leaves out GONE.
- `seer_positions` returns the marks `110 / 50 / 20` with their sources, and book P&L `value + income − cost`.
- `seer_sera_best` returns M9002-A and M9001-B (MAR order, tie to lower n), with stored `eligible_at_run`, funding-based beats-SPY, test trials, and working filters.
- Typecheck and both suites are green.

## Handoffs

- **Reconciled with phase 1:** the int test uses phase 1's exact harness (`makeLab()` → `{ path, dir }` with the lab tables, `connectorFor('seer', { labPath })`, `seedSystem`, `cleanupHarness`). Phase 1's lab runner takes positional `?` params and wraps the SQL as a subquery, which `BEST_SQL` (window function + `LIMIT ?`) survives. A `ConnectorError` renders bare, a plain `Error` as `error: …`; the tests use `toContain`. Phase 1's tool-list tests do not count tools, so this phase lands in any order relative to phases 2 and 3.
- **README / instructions paragraph:** phase 1 writes the `seer_*` rows with this phase's inputs (`strategy`, `include_pending`; `status`, `only_eligible`, `limit`) and the "eligible as of run date" caveat. This phase does not edit README or `instructions.ts`.
- **Phase 5 (captions):** no work needed. The three names are already in `ALL_CONNECTOR_TOOL_NAMES` and caption as "reading seer".
- **Not done (out of scope for R2 as decided):** re-deriving DSR at the current N (Decisions table: "DSR not re-derived"), the go-live checklist (`metrics.ts checklist`), the monthly sheet and Sean's real trades (`sean_*`). Any of these can be a later iteration's curated tool. `seer_sql` covers ad-hoc reads now.

## Rollback

Revert this phase's commit. `src/connectors/seer/curated.ts` returns to the phase-1 no-op stub. The five new `src/connectors/seer/*.ts` files and four test files disappear. Nothing else references them: phase 1's `register.ts` only imports `registerSeerCurated`, whose signature is unchanged, and phase 5 reads tool names from `names.ts`. Nothing is migrated, and no data anywhere changes.
