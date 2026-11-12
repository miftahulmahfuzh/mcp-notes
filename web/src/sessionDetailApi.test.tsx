// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  fetchSessionDetail,
  fetchSessionPrompts,
  normalizeHandoffEstimate,
  normalizeSessionContext,
  normalizeSessionDetail,
  parseContextEvent,
  requestSummary,
  resumeErrorNotice,
  resumeNotice,
  resumeSession,
  summarizeErrorNotice,
} from './sessionDetailApi';

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
      commits: [{ sha: 'abcdef1', subject: 'feat: x', url: 'https://github.com/o/r/commit/abcdef1' }],
      files_edited: [],
      plan_docs: [],
      notes: [{ id: 'K-F07', excerpt: 'saved note', tags: [], created_at: null }],
      parent: { session_id: 'p', node_id: 'B1-11', repo: 'mcp-notes', title: 'orch-x', started_at: null, last_active_at: null, host: 'lenovo', available: true, live: false, status: null, parent_link_source: null },
      children: [],
    });
    expect(d.prompts).toEqual(['first']);
    expect(d.commits).toEqual([{ sha: 'abcdef1', subject: 'feat: x', url: 'https://github.com/o/r/commit/abcdef1' }]);
    expect(d.notes).toEqual([{ id: 'K-F07', preview: 'saved note', kind: 'made' }]);
    expect(d.parent).toEqual({ node_id: 'B1-11', name: 'orch-x', repo: 'mcp-notes' });
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
      { sha: 'abcdef1', subject: 'feat: x', url: null },
      { sha: '1234567', subject: 'fix: y', url: null },
    ]);
    expect(d.notes).toEqual([
      { id: 'K-F07', preview: '', kind: 'made' },
      { id: 'Z-Z01', preview: 'first line', kind: 'made' },
    ]);
    expect(d.tokens).toEqual({ input: 10, output: 20, cache_read: 30, cache_write: 0 });
    expect(d.cost_usd).toBe(1.5);
    expect(d.parent).toEqual({ node_id: 'B1-11', name: null, repo: null });
    expect(d.parent_link_source).toBe('heuristic');
    expect(d.live).toBe(true);
    expect(d.repo).toBeNull();
  });

  it('reads each note kind: linked stays linked, a missing or unknown kind is made', () => {
    const d = normalizeSessionDetail({
      session: { session_id: 'cc64', node_id: '5U-I7', host: 'lenovo' },
      notes: [
        { id: '5-BW7', excerpt: 'linked in later', kind: 'linked' },
        { id: 'K-F07', excerpt: 'saved here', kind: 'made' },
        { id: 'Z-Z01', excerpt: 'old daemon' },
        { id: 'Q-R88', excerpt: 'future kind', kind: 'pinned' },
      ],
    });
    expect(d.notes.map((n) => [n.id, n.kind])).toEqual([
      ['5-BW7', 'linked'],
      ['K-F07', 'made'],
      ['Z-Z01', 'made'],
      ['Q-R88', 'made'],
    ]);
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
    expect(d.parent).toEqual({ node_id: 'B1-11', name: 'trunk', repo: null });
    expect(d.parent_link_source).toBeNull();
    expect(d.available).toBe(false);
    expect(d.cost_usd).toBeNull();
    expect(d.prompts).toEqual([]);
    expect(d.notes).toEqual([]);
  });

  it('reads a fork: source, fork point, and the fork parent when no parent object came', () => {
    const fork = { parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 };
    const d = normalizeSessionDetail({ session: { node_id: 'JM-UJ', parent_link_source: 'fork', fork, live: true, job_id: 'e3650501' } });
    expect(d.parent_link_source).toBe('fork');
    expect(d.fork).toEqual(fork);
    expect(d.parent).toEqual({ node_id: 'DM-OV', name: null, repo: null });
    expect(d.job_id).toBe('e3650501');
    expect(normalizeSessionDetail({ session: { node_id: 'JM-UJ', live: false, job_id: 'e3650501' } }).job_id).toBeNull();
    expect(normalizeSessionDetail({ session: { node_id: 'A0-3G', parent_link_source: 'nope' } })).toMatchObject({ parent_link_source: null, fork: null, job_id: null });
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

  it('carries the background job and whether the prompt was delivered', async () => {
    stub(200, { action: 'attached', window: 'note:6', job_id: 'e3650501', prompt_delivered: false });
    expect(await resumeSession('JM-UJ', { prompt: 'go on' })).toEqual({ action: 'attached', window: 'note:6', job_id: 'e3650501', prompt_delivered: false });
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

  it('names the background job instead of an error code', () => {
    expect(resumeNotice({ action: 'attached', window: 'note:6', job_id: 'e3650501' }, false)).toBe('Opened claude attach e3650501 in note:6');
    expect(resumeNotice({ action: 'attached', window: 'note:6', job_id: 'e3650501', prompt_delivered: false }, false)).toBe(
      'Opened claude attach e3650501 in note:6; prompt not sent, type it there',
    );
    expect(resumeNotice({ action: 'attached', window: null }, false)).toBe('Attached to the background session');
    expect(resumeNotice({ action: 'focused', window: 'note:6', job_id: 'e3650501' }, false)).toBe('Background job, focused claude attach e3650501 in note:6');
    expect(resumeNotice({ action: 'messaged', window: null, job_id: 'e3650501' }, false)).toBe('Background job, prompt sent to claude attach e3650501');
    const bg = { node_id: 'JM-UJ', host: 'lenovo', job_id: 'e3650501' };
    expect(resumeErrorNotice(new ApiError(409, 'live_outside_tmux'), bg)).toBe('JM-UJ is background job e3650501: run claude attach e3650501');
    expect(resumeErrorNotice(new ApiError(409, 'live_outside_tmux'), { ...bg, job_id: null })).toBe('Could not resume JM-UJ: live_outside_tmux');
  });
});

describe('summary state', () => {
  it('reads summary_state and summary_requested_at from the session object', () => {
    const d = normalizeSessionDetail({
      session: { node_id: 'A0-3G', host: 'GPD', summary: null, summary_state: 'requested', summary_requested_at: '2026-11-03T08:00:00.000Z' },
    });
    expect(d.summary_state).toBe('requested');
    expect(d.summary_requested_at).toBe('2026-11-03T08:00:00.000Z');
  });

  it('is ready whenever there is a summary, and never ready without one', () => {
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary: 'Did it.', summary_state: 'idle_wait' }).summary_state).toBe('ready');
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary: 'Did it.' }).summary_state).toBe('ready');
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary: null, summary_state: 'ready' }).summary_state).toBeNull();
  });

  it('is null for a missing or unknown state (older daemon)', () => {
    const old = normalizeSessionDetail({ node_id: 'A0-3G' });
    expect(old.summary_state).toBeNull();
    expect(old.summary_requested_at).toBeNull();
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary_state: 'queued' }).summary_state).toBeNull();
    for (const s of ['empty', 'requested', 'idle_wait', 'other_host'] as const) {
      expect(normalizeSessionDetail({ node_id: 'A0-3G', summary_state: s }).summary_state).toBe(s);
    }
  });
});

