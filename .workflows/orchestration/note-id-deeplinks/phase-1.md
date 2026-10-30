# Phase 1: Wall deep link

**Plan set:** `NOTE_ID_DEEPLINKS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-180927-N8LK_code_analyzer.md`
**Satisfies:** R1, R4. Opening `/?note=<id>` or `/#<id>` on the wall selects the note: it is scrolled into view and briefly outlined, whatever state the wall is in. R4 here covers the single-note fetch fallback past the 2000-note page, offering the Bin for a deleted note, and making sure an SSE refetch does not select the note again.
**Depends on:** none
**Difficulty:** HARD
**Package:** `web/src`

---

## Goal

The wall reads its own URL. Once the first notes fetch has resolved, and again on every `hashchange` and `popstate`, it takes the note id from `#<id>` or `?note=<id>`. Case does not matter and the dash is optional. It then makes the note visible: it leaves the Bin, switches to `all` when the mode hides the note, drops only the active tags that exclude it, and closes a big editor that is open on a *different* note. Then it scrolls to the card and plays the existing `flashNote` outline. A note past the loaded page is fetched with `GET /api/notes/:id`. A deleted note opens the Bin on its card with a notice. An unknown id shows a quiet notice, and an invalid id is ignored. The URL is never rewritten.

## Interface Contract

**Deletes:** the local definition of `flashNote` in `web/src/components/DropOverlay.tsx:38-54` moves to `web/src/lib/flash.ts`. `DropOverlay.tsx` re-exports it, so `import { flashNote } from './components/DropOverlay'` keeps working.
**Renames:** none
**Creates:**
- `web/src/lib/deepLink.ts`: `normalizeNoteId(input)`, `parseDeepLink(search, hash)`, `deepLinkFromLocation(loc)`
- `web/src/lib/flash.ts`: `FlashOptions`, `noteSelector(id)`, `binNoteSelector(id)`, `pulse(el)`, `flashSelector(selector, opts)`, `flashNote(id, delayMs)`
- `web/src/lib/reveal.ts`: `RevealState`, `RevealPlan`, `tagsKeeping(note, active)`, `planReveal(note, state, opts)`
- `web/src/hooks/useDeepLink.ts`: `useDeepLink(ready, onLink)`
- `web/src/api.ts`: `fetchNote(id): Promise<Note | null>` (`GET /api/notes/:id`, 404 means null)
- `web/src/components/LinkNotice.tsx` + `LinkNotice.css`: `LinkNotice({ text })`, DOM `[data-link-notice]`
- `NoteEditorProps.closeSignal?: number` (`web/src/components/NoteEditor.tsx`)
- tests: `web/src/lib/deepLink.test.tsx`, `web/src/lib/flash.test.tsx`, `web/src/lib/reveal.test.tsx`, `web/src/hooks/useDeepLink.test.tsx`, `web/src/App.deeplink.test.tsx`, a new `describe` in `web/src/components/NoteEditor.test.tsx`
- README: a `### Links to a note` subsection at the end of "A tour of the wall", plus its Contents line

**Signature changes:** `flashNote(id: string, delayMs = 450): void` becomes `flashNote(id: string, delayMs = 450): () => void`. It now returns a cancel function. Existing callers ignore the return value, so they still compile.
**Requires (from earlier phases):** nothing.
**URL contract this phase implements (consumed by Phases 2 and 3):** `<wall>/?note=<ID>` and `<wall>/#<ID>`, where `<ID>` may be in any case and may lack its dash (`f-zh5`, `FZH5`, `F-ZH5`). When both are present and the hash holds a valid id, **the hash wins**, because it is the part that changes in place on `hashchange`. Otherwise `?note=` is used. Any other value is ignored silently. The path must be `/` (or `/index.html`); `src/http/static.ts` already serves `index.html` for `/` with any query or hash.
**Leaves alone (owned by others):** `src/**` (no server change; `GET /api/notes/:id` and `GET /api/bin` already exist), `claude/**` (Phases 2, 3), `docs/INSTALL.md` and README sections other than the new subsection and its Contents line (Phase 2 owns "Using it from Claude Code" / Configuration, and Phase 3 owns "Repository layout").

## Decisions taken in this phase

