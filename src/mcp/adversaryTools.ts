import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AdversaryReader } from '../adversary/read.js';
import { ADVERSARY_TOOL_NAMES } from '../chat/status.js';
import { createSeerConnector } from '../connectors/seer/index.js';
import { run, type ToolDeps } from './tools.js';

const [OVERVIEW, VERDICTS, SCORECARD] = ADVERSARY_TOOL_NAMES;

const strategyField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/)
  .describe("A Seer strategy id such as 'A-GT' or 'RAW35-FR-GT' (any case). A twin's id ('A-GT-CX') means its original. adversary_overview lists them.");

const OVERVIEW_DESCRIPTION =
  "Seer Adversarial: Claude reviews the picks of every method on Seer's roster before they are bought, and each method has a " +
  "Claude twin, a paper book that runs the same method but drops what Claude objected to. Returns roster (every method, active " +
  'first, then retired), methods (each active method with a twin: returns.original / .twin / .spy, money-weighted with deposits ' +
  "included, over the twin's record since it started; objections.objected / .reviewed / .fell_after (objected stocks that then " +
  'did worse than the kept picks); coverage: decisions reviewed in time, absent (nobody reviewed before the open, or too late), ' +
  "paused (the owner turned automatic reviews off), pending (not open yet); checklist.original / .twin: Seer's five go-live rules " +
  "with Seer's own wording in seer.label / seer.val; a twin's backtest is 'na' because Claude knows how the past turned out), " +
  'cause (twins ahead of SPY, extra_profit_usd beyond the originals, drawdown_delta_pts), latest (the newest objections and ' +
  "can't-tell verdicts with reasons, sources and the host that made them), last_review and reviewer (this machine's reviewer, " +
  'null when it is off). Fractions: 0.054 = +5.4%. Money: USD. Quote the numbers as given; never compute or invent your own.';

const VERDICTS_DESCRIPTION =
  "Claude's verdicts on Seer picks: agree, object, or unsure (Claude could not tell, so the pick is kept). Each has the stock " +
  "(symbol), the decision session it was for, a plain-words reason, numbered sources (url, publisher, fetched_at), the model, " +
  'prompt_version, lens and host, and late: true when it was decided after the session opened (kept for the record, but the twin ' +
  'ignored it). Without session it answers each method\'s latest decision, so "what did Claude object to today?" is ' +
  'verdict "object" with no other filter. sessions[] gives each decision\'s coverage (reviewed, absent, paused, pending).';

const SCORECARD_DESCRIPTION =
  "Whether Claude's objections were right for one method. record.points: for each objection whose horizon has passed, the stock's " +
  "return over the method's own horizon (5 sessions for the daily dip-buy method, until the next rebalance for a book) against " +
  'the average of the picks Claude kept on the same decision; gap_pts below 0 means the dropped stock did worse, i.e. Claude was ' +
  'right; outcome worse / same (within half a point) / better. record.summary counts them; record.pending lists objections still ' +
  "inside their horizon. duel (daily methods with C, Seer's news model): on the nights C and Claude disagreed, who was right, " +
  'judged against the names neither blocked. Few calls cannot tell skill from luck; say so.';

