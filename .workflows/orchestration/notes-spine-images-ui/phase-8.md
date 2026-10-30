# Phase 8: Web UI images: gallery, photo modal, full-screen tab, drag/paste upload, missing-file placeholder

**Plan set:** `NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R3. The image half of the web UI: the gallery grid, photo modal, full-screen tab, drag/paste upload and the "not on this machine" placeholder.
**Depends on:** Phase 5 (image routes), Phase 7 (web app shell + the four stubs). Phase 6 (`/full/:id` static route, `GET /api/notes/:id`) is reached through phase 7.
**Difficulty:** NORMAL
**Package:** `web/`

---

## Goal

Visibility is a 3-way mode owned by phase 7 (`'text' | 'images' | 'all'`, default `'text'`, design commit `30a58fd`). In `'images'` mode the wall is replaced by the design's flex-wrap contact sheet. In `'all'` mode image notes sit on the wall through `NoteImage`. Clicking a photo opens the
modal (display derivative, film tone, text without hashtags, tag chips, copy id, full screen,
prev/next with wraparound, Esc and arrow keys). "Show full screen" opens `/full/<id>` in a new tab:
the unfiltered original (or HEIC display derivative) on black, fit by default, click toggles device
1:1 pixels, drag pans. Dropping or pasting an image anywhere uploads it to `POST /api/images`. A new image note
added in `'text'` mode switches the mode to `'all'` so it is visible. A dedupe hit is handed to
phase 7's `onImageAdded(note)` like any upload (it switches `'text'` → `'all'`), then the existing
note's card or gallery tile is scrolled into view and flashed. A note whose file lives on another machine
shows a "not on this machine" placeholder at the image's aspect ratio on the wall, in the gallery,
in the modal and in the full-screen tab.

## Interface Contract

**Deletes:** none. (The four phase-7 stub bodies are replaced. Their exported names stay.)
**Renames:** none
**Creates:**
- `web/src/components/NoteImage.tsx`: `NoteImage`, `NoteImageProps` (phase 7's `{ note, className?, style? }` widened with optional `variant` and `onClick`), `ImagePlaceholder`, `FILM_FILTER`, `imageUrl(id, variant)`, `aspectOf(image)`, types `ImageInfo`, `ImageNote`, `ImageVariant`
- `web/src/components/Gallery.tsx`: `Gallery` (phase 7's `GalleryProps { photos, copiedId, onCopy }`), `galleryTile(image)`, `GALLERY_ROW_HEIGHT` (= 230)
- `web/src/components/PhotoModal.tsx`: `PhotoModal` (phase 7's `PhotoModalProps { photos, index, onIndex, onClose, copiedId, onCopy }`), `stepIndex(i, d, len)`, `stripTags(body)`
- `web/src/components/PhotoModal.css`: hover rule for modal icon buttons (`.pm-btn:hover`)
- `web/src/components/DropOverlay.tsx`: `DropOverlay` (phase 7's `DropOverlayProps { onImageAdded(note) }`), `uploadImage(file, fetchImpl?)`, `imageFiles(files)`, `firstImageFile(files)`, `hasFiles(dt)`, `flashNote(id, delayMs?)`, type `UploadResult`
- `web/fullscreen.html` (second Vite HTML entry)
- `web/src/fullscreen/main.tsx`, `web/src/fullscreen/FullscreenApp.tsx` (`FullscreenApp`, `idFromLocation`, `describeMissing`), `web/src/fullscreen/view.ts` (`viewReducer`, `initialView`, `imgStyleFor`, `cursorFor`, `DRAG_THRESHOLD`)
- Tests: `web/src/components/{Gallery,PhotoModal,DropOverlay,NoteImage}.test.tsx`, `web/src/fullscreen/FullscreenApp.test.tsx`

**Signature changes:** none to phase 7's call sites. This phase conforms to the props phase 7's
stubs declare (reconciled), so `web/src/App.tsx` and `NoteCard.tsx` are **not edited**:
- `<NoteImage note={n} />` (NoteCard, wall image cards in `'all'` mode). `variant` defaults to `'thumb'`; the modal passes `variant="display"`. `className`/`style` are honoured.
- `<Gallery photos={...} copiedId={copiedId} onCopy={copy} />`, rendered by App only when `mode === 'images'`, with `photos` already tag-filtered by phase 7's `photosOf` (`web/src/lib/filter.ts`). **Gallery owns the modal** (phase 7's contract): it keeps the open photo id in local state and renders `<PhotoModal>` in a portal. App holds no modal state.
- `<PhotoModal photos index onIndex onClose copiedId onCopy />`: rendered only by `Gallery`. The meta date uses phase 7's `relativeDate` (`web/src/lib/dates.ts`), imported directly.
- `<DropOverlay onImageAdded={...} />`: rendered once at the App root, in every mode. Every upload result's note goes to `onImageAdded(note)`; App inserts it, switches `'text'` → `'all'` and refetches (phase 7). A dedupe hit (`created: false`) additionally scrolls to and flashes `[data-note="<id>"]` (wall card, or gallery tile, which carries `data-note` too). It owns the document-level `dragover`/`dragleave`/`drop`/`paste` listeners, the overlay and the upload queue.

**Requires (from earlier phases):**
- Phase 5: `POST /api/images` (multipart `file`) → `200 {note, created}`; `GET /api/notes/:id/{thumb,display}`; a missing original → `404 {error:'not_on_this_machine', host}` on `/display` (and `/thumb`).
- Phase 6: `/full/:id` serves `web/dist/fullscreen.html`; `/assets/*` from `web/dist`; `GET /api/notes/:id` returns a bare `Note`; SSE `note` events trigger the wall's refetch (phase 7), which is how a new upload appears.
- Phase 7:
  - stub files `web/src/components/{Gallery,PhotoModal,DropOverlay,NoteImage}.tsx` exporting those four names as **named exports**;
  - App renders the three call sites above with phase 7's props (`web/src/App.tsx`, Step 25 of phase 7);
  - the mode state (`'text' | 'images' | 'all'`, default `'text'`), the rail cycle button, the sidebar's three mode icons, the headings and count lines, and the wall's visibility filter, per `Notes Wall.dc.html` after `30a58fd`; App's `onImageAdded(note)` applies the text→all rule;
  - `relativeDate(iso, now, lower?)` in `web/src/lib/dates.ts`, `photosOf` in `web/src/lib/filter.ts`, `useCopied`/`copyText` in `web/src/hooks/useCopied.ts`, `type Note` in `web/src/types.ts`;
  - App's document `keydown` handler (bubble phase) ignores `defaultPrevented` events; the modal registers its handler with `{ capture: true }` and calls `preventDefault()` + `stopPropagation()` on the keys it handles;
  - wall cards carry `data-note={id}`;
  - the document-level `[data-tip]` tooltip (`Notes Wall.dc.html:207-212`), so `data-tip` attributes are all this phase adds;
  - `web/vite.config.ts` with Vite `root` = `web/`, `base` = `'/'` (a relative base breaks asset URLs under `/full/<id>`), output `web/dist`, and an object `build.rolldownOptions.input` (Vite 8) with an `index` key;
  - fonts: `@fontsource/geist-mono` and `@fontsource-variable/host-grotesk` are imported by the main entry. The full-screen entry imports Geist Mono itself.
- Phase 1: `react`, `react-dom`, `@phosphor-icons/react` (2.1.10, plain icon names `CaretLeft`, `CaretRight`, `Copy`, `Check`, `ArrowsOut`, `X`, `ImageSquare`, `ImageBroken`), `@fontsource/geist-mono`, `jsdom`, `vitest` installed; vitest picks up `web/src/**/*.test.tsx` with the per-file `// @vitest-environment jsdom` pragma and compiles TSX. Phase 1 also installs `@testing-library/*`; these tests do not need it and use `react-dom/client` + `act` from `react`.

