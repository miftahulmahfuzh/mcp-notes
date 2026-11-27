import type { StreamTorrentRow } from '../../../db/schema.js';
import type { RemuxKeeper } from '../remuxOnly.js';
import type { TorrentRecords } from '../repo.js';
import type { TorrentFolder } from '../store.js';
import type { TorrentEngine, TorrentHandle } from '../types.js';

/**
 * One chosen file of a torrent as this machine's disk holds it now (TorrentStreams.onDisk). `whole`: at its full
 * length. `partial`: the byte stretches whose pieces are verified on disk, `[from, to)`, in order; empty when the
 * torrent is not in the swarm and nothing says which pieces are there.
 */
export type FileOnDisk =
  | { readonly kind: 'whole'; readonly path: string; readonly length: number }
  | { readonly kind: 'partial'; readonly path: string; readonly length: number; readonly ranges: readonly [number, number][] };

/** A chosen video of this host that is whole on disk: as its file, or as its finished remux alone (its original was deleted). */
export type WholeVideo = { readonly infoHash: string; readonly fileIndex: number; readonly durationS: number | null } & (
  | { readonly via: 'file'; readonly path: string }
  | { readonly via: 'remux' }
);

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
   * Says whether a remuxed video's remux can stand in for its original alone (remuxOnly.ts). Set: once it can and nothing
   * uses the torrent, the original is deleted and the remux is the one copy. Unset (the remux off, tests): never.
   */
  remuxes?: RemuxKeeper | null;
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

/** A torrent in the swarm. A finished download read from disk is never one. Internal to streams/. */
export interface Active {
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
