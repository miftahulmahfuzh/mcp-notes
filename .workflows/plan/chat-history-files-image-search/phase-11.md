# Phase 11: Note-id links open the note modal in place; show-on-wall button

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R3. The design's "every note id in chat text renders as a link that opens the bigger-note-view modal in place, no navigation. The modal gets an icon button that goes to `/?note=ID` and flashes the note on the wall."
**Depends on:** Phase 10, and through it 9, 7, 5, 4, 3, 2 and 1
**Difficulty:** NORMAL
**Package:** `web`

---

## Goal

Note ids in chat text, in the wall `AnswerPanel` and in every history-page `Bubble`, become links. A plain click opens the big note editor over whatever page is showing, with no navigation. Ctrl, cmd, shift and middle click keep the real `/?note=ID` URL. A loaded note opens at once. A note outside the loaded page is fetched and stays open across refetches. A deleted id gets the deep link's quiet notice, and so does an unknown one. The editor gains a "Show on wall" icon. It closes the editor the normal way, switches to the wall view, pushes `/?note=ID` and flashes the card.

## Interface Contract

**Deletes:** none.
**Renames:** none.
**Creates:**
- `segmentChat`, `wallNoteId`, `ChatSegment`, `ChatSegmentOptions` (`web/src/lib/chatSegments.ts`, new)
- `noteHref` (`web/src/lib/deepLink.ts`)
- `NoteLinkContext`, `NoteLinks`, `ChatInline`, `ChatInlineProps` (`web/src/components/ChatText.tsx`, new)
- App-internal (not exported): `openNoteModal`, `showOnWall`, `noteLinks`, `pendingModal`, `modalSeq`, `lastExpanded` (`web/src/App.tsx`)
- CSS classes `.note-link` (`web/src/styles.css`) and `.ed-btn:disabled` (`web/src/components/NoteEditor.css`)
- DOM attribute `data-note-link="<ID>"` on chat note links. It is deliberately **not** `data-note`, because `noteSelector`/`scrollToNote` take the first `[data-note=…]` in the document, and a chat link must never be the element that gets flashed or scrolled to instead of the card.

**Signature changes:**
- `NoteEditorProps` gains the optional `onShowOnWall?: (note: Note) => void`. Leaving it out means no icon, so every existing caller and test is unchanged.
- `App`'s `expandedNote` memo falls back to the last version it showed when the store loses the note (see Step 7).

**Requires (from earlier phases):**
- P9 (Step 18) and P10 (Step 7): `web/src/components/Bubble.tsx` renders `msg.text` as `const parts = msg.text ? msg.text.split('\n\n') : [];` and a `parts.map(…)` block of `<p>`s whose content is `segmentLinks(t, { streaming: tail })` mapped to `<a className="answer-link">` or `<Fragment>`, plus `{tail ? ' ▍' : ''}` (quoted verbatim in Step 6c). P10 added only optional `slots` (quote, editor, foot) around that block and did not change it; P10's `MessageItem` renders the same `Bubble`, so server rows on the history page get note links too. Bubble props: `{ item: TimelineItem; now: Date; focused: boolean; onOpenImages; slots? }`.
- P9: `View` includes `'history'`, and `App` renders `{expandedNote && createPortal(<NoteEditor …/>, document.body)}`, `<LinkNotice>` and `<AnswerPanel>` at App root for every view, as today. `HistoryPage` and its `Bubble`s render inside App's tree, so a context provider at App root reaches them.
- P9 (Step 4 `hrefForView`, Step 24c): P9 owns the view→URL sync and its pathname guard. Entering `history` pushes `/history[?thread=…]`; leaving it pushes `/` only when the path is `/history`; wall and bin never rewrite a non-history URL, so `/?note=ID` survives a switch to the wall. Its `popstate` handler derives the view from the pathname. This phase adds no URL-sync code and changes no P9 line for it.
- P9: `planReveal` (`web/src/lib/reveal.ts`) still always returns `view: 'wall'`, so `revealLinked`/`openLinked` leave `history` as well as `bin`.
- P4: the web `Note` type has `files?: NoteFile[]` (optional, plan Decision). It is used only as `note.files?.length ?? 0`.
- P5: `closeEditor`'s empty rule already counts files. This phase does not change `closeEditor`.
- P3/P7/P9: `App.test.tsx`'s chat fixture (POST `/api/chat`, SSE `delta` then `done`) still drives `useChat`, and the wall chat bar is still `form.chatbar` with the label "Ask about your notes".
- P2/P5: `NoteEditor.tsx` after P5 has line 2 `import { Check, Copy, Paperclip, Trash, X } from '@phosphor-icons/react';`, P2's `Lightbox` import, `viewing` state, `isLightboxOpen()` Esc yield, `.ed-open` strip and `<Lightbox>`, and in `.ed-top` after `<span className="ed-spacer" />`: `<NoteRevealButton note={note} className="ed-btn" />`, then the `{onAttachFiles && (…)}` paperclip button with its hidden `input[data-picker]`, then `{onDelete && (…)}` (Trash) and the Close button. This phase keeps all of it.
- P3/P9: `AnswerPanel.tsx` after P9 imports `import { Fragment, useState } from 'react';` and `import { segmentLinks } from '../lib/links';`, has P3's `.answer-images` thumbnails (P9 made them Lightbox buttons) and P9's "Chat in full screen" button; its `.answer-body` `parts.map` block is today's, unchanged by P3 and P9.

**Leaves alone (owned by others):** every server file; `web/src/lib/links.ts` (`segmentLinks` unchanged, only composed); `web/src/lib/usedIds.ts` and the used-chips row; `web/src/hooks/useDeepLink.ts` (verified: it already listens to `popstate` and `hashchange`, and Step 7 explains why no listener is added); `closeEditor`, `commit` and `openLinked` logic; `HistoryPage`, reply headers and edit mode (P9/P10); `web/src/hooks/useNotes.ts`.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/lib/chatSegments.ts` | create | `segmentChat`: composes `segmentLinks`, turns wall deep links into `note` segments, finds note ids in plain text (code spans, code-ish neighbours, known-or-canonical rule, streaming tail) |
| `web/src/lib/chatSegments.test.tsx` | create | unit tests: boundaries, URLs, wall links, code spans, case/dash, streaming |
| `web/src/lib/deepLink.ts` | modify (append after line 39) | `noteHref(id)` → `/?note=ID` |
| `web/src/components/ChatText.tsx` | create | `NoteLinkContext`, `ChatInline` (renders segments), `NoteLink` (intercepts a plain click only) |
| `web/src/components/ChatText.test.tsx` | create | click and modifier behaviour, no-provider fallback, no `data-note` |
| `web/src/components/AnswerPanel.tsx` | modify (P9's `react` and `segmentLinks` imports; the `.answer-body` `parts.map` block) | paragraph content renders through `<ChatInline>` |
| `web/src/components/AnswerPanel.test.tsx` | modify (append) | note links in the panel, used row kept, streaming tail |
| `web/src/components/Bubble.tsx` (P9, slots by P10) | modify | the `parts.map` text block renders through `<ChatInline>`; `segmentLinks` import dropped |
| `web/src/components/Bubble.notelinks.test.tsx` | create | bubble id click opens via context and does not navigate |
| `web/src/components/NoteEditor.tsx` | modify (icon import; props after P5's `onRemoveFile`; signature; `.ed-top` after P5's paperclip, before Trash) | `onShowOnWall` prop and Crosshair "Show on wall" icon |
| `web/src/components/NoteEditor.css` | modify (after line 10) | `.ed-btn:disabled` |
| `web/src/components/NoteEditor.test.tsx` | modify (append) | icon present or absent, close-then-show order, disabled when empty |
| `web/src/App.tsx` | modify (imports; `expandedNote` memo; after `openLinked`/`useDeepLink(...)`; provider at the JSX root; `NoteEditor` props after P5's `onRemoveFile`) | `openNoteModal`, pending-modal effect, `showOnWall`, `noteLinks` context, `expandedNote` fallback |
| `web/src/App.notelinks.test.tsx` | create | App-level: in-place open, fetch, refetch survival, deleted/unknown notices, modified clicks, bin and history views, show-on-wall |
| `web/src/App.test.tsx` | modify (the `getByText('Look at a-b32 and Z-Z99.')` assertion, line 102 today) | the answer paragraph is now split by note links, so assert on `textContent` |
| `web/src/styles.css` | modify (after line 115) | `.note-link` chip-styled inline link |
| `README.md` | modify ("The chat bar" section, after line 388) | one paragraph |
| `CHANGELOG.md` | modify (`## [Unreleased]` → `### Added`) | one line |
| `web/src/hooks/useDeepLink.ts` | no change (verified) | already handles `popstate`; show-on-wall calls `openLinked` directly |

