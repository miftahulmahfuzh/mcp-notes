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
