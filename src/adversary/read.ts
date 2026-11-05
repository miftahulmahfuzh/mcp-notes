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
    const stateBy = new Map<string, CoverageState>(decisions.map((d) => [`${d.strategy_id}|${d.session_date}`, stateOf(d)]));
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
