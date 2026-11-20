import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StreamTorrentState } from '../../db/schema.js';
import type { StreamRef } from '../types.js';

/**
 * Torrents as a direct-streaming source (torrent-stream-source phase 1): the shapes the engine, the
 * service, the routes and the later phases share. A torrent is named by its v1 info hash, 40 lower-case
 * hexadecimal characters, checked once where it enters (normalizeInfoHash).
 */

/** Where the downloads live under the data directory when NOTESD_TORRENT_DIR is unset. */
export const TORRENT_SUBDIR = path.join('movies', 'torrents');
/** How long `open` waits for a peer to send the file list. */
export const TORRENT_OPEN_TIMEOUT_MS = 60_000;
/** An unfinished torrent nothing uses leaves the swarm this long after its last file request. */
export const TORRENT_LINGER_MS = 3 * 60_000;
/** How often the service records progress, marks finished downloads and lets idle torrents go. */
export const TORRENT_TICK_MS = 5_000;
/** How often downloads not played for `keepDays` are looked for. */
export const TORRENT_PRUNE_EVERY_MS = 6 * 3_600_000;
/** Progress is written to the database at most once per this many new bytes (Neon egress). */
export const PROGRESS_STEP_BYTES = 16 * 1_048_576;
/** `played_at` is written at most once per minute per download. */
export const PLAYED_EVERY_MS = 60_000;
/** Bytes per second in one kB/s of NOTESD_TORRENT_UPLOAD_KBPS. */
export const BYTES_PER_KB = 1000;

/** Bytes per second as kilobits per second, the unit of the stream evidence log's `kbps` and the views' `*_kbps`. */
export function kilobits(bytesPerSecond: number): number {
  return Math.round((bytesPerSecond * 8) / 1000);
}

export const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/;

/** A v1 info hash in any case, trimmed and lower-cased; null for anything else. */
export function normalizeInfoHash(raw: string): string | null {
  const hash = raw.trim().toLowerCase();
  return INFO_HASH_PATTERN.test(hash) ? hash : null;
}

const VIDEO_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
};
const SUBTITLE_TYPES: Readonly<Record<string, string>> = {
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
};

export type TorrentMedia = 'video' | 'subtitle';

/** What a torrent file is by its extension: the only two kinds notesd ever selects, reads or serves. */
export function mediaOf(name: string): TorrentMedia | null {
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(VIDEO_TYPES, ext)) return 'video';
  if (Object.hasOwn(SUBTITLE_TYPES, ext)) return 'subtitle';
  return null;
}

/** The content type a chosen file is served with; never one a browser would run. */
export function torrentContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_TYPES[ext] ?? SUBTITLE_TYPES[ext] ?? 'application/octet-stream';
}

/** One file of a torrent: its index in the torrent, its path inside it (the torrent's name first), its size. */
export interface TorrentFileInfo {
  index: number;
  path: string;
  name: string;
  length: number;
}

/** A torrent's swarm now. Speeds in kilobits per second; all 0 for a download read from disk. */
export interface TorrentStats {
  peers: number;
  down_kbps: number;
  up_kbps: number;
}

/** An open torrent: from the swarm (`live`), or a finished download read from disk with no swarm. */
export interface TorrentHandle {
  readonly infoHash: string;
  readonly name: string;
  /** The swarm handle: every file of the torrent. A disk handle: the chosen files only. */
  readonly files: readonly TorrentFileInfo[];
  /** True while the pieces come from the swarm; false for a finished download read from disk. */
  readonly live: boolean;
  /** Downloads these files (in order); never anything else. A disk handle ignores it. */
  select(indexes: readonly number[]): void;
  /** Stops fetching these files ahead (a file route's read still fetches its own range). Absent: a disk handle, tests' fakes. */
  deselect?(indexes: readonly number[]): void;
  /** Bytes start..end of one file, `end` inclusive, in order; the swarm fetches their pieces first. */
  read(index: number, range: { start: number; end: number }): Readable;
  stats(): TorrentStats;
  /** Bytes received from peers since the torrent was opened (any piece, verified or not); absent: unknown (a disk handle, tests' fakes). */
  received?(): number;
  /** The stretches of one file that are on disk, `[from, to)` byte offsets, in order, never touching. */
  ranges(index: number): [number, number][];
  done(index: number): boolean;
}

