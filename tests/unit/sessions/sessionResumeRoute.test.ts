import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { registryLive, sessionResumeRoutes } from '../../../src/http/sessionResume.js';
import type { ResumeOutcome, ResumeRequest, SessionResumer } from '../../../src/sessions/resume.js';
import { copyFixtureClaudeHome, FIXTURE } from '../../helpers/claudeHome.js';

const OWN = 'http://localhost';

function fakeResumer(out: ResumeOutcome) {
  const resume = vi.fn(async (_id: string, _req: ResumeRequest): Promise<ResumeOutcome> => out);
  return { resume } satisfies SessionResumer;
}

/** `origin: null` sends no Origin header (undefined would pick the default). */
function post(app: ReturnType<typeof sessionResumeRoutes>, body: string | undefined, origin: string | null = OWN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers.Origin = origin;
  return Promise.resolve(
    app.request('/api/sessions/a03g/resume', { method: 'POST', headers, ...(body !== undefined ? { body } : {}) }),
  );
}

/** The route never reads deps when a resumer is injected. */
const NO_DEPS = {} as AppDeps;

describe('POST /api/sessions/:nodeId/resume', () => {
  it('refuses a missing or foreign Origin before touching the resumer', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'resumed' } });
    const app = sessionResumeRoutes(NO_DEPS, { resumer: r });
    for (const origin of [null, 'http://evil.example', 'http://localhost:5173']) {
      const res = await post(app, '{}', origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    }
    expect(r.resume).not.toHaveBeenCalled();
  });

  it('an empty body is {}; the raw node id is passed through', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'resumed', window: 'note:4', cwd: '/x' } });
    const res = await post(sessionResumeRoutes(NO_DEPS, { resumer: r }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'resumed', window: 'note:4', cwd: '/x' });
    expect(r.resume).toHaveBeenCalledWith('a03g', {});
  });

  it('passes prompt and fresh', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'spawned' } });
    await post(sessionResumeRoutes(NO_DEPS, { resumer: r }), JSON.stringify({ prompt: 'go', fresh: true }));
    expect(r.resume).toHaveBeenCalledWith('a03g', { prompt: 'go', fresh: true });
  });

  it('400 for bad JSON, unknown keys, wrong types and an over-long prompt', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'resumed' } });
    const app = sessionResumeRoutes(NO_DEPS, { resumer: r });
    expect(await (await post(app, '{nope')).json()).toEqual({ error: 'invalid_json' });
    for (const body of [{ fresh: 'yes' }, { promt: 'typo' }, { prompt: 'x'.repeat(4001) }, { prompt: null }]) {
      const res = await post(app, JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    }
    expect(r.resume).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 200, body: { action: 'attached', job_id: 'e3650501', window: 'note:5', prompt_delivered: false } }],
    [{ status: 404, body: { error: 'not_found' } }],
    [{ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } }],
    [{ status: 409, body: { error: 'no_tmux' } }],
    [{ status: 409, body: { error: 'live_outside_tmux', pid: 7 } }],
    [{ status: 500, body: { error: 'spawn_failed', message: 'boom' } }],
  ] as Array<[ResumeOutcome]>)('passes the outcome through: %j', async (out) => {
    const res = await post(sessionResumeRoutes(NO_DEPS, { resumer: fakeResumer(out) }), '{}');
    expect(res.status).toBe(out.status);
    expect(await res.json()).toEqual(out.body);
  });
});

describe('registryLive (registry -> LiveEntry)', () => {
  it('gives a live background job its jobId, and an interactive session none', async () => {
    const home = await copyFixtureClaudeHome();
    try {
      const sid = 'e3650501-2a9d-432a-b2c0-f2aeff23fdf8';
      await writeFile(
        path.join(home, 'sessions', '3318108.json'),
        JSON.stringify({
          pid: 3318108,
          sessionId: sid,
          kind: 'bg',
          jobId: 'e3650501',
          messagingSocketPath: '/run/user/1000/cc-socks/3318108.sock',
          updatedAt: 1793585600000,
        }),
      );
      const live = registryLive(home, (pid) => pid === 4242 || pid === 3318108);
      expect(await live(sid)).toEqual({ pid: 3318108, tmux: null, jobId: 'e3650501' });
      expect(await live(FIXTURE.main)).toEqual({ pid: 4242, tmux: 'note:@0.%7', jobId: null });
      expect(await live('not-live')).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