## Implementation Steps

### Step 1: `noteHref` in the deep-link module
**File:** `web/src/lib/deepLink.ts:39` (append at end of file)
**Change:** One helper so the chat link `href` and show-on-wall's `pushState` build the same URL.
**Code:**
```ts

/** The wall URL of a note: `/?note=<ID>`, the form useDeepLink reads on load and on popstate. */
export function noteHref(id: string): string {
  return `/?note=${encodeURIComponent(id)}`;
}
```
**Impact:** additive only.

### Step 2: The chat segmenter
**File:** `web/src/lib/chatSegments.ts` (new)
**Change:** A pure function in the `segmentLinks` idiom.

Decisions (rung 5: needed for robustness, all reversible):
- **URLs first.** `segmentLinks` runs first, so an id inside a bare URL or a markdown link target stays part of that link. An id in the *label* of a link to an external site stays part of the link too.
- **Wall deep links become note links** (plan Decision, rung: the design's "every note id in chat text renders as a link that opens the bigger-note-view modal in place, no navigation"). The anchor still carries the real `href="/?note=ID"` (`noteHref`), only a plain primary click without modifiers is intercepted, and ctrl/cmd/shift/alt or middle click, "open in new tab" and a fresh load of `/?note=ID` go through the browser and `useDeepLink` exactly as today (`useDeepLink` is untouched). P8 captures `/n` answers, and Claude Code writes every id there as `[A-B32](http://localhost:7317/?note=A-B32)` (the MCP instructions require it). A link whose host is loopback (any port, because `NOTESD_PORT` is configurable) or the page's own host, whose path is `/`, and which carries a valid `?note=`/`#id`, becomes a `note` segment that keeps its label. Without this, the most common form of id in captured answers would open a new tab instead of the modal.
- **Which plain ids are linked.** A candidate must pass `ID_RE`'s boundary (from `lib/usedIds`). It also must not sit next to code-ish characters: not after `_ / \ . @ # = :`, not before `_ / \ @`, and not before a dot that continues a token (`A-B32.png`). That excludes `upload:A-B32` (Invariant 6), `?note=A-B32` in prose, file paths and snake_case. Of those candidates, the segmenter links:
  - a **known** id (in App's loaded store), in any case. The text stays as written and the id is canonical.
  - an **unknown** id written in canonical upper case (`[0-9A-Z]-[0-9A-Z]{3}`). Such an id may sit past the 2000-note page or in the bin; clicking it fetches the note or shows the notice.
  
  A lower-case unknown candidate (`x-ray`, `e-Bay`) stays text. Ids without a dash (`AB32`, `2024`) are never linked: the dash is what separates an id from years and words.
- **Code spans** (CommonMark backtick runs, an opener matched by the next run of the same length) are never scanned. While streaming, an unmatched opener means the span is not closed yet, so nothing after it is linked. Once the text is done, an unmatched opener is a literal backtick.
- **Streaming tail.** While streaming, an id that ends exactly at the end of the text is not linked yet, because the next chunk may extend it (`A-B32` → `A-B321`). It becomes a link on the next character or when the answer is done. A half id like `A-B3` never matches.

**Code:**
```ts
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
```
**Impact:** new module. `segmentLinks` and `extractUsedIds` are untouched. (`tsconfig.web.json` has no `noUncheckedIndexedAccess`, so indexed reads are typed without `!`.)

### Step 3: Segmenter unit tests
**File:** `web/src/lib/chatSegments.test.tsx` (new; node environment like `links.test.tsx`, so `window` is undefined and `wallNoteId` gets `here = null` unless a test passes it)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { segmentLinks } from './links';
import { segmentChat, wallNoteId, type ChatSegmentOptions } from './chatSegments';

const known =
  (...list: string[]) =>
  (id: string) =>
    list.includes(id);

function ids(text: string, opts: ChatSegmentOptions = {}): string[] {
  return segmentChat(text, opts).flatMap((s) => (s.kind === 'note' ? [s.id] : []));
}

describe('segmentChat: plain ids', () => {
  it('splits text around canonical ids', () => {
    expect(segmentChat('See A-B32, then C-D45.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'note', text: 'A-B32', id: 'A-B32' },
      { kind: 'text', text: ', then ' },
      { kind: 'note', text: 'C-D45', id: 'C-D45' },
      { kind: 'text', text: '.' },
    ]);
  });
  it('links a known id in any case, showing it as written', () => {
    expect(segmentChat('look at a-b32 now', { isKnown: known('A-B32') })).toEqual([
      { kind: 'text', text: 'look at ' },
      { kind: 'note', text: 'a-b32', id: 'A-B32' },
      { kind: 'text', text: ' now' },
    ]);
  });
  it('leaves unknown lower- or mixed-case words alone', () => {
    expect(ids('an x-ray, a T-shirt, e-Bay and a-b32', { isKnown: known('C-D45') })).toEqual([]);
  });
  it('links an unknown id written canonically (it may be past the page or in the bin)', () => {
    expect(ids('no note Z-Z99 here')).toEqual(['Z-Z99']);
  });
  it('needs the dash: no dashless ids, no years', () => {
    expect(ids('AB32, ab32, 2024 and 1-2-3', { isKnown: known('A-B32') })).toEqual([]);
  });
  it('does not link inside longer tokens', () => {
    expect(ids('AA-B32 A-B321 A-B32-C x-A-B32 A-B32x')).toEqual([]);
  });
  it('does not link code-ish tokens', () => {
    expect(ids('foo_A-B32 images/A-B32 a\\A-B32 A-B32.png user@A-B32 #A-B32 ?note=A-B32 [image upload:A-B32] A-B32_x A-B32/x')).toEqual([]);
  });
  it('links ids next to ordinary punctuation', () => {
    expect(ids('(A-B32) "C-D45" E-F56. K-F07: G-H19; [Q-R88] \'M-N11\'')).toEqual(['A-B32', 'C-D45', 'E-F56', 'K-F07', 'G-H19', 'Q-R88', 'M-N11']);
  });
  it('returns no segments for empty text, and segmentLinks output when there is no id', () => {
    expect(segmentChat('')).toEqual([]);
    const s = 'Read [x](https://a.com/y) and https://b.com, done.';
    expect(segmentChat(s)).toEqual(segmentLinks(s));
  });
});

describe('segmentChat: links', () => {
  it('keeps ids inside URLs and link targets part of the link', () => {
    expect(segmentChat('see https://example.com/notes/A-B32 and [x](https://e.com/?id=C-D45)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/notes/A-B32', href: 'https://example.com/notes/A-B32' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'x', href: 'https://e.com/?id=C-D45' },
    ]);
  });
  it('keeps an id that labels an external link part of that link', () => {
    expect(segmentChat('[A-B32](https://example.com/a)')).toEqual([{ kind: 'link', text: 'A-B32', href: 'https://example.com/a' }]);
  });
  it('turns markdown links to the wall into note links, keeping the label', () => {
    expect(segmentChat('[A-B32](http://localhost:7317/?note=A-B32) and [that one](http://127.0.0.1:9000/?note=c-d45)')).toEqual([
      { kind: 'note', text: 'A-B32', id: 'A-B32' },
      { kind: 'text', text: ' and ' },
      { kind: 'note', text: 'that one', id: 'C-D45' },
    ]);
  });
  it('turns a bare wall URL into a note link; trailing punctuation stays outside', () => {
    expect(segmentChat('open http://localhost:7317/?note=A-B32.')).toEqual([
      { kind: 'text', text: 'open ' },
      { kind: 'note', text: 'http://localhost:7317/?note=A-B32', id: 'A-B32' },
      { kind: 'text', text: '.' },
    ]);
  });
  it('leaves other wall URLs as links', () => {
    expect(segmentChat('http://localhost:7317/history')).toEqual([{ kind: 'link', text: 'http://localhost:7317/history', href: 'http://localhost:7317/history' }]);
    expect(segmentChat('http://localhost:7317/?note=hello')).toEqual([{ kind: 'link', text: 'http://localhost:7317/?note=hello', href: 'http://localhost:7317/?note=hello' }]);
  });
});

describe('wallNoteId', () => {
  it('reads ?note= and #id on loopback hosts and on this page host only, path / only', () => {
    expect(wallNoteId('http://localhost:9000/#a-b32')).toBe('A-B32');
    expect(wallNoteId('http://[::1]:7317/?note=ab32')).toBe('A-B32');
    expect(wallNoteId('http://wall.lan/?note=A-B32', 'wall.lan')).toBe('A-B32');
    expect(wallNoteId('https://example.com/?note=A-B32', 'wall.lan')).toBeNull();
    expect(wallNoteId('http://localhost:7317/full/A-B32')).toBeNull();
    expect(wallNoteId('not a url')).toBeNull();
  });
});

describe('segmentChat: code spans', () => {
  it('never links inside code spans of any fence length', () => {
    expect(ids('`A-B32` and ``x `C-D45` y`` but E-F56')).toEqual(['E-F56']);
  });
  it('once done, a stray backtick is literal', () => {
    expect(ids('a ` stray then A-B32')).toEqual(['A-B32']);
    expect(ids('see `A-B32 and C-D45 ')).toEqual(['A-B32', 'C-D45']);
  });
  it('while streaming, an open span links nothing after it', () => {
    expect(ids('see `A-B32 and C-D45 ', { streaming: true })).toEqual([]);
    expect(ids('E-F56 then `A-B32 and', { streaming: true })).toEqual(['E-F56']);
  });
});

describe('segmentChat: streaming', () => {
  it('never shows a half id or an id that may still grow', () => {
    expect(segmentChat('see A-B3', { streaming: true })).toEqual([{ kind: 'text', text: 'see A-B3' }]);
    expect(segmentChat('see A-B32', { streaming: true })).toEqual([{ kind: 'text', text: 'see A-B32' }]);
    expect(ids('see A-B32 ', { streaming: true })).toEqual(['A-B32']);
    expect(ids('see A-B32.', { streaming: true })).toEqual(['A-B32']);
    expect(ids('see A-B32')).toEqual(['A-B32']);
  });
  it('an unfinished wall link shows its label only, unlinked, until it completes', () => {
    expect(segmentChat('[A-B32](http://localhost:7317/?no', { streaming: true })).toEqual([{ kind: 'text', text: 'A-B32' }]);
    expect(segmentChat('[A-B32](http://localhost:7317/?note=A-B32)', { streaming: true })).toEqual([{ kind: 'note', text: 'A-B32', id: 'A-B32' }]);
  });
});
```
**Impact:** none outside the test file.

### Step 4: `ChatInline` and the note-link context
**File:** `web/src/components/ChatText.tsx` (new)
**Change:** One renderer for a paragraph of chat text. The context is how App hands "is this note loaded" and "open it" to the AnswerPanel and to the history page's bubbles, so the props of P9's `HistoryPage` and `Bubble` do not need to change. With no provider (isolated component tests, any future host), an id still renders as a real `/?note=ID` link and clicks are not intercepted.
**Code:**
```tsx
import { createContext, Fragment, useContext, useMemo, type MouseEvent } from 'react';
import { segmentChat } from '../lib/chatSegments';
import { noteHref } from '../lib/deepLink';

/** What chat text needs from the page to link note ids (App provides it, phase 11). */
export interface NoteLinks {
  /** Canonical id -> the page's store holds that note (known ids link in any case). */
  isKnown: (id: string) => boolean;
  /** Open the big note editor on `id` over the current page, without navigating. */
  open: (id: string) => void;
}

export const NoteLinkContext = createContext<NoteLinks | null>(null);

const NOBODY = (): boolean => false;

export interface ChatInlineProps {
  /** One paragraph of chat text (callers split on blank lines). */
  text: string;
  /** The last paragraph of a reply that is still streaming. */
  streaming?: boolean;
}

/** One paragraph of chat text: plain text, http(s) links (new tab) and note links (open in place). */
export function ChatInline({ text, streaming = false }: ChatInlineProps) {
  const links = useContext(NoteLinkContext);
  const isKnown = links?.isKnown ?? NOBODY;
  const segs = useMemo(() => segmentChat(text, { streaming, isKnown }), [text, streaming, isKnown]);
  return (
    <>
      {segs.map((s, j) => {
        if (s.kind === 'link') {
          return (
            <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
              {s.text}
            </a>
          );
        }
        if (s.kind === 'note') return <NoteLink key={j} id={s.id} text={s.text} open={links?.open ?? null} />;
        return <Fragment key={j}>{s.text}</Fragment>;
      })}
    </>
  );
}

interface NoteLinkProps {
  id: string;
  text: string;
  open: ((id: string) => void) | null;
}

/**
 * A real link to `/?note=ID`. A plain primary click is the page's own: it opens the editor in
 * place. Ctrl/cmd/shift/alt or a non-primary button is left to the browser (new tab or window).
 * `data-note-link`, never `data-note`: flash and scroll look up the first `[data-note]`, the card.
 */
function NoteLink({ id, text, open }: NoteLinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (open === null) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    open(id);
  };
  return (
    <a className="answer-link note-link" href={noteHref(id)} data-note-link={id} data-tip="Open note" onClick={onClick}>
      {text}
    </a>
  );
}
```
**Impact:** new module.

### Step 5: `ChatInline` tests
**File:** `web/src/components/ChatText.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ChatInline, NoteLinkContext, type NoteLinks } from './ChatText';

