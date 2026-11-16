import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CacheSubtitleView } from '../../cachePlay.js';
import type { SubtitleContext, SubtitleTier } from './chain.js';
import { cueFeedUrl, type CueFeed, type CueFeeds, type FeedCue } from './feed.js';

/**
 * The English subtitle track inside a torrent's video file (R3.4, R3.5). Subtitle packets are spread
 * through the whole file, so ffmpeg can give the cues only as far as the torrent has downloaded: the
 * extraction reads the file from its start, following the download, and each cue goes into a growing
 * feed the player page reads again until it is complete. A file complete on disk is read from its
 * path, at full speed. Only text tracks are used; a picture track (PGS, VobSub, DVB) is never
 * turned into text, and the chain goes on to the next tier.
 */

/** Subtitle codecs (ffprobe's names) ffmpeg turns into WebVTT. Every other one is never used: hdmv_pgs_subtitle, dvd_subtitle, dvb_subtitle and xsub are pictures. */
export const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set(['subrip', 'srt', 'webvtt', 'mov_text', 'text', 'ass', 'ssa']);
/** Among English tracks: plain SubRip first, ASS (often signs and songs) last. */
const CODEC_RANK: Readonly<Record<string, number>> = { subrip: 0, srt: 0, webvtt: 1, mov_text: 2, text: 3, ass: 4, ssa: 4 };

/** No byte from the file route for this long ends the extraction (a torrent released or stuck); the next play starts it again. */
export const EXTRACT_STALL_S = 300;
const STDERR_KEEP = 2_000;

/** A subtitle stream as phase 3's probe reads it. The last three are optional: without them SDH and forced tracks are told apart by their titles. */
export interface EmbeddedTrackInfo {
  /** ffprobe's stream index: what `-map 0:<index>` names. */
  index: number;
  codec: string;
  lang: string | null;
  title?: string | null;
  forced?: boolean;
  hearingImpaired?: boolean;
}

const ENGLISH = /^(en|eng)(?:[-_].*)?$/i;
const isEnglishTrack = (t: EmbeddedTrackInfo): boolean => (t.lang !== null && ENGLISH.test(t.lang.trim())) || /\benglish\b/i.test(t.title ?? '');
const isForced = (t: EmbeddedTrackInfo): boolean => t.forced === true || /\bforced\b/i.test(t.title ?? '');
const isSdh = (t: EmbeddedTrackInfo): boolean => t.hearingImpaired === true || /\b(sdh|cc|hearing)\b/i.test(t.title ?? '');

/**
 * The English text track to show: a full one before an SDH one, SubRip before ASS, then the first in
 * the file. A forced track (only the lines in another language) is taken only when it is the one
 * English text track. Picture tracks and tracks in other languages are never chosen.
 */
export function chooseEmbeddedTrack(tracks: readonly EmbeddedTrackInfo[]): EmbeddedTrackInfo | null {
  const english = tracks.filter((t) => TEXT_SUBTITLE_CODECS.has(t.codec.toLowerCase()) && isEnglishTrack(t));
  const full = english.filter((t) => !isForced(t));
  if (full.length === 0) return english.length === 1 ? (english[0] ?? null) : null;
  const rank = (t: EmbeddedTrackInfo): [number, number, number] => [isSdh(t) ? 1 : 0, CODEC_RANK[t.codec.toLowerCase()] ?? 9, t.index];
  const sorted = [...full].sort((a, b) => {
    const [a0, a1, a2] = rank(a);
    const [b0, b1, b2] = rank(b);
    return a0 - b0 || a1 - b1 || a2 - b2;
  });
  return sorted[0] ?? null;
}

const GENERIC_TITLE = /^(subtitles?|english|eng|en|und|default|track ?\d*)?$/i;

/** The menu's name for the track: its own title when it says something ("English SDH"), else "English". */
export function trackLabel(track: EmbeddedTrackInfo): string {
  const title = (track.title ?? '').trim();
  return title !== '' && !GENERIC_TITLE.test(title) ? title : 'English';
}

