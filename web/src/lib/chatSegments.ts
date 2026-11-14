// Note-id links in chat text (phase 11). Composes segmentLinks (./links): URLs and markdown links are
// found first and stay whole, so an id inside a URL or a link target is never split out of it. A link
// that is itself a wall deep link (`http://localhost:7317/?note=A-B32`, how Claude Code writes ids)
// becomes a `note` segment. Then, in the plain text between links and outside code spans, note ids
// become `note` segments that the chat UI renders as links opening the big editor in place.
// Session node ids (`BE-XU`) become `node` segments the same way, but only ids the server knows:
// upper-case look-alikes (CI-CD, UI-UX) share the shape.
// Movie ids (`M-23T4`: a title, or one episode) become `movie` segments by shape alone: `M-` and
// four characters is not a word, and the pop-up says so when the id names nothing.

import { segmentLinks, type LinkSegment } from './links';
import { parseDeepLink } from './deepLink';
import { canonicalNodeId } from './route';

export type ChatSegment =
  | LinkSegment
  | { kind: 'note'; text: string; id: string }
  | { kind: 'node'; text: string; id: string }
  | { kind: 'movie'; text: string; id: string };

export interface ChatSegmentOptions {
  /** The last paragraph of an answer that is still streaming. */
  streaming?: boolean;
  /** Canonical id (`A-B32`) -> the page holds that note. Known ids are linked in any case. */
  isKnown?: (id: string) => boolean;
  /** Canonical node id (`BE-XU`) -> the server has that session. Unknown node ids stay text. */
  isKnownNode?: (id: string) => boolean;
}

/**
 * ID_RE's boundary (lib/usedIds: not inside a longer [0-9A-Za-z-] token) plus code-ish neighbours:
 * not after `_ / \ . @ # = :` (snake_case, paths, `upload:ID`, `?note=ID`), not before `_ / \ @`,
 * and not before a dot that continues a token (`A-B32.png`). A sentence-ending dot is fine.
 */
const ID_SRC = '(?<![0-9A-Za-z_/\\\\.@#=:-])([0-9A-Za-z])-([0-9A-Za-z]{3})(?![0-9A-Za-z_/\\\\@-])(?!\\.[0-9A-Za-z])';
/** How the model is told to write ids; an unknown id is linked only in this form. */
const CANONICAL = /^[0-9A-Z]-[0-9A-Z]{3}$/;
/**
 * src/sessions/ids.ts NODE_ID_CANDIDATE_SOURCE: upper case as written, dash required, a whole token
 * (dates, times, versions, paths, file names, UATP-2960 and note ids never match).
 */
const NODE_SRC = String.raw`(?<![0-9A-Za-z_.\/:\\-])([0-9A-Z]{2}-[0-9A-Z]{2})(?![0-9A-Za-z_\/\\-]|[.:][0-9A-Za-z])`;
/** src/movies/ids.ts: `M-` and four of [0-9A-Z], upper case as written, a whole token (never a note id: those have three). */
const MOVIE_SRC = String.raw`(?<![0-9A-Za-z_.\/:\\-])(M-[0-9A-Z]{4})(?![0-9A-Za-z_\/\\-]|[.:][0-9A-Za-z])`;
const MOVIE_ID = /^M-[0-9A-Z]{4}$/;
/** The server never hands out an all-digit id (it reads as a page range or a score). */
const HAS_LETTER = /[A-Z]/;
/** Stands in for a link segment in the joined text: not an id character, not a backtick. */
const HOLE = '\u0000';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

interface Hit {
  kind: 'note' | 'node' | 'movie';
  start: number;
  end: number;
  id: string;
}

function currentHost(): string | null {
  return typeof window === 'undefined' ? null : window.location.host;
}

/**
 * The note a link points at when the link is the wall itself: http(s), a loopback host (any port,
 * NOTESD_PORT varies) or this page's host, path `/`, and a valid `?note=` or `#id`. Else null.
 */
export function wallNoteId(href: string, here: string | null = currentHost()): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!LOOPBACK.has(u.hostname) && u.host !== here) return null;
  if (u.pathname !== '/') return null;
  return parseDeepLink(u.search, u.hash);
}

/** The node a link points at when the link is the wall's projects page (`/projects?…node=BE-XU`). Else null. */
export function wallNodeId(href: string, here: string | null = currentHost()): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!LOOPBACK.has(u.hostname) && u.host !== here) return null;
  if (u.pathname.replace(/\/+$/, '') !== '/projects') return null;
  const node = u.searchParams.get('node');
  return node === null ? null : canonicalNodeId(node);
}

/** The movie id a link points at when the link is the wall's movies page with a movie id (`/movies/M-23T4`). Else null. */
export function wallMovieId(href: string, here: string | null = currentHost()): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!LOOPBACK.has(u.hostname) && u.host !== here) return null;
  const m = /^\/movies\/([^/]+)\/?$/.exec(u.pathname);
  if (m === null) return null;
  const id = decodeURIComponent(m[1]).toUpperCase();
  return MOVIE_ID.test(id) ? id : null;
}

