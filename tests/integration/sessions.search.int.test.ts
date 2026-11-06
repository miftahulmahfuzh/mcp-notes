import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { toVectorLiteral } from '../../src/embeddings/repo.js';
import { SESSIONS_SEMANTIC_OFF_FALLBACK, VIA_REPLIES_MAX, searchSessions } from '../../src/sessions/search.js';
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

describe('searchSessions: notes of a session count as its text', () => {
  async function insertNote(v: { id: string; body: string; madeIn?: string; linkTo?: string; embed?: boolean; deleted?: boolean }): Promise<void> {
    const origin = v.madeIn !== undefined ? JSON.stringify({ claude_session: v.madeIn }) : null;
    await db.execute(sql`
      insert into notes (id, body, origin, created_at, updated_at, deleted_at)
      values (${v.id}, ${v.body}, ${origin}::jsonb, now(), now(), ${v.deleted === true ? sql`now()` : sql`null`})
    `);
    if (v.linkTo !== undefined) {
      await db.execute(sql`insert into note_session_links (note_id, session_id) values (${v.id}, ${v.linkTo})`);
    }
    if (v.embed !== false) {
      await db.execute(sql`
        insert into note_embeddings (note_id, embedding, body_sha256, model, embedded_at, updated_at)
        values (${v.id}, ${toVectorLiteral(embedder.vectorFor(v.body))}::vector,
          encode(sha256(convert_to(${v.body}, 'UTF8')), 'hex'), ${embedder.model}, now(), now())
      `);
    }
  }

  it('hybrid: a word only a linked note has finds its session, listed in via_notes', async () => {
    await insertNote({ id: 'Z-001', body: 'Adversarial shows zero trades, suspect the cutoff', linkTo: 's-other' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'adversarial trades');
    expect(page.mode).toBe('hybrid');
    expect(page.sessions[0]?.session_id).toBe('s-other');
    expect(page.sessions[0]?.via_notes).toEqual([{ id: 'Z-001', excerpt: 'Adversarial shows zero trades, suspect the cutoff' }]);
  });

  it('a note saved from a session (origin) counts as well, and respects the repo filter', async () => {
    await insertNote({ id: 'Z-002', body: 'quokka migration plan', madeIn: 's-literal' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'quokka');
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-literal']);
    const other = await searchSessions({ db, embedder, host: HOST }, 'quokka', { repo: 'seer' });
    expect(other.sessions).toEqual([]);
  });

  it('text mode: note words rank the session too', async () => {
    await insertNote({ id: 'Z-003', body: 'quokka migration plan', linkTo: 's-meaning', embed: false });
    const page = await searchSessions({ db, embedder, host: HOST }, 'quokka', {}, { mode: 'text' });
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-meaning']);
    expect(page.sessions[0]?.via_notes.map((n) => n.id)).toEqual(['Z-003']);
  });

  it('hybrid: a session matched through its note lists that note even when another session matches on its own text', async () => {
    await insertNote({ id: 'Z-004', body: 'Leaderboard ranking tweaks.', linkTo: 's-literal' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'leaderboard ranking tweaks');
    expect(page.sessions.map((s) => s.session_id)).toContain('s-literal');
    expect(page.sessions.find((s) => s.session_id === 's-literal')?.via_notes.map((n) => n.id)).toEqual(['Z-004']);
  });

  it('deleted notes and notes of no session are ignored; own-text hits keep an empty via_notes', async () => {
    await insertNote({ id: 'Z-005', body: 'quokka deleted', linkTo: 's-literal', deleted: true });
    await insertNote({ id: 'Z-006', body: 'quokka loose note' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'quokka');
    expect(page.sessions).toEqual([]);
    const own = await searchSessions({ db, embedder, host: HOST }, 'photo delete');
    expect(own.sessions[0]?.via_notes).toEqual([]);
  });
});

describe('searchSessions: Claude\'s replies count as related text', () => {
  async function insertReply(v: { sessionId: string; seq: number; text: string; embed?: boolean; embedText?: string; model?: string }): Promise<void> {
    await db.execute(sql`
      insert into cc_session_prompts (session_id, seq, at, text, truncated)
      values (${v.sessionId}, ${v.seq}, now(), ${`prompt ${v.seq}`}, false)
    `);
    await db.execute(sql`
      insert into cc_session_replies (session_id, seq, at, text, truncated)
      values (${v.sessionId}, ${v.seq}, now(), ${v.text}, false)
    `);
    if (v.embed !== false) {
      const made = v.embedText ?? v.text;
      await db.execute(sql`
        insert into cc_session_reply_embeddings (session_id, seq, sha, model, embedding, embedded_at, updated_at)
        values (${v.sessionId}, ${v.seq}, encode(sha256(convert_to(${made}, 'UTF8')), 'hex'), ${v.model ?? embedder.model},
          ${toVectorLiteral(embedder.vectorFor(made))}::vector, now(), now())
      `);
    }
  }

  it('hybrid: a word only a reply has finds its session, listed in via_replies with the passage', async () => {
    await insertReply({ sessionId: 's-other', seq: 1, text: 'The wombat cache was stale because its key ignored the repo; it is keyed by repo now.' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'wombat');
    expect(page.mode).toBe('hybrid');
    expect(page.sessions[0]?.session_id).toBe('s-other');
    expect(page.sessions[0]?.via_replies).toEqual([{ seq: 1, excerpt: expect.stringContaining('wombat') }]);
    expect(page.sessions[0]?.via_notes).toEqual([]);
  });

  it('text mode and no embedder: reply words rank the session too', async () => {
    await insertReply({ sessionId: 's-meaning', seq: 1, text: 'wombat flag removed', embed: false });
    const text = await searchSessions({ db, embedder, host: HOST }, 'wombat', {}, { mode: 'text' });
    expect(text.sessions.map((s) => s.session_id)).toEqual(['s-meaning']);
    expect(text.sessions[0]?.via_replies.map((r) => r.seq)).toEqual([1]);
    const fallback = await searchSessions({ db, embedder: null, host: HOST }, 'wombat');
    expect(fallback.fallback).toBe(SESSIONS_SEMANTIC_OFF_FALLBACK);
    expect(fallback.sessions[0]?.via_replies.map((r) => r.seq)).toEqual([1]);
  });

  it('text mode: a session whose own text matches stays above one whose reply says the same', async () => {
    await insertReply({ sessionId: 's-other', seq: 1, text: 'Wall photo delete button added to the editor.', embed: false });
    const page = await searchSessions({ db, embedder, host: HOST }, 'photo delete', {}, { mode: 'text' });
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-literal', 's-other']);
  });

  it('hybrid: meaning only a reply has finds its session; the session whose own text answers stays first', async () => {
    await insertReply({ sessionId: 's-literal', seq: 1, text: 'authentication failed again after suspend on the thinkpad' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'auth failures after resume');
    expect(page.sessions[0]?.session_id).toBe('s-meaning');
    expect(page.sessions.find((s) => s.session_id === 's-literal')?.via_replies.map((r) => r.seq)).toEqual([1]);
  });

  it('ignores a reply vector made from older text or by another model', async () => {
    await insertReply({ sessionId: 's-other', seq: 1, text: 'leaderboard copy tweaks', embedText: 'authentication failed after suspend' });
    await insertReply({ sessionId: 's-other', seq: 2, text: 'authentication failed after suspend', model: 'other/model' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'auth failures after resume');
    expect(page.sessions.map((s) => s.session_id)).not.toContain('s-other');
  });

  it('respects the repo filter and lists at most VIA_REPLIES_MAX replies, best first', async () => {
    await insertReply({ sessionId: 's-meaning', seq: 1, text: 'quokka' });
    await insertReply({ sessionId: 's-meaning', seq: 2, text: 'quokka quokka quokka' });
    await insertReply({ sessionId: 's-meaning', seq: 3, text: 'quokka quokka' });
    await insertReply({ sessionId: 's-meaning', seq: 4, text: 'quokka again' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'quokka');
    const via = page.sessions[0]?.via_replies ?? [];
    expect(via).toHaveLength(VIA_REPLIES_MAX);
    expect(via[0]?.seq).toBe(2);
    expect(via.every((r) => r.excerpt.includes('quokka'))).toBe(true);
    expect((await searchSessions({ db, embedder, host: HOST }, 'quokka', { repo: 'seer' })).sessions).toEqual([]);
  });

  it('own-text hits keep an empty via_replies', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'photo delete');
    expect(page.sessions[0]?.via_replies).toEqual([]);
  });
});
