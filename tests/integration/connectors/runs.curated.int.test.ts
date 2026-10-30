import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { registerRunsCurated } from '../../../src/connectors/runs/curated.js';
import { cleanupHarness, connectorFor, describeWithRepo, systemDbUrl, truncateSystem, withAdmin } from './harness.js';

/*
 * runs_list / runs_get / runs_review against a Docker Postgres built from ~/run-insights' own
 * drizzle migrations (phase 1 harness). Seeds through an admin connection; the tools read through
 * a real read-only connector. Calendar used below: 2026-10-28 is a Wednesday in ISO week
 * 2026-W44 (Oct 26 - Nov 1); 2026-09-30 and 2026-10-01 both fall in 2026-W40.
 */

/** Seeds one statement at a time through a writable admin connection (local helper, not in the harness). */
async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
  await withAdmin(systemDbUrl('runs'), async (admin) => {
    for (const [sql, params] of statements) await admin.query(sql, params);
  });
}

function insertRun(r: {
  id: string;
  date: string;
  start: string | null;
  distance: number;
  duration: number;
  pace: number;
  avgHr: number | null;
  maxHr?: number | null;
  intent?: string;
  reviewed?: boolean;
  note?: string | null;
  endHr?: number | null;
  hr1?: number | null;
}): [string, unknown[]] {
  return [
    `INSERT INTO runs (id, user_id, occurred_on, started_at, activity_type, duration_sec, distance_m,
       active_kcal, total_kcal, elevation_m, avg_cadence, avg_pace_sec, avg_hr, max_hr, intent,
       end_hr_bpm, hr_1min_post_bpm, note, source, reviewed_at)
     VALUES ($1, 'u1', $2, $3, 'Outdoor Run', $4, $5, 300, 380, 20, 170, $6, $7, $8, $9, $10, $11, $12,
       'screenshot', CASE WHEN $13::boolean THEN now() ELSE NULL END)`,
    [
      r.id, r.date, r.start, r.duration, r.distance, r.pace, r.avgHr, r.maxHr ?? null, r.intent ?? 'easy',
      r.endHr ?? null, r.hr1 ?? null, r.note ?? null, r.reviewed ?? true,
    ],
  ];
}

function payload(headline: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headline,
    verdict: 'moderate',
    whatHappened: `${headline}: what happened.`,
    observations: [
      { title: 'Pace', detail: 'Even splits.', metric: '5:44 /km' },
      { title: 'Heart rate', detail: 'Mostly zone 3.', metric: '150 bpm' },
    ],
    doNext: ['Keep the easy days easy.'],
    questionForRunner: 'How did your legs feel?',
    ...extra,
  });
}

function insertInsight(id: string, scope: string, key: string, createdAt: string, body: string): [string, unknown[]] {
  return [
    `INSERT INTO insights (id, user_id, scope, scope_key, facts_hash, payload, model, created_at)
     VALUES ($1, 'u1', $2, $3, $4, $5::jsonb, 'test-model', $6::timestamptz)`,
    [id, scope, key, `hash-${id}`, body, createdAt],
  ];
}

