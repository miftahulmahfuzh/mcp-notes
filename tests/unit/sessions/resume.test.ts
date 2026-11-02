import { describe, expect, it } from 'vitest';
import {
  claudeCommand,
  clipUtf8,
  createSessionResumer,
  freshPrompt,
  isUnder,
  NEW_WINDOW_FORMAT,
  parseLatest,
  parseNewWindow,
  parseRegistryTmux,
  promptArgs,
  RECENT_SPAWN_MS,
  resolveCwd,
  resumeNode,
  SCRUBBED_ENV,
  toResumeNode,
  windowName,
  type CommandRunner,
  type LiveEntry,
  type ResumeDeps,
  type ResumeNode,
} from '../../../src/sessions/resume.js';

const SID = '6f1c2d3e-0000-4000-8000-00000000abcd';
const CLAUDE = '/opt/claude/claude.exe';

type Handler = (args: string[]) => string;

/** A tmux that answers per subcommand; records every call (with any -S stripped in `sub`). */
function fakeTmux(over: Partial<Record<string, Handler>> = {}) {
  const calls: string[][] = [];
  const handlers: Record<string, Handler> = {
    'list-sessions': () => '100 work\n200 note\n 0 never\n',
    'list-clients': () => '50 /dev/pts/1\n90 /dev/pts/2\n',
    'list-panes': () => '%1\n%7\n',
    'display-message': (a) => (a.includes('#{pane_in_mode}') ? '0\n' : 'note:1\n'),
    'new-window': () => 'note:3 %12\n',
    ...over,
  } as Record<string, Handler>;
  const run: CommandRunner = async (cmd, args) => {
    expect(cmd).toBe('tmux');
    calls.push([...args]);
    const a = args[0] === '-S' ? args.slice(2) : [...args];
    const h = handlers[a[0]!];
    return h === undefined ? '' : h(a);
  };
  const sub = (name: string): string[][] =>
    calls.map((c) => (c[0] === '-S' ? c.slice(2) : c)).filter((c) => c[0] === name);
  return { run, calls, sub };
}

function makeDeps(
  run: CommandRunner,
  over: Partial<ResumeDeps> & { dirs?: string[]; liveEntry?: LiveEntry | null; clock?: { t: number } } = {},
): ResumeDeps {
  const dirs = new Set(over.dirs ?? ['/home/u/mcp-notes', '/home/u']);
  const clock = over.clock ?? { t: 1_000_000 };
  return {
    host: 'lenovo',
    run,
    tmuxBin: 'tmux',
    tmuxSocket: null,
    claudeBin: CLAUDE,
    homeDir: '/home/u',
    worktreesDir: '/home/u/.worktrees',
    live: async () => over.liveEntry ?? null,
    isDir: async (p) => dirs.has(p),
    repoCwds: async () => [],
    now: () => clock.t,
    ...over,
  };
}

function node(over: Partial<ResumeNode> = {}): ResumeNode {
  return {
    sessionId: SID,
    nodeId: 'A0-3G',
    host: 'lenovo',
    repo: 'mcp-notes',
    cwd: '/home/u/mcp-notes',
    name: 'impl-x-p1',
    title: 'wall editing',
    summary: 'Built the photo delete flow.',
    firstPrompt: 'make photos deletable',
    transcriptPath: `/home/u/.claude/projects/-home-u-mcp-notes/${SID}.jsonl`,
    commits: ['abc123def456 feat: delete photos'],
    planDocs: ['docs/plans/WALL_PLAN.md'],
    ...over,
  };
}

function newWindowArgv(cwd: string, name: string, argv: string[]): string[] {
  return ['new-window', '-t', '=note:', '-c', cwd, '-n', name, '-P', '-F', NEW_WINDOW_FORMAT, ...argv];
}

