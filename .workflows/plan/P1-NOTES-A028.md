> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 6. Source: `.workflows/plan/wall-editing/phase-6.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 6: Web on images[]: cards, gallery, modal stepping, full-screen by image

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R1 (web consumers of `images[]`), R5 (this phase's own tests). The user sees: a wall card shows its first image as the cover with a small Geist Mono count when the note has more; "Photos." shows one tile per image; the photo modal steps image by image (within a note, then across notes) and says which image of the note it is; "Show full screen" opens that image.
**Depends on:** Phase 2 (server wire `images[]`, `GET /api/images/:id`, `GET /api/images/:id/:variant`)
**Difficulty:** HARD
**Package:** `web/src`

---

## Goal

After this phase the web app reads the phase-2 wire: `Note.images: NoteImage[]` replaces `Note.image`, every image URL is keyed by **image id** (`/api/images/<imageId>/<variant>`), and the gallery/modal work on a flat `PhotoItem[]` (one item per image, note by note in wall order, images in position order). Nothing in `web/src` reads `note.image` or builds `/api/notes/<id>/<variant>` any more.

## Interface Contract

**Deletes:**
- `NoteImageMeta` interface (`web/src/types.ts:1-10`), field `Note.image` (`web/src/types.ts:20`)
- `thumbUrl`, `displayUrl`, `originalUrl` (`web/src/api.ts:69-71`; note-keyed, unused)
- `ImageNote` type (`web/src/components/NoteImage.tsx:16-22`)
- local `imageUrl` in `web/src/components/NoteImage.tsx:26-28` (moved to `api.ts`, now image-keyed)

**Renames / moves:** `NoteImage.tsx imageUrl(noteId, variant)` -> `api.ts imageUrl(imageId, variant)` (URL becomes `/api/images/<id>/<variant>`).

**Creates:**
- `NoteImage` (wire type), `PhotoItem` (`web/src/types.ts`) — exactly the Contract shapes
- `ImageFileVariant`, `imageUrl(imageId, variant)`, `imageInfoUrl(imageId)` (`web/src/api.ts`)
- `hasImages(n)`, `imageCount(notes)` (`web/src/lib/filter.ts`)
- CSS `.card-cover`, `.card-count` (`web/src/styles.css`)
- test fixtures `makeImage(id, over?)`, `makeNote(id, body, opts?)` (`web/src/testing/fixtures.ts`, new; not a test file, not imported by app code) — phases 7–9 may reuse them

**Signature changes:**
- `NoteImage({ note, variant, ... })` -> `NoteImage({ image, variant, ... })`; `image: ImageInfo` where `ImageInfo = Pick<NoteImage(wire), 'id'|'width'|'height'|'available'|'host'>` (any wire `NoteImage` is assignable)
- `photosOf(notes, active): Note[]` -> `photosOf(notes, active): PhotoItem[]`
- `countLineFor(mode, active, all, visible, photos: Note[])` -> `photos: PhotoItem[]`
- `GalleryProps { photos: ImageNote[] }` -> `GalleryProps { items: PhotoItem[] }`
- `PhotoModalProps { photos: ImageNote[] }` -> `PhotoModalProps { items: PhotoItem[] }`; `onCopy` receives the **note id** of the current item
- `describeMissing(id)` reads dims from `GET /api/images/<id>` (bare `NoteImage` JSON) instead of `GET /api/notes/<id>`
- `fontSizeFor(body, hasImage)` is unchanged; its callers pass `note.images.length > 0`

**Requires (from earlier phases):** Phase 2 serves `Note.images` (live images, ascending `position`) on `GET /api/notes`, `POST/PATCH /api/notes`, `POST /api/images`; `GET /api/images/:imageId` returns a bare `NoteImage` JSON object (with `width`, `height`); `GET /api/images/:imageId/{thumb,display,original,preview}` serves the file, 404 `{ error: 'not_on_this_machine', host }` when elsewhere. A note's first image has the note's own id, so old `/full/<noteId>` links keep working through the new route.

**Leaves alone (owned by others):**
- `web/src/lib/text.ts` — **not edited** (only its callers change), so phase 11 may add `oneLine` there or in `web/src/lib/oneLine.ts` without a collision.
- `<AnswerPanel …/>` and `<ChatBar …/>` JSX, `App.send`, the chat Esc effect (`App.tsx:121-137,181-196`), `ChatBar.tsx`, `AnswerPanel.tsx`, `useChat.ts`, `.answer*`/`.chatbar`/`.sendbtn` CSS — phase 11 (invariant 7).
- `DropOverlay.tsx` (behaviour and code unchanged; it never read `image`), `Wall.tsx`, `Sidebar.tsx`, `Rail.tsx`, `Header.tsx`, `useNotes.ts`.
- Editor, `ArrowsOutSimple`, `DropOverlay target` (7); trash/undo/bin (8); `RevealButton` (9).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/types.ts` | modify (lines 1-21) | wire `NoteImage`, `Note.images`, `PhotoItem`; drop `NoteImageMeta` / `Note.image` |
| `web/src/api.ts` | modify (lines 69-71) | image-id URL builders replace note-id ones |
| `web/src/components/NoteImage.tsx` | rewrite (1-137) | takes `image`; URL by image id; failure state keyed by image id |
| `web/src/lib/filter.ts` | rewrite (1-59) | `hasImages`, `imageCount`, `photosOf -> PhotoItem[]`, counts by images |
| `web/src/components/NoteCard.tsx` | rewrite (1-98) | cover = `images[0]`, count overlay when n > 1, `fontSizeFor` callers |
| `web/src/components/Gallery.tsx` | rewrite (1-66) | one tile per `PhotoItem`, open state = image id |
| `web/src/components/PhotoModal.tsx` | rewrite (1-165) | `items`, meta `i / len` + `k/n`, full screen `/full/<imageId>`, copy = note id |
| `web/src/fullscreen/FullscreenApp.tsx` | rewrite (1-102) | display + dims by image id |
| `web/src/App.tsx` | modify (lines 10, 45, 88, 166) | `imageCount`, empty rule on `images.length`, `<Gallery items>` |
| `web/src/styles.css` | modify (after line 83) | `.card-cover`, `.card-count` |
| `web/src/testing/fixtures.ts` | create | `makeImage`, `makeNote` |
| `web/src/components/NoteImage.test.tsx` | rewrite | image-keyed tests |
| `web/src/components/NoteCard.test.tsx` | rewrite | images fixtures, cover + count tests |
| `web/src/components/Gallery.test.tsx` | rewrite | `PhotoItem` tiles, open by image |
| `web/src/components/PhotoModal.test.tsx` | rewrite | stepping across a multi-image note, `k/n`, `/full/<imageId>` |
| `web/src/lib/filter.test.tsx` | rewrite | new helpers, flattened photos, counts |
| `web/src/fullscreen/FullscreenApp.test.tsx` | rewrite | `/api/images/<id>` URLs |
| `web/src/App.test.tsx` | modify (lines 4-20, 68, insert after 69) | fixtures with `images`, new multi-image test |
| `web/src/components/DropOverlay.test.tsx` | modify (lines 64, 93, 128) | `image: null` -> `images: []` in response fixtures |

