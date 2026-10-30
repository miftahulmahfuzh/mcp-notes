> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 7. Source: `.workflows/plan/wall-editing/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: Web big editor modal + attach on drop/paste

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R2 (big editor: expand icon, save on blur/close, Esc, drop/paste attaches, Notes.→Everything. on close, empty rule on close only), R5 (component tests for every R2 bullet)
**Depends on:** Phase 3 (`POST /api/notes/:id/images` → `AttachResult`, `DELETE /api/images/:id` → `Note`), Phase 6 (web on `images[]`)
**Difficulty:** HARD
**Package:** `web/src`

---

## Goal

Every wall card gets an `ArrowsOutSimple` icon that opens a large modal editor on that same note: a wide, tall Host Grotesk textarea, the note id with copy-id, live tag chips, and the note's images as a thumbnail strip with a per-image remove icon. While it is open, dropped or pasted images attach to that note (the drop overlay shows `Paperclip`), a dedupe hit is reported quietly in the editor, the note can't vanish from the wall, and an emptied note is only deleted on close. Closing applies the existing empty-note rule and switches Notes. to Everything. when the note now has images.

## Assumptions (state after phases 3 and 6)

Code facts checked against the worktree at `920b419`. The analysis's line numbers for `App.tsx` are stale; the numbers below come from the code.

1. **`web/src/types.ts` (phase 6)** exports the wire `NoteImage` interface (`id, note_id, position, mime, width, height, bytes, taken_at, original_name, host, available, urls{thumb,display,original,preview}, deleted_at?`) and `Note.images: NoteImage[]`. `Note.image` is gone. This phase imports it as `import type { NoteImage as NoteImageData } from '../types'` so it doesn't clash with the `NoteImage` component.
2. **`web/src/components/NoteImage.tsx` (phase 6)** exports the component `NoteImage({ image, variant = 'thumb', className, style, onClick })`, where `image: NoteImage` is a wire image and the `<img>` src comes from the image's id/urls. It still exports `aspectOf({width,height})`. If phase 6 names the prop differently, change only the one `<NoteImage image={img} …/>` line in `NoteEditor.tsx`.
3. **`web/src/App.tsx` (phase 6)**: `commit` tests `note.images.length === 0` instead of `!note.image`. Everything else this phase touches (imports, `editing` state, `visible` memo, `commit`, `onImageAdded`, the `<Wall>` and `<DropOverlay>` JSX) has the shape it has today.
4. **`web/src/components/NoteCard.tsx` (phase 6)** renders the cover from `note.images[0]`, plus the Geist Mono count when `images.length > 1`. `hasImg` is `note.images.length > 0`. This phase does not touch the cover markup.
5. **`web/src/lib/filter.ts` (phase 6)** exports `hasImages(n) = n.images.length > 0`, and `visibleOnWall` uses it. The `filter.test.tsx` helper `note(id, body, { image?: boolean })` still exists and now produces `images: [img]` / `[]`.
6. **`web/src/api.ts` (phase 6)** has its image-URL helpers keyed by image id. This phase only appends two functions and one interface at the end.
7. **Server (phase 3)**: `POST /api/notes/:id/images` (multipart `file`) → 201 `{note, attached: true}`, 200 `{note, attached: false}` (the bytes already live in `note`, which may be another note; a deleted holder is restored), 404 when the note is not live. `DELETE /api/images/:imageId` → 200 owner `Note` with that image gone from `images`.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `NoteEditor`, `NoteEditorProps` (`web/src/components/NoteEditor.tsx`, new)
- `web/src/components/NoteEditor.css` (new; classes `.ed`, `.ed-panel`, `.ed-top`, `.ed-id`, `.ed-notice`, `.ed-spacer`, `.ed-btn`, `.ed-text`, `.ed-tags`, `.ed-tag`, `.ed-strip`, `.ed-thumb`, `.ed-rm`)
- `useNotice(ms?)` → `{ notice: string | null; show(text) }` (`web/src/hooks/useNotice.ts`, new)
- `AttachResult = { note: Note; attached: boolean }`, `attachImage(noteId, file): Promise<AttachResult>`, `removeImage(imageId): Promise<Note>` (`web/src/api.ts`, appended)
- App state `expanded: string | null` (+ `expandedRef`, `notesRef`), App callbacks `save`, `expand`, `closeEditor`, `removeImg`, `onAttached`
- DOM hooks other phases and tests rely on: `[data-modal="editor"]` (editor backdrop), `.ed-top` (editor toolbar row: phase 8 adds its `Trash` before the Close button), `.ed-thumb[data-image="<imageId>"]` (strip tile: phase 9 adds `RevealButton` inside it, before the `.ed-rm` remove button), `.ed-btn` (toolbar icon-button class), `.ed-rm` (strip remove button, `aria-label="Remove image"`), `[data-notice]`, `[data-drop-overlay="attach"|"new"]`, card meta button `aria-label="Expand note"` / `data-tip="Expand note"` (not plain "Expand": phase 11's collapsed answer panel has its own "Expand" caret)

**Signature changes:**
- `NoteCardProps` gains `onExpand: (note: Note, draft: string | null) => void` (required)
- `WallProps` gains `onExpand: (note: Note, draft: string | null) => void` (required)
- `DropOverlayProps` gains `target?: string | null` and `onAttached?: (result: AttachResult, target: string) => void` (both optional; existing callers unaffected)
- `visibleOnWall(notes, mode, active, keepId: string | null = null)` becomes `visibleOnWall(notes, mode, active, keep: string | null | ReadonlyArray<string | null> = null)` (backward compatible)
- `App.commit(note, draft)` keeps its signature. Its "update if changed" half moves into the new `save(note, draft)`, and it returns early when the note is the one open in the big editor.

**Requires (from earlier phases):**
- Phase 6: `Note.images`, the wire `NoteImage` type, `NoteImage` component with an `image` prop, `aspectOf`, the `commit` empty rule on `images.length`
- Phase 3: `POST /api/notes/:id/images` and `DELETE /api/images/:imageId` as contracted

**Leaves alone (owned by others):**
- Delete icon, undo, `UndoBar`, bin (phase 8). The strip's remove icon calls `removeImage` with no undo; phase 8 adds undo and the editor's `Trash`
- `RevealButton` (phase 9)
- `<AnswerPanel …/>`, `<ChatBar …/>` JSX, `App.send`, the chat Esc effect, `ChatBar.tsx`, `AnswerPanel.tsx`, `useChat.ts`, and the `.answer*`/`.chatbar`/`.sendbtn` CSS (phase 11, invariant 7)
- `web/src/styles.css`: not edited. The editor's CSS lives in `NoteEditor.css`, the same pattern as `PhotoModal.css` and phase 11's `ChatBar.css`, which avoids merge collisions with phases 6, 8 and 11
- `web/src/types.ts`, `NoteImage.tsx`, `Gallery.tsx`, `PhotoModal.tsx` (phase 6)

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/components/NoteEditor.tsx` | create | the big editor modal |
| `web/src/components/NoteEditor.css` | create | editor styles (hairlines, no radius on the panel, no shadows) |
| `web/src/components/NoteEditor.test.tsx` | create | component tests: render, copy, tags, blur save, Esc capture, close/backdrop, strip remove, notice |
| `web/src/hooks/useNotice.ts` | create | timed quiet label (the dedupe message) |
| `web/src/api.ts` | modify (append at end of file, after the image-URL helpers, currently `:69-71`) | `AttachResult`, `attachImage`, `removeImage` |
| `web/src/lib/filter.ts` | modify `visibleOnWall` (`:23-25`) | keep several ids (editing + expanded) |
| `web/src/lib/filter.test.tsx` | modify (`describe('visibleOnWall')`, `:25-37`) | one test for the array form |
| `web/src/components/NoteCard.tsx` | modify (imports `:1-2`, props `:8-21`, `CardEditor` `:23-44`, `NoteCardImpl` `:46-96`) | `ArrowsOutSimple` expand button in the meta row; the inline draft is handed over on expand |
| `web/src/components/NoteCard.test.tsx` | modify (`renderCard` `:23-38`, new tests at end of `describe`) | expand click and mousedown-keeps-focus tests |
| `web/src/components/Wall.tsx` | modify (whole file, 37 lines) | pass `onExpand` through |
| `web/src/components/DropOverlay.tsx` | modify (whole file, 138 lines) | `target` / `onAttached`, `Paperclip` icon |
| `web/src/components/DropOverlay.test.tsx` | modify (new tests at end of `describe('DropOverlay')`) | attach-mode routing + overlay icon |
| `web/src/App.tsx` | modify (imports `:1-22`, state `:40-43`, `commit` `:85-110`, after `onImageAdded` `:119`, `<Wall>` `:168-178`, `<DropOverlay>` `:197`) | `expanded`, `save`, `expand`, `closeEditor`, `removeImg`, `onAttached`, editor portal |
| `web/src/App.test.tsx` | modify (new `describe` block at end) | App-level R2 flows |

