// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { fetchSessionDetail, normalizeSessionDetail, resumeErrorNotice, resumeNotice, resumeSession } from './sessionDetailApi';

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function stub(status: number, body: unknown): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('normalizeSessionDetail', () => {
  it('reads phase 7 detail: session fields under `session`, lists and parent NodeRef at the top', () => {
    const d = normalizeSessionDetail({
      session: {
        session_id: 'cc64',
        node_id: 'A0-3G',
        repo: 'mcp-notes',
        host: 'lenovo',
        available: true,
        live: false,
        title: 'Wall editing',
        ai_title: 'Wall editing',
        tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4, total: 10 },
        cost_usd: 0.25,
        summary: 'Did the thing.',
        parent_node_id: 'B1-11',
        parent_link_source: 'env',
      },
      prompts: [{ text: 'first', at: null }],
      commits: [{ sha: 'abcdef1', subject: 'feat: x' }],
      files_edited: [],
      plan_docs: [],
      notes: [{ id: 'K-F07', excerpt: 'saved note', tags: [], created_at: null }],
      parent: { session_id: 'p', node_id: 'B1-11', repo: 'mcp-notes', title: 'orch-x', started_at: null, last_active_at: null, host: 'lenovo', available: true, live: false, status: null, parent_link_source: null },
      children: [],
    });
    expect(d.prompts).toEqual(['first']);
    expect(d.commits).toEqual([{ sha: 'abcdef1', subject: 'feat: x' }]);
    expect(d.notes).toEqual([{ id: 'K-F07', preview: 'saved note' }]);
    expect(d.parent).toEqual({ node_id: 'B1-11', name: 'orch-x' });
    expect(d.tokens).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
    expect(d.summary).toBe('Did the thing.');
  });

  it('reads flat token columns, a numeric-string cost, string commits and string note ids', () => {
    const d = normalizeSessionDetail({
      session_id: 'cc64',
      node_id: 'A0-3G',
      host: 'lenovo',
      available: true,
      live: true,
      ai_title: 'Wall editing',
      prompts: ['first', { text: 'second' }, '  ', 7],
      commits: ['abcdef1 feat: x', { hash: '1234567', message: 'fix: y' }, { subject: 'no sha' }],
      notes: ['K-F07', { id: 'Z-Z01', excerpt: '\n  first line  \nsecond' }],
      input_tokens: 10,
      output_tokens: '20',
      cache_read_tokens: 30,
      cache_write_tokens: null,
      cost_usd: '1.5',
      parent_node_id: 'B1-11',
      parent_link_source: 'heuristic',
    });
    expect(d.title).toBe('Wall editing');
    expect(d.prompts).toEqual(['first', 'second']);
    expect(d.commits).toEqual([
      { sha: 'abcdef1', subject: 'feat: x' },
      { sha: '1234567', subject: 'fix: y' },
    ]);
    expect(d.notes).toEqual([
      { id: 'K-F07', preview: '' },
      { id: 'Z-Z01', preview: 'first line' },
    ]);
    expect(d.tokens).toEqual({ input: 10, output: 20, cache_read: 30, cache_write: 0 });
    expect(d.cost_usd).toBe(1.5);
    expect(d.parent).toEqual({ node_id: 'B1-11', name: null });
    expect(d.parent_link_source).toBe('heuristic');
    expect(d.live).toBe(true);
    expect(d.repo).toBeNull();
  });

  it('reads a tokens object, a parent object, a {session} wrapper and defaults the rest', () => {
    const d = normalizeSessionDetail({
      session: {
        node_id: 'A0-3G',
        custom_title: 'mine',
        ai_title: 'theirs',
        tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
        parent: { node_id: 'B1-11', name: 'trunk' },
        parent_link_source: 'bogus',
        available: false,
      },
    });
    expect(d.title).toBe('mine');
    expect(d.tokens).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
    expect(d.parent).toEqual({ node_id: 'B1-11', name: 'trunk' });
    expect(d.parent_link_source).toBeNull();
    expect(d.available).toBe(false);
    expect(d.cost_usd).toBeNull();
    expect(d.prompts).toEqual([]);
    expect(d.notes).toEqual([]);
  });
});

describe('fetchSessionDetail', () => {
  it('GETs the node and normalises it', async () => {
    const seen = stub(200, { node_id: 'A0-3G', host: 'lenovo' });
    const d = await fetchSessionDetail('a03g');
    expect(d?.node_id).toBe('A0-3G');
    expect(seen[0]).toEqual({ url: '/api/sessions/a03g', method: 'GET', body: null });
  });

  it('is null on 404 and throws ApiError otherwise', async () => {
    stub(404, { error: 'not_found' });
    expect(await fetchSessionDetail('ZZ-ZZ')).toBeNull();
    stub(500, { error: 'boom' });
    await expect(fetchSessionDetail('A0-3G')).rejects.toMatchObject({ status: 500, message: 'boom' });
  });
});

describe('resumeSession', () => {
  it('POSTs {} to resume, {fresh:true} to spawn fresh, and a trimmed prompt', async () => {
    const seen = stub(200, { action: 'resumed', window: 'note:4' });
    expect(await resumeSession('A0-3G')).toEqual({ action: 'resumed', window: 'note:4' });
    await resumeSession('A0-3G', { fresh: true });
    await resumeSession('A0-3G', { prompt: '  go on  ' });
    expect(seen).toEqual([
      { url: '/api/sessions/A0-3G/resume', method: 'POST', body: {} },
      { url: '/api/sessions/A0-3G/resume', method: 'POST', body: { fresh: true } },
      { url: '/api/sessions/A0-3G/resume', method: 'POST', body: { prompt: 'go on' } },
    ]);
  });

  it('throws the error code as an ApiError', async () => {
    stub(404, { error: 'not_on_this_machine' });
    const err = await resumeSession('A0-3G').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('not_on_this_machine');
  });
});

describe('notices', () => {
  it('says what the daemon did', () => {
    expect(resumeNotice({ action: 'resumed', window: 'note:4' }, false)).toBe('Resumed in note:4');
    expect(resumeNotice({ action: 'spawned', window: null }, true)).toBe('Fresh session started');
    expect(resumeNotice({ action: 'focused', window: 'note:2' }, false)).toBe('Already running, focused in note:2');
    expect(resumeNotice({ action: 'messaged', window: null }, false)).toBe('Already running, prompt sent');
    expect(resumeNotice({ action: 'queued', window: null }, true)).toBe('Fresh session: queued');
  });

  it('explains failures', () => {
    const d = { node_id: 'A0-3G', host: 'GPD' };
    expect(resumeErrorNotice(new ApiError(404, 'not_on_this_machine'), d)).toBe('A0-3G is not on this machine (it ran on GPD)');
    expect(resumeErrorNotice(new ApiError(404, 'not_on_this_machine'), { node_id: 'A0-3G', host: '' })).toBe('A0-3G is not on this machine');
    expect(resumeErrorNotice(new ApiError(403, 'forbidden'), d)).toBe('Resume only works from the wall on this machine');
    expect(resumeErrorNotice(new ApiError(500, 'tmux_failed'), d)).toBe('Could not resume A0-3G: tmux_failed');
    expect(resumeErrorNotice(new Error('x'), d)).toBe('Could not resume A0-3G');
  });
});