describe('parsers', () => {
  it('parseLatest picks the largest number, treats an empty number as 0, keeps spaces in names', () => {
    expect(parseLatest('100 work\n200 note\n 0 never\n')).toBe('note');
    expect(parseLatest(' a\n b\n')).toBe('a');
    expect(parseLatest('5 my session\n')).toBe('my session');
    expect(parseLatest('')).toBeNull();
  });

  it('parseRegistryTmux keeps the pane id and tolerates colons in the session name', () => {
    expect(parseRegistryTmux('note:@0.%7')).toEqual({ session: 'note', windowId: '@0', paneId: '%7' });
    expect(parseRegistryTmux('a:b:@12.%255')).toEqual({ session: 'a:b', windowId: '@12', paneId: '%255' });
    expect(parseRegistryTmux('%7')).toBeNull();
  });

  it('parseNewWindow splits the window label from the pane id', () => {
    expect(parseNewWindow('note:3 %12\n')).toEqual({ window: 'note:3', paneId: '%12' });
    expect(parseNewWindow('my session:3 %12')).toEqual({ window: 'my session:3', paneId: '%12' });
    expect(parseNewWindow('')).toEqual({ window: '', paneId: null });
  });

  it('clipUtf8 cuts on code points within the byte budget', () => {
    expect(clipUtf8('short', 100)).toBe('short');
    const cut = clipUtf8('é'.repeat(100), 21);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(21);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('isUnder, promptArgs, windowName', () => {
    expect(isUnder('/home/u/.worktrees/mcp-notes/x', '/home/u/.worktrees')).toBe(true);
    expect(isUnder('/home/u/mcp-notes', '/home/u/.worktrees')).toBe(false);
    expect(promptArgs(undefined)).toEqual([]);
    expect(promptArgs('go on')).toEqual(['go on']);
    expect(promptArgs('-x please')).toEqual(['--', '-x please']);
    expect(windowName({ name: 'impl x:p1', nodeId: 'A0-3G' }, false)).toBe('impl-x-p1');
    expect(windowName({ name: null, nodeId: 'A0-3G' }, false)).toBe('A0-3G');
    expect(windowName({ name: 'impl', nodeId: 'A0-3G' }, true)).toBe('A0-3G-new');
  });

  it('claudeCommand scrubs the inherited Claude Code markers (M5) and sets extra env', () => {
    expect(SCRUBBED_ENV).toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(claudeCommand(CLAUDE, ['--resume', SID], { CC_PARENT_SESSION: 'p' })).toEqual([
      'env',
      ...SCRUBBED_ENV.flatMap((n) => ['-u', n]),
      'CC_PARENT_SESSION=p',
      CLAUDE,
      '--resume',
      SID,
    ]);
  });

  it('toResumeNode maps commits {sha, subject} and plan docs, title falls back to the AI title', () => {
    const n = toResumeNode({
      sessionId: SID,
      nodeId: 'A0-3G',
      host: 'lenovo',
      repo: 'mcp-notes',
      cwd: '/x',
      name: null,
      customTitle: null,
      aiTitle: 'AI title',
      summary: null,
      firstPrompt: 'hi',
      transcriptPath: null,
      commits: [{ sha: 'abc123def4567890', subject: 'feat: y', at: null }, 'raw line', 42],
      planDocs: ['docs/plans/A.md', ''],
    });
    expect(n.title).toBe('AI title');
    expect(n.commits).toEqual(['abc123def456 feat: y', 'raw line']);
    expect(n.planDocs).toEqual(['docs/plans/A.md']);
  });

  it('freshPrompt carries node id, transcript, summary, commits, plan docs and the task, within the byte budget', () => {
    const p = freshPrompt(node(), 'add tests');
    expect(p).toContain('A0-3G');
    expect(p).toContain(`${SID}.jsonl`);
    expect(p).toContain('Built the photo delete flow.');
    expect(p).toContain('- abc123def456 feat: delete photos');
    expect(p).toContain('- docs/plans/WALL_PLAN.md');
    expect(p.endsWith('Task: add tests')).toBe(true);
    const huge = freshPrompt(node({ summary: 'x'.repeat(50_000) }), 'keep me');
    expect(Buffer.byteLength(huge, 'utf8')).toBeLessThanOrEqual(12_000);
    expect(huge.endsWith('Task: keep me')).toBe(true);
  });
});

describe('resumeNode', () => {
  it('a node from another host is not_on_this_machine and touches no tmux', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run), node({ host: 'GPD' }), {});
    expect(out).toEqual({ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } });
    expect(t.calls).toEqual([]);
  });

  it('not live: claude --resume in a new window of the most recently attached session', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run), node(), {});
    expect(out).toEqual({ status: 200, body: { action: 'resumed', window: 'note:3', cwd: '/home/u/mcp-notes' } });
    expect(t.sub('new-window')).toEqual([
      newWindowArgv('/home/u/mcp-notes', 'impl-x-p1', claudeCommand(CLAUDE, ['--resume', SID])),
    ]);
    expect(t.sub('switch-client')).toEqual([['switch-client', '-c', '/dev/pts/2', '-t', '%12']]);
  });

  it('not live with a prompt: the prompt follows --resume <sid>, behind -- when it starts with a dash', async () => {
    const t = fakeTmux();
    await resumeNode(makeDeps(t.run), node(), { prompt: '  continue  ' });
    await resumeNode(makeDeps(t.run), node({ sessionId: 'other' }), { prompt: '-rf? no, continue' });
    const [first, second] = t.sub('new-window');
    expect(first!.slice(-3)).toEqual(['--resume', SID, 'continue']);
    expect(second!.slice(-4)).toEqual(['--resume', 'other', '--', '-rf? no, continue']);
  });

  it('live in a reachable pane: focuses it, never opens a window', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'stale-name:@0.%7' } }), node(), {});
    expect(out).toEqual({ status: 200, body: { action: 'focused', window: 'note:1' } });
    expect(t.sub('select-window')).toEqual([['select-window', '-t', '%7']]);
    expect(t.sub('select-pane')).toEqual([['select-pane', '-t', '%7']]);
    expect(t.sub('switch-client')).toEqual([['switch-client', '-c', '/dev/pts/2', '-t', '%7']]);
    expect(t.sub('new-window')).toEqual([]);
  });

  it('live with a prompt: pastes it as one bracketed paste and presses Enter', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'note:@0.%7' } }), node(), {
      prompt: 'line one\nline two',
    });
    expect(out).toEqual({ status: 200, body: { action: 'messaged', window: 'note:1' } });
    const [set] = t.sub('set-buffer');
    expect(set!.slice(0, 2)).toEqual(['set-buffer', '-b']);
    expect(set!.slice(3)).toEqual(['--', 'line one\nline two']);
    const buffer = set![2]!;
    expect(t.sub('paste-buffer')).toEqual([['paste-buffer', '-p', '-d', '-b', buffer, '-t', '%7']]);
    expect(t.sub('send-keys')).toEqual([['send-keys', '-t', '%7', 'Enter']]);
    expect(t.sub('new-window')).toEqual([]);
  });

  it('a pane in copy mode is released before the paste', async () => {
    const t = fakeTmux({ 'display-message': (a) => (a.includes('#{pane_in_mode}') ? '1\n' : 'note:1\n') });
    await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'note:@0.%7' } }), node(), { prompt: 'hi' });
    expect(t.sub('send-keys')).toEqual([
      ['send-keys', '-t', '%7', '-X', 'cancel'],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
  });

  it('live but not in tmux (or its pane is gone): 409 live_outside_tmux, nothing spawned', async () => {
    const t = fakeTmux();
    expect(await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: null } }), node(), {})).toEqual({
      status: 409,
      body: { error: 'live_outside_tmux', pid: 42 },
    });
    expect(await resumeNode(makeDeps(t.run, { liveEntry: { pid: 43, tmux: 'note:@0.%99' } }), node(), {})).toEqual({
      status: 409,
      body: { error: 'live_outside_tmux', pid: 43 },
    });
    expect(t.sub('new-window')).toEqual([]);
  });

  it('fresh: a new claude with the node context, child of the node, even while the node is live', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'note:@0.%7' } }), node(), {
      fresh: true,
      prompt: 'write the README',
    });
    expect(out).toEqual({ status: 200, body: { action: 'spawned', window: 'note:3', cwd: '/home/u/mcp-notes' } });
    const [nw] = t.sub('new-window');
    const expectedPrompt = freshPrompt(node(), 'write the README');
    expect(nw).toEqual(
      newWindowArgv(
        '/home/u/mcp-notes',
        'A0-3G-new',
        claudeCommand(CLAUDE, [expectedPrompt], { CC_PARENT_SESSION: SID }),
      ),
    );
    expect(t.sub('select-window')).toEqual([]);
  });

  it('no tmux server: 409 no_tmux', async () => {
    const t = fakeTmux({
      'list-sessions': () => {
        throw new Error('no server running on /tmp/tmux-1000/default');
      },
    });
    expect(await resumeNode(makeDeps(t.run), node(), {})).toEqual({ status: 409, body: { error: 'no_tmux' } });
  });

  it('new-window failing is a 500 spawn_failed with the message', async () => {
    const t = fakeTmux({
      'new-window': () => {
        throw new Error('command too long');
      },
    });
    expect(await resumeNode(makeDeps(t.run), node(), {})).toEqual({
      status: 500,
      body: { error: 'spawn_failed', message: 'command too long' },
    });
  });

  it('NOTESD_TMUX_SOCKET puts -S <socket> in front of every tmux call', async () => {
    const t = fakeTmux();
    await resumeNode(makeDeps(t.run, { tmuxSocket: '/run/tmux.sock' }), node(), {});
    expect(t.calls.length).toBeGreaterThan(0);
    for (const call of t.calls) expect(call.slice(0, 2)).toEqual(['-S', '/run/tmux.sock']);
  });
});

