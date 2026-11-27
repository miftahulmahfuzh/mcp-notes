import type { StreamTorrentFile, StreamTorrentRow } from '../../../db/schema.js';
import type { StreamRef } from '../../types.js';
import { slotOf, torrentRef, type TorrentRecordSpec } from '../repo.js';
import { removalPlan, slotId, type FolderEntry, type SlotKey, type TorrentUsage } from '../usage.js';
import {
  mediaOf,
  normalizeInfoHash,
  PLAYED_EVERY_MS,
  TorrentError,
  type TorrentDownload,
  type TorrentDownloadView,
  type TorrentFileInfo,
  type TorrentHandle,
  type TorrentMap,
  type TorrentPick,
  type TorrentSlotRecord,
  type TorrentStats,
  type TorrentStatus,
} from '../types.js';
import { StreamsCore } from './core.js';
import * as files from './files.js';
import { leave, settle } from './leave.js';
import { OriginalsKeeper } from './originals.js';
import { Pruner } from './prune.js';
import type { Active, FileOnDisk, TorrentStreamsOptions, WholeVideo } from './types.js';
import { episodeOf, gb, messageOf, sameRef, slotKey } from './util.js';
import { statusOf, viewOf } from './views.js';

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * This host's torrent downloads (torrent-stream-source phase 1). Held in AppDeps.torrents; the routes
 * (src/http/streamTorrentApi.ts) and, from phase 3, the stream sessions call it. A torrent is in the swarm
 * only while something uses it; the engine itself runs only while a torrent is in the swarm.
 *
 * This class keeps the swarm lifecycle (open, use, release, drop, discard, the tick) and hands the rest to the
 * modules of streams/: core.ts (the shared state and row lookups), leave.ts (settle and leave), files.ts (paths,
 * Range answers, the map, the Cache page's usage), views.ts, originals.ts (one copy beside a whole remux) and
 * prune.ts (age, orphan folders, budget).
 */
export class TorrentStreams {
  private readonly core: StreamsCore;
  private readonly originals: OriginalsKeeper;
  private readonly pruner: Pruner;
  private readonly every: (fn: () => void, ms: number) => () => void;
  private readonly playedAt = new Map<string, number>();
  private stopTimer: (() => void) | null = null;
  private ticking = false;

  constructor(private readonly opts: TorrentStreamsOptions) {
    this.core = new StreamsCore(opts);
    this.originals = new OriginalsKeeper(this.core);
    this.pruner = new Pruner(this.core, this.originals);
    this.every = opts.every ?? defaultEvery;
  }

  get host(): string {
    return this.opts.host;
  }

  get root(): string {
    return this.core.folder.root;
  }

  get uploadKbps(): number {
    return this.opts.uploadKbps;
  }

  get keepDays(): number {
    return this.opts.keepDays;
  }

  /**
   * Deletes the originals that already stand beside a whole remux of them (sweepRemuxed), clears downloads not played
   * for `keepDays` and starts the tick. Joins nothing. Returns how many downloads were cleared.
   */
  async start(): Promise<number> {
    await this.sweepRemuxed();
    const cleared = await this.prune();
    this.stopTimer ??= this.every(() => void this.tick(), this.core.tickMs);
    return cleared;
  }

  async close(): Promise<void> {
    this.core.closed = true;
    this.stopTimer?.();
    this.stopTimer = null;
    this.core.active.clear();
    await this.core.engine.close();
  }

  /**
   * Opens a torrent for a title and answers once its file list is known, with nothing selected. The same
   * handle while it is open. A download finished on this host for the same title answers from disk.
   */
  async open(pick: TorrentPick, options: { timeoutMs: number }): Promise<TorrentHandle> {
    const { core } = this;
    const infoHash = normalizeInfoHash(pick.infoHash);
    if (infoHash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    if (core.closed) throw new TorrentError('closing', 'The daemon is stopping.');
    // An original being deleted beside its remux: the open reads the row that says so.
    await this.originals.pending(infoHash);
    const live = core.active.get(infoHash);
    if (live !== undefined) {
      live.lastRequestAt = core.nowMs();
      await this.takeSlot(live, { ...pick, infoHash });
      return live.handle;
    }
    const pending = core.opening.get(infoHash);
    if (pending !== undefined) {
      const handle = await pending;
      const opened = core.active.get(infoHash);
      if (opened !== undefined) await this.takeSlot(opened, { ...pick, infoHash });
      return handle;
    }
    const opened = this.openNow({ ...pick, infoHash }, options).finally(() => core.opening.delete(infoHash));
    core.opening.set(infoHash, opened);
    return opened;
  }

  /**
   * Selects these files (videos and subtitles only) and counts one more user. On a finished download read
   * from disk it does nothing (nothing joins a swarm). Throws not_open, not_media, invalid_hash.
   */
  async use(infoHash: string, fileIndexes: readonly number[]): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    const live = this.core.active.get(hash);
    if (live === undefined) {
      if (await this.readyOnDisk(hash, fileIndexes)) return;
      throw new TorrentError('not_open', 'Open the torrent before using its files.');
    }
    await this.useIn(hash, live, fileIndexes, null);
  }

  /**
   * `use` for one named episode of a torrent in the swarm (a season download takes every wanted episode of a pack this
   * way, one hold each): that episode's row, made now when there is none, takes the files, whatever episode was opened
   * last. Two episodes on one file (a double episode) each keep their own row. On a finished download read from disk
   * it does nothing. Throws not_open, not_media, invalid_hash.
   */
  async useSlot(pick: TorrentPick, fileIndexes: readonly number[]): Promise<void> {
    const hash = normalizeInfoHash(pick.infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    const live = this.core.active.get(hash);
    if (live === undefined) {
      if (await this.readyOnDisk(hash, fileIndexes)) return;
      throw new TorrentError('not_open', 'Open the torrent before using its files.');
    }
    live.lastRequestAt = this.core.nowMs();
    await this.takeSlot(live, { ...pick, infoHash: hash });
    await this.useIn(hash, live, fileIndexes, slotKey(slotOf(hash, pick.ref)));
  }

  /** A ready row of this host that chose every one of these files, whole on disk: nothing to join. */
  private async readyOnDisk(hash: string, fileIndexes: readonly number[]): Promise<boolean> {
    const { core } = this;
    for (const row of await core.repo.slots(core.host, hash)) {
      if (row.state === 'ready' && fileIndexes.every((i) => row.files.some((f) => f.index === i)) && (await core.diskHandle(row)) !== null) return true;
    }
    return false;
  }

  /** `use` on a torrent in the swarm. `key`: the episode's row that takes the files; null: as `use` has always chosen. */
  private async useIn(hash: string, live: Active, fileIndexes: readonly number[], key: string | null): Promise<void> {
    const { core } = this;
    const chosen = this.mediaFiles(live.handle, fileIndexes);
    // A video that lives as its remux is never fetched again: its original was deleted on purpose.
    const remuxed = new Set([...live.rows.values()].flatMap((r) => r.files.filter((f) => f.remuxed === true).map((f) => f.index)));
    live.handle.select(chosen.filter((f) => !remuxed.has(f.index)).map((f) => f.index));
    live.users += 1;
    live.lastRequestAt = core.nowMs();
    // The episode named; else the one whose row already holds these files (a reload takes its torrent again), else the one last opened.
    const named = key === null ? undefined : live.rows.get(key);
    const row = named ?? [...live.rows.values()].find((r) => chosen.every((c) => r.files.some((f) => f.index === c.index))) ?? core.current(live);
    const files: StreamTorrentFile[] = row.files.map((f) => ({ ...f }));
    for (const f of chosen) if (!files.some((m) => m.index === f.index)) files.push({ index: f.index, path: f.path, length: f.length });
    const fileIndex = row.fileIndex ?? chosen.find((f) => mediaOf(f.name) === 'video')?.index ?? null;
    const fileLength = files.find((f) => f.index === fileIndex)?.length ?? null;
    try {
      live.rows.set(slotKey(row), await core.repo.chosen(core.host, row, { files, fileIndex, fileLength }, core.now()));
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
    const { core } = this;
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : core.active.get(hash);
    if (hash === null || live === undefined) return;
    live.lastRequestAt = core.nowMs();
    if (live.users === 0) {
      await leave(core, this.originals, hash, live, 'it was opened and never used', { forget: true });
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
          core.log(`[notesd] torrent: could not pause ${hash.slice(0, 8)}: ${messageOf(err)}`);
        }
      }
      await settle(core, this.pruner, this.originals, hash, live);
    }
  }

  /**
   * Gives back the hold one episode took with `useSlot` and stops fetching that episode's own files (the ones no other
   * episode of the torrent chose, and not whole yet): a season download whose episode was cancelled. The episode's row
   * and what is on disk stay. With no hold left the torrent goes as after `release`. Unknown or not in the swarm: ignored.
   */
  async releaseSlot(infoHash: string, ref: StreamRef): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.core.active.get(hash);
    if (hash === null || live === undefined) return;
    const key = slotKey(slotOf(hash, ref));
    const row = live.rows.get(key);
    if (row !== undefined) {
      const others = new Set([...live.rows.values()].filter((r) => slotKey(r) !== key).flatMap((r) => r.files.map((f) => f.index)));
      const stop = row.files.map((f) => f.index).filter((i) => !others.has(i) && !live.handle.done(i));
      if (stop.length > 0) {
        try {
          live.handle.deselect?.(stop);
        } catch (err) {
          this.core.log(`[notesd] torrent: could not stop ${row.name}${episodeOf(row)}: ${messageOf(err)}`);
        }
      }
    }
    await this.release(hash);
  }

  /**
   * Gives back a hold taken with `use`, and with none left the swarm is left at once, finished or not: a torrent
   * that lost the choice to another, or whose file does not play. Only for a caller whose `use` answered; one
   * that opened the torrent and used nothing calls `discard`. Unknown: ignored.
   */
  async drop(infoHash: string): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.core.active.get(hash);
    if (hash === null || live === undefined) return;
    if (live.users > 0) live.users -= 1;
    if (live.users === 0) await leave(this.core, this.originals, hash, live, 'it is not the torrent that plays', { forget: true });
  }

  /**
   * For a caller that opened a torrent and took no hold of it (its open gave up, it holds no file of the title,
   * another torrent was chosen first): the swarm is left at once when nothing uses the torrent. A hold another
   * caller took is never touched, so a torrent a session plays stays in the swarm. Unknown: ignored.
   */
  async discard(infoHash: string): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.core.active.get(hash);
    if (hash === null || live === undefined || live.users > 0) return;
    await leave(this.core, this.originals, hash, live, 'it is not the torrent that plays', { forget: true });
  }

  /**
   * The player page reported a position of this torrent's session: it really plays, so its download is kept for
   * `keepDays` from now. Written at most once a minute per torrent; the file route's own reads (the header probe,
   * ffmpeg, a subtitle tier) never mark a play. Unknown or the other machine's: ignored. Never throws.
   */
  async played(infoHash: string, fileIndex?: number): Promise<void> {
    const { core } = this;
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return;
    const at = core.nowMs();
    const throttle = `${hash}:${fileIndex ?? ''}`;
    if (at - (this.playedAt.get(throttle) ?? Number.NEGATIVE_INFINITY) < PLAYED_EVERY_MS) return;
    this.playedAt.set(throttle, at);
    try {
      const live = core.active.get(hash);
      const rows = live !== undefined ? [...live.rows.values()] : await core.repo.slots(core.host, hash);
      // The episode whose video plays; without its index, the episode last opened.
      const row = rows.find((r) => fileIndex !== undefined && r.fileIndex === fileIndex) ?? (live !== undefined ? core.current(live) : rows[0]);
      if (row === undefined) return;
      await core.repo.played(core.host, row, core.now());
      if (live !== undefined && core.active.get(hash) === live) live.rows.set(slotKey(row), { ...row, playedAt: core.now() });
    } catch (err) {
      core.log(`[notesd] torrent: could not mark ${hash.slice(0, 8)} played: ${messageOf(err)}`);
    }
  }

  /** The peers connected and the download rate of a torrent in the swarm, now; null when it is not in it. */
  stats(infoHash: string): TorrentStats | null {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.core.active.get(hash);
    return live === undefined ? null : live.handle.stats();
  }

  /** The release name this host's row of a torrent keeps (as the index listed it), else its swarm name; null without a row. */
  async releaseName(infoHash: string): Promise<string | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const row = await this.core.repo.get(this.host, hash);
    return row === null ? null : (row.release ?? row.name ?? null);
  }

  /** The trackers this host's row of a torrent keeps; [] without a row (a download opened again by its info hash). */
  async trackersOf(infoHash: string): Promise<string[]> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return [];
    return (await this.core.repo.get(this.host, hash))?.trackers ?? [];
  }

  /** Bytes the torrent received from peers since it was opened; null when it is not in the swarm or its handle cannot say. */
  received(infoHash: string): number | null {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.core.active.get(hash);
    return live?.handle.received?.() ?? null;
  }

  /** This host's best record of a title with a chosen video: a ready one first, then the most recent. */
  async find(ref: StreamRef): Promise<TorrentDownload | null> {
    for (const stored of await this.core.repo.forRef(this.host, ref)) {
      const row = this.core.active.get(stored.infoHash)?.rows.get(slotKey(stored)) ?? stored;
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

  /** This host's rows of a title slot (every torrent opened for that film or episode), for the candidates list. */
  async downloadsOf(ref: StreamRef): Promise<TorrentSlotRecord[]> {
    return (await this.core.repo.forRef(this.host, ref)).map((stored) => {
      const row = this.core.active.get(stored.infoHash)?.rows.get(slotKey(stored)) ?? stored;
      return { infoHash: row.infoHash, name: row.name, release: row.release, state: row.state, error: row.error, playedAt: row.playedAt, fileLength: row.fileLength };
    });
  }

  /** One download: this host's, else the other machine's (`available: false`); null when none. */
  async view(infoHash: string): Promise<TorrentDownloadView | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.core.rowHere(hash);
    if (!(found instanceof Response)) return viewOf(this.core, found);
    const rows = await this.core.repo.byHash(hash);
    return rows[0] === undefined ? null : viewOf(this.core, rows[0]);
  }

  /** Every download of both machines, newest first. */
  async list(): Promise<TorrentDownloadView[]> {
    return (await this.core.repo.all()).map((row) => viewOf(this.core, row.host === this.host ? (this.core.active.get(row.infoHash)?.rows.get(slotKey(row)) ?? row) : row));
  }

  status(): TorrentStatus {
    return statusOf(this.core);
  }

  /** files.ts: the absolute path of a chosen file once it is whole on this machine's disk, else null. */
  async filePath(infoHash: string, index: number): Promise<string | null> {
    return files.filePath(this.core, infoHash, index);
  }

  /** files.ts: true when this host's chosen video lives as its whole remux only (its original was deleted). */
  async remuxOnly(infoHash: string, index: number): Promise<boolean> {
    return files.remuxOnly(this.core, infoHash, index);
  }

  /** files.ts: file `index` of a torrent as it is on this machine's disk now, for the seek previews. Holds nothing. */
  async onDisk(infoHash: string, index: number): Promise<FileOnDisk | null> {
    return files.onDisk(this.core, infoHash, index);
  }

  /** files.ts: GET /api/stream/torrent/:hash/f/:index, from disk when whole, else through the swarm. */
  async serve(infoHash: string, index: number, rangeHeader: string | null): Promise<Response> {
    return files.serve(this.core, infoHash, index, rangeHeader);
  }

  /** files.ts: the video's stretches on this machine's disk; null for an unknown hash or the other machine's. */
  async map(infoHash: string): Promise<TorrentMap | null> {
    return files.map(this.core, infoHash);
  }

  /** files.ts: how much of one chosen file is on this machine's disk now, for a download's progress. */
  async fileProgress(infoHash: string, fileIndex: number): Promise<{ bytesDone: number; length: number } | null> {
    return files.fileProgress(this.core, infoHash, fileIndex);
  }

  /**
   * The video's length in seconds, once a caller knows it (phase 3's probe): the map turns bytes into seconds with it.
   * `fileIndex` names the episode's video in a season pack; without it, the episode last opened (or on screen).
   */
  async setDuration(infoHash: string, seconds: number, fileIndex?: number): Promise<void> {
    const { core } = this;
    const hash = normalizeInfoHash(infoHash);
    if (hash === null || !Number.isFinite(seconds) || seconds <= 0) return;
    const live = core.active.get(hash);
    const rows = live !== undefined ? [...live.rows.values()] : await core.repo.slots(core.host, hash);
    const byIndex = fileIndex === undefined ? undefined : rows.find((r) => r.fileIndex === fileIndex);
    const found = byIndex ?? (live !== undefined ? core.current(live) : await core.rowHere(hash));
    if (found instanceof Response) return;
    await core.repo.duration(core.host, found, seconds, core.now());
    if (live !== undefined && core.active.get(hash) === live) live.rows.set(slotKey(found), { ...found, durationS: seconds });
  }

  localUrl(infoHash: string, index: number): string {
    return this.core.localUrl(infoHash, index);
  }

  /**
   * True while the torrent is being opened or something holds it (a stream session, the next episode fetched ahead, the
   * open route): the Cache page shows it as playing and nothing deletes it. A torrent only waiting to leave the swarm
   * (nobody uses it) is not in use.
   */
  inUse(infoHash: string): boolean {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return false;
    return this.core.opening.has(hash) || (this.core.active.get(hash)?.users ?? 0) > 0;
  }

  /**
   * The owner's mark on a torrent of this host (a download they asked for): kept, the age prune and the budget leave
   * it alone until it is deleted on the Cache page; not kept, it prunes like any other. Every row of the torrent.
   */
  async keep(infoHash: string, kept: boolean): Promise<void> {
    const { core } = this;
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return;
    const at = kept ? core.now() : null;
    await core.repo.setKept(core.host, hash, at);
    const live = core.active.get(hash);
    if (live !== undefined) for (const [key, row] of live.rows) live.rows.set(key, { ...row, keptAt: at });
  }

  /** files.ts: what this host's torrents take on disk, for the Cache page. Never the other host's. */
  async diskUsage(): Promise<{ torrents: { infoHash: string; rows: StreamTorrentRow[]; usage: TorrentUsage }[]; unnamedBytes: number; budgetBytes: number | null }> {
    return files.diskUsage(this.core);
  }

  /** files.ts: this host's chosen videos that are whole on disk now, for the seek previews' sweep. Holds nothing. */
  async wholeVideos(): Promise<WholeVideo[]> {
    return files.wholeVideos(this.core);
  }

  /**
   * Deletes these episodes of a torrent (a film: season 0, episode 0) from this host, the way the prune does: with no
   * episode of it left, the whole folder (with its remux and cue files) and every row; else each deleted episode's row
   * and the files only deleted episodes own (its video, its remux, its cues), keeping what a kept episode chose and
   * the pack's shared files. A torrent only waiting to leave the swarm leaves it first. Nothing is blacklisted: the
   * torrent may be fetched again. Throws in_use while it is being opened or something holds it. Returns the bytes freed.
   */
  async removeSlots(infoHash: string, slots: readonly SlotKey[]): Promise<number> {
    const { core } = this;
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    if (this.inUse(hash)) throw new TorrentError('in_use', 'This torrent plays or is being fetched now.');
    const live = core.active.get(hash);
    if (live !== undefined) await leave(core, this.originals, hash, live, 'its download was deleted from the Cache page');
    const rows = await core.repo.slots(core.host, hash);
    const gone = new Set(slots.map(slotId));
    const deleting = rows.filter((r) => gone.has(slotId(r)));
    if (deleting.length === 0) return 0;
    const entries: FolderEntry[] = await core.folder.usage(hash);
    const plan = removalPlan(rows, gone, entries, core.relOf(hash));
    const name = rows[0]?.name ?? hash.slice(0, 8);
    if (plan.all) {
      await core.folder.remove(hash);
      await core.repo.delete(core.host, hash);
    } else {
      await core.folder.removeInside(hash, plan.rels);
      for (const row of deleting) await core.repo.deleteSlot(core.host, row);
    }
    const what = deleting.some((r) => r.kind === 'tv') ? ` ${deleting.map((r) => `S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`).join(', ')}` : '';
    core.log(`[notesd] torrent: deleted ${name}${what} (${gb(plan.bytes)}) from the Cache page`);
    return plan.bytes;
  }

  /** The timer's work: progress, finished downloads, idle torrents leaving, and now and then the prune. */
  async tick(): Promise<void> {
    const { core } = this;
    if (this.ticking || core.closed) return;
    this.ticking = true;
    try {
      for (const [hash, live] of [...core.active]) {
        try {
          await settle(core, this.pruner, this.originals, hash, live);
        } catch (err) {
          core.log(`[notesd] torrent: ${live.handle.name}: ${messageOf(err)}`);
        }
      }
      if (this.pruner.due()) await this.prune();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Deletes this host's downloads not played for `keepDays`, with their folders, then every folder under the torrent
   * dir that no row of this host names and nothing uses now (a torrent left behind by a crash or an older daemon),
   * then each original that may go beside its whole remux (dropOriginals), then whole torrents until the folder is
   * under the budget (`budgetBytes`). Files under the root (the tracker book, the tracker lists) are never touched.
   * The folder sweep is skipped with `sweepOrphans: false` (the shared import still pending). Runs at start, every TORRENT_PRUNE_EVERY_MS and after a download is finished; one at a time.
   * Never throws. (prune.ts)
   */
  async prune(): Promise<number> {
    return this.pruner.prune();
  }

  /** originals.ts: once at start, every original beside a whole remux of it in a torrent nothing uses is deleted. Never throws. */
  async sweepRemuxed(): Promise<number> {
    return this.originals.sweepRemuxed();
  }

  /** originals.ts: a remuxed film keeps one copy, never while the torrent is in the swarm or being opened. Never throws. */
  async dropOriginals(infoHash: string, options: { fileIndex?: number; sweep?: boolean } = {}): Promise<number> {
    return this.originals.dropOriginals(infoHash, options);
  }

  private async openNow(pick: TorrentPick, options: { timeoutMs: number }): Promise<TorrentHandle> {
    const { core } = this;
    const existing = await core.repo.get(core.host, pick.infoHash, pick.ref);
    if (existing !== null && existing.state === 'ready' && sameRef(torrentRef(existing), pick.ref)) {
      const disk = await core.diskHandle(existing);
      if (disk !== null) return disk;
      await core.repo.restarted(core.host, existing, core.now());
      core.log(`[notesd] torrent: ${existing.name} was finished but its files are gone from ${core.folder.dirOf(pick.infoHash)}; downloading it again`);
    }
    // Every episode of the torrent already on this host (a season pack): held beside the one opened now.
    const others = await core.repo.slots(core.host, pick.infoHash);
    const spec = (name: string): TorrentRecordSpec => ({ infoHash: pick.infoHash, ref: pick.ref, name, release: pick.name, trackers: pick.trackers });
    let handle: TorrentHandle;
    try {
      handle = await core.engine.add({ infoHash: pick.infoHash, trackers: pick.trackers, name: pick.name }, options);
    } catch (err) {
      // No row: a torrent whose file list never came holds nothing (most are the race's candidates that did not answer).
      const failure = err instanceof TorrentError ? err : new TorrentError('engine_error', messageOf(err));
      if (failure.code !== 'closing') {
        if (others.length === 0) await core.folder.remove(pick.infoHash).catch(() => undefined);
        core.log(`[notesd] torrent: ${pick.name ?? pick.infoHash}: ${failure.code}: ${failure.message}`);
      }
      throw failure;
    }
    const row = await core.repo.record(core.host, spec(handle.name), core.now());
    // Every episode already chosen from it is held too: its files are kept when the swarm is left, and finish here.
    const rows = new Map(others.map((r) => [slotKey(r), r]));
    rows.set(slotKey(row), row);
    const fresh = others.every((r) => r.state === 'failed');
    core.active.set(pick.infoHash, { handle, users: 0, lastRequestAt: core.nowMs(), rows, slot: slotKey(row), fresh });
    core.log(`[notesd] torrent: joined the swarm of ${handle.name} (${pick.infoHash.slice(0, 8)}), ${handle.files.length} files, nothing chosen yet`);
    return handle;
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

  /** A torrent in the swarm opened again, maybe for another episode of its pack: that episode gets its own row. */
  private async takeSlot(live: Active, pick: TorrentPick): Promise<void> {
    const { core } = this;
    const key = slotKey(slotOf(pick.infoHash, pick.ref));
    const had = live.rows.get(key);
    if (had === undefined || !sameRef(torrentRef(had), pick.ref)) {
      const row = await core.repo.record(core.host, { infoHash: pick.infoHash, ref: pick.ref, name: live.handle.name, release: pick.name, trackers: pick.trackers }, core.now());
      live.rows.set(key, row);
    }
    live.slot = key;
  }
}
