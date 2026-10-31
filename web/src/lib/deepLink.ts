/**
 * The wall's deep link: `/?note=<id>` or `/#<id>`. Ids are normalised the way the server does it
 * (src/notes/ids.ts `normalizeId`): trimmed, upper-cased, dash optional, so `f-zh5`, `FZH5` and
 * `F-ZH5` all mean `F-ZH5`. Anything else is not a target and is ignored.
 */
const LOOSE_ID = /^([0-9A-Z])-?([0-9A-Z]{3})$/;

/** `ab32`, `a-b32`, ` A-B32 ` -> `A-B32`; null for anything that cannot be a note id. */
export function normalizeNoteId(input: string): string | null {
  const m = LOOSE_ID.exec(input.trim().toUpperCase());
  return m ? `${m[1]}-${m[2]}` : null;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The note id a URL points at, or null. The hash wins when it holds a valid id (it is what changes
 * in place on hashchange); otherwise `?note=`. Neither present or valid -> null.
 */
export function parseDeepLink(search: string, hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h !== '') {
    const fromHash = normalizeNoteId(decode(h));
    if (fromHash !== null) return fromHash;
  }
  const q = new URLSearchParams(search).get('note');
  return q === null ? null : normalizeNoteId(q);
}

/** `parseDeepLink` on `window.location` (or any object with `search` and `hash`). */
export function deepLinkFromLocation(loc: Pick<Location, 'search' | 'hash'>): string | null {
  return parseDeepLink(loc.search, loc.hash);
}

/** The wall URL of a note: `/?note=<ID>`, the form useDeepLink reads on load and on popstate. */
export function noteHref(id: string): string {
  return `/?note=${encodeURIComponent(id)}`;
}
