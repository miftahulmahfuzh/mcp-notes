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
