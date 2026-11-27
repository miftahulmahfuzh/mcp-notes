import type { AppDeps } from '../../deps.js';
import { PlayLogRepo } from './repo.js';

/**
 * The stream health view (stream-play-log phase 3): GET /api/stream/health, the direct_stream_health tool and the
 * /movies/health page all answer from `readHealth`. Reads only; PlayLogRepo's writes are phase 1's.
 *
 * A play that reached the screen is a successful streaming attempt whatever its length (the owner tests torrents with
 * short plays): `played` counts outcome `played` and `site` (a streaming site's player ran), and nothing here counts a
 * short play as a failure. Watched minutes are no headline: only the per-hour stall rate uses them.
 */

export const HEALTH_DEFAULT_DAYS = 7;
export const HEALTH_MAX_DAYS = 90;
/** How many of the period's plays `recent` lists, newest first. */
export const HEALTH_RECENT_LIMIT = 30;
/** How many films and episodes `unhandled` lists at most (over all time). */
export const HEALTH_UNHANDLED_LIMIT = 200;

export type PlayOutcome = 'failed' | 'no_picture' | 'played' | 'site';

/** One stream_play_log row as the health view reads it, with its title's name and movie id. */
export interface HealthRow {
  id: number;
  asked_at: Date;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  asked: string | null;
  outcome: PlayOutcome;
  failure: string | null;
  cloud_failure: string | null;
  torrent_failure: string | null;
  resolve_ms: number | null;
  channel: string | null;
  provider_first: string | null;
  torrent_index: string | null;
  height: number | null;
  first_frame_ms: number | null;
  played_ms: number;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  ended: string | null;
  /** movie_titles.title, else the title key (`movie-603`) for a title the library does not store. */
  title: string;
  movie_id: string | null;
}

/** A film or episode whose last ask failed and that has not played since (all time). */
export interface UnhandledEntry {
  title: string;
  movie_id: string | null;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  /** Failed asks since its last successful play (all of them when it never played). */
  asks: number;
  last_asked_at: string;
  /** The word of its latest failed ask that asked the cloud providers; null: never asked there. */
  cloud_failure: string | null;
  /** The word of its latest failed ask that asked the torrents; null: never asked there. */
  torrent_failure: string | null;
}

export interface Figures {
  asks: number;
  failed: number;
  no_picture: number;
  /** Plays that reached the screen, however short (outcome played or site). */
  played: number;
  /** played / asks; null with no ask. */
  success_rate: number | null;
  /** Ask to answer, over the asks that got a player (no_picture, played, site). */
  median_resolve_ms: number | null;
  /** Page load to first frame, over the plays that reported one. */
  median_first_frame_ms: number | null;
  played_hours: number;
  /** Stalls per hour played; null when nothing played. */
  stalls_per_hour: number | null;
  /** Time stood still per time played (stalled_ms / played_ms); null when nothing played. */
  stalled_share: number | null;
  /** Share of the plays whose height is known that played at 1080p or better; null when none is known. */
  hd_share: number | null;
}

export interface SourceFigures extends Figures {
  channel: string;
  /** A cloud play's first provider, a torrent play's index (`disk` without one), else the channel. */
  source: string;
}

export interface FailureCount {
  channel: string;
  failure: string;
  count: number;
}

export interface RecentPlay {
  id: number;
  asked_at: string;
  title: string;
  movie_id: string | null;
  season: number | null;
  episode: number | null;
  channel: string | null;
  source: string | null;
  outcome: PlayOutcome;
  failure: string | null;
  height: number | null;
  resolve_ms: number | null;
  first_frame_ms: number | null;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  ended: string | null;
}

export interface HealthAnswer {
  host: string;
  days: number;
  since: string;
  first_logged_at: string | null;
  totals: Record<string, Figures>;
  by_source: SourceFigures[];
  failures: FailureCount[];
  recent: RecentPlay[];
  unhandled: UnhandledEntry[];
}

