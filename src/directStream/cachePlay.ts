import { isEnglish, refLabel, type ManifestKind, type ResolvedSource, type SourceAudio, type StreamRef } from './types.js';

/**
 * Playing from the stream cache (STREAM_CACHE_AND_BUG_REPORT phase 6). The cache itself (table
 * stream_caches, the downloader, the file route under /api/stream/cache/<id>/f/) is phase 5's
 * StreamCache in src/directStream/cache/; this module names only what a play reads from it, so the
 * service depends on this shape and not on the downloader.
 */

export type CacheState = 'downloading' | 'ready' | 'failed';

/** One subtitle file of a cache (WebVTT), served by the cache's file route; a torrent session's subtitles have the same shape. */
export interface CacheSubtitleView {
  /** Relative to the daemon's origin: `/api/stream/cache/<id>/f/<file>`, a torrent's `/sub/` route, or a cue feed. */
  url: string;
  lang: string | null;
  label: string;
  /**
   * A cue feed (`GET /api/stream/torrent/:hash/cues/:track`): `url` answers JSON cues after an
   * index, and the player reads it again until it is complete. Absent: `url` is a WebVTT file.
   */
  growing?: true;
}

/** One stream cache as a play reads it (phase 5's StreamCache answers it). */
export interface CachePlayView {
  /** The cache's own id (a uuid), never a movie id. */
  id: string;
  ref: StreamRef;
  /** The machine whose disk holds the files (os.hostname()). */
  host: string;
  state: CacheState;
  /** The provider the cache was downloaded from. */
  provider: string;
  /** The cached rendition's height; null when the manifest did not say. */
  height: number | null;
  /** The local manifest: one rendition's HLS playlist, or a plain file. DASH is never cached. */
  manifestKind: Extract<ManifestKind, 'hls' | 'mp4'>;
  /** The local playlist or file, relative to the daemon's origin: `/api/stream/cache/<id>/f/...`. */
  manifestUrl: string;
  subtitles: CacheSubtitleView[];
  /** The original language the cache's resolve was told (`--audio-lang`); null when it was not known. */
  audioLang: string | null;
  /** What that resolve heard in the stream; null when it was not asked. */
  audio: SourceAudio | null;
}

/** What DirectStreamService reads from phase 5's StreamCache (AppDeps.streamCache). */
export interface PlayableCaches {
  /** This host's cache of `ref` in any state (the newest when there are several), or null. */
  find(ref: StreamRef): Promise<CachePlayView | null>;
  /** The cache with this id on any host, or null when there is none or it was deleted. */
  get(id: string): Promise<CachePlayView | null>;
  /**
   * Starts this host's cache of `ref` for the player page (a paused play; `auto`), or carries a
   * failed one on; a ready or running one is left as it is. Answers where it stands. Without it
   * a paused play caches nothing.
   */
  start?(ref: StreamRef): Promise<CacheStanding>;
  /** Where this host's cache of `ref` stands, without starting anything; null: there is none. */
  standing?(ref: StreamRef): Promise<CacheStanding | null>;
}

/** A cache as a paused play follows it, before it can be played too (its source is not known yet). */
export interface CacheStanding {
  id: string;
  state: CacheState;
  /** `stream_caches.error` of a failed one (`cache_unsupported`, `download_failed`, ...). */
  error: string | null;
  /** segments_done / segments_total, 0 to 1. */
  progress: number;
}

/** The cache a stream session plays from. A failed cache cannot be one: a session never holds it. */
export interface SessionCache {
  id: string;
  state: Exclude<CacheState, 'failed'>;
  height: number | null;
  manifestUrl: string;
  subtitles: CacheSubtitleView[];
}

/** Why a cache is not played. */
export type CacheRefusal = 'other_host' | 'failed' | 'other_language';

export type Playable = { ok: true; cache: SessionCache } | { ok: false; refusal: CacheRefusal };

/**
 * Whether this host may play `view`: its files must be on this host's disk, it must not have
 * failed, and when the title's original language is known the cache must have been resolved for
 * exactly that language (a stream plays in the original language only; a cache resolved without
 * it, or for another, could hold a dub).
 */
export function playable(view: CachePlayView, host: string, audioLang: string | null): Playable {
  if (view.host !== host) return { ok: false, refusal: 'other_host' };
  const state = view.state;
  if (state === 'failed') return { ok: false, refusal: 'failed' };
  if (audioLang !== null && view.audioLang !== audioLang) return { ok: false, refusal: 'other_language' };
  return { ok: true, cache: { id: view.id, state, height: view.height, manifestUrl: view.manifestUrl, subtitles: view.subtitles } };
}

/**
 * The ResolvedSource a cached session carries, so whatever reads `session.source` (the provider of
 * movie_plays and of the stream on screen, phase 1's snapshot) reads the cache's. Its manifest
 * address is the local, relative one, so `sourceHosts` finds no stream host: the pass-through
 * refuses every address for a cached session (`forbidden_host`), and nothing here is a token.
 */
export function cacheSource(view: CachePlayView): ResolvedSource {
  return {
    provider: view.provider,
    embed_url: '',
    manifest_url: view.manifestUrl,
    manifest_kind: view.manifestKind,
    headers: { referer: null, origin: null, user_agent: null },
    subtitles: [],
    best_height: view.height,
    en_subtitle: view.subtitles.some((t) => isEnglish(t)),
    audio: view.audio,
    took_s: null,
  };
}

export type CachePlayErrorCode = 'unknown_cache' | 'not_on_this_machine' | 'cache_failed' | 'cache_language';

/** A cache that `POST /api/stream/cache/:id/play` cannot play (src/http/streamCachePlayApi.ts maps it to HTTP). */
export class CachePlayError extends Error {
  override name = 'CachePlayError';

  constructor(
    readonly code: CachePlayErrorCode,
    message: string,
    /** `not_on_this_machine`: the host that holds the files. */
    readonly host: string | null = null,
  ) {
    super(message);
  }
}

/** The error a refusal answers when a cache is asked for by id. */
export function cacheRefusalError(view: CachePlayView, refusal: CacheRefusal, audioLang: string | null): CachePlayError {
  switch (refusal) {
    case 'other_host':
      return new CachePlayError('not_on_this_machine', `That stream cache is on ${view.host}, not on this machine.`, view.host);
    case 'failed':
      return new CachePlayError('cache_failed', 'That stream cache failed to download, so it cannot be played.');
    case 'other_language':
      return new CachePlayError(
        'cache_language',
        `That stream cache was made for ${view.audioLang ?? 'an unknown language'}, and ${refLabel(view.ref)} is in ${audioLang ?? 'an unknown language'}.`,
      );
  }
}

/** A cache id as phase 5 makes them (a uuid); anything else names no cache. One definition: phase 5's. */
export { CACHE_ID_PATTERN } from './cache/types.js';