describe('resolveCwd (deleted worktree)', () => {
  const gone = node({ cwd: '/home/u/.worktrees/mcp-notes/wall-editing' });

  it('prefers the newest existing non-worktree cwd of the same repo, and reports original_cwd', async () => {
    const t = fakeTmux();
    const deps = makeDeps(t.run, {
      dirs: ['/home/u/mcp-notes', '/home/u/.worktrees/mcp-notes/other', '/home/u'],
      repoCwds: async () => ['/home/u/.worktrees/mcp-notes/other', '/home/u/old-clone', '/home/u/mcp-notes'],
    });
    expect(await resolveCwd(deps, gone)).toEqual({ cwd: '/home/u/mcp-notes', missing: true });
    const out = await resumeNode(deps, gone, {});
    expect(out).toEqual({
      status: 200,
      body: {
        action: 'resumed',
        window: 'note:3',
        cwd: '/home/u/mcp-notes',
        original_cwd: '/home/u/.worktrees/mcp-notes/wall-editing',
      },
    });
  });

  it('falls back to ~/<repo>, then $HOME', async () => {
    const t = fakeTmux();
    expect(await resolveCwd(makeDeps(t.run, { dirs: ['/home/u/mcp-notes'] }), gone)).toEqual({
      cwd: '/home/u/mcp-notes',
      missing: true,
    });
    expect(await resolveCwd(makeDeps(t.run, { dirs: [] }), gone)).toEqual({ cwd: '/home/u', missing: true });
    expect(await resolveCwd(makeDeps(t.run, { dirs: [] }), node({ cwd: null, repo: null }))).toEqual({
      cwd: '/home/u',
      missing: false,
    });
  });

  it('a failing repoCwds is only a hint', async () => {
    const t = fakeTmux();
    const deps = makeDeps(t.run, {
      dirs: ['/home/u/mcp-notes'],
      repoCwds: async () => {
        throw new Error('db down');
      },
    });
    expect(await resolveCwd(deps, gone)).toEqual({ cwd: '/home/u/mcp-notes', missing: true });
  });
});