export interface TorrentAddSpec {
  infoHash: string;
  /** Asked only with discovery on. */
  trackers: readonly string[];
  /** For the log; the torrent's own name comes with its file list. */
  name: string | null;
}

/** Joins swarms. WebTorrentEngine is the real one; tests inject a fake. */
export interface TorrentEngine {
  /** Resolves once a peer sent the file list (nothing selected); rejects TorrentError no_metadata / unsafe_path / engine_error / closing. */
  add(spec: TorrentAddSpec, options: { timeoutMs: number }): Promise<TorrentHandle>;
  get(infoHash: string): TorrentHandle | null;
  /** Leaves the swarm. `deleteFiles` also deletes the torrent's folder. */
  remove(infoHash: string, options: { deleteFiles: boolean }): Promise<void>;
  /** The listening port while any torrent is in the swarm, else null (no engine runs). */
  port(): number | null;
  close(): Promise<void>;
}

/** What a caller opens: a torrent for a title. */
export interface TorrentPick {
  infoHash: string;
  trackers: readonly string[];
  /** The release name as an index lists it (stored as the download's `release`); null when unknown. */
  name: string | null;
  ref: StreamRef;
  /** What the finder knows of the release (phase 2's ReleaseInfo). Not read in phase 1. */
  release?: unknown;
}

/** This host's record of a title's download with a chosen video (TorrentStreams.find). */
export interface TorrentDownload {
  infoHash: string;
  host: string;
  /** The torrent's own name. */
  name: string;
  release: string | null;
  fileIndex: number;
  fileLength: number | null;
  state: StreamTorrentState;
  durationS: number | null;
}

export interface TorrentFileView {
  index: number;
  path: string;
  length: number;
  media: TorrentMedia | null;
}

/** One download as the routes answer it. */
export interface TorrentDownloadView {
  info_hash: string;
  /** The machine whose disk holds the files. */
  host: string;
  /** True when `host` is this machine. */
  available: boolean;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  /** The torrent's own name. */
  name: string;
  /** The release name the index listed. */
  release: string | null;
  state: StreamTorrentState;
  error: string | null;
  /** The video among `files`; null before one was chosen. */
  file_index: number | null;
  file_length: number | null;
  /** The chosen files only. */
  files: TorrentFileView[];
  bytes_done: number;
  /** bytes_done / file_length, 0 to 1. */
  progress: number;
  duration_s: number | null;
  in_swarm: boolean;
  users: number;
  peers: number;
  down_kbps: number;
  up_kbps: number;
  /** `/api/stream/torrent/<hash>/f/<video index>`; null on the other machine or before a choice. */
  file_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  played_at: string | null;
}

/** `GET /api/stream/torrent/:hash/map`: the video's stretches on disk. */
export interface TorrentMap {
  /** Null until a caller set it (TorrentStreams.setDuration). */
  duration_s: number | null;
  /** `byte_ranges` in seconds by proportion; empty while `duration_s` is null. */
  ranges: [number, number][];
  length: number | null;
  /** `[from, to)` byte offsets of the video, in order. */
  byte_ranges: [number, number][];
}

export interface TorrentSwarmView extends TorrentStats {
  info_hash: string;
  name: string;
  users: number;
}

/** `GET /api/stream/torrent`: this machine's engine. */
export interface TorrentStatus {
  host: string;
  /** The engine's listening port; null while no torrent is in the swarm. */
  port: number | null;
  upload_cap_bytes_per_s: number;
  keep_days: number;
  discovery: boolean;
  swarm: TorrentSwarmView[];
}

export type TorrentErrorCode =
  | 'invalid_hash'
  | 'unknown_torrent'
  | 'not_on_this_machine'
  | 'not_open'
  | 'not_media'
  | 'no_metadata'
  | 'unsafe_path'
  | 'engine_error'
  | 'closing';

export class TorrentError extends Error {
  override readonly name = 'TorrentError';
  constructor(
    readonly code: TorrentErrorCode,
    message: string,
    readonly extra: { host?: string } = {},
  ) {
    super(message);
  }
}

/** One host's row of a torrent for one film or episode, as the candidates list reads it (TorrentStreams.downloadsOf). */
export interface TorrentSlotRecord {
  infoHash: string;
  name: string;
  release: string | null;
  state: 'downloading' | 'ready' | 'failed';
  error: string | null;
  playedAt: Date | null;
  fileLength: number | null;
}
