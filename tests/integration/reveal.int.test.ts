import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { RevealDeps, RevealEnv } from '../../src/http/reveal.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

const ENV: RevealEnv = { explorer: '/mnt/c/Windows/explorer.exe', wslpath: '/usr/bin/wslpath' };
/** app.request() builds http://localhost/... URLs, so this is "our own page". */
const OWN_ORIGIN = 'http://localhost';

interface UploadResult {
  note: { id: string; images: Array<{ id: string; available: boolean; host: string | null }> };
  created: boolean;
}

/** Every member is a vi.fn mock (overrides are plain functions wrapped here), so .mock stays typed. */
function fakeReveal(over: { detect?: RevealDeps['detect']; spawn?: RevealDeps['spawn'] } = {}) {
  return {
    detect: vi.fn(over.detect ?? (async (): Promise<RevealEnv | null> => ENV)),
    wslpath: vi.fn(async (abs: string): Promise<string> => `\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`),
    spawn: vi.fn(over.spawn ?? (async (_cmd: string, _args: string[]): Promise<void> => undefined)),
  } satisfies RevealDeps;
}

describe('reveal in Explorer', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function uploadImage(rgb: { r: number; g: number; b: number }): Promise<string> {
    const png = await makeImage('png', 24, 16, rgb);
    const fd = new FormData();
    fd.append('file', new File([png], 'shot.png', { type: 'image/png' }));
    const res = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const { note } = (await res.json()) as UploadResult;
    expect(note.images).toHaveLength(1);
    return note.images[0]!.id;
  }

  function reveal(app: { request: typeof h.app.request }, imageId: string, origin?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers.Origin = origin;
    return Promise.resolve(app.request(`/api/images/${imageId}/reveal`, { method: 'POST', headers }));
  }

  describe('on the real app (never spawns)', () => {
    it('GET /api/capabilities answers { reveal: boolean }', async () => {
      const res = await h.app.request('/api/capabilities');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reveal: unknown };
      expect(Object.keys(body)).toEqual(['reveal']);
      expect(typeof body.reveal).toBe('boolean');
    });

    it('403 forbidden_origin without an Origin header', async () => {
      const id = await uploadImage({ r: 10, g: 20, b: 30 });
      const res = await reveal(h.app, id);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    });

    it('403 forbidden_origin for a foreign Origin, and for our host on another port', async () => {
      const id = await uploadImage({ r: 11, g: 21, b: 31 });
      for (const origin of ['http://evil.example', 'http://localhost:5173', 'null']) {
        const res = await reveal(h.app, id, origin);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden_origin' });
      }
    });

    it('404 not_found for an unknown or malformed image id (checked before detecting WSL)', async () => {
      for (const id of ['Z-ZZZ', 'not-an-id']) {
        const res = await reveal(h.app, id, OWN_ORIGIN);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
    });

    it('GET on the reveal path is not served by the SPA fallback', async () => {
      const res = await h.app.request('/api/images/Z-ZZZ/reveal');
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
    });
  });

  describe('with injected RevealDeps', () => {
    it('capabilities follow detect', async () => {
      const on = createApp(h.deps, { reveal: fakeReveal() });
      expect(await (await on.request('/api/capabilities')).json()).toEqual({ reveal: true });
      const off = createApp(h.deps, { reveal: fakeReveal({ detect: async () => null }) });
      expect(await (await off.request('/api/capabilities')).json()).toEqual({ reveal: false });
    });

    it('runs explorer.exe /select,<wslpath -w original> for a real image and answers 202', async () => {
      const id = await uploadImage({ r: 40, g: 50, b: 60 });
      const fake = fakeReveal();
      const app = createApp(h.deps, { reveal: fake });

      const res = await reveal(app, id.replace('-', '').toLowerCase(), OWN_ORIGIN);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });

      expect(fake.wslpath).toHaveBeenCalledTimes(1);
      const abs = fake.wslpath.mock.calls[0]![0];
      expect(path.isAbsolute(abs)).toBe(true);
      expect(abs.startsWith(path.join(h.dataDir, 'images') + path.sep)).toBe(true);
      expect(abs).toMatch(new RegExp(`/images/\\d{4}/\\d{2}/${id}\\.png$`));

      expect(fake.spawn).toHaveBeenCalledTimes(1);
      expect(fake.spawn).toHaveBeenCalledWith(ENV.explorer, [`/select,\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`]);
    });

    it('409 reveal_unavailable when detect says no', async () => {
      const id = await uploadImage({ r: 70, g: 80, b: 90 });
      const fake = fakeReveal({ detect: async () => null });
      const res = await reveal(createApp(h.deps, { reveal: fake }), id, OWN_ORIGIN);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'reveal_unavailable' });
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it('500 spawn_failed when the spawn errors', async () => {
      const id = await uploadImage({ r: 100, g: 110, b: 120 });
      const fake = fakeReveal({
        spawn: async () => {
          throw new Error('spawn /mnt/c/Windows/explorer.exe EACCES');
        },
      });
      const res = await reveal(createApp(h.deps, { reveal: fake }), id, OWN_ORIGIN);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'spawn_failed', message: 'spawn /mnt/c/Windows/explorer.exe EACCES' });
    });

    it('404 not_on_this_machine (with host) once the original is gone, and nothing is spawned', async () => {
      const id = await uploadImage({ r: 130, g: 140, b: 150 });
      const fake = fakeReveal();
      const app = createApp(h.deps, { reveal: fake });
      expect((await reveal(app, id, OWN_ORIGIN)).status).toBe(202);
      const abs = fake.wslpath.mock.calls[0]![0];
      await rm(abs);
      fake.spawn.mockClear();

      const res = await reveal(app, id, OWN_ORIGIN);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; host: string | null };
      expect(body.error).toBe('not_on_this_machine');
      expect('host' in body).toBe(true);
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it('still checks the Origin with injected deps', async () => {
      const id = await uploadImage({ r: 160, g: 170, b: 180 });
      const fake = fakeReveal();
      const res = await reveal(createApp(h.deps, { reveal: fake }), id, 'http://evil.example');
      expect(res.status).toBe(403);
      expect(fake.detect).not.toHaveBeenCalled();
      expect(fake.spawn).not.toHaveBeenCalled();
    });
  });
});
