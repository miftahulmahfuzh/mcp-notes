import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import type { SessionsReadOverrides } from '../../src/sessions/readModel.js';
import type {
  ContextPayload,
  GraphPayload,
  ProjectsPayload,
  SearchPayload,
  SessionDetail,
  TranscriptPayload,
  UsagePayload,
} from '../../src/sessions/view.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { clearSessions, OTHER_HOST, seedGraph, seedSession, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  // sess-c2 is "live" in the registry but on the other host: it must not show as live.
  live: async () => [
    { sessionId: 'sess-b1', status: 'busy', tmux: 'note:@0.%7' },
    { sessionId: 'sess-c2', status: 'busy', tmux: null },
  ],
};

let h: ApiHarness;
let app: Hono;
let transcript: { file: string; cleanup: () => Promise<void> };

async function get<T>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T; res: Response }> {
  const res = await app.request(pathname, init);
  const text = await res.text();
  return { status: res.status, body: (text === '' ? null : JSON.parse(text)) as T, res };
}

beforeAll(async () => {
  h = await createApiHarness();
  app = new Hono();
  app.route('/', sessionsApiRoutes(h.deps, overrides));
  transcript = await writeTranscript();
});

afterAll(async () => {
  await clearSessions(h.deps.db);
  await transcript.cleanup();
  await h.close();
});

beforeEach(async () => {
  await clearSessions(h.deps.db);
  await seedGraph(h.deps.db, transcript.file);
});

describe('GET /api/projects', () => {
  it('lists repos most recently active first with counts, live count and hosts', async () => {
    const { status, body } = await get<ProjectsPayload>('/api/projects');
    expect(status).toBe(200);
    expect(body.host).toBe(THIS_HOST);
    expect(body.selected).toBeNull();
    expect(body.projects.map((p) => p.repo)).toEqual(['mcp-notes', 'seer']);
    expect(body.projects[0]).toMatchObject({
      sessions: 3,
      live: 1,
      hosts: [OTHER_HOST, THIS_HOST].sort(),
      last_active_at: '2026-11-01T03:00:00.000Z',
      first_started_at: '2026-10-31T18:00:00.000Z',
    });
  });

  it('is mounted by createApp', async () => {
    const full = createApp(h.deps, { sessions: overrides });
    const res = await full.request('/api/projects');
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProjectsPayload).projects).toHaveLength(2);
  });
});

