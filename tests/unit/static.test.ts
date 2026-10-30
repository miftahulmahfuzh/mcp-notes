import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_NOT_BUILT_TEXT, staticRoutes } from '../../src/http/static.js';

let tmp: string;
let dist: string;

function appFor(webDist: string): Hono {
  const app = new Hono();
  app.route('/', staticRoutes(undefined, { webDist }));
  return app;
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-static-'));
  dist = path.join(tmp, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>index</title>');
  await writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1);');
  await writeFile(path.join(dist, 'favicon.svg'), '<svg></svg>');
  await writeFile(path.join(tmp, 'secret.txt'), 'secret');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('staticRoutes', () => {
  it('returns 503 text when web/dist is missing', async () => {
    const res = await appFor(path.join(tmp, 'nope')).request('/');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(WEB_NOT_BUILT_TEXT);
  });

  it('serves index.html at / with no-cache', async () => {
    const res = await appFor(dist).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>index</title>');
  });

  it('falls back to index.html for client routes', async () => {
    const res = await appFor(dist).request('/some/client/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>index</title>');
  });

  it('serves index.html for /full/:id until fullscreen.html exists, then fullscreen.html', async () => {
    const app = appFor(dist);
    expect(await (await app.request('/full/A-B32CD')).text()).toContain('<title>index</title>');
    await writeFile(path.join(dist, 'fullscreen.html'), '<!doctype html><title>full</title>');
    try {
      const res = await app.request('/full/A-B32CD');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>full</title>');
    } finally {
      await rm(path.join(dist, 'fullscreen.html'));
    }
  });

  it('serves assets with a long immutable cache and the right type', async () => {
    const res = await appFor(dist).request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log(1);');
  });

  it('404s a missing asset instead of returning html', async () => {
    const res = await appFor(dist).request('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it('serves other root files such as favicon.svg', async () => {
    const res = await appFor(dist).request('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
  });

  it.each(['/api', '/api/notes', '/api/nope/x', '/mcp', '/health'])('does not serve %s', async (p) => {
    const res = await appFor(dist).request(p);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<title>index</title>');
  });

  it('does not escape web/dist', async () => {
    const res = await appFor(dist).request('/..%2Fsecret.txt');
    expect(await res.text()).not.toBe('secret');
    const asset = await appFor(dist).request('/assets/..%2F..%2Fsecret.txt');
    expect(await asset.text()).not.toBe('secret');
  });
});
