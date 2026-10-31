// Note-id links in chat text (phase 11). Composes segmentLinks (./links): URLs and markdown links are
// found first and stay whole, so an id inside a URL or a link target is never split out of it. A link
// that is itself a wall deep link (`http://localhost:7317/?note=A-B32`, how Claude Code writes ids)
// becomes a `note` segment. Then, in the plain text between links and outside code spans, note ids
// become `note` segments that the chat UI renders as links opening the big editor in place.

import { segmentLinks, type LinkSegment } from './links';
import { parseDeepLink } from './deepLink';

export type ChatSegment = LinkSegment | { kind: 'note'; text: string; id: string };

export interface ChatSegmentOptions {
  /** The last paragraph of an answer that is still streaming. */
  streaming?: boolean;
  /** Canonical id (`A-B32`) -> the page holds that note. Known ids are linked in any case. */
  isKnown?: (id: string) => boolean;
}

/**
 * ID_RE's boundary (lib/usedIds: not inside a longer [0-9A-Za-z-] token) plus code-ish neighbours:
 * not after `_ / \ . @ # = :` (snake_case, paths, `upload:ID`, `?note=ID`), not before `_ / \ @`,
 * and not before a dot that continues a token (`A-B32.png`). A sentence-ending dot is fine.
 */
const ID_SRC = '(?<![0-9A-Za-z_/\\\\.@#=:-])([0-9A-Za-z])-([0-9A-Za-z]{3})(?![0-9A-Za-z_/\\\\@-])(?!\\.[0-9A-Za-z])';
/** How the model is told to write ids; an unknown id is linked only in this form. */
const CANONICAL = /^[0-9A-Z]-[0-9A-Z]{3}$/;
/** Stands in for a link segment in the joined text: not an id character, not a backtick. */
const HOLE = '\u0000';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

interface Hit {
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
 * - Never inside code spans, URLs, longer words or code-ish tokens; never at the very end of a
 *   streaming paragraph.
 */
export function segmentChat(text: string, opts: ChatSegmentOptions = {}): ChatSegment[] {
  const streaming = opts.streaming === true;
  const isKnown = opts.isKnown ?? (() => false);
  const segs = segmentLinks(text, { streaming }).map((s): ChatSegment => {
    if (s.kind !== 'link') return s;
    const id = wallNoteId(s.href);
    return id === null ? s : { kind: 'note', text: s.text, id };
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
    hits.push({ start, end, id });
  }
  if (hits.length === 0) return segs;

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
      out.push({ kind: 'note', text: joined.slice(hit.start, hit.end), id: hit.id });
      at = hit.end;
      h++;
    }
    if (at < stop) out.push({ kind: 'text', text: joined.slice(at, stop) });
  });
  return out;
}