const SEED: Array<[string, unknown[]]> = [
  [`INSERT INTO "user" (id, name, email) VALUES ('u1', 'Runner', 'runner@example.test')`, []],
  [`INSERT INTO profiles (user_id, max_hr, resting_hr) VALUES ('u1', 190, 52)`, []],
  insertRun({ id: 'r_oct28am', date: '2026-10-28', start: '06:00:00', distance: 5230, duration: 1800, pace: 344, avgHr: 150, maxHr: 170, note: 'felt good', endHr: 165, hr1: 130 }),
  insertRun({ id: 'r_oct28pm', date: '2026-10-28', start: '18:00:00', distance: 3000, duration: 1200, pace: 400, avgHr: 140, maxHr: 155 }),
  insertRun({ id: 'r_oct29draft', date: '2026-10-29', start: '06:00:00', distance: 4000, duration: 1500, pace: 375, avgHr: 145, reviewed: false }),
  insertRun({ id: 'r_oct01', date: '2026-10-01', start: '05:30:00', distance: 8000, duration: 2880, pace: 360, avgHr: null, intent: 'long' }),
  insertRun({ id: 'r_sep30', date: '2026-09-30', start: '05:30:00', distance: 10000, duration: 3600, pace: 360, avgHr: 155, maxHr: 175, intent: 'long' }),
  ...[
    [1, 340, 340, 145, false],
    [2, 345, 345, 150, false],
    [3, 344, 344, 151, false],
    [4, 343, 343, 152, false],
    [5, 348, 348, 155, false],
    [6, 80, 348, 158, true],
  ].map(([km, time, pace, hr, partial]): [string, unknown[]] => [
    `INSERT INTO run_splits (run_id, km, time_sec, pace_sec, hr, cadence, partial) VALUES ('r_oct28am', $1, $2, $3, $4, 170, $5)`,
    [km, time, pace, hr, partial],
  ]),
  ...[
    [1, 60, null, 129],
    [2, 300, 130, 145],
    [3, 900, 146, 160],
    [4, 480, 161, 173],
    [5, 60, 174, null],
  ].map(([zone, dur, min, max]): [string, unknown[]] => [
    `INSERT INTO run_zones (run_id, zone, duration_sec, min_bpm, max_bpm) VALUES ('r_oct28am', $1, $2, $3, $4)`,
    [zone, dur, min, max],
  ]),
  insertInsight('i_s_old', 'session', 'r_oct28am', '2026-10-28T08:00:00+07:00', payload('Older take')),
  insertInsight('i_s_new', 'session', 'r_oct28am', '2026-10-28T09:00:00+07:00', payload('Steady aerobic morning', { hrMaxUsed: 190, hrMaxSource: 'profile' })),
  insertInsight('i_w44', 'week', '2026-W44', '2026-11-01T20:00:00+07:00', payload('Solid week')),
  insertInsight('i_m10_old', 'month', '2026-10', '2026-10-20T20:00:00+07:00', payload('Mid-month draft')),
  insertInsight('i_m10_new', 'month', '2026-10', '2026-10-31T20:00:00+07:00', payload('October in review')),
];

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describeWithRepo('runs', 'run-insights curated tools', () => {
  let client: Client;

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
    const server = new McpServer({ name: 'runs-curated-int', version: '0.0.0' });
    registerRunsCurated(server, connectorFor('runs'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'runs-curated-int-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    cleanupHarness();
  });

  beforeEach(async () => {
    await truncateSystem('runs');
    await seed(SEED);
  });

  it('runs_list: reviewed runs in range, newest first, with metrics, insight headline and period totals', async () => {
    const out = await call<{ runs: Array<Record<string, unknown>>; totals: Record<string, unknown>; truncated: boolean }>(
      'runs_list',
      { from: '2026-10-01', to: '2026-10-31' },
    );
    expect(out.runs.map((r) => r.id)).toEqual(['r_oct28pm', 'r_oct28am', 'r_oct01']);
    expect(out.runs[1]).toMatchObject({
      id: 'r_oct28am',
      date: '2026-10-28',
      started_at: '06:00:00',
      intent: 'easy',
      distance_m: 5230,
      km: 5.23,
      duration_sec: 1800,
      duration: '0:30:00',
      avg_pace_sec: 344,
      avg_pace: '5:44 /km',
      avg_hr: 150,
      max_hr: 170,
      avg_cadence: 170,
      hr_drop_1min: 35,
      insight: { headline: 'Steady aerobic morning', verdict: 'moderate' },
    });
    expect(out.runs[0]?.insight).toBeNull();
    expect(out.totals).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      runs: 3,
      run_days: 2,
      distance_m: 16230,
      km: 16.23,
      duration_sec: 5880,
      duration: '1:38:00',
      avg_pace_sec: 362,
      avg_pace: '6:02 /km',
      avg_hr: 146,
      max_hr: 170,
      longest_run_m: 8000,
    });
    expect(out.truncated).toBe(false);
  });

  it('runs_list: last month is a second call with its own totals', async () => {
    const out = await call<{ runs: Array<Record<string, unknown>>; totals: Record<string, unknown> }>('runs_list', {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(out.runs.map((r) => r.id)).toEqual(['r_sep30']);
    expect(out.totals).toMatchObject({ runs: 1, distance_m: 10000, avg_pace: '6:00 /km', avg_hr: 155 });
  });

  it('runs_list: an empty range has zero totals', async () => {
    const out = await call<{ runs: unknown[]; totals: Record<string, unknown> }>('runs_list', { from: '2026-08-01', to: '2026-08-31' });
    expect(out.runs).toEqual([]);
    expect(out.totals).toMatchObject({ runs: 0, distance_m: 0, avg_pace_sec: null, avg_hr: null });
  });

  it('runs_get by id: splits by km with the partial km, zones 1-5, newest session insight, profile', async () => {
    const out = await call<{ id: string; runs: Array<Record<string, unknown>>; profile: unknown }>('runs_get', { id: 'r_oct28am' });
    expect(out.profile).toEqual({ max_hr: 190, resting_hr: 52 });
    expect(out.runs).toHaveLength(1);
    const run = out.runs[0] as Record<string, unknown>;
    expect(run).toMatchObject({ id: 'r_oct28am', reviewed: true, note: 'felt good', end_hr_bpm: 165, hr_1min_post_bpm: 130 });
    const splits = run.splits as Array<Record<string, unknown>>;
    expect(splits.map((s) => s.km)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(splits[5]).toMatchObject({ km: 6, partial: true, pace_sec: 348, pace: '5:48 /km' });
    expect(splits.slice(0, 5).every((s) => s.partial === false)).toBe(true);
    const zones = run.zones as Array<Record<string, unknown>>;
    expect(zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(zones[0]).toMatchObject({ range: '< 129 bpm', pct: 3.3 });
    expect(zones[2]).toMatchObject({ duration_sec: 900, pct: 50, range: '146-160 bpm' });
    expect(zones[4]).toMatchObject({ range: '> 174 bpm' });
    expect(run.insight).toMatchObject({
      headline: 'Steady aerobic morning',
      verdict: 'moderate',
      what_happened: 'Steady aerobic morning: what happened.',
      do_next: ['Keep the easy days easy.'],
      question_for_runner: 'How did your legs feel?',
      hr_max_used: 190,
      hr_max_source: 'profile',
      model: 'test-model',
    });
    expect((run.insight as { observations: unknown[] }).observations).toHaveLength(2);
  });

  it('runs_get by date returns every run that day in start order, unreviewed ones flagged', async () => {
    const both = await call<{ runs: Array<Record<string, unknown>> }>('runs_get', { date: '2026-10-28' });
    expect(both.runs.map((r) => r.id)).toEqual(['r_oct28am', 'r_oct28pm']);
    expect(both.runs[1]).toMatchObject({ splits: [], zones: [], insight: null });

    const draft = await call<{ runs: Array<Record<string, unknown>> }>('runs_get', { date: '2026-10-29' });
    expect(draft.runs).toHaveLength(1);
    expect(draft.runs[0]).toMatchObject({ id: 'r_oct29draft', reviewed: false, reviewed_at: null });
  });

  it('runs_get reports an unknown id as a tool error', async () => {
    expect(await callError('runs_get', { id: 'missing' })).toContain('no run with id "missing"');
  });

  it('runs_review week from a day: latest week review plus reviewed-only totals for Mon-Sun', async () => {
    const out = await call<Record<string, unknown>>('runs_review', { scope: 'week', key: '2026-10-28' });
    expect(out).toMatchObject({ scope: 'week', key: '2026-W44', from: '2026-10-26', to: '2026-11-01', review_missing: null });
    expect(out.review).toMatchObject({ headline: 'Solid week', verdict: 'moderate' });
    expect(out.totals).toMatchObject({ runs: 2, distance_m: 8230 });
    expect((out.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(['r_oct28pm', 'r_oct28am']);
  });

  it('runs_review week spanning two months, with no stored review', async () => {
    const out = await call<Record<string, unknown>>('runs_review', { scope: 'week', key: '2026-W40' });
    expect(out).toMatchObject({ from: '2026-09-28', to: '2026-10-04', review: null });
    expect(out.review_missing).toContain('2026-W40');
    expect(out.totals).toMatchObject({ runs: 2, distance_m: 18000, avg_hr: 155 });
  });

  it('runs_review month: the newest of several month reviews wins', async () => {
    const out = await call<Record<string, unknown>>('runs_review', { scope: 'month', key: '2026-10' });
    expect(out.review).toMatchObject({ headline: 'October in review' });
    expect(out.review).not.toHaveProperty('hr_max_used');
    expect(out.totals).toMatchObject({ runs: 3, distance_m: 16230, avg_pace: '6:02 /km' });
  });
});