describe('createSessionResumer', () => {
  function resumerWith(deps: ResumeDeps, nodes: ResumeNode[]) {
    return createSessionResumer({
      normalize: (input) => {
        const s = input.trim().toUpperCase().replace('-', '');
        return /^[0-9A-Z]{4}$/.test(s) ? `${s.slice(0, 2)}-${s.slice(2)}` : null;
      },
      lookup: async (id) => nodes.find((n) => n.nodeId === id) ?? null,
      deps,
    });
  }

  it('a non-id and an unknown id are not_found', async () => {
    const t = fakeTmux();
    const r = resumerWith(makeDeps(t.run), [node()]);
    expect(await r.resume('not an id', {})).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await r.resume('ZZ-ZZ', {})).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(t.calls).toEqual([]);
  });

  it('a second click before the registry lists the new process focuses the window it just opened', async () => {
    const clock = { t: 1_000_000 };
    const t = fakeTmux({ 'list-panes': () => '%1\n%12\n' });
    const r = resumerWith(makeDeps(t.run, { clock }), [node()]);
    expect((await r.resume('a03g', {})).body).toMatchObject({ action: 'resumed' });
    clock.t += 5_000;
    expect((await r.resume('A0-3G', {})).body).toMatchObject({ action: 'focused' });
    expect(t.sub('new-window')).toHaveLength(1);
    clock.t += RECENT_SPAWN_MS;
    expect((await r.resume('A0-3G', {})).body).toMatchObject({ action: 'resumed' });
    expect(t.sub('new-window')).toHaveLength(2);
  });

  it('builds lazy deps once', async () => {
    const t = fakeTmux();
    let built = 0;
    const r = createSessionResumer({
      normalize: () => 'A0-3G',
      lookup: async () => node(),
      deps: () => {
        built += 1;
        return makeDeps(t.run);
      },
    });
    expect(built).toBe(0);
    await r.resume('A0-3G', {});
    await r.resume('A0-3G', { fresh: true });
    expect(built).toBe(1);
  });
});
