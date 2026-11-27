import path from 'node:path';
import type { RemuxKeeper } from '../remuxOnly.js';
import { normalizeInfoHash } from '../types.js';
import type { StreamsCore } from './core.js';
import { allocated, episodeOf, gb, messageOf } from './util.js';

/**
 * A remuxed film keeps one copy: the original beside a whole remux that can stand in for it alone (remuxOnly.ts) is
 * deleted and its file entry marked `remuxed`. Never while the torrent is in the swarm or being opened. An open of a
 * torrent waits for its originals being deleted (`waitFor`), so it reads the row that says so.
 */
export class OriginalsKeeper {
  /** Originals being deleted, by info hash: an open of the torrent waits for it (dropOriginals). */
  private readonly dropping = new Map<string, Promise<number>>();

  constructor(private readonly core: StreamsCore) {}

  /**
   * The deletion of `hash`'s originals running now, or undefined when none runs: an open awaits it. Not async on
   * purpose, so awaiting it takes the same turns as awaiting the map entry did.
   */
  pending(hash: string): Promise<number> | undefined {
    return this.dropping.get(hash);
  }

  /**
   * Once at start: every original that already stands beside a whole remux of it, in a torrent nothing uses, is deleted
   * (dropOriginals), and the remux plays in its place. A file marked as living as its remux whose remux is gone downloads
   * again; what an edge piece left at such a file's path goes. Returns how many originals went. Never throws.
   */
  async sweepRemuxed(): Promise<number> {
    if ((this.core.opts.remuxes ?? null) === null) return 0;
    let dropped = 0;
    try {
      for (const hash of new Set((await this.core.hostRows()).map((r) => r.infoHash))) dropped += await this.dropOriginals(hash, { sweep: true });
    } catch (err) {
      this.core.log(`[notesd] torrent: could not look for originals beside their remux: ${messageOf(err)}`);
    }
    return dropped;
  }

  /**
   * A remuxed film keeps one copy: the original of each ready video of the torrent (`fileIndex`: that one only) whose
   * whole remux can stand in for it alone (remuxOnly.ts: the remux finished and covers the film, its probe is kept, the
   * English text track inside the file is in a complete cue feed) is deleted, and its file entry marked `remuxed`, so
   * nothing fetches or seeds it again and the state survives a restart. Never while the torrent is in the swarm or
   * being opened (it is done when it leaves). One log line per original deleted, with its size. Called when a torrent
   * leaves the swarm, when a remux becomes whole (TorrentRemux.whenDone) and at start. Returns how many went. Never throws.
   */
  async dropOriginals(infoHash: string, options: { fileIndex?: number; sweep?: boolean } = {}): Promise<number> {
    const keeper = this.core.opts.remuxes ?? null;
    const hash = normalizeInfoHash(infoHash);
    if (keeper === null || hash === null || this.core.closed) return 0;
    const before = this.dropping.get(hash) ?? Promise.resolve(0);
    const work = before
      .then(() => this.dropNow(hash, keeper, options))
      .catch((err: unknown) => {
        this.core.log(`[notesd] torrent: could not delete the originals of ${hash.slice(0, 8)} beside their remux: ${messageOf(err)}`);
        return 0;
      });
    this.dropping.set(hash, work);
    try {
      return await work;
    } finally {
      if (this.dropping.get(hash) === work) this.dropping.delete(hash);
    }
  }

  private async dropNow(hash: string, keeper: RemuxKeeper, options: { fileIndex?: number; sweep?: boolean }): Promise<number> {
    const { core } = this;
    if (core.held(hash)) return 0;
    let dropped = 0;
    for (const row of await core.repo.slots(core.host, hash)) {
      if (row.state !== 'ready' || row.fileIndex === null) continue;
      if (options.fileIndex !== undefined && row.fileIndex !== options.fileIndex) continue;
      const video = row.files.find((f) => f.index === row.fileIndex);
      if (video === undefined) continue;
      const label = `${row.name}${episodeOf(row)}`;
      if (video.remuxed === true) {
        if (options.sweep !== true) continue;
        if (!keeper.playable(hash, video.index)) {
          await core.repo.restarted(core.host, row, core.now());
          core.log(`[notesd] torrent: ${label} lived as its remux, and the remux is gone; it downloads again on the next play`);
          continue;
        }
        // What a neighbour's edge piece (or a stop between the mark and the delete) left at the original's path.
        const left = core.folder.diskPath(hash, video.path);
        const size = left === null ? 0 : await allocated(left);
        if (size > 0 && (await core.folder.dropFiles(hash, [video.path])) > 0) {
          core.log(`[notesd] torrent: deleted what was left at the original's path of ${label} (${gb(size)}): it lives as its remux`);
        }
        continue;
      }
      // Only a file with a finished remux; a file Chrome plays as is has none and keeps its original.
      if (!keeper.playable(hash, video.index)) continue;
      const original = await core.folder.complete(hash, video.path, video.length);
      if (original === null) continue;
      const blocker = await keeper.blocker(hash, video.index, original, row.durationS);
      if (blocker !== null) {
        if (options.sweep === true) core.log(`[notesd] torrent: kept the original of ${label} beside its remux: ${blocker}`);
        continue;
      }
      // Something took the torrent while the remux was looked at: it goes when the torrent leaves the swarm.
      if (core.held(hash)) break;
      const size = await allocated(original);
      await core.repo.remuxed(core.host, row, video.index);
      await core.folder.dropFiles(hash, [video.path]);
      dropped += 1;
      core.log(`[notesd] torrent: deleted the original of ${label} (${path.basename(video.path)}, ${gb(size)}): its whole remux plays in its place, one copy on disk`);
    }
    return dropped;
  }
}
