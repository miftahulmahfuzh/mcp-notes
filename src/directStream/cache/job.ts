import { readFile } from 'node:fs/promises';
import { jsonError, PLAYLIST_MAX_BYTES, type FetchLike } from '../passThrough.js';
import type { CachePlanned } from '../repo.js';
import { learn, type StreamSession } from '../sessions.js';
import { DirectStreamError, refLabel, type StreamRef } from '../types.js';
import { HlsUnsupported, isMaster, parseMaster, parseMedia, pickAudio, pickVariant, type HlsRendition, type HlsVariant } from './hls.js';
import { chunkName, hlsPlan, MP4_CHUNK_BYTES, mp4Plan, type CachePlan } from './plan.js';
import { parseRange } from './serve.js';
import type { CacheStore } from './store.js';
import { englishSubtitle } from './subtitle.js';
import { CacheFailure, type CacheFailureCode } from './types.js';
import { fetchUpstream, SEGMENT_MAX_BYTES } from './upstream.js';

/** Files fetched at once in one download. */
export const CACHE_PARALLEL = 4;
/** Tries of one file before the download fails (5 waits: 1, 2, 4, 8, 16 s). */
export const SEGMENT_ATTEMPTS = 6;
/** Fresh resolves in a row without a file downloaded in between; one more fails the download (token_refused). */
export const MAX_REFRESHES = 3;
/** Times the source may change shape under one download before it fails (source_changed). */
export const MAX_RESTARTS = 2;
/** Progress is written to the database at most this often. */
export const PROGRESS_FLUSH_MS = 2_000;

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
}

/** Where a download writes what it learns (StreamCache binds it to DirectStreamRepo; tests record it). */
export interface CacheRecorder {
  resolved(id: string): Promise<void>;
  planned(id: string, planned: CachePlanned): Promise<void>;
  progress(id: string, segmentsDone: number, bytes: number): Promise<void>;
  subtitle(id: string, saved: boolean): Promise<void>;
}

export interface CacheJobDeps {
  store: CacheStore;
  recorder: CacheRecorder;
  /** DirectStreamService.resolve: a fresh source for the title (the streaming Chrome, out of sight). */
  resolve: (ref: StreamRef) => Promise<StreamSession>;
  fetch: FetchLike;
  now: () => Date;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
  /** Default CACHE_PARALLEL. */
  parallel?: number;
  /** A plain file's chunk size; default MP4_CHUNK_BYTES. */
  chunkBytes?: number;
}

export type JobOutcome =
  | { state: 'ready'; segments: number; bytes: number; subtitle: boolean }
  | { state: 'failed'; error: CacheFailureCode; detail: string }
  | { state: 'cancelled' };

export interface JobProgress {
  segmentsDone: number;
  segmentsTotal: number;
  bytes: number;
}

interface Source {
  generation: number;
  session: StreamSession;
  plan: CachePlan;
}

/** The host refused a playlist or the probe: resolve again. */
class Refused extends Error {
  constructor(readonly what: string) {
    super(`the stream host refused ${what}`);
  }
}

/** A fresh resolve gave a source of another shape: the files on disk do not match it. */
class SourceChanged extends Error {
  constructor(
    readonly session: StreamSession,
    readonly plan: CachePlan,
  ) {
    super('the stream changed after a fresh resolve');
  }
}

/** Opens once the download knows its files; fails with the download. */
class Gate {
  readonly promise: Promise<void>;
  open: () => void = () => undefined;
  fail: (err: unknown) => void = () => undefined;
  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.open = resolve;
      this.fail = reject;
    });
    this.promise.catch(() => undefined);
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function failureOutcome(err: unknown): JobOutcome {
  if (err instanceof CacheFailure) return { state: 'failed', error: err.code, detail: err.message };
  if (err instanceof DirectStreamError) return { state: 'failed', error: err.code === 'no_source' ? 'no_source' : 'resolve_failed', detail: err.message };
  if (err instanceof Refused) return { state: 'failed', error: 'token_refused', detail: err.message };
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return { state: 'failed', error: 'disk_error', detail: messageOf(err) };
  return { state: 'failed', error: 'download_failed', detail: messageOf(err) };
}

