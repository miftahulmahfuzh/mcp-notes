import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { toVectorLiteral } from '../../src/embeddings/repo.js';
import { SESSIONS_SEMANTIC_OFF_FALLBACK, searchSessions } from '../../src/sessions/search.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'int-host';
let db: Db;
let embedder: FakeEmbedder;

async function insertSession(v: {
  sessionId: string;
  nodeId: string;
  repo: string;
  host?: string;
  summary: string;
  daysAgo: number;
  embed?: boolean;
}): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, name, first_prompt, prompts, summary,
      started_at, last_active_at, created_at, updated_at)
    values (${v.sessionId}, ${v.nodeId}, ${v.host ?? HOST}, ${v.repo}, '/tmp', null, 'start', '["start"]'::jsonb, ${v.summary},
      now() - make_interval(days => ${v.daysAgo}, hours => 1), now() - make_interval(days => ${v.daysAgo}), now(), now())
  `);
  if (v.embed !== false) {
    const vec = embedder.vectorFor(v.summary);
    await db.execute(sql`
      insert into cc_session_embeddings (session_id, sha, model, embedding, embedded_at, created_at, updated_at)
      values (${v.sessionId}, 'sha', ${embedder.model}, ${toVectorLiteral(vec)}::vector, now(), now(), now())
    `);
  }
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
  await truncateAll(db); // phase 1 extended it to the cc_* tables
  await insertSession({ sessionId: 's-literal', nodeId: 'A0-3G', repo: 'mcp-notes', summary: 'Wall photo delete button added to the editor.', daysAgo: 30 });
  await insertSession({ sessionId: 's-meaning', nodeId: 'B1-4H', repo: 'mcp-notes', summary: 'The login broke after the laptop slept.', daysAgo: 2 });
  await insertSession({ sessionId: 's-other', nodeId: 'C2-5J', repo: 'seer', host: 'gpd', summary: 'Leaderboard ranking tweaks.', daysAgo: 1 });
});

describe('searchSessions', () => {
  it('hybrid: a literal hit ranks first', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'photo delete');
    expect(page.mode).toBe('hybrid');
    expect(page.sessions[0]?.session_id).toBe('s-literal');
    expect(page.sessions[0]?.node_id).toBe('A0-3G');
    expect(page.sessions[0]?.available).toBe(true);
  });

  it('hybrid: finds a session by meaning with no shared word', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'auth failures after resume');
    expect(page.sessions.map((s) => s.session_id)).toContain('s-meaning');
    expect(page.sessions[0]?.session_id).toBe('s-meaning');
  });

  it('a node id in the query goes first', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'C2-5J photo delete');
    expect(page.sessions[0]?.session_id).toBe('s-other');
    expect(page.sessions[0]?.available).toBe(false);
  });

  it('without an embedder: full text with a fallback', async () => {
    const page = await searchSessions({ db, embedder: null, host: HOST }, 'photo delete');
    expect(page.mode).toBe('text');
    expect(page.fallback).toBe(SESSIONS_SEMANTIC_OFF_FALLBACK);
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-literal']);
  });

  it('mode text has no fallback', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'leaderboard', {}, { mode: 'text' });
    expect(page.mode).toBe('text');
    expect(page.fallback).toBeUndefined();
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-other']);
  });

  it('filters by repo, host and date', async () => {
    const byRepo = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { repo: 'seer' });
    expect(byRepo.sessions.map((s) => s.session_id)).toEqual(['s-other']);
    const byHost = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { host: HOST });
    expect(byHost.sessions.map((s) => s.session_id).sort()).toEqual(['s-literal', 's-meaning']);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const recent = await searchSessions({ db, embedder, host: HOST }, 'photo or delete or login', { from });
    expect(recent.sessions.map((s) => s.session_id)).not.toContain('s-literal');
  });

  it('pages with next_cursor and rejects an empty query', async () => {
    const first = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { limit: 1 });
    expect(first.sessions).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { limit: 1, cursor: first.next_cursor ?? undefined });
    expect(second.sessions[0]?.session_id).not.toBe(first.sessions[0]?.session_id);
    await expect(searchSessions({ db, embedder, host: HOST }, '   ')).rejects.toThrow(/non-empty/);
  });
});
