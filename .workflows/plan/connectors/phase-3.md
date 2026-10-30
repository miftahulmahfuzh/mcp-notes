# Phase 3: run-insights curated tools

**Plan set:** `CONNECTORS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-124712-C5N7_code_analyzer.md`
**Satisfies:** R2, R5 — `runs_list`, `runs_get`, `runs_review` answer "how did my run go", "this month vs last month" and "how was my week" in one call each, in the app's units with readable companions; covered by unit and Docker integration tests
**Depends on:** Phase 1
**Difficulty:** NORMAL
**Package:** `src/connectors/runs`

---

## Goal

After this phase the `notes` MCP server exposes three curated run-insights tools in place of phase 1's no-op stub: `runs_list` (reviewed runs in a WIB day range with key metrics, the app's per-run insight headline, and period totals), `runs_get` (one run by id, or every run on a day, with splits, HR zones, note, review flag, the app's full latest session analysis and the profile's max/resting HR) and `runs_review` (the app's latest week/month review for a period plus that period's totals and runs). Every read is a parameterised SELECT through `connector.query` (read-only, capped, timed out by phase 1), mirroring the app's own query semantics.

## Interface Contract

**Deletes:** nothing. (The phase-1 stub body of `registerRunsCurated` is replaced; the export survives.)
**Renames:** none
**Creates:**
- `registerRunsCurated` body (`src/connectors/runs/curated.ts`) registering MCP tools `runs_list`, `runs_get`, `runs_review`; plus exported handler functions `runsList`, `runsGet`, `runsReview` in the same file
- `src/connectors/runs/format.ts`: `toNumber`, `toText`, `metresToKm`, `formatDuration`, `formatPace`, `avgPaceSecPerKm`, `hrDrop1Min`, `formatZoneRange`, `percentOf`
- `src/connectors/runs/periods.ts`: `WIB_TIME_ZONE`, `PeriodScope`, `Period`, `isRealDate`, `addDays`, `todayInWib`, `isoWeekKeyOf`, `isoWeekRange`, `monthRange`, `resolvePeriod`, `resolveRange`
- `src/connectors/runs/queries.ts`: `RUNS_MAX_ROWS`, `rowsToObjects`, SQL constants (`LIST_RUNS_SQL`, `PERIOD_TOTALS_SQL`, `RUN_BY_ID_SQL`, `RUNS_BY_DATE_SQL`, `SPLITS_SQL`, `ZONES_SQL`, `SESSION_INSIGHTS_SQL`, `PERIOD_INSIGHT_SQL`, `PROFILE_SQL`), output types (`RunMetrics`, `RunListItem`, `PeriodTotals`, `SplitOut`, `ZoneOut`, `InsightOut`, `InsightObservation`, `RunDetail`, `RunBrief`), mappers (`runMetrics`, `runListItem`, `runBrief`, `periodTotals`, `splitOut`, `zonesOut`, `insightOut`, `compareListOrder`) and reads (`listRuns`, `readPeriodTotals`, `readRunDetails`, `readRunRowsById`, `readRunRowsByDate`, `readPeriodInsight`)
- Tests: `tests/unit/connectors/runs.format.test.ts`, `tests/unit/connectors/runs.periods.test.ts`, `tests/unit/connectors/runs.curated.test.ts`, `tests/integration/connectors/runs.curated.int.test.ts`

**Signature changes:** none. `registerRunsCurated(server: McpServer, connector: Connector): void` keeps the exact phase-1 signature.

**Tool input/output contract (for phase 5 captions/prompt and the README):**
- `runs_list({ from: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' (default today WIB) })` → `{ from, to, totals: PeriodTotals, runs: RunListItem[], truncated }`
- `runs_get({ id?: string, date?: 'YYYY-MM-DD' })` (exactly one) → `{ id | date, runs: RunDetail[], profile: { max_hr, resting_hr } | null }`; unknown id is a tool error, a day with no runs is `runs: []`
- `runs_review({ scope: 'week'|'month', key?: 'YYYY-Www'|'YYYY-MM'|'YYYY-MM-DD' (default: period containing today WIB) })` → `{ scope, key, from, to, review: InsightOut | null, review_missing: string | null, totals: PeriodTotals, runs: RunBrief[] }`

**Requires (from earlier phases):**
- `src/connectors/types.ts` exports `Connector` and `QueryResult` exactly as the index contract states (`query(sql, params?, { maxRows? })` → `{ columns, rows: unknown[][], row_count, truncated }`), and `query` wraps the statement as `SELECT * FROM (<sql>) AS q LIMIT <cap+1>` inside `BEGIN READ ONLY` with `TimeZone=Asia/Jakarta` (Phase 1). Our SQL is written to be valid as such a subquery: no trailing semicolon, unique output column names, block comments only.
- `src/connectors/names.ts` exports `CONNECTOR_TOOL_NAMES` with `runs: [..., 'runs_list', 'runs_get', 'runs_review']` (Phase 1). Used by the unit test only.
- `src/mcp/tools.ts` exports `run(fn, options?: { compact?: boolean }): Promise<CallToolResult>` (Phase 1); every handler here passes `{ compact: true }`. A thrown `ConnectorError` renders as its bare message, any other `Error` as `error: <message>`; tests use `toContain`, so both pass.
- `src/connectors/rows.ts` exports `toObjects(result)` (Phase 1). This phase uses it under the local alias `rowsToObjects` instead of its own copy.
- `src/connectors/register.ts` calls `registerRunsCurated(server, connector)` with the runs connector (Phase 1).
- `src/connectors/runs/curated.ts` exists as a stub exporting `registerRunsCurated` (Phase 1). This phase overwrites the whole file.
- `tests/integration/connectors/harness.ts` exports (Phase 1, exact): `describeWithRepo(id, name, fn)` (sync), `systemDbUrl(id): string` (sync, writable admin URL of `connectors_runs`, built from run-insights' drizzle migrations on `pgvector/pgvector:pg16`, so 0023's `CREATE EXTENSION vector` works), `withAdmin(url, fn)` (async, refuses Neon), `truncateSystem(id): Promise<void>`, `connectorFor(id): Connector` (sync) and `cleanupHarness(): void`.
- `vitest.config.ts` integration mode includes `tests/integration/**/*.int.test.ts` (already true today; phase 1 must keep it so subdirectories are picked up).

**Leaves alone (owned by others):** `src/connectors/{names,types,register,env,pg,guard,lab,errors,schema,sql}.ts` and `src/connectors/runs/index.ts` (Phase 1), `src/mcp/**` (Phase 1), `tests/integration/connectors/{harness,globalSetup}.ts` and generic connector tests (Phase 1), `scripts/test-int.sh`, `vitest.config.ts`, `package.json`, README (Phase 1/5), `src/connectors/expenses/**` (Phase 2), `src/connectors/seer/**` (Phase 4), `src/chat/**`, `claude/**` (Phase 5), `web/**` (Phase 6). Nothing in `~/run-insights` is written or imported.

## Files

| File | Action | What changes |
|---|---|---|
| `src/connectors/runs/curated.ts` | modify (full replace of the phase-1 stub, line 1 to end) | registers `runs_list`, `runs_get`, `runs_review`; exports their handler functions |
| `src/connectors/runs/format.ts` | create | pure unit/format helpers (pace, duration, km, HR drop, zone range, percent, driver coercion) |
| `src/connectors/runs/periods.ts` | create | WIB today, real-day check, ISO week key/range, month range, period/range resolution |
| `src/connectors/runs/queries.ts` | create | parameterised SQL, row-to-output mapping, read functions |
| `tests/unit/connectors/runs.format.test.ts` | create | unit tests for `format.ts` |
| `tests/unit/connectors/runs.periods.test.ts` | create | unit tests for `periods.ts` |
| `tests/unit/connectors/runs.curated.test.ts` | create | registers the tools on an in-memory MCP server with a fake connector; shapes, validation, error path |
| `tests/integration/connectors/runs.curated.int.test.ts` | create | the three tools against the phase-1 Docker DB built from run-insights migrations, seeded locally |

## Semantics mirrored from ~/run-insights (read, never imported)

| App rule | Source | How this phase applies it |
|---|---|---|
| `runs.reviewed_at IS NOT NULL` gates every aggregate and list | `lib/db/schema.ts` header; `lib/db/queries/runs.ts` `listRuns`, `listRunsWithPhotoCounts`; `rollups.ts` | `runs_list`, all totals, `runs_review`'s run list. `runs_get` is draft-visible like `getRunDetail`, flagged `reviewed` |
| List order `occurred_on DESC, started_at DESC` | `lib/db/queries/runs.ts:334` | SQL `ORDER BY` + `compareListOrder` re-sort in TS (NULL start first, as Postgres DESC does) because the connector wraps the statement |
| Splits by km, partial final km stored and shown | `schema/runs.ts` `run_splits`, `getRunDetail` | `partial` flag per split, ordered by km |
| Zones 1..5; zone 1 has no floor, zone 5 no ceiling | `schema/runs.ts` `run_zones` | `range` companion `< max bpm` / `> min bpm`, `pct` of zone time |
| Newest insight per (scope, scope_key) wins | `lib/db/queries/insights.ts:49` `getLatestInsight` | `LATERAL ... ORDER BY created_at DESC LIMIT 1`, `DISTINCT ON (scope_key)`, `ORDER BY created_at DESC LIMIT 1` |
| Insight payload `{headline, verdict, whatHappened, observations[{title,detail,metric}], doNext[], questionForRunner}` + `hrMaxUsed`/`hrMaxSource` on session rows | `lib/llm/schema.ts:33-63` | `insightOut` maps to snake_case; HR-max fields only when present (session rows) |
| Week = ISO 8601 `YYYY-Www` Monday..Sunday; month `YYYY-MM`; ranges over `occurred_on` | `lib/date/ranges.ts:83-115` | `isoWeekKeyOf` / `isoWeekRange` / `monthRange` re-implemented in `periods.ts` (inclusive `to` = endExclusive - 1 day) |
| Period pace = summed duration / summed distance, whole seconds | `lib/metrics/pace.ts` `avgPaceSecPerKm` | `avgPaceSecPerKm` (null instead of 0 when there is no distance) |
| Units: metres, seconds, sec/km, bpm | `lib/db/schema.ts` header | raw integers kept; companions `km` (2 dp), `duration` `h:mm:ss`, `avg_pace` `m:ss /km` |