/**
 * One cache's download on this host. `run()` resolves the title, turns the source into files
 * (plan.ts), compares them with what the folder already holds (a resume keeps every file whose
 * source has the same shape), writes the local playlists, then fetches the rest with up to
 * `parallel` at once. A file that fails is tried SEGMENT_ATTEMPTS times with backoff. A refused
 * token (401/403/410) resolves the title again, once for every file that saw it, and the download
 * carries on by index; MAX_REFRESHES fresh resolves without a file in between fail it. A new source
 * of another shape empties the folder and starts over (at most MAX_RESTARTS times).
 */
export class CacheJob {
  private readonly abort = new AbortController();
  private gate = new Gate();
  private source: Source | null = null;
  private lastPlan: CachePlan | null = null;
  private generation = 0;
  private present = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private refreshing: Promise<void> | null = null;
  private refreshes = 0;
  private restarts = 0;
  private counted = 0;
  private bytes = 0;
  private lastFlush = 0;
  /** Where in the plan's order the download goes on from: the file the player asked for last (fetchNow). */
  private cursor = 0;

  constructor(
    readonly id: string,
    readonly ref: StreamRef,
    readonly maxHeight: number | null,
    private readonly deps: CacheJobDeps,
  ) {}

  /** The download, start to end. Never throws: a stop is `cancelled`, a failure is `failed`. */
  async run(): Promise<JobOutcome> {
    let subtitle: Promise<boolean> | null = null;
    try {
      await this.deps.store.prepare(this.id);
      let next = await this.planFor(await this.resolveNow());
      for (;;) {
        await this.adopt(next.session, next.plan);
        subtitle ??= this.saveSubtitle(next.session);
        try {
          await this.downloadAll();
          break;
        } catch (err) {
          if (!(err instanceof SourceChanged)) throw err;
          this.restarts += 1;
          if (this.restarts > MAX_RESTARTS) throw new CacheFailure('source_changed', `the stream changed under the download ${this.restarts} times`);
          this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: the fresh source is not the one on disk; starting over`);
          await subtitle;
          subtitle = null;
          next = { session: err.session, plan: err.plan };
        }
      }
      const plan = this.current().plan;
      if (plan.kind === 'mp4' && !(await this.deps.store.has(this.id, 'video.mp4'))) await this.deps.store.join(this.id, plan.order, 'video.mp4');
      const saved = await (subtitle ?? Promise.resolve(false));
      return { state: 'ready', segments: plan.segmentsTotal, bytes: this.bytes, subtitle: saved };
    } catch (err) {
      this.gate.fail(err);
      if (subtitle !== null) await subtitle;
      if (this.abort.signal.aborted) return { state: 'cancelled' };
      return failureOutcome(err);
    }
  }

  /** Stops the download: requests in flight are aborted, nothing more is written. */
  cancel(): void {
    this.abort.abort(new Error('the stream cache download was cancelled'));
  }

  /** Counts for the routes' view; null until the source is known. */
  progress(): JobProgress | null {
    const plan = this.source?.plan ?? this.lastPlan;
    if (plan === null) return null;
    return { segmentsDone: this.counted + plan.gaps, segmentsTotal: plan.segmentsTotal, bytes: this.bytes };
  }

  /**
   * The file route's turn: waits for the source, then fetches `name` now (ahead of the queue, or
   * joining its fetch in flight) and stores it. Returns without fetching for a name the cache does
   * not download (a playlist, already on disk once the source is known). Throws what the fetch threw.
   */
  async fetchNow(name: string): Promise<void> {
    for (;;) {
      await this.gate.promise;
      const src = this.source;
      if (src === null) continue;
      if (!src.plan.files.has(name)) return;
      // The film is here now: the queue carries on from this file, not from where it was.
      const at = src.plan.order.indexOf(name);
      if (at >= 0) this.cursor = at;
      await this.ensure(name);
      return;
    }
  }

  /**
   * `GET .../f/video.mp4` while a plain file downloads: the chunk the range starts in is fetched now
   * if it is missing, and the answer is that range cut at the chunk's end (206; the player asks on).
   */
  async mp4Answer(rangeHeader: string | null): Promise<Response> {
    await this.gate.promise;
    const plan = this.current().plan;
    if (plan.kind !== 'mp4' || plan.size === null || plan.chunkBytes === null) return jsonError(404, 'not_found', 'This cache holds no plain file.');
    const size = plan.size;
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' } });
    const start = range?.start ?? 0;
    const index = Math.floor(start / plan.chunkBytes) + 1;
    const name = chunkName(index);
    await this.ensure(name);
    const chunk = await readFile(this.deps.store.file(this.id, name));
    const chunkStart = (index - 1) * plan.chunkBytes;
    const end = Math.min(range?.end ?? size - 1, chunkStart + chunk.length - 1);
    const body = new Uint8Array(chunk.subarray(start - chunkStart, end - chunkStart + 1));
    return new Response(body, {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(body.length),
        'cache-control': 'no-store',
      },
    });
  }

  private current(): Source {
    if (this.source === null) throw new Error('the stream cache download has no source yet');
    return this.source;
  }

  private async resolveNow(): Promise<StreamSession> {
    const session = await this.deps.resolve(this.ref);
    try {
      await this.deps.recorder.resolved(this.id);
    } catch (err) {
      this.deps.log(`[notesd] stream cache: could not count a resolve: ${messageOf(err)}`);
    }
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
    return session;
  }

  private bumpRefresh(why: string): void {
    this.refreshes += 1;
    if (this.refreshes > MAX_REFRESHES) throw new CacheFailure('token_refused', `the stream host kept refusing ${why} after ${MAX_REFRESHES} fresh resolves`);
  }

  /** A plan for `session`; a refused playlist resolves again (counted like any refresh). */
  private async planFor(session: StreamSession): Promise<{ session: StreamSession; plan: CachePlan }> {
    let current = session;
    for (;;) {
      try {
        return { session: current, plan: await this.makePlan(current) };
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        this.bumpRefresh(err.what);
        current = await this.resolveNow();
      }
    }
  }

  private async text(session: StreamSession, url: string): Promise<{ text: string; url: string }> {
    for (let attempt = 1; ; attempt += 1) {
      const got = await fetchUpstream(this.deps.fetch, session, url, { range: null, maxBytes: PLAYLIST_MAX_BYTES, signal: this.abort.signal });
      if (got.kind === 'ok') return { text: new TextDecoder().decode(got.body), url: got.url };
      if (got.kind === 'refused') throw new Refused(`a playlist (HTTP ${got.status})`);
      if (got.kind === 'retry' && attempt < SEGMENT_ATTEMPTS) {
        await this.deps.sleep(backoffMs(attempt), this.abort.signal);
        continue;
      }
      throw new CacheFailure('download_failed', `a playlist: ${got.detail}`);
    }
  }

  private async makePlan(session: StreamSession): Promise<CachePlan> {
    const src = session.source;
    if (src.manifest_kind === 'dash') throw new CacheFailure('cache_unsupported', `${src.provider} streams this title as DASH, which a cache does not hold`);
    if (src.manifest_kind === 'mp4') return this.mp4(session);
    try {
      const top = await this.text(session, src.manifest_url);
      let variant: HlsVariant | null = null;
      let rendition: HlsRendition | null = null;
      let independent = false;
      let videoText = top;
      if (isMaster(top.text)) {
        const master = parseMaster(top.text, top.url);
        for (const v of master.variants) learn(session, v.url);
        for (const m of master.media) if (m.url !== null) learn(session, m.url);
        variant = pickVariant(master.variants, this.maxHeight);
        rendition = pickAudio(master.media, variant.audioGroup, { track: src.audio?.track ?? null, lang: session.audioLang });
        independent = master.independentSegments;
        videoText = await this.text(session, variant.url);
      }
      const video = parseMedia(videoText.text, videoText.url);
      let audio = null;
      if (rendition !== null && rendition.url !== null) {
        const audioText = await this.text(session, rendition.url);
        audio = parseMedia(audioText.text, audioText.url);
      }
      const plan = hlsPlan({
        provider: src.provider,
        variant,
        audioRendition: audio === null ? null : rendition,
        video,
        audio,
        independentSegments: independent || video.independentSegments,
        bestHeight: src.best_height,
        audioLang: (audio === null ? null : rendition?.language) ?? session.audioLang,
      });
      for (const file of plan.files.values()) learn(session, file.url);
      return plan;
    } catch (err) {
      if (err instanceof HlsUnsupported) throw new CacheFailure('cache_unsupported', `${src.provider}: ${err.message}`);
      throw err;
    }
  }

  private async mp4(session: StreamSession): Promise<CachePlan> {
    const src = session.source;
    for (let attempt = 1; ; attempt += 1) {
      const got = await fetchUpstream(this.deps.fetch, session, src.manifest_url, { range: { offset: 0, length: 1 }, maxBytes: SEGMENT_MAX_BYTES, signal: this.abort.signal });
      if (got.kind === 'ok') {
        const total = /\/(\d+)\s*$/.exec(got.contentRange ?? '');
        const size = total === null ? 0 : Number(total[1]);
        if (got.status !== 206 || size <= 0) {
          throw new CacheFailure('cache_unsupported', `${src.provider} serves the film as one file without byte ranges, which a cache cannot resume`);
        }
        return mp4Plan({ provider: src.provider, url: got.url, size, chunkBytes: this.deps.chunkBytes ?? MP4_CHUNK_BYTES, bestHeight: src.best_height, audioLang: session.audioLang });
      }
      if (got.kind === 'refused') throw new Refused(`the film (HTTP ${got.status})`);
      if (got.kind === 'retry' && attempt < SEGMENT_ATTEMPTS) {
        await this.deps.sleep(backoffMs(attempt), this.abort.signal);
        continue;
      }
      throw new CacheFailure('download_failed', `the film: ${got.detail}`);
    }
  }

  /** Makes `plan` the source: drops a folder of another shape, writes meta and playlists, counts what is on disk. */
  private async adopt(session: StreamSession, plan: CachePlan): Promise<void> {
    const { store } = this.deps;
    const meta = await store.readMeta(this.id);
    if (meta !== null && meta.signature !== plan.signature) {
      this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: the files on disk came from another source (${meta.provider}); downloading again from ${plan.provider}`);
      await store.clear(this.id);
    }
    await store.writeMeta(this.id, { version: 1, signature: plan.signature, provider: plan.provider, kind: plan.kind });
    for (const p of plan.playlists) await store.write(this.id, p.name, p.text);
    const names = await store.names(this.id);
    const joined = plan.kind === 'mp4' && names.has('video.mp4');
    this.present = new Set();
    this.counted = 0;
    this.bytes = 0;
    for (const [name, file] of plan.files) {
      if (!joined && !names.has(name)) continue;
      this.present.add(name);
      if (file.counts) this.counted += 1;
      if (!joined) this.bytes += await store.size(this.id, name);
    }
    if (joined) this.bytes = await store.size(this.id, 'video.mp4');
    this.generation += 1;
    this.source = { generation: this.generation, session, plan };
    this.lastPlan = plan;
    this.lastFlush = this.deps.now().getTime();
    await this.deps.recorder.planned(this.id, {
      provider: plan.provider,
      manifestKind: plan.kind,
      height: plan.height,
      audioLang: plan.audioLang,
      segmentsTotal: plan.segmentsTotal,
      segmentsDone: this.counted + plan.gaps,
      bytes: this.bytes,
      durationS: plan.durationS,
    });
    this.gate.open();
  }

  private async downloadAll(): Promise<void> {
    const src = this.current();
    const order = src.plan.order;
    const taken = new Set<string>();
    // The next file not on disk, from the cursor on and around: a player that moved (fetchNow) is
    // followed, and what lies before it is fetched once the rest is in.
    const take = (): string | undefined => {
      for (let step = 0; step < order.length; step++) {
        const at = (this.cursor + step) % order.length;
        const name = order[at];
        if (name === undefined || taken.has(name) || this.present.has(name)) continue;
        taken.add(name);
        this.cursor = at;
        return name;
      }
      return undefined;
    };
    let failure: unknown = null;
    const worker = async (): Promise<void> => {
      while (failure === null && !this.abort.signal.aborted) {
        const name = take();
        if (name === undefined) return;
        try {
          await this.ensure(name);
        } catch (err) {
          failure ??= err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.deps.parallel ?? CACHE_PARALLEL) }, () => worker()));
    await Promise.allSettled([...this.inflight.values()]);
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
    if (failure !== null) throw failure;
    const missing = src.plan.order.filter((name) => !this.present.has(name)).length;
    if (missing > 0) throw new CacheFailure('download_failed', `${missing} file(s) were not downloaded`);
  }

