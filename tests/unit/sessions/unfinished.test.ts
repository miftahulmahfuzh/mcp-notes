import { describe, expect, it, vi } from 'vitest';
import {
  createUnfinishedChecker,
  orchSlug,
  parseVerifyOutput,
  type SwarmRunner,
  type SwarmRunRequest,
  type UnfinishedTarget,
} from '../../../src/sessions/unfinished.js';

const HOST = 'lenovo';
const HOME = '/home/u';
const SCRIPT = '/home/u/.claude/skills/swarm/swarm.py';

function verifyJson(statuses: Array<{ status: string; derived?: string }>): string {
  return JSON.stringify({
    swarm: true,
    slug: 's',
    disagreements: [],
    applied: false,
    runnable_now: [],
    stalled: [],
    phases: statuses.map((p, i) => ({ n: i + 1, title: `p${i + 1}`, commit: null, task_id: null, ...p })),
  });
}

function node(over: Partial<UnfinishedTarget> = {}): UnfinishedTarget {
  return {
    name: 'orch-wall-editing',
    custom_title: null,
    host: HOST,
    cwd: '/home/u/.worktrees/mcp-notes/wall-editing',
    repo: 'mcp-notes',
    live: false,
    unfinished: null,
    ...over,
  };
}

function fakeRunner(stdout: string | ((req: SwarmRunRequest) => string)) {
  return vi.fn<SwarmRunner>(async (req) => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : stdout(req) }));
}

function checker(runner: SwarmRunner, over: { exists?: Set<string>; now?: () => number; waitMs?: number; swarmScript?: string | null } = {}) {
  const present = over.exists ?? new Set([SCRIPT, '/home/u/.worktrees/mcp-notes/wall-editing', '/home/u/mcp-notes']);
  return createUnfinishedChecker({
    swarmScript: over.swarmScript === undefined ? SCRIPT : over.swarmScript,
    host: HOST,
    homeDir: HOME,
    runner,
    exists: (p) => present.has(p),
    now: over.now ?? (() => 0),
    waitMs: over.waitMs ?? 200,
  });
}

describe('orchSlug', () => {
  it('takes the slug off an orch name', () => {
    expect(orchSlug('orch-wall-editing')).toBe('wall-editing');
    expect(orchSlug('orch-project-session-graph')).toBe('project-session-graph');
  });
  it('rejects everything else', () => {
    expect(orchSlug('impl-wall-editing-p3')).toBeNull();
    expect(orchSlug('analyze-wall-editing')).toBeNull();
    expect(orchSlug('orch-')).toBeNull();
    expect(orchSlug('orch-a b')).toBeNull();
    expect(orchSlug('orch-../x')).toBeNull();
    expect(orchSlug(null)).toBeNull();
  });
});

describe('parseVerifyOutput', () => {
  it('is true when any phase is not derived done', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'done' }, { status: 'pending', derived: 'pending' }]))).toBe(true);
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'done' }, { status: 'failed', derived: 'failed' }]))).toBe(true);
  });
  it('trusts derived over the ledger status', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'running', derived: 'done' }]))).toBe(false);
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'pending' }]))).toBe(true);
  });
  it('falls back to status when derived is missing', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'done' }]))).toBe(false);
    expect(parseVerifyOutput(verifyJson([{ status: 'running' }]))).toBe(true);
  });
  it('is false when every phase is done or there are none', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'done' }]))).toBe(false);
    expect(parseVerifyOutput(verifyJson([]))).toBe(false);
  });
  it('is false for a repo with no ledger for the slug', () => {
    expect(parseVerifyOutput(JSON.stringify({ swarm: false, reason: 'no ledger for x', repo: '/home/u/mcp-notes' }))).toBe(false);
  });
  it('is null when swarm.py found no repo, or the output is not what it prints', () => {
    expect(parseVerifyOutput(JSON.stringify({ swarm: false, reason: 'not inside a git repository' }))).toBeNull();
    expect(parseVerifyOutput('Traceback (most recent call last):')).toBeNull();
    expect(parseVerifyOutput('[]')).toBeNull();
    expect(parseVerifyOutput(JSON.stringify({ swarm: true }))).toBeNull();
  });
});

