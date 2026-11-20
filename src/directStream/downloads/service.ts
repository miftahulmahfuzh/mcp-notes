import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { StreamDownloadRow } from '../../db/schema.js';
import type { WarpSwitch } from '../../streaming/warp.js';
import type { StreamCache } from '../cache/service.js';
import { CacheError, type StreamCacheView } from '../cache/types.js';
import type { DirectStreamService } from '../service.js';
import type { SessionTorrent } from '../sessions.js';
import type { SwarmCount, TorrentCandidate } from '../torrent/find/index.js';
import type { TorrentSource } from '../torrent/source.js';
import type { TorrentStreams } from '../torrent/service.js';
import { normalizeInfoHash, PROGRESS_STEP_BYTES } from '../torrent/types.js';
import { refLabel, type ResolveAttempt, type StreamRef } from '../types.js';
import { bandAllows, CLOUD_MAX_HEIGHT, finalFailure, isOffice, planDownload, stepLabel, stepsAfterCloud, type CloudStep, type DownloadPlan, type DownloadStep, type StepFailure } from './plan.js';
import { DOWNLOAD_CANCELLED, downloadRef, DownloadsRepo, type DownloadOn, type DownloadRecords } from './repo.js';
import {
  DownloadError,
  type CacheNow,
  type DownloadAsk,
  type DownloadCaches,
  type DownloadFacts,
  type DownloadRequestAnswer,
  type DownloadState,
  type DownloadTorrents,
  type DownloadView,
  type KeptTorrentHandle,
  type TorrentFetch,
} from './types.js';

/** How often the engine looks at what it downloads (progress, a play on screen, a cache's end). */
export const DOWNLOAD_TICK_MS = 5_000;
/** A torrent download carried on by its info hash (a pause, a restart) whose swarm gave nothing is tried this many times. */
export const DOWNLOAD_RESUME_TRIES = 3;
/** ...this far apart. */
export const DOWNLOAD_RETRY_MS = 60_000;
/** The SSID is read once a minute at most (warp.mjs runs a Windows program). */
export const SSID_TTL_MS = 60_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const share = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

export interface StreamDownloadsOptions {
  /** os.hostname(): rows are made and read under it. */
  host: string;
  repo: DownloadRecords;
  /** Null with torrents off. */
  torrents: DownloadTorrents | null;
  /** Null without the stream cache. */
  caches: DownloadCaches | null;
  /** The Wi-Fi network's name, or null (none, or it could not be read). Only ever read: a download never switches WARP. */
  ssid: () => Promise<string | null>;
  /** The info hashes of the torrents playing on screen now (DirectStreamService.torrentsOnScreen). */
  playingTorrents: () => readonly string[];
  /** Told when a download is whole: the seek previews' sweep queues its sheets. */
  afterDone?: () => void;
  now?: () => Date;
  log?: (line: string) => void;
  /** Runs `fn` every `ms`; answers how to stop it. Default setInterval, unref'd. Tests pass a no-op and call tick(). */
  every?: (fn: () => void, ms: number) => () => void;
}

/** The one download fetching from a torrent (or being planned) now. */
interface Job {
  readonly id: string;
  readonly ref: StreamRef;
  handle: KeptTorrentHandle | null;
  /** Cancelled, paused or closed: whatever its run finds now is let go. */
  stopped: boolean;
  remuxRetried: boolean;
  lastBytes: number;
  /** The torrent a carried-on download fetched before (its kept mark is cleared if it fails for good). */
  readonly sourceHash: string | null;
}