afterEach(cleanup);

/**
 * Click `el`. True when the page cancelled the click (no navigation). A bubbling document listener
 * records whether it was cancelled before it got there, then cancels it so jsdom does not try to
 * navigate a click the page left alone. A click the page stopped never reaches it: then the
 * dispatch result says whether it was cancelled.
 */
function press(el: Element, init: MouseEventInit = {}): boolean {
  const box: { seen: boolean | null } = { seen: null };
  const stop = (e: Event) => {
    box.seen = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', stop);
  try {
    const notCancelled = fireEvent.click(el, init);
    return box.seen ?? !notCancelled;
  } finally {
    document.removeEventListener('click', stop);
  }
}

function renderWith(text: string, links: NoteLinks | null, streaming = false) {
  return render(
    <NoteLinkContext.Provider value={links}>
      <p>
        <ChatInline text={text} streaming={streaming} />
      </p>
    </NoteLinkContext.Provider>,
  );
}

const linkOf = (c: HTMLElement, id: string) => c.querySelector(`[data-note-link="${id}"]`) as HTMLAnchorElement;

describe('ChatInline note links', () => {
  it('renders a real /?note= link with no new-tab target and no data-note', () => {
    const { container } = renderWith('see a-b32 and https://e.com', { isKnown: (id) => id === 'A-B32', open: vi.fn() });
    const a = linkOf(container, 'A-B32');
    expect(a.textContent).toBe('a-b32');
    expect(a.getAttribute('href')).toBe('/?note=A-B32');
    expect(a.className).toBe('answer-link note-link');
    expect(a.getAttribute('target')).toBeNull();
    expect(container.querySelector('[data-note]')).toBeNull();
    expect(container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://e.com');
    expect(container.textContent).toBe('see a-b32 and https://e.com');
  });

  it('a plain click opens the note in place and cancels navigation', () => {
    const open = vi.fn();
    const { container } = renderWith('see A-B32 now', { isKnown: () => false, open });
    expect(press(linkOf(container, 'A-B32'))).toBe(true);
    expect(open).toHaveBeenCalledWith('A-B32');
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])('a modified click %j is left to the browser', (init) => {
    const open = vi.fn();
    const { container } = renderWith('see A-B32 now', { isKnown: () => false, open });
    expect(press(linkOf(container, 'A-B32'), init)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('a wall deep link keeps a real same-origin /?note= href; only a plain click is intercepted', () => {
    const open = vi.fn();
    const { container } = renderWith('see [that note](http://localhost:7317/?note=A-B32)', { isKnown: () => false, open });
    const a = linkOf(container, 'A-B32');
    expect(a.textContent).toBe('that note');
    expect(a.getAttribute('href')).toBe('/?note=A-B32');
    expect(a.getAttribute('target')).toBeNull();
    expect(press(a, { ctrlKey: true })).toBe(false);
    expect(press(a, { button: 1 })).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(press(a)).toBe(true);
    expect(open).toHaveBeenCalledWith('A-B32');
  });

  it('without a provider an id is a plain link and a click is not intercepted', () => {
    const { container } = renderWith('see A-B32 now', null);
    expect(linkOf(container, 'A-B32').getAttribute('href')).toBe('/?note=A-B32');
    expect(press(linkOf(container, 'A-B32'))).toBe(false);
  });

  it('without a provider a lower-case id is not linked (nothing is known)', () => {
    const { container } = renderWith('see a-b32 now', null);
    expect(container.querySelector('a')).toBeNull();
  });

  it('a code span is not linked', () => {
    const { container } = renderWith('run `notes get A-B32` first', { isKnown: () => true, open: vi.fn() });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('run `notes get A-B32` first');
  });

  it('a streaming id at the end is not linked until the next character', () => {
    const links: NoteLinks = { isKnown: () => true, open: vi.fn() };
    const { container, rerender } = renderWith('see A-B32', links, true);
    expect(container.querySelector('a')).toBeNull();
    rerender(
      <NoteLinkContext.Provider value={links}>
        <p>
          <ChatInline text="see A-B32." streaming />
        </p>
      </NoteLinkContext.Provider>,
    );
    expect(linkOf(container, 'A-B32')).not.toBeNull();
  });
});
```
**Impact:** none.

### Step 6a: AnswerPanel renders through `ChatInline`
**File:** `web/src/components/AnswerPanel.tsx` as P9 left it (P3's thumbnails, P9's Lightbox buttons and "Chat in full screen" button stay as they are)
**Change:** Replace the inline `segmentLinks(...).map(...)` with `<ChatInline>`. After it, nothing in the file uses `Fragment` or `segmentLinks` (P3's and P9's additions use neither), so replace P9's
```tsx
import { Fragment, useState } from 'react';
```
with
```tsx
import { useState } from 'react';
```
delete `import { segmentLinks } from '../lib/links';`, and add after P9's `import { Lightbox } from './Lightbox';`:
```tsx
import { ChatInline } from './ChatText';
```
The used-chips row is unchanged.
**Code:**
The body block, replacing the `parts.map` callback in full:
```tsx
          {parts.map((t, i) => {
            const streaming = !done && i === parts.length - 1;
            return (
              <p key={i}>
                <ChatInline text={t} streaming={streaming} />
                {streaming ? ' ▍' : ''}
              </p>
            );
          })}
```
**Impact:** links and text render the same as before when the text has no ids. Every existing `AnswerPanel.test.tsx` case still passes: their texts hold no ids except the collapsed one, which renders no body.

### Step 6b: AnswerPanel tests
**File:** `web/src/components/AnswerPanel.test.tsx` (append; add `NoteLinkContext` and `NoteLinks` to the imports)
**Code:**
```tsx
import { NoteLinkContext, type NoteLinks } from './ChatText';

describe('AnswerPanel note ids (phase 11)', () => {
  function renderLinked(links: NoteLinks, over: Partial<AnswerPanelProps> = {}) {
    return render(
      <NoteLinkContext.Provider value={links}>
        <AnswerPanel {...props(over)} />
      </NoteLinkContext.Provider>,
    );
  }

  it('links note ids in place, keeps URLs as new-tab links and keeps the used-chips row', () => {
    const open = vi.fn();
    const onJump = vi.fn();
    const { container } = renderLinked(
      { isKnown: (id) => id === 'A-B32', open },
      { text: 'Look at a-b32 and https://e.com/C-D45.', usedIds: ['A-B32'], onJump },
    );
    const notes = [...body(container).querySelectorAll('a.note-link')];
    expect(notes.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['a-b32', '/?note=A-B32']]);
    expect(body(container).querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://e.com/C-D45');
    expect(body(container).textContent).toBe('Look at a-b32 and https://e.com/C-D45.');
    expect(fireEvent.click(notes[0] as HTMLElement)).toBe(false);
    expect(open).toHaveBeenCalledWith('A-B32');
    fireEvent.click(screen.getByRole('button', { name: 'A-B32' }));
    expect(onJump).toHaveBeenCalledWith('A-B32');
  });

  it('does not link the id still arriving at the end of the streaming paragraph', () => {
    const links: NoteLinks = { isKnown: () => true, open: vi.fn() };
    const { container, rerender } = renderLinked(links, { text: 'first A-B32\n\nnow C-D4', done: false });
    expect([...body(container).querySelectorAll('a.note-link')].map((a) => a.textContent)).toEqual(['A-B32']);
    rerender(
      <NoteLinkContext.Provider value={links}>
        <AnswerPanel {...props({ text: 'first A-B32\n\nnow C-D45', done: false })} />
      </NoteLinkContext.Provider>,
    );
    expect([...body(container).querySelectorAll('a.note-link')].map((a) => a.textContent)).toEqual(['A-B32']);
    rerender(
      <NoteLinkContext.Provider value={links}>
        <AnswerPanel {...props({ text: 'first A-B32\n\nnow C-D45', done: true })} />
      </NoteLinkContext.Provider>,
    );
    expect([...body(container).querySelectorAll('a.note-link')].map((a) => a.textContent)).toEqual(['A-B32', 'C-D45']);
  });
});
```
**Impact:** none.

### Step 6c: Bubble renders through `ChatInline` (P9's component)
**File:** `web/src/components/Bubble.tsx` (P9 Step 18, with P10 Step 7's `slots`). The read-only text of every bubble, user and assistant, goes through `<ChatInline>`. P10's edit-mode textarea (the `editor` slot) is unchanged. P10's reply quote header (the `quote` slot) stays plain text: it is already a click target that scrolls to the quoted bubble, and a link inside it would put a click target within a click target.
**Change:**

(a) Imports. Replace P10's first import line and delete P9's `segmentLinks` import:
```tsx
import { Fragment, type ReactNode } from 'react';
```
```tsx
import { segmentLinks } from '../lib/links';
```
with (the `ChatInline` import goes after P9's `import type { LightboxItem } from './Lightbox';`)
```tsx
import type { ReactNode } from 'react';
```
```tsx
import { ChatInline } from './ChatText';
```
(`Fragment` is used only by the block below in P9's file, so it goes too.)

(b) Replace P9's text block, which P10 left byte-for-byte:
```tsx
        {parts.map((t, i) => {
          const tail = streaming && i === parts.length - 1;
          return (
            <p key={i}>
              {segmentLinks(t, { streaming: tail }).map((s, j) =>
                s.kind === 'link' ? (
                  <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
                    {s.text}
                  </a>
                ) : (
                  <Fragment key={j}>{s.text}</Fragment>
                ),
              )}
              {tail ? ' ▍' : ''}
            </p>
          );
        })}
```
with
```tsx
        {parts.map((t, i) => {
          const tail = streaming && i === parts.length - 1;
          return (
            <p key={i}>
              <ChatInline text={t} streaming={tail} />
              {tail ? ' ▍' : ''}
            </p>
          );
        })}
```
The streaming reply bubble of the history composer (a local bubble with `streaming: true`) passes `tail` for its last paragraph exactly as before.
**Impact:** bubble DOM gains `<a class="answer-link note-link">` wherever ids occur. No P9 or P10 test asserts `getByText` on bubble text that contains an id (checked), so none needs changing.

### Step 6d: Bubble test
**File:** `web/src/components/Bubble.notelinks.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Bubble, type BubbleProps } from './Bubble';
import { NoteLinkContext } from './ChatText';
import { makeMessage } from '../testing/chatFixtures';

afterEach(cleanup);

const NOW = new Date('2026-10-31T05:00:00.000Z');

/** P9's Bubble props for a server row (P7 wire message via P9's fixture). */
function bubbleProps(text: string): BubbleProps {
  const msg = makeMessage('K7F2', { thread_id: 'T-HR1', role: 'assistant', text, brain: 'claude' });
  return { item: { key: msg.id, msg, local: null }, now: NOW, focused: false, onOpenImages: vi.fn() };
}

function renderBubble(text: string, open: (id: string) => void) {
  return render(
    <NoteLinkContext.Provider value={{ isKnown: () => false, open }}>
      <ol>
        <Bubble {...bubbleProps(text)} />
      </ol>
    </NoteLinkContext.Provider>,
  );
}

describe('Bubble note ids (phase 11)', () => {
  it('a plain click on an id opens the note through the page and does not navigate', () => {
    const open = vi.fn();
    const { container } = renderBubble('Saved as A-B32, see [it](http://localhost:7317/?note=C-D45).', open);
    const a = container.querySelector('[data-note-link="A-B32"]') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/?note=A-B32');
    expect(fireEvent.click(a)).toBe(false);
    expect(open).toHaveBeenCalledWith('A-B32');
    const wall = container.querySelector('[data-note-link="C-D45"]') as HTMLAnchorElement;
    expect(wall.textContent).toBe('it');
    expect(wall.getAttribute('href')).toBe('/?note=C-D45');
    expect(fireEvent.click(wall)).toBe(false);
    expect(open).toHaveBeenLastCalledWith('C-D45');
  });

  it('a ctrl-click is left to the browser', () => {
    const open = vi.fn();
    const { container } = renderBubble('Saved as A-B32.', open);
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop);
    try {
      fireEvent.click(container.querySelector('[data-note-link="A-B32"]') as HTMLElement, { ctrlKey: true });
    } finally {
      document.removeEventListener('click', stop);
    }
    expect(open).not.toHaveBeenCalled();
  });
});
```
**Impact:** none.

### Step 7: App, open in place, the pending modal, show on wall and the context
**File:** `web/src/App.tsx` as P3 (chat images), P5 (`attachFiles`, `onAttachFailed`, `removeFileWithUndo`, `hasAttachments`, the extra `NoteEditor`/`DropOverlay` props), P9 (`history` view, `hrefForView` URL sync, `HistoryPage`, `view !== 'history'` guards) and P10 (`useHistory(…, { includeDeleted: true })`, `pushUndo` on `HistoryPage`) left it. None of them touches the symbols this step anchors on (`expandedNote`, `openLinked`/`useDeepLink(...)`, the `<IconContext.Provider>` root, the `<NoteEditor` element's last prop), so place each change by the symbol named; line numbers are today's and only orientation.

**7.1 Imports.** In the `./lib/deepLink` import (new to App), and next to the other component imports:
```tsx
import { normalizeNoteId, noteHref } from './lib/deepLink';
import { NoteLinkContext, type NoteLinks } from './components/ChatText';
```

**7.2 `expandedNote` (line 76).** Replace the one-line memo. This is the robustness fix that opening fetched notes needs. A note fetched past the 2000-note page goes into the store through `upsertLocal`, but the next refetch replaces the store with the page. The editor's first blur-save calls `refetch()` itself, so that happens almost at once. Today `expandedNote` would then become null, and the editor would unmount mid-edit without `close()`, losing the draft. With this change the editor keeps the last version it showed. `removeNote` and `closeEditor` both clear `expanded`, so the fallback never brings back a note the user closed or deleted.
```tsx
  // The big editor's note. A note opened from a chat link may lie past the wall's 2000-note page:
  // the next refetch drops it from the store, and the editor keeps its last version instead of
  // unmounting mid-edit (phase 11). Closing or deleting clears `expanded`, so this never revives one.
  const lastExpanded = useRef<Note | null>(null);
  const expandedNote = useMemo(() => {
    if (!expanded) return null;
    const live = notes.find((n) => n.id === expanded);
    if (live) return live;
    const last = lastExpanded.current;
    return last !== null && last.id === expanded ? last : null;
  }, [notes, expanded]);
  lastExpanded.current = expandedNote;
```

**7.3 After `openLinked` and the `useDeepLink(...)` call (line 351), insert:**
```tsx
  // Note links in chat text (phase 11): open the big editor over whatever page is showing.
  const modalSeq = useRef(0);
  /** A link clicked while another note's editor is open: opened once that editor has closed. */
  const pendingModal = useRef<string | null>(null);

  /**
   * A note id clicked in chat text. A loaded note opens at once (`expand`, no draft); else
   * GET /api/notes/:id and upsert; a 404 the bin holds or an unknown id gets the deep link's quiet
   * notice. Never changes the view, the URL or the scroll position. Only the newest click acts.
   */
  const openNoteModal = useCallback(
    async (raw: string) => {
      const id = normalizeNoteId(raw);
      if (id === null) return;
      const seq = ++modalSeq.current;
      const stale = () => seq !== modalSeq.current;
      const open = (note: Note) => {
        const cur = expandedRef.current;
        if (cur === note.id) return;
        if (cur !== null) {
          // Close the open editor the normal way (draft saved, empty rule) before swapping notes.
          pendingModal.current = note.id;
          setCloseSignal((n) => n + 1);
          return;
        }
        expand(note, null);
      };
      const known = notesRef.current.find((n) => n.id === id);
      if (known) {
        open(known);
        return;
      }
      let note: Note | null;
      try {
        note = await fetchNote(id);
      } catch (e) {
        if (stale()) return;
        console.error('note link: fetch note failed', e);
        showLinkNotice(`could not open ${id}`);
        return;
      }
      if (stale()) return;
      if (note) {
        upsertLocal(note);
        open(note);
        return;
      }
      let deleted = false;
      try {
        deleted = (await fetchBin()).notes.some((n) => n.id === id);
      } catch (e) {
        console.error('note link: bin lookup failed', e);
      }
      if (stale()) return;
      showLinkNotice(deleted ? `${id} is deleted. Restore it from the bin.` : `no note ${id}`);
    },
    [expand, upsertLocal, showLinkNotice],
  );

  useEffect(() => {
    if (expanded !== null) return;
    const id = pendingModal.current;
    if (id === null) return;
    pendingModal.current = null;
    const note = notesRef.current.find((n) => n.id === id);
    if (note) expand(note, null);
  }, [expanded, expand]);

  /**
   * The editor's "Show on wall" icon. The editor has already closed itself (closeEditor ran), but
   * the wall mirror still says it is open until the next render. Without the reset, revealLinked
   * would treat the note as kept by the editor and skip the tag/mode reveal. Then push the wall
   * URL (a pushState fires no popstate, so the deep link is acted on here, not by useDeepLink;
   * Back and Forward later fire popstate, which useDeepLink and P9's view sync already follow) and
   * reveal: planReveal switches history/bin to the wall, fixes mode and tags, and flashes the card.
   */
  const showOnWall = useCallback(
    (note: Note) => {
      wallRef.current = { ...wallRef.current, expanded: null };
      pendingModal.current = null;
      const href = noteHref(note.id);
      const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (here !== href) window.history.pushState(null, '', href);
      void openLinked(note.id);
    },
    [openLinked],
  );

  const knownIds = useMemo(() => new Set(notes.map((n) => n.id.toUpperCase())), [notes]);
  const noteLinks = useMemo<NoteLinks>(
    () => ({
      isKnown: (id: string) => knownIds.has(id.toUpperCase()),
      open: (id: string) => {
        void openNoteModal(id);
      },
    }),
    [knownIds, openNoteModal],
  );
```
No URL-sync code here: P9's single `hrefForView` effect (P9 Step 24c) already leaves `/?note=ID` alone when the view becomes the wall (it writes `/` only when leaving `/history`), so `showOnWall`'s one `pushState` is the only history entry. `App.notelinks.test.tsx` asserts this ("from the history page: lands on the wall…", one entry).

**7.4 Provider (JSX line 374-375).** Wrap the app root:
```tsx
    <IconContext.Provider value={ICONS}>
      <NoteLinkContext.Provider value={noteLinks}>
        <div className="app">
          {/* … everything that is inside <div className="app"> today and after P9, unchanged … */}
        </div>
      </NoteLinkContext.Provider>
    </IconContext.Provider>
```
(The comment marks re-indentation only. No child changes apart from 7.5.)

**7.5 `NoteEditor` props.** Add one prop to the portaled editor, after P5's `onRemoveFile={removeFileWithUndo}`:
```tsx
              onShowOnWall={showOnWall}
```
**Impact:**
- `openNoteModal` never calls `setView`, `setMode`, `setActive`, `pushState`, `scrollTo` or `flashSelector`. The history page and the bin stay where they were, and closing returns to them untouched.
- `closeEditor` is not modified. A note opened this way goes through the same close path as a card-expanded one. An unchanged close issues no PATCH and no DELETE, and the empty rule fires only when the note really is empty: no text, no images, no files (P5).
- `useDeepLink` is not modified. It already listens to `popstate` and `hashchange`. `pushState` fires neither, so `showOnWall` calls `openLinked` itself. A later Back or Forward to `/?note=ID` fires `popstate` and re-flashes through the existing path.
- Side effect of 7.2: a card-expanded note deleted on the other laptop now stays open with its last version instead of vanishing. Closing it then tries a PATCH that 404s and is logged. That is preferred to silently losing a draft.

### Step 8: NoteEditor "Show on wall" icon
**File:** `web/src/components/NoteEditor.tsx`
**File state:** `NoteEditor.tsx` as P2 (Lightbox import, `viewing`, `isLightboxOpen()` Esc yield, `.ed-open` strip, `<Lightbox>`) and P5 (paperclip, `NoteRevealButton`, `FileChips`, `onAttachFiles`/`onRemoveFile`) left it. All of that stays.

**8.1 Import (line 2).** P5 made it `import { Check, Copy, Paperclip, Trash, X } from '@phosphor-icons/react';`. Replace it with:
```tsx
import { Check, Copy, Crosshair, Paperclip, Trash, X } from '@phosphor-icons/react';
```

**8.2 Props (inside `NoteEditorProps`, after P5's `onRemoveFile?: (file: NoteFile) => void;`).**
```tsx
  /** Phase 11: the "Show on wall" icon. The editor first closes the normal way (draft saved, empty rule), then this runs. Absent = no icon. */
  onShowOnWall?: (note: Note) => void;
```
Add `onShowOnWall` to the destructured parameters of `NoteEditor`; P5's signature becomes
```tsx
export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage, onDelete, onAttachFiles, onRemoveFile, onShowOnWall, tags: knownTags = [], closeSignal = 0 }: NoteEditorProps) {
```

**8.3 Blank flag.** After `const tags = tagsOf(draft);` (line 95):
```tsx
  // Nothing to show on the wall: close() would delete it under the empty rule.
  const blank = draft.trim() === '' && note.images.length === 0 && (note.files?.length ?? 0) === 0;
```

**8.4 Button.** In `.ed-top`, after `<span className="ed-spacer" />`, P5's `<NoteRevealButton note={note} className="ed-btn" />` and P5's `{onAttachFiles && (…)}` paperclip block (it ends with `</>` and `)}` after the hidden `input[data-picker]`), and immediately before `{onDelete && (` (the Trash button). The row reads: spacer, note reveal, paperclip, show on wall, delete, close.
```tsx
          {onShowOnWall && (
            <button
              type="button"
              className="ed-btn"
              data-tip="Show on wall"
              aria-label="Show on wall"
              disabled={blank}
              onClick={() => {
                if (closedRef.current) return;
                close();
                onShowOnWall(noteRef.current);
              }}
            >
              <Crosshair weight="duotone" />
            </button>
          )}
```
**8.5 CSS.** `web/src/components/NoteEditor.css`, after `.ed-btn:hover { background: var(--hover); }` (line 10; neither P2 nor P5 adds a `:disabled` rule):
```css
.ed-btn:disabled { opacity: .35; cursor: default; }
.ed-btn:disabled:hover { background: transparent; }
```
**Impact:** callers without `onShowOnWall` render the same as before.

### Step 9: Existing App test assertion
**File:** `web/src/App.test.tsx`, test "streams the chat answer, shows used-note chips, and dims non-used cards" (line 102 today)
**Change:** The answer `a-b32` is a known id and `Z-Z99` is canonical, so both are now links and the paragraph's own text nodes no longer equal the whole sentence. Replace
```tsx
    expect(screen.getByText('Look at a-b32 and Z-Z99.')).toBeTruthy();
```
with
```tsx
    expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at a-b32 and Z-Z99.');
    expect([...document.querySelectorAll('.answer-body a.note-link')].map((a) => a.textContent)).toEqual(['a-b32', 'Z-Z99']);
```
**Impact:** same intent, plus it asserts the links.

### Step 10: App-level tests
**File:** `web/src/App.notelinks.test.tsx` (new). The harness follows `App.deeplink.test.tsx`: a stubbed `fetch`, a recorded `animate` as the flash probe, and real timers with `waitFor`. The deep-link suite runs on real timers, not fake ones, because `flashSelector` polls with `setTimeout` and `useNotes` debounces. The history-view test answers `GET /api/chat/messages…` with a P7 `ChatPage` built from P9's `makeMessage`.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bin, Note } from './types';
import { makeNote } from './testing/fixtures';
import { makeMessage } from './testing/chatFixtures';
import { App } from './App';

const iso = new Date().toISOString();
const older = new Date(Date.now() - 3_600_000).toISOString();

// Made-up notes only. Q-R88 lies past the wall's page; G-H19 is in the bin; Z-Z99 does not exist.
const textA = makeNote('A-B32', '#seer onboarding is long', { created: older });
const textC = makeNote('C-D45', 'buy fennel #kitchen', { created: older });
const photoK = makeNote('K-F07', 'River #walks', { created: older, updated: iso, images: ['K-F07', 'M-N11'] });
const far = makeNote('Q-R88', 'an old note past the first page', { created: older });
const gone: Note = { ...makeNote('G-H19', 'a deleted draft', { created: older }), deleted_at: iso };
const page = [textA, textC, photoK];

const ANSWER = 'See a-b32, Q-R88, G-H19, Z-Z99 and K-F07.';

// P7 wire for GET /api/chat/messages (`ChatPage`), built with P9's fixture. App asks with include_deleted=1 (P10).
const HISTORY = {
  messages: [
    makeMessage('K7F2', { thread_id: 'T-HR1', role: 'user', text: 'where is the seer note?', created_at: older }),
    makeMessage('M3Q9', { thread_id: 'T-HR1', role: 'assistant', text: 'It is A-B32.', created_at: older, brain: 'claude' }),
  ],
  next_before: null,
};

let calls: string[];
let flashed: string[];

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  flashed = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (method === 'POST' && url === '/api/chat') {
        const done = { thread_id: 't1', user_message_id: 'U001', assistant_message_id: 'A001', reply_to: null };
        return new Response(`event: delta\ndata: ${JSON.stringify({ text: ANSWER })}\n\nevent: done\ndata: ${JSON.stringify(done)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (method === 'GET' && url.startsWith('/api/chat/messages')) return json(HISTORY);
      if (method === 'GET' && url.startsWith('/api/notes?')) return json({ notes: page, next_cursor: null });
      const one = url.match(/^\/api\/notes\/([^/?]+)$/);
      if (one && method === 'GET') {
        const id = decodeURIComponent(one[1]);
        const hit = [...page, far].find((n) => n.id === id);
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
      }
      if (one && method === 'PATCH') {
        const id = decodeURIComponent(one[1]);
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        const base = [...page, far].find((n) => n.id === id) as Note;
        return json({ ...base, body });
      }
      if (url.startsWith('/api/tags')) return json([]);
      if (url.startsWith('/api/bin')) {
        const bin: Bin = { notes: [gone], images: [] };
        return json(bin);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function animate(this: HTMLElement): Animation {
      flashed.push(this.getAttribute('data-note') ?? this.getAttribute('data-bin-note') ?? '?');
      return {} as Animation;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  window.history.replaceState(null, '', '/');
});

const at = (url: string) => window.history.replaceState(null, '', url);
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const notice = () => document.querySelector('[data-link-notice]')?.textContent ?? null;
const card = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
const dialog = (id: string) => screen.queryByRole('dialog', { name: `Edit note ${id}` });
const link = (id: string) => document.querySelector<HTMLAnchorElement>(`.answer [data-note-link="${id}"]`);
const tagChip = (id: string, tag: string) =>
  Array.from(card(id)?.querySelectorAll('.tagchip') ?? []).find((el) => el.textContent === `#${tag}`) as HTMLElement;
const settle = () => new Promise((r) => setTimeout(r, 300));
const mutations = () => calls.filter((c) => c.startsWith('PATCH ') || c.startsWith('DELETE '));

/** Click; true when the page cancelled it (see ChatText.test.tsx `press`). */
function press(el: Element, init: MouseEventInit = {}): boolean {
  const box: { seen: boolean | null } = { seen: null };
  const stop = (e: Event) => {
    box.seen = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', stop);
  try {
    const notCancelled = fireEvent.click(el, init);
    return box.seen ?? !notCancelled;
  } finally {
    document.removeEventListener('click', stop);
  }
}

const loadedWall = async () => {
  render(<App />);
  await screen.findByText('onboarding is long');
};

const ask = async () => {
  fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'which notes?' } });
  fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
  await waitFor(() => expect(document.querySelector('.answer .used-row')).not.toBeNull());
};

describe('App: note ids in chat open the big editor in place', () => {
  it('renders each id as a /?note= link, canonical href, text as written', async () => {
    await loadedWall();
    await ask();
    expect(link('A-B32')?.textContent).toBe('a-b32');
    expect(link('A-B32')?.getAttribute('href')).toBe('/?note=A-B32');
    for (const id of ['Q-R88', 'G-H19', 'Z-Z99', 'K-F07']) expect(link(id)).not.toBeNull();
    expect(within(document.querySelector('.answer') as HTMLElement).getByRole('button', { name: 'A-B32' }).className).toBe('usedchip');
  });

  it('a plain click on a loaded note opens the editor; URL, view and scroll stay', async () => {
    await loadedWall();
    await ask();
    vi.mocked(window.scrollTo).mockClear();
    const href = window.location.href;
    expect(press(link('A-B32') as HTMLElement)).toBe(true);
    expect(dialog('A-B32')).not.toBeNull();
    expect(window.location.href).toBe(href);
    expect(h1()).toBe('Notes.');
    expect(calls).not.toContain('GET /api/notes/A-B32');
    expect(window.scrollTo).not.toHaveBeenCalled();
    await settle();
    expect(flashed).toEqual([]);
  });

  it('closing it unchanged saves and deletes nothing and leaves the answer open', async () => {
    await loadedWall();
    await ask();
    press(link('A-B32') as HTMLElement);
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Escape' });
    expect(dialog('A-B32')).toBeNull();
    await settle();
    expect(mutations()).toEqual([]);
    expect(document.querySelector('.answer')).not.toBeNull();
  });

  it('a note past the loaded page is fetched, opened, and stays open across a refetch', async () => {
    await loadedWall();
    await ask();
    press(link('Q-R88') as HTMLElement);
    await waitFor(() => expect(dialog('Q-R88')).not.toBeNull());
    expect(calls).toContain('GET /api/notes/Q-R88');
    const pages = () => calls.filter((c) => c.startsWith('GET /api/notes?')).length;
    const before = pages();
    const ta = screen.getByLabelText('Note text') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'an old note, edited' } });
    fireEvent.blur(ta);
    await waitFor(() => expect(calls).toContain('PATCH /api/notes/Q-R88'));
    await waitFor(() => expect(pages()).toBeGreaterThan(before), { timeout: 2000 });
    await settle();
    expect(dialog('Q-R88')).not.toBeNull();
    expect((screen.getByLabelText('Note text') as HTMLTextAreaElement).value).toBe('an old note, edited');
  });

  it('a deleted note says so quietly and stays on the wall (no bin switch, no editor)', async () => {
    await loadedWall();
    await ask();
    press(link('G-H19') as HTMLElement);
    await waitFor(() => expect(notice()).toBe('G-H19 is deleted. Restore it from the bin.'));
    expect(h1()).toBe('Notes.');
    expect(dialog('G-H19')).toBeNull();
    expect(flashed).toEqual([]);
  });

  it('an unknown id says "no note"', async () => {
    await loadedWall();
    await ask();
    press(link('Z-Z99') as HTMLElement);
    await waitFor(() => expect(notice()).toBe('no note Z-Z99'));
    expect(calls).toContain('GET /api/notes/Z-Z99');
    expect(document.querySelector('[data-modal="editor"]')).toBeNull();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])('a modified click %j keeps the real link', async (init) => {
    await loadedWall();
    await ask();
    expect(press(link('A-B32') as HTMLElement, init)).toBe(false);
    expect(document.querySelector('[data-modal="editor"]')).toBeNull();
  });

  it('opens over the bin without leaving it', async () => {
    await loadedWall();
    await ask();
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    press(link('A-B32') as HTMLElement);
    expect(dialog('A-B32')).not.toBeNull();
    expect(h1()).toBe('Deleted.');
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Escape' });
    expect(h1()).toBe('Deleted.');
  });

  it('opens over the history page; closing returns to it with no navigation', async () => {
    at('/history');
    render(<App />);
    const a = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('[data-note-link="A-B32"]');
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    const len = window.history.length;
    expect(press(a)).toBe(true);
    expect(dialog('A-B32')).not.toBeNull();
    expect(window.location.pathname).toBe('/history');
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Escape' });
    expect(dialog('A-B32')).toBeNull();
    expect(window.location.pathname).toBe('/history');
    expect(window.history.length).toBe(len);
    expect(document.querySelector('[data-note-link="A-B32"]')).not.toBeNull();
  });
});