## Implementation Steps

### Step 1: Wire types
**File:** `web/src/types.ts:1-21` (replace lines 1-21; `TagCount` and `Mode` below stay as they are)
**Change:** mirror the phase-2 wire exactly; add `PhotoItem`.
**Code:**
```ts
/** One image of a note, as the server sends it (src/notes/types.ts, phase 2). */
export interface NoteImage {
  id: string;
  note_id: string;
  position: number;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  /** The original exists under this machine's data dir. */
  available: boolean;
  /** `/api/images/<id>/<variant>`. */
  urls: { thumb: string; display: string; original: string; preview: string };
  /** Present only on removed images (bin listings). */
  deleted_at?: string;
}

export interface Note {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  origin: Record<string, unknown> | null;
  /** Live images, ascending `position`. Empty for a text note. */
  images: NoteImage[];
}

/** One image in the gallery / photo modal: `k` is 1-based within its note of `n` images. */
export interface PhotoItem {
  note: Note;
  image: NoteImage;
  k: number;
  n: number;
}
```
**Impact:** every reader of `Note.image` stops compiling until Steps 2–9 land (all in this phase).

### Step 2: Image URLs by image id
**File:** `web/src/api.ts:69-71`
**Change:** delete `thumbUrl`, `displayUrl`, `originalUrl` (note-keyed; nothing imports them) and append the image-keyed builders. `enc` is the existing `encodeURIComponent` alias at line 26.
**Code (replaces lines 69-71):**
```ts
export type ImageFileVariant = 'thumb' | 'display' | 'original' | 'preview';

/** `/api/images/<imageId>/<variant>` — serves any image row's file (phase 2). */
export function imageUrl(imageId: string, variant: ImageFileVariant): string {
  return `/api/images/${enc(imageId)}/${variant}`;
}

/** `GET /api/images/<imageId>` → the image's wire `NoteImage` JSON. */
export function imageInfoUrl(imageId: string): string {
  return `/api/images/${enc(imageId)}`;
}
```
Why build by id rather than read `image.urls`: `FullscreenApp` only has an id from the location, and one builder keeps every caller identical; the server's `urls` are the same strings.
**Impact:** none outside this phase.

### Step 3: `NoteImage` component takes an image
**File:** `web/src/components/NoteImage.tsx` (whole file, lines 1-137)
**Code:**
```tsx
import { useState, type CSSProperties, type MouseEvent } from 'react';
import { ImageBroken } from '@phosphor-icons/react';
import { imageUrl } from '../api';
import type { NoteImage as NoteImageData } from '../types';

/** Film tone from the design (Notes Wall.dc.html:282). Wall, gallery and modal only. */
export const FILM_FILTER = 'sepia(.14) saturate(1.12) contrast(1.05) brightness(.97)';

/** The subset of the wire `NoteImage` this file reads. Any wire `NoteImage` is assignable. */
export type ImageInfo = Pick<NoteImageData, 'id' | 'width' | 'height' | 'available' | 'host'>;

export type ImageVariant = 'thumb' | 'display';

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

/** `variant` defaults to 'thumb' (wall cover, gallery tile); the modal passes 'display'. */
export type NoteImageProps = {
  image: ImageInfo;
  variant?: ImageVariant;
  className?: string;
  style?: CSSProperties;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
};

/**
 * One image, with the film tone, fetched by its image id.
 * - `thumb`: wall cover and gallery tile (Notes Wall.dc.html:72, 97): full width, height from the aspect ratio.
 * - `display`: the modal (Notes Wall.dc.html:135): the display derivative, never a downscaled guess.
 */
export function NoteImage({ image, variant = 'thumb', className = variant === 'thumb' ? 'card-img' : undefined, style, onClick }: NoteImageProps) {
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const key = `${image.id}/${variant}`;
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
      src={imageUrl(image.id, variant)}
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
**Impact:** `ImageNote` and the local `imageUrl` are gone; `FullscreenApp` now imports `imageUrl` from `../api` (Step 8).

### Step 4: Filters over images
**File:** `web/src/lib/filter.ts` (whole file, lines 1-59)
**Code:**
```ts
import type { Mode, Note, PhotoItem } from '../types';
import { tagsOf } from './text';

export const MODE_TIP: Record<Mode, string> = {
  text: 'Text notes only',
  images: 'Image notes only',
  all: 'All notes',
};
export const MODE_ORDER: Mode[] = ['text', 'images', 'all'];

export function nextMode(m: Mode): Mode {
  return m === 'text' ? 'images' : m === 'images' ? 'all' : 'text';
}

/** A note with at least one live image. */
export function hasImages(n: Note): boolean {
  return n.images.length > 0;
}

/** Number of images across `notes` (the sidebar's "N photos"). */
export function imageCount(notes: Note[]): number {
  let total = 0;
  for (const n of notes) total += n.images.length;
  return total;
}

/** AND semantics: a note matches when it carries every active tag. */
export function matchesTags(note: Note, active: string[]): boolean {
  if (active.length === 0) return true;
  const t = tagsOf(note.body);
  return active.every((a) => t.includes(a));
}

/** Notes shown on the wall. `keepId` (the note being edited) is always kept. */
export function visibleOnWall(notes: Note[], mode: Mode, active: string[], keepId: string | null = null): Note[] {
  return notes.filter((n) => n.id === keepId || ((mode !== 'text' || !hasImages(n)) && matchesTags(n, active)));
}

/** One item per image of every tag-matching note: note by note in wall order, images in position order. */
export function photosOf(notes: Note[], active: string[]): PhotoItem[] {
  const out: PhotoItem[] = [];
  for (const note of notes) {
    if (!hasImages(note) || !matchesTags(note, active)) continue;
    const n = note.images.length;
    note.images.forEach((image, i) => out.push({ note, image, k: i + 1, n }));
  }
  return out;
}

export function headingFor(mode: Mode, active: string[]): string {
  if (mode === 'images') return 'Photos.';
  if (active.length) return active.map((t) => '#' + t).join(' ');
  return mode === 'text' ? 'Notes.' : 'Everything.';
}

export function countLineFor(mode: Mode, active: string[], all: Note[], visible: Note[], photos: PhotoItem[]): string {
  if (mode === 'images') return `${photos.length} photos.`;
  if (active.length) return `${visible.length} of ${all.length} notes.`;
  if (mode === 'text') return `${visible.length} notes, ${all.length - visible.length} photo notes hidden.`;
  return `${all.length} notes, ${all.filter(hasImages).length} with photos.`;
}