/** What readHealth needs of PlayLogRepo; tests pass an in-memory one. */
export interface PlayLogReader {
  healthRows(host: string, since: Date): Promise<HealthRow[]>;
  firstAskedAt(host: string): Promise<Date | null>;
  unhandled(host: string, limit: number): Promise<UnhandledEntry[]>;
}

/** What the route and the tool call: the answer for the last `days` days on this host. */
export interface StreamHealthReader {
  read(days: number): Promise<HealthAnswer>;
}

/** The channels always in `totals`, zeros included, so an empty period still answers per channel (R2.4). */
const ALWAYS = ['all', 'cloud', 'torrent'] as const;
const CHANNEL_ORDER = ['torrent', 'cloud', 'cache', 'site', 'none'];

const round = (x: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

const isPlayed = (r: HealthRow): boolean => r.outcome === 'played' || r.outcome === 'site';

/**
 * The channels a row counts under. A row with a channel counts there. A failed ask with no channel counts under every
 * channel it asked (its cloud_failure / torrent_failure), else under the one `asked` names, else `none`.
 */
export function channelsOf(r: HealthRow): string[] {
  if (r.channel !== null) return [r.channel];
  if (r.outcome !== 'failed') return ['none'];
  const asked: string[] = [];
  if (r.cloud_failure !== null) asked.push('cloud');
  if (r.torrent_failure !== null) asked.push('torrent');
  if (asked.length > 0) return asked;
  if (r.asked === 'torrent') return ['torrent'];
  if (r.asked === 'cloud' || r.asked === 'provider') return ['cloud'];
  return ['none'];
}

/** The provider or index a row played through, or null for a failed ask that never reached a channel. */
export function sourceOf(r: HealthRow): string | null {
  if (r.channel === null) return null;
  if (r.channel === 'torrent') return r.torrent_index ?? 'disk';
  return r.provider_first ?? r.channel;
}

/** The middle value (the mean of the two middle ones, rounded), or null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function figures(rows: readonly HealthRow[]): Figures {
  const asks = rows.length;
  const played = rows.filter(isPlayed);
  const playedMs = rows.reduce((n, r) => n + r.played_ms, 0);
  const stalls = rows.reduce((n, r) => n + r.stalls, 0);
  const stalledMs = rows.reduce((n, r) => n + r.stalled_ms, 0);
  const hours = playedMs / 3_600_000;
  const sized = played.filter((r) => r.height !== null);
  return {
    asks,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    no_picture: rows.filter((r) => r.outcome === 'no_picture').length,
    played: played.length,
    success_rate: asks === 0 ? null : round(played.length / asks, 3),
    median_resolve_ms: median(rows.filter((r) => r.outcome !== 'failed' && r.resolve_ms !== null).map((r) => r.resolve_ms!)),
    median_first_frame_ms: median(played.filter((r) => r.first_frame_ms !== null).map((r) => r.first_frame_ms!)),
    played_hours: round(hours, 2),
    stalls_per_hour: playedMs === 0 ? null : round(stalls / hours, 2),
    stalled_share: playedMs === 0 ? null : round(stalledMs / playedMs, 4),
    hd_share: sized.length === 0 ? null : round(sized.filter((r) => r.height! >= 1080).length / sized.length, 3),
  };
}

const channelRank = (c: string): number => {
  const i = CHANNEL_ORDER.indexOf(c);
  return i === -1 ? CHANNEL_ORDER.length : i;
};

/** The word a failed row ended with on one channel. */
function failureWord(r: HealthRow, channel: string): string {
  if (channel === 'cloud') return r.cloud_failure ?? r.failure ?? 'unknown';
  if (channel === 'torrent') return r.torrent_failure ?? r.failure ?? 'unknown';
  return r.failure ?? 'unknown';
}

/** The Health answer from the period's rows (newest first), the first row's time and the unhandled list. */
export function buildHealth(input: {
  host: string;
  days: number;
  since: Date;
  rows: readonly HealthRow[];
  firstLoggedAt: Date | null;
  unhandled: readonly UnhandledEntry[];
}): HealthAnswer {
  const byChannel = new Map<string, HealthRow[]>();
  const bySource = new Map<string, { channel: string; source: string; rows: HealthRow[] }>();
  const failures = new Map<string, FailureCount>();
  for (const r of input.rows) {
    for (const c of channelsOf(r)) {
      const list = byChannel.get(c) ?? [];
      list.push(r);
      byChannel.set(c, list);
      if (r.outcome === 'failed') {
        const word = failureWord(r, c);
        const key = `${c}\u0000${word}`;
        const f = failures.get(key) ?? { channel: c, failure: word, count: 0 };
        f.count += 1;
        failures.set(key, f);
      }
    }
    const source = sourceOf(r);
    if (source !== null && r.channel !== null) {
      const key = `${r.channel}\u0000${source}`;
      const s = bySource.get(key) ?? { channel: r.channel, source, rows: [] };
      s.rows.push(r);
      bySource.set(key, s);
    }
  }
  const totals: Record<string, Figures> = {};
  totals.all = figures(input.rows);
  for (const c of ALWAYS) if (c !== 'all') totals[c] = figures(byChannel.get(c) ?? []);
  for (const c of [...byChannel.keys()].sort((a, b) => channelRank(a) - channelRank(b))) if (totals[c] === undefined) totals[c] = figures(byChannel.get(c)!);
  return {
    host: input.host,
    days: input.days,
    since: input.since.toISOString(),
    first_logged_at: input.firstLoggedAt === null ? null : input.firstLoggedAt.toISOString(),
    totals,
    by_source: [...bySource.values()]
      .map((s) => ({ channel: s.channel, source: s.source, ...figures(s.rows) }))
      .sort((a, b) => channelRank(a.channel) - channelRank(b.channel) || b.asks - a.asks || a.source.localeCompare(b.source)),
    failures: [...failures.values()].sort((a, b) => b.count - a.count || channelRank(a.channel) - channelRank(b.channel) || a.failure.localeCompare(b.failure)),
    recent: input.rows.slice(0, HEALTH_RECENT_LIMIT).map((r) => ({
      id: r.id,
      asked_at: r.asked_at.toISOString(),
      title: r.title,
      movie_id: r.movie_id,
      season: r.season,
      episode: r.episode,
      channel: r.channel,
      source: sourceOf(r),
      outcome: r.outcome,
      failure: r.failure,
      height: r.height,
      resolve_ms: r.resolve_ms,
      first_frame_ms: r.first_frame_ms,
      stalls: r.stalls,
      stalled_ms: r.stalled_ms,
      waits: r.waits,
      waited_ms: r.waited_ms,
      ended: r.ended,
    })),
    unhandled: [...input.unhandled],
  };
}

/** The answer for the `days` days before `now` on `host`. `days` is already 1..HEALTH_MAX_DAYS (the route and the tool check it). */
export async function readHealth(reader: PlayLogReader, host: string, days: number, now: Date): Promise<HealthAnswer> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [rows, firstLoggedAt, unhandled] = await Promise.all([reader.healthRows(host, since), reader.firstAskedAt(host), reader.unhandled(host, HEALTH_UNHANDLED_LIMIT)]);
  return buildHealth({ host, days, since, rows, firstLoggedAt, unhandled });
}

/**
 * The reader the route and the tool share, or null with the movie library off (no host to read for). Builds a
 * PlayLogRepo over the daemon's Db per daemon, as /api/movies/trending builds its TrendingRepo: it holds no state.
 */
export function streamHealthReader(deps: Pick<AppDeps, 'db' | 'movies'>, now: () => Date = () => new Date()): StreamHealthReader | null {
  const movies = deps.movies;
  if (movies === null || movies === undefined) return null;
  const repo = new PlayLogRepo(deps.db);
  return { read: (days) => readHealth(repo, movies.host, days, now()) };
}
