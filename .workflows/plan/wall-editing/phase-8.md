# Phase 8: Web delete, undo, recycle bin view

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R3 (delete icon on card / editor / photo modal, quiet undo, "Deleted." bin with restore and inline-confirmed delete forever, tag filters, live-only sidebar counts), R5 (this phase's component tests)
**Depends on:** Phase 4 (bin, note restore, purge routes), Phase 7 (NoteEditor, `expanded`, `api.removeImage`), and through them Phases 3 and 6 (`POST /api/images/:id/restore`, wire `images[]`, `PhotoItem`, `NoteImage({ image })`, `PhotoModal({ items })`)
**Difficulty:** HARD
**Package:** `web/src`

---

## Goal

Every note card, the big editor and the photo modal get a `Trash` icon. Deleting is soft and asks nothing. For 6 s an undo label sits above the right end of the chat bar, and its `ArrowCounterClockwise` button brings the note back. Removing an image in the editor gets the same undo. A `Trash` icon on the rail (and in the expanded sidebar) switches the main area to the recycle bin: the giant heading `Deleted.`, a gallery-style grid of deleted images on top, and deleted-note cards below in wall style. Each entry has restore and delete forever. Delete forever is confirmed inline with two icons: `Check` (Delete forever) and `X` (Cancel). The active tag filters apply in the bin, and the sidebar's tags and counts still count live notes only.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `web/src/hooks/useUndo.ts`: `UNDO_MS = 6000`, `interface UndoEntry { label: string; run(): Promise<void> }`, `type UndoItem = UndoEntry & { seq: number }`, `interface UndoStore { entry; push; undo; dismiss }`, `function useUndo(ms?): UndoStore`
- `web/src/hooks/useBin.ts`: `interface BinStore { bin: Bin; loaded: boolean; error: string | null; refetch(); dropNote(id); dropImage(imageId) }`, `function useBin(active: string[], enabled: boolean): BinStore`. It opens its own `EventSource('/api/events')` only while `enabled` is true.
- `web/src/components/UndoBar.tsx` (+ `UndoBar.css`): `UndoBar({ entry, onUndo })` (fixed above the chat bar's right end; see Step 5)
- `web/src/components/Bin.tsx` (+ `Bin.css`): `Bin({ store, now, onRestored })`
- `web/src/api.ts` (appended): `fetchBin(tags)`, `restoreNote(id)`, `restoreImage(imageId)`, `purgeNote(id)`, `purgeImage(imageId)`, `type PurgeResult`, `class DuplicateImageError extends ApiError { noteId }`
- `web/src/types.ts` (appended): `interface BinImage`, `interface Bin` (mirror phase 4's wire types exactly), `type View = 'wall' | 'bin'`
- `web/src/lib/filter.ts` (appended): `BIN_HEADING = 'Deleted.'`, `binCountLine(bin, active)`
- `web/src/components/Rail.tsx`: `export const BIN_TIP: Record<View, string>`

**Signature changes (all additive):**
- `NoteCardProps` + `onDelete?: (note: Note) => void`: the Trash icon renders only when it is given.
- `WallProps` + `onDelete: (note: Note) => void` (required, since only App renders Wall).
- `GalleryProps` + `onDelete?: (note: Note) => void`, passed through to PhotoModal.
- `PhotoModalProps` + `onDelete?: (note: Note) => void`.
- `NoteEditorProps` (phase 7) + `onDelete?: (note: Note, draft: string) => void`.
- `RailProps` + `view: View`, `onToggleBin: () => void`.
- `SidebarProps` + `view: View`, `onToggleBin: () => void`.
- `HeaderProps` + `bin?: boolean`.
- App: new state `view`. The phase 7 remove-image handler passed to NoteEditor gets a new body and now pushes an undo entry (`removeImageWithUndo(image: NoteImage)`).

**Requires (from earlier phases):**
- Phase 4: `GET /api/bin?tag=a&tag=b` → `Bin` (tags parsed like `GET /api/notes`, AND semantics); `POST /api/notes/:id/restore` → `Note`, 409 `not_deleted` when the note is live; `DELETE /api/bin/notes/:id` and `DELETE /api/bin/images/:imageId` → `{ purged, files }` behind `sameOriginOnly` (the page's own `fetch` adds `Origin` to a DELETE).
- Phase 3: `POST /api/images/:imageId/restore` → `Note` / 409 `{ error: 'duplicate_image', note_id }`.
- Phase 2: `GET /api/images/:id/thumb` serves any existing row (removed images and images of deleted notes), which the bin grid needs.
- Phase 6: web `Note.images: NoteImage[]`, the web `NoteImage` interface (wire mirror, incl. `id`, `note_id`, `urls`, `deleted_at?`), `PhotoItem`, the component `NoteImage({ image, variant? })` (default variant `thumb`, default class `card-img`), `galleryTile({ width, height })` still exported from `Gallery.tsx`, `PhotoModal({ items, index, onIndex, onClose, copiedId, onCopy })`, `fontSizeFor(body, hasImage: boolean)` kept.
- Phase 7 (names confirmed against phase-7.md): `NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage })` with `onRemoveImage: (image: NoteImage) => void`; its toolbar is `<div className="ed-top">` (id, Copy, `copied`, `.ed-notice`, `.ed-spacer`, then the Close button with class `ed-btn`); internal `draft` state mirrored in `draftRef`; `closedRef`, set only by `close()`, makes a later blur a no-op. App (phase 7) has `expanded` / `setExpanded`, the synchronous mirrors `expandedRef` and `notesRef`, callbacks `save`, `commit`, `expand`, `closeEditor`, `removeImg`, `onAttached`, the `useNotice` hook, and imports the web `NoteImage` type as `NoteImageData`. `api.removeImage(imageId): Promise<Note>` and `api.attachImage` + `type AttachResult` exist. The card's expand icon is labelled `Expand note`, the strip remove icon (`.ed-rm`) `Remove image`. The test helper is `renderEditor(note: Note, over?: Partial<NoteEditorProps>)` → RTL result + `props` + `ta`, with `note(body, images?)` building note `A-B32`. Phase 7 never saves in an unmount cleanup: saving happens on blur (guarded by `closedRef`) and in App's `closeEditor`.

**Leaves alone (owned by others):**
- The server: everything under `src/**` and `tests/**` (phases 1–5).
- Reveal: `RevealButton`, `useCapabilities`, `fetchCapabilities`, `revealImage` (phase 9, which lands after this phase and mounts into the same toolbars).
- Chat (invariant 7, phase 11): the `<AnswerPanel …/>` and `<ChatBar …/>` JSX elements in `App.tsx`, `App.send`, the chat Esc effect, `ChatBar.tsx`, `ChatBar.css`, `AnswerPanel.tsx`, `useChat.ts`, and the `.answer*` / `.chatbar` / `.sendbtn` rules in `styles.css`. This phase only reads the `--chatbar-h` CSS variable that phase 11 publishes, with a `54px` fallback.
- `useNotes.ts` (unchanged; the bin has its own hook).
- `web/src/styles.css`: not edited. All new CSS lives in `Bin.css` and `UndoBar.css`, following the `PhotoModal.css` precedent, so no hunk can collide with phases 6, 7, 9 or 11.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/types.ts` | modify (append at end) | `BinImage`, `Bin`, `View` |
| `web/src/api.ts` | modify (append at end) | `fetchBin`, `restoreNote`, `restoreImage`, `purgeNote`, `purgeImage`, `PurgeResult`, `DuplicateImageError` |
| `web/src/lib/filter.ts` | modify (append at end + one import) | `BIN_HEADING`, `binCountLine` |
| `web/src/hooks/useUndo.ts` | create | undo entry with a 6 s timer |
| `web/src/hooks/useBin.ts` | create | bin fetch, tag-aware, refetch on SSE note events, optimistic drops |
| `web/src/components/UndoBar.tsx` | create | label plus icon button, fixed above the chat bar's right end |
| `web/src/components/UndoBar.css` | create | `right: 16px`, bottom from `--chatbar-h` |
| `web/src/components/Bin.tsx` | create | image grid, deleted-note cards, restore, inline-confirmed purge |
| `web/src/components/Bin.css` | create | bin grid / tile / card bits, `.copybtn:disabled` |
| `web/src/components/Rail.tsx` | modify (whole file) | `Trash` toggle, `BIN_TIP` |
| `web/src/components/Sidebar.tsx` | modify (whole file) | `Trash` toggle in side-modes; mode buttons not "on" while in the bin |
| `web/src/components/Header.tsx` | modify (whole file) | `bin` prop: no "Last edited", bin hint sentence |
| `web/src/components/NoteCard.tsx` | modify | `onDelete?` prop + Trash icon in the meta row |
| `web/src/components/Wall.tsx` | modify | `onDelete` pass-through |
| `web/src/components/Gallery.tsx` | modify | `onDelete?` pass-through to PhotoModal |
| `web/src/components/PhotoModal.tsx` | modify | `onDelete?` prop + Trash icon in the toolbar (deletes the note, closes) |
| `web/src/components/NoteEditor.tsx` | modify | `onDelete?` prop + Trash icon (`ed-btn`) in `.ed-top` before Close; sets `closedRef` then deletes the note with its draft |
| `web/src/App.tsx` | modify | `view`, `useUndo`, `useBin`, `removeNote`, `removeImageWithUndo` (replaces phase 7's `removeImg`), `onRestored`, `toggleBin`, `pickMode`; Rail / Sidebar / Header / main / NoteEditor / UndoBar wiring |
| `web/src/components/UndoBar.test.tsx` | create | undo label, 6 s, replace, run, failure logged |
| `web/src/components/Bin.test.tsx` | create | layout, restore (note, note tile, image, 409), delete-forever confirm + cancel, tag filter, SSE refetch, empty |
| `web/src/App.bin.test.tsx` | create | card delete → undo; bin via rail + sidebar; restore back to wall; editor remove-image → undo |
| `web/src/components/PhotoModal.delete.test.tsx` | create | modal Trash deletes the note and closes |
| `web/src/lib/binFilter.test.tsx` | create | `binCountLine` |
| `web/src/components/NoteCard.test.tsx` | modify (append two `it`s) | Trash icon calls `onDelete`; absent without it |
| `web/src/components/NoteEditor.test.tsx` | modify (append two `it`s) | Trash icon calls `onDelete(note, draft)`; absent without it |

## Implementation Steps

Line numbers below are today's (pre-phase-6/7). Phases 6 and 7 move them, so each step also names the landmark to anchor on.

### Step 1: Bin wire types
**File:** `web/src/types.ts`, append after the last line (today line 29, `export type Mode …`; after phase 6 the file ends with `PhotoItem` or `Mode`, so append at the end either way)
**Change:** mirror phase 4's `Bin` / `BinImage` and add the view type. `NoteImage` here is phase 6's wire interface in the same file.
**Code:**
```ts
/** Phase 4 wire: one tile of the bin's image grid. */
export interface BinImage {
  image: NoteImage;
  note_id: string;
  /** 'note': an image of a deleted note (actions act on the note). 'image': removed from a live note (actions act on the image). */
  kind: 'note' | 'image';
  deleted_at: string;
}

/** Phase 4 wire: `GET /api/bin`. Both lists newest `deleted_at` first. */
export interface Bin {
  notes: Note[];
  images: BinImage[];
}

/** What the main area shows: the wall (text / images / all modes) or the recycle bin. */
export type View = 'wall' | 'bin';
```
**Impact:** types only.

### Step 2: API calls for the bin, restore and purge
**File:** `web/src/api.ts`, append at the end of the file (today after line 71, `originalUrl`; after phases 6–7 after whatever is last, e.g. phase 7's `removeImage`). Extend the type import on line 1 to `import type { Bin, Note, TagCount } from './types';` (keep any names phases 6–7 added to that import).
**Code:**
```ts
/** `GET /api/bin?tag=a&tag=b` → deleted notes + deleted images, tag AND filter on the owning note. */
export async function fetchBin(tags: string[] = []): Promise<Bin> {
  const qs = tags.length ? '?' + tags.map((t) => `tag=${enc(t)}`).join('&') : '';
  const res = await check(await fetch(`/api/bin${qs}`));
  return (await res.json()) as Bin;
}

/** `POST /api/notes/:id/restore` → the live note. A note that is already live (409 not_deleted) is returned as it is. */
export async function restoreNote(id: string): Promise<Note> {
  const res = await fetch(`/api/notes/${enc(id)}/restore`, { method: 'POST' });
  if (res.status === 409) {
    const live = await check(await fetch(`/api/notes/${enc(id)}`));
    return (await live.json()) as Note;
  }
  await check(res);
  return (await res.json()) as Note;
}

/** 409 from `POST /api/images/:id/restore`: the same bytes already live in note `noteId`. */
export class DuplicateImageError extends ApiError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(409, 'duplicate_image');
    this.name = 'DuplicateImageError';
    this.noteId = noteId;
  }
}

/** `POST /api/images/:imageId/restore` → the owning note (restored too when it was deleted). */
export async function restoreImage(imageId: string): Promise<Note> {
  const res = await fetch(`/api/images/${enc(imageId)}/restore`, { method: 'POST' });
  if (res.status === 409) {
    const j = (await res.json().catch(() => null)) as { error?: string; note_id?: string } | null;
    if (j?.error === 'duplicate_image' && typeof j.note_id === 'string') throw new DuplicateImageError(j.note_id);
    throw new ApiError(409, j?.error ?? 'conflict');
  }
  await check(res);
  return (await res.json()) as Note;
}

export type PurgeResult = { purged: string; files: number };

// Purge is guarded by sameOriginOnly on the server. These requests go out from the page itself, so
// the browser adds the page's Origin header to the DELETE. Never call them from anywhere else.

/** `DELETE /api/bin/notes/:id`: delete a deleted note forever (rows, originals, derived files). */
export async function purgeNote(id: string): Promise<PurgeResult> {
  const res = await check(await fetch(`/api/bin/notes/${enc(id)}`, { method: 'DELETE' }));
  return (await res.json()) as PurgeResult;
}

/** `DELETE /api/bin/images/:imageId`: delete a removed image forever (row, original, derived files). */
export async function purgeImage(imageId: string): Promise<PurgeResult> {
  const res = await check(await fetch(`/api/bin/images/${enc(imageId)}`, { method: 'DELETE' }));
  return (await res.json()) as PurgeResult;
}
```
**Impact:** additive. `check`, `enc` and `ApiError` already exist in this file.

### Step 3: Bin heading and count line
**File:** `web/src/lib/filter.ts`. Add `Bin` to the type import on line 1 (today `import type { Mode, Note } from '../types';`; keep phase 6's names, e.g. `PhotoItem`). Append at the end of the file (today after line 59, `isHiddenByMode`).
**Code:**
```ts
export const BIN_HEADING = 'Deleted.';

/** The bin's count line. The tag filter is already applied by the server (`GET /api/bin?tag=`). */
export function binCountLine(bin: Bin, active: string[]): string {
  const base = `${bin.notes.length} deleted notes, ${bin.images.length} images`;
  return active.length ? `${base}, tagged ${active.map((t) => '#' + t).join(' ')}.` : `${base}.`;
}
```
**Impact:** additive.

### Step 4: `useUndo`
**File:** `web/src/hooks/useUndo.ts` (new)
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the undo label stays (R3: "a quiet undo … for a few seconds"). */
export const UNDO_MS = 6000;

export interface UndoEntry {
  /** Geist Mono label: `deleted A-B32`, `removed image`. */
  label: string;
  /** Reverses the action. A failure is logged, never shown. */
  run: () => Promise<void>;
}

/** `seq` changes on every push, so the bar re-mounts (and re-fades) for each new entry. */
export type UndoItem = UndoEntry & { seq: number };

export interface UndoStore {
  entry: UndoItem | null;
  /** Show `entry` for `ms`, replacing any entry still showing (that action simply stays done). */
  push: (entry: UndoEntry) => void;
  /** Run the current entry once and hide it. No-op when nothing is showing. */
  undo: () => void;
  dismiss: () => void;
}

export function useUndo(ms = UNDO_MS): UndoStore {
  const [entry, setEntry] = useState<UndoItem | null>(null);
  const current = useRef<UndoItem | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  const set = useCallback((e: UndoItem | null) => {
    current.current = e;
    setEntry(e);
  }, []);

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current);
    set(null);
  }, [set]);

  const push = useCallback(
    (e: UndoEntry) => {
      window.clearTimeout(timer.current);
      seq.current += 1;
      set({ ...e, seq: seq.current });
      timer.current = window.setTimeout(() => set(null), ms);
    },
    [ms, set],
  );

  const undo = useCallback(() => {
    const e = current.current;
    dismiss();
    if (e) void e.run().catch((err: unknown) => console.error('undo failed', err));
  }, [dismiss]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { entry, push, undo, dismiss };
}
```
**Impact:** new file.

### Step 5: `UndoBar` + its CSS
**File:** `web/src/components/UndoBar.tsx` (new)
**Code:**
```tsx
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import type { UndoItem } from '../hooks/useUndo';
import './UndoBar.css';

export interface UndoBarProps {
  entry: UndoItem | null;
  onUndo: () => void;
}

/**
 * Fixed above the right end of the chat bar: a Geist Mono label and one icon button, like the
 * "copied" label. Right-aligned so it stays clear of the answer panel, which is anchored at the
 * chat bar's left edge and at most 680px wide (phase 11 keeps that geometry).
 */
export function UndoBar({ entry, onUndo }: UndoBarProps) {
  if (!entry) return null;
  return (
    <div key={entry.seq} className="undo" role="status" data-undo="">
      <span className="undo-label">{entry.label}</span>
      <button type="button" className="copybtn" data-tip="Undo" aria-label="Undo" onClick={onUndo}>
        <ArrowCounterClockwise weight="duotone" />
      </button>
    </div>
  );
}
```

**File:** `web/src/components/UndoBar.css` (new)
**Code:**
```css
/* Phase 11 publishes the chat bar's live height as --chatbar-h; the bar sits 16px above the bottom,
   so this sits 8px above the bar's top edge, right-aligned with the bar (right: 16px). The answer
   panel (bottom: calc(var(--chatbar-h, 54px) + 32px)) is anchored at the bar's LEFT edge and is at
   most 680px wide, so the two never overlap on any window wider than about 1220px (sidebar open) /
   980px (rail only). Narrower than that, the undo label (z 65) stays on top of the panel (z 40) for
   its 6 s. z-index above the photo modal / editor (60) so an image removed in the editor can be
   undone there; below the drop overlay (70) and the tooltip (200). */
.undo {
  position: fixed;
  right: 16px;
  bottom: calc(var(--chatbar-h, 54px) + 24px);
  z-index: 65;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 3px 0 10px;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--line-14);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .03em;
  color: var(--dim);
  animation: undo-in .25s ease-out;
}
.undo-label { color: var(--id); white-space: nowrap; }
@keyframes undo-in { from { opacity: 0; } to { opacity: 1; } }
```
**Impact:** new files. `.copybtn` (existing, `styles.css:92`) gives the 13px round icon button.

### Step 6: `useBin`
**File:** `web/src/hooks/useBin.ts` (new)
**Change:** same load/debounce/generation pattern as `useNotes` (`web/src/hooks/useNotes.ts:33-86`), but keyed by the active tags and alive only while the bin is shown. It opens its own `EventSource`, so `useNotes` stays untouched.
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBin } from '../api';
import type { Bin } from '../types';

export interface BinStore {
  bin: Bin;
  loaded: boolean;
  error: string | null;
  /** Debounced (250 ms) refetch. No-op while disabled. */
  refetch: () => void;
  /** Optimistically drop a deleted note: its card and its 'note' tiles. */
  dropNote: (id: string) => void;
  /** Optimistically drop one tile by image id. */
  dropImage: (imageId: string) => void;
}

interface State {
  bin: Bin;
  loaded: boolean;
  error: string | null;
}

const EMPTY: Bin = { notes: [], images: [] };
const DEBOUNCE_MS = 250;
const SEP = '\u0000';

/** The recycle bin, fetched with the active tag filters, refetched on every SSE note event while `enabled`. */
export function useBin(active: string[], enabled: boolean): BinStore {
  const [state, setState] = useState<State>({ bin: EMPTY, loaded: false, error: null });
  // Bumped on every local drop; a fetch that started before a drop is discarded and retried.
  const gen = useRef(0);
  const refetchRef = useRef<() => void>(() => {});
  const tagKey = active.join(SEP);

  useEffect(() => {
    if (!enabled) return;
    const tags = tagKey === '' ? [] : tagKey.split(SEP);
    let alive = true;
    let inFlight = false;
    let again = false;
    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), DEBOUNCE_MS);
    };

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      const g = gen.current;
      try {
        const bin = await fetchBin(tags);
        if (!alive) return;
        if (gen.current === g) setState({ bin, loaded: true, error: null });
        else again = true;
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        inFlight = false;
        if (alive && again) {
          again = false;
          schedule();
        }
      }
    };

    refetchRef.current = schedule;
    void load();

    let es: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      es = new EventSource('/api/events');
      es.addEventListener('note', schedule);
      es.addEventListener('open', schedule);
    }

    return () => {
      alive = false;
      window.clearTimeout(timer);
      es?.close();
      refetchRef.current = () => {};
    };
  }, [enabled, tagKey]);

  const refetch = useCallback(() => refetchRef.current(), []);

  const dropNote = useCallback((id: string) => {
    gen.current += 1;
    setState((s) => ({
      ...s,
      bin: {
        notes: s.bin.notes.filter((n) => n.id !== id),
        images: s.bin.images.filter((b) => !(b.kind === 'note' && b.note_id === id)),
      },
    }));
  }, []);

  const dropImage = useCallback((imageId: string) => {
    gen.current += 1;
    setState((s) => ({ ...s, bin: { ...s.bin, images: s.bin.images.filter((b) => b.image.id !== imageId) } }));
  }, []);

  return { ...state, refetch, dropNote, dropImage };
}
```
**Impact:** new file. While the bin is open the page holds two SSE connections (this one and `useNotes`'). Both go to the same loopback origin, well under the browser's 6-per-host limit.

### Step 7: `Bin` component + CSS
**File:** `web/src/components/Bin.tsx` (new)
**Code:**
```tsx
import { useState, type ReactNode } from 'react';
import { ArrowCounterClockwise, Check, Trash, X } from '@phosphor-icons/react';
import type { BinImage, Note } from '../types';
import { DuplicateImageError, purgeImage, purgeNote, restoreImage, restoreNote } from '../api';
import type { BinStore } from '../hooks/useBin';
import { fontSizeFor, letterSpacingFor, segmentBody } from '../lib/text';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';
import { galleryTile } from './Gallery';
import './Bin.css';

