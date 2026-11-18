import { LookupError, lookupTitle, type LookupDeps, type TitleCandidate } from '../directStream/lookup.js';
import type { RememberedChannel, StreamRef } from '../directStream/types.js';
import type { MoviesRepo } from '../movies/repo.js';
import type { MovieStreams } from '../movies/streams.js';
import type { MovieSiteTitleRow, TitleKind } from '../movies/types.js';
import { STREAMING_SITES, type StreamingRunner, type StreamingSite } from './service.js';

/**
 * A streaming site's player that started, as `claude/streaming/cli.mjs` reports it after a play
 * (the /idlix, /lk21, /flicksy and /dramacool skills and the streaming tools all run that command).
 * `url` is the title's page on the site, as its search returned it; `season` and `episode` are the
 * site's own numbers, null for a film. A play started by its address alone (`--play-url`) knows no
 * name: it carries `url` only.
 */
export interface SitePlayReport {
  site: StreamingSite;
  url: string;
  name?: string | null;
  original_name?: string | null;
  year?: number | null;
  kind?: 'movie' | 'series' | null;
  season?: number | null;
  episode?: number | null;
}

/** What became of a report: the title it was kept under, or why it was not kept. */
export type SitePlayOutcome =
  | { recorded: true; title_id: string; season: number | null; episode: number | null }
  /** No title of that name and year is known: it is kept by what the site says of it (movie_site_titles). */
  | { recorded: true; title_id: null; site_title_id: number; season: number | null; episode: number | null }
  | { recorded: false; reason: 'no_name' | 'no_match' | 'several_matches' | 'tmdb_unavailable' | 'not_stored'; candidates?: string[] };

export interface SitePlaysDeps {
  /** The stored titles and TMDB, as the direct-stream tools look a title up. */
  lookup: LookupDeps;
  streams: Pick<MovieStreams, 'recordSitePlay'>;
  /** Keeps a title TMDB does not list (`siteTitleKeeper`); unset: such a play is not kept. */
  siteTitles?: (report: SitePlayReport) => Promise<number | null>;
  log?: (line: string) => void;
}

/** A title TMDB does not list, as the routes answer it (`GET /api/movies/stream` `site_titles`). */
export interface SiteTitleView {
  id: number;
  site: string;
  site_url: string;
  kind: 'movie' | 'series';
  name: string;
  year: number | null;
  poster_url: string | null;
  overview: string;
  country: string | null;
  status: string | null;
  genres: string[];
  also_known: string | null;
  /** The episode last played; null for a film. */
  season: number | null;
  episode: number | null;
  played_at: string;
}

