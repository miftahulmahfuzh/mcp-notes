import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { RevealDeps, RevealEnv } from '../../src/http/reveal.js';
import type { Note } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

const ENV: RevealEnv = { explorer: '/mnt/c/Windows/explorer.exe', wslpath: '/usr/bin/wslpath' };
const OWN_ORIGIN = 'http://localhost';

function fakeReveal(over: { detect?: RevealDeps['detect'] } = {}) {
  return {
    detect: vi.fn(over.detect ?? (async (): Promise<RevealEnv | null> => ENV)),
    wslpath: vi.fn(async (abs: string): Promise<string> => `\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`),
    spawn: vi.fn(async (_cmd: string, _args: string[]): Promise<void> => undefined),
  } satisfies RevealDeps;
}

function win(abs: string): string {
  return `\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`;
}

describe('reveal for note files', () => {
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

  async function attachFile(noteId: string, text: string, name: string): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([Buffer.from(text)], name));
    const res = await h.app.request(`/api/notes/${noteId}/files`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  async function attachImage(noteId: string, rgb: { r: number; g: number; b: number }): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([await makeImage('png', 8, 8, rgb)], 'p.png'));
    const res = await h.app.request(`/api/notes/${noteId}/images`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  function post(app: { request: typeof h.app.request }, url: string, origin: string | null = OWN_ORIGIN): Promise<Response> {
    const headers: Record<string, string> = {};
    if (origin !== null) headers.Origin = origin;
    return Promise.resolve(app.request(url, { method: 'POST', headers }));
  }

  it('selects one file in Explorer', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attachFile('A-B32', 'hello', 'notes.txt')).files[0]!;
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    const res = await post(app, `/api/files/${f.id}/reveal`);
    expect(res.status).toBe(202);
    const abs = path.join(h.dataDir, 'files', 'A-B32', 'notes.txt');
    expect(fake.wslpath).toHaveBeenCalledWith(abs);
    expect(fake.spawn).toHaveBeenCalledWith(ENV.explorer, [`/select,${win(abs)}`]);
  });

  it('refuses foreign origins and unknown ids, and reports a file on another machine', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attachFile('A-B32', 'hello', 'notes.txt')).files[0]!;
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    expect((await post(app, `/api/files/${f.id}/reveal`, null)).status).toBe(403);
    expect((await post(app, `/api/files/${f.id}/reveal`, 'http://evil.example')).status).toBe(403);
    const unknown = await post(app, '/api/files/Z-ZZZ/reveal');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
    await rm(path.join(h.dataDir, 'files', 'A-B32', 'notes.txt'));
    const away = await post(app, `/api/files/${f.id}/reveal`);
    expect(away.status).toBe(404);
    expect(await away.json()).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('opens the note files folder when the note has files (images or not)', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await attachImage('A-B32', { r: 1, g: 1, b: 1 });
    await attachFile('A-B32', 'hello', 'notes.txt');
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    const res = await post(app, '/api/notes/a-b32/reveal');
    expect(res.status).toBe(202);
    const dir = path.join(h.dataDir, 'files', 'A-B32');
    expect(fake.wslpath).toHaveBeenCalledWith(dir);
    expect(fake.spawn).toHaveBeenCalledWith(ENV.explorer, [win(dir)]);
  });

  it('selects the first image when the note has no live files', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const withImage = await attachImage('A-B32', { r: 2, g: 2, b: 2 });
    const f = (await attachFile('A-B32', 'gone soon', 'old.txt')).files[0]!;
    await h.app.request(`/api/files/${f.id}`, { method: 'DELETE' });
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    expect((await post(app, '/api/notes/A-B32/reveal')).status).toBe(202);
    const args = fake.spawn.mock.calls[0]![1];
    expect(args).toHaveLength(1);
    expect(args[0]!.startsWith('/select,')).toBe(true);
    expect(args[0]).toContain(`${withImage.images[0]!.id}.png`);
  });

  it('404s a text note, an unknown, malformed or deleted note', async () => {
    await insertTextNote(h, 'A-B32', 'just text');
    await insertTextNote(h, 'C-D45', 'deleted');
    await attachFile('C-D45', 'x', 'x.txt');
    await h.app.request('/api/notes/C-D45', { method: 'DELETE' });
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    for (const id of ['A-B32', 'Z-ZZZ', 'not-an-id', 'C-D45']) {
      const res = await post(app, `/api/notes/${id}/reveal`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect(fake.detect).not.toHaveBeenCalled();
  });

  it('reports not_on_this_machine when none of the note files is here', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await attachFile('A-B32', 'hello', 'notes.txt');
    await rm(path.join(h.dataDir, 'files', 'A-B32', 'notes.txt'));
    const app = createApp(h.deps, { reveal: fakeReveal() });
    const res = await post(app, '/api/notes/A-B32/reveal');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
  });

  it('answers 409 reveal_unavailable off WSL, and 403 for a foreign origin', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await attachFile('A-B32', 'hello', 'notes.txt');
    const off = createApp(h.deps, { reveal: fakeReveal({ detect: async () => null }) });
    const res = await post(off, '/api/notes/A-B32/reveal');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'reveal_unavailable' });
    expect((await post(off, '/api/notes/A-B32/reveal', 'http://localhost:5173')).status).toBe(403);
  });
});