| Fork | Chosen | Why |
|---|---|---|
| Strip the param after use? | **No.** The URL stays as it is | Reloading reselects the note, which is predictable. Stripping would need `replaceState`, which fires no event, so the plan would grow without any gain. The README says this. |
| `?note=` vs `#` when both are present | The hash wins if it is a valid id | The hash is what changes in place (`hashchange`). A page first opened with `?note=A` can still be steered with `#B`. |
| popstate + hashchange for one navigation | Coalesced: the same `href` within 100 ms fires once | Browsers fire both for a fragment navigation. Without this, every hash link would flash twice. A *different* href (for example `#A` -> `#C` -> `#a`) always fires, so the same target re-flashes on a new hashchange. |
| SSE / poll refetch | The hook's effect depends on `ready` (`useNotes().loaded`) only, never on `notes` | `loaded` goes false -> true once. Refetches change `notes` but never re-run the effect. |
| Active tags | Drop only the active tags that the target does not carry (`tagsKeeping`) | This disturbs the user's filter as little as possible. |
| Deleted target and tags | The same rule, applied to the deleted note's body (not "clear all") | Its Bin card shows up under the remaining filter. The index's "filtered to nothing" yields the same visible result, but this version is less destructive. The reconciler can flip it to `setActive([])` in one line if it wants. |
| Target is the inline-edited or expanded note | Keep that state. `planReveal` treats a kept id as visible: no mode or tag change unless the mode is `images` | `visibleOnWall` already keeps those ids, so the card is on the wall behind the editor. |
| The big editor is open on another note | Closed through its own close path (new `closeSignal` prop). The draft is saved and the empty rule applies, exactly as for Esc | The editor modal covers the wall, and a scroll behind it would be invisible. App does not own the draft, so the editor has to close itself. |
| Inline editor on another note | Left alone | The card stays visible and nothing covers the target. Blur still commits it later. |
| Notice | A separate `useNotice(6000)` instance rendered by a new fixed `LinkNotice` (top right) | App's existing notice is shown inside the big editor only, and its dedupe text must not leak to the wall. The undo line already occupies the bottom right. |
| `jump()` | Refactored onto `planReveal(note, {…, keep: []})` with `tags: false`. **Behaviour is identical** (same view and mode switch, same 50 ms delayed `scrollToNote`, no tag change, no flash) | This shares the reveal rule without changing chat citations or the Header "Last edited" link (Invariant 5). |
| Note fetched past the page | `upsertLocal(note)` (appended, since it is the oldest) | The next full refetch replaces `notes` with the 2000-note page and the card disappears again. Reloading the same URL brings it back. This is a known limitation, listed in Risks. |

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/lib/deepLink.ts` | create | parse `?note=` / `#`, normalise like `src/notes/ids.ts` `normalizeId` |
| `web/src/lib/deepLink.test.tsx` | create | pure parse and normalise tests |
| `web/src/lib/flash.ts` | create | `flashNote` moved here, plus `flashSelector` with wait/poll + cancel and the selector helpers |
| `web/src/lib/flash.test.tsx` | create | jsdom + fake timers |
| `web/src/lib/reveal.ts` | create | pure `planReveal` / `tagsKeeping` |
| `web/src/lib/reveal.test.tsx` | create | pure tests |
| `web/src/hooks/useDeepLink.ts` | create | load + hashchange + popstate listener, gated on `ready`, coalesced |
| `web/src/hooks/useDeepLink.test.tsx` | create | `renderHook` tests |
| `web/src/api.ts:34` | modify | add `fetchNote` after `fetchNotes` |
| `web/src/components/DropOverlay.tsx:1-54` | modify | delete the local `flashNote`, then import and re-export it from `../lib/flash` |
| `web/src/components/NoteEditor.tsx:9-58` | modify | `closeSignal` prop + effect |
| `web/src/components/NoteEditor.test.tsx:200` | modify | append a `closeSignal` describe |
| `web/src/components/LinkNotice.tsx` | create | fixed quiet label |
| `web/src/components/LinkNotice.css` | create | its style |
| `web/src/App.tsx` | modify | imports, `loaded`, link state, `wallRef`, `jump` on `planReveal`, `revealLinked`, `openLinked`, `useDeepLink`, `closeSignal` on `NoteEditor`, `<LinkNotice>` |
| `web/src/App.deeplink.test.tsx` | create | App-level tests with stubbed fetch |
| `README.md:22`, `README.md:254` | modify | one Contents line, plus the `### Links to a note` subsection |

## Implementation Steps

### Step 1: Parse and normalise the deep link
**File:** `web/src/lib/deepLink.ts` (new)
**Change:** A web-side copy of the server's `normalizeId` (`src/notes/ids.ts`, `LOOSE_ID = /^([0-9A-Z])-?([0-9A-Z]{3})$/` after trim + upper-case). The web tsconfig cannot import from `src/`, so the code is copied.
**Code:**
```ts
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
```
**Impact:** new module only.

### Step 2: Parse tests
**File:** `web/src/lib/deepLink.test.tsx` (new; `.tsx` because `vitest.config.ts` includes only `web/src/**/*.test.tsx`)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { deepLinkFromLocation, normalizeNoteId, parseDeepLink } from './deepLink';

describe('normalizeNoteId', () => {
  it.each([
    ['A-B32', 'A-B32'],
    ['a-b32', 'A-B32'],
    ['ab32', 'A-B32'],
    ['AB32', 'A-B32'],
    [' a-b32 ', 'A-B32'],
    ['0-000', '0-000'],
    ['z9zz', 'Z-9ZZ'],
  ])('%j -> %s', (input, out) => {
    expect(normalizeNoteId(input)).toBe(out);
  });

  it.each(['', 'A', 'A-B3', 'A-B323', 'AB-32', 'A--B32', 'A_B32', 'Ä-B32', 'A-B32x', 'top', '/full/A-B32'])('%j -> null', (input) => {
    expect(normalizeNoteId(input)).toBeNull();
  });
});

describe('parseDeepLink', () => {
  it.each([
    ['?note=a-b32', '', 'A-B32'],
    ['?note=FZH5', '', 'F-ZH5'],
    ['?x=1&note=%20c-d45', '', 'C-D45'],
    ['', '#F-ZH5', 'F-ZH5'],
    ['', '#fzh5', 'F-ZH5'],
    ['', '#a%2Db32', 'A-B32'],
    ['?note=A-B32', '#C-D45', 'C-D45'],
    ['?note=A-B32', '#top', 'A-B32'],
  ])('search %j, hash %j -> %s', (search, hash, out) => {
    expect(parseDeepLink(search, hash)).toBe(out);
  });

  it.each([
    ['', ''],
    ['', '#'],
    ['?note=', ''],
    ['?note=hello', ''],
    ['?id=A-B32', ''],
    ['', '#%E0%A4%A'],
    ['?note=hello', '#nope'],
  ])('search %j, hash %j -> null', (search, hash) => {
    expect(parseDeepLink(search, hash)).toBeNull();
  });

  it('reads a Location-like object', () => {
    expect(deepLinkFromLocation({ search: '?note=k-f07', hash: '' })).toBe('K-F07');
  });
});
```

### Step 3: Move `flashNote` to a shared lib, and add wait/poll + cancel
**File:** `web/src/lib/flash.ts` (new)
**Change:** The same scroll and the same 1.6 s outline as `DropOverlay.tsx:39-54`, now split into `pulse(el)` and `flashSelector(selector, { delayMs, waitMs })`. `waitMs` keeps looking every 50 ms. This is needed for a card that renders after a mode or view switch, or for a Bin card that appears after `GET /api/bin`. The retry count is a counter rather than a clock, so fake timers stay deterministic. The id is quoted for the attribute selector.
**Code:**
```ts
/** Scroll-to + outline pulse for a wall card, gallery tile or bin card (dedupe hits, deep links). */

