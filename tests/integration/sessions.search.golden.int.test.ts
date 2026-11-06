import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { toVectorLiteral } from '../../src/embeddings/repo.js';
import { QueryVectorCache } from '../../src/search/queryVector.js';
import {
  searchSessions,
  type SessionSearchFilter,
  type SessionSearchOptions,
  type SessionSearchPage,
} from '../../src/sessions/search.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

/**
 * Golden output of searchSessions, written from the code as of b41ae04 (before the
 * candidate-source refactor) and kept byte for byte by it. Every timestamp is absolute and `now`
 * is fixed, so recency (and hence every blended score) is identical on every run.
 */

const HOST = 'golden-host';
const NOW = new Date('2026-11-01T00:00:00.000Z');
let db: Db;
let embedder: FakeEmbedder;

interface SeedSession {
  sessionId: string;
  nodeId: string;
  repo: string;
  host?: string;
  summary: string;
  lastActive: string;
  embed?: boolean;
}

const SESSIONS: SeedSession[] = [
  { sessionId: 'g-photo', nodeId: 'A0-3G', repo: 'mcp-notes', summary: 'Wall photo delete button added to the editor.', lastActive: '2026-10-01T10:00:00.000Z' },
  { sessionId: 'g-login', nodeId: 'B1-4H', repo: 'mcp-notes', summary: 'The login broke after the laptop slept.', lastActive: '2026-10-28T10:00:00.000Z' },
  { sessionId: 'g-board', nodeId: 'C2-5J', repo: 'seer', host: 'gpd', summary: 'Leaderboard ranking tweaks.', lastActive: '2026-10-30T10:00:00.000Z' },
  { sessionId: 'g-vault', nodeId: 'D3-6K', repo: 'mcp-notes', summary: 'Arango password moved to the vault.', lastActive: '2026-09-15T10:00:00.000Z' },
  { sessionId: 'g-noemb', nodeId: 'E4-7L', repo: 'seer', summary: 'Photo upload crash on resume.', lastActive: '2026-10-20T10:00:00.000Z', embed: false },
  { sessionId: 'g-tie-a', nodeId: 'F5-8M', repo: 'mcp-notes', summary: 'quokka tie session', lastActive: '2026-10-10T10:00:00.000Z' },
  { sessionId: 'g-tie-b', nodeId: 'G6-9N', repo: 'mcp-notes', summary: 'quokka tie session', lastActive: '2026-10-10T10:00:00.000Z' },
];

interface SeedNote {
  id: string;
  body: string;
  madeIn?: string;
  linkTo?: string[];
  embed?: boolean;
  deleted?: boolean;
}

const NOTES: SeedNote[] = [
  { id: 'N-001', body: 'Adversarial shows zero trades, suspect the cutoff', linkTo: ['g-board'] },
  { id: 'N-002', body: 'quokka migration plan', madeIn: 'g-photo' },
  { id: 'N-003', body: 'Leaderboard ranking tweaks.', linkTo: ['g-photo'] },
  { id: 'N-004', body: 'vault credentials rotated after the login incident', madeIn: 'g-vault', linkTo: ['g-login'] },
  { id: 'N-005', body: 'quokka deleted', linkTo: ['g-login'], deleted: true },
  { id: 'N-006', body: 'photo delete notes for the upload crash', linkTo: ['g-noemb'], embed: false },
  { id: 'N-007', body: 'quokka loose note' },
  { id: 'N-008', body: 'second quokka note about the migration', linkTo: ['g-photo', 'g-tie-a'] },
];