/** A download handed to the stream cache, followed until the cache is ready or failed. */
interface CloudFollow {
  ref: StreamRef;
  step: CloudStep;
  /** What it goes on to when the cache fails (auto: a torrent below 1080p). */
  after: DownloadStep[];
  failures: StepFailure[];
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * Downloads the owner asks for (stream-downloads phase 2), held in AppDeps.streamDownloads; phase 4's routes and tool
 * call request, list and cancel. One torrent download at a time; a cloud download is handed to the stream cache, whose
 * own queue runs it. A torrent download gives way to a torrent playing on screen (paused, carried on when the play
 * ends). What a start finds queued, running or paused carries on from what is on disk.
 */
export class StreamDownloads {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly every: (fn: () => void, ms: number) => () => void;
  private job: Job | null = null;
  private current: Promise<void> | null = null;
  private readonly clouds = new Map<string, CloudFollow>();
  /** Steps left after a cache failed, for the row's next run. */
  private readonly pending = new Map<string, { steps: DownloadStep[]; failures: StepFailure[] }>();
  private readonly retries = new Map<string, { tries: number; at: number }>();
  private tickRun: Promise<void> | null = null;
  private tickAgain = false;
  private stopTimer: (() => void) | null = null;
  private closed = false;

  constructor(private readonly opts: StreamDownloadsOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.every = opts.every ?? defaultEvery;
  }

  get host(): string {
    return this.opts.host;
  }

  /**
   * Queues one film or episode and answers at once. A title already whole on this machine queues nothing (`onDisk`); a
   * slot already queued, running or paused is answered as it is (`created: false`). Throws DownloadError
   * `invalid_request` (a malformed info hash, or one without `via: torrent`) or `downloads_off` (the daemon stops).
   */
  async request(ref: StreamRef, ask: DownloadAsk): Promise<DownloadRequestAnswer> {
    if (this.closed) throw new DownloadError('downloads_off', 'The daemon is stopping.');
    const infoHash = ask.infoHash == null ? null : normalizeInfoHash(ask.infoHash);
    if (ask.infoHash != null && infoHash === null) throw new DownloadError('invalid_request', 'An info hash is 40 hexadecimal characters.');
    if (infoHash !== null && ask.via !== 'torrent') throw new DownloadError('invalid_request', 'A torrent picked by its info hash is downloaded with via "torrent".');
    if (await this.onDisk(ref)) return { download: null, created: false, onDisk: true };
    const { row, created } = await this.opts.repo.create(this.host, { ref, via: ask.via, infoHash, batch: ask.batch ?? null }, this.now());
    if (created) this.log(`[notesd] downloads: queued ${refLabel(ref)} (${ask.via}${infoHash === null ? '' : ` ${infoHash.slice(0, 8)}`})`);
    void this.tick();
    return { download: await this.viewOf(row), created, onDisk: false };
  }

  /**
   * Stops a download that is not finished: its torrent is let go and loses the owner's mark (unless another download
   * keeps it), a cloud download's cache stops with what it has on disk. The row is failed with `cancelled` and leaves
   * the list. A finished or failed one is answered as it is. Throws DownloadError `unknown_download`.
   */
  async cancel(id: string): Promise<DownloadView> {
    const row = await this.opts.repo.get(this.host, id);
    if (row === null) throw new DownloadError('unknown_download', 'No download of this machine has this id.');
    if (row.state === 'done' || row.state === 'failed') return this.viewOf(row);
    const ref = downloadRef(row);
    const job = this.job;
    if (job !== null && job.id === id) {
      this.job = null;
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
    }
    if (this.clouds.delete(id)) await this.opts.caches?.pause(ref).catch(() => false);
    this.pending.delete(id);
    this.retries.delete(id);
    const cancelled = await this.opts.repo.cancel(this.host, id, this.now());
    if (row.source === 'torrent' && row.sourceId !== null) await this.unkeep(row.sourceId, id);
    this.log(`[notesd] downloads: cancelled ${refLabel(ref)}`);
    void this.tick();
    return this.viewOf(cancelled ?? row);
  }

