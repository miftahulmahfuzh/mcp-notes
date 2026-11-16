import type { TmdbNamedHit } from '../movies/tmdb.js';
import { normalizeName } from './match.js';

/** Titles direct_stream_discover lists when the caller names no limit, and at most. */
export const DISCOVER_DEFAULT_LIMIT = 20;
export const DISCOVER_MAX_LIMIT = 40;
/** Other people, companies or services a name also fits, listed beside the one picked. */
export const DISCOVER_MAX_OTHERS = 5;
/** The country a streaming service's catalogue is read for when none is named. */
export const DISCOVER_DEFAULT_REGION = 'US';
/** How much of a synopsis a listed title carries. */
export const DISCOVER_OVERVIEW_CHARS = 240;

/** Names Intl does not give, or gives differently from how TMDB codes them (TMDB: `cn` is Cantonese, `zh` Mandarin). */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  mandarin: 'zh',
  cantonese: 'cn',
  filipino: 'tl',
  tagalog: 'tl',
  bahasa: 'id',
  'bahasa indonesia': 'id',
  farsi: 'fa',
  castilian: 'es',
};

let languageNames: Map<string, string> | null = null;

/** English language names ("spanish") to ISO 639-1 codes, built once from Intl. */
function namesToCodes(): Map<string, string> {
  if (languageNames !== null) return languageNames;
  const names = new Map<string, string>(Object.entries(LANGUAGE_ALIASES));
  const display = new Intl.DisplayNames(['en'], { type: 'language' });
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b;
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        continue;
      }
      // An unknown code comes back as itself.
      if (name === undefined || name.toLowerCase() === code) continue;
      const key = name.toLowerCase();
      if (!names.has(key)) names.set(key, code);
    }
  }
  languageNames = names;
  return names;
}

/** TMDB's code for a language given as a code ("es") or an English name ("Spanish"); null when it is neither. */
export function languageCode(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  const named = namesToCodes().get(text);
  if (named !== undefined) return named;
  return /^[a-z]{2}$/.test(text) ? text : null;
}

/**
 * The entries of a TMDB name list that a name means, best first: the ones called exactly that,
 * then the ones whose name starts with it, then the ones that contain it; each group in the
 * list's own order. [] when nothing fits.
 */
export function rankByName<T extends Pick<TmdbNamedHit, 'name'>>(list: readonly T[], name: string): T[] {
  const wanted = normalizeName(name);
  if (wanted === '') return [];
  const exact: T[] = [];
  const starts: T[] = [];
  const contains: T[] = [];
  for (const item of list) {
    const own = normalizeName(item.name);
    if (own === wanted) exact.push(item);
    else if (own.startsWith(wanted)) starts.push(item);
    else if (own.includes(wanted)) contains.push(item);
  }
  return [...exact, ...starts, ...contains];
}

export interface DateRange {
  from: string | null;
  to: string;
}

/**
 * The release window asked for: `year` alone is that year, `yearFrom` / `yearTo` a range. It never
 * reaches past `today` (`YYYY-MM-DD`): a title that is not out yet cannot be streamed.
 */
export function releaseWindow(year: number | undefined, yearFrom: number | undefined, yearTo: number | undefined, today: string): DateRange {
  const first = yearFrom ?? year;
  const last = yearTo ?? year;
  const end = last === undefined ? today : `${last}-12-31`;
  return { from: first === undefined ? null : `${first}-01-01`, to: end < today ? end : today };
}

export function inWindow(date: string | null, window: DateRange): boolean {
  if (date === null) return false;
  return date <= window.to && (window.from === null || date >= window.from);
}

/** A synopsis cut at a word to DISCOVER_OVERVIEW_CHARS. */
export function shortOverview(overview: string): string {
  const text = overview.trim();
  if (text.length <= DISCOVER_OVERVIEW_CHARS) return text;
  const cut = text.slice(0, DISCOVER_OVERVIEW_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > DISCOVER_OVERVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}
