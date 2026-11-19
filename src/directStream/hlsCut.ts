import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { hlsStretch } from './picture.js';
import type { AudioCutter, StretchCut, StretchRequest } from './torrent/subtitles/whisper.js';

/**
 * The audio of a cloud stream ffmpeg cannot read by itself, for the cutters of Wyzie Synced and /sync-subtitle.
 *
 * Several stream hosts wrap every HLS segment in a small picture file (VidNest's and HyperLink's are PNGs), or name
 * their fragmented-MP4 parts `.jpg`, `.css` and `.pdf`: ffmpeg opens the playlist, sees pictures and finds no audio
 * stream, or reads the start and comes back empty after a seek.
 * In the subtitle soak of 2026-11-20 that left 8 of 10 cloud streams unheard: `/sync-subtitle` answered `unheard`,
 * and Wyzie Synced failed, for three of them with "too little speech in the film", which is never tried again.
 *
 * So the audio of an HLS source is cut from its segments first, and by ffmpeg alone only when that gives nothing:
 * the segments that hold the stretch are fetched here with the headers the resolve captured (picture.ts `hlsStretch`:
 * the stream's own audio rendition, else its smallest one; MPEG-TS cut at its sync, or fragmented MP4 behind its
 * `#EXT-X-MAP` part) and handed to ffmpeg on stdin, which trims to the second asked for. A source that is not HLS,
 * and an encrypted stream are cut by the plain cutter as before.
 */

const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SECOND = 32_000;
/** The whole second cut (playlists, segments, ffmpeg) fits in this. */
export const HLS_CUT_TIMEOUT_MS = 150_000;

export interface HlsCutOptions {
  ffmpegBin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The pause before a playlist or a segment that did not answer is asked for again. */
  retryMs?: number;
}

/** ffmpeg's arguments for a transport stream on stdin that begins `skipS` before the second asked for. */
export function hlsCutArgs(skipS: number, lengthS: number, out: string, format: 'mpegts' | 'mp4' = 'mpegts'): string[] {
  return [
    '-v', 'error', '-y',
    '-f', format, '-i', 'pipe:0',
    '-ss', String(Math.max(0, Math.round(skipS * 1000) / 1000)), '-t', String(lengthS),
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    out,
  ];
}

async function segmentCut(request: StretchRequest, options: HlsCutOptions, outer: AbortSignal): Promise<(StretchCut & { totalS?: number }) | null> {
  const source = request.hls;
  if (source === undefined) return null;
  const signal = AbortSignal.any([outer, AbortSignal.timeout(options.timeoutMs ?? HLS_CUT_TIMEOUT_MS)]);
  await rm(request.out, { force: true });
  let child: ReturnType<typeof spawn> | null = null;
  let ended: Promise<number | null> | null = null;
  try {
    // ffmpeg starts once the playlist is read: only then is it known where the first segment begins.
    const got = await hlsStretch(source, request.startS, request.lengthS, options.fetch ?? fetch, signal, async (part) => {
      if (child !== null) await writeTo(child, part);
    }, (fromS, format) => {
      child = spawn(options.ffmpegBin, hlsCutArgs(request.startS - fromS, request.lengthS, request.out, format), { stdio: ['pipe', 'ignore', 'ignore'], signal, killSignal: 'SIGKILL' });
      child.stdin?.on('error', () => undefined);
      child.on('error', () => undefined);
      const c = child;
      ended = new Promise((resolve) => c.on('close', (code) => resolve(code)));
    }, options.retryMs);
    const running = child as ReturnType<typeof spawn> | null;
    running?.stdin?.end();
    if (got === null) {
      running?.kill('SIGKILL');
      return null;
    }
    if (got.segments === 0) return { ok: true, lengthS: 0, totalS: got.totalS };
    await ended;
    const size = await stat(request.out).then((s) => s.size, () => 0);
    const lengthS = Math.max(0, size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND;
    if (lengthS <= 0) return null;
    return { ok: true, lengthS, totalS: got.totalS };
  } catch {
    (child as ReturnType<typeof spawn> | null)?.kill('SIGKILL');
    return null;
  }
}

/** Writes one part to ffmpeg's stdin, waiting while its pipe is full. ffmpeg stops reading once it has its stretch: that is not an error. */
function writeTo(child: ReturnType<typeof spawn>, part: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const stdin = child.stdin;
    if (stdin === null || stdin.destroyed || child.exitCode !== null) return resolve();
    if (stdin.write(part)) return resolve();
    const done = (): void => {
      stdin.off('drain', done);
      child.off('close', done);
      resolve();
    };
    stdin.once('drain', done);
    child.once('close', done);
  });
}

/**
 * For an HLS source (`request.hls`) the segments read here; `plain` for everything else, and for an HLS source whose
 * segments gave nothing (an encrypted stream, a host that refused them) or less than `plain` reads; a stretch that
 * stays incomplete is a failed cut, so nobody takes it for the film's end. The segments come
 * first because the playlist says where the film ends: on a host whose parts ffmpeg cannot seek in, a plain cut past
 * the end came back with the film's first minute.
 */
export function withHlsSegments(plain: AudioCutter, options: HlsCutOptions): AudioCutter {
  return async (request, signal) => {
    if (request.hls === undefined) return plain(request, signal);
    const first = await segmentCut(request, options, signal);
    if (first !== null && first.ok) {
      const left = first.totalS === undefined ? request.lengthS : Math.min(request.lengthS, first.totalS - request.startS);
      // All of the stretch, or all the film still holds from there (nothing, past its end).
      if (first.lengthS >= left - 1) return { ok: true, lengthS: first.lengthS };
    }
    if (signal.aborted) return { ok: false, reason: 'stopped' };
    const second = await plain(request, signal);
    if (second.ok && (first === null || !first.ok || second.lengthS > first.lengthS)) return second;
    // Part of the stretch only (a segment that did not answer): a failure, never a short cut, which reads as the film's end.
    if (first !== null && first.ok) return { ok: false, reason: `the stream host gave ${Math.round(first.lengthS)} s of the ${Math.round(request.lengthS)} s asked for` };
    return second;
  };
}
