import type { TmdbGenre, TmdbNamedHit } from '../movies/tmdb.js';
import { normalizeName } from './match.js';

/** Titles direct_stream_discover lists when the caller names no limit, and at most. */
export const DISCOVER_DEFAULT_LIMIT = 20;
export const DISCOVER_MAX_LIMIT = 40;
/** Other people, companies or services a name also fits, listed beside the one picked. */
export const DISCOVER_MAX_OTHERS = 5;
/** The country a streaming service's catalogue is read for when none is named. */
export const DISCOVER_DEFAULT_REGION = 'US';
/** Companies one name stands for at most ("Blumhouse" is Blumhouse Productions, Television, International, ...). */
export const DISCOVER_MAX_COMPANIES = 6;
/** Keywords one word stands for at most ("mafia" is mafia, sicilian mafia, japanese mafia, ...). */
export const DISCOVER_MAX_KEYWORDS = 8;
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
 * The companies a studio's name stands for. The one called exactly that when there is one; else
 * every company whose name starts with it, since TMDB files a studio under several ("Blumhouse"
 * is Blumhouse Productions, Blumhouse Television, ...); else the first whose name contains it.
 * `others` is what else the name fits. Both in the list's own order.
 */
export function companiesNamed<T extends Pick<TmdbNamedHit, 'name'>>(list: readonly T[], name: string): { picked: T[]; others: T[] } {
  const wanted = normalizeName(name);
  if (wanted === '') return { picked: [], others: [] };
  const fits = list.filter((item) => normalizeName(item.name).includes(wanted));
  const exact = fits.filter((item) => normalizeName(item.name) === wanted);
  const starts = fits.filter((item) => normalizeName(item.name).startsWith(wanted));
  const picked = exact.length > 0 ? exact.slice(0, 1) : starts.length > 0 ? starts.slice(0, DISCOVER_MAX_COMPANIES) : fits.slice(0, 1);
  return { picked, others: fits.filter((item) => !picked.includes(item)) };
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

/**
 * TMDB's codes for a language as the owner says it. One code for most; "Chinese" is both of TMDB's,
 * `zh` (Mandarin) and `cn` (Cantonese), since a Hong Kong film is as Chinese as a mainland one.
 * Null when it is neither a name nor a code.
 */
export function languageCodes(value: string): string[] | null {
  if (value.trim().toLowerCase() === 'chinese') return ['zh', 'cn'];
  const code = languageCode(value);
  return code === null ? null : [code];
}

/** Words the owner uses for a genre, as TMDB's own word for it (normalized). */
const GENRE_WORDS: Readonly<Record<string, string>> = {
  sciencefiction: 'scifi',
  romantic: 'romance',
  romcom: 'romance',
  funny: 'comedy',
  comedies: 'comedy',
  scary: 'horror',
  animated: 'animation',
  anime: 'animation',
  cartoon: 'animation',
  documentaries: 'documentary',
  docu: 'documentary',
  historical: 'history',
  musical: 'music',
  thrillers: 'thriller',
  mysteries: 'mystery',
  political: 'politics',
};

const genreWord = (text: string): string => {
  const word = normalizeName(text);
  return GENRE_WORDS[word] ?? word;
};

/**
 * The genre of one kind's list a word means: the one called that ("Horror"), else the one that has
 * the word as a part of its name, which is how TMDB files series ("action" is "Action & Adventure",
 * "sci-fi" and "fantasy" are "Sci-Fi & Fantasy", "war" is "War & Politics"). Null when the kind has
 * no such genre: TMDB has no Horror, Thriller or Romance for series.
 */
export function genreNamed(list: readonly TmdbGenre[], name: string): TmdbGenre | null {
  const wanted = genreWord(name);
  if (wanted === '') return null;
  return (
    list.find((g) => genreWord(g.name) === wanted) ??
    list.find((g) =>
      g.name
        .split('&')
        .map(genreWord)
        .includes(wanted),
    ) ??
    null
  );
}

/**
 * The keywords a word stands for: the one called exactly that first, then the ones that hold it as
 * a whole word ("mafia": mafia, sicilian mafia, japanese mafia), in the list's own order, capped at
 * DISCOVER_MAX_KEYWORDS. A title carrying any of them passes. [] when nothing fits.
 */
export function keywordsNamed<T extends Pick<TmdbNamedHit, 'name'>>(list: readonly T[], name: string): T[] {
  const wanted = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (wanted === '') return [];
  const own = (item: T): string => item.name.trim().toLowerCase().replace(/\s+/g, ' ');
  const exact = list.filter((item) => own(item) === wanted);
  const holds = list.filter((item) => own(item) !== wanted && ` ${own(item)} `.includes(` ${wanted} `));
  return [...exact, ...holds].slice(0, DISCOVER_MAX_KEYWORDS);
}

/** Letters changed, added or dropped to turn one text into the other. */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * Shorter searches for a person's name that found nobody, to catch a misspelt last word ("park bo
 * yeung" for Park Bo-young): the name with its last word cut to one letter, then without it. []
 * for a single word.
 */
export function looserNames(name: string): string[] {
  const words = name.trim().split(/\s+/);
  const last = words.pop();
  if (last === undefined || words.length === 0) return [];
  const head = words.join(' ');
  return [`${head} ${last.slice(0, 1)}`, head];
}

/**
 * The entries whose name is the asked one but for a letter or two (one letter per five, at least
 * one), closest first, each group in the list's own order.
 */
export function nearlyNamed<T extends Pick<TmdbNamedHit, 'name'>>(list: readonly T[], name: string): T[] {
  const wanted = normalizeName(name);
  if (wanted === '') return [];
  const allowed = Math.max(1, Math.floor(wanted.length / 5));
  return list
    .map((item, at) => ({ item, at, distance: editDistance(normalizeName(item.name), wanted) }))
    .filter((x) => x.distance <= allowed)
    .sort((a, b) => a.distance - b.distance || a.at - b.at)
    .map((x) => x.item);
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