/** Node ids written in plain text (outside code spans), canonical and deduped: what the page asks the server about. */
export function nodeIdCandidates(text: string): string[] {
  const code = codeRanges(text, false);
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(NODE_SRC, 'g'))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!HAS_LETTER.test(m[0]) || code.some(([a, b]) => start < b && end > a)) continue;
    out.add(m[0]);
  }
  return [...out];
}

/**
 * [start, end) ranges of code spans: a run of N backticks up to the next run of exactly N.
 * An opener with no closer is a literal backtick, except while streaming, where it is a span
 * that has not closed yet and runs to the end.
 */
function codeRanges(s: string, streaming: boolean): Array<[number, number]> {
  const runs: Array<{ at: number; n: number }> = [];
  for (const m of s.matchAll(/`+/g)) runs.push({ at: m.index ?? 0, n: m[0].length });
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < runs.length) {
    const open = runs[i];
    let j = i + 1;
    while (j < runs.length && runs[j].n !== open.n) j++;
    if (j < runs.length) {
      out.push([open.at, runs[j].at + runs[j].n]);
      i = j + 1;
      continue;
    }
    if (streaming) {
      out.push([open.at, s.length]);
      return out;
    }
    i++;
  }
  return out;
}

/**
 * Splits one paragraph of chat text into text, links and note links.
 * - Everything `segmentLinks` does, unchanged (http(s) only, trailing punctuation, streaming
 *   markdown tail shown as its label).
 * - A link to the wall with a note target becomes `{kind:'note', text: <label>, id}`.
 * - A note id in plain text becomes `{kind:'note', text: <as written>, id: <canonical>}` when the
 *   page knows it, or when it is written in canonical upper case.
 * - A link to the wall's projects page with a node target becomes `{kind:'node', text: <label>, id}`.
 * - A node id in plain text becomes `{kind:'node', text, id}` when `isKnownNode` says it exists.
 * - A link to `/movies/M-23T4` on the wall, and a movie id in plain text, become `{kind:'movie', text, id}`.
 * - Never inside code spans, URLs, longer words or code-ish tokens; never at the very end of a
 *   streaming paragraph.
 */
export function segmentChat(text: string, opts: ChatSegmentOptions = {}): ChatSegment[] {
  const streaming = opts.streaming === true;
  const isKnown = opts.isKnown ?? (() => false);
  const isKnownNode = opts.isKnownNode ?? (() => false);
  const segs = segmentLinks(text, { streaming }).map((s): ChatSegment => {
    if (s.kind !== 'link') return s;
    const id = wallNoteId(s.href);
    if (id !== null) return { kind: 'note', text: s.text, id };
    const node = wallNodeId(s.href);
    if (node !== null) return { kind: 'node', text: s.text, id: node };
    const movie = wallMovieId(s.href);
    return movie === null ? s : { kind: 'movie', text: s.text, id: movie };
  });

  let joined = '';
  const starts: number[] = [];
  for (const s of segs) {
    starts.push(joined.length);
    joined += s.kind === 'text' ? s.text : HOLE;
  }

  const code = codeRanges(joined, streaming);
  const hits: Hit[] = [];
  for (const m of joined.matchAll(new RegExp(ID_SRC, 'g'))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (streaming && end === joined.length) continue;
    if (code.some(([a, b]) => start < b && end > a)) continue;
    const id = m[0].toUpperCase();
    if (!CANONICAL.test(m[0]) && !isKnown(id)) continue;
    hits.push({ kind: 'note', start, end, id });
  }
  for (const m of joined.matchAll(new RegExp(NODE_SRC, 'g'))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (streaming && end === joined.length) continue;
    if (code.some(([a, b]) => start < b && end > a)) continue;
    if (!HAS_LETTER.test(m[0]) || !isKnownNode(m[0])) continue;
    hits.push({ kind: 'node', start, end, id: m[0] });
  }
  for (const m of joined.matchAll(new RegExp(MOVIE_SRC, 'g'))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (streaming && end === joined.length) continue;
    if (code.some(([a, b]) => start < b && end > a)) continue;
    hits.push({ kind: 'movie', start, end, id: m[0] });
  }
  if (hits.length === 0) return segs;
  hits.sort((a, b) => a.start - b.start);

  // Every hit lies inside one text segment: HOLE is not an id character, so no match spans a link.
  const out: ChatSegment[] = [];
  let h = 0;
  segs.forEach((s, i) => {
    if (s.kind !== 'text') {
      out.push(s);
      return;
    }
    const stop = starts[i] + s.text.length;
    let at = starts[i];
    while (h < hits.length && hits[h].start < stop) {
      const hit = hits[h];
      if (hit.start > at) out.push({ kind: 'text', text: joined.slice(at, hit.start) });
      out.push({ kind: hit.kind, text: joined.slice(hit.start, hit.end), id: hit.id });
      at = hit.end;
      h++;
    }
    if (at < stop) out.push({ kind: 'text', text: joined.slice(at, stop) });
  });
  return out;
}
