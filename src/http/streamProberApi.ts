import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { DisabledProber } from '../directStream/prober.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * GET /api/stream/prober: the direct-streaming prober of this machine. A read that starts nothing.
 * POST /api/stream/prober/pass: the owner asks for one pass now.
 * Like every direct-stream route it answers 503 direct_stream_off without direct streaming (R2.6).
 */
export function streamProberRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.get('/api/stream/prober', async (c) => {
    if (deps.directStream === undefined || deps.directStream === null) return c.json({ error: 'direct_stream_off' }, 503);
    const prober = deps.streamProber ?? new DisabledProber('setting_off');
    return c.json(await prober.status());
  });
  // The Stream side's refresh button: one pass now, asked for, so it rebuilds the candidate
  // listing and does not wait for idle. Answers at once; the pass runs on (GET shows `running`).
  r.post('/api/stream/prober/pass', sameOriginOnly, async (c) => {
    if (deps.directStream === undefined || deps.directStream === null) return c.json({ error: 'direct_stream_off' }, 503);
    const prober = deps.streamProber ?? new DisabledProber('setting_off');
    if (!prober.askPass()) return c.json({ error: 'prober_off', ...(await prober.status()) }, 409);
    return c.json(await prober.status(), 202);
  });
  return r;
}
