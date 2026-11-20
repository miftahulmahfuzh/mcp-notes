import path from 'node:path';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { and, inArray, isNotNull, or } from 'drizzle-orm';
import { movieTitles, type StreamTorrentFile, type StreamTorrentRow } from '../../db/schema.js';
import { jsonError } from '../passThrough.js';
import type { StreamRef } from '../types.js';
import { WebTorrentEngine } from './engine.js';
import { slotOf, torrentRef, TorrentsRepo, type TorrentRecords, type TorrentRecordSpec, type TorrentSlot } from './repo.js';
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
const slotKey = (s: Pick<TorrentSlot, 'season' | 'episode'>): string => `${s.season}x${s.episode}`;
const GIB = 1024 ** 3;
const gb = (bytes: number): string => (bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1_048_576)} MB`);
/** A ready download played (or finished) within this long goes last in the budget's order. */
export const TORRENT_RECENT_MS = 86_400_000;
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
  /** NOTESD_TORRENT_BUDGET_GB, as bytes: the prune deletes whole torrents until the torrent folder takes less. Unset: no budget. */
  budgetBytes?: number;
  /** NOTESD_TORRENT_DISCOVERY, for the status. */
  discovery: boolean;
  /**
   * Of these title ids (`movie-<tmdb id>`, `tv-<tmdb id>`), the ones the owner marked watched or not interested: the
   * budget deletes their downloads first. Unset: none is.
   */
  marked?: (titleIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /**
   * Sweep folders no row of this host names (default true). False while the old shared database is still to be
   * merged (`importPending`): a download whose row is only there yet must keep its files.
   */
  sweepOrphans?: boolean;
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
  /**
   * This host's rows of the torrent as last written, one per episode chosen from it (a film: one), by slotKey;
   * ticks read them instead of the database. A season pack keeps a row for every episode chosen from it.
   */
  rows: Map<string, StreamTorrentRow>;
  /** The episode last opened: a `use` naming files no row holds yet chooses them for it. */
  slot: string;
  /**
   * The row was made by this open (none was there, or only a failed one): a torrent that leaves as one that does not
   * play, never played, takes its row and folder with it.
   */
  fresh: boolean;
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
  private pruning: Promise<number> | null = null;
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
      await this.takeSlot(live, { ...pick, infoHash });
      return live.handle;
    }
    const pending = this.opening.get(infoHash);
    if (pending !== undefined) {
      const handle = await pending;
      const opened = this.active.get(infoHash);
      if (opened !== undefined) await this.takeSlot(opened, { ...pick, infoHash });
      return handle;
    }
    const opened = this.openNow({ ...pick, infoHash }, options).finally(() => this.opening.delete(infoHash));
    this.opening.set(infoHash, opened);
    return opened;
  }

  /**
   * Selects these files (videos and subtitles only) and counts one more user. On a finished download read
   * from disk it does nothing (nothing joins a swarm). Throws not_open, not_media, invalid_hash.
   */
  async use(infoHash: string, fileIndexes: readonly number[]): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    const live = this.active.get(hash);
    if (live === undefined) {
      for (const row of await this.repo.slots(this.host, hash)) {
        if (row.state === 'ready' && fileIndexes.every((i) => row.files.some((f) => f.index === i)) && (await this.diskHandle(row)) !== null) return;
      }
      throw new TorrentError('not_open', 'Open the torrent before using its files.');
    }
    const chosen = this.mediaFiles(live.handle, fileIndexes);
    live.handle.select(chosen.map((f) => f.index));
    live.users += 1;
    live.lastRequestAt = this.nowMs();
    // The episode whose row already holds these files (a reload takes its torrent again), else the one last opened.
    const row = [...live.rows.values()].find((r) => chosen.every((c) => r.files.some((f) => f.index === c.index))) ?? this.current(live);
    const files: StreamTorrentFile[] = row.files.map((f) => ({ ...f }));
    for (const f of chosen) if (!files.some((m) => m.index === f.index)) files.push({ index: f.index, path: f.path, length: f.length });
    const fileIndex = row.fileIndex ?? chosen.find((f) => mediaOf(f.name) === 'video')?.index ?? null;
    const fileLength = files.find((f) => f.index === fileIndex)?.length ?? null;
    try {
      live.rows.set(slotKey(row), await this.repo.chosen(this.host, row, { files, fileIndex, fileLength }, this.now()));
    } catch (err) {
      // The caller sees a throw and holds nothing: the user it was counted as is taken back.
      live.users -= 1;
      throw err;
    }
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
      await this.leave(hash, live, 'it was opened and never used', { forget: true });
      return;
    }
    live.users -= 1;
    if (live.users === 0) {
      // Nobody plays it now: it stops downloading while it waits (lingerMs) for a reload. A finished one leaves in
      // settle. Left downloading, the last film filled this machine's ~9 Mbps link for three more minutes and the
      // next play's TMDB and index requests timed out (Sinners, F1: "could not read the IMDb id").
      const unfinished = [...live.rows.values()].filter((r) => r.fileIndex !== null && r.state !== 'ready' && !r.files.every((f) => live.handle.done(f.index)));
      if (unfinished.length > 0) {
        try {
          live.handle.deselect?.(unfinished.flatMap((r) => r.files.map((f) => f.index)));
        } catch (err) {
          this.log(`[notesd] torrent: could not pause ${hash.slice(0, 8)}: ${messageOf(err)}`);
        }
      }
      await this.settle(hash, live);
    }
  }

  /**
   * Gives back a hold taken with `use`, and with none left the swarm is left at once, finished or not: a torrent
   * that lost the choice to another, or whose file does not play. Only for a caller whose `use` answered; one
   * that opened the torrent and used nothing calls `discard`. Unknown: ignored.
   */
  async drop(infoHash: string): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    if (hash === null || live === undefined) return;
    if (live.users > 0) live.users -= 1;
    if (live.users === 0) await this.leave(hash, live, 'it is not the torrent that plays', { forget: true });
  }

  /**
   * For a caller that opened a torrent and took no hold of it (its open gave up, it holds no file of the title,
   * another torrent was chosen first): the swarm is left at once when nothing uses the torrent. A hold another
   * caller took is never touched, so a torrent a session plays stays in the swarm. Unknown: ignored.
   */
  async discard(infoHash: string): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    if (hash === null || live === undefined || live.users > 0) return;
    await this.leave(hash, live, 'it is not the torrent that plays', { forget: true });
  }

  /**
   * The player page reported a position of this torrent's session: it really plays, so its download is kept for
   * `keepDays` from now. Written at most once a minute per torrent; the file route's own reads (the header probe,
   * ffmpeg, a subtitle tier) never mark a play. Unknown or the other machine's: ignored. Never throws.
   */
  async played(infoHash: string, fileIndex?: number): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return;
    const at = this.nowMs();
    const throttle = `${hash}:${fileIndex ?? ''}`;
    if (at - (this.playedAt.get(throttle) ?? Number.NEGATIVE_INFINITY) < PLAYED_EVERY_MS) return;
    this.playedAt.set(throttle, at);
    try {
      const live = this.active.get(hash);
      const rows = live !== undefined ? [...live.rows.values()] : await this.repo.slots(this.host, hash);
      // The episode whose video plays; without its index, the episode last opened.
      const row = rows.find((r) => fileIndex !== undefined && r.fileIndex === fileIndex) ?? (live !== undefined ? this.current(live) : rows[0]);
      if (row === undefined) return;
      await this.repo.played(this.host, row, this.now());
      if (live !== undefined && this.active.get(hash) === live) live.rows.set(slotKey(row), { ...row, playedAt: this.now() });
    } catch (err) {
      this.log(`[notesd] torrent: could not mark ${hash.slice(0, 8)} played: ${messageOf(err)}`);
    }
  }

  /** The peers connected and the download rate of a torrent in the swarm, now; null when it is not in it. */
  stats(infoHash: string): TorrentStats | null {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    return live === undefined ? null : live.handle.stats();
  }

  /** The release name this host's row of a torrent keeps (as the index listed it), else its swarm name; null without a row. */
  async releaseName(infoHash: string): Promise<string | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const row = await this.repo.get(this.host, hash);
    return row === null ? null : (row.release ?? row.name ?? null);
  }

  /** Bytes the torrent received from peers since it was opened; null when it is not in the swarm or its handle cannot say. */
  received(infoHash: string): number | null {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    return live?.handle.received?.() ?? null;
  }

  /** This host's best record of a title with a chosen video: a ready one first, then the most recent. */
  async find(ref: StreamRef): Promise<TorrentDownload | null> {
    for (const stored of await this.repo.forRef(this.host, ref)) {
      const row = this.active.get(stored.infoHash)?.rows.get(slotKey(stored)) ?? stored;
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
    const found = await this.rowHere(hash);
    if (!(found instanceof Response)) return this.viewOf(found);
    const rows = await this.repo.byHash(hash);
    return rows[0] === undefined ? null : this.viewOf(rows[0]);
  }

  /** Every download of both machines, newest first. */
  async list(): Promise<TorrentDownloadView[]> {
    return (await this.repo.all()).map((row) => this.viewOf(row.host === this.host ? (this.active.get(row.infoHash)?.rows.get(slotKey(row)) ?? row) : row));
  }

  status(): TorrentStatus {
    return {
      host: this.host,
      port: this.engine.port(),
      upload_cap_bytes_per_s: this.opts.uploadKbps * BYTES_PER_KB,
      keep_days: this.opts.keepDays,
      discovery: this.opts.discovery,
      swarm: [...this.active.entries()].map(([hash, live]) => ({ info_hash: hash, name: live.handle.name, users: live.users, ...live.handle.stats() })),
    };
  }

  /** The absolute path of a chosen file once it is whole on this machine's disk, else null. */
  async filePath(infoHash: string, index: number): Promise<string | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.rowHere(hash, index);
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
    const found = await this.rowHere(hash, index);
    if (found instanceof Response) return found;
    const file = found.files.find((f) => f.index === index);
    if (file === undefined) return jsonError(404, 'not_selected', 'That file of the torrent is not one this machine downloads.');
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

  /**
   * The video's length in seconds, once a caller knows it (phase 3's probe): the map turns bytes into seconds with it.
   * `fileIndex` names the episode's video in a season pack; without it, the episode last opened (or on screen).
   */
  async setDuration(infoHash: string, seconds: number, fileIndex?: number): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null || !Number.isFinite(seconds) || seconds <= 0) return;
    const live = this.active.get(hash);
    const rows = live !== undefined ? [...live.rows.values()] : await this.repo.slots(this.host, hash);
    const byIndex = fileIndex === undefined ? undefined : rows.find((r) => r.fileIndex === fileIndex);
    const found = byIndex ?? (live !== undefined ? this.current(live) : await this.rowHere(hash));
    if (found instanceof Response) return;
    await this.repo.duration(this.host, found, seconds, this.now());
    if (live !== undefined && this.active.get(hash) === live) live.rows.set(slotKey(found), { ...found, durationS: seconds });
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
          this.log(`[notesd] torrent: ${live.handle.name}: ${messageOf(err)}`);
        }
      }
      if (this.nowMs() - this.lastPrune >= TORRENT_PRUNE_EVERY_MS) await this.prune();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Deletes this host's downloads not played for `keepDays`, with their folders, then every folder under the torrent
   * dir that no row of this host names and nothing uses now (a torrent left behind by a crash or an older daemon),
   * then whole torrents until the folder is under the budget (`budgetBytes`). Files under the root (the tracker book,
   * the tracker lists) are never touched. The folder sweep is skipped with `sweepOrphans: false` (the shared import
   * still pending). Runs at start, every TORRENT_PRUNE_EVERY_MS and after a download is finished; one at a time.
   * Never throws.
   */
  async prune(): Promise<number> {
    this.pruning ??= this.pruneNow().finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  private async pruneNow(): Promise<number> {
    this.lastPrune = this.nowMs();
    let cleared = 0;
    const held = (hash: string): boolean => this.active.has(hash) || this.opening.has(hash);
    try {
      // A torrent goes when none of its episodes was played (else finished, else made) within keepDays.
      const before = this.nowMs() - this.opts.keepDays * 86_400_000;
      for (const [hash, { touched, name }] of this.lastActivity(await this.hostRows())) {
        if (touched >= before || held(hash)) continue;
        await this.folder.remove(hash);
        await this.repo.delete(this.host, hash);
        cleared += 1;
        this.log(`[notesd] torrent: cleared ${name}, not played for ${this.opts.keepDays} days`);
      }
    } catch (err) {
      this.log(`[notesd] torrent: could not clear old downloads: ${messageOf(err)}`);
    }
    try {
      const named = new Set((await this.hostRows()).map((r) => r.infoHash));
      // Skipped while the shared import is pending; the budget below still runs (it deletes only torrents with a row here).
      for (const hash of this.opts.sweepOrphans === false ? [] : await this.folder.hashes()) {
        if (named.has(hash) || held(hash)) continue;
        await this.folder.remove(hash);
        cleared += 1;
        this.log(`[notesd] torrent: cleared the folder ${hash.slice(0, 8)}, which no download names`);
      }
    } catch (err) {
      this.log(`[notesd] torrent: could not clear folders no download names: ${messageOf(err)}`);
    }
    try {
      cleared += await this.keepBudget(held);
    } catch (err) {
      this.log(`[notesd] torrent: could not keep the downloads under the budget: ${messageOf(err)}`);
    }
    return cleared;
  }

  /**
   * Deletes whole torrents (folder with its remux and cue files, and every row) until the torrent folder takes less
   * than `budgetBytes`. Never one in use. First the downloads of titles the owner marked watched or not interested
   * (`marked`), then the never played ones, oldest first, then the played ones, least recently played first; a
   * download played or finished within TORRENT_RECENT_MS goes only when that was not enough (within each group).
   */
  private async keepBudget(held: (hash: string) => boolean): Promise<number> {
    const budget = this.opts.budgetBytes;
    if (budget === undefined) return 0;
    const sizes = new Map<string, number>();
    for (const hash of await this.folder.hashes()) sizes.set(hash, await this.folder.size(hash));
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (total <= budget) return 0;
    const recentFrom = this.nowMs() - TORRENT_RECENT_MS;
    const rows = await this.hostRows();
    // The titles the owner marked watched or not interested go first, whatever their age.
    const titleOf = (r: Pick<StreamTorrentRow, 'kind' | 'tmdbId'>): string => `${r.kind}-${r.tmdbId}`;
    let marked: ReadonlySet<string> = new Set();
    try {
      marked = (await this.opts.marked?.([...new Set(rows.map(titleOf))])) ?? new Set();
    } catch (err) {
      this.log(`[notesd] torrent: could not read which titles are watched or not interested: ${messageOf(err)}`);
    }
    const dismissed = new Set(rows.filter((r) => marked.has(titleOf(r))).map((r) => r.infoHash));
    const order = [...this.lastActivity(rows)]
      .filter(([hash]) => !held(hash) && (sizes.get(hash) ?? 0) > 0)
      .map(([hash, last]) => ({ hash, ...last, recent: last.touched >= recentFrom, dismissed: dismissed.has(hash) }))
      .sort(
        (a, b) =>
          Number(b.dismissed) - Number(a.dismissed) ||
          Number(a.recent) - Number(b.recent) ||
          Number(a.played !== null) - Number(b.played !== null) ||
          (a.played ?? a.touched) - (b.played ?? b.touched),
      );
    let cleared = 0;
    for (const t of order) {
      if (total <= budget) break;
      const size = sizes.get(t.hash) ?? 0;
      await this.folder.remove(t.hash);
      await this.repo.delete(this.host, t.hash);
      total -= size;
      cleared += 1;
      const why = `${t.dismissed ? 'watched or not interested, ' : ''}${t.played !== null ? `last played ${new Date(t.played).toISOString().slice(0, 10)}` : 'never played'}`;
      this.log(`[notesd] torrent: cleared ${t.name} (${gb(size)}, ${why}): the downloads took more than the ${gb(budget)} budget, ${gb(total)} now`);
    }
    if (total > budget) this.log(`[notesd] torrent: the downloads take ${gb(total)}, over the ${gb(budget)} budget, and what is left is in use`);
    return cleared;
  }

  private async hostRows(): Promise<StreamTorrentRow[]> {
    return (await this.repo.all()).filter((r) => r.host === this.host);
  }

  /**
   * Per torrent, over all its episodes: the last play (null: never played), the last play or finish or make
   * (`touched`), and a name.
   */
  private lastActivity(rows: readonly StreamTorrentRow[]): Map<string, { played: number | null; touched: number; name: string }> {
    const out = new Map<string, { played: number | null; touched: number; name: string }>();
    for (const r of rows) {
      const played = r.playedAt?.getTime() ?? null;
      const touched = Math.max(played ?? 0, (r.completedAt ?? r.createdAt).getTime());
      const was = out.get(r.infoHash);
      out.set(r.infoHash, {
        played: was === undefined ? played : played === null ? was.played : Math.max(played, was.played ?? 0),
        touched: Math.max(touched, was?.touched ?? 0),
        name: was?.name ?? r.name,
      });
    }
    return out;
  }

  private nowMs(): number {
    return this.now().getTime();
  }

  private async openNow(pick: TorrentPick, options: { timeoutMs: number }): Promise<TorrentHandle> {
    const existing = await this.repo.get(this.host, pick.infoHash, pick.ref);
    if (existing !== null && existing.state === 'ready' && sameRef(torrentRef(existing), pick.ref)) {
      const disk = await this.diskHandle(existing);
      if (disk !== null) return disk;
      await this.repo.restarted(this.host, existing, this.now());
      this.log(`[notesd] torrent: ${existing.name} was finished but its files are gone from ${this.folder.dirOf(pick.infoHash)}; downloading it again`);
    }
    // Every episode of the torrent already on this host (a season pack): held beside the one opened now.
    const others = await this.repo.slots(this.host, pick.infoHash);
    const spec = (name: string): TorrentRecordSpec => ({ infoHash: pick.infoHash, ref: pick.ref, name, release: pick.name, trackers: pick.trackers });
    let handle: TorrentHandle;
    try {
      handle = await this.engine.add({ infoHash: pick.infoHash, trackers: pick.trackers, name: pick.name }, options);
    } catch (err) {
      // No row: a torrent whose file list never came holds nothing (most are the race's candidates that did not answer).
      const failure = err instanceof TorrentError ? err : new TorrentError('engine_error', messageOf(err));
      if (failure.code !== 'closing') {
        if (others.length === 0) await this.folder.remove(pick.infoHash).catch(() => undefined);
        this.log(`[notesd] torrent: ${pick.name ?? pick.infoHash}: ${failure.code}: ${failure.message}`);
      }
      throw failure;
    }
    const row = await this.repo.record(this.host, spec(handle.name), this.now());
    // Every episode already chosen from it is held too: its files are kept when the swarm is left, and finish here.
    const rows = new Map(others.map((r) => [slotKey(r), r]));
    rows.set(slotKey(row), row);
    const fresh = others.every((r) => r.state === 'failed');
    this.active.set(pick.infoHash, { handle, users: 0, lastRequestAt: this.nowMs(), rows, slot: slotKey(row), fresh });
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
    // Each episode chosen from the torrent is finished on its own: E01 is ready while E02 still downloads.
    let chosen = 0;
    let finished = 0;
    let readyNow = false;
    for (const row of [...live.rows.values()]) {
      if (row.fileIndex === null) continue;
      chosen += 1;
      // A ready episode of the pack is whole on disk already (another play finished it); it is not downloaded again.
      const done = row.state === 'ready' || row.files.every((f) => live.handle.done(f.index));
      if (done) finished += 1;
      if (done && row.state !== 'ready') {
        live.rows.set(slotKey(row), await this.repo.ready(this.host, row, row.fileLength ?? 0, this.now()));
        readyNow = true;
        const episode = row.kind === 'tv' ? ` S${String(row.season).padStart(2, '0')}E${String(row.episode).padStart(2, '0')}` : '';
        this.log(`[notesd] torrent: ${row.name}${episode} is on disk (${Math.round((row.fileLength ?? 0) / 1_048_576)} MB)`);
      } else if (!done) {
        const bytes = sumRanges(live.handle.ranges(row.fileIndex));
        if (Math.abs(bytes - row.bytesDone) >= PROGRESS_STEP_BYTES) {
          await this.repo.progress(this.host, row, bytes, this.now());
          live.rows.set(slotKey(row), { ...row, bytesDone: bytes });
        }
      }
    }
    // A finished download may take the folder over the budget.
    if (readyNow && this.opts.budgetBytes !== undefined) void this.prune();
    const complete = chosen > 0 && finished === chosen;
    if (live.users > 0) return;
    if (complete) await this.leave(hash, live, 'it is finished and nothing plays it');
    else if (this.nowMs() - live.lastRequestAt >= this.lingerMs) {
      await this.leave(hash, live, `nothing asked for it for ${Math.round(this.lingerMs / 60_000)} min`);
    }
  }

  /**
   * Leaves the swarm. `forget`: the torrent does not play (it lost the race, its open gave up, its file was refused);
   * when this open made its row and nothing of it was ever played or finished, the row and the folder go too.
   */
  private async leave(hash: string, live: Active, why: string, options: { forget?: boolean } = {}): Promise<void> {
    if (this.active.get(hash) !== live) return;
    this.active.delete(hash);
    const rows = [...live.rows.values()];
    const name = live.handle.name;
    if (options.forget === true && live.fresh && rows.every((r) => r.playedAt === null && r.state !== 'ready')) {
      try {
        await this.engine.remove(hash, { deleteFiles: true });
        await this.folder.remove(hash);
        await this.repo.delete(this.host, hash);
      } catch (err) {
        this.log(`[notesd] torrent: could not clear ${name} after leaving its swarm: ${messageOf(err)}`);
      }
      this.log(`[notesd] torrent: left the swarm of ${name} (${hash.slice(0, 8)}) and deleted what it fetched: ${why}`);
      return;
    }
    try {
      await this.engine.remove(hash, { deleteFiles: false });
    } catch (err) {
      this.log(`[notesd] torrent: could not leave the swarm of ${name}: ${messageOf(err)}`);
    }
    try {
      // A file is unchosen only when no episode's row of this torrent chose it (a season pack keeps every episode).
      const stored = await this.repo.slots(this.host, hash);
      const chosen = new Set([...rows, ...stored].flatMap((r) => r.files.map((f) => f.index)));
      await this.folder.dropFiles(hash, live.handle.files.filter((f) => !chosen.has(f.index)).map((f) => f.path));
    } catch (err) {
      this.log(`[notesd] torrent: could not delete the edges of unchosen files of ${name}: ${messageOf(err)}`);
    }
    this.log(`[notesd] torrent: left the swarm of ${name} (${hash.slice(0, 8)}): ${why}`);
  }

  /** The row of the episode last opened. */
  private current(live: Active): StreamTorrentRow {
    const row = live.rows.get(live.slot);
    if (row === undefined) throw new Error(`no row of ${live.handle.name} for ${live.slot}`);
    return row;
  }

  /** A torrent in the swarm opened again, maybe for another episode of its pack: that episode gets its own row. */
  private async takeSlot(live: Active, pick: TorrentPick): Promise<void> {
    const key = slotKey(slotOf(pick.infoHash, pick.ref));
    const had = live.rows.get(key);
    if (had === undefined || !sameRef(torrentRef(had), pick.ref)) {
      const row = await this.repo.record(this.host, { infoHash: pick.infoHash, ref: pick.ref, name: live.handle.name, release: pick.name, trackers: pick.trackers }, this.now());
      live.rows.set(key, row);
    }
    live.slot = key;
  }

  /**
   * This host's row of a hash, or the answer for the other machine's / an unknown one. Of a season pack's rows: the
   * one that chose file `index`; else the episode on screen (played within the last few minutes), else the one last
   * opened, else the one last written.
   */
  private async rowHere(hash: string, index?: number): Promise<StreamTorrentRow | Response> {
    const live = this.active.get(hash);
    const rows = live !== undefined ? [...live.rows.values()] : await this.repo.byHash(hash);
    const here = rows.filter((r) => r.host === this.host);
    if (here.length > 0) {
      const byIndex = index === undefined ? undefined : here.find((r) => r.files.some((f) => f.index === index));
      if (byIndex !== undefined) return byIndex;
      const onScreen = here
        .filter((r) => r.playedAt !== null && this.nowMs() - r.playedAt.getTime() < 3 * PLAYED_EVERY_MS)
        .sort((a, b) => (b.playedAt?.getTime() ?? 0) - (a.playedAt?.getTime() ?? 0))[0];
      return onScreen ?? (live !== undefined ? this.current(live) : here.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!);
    }
    const other = rows[0];
    if (other !== undefined) return notOnThisMachine(other.host);
    return jsonError(404, 'unknown_torrent', 'No torrent download has this info hash.');
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
  /** False while the shared import is pending: no folder a row does not name is swept. */
  sweepOrphans?: boolean;
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
    budgetBytes: t.budgetGb * GIB,
    discovery: t.discovery,
    marked: async (ids) => {
      if (ids.length === 0) return new Set<string>();
      const found = await db
        .select({ id: movieTitles.id })
        .from(movieTitles)
        .where(and(inArray(movieTitles.id, [...ids]), or(isNotNull(movieTitles.watchedAt), isNotNull(movieTitles.notInterestedAt))));
      return new Set(found.map((r) => r.id));
    },
    log,
    ...(overrides.sweepOrphans === undefined ? {} : { sweepOrphans: overrides.sweepOrphans }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}
