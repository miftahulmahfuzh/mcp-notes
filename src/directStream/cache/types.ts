import path from 'node:path';
import type { StreamCacheKind, StreamCacheState } from '../../db/schema.js';

/**
 * The stream cache (STREAM_CACHE_AND_BUG_REPORT phase 5): one film or episode downloaded to this
 * host's disk, recorded in stream_caches. These are the shapes its parts, routes and tool share.
 */

/** Where the caches live under the data directory when NOTESD_STREAM_CACHE_DIR is unset. */
export const STREAM_CACHE_SUBDIR = path.join('movies', 'stream-cache');

/** A cache id is the row's uuid. Checked before any lookup, so a malformed id never reaches Postgres. */
export const CACHE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One cache as every route and the tool answer it. */
export interface StreamCacheView {
  id: string;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  /** Null for a film. */
  season: number | null;
  /** Null for a film. */
  episode: number | null;
  /** The machine whose disk holds the files. */
  host: string;
  /** True when `host` is this machine: its files can be served and it can be cleared here. */
  available: boolean;
  state: StreamCacheState;
  /** A download runs now on this machine. */
  running: boolean;
  /** Waiting for another download to finish. */
  queued: boolean;
  provider: string | null;
  manifest_kind: StreamCacheKind | null;
  height: number | null;
  max_height: number | null;
  audio_lang: string | null;
  subtitle: boolean;
  segments_total: number;
  segments_done: number;
  /** segments_done / segments_total, 0 to 1. */
  progress: number;
  bytes: number;
  duration_s: number | null;
  resolves: number;
  error: string | null;
  error_detail: string | null;
  /** `/api/stream/cache/<id>/f/master.m3u8` or `.../video.mp4`; null on the other machine or before the source is known. */
  playlist_url: string | null;
  /** `/api/stream/cache/<id>/f/subtitle.vtt`; null without an English subtitle or on the other machine. */
  subtitle_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type CacheErrorCode = 'unknown_cache' | 'not_on_this_machine' | 'cache_exists';

/** A request the cache refuses (src/http/streamCacheApi.ts maps it to HTTP; the tool answers it as JSON). */
export class CacheError extends Error {
  override readonly name = 'CacheError';
  constructor(
    readonly code: CacheErrorCode,
    message: string,
    readonly extra: { host?: string; cache?: StreamCacheView } = {},
  ) {
    super(message);
  }
}

/** Why a download stopped for good: written to stream_caches.error. */
export type CacheFailureCode =
  | 'cache_unsupported'
  | 'no_source'
  | 'resolve_failed'
  | 'download_failed'
  | 'token_refused'
  | 'source_changed'
  | 'disk_error';

export class CacheFailure extends Error {
  override readonly name = 'CacheFailure';
  constructor(
    readonly code: CacheFailureCode,
    message: string,
  ) {
    super(message);
  }
}
