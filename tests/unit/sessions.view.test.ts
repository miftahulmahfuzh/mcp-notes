import { describe, expect, it } from 'vitest';
import {
  CONTEXT_NODE_MAX_CHARS,
  excerpt,
  forkPointText,
  formatContext,
  formatLocalTime,
  iso,
  nodeUrl,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  resumeCommand,
  sessionTitle,
  summaryState,
  toGraphNode,
  toNodeRef,
  toNoteRef,
  toSessionInfo,
  toSessionContext,
  type DetailRow,
  type LiveEntry,
  type NodeRow,
} from '../../src/sessions/view.js';
import { contextBand } from '../../src/sessions/contextWindow.js';

function row(over: Partial<NodeRow> = {}): NodeRow {
  return {
    session_id: 'sess-1',
    node_id: 'A0-3G',
    host: 'lenovo',
    repo: 'mcp-notes',
    cwd: '/home/m/mcp-notes',
    branch: 'main',
    name: null,
    custom_title: null,
    ai_title: null,
    first_prompt: 'plan the session graph',
    started_at: new Date('2026-11-01T03:00:00Z'),
    last_active_at: '2026-11-01T05:30:00Z',
    input_tokens: '100',
    output_tokens: 200,
    cache_read_tokens: 1000,
    cache_write_tokens: null,
    cost_usd: '1.25',
    parent_session_id: null,
    parent_link_source: null,
    tmux: null,
    forked_at: null,
    fork_prompt_count: null,
    summary_head: null,
    parent_node_id: null,
    child_count: '2',
    ...over,
  };
}

function detail(over: Partial<DetailRow> = {}): DetailRow {
  return {
    ...row(),
    entrypoint: 'cli',
    version: '2.1.0',
    models: null,
    transcript_path: '/home/m/.claude/projects/x/sess-1.jsonl',
    first_prompt_full: 'plan the session graph',
    last_prompt: null,
    summary: null,
    summarized_at: null,
    summary_requested_at: null,
    final_message: null,
    prompts: [],
    commits: [],
    files_edited: [],
    plan_docs: [],
    context_tokens: null,
    context_model: null,
    context_at: null,
    context_peak_tokens: null,
    context_long_beta: false,
    ...over,
  };
}

const noLive = new Map<string, LiveEntry>();

describe('toGraphNode', () => {
  it('maps a local row: tokens summed from strings and nulls, cost parsed, unfinished null', () => {
    const n = toGraphNode(row(), { host: 'lenovo', live: noLive });
    expect(n.tokens).toEqual({ input: 100, output: 200, cache_read: 1000, cache_write: 0, total: 1300 });
    expect(n.cost_usd).toBe(1.25);
    expect(n.available).toBe(true);
    expect(n.live).toBe(false);
    expect(n.child_count).toBe(2);
    expect(n.unfinished).toBeNull();
    expect(n.started_at).toBe('2026-11-01T03:00:00.000Z');
    expect(n.last_active_at).toBe('2026-11-01T05:30:00.000Z');
    expect(n.title).toBe('plan the session graph');
  });

  it('marks live only for this host, and takes status and tmux from the registry', () => {
    const live = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'busy', tmux: 'note:@0.%7', jobId: null }]]);
    const here = toGraphNode(row(), { host: 'lenovo', live });
    expect(here).toMatchObject({ live: true, status: 'busy', tmux: 'note:@0.%7', available: true });
    const there = toGraphNode(row({ host: 'gpd' }), { host: 'lenovo', live });
    expect(there).toMatchObject({ live: false, status: null, available: false });
  });

  it('keeps only known link sources', () => {
    expect(toGraphNode(row({ parent_link_source: 'env' }), { host: 'x', live: noLive }).parent_link_source).toBe('env');
    expect(toGraphNode(row({ parent_link_source: 'fork' }), { host: 'x', live: noLive }).parent_link_source).toBe('fork');
    expect(toGraphNode(row({ parent_link_source: 'bogus' }), { host: 'x', live: noLive }).parent_link_source).toBeNull();
  });
});

