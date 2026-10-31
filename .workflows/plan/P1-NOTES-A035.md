> Adopted from `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` phase 2. Source: `.workflows/plan/chat-history-files-image-search/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Shared Lightbox + note modal strip

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R4 — one shared image lightbox (chat thumbnails + the note modal's gallery strip, arrows by click and key)
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `web` (`web/src/components`)

---

## Goal

A standalone `Lightbox` component exists: it shows one image large, moves to the adjacent image with
the left/right buttons or ArrowLeft/ArrowRight without closing, disables (never wraps) at the first
and last image, and closes on Esc, a backdrop click or its X, handing focus back to whatever opened
it. It takes a generic item list (`{id, src, label?, width?, height?, film?}`) so Phase 9 can feed it
chat images from `/api/chat/images/:id/display`. The big note editor's thumbnail strip opens it:
clicking a thumbnail views that image over the note's available images, and Esc closes only the
lightbox, never the editor or the chat panel behind it.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/components/Lightbox.tsx`:
  - `interface LightboxItem { id: string; src: string; label?: string; width?: number; height?: number; film?: boolean }`
  - `interface LightboxProps { items: LightboxItem[]; index: number; onIndex: (index: number) => void; onClose: () => void }`
  - `function Lightbox(props: LightboxProps): ReactPortal | null` — portaled to `document.body`, root carries `data-lightbox=""`
  - `const LIGHTBOX_SELECTOR = '[data-lightbox]'`
  - `function isLightboxOpen(doc?: Document): boolean` — the Esc seam every other window/document key listener must consult
  - `function adjacentIndex(i: number, d: -1 | 1, len: number): number` — no wrap, `-1` past either end
  - `function noteImageItems(images: NoteImage[]): LightboxItem[]` — available images only, `imageUrl(id, 'display')`, `film: true`
