import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { jpegSize, SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { planSheets, type SheetSpec } from '../../../../src/directStream/previews/plan.js';
import { fakeFfmpeg, fakeJpeg, fakeVideo } from './fakes.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'notesd-previews-builder-'));
  dirs.push(d);
  return d;
}

const SHEET0 = planSheets(800)[0] as SheetSpec;
const go = () => new AbortController().signal;

function builderOf(ffmpeg: ReturnType<typeof fakeFfmpeg>, timeLimitMs?: number) {
  const priorities: Array<[number, number]> = [];
  const builder = new SheetBuilder({
    spawn: ffmpeg.spawn,
    ffmpegBin: 'ffmpeg',
    setPriority: (pid, p) => void priorities.push([pid, p]),
    getPriority: () => 19,
    log: () => undefined,
    ...(timeLimitMs === undefined ? {} : { timeLimitMs }),
  });
  return { builder, priorities };
}

describe('one sheet', () => {
  it('is written by a niced ffmpeg that can open local files only, under a .part name, checked, then renamed', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const { builder, priorities } = builderOf(ffmpeg);
    const outcome = await builder.build(fakeVideo(dir), SHEET0, go());
    expect(outcome).toMatchObject({ kind: 'made', nice: 19, record: { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 } });
    expect(await readdir(dir)).toEqual(['sheet-00000.jpg']);
    const run = ffmpeg.runs[0];
    expect(run?.out).toMatch(/sheet-00000\.jpg\.[0-9a-f]{8}\.part$/);
    const args = run?.args ?? [];
    expect(args.indexOf('-protocol_whitelist')).toBeGreaterThan(-1);
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,crypto,data,concat');
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('-xerror');
    // The input's own seek, once: the builder adds none.
    expect(args.filter((a) => a === '-ss')).toHaveLength(1);
    expect(args.join(' ')).toContain('-skip_frame nokey');
    expect(args.join(' ')).toContain('fps=1/10,scale=240:-2,tile=6x6');
    expect(priorities).toEqual([[run?.pid, 19]]);
  });

  it('reads this daemon\'s loopback gate only when the input says so, and never another host', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const { builder } = builderOf(ffmpeg);
    expect(await builder.build(fakeVideo(dir, { input: 'http://127.0.0.1:41234/0123abcd' }), SHEET0, go())).toMatchObject({ kind: 'made' });
    const args = ffmpeg.runs[0]?.args ?? [];
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,crypto,data,concat,http,tcp');
    for (const input of ['http://10.0.0.7/film.mp4', 'http://localhost:41234/x', 'https://127.0.0.1/x', 'tcp://127.0.0.1:1', 'pipe:0']) {
      expect(await builder.build(fakeVideo(dir, { input }), SHEET0, go())).toMatchObject({ kind: 'failed', detail: expect.stringContaining('is not run') });
    }
    expect(ffmpeg.runs).toHaveLength(1);
  });

  it('a delete racing the build keeps no sheet and never makes the video\'s folder again', async () => {
    const home = await tempDir();
    const dir = path.join(home, 'previews');
    const { builder } = builderOf(fakeFfmpeg({ delayMs: 60 }));
    const outcome = builder.build(fakeVideo(dir), SHEET0, go());
    setTimeout(() => void rm(home, { recursive: true, force: true }), 20);
    expect(await outcome).toMatchObject({ kind: 'not_yet', detail: expect.stringContaining('deleted') });
    await expect(readdir(home)).rejects.toThrow();
    const ffmpeg = fakeFfmpeg();
    expect(await builderOf(ffmpeg).builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'not_yet' });
    expect(ffmpeg.runs).toEqual([]);
    await expect(readdir(home)).rejects.toThrow();
  });

  it('keeps no part of a sheet ffmpeg failed on', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'fail' }));
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'failed', detail: expect.stringContaining('ffmpeg exited with 1') });
    expect(await readdir(dir)).toEqual([]);
  });

  it('kills an ffmpeg past its time limit and keeps nothing', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'hang' });
    const { builder } = builderOf(ffmpeg, 30);
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'failed', detail: expect.stringContaining('ran past') });
    expect(ffmpeg.runs[0]?.killed).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a picture that is not a JPEG is a failure', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'garbage' }));
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toEqual({ kind: 'failed', detail: 'ffmpeg wrote no picture' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('says so when ffmpeg is missing', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'missing' }));
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'no_ffmpeg' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('starts no ffmpeg for a stretch that is not on disk', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const { builder } = builderOf(ffmpeg);
    expect(await builder.build(fakeVideo(dir, { coverage: [[0, 200]] }), SHEET0, go())).toMatchObject({ kind: 'not_yet' });
    expect(ffmpeg.runs).toEqual([]);
  });

  it('a stretch that runs out of pieces is "not yet", not a failure, and keeps nothing', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'fail' }));
    expect(await builder.build(fakeVideo(dir, { notYet: true }), SHEET0, go())).toEqual({ kind: 'not_yet', detail: 'a piece of the stretch is not on disk' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('a sheet ffmpeg made from the bytes it was served is kept, whatever the cleanup says', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg());
    expect(await builder.build(fakeVideo(dir, { notYet: true }), SHEET0, go())).toMatchObject({ kind: 'made' });
    expect(await readdir(dir)).toEqual(['sheet-00000.jpg']);
  });

  it('an abort stops ffmpeg and keeps nothing', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'hang' });
    const { builder } = builderOf(ffmpeg);
    const abort = new AbortController();
    const outcome = builder.build(fakeVideo(dir), SHEET0, abort.signal);
    setTimeout(() => abort.abort(), 20);
    expect(await outcome).toEqual({ kind: 'aborted' });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('jpegSize', () => {
  it('reads a JPEG\'s size and nothing else', () => {
    expect(jpegSize(fakeJpeg(1440, 816))).toEqual({ width: 1440, height: 816 });
    expect(jpegSize(Buffer.from('not a picture'))).toBeNull();
  });
});
