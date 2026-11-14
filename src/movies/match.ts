import type { NameFallback } from './fallback.js';
import { compactTitle, normalizeTitle, type KindHint, type ParsedName } from './parse.js';
import type { TitleKind, TmdbClient, TmdbSearchHit } from './tmdb.js';

/**
 * Parsed file name -> one TMDB title, or no match with a reason.
 *
 * The confidence rule (one number per candidate, 0..1):
 *   confidence = clamp(titleSimilarity + yearAdjustment, 0, 1)
 * - titleSimilarity, against the candidate's title and original title (the higher counts):
 *   1 when normalizeTitle is equal ("WALL-E" = "WALL·E", "Batman - The Killing Joke" =
 *   "Batman: The Killing Joke"); 0.95 when equal without spaces ("Nezha" = "Ne Zha"); else the
 *   Dice coefficient of the two word sets.
 * - yearAdjustment, when the name has a year: 0 for the same year; -0.1 one year apart or when
 *   the candidate has no date; -0.5 further apart. A series' later season year (name year after
 *   the first air year) costs nothing.
 * A candidate is a match at CONFIDENT_SCORE or above. The best candidate wins; on a tie the
 * earlier one in TMDB's order (which ranks by popularity), movies before series.
 *
 * Search order: an episode ('tv' hint) searches series only, a film ('movie' hint) films only, no
 * hint films then series (series skipped once a film is confident). A search with a year that
 * finds nothing is repeated without it (folder years are sometimes off).
 *
 * Below CONFIDENT_SCORE the Haiku fallback (when given) is asked for a title and year from the raw
 * file and folder names, and its answer goes through the same search and rule. TmdbError is not
 * caught here: the caller (sync) leaves the file pending and retries on its next pass.
 */

export const CONFIDENT_SCORE = 0.85;
/** Search results scored per query. */
export const MAX_CANDIDATES = 10;

export type MatchResult =
  | {
      kind: 'matched';
      tmdbKind: TitleKind;
      tmdbId: number;
      confidence: number;
      /** 'filename': the parsed name matched. 'fallback': Haiku's title matched. */
      source: 'filename' | 'fallback';
      /** TMDB's title of the match, for logs. */
      matchedTitle: string;
    }
  | {
      kind: 'none';
      /** no_match: TMDB returned no candidate. low_confidence: candidates, none confident. */
      reason: 'no_match' | 'low_confidence';
    };

interface Candidate {
  hit: TmdbSearchHit;
  score: number;
}

function words(text: string): Set<string> {
  return new Set(normalizeTitle(text).split(' ').filter((w) => w !== ''));
}

/** 0..1, see the rule above. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;
  if (compactTitle(a) === compactTitle(b)) return 0.95;
  const wa = words(a);
  const wb = words(b);
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return (2 * common) / (wa.size + wb.size);
}

export function yearAdjustment(kind: TitleKind, nameYear: number | null, hitYear: number | null): number {
  if (nameYear === null) return 0;
  if (hitYear === null) return -0.1;
  const diff = nameYear - hitYear;
  if (diff === 0) return 0;
  if (kind === 'tv' && diff > 0) return 0;
  if (Math.abs(diff) === 1) return -0.1;
  return -0.5;
}

/** Confidence of one candidate for a title and year, rounded to 3 decimals. */
export function scoreHit(title: string, year: number | null, hit: TmdbSearchHit): number {
  const similarity = Math.max(titleSimilarity(title, hit.title), titleSimilarity(title, hit.originalTitle));
  const score = Math.min(1, Math.max(0, similarity + yearAdjustment(hit.kind, year, hit.year)));
  return Math.round(score * 1000) / 1000;
}

/** What is sent to TMDB: the title without stand-alone dashes ("Batman - The Killing Joke" -> "Batman The Killing Joke"). */
export function searchQuery(title: string): string {
  return title
    .split(/\s+/)
    .filter((w) => w !== '' && !/^[-–—:]+$/.test(w))
    .join(' ');
}

function kindsFor(hint: KindHint): TitleKind[] {
  if (hint === 'tv') return ['tv'];
  if (hint === 'movie') return ['movie'];
  return ['movie', 'tv'];
}

async function search(client: TmdbClient, kind: TitleKind, query: string, year: number | null): Promise<TmdbSearchHit[]> {
  return kind === 'movie' ? client.searchMovie(query, year) : client.searchTv(query, year);
}

async function bestCandidate(
  client: TmdbClient,
  title: string,
  year: number | null,
  hint: KindHint,
): Promise<Candidate | null> {
  const query = searchQuery(title);
  if (query === '') return null;
  let best: Candidate | null = null;
  for (const kind of kindsFor(hint)) {
    if (best !== null && best.score >= CONFIDENT_SCORE) break;
    let hits = await search(client, kind, query, year);
    if (hits.length === 0 && year !== null) hits = await search(client, kind, query, null);
    for (const hit of hits.slice(0, MAX_CANDIDATES)) {
      const score = scoreHit(title, year, hit);
      if (best === null || score > best.score) best = { hit, score };
    }
  }
  return best;
}

function matched(c: Candidate, source: 'filename' | 'fallback'): MatchResult {
  return { kind: 'matched', tmdbKind: c.hit.kind, tmdbId: c.hit.tmdbId, confidence: c.score, source, matchedTitle: c.hit.title };
}

function none(best: Candidate | null): MatchResult {
  return { kind: 'none', reason: best === null ? 'no_match' : 'low_confidence' };
}

export async function matchTitle(parsed: ParsedName, client: TmdbClient, fallback?: NameFallback | null): Promise<MatchResult> {
  const first = await bestCandidate(client, parsed.title, parsed.year, parsed.kindHint);
  if (first !== null && first.score >= CONFIDENT_SCORE) return matched(first, 'filename');
  if (fallback === undefined || fallback === null) return none(first);

  const answer = await fallback.resolve(parsed.fileName, parsed.dirName);
  if (answer === null) return none(first);
  const second = await bestCandidate(client, answer.title, answer.year, answer.kind ?? parsed.kindHint);
  if (second !== null && second.score >= CONFIDENT_SCORE) return matched(second, 'fallback');
  return none(second ?? first);
}