**Leaves alone (owned by others):** `src/**` (server, phases 2-6), `package.json` / `package-lock.json` (phase 1; scripts phase 7), every `web/**` file of phase 7 except the four stubs and the `input` map in `web/vite.config.ts`. The mode state and its controls, every heading ("Notes.", "Everything.", "Photos.") and count line (including "N photo notes hidden."), the `photoCount`, and the mode switches on "+" (images→text), chat `ask` (images→all) and `jump` stay with phase 7.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/components/NoteImage.tsx` | rewrite (phase 7 stub) | image with film filter, thumb/display variants, missing-file placeholder |
| `web/src/components/Gallery.tsx` | rewrite (phase 7 stub) | flex-wrap gallery, tile math, owns modal state |
| `web/src/components/PhotoModal.tsx` | rewrite (phase 7 stub) | modal grid, keys, copy, full screen, wraparound |
| `web/src/components/PhotoModal.css` | create | `.pm-btn:hover` (the design's `style-hover`) |
| `web/src/components/DropOverlay.tsx` | rewrite (phase 7 stub) | drag overlay, drop + paste listeners, sequential upload, dedupe jump + flash |
| `web/fullscreen.html` | create | second HTML entry |
| `web/src/fullscreen/main.tsx` | create | entry: mounts `FullscreenApp` |
| `web/src/fullscreen/FullscreenApp.tsx` | create | fit / 1:1 / pan viewer, title = id, 404 placeholder |
| `web/src/fullscreen/view.ts` | create | pure view reducer + styles |
| `web/vite.config.ts` | modify (phase 7 file) | add `fullscreen` to `build.rolldownOptions.input` |
| `web/src/components/NoteImage.test.tsx` | create | placeholder when `available=false`, URLs, filter |
| `web/src/components/Gallery.test.tsx` | create | basis/grow math, spacer, click opens modal |
| `web/src/components/PhotoModal.test.tsx` | create | wraparound, Esc/arrows, propagation, backdrop |
| `web/src/components/DropOverlay.test.tsx` | create | paste picks first image, dedupe jump, overlay only for Files, sequential |
| `web/src/fullscreen/FullscreenApp.test.tsx` | create | fit/1:1 toggle vs drag, title, 404 placeholder |

## Implementation Steps

### Step 1: `NoteImage`, the placeholder and shared image helpers
**File:** `web/src/components/NoteImage.tsx` (whole file. Replaces phase 7's stub.)
**Change:** One image element used by the wall card, the gallery tile and the modal. It applies the film tone (design `Notes Wall.dc.html:282`). It renders the placeholder when the file is not on this machine (`image.available === false`), or when the image request fails for any other reason (captioned `unavailable` in that case, so it never claims "not on this machine" wrongly). The types are structural and minimal, so phase 7's full `Note` type is assignable without an import in either direction.
**Code:**
```tsx
import { useState, type CSSProperties, type MouseEvent } from 'react';
import { ImageBroken } from '@phosphor-icons/react';

/** Film tone from the design (Notes Wall.dc.html:282). Wall, gallery and modal only. */
export const FILM_FILTER = 'sepia(.14) saturate(1.12) contrast(1.05) brightness(.97)';

/** The subset of the wire `Note.image` this file reads. */
export type ImageInfo = {
  width: number;
  height: number;
  available: boolean;
  host?: string | null;
};

/** The subset of the wire `Note` this file reads. Phase 7's `Note` is assignable to it. */
export type ImageNote = {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  image: ImageInfo | null;
};

export type ImageVariant = 'thumb' | 'display';

export function imageUrl(id: string, variant: ImageVariant | 'original'): string {
  return `/api/notes/${encodeURIComponent(id)}/${variant}`;
}

/** Aspect ratio of an image, falling back to 3:2 when dimensions are missing or zero. */
export function aspectOf(image: Pick<ImageInfo, 'width' | 'height'> | null | undefined): {
  w: number;
  h: number;
  ratio: number;
  css: string;
} {
  const w = image && image.width > 0 ? image.width : 3;
  const h = image && image.height > 0 ? image.height : 2;
  return { w, h, ratio: w / h, css: `${w} / ${h}` };
}

type PlaceholderProps = {
  aspect: string;
  caption: string;
  host?: string | null;
  width?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
};

/**
 * A box at the image's aspect ratio: a duotone icon and a tiny Geist Mono status caption.
 * The caption is a status label, not a control.
 */
