import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AdversaryChange } from '../../../src/adversary/events.js';
import { SeerReader } from '../../../src/adversary/seerReader.js';
import { SeerWriter } from '../../../src/adversary/seerWriter.js';
import { AdversaryService } from '../../../src/adversary/service.js';
import { addDays, utcDate } from '../../../src/adversary/sessions.js';
import { DEFAULT_ADVERSARY_CONFIG, type AdversaryConfig } from '../../../src/config.js';
import { createConnector } from '../../../src/connectors/connector.js';
import type { Db } from '../../../src/db/client.js';
import { adversaryReviews } from '../../../src/db/schema.js';
import { fakeReviewer, type FakeReviewer } from '../../helpers/fakeReviewer.js';
import { seedSystem, systemDbUrl, truncateSystem, withAdmin } from '../connectors/harness.js';
import { closeTestDb, openTestDb, truncateAll } from '../setup.js';
import { describeWithAdversarySchema } from './harness.js';

const BRK = 'T-BRK';
const BOOK = 'T-BOOK';
const S1 = '2031-01-14';
const D1 = '2031-01-13';
const OPEN_S1 = '2031-01-14T14:30:00Z';

/** Test roster only: two twinned originals (contract C2 shape) and one active original without a twin. */
const ROSTER_SEED = `
INSERT INTO strategies (id, name, sub, icon, sort, engine, rules_id, object_name, gate_note, gate_applicable, status, twin_of) VALUES
  ('T-BRK', 'TB · Dip test', 'Buys a short dip, test row', 'zap', 1, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', 'test row', true, 'active', NULL),
  ('T-BOOK', 'TK · Book test', 'Holds a monthly basket, test row', 'zap', 2, 'book', 'monthly-hold-frac-gotrade', 'RESIDMOM35', 'test row', true, 'active', NULL),
  ('T-LONE', 'TL · No twin', 'Active, never twinned', 'zap', 3, 'book', 'monthly-hold-frac-gotrade', 'COSKEW', 'test row', true, 'active', NULL);
INSERT INTO strategies (id, name, sub, icon, sort, engine, rules_id, object_name, gate_note, gate_applicable, status, twin_of, is_champion, is_benchmark) VALUES
  ('T-BRK-CX', 'TB+Claude · Dip test', 'Buys a short dip, test row', 'zap', 4, 'bracket', 'design-v0-gotrade', 'STRATEGY_A', 'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'active', 'T-BRK', false, false),
  ('T-BOOK-CX', 'TK+Claude · Book test', 'Holds a monthly basket, test row', 'zap', 5, 'book', 'monthly-hold-frac-gotrade', 'RESIDMOM35', 'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'active', 'T-BOOK', false, false);
`;

let db: Db;
let repoDir: string;

async function seer<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withAdmin(systemDbUrl('seer'), async (c) => (await c.query<T>(sql, params)).rows);
}

async function seedCandidates(strategyId: string, sessionDate: string, dataDate: string, kind: 'bracket' | 'book', symbols: string[]): Promise<void> {
  const rows = symbols.map(
    (symbol, i) => `('${strategyId}', '${sessionDate}', '${dataDate}', '${kind}', ${i + 1}, '${symbol}', ${kind === 'book' ? (1 / symbols.length).toFixed(6) : 'NULL'})`,
  );
  await seedSystem('seer', `INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight) VALUES ${rows.join(', ')}`);
}

