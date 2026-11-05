import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AdversaryReader } from '../../../src/adversary/read.js';
import { isoOf, openAt } from '../../../src/adversary/readSql.js';
import type {
  AdversaryDecision,
  MethodPayload,
  OverviewPayload,
  ScorecardPayload,
  ThreeWay,
  VerdictList,
} from '../../../src/adversary/readTypes.js';
import { sessionOpenUtc } from '../../../src/adversary/sessions.js';
import { toObjects } from '../../../src/connectors/seer/rows.js';
import type { Connector } from '../../../src/connectors/types.js';
import { adversaryApiRoutes } from '../../../src/http/adversaryApi.js';
import { registerAdversaryTools } from '../../../src/mcp/adversaryTools.js';
import { fakeAdversary, type FakeAdversary } from '../helpers/adversaryFake.js';
import { cleanupHarness, connectorFor, describeWithRepo, seedSystem, truncateSystem } from './harness.js';

const SEED = readFileSync(new URL('../../fixtures/adversary/seer-seed.sql', import.meta.url), 'utf8');
const SAME_ORIGIN = { origin: 'http://localhost' };

describeWithRepo('seer', 'Seer Adversarial read model, API and MCP on a seeded Seer schema', () => {
  let seer: Connector;
  let reader: AdversaryReader;
  let fake: FakeAdversary;
  let app: Hono;

  beforeAll(async () => {
    await truncateSystem('seer');
    await seedSystem('seer', SEED);
    seer = connectorFor('seer');
    reader = new AdversaryReader(seer);
    fake = fakeAdversary();
    app = new Hono();
    app.route('/', adversaryApiRoutes({ adversary: fake.service }, { seer }));
  });

  afterAll(() => cleanupHarness());

  const getJson = async <T>(path: string, status = 200): Promise<T> => {
    const res = await app.request(path);
    expect(res.status, path).toBe(status);
    return (await res.json()) as T;
  };

  it("computes the session open in SQL exactly like phase 4's sessionOpenUtc (C3 pinned examples)", async () => {
    const res = await seer.query(`SELECT ${isoOf(openAt("'2026-11-04'"))} AS winter, ${isoOf(openAt("'2026-07-01'"))} AS summer`);
    const row = toObjects(res)[0]!;
    expect(row).toEqual({ winter: '2026-11-04T14:30:00.000Z', summer: '2026-07-01T13:30:00.000Z' });
    expect(sessionOpenUtc('2026-11-04').toISOString()).toBe(row.winter);
    expect(sessionOpenUtc('2026-07-01').toISOString()).toBe(row.summer);
  });

  it('overview: roster, methods with returns, coverage, checklists, cause, latest, last review', async () => {
    const o = await getJson<OverviewPayload>('/api/adversary/overview');
    expect(o.roster.map((m) => [m.strategy_id, m.twin_id, m.cadence, m.status])).toEqual([
      ['A-GT', 'A-GT-CX', 'daily', 'active'],
      ['RAW35-FR-GT', 'RAW35-FR-GT-CX', 'monthly', 'active'],
      ['MOM70-FR-GT', null, 'monthly', 'retired'],
    ]);
    expect(o.methods.map((m) => m.strategy_id)).toEqual(['A-GT', 'RAW35-FR-GT']);
    const [a, raw] = o.methods;
    expect(a!.window).toEqual({ from: '2026-10-02', to: '2026-10-06', sessions: 3 });
    expect(a!.coverage).toEqual({ decisions: 4, reviewed: 1, absent: 2, late: 1, paused: 1, pending: 0 });
    expect(a!.objections).toEqual({ objected: 1, reviewed: 3, fell_after: 1, scored: 1, pending: 0 });
    expect(a!.returns.twin!).toBeGreaterThan(a!.returns.spy!);
    expect(a!.returns.spy!).toBeGreaterThan(0);
    expect(a!.returns.original!).toBeLessThan(0);
    expect(a!.figures.twin).toMatchObject({ deposits_usd: 300, gain_usd: 180, worst_drop: 0, trades: 1, profit_factor: 'infinite', fees_usd: null });
    expect(a!.figures.original).toMatchObject({ deposits_usd: 300, gain_usd: -9.06, trades: 2, profit_factor: 3, fees_usd: null });
    expect(a!.figures.original!.worst_drop).toBeCloseTo(0.1, 6);
    expect(a!.beyond_original_usd).toBe(189);
    expect(a!.checklist.original.map((i) => i.seer.val)).toEqual(['0.1 mo', '+50.0 vs +56.9', '3.00', '10.0%', 'Not passed']);
    expect(a!.checklist.original.map((i) => i.state)).toEqual(['fail', 'fail', 'pass', 'pass', 'fail']);
    expect(a!.checklist.twin.map((i) => i.state)).toEqual(['fail', 'pass', 'pass', 'pass', 'na']);
    expect(a!.checklist.twin[4]).toMatchObject({ value: "can't be run", seer: { label: 'Backtest gate', val: "Can't be run", ok: false } });
    expect(raw!.coverage).toEqual({ decisions: 2, reviewed: 1, absent: 1, late: 0, paused: 0, pending: 0 });
    expect(raw!.figures.original).toMatchObject({ deposits_usd: 0, gain_usd: 6, fees_usd: 0.1 });
    expect(raw!.figures.twin).toMatchObject({ deposits_usd: 0, gain_usd: 3, fees_usd: 0.4 });
    expect(raw!.beyond_original_usd).toBe(-2.94);
    expect(raw!.checklist.original[4]!.seer.val).toBe('Passed');
    expect(o.cause).toEqual({
      twins: 2,
      twins_beat_spy: ['A-GT', 'RAW35-FR-GT'],
      originals_beat_spy: ['RAW35-FR-GT'],
      extra_profit_usd: 186.06,
      drawdown_delta_pts: -5,
    });
    expect(o.latest.map((v) => [v.id, v.symbol, v.verdict, v.late, v.host])).toEqual([
      [4, 'CCC', 'unsure', false, 'lenovo'],
      [2, 'AAA', 'object', false, 'lenovo'],
      [6, 'XOM', 'object', false, 'gpd'],
    ]);
    expect(o.latest[1]!.sources.map((s) => s.publisher)).toEqual(['sec.gov', 'benzinga.com']);
    expect(o.last_review).toEqual({ strategy_id: 'A-GT', session_date: '2026-10-06', picks: 1, finished_at: '2026-10-06T13:45:00.000Z' });
    expect(o).toMatchObject({ started_on: '2026-10-01', months_on_paper: 0.13, spy_id: 'SPY-GT' });
    expect(o.reviewer).toMatchObject({ host: 'test-host', daily_cap: 15 });
  });

  it('method: curves with deposits taken out, record, revisions, decisions, three-way; a twin id opens its original', async () => {
    const m = await getJson<MethodPayload>('/api/adversary/methods/a-gt-cx');
    expect(m.method.strategy_id).toBe('A-GT');
    expect(m.curves).toEqual({ dates: ['2026-10-02', '2026-10-05', '2026-10-06'], original: [100, 110, 99], twin: [100, 120, 120], spy: [100, 105, 107.1] });
    expect(m.record.points.map((p) => [p.symbol, p.session_date, p.outcome, p.gap_pts])).toEqual([['AAA', '2026-10-05', 'worse', -13]]);
    expect(m.revisions.map((r) => [r.prompt_version, r.verdicts, r.until === null])).toEqual([
      ['pv-a2', 1, true],
      ['pv-a1', 4, false],
    ]);
    expect(m.decisions.map((d) => [d.session_date, d.coverage])).toEqual([
      ['2026-10-08', 'absent'],
      ['2026-10-07', 'paused'],
      ['2026-10-06', 'absent'],
      ['2026-10-05', 'reviewed'],
    ]);
    expect(m.decision?.session_date).toBe('2026-10-05');
    expect(m.three_way?.critic.strategy_id).toBe('C-GT');
    expect(m.three_way?.session_date).toBe('2026-10-05');
    expect(m.lens_question).toBeNull();
  });

  it('decision cards: the counted verdict wins over a superseded one; review header; late verdicts leave it absent', async () => {
    const d = await getJson<AdversaryDecision>('/api/adversary/methods/A-GT/decisions/2026-10-05');
    expect(d).toMatchObject({
      coverage: 'reviewed',
      data_date: '2026-10-02',
      open_utc: '2026-10-05T13:30:00.000Z',
      counts: { object: 1, unsure: 1, agree: 1, none: 0, late: 0 },
      first_started_at: '2026-10-05T12:50:00.000Z',
      last_decided_at: '2026-10-05T13:10:00.000Z',
      models: ['claude-opus-5-5'],
      prompt_versions: ['pv-a1'],
      hosts: ['lenovo'],
    });
    expect(d.verdicts.map((v) => [v.symbol, v.id, v.verdict, v.action])).toEqual([
      ['AAA', 2, 'object', 'skip'],
      ['BBB', 3, 'agree', null],
      ['CCC', 4, 'unsure', null],
    ]);
    const late = await getJson<AdversaryDecision>('/api/adversary/methods/A-GT/decisions/2026-10-06');
    expect(late).toMatchObject({ coverage: 'absent', counts: { object: 0, unsure: 0, agree: 0, none: 2, late: 1 } });
    expect(late.picks[1]!.verdict).toMatchObject({ id: 5, late: true, action: null });
  });

  it("book decision: held · sell, new names keep their pro-rata share, twin weights from the twin's own book", async () => {
    const d = await getJson<AdversaryDecision>('/api/adversary/methods/RAW35-FR-GT/decisions/2026-10-01');
    expect(d.picks.map((p) => [p.symbol, p.held, p.twin_weight, p.twin_weight_source, p.verdict?.action ?? null])).toEqual([
      ['XOM', true, 0, 'twin_book', 'sell'],
      ['NVDA', false, 0.6, 'twin_book', null],
      ['AMD', false, 0.4, 'twin_book', null],
    ]);
  });

  it('three-way: A, C and Claude side by side, what each book bought, grid and who was right', async () => {
    const t = await getJson<ThreeWay>('/api/adversary/daily/A-GT');
    expect(t.sessions).toEqual(['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05']);
    expect(t.session_date).toBe('2026-10-05');
    expect(t.rows.map((r) => [r.symbol, r.c?.verdict, r.claude?.verdict, r.buys])).toEqual([
      ['AAA', 'allow', 'object', { original: true, critic: true, twin: false }],
      ['BBB', 'veto', 'agree', { original: true, critic: false, twin: true }],
      ['CCC', 'allow', 'unsure', { original: false, critic: true, twin: true }],
    ]);
    expect(t.grid).toEqual({ c_veto_claude_object: [], c_veto_claude_keep: ['BBB'], c_allow_claude_object: ['AAA'], c_allow_claude_keep: ['CCC'] });
    expect(t.settled).toEqual({ claude_right: 2, critic_right: 0, disagreements: 2, scored: 2, pending: 0, nights: 1 });
    expect(t.books.original).toMatchObject({ strategy_id: 'A-GT', trades: 2, profit_factor: 3 });
    expect(t.books.twin).toMatchObject({ strategy_id: 'A-GT-CX', trades: 1 });
    expect((await getJson<ThreeWay>('/api/adversary/daily/A-GT?session=2026-10-08')).rows.map((r) => r.symbol)).toEqual(['FFF']);
  });

  it('scorecard: the horizon record for a book and the duel for a daily method', async () => {
    const raw = await getJson<ScorecardPayload>('/api/adversary/scorecard/RAW35-FR-GT');
    expect(raw.duel).toBeNull();
    expect(raw.record.horizon).toBe('until the next rebalance');
    expect(raw.record.points).toEqual([
      expect.objectContaining({ symbol: 'XOM', outcome: 'worse', gap_pts: -15, kept: 2, horizon_from: '2026-09-30', horizon_to: '2026-10-14', fell: true }),
    ]);
    const a = await getJson<ScorecardPayload>('/api/adversary/scorecard/A-GT');
    expect(a.record.points[0]).toMatchObject({ symbol: 'AAA', horizon_to: '2026-10-09', sessions: 5 });
    expect(a.duel).toMatchObject({ critic_id: 'C-GT', disagreements: 2, claude_right: 2, critic_right: 0 });
  });

  it('verdict list: latest decision per method by default; a session and a verdict filter', async () => {
    const objections: VerdictList = await reader.verdicts({ verdict: 'object' });
    expect(objections.verdicts.map((v) => [v.strategy_id, v.session_date, v.symbol, v.late])).toEqual([
      ['A-GT', '2026-10-06', 'DDD', true],
      ['RAW35-FR-GT', '2026-10-01', 'XOM', false],
    ]);
    expect(objections.sessions).toEqual([
      { strategy_id: 'A-GT', session_date: '2026-10-06', coverage: 'absent' },
      { strategy_id: 'RAW35-FR-GT', session_date: '2026-10-01', coverage: 'reviewed' },
    ]);
    const day = await reader.verdicts({ strategy: 'a-gt', session: '2026-10-05' });
    expect(day.verdicts.map((v) => [v.symbol, v.id])).toEqual([['AAA', 2], ['BBB', 3], ['CCC', 4]]);
  });

  it('errors: unknown, malformed, not a daily method, Seer unreachable', async () => {
    expect(await getJson('/api/adversary/methods/NOPE', 404)).toMatchObject({ error: 'not_found' });
    expect(await getJson('/api/adversary/methods/C-GT', 404)).toMatchObject({ error: 'not_found' });
    expect(await getJson('/api/adversary/methods/A-GT/decisions/2026-13-01', 400)).toMatchObject({ error: 'invalid_session' });
    expect(await getJson('/api/adversary/methods/A-GT/decisions/2026-10-09', 404)).toMatchObject({ error: 'not_found' });
    expect(await getJson('/api/adversary/methods/bad%20id', 400)).toMatchObject({ error: 'invalid_id' });
    expect(await getJson('/api/adversary/daily/RAW35-FR-GT', 400)).toMatchObject({ error: 'not_bracket' });
    const down = new Hono();
    down.route('/', adversaryApiRoutes({ adversary: null }, { seer: connectorFor('seer', { repoDir: null }) }));
    const res = await down.request('/api/adversary/overview');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'seer_unavailable', detail: 'not_reachable' });
    const off = await down.request('/api/adversary/toggle');
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: 'reviewer_off' });
  });

  it('toggle and review-now: same-origin only, reach the reviewer, review-now answers 202 before the pass ends', async () => {
    expect(await getJson('/api/adversary/toggle')).toEqual({ on: true, changed_at: null, host: null });
    const json = { 'content-type': 'application/json' };
    expect((await app.request('/api/adversary/toggle', { method: 'PUT', headers: json, body: '{"on":false}' })).status).toBe(403);
    const put = await app.request('/api/adversary/toggle', { method: 'PUT', headers: { ...json, ...SAME_ORIGIN }, body: '{"on":false}' });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ on: false, host: 'test-host' });
    expect(fake.toggles).toEqual([{ on: false, host: 'test-host' }]);
    expect((await app.request('/api/adversary/toggle', { method: 'PUT', headers: { ...json, ...SAME_ORIGIN }, body: '{"on":"no"}' })).status).toBe(400);

    expect((await app.request('/api/adversary/review-now', { method: 'POST', headers: json, body: '{}' })).status).toBe(403);
    const now = await app.request('/api/adversary/review-now', { method: 'POST', headers: { ...json, ...SAME_ORIGIN }, body: '{"strategy_id":"a-gt-cx"}' });
    expect(now.status).toBe(202);
    expect(await now.json()).toEqual({ started: true, reason: null });
    expect(fake.reviews).toEqual([{ strategyId: 'A-GT' }]);
    const all = await app.request('/api/adversary/review-now', { method: 'POST', headers: SAME_ORIGIN });
    expect(all.status).toBe(202);
    expect(fake.reviews[1]).toEqual({});
    const unknown = await app.request('/api/adversary/review-now', { method: 'POST', headers: { ...json, ...SAME_ORIGIN }, body: '{"strategy_id":"NOPE"}' });
    expect(unknown.status).toBe(404);
    const bad = await app.request('/api/adversary/review-now', { method: 'POST', headers: { ...json, ...SAME_ORIGIN }, body: '{"strategy_id":5}' });
    expect(bad.status).toBe(400);
  });

  it('MCP: three read-only tools answer from the same read model', async () => {
    const server = new McpServer({ name: 'adversary-test', version: '0.0.0' });
    registerAdversaryTools(server, { connectors: { seer } as never, adversary: fake.service });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'adversary-test-client', version: '0.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(['adversary_overview', 'adversary_scorecard', 'adversary_verdicts']);
      for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
      const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
      const overview = JSON.parse(text((await client.callTool({ name: 'adversary_overview', arguments: {} })) as CallToolResult)) as OverviewPayload;
      expect(overview.methods.map((x) => x.strategy_id)).toEqual(['A-GT', 'RAW35-FR-GT']);
      const objections = JSON.parse(
        text((await client.callTool({ name: 'adversary_verdicts', arguments: { verdict: 'object' } })) as CallToolResult),
      ) as VerdictList;
      expect(objections.verdicts.map((v) => v.symbol)).toEqual(['DDD', 'XOM']);
      const card = JSON.parse(
        text((await client.callTool({ name: 'adversary_scorecard', arguments: { strategy: 'RAW35-FR-GT' } })) as CallToolResult),
      ) as ScorecardPayload;
      expect(card.record.points[0]).toMatchObject({ symbol: 'XOM', outcome: 'worse' });
      const missing = (await client.callTool({ name: 'adversary_scorecard', arguments: { strategy: 'NOPE' } })) as CallToolResult;
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/not_found/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a decision whose session has not opened is pending and becomes the page default (runs last: adds a row)', async () => {
    await seedSystem(
      'seer',
      `INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence)
       VALUES ('A-GT', '2099-01-05', '2099-01-02', 'bracket', 1, 'FUT', NULL, NULL)`,
    );
    const o = await reader.overview(null);
    expect(o.methods[0]!.coverage).toEqual({ decisions: 5, reviewed: 1, absent: 2, late: 1, paused: 1, pending: 1 });
    const m = await reader.method('A-GT');
    expect(m.decision).toMatchObject({ session_date: '2099-01-05', coverage: 'pending' });
  });
});
