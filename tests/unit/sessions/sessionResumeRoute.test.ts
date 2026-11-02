import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { sessionResumeRoutes } from '../../../src/http/sessionResume.js';
import type { ResumeOutcome, ResumeRequest, SessionResumer } from '../../../src/sessions/resume.js';

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