describe('requestSummary', () => {
  it('POSTs to the node and returns the recorded state', async () => {
    const seen = stub(200, { node_id: 'A0-3G', summary_state: 'requested', summary_requested_at: '2026-11-03T08:00:00.000Z' });
    expect(await requestSummary('A0-3G')).toEqual({ summary_state: 'requested', summary_requested_at: '2026-11-03T08:00:00.000Z' });
    expect(seen).toEqual([{ url: '/api/sessions/A0-3G/summarize', method: 'POST', body: null }]);
  });

  it('reads an unknown state in a 200 as requested', async () => {
    stub(200, { node_id: 'A0-3G' });
    expect(await requestSummary('A0-3G')).toEqual({ summary_state: 'requested', summary_requested_at: null });
  });

  it('throws the error code as an ApiError', async () => {
    stub(409, { error: 'empty_session' });
    const err = await requestSummary('A0-3G').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'empty_session' });
  });
});

describe('summarizeErrorNotice', () => {
  it('explains failures', () => {
    const d = { node_id: 'A0-3G' };
    expect(summarizeErrorNotice(new ApiError(409, 'empty_session'), d)).toBe('A0-3G is an empty session, nothing to summarize');
    expect(summarizeErrorNotice(new ApiError(403, 'forbidden'), d)).toBe('Summarize only works from the wall on this machine');
    expect(summarizeErrorNotice(new ApiError(404, 'not_found'), d)).toBe('No session A0-3G');
    expect(summarizeErrorNotice(new ApiError(500, 'boom'), d)).toBe('Could not request a summary of A0-3G: boom');
    expect(summarizeErrorNotice(new Error('x'), d)).toBe('Could not request a summary of A0-3G');
  });
});