describe('App: "Show on wall" in the big editor', () => {
  it('from the bin: closes the editor, switches to the wall, pushes /?note=ID and flashes the card', async () => {
    await loadedWall();
    await ask();
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    press(link('A-B32') as HTMLElement);
    const len = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    expect(dialog('A-B32')).toBeNull();
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
    expect(`${window.location.pathname}${window.location.search}`).toBe('/?note=A-B32');
    expect(window.history.length).toBe(len + 1);
    expect(mutations()).toEqual([]);
  });

  it('from the history page: lands on the wall with the card flashed', async () => {
    at('/history');
    render(<App />);
    const a = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('[data-note-link="A-B32"]');
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    press(a);
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(`${window.location.pathname}${window.location.search}`).toBe('/?note=A-B32');
    expect(card('A-B32')).not.toBeNull();
  });

  it('drops an active tag that hides the note (the editor no longer counts as keeping it)', async () => {
    await loadedWall();
    await ask();
    fireEvent.click(tagChip('C-D45', 'kitchen'));
    expect(h1()).toBe('#kitchen');
    expect(card('A-B32')).toBeNull();
    press(link('A-B32') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
    expect(card('A-B32')).not.toBeNull();
  });

  it('a photo note hidden by text mode switches to Everything.', async () => {
    await loadedWall();
    await ask();
    press(link('K-F07') as HTMLElement);
    expect(dialog('K-F07')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['K-F07']));
    expect(h1()).toBe('Everything.');
  });

  it('a later Forward/Back through popstate re-reads the URL as before', async () => {
    await loadedWall();
    await ask();
    press(link('A-B32') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    window.history.pushState(null, '', '/?note=C-D45');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(flashed).toEqual(['A-B32', 'C-D45']));
  });
});
```
**Impact:** none on production code.

### Step 11: NoteEditor tests
**File:** `web/src/components/NoteEditor.test.tsx` (append; reuses the file's `renderEditor`, `note`, `img`)
**Code:**
```tsx
describe('NoteEditor: show on wall (phase 11)', () => {
  it('has no icon without onShowOnWall', () => {
    const { queryByLabelText } = renderEditor(note('x'));
    expect(queryByLabelText('Show on wall')).toBeNull();
  });

  it('closes the normal way first (draft and dirty flag), then asks to show the note', () => {
    const onShowOnWall = vi.fn();
    const n = note('first');
    const { ta, getByLabelText, props } = renderEditor(n, { onShowOnWall });
    fireEvent.change(ta, { target: { value: 'first, edited' } });
    const btn = getByLabelText('Show on wall');
    expect(btn.getAttribute('data-tip')).toBe('Show on wall');
    expect(btn.querySelector('svg')).not.toBeNull();
    fireEvent.click(btn);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledWith(n, 'first, edited', true);
    expect(onShowOnWall).toHaveBeenCalledWith(n);
    expect(vi.mocked(props.onClose).mock.invocationCallOrder[0]).toBeLessThan(onShowOnWall.mock.invocationCallOrder[0]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('is disabled while the note is empty (no text, no images, no files)', () => {
    const { ta, getByLabelText } = renderEditor(note(''), { onShowOnWall: vi.fn() });
    const btn = () => getByLabelText('Show on wall') as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    fireEvent.change(ta, { target: { value: 'now text' } });
    expect(btn().disabled).toBe(false);
    cleanup();
    const withImage = renderEditor(note('', [img('P-IC1', 'A-B32')]), { onShowOnWall: vi.fn() });
    expect((withImage.getByLabelText('Show on wall') as HTMLButtonElement).disabled).toBe(false);
  });
});
```
**Impact:** none.

### Step 12: Styles
**File:** `web/src/styles.css`, after line 115 (`.answer-link:hover`)
**Code:**
```css
.note-link { display: inline-block; text-decoration: none; border: 1px solid var(--line-25); border-radius: 999px; padding: 0 6px; font-size: 11px; line-height: 1.55; white-space: nowrap; overflow-wrap: normal; cursor: pointer; }
.note-link:hover { background: var(--fg); color: var(--bg); text-decoration: none; }
```
**Impact:** the inline chip look of `.usedchip`, kept small enough to sit in a line of text.

### Step 13: Docs (Invariant 9)
**File:** `README.md`, section "The chat bar", after the paragraph ending "switching the view if that note is hidden." (line 388)
**Code:**
```markdown

Note ids in an answer, and in every bubble on the history page, are links. A click opens the note
in the big editor right where you are: the wall, the bin or the history page stay as they were
when you close it. Ctrl/cmd-click or middle-click opens the wall on that note in a new tab. A note
the wall has not loaded is fetched; a deleted one says "A-B32 is deleted. Restore it from the
bin." and an unknown one "no note A-B32". Ids in code spans, inside URLs, paths and longer words
are left alone, and links to the wall written as `[A-B32](http://localhost:7317/?note=A-B32)` open
in place too. In the editor, the crosshair icon ("Show on wall") closes it, goes to
`/?note=<id>` and outlines the card.
```
**File:** `CHANGELOG.md`, under `## [Unreleased]` → `### Added`; create `## [Unreleased]` (above `## [v0.1.0]`) or `### Added` only if missing (on merge there is exactly one of each):
```markdown
- **Note-id links in chat**: ids in answers and history bubbles open the big editor in place (fetched, deleted and unknown ids handled quietly); the editor's "Show on wall" icon goes to `/?note=<id>` and flashes the card.
```

## Verification

**Setup (Invariant 10):** `cd /home/miftah/.worktrees/mcp-notes/chat-history-files-image-search && { [ -d node_modules ] || npm ci; } && { [ -e .env.local ] || ln -s ~/mcp-notes/.env.local .env.local; }`
**Build:** `npm run typecheck && npm run build`
**Tests:**
- Focused: `npx vitest run web/src/lib/chatSegments.test.tsx web/src/components/ChatText.test.tsx web/src/components/AnswerPanel.test.tsx web/src/components/Bubble.notelinks.test.tsx web/src/components/NoteEditor.test.tsx web/src/App.notelinks.test.tsx web/src/App.test.tsx web/src/App.deeplink.test.tsx web/src/hooks/useDeepLink.test.tsx`
- Full: `npm test` and `npm run test:int` (no server change; run it per Invariant 1)

**Manual check:** `npm run dev:web` against a running daemon.
- Ask the chat bar about a note. Click its id in the answer: the editor opens and the wall does not move. Ctrl-click: a new tab opens on `/?note=ID`.
- Open the history page and scroll halfway. Click an id in a bubble: the editor opens. Esc: the same scroll position, URL still `/history`.
- Click "Show on wall": the wall view, URL `/?note=ID`, the card outlined. Back returns to `/history`.
- Click a captured `/n` bubble's `[A-B32](http://localhost:7317/?note=A-B32)`: it opens in place, not in a tab.
- Click a deleted id: the top-right notice, and the view does not change.

**Exit criteria:**
- Ids inside code spans, URLs, paths, `upload:` refs and longer words are not linked (`chatSegments.test.tsx`).
- A plain click on an id in the AnswerPanel or a history Bubble opens the big editor without changing the URL, the view or the scroll position. A modified click is not intercepted.
- A fetched note survives a refetch while open.
- A deleted id or an unknown id shows the LinkNotice text and nothing else.
- The editor's "Show on wall" closes the editor, switches from bin or history to the wall, pushes `/?note=ID` (one history entry) and flashes the card.
- `npm run typecheck`, `npm test`, `npm run test:int` and `npm run build` all pass.

## Handoffs

- **P9:** owns the view→URL pathname guard (`hrefForView`); this phase relies on it and adds none.
- **P9/P10:** this phase replaces only Bubble's `parts.map` text block (P10 left it as P9 wrote it) and drops the now-unused `Fragment`/`segmentLinks` imports. No P9/P10 test asserts `getByText` on bubble text containing an id.
- **Not done (pre-existing, any later phase):** `openLinked` (deep link) upserts a far note that the next refetch drops again. The flash usually lands first, so it is harmless. `useNotes` has no notion of "keep these ids across a refetch". This phase fixed only the modal path (Step 7.2). A general keep-set in `useNotes` would belong to a follow-up.
- **Not done:** reply quote headers (P10) keep their text plain, by design, because they are a click target already.
- **Not done:** the wall chat system prompt (`src/chat/prompt.ts`) still asks for bare ids, which this phase links. No server change is needed or made.

## Rollback

Revert this phase's commits. No data or schema is involved. Revert by hand only if partially landed:
- delete `web/src/lib/chatSegments.ts`, `web/src/components/ChatText.tsx` and their tests, plus `App.notelinks.test.tsx` and `Bubble.notelinks.test.tsx`
- restore the `segmentLinks` map in `AnswerPanel.tsx` and `Bubble.tsx`
- remove `onShowOnWall`, the icon and `.ed-btn:disabled` from `NoteEditor`
- remove `openNoteModal`, `pendingModal`, `showOnWall`, `noteLinks`, the provider and the `expandedNote` fallback from `App.tsx`
- remove `noteHref` from `lib/deepLink.ts` and `.note-link` from `styles.css`
- restore the `getByText` assertion in `App.test.tsx`, and drop the README paragraph and the CHANGELOG line
