# Phase 5: Note files UI: paperclip, chips, paste/drop routing, reveal

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R2. In the bigger-note-view modal you can attach any file (paperclip picker, ctrl-v, drop). Files show as chips with download, per-file reveal and remove-with-undo. A note-level "Show in Explorer" opens the note's files folder.
**Depends on:** Phase 1 (card footer slot), Phase 2 (Lightbox in `NoteEditor`), Phase 3 (`DropOverlay` ChatBar paste guard, `App.tsx` chat edits), Phase 4 (files API + `NoteFile` type)
**Difficulty:** NORMAL
**Package:** `web`

---

## Goal

Phase 4 adds a backend that stores files per note. This phase puts it in the wall:
- The big editor gets a paperclip button that opens a multi-file picker. Files show as chips under the text: type icon, name, size and type, download, per-file "Show in Explorer", and remove with a 6 s undo.
- While the editor is open, drop and ctrl-v route images to the existing image path and every other file to `/files`. Outside the editor, non-image paste or drop is still ignored.
- The note-level reveal button (card footer and editor top bar) calls `POST /api/notes/:id/reveal`.
- Cards show a paperclip count.
- The empty-note rule counts files, so a note that holds only files is never auto-deleted.

## Interface Contract

**Deletes:** none. (`NoteCard` stops importing `RevealButton`. The component stays and is still used by the editor strip and `PhotoModal`.)
**Renames:** none.
**Creates:**
- `web/src/lib/files.ts`: `ATTACHABLE_IMAGE_TYPES`, `type RoutedFile = { kind: 'image' | 'file'; file: File }`, `routeFiles(files)`, `pastedFiles(files, attaching)`, `formatBytes(bytes)`, `extensionOf(name)`, `typeLabel(mime, name)`, `type FileKind`, `fileKind(mime, name)`, `type Attachable`, `hasAttachments(note)`, `noteRevealable(note)`
- `web/src/api.ts`: `interface FileAttachResult extends AttachResult { kind: 'image' | 'file' }`, `attachFile(noteId, file): Promise<FileAttachResult>` (409 `duplicate_file`/`duplicate_image` throw `DuplicateFileError`/`DuplicateImageError`), `attachRouted(noteId, item)`, `removeFile(fileId)`, `class DuplicateFileError`, `restoreFile(fileId)`, `fileDownloadUrl(fileId)`, `revealFile(fileId)`, `revealNote(noteId)`
- `web/src/components/FileChips.tsx` (+ `FileChips.css`): `FileChips({ files, onRemove? })`. Root `ul.fchips[data-files]`, one `li.fchip[data-file=<id>]` per file. The per-file reveal button carries `data-reveal-file=<id>`.
- `web/src/components/NoteRevealButton.tsx`: `NoteRevealButton({ note, className?, style? })`, `data-reveal-note=<noteId>`, `aria-label="Show in Explorer"`
- `web/src/testing/fixtures.ts`: `makeFile(id, over)`. `MakeNoteOpts.files`, and `makeNote` now always sets `files` (default `[]`).
- New DOM hooks: `NoteEditor` has `button[aria-label="Attach files"]` and `input[type=file][data-picker]`. `NoteCard` footer has `span.card-files[data-files=<n>]`.
**Signature changes:**
- `NoteEditorProps` gains optional `onAttachFiles?: (files: File[]) => void` and `onRemoveFile?: (file: NoteFile) => void`.
- `DropOverlayProps` gains optional `onAttachFailed?: (file: File, err: unknown) => void`.
- `DropOverlay` behavior: with `target` set, a drop sends **every** file (images to `/images`, others to `/files`, in order), and a paste sends every clipboard file the same way. Without a target, behavior is unchanged (images only, first image on paste).
- `NoteCard` footer: the reveal slot (Phase 1's slot right after Copy ID) now renders `NoteRevealButton` (note-level). It used to render `RevealButton` for `note.images[0]`.
**Requires (from earlier phases):**
- **Phase 4 (exact, from phase-4.md "Wire contract P5 builds on" and Step 18):** `web/src/types.ts` exports `NoteFile = { id: string; note_id: string; position: number; name: string; mime: string; bytes: number; host: string | null; available: boolean; extraction_status: 'none' | 'pending' | 'done' | 'failed' | 'unsupported'; urls: { download: string }; deleted_at?: string }`. `name` is the user's file name (control characters removed); the stored `safeName` never reaches the wire. `Note.files?: NoteFile[]` is **optional** on the web (the server always sends it); this phase reads `note.files ?? []` everywhere and does not change `types.ts`. Routes and responses:
  - `POST /api/notes/:id/files` (multipart `file`) returns 201 `{note, attached: true, kind}`, or 200 `{note, attached: false, kind}` with the holder note (restored if it was deleted). `kind` is `'image'` when the server sniffed a supported image and stored it through the image path, else `'file'`. Errors: 400 `invalid_id` | `bad_multipart` | `file_required` | `empty_file`; 404 `not_found`; 409 `duplicate_file` | `duplicate_image` (with `note_id`) | `conflict`; 413 `{error: 'too_large', max_bytes}`.
  - `DELETE /api/files/:id` returns the owner `Note`.
  - `POST /api/files/:id/restore` returns the owner `Note`, or 409 `{error: 'duplicate_file', note_id, message}`.
  - `GET /api/files/:id/download` is an attachment (`Content-Disposition` from `name`, `nosniff`).
  - `POST /api/files/:id/reveal` returns 202 (same origin).
  - `POST /api/notes/:id/reveal` returns 202: live files → opens `files/<noteId>/`; no live files → selects the first live image; neither → 404 `not_found`. `noteRevealable` mirrors this rule so the button never offers a 404.
  - Errors carry the `{error}` JSON body that `check()` reads.
- **Phase 1:** in `.card-meta` the reveal element is the child right after the `Copy ID` button and before `span.copied`, preceded by Phase 1's comment line (quoted in Step 8). `NoteCard.test.tsx` has the module-level helper `footerSequence(container)` and the four-case `describe('NoteCard footer order')` block; they stay valid unchanged after this phase. `RevealMounts.test.tsx`'s first wall-card case checks the `[data-reveal]` position (rewritten to `[data-reveal-note]` in Step 10).
- **Phase 2:** `NoteEditor.tsx` has the `Lightbox, isLightboxOpen, noteImageItems` import (just above `import './NoteEditor.css';`), the `viewing` state, the `isLightboxOpen()` Esc yield, the `.ed-open` strip and the `<Lightbox>` render; this phase keeps every one of them and edits none. Every anchor used here (`import { Check, Copy, Trash, X } from '@phosphor-icons/react';`, `import type { Note, NoteImage as NoteImageData, TagCount } from '../types';`, `import './NoteEditor.css';`, the props interface's `closeSignal?: number;` line, the component signature, `const pendingCaret = useRef<number | null>(null);`, `<span className="ed-spacer" />`, the end of the `.ed-tags` block) was checked against Phase 2's full post-change file (phase-2.md Step 4) and is byte-identical there. `NoteEditor.test.tsx` line 3 gained `screen` in Phase 2 (kept in Step 7).
- **Phase 3:** `DropOverlay.tsx` exports `chatBarHasFocus` (inserted after `hasFiles`) and its `onPaste` begins `if (chatBarHasFocus()) return;` followed by the four `firstImageFile` lines quoted in Step 11f; this phase replaces only those four lines. `web/src/api.ts` line 1 is `import type { Bin, ChatImage, Note, TagCount } from './types';`, with `uploadChatImage`/`chatImageUrl`/`ChatImageUpload` after `imageInfoUrl` and `postChat(…, imageIds)`; `revealImage` is still the last function. `App.tsx` gains the `useChatImages` import and hook, a new `send`, `images={chat.images}` on `AnswerPanel` and a multi-line `<ChatBar>`; this phase leaves all of them as Phase 3 wrote them and edits only the anchors in Step 13 (quoted by text).
**Leaves alone (owned by others):** all server code (`src/**`, Phase 4); `web/src/types.ts` (Phase 4 owns `NoteFile`/`Note.files`); `ChatBar`, `AnswerPanel`, `useChat` (Phases 3, 9, 10, 11); `Lightbox` and the editor strip/Esc seam (Phase 2); `PhotoModal`, `Gallery`, photo mode (unchanged); the bin view (no files in the bin, per plan Decisions).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/lib/files.ts` | create | pure routing / formatting / empty-rule helpers |
| `web/src/lib/files.test.tsx` | create | unit tests for every helper |
| `web/src/api.ts` | modify (Phase 3's line-1 type import; append after `revealImage`, the last function) | `FileAttachResult`, file API calls + `DuplicateFileError` + `attachRouted` |
| `web/src/components/FileChips.tsx` | create | chips component with per-file reveal |
| `web/src/components/FileChips.css` | create | chip styles |
| `web/src/components/FileChips.test.tsx` | create | chips render, download, reveal, remove |
| `web/src/components/NoteRevealButton.tsx` | create | note-level reveal button |
| `web/src/components/NoteRevealButton.test.tsx` | create | visibility rules + POST route |
| `web/src/components/NoteEditor.tsx` | modify (imports 1-8, props ~28, signature ~33, refs ~48, top bar ~145, after `.ed-tags` ~214) | paperclip + picker, note reveal, chips |
| `web/src/components/NoteEditor.test.tsx` | modify (imports 1-6 as Phase 2 leaves them, append after Phase 2's lightbox block) | picker, chips, remove |
| `web/src/components/NoteCard.tsx` | modify (imports 2, 7; body ~66; footer ~122-124) | `NoteRevealButton`, paperclip count |
| `web/src/components/NoteCard.test.tsx` | modify (imports, append after Phase 1's footer-order block) | files footer tests |
| `web/src/components/RevealMounts.test.tsx` | modify (helpers ~22, wall-card cases ~52-72, new editor case) | note-level reveal is `data-reveal-note` |
| `web/src/components/DropOverlay.tsx` | modify, as Phase 3 leaves it; line numbers are today's (imports 1-5, props 42-49, refs/effect 51-62, `enqueue` 65-83, `onDrop` 97, `onPaste` body) | routed attach, failure callback |
| `web/src/components/DropOverlay.test.tsx` | modify (replace case at 165-178, append cases) | routing tests |
| `web/src/App.tsx` | modify, as Phase 3 leaves it; line numbers are today's, match on text (imports 5-6 + new import; `commit` ~138; `closeEditor` ~175-181; after `onAttached` ~206; after `removeImageWithUndo` ~274; `DropOverlay` ~452; `NoteEditor` ~455-467) | empty rule, attach queue, file undo, wiring |
| `web/src/App.test.tsx` | modify (imports 4-6, append new `describe` after Phase 3's) | integration of paste/picker/undo/empty rule/409 notice |
| `web/src/styles.css` | modify (after line 100) | `.card-files` |
| `web/src/testing/fixtures.ts` | modify | `makeFile`, `files` on `makeNote` |
| `README.md` | modify (editor bullets ~157-165, "Open file location" ~246-251) | user-facing text |
| `CHANGELOG.md` | modify (`## [Unreleased]` → `### Added`) | one line |

## Implementation Steps

### Step 0: Worktree setup (Invariant 10)
```bash
cd /home/miftah/.worktrees/mcp-notes/chat-history-files-image-search
[ -d node_modules ] || npm ci
[ -e .env.local ] || ln -s ~/mcp-notes/.env.local .env.local
```
Check that Phases 1-4 have landed: `grep -n "interface NoteFile" web/src/types.ts` (Phase 4), `grep -n "isLightboxOpen" web/src/components/NoteEditor.tsx` (Phase 2), `grep -n "chatBarHasFocus" web/src/components/DropOverlay.tsx` (Phase 3) and `grep -n "footerSequence" web/src/components/NoteCard.test.tsx` (Phase 1) must all match. Phase 4's web `NoteFile` is exactly the shape in the Interface Contract below, and `Note.files` is optional (`files?: NoteFile[]`).

### Step 1: Pure helpers
**File:** `web/src/lib/files.ts` (new)
**Code:**
```ts
/**
 * Note files on the wall (R2, phase 5): which dropped / pasted / picked file takes which upload
 * path, how a file chip names its size and type, and the empty-note / reveal rules that count files.
 * Pure: no fetch, no DOM beyond the File objects handed in.
 */

type FileSource = FileList | ArrayLike<File> | null | undefined;

/**
 * The image types the image path (`POST /api/notes/:id/images`) accepts. Mirrors
 * `SUPPORTED_IMAGE_MIMES` in src/images/probe.ts. Everything else goes to `/files`, including
 * image/svg+xml, image/bmp and a file the browser reports with no type (Windows often does this for
 * HEIC). The server's `/files` hands bytes it sniffs as a supported image to the image path (plan
 * Decisions: "Client routing of attached files").
 */
export const ATTACHABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'image/tiff',
]);

/** One file to attach to an open note, and the upload path it takes. */
export type RoutedFile = { kind: 'image' | 'file'; file: File };

/** Every file, in order: supported images keep the image path, anything else becomes a note file. */
export function routeFiles(files: FileSource): RoutedFile[] {
  return Array.from(files ?? []).map((file): RoutedFile => ({
    kind: ATTACHABLE_IMAGE_TYPES.has(file.type.toLowerCase()) ? 'image' : 'file',
    file,
  }));
}

/**
 * What a ctrl-v hands on. With a note open (`attaching`), every pasted file attaches to it. Otherwise
 * only the first image counts, because it becomes a new photo note. Any other pasted file is left
 * alone (outside the editor a pasted PDF is ignored, as before).
 */
export function pastedFiles(files: FileSource, attaching: boolean): File[] {
  const all = Array.from(files ?? []);
  if (attaching) return all;
  const image = all.find((f) => f.type.startsWith('image/'));
  return image ? [image] : [];
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** `0 B`, `1023 B`, `1 KB`, `1.5 KB`, `12 KB`, `5 MB`. Empty for a negative or non-finite size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes / 1024;
  let i = 0;
  // 1023.5 rounds to 1024 below, so step up to the next unit instead of printing "1024 KB".
  while (v >= 1023.5 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const s = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return `${s} ${BYTE_UNITS[i]}`;
}

/** The lower-case extension of a file name (`report.PDF` → `pdf`), or '' when there is none. */
export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/json': 'JSON',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'text/markdown': 'MD',
};

/** The chip's short type: the extension upper-cased, else a known mime label, else the mime subtype, else `FILE`. */
export function typeLabel(mime: string, name: string): string {
  const ext = extensionOf(name);
  if (ext) return ext.toUpperCase();
  const m = mime.toLowerCase();
  const known = MIME_LABELS[m];
  if (known) return known;
  const sub = (m.split('/')[1] ?? '').split(/[+;]/)[0] ?? '';
  return sub && sub.length <= 8 ? sub.toUpperCase() : 'FILE';
}

export type FileKind = 'pdf' | 'image' | 'audio' | 'video' | 'archive' | 'sheet' | 'slides' | 'doc' | 'code' | 'text' | 'other';

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  xz: 'archive',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  ods: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  rtf: 'doc',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  py: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  sh: 'code',
  sql: 'code',
  json: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  html: 'code',
  css: 'code',
  txt: 'text',
  md: 'text',
  log: 'text',
};

/** Which icon a chip shows: by extension first (mimes are often generic), then by mime family. */
export function fileKind(mime: string, name: string): FileKind {
  const ext = extensionOf(name);
  const byExt = ext ? EXT_KIND[ext] : undefined;
  if (byExt) return byExt;
  const m = mime.toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

/** Structural: the wire `Note` (Phase 4 types `files` as optional on the web) and test fixtures fit. */
export type Attachable = {
  images: ReadonlyArray<{ available: boolean }>;
  files?: ReadonlyArray<{ available: boolean }>;
};

/** The empty-note rule's "has something besides text": any live image or any live file (local or not). */
export function hasAttachments(note: Attachable): boolean {
  return note.images.length > 0 || (note.files?.length ?? 0) > 0;
}

/**
 * The note-level "Show in Explorer" can do something here. Mirrors Phase 4's `POST /api/notes/:id/reveal`:
 * a note with live files opens its files folder (so some file must be on this machine); a note with no
 * files selects its first image (so some image must be local); a note with neither is 404 `not_found`.
 */
export function noteRevealable(note: Attachable): boolean {
  const files = note.files ?? [];
  if (files.length > 0) return files.some((f) => f.available);
  return note.images.some((i) => i.available);
}
```
**Impact:** new module, no callers until later steps.

### Step 2: Helper tests
**File:** `web/src/lib/files.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extensionOf, fileKind, formatBytes, hasAttachments, noteRevealable, pastedFiles, routeFiles, typeLabel } from './files';

const png = new File(['p'], 'shot.png', { type: 'image/png' });
const heic = new File(['h'], 'IMG_1.HEIC', { type: 'image/heic' });
const svg = new File(['s'], 'logo.svg', { type: 'image/svg+xml' });
const pdf = new File(['%PDF'], 'contract.pdf', { type: 'application/pdf' });
const untyped = new File(['?'], 'IMG_2.heic', { type: '' });
const txt = new File(['t'], 'a.txt', { type: 'text/plain' });

describe('routeFiles', () => {
  it('keeps order; supported images take the image path, everything else is a file', () => {
    expect(routeFiles([pdf, png, svg, heic, untyped, txt]).map((r) => [r.kind, r.file.name])).toEqual([
      ['file', 'contract.pdf'],
      ['image', 'shot.png'],
      ['file', 'logo.svg'],
      ['image', 'IMG_1.HEIC'],
      ['file', 'IMG_2.heic'],
      ['file', 'a.txt'],
    ]);
  });
  it('is empty for nothing', () => {
    expect(routeFiles(null)).toEqual([]);
    expect(routeFiles(undefined)).toEqual([]);
    expect(routeFiles([])).toEqual([]);
  });
});

describe('pastedFiles', () => {
  it('with a note open, every pasted file attaches', () => {
    expect(pastedFiles([txt, png, pdf], true)).toEqual([txt, png, pdf]);
  });
  it('without a note open, only the first image counts and non-images are ignored', () => {
    expect(pastedFiles([txt, png, heic], false)).toEqual([png]);
    expect(pastedFiles([txt, pdf], false)).toEqual([]);
    expect(pastedFiles(null, false)).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('formats B, KB, MB, GB with one decimal under 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1048000)).toBe('1023 KB');
    expect(formatBytes(1048575)).toBe('1 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB');
  });
  it('is empty for nonsense', () => {
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('typeLabel / extensionOf / fileKind', () => {
  it('labels by extension, then known mime, then subtype, then FILE', () => {
    expect(extensionOf('report.PDF')).toBe('pdf');
    expect(extensionOf('Makefile')).toBe('');
    expect(typeLabel('application/pdf', 'report.PDF')).toBe('PDF');
    expect(typeLabel('application/pdf', 'report')).toBe('PDF');
    expect(typeLabel('audio/mpeg', 'voice')).toBe('MPEG');
    expect(typeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x')).toBe('FILE');
    expect(typeLabel('', 'x')).toBe('FILE');
  });
  it('picks an icon kind by extension first, then mime family', () => {
    expect(fileKind('application/octet-stream', 'deck.pptx')).toBe('slides');
    expect(fileKind('application/octet-stream', 'sheet.xlsx')).toBe('sheet');
    expect(fileKind('application/zip', 'bundle.zip')).toBe('archive');
    expect(fileKind('application/pdf', 'scan')).toBe('pdf');
    expect(fileKind('audio/mpeg', 'voice.mp3')).toBe('audio');
    expect(fileKind('video/mp4', 'clip.mp4')).toBe('video');
    expect(fileKind('text/plain', 'notes')).toBe('text');
    expect(fileKind('application/octet-stream', 'blob.bin')).toBe('other');
  });
});

describe('hasAttachments / noteRevealable', () => {
  const local = { available: true };
  const away = { available: false };
  it('counts images and files, local or not, for the empty-note rule', () => {
    expect(hasAttachments({ images: [] })).toBe(false);
    expect(hasAttachments({ images: [], files: [] })).toBe(false);
    expect(hasAttachments({ images: [away] })).toBe(true);
    expect(hasAttachments({ images: [], files: [away] })).toBe(true);
  });
  it('follows the note route: files decide when there are any, else images; neither is never revealable', () => {
    expect(noteRevealable({ images: [], files: [] })).toBe(false);
    expect(noteRevealable({ images: [away], files: [away] })).toBe(false);
    expect(noteRevealable({ images: [local] })).toBe(true);
    expect(noteRevealable({ images: [away], files: [local] })).toBe(true);
    // The route opens the files folder, which is not on this machine: a local image does not help.
    expect(noteRevealable({ images: [local], files: [away] })).toBe(false);
  });
});
```

### Step 3: API calls
**File:** `web/src/api.ts` as Phase 3 leaves it: the type import on line 1, and append at the end of the file (after `revealImage`, which is still the last function: Phase 3 inserts its chat-image helpers after `imageInfoUrl` and changes `postChat` in place)
**Change:** Phase 3's line 1 (`import type { Bin, ChatImage, Note, TagCount } from './types';`) becomes two lines:
```ts
import type { Bin, ChatImage, Note, TagCount } from './types';
import type { RoutedFile } from './lib/files';
```
Append at the end of the file:
```ts
/** Phase 4's `POST /api/notes/:id/files` result. `kind: 'image'` when the server sniffed a supported image and stored it through the image path (it is then in `note.images`), else `'file'`. */
export interface FileAttachResult extends AttachResult {
  kind: 'image' | 'file';
}

/**
 * Phase 5 (R2): `POST /api/notes/:id/files` (multipart `file`) → 201 `{ note, attached: true, kind }`,
 * or 200 `{ note, attached: false, kind }` with the note that already holds these bytes (restored if it
 * was deleted). A 409 `duplicate_file` / `duplicate_image` with `note_id` (a lost race on the same
 * bytes) throws DuplicateFileError / DuplicateImageError; 413 throws ApiError `too_large`.
 */
export async function attachFile(noteId: string, file: File): Promise<FileAttachResult> {
  const form = new FormData();
  form.append('file', file, file.name || 'pasted-file');
  const res = await fetch(`/api/notes/${enc(noteId)}/files`, { method: 'POST', body: form });
  if (res.status === 409) {
    const j = (await res.json().catch(() => null)) as { error?: string; note_id?: string } | null;
    if (j?.error === 'duplicate_file' && typeof j.note_id === 'string') throw new DuplicateFileError(j.note_id);
    if (j?.error === 'duplicate_image' && typeof j.note_id === 'string') throw new DuplicateImageError(j.note_id);
    throw new ApiError(409, j?.error ?? 'conflict');
  }
  await check(res);
  return (await res.json()) as FileAttachResult;
}

/** One routed file (lib/files `routeFiles`) to its upload path: images to `/images`, everything else to `/files`. */
export function attachRouted(noteId: string, item: RoutedFile): Promise<AttachResult> {
  return item.kind === 'image' ? attachImage(noteId, item.file) : attachFile(noteId, item.file);
}

/** `DELETE /api/files/:fileId`: soft-remove one file from its note. Returns the owner note without it. */
export async function removeFile(fileId: string): Promise<Note> {
  const res = await check(await fetch(`/api/files/${enc(fileId)}`, { method: 'DELETE' }));
  return (await res.json()) as Note;
}

/** 409 `duplicate_file` (restore, or a lost attach race): the same bytes already live in note `noteId`. Mirrors DuplicateImageError. */
export class DuplicateFileError extends ApiError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(409, 'duplicate_file');
    this.name = 'DuplicateFileError';
    this.noteId = noteId;
  }
}

/** `POST /api/files/:fileId/restore` → the owning note. */
export async function restoreFile(fileId: string): Promise<Note> {
  const res = await fetch(`/api/files/${enc(fileId)}/restore`, { method: 'POST' });
  if (res.status === 409) {
    const j = (await res.json().catch(() => null)) as { error?: string; note_id?: string } | null;
    if (j?.error === 'duplicate_file' && typeof j.note_id === 'string') throw new DuplicateFileError(j.note_id);
    throw new ApiError(409, j?.error ?? 'conflict');
  }
  await check(res);
  return (await res.json()) as Note;
}

/** `/api/files/<fileId>/download`: served as an attachment with its original name. Fallback for a wire file without `urls.download`. */
export function fileDownloadUrl(fileId: string): string {
  return `/api/files/${enc(fileId)}/download`;
}

/** `POST /api/files/<fileId>/reveal` → 202. Explorer opens with the file selected. */
export async function revealFile(fileId: string): Promise<void> {
  await check(await fetch(`/api/files/${enc(fileId)}/reveal`, { method: 'POST' }));
}

/** `POST /api/notes/<noteId>/reveal` → 202. Opens the note's files folder, or selects its first image when it has no files. */
export async function revealNote(noteId: string): Promise<void> {
  await check(await fetch(`/api/notes/${enc(noteId)}/reveal`, { method: 'POST' }));
}
```
**Impact:** additive. `lib/files.ts` imports nothing from `api.ts`, so there is no import cycle.

### Step 4: `NoteRevealButton`
**File:** `web/src/components/NoteRevealButton.tsx` (new)
**Code:**
```tsx
import type { CSSProperties, MouseEvent } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import { revealNote } from '../api';
import { useCapabilities } from '../hooks/useCapabilities';
import { noteRevealable, type Attachable } from '../lib/files';

export interface NoteRevealButtonProps {
  /** Structural so the wire `Note` and test fixtures fit. */
  note: { id: string } & Attachable;
  /** Icon-button class of the host toolbar: `copybtn` on cards (default), `ed-btn` in the editor top bar. */
  className?: string;
  style?: CSSProperties;
}

/**
 * The note-level "Show in Explorer" (R2). notesd opens the folder that holds this note's files, or
 * selects its first image when it has none (a note with neither is 404 there). It renders only when
 * notesd can reveal and `noteRevealable` says the route has something local to show.
 */
export function NoteRevealButton({ note, className = 'copybtn', style }: NoteRevealButtonProps) {
  const caps = useCapabilities();
  if (!caps.reveal || !noteRevealable(note)) return null;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    revealNote(note.id).catch((err: unknown) => {
      console.warn(`reveal note ${note.id} failed:`, err instanceof Error ? err.message : err);
    });
  };

  return (
    <button
      type="button"
      className={className}
      data-tip="Show in Explorer"
      aria-label="Show in Explorer"
      data-reveal-note={note.id}
      onClick={onClick}
      style={style}
    >
      <FolderOpen weight="duotone" />
    </button>
  );
}
```

**File:** `web/src/components/NoteRevealButton.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { NoteRevealButton } from './NoteRevealButton';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/reveal') ? json({ ok: true }, 202) : json({ error: 'not_found' }, 404),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

const local = { available: true };
const away = { available: false };

describe('NoteRevealButton', () => {
  it('renders for a note with a local file or a local image when caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const files = render(<NoteRevealButton note={{ id: 'A-B32', images: [], files: [local] }} />);
    expect(files.container.querySelector('[data-reveal-note="A-B32"]')).not.toBeNull();
    files.unmount();
    const images = render(<NoteRevealButton note={{ id: 'K-F07', images: [local] }} />);
    const btn = images.container.querySelector('[data-reveal-note="K-F07"]') as HTMLElement;
    expect(btn.getAttribute('aria-label')).toBe('Show in Explorer');
    expect(btn.className).toBe('copybtn');
  });

  it('renders nothing when nothing is local, for a text note, or without caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [away], files: [away] }} />).container.querySelector('button')).toBeNull();
    cleanup();
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [], files: [] }} />).container.querySelector('button')).toBeNull();
    cleanup();
    // Files decide when the note has any (the route opens the files folder): a local image does not help.
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [local], files: [away] }} />).container.querySelector('button')).toBeNull();
    cleanup();
    resetCapabilitiesForTests({ reveal: false });
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [local], files: [local] }} />).container.querySelector('button')).toBeNull();
  });

  it('click POSTs /api/notes/<id>/reveal and does not reach the parent', async () => {
    resetCapabilitiesForTests({ reveal: true });
    const parent = vi.fn();
    const { container } = render(
      <div onClick={parent}>
        <NoteRevealButton note={{ id: 'C-D45', images: [], files: [local] }} className="ed-btn" />
      </div>,
    );
    const btn = container.querySelector('[data-reveal-note]') as HTMLElement;
    expect(btn.className).toBe('ed-btn');
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notes/C-D45/reveal');
    expect(init.method).toBe('POST');
    expect(parent).not.toHaveBeenCalled();
  });

  it('a failed reveal only logs a quiet warning', async () => {
    resetCapabilitiesForTests({ reveal: true });
    fetchMock.mockImplementation(async () => json({ error: 'spawn_failed' }, 500));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(<NoteRevealButton note={{ id: 'C-D45', images: [local] }} />);
    fireEvent.click(container.querySelector('[data-reveal-note]') as HTMLElement);
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0][0])).toContain('C-D45');
    expect(String(warn.mock.calls[0][1])).toBe('spawn_failed');
  });
});
```

### Step 5: `FileChips`
**File:** `web/src/components/FileChips.tsx` (new)
**Code:**
```tsx
import type { MouseEvent } from 'react';
import {
  DownloadSimple,
  FileAudio,
  FileCode,
  FileDoc,
  FileIcon,
  FileImage,
  FilePdf,
  FilePpt,
  FileText,
  FileVideo,
  FileXls,
  FileZip,
  FolderOpen,
  X,
  type Icon,
} from '@phosphor-icons/react';
import type { NoteFile } from '../types';
import { fileDownloadUrl, revealFile } from '../api';
import { useCapabilities } from '../hooks/useCapabilities';
import { fileKind, formatBytes, typeLabel, type FileKind } from '../lib/files';
import './FileChips.css';

const KIND_ICON: Record<FileKind, Icon> = {
  pdf: FilePdf,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileZip,
  sheet: FileXls,
  slides: FilePpt,
  doc: FileDoc,
  code: FileCode,
  text: FileText,
  other: FileIcon,
};

export interface FileChipsProps {
  /** The note's live files, ascending `position`. */
  files: NoteFile[];
  /** The chip's remove icon (soft remove; App offers a 6 s undo). Absent = no remove icon. */
  onRemove?: (file: NoteFile) => void;
}

/** Per-file "Show in Explorer": only when notesd can reveal and this file's bytes are on this machine. */
function FileRevealButton({ file }: { file: Pick<NoteFile, 'id' | 'available'> }) {
  const caps = useCapabilities();
  if (!caps.reveal || !file.available) return null;
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    revealFile(file.id).catch((err: unknown) => {
      console.warn(`reveal file ${file.id} failed:`, err instanceof Error ? err.message : err);
    });
  };
  return (
    <button type="button" className="fchip-btn" data-tip="Show in Explorer" aria-label="Show in Explorer" data-reveal-file={file.id} onClick={onClick}>
      <FolderOpen weight="duotone" />
    </button>
  );
}

/**
 * A note's files as chips under the editor text (R2): type icon, name, "size · TYPE", then download,
 * reveal and remove. A file whose bytes live on the other laptop is dimmed and says where it is.
 * It cannot be downloaded or revealed from here.
 */
export function FileChips({ files, onRemove }: FileChipsProps) {
  if (files.length === 0) return null;
  return (
    <ul className="fchips" data-files="" aria-label="Files">
      {files.map((f) => {
        const Kind = KIND_ICON[fileKind(f.mime, f.name)];
        const meta = [formatBytes(f.bytes), typeLabel(f.mime, f.name), f.available ? '' : `on ${f.host ?? 'another machine'}`]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={f.id} className={f.available ? 'fchip' : 'fchip away'} data-file={f.id}>
            <span className="fchip-icon" aria-hidden="true">
              <Kind weight="duotone" />
            </span>
            <span className="fchip-name" data-tip={f.name}>
              {f.name}
            </span>
            <span className="fchip-meta" data-meta="">
              {meta}
            </span>
            {f.available && (
              <a
                className="fchip-btn"
                href={f.urls.download || fileDownloadUrl(f.id)}
                download={f.name}
                data-tip="Download"
                aria-label="Download file"
                data-download={f.id}
              >
                <DownloadSimple weight="duotone" />
              </a>
            )}
            <FileRevealButton file={f} />
            {onRemove && (
              <button
                type="button"
                className="fchip-btn"
                data-tip="Remove file"
                aria-label="Remove file"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(f);
                }}
              >
                <X weight="duotone" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```
Every user-visible label (chip text, tooltip, `download` attribute, type label) uses `NoteFile.name`, the user's display name. Phase 4 stores the bytes under a sanitised, possibly collision-suffixed `safeName` that never reaches the wire; the browser's saved name comes from the server's `Content-Disposition` (built from `name`), and the `download` attribute repeats it.
Note: `FileIcon` is the non-deprecated export name for Phosphor's `File` icon. The bare `File` name would shadow the DOM `File` type in this module.

**File:** `web/src/components/FileChips.css` (new)
**Code:**
```css
/* Phase 5 (R2): a note's files under the editor text. Idiom: the editor's tag chips + the card's icon buttons. */
.fchips { flex: none; display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; max-height: 132px; overflow-y: auto; }
.fchip { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 360px; padding: 3px 4px 3px 10px; border: 1px solid var(--line-14); border-radius: 999px; background: var(--chip-bg); color: var(--fg); font-family: var(--mono); font-size: 11px; }
.fchip.away { opacity: .55; }
.fchip-icon { flex: none; display: grid; place-items: center; font-size: 16px; color: var(--chip); }
.fchip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.fchip-meta { flex: none; color: var(--dim); white-space: nowrap; }
.fchip-btn { flex: none; width: 24px; height: 24px; border: 0; border-radius: 999px; background: transparent; color: var(--id); font-size: 13px; cursor: pointer; display: grid; place-items: center; text-decoration: none; }
.fchip-btn:hover, .fchip-btn:focus-visible { background: var(--hover); color: var(--fg); }
```

**File:** `web/src/components/FileChips.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { FileChips } from './FileChips';
import { makeFile } from '../testing/fixtures';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }, 202));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCapabilitiesForTests();
});

const pdf = makeFile('F-IL1', { note_id: 'A-B32', name: 'contract.pdf', mime: 'application/pdf', bytes: 2048 });
const zip = makeFile('F-IL2', { note_id: 'A-B32', position: 1, name: 'bundle.zip', mime: 'application/zip', bytes: 5 * 1024 * 1024 });
const away = makeFile('F-IL3', { note_id: 'A-B32', position: 2, name: 'far.txt', mime: 'text/plain', bytes: 12, host: 'thinkpad', available: false });

describe('FileChips', () => {
  it('renders nothing without files', () => {
    resetCapabilitiesForTests({ reveal: false });
    expect(render(<FileChips files={[]} />).container.querySelector('.fchips')).toBeNull();
  });

  it('one chip per file in order with name and "size · TYPE", and a download link', () => {
    resetCapabilitiesForTests({ reveal: false });
    const { container } = render(<FileChips files={[pdf, zip]} />);
    const chips = Array.from(container.querySelectorAll('.fchip'));
    expect(chips.map((c) => c.getAttribute('data-file'))).toEqual(['F-IL1', 'F-IL2']);
    expect(chips[0].querySelector('.fchip-name')?.textContent).toBe('contract.pdf');
    expect(chips[0].querySelector('[data-meta]')?.textContent).toBe('2 KB · PDF');
    expect(chips[1].querySelector('[data-meta]')?.textContent).toBe('5 MB · ZIP');
    expect(chips[0].querySelector('svg')).not.toBeNull();
    const a = within(chips[0] as HTMLElement).getByLabelText('Download file') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/api/files/F-IL1/download');
    expect(a.getAttribute('download')).toBe('contract.pdf');
  });

  it('shows the display name, never the stored (sanitised) name', () => {
    // Phase 4 stores `files/<noteId>/<safeName>`; `name` is the user's name with control characters removed.
    resetCapabilitiesForTests({ reveal: false });
    const odd = makeFile('F-IL4', { note_id: 'A-B32', name: 'Q3 report: final?.pdf', urls: { download: '/api/files/F-IL4/download' } });
    const { container } = render(<FileChips files={[odd]} />);
    const chip = container.querySelector('[data-file="F-IL4"]') as HTMLElement;
    expect(chip.querySelector('.fchip-name')?.textContent).toBe('Q3 report: final?.pdf');
    expect(chip.querySelector('.fchip-name')?.getAttribute('data-tip')).toBe('Q3 report: final?.pdf');
    expect(chip.querySelector('[data-download]')?.getAttribute('download')).toBe('Q3 report: final?.pdf');
  });

  it('a file on another machine is dimmed, says where, and has no download or reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = render(<FileChips files={[away]} />);
    const chip = container.querySelector('[data-file="F-IL3"]') as HTMLElement;
    expect(chip.className).toBe('fchip away');
    expect(chip.querySelector('[data-meta]')?.textContent).toBe('12 B · TXT · on thinkpad');
    expect(chip.querySelector('[data-download]')).toBeNull();
    expect(chip.querySelector('[data-reveal-file]')).toBeNull();
  });

  it('per-file reveal POSTs /api/files/<id>/reveal, only when caps.reveal', async () => {
    resetCapabilitiesForTests({ reveal: false });
    const off = render(<FileChips files={[pdf]} />);
    expect(off.container.querySelector('[data-reveal-file]')).toBeNull();
    off.unmount();

    resetCapabilitiesForTests({ reveal: true });
    const parent = vi.fn();
    const { container } = render(
      <div onClick={parent}>
        <FileChips files={[pdf]} />
      </div>,
    );
    fireEvent.click(container.querySelector('[data-reveal-file="F-IL1"]') as HTMLElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/files/F-IL1/reveal');
    expect(init.method).toBe('POST');
    expect(parent).not.toHaveBeenCalled();
  });

  it('remove icon only with onRemove, and hands over that file', () => {
    resetCapabilitiesForTests({ reveal: false });
    const bare = render(<FileChips files={[pdf]} />);
    expect(bare.container.querySelector('[aria-label="Remove file"]')).toBeNull();
    bare.unmount();
    const onRemove = vi.fn();
    const { container } = render(<FileChips files={[pdf, zip]} onRemove={onRemove} />);
    fireEvent.click(within(container.querySelector('[data-file="F-IL2"]') as HTMLElement).getByLabelText('Remove file'));
    expect(onRemove).toHaveBeenCalledWith(zip);
  });
});
```

### Step 6: Paperclip, picker, note reveal and chips in `NoteEditor`
**File:** `web/src/components/NoteEditor.tsx` (as Phase 2 leaves it)

**6a. Imports.** Line 2: add `Paperclip`:
```tsx
import { Check, Copy, Paperclip, Trash, X } from '@phosphor-icons/react';
```
Line 3: add `NoteFile`:
```tsx
import type { Note, NoteFile, NoteImage as NoteImageData, TagCount } from '../types';
```
Replace `import './NoteEditor.css';` with:
```tsx
import { FileChips } from './FileChips';
import { NoteRevealButton } from './NoteRevealButton';
import './NoteEditor.css';
```

**6b. Props.** In `NoteEditorProps`, replace
```tsx
  closeSignal?: number;
}
```
with
```tsx
  closeSignal?: number;
  /** Phase 5 (R2): files picked with the paperclip, in order. App routes images to `/images` and the rest to `/files`. Absent = no paperclip. */
  onAttachFiles?: (files: File[]) => void;
  /** Phase 5 (R2): a file chip's remove icon (soft remove; App offers a 6 s undo). Absent = no remove icon on chips. */
  onRemoveFile?: (file: NoteFile) => void;
}
```

**6c. Signature.** Replace the component signature line with:
```tsx
export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage, onDelete, onAttachFiles, onRemoveFile, tags: knownTags = [], closeSignal = 0 }: NoteEditorProps) {
```

**6d. Picker ref and file list.** Directly after `const pendingCaret = useRef<number | null>(null);` add:
```tsx
  // Phase 5: the hidden multi-file input the paperclip clicks.
  const pickerRef = useRef<HTMLInputElement>(null);
  const files = note.files ?? [];
```

**6e. Top bar.** Replace `<span className="ed-spacer" />` with:
```tsx
          <span className="ed-spacer" />
          <NoteRevealButton note={note} className="ed-btn" />
          {onAttachFiles && (
            <>
              <button type="button" className="ed-btn" data-tip="Attach files" aria-label="Attach files" onClick={() => pickerRef.current?.click()}>
                <Paperclip weight="duotone" />
              </button>
              <input
                ref={pickerRef}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                aria-hidden="true"
                data-picker=""
                onChange={(e) => {
                  const input = e.currentTarget;
                  // Copy first: clearing the value empties the live FileList. Clearing lets the same file be picked again.
                  const picked = Array.from(input.files ?? []);
                  input.value = '';
                  if (picked.length > 0) onAttachFiles(picked);
                }}
              />
            </>
          )}
```

**6f. Chips under the text.** Replace the end of the `.ed-tags` block:
```tsx
              <span key={t} className="ed-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
```
with
```tsx
              <span key={t} className="ed-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
        <FileChips files={files} onRemove={onRemoveFile} />
```
`FileChips` renders nothing for an empty list, so text notes look as before. The chips sit above Phase 2's `.ed-strip`, so file chips stay out of the lightbox, as Phase 2 asked.

**Impact:** the editor has two new top-bar controls. The note-level reveal shows only when caps and a local image or file allow it. The paperclip shows only when App passes `onAttachFiles`. Phase 2's Esc seam, strip and lightbox are untouched. Clicking the paperclip moves focus off the textarea, so the existing blur-save runs first, the same as any other top-bar button.

### Step 7: `NoteEditor` tests
**File:** `web/src/components/NoteEditor.test.tsx`
Imports (lines 1-6 as Phase 2 leaves them: Phase 2 Step 6 added `screen` to line 3, `import { cleanup, fireEvent, render, screen } from '@testing-library/react';`) become:
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Note, NoteFile, NoteImage as NoteImageData } from '../types';
import { makeFile, makeImage, makeNote } from '../testing/fixtures';
import { NoteEditor, type NoteEditorProps } from './NoteEditor';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';
```
Append after Phase 2's `describe('NoteEditor lightbox', …)` block (the end of the file after Phase 2). Phase 2's lightbox cases are not touched.
```tsx
describe('NoteEditor files (R2)', () => {
  beforeEach(() => resetCapabilitiesForTests({ reveal: false }));
  afterEach(() => resetCapabilitiesForTests());

  const withFiles = (files: NoteFile[]): Note => makeNote('A-B32', 'with files', { files, tags: [], created: iso });

  it('the paperclip opens a hidden multi-file picker and hands the picked files over once, in order', () => {
    const onAttachFiles = vi.fn();
    const { container, getByLabelText } = renderEditor(note('x'), { onAttachFiles });
    const input = container.querySelector('input[data-picker]') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.hidden).toBe(true);
    const click = vi.spyOn(input, 'click');
    fireEvent.click(getByLabelText('Attach files'));
    expect(click).toHaveBeenCalledTimes(1);
    const a = new File(['a'], 'a.pdf', { type: 'application/pdf' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [a, b], configurable: true });
    fireEvent.change(input);
    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(onAttachFiles).toHaveBeenCalledWith([a, b]);
    expect(input.value).toBe('');
  });

  it('an empty pick (dialog cancelled) attaches nothing', () => {
    const onAttachFiles = vi.fn();
    const { container } = renderEditor(note('x'), { onAttachFiles });
    const input = container.querySelector('input[data-picker]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    fireEvent.change(input);
    expect(onAttachFiles).not.toHaveBeenCalled();
  });

  it('has no paperclip without onAttachFiles', () => {
    const { container } = renderEditor(note('x'));
    expect(container.querySelector('[aria-label="Attach files"]')).toBeNull();
    expect(container.querySelector('input[data-picker]')).toBeNull();
  });

  it('shows the note files as chips under the text; the remove icon hands the file to onRemoveFile', () => {
    const f1 = makeFile('F-IL1', { note_id: 'A-B32', name: 'contract.pdf' });
    const f2 = makeFile('F-IL2', { note_id: 'A-B32', position: 1, name: 'notes.txt', mime: 'text/plain', bytes: 5 });
    const onRemoveFile = vi.fn();
    const { container, props } = renderEditor(withFiles([f1, f2]), { onRemoveFile });
    const chips = Array.from(container.querySelectorAll('.ed-panel .fchips .fchip'));
    expect(chips.map((c) => c.getAttribute('data-file'))).toEqual(['F-IL1', 'F-IL2']);
    fireEvent.click(within(chips[1] as HTMLElement).getByLabelText('Remove file'));
    expect(onRemoveFile).toHaveBeenCalledWith(f2);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('renders no chips for a note without files', () => {
    const { container } = renderEditor(note('text only'));
    expect(container.querySelector('.fchips')).toBeNull();
  });

  it('the top bar has a note-level reveal when a file is local and caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderEditor(withFiles([makeFile('F-IL1', { note_id: 'A-B32' })]));
    const btn = container.querySelector('.ed-top [data-reveal-note="A-B32"]') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.className).toBe('ed-btn');
  });
});
```

### Step 8: `NoteCard`: note-level reveal + paperclip count
**File:** `web/src/components/NoteCard.tsx` (as Phase 1 leaves it)

Line 2 becomes:
```tsx
import { ArrowsOutSimple, Check, Copy, Paperclip, Trash } from '@phosphor-icons/react';
```
Line 7 `import { RevealButton } from './RevealButton';` becomes:
```tsx
import { NoteRevealButton } from './NoteRevealButton';
```
In `NoteCardImpl`, after `const draftRef = useRef(note.body);` add:
```tsx
  // Phase 5: live files, local or not (a file on the other laptop still belongs to the note).
  const fileCount = (note.files ?? []).length;
```
In `.card-meta`, Phase 1's lines
```tsx
          {/* Reveal sits right after copy: the "copied" label reserves its width even while hidden, so it goes after. */}
          {note.images.length > 0 && <RevealButton image={note.images[0]} />}
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
```
become
```tsx
          {/* Reveal sits right after copy: the "copied" label reserves its width even while hidden, so it goes after. */}
          {/* Note-level (R2): the note's files folder, or its first image when it has no files. */}
          <NoteRevealButton note={note} />
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          {fileCount > 0 && (
            <span className="card-files" data-files={fileCount} data-tip={fileCount === 1 ? '1 file' : `${fileCount} files`}>
              <Paperclip weight="duotone" />
              {fileCount}
            </span>
          )}
```
**Impact:** Phase 1's footer order is kept (`id, copy, reveal, copied, …, date`). The paperclip count sits after `copied` and before the right-pushed date, never between copy and reveal (Phase 1's contract). For a note without files the button now shows when *any* image is local (before: only when `images[0]` was); for a note with files it shows when some file is local. The click goes to the note-level route: files folder when the note has files, else the first image (Phase 4), and the button never shows for a note the route would answer 404. `RevealButton` is no longer imported by `NoteCard`; the component stays (editor strip, PhotoModal).

**File:** `web/src/styles.css`, after line 100 (`.card-date { margin-left: auto; }`):
```css
/* Phase 5 (R2): paperclip + count for a note with files, left side of the footer. */
.card-files { display: inline-flex; align-items: center; gap: 2px; margin-left: 2px; color: var(--dim); font-size: 10.5px; }
```

### Step 9: Fixtures
**File:** `web/src/testing/fixtures.ts`
Line 1 becomes:
```ts
import type { Note, NoteFile, NoteImage } from '../types';
```
Insert after `makeImage` (after its closing `}`):
```ts
/** A wire `NoteFile` (2 KB PDF on 'lenovo', available). `note_id` defaults to `id`. Phase 5. */
export function makeFile(id: string, over: Partial<NoteFile> = {}): NoteFile {
  const base: NoteFile = {
    id,
    note_id: id,
    position: 0,
    name: 'report.pdf',
    mime: 'application/pdf',
    bytes: 2048,
    host: 'lenovo',
    available: true,
    extraction_status: 'none',
    urls: { download: `/api/files/${id}/download` },
  };
  return { ...base, ...over };
}
```
`MakeNoteOpts` gains (after `updated?: string;`):
```ts
  /** Ready files (Phase 5). Defaults to none. */
  files?: NoteFile[];
