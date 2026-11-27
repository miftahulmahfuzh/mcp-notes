import type { MovieTitleKind, StreamPlayAsked, StreamPlayChannel } from '../../db/schema.js';
import { CachePlayError } from '../cachePlay.js';
import { redactQueries } from '../evidence.js';
import { showsEnglish } from '../outsideSubtitles.js';
import type { StreamSession } from '../sessions.js';
import { namesCloud, namesTorrent, SUBTITLES_PENDING } from '../torrent/source.js';
import { DirectStreamError, type ResolveAttempt, type StreamRef } from '../types.js';
import { PLAY_LOG_DETAIL_MAX, type ChannelFailures } from './types.js';

/** The one attempt of a play refused because the title is not out yet: service.ts's NOT_RELEASED (a test keeps the two equal). */
export const RELEASE_DATE_ATTEMPT = 'Release date';
const SUBTITLE_TIER = 'Subtitles: ';
const SKIPPED = new Set<string>(['skipped', 'skipped_browser_only', 'skipped_no_template']);
/** Which word a channel's attempts end with, the first that any attempt has: a stream found, then what the owner can act on. */
const WORDS = ['resolved', 'bot_check', 'dubbed', 'no_stream', 'unplayable', 'error'] as const;

/** How the ask named its source, as `playDirect` sets the session's lock: a magnet or "torrent", "cloud", a provider by name, or nothing. */
export function askedOf(provider: string | null, magnet: string | null): StreamPlayAsked | null {
  if (magnet !== null) return 'torrent';
  if (provider === null) return null;
  if (namesTorrent(provider)) return 'torrent';
  return namesCloud(provider) ? 'cloud' : 'provider';
}

/** The title's columns: a film has no season or episode. */
export function slotOf(ref: StreamRef): { kind: MovieTitleKind; tmdbId: number; season: number | null; episode: number | null } {
  return ref.kind === 'movie' ? { kind: 'movie', tmdbId: ref.tmdbId, season: null, episode: null } : { kind: 'tv', tmdbId: ref.tmdbId, season: ref.season, episode: ref.episode };
}

/** What a session plays through: a torrent, this host's cache, or a cloud provider through the pass-through. */
export function channelOf(session: StreamSession): Exclude<StreamPlayChannel, 'site'> {
  if (session.torrent !== null) return 'torrent';
  return session.cache !== null ? 'cache' : 'cloud';
}

/** The height that plays: the torrent's file, else the cache's rendition, else the resolver's best. */
export function heightOf(session: StreamSession): number | null {
  return session.torrent?.height ?? session.cache?.height ?? session.source.best_height ?? null;
}

/** A bitrate as the row keeps it: whole kbit/s, or null. */
export function kbpsOf(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value);
}

/**
 * Where the session's English subtitle comes from now: a torrent's subtitle tier (`Subtitles: <tier>`, the tier's
 * name), the torrent's own files (`torrent`), the stream (`stream`), the cache (`cache`), or one from outside the
 * stream (`outside`). Null: none.
 */
export function subtitleSourceOf(session: StreamSession): string | null {
  const torrent = session.torrent;
  if (torrent !== null) {
    const tier = [...session.attempts].reverse().find((a) => a.provider.startsWith(SUBTITLE_TIER) && a.provider !== SUBTITLES_PENDING && a.outcome === 'resolved');
    if (tier !== undefined) return tier.provider.slice(SUBTITLE_TIER.length);
    return showsEnglish(torrent.subtitles) ? 'torrent' : null;
  }
  const own = session.cache === null ? session.source.subtitles : session.cache.subtitles;
  if (showsEnglish(own)) return session.cache === null ? 'stream' : 'cache';
  return session.outside.subtitles.length > 0 ? 'outside' : null;
}

/** The failure's outcome word: a DirectStreamError's or CachePlayError's code, else `error`. */
export function failureOf(err: unknown): string {
  if (err instanceof DirectStreamError || err instanceof CachePlayError) return err.code;
  return 'error';
}

/** The failure's message with every query, fragment and magnet link cut off, at most PLAY_LOG_DETAIL_MAX characters; null when empty. */
export function failureDetailOf(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err);
  const clean = redactQueries(text.replace(/magnet:\?\S*/gi, 'magnet:')).trim();
  return clean === '' ? null : clean.slice(0, PLAY_LOG_DETAIL_MAX);
}

/** Which channel an attempt belongs to; null for a subtitle tier, a streaming site or the release-date refusal. */
function sideOf(provider: string): 'cloud' | 'torrent' | null {
  if (provider === RELEASE_DATE_ATTEMPT || provider.startsWith(SUBTITLE_TIER) || provider.startsWith('Site: ')) return null;
  if (provider === 'WARP' || provider === 'Torrent' || /^(Index|Torrent|Torrents): /.test(provider)) return 'torrent';
  return 'cloud';
}

function wordOf(attempts: readonly ResolveAttempt[]): string {
  for (const word of WORDS) if (attempts.some((a) => a.outcome === word)) return word;
  return attempts[0]?.outcome ?? 'no_source';
}

function cloudWord(all: readonly ResolveAttempt[], code: string, asked: StreamPlayAsked | null): string | null {
  const tried = all.filter((a) => !SKIPPED.has(a.outcome));
  if (tried.length > 0) return wordOf(tried);
  if (all.length > 0) return 'no_source';
  // The cloud resolve could not run (no Chrome): no provider's attempt, and the ask did go to the cloud.
  return code === 'resolve_failed' && asked !== 'torrent' ? 'resolve_failed' : null;
}

function torrentWord(all: readonly ResolveAttempt[], code: string, asked: StreamPlayAsked | null): string | null {
  const tries = all.filter((a) => a.provider.startsWith('Torrent: '));
  if (tries.length > 0) return wordOf(tries);
  const indexes = all.filter((a) => a.provider.startsWith('Index: ') && !SKIPPED.has(a.outcome));
  if (indexes.some((a) => a.outcome === 'bot_check')) return 'bot_check';
  if (indexes.length > 0 && indexes.every((a) => a.outcome === 'error')) return 'error';
  // The indexes answered and no torrent was worth trying: no torrent exists for the title.
  if (all.length > 0) return 'no_source';
  return code === 'torrent_off' && asked !== 'cloud' && asked !== 'provider' ? 'torrent_off' : null;
}

/**
 * The word each channel of a failed ask ended with, read from the failure's attempts (cloud providers by name;
 * `Index:`, `Torrent:`, `Torrents:` and `WARP` for the torrents): so the owner can find, over time, the titles no
 * torrent or no cloud source can play. Null: that channel was not asked. A title not out yet asked neither.
 */
export function channelFailures(asked: StreamPlayAsked | null, err: unknown): ChannelFailures {
  const attempts = err instanceof DirectStreamError ? err.attempts : [];
  if (attempts.some((a) => a.provider === RELEASE_DATE_ATTEMPT)) return { cloud: null, torrent: null };
  const code = failureOf(err);
  const cloud = attempts.filter((a) => sideOf(a.provider) === 'cloud');
  const torrent = attempts.filter((a) => sideOf(a.provider) === 'torrent');
  return { cloud: cloudWord(cloud, code, asked), torrent: torrentWord(torrent, code, asked) };
}