  /**
   * This host's downloads not finished (queued, running, paused, failed; a cancelled one is left out), in the queue's
   * order, with live progress. With a title filter (the title page) also that title's finished downloads: the latest
   * `done` row per film or episode, and only while that film or episode is still whole here (one deleted on the Cache
   * page is no longer "on this machine"). Without a filter no `done` row is listed.
   */
  async list(filter?: { kind: 'movie' | 'tv'; tmdbId: number }): Promise<DownloadView[]> {
    const title = filter === undefined ? {} : { kind: filter.kind, tmdbId: filter.tmdbId };
    const open = (await this.opts.repo.list(this.host, { ...title, states: ['queued', 'running', 'paused', 'failed'] })).filter((r) => r.error !== DOWNLOAD_CANCELLED);
    const done: StreamDownloadRow[] = [];
    if (filter !== undefined) {
      const latest = new Map<string, StreamDownloadRow>();
      for (const r of await this.opts.repo.list(this.host, { ...title, states: ['done'] })) latest.set(`${r.season}x${r.episode}`, r);
      for (const r of latest.values()) if (await this.onDisk(downloadRef(r))) done.push(r);
    }
    return Promise.all([...open, ...done].map((r) => this.viewOf(r)));
  }

  /** A daemon start: what was queued, running or paused is queued again and carried on from what is on disk. Returns how many. */
  async start(): Promise<number> {
    const rows = await this.opts.repo.toResume(this.host, this.now());
    this.stopTimer ??= this.every(() => void this.tick(), DOWNLOAD_TICK_MS);
    void this.tick();
    return rows.length;
  }

  /** Lets go of the torrent held (its row stays running: the next start carries it on). Waits for nothing that runs long. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopTimer?.();
    this.stopTimer = null;
    const job = this.job;
    this.job = null;
    if (job !== null) {
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
    }
    this.clouds.clear();
  }

  /** One look: play first, the torrent held, the caches followed, the next download started. One at a time; an ask meanwhile runs once more after. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.tickRun !== null) {
      this.tickAgain = true;
      return this.tickRun;
    }
    const run = (async () => {
      try {
        do {
          this.tickAgain = false;
          await this.tickOnce();
        } while (this.tickAgain && !this.closed);
      } finally {
        this.tickRun = null;
      }
    })();
    this.tickRun = run;
    return run;
  }

  /** Resolves once no look and no download start runs (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const waiting = [this.tickRun, this.current].filter((p): p is Promise<void> => p !== null);
      if (waiting.length === 0) return;
      await Promise.all(waiting);
    }
  }

  private async tickOnce(): Promise<void> {
    try {
      await this.playFirst();
      await this.followTorrent();
      await this.followClouds();
      await this.startNext();
    } catch (err) {
      this.log(`[notesd] downloads: ${messageOf(err)}`);
    }
  }

  /** A torrent playing on screen (another than the one downloaded): the torrent download lets go of its swarm and waits. */
  private async playFirst(): Promise<void> {
    const job = this.job;
    const handle = job?.handle ?? null;
    if (job === null || handle === null) return;
    if (!this.opts.playingTorrents().some((hash) => hash !== handle.infoHash)) return;
    this.job = null;
    job.stopped = true;
    this.opts.torrents?.release(handle);
    await this.opts.repo.setState(this.host, job.id, 'paused', this.now());
    this.log(`[notesd] downloads: paused ${refLabel(job.ref)} (${handle.name}): a torrent plays on screen; it carries on when the play ends`);
  }

  /** The torrent held: its progress written, and once its file, remux and subtitle search are done it is let go, finished. */
  private async followTorrent(): Promise<void> {
    const job = this.job;
    const torrents = this.opts.torrents;
    const handle = job?.handle ?? null;
    if (job === null || handle === null || torrents === null) return;
    const now = await torrents.now(handle);
    if (this.job !== job) return;
    if (Math.abs(now.bytesDone - job.lastBytes) >= PROGRESS_STEP_BYTES || (now.file === 'whole' && now.bytesDone !== job.lastBytes)) {
      job.lastBytes = now.bytesDone;
      await this.opts.repo.progress(this.host, job.id, now.bytesDone, now.bytesTotal, this.now());
    }
    if (now.file !== 'whole') return;
    if (now.remux === 'failed' && !job.remuxRetried) {
      job.remuxRetried = true;
      await torrents.retryRemux(handle);
      return;
    }
    if (now.remux === 'running' || now.subtitles === 'searching') return;
    if (this.job !== job) return;
    this.job = null;
    torrents.release(handle);
    const on: DownloadOn = { source: 'torrent', infoHash: handle.infoHash };
    await this.opts.repo.done(this.host, job.id, on, { bytesDone: now.bytesTotal ?? now.bytesDone, bytesTotal: now.bytesTotal }, this.now());
    this.log(
      `[notesd] downloads: ${refLabel(job.ref)} is on this machine (${handle.name})${now.remux === 'failed' ? '; its remux failed twice, a play remuxes it from disk' : ''}`,
    );
    this.opts.afterDone?.();
  }