/** The feed name of a subtitle stream of one file of a torrent (a pack's episodes share the info hash). */
export const embeddedTrackId = (fileIndex: number, streamIndex: number): string => `embedded-${fileIndex}-${streamIndex}`;

const VTT_TIMING = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/;
const secondsOf = (h: string | undefined, m: string | undefined, s: string | undefined, ms: string | undefined): number =>
  Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0) + Number(ms ?? 0) / 1000;

/** One WebVTT block as a cue; null for the header, a NOTE, or a block without text. */
export function parseVttBlock(block: string): FeedCue | null {
  const lines = block.split('\n');
  const at = lines.findIndex((line) => line.includes('-->'));
  if (at === -1) return null;
  const m = VTT_TIMING.exec((lines[at] ?? '').trim());
  if (m === null) return null;
  const text = lines.slice(at + 1).join('\n').trim();
  if (text === '') return null;
  return { start_s: secondsOf(m[1], m[2], m[3], m[4]), end_s: secondsOf(m[5], m[6], m[7], m[8]), text };
}

/** ffmpeg's WebVTT on stdout, read as it comes: a cue is given once its block has ended (a blank line). */
export class VttCueReader {
  private rest = '';

  push(chunk: string): FeedCue[] {
    this.rest = (this.rest + chunk).replace(/\r/g, '');
    const blocks = this.rest.split(/\n{2,}/);
    this.rest = blocks.pop() ?? '';
    return blocks.map(parseVttBlock).filter((c): c is FeedCue => c !== null);
  }

  /** What is left when ffmpeg is done: the last block, when it had no blank line after it. */
  end(): FeedCue[] {
    const last = parseVttBlock(this.rest.trim());
    this.rest = '';
    return last === null ? [] : [last];
  }
}

/**
 * ffmpeg's arguments: one subtitle stream of `input` to WebVTT on stdout. `-copyts` keeps the file's
 * own times (without it every cue moves by the file's start, -0.023 s for an AAC track). Over HTTP a
 * response that ends early is asked again where it stopped, and a route that sends nothing for
 * `stallS` ends the run.
 */
export function extractArgs(input: string, streamIndex: number, stallS: number = EXTRACT_STALL_S): string[] {
  const overHttp = /^https?:\/\//.test(input);
  return [
    '-v', 'error', '-nostdin', '-copyts',
    ...(overHttp ? ['-reconnect', '1', '-reconnect_delay_max', '30', '-rw_timeout', String(stallS * 1_000_000)] : []),
    '-i', input,
    '-map', `0:${streamIndex}`,
    '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', 'pipe:1',
  ];
}

/** The part of a child process the extraction uses. Production: spawnExtractor. Tests: an EventEmitter with two PassThroughs. */
export interface ExtractorProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnExtractor = (bin: string, args: string[]) => ExtractorProcess;

export const spawnExtractor: SpawnExtractor = (bin, args) => spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

export interface EmbeddedSubtitlesOptions {
  /** `config.torrent.ffmpegBin`. */
  ffmpegBin: string;
  feeds: CueFeeds;
  /** What ffmpeg reads: the file's path once it is complete on disk, else its absolute file route on this daemon. */
  input: (infoHash: string, fileIndex: number) => Promise<string>;
  spawn?: SpawnExtractor;
  stallS?: number;
  log?: (line: string) => void;
}

export class EmbeddedSubtitles {
  /** The extraction of each torrent and track that is running, by `<hash>|<track>`. */
  private readonly running = new Map<string, Promise<CueFeed | null>>();
  readonly log: (line: string) => void;