Choices this phase makes on its own (not in the app): period `avg_hr` is the **duration-weighted** mean of per-run `avg_hr` over runs that have one (a true time average; the app has no period HR average); `hr_drop_1min` = `end_hr_bpm - hr_1min_post_bpm` (the app's `hrRecovery1MinBpm`, `lib/metrics/types.ts:105`); the profile in `runs_get` is the owner of the first returned run (no user filter otherwise, per plan decision).

## Implementation Steps

### Step 1: Unit and format helpers
**File:** `src/connectors/runs/format.ts:1` (new)
**Change:** Pure helpers. No imports.
**Code:**
```ts
/**
 * Pure unit helpers for the run-insights curated tools.
 *
 * run-insights stores integers in the smallest sensible unit (metres, seconds, sec/km, bpm). The
 * tools return those raw integers unchanged and add a human-readable companion next to each, so
 * Claude can quote "5.23 km at 5:44 /km" without doing arithmetic and still compare raw numbers.
 *
 * These are re-implementations, not imports: run-insights is a separate project and its code is
 * never imported here.
 */

/** Coerces a driver value (number, numeric/int8 string, bigint) to a finite number, else null. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A driver value as a string, else null. */
export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 5230 -> 5.23. Two decimals, which is what the app shows. */
export function metresToKm(metres: number | null): number | null {
  if (metres === null) return null;
  return Math.round(metres / 10) / 100;
}

/** 1800 -> "0:30:00", 3725 -> "1:02:05". Always h:mm:ss, so it never reads as a pace. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return `${hours}:${pad2(minutes)}:${pad2(s % 60)}`;
}

/** 344 -> "5:44 /km". Null for a missing or non-positive pace. */
export function formatPace(secPerKm: number | null): string | null {
  if (secPerKm === null || !Number.isFinite(secPerKm) || secPerKm <= 0) return null;
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${pad2(s % 60)} /km`;
}

/**
 * Whole-period pace: summed duration over summed distance, rounded to whole seconds per km. This
 * is the app's own rule for week and month averages (a distance-weighted pace), not a mean of
 * per-run paces. Null when there is no distance (the app shows 0; null is clearer to Claude).
 */
export function avgPaceSecPerKm(distanceM: number, durationSec: number): number | null {
  if (!(distanceM > 0)) return null;
  return Math.round(durationSec / (distanceM / 1000));
}

/** Heart-rate drop in the first minute after the run (end HR minus HR one minute later). Bigger is better. */
export function hrDrop1Min(endHr: number | null, oneMinHr: number | null): number | null {
  if (endHr === null || oneMinHr === null) return null;
  return endHr - oneMinHr;
}

/** Zone bounds as Apple prints them: zone 1 has no floor, zone 5 has no ceiling. */
export function formatZoneRange(minBpm: number | null, maxBpm: number | null): string | null {
  if (minBpm === null && maxBpm === null) return null;
  if (minBpm === null) return `< ${maxBpm} bpm`;
  if (maxBpm === null) return `> ${minBpm} bpm`;
  return `${minBpm}-${maxBpm} bpm`;
}

/** part/whole as a percentage with one decimal; null when whole is 0. */
export function percentOf(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 1000) / 10;
}
```
**Impact:** none outside this directory.

### Step 2: Calendar helpers (WIB, ISO weeks, months)
**File:** `src/connectors/runs/periods.ts:1` (new)
**Change:** Pure helpers. `resolvePeriod` accepts a week key, a month key, or any day inside the period; uppercases so `2026-w44` works; rejects a week 53 the year does not have.
**Code:**
```ts
/**
 * Calendar helpers for the run-insights curated tools: WIB days, ISO weeks, months.
 *
 * run-insights keys its week reviews 'YYYY-Www' (ISO 8601, Monday to Sunday, week 1 holds the
 * year's first Thursday) and its month reviews 'YYYY-MM', both over `runs.occurred_on`, which is
 * an Asia/Jakarta calendar day. Everything here is integer/UTC arithmetic on day strings, so no
 * host timezone can shift a day. Re-implemented here; run-insights code is never imported.
 */

export const WIB_TIME_ZONE = 'Asia/Jakarta';

const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;

export type PeriodScope = 'week' | 'month';

