import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownIdsRoutes, type KnownIds } from '../../src/http/knownIdsApi.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';
import { clearSessions, seedSession } from './helpers/sessionsSeed.js';

let h: ApiHarness;
let app: Hono;
let noteId: string;
let deletedNoteId: string;
let movieId: string;

async function known(ids: string): Promise<KnownIds> {
  const res = await app.request(`/api/ids/known?ids=${encodeURIComponent(ids)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as KnownIds;
}

beforeAll(async () => {
  h = await createApiHarness();
  app = new Hono();
  app.route('/', knownIdsRoutes(h.deps));
  await clearSessions(h.deps.db);
  await truncateMovies(h.deps.db);
  noteId = (await h.notes.create({ body: 'known ids: kept' })).id;
  deletedNoteId = (await h.notes.create({ body: 'known ids: deleted' })).id;
  await h.notes.delete(deletedNoteId);
  await seedSession(h.deps.db, { sessionId: 'sess-known', nodeId: 'KN-0W', firstPrompt: 'x', startedAt: '2026-11-01T00:00:00Z' });
  await seedTitle(h.deps.db, { id: 'movie-990001', kind: 'movie', tmdbId: 990001, title: 'Known' });
  const rows = await h.deps.db.execute<{ id: string }>(sql`select id from movie_ids where title_id = 'movie-990001'`);
  movieId = rows.rows[0]!.id;
});

afterAll(async () => {
  await clearSessions(h.deps.db);
  await truncateMovies(h.deps.db);
  await h.close();
});

describe('GET /api/ids/known', () => {
  it('answers every kind in one request and drops the ids that do not exist', async () => {
    const absentNote = noteId === '0-000' ? '0-001' : '0-000';
    const absentMovie = movieId === 'M-0000' ? 'M-0001' : 'M-0000';
    const body = await known(`${noteId},${absentNote},KN-0W,CI-CD,${movieId},${absentMovie}`);
    expect(body.notes).toEqual([noteId]);
    expect(body.nodes.map((n) => n.node_id)).toEqual(['KN-0W']);
    expect(body.movies).toEqual([movieId]);
  });

  it('counts a soft-deleted note: its id is real', async () => {
    expect((await known(deletedNoteId)).notes).toEqual([deletedNoteId]);
  });

  it('takes the canonical form only', async () => {
    const loose = `${noteId.toLowerCase()} ${noteId.replace('-', '')} kn-0w KN0W ${movieId.toLowerCase()} bad!`;
    expect(await known(loose)).toEqual({ notes: [], nodes: [], movies: [] });
  });

  it('is empty for no ids and refuses a list that is too long', async () => {
    expect(await (await app.request('/api/ids/known')).json()).toEqual({ notes: [], nodes: [], movies: [] });
    expect((await app.request(`/api/ids/known?ids=${'A-B32,'.repeat(200)}`)).status).toBe(400);
  });
});