describe('createUnfinishedChecker.annotate', () => {
  const PENDING = verifyJson([{ status: 'done', derived: 'done' }, { status: 'pending', derived: 'pending' }]);
  const DONE = verifyJson([{ status: 'done', derived: 'done' }]);

  it('marks an orch node with pending phases and no live session', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner).annotate([node()]);
    expect(n!.unfinished).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toMatchObject({
      script: SCRIPT,
      slug: 'wall-editing',
      cwd: '/home/u/.worktrees/mcp-notes/wall-editing',
    });
  });

  it('is false while the orch session is live', async () => {
    const [n] = await checker(fakeRunner(PENDING)).annotate([node({ live: true })]);
    expect(n!.unfinished).toBe(false);
  });

  it('is false when the ledger is finished', async () => {
    const [n] = await checker(fakeRunner(DONE)).annotate([node()]);
    expect(n!.unfinished).toBe(false);
  });

  it('reads the orch name from the custom title too', async () => {
    const [n] = await checker(fakeRunner(PENDING)).annotate([node({ name: null, custom_title: 'orch-wall-editing' })]);
    expect(n!.unfinished).toBe(true);
  });

  it('never runs for a non-orch node and leaves it null', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner).annotate([node({ name: 'impl-wall-editing-p3' })]);
    expect(n!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('never runs for a node on the other machine', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner).annotate([node({ host: 'gpd' })]);
    expect(n!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('is null, without running anything, when the script is missing or turned off', async () => {
    const runner = fakeRunner(PENDING);
    const missing = new Set(['/home/u/.worktrees/mcp-notes/wall-editing']);
    expect((await checker(runner, { exists: missing }).annotate([node()]))[0]!.unfinished).toBeNull();
    expect((await checker(runner, { swarmScript: null }).annotate([node()]))[0]!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('falls back to ~/<repo> when the worktree is gone, and gives up when neither exists', async () => {
    const runner = fakeRunner(PENDING);
    const gone = new Set([SCRIPT, '/home/u/mcp-notes']);
    await checker(runner, { exists: gone }).annotate([node()]);
    expect(runner.mock.calls[0]![0].cwd).toBe('/home/u/mcp-notes');

    const nothing = fakeRunner(PENDING);
    const [n] = await checker(nothing, { exists: new Set([SCRIPT]) }).annotate([node()]);
    expect(n!.unfinished).toBeNull();
    expect(nothing).not.toHaveBeenCalled();
  });

  it('ignores a repo key that is not a plain directory name', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner, { exists: new Set([SCRIPT, '/home/x']) }).annotate([
      node({ cwd: null, repo: '../x' }),
    ]);
    expect(n!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('is null when swarm.py fails, exits non-zero or throws', async () => {
    const bad = vi.fn<SwarmRunner>(async () => ({ code: 2, stdout: PENDING }));
    expect((await checker(bad).annotate([node()]))[0]!.unfinished).toBeNull();
    const boom = vi.fn<SwarmRunner>(async () => {
      throw new Error('spawn python3 ENOENT');
    });
    expect((await checker(boom).annotate([node()]))[0]!.unfinished).toBeNull();
  });

  it('caches per slug for the TTL, then serves the stale value while it refreshes', async () => {
    let t = 0;
    let out = PENDING;
    const runner = fakeRunner(() => out);
    const c = checker(runner, { now: () => t });

    expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    t = 30_000;
    expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);

    out = DONE;
    t = 61_000;
    // Stale: answered from the cache at once, refresh started in the background.
    expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect((await c.annotate([node()]))[0]!.unfinished).toBe(false);
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('runs once for two nodes of the same set', async () => {
    const runner = fakeRunner(PENDING);
    const nodes = await checker(runner).annotate([node(), node({ live: true })]);
    expect(nodes.map((n) => n.unfinished)).toEqual([true, false]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('answers null when swarm.py is slower than the wait budget, and the value on the next call', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn<SwarmRunner>(async () => {
      await gate;
      return { code: 0, stdout: PENDING };
    });
    const c = checker(runner, { waitMs: 10 });
    expect((await c.annotate([node()]))[0]!.unfinished).toBeNull();
    release();
    await vi.waitFor(async () => {
      expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('runs at most `concurrency` at a time', async () => {
    let active = 0;
    let peak = 0;
    const runner = vi.fn<SwarmRunner>(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { code: 0, stdout: PENDING };
    });
    const c = createUnfinishedChecker({
      swarmScript: SCRIPT,
      host: HOST,
      homeDir: HOME,
      runner,
      exists: () => true,
      waitMs: 1_000,
      concurrency: 2,
    });
    const nodes = Array.from({ length: 6 }, (_, i) => node({ name: `orch-set-${i}` }));
    await c.annotate(nodes);
    expect(runner).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
    expect(nodes.every((n) => n.unfinished === true)).toBe(true);
  });
});