  /** Each download handed to the cache: finished when it is ready; on to the next step (or failed) when it failed. */
  private async followClouds(): Promise<void> {
    const caches = this.opts.caches;
    if (caches === null) return;
    for (const [id, follow] of [...this.clouds]) {
      let cache: CacheNow | null;
      try {
        cache = await caches.find(follow.ref);
      } catch (err) {
        this.log(`[notesd] downloads: could not read the cache of ${refLabel(follow.ref)}: ${messageOf(err)}`);
        continue;
      }
      if (!this.clouds.has(id)) continue;
      if (cache === null) {
        // Its cache was deleted on the Cache page while it downloaded.
        this.clouds.delete(id);
        await this.opts.repo.failed(this.host, id, DOWNLOAD_CANCELLED, 'its cache was deleted', this.now());
        continue;
      }
      if (cache.state === 'ready') {
        this.clouds.delete(id);
        await this.finishCloud(id, follow.ref, cache);
        continue;
      }
      if (cache.state === 'failed') {
        this.clouds.delete(id);
        const failures = [...follow.failures, { step: follow.step, error: cache.error ?? 'download_failed', detail: cache.errorDetail ?? '' }];
        if (follow.after.length > 0) {
          this.pending.set(id, { steps: follow.after, failures });
          await this.opts.repo.setState(this.host, id, 'queued', this.now());
          this.log(`[notesd] downloads: the cloud cache of ${refLabel(follow.ref)} failed (${cache.error ?? 'failed'}); ${stepLabel(follow.after[0]!)} next`);
        } else {
          await this.fail(id, follow.ref, failures, null);
        }
        continue;
      }
      // Downloading: a cache neither running nor queued was stopped (a restart of the cache, the ahead rules): asked again.
      if (!cache.running && !cache.queued) await caches.request(follow.ref, follow.step.maxHeight).catch((err: unknown) => this.log(`[notesd] downloads: could not carry on the cache of ${refLabel(follow.ref)}: ${messageOf(err)}`));
      await this.opts.repo.progress(this.host, id, cache.bytes, null, this.now());
    }
  }

  /** The oldest queued or paused download whose first step can run now, started behind this look. */
  private async startNext(): Promise<void> {
    if (this.job !== null || this.closed) return;
    const rows = (await this.opts.repo.list(this.host, { states: ['queued', 'paused'] })).filter((r) => !this.clouds.has(r.id));
    if (rows.length === 0) return;
    const at = this.now().getTime();
    const playing = this.opts.playingTorrents().length > 0;
    let office: boolean | null = null;
    for (const row of rows) {
      if (this.job !== null || this.closed) return;
      if ((this.retries.get(row.id)?.at ?? 0) > at) continue;
      office ??= isOffice(await this.opts.ssid());
      const resumeHash = row.source === 'torrent' ? row.sourceId : null;
      // A torrent download carried on waits off the office network: nothing there reaches its peers.
      if (resumeHash !== null && office) continue;
      const plan = this.planOf(row, office);
      if (!plan.ok) {
        await this.fail(row.id, downloadRef(row), [{ step: null, error: plan.error, detail: plan.detail }], null);
        continue;
      }
      // Play first: a torrent download does not start while a torrent plays on screen; a cloud one does.
      if (playing && plan.steps[0]!.kind !== 'cloud') continue;
      const job: Job = { id: row.id, ref: downloadRef(row), handle: null, stopped: false, remuxRetried: false, lastBytes: row.bytesDone, sourceHash: resumeHash };
      this.job = job;
      const before = this.pending.get(row.id)?.failures ?? [];
      this.pending.delete(row.id);
      const run = this.run(job, plan.steps, before, resumeHash !== null);
      this.current = run;
      void run.finally(() => {
        if (this.current === run) this.current = null;
      });
      return;
    }
  }

