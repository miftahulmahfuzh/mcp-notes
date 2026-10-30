import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageRoutes } from '../../src/http/images.js';
import {
  cacheDirOf,
  insertTextNote,
  makeImage,
  originalPathOf,
  startHarness,
  type Harness,
} from './imageHarness.js';

interface UploadResult {
  note: { id: string; body: string; tags: string[]; image: { mime: string; width: number; height: number; available: boolean; host: string | null } | null };
  created: boolean;
}

describe('image HTTP routes', () => {
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

  async function upload(bytes: Buffer, name: string, type: string, body?: string, app: Hono = h.app): Promise<Response> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name, { type }));
    if (body !== undefined) fd.append('body', body);
    return app.request('/api/images', { method: 'POST', body: fd });
  }

  it('uploads an image, returns {note, created}, and dedupes the same bytes', async () => {
    const png = await makeImage('png', 64, 32, { r: 200, g: 10, b: 10 });
    const r1 = await upload(png, 'red.png', 'image/png', 'a red box #from_phone');
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as UploadResult;
    expect(j1.created).toBe(true);
    expect(j1.note.body).toBe('a red box #from_phone');
    expect(j1.note.tags).toEqual(['from_phone']);
    expect(j1.note.image).toMatchObject({ mime: 'image/png', width: 64, height: 32, available: true });

    const r2 = await upload(png, 'again.png', 'image/png');
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as UploadResult;
    expect(j2.created).toBe(false);
    expect(j2.note.id).toBe(j1.note.id);
  });

  it('serves the original byte for byte with immutable caching and an sha256 ETag', async () => {
    const png = await makeImage('png', 40, 40, { r: 1, g: 2, b: 3 });
    const { note } = (await (await upload(png, 'orig.png', 'image/png')).json()) as UploadResult;

    const res = await h.app.request(`/api/notes/${note.id}/original`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const got = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(got, png)).toBe(0);
    expect(Buffer.compare(got, await readFile(await originalPathOf(h, note.id)))).toBe(0);

    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await h.app.request(`/api/notes/${note.id}/original`, { headers: { 'If-None-Match': etag! } });
    expect(again.status).toBe(304);
  });

  it('accepts lower-case and dash-less ids', async () => {
    const png = await makeImage('png', 10, 10, { r: 9, g: 9, b: 9 });
    const { note } = (await (await upload(png, 'id.png', 'image/png')).json()) as UploadResult;
    const loose = note.id.replace('-', '').toLowerCase();
    expect((await h.app.request(`/api/notes/${loose}/original`)).status).toBe(200);
    expect((await h.app.request(`/api/notes/${note.id.toLowerCase()}/thumb`)).status).toBe(200);
  });

  it('serves thumb (webp, 480 wide max) and preview (jpeg, long edge <= 1568)', async () => {
    const big = await makeImage('jpeg', 2400, 1200, { r: 30, g: 120, b: 60 });
    const { note } = (await (await upload(big, 'big.jpg', 'image/jpeg')).json()) as UploadResult;

    const thumb = await h.app.request(`/api/notes/${note.id}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    const tMeta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(tMeta.format).toBe('webp');
    expect(tMeta.width).toBeLessThanOrEqual(480);

    const preview = await h.app.request(`/api/notes/${note.id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
    const pMeta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    expect(pMeta.format).toBe('jpeg');
    expect(Math.max(pMeta.width!, pMeta.height!)).toBeLessThanOrEqual(1568);
  });

  it('display returns the original for browser formats and a JPEG for TIFF', async () => {
    const png = await makeImage('png', 50, 20, { r: 5, g: 50, b: 150 });
    const { note: pngNote } = (await (await upload(png, 'd.png', 'image/png')).json()) as UploadResult;
    const d1 = await h.app.request(`/api/notes/${pngNote.id}/display`);
    expect(d1.headers.get('content-type')).toBe('image/png');
    expect(Buffer.compare(Buffer.from(await d1.arrayBuffer()), png)).toBe(0);

    const tiff = await makeImage('tiff', 60, 30, { r: 90, g: 90, b: 10 });
    const { note: tifNote } = (await (await upload(tiff, 'd.tiff', 'image/tiff')).json()) as UploadResult;
    const d2 = await h.app.request(`/api/notes/${tifNote.id}/display`);
    expect(d2.status).toBe(200);
    expect(d2.headers.get('content-type')).toBe('image/jpeg');
    expect((await sharp(Buffer.from(await d2.arrayBuffer())).metadata()).width).toBe(60);
  });

  it('refuses non-images, a missing file field and oversized uploads', async () => {
    const notImage = await upload(Buffer.from('hello, not a picture'), 'a.txt', 'text/plain');
    expect(notImage.status).toBe(415);
    expect(((await notImage.json()) as { error: string }).error).toBe('not_an_image');

    const fd = new FormData();
    fd.append('body', 'no file here');
    const noFile = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(noFile.status).toBe(400);
    expect(((await noFile.json()) as { error: string }).error).toBe('file_required');

    const small = new Hono().route('/', imageRoutes(h.deps, { maxUploadBytes: 1024 }));
    const png = await makeImage('png', 300, 300, { r: 250, g: 1, b: 250 });
    const pngNoise = Buffer.concat([png, Buffer.alloc(4096, 7)]);
    const tooBig = await upload(pngNoise, 'big.png', 'image/png', undefined, small);
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: string }).error).toBe('too_large');
  });

  it('returns not_found for unknown ids and no_image for text notes', async () => {
    const unknown = await h.app.request('/api/notes/Z-ZZZ/original');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });

    const garbage = await h.app.request('/api/notes/not-an-id-at-all/thumb');
    expect(garbage.status).toBe(404);

    await insertTextNote(h, 'T-XT1', 'just words');
    const text = await h.app.request('/api/notes/T-XT1/preview');
    expect(text.status).toBe(404);
    expect(((await text.json()) as { error: string }).error).toBe('no_image');
  });

  it('answers not_on_this_machine with the host when the original is gone', async () => {
    const png = await makeImage('png', 30, 30, { r: 77, g: 77, b: 1 });
    const { note } = (await (await upload(png, 'gone.png', 'image/png')).json()) as UploadResult;
    await rm(await originalPathOf(h, note.id));
    await rm(cacheDirOf(h, note.id), { recursive: true, force: true });

    for (const v of ['original', 'display', 'thumb', 'preview']) {
      const res = await h.app.request(`/api/notes/${note.id}/${v}`);
      expect(res.status, v).toBe(404);
      expect(await res.json(), v).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
    }
  });

  it('a cached derivative is not served once the original is gone (every variant 404s)', async () => {
    const png = await makeImage('png', 900, 600, { r: 10, g: 200, b: 200 });
    const { note } = (await (await upload(png, 'cached.png', 'image/png')).json()) as UploadResult;
    expect((await h.app.request(`/api/notes/${note.id}/thumb`)).status).toBe(200);
    await rm(await originalPathOf(h, note.id));
    const thumb = await h.app.request(`/api/notes/${note.id}/thumb`);
    expect(thumb.status).toBe(404);
    expect(((await thumb.json()) as { error: string }).error).toBe('not_on_this_machine');
  });
});
