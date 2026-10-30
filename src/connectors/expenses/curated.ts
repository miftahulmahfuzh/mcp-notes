import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../../mcp/tools.js';
import type { Connector } from '../types.js';
import { EATING_CATEGORIES, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from './categories.js';
import { DATE_RE, MONTH_RE } from './dates.js';
import {
  DEFAULT_MONTHS,
  DEFAULT_TOP,
  MAX_MONTHS,
  MAX_SPENDING_DAYS,
  MAX_TOP,
  fetchGroup,
  fetchMonths,
  fetchSpending,
} from './queries.js';

const CATEGORY_LIST = EXPENSE_CATEGORIES.map((c) => `${c} (${EXPENSE_CATEGORY_LABELS[c]})`).join(', ');

const categoriesField = z
  .array(z.enum(EXPENSE_CATEGORIES))
  .min(1)
  .max(EXPENSE_CATEGORIES.length)
  .optional()
  .describe(
    `Only count items in these categories; omit for all spending. Slugs (Indonesian label): ${CATEGORY_LIST}. ` +
      `"meals" is everyday meals only; for all eating and drinking pass ${EATING_CATEGORIES.join(', ')}.`,
  );

const dayField = (role: string) =>
  z.string().regex(DATE_RE, 'expected YYYY-MM-DD').describe(`${role}, a WIB (Asia/Jakarta) calendar day as YYYY-MM-DD, inclusive.`);

/**
 * expense-tracking's curated tools: one call answers the common spending questions, with the app's
 * own arithmetic (integer rupiah sums of expense_items.amount_idr, WIB days on expense_groups.occurred_on).
 * Read-only: every query goes through connector.query (read-only session + BEGIN READ ONLY).
 */
export function registerExpensesCurated(server: McpServer, connector: Connector): void {
  server.registerTool(
    'expenses_spending',
    {
      title: 'Spending in a date range',
      description:
        "Spending from expense-tracking (the user's own expense app; amounts in Indonesian rupiah) for an inclusive range of WIB (Asia/Jakarta) calendar days, in one call. " +
        'Returns total_idr, item_count, group_count (expense groups = one pasted receipt/outing), average_per_day_idr, ' +
        'by_category (slug, Indonesian label, total_idr, share_pct), by_day (only days with spending, with weekday), ' +
        'by_week (every ISO week Monday-Sunday the range touches, keyed by its Monday, zero-filled; weeks cut by the range have partial=true and fewer days_in_range), ' +
        'and largest_items (biggest single items with group_title, occurred_on and group_id; pass group_id to expenses_get for the whole receipt). ' +
        'All money is integer rupiah, never converted. Pass categories to narrow the question, so "how much on meals in October and which week was worst" is one call ' +
        '(from 2026-10-01, to 2026-10-31, categories ["meals"], then compare by_week, minding partial weeks). "This week" is Monday through today (today_wib is in the result). ' +
        `Ranges up to ${MAX_SPENDING_DAYS} days; for month-by-month trends use expenses_months. ` +
        'Read the numbers for what they show (what dominated, unusual days, big one-offs) rather than only restating totals.',
      inputSchema: {
        from: dayField('First day'),
        to: dayField('Last day'),
        categories: categoriesField,
        top: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP)
          .optional()
          .describe(`How many largest items to return (default ${DEFAULT_TOP}, max ${MAX_TOP}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to, categories, top }) =>
      run(() => fetchSpending(connector, { from, to, categories, top }), { compact: true }),
  );

  server.registerTool(
    'expenses_get',
    {
      title: 'One expense group',
      description:
        'One expense group from expense-tracking by id (a group is one pasted receipt or outing, e.g. "bakar duit tuesday"): ' +
        'title, WIB date (occurred_on), note, raw_text (the text the user originally pasted), its items in the app\'s order with integer-rupiah amount_idr and category (slug + Indonesian label), ' +
        'total_idr, item_count, and its photos (photo_count and public blob_url for each). ' +
        'Get group ids from expenses_spending (largest_items[].group_id) or expenses_sql.',
      inputSchema: {
        id: z.string().min(1).max(64).describe('The expense group id (expense_groups.id, a 12-character nanoid; case-sensitive).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => run(() => fetchGroup(connector, id), { compact: true }),
  );

  server.registerTool(
    'expenses_months',
    {
      title: 'Monthly spending totals',
      description:
        'Monthly spending totals from expense-tracking for the last N months ending at to_month (default: the current WIB month), oldest first, ' +
        'zero-filled so a month with no spending shows 0, the same series as the app\'s monthly chart. Months are WIB calendar months on the expense date; money is integer rupiah. ' +
        'Each month has total_idr, item_count, group_count and status: complete, in_progress (month to date, so not comparable to a full month as is) or future. ' +
        'average_per_month_idr averages complete months only. Optional categories filter. ' +
        'Use it for trends and this-month-vs-last-month; use expenses_spending for one period in detail (categories, days, weeks, largest items).',
      inputSchema: {
        months: z
          .number()
          .int()
          .min(1)
          .max(MAX_MONTHS)
          .optional()
          .describe(`How many months, counting to_month (default ${DEFAULT_MONTHS}, max ${MAX_MONTHS}).`),
        to_month: z
          .string()
          .regex(MONTH_RE, 'expected YYYY-MM')
          .optional()
          .describe('Last month of the series as YYYY-MM (WIB). Default: the current month.'),
        categories: categoriesField,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ months, to_month, categories }) =>
      run(() => fetchMonths(connector, { months, toMonth: to_month, categories }), { compact: true }),
  );
}