/** What a bin entry's two actions act on. A tile of a deleted note acts on the note. */
type Target = { kind: 'note' | 'image'; id: string };

const keyOf = (t: Target): string => `${t.kind}:${t.id}`;

const targetOf = (b: BinImage): Target => (b.kind === 'note' ? { kind: 'note', id: b.note_id } : { kind: 'image', id: b.image.id });

interface BinActionsProps {
  what: 'note' | 'image';
  confirming: boolean;
  busy: boolean;
  onRestore: () => void;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Restore + delete forever; delete forever turns the pair into Check (Delete forever) + X (Cancel). Icons only. */
function BinActions({ what, confirming, busy, onRestore, onAsk, onConfirm, onCancel }: BinActionsProps) {
  if (confirming) {
    return (
      <span className="bin-actions" data-confirm="">
        <button type="button" className="copybtn" data-tip="Delete forever" aria-label="Delete forever" disabled={busy} onClick={onConfirm}>
          <Check weight="duotone" />
        </button>
        <button type="button" className="copybtn" data-tip="Cancel" aria-label="Cancel" onClick={onCancel}>
          <X weight="duotone" />
        </button>
      </span>
    );
  }
  return (
    <span className="bin-actions">
      <button type="button" className="copybtn" data-tip={`Restore ${what}`} aria-label={`Restore ${what}`} disabled={busy} onClick={onRestore}>
        <ArrowCounterClockwise weight="duotone" />
      </button>
      <button type="button" className="copybtn" data-tip={`Delete ${what} forever`} aria-label={`Delete ${what} forever`} disabled={busy} onClick={onAsk}>
        <Trash weight="duotone" />
      </button>
    </span>
  );
}

/** A deleted note in wall style: cover + count, read-only text with inert tag chips, id, deleted date, actions. */
function BinCard({ note, now, actions }: { note: Note; now: Date; actions: ReactNode }) {
  const n = note.images.length;
  const cover = note.images[0];
  const fs = fontSizeFor(note.body, n > 0);
  return (
    <article className={n > 0 ? 'card img' : 'card'} data-bin-note={note.id}>
      {cover && (
        <div className="card-cover">
          <NoteImage image={cover} />
          {n > 1 && (
            <span className="card-count" data-count={n}>
              {n}
            </span>
          )}
        </div>
      )}
      <div className="card-body">
        {note.body.trim() !== '' && (
          <p className="card-text bin-text" style={{ fontSize: fs, letterSpacing: letterSpacingFor(fs) }}>
            {segmentBody(note.body).map((s, i) =>
              s.kind === 'tag' ? (
                <span key={i} className="tagchip bin-tag">
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
          <span className="card-date">{note.deleted_at ? relativeDate(note.deleted_at, now) : ''}</span>
          {actions}
        </div>
      </div>
    </article>
  );
}

export interface BinProps {
  store: BinStore;
  now: Date;
  /** A note is live again (restore of the note, or of one of its images). App puts it back on the wall. */
  onRestored: (note: Note) => void;
}

/** "Deleted.": image grid (gallery style) on top, deleted-note cards (wall style) below, both newest-deleted first. */
export function Bin({ store, now, onRestored }: BinProps) {
  const { bin, loaded } = store;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});

  const restore = async (t: Target): Promise<void> => {
    const k = keyOf(t);
    setConfirming(null);
    setBusy(k);
    try {
      if (t.kind === 'note') {
        store.dropNote(t.id);
        onRestored(await restoreNote(t.id));
      } else {
        const note = await restoreImage(t.id);
        store.dropImage(t.id);
        onRestored(note);
      }
    } catch (e) {
      if (e instanceof DuplicateImageError) setNotices((m) => ({ ...m, [k]: `already in ${e.noteId}` }));
      else console.error('restore failed', e);
    } finally {
      setBusy(null);
      store.refetch();
    }
  };

  const purge = async (t: Target): Promise<void> => {
    setConfirming(null);
    setBusy(keyOf(t));
    try {
      if (t.kind === 'note') {
        store.dropNote(t.id);
        await purgeNote(t.id);
      } else {
        store.dropImage(t.id);
        await purgeImage(t.id);
      }
    } catch (e) {
      console.error('delete forever failed', e);
    } finally {
      setBusy(null);
      store.refetch();
    }
  };

  const actions = (t: Target): ReactNode => {
    const k = keyOf(t);
    return (
      <BinActions
        what={t.kind}
        confirming={confirming === k}
        busy={busy === k}
        onRestore={() => void restore(t)}
        onAsk={() => setConfirming(k)}
        onConfirm={() => void purge(t)}
        onCancel={() => setConfirming((c) => (c === k ? null : c))}
      />
    );
  };

  const empty = loaded && bin.notes.length === 0 && bin.images.length === 0;

  return (
    <section className="bin" data-bin="">
      {bin.images.length > 0 && (
        <div className="bin-grid">
          {bin.images.map((b) => {
            const t = targetOf(b);
            const g = galleryTile(b.image);
            const notice = notices[keyOf(t)];
            return (
              <div key={b.image.id} className="bin-tile" data-bin-image={b.image.id} data-kind={b.kind} style={{ flex: `${g.grow} 1 ${g.basis}px` }}>
                <NoteImage image={b.image} />
                <div className="card-meta bin-meta">
                  <span className="card-id">{b.note_id}</span>
                  <span>{b.kind}</span>
                  {notice && <span className="bin-notice">{notice}</span>}
                  {actions(t)}
                </div>
              </div>
            );
          })}
          <div className="bin-spacer" />
        </div>
      )}
      {bin.notes.length > 0 && (
        <section className="wall">
          {bin.notes.map((n) => (
            <BinCard key={n.id} note={n} now={now} actions={actions({ kind: 'note', id: n.id })} />
          ))}
        </section>
      )}
      {empty && <p className="bin-empty">Nothing deleted.</p>}
    </section>
  );
}
```

**File:** `web/src/components/Bin.css` (new)
**Code:**
```css
/* Recycle bin. Gallery tiles (Gallery.tsx) and wall cards (styles.css .card*) reused; hairlines, no shadows, square corners. */
.bin-grid { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 30px; }
.bin-tile { min-width: 0; background: var(--img-bg); }
.bin-meta { flex-wrap: wrap; padding: 6px 2px 6px 8px; background: var(--bg); }
.bin-meta .bin-actions { margin-left: auto; }
.bin-spacer { flex: 999 1 0px; }
.bin-actions { display: inline-flex; align-items: center; gap: 2px; }
.bin-text { cursor: default; }
.bin-tag, .bin-tag:hover { cursor: default; background: var(--chip-bg); color: var(--chip); }
.bin-notice { color: var(--fg); }
.bin-empty { margin: 30px 0 0; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.copybtn:disabled { opacity: .4; cursor: default; }
```
**Impact:** new files. The `.wall` class (`styles.css:78`) gives the masonry columns and 30px top padding below the grid.

### Step 8: Rail Trash toggle
**File:** `web/src/components/Rail.tsx` (whole file; phases 6 and 7 do not touch it)
**Code:**
```tsx
import { Images, NotePencil, SidebarSimple, SquaresFour, TextAa, Trash, XCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Mode, View } from '../types';
import { MODE_TIP } from '../lib/filter';

export const MODE_ICON: Record<Mode, Icon> = { text: TextAa, images: Images, all: SquaresFour };

/** Tooltip / label of the Trash toggle, by the view it is pressed from. */
export const BIN_TIP: Record<View, string> = { wall: 'Recycle bin', bin: 'Back to the wall' };

export interface RailProps {
  mode: Mode;
  view: View;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, view, active, onToggleSide, onAdd, onCycleMode, onToggleBin, onToggleTag, onClear }: RailProps) {
  const ModeIcon = MODE_ICON[mode];
  return (
    <nav className="rail">
      <button type="button" className="ibtn hov" data-tip="Toggle sidebar" data-tip-side="right" aria-label="Toggle sidebar" onClick={onToggleSide}>
        <SidebarSimple weight="duotone" />
      </button>
      <button type="button" className="ibtn hov" data-tip="New note" data-tip-side="right" aria-label="New note" onClick={onAdd}>
        <NotePencil weight="duotone" />
      </button>
      <button
        type="button"
        className={mode === 'text' ? 'ibtn' : 'ibtn on'}
        data-tip={`${MODE_TIP[mode]} (click to switch)`}
        data-tip-side="right"
        aria-label={`${MODE_TIP[mode]} (click to switch)`}
        onClick={onCycleMode}
      >
        <ModeIcon weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'bin' ? 'ibtn on' : 'ibtn hov'}
        data-tip={BIN_TIP[view]}
        data-tip-side="right"
        aria-label={BIN_TIP[view]}
        aria-pressed={view === 'bin'}
        onClick={onToggleBin}
      >
        <Trash weight="duotone" />
      </button>
      <div className="rail-sep" />
      {active.map((t) => (
        <button key={t} type="button" className="rail-chip" data-tip="Remove filter" data-tip-side="right" onClick={() => onToggleTag(t)}>
          #{t}
        </button>
      ))}
      {active.length > 0 && (
        <button type="button" className="ibtn hov clear" data-tip="Clear filters" data-tip-side="right" aria-label="Clear filters" onClick={onClear}>
          <XCircle weight="duotone" />
        </button>
      )}
    </nav>
  );
}
```
**Impact:** two new required props. Only App renders Rail.

### Step 9: Sidebar Trash toggle
**File:** `web/src/components/Sidebar.tsx` (whole file)
**Change:** add a Trash toggle after the three mode buttons, before the photo count. While in the bin, no mode button is "on". `photoCount` and the tag rows are unchanged: they come from `useNotes` (`GET /api/tags`), which counts live notes only (invariant 6).
**Code:**
```tsx
import { Trash } from '@phosphor-icons/react';
import type { Mode, TagCount, View } from '../types';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { BIN_TIP, MODE_ICON } from './Rail';

export interface SidebarProps {
  mode: Mode;
  view: View;
  photoCount: number;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
}

export function Sidebar({ mode, view, photoCount, tags, active, onMode, onToggleBin, onToggleTag }: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return (
    <aside className="side">
      <div className="side-modes">
        {MODE_ORDER.map((m) => {
          const I = MODE_ICON[m];
          return (
            <button
              key={m}
              type="button"
              className={view === 'wall' && m === mode ? 'ibtn on' : 'ibtn'}
              data-tip={MODE_TIP[m]}
              aria-label={MODE_TIP[m]}
              onClick={() => onMode(m)}
            >
              <I weight="duotone" />
            </button>
          );
        })}
        <button
          type="button"
          className={view === 'bin' ? 'ibtn on' : 'ibtn'}
          data-tip={BIN_TIP[view]}
          aria-label={BIN_TIP[view]}
          aria-pressed={view === 'bin'}
          onClick={onToggleBin}
        >
          <Trash weight="duotone" />
        </button>
        <span className="side-count">{photoCount} photos</span>
      </div>
      <div className="side-sep" />
      <div className="side-tags">
        {sorted.map((t) => (
          <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
            <span>#{t.tag}</span>
            <span className="n">{t.count}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
```
**Impact:** two new required props. Only App renders Sidebar. The side-modes row is 216px wide inside its padding. Four 40px buttons with 4px gaps take 172px, which leaves 44px for the `N photos` label. At 11px Geist Mono that fits up to about "99 photos". A longer label pushes `margin-left:auto` to zero and the label may wrap. If the implementer sees it wrap, add `white-space: nowrap` to `.side-count`. That would be a styles.css edit, so it goes in `Bin.css` as `.side-count { white-space: nowrap; }`.

### Step 10: Header bin mode
**File:** `web/src/components/Header.tsx` (whole file)
**Code:**
```tsx
import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  /** The recycle bin is showing: no "Last edited" link, and the hint explains the bin. */
  bin?: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, onJumpLast, onAdd }: HeaderProps) {
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {!bin && last && (
          <>
            {' '}Last edited{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onJumpLast();
              }}
            >
              {last.id}
            </a>{' '}
            {lastWhen}.
          </>
        )}{' '}
        {bin ? 'Restore brings a note or an image back. Delete forever removes it and its files.' : 'Drop or paste an image anywhere to make a photo note.'}
      </p>
      <h1>{heading}</h1>
      {showSticker && (
        <button type="button" className="sticker" data-tip="New note" aria-label="New note" onClick={onAdd}>
          <Plus weight="duotone" />
        </button>
      )}
    </header>
  );
}
```
**Impact:** optional prop. Existing call sites are unchanged.

### Step 11: Trash icon on the note card
**File:** `web/src/components/NoteCard.tsx`
**Change:**
1. Icon import (today line 2, `import { Check, Copy } from '@phosphor-icons/react';`, which phase 7 extends with `ArrowsOutSimple`): add `Trash` to it.
2. `NoteCardProps` (today lines 8–21): add the optional prop after `onCommit`:
```ts
  /** Soft delete, no confirmation (R3). Absent = no trash icon. */
  onDelete?: (note: Note) => void;
```
3. Destructure `onDelete` in `NoteCardImpl`'s parameter list (today line 46).
4. In the `.card-meta` row (today lines 76–92), insert this element **immediately after phase 7's expand (`ArrowsOutSimple`) button**, wherever phase 7 placed it, so the card's two actions sit together. If phase 7's expand button follows `.card-date`, the trash follows it too.
**Code:**
```tsx
          {onDelete && (
            <button
              type="button"
              className="copybtn"
              data-tip="Delete note"
              aria-label="Delete note"
              // Keep focus where it is: an open inline editor must not blur-commit (or empty-delete) the note being deleted.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(note);
              }}
            >
              <Trash weight="duotone" />
            </button>
          )}
```
**Impact:** an optional prop, so existing tests and helpers still compile. `memo` stays effective because App's `removeNote` is a stable `useCallback`.

### Step 12: Wall pass-through
**File:** `web/src/components/Wall.tsx`
**Change:** add `onDelete: (note: Note) => void;` to `WallProps` (today after line 13, `onCommit`), destructure it in `Wall(...)` (today line 17), and pass `onDelete={onDelete}` to `<NoteCard …>` (today after line 31, `onCommit={onCommit}`). Phase 7's `onExpand` stays as phase 7 wrote it.
**Code (the whole file after phases 7 and 8; only the three `onDelete` lines are new):**
```tsx
import type { Note } from '../types';
import { NoteCard } from './NoteCard';

export interface WallProps {
  notes: Note[];
  now: Date;
  editingId: string | null;
  /** null = no chat highlight; else the set of used ids. */
  usedIds: Set<string> | null;
  copiedId: string | null;
  onCopy: (id: string) => void;
  onEdit: (id: string) => void;
  onCommit: (note: Note, draft: string) => void;
  /** Soft delete from a card's trash icon (phase 8). */
  onDelete: (note: Note) => void;
  onToggleTag: (tag: string) => void;
  /** Open the big editor on a note (phase 7). */
  onExpand: (note: Note, draft: string | null) => void;
}

export function Wall({ notes, now, editingId, usedIds, copiedId, onCopy, onEdit, onCommit, onDelete, onToggleTag, onExpand }: WallProps) {
  return (
    <section className="wall">
      {notes.map((n) => (
        <NoteCard
          key={n.id}
          note={n}
          now={now}
          editing={editingId === n.id}
          dim={usedIds !== null && !usedIds.has(n.id)}
          used={usedIds !== null && usedIds.has(n.id)}
          copied={copiedId === n.id}
          onCopy={onCopy}
          onEdit={onEdit}
          onCommit={onCommit}
          onDelete={onDelete}
          onToggleTag={onToggleTag}
          onExpand={onExpand}
        />
      ))}
    </section>
  );
}
```
**Impact:** required prop. App is the only caller (Step 16).

### Step 13: Photo modal Trash
**File:** `web/src/components/PhotoModal.tsx`
**Change:**
1. Icon import (today line 2): add `Trash`.
2. Type import: `import type { Note } from '../types';` (phase 6 already imports `PhotoItem` from there; merge).
3. `PhotoModalProps` (today lines 39–46, phase 6's `items` version): add
```ts
  /** Soft-delete the shown photo's note (R3), then close. Absent = no trash icon. */
  onDelete?: (note: Note) => void;
```
4. Destructure `onDelete` in `PhotoModal(...)`.
5. In the toolbar row (today lines 119–129, the `div` with `justifyContent: 'flex-end'`), insert this button **immediately before the Close (`X`) button**. Phase 6 names the current item `item` and destructures it after the early return (`const { note, image } = item;`), so `note` is the shown photo's note.
**Code:**
```tsx
          {onDelete && (
            <button
              type="button"
              className="pm-btn"
              data-tip="Delete note"
              aria-label="Delete note"
              onClick={() => {
                onDelete(note);
                onClose();
              }}
              style={toolBtn}
            >
              <Trash weight="duotone" />
            </button>
          )}
```
**Impact:** the modal deletes the **note** that owns the shown image, not just the image (decision: the modal is a note's view; removing one image is the editor strip's job, R2). The tooltip says "note". The undo label then reads `deleted <id>`.

### Step 14: Gallery pass-through
**File:** `web/src/components/Gallery.tsx`
**Change:** add `onDelete?: (note: Note) => void;` to `GalleryProps` (today lines 19–23; import `type Note` from `'../types'`), destructure it in `Gallery(...)`, and pass `onDelete={onDelete}` on the `<PhotoModal …/>` element (today line 60).
**Code (the additions):**
```tsx
import type { Note } from '../types';
```
```tsx
  /** Passed to the photo modal's trash icon. */
  onDelete?: (note: Note) => void;
```
```tsx
            <PhotoModal items={items} index={index} onIndex={onIndex} onClose={onClose} copiedId={copiedId} onCopy={onCopy} onDelete={onDelete} />,
```
(Everything but `onDelete={onDelete}` is phase 6's line verbatim; phase 6's prop is `items`. Destructure `onDelete` next to `items, copiedId, onCopy` in `Gallery({ … })`.)
**Impact:** optional prop. Phase 6's Gallery tests still compile.

### Step 15: Editor Trash
**File:** `web/src/components/NoteEditor.tsx` (created by phase 7)
**Change:**
1. Add `Trash` to the `@phosphor-icons/react` import.
2. Props interface: add
```ts
  /** Soft-delete this note with the current draft, then close without the close-time save or empty rule (R3). Absent = no trash icon. */
  onDelete?: (note: Note, draft: string) => void;
```
3. Destructure `onDelete` (after `onRemoveImage`).
4. In `.ed-top`, insert this button **between `<span className="ed-spacer" />` and the Close button**, with the toolbar's icon-button class `ed-btn` (phase 7's Close uses it; `NoteEditor.css` sizes it, so no inline style).
**Code:**
```tsx
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
```
**Impact:** optional prop. Phase 7's tests still compile. App closes the editor by clearing `expanded` directly (and `expandedRef`), so phase 7's `closeEditor`, with its save, empty-note rule and Notes.→Everything. switch, does not run for a delete.

### Step 16: App wiring
**File:** `web/src/App.tsx`

**16a. Imports** (the whole import block after phase 7, phase-7.md Step 9a, with this phase's names added):
```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconContext } from '@phosphor-icons/react';
import { createNote, deleteNote, DuplicateImageError, removeImage, restoreImage, restoreNote, updateNote, type AttachResult } from './api';
import type { Mode, Note, NoteImage as NoteImageData, View } from './types';
import { useNotes } from './hooks/useNotes';
import { useChat } from './hooks/useChat';
import { useNow } from './hooks/useNow';
import { useCopied } from './hooks/useCopied';
import { useNotice } from './hooks/useNotice';
import { useUndo } from './hooks/useUndo';
import { useBin } from './hooks/useBin';
import { BIN_HEADING, binCountLine, countLineFor, headingFor, imageCount, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
import { extractUsedIds } from './lib/usedIds';
import { relativeDate } from './lib/dates';
import { tagsOf } from './lib/text';
import { Rail } from './components/Rail';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Wall } from './components/Wall';
import { AnswerPanel } from './components/AnswerPanel';
import { ChatBar } from './components/ChatBar';
import { Tooltip } from './components/Tooltip';
import { Gallery } from './components/Gallery';
import { DropOverlay } from './components/DropOverlay';
import { NoteEditor } from './components/NoteEditor';
import { Bin } from './components/Bin';
import { UndoBar } from './components/UndoBar';
```
(New in this phase: `DuplicateImageError`, `restoreImage`, `restoreNote`, `View`, `useUndo`, `useBin`, `BIN_HEADING`, `binCountLine`, `Bin`, `UndoBar`. `NoteImageData` is phase 7's alias. `removeImage` stays imported: `removeImageWithUndo` calls it.)

**16b. State** (right after phase 7's `const { notice, show: showNotice } = useNotice();`):
```tsx
  const [view, setView] = useState<View>('wall');
  const { entry: undoEntry, push: pushUndo, undo: runUndo } = useUndo();
  const binStore = useBin(active, view === 'bin');
```

**16c. `jump`** (today lines 58–69; phase 7 does not touch it). Replace the whole callback. Leaving the bin first means a used-note chip in the answer panel (its `onJump` prop is unchanged) still works from the bin.
```tsx
  const jump = useCallback(
    (id: string) => {
      const note = notes.find((n) => n.id === id);
      const leaving = view === 'bin';
      if (leaving) setView('wall');
      if (isHiddenByMode(note, mode)) {
        setMode('all');
        window.setTimeout(() => scrollToNote(id), 50);
      } else if (leaving) {
        window.setTimeout(() => scrollToNote(id), 50);
      } else {
        scrollToNote(id);
      }
    },
    [notes, mode, view],
  );
```

**16d. `addNote`** (today lines 71–83): add `setView('wall');` as the line right after `setEditing(n.id);`, so "+" from the rail while in the bin shows the new card.

**16e. `onImageAdded`** (today lines 112–119; phase 7 leaves it alone and puts attaches in the separate `onAttached`): add `setView('wall');` next to the existing `setMode((m) => (m === 'text' ? 'all' : m));`. A photo dropped while the bin is showing then appears on the wall.

**16f. New callbacks.** Insert after phase 7's `onAttached` (the last of phase 7's editor callbacks):
```tsx
  const toggleBin = useCallback(() => setView((v) => (v === 'bin' ? 'wall' : 'bin')), []);