export interface FlashOptions {
  /** Wait this long before the first look, so React can render a view/mode switch first. Default 450. */
  delayMs?: number;
  /** When the element is not there yet, keep looking every 50 ms for up to this long. Default 0 (one look). */
  waitMs?: number;
}

const POLL_MS = 50;

const quote = (v: string): string => `"${v.replace(/["\\]/g, '\\$&')}"`;

/** The wall card (NoteCard) or gallery tiles (Gallery) of a live note. */
export function noteSelector(id: string): string {
  return `[data-note=${quote(id)}]`;
}

/** The card of a deleted note in the bin (Bin.tsx `BinCard`). */
export function binNoteSelector(id: string): string {
  return `[data-bin-note=${quote(id)}]`;
}

/** Scroll `el` to the middle of the window and pulse a 1.6 s outline on it. */
export function pulse(el: HTMLElement): void {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (typeof el.animate !== 'function') return;
  el.animate(
    [
      { outline: '1px solid rgba(236,235,228,.85)', outlineOffset: '3px' },
      { outline: '1px solid rgba(236,235,228,.85)', outlineOffset: '3px', offset: 0.6 },
      { outline: '1px solid rgba(236,235,228,0)', outlineOffset: '3px' },
    ],
    { duration: 1600, easing: 'ease-out' },
  );
}

/** Pulse the first element matching `selector` after `delayMs`, waiting up to `waitMs` for it. Returns a cancel function. */
export function flashSelector(selector: string, { delayMs = 450, waitMs = 0 }: FlashOptions = {}): () => void {
  let timer: number | undefined;
  let cancelled = false;
  let tries = Math.max(0, Math.ceil(waitMs / POLL_MS));
  const look = (): void => {
    if (cancelled) return;
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      pulse(el);
      return;
    }
    if (tries <= 0) return;
    tries -= 1;
    timer = window.setTimeout(look, POLL_MS);
  };
  timer = window.setTimeout(look, delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

/** Scroll the card (or gallery tile) of `id` into view and pulse an outline on it. Returns a cancel function. */
export function flashNote(id: string, delayMs = 450): () => void {
  return flashSelector(noteSelector(id), { delayMs });
}
```

### Step 4: `DropOverlay` uses the shared `flashNote` and keeps exporting it
**File:** `web/src/components/DropOverlay.tsx:1-54`
**Change:** Delete lines 38-54 (the doc comment and `export function flashNote ... }`). Add the import below the existing imports, and a re-export, so `import { flashNote } from './components/DropOverlay'` keeps working. Line 90 (`if (!result.created) flashNote(result.note.id);`) is unchanged.
**Code (new head of the file, lines 1-6; everything from `/** Phase 5: ...` at old line 6 through `uploadImage` at old line 36 stays as it is, and old lines 38-54 are removed):**
```tsx
import { useEffect, useRef, useState } from 'react';
import { ImageSquare, Paperclip } from '@phosphor-icons/react';
import type { Note } from '../types';
import { attachImage, type AttachResult } from '../api';
import { flashNote } from '../lib/flash';

/** Moved to lib/flash (shared with the wall's deep link); re-exported for existing importers. */
export { flashNote };
```
**Impact:** none for behaviour. `DropOverlay.test.tsx` imports only `DropOverlay, firstImageFile, hasFiles, imageFiles`.

### Step 5: Flash tests
**File:** `web/src/lib/flash.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binNoteSelector, flashNote, flashSelector, noteSelector } from './flash';
import { flashNote as reExported } from '../components/DropOverlay';

let animate: ReturnType<typeof vi.fn>;
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  animate = vi.fn();
  scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.innerHTML = '';
});

const add = (html: string) => document.body.insertAdjacentHTML('beforeend', html);