export interface Period {
  scope: PeriodScope;
  /** 'YYYY-Www' or 'YYYY-MM': the app's insights.scope_key for this period. */
  key: string;
  /** First day, inclusive, 'YYYY-MM-DD'. */
  from: string;
  /** Last day, inclusive, 'YYYY-MM-DD'. */
  to: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function toISO(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function utcDay(dateISO: string): Date {
  return new Date(`${dateISO}T00:00:00Z`);
}

/** True for a 'YYYY-MM-DD' string naming a day that exists ('2026-02-30' is false). */
export function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  return toISO(utcDay(value)) === value;
}

/** addDays('2026-10-31', 1) === '2026-11-01'. */
export function addDays(dateISO: string, days: number): string {
  const d = utcDay(dateISO);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}

/** Today's calendar day in WIB, 'YYYY-MM-DD'. */
export function todayInWib(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WIB_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The ISO week key that owns a day: the Thursday of the day's week decides the week-year. */
export function isoWeekKeyOf(dateISO: string): string {
  const d = utcDay(dateISO);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - dow + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.floor((thursday.getTime() - jan1.getTime()) / (7 * 86_400_000)) + 1;
  return `${pad(isoYear, 4)}-W${pad(week)}`;
}

/** First (Monday) and last (Sunday) day of an ISO week key, both inclusive. */
export function isoWeekRange(key: string): { from: string; to: string } {
  const m = WEEK_RE.exec(key);
  if (!m) throw new RangeError(`"${key}" is not an ISO week like 2026-W34`);
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Dow + (week - 1) * 7);
  const from = toISO(monday);
  // Week 53 only exists in some years; '2025-W53' would silently be 2026-W01.
  if (isoWeekKeyOf(from) !== key) throw new RangeError(`${isoYear} has no ISO week ${m[2]}`);
  return { from, to: addDays(from, 6) };
}

/** First and last day of a 'YYYY-MM' month, both inclusive. */
export function monthRange(key: string): { from: string; to: string } {
  if (!MONTH_RE.test(key)) throw new RangeError(`"${key}" is not a month like 2026-08`);
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const next = new Date(Date.UTC(y, m, 1)); // month m is 1-based, so this is the next month's 1st
  return { from: `${key}-01`, to: addDays(toISO(next), -1) };
}

/**
 * Resolves a review period from a key: 'YYYY-Www' (week), 'YYYY-MM' (month), or any 'YYYY-MM-DD'
 * inside the period. No key means the period that contains today (WIB).
 */
export function resolvePeriod(scope: PeriodScope, key: string | undefined, now: Date = new Date()): Period {
  const raw = (key ?? '').trim().toUpperCase() || todayInWib(now);
  if (scope === 'week') {
    let weekKey: string;
    if (WEEK_RE.test(raw)) weekKey = raw;
    else if (isRealDate(raw)) weekKey = isoWeekKeyOf(raw);
    else throw new RangeError(`"${key}" is not an ISO week like 2026-W34 or a date like 2026-08-20`);
    return { scope, key: weekKey, ...isoWeekRange(weekKey) };
  }
  let monthKey: string;
  if (MONTH_RE.test(raw)) monthKey = raw;
  else if (isRealDate(raw)) monthKey = raw.slice(0, 7);
  else throw new RangeError(`"${key}" is not a month like 2026-08 or a date like 2026-08-20`);
  return { scope, key: monthKey, ...monthRange(monthKey) };
}

/** Validates an inclusive day range; `to` defaults to today (WIB). */
export function resolveRange(from: string, to: string | undefined, now: Date = new Date()): { from: string; to: string } {
  const end = to ?? todayInWib(now);
  if (!isRealDate(from)) throw new RangeError(`from "${from}" is not a real day (YYYY-MM-DD)`);
  if (!isRealDate(end)) throw new RangeError(`to "${end}" is not a real day (YYYY-MM-DD)`);
  if (from > end) throw new RangeError(`from ${from} is after to ${end}`);
  return { from, to: end };
}
```
**Impact:** none outside this directory.

### Step 3: SQL, mapping and reads
**File:** `src/connectors/runs/queries.ts:1` (new)
**Change:** Every statement is a single SELECT, parameterised, starting with a `/* runs:<name> */` tag (used by the unit-test fake and visible in `pg_stat_activity`). Dates, times and timestamps are `::text` in SQL (phase 1 returns them as text anyway, so the cast only pins the format); numbers go through `toNumber` so `int8`/`numeric` strings also work (verified both ways, see Verification). In SQL, `ORDER BY` uses table-qualified names (`r.started_at`, `i.created_at`) so it sorts on the real column, not the `::text` output alias. `readRunDetails` issues splits/zones/insights/profile in parallel (one fresh connection each) to keep `runs_get` to two round trips over Neon.
**Code:**
```ts
/**
 * SQL and result shaping for the run-insights curated tools (runs_list, runs_get, runs_review).
 *
 * Semantics mirror the app (read from ~/run-insights, never imported):
 *   - `runs.reviewed_at IS NOT NULL` gates every list and aggregate (lib/db/schema.ts header);
 *     runs_get shows unreviewed runs too, flagged `reviewed: false`, like the app's /r/[id].
 *   - Lists are ordered `occurred_on DESC, started_at DESC` (lib/db/queries/runs.ts listRuns).
 *   - Splits by km with the final partial km flagged, zones 1..5 (getRunDetail).
 *   - The newest `insights` row per (scope, scope_key) wins (lib/db/queries/insights.ts
 *     getLatestInsight); session rows are keyed by run id, week by 'YYYY-Www', month by 'YYYY-MM'.
 *   - Period pace = summed duration / summed distance (lib/metrics/pace.ts).
 * No user_id filter: each app has one owner (plan decision).
 *
 * Every statement is one parameterised SELECT run through `connector.query`, which wraps it as a
 * subquery under a row cap inside a read-only transaction. Dates, times and timestamps are cast
 * to text in SQL so the output does not depend on driver type parsers. Each statement starts with
 * a block comment naming it, which shows up in pg_stat_activity and lets unit tests route a fake.
 */
import { toObjects } from '../rows.js';
import type { Connector } from '../types.js';
import {
  avgPaceSecPerKm,
  formatDuration,
  formatPace,
  formatZoneRange,
  hrDrop1Min,
  metresToKm,
  percentOf,
  toNumber,
  toText,
} from './format.js';
import type { Period } from './periods.js';

/** Row cap for runs lists: ~200 runs a year, so a multi-year range still fits. */
export const RUNS_MAX_ROWS = 1000;

type Row = Record<string, unknown>;

/** Compact { columns, rows } -> one object per row. Phase 1's helper, under this file's name. */
export const rowsToObjects = toObjects;

const RUN_COLUMNS = `
  r.id,
  r.user_id,
  r.occurred_on::text AS occurred_on,
  r.started_at::text AS started_at,
  r.ended_at::text AS ended_at,
  r.activity_type,
  r.location,
  r.intent,
  r.distance_m,
  r.duration_sec,
  r.avg_pace_sec,
  r.avg_hr,
  r.max_hr,
  r.resting_hr,
  r.avg_cadence,
  r.elevation_m,
  r.active_kcal,
  r.total_kcal,
  r.end_hr_bpm,
  r.hr_1min_post_bpm,
  r.note,
  r.source,
  (r.reviewed_at IS NOT NULL) AS reviewed,
  r.reviewed_at::text AS reviewed_at,
  r.corrected_at::text AS corrected_at`;

export const LIST_RUNS_SQL = `/* runs:list */
SELECT ${RUN_COLUMNS},
  li.payload->>'headline' AS insight_headline,
  li.payload->>'verdict' AS insight_verdict
FROM runs r
LEFT JOIN LATERAL (
  SELECT i.payload FROM insights i
  WHERE i.scope = 'session' AND i.scope_key = r.id
  ORDER BY i.created_at DESC
  LIMIT 1
) li ON true
WHERE r.reviewed_at IS NOT NULL
  AND r.occurred_on >= $1::date
  AND r.occurred_on <= $2::date
ORDER BY r.occurred_on DESC, r.started_at DESC`;

export const PERIOD_TOTALS_SQL = `/* runs:totals */
SELECT
  count(*)::int AS runs,
  count(DISTINCT r.occurred_on)::int AS run_days,
  coalesce(sum(r.distance_m), 0)::bigint AS distance_m,
  coalesce(sum(r.duration_sec), 0)::bigint AS duration_sec,
  coalesce(sum(r.avg_hr::bigint * r.duration_sec) FILTER (WHERE r.avg_hr IS NOT NULL), 0)::bigint AS hr_weighted_sum,
  coalesce(sum(r.duration_sec) FILTER (WHERE r.avg_hr IS NOT NULL), 0)::bigint AS hr_duration_sec,
  max(r.max_hr) AS max_hr,
  max(r.distance_m) AS longest_m,
  sum(r.elevation_m)::bigint AS elevation_m,
  sum(r.active_kcal)::bigint AS active_kcal
FROM runs r
WHERE r.reviewed_at IS NOT NULL
  AND r.occurred_on >= $1::date
  AND r.occurred_on <= $2::date`;

export const RUN_BY_ID_SQL = `/* runs:by_id */
SELECT ${RUN_COLUMNS}
FROM runs r
WHERE r.id = $1`;

export const RUNS_BY_DATE_SQL = `/* runs:by_date */
SELECT ${RUN_COLUMNS}
FROM runs r
WHERE r.occurred_on = $1::date
ORDER BY r.started_at ASC NULLS LAST, r.id ASC`;

export const SPLITS_SQL = `/* runs:splits */
SELECT s.run_id, s.km, s.time_sec, s.pace_sec, s.hr, s.cadence, s.partial
FROM run_splits s
WHERE s.run_id = ANY($1::text[])
ORDER BY s.run_id, s.km`;

export const ZONES_SQL = `/* runs:zones */
SELECT z.run_id, z.zone, z.duration_sec, z.min_bpm, z.max_bpm
FROM run_zones z
WHERE z.run_id = ANY($1::text[])
ORDER BY z.run_id, z.zone`;

export const SESSION_INSIGHTS_SQL = `/* runs:session_insights */
SELECT DISTINCT ON (i.scope_key)
  i.scope_key, i.payload, i.model, i.created_at::text AS generated_at
FROM insights i
WHERE i.scope = 'session' AND i.scope_key = ANY($1::text[])
ORDER BY i.scope_key, i.created_at DESC`;

export const PERIOD_INSIGHT_SQL = `/* runs:period_insight */
SELECT i.scope_key, i.payload, i.model, i.created_at::text AS generated_at
FROM insights i
WHERE i.scope = $1 AND i.scope_key = $2
ORDER BY i.created_at DESC
LIMIT 1`;

export const PROFILE_SQL = `/* runs:profile */
SELECT p.max_hr, p.resting_hr
FROM profiles p
WHERE p.user_id = $1`;

/* ---------------------------------------------------------------------------------------------
 * Output shapes
 * -------------------------------------------------------------------------------------------*/

export interface RunMetrics {
  id: string;
  date: string;
  started_at: string | null;
  activity_type: string | null;
  intent: string | null;
  location: string | null;
  distance_m: number;
  km: number | null;
  duration_sec: number;
  duration: string | null;
  avg_pace_sec: number | null;
  avg_pace: string | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  elevation_m: number | null;
  active_kcal: number | null;
  total_kcal: number | null;
  hr_drop_1min: number | null;
}

export interface RunListItem extends RunMetrics {
  /** Headline and verdict of the newest session insight, or null if the app has none for this run. */
  insight: { headline: string | null; verdict: string | null } | null;
}

export interface PeriodTotals {
  from: string;
  to: string;
  runs: number;
  run_days: number;
  distance_m: number;
  km: number | null;
  duration_sec: number;
  duration: string | null;
  avg_pace_sec: number | null;
  avg_pace: string | null;
  avg_hr: number | null;
  max_hr: number | null;
  longest_run_m: number | null;
  longest_run_km: number | null;
  elevation_m: number | null;
  active_kcal: number | null;
}

export interface SplitOut {
  km: number;
  time_sec: number;
  pace_sec: number;
  pace: string | null;
  hr: number | null;
  cadence: number | null;
  partial: boolean;
}

export interface ZoneOut {
  zone: number;
  duration_sec: number;
  duration: string | null;
  pct: number | null;
  min_bpm: number | null;
  max_bpm: number | null;
  range: string | null;
}

export interface InsightObservation {
  title: string | null;
  detail: string | null;
  metric: string | null;
}

export interface InsightOut {
  headline: string | null;
  verdict: string | null;
  what_happened: string | null;
  observations: InsightObservation[];
  do_next: string[];
  question_for_runner: string | null;
  /** Session insights only: the HRmax the app divided by when it wrote the text. */
  hr_max_used?: number | null;
  hr_max_source?: string | null;
  generated_at: string | null;
  model: string | null;
}

export interface RunDetail extends RunMetrics {
  ended_at: string | null;
  resting_hr: number | null;
  end_hr_bpm: number | null;
  hr_1min_post_bpm: number | null;
  note: string | null;
  source: string | null;
  reviewed: boolean;
  reviewed_at: string | null;
  corrected_at: string | null;
  splits: SplitOut[];
  zones: ZoneOut[];
  insight: InsightOut | null;
}

export interface RunBrief {
  id: string;
  date: string;
  intent: string | null;
  km: number | null;
  duration: string | null;
  avg_pace: string | null;
  avg_hr: number | null;
}

/* ---------------------------------------------------------------------------------------------
 * Row mapping (pure)
 * -------------------------------------------------------------------------------------------*/

export function runMetrics(row: Row): RunMetrics {
  const distance = toNumber(row.distance_m) ?? 0;
  const duration = toNumber(row.duration_sec) ?? 0;
  const pace = toNumber(row.avg_pace_sec);
  return {
    id: String(row.id),
    date: String(row.occurred_on),
    started_at: toText(row.started_at),
    activity_type: toText(row.activity_type),
    intent: toText(row.intent),
    location: toText(row.location),
    distance_m: distance,
    km: metresToKm(distance),
    duration_sec: duration,
    duration: formatDuration(duration),
    avg_pace_sec: pace,
    avg_pace: formatPace(pace),
    avg_hr: toNumber(row.avg_hr),
    max_hr: toNumber(row.max_hr),
    avg_cadence: toNumber(row.avg_cadence),
    elevation_m: toNumber(row.elevation_m),
    active_kcal: toNumber(row.active_kcal),
    total_kcal: toNumber(row.total_kcal),
    hr_drop_1min: hrDrop1Min(toNumber(row.end_hr_bpm), toNumber(row.hr_1min_post_bpm)),
  };
}

export function runListItem(row: Row): RunListItem {
  const headline = toText(row.insight_headline);
  const verdict = toText(row.insight_verdict);
  return {
    ...runMetrics(row),
    insight: headline === null && verdict === null ? null : { headline, verdict },
  };
}

export function runBrief(item: RunMetrics): RunBrief {
  return {
    id: item.id,
    date: item.date,
    intent: item.intent,
    km: item.km,
    duration: item.duration,
    avg_pace: item.avg_pace,
    avg_hr: item.avg_hr,
  };
}

export function periodTotals(from: string, to: string, row: Row | undefined): PeriodTotals {
  const distance = toNumber(row?.distance_m) ?? 0;
  const duration = toNumber(row?.duration_sec) ?? 0;
  const hrSum = toNumber(row?.hr_weighted_sum) ?? 0;
  const hrDuration = toNumber(row?.hr_duration_sec) ?? 0;
  const pace = avgPaceSecPerKm(distance, duration);
  const longest = toNumber(row?.longest_m);
  return {
    from,
    to,
    runs: toNumber(row?.runs) ?? 0,
    run_days: toNumber(row?.run_days) ?? 0,
    distance_m: distance,
    km: metresToKm(distance),
    duration_sec: duration,
    duration: formatDuration(duration),
    avg_pace_sec: pace,
    avg_pace: formatPace(pace),
    avg_hr: hrDuration > 0 ? Math.round(hrSum / hrDuration) : null,
    max_hr: toNumber(row?.max_hr),
    longest_run_m: longest,
    longest_run_km: metresToKm(longest),
    elevation_m: toNumber(row?.elevation_m),
    active_kcal: toNumber(row?.active_kcal),
  };
}

export function splitOut(row: Row): SplitOut {
  const pace = toNumber(row.pace_sec) ?? 0;
  return {
    km: toNumber(row.km) ?? 0,
    time_sec: toNumber(row.time_sec) ?? 0,
    pace_sec: pace,
    pace: formatPace(pace),
    hr: toNumber(row.hr),
    cadence: toNumber(row.cadence),
    partial: row.partial === true || row.partial === 't',
  };
}

export function zonesOut(rows: Row[]): ZoneOut[] {
  const total = rows.reduce((sum, r) => sum + (toNumber(r.duration_sec) ?? 0), 0);
  return rows.map((r) => {
    const duration = toNumber(r.duration_sec) ?? 0;
    const min = toNumber(r.min_bpm);
    const max = toNumber(r.max_bpm);
    return {
      zone: toNumber(r.zone) ?? 0,
      duration_sec: duration,
      duration: formatDuration(duration),
      pct: percentOf(duration, total),
      min_bpm: min,
      max_bpm: max,
      range: formatZoneRange(min, max),
    };
  });
}

function asRecord(value: unknown): Row {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

/**
 * The app's insight payload ({headline, verdict, whatHappened, observations, doNext,
 * questionForRunner} + hrMaxUsed/hrMaxSource on session rows, lib/llm/schema.ts) in snake_case.
 * Defensive: a field the payload lacks comes back null/empty instead of throwing.
 */
export function insightOut(row: Row | undefined): InsightOut | null {
  if (!row) return null;
  const p = asRecord(row.payload);
  const observations = Array.isArray(p.observations) ? p.observations : [];
  const doNext = Array.isArray(p.doNext) ? p.doNext : [];
  const out: InsightOut = {
    headline: toText(p.headline),
    verdict: toText(p.verdict),
    what_happened: toText(p.whatHappened),
    observations: observations.map((o) => {
      const r = asRecord(o);
      return { title: toText(r.title), detail: toText(r.detail), metric: toText(r.metric) };
    }),
    do_next: doNext.map((d) => String(d)),
    question_for_runner: toText(p.questionForRunner),
    generated_at: toText(row.generated_at),
    model: toText(row.model),
  };
  if ('hrMaxUsed' in p) out.hr_max_used = toNumber(p.hrMaxUsed);
  if ('hrMaxSource' in p) out.hr_max_source = toText(p.hrMaxSource);
  return out;
}

/** occurred_on DESC, started_at DESC with NULL start times first (Postgres DESC default), then id. */
export function compareListOrder(a: RunMetrics, b: RunMetrics): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.started_at !== b.started_at) {
    if (a.started_at === null) return -1;
    if (b.started_at === null) return 1;
    return a.started_at < b.started_at ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ---------------------------------------------------------------------------------------------
 * Reads
 * -------------------------------------------------------------------------------------------*/

export async function listRuns(
  connector: Connector,
  from: string,
  to: string,
): Promise<{ runs: RunListItem[]; truncated: boolean }> {
  const result = await connector.query(LIST_RUNS_SQL, [from, to], { maxRows: RUNS_MAX_ROWS });
  // The connector wraps the statement in an outer SELECT; re-sort so order never depends on it.
  const runs = rowsToObjects(result).map(runListItem).sort(compareListOrder);
  return { runs, truncated: result.truncated };
}

export async function readPeriodTotals(connector: Connector, from: string, to: string): Promise<PeriodTotals> {
  const result = await connector.query(PERIOD_TOTALS_SQL, [from, to]);
  return periodTotals(from, to, rowsToObjects(result)[0]);
}

function groupByRun(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const id = String(row.run_id);
    const list = out.get(id);
    if (list) list.push(row);
    else out.set(id, [row]);
  }
  return out;
}

/** Runs (any review state) with splits, zones, latest session insight, plus the owner's profile HR. */
export async function readRunDetails(
  connector: Connector,
  runRows: Row[],
): Promise<{ runs: RunDetail[]; profile: { max_hr: number | null; resting_hr: number | null } | null }> {
  if (runRows.length === 0) return { runs: [], profile: null };
  const ids = runRows.map((r) => String(r.id));
  const ownerId = String(runRows[0]?.user_id);
  const [splitsRes, zonesRes, insightsRes, profileRes] = await Promise.all([
    connector.query(SPLITS_SQL, [ids], { maxRows: RUNS_MAX_ROWS }),
    connector.query(ZONES_SQL, [ids]),
    connector.query(SESSION_INSIGHTS_SQL, [ids]),
    connector.query(PROFILE_SQL, [ownerId]),
  ]);
  const splits = groupByRun(rowsToObjects(splitsRes));
  const zones = groupByRun(rowsToObjects(zonesRes));
  const insights = new Map(rowsToObjects(insightsRes).map((r) => [String(r.scope_key), r]));
  const profileRow = rowsToObjects(profileRes)[0];

  const runs = runRows.map((row): RunDetail => {
    const id = String(row.id);
    const runSplits = (splits.get(id) ?? []).map(splitOut).sort((a, b) => a.km - b.km);
    const runZones = zonesOut((zones.get(id) ?? []).sort((a, b) => (toNumber(a.zone) ?? 0) - (toNumber(b.zone) ?? 0)));
    return {
      ...runMetrics(row),
      ended_at: toText(row.ended_at),
      resting_hr: toNumber(row.resting_hr),
      end_hr_bpm: toNumber(row.end_hr_bpm),
      hr_1min_post_bpm: toNumber(row.hr_1min_post_bpm),
      note: toText(row.note),
      source: toText(row.source),
      reviewed: row.reviewed === true || row.reviewed === 't',
      reviewed_at: toText(row.reviewed_at),
      corrected_at: toText(row.corrected_at),
      splits: runSplits,
      zones: runZones,
      insight: insightOut(insights.get(id)),
    };
  });
  const profile = profileRow
    ? { max_hr: toNumber(profileRow.max_hr), resting_hr: toNumber(profileRow.resting_hr) }
    : null;
  return { runs, profile };
}

export async function readRunRowsById(connector: Connector, id: string): Promise<Row[]> {
  return rowsToObjects(await connector.query(RUN_BY_ID_SQL, [id]));
}

export async function readRunRowsByDate(connector: Connector, date: string): Promise<Row[]> {
  const rows = rowsToObjects(await connector.query(RUNS_BY_DATE_SQL, [date]));
  return rows.sort((a, b) => {
    const sa = toText(a.started_at);
    const sb = toText(b.started_at);
    if (sa !== sb) {
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sa < sb ? -1 : 1;
    }
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

export async function readPeriodInsight(connector: Connector, period: Period): Promise<InsightOut | null> {
  const result = await connector.query(PERIOD_INSIGHT_SQL, [period.scope, period.key]);
  return insightOut(rowsToObjects(result)[0]);
}
```
**Impact:** none outside this directory.

### Step 4: Replace the stub with the three tools
**File:** `src/connectors/runs/curated.ts:1` (phase 1 stub; replace the whole file)
**Change:** Keep the export name and signature. Inputs validated by zod for shape and by `resolveRange` / `resolvePeriod` / `isRealDate` for meaning before any query runs. All handlers go through `run(…, { compact: true })` from `src/mcp/tools.ts`, so a `ConnectorError` (or any throw) is an `isError` result for that call only.
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../../mcp/tools.js';
import type { Connector } from '../types.js';
import { isRealDate, resolvePeriod, resolveRange, type PeriodScope } from './periods.js';
import {
  listRuns,
  readPeriodInsight,
  readPeriodTotals,
  readRunDetails,
  readRunRowsByDate,
  readRunRowsById,
  runBrief,
} from './queries.js';

const UNITS_NOTE =
  'Units are the app\'s own: distance_m metres, duration_sec seconds, avg_pace_sec seconds per km, heart rate bpm; ' +
  'each comes with a readable companion (km, duration "h:mm:ss", avg_pace "m:ss /km"). Dates are WIB (Asia/Jakarta) calendar days.';

const dayField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** runs_list: reviewed runs in an inclusive WIB day range, newest first, plus period totals. */
export async function runsList(connector: Connector, from: string, to: string | undefined, now: Date = new Date()) {
  const range = resolveRange(from, to, now);
  const [list, totals] = await Promise.all([
    listRuns(connector, range.from, range.to),
    readPeriodTotals(connector, range.from, range.to),
  ]);
  return { from: range.from, to: range.to, totals, runs: list.runs, truncated: list.truncated };
}

/** runs_get: one run by id, or every run on a day, in full. */
export async function runsGet(connector: Connector, id: string | undefined, date: string | undefined) {
  const byId = id !== undefined && id.trim() !== '';
  const byDate = date !== undefined && date.trim() !== '';
  if (byId === byDate) throw new Error('give exactly one of id (a run id from runs_list) or date (YYYY-MM-DD)');
  if (byId) {
    const runId = (id as string).trim();
    const rows = await readRunRowsById(connector, runId);
    if (rows.length === 0) throw new Error(`run-insights has no run with id "${runId}"`);
    return { id: runId, ...(await readRunDetails(connector, rows)) };
  }
  const day = (date as string).trim();
  if (!isRealDate(day)) throw new RangeError(`date "${day}" is not a real day (YYYY-MM-DD)`);
  const details = await readRunDetails(connector, await readRunRowsByDate(connector, day));
  return { date: day, ...details };
}

/** runs_review: the app's latest week or month review for a period, plus that period's totals and runs. */
export async function runsReview(connector: Connector, scope: PeriodScope, key: string | undefined, now: Date = new Date()) {
  const period = resolvePeriod(scope, key, now);
  const [insight, totals, list] = await Promise.all([
    readPeriodInsight(connector, period),
    readPeriodTotals(connector, period.from, period.to),
    listRuns(connector, period.from, period.to),
  ]);
  return {
    scope: period.scope,
    key: period.key,
    from: period.from,
    to: period.to,
    review: insight,
    review_missing: insight === null ? `run-insights has no ${period.scope} review stored for ${period.key}` : null,
    totals,
    runs: list.runs.map(runBrief),
  };
}

export function registerRunsCurated(server: McpServer, connector: Connector): void {
  server.registerTool(
    'runs_list',
    {
      title: 'Runs in a date range',
      description:
        'The user\'s runs from run-insights (Apple Watch runs read from screenshots) between two dates, inclusive, newest first. ' +
        'Only reviewed runs are counted, as in the app. Per run: id, date, start time, activity type, intent, distance, duration, ' +
        'average pace, average and max heart rate, cadence, elevation, kcal, 1-minute heart-rate drop after the run, and the headline ' +
        'and verdict of the app\'s own analysis of that run when it has one. Also returns totals for the period (runs, distance, time, ' +
        'distance-weighted average pace, time-weighted average heart rate, longest run). To compare periods ("this month vs last month") ' +
        'call it once per period. For one run in full (splits, zones, the full analysis text) use runs_get with its id. ' +
        UNITS_NOTE,
      inputSchema: {
        from: dayField.describe('First day, inclusive, YYYY-MM-DD (WIB).'),
        to: dayField.optional().describe('Last day, inclusive, YYYY-MM-DD (WIB). Default: today.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => run(() => runsList(connector, from, to), { compact: true }),
  );

  server.registerTool(
    'runs_get',
    {
      title: 'One run in full',
      description:
        'One run from run-insights in full: give either id (from runs_list) or date (YYYY-MM-DD, returns every run that day, ' +
        'e.g. "my run yesterday"). Returns all metrics, per-km splits in km order (the last km flagged partial when it was not a full km), ' +
        'time in heart-rate zones 1-5 with bpm bounds and share of time, the runner\'s note, whether the run was reviewed, and the app\'s ' +
        'latest analysis of the run (headline, verdict, what happened, observations, what to do next, a question for the runner). ' +
        'profile carries the runner\'s max and resting heart rate for context. Unreviewed runs are included and flagged reviewed: false. ' +
        UNITS_NOTE,
      inputSchema: {
        id: z.string().optional().describe('Run id, as returned by runs_list.'),
        date: dayField.optional().describe('A WIB day, YYYY-MM-DD: returns every run on that day.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, date }) => run(() => runsGet(connector, id, date), { compact: true }),
  );

  server.registerTool(
    'runs_review',
    {
      title: 'Weekly or monthly running review',
      description:
        'The run-insights app\'s own weekly or monthly review (headline, verdict, what happened, observations, what to do next, ' +
        'a question for the runner) for one period, plus totals and a short list of the reviewed runs in it. scope "week" is an ISO week, ' +
        'Monday to Sunday; scope "month" is a calendar month. key is "2026-W34" for a week, "2026-08" for a month, or any day ' +
        'YYYY-MM-DD inside the period; omit it for the current week or month. review is null (and review_missing says so) when the app ' +
        'has not generated one for that period; the totals are still correct. ' +
        UNITS_NOTE,
      inputSchema: {
        scope: z.enum(['week', 'month']).describe('"week" (ISO, Monday-Sunday) or "month".'),
        key: z
          .string()
          .optional()
          .describe('"2026-W34", "2026-08", or a day YYYY-MM-DD inside the period. Default: the period containing today (WIB).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, key }) => run(() => runsReview(connector, scope, key), { compact: true }),
  );
}
```
**Impact:** `tools/list` on `/mcp` gains `runs_list`, `runs_get`, `runs_review` (via phase 1's `registerConnectorTools`). No other tool changes.

### Step 5: Unit tests for the pure helpers
**File:** `tests/unit/connectors/runs.format.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  avgPaceSecPerKm,
  formatDuration,
  formatPace,
  formatZoneRange,
  hrDrop1Min,
  metresToKm,
  percentOf,
  toNumber,
  toText,
} from '../../../src/connectors/runs/format.js';

describe('runs format helpers', () => {
  it('formats pace as m:ss /km', () => {
    expect(formatPace(344)).toBe('5:44 /km');
    expect(formatPace(360)).toBe('6:00 /km');
    expect(formatPace(605)).toBe('10:05 /km');
    expect(formatPace(343.6)).toBe('5:44 /km');
    expect(formatPace(null)).toBeNull();
    expect(formatPace(0)).toBeNull();
  });

  it('formats duration as h:mm:ss', () => {
    expect(formatDuration(1800)).toBe('0:30:00');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(59.6)).toBe('0:01:00');
    expect(formatDuration(0)).toBe('0:00:00');
    expect(formatDuration(null)).toBeNull();
  });

  it('converts metres to km with two decimals', () => {
    expect(metresToKm(5230)).toBe(5.23);
    expect(metresToKm(16234)).toBe(16.23);
    expect(metresToKm(10000)).toBe(10);
    expect(metresToKm(null)).toBeNull();
  });

  it('computes period pace as summed duration over summed distance', () => {
    expect(avgPaceSecPerKm(16230, 5880)).toBe(362);
    expect(avgPaceSecPerKm(10000, 3600)).toBe(360);
    expect(avgPaceSecPerKm(0, 100)).toBeNull();
  });

  it('computes the 1-minute HR drop', () => {
    expect(hrDrop1Min(165, 130)).toBe(35);
    expect(hrDrop1Min(null, 130)).toBeNull();
    expect(hrDrop1Min(165, null)).toBeNull();
  });

  it('formats zone bounds like Apple prints them', () => {
    expect(formatZoneRange(null, 129)).toBe('< 129 bpm');
    expect(formatZoneRange(130, 145)).toBe('130-145 bpm');
    expect(formatZoneRange(174, null)).toBe('> 174 bpm');
    expect(formatZoneRange(null, null)).toBeNull();
  });

  it('computes one-decimal percentages', () => {
    expect(percentOf(900, 1800)).toBe(50);
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(5, 0)).toBeNull();
  });

  it('coerces driver values', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber('42')).toBe(42);
    expect(toNumber('146.5')).toBe(146.5);
    expect(toNumber(10n)).toBe(10);
    expect(toNumber('x')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toText(null)).toBeNull();
    expect(toText('06:00:00')).toBe('06:00:00');
  });
});
```

**File:** `tests/unit/connectors/runs.periods.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  addDays,
  isRealDate,
  isoWeekKeyOf,
  isoWeekRange,
  monthRange,
  resolvePeriod,
  resolveRange,
  todayInWib,
} from '../../../src/connectors/runs/periods.js';

describe('runs period helpers', () => {
  it('validates real days', () => {
    expect(isRealDate('2026-10-28')).toBe(true);
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-10-28T00:00')).toBe(false);
    expect(isRealDate('yesterday')).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('gives today in WIB, not UTC', () => {
    expect(todayInWib(new Date('2026-10-31T17:30:00Z'))).toBe('2026-11-01');
    expect(todayInWib(new Date('2026-10-31T16:59:00Z'))).toBe('2026-10-31');
  });

  it('keys ISO weeks by the Thursday rule', () => {
    expect(isoWeekKeyOf('2025-12-29')).toBe('2026-W01');
    expect(isoWeekKeyOf('2027-01-03')).toBe('2026-W53');
    expect(isoWeekKeyOf('2026-10-28')).toBe('2026-W44');
    expect(isoWeekKeyOf('2026-09-30')).toBe('2026-W40');
    expect(isoWeekKeyOf('2026-10-01')).toBe('2026-W40');
  });

  it('ranges ISO weeks Monday to Sunday', () => {
    expect(isoWeekRange('2026-W01')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect(isoWeekRange('2026-W44')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(isoWeekRange('2026-W53')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(() => isoWeekRange('2025-W53')).toThrow(RangeError);
    expect(() => isoWeekRange('2026-W54')).toThrow(RangeError);
  });

  it('ranges months', () => {
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(() => monthRange('2026-13')).toThrow(RangeError);
  });

  it('resolves a review period from a week key, month key or a day inside it', () => {
    expect(resolvePeriod('week', '2026-W44')).toEqual({ scope: 'week', key: '2026-W44', from: '2026-10-26', to: '2026-11-01' });
    expect(resolvePeriod('week', '2026-w44').key).toBe('2026-W44');
    expect(resolvePeriod('week', '2026-10-28').key).toBe('2026-W44');
    expect(resolvePeriod('month', '2026-10-15')).toEqual({ scope: 'month', key: '2026-10', from: '2026-10-01', to: '2026-10-31' });
    expect(resolvePeriod('month', '2026-09').to).toBe('2026-09-30');
  });

  it('defaults the period to the one containing today in WIB', () => {
    const now = new Date('2026-10-31T17:30:00Z'); // 2026-11-01 00:30 WIB
    expect(resolvePeriod('month', undefined, now).key).toBe('2026-11');
    expect(resolvePeriod('week', undefined, now).key).toBe('2026-W44');
  });

  it('rejects keys that are neither a period nor a day', () => {
    expect(() => resolvePeriod('week', 'banana')).toThrow(RangeError);
    expect(() => resolvePeriod('month', '2026-W44')).toThrow(RangeError);
    expect(() => resolvePeriod('week', '2025-W53')).toThrow(RangeError);
  });

  it('validates inclusive ranges and defaults to to today', () => {
    expect(resolveRange('2026-10-01', '2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveRange('2026-10-01', undefined, new Date('2026-10-30T03:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-30' });
    expect(() => resolveRange('2026-10-31', '2026-10-01')).toThrow(/after/);
    expect(() => resolveRange('2026-02-30', '2026-03-01')).toThrow(RangeError);
  });
});
```
**Impact:** runs in `npm test` (`tests/unit/**/*.test.ts`).

### Step 6: Unit test for the tool layer with a fake connector
**File:** `tests/unit/connectors/runs.curated.test.ts:1` (new)
**Change:** Registers the tools on a real `McpServer` linked to an SDK `Client` through `InMemoryTransport` (SDK 1.32.2 ships `@modelcontextprotocol/sdk/inMemory.js`). The fake routes by the SQL tag comment. No Docker needed, so the mapping and validation are covered by `npm test`.
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTOR_TOOL_NAMES } from '../../../src/connectors/names.js';
import { registerRunsCurated } from '../../../src/connectors/runs/curated.js';
import type { Connector, QueryResult } from '../../../src/connectors/types.js';

/** A canned result keyed by the statement's leading tag comment, e.g. runs:list. */
type Canned = Record<string, { columns: string[]; rows: unknown[][]; truncated?: boolean }>;

interface Call {
  tag: string;
  sql: string;
  params: readonly unknown[];
}

function fakeConnector(canned: Canned, calls: Call[], fail?: Error): Connector {
  return {
    id: 'runs',
    label: 'run-insights',
    async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
      const tag = /\/\* (runs:\w+) \*\//.exec(sql)?.[1] ?? 'untagged';
      calls.push({ tag, sql, params });
      if (fail) throw fail;
      const c = canned[tag] ?? { columns: [], rows: [] };
      return { columns: c.columns, rows: c.rows, row_count: c.rows.length, truncated: c.truncated ?? false };
    },
  };
}

let client: Client | undefined;

async function connect(connector: Connector): Promise<Client> {
  const server = new McpServer({ name: 'runs-curated-test', version: '0.0.0' });
  registerRunsCurated(server, connector);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: 'runs-curated-test-client', version: '0.0.0' });
  await c.connect(clientTransport);
  client = c;
  return c;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function call<T>(c: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(textOf(result));
  return JSON.parse(textOf(result)) as T;
}

async function callError(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError).toBe(true);
  return textOf(result);
}

const RUN_COLS = [
  'id', 'user_id', 'occurred_on', 'started_at', 'ended_at', 'activity_type', 'location', 'intent',
  'distance_m', 'duration_sec', 'avg_pace_sec', 'avg_hr', 'max_hr', 'resting_hr', 'avg_cadence',
  'elevation_m', 'active_kcal', 'total_kcal', 'end_hr_bpm', 'hr_1min_post_bpm', 'note', 'source',
  'reviewed', 'reviewed_at', 'corrected_at',
];

function runRow(over: Partial<Record<string, unknown>>): unknown[] {
  const base: Record<string, unknown> = {
    id: 'r1', user_id: 'u1', occurred_on: '2026-10-28', started_at: '06:00:00', ended_at: '06:30:00',
    activity_type: 'Outdoor Run', location: null, intent: 'easy', distance_m: 5230, duration_sec: 1800,
    avg_pace_sec: 344, avg_hr: 150, max_hr: 170, resting_hr: null, avg_cadence: 170, elevation_m: 20,
    active_kcal: 350, total_kcal: 420, end_hr_bpm: 165, hr_1min_post_bpm: 130, note: 'felt good',
    source: 'screenshot', reviewed: true, reviewed_at: '2026-10-28 07:00:00+07', corrected_at: null,
    ...over,
  };
  return RUN_COLS.map((c) => base[c]);
}

describe('registerRunsCurated', () => {
  it('registers exactly the three curated run tools named in the contract', async () => {
    const c = await connect(fakeConnector({}, []));
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['runs_get', 'runs_list', 'runs_review']);
    for (const name of names) expect(CONNECTOR_TOOL_NAMES.runs).toContain(name);
  });

  it('runs_list shapes runs with companions and computes period totals', async () => {
    const calls: Call[] = [];
    const c = await connect(
      fakeConnector(
        {
          'runs:list': {
            columns: [...RUN_COLS, 'insight_headline', 'insight_verdict'],
            rows: [
              [...runRow({ id: 'r2', occurred_on: '2026-10-01', started_at: '05:30:00', distance_m: 8000, duration_sec: 2880, avg_pace_sec: 360, avg_hr: null }), null, null],
              [...runRow({}), 'Easy aerobic run', 'easy'],
            ],
          },
          'runs:totals': {
            columns: ['runs', 'run_days', 'distance_m', 'duration_sec', 'hr_weighted_sum', 'hr_duration_sec', 'max_hr', 'longest_m', 'elevation_m', 'active_kcal'],
            rows: [[2, 2, '13230', '4680', '270000', '1800', 170, 8000, '40', '700']],
          },
        },
        calls,
      ),
    );
    const out = await call<{
      from: string;
      to: string;
      runs: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
      truncated: boolean;
    }>(c, 'runs_list', { from: '2026-10-01', to: '2026-10-31' });

    expect(out.from).toBe('2026-10-01');
    expect(out.to).toBe('2026-10-31');
    expect(out.runs.map((r) => r.id)).toEqual(['r1', 'r2']); // newest first even if the driver returned otherwise
    expect(out.runs[0]).toMatchObject({
      date: '2026-10-28',
      km: 5.23,
      duration: '0:30:00',
      avg_pace_sec: 344,
      avg_pace: '5:44 /km',
      hr_drop_1min: 35,
      insight: { headline: 'Easy aerobic run', verdict: 'easy' },
    });
    expect(out.runs[1]?.insight).toBeNull();
    expect(out.totals).toMatchObject({
      runs: 2,
      distance_m: 13230,
      km: 13.23,
      duration_sec: 4680,
      avg_pace_sec: 354,
      avg_pace: '5:54 /km',
      avg_hr: 150,
      longest_run_km: 8,
    });
    expect(out.truncated).toBe(false);
    const list = calls.find((x) => x.tag === 'runs:list');
    expect(list?.params).toEqual(['2026-10-01', '2026-10-31']);
    expect(list?.sql).toContain('reviewed_at IS NOT NULL');
  });

  it('runs_list rejects an inverted range before touching the database', async () => {
    const calls: Call[] = [];
    const c = await connect(fakeConnector({}, calls));
    expect(await callError(c, 'runs_list', { from: '2026-10-31', to: '2026-10-01' })).toContain('after');
    expect(calls).toHaveLength(0);
  });

  it('runs_get returns splits, zones, the full insight and the profile', async () => {
    const c = await connect(
      fakeConnector(
        {
          'runs:by_id': { columns: RUN_COLS, rows: [runRow({})] },
          'runs:splits': {
            columns: ['run_id', 'km', 'time_sec', 'pace_sec', 'hr', 'cadence', 'partial'],
            rows: [
              ['r1', 2, 345, 345, 150, 170, false],
              ['r1', 1, 340, 340, 145, 168, false],
              ['r1', 3, 80, 348, 155, 171, true],
            ],
          },
          'runs:zones': {
            columns: ['run_id', 'zone', 'duration_sec', 'min_bpm', 'max_bpm'],
            rows: [
              ['r1', 1, 600, null, 129],
              ['r1', 2, 1200, 130, 145],
            ],
          },
          'runs:session_insights': {
            columns: ['scope_key', 'payload', 'model', 'generated_at'],
            rows: [
              [
                'r1',
                {
                  headline: 'Easy aerobic run',
                  verdict: 'easy',
                  whatHappened: 'Steady.',
                  observations: [{ title: 'HR', detail: 'Low', metric: '150 bpm' }],
                  doNext: ['Repeat'],
                  questionForRunner: 'How did it feel?',
                  hrMaxUsed: 190,
                  hrMaxSource: 'profile',
                },
                'claude-x',
                '2026-10-28 08:00:00+07',
              ],
            ],
          },
          'runs:profile': { columns: ['max_hr', 'resting_hr'], rows: [[190, 52]] },
        },
        [],
      ),
    );
    const out = await call<{ id: string; runs: Array<Record<string, unknown>>; profile: unknown }>(c, 'runs_get', { id: 'r1' });
    expect(out.id).toBe('r1');
    expect(out.profile).toEqual({ max_hr: 190, resting_hr: 52 });
    const run = out.runs[0] as Record<string, unknown>;
    expect(run.reviewed).toBe(true);
    expect(run.note).toBe('felt good');
    expect((run.splits as Array<{ km: number }>).map((s) => s.km)).toEqual([1, 2, 3]);
    expect((run.splits as Array<{ partial: boolean; pace: string }>)[2]).toMatchObject({ partial: true, pace: '5:48 /km' });
    expect(run.zones).toEqual([
      { zone: 1, duration_sec: 600, duration: '0:10:00', pct: 33.3, min_bpm: null, max_bpm: 129, range: '< 129 bpm' },
      { zone: 2, duration_sec: 1200, duration: '0:20:00', pct: 66.7, min_bpm: 130, max_bpm: 145, range: '130-145 bpm' },
    ]);
    expect(run.insight).toEqual({
      headline: 'Easy aerobic run',
      verdict: 'easy',
      what_happened: 'Steady.',
      observations: [{ title: 'HR', detail: 'Low', metric: '150 bpm' }],
      do_next: ['Repeat'],
      question_for_runner: 'How did it feel?',
      hr_max_used: 190,
      hr_max_source: 'profile',
      generated_at: '2026-10-28 08:00:00+07',
      model: 'claude-x',
    });
  });

  it('runs_get needs exactly one of id or date, and reports an unknown id', async () => {
    const c = await connect(fakeConnector({}, []));
    expect(await callError(c, 'runs_get', {})).toContain('exactly one');
    expect(await callError(c, 'runs_get', { id: 'r1', date: '2026-10-28' })).toContain('exactly one');
    expect(await callError(c, 'runs_get', { id: 'nope' })).toContain('no run with id "nope"');
  });

  it('runs_get by a day with no runs returns an empty list, not an error', async () => {
    const c = await connect(fakeConnector({}, []));
    expect(await call(c, 'runs_get', { date: '2026-10-27' })).toEqual({ date: '2026-10-27', runs: [], profile: null });
  });

  it('runs_review resolves a day to its ISO week and says when no review exists', async () => {
    const calls: Call[] = [];
    const c = await connect(fakeConnector({}, calls));
    const out = await call<Record<string, unknown>>(c, 'runs_review', { scope: 'week', key: '2026-10-28' });
    expect(out).toMatchObject({ scope: 'week', key: '2026-W44', from: '2026-10-26', to: '2026-11-01', review: null, runs: [] });
    expect(out.review_missing).toContain('2026-W44');
    expect(calls.find((x) => x.tag === 'runs:period_insight')?.params).toEqual(['week', '2026-W44']);
    expect(calls.find((x) => x.tag === 'runs:totals')?.params).toEqual(['2026-10-26', '2026-11-01']);
  });

  it('runs_review rejects a key that is neither a period nor a day', async () => {
    const c = await connect(fakeConnector({}, []));
    expect(await callError(c, 'runs_review', { scope: 'month', key: 'banana' })).toContain('not a month');
  });

  it('a connector failure becomes a tool error with the connector message', async () => {
    const c = await connect(fakeConnector({}, [], new Error('run-insights is not reachable: .env.local not found')));
    expect(await callError(c, 'runs_list', { from: '2026-10-01', to: '2026-10-31' })).toContain(
      'run-insights is not reachable: .env.local not found',
    );
  });
});
```
**Impact:** runs in `npm test`. Depends on phase 1's `names.ts` and `types.ts` existing with the contract shapes.

### Step 7: Integration test on the Docker run-insights database
**File:** `tests/integration/connectors/runs.curated.int.test.ts:1` (new)
**Change:** Uses the phase-1 harness (`describeWithRepo('runs', …)`, `systemDbUrl`, `withAdmin`, `truncateSystem`, `connectorFor`, `cleanupHarness`). Seeding goes through a local `seed()` helper on `withAdmin(systemDbUrl('runs'), …)` (writable, refuses Neon; not added to the harness). Seeds `"user"`, `profiles`, five `runs` (two on one day, one unreviewed, one with no avg HR, one in the previous month in the same ISO week), six `run_splits` with a partial km, five `run_zones`, and `insights` with superseded rows per key to prove newest-wins. Reads go through the real read-only connector.
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { registerRunsCurated } from '../../../src/connectors/runs/curated.js';
import { cleanupHarness, connectorFor, describeWithRepo, systemDbUrl, truncateSystem, withAdmin } from './harness.js';

/*
 * runs_list / runs_get / runs_review against a Docker Postgres built from ~/run-insights' own
 * drizzle migrations (phase 1 harness). Seeds through an admin connection; the tools read through
 * a real read-only connector. Calendar used below: 2026-10-28 is a Wednesday in ISO week
 * 2026-W44 (Oct 26 - Nov 1); 2026-09-30 and 2026-10-01 both fall in 2026-W40.
 */

/** Seeds one statement at a time through a writable admin connection (local helper, not in the harness). */
async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
  await withAdmin(systemDbUrl('runs'), async (admin) => {
    for (const [sql, params] of statements) await admin.query(sql, params);
  });
}

function insertRun(r: {
  id: string;
  date: string;
  start: string | null;
  distance: number;
  duration: number;
  pace: number;
  avgHr: number | null;
  maxHr?: number | null;
  intent?: string;
  reviewed?: boolean;
  note?: string | null;
  endHr?: number | null;
  hr1?: number | null;
}): [string, unknown[]] {
  return [
    `INSERT INTO runs (id, user_id, occurred_on, started_at, activity_type, duration_sec, distance_m,
       active_kcal, total_kcal, elevation_m, avg_cadence, avg_pace_sec, avg_hr, max_hr, intent,
       end_hr_bpm, hr_1min_post_bpm, note, source, reviewed_at)
     VALUES ($1, 'u1', $2, $3, 'Outdoor Run', $4, $5, 300, 380, 20, 170, $6, $7, $8, $9, $10, $11, $12,
       'screenshot', CASE WHEN $13::boolean THEN now() ELSE NULL END)`,
    [
      r.id, r.date, r.start, r.duration, r.distance, r.pace, r.avgHr, r.maxHr ?? null, r.intent ?? 'easy',
      r.endHr ?? null, r.hr1 ?? null, r.note ?? null, r.reviewed ?? true,
    ],
  ];
}

function payload(headline: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headline,
    verdict: 'moderate',
    whatHappened: `${headline}: what happened.`,
    observations: [
      { title: 'Pace', detail: 'Even splits.', metric: '5:44 /km' },
      { title: 'Heart rate', detail: 'Mostly zone 3.', metric: '150 bpm' },
    ],
    doNext: ['Keep the easy days easy.'],
    questionForRunner: 'How did your legs feel?',
    ...extra,
  });
}

function insertInsight(id: string, scope: string, key: string, createdAt: string, body: string): [string, unknown[]] {
  return [
    `INSERT INTO insights (id, user_id, scope, scope_key, facts_hash, payload, model, created_at)
     VALUES ($1, 'u1', $2, $3, $4, $5::jsonb, 'test-model', $6::timestamptz)`,
    [id, scope, key, `hash-${id}`, body, createdAt],
  ];
}

const SEED: Array<[string, unknown[]]> = [
  [`INSERT INTO "user" (id, name, email) VALUES ('u1', 'Runner', 'runner@example.test')`, []],
  [`INSERT INTO profiles (user_id, max_hr, resting_hr) VALUES ('u1', 190, 52)`, []],
  insertRun({ id: 'r_oct28am', date: '2026-10-28', start: '06:00:00', distance: 5230, duration: 1800, pace: 344, avgHr: 150, maxHr: 170, note: 'felt good', endHr: 165, hr1: 130 }),
  insertRun({ id: 'r_oct28pm', date: '2026-10-28', start: '18:00:00', distance: 3000, duration: 1200, pace: 400, avgHr: 140, maxHr: 155 }),
  insertRun({ id: 'r_oct29draft', date: '2026-10-29', start: '06:00:00', distance: 4000, duration: 1500, pace: 375, avgHr: 145, reviewed: false }),
  insertRun({ id: 'r_oct01', date: '2026-10-01', start: '05:30:00', distance: 8000, duration: 2880, pace: 360, avgHr: null, intent: 'long' }),
  insertRun({ id: 'r_sep30', date: '2026-09-30', start: '05:30:00', distance: 10000, duration: 3600, pace: 360, avgHr: 155, maxHr: 175, intent: 'long' }),
  ...[
    [1, 340, 340, 145, false],
    [2, 345, 345, 150, false],
    [3, 344, 344, 151, false],
    [4, 343, 343, 152, false],
    [5, 348, 348, 155, false],
    [6, 80, 348, 158, true],
  ].map(([km, time, pace, hr, partial]): [string, unknown[]] => [
    `INSERT INTO run_splits (run_id, km, time_sec, pace_sec, hr, cadence, partial) VALUES ('r_oct28am', $1, $2, $3, $4, 170, $5)`,
    [km, time, pace, hr, partial],
  ]),
  ...[
    [1, 60, null, 129],
    [2, 300, 130, 145],
    [3, 900, 146, 160],
    [4, 480, 161, 173],
    [5, 60, 174, null],
  ].map(([zone, dur, min, max]): [string, unknown[]] => [
    `INSERT INTO run_zones (run_id, zone, duration_sec, min_bpm, max_bpm) VALUES ('r_oct28am', $1, $2, $3, $4)`,
    [zone, dur, min, max],
  ]),
  insertInsight('i_s_old', 'session', 'r_oct28am', '2026-10-28T08:00:00+07:00', payload('Older take')),
  insertInsight('i_s_new', 'session', 'r_oct28am', '2026-10-28T09:00:00+07:00', payload('Steady aerobic morning', { hrMaxUsed: 190, hrMaxSource: 'profile' })),
  insertInsight('i_w44', 'week', '2026-W44', '2026-11-01T20:00:00+07:00', payload('Solid week')),
  insertInsight('i_m10_old', 'month', '2026-10', '2026-10-20T20:00:00+07:00', payload('Mid-month draft')),
  insertInsight('i_m10_new', 'month', '2026-10', '2026-10-31T20:00:00+07:00', payload('October in review')),
];

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describeWithRepo('runs', 'run-insights curated tools', () => {
  let client: Client;

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(textOf(result));
    return JSON.parse(textOf(result)) as T;
  }

  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError).toBe(true);
    return textOf(result);
  }

  beforeAll(async () => {
    const server = new McpServer({ name: 'runs-curated-int', version: '0.0.0' });
    registerRunsCurated(server, connectorFor('runs'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'runs-curated-int-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    cleanupHarness();
  });

  beforeEach(async () => {
    await truncateSystem('runs');
    await seed(SEED);
  });

  it('runs_list: reviewed runs in range, newest first, with metrics, insight headline and period totals', async () => {
    const out = await call<{ runs: Array<Record<string, unknown>>; totals: Record<string, unknown>; truncated: boolean }>(
      'runs_list',
      { from: '2026-10-01', to: '2026-10-31' },
    );
    expect(out.runs.map((r) => r.id)).toEqual(['r_oct28pm', 'r_oct28am', 'r_oct01']);
    expect(out.runs[1]).toMatchObject({
      id: 'r_oct28am',
      date: '2026-10-28',
      started_at: '06:00:00',
      intent: 'easy',
      distance_m: 5230,
      km: 5.23,
      duration_sec: 1800,
      duration: '0:30:00',
      avg_pace_sec: 344,
      avg_pace: '5:44 /km',
      avg_hr: 150,
      max_hr: 170,
      avg_cadence: 170,
      hr_drop_1min: 35,
      insight: { headline: 'Steady aerobic morning', verdict: 'moderate' },
    });
    expect(out.runs[0]?.insight).toBeNull();
    expect(out.totals).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      runs: 3,
      run_days: 2,
      distance_m: 16230,
      km: 16.23,
      duration_sec: 5880,
      duration: '1:38:00',
      avg_pace_sec: 362,
      avg_pace: '6:02 /km',
      avg_hr: 146,
      max_hr: 170,
      longest_run_m: 8000,
    });
    expect(out.truncated).toBe(false);
  });

  it('runs_list: last month is a second call with its own totals', async () => {
    const out = await call<{ runs: Array<Record<string, unknown>>; totals: Record<string, unknown> }>('runs_list', {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(out.runs.map((r) => r.id)).toEqual(['r_sep30']);
    expect(out.totals).toMatchObject({ runs: 1, distance_m: 10000, avg_pace: '6:00 /km', avg_hr: 155 });
  });

  it('runs_list: an empty range has zero totals', async () => {
    const out = await call<{ runs: unknown[]; totals: Record<string, unknown> }>('runs_list', { from: '2026-08-01', to: '2026-08-31' });
    expect(out.runs).toEqual([]);
    expect(out.totals).toMatchObject({ runs: 0, distance_m: 0, avg_pace_sec: null, avg_hr: null });
  });

  it('runs_get by id: splits by km with the partial km, zones 1-5, newest session insight, profile', async () => {
    const out = await call<{ id: string; runs: Array<Record<string, unknown>>; profile: unknown }>('runs_get', { id: 'r_oct28am' });
    expect(out.profile).toEqual({ max_hr: 190, resting_hr: 52 });
    expect(out.runs).toHaveLength(1);
    const run = out.runs[0] as Record<string, unknown>;
    expect(run).toMatchObject({ id: 'r_oct28am', reviewed: true, note: 'felt good', end_hr_bpm: 165, hr_1min_post_bpm: 130 });
    const splits = run.splits as Array<Record<string, unknown>>;
    expect(splits.map((s) => s.km)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(splits[5]).toMatchObject({ km: 6, partial: true, pace_sec: 348, pace: '5:48 /km' });
    expect(splits.slice(0, 5).every((s) => s.partial === false)).toBe(true);
    const zones = run.zones as Array<Record<string, unknown>>;
    expect(zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(zones[0]).toMatchObject({ range: '< 129 bpm', pct: 3.3 });
    expect(zones[2]).toMatchObject({ duration_sec: 900, pct: 50, range: '146-160 bpm' });
    expect(zones[4]).toMatchObject({ range: '> 174 bpm' });
    expect(run.insight).toMatchObject({
      headline: 'Steady aerobic morning',
      verdict: 'moderate',
      what_happened: 'Steady aerobic morning: what happened.',
      do_next: ['Keep the easy days easy.'],
      question_for_runner: 'How did your legs feel?',
      hr_max_used: 190,
      hr_max_source: 'profile',
      model: 'test-model',
    });
    expect((run.insight as { observations: unknown[] }).observations).toHaveLength(2);
  });

  it('runs_get by date returns every run that day in start order, unreviewed ones flagged', async () => {
    const both = await call<{ runs: Array<Record<string, unknown>> }>('runs_get', { date: '2026-10-28' });
    expect(both.runs.map((r) => r.id)).toEqual(['r_oct28am', 'r_oct28pm']);
    expect(both.runs[1]).toMatchObject({ splits: [], zones: [], insight: null });

    const draft = await call<{ runs: Array<Record<string, unknown>> }>('runs_get', { date: '2026-10-29' });
    expect(draft.runs).toHaveLength(1);
    expect(draft.runs[0]).toMatchObject({ id: 'r_oct29draft', reviewed: false, reviewed_at: null });
  });

  it('runs_get reports an unknown id as a tool error', async () => {
    expect(await callError('runs_get', { id: 'missing' })).toContain('no run with id "missing"');
  });

  it('runs_review week from a day: latest week review plus reviewed-only totals for Mon-Sun', async () => {
    const out = await call<Record<string, unknown>>('runs_review', { scope: 'week', key: '2026-10-28' });
    expect(out).toMatchObject({ scope: 'week', key: '2026-W44', from: '2026-10-26', to: '2026-11-01', review_missing: null });
    expect(out.review).toMatchObject({ headline: 'Solid week', verdict: 'moderate' });
    expect(out.totals).toMatchObject({ runs: 2, distance_m: 8230 });
    expect((out.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(['r_oct28pm', 'r_oct28am']);
  });

  it('runs_review week spanning two months, with no stored review', async () => {
    const out = await call<Record<string, unknown>>('runs_review', { scope: 'week', key: '2026-W40' });
    expect(out).toMatchObject({ from: '2026-09-28', to: '2026-10-04', review: null });
    expect(out.review_missing).toContain('2026-W40');
    expect(out.totals).toMatchObject({ runs: 2, distance_m: 18000, avg_hr: 155 });
  });

  it('runs_review month: the newest of several month reviews wins', async () => {
    const out = await call<Record<string, unknown>>('runs_review', { scope: 'month', key: '2026-10' });
    expect(out.review).toMatchObject({ headline: 'October in review' });
    expect(out.review).not.toHaveProperty('hr_max_used');
    expect(out.totals).toMatchObject({ runs: 3, distance_m: 16230, avg_pace: '6:02 /km' });
  });
});
```
**Impact:** runs in `npm run test:int`; skipped with phase 1's message when `~/run-insights` is absent.

