import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config.js';
import type { StreamCacheRow } from '../../db/schema.js';
import { jsonError, type FetchLike } from '../passThrough.js';
import type { CacheStanding } from '../cachePlay.js';
import { cacheRef, type DirectStreamRepo } from '../repo.js';
import type { StreamSession } from '../sessions.js';
import { refLabel, type SourceAudio, type StreamRef } from '../types.js';
import { CacheJob, type CacheJobDeps, type CacheRecorder, type JobOutcome } from './job.js';
import { fileResponse } from './serve.js';
import { CacheStore, SERVED_NAME } from './store.js';
import { CACHE_ID_PATTERN, CacheError, CacheFailure, STREAM_CACHE_SUBDIR, type CacheMap, type StreamCacheView } from './types.js';

/** Downloads that run at once on this host; the rest wait their turn (`queued`). */
export const CACHE_JOBS = 1;
/** A cache the player started on a pause is cleared this long after it was last written. */
export const AUTO_CACHE_KEEP_MS = 3 * 24 * 3_600_000;

export interface StreamCacheOptions {
  repo: DirectStreamRepo;
  /** os.hostname(): rows are made under it, and only its rows' files are here. */
  host: string;
  /** The folder holding one folder per cache id. */
  root: string;
  /** DirectStreamService.resolve. */
  resolve: (ref: StreamRef) => Promise<StreamSession>;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  /** Files fetched at once per download (job.ts CACHE_PARALLEL). */
  parallel?: number;
  /** Downloads at once (CACHE_JOBS). */
  jobs?: number;
  /** A plain file's chunk size (plan.ts MP4_CHUNK_BYTES). */
  chunkBytes?: number;
}

/**
 * What a play (phase 6, src/directStream/cachePlay.ts CachePlayView) reads of a cache. Only a
 * cache whose source is known (provider and manifest kind set) is answered.
 */
export interface CachePlayData {
  id: string;
  ref: StreamRef;
  host: string;
  state: 'downloading' | 'ready' | 'failed';
  provider: string;
  height: number | null;
  manifestKind: 'hls' | 'mp4';
  manifestUrl: string;
  subtitles: { url: string; lang: string | null; label: string }[];
  audioLang: string | null;
  audio: SourceAudio | null;
}

