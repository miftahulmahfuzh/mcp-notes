import { describe, expect, it } from 'vitest';
import {
  CONTEXT_NODE_MAX_CHARS,
  excerpt,
  formatContext,
  formatLocalTime,
  iso,
  nodeUrl,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  sessionTitle,
  toGraphNode,
  toSessionInfo,
  type DetailRow,
  type LiveEntry,
  type NodeRow,
} from '../../src/sessions/view.js';

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
    final_message: null,
    prompts: [],
    commits: [],
    files_edited: [],
    plan_docs: [],
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
    const live = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'busy', tmux: 'note:@0.%7' }]]);
    const here = toGraphNode(row(), { host: 'lenovo', live });
    expect(here).toMatchObject({ live: true, status: 'busy', tmux: 'note:@0.%7', available: true });
    const there = toGraphNode(row({ host: 'gpd' }), { host: 'lenovo', live });
    expect(there).toMatchObject({ live: false, status: null, available: false });
  });

  it('keeps only known link sources', () => {
    expect(toGraphNode(row({ parent_link_source: 'env' }), { host: 'x', live: noLive }).parent_link_source).toBe('env');
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
