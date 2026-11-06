import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import type { SessionsReadOverrides } from '../../src/sessions/readModel.js';
import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS } from '../../src/sessions/types.js';
import type {
  ContextPayload,
  GraphPayload,
  ProjectsPayload,
  PromptsPayload,
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
  // Never the real clones: every known sha links to a fake forge.
  commitLinks: async ({ shas }) => new Map(shas.map((sha) => [sha.toLowerCase(), `https://forge.test/r/-/commit/${sha}`])),
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
    expect(body.commits).toEqual([
      { sha: 'abc1234def', subject: 'feat(web): photo delete', url: 'https://forge.test/r/-/commit/abc1234def' },
    ]);
    expect(body.files_edited).toEqual(['web/src/components/NoteEditor.tsx']);
    expect(body.plan_docs).toEqual(['docs/plans/WALL_EDITING_PLAN.md']);
    expect(body.notes.map((n) => n.id)).toEqual([note.id]);
    expect(body.parent).toBeNull();
    expect(body.children.map((c) => c.node_id)).toEqual(['B1-22', 'C2-33']);
    expect(body.children[0]).toMatchObject({ live: true, parent_link_source: 'env' });
  });

  it('a recorded cost stays; without one the cost is estimated; the subagent share is estimated', async () => {
    const opus = { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const haiku = { inputTokens: 0, outputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // B1-22 has no recorded cost: its models (session + subagent) are priced.
    await h.deps.db.execute(
      sql`update cc_sessions set models = ${JSON.stringify({ 'claude-opus-5-5': opus, 'claude-haiku-5-5': haiku })}::jsonb where session_id = 'sess-b1'`,
    );
    await h.deps.db.execute(sql`
      insert into cc_subagent_transcripts (transcript_path, session_id, agent_id, host, models)
      values ('/t/sess-b1/subagents/agent-a1.jsonl', 'sess-b1', 'a1', ${THIS_HOST}, ${JSON.stringify({ 'claude-haiku-5-5': haiku })}::jsonb)`);
    const child = (await get<SessionDetail>('/api/sessions/B1-22')).body.session;
    expect(child).toMatchObject({ cost_estimated: true, subagent_count: 1 });
    expect(child.cost_usd).toBeCloseTo(20 + 1, 6);
    expect(child.subagent_cost_usd).toBeCloseTo(1, 6);
    // A0-3G carries a recorded total and no subagents.
    const root = (await get<SessionDetail>('/api/sessions/A0-3G')).body.session;
    expect(root).toMatchObject({ cost_usd: 1.25, cost_estimated: false, subagent_count: 0, subagent_cost_usd: null });
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

describe('POST /api/sessions/:nodeId/summarize', () => {
  const summarize = (nodeId: string, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> =>
    Promise.resolve(app.request(`/api/sessions/${nodeId}/summarize`, { method: 'POST', headers }));

  const requestedAt = async (sessionId: string): Promise<string | null> => {
    const res = await h.deps.db.execute<{ at: Date | string | null }>(
      sql`select summary_requested_at as at from cc_sessions where session_id = ${sessionId}`,
    );
    const at = res.rows[0]?.at ?? null;
    return at === null ? null : new Date(at).toISOString();
  };

  it('detail says why there is no summary', async () => {
    expect((await get<SessionDetail>('/api/sessions/A0-3G')).body.session).toMatchObject({ summary_state: 'ready', summary_requested_at: null });
    expect((await get<SessionDetail>('/api/sessions/B1-22')).body.session.summary_state).toBe('idle_wait');
    expect((await get<SessionDetail>('/api/sessions/C2-33')).body.session.summary_state).toBe('empty');
    await h.deps.db.execute(sql`update cc_sessions set input_tokens = 5 where session_id = 'sess-c2'`);
    expect((await get<SessionDetail>('/api/sessions/C2-33')).body.session.summary_state).toBe('other_host');
  });

  it('records a request through SessionsRepo, same-origin only, idempotently, and detail shows it', async () => {
    const noOrigin = await summarize('D4-44', {});
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: 'forbidden_origin' });
    expect(await requestedAt('sess-d4')).toBeNull();

    const first = await summarize('d444');
    expect(first.status).toBe(200);
    const body = (await first.json()) as { node_id: string; summary_state: string; summary_requested_at: string | null };
    expect(body).toMatchObject({ node_id: 'D4-44', summary_state: 'requested' });
    expect(body.summary_requested_at).toBe(await requestedAt('sess-d4'));
    expect(body.summary_requested_at).not.toBeNull();

    const again = await summarize('D4-44');
    expect(await again.json()).toEqual(body);

    expect((await get<SessionDetail>('/api/sessions/D4-44')).body.session).toMatchObject({
      summary_state: 'requested',
      summary_requested_at: body.summary_requested_at,
    });
  });

  it('a live session can be requested; another host\'s session too', async () => {
    expect(((await (await summarize('B1-22')).json()) as { summary_state: string }).summary_state).toBe('requested');
    await h.deps.db.execute(sql`update cc_sessions set input_tokens = 5 where session_id = 'sess-c2'`);
    expect(((await (await summarize('C2-33')).json()) as { summary_state: string }).summary_state).toBe('requested');
    expect(await requestedAt('sess-c2')).not.toBeNull();
  });

  it('ready writes nothing; empty is 409; bad and unknown ids are 400 / 404', async () => {
    const ready = await summarize('A0-3G');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ node_id: 'A0-3G', summary_state: 'ready', summary_requested_at: null });
    expect(await requestedAt('sess-root')).toBeNull();

    const empty = await summarize('C2-33');
    expect(empty.status).toBe(409);
    expect(await empty.json()).toEqual({ error: 'empty_session', node_id: 'C2-33' });
    expect(await requestedAt('sess-c2')).toBeNull();

    const bad = await summarize('A-B32');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_node_id' });

    const missing = await summarize('ZZ-ZZ');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
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

describe('GET /api/sessions/:nodeId/prompts', () => {
  const LONG = `${'x'.repeat(2500)}\n  tail kept`;
  const SPACED = '  indented\n\n\tkeep [redacted] spacing  ';

  async function storePrompts(sessionId: string, version: number, rows: Array<{ seq: number; at: string | null; text: string; truncated?: boolean }>): Promise<void> {
    await h.deps.db.execute(sql`update cc_sessions set prompts_version = ${version} where session_id = ${sessionId}`);
    for (const r of rows) {
      await h.deps.db.execute(sql`
        insert into cc_session_prompts (session_id, seq, at, text, truncated)
        values (${sessionId}, ${r.seq}, ${r.at}::timestamptz, ${r.text}, ${r.truncated ?? false})`);
    }
  }

  it('lists every stored prompt of a backfilled row in seq order, numbered from 1, text byte for byte', async () => {
    await storePrompts('sess-root', PROMPTS_VERSION, [
      { seq: 2, at: '2026-10-31T18:05:00Z', text: LONG },
      { seq: 1, at: '2026-10-31T18:00:00Z', text: SPACED },
      { seq: 3, at: null, text: 'cut here', truncated: true },
    ]);
    const { status, body } = await get<PromptsPayload>('/api/sessions/a03g/prompts');
    expect(status).toBe(200);
    expect(body).toEqual({
      node_id: 'A0-3G',
      host: THIS_HOST,
      available: true,
      complete: true,
      incomplete_reason: null,
      prompts: [
        { n: 1, text: SPACED, at: '2026-10-31T18:00:00.000Z', truncated: false, images: [] },
        { n: 2, text: LONG, at: '2026-10-31T18:05:00.000Z', truncated: false, images: [] },
        { n: 3, text: 'cut here', at: null, truncated: true, images: [] },
      ],
    });
  });

  it('attaches a pasted image to its prompt, with chat-image urls and host availability', async () => {
    await storePrompts('sess-root', PROMPTS_VERSION, [{ seq: 1, at: null, text: 'see this' }]);
    const sha1 = 'x'.repeat(64);
    const sha2 = 'y'.repeat(64);
    await h.deps.db.execute(sql`delete from chat_images where id in ('A-IMG1', 'A-IMG2')`);
    await h.deps.db.execute(sql`
      insert into chat_images (id, path, sha256, mime, width, height, bytes, host, source)
      values ('A-IMG1', 'chat-images/2026/11/A-IMG1.png', ${sha1}, 'image/png', 12, 8, 100, ${THIS_HOST}, 'claude_code'),
             ('A-IMG2', 'chat-images/2026/11/A-IMG2.png', ${sha2}, 'image/png', 20, 10, 100, ${OTHER_HOST}, 'claude_code')`);
    await h.deps.db.execute(sql`
      insert into cc_session_prompt_images (session_id, prompt_seq, position, image_id, paste_id)
      values ('sess-root', 1, 0, 'A-IMG1', 1), ('sess-root', 1, 1, 'A-IMG2', 2)`);
    const { status, body } = await get<PromptsPayload>('/api/sessions/a03g/prompts');
    expect(status).toBe(200);
    expect(body.prompts).toEqual([
      {
        n: 1,
        text: 'see this',
        at: null,
        truncated: false,
        images: [
          { id: 'A-IMG1', width: 12, height: 8, available: true, urls: { thumb: '/api/chat/images/A-IMG1/thumb', display: '/api/chat/images/A-IMG1/display' } },
          { id: 'A-IMG2', width: 20, height: 10, available: false, urls: { thumb: '/api/chat/images/A-IMG2/thumb', display: '/api/chat/images/A-IMG2/display' } },
        ],
      },
    ]);
  });

  it('a backfilled row with no prompts answers an empty list', async () => {
    await storePrompts('sess-b1', PROMPTS_VERSION, []);
    const { body } = await get<PromptsPayload>('/api/sessions/B1-22/prompts');
    expect(body).toMatchObject({ node_id: 'B1-22', complete: true, prompts: [] });
  });

  it('falls back to the cc_sessions excerpts, complete false, until the owning host backfills', async () => {
    await h.deps.db.execute(sql`
      update cc_sessions set prompts = ${JSON.stringify([{ text: 'old excerpt…', at: '2026-11-01T02:00:00Z' }])}::jsonb
      where session_id = 'sess-c2'`);
    // A tail append on a legacy row may already have written side rows; they are partial and ignored.
    await storePrompts('sess-c2', 0, [{ seq: 1, at: null, text: 'partial side row' }]);
    const { status, body } = await get<PromptsPayload>('/api/sessions/C2-33/prompts');
    expect(status).toBe(200);
    expect(body).toEqual({
      node_id: 'C2-33',
      host: OTHER_HOST,
      available: false,
      complete: false,
      incomplete_reason: 'not_backfilled',
      prompts: [{ n: 1, text: 'old excerpt…', at: '2026-11-01T02:00:00.000Z', truncated: false, images: [] }],
    });
  });

  it('a row redacted in place from excerpts (transcript pruned) lists its side rows, never complete', async () => {
    await storePrompts('sess-d4', PROMPTS_VERSION_EXCERPTS, [
      { seq: 1, at: '2026-10-01T00:00:00Z', text: 'old one' },
      { seq: 2, at: null, text: 'deploy with [redacted] and more…', truncated: true },
    ]);
    const { status, body } = await get<PromptsPayload>('/api/sessions/D4-44/prompts');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      node_id: 'D4-44',
      complete: false,
      incomplete_reason: 'transcript_pruned',
      prompts: [
        { n: 1, text: 'old one', at: '2026-10-01T00:00:00.000Z', truncated: false },
        { n: 2, text: 'deploy with [redacted] and more…', at: null, truncated: true },
      ],
    });
  });

  it('400 invalid_node_id, 404 not_found', async () => {
    const bad = await get<{ error: string }>('/api/sessions/A-B32/prompts');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_node_id' });
    const missing = await get<{ error: string }>('/api/sessions/ZZ-ZZ/prompts');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });

  it('the graph and detail payloads do not carry the side-table text', async () => {
    await storePrompts('sess-root', PROMPTS_VERSION, [{ seq: 1, at: null, text: 'only-in-side-table-7f3' }]);
    const graph = await app.request('/api/projects/mcp-notes/sessions');
    expect(await graph.text()).not.toContain('only-in-side-table-7f3');
    const detail = await app.request('/api/sessions/A0-3G');
    expect(await detail.text()).not.toContain('only-in-side-table-7f3');
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

describe('GET /api/sessions/known', () => {
  it('returns the ids that exist with their repo, dropping unknown and invalid ones', async () => {
    const { status, body } = await get<{ nodes: Array<{ node_id: string; repo: string | null }> }>(
      '/api/sessions/known?ids=b1-22,ZZ-ZZ,%20bad!,A0-3G,a03g',
    );
    expect(status).toBe(200);
    expect(body.nodes.map((n) => n.node_id)).toEqual(['A0-3G', 'B1-22']);
    expect(body.nodes.every((n) => typeof n.repo === 'string')).toBe(true);
  });

  it('is empty for no ids', async () => {
    expect((await get<{ nodes: unknown[] }>('/api/sessions/known')).body).toEqual({ nodes: [] });
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
    expect(body.hits.map((x) => x.via_replies)).toEqual([[], []]);
  });

  it('uses phase 6 search for real and reports the text fallback without an embedder', async () => {
    const { status, body } = await get<SearchPayload>('/api/sessions/search?q=photo%20delete');
    expect(status).toBe(200);
    expect(body.mode).toBe('text');
    expect(typeof body.fallback).toBe('string');
    expect(body.hits.map((x) => x.node_id)).toContain('A0-3G');
    expect(body.hits.every((x) => Array.isArray(x.via_notes) && Array.isArray(x.via_replies))).toBe(true);
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