async function seed(): Promise<void> {
  for (const s of SESSIONS) {
    const started = new Date(new Date(s.lastActive).getTime() - 3_600_000).toISOString();
    await db.execute(sql`
      insert into cc_sessions (session_id, node_id, host, repo, cwd, name, first_prompt, prompts, summary,
        started_at, last_active_at, created_at, updated_at)
      values (${s.sessionId}, ${s.nodeId}, ${s.host ?? HOST}, ${s.repo}, '/tmp', null, 'start', '["start"]'::jsonb, ${s.summary},
        ${started}::timestamptz, ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz)
    `);
    if (s.embed !== false) {
      await db.execute(sql`
        insert into cc_session_embeddings (session_id, sha, model, embedding, embedded_at, created_at, updated_at)
        values (${s.sessionId}, 'sha', ${embedder.model}, ${toVectorLiteral(embedder.vectorFor(s.summary))}::vector,
          ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz)
      `);
    }
  }
  for (const n of NOTES) {
    const origin = n.madeIn !== undefined ? JSON.stringify({ claude_session: n.madeIn }) : null;
    await db.execute(sql`
      insert into notes (id, body, origin, created_at, updated_at, deleted_at)
      values (${n.id}, ${n.body}, ${origin}::jsonb, '2026-10-01T00:00:00Z'::timestamptz, '2026-10-01T00:00:00Z'::timestamptz,
        ${n.deleted === true ? sql`'2026-10-02T00:00:00Z'::timestamptz` : sql`null`})
    `);
    for (const sessionId of n.linkTo ?? []) {
      await db.execute(sql`insert into note_session_links (note_id, session_id) values (${n.id}, ${sessionId})`);
    }
    if (n.embed !== false) {
      await db.execute(sql`
        insert into note_embeddings (note_id, embedding, body_sha256, model, embedded_at, updated_at)
        values (${n.id}, ${toVectorLiteral(embedder.vectorFor(n.body))}::vector,
          encode(sha256(convert_to(${n.body}, 'UTF8')), 'hex'), ${embedder.model},
          '2026-10-01T00:00:00Z'::timestamptz, '2026-10-01T00:00:00Z'::timestamptz)
      `);
    }
  }
}

/** What a caller can observe of a page. */
function observable(page: SessionSearchPage): unknown {
  return {
    mode: page.mode,
    fallback: page.fallback ?? null,
    next_cursor: page.next_cursor,
    sessions: page.sessions.map((s) => ({
      session_id: s.session_id,
      node_id: s.node_id,
      available: s.available,
      title: s.title,
      score: s.score,
      via_notes: s.via_notes,
    })),
  };
}

const QUERIES = [
  'photo delete',
  'auth failures after resume',
  'C2-5J photo delete',
  'leaderboard',
  'leaderboard ranking tweaks',
  'quokka',
  'quokka migration',
  'adversarial trades',
  'vault credentials',
  'password',
  'leaderboard or login or photo',
  'photo -delete',
  '"photo delete"',
  'crash',
  'no such word anywhere',
];

const FILTERS: SessionSearchFilter[] = [
  { repo: 'seer' },
  { repo: 'mcp-notes' },
  { host: HOST },
  { from: '2026-10-15' },
  { to: '2026-10-15' },
];

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
  await seed();
});

async function run(query: string, filter: SessionSearchFilter, opts: SessionSearchOptions, withEmbedder = true): Promise<unknown> {
  const deps = { db, embedder: withEmbedder ? embedder : null, host: HOST, queryVectors: new QueryVectorCache() };
  return observable(await searchSessions(deps, query, filter, { now: NOW, ...opts }));
}

describe('searchSessions golden output (must not change in the candidate-source refactor)', () => {
  it('hybrid, every query', async () => {
    const out: Record<string, unknown> = {};
    for (const q of QUERIES) out[q] = await run(q, {}, {});
    expect(out).toMatchSnapshot();
  });

  it('text mode, every query', async () => {
    const out: Record<string, unknown> = {};
    for (const q of QUERIES) out[q] = await run(q, {}, { mode: 'text' });
    expect(out).toMatchSnapshot();
  });

  it('no embedder: text fallback, every query', async () => {
    const out: Record<string, unknown> = {};
    for (const q of QUERIES) out[q] = await run(q, {}, {}, false);
    expect(out).toMatchSnapshot();
  });

  it('filters, both modes', async () => {
    const out: Record<string, unknown> = {};
    for (const f of FILTERS) {
      for (const q of ['leaderboard or login or photo or quokka', 'quokka', 'auth failures after resume']) {
        out[`hybrid ${JSON.stringify(f)} ${q}`] = await run(q, f, {});
        out[`text ${JSON.stringify(f)} ${q}`] = await run(q, f, { mode: 'text' });
      }
    }
    expect(out).toMatchSnapshot();
  });

  it('paging walks the whole ranking, both modes', async () => {
    const out: Record<string, unknown> = {};
    for (const mode of ['hybrid', 'text'] as const) {
      const pages: unknown[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await searchSessions(
          { db, embedder, host: HOST, queryVectors: new QueryVectorCache() },
          'leaderboard or login or photo or quokka or vault',
          { limit: 2, cursor },
          { now: NOW, mode },
        );
        pages.push(observable(page));
        if (page.next_cursor === null) break;
        cursor = page.next_cursor;
      }
      out[mode] = pages;
    }
    expect(out).toMatchSnapshot();
  });
});
