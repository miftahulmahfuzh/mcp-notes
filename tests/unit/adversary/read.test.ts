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
