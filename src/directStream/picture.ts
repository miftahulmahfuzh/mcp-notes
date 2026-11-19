import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { refLabel, type ResolvedSource, type StreamRef } from './types.js';

/**
 * Looking at a stream before it plays. A resolve knows a stream's size, subtitles and (sometimes)
 * language, and nothing of what the picture looks like: The Shadow's Edge resolved to a "960p"
 * recording made in a cinema with a betting site's logo burned in, and then to a Hindi dub with
 * another. So the first time a provider's stream of a title is about to play, two frames are read
 * from it with ffmpeg (the manifest's address and the headers the resolve captured, as the
 * pass-through sends them) and one model call says whether the picture is a proper copy. The
 * verdict is kept per title and provider on this machine, so it is paid for once.
 *
 * Nothing here fails a play: a frame that cannot be read or a model that does not answer is
 * `unsure`, which plays.
 */

/** Seconds into the title the frames are read at: past the studio logos, and far enough apart to differ. */
export const PICTURE_FRAME_AT_S = [240, 900] as const;
export const PICTURE_FRAME_TIMEOUT_MS = 40_000;
export const PICTURE_JUDGE_TIMEOUT_MS = 60_000;
/** A rejected stream is looked at again after this long: a proper copy may have replaced it. */
export const PICTURE_BAD_TTL_MS = 14 * 24 * 3_600_000;
export const PICTURE_CLEAN_TTL_MS = 60 * 24 * 3_600_000;
export const PICTURE_VERDICTS_FILE = 'stream-pictures.json';
/** A stream no frame could be read from is not tried again for this long (remembered in memory only: a restart forgets it). */
export const PICTURE_UNREADABLE_MS = 6 * 3_600_000;
/** How long a stream no frame could be read from has to hand out the first bytes of a segment. */
export const PICTURE_REACH_TIMEOUT_MS = 10_000;

/** `recording`: filmed off a cinema screen. `watermark`: a logo or advert burned into the picture by whoever copied it. */
export type PictureVerdict = 'clean' | 'recording' | 'watermark' | 'unsure';

export const isBadPicture = (verdict: PictureVerdict): boolean => verdict === 'recording' || verdict === 'watermark';

export interface PictureFinding {
  verdict: PictureVerdict;
  /** One short line: what was seen ("1XBET logo top right"), or why nothing could be said. */
  reason: string;
}

export const PICTURE_SYSTEM_PROMPT = [
  'You check whether a video stream of a film or series is a proper copy. You are shown one or two still frames taken from it.',
  'Answer "watermark" when a logo, web address or advert was burned into the picture by whoever copied it: a betting or casino brand (1XBET, PariMatch, Melbet and the like), a pirate site name, a banner, usually in a corner or along an edge and unrelated to the scene.',
  'Answer "recording" when the picture was filmed off a cinema screen: soft or washed out, tilted or cropped unevenly, a visible screen edge, heads or seats in front, flicker bands.',
  'Answer "clean" when it is a proper copy. These do not make a copy bad: black bars, a dark or grainy scene, subtitles in any language, a studio or broadcaster logo, an age rating, and any text, screen, sign or logo that belongs to the scene itself.',
  'Answer "unsure" when the frames do not let you tell (a black frame, a title card).',
  'When the two frames disagree, a watermark or a recording in either one decides.',
  'Reply with one line of JSON and nothing else: {"verdict": "clean" | "watermark" | "recording" | "unsure", "reason": "<at most 12 words on what you saw>"}',
].join(' ');

/** Reads the model's one line of JSON; anything else is `unsure`. */
export function parsePictureAnswer(text: string): PictureFinding {
  const match = /\{[^{}]*\}/.exec(text);
  if (match !== null) {
    try {
      const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
      const verdict = parsed.verdict;
      if (verdict === 'clean' || verdict === 'recording' || verdict === 'watermark' || verdict === 'unsure') {
        return { verdict, reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '' };
      }
    } catch {
      // Not JSON after all.
    }
  }
  return { verdict: 'unsure', reason: 'the model did not answer in the asked form' };
}