export function lastEdited(notes: Note[]): Note | null {
  let best: Note | null = null;
  let bestT = -Infinity;
  for (const n of notes) {
    const t = Date.parse(n.updated_at);
    if (!Number.isNaN(t) && t > bestT) {
      best = n;
      bestT = t;
    }
  }
  return best;
}

export function isHiddenByMode(note: Note | undefined, mode: Mode): boolean {
  return mode === 'images' || (mode === 'text' && !!note && hasImages(note));
}
```
**Impact:** "Photos." count line and the sidebar count now count images; "with photos" / "photo notes hidden" still count notes (they describe notes).

### Step 5: Wall card cover + count
**File:** `web/src/components/NoteCard.tsx` (whole file, lines 1-98)
**Change:** cover = `note.images[0]` wrapped in `.card-cover`; when the note has more than one image, a Geist Mono count sits bottom-right on the cover. It is a status label (plain text in a non-interactive span, not a control), with no pill and no shadow (invariant 5; the design's mono captions, `Notes Wall.dc.html:83`). `fontSizeFor` callers pass `note.images.length > 0`.
**Code:**
```tsx
import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import type { Note } from '../types';
import { fontSizeFor, letterSpacingFor, rowsFor, segmentBody } from '../lib/text';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';

export interface NoteCardProps {
  note: Note;
  now: Date;
  editing: boolean;
  /** Chat highlight active and this note not used: opacity .22. */
  dim: boolean;
  /** Chat highlight active and this note used: outline ring. */
  used: boolean;
  copied: boolean;
  onCopy: (id: string) => void;
  onEdit: (id: string) => void;
  onCommit: (note: Note, draft: string) => void;
  onToggleTag: (tag: string) => void;
}

function CardEditor({ note, onCommit }: { note: Note; onCommit: (note: Note, draft: string) => void }) {
  const [draft, setDraft] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  return (
    <textarea
      ref={ref}
      className="card-edit"
      value={draft}
      rows={rowsFor(draft.length)}
      style={{ fontSize: fontSizeFor(draft, note.images.length > 0) }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(note, draft)}
    />
  );
}

function NoteCardImpl({ note, now, editing, dim, used, copied, onCopy, onEdit, onCommit, onToggleTag }: NoteCardProps) {
  const count = note.images.length;
  const cover = count > 0 ? note.images[0] : undefined;
  const hasImg = cover !== undefined;
  const fs = fontSizeFor(note.body, hasImg);
  const cls = ['card', hasImg ? 'img' : '', dim ? 'dim' : '', used ? 'used' : ''].filter(Boolean).join(' ');
  return (
    <article className={cls} data-note={note.id}>
      {cover && (
        <div className="card-cover">
          <NoteImage image={cover} />
          {count > 1 && (
            <span className="card-count" data-count={count}>
              {count}
            </span>
          )}
        </div>
      )}
      <div className="card-body">
        {editing ? (
          <CardEditor note={note} onCommit={onCommit} />
        ) : (
          <p className="card-text" style={{ fontSize: fs, letterSpacing: letterSpacingFor(fs) }} onClick={() => onEdit(note.id)}>
            {segmentBody(note.body).map((s, i) =>
              s.kind === 'tag' ? (
                <span
                  key={i}
                  className="tagchip"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleTag(s.tag);
                  }}
                >
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
        )}
        <div className="card-meta">
          <span className="card-id">{note.id}</span>
          <button
            type="button"
            className="copybtn"
            data-tip="Copy ID"
            aria-label="Copy ID"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(note.id);
            }}
          >
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          <span className="card-date">{relativeDate(note.created_at, now)}</span>
        </div>
      </div>
    </article>
  );
}

export const NoteCard = memo(NoteCardImpl);
```
**Impact:** the cover `<img>` is now one level deeper (inside `.card-cover`); selectors like `[data-note="X"] img` still match. Phase 7 adds its `ArrowsOutSimple` button to `.card-meta` on top of this file.

### Step 6: Cover-count CSS
**File:** `web/src/styles.css` — insert after line 83 (`.card-img { … }`)
**Code:**
```css
/* Several images: the cover is images[0]; the count sits on it, bottom-right. No pill, no shadow;
   difference blending keeps the mono digits legible on light and dark photos alike. */
.card-cover { position: relative; }
.card-count { position: absolute; right: 7px; bottom: 6px; font-family: var(--mono); font-size: 11px; line-height: 1; letter-spacing: .03em; color: var(--fg); mix-blend-mode: difference; pointer-events: none; user-select: none; }
```
**Impact:** none on the chat rules (invariant 7); inserted far from `.answer*`/`.chatbar`.

### Step 7: Gallery tile per image
**File:** `web/src/components/Gallery.tsx` (whole file, lines 1-66)
**Code:**
```tsx
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PhotoItem } from '../types';
import { NoteImage, aspectOf, type ImageInfo } from './NoteImage';
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

/** `items` arrive tag-filtered and flattened, one per image (`photosOf`). */
export interface GalleryProps {
  items: PhotoItem[];
  copiedId: string | null;
  onCopy: (id: string) => void;
}

export function Gallery({ items, copiedId, onCopy }: GalleryProps) {
  /** The open image's id; the modal hides itself when that image leaves `items`. */
  const [openId, setOpenId] = useState<string | null>(null);
  const index = openId === null ? -1 : items.findIndex((it) => it.image.id === openId);

  const onIndex = useCallback(
    (i: number) => {
      const it = items[i];
      setOpenId(it ? it.image.id : null);
    },
    [items],
  );
  const onClose = useCallback(() => setOpenId(null), []);

  return (
    <>
      {/* App.test.tsx finds the gallery by `.gallery`. */}
      <section className="gallery" data-gallery="" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 30 }}>
        {items.map((it) => {
          const t = galleryTile(it.image);
          return (
            <div
              key={it.image.id}
              data-photo={it.image.id}
              data-note={it.note.id}
              onClick={() => setOpenId(it.image.id)}
              style={{ flex: `${t.grow} 1 ${t.basis}px`, cursor: 'zoom-in', background: '#1c1c1a' }}
            >
              <NoteImage image={it.image} variant="thumb" />
            </div>
          );
        })}
        <div data-gallery-spacer="" style={{ flex: '999 1 0px' }} />
      </section>
      {index >= 0
        ? createPortal(
            <PhotoModal items={items} index={index} onIndex={onIndex} onClose={onClose} copiedId={copiedId} onCopy={onCopy} />,
            document.body,
          )
        : null}
    </>
  );
}
```
**Impact:** every tile of a multi-image note carries the same `data-note`; `flashNote` (DropOverlay) uses `querySelector`, so it pulses the note's first tile — the intended target.

### Step 8: Photo modal over `PhotoItem[]`
**File:** `web/src/components/PhotoModal.tsx` (whole file, lines 1-165)
**Change:** linear stepping over the flattened list already means "within a note, then across notes". Meta: `i / len`, then `k/n` only when the note has more than one image, then the relative date. Copy copies the note id; full screen opens `/full/<imageId>`.
**Code:**
```tsx
import { useEffect, type CSSProperties, type MouseEvent } from 'react';
import { ArrowsOut, CaretLeft, CaretRight, Check, Copy, X } from '@phosphor-icons/react';
import type { PhotoItem } from '../types';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';
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