/** Read-only Seer Adversarial tools (phase 5). Seer is read through the connector, per call. */
export function registerAdversaryTools(server: McpServer, deps: Pick<ToolDeps, 'connectors' | 'adversary'>): void {
  const reader = (): AdversaryReader => new AdversaryReader(deps.connectors?.seer ?? createSeerConnector());

  server.registerTool(
    OVERVIEW,
    { title: 'Seer Adversarial overview', description: OVERVIEW_DESCRIPTION, annotations: { readOnlyHint: true } },
    async () =>
      run(async () => reader().overview(deps.adversary ? await deps.adversary.status().catch(() => null) : null), { compact: true }),
  );

  server.registerTool(
    VERDICTS,
    {
      title: "Claude's verdicts on Seer picks",
      description: VERDICTS_DESCRIPTION,
      inputSchema: {
        strategy: strategyField.optional(),
        session: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('The decision session, YYYY-MM-DD (the day the stock would be bought). Omit for each method\'s latest decision.'),
        verdict: z
          .enum(['agree', 'object', 'unsure'])
          .optional()
          .describe("Only this verdict: 'object' (Claude dropped it), 'agree', or 'unsure' (could not tell; kept)."),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many verdicts. Default 50.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ strategy, session, verdict, limit }) =>
      run(
        () =>
          reader().verdicts({
            ...(strategy !== undefined ? { strategy } : {}),
            ...(session !== undefined ? { session } : {}),
            ...(verdict !== undefined ? { verdict } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        { compact: true },
      ),
  );

  server.registerTool(
    SCORECARD,
    {
      title: "Claude's record on one Seer method",
      description: SCORECARD_DESCRIPTION,
      inputSchema: { strategy: strategyField },
      annotations: { readOnlyHint: true },
    },
    async ({ strategy }) => run(() => reader().scorecard(strategy), { compact: true }),
  );

  const reviewerOff = { ok: false, code: 'reviewer_off', message: 'The Seer Adversarial reviewer is not running on this machine (NOTESD_ADVERSARY=off), so a redo cannot be written.' };
  const symbolField = z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z0-9.-]+$/)
    .describe("The stock's ticker, e.g. 'SLB'.");
  const sessionField = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('The decision session, YYYY-MM-DD. Omit for the next one that has not opened.');

  server.registerTool(
    'adversary_redo_context',
    {
      title: 'Redo a Seer Adversarial review: context and clock',
      description:
        "For /redo only. Says whether redoing Claude's review of one pick is still fresh: a verdict counts only when decided before the US open (09:30 New York) of the pick's session, so after that a redo is stale and nothing is written. " +
        "Returns can_redo, a plain message, the clock (open_utc, open_wib, start_by_wib, minutes_to_open; state fresh | closing | closed), the existing verdict, and, when fresh, the facts of the pick, the method's lens and the rules to follow. " +
        "When can_redo is false, stop and tell the owner the message in a sentence or two; do not research. strategy takes 'A-GT' or a short form like 'A'.",
      inputSchema: { strategy: strategyField, symbol: symbolField, session: sessionField },
      annotations: { readOnlyHint: true },
    },
    async ({ strategy, symbol, session }) =>
      run(async () => (deps.adversary ? deps.adversary.redoContext({ strategy, symbol, session_date: session }) : reviewerOff), { compact: true }),
  );

  server.registerTool(
    'adversary_redo_submit',
    {
      title: 'Redo a Seer Adversarial review: write the verdict',
      description:
        "For /redo only. Writes your verdict on one pick to Seer, replacing the earlier one. Call it only after adversary_redo_context said can_redo and you researched with web search, opening every page you cite. " +
        "The clock is checked again here and nothing is written once the session has opened. agree or object without at least one source becomes unsure. reason: at most 600 characters, plain words for a non-trader.",
      inputSchema: {
        strategy: strategyField,
        symbol: symbolField,
        session: sessionField,
        verdict: z.enum(['agree', 'object', 'unsure']),
        reason: z.string().min(1).max(600),
        sources: z
          .array(
            z.object({
              url: z.string().url().describe('A page you opened with WebFetch, copied exactly.'),
              title: z.string().optional(),
              publisher: z.string().optional(),
              published_at: z.string().optional().describe('ISO 8601 date when the page says when it was published.'),
            }),
          )
          .max(12),
        model: z.string().max(80).optional().describe('Your exact model id.'),
      },
    },
    async ({ strategy, symbol, session, verdict, reason, sources, model }) =>
      run(
        async () => (deps.adversary ? deps.adversary.redoSubmit({ strategy, symbol, session_date: session, verdict, reason, sources, model }) : reviewerOff),
        { compact: true },
      ),
  );
}