export function siteTitleView(row: MovieSiteTitleRow): SiteTitleView {
  return {
    id: row.id,
    site: row.site,
    site_url: row.siteUrl,
    kind: row.kind,
    name: row.name,
    year: row.year,
    poster_url: row.posterUrl,
    overview: row.overview,
    country: row.country,
    status: row.status,
    genres: row.genres,
    also_known: row.alsoKnown,
    season: row.season,
    episode: row.episode,
    played_at: row.playedAt.toISOString(),
  };
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

/**
 * Keeps a played title TMDB does not list: what the site's own page says of it is read through the
 * streaming command (`--details`; a site whose module reads none answers null) and stored with the
 * play. A page that cannot be read keeps the title by its name alone. Answers the row's id.
 */
export function siteTitleKeeper(deps: { repo: Pick<MoviesRepo, 'keepSiteTitle'>; host: string; runner: StreamingRunner | null; now?: () => Date; log?: (line: string) => void }): (report: SitePlayReport) => Promise<number | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  return async (report) => {
    const name = (report.name ?? '').trim();
    if (name === '') return null;
    let details: Record<string, unknown> = {};
    if (deps.runner !== null) {
      try {
        const answer = (await deps.runner(report.site, ['--details', report.url])) as { details?: unknown } | null;
        if (answer !== null && typeof answer.details === 'object' && answer.details !== null) details = answer.details as Record<string, unknown>;
      } catch (err) {
        log(`[notesd] streaming: ${report.site} did not say more of ${report.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const poster = text(details.poster_url, 500);
    const kind = report.kind === 'movie' ? 'movie' : 'series';
    const row = await deps.repo.keepSiteTitle({
      host: deps.host,
      site: report.site,
      siteUrl: report.url,
      kind,
      name: name.slice(0, 300),
      year: report.year ?? (typeof details.year === 'number' && Number.isInteger(details.year) ? details.year : null),
      posterUrl: poster !== null && /^https:\/\//.test(poster) ? poster : null,
      overview: text(details.overview, 4000),
      country: text(details.country, 100),
      status: text(details.status, 100),
      genres: Array.isArray(details.genres) ? details.genres.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((g) => g.trim().slice(0, 60)).slice(0, 20) : [],
      alsoKnown: text(details.also_known, 300),
      season: kind === 'series' ? (report.season ?? 1) : null,
      episode: kind === 'series' ? (report.episode ?? 1) : null,
      at: (deps.now ?? (() => new Date()))(),
    });
    return row.id;
  };
}

function isSite(value: string): value is StreamingSite {
  return (STREAMING_SITES as readonly string[]).includes(value);
}

/**
 * The stored or TMDB title a site's result is. A site that lists every title as a list of
 * episodes (dramacool) calls a film a series too, so a one-episode "series" no series matches is
 * looked up as a film. A later season is a title of its own on such a site, dated by its own year:
 * it is looked up without the year when the year finds nothing.
 */
async function titleOf(report: SitePlayReport, deps: LookupDeps): Promise<{ candidate: TitleCandidate } | { reason: 'no_match' | 'several_matches'; candidates: string[] }> {
  const name = (report.name ?? '').trim();
  const year = report.year ?? null;
  const first: TitleKind = report.kind === 'movie' ? 'movie' : 'tv';
  const tries: Array<{ name: string; year: number | null; kind: TitleKind }> = [{ name, year, kind: first }];
  const original = (report.original_name ?? '').trim();
  if (original !== '' && original !== name) tries.push({ name: original, year, kind: first });
  if (first === 'tv' && year !== null && (report.season ?? 1) > 1) tries.push({ name, year: null, kind: 'tv' });
  if (first === 'tv' && (report.season ?? 1) === 1 && (report.episode ?? 1) === 1) tries.push({ name, year, kind: 'movie' });
  let several: string[] = [];
  for (const t of tries) {
    const found = await lookupTitle({ by: 'words', name: t.name, year: t.year, kind: t.kind }, deps);
    if (found.status === 'one') return { candidate: found.candidate };
    if (found.status === 'several' && several.length === 0) several = found.candidates.map((c) => `${c.kind}-${c.tmdbId}`);
  }
  return several.length > 0 ? { reason: 'several_matches', candidates: several } : { reason: 'no_match', candidates: [] };
}

/**
 * Keeps a site's play in the movie store: the title is found by its name and year (stored titles
 * first, then TMDB), stored when it is new, and gets one play row with the site as its provider and
 * the site as the channel it is streamed through from now on. Never throws for a title it cannot
 * place: the answer says why.
 */
export async function recordSitePlay(report: SitePlayReport, deps: SitePlaysDeps): Promise<SitePlayOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  if ((report.name ?? '').trim() === '') return { recorded: false, reason: 'no_name' };
  let found: Awaited<ReturnType<typeof titleOf>>;
  try {
    found = await titleOf(report, deps.lookup);
  } catch (err) {
    if (!(err instanceof LookupError)) throw err;
    log(`[notesd] streaming: the play of ${report.name} on ${report.site} is not kept: ${err.message}`);
    return { recorded: false, reason: 'tmdb_unavailable' };
  }
  if (!('candidate' in found)) {
    if (found.reason === 'no_match' && deps.siteTitles !== undefined) {
      const id = await deps.siteTitles(report);
      if (id !== null) {
        log(`[notesd] streaming: ${report.name} played on ${report.site}; TMDB does not list it, so it is kept by what the site says of it`);
        const series = report.kind !== 'movie';
        return { recorded: true, title_id: null, site_title_id: id, season: series ? (report.season ?? 1) : null, episode: series ? (report.episode ?? 1) : null };
      }
    }
    log(`[notesd] streaming: the play of ${report.name} on ${report.site} is not kept: ${found.reason === 'no_match' ? 'no title of that name and year is known' : `several titles carry that name (${found.candidates.join(', ')})`}`);
    return { recorded: false, reason: found.reason, ...(found.candidates.length > 0 ? { candidates: found.candidates } : {}) };
  }
  const c = found.candidate;
  const episode = c.kind === 'tv' ? (report.episode ?? null) : null;
  const season = c.kind === 'tv' ? (report.season ?? 1) : null;
  if (c.kind === 'tv' && episode === null) return { recorded: false, reason: 'no_name' };
  const written = await deps.streams.recordSitePlay(c.kind === 'tv' ? { kind: 'tv', tmdbId: c.tmdbId, season, episode } : { kind: 'movie', tmdbId: c.tmdbId }, report.site, report.url);
  if (written === null) return { recorded: false, reason: 'not_stored' };
  log(`[notesd] streaming: ${c.title}${c.kind === 'tv' ? ` S${season}E${episode}` : ''} played on ${report.site}; it is streamed from there from now on`);
  return { recorded: true, title_id: written.titleId, season, episode };
}

/** What a play sent back to its streaming site answers: the site's own answer, and where it played. */
export interface SiteReplay {
  site: StreamingSite;
  /** The title's page on the site. */
  url: string;
  /** `cli.mjs`'s `play` object: `playing: true` with `fullscreen`, `duration_s`. */
  play: unknown;
}

export function playing(answer: unknown): unknown | null {
  const play = (answer as { play?: { playing?: unknown } } | null)?.play;
  return play !== undefined && play !== null && play.playing === true ? play : null;
}

/**
 * Plays `ref` on the streaming site its title was last played through, when that is how it was last
 * streamed. Null when it was not, when the site does not have the episode at that address, or when
 * its player did not start: the caller then streams it the usual way. The play is kept here
 * (`--no-report` stops the command from reporting it a second time).
 */
export async function replayOnSite(
  ref: StreamRef,
  known: RememberedChannel | null,
  deps: { runner: StreamingRunner | null; streams: Pick<MovieStreams, 'recordSitePlay'>; log?: (line: string) => void },
): Promise<SiteReplay | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (deps.runner === null || known === null || known.channel !== 'site' || known.provider === null || known.siteUrl === null || !isSite(known.provider)) return null;
  const site = known.provider;
  const args =
    ref.kind === 'movie'
      ? ['--play-url', known.siteUrl, '--no-report']
      : ['--play-from', known.siteUrl, '--episode', String(ref.episode), '--season', String(ref.season), '--no-report'];
  let play: unknown | null;
  try {
    play = playing(await deps.runner(site, args));
  } catch (err) {
    log(`[notesd] streaming: ${site} could not be asked for ${known.siteUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (play === null) {
    log(`[notesd] streaming: ${site} played it last time and did not start ${known.siteUrl} now; streaming it the usual way`);
    return null;
  }
  try {
    await deps.streams.recordSitePlay(ref, site, known.siteUrl);
  } catch (err) {
    log(`[notesd] streaming: the play on ${site} is not kept: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { site, url: known.siteUrl, play };
}
