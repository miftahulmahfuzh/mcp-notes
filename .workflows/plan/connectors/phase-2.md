# Phase 2: expense-tracking curated tools

**Plan set:** `CONNECTORS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-124712-C5N7_code_analyzer.md`
**Satisfies:** R2 (curated tools for expense-tracking: WIB dates, integer rupiah), R5 (unit tests for the pure helpers, Docker integration test seeded from the sibling repo's migrations)
**Depends on:** Phase 1
**Difficulty:** NORMAL
**Package:** `src/connectors/expenses`

---

## Goal

Replace the phase-1 no-op `registerExpensesCurated` with three read-only tools: `expenses_spending`, `expenses_get` and `expenses_months`. Each answers a common spending question in one call, using the same arithmetic the expense-tracking app uses for its screens. After this phase "how much did I spend on meals in October, and which week was the worst?" is a single `expenses_spending` call. Every money value is integer rupiah, and every date is a WIB calendar day on `expense_groups.occurred_on`.

## Interface Contract

**Deletes:** nothing. The body of phase 1's stub `registerExpensesCurated` is replaced, and its signature stays the same.
**Renames:** none
**Creates:**
- `registerExpensesCurated(server: McpServer, connector: Connector): void`, now real (`src/connectors/expenses/curated.ts`). It registers the MCP tools `expenses_spending`, `expenses_get` and `expenses_months`, exactly the three curated names `CONNECTOR_TOOL_NAMES.expenses` lists after `_schema`/`_sql`.
- `src/connectors/expenses/categories.ts`: `EXPENSE_CATEGORIES` (17 slugs), `ExpenseCategory`, `EXPENSE_CATEGORY_LABELS`, `EATING_CATEGORIES`, `isExpenseCategory`, `toExpenseCategory`, `categoryLabel`
- `src/connectors/expenses/dates.ts`: `WIB_TIME_ZONE`, `DATE_RE`, `MONTH_RE`, `isValidDateIso`, `isValidMonthKey`, `addDays`, `daysInclusive`, `weekdayOf`, `isoWeekMonday`, `isoWeekKey`, `todayWib`, `addMonths`
- `src/connectors/expenses/queries.ts`: SQL constants, `rowsOf`, `toInt`, `shareOf`, `buildDayTotals`, `buildWeekTotals`, `buildCategoryTotals`, `buildLargestItems`, `fillZeroMonths`, `validateRange`, `fetchSpending`, `fetchGroup`, `fetchMonths`, plus the result interfaces
**Signature changes:** none
**Requires (from earlier phases):**
- Phase 1: `src/connectors/types.ts` exports `Connector`, `ReadOnlySource`, `QueryResult` and `QueryOptions` exactly as the plan index contract gives them (`query(sql, params?, { maxRows? })` → `{ columns, rows, row_count, truncated }`; one parameterised SELECT run as `SELECT * FROM (<sql>) AS q LIMIT cap+1` inside `BEGIN READ ONLY`; `int8` comes back as a number when safe, `numeric` as a number, `date`/`timestamptz` as text).
- Phase 1: `src/connectors/rows.ts` exports `toObjects(result: QueryResult): Record<string, unknown>[]`. This phase uses it (as the local alias `rowsOf`) instead of its own copy.
- Phase 1: `src/connectors/expenses/curated.ts` exists as a stub exporting `registerExpensesCurated(server: McpServer, connector: Connector): void`, and `register.ts` calls it once per `/mcp` server build with the expenses connector.
- Phase 1: `src/mcp/tools.ts` exports `run(fn, options?: { compact?: boolean }): Promise<CallToolResult>`. Every handler here passes `{ compact: true }`. A thrown `ConnectorError` renders as its bare message; any other `Error` as `error: <message>`.
- Phase 1: `tests/integration/connectors/harness.ts` exports `describeWithRepo(id, name, fn)` (sync), `systemDbUrl(id): string` (sync; a **writable admin** URL to the per-system DB migrated from `~/expense-tracking/drizzle`), `withAdmin(url, fn)` (async, refuses Neon), `truncateSystem(id): Promise<void>`, `connectorFor(id, overrides?): Connector` (sync) and `cleanupHarness(): void`.
- Phase 1: the unit vitest include still matches `tests/unit/**/*.test.ts`, and the integration include still matches `tests/integration/**/*.int.test.ts` with `TEST_CONNECTORS_URL` set by `scripts/test-int.sh`.
**Leaves alone (owned by others):** `src/connectors/{names,types,env,pg,guard,lab,errors,schema,sql,register}.ts`, `src/connectors/expenses/index.ts`, `src/mcp/**`, `tests/integration/connectors/harness.ts` / `globalSetup.ts` (Phase 1); `src/connectors/runs/**` (Phase 3); `src/connectors/seer/**` (Phase 4); `src/chat/**`, `claude/**` (Phase 5); `web/**` (Phase 6); README (Phases 1, 5).

## Files

| File | Action | What changes |
|---|---|---|
| `src/connectors/expenses/curated.ts` | replace (phase-1 stub, whole file from line 1) | registers the three tools with zod inputs and descriptions written for Claude |
| `src/connectors/expenses/categories.ts` | create | the 17 slugs and Indonesian labels, copied as data from `~/expense-tracking/lib/categories.ts` `CATEGORY_META` |
| `src/connectors/expenses/dates.ts` | create | pure WIB calendar helpers (ISO weeks, month math), mirroring `~/expense-tracking/lib/format.ts` |
| `src/connectors/expenses/queries.ts` | create | parameterised SQL, row shaping, `fetchSpending` / `fetchGroup` / `fetchMonths` |
| `tests/unit/connectors/expenses.dates.test.ts` | create | ISO weeks, month math, WIB today |
| `tests/unit/connectors/expenses.categories.test.ts` | create | 17 slugs, labels, unknown → other |
| `tests/unit/connectors/expenses.queries.test.ts` | create | builders and `fetch*` against a fake `ReadOnlySource` |
| `tests/integration/connectors/expenses.curated.int.test.ts` | create | seeded Docker DB, all three tools over an in-memory MCP client |

## Semantics mirrored from expense-tracking (read, not imported)

- Money: `expense_items.amount_idr` is whole rupiah (`bigint`, ≥ 0). Totals are never stored, only `SUM(amount_idr)` (`lib/db/queries.ts` everywhere).
- Day: `expense_groups.occurred_on` is the Asia/Jakarta calendar day (`lib/db/schema.ts:96`). A group has exactly one day, so the per-day `count(DISTINCT g.id)` values add up exactly to a period's group count.
- Month: `'YYYY-MM'`, half-open `[m-01, next-01)` (`lib/format.ts:192`). Monthly totals use `to_char(occurred_on,'YYYY-MM')` with a LEFT JOIN to items and zero-fill in JS (`getMonthlyTotals` / `fillZeroMonths`, `lib/db/queries.ts:526-575`).
- Largest item tie-break: `amount_idr DESC, occurred_on DESC, item id ASC` (`getBiggestExpense`, `lib/db/queries.ts:614`).
- Group detail: items ordered `sort_order, id`, photos ordered `sort_order, created_at` (`getGroupDetail`, `lib/db/queries.ts:367`). Total = sum of items.
- Category: 17 slugs. An unknown stored string degrades to `other` at read time (`toCategory`, `lib/categories.ts`), and the by-category totals here do the same.
- Week: ISO week Monday to Sunday. The app keys its "this week" summary on the Jakarta ISO week (`expense_insights.scope_key`, e.g. `2026-W34`).
- No `user_id` filter (plan decision: each app has one owner).

## Implementation Steps

### Step 1: Category data
**File:** `src/connectors/expenses/categories.ts:1` (new)
**Change:** copy the 17 slugs and their Indonesian labels as plain data. Nothing is imported from `~/expense-tracking`.
**Code:**
```ts
/**
 * expense-tracking's 17 expense categories, copied as DATA from ~/expense-tracking/lib/categories.ts
 * (CATEGORY_META: id + Indonesian label). Never imported: that repo changes on its own. If it adds a
 * category, add it here too; until then the new slug reads as `other`, which is what the app itself
 * does with an unknown string (toCategory).
 *
 * Order is the app's display order, grouped by family: eating, transport, bills & home, leisure,
 * health, other.
 */
export const EXPENSE_CATEGORIES = [
  'meals',
  'jajan',
  'dining',
  'snacks',
  'drinks',
  'transport',
  'fuel',
  'parking',
  'bills',
  'internet',
  'utilities',
  'housing',
  'entertainment',
  'cinema',
  'health',
  'grooming',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Indonesian display labels, verbatim from CATEGORY_META[slug].label. */
export const EXPENSE_CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  meals: 'Makan Harian',
  jajan: 'Jajan',
  dining: 'Fancy Makan Berat',
  snacks: 'Snack',
  drinks: 'Beverage',
  transport: 'Transport',
  fuel: 'Bensin',
  parking: 'Sewa Parkir Motor',
  bills: 'Tagihan',
  internet: 'Internet',
  utilities: 'Listrik & Air Apart',
  housing: 'Tempat Tinggal',
  entertainment: 'Hiburan',
  cinema: 'Bioskop',
  health: 'Kesehatan',
  grooming: 'Pangkas Rambut',
  other: 'Lainnya',
};

/** The eating-and-drinking family, for "all food" questions ('meals' alone is daily meals only). */
export const EATING_CATEGORIES = ['meals', 'jajan', 'dining', 'snacks', 'drinks'] as const satisfies readonly ExpenseCategory[];

export const DEFAULT_EXPENSE_CATEGORY: ExpenseCategory = 'other';

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/** Unknown or missing input degrades to `other`, as the app does at its DB read boundary. */
export function toExpenseCategory(value: unknown): ExpenseCategory {
  return isExpenseCategory(value) ? value : DEFAULT_EXPENSE_CATEGORY;
}

export function categoryLabel(value: unknown): string {
  return EXPENSE_CATEGORY_LABELS[toExpenseCategory(value)];
}
```
**Impact:** new file, no callers outside this directory.

### Step 2: WIB calendar helpers
**File:** `src/connectors/expenses/dates.ts:1` (new)
**Change:** pure date math on `'YYYY-MM-DD'` strings, done on UTC midnights so the host timezone cannot change a result. The only wall-clock read is `todayWib(now)`.
**Code:**
```ts
/**
 * Pure calendar helpers for the expenses connector.
 *
 * Every day is a WIB (Asia/Jakarta) calendar day written 'YYYY-MM-DD' (expense_groups.occurred_on
 * is exactly that); every month is 'YYYY-MM'. Arithmetic runs on UTC midnights of those calendar
 * days, so the host timezone never changes an answer. Mirrors ~/expense-tracking/lib/format.ts
 * (copied semantics, not imported). The wall clock enters only through todayWib(now).
 */

export const WIB_TIME_ZONE = 'Asia/Jakarta';
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function toUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A real calendar day as 'YYYY-MM-DD' ('2026-02-30' is not). */
export function isValidDateIso(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  return fromUtcMs(toUtcMs(value)) === value;
}

export function isValidMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_RE.test(value);
}

/** addDays('2026-10-31', 1) === '2026-11-01'. */
export function addDays(iso: string, n: number): string {
  return fromUtcMs(toUtcMs(iso) + n * DAY_MS);
}

/** Number of calendar days from `from` to `to`, both included. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS) + 1;
}

/** 'Mon' … 'Sun'. */
export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(toUtcMs(iso)).getUTCDay()] ?? 'Sun';
}

/** The Monday that starts the ISO week (Monday–Sunday) containing `iso`. */
export function isoWeekMonday(iso: string): string {
  const dow = new Date(toUtcMs(iso)).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

/** ISO 8601 week label, e.g. '2026-W41'. The year is the year of the week's Thursday. */
export function isoWeekKey(iso: string): string {
  const thursday = addDays(isoWeekMonday(iso), 3);
  const year = Number(thursday.slice(0, 4));
  const dayOfYear = Math.round((toUtcMs(thursday) - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
  const week = Math.ceil(dayOfYear / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Today in Asia/Jakarta as 'YYYY-MM-DD'. Pass `now` in tests. */
export function todayWib(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WIB_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** addMonths('2026-01', -1) === '2025-12'. Integer math, no Date. */
export function addMonths(month: string, delta: number): string {
  if (!isValidMonthKey(month)) throw new RangeError(`invalid month "${month}", expected YYYY-MM`);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}
```
**Impact:** new file.

### Step 3: SQL, row shaping and fetchers
**File:** `src/connectors/expenses/queries.ts:1` (new)
**Change:** three tool backends that take any `ReadOnlySource`, so the unit tests can pass a fake. All SQL is parameterised and there is one SELECT per call. No statement ends in `;`, because phase 1 wraps each one as a subquery. Ordering is applied again in JS, because the `SELECT * FROM (...) q LIMIT n` wrapper does not formally guarantee the inner order. Independent queries run in parallel with `Promise.all`, each on its own phase-1 connection.
**Code:**
```ts
import { toObjects } from '../rows.js';
import type { ReadOnlySource } from '../types.js';
import { EXPENSE_CATEGORIES, type ExpenseCategory, categoryLabel, toExpenseCategory } from './categories.js';
import {
  addDays,
  addMonths,
  daysInclusive,
  isValidDateIso,
  isValidMonthKey,
  isoWeekKey,
  isoWeekMonday,
  todayWib,
  weekdayOf,
} from './dates.js';

/* ---------------------------------------------------------------- limits */

export const MAX_SPENDING_DAYS = 366;
export const DEFAULT_TOP = 10;
export const MAX_TOP = 50;
export const DEFAULT_MONTHS = 6;
export const MAX_MONTHS = 60;
const MAX_ITEMS_PER_GROUP = 1000;
const MAX_PHOTOS_PER_GROUP = 200;
const MAX_CATEGORY_ROWS = 200;

/* ------------------------------------------------------------------- SQL */
/*
 * Params for the three spending queries: $1 from (date, inclusive), $2 to (date, inclusive),
 * $3 categories (text[] or NULL = all). LARGEST_ITEMS_SQL adds $4 top (int).
 * No user_id filter: each app has one owner (plan decision).
 */

const CATEGORY_FILTER = `($3::text[] IS NULL OR i.category = ANY($3::text[]))`;

export const SPENDING_BY_DAY_SQL = `
SELECT g.occurred_on::text AS day,
       sum(i.amount_idr)::bigint AS total_idr,
       count(i.id)::int AS item_count,
       count(DISTINCT g.id)::int AS group_count
FROM expense_groups g
JOIN expense_items i ON i.group_id = g.id
WHERE g.occurred_on >= $1::date AND g.occurred_on <= $2::date
  AND ${CATEGORY_FILTER}
GROUP BY g.occurred_on
ORDER BY g.occurred_on`;

export const SPENDING_BY_CATEGORY_SQL = `
SELECT i.category AS category,
       sum(i.amount_idr)::bigint AS total_idr,
       count(i.id)::int AS item_count,
       count(DISTINCT g.id)::int AS group_count
FROM expense_groups g
JOIN expense_items i ON i.group_id = g.id
WHERE g.occurred_on >= $1::date AND g.occurred_on <= $2::date
  AND ${CATEGORY_FILTER}
GROUP BY i.category
ORDER BY sum(i.amount_idr) DESC, i.category`;

export const LARGEST_ITEMS_SQL = `
SELECT i.id AS item_id,
       i.name AS name,
       i.amount_idr::bigint AS amount_idr,
       i.category AS category,
       g.id AS group_id,
       g.title AS group_title,
       g.occurred_on::text AS occurred_on
FROM expense_items i
JOIN expense_groups g ON g.id = i.group_id
WHERE g.occurred_on >= $1::date AND g.occurred_on <= $2::date
  AND ${CATEGORY_FILTER}
ORDER BY i.amount_idr DESC, g.occurred_on DESC, i.id ASC
LIMIT $4::int`;

/** $1 group id. */
export const GROUP_SQL = `
SELECT g.id AS id,
       g.title AS title,
       g.occurred_on::text AS occurred_on,
       g.note AS note,
       g.raw_text AS raw_text,
       g.created_at::text AS created_at,
       g.updated_at::text AS updated_at
FROM expense_groups g
WHERE g.id = $1`;

/** $1 group id. Mirrors getGroupDetail: sort_order, then id. */
export const GROUP_ITEMS_SQL = `
SELECT i.id AS id,
       i.name AS name,
       i.amount_idr::bigint AS amount_idr,
       i.category AS category,
       i.sort_order AS sort_order
FROM expense_items i
WHERE i.group_id = $1
ORDER BY i.sort_order, i.id`;

/** $1 group id. Mirrors getGroupDetail: sort_order, then created_at. */
export const GROUP_PHOTOS_SQL = `
SELECT p.id AS id,
       p.blob_url AS blob_url,
       p.width AS width,
       p.height AS height,
       p.sort_order AS sort_order,
       p.created_at::text AS created_at
FROM expense_photos p
WHERE p.group_id = $1
ORDER BY p.sort_order, p.created_at`;

/**
 * $1 first month start (date, inclusive), $2 month after the last (date, exclusive), $3 categories.
 * Mirrors getMonthlyTotals: LEFT JOIN so a group with no items keeps its month, zero-fill in JS.
 * group_count counts groups with at least one counted item (count(DISTINCT i.group_id) ignores NULL).
 */
export const MONTHLY_TOTALS_SQL = `
SELECT to_char(g.occurred_on, 'YYYY-MM') AS month,
       coalesce(sum(i.amount_idr), 0)::bigint AS total_idr,
       count(i.id)::int AS item_count,
       count(DISTINCT i.group_id)::int AS group_count
FROM expense_groups g
LEFT JOIN expense_items i ON i.group_id = g.id
WHERE g.occurred_on >= $1::date AND g.occurred_on < $2::date
  AND ${CATEGORY_FILTER}
GROUP BY to_char(g.occurred_on, 'YYYY-MM')`;

/* ---------------------------------------------------------- row helpers */

export type Row = Record<string, unknown>;

/** Compact { columns, rows } → one object per row keyed by column name. Phase 1's helper, under this file's name. */
export const rowsOf = toObjects;

/** Integer from a driver value (number, or numeric/int8 text). NULL → 0. */
export function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number from expense-tracking, got ${JSON.stringify(value)}`);
  return Math.round(n);
}

function toNullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : toInt(value);
}

function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function toNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Percentage with one decimal; 0 when the whole is 0. */
export function shareOf(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part * 1000) / whole) / 10;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const CATEGORY_ORDER = new Map<string, number>(EXPENSE_CATEGORIES.map((c, i) => [c, i]));

/* ---------------------------------------------------------------- shapes */

export interface CategoryTotal {
  category: ExpenseCategory;
  label: string;
  total_idr: number;
  share_pct: number;
  item_count: number;
  group_count: number;
}

export interface DayTotal {
  date: string;
  weekday: string;
  total_idr: number;
  item_count: number;
  group_count: number;
}

export interface WeekTotal {
  /** ISO week label, e.g. '2026-W41'. */
  week: string;
  monday: string;
  sunday: string;
  /** Days of this week inside [from, to]; 7 unless the range cuts the week. */
  days_in_range: number;
  partial: boolean;
  total_idr: number;
  item_count: number;
  group_count: number;
}

export interface LargestItem {
  item_id: string;
  name: string;
  amount_idr: number;
  category: ExpenseCategory;
  label: string;
  group_id: string;
  group_title: string;
  occurred_on: string;
}

export interface SpendingArgs {
  from: string;
  to: string;
  categories?: readonly ExpenseCategory[] | undefined;
  top?: number | undefined;
}