describe('sessionTitle', () => {
  it('prefers custom title, then name, then ai title, then the first prompt, then the node id', () => {
    const base = { node_id: 'A0-3G', custom_title: null, name: null, ai_title: null, first_prompt: null };
    expect(sessionTitle({ ...base, custom_title: 'mine', name: 'impl-x-p1', ai_title: 'ai' })).toBe('mine');
    expect(sessionTitle({ ...base, name: 'impl-x-p1', ai_title: 'ai' })).toBe('impl-x-p1');
    expect(sessionTitle({ ...base, ai_title: 'ai' })).toBe('ai');
    expect(sessionTitle({ ...base, first_prompt: 'x'.repeat(200) })).toHaveLength(80);
    expect(sessionTitle(base)).toBe('A0-3G');
  });
});

describe('normalizers', () => {
  it('prompts: strings and objects, blanks dropped, timestamps normalised', () => {
    expect(normalizePrompts(['a', { text: 'b', timestamp: '2026-11-01T00:00:00Z' }, { prompt: '  ' }, 5, null])).toEqual([
      { text: 'a', at: null },
      { text: 'b', at: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(normalizePrompts('nope')).toEqual([]);
  });

  it('commits: "sha subject" strings and objects', () => {
    expect(normalizeCommits(['abc1234 feat: x', { hash: 'def5678', message: 'fix: y\n\nbody' }, 'not a sha'])).toEqual([
      { sha: 'abc1234', subject: 'feat: x' },
      { sha: 'def5678', subject: 'fix: y' },
      { sha: null, subject: 'not a sha' },
    ]);
  });

  it('paths: strings and {path}, deduped in order', () => {
    expect(normalizePaths(['a.md', { path: 'b.md' }, 'a.md', { file: 'c.md' }, 3])).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

describe('helpers', () => {
  it('excerpt collapses whitespace and cuts with an ellipsis', () => {
    expect(excerpt('  a \n b  ', 10)).toBe('a b');
    expect(excerpt('abcdef', 4)).toBe('abc…');
    expect(excerpt('   ', 4)).toBeNull();
  });

  it('iso accepts dates and strings, rejects junk', () => {
    expect(iso(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(iso('nope')).toBeNull();
    expect(iso(null)).toBeNull();
  });

  it('nodeUrl encodes the repo and needs one', () => {
    expect(nodeUrl('http://localhost:7317/', 'my repo', 'A0-3G')).toBe('http://localhost:7317/projects?repo=my%20repo&node=A0-3G');
    expect(nodeUrl('http://localhost:7317', null, 'A0-3G')).toBeNull();
  });

  it('formatLocalTime renders in the given zone', () => {
    expect(formatLocalTime('2026-10-31T18:00:00Z', 'Asia/Jakarta')).toBe('2026-11-01 01:00');
  });
});

describe('formatContext', () => {
  const opts = { timeZone: 'Asia/Jakarta', wallUrl: 'http://localhost:7317' };

  it('names the node, parent, children, summary, plan docs, commits, transcript and wall link', () => {
    const session = toSessionInfo(
      detail({ summary: 'Built the graph.', parent_node_id: 'B1-22', parent_link_source: 'env' }),
      { host: 'lenovo', live: noLive },
    );
    const text = formatContext(
      {
        session,
        commits: [{ sha: 'abc1234def', subject: 'feat: graph' }],
        plan_docs: ['docs/plans/X.md'],
        children_node_ids: ['C2-33'],
      },
      opts,
    );
    expect(text).toContain('Session A0-3G "plan the session graph" (repo mcp-notes, branch main, host lenovo; 2026-11-01 10:00 to 2026-11-01 12:30 Asia/Jakarta)');
    expect(text).toContain('Parent: B1-22 (env link)');
    expect(text).toContain('Children: C2-33');
    expect(text).toContain('Summary: Built the graph.');
    expect(text).toContain('Plan docs: docs/plans/X.md');
    expect(text).toContain('Commits: abc1234 feat: graph');
    expect(text).toContain('Transcript: /home/m/.claude/projects/x/sess-1.jsonl (resume with: claude --resume sess-1)');
    expect(text).toContain('Wall: http://localhost:7317/projects?repo=mcp-notes&node=A0-3G');
  });

  it('says where the transcript is for another host, and falls back to the first prompt without a summary', () => {
    const session = toSessionInfo(detail({ host: 'gpd' }), { host: 'lenovo', live: noLive });
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text).toContain('Transcript: on gpd, not readable from this machine.');
    expect(text).toContain('Summary: not summarized yet. First prompt: plan the session graph');
    expect(text).not.toContain('Commits:');
  });

  it('is bounded', () => {
    const session = toSessionInfo(detail({ summary: 'x'.repeat(10_000) }), { host: 'lenovo', live: noLive });
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text.length).toBeLessThanOrEqual(CONTEXT_NODE_MAX_CHARS);
  });
});

describe('toNoteRef', () => {
  it('maps a session-detail note row to the wire NoteRef with its kind', () => {
    expect(
      toNoteRef({ id: 'A-B32', body: '  hello \n  world #x ', tags: ['x'], created_at: new Date('2026-11-03T00:00:00Z'), kind: 'made' }),
    ).toEqual({ id: 'A-B32', excerpt: 'hello world #x', tags: ['x'], created_at: '2026-11-03T00:00:00.000Z', kind: 'made' });
    expect(toNoteRef({ id: 'A-B33', body: '', tags: null, created_at: null, kind: 'linked' })).toEqual({
      id: 'A-B33',
      excerpt: '',
      tags: [],
      created_at: null,
      kind: 'linked',
    });
  });
});

describe('summaryState', () => {
  const base = { has_summary: false, total_tokens: 10, summary_requested_at: null, host: 'lenovo' };

  it('ready > empty > requested > other_host > idle_wait', () => {
    expect(summaryState({ ...base, has_summary: true, total_tokens: 0 }, 'lenovo')).toBe('ready');
    expect(summaryState({ ...base, total_tokens: 0, summary_requested_at: '2026-11-03T08:00:00.000Z' }, 'lenovo')).toBe('empty');
    expect(summaryState({ ...base, summary_requested_at: '2026-11-03T08:00:00.000Z', host: 'gpd' }, 'lenovo')).toBe('requested');
    expect(summaryState({ ...base, host: 'gpd' }, 'lenovo')).toBe('other_host');
    expect(summaryState(base, 'lenovo')).toBe('idle_wait');
  });

  it('toSessionInfo carries summary_requested_at as ISO and the state', () => {
    const live = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'busy', tmux: null, jobId: null }]]);
    expect(toSessionInfo(detail(), { host: 'lenovo', live })).toMatchObject({ summary_requested_at: null, summary_state: 'idle_wait' });
    expect(toSessionInfo(detail({ summary: '   ' }), { host: 'lenovo', live: noLive }).summary_state).toBe('idle_wait');
    expect(toSessionInfo(detail({ summary: 'Built it.' }), { host: 'lenovo', live: noLive }).summary_state).toBe('ready');
    expect(
      toSessionInfo(detail({ summary_requested_at: new Date('2026-11-03T08:00:00Z') }), { host: 'lenovo', live: noLive }),
    ).toMatchObject({ summary_requested_at: '2026-11-03T08:00:00.000Z', summary_state: 'requested' });
    expect(toSessionInfo(detail({ host: 'gpd' }), { host: 'lenovo', live: noLive }).summary_state).toBe('other_host');
    expect(
      toSessionInfo(detail({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }), { host: 'lenovo', live: noLive })
        .summary_state,
    ).toBe('empty');
  });
});

describe('forks and background jobs', () => {
  const opts = { timeZone: 'Asia/Jakarta', wallUrl: 'http://localhost:7317' };
  const ctx = { host: 'lenovo', live: noLive };
  // JM-UJ-shaped: forked from DM-OV after its 12th prompt, at the job's forkBoundaryAt.
  const forkCols = {
    parent_session_id: 'sess-0',
    parent_node_id: 'DM-OV',
    parent_link_source: 'fork',
    forked_at: '2026-11-11T01:37:02.342Z',
    fork_prompt_count: '12',
  };
  const bgLive = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'idle', tmux: null, jobId: 'e3650501' }]]);

  it('a fork node carries its fork point on the node and its ref; any other link carries none', () => {
    const n = toGraphNode(row(forkCols), ctx);
    expect(n.parent_link_source).toBe('fork');
    expect(n.fork).toEqual({ parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 });
    expect(toNodeRef(n).fork).toEqual(n.fork);
    expect(toGraphNode(row({ ...forkCols, parent_link_source: 'env' }), ctx).fork).toBeNull();
    expect(toGraphNode(row({ ...forkCols, parent_node_id: null }), ctx).fork).toBeNull();
    expect(toGraphNode(row(), ctx).fork).toBeNull();
  });

  it('job_id comes from a live background entry on this host only', () => {
    expect(toGraphNode(row(), { host: 'lenovo', live: bgLive })).toMatchObject({ live: true, job_id: 'e3650501' });
    expect(toNodeRef(toGraphNode(row(), { host: 'lenovo', live: bgLive })).job_id).toBe('e3650501');
    expect(toGraphNode(row({ host: 'gpd' }), { host: 'lenovo', live: bgLive }).job_id).toBeNull();
    expect(toGraphNode(row(), ctx).job_id).toBeNull();
  });

  it('forkPointText names the parent, the prompts copied and the local fork time', () => {
    expect(forkPointText({ parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 }, 'Asia/Jakarta')).toBe(
      'DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)',
    );
    expect(forkPointText({ parent_node_id: 'DM-OV', forked_at: null, prompt_count: 0 }, 'Asia/Jakarta')).toBe('DM-OV (before its first prompt)');
    expect(forkPointText({ parent_node_id: 'DM-OV', forked_at: null, prompt_count: null }, 'Asia/Jakarta')).toBe('DM-OV');
  });

  it('the hook context says "Fork of <parent>" with the fork point instead of a Parent line', () => {
    const session = toSessionInfo(detail(forkCols), ctx);
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text).toContain('Fork of DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)');
    expect(text).not.toContain('Parent:');
    expect(text).toContain('Transcript: /home/m/.claude/projects/x/sess-1.jsonl (resume with: claude --resume sess-1)');
  });

  it('a live background job is attached, never resumed', () => {
    const session = toSessionInfo(detail(), { host: 'lenovo', live: bgLive });
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text).toContain('Transcript: /home/m/.claude/projects/x/sess-1.jsonl (attach with: claude attach e3650501)');
    expect(text).not.toContain('claude --resume');
    expect(resumeCommand(session)).toBe('claude attach e3650501');
  });

  it('resumeCommand is claude --resume for an ordinary local session and null on another host', () => {
    expect(resumeCommand(toSessionInfo(detail(), ctx))).toBe('claude --resume sess-1');
    expect(resumeCommand(toSessionInfo(detail({ host: 'gpd' }), ctx))).toBeNull();
  });
});

