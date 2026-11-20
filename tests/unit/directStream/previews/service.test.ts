import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { LocalSource, type LocalVideos } from '../../../../src/directStream/previews/local.js';
import { StreamPreviews } from '../../../../src/directStream/previews/service.js';
import type { LocalVideo, PreviewSource } from '../../../../src/directStream/previews/types.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';
import { fakeFfmpeg, fakeVideo } from './fakes.js';

const dirs: string[] = [];
const open: StreamPreviews[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'notesd-previews-service-'));
  dirs.push(d);
  return d;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL = { timeout: 5000, interval: 10 };

function sessionOf(): StreamSession {
  return { id: 'P'.repeat(32), ref: { kind: 'movie', tmdbId: 550 }, cache: null, torrent: null, previewRev: 0 } as unknown as StreamSession;
}

function setup(video: LocalVideo, ffmpeg: ReturnType<typeof fakeFfmpeg>, options: { before?: PreviewSource[] } = {}) {
  const session = sessionOf();
  const logged: string[] = [];
  const priorities: Array<[number, number]> = [];
  const log = (line: string) => void logged.push(line);
  const videos: LocalVideos = { forSession: async () => video, whole: async () => [video] };
  const previews = new StreamPreviews({
    sources: [...(options.before ?? []), new LocalSource('cache', videos, log)],
    builder: new SheetBuilder({ spawn: ffmpeg.spawn, ffmpegBin: '/opt/ffmpeg', setPriority: (pid, p) => void priorities.push([pid, p]), getPriority: () => 19, log }),
    peek: (id) => (id === session.id ? session : null),
    log,
    lookMs: 0,
    retryMs: 1,
  });
  open.push(previews);
  return { previews, session, logged, priorities };
}

describe('seek previews of the session on screen', () => {
  it('are made one ffmpeg at a time, each at the lowest priority', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const t = setup(fakeVideo(dir, { durationS: 1100 }), ffmpeg);
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).state, POLL).toBe('ready');
    expect(ffmpeg.runs).toHaveLength(4);
    expect(ffmpeg.mostAtOnce()).toBe(1);
    expect(t.priorities).toEqual(ffmpeg.runs.map((r) => [r.pid, 19]));
    expect((await readdir(dir)).sort()).toEqual(['previews.json', 'sheet-00000.jpg', 'sheet-00001.jpg', 'sheet-00002.jpg', 'sheet-00003.jpg']);
  });

  it('a sheet ffmpeg keeps failing is tried three times, keeps nothing and changes nothing the page sees', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'fail' });
    const t = setup(fakeVideo(dir, { durationS: 300 }), ffmpeg);
    t.previews.reported(t.session.id);
    await expect.poll(() => t.logged.some((l) => l.includes('giving up on sheet 1/1')), POLL).toBe(true);
    await sleep(50);
    t.previews.reported(t.session.id);
    await sleep(50);
    expect(ffmpeg.runs).toHaveLength(3);
    expect(t.logged.filter((l) => l.includes('failed ('))).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
    expect(await t.previews.list(t.session)).toEqual({ state: 'none', source: null, cues: [] });
    expect(t.session.previewRev).toBe(0);
  });

  it('a missing ffmpeg is said once and nothing more is tried', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'missing' });
    const t = setup(fakeVideo(dir, { durationS: 1100 }), ffmpeg);
    t.previews.reported(t.session.id);
    await expect.poll(() => t.logged.some((l) => l.includes('ffmpeg (/opt/ffmpeg) was not found')), POLL).toBe(true);
    t.previews.reported(t.session.id);
    expect(await t.previews.sweep()).toBe(0);
    await sleep(50);
    expect(ffmpeg.runs).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a restart keeps the finished sheets and makes only the missing ones', async () => {
    const dir = await tempDir();
    const a = setup(fakeVideo(dir, { durationS: 1000, coverage: [[0, 360], [720, 1000]] }), fakeFfmpeg());
    a.previews.reported(a.session.id);
    await expect.poll(async () => (await a.previews.list(a.session)).cues.length, POLL).toBe(64);
    await a.previews.close();
    const before = await stat(path.join(dir, 'sheet-00000.jpg'));
    const second = fakeFfmpeg();
    const b = setup(fakeVideo(dir, { durationS: 1000 }), second);
    b.previews.reported(b.session.id);
    await expect.poll(async () => (await b.previews.list(b.session)).state, POLL).toBe('ready');
    expect(second.runs.map((r) => path.basename(r.out).split('.')[0])).toEqual(['sheet-00001']);
    const after = await stat(path.join(dir, 'sheet-00000.jpg'));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it('raise preview_rev each time the cue list changes, and only then', async () => {
    const dir = await tempDir();
    const video = fakeVideo(dir, { durationS: 1000, coverage: [[0, 360]] });
    const t = setup(video, fakeFfmpeg());
    expect((await t.previews.list(t.session)).state).toBe('none');
    expect(t.session.previewRev).toBe(0);
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).state, POLL).toBe('partial');
    const partialRev = t.session.previewRev;
    expect(partialRev).toBeGreaterThanOrEqual(1);
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(partialRev);
    video.setCoverage([[0, 1000]]);
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).state, POLL).toBe('ready');
    const readyRev = t.session.previewRev;
    expect(readyRev).toBeGreaterThan(partialRev);
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(readyRev);
  });

  it('take the first source with frames: a provider\'s before this machine\'s', async () => {
    const dir = await tempDir();
    const none: PreviewSource = { name: 'provider', list: async () => ({ state: 'none', source: null, cues: [] }) };
    const t = setup(fakeVideo(dir, { durationS: 300 }), fakeFfmpeg(), { before: [none] });
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).source, POLL).toBe('local');
    const provider: PreviewSource = {
      name: 'provider',
      list: async () => ({ state: 'ready', source: 'provider', cues: [{ start_s: 0, end_s: 10, url: '/api/stream/sessions/x/p?u=a&img=1', x: 0, y: 0, w: 160, h: 90 }] }),
    };
    const u = setup(fakeVideo(dir, { durationS: 300 }), fakeFfmpeg(), { before: [provider] });
    expect((await u.previews.list(u.session)).source).toBe('provider');
  });

  it('a source that says its list changed has the session listed again: preview_rev rises once, and no position answer waits for it', async () => {
    const dir = await tempDir();
    let frames = false;
    const provider: PreviewSource = {
      name: 'provider',
      list: async () =>
        frames
          ? { state: 'ready', source: 'provider', cues: [{ start_s: 0, end_s: 10, url: '/api/stream/sessions/x/p?u=a&img=1', x: 0, y: 0, w: 160, h: 90 }] }
          : { state: 'none', source: null, cues: [] },
    };
    const t = setup(fakeVideo(dir, { durationS: 300, coverage: [] }), fakeFfmpeg(), { before: [provider] });
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(0);
    frames = true;
    t.previews.changed(t.session);
    await expect.poll(() => t.session.previewRev, POLL).toBe(1);
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(1);
  });

  it('a sweep makes what the films whole on disk lack, with no session', async () => {
    const dir = await tempDir();
    const t = setup(fakeVideo(dir, { durationS: 800 }), fakeFfmpeg());
    expect(await t.previews.sweep()).toBe(3);
    await expect.poll(async () => (await readdir(dir)).filter((n) => n.startsWith('sheet-')).length, POLL).toBe(3);
  });
});