  /** One fetch per file at a time: a second caller joins the first. */
  private ensure(name: string): Promise<void> {
    if (this.present.has(name)) return Promise.resolve();
    const running = this.inflight.get(name);
    if (running !== undefined) return running;
    const job = this.download(name).finally(() => {
      this.inflight.delete(name);
    });
    this.inflight.set(name, job);
    return job;
  }

  private async download(name: string): Promise<void> {
    let attempt = 1;
    for (;;) {
      if (this.source === null) await this.gate.promise;
      const src = this.current();
      const file = src.plan.files.get(name);
      if (file === undefined) return;
      const got = await fetchUpstream(this.deps.fetch, src.session, file.url, { range: file.range, maxBytes: SEGMENT_MAX_BYTES, signal: this.abort.signal });
      if (got.kind === 'ok') {
        // The source changed shape while this was in flight: the folder is about to be emptied.
        if (this.source === null || this.source.plan.signature !== src.plan.signature) return;
        await this.deps.store.write(this.id, name, got.body);
        this.present.add(name);
        this.bytes += got.body.length;
        if (file.counts) this.counted += 1;
        this.refreshes = 0;
        await this.flush();
        return;
      }
      if (got.kind === 'refused') {
        await this.refresh(src.generation, `${name} (HTTP ${got.status})`);
        continue;
      }
      if (got.kind === 'retry' && attempt < SEGMENT_ATTEMPTS) {
        await this.deps.sleep(backoffMs(attempt), this.abort.signal);
        attempt += 1;
        continue;
      }
      throw new CacheFailure('download_failed', `${name}: ${got.detail}${got.kind === 'retry' ? ` (${attempt} tries)` : ''}`);
    }
  }