describe('flash', () => {
  it('flashNote scrolls to and pulses the card after the default 450 ms', () => {
    add('<article data-note="A-B32"></article>');
    flashNote('A-B32');
    vi.advanceTimersByTime(449);
    expect(animate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1]).toEqual({ duration: 1600, easing: 'ease-out' });
  });

  it('DropOverlay still exports the same flashNote', () => {
    expect(reExported).toBe(flashNote);
  });

  it('without waitMs looks once and gives up', () => {
    flashSelector(noteSelector('A-B32'), { delayMs: 10 });
    vi.advanceTimersByTime(10);
    add('<article data-note="A-B32"></article>');
    vi.advanceTimersByTime(1000);
    expect(animate).not.toHaveBeenCalled();
  });

  it('with waitMs keeps looking until the element appears, then pulses once', () => {
    flashSelector(binNoteSelector('G-H19'), { delayMs: 60, waitMs: 1000 });
    vi.advanceTimersByTime(60);
    expect(animate).not.toHaveBeenCalled();
    add('<article data-bin-note="G-H19"></article>');
    vi.advanceTimersByTime(50);
    expect(animate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('stops looking after waitMs', () => {
    flashSelector(noteSelector('A-B32'), { delayMs: 0, waitMs: 100 });
    vi.advanceTimersByTime(150);
    add('<article data-note="A-B32"></article>');
    vi.advanceTimersByTime(1000);
    expect(animate).not.toHaveBeenCalled();
  });

  it('the returned function cancels a pending flash', () => {
    add('<article data-note="A-B32"></article>');
    const cancel = flashNote('A-B32', 100);
    cancel();
    vi.advanceTimersByTime(500);
    expect(animate).not.toHaveBeenCalled();
  });

  it('pulses the first match only (gallery tiles share data-note)', () => {
    add('<div data-note="K-F07" id="one"></div><div data-note="K-F07" id="two"></div>');
    flashNote('K-F07', 0);
    vi.advanceTimersByTime(0);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(document.getElementById('one'));
  });

  it('quotes the id in the selector', () => {
    expect(noteSelector('A-B32')).toBe('[data-note="A-B32"]');
    expect(noteSelector('a"b\\c')).toBe('[data-note="a\\"b\\\\c"]');
    expect(binNoteSelector('G-H19')).toBe('[data-bin-note="G-H19"]');
  });
});
```

### Step 6: The reveal rule, shared by `jump` and the deep link
**File:** `web/src/lib/reveal.ts` (new)
**Code:**
```ts
import type { Mode, Note, View } from '../types';
import { isHiddenByMode } from './filter';
import { tagsOf } from './text';

/** The wall state that can hide a note. `keep` = ids `visibleOnWall` always shows (inline-edited, expanded). */
export interface RevealState {
  view: View;
  mode: Mode;
  active: string[];
  keep: ReadonlyArray<string | null>;
}

/** What to set so the note's card is on screen. `active` is the same array when unchanged. */
export interface RevealPlan {
  view: View;
  mode: Mode;
  active: string[];
  /** Something differs from the state: the card appears only after the next render. */
  changed: boolean;
}

/** The active tags the note carries (AND filter): drops only the ones that exclude it. Same array when none is dropped. */
export function tagsKeeping(note: Note, active: string[]): string[] {
  if (active.length === 0) return active;
  const own = tagsOf(note.body);
  const kept = active.filter((t) => own.includes(t));
  return kept.length === active.length ? active : kept;
}

/**
 * How to make `note` visible on the wall: leave the bin; `all` when the mode hides it (any note in
 * `images` mode, a photo note in `text` mode); with `tags`, drop the active tags that exclude it.
 * A kept note (being edited or expanded) is already on the wall unless the mode is `images`.
 * `note` may be undefined (jump on an id not in the store): only the mode rule applies, as before.
 */
export function planReveal(note: Note | undefined, s: RevealState, opts: { tags?: boolean } = {}): RevealPlan {
  const view: View = 'wall';
  const kept = note !== undefined && s.mode !== 'images' && s.keep.includes(note.id);
  const mode: Mode = !kept && isHiddenByMode(note, s.mode) ? 'all' : s.mode;
  const active = opts.tags === true && note !== undefined && !kept ? tagsKeeping(note, s.active) : s.active;
  return { view, mode, active, changed: view !== s.view || mode !== s.mode || active !== s.active };
}
```

### Step 7: Reveal tests
**File:** `web/src/lib/reveal.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { makeNote } from '../testing/fixtures';
import { planReveal, tagsKeeping, type RevealState } from './reveal';

const text = makeNote('A-B32', '#seer onboarding is long');
const both = makeNote('E-F56', 'miso soup #seer #kitchen');
const photo = makeNote('K-F07', 'River #walks', { images: ['K-F07'] });

const base: RevealState = { view: 'wall', mode: 'text', active: [], keep: [] };

describe('tagsKeeping', () => {
  it('keeps the tags the note carries and returns the same array when nothing drops', () => {
    const active = ['seer', 'kitchen'];
    expect(tagsKeeping(both, active)).toBe(active);
    expect(tagsKeeping(text, active)).toEqual(['seer']);
    expect(tagsKeeping(photo, active)).toEqual([]);
    const none: string[] = [];
    expect(tagsKeeping(text, none)).toBe(none);
  });
});

describe('planReveal', () => {
  it('changes nothing for a visible text note on the text wall', () => {
    const s = { ...base, active: ['seer'] };
    const p = planReveal(text, s, { tags: true });
    expect(p).toEqual({ view: 'wall', mode: 'text', active: ['seer'], changed: false });
    expect(p.active).toBe(s.active);
  });

  it('switches text -> all for a photo note and images -> all for any note', () => {
    expect(planReveal(photo, base)).toMatchObject({ mode: 'all', changed: true });
    expect(planReveal(text, { ...base, mode: 'images' })).toMatchObject({ mode: 'all', changed: true });
    expect(planReveal(photo, { ...base, mode: 'all' })).toMatchObject({ mode: 'all', changed: false });
  });

  it('leaves the bin', () => {
    expect(planReveal(text, { ...base, view: 'bin' })).toMatchObject({ view: 'wall', mode: 'text', changed: true });
  });

  it('drops only the excluding tags, and only with tags: true', () => {
    const s = { ...base, active: ['kitchen', 'seer'] };
    expect(planReveal(text, s, { tags: true })).toMatchObject({ active: ['seer'], changed: true });
    expect(planReveal(text, s).active).toBe(s.active);
  });

  it('a kept (edited/expanded) note needs no mode or tag change, except in images mode', () => {
    const s = { ...base, active: ['kitchen'], keep: ['K-F07', null] };
    const p = planReveal(photo, s, { tags: true });
    expect(p).toMatchObject({ mode: 'text', changed: false });
    expect(p.active).toBe(s.active);
    expect(planReveal(photo, { ...s, mode: 'images' }, { tags: true })).toMatchObject({ mode: 'all', active: [], changed: true });
  });

  it('an unknown note (jump on a missing id) keeps the old mode rule', () => {
    expect(planReveal(undefined, { ...base, mode: 'images' })).toMatchObject({ mode: 'all', changed: true });
    expect(planReveal(undefined, base)).toMatchObject({ mode: 'text', changed: false });
  });
});
```

### Step 8: The deep-link hook
**File:** `web/src/hooks/useDeepLink.ts` (new)
**Code:**
```ts
import { useEffect, useRef } from 'react';
import { deepLinkFromLocation } from '../lib/deepLink';

/** popstate and hashchange both fire for one fragment navigation; the same href inside this window counts once. */
const COALESCE_MS = 100;

/**
 * Calls `onLink(id)` with the note id in the URL (`#<id>` or `?note=<id>`, see lib/deepLink) once
 * `ready` is true, then on every hashchange / popstate that carries one. The effect depends on
 * `ready` only, so background refetches (SSE, poll) never re-select the note. The URL is not changed.
 */
export function useDeepLink(ready: boolean, onLink: (id: string) => void): void {
  const cb = useRef(onLink);
  cb.current = onLink;

  useEffect(() => {
    if (!ready) return;
    let lastHref = '';
    let lastAt = Number.NEGATIVE_INFINITY;
    const fire = (): void => {
      const href = window.location.href;
      const at = Date.now();
      if (href === lastHref && at - lastAt < COALESCE_MS) return;
      lastHref = href;
      lastAt = at;
      const id = deepLinkFromLocation(window.location);
      if (id !== null) cb.current(id);
    };
    fire();
    window.addEventListener('hashchange', fire);
    window.addEventListener('popstate', fire);
    return () => {
      window.removeEventListener('hashchange', fire);
      window.removeEventListener('popstate', fire);
    };
  }, [ready]);
}
```
**Impact:** in dev `StrictMode` (`web/src/main.tsx`) the effect runs twice on mount, so `onLink` runs twice. App's resolver supersedes the first call (sequence number + flash cancel, Step 13), so the user sees one flash.

### Step 9: Hook tests
**File:** `web/src/hooks/useDeepLink.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useDeepLink } from './useDeepLink';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const popTo = (url: string) => {
  window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

describe('useDeepLink', () => {
  it('waits for ready, then reads the URL once (rerenders do not re-fire)', () => {
    window.history.replaceState(null, '', '/?note=a-b32');
    const onLink = vi.fn();
    const { rerender } = renderHook(({ ready }) => useDeepLink(ready, onLink), { initialProps: { ready: false } });
    expect(onLink).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith('A-B32');
    rerender({ ready: true });
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('does nothing on load without a target', () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    expect(onLink).not.toHaveBeenCalled();
  });

  it('follows hashchange', async () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    act(() => {
      window.location.hash = '#cd45';
    });
    await waitFor(() => expect(onLink).toHaveBeenCalledWith('C-D45'));
  });

  it('follows popstate, and counts popstate + hashchange of one navigation once', () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    act(() => {
      popTo('/#E-F56');
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith('E-F56');
    act(() => popTo('/?note=k-f07'));
    expect(onLink).toHaveBeenCalledTimes(2);
    expect(onLink).toHaveBeenLastCalledWith('K-F07');
  });

  it('ignores ids that cannot be note ids', () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    act(() => popTo('/?note=hello#top'));
    expect(onLink).not.toHaveBeenCalled();
  });

  it('calls the latest callback and stops listening when unmounted', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ fn }) => useDeepLink(true, fn), { initialProps: { fn: first } });
    rerender({ fn: second });
    act(() => popTo('/?note=A-B32'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('A-B32');
    unmount();
    act(() => popTo('/?note=C-D45'));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
```

### Step 10: `fetchNote`
**File:** `web/src/api.ts:34` (insert after `fetchNotes`, before the `fetchTags` doc comment at line 36)
**Code:**
```ts
/** `GET /api/notes/:id` → the live note, or null on 404 (unknown or deleted). The server normalises the id. */
export async function fetchNote(id: string): Promise<Note | null> {
  const res = await fetch(`/api/notes/${enc(id)}`);
  if (res.status === 404) return null;
  await check(res);
  return (await res.json()) as Note;
}
```
**Impact:** a new export only. The server route is `src/http/api.ts:127`, unchanged: 400 `invalid_id` throws `ApiError`, but the wall never sends an invalid id.

### Step 11: `NoteEditor` can be asked to close through its own path
**File:** `web/src/components/NoteEditor.tsx`
**Change 1 (props interface, insert after line 26 `tags?: TagCount[];`):**
```ts
  /** Bumped by App to close this editor the normal way (draft saved, empty rule), e.g. a deep link to another note. The value at mount never closes it. */
  closeSignal?: number;
```
**Change 2 (line 31, the signature):**
```tsx
export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage, onDelete, tags: knownTags = [], closeSignal = 0 }: NoteEditorProps) {
```
**Change 3 (insert directly after the `close` callback, which ends at line 58 `}, []);`):**
```tsx
  const mountSignal = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal !== mountSignal.current) close();
  }, [closeSignal, close]);