function makeService(host: string, reviewer: FakeReviewer, options: { now?: () => Date; config?: Partial<AdversaryConfig> } = {}): AdversaryService {
  return new AdversaryService({
    config: { ...DEFAULT_ADVERSARY_CONFIG, enabled: true, ...options.config },
    db,
    host,
    reviewer,
    seer: new SeerReader(createConnector('seer', { repoDir, settings: { envFile: false } })),
    writer: new SeerWriter({ repoDir: () => repoDir }),
    now: options.now,
    log: () => {},
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describeWithAdversarySchema('Seer Adversarial reviewer against the Seer schema rebuilt from its migrations', () => {
  beforeAll(() => {
    db = openTestDb();
    repoDir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-adversary-seer-'));
    writeFileSync(path.join(repoDir, '.env.local'), `DATABASE_URL_UNPOOLED=${systemDbUrl('seer')}\n`);
  });

  afterAll(async () => {
    await closeTestDb(db);
    rmSync(repoDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await truncateSystem('seer');
    await seedSystem('seer', ROSTER_SEED);
  });

  it('reviews every due pick of a twinned original once and writes verdicts the engine can read', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    await seedCandidates('T-LONE', S1, D1, 'book', ['ZZZ']);
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer);

    const first = await svc.reviewNow();
    expect(first.error).toBeNull();
    expect(first.reviewed).toBe(2);
    expect(reviewer.calls.map((c) => c.pick.symbol)).toEqual(['AAA', 'BBB']);

    const rows = await seer(
      `SELECT strategy_id, session_date::text AS session_date, symbol, verdict, host, model, prompt_version, lens,
              jsonb_array_length(sources) AS n_sources, decided_at < $1::timestamptz AS before_open, superseded_by
       FROM adversary_verdicts ORDER BY symbol`,
      [OPEN_S1],
    );
    expect(rows.map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
    for (const r of rows) {
      expect(r).toMatchObject({ strategy_id: BRK, session_date: S1, verdict: 'object', host: 'lenovo', model: 'claude-opus-test', n_sources: 1, before_open: true, superseded_by: null });
      expect(String(r.prompt_version)).toMatch(/^adv-v1-[0-9a-f]{12}$/);
      expect(String(r.lens)).toMatch(/^STRATEGY_A@[0-9a-f]{8}$/);
    }

    const logged = await db.select().from(adversaryReviews);
    expect(logged.map((r) => `${r.symbol}:${r.stage}:${r.status}`).sort()).toEqual(['AAA:final:ok', 'BBB:final:ok']);
    expect(logged.every((r) => typeof r.verdict?.seer_verdict_id === 'number' && r.inputTokens === 1_200 && r.host === 'lenovo')).toBe(true);

    const second = await svc.reviewNow();
    expect(second.reviewed).toBe(0);
    expect(reviewer.calls).toHaveLength(2);
    expect(await seer('SELECT * FROM adversary_leases')).toHaveLength(0);
  });

  it('lets only one of two hosts review a decision while its lease is held', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    const gate = deferred();
    const lenovoReviewer = fakeReviewer({ gate: gate.promise });
    const gpdReviewer = fakeReviewer();
    const lenovo = makeService('lenovo', lenovoReviewer);
    const gpd = makeService('gpd', gpdReviewer);

    const lenovoRun = lenovo.reviewNow();
    await waitFor(() => lenovoReviewer.calls.length === 1);
    expect(await seer('SELECT host, expires_at > now() AS live FROM adversary_leases')).toEqual([{ host: 'lenovo', live: true }]);

    const gpdRun = await gpd.reviewNow();
    expect(gpdRun).toMatchObject({ leases_lost: 1, reviewed: 0 });
    expect(gpdReviewer.calls).toHaveLength(0);

    gate.resolve();
    expect((await lenovoRun).reviewed).toBe(2);
    expect((await seer<{ host: string }>('SELECT DISTINCT host FROM adversary_verdicts')).map((r) => r.host)).toEqual(['lenovo']);
    expect(await seer('SELECT * FROM adversary_leases')).toHaveLength(0);
  });

  it('takes over a lease another host let expire, judged by the database clock', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    await seedSystem(
      'seer',
      `INSERT INTO adversary_leases (strategy_id, session_date, host, claimed_at, expires_at) VALUES ('${BRK}', '${S1}', 'ghost', now() - interval '1 hour', now() + interval '1 hour')`,
    );
    const svc = makeService('gpd', fakeReviewer());
    expect((await svc.reviewNow()).leases_lost).toBe(1);

    await seedSystem('seer', `UPDATE adversary_leases SET expires_at = now() - interval '1 minute' WHERE host = 'ghost'`);
    expect((await svc.reviewNow()).reviewed).toBe(1);
    expect((await seer<{ host: string }>('SELECT host FROM adversary_verdicts')).map((r) => r.host)).toEqual(['gpd']);
  });

  it('never starts a review once the session has opened', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    const reviewer = fakeReviewer();
    const run = await makeService('lenovo', reviewer, { now: () => new Date('2031-01-14T15:00:00Z') }).reviewNow();
    expect(run.reviewed).toBe(0);
    expect(reviewer.calls).toHaveLength(0);
    expect(await seer('SELECT * FROM adversary_verdicts')).toHaveLength(0);
  });

  it('keeps a verdict that lands after the open, logged late (the engine ignores it)', async () => {
    await seedCandidates(BRK, '2026-01-06', '2026-01-05', 'bracket', ['AAA']);
    const run = await makeService('lenovo', fakeReviewer(), { now: () => new Date('2026-01-06T13:00:00Z') }).reviewNow();
    expect(run).toMatchObject({ reviewed: 1, late: 1 });
    expect(await seer(`SELECT decided_at < '2026-01-06T14:30:00Z'::timestamptz AS before_open FROM adversary_verdicts`)).toEqual([{ before_open: false }]);
    expect((await db.select().from(adversaryReviews)).map((r) => r.status)).toEqual(['late']);
  });

  it('writes one paused mark per due decision while auto runs are off, and reviews only on demand', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    await seedCandidates(BOOK, S1, D1, 'book', ['KKK', 'LLL']);
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer);
    const seen: AdversaryChange[] = [];
    svc.events.on((c) => seen.push(c));

    expect(await svc.setToggle(false, 'lenovo')).toMatchObject({ on: false, host: 'lenovo' });
    expect((await svc.getToggle()).on).toBe(false);

    const auto = await svc.pollNow();
    expect(auto.marks).toBe(2);
    expect(reviewer.calls).toHaveLength(0);
    expect(await seer('SELECT strategy_id, session_date::text AS session_date, mark, host FROM adversary_marks ORDER BY strategy_id')).toEqual([
      { strategy_id: BOOK, session_date: S1, mark: 'paused', host: 'lenovo' },
      { strategy_id: BRK, session_date: S1, mark: 'paused', host: 'lenovo' },
    ]);
    expect(seen).toEqual(
      expect.arrayContaining([
        { type: 'adversary', op: 'toggle' },
        { type: 'adversary', op: 'run' },
        { type: 'adversary', op: 'mark', strategy_id: BRK, session_date: S1 },
      ]),
    );
    expect((await svc.pollNow()).marks).toBe(0);

    const manual = await svc.reviewNow();
    expect(manual.reviewed).toBe(3);
    expect(await seer('SELECT * FROM adversary_verdicts')).toHaveLength(3);
    expect(seen.filter((c) => c.op === 'verdict')).toHaveLength(3);
  });

  it('stops at the daily cap with bracket picks first, and logs each skipped pick once a day', async () => {
    await seedCandidates(BOOK, '2031-01-10', '2031-01-09', 'book', ['KKK']);
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer, { config: { dailyCap: 2 } });

    expect(await svc.reviewNow()).toMatchObject({ reviewed: 2, skipped_budget: 1 });
    expect(reviewer.calls.map((c) => c.pick.symbol)).toEqual(['AAA', 'BBB']);
    expect(await svc.reviewNow()).toMatchObject({ reviewed: 0, skipped_budget: 0 });
    const skipped = (await db.select().from(adversaryReviews)).filter((r) => r.status === 'skipped_budget');
    expect(skipped.map((r) => r.symbol)).toEqual(['KKK']);
    expect((await svc.status()).used_today).toBe(2);
  });

  it('drafts a book preview early, then reuses the draft when the real targets appear', async () => {
    const today = utcDate(new Date());
    const next = addDays(today, 3);
    await seedSystem(
      'seer',
      `INSERT INTO book_previews (strategy_id, data_date, rank, symbol, weight, last, next_decision_session) VALUES
         ('${BOOK}', '${today}', 1, 'PPP', 0.5, 10, '${next}'), ('${BOOK}', '${today}', 2, 'QQQ', 0.5, 20, '${next}')`,
    );
    const reviewer = fakeReviewer();
    const svc = makeService('lenovo', reviewer);

    expect(await svc.reviewNow()).toMatchObject({ drafted: 2, reviewed: 0 });
    expect(await seer('SELECT * FROM adversary_verdicts')).toHaveLength(0);
    expect(await svc.reviewNow()).toMatchObject({ drafted: 0 });

    await seedCandidates(BOOK, next, today, 'book', ['PPP', 'QQQ', 'RRR']);
    expect(await svc.reviewNow()).toMatchObject({ reused: 2, reviewed: 1, drafted: 0 });
    expect(reviewer.calls.map((c) => `${c.decision.stage}:${c.pick.symbol}`)).toEqual(['draft:PPP', 'draft:QQQ', 'final:RRR']);

    const verdicts = await seer<{ symbol: string; prompt_version: string }>('SELECT symbol, prompt_version FROM adversary_verdicts ORDER BY symbol');
    expect(verdicts.map((v) => v.symbol)).toEqual(['PPP', 'QQQ', 'RRR']);
    expect(new Set(verdicts.map((v) => v.prompt_version)).size).toBe(1);
    const finals = (await db.select().from(adversaryReviews)).filter((r) => r.stage === 'final');
    expect(finals.filter((r) => r.reusedFrom !== null).map((r) => r.symbol).sort()).toEqual(['PPP', 'QQQ']);
    expect((await svc.status()).used_today).toBe(3);
  });

  it('re-reviewing supersedes the old verdict and keeps it on the record', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA']);
    const svc = makeService('lenovo', fakeReviewer());
    await svc.reviewNow();
    expect((await svc.reviewNow({ strategyId: BRK, sessionDate: S1, rereview: true })).reviewed).toBe(1);
    const rows = await seer<{ id: string; superseded_by: string | null }>('SELECT id::text AS id, superseded_by::text AS superseded_by FROM adversary_verdicts ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.superseded_by).toBe(rows[1]?.id);
    expect(rows[1]?.superseded_by).toBeNull();
  });

  it('records a failed review and keeps going with the next pick', async () => {
    await seedCandidates(BRK, S1, D1, 'bracket', ['AAA', 'BBB']);
    const svc = makeService('lenovo', fakeReviewer({ fail: (c) => (c.pick.symbol === 'AAA' ? 'the model ran out of turns' : null) }));
    expect(await svc.reviewNow()).toMatchObject({ failed: 1, reviewed: 1 });
    const logged = await db.select().from(adversaryReviews);
    expect(logged.find((r) => r.symbol === 'AAA')).toMatchObject({ status: 'failed', error: 'the model ran out of turns', inputTokens: 1_200 });
    expect((await seer<{ symbol: string }>('SELECT symbol FROM adversary_verdicts')).map((r) => r.symbol)).toEqual(['BBB']);
  });
});
