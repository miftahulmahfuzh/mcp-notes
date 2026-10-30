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