  const pickMode = useCallback((m: Mode) => {
    setMode(m);
    setView('wall');
  }, []);

  /** Soft delete from a card, the editor (with its draft) or the photo modal. No confirmation; 6 s undo. */
  const removeNote = useCallback(
    (note: Note, draft?: string) => {
      setEditing((cur) => (cur === note.id ? null : cur));
      if (expandedRef.current === note.id) expandedRef.current = null;
      setExpanded((cur) => (cur === note.id ? null : cur));
      removeLocal(note.id);
      const done = (async () => {
        try {
          if (draft !== undefined && draft !== note.body) await updateNote(note.id, draft);
          await deleteNote(note.id);
        } catch (e) {
          console.error('delete note failed', e);
        } finally {
          refetch();
        }
      })();
      pushUndo({
        label: `deleted ${note.id}`,
        run: async () => {
          await done;
          upsertLocal(await restoreNote(note.id), true);
          refetch();
        },
      });
    },
    [removeLocal, upsertLocal, refetch, pushUndo],
  );

  /** The editor strip's remove icon (phase 7): soft remove one image, 6 s undo puts it back at its old position. */
  const removeImageWithUndo = useCallback(
    (image: NoteImageData) => {
      const owner = notesRef.current.find((n) => n.id === image.note_id);
      if (owner) upsertLocal({ ...owner, images: owner.images.filter((i) => i.id !== image.id) });
      const done = (async () => {
        try {
          upsertLocal(await removeImage(image.id));
        } catch (e) {
          console.error('remove image failed', e);
        } finally {
          refetch();
        }
      })();
      pushUndo({
        label: 'removed image',
        run: async () => {
          await done;
          try {
            upsertLocal(await restoreImage(image.id));
          } catch (e) {
            if (e instanceof DuplicateImageError) console.warn(`image already in ${e.noteId}`);
            else throw e;
          } finally {
            refetch();
          }
        },
      });
    },
    [upsertLocal, refetch, pushUndo],
  );