export interface SpendingResult {
  from: string;
  to: string;
  days: number;
  today_wib: string;
  categories: ExpenseCategory[] | null;
  total_idr: number;
  item_count: number;
  group_count: number;
  days_with_spending: number;
  average_per_day_idr: number;
  by_category: CategoryTotal[];
  by_day: DayTotal[];
  by_week: WeekTotal[];
  largest_items: LargestItem[];
}

export interface GroupItem {
  id: string;
  name: string;
  amount_idr: number;
  category: ExpenseCategory;
  label: string;
  sort_order: number;
}

export interface GroupPhoto {
  id: string;
  blob_url: string;
  width: number | null;
  height: number | null;
  sort_order: number;
}

export interface GroupDetail {
  id: string;
  title: string;
  occurred_on: string;
  note: string | null;
  raw_text: string | null;
  created_at: string;
  updated_at: string;
  total_idr: number;
  item_count: number;
  items: GroupItem[];
  photo_count: number;
  photos: GroupPhoto[];
}

export type MonthStatus = 'complete' | 'in_progress' | 'future';

export interface MonthTotal {
  month: string;
  status: MonthStatus;
  total_idr: number;
  item_count: number;
  group_count: number;
}

export interface MonthsArgs {
  months?: number | undefined;
  toMonth?: string | undefined;
  categories?: readonly ExpenseCategory[] | undefined;
}

export interface MonthsResult {
  to_month: string;
  months: number;
  today_wib: string;
  categories: ExpenseCategory[] | null;
  total_idr: number;
  /** Mean over `complete` months only; 0 when there are none. */
  average_per_month_idr: number;
  by_month: MonthTotal[];
}

/* -------------------------------------------------------------- builders */

