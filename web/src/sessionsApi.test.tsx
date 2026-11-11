import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { fetchProjects, fetchSelectedProject, fetchSessionGraph, GRAPH_LIMIT, saveSelectedProject } from './sessionsApi';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('sessionsApi', () => {
  it('asks for one repo by its encoded key and fills missing fields', async () => {
    const fetchMock = vi.fn(async () => json({ repo: 'a b', nodes: [{ session_id: 's1', node_id: 'A0-3G', host: 'gpd', available: false }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { payload: p } = await fetchSessionGraph('a b');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`/api/projects/a%20b/sessions?limit=${GRAPH_LIMIT}`);
    expect(p?.repo).toBe('a b');
    expect(p?.nodes[0]).toEqual({
      session_id: 's1',
      node_id: 'A0-3G',
      repo: null,
      parent_session_id: null,
      parent_node_id: null,
      parent_link_source: null,
      title: 'A0-3G',
      name: null,
      custom_title: null,
      ai_title: null,
      first_prompt: null,
      branch: null,
      cwd: null,
      started_at: null,
      last_active_at: null,
      host: 'gpd',
      available: false,
      live: false,
      status: null,
      tmux: null,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
      cost_usd: null,
      summary_excerpt: null,
      child_count: 0,
      unfinished: null,
      fork: null,
      job_id: null,
    });
  });

  it('reads a fork node and keeps a background job id only while live', async () => {
    const fork = { parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          repo: 'r',
          nodes: [
            { session_id: 's1', node_id: 'JM-UJ', parent_link_source: 'fork', parent_node_id: 'DM-OV', fork, live: true, job_id: 'e3650501' },
            { session_id: 's2', node_id: 'A0-3G', parent_link_source: 'fork', fork: { forked_at: null }, live: false, job_id: 'e3650501' },
          ],
        }),
      ),
    );
    const { payload } = await fetchSessionGraph('r');
    const [a, b] = payload!.nodes;
    expect(a!.parent_link_source).toBe('fork');
    expect(a!.fork).toEqual(fork);
    expect(a!.job_id).toBe('e3650501');
    expect(b!.fork).toBeNull();
    expect(b!.job_id).toBeNull();
  });

  it('sends If-None-Match and keeps nothing new on 304', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSessionGraph('seer', { etag: 'W/"abc"' })).toEqual({ payload: null, etag: 'W/"abc"' });
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)['if-none-match']).toBe('W/"abc"');
  });

  it('reads the project list and the selection, and PUTs a pick as JSON', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects')
        return json({ host: 'lenovo', selected: 'seer', projects: [{ repo: 'seer', sessions: 2, live: 0, last_active_at: null, first_started_at: null, hosts: ['lenovo'] }] });
      if (init?.method === 'PUT') return json(JSON.parse(String(init.body)));
      return json({ repo: 'seer' });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchProjects()).map((p) => p.repo)).toEqual(['seer']);
    expect(await fetchSelectedProject()).toBe('seer');
    expect(await saveSelectedProject('mcp-notes')).toBe('mcp-notes');
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT') as [string, RequestInit];
    expect(put[0]).toBe('/api/projects/selected');
    expect(JSON.parse(String(put[1].body))).toEqual({ repo: 'mcp-notes' });
  });

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));
    await expect(fetchProjects()).rejects.toEqual(new ApiError(500, 'boom'));
  });
});
