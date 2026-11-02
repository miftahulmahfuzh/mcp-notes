import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { dbSummaryStore, startSummaryWorker } from '../../src/sessions/summaryWorker.js';
import { createFakeEmbedder } from '../helpers/fakeEmbedder.js';
import { createFakeSummarizer } from '../helpers/fakeSummarizer.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'int-host';
let db: Db;

async function insertSession(v: {
  sessionId: string;
  nodeId: string;
  host?: string;
  lastActiveMinutesAgo: number;
  prompts: string[];
}): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, name, custom_title, first_prompt,
      prompts, commits, files_edited, plan_docs, final_message, started_at, last_active_at, created_at, updated_at)
    values (${v.sessionId}, ${v.nodeId}, ${v.host ?? HOST}, 'mcp-notes', '/home/u/mcp-notes', 'impl-x', 'wall editing',
      ${v.prompts[0] ?? null}, ${JSON.stringify(v.prompts)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'done',
      now() - make_interval(mins => ${v.lastActiveMinutesAgo + 30}),
      now() - make_interval(mins => ${v.lastActiveMinutesAgo}), now(), now())
  `);
}

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db); // phase 1 extended it to the cc_* tables
});

describe('session summary worker (Postgres)', () => {
  it('summarizes and embeds an idle session once, redacted, and skips fresh and foreign ones', async () => {
    await insertSession({
      sessionId: '11111111-1111-1111-1111-111111111111',
      nodeId: 'A0-3G',
      lastActiveMinutesAgo: 60,
      prompts: ['fix the login, password: hunter2'],
    });
    await insertSession({ sessionId: '22222222-2222-2222-2222-222222222222', nodeId: 'B1-4H', lastActiveMinutesAgo: 1, prompts: ['fresh'] });
    await insertSession({
      sessionId: '33333333-3333-3333-3333-333333333333',
      nodeId: 'C2-5J',
      host: 'other-host',
      lastActiveMinutesAgo: 60,
      prompts: ['elsewhere'],
    });

    const summarizer = createFakeSummarizer();
    const embedder = createFakeEmbedder();
    const store = dbSummaryStore(db, new SessionsRepo(db));
    const opts = { store, summarizer, embedder, host: HOST, minIntervalMs: 0, embedMinIntervalMs: 0, sweepMs: 3_600_000, log: () => {} };
    const w = startSummaryWorker(opts);
    await w.idle();
    await w.close();

    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(summarizer.calls[0]?.input).not.toContain('hunter2');

    const rows = await db.execute<{ session_id: string; summary: string | null; summary_sha: string | null; has_vec: boolean | null }>(sql`
      select s.session_id, s.summary, s.summary_sha, e.embedding is not null as has_vec
      from cc_sessions s left join cc_session_embeddings e on e.session_id = s.session_id
      order by s.session_id
    `);
    const byId = new Map(rows.rows.map((r) => [r.session_id, r]));
    expect(byId.get('11111111-1111-1111-1111-111111111111')?.summary).toMatch(/^Summary of Node: A0-3G/);
    expect(byId.get('11111111-1111-1111-1111-111111111111')?.has_vec).toBe(true);
    expect(byId.get('22222222-2222-2222-2222-222222222222')?.summary).toBeNull();
    expect(byId.get('33333333-3333-3333-3333-333333333333')?.summary).toBeNull();

    // A new worker (daemon restart) does nothing for the unchanged session.
    const summarizer2 = createFakeSummarizer();
    const embedder2 = createFakeEmbedder();
    const w2 = startSummaryWorker({ ...opts, summarizer: summarizer2, embedder: embedder2 });
    await w2.idle();
    await w2.close();
    expect(summarizer2.calls).toHaveLength(0);
    expect(embedder2.calls).toHaveLength(0);
  });
});
