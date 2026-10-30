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