/** Days with spending, oldest first. */
export function buildDayTotals(rows: readonly Row[]): DayTotal[] {
  return rows
    .map((r) => {
      const date = toText(r.day);
      return {
        date,
        weekday: weekdayOf(date),
        total_idr: toInt(r.total_idr),
        item_count: toInt(r.item_count),
        group_count: toInt(r.group_count),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Every ISO week (Monday–Sunday) that [from, to] touches, oldest first, zero-filled. Only days
 * inside the range count, so a week cut by the range is `partial` with fewer `days_in_range`.
 * group_count is exact: a group has one day.
 */
export function buildWeekTotals(from: string, to: string, days: readonly DayTotal[]): WeekTotal[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const weeks: WeekTotal[] = [];
  for (let monday = isoWeekMonday(from); monday <= to; monday = addDays(monday, 7)) {
    const sunday = addDays(monday, 6);
    const first = monday < from ? from : monday;
    const last = sunday > to ? to : sunday;
    let total = 0;
    let items = 0;
    let groups = 0;
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const day = byDate.get(d);
      if (day) {
        total += day.total_idr;
        items += day.item_count;
        groups += day.group_count;
      }
    }
    const daysInRange = daysInclusive(first, last);
    weeks.push({
      week: isoWeekKey(monday),
      monday,
      sunday,
      days_in_range: daysInRange,
      partial: daysInRange < 7,
      total_idr: total,
      item_count: items,
      group_count: groups,
    });
  }
  return weeks;
}

/**
 * Category totals, biggest first (ties in the app's display order). Unknown stored slugs merge into
 * `other`, as the app's toCategory does. group_count after a merge is an upper bound (a group with
 * items in two unknown slugs counts twice); it is exact for every known slug.
 */
export function buildCategoryTotals(rows: readonly Row[], grandTotal: number): CategoryTotal[] {
  const merged = new Map<ExpenseCategory, { total: number; items: number; groups: number }>();
  for (const r of rows) {
    const category = toExpenseCategory(r.category);
    const acc = merged.get(category) ?? { total: 0, items: 0, groups: 0 };
    acc.total += toInt(r.total_idr);
    acc.items += toInt(r.item_count);
    acc.groups += toInt(r.group_count);
    merged.set(category, acc);
  }
  return [...merged.entries()]
    .map(([category, acc]) => ({
      category,
      label: categoryLabel(category),
      total_idr: acc.total,
      share_pct: shareOf(acc.total, grandTotal),
      item_count: acc.items,
      group_count: acc.groups,
    }))
    .sort(
      (a, b) =>
        b.total_idr - a.total_idr || (CATEGORY_ORDER.get(a.category) ?? 99) - (CATEGORY_ORDER.get(b.category) ?? 99),
    );
}

/** Largest items with the app's tie-break: amount desc, newest day, then item id. */
export function buildLargestItems(rows: readonly Row[], top: number): LargestItem[] {
  return rows
    .map((r) => {
      const category = toExpenseCategory(r.category);
      return {
        item_id: toText(r.item_id),
        name: toText(r.name),
        amount_idr: toInt(r.amount_idr),
        category,
        label: categoryLabel(category),
        group_id: toText(r.group_id),
        group_title: toText(r.group_title),
        occurred_on: toText(r.occurred_on),
      };
    })
    .sort(
      (a, b) =>
        b.amount_idr - a.amount_idr ||
        (a.occurred_on < b.occurred_on ? 1 : a.occurred_on > b.occurred_on ? -1 : 0) ||
        (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0),
    )
    .slice(0, top);
}

/** Last `months` months ending at `toMonth`, oldest first, zero-filled (mirrors fillZeroMonths). */
export function fillZeroMonths(
  rows: readonly Row[],
  toMonth: string,
  months: number,
  currentMonth: string,
): MonthTotal[] {
  const byMonth = new Map(rows.map((r) => [toText(r.month), r]));
  const out: MonthTotal[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const month = addMonths(toMonth, -i);
    const r = byMonth.get(month);
    const status: MonthStatus = month < currentMonth ? 'complete' : month === currentMonth ? 'in_progress' : 'future';
    out.push({
      month,
      status,
      total_idr: r ? toInt(r.total_idr) : 0,
      item_count: r ? toInt(r.item_count) : 0,
      group_count: r ? toInt(r.group_count) : 0,
    });
  }
  return out;
}

/** Validates an inclusive day range and returns its length in days. Throws a message Claude can act on. */
export function validateRange(from: string, to: string): number {
  if (!isValidDateIso(from)) throw new Error(`from must be a real calendar day as YYYY-MM-DD, got "${from}"`);
  if (!isValidDateIso(to)) throw new Error(`to must be a real calendar day as YYYY-MM-DD, got "${to}"`);
  if (from > to) throw new Error(`from (${from}) is after to (${to})`);
  const days = daysInclusive(from, to);
  if (days > MAX_SPENDING_DAYS) {
    throw new Error(
      `the range is ${days} days; expenses_spending covers at most ${MAX_SPENDING_DAYS} days. Use expenses_months for longer spans.`,
    );
  }
  return days;
}

function normalizeCategories(categories: readonly ExpenseCategory[] | undefined): ExpenseCategory[] | null {
  if (!categories || categories.length === 0) return null;
  return [...new Set(categories)];
}

/* -------------------------------------------------------------- fetchers */

export async function fetchSpending(
  source: ReadOnlySource,
  args: SpendingArgs,
  now: Date = new Date(),
): Promise<SpendingResult> {
  const days = validateRange(args.from, args.to);
  const top = clampInt(args.top ?? DEFAULT_TOP, 1, MAX_TOP);
  const categories = normalizeCategories(args.categories);
  const params: unknown[] = [args.from, args.to, categories];

  const [dayResult, categoryResult, largestResult] = await Promise.all([
    source.query(SPENDING_BY_DAY_SQL, params, { maxRows: MAX_SPENDING_DAYS }),
    source.query(SPENDING_BY_CATEGORY_SQL, params, { maxRows: MAX_CATEGORY_ROWS }),
    source.query(LARGEST_ITEMS_SQL, [...params, top], { maxRows: top }),
  ]);

  const byDay = buildDayTotals(rowsOf(dayResult));
  const total = byDay.reduce((sum, d) => sum + d.total_idr, 0);
  const itemCount = byDay.reduce((sum, d) => sum + d.item_count, 0);
  const groupCount = byDay.reduce((sum, d) => sum + d.group_count, 0);

  return {
    from: args.from,
    to: args.to,
    days,
    today_wib: todayWib(now),
    categories,
    total_idr: total,
    item_count: itemCount,
    group_count: groupCount,
    days_with_spending: byDay.length,
    average_per_day_idr: Math.round(total / days),
    by_category: buildCategoryTotals(rowsOf(categoryResult), total),
    by_day: byDay,
    by_week: buildWeekTotals(args.from, args.to, byDay),
    largest_items: buildLargestItems(rowsOf(largestResult), top),
  };
}

export async function fetchGroup(source: ReadOnlySource, id: string): Promise<GroupDetail> {
  const groupId = id.trim();
  if (groupId === '') throw new Error('id must not be empty');

  const [groupResult, itemResult, photoResult] = await Promise.all([
    source.query(GROUP_SQL, [groupId], { maxRows: 1 }),
    source.query(GROUP_ITEMS_SQL, [groupId], { maxRows: MAX_ITEMS_PER_GROUP }),
    source.query(GROUP_PHOTOS_SQL, [groupId], { maxRows: MAX_PHOTOS_PER_GROUP }),
  ]);

  const group = rowsOf(groupResult)[0];
  if (!group) {
    throw new Error(
      `no expense group with id "${groupId}". Group ids come from expenses_spending (largest_items[].group_id) or expenses_sql.`,
    );
  }

  const items: GroupItem[] = rowsOf(itemResult)
    .map((r) => {
      const category = toExpenseCategory(r.category);
      return {
        id: toText(r.id),
        name: toText(r.name),
        amount_idr: toInt(r.amount_idr),
        category,
        label: categoryLabel(category),
        sort_order: toInt(r.sort_order),
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const photos = rowsOf(photoResult)
    .map((r) => ({
      id: toText(r.id),
      blob_url: toText(r.blob_url),
      width: toNullableInt(r.width),
      height: toNullableInt(r.height),
      sort_order: toInt(r.sort_order),
      created_at: toText(r.created_at),
    }))
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0),
    )
    .map(({ created_at: _createdAt, ...photo }): GroupPhoto => photo);

  return {
    id: toText(group.id),
    title: toText(group.title),
    occurred_on: toText(group.occurred_on),
    note: toNullableText(group.note),
    raw_text: toNullableText(group.raw_text),
    created_at: toText(group.created_at),
    updated_at: toText(group.updated_at),
    total_idr: items.reduce((sum, it) => sum + it.amount_idr, 0),
    item_count: items.length,
    items,
    photo_count: photos.length,
    photos,
  };
}

export async function fetchMonths(
  source: ReadOnlySource,
  args: MonthsArgs,
  now: Date = new Date(),
): Promise<MonthsResult> {
  const today = todayWib(now);
  const currentMonth = today.slice(0, 7);
  const toMonth = args.toMonth ?? currentMonth;
  if (!isValidMonthKey(toMonth)) throw new Error(`to_month must be YYYY-MM, got "${toMonth}"`);
  const months = clampInt(args.months ?? DEFAULT_MONTHS, 1, MAX_MONTHS);
  const categories = normalizeCategories(args.categories);

  const firstMonth = addMonths(toMonth, -(months - 1));
  const startIso = `${firstMonth}-01`;
  const endExclusiveIso = `${addMonths(toMonth, 1)}-01`;

  const result = await source.query(MONTHLY_TOTALS_SQL, [startIso, endExclusiveIso, categories], {
    maxRows: MAX_MONTHS,
  });
  const byMonth = fillZeroMonths(rowsOf(result), toMonth, months, currentMonth);
  const complete = byMonth.filter((m) => m.status === 'complete');
  const completeTotal = complete.reduce((sum, m) => sum + m.total_idr, 0);

  return {
    to_month: toMonth,
    months,
    today_wib: today,
    categories,
    total_idr: byMonth.reduce((sum, m) => sum + m.total_idr, 0),
    average_per_month_idr: complete.length === 0 ? 0 : Math.round(completeTotal / complete.length),
    by_month: byMonth,
  };
}
```
**Impact:** new file. `../types.js` must export `ReadOnlySource` and `../rows.js` must export `toObjects` (phase 1). Notes: `$3::text[]` with a JS `null` matches every category, and a JS string array is sent by `pg` as a Postgres array literal. The `_createdAt` destructure drops the sort key from the output (an unused binding with a leading underscore passes `tsc` under this repo's `strict` config, and the repo does not set `noUnusedLocals`).

### Step 4: Register the tools
**File:** `src/connectors/expenses/curated.ts:1` (replace the whole phase-1 stub; the exported name and signature stay the same)
**Change:** zod input shapes, descriptions written for Claude, and `run(..., { compact: true })` so any throw (a `ConnectorError` or a validation `Error`) becomes an `isError` result for that call only.
**Code:**
```ts
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
```
**Impact:** the three names now appear in `tools/list` on `/mcp` (phase 1's `register.ts` already calls this function). Phase 1's tool-list assertions check "generic six present, every name a contract name", so they pass with these three added.

### Step 5: Unit tests: dates
**File:** `tests/unit/connectors/expenses.dates.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysInclusive,
  isValidDateIso,
  isValidMonthKey,
  isoWeekKey,
  isoWeekMonday,
  todayWib,
  weekdayOf,
} from '../../../src/connectors/expenses/dates.js';

describe('expenses dates', () => {
  it('validates real calendar days and months', () => {
    expect(isValidDateIso('2026-10-31')).toBe(true);
    expect(isValidDateIso('2028-02-29')).toBe(true);
    expect(isValidDateIso('2026-02-29')).toBe(false);
    expect(isValidDateIso('2026-02-30')).toBe(false);
    expect(isValidDateIso('2026-13-01')).toBe(false);
    expect(isValidDateIso('26-10-01')).toBe(false);
    expect(isValidDateIso(20261001)).toBe(false);
    expect(isValidMonthKey('2026-10')).toBe(true);
    expect(isValidMonthKey('2026-13')).toBe(false);
    expect(isValidMonthKey('2026-1')).toBe(false);
  });

  it('adds days across month and year ends and counts inclusive spans', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysInclusive('2026-10-01', '2026-10-31')).toBe(31);
    expect(daysInclusive('2026-10-06', '2026-10-06')).toBe(1);
    expect(daysInclusive('2026-01-01', '2026-12-31')).toBe(365);
  });

  it('names weekdays', () => {
    expect(weekdayOf('2026-10-05')).toBe('Mon');
    expect(weekdayOf('2026-10-01')).toBe('Thu');
    expect(weekdayOf('2026-11-01')).toBe('Sun');
  });

  it('finds the Monday of the ISO week (Monday–Sunday)', () => {
    expect(isoWeekMonday('2026-10-01')).toBe('2026-09-28');
    expect(isoWeekMonday('2026-10-05')).toBe('2026-10-05');
    expect(isoWeekMonday('2026-11-01')).toBe('2026-10-26');
  });

  it('labels ISO weeks by the year of their Thursday', () => {
    expect(isoWeekKey('2026-10-05')).toBe('2026-W41');
    expect(isoWeekKey('2026-10-01')).toBe('2026-W40');
    expect(isoWeekKey('2026-12-28')).toBe('2026-W53');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2021-01-03')).toBe('2020-W53');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
  });

  it('reads today in Asia/Jakarta, not UTC', () => {
    // 2026-10-30T18:30Z is 2026-10-31 01:30 in Jakarta (UTC+7).
    expect(todayWib(new Date('2026-10-30T18:30:00Z'))).toBe('2026-10-31');
    expect(todayWib(new Date('2026-10-30T16:59:00Z'))).toBe('2026-10-30');
  });

  it('adds months with integer math', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 3)).toBe('2027-01');
    expect(addMonths('2026-10', -21)).toBe('2025-01');
    expect(() => addMonths('2026-13', 1)).toThrow(RangeError);
  });
});
```

### Step 6: Unit tests: categories
**File:** `tests/unit/connectors/expenses.categories.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  EATING_CATEGORIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  categoryLabel,
  isExpenseCategory,
  toExpenseCategory,
} from '../../../src/connectors/expenses/categories.js';