```
`makeNote`'s return object becomes:
```ts
  return {
    id,
    body,
    tags: opts.tags ?? tagsOf(body),
    created_at: created,
    updated_at: opts.updated ?? created,
    origin: null,
    images,
    files: opts.files ?? [],
  };
```

### Step 10: `NoteCard` and `RevealMounts` tests
**File:** `web/src/components/NoteCard.test.tsx` (as Phase 1 leaves it)
Change Phase 1's fixtures import line `import { makeNote } from '../testing/fixtures';` to `import { makeFile, makeNote } from '../testing/fixtures';` (Phase 1 already imports `resetCapabilitiesForTests` and `afterEach`). Phase 1's four `describe('NoteCard footer order')` cases stay valid unchanged: their notes have no files, `NoteRevealButton` renders for a local image under the same `aria-label="Show in Explorer"` that `footerSequence` reads, and it renders nothing for a text note or without `caps.reveal`, exactly like the `RevealButton` it replaces. Do not edit them. Append after Phase 1's `describe('NoteCard footer order')`:
```tsx
describe('NoteCard files (R2)', () => {
  afterEach(() => resetCapabilitiesForTests());

  const withFiles = (body: string, available = true) =>
    makeNote('A-B32', body, {
      tags: [],
      created: now.toISOString(),
      files: [
        makeFile('F-IL1', { note_id: 'A-B32', available }),
        makeFile('F-IL2', { note_id: 'A-B32', position: 1, available }),
      ],
    });

  it('a note with files: note-level reveal right after Copy ID, paperclip count before the date', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(withFiles('contract'));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'Show in Explorer', 'copied', 'card-files', 'card-date', 'Expand note']);
    const count = container.querySelector('.card-files') as HTMLElement;
    expect(count.textContent).toBe('2');
    expect(count.dataset.files).toBe('2');
    expect(count.getAttribute('data-tip')).toBe('2 files');
    expect(container.querySelector('[data-reveal-note="A-B32"]')).not.toBeNull();
  });

  it('files all on another machine: the count stays, no reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(withFiles('far', false));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'copied', 'card-files', 'card-date', 'Expand note']);
  });

  it('a text note has no paperclip count', () => {
    const { container } = renderCard(note('plain'));
    expect(container.querySelector('.card-files')).toBeNull();
  });
});
```

**File:** `web/src/components/RevealMounts.test.tsx`
After the `reveals` helper (line 22) add:
```tsx
const noteReveals = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('[data-reveal-note]')).map((b) => b.dataset.revealNote);
```
Replace the two wall-card cases. As Phase 1 leaves them (Phase 1 Step 3 rewrote the first; the second is today's lines 59-72, untouched by Phase 1), they read:
```tsx
  it('wall card: one icon in the meta row, for the cover image, when caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1)]));
    const meta = container.querySelector('.card-meta') as HTMLElement;
    expect(reveals(meta)).toEqual(['K-F07']);
    // Left-aligned: right after the copy-ID button, ahead of the (width-reserving) copied label.
    const btn = meta.querySelector('[data-reveal]') as HTMLElement;
    expect(btn.previousElementSibling?.getAttribute('aria-label')).toBe('Copy ID');
    expect(btn.nextElementSibling?.classList.contains('copied')).toBe(true);
  });

  it('wall card: none for a text note, none when caps.reveal is false, none when the cover is elsewhere', () => {
    resetCapabilitiesForTests({ reveal: true });
    const text = renderCard(note('A-B32', []));
    expect(reveals(text.container)).toEqual([]);
    text.unmount();

    const away = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0, false)]));
    expect(reveals(away.container)).toEqual([]);
    away.unmount();

    resetCapabilitiesForTests({ reveal: false });
    const off = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0)]));
    expect(reveals(off.container)).toEqual([]);
  });