  /** A note restored from the bin goes back on the wall at once; the refetch puts it in its place. */
  const onRestored = useCallback(
    (note: Note) => {
      upsertLocal(note, true);
      refetch();
    },
    [upsertLocal, refetch],
  );
```
Delete phase 7's `removeImg` callback (phase-7.md Step 9d), which calls `removeImage` without undo. `removeImageWithUndo` replaces it, with the same optimistic upsert.

**16g. Rail JSX** (today lines 142–150):
```tsx
        <Rail
          mode={mode}
          view={view}
          active={active}
          onToggleSide={() => setSide((s) => !s)}
          onAdd={() => void addNote()}
          onCycleMode={() => {
            setMode(nextMode);
            setView('wall');
          }}
          onToggleBin={toggleBin}
          onToggleTag={toggleTag}
          onClear={() => setActive([])}
        />
```

**16h. Sidebar JSX** (today lines 151–153):
```tsx
        {side && (
          <Sidebar
            mode={mode}
            view={view}
            photoCount={photoCount}
            tags={tags}
            active={active}
            onMode={pickMode}
            onToggleBin={toggleBin}
            onToggleTag={toggleTag}
          />
        )}
```

**16i. Header JSX** (today lines 155–163). Keep phase 6's `countLineFor(...)` argument list as the wall branch:
```tsx
          <Header
            heading={view === 'bin' ? BIN_HEADING : headingFor(mode, active)}
            countLine={view === 'bin' ? binCountLine(binStore.bin, active) : countLineFor(mode, active, notes, visible, photos)}
            last={last}
            lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
            showSticker={view === 'wall' && mode !== 'images'}
            bin={view === 'bin'}
            onJumpLast={() => last && jump(last.id)}
            onAdd={() => void addNote()}
          />
```

**16j. Main content** (today lines 165–179, the `mode === 'images' ? <Gallery> : <Wall>` ternary). Wrap it in the bin branch, keep every prop phases 6–7 pass, and add the `onDelete` props:
```tsx
          {view === 'bin' ? (
            <Bin store={binStore} now={now} onRestored={onRestored} />
          ) : mode === 'images' ? (
            <Gallery items={photos} copiedId={copied} onCopy={copy} onDelete={removeNote} />
          ) : (
            <Wall
              notes={visible}
              now={now}
              editingId={editing}
              usedIds={usedSet}
              copiedId={copied}
              onCopy={copy}
              onEdit={setEditing}
              onCommit={commit}
              onDelete={removeNote}
              onToggleTag={toggleTag}
              onExpand={expand}
            />
          )}
```
(`items={photos}` is phase 6's Gallery prop; `onExpand={expand}` is phase 7's.)

**16k. NoteEditor JSX** (phase 7's portal, phase-7.md Step 9f) becomes:
```tsx
        {expandedNote &&
          createPortal(
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
            />,
            document.body,
          )}
```

**16l. UndoBar**: insert one line **immediately before `<Tooltip />`**, i.e. after phase 7's editor portal (today line 198). Do not put it next to `<ChatBar …/>` or `<AnswerPanel …/>` (invariant 7).
```tsx
        <UndoBar entry={undoEntry} onUndo={runUndo} />
```
**Impact:** App now has two views. The chat JSX, `send` and the chat Esc effect are untouched. `commit`'s empty-note auto-delete is unchanged and pushes no undo entry, since it removes an empty note nobody meant to keep.

### Step 17: Tests: undo
**File:** `web/src/components/UndoBar.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UNDO_MS, useUndo, type UndoStore } from '../hooks/useUndo';
import { UndoBar } from './UndoBar';

