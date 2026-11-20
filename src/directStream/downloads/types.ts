import type { StreamDownloadSource, StreamDownloadState, StreamDownloadVia } from '../../db/schema.js';
import type { KeptState, TorrentResolveOptions } from '../torrent/source.js';
import type { StreamRef } from '../types.js';

/**
 * Downloads the owner asks for (stream-downloads phase 2): one film or one episode at a time, persisted in
 * stream_downloads (written by DownloadsRepo only), kept on this machine until it is deleted on the Cache page.
 * These are the shapes the engine, its seams and (phase 4) the routes share.
 */

export type DownloadVia = StreamDownloadVia;
export type DownloadState = StreamDownloadState;
export type DownloadSource = StreamDownloadSource;

/** Which torrents a step may take: 1080p with live seeds (`preferred`), or below 1080p (`below`; 2160p is never taken unasked). */
export type TorrentBand = 'preferred' | 'below';

/** How a torrent step asks: by band (the indexes are asked), or one torrent by its info hash (a pick, a carry-on). */
export type TorrentAsk = { band: TorrentBand } | { infoHash: string };

/** What the owner asked for. `infoHash` only with `via: 'torrent'` (a torrent picked from the candidates list). */
export interface DownloadAsk {
  via: DownloadVia;
  infoHash?: string | null;
  /** The season click that made it (phase 3); null otherwise. */
  batch?: string | null;
}

/** What `request` answers: the row (null when the title is already whole here), and whether it was made by this ask. */
export interface DownloadRequestAnswer {
  download: DownloadView | null;
  created: boolean;
  /** The film or episode is already whole on this machine (a ready torrent download or cache): nothing was queued. */
  onDisk: boolean;
}

/** One download as `GET /api/stream/downloads` (phase 4) answers it. */
export interface DownloadView {
  id: string;
  host: string;
  /** True when the row is this machine's. */
  available: boolean;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  /** Null for a film. */
  season: number | null;
  /** Null for a film. */
  episode: number | null;
  via: DownloadVia;
  info_hash: string | null;
  batch: string | null;
  /** `queued` also while the cloud cache holds it behind another of its downloads. */
  state: DownloadState;
  /** What it downloads from once one was found; null before. */
  source: DownloadSource | null;
  /** The torrent's info hash or the stream cache's id. */
  source_id: string | null;
  /** 0 to 1. */
  progress: number;
  bytes_done: number;
  /** Null when unknown (a cloud cache counts segments, not bytes). */
  bytes_total: number | null;
  /** The torrent's peers and download rate now; null for a cloud download or a torrent not in the swarm. */
  peers: number | null;
  down_kbps: number | null;
  /** Why it failed: `no_source`, `no_peers_here`, `dubbed`, `download_failed`, `torrent_off`, `cloud_off` or a cache's code. */
  error: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export type DownloadErrorCode = 'invalid_request' | 'downloads_off' | 'unknown_download';

/** A request the engine refuses (phase 4 maps it to HTTP: 400, 503, 404). */
export class DownloadError extends Error {
  override readonly name = 'DownloadError';
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The title facts a torrent search needs (DirectStreamService.downloadFacts). */
export type DownloadFacts = Pick<TorrentResolveOptions, 'audioLang' | 'imdbId' | 'names'>;

/** A torrent held for a download: what the engine knows of it. The adapter keeps the session torrent behind it. */
export interface KeptTorrentHandle {
  readonly infoHash: string;
  readonly fileIndex: number;
  readonly name: string;
}

/** A torrent step's answer: the torrent now downloading (`detail`: its name and height), or why none could be. */
export type TorrentFetch = { ok: true; handle: KeptTorrentHandle; detail: string } | { ok: false; error: 'no_source' | 'dubbed'; detail: string };

/** A held torrent now: KeptState plus its bytes and swarm. */
export type TorrentNow = KeptState & { bytesDone: number; bytesTotal: number | null; peers: number | null; downKbps: number | null };

/** The torrent side of the engine (torrentDownloadsOf over TorrentSource and TorrentStreams; tests pass a fake). */
export interface DownloadTorrents {
  /** True when this host holds a finished torrent download of `ref`. */
  onDisk(ref: StreamRef): Promise<boolean>;
  fetch(ref: StreamRef, ask: TorrentAsk): Promise<TorrentFetch>;
  now(handle: KeptTorrentHandle): Promise<TorrentNow>;
  /** Starts a failed remux again (once the file is whole). */
  retryRemux(handle: KeptTorrentHandle): Promise<void>;
  /** Lets go of the torrent: with no other user the daemon leaves its swarm. Safe twice. */
  release(handle: KeptTorrentHandle): void;
  /** Sets or clears the owner's mark that both prunes skip. */
  keep(infoHash: string, kept: boolean): Promise<void>;
}

/** A stream cache as the engine follows it. */
export interface CacheNow {
  id: string;
  state: 'downloading' | 'ready' | 'failed';
  running: boolean;
  queued: boolean;
  progress: number;
  bytes: number;
  maxHeight: number | null;
  error: string | null;
  errorDetail: string | null;
}

/** The cloud side of the engine (cacheDownloadsOf over StreamCache; tests pass a fake). */
export interface DownloadCaches {
  /** True when this host holds a ready cache of `ref`. */
  onDisk(ref: StreamRef): Promise<boolean>;
  /** The owner's cache of `ref` at `maxHeight` or lower (an existing cache of another height carries on at its own). */
  request(ref: StreamRef, maxHeight: number): Promise<CacheNow>;
  find(ref: StreamRef): Promise<CacheNow | null>;
  /** Stops the cache's download, keeping what is on disk. */
  pause(ref: StreamRef): Promise<boolean>;
}