```
Replace both with (the card's button is now `data-reveal-note`, so Phase 1's position assertion moves to that selector):
```tsx
  it('wall card: one note-level icon in the meta row, right after Copy ID, when caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1)]));
    const meta = container.querySelector('.card-meta') as HTMLElement;
    expect(reveals(meta)).toEqual([]);
    expect(noteReveals(meta)).toEqual(['K-F07']);
    // Left-aligned: right after the copy-ID button, ahead of the (width-reserving) copied label.
    const btn = meta.querySelector('[data-reveal-note]') as HTMLElement;
    expect(btn.previousElementSibling?.getAttribute('aria-label')).toBe('Copy ID');
    expect(btn.nextElementSibling?.classList.contains('copied')).toBe(true);
  });

  it('wall card: none for a text note, none when caps.reveal is false, none when every image is elsewhere', () => {
    resetCapabilitiesForTests({ reveal: true });
    const text = renderCard(note('A-B32', []));
    expect(noteReveals(text.container)).toEqual([]);
    text.unmount();

    const away = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0, false)]));
    expect(noteReveals(away.container)).toEqual([]);
    away.unmount();

    // A later local image is enough (the note-level route picks what to show).
    const later = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0, false), img('M-Q11', 'K-F07', 1)]));
    expect(noteReveals(later.container)).toEqual(['K-F07']);
    later.unmount();

    resetCapabilitiesForTests({ reveal: false });
    const off = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0)]));
    expect(noteReveals(off.container)).toEqual([]);
  });
