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
