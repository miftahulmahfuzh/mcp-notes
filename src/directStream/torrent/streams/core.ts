import path from 'node:path';
import type { StreamTorrentRow } from '../../../db/schema.js';
import { jsonError } from '../../passThrough.js';
import type { TorrentRecords } from '../repo.js';
import { notOnThisMachine } from '../serve.js';
import { DiskHandle, type TorrentFolder } from '../store.js';
import { PLAYED_EVERY_MS, TORRENT_LINGER_MS, TORRENT_TICK_MS, type TorrentEngine, type TorrentFileInfo, type TorrentHandle } from '../types.js';
import type { Active, TorrentStreamsOptions } from './types.js';

/**
 * What every part of TorrentStreams shares: its options and collaborators, the torrents in the swarm (`active`) and
 * being opened (`opening`), the clock, and the row lookups (this host's rows, the row of a hash, the episode last
 * opened). One per TorrentStreams; the swarm lifecycle (torrentStreams.ts, leave.ts), the files (files.ts), the views
 * (views.ts), the originals beside their remux (originals.ts) and the prune (prune.ts) all read and change it.
 */
export class StreamsCore {
  readonly engine: TorrentEngine;
  readonly repo: TorrentRecords;
  readonly folder: TorrentFolder;
  readonly lingerMs: number;
  readonly tickMs: number;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly active = new Map<string, Active>();
  readonly opening = new Map<string, Promise<TorrentHandle>>();
  /** Set once by close(): nothing joins, and the originals sweep stops. */
  closed = false;

  constructor(readonly opts: TorrentStreamsOptions) {
    this.engine = opts.engine;
    this.repo = opts.repo;
    this.folder = opts.folder;
    this.lingerMs = opts.lingerMs ?? TORRENT_LINGER_MS;
    this.tickMs = opts.tickMs ?? TORRENT_TICK_MS;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  get host(): string {
    return this.opts.host;
  }

  nowMs(): number {
    return this.now().getTime();
  }

  /** In the swarm, or being opened: in use. */
  held(hash: string): boolean {
    return this.active.has(hash) || this.opening.has(hash);
  }

  /** The row of the episode last opened. */
  current(live: Active): StreamTorrentRow {
    const row = live.rows.get(live.slot);
    if (row === undefined) throw new Error(`no row of ${live.handle.name} for ${live.slot}`);
    return row;
  }

  async hostRows(): Promise<StreamTorrentRow[]> {
    return (await this.repo.all()).filter((r) => r.host === this.host);
  }

  /**
   * This host's row of a hash, or the answer for the other machine's / an unknown one. Of a season pack's rows: the
   * one that chose file `index`; else the episode on screen (played within the last few minutes), else the one last
   * opened, else the one last written.
   */
  async rowHere(hash: string, index?: number): Promise<StreamTorrentRow | Response> {
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

  /** A DiskHandle over a ready row's chosen files when every one is whole on disk, else null. */
  async diskHandle(row: StreamTorrentRow): Promise<DiskHandle | null> {
    if (row.fileIndex === null || row.files.length === 0) return null;
    const paths = new Map<number, string>();
    for (const f of row.files) {
      if (f.remuxed === true) {
        // It plays as its remux: here as long as the remux is. Nothing reads its original.
        if (this.opts.remuxes?.playable(row.infoHash, f.index) !== true) return null;
        continue;
      }
      const onDisk = await this.folder.complete(row.infoHash, f.path, f.length);
      if (onDisk === null) return null;
      paths.set(f.index, onDisk);
    }
    const files: TorrentFileInfo[] = row.files.map((f) => ({ index: f.index, path: f.path, name: path.basename(f.path), length: f.length }));
    return new DiskHandle(row.infoHash, row.name, files, paths);
  }

  /** A file of the torrent as `TorrentFolder.usage` names it (relative, `/` between names); null when it would leave the folder. */
  relOf(hash: string): (filePath: string) => string | null {
    const dir = this.folder.dirOf(hash);
    return (filePath) => {
      const disk = this.folder.diskPath(hash, filePath);
      return disk === null ? null : path.relative(dir, disk).split(path.sep).join('/');
    };
  }

  /** `/api/stream/torrent/<hash>/f/<index>`. */
  localUrl(infoHash: string, index: number): string {
    return `/api/stream/torrent/${infoHash}/f/${index}`;
  }
}