/** `3 / 7  2/3  Today`: position in the whole list, then (only for multi-image notes) which image of the note. */
export function metaLine(index: number, len: number, item: Pick<PhotoItem, 'k' | 'n'>, when: string): string {
  const parts = [`${index + 1} / ${len}`];
  if (item.n > 1) parts.push(`${item.k}/${item.n}`);
  parts.push(when);
  return parts.join('  ');
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

/** `items` is the gallery's flattened list (one per image). Copy state is App's (`useCopied`); `onCopy` gets the note id. */
export interface PhotoModalProps {
  items: PhotoItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  copiedId: string | null;
  onCopy: (id: string) => void;
}

export function PhotoModal({ items, index, onIndex, onClose, copiedId, onCopy }: PhotoModalProps) {
  const len = items.length;
  const item = index >= 0 && index < len ? items[index] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + preventDefault + stopPropagation: Esc closes only the modal, never the
      // chat panel behind it.
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

  if (!item) return null;
  const { note, image } = item;

  const copy = () => onCopy(note.id);
  const full = () => {
    window.open(`/full/${encodeURIComponent(image.id)}`, '_blank', 'noopener');
  };
  const copied = copiedId === note.id;
  const meta = metaLine(index, len, item, relativeDate(note.created_at, new Date()));

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
        <NoteImage key={image.id} image={image} variant="display" onClick={stop} />
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
          {stripTags(note.body)}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {note.tags.map((t) => (
            <span key={t} style={{ fontSize: 11, padding: '3px 8px 4px', borderRadius: 999, background: '#2a2a27', color: '#d6d5cd' }}>
              #{t}
            </span>
          ))}
        </div>
        <div style={{ height: 1, background: 'rgba(236,235,228,.1)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'Geist Mono',monospace", fontSize: 11, color: '#bdbcb4' }}>
          <span>{note.id}</span>
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
**Impact:** phases 8 (Trash in the toolbar) and 9 (RevealButton in the toolbar) build on this file; the toolbar row is the `justifyContent: 'flex-end'` div.

### Step 9: Full screen by image id
**File:** `web/src/fullscreen/FullscreenApp.tsx` (whole file, lines 1-102)
**Change:** `idFromLocation` is unchanged (the id is now an image id; a legacy `/full/<noteId>` still resolves because a note's first image shares its id). Display = `/api/images/<id>/display`; dims for the placeholder from `GET /api/images/<id>` (bare `NoteImage`).
**Code:**
```tsx
import { useEffect, useReducer, useState } from 'react';
import { imageInfoUrl, imageUrl } from '../api';
import { ImagePlaceholder, aspectOf } from '../components/NoteImage';
import { cursorFor, imgStyleFor, initialView, viewReducer, type Natural } from './view';

/** The image id from `/full/<imageId>` (or `?id=`). */
export function idFromLocation(loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const m = /^\/full\/([^/]+)\/?$/.exec(loc.pathname);
  if (m) return decodeURIComponent(m[1]);
  const q = new URLSearchParams(loc.search).get('id');
  return q && q.trim() ? q.trim() : null;
}

export type Missing = { caption: string; host: string | null; w: number; h: number };

/** Why the display image did not load, plus the image's aspect ratio when it can be read. */
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
    const res = await fetchImpl(imageInfoUrl(id));
    if (res.ok) {
      const json = (await res.json()) as { width?: unknown; height?: unknown } | null;
      if (json && typeof json.width === 'number' && typeof json.height === 'number') {
        dims = aspectOf({ width: json.width, height: json.height });
      }
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
**Impact:** `fullscreen/main.tsx` and `view.ts` unchanged. The full-screen bundle now pulls in `api.ts` (tiny; no side effects at import).

### Step 10: App wiring
**File:** `web/src/App.tsx` — four one-line hunks, none inside the chat JSX (181-196), `send` (121-127) or the Esc effect (129-137).

Line 10 becomes:
```tsx
import { countLineFor, headingFor, imageCount, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
```
Line 45 becomes:
```tsx
  const photoCount = useMemo(() => imageCount(notes), [notes]);
```
Lines 85-110 (`commit`) become (only line 88 changes):
```tsx
  const commit = useCallback(
    async (note: Note, draft: string) => {
      setEditing((cur) => (cur === note.id ? null : cur));
      if (!draft.trim() && note.images.length === 0) {
        removeLocal(note.id);
        try {
          await deleteNote(note.id);
        } catch (e) {
          console.error('delete note failed', e);
        } finally {
          refetch();
        }
        return;
      }
      if (draft === note.body) return;
      upsertLocal({ ...note, body: draft, tags: tagsOf(draft), updated_at: new Date().toISOString() });
      try {
        upsertLocal(await updateNote(note.id, draft));
      } catch (e) {
        console.error('update note failed', e);
      } finally {
        refetch();
      }
    },
    [removeLocal, upsertLocal, refetch],
  );
```
Line 166 becomes:
```tsx
            <Gallery items={photos} copiedId={copied} onCopy={copy} />
```
`photos` (line 44, `photosOf(notes, active)`) is now `PhotoItem[]` and flows unchanged into `countLineFor` (line 157).
**Impact:** sidebar "N photos" counts images.

### Step 11: Test fixtures (new)
**File:** `web/src/testing/fixtures.ts` (create). Not matched by vitest's `web/src/**/*.test.tsx`; typechecked by `tsconfig.web.json` (`include: web/src`); never imported by app code, so not bundled.
**Code:**
```ts
import type { Note, NoteImage } from '../types';
import { tagsOf } from '../lib/text';

const ISO = '2026-10-30T01:00:00.000Z';

/** A wire `NoteImage` (600x400 JPEG on 'lenovo', available). `note_id` defaults to `id` (a note's first image). */
export function makeImage(id: string, over: Partial<NoteImage> = {}): NoteImage {
  const base: NoteImage = {
    id,
    note_id: id,
    position: 0,
    mime: 'image/jpeg',
    width: 600,
    height: 400,
    bytes: 1,
    taken_at: null,
    original_name: null,
    host: 'lenovo',
    available: true,
    urls: {
      thumb: `/api/images/${id}/thumb`,
      display: `/api/images/${id}/display`,
      original: `/api/images/${id}/original`,
      preview: `/api/images/${id}/preview`,
    },
  };
  return { ...base, ...over };
}

export type MakeNoteOpts = {
  /** Image ids (made with this note's id and positions 0..n-1) or ready images. */
  images?: Array<string | NoteImage>;
  /** Defaults to the body's hashtags. */
  tags?: string[];
  created?: string;
  /** Defaults to `created`. */
  updated?: string;
};

/** A wire `Note`. */
export function makeNote(id: string, body: string, opts: MakeNoteOpts = {}): Note {
  const created = opts.created ?? ISO;
  const images = (opts.images ?? []).map((im, i) => (typeof im === 'string' ? makeImage(im, { note_id: id, position: i }) : im));
  return {
    id,
    body,
    tags: opts.tags ?? tagsOf(body),
    created_at: created,
    updated_at: opts.updated ?? created,
    origin: null,
    images,
  };
}
```

### Step 12: `NoteImage.test.tsx`
**File:** `web/src/components/NoteImage.test.tsx` (whole file)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FILM_FILTER, NoteImage, aspectOf } from './NoteImage';
import { imageInfoUrl, imageUrl } from '../api';
import { makeImage } from '../testing/fixtures';

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

describe('NoteImage', () => {
  it('renders the thumb by image id with the film filter and aspect ratio', () => {
    const el = render(<NoteImage image={makeImage('M-N11', { note_id: 'K-F07', position: 1 })} variant="thumb" />);
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/images/M-N11/thumb');
    expect(img.style.filter).toBe(FILM_FILTER);
    expect(img.style.aspectRatio).toBe('600 / 400');
  });

  it('uses the display derivative for the modal variant', () => {
    const el = render(<NoteImage image={makeImage('K-F07')} variant="display" />);
    expect(el.querySelector('img')!.getAttribute('src')).toBe('/api/images/K-F07/display');
  });

  it('shows the placeholder with the host when the file is not on this machine', () => {
    const el = render(<NoteImage image={makeImage('K-F07', { available: false, host: 'lenovo' })} variant="thumb" />);
    expect(el.querySelector('img')).toBeNull();
    const ph = el.querySelector('[data-placeholder="image"]') as HTMLElement;
    expect(ph).not.toBeNull();
    expect(ph.textContent).toContain('not on this machine');
    expect(ph.textContent).toContain('lenovo');
    expect(ph.style.aspectRatio).toBe('600 / 400');
    expect(el.querySelector('button')).toBeNull();
  });

  it('omits the host line when the host is unknown', () => {
    const el = render(<NoteImage image={makeImage('K-F07', { available: false, host: null })} variant="display" />);
    const ph = el.querySelector('[data-placeholder="image"]')!;
    expect(ph.textContent).toBe('not on this machine');
  });

  it('falls back to an "unavailable" placeholder when the image errors', () => {
    const el = render(<NoteImage image={makeImage('K-F07')} variant="thumb" />);
    act(() => {
      el.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('unavailable');
  });

  it('a failed image does not hide the next one rendered in the same place', () => {
    const el = render(<NoteImage image={makeImage('K-F07')} variant="display" />);
    act(() => {
      el.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    act(() => root!.render(<NoteImage image={makeImage('M-N11')} variant="display" />));
    expect(el.querySelector('img')!.getAttribute('src')).toBe('/api/images/M-N11/display');
  });

  it('helpers', () => {
    expect(imageUrl('A-B32', 'original')).toBe('/api/images/A-B32/original');
    expect(imageUrl('A-B32', 'preview')).toBe('/api/images/A-B32/preview');
    expect(imageInfoUrl('A-B32')).toBe('/api/images/A-B32');
    expect(aspectOf({ width: 0, height: 0 }).css).toBe('3 / 2');
  });
});
```

### Step 13: `NoteCard.test.tsx`
**File:** `web/src/components/NoteCard.test.tsx` (whole file)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note } from '../types';
import { NoteCard } from './NoteCard';
import type { NoteCardProps } from './NoteCard';
import { makeNote } from '../testing/fixtures';

afterEach(cleanup);

const now = new Date();
function note(body: string, images: string[] = []): Note {
  return makeNote('A-B32', body, { images, tags: [], created: now.toISOString() });
}

function renderCard(n: Note, over: Partial<NoteCardProps> = {}) {
  const props = {
    note: n,
    now,
    editing: false,
    dim: false,
    used: false,
    copied: false,
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onCommit: vi.fn(),
    onToggleTag: vi.fn(),
    ...over,
  };
  return { ...render(<NoteCard {...props} />), props };
}

describe('NoteCard', () => {
  it('renders the font size by text length', () => {
    const cases: Array<[string, string[], string]> = [
      ['short #a', [], '26px'],
      ['a'.repeat(50), [], '17px'],
      ['a'.repeat(120), [], '13.5px'],
      ['a'.repeat(10), ['A-B32'], '13px'],
      ['a'.repeat(10), ['A-B32', 'M-N11'], '13px'],
    ];
    for (const [body, images, fs] of cases) {
      const { container, unmount } = renderCard(note(body, images));
      expect((container.querySelector('.card-text') as HTMLElement).style.fontSize).toBe(fs);
      unmount();
    }
  });

  it('renders tag chips; clicking one toggles the filter without entering edit', () => {
    const { container, props } = renderCard(note('#seer onboarding'));
    const chip = container.querySelector('.tagchip') as HTMLElement;
    expect(chip.textContent).toBe('#seer');
    fireEvent.click(chip);
    expect(props.onToggleTag).toHaveBeenCalledWith('seer');
    expect(props.onEdit).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.card-text') as HTMLElement);
    expect(props.onEdit).toHaveBeenCalledWith('A-B32');
  });

  it('shows id, copy button, relative date; marks copied', () => {
    const { container, getByLabelText, props } = renderCard(note('x'), { copied: true });
    expect(container.querySelector('.card-id')?.textContent).toBe('A-B32');
    expect(container.querySelector('.card-date')?.textContent).toBe('just now');
    expect(container.querySelector('.copied')?.className).toContain('on');
    fireEvent.click(getByLabelText('Copy ID'));
    expect(props.onCopy).toHaveBeenCalledWith('A-B32');
  });

  it('commits the draft on blur while editing', () => {
    const n = note('old');
    const { container, props } = renderCard(n, { editing: true });
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('old');
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.blur(ta);
    expect(props.onCommit).toHaveBeenCalledWith(n, '');
  });

  it('a text note has no cover', () => {
    const { container } = renderCard(note('just text'));
    expect(container.querySelector('.card-cover')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('article')!.className).not.toContain('img');
  });

  it('a one-image note shows that image as the cover with no count', () => {
    const { container } = renderCard(note('pic', ['A-B32']));
    const img = container.querySelector('.card-cover img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/images/A-B32/thumb');
    expect(img.style.aspectRatio).toBe('600 / 400');
    expect(container.querySelector('.card-count')).toBeNull();
    expect(container.querySelector('article')!.className).toContain('img');
  });

  it('a multi-image note shows images[0] as the cover and the count on it, as plain text', () => {
    const { container } = renderCard(note('pics', ['A-B32', 'M-N11', 'P-Q22']));
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/api/images/A-B32/thumb');
    const count = container.querySelector('.card-cover .card-count') as HTMLElement;
    expect(count.textContent).toBe('3');
    expect(count.tagName).toBe('SPAN');
    expect(container.querySelector('.card-cover button')).toBeNull();
  });
});
```

### Step 14: `Gallery.test.tsx`
**File:** `web/src/components/Gallery.test.tsx` (whole file)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gallery, galleryTile } from './Gallery';
import { photosOf } from '../lib/filter';
import { makeImage, makeNote } from '../testing/fixtures';

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

const notes = [
  makeNote('K-F07', 'two photos #walks', {
    images: [makeImage('K-F07', { width: 600, height: 400 }), makeImage('M-N11', { note_id: 'K-F07', position: 1, width: 400, height: 600 })],
  }),
  makeNote('A-B32', 'text only'),
  makeNote('D-P90', 'one photo', { images: [makeImage('D-P90', { width: 600, height: 800 })] }),
];

describe('galleryTile', () => {
  it('grow = w/h to 3 places, basis = round(w/h * 230)', () => {
    expect(galleryTile({ width: 600, height: 400 })).toEqual({ grow: '1.500', basis: 345, ar: '600 / 400' });
    expect(galleryTile({ width: 500, height: 700 })).toEqual({ grow: '0.714', basis: 164, ar: '500 / 700' });
    expect(galleryTile({ width: 600, height: 600 })).toEqual({ grow: '1.000', basis: 230, ar: '600 / 600' });
    expect(galleryTile({ width: 640, height: 427 }).basis).toBe(345);
  });
});

describe('Gallery', () => {
  it('renders one tile per image in note order, a trailing spacer, and opens the modal on the clicked image', () => {
    const el = render(<Gallery items={photosOf(notes, [])} copiedId={null} onCopy={() => {}} />);
    const section = el.querySelector('[data-gallery]')!;
    const tiles = Array.from(section.querySelectorAll('[data-photo]'));
    expect(tiles.map((t) => t.getAttribute('data-photo'))).toEqual(['K-F07', 'M-N11', 'D-P90']);
    expect(tiles.map((t) => t.getAttribute('data-note'))).toEqual(['K-F07', 'K-F07', 'D-P90']);
    expect(tiles[1].querySelector('img')!.getAttribute('src')).toBe('/api/images/M-N11/thumb');
    expect(section.lastElementChild!.hasAttribute('data-gallery-spacer')).toBe(true);
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
    act(() => {
      (el.querySelector('[data-photo="M-N11"]') as HTMLElement).click();
    });
    const modal = document.querySelector('[data-modal="photo"]')!;
    expect(modal).not.toBeNull();
    expect(modal.querySelector('[data-meta]')!.textContent).toBe('2 / 3  2/2  Today');
    expect(modal.querySelector('img')!.getAttribute('src')).toBe('/api/images/M-N11/display');
  });

  it('closes the modal when the open image leaves the list', () => {
    const items = photosOf(notes, []);
    const el = render(<Gallery items={items} copiedId={null} onCopy={() => {}} />);
    act(() => {
      (el.querySelector('[data-photo="M-N11"]') as HTMLElement).click();
    });
    act(() => root!.render(<Gallery items={items.filter((it) => it.image.id !== 'M-N11')} copiedId={null} onCopy={() => {}} />));
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
  });
});
```

### Step 15: `PhotoModal.test.tsx`
**File:** `web/src/components/PhotoModal.test.tsx` (whole file)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhotoModal, metaLine, stepIndex, stripTags } from './PhotoModal';
import { photosOf } from '../lib/filter';
import { makeNote } from '../testing/fixtures';

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

// 4 items: K-F07 (2 images: K-F07, M-N11), D-P90 (1), B-Y66 (1).
const items = photosOf(
  [
    makeNote('K-F07', 'River below the old bridge, 6:40am. Fog lifting. #walks #film', { images: ['K-F07', 'M-N11'] }),
    makeNote('D-P90', 'Pug on the tram again. #walks', { images: ['D-P90'] }),
    makeNote('B-Y66', '#film #kitchen', { images: ['B-Y66'] }),
  ],
  [],
);

function key(k: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

function modal(index: number, over: Partial<React.ComponentProps<typeof PhotoModal>> = {}) {
  render(<PhotoModal items={items} index={index} onIndex={() => {}} onClose={() => {}} copiedId={null} onCopy={() => {}} {...over} />);
  return document.querySelector('[data-modal="photo"]') as HTMLElement;
}

describe('stepIndex / stripTags / metaLine', () => {
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
  it('shows k/n only for multi-image notes', () => {
    expect(metaLine(2, 7, { k: 2, n: 3 }, 'Today')).toBe('3 / 7  2/3  Today');
    expect(metaLine(0, 1, { k: 1, n: 1 }, 'Today')).toBe('1 / 1  Today');
  });
});

describe('PhotoModal', () => {
  it('shows the note text without tags, tag chips, the note id, and meta with k/n', () => {
    const m = modal(0);
    expect(m.querySelector('p')!.textContent).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(m.textContent).toContain('#walks');
    expect(m.textContent).toContain('#film');
    expect(m.textContent).toContain('K-F07');
    expect(m.querySelector('[data-meta]')!.textContent).toBe('1 / 4  1/2  Today');
    expect(m.querySelector('img')!.getAttribute('src')).toBe('/api/images/K-F07/display');
  });

  it('the second image of a note shows that image, the same note, and 2/2', () => {
    const m = modal(1);
    expect(m.querySelector('img')!.getAttribute('src')).toBe('/api/images/M-N11/display');
    expect(m.querySelector('p')!.textContent).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(m.querySelector('[data-meta]')!.textContent).toBe('2 / 4  2/2  Today');
  });

  it('a single-image note has no k/n', () => {
    const m = modal(2);
    expect(m.querySelector('[data-meta]')!.textContent).toBe('3 / 4  Today');
    expect(m.textContent).toContain('D-P90');
  });

  it('arrow keys step image by image with wraparound; Escape closes and does not reach document listeners', () => {
    const onIndex = vi.fn();
    const onClose = vi.fn();
    const docEsc = vi.fn();
    document.addEventListener('keydown', docEsc);
    modal(0, { onIndex, onClose });
    key('ArrowLeft');
    expect(onIndex).toHaveBeenLastCalledWith(3);
    key('ArrowRight');
    expect(onIndex).toHaveBeenLastCalledWith(1);
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(docEsc).not.toHaveBeenCalled();
    key('a');
    expect(docEsc).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', docEsc);
  });

  it('Next steps from the last image of a note to the next note, and wraps from the end', () => {
    const onIndex = vi.fn();
    modal(1, { onIndex });
    act(() => (document.querySelector('[data-tip="Next"]') as HTMLElement).click());
    expect(onIndex).toHaveBeenLastCalledWith(2);
    act(() => root!.render(<PhotoModal items={items} index={3} onIndex={onIndex} onClose={() => {}} copiedId={null} onCopy={() => {}} />));
    act(() => (document.querySelector('[data-tip="Next"]') as HTMLElement).click());
    expect(onIndex).toHaveBeenLastCalledWith(0);
  });

  it('backdrop click closes; clicks on the image, panel and prev do not', () => {
    const onClose = vi.fn();
    const m = modal(1, { onClose });
    act(() => (m.querySelector('img') as HTMLElement).click());
    act(() => (m.querySelector('p') as HTMLElement).click());
    act(() => (m.querySelector('[data-tip="Previous"]') as HTMLElement).click());
    expect(onClose).not.toHaveBeenCalled();
    act(() => m.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copy copies the note id, "copied" follows copiedId, and full screen opens /full/<imageId>', () => {
    const onCopy = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const m = modal(1, { copiedId: 'K-F07', onCopy });
    act(() => (document.querySelector('[data-tip="Copy ID"]') as HTMLElement).click());
    expect(onCopy).toHaveBeenCalledWith('K-F07');
    expect(m.textContent).toContain('copied');
    act(() => (document.querySelector('[data-tip="Show full screen"]') as HTMLElement).click());
    expect(open).toHaveBeenCalledWith('/full/M-N11', '_blank', 'noopener');
  });
});
```

### Step 16: `filter.test.tsx`
**File:** `web/src/lib/filter.test.tsx` (whole file)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { countLineFor, hasImages, headingFor, imageCount, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './filter';
import { makeNote } from '../testing/fixtures';

const notes = [
  makeNote('A-AAA', '#seer #ux both'),
  makeNote('B-BBB', '#seer only'),
  makeNote('C-CCC', '#ux only'),
  makeNote('D-DDD', 'photos #seer #ux', { images: ['D-DDD', 'E-EE1', 'F-FF2'] }),
  makeNote('G-GGG', 'one photo #ux', { images: ['G-GGG'] }),
];

describe('visibleOnWall', () => {
  it('applies tag filters with AND semantics', () => {
    expect(visibleOnWall(notes, 'all', ['seer', 'ux']).map((n) => n.id)).toEqual(['A-AAA', 'D-DDD']);
    expect(visibleOnWall(notes, 'all', ['seer']).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'D-DDD']);
  });
  it('hides notes with images in text mode only', () => {
    expect(visibleOnWall(notes, 'text', []).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'C-CCC']);
    expect(visibleOnWall(notes, 'all', [])).toHaveLength(5);
  });
  it('always keeps the note being edited', () => {
    expect(visibleOnWall([...notes, makeNote('E-EEE', '')], 'text', ['seer'], 'E-EEE').map((n) => n.id)).toContain('E-EEE');
  });
});

describe('images', () => {
  it('hasImages and imageCount', () => {
    expect(hasImages(notes[0])).toBe(false);
    expect(hasImages(notes[3])).toBe(true);
    expect(imageCount(notes)).toBe(4);
    expect(imageCount([])).toBe(0);
  });
  it('photosOf flattens note by note, images in position order, with k/n per note', () => {
    const items = photosOf(notes, []);
    expect(items.map((it) => [it.image.id, it.note.id, it.k, it.n])).toEqual([
      ['D-DDD', 'D-DDD', 1, 3],
      ['E-EE1', 'D-DDD', 2, 3],
      ['F-FF2', 'D-DDD', 3, 3],
      ['G-GGG', 'G-GGG', 1, 1],
    ]);
    expect(items[1].note).toBe(notes[3]);
  });
  it('photosOf applies tag filters to the owning note', () => {
    expect(photosOf(notes, ['seer']).map((it) => it.image.id)).toEqual(['D-DDD', 'E-EE1', 'F-FF2']);
    expect(photosOf(notes, ['nope'])).toEqual([]);
  });
});

describe('modes and header', () => {
  it('cycles text → images → all → text', () => {
    expect(nextMode('text')).toBe('images');
    expect(nextMode('images')).toBe('all');
    expect(nextMode('all')).toBe('text');
  });
  it('picks the heading', () => {
    expect(headingFor('text', [])).toBe('Notes.');
    expect(headingFor('all', [])).toBe('Everything.');
    expect(headingFor('images', ['seer'])).toBe('Photos.');
    expect(headingFor('text', ['seer', 'ux'])).toBe('#seer #ux');
  });
  it('builds the count line per mode: photos count images, the rest count notes', () => {
    const textVis = visibleOnWall(notes, 'text', []);
    expect(countLineFor('text', [], notes, textVis, [])).toBe('3 notes, 2 photo notes hidden.');
    expect(countLineFor('all', [], notes, notes, [])).toBe('5 notes, 2 with photos.');
    expect(countLineFor('images', [], notes, [], photosOf(notes, []))).toBe('4 photos.');
    const tagged = visibleOnWall(notes, 'all', ['ux']);
    expect(countLineFor('all', ['ux'], notes, tagged, [])).toBe('4 of 5 notes.');
  });
  it('knows which notes a mode hides', () => {
    expect(isHiddenByMode(notes[0], 'images')).toBe(true);
    expect(isHiddenByMode(notes[3], 'text')).toBe(true);
    expect(isHiddenByMode(notes[0], 'text')).toBe(false);
    expect(isHiddenByMode(notes[3], 'all')).toBe(false);
    expect(isHiddenByMode(undefined, 'text')).toBe(false);
  });
  it('finds the last edited note by updated_at', () => {
    const list = [makeNote('A-AAA', 'x', { updated: '2026-10-29T10:00:00Z' }), makeNote('B-BBB', 'y', { updated: '2026-10-30T09:00:00Z' })];
    expect(lastEdited(list)?.id).toBe('B-BBB');
    expect(lastEdited([])).toBeNull();
  });
});
```

### Step 17: `FullscreenApp.test.tsx`
**File:** `web/src/fullscreen/FullscreenApp.test.tsx` (whole file; `viewReducer` tests unchanged, URLs move to image ids)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FullscreenApp, describeMissing, idFromLocation } from './FullscreenApp';
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

const jsonRes = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

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
  it('reads /full/<imageId> and falls back to ?id=', () => {
    expect(idFromLocation({ pathname: '/full/M-N11', search: '' })).toBe('M-N11');
    expect(idFromLocation({ pathname: '/full/A-B32/', search: '' })).toBe('A-B32');
    expect(idFromLocation({ pathname: '/fullscreen.html', search: '?id=K-F07' })).toBe('K-F07');
    expect(idFromLocation({ pathname: '/', search: '' })).toBeNull();
  });
});

describe('describeMissing', () => {
  it('reads the reason from the display route and the dims from GET /api/images/<id>', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/images/M-N11/display') return jsonRes({ error: 'not_found' }, 404);
      return jsonRes({ id: 'M-N11', note_id: 'K-F07', width: 400, height: 900 });
    }) as unknown as typeof fetch;
    expect(await describeMissing('M-N11', fetchImpl)).toEqual({ caption: 'not found', host: null, w: 400, h: 900 });
    expect(calls).toEqual(['/api/images/M-N11/display', '/api/images/M-N11']);
  });
  it('falls back to 3:2 when the image JSON has no dims', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'not_found' }, 404)) as unknown as typeof fetch;
    expect(await describeMissing('Z-Z99', fetchImpl)).toEqual({ caption: 'not found', host: null, w: 3, h: 2 });
  });
});

