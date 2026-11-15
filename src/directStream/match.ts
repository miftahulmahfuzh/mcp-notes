/**
 * The exact-title-and-year rule of the streaming sites (claude/streaming/match.mjs pickMatches),
 * for the daemon. The server build cannot import that .mjs, so it is ported here, and
 * tests/unit/directStream/match.test.ts runs both over the same cases so they cannot drift.
 */

/** What the owner asked for: a name, and a year when they gave one. */
export interface TitleQuery {
  name: string;
  year: number | null;
}

/** A title to test: its English name, its original-language name, its year. */
export interface NamedTitle {
  name: string;
  originalName: string | null;
  year: number | null;
}

/** Lower case, accents dropped, "&" read as "and", everything but letters and digits removed. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * True when `result` is the asked title: the same normalized name (its English or its original
 * one; the original also matches unnormalized, for a title in another script), and the same year
 * when a year was asked for and the result has one.
 */
export function isSameTitle(result: NamedTitle, query: TitleQuery): boolean {
  const wanted = normalizeName(query.name);
  const wantedRaw = query.name.normalize('NFKC').toLowerCase();
  const original = result.originalName;
  const sameName =
    normalizeName(result.name) === wanted ||
    (original !== null &&
      (original.normalize('NFKC').toLowerCase() === wantedRaw || (normalizeName(original) !== '' && normalizeName(original) === wanted)));
  const sameYear = query.year === null || result.year === null || result.year === query.year;
  return sameName && sameYear;
}