```
Append inside `describe('reveal mount points')`, after the last editor case:
```tsx
  it('editor top bar: one note-level icon besides the per-image strip icons', () => {
    resetCapabilitiesForTests({ reveal: true });
    const n = note('K-F07', [img('K-F07', 'K-F07', 0), img('P-R22', 'K-F07', 1)]);
    const props = { note: n } as NoteEditorProps;
    render(<NoteEditor {...props} />);
    expect(noteReveals(document.body)).toEqual(['K-F07']);
    expect(reveals(document.body)).toEqual(['K-F07', 'P-R22']);
  });
```

### Step 11: `DropOverlay` routing
**File:** `web/src/components/DropOverlay.tsx` (as Phase 3 leaves it). Phase 3 inserted the exported `chatBarHasFocus` (about 8 lines) after `hasFiles` and put `if (chatBarHasFocus()) return;` first in `onPaste`; it changed no import, prop or `enqueue`. Line numbers below are today's; after Phase 3 everything from the props interface down sits about 8 lines lower, so match on the quoted text.

**11a. Imports (lines 1-5).** Replace
```tsx
import { attachImage, type AttachResult } from '../api';
```
with
```tsx
import { attachRouted, type AttachResult } from '../api';
import { pastedFiles, routeFiles, type RoutedFile } from '../lib/files';
```
(`attachImage` is no longer imported here. Phase 3 adds no import to this file.)

**11b. Props (lines 42-49).** Replace the `DropOverlayProps` interface with:
```tsx
export interface DropOverlayProps {
  /** Call once per note returned by POST /api/images. App inserts it and switches text -> all. */
  onImageAdded: (note: Note) => void;
  /** The note open in the big editor, or null. When set, files attach to it instead of making new notes. */
  target?: string | null;
  /** Called once per attach (target set), image or file, with the server's result and the note id it was sent to. */
  onAttached?: (result: AttachResult, target: string) => void;
  /** Phase 5: an attach (target set) failed, e.g. 413 too large. The file still is not attached. */
  onAttachFailed?: (file: File, err: unknown) => void;
}
```

**11c. Refs + sync effect (lines 51-62).** Replace
```tsx
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
```
with
```tsx
export function DropOverlay({ onImageAdded, target = null, onAttached, onAttachFailed }: DropOverlayProps) {
  const [dragging, setDragging] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const addedRef = useRef(onImageAdded);
  const attachedRef = useRef(onAttached);
  const failedRef = useRef(onAttachFailed);
  const targetRef = useRef<string | null>(target);

  useEffect(() => {
    addedRef.current = onImageAdded;
    attachedRef.current = onAttached;
    failedRef.current = onAttachFailed;
    targetRef.current = target;
  }, [onImageAdded, onAttached, onAttachFailed, target]);
```

**11d. `enqueue` (lines 65-83).** Replace the whole `const enqueue = …;` with:
```tsx
    const enqueue = (files: File[]) => {
      const to = targetRef.current;
      // Open note (R2): images keep the image path and every other file goes to /files, in order.
      // No open note: only images, each a new photo note (non-images are ignored, as before).
      const jobs: RoutedFile[] = to ? routeFiles(files) : imageFiles(files).map((file): RoutedFile => ({ kind: 'image', file }));
      for (const job of jobs) {
        queue.current = queue.current.then(async () => {
          try {
            if (to) {
              const result = await attachRouted(to, job);
              attachedRef.current?.(result, to);
            } else {
              const result = await uploadImage(job.file);
              addedRef.current(result.note);
              if (!result.created) flashNote(result.note.id);
            }
          } catch (err) {
            console.error(to ? '[attach]' : '[upload]', job.file.name, err);
            if (to) failedRef.current?.(job.file, err);
          }
        });
      }
    };
```

**11e. `onDrop` (line 97).** Replace `enqueue(imageFiles(e.dataTransfer?.files));` with:
```tsx
      enqueue(Array.from(e.dataTransfer?.files ?? []));
```

**11f. `onPaste`.** Phase 3 left it as:
```tsx
    const onPaste = (e: ClipboardEvent) => {
      if (chatBarHasFocus()) return;
      const file = firstImageFile(e.clipboardData?.files);
      if (!file) return;
      e.preventDefault();
      enqueue([file]);
    };
```
Keep Phase 3's ChatBar-focus early return as the first statement. Replace the four lines after it:
```tsx
      const file = firstImageFile(e.clipboardData?.files);
      if (!file) return;
      e.preventDefault();
      enqueue([file]);
```
with
```tsx
      // Open note: every pasted file attaches to it. Otherwise only the first image makes a new note.
      // A text-only paste carries no files and falls through to the focused field untouched.
      const files = pastedFiles(e.clipboardData?.files, targetRef.current !== null);
      if (files.length === 0) return;
      e.preventDefault();
      enqueue(files);
```
`imageFiles`, `firstImageFile` and `hasFiles` stay exported (tests and possibly other importers use them). `firstImageFile` is no longer called inside the component. It is exported, so `noUnusedLocals` does not flag it.

**Impact:**
- Behavior change only while a note is open. A dropped PDF used to be dropped silently. Now it attaches as a file. A pasted non-image file now attaches.
- Outside the editor nothing changes.
- Phase 3's ChatBar guard still runs first, so a paste into the focused ChatBar never reaches this code.

### Step 12: `DropOverlay` tests
**File:** `web/src/components/DropOverlay.test.tsx`
Replace the case `'with a target, dropped images attach one at a time and a dedupe result is passed through'` (lines 165-178) with:
```tsx
  it('with a target, dropped files attach one at a time in order: images to /images, others to /files; a dedupe result is passed through', async () => {
    const dup = { note: { id: 'K-F07', body: '', tags: [], created_at: '', updated_at: '', origin: null, images: [], files: [] }, attached: false };
    fetchMock.mockImplementation(async () => okResponse(dup));
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={onAttached} />);
    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [png, txt, jpg] }));
    });
    await flush();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/notes/A-B32/images', '/api/notes/A-B32/files', '/api/notes/A-B32/images']);
    expect((((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData).get('file') as File).name).toBe('a.txt');
    expect(onAttached).toHaveBeenCalledTimes(3);
    expect(onAttached.mock.calls[0]![0]).toMatchObject({ attached: false, note: { id: 'K-F07' } });
  });