describe('toSessionContext', () => {
  const none = { context_tokens: null, context_model: null, context_at: null, context_peak_tokens: null, context_long_beta: false };

  it('is null while no context was captured: unknown, not 0%', () => {
    expect(toSessionContext(none)).toBeNull();
    expect(toSessionInfo(detail(), { host: 'lenovo', live: noLive }).context).toBeNull();
  });

  it('an unknown model with no 1M evidence gets the 200k default window', () => {
    expect(
      toSessionContext({ ...none, context_tokens: '50000', context_model: 'glm-5.3', context_at: '2026-11-12T02:00:00Z', context_peak_tokens: '50000' }),
    ).toEqual({
      tokens: 50_000,
      window: 200_000,
      percent: 25,
      band: contextBand(25),
      model: 'glm-5.3',
      at: '2026-11-12T02:00:00.000Z',
      window_source: 'default',
      peak_tokens: 50_000,
    });
  });

  it('a peak above 200k infers a 1M window, after compaction too', () => {
    const c = toSessionContext({ ...none, context_tokens: 150_000, context_model: 'glm-5.3', context_peak_tokens: 250_000 });
    expect(c).toMatchObject({ tokens: 150_000, window: 1_000_000, percent: 15, window_source: 'peak', peak_tokens: 250_000 });
  });

  it('rounds the percent to one decimal (contextPercent) and bands on that shown percent', () => {
    const c = toSessionContext({ ...none, context_tokens: 79_990, context_model: 'glm-5.3', context_peak_tokens: 79_990 });
    expect(c?.percent).toBe(40);
    expect(c?.band).toBe('amber');
  });

  it('a missing peak falls back to the tokens', () => {
    expect(toSessionContext({ ...none, context_tokens: 10, context_model: 'glm-5.3' })?.peak_tokens).toBe(10);
  });

  it('toSessionInfo carries it', () => {
    const s = toSessionInfo(detail({ context_tokens: 50_000, context_model: 'glm-5.3', context_peak_tokens: 50_000 }), { host: 'lenovo', live: noLive });
    expect(s.context).toMatchObject({ tokens: 50_000, window: 200_000, percent: 25 });
  });
});