describe('expenses categories', () => {
  it('has the 17 slugs of expense-tracking, in display order, each with an Indonesian label', () => {
    expect(EXPENSE_CATEGORIES).toHaveLength(17);
    expect(new Set(EXPENSE_CATEGORIES).size).toBe(17);
    expect(EXPENSE_CATEGORIES[0]).toBe('meals');
    expect(EXPENSE_CATEGORIES[16]).toBe('other');
    for (const slug of EXPENSE_CATEGORIES) expect(EXPENSE_CATEGORY_LABELS[slug].length).toBeGreaterThan(0);
    expect(EXPENSE_CATEGORY_LABELS.meals).toBe('Makan Harian');
    expect(EXPENSE_CATEGORY_LABELS.dining).toBe('Fancy Makan Berat');
    expect(EXPENSE_CATEGORY_LABELS.utilities).toBe('Listrik & Air Apart');
    expect(EXPENSE_CATEGORY_LABELS.other).toBe('Lainnya');
  });

  it('degrades unknown slugs to other, as the app does', () => {
    expect(isExpenseCategory('fuel')).toBe(true);
    expect(isExpenseCategory('food')).toBe(false);
    expect(toExpenseCategory('food')).toBe('other');
    expect(toExpenseCategory(null)).toBe('other');
    expect(categoryLabel('food')).toBe('Lainnya');
    expect(categoryLabel('cinema')).toBe('Bioskop');
  });

  it('lists the eating family', () => {
    expect([...EATING_CATEGORIES]).toEqual(['meals', 'jajan', 'dining', 'snacks', 'drinks']);
  });
});
```

### Step 7: Unit tests: builders and fetchers on a fake source
**File:** `tests/unit/connectors/expenses.queries.test.ts:1` (new)
**Change:** no database. A fake `ReadOnlySource` answers by SQL identity and records the params, which pins down the parameter order, the category filter and the shaping.
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  GROUP_ITEMS_SQL,
  GROUP_PHOTOS_SQL,
  GROUP_SQL,
  LARGEST_ITEMS_SQL,
  MONTHLY_TOTALS_SQL,
  SPENDING_BY_CATEGORY_SQL,
  SPENDING_BY_DAY_SQL,
  buildCategoryTotals,
  buildDayTotals,
  buildLargestItems,
  buildWeekTotals,
  fetchGroup,
  fetchMonths,
  fetchSpending,
  fillZeroMonths,
  rowsOf,
  shareOf,
  toInt,
  validateRange,
} from '../../../src/connectors/expenses/queries.js';
import type { QueryOptions, QueryResult, ReadOnlySource } from '../../../src/connectors/types.js';

function result(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, row_count: rows.length, truncated: false };
}

interface Call {
  sql: string;
  params: readonly unknown[] | undefined;
  options: QueryOptions | undefined;
}

function fakeSource(answers: Map<string, QueryResult>): ReadOnlySource & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult> {
      calls.push({ sql, params, options });
      const answer = answers.get(sql);
      if (!answer) throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
      return answer;
    },
  };
}

const NOW = new Date('2026-10-30T05:00:00Z'); // 2026-10-30 12:00 WIB

describe('row helpers', () => {
  it('turns compact results into objects', () => {
    expect(rowsOf(result(['a', 'b'], [[1, 'x'], [2, null]]))).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: null },
    ]);
  });

  it('reads integers from numbers and numeric text', () => {
    expect(toInt(593000)).toBe(593000);
    expect(toInt('593000')).toBe(593000);
    expect(toInt(null)).toBe(0);
    expect(() => toInt('abc')).toThrow(/expected a number/);
  });

  it('computes one-decimal shares and guards zero', () => {
    expect(shareOf(350000, 593000)).toBe(59);
    expect(shareOf(110000, 593000)).toBe(18.5);
    expect(shareOf(5, 0)).toBe(0);
  });
});

describe('validateRange', () => {
  it('accepts an inclusive range and returns its length', () => {
    expect(validateRange('2026-10-01', '2026-10-31')).toBe(31);
  });
  it('rejects bad days, reversed and over-long ranges with actionable messages', () => {
    expect(() => validateRange('2026-02-30', '2026-03-01')).toThrow(/real calendar day/);
    expect(() => validateRange('2026-10-31', '2026-10-01')).toThrow(/is after/);
    expect(() => validateRange('2025-01-01', '2026-10-31')).toThrow(/expenses_months/);
  });
});

describe('builders', () => {
  const days = buildDayTotals([
    { day: '2026-10-14', total_idr: '40000', item_count: 1, group_count: 1 },
    { day: '2026-10-01', total_idr: 25000, item_count: 1, group_count: 1 },
  ]);

  it('sorts days and names their weekday', () => {
    expect(days.map((d) => [d.date, d.weekday, d.total_idr])).toEqual([
      ['2026-10-01', 'Thu', 25000],
      ['2026-10-14', 'Wed', 40000],
    ]);
  });

  it('zero-fills every ISO week the range touches and flags partial weeks', () => {
    const weeks = buildWeekTotals('2026-10-01', '2026-10-31', days);
    expect(weeks.map((w) => [w.week, w.monday, w.sunday, w.days_in_range, w.partial, w.total_idr])).toEqual([
      ['2026-W40', '2026-09-28', '2026-10-04', 4, true, 25000],
      ['2026-W41', '2026-10-05', '2026-10-11', 7, false, 0],
      ['2026-W42', '2026-10-12', '2026-10-18', 7, false, 40000],
      ['2026-W43', '2026-10-19', '2026-10-25', 7, false, 0],
      ['2026-W44', '2026-10-26', '2026-11-01', 6, true, 0],
    ]);
  });

  it('merges unknown categories into other, labels them, and sorts biggest first', () => {
    const cats = buildCategoryTotals(
      [
        { category: 'meals', total_idr: 110000, item_count: 4, group_count: 4 },
        { category: 'food', total_idr: 5000, item_count: 1, group_count: 1 },
        { category: 'other', total_idr: 5000, item_count: 1, group_count: 1 },
        { category: 'dining', total_idr: 350000, item_count: 1, group_count: 1 },
      ],
      470000,
    );
    expect(cats.map((c) => [c.category, c.label, c.total_idr, c.item_count])).toEqual([
      ['dining', 'Fancy Makan Berat', 350000, 1],
      ['meals', 'Makan Harian', 110000, 4],
      ['other', 'Lainnya', 10000, 2],
    ]);
  });

  it('orders largest items amount desc, newest day, then item id', () => {
    const items = buildLargestItems(
      [
        { item_id: 'b', name: 'x', amount_idr: 50000, category: 'fuel', group_id: 'g1', group_title: 't', occurred_on: '2026-10-14' },
        { item_id: 'a', name: 'y', amount_idr: 50000, category: 'fuel', group_id: 'g2', group_title: 't', occurred_on: '2026-10-14' },
        { item_id: 'c', name: 'z', amount_idr: 50000, category: 'fuel', group_id: 'g3', group_title: 't', occurred_on: '2026-10-20' },
        { item_id: 'd', name: 'w', amount_idr: 90000, category: 'nope', group_id: 'g4', group_title: 't', occurred_on: '2026-10-01' },
      ],
      3,
    );
    expect(items.map((i) => i.item_id)).toEqual(['d', 'c', 'a']);
    expect(items[0]?.label).toBe('Lainnya');
  });

  it('zero-fills months and marks complete / in progress / future', () => {
    const months = fillZeroMonths([{ month: '2026-10', total_idr: '593000', item_count: 9, group_count: 4 }], '2026-11', 4, '2026-10');
    expect(months.map((m) => [m.month, m.status, m.total_idr])).toEqual([
      ['2026-08', 'complete', 0],
      ['2026-09', 'complete', 0],
      ['2026-10', 'in_progress', 593000],
      ['2026-11', 'future', 0],
    ]);
  });
});

describe('fetchSpending', () => {
  it('passes from/to/categories/top in order and shapes one answer', async () => {
    const source = fakeSource(
      new Map([
        [
          SPENDING_BY_DAY_SQL,
          result(['day', 'total_idr', 'item_count', 'group_count'], [
            ['2026-10-01', 25000, 1, 1],
            ['2026-10-14', 40000, 1, 1],
          ]),
        ],
        [SPENDING_BY_CATEGORY_SQL, result(['category', 'total_idr', 'item_count', 'group_count'], [['meals', 65000, 2, 2]])],
        [
          LARGEST_ITEMS_SQL,
          result(['item_id', 'name', 'amount_idr', 'category', 'group_id', 'group_title', 'occurred_on'], [
            ['i4', 'nasi', 40000, 'meals', 'g4', 'rabu', '2026-10-14'],
          ]),
        ],
      ]),
    );
    const out = await fetchSpending(source, { from: '2026-10-01', to: '2026-10-31', categories: ['meals', 'meals'], top: 1 }, NOW);

    const byDay = source.calls.find((c) => c.sql === SPENDING_BY_DAY_SQL);
    expect(byDay?.params).toEqual(['2026-10-01', '2026-10-31', ['meals']]);
    const largest = source.calls.find((c) => c.sql === LARGEST_ITEMS_SQL);
    expect(largest?.params).toEqual(['2026-10-01', '2026-10-31', ['meals'], 1]);
    expect(largest?.options).toEqual({ maxRows: 1 });

    expect(out.today_wib).toBe('2026-10-30');
    expect(out.categories).toEqual(['meals']);
    expect(out.total_idr).toBe(65000);
    expect(out.item_count).toBe(2);
    expect(out.group_count).toBe(2);
    expect(out.days).toBe(31);
    expect(out.days_with_spending).toBe(2);
    expect(out.average_per_day_idr).toBe(2097);
    expect(out.by_week).toHaveLength(5);
    expect(out.by_category[0]).toMatchObject({ category: 'meals', share_pct: 100 });
    expect(out.largest_items[0]).toMatchObject({ group_id: 'g4', label: 'Makan Harian' });
  });

  it('sends NULL categories when no filter is given', async () => {
    const empty = result(['x'], []);
    const source = fakeSource(
      new Map([
        [SPENDING_BY_DAY_SQL, empty],
        [SPENDING_BY_CATEGORY_SQL, empty],
        [LARGEST_ITEMS_SQL, empty],
      ]),
    );
    const out = await fetchSpending(source, { from: '2026-10-05', to: '2026-10-11' }, NOW);
    expect(source.calls[0]?.params).toEqual(['2026-10-05', '2026-10-11', null]);
    expect(out.total_idr).toBe(0);
    expect(out.average_per_day_idr).toBe(0);
    expect(out.by_week).toEqual([
      expect.objectContaining({ week: '2026-W41', total_idr: 0, partial: false }),
    ]);
    expect(out.largest_items).toEqual([]);
  });
});

describe('fetchGroup', () => {
  it('orders items by sort_order then id, photos by sort_order then created_at, and totals the items', async () => {
    const source = fakeSource(
      new Map([
        [
          GROUP_SQL,
          result(['id', 'title', 'occurred_on', 'note', 'raw_text', 'created_at', 'updated_at'], [
            ['g3', 'bakar duit selasa', '2026-10-06', null, 'steak 350rb', '2026-10-06 19:00:00+07', '2026-10-06 19:00:00+07'],
          ]),
        ],
        [
          GROUP_ITEMS_SQL,
          result(['id', 'name', 'amount_idr', 'category', 'sort_order'], [
            ['i3c', 'gojek', 15000, 'transport', 2],
            ['i3a', 'nasi', 30000, 'meals', 1],
            ['i3b', 'steak', 350000, 'dining', 0],
          ]),
        ],
        [
          GROUP_PHOTOS_SQL,
          result(['id', 'blob_url', 'width', 'height', 'sort_order', 'created_at'], [
            ['p1', 'https://blob.example/b.jpg', 1200, 1600, 1, '2026-10-06 19:00:00+07'],
            ['p2', 'https://blob.example/a.jpg', null, null, 0, '2026-10-06 19:01:00+07'],
          ]),
        ],
      ]),
    );
    const g = await fetchGroup(source, ' g3 ');
    expect(source.calls.every((c) => (c.params ?? [])[0] === 'g3')).toBe(true);
    expect(g.items.map((i) => i.name)).toEqual(['steak', 'nasi', 'gojek']);
    expect(g.total_idr).toBe(395000);
    expect(g.note).toBeNull();
    expect(g.photo_count).toBe(2);
    expect(g.photos).toEqual([
      { id: 'p2', blob_url: 'https://blob.example/a.jpg', width: null, height: null, sort_order: 0 },
      { id: 'p1', blob_url: 'https://blob.example/b.jpg', width: 1200, height: 1600, sort_order: 1 },
    ]);
  });

  it('throws a message naming where ids come from when the group does not exist', async () => {
    const empty = result(['id'], []);
    const source = fakeSource(
      new Map([
        [GROUP_SQL, empty],
        [GROUP_ITEMS_SQL, empty],
        [GROUP_PHOTOS_SQL, empty],
      ]),
    );
    await expect(fetchGroup(source, 'nope')).rejects.toThrow(/no expense group with id "nope".*expenses_spending/);
  });
});

describe('fetchMonths', () => {
  it('defaults to the current WIB month, sends a half-open range, averages complete months only', async () => {
    const source = fakeSource(
      new Map([
        [
          MONTHLY_TOTALS_SQL,
          result(['month', 'total_idr', 'item_count', 'group_count'], [
            ['2026-09', 20000, 1, 1],
            ['2026-10', 593000, 9, 4],
          ]),
        ],
      ]),
    );
    const out = await fetchMonths(source, { months: 3 }, NOW);
    expect(source.calls[0]?.params).toEqual(['2026-08-01', '2026-11-01', null]);
    expect(out.to_month).toBe('2026-10');
    expect(out.by_month.map((m) => [m.month, m.status, m.total_idr])).toEqual([
      ['2026-08', 'complete', 0],
      ['2026-09', 'complete', 20000],
      ['2026-10', 'in_progress', 593000],
    ]);
    expect(out.total_idr).toBe(613000);
    expect(out.average_per_month_idr).toBe(10000);
  });

  it('rejects a malformed to_month', async () => {
    const source = fakeSource(new Map());
    await expect(fetchMonths(source, { toMonth: '2026-13' }, NOW)).rejects.toThrow(/to_month must be YYYY-MM/);
  });
});
```
**Note:** this file imports the type `QueryOptions` from `../../../src/connectors/types.js`; phase 1 exports it under exactly that name (`{ maxRows?: number }`).

