import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTOR_TOOL_NAMES } from '../../../src/connectors/names.js';
import { registerRunsCurated } from '../../../src/connectors/runs/curated.js';
import type { Connector, QueryResult } from '../../../src/connectors/types.js';

/** A canned result keyed by the statement's leading tag comment, e.g. runs:list. */
type Canned = Record<string, { columns: string[]; rows: unknown[][]; truncated?: boolean }>;

interface Call {
  tag: string;
  sql: string;
  params: readonly unknown[];
}

function fakeConnector(canned: Canned, calls: Call[], fail?: Error): Connector {
  return {
    id: 'runs',
    label: 'run-insights',
    async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
      const tag = /\/\* (runs:\w+) \*\//.exec(sql)?.[1] ?? 'untagged';
      calls.push({ tag, sql, params });
      if (fail) throw fail;
      const c = canned[tag] ?? { columns: [], rows: [] };
      return { columns: c.columns, rows: c.rows, row_count: c.rows.length, truncated: c.truncated ?? false };
    },
  };
}

let client: Client | undefined;

async function connect(connector: Connector): Promise<Client> {
  const server = new McpServer({ name: 'runs-curated-test', version: '0.0.0' });
  registerRunsCurated(server, connector);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: 'runs-curated-test-client', version: '0.0.0' });
  await c.connect(clientTransport);
  client = c;
  return c;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function call<T>(c: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(textOf(result));
  return JSON.parse(textOf(result)) as T;
}

async function callError(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError).toBe(true);
  return textOf(result);
}

const RUN_COLS = [
  'id', 'user_id', 'occurred_on', 'started_at', 'ended_at', 'activity_type', 'location', 'intent',
  'distance_m', 'duration_sec', 'avg_pace_sec', 'avg_hr', 'max_hr', 'resting_hr', 'avg_cadence',
  'elevation_m', 'active_kcal', 'total_kcal', 'end_hr_bpm', 'hr_1min_post_bpm', 'note', 'source',
  'reviewed', 'reviewed_at', 'corrected_at',
];

function runRow(over: Partial<Record<string, unknown>>): unknown[] {
  const base: Record<string, unknown> = {
    id: 'r1', user_id: 'u1', occurred_on: '2026-10-28', started_at: '06:00:00', ended_at: '06:30:00',
    activity_type: 'Outdoor Run', location: null, intent: 'easy', distance_m: 5230, duration_sec: 1800,
    avg_pace_sec: 344, avg_hr: 150, max_hr: 170, resting_hr: null, avg_cadence: 170, elevation_m: 20,
    active_kcal: 350, total_kcal: 420, end_hr_bpm: 165, hr_1min_post_bpm: 130, note: 'felt good',
    source: 'screenshot', reviewed: true, reviewed_at: '2026-10-28 07:00:00+07', corrected_at: null,
    ...over,
  };
  return RUN_COLS.map((c) => base[c]);
}

