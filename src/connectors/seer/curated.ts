import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../../mcp/tools.js';
import type { Connector } from '../types.js';
import { seerLeaderboard } from './leaderboard.js';
import { seerPositions } from './positions.js';
import { METHOD_STATUSES, SERA_DEFAULT_LIMIT, SERA_MAX_LIMIT, seerSeraBest } from './sera.js';

const LEADERBOARD_DESCRIPTION =
  "Seer's paper-trading leaderboard, ranked the way the Seer app ranks it. Strategies are compared only over the dates " +
  'every ranked strategy has an equity snapshot (the common window, returned as window.from / window.to / window.sessions); ' +
  'a ranking needs at least 63 shared sessions, and a strategy that overlaps too little is dropped so the rest can still be ranked. ' +
  'Order: annualised Sharpe of daily returns over the window (rf = 0, x sqrt(252)) highest first, no Sharpe last; then window ' +
  'total return; then smaller max drawdown; then id. ranked[] has rank, window figures (total_return, cagr, max_drawdown, sharpe) ' +
  'and since_start figures over the whole record (total_return, max_drawdown, win_rate, profit_factor where "infinite" means ' +
  'no losing trade, trades, months), plus sessions, days, paper_start and current_equity_usd. not_ranked[] holds the benchmark ' +
  '(SPY, the yardstick, with its figures over the same window), retired strategies (record kept, never ranked) and strategies ' +
  'too new to share 63 sessions, each with not_ranked_reason. Returns are fractions (0.12 = +12%); money is USD. Always name the ' +
  'window when you say which strategy leads. If window is null nothing is ranked yet: say so, and use shared_sessions to say how ' +
  'far off a ranking is.';

const POSITIONS_DESCRIPTION =
  'Open paper positions in Seer, grouped by strategy (live strategies are listed even when flat). bracket[] holds open bracket ' +
  "orders: entry, mark (the order's own mark, else the symbol's latest stored close, else the fill price; mark_source says which), " +
  'take_profit / stop_loss, day N of max_days, value, weight of equity, unrealised P&L = (mark - entry) x shares. book[] holds ' +
  'book and benchmark holdings: value, cost, income (dividends), unrealised P&L = value + income - cost (fees included), ' +
  'exit_pending when a sell executes at the next open. Each strategy also has equity_usd, open_value_usd and unrealised_pnl_usd. ' +
  'Money is USD exactly as Seer stores it; fx.usd_idr is the latest stored rate if the user wants rupiah. Pass strategy (an id ' +
  "such as 'RAW35-FR-GT'; seer_leaderboard lists them) for one strategy. include_pending adds what is queued for the next " +
  "session: pending bracket orders, or a book strategy's target weights for its pending decision session.";

const SERA_DESCRIPTION =
  "The best Sera research result per method, read from Seer's lab (lab.sqlite). Each method's best variant is chosen by the " +
  "lab's own rule: the dev-window trial with the highest MAR (CAGR / max drawdown), ties to the earlier trial; never chosen on " +
  'DSR. Methods are listed best MAR first. Per method: name, family, status, hypothesis (shortened), dev_trials (how many dev ' +
  "variants it ran), and best: the trial's candidate_id, run_at, window dates, total_return, cagr, max_drawdown, profit_factor, " +
  "trades, sharpe, mar, dsr, n_trials_at_run, spy_tr_return (SPY total return over the same window), funding (money-weighted " +
  'returns when the trial was funded with deposits) and hurdles recomputed from those numbers (beats SPY, money-weighted when ' +
  'funded; PF >= 1.3; trades >= 100). test_trials[] lists the out-of-sample test-window trials for that method, if any. ' +
  'eligible_at_run is the lab verdict AS OF THE RUN DATE: the deflated Sharpe discounts for how many trials had been run, so a ' +
  'variant eligible then may not clear the bar at today\'s larger trial count, and this tool does not re-derive DSR. Say ' +
  '"eligible when it ran" rather than "eligible". Filters: status (method status), only_eligible (choose each method\'s best ' +
  'among trials stored eligible), limit (default 25). Returns are fractions.';

export function registerSeerCurated(server: McpServer, connector: Connector): void {
  server.registerTool(
    'seer_leaderboard',
    {
      title: 'Seer leaderboard',
      description: LEADERBOARD_DESCRIPTION,
      annotations: { readOnlyHint: true },
    },
    async () => run(() => seerLeaderboard(connector), { compact: true }),
  );

  server.registerTool(
    'seer_positions',
    {
      title: 'Seer open positions',
      description: POSITIONS_DESCRIPTION,
      inputSchema: {
        strategy: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("A strategy id, e.g. 'RAW35-FR-GT' (case-insensitive). Omit for every live strategy."),
        include_pending: z
          .boolean()
          .optional()
          .describe('Also list orders and book targets queued for the next session. Default false.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ strategy, include_pending }) =>
      run(() => seerPositions(connector, { strategy, includePending: include_pending ?? false }), { compact: true }),
  );

  server.registerTool(
    'seer_sera_best',
    {
      title: 'Sera best variant per method',
      description: SERA_DESCRIPTION,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(SERA_MAX_LIMIT)
          .optional()
          .describe(`How many methods to return, best MAR first. Default ${SERA_DEFAULT_LIMIT}.`),
        status: z.enum(METHOD_STATUSES).optional().describe('Only methods in this lab status, e.g. "dev-eligible".'),
        only_eligible: z
          .boolean()
          .optional()
          .describe("Pick each method's best among trials the lab stored as eligible when they ran. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, status, only_eligible }) =>
      run(() => seerSeraBest(connector.lab, { limit, status, onlyEligible: only_eligible ?? false }), { compact: true }),
  );
}
