import { redactQueries } from '../evidence.js';
import { forward, readCapped, type FetchLike } from '../passThrough.js';
import { absoluteHttp, proxiedUrl } from '../rewrite.js';
import { learn, type StreamSession } from '../sessions.js';
import type { ResolvedSource, ThumbnailTrack } from '../types.js';
import type { PreviewSourceFactory } from './sources.js';
import type { PreviewCue, PreviewList, PreviewSource } from './types.js';

/**
 * A provider's own seek-preview track (SEEK_PREVIEW_THUMBNAILS phase 3, R1.4, R2.6). The resolver keeps the first
 * WebVTT request the provider's page made that names itself a thumbnail track (resolve.mjs thumbnailTrack, the
 * source's `thumbnails`). This source reads it once per session source, through the pass-through's host check and
 * with the headers that request carried, and lists its cues. A cue is a picture address with `#xywh=x,y,w,h`; the
 * page fetches its picture through the pass-through with `img=1`, which lets only image/* answers under a size
 * limit through and records them as kind `image`, never counted in a provider's delivery. The track itself is
 * fetched outside the evidence log: a track that cannot be fetched, is too big or names no picture is one log
 * line and no frame.
 *
 * A cue whose picture has no `#xywh` fragment (one whole picture per cue) is not listed: its rectangle is the
 * picture's own size, which only fetching every picture would tell, and a guessed one shows a wrong or cropped
 * frame. No frame (the page then shows the time alone) is the safe answer.
 */

/** A seek-preview track is one short line per frame: tens or hundreds of kilobytes. Past this it is not one. */
export const PROVIDER_TRACK_MAX_BYTES = 2 * 1024 * 1024;
/** The whole read of the track, headers and body. */
export const PROVIDER_TRACK_TIMEOUT_MS = 15_000;
/** How long list() waits for a track still being read before it answers without it (the change is told when it lands). */
export const PROVIDER_LIST_WAIT_MS = 3_000;
/** More cues than this are left out: one a second for five and a half hours. */
export const PROVIDER_MAX_CUES = 20_000;
/** A frame wider or taller than this is no thumbnail. */
const MAX_FRAME_PX = 4096;

const NONE: PreviewList = { state: 'none', source: null, cues: [] };

