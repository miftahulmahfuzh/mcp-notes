import { LookupError, lookupTitle, type LookupDeps, type TitleCandidate } from '../directStream/lookup.js';
import type { StreamRef } from '../directStream/types.js';
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
  /** No title of that name and year is known, or more than one: it is kept by what the site says of it (movie_site_titles). */
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

export function isSite(value: string): value is StreamingSite {
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
    // No title, or more than one, carries the name: nothing is guessed, and the play is kept by what the site says of it.
    if (deps.siteTitles !== undefined) {
      const id = await deps.siteTitles(report);
      if (id !== null) {
        log(`[notesd] streaming: ${report.name} played on ${report.site}; ${found.reason === 'no_match' ? 'TMDB does not list it' : `several titles carry that name (${found.candidates.join(', ')})`}, so it is kept by what the site says of it`);
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

export function playing(answer: unknown): unknown | null {
  const play = (answer as { play?: { playing?: unknown } } | null)?.play;
  return play !== undefined && play !== null && play.playing === true ? play : null;
}

/** Why a site did not start a title (`playOnSite`), as the site-play route answers it. */
export type SiteSkip = 'no_match' | 'several_matches' | 'no_episode' | 'series' | 'not_playing';

/** What one site made of a play: its player started, with the title's page there, or why not. */
export type SiteTry =
  | { ok: true; site: StreamingSite; site_url: string | null; site_play: unknown }
  | { ok: false; site: StreamingSite; error: SiteSkip; message: string; play?: unknown };

/**
 * Plays `ref` on one streaming site: from `known`, the title's page this site played it from last time (no search,
 * and no second title of that name), else from the one page the site's search returns for the title's name and
 * year. Only exactly one match plays (the streaming command's own rule); nothing is guessed. A play from `known` is
 * kept here (`--no-report`); one from the search is reported to the daemon by the command itself. Never throws.
 * Shared by `POST /api/movies/:id/site-play` and the sites' fallback after direct streaming (fallback.ts).
 */
export async function playOnSite(
  input: { site: StreamingSite; ref: StreamRef; title: string | null; year: number | null; known: string | null },
  deps: { runner: StreamingRunner; streams: Pick<MovieStreams, 'recordSitePlay'>; log?: (line: string) => void },
): Promise<SiteTry> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { site, ref, known } = input;
  const slot = ref.kind === 'tv' ? ['--episode', String(ref.episode), '--season', String(ref.season)] : [];
  const name = input.title ?? '';
  try {
    if (known !== null) {
      const again = playing(await deps.runner(site, ref.kind === 'movie' ? ['--play-url', known, '--no-report'] : ['--play-from', known, ...slot, '--no-report']));
      if (again !== null) {
        try {
          await deps.streams.recordSitePlay(ref, site, known);
        } catch (err) {
          log(`[notesd] streaming: the play on ${site} is not kept: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { ok: true, site, site_url: known, site_play: again };
      }
      if (input.title === null) return { ok: false, site, error: 'not_playing', message: `${site} did not start ${known}.` };
    }
    if (input.title === null) return { ok: false, site, error: 'no_match', message: `The title's name is not known, so ${site} was not searched.` };
    const answer = (await deps.runner(site, ['--play', name, ...(input.year === null ? [] : [String(input.year)]), ...slot])) as { play?: { skipped_play?: unknown; url?: unknown } } | null;
    const play = playing(answer);
    if (play !== null) return { ok: true, site, site_url: typeof answer?.play?.url === 'string' ? answer.play.url : null, site_play: play };
    const skipped = typeof answer?.play?.skipped_play === 'string' ? answer.play.skipped_play : null;
    if (skipped === 'no_match') return { ok: false, site, error: 'no_match', message: `${site} does not list ${name}.` };
    if (skipped === 'several_matches') return { ok: false, site, error: 'several_matches', message: `${site} lists several titles called ${name}; name one with /${site}.` };
    if (skipped === 'no_episode') return { ok: false, site, error: 'no_episode', message: `${site} lists no such episode of ${name}.` };
    if (skipped === 'series') return { ok: false, site, error: 'series', message: `${site} plays films only.` };
    return { ok: false, site, error: 'not_playing', message: `${site} did not start ${name}.`, play: answer?.play ?? null };
  } catch (err) {
    return { ok: false, site, error: 'not_playing', message: err instanceof Error ? err.message : String(err) };
  }
}