describe('fetchSessionPrompts', () => {
  it('GETs /api/sessions/:id/prompts and keeps each text exactly as sent', async () => {
    const seen = stub(200, {
      node_id: 'A0-3G',
      host: 'GPD',
      available: false,
      complete: false,
      prompts: [
        { n: 1, text: '  a\n\tb  ', at: '2026-11-01T01:00:00.000Z', truncated: false },
        { n: 2, text: 'cut', at: null, truncated: true },
        { n: 3, text: 42 },
      ],
    });
    const p = await fetchSessionPrompts('A0-3G');
    expect(seen[0]).toEqual({ url: '/api/sessions/A0-3G/prompts', method: 'GET', body: null });
    expect(p).toEqual({
      node_id: 'A0-3G',
      host: 'GPD',
      available: false,
      complete: false,
      incomplete_reason: 'not_backfilled',
      prompts: [
        { n: 1, text: '  a\n\tb  ', at: '2026-11-01T01:00:00.000Z', truncated: false, images: [] },
        { n: 2, text: 'cut', at: null, truncated: true, images: [] },
      ],
    });
  });

  it('normalizes pasted images, defaulting urls and an unset available to true', async () => {
    stub(200, {
      node_id: 'A0-3G',
      host: 'pc',
      complete: true,
      prompts: [
        {
          n: 1,
          text: 'see this',
          at: null,
          truncated: false,
          images: [
            { id: 'A-IMG1', width: 12, height: 8, available: false, urls: { thumb: '/api/chat/images/A-IMG1/thumb', display: '/api/chat/images/A-IMG1/display' } },
            { id: 'A-IMG2', width: '20', height: 10 },
            'bogus',
          ],
        },
      ],
    });
    const p = await fetchSessionPrompts('A0-3G');
    expect(p?.prompts[0]?.images).toEqual([
      { id: 'A-IMG1', width: 12, height: 8, available: false, urls: { thumb: '/api/chat/images/A-IMG1/thumb', display: '/api/chat/images/A-IMG1/display' } },
      { id: 'A-IMG2', width: 20, height: 10, available: true, urls: { thumb: '/api/chat/images/A-IMG2/thumb', display: '/api/chat/images/A-IMG2/display' } },
    ]);
  });

  it('keeps transcript_pruned, and has no reason when complete', async () => {
    stub(200, { node_id: 'A0-3G', host: 'pc', complete: false, incomplete_reason: 'transcript_pruned', prompts: [] });
    expect((await fetchSessionPrompts('A0-3G'))?.incomplete_reason).toBe('transcript_pruned');
    stub(200, { node_id: 'A0-3G', host: 'pc', complete: true, incomplete_reason: 'transcript_pruned', prompts: [] });
    expect((await fetchSessionPrompts('A0-3G'))?.incomplete_reason).toBeNull();
  });

  it('null on 404, ApiError with the server error otherwise', async () => {
    stub(404, { error: 'not_found' });
    expect(await fetchSessionPrompts('ZZ-ZZ')).toBeNull();
    stub(500, { error: 'boom' });
    await expect(fetchSessionPrompts('A0-3G')).rejects.toMatchObject({ status: 500, message: 'boom' });
  });
});

describe('context wire', () => {
  const CTX = { tokens: 390_000, window: 1_000_000, percent: 39, band: 'green', model: 'claude-opus-5-5', at: '2026-11-12T02:00:00.000Z', window_source: 'peak', peak_tokens: 410_000 };

  it('carries the detail context and null without one', () => {
    expect(normalizeSessionDetail({ session: { node_id: 'A0-3G', context: CTX } }).context).toEqual(CTX);
    expect(normalizeSessionDetail({ session: { node_id: 'A0-3G', context: null } }).context).toBeNull();
    expect(normalizeSessionDetail({ node_id: 'A0-3G' }).context).toBeNull();
  });

  it('drops a context it cannot draw', () => {
    expect(normalizeSessionContext({ ...CTX, band: 'purple' })).toBeNull();
    expect(normalizeSessionContext({ ...CTX, window: 0 })).toBeNull();
    expect(normalizeSessionContext({ ...CTX, tokens: 'x' })).toBeNull();
    expect(normalizeSessionContext({ ...CTX, window_source: 'guess' })?.window_source).toBe('default');
  });

  it('parses a stream event and rejects anything else', () => {
    expect(parseContextEvent(JSON.stringify({ node_id: 'A0-3G', host: 'lenovo', available: true, context: CTX }))).toEqual({
      node_id: 'A0-3G',
      host: 'lenovo',
      available: true,
      context: CTX,
    });
    expect(parseContextEvent('not json')).toBeNull();
    expect(parseContextEvent(JSON.stringify({ context: CTX }))).toBeNull();
    expect(parseContextEvent(undefined)).toBeNull();
  });

  it('reads a handoff estimate and rejects an incomplete one', () => {
    const est = { node_id: 'A0-3G', tokens: 120_000, window: 1_000_000, percent: 12, baseline: 48_000, exchanges_included: 3, exchanges_total: 9, truncated: true };
    expect(normalizeHandoffEstimate(est)).toEqual(est);
    expect(normalizeHandoffEstimate({ ...est, exchanges_total: undefined })).toBeNull();
  });
});