  /** A fresh resolve for every file refused under `generation`, run once; later callers wait for it. */
  private refresh(generation: number, why: string): Promise<void> {
    const current = this.source;
    if (current === null) return this.gate.promise;
    if (current.generation !== generation) return Promise.resolve();
    this.refreshing ??= this.renew(current, why).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async renew(current: Source, why: string): Promise<void> {
    this.bumpRefresh(why);
    this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: the stream host refused ${why}; resolving again`);
    const { session, plan } = await this.planFor(await this.resolveNow());
    if (plan.signature === current.plan.signature) {
      this.generation += 1;
      this.source = { generation: this.generation, session, plan };
      return;
    }
    this.source = null;
    this.gate = new Gate();
    throw new SourceChanged(session, plan);
  }

  private async flush(): Promise<void> {
    const at = this.deps.now().getTime();
    if (at - this.lastFlush < PROGRESS_FLUSH_MS) return;
    this.lastFlush = at;
    const p = this.progress();
    if (p === null) return;
    try {
      await this.deps.recorder.progress(this.id, p.segmentsDone, p.bytes);
    } catch (err) {
      this.deps.log(`[notesd] stream cache: could not record progress: ${messageOf(err)}`);
    }
  }

  /** The English subtitle, once per download; never fails it. */
  private async saveSubtitle(session: StreamSession): Promise<boolean> {
    try {
      if (!(await this.deps.store.has(this.id, 'subtitle.vtt'))) {
        const vtt = await englishSubtitle(this.deps.fetch, session, this.abort.signal);
        if (vtt === null) return false;
        await this.deps.store.write(this.id, 'subtitle.vtt', vtt);
      }
      await this.deps.recorder.subtitle(this.id, true);
      return true;
    } catch (err) {
      if (!this.abort.signal.aborted) this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: no subtitle saved: ${messageOf(err)}`);
      return false;
    }
  }
}
