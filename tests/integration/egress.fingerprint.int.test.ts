import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import { resetGraphCache, type SessionsReadOverrides } from '../../src/sessions/readModel.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createApiHarness, uniqueTag, type ApiHarness } from './helpers/api-harness.js';
import { clearSessions, seedSession, THIS_HOST } from './helpers/sessionsSeed.js';

let h: ApiHarness;
let queries: string[] = [];

/** Records every statement the pool runs. */
function countQueries(h: ApiHarness): void {
  const client = h.deps.db.$client as unknown as { query: (...a: unknown[]) => unknown };
  const orig = client.query.bind(client);
  client.query = (...args: unknown[]) => {
    const first = args[0];
    queries.push(typeof first === 'string' ? first : ((first as { text?: string })?.text ?? ''));
    return orig(...args);
  };
}

beforeAll(async () => {
  h = await createApiHarness();
  countQueries(h);
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  queries = [];
});

async function getList(etag?: string): Promise<Response> {
  return h.request('/api/notes?limit=50', etag ? { headers: { 'if-none-match': etag } } : undefined);
}

describe('notes fingerprint', () => {
  it('answers an unchanged poll with 304 and one fingerprint query', async () => {
    await h.sendJson('POST', '/api/notes', { body: `first #${uniqueTag()}` });
    const first = await getList();
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control')).toBe('no-cache');
    queries = [];
    const second = await getList(etag!);
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/from notes/i);
  });

  it('moves on body update, soft delete and restore', async () => {
    const created = (await (await h.sendJson('POST', '/api/notes', { body: 'moves' })).json()) as { id: string };
    let etag = (await getList()).headers.get('etag')!;
    const step = async (): Promise<void> => {
      const res = await getList(etag);
      expect(res.status).toBe(200);
      etag = res.headers.get('etag')!;
    };
    await h.notes.update(created.id, 'moves again');
    await step();
    await h.notes.delete(created.id);
    await step();
    await h.notes.restore(created.id);
    await step();
  });

  it('moves when an image is removed and restored', async () => {
    const noteId = await h.insertImageNote(uniqueTag());
    let etag = (await getList()).headers.get('etag')!;
    await h.notes.removeImage(noteId);
    let res = await getList(etag);
    expect(res.status).toBe(200);
    etag = res.headers.get('etag')!;
    await h.notes.restoreImage(noteId);
    res = await getList(etag);
    expect(res.status).toBe(200);
  });

  it('serves /api/tags with its own etag', async () => {
    const first = await h.request('/api/tags');
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    expect((await h.request('/api/tags', { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect(etag).not.toBe((await getList()).headers.get('etag'));
  });
});

describe('graph cache', () => {
  const overrides: SessionsReadOverrides = { host: THIS_HOST, timeZone: 'Asia/Jakarta', live: async () => [] };
  let app: Hono;
  const graphReads = (): number => queries.filter((q) => /from cc_sessions s\s+left join/i.test(q)).length;

  beforeAll(() => {
    app = new Hono();
    app.route('/', sessionsApiRoutes(h.deps, overrides));
  });
  beforeEach(async () => {
    resetGraphCache();
    await clearSessions(h.deps.db);
    await seedSession(h.deps.db, { sessionId: 'sess-fp-1', nodeId: 'F0-1A', repo: 'fp-repo', startedAt: '2026-11-01T00:00:00Z' });
  });

  it('reads rows once for an unchanged repo and again after a write', async () => {
    const first = await app.request('/api/projects/fp-repo/sessions');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    queries = [];
    const second = await app.request('/api/projects/fp-repo/sessions', { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(graphReads()).toBe(0);
    await new SessionsRepo(h.deps.db).setSummary('sess-fp-1', { summary: 'changed', sha: 'abc' });
    queries = [];
    const third = await app.request('/api/projects/fp-repo/sessions', { headers: { 'if-none-match': etag } });
    expect(third.status).toBe(200);
    expect(graphReads()).toBe(1);
  });
});
