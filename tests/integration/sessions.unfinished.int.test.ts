import { hostname } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createUnfinishedChecker, type SwarmRunner } from '../../src/sessions/unfinished.js';
import { startHarness, type Harness } from './imageHarness.js';

const PENDING = JSON.stringify({
  swarm: true,
  slug: 'demo',
  phases: [
    { n: 1, title: 'a', status: 'done', derived: 'done' },
    { n: 2, title: 'b', status: 'pending', derived: 'pending' },
  ],
});

interface WireNode {
  node_id: string;
  name: string | null;
  unfinished: boolean | null;
}

/** Phase 7 seam: nothing is live, and the real ~/.claude/sessions is never read. */
const NO_LIVE = { live: async () => [] };

describe('unfinished badge field', () => {
  let h: Harness;
  const runner = vi.fn<SwarmRunner>(async () => ({ code: 0, stdout: PENDING }));

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    runner.mockClear();
  });

  async function seed(sessionId: string, name: string, host: string): Promise<string> {
    const repo = new SessionsRepo(h.deps.db);
    const { session } = await repo.upsertFromHook({
      sessionId,
      parentSessionId: null,
      cwd: '/',
      name,
      tmux: null,
      host,
      startedAt: new Date('2026-11-01T00:00:00Z'),
      repo: 'demo-repo',
    });
    return session.nodeId;
  }

  function app() {
    return createApp(h.deps, {
      sessions: NO_LIVE,
      unfinished: createUnfinishedChecker({ swarmScript: '/', host: hostname(), runner, exists: () => true }),
    });
  }

  it('fills unfinished for orch nodes on this host only', async () => {
    await seed('00000000-0000-4000-8000-000000000001', 'orch-demo', hostname());
    await seed('00000000-0000-4000-8000-000000000002', 'impl-demo-p1', hostname());
    await seed('00000000-0000-4000-8000-000000000003', 'orch-demo', 'some-other-laptop');

    const res = await app().request('/api/projects/demo-repo/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: WireNode[] };
    const byHostName = body.nodes.map((n) => [n.name, n.unfinished]);
    expect(byHostName).toEqual(
      expect.arrayContaining([
        ['orch-demo', true],
        ['impl-demo-p1', null],
        ['orch-demo', null],
      ]),
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('fills unfinished on the node detail', async () => {
    const nodeId = await seed('00000000-0000-4000-8000-000000000004', 'orch-demo', hostname());
    const res = await app().request(`/api/sessions/${nodeId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { unfinished: boolean | null } };
    expect(body.session.unfinished).toBe(true);
  });

  it('reports null when no swarm script is configured (default test config)', async () => {
    await seed('00000000-0000-4000-8000-000000000005', 'orch-demo', hostname());
    const res = await createApp(h.deps, { sessions: NO_LIVE }).request('/api/projects/demo-repo/sessions');
    const body = (await res.json()) as { nodes: WireNode[] };
    expect(body.nodes.find((n) => n.name === 'orch-demo')!.unfinished).toBeNull();
  });
});
