import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { searchSessions } from '../../src/sessions/search.js';
import { SESSION_EMBED_TEXT_VERSION } from '../../src/sessions/summarize.js';
import { dbSummaryStore, startSummaryWorker } from '../../src/sessions/summaryWorker.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

/**
 * Commit subjects are a session's own search context (phase 2 of session-search-context):
 * `cc_sessions.search_tsv` indexes `commits[*].subject` (migration 0013) and the session embed
 * text carries them before the prompts. Sessions are embedded by the real summary worker (fake
 * embedder, summaries off), so the vectors are the ones production would store.
 */

const HOST = 'int-host';
const COMMIT_ONLY = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEANING_ONLY = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
let db: Db;
let embedder: FakeEmbedder;

async function insertSession(v: { sessionId: string; nodeId: string; prompts: string[]; commits: Array<{ sha: string; subject: string }> }): Promise<void> {
  const commits = v.commits.map((c) => ({ ...c, at: null }));
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, first_prompt, prompts, commits,
      started_at, last_active_at, created_at, updated_at)
    values (${v.sessionId}, ${v.nodeId}, ${HOST}, 'mcp-notes', '/tmp', ${v.prompts[0] ?? null},
      ${JSON.stringify(v.prompts)}::jsonb, ${JSON.stringify(commits)}::jsonb,
      now() - interval '2 hours', now() - interval '1 hour', now(), now())
  `);
}

async function embedAll(e: FakeEmbedder): Promise<void> {
  const w = startSummaryWorker({
    store: dbSummaryStore(db, new SessionsRepo(db)),
    summarizer: null,
    embedder: e,
    host: HOST,
    embedMinIntervalMs: 0,
    sweepMs: 3_600_000,
    log: () => {},
  });
  await w.idle();
  await w.close();
}

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
  embedder = createFakeEmbedder();
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  await insertSession({
    sessionId: COMMIT_ONLY,
    nodeId: 'A0-3G',
    prompts: ['tidy the spinner css'],
    commits: [{ sha: '0123456789abcdef', subject: 'fix(wall): zanzibar spinner stalls' }],
  });
  await insertSession({
    sessionId: MEANING_ONLY,
    nodeId: 'B1-4H',
    prompts: ['tidy up'],
    commits: [{ sha: 'fedcba9876543210', subject: 'login broke after laptop resume' }],
  });
  await insertSession({ sessionId: OTHER, nodeId: 'C2-5J', prompts: ['leaderboard ranking tweaks'], commits: [] });
});

describe('searchSessions: commit subjects are part of a session', () => {
  it('text mode: a word only a commit subject has finds the session', async () => {
    const page = await searchSessions({ db, embedder: null, host: HOST }, 'zanzibar');
    expect(page.mode).toBe('text');
    expect(page.sessions.map((s) => s.session_id)).toEqual([COMMIT_ONLY]);
  });

  it('hybrid: a word only a commit subject has ranks that session first', async () => {
    await embedAll(embedder);
    const page = await searchSessions({ db, embedder, host: HOST }, 'zanzibar');
    expect(page.mode).toBe('hybrid');
    expect(page.sessions[0]?.session_id).toBe(COMMIT_ONLY);
  });

  it('hybrid: a meaning only a commit subject carries finds the session through its vector', async () => {
    await embedAll(embedder);
    const query = 'auth failures on wake notebook';
    const words = await searchSessions({ db, embedder: null, host: HOST }, query);
    expect(words.sessions.map((s) => s.session_id)).not.toContain(MEANING_ONLY);
    const page = await searchSessions({ db, embedder, host: HOST }, query);
    expect(page.sessions[0]?.session_id).toBe(MEANING_ONLY);
  });

  it('the sha of a commit is not indexed, only its subject', async () => {
    const page = await searchSessions({ db, embedder: null, host: HOST }, '0123456789abcdef');
    expect(page.sessions).toEqual([]);
  });
});

describe('summary worker: the embed-text version re-embeds every session once', () => {
  it('stamps new vectors with the current version', async () => {
    await embedAll(embedder);
    const res = await db.execute<{ text_version: number }>(sql`select text_version from cc_session_embeddings order by session_id`);
    expect(res.rows.map((r) => r.text_version)).toEqual([SESSION_EMBED_TEXT_VERSION, SESSION_EMBED_TEXT_VERSION, SESSION_EMBED_TEXT_VERSION]);
  });

  it('a vector from before the version (text_version 0) is rebuilt exactly once, then left alone', async () => {
    await embedAll(createFakeEmbedder());
    // What migration 0013 leaves behind: every existing vector at version 0, unchanged sha.
    await db.execute(sql`update cc_session_embeddings set text_version = 0`);

    const second = createFakeEmbedder();
    await embedAll(second);
    expect(second.calls.flat()).toHaveLength(3);
    const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_embeddings where text_version = ${SESSION_EMBED_TEXT_VERSION}`);
    expect(res.rows[0]?.n).toBe(3);

    const third = createFakeEmbedder();
    await embedAll(third);
    expect(third.calls).toHaveLength(0);
  });
});