```
**Impact:** an optional prop. Existing callers and tests are unaffected. `close()` is idempotent (`closedRef`).

### Step 12: `NoteEditor` test for `closeSignal`
**File:** `web/src/components/NoteEditor.test.tsx:200` (append after the final `});` of `describe('NoteEditor', …)`)
**Code:**
```tsx

describe('NoteEditor closeSignal', () => {
  it('closes through onClose with the draft when the signal changes, never on mount, once', () => {
    const n = note('kept text');
    const { ta, props, rerender } = renderEditor(n, { closeSignal: 3 });
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.change(ta, { target: { value: 'kept text, edited' } });
    rerender(<NoteEditor {...props} closeSignal={4} />);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledWith(n, 'kept text, edited', true);
    rerender(<NoteEditor {...props} closeSignal={5} />);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
```

### Step 13: `LinkNotice`
**File:** `web/src/components/LinkNotice.tsx` (new)
**Code:**
```tsx
import './LinkNotice.css';

export interface LinkNoticeProps {
  /** e.g. "no note Z-Z99"; null hides it. */
  text: string | null;
}

/** The deep link's quiet status line, top right (the undo line owns the bottom right). */
export function LinkNotice({ text }: LinkNoticeProps) {
  if (!text) return null;
  return (
    <div className="link-notice" role="status" data-link-notice="">
      {text}
    </div>
  );
}
```
**File:** `web/src/components/LinkNotice.css` (new)
**Code:**
```css
/* The undo line's look (UndoBar.css), pinned top right so it never meets the undo line or the
   answer panel by the chat bar. z-index above the editor / photo modal (60), below the drop
   overlay (70) and the tooltip (200). */
.link-notice {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 65;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--line-14);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .03em;
  color: var(--id);
  white-space: nowrap;
  animation: link-notice-in .25s ease-out;
}
@keyframes link-notice-in { from { opacity: 0; } to { opacity: 1; } }
```

### Step 14: Wire it into `App`
**File:** `web/src/App.tsx`

**14a. Imports (lines 5, 13, 14, 17, 29).** Replace line 5:
```tsx
import { createNote, deleteNote, DuplicateImageError, fetchBin, fetchNote, removeImage, restoreImage, restoreNote, updateNote, type AttachResult } from './api';
```
Replace line 13 (`import { useBin } from './hooks/useBin';`) with:
```tsx
import { useBin } from './hooks/useBin';
import { useDeepLink } from './hooks/useDeepLink';
```
Replace line 14. `isHiddenByMode` leaves this import, since it is now used only through `planReveal`, and `noUnusedLocals` would fail otherwise:
```tsx
import { BIN_HEADING, binCountLine, countLineFor, headingFor, imageCount, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
```
Replace line 17 (`import { tagsOf } from './lib/text';`) with:
```tsx
import { tagsOf } from './lib/text';
import { binNoteSelector, flashSelector, noteSelector, type FlashOptions } from './lib/flash';
import { planReveal, tagsKeeping } from './lib/reveal';
```
Replace line 29 (`import { UndoBar } from './components/UndoBar';`) with:
```tsx
import { UndoBar } from './components/UndoBar';
import { LinkNotice } from './components/LinkNotice';
```

**14b. Module constant (after line 31 `const ICONS = …;`):**
```tsx

/** Deep-link flash: after the view/mode switch renders; wait for a card that needs a fetch or the bin to load. */
const LINK_FLASH: FlashOptions = { delayMs: 60, waitMs: 3000 };
```

**14c. `loaded` (line 39):**
```tsx
  const { notes, tags, loaded, refetch, upsertLocal, removeLocal } = useNotes();
```

**14d. Link state (insert after line 53 `const binStore = useBin(active, view === 'bin');`):**
```tsx
  // Deep link (?note=<id> / #<id>): its own quiet notice (App's other notice is shown in the big
  // editor), a way to close the big editor through its normal path, and the newest-link guard.
  const { notice: linkNotice, show: showLinkNotice } = useNotice(6000);
  const [closeSignal, setCloseSignal] = useState(0);
  const linkSeq = useRef(0);
  const cancelFlash = useRef<() => void>(() => {});
```

**14e. Wall-state mirror (insert after line 58 `notesRef.current = notes;`):**
```tsx
  const wallRef = useRef({ view, mode, active, editing, expanded });
  wallRef.current = { view, mode, active, editing, expanded };
```

**14f. `jump` on the shared rule (replace lines 76-91 entirely). Behaviour is identical to today: no tag change, no flash, 50 ms delayed scroll when the view or mode changed.**
```tsx
  const jump = useCallback(
    (id: string) => {
      const note = notes.find((n) => n.id === id);
      const plan = planReveal(note, { view, mode, active, keep: [] });
      if (plan.view !== view) setView(plan.view);
      if (plan.mode !== mode) setMode(plan.mode);
      if (plan.changed) window.setTimeout(() => scrollToNote(id), 50);
      else scrollToNote(id);
    },
    [notes, mode, view, active],
  );
```

**14g. Resolver (insert after `onRestored`, i.e. after line 273, before `const send = …` at line 275):**
```tsx
  /** Put a live note on screen for a deep link, then scroll to and outline its card. */
  const revealLinked = useCallback((note: Note) => {
    const s = wallRef.current;
    if (s.expanded !== null && s.expanded !== note.id) setCloseSignal((n) => n + 1);
    const keep = [s.editing, s.expanded === note.id ? note.id : null];
    const plan = planReveal(note, { view: s.view, mode: s.mode, active: s.active, keep }, { tags: true });
    if (plan.view !== s.view) setView(plan.view);
    if (plan.mode !== s.mode) setMode(plan.mode);
    if (plan.active !== s.active) setActive(plan.active);
    cancelFlash.current();
    cancelFlash.current = flashSelector(noteSelector(note.id), LINK_FLASH);
  }, []);

  /**
   * ?note=<id> / #<id>: a loaded note is revealed; else GET /api/notes/:id (past the 2000-note page);
   * a 404 that the bin holds opens the bin on its card; else a quiet "no note <id>". Only the newest
   * link acts (a second link while one is still fetching wins).
   */
  const openLinked = useCallback(
    async (id: string) => {
      const seq = ++linkSeq.current;
      const stale = () => seq !== linkSeq.current;
      const known = notesRef.current.find((n) => n.id === id);
      if (known) {
        revealLinked(known);
        return;
      }
      let note: Note | null;
      try {
        note = await fetchNote(id);
      } catch (e) {
        if (stale()) return;
        console.error('deep link: fetch note failed', e);
        showLinkNotice(`could not open ${id}`);
        return;
      }
      if (stale()) return;
      if (note) {
        upsertLocal(note);
        revealLinked(note);
        return;
      }
      let deleted: Note | undefined;
      try {
        deleted = (await fetchBin()).notes.find((n) => n.id === id);
      } catch (e) {
        console.error('deep link: bin lookup failed', e);
      }
      if (stale()) return;
      if (deleted) {
        const binNote = deleted;
        if (wallRef.current.expanded !== null) setCloseSignal((n) => n + 1);
        setActive((a) => tagsKeeping(binNote, a));
        setView('bin');
        cancelFlash.current();
        cancelFlash.current = flashSelector(binNoteSelector(id), LINK_FLASH);
        showLinkNotice(`${id} is deleted. Restore it from the bin.`);
        return;
      }
      showLinkNotice(`no note ${id}`);
    },
    [revealLinked, upsertLocal, showLinkNotice],
  );

  useDeepLink(loaded, (id) => {
    void openLinked(id);
  });

  useEffect(() => () => cancelFlash.current(), []);
```

**14h. `NoteEditor` gets the signal (inside the portal, lines 375-386). Add one prop after `tags={tags}`:**
```tsx
            <NoteEditor
              key={expandedNote.id}
              note={expandedNote}
              copied={copied === expandedNote.id}
              notice={notice}
              onCopy={copy}
              onSave={save}
              onClose={closeEditor}
              onRemoveImage={removeImageWithUndo}
              onDelete={removeNote}
              tags={tags}
              closeSignal={closeSignal}
            />,
```

**14i. Render the notice (line 389, after `<UndoBar … />`):**
```tsx
        <UndoBar entry={undoEntry} onUndo={runUndo} />
        <LinkNotice text={linkNotice} />
```
**Impact:** `jump` keeps today's behaviour (Invariant 5). Without a URL target, nothing else runs: `useDeepLink` fires once on load, finds no id, and then only listens.

### Step 15: App-level deep-link tests
**File:** `web/src/App.deeplink.test.tsx` (new). The notes and bodies are made up.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bin, Note } from './types';
import { makeNote } from './testing/fixtures';
import { App } from './App';

const iso = new Date().toISOString();
const older = new Date(Date.now() - 3_600_000).toISOString();

// Made-up notes only. Q-R88 lies past the wall's 2000-note page; G-H19 is in the bin; Z-Z99 does not exist.
const textA = makeNote('A-B32', '#seer onboarding is long', { created: older });
const textC = makeNote('C-D45', 'buy fennel #kitchen', { created: older });
const textE = makeNote('E-F56', 'miso soup #seer #kitchen', { created: older });
const photoK = makeNote('K-F07', 'River #walks', { created: older, updated: iso, images: ['K-F07', 'M-N11'] });
const far = makeNote('Q-R88', 'an old note past the first page', { created: older });
const gone: Note = { ...makeNote('G-H19', 'a deleted draft #seer', { created: older }), deleted_at: iso };
const page = [textA, textC, textE, photoK];

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
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url.startsWith('/api/notes?')) return json({ notes: page, next_cursor: null });
      if (method === 'GET' && url.startsWith('/api/notes/')) {
        const id = decodeURIComponent(url.slice('/api/notes/'.length));
        const hit = [...page, far].find((n) => n.id === id);
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
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
const go = (hash: string) =>
  act(() => {
    window.location.hash = hash;
  });
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
const card = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const notice = () => document.querySelector('[data-link-notice]')?.textContent ?? null;
const chip = (id: string, tag: string) =>
  Array.from(card(id)?.querySelectorAll('.tagchip') ?? []).find((el) => el.textContent === `#${tag}`) as HTMLElement;
const settle = () => new Promise((r) => setTimeout(r, 200));
const loadedWall = async () => {
  render(<App />);
  await screen.findByText('onboarding is long');
};

describe('App: deep link to a note', () => {
  it('?note= with a lower-case id selects the note on load', async () => {
    at('/?note=a-b32');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
    expect(notice()).toBeNull();
  });

  it('?note= without the dash', async () => {
    at('/?note=cd45');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
  });

  it('#id of a photo note hidden by text mode switches to Everything.', async () => {
    at('/#k-f07');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['K-F07']));
    expect(h1()).toBe('Everything.');
    expect(card('K-F07')).not.toBeNull();
  });

  it('from the Photos. gallery, a text note switches to Everything.', async () => {
    await loadedWall();
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    expect(h1()).toBe('Photos.');
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Everything.');
  });

  it('drops only the active tags that exclude the note', async () => {
    await loadedWall();
    fireEvent.click(chip('C-D45', 'kitchen'));
    fireEvent.click(chip('E-F56', 'seer'));
    expect(h1()).toBe('#kitchen #seer');
    expect(card('C-D45')).toBeNull();
    go('#C-D45');
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
    expect(h1()).toBe('#kitchen');
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['C-D45', 'A-B32']));
    expect(h1()).toBe('Notes.');
  });

  it('leaves the bin view for a live note', async () => {
    await loadedWall();
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
  });

  it('follows hashchange, and a new hashchange to the same note flashes it again', async () => {
    await loadedWall();
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    go('#C-D45');
    await waitFor(() => expect(flashed).toEqual(['A-B32', 'C-D45']));
    go('#a-b32');
    await waitFor(() => expect(flashed).toEqual(['A-B32', 'C-D45', 'A-B32']));
  });

  it('follows popstate; popstate + hashchange of one navigation flash once', async () => {
    await loadedWall();
    pop('/?note=C-D45');
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
    pop('/?note=E-F56');
    await waitFor(() => expect(flashed).toEqual(['C-D45', 'E-F56']));
    act(() => {
      window.location.hash = '#A-B32';
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(flashed).toEqual(['C-D45', 'E-F56', 'A-B32']));
    await settle();
    expect(flashed).toEqual(['C-D45', 'E-F56', 'A-B32']);
  });

  it('keeps the big editor open when it holds the target', async () => {
    await loadedWall();
    fireEvent.click(within(card('A-B32') as HTMLElement).getByRole('button', { name: 'Expand note' }));
    expect(screen.getByRole('dialog', { name: 'Edit note A-B32' })).toBeTruthy();
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(screen.getByRole('dialog', { name: 'Edit note A-B32' })).toBeTruthy();
  });

  it('closes a big editor open on another note (unchanged draft: no save, no delete)', async () => {
    await loadedWall();
    fireEvent.click(within(card('A-B32') as HTMLElement).getByRole('button', { name: 'Expand note' }));
    expect(document.querySelector('[data-modal="editor"]')).not.toBeNull();
    go('#C-D45');
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
    expect(document.querySelector('[data-modal="editor"]')).toBeNull();
    expect(calls.some((c) => c.startsWith('PATCH ') || c.startsWith('DELETE '))).toBe(false);
  });

  it('keeps the inline editor of the target', async () => {
    await loadedWall();
    fireEvent.click(card('A-B32')?.querySelector('.card-text') as HTMLElement);
    expect(card('A-B32')?.querySelector('.card-edit')).not.toBeNull();
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(card('A-B32')?.querySelector('.card-edit')).not.toBeNull();
  });

  it('fetches a note that is not in the loaded page and shows it', async () => {
    at('/?note=q-r88');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['Q-R88']));
    expect(calls).toContain('GET /api/notes/Q-R88');
    expect(card('Q-R88')).not.toBeNull();
  });

  it('a deleted note opens the bin on its card with a notice', async () => {
    at('/?note=gh19');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['G-H19']));
    expect(h1()).toBe('Deleted.');
    expect(calls).toContain('GET /api/notes/G-H19');
    expect(notice()).toBe('G-H19 is deleted. Restore it from the bin.');
    const binCard = document.querySelector('[data-bin-note="G-H19"]') as HTMLElement;
    expect(within(binCard).getByRole('button', { name: 'Restore note' })).toBeTruthy();
  });

  it('an unknown id shows a quiet notice and changes nothing', async () => {
    at('/?note=Z-Z99');
    await loadedWall();
    await waitFor(() => expect(notice()).toBe('no note Z-Z99'));
    expect(h1()).toBe('Notes.');
    expect(flashed).toEqual([]);
  });

  it('ignores a value that cannot be a note id', async () => {
    at('/?note=hello');
    await loadedWall();
    await settle();
    expect(calls.some((c) => c.startsWith('GET /api/notes/'))).toBe(false);
    expect(notice()).toBeNull();
    expect(flashed).toEqual([]);
  });

  it('a background refetch (SSE note event) does not select the note again', async () => {
    class FakeES {
      static last: FakeES | null = null;
      private l = new Map<string, Array<() => void>>();
      constructor(public url: string) {
        FakeES.last = this;
      }
      addEventListener(type: string, fn: () => void) {
        this.l.set(type, [...(this.l.get(type) ?? []), fn]);
      }
      close() {}
      emit(type: string) {
        for (const fn of this.l.get(type) ?? []) fn();
      }
    }
    vi.stubGlobal('EventSource', FakeES);
    at('/?note=A-B32');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    const pages = () => calls.filter((c) => c === 'GET /api/notes?limit=2000').length;
    const before = pages();
    act(() => FakeES.last?.emit('note'));
    await waitFor(() => expect(pages()).toBe(before + 1), { timeout: 2000 });
    await settle();
    expect(flashed).toEqual(['A-B32']);
  });

  it('without a target, the Header "Last edited" jump behaves as before (no flash)', async () => {
    await loadedWall();
    fireEvent.click(screen.getByRole('link', { name: 'K-F07' }));
    await waitFor(() => expect(h1()).toBe('Everything.'));
    await settle();
    expect(flashed).toEqual([]);
    expect(window.scrollTo).toHaveBeenCalled();
  });
});
```
**Notes for the implementer:**
- jsdom fires `hashchange` asynchronously when `location.hash` is set. `waitFor` covers this.
- `lastEdited` picks `K-F07` (it is the only note with `updated: iso`), so the Header link reads `K-F07`.
- `textE` adds a second `#seer` / `#kitchen` note, so the "drop only the excluding tags" case has a note that survives a partial drop.
- If `getByRole('link', { name: 'K-F07' })` is ambiguous because a chat chip exists, it is not here: the chat is never opened in this file.