- `web/src/components/Lightbox.css` (classes `lb`, `lb-top`, `lb-nav`, `lb-btn`, `lb-stage`, `lb-img`, `lb-meta`, `lb-label`; z-index 66)
- `web/src/components/Lightbox.test.tsx`
- In `NoteEditor`: CSS class `ed-open` (the thumbnail's open button, `aria-label="View image <id>"`, `data-open=<id>`).

**Signature changes:** none. `NoteEditorProps` is unchanged.
**Behavior changes:** `NoteEditor`'s window capture Esc listener returns early (does nothing) while `isLightboxOpen()` is true.
**Requires (from earlier phases):** none.
**Leaves alone (owned by others):**
- `web/src/components/PhotoModal.tsx`, `Gallery.tsx` and their CSS/tests (stay as they are; design scope).
- `web/src/components/DropOverlay.tsx`, `App.tsx`, `ChatBar.tsx` (Phase 3 / Phase 5 / Phase 9).
- `web/src/components/NoteCard.tsx`, `styles.css` (Phase 1).
- The editor's file chips, paperclip and note-level reveal button (Phase 5), the editor's show-on-wall button (Phase 11). Phase 5 and Phase 11 edit `NoteEditor.tsx` after this phase; see Handoffs for the anchor they must keep.
- Chat history thumbnails (Phase 9 consumes `Lightbox`).

## The Esc seam (why it is built this way)

Today `NoteEditor` registers `window.addEventListener('keydown', onKey, true)` on mount
(`NoteEditor.tsx:68-86`), and its Esc branch calls `close()`. The lightbox mounts later, so its own
window capture listener is registered *after* the editor's and runs *after* it on the same target and
phase. `stopPropagation()` / `stopImmediatePropagation()` in the lightbox therefore cannot stop the
editor's listener, which has already run. The seam:

1. `Lightbox` renders (via portal) a root with `data-lightbox=""`. The DOM node is committed before
   any `useEffect` runs and stays until unmount, so its presence is an exact "a lightbox is open" flag
   with no shared mutable state to keep in sync.
2. `NoteEditor`'s Esc listener starts with `if (isLightboxOpen()) return;` — it yields completely,
   including the tag-popup branch (the popup gets the next Esc).
3. `Lightbox`'s listener handles Escape / ArrowLeft / ArrowRight with `preventDefault()`,
   `stopPropagation()` and `stopImmediatePropagation()`. That stops the `App` document-level chat-panel
   Esc (`App.tsx:365-371`, which also checks `defaultPrevented`), and any window capture listener
   registered after the lightbox (the reverse order, possible on Phase 9's page).
4. Clicks: the lightbox root's React `onClick` calls `e.stopPropagation()` before `onClose()`. React
   events bubble through the React tree across portals, so without that a backdrop click inside the
   lightbox would reach the editor's `.ed` `onClick={close}` (`NoteEditor.tsx:134`) and close the
   editor too. The nav buttons sit in wrappers that stop clicks, so a click on a *disabled* nav button
   (which browsers may still dispatch to ancestors) never reaches the backdrop either.

DropOverlay is untouched: while the lightbox is open a pasted/dropped image still attaches to the open
note (`target` is still the editor's note); the strip and the lightbox's item list both grow, and the
lightbox keeps showing the same image because the editor tracks the viewed image by id, not by index.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/components/Lightbox.tsx` | create | the shared component, helpers, Esc/arrow key seam, focus handling |
| `web/src/components/Lightbox.css` | create | layout and buttons, z-index 66 |
| `web/src/components/Lightbox.test.tsx` | create | jsdom tests: click and key navigation, ends, Esc, backdrop, focus restore, error placeholder, helpers |
| `web/src/components/NoteEditor.tsx` | modify | import (line 1-7), `viewing` state (after line 47), Esc yield (line 68-86), strip thumbnails become open buttons and the lightbox renders (line 215-227) |
| `web/src/components/NoteEditor.css` | modify | append `.ed-open` rules after line 29 |
| `web/src/components/NoteEditor.test.tsx` | modify | append a `describe('NoteEditor lightbox', …)` after line 214 |
| `README.md` | modify | "The big editor" bullet list (line 149-150) and the Esc line (line 156) |
| `CHANGELOG.md` | modify | add an `## [Unreleased]` / `### Added` line above `## [v0.1.0]` (line 8) |

(The index lists 6 files; the two doc files are Invariant 9's docs update.)

## Implementation Steps

### Step 1: Create the Lightbox component
**File:** `web/src/components/Lightbox.tsx` (new)
**Change:** the whole component. Controlled like `PhotoModal` (`index` + `onIndex`), but no wrap, generic
items, portaled to `document.body`, focus moved in and restored on unmount.
**Code:**
```tsx
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, CaretRight, X } from '@phosphor-icons/react';
import { imageUrl } from '../api';
import type { NoteImage as NoteImageData } from '../types';
import { FILM_FILTER, ImagePlaceholder, aspectOf } from './NoteImage';
import './Lightbox.css';

/**
 * One image the lightbox can show. Generic on purpose: note images (`noteImageItems`) and chat
 * images (Phase 9: `src` = `/api/chat/images/<id>/display`) both fit.
 */
export interface LightboxItem {
  /** Stable identity (note image id or chat image id); also the React key of the `<img>`. */
  id: string;
  /** URL of the large rendition. */
  src: string;
  /** Short caption under the image (Geist Mono) and the image's alt text, e.g. the original file name. */
  label?: string;
  /** Natural size, for the aspect ratio of the image box and the error placeholder. 0/absent = 3:2. */
  width?: number;
  height?: number;
  /** Apply the wall's film tone (note images). Chat uploads leave it off. */
  film?: boolean;
}

export interface LightboxProps {
  items: LightboxItem[];
  /** The shown item. Out of range renders nothing (the host should then drop its "viewing" state). */
  index: number;
  /** Called with the adjacent index only; never with a wrapped or out-of-range index. */
  onIndex: (index: number) => void;
  /** Esc, a backdrop click or the X. The host unmounts the lightbox. */
  onClose: () => void;
}

/** The lightbox root carries `data-lightbox`; its presence in the DOM means "a lightbox is open". */
export const LIGHTBOX_SELECTOR = '[data-lightbox]';

/**
 * True while a lightbox is mounted. Every other modal key listener that runs before the lightbox's
 * own (an earlier-registered window capture listener, e.g. NoteEditor's Esc) must return early when
 * this is true: stopPropagation in the lightbox cannot stop a listener on the same target that
 * already ran.
 */
export function isLightboxOpen(doc: Document = document): boolean {
  return doc.querySelector(LIGHTBOX_SELECTOR) !== null;
}

/** i + d when it stays inside [0, len), else -1. No wraparound: the lightbox stops at the ends. */
export function adjacentIndex(i: number, d: -1 | 1, len: number): number {
  const j = i + d;
  return j >= 0 && j < len ? j : -1;
}

/** A note's images as lightbox items: only those whose bytes are on this machine, in note order. */
export function noteImageItems(images: NoteImageData[]): LightboxItem[] {
  return images
    .filter((img) => img.available)
    .map((img) => ({
      id: img.id,
      src: imageUrl(img.id, 'display'),
      label: img.original_name ?? img.id,
      width: img.width,
      height: img.height,
      film: true,
    }));
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function Lightbox({ items, index, onIndex, onClose }: LightboxProps) {
  const len = items.length;
  const item = index >= 0 && index < len ? items[index] : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // The one window listener reads the latest props through this ref, so it is registered once and
  // keeps its place in the listener order for the lightbox's whole life.
  const live = useRef({ index, len, onIndex, onClose });
  live.current = { index, len, onIndex, onClose };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      if (e.key !== 'Escape' && !arrow) return;
      // Alt/Ctrl/Meta + arrow is the browser's (history, word jumps): leave it alone.
      if (arrow && (e.altKey || e.ctrlKey || e.metaKey)) return;
      // Capture phase + preventDefault + stopPropagation (PhotoModal's seam) so the chat panel's
      // document listener never sees it, + stopImmediatePropagation for window capture listeners
      // registered after this one. Listeners registered before it yield via isLightboxOpen().
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const s = live.current;
      if (e.key === 'Escape') {
        s.onClose();
        return;
      }
      const j = adjacentIndex(s.index, e.key === 'ArrowLeft' ? -1 : 1, s.len);
      if (j >= 0) s.onIndex(j);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    // Take focus so keyboard users are inside the viewer; give it back to the opener (e.g. the strip
    // thumbnail) on close, if it is still in the document.
    const opener = document.activeElement;
    rootRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  if (!item) return null;

  const { css } = aspectOf({ width: item.width ?? 0, height: item.height ?? 0 });
  const prev = adjacentIndex(index, -1, len);
  const next = adjacentIndex(index, 1, len);
  const close = (e: MouseEvent) => {
    // Stop first: React bubbles through portals, and a host modal's backdrop handler (NoteEditor's
    // `.ed` onClick) must not see this click.
    e.stopPropagation();
    onClose();
  };

  return createPortal(
    <div
      ref={rootRef}
      className="lb"
      data-lightbox=""
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      onClick={close}
    >
      <div className="lb-top">
        <button type="button" className="lb-btn" data-tip="Close" aria-label="Close image viewer" onClick={close}>
          <X weight="duotone" />
        </button>
      </div>

      <div className="lb-nav lb-nav-prev" onClick={stop}>
        <button
          type="button"
          className="lb-btn"
          data-tip="Previous"
          aria-label="Previous image"
          disabled={prev < 0}
          onClick={() => {
            if (prev >= 0) onIndex(prev);
          }}
        >
          <CaretLeft weight="duotone" />
        </button>
      </div>

      <div className="lb-stage">
        {failedSrc === item.src ? (
          <ImagePlaceholder aspect={css} caption="unavailable" width="min(100%, 480px)" onClick={stop} />
        ) : (
          <img
            key={item.id}
            className="lb-img"
            src={item.src}
            alt={item.label ?? ''}
            draggable={false}
            decoding="async"
            onClick={stop}
            onError={() => setFailedSrc(item.src)}
            style={{ aspectRatio: css, filter: item.film ? FILM_FILTER : undefined }}
          />
        )}
      </div>

      <div className="lb-nav lb-nav-next" onClick={stop}>
        <button
          type="button"
          className="lb-btn"
          data-tip="Next"
          aria-label="Next image"
          disabled={next < 0}
          onClick={() => {
            if (next >= 0) onIndex(next);
          }}
        >
          <CaretRight weight="duotone" />
        </button>
      </div>

      <div className="lb-meta" onClick={stop}>
        <span data-lightbox-count="">
          {index + 1} / {len}
        </span>
        {item.label ? <span className="lb-label">{item.label}</span> : null}
      </div>
    </div>,
    document.body,
  );
}
```
**Impact:** new file only; nothing imports it until Step 4.

### Step 2: Lightbox styles
**File:** `web/src/components/Lightbox.css` (new)
**Change:** layout in the editor's idiom (`.ed`, `.ed-btn`). z-index 66: above the editor/photo modal
(60) and the undo bar / link notice (65), below the drop overlay (70, so a drop over an open
lightbox still shows the paperclip) and tooltips (200).
**Code:**
```css
/* Shared image lightbox (R4): the note editor strip and, from Phase 9, chat thumbnails.
   z-index 66: above the editor / photo modal (60) and the undo bar (65), below the drop overlay (70)
   and tooltips (200). */
.lb { position: fixed; inset: 0; z-index: 66; background: rgba(10, 10, 9, .96); display: grid; grid-template-columns: 56px minmax(0, 1fr) 56px; grid-template-rows: auto minmax(0, 1fr) auto; align-items: center; gap: 8px 16px; padding: 16px; box-sizing: border-box; color: var(--fg); font-family: var(--sans); outline: none; }
.lb-top { grid-column: 1 / -1; grid-row: 1; display: flex; justify-content: flex-end; }
.lb-nav { grid-row: 2; display: grid; place-items: center; }
.lb-nav-prev { grid-column: 1; }
.lb-nav-next { grid-column: 3; }
.lb-stage { grid-column: 2; grid-row: 2; height: 100%; min-width: 0; min-height: 0; display: grid; place-items: center; }
.lb-img { display: block; max-width: 100%; max-height: calc(100vh - 140px); object-fit: contain; background: var(--img-bg); }
.lb-btn { width: 44px; height: 44px; border: 0; border-radius: 999px; background: transparent; color: var(--fg); font-size: 22px; cursor: pointer; display: grid; place-items: center; }
.lb-btn:hover:not(:disabled) { background: var(--hover); }
.lb-btn:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; }
.lb-btn:disabled { opacity: .25; cursor: default; }
.lb-meta { grid-column: 2; grid-row: 3; display: flex; justify-content: center; gap: 14px; min-width: 0; font-family: var(--mono); font-size: 11px; letter-spacing: .03em; color: var(--dim); }
.lb-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--id); }
```
**Impact:** none outside the component.

### Step 3: Lightbox tests
**File:** `web/src/components/Lightbox.test.tsx` (new)
**Change:** jsdom tests of the component alone. The lightbox is portaled to `document.body`, so queries
use `screen`/`document`, not the render container.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { makeImage } from '../testing/fixtures';
import { FILM_FILTER } from './NoteImage';
import { Lightbox, adjacentIndex, isLightboxOpen, noteImageItems, type LightboxItem } from './Lightbox';

afterEach(cleanup);

const items: LightboxItem[] = [
  { id: 'A-B32', src: '/x/A-B32.png', label: 'first.png', width: 600, height: 400, film: true },
  { id: 'Q-RS1', src: '/x/Q-RS1.png', label: 'second.png', width: 400, height: 600 },
  { id: 'Z-ZZ9', src: '/x/Z-ZZ9.png' },
];

/** Controlled host: owns the index like NoteEditor does. */
function Host({ start = 0, onClose = () => {} }: { start?: number; onClose?: () => void }) {
  const [i, setI] = useState(start);
  return <Lightbox items={items} index={i} onIndex={setI} onClose={onClose} />;
}

/** Opener button + lightbox, unmounted on close: the real lifecycle. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && <Lightbox items={items} index={1} onIndex={() => {}} onClose={() => setOpen(false)} />}
    </>
  );
}

const shown = () => document.querySelector('[data-lightbox] img') as HTMLImageElement | null;
const count = () => document.querySelector('[data-lightbox-count]')?.textContent;
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: k, ...init });

describe('adjacentIndex', () => {
  it('steps inside the list and returns -1 past either end (no wrap)', () => {
    expect(adjacentIndex(0, 1, 3)).toBe(1);
    expect(adjacentIndex(2, -1, 3)).toBe(1);
    expect(adjacentIndex(2, 1, 3)).toBe(-1);
    expect(adjacentIndex(0, -1, 3)).toBe(-1);
    expect(adjacentIndex(0, 1, 0)).toBe(-1);
  });
});

describe('noteImageItems', () => {
  it('keeps available images in order, with the display url, the file name and the film tone', () => {
    const a = makeImage('A-B32', { original_name: 'a.jpg' });
    const gone = makeImage('C-DD4', { available: false });
    const b = makeImage('Q-RS1');
    expect(noteImageItems([a, gone, b])).toEqual([
      { id: 'A-B32', src: '/api/images/A-B32/display', label: 'a.jpg', width: 600, height: 400, film: true },
      { id: 'Q-RS1', src: '/api/images/Q-RS1/display', label: 'Q-RS1', width: 600, height: 400, film: true },
    ]);
  });
});

describe('Lightbox', () => {
  it('shows the item at index large, with its position, label and film tone only when asked', () => {
    render(<Host />);
    expect(shown()?.getAttribute('src')).toBe('/x/A-B32.png');
    expect(shown()?.alt).toBe('first.png');
    expect(shown()?.style.filter).toBe(FILM_FILTER);
    expect(shown()?.style.aspectRatio).toBe('600 / 400');
    expect(count()).toBe('1 / 3');
    expect(screen.getByText('first.png')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(shown()?.style.filter).toBe('');
    expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeTruthy();
  });

  it('the next and previous buttons move to the adjacent image without closing', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(shown()?.getAttribute('src')).toBe('/x/Q-RS1.png');
    expect(count()).toBe('2 / 3');
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(count()).toBe('3 / 3');
    fireEvent.click(screen.getByLabelText('Previous image'));
    expect(count()).toBe('2 / 3');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables the arrows at the ends; clicking a disabled arrow neither wraps nor closes', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const prev = screen.getByLabelText('Previous image') as HTMLButtonElement;
    const next = screen.getByLabelText('Next image') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(prev);
    expect(count()).toBe('1 / 3');
    fireEvent.click(next);
    fireEvent.click(next);
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
    fireEvent.click(next);
    expect(count()).toBe('3 / 3');
    // A click that lands on the nav cell around a disabled button is not a backdrop click.
    fireEvent.click(next.parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ArrowRight / ArrowLeft move between adjacent images and stop at the ends', () => {
    render(<Host />);
    expect(key('ArrowLeft')).toBe(false);
    expect(count()).toBe('1 / 3');
    key('ArrowRight');
    expect(count()).toBe('2 / 3');
    key('ArrowRight');
    key('ArrowRight');
    expect(count()).toBe('3 / 3');
    key('ArrowLeft');
    expect(count()).toBe('2 / 3');
  });

  it('leaves Alt/Ctrl/Meta + arrow to the browser', () => {
    render(<Host />);
    expect(key('ArrowRight', { altKey: true })).toBe(true);
    expect(key('ArrowRight', { ctrlKey: true })).toBe(true);
    expect(count()).toBe('1 / 3');
  });

  it('Esc closes in the capture phase and never reaches document listeners (the chat panel)', () => {
    const onClose = vi.fn();
    const docKey = vi.fn();
    document.addEventListener('keydown', docKey);
    try {
      render(<Host onClose={onClose} />);
      expect(key('Escape')).toBe(false);
      key('ArrowRight');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(docKey).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', docKey);
    }
  });

  it('a window capture listener registered after the lightbox does not see its keys', () => {
    render(<Host />);
    const later = vi.fn();
    window.addEventListener('keydown', later, true);
    try {
      key('Escape');
      key('ArrowRight');
      key('a');
      expect(later.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(['a']);
    } finally {
      window.removeEventListener('keydown', later, true);
    }
  });

  it('a backdrop click or the X closes; a click on the image or the caption does not', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(shown() as HTMLImageElement);
    fireEvent.click(document.querySelector('.lb-meta') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.lb-stage') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Close image viewer'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a backdrop click does not bubble to a React ancestor of the host', () => {
    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <Host />
      </div>,
    );
    fireEvent.click(document.querySelector('[data-lightbox]') as HTMLElement);
    fireEvent.click(screen.getByLabelText('Close image viewer'));
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(outer).not.toHaveBeenCalled();
  });

  it('takes focus on open and gives it back to the opener on close', () => {
    render(<Opener />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(document.querySelector('[data-lightbox]'));
    key('Escape');
    expect(document.querySelector('[data-lightbox]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('isLightboxOpen follows the mounted lightbox', () => {
    expect(isLightboxOpen()).toBe(false);
    render(<Opener />);
    fireEvent.click(screen.getByText('open'));
    expect(isLightboxOpen()).toBe(true);
    key('Escape');
    expect(isLightboxOpen()).toBe(false);
  });

  it('an image that fails to load becomes the "unavailable" placeholder; the next image loads normally', () => {
    render(<Host />);
    fireEvent.error(shown() as HTMLImageElement);
    expect(shown()).toBeNull();
    expect(screen.getByRole('img', { name: 'unavailable' })).toBeTruthy();
    key('ArrowRight');
    expect(shown()?.getAttribute('src')).toBe('/x/Q-RS1.png');
  });

  it('renders nothing for an out-of-range index', () => {
    render(<Lightbox items={items} index={5} onIndex={() => {}} onClose={() => {}} />);
    expect(isLightboxOpen()).toBe(false);
  });
});
```
**Impact:** test-only.

### Step 4: Wire the lightbox into the note editor strip, with the Esc yield
**File:** `web/src/components/NoteEditor.tsx` — imports (line 1-7), new state after line 47, Esc
listener (line 68-86), strip (line 215-227).
**Change:**
- Import `Lightbox`, `isLightboxOpen`, `noteImageItems`.
- `viewing: string | null` (image **id**, not index, so an attach or remove while the lightbox is open
  keeps it on the right image); an effect clears it if that image leaves the note's available set.
- The Esc listener returns before anything else while `isLightboxOpen()`.
- Each strip thumbnail's `NoteImage` is wrapped in a `<button className="ed-open">` that opens the
  lightbox. The reveal and remove buttons stay siblings (no nested buttons), unchanged.
- The `<Lightbox>` is rendered inside `.ed-panel` (its own portal puts it on `document.body`; its click
  handlers stop propagation so the editor's backdrop never sees them).

Full file after the change (everything outside the listed regions is byte-for-byte today's file):
**Code:**
```tsx
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react';
import { Check, Copy, Trash, X } from '@phosphor-icons/react';
import type { Note, NoteImage as NoteImageData, TagCount } from '../types';
import { tagsOf, tagQueryAt, suggestTags } from '../lib/text';
import { NoteImage, aspectOf } from './NoteImage';
import { RevealButton } from './RevealButton';
import { Lightbox, isLightboxOpen, noteImageItems } from './Lightbox';
import './NoteEditor.css';

export interface NoteEditorProps {
  /** The live note from App's store: images update in place as attaches land. */
  note: Note;
  /** App's `useCopied` state for this note. */
  copied: boolean;
  /** Quiet status label, e.g. "already in K-F07" after a dedupe hit. */
  notice: string | null;
  onCopy: (id: string) => void;
  /** Blur only, and only when the draft changed since the last save. May be an empty body. */
  onSave: (note: Note, draft: string) => void;
  /** Exactly once per editor: X, backdrop or Esc. `dirty` = draft differs from the last saved text. */
  onClose: (note: Note, draft: string, dirty: boolean) => void;
  /** The strip's remove icon (soft remove; App offers a 6 s undo). */
  onRemoveImage: (image: NoteImageData) => void;
  /** Soft-delete this note with the current draft, then close without the close-time save or empty rule (R3). Absent = no trash icon. */
  onDelete?: (note: Note, draft: string) => void;
  /** Existing tags (App's store) offered while typing `#…`. Absent = no autocomplete. */
  tags?: TagCount[];
  /** Bumped by App to close this editor the normal way (draft saved, empty rule), e.g. a deep link to another note. The value at mount never closes it. */
  closeSignal?: number;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage, onDelete, tags: knownTags = [], closeSignal = 0 }: NoteEditorProps) {
  const [draft, setDraft] = useState(note.body);
  const draftRef = useRef(note.body);
  const savedRef = useRef(note.body);
  const closedRef = useRef(false);
  const noteRef = useRef(note);
  noteRef.current = note;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(note.body.length);
  const [active, setActive] = useState(0);
  // Start index of the `#…` token whose popup Esc dismissed; a new token reopens it.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  // Id of the strip image shown in the lightbox (R4), or null. An id, not an index: attaches and
  // removes while it is open must not shift it onto another image.
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(noteRef.current, draftRef.current, draftRef.current !== savedRef.current);
  }, []);

  const mountSignal = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal !== mountSignal.current) close();
  }, [closeSignal, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A lightbox over the editor owns Esc. It registers its own window capture listener after this
      // one, so its stopPropagation cannot keep this listener from running: yield while it is open.
      if (isLightboxOpen()) return;
      if (popupRef.current !== null) {
        // Esc with the tag popup open closes the popup only.
        e.preventDefault();
        e.stopPropagation();
        setDismissed(popupRef.current);
        return;
      }
      // Capture phase + preventDefault + stopPropagation (PhotoModal's seam): Esc closes only the
      // editor, never the chat panel behind it.
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const onBlur = () => {
    if (closedRef.current) return;
    if (draftRef.current === savedRef.current) return;
    savedRef.current = draftRef.current;
    onSave(noteRef.current, draftRef.current);
  };

  const tags = tagsOf(draft);

  const query = tagQueryAt(draft, caret);
  const suggestions = query && query.start !== dismissed ? suggestTags(knownTags, query.text) : [];
  const open = suggestions.length > 0;
  const activeIdx = Math.min(active, Math.max(suggestions.length - 1, 0));
  const popupRef = useRef<number | null>(null);
  popupRef.current = open && query ? query.start : null;

  const available = note.images.filter((img) => img.available);
  const lightboxItems = noteImageItems(note.images);
  const viewIndex = viewing === null ? -1 : lightboxItems.findIndex((item) => item.id === viewing);

  // The viewed image left the note (removed here or elsewhere, or no longer on this machine): close
  // the lightbox rather than let it reappear if that image comes back.
  useEffect(() => {
    if (viewing !== null && viewIndex < 0) setViewing(null);
  }, [viewing, viewIndex]);

  useEffect(() => {
    if (pendingCaret.current === null) return;
    taRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const accept = (tag: string) => {
    if (!query) return;
    const next = `${draft.slice(0, query.start)}#${tag} ${draft.slice(caret)}`;
    const pos = query.start + tag.length + 2;
    draftRef.current = next;
    setDraft(next);
    setCaret(pos);
    pendingCaret.current = pos;
    setActive(0);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = suggestions.length;
      setActive((activeIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(suggestions[activeIdx].tag);
    }
  };

  return (
    <div className="ed" data-modal="editor" onClick={close}>
      <div className="ed-panel" role="dialog" aria-label={`Edit note ${note.id}`} onClick={stop}>
        <div className="ed-top">
          <span className="ed-id">{note.id}</span>
          <button type="button" className="copybtn" data-tip="Copy ID" aria-label="Copy ID" onClick={() => onCopy(note.id)}>
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          <span className={notice ? 'ed-notice on' : 'ed-notice'} data-notice="" aria-live="polite">
            {notice ?? ''}
          </span>
          <span className="ed-spacer" />
          {onDelete && (
            <button
              type="button"
              className="ed-btn"
              data-tip="Delete note"
              aria-label="Delete note"
              // No blur-save: App saves the draft (if changed) and deletes in one ordered sequence.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // The editor is about to unmount without close(): mark it closed so a blur fired
                // on unmount cannot onSave the note back into the store after it was deleted.
                closedRef.current = true;
                onDelete(noteRef.current, draftRef.current);
              }}
            >
              <Trash weight="duotone" />
            </button>
          )}
          <button type="button" className="ed-btn" data-tip="Close" aria-label="Close" onClick={close}>
            <X weight="duotone" />
          </button>
        </div>
        <div className="ed-field">
        <textarea
          ref={taRef}
          className="ed-text"
          aria-label="Note text"
          value={draft}
          onChange={(e) => {
            draftRef.current = e.target.value;
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
            setActive(0);
          }}
          // A programmatic value swap reports the stale caret first; accept() already knows the real one.
          onSelect={(e) => pendingCaret.current === null && setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        {open && (
          <ul className="ed-suggest" role="listbox" aria-label="Tag suggestions">
            {suggestions.map((t, i) => (
              <li
                key={t.tag}
                role="option"
                aria-selected={i === activeIdx}
                className={i === activeIdx ? 'on' : undefined}
                // mousedown, not click: keep textarea focus so no blur-save fires mid-pick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(t.tag);
                }}
              >
                #{t.tag}
                <span className="ed-suggest-n">{t.count}</span>
              </li>
            ))}
          </ul>
        )}
        </div>
        {tags.length > 0 && (
          <div className="ed-tags">
            {tags.map((t) => (
              <span key={t} className="ed-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
        {available.length > 0 && (
          <div className="ed-strip" data-strip="">
            {available.map((img) => (
              <div key={img.id} className="ed-thumb" data-image={img.id} style={{ aspectRatio: aspectOf(img).css }}>
                <button
                  type="button"
                  className="ed-open"
                  data-open={img.id}
                  aria-label={`View image ${img.id}`}
                  onClick={() => setViewing(img.id)}
                >
                  <NoteImage image={img} variant="thumb" className="ed-thumb-img" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </button>
                <RevealButton image={img} className="ed-rm ed-reveal" />
                <button type="button" className="ed-rm" data-tip="Remove image" aria-label="Remove image" onClick={() => onRemoveImage(img)}>
                  <X weight="duotone" />
                </button>
              </div>
            ))}
          </div>
        )}
        {viewIndex >= 0 && (
          <Lightbox
            items={lightboxItems}
            index={viewIndex}
            onIndex={(i) => setViewing(lightboxItems[i].id)}
            onClose={() => setViewing(null)}
          />
        )}
      </div>
    </div>
  );
}
```
**Impact:**
- Clicking a thumbnail now opens the lightbox (before: a click did nothing). Clicking moves focus
  off the textarea, so the existing blur-save fires first if the draft changed (same as clicking the
  remove icon today).
- Esc order with the lightbox open: lightbox closes; focus returns to the thumbnail button; the next
  Esc closes the tag popup if open, else the editor. The editor's backdrop/`stop` handlers, the X, the
  trash, `closeSignal` and the tag-popup Esc are unchanged when no lightbox is open.
- `closeSignal` while the lightbox is open closes the editor, which unmounts the lightbox with it;
  focus restore is skipped because the thumbnail is gone (`isConnected` check).
- DOM: each `.ed-thumb` now holds `button.ed-open > img.ed-thumb-img` instead of the bare image. The
  existing test that reads `.ed-thumb` `data-image` and `style.aspectRatio` is unaffected.

### Step 5: Thumbnail open-button styles
**File:** `web/src/components/NoteEditor.css` — append after line 29 (end of file).
**Change:** make the button invisible chrome that fills the tile.
**Code:**
```css

/* R4: the thumbnail itself is a button that opens the shared lightbox. Fills the tile; the reveal and
   remove icons stay above it (absolutely positioned siblings). */
.ed-open { display: block; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.ed-open:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; }
```
**Impact:** visual only.

### Step 6: Editor tests for the strip lightbox and the Esc seam
**File:** `web/src/components/NoteEditor.test.tsx` — append after line 214 (end of file). Uses the
file's existing imports (`vi`, `fireEvent`, `cleanup` via `afterEach`, `img`, `note`, `renderEditor`)
and adds `screen` to the `@testing-library/react` import on line 3:
```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
```
**Code (appended):**
```tsx

describe('NoteEditor lightbox', () => {
  const pics = () => note('pics', [img('A-B32', 'A-B32', 0), img('Q-RS1', 'A-B32', 1), img('Z-ZZ9', 'A-B32', 2)]);
  const shown = () => document.querySelector('[data-lightbox] img')?.getAttribute('src');
  const lightbox = () => document.querySelector('[data-lightbox]');
  const esc = () => fireEvent.keyDown(document.body, { key: 'Escape' });

  it('clicking a strip thumbnail opens the lightbox on that image', () => {
    const { props } = renderEditor(pics());
    expect(lightbox()).toBeNull();
    fireEvent.click(screen.getByLabelText('View image Q-RS1'));
    expect(shown()).toBe('/api/images/Q-RS1/display');
    expect(document.querySelector('[data-lightbox-count]')?.textContent).toBe('2 / 3');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('arrows by click and key move across the note images without closing, and stop at the ends', () => {
    const { props } = renderEditor(pics());
    fireEvent.click(screen.getByLabelText('View image A-B32'));
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(shown()).toBe('/api/images/A-B32/display');
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(shown()).toBe('/api/images/Q-RS1/display');
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(shown()).toBe('/api/images/Z-ZZ9/display');
    expect((screen.getByLabelText('Next image') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(shown()).toBe('/api/images/Z-ZZ9/display');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('skips images that are not on this machine', () => {
    const away = { ...img('C-DD4', 'A-B32', 1), available: false };
    renderEditor(note('pics', [img('A-B32', 'A-B32', 0), away, img('Q-RS1', 'A-B32', 2)]));
    fireEvent.click(screen.getByLabelText('View image A-B32'));
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(shown()).toBe('/api/images/Q-RS1/display');
    expect(document.querySelector('[data-lightbox-count]')?.textContent).toBe('2 / 2');
  });

  it('Esc closes only the lightbox, never the editor or the chat panel; the next Esc closes the editor', () => {
    const chatEsc = vi.fn();
    document.addEventListener('keydown', chatEsc);
    try {
      const { props } = renderEditor(pics());
      fireEvent.click(screen.getByLabelText('View image Q-RS1'));
      expect(esc()).toBe(false);
      expect(lightbox()).toBeNull();
      expect(props.onClose).not.toHaveBeenCalled();
      expect(document.querySelector('[data-modal="editor"]')).not.toBeNull();
      expect(chatEsc).not.toHaveBeenCalled();
      esc();
      expect(props.onClose).toHaveBeenCalledTimes(1);
      expect(chatEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', chatEsc);
    }
  });

  it('a click on the lightbox backdrop or its X closes the lightbox, not the editor', () => {
    const { props } = renderEditor(pics());
    fireEvent.click(screen.getByLabelText('View image A-B32'));
    fireEvent.click(lightbox() as HTMLElement);
    expect(lightbox()).toBeNull();
    fireEvent.click(screen.getByLabelText('View image A-B32'));
    fireEvent.click(screen.getByLabelText('Close image viewer'));
    expect(lightbox()).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    // The editor's own backdrop still closes it.
    fireEvent.click(document.querySelector('[data-modal="editor"]') as HTMLElement);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('focus moves into the lightbox and back to the thumbnail that opened it', () => {
    renderEditor(pics());
    const thumb = screen.getByLabelText('View image Q-RS1');
    thumb.focus();
    fireEvent.click(thumb);
    expect(document.activeElement).toBe(lightbox());
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    esc();
    expect(document.activeElement).toBe(thumb);
  });

  it('with the tag popup open, Esc closes the lightbox first, then the popup, then the editor', () => {
    const known = [{ tag: 'seer', count: 5, last_used: null }];
    const { ta, props, queryByRole } = renderEditor(pics(), { tags: known });
    ta.setSelectionRange(3, 3);
    fireEvent.change(ta, { target: { value: '#se', selectionStart: 3 } });
    expect(queryByRole('listbox')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('View image A-B32'));
    esc();
    expect(lightbox()).toBeNull();
    expect(queryByRole('listbox')).not.toBeNull();
    esc();
    expect(queryByRole('listbox')).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    esc();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps showing the same image when another one is attached while it is open', () => {
    const { props, rerender } = renderEditor(pics());
    fireEvent.click(screen.getByLabelText('View image Q-RS1'));
    const grown = note('pics', [img('N-EW1', 'A-B32', 0), ...pics().images]);
    rerender(<NoteEditor {...props} note={grown} />);
    expect(shown()).toBe('/api/images/Q-RS1/display');
    expect(document.querySelector('[data-lightbox-count]')?.textContent).toBe('3 / 4');
  });

  it('closes when the viewed image leaves the note, and Esc then closes the editor', () => {
    const { props, rerender } = renderEditor(pics());
    fireEvent.click(screen.getByLabelText('View image Q-RS1'));
    const shrunk = note('pics', pics().images.filter((i) => i.id !== 'Q-RS1'));
    rerender(<NoteEditor {...props} note={shrunk} />);
    expect(lightbox()).toBeNull();
    esc();
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // The image coming back (undo) does not reopen the lightbox.
    rerender(<NoteEditor {...props} note={pics()} />);
    expect(lightbox()).toBeNull();
  });

  it('closeSignal while the lightbox is open closes the editor and the lightbox with it', () => {
    const { props, rerender, unmount } = renderEditor(pics(), { closeSignal: 1 });
    fireEvent.click(screen.getByLabelText('View image A-B32'));
    rerender(<NoteEditor {...props} closeSignal={2} />);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(lightbox()).toBeNull();
  });

  it('the strip remove icon still removes without opening the lightbox', () => {
    const { props, getAllByLabelText } = renderEditor(pics());
    fireEvent.click(getAllByLabelText('Remove image')[0]!);
    expect(props.onRemoveImage).toHaveBeenCalledTimes(1);
    expect(lightbox()).toBeNull();
  });
});
```
Note: the `closeSignal` test unmounts explicitly because the host (App) unmounts the editor on
close; the editor component itself only calls `onClose`.

**Impact:** test-only.

### Step 7: Docs (Invariant 9)
**File:** `README.md` — "The big editor" (line 149-150 bullet and line 156 Esc bullet).
**Change:** replace lines 149-150:
```markdown
- the note's photos as a strip, each with a remove icon and the folder icon (see
  [Open file location](#open-file-location)). Click a photo to see it large; the left and right
  arrows (buttons or keys) move to the note's other photos without closing it and stop at the first
  and last one. Esc, a click beside the photo or the X closes the photo and leaves the editor open.
```
and replace line 156 (`- Esc closes it.`) with:
```markdown
- Esc closes it (when a photo is open large, the first Esc closes only the photo).
```

**File:** `CHANGELOG.md` — insert above `## [v0.1.0] - 2026-10-30` (line 8):
```markdown
## [Unreleased]

### Added

- **Image lightbox**: click a photo in the big editor's strip to see it large; arrows (click or
  keys) move between the note's photos without closing, Esc closes only the photo (R4).

```
If another phase's branch already added `## [Unreleased]` / `### Added`, add only the bullet under it
(the integrator merges these hunks).

**Impact:** docs only.

## Verification

Worktree setup first (Invariant 10): `npm ci` if `node_modules` is missing; `ln -s ~/mcp-notes/.env.local .env.local` if missing.

**Build:** `npm run typecheck && npm run build`
**Tests:**
- focused: `npx vitest run web/src/components/Lightbox.test.tsx web/src/components/NoteEditor.test.tsx`
- full: `npm test` and `npm run test:int` (no server change; must stay green per Invariant 1)
**Manual check:** `npm run build`, restart the daemon from the worktree (or `npm run dev` if used),
open http://localhost:7317, expand a note with 3 photos:
1. click the middle thumbnail → large view, `2 / 3`, file name caption;
2. ArrowLeft/ArrowRight and the side buttons move; at `1 / 3` the left button is dim and ArrowLeft does nothing;
3. Esc → lightbox closes, editor still open, focus ring on the thumbnail; Esc again → editor closes;
4. open the chat panel first, then repeat 3: the chat panel stays open through the first Esc;
5. with the lightbox open, paste an image: it attaches to the note (strip grows), lightbox still on the same photo;
6. the Gallery's photo modal is unchanged (wraps around as before).
**Exit criteria:** clicking a strip thumbnail opens the lightbox on it; buttons and ArrowLeft/ArrowRight
move between the note's available images without closing and stop at the ends; Esc, backdrop and X
close the lightbox but not the editor or the chat panel; focus returns to the thumbnail;
`Lightbox` takes a generic `LightboxItem[]` with per-item `src`; typecheck, `npm test`,
`npm run test:int` and `npm run build` pass.

## Handoffs

- **Phase 9 (R3, chat history thumbnails):** consume `Lightbox` with
  items built from Phase 7's message attachments (`{kind, id, url, thumb_url}`, no dimensions or
  name on the wire): `{ id: a.id, src: a.url, label: a.id }` (no `film`; `width`/`height` omitted).
  Track the viewed image by id like `NoteEditor` does. Any window *capture* keydown
  listener Phase 9 adds that handles Esc or arrows and can be registered before a lightbox opens must
  start with `if (isLightboxOpen()) return;`. A document-level bubble listener only needs the existing
  `if (e.defaultPrevented) return;` (the `App.tsx:365-371` pattern). Phase 3 adds
  `chatImageUrl(id, variant)` to `web/src/api.ts`; nothing is added here.
- **Phase 5 (R2) and Phase 11 (R3) edit `NoteEditor.tsx` after this phase.** Keep: the
  `if (isLightboxOpen()) return;` line at the top of the Esc branch of the window capture listener;
  the `.ed-open` button wrapping each strip thumbnail; the `<Lightbox>` render inside `.ed-panel`.
  Phase 5's file chips are not images and must not be added to `noteImageItems`. Phase 5's
  ctrl-v/drop routing inside the editor does not need to know about the lightbox (the note id target
  is unchanged while it is open).
- **Phase 11 (R3):** if the note modal can be opened from the history page while a chat lightbox is
  open, the order is lightbox first, editor second; the lightbox's `stopImmediatePropagation` already
  keeps the later-registered editor listener from seeing Esc. No change needed, but test it there.
- **Not done (out of scope, possible follow-up):** a full Tab focus trap inside the lightbox (today Tab
  can reach the editor controls behind it; Esc/arrow handling is window-level so it is unaffected);
  preloading the adjacent images; making `PhotoModal` use `Lightbox` (explicitly left alone).
- **CHANGELOG:** `CHANGELOG.md` has no `## [Unreleased]` section on `main`; Phases 1 and 3 (same wave)
  will likely add one too. The reconciler/integrator should keep one `## [Unreleased]` / `### Added`
  heading with each phase's bullet.

## Rollback

Revert this phase's commits. Equivalent by hand: delete `web/src/components/Lightbox.tsx`,
`Lightbox.css`, `Lightbox.test.tsx`; restore `NoteEditor.tsx`, `NoteEditor.css`,
`NoteEditor.test.tsx`, `README.md`, `CHANGELOG.md` from `main` (`git checkout main -- <paths>`).
No data, schema or server change; nothing to migrate back. Note: Phases 5, 9 and 11 build on this
phase, so roll back only before they land (or revert theirs first).