/** One JPEG frame of the stream at `atS` seconds, or null when it could not be read. Never throws. */
export type FrameGrabber = (source: ResolvedSource, atS: number) => Promise<Buffer | null>;

/**
 * Frames through ffmpeg: it reads the manifest with the Referer, Origin and User-Agent the resolve
 * captured (what the pass-through sends for the player), seeks, and writes one frame scaled to 960
 * wide, which is plenty to see a logo and small enough for one cheap call.
 */
export function ffmpegFrameGrabber(options: { ffmpegBin: string; timeoutMs?: number }): FrameGrabber {
  return async (source, atS) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notesd-picture-'));
    const out = path.join(dir, 'frame.jpg');
    const { referer, origin, user_agent: userAgent } = source.headers;
    const headers = [referer === null ? null : `Referer: ${referer}`, origin === null ? null : `Origin: ${origin}`].filter((h): h is string => h !== null);
    const args = [
      '-v', 'error', '-y', '-ss', String(atS),
      ...(userAgent === null ? [] : ['-user_agent', userAgent]),
      ...(headers.length === 0 ? [] : ['-headers', headers.map((h) => `${h}\r\n`).join('')]),
      '-i', source.manifest_url, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', out,
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(options.ffmpegBin, args, { timeout: options.timeoutMs ?? PICTURE_FRAME_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err) => (err ? reject(err) : resolve()));
      });
      const frame = await readFile(out);
      return frame.length > 0 ? frame : null;
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Bytes of one segment read for a frame: a 10 s segment of a 1080p stream is a few MB. */
const SEGMENT_MAX_BYTES = 24 * 1024 * 1024;
/** Segments of one clip asked of a host at the same time. */
const SEGMENTS_AT_ONCE = 3;
/** How far into a segment an MPEG-TS sync is looked for: some hosts put a small picture file in front of it. */
const TS_SYNC_SEARCH_BYTES = 256 * 1024;

/** Where the MPEG-TS packets of a segment start: three sync bytes 188 apart; -1 when it is not a transport stream. */
export function tsSyncOffset(bytes: Uint8Array): number {
  const end = Math.min(bytes.length - 376, TS_SYNC_SEARCH_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) return i;
  }
  return -1;
}

/** The address of the segment that holds second `atS` of a media playlist (its last one for a shorter film), or null for a playlist without segments. */
export function segmentAt(playlist: string, base: string, atS: number): string | null {
  let at = 0;
  let length: number | null = null;
  let last: string | null = null;
  for (const raw of playlist.split('\n')) {
    const line = raw.trim();
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf !== null) length = Number(inf[1]);
    else if (line !== '' && !line.startsWith('#') && length !== null) {
      last = new URL(line, base).href;
      if (at + length > atS) return last;
      at += length;
      length = null;
    }
  }
  return last;
}

/** The addresses of up to `count` segments in a row, from the one that holds second `atS` (the last ones for a shorter film). */
export function segmentsFrom(playlist: string, base: string, atS: number, count: number): string[] {
  const all: Array<{ url: string; from: number; to: number }> = [];
  let at = 0;
  let length: number | null = null;
  for (const raw of playlist.split('\n')) {
    const line = raw.trim();
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf !== null) length = Number(inf[1]);
    else if (line !== '' && !line.startsWith('#') && length !== null) {
      all.push({ url: new URL(line, base).href, from: at, to: at + length });
      at += length;
      length = null;
    }
  }
  if (all.length === 0 || count < 1) return [];
  const first = all.findIndex((s) => s.to > atS);
  const start = first === -1 ? Math.max(0, all.length - count) : first;
  return all.slice(start, start + count).map((s) => s.url);
}

/** The first rendition a master playlist names, or null when `playlist` is a media playlist already. */
export function firstVariant(playlist: string, base: string): string | null {
  const lines = playlist.split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const uri = at === -1 ? undefined : lines.slice(at + 1).find((l) => l !== '' && !l.startsWith('#'));
  return uri === undefined ? null : new URL(uri, base).href;
}

