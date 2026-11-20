import { writeFile } from 'node:fs/promises';
import type { PreviewProcess, SpawnPreview } from '../../../../src/directStream/previews/builder.js';
import { PreviewNotYet, type LocalVideo } from '../../../../src/directStream/previews/types.js';

/** A JPEG's first bytes saying `width` x `height`: what the builder's check reads. */
export function fakeJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

export type FakeMode = 'ok' | 'fail' | 'garbage' | 'hang' | 'missing';

export interface FakeRun {
  args: string[];
  out: string;
  pid: number | null;
  killed: boolean;
}

/** A stand-in for ffmpeg: records each run and writes (or not) its output as `mode` says. */
export function fakeFfmpeg(options: { mode?: FakeMode; width?: number; height?: number; delayMs?: number } = {}) {
  const runs: FakeRun[] = [];
  let atOnce = 0;
  let most = 0;
  let nextPid = 4000;
  const spawn: SpawnPreview = (args) => {
    const mode = options.mode ?? 'ok';
    const out = args[args.length - 1] ?? '';
    const run: FakeRun = { args: [...args], out, pid: mode === 'missing' ? null : (nextPid += 1), killed: false };
    runs.push(run);
    let settle: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    atOnce += 1;
    most = Math.max(most, atOnce);
    void exited.then(() => {
      atOnce -= 1;
    });
    // A write into a folder deleted meanwhile fails as the real ffmpeg would: exit 1.
    const later = (work: () => Promise<number | null>): void => {
      setTimeout(() => void work().then((code) => settle(code), () => settle(1)), options.delayMs ?? 5);
    };
    const missing = mode === 'missing' ? Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) : null;
    if (mode === 'missing') later(async () => -1);
    if (mode === 'ok') later(async () => (await writeFile(out, fakeJpeg(options.width ?? 1440, options.height ?? 816)), 0));
    if (mode === 'garbage') later(async () => (await writeFile(out, 'not a picture'), 0));
    if (mode === 'fail') later(async () => (await writeFile(out, 'half a sheet'), 1));
    const proc: PreviewProcess = {
      pid: run.pid,
      exited,
      startError: () => missing,
      stderrTail: () => (mode === 'fail' ? 'Invalid data found when processing input' : ''),
      kill: () => {
        run.killed = true;
        settle(null);
      },
    };
    return proc;
  };
  return { spawn, runs, mostAtOnce: () => most };
}

export interface FakeVideo extends LocalVideo {
  inputs: Array<[number, number]>;
  setCoverage(ranges: Array<[number, number]>): void;
}

/**
 * A LocalVideo whose sheets go to `dir` (its home: the folder `dir` is in); `notYet`: its stretches run out of pieces
 * (PreviewNotYet from cleanup); `input`: the address it gives ffmpeg, with `loopback` set for an http one.
 */
export function fakeVideo(
  dir: string,
  options: { key?: string; durationS?: number; coverage?: Array<[number, number]>; notYet?: boolean; input?: string } = {},
): FakeVideo {
  const durationS = options.durationS ?? 800;
  let ranges: Array<[number, number]> = options.coverage ?? [[0, durationS]];
  const inputs: Array<[number, number]> = [];
  return {
    key: options.key ?? 'test-video',
    dir,
    durationS,
    inputs,
    setCoverage: (next) => {
      ranges = next;
    },
    coverage: async () => ranges,
    input: async (startS, endS) => {
      inputs.push([startS, endS]);
      const address = options.input ?? '/films/test.mp4';
      const args = ['-ss', String(startS), '-t', String(endS - startS), '-i', address];
      const loopback = address.startsWith('http:') ? { loopback: true as const } : {};
      if (options.notYet !== true) return { args, ...loopback };
      return {
        args,
        ...loopback,
        cleanup: async () => {
          throw new PreviewNotYet('a piece of the stretch is not on disk');
        },
      };
    },
  };
}