```
Append inside `describe('DropOverlay')`, before its closing `});`:
```tsx
  it('with a target, a pasted non-image file attaches to that note as a file', async () => {
    const attached = { note: { id: 'A-B32', body: '', tags: [], created_at: '', updated_at: '', origin: null, images: [], files: [] }, attached: true, kind: 'file' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(attached), { status: 201, headers: { 'content-type': 'application/json' } }));
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={onAttached} />);
    const e = eventWith('paste', 'clipboardData', { files: [txt] });
    act(() => {
      document.dispatchEvent(e);
    });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notes/A-B32/files');
    expect(init.method).toBe('POST');
    expect(((init.body as FormData).get('file') as File).name).toBe('a.txt');
    expect(onAttached).toHaveBeenCalledWith(attached, 'A-B32');
  });

  it('with a target, a text-only paste (no files) is left to the focused field', () => {
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={() => {}} />);
    const e = eventWith('paste', 'clipboardData', { files: [] });
    act(() => {
      document.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('without a target, a dropped non-image file is ignored', async () => {
    render(<DropOverlay onImageAdded={() => {}} />);
    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [txt] }));
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed attach is reported through onAttachFailed and the queue keeps going', async () => {
    const ok = { note: { id: 'A-B32', body: '', tags: [], created_at: '', updated_at: '', origin: null, images: [], files: [] }, attached: true };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'too_large' }), { status: 413, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 201, headers: { 'content-type': 'application/json' } }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onAttachFailed = vi.fn();
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={onAttached} onAttachFailed={onAttachFailed} />);
    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [txt, png] }));
    });
    await flush();
    expect(onAttachFailed).toHaveBeenCalledTimes(1);
    expect(onAttachFailed.mock.calls[0]![0]).toBe(txt);
    expect((onAttachFailed.mock.calls[0]![1] as { status?: number }).status).toBe(413);
    expect(onAttached).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