  /** The steps of a row: what a failed cache left, a carry-on by info hash, a cache followed again, or its whole plan. */
  private planOf(row: StreamDownloadRow, office: boolean): DownloadPlan {
    const pending = this.pending.get(row.id);
    if (pending !== undefined) return { ok: true, steps: pending.steps };
    if (row.source === 'torrent' && row.sourceId !== null) return { ok: true, steps: [{ kind: 'hash', infoHash: row.sourceId }] };
    const full = planDownload({ via: row.via, infoHash: row.infoHash }, { office, torrent: this.opts.torrents !== null, cloud: this.opts.caches !== null });
    if (row.source === 'cloud' && full.ok) return { ok: true, steps: [{ kind: 'cloud', maxHeight: CLOUD_MAX_HEIGHT }, ...stepsAfterCloud(full.steps)] };
    return full;
  }

  /** One download's steps, in order, until a torrent is held, the cache took it, or every step failed. Never throws. */
  private async run(job: Job, steps: readonly DownloadStep[], before: readonly StepFailure[], resume: boolean): Promise<void> {
    const failures: StepFailure[] = [...before];
    try {
      await this.opts.repo.setState(this.host, job.id, 'running', this.now());
      for (let i = 0; i < steps.length; i += 1) {
        if (job.stopped) return;
        const step = steps[i]!;
        if (step.kind === 'cloud') {
          if (await this.startCloud(job, step, steps.slice(i + 1), failures)) return;
          continue;
        }
        const torrents = this.opts.torrents;
        if (torrents === null) {
          failures.push({ step, error: 'torrent_off', detail: 'torrents are off on this machine' });
          continue;
        }
        const fetched: TorrentFetch = await torrents.fetch(job.ref, step.kind === 'hash' ? { infoHash: step.infoHash } : { band: step.band });
        if (job.stopped || this.job !== job) {
          if (fetched.ok) torrents.release(fetched.handle);
          return;
        }
        if (!fetched.ok) {
          failures.push({ step, error: fetched.error, detail: fetched.detail });
          continue;
        }
        job.handle = fetched.handle;
        this.retries.delete(job.id);
        await torrents.keep(fetched.handle.infoHash, true);
        await this.opts.repo.on(this.host, job.id, { source: 'torrent', infoHash: fetched.handle.infoHash }, this.now());
        this.log(`[notesd] downloads: ${refLabel(job.ref)} downloads from the torrent ${fetched.detail}, kept until it is deleted on the Cache page`);
        return;
      }
      if (job.stopped || this.closed) return;
      if (resume && (await this.retryLater(job, failures))) return;
      await this.fail(job.id, job.ref, failures, job.sourceHash);
    } catch (err) {
      if (this.closed || job.stopped) return;
      this.log(`[notesd] downloads: ${refLabel(job.ref)}: ${messageOf(err)}`);
      await this.fail(job.id, job.ref, [...failures, { step: null, error: 'download_failed', detail: messageOf(err) }], job.sourceHash).catch(() => undefined);
    } finally {
      if (this.job === job && job.handle === null) this.job = null;
      if (this.job === null) void this.tick();
    }
  }

