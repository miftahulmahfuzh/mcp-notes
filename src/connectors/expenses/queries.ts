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