export function ImagePlaceholder({ aspect, caption, host, width, onClick }: PlaceholderProps) {
  return (
    <div
      role="img"
      aria-label={host ? `${caption}, ${host}` : caption}
      data-placeholder="image"
      onClick={onClick}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: width ?? '100%',
        aspectRatio: aspect,
        background: '#1c1c1a',
        color: '#8a897f',
        boxSizing: 'border-box',
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' }}>
        <ImageBroken weight="duotone" size={28} color="#bdbcb4" />
        <span style={{ fontFamily: "'Geist Mono',monospace", fontSize: 10.5, letterSpacing: '.03em', lineHeight: 1.3 }}>
          {caption}
        </span>
        {host ? (
          <span style={{ fontFamily: "'Geist Mono',monospace", fontSize: 10.5, letterSpacing: '.03em', lineHeight: 1.3, opacity: 0.7 }}>
            {host}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Phase 7's stub props, widened: `variant` defaults to 'thumb' (the wall/gallery), the modal passes 'display'. */
export type NoteImageProps = {
  note: ImageNote;
  variant?: ImageVariant;
  className?: string;
  style?: CSSProperties;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
};

/**
 * The image of an image note, with the film tone.
 * - `thumb`: wall card and gallery tile (Notes Wall.dc.html:72, 97): full width, height from the aspect ratio.
 * - `display`: the modal (Notes Wall.dc.html:135): the display derivative, never a downscaled guess.
 */
export function NoteImage({ note, variant = 'thumb', className = variant === 'thumb' ? 'card-img' : undefined, style, onClick }: NoteImageProps) {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const image = note.image;
  if (!image) return null;

  const key = `${note.id}/${variant}`;
  const { ratio, css } = aspectOf(image);
  const placeholderWidth = variant === 'display' ? `min(100%, calc((100vh - 48px) * ${ratio.toFixed(4)}))` : undefined;

  if (!image.available) {
    return (
      <ImagePlaceholder aspect={css} caption="not on this machine" host={image.host ?? null} width={placeholderWidth} onClick={onClick} />
    );
  }
  if (failedKey === key) {
    return <ImagePlaceholder aspect={css} caption="unavailable" width={placeholderWidth} onClick={onClick} />;
  }

  const base: CSSProperties =
    variant === 'thumb'
      ? { display: 'block', width: '100%', height: 'auto', aspectRatio: css, filter: FILM_FILTER, background: '#1c1c1a' }
      : { display: 'block', maxWidth: '100%', maxHeight: 'calc(100vh - 48px)', aspectRatio: css, filter: FILM_FILTER };

  return (
    <img
      className={className}
      src={imageUrl(note.id, variant)}
      alt=""
      draggable={false}
      loading={variant === 'thumb' ? 'lazy' : undefined}
      decoding="async"
      onClick={onClick}
      onError={() => setFailedKey(key)}
      style={{ ...base, ...style }}
    />
  );
}
```
**Impact:** The wall card (phase 7) renders this for image notes. Nothing else changes.

### Step 2: `PhotoModal` and its hover CSS
**File:** `web/src/components/PhotoModal.css` (new)
**Code:**
```css
/* The design's style-hover="background:#222220" on modal icon buttons (Notes Wall.dc.html:133-153). */
.pm-btn:hover {
  background: #222220 !important;
}
```

**File:** `web/src/components/PhotoModal.tsx` (whole file. Replaces phase 7's stub.)
**Change:** The design's modal (`Notes Wall.dc.html:131-155`, data `:315-321`). Grid `56px minmax(0,1fr) 300px 56px` on `rgba(10,10,9,.94)`, z 60. A backdrop click closes it. The image and the side panel stop propagation, and so do prev/next. Keys are handled by a **capture-phase `window` listener that stops propagation**, so with the modal open Esc closes only the modal and never reaches App's Esc-closes-chat handler (design `:213-220` checks the modal first). Text = body with hashtags stripped. Tag chips come from the server-parsed `note.tags`. Meta = `i / n  date`. "Show full screen" opens `/full/<id>`.
**Code:**
```tsx
import { useEffect, type CSSProperties, type MouseEvent } from 'react';
import { ArrowsOut, CaretLeft, CaretRight, Check, Copy, X } from '@phosphor-icons/react';
import { relativeDate } from '../lib/dates';
import { NoteImage, type ImageNote } from './NoteImage';
import './PhotoModal.css';

/** (i + d) modulo len, wrapping both ways. -1 when there is nothing to show. */
export function stepIndex(i: number, d: number, len: number): number {
  if (len <= 0) return -1;
  return (((i + d) % len) + len) % len;
}

/** Body text with #hashtags removed and whitespace collapsed (Notes Wall.dc.html:317). */
export function stripTags(body: string): string {
  return body
    .replace(/(?<![\w])#[A-Za-z0-9_-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const stop = (e: MouseEvent) => e.stopPropagation();

const navBtn: CSSProperties = {
  width: 44,
  height: 44,
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  color: '#ecebe4',
  fontSize: 22,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
};

const toolBtn: CSSProperties = { ...navBtn, width: 40, height: 40, fontSize: 19 };

/** Phase 7's stub props; `photos` widened to the structural `ImageNote` (phase 7's `Note` is assignable). Copy state is App's (`useCopied`). */
export interface PhotoModalProps {
  photos: ImageNote[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  copiedId: string | null;
  onCopy: (id: string) => void;
}

export function PhotoModal({ photos, index, onIndex, onClose, copiedId, onCopy }: PhotoModalProps) {
  const len = photos.length;
  const photo = index >= 0 && index < len ? photos[index] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + preventDefault (phase 7's keyboard seam) + stopPropagation: Esc closes
      // only the modal, never the chat panel behind it.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        onIndex(stepIndex(index, 1, len));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        onIndex(stepIndex(index, -1, len));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, len, onIndex, onClose]);

  if (!photo) return null;

  const copy = () => onCopy(photo.id);
  const full = () => {
    window.open(`/full/${encodeURIComponent(photo.id)}`, '_blank', 'noopener');
  };
  const copied = copiedId === photo.id;
  const meta = `${index + 1} / ${len}  ${relativeDate(photo.created_at, new Date())}`;

  return (
    <div
      data-modal="photo"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,9,.94)',
        zIndex: 60,
        display: 'grid',
        gridTemplateColumns: '56px minmax(0,1fr) 300px 56px',
        alignItems: 'center',
        gap: 16,
        padding: '24px 16px',
        boxSizing: 'border-box',
      }}
    >
      <button
        type="button"
        className="pm-btn"
        data-tip="Previous"
        aria-label="Previous"
        onClick={(e) => {
          e.stopPropagation();
          onIndex(stepIndex(index, -1, len));
        }}
        style={navBtn}
      >
        <CaretLeft weight="duotone" />
      </button>

      <div style={{ height: '100%', display: 'grid', placeItems: 'center', minWidth: 0 }}>
        <NoteImage key={photo.id} note={photo} variant="display" onClick={stop} />
      </div>

      <div onClick={stop} style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 4 }}>
        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
          <button type="button" className="pm-btn" data-tip="Copy ID" aria-label="Copy ID" onClick={copy} style={toolBtn}>
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <button type="button" className="pm-btn" data-tip="Show full screen" aria-label="Show full screen" onClick={full} style={toolBtn}>
            <ArrowsOut weight="duotone" />
          </button>
          <button type="button" className="pm-btn" data-tip="Close" aria-label="Close" onClick={onClose} style={toolBtn}>
            <X weight="duotone" />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, color: '#e4e3dc', textWrap: 'pretty' } as CSSProperties}>
          {stripTags(photo.body)}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {photo.tags.map((t) => (
            <span key={t} style={{ fontSize: 11, padding: '3px 8px 4px', borderRadius: 999, background: '#2a2a27', color: '#d6d5cd' }}>
              #{t}
            </span>
          ))}
        </div>
        <div style={{ height: 1, background: 'rgba(236,235,228,.1)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'Geist Mono',monospace", fontSize: 11, color: '#bdbcb4' }}>
          <span>{photo.id}</span>
          <span style={{ opacity: copied ? 1 : 0, color: '#8a897f', transition: 'opacity .25s' }}>copied</span>
          <span data-meta="" style={{ marginLeft: 'auto', color: '#8a897f' }}>
            {meta}
          </span>
        </div>
      </div>

      <button
        type="button"
        className="pm-btn"
        data-tip="Next"
        aria-label="Next"
        onClick={(e) => {
          e.stopPropagation();
          onIndex(stepIndex(index, 1, len));
        }}
        style={navBtn}
      >
        <CaretRight weight="duotone" />
      </button>
    </div>
  );
}
```
**Impact:** None outside `Gallery`. `aria-label` adds no visible text, so the controls stay icon-only.

### Step 3: `Gallery`
**File:** `web/src/components/Gallery.tsx` (whole file. Replaces phase 7's stub.)
**Change:** The design's gallery (`Notes Wall.dc.html:93-102`, data `:277`, `:313`). Each tile is `flex: <w/h toFixed(3)> 1 <round(w/h*230)>px`, the gap is 4px, and a trailing `flex: 999 1 0px` spacer keeps the last row from stretching. The open modal is tracked **by note id**, not index. When an SSE refetch reorders or drops photos while the modal is open, it stays on the same photo, or closes when that photo is gone. The modal goes through a portal to `document.body`, so no ancestor stacking context can clip it.
**Code:**
```tsx
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { NoteImage, aspectOf, type ImageInfo, type ImageNote } from './NoteImage';
import { PhotoModal } from './PhotoModal';

export const GALLERY_ROW_HEIGHT = 230;

/** Flex values for one gallery tile (Notes Wall.dc.html:313). */
export function galleryTile(image: Pick<ImageInfo, 'width' | 'height'> | null): {
  grow: string;
  basis: number;
  ar: string;
} {
  const { ratio, css } = aspectOf(image);
  return { grow: ratio.toFixed(3), basis: Math.round(ratio * GALLERY_ROW_HEIGHT), ar: css };
}

/** Phase 7's stub props; `photos` widened to `ImageNote` (phase 7's `Note` is assignable). They arrive tag-filtered (phase 7's `photosOf`). */
export interface GalleryProps {
  photos: ImageNote[];
  copiedId: string | null;
  onCopy: (id: string) => void;
}

export function Gallery({ photos, copiedId, onCopy }: GalleryProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const index = openId === null ? -1 : photos.findIndex((p) => p.id === openId);

  const onIndex = useCallback(
    (i: number) => {
      const p = photos[i];
      setOpenId(p ? p.id : null);
    },
    [photos],
  );
  const onClose = useCallback(() => setOpenId(null), []);

  return (
    <>
      <section data-gallery="" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 30 }}>
        {photos.map((p) => {
          const t = galleryTile(p.image);
          return (
            <div
              key={p.id}
              data-photo={p.id}
              data-note={p.id}
              onClick={() => setOpenId(p.id)}
              style={{ flex: `${t.grow} 1 ${t.basis}px`, cursor: 'zoom-in', background: '#1c1c1a' }}
            >
              <NoteImage note={p} variant="thumb" />
            </div>
          );
        })}
        <div data-gallery-spacer="" style={{ flex: '999 1 0px' }} />
      </section>
      {index >= 0
        ? createPortal(
            <PhotoModal photos={photos} index={index} onIndex={onIndex} onClose={onClose} copiedId={copiedId} onCopy={onCopy} />,
            document.body,
          )
        : null}
    </>
  );
}
```
**Impact:** Leaving `'images'` mode (rail cycle, sidebar pick, `ask` switching images→all, `jump`) unmounts the gallery, which closes the modal. That matches the design's `cycleMode`/`modeOpts.pick`/`ask` resetting `modal: -1`.

### Step 4: `DropOverlay`: drag overlay, drop + paste upload, dedupe jump
**File:** `web/src/components/DropOverlay.tsx` (whole file. Replaces phase 7's stub.)
**Change:** Document-level listeners (the design puts them on the root div, `Notes Wall.dc.html:24`. Document level is equivalent and keeps App untouched):
- `dragover`: only when `dataTransfer.types` includes `Files` → `preventDefault` + show the overlay (`:350`).
- `dragleave` with no `relatedTarget` (the pointer left the window) → hide (`:351`).
- `drop` with Files → `preventDefault`, hide, upload every `image/*` file (`:352`).
- `paste` → the first `image/*` file in `clipboardData.files`. If one exists, `preventDefault` and upload it (`:221-224`).

Uploads go through one promise chain, so files upload **one at a time** in order, even across separate drops. Every result's note goes to phase 7's `onImageAdded(note)`, which inserts it locally, switches `'text'` → `'all'` (other modes kept) and refetches (design `addImage`, `Notes Wall.dc.html:266-270`). `created: false` (dedupe hit) → also `flashNote(id)`: once React has re-rendered, it scrolls `[data-note="<id>"]` (wall card in `'all'`, gallery tile in `'images'`) into view and runs a Web Animations outline pulse. Failures go to `console.error`, because the design has no error surface. See Handoffs.
**Code:**
```tsx
import { useEffect, useRef, useState } from 'react';
import { ImageSquare } from '@phosphor-icons/react';
import type { Note } from '../types';

/** Phase 5: `POST /api/images` → 201 `{ note, created: true }` or 200 `{ note, created: false }`. */
export type UploadResult = { note: Note; created: boolean };

type FileSource = FileList | ArrayLike<File> | null | undefined;

/** The image files of a FileList, in order. */
export function imageFiles(files: FileSource): File[] {
  return Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
}

/** The first image file, or null (the paste rule, Notes Wall.dc.html:222). */
export function firstImageFile(files: FileSource): File | null {
  return imageFiles(files)[0] ?? null;
}

/** True only for drags that carry files (not text or links). */
export function hasFiles(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

/** POST /api/images (multipart `file`) → {note, created}. Throws on a non-2xx response. */
export async function uploadImage(file: File, fetchImpl: typeof fetch = fetch): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file, file.name || 'pasted-image');
  const res = await fetchImpl('/api/images', { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload failed: ${res.status} ${detail}`.trim());
  }
  return (await res.json()) as UploadResult;
}

/** Scroll the card (or gallery tile) of `id` into view and pulse an outline on it. */
export function flashNote(id: string, delayMs = 450): void {
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`[data-note="${id}"]`);
    if (!el) return;
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
  }, delayMs);
}

/** Phase 7's stub props, unchanged. */
export interface DropOverlayProps {
  /** Call once per note returned by POST /api/images. App inserts it and switches text -> all. */
  onImageAdded: (note: Note) => void;
}

export function DropOverlay({ onImageAdded }: DropOverlayProps) {
  const [dragging, setDragging] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const addedRef = useRef(onImageAdded);

  useEffect(() => {
    addedRef.current = onImageAdded;
  }, [onImageAdded]);

  useEffect(() => {
    const enqueue = (files: File[]) => {
      for (const file of files) {
        queue.current = queue.current.then(async () => {
          try {
            const result = await uploadImage(file);
            addedRef.current(result.note);
            if (!result.created) flashNote(result.note.id);
          } catch (err) {
            console.error('[upload]', file.name, err);
          }
        });
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(false);
      enqueue(imageFiles(e.dataTransfer?.files));
    };
    const onPaste = (e: ClipboardEvent) => {
      const file = firstImageFile(e.clipboardData?.files);
      if (!file) return;
      e.preventDefault();
      enqueue([file]);
    };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  if (!dragging) return null;
  return (
    <div
      data-drop-overlay=""
      style={{
        position: 'fixed',
        inset: 10,
        border: '1px dashed rgba(236,235,228,.5)',
        zIndex: 70,
        pointerEvents: 'none',
        display: 'grid',
        placeItems: 'center',
        fontSize: 48,
        color: '#ecebe4',
        background: 'rgba(18,18,17,.6)',
      }}
    >
      <ImageSquare weight="duotone" />
    </div>
  );
}
```
**Impact:** A paste of an image while the cursor is in the chat bar or a card textarea also creates an image note. The design does the same: its handler has no focus check. Text pastes are untouched.

### Step 5: Full-screen view reducer
**File:** `web/src/fullscreen/view.ts` (new)
**Change:** A pure version of `Fullscreen.dc.html:20-38`, so the toggle-vs-drag rule can be tested without layout. One deliberate refinement: in 1:1 mode the image is sized `naturalWidth / devicePixelRatio` CSS px, so one image pixel is one **device** pixel (the brief: "click toggles 1:1 pixels"). At DPR 1 this is identical to the design's `maxWidth: none`.
**Code:**
```ts
import type { CSSProperties } from 'react';

export const DRAG_THRESHOLD = 4;

type Drag = { sx: number; sy: number; ox: number; oy: number; moved: boolean };

export type View = { fit: boolean; x: number; y: number; drag: Drag | null };

export type ViewAction =
  | { type: 'down'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'up' }
  | { type: 'leave' };

export const initialView: View = { fit: true, x: 0, y: 0, drag: null };

export function viewReducer(s: View, a: ViewAction): View {
  switch (a.type) {
    case 'down':
      return { ...s, drag: { sx: a.x, sy: a.y, ox: s.x, oy: s.y, moved: false } };
    case 'move': {
      const d = s.drag;
      if (!d || s.fit) return s;
      const dx = a.x - d.sx;
      const dy = a.y - d.sy;
      if (d.moved || Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        return { ...s, x: d.ox + dx, y: d.oy + dy, drag: { ...d, moved: true } };
      }
      return s;
    }
    case 'up': {
      const d = s.drag;
      if (d && !d.moved) return { fit: !s.fit, x: 0, y: 0, drag: null };
      return { ...s, drag: null };
    }
    case 'leave':
      return s.drag ? { ...s, drag: null } : s;
  }
}

export type Natural = { w: number; h: number } | null;

export function imgStyleFor(v: View, natural: Natural, dpr: number): CSSProperties {
  if (v.fit) {
    return { position: 'absolute', inset: 0, margin: 'auto', maxWidth: '100%', maxHeight: '100%', display: 'block' };
  }
  const ratio = dpr > 0 ? dpr : 1;
  const size: CSSProperties = natural ? { width: natural.w / ratio, height: natural.h / ratio } : {};
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    maxWidth: 'none',
    maxHeight: 'none',
    display: 'block',
    ...size,
    transform: `translate(calc(-50% + ${v.x}px), calc(-50% + ${v.y}px))`,
  };
}

export function cursorFor(v: View): string {
  if (v.fit) return 'zoom-in';
  return v.drag && v.drag.moved ? 'grabbing' : 'grab';
}
```

### Step 6: `FullscreenApp` and its entry
**File:** `web/src/fullscreen/FullscreenApp.tsx` (new)
**Change:** The id comes from `/full/<id>` (phase 6's route), or from `?id=` as a fallback for `vite` dev. `document.title = id`. The image is `/api/notes/:id/display`, which phase 5 serves as the original bytes for browser formats and the HEIC display derivative otherwise. It is shown with **no filter** on black. If the image fails to load, `describeMissing` fetches the display URL to read the error. A `404 {error:'not_on_this_machine', host}` gives the same placeholder as the wall, centred on black, sized to the note's aspect ratio when `GET /api/notes/:id` answers.
**Code:**
```tsx
import { useEffect, useReducer, useState } from 'react';
import { ImagePlaceholder, aspectOf, imageUrl } from '../components/NoteImage';
import { cursorFor, imgStyleFor, initialView, viewReducer, type Natural } from './view';

export function idFromLocation(loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const m = /^\/full\/([^/]+)\/?$/.exec(loc.pathname);
  if (m) return decodeURIComponent(m[1]);
  const q = new URLSearchParams(loc.search).get('id');
  return q && q.trim() ? q.trim() : null;
}

export type Missing = { caption: string; host: string | null; w: number; h: number };

/** Why the display image did not load, plus the note's aspect ratio when it can be read. */
export async function describeMissing(id: string, fetchImpl: typeof fetch = fetch): Promise<Missing> {
  let caption = 'unavailable';
  let host: string | null = null;
  try {
    const res = await fetchImpl(imageUrl(id, 'display'));
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: unknown; host?: unknown } | null;
      if (body && body.error === 'not_on_this_machine') {
        caption = 'not on this machine';
        host = typeof body.host === 'string' && body.host ? body.host : null;
      } else {
        caption = 'not found';
      }
    }
  } catch {
    // network error: keep 'unavailable'
  }
  let dims = aspectOf(null);
  try {
    const res = await fetchImpl(`/api/notes/${encodeURIComponent(id)}`);
    if (res.ok) {
      const json = (await res.json()) as { note?: { image?: { width: number; height: number } | null }; image?: { width: number; height: number } | null };
      const note = json && 'note' in json && json.note ? json.note : json;
      dims = aspectOf(note?.image ?? null);
    }
  } catch {
    // keep the 3:2 fallback
  }
  return { caption, host, w: dims.w, h: dims.h };
}

export function FullscreenApp({ id }: { id: string | null }) {
  const [view, dispatch] = useReducer(viewReducer, initialView);
  const [natural, setNatural] = useState<Natural>(null);
  const [missing, setMissing] = useState<Missing | null>(
    id === null ? { caption: 'not found', host: null, w: 3, h: 2 } : null,
  );

  useEffect(() => {
    document.title = id ?? 'Image';
  }, [id]);

  const onError = () => {
    if (id === null) return;
    void describeMissing(id).then(setMissing);
  };

  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;

  return (
    <div
      data-fullscreen=""
      onMouseDown={(e) => dispatch({ type: 'down', x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => dispatch({ type: 'move', x: e.clientX, y: e.clientY })}
      onMouseUp={() => dispatch({ type: 'up' })}
      onMouseLeave={() => dispatch({ type: 'leave' })}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        overflow: 'hidden',
        cursor: missing ? 'default' : cursorFor(view),
        userSelect: 'none',
      }}
    >
      {missing ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <ImagePlaceholder
            aspect={`${missing.w} / ${missing.h}`}
            caption={missing.caption}
            host={missing.host}
            width={`min(100vw, calc(100vh * ${(missing.w / missing.h).toFixed(4)}))`}
          />
        </div>
      ) : id !== null ? (
        <img
          src={imageUrl(id, 'display')}
          alt=""
          draggable={false}
          data-fit={view.fit ? 'fit' : 'actual'}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={onError}
          style={imgStyleFor(view, natural, dpr)}
        />
      ) : null}
    </div>
  );
}
```

**File:** `web/src/fullscreen/main.tsx` (new)
**Code:**
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/geist-mono/400.css';
import { FullscreenApp, idFromLocation } from './FullscreenApp';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <FullscreenApp id={idFromLocation(window.location)} />
    </StrictMode>,
  );
}
```

**File:** `web/fullscreen.html` (new)
**Change:** Black page, no grain overlay, no other UI (`Fullscreen.dc.html:11`). The title is replaced at runtime by the note id.
**Code:**
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Image</title>
    <style>
      html,
      body {
        margin: 0;
        background: #000;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/fullscreen/main.tsx"></script>
  </body>
</html>
```

### Step 7: Second Vite input
**File:** `web/vite.config.ts` (phase 7's file), `build.rolldownOptions.input`
**Change:** Add the full-screen page as a second HTML entry, so `npm run build` writes `web/dist/fullscreen.html` next to `web/dist/index.html`. Phase 7's plan was not written when this plan was drafted, so the file below is what this phase expects phase 7 to ship. **If phase 7's file differs, change only the `input` map** (add the `fullscreen` key, and make sure a `main` entry for `index.html` exists, because setting `input` replaces Vite's default single entry) and keep everything else of phase 7's. `base` must stay `'/'`.
**Code (expected full file after this step):**
```ts
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webRoot,
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(webRoot, 'dist'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: resolve(webRoot, 'index.html'),
        fullscreen: resolve(webRoot, 'fullscreen.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7317',
      '/full': 'http://127.0.0.1:7317',
    },
  },
});
```
**Impact:** One more HTML file in `web/dist`. Phase 6's `/full/:id` route already points at it. Before this step that route answered with a missing-file response.

### Step 8: Tests (jsdom, no testing-library)
Every test file starts with the jsdom pragma and uses this local render helper (inlined per file):
```tsx
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
```

**File:** `web/src/components/NoteImage.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FILM_FILTER, NoteImage, aspectOf, imageUrl, type ImageNote } from './NoteImage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const note = (over: Partial<NonNullable<ImageNote['image']>> = {}): ImageNote => ({
  id: 'K-F07',
  body: 'River #walks',
  tags: ['walks'],
  created_at: '2026-10-30T01:00:00.000Z',
  image: { width: 600, height: 400, available: true, host: 'lenovo', ...over },
});

describe('NoteImage', () => {
  it('renders the thumb with the film filter and aspect ratio', () => {
    const el = render(<NoteImage note={note()} variant="thumb" />);
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/notes/K-F07/thumb');
    expect(img.style.filter).toBe(FILM_FILTER);
    expect(img.style.aspectRatio).toBe('600 / 400');
  });

  it('uses the display derivative for the modal variant', () => {
    const el = render(<NoteImage note={note()} variant="display" />);
    expect(el.querySelector('img')!.getAttribute('src')).toBe('/api/notes/K-F07/display');
  });

  it('shows the placeholder with the host when the file is not on this machine', () => {
    const el = render(<NoteImage note={note({ available: false, host: 'lenovo' })} variant="thumb" />);
    expect(el.querySelector('img')).toBeNull();
    const ph = el.querySelector('[data-placeholder="image"]') as HTMLElement;
    expect(ph).not.toBeNull();
    expect(ph.textContent).toContain('not on this machine');
    expect(ph.textContent).toContain('lenovo');
    expect(ph.style.aspectRatio).toBe('600 / 400');
    expect(el.querySelector('button')).toBeNull();
  });

  it('omits the host line when the host is unknown', () => {
    const el = render(<NoteImage note={note({ available: false, host: null })} variant="display" />);
    const ph = el.querySelector('[data-placeholder="image"]')!;
    expect(ph.textContent).toBe('not on this machine');
  });

  it('falls back to an "unavailable" placeholder when the image errors', () => {
    const el = render(<NoteImage note={note()} variant="thumb" />);
    act(() => {
      el.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('unavailable');
  });

  it('renders nothing for a text note', () => {
    const el = render(<NoteImage note={{ ...note(), image: null }} variant="thumb" />);
    expect(el.innerHTML).toBe('');
  });

  it('helpers', () => {
    expect(imageUrl('A-B32', 'original')).toBe('/api/notes/A-B32/original');
    expect(aspectOf({ width: 0, height: 0 }).css).toBe('3 / 2');
  });
});
```

**File:** `web/src/components/Gallery.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gallery, galleryTile } from './Gallery';
import type { ImageNote } from './NoteImage';

vi.mock('../lib/dates', () => ({ relativeDate: () => 'Today' }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const n = (id: string, w: number, h: number, tags: string[] = []): ImageNote => ({
  id,
  body: `photo ${tags.map((t) => '#' + t).join(' ')}`,
  tags,
  created_at: '2026-10-30T01:00:00.000Z',
  image: { width: w, height: h, available: true, host: null },
});

describe('galleryTile', () => {
  it('grow = w/h to 3 places, basis = round(w/h * 230)', () => {
    expect(galleryTile({ width: 600, height: 400 })).toEqual({ grow: '1.500', basis: 345, ar: '600 / 400' });
    expect(galleryTile({ width: 500, height: 700 })).toEqual({ grow: '0.714', basis: 164, ar: '500 / 700' });
    expect(galleryTile({ width: 600, height: 600 })).toEqual({ grow: '1.000', basis: 230, ar: '600 / 600' });
    expect(galleryTile({ width: 640, height: 427 }).basis).toBe(345);
  });
});

describe('Gallery', () => {
  it('renders one tile per photo, a trailing spacer, and opens the modal on click', () => {
    const photos = [n('K-F07', 600, 400), n('D-P90', 600, 800)];
    const el = render(<Gallery photos={photos} copiedId={null} onCopy={() => {}} />);
    const section = el.querySelector('[data-gallery]')!;
    expect(section.querySelectorAll('[data-photo]').length).toBe(2);
    expect(section.lastElementChild!.hasAttribute('data-gallery-spacer')).toBe(true);
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
    act(() => {
      (el.querySelector('[data-photo="D-P90"]') as HTMLElement).click();
    });
    const modal = document.querySelector('[data-modal="photo"]')!;
    expect(modal).not.toBeNull();
    expect(modal.querySelector('[data-meta]')!.textContent).toBe('2 / 2  Today');
  });

  it('closes the modal when the open photo leaves the list', () => {
    const photos = [n('K-F07', 600, 400), n('D-P90', 600, 800)];
    const el = render(<Gallery photos={photos} copiedId={null} onCopy={() => {}} />);
    act(() => {
      (el.querySelector('[data-photo="D-P90"]') as HTMLElement).click();
    });
    act(() => root!.render(<Gallery photos={[photos[0]]} copiedId={null} onCopy={() => {}} />));
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
  });
});
```

**File:** `web/src/components/PhotoModal.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhotoModal, stepIndex, stripTags } from './PhotoModal';
import type { ImageNote } from './NoteImage';

vi.mock('../lib/dates', () => ({ relativeDate: () => 'Today' }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const photo = (id: string, body: string, tags: string[]): ImageNote => ({
  id,
  body,
  tags,
  created_at: '2026-10-30T01:00:00.000Z',
  image: { width: 600, height: 400, available: true, host: null },
});
const photos = [
  photo('K-F07', 'River below the old bridge, 6:40am. Fog lifting. #walks #film', ['walks', 'film']),
  photo('D-P90', 'Pug on the tram again. #walks', ['walks']),
  photo('B-Y66', '#film #kitchen', ['film', 'kitchen']),
];

function key(k: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

describe('stepIndex / stripTags', () => {
  it('wraps both ways', () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
  it('strips hashtags and collapses whitespace, keeping C# and a#b', () => {
    expect(stripTags('River below the old bridge, 6:40am. Fog lifting. #walks #film')).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(stripTags('#film #kitchen')).toBe('');
    expect(stripTags('learn C# and a#b #todo')).toBe('learn C# and a#b');
  });
});

describe('PhotoModal', () => {
  it('shows text without tags, tag chips, id and meta', () => {
    render(<PhotoModal photos={photos} index={0} onIndex={() => {}} onClose={() => {}} copiedId={null} onCopy={() => {}} />);
    const modal = document.querySelector('[data-modal="photo"]')!;
    expect(modal.querySelector('p')!.textContent).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(modal.textContent).toContain('#walks');
    expect(modal.textContent).toContain('#film');
    expect(modal.textContent).toContain('K-F07');
    expect(modal.querySelector('[data-meta]')!.textContent).toBe('1 / 3  Today');
    expect(modal.querySelector('img')!.getAttribute('src')).toBe('/api/notes/K-F07/display');
  });

  it('arrow keys step with wraparound; Escape closes and does not reach document listeners', () => {
    const onIndex = vi.fn();
    const onClose = vi.fn();
    const docEsc = vi.fn();
    document.addEventListener('keydown', docEsc);
    render(<PhotoModal photos={photos} index={0} onIndex={onIndex} onClose={onClose} copiedId={null} onCopy={() => {}} />);
    key('ArrowLeft');
    expect(onIndex).toHaveBeenLastCalledWith(2);
    key('ArrowRight');
    expect(onIndex).toHaveBeenLastCalledWith(1);
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(docEsc).not.toHaveBeenCalled();
    key('a');
    expect(docEsc).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', docEsc);
  });

  it('wraps forward from the last photo via the Next button', () => {
    const onIndex = vi.fn();
    render(<PhotoModal photos={photos} index={2} onIndex={onIndex} onClose={() => {}} copiedId={null} onCopy={() => {}} />);
    act(() => {
      (document.querySelector('[data-tip="Next"]') as HTMLElement).click();
    });
    expect(onIndex).toHaveBeenCalledWith(0);
  });

  it('backdrop click closes; clicks on the image, panel and prev do not', () => {
    const onClose = vi.fn();
    render(<PhotoModal photos={photos} index={1} onIndex={() => {}} onClose={onClose} copiedId={null} onCopy={() => {}} />);
    const modal = document.querySelector('[data-modal="photo"]') as HTMLElement;
    act(() => (modal.querySelector('img') as HTMLElement).click());
    act(() => (modal.querySelector('p') as HTMLElement).click());
    act(() => (modal.querySelector('[data-tip="Previous"]') as HTMLElement).click());
    expect(onClose).not.toHaveBeenCalled();
    act(() => modal.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copy calls onCopy, "copied" follows copiedId, and full screen opens /full/<id>', () => {
    const onCopy = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<PhotoModal photos={photos} index={1} onIndex={() => {}} onClose={() => {}} copiedId={'D-P90'} onCopy={onCopy} />);
    act(() => (document.querySelector('[data-tip="Copy ID"]') as HTMLElement).click());
    expect(onCopy).toHaveBeenCalledWith('D-P90');
    expect(document.querySelector('[data-modal="photo"]')!.textContent).toContain('copied');
    act(() => (document.querySelector('[data-tip="Show full screen"]') as HTMLElement).click());
    expect(open).toHaveBeenCalledWith('/full/D-P90', '_blank', 'noopener');
  });
});
```

**File:** `web/src/components/DropOverlay.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DropOverlay, firstImageFile, hasFiles, imageFiles } from './DropOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

const txt = new File(['hello'], 'a.txt', { type: 'text/plain' });
const png = new File(['png'], 'b.png', { type: 'image/png' });
const jpg = new File(['jpg'], 'c.jpg', { type: 'image/jpeg' });

function eventWith(type: string, prop: 'clipboardData' | 'dataTransfer', value: unknown): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, prop, { value });
  return e;
}

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const flush = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('file helpers', () => {
  it('firstImageFile picks the first image file', () => {
    expect(firstImageFile([txt, png, jpg])).toBe(png);
    expect(firstImageFile([txt])).toBeNull();
    expect(firstImageFile(null)).toBeNull();
    expect(imageFiles([txt, png, jpg])).toEqual([png, jpg]);
  });
  it('hasFiles only for Files drags', () => {
    expect(hasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(hasFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});

describe('DropOverlay', () => {
  it('paste uploads only the first image file and prevents default', async () => {
    fetchMock.mockResolvedValue(okResponse({ note: { id: 'A-B32', body: '', tags: [], created_at: '', image: null }, created: true }));
    const onImageAdded = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} />);
    const e = eventWith('paste', 'clipboardData', { files: [txt, png, jpg] });
    act(() => {
      document.dispatchEvent(e);
    });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/images');
    expect(init.method).toBe('POST');
    expect(((init.body as FormData).get('file') as File).name).toBe('b.png');
    expect(onImageAdded).toHaveBeenCalledTimes(1);
    expect(onImageAdded.mock.calls[0]![0]).toMatchObject({ id: 'A-B32' });
  });

  it('a text-only paste is left alone', () => {
    render(<DropOverlay onImageAdded={() => {}} />);
    const e = eventWith('paste', 'clipboardData', { files: [txt] });
    act(() => {
      document.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a dedupe hit is handed to onImageAdded like any upload', async () => {
    fetchMock.mockResolvedValue(okResponse({ note: { id: 'K-F07', body: '', tags: [], created_at: '', image: null }, created: false }));
    const onImageAdded = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} />);
    act(() => {
      document.dispatchEvent(eventWith('paste', 'clipboardData', { files: [png] }));
    });
    await flush();
    // A dedupe hit goes through the same seam (App switches text -> all); flashNote then scrolls to it.
    expect(onImageAdded).toHaveBeenCalledTimes(1);
    expect(onImageAdded.mock.calls[0]![0]).toMatchObject({ id: 'K-F07' });
  });

  it('shows the overlay only for Files drags and uploads dropped images one at a time', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((res) => resolvers.push(res)));
    const el = render(<DropOverlay onImageAdded={() => {}} />);

    act(() => {
      document.dispatchEvent(eventWith('dragover', 'dataTransfer', { types: ['text/plain'], files: [] }));
    });
    expect(el.querySelector('[data-drop-overlay]')).toBeNull();

    const over = eventWith('dragover', 'dataTransfer', { types: ['Files'], files: [] });
    act(() => {
      document.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(el.querySelector('[data-drop-overlay]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [png, txt, jpg] }));
    });
    expect(el.querySelector('[data-drop-overlay]')).toBeNull();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvers[0](okResponse({ note: { id: 'A-B32', body: '', tags: [], created_at: '', image: null }, created: true }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData).get('file') as File).name).toBe('c.jpg');
  });

  it('dragleave with no relatedTarget hides the overlay', () => {
    const el = render(<DropOverlay onImageAdded={() => {}} />);
    act(() => {
      document.dispatchEvent(eventWith('dragover', 'dataTransfer', { types: ['Files'], files: [] }));
    });
    act(() => {
      document.dispatchEvent(new Event('dragleave', { bubbles: true }));
    });
    expect(el.querySelector('[data-drop-overlay]')).toBeNull();
  });
});
```

**File:** `web/src/fullscreen/FullscreenApp.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FullscreenApp, idFromLocation } from './FullscreenApp';
import { initialView, viewReducer } from './view';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function mouse(el: Element, type: string, x: number, y: number) {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  });
}

describe('viewReducer', () => {
  it('a click (no move) toggles fit and resets the pan', () => {
    let s = viewReducer(initialView, { type: 'down', x: 10, y: 10 });
    s = viewReducer(s, { type: 'up' });
    expect(s).toEqual({ fit: false, x: 0, y: 0, drag: null });
    s = viewReducer(s, { type: 'down', x: 0, y: 0 });
    s = viewReducer(s, { type: 'up' });
    expect(s.fit).toBe(true);
  });
  it('moves within the 4px threshold still count as a click', () => {
    let s = viewReducer({ ...initialView, fit: false }, { type: 'down', x: 0, y: 0 });
    s = viewReducer(s, { type: 'move', x: 2, y: 2 });
    expect(s.x).toBe(0);
    s = viewReducer(s, { type: 'up' });
    expect(s.fit).toBe(true);
  });
  it('a drag past the threshold pans and does not toggle', () => {
    let s = viewReducer({ fit: false, x: 5, y: 5, drag: null }, { type: 'down', x: 100, y: 100 });
    s = viewReducer(s, { type: 'move', x: 130, y: 90 });
    expect([s.x, s.y]).toEqual([35, -5]);
    s = viewReducer(s, { type: 'move', x: 101, y: 100 });
    expect([s.x, s.y]).toEqual([6, 5]);
    s = viewReducer(s, { type: 'up' });
    expect(s.fit).toBe(false);
    expect([s.x, s.y]).toEqual([6, 5]);
  });
  it('dragging does nothing in fit mode; leave cancels a drag', () => {
    let s = viewReducer(initialView, { type: 'down', x: 0, y: 0 });
    s = viewReducer(s, { type: 'move', x: 50, y: 50 });
    expect([s.x, s.y, s.drag?.moved]).toEqual([0, 0, false]);
    s = viewReducer(s, { type: 'leave' });
    expect(s.drag).toBeNull();
  });
});

describe('idFromLocation', () => {
  it('reads /full/<id> and falls back to ?id=', () => {
    expect(idFromLocation({ pathname: '/full/A-B32', search: '' })).toBe('A-B32');
    expect(idFromLocation({ pathname: '/full/A-B32/', search: '' })).toBe('A-B32');
    expect(idFromLocation({ pathname: '/fullscreen.html', search: '?id=K-F07' })).toBe('K-F07');
    expect(idFromLocation({ pathname: '/', search: '' })).toBeNull();
  });
});

describe('FullscreenApp', () => {
  it('sets the title, shows the unfiltered display image, click toggles fit, drag does not', () => {
    const el = render(<FullscreenApp id="A-B32" />);
    expect(document.title).toBe('A-B32');
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/notes/A-B32/display');
    expect(img.style.filter).toBe('');
    expect(img.dataset.fit).toBe('fit');
    const stage = el.querySelector('[data-fullscreen]')!;

    mouse(stage, 'mousedown', 100, 100);
    mouse(stage, 'mouseup', 100, 100);
    expect(el.querySelector('img')!.dataset.fit).toBe('actual');
    expect((stage as HTMLElement).style.cursor).toBe('grab');

    mouse(stage, 'mousedown', 100, 100);
    mouse(stage, 'mousemove', 140, 100);
    expect((stage as HTMLElement).style.cursor).toBe('grabbing');
    mouse(stage, 'mouseup', 140, 100);
    expect(el.querySelector('img')!.dataset.fit).toBe('actual');

    mouse(stage, 'mousedown', 10, 10);
    mouse(stage, 'mouseup', 10, 10);
    expect(el.querySelector('img')!.dataset.fit).toBe('fit');
  });

  it('shows the placeholder with the host when the display endpoint 404s not_on_this_machine', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/notes/K-F07/display') {
        return new Response(JSON.stringify({ error: 'not_on_this_machine', host: 'lenovo' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'K-F07', image: { width: 600, height: 400 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const el = render(<FullscreenApp id="K-F07" />);
    act(() => {
      el.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    for (let i = 0; i < 10; i++) await act(async () => {});
    expect(el.querySelector('img')).toBeNull();
    const ph = el.querySelector('[data-placeholder="image"]') as HTMLElement;
    expect(ph.textContent).toContain('not on this machine');
    expect(ph.textContent).toContain('lenovo');
    expect(ph.style.aspectRatio).toBe('600 / 400');
  });
});
```

### Step 9: Call-site check (no edit)
**File:** none. Phase 7's `web/src/App.tsx` already renders `<Gallery photos copiedId onCopy />`
(only in `'images'` mode), `<DropOverlay onImageAdded />` once at the root, and NoteCard renders
`<NoteImage note />`. This phase's components take exactly those props (reconciled), so App is not
edited. Confirm with `grep -n "<Gallery\|<DropOverlay\|<NoteImage" web/src/App.tsx web/src/components/NoteCard.tsx`.
**Impact:** none.

## Verification

**Build:** `npm run typecheck && npm run build`, then `test -f web/dist/fullscreen.html && test -f web/dist/index.html`. `grep -o 'src="/assets/[^"]*"' web/dist/fullscreen.html` must print an absolute `/assets/` URL.
**Tests:** `npm test` (includes the five new `web/src/**/*.test.tsx` files) and `npm run test:int` (unchanged, must stay green).
**Manual check (daemon on a test port, never 7317; temp data dir; the test Postgres, not Neon):**
```bash
cd /home/miftah/.worktrees/mcp-notes/notes-spine-images-ui
npm run build
export NOTES_DATA_DIR="$(mktemp -d)"
# DATABASE_URL: the mcp-notes-pg-test container URL (port 55433) that scripts/test-int.sh uses,
# after `npm run test:int` has started and migrated it. Never the .env.local Neon URL for this check.
export DATABASE_URL="$TEST_DATABASE_URL"
NOTESD_PORT=7391 node dist/main.js &   # stop it with kill %1 at the end
IMG=tests/fixtures/<a JPEG with EXIF, from phase 4>
curl -s -F "file=@$IMG" http://127.0.0.1:7391/api/images            # → {"note":{"id":"X-XXX",...},"created":true}
curl -s -F "file=@$IMG" http://127.0.0.1:7391/api/images            # → same id, "created":false
ID=<that id>
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:7391/full/$ID              # 200 text/html
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:7391/api/notes/$ID/display # 200 image/jpeg
cmp <(curl -s http://127.0.0.1:7391/api/notes/$ID/display) "$IMG" && echo display=original-bytes
mv "$NOTES_DATA_DIR/images" "$NOTES_DATA_DIR/images.off"
curl -s http://127.0.0.1:7391/api/notes/$ID/display                  # 404 {"error":"not_on_this_machine","host":...}
mv "$NOTES_DATA_DIR/images.off" "$NOTES_DATA_DIR/images"
```
In a browser at `http://localhost:7391` (Windows reaches WSL loopback), check:
- The page opens in `'text'` mode with no image cards. `'all'` shows image cards on the wall with the film tone. `'images'` shows the flex-wrap contact sheet with 4px gaps and a ragged last row, filtered by the active tags. Headings and counts come from phase 7.
- In `'text'` mode, pasting a new image switches to `'all'` and the new card appears. Pasting the same image again in `'text'` mode jumps to it in `'all'` and flashes it.
- A click opens the modal: display image with the film tone, text without hashtags, tag chips, id + copy + "copied", `1 / n  date`. ←/→ wrap. Esc closes and leaves an open chat panel alone. A backdrop click closes.
- "Show full screen" opens a new tab titled with the id: black page, no filter, fit by default. A click goes to 1:1, a drag pans, a click returns to fit.
- Dragging a file shows the dashed overlay. Dragging selected text does not. Dropping uploads, and the card appears through SSE with no reload. Pasting a screenshot (Win+Shift+S, then Ctrl+V) creates a note. Pasting the same image again jumps to and flashes the existing card.
- With `images/` moved away and the page reloaded: wall card, gallery tile and modal show the "not on this machine" placeholder at the right aspect ratio, and `/full/<id>` shows it on black.

**Exit criteria:** `npm run typecheck`, `npm test`, `npm run test:int`, `npm run build` are green. `web/dist/fullscreen.html` exists. Every manual check above passes against the test-port daemon.

## Handoffs

- **Phase 7 (resolved by the reconciler).** This phase conforms to phase 7's stub props and its `onImageAdded(note)` seam; it does not edit App. `photosOf` and the copy helper are phase 7's (`lib/filter.ts`, `hooks/useCopied.ts`); this phase no longer defines its own. Vite input key is `rolldownOptions` (Vite 8.3.5, phase 1's pin).
- **Phase 7 (film tone constant).** `FILM_FILTER` lives in `NoteImage.tsx`. If phase 7 defines its own, it should import this one.
- **Phase 6 (no change expected).** `/full/:id` must serve `web/dist/fullscreen.html` for any id string (case-insensitive ids pass through to `/api/notes/:id/display`, which phase 5 normalises).
- **Later iteration / not in R3.** No upload error surface: failures only go to `console.error`, because the design has none. An error toast would be a design change, not part of this plan.

## Rollback

Restore the four stub files to phase 7's versions (`git checkout <phase-7 commit> -- web/src/components/{Gallery,PhotoModal,DropOverlay,NoteImage}.tsx web/vite.config.ts`). Delete `web/fullscreen.html`, `web/src/fullscreen/`, `web/src/components/PhotoModal.css` and the five new test files. Or `git revert` this phase's commit. No server, schema or dependency state is involved.