  /** The cloud step: the owner's cache at `maxHeight` or lower, followed from now on. False when the cache could not take it. */
  private async startCloud(job: Job, step: CloudStep, after: DownloadStep[], failures: StepFailure[]): Promise<boolean> {
    const caches = this.opts.caches;
    if (caches === null) {
      failures.push({ step, error: 'cloud_off', detail: 'the stream cache is off on this machine' });
      return false;
    }
    let cache: CacheNow;
    try {
      cache = await caches.request(job.ref, step.maxHeight);
    } catch (err) {
      failures.push({ step, error: 'download_failed', detail: messageOf(err) });
      return false;
    }
    if (job.stopped || this.job !== job) return true;
    if (cache.state === 'ready') {
      await this.finishCloud(job.id, job.ref, cache);
      return true;
    }
    await this.opts.repo.on(this.host, job.id, { source: 'cloud', cacheId: cache.id }, this.now());
    this.clouds.set(job.id, { ref: job.ref, step, after, failures: [...failures] });
    this.log(`[notesd] downloads: ${refLabel(job.ref)} downloads into the stream cache at ${cache.maxHeight === null ? 'the highest quality' : `${cache.maxHeight}p or lower`}`);
    return true;
  }

  private async finishCloud(id: string, ref: StreamRef, cache: CacheNow): Promise<void> {
    await this.opts.repo.done(this.host, id, { source: 'cloud', cacheId: cache.id }, { bytesDone: cache.bytes, bytesTotal: cache.bytes }, this.now());
    this.log(`[notesd] downloads: ${refLabel(ref)} is on this machine (the stream cache ${cache.id})`);
    this.opts.afterDone?.();
  }

  /** A carried-on torrent download whose swarm gave nothing: queued again a minute later, DOWNLOAD_RESUME_TRIES times in all. */
  private async retryLater(job: Job, failures: readonly StepFailure[]): Promise<boolean> {
    const tries = (this.retries.get(job.id)?.tries ?? 0) + 1;
    if (tries >= DOWNLOAD_RESUME_TRIES) {
      this.retries.delete(job.id);
      return false;
    }
    this.retries.set(job.id, { tries, at: this.now().getTime() + DOWNLOAD_RETRY_MS });
    await this.opts.repo.setState(this.host, job.id, 'queued', this.now());
    this.log(`[notesd] downloads: ${refLabel(job.ref)} could not carry on (${finalFailure(failures).detail}); trying again in ${Math.round(DOWNLOAD_RETRY_MS / 1000)} s`);
    return true;
  }

  /** Every step failed: the row says why (R1.11); a torrent it had kept loses the owner's mark. */
  private async fail(id: string, ref: StreamRef, failures: readonly StepFailure[], keptHash: string | null): Promise<void> {
    const final = finalFailure(failures);
    await this.opts.repo.failed(this.host, id, final.error, final.detail, this.now());
    if (keptHash !== null) await this.unkeep(keptHash, id);
    this.log(`[notesd] downloads: ${refLabel(ref)} could not be downloaded: ${final.error} (${final.detail})`);
  }

  /** Clears a torrent's kept mark unless another download of this host (not failed) still names it. */
  private async unkeep(infoHash: string, exceptId: string): Promise<void> {
    const rows = await this.opts.repo.list(this.host, { states: ['queued', 'running', 'paused', 'done'] });
    if (rows.some((r) => r.id !== exceptId && r.source === 'torrent' && r.sourceId === infoHash)) return;
    await this.opts.torrents?.keep(infoHash, false).catch((err: unknown) => this.log(`[notesd] downloads: could not clear the kept mark of ${infoHash.slice(0, 8)}: ${messageOf(err)}`));
  }

  private async onDisk(ref: StreamRef): Promise<boolean> {
    const torrent = (await this.opts.torrents?.onDisk(ref).catch(() => false)) === true;
    return torrent || (await this.opts.caches?.onDisk(ref).catch(() => false)) === true;
  }

