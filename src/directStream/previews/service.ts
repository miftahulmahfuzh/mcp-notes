import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FFMPEG_BIN, type Config } from '../../config.js';
import type { StreamCache } from '../cache/service.js';
import type { DirectStreamService } from '../service.js';
import type { StreamSession } from '../sessions.js';
import type { TorrentStreams } from '../torrent/service.js';
import { ffmpegPreviewSpawner, SheetBuilder, type SpawnPreview } from './builder.js';
import { isFile, keyTag, LocalSource } from './local.js';
import { covered, planSheets, SHEET_NAME, type SheetSpec } from './plan.js';
import { PreviewQueue } from './queue.js';
import { readSheets } from './sheetIndex.js';
import { previewSources } from './sources.js';
import { noPreviews, type LocalVideo, type PreviewList, type PreviewSource } from './types.js';

/** The session on screen is looked at again (what is on disk, what to make) at most this often. */
export const PREVIEW_LOOK_MS = 15_000;
/** The first sweep of the films on disk, after start. */
export const PREVIEW_SWEEP_FIRST_MS = 30_000;
/** Then this often. */
export const PREVIEW_SWEEP_MS = 30 * 60_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function signatureOf(list: PreviewList): string {
  return `${list.state}|${list.source ?? ''}|${list.cues.map((c) => `${c.start_s}:${c.end_s}:${c.url}:${c.x}:${c.y}`).join(',')}`;
}

const NONE_SIGNATURE = signatureOf(noPreviews());

/** The sheets of `video` not made yet whose whole stretch is on disk now. */
export async function missingSheets(video: LocalVideo): Promise<SheetSpec[]> {
  const done = new Set((await readSheets(video)).map((s) => s.index));
  const coverage = await video.coverage();
  return planSheets(video.durationS).filter((s) => !done.has(s.index) && covered(s, coverage));
}

export interface StreamPreviewsOptions {
  /** In the asking order (sources.ts). */
  sources: readonly PreviewSource[];
  builder: SheetBuilder;
  /** DirectStreamService.peek: a live session without marking it used. */
  peek: (id: string) => StreamSession | null;
  now?: () => number;
  log?: (line: string) => void;
  lookMs?: number;
  sweepFirstMs?: number;
  sweepMs?: number;
  retryMs?: number;
  maxTries?: number;
}

/**
 * Seek previews on this host (SEEK_PREVIEW_THUMBNAILS phase 1). Held in AppDeps.streamPreviews; the routes in
 * src/http/directStreamApi.ts read it, startBackground starts and closes it. A failure is a missing picture and one
 * log line: nothing here throws into a route or touches a play.
 */
