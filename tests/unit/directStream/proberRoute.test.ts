import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { DisabledProber } from '../../../src/directStream/prober.js';
import { streamProberRoutes } from '../../../src/http/streamProberApi.js';

function app(deps: Partial<AppDeps>): Hono {
  const a = new Hono();
  a.route('/', streamProberRoutes(deps as AppDeps));
  return a;
}

describe('GET /api/stream/prober', () => {
  it('answers direct_stream_off without direct streaming', async () => {
    const res = await app({ directStream: null } as Partial<AppDeps>).request('/api/stream/prober');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'direct_stream_off' });
  });

  it('reports the prober off with its reason', async () => {
    const deps = { directStream: {}, streamProber: new DisabledProber('no_interop') } as unknown as Partial<AppDeps>;
    const res = await app(deps).request('/api/stream/prober');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, off_reason: 'no_interop', last_pass: null });
  });
});
