import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../../mcp/tools.js';
import type { Connector } from '../types.js';
import { isRealDate, resolvePeriod, resolveRange, type PeriodScope } from './periods.js';
import {
  listRuns,
  readPeriodInsight,
  readPeriodTotals,
  readRunDetails,
  readRunRowsByDate,
  readRunRowsById,
  runBrief,
} from './queries.js';

const UNITS_NOTE =
  'Units are the app\'s own: distance_m metres, duration_sec seconds, avg_pace_sec seconds per km, heart rate bpm; ' +
  'each comes with a readable companion (km, duration "h:mm:ss", avg_pace "m:ss /km"). Dates are WIB (Asia/Jakarta) calendar days.';

const dayField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** runs_list: reviewed runs in an inclusive WIB day range, newest first, plus period totals. */
export async function runsList(connector: Connector, from: string, to: string | undefined, now: Date = new Date()) {
  const range = resolveRange(from, to, now);
  const [list, totals] = await Promise.all([
    listRuns(connector, range.from, range.to),
    readPeriodTotals(connector, range.from, range.to),
  ]);
  return { from: range.from, to: range.to, totals, runs: list.runs, truncated: list.truncated };
}

/** runs_get: one run by id, or every run on a day, in full. */
export async function runsGet(connector: Connector, id: string | undefined, date: string | undefined) {
  const byId = id !== undefined && id.trim() !== '';
  const byDate = date !== undefined && date.trim() !== '';
  if (byId === byDate) throw new Error('give exactly one of id (a run id from runs_list) or date (YYYY-MM-DD)');
  if (byId) {
    const runId = (id as string).trim();
    const rows = await readRunRowsById(connector, runId);
    if (rows.length === 0) throw new Error(`run-insights has no run with id "${runId}"`);
    return { id: runId, ...(await readRunDetails(connector, rows)) };
  }
  const day = (date as string).trim();
  if (!isRealDate(day)) throw new RangeError(`date "${day}" is not a real day (YYYY-MM-DD)`);
  const details = await readRunDetails(connector, await readRunRowsByDate(connector, day));
  return { date: day, ...details };
}

/** runs_review: the app's latest week or month review for a period, plus that period's totals and runs. */
export async function runsReview(connector: Connector, scope: PeriodScope, key: string | undefined, now: Date = new Date()) {
  const period = resolvePeriod(scope, key, now);
  const [insight, totals, list] = await Promise.all([
    readPeriodInsight(connector, period),
    readPeriodTotals(connector, period.from, period.to),
    listRuns(connector, period.from, period.to),
  ]);
  return {
    scope: period.scope,
    key: period.key,
    from: period.from,
    to: period.to,
    review: insight,
    review_missing: insight === null ? `run-insights has no ${period.scope} review stored for ${period.key}` : null,
    totals,
    runs: list.runs.map(runBrief),
  };
}

export function registerRunsCurated(server: McpServer, connector: Connector): void {
  server.registerTool(
    'runs_list',
    {
      title: 'Runs in a date range',
      description:
        'The user\'s runs from run-insights (Apple Watch runs read from screenshots) between two dates, inclusive, newest first. ' +
        'Only reviewed runs are counted, as in the app. Per run: id, date, start time, activity type, intent, distance, duration, ' +
        'average pace, average and max heart rate, cadence, elevation, kcal, 1-minute heart-rate drop after the run, and the headline ' +
        'and verdict of the app\'s own analysis of that run when it has one. Also returns totals for the period (runs, distance, time, ' +
        'distance-weighted average pace, time-weighted average heart rate, longest run). To compare periods ("this month vs last month") ' +
        'call it once per period. For one run in full (splits, zones, the full analysis text) use runs_get with its id. ' +
        UNITS_NOTE,
      inputSchema: {
        from: dayField.describe('First day, inclusive, YYYY-MM-DD (WIB).'),
        to: dayField.optional().describe('Last day, inclusive, YYYY-MM-DD (WIB). Default: today.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => run(() => runsList(connector, from, to), { compact: true }),
  );

  server.registerTool(
    'runs_get',
    {
      title: 'One run in full',
      description:
        'One run from run-insights in full: give either id (from runs_list) or date (YYYY-MM-DD, returns every run that day, ' +
        'e.g. "my run yesterday"). Returns all metrics, per-km splits in km order (the last km flagged partial when it was not a full km), ' +
        'time in heart-rate zones 1-5 with bpm bounds and share of time, the runner\'s note, whether the run was reviewed, and the app\'s ' +
        'latest analysis of the run (headline, verdict, what happened, observations, what to do next, a question for the runner). ' +
        'profile carries the runner\'s max and resting heart rate for context. Unreviewed runs are included and flagged reviewed: false. ' +
        UNITS_NOTE,
      inputSchema: {
        id: z.string().optional().describe('Run id, as returned by runs_list.'),
        date: dayField.optional().describe('A WIB day, YYYY-MM-DD: returns every run on that day.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, date }) => run(() => runsGet(connector, id, date), { compact: true }),
  );

  server.registerTool(
    'runs_review',
    {
      title: 'Weekly or monthly running review',
      description:
        'The run-insights app\'s own weekly or monthly review (headline, verdict, what happened, observations, what to do next, ' +
        'a question for the runner) for one period, plus totals and a short list of the reviewed runs in it. scope "week" is an ISO week, ' +
        'Monday to Sunday; scope "month" is a calendar month. key is "2026-W34" for a week, "2026-08" for a month, or any day ' +
        'YYYY-MM-DD inside the period; omit it for the current week or month. review is null (and review_missing says so) when the app ' +
        'has not generated one for that period; the totals are still correct. ' +
        UNITS_NOTE,
      inputSchema: {
        scope: z.enum(['week', 'month']).describe('"week" (ISO, Monday-Sunday) or "month".'),
        key: z
          .string()
          .optional()
          .describe('"2026-W34", "2026-08", or a day YYYY-MM-DD inside the period. Default: the period containing today (WIB).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, key }) => run(() => runsReview(connector, scope, key), { compact: true }),
  );
}
