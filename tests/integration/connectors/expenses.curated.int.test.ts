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
