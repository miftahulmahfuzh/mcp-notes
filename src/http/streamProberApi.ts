import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { DisabledProber } from '../directStream/prober.js';

/**
 * GET /api/stream/prober: the direct-streaming prober of this machine. A read that starts nothing.
 * Like every direct-stream route it answers 503 direct_stream_off without direct streaming (R2.6).
 */
export function streamProberRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.get('/api/stream/prober', async (c) => {
    if (deps.directStream === undefined || deps.directStream === null) return c.json({ error: 'direct_stream_off' }, 503);
    const prober = deps.streamProber ?? new DisabledProber('setting_off');
    return c.json(await prober.status());
  });
  return r;
}