describe('FullscreenApp', () => {
  it('sets the title, shows the unfiltered display image by image id, click toggles fit, drag does not', () => {
    const el = render(<FullscreenApp id="M-N11" />);
    expect(document.title).toBe('M-N11');
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/images/M-N11/display');
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
      if (url === '/api/images/K-F07/display') return jsonRes({ error: 'not_on_this_machine', host: 'lenovo' }, 404);
      return jsonRes({ id: 'K-F07', note_id: 'K-F07', width: 600, height: 400 });
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

### Step 18: `App.test.tsx`
**File:** `web/src/App.test.tsx` — three hunks only. Phase 11 edits the chat tests in this same file concurrently; these hunks stay away from the chat tests (lines 81-135) so the merge is mechanical.

Hunk A — lines 4-20 (imports + fixture) become:
```tsx
import type { Note } from './types';
import { App } from './App';
import { makeNote } from './testing/fixtures';

const iso = new Date().toISOString();
const notes: Note[] = [
  makeNote('A-B32', '#seer onboarding is long', { created: iso }),
  makeNote('C-D45', 'buy fennel #kitchen', { created: iso }),
  makeNote('K-F07', 'River #walks', { created: iso, images: ['K-F07', 'M-N11'] }),
];
```
Hunk B — line 68 becomes:
```tsx
    expect(document.querySelector('[data-note="K-F07"] img')?.getAttribute('src')).toBe('/api/images/K-F07/thumb');
```
Hunk C — insert after line 69 (the closing `});` of "cycles modes …"), before "filters by a tag chip …":
```tsx

  it('counts images, shows one gallery tile per image, steps the modal within a note, and puts the count on the cover', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expect(screen.getByText(/2 notes, 1 photo notes hidden\./)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    expect(screen.getByText(/2 photos\./)).toBeTruthy();
    const tiles = Array.from(document.querySelectorAll('.gallery [data-photo]')).map((t) => t.getAttribute('data-photo'));
    expect(tiles).toEqual(['K-F07', 'M-N11']);
    fireEvent.click(document.querySelector('[data-photo="K-F07"]') as HTMLElement);
    expect(document.querySelector('[data-modal="photo"] [data-meta]')?.textContent).toContain('1 / 2  1/2');
    fireEvent.click(screen.getByLabelText('Next'));
    expect(document.querySelector('[data-modal="photo"] [data-meta]')?.textContent).toContain('2 / 2  2/2');
    expect(document.querySelector('[data-modal="photo"] img')?.getAttribute('src')).toBe('/api/images/M-N11/display');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    expect(document.querySelectorAll('[data-note="K-F07"] img')).toHaveLength(1);
    expect(document.querySelector('[data-note="K-F07"] .card-count')?.textContent).toBe('2');
  });
```
The `fetch` stub (`url.startsWith('/api/notes')`) is unchanged; thumbs are `<img>` loads, not fetches.

### Step 19: `DropOverlay.test.tsx` response fixtures
**File:** `web/src/components/DropOverlay.test.tsx:64`, `:93`, `:128`
**Change:** in each `okResponse({ note: { …, image: null }, … })`, replace `image: null` with `images: []`. Nothing else in the file or in `DropOverlay.tsx` changes.
**Code (the three lines after the edit):**
```tsx
    fetchMock.mockResolvedValue(okResponse({ note: { id: 'A-B32', body: '', tags: [], created_at: '', images: [] }, created: true }));
```
```tsx
    fetchMock.mockResolvedValue(okResponse({ note: { id: 'K-F07', body: '', tags: [], created_at: '', images: [] }, created: false }));
```
```tsx
    resolvers[0](okResponse({ note: { id: 'A-B32', body: '', tags: [], created_at: '', images: [] }, created: true }));
```

## Verification

**Build:** `npm run typecheck` (both `tsconfig.json` and `tsconfig.web.json`), then `npm run build` if available to confirm the main and fullscreen bundles build.
**Tests:** `npm test` (unit + all `web/src/**/*.test.tsx`). `npm run test:int` must stay green too (no server change here; run it per invariant 1).
**Grep gates (must print nothing):**
- `grep -rnE "\.image\b|image: null|ImageNote\b|NoteImageMeta" web/src --include='*.ts' --include='*.tsx'`
- `grep -rnE "/api/notes/[^\"'\`]*/(thumb|display|original|preview)" web/src`
- `grep -rn "thumbUrl\|displayUrl\|originalUrl" web/src`
**Manual check (against a phase-2 daemon):** a note with two images shows one cover and a small mono `2` bottom-right, no pill or shadow, legible on a bright photo; "Photos." shows both images as tiles; the modal meta reads `1 / N  1/2` then `2 / N  2/2`, then moves to the next note; "Show full screen" opens `/full/<imageId>` with that image; an old `/full/<noteId>` link still opens the note's first image.
**Exit criteria:** wall cover + count, gallery tile per image, modal steps image by image within a note then across notes and shows `k/n`, full screen by image id; typecheck, `npm test`, `npm run test:int` green; the three grep gates empty.

## Handoffs

- **Phase 7 (R2):** adds `ArrowsOutSimple` to `.card-meta` in `NoteCard.tsx`, `expanded` + attach handler to `App.tsx`, and `attachImage`/`removeImage` to the end of `api.ts` — all on top of this phase's versions of those files. `makeNote`/`makeImage` in `web/src/testing/fixtures.ts` are available for its tests. Phase 7 owns keeping the expanded note visible in `filter.ts` (`visibleOnWall` keepId already exists).
- **Phase 8 (R3):** the bin's image grid can reuse `NoteImage image={…}` and `galleryTile`; bin images use `imageUrl(id, 'thumb')` (the phase-2 route serves removed/deleted rows). Trash icon goes in the PhotoModal toolbar row (`justifyContent: 'flex-end'` div) and the card meta.
- **Phase 9 (R4):** `RevealButton({ image })` receives `PhotoItem.image` in the modal and `note.images[k]` elsewhere; `image.available` is on the wire type defined here.
- **Phase 10 (R5 docs):** README text for the cover count, gallery-per-image, modal `k/n`, and `/full/<imageId>`.
- **Phase 11:** `web/src/lib/text.ts` is not touched by this phase; `App.test.tsx` gets three hunks here (lines 4-20, 68, a new test after 69) — phase 11's chat-test edits further down merge cleanly.

## Rollback

Revert this phase's commit. The web goes back to reading `note.image`, which phase 2's server no longer sends, so a rollback of phase 6 alone leaves the web showing every note as text with no images (no crash: `!!note.image` is false). Roll back phase 2 together with it to restore images on the wall.
