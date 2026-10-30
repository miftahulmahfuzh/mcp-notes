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