### Step 8: Integration test on the Docker DB seeded from expense-tracking's migrations
**File:** `tests/integration/connectors/expenses.curated.int.test.ts:1` (new)
**Change:** truncate the per-system DB, seed it through the harness's `withAdmin(systemDbUrl('expenses'), …)` (writable, refuses Neon), then call the tools through a bare `McpServer`. That server registers only `registerExpensesCurated` against `connectorFor('expenses')` (a real phase-1 connector reading a generated `.env.local`) and is reached over the SDK's `InMemoryTransport`. This exercises the real `query` path (read-only txn, wrapper, type parsing) without depending on how phase 1 wires `/mcp`.
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerExpensesCurated } from '../../../src/connectors/expenses/curated.js';
import { cleanupHarness, connectorFor, describeWithRepo, systemDbUrl, truncateSystem, withAdmin } from './harness.js';

/*
 * Seed, all WIB days (October 2026: Thu 1st; ISO weeks start Sep 28, Oct 5, 12, 19, 26):
 *   g1 2026-09-30  meals 20000                                  (outside October)
 *   g2 2026-10-01  meals 25000, drinks 8000                     = 33000
 *   g3 2026-10-06  steak dining 350000 (sort 0), nasi meals 30000 (sort 1), gojek transport 15000 (sort 2)
 *                  = 395000, note + raw_text, 2 photos (sort 1 = b.jpg, sort 0 = a.jpg)
 *   g4 2026-10-14  meals 40000, fuel 50000                      = 90000
 *   g7 2026-10-20  no items                                     (counts nowhere)
 *   g5 2026-10-31  meals 15000, cinema 60000                    = 75000
 *   g6 2026-11-01  meals 99000                                  (outside October)
 * October: total 593000, 9 items, 4 groups; meals 110000 in 4 items.
 */