/**
 * The rendition with the lowest BANDWIDTH a master playlist names, or null for a media playlist. The sound of every
 * rendition is the same, and its segments are a fraction of the tallest one's: what an audio clip is read from.
 */
export function lowestVariant(playlist: string, base: string): string | null {
  const lines = playlist.split('\n').map((l) => l.trim());
  let best: { uri: string; bandwidth: number } | null = null;
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines.slice(i + 1).find((l) => l !== '' && !l.startsWith('#'));
    if (uri === undefined) continue;
    const bandwidth = Number(/[:,]BANDWIDTH=(\d+)/.exec(line)?.[1] ?? Number.POSITIVE_INFINITY);
    if (best === null || bandwidth < best.bandwidth) best = { uri, bandwidth };
  }
  return best === null ? null : new URL(best.uri, base).href;
}

/** The segment that holds second `atS` of an HLS stream's first rendition, with the headers the resolve captured; null for a playlist without segments. Throws when a playlist does not answer. */
async function hlsSegment(source: ResolvedSource, atS: number, fetchImpl: typeof fetch, signal: AbortSignal, pick: (playlist: string, base: string) => string | null = firstVariant): Promise<{ segment: string; headers: Record<string, string>; encrypted: boolean; playlist: string; playlistUrl: string } | null> {
  const { referer, origin, user_agent: userAgent } = source.headers;
  const headers: Record<string, string> = { ...(referer === null ? {} : { referer }), ...(origin === null ? {} : { origin }), ...(userAgent === null ? {} : { 'user-agent': userAgent }) };
  const text = async (url: string): Promise<{ body: string; url: string }> => {
    const res = await fetchImpl(url, { headers, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { body: await res.text(), url: res.url || url };
  };
  let playlist = await text(source.manifest_url);
  const variant = pick(playlist.body, playlist.url);
  if (variant !== null) playlist = await text(variant);
  const segment = segmentAt(playlist.body, playlist.url, atS);
  return segment === null ? null : { segment, headers, encrypted: /#EXT-X-KEY:(?!METHOD=NONE)/.test(playlist.body), playlist: playlist.body, playlistUrl: playlist.url };
}

/**
 * The transport stream of up to `count` segments in a row from second `atS` of an HLS stream's smallest rendition, each
 * fetched with the headers the resolve captured and cut at its MPEG-TS sync (some hosts wrap every segment in a small
 * picture file). Null for anything but plain MPEG-TS: an encrypted stream, fragmented MP4, a playlist without
 * segments, a segment that does not answer or is larger than SEGMENT_MAX_BYTES. Throws when a playlist does not answer.
 */
export async function hlsTransportStream(source: ResolvedSource, atS: number, count: number, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Buffer | null> {
  if (source.manifest_kind !== 'hls') return null;
  const found = await hlsSegment(source, atS, fetchImpl, signal, lowestVariant);
  if (found === null || found.encrypted) return null;
  // Three at a time: one after another, eight segments took 18 s from a slow host; all eight at once, HyperLink's
  // host refused most of them and the clip came out 5 s long.
  const urls = segmentsFrom(found.playlist, found.playlistUrl, atS, count);
  const one = async (url: string): Promise<Buffer | null> => {
    const res = await fetchImpl(url, { headers: found.headers, signal });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > SEGMENT_MAX_BYTES) return null;
    const sync = tsSyncOffset(bytes);
    return sync === -1 ? null : Buffer.from(bytes.buffer, bytes.byteOffset + sync, bytes.length - sync);
  };
  const fetched: Array<Buffer | null> = [];
  for (let at = 0; at < urls.length; at += SEGMENTS_AT_ONCE) {
    const batch = await Promise.all(urls.slice(at, at + SEGMENTS_AT_ONCE).map(one));
    fetched.push(...batch);
    if (batch.includes(null)) break;
  }
  // The segments in a row up to the first that is missing: a gap would put two stretches of the film side by side.
  const gap = fetched.findIndex((part) => part === null);
  const parts = (gap === -1 ? fetched : fetched.slice(0, gap)) as Buffer[];
  return parts.length === 0 ? null : Buffer.concat(parts);
}

/** Whether a stream's host hands out the film: true when a segment of it answers with bytes. Never throws. */
export type StreamReach = (source: ResolvedSource, atS: number) => Promise<boolean>;

/**
 * The reach of an HLS stream: its playlists and the segment that holds the second are asked as the
 * frame grabber asks them, and the first bytes of the segment are enough. A stream ffmpeg cannot
 * decode here (fragmented MP4 in HEVC, an encrypted one) still reaches; one whose segments sit on a
 * host this network cannot get to does not. Anything but HLS is not asked and does not reach.
 */
export function hlsStreamReach(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): StreamReach {
  const fetchImpl = options.fetch ?? fetch;
  return async (source, atS) => {
    if (source.manifest_kind !== 'hls') return false;
    const signal = AbortSignal.timeout(options.timeoutMs ?? PICTURE_REACH_TIMEOUT_MS);
    try {
      const found = await hlsSegment(source, atS, fetchImpl, signal);
      if (found === null) return false;
      const res = await fetchImpl(found.segment, { headers: found.headers, signal });
      if (!res.ok || res.body === null) return false;
      const reader = res.body.getReader();
      const first = await reader.read();
      await reader.cancel().catch(() => undefined);
      return first.value !== undefined && first.value.length > 0;
    } catch {
      return false;
    }
  };
}

/**
 * Frames of an HLS stream ffmpeg cannot open by itself: the segment that holds the second is
 * fetched here and its transport stream handed to ffmpeg on stdin. Some hosts wrap every segment
 * in a small picture file (HyperLink's are PNGs on an image host): a browser's player finds the
 * transport stream behind it, ffmpeg sees a picture and stops. Encrypted segments are not read.
 */
export function hlsSegmentFrameGrabber(options: { ffmpegBin: string; fetch?: typeof fetch; timeoutMs?: number }): FrameGrabber {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PICTURE_FRAME_TIMEOUT_MS;
  return async (source, atS) => {
    if (source.manifest_kind !== 'hls') return null;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const found = await hlsSegment(source, atS, fetchImpl, signal);
      if (found === null || found.encrypted) return null;
      const res = await fetchImpl(found.segment, { headers: found.headers, signal });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > SEGMENT_MAX_BYTES) return null;
      const sync = tsSyncOffset(bytes);
      if (sync === -1) return null;
      return await new Promise<Buffer | null>((resolve) => {
        const child = execFile(
          options.ffmpegBin,
          ['-v', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
          { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => resolve(err || stdout.length === 0 ? null : stdout),
        );
        // ffmpeg stops reading once it has its frame: the rest of the segment is not an error.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(Buffer.from(bytes.buffer, bytes.byteOffset + sync, bytes.length - sync));
      });
    } catch {
      return null;
    }
  };
}

/** Each grabber in turn until one reads the frame. */
export function firstFrameOf(...grabbers: FrameGrabber[]): FrameGrabber {
  return async (source, atS) => {
    for (const grab of grabbers) {
      const frame = await grab(source, atS);
      if (frame !== null) return frame;
    }
    return null;
  };
}

/** The seam between a frame and a model. Production: createPictureJudge. Tests: a plain object. */
export interface PictureJudge {
  readonly model: string;
  /** Rejects when the model call fails or times out. */
  judge(frames: readonly Buffer[], title: string): Promise<PictureFinding>;
}

export interface PictureJudgeOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-picture`; created on first use, nothing is persisted there. */
  cwd: string;
  model: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Claude through the Agent SDK, as the story writer runs it (story.ts): the owner's login, no tools, one turn. Null without a claude binary. */
export function createPictureJudge(opts: PictureJudgeOptions): PictureJudge | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const timeoutMs = opts.timeoutMs ?? PICTURE_JUDGE_TIMEOUT_MS;

  function optionsFor(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      model: opts.model,
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      thinking: { type: 'disabled' },
      systemPrompt: PICTURE_SYSTEM_PROMPT,
      persistSession: false,
    };
  }

  return {
    model: opts.model,
    async judge(frames, title) {
      await mkdir(opts.cwd, { recursive: true });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
      timer.unref();
      const message: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            ...frames.map((frame) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: frame.toString('base64') } })),
            { type: 'text' as const, text: `${frames.length === 1 ? 'One frame' : `${frames.length} frames`} from a stream of ${title}. Is it a proper copy?` },
          ],
        },
        parent_tool_use_id: null,
      };
      let result: string | null = null;
      let failure: string | null = null;
      try {
        const prompt = (async function* oneMessage(): AsyncGenerator<SDKUserMessage> {
          yield message;
        })();
        for await (const event of query({ prompt, options: optionsFor(controller) })) {
          if (event.type !== 'result') continue;
          if (event.subtype === 'success' && !event.is_error) result = event.result;
          else if (event.subtype === 'success') failure = event.result.trim() || 'the model failed without saying why';
          else failure = event.errors.join('; ').trim() || `the model failed (${event.subtype})`;
        }
      } catch (err) {
        // A CLI that exits non-zero after its result still produced that result: trust it.
        if (result === null && failure === null) failure = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (result === null) throw new Error(failure ?? 'the model answered nothing');
      return parsePictureAnswer(result);
    },
  };
}

/** One kept verdict. */
export interface StoredPicture extends PictureFinding {
  provider: string;
  at: string;
  model: string;
}

const pictureKey = (ref: StreamRef, provider: string): string => `${refLabel(ref)}|${provider.toLowerCase()}`;

/**
 * This machine's verdicts, in one small JSON file beside the stream evidence log. A verdict is the
 * machine's own look at a stream, like a provider's health; it is not shared, and losing the file
 * only costs the calls again.
 */
export class PictureVerdicts {
  private loaded: Map<string, StoredPicture> | null = null;

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async all(): Promise<Map<string, StoredPicture>> {
    if (this.loaded !== null) return this.loaded;
    const map = new Map<string, StoredPicture>();
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, StoredPicture>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== null && typeof value === 'object' && typeof value.verdict === 'string' && typeof value.at === 'string') map.set(key, value);
      }
    } catch {
      // No file yet, or one that cannot be read: start empty.
    }
    this.loaded = map;
    return map;
  }

  private fresh(entry: StoredPicture): boolean {
    const age = this.now().getTime() - Date.parse(entry.at);
    return age >= 0 && age < (isBadPicture(entry.verdict) ? PICTURE_BAD_TTL_MS : PICTURE_CLEAN_TTL_MS);
  }

  /** The kept verdict of a provider's stream of a title, or null: never looked at, or too long ago. */
  async get(ref: StreamRef, provider: string): Promise<StoredPicture | null> {
    const entry = (await this.all()).get(pictureKey(ref, provider));
    return entry !== undefined && this.fresh(entry) ? entry : null;
  }

  /** The providers whose stream of this title was rejected and not looked at again since. */
  async badFor(ref: StreamRef): Promise<string[]> {
    const prefix = `${refLabel(ref)}|`;
    return [...(await this.all()).entries()].filter(([key, entry]) => key.startsWith(prefix) && isBadPicture(entry.verdict) && this.fresh(entry)).map(([, entry]) => entry.provider);
  }

  async set(ref: StreamRef, provider: string, finding: PictureFinding, model: string): Promise<void> {
    const map = await this.all();
    map.set(pictureKey(ref, provider), { ...finding, provider, at: this.now().toISOString(), model });
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(map), null, 1));
    await rename(tmp, this.file);
  }
}

/** One look at a stream. */
export interface PictureLook extends PictureFinding {
  /** The verdict was kept from an earlier look: no frame was read and no model asked. */
  kept: boolean;
  /**
   * Not one frame could be read from the stream (`unsure`) and its host did not hand out a segment
   * either. Such a stream seldom plays (HyperLink's segments on a host this network cannot reach),
   * so a play passes it over while another provider answers. Remembered for six hours in memory only.
   * A stream whose segment does answer is only one ffmpeg cannot decode: it is not unreadable, and plays.
   */
  unreadable: boolean;
}

/** A stream a play passes over for the next provider: a rejected picture, or one that could not be read at all. */
export const passesOver = (look: PictureLook): boolean => isBadPicture(look.verdict) || look.unreadable;

export interface PictureCheckOptions {
  verdicts: PictureVerdicts;
  grab: FrameGrabber;
  /** Asked when no frame could be read: whether the stream's host hands out a segment. Without it every such stream is unreadable. */
  reach?: StreamReach;
  judge: PictureJudge;
  frameAtS?: readonly number[];
  now?: () => Date;
  log?: (line: string) => void;
}

/** What the service asks: one stream's verdict (kept, or looked at now), and which providers to leave out from the start. */
export class PictureCheck {
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  /** `<title>|<provider>` -> { provider, until }: streams no frame could be read from lately. */
  private readonly unreadable = new Map<string, { provider: string; until: number }>();

  constructor(private readonly opts: PictureCheckOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.now = opts.now ?? (() => new Date());
  }

  /** The providers a play of `ref` leaves out from the start: a rejected picture, or a stream that could not be read lately. */
  async badFor(ref: StreamRef): Promise<string[]> {
    const kept = await this.opts.verdicts.badFor(ref).catch(() => [] as string[]);
    const prefix = `${refLabel(ref)}|`;
    const at = this.now().getTime();
    const unread = [...this.unreadable.entries()].filter(([key, entry]) => key.startsWith(prefix) && entry.until > at).map(([, entry]) => entry.provider);
    return [...kept, ...unread.filter((name) => !kept.includes(name))];
  }

  /**
   * The verdict of `source` for `ref`: the kept one, else frames and one model call. `unsure` is
   * never kept, so the next play looks again. `title` is what the model is told the frames are from.
   */
  async check(ref: StreamRef, source: ResolvedSource, title: string): Promise<PictureLook> {
    try {
      const kept = await this.opts.verdicts.get(ref, source.provider);
      if (kept !== null) return { verdict: kept.verdict, reason: kept.reason, kept: true, unreadable: false };
      const frames = (await Promise.all((this.opts.frameAtS ?? PICTURE_FRAME_AT_S).map((at) => this.opts.grab(source, at)))).filter((f): f is Buffer => f !== null);
      if (frames.length === 0) {
        const at = (this.opts.frameAtS ?? PICTURE_FRAME_AT_S)[0];
        if (this.opts.reach !== undefined && at !== undefined && (await this.opts.reach(source, at))) {
          // The 129 s detour of Fake Profile S02E01: VidNest's stream played well, and four other providers were asked first.
          this.unreadable.delete(pictureKey(ref, source.provider));
          this.log(`[notesd] direct stream: no frame of ${refLabel(ref)} could be decoded from ${source.provider}, whose host delivers it: it plays`);
          return { verdict: 'unsure', reason: 'no frame could be decoded, and the stream host delivers', kept: false, unreadable: false };
        }
        this.unreadable.set(pictureKey(ref, source.provider), { provider: source.provider, until: this.now().getTime() + PICTURE_UNREADABLE_MS });
        this.log(`[notesd] direct stream: no frame of ${refLabel(ref)} could be read from ${source.provider}`);
        return { verdict: 'unsure', reason: 'no frame could be read from the stream', kept: false, unreadable: true };
      }
      this.unreadable.delete(pictureKey(ref, source.provider));
      const finding = await this.opts.judge.judge(frames, title);
      this.log(`[notesd] direct stream: picture of ${refLabel(ref)} from ${source.provider}: ${finding.verdict}${finding.reason === '' ? '' : ` (${finding.reason})`}`);
      if (finding.verdict !== 'unsure') await this.opts.verdicts.set(ref, source.provider, finding, this.opts.judge.model);
      return { ...finding, kept: false, unreadable: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] direct stream: the picture of ${refLabel(ref)} from ${source.provider} could not be checked: ${reason}`);
      return { verdict: 'unsure', reason: reason.slice(0, 200), kept: false, unreadable: false };
    }
  }
}