### Step 16: README
**File:** `README.md:22`. Insert a Contents line after `  - [Open file location](#open-file-location)`:
```markdown
  - [Links to a note](#links-to-a-note)
```
**File:** `README.md:254`. Insert after the last paragraph of "### Open file location" (it ends at line 254 with ``…`Origin` is not the wall's own page, so another site open in the browser cannot trigger it.``), before the blank line and `## Using it from Claude Code`:
```markdown

### Links to a note

`http://localhost:7317/?note=F-ZH5` (the port is `NOTESD_PORT`) opens the wall with that note
scrolled into view and briefly outlined; `#F-ZH5` works too, and the id may be lower-case or lack
its dash (`?note=fzh5`). The wall first makes the note visible: it leaves the bin, switches
"Notes." or "Photos." to "Everything." when the view hides it, and drops only the active tags the
note does not carry. A big editor open on another note closes the usual way, saving its text; one
open on the linked note stays open. A note older than the 2000 the wall loads is fetched on its
own. A deleted note opens the bin on its card, with a line saying it can be restored there, and an
unknown id says `no note F-ZH5` in the top right corner. The address is left as it is, so a reload
selects the note again; changing the hash or moving back and forward selects the new target.
```

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/note-id-deeplinks && npm run typecheck && npm run build:web`
**Tests:** `cd /home/miftah/.worktrees/mcp-notes/note-id-deeplinks && npx vitest run web/src` and then the full `npm test`
**Manual check (optional; never bind 7317):** `npm run dev:web` against a daemon on another port, or skip it. Open `/?note=<an id>` and `/#<id>` with made-up notes, and check the scroll, the outline and the top-right notice. Never open notes O-5KD or V-UM6.
**Exit criteria:** `/?note=f-zh5`, `/?note=FZH5` and `/#F-ZH5` each select the note from text mode, the gallery, an active tag filter, the Bin view, an open editor on that note or on another, and past the loaded page. hashchange and popstate re-resolve, and a new hashchange to the same id re-flashes. A deleted id opens the Bin on its card with the notice. An unknown id shows `no note <ID>`. An SSE refetch does not re-flash. `jump()`, chat citations and the Header link behave as before. `npm run typecheck` and `npm test` pass.

## Handoffs

- **Phase 2 (R2):** the link form to teach is `[<ID>](<wall>/?note=<ID>)` as in Invariant 4. This phase also accepts `#<ID>`, any case, dash optional. Phase 2's README text on clickable ids may point to `#links-to-a-note`, the anchor this phase adds.
- **Phase 3 (R3):** `/open <id>` should open `<wall>/?note=<ID>`. No canonicalisation is needed on the mod side, since the wall normalises the id, but the mod's own linkify should still use the canonical form.
- **Not done (out of scope, noted for later):** keeping a past-the-page note on the wall across later full refetches (`useNotes` would need a "pinned extras" set); linkifying ids inside note bodies on the wall (out of scope per the index).

## Risks

- **README adjacency:** this phase inserts a Contents line right before `- [Using it from Claude Code]` (README line 23) and a subsection right before `## Using it from Claude Code` (line 256). If Phase 2 inserts its Contents entry or subsection text immediately next to those lines, git reports a textual conflict. Resolve it by keeping both.
- **A past-the-page note** disappears from the wall at the next full refetch (SSE or the 60 s poll). Reloading the URL brings it back.
- **Timing in jsdom:** the popstate + hashchange coalescing depends on jsdom delivering `hashchange` within 100 ms of setting `location.hash`. It does this as an immediate task. If that ever flakes, the window can be raised without changing behaviour.
- **StrictMode (dev only)** runs the resolver twice on load. The sequence guard and flash cancel leave one flash, but a past-the-page or deleted target is fetched twice in dev.

## Rollback

Revert this phase's commit. Nothing outside `web/` and the two README insertions changes, there is no server or data change, and `web/dist` is untracked (rebuild with `npm run build:web`).
