import { answerOf, candidateFrom } from './candidate.js';
import type { ExcludeReason, IndexAnswer, IndexRow, TorrentQuery, TvQuery } from './types.js';

/**
 * The indexes asked by title, not by IMDb id: Knaben, Bitsearch, torrents-csv (WIDER_TORRENT_SOURCES_PLAN phase 2).
 * An IMDb-keyed index answers for the title it was asked. A title search answers anything whose name holds the words,
 * so a release only title searches list is held to a stricter fit (titleSearchExclusion, applied in rank.ts): it must
 * start with the asked title and go straight on to the film's year or the episode's marker. A title is never guessed.
 */

/** Each title-search index's own limit; shorter than the finder's 10 s, so it never holds a play up longer. */
export const TITLE_SEARCH_TIMEOUT_MS = 8_000;
/** Rows asked of an index that takes a count (Knaben, torrents-csv). */
export const TITLE_SEARCH_ROWS = 50;
/** A film's release may carry the year next to TMDB's (a festival year, a late release); further off is another film. */
export const TITLE_SEARCH_YEAR_SLACK = 1;

export type TitleSearchExclusion = Extract<ExcludeReason, 'other_title' | 'other_year'>;

const ARTICLES: ReadonlySet<string> = new Set(['the', 'a', 'an']);
/** Words a release may put between a film's title and its year ("Kingdom of Heaven Directors Cut 2005"). */
const EDITION_WORDS: ReadonlySet<string> = new Set(['extended', 'directors', 'director', 'dc', 'cut', 'uncut', 'unrated', 'remastered', 'theatrical', 'edition', 'imax', 'repack', 'proper', 'criterion']);
/** Words that open a season pack's name right after the series' title. */
const SEASON_WORDS: ReadonlySet<string> = new Set(['season', 'seasons', 'complete', 'temporada', 'saison']);
const YEAR = /^(?:19|20)\d{2}$/;
/** "s01e01", "s01", "e01", "1x01", once the name is split into words. */
const EPISODE_MARK = /^(?:s\d{1,2}(?:e\d{1,4})?|e\d{1,4}|\d{1,2}x\d{2,3})$/;
/** A leading "[group]", "(tag)", "{tag}", "【tag】" or "www.site.org - " before the release's own name. */
const PREFIX = /^\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|【[^】]*】|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6}\s+-\s+)\s*/i;

const two = (n: number): string => String(n).padStart(2, '0');

function titleOf(query: TorrentQuery): string {
  return query.title?.trim() || query.originalTitle?.trim() || '';
}

/**
 * What a title-search index is asked: a film as its title and year ("Dune 2021"), an episode as its title and
 * SxxEyy, numbered within the season (`alt`) when TMDB's number runs on across seasons. Null when the query has no
 * name, or is a film with no year: such a query is not searched at all (`unsearchable`).
 */
export function titleSearchText(query: TorrentQuery): string | null {
  const title = titleOf(query);
  if (title === '') return null;
  if (query.kind === 'movie') return query.year === null || query.year === undefined ? null : `${title} ${query.year}`;
  const episode = query.alt ?? query;
  return `${title} S${two(episode.season)}E${two(episode.episode)}`;
}

/** The answer of a title-search index that sent no request because titleSearchText had nothing to ask. */
export function unsearchable(query: TorrentQuery): IndexAnswer {
  const detail = titleOf(query) === '' ? 'not asked: the title has no name to search by' : 'not asked: a film is searched by title and year, and its year is unknown';
  return { outcome: 'empty', detail, candidates: [] };
}

/** A title-search index's rows as candidates marked `titleSearch`, so rank.ts holds them to titleSearchExclusion. */
export function titleSearchAnswer(rows: readonly IndexRow[], index: string, query: TorrentQuery): IndexAnswer {
  return answerOf(rows.map((row) => ({ ...candidateFrom(row, index, query), titleSearch: true as const })));
}

/** Lower case, accents dropped, "&" read as "and", apostrophes dropped, split on anything else; a leading article dropped. */
function words(text: string): string[] {
  const all = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  return all.length > 1 && all[0] !== undefined && ARTICLES.has(all[0]) ? all.slice(1) : all;
}

/** The name's words, then again after each leading prefix ("[YTS.MX] ", "www.UIndex.org - "), at most three. */
function readings(name: string): string[][] {
  const out = [words(name)];
  let rest = name;
  for (let i = 0; i < 3; i++) {
    const m = PREFIX.exec(rest);
    if (m === null || m[0] === '') break;
    rest = rest.slice(m[0].length);
    out.push(words(rest));
  }
  return out;
}

function startsWith(name: readonly string[], title: readonly string[]): boolean {
  return title.length > 0 && title.length <= name.length && title.every((w, i) => name[i] === w);
}

/** What follows a film's title: its year (after any edition words), within the slack. */
function filmFit(rest: readonly string[], year: number): TitleSearchExclusion | null {
  let at = 0;
  while (at < rest.length && EDITION_WORDS.has(rest[at] ?? '')) at++;
  const next = rest[at];
  if (next !== undefined && YEAR.test(next)) return Math.abs(Number(next) - year) <= TITLE_SEARCH_YEAR_SLACK ? null : 'other_year';
  // The title runs on into other words before a year ("Dune Part Two 2024"): another film. No year at all: nothing says which.
  return rest.some((w) => YEAR.test(w)) ? 'other_title' : 'other_year';
}

/** What follows a series' title: an optional year ("Doctor Who 2005"), then a season or episode marker, or the running number. */
function episodeFollows(rest: readonly string[], query: TvQuery): boolean {
  let at = 0;
  if (YEAR.test(rest[at] ?? '')) at++;
  const next = rest[at];
  if (next === undefined) return false;
  if (EPISODE_MARK.test(next) || SEASON_WORDS.has(next)) return true;
  const running = query.absoluteEpisode ?? null;
  return running !== null && /^\d{1,4}$/.test(next) && Number(next) === running;
}

/**
 * Why a release only a title search listed is not the asked title, or null when it is. It must start with the title
 * or the original title (after a leading group or site prefix, a leading article ignored), then go straight on to:
 * - a film: its year, give or take TITLE_SEARCH_YEAR_SLACK (edition words may come between). Another year, or no year,
 *   is `other_year`; other words before the year are `other_title`.
 * - an episode: a season or episode marker (or the running number of a long anime). Which episode is left to rank.ts's
 *   episode check (`other_episode`), as for every unscoped listing.
 */
export function titleSearchExclusion(name: string, query: TorrentQuery): TitleSearchExclusion | null {
  const titles = [query.title, query.originalTitle].map((t) => words(t ?? '')).filter((w) => w.length > 0);
  if (titles.length === 0) return 'other_title';
  let wrongYear = false;
  for (const reading of readings(name)) {
    for (const title of titles) {
      if (!startsWith(reading, title)) continue;
      const rest = reading.slice(title.length);
      if (query.kind === 'tv') {
        if (episodeFollows(rest, query)) return null;
        continue;
      }
      // Not reached through the indexes (a film with no year is never searched); without a year nothing tells two films apart.
      if (query.year === null || query.year === undefined) return 'other_year';
      const fit = filmFit(rest, query.year);
      if (fit === null) return null;
      if (fit === 'other_year') wrongYear = true;
    }
  }
  return wrongYear ? 'other_year' : 'other_title';
}
