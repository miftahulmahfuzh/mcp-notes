import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

export const SEER_ABOUT: SystemAbout = {
  summary: "the owner's quantitative trading lab: paper strategies, positions, trades, a leaderboard, and Sera, the method lab (lab.sqlite)",
  db:
    'strategies: id (e.g. RAW35-FR-GT), name, sub, engine (bracket, book, benchmark), status (active, retired), is_champion, is_benchmark, paper_start/paper_end, promoted_from (the lab method id), params jsonb. ' +
    'equity_snapshots: daily cash_usd and equity_usd per strategy. orders: bracket-engine picks (status pending/open/closed/expired, entry/stop/target prices, fill_price, pnl_usd, mark). ' +
    'book_positions: open holdings of book-engine strategies; book_trades: closed book trades; book_fills: fills. bars: daily prices; fx_rates: usd_idr. sean_*: the owner\'s own real trades. ' +
    'Money is US dollars (numeric); returns are fractions (0.05 = 5%); date columns are NYSE session dates (America/New_York). The leaderboard is not stored: it is computed from equity_snapshots and closed P&L.',
  lab:
    'lab.sqlite is Sera, the method lab. methods: one research idea (id M0001... or H-*, name, family, hypothesis, status idea/registered/rejected/dev-eligible/promoted/test-passed/test-failed/paper/blocked-data, analysis, verdict). ' +
    'trials: one backtest of a candidate variant of a method: n, method_id, candidate_id, window (dev or test), start/end, run_at, total_return, cagr, max_drawdown, profit_factor, trades, sharpe, mar (CAGR over max drawdown), dsr (deflated Sharpe), n_trials_at_run, spy_tr_return/spy_tr_cagr (SPY total-return benchmark), eligible (the verdict frozen at run time), failed (reasons). ' +
    "The lab's best variant per method is its dev trial with the highest mar (ties: lowest n). trial_funding: money-weighted returns under a deposit schedule (mwr, spy_tr_mwr). insights: the lab journal. Returns are fractions; the tables are append-only. Query it with seer_sql source \"lab\" (SQLite dialect).",
};

export function createSeerConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('seer', options);
}