export class StreamPreviews {
  private readonly locals: LocalSource[];
  private readonly queue: PreviewQueue;
  /** The last list each session was given, as a signature: a different one raises its previewRev. */
  private readonly shown = new WeakMap<StreamSession, string>();
  private readonly looked = new WeakMap<StreamSession, number>();
  private onScreen: string | null = null;
  private firstSweep: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly opts: StreamPreviewsOptions) {
    this.locals = opts.sources.filter((s): s is LocalSource => s instanceof LocalSource);
    this.queue = new PreviewQueue({
      builder: opts.builder,
      onMade: () => void this.refreshOnScreen(),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      log: (line) => this.log(line),
      ...(opts.retryMs === undefined ? {} : { retryMs: opts.retryMs }),
      ...(opts.maxTries === undefined ? {} : { maxTries: opts.maxTries }),
    });
  }

  /** Starts the sweeps of the films on disk. */
  start(): void {
    if (this.closed || this.firstSweep !== null) return;
    this.firstSweep = setTimeout(() => void this.sweep(), this.opts.sweepFirstMs ?? PREVIEW_SWEEP_FIRST_MS);
    this.firstSweep.unref();
    this.sweepTimer = setInterval(() => void this.sweep(), this.opts.sweepMs ?? PREVIEW_SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** Stops the sweeps and the running ffmpeg (keeping no part of its sheet). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.firstSweep !== null) clearTimeout(this.firstSweep);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    await this.queue.close();
  }

  /** GET /api/stream/sessions/:id/previews: the first list that is not `none`, the sources asked in order. */
  async list(session: StreamSession): Promise<PreviewList> {
    let list = noPreviews();
    for (const source of this.opts.sources) {
      let answer: PreviewList;
      try {
        answer = await source.list(session);
      } catch (err) {
        this.log(`[notesd] previews: the ${source.name} source failed for session ${session.id.slice(0, 6)}: ${messageOf(err)}`);
        continue;
      }
      if (answer.state !== 'none') {
        list = answer;
        break;
      }
    }
    const signature = signatureOf(list);
    if (signature !== (this.shown.get(session) ?? NONE_SIGNATURE)) session.previewRev += 1;
    this.shown.set(session, signature);
    return list;
  }

  /** A source says its list for `session` changed (PreviewSourceDeps.changed): list it again, in the background. Never throws. */
  changed(session: StreamSession): void {
    if (this.closed) return;
    void this.list(session).catch((err: unknown) => this.log(`[notesd] previews: could not list session ${session.id.slice(0, 6)} again: ${messageOf(err)}`));
  }

  /** GET /api/stream/sessions/:id/previews/:name: a sheet's bytes from the first local video of the session holding it (`tag`: its key). */
  async sheet(session: StreamSession, name: string, tag: string | null): Promise<Uint8Array | null> {
    if (!SHEET_NAME.test(name)) return null;
    for (const source of this.locals) {
      const video = await source.video(session);
      if (video === null || (tag !== null && keyTag(video.key) !== tag)) continue;
      const file = path.join(video.dir, name);
      if (!(await isFile(file))) continue;
      try {
        return await readFile(file);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** A position report of a page that is still open: the session is on screen; its previews come first. */
  reported(id: string): void {
    if (this.closed) return;
    const session = this.opts.peek(id);
    if (session === null) return;
    this.onScreen = id;
    const now = (this.opts.now ?? Date.now)();
    const last = this.looked.get(session);
    if (last !== undefined && now - last < (this.opts.lookMs ?? PREVIEW_LOOK_MS)) return;
    this.looked.set(session, now);
    void this.look(session).catch((err: unknown) => this.log(`[notesd] previews: could not look at session ${id.slice(0, 6)}: ${messageOf(err)}`));
  }

  /** Queues what the whole videos on disk lack, behind the session on screen's. Never throws; answers how many sheets were queued. */
  async sweep(): Promise<number> {
    let added = 0;
    let videos = 0;
    for (const source of this.locals) {
      for (const video of await source.whole()) {
        try {
          const sheets = await missingSheets(video);
          if (sheets.length === 0) continue;
          videos += 1;
          added += this.queue.want(video, sheets, false);
        } catch (err) {
          this.log(`[notesd] previews: could not look at ${video.key}: ${messageOf(err)}`);
        }
      }
    }
    if (added > 0) this.log(`[notesd] previews: ${added} sheet(s) of ${videos} film(s) on disk to make`);
    return added;
  }

  private async look(session: StreamSession): Promise<void> {
    for (const source of this.locals) {
      const video = await source.video(session);
      if (video === null) continue;
      this.queue.want(video, await missingSheets(video), true);
      break;
    }
    await this.list(session);
  }

  private async refreshOnScreen(): Promise<void> {
    const id = this.onScreen;
    const session = id === null ? null : this.opts.peek(id);
    if (session !== null) await this.list(session);
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }
}

/** What buildStreamPreviews reads of the daemon. */
export interface PreviewWiring {
  directStream: DirectStreamService | null;
  streamCache: StreamCache | null;
  torrents: TorrentStreams | null;
}

/** Test seams. */
export interface PreviewOverrides {
  spawn?: SpawnPreview;
  setPriority?: (pid: number, priority: number) => void;
  getPriority?: (pid: number) => number;
  probeDuration?: (file: string) => Promise<number | null>;
  now?: () => number;
  log?: (line: string) => void;
}

/** The daemon's seek previews, or null (nothing is built, the route answers no frame) with NOTESD_STREAM_PREVIEWS=off or without direct streaming. */
export function buildStreamPreviews(config: Config, wiring: PreviewWiring, overrides: PreviewOverrides = {}): StreamPreviews | null {
  const ds = config.directStream;
  const directStream = wiring.directStream;
  if (ds === undefined || ds.previews !== true || directStream === null) return null;
  const log = overrides.log ?? ((line: string) => console.log(line));
  const ffmpegBin = ds.ffmpegBin ?? DEFAULT_FFMPEG_BIN;
  // The sources are built before the service that lists them: their change hook reaches it through this holder.
  const holder: { previews: StreamPreviews | null } = { previews: null };
  const previews = new StreamPreviews({
    sources: previewSources({
      config,
      directStream,
      streamCache: wiring.streamCache,
      torrents: wiring.torrents,
      fetch: directStream.passThroughFetch,
      changed: (session) => holder.previews?.changed(session),
      log,
      ...(overrides.probeDuration === undefined ? {} : { probeDuration: overrides.probeDuration }),
    }),
    builder: new SheetBuilder({
      spawn: overrides.spawn ?? ffmpegPreviewSpawner(ffmpegBin),
      ffmpegBin,
      log,
      ...(overrides.setPriority === undefined ? {} : { setPriority: overrides.setPriority }),
      ...(overrides.getPriority === undefined ? {} : { getPriority: overrides.getPriority }),
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
    }),
    peek: (id) => directStream.peek(id),
    log,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  holder.previews = previews;
  return previews;
}