## Verification

**Setup:** the worktree has no `node_modules`. Run `npm ci` at the worktree root before any other command.
**Build:** `npm run typecheck`
**Tests:** `npm test -- tests/unit/connectors/runs` then `npm run test:int -- tests/integration/connectors/runs.curated.int.test.ts`, then the full `npm test` and `npm run test:int`
**Manual check:** with notesd running and `~/run-insights/.env.local` present, from Claude Code: `/n i did a run yesterday. show me how it went` should call `runs_get` with `date` = yesterday (WIB) and the result should show splits, zones and the app's analysis; `/n compare my running this month with last month` should call `runs_list` twice (or `runs_review` month twice).
**Exit criteria:** the three tools are listed by `tools/list`; all four new test files pass; `runs_list` excludes unreviewed runs and its totals match the app's rules (distance-weighted pace); `runs_get` returns splits ordered by km with the partial km flagged, zones 1-5, and the newest session insight; `runs_review` resolves `YYYY-Www` / `YYYY-MM` / a day to the right period and returns the newest review for it.

**Pre-validated while planning (scratch copy, not the worktree):** all code in this plan was typechecked with the repo's `tsconfig.json` against stubs of the contract's `types.ts`/`names.ts`/`run`, and run: the three unit files (27 tests) pass; the integration file (9 tests) passes against a throwaway `postgres:16` loaded with run-insights' journal-ordered migrations (vector/HNSW statements skipped, which touch only Nina tables) through a connector that wraps the SQL exactly as the contract says, inside `BEGIN READ ONLY` with `TimeZone=Asia/Jakarta`, both with and without custom `int8`/`numeric`/`date` type parsers.

## Handoffs

- **Reconciled with phase 1:** the connectors container is `mcp-notes-pg-connectors` on **127.0.0.1:55435** (55434 is `mcp-notes-pg-demo`); `systemDbUrl('runs')` is a writable admin URL of a pgvector database built from the full migration set; phase 1's tool-list tests do not count tools, so this phase lands in any order.
- **README:** phase 1 writes the `runs_*` rows with this phase's inputs (`from`/`to`; `id` or `date`; `scope`/`key`). This phase does not edit README.
- **Phase 5 (R3):** the `/n` skill and chat prompt can route "my run yesterday" to `runs_get { date }`, "this month vs last month" to two `runs_list` calls (or `runs_review` month twice), and "how was my week" to `runs_review { scope: 'week' }`. Captions are by tool name (`reading runs`), nothing needed from this phase.
- Not done here on purpose: records/badges/Nina chat reads (no requirement asks for them; `runs_sql` covers ad-hoc questions).

## Rollback

Revert this phase's commit: delete `src/connectors/runs/{format,periods,queries}.ts` and the four test files, and restore phase 1's stub `src/connectors/runs/curated.ts`. Nothing else references these files, so phases 1, 2, 4, 5, 6 are unaffected.
