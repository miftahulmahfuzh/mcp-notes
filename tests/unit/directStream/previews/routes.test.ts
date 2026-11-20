import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { DirectStreamService } from '../../../../src/directStream/service.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';
import { SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { LocalSource } from '../../../../src/directStream/previews/local.js';
import { StreamPreviews } from '../../../../src/directStream/previews/service.js';
import { addSheet } from '../../../../src/directStream/previews/sheetIndex.js';
import { directStreamRoutes, streamPositionRoutes, UNKNOWN_SESSION } from '../../../../src/http/directStreamApi.js';
import type { MovieStreamsSource } from '../../../../src/movies/streams.js';
import type { StreamLive } from '../../../../src/movies/streamLive.js';
import { fakeFfmpeg, fakeJpeg, fakeVideo } from './fakes.js';

const SID = 'R'.repeat(32);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const sessionOf = () => ({ id: SID, ref: { kind: 'movie', tmdbId: 550 }, cache: null, torrent: null, previewRev: 0 }) as unknown as StreamSession;

function appOf(previews: StreamPreviews | null, session: StreamSession): Hono {
  const directStream = { session: (id: string) => (id === SID ? session : null) } as unknown as DirectStreamService;
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream, streamPreviews: previews }));
  return app;
}

describe('GET /api/stream/sessions/:id/previews', () => {
  it('answers no frame with previews off (NOTESD_STREAM_PREVIEWS=off)', async () => {
    const res = await appOf(null, sessionOf()).request(`/api/stream/sessions/${SID}/previews`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'none', rev: 0, source: null, cues: [] });
  });

  it('answers an unknown session as the session route does', async () => {
    const res = await appOf(null, sessionOf()).request(`/api/stream/sessions/${'X'.repeat(32)}/previews`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(UNKNOWN_SESSION);
  });

  it('lists the frames with the session\'s rev, serves a listed sheet as a JPEG, and nothing else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notesd-previews-route-'));
    dirs.push(dir);
    const video = fakeVideo(dir, { durationS: 800 });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'sheet-00000.jpg'), fakeJpeg(1440, 816));
    await addSheet(video, { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 });
    const session = sessionOf();
    const previews = new StreamPreviews({
      sources: [new LocalSource('cache', { forSession: async () => video, whole: async () => [] }, () => undefined)],
      builder: new SheetBuilder({ spawn: fakeFfmpeg().spawn, ffmpegBin: 'ffmpeg', log: () => undefined }),
      peek: () => session,
      log: () => undefined,
    });
    const app = appOf(previews, session);
    const body = (await (await app.request(`/api/stream/sessions/${SID}/previews`)).json()) as { state: string; rev: number; source: string; cues: Array<{ url: string }> };
    expect(body).toMatchObject({ state: 'partial', rev: 1, source: 'local' });
    expect(body.cues).toHaveLength(36);
    const sheet = await app.request(body.cues[0]?.url ?? '');
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await sheet.arrayBuffer())).toEqual(fakeJpeg(1440, 816));
    expect((await app.request(`/api/stream/sessions/${SID}/previews/previews.json`)).status).toBe(404);
    expect((await app.request(`/api/stream/sessions/${SID}/previews/sheet-00001.jpg`)).status).toBe(404);
    expect((await app.request(`/api/stream/sessions/${SID}/previews/sheet-00000.jpg?k=00000000`)).status).toBe(404);
    expect((await (await app.request(`/api/stream/sessions/${SID}/previews`)).json()) as { rev: number }).toMatchObject({ rev: 1 });
    await previews.close();
  });
});

describe('the position answer', () => {
  it('carries preview_rev and makes a page that is still open the one whose previews come first', async () => {
    const seen: string[] = [];
    const live = { has: () => true, current: () => ({ title_id: 'movie-550', duration: 100 }), report: () => undefined, end: () => undefined } as unknown as StreamLive;
    const movies = { host: 'host-a', tmdb: null, events: { changed: () => undefined }, repo: { titleById: async () => { throw new Error('down'); } } } as unknown as MovieStreamsSource;
    const session = { id: SID, ref: { kind: 'movie' as const, tmdbId: 550 }, source: { provider: 'Alpha' }, torrent: null, previewRev: 3 };
    const app = streamPositionRoutes({ movies, directStream: { session: () => session }, live, previews: { reported: (id) => void seen.push(id) } }, { log: () => undefined });
    const post = (body: object) => app.request(`/api/stream/sessions/${SID}/position`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await post({ position_s: 5, paused: true, beat: true });
    expect(await res.json()).toEqual({ ok: true, play_id: null, ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: 3 });
    await post({ position_s: 6, closed: true });
    expect(seen).toEqual([SID]);
  });
});
