import path from 'node:path';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { StreamTorrentFile, StreamTorrentRow } from '../../db/schema.js';
import { jsonError } from '../passThrough.js';
import type { StreamRef } from '../types.js';
import { WebTorrentEngine } from './engine.js';
import { torrentRef, TorrentsRepo, type TorrentRecords, type TorrentRecordSpec } from './repo.js';
import { diskFileResponse, notOnThisMachine, swarmFileResponse } from './serve.js';
import { DiskHandle, TorrentFolder } from './store.js';
import {
  BYTES_PER_KB,
  mediaOf,
  normalizeInfoHash,
  PLAYED_EVERY_MS,
  PROGRESS_STEP_BYTES,
  TORRENT_LINGER_MS,
  TORRENT_PRUNE_EVERY_MS,
  TORRENT_TICK_MS,
  TorrentError,
  type TorrentDownload,
  type TorrentDownloadView,
  type TorrentEngine,
  type TorrentFileInfo,
  type TorrentHandle,
  type TorrentMap,
  type TorrentPick,
  type TorrentStats,
  type TorrentStatus,
} from './types.js';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sumRanges = (ranges: readonly [number, number][]): number => ranges.reduce((n, [from, to]) => n + (to - from), 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const sameRef = (a: StreamRef, b: StreamRef): boolean =>
  a.kind === b.kind && a.tmdbId === b.tmdbId && (a.kind === 'movie' || (b.kind === 'tv' && a.season === b.season && a.episode === b.episode));

export interface TorrentStreamsOptions {
  engine: TorrentEngine;
  repo: TorrentRecords;
  folder: TorrentFolder;
  /** os.hostname(): rows are made under it, and only its rows' files are here. */
  host: string;
  /** NOTESD_TORRENT_UPLOAD_KBPS, for the status (the engine applies it). */
  uploadKbps: number;
  /** NOTESD_TORRENT_KEEP_DAYS. */
  keepDays: number;
  /** NOTESD_TORRENT_DISCOVERY, for the status. */
  discovery: boolean;
  lingerMs?: number;
  tickMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** Runs `fn` every `ms`; answers how to stop it. Default setInterval, unref'd. Tests pass a no-op and call tick(). */
  every?: (fn: () => void, ms: number) => () => void;
}

/** A torrent in the swarm. A finished download read from disk is never one. */
interface Active {
  handle: TorrentHandle;
  /** Stream sessions (and the open route) using it now. */
  users: number;
  /** The last use, release or file request, in ms. */
  lastRequestAt: number;
  /** This host's row as last written; ticks read it instead of the database. */
  row: StreamTorrentRow;
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * This host's torrent downloads (torrent-stream-source phase 1). Held in AppDeps.torrents; the routes
 * (src/http/streamTorrentApi.ts) and, from phase 3, the stream sessions call it. A torrent is in the swarm
 * only while something uses it; the engine itself runs only while a torrent is in the swarm.
 */
export class TorrentStreams {
  private readonly engine: TorrentEngine;
  private readonly repo: TorrentRecords;
  private readonly folder: TorrentFolder;
  private readonly lingerMs: number;
  private readonly tickMs: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly every: (fn: () => void, ms: number) => () => void;
  private readonly active = new Map<string, Active>();
  private readonly opening = new Map<string, Promise<TorrentHandle>>();
  private readonly playedAt = new Map<string, number>();
  private stopTimer: (() => void) | null = null;
  private lastPrune = 0;
  private ticking = false;
  private closed = false;

  constructor(private readonly opts: TorrentStreamsOptions) {
    this.engine = opts.engine;
    this.repo = opts.repo;
    this.folder = opts.folder;
    this.lingerMs = opts.lingerMs ?? TORRENT_LINGER_MS;
    this.tickMs = opts.tickMs ?? TORRENT_TICK_MS;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.every = opts.every ?? defaultEvery;
  }

  get host(): string {
    return this.opts.host;
  }

  get root(): string {
    return this.folder.root;
  }

  get uploadKbps(): number {
    return this.opts.uploadKbps;
  }

  get keepDays(): number {
    return this.opts.keepDays;
  }

  /** Clears downloads not played for `keepDays` and starts the tick. Joins nothing. Returns how many were cleared. */
  async start(): Promise<number> {
    const cleared = await this.prune();
    this.stopTimer ??= this.every(() => void this.tick(), this.tickMs);
    return cleared;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopTimer?.();
    this.stopTimer = null;
    this.active.clear();
    await this.engine.close();
  }

  /**
   * Opens a torrent for a title and answers once its file list is known, with nothing selected. The same
   * handle while it is open. A download finished on this host for the same title answers from disk.
   */
  async open(pick: TorrentPick, options: { timeoutMs: number }): Promise<TorrentHandle> {
    const infoHash = normalizeInfoHash(pick.infoHash);
    if (infoHash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    if (this.closed) throw new TorrentError('closing', 'The daemon is stopping.');
    const live = this.active.get(infoHash);
    if (live !== undefined) {
      live.lastRequestAt = this.nowMs();
      return live.handle;
    }
    const pending = this.opening.get(infoHash);
    if (pending !== undefined) return pending;
    const opened = this.openNow({ ...pick, infoHash }, options).finally(() => this.opening.delete(infoHash));
    this.opening.set(infoHash, opened);
    return opened;
  }

  /**
   * Selects these files (videos and subtitles only) and counts one more user. On a finished download read
   * from disk it only marks the play (nothing joins a swarm). Throws not_open, not_media, invalid_hash.
   */
  async use(infoHash: string, fileIndexes: readonly number[]): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    const live = this.active.get(hash);
    if (live === undefined) {
      const row = await this.repo.get(this.host, hash);
      if (row !== null && row.state === 'ready' && fileIndexes.every((i) => row.files.some((f) => f.index === i)) && (await this.diskHandle(row)) !== null) {
        await this.notePlayed(row, true);
        return;
      }
      throw new TorrentError('not_open', 'Open the torrent before using its files.');
    }
    const chosen = this.mediaFiles(live.handle, fileIndexes);
    live.handle.select(chosen.map((f) => f.index));
    live.users += 1;
    live.lastRequestAt = this.nowMs();
    const files: StreamTorrentFile[] = live.row.files.map((f) => ({ ...f }));
    for (const f of chosen) if (!files.some((m) => m.index === f.index)) files.push({ index: f.index, path: f.path, length: f.length });
    const fileIndex = live.row.fileIndex ?? chosen.find((f) => mediaOf(f.name) === 'video')?.index ?? null;
    const fileLength = files.find((f) => f.index === fileIndex)?.length ?? null;
    live.row = await this.repo.chosen(this.host, hash, { files, fileIndex, fileLength }, this.now());
  }

  /**
   * One user fewer. With none left, a finished download leaves the swarm at once and an unfinished one
   * `lingerMs` after its last file request. A torrent opened and never used leaves at once. Unknown: ignored.
   */
  async release(infoHash: string): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    if (hash === null || live === undefined) return;
    live.lastRequestAt = this.nowMs();
    if (live.users === 0) {
      await this.leave(hash, live, 'it was opened and never used');
      return;
    }
    live.users -= 1;
    if (live.users === 0) await this.settle(hash, live);
  }

  /**
   * One user fewer, and with none left the swarm is left at once, finished or not: a torrent that lost the choice
   * to another, or whose file does not play. What it downloaded stays until the prune. Unknown: ignored.
   */
  async drop(infoHash: string): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    if (hash === null || live === undefined) return;
    if (live.users > 0) live.users -= 1;
    if (live.users === 0) await this.leave(hash, live, 'it is not the torrent that plays');
  }

  /** The peers connected and the download rate of a torrent in the swarm, now; null when it is not in it. */
  stats(infoHash: string): TorrentStats | null {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    return live === undefined ? null : live.handle.stats();
  }

  /** This host's best record of a title with a chosen video: a ready one first, then the most recent. */
  async find(ref: StreamRef): Promise<TorrentDownload | null> {
    for (const stored of await this.repo.forRef(this.host, ref)) {
      const row = this.active.get(stored.infoHash)?.row ?? stored;
      if (row.fileIndex === null) continue;
      return {
        infoHash: row.infoHash,
        host: row.host,
        name: row.name,
        release: row.release,
        fileIndex: row.fileIndex,
        fileLength: row.fileLength,
        state: row.state,
        durationS: row.durationS,
      };
    }
    return null;
  }

  /** One download: this host's, else the other machine's (`available: false`); null when none. */
  async view(infoHash: string): Promise<TorrentDownloadView | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const live = this.active.get(hash);
    if (live !== undefined) return this.viewOf(live.row);
    const rows = await this.repo.byHash(hash);
    const row = rows.find((r) => r.host === this.host) ?? rows[0];
    return row === undefined ? null : this.viewOf(row);
  }

  /** Every download of both machines, newest first. */
  async list(): Promise<TorrentDownloadView[]> {
    return (await this.repo.all()).map((row) => this.viewOf(row.host === this.host ? (this.active.get(row.infoHash)?.row ?? row) : row));
  }

  status(): TorrentStatus {
    return {
      host: this.host,
      port: this.engine.port(),
      upload_cap_bytes_per_s: this.opts.uploadKbps * BYTES_PER_KB,
      keep_days: this.opts.keepDays,
      discovery: this.opts.discovery,
      swarm: [...this.active.entries()].map(([hash, live]) => ({ info_hash: hash, name: live.row.name, users: live.users, ...live.handle.stats() })),
    };
  }

  /** The absolute path of a chosen file once it is whole on this machine's disk, else null. */
  async filePath(infoHash: string, index: number): Promise<string | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.rowHere(hash);
    if (found instanceof Response) return null;
    const file = found.files.find((f) => f.index === index);
    if (file === undefined) return null;
    if (found.state !== 'ready' && this.active.get(hash)?.handle.done(index) !== true) return null;
    return this.folder.complete(hash, file.path, file.length);
  }

  /**
   * GET /api/stream/torrent/:hash/f/:index. A chosen file with Range: from disk when it is whole, else
   * through the swarm, whose pieces for the range come first. 404 unknown_torrent / not_on_this_machine /
   * not_selected, 409 not_in_swarm (unfinished and not open: play it to carry on), 503 closing.
   */
  async serve(infoHash: string, index: number, rangeHeader: string | null): Promise<Response> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null || !Number.isSafeInteger(index) || index < 0) return jsonError(404, 'unknown_torrent', 'No torrent download has this info hash.');
    const found = await this.rowHere(hash);
    if (found instanceof Response) return found;
    const file = found.files.find((f) => f.index === index);
    if (file === undefined) return jsonError(404, 'not_selected', 'That file of the torrent is not one this machine downloads.');
    await this.notePlayed(found, index === found.fileIndex);
    const live = this.active.get(hash);
    if (found.state === 'ready' || live?.handle.done(index) === true) {
      const onDisk = await this.folder.complete(hash, file.path, file.length);
      if (onDisk !== null) return diskFileResponse(onDisk, file.path, rangeHeader);
    }
    if (this.closed) return jsonError(503, 'closing', 'The daemon is stopping.');
    if (live === undefined) return jsonError(409, 'not_in_swarm', 'This torrent is not being downloaded now; play it again to carry on.');
    live.lastRequestAt = this.nowMs();
    return swarmFileResponse(live.handle, file, rangeHeader);
  }

  /** The video's stretches on this machine's disk; null for an unknown hash or the other machine's. */
  async map(infoHash: string): Promise<TorrentMap | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.rowHere(hash);
    if (found instanceof Response) return null;
    const live = this.active.get(hash);
    const length = found.fileLength;
    let bytes: [number, number][] = [];
    if (found.fileIndex !== null && length !== null) {
      if (found.state === 'ready') bytes = length > 0 ? [[0, length]] : [];
      else if (live !== undefined) bytes = live.handle.ranges(found.fileIndex);
    }
    const duration = found.durationS;
    const ranges: [number, number][] =
      duration === null || length === null || length === 0 ? [] : bytes.map(([from, to]) => [round1((from / length) * duration), round1((to / length) * duration)]);
    return { duration_s: duration, ranges, length, byte_ranges: bytes };
  }

  /** The video's length in seconds, once a caller knows it (phase 3's probe): the map turns bytes into seconds with it. */
  async setDuration(infoHash: string, seconds: number): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null || !Number.isFinite(seconds) || seconds <= 0) return;
    await this.repo.duration(this.host, hash, seconds, this.now());
    const live = this.active.get(hash);
    if (live !== undefined) live.row = { ...live.row, durationS: seconds };
  }

  localUrl(infoHash: string, index: number): string {
    return `/api/stream/torrent/${infoHash}/f/${index}`;
  }

  /** The timer's work: progress, finished downloads, idle torrents leaving, and now and then the prune. */
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const [hash, live] of [...this.active]) {
        try {
          await this.settle(hash, live);
        } catch (err) {
          this.log(`[notesd] torrent: ${live.row.name}: ${messageOf(err)}`);
        }
      }
      if (this.nowMs() - this.lastPrune >= TORRENT_PRUNE_EVERY_MS) await this.prune();
    } finally {
      this.ticking = false;
    }
  }

  /** Deletes this host's downloads not played for `keepDays`, with their folders. Never throws. */
  async prune(): Promise<number> {
    this.lastPrune = this.nowMs();
    let cleared = 0;
    try {
      const before = new Date(this.nowMs() - this.opts.keepDays * 86_400_000);
      for (const row of await this.repo.stale(this.host, before)) {
        if (this.active.has(row.infoHash) || this.opening.has(row.infoHash)) continue;
        await this.folder.remove(row.infoHash);
        await this.repo.delete(this.host, row.infoHash);
        cleared += 1;
        this.log(`[notesd] torrent: cleared ${row.name}, not played for ${this.opts.keepDays} days`);
      }
    } catch (err) {
      this.log(`[notesd] torrent: could not clear old downloads: ${messageOf(err)}`);
    }
    return cleared;
  }

  private nowMs(): number {
    return this.now().getTime();
  }

  private async openNow(pick: TorrentPick, options: { timeoutMs: number }): Promise<TorrentHandle> {
    const existing = await this.repo.get(this.host, pick.infoHash);
    if (existing !== null && existing.state === 'ready' && sameRef(torrentRef(existing), pick.ref)) {
      const disk = await this.diskHandle(existing);
      if (disk !== null) return disk;
      await this.repo.restarted(this.host, pick.infoHash, this.now());
      this.log(`[notesd] torrent: ${existing.name} was finished but its files are gone from ${this.folder.dirOf(pick.infoHash)}; downloading it again`);
    }
    const spec = (name: string): TorrentRecordSpec => ({ infoHash: pick.infoHash, ref: pick.ref, name, release: pick.name, trackers: pick.trackers });
    let handle: TorrentHandle;
    try {
      handle = await this.engine.add({ infoHash: pick.infoHash, trackers: pick.trackers, name: pick.name }, options);
    } catch (err) {
      const failure = err instanceof TorrentError ? err : new TorrentError('engine_error', messageOf(err));
      if (failure.code !== 'closing') {
        await this.repo.record(this.host, spec(existing?.name ?? pick.name ?? pick.infoHash), this.now());
        await this.repo.failed(this.host, pick.infoHash, failure.code, this.now());
        this.log(`[notesd] torrent: ${pick.name ?? pick.infoHash}: ${failure.code}: ${failure.message}`);
      }
      throw failure;
    }
    const row = await this.repo.record(this.host, spec(handle.name), this.now());
    this.active.set(pick.infoHash, { handle, users: 0, lastRequestAt: this.nowMs(), row });
    this.log(`[notesd] torrent: joined the swarm of ${handle.name} (${pick.infoHash.slice(0, 8)}), ${handle.files.length} files, nothing chosen yet`);
    return handle;
  }

  /** A DiskHandle over a ready row's chosen files when every one is whole on disk, else null. */
  private async diskHandle(row: StreamTorrentRow): Promise<DiskHandle | null> {
    if (row.fileIndex === null || row.files.length === 0) return null;
    const paths = new Map<number, string>();
    for (const f of row.files) {
      const onDisk = await this.folder.complete(row.infoHash, f.path, f.length);
      if (onDisk === null) return null;
      paths.set(f.index, onDisk);
    }
    const files: TorrentFileInfo[] = row.files.map((f) => ({ index: f.index, path: f.path, name: path.basename(f.path), length: f.length }));
    return new DiskHandle(row.infoHash, row.name, files, paths);
  }

  private mediaFiles(handle: TorrentHandle, indexes: readonly number[]): TorrentFileInfo[] {
    if (indexes.length === 0) throw new TorrentError('not_media', 'Name at least one file to use.');
    return [...new Set(indexes)].map((index) => {
      const file = handle.files.find((f) => f.index === index);
      if (file === undefined) throw new TorrentError('not_media', `The torrent has no file ${index}.`);
      if (mediaOf(file.name) === null) {
        throw new TorrentError('not_media', `${file.path} is neither a video nor a subtitle file; notesd never downloads or opens anything else from a torrent.`);
      }
      return file;
    });
  }

  /** Records progress and a finished download, then lets the torrent go when nothing uses it. */
  private async settle(hash: string, live: Active): Promise<void> {
    const row = live.row;
    const complete = row.fileIndex !== null && row.files.every((f) => live.handle.done(f.index));
    if (complete && row.state !== 'ready') {
      live.row = await this.repo.ready(this.host, hash, row.fileLength ?? 0, this.now());
      this.log(`[notesd] torrent: ${row.name} is on disk (${Math.round((row.fileLength ?? 0) / 1_048_576)} MB)`);
    } else if (!complete && row.fileIndex !== null) {
      const bytes = sumRanges(live.handle.ranges(row.fileIndex));
      if (Math.abs(bytes - row.bytesDone) >= PROGRESS_STEP_BYTES) {
        await this.repo.progress(this.host, hash, bytes, this.now());
        live.row = { ...row, bytesDone: bytes };
      }
    }
    if (live.users > 0) return;
    if (complete) await this.leave(hash, live, 'it is finished and nothing plays it');
    else if (this.nowMs() - live.lastRequestAt >= this.lingerMs) {
      await this.leave(hash, live, `nothing asked for it for ${Math.round(this.lingerMs / 60_000)} min`);
    }
  }

  private async leave(hash: string, live: Active, why: string): Promise<void> {
    if (this.active.get(hash) !== live) return;
    this.active.delete(hash);
    try {
      await this.engine.remove(hash, { deleteFiles: false });
    } catch (err) {
      this.log(`[notesd] torrent: could not leave the swarm of ${live.row.name}: ${messageOf(err)}`);
    }
    const chosen = new Set(live.row.files.map((f) => f.index));
    try {
      await this.folder.dropFiles(hash, live.handle.files.filter((f) => !chosen.has(f.index)).map((f) => f.path));
    } catch (err) {
      this.log(`[notesd] torrent: could not delete the edges of unchosen files of ${live.row.name}: ${messageOf(err)}`);
    }
    this.log(`[notesd] torrent: left the swarm of ${live.row.name} (${hash.slice(0, 8)}): ${why}`);
  }

  /** This host's row of a hash, or the answer for the other machine's / an unknown one. */
  private async rowHere(hash: string): Promise<StreamTorrentRow | Response> {
    const live = this.active.get(hash);
    if (live !== undefined) return live.row;
    const rows = await this.repo.byHash(hash);
    const here = rows.find((r) => r.host === this.host);
    if (here !== undefined) return here;
    const other = rows[0];
    if (other !== undefined) return notOnThisMachine(other.host);
    return jsonError(404, 'unknown_torrent', 'No torrent download has this info hash.');
  }

  private async notePlayed(row: StreamTorrentRow, isVideo: boolean): Promise<void> {
    if (!isVideo) return;
    const at = this.nowMs();
    if (at - (this.playedAt.get(row.infoHash) ?? Number.NEGATIVE_INFINITY) < PLAYED_EVERY_MS) return;
    this.playedAt.set(row.infoHash, at);
    try {
      await this.repo.played(this.host, row.infoHash, this.now());
    } catch (err) {
      this.log(`[notesd] torrent: could not mark ${row.name} played: ${messageOf(err)}`);
    }
  }

  private viewOf(row: StreamTorrentRow): TorrentDownloadView {
    const available = row.host === this.host;
    const live = available ? this.active.get(row.infoHash) : undefined;
    const stats = live?.handle.stats() ?? { peers: 0, down_kbps: 0, up_kbps: 0 };
    const length = row.fileLength;
    const bytes =
      row.state === 'ready'
        ? (length ?? row.bytesDone)
        : live !== undefined && row.fileIndex !== null
          ? sumRanges(live.handle.ranges(row.fileIndex))
          : row.bytesDone;
    return {
      info_hash: row.infoHash,
      host: row.host,
      available,
      kind: row.kind,
      tmdb_id: row.tmdbId,
      season: row.kind === 'tv' ? row.season : null,
      episode: row.kind === 'tv' ? row.episode : null,
      name: row.name,
      release: row.release,
      state: row.state,
      error: row.error,
      file_index: row.fileIndex,
      file_length: length,
      files: row.files.map((f) => ({ index: f.index, path: f.path, length: f.length, media: mediaOf(f.path) })),
      bytes_done: bytes,
      progress: length === null || length === 0 ? (row.state === 'ready' ? 1 : 0) : Math.round((bytes / length) * 1000) / 1000,
      duration_s: row.durationS,
      in_swarm: live !== undefined,
      users: live?.users ?? 0,
      ...stats,
      file_url: available && row.fileIndex !== null ? this.localUrl(row.infoHash, row.fileIndex) : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      completed_at: row.completedAt === null ? null : row.completedAt.toISOString(),
      played_at: row.playedAt === null ? null : row.playedAt.toISOString(),
    };
  }
}

/** Test seams for buildTorrentStreams. */
export interface TorrentStreamsOverrides {
  engine?: TorrentEngine;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's torrents, or null with direct streaming off or NOTESD_TORRENT=off (then nothing is built,
 * no swarm is joined and the routes answer torrent_off). Building it starts nothing: the engine starts
 * with the first torrent opened.
 */
export function buildTorrentStreams(
  config: Config,
  directStream: { readonly host: string } | null,
  db: Db,
  overrides: TorrentStreamsOverrides = {},
): TorrentStreams | null {
  const t = config.torrent;
  if (directStream === null || t === undefined || !t.enabled) return null;
  const folder = new TorrentFolder(t.dir);
  const log = overrides.log ?? ((line: string) => console.log(line));
  return new TorrentStreams({
    engine: overrides.engine ?? new WebTorrentEngine({ folder, uploadKbps: t.uploadKbps, discovery: t.discovery, peers: t.peers, log }),
    repo: new TorrentsRepo(db),
    folder,
    host: directStream.host,
    uploadKbps: t.uploadKbps,
    keepDays: t.keepDays,
    discovery: t.discovery,
    log,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}