```
Phase 3 changed this file's `./DropOverlay` import to `import { DropOverlay, chatBarHasFocus, firstImageFile, hasFiles, imageFiles } from './DropOverlay';` and appended its `chatBarFixture`/`chatBarHasFocus` cases; keep both. The other existing cases are unchanged and still hold: no-target paste of `[txt, png, jpg]` uploads only `b.png`, no-target drop of `[png, txt, jpg]` uploads two images, and target paste of `[png]` goes to `/images`. Phase 3's ChatBar-focus case is untouched.

### Step 13: `App.tsx`: empty rule, attach queue, file undo, wiring
**File:** `web/src/App.tsx` (as Phase 3 leaves it). Phase 3 adds `import { useChatImages } from './hooks/useChatImages';` after the `useChat` import, `const chatImages = useChatImages();` after `const chat = useChat();`, rewrites `send`, adds `images={chat.images}` to `AnswerPanel` and replaces the `<ChatBar …/>` element (it now spans several lines, just above `<DropOverlay`). Phase 3 changes neither the `./api` import on line 5, nor `commit`/`closeEditor`/`onAttached`/`removeImageWithUndo`, nor the `<DropOverlay>`/`<NoteEditor>` elements. The line numbers below are today's (main); after Phase 3 everything past line 8 sits 2+ lines lower, so match on the quoted text, not the number.

**13a. Imports.** In the `./api` import (line 5, untouched by Phase 3), add `ApiError, attachRouted, DuplicateFileError, removeFile, restoreFile` to the names already there. The line becomes:
```tsx
import { ApiError, attachRouted, createNote, deleteNote, DuplicateFileError, DuplicateImageError, fetchBin, fetchNote, removeFile, removeImage, restoreFile, restoreImage, restoreNote, updateNote, type AttachResult } from './api';
```
Line 6 becomes:
```tsx
import type { Mode, Note, NoteFile, NoteImage as NoteImageData, View } from './types';
```
After `import { planReveal, tagsKeeping } from './lib/reveal';` add:
```tsx
import { hasAttachments, routeFiles } from './lib/files';
```

**13b. `commit` empty rule (line 138).** Replace
```tsx
      if (!draft.trim() && note.images.length === 0) {
```
with
```tsx
      // Empty = no text, no images and no files (R2): a note holding only files is kept.
      if (!draft.trim() && !hasAttachments(note)) {
```

**13c. `closeEditor` empty rule (lines 175 and 181).** Replace the doc comment
```tsx
  /** Big editor closed (X, backdrop, Esc). The empty rule applies only here; Notes. -> Everything. when it now has images. */
```
with
```tsx
  /** Big editor closed (X, backdrop, Esc). The empty rule (no text, images or files) applies only here; Notes. -> Everything. when it now has images. */
```
and
```tsx
      if (!draft.trim() && latest.images.length === 0) {
```
with
```tsx
      if (!draft.trim() && !hasAttachments(latest)) {
```

**13d. Attach queue and failure notice.** Directly after the `onAttached` `useCallback` (ends line 206) add:
```tsx
  /** An attach to the open note failed (413, 415, 409 race, offline). Said quietly in the editor; nothing else changes. */
  const onAttachFailed = useCallback(
    (file: File, err: unknown) => {
      if (err instanceof DuplicateFileError || err instanceof DuplicateImageError) {
        showNotice(`already in ${err.noteId}`);
        return;
      }
      const why = err instanceof ApiError && err.status === 413 ? ' (too large)' : '';
      showNotice(`could not attach ${file.name || 'file'}${why}`);
    },
    [showNotice],
  );

  // The paperclip picker's own serial queue (DropOverlay keeps one for drop/paste): one upload at a time, in pick order.
  const attachQueue = useRef<Promise<void>>(Promise.resolve());

  /** Files picked in the big editor: images to /images, everything else to /files (lib/files routeFiles). */
  const attachFiles = useCallback(
    (noteId: string, files: File[]) => {
      for (const job of routeFiles(files)) {
        attachQueue.current = attachQueue.current.then(async () => {
          try {
            onAttached(await attachRouted(noteId, job));
          } catch (err) {
            console.error('[attach]', job.file.name, err);
            onAttachFailed(job.file, err);
          }
        });
      }
    },
    [onAttached, onAttachFailed],
  );
```

**13e. File remove with undo.** Directly after `removeImageWithUndo` (ends line 274) add:
```tsx
  /** A file chip's remove icon (R2): soft remove one file, 6 s undo puts it back. Mirrors removeImageWithUndo. */
  const removeFileWithUndo = useCallback(
    (file: NoteFile) => {
      const owner = notesRef.current.find((n) => n.id === file.note_id);
      if (owner) upsertLocal({ ...owner, files: (owner.files ?? []).filter((f) => f.id !== file.id) });
      const done = (async () => {
        try {
          upsertLocal(await removeFile(file.id));
        } catch (e) {
          console.error('remove file failed', e);
        } finally {
          refetch();
        }
      })();
      pushUndo({
        label: 'removed file',
        run: async () => {
          await done;
          try {
            upsertLocal(await restoreFile(file.id));
          } catch (e) {
            if (e instanceof DuplicateFileError) console.warn(`file already in ${e.noteId}`);
            else throw e;
          } finally {
            refetch();
          }
        },
      });
    },
    [upsertLocal, refetch, pushUndo],
  );
```

**13f. `DropOverlay` JSX (line 452).** Replace
```tsx
        <DropOverlay onImageAdded={onImageAdded} target={expandedNote ? expandedNote.id : null} onAttached={onAttached} />
```
with (Phase 3 leaves this element as it is on main):
```tsx
        <DropOverlay onImageAdded={onImageAdded} target={expandedNote ? expandedNote.id : null} onAttached={onAttached} onAttachFailed={onAttachFailed} />
```

**13g. `NoteEditor` JSX (lines 455-467).** Replace
```tsx
              onRemoveImage={removeImageWithUndo}
```
with
```tsx
              onRemoveImage={removeImageWithUndo}
              onAttachFiles={(files) => attachFiles(expandedNote.id, files)}
              onRemoveFile={removeFileWithUndo}
```
(`expandedNote` is a `const` narrowed by the surrounding `expandedNote && createPortal(…)`, so the closure sees it as non-null.)

**Impact:**
- A note with only files (empty text) survives both the inline blur-commit and the editor close. A file attach result (or dedupe hit, "already in X") goes through the same `onAttached` as images. Failures show "could not attach <name>" in the editor's notice label.
- Gallery and photo mode are untouched. `photosOf`/`visibleOnWall` still classify by images, so a files-only note stays a text note.
- Leaves Phase 3's `send`/`ChatBar`/`useChat` edits alone.

### Step 14: App integration tests
**File:** `web/src/App.test.tsx`
Imports (lines 4-6) become:
```tsx
import type { Note, NoteFile } from './types';
import { App } from './App';
import { makeFile, makeImage, makeNote } from './testing/fixtures';
```
Append at the end of the file:
```tsx
describe('App note files (R2)', () => {
  type Call = { method: string; url: string; file: string | null };
  let calls: Call[];
  let server: Note[];
  let removed: Map<string, NoteFile>;
  let fileReply: (noteId: string, name: string) => { status: number; body: unknown };

  const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const paste = (files: File[]) => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files } });
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
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    calls = [];
    removed = new Map();
    server = [
      makeNote('A-B32', '#seer onboarding is long', { created: iso }),
      makeNote('C-D45', 'buy fennel #kitchen', { created: iso, files: [makeFile('F-IL1', { note_id: 'C-D45', name: 'receipt.pdf' })] }),
    ];
    let seq = 0;
    fileReply = (noteId, name) => {
      const n = server.find((x) => x.id === noteId)!;
      const files = n.files ?? [];
      seq += 1;
      const f = makeFile(`F-NW${seq}`, { note_id: noteId, name, mime: 'text/plain', bytes: 5, position: files.length });
      return { status: 201, body: { note: { ...n, files: [...files, f] }, attached: true, kind: 'file' } };
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const file = init?.body instanceof FormData ? ((init.body.get('file') as File | null)?.name ?? null) : null;
        calls.push({ method, url, file });
        if (method === 'GET' && url.startsWith('/api/notes')) return reply({ notes: server, next_cursor: null });
        if (method === 'GET' && url.startsWith('/api/tags')) return reply([]);
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
        const files = url.match(/^\/api\/notes\/([^/]+)\/files$/);
        if (files && method === 'POST') {
          const r = fileReply(files[1]!, file ?? 'file');
          if (r.status === 201) {
            const next = (r.body as { note: Note }).note;
            server = server.map((n) => (n.id === next.id ? next : n));
          }
          return reply(r.body, r.status);
        }
        const images = url.match(/^\/api\/notes\/([^/]+)\/images$/);
        if (images && method === 'POST') {
          const n = server.find((x) => x.id === images[1])!;
          const next = { ...n, images: [...n.images, makeImage('P-IC1', { note_id: n.id, mime: 'image/png' })] };
          server = server.map((x) => (x.id === n.id ? next : x));
          return reply({ note: next, attached: true }, 201);
        }
        const rm = url.match(/^\/api\/files\/([^/]+)$/);
        if (rm && method === 'DELETE') {
          const owner = server.find((n) => (n.files ?? []).some((f) => f.id === rm[1]))!;
          const gone = (owner.files ?? []).find((f) => f.id === rm[1])!;
          removed.set(gone.id, gone);
          const next = { ...owner, files: (owner.files ?? []).filter((f) => f.id !== rm[1]) };
          server = server.map((n) => (n.id === owner.id ? next : n));
          return reply(next);
        }
        const rs = url.match(/^\/api\/files\/([^/]+)\/restore$/);
        if (rs && method === 'POST') {
          const f = removed.get(rs[1]!)!;
          const owner = server.find((n) => n.id === f.note_id)!;
          const next = { ...owner, files: [...(owner.files ?? []), f].sort((a, b) => a.position - b.position) };
          server = server.map((n) => (n.id === owner.id ? next : n));
          return reply(next);
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  it('pasting a non-image file while the editor is open attaches it to that note as a chip', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('.fchip[data-file="F-NW1"]')).not.toBeNull());
    expect(of('POST', '/api/notes/A-B32/files')).toHaveLength(1);
    expect(of('POST', '/api/notes/A-B32/files')[0]!.file).toBe('notes.txt');
    expect(calls.some((c) => c.url.endsWith('/images'))).toBe(false);
  });

  it('outside the editor a non-image paste is ignored', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    paste([txt]);
    await tick();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('the paperclip picker routes files to /files and images to /images, in pick order', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    fireEvent.click(within(editor()!).getByLabelText('Attach files'));
    const input = editor()!.querySelector('input[data-picker]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [txt, png], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(of('POST', '/api/notes/A-B32/images')).toHaveLength(1));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/notes/A-B32/files', '/api/notes/A-B32/images']);
    await waitFor(() => expect(editor()!.querySelector('.fchip[data-file="F-NW1"]')).not.toBeNull());
  });

  it('a file dedupe hit says quietly which note holds it', async () => {
    fileReply = () => ({ status: 200, body: { note: server.find((n) => n.id === 'C-D45')!, attached: false, kind: 'file' } });
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('already in C-D45'));
    expect(editor()!.querySelector('.fchip')).toBeNull();
  });

  it('a failed attach says so in the editor', async () => {
    fileReply = () => ({ status: 413, body: { error: 'too_large' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('could not attach notes.txt (too large)'));
    vi.mocked(console.error).mockRestore();
  });

  it('a note holding only files is kept when emptied in the editor and closed', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    expandCard('C-D45');
    fireEvent.change(edText(), { target: { value: '' } });
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    await tick();
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
    expect(card('C-D45')).not.toBeNull();
  });

  it('a note holding only files is kept when emptied inline on the card', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    fireEvent.click(card('C-D45').querySelector('.card-text') as HTMLElement);
    const ta = card('C-D45').querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.blur(ta);
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    await tick();
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
    expect(card('C-D45')).not.toBeNull();
  });

  it('the card shows a paperclip count for a note with files', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    expect(card('C-D45').querySelector('.card-files')?.textContent).toBe('1');
    expect(card('A-B32').querySelector('.card-files')).toBeNull();
  });

  it('removing a file chip soft-removes it; Undo restores it', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    expandCard('C-D45');
    const chip = () => editor()!.querySelector('.fchip[data-file="F-IL1"]') as HTMLElement | null;
    expect(chip()).not.toBeNull();
    fireEvent.click(within(chip()!).getByLabelText('Remove file'));
    expect(chip()).toBeNull();
    await waitFor(() => expect(of('DELETE', '/api/files/F-IL1')).toHaveLength(1));
    expect(document.querySelector('[data-undo] .undo-label')?.textContent).toBe('removed file');
    fireEvent.click(screen.getByLabelText('Undo'));
    await waitFor(() => expect(of('POST', '/api/files/F-IL1/restore')).toHaveLength(1));
    await waitFor(() => expect(chip()).not.toBeNull());
  });
});
```
Notes for the implementer:
- `GET /api/capabilities` falls through to the 404 branch, so `reveal` stays false and no reveal buttons render here. Reveal is covered by the component tests.
- Phase 4 types the web `Note.files` as optional, so the existing hand-written `Note` literals in `App.test.tsx` (lines 146, 166, 195, 338 today) and `DropOverlay.test.tsx` need no change. Only `makeNote` (Step 9) gains `files: []`; no other phase adds it.
- Add one case for the 409 race, after `'a failed attach says so in the editor'`:
```tsx
  it('a 409 duplicate_file on attach says which note holds the bytes', async () => {
    fileReply = () => ({ status: 409, body: { error: 'duplicate_file', note_id: 'C-D45', message: 'already attached' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('already in C-D45'));
    vi.mocked(console.error).mockRestore();
  });
```

### Step 15: Docs
**File:** `README.md`, "The big editor" bullets (today's lines 157-165; Phase 2 edits the bullets just above, so match on the text). Replace the bullet
```markdown
- While the editor is open, a dropped or pasted image is attached to this note instead of
  becoming a new one. The drop overlay shows a paperclip instead of the usual image icon to say
  so. A file that already lives in a note is not attached twice. The editor quietly says which
  note holds it.
```
with
```markdown
- While the editor is open, anything you drop or paste is attached to this note instead of
  becoming a new one. Photos go to the photo strip. Any other file (PDF, spreadsheet, zip, …)
  becomes a file chip under the text. The paperclip button in the editor's top bar opens a file
  picker for the same thing. The drop overlay shows a paperclip instead of the usual image icon
  to say so. A file that already lives in a note is not attached twice. The editor quietly says
  which note holds it.
- A file chip shows the file's name, size and type, with a download icon and its own "Show in
  Explorer". Removing a chip is soft. You get the usual 6 s undo, and the file is removed for good
  only when its note is purged from the bin. A file whose bytes are on the other laptop is dimmed
  and cannot be downloaded from here. Cards show a paperclip and the number of files.
```
and the bullet
```markdown
- Emptying the text does not delete the note while the editor is open. On close, a note with no
  text and no photos goes to the recycle bin, the same rule as on the wall.
```
with
```markdown
- Emptying the text does not delete the note while the editor is open. On close, a note with no
  text, no photos and no files goes to the recycle bin, the same rule as on the wall.
```
**File:** `README.md:246-251` ("Open file location"). Replace the first paragraph with:
```markdown
Wall cards and the editor's top bar have a note-level folder icon ("Show in Explorer"). For a
note with files it opens the note's files folder. For a note with only photos it selects the
first photo. The photo modal, each photo in the editor strip and each file chip have their own
icon for that one photo or file. Gallery tiles don't; open the photo and use the modal's.
Clicking one opens Windows Explorer. `notesd` turns the stored path into a Windows path with
`wslpath -w` and starts `explorer.exe`. It does not wait for Explorer, whose exit code means nothing.
```
**File:** `CHANGELOG.md`, under `## [Unreleased]` → `### Added`. Create `## [Unreleased]` (above `## [v0.1.0] - 2026-10-30`) and/or `### Added` only if missing; earlier phases (1-4) normally created both, so this is usually one appended bullet:
```markdown
- Note files on the wall: a paperclip picker, drop and ctrl-v in the note editor attach any file. Files show as chips with download, reveal and undoable remove. Cards show a file count. The note-level "Show in Explorer" opens the note's files folder.
```

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:**
- Focused: `npx vitest run web/src/lib/files.test.tsx web/src/components/FileChips.test.tsx web/src/components/NoteRevealButton.test.tsx web/src/components/NoteEditor.test.tsx web/src/components/NoteCard.test.tsx web/src/components/RevealMounts.test.tsx web/src/components/DropOverlay.test.tsx web/src/components/RevealButton.test.tsx web/src/App.test.tsx`
- Full: `npm test`, then `npm run test:int` (Invariant 1. No server change, so it must stay green as Phase 4 left it.)
**Manual check:** run `npm run build`, then restart notesd (or `npm run dev` plus `npm run dev:web`) and open http://localhost:7317.
1. Expand a text note. Click the paperclip and pick a PDF and a PNG. The PDF appears as a chip (`2 KB · PDF`-style meta), and the PNG appears in the photo strip.
2. Ctrl-v a copied file from Explorer into the open editor. It attaches as a chip. Ctrl-v the same file into another note. The editor says `already in <id>`.
3. Click a chip's download icon. The browser saves the file under its original name. Click its folder icon. Explorer selects the file.
4. Remove the chip. The undo bar says `removed file`. Undo brings it back.
5. Empty the text of a note that only has files and close it. The note stays, and the card shows a paperclip count.
6. The card footer's folder icon sits right after copy-ID and opens the files folder.
7. Outside the editor, pasting a PDF does nothing. Pasting into the focused ChatBar is still handled by the bar (Phase 3).
8. Clicking a strip thumbnail still opens the lightbox, and Esc closes only the lightbox (Phase 2).
**Exit criteria:**
- Picker, paste, drop, chips, undo, dedupe notice, reveal calls and both empty-note paths are covered by passing tests.
- A note holding only files is not auto-deleted on close or on inline commit.
- `npm run typecheck`, `npm test`, `npm run test:int` and `npm run build` are green.

## Handoffs

- **Phase 4 (R2):** reconciled. This plan uses Phase 4's wire as written in phase-4.md (see Requires). The web `Note.files` stays optional; this phase is the only one that adds `files: []` to `makeNote`, and no hand-written `Note` literal needs it.
- **Phase 1 (R6):** this plan changes what sits in the footer slot, not where it sits. Phase 1's four `footerSequence` cases stay valid unchanged. Its first `RevealMounts` wall-card case is rewritten in Step 10, because the card's button is now `data-reveal-note`, not `data-reveal`.
- **Phase 9, 10, 11 (R3), which edit `App.tsx` after this phase:** quote it as Phase 5 leaves it. Phase 5 changes these anchors and must keep them: the `./api` import line (adds `ApiError, attachRouted, DuplicateFileError, removeFile, restoreFile`); the `./types` import (adds `NoteFile`); a new `import { hasAttachments, routeFiles } from './lib/files';` after the `./lib/reveal` import; `commit`'s empty rule (`if (!draft.trim() && !hasAttachments(note)) {` with a comment line above it); `closeEditor`'s doc comment and `if (!draft.trim() && !hasAttachments(latest)) {`; new `onAttachFailed`, `attachQueue`, `attachFiles` right after `onAttached`; new `removeFileWithUndo` right after `removeImageWithUndo`; `<DropOverlay … onAttached={onAttached} onAttachFailed={onAttachFailed} />`; and in `<NoteEditor>` the two lines `onAttachFiles={(files) => attachFiles(expandedNote.id, files)}` / `onRemoveFile={removeFileWithUndo}` right after `onRemoveImage={removeImageWithUndo}`. Phase 5 does not touch the imports of React/hooks, the `view` state, `toggleBin`, the Esc effect, `send`, `<Rail>`…`<ChatBar>` or `<AnswerPanel>`.
- **Phase 11 (R3), which edits `NoteEditor.tsx` after this phase:** quote it as Phases 2 and 5 leave it. Phase 5 changes: line 2 `import { Check, Copy, Paperclip, Trash, X } from '@phosphor-icons/react';`; line 3 `import type { Note, NoteFile, NoteImage as NoteImageData, TagCount } from '../types';`; `import { FileChips } from './FileChips';` and `import { NoteRevealButton } from './NoteRevealButton';` just above `import './NoteEditor.css';` (after Phase 2's `Lightbox` import); the props interface now ends `closeSignal?: number;` + `onAttachFiles?` + `onRemoveFile?` before `}`; the signature is `export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage, onDelete, onAttachFiles, onRemoveFile, tags: knownTags = [], closeSignal = 0 }: NoteEditorProps) {`; `pickerRef` and `const files = note.files ?? [];` after `pendingCaret`; in `.ed-top`, right after `<span className="ed-spacer" />`, `<NoteRevealButton note={note} className="ed-btn" />` then the paperclip button + hidden `input[data-picker]` (inside `{onAttachFiles && (<>…</>)}`), then the existing trash and close; `<FileChips files={files} onRemove={onRemoveFile} />` right after the `.ed-tags` block, before Phase 2's `.ed-strip`. Phase 11's show-on-wall icon goes in the same `.ed-top` row after `ed-spacer`. Phase 2's Esc yield, strip and `<Lightbox>` stay as they are.
- **Not done (out of scope / possible follow-up):**
  - Upload progress for big files (one silent request per file, failures shown as a notice).
  - Reordering file chips.
  - Files in the bin view (plan Decisions: not in v1).
  - Moving `RevealButton` usage in `PhotoModal`/strip to anything else (unchanged).
  - The pre-existing mismatch where the card cover uses the first *available* image (now irrelevant to reveal, since the note-level route decides).

## Rollback

Revert this phase's commit(s): `git revert <phase-5 commits>`. It touches only web files plus README/CHANGELOG, with no data or schema. Files attached through the UI stay in the DB and `files/` (Phase 4's store). They are still visible to MCP tools and removable through Phase 4's API. After the revert the wall just stops showing them, and the empty-note rule goes back to text+images. A note holding only files and no text could then be deleted when you close its editor (soft delete, restorable from the bin). That is the one behavioral risk of a partial revert.