const USER_ID = 'u-owner';

const GROUPS: ReadonlyArray<[id: string, day: string, title: string, note: string | null, raw: string | null]> = [
  ['g1', '2026-09-30', 'akhir september', null, null],
  ['g2', '2026-10-01', 'makan kamis', null, null],
  ['g3', '2026-10-06', 'bakar duit selasa', 'ulang tahun', 'steak 350rb\nnasi 30rb\ngojek 15rb'],
  ['g4', '2026-10-14', 'rabu', null, null],
  ['g5', '2026-10-31', 'halloween', null, null],
  ['g6', '2026-11-01', 'november', null, null],
  ['g7', '2026-10-20', 'kosong', null, null],
];

const ITEMS: ReadonlyArray<[id: string, group: string, name: string, amount: number, category: string, sort: number]> = [
  ['i1a', 'g1', 'nasi padang', 20000, 'meals', 0],
  ['i2a', 'g2', 'nasi uduk', 25000, 'meals', 0],
  ['i2b', 'g2', 'es teh', 8000, 'drinks', 1],
  ['i3a', 'g3', 'nasi', 30000, 'meals', 1],
  ['i3b', 'g3', 'steak', 350000, 'dining', 0],
  ['i3c', 'g3', 'gojek', 15000, 'transport', 2],
  ['i4a', 'g4', 'warteg', 40000, 'meals', 0],
  ['i4b', 'g4', 'pertamax', 50000, 'fuel', 1],
  ['i5a', 'g5', 'bakso', 15000, 'meals', 0],
  ['i5b', 'g5', 'xxi', 60000, 'cinema', 1],
  ['i6a', 'g6', 'nasi kotak', 99000, 'meals', 0],
];

const PHOTOS: ReadonlyArray<[id: string, group: string, url: string, sort: number]> = [
  ['p1', 'g3', 'https://blob.example/b.jpg', 1],
  ['p2', 'g3', 'https://blob.example/a.jpg', 0],
];