  private async viewOf(row: StreamDownloadRow): Promise<DownloadView> {
    let state: DownloadState = row.state;
    let bytesDone = row.bytesDone;
    let bytesTotal = row.bytesTotal;
    let peers: number | null = null;
    let downKbps: number | null = null;
    let progress: number | null = null;
    const job = this.job;
    if (job !== null && job.id === row.id && job.handle !== null && this.opts.torrents !== null) {
      try {
        const now = await this.opts.torrents.now(job.handle);
        bytesDone = now.bytesDone;
        bytesTotal = now.bytesTotal;
        peers = now.peers;
        downKbps = now.downKbps;
      } catch {
        // The row's last count stands.
      }
    }
    if (this.clouds.has(row.id) && this.opts.caches !== null) {
      const cache = await this.opts.caches.find(downloadRef(row)).catch(() => null);
      if (cache !== null) {
        progress = cache.progress;
        bytesDone = cache.bytes;
        bytesTotal = null;
        if (cache.queued) state = 'queued';
      }
    }
    progress ??= row.state === 'done' ? 1 : bytesTotal !== null && bytesTotal > 0 ? share(bytesDone / bytesTotal) : 0;
    return {
      id: row.id,
      host: row.host,
      available: row.host === this.host,
      kind: row.kind,
      tmdb_id: row.tmdbId,
      season: row.kind === 'tv' ? row.season : null,
      episode: row.kind === 'tv' ? row.episode : null,
      via: row.via,
      info_hash: row.infoHash,
      batch: row.batch,
      state,
      source: row.source,
      source_id: row.sourceId,
      progress,
      bytes_done: bytesDone,
      bytes_total: bytesTotal,
      peers,
      down_kbps: downKbps,
      error: row.error,
      detail: row.errorDetail,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      finished_at: row.completedAt === null ? null : row.completedAt.toISOString(),
    };
  }
}

/**
 * The SSID as a download reads it: warp.mjs's `status`, once a minute at most. Typed to `status` alone, so nothing a
 * download holds can switch WARP. A status that cannot be read is no network (not the office).
 */
export function ssidFrom(warp: Pick<WarpSwitch, 'status'>, options: { ttlMs?: number; now?: () => number } = {}): () => Promise<string | null> {
  const ttlMs = options.ttlMs ?? SSID_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let kept: { at: number; ssid: string | null } | null = null;
  return async () => {
    if (kept !== null && now() - kept.at < ttlMs) return kept.ssid;
    let ssid: string | null = null;
    try {
      const state = await warp.status();
      ssid = state.ok ? state.ssid : null;
    } catch {
      ssid = null;
    }
    kept = { at: now(), ssid };
    return ssid;
  };
}

/**
 * The SSID pinned by NOTESD_STREAM_DOWNLOAD_SSID: answered as it is, and nothing is read (verify.sh pins it, so a
 * throwaway daemon never runs warp.mjs to read the machine's real network).
 */
export function fixedSsid(ssid: string): () => Promise<string | null> {
  return async () => ssid;
}

/** The last attempts of a torrent step that found nothing, for the row's detail (no key or token is in them). */
export function attemptsText(attempts: readonly ResolveAttempt[]): string {
  const said = attempts.filter((a) => a.outcome !== 'skipped' && (a.provider.startsWith('Torrent: ') || a.provider.startsWith('Index: ')));
  const text = said
    .slice(-4)
    .map((a) => `${a.provider}: ${a.outcome}${a.detail === '' ? '' : ` (${a.detail})`}`)
    .join('; ');
  return (text === '' ? 'no torrent was found' : text).slice(0, 400);
}

/** The torrent side over TorrentSource (built on first use, so read each time) and TorrentStreams. */
export function torrentDownloadsOf(source: () => TorrentSource | null, streams: TorrentStreams, facts: (ref: StreamRef) => Promise<DownloadFacts>): DownloadTorrents {
  const held = new WeakMap<KeptTorrentHandle, SessionTorrent>();
  return {
    onDisk: async (ref) => (await source()?.onDisk(ref)) === true,
    fetch: async (ref, ask) => {
      const s = source();
      if (s === null) return { ok: false, error: 'no_source', detail: 'torrents are off on this machine' };
      const title = await facts(ref);
      const band = 'band' in ask ? ask.band : null;
      const out = await s.fetchKept(ref, {
        ...title,
        resumeS: null,
        ...(band === null ? {} : { only: (c: TorrentCandidate, count: SwarmCount | null): boolean => bandAllows(band, c, count) }),
        ...('infoHash' in ask ? { infoHash: ask.infoHash } : {}),
      });
      if (!out.ok) return { ok: false, error: out.error, detail: attemptsText(out.attempts) };
      const handle: KeptTorrentHandle = { infoHash: out.torrent.infoHash, fileIndex: out.torrent.fileIndex, name: out.torrent.name };
      held.set(handle, out.torrent);
      return { ok: true, handle, detail: `${out.torrent.name}${out.torrent.height === null ? '' : `, ${out.torrent.height}p`}` };
    },
    now: async (handle) => {
      const torrent = held.get(handle);
      const s = source();
      const kept = torrent === undefined || s === null ? { file: 'downloading' as const, remux: 'none' as const, subtitles: 'done' as const } : await s.keptState(torrent);
      const file = await streams.fileProgress(handle.infoHash, handle.fileIndex);
      const stats = streams.stats(handle.infoHash);
      return { ...kept, bytesDone: file?.bytesDone ?? 0, bytesTotal: file?.length ?? null, peers: stats?.peers ?? null, downKbps: stats?.down_kbps ?? null };
    },
    retryRemux: async (handle) => {
      const torrent = held.get(handle);
      if (torrent !== undefined) await source()?.retryKeptRemux(torrent);
    },
    release: (handle) => {
      const torrent = held.get(handle);
      if (torrent === undefined) return;
      held.delete(handle);
      source()?.release(torrent);
    },
    keep: (infoHash, kept) => streams.keep(infoHash, kept),
  };
}

/** The cloud side over StreamCache: always the owner's cache (not `auto`), so the cache's prune never clears it. */
export function cacheDownloadsOf(cache: StreamCache): DownloadCaches {
  const nowOf = (v: StreamCacheView): CacheNow => ({
    id: v.id,
    state: v.state,
    running: v.running,
    queued: v.queued,
    progress: v.progress,
    bytes: v.bytes,
    maxHeight: v.max_height,
    error: v.error,
    errorDetail: v.error_detail,
  });
  return {
    onDisk: async (ref) => (await cache.find(ref))?.state === 'ready',
    request: async (ref, maxHeight) => {
      try {
        return nowOf((await cache.request(ref, { maxHeight })).cache);
      } catch (err) {
        // A cache of this title at another height already exists here: it is carried on (and becomes the owner's) at its own.
        if (err instanceof CacheError && err.code === 'cache_exists' && err.extra.cache !== undefined) {
          return nowOf((await cache.request(ref, { maxHeight: err.extra.cache.max_height })).cache);
        }
        throw err;
      }
    },
    find: async (ref) => {
      const v = await cache.find(ref);
      return v === null ? null : nowOf(v);
    },
    pause: (ref) => cache.pause(ref),
  };
}

/**
 * The daemon's download engine, or null with NOTESD_STREAM_DOWNLOADS=off, without direct streaming, or with neither
 * torrents nor the stream cache. Building it starts nothing: startBackground calls `start`.
 */
export function buildStreamDownloads(
  config: Config,
  wiring: {
    db: Db;
    directStream: DirectStreamService | null;
    torrentSource: () => TorrentSource | null;
    torrents: TorrentStreams | null;
    streamCache: StreamCache | null;
    warp: Pick<WarpSwitch, 'status'>;
    afterDone?: () => void;
    log?: (line: string) => void;
  },
): StreamDownloads | null {
  const ds = wiring.directStream;
  if (config.directStream?.downloads !== true || ds === null || (wiring.torrents === null && wiring.streamCache === null)) return null;
  return new StreamDownloads({
    host: ds.host,
    repo: new DownloadsRepo(wiring.db),
    torrents: wiring.torrents === null ? null : torrentDownloadsOf(wiring.torrentSource, wiring.torrents, (ref) => ds.downloadFacts(ref)),
    caches: wiring.streamCache === null ? null : cacheDownloadsOf(wiring.streamCache),
    ssid: config.directStream?.downloadSsid != null ? fixedSsid(config.directStream.downloadSsid) : ssidFrom(wiring.warp),
    playingTorrents: () => ds.torrentsOnScreen(),
    ...(wiring.afterDone === undefined ? {} : { afterDone: wiring.afterDone }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