/** One picture cue of a track, its picture resolved against the track's address and without the fragment. */
export interface ThumbnailCue {
  start_s: number;
  end_s: number;
  /** Absolute http(s). */
  picture: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const XYWH = /^xywh=(?:pixel:)?(\d+),(\d+),(\d+),(\d+)$/i;

function seconds(stamp: string): number | null {
  const m = TIMESTAMP.exec(stamp.trim());
  if (m === null) return null;
  const [, h = '0', mm = '0', ss = '0', ms = '0'] = m;
  return Number(h) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000;
}

/**
 * The picture cues of a WebVTT seek-preview track, sorted by start, never overlapping (a cue that starts inside
 * the one before starts where that one ends; one wholly inside it is dropped). A cue without an `#xywh` fragment,
 * with a percent rectangle, an empty or oversized rectangle, a picture that is not http(s) or an end not after its
 * start is left out. Text that is not WebVTT has none.
 */
export function parseThumbnailCues(text: string, trackUrl: string, maxCues: number = PROVIDER_MAX_CUES): ThumbnailCue[] {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (!/^WEBVTT(?:[ \t]|$)/.test(lines[0] ?? '')) return [];
  const found: ThumbnailCue[] = [];
  for (let i = 1; i < lines.length && found.length < maxCues; i += 1) {
    const line = lines[i] ?? '';
    const arrow = line.indexOf('-->');
    if (arrow < 0) continue;
    const start = seconds(line.slice(0, arrow));
    const end = seconds(line.slice(arrow + 3).trim().split(/\s+/)[0] ?? '');
    const payload = (lines[i + 1] ?? '').trim();
    i += 1;
    if (start === null || end === null || !(end > start)) continue;
    const hash = payload.indexOf('#');
    if (hash <= 0) continue;
    const rect = XYWH.exec(payload.slice(hash + 1));
    if (rect === null) continue;
    const x = Number(rect[1]);
    const y = Number(rect[2]);
    const w = Number(rect[3]);
    const h = Number(rect[4]);
    if (w <= 0 || h <= 0 || w > MAX_FRAME_PX || h > MAX_FRAME_PX) continue;
    const picture = absoluteHttp(payload.slice(0, hash), trackUrl);
    if (picture === null) continue;
    found.push({ start_s: start, end_s: end, picture, x, y, w, h });
  }
  found.sort((a, b) => a.start_s - b.start_s);
  const out: ThumbnailCue[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const cue of found) {
    if (cue.end_s <= lastEnd) continue;
    out.push({ ...cue, start_s: Math.max(cue.start_s, lastEnd) });
    lastEnd = cue.end_s;
  }
  return out;
}

export interface ProviderPreviewOptions {
  /** The pass-through's fetch (DirectStreamService's; tests inject one). */
  fetch?: FetchLike;
  /** Told when this source's list for a session changed: frames arrived, or the frames it listed are gone. */
  onChange?: (session: StreamSession) => void;
  log?: (line: string) => void;
  maxBytes?: number;
  timeoutMs?: number;
  waitMs?: number;
}

interface Entry {
  /** The session's source this entry was made for: a refresh or a switch brings another, and with it another track (or none). */
  readonly source: ResolvedSource;
  /** Null while the track is being read. */
  list: PreviewList | null;
  done: Promise<void>;
}

const hasFrames = (list: PreviewList | null): boolean => list !== null && list.cues.length > 0;

/** The track a session's frames may come from: null for a cache's or a torrent's stand-in source (their frames come from the video on disk). */
function trackOf(session: StreamSession): ThumbnailTrack | null {
  if (session.cache !== null || session.torrent !== null) return null;
  return session.source.thumbnails ?? null;
}

function toPreviewCue(sessionId: string, cue: ThumbnailCue): PreviewCue {
  return { start_s: cue.start_s, end_s: cue.end_s, url: `${proxiedUrl(sessionId, cue.picture)}&img=1`, x: cue.x, y: cue.y, w: cue.w, h: cue.h };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export class ProviderPreviewSource implements PreviewSource {
  readonly name = 'provider' as const;
  private readonly entries = new WeakMap<StreamSession, Entry>();
  private readonly fetchImpl: FetchLike;
  private readonly onChange: (session: StreamSession) => void;
  private readonly log: (line: string) => void;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly waitMs: number;

  constructor(opts: ProviderPreviewOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.onChange = opts.onChange ?? (() => undefined);
    this.log = opts.log ?? ((line) => console.error(line));
    this.maxBytes = opts.maxBytes ?? PROVIDER_TRACK_MAX_BYTES;
    this.timeoutMs = opts.timeoutMs ?? PROVIDER_TRACK_TIMEOUT_MS;
    this.waitMs = opts.waitMs ?? PROVIDER_LIST_WAIT_MS;
  }

  /** The track's frames, `ready` and `provider`; `none` while there is no track, it is still being read, or it gave none. Never throws. */
  async list(session: StreamSession): Promise<PreviewList> {
    try {
      const track = trackOf(session);
      const had = this.entries.get(session);
      if (had !== undefined && (track === null || had.source !== session.source)) {
        this.entries.delete(session);
        if (hasFrames(had.list)) this.changed(session);
      }
      if (track === null) return NONE;
      const entry = this.entries.get(session) ?? this.start(session, track);
      if (entry.list === null && this.waitMs > 0) await Promise.race([entry.done, pause(this.waitMs)]);
      return entry.list ?? NONE;
    } catch (err) {
      this.log(`[notesd] previews: the provider source failed: ${redactQueries(err instanceof Error ? err.message : String(err))}`);
      return NONE;
    }
  }

  private start(session: StreamSession, track: ThumbnailTrack): Entry {
    const entry: Entry = { source: session.source, list: null, done: Promise.resolve() };
    this.entries.set(session, entry);
    entry.done = this.readCues(session, track)
      .then((cues) => {
        // A refresh or a switch replaced the source while the track was read: this answer is for a track the session no longer has.
        if (this.entries.get(session) !== entry) return;
        if (cues.length === 0) {
          entry.list = NONE;
          return;
        }
        for (const cue of cues) learn(session, cue.picture);
        entry.list = { state: 'ready', source: 'provider', cues: cues.map((cue) => toPreviewCue(session.id, cue)) };
        this.changed(session);
      })
      .catch(() => {
        entry.list = NONE;
      });
    return entry;
  }

  /** The track's picture cues; [] (and one log line, without the address) when it gives none. Never rejects. */
  private async readCues(session: StreamSession, track: ThumbnailTrack): Promise<ThumbnailCue[]> {
    const provider = session.source.provider;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response | null = null;
    const miss = async (reason: string): Promise<ThumbnailCue[]> => {
      await res?.body?.cancel().catch(() => undefined);
      this.log(`[notesd] previews: ${provider}'s preview track gives no frame: ${reason}`);
      return [];
    };
    const late = `it took longer than ${this.timeoutMs} ms`;
    try {
      res = await forward(session, { target: track.url, range: null, vtt: false, preview: 'track', signal }, this.fetchImpl);
      if (!res.ok) return await miss(signal.aborted ? late : `it answered ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (/^(?:text\/html|application\/xhtml|image\/|video\/|audio\/)/.test(type)) return await miss(`it answered ${type}`);
      if (Number(res.headers.get('content-length') ?? '0') > this.maxBytes) return await miss(`it is larger than ${this.maxBytes} bytes`);
      const text = await readCapped(res, this.maxBytes);
      if (text === null) return await miss(`it is larger than ${this.maxBytes} bytes`);
      const cues = parseThumbnailCues(text, track.url);
      return cues.length > 0 ? cues : await miss('it holds no picture cue');
    } catch {
      return miss(signal.aborted ? late : 'it could not be fetched');
    }
  }

  private changed(session: StreamSession): void {
    try {
      this.onChange(session);
    } catch {
      // A listener never fails a list.
    }
  }
}

/** The registry's provider source (sources.ts): the pass-through's fetch, and phase 1's change hook as `onChange`. */
export const providerSource: PreviewSourceFactory = (deps) => new ProviderPreviewSource({ fetch: deps.fetch, onChange: deps.changed, log: deps.log });
