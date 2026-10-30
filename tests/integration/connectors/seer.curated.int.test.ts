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