describe('registerRunsCurated', () => {
  it('registers exactly the three curated run tools named in the contract', async () => {
    const c = await connect(fakeConnector({}, []));
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['runs_get', 'runs_list', 'runs_review']);
    for (const name of names) expect(CONNECTOR_TOOL_NAMES.runs).toContain(name);
  });

  it('runs_list shapes runs with companions and computes period totals', async () => {
    const calls: Call[] = [];
    const c = await connect(
      fakeConnector(
        {
          'runs:list': {
            columns: [...RUN_COLS, 'insight_headline', 'insight_verdict'],
            rows: [
              [...runRow({ id: 'r2', occurred_on: '2026-10-01', started_at: '05:30:00', distance_m: 8000, duration_sec: 2880, avg_pace_sec: 360, avg_hr: null }), null, null],
              [...runRow({}), 'Easy aerobic run', 'easy'],
            ],
          },
          'runs:totals': {
            columns: ['runs', 'run_days', 'distance_m', 'duration_sec', 'hr_weighted_sum', 'hr_duration_sec', 'max_hr', 'longest_m', 'elevation_m', 'active_kcal'],
            rows: [[2, 2, '13230', '4680', '270000', '1800', 170, 8000, '40', '700']],
          },
        },
        calls,
      ),
    );
    const out = await call<{
      from: string;
      to: string;
      runs: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
      truncated: boolean;
    }>(c, 'runs_list', { from: '2026-10-01', to: '2026-10-31' });

    expect(out.from).toBe('2026-10-01');
    expect(out.to).toBe('2026-10-31');
    expect(out.runs.map((r) => r.id)).toEqual(['r1', 'r2']); // newest first even if the driver returned otherwise
    expect(out.runs[0]).toMatchObject({
      date: '2026-10-28',
      km: 5.23,
      duration: '0:30:00',
      avg_pace_sec: 344,
      avg_pace: '5:44 /km',
      hr_drop_1min: 35,
      insight: { headline: 'Easy aerobic run', verdict: 'easy' },
    });
    expect(out.runs[1]?.insight).toBeNull();
    expect(out.totals).toMatchObject({
      runs: 2,
      distance_m: 13230,
      km: 13.23,
      duration_sec: 4680,
      avg_pace_sec: 354,
      avg_pace: '5:54 /km',
      avg_hr: 150,
      longest_run_km: 8,
    });
    expect(out.truncated).toBe(false);
    const list = calls.find((x) => x.tag === 'runs:list');
    expect(list?.params).toEqual(['2026-10-01', '2026-10-31']);
    expect(list?.sql).toContain('reviewed_at IS NOT NULL');
  });

  it('runs_list rejects an inverted range before touching the database', async () => {
    const calls: Call[] = [];
    const c = await connect(fakeConnector({}, calls));
    expect(await callError(c, 'runs_list', { from: '2026-10-31', to: '2026-10-01' })).toContain('after');
    expect(calls).toHaveLength(0);
  });

  it('runs_get returns splits, zones, the full insight and the profile', async () => {
    const c = await connect(
      fakeConnector(
        {
          'runs:by_id': { columns: RUN_COLS, rows: [runRow({})] },
          'runs:splits': {
            columns: ['run_id', 'km', 'time_sec', 'pace_sec', 'hr', 'cadence', 'partial'],
            rows: [
              ['r1', 2, 345, 345, 150, 170, false],
              ['r1', 1, 340, 340, 145, 168, false],
              ['r1', 3, 80, 348, 155, 171, true],
            ],
          },
          'runs:zones': {
            columns: ['run_id', 'zone', 'duration_sec', 'min_bpm', 'max_bpm'],
            rows: [
              ['r1', 1, 600, null, 129],
              ['r1', 2, 1200, 130, 145],
            ],
          },
          'runs:session_insights': {
            columns: ['scope_key', 'payload', 'model', 'generated_at'],
            rows: [
              [
                'r1',
                {
                  headline: 'Easy aerobic run',
                  verdict: 'easy',
                  whatHappened: 'Steady.',
                  observations: [{ title: 'HR', detail: 'Low', metric: '150 bpm' }],
                  doNext: ['Repeat'],
                  questionForRunner: 'How did it feel?',
                  hrMaxUsed: 190,
                  hrMaxSource: 'profile',
                },
                'claude-x',
                '2026-10-28 08:00:00+07',
              ],
            ],
          },
          'runs:profile': { columns: ['max_hr', 'resting_hr'], rows: [[190, 52]] },
        },
        [],
      ),
    );
    const out = await call<{ id: string; runs: Array<Record<string, unknown>>; profile: unknown }>(c, 'runs_get', { id: 'r1' });
    expect(out.id).toBe('r1');
    expect(out.profile).toEqual({ max_hr: 190, resting_hr: 52 });
    const run = out.runs[0] as Record<string, unknown>;
    expect(run.reviewed).toBe(true);
    expect(run.note).toBe('felt good');
    expect((run.splits as Array<{ km: number }>).map((s) => s.km)).toEqual([1, 2, 3]);
    expect((run.splits as Array<{ partial: boolean; pace: string }>)[2]).toMatchObject({ partial: true, pace: '5:48 /km' });
    expect(run.zones).toEqual([
      { zone: 1, duration_sec: 600, duration: '0:10:00', pct: 33.3, min_bpm: null, max_bpm: 129, range: '< 129 bpm' },
      { zone: 2, duration_sec: 1200, duration: '0:20:00', pct: 66.7, min_bpm: 130, max_bpm: 145, range: '130-145 bpm' },
    ]);
    expect(run.insight).toEqual({
      headline: 'Easy aerobic run',
      verdict: 'easy',
      what_happened: 'Steady.',
      observations: [{ title: 'HR', detail: 'Low', metric: '150 bpm' }],
      do_next: ['Repeat'],
      question_for_runner: 'How did it feel?',
      hr_max_used: 190,
      hr_max_source: 'profile',
      generated_at: '2026-10-28 08:00:00+07',
      model: 'claude-x',
    });
  });

  it('runs_get needs exactly one of id or date, and reports an unknown id', async () => {
    const c = await connect(fakeConnector({}, []));
    expect(await callError(c, 'runs_get', {})).toContain('exactly one');
    expect(await callError(c, 'runs_get', { id: 'r1', date: '2026-10-28' })).toContain('exactly one');
    expect(await callError(c, 'runs_get', { id: 'nope' })).toContain('no run with id "nope"');
  });

  it('runs_get by a day with no runs returns an empty list, not an error', async () => {
    const c = await connect(fakeConnector({}, []));
    expect(await call(c, 'runs_get', { date: '2026-10-27' })).toEqual({ date: '2026-10-27', runs: [], profile: null });
  });

  it('runs_review resolves a day to its ISO week and says when no review exists', async () => {
    const calls: Call[] = [];
    const c = await connect(fakeConnector({}, calls));
    const out = await call<Record<string, unknown>>(c, 'runs_review', { scope: 'week', key: '2026-10-28' });
    expect(out).toMatchObject({ scope: 'week', key: '2026-W44', from: '2026-10-26', to: '2026-11-01', review: null, runs: [] });
    expect(out.review_missing).toContain('2026-W44');
    expect(calls.find((x) => x.tag === 'runs:period_insight')?.params).toEqual(['week', '2026-W44']);
    expect(calls.find((x) => x.tag === 'runs:totals')?.params).toEqual(['2026-10-26', '2026-11-01']);
  });

  it('runs_review rejects a key that is neither a period nor a day', async () => {
    const c = await connect(fakeConnector({}, []));
    expect(await callError(c, 'runs_review', { scope: 'month', key: 'banana' })).toContain('not a month');
  });

  it('a connector failure becomes a tool error with the connector message', async () => {
    const c = await connect(fakeConnector({}, [], new Error('run-insights is not reachable: .env.local not found')));
    expect(await callError(c, 'runs_list', { from: '2026-10-01', to: '2026-10-31' })).toContain(
      'run-insights is not reachable: .env.local not found',
    );
  });
});
