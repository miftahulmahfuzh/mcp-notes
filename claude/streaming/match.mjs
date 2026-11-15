// Title matching shared by the streaming sites: how a typed title is read, and which of a
// site's search results are that title.
import { normalizeName, parseQuery } from '../skills/pahe/search.mjs';

export { normalizeName, parseQuery };

/**
 * Splits results into the ones that are the asked title and the rest, in the site's order. A match
 * has the same normalized name (its English or its original one), and the same year when a year
 * was asked for and the result has one.
 */
export function pickMatches(results, query) {
  const wanted = normalizeName(query.name);
  const wantedRaw = query.name.normalize('NFKC').toLowerCase();
  const matches = [];
  const others = [];
  for (const result of results) {
    const original = result.original_name ?? null;
    const sameName =
      normalizeName(result.name) === wanted ||
      (original !== null && (original.normalize('NFKC').toLowerCase() === wantedRaw || (normalizeName(original) !== '' && normalizeName(original) === wanted)));
    const sameYear = query.year === null || result.year === null || result.year === query.year;
    (sameName && sameYear ? matches : others).push(result);
  }
  return { matches, others };
}

/** The path of a title page on a site, or null for any other address. */
export function pathOnSite(url, origin, pattern) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || !pattern.test(parsed.pathname)) return null;
  return parsed.pathname;
}