async function seed(): Promise<void> {
  await withAdmin(systemDbUrl('expenses'), async (db) => {
    await db.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [USER_ID, 'Owner', 'owner@example.test']);
    for (const [id, day, title, note, raw] of GROUPS) {
      await db.query(
        'INSERT INTO expense_groups (id, user_id, title, occurred_on, note, raw_text) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, USER_ID, title, day, note, raw],
      );
    }
    for (const [id, group, name, amount, category, sort] of ITEMS) {
      await db.query(
        'INSERT INTO expense_items (id, group_id, name, amount_idr, category, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, group, name, amount, category, sort],
      );
    }
    for (const [id, group, url, sort] of PHOTOS) {
      await db.query(
        'INSERT INTO expense_photos (id, group_id, blob_url, blob_pathname, width, height, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, group, url, url.replace('https://blob.example/', ''), 1200, 1600, sort],
      );
    }
  });
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describeWithRepo('expenses', 'expense-tracking curated tools', () => {
  let client: Client;
  let server: McpServer;

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(textOf(result));
    return JSON.parse(textOf(result)) as T;
  }

  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError).toBe(true);
    return textOf(result);
  }

  beforeAll(async () => {
    await truncateSystem('expenses');
    await seed();
    const connector = connectorFor('expenses');
    server = new McpServer({ name: 'expenses-curated-test', version: '0.0.0' });
    registerExpensesCurated(server, connector);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'expenses-curated-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    cleanupHarness();
  });

  it('registers exactly the three curated tools, read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['expenses_get', 'expenses_months', 'expenses_spending']);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('expenses_spending: October totals, categories, days, ISO weeks and largest items', async () => {
    const out = await call<{
      days: number;
      total_idr: number;
      item_count: number;
      group_count: number;
      days_with_spending: number;
      average_per_day_idr: number;
      by_category: Array<{ category: string; label: string; total_idr: number; share_pct: number }>;
      by_day: Array<{ date: string; weekday: string; total_idr: number; item_count: number; group_count: number }>;
      by_week: Array<{ week: string; monday: string; days_in_range: number; partial: boolean; total_idr: number }>;
      largest_items: Array<{ name: string; amount_idr: number; group_id: string; group_title: string; occurred_on: string; label: string }>;
    }>('expenses_spending', { from: '2026-10-01', to: '2026-10-31', top: 3 });

    expect(out.days).toBe(31);
    expect(out.total_idr).toBe(593000);
    expect(out.item_count).toBe(9);
    expect(out.group_count).toBe(4);
    expect(out.days_with_spending).toBe(4);
    expect(out.average_per_day_idr).toBe(19129);

    expect(out.by_category.map((c) => [c.category, c.total_idr])).toEqual([
      ['dining', 350000],
      ['meals', 110000],
      ['cinema', 60000],
      ['fuel', 50000],
      ['transport', 15000],
      ['drinks', 8000],
    ]);
    expect(out.by_category[0]).toMatchObject({ label: 'Fancy Makan Berat', share_pct: 59 });

    expect(out.by_day).toEqual([
      { date: '2026-10-01', weekday: 'Thu', total_idr: 33000, item_count: 2, group_count: 1 },
      { date: '2026-10-06', weekday: 'Tue', total_idr: 395000, item_count: 3, group_count: 1 },
      { date: '2026-10-14', weekday: 'Wed', total_idr: 90000, item_count: 2, group_count: 1 },
      { date: '2026-10-31', weekday: 'Sat', total_idr: 75000, item_count: 2, group_count: 1 },
    ]);

    expect(out.by_week.map((w) => [w.week, w.monday, w.days_in_range, w.partial, w.total_idr])).toEqual([
      ['2026-W40', '2026-09-28', 4, true, 33000],
      ['2026-W41', '2026-10-05', 7, false, 395000],
      ['2026-W42', '2026-10-12', 7, false, 90000],
      ['2026-W43', '2026-10-19', 7, false, 0],
      ['2026-W44', '2026-10-26', 6, true, 75000],
    ]);

    expect(out.largest_items.map((i) => [i.name, i.amount_idr, i.group_id, i.group_title, i.occurred_on])).toEqual([
      ['steak', 350000, 'g3', 'bakar duit selasa', '2026-10-06'],
      ['xxi', 60000, 'g5', 'halloween', '2026-10-31'],
      ['pertamax', 50000, 'g4', 'rabu', '2026-10-14'],
    ]);
  });

  it('expenses_spending: "meals in October, worst week" is one call', async () => {
    const out = await call<{
      total_idr: number;
      item_count: number;
      group_count: number;
      categories: string[];
      by_category: Array<{ category: string; label: string; total_idr: number }>;
      by_week: Array<{ monday: string; total_idr: number }>;
    }>('expenses_spending', { from: '2026-10-01', to: '2026-10-31', categories: ['meals'] });

    expect(out.categories).toEqual(['meals']);
    expect(out.total_idr).toBe(110000);
    expect(out.item_count).toBe(4);
    expect(out.group_count).toBe(4);
    expect(out.by_category).toEqual([expect.objectContaining({ category: 'meals', label: 'Makan Harian', total_idr: 110000 })]);
    expect(out.by_week.map((w) => w.total_idr)).toEqual([25000, 30000, 40000, 0, 15000]);
    const worst = [...out.by_week].sort((a, b) => b.total_idr - a.total_idr)[0];
    expect(worst?.monday).toBe('2026-10-12');
  });

  it('expenses_spending: several categories, and an empty range', async () => {
    const two = await call<{ total_idr: number }>('expenses_spending', {
      from: '2026-10-01',
      to: '2026-10-31',
      categories: ['meals', 'drinks'],
    });
    expect(two.total_idr).toBe(118000);

    const none = await call<{ total_idr: number; by_day: unknown[]; by_week: Array<{ total_idr: number }>; largest_items: unknown[] }>(
      'expenses_spending',
      { from: '2025-01-06', to: '2025-01-12' },
    );
    expect(none.total_idr).toBe(0);
    expect(none.by_day).toEqual([]);
    expect(none.by_week).toEqual([expect.objectContaining({ total_idr: 0 })]);
    expect(none.largest_items).toEqual([]);
  });

  it('expenses_spending: a reversed range is a tool error, not a crash', async () => {
    expect(await callError('expenses_spending', { from: '2026-10-31', to: '2026-10-01' })).toMatch(/is after/);
  });

  it('expenses_get: one group with items in sort order, photos and raw text', async () => {
    const g = await call<{
      id: string;
      title: string;
      occurred_on: string;
      note: string | null;
      raw_text: string | null;
      total_idr: number;
      item_count: number;
      items: Array<{ name: string; amount_idr: number; category: string; label: string }>;
      photo_count: number;
      photos: Array<{ blob_url: string }>;
    }>('expenses_get', { id: 'g3' });

    expect(g).toMatchObject({
      id: 'g3',
      title: 'bakar duit selasa',
      occurred_on: '2026-10-06',
      note: 'ulang tahun',
      raw_text: 'steak 350rb\nnasi 30rb\ngojek 15rb',
      total_idr: 395000,
      item_count: 3,
      photo_count: 2,
    });
    expect(g.items.map((i) => [i.name, i.amount_idr, i.category, i.label])).toEqual([
      ['steak', 350000, 'dining', 'Fancy Makan Berat'],
      ['nasi', 30000, 'meals', 'Makan Harian'],
      ['gojek', 15000, 'transport', 'Transport'],
    ]);
    expect(g.photos.map((p) => p.blob_url)).toEqual(['https://blob.example/a.jpg', 'https://blob.example/b.jpg']);
  });

  it('expenses_get: an unknown id is a tool error that says where ids come from', async () => {
    expect(await callError('expenses_get', { id: 'nope' })).toMatch(/no expense group with id "nope"/);
  });

  it('expenses_months: zero-filled monthly totals, with and without a category filter', async () => {
    const all = await call<{ total_idr: number; by_month: Array<{ month: string; total_idr: number; item_count: number; group_count: number }> }>(
      'expenses_months',
      { to_month: '2026-11', months: 4 },
    );
    expect(all.by_month.map((m) => [m.month, m.total_idr, m.item_count, m.group_count])).toEqual([
      ['2026-08', 0, 0, 0],
      ['2026-09', 20000, 1, 1],
      ['2026-10', 593000, 9, 4],
      ['2026-11', 99000, 1, 1],
    ]);
    expect(all.total_idr).toBe(712000);

    const meals = await call<{ by_month: Array<{ month: string; total_idr: number }> }>('expenses_months', {
      to_month: '2026-11',
      months: 4,
      categories: ['meals'],
    });
    expect(meals.by_month.map((m) => m.total_idr)).toEqual([0, 20000, 110000, 99000]);
  });
});
```
**Notes:**
- `describeWithRepo` is called with a callback that registers `beforeAll`/`it` inside it, so a skipped suite (no `~/expense-tracking`) never calls `systemDbUrl` or connects. `systemDbUrl` and `connectorFor` are synchronous in phase 1's harness; only `truncateSystem` and `withAdmin` are awaited.
- `client?.close()` / `server?.close()` guard against a failed `beforeAll`. Under `strict`, optional chaining on a definitely-typed `let` is allowed.
- The test only reads after seeding, so one seed in `beforeAll` is enough. `truncateSystem('expenses')` runs first, so leftovers from any other file cannot change these numbers. Phase 1's generic expenses test asserts only types and refusals, never row counts, so it does not care what this file leaves behind.

## Verification

**Setup:** the worktree has no `node_modules`. Run `npm ci` at the worktree root before any other command.
**Build:** `npm run typecheck`
**Tests:** `npm test` (the three new unit files) and `npm run test:int` (runs `tests/integration/connectors/expenses.curated.int.test.ts` against `mcp-notes-pg-connectors`; it skips with phase 1's message when `~/expense-tracking` is absent)
**Manual check:** with notesd running, `tools/list` on `/mcp` shows `expenses_spending`, `expenses_get` and `expenses_months`. Then from Claude Code: `/n how much did i spend on meals in october, and which week was the worst?` makes one `expenses_spending` call with `categories: ["meals"]`, and the answer names the worst full or partial week by its Monday.
**Exit criteria:** on the seeded data, `expenses_spending` returns October = 593000 with dining 350000 (Fancy Makan Berat) first, the five ISO weeks with partial flags, and steak 350000 as the largest item. `expenses_spending` filtered to meals returns 110000 with the week of 2026-10-12 the worst. `expenses_get('g3')` returns 3 items in sort order totalling 395000, 2 photos in sort order, the note and the raw text. `expenses_months(to_month 2026-11, months 4)` returns [0, 20000, 593000, 99000]. Bad input is an `isError` result, and typecheck, unit and integration suites are green.

## Handoffs

- **Reconciled with phase 1:** phase 1's tool-list tests assert "generic six present, every name a contract name", so this phase landing (before or after phases 3 and 4) needs no edit there. `rowsOf` is phase 1's `toObjects`. Validation errors here are plain `Error`s and render as `error: <message>`; a `ConnectorError` renders bare; the tests match with unanchored regexes, so both pass.
- **README:** phase 1 writes the `expenses_*` rows with this phase's inputs (`from`/`to`, `categories`, `top`; `id`; `months`, `to_month`). This phase does not edit README.
- **Phase 5 (R3):** the `/n` skill and chat prompt can point "spending this week / meals in October / which week was worst" at `expenses_spending` (with `categories`), and "compare months" at `expenses_months`. That wording is phase 5's.
- **Not done (out of scope for R2 minimums):** a per-group listing (the groups in a range with totals, like the app's month page) and reading the cached `expense_insights` LLM summaries. Both can be answered with `expenses_sql` today. If wanted later, they become a new curated tool, which changes `names.ts` (phase 1's file) and needs a new plan.

## Rollback

Restore phase 1's stub `src/connectors/expenses/curated.ts` (`git checkout <phase-1 commit> -- src/connectors/expenses/curated.ts`), delete `src/connectors/expenses/{categories,dates,queries}.ts`, `tests/unit/connectors/expenses.*.test.ts` and `tests/integration/connectors/expenses.curated.int.test.ts`. No other file changes, so reverting this phase's commit alone is enough.