## Implementation Steps

### Step 1: `api.ts`: attach and remove one image
**File:** `web/src/api.ts`, appended at the end of the file (after phase 6's image-URL helpers; today `:69-71`)
**Change:** add the attach result type and two calls. `check` throws `ApiError` on any non-2xx, so a 404 (note no longer live) or 413/415 surfaces to the caller.
**Code:**
```ts
/** Phase 3: `POST /api/notes/:id/images` → 201 `{ note, attached: true }` or 200 `{ note, attached: false }` (bytes already live in `note`). */
export interface AttachResult {
  note: Note;
  attached: boolean;
}

/** Attach one image file to an existing live note (multipart `file`). */
export async function attachImage(noteId: string, file: File): Promise<AttachResult> {
  const form = new FormData();
  form.append('file', file, file.name || 'pasted-image');
  const res = await check(await fetch(`/api/notes/${enc(noteId)}/images`, { method: 'POST', body: form }));
  return (await res.json()) as AttachResult;
}

/** Soft-remove one image from its note (to the bin). Returns the owner note without it. */
export async function removeImage(imageId: string): Promise<Note> {
  const res = await check(await fetch(`/api/images/${enc(imageId)}`, { method: 'DELETE' }));
  return (await res.json()) as Note;
}
```
**Impact:** additive. `Note` is already imported at `api.ts:1`.

### Step 2: `useNotice`, the quiet timed label
**File:** `web/src/hooks/useNotice.ts` (new)
**Change:** works like `useCopied` but has no clipboard. It holds one short message for `ms`, and a new message replaces the old one and restarts the timer.
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';

/** A quiet status label (the "copied" style) shown for `ms`, e.g. "already in K-F07". */
export function useNotice(ms = 2400): { notice: string | null; show: (text: string) => void } {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback(
    (text: string) => {
      setNotice(text);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setNotice(null), ms);
    },
    [ms],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { notice, show };
}
```
**Impact:** none outside App.

### Step 3: `filter.ts`: keep the edited and the expanded note visible
**File:** `web/src/lib/filter.ts:23-25` (`visibleOnWall`; phase 6 has switched its body to `hasImages`)
**Change:** `keep` accepts one id or a list. The expanded note must stay on the wall while it gains images in Notes. mode, and while its tags change under an active filter.
**Code:**
```ts
/** Notes shown on the wall. `keep` (the note being edited inline and/or the one open in the big editor) is always kept. */
export function visibleOnWall(
  notes: Note[],
  mode: Mode,
  active: string[],
  keep: string | null | ReadonlyArray<string | null> = null,
): Note[] {
  const list: ReadonlyArray<string | null> = typeof keep === 'string' || keep === null ? [keep] : keep;
  const kept = new Set<string>();
  for (const k of list) if (k !== null) kept.add(k);
  return notes.filter((n) => kept.has(n.id) || ((mode !== 'text' || !hasImages(n)) && matchesTags(n, active)));
}
```
**Impact:** existing callers that pass a string or nothing behave as before.

**File:** `web/src/lib/filter.test.tsx`, add inside `describe('visibleOnWall', …)` after the `'always keeps the note being edited'` test (`:34-36`):
```ts
  it('keeps every id in a keep list (inline edit + big editor)', () => {
    const extra = [...notes, note('E-EEE', ''), note('F-FFF', 'pic', { image: true })];
    const ids = visibleOnWall(extra, 'text', ['seer'], ['E-EEE', 'F-FFF', null]).map((n) => n.id);
    expect(ids).toContain('E-EEE');
    expect(ids).toContain('F-FFF');
    expect(ids).not.toContain('C-CCC');
  });
```

### Step 4: `NoteEditor` component
**File:** `web/src/components/NoteEditor.tsx` (new)
**Change:** the modal. Save rules:
- **Blur:** calls `onSave(note, draft)` only when the draft differs from the last saved text (initially the body at open). An empty draft is saved as empty and never deleted while the editor is open.
- **Close** (X button, backdrop click, Esc): calls `onClose(note, draft, dirty)` exactly once. `dirty` = the draft differs from the last saved text. App decides between the empty-rule delete, the save and the mode switch. The editor never saves on close itself, because a PATCH racing App's DELETE could re-insert the note locally.
- **Esc:** window keydown listener in the capture phase, with `preventDefault` + `stopPropagation`, like `PhotoModal`. The chat panel's document-level Esc handler never sees the key.
- **After close:** a blur fired on unmount is ignored (`closedRef`).
**Code:**
```tsx
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Check, Copy, X } from '@phosphor-icons/react';
import type { Note, NoteImage as NoteImageData } from '../types';
import { tagsOf } from '../lib/text';
import { NoteImage, aspectOf } from './NoteImage';
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
  /** The strip's remove icon (soft remove; phase 8 adds undo). */
  onRemoveImage: (image: NoteImageData) => void;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage }: NoteEditorProps) {
  const [draft, setDraft] = useState(note.body);
  const draftRef = useRef(note.body);
  const savedRef = useRef(note.body);
  const closedRef = useRef(false);
  const noteRef = useRef(note);
  noteRef.current = note;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
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
          <button type="button" className="ed-btn" data-tip="Close" aria-label="Close" onClick={close}>
            <X weight="duotone" />
          </button>
        </div>
        <textarea
          ref={taRef}
          className="ed-text"
          aria-label="Note text"
          value={draft}
          onChange={(e) => {
            draftRef.current = e.target.value;
            setDraft(e.target.value);
          }}
          onBlur={onBlur}
        />
        {tags.length > 0 && (
          <div className="ed-tags">
            {tags.map((t) => (
              <span key={t} className="ed-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
        {note.images.length > 0 && (
          <div className="ed-strip" data-strip="">
            {note.images.map((img) => (
              <div key={img.id} className="ed-thumb" data-image={img.id} style={{ aspectRatio: aspectOf(img).css }}>
                <NoteImage image={img} variant="thumb" className="ed-thumb-img" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button type="button" className="ed-rm" data-tip="Remove image" aria-label="Remove image" onClick={() => onRemoveImage(img)}>
                  <X weight="duotone" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```
**Impact:** new file; App mounts it (Step 9).

### Step 5: Editor CSS
**File:** `web/src/components/NoteEditor.css` (new)
**Change:** design-language styles. The backdrop matches PhotoModal (`rgba(10,10,9,.94)`, z 60). The panel is the canvas colour with a hairline border, square corners and no shadow. The textarea is Host Grotesk at 22px with line-height 1.45. The id, the copied label and the notice are Geist Mono 11px, as in the PhotoModal meta row. Tag chips copy PhotoModal's chips. The drop overlay (z 70) still sits above the editor.
**Code:**
```css
/* Big note editor (iteration 7, R2). Idiom: PhotoModal backdrop + the wall's type. */
.ed { position: fixed; inset: 0; z-index: 60; background: rgba(10, 10, 9, .94); display: grid; place-items: center; padding: 24px 16px; box-sizing: border-box; }
.ed-panel { width: min(1080px, 100%); height: min(880px, calc(100vh - 48px)); display: flex; flex-direction: column; gap: 14px; background: var(--bg); border: 1px solid var(--line-14); padding: 12px 18px 18px; box-sizing: border-box; color: var(--fg); font-family: var(--sans); }
.ed-top { display: flex; align-items: center; gap: 4px; min-height: 40px; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.ed-id { color: var(--id); letter-spacing: .03em; }
.ed-notice { margin-left: 10px; color: var(--dim); opacity: 0; transition: opacity .25s; white-space: nowrap; }
.ed-notice.on { opacity: 1; }
.ed-spacer { flex: 1; }
.ed-btn { width: 40px; height: 40px; border: 0; border-radius: 999px; background: transparent; color: var(--fg); font-size: 19px; cursor: pointer; display: grid; place-items: center; }
.ed-btn:hover { background: var(--hover); }
.ed-text { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; margin: 0; padding: 18px 2px 0; border: 0; border-top: 1px solid var(--line); background: transparent; color: var(--text); resize: none; overflow-y: auto; font-family: var(--sans); font-size: 22px; line-height: 1.45; letter-spacing: -.005em; }
.ed-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.ed-tag { font-size: 11px; padding: 3px 8px 4px; border-radius: 999px; background: var(--chip-bg); color: var(--chip); }
.ed-strip { flex: none; display: flex; gap: 6px; overflow-x: auto; padding-top: 12px; border-top: 1px solid var(--line); }
.ed-thumb { position: relative; flex: none; height: 96px; background: var(--img-bg); }
.ed-thumb-img { display: block; }
.ed-rm { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; border: 0; border-radius: 999px; background: rgba(18, 18, 17, .72); color: var(--fg); font-size: 13px; cursor: pointer; display: grid; place-items: center; opacity: 0; transition: opacity .2s; }
.ed-thumb:hover .ed-rm, .ed-rm:focus-visible { opacity: 1; }
.ed-rm:hover { background: var(--fg); color: var(--bg); }
```
**Impact:** relies on the `:root` tokens in `styles.css` (`--bg`, `--line-14`, `--line`, `--mono`, `--sans`, `--id`, `--dim`, `--hover`, `--chip-bg`, `--chip`, `--img-bg`, `--text`) and on the existing `.copybtn` / `.copied` rules. No edit to `styles.css`.

### Step 6: `NoteCard`: expand icon in the meta row
**File:** `web/src/components/NoteCard.tsx`
**Change:**
- (a) imports at `:2`: add `ArrowsOutSimple`, and `MutableRefObject` from react.
- (b) props at `:8-21`: add `onExpand`.
- (c) `CardEditor` at `:23-44`: mirrors its draft into a ref owned by the card, so the expand click can hand over unsaved inline text.
- (d) `NoteCardImpl` at `:46-96`: owns `draftRef`, renders the expand button after the date. The button's `onMouseDown` calls `preventDefault`, so the inline textarea keeps focus and doesn't blur-commit. Without that, "+ → expand" on an empty new note would delete it before the editor opens.

**Code:** the imports (replace `:1-2`):
```tsx
import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowsOutSimple, Check, Copy } from '@phosphor-icons/react';
```
Props (replace the interface at `:8-21`):
```tsx
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
  /** Open the big editor. `draft` = the unsaved inline text when the card is being edited, else null. */
  onExpand: (note: Note, draft: string | null) => void;
}
```
`CardEditor` (replace `:23-44`; the `fontSizeFor` second argument is phase 6's `note.images.length > 0`):
```tsx
function CardEditor({
  note,
  draftRef,
  onCommit,
}: {
  note: Note;
  draftRef: MutableRefObject<string>;
  onCommit: (note: Note, draft: string) => void;
}) {
  const [draft, setDraft] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    draftRef.current = note.body;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    // Mount only: the draft is seeded once, like the textarea itself.
  }, []);
  return (
    <textarea
      ref={ref}
      className="card-edit"
      value={draft}
      rows={rowsFor(draft.length)}
      style={{ fontSize: fontSizeFor(draft, note.images.length > 0) }}
      onChange={(e) => {
        draftRef.current = e.target.value;
        setDraft(e.target.value);
      }}
      onBlur={() => onCommit(note, draft)}
    />
  );
}
```
(React 19's `useRef` returns a mutable `RefObject<string>`, which is structurally assignable to `MutableRefObject<string>`. If `MutableRefObject` triggers a deprecation hint, type the prop as `RefObject<string>` instead.)

`NoteCardImpl` (replace `:46-96`). The `count` / `cover` / `hasImg` lines and the cover block are **phase 6's**, quoted verbatim from phase-6.md Step 5. This phase adds only `onExpand` in the destructuring, `draftRef`, the `draftRef` prop on `CardEditor`, and the expand `<button>` after `.card-date`.
```tsx
function NoteCardImpl({ note, now, editing, dim, used, copied, onCopy, onEdit, onCommit, onToggleTag, onExpand }: NoteCardProps) {
  const count = note.images.length;
  const cover = count > 0 ? note.images[0] : undefined;
  const hasImg = cover !== undefined;
  const fs = fontSizeFor(note.body, hasImg);
  const cls = ['card', hasImg ? 'img' : '', dim ? 'dim' : '', used ? 'used' : ''].filter(Boolean).join(' ');
  const draftRef = useRef(note.body);
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
          <CardEditor note={note} draftRef={draftRef} onCommit={onCommit} />
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
          <button
            type="button"
            className="copybtn"
            data-tip="Expand note"
            aria-label="Expand note"
            onMouseDown={(e) => {
              // Keep focus in the inline editor: a blur here would commit (and delete an empty new note).
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onExpand(note, editing ? draftRef.current : null);
            }}
          >
            <ArrowsOutSimple weight="duotone" />
          </button>
        </div>
      </div>
    </article>
  );
}
```
**Impact:** `NoteCardProps.onExpand` is required, so `Wall` (Step 7) and `NoteCard.test.tsx` (Step 11) must pass it in the same commit. Phase 8 adds its `Trash` to this meta row after the expand button.

### Step 7: `Wall`: pass `onExpand` through
**File:** `web/src/components/Wall.tsx` (whole file)
**Code:**
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
  onToggleTag: (tag: string) => void;
  /** Open the big editor on a note (phase 7). */
  onExpand: (note: Note, draft: string | null) => void;
}

export function Wall({ notes, now, editingId, usedIds, copiedId, onCopy, onEdit, onCommit, onToggleTag, onExpand }: WallProps) {
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
          onToggleTag={onToggleTag}
          onExpand={onExpand}
        />
      ))}
    </section>
  );
}
```

### Step 8: `DropOverlay`: attach mode
**File:** `web/src/components/DropOverlay.tsx` (whole file; phase 6 changed only the `Note` type it carries)
**Change:** new optional `target` and `onAttached`. The target is read when a file is queued, so a file dropped just before close still goes to the note it was dropped on. With a target, each file goes to `attachImage(target, file)`, `onAttached(result, target)` is called, and `onImageAdded`/`flashNote` are not. The overlay icon becomes `Paperclip`, and the element gets `data-drop-overlay="attach"` (`"new"` otherwise). Selectors in the existing tests use `[data-drop-overlay]`, which still matches.
**Code:**
```tsx
import { useEffect, useRef, useState } from 'react';
import { ImageSquare, Paperclip } from '@phosphor-icons/react';
import type { Note } from '../types';
import { attachImage, type AttachResult } from '../api';

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

export interface DropOverlayProps {
  /** Call once per note returned by POST /api/images. App inserts it and switches text -> all. */
  onImageAdded: (note: Note) => void;
  /** The note open in the big editor, or null. When set, files attach to it instead of making new notes. */
  target?: string | null;
  /** Called once per attach (target set) with the server's result and the note id it was sent to. */
  onAttached?: (result: AttachResult, target: string) => void;
}

export function DropOverlay({ onImageAdded, target = null, onAttached }: DropOverlayProps) {
  const [dragging, setDragging] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const addedRef = useRef(onImageAdded);
  const attachedRef = useRef(onAttached);
  const targetRef = useRef<string | null>(target);

  useEffect(() => {
    addedRef.current = onImageAdded;
    attachedRef.current = onAttached;
    targetRef.current = target;
  }, [onImageAdded, onAttached, target]);

  useEffect(() => {
    const enqueue = (files: File[]) => {
      const to = targetRef.current;
      for (const file of files) {
        queue.current = queue.current.then(async () => {
          try {
            if (to) {
              const result = await attachImage(to, file);
              attachedRef.current?.(result, to);
            } else {
              const result = await uploadImage(file);
              addedRef.current(result.note);
              if (!result.created) flashNote(result.note.id);
            }
          } catch (err) {
            console.error(to ? '[attach]' : '[upload]', file.name, err);
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
      data-drop-overlay={target ? 'attach' : 'new'}
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
      {target ? <Paperclip weight="duotone" /> : <ImageSquare weight="duotone" />}
    </div>
  );
}
```
**Impact:** text pastes in the editor textarea are untouched: `onPaste` only intercepts when the clipboard carries an image file.

### Step 9: `App`: `expanded`, the save/close rules, the editor portal
**File:** `web/src/App.tsx`. Hunks avoid every chat line (invariant 7).

**9a. Imports** (replace `:1-22`; the chat imports stay as they are):
```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconContext } from '@phosphor-icons/react';
import { createNote, deleteNote, removeImage, updateNote, type AttachResult } from './api';
import type { Mode, Note, NoteImage as NoteImageData } from './types';
import { useNotes } from './hooks/useNotes';
import { useChat } from './hooks/useChat';
import { useNow } from './hooks/useNow';
import { useCopied } from './hooks/useCopied';
import { useNotice } from './hooks/useNotice';
import { countLineFor, headingFor, imageCount, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
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
```
(The `./lib/filter` line is phase 6's, with `imageCount` (phase-6.md Step 10, used by `photoCount`). This phase adds nothing to it; dropping `imageCount` would break the build.)

**9b. State + visibility** (replace `:40` `editing` state through `:43` `visible` memo; `q` stays):
```tsx
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const { notice, show: showNotice } = useNotice();

  // Synchronous mirrors for event handlers that run before React re-renders.
  const expandedRef = useRef<string | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const visible = useMemo(() => visibleOnWall(notes, mode, active, [editing, expanded]), [notes, mode, active, editing, expanded]);
  const expandedNote = useMemo(() => (expanded ? (notes.find((n) => n.id === expanded) ?? null) : null), [notes, expanded]);
```

**9c. `save` + `commit`** (replace `commit` at `:85-110`). `save` is the "update only if changed, optimistic, card reflects at once" half. `commit` (the inline card editor's blur) keeps the empty rule and returns early when that note is open in the big editor, because expanding unmounts the inline editor and some browsers fire blur on unmount:
```tsx
  const save = useCallback(
    async (note: Note, draft: string) => {
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
    [upsertLocal, refetch],
  );

  const commit = useCallback(
    async (note: Note, draft: string) => {
      setEditing((cur) => (cur === note.id ? null : cur));
      // The big editor owns this note now (expand unmounts the inline editor); it applies the rules on close.
      if (expandedRef.current === note.id) return;
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
      await save(note, draft);
    },
    [removeLocal, refetch, save],
  );
```

**9d. Editor callbacks** (insert right after `onImageAdded`, i.e. after `:119`):
```tsx
  /** Expand icon on a card. `draft` = unsaved inline text (card was being edited), saved first, never deleted. */
  const expand = useCallback(
    (note: Note, draft: string | null) => {
      expandedRef.current = note.id;
      setExpanded(note.id);
      setEditing((cur) => (cur === note.id ? null : cur));
      if (draft !== null) void save(note, draft);
    },
    [save],
  );

  /** Big editor closed (X, backdrop, Esc). The empty rule applies only here; Notes. -> Everything. when it now has images. */
  const closeEditor = useCallback(
    async (note: Note, draft: string, dirty: boolean) => {
      expandedRef.current = null;
      setExpanded(null);
      const latest = notesRef.current.find((n) => n.id === note.id) ?? note;
      if (!draft.trim() && latest.images.length === 0) {
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
      if (latest.images.length > 0) setMode((m) => (m === 'text' ? 'all' : m));
      if (dirty) await save(latest, draft);
    },
    [removeLocal, refetch, save],
  );

  /** Strip remove icon: soft remove (phase 8 adds undo). Optimistic, then the server's owner note. */
  const removeImg = useCallback(
    async (image: NoteImageData) => {
      const owner = notesRef.current.find((n) => n.id === image.note_id);
      if (owner) upsertLocal({ ...owner, images: owner.images.filter((i) => i.id !== image.id) });
      try {
        upsertLocal(await removeImage(image.id));
      } catch (e) {
        console.error('remove image failed', e);
      } finally {
        refetch();
      }
    },
    [upsertLocal, refetch],
  );

  /** A drop/paste while the editor is open. A dedupe hit says so quietly; the holder (maybe restored) joins the store. */
  const onAttached = useCallback(
    (result: AttachResult) => {
      upsertLocal(result.note, true);
      if (!result.attached) showNotice(`already in ${result.note.id}`);
      refetch();
    },
    [upsertLocal, refetch, showNotice],
  );
```

**9e. `<Wall>`** (replace `:168-178`):
```tsx
            <Wall
              notes={visible}
              now={now}
              editingId={editing}
              usedIds={usedSet}
              copiedId={copied}
              onCopy={copy}
              onEdit={setEditing}
              onCommit={commit}
              onToggleTag={toggleTag}
              onExpand={expand}
            />
```

**9f. `<DropOverlay>` + editor portal** (replace the single line `:197` `<DropOverlay onImageAdded={onImageAdded} />`; the `<ChatBar …/>` line above it and `<Tooltip />` below it are not touched):
```tsx
        <DropOverlay onImageAdded={onImageAdded} target={expandedNote ? expandedNote.id : null} onAttached={onAttached} />
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
              onRemoveImage={removeImg}
            />,
            document.body,
          )}
```
**Impact:**
- The DropOverlay target follows `expandedNote`, not `expanded`. If the note vanishes from the store (deleted elsewhere), the editor unmounts and drops go back to making new notes.
- `onSave={save}` / `onClose={closeEditor}` / `onRemoveImage={removeImg}`: these Promise-returning functions are assignable to the void-returning prop types.
- The Esc listener on the editor's window, in the capture phase, stops the event before App's document-level chat Esc effect (unchanged) sees it.

### Step 10: `NoteEditor.test.tsx`
**File:** `web/src/components/NoteEditor.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note, NoteImage as NoteImageData } from '../types';
import { makeImage, makeNote } from '../testing/fixtures';
import { NoteEditor, type NoteEditorProps } from './NoteEditor';

afterEach(cleanup);

const iso = new Date().toISOString();

// Phase 6's shared fixtures (web/src/testing/fixtures.ts), with this file's PNG defaults.
function img(id: string, noteId: string, position = 0): NoteImageData {
  return makeImage(id, { note_id: noteId, position, mime: 'image/png', bytes: 10, original_name: 'shot.png' });
}

function note(body: string, images: NoteImageData[] = []): Note {
  return makeNote('A-B32', body, { images, tags: [], created: iso });
}

function renderEditor(n: Note, over: Partial<NoteEditorProps> = {}) {
  const props: NoteEditorProps = {
    note: n,
    copied: false,
    notice: null,
    onCopy: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    onRemoveImage: vi.fn(),
    ...over,
  };
  const r = render(<NoteEditor {...props} />);
  const ta = r.getByLabelText('Note text') as HTMLTextAreaElement;
  return { ...r, props, ta };
}

describe('NoteEditor', () => {
  it('opens on the note: wide textarea with the body, focused, id and copy-id', () => {
    const { ta, container, getByLabelText, props, rerender } = renderEditor(note('first line'));
    expect(ta.value).toBe('first line');
    expect(document.activeElement).toBe(ta);
    expect(container.querySelector('.ed-id')?.textContent).toBe('A-B32');
    fireEvent.click(getByLabelText('Copy ID'));
    expect(props.onCopy).toHaveBeenCalledWith('A-B32');
    rerender(<NoteEditor {...props} copied />);
    expect(container.querySelector('.ed-top .copied')?.className).toContain('on');
  });

  it('shows tag chips from the live draft', () => {
    const { ta, container } = renderEditor(note('plain'));
    expect(container.querySelector('.ed-tags')).toBeNull();
    fireEvent.change(ta, { target: { value: 'now #seer and #UX' } });
    expect(Array.from(container.querySelectorAll('.ed-tag')).map((e) => e.textContent)).toEqual(['#seer', '#ux']);
  });

  it('saves on blur only when the text changed, once per change', () => {
    const n = note('old');
    const { ta, props } = renderEditor(n);
    fireEvent.blur(ta);
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.change(ta, { target: { value: 'new text' } });
    fireEvent.blur(ta);
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith(n, 'new text');
    fireEvent.blur(ta);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it('an emptied note is saved empty on blur and never closed or deleted while open', () => {
    const n = note('soon gone');
    const { ta, props, container } = renderEditor(n);
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.blur(ta);
    expect(props.onSave).toHaveBeenCalledWith(n, '');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-modal="editor"]')).not.toBeNull();
  });

  it('Esc closes in the capture phase without reaching the chat panel handler', () => {
    const chatEsc = vi.fn();
    document.addEventListener('keydown', chatEsc);
    try {
      const n = note('x');
      const { ta, props } = renderEditor(n);
      fireEvent.change(ta, { target: { value: 'x y' } });
      const notPrevented = fireEvent.keyDown(ta, { key: 'Escape' });
      expect(notPrevented).toBe(false);
      expect(chatEsc).not.toHaveBeenCalled();
      expect(props.onClose).toHaveBeenCalledTimes(1);
      expect(props.onClose).toHaveBeenCalledWith(n, 'x y', true);
    } finally {
      document.removeEventListener('keydown', chatEsc);
    }
  });

  it('close reports dirty=false after a blur save, and fires only once; a blur after close is ignored', () => {
    const n = note('a');
    const { ta, props, getByLabelText } = renderEditor(n);
    fireEvent.change(ta, { target: { value: 'ab' } });
    fireEvent.blur(ta);
    fireEvent.click(getByLabelText('Close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.blur(ta);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledWith(n, 'ab', false);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it('a backdrop click closes; a click inside the panel does not', () => {
    const { container, props } = renderEditor(note('x'));
    fireEvent.click(container.querySelector('.ed-panel') as HTMLElement);
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-modal="editor"]') as HTMLElement);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the images as a strip in order with a remove icon each', () => {
    const a = img('A-B32', 'A-B32', 0);
    const b = img('Q-RS1', 'A-B32', 1);
    const { container, getAllByLabelText, props } = renderEditor(note('pics', [a, b]));
    const tiles = Array.from(container.querySelectorAll('.ed-strip .ed-thumb'));
    expect(tiles.map((t) => t.getAttribute('data-image'))).toEqual(['A-B32', 'Q-RS1']);
    expect((tiles[0] as HTMLElement).style.aspectRatio).toBe('600 / 400');
    fireEvent.click(getAllByLabelText('Remove image')[1]!);
    expect(props.onRemoveImage).toHaveBeenCalledWith(b);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('renders no strip for a text note', () => {
    const { container } = renderEditor(note('text only'));
    expect(container.querySelector('.ed-strip')).toBeNull();
  });

  it('says a dedupe hit quietly in a Geist Mono label', () => {
    const { container, rerender, props } = renderEditor(note('x'));
    const label = () => container.querySelector('[data-notice]') as HTMLElement;
    expect(label().className).toBe('ed-notice');
    rerender(<NoteEditor {...props} notice="already in K-F07" />);
    expect(label().className).toBe('ed-notice on');
    expect(label().textContent).toBe('already in K-F07');
  });
});
```

### Step 11: `NoteCard.test.tsx`: expand
**File:** `web/src/components/NoteCard.test.tsx`
**Change:** in `renderCard` (`:23-38`), add `onExpand: vi.fn(),` to the default `props` object after `onToggleTag: vi.fn(),`. Then append inside `describe('NoteCard', …)` (after the last `it`). `note(...)` is phase 6's fixture helper with the same call shape.
**Code:**
```tsx
  it('has an Expand note icon in the meta row that opens the big editor', () => {
    const n = note('x');
    const { getByLabelText, props } = renderCard(n);
    const btn = getByLabelText('Expand note');
    expect(btn.getAttribute('data-tip')).toBe('Expand note');
    expect(btn.closest('.card-meta')).not.toBeNull();
    fireEvent.click(btn);
    expect(props.onExpand).toHaveBeenCalledWith(n, null);
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('expanding while editing keeps the inline editor focused and hands over the unsaved draft', () => {
    const n = note('');
    const { container, getByLabelText, props } = renderCard(n, { editing: true });
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'typed inline' } });
    const btn = getByLabelText('Expand note');
    expect(fireEvent.mouseDown(btn)).toBe(false);
    fireEvent.click(btn);
    expect(props.onExpand).toHaveBeenCalledWith(n, 'typed inline');
    expect(props.onCommit).not.toHaveBeenCalled();
  });
```

### Step 12: `DropOverlay.test.tsx`: attach mode
**File:** `web/src/components/DropOverlay.test.tsx`, append inside `describe('DropOverlay', …)` (after `'dragleave with no relatedTarget hides the overlay'`). The existing fixtures in this file carry `image: null` (phase 6 changes them to `images: []`). The new ones use `images: []`.
**Code:**
```tsx
  it('with a target, a paste attaches to that note instead of making a new one', async () => {
    const attached = { note: { id: 'A-B32', body: 'long', tags: [], created_at: '', updated_at: '', origin: null, images: [] }, attached: true };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(attached), { status: 201, headers: { 'content-type': 'application/json' } }));
    const onImageAdded = vi.fn();
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} target="A-B32" onAttached={onAttached} />);
    const e = eventWith('paste', 'clipboardData', { files: [png] });
    act(() => {
      document.dispatchEvent(e);
    });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notes/A-B32/images');
    expect(init.method).toBe('POST');
    expect(((init.body as FormData).get('file') as File).name).toBe('b.png');
    expect(onAttached).toHaveBeenCalledWith(attached, 'A-B32');
    expect(onImageAdded).not.toHaveBeenCalled();
  });

  it('with a target, dropped images attach one at a time and a dedupe result is passed through', async () => {
    const dup = { note: { id: 'K-F07', body: '', tags: [], created_at: '', updated_at: '', origin: null, images: [] }, attached: false };
    fetchMock.mockImplementation(async () => okResponse(dup));
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={onAttached} />);
    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [png, txt, jpg] }));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/notes/A-B32/images', '/api/notes/A-B32/images']);
    expect(onAttached).toHaveBeenCalledTimes(2);
    expect(onAttached.mock.calls[0]![0]).toMatchObject({ attached: false, note: { id: 'K-F07' } });
  });

  it('the overlay shows the attach icon while a target is set, the new-note icon otherwise', () => {
    const el = render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={() => {}} />);
    act(() => {
      document.dispatchEvent(eventWith('dragover', 'dataTransfer', { types: ['Files'], files: [] }));
    });
    expect(el.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('attach');
    act(() => root!.render(<DropOverlay onImageAdded={() => {}} target={null} />));
    expect(el.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('new');
  });
```

### Step 13: `App.test.tsx`: the R2 flows end to end
**File:** `web/src/App.test.tsx`. Add `within` to the testing-library import at `:3`, then append a new `describe` block at the end of the file. It installs its own method-aware fetch stub with a tiny in-memory server; its `beforeEach` runs after the file's top-level one and replaces the stub. `afterEach` cleanup is the file's existing one.
**Code:** the import line (replace `:3`), plus `makeImage` added to phase 6's fixtures import (phase 6 already imports `makeNote` from `./testing/fixtures` in this file):
```tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
```
```tsx
import { makeImage, makeNote } from './testing/fixtures';
```
The block (append at end of file):
```tsx
describe('App big editor (R2)', () => {
  type Call = { method: string; url: string; body?: unknown };
  let calls: Call[];
  let server: Note[];
  let attachReply: (noteId: string) => { status: number; body: { note: Note; attached: boolean } };

  const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const img = (id: string, noteId: string, position = 0) =>
    makeImage(id, { note_id: noteId, position, mime: 'image/png', bytes: 10, original_name: 'shot.png' });
  const pasteImage = () => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files: [png] } });
    document.dispatchEvent(e);
  };
  const card = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement;
  const editor = () => document.querySelector('[data-modal="editor"]') as HTMLElement | null;
  const edText = () => within(editor()!).getByLabelText('Note text') as HTMLTextAreaElement;
  const expandCard = (id: string) => {
    const btn = within(card(id)).getByLabelText('Expand note');
    fireEvent.mouseDown(btn);
    fireEvent.click(btn);
  };
  const of = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);

  beforeEach(() => {
    calls = [];
    server = [
      makeNote('A-B32', '#seer onboarding is long', { created: iso }),
      makeNote('C-D45', 'buy fennel #kitchen', { created: iso }),
    ];
    attachReply = (noteId) => {
      const n = server.find((x) => x.id === noteId)!;
      return { status: 201, body: { note: { ...n, images: [...n.images, img('P-IC1', noteId, n.images.length)] }, attached: true } };
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (method === 'GET' && url.startsWith('/api/notes')) return reply({ notes: server, next_cursor: null });
        if (method === 'GET' && url.startsWith('/api/tags')) return reply([]);
        if (method === 'POST' && url === '/api/notes') {
          const n: Note = { id: 'N-EW1', body: '', tags: [], created_at: iso, updated_at: iso, origin: null, images: [] };
          server = [n, ...server];
          return reply(n, 201);
        }
        const one = url.match(/^\/api\/notes\/([^/]+)$/);
        if (one && method === 'PATCH') {
          const body = (JSON.parse(String(init?.body)) as { body: string }).body;
          server = server.map((n) => (n.id === one[1] ? { ...n, body } : n));
          return reply(server.find((n) => n.id === one[1]));
        }
        if (one && method === 'DELETE') {
          server = server.filter((n) => n.id !== one[1]);
          return reply({ ok: true });
        }
        const att = url.match(/^\/api\/notes\/([^/]+)\/images$/);
        if (att && method === 'POST') {
          const r = attachReply(att[1]!);
          if (r.body.attached) server = server.map((n) => (n.id === r.body.note.id ? r.body.note : n));
          return reply(r.body, r.status);
        }
        const rm = url.match(/^\/api\/images\/([^/]+)$/);
        if (rm && method === 'DELETE') {
          const owner = server.find((n) => n.images.some((i) => i.id === rm[1]))!;
          const next = { ...owner, images: owner.images.filter((i) => i.id !== rm[1]) };
          server = server.map((n) => (n.id === owner.id ? next : n));
          return reply(next);
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  it('the expand icon opens the editor on that note; Esc closes and saves only if changed', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    expect(editor()).not.toBeNull();
    expect(edText().value).toBe('#seer onboarding is long');
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(editor()).toBeNull();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    expandCard('A-B32');
    fireEvent.change(edText(), { target: { value: 'para one\n\npara two #seer' } });
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(editor()).toBeNull();
    await waitFor(() => expect(of('PATCH', '/api/notes/A-B32')).toHaveLength(1));
    expect(of('PATCH', '/api/notes/A-B32')[0]!.body).toEqual({ body: 'para one\n\npara two #seer' });
    expect(card('A-B32').querySelector('.card-text')?.textContent).toContain('para two');
  });

  it('saves on blur while open and the card reflects it at once', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    fireEvent.change(edText(), { target: { value: 'rewritten #seer' } });
    fireEvent.blur(edText());
    expect(card('A-B32').querySelector('.card-text')?.textContent).toContain('rewritten');
    expect(editor()).not.toBeNull();
    await waitFor(() => expect(of('PATCH', '/api/notes/A-B32')).toHaveLength(1));
    fireEvent.click(within(editor()!).getByLabelText('Close'));
    await waitFor(() => expect(editor()).toBeNull());
    expect(of('PATCH', '/api/notes/A-B32')).toHaveLength(1);
  });

  it('"+" then expand: the empty new note survives while open and is soft-deleted on close', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getByLabelText('New note'));
    await waitFor(() => expect(card('N-EW1')?.querySelector('textarea')).not.toBeNull());
    expandCard('N-EW1');
    expect(editor()).not.toBeNull();
    expect(of('DELETE', '/api/notes/N-EW1')).toHaveLength(0);
    fireEvent.blur(edText());
    expect(of('DELETE', '/api/notes/N-EW1')).toHaveLength(0);
    expect(card('N-EW1')).not.toBeNull();
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('DELETE', '/api/notes/N-EW1')).toHaveLength(1));
    expect(card('N-EW1')).toBeNull();
  });

  it('an emptied note is not deleted while open; on close the empty rule deletes it', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('C-D45');
    fireEvent.change(edText(), { target: { value: '' } });
    fireEvent.blur(edText());
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
    expect(card('C-D45')).not.toBeNull();
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(1));
    expect(card('C-D45')).toBeNull();
  });

  it('pasting an image while open attaches it to the edited note; Notes. switches to Everything. on close', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
    expandCard('A-B32');
    pasteImage();
    await waitFor(() => expect(editor()!.querySelector('.ed-thumb[data-image="P-IC1"]')).not.toBeNull());
    expect(of('POST', '/api/notes/A-B32/images')).toHaveLength(1);
    expect(calls.some((c) => c.url === '/api/images')).toBe(false);
    // Still on the wall behind the editor, though it now has an image in text mode.
    expect(card('A-B32')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Everything.');
    expect(card('A-B32')).not.toBeNull();
  });

  it('an emptied note that gained an image is kept on close', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('C-D45');
    fireEvent.change(edText(), { target: { value: '' } });
    pasteImage();
    await waitFor(() => expect(editor()!.querySelector('.ed-thumb')).not.toBeNull());
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
  });

  it('the drop overlay shows the attach state while the editor is open', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    const over = () => {
      const e = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [] } });
      document.dispatchEvent(e);
    };
    over();
    await waitFor(() => expect(document.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('new'));
    document.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expandCard('A-B32');
    over();
    await waitFor(() => expect(document.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('attach'));
  });

  it('a dedupe hit says so quietly in the editor and attaches nothing', async () => {
    attachReply = () => ({
      status: 200,
      body: { note: { id: 'K-F07', body: 'River', tags: [], created_at: iso, updated_at: iso, origin: null, images: [img('K-F07', 'K-F07')] }, attached: false },
    });
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    pasteImage();
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('already in K-F07'));
    expect(editor()!.querySelector('[data-notice]')?.className).toContain('on');
    expect(editor()!.querySelector('.ed-thumb')).toBeNull();
  });

  it('the strip remove icon soft-removes one image', async () => {
    server = server.map((n) => (n.id === 'A-B32' ? { ...n, images: [img('A-B32', 'A-B32', 0), img('Q-RS1', 'A-B32', 1)] } : n));
    render(<App />);
    await screen.findByText('buy fennel');
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    expandCard('A-B32');
    expect(editor()!.querySelectorAll('.ed-thumb')).toHaveLength(2);
    fireEvent.click(within(editor()!.querySelector('[data-image="Q-RS1"]') as HTMLElement).getByLabelText('Remove image'));
    expect(editor()!.querySelectorAll('.ed-thumb')).toHaveLength(1);
    await waitFor(() => expect(of('DELETE', '/api/images/Q-RS1')).toHaveLength(1));
    expect(editor()!.querySelector('[data-image="A-B32"]')).not.toBeNull();
  });

  it('Esc in the editor leaves an open chat answer alone', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith('/api/chat')
          ? new Response('event: delta\ndata: {"text":"Look at A-B32."}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
          : base(input, init),
      ),
    );
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    await waitFor(() => expect(document.querySelector('.answer')).not.toBeNull());
    expandCard('C-D45');
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(editor()).toBeNull();
    expect(document.querySelector('.answer')).not.toBeNull();
  });
});
```
Test notes:
- **Chat bar selectors:** the last test finds the chat bar with `getByLabelText('Ask about your notes')` and `form.chatbar`, the same selectors the existing chat tests use. If phase 11 changes the control to a `<textarea>`, it keeps that `aria-label` and form class (phase 11's plan updates the existing tests the same way). If phase 11 breaks those selectors, this one test follows whatever the existing chat tests use.
- **Remove-image mode:** the strip-remove test switches to Everything. first, because Notes. mode hides a note that has images. It waits on `'buy fennel'` because the A-B32 card isn't rendered in text mode.

## Requirement → test map (R5 for R2)

| R2 bullet | Test |
|---|---|
| Expand icon on every card | `NoteCard.test` "has an Expand note icon…"; `App.test` "the expand icon opens…" |
| Large modal on that note: textarea, id + copy-id, tag chips, image strip with per-image remove | `NoteEditor.test` "opens on the note…", "shows tag chips…", "shows the images as a strip…", "renders no strip…"; `App.test` "the strip remove icon…" |
| Saves on blur and on close, only if changed; card reflects at once | `NoteEditor.test` "saves on blur only when…", "close reports dirty…"; `App.test` "…Esc closes and saves only if changed", "saves on blur while open and the card reflects it at once" |
| Esc closes (chat panel stays) | `NoteEditor.test` "Esc closes in the capture phase…"; `App.test` "Esc in the editor leaves an open chat answer alone" |
| "+" creates in place; expanding it is the zoom-in | `NoteCard.test` "expanding while editing keeps the inline editor focused…"; `App.test` "\"+\" then expand…" |
| Drop/paste attaches to the edited note; overlay shows the attach icon | `DropOverlay.test` three attach-mode tests; `App.test` "pasting an image while open…", "the drop overlay shows the attach state…" |
| Dedupe says so quietly | `NoteEditor.test` "says a dedupe hit quietly…"; `App.test` "a dedupe hit says so quietly…" |
| Notes. → Everything. on close after attaching to a text note | `App.test` "pasting an image while open… switches to Everything. on close" |
| Emptied note not deleted while open; empty rule on close | `NoteEditor.test` "an emptied note is saved empty…"; `App.test` "an emptied note is not deleted while open…", "an emptied note that gained an image is kept on close", "\"+\" then expand…" |
| Expanded note stays visible | `filter.test` "keeps every id in a keep list…"; `App.test` "pasting…" (card still on the wall in Notes.) |

## Verification

**Build:** `npm run typecheck` (both tsconfigs; the web one has `noUnusedLocals`), then `npm run build` if it is part of the phase gate.
**Tests:** `npm test` (unit + all `web/src/**/*.test.tsx`). `npm run test:int` still has to pass per invariant 1. This phase touches no server code, so it is unaffected.
**Manual check:** `npm run dev` (or the built daemon at :7317):
1. "+" → type a line → click the expand icon → write three paragraphs → paste one screenshot and drop another → close. Expected: one note with the text and two images; the wall shows Everything. with the cover and a "2".
2. Drag a file over the page with the editor open. Expected: the paperclip overlay.
3. Drop the same screenshot again. Expected: "already in X-XXX" fades in beside the id.
4. Open the chat answer, open the editor, press Esc. Expected: only the editor closes.

**Exit criteria:** every R2 bullet in the map above has a passing test; typecheck and the full unit suite are green; nothing in the chat files or `styles.css` changed.

## Handoffs

- **Phase 8 (R3):**
  - Add `Trash` to `.ed-top` before the Close button (class `ed-btn`, like Close), and to the card meta row after the `Expand note` button.
  - The editor's blur-on-unmount guard is `closedRef`, set only by `close()`. A Trash click that unmounts the editor without `close()` must set `closedRef.current = true` first (phase-8.md Step 15 does), or an unmount-time blur could save the deleted note back.
  - Wrap `removeImg` in App with undo. Today it calls `removeImage` with no undo; the contract's "removed image" undo label belongs to phase 8.
  - Phase 8's note delete from the editor should reuse `closeEditor`'s cleanup (`expandedRef.current = null; setExpanded(null)`) before deleting.
  - Phase 8 edits `filter.ts` (bin heading/count) next to `visibleOnWall`; this phase changed only `visibleOnWall`'s signature/body.
- **Phase 9 (R4):** mounts `RevealButton({ image: img })` inside each `.ed-thumb[data-image]` tile, right before `.ed-rm`, with class `ed-rm ed-reveal`; it appends `.ed-reveal { right: 34px; }` to `NoteEditor.css` so the two icons sit side by side.
- **Phase 10 (R5 docs):** README text for the big editor: the expand icon, attach on drop/paste while open, the paperclip overlay, the dedupe label, and the close rules.
- **Reconciler / integrator:**
  - **Merge with phase 11 in `App.tsx` (reconciled).** Phase 11 does not edit the `<ChatBar …/>` line: it only adds two props inside `<AnswerPanel …/>` (after `pinned` and after `onTogglePin`, today `:189`/`:191`). This phase rewrites the `<DropOverlay …/>` line (today `:197`). At least five untouched lines (`onClose`, `onJump`, `/>`, `)}`, `<ChatBar …/>`) separate the two hunks, so git merges them cleanly. If an integrator still sees a conflict there, the resolution is to keep both: phase 11's `<AnswerPanel>` props, the unchanged `<ChatBar …/>`, then this phase's `<DropOverlay …/>` + editor portal, in that order. The editor's capture-phase Esc `stopPropagation` runs before the chat Esc effect either way.
  - **Phase 6's `NoteCard` cover (reconciled).** Step 6 now quotes phase 6's cover JSX verbatim (`count`, `data-count`).

## Rollback

Revert this phase's commit. The new files (`NoteEditor.tsx`, `.css`, `.test.tsx`, `hooks/useNotice.ts`) go away. The modified files return to their phase-6 state. `visibleOnWall`'s widened signature is backward compatible, so no other phase's code depends on the revert order, except phase 8/9 mount points inside `NoteEditor` (revert those phases first).