let store: UndoStore;
function Harness() {
  store = useUndo();
  return <UndoBar entry={store.entry} onUndo={store.undo} />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('UndoBar + useUndo', () => {
  it('renders nothing until something is pushed', () => {
    render(<Harness />);
    expect(document.querySelector('.undo')).toBeNull();
  });

  it('shows the Geist Mono label and an icon-only Undo button (placed by .undo in UndoBar.css, no inline left)', () => {
    render(<Harness />);
    act(() => store.push({ label: 'deleted A-B32', run: vi.fn(async () => {}) }));
    const bar = document.querySelector('.undo') as HTMLElement;
    expect(bar.textContent).toBe('deleted A-B32');
    expect(bar.style.left).toBe('');
    const btn = screen.getByRole('button', { name: 'Undo' });
    expect(btn.getAttribute('data-tip')).toBe('Undo');
    expect(btn.textContent).toBe('');
  });

  it('runs the entry once and hides when Undo is clicked', () => {
    const run = vi.fn(async () => {});
    render(<Harness />);
    act(() => store.push({ label: 'removed image', run }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.undo')).toBeNull();
  });

  it('disappears after 6 s without running', () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    render(<Harness />);
    act(() => store.push({ label: 'deleted A-B32', run }));
    act(() => {
      vi.advanceTimersByTime(UNDO_MS - 1);
    });
    expect(document.querySelector('.undo')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector('.undo')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('a new push replaces the previous entry and restarts the clock', () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    render(<Harness />);
    act(() => store.push({ label: 'deleted A-B32', run: first }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    act(() => store.push({ label: 'deleted C-D45', run: second }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(document.querySelector('.undo')?.textContent).toBe('deleted C-D45');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('logs a failed undo instead of throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Harness />);
    act(() =>
      store.push({
        label: 'deleted A-B32',
        run: async () => {
          throw new Error('offline');
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(err).toHaveBeenCalledWith('undo failed', expect.any(Error)));
  });
});
```

### Step 18: Tests: bin
**File:** `web/src/components/Bin.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { Bin as BinData, Note, NoteImage as NoteImageInfo } from '../types';
import { makeImage, makeNote } from '../testing/fixtures';
import { useBin } from '../hooks/useBin';
import { Bin } from './Bin';

const iso = '2026-10-30T01:00:00.000Z';

// Phase 6's shared fixtures (web/src/testing/fixtures.ts).
function img(id: string, noteId: string, position = 0): NoteImageInfo {
  return makeImage(id, { note_id: noteId, position, bytes: 10, original_name: `${id}.jpg` });
}

function note(id: string, body: string, tags: string[], images: NoteImageInfo[] = [], deleted = true): Note {
  const n = makeNote(id, body, { images, tags, created: iso });
  return deleted ? { ...n, deleted_at: iso } : n;
}

function fixture(): BinData {
  return {
    notes: [note('A-B32', '#seer onboarding is long', ['seer']), note('K-F07', 'River #walks', ['walks'], [img('K-F07', 'K-F07'), img('M-Q11', 'K-F07', 1)])],
    images: [
      { image: { ...img('R-T22', 'C-D45', 2), deleted_at: iso }, note_id: 'C-D45', kind: 'image', deleted_at: iso },
      { image: img('K-F07', 'K-F07'), note_id: 'K-F07', kind: 'note', deleted_at: iso },
      { image: img('M-Q11', 'K-F07', 1), note_id: 'K-F07', kind: 'note', deleted_at: iso },
    ],
  };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let current: BinData;
let calls: Array<{ url: string; method: string }>;
let override: ((url: string, method: string) => Response | undefined) | null;

function dropNoteFromCurrent(id: string) {
  current = { notes: current.notes.filter((n) => n.id !== id), images: current.images.filter((b) => !(b.kind === 'note' && b.note_id === id)) };
}
function dropImageFromCurrent(id: string) {
  current = { ...current, images: current.images.filter((b) => b.image.id !== id) };
}

beforeEach(() => {
  current = fixture();
  calls = [];
  override = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const o = override?.(url, method);
      if (o) return o;
      const id = decodeURIComponent(url.split('/')[3] ?? '');
      if (method === 'GET' && url.startsWith('/api/bin')) return json(current);
      if (method === 'POST' && /^\/api\/notes\/[^/]+\/restore$/.test(url)) {
        const n = current.notes.find((x) => x.id === id) ?? note(id, '', []);
        dropNoteFromCurrent(id);
        return json({ ...n, deleted_at: undefined });
      }
      if (method === 'POST' && /^\/api\/images\/[^/]+\/restore$/.test(url)) {
        dropImageFromCurrent(id);
        return json(note('C-D45', 'kitchen shelf', [], [img(id, 'C-D45', 2)], false));
      }
      if (method === 'DELETE' && url.startsWith('/api/bin/notes/')) {
        const nid = decodeURIComponent(url.split('/')[4] ?? '');
        dropNoteFromCurrent(nid);
        return json({ purged: nid, files: 2 });
      }
      if (method === 'DELETE' && url.startsWith('/api/bin/images/')) {
        const iid = decodeURIComponent(url.split('/')[4] ?? '');
        dropImageFromCurrent(iid);
        return json({ purged: iid, files: 1 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness({ active = [], onRestored = () => {} }: { active?: string[]; onRestored?: (n: Note) => void }) {
  const store = useBin(active, true);
  return <Bin store={store} now={new Date('2026-10-30T02:00:00.000Z')} onRestored={onRestored} />;
}

const tile = (id: string) => document.querySelector(`[data-bin-image="${id}"]`) as HTMLElement;
const card = (id: string) => document.querySelector(`[data-bin-note="${id}"]`) as HTMLElement;
const sent = (method: string, url: string) => calls.some((c) => c.method === method && c.url === url);

describe('Bin', () => {
  it('shows the image grid on top and deleted-note cards below, in the order served', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    const tiles = Array.from(document.querySelectorAll('[data-bin-image]')).map((e) => e.getAttribute('data-bin-image'));
    expect(tiles).toEqual(['R-T22', 'K-F07', 'M-Q11']);
    const cards = Array.from(document.querySelectorAll('[data-bin-note]')).map((e) => e.getAttribute('data-bin-note'));
    expect(cards).toEqual(['A-B32', 'K-F07']);
    const grid = document.querySelector('.bin-grid') as HTMLElement;
    expect(grid.compareDocumentPosition(card('A-B32')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tile('R-T22').querySelector('img')?.getAttribute('src')).toBe('/api/images/R-T22/thumb');
    expect(card('K-F07').querySelector('.card-count')?.textContent).toBe('2');
  });

  it("a deleted note's tile speaks of the note; a removed image's tile speaks of the image", async () => {
    render(<Harness />);
    await waitFor(() => expect(tile('K-F07')).not.toBeNull());
    expect(within(tile('K-F07')).getByRole('button', { name: 'Restore note' }).getAttribute('data-tip')).toBe('Restore note');
    expect(within(tile('K-F07')).getByRole('button', { name: 'Delete note forever' })).toBeTruthy();
    expect(within(tile('R-T22')).getByRole('button', { name: 'Restore image' })).toBeTruthy();
    expect(within(tile('R-T22')).getByRole('button', { name: 'Delete image forever' })).toBeTruthy();
    for (const b of Array.from(document.querySelectorAll('[data-bin] button'))) expect(b.textContent).toBe('');
  });

  it('restores a deleted note: POST restore, card gone, note handed to the wall', async () => {
    const onRestored = vi.fn();
    render(<Harness onRestored={onRestored} />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Restore note' }));
    expect(card('A-B32')).toBeNull();
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-B32' })));
    expect(sent('POST', '/api/notes/A-B32/restore')).toBe(true);
  });

  it("a deleted note's tile restores the whole note: its tiles and its card go", async () => {
    render(<Harness />);
    await waitFor(() => expect(tile('M-Q11')).not.toBeNull());
    fireEvent.click(within(tile('M-Q11')).getByRole('button', { name: 'Restore note' }));
    expect(tile('K-F07')).toBeNull();
    expect(tile('M-Q11')).toBeNull();
    expect(card('K-F07')).toBeNull();
    await waitFor(() => expect(sent('POST', '/api/notes/K-F07/restore')).toBe(true));
    expect(calls.some((c) => c.url.startsWith('/api/images/'))).toBe(false);
  });

  it('restores a removed image into its note', async () => {
    const onRestored = vi.fn();
    render(<Harness onRestored={onRestored} />);
    await waitFor(() => expect(tile('R-T22')).not.toBeNull());
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Restore image' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({ id: 'C-D45' })));
    expect(sent('POST', '/api/images/R-T22/restore')).toBe(true);
    expect(tile('R-T22')).toBeNull();
  });

  it('says quietly where the image already lives when restore is refused (409 duplicate_image)', async () => {
    override = (url, method) =>
      method === 'POST' && url === '/api/images/R-T22/restore' ? json({ error: 'duplicate_image', note_id: 'Z-Z99' }, 409) : undefined;
    const onRestored = vi.fn();
    render(<Harness onRestored={onRestored} />);
    await waitFor(() => expect(tile('R-T22')).not.toBeNull());
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Restore image' }));
    await waitFor(() => expect(tile('R-T22').textContent).toContain('already in Z-Z99'));
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('delete forever asks inline with Check + X; cancel puts restore/trash back and sends nothing', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete note forever' }));
    const confirm = within(card('A-B32')).getByRole('button', { name: 'Delete forever' });
    const cancel = within(card('A-B32')).getByRole('button', { name: 'Cancel' });
    expect(confirm.getAttribute('data-tip')).toBe('Delete forever');
    expect(cancel.getAttribute('data-tip')).toBe('Cancel');
    expect(confirm.textContent).toBe('');
    expect(within(card('A-B32')).queryByRole('button', { name: 'Restore note' })).toBeNull();
    fireEvent.click(cancel);
    expect(within(card('A-B32')).getByRole('button', { name: 'Restore note' })).toBeTruthy();
    expect(within(card('A-B32')).queryByRole('button', { name: 'Delete forever' })).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('confirming deletes a note forever', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete note forever' }));
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete forever' }));
    expect(card('A-B32')).toBeNull();
    await waitFor(() => expect(sent('DELETE', '/api/bin/notes/A-B32')).toBe(true));
  });

  it('confirming on a removed image deletes only that image forever', async () => {
    render(<Harness />);
    await waitFor(() => expect(tile('R-T22')).not.toBeNull());
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Delete image forever' }));
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(sent('DELETE', '/api/bin/images/R-T22')).toBe(true));
    expect(tile('R-T22')).toBeNull();
    expect(card('A-B32')).not.toBeNull();
  });

  it('only one entry asks at a time', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete note forever' }));
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Delete image forever' }));
    expect(within(card('A-B32')).getByRole('button', { name: 'Restore note' })).toBeTruthy();
    expect(within(tile('R-T22')).getByRole('button', { name: 'Delete forever' })).toBeTruthy();
  });

  it('sends the active tag filters to GET /api/bin and refetches when they change', async () => {
    const { rerender } = render(<Harness active={['seer']} />);
    await waitFor(() => expect(sent('GET', '/api/bin?tag=seer')).toBe(true));
    rerender(<Harness active={['seer', 'walks']} />);
    await waitFor(() => expect(sent('GET', '/api/bin?tag=seer&tag=walks')).toBe(true));
    rerender(<Harness active={[]} />);
    await waitFor(() => expect(sent('GET', '/api/bin')).toBe(true));
  });

  it('refetches on SSE note events and closes its EventSource when unmounted', async () => {
    class FakeES {
      static last: FakeES | null = null;
      closed = false;
      private l = new Map<string, Array<() => void>>();
      constructor(public url: string) {
        FakeES.last = this;
      }
      addEventListener(type: string, fn: () => void) {
        this.l.set(type, [...(this.l.get(type) ?? []), fn]);
      }
      close() {
        this.closed = true;
      }
      emit(type: string) {
        for (const fn of this.l.get(type) ?? []) fn();
      }
    }
    vi.stubGlobal('EventSource', FakeES);
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    expect(FakeES.last?.url).toBe('/api/events');
    current = { notes: [], images: [] };
    act(() => FakeES.last?.emit('note'));
    await waitFor(() => expect(document.querySelector('[data-bin-note]')).toBeNull(), { timeout: 2000 });
    expect(document.querySelector('.bin-empty')?.textContent).toBe('Nothing deleted.');
    unmount();
    expect(FakeES.last?.closed).toBe(true);
  });
});
```

### Step 19: Tests: App flows
**File:** `web/src/App.bin.test.tsx` (new). This file is separate from `App.test.tsx`, so it does not collide with the fixture edits phases 6, 7 and 11 make there.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bin, Note } from './types';
import { makeNote } from './testing/fixtures';
import { App } from './App';

const iso = new Date().toISOString();

// Phase 6's shared fixtures: makeNote builds images K-F07 (position 0) and M-Q11 (position 1) for note K-F07.
const textA: Note = makeNote('A-B32', '#seer onboarding is long', { created: iso });
const textC: Note = makeNote('C-D45', 'buy fennel #kitchen', { created: iso });
const photoK: Note = makeNote('K-F07', 'River #walks', { created: iso, images: ['K-F07', 'M-Q11'] });

let deleted: Set<string>;
let removedImages: Set<string>;
let calls: Array<{ url: string; method: string }>;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const withImages = (n: Note): Note => ({ ...n, images: n.images.filter((i) => !removedImages.has(i.id)) });
const live = () => [textA, textC, photoK].filter((n) => !deleted.has(n.id)).map(withImages);
const sent = (method: string, url: string) => calls.some((c) => c.method === method && c.url === url);

beforeEach(() => {
  deleted = new Set();
  removedImages = new Set();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const seg = url.split('/');
      if (method === 'GET' && url.startsWith('/api/notes')) return json({ notes: live(), next_cursor: null });
      if (method === 'GET' && url.startsWith('/api/tags')) return json([]);
      if (method === 'GET' && url.startsWith('/api/bin')) {
        const bin: Bin = { notes: [textA, textC, photoK].filter((n) => deleted.has(n.id)).map((n) => ({ ...n, deleted_at: iso })), images: [] };
        return json(bin);
      }
      if (method === 'DELETE' && url.startsWith('/api/notes/')) {
        deleted.add(seg[3] ?? '');
        return json({ ok: true });
      }
      if (method === 'POST' && /^\/api\/notes\/[^/]+\/restore$/.test(url)) {
        deleted.delete(seg[3] ?? '');
        return json(withImages([textA, textC, photoK].find((n) => n.id === seg[3]) as Note));
      }
      if (method === 'DELETE' && url.startsWith('/api/images/')) {
        removedImages.add(seg[3] ?? '');
        return json(withImages(photoK));
      }
      if (method === 'POST' && /^\/api\/images\/[^/]+\/restore$/.test(url)) {
        removedImages.delete(seg[3] ?? '');
        return json(withImages(photoK));
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wallCard = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;

describe('App: delete, undo, bin', () => {
  it('deletes a note from its card without asking; undo brings it back', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(within(wallCard('A-B32') as HTMLElement).getByRole('button', { name: 'Delete note' }));
    expect(wallCard('A-B32')).toBeNull();
    await waitFor(() => expect(sent('DELETE', '/api/notes/A-B32')).toBe(true));
    expect(document.querySelector('.undo')?.textContent).toBe('deleted A-B32');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(wallCard('A-B32')).not.toBeNull());
    expect(sent('POST', '/api/notes/A-B32/restore')).toBe(true);
    expect(document.querySelector('.undo')).toBeNull();
  });

  it('the rail trash opens "Deleted." with the deleted note; restore puts it back on the wall', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(within(wallCard('A-B32') as HTMLElement).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(sent('DELETE', '/api/notes/A-B32')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    const binCard = await waitFor(() => {
      const el = document.querySelector('[data-bin-note="A-B32"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(screen.getByText(/1 deleted notes, 0 images\./)).toBeTruthy();
    expect(document.querySelector('.sticker')).toBeNull();
    fireEvent.click(within(binCard).getByRole('button', { name: 'Restore note' }));
    await waitFor(() => expect(sent('POST', '/api/notes/A-B32/restore')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the wall' }));
    expect(h1()).toBe('Notes.');
    await waitFor(() => expect(wallCard('A-B32')).not.toBeNull());
  });

  it('the sidebar trash toggles the bin as well; the sidebar keeps its live counts', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getByLabelText('Toggle sidebar'));
    const side = document.querySelector('.side') as HTMLElement;
    const before = side.querySelector('.side-count')?.textContent;
    fireEvent.click(within(side).getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    await waitFor(() => expect(sent('GET', '/api/bin')).toBe(true));
    expect(side.querySelector('.side-count')?.textContent).toBe(before);
    fireEvent.click(within(side).getByRole('button', { name: 'Back to the wall' }));
    expect(h1()).toBe('Notes.');
  });

  it('passes the active tag filter to the bin', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(document.querySelector('[data-note="A-B32"] .tagchip') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    await waitFor(() => expect(sent('GET', '/api/bin?tag=seer')).toBe(true));
    expect(screen.getByText(/tagged #seer\./)).toBeTruthy();
  });

  it("removing an image in the editor can be undone (phase 7's Expand note / Remove image labels)", async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    await waitFor(() => expect(wallCard('K-F07')).not.toBeNull());
    fireEvent.click(within(wallCard('K-F07') as HTMLElement).getByRole('button', { name: 'Expand note' }));
    const removes = await screen.findAllByRole('button', { name: 'Remove image' });
    fireEvent.click(removes[1] as HTMLElement);
    await waitFor(() => expect(sent('DELETE', '/api/images/M-Q11')).toBe(true));
    expect(document.querySelector('.undo')?.textContent).toBe('removed image');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sent('POST', '/api/images/M-Q11/restore')).toBe(true));
  });
});
```

### Step 20: Tests: modal, card, editor trash; bin count line
**File:** `web/src/components/PhotoModal.delete.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Note, PhotoItem } from '../types';
import { makeNote } from '../testing/fixtures';
import { PhotoModal } from './PhotoModal';

afterEach(cleanup);

const note: Note = makeNote('K-F07', 'River #walks', { images: ['K-F07'] });
const image = note.images[0]!;
const items: PhotoItem[] = [{ note, image, k: 1, n: 1 }];

const base = { items, index: 0, onIndex: () => {}, copiedId: null, onCopy: () => {} };

describe('PhotoModal trash', () => {
  it("deletes the shown photo's note and closes", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<PhotoModal {...base} onClose={onClose} onDelete={onDelete} />);
    const btn = screen.getByRole('button', { name: 'Delete note' });
    expect(btn.getAttribute('data-tip')).toBe('Delete note');
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith(note);
    expect(onClose).toHaveBeenCalled();
  });

  it('has no trash icon without onDelete', () => {
    render(<PhotoModal {...base} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Delete note' })).toBeNull();
  });
});
```

**File:** `web/src/components/NoteCard.test.tsx`. Append these two cases inside the existing `describe('NoteCard', …)` block, before its closing `});`. They use the file's `renderCard` / `note` helpers, in whatever shape phase 6/7 left them.
**Code:**
```tsx
  it('the trash icon deletes the note without entering edit', () => {
    const onDelete = vi.fn();
    const n = note('hello');
    const { container, props } = renderCard(n, { onDelete });
    const btn = container.querySelector('[aria-label="Delete note"]') as HTMLButtonElement;
    expect(btn.getAttribute('data-tip')).toBe('Delete note');
    expect(btn.textContent).toBe('');
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith(n);
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('has no trash icon without onDelete', () => {
    const { container } = renderCard(note('hello'));
    expect(container.querySelector('[aria-label="Delete note"]')).toBeNull();
  });
```

**File:** `web/src/components/NoteEditor.test.tsx` (phase 7). Append inside `describe('NoteEditor', …)`, using phase 7's helpers `renderEditor(note, over)` (returns the RTL result plus `props` and `ta`) and `note(body, images?)`.
**Code:**
```tsx
  it('the trash icon deletes the note with the current draft', () => {
    const onDelete = vi.fn();
    const { container, props, ta } = renderEditor(note('first line'), { onDelete });
    fireEvent.change(ta, { target: { value: 'three paragraphs later' } });
    const btn = container.ownerDocument.querySelector('[aria-label="Delete note"]') as HTMLButtonElement;
    expect(btn.getAttribute('data-tip')).toBe('Delete note');
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith(props.note, 'three paragraphs later');
  });

  it('has no trash icon without onDelete', () => {
    const { container } = renderEditor(note('first line'));
    expect(container.ownerDocument.querySelector('[aria-label="Delete note"]')).toBeNull();
  });
```

**File:** `web/src/lib/binFilter.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import type { Bin } from '../types';
import { BIN_HEADING, binCountLine } from './filter';

const bin = (notes: number, images: number): Bin => ({
  notes: Array.from({ length: notes }, () => ({}) as Bin['notes'][number]),
  images: Array.from({ length: images }, () => ({}) as Bin['images'][number]),
});

describe('bin heading and count line', () => {
  it('heads the bin "Deleted."', () => {
    expect(BIN_HEADING).toBe('Deleted.');
  });
  it('counts deleted notes and images', () => {
    expect(binCountLine(bin(3, 5), [])).toBe('3 deleted notes, 5 images.');
  });
  it('names the active tags', () => {
    expect(binCountLine(bin(1, 0), ['seer', 'ux'])).toBe('1 deleted notes, 0 images, tagged #seer #ux.');
  });
});
```

## Verification

**Build:** `npm run typecheck && npm run build:web`
**Tests:** `npm test` (all web component tests run under jsdom by pragma). `npm run test:int` should be unaffected, since there are no server changes, but run it because invariant 1 requires it.
**Manual check:** `npm run dev:web` against a daemon with phases 2–4 deployed (or the worktree's `npm run dev`), then:
1. Delete a note from its card. It vanishes, and the label `deleted X-XXX` with the undo icon appears above the right end of the chat bar. Click undo and the card returns. With an answer panel open, the label sits to the right of the panel, not over it.
2. Delete it again and open the rail trash. The heading reads `Deleted.` and the card is listed. Restore it and it is back on the wall.
3. Expand a note with two images and remove one. The `removed image` undo shows above the editor. Let it time out, then open the bin: the image is in the grid. Restore it and it is back in the note at its old position.
4. In the bin, click delete forever on a note. The icons turn into Check + X. Cancel restores the two icons. Confirm sends `DELETE /api/bin/notes/:id` with an `Origin` header (check DevTools: it must be 200, not 403).
5. Activate a tag and open the bin: the request carries `?tag=`, and the sidebar counts do not change.
6. With the answer panel open, the undo label must not cover the chat bar. A tall multi-line chat bar (phase 11) must push the label up.
**Exit criteria:** every R3 acceptance step in the brief works through the component tests above. Covered there: card delete → gone → undo → back; delete → in "Deleted." → restore → back; remove image in editor → undo; delete forever asks first with Check / X and cancels cleanly; bin tag filter; image grid above note cards. `npm run typecheck`, `npm test` and `npm run test:int` are green.

## Handoffs

- **Phase 9 (reveal):** mounts `RevealButton` into the same three places this phase adds a Trash icon to: the card meta row, the PhotoModal toolbar and the NoteEditor toolbar (strip). Suggested order in each toolbar: …, reveal, trash, close. Phase 9 may also want the folder icon on bin tiles. That is not in R4 ("photo cards, the photo modal and the editor's image strip"), so this phase does not add it.
- **Phase 10 (docs, R5):** README text for the delete icon, undo, the `Deleted.` view (rail / sidebar trash), delete forever being UI-only, and the API table rows for `GET /api/bin`, `POST /api/notes/:id/restore`, `DELETE /api/bin/notes/:id`, `DELETE /api/bin/images/:id`.
- **Phase 6 (cover count, reconciled):** `BinCard` reuses phase 6's `.card-cover` / `.card-count` markup and CSS (`styles.css`, phase-6.md Steps 5–6), so a deleted note's card looks exactly like its wall card; `Bin.css` defines no count rule.
- **Phase 7 (reconciled):** every phase-7 name used here is confirmed against phase-7.md: `onRemoveImage`, `removeImg` (deleted here), `expand`, `closeEditor`, `expandedRef`, `notesRef`, `NoteImageData`, the `Expand note` and `Remove image` labels, `renderEditor(note, over)`, `.ed-top` / `.ed-btn`, and `closedRef`. Phase 7 never saves in an unmount cleanup; Step 15 sets `closedRef` before the delete so a blur on unmount is a no-op.
- **Phase 9 (R4):** mounts `RevealButton` in the card meta row (after the `copied` span), the modal toolbar (after Copy ID) and the editor strip (before `.ed-rm`); it does not touch the Trash buttons.
- **Phase 11:** the UndoBar reads `var(--chatbar-h, 54px)` and sits at `right: 16px`; the answer panel stays left-anchored and ≤ 680px wide, so they do not overlap (index Decisions).
- **Not done here (drive-bys):** Esc does not cancel an inline delete-forever confirm. Ctrl+Z does not trigger undo. Neither is in R3.

## Rollback

Revert this phase's commit. The new files (`useUndo.ts`, `useBin.ts`, `UndoBar.*`, `Bin.*`, the four new test files) go away, and the additive props on NoteCard / Wall / Gallery / PhotoModal / NoteEditor / Rail / Sidebar / Header and the App wiring revert with them. No server or data change is involved. The server's bin routes from phase 4 stay and remain reachable over HTTP.
