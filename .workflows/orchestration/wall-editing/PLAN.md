# Plan: Wall editing (mcp-notes iteration 7)

**Slug:** wall-editing
**Date:** 2026-10-30T15:37:29+07:00
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/wall-editing`
**Branch:** `feature/wall-editing` (base: `origin/main` @ `f899905`)
**Phases:** 11
**Status:** phase 5/11 complete — in progress; phases 1, 2, 5 and 11 done (4 of 11)
**Coordinator:** —

---

## Why

Verbatim from `docs/iterations/07-wall-editing.md` (full text in the analysis document under "Original User Request"). The owner's own words:

> mcp-notes features
> - add expand button to note item, so, i can:
> 1. click add new note, and type in in the small note for short text, but if i need to typed in
>    long text, i can click "zoom in" button, and we can edit text in a big pop up modal. dropping
>    an image when this modal pop will automatically attach this image into the note that we are
>    editing.
> - add a delete button to note item . deleting an image note will move it to our own "recycle
>   bin" so i can easily check "deleted" image if needed
> - for image note, can we add a "open file location" button that will open windows explorer and
>   open the dir path and select the file?

> Decisions already made with the owner:
>   - A note can hold several images (like Google Keep), not one. Dropping an image into a note
>     that already has images adds another.
>   - The recycle bin holds every deleted note, text and image, not only image notes.

> The "Fixed decisions" table in docs/ROADMAP.md is binding except where this brief explicitly
> changes it (one change: a note may now hold several images; see R1).

> Out of scope: rich text or markdown rendering in notes, reordering images by drag (order is
> attach order; removing and restoring keeps position), image editing or cropping, a bin auto-purge
> timer, mobile layout, sync of images to other machines.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Several images per note: per-image table, lossless live migration (old columns kept), per-live-image dedupe, wire `images[]` with every consumer moved, per-image derivatives, HTTP + MCP attach and soft remove of one image | 1, 2, 3, 6, 10 |
| R2 | Big editor modal from an expand icon on every card; save on blur/close; Esc; drop/paste attaches to the edited note with an attach overlay icon; Notes.→Everything. on close; empty-note rule on close only | 7 |
| R3 | Delete icon on card/editor/modal, soft + quiet undo; "Deleted." bin view (rail + sidebar trash icon) with image grid on top, restore and inline-confirmed delete forever (rows + original + derived files), UI-only, tag filters, live-only sidebar counts | 4, 8 |
| R4 | Folder icon (photo cards, modal, editor strip) → notesd runs `explorer.exe /select,<wslpath -w>`; image id only; own-Origin only; icon only when local + WSL interop (capabilities endpoint); spawn-only success | 5, 9 |
| R6 | Collapsible answer panel: caret icon beside pin/dismiss; collapsed = header line only above the chat bar; new answers open expanded; streaming continues collapsed; click the line to expand; pin/dismiss/Esc and wall highlight unchanged | 11 |
| R7 | Multi-line chat bar: textarea, Enter sends, Shift+Enter newline, IME-safe; grows to ~6 lines then scrolls, send button bottom right, shrinks after send; panel stays above it; newlines reach /api/chat; header query on one line with ellipsis + tooltip | 11 |
| R5 | Unit/component + integration tests for all of the above; README photo/gallery/modal text updated | 1–11 (each phase's own tests), 10 (docs) |

R1 spans five phases by construction: the table + migration (1), the cutover of every server read/write path and the web-independent wire (2), attach/remove (3), the web consumers (6), and applying migration 0002 to the live Neon database (10). R3 and R4 each split into a server phase and a web phase. R6 and R7 were added by the owner mid-planning (origin/main `e78e3e4`, `920b419`); they share one small web phase (11) because both change the chat bar / answer panel pair and R7's one-line query display is the collapsed line R6 introduces.

## Scope

**In scope:** `drizzle/0002_*` + meta, `src/db/schema.ts`, `src/notes/**`, `src/images/**`, `src/http/**`, `src/mcp/**`, `src/chat/status.ts`, `src/chat/prompt.ts` (one sentence), `src/background.ts`, `web/src/**`, tests, `README.md`, `claude/skills/n/SKILL.md`, `docs/INSTALL.md`. Applying migration 0002 to Neon (phase 10).

**Out of scope:** the brief's out-of-scope list; the connectors; embeddings logic (text only — unaffected); `deploy/notesd.service` (no change needed, see Decisions); dropping `notes.image_path` / `notes.image_meta` (a later migration); restarting the installed daemon (the owner runs `scripts/install.sh` after landing, as in iterations 5–6).

## Invariants

1. `npm run typecheck`, `npm test` and `npm run test:int` pass at the end of every phase.
2. Originals are never moved, renamed, re-encoded or overwritten. Purge (delete forever) is the only code that unlinks an original, and only the files named by the rows it deletes.
3. No MCP tool can permanently delete anything. Every MCP removal is soft and reversible through MCP.
4. Migration 0002 is additive: it creates `note_images` and copies; it never alters or drops an existing column, index or row. Every legacy image (live notes and soft-deleted notes) gets exactly one `note_images` row.
5. Fixed decisions in `docs/ROADMAP.md` hold: icon-only controls, Phosphor duotone from `@phosphor-icons/react`, custom `[data-tip]` tooltip, no text on buttons, hairlines, no shadows, no rounded cards, `#121211` / `#ecebe4`, Host Grotesk + Geist Mono, the giant heading.
6. Tags and counts in the sidebar (`GET /api/tags`) count live notes only.
7. Phases 6–9 never edit the `<AnswerPanel …/>` and `<ChatBar …/>` JSX elements in `web/src/App.tsx`, `App.send`, the chat Esc effect, `ChatBar.tsx`, `AnswerPanel.tsx`, `useChat.ts`, or the `.answer*` / `.chatbar` / `.sendbtn` rules in `styles.css`; phase 11 owns them and runs concurrently with the rest, so its hunks must not overlap theirs. Phase 11 keeps its new CSS in `web/src/components/ChatBar.css` (imported by `ChatBar.tsx`) and edits only the existing chat rules in `styles.css`.
8. A fresh worktree has no `.env.local`; phases that need it (drizzle-kit generate, Neon migrate) symlink it: `ln -sf /home/miftah/mcp-notes/.env.local .env.local`. Integration tests never touch Neon (`tests/integration/setup.ts` refuses).

## Contract (binding on every phase)

### Table `note_images` — phase 1 (`src/db/schema.ts`, `drizzle/0002_note_images.sql`)
```ts
export const noteImages = pgTable('note_images', {
  id: text('id').primaryKey(),                       // note-id format (A-B32). See "Image ids".
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),                      // relative to dataDir: images/YYYY/MM/<id>.<ext>
  sha256: text('sha256').notNull(),
  mime: text('mime').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  bytes: integer('bytes').notNull(),                 // <= 200 MB cap fits int4
  takenAt: timestamp('taken_at', { withTimezone: true, mode: 'date' }),
  originalName: text('original_name'),
  host: text('host'),
  position: integer('position').notNull(),           // attach order; never renumbered
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }), // removed from its note (in the bin)
}, (t) => [
  uniqueIndex('note_images_path_uniq').on(t.path),
  index('note_images_note_position_idx').on(t.noteId, t.position),
  uniqueIndex('note_images_sha256_live_uniq').on(t.sha256).where(sql`${t.deletedAt} is null`),
  index('note_images_taken_at_idx').on(t.takenAt),
]);
export type NoteImageRow = typeof noteImages.$inferSelect;
```
`notes.image_path`, `notes.image_meta` and their two indexes stay in `schema.ts` (commented "legacy, read only by the reconcile; dropped in a later migration") so drizzle-kit generates no drop.

### Legacy copy + reconcile — phase 1 (`src/images/legacy.ts`)
`reconcileLegacyImages(db: Executor): Promise<number>` — inserts one `note_images` row for every `notes` row with `image_path is not null and image_meta is not null` that has no `note_images` row whose `id = notes.id`; returns rows inserted. Row values: `id = note_id = notes.id`, `path = image_path`, fields from `image_meta` (`taken_at` cast to timestamptz), `position = 0`, `created_at = notes.created_at`. `deleted_at = null`, **except** when that would break `note_images_sha256_live_uniq` (an existing live row, or an earlier candidate in the same batch, has the same sha256 — candidates ranked live notes first, then most recently deleted): then `deleted_at = coalesce(notes.deleted_at, now())`, so the image is kept and shows in the bin. One INSERT…SELECT; idempotent. Migration 0002's hand-appended data statement is the same SQL. Phase 2 calls it once at daemon start (`src/background.ts`) so images the old daemon ingests between the Neon migration and the restart are picked up.

### Image ids
Same format and generator as note ids (`src/notes/ids.ts`). A note created with an image (upload, inbox, `create_image`, legacy copy) gives that **first image the note's own id**; images attached later get a fresh id that is free in both `notes.id` and `note_images.id`. `NotesService.newId()` also checks `note_images.id`. Consequences: legacy derivatives in `cache/<noteId>/` stay valid; `/full/<noteId>` and `/api/notes/<noteId>/<variant>` keep working.

### Wire shape — phase 2 (`src/notes/types.ts`), mirrored in phase 6 (`web/src/types.ts`)
```ts
export interface NoteImage {
  id: string;
  note_id: string;
  position: number;
  mime: string; width: number; height: number; bytes: number;
  taken_at: string | null;          // ISO 8601 UTC
  original_name: string | null;
  host: string | null;
  available: boolean;               // original exists under this machine's data dir
  urls: { thumb: string; display: string; original: string; preview: string }; // /api/images/<id>/<variant>
  deleted_at?: string;              // present only on removed images (bin listings)
}
export interface Note { id; body; tags; created_at; updated_at; deleted_at?; origin; images: NoteImage[] }
```
`Note.image` is **removed**. `images` = the note's live images (image `deleted_at is null`), ascending `position`.

### Repo — phase 1 (`src/notes/imageRepo.ts`)
`imagesForNotes(db, noteIds, opts?: { includeRemoved?: boolean }): Promise<Map<string, NoteImageRow[]>>` (position order) · `findImageById(db, id)` · `findLiveImageBySha256(db, sha)` → `{ image: NoteImageRow; noteDeletedAt: Date | null } | null` · `insertImage(db, values: NewNoteImageRow)` → row, throws `NoteError('duplicate_image')` on 23505 of the sha index · `nextPosition(db, noteId)` = max(position over all rows incl. removed) + 1, or 0 · `imageIdTaken(db, id)` (true if `id` is in `notes` or `note_images`) · `setImageDeleted(db, id, deleted: boolean)` → row.

### Filters — phase 2 (`src/notes/repo.ts` `filterConditions`)
`hasImage: true` ⇔ `exists (select 1 from note_images i where i.note_id = notes.id and i.deleted_at is null)`; `false` ⇔ not exists. `takenFrom/To` ⇔ exists a live image with `taken_at` in range.

### Image records + ingest — phase 2 (`src/images/records.ts`, `src/images/ingest.ts`)
`ImageRecord = { id; note_id; path; meta: ImageMeta; position; deleted_at: string|null; note_deleted_at: string|null }`; `ImageRecords { bySha256Live(sha), byImageId(id), firstLiveImageOfNote(noteId) }`. `LocatedImage.id` = image id (keys `cache/<imageId>/`). `locateImage(deps, imageId)`. `ingestImage` unchanged in contract (`{ note, created }`), now writes the note + its first image row in one transaction via `NotesService.create({ id, body, origin, image: { path, meta }, allowEmpty })`. Dedupe: `bySha256Live` hit → return the holder note (restoring it when deleted), `created: false`.

### HTTP — image serving, phase 2 (`src/http/images.ts`, `src/http/imageAccess.ts`)
- `GET /api/images/:imageId` → `NoteImage` JSON (any state; 404 unknown).
- `GET /api/images/:imageId/{original|display|thumb|preview}` → serves any existing row's file (live, removed, or in a deleted note) — the bin needs thumbs; 404 `not_on_this_machine` + host when the file is elsewhere.
- `GET /api/notes/:id/{variant}` → alias: first live image of a **live** note (unchanged 404s otherwise).
- `POST /api/images` unchanged contract.

### Same-origin guard — phase 2 (`src/http/sameOrigin.ts`)
`export const sameOriginOnly: MiddlewareHandler` — 403 `{ error: 'forbidden_origin' }` unless the request has an `Origin` header whose `new URL(origin).origin === new URL(c.req.url).origin` and the request host is loopback (reuse `isLoopbackUrl` logic from `src/http/app.ts`, moved/exported here). Used by purge (phase 4) and reveal (phase 5).

### MCP — phase 2 `view_images`
`ids`: 1..8 note ids **or image ids**. Output: for each id in order — a note id expands to its live images in position order; an image id to that image. At most `VIEW_IMAGES_MAX = 8` images per call; past the cap one text line lists the image ids not shown ("call view_images again with these ids"). Each image is preceded by its text block (`describeImage(note, image, k, n)`: id, image id, `image k of n`, saved, taken, dims/mime/size/original name, tags, body). Deleted notes and text notes keep today's one-line answers.

### Service writes — phase 3 (`src/notes/service.ts`)
`attachImage(noteId, { id, path, meta }): Promise<Note>` (note must be live; position = `nextPosition`; emits `updated`) · `removeImage(imageId): Promise<Note>` (soft; idempotent; emits `updated` with the note id) · `restoreImage(imageId): Promise<Note>` (clears `deleted_at`; restores the note too when it is deleted; a live sha clash → `NoteError('duplicate_image', '... already in note X-XXX')`; emits).
Ingest — `attachImage(deps, noteId, input: IngestInput)` in `src/images/ingest.ts` → `AttachResult = { note: Note; attached: boolean }`; `attached: false` = the bytes already live in `note` (this note or another; a deleted holder is restored, same rule as upload). New image file: `images/YYYY/MM/<imageId>.<ext>`.

### HTTP + MCP attach/remove — phase 3
- `POST /api/notes/:id/images` multipart `file` → 201 `AttachResult` (attached) / 200 (already held) / 404 note not live / 413 / 415.
- `DELETE /api/images/:imageId` → 200 owner `Note`. `POST /api/images/:imageId/restore` → 200 `Note` / 409 `{ error: 'duplicate_image', note_id }`.
- MCP `attach_image { id, path, origin? }` → `{ note, attached }`; `remove_image { image_id }` → `{ note }`; `restore_image { image_id }` → `{ note }`. Added to `NOTES_TOOL_NAMES` with captions (`attaching a photo`, `removing a photo`, `restoring a photo`); instructions paragraph updated.

### Bin + purge — phase 4
- Types (`src/notes/types.ts`): `BinImage = { image: NoteImage; note_id: string; kind: 'note' | 'image'; deleted_at: string }` (`'note'`: image of a deleted note, actions act on the note; `'image'`: removed from a live note, actions act on the image); `Bin = { notes: Note[]; images: BinImage[] }`. `notes` = deleted notes, newest `deleted_at` first, each with its non-removed images; `images` newest `deleted_at` first. A removed image of a deleted note is listed once, as `'image'`.
- Queries in a new `src/notes/binRepo.ts` (listing, image row lock, deletes, legacy-column clear); single-image and per-note image reads reuse phase 1's `imageRepo`.
- Service: `listBin({ tagsAll? }): Promise<Bin>` (tag AND filter on the owning note) · `purgeNote(noteId)` (only a deleted note, else `NoteError('not_deleted')`; deletes the notes row — cascade removes images, revisions, embeddings — then removes every one of its image files) · `purgeImage(imageId)` (only a removed image, else `not_deleted`; deletes the row; when the row is the legacy image (`id = note_id` and `notes.image_path = row.path`) also sets `notes.image_path = null, image_meta = null` so the reconcile cannot resurrect it; removes its files). Both return `{ purged: string; files: number }` and emit `purged` (new `NoteOp`, note id). `NoteErrorCode` gains `not_deleted` (HTTP 409).
- Files: `removeImageFiles(dataDir, { id, path })` in `src/images/store.ts` — unlinks the original (must resolve under `<dataDir>/images/`) and `rm -r cache/<id>`; returns count removed.
- HTTP (`src/http/api.ts`): `GET /api/bin?tag=` → `Bin`; `POST /api/notes/:id/restore` → `Note`; `DELETE /api/bin/notes/:id` and `DELETE /api/bin/images/:imageId` behind `sameOriginOnly` → `{ purged, files }`. No MCP tool.

### Reveal — phase 5 (`src/http/reveal.ts`, mounted in `src/http/app.ts` before `staticRoutes`)
- `GET /api/capabilities` → `{ reveal: boolean }`.
- `POST /api/images/:imageId/reveal` behind `sameOriginOnly` → 202 `{ ok: true }` · 404 `not_found` · 404 `not_on_this_machine` · 409 `reveal_unavailable` · 500 `{ error: 'spawn_failed', message }`.
- `revealRoutes(deps, opts?: { reveal?: RevealDeps })`; `RevealDeps = { detect(): Promise<RevealEnv | null>; wslpath(abs: string): Promise<string>; spawn(cmd: string, args: string[]): Promise<void> }`. Real `detect`: Linux + `/proc/sys/fs/binfmt_misc/WSLInterop` (or `WSLInterop-late`) exists + `wslpath` resolvable + explorer resolvable: `NOTESD_EXPLORER_BIN`, else `explorer.exe` on PATH, else `/mnt/c/Windows/explorer.exe` if it exists (the unit's PATH has no `/mnt/c`). Cached per process. Real `spawn`: `child_process.spawn(cmd, args, { detached: true, stdio: 'ignore' })`, resolve on `'spawn'`, reject on `'error'`, `unref()`; exit code ignored. Args: `['/select,' + winPath]`.

### Web — phase 6 (images[]), 7 (editor), 8 (delete/bin), 9 (reveal)
- `web/src/types.ts` mirrors the wire; `PhotoItem = { note: Note; image: NoteImage; k: number; n: number }` (k 1-based within the note).
- `web/src/lib/filter.ts`: `hasImages(n) = n.images.length > 0`; `photosOf(notes, active): PhotoItem[]` flattened note by note in wall order, images in position order.
- `NoteImage` component takes `image: NoteImage` (not a note). Wall card cover = `images[0]`; when `n > 1` a Geist Mono count (`2`) overlaid bottom-right of the cover (no pill, no shadow).
- `PhotoModal` takes `items: PhotoItem[]`; meta shows overall `i / len` and, when `n > 1`, `k/n` for the note; "Show full screen" → `/full/<imageId>`; `FullscreenApp` loads `/api/images/<id>/display` and dims from `GET /api/images/<id>`.
- Phase 7: `NoteEditor` (new, CSS in `NoteEditor.css`) opened by an `ArrowsOutSimple` icon (`data-tip`/`aria-label` `Expand note`) at the end of each card's meta row; App state `expanded: string | null`; `DropOverlay` gains `target: string | null` — when set, files go to `POST /api/notes/<target>/images` and the overlay shows `Paperclip` instead of `ImageSquare`.
- Phase 8: `Trash` icon (`Delete note`; card meta, editor toolbar, modal toolbar); `UndoBar` (new, `UndoBar.css`) fixed above the chat bar's right end (`right: 16px; bottom: calc(var(--chatbar-h, 54px) + 24px)`, clear of the left-anchored answer panel): Geist Mono label (`deleted A-B32` / `removed image`) + `ArrowCounterClockwise` icon button (`data-tip="Undo"`), 6 s; covers note deletes and image removals. App `view: 'wall' | 'bin'`; rail + sidebar `Trash` icon toggles the bin; `Bin` (new) — heading `Deleted.`, image grid (gallery style) on top, deleted-note cards below in wall style; per entry `ArrowCounterClockwise` (restore) and `Trash` (delete forever) → inline confirm: the two icons become `Check` (`data-tip="Delete forever"`) + `X` (`data-tip="Cancel"`). Tag filters (`active`) apply.
- Phase 11: `useChat` gains `collapsed: boolean` + `toggleCollapsed()`; `ask` resets `collapsed` to false; `close` resets it. `AnswerPanel` props gain `collapsed`, `onToggleCollapse`; header icon `CaretDown` (expanded, `data-tip="Collapse"`) / `CaretUp` (collapsed, `data-tip="Expand"`); collapsed renders the header only and clicking the line (outside the buttons) expands; the query shows via `oneLine(query)` (newlines → spaces) with CSS ellipsis and `data-tip`/`title` = full query. `ChatBar` becomes a `<textarea rows={1}>` auto-growing to 6 lines (then `overflow-y: auto`); Enter without Shift and not `isComposing` (also `keyCode 229`) → `form.requestSubmit()`; publishes its live height as `--chatbar-h` on `document.documentElement`; `.answer { bottom: calc(var(--chatbar-h, 54px) + 32px) }`. `App.send` unchanged except it must not `trim()` the message it sends (it already sends `q` raw).
- Phase 9: `useCapabilities()` (fetch once); `RevealButton({ image })` renders `FolderOpen` (`data-tip="Show in Explorer"`) only when `caps.reveal && image.available`, on wall cards with images (cover), the modal toolbar (current image) and each editor strip tile (class `ed-rm ed-reveal`); not on gallery tiles.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | `note_images` table, migration 0002, legacy copy/reconcile, image repo | R1, R5 | `src/db`, `drizzle`, `src/notes`, `src/images` | 10 | — | HARD | `.workflows/plan/wall-editing/phase-1.md` | P1-NOTES-A023 | — |
| 2 | Cut the server over to per-image: wire `images[]`, filters, ingest, image-id routes, `view_images`, same-origin guard, startup reconcile | R1, R5 | `src/notes`, `src/images`, `src/http`, `src/mcp`, `src/chat` | 29 | 1 | HARD | `.workflows/plan/wall-editing/phase-2.md` | P1-NOTES-A024 | — |
| 3 | Attach / remove / restore one image: service, ingest, HTTP, MCP tools | R1, R5 | `src/notes`, `src/images`, `src/http`, `src/mcp`, `src/chat` | 12 | 2 | NORMAL | `.workflows/plan/wall-editing/phase-3.md` | P1-NOTES-A025 | — |
| 4 | Bin listing, note restore endpoint, purge (rows + files) | R3, R5 | `src/notes`, `src/images`, `src/http` | 9 | 3 | NORMAL | `.workflows/plan/wall-editing/phase-4.md` | P1-NOTES-A026 | — |
| 5 | Reveal in Explorer: capabilities + reveal endpoint | R4, R5 | `src/http` | 4 | 2 | NORMAL | `.workflows/plan/wall-editing/phase-5.md` | P1-NOTES-A027 | — |
| 6 | Web on `images[]`: cards, gallery, modal stepping, full-screen by image | R1, R5 | `web/src` | 19 | 2 | HARD | `.workflows/plan/wall-editing/phase-6.md` | P1-NOTES-A028 | — |
| 7 | Web big editor modal + attach on drop/paste | R2, R5 | `web/src` | 14 | 3, 6 | HARD | `.workflows/plan/wall-editing/phase-7.md` | P1-NOTES-A029 | — |
| 8 | Web delete, undo, recycle bin view | R3, R5 | `web/src` | 25 | 4, 7 | HARD | `.workflows/plan/wall-editing/phase-8.md` | P1-NOTES-A030 | — |
| 9 | Web reveal button + capabilities | R4, R5 | `web/src` | 10 | 5, 8 | NORMAL | `.workflows/plan/wall-editing/phase-9.md` | P1-NOTES-A031 | — |
| 10 | Docs, Neon migration 0002, full verification | R5, R1 (Neon) | docs, Neon | 3 + Neon | 9, 11 | NORMAL | `.workflows/plan/wall-editing/phase-10.md` | P1-NOTES-A032 | — |
| 11 | Collapsible answer panel + multi-line chat bar | R6, R7, R5 | `web/src` | 12 | — | NORMAL | `.workflows/plan/wall-editing/phase-11.md` | P1-NOTES-A033 | — |

Waves (dependencies point backward only): **1** = {1, 11} · **2** = {2} · **3** = {3, 5, 6} · **4** = {4, 7} · **5** = {8} · **6** = {9} · **7** = {10}. Phase 11 shares `App.tsx`, `App.test.tsx` and `styles.css` with phases 6–8 in non-overlapping hunks (invariant 7; see Reconciliation Log for the merge notes).

### Phase 1 — `note_images` table, migration 0002, legacy copy/reconcile, image repo
**Satisfies:** R1, R5
**Owns:** `src/db/schema.ts` (add `noteImages`, `NoteImageRow`, `NewNoteImageRow`; keep legacy columns), `drizzle/0002_note_images.sql` (generated DDL + hand-appended copy statement) + `drizzle/meta/0002_snapshot.json` + `_journal.json`, `src/notes/imageRepo.ts` (new; also `isLiveShaClash`, `LiveImageHit`), `src/images/legacy.ts` (new; `LEGACY_COPY_SQL`, `reconcileLegacyImages`), `tests/integration/setup.ts` (`truncateAll` lists `note_images`), `tests/integration/schema.int.test.ts` (new indexes, migration count 3), `tests/integration/migration0002.int.test.ts` (new: iteration-6-shaped DB → 0002 → lossless), `tests/integration/imageRepo.int.test.ts` (new).
**Does not touch:** any consumer of `Note.image` / `image_path` (service, repo filters, images/*, http, mcp, web). Nothing reads the new table yet. Neon (phase 10).
**Exit criteria:** migration applies on the Docker DB; the migration test proves every legacy image (live note, deleted note, both sha-clash shapes) has exactly one row with identical metadata and the files untouched; reconcile is idempotent, picks up late legacy ingests and bins a late clash; all existing tests unchanged and green except `schema.int.test.ts` / `setup.ts`.

### Phase 2 — Cut the server over to per-image
**Satisfies:** R1, R5
**Owns:** `src/notes/{types,repo,service}.ts` (wire `images`, `image` removed, `toNoteImage`, `imageUrls`, `rowToNote(row, dataDir, images)`, async `finish`/`toNote` + `toNotes` batch image load on every read path incl. hybrid search and `related`, `create` with first image in one transaction, `newId` free in both tables, EXISTS filters), `src/images/{records,ingest}.ts` (per-image records, `bySha256Live`/`byImageId`/`firstLiveImageOfNote`, `locateImage` by image id, `locateNoteImage`), doc comments in `src/images/{derive,store}.ts`, `src/http/{imageAccess,images}.ts` (image-id routes + note alias + bare-`NoteImage` `GET /api/images/:id`), `src/http/sameOrigin.ts` (new; `src/http/app.ts` imports `isLoopbackUrl` from it), `src/mcp/{imageTools,tools,instructions}.ts`, `src/chat/prompt.ts` (view_images sentence), `src/background.ts` (startup `reconcileLegacyImages`), `tests/helpers/fakeNotes.ts`, every server test that reads `image` (analysis Reference List), `tests/unit/sameOrigin.test.ts` (new), and a serving test for a reconciled legacy image in `images.http.int.test.ts` (R5 "every image is still served").
**Does not touch:** `web/**`; attach/remove/restore image (3); bin/purge, `src/http/api.ts` (4); reveal (5); `src/images/inbox.ts` (no change needed).
**Exit criteria:** no server code reads `notes.image_path`/`image_meta` except `src/images/legacy.ts`; every read path returns `images[]`; `has_image`/taken filters are any-live-image; `view_images` returns every image capped at 8 with overflow ids; legacy `/api/notes/:id/:variant` and new `/api/images/:id/:variant` both serve, including a reconciled legacy row; `sameOriginOnly` answers 403 to a missing, foreign or `null` Origin.

### Phase 3 — Attach / remove / restore one image
**Satisfies:** R1, R5
**Owns:** `src/notes/types.ts` (`DuplicateImageError`), `src/notes/repo.ts` (`touchNote`), `src/notes/service.ts` (`AttachImageInput`, `attachImage`, `removeImage`, `restoreImage`, `requireImageId`, `lockImage` (note row first), module helper `imageValues`, which phase 2's `create` now calls), `src/images/ingest.ts` (`attachImage`, `AttachDeps`, `AttachResult`), `src/http/imageAccess.ts` (`attachFromUpload`, `attachFromPath`, `toolAttachDeps`), `src/http/images.ts` (`POST /api/notes/:id/images`, `DELETE /api/images/:id`, `POST /api/images/:id/restore`), `src/mcp/imageTools.ts` (`attach_image`, `remove_image`, `restore_image`), `src/mcp/instructions.ts` (`Attaching.` paragraph), `src/chat/status.ts` (17 tools + captions), `tests/integration/images.attach.int.test.ts`, `tests/unit/{chat-status,mcp.instructions}.test.ts`.
**Does not touch:** bin listing / purge (4), `web/**`, `tests/helpers/fakeNotes.ts`.
**Exit criteria:** the three HTTP routes and three MCP tools work as contracted; dedupe returns the holder (restoring a deleted one); restore keeps the old position; a restore clash answers 409 `{ error: 'duplicate_image', note_id }`.

### Phase 4 — Bin listing, note restore endpoint, purge
**Satisfies:** R3, R5
**Owns:** `src/notes/{types,events}.ts` (`Bin`, `BinImage`, `PurgeResult`, `not_deleted`, `purged` op), `src/notes/binRepo.ts` (new: listing, image row lock, deletes, `clearLegacyImage`), `src/notes/service.ts` (`listBin`, `purgeNote`, `purgeImage` reusing `imageRepo` and phase 3's `requireImageId`; note-then-image lock order), `src/images/store.ts` (`removeImageFiles`), `src/http/api.ts` (bin, restore, purge routes; 409 mapping), `tests/integration/bin.int.test.ts`, `tests/unit/images/removeImageFiles.test.ts`, `tests/unit/embeddings/worker.test.ts` (ignores `purged`).
**Does not touch:** MCP (no purge tool — asserted), `web/**`, `src/notes/{repo,imageRepo}.ts`, the embeddings worker source.
**Exit criteria:** contract routes pass; purge leaves every other file in `images/` and `cache/` untouched; live items get 409 `not_deleted`; Origin-less, foreign and `null` Origins get 403.

### Phase 5 — Reveal in Explorer
**Satisfies:** R4, R5
**Owns:** `src/http/reveal.ts` (new), `src/http/app.ts` (mount + `CreateAppOptions.reveal`), `tests/unit/reveal.test.ts`, `tests/integration/reveal.int.test.ts`.
**Does not touch:** anything else; `web/vite.config.ts` stays as it is (Decisions).
**Exit criteria:** capabilities reports `reveal: false` off WSL; the reveal route answers 202 on spawn and never awaits Explorer's exit; the command line is exactly `[explorer, ['/select,' + wslpath -w original]]`.

### Phase 6 — Web on `images[]`
**Satisfies:** R1, R5
**Owns:** `web/src/types.ts`, `web/src/api.ts` (image URLs by image id), `web/src/components/{NoteImage,NoteCard,Gallery,PhotoModal}.tsx`, `web/src/fullscreen/FullscreenApp.tsx`, `web/src/lib/filter.ts` (`hasImages`, `imageCount`, `photosOf → PhotoItem[]`), `web/src/App.tsx` (photo count, `commit`'s empty rule on `images.length`, `<Gallery items>`), `web/src/styles.css` (`.card-cover`, `.card-count`), `web/src/testing/fixtures.ts` (new: `makeImage`, `makeNote`, reused by phases 7–9), and their tests.
**Does not touch:** `web/src/lib/text.ts`; editor (7), delete/bin (8), reveal (9), chat JSX/CSS (11), `DropOverlay.tsx`.
**Exit criteria:** wall cover + count, gallery tile per image, modal steps image by image within a note then across notes and shows `k/n`, full-screen by image id; grep gates empty.

### Phase 7 — Web big editor modal + attach on drop/paste
**Satisfies:** R2, R5
**Owns:** `web/src/components/NoteEditor.{tsx,css,test.tsx}` (new), `web/src/hooks/useNotice.ts` (new), `web/src/components/{NoteCard,Wall,DropOverlay}.tsx` (+ their tests), `web/src/App.tsx` (`expanded`, `expandedRef`, `notesRef`, `save`, `commit`, `expand`, `closeEditor`, `removeImg`, `onAttached`, editor portal), `web/src/api.ts` (`attachImage`, `removeImage`, `AttachResult`), `web/src/lib/filter.ts` (`visibleOnWall` keep list), `web/src/App.test.tsx` (new describe block).
**Does not touch:** `web/src/styles.css`; delete/undo/bin (8) — the strip's remove icon calls `removeImage` without undo here; chat files (11).
**Exit criteria:** the brief's R2 bullets, each covered by a component test; the card's expand icon is labelled `Expand note`.

### Phase 8 — Web delete, undo, recycle bin
**Satisfies:** R3, R5
**Owns:** `web/src/components/{Bin,UndoBar}.{tsx,css}` (+ tests, new), `web/src/hooks/{useUndo,useBin}.ts` (new), `web/src/components/{NoteCard,NoteEditor,PhotoModal,Gallery,Rail,Sidebar,Header,Wall}.tsx`, `web/src/App.tsx` (`view`, `removeNote`, `removeImageWithUndo` replacing phase 7's `removeImg`, `onRestored`, `toggleBin`, `pickMode`, wiring), `web/src/api.ts` (`fetchBin`, `restoreNote`, `restoreImage`, `purgeNote`, `purgeImage`, `DuplicateImageError`), `web/src/types.ts` (`Bin`, `BinImage`, `View`), `web/src/lib/filter.ts` (`BIN_HEADING`, `binCountLine`), tests (`UndoBar`, `Bin`, `App.bin`, `PhotoModal.delete`, `binFilter`, appended NoteCard/NoteEditor cases).
**Does not touch:** server; reveal (9); `web/src/styles.css`; chat files (11; only reads `--chatbar-h`).
**Exit criteria:** the brief's R3 acceptance steps pass in component tests; the undo label sits above the chat bar's right end and does not overlap the answer panel.

### Phase 9 — Web reveal button
**Satisfies:** R4, R5
**Owns:** `web/src/hooks/useCapabilities.ts`, `web/src/components/RevealButton.tsx` (+ tests, new), `web/src/api.ts` (`Capabilities`, `fetchCapabilities`, `revealImage`), mount points in `NoteCard` (after the `copied` span), `PhotoModal` (after Copy ID), `NoteEditor` (before `.ed-rm`, class `ed-rm ed-reveal`), one rule appended to `web/src/components/NoteEditor.css` (`.ed-reveal`), `RevealMounts.test.tsx`.
**Does not touch:** server, `App.tsx`, `Gallery.tsx`, `styles.css`.
**Exit criteria:** visibility rules tested (caps false → none; unavailable image → none; both true → icon, click POSTs); icon in card meta, modal toolbar and editor strip.

### Phase 11 — Collapsible answer panel + multi-line chat bar
**Satisfies:** R6, R7, R5
**Owns:** `web/src/components/{AnswerPanel,ChatBar}.tsx`, `web/src/components/ChatBar.css` (new), `web/src/hooks/useChat.ts`, `web/src/lib/oneLine.ts` (new; not `text.ts`), the `.answer`/`.answer-q`/`.answer-status`/`.chatbar`/`.chatbar input`/`.sendbtn` rules in `web/src/styles.css`, the `<AnswerPanel>` JSX in `web/src/App.tsx` (two new props only; `<ChatBar>` untouched), `web/src/App.test.tsx:125` (header button count 2 → 3), tests (`AnswerPanel.test.tsx`, new `ChatBar.test.tsx`, `useChat.test.tsx`, `oneLine.test.tsx`).
**Does not touch:** anything phases 6–9 own; the server (`chatSchema.message` trims only the ends).
**Exit criteria:** R6 and R7 bullets each covered by a component test; the panel stays left-anchored and ≤ 680px wide; `--chatbar-h` published on `document.documentElement`.
**R6/R7 vs R1–R5:** independent; runs in wave 1 beside phase 1.

### Phase 10 — Docs, Neon migration, full verification
**Satisfies:** R5 (README), R1 (applying migration 0002 to the live Neon database)
**Owns:** `README.md` (photos, gallery, modal, editor, bin, reveal, collapsible answer panel, multi-line chat bar, API table, storage section, MCP tool table), `claude/skills/n/SKILL.md` (images list, attach_image, "show me the pictures in note X"), `docs/INSTALL.md` (migrate step for 0002), `npm run db:migrate` against Neon with before/after verification (after-check matches phase 1's ranking; late old-daemon ingests after `MIGRATE_START` are tolerated), `npm run build`.
**Does not touch:** source code (a defect found here is fixed in the phase that owns the file, by a follow-up commit on this branch that names it); the installed daemon.
**Exit criteria:** full suite + build green; Neon has `note_images` with one row per legacy image (count equals `select count(*) from notes where image_path is not null`, minus any listed late ingests), every row with identical metadata; the installed daemon untouched.

## Reconciliation Log

Round 1, 2026-10-30. Every planner-flagged item was checked against the plan text; confirmations are listed after the conflicts.

| # | Conflict (class) | Phases | Resolution |
|---|---|---|---|
| 1 | Broken-build: phase 7's `App.tsx` import block dropped phase 6's `imageCount` from the `./lib/filter` import (`photoCount` uses it) | 6, 7 | phase-7 Step 9a now imports `imageCount`; note says dropping it breaks the build |
| 2 | File collision: phase 7 quoted a guessed `NoteCard` cover (`hasImg && …`, no `data-count`) | 6, 7 | phase-7 Step 6 now quotes phase 6's Step 5 cover verbatim (`count`, `cover`, `data-count`) |
| 3 | File collision / contract drift: phase 8 used `items={photos}` inside `Gallery` and `<Gallery photos={photos}>` in App; phase 6's prop is `items` | 6, 8 | phase-8 Steps 14 and 16j use `items={items}` / `<Gallery items={photos}>` |
| 4 | Later phase quoting pre-change state: phase 8's `Wall` step was a placeholder (`/* plus phase 7's props */`) and App passed `onExpand={setExpanded}` | 7, 8 | phase-8 Step 12 gives the whole post-7 `Wall.tsx`; Step 16j passes phase 7's `onExpand={expand}` |
| 5 | Unmet assumption: phase 8's App import list was partial and used a `NoteImageInfo` alias; phase 7 aliases `NoteImageData` | 7, 8 | phase-8 Step 16a is the full post-7 import block plus phase 8's names; alias `NoteImageData` |
| 6 | Unmet assumption: phase 8's editor Trash used `pm-btn` + `toolBtn` (PhotoModal names) | 7, 8 | phase-8 Step 15 uses phase 7's `ed-btn` in `.ed-top`, between `.ed-spacer` and Close |
| 7 | Contract drift (behaviour): an editor delete unmounts the editor without `close()`, so an unmount-time blur could `onSave` the deleted note back into the store | 7, 8 | phase-8 Step 15 sets `closedRef.current = true` before `onDelete(noteRef.current, draftRef.current)`; phase-7 handoff states the rule |
| 8 | Contract drift: phase 8's `removeNote` cleared `expanded` but left phase 7's `expandedRef`; `removeImageWithUndo` read a stale `notes` closure | 7, 8 | `removeNote` clears `expandedRef`; `removeImageWithUndo` reads `notesRef.current`; phase 7's `removeImg` is named and deleted |
| 9 | Unmet assumption: phase 8 called `renderEditor({ onDelete })`; phase 7's helper is `renderEditor(note, over)` | 7, 8 | phase-8 Step 20 calls `renderEditor(note('first line'), { onDelete })` |
| 10 | Unmet assumption: phase 9 used placeholders `STRIP_BTN_CLASS` and `item.image`; and `.ed-rm` is absolutely positioned, so a reveal button with that class alone would cover the remove icon | 7, 9 | phase-9 Step 6 uses class `ed-rm ed-reveal` and appends `.ed-reveal { right: 34px; }` to `NoteEditor.css` (added to its Files/Owns); Step 5 uses phase 6's destructured `image` |
| 11 | Contract drift: phase 9 described the card meta order as expand/Trash before the date | 7, 8, 9 | corrected to id, Copy, copied, [reveal], date, Expand note, Delete note |
| 12 | Overlap (UI geometry): phase 8's UndoBar sat on the chat bar's left edge at `bottom: --chatbar-h + 24px`, under the answer panel (`bottom: --chatbar-h + 32px`, same left edge) | 8, 11 | UndoBar moved to `right: 16px` (prop `left` removed, tests updated); see Decisions |
| 13 | Duplicate label: the card's expand button (`Expand`) and phase 11's collapsed-panel caret (`Expand`) | 7, 8, 11 | card button renamed `Expand note` in phases 7, 8, 10; see Decisions |
| 14 | Duplicate work: phase 3's `imageValues` and phase 2's inline ImageMeta→row mapping in `create` | 2, 3 | phase-3 Step 3f makes `create` call `imageValues(id, id, path, meta, 0)`; one mapping |
| 15 | Duplicate work: phase 4's `binRepo.findImageRow` / `imageRowsOfNote` duplicated phase 1's `imageRepo.findImageById` / `imagesForNotes(…, { includeRemoved: true })` | 1, 4 | phase 4 reuses `imageRepo`; both helpers removed from `binRepo` and its Creates list |
| 16 | Duplicate work: phase 4's `purgeImage` re-parsed the image id | 3, 4 | uses phase 3's private `requireImageId` |
| 17 | File collision: phase 4's "full" `./types.js` import list in `service.ts` omitted phase 3's `DuplicateImageError` | 3, 4 | added |
| 18 | Gap: R5 "every image is still served" after the migration (phase 1 handed it to phase 2; phase 2 did not take it) | 1, 2 | phase-2 Step 21 adds a test: a legacy-only row is reconciled, then served by `/api/images/<id>/{thumb,original}` and `/api/notes/<id>/thumb`, bytes identical |
| 19 | Contract drift: phase 10's Neon after-check failed outright when late old-daemon ingests were listed in `missing` (count checks did not subtract them) | 10 | counts subtract `missing`; Step 8 records `MIGRATE_START`; a missing row created before it is a FAIL (phase 1 defect) |
| 20 | Requirement mapping: phase 10 applies migration 0002 to Neon (R1's "runs on the live Neon database") but listed only R5 | 10 | phase 10 Satisfies R5 + R1 (Neon); Requirements row R1 now 1, 2, 3, 6, 10 (the Scope section already put the Neon step in phase 10) |
| 21 | Index drift: draft index said phases 7 and 8 own `styles.css`; both keep their CSS in their own files (`NoteEditor.css`, `Bin.css`, `UndoBar.css`) | 7, 8 | index Owns lines corrected; phase 9's `NoteEditor.css` rule recorded |
| 22 | Test fixtures (flag 9): phases 7–9 rebuilt `NoteImage`/`Note` literals by hand | 6–9 | `NoteEditor.test`, phase 7's App block, `Bin.test`, `App.bin.test`, `PhotoModal.delete.test`, `RevealMounts.test` now build from `makeImage` / `makeNote` |
| 23 | Merge with phase 11 in `App.tsx` (flag 10): phase 7 expected a conflict with a phase-11 `<ChatBar>` edit | 7, 11 | phase 11 edits only `<AnswerPanel>` props (lines ~189/191); phase 7's `<DropOverlay>` hunk (~197) and phase 8's main/`<UndoBar>` hunks are ≥ 5 untouched lines away, so git merges cleanly. If an integrator still sees one: keep phase 11's `<AnswerPanel>` props, the unchanged `<ChatBar …/>`, then phase 7's `<DropOverlay>` + editor portal, then phase 8's `<UndoBar>`, then `<Tooltip />`. `App.test.tsx`: phase 6 hunks at 4-20/68/after 69, phase 7 and 8 append at EOF / new files, phase 11 changes line 125 only; no phase 6–9 test asserts the header button count |
| 24 | Vite dev proxy Origin (flag 12): phases 5 and 9 said reveal/purge get 403 under `npm run dev:web` | 5, 9 | wrong: the proxy has no `changeOrigin`, so Host and Origin agree; notes corrected, `web/vite.config.ts` unchanged (Decisions) |
| 26 | Duplicate work: phase 8's `BinCard` drew its own `.bin-cover` / `.bin-count` instead of phase 6's `.card-cover` / `.card-count` | 6, 8 | `BinCard` reuses phase 6's classes; the `Bin.css` rules and the test selector follow |
| 25 | Phase 10 README strings (flag 14) did not match the reconciled UI (expand icon "next to the id", undo "above the chat bar" on the left, folder icon on gallery tiles implied) | 10 | Step 1d/1f text and the Requires list now quote: `Expand note` at the right end of the id line beside the trash, undo above the chat bar's right end, `Paperclip`, `Check`/`X` (`Delete forever`/`Cancel`), "Show in Explorer" on wall photo cards, modal and strip only, `Collapse`/`Expand` caret |

Confirmed, no edit needed beyond removing hedges:
- Flag 1: phase 2 names the converter `toNoteImage(row, dataDir)` in `src/notes/types.ts` (phase 4 imports it); `finish`/`toNote` become async and `toNotes` is added (phase 3's assumption holds).
- Flag 2: `DuplicateImageError` goes after `class NoteError`, `touchNote` after `setDeleted`, `AttachDeps` beside `ImageNotes`; phase 4 adds `not_deleted` to the `NoteErrorCode` union above (no overlap) and its service methods after `restoreImage`.
- Flag 3: lock order is already note row → image row in both phase 3's `lockImage` and phase 4's `purgeImage`; caveats replaced by the confirmation.
- Flag 4: `restoreImage` emits `restored` when it also restores the note; `useNotes` and phase 8's `useBin` refetch on any `note` event and never read `op`.
- Flag 5: `sameOriginOnly` → `isSameOrigin` returns false for a missing Origin and for `new URL('null')` throwing; 403 `{ error: 'forbidden_origin' }` as phases 4 and 5 test.
- Flag 6: `GET /api/images/:id` returns `c.json(toNoteImage(row, dataDir))`, a bare `NoteImage`.
- Flag 7: phase 10's `removed = with_meta − distinct_sha` / `removed deleted_at = notes.deleted_at` matches phase 1's `LEGACY_COPY_SQL` ranking (live first, then `deleted_at desc`, then id; ranks > 1 are always deleted notes, so `coalesce` never falls back to `now()` on a fresh table).
- Flag 11, 13: accepted and recorded in Decisions.
- Deleted-then-used: none. Every deletion (`Note.image`, `toImage`, `findNoteBySha256`, `ImageRecords.bySha256/byId`, `describeImageNote`, local `isLoopbackUrl` in phase 2; `NoteImageMeta`, `thumbUrl`/`displayUrl`/`originalUrl`, `ImageNote` in phase 6; `.chatbar input` in phase 11; `removeImg` in phase 8) has no reader in a later phase.
- Gaps vs analysis Impact Points / Reference List: every file is owned (Impact Point 11's `Gallery` reveal mount is the accepted exception). Note: the analysis's Impact Points carry stale phase numbers from an earlier draft; the Owns lines above are authoritative.

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Image id scheme | note-id format; a note's first image shares the note id (legacy and new); later images get ids free in both tables | 6: convention (keeps `cache/<id>/`, `/full/<id>`, `/api/notes/<id>/<variant>` valid without moving files — brief: "Files on disk do not move") |
| Legacy sha clash during copy (two legacy rows, same sha) | kept, the extra row gets `deleted_at` = its note's deleted time (shows in bin) | 1: invariant 4 (lossless) + brief "lossless for every existing note" |
| Old daemon ingests after Neon migration, before restart | idempotent `reconcileLegacyImages` at daemon start; purge of a legacy image clears the legacy columns | 5: user input ("runs on the live Neon database", "keep the old columns") |
| Old columns / indexes | kept, never written by new code (except purge clearing them) | 5: user input ("drop them in a later migration") |
| Does a removed (binned) image count for dedupe? | no — dedupe is per live image; restoring it while a live duplicate exists → 409 naming the holder | 5: user input ("Dedupe stays by sha256 per live image") |
| Dropping a file whose holder note is deleted | holder restored and returned (today's upload rule), editor says so quietly | 6: convention (`reuseExisting`) |
| `view_images` cap with many images | 8 images per call; ids may be note or image ids; overflow line lists image ids | 5: user input ("returns every image … (still capped)") |
| MCP image removal reversible | add `restore_image` beside `remove_image` | 1: invariant 3 (Claude can never destroy data; every MCP removal reversible) |
| Bin thumbnails for deleted items | `/api/images/:id/:variant` serves any existing row; MCP `view_images` still refuses deleted notes | 4: requirements (R3 grid of deleted images) |
| Bin grid tile of a whole deleted note | acts on the note (tooltips say "note") | 4: requirements (R3 "Each entry has restore and delete forever") |
| Restoring a removed image of a deleted note | restores the note too | 6: convention (an image is visible only in a live note) |
| Purge routes guard | same-origin guard like reveal | 1: invariant 3 + R4's Origin rule applied to the one destructive endpoint |
| `explorer.exe` not on the systemd unit's PATH | resolve `NOTESD_EXPLORER_BIN` → PATH → `/mnt/c/Windows/explorer.exe`; unit file unchanged | 6: convention (`deploy/notesd.service:16` PATH) |
| Undo scope | note deletes and image removals, 6 s | 4: requirements (R3 "a quiet undo … restores it"; R2 strip remove is a soft delete too) |
| R6 + R7 placement | one web phase (11) with no dependencies, sharing nothing with phases 6–9 (invariant 7) | 6: convention (the teammate's note: "pairs naturally with R6 in one small UI phase") |
| Neon migration timing | phase 10, after the suite is green, before landing; installed daemon not restarted | 5: user input + iteration 6 precedent |
| Undo label placement (phase 8 put it on the chat bar's left edge, where the answer panel also sits) | above the chat bar's **right** end: `right: 16px; bottom: calc(var(--chatbar-h, 54px) + 24px)`, z 65. The panel stays left-anchored at the bar's left edge and ≤ 680px wide, so they do not overlap on windows wider than ~1220px (sidebar open) / ~980px (rail only); narrower, the 6 s label sits on top | 3: plan code blocks (phase 11's `.answer` geometry and `--chatbar-h`; R3 fixes no position) |
| Card expand button label (`Expand`, same as phase 11's collapsed-panel caret) | `Expand note` (`data-tip` and `aria-label`), matching its sibling `Delete note` | 6: convention (one label per control; phase 8's `Delete note`) |
| Vite dev proxy vs `sameOriginOnly` | no change to `web/vite.config.ts`: without `changeOrigin` the proxy keeps the browser's Host, so Origin equals the request URL's origin and purge/reveal work under `npm run dev:web`. Never add `changeOrigin: true` | 6: convention (the shipped proxy config) |
| Reveal icon on "Photos." gallery tiles (analysis Impact Point 11 lists `Gallery`) | not rendered; the tile opens the modal, whose toolbar has the icon | 4: requirements (R4: "Photo cards, the photo modal and the editor's image strip") |
| Web build from this branch between phases 2 and 6 shows no photos (`Note.image` gone, `images[]` not yet read) | accepted; no crash, web tests use their own types, and the installed daemon is only rebuilt after landing | 1: invariant 1 (every phase green on tests, not on a live UI) |
| One ImageMeta→`note_images` mapping | phase 3's `imageValues`, also used by phase 2's `create` | 6: convention (one owner per region) |
| Phase 4 queries | reuse phase 1's `imageRepo.findImageById` / `imagesForNotes(…, { includeRemoved: true })` and phase 3's `requireImageId`; `binRepo` keeps only what is new | 6: convention |
| Reveal button in the editor strip | class `ed-rm ed-reveal`, `.ed-reveal { right: 34px; }` appended to `NoteEditor.css` by phase 9 | 6: convention (phase 7's strip button style) |

## Open Questions

None.

## Rollback

Per phase: revert the phase commit. Whole set: revert the merge. Neon: `drop table note_images;` — the legacy columns were never altered, so main's code works unchanged (images attached after the migration exist only in `note_images` and their files stay on disk). Purged items are gone by design.

## Next

Run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows:

    /analyze-orchestrator -f docs/plans/WALL_EDITING_PLAN.md

Or one phase at a time, starting at phase 1:

    /implement -f docs/plans/WALL_EDITING_PLAN.md --phase 1

Or put them on the board first:

    /create-task --from-plan docs/plans/WALL_EDITING_PLAN.md