interface Waiting {
  id: string;
  ref: StreamRef;
  maxHeight: number | null;
  /** Fetched for later (the next episode, ahead.ts): it gives way to a download the owner or a pause asks for. */
  ahead?: boolean;
  /** One file at a time: the episode on screen still streams from its host. */
  gentle?: boolean;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A setTimeout that an abort ends early (rejecting with the abort's reason). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The stream cache of this host (STREAM_CACHE_AND_BUG_REPORT phase 5): films and episodes
 * downloaded to `root`, recorded in stream_caches (through DirectStreamRepo). Downloads run one
 * at a time in the daemon (job.ts); a daemon start carries unfinished ones on (`start`). A row of
 * the other host is listed `available: false`; its files and its delete answer not_on_this_machine.
 * Held in AppDeps.streamCache; the routes (src/http/streamCacheApi.ts) and direct_stream_cache call it.
 */
export class StreamCache {
  private readonly repo: DirectStreamRepo;
  private readonly store: CacheStore;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly jobDeps: CacheJobDeps;
  private readonly jobsAtOnce: number;
  private waiting: Waiting[] = [];
  private readonly running = new Map<string, CacheJob>();
  /** The running downloads that were fetched ahead, and those among them told to give way (they queue again once stopped). */
  private readonly aheadRunning = new Map<string, Waiting>();
  private readonly yielded = new Set<string>();
  private readonly settling = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly opts: StreamCacheOptions) {
    this.repo = opts.repo;
    this.store = new CacheStore(opts.root);
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.jobsAtOnce = Math.max(1, opts.jobs ?? CACHE_JOBS);
    const recorder: CacheRecorder = {
      resolved: (id) => this.repo.cacheResolved(id, this.now()),
      planned: (id, planned) => this.repo.cachePlanned(id, planned, this.now()),
      progress: (id, done, bytes) => this.repo.cacheProgress(id, done, bytes, this.now()),
      subtitle: (id, saved) => this.repo.cacheSubtitle(id, saved, this.now()),
    };
    this.jobDeps = {
      store: this.store,
      recorder,
      resolve: opts.resolve,
      fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
      now: this.now,
      sleep: opts.sleep ?? abortableSleep,
      log: this.log,
      ...(opts.parallel === undefined ? {} : { parallel: opts.parallel }),
      ...(opts.chunkBytes === undefined ? {} : { chunkBytes: opts.chunkBytes }),
    };
  }

  get host(): string {
    return this.opts.host;
  }

  get root(): string {
    return this.opts.root;
  }

  /** Queues this host's unfinished downloads (a daemon start). Returns how many. */
  async start(): Promise<number> {
    await this.prune();
    const rows = await this.repo.unfinishedCaches(this.host);
    for (const row of rows) this.enqueue({ id: row.id, ref: cacheRef(row), maxHeight: row.maxHeight });
    return rows.length;
  }

  /** Stops every download (their rows stay `downloading` for the next start) and waits for them. */
  async close(): Promise<void> {
    this.closed = true;
    this.waiting = [];
    for (const job of this.running.values()) job.cancel();
    await Promise.allSettled([...this.settling.values()]);
  }

  /**
   * Caches `ref` on this host: a new row starts downloading; a failed one starts again from what
   * is on disk; a ready or running one is answered as it is (`started: false`). A different
   * `maxHeight` than the existing cache's throws `cache_exists` (clear it first). `ahead` marks a
   * download nobody waits for (the next episode): it gives way to any other; `gentle` fetches one
   * file at a time.
   */
  async request(ref: StreamRef, options: { maxHeight: number | null; auto?: boolean; ahead?: boolean; gentle?: boolean }): Promise<{ cache: StreamCacheView; started: boolean }> {
    if (this.closed) throw new Error('the stream cache is closing');
    const auto = options.auto === true;
    const { row, created } = await this.repo.createCache(this.host, ref, options.maxHeight, this.now(), auto);
    // The owner asks for a cache the player started: from now on it is theirs to clear.
    if (!created && !auto && row.auto) {
      await this.repo.cacheKept(row.id);
      row.auto = false;
    }
    if (!created && auto && row.auto) await this.repo.cacheTouched(row.id, this.now());
    await this.prune(row.id);
    if (!created && options.maxHeight !== null && row.maxHeight !== options.maxHeight) {
      throw new CacheError(
        'cache_exists',
        `This machine already holds ${refLabel(ref)} ${row.maxHeight === null ? 'at the highest quality' : `at ${row.maxHeight}p or below`}; clear that cache first to cache another quality.`,
        { cache: this.view(row) },
      );
    }
    if (row.state === 'ready') return { cache: this.view(row), started: false };
    if (row.state === 'failed') await this.repo.cacheRestarted(row.id, this.now());
    const started = this.enqueue({ id: row.id, ref, maxHeight: row.maxHeight, ...(options.ahead === true ? { ahead: true } : {}), ...(options.gentle === true ? { gentle: true } : {}) });
    return { cache: this.view((await this.repo.cacheById(row.id)) ?? row), started };
  }

  /**
   * Stops this host's download of `ref`, running or waiting, and keeps what is on disk: the row stays
   * `downloading`, so a play of it, another request or a daemon start carries it on. True when one was stopped.
   */
  async pause(ref: StreamRef): Promise<boolean> {
    const row = await this.repo.cacheFor(this.host, ref);
    if (row === null) return false;
    const queued = this.waiting.some((w) => w.id === row.id);
    this.waiting = this.waiting.filter((w) => w.id !== row.id);
    this.yielded.delete(row.id);
    const job = this.running.get(row.id);
    if (job === undefined) return queued;
    job.cancel();
    await this.settling.get(row.id);
    return true;
  }

  /**
   * Clears this host's caches the player started (`auto`) that nothing has written for
   * AUTO_CACHE_KEEP_MS, so a pause never fills the disk for good. A running download is left, and
   * so is `except` (the cache a request is about: a pause on an old one carries it on).
   * Never throws: a cache that cannot be cleared now is tried at the next request.
   */
  async prune(except: string | null = null): Promise<number> {
    let cleared = 0;
    try {
      const stale = await this.repo.staleAutoCaches(this.host, new Date(this.now().getTime() - AUTO_CACHE_KEEP_MS));
      for (const row of stale) {
        if (row.id === except || this.running.has(row.id) || this.waiting.some((w) => w.id === row.id)) continue;
        await this.store.remove(row.id);
        await this.repo.deleteCache(row.id);
        cleared += 1;
        this.log(`[notesd] stream cache: cleared ${refLabel(cacheRef(row))}, started by a pause and not touched for three days`);
      }
    } catch (err) {
      this.log(`[notesd] stream cache: could not clear old paused-play caches: ${messageOf(err)}`);
    }
    return cleared;
  }

  /**
   * The stretches of a cache that are on this host's disk, for the player's timeline. HLS: the video
   * playlist's segments whose files exist, by their EXTINF times. A plain file: the whole title once
   * it is ready (its chunks are not times). Null for an unknown cache or the other host's.
   */
  async map(id: string): Promise<CacheMap | null> {
    const row = await this.rowOf(id);
    if (row === null || row.host !== this.host) return null;
    if (row.manifestKind !== 'hls') {
      return { duration_s: row.durationS, ranges: row.state === 'ready' && row.durationS !== null ? [[0, row.durationS]] : [] };
    }
    let playlist: string;
    try {
      playlist = await readFile(this.store.file(row.id, 'video.m3u8'), 'utf8');
    } catch {
      return { duration_s: row.durationS, ranges: [] };
    }
    const names = await this.store.names(row.id);
    const ranges: [number, number][] = [];
    let at = 0;
    let length: number | null = null;
    for (const raw of playlist.split('\n')) {
      const line = raw.trim();
      const inf = /^#EXTINF:([\d.]+)/.exec(line);
      if (inf !== null) length = Number(inf[1]);
      else if (line !== '' && !line.startsWith('#') && length !== null) {
        const end = at + length;
        if (names.has(line)) {
          const last = ranges.at(-1);
          if (last !== undefined && Math.abs(last[1] - at) < 0.01) last[1] = end;
          else ranges.push([at, end]);
        }
        at = end;
        length = null;
      }
    }
    const round = (n: number): number => Math.round(n * 10) / 10;
    return { duration_s: row.durationS ?? round(at), ranges: ranges.map(([a, b]) => [round(a), round(b)]) };
  }

  /** Every cache of both hosts, newest first. */
  async list(): Promise<StreamCacheView[]> {
    return (await this.repo.caches()).map((row) => this.view(row));
  }

  /** The cache with this id on either host, or null (a malformed id included). */
  async get(id: string): Promise<StreamCacheView | null> {
    const row = await this.rowOf(id);
    return row === null ? null : this.view(row);
  }

  /** This host's cache of `ref` in any state, or null. */
  async find(ref: StreamRef): Promise<StreamCacheView | null> {
    const row = await this.repo.cacheFor(this.host, ref);
    return row === null ? null : this.view(row);
  }

  /** This host's cache of `ref` when it is complete, or null. */
  async findReady(ref: StreamRef): Promise<StreamCacheView | null> {
    const view = await this.find(ref);
    return view !== null && view.state === 'ready' ? view : null;
  }

  /** Every host's cache of `ref`. */
  async forRef(ref: StreamRef): Promise<StreamCacheView[]> {
    return (await this.repo.cachesOf(ref)).map((row) => this.view(row));
  }

  /** Phase 6's reads (cachePlay.ts PlayableCaches): `find` on this host, `get` on any host, as CachePlayData. */
  player(): {
    find(ref: StreamRef): Promise<CachePlayData | null>;
    get(id: string): Promise<CachePlayData | null>;
    start(ref: StreamRef): Promise<CacheStanding>;
    standing(ref: StreamRef): Promise<CacheStanding | null>;
    ahead(ref: StreamRef, options: { gentle: boolean }): Promise<{ started: boolean; state: string }>;
    pause(ref: StreamRef): Promise<boolean>;
  } {
    const standing = (view: StreamCacheView): CacheStanding => ({ id: view.id, state: view.state, error: view.error, progress: view.progress });
    return {
      start: async (ref) => standing((await this.request(ref, { maxHeight: null, auto: true })).cache),
      ahead: async (ref, options) => {
        const answer = await this.request(ref, { maxHeight: null, auto: true, ahead: true, gentle: options.gentle });
        return { started: answer.started, state: answer.cache.state };
      },
      pause: (ref) => this.pause(ref),
      standing: async (ref) => {
        const view = await this.find(ref);
        return view === null ? null : standing(view);
      },
      find: async (ref) => {
        const row = await this.repo.cacheFor(this.host, ref);
        return row === null ? null : this.playData(row);
      },
      get: async (id) => {
        const row = await this.rowOf(id);
        return row === null ? null : this.playData(row);
      },
    };
  }

  /** Stops the download, deletes the folder and the row. Throws unknown_cache, or not_on_this_machine for the other host's. */
  async remove(id: string): Promise<void> {
    const row = await this.rowOf(id);
    if (row === null) throw new CacheError('unknown_cache', 'No stream cache has this id.');
    if (row.host !== this.host) throw new CacheError('not_on_this_machine', `This cache was made on ${row.host}; clear it there.`, { host: row.host });
    this.waiting = this.waiting.filter((w) => w.id !== row.id);
    const job = this.running.get(row.id);
    if (job !== undefined) {
      job.cancel();
      await this.settling.get(row.id);
    }
    await this.store.remove(row.id);
    await this.repo.deleteCache(row.id);
    this.log(`[notesd] stream cache: cleared ${refLabel(cacheRef(row))}`);
  }

  /**
   * GET /api/stream/cache/:id/f/:name. A file on disk is served with Range. While the cache
   * downloads, a file not on disk yet is fetched now, ahead of the queue, and stored; a plain
   * file is answered chunk by chunk. 404 unknown_cache / not_on_this_machine / not_found,
   * 409 cache_failed, 502 upstream_error.
   */
  async file(id: string, name: string, request: { range: string | null }): Promise<Response> {
    const row = await this.rowOf(id);
    if (row === null) return jsonError(404, 'unknown_cache', 'No stream cache has this id.');
    if (row.host !== this.host) {
      return new Response(JSON.stringify({ error: 'not_on_this_machine', host: row.host, message: `This cache was made on ${row.host}; its files are only there.` }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (!SERVED_NAME.test(name)) return jsonError(404, 'not_found', 'A stream cache has no file of that name.');
    const onDisk = this.store.file(row.id, name);
    if (await this.store.has(row.id, name)) return fileResponse(onDisk, name, request.range);
    if (row.state === 'ready') return jsonError(404, 'not_found', 'That file is not part of this cache.');
    if (row.state === 'failed') return jsonError(409, 'cache_failed', `This cache stopped (${row.error ?? 'failed'}); ask for it again to carry on.`);
    if (this.closed) return jsonError(503, 'closing', 'The daemon is stopping.');
    const job = this.running.get(row.id) ?? this.launchNow(row);
    try {
      if (name === 'video.mp4') return await job.mp4Answer(request.range);
      await job.fetchNow(name);
    } catch (err) {
      return jsonError(502, 'upstream_error', `The file could not be fetched now: ${err instanceof CacheFailure ? `${err.code}: ${err.message}` : messageOf(err)}`);
    }
    return (await this.store.has(row.id, name)) ? fileResponse(onDisk, name, request.range) : jsonError(404, 'not_found', 'That file is not part of this cache.');
  }

  private async rowOf(id: string): Promise<StreamCacheRow | null> {
    return CACHE_ID_PATTERN.test(id) ? this.repo.cacheById(id.toLowerCase()) : null;
  }

  private enqueue(w: Waiting): boolean {
    if (this.closed || this.running.has(w.id) || this.waiting.some((x) => x.id === w.id)) return false;
    this.waiting.push(w);
    // A download somebody waits for comes before one fetched ahead: that one stops and queues again behind it.
    if (w.ahead !== true && this.running.size >= this.jobsAtOnce) {
      for (const id of this.aheadRunning.keys()) {
        if (this.yielded.has(id)) continue;
        this.yielded.add(id);
        this.running.get(id)?.cancel();
      }
    }
    this.pump();
    return true;
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.jobsAtOnce) {
      const next = this.waiting.shift();
      if (next === undefined) return;
      this.launch(next);
    }
  }

  /** The file route's turn for a cache that waits (or that no download serves): run it now, beside the others. */
  private launchNow(row: StreamCacheRow): CacheJob {
    this.waiting = this.waiting.filter((w) => w.id !== row.id);
    return this.launch({ id: row.id, ref: cacheRef(row), maxHeight: row.maxHeight });
  }

  private launch(w: Waiting): CacheJob {
    const job = new CacheJob(w.id, w.ref, w.maxHeight, w.gentle === true ? { ...this.jobDeps, parallel: 1 } : this.jobDeps);
    this.running.set(w.id, job);
    if (w.ahead === true) this.aheadRunning.set(w.id, w);
    const settled = job
      .run()
      .then((outcome) => this.settle(w, outcome))
      .catch((err: unknown) => this.log(`[notesd] stream cache: ${refLabel(w.ref)}: could not record how the download ended: ${messageOf(err)}`))
      .finally(() => {
        this.running.delete(w.id);
        this.settling.delete(w.id);
        this.aheadRunning.delete(w.id);
        if (this.yielded.delete(w.id) && !this.closed) this.waiting.push(w);
        this.pump();
      });
    this.settling.set(w.id, settled);
    return job;
  }

  private async settle(w: Waiting, outcome: JobOutcome): Promise<void> {
    const at = this.now();
    if (outcome.state === 'ready') {
      await this.repo.cacheReady(w.id, outcome, at);
      this.log(`[notesd] stream cache: ${refLabel(w.ref)} is cached (${outcome.segments} segments, ${Math.round(outcome.bytes / 1_048_576)} MB)`);
    } else if (outcome.state === 'failed') {
      await this.repo.cacheFailed(w.id, outcome.error, outcome.detail, at);
      this.log(`[notesd] stream cache: ${refLabel(w.ref)} stopped: ${outcome.error} (${outcome.detail})`);
    }
    // cancelled: the row stays `downloading` (a restart carries it on) unless it was cleared.
  }

  private view(row: StreamCacheRow): StreamCacheView {
    const live = this.running.get(row.id)?.progress() ?? null;
    const available = row.host === this.host;
    const total = live?.segmentsTotal ?? row.segmentsTotal;
    const done = live?.segmentsDone ?? row.segmentsDone;
    const base = `/api/stream/cache/${row.id}/f/`;
    return {
      id: row.id,
      kind: row.kind,
      tmdb_id: row.tmdbId,
      season: row.kind === 'tv' ? row.season : null,
      episode: row.kind === 'tv' ? row.episode : null,
      host: row.host,
      available,
      state: row.state,
      running: available && this.running.has(row.id),
      queued: available && this.waiting.some((w) => w.id === row.id),
      provider: row.provider,
      manifest_kind: row.manifestKind,
      height: row.height,
      max_height: row.maxHeight,
      audio_lang: row.audioLang,
      subtitle: row.subtitle,
      segments_total: total,
      segments_done: done,
      progress: total === 0 ? (row.state === 'ready' ? 1 : 0) : Math.round((done / total) * 1000) / 1000,
      bytes: live?.bytes ?? row.bytes,
      duration_s: row.durationS,
      resolves: row.resolves,
      error: row.error,
      error_detail: row.errorDetail,
      auto: row.auto,
      playlist_url: available && row.manifestKind !== null ? `${base}${row.manifestKind === 'hls' ? 'master.m3u8' : 'video.mp4'}` : null,
      subtitle_url: available && row.subtitle ? `${base}subtitle.vtt` : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      completed_at: row.completedAt === null ? null : row.completedAt.toISOString(),
    };
  }

  private playData(row: StreamCacheRow): CachePlayData | null {
    if (row.provider === null || row.manifestKind === null) return null;
    const base = `/api/stream/cache/${row.id}/f/`;
    return {
      id: row.id,
      ref: cacheRef(row),
      host: row.host,
      state: row.state,
      provider: row.provider,
      height: row.height,
      manifestKind: row.manifestKind,
      manifestUrl: `${base}${row.manifestKind === 'hls' ? 'master.m3u8' : 'video.mp4'}`,
      subtitles: row.subtitle ? [{ url: `${base}subtitle.vtt`, lang: 'en', label: 'English' }] : [],
      audioLang: row.audioLang,
      audio: null,
    };
  }
}

/** Test seams for buildStreamCache. */
export interface StreamCacheOverrides {
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's stream cache, or null without direct streaming. The folder is NOTESD_STREAM_CACHE_DIR,
 * else `<dataDir>/movies/stream-cache`; it is made when the first download starts.
 */
export function buildStreamCache(
  config: Config,
  directStream: { readonly host: string; resolve(ref: StreamRef, options: { resumeS?: number | null; vet?: boolean }): Promise<StreamSession> } | null,
  repo: DirectStreamRepo,
  overrides: StreamCacheOverrides = {},
): StreamCache | null {
  if (directStream === null) return null;
  return new StreamCache({
    repo,
    host: directStream.host,
    root: config.directStream?.cacheDir ?? path.join(config.dataDir, STREAM_CACHE_SUBDIR),
    // resumeS 0: a cache's resolve skips the resume hook (it opens no player).
    resolve: (ref) => directStream.resolve(ref, { resumeS: 0, vet: true }),
    ...overrides,
  });
}
