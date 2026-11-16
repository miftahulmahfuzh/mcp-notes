import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FfmpegProcess, SpawnFfmpeg } from '../../../src/directStream/torrent/remux.js';

/** The playlist ffmpeg's HLS muxer writes after `n` segments of 6 s; `end` adds the EXT-X-ENDLIST it writes on any exit. */
export function eventPlaylist(n: number, end = false): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:6.000000,', `seg-${String(i).padStart(5, '0')}.m4s`);
  if (end) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

export interface FakeFfmpegRun {
  args: string[];
  dir: string;
  killed: boolean;
  /** ffmpeg has written `n` segments (and with `end`, closed the playlist as it does on exit). */
  write(n: number, end?: boolean): Promise<void>;
  exit(code: number | null): void;
}

/** A stand-in for ffmpeg: it records each run's arguments and writes what a test tells it to into the run's folder. */
export function fakeFfmpeg(options: { segmentsAtStart?: number; exitAtStart?: number } = {}): { spawn: SpawnFfmpeg; runs: FakeFfmpegRun[] } {
  const runs: FakeFfmpegRun[] = [];
  const spawn: SpawnFfmpeg = (args) => {
    let settle: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const out = args[args.length - 1] ?? '';
    const run: FakeFfmpegRun = {
      args: [...args],
      dir: path.dirname(out),
      killed: false,
      async write(n, end = false) {
        await writeFile(path.join(run.dir, 'init.mp4'), 'init');
        for (let i = 0; i < n; i++) await writeFile(path.join(run.dir, `seg-${String(i).padStart(5, '0')}.m4s`), `segment ${i} `.repeat(20));
        await writeFile(out, eventPlaylist(n, end));
      },
      exit: (code) => settle(code),
    };
    runs.push(run);
    if (options.segmentsAtStart !== undefined) void run.write(options.segmentsAtStart);
    if (options.exitAtStart !== undefined) settle(options.exitAtStart);
    const proc: FfmpegProcess = {
      exited,
      stderrTail: () => 'Invalid data found when processing input',
      kill: () => {
        run.killed = true;
        settle(255);
      },
    };
    return proc;
  };
  return { spawn, runs };
}