  constructor(private readonly opts: EmbeddedSubtitlesOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * The feed of one subtitle stream of a torrent's file: a complete one kept from an earlier play,
   * the one an extraction is still filling, or a new extraction. Answers once ffmpeg has started
   * (not when it is done); null when it could not start.
   */
  feedOf(infoHash: string, fileIndex: number, track: EmbeddedTrackInfo): Promise<CueFeed | null> {
    const trackId = embeddedTrackId(fileIndex, track.index);
    const key = `${infoHash}|${trackId}`;
    const running = this.running.get(key);
    if (running !== undefined) return running;
    const started = this.begin(infoHash, fileIndex, track.index, trackId, () => this.running.delete(key));
    this.running.set(key, started);
    return started;
  }

  private async begin(infoHash: string, fileIndex: number, streamIndex: number, trackId: string, over: () => void): Promise<CueFeed | null> {
    const what = `the subtitle track ${streamIndex} of ${infoHash.slice(0, 8)}`;
    let feed: CueFeed;
    let input: string;
    try {
      const kept = await this.opts.feeds.get(infoHash, trackId);
      if (kept !== null && kept.isComplete) {
        over();
        return kept;
      }
      input = await this.opts.input(infoHash, fileIndex);
      feed = await this.opts.feeds.start(infoHash, trackId);
    } catch (err) {
      over();
      this.log(`[notesd] torrent: ${what} could not be extracted: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    let child: ExtractorProcess;
    try {
      child = (this.opts.spawn ?? spawnExtractor)(this.opts.ffmpegBin, extractArgs(input, streamIndex, this.opts.stallS));
    } catch (err) {
      over();
      this.log(`[notesd] torrent: ffmpeg did not start for ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const reader = new VttCueReader();
    let stderr = '';
    let ended = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      void feed.append(reader.push(chunk));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    const finish = (clean: boolean, why: string): void => {
      if (ended) return;
      ended = true;
      over();
      void feed.append(reader.end());
      if (clean) {
        void feed.complete();
        this.log(`[notesd] torrent: ${what} extracted, ${feed.size} cues`);
      } else {
        this.log(`[notesd] torrent: ${what} stopped after ${feed.size} cues (${why}); the next play starts it again`);
      }
    };
    return new Promise<CueFeed | null>((resolve) => {
      child.on('spawn', () => resolve(feed));
      child.on('error', (err) => {
        finish(false, err.message);
        resolve(null);
      });
      child.on('close', (code, signal) => {
        const last = stderr.trim().split('\n').pop() ?? '';
        finish(code === 0, code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}${last === '' ? '' : `: ${last}`}`);
        resolve(feed);
      });
    });
  }
}

/** What the embedded tier reads from phase 3's SubtitleContext. */
export type EmbeddedTierContext = Pick<SubtitleContext, 'infoHash' | 'fileIndex' | 'probe'>;

/**
 * The chain's `embedded` tier, after phase 6's files tier and before its service tier: the English
 * text track of the file as a growing subtitle, or nothing, and the chain goes on. A growing tier
 * (`blocks: false`): it answers once ffmpeg has started and is not counted in the chain's budget. It
 * does not read `ctx.signal`: an extraction ends by itself at the end of the file, when the file route
 * answers 409 `not_in_swarm` (the torrent left the swarm; it never rejoins), or after the 300 s stall.
 */
export function embeddedTier(subtitles: EmbeddedSubtitles): SubtitleTier {
  return {
    name: 'embedded',
    blocks: false,
    async find(ctx: EmbeddedTierContext): Promise<CacheSubtitleView[]> {
      const tracks = ctx.probe.subtitles;
      const track = chooseEmbeddedTrack(tracks);
      if (track === null) {
        const seen = tracks.map((t) => `${t.codec}/${t.lang ?? 'und'}`).join(', ') || 'none';
        subtitles.log(`[notesd] torrent: no English text subtitle track in ${ctx.infoHash.slice(0, 8)} (${seen}); the next subtitle tier is asked`);
        return [];
      }
      const feed = await subtitles.feedOf(ctx.infoHash, ctx.fileIndex, track);
      if (feed === null) return [];
      return [{ url: cueFeedUrl(ctx.infoHash, feed.track), lang: 'en', label: trackLabel(track), growing: true }];
    },
  };
}