describe('selected project', () => {
  const put = (repo: string | null, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> =>
    Promise.resolve(
      app.request('/api/projects/selected', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ repo }),
      }),
    );

  it('round-trips through app_settings, same-origin only, known repos only', async () => {
    expect((await get<{ repo: string | null }>('/api/projects/selected')).body).toEqual({ repo: null });

    const noOrigin = await put('mcp-notes', {});
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: 'forbidden_origin' });

    const ok = await put('mcp-notes');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ repo: 'mcp-notes' });
    expect((await get<{ repo: string | null }>('/api/projects/selected')).body).toEqual({ repo: 'mcp-notes' });
    expect((await get<ProjectsPayload>('/api/projects')).body.selected).toBe('mcp-notes');

    const unknown = await put('no-such-repo');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_repo', repo: 'no-such-repo' });

    expect((await put(null)).status).toBe(200);
    expect((await get<{ repo: string | null }>('/api/projects/selected')).body).toEqual({ repo: null });
  });

  it('400 on a bad body', async () => {
    const res = await app.request('/api/projects/selected', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN },
      body: JSON.stringify({ repo: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects/:repo/sessions', () => {
  it('returns every node newest first with parent node ids, availability, liveness and a reserved unfinished', async () => {
    const { status, body, res } = await get<GraphPayload>('/api/projects/mcp-notes/sessions');
    expect(status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{40}"$/);
    expect(body).toMatchObject({ repo: 'mcp-notes', host: THIS_HOST, total: 3, truncated: false, next_before: null });
    expect(body.nodes.map((n) => n.node_id)).toEqual(['C2-33', 'B1-22', 'A0-3G']);
    const [c2, b1, root] = body.nodes;
    expect(c2).toMatchObject({ parent_node_id: 'A0-3G', parent_link_source: 'heuristic', available: false, live: false, host: OTHER_HOST });
    expect(b1).toMatchObject({ parent_node_id: 'A0-3G', parent_link_source: 'env', available: true, live: true, status: 'busy', tmux: 'note:@0.%7', title: 'impl-wall-p1' });
    expect(root).toMatchObject({
      parent_node_id: null,
      child_count: 2,
      cost_usd: 1.25,
      tokens: { input: 100, output: 200, cache_read: 1000, cache_write: 50, total: 1350 },
      unfinished: null,
    });
    expect(root!.summary_excerpt).toContain('photo delete');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const first = await app.request('/api/projects/mcp-notes/sessions');
    const etag = first.headers.get('etag')!;
    const again = await app.request('/api/projects/mcp-notes/sessions', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('pages with limit and before', async () => {
    const page1 = await get<GraphPayload>('/api/projects/mcp-notes/sessions?limit=2');
    expect(page1.body.nodes.map((n) => n.node_id)).toEqual(['C2-33', 'B1-22']);
    expect(page1.body.truncated).toBe(true);
    expect(page1.body.next_before).toBe('2026-11-01T01:00:00.000Z');
    const page2 = await get<GraphPayload>(`/api/projects/mcp-notes/sessions?limit=2&before=${encodeURIComponent(page1.body.next_before!)}`);
    expect(page2.body.nodes.map((n) => n.node_id)).toEqual(['A0-3G']);
    expect(page2.body.truncated).toBe(false);
  });

  it('404 for an unknown repo, 400 for a bad limit', async () => {
    expect((await get('/api/projects/nope/sessions')).status).toBe(404);
    expect((await get('/api/projects/mcp-notes/sessions?limit=0')).status).toBe(400);
    expect((await get('/api/projects/mcp-notes/sessions?before=yesterday')).status).toBe(400);
  });

  it('serves a 1000-node repo in one page', async () => {
    for (let i = 0; i < 1000; i++) {
      const a = (i % 36).toString(36).toUpperCase();
      const b = Math.floor(i / 36).toString(36).toUpperCase().padStart(2, '0');
      await seedSession(h.deps.db, {
        sessionId: `bulk-${i}`,
        nodeId: `Z${a}-${b}`,
        repo: 'bulk',
        startedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      });
    }
    const { status, body } = await get<GraphPayload>('/api/projects/bulk/sessions');
    expect(status).toBe(200);
    expect(body.total).toBe(1000);
    expect(body.nodes).toHaveLength(1000);
    expect(body.truncated).toBe(false);
  });
});

describe('GET /api/sessions/:nodeId', () => {
  it('returns the full detail, case-insensitive and dash-tolerant, with notes made in the session', async () => {
    const note = await h.notes.create({ body: 'insight from the wall session #psgtest', origin: { claude_session: 'sess-root' } });
    const { status, body } = await get<SessionDetail>('/api/sessions/a03g');
    expect(status).toBe(200);
    expect(body.session).toMatchObject({
      node_id: 'A0-3G',
      session_id: 'sess-root',
      summary: 'Planned the wall editing photo delete flow and wrote the plan.',
      transcript_path: transcript.file,
      entrypoint: 'cli',
      final_message: 'Done.',
    });
    expect(body.prompts).toEqual([{ text: 'Plan the wall photo delete flow', at: '2026-10-31T18:00:00.000Z' }]);
    expect(body.commits).toEqual([{ sha: 'abc1234def', subject: 'feat(web): photo delete' }]);
    expect(body.files_edited).toEqual(['web/src/components/NoteEditor.tsx']);
    expect(body.plan_docs).toEqual(['docs/plans/WALL_EDITING_PLAN.md']);
    expect(body.notes.map((n) => n.id)).toEqual([note.id]);
    expect(body.parent).toBeNull();
    expect(body.children.map((c) => c.node_id)).toEqual(['B1-22', 'C2-33']);
    expect(body.children[0]).toMatchObject({ live: true, parent_link_source: 'env' });
  });

  it('a child names its parent', async () => {
    const { body } = await get<SessionDetail>('/api/sessions/B1-22');
    expect(body.parent).toMatchObject({ node_id: 'A0-3G', session_id: 'sess-root' });
    expect(body.notes).toEqual([]);
  });

  it('400 invalid_node_id, 404 not_found', async () => {
    expect((await get<{ error: string }>('/api/sessions/A-B32')).body).toEqual({ error: 'invalid_node_id' });
    const missing = await get<{ error: string }>('/api/sessions/ZZ-ZZ');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });
});

describe('GET /api/sessions/:nodeId/transcript', () => {
  it('searches the transcript on the owning host', async () => {
    const { status, body } = await get<TranscriptPayload>('/api/sessions/A0-3G/transcript?query=photo%20delete');
    expect(status).toBe(200);
    expect(body).toMatchObject({ node_id: 'A0-3G', query: 'photo delete', transcript_path: transcript.file, total_matches: 2, truncated: false });
    expect(body.matches.map((m) => m.line)).toEqual([1, 2]);
  });

  it('without a query returns the last messages', async () => {
    const { body } = await get<TranscriptPayload>('/api/sessions/A0-3G/transcript?limit=1');
    expect(body.query).toBeNull();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]!.excerpt).toBe('Unrelated closing words.');
  });

  it('404 not_on_this_machine for another host, transcript_missing when the file is gone or unrecorded', async () => {
    const remote = await get<{ error: string; host: string }>('/api/sessions/C2-33/transcript?query=x');
    expect(remote.status).toBe(404);
    expect(remote.body).toEqual({ error: 'not_on_this_machine', node_id: 'C2-33', host: OTHER_HOST });

    const unrecorded = await get<{ error: string }>('/api/sessions/B1-22/transcript');
    expect(unrecorded.status).toBe(404);
    expect(unrecorded.body).toEqual({ error: 'transcript_missing', node_id: 'B1-22' });

    await seedSession(h.deps.db, { sessionId: 'sess-gone', nodeId: 'E5-55', transcriptPath: '/nonexistent/sess-gone.jsonl', startedAt: '2026-10-01T00:00:00Z' });
    expect((await get<{ error: string }>('/api/sessions/E5-55/transcript')).body).toEqual({ error: 'transcript_missing', node_id: 'E5-55' });
  });
});

describe('GET /api/sessions/context', () => {
  it('returns context only for ids that exist, in request order', async () => {
    // 'bad!' is not a node id at all (note: a bare 4-letter word like "nope" IS one, NO-PE, and would be looked up).
    const { status, body } = await get<ContextPayload>('/api/sessions/context?ids=a03g,ZZ-ZZ,%20bad!,B1-22,A0-3G');
    expect(status).toBe(200);
    expect(body.nodes.map((n) => n.node_id)).toEqual(['A0-3G', 'B1-22']);
    // Invalid inputs first (as given), then well-formed ids that do not exist (canonical).
    expect(body.missing).toEqual(['bad!', 'ZZ-ZZ']);
    const root = body.nodes[0]!.text;
    expect(root).toContain('Session A0-3G');
    expect(root).toContain('Children: B1-22, C2-33');
    expect(root).toContain('Summary: Planned the wall editing photo delete flow');
    expect(root).toContain('Plan docs: docs/plans/WALL_EDITING_PLAN.md');
    expect(root).toContain('Commits: abc1234 feat(web): photo delete');
    expect(root).toContain(`Transcript: ${transcript.file}`);
    expect(body.context.startsWith('Claude Code session nodes mentioned in this prompt')).toBe(true);
  });

  it('is empty for no ids or only unknown ids', async () => {
    expect((await get<ContextPayload>('/api/sessions/context')).body).toEqual({ nodes: [], missing: [], context: '' });
    expect((await get<ContextPayload>('/api/sessions/context?ids=ZZ-ZZ')).body).toEqual({ nodes: [], missing: ['ZZ-ZZ'], context: '' });
  });

  it('is loopback only', async () => {
    const foreignOrigin = await app.request('/api/sessions/context?ids=A0-3G', { headers: { origin: 'http://evil.example' } });
    expect(foreignOrigin.status).toBe(403);
    expect(await foreignOrigin.json()).toEqual({ error: 'forbidden_origin' });
    const foreignHost = await app.request('http://evil.example/api/sessions/context?ids=A0-3G');
    expect(foreignHost.status).toBe(403);
    expect(await foreignHost.json()).toEqual({ error: 'forbidden_host' });
  });
});

describe('GET /api/sessions/search', () => {
  it('hydrates the search hits in rank order (injected search)', async () => {
    const searchApp = new Hono();
    searchApp.route(
      '/',
      sessionsApiRoutes(h.deps, {
        ...overrides,
        search: async ({ query, repo, limit }) => {
          expect({ query, repo, limit }).toEqual({ query: 'photo delete', repo: 'mcp-notes', limit: 5 });
          return { mode: 'hybrid', fallback: null, hits: [{ sessionId: 'sess-b1', score: 0.912345 }, { sessionId: 'gone', score: 0.5 }, { sessionId: 'sess-root', score: 0.8 }] };
        },
      }),
    );
    const res = await searchApp.request('/api/sessions/search?q=photo%20delete&repo=mcp-notes&limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchPayload;
    expect(body.mode).toBe('hybrid');
    expect(body.hits.map((x) => [x.node_id, x.score])).toEqual([
      ['B1-22', 0.9123],
      ['A0-3G', 0.8],
    ]);
  });

  it('uses phase 6 search for real and reports the text fallback without an embedder', async () => {
    const { status, body } = await get<SearchPayload>('/api/sessions/search?q=photo%20delete');
    expect(status).toBe(200);
    expect(body.mode).toBe('text');
    expect(typeof body.fallback).toBe('string');
    expect(body.hits.map((x) => x.node_id)).toContain('A0-3G');
  });

  it('400 without q', async () => {
    expect((await get('/api/sessions/search')).status).toBe(400);
    expect((await get('/api/sessions/search?q=%20')).status).toBe(400);
  });
});

describe('GET /api/sessions/usage', () => {
  it('by month, in the daemon timezone', async () => {
    const { status, body } = await get<Extract<UsagePayload, { by: 'month' }>>('/api/sessions/usage?by=month');
    expect(status).toBe(200);
    expect(body.time_zone).toBe('Asia/Jakarta');
    // sess-root started 2026-10-31T18:00Z = 2026-11-01 01:00 WIB, so it counts in November.
    expect(body.rows.map((r) => [r.month, r.sessions])).toEqual([
      ['2026-11', 3],
      ['2026-09', 1],
    ]);
    expect(body.rows[0]).toMatchObject({ input_tokens: 110, output_tokens: 220, cache_read_tokens: 1000, cache_write_tokens: 50, total_tokens: 1380, cost_usd: 1.25 });
    expect(body.totals.sessions).toBe(4);
    expect(body.totals.cost_usd).toBe(10.75);
  });

  it('by node, filtered by repo and month', async () => {
    const all = await get<Extract<UsagePayload, { by: 'node' }>>('/api/sessions/usage?by=node');
    expect(all.body.rows[0]!.node_id).toBe('D4-44');
    const repo = await get<Extract<UsagePayload, { by: 'node' }>>('/api/sessions/usage?by=node&repo=mcp-notes&limit=1');
    expect(repo.body.rows.map((r) => r.node_id)).toEqual(['A0-3G']);
    expect(repo.body.totals.sessions).toBe(3);
    const sept = await get<Extract<UsagePayload, { by: 'node' }>>('/api/sessions/usage?by=node&month=2026-09');
    expect(sept.body.rows.map((r) => r.node_id)).toEqual(['D4-44']);
  });

  it('400 on bad parameters', async () => {
    expect((await get('/api/sessions/usage?by=week')).status).toBe(400);
    expect((await get('/api/sessions/usage?month=2026-13')).status).toBe(400);
  });
});
