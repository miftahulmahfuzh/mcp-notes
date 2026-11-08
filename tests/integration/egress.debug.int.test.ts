import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { debugApiRoutes } from '../../src/http/debugApi.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';

let h: ApiHarness;
let app: Hono;

beforeAll(async () => {
  h = await createApiHarness();
  app = new Hono();
  app.route('/', debugApiRoutes(h.deps));
});

afterAll(async () => {
  await h.close();
});

describe('GET /api/debug/egress', () => {
  it('lists query shapes with rows and bytes on a loopback host', async () => {
    await h.sendJson('POST', '/api/notes', { body: 'egress probe' });
    await h.request('/api/notes');
    const res = await Promise.resolve(app.request('http://127.0.0.1/api/debug/egress'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      quota: { tripped: boolean; resumes_at: string | null };
      totalCalls: number;
      top: { label: string; calls: number; rows: number; bytes: number }[];
    };
    expect(body.enabled).toBe(true);
    expect(body.quota).toEqual({ tripped: false, resumes_at: null });
    expect(body.totalCalls).toBeGreaterThan(0);
    expect(body.top.length).toBeGreaterThan(0);
    expect(body.top[0]!.bytes).toBeGreaterThan(0);
  });

  it('refuses a non-loopback host', async () => {
    const res = await Promise.resolve(app.request('http://evil.example/api/debug/egress'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_host' });
  });
});
