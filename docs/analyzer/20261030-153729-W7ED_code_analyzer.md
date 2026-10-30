# Code Analysis: mcp-notes iteration 7 — Wall editing

**Type:** Feature Implementation
**Date:** 2026-10-30T15:37:29+07:00
**Session ID:** 20261030-153729-W7ED
**Plan:** `docs/plans/WALL_EDITING_PLAN.md` (11 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/wall-editing` on `feature/wall-editing` (base `origin/main` @ `f899905`)

---

## User Input

### Original User Request
Everything below the `---` line of `docs/iterations/07-wall-editing.md`, verbatim:

Build mcp-notes iteration 7 ("Wall editing"). The "Fixed decisions" table in docs/ROADMAP.md is
binding except where this brief explicitly changes it (one change: a note may now hold several
images; see R1). Iterations 1–6 are on main (plans in docs/plans/).

The owner's request, as written:

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

Decisions already made with the owner:
  - A note can hold several images (like Google Keep), not one. Dropping an image into a note
    that already has images adds another.
  - The recycle bin holds every deleted note, text and image, not only image notes.

There is no Claude Design mock for these screens. Follow the existing design language exactly
(docs/design/claude-design/Notes Wall.dc.html and the shipped web/): #121211 canvas, #ecebe4
text, Host Grotesk + Geist Mono, icon-only controls (Phosphor duotone from the npm package) with
the custom tooltip, hairlines, no shadows, no rounded cards, the giant heading. No text on
buttons.

R1 — Several images per note. Move from `notes.image_path` / `notes.image_meta` (one image) to a
per-image table: each image keeps its own byte-exact original, sha256, metadata (mime, width,
height, bytes, EXIF taken_at, original name, host), position in the note, and its own soft-delete
time. The migration is lossless for every existing note, including soft-deleted ones, and runs
on the live Neon database; keep the old columns until the new table is proven (drop them in a
later migration, not this one, unless the plan shows a safe drop). Files on disk do not move.
  - Dedupe stays by sha256 per live image: dropping a file that already lives in a note returns
    that note instead of a duplicate (and, in the editor, says so quietly rather than attaching a
    second copy).
  - The wire Note carries `images: [...]` in order, each with its own id, URLs and `available`.
    Every consumer moves to it: wall cards show the first image as the cover with a small
    Geist Mono count when there are more; the "Photos." gallery shows one tile per image; the
    photo modal steps through images (within a note, then across notes) and shows which image of
    the note it is; the full-screen tab takes an image, not a note; `view_images` returns every
    image of the notes asked for (still capped); `list`/`search` `has_image` means "at least one
    image"; EXIF taken-date filters match if any image matches. Derived files (thumb, preview,
    display) become per image. Embeddings are unaffected (they embed text).
  - Ingestion: HTTP upload, the inbox folder and `create_image` still create one new note per
    file. New: HTTP and MCP ways to attach an image to an existing note (an `attach_image` MCP
    tool taking a note id and a local path), and to remove one image from a note (soft, to the
    bin).

R2 — The big editor. Every note card gets an expand icon (Phosphor arrows-out-simple or similar).
It opens a large modal editor on that same note: a wide, tall text area in the wall's type
(Host Grotesk, generous size), the note id with copy-id, tag chips, and the note's images as a
strip with a per-image remove icon. Text saves the way cards do (on blur and on close, only if
changed), and the card on the wall reflects it at once. Esc closes. The "+" sticker still
creates a note in place on the wall; expanding it from there is the "zoom in" the owner
describes. While the editor is open:
  - dropping or pasting an image attaches it to the note being edited (not a new note); the
    drop overlay says so by its icon (an "attach" icon, not the new-note image icon);
  - attaching an image to a text note while the wall is in "Notes." (text only) switches the wall
    to "Everything." on close, so the note does not vanish, following the existing rule for
    drops;
  - an emptied note is not deleted while the editor is open; on close, the existing rule applies
    (an empty note with no images is soft-deleted).

R3 — Delete button and recycle bin. Every note card, the editor, and the photo modal get a delete
icon (Phosphor trash). Deleting is soft and needs no confirmation; a quiet undo (an icon button
with a tooltip, in the style of the existing "copied" label, for a few seconds) restores it.
The recycle bin is a new view reached by a trash icon on the rail (and in the expanded sidebar),
with the giant heading "Deleted." It lists deleted notes newest-deleted first in the same wall
style, with deleted images also as a gallery grid at the top: whole deleted notes and single
images removed from a live note. Each entry has restore and "delete forever". Delete forever is
the one destructive action: it asks for confirmation (a small inline confirm, icon-only, in the
design's style), then removes the database rows and the original files plus their derived files.
It is UI-only: no MCP tool can delete forever, so Claude can never destroy data. Tag filters
apply in the bin too. Tags and counts in the sidebar keep counting live notes only.

R4 — Open file location. Photo cards, the photo modal and the editor's image strip get a folder
icon (Phosphor folder-open). Clicking it asks notesd to open Windows Explorer with the image's
original selected: notesd converts the path with `wslpath -w` and runs
`explorer.exe /select,<windows path>` (WSL interop works from the systemd user unit; this was
checked). Rules:
  - The endpoint only accepts requests whose Origin is notesd's own page, so another site open
    in the browser cannot trigger it; it takes an image id, never a path.
  - The icon shows only when the file is on this machine and the daemon runs under WSL with
    interop available (report this through a small capabilities endpoint); otherwise it is not
    rendered.
  - explorer.exe's exit code is meaningless (it returns 1 on success); judge success by the spawn
    only, and never block the request on Explorer.

R6 — Collapsible answer panel. Added by the owner after this brief was first written:

> make it so the overlay claude answer can be collapsed and expanded. by default it would be in
> its expanded state, if user click the collapse button, it will collapse to only show the
> query. e.g:
> ```
> cari notes yang membahas fitur . claude
> ```
> right now , we only have `x` button that closes the overlay permanently

  - The answer panel's header gets a collapse/expand icon (Phosphor caret-down / caret-up, or
    similar), next to pin and dismiss, with a tooltip. Icon only.
  - Collapsed, the panel shrinks to its header line alone: the query, then " · " and the brain
    (or the live status caption while it is still answering), plus its icons, sitting just above
    the chat bar. Expanded shows the full answer, as today.
  - Every new answer opens expanded. Collapsing does not stop a streaming answer; it keeps
    streaming and the status caption keeps updating in the collapsed line.
  - Clicking the collapsed line (not only the icon) expands it. Pin, dismiss and Esc keep their
    current meaning; dismiss still closes it for good and starts a new thread next time.
  - Used-note outlines and dimming on the wall stay while collapsed, since the answer is still
    the current one.

R7 — Multi-line chat bar. Added by the owner after this brief was first written:

> also, make it so the query bar can be added newlines, for example typing "Shift+Enter" will
> create a newline instead of sending the query to backend

  - The chat bar's single-line input becomes a textarea. Enter sends; Shift+Enter inserts a
    newline. Enter while an IME composition is active does not send.
  - The pill grows upward with its content, one line at a time, up to about six lines, then
    scrolls inside. It keeps its pill shape, colours and the round send button pinned to the
    bottom right. After sending it shrinks back to one line. The answer panel stays clear of the
    taller bar (it sits above it, whatever its height).
  - Pasted multi-line text keeps its newlines. The message reaches `/api/chat` with its newlines
    intact.
  - The answer panel's header shows the query on one line: newlines become spaces and a long
    query is cut with an ellipsis (the collapsed line from R6 included). The full query is in the
    header's tooltip.

R5 — Tests. Unit and component tests for the editor (save on blur/close, attach on drop and
paste, empty-on-close rule, mode switch), the bin (restore, undo, delete-forever confirm), and
the reveal button's visibility rules. Integration tests for the migration (an iteration-6
shaped database with live and deleted image notes migrates losslessly and every image is still
served), attach/remove image, per-image dedupe, the bin endpoints, delete forever (rows and files
gone, nothing else touched), the Origin check, and the reveal command line (with the spawn
faked). Update the README sections and GIF-free text that describe photos, the gallery and the
modal so they match the new behaviour.

Acceptance (in the browser at http://localhost:7317, and through `/n`):
  - "+" → type a line → expand → write three paragraphs → drop two screenshots → close: one note
    with the text and two images; the wall shows the cover and "2".
  - Delete that note from its card → it is gone from the wall → undo brings it back → delete
    again → it is in "Deleted." → restore → back on the wall with both images.
  - Remove one image in the editor → it appears in the bin's image grid → restore puts it back in
    the note at its old position.
  - Delete forever on a deleted note asks first, then the files are gone from
    ~/mcp-notes-data/images.
  - The folder icon on a photo opens Explorer with that file selected.
  - /n show me the pictures in note <id>  → Claude sees every image of that note.
  - /n attach ~/Pictures/Screenshots/<file>.png to note <id>
  - Ask in the chat bar → collapse while it streams → the line shows "<query> · <status>" and
    then "<query> · claude" → click it → the full answer is there.
  - Type two lines in the chat bar with Shift+Enter between them → the bar grows to two lines →
    Enter sends both lines as one message → the bar is one line again.

Out of scope: rich text or markdown rendering in notes, reordering images by drag (order is
attach order; removing and restoring keeps position), image editing or cropping, a bin auto-purge
timer, mobile layout, sync of images to other machines.

### User-Provided Context
- `docs/ROADMAP.md` "Fixed decisions" is binding, except the one change the brief makes: a note may hold several images. ROADMAP's Images row already says "one or more local files (several images per note since iteration 7)".
- Design language: `docs/design/claude-design/Notes Wall.dc.html` and the shipped `web/`. No mock exists for the new screens.

### User-Provided Files
None marked with `@`. The brief names `docs/ROADMAP.md`, `docs/plans/`, `docs/design/claude-design/Notes Wall.dc.html`, `web/`.

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Several images per note: per-image table (own original, sha256, metadata, position, soft-delete), lossless migration on live Neon keeping old columns, per-live-image sha dedupe, wire `images: [...]` with every consumer moved (cards cover + count, gallery per image, modal stepping, full-screen by image, `view_images` all images capped, `has_image` = at least one, taken filter = any image), per-image derived files, HTTP + MCP `attach_image` and remove-one-image (soft) |
| R2 | The big editor: expand icon on every card opens a large modal editor on that note (text area, id + copy, tag chips, image strip with per-image remove); saves on blur/close if changed; Esc closes; drop/paste attaches to the edited note with an "attach" overlay icon; Notes.→Everything. switch on close when a text note gains an image; empty-note rule applied on close only |
| R3 | Delete icon on card, editor and photo modal (soft, no confirm, quiet undo); recycle bin view "Deleted." from rail + sidebar trash icon: deleted notes newest-deleted first, deleted images as a grid on top (whole deleted notes and single removed images), restore and delete-forever per entry; delete forever asks inline, removes rows + original + derived files; UI-only (no MCP tool); tag filters apply in the bin; sidebar tags/counts count live notes only |
| R4 | Open file location: folder icon on photo cards, photo modal, editor image strip; notesd runs `explorer.exe /select,<wslpath -w path>`; endpoint takes an image id, accepts only notesd's own Origin; icon only when the file is local and the daemon is WSL with interop (capabilities endpoint); spawn-only success, never block on Explorer |
| R6 | Collapsible answer panel: caret icon in the panel header next to pin/dismiss; collapsed = header line only (query · brain or live status) above the chat bar; new answers open expanded; streaming continues while collapsed; clicking the collapsed line expands; pin/dismiss/Esc unchanged; wall highlight stays |
| R7 | Multi-line chat bar: textarea, Enter sends, Shift+Enter newline, no send during IME composition; grows upward to ~6 lines then scrolls, send button bottom right, shrinks after send; answer panel stays above the bar; newlines reach /api/chat intact; panel header shows the query on one line (newlines → spaces, ellipsis, full text in tooltip) |
| R5 | Tests (unit/component for editor, bin, reveal visibility; integration for migration, attach/remove, per-image dedupe, bin endpoints, delete forever, Origin check, reveal command line with faked spawn) and README text updates for photos/gallery/modal |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** Today an image note is a `notes` row with `image_path` + `image_meta` (one image). The wire `Note` has `image: NoteImage | null`; every consumer (MCP, HTTP, web) keys images by **note id** (`/api/notes/:id/thumb`, `cache/<noteId>/`, `/full/<noteId>`, `view_images(note ids)`). Iteration 7 moves images into their own table so one note can hold many, keyed by an **image id**, and adds three UI features on top (editor modal, delete + bin, reveal in Explorer).

**Success Criteria.** The acceptance list in the brief, verbatim; plus `npm run typecheck`, `npm test`, `npm run test:int` green at the end of every phase; migration applied to Neon with every pre-existing image (live and in deleted notes) still served.

**Key Considerations.**
- Live-DB migration: additive (new table + INSERT…SELECT copy). The installed daemon (main's code) keeps reading the old columns until it is rebuilt and restarted, so an image ingested by the old daemon after the migration ran must still reach the new table (see Impact Points: startup reconcile).
- The old partial unique index `notes_image_sha256_live_uniq` and `notes_image_taken_at_idx` live on the old columns; new writes never fill those columns, so they constrain nothing new.
- Derived files today live in `cache/<noteId>/`. If a migrated image's id equals its note id, every existing derivative stays valid and every old `/full/<noteId>` link and `/api/notes/<noteId>/<variant>` URL keeps meaning "this note's first image".
- The systemd unit's PATH is `@NODE_DIR@:/usr/local/bin:/usr/bin:/bin` (`deploy/notesd.service:16`). `wslpath` is `/usr/bin/wslpath`; `explorer.exe` is **not** on that PATH (it lives at `/mnt/c/Windows/explorer.exe`).
- `NoteEvents` has ops `created|updated|deleted|restored` (`src/notes/events.ts:3`); the embeddings worker reacts to `created|updated` only (`src/embeddings/worker.ts:121`); `useNotes` refetches on any op.
- `DELETE /api/notes/:id` already soft-deletes (`src/http/api.ts:160`) and the web's empty-note rule uses it (`web/src/App.tsx:294-307`).
- No MCP tool may delete forever.

**Assumptions** (decided in the plan index under Decisions): image ids share the note-id format and generator; migrated images take their note's id; old `/api/notes/:id/:variant` routes stay as a first-live-image alias.

---

## Analysis Scope

### Explicitly Mentioned Files
`docs/ROADMAP.md`, `docs/design/claude-design/Notes Wall.dc.html`, `web/`, `docs/plans/*`.

### Discovered Related Files
Server: `src/db/schema.ts`, `drizzle/0000_init.sql`, `drizzle/0001_note_embeddings.sql`, `drizzle/meta/*`, `drizzle.config.ts`, `src/notes/{types,repo,service,events,ids}.ts`, `src/images/{ingest,records,store,derive,probe,inbox}.ts`, `src/http/{app,api,images,imageAccess,static}.ts`, `src/mcp/{tools,imageTools,instructions,server}.ts`, `src/chat/{status,prompt}.ts`, `src/background.ts`, `src/daemon.ts`, `src/deps.ts`, `src/config.ts`, `src/embeddings/worker.ts`, `deploy/notesd.service`.
Web: `web/src/{App.tsx,api.ts,types.ts,styles.css}`, `web/src/hooks/{useNotes,useCopied}.ts`, `web/src/components/{NoteCard,NoteImage,Gallery,PhotoModal,PhotoModal.css,DropOverlay,Wall,Rail,Sidebar,Header,Tooltip}.tsx`, `web/src/fullscreen/{FullscreenApp.tsx,view.ts,main.tsx}`, `web/src/lib/{filter,text}.ts`.
Tests: `tests/integration/{setup,globalSetup,imageHarness,schema,notes.service,images,images.http,images.mcp,api,mcp.tools,search.hybrid,related,embeddings.worker,daemon}.int.test.ts`, `tests/helpers/fakeNotes.ts`, `tests/unit/{notes.helpers,takenFilter,images/*}.test.ts`, every `web/src/**/*.test.tsx` that builds a `Note` with `image`.
Docs: `README.md` (photos/gallery/modal sections at lines 92-150, 439-490), `claude/skills/n/SKILL.md:25-35,160-167`, `src/mcp/instructions.ts:16,30`.

---

## Current Dataflow

### Entry Point A: image ingestion
**Location:** `src/images/ingest.ts:138` `ingestImage(deps, input)`
**Triggers:** `POST /api/images` (`src/http/images.ts:301` → `ingestFromUpload` `src/http/imageAccess.ts:473`), MCP `create_image` (`src/mcp/imageTools.ts:51` → `ingestFromPath` `imageAccess.ts:490`), inbox watcher (`src/background.ts` → `startInboxWatcher` `src/images/inbox.ts:239`, `move: true`).
**Chain:**
1. read bytes, `sha256Hex` → `withShaLock(sha)` (in-process serialisation, `ingest.ts:74`).
2. `records.bySha256(sha)` (`src/images/records.ts:380`): `notes` where `image_path is not null and image_meta->>'sha256' = sha`, live first then most recently deleted. Hit → `reuseExisting` (`ingest.ts:107`): place bytes if the file is missing on this host, restore the note if deleted, return `{note, created:false}`.
3. Miss → `probeImage` (mime by magic bytes, w/h, EXIF taken_at) → `chooseExt` → loop: `notes.newId()` → `originalRelPath(id, ext, now)` = `images/YYYY/MM/<noteId>.<ext>` (`store.ts:250`) → `placeOriginal` (write/copy/move, never overwrite) → `NotesService.create({id, body, image:{path, meta}, allowEmpty:true})` → `repo.insertNote` (`repo.ts:315`). 23505 on the live-sha index → `NoteError('duplicate_image')` → unplace, return the winner.
**Exit:** `{note, created}`; `created` event emitted by the service.

### Entry Point B: serving an image
**Location:** `src/http/images.ts:331` `GET /api/notes/:id/{original|display|thumb|preview}` → `sendImage` → `resolveImageFile(img, id, variant)` (`imageAccess.ts:403`) → `locateImage` (`ingest.ts:193`, `records.byId(noteId)`) → deleted → 404 `not_found`; file missing → 404 `not_on_this_machine` + host; else `getDisplay/getThumb/getPreview` (`src/images/derive.ts`) writing `cache/<noteId>/{display.jpg,thumb.webp,preview.jpg}` once (`derivativePaths(dataDir, id)` `derive.ts:28`). ETag `"<sha>"` / `"<sha>-<variant>"`.

### Entry Point C: notes read paths
`NotesService.list/search/get/getOne/related` (`src/notes/service.ts`) → repo selects full `notes` rows → `rowToNote(row, dataDir)` (`src/notes/types.ts:273`) → `toImage` builds `image` from `image_meta` + `imageAvailable(dataDir, image_path)` (sync `existsSync`). Filters: `filterConditions` (`repo.ts:112`): `hasImage` → `image_path is (not) null`; `takenFrom/To` → text compare on `image_meta->>'taken_at'`. Hybrid search (`repo.searchCandidates`, `repo.ts:215`) and `related` (`src/embeddings/repo.ts nearestNotes`) both return `NoteRow`s and go through the same `rowToNote`.

### Entry Point D: MCP
`registerNoteTools` (`src/mcp/tools.ts:152`): create/get/update/append/delete/restore/list/search/tags/related/revisions/revert. `registerImageTools` (`src/mcp/imageTools.ts:48`): `create_image`, `view_images` (1..8 note ids; per note: deleted → line, no image → line, else `resolveImageFile(noteId,'preview')` → base64 image content after `describeImageNote`). Chat brain allow list = `NOTES_TOOL_NAMES` (`src/chat/status.ts:18-31`), captions in `captionForToolUse` (`status.ts:83`). Server instructions text `src/mcp/instructions.ts:16,30` describes `image`.

### Entry Point E: HTTP notes API
`src/http/api.ts`: `GET /api/notes?limit&cursor&has_image&tag` (live only), `GET /api/notes/:id`, `POST /api/notes` (allowEmpty, origin web), `PATCH /api/notes/:id` (allowEmpty), `DELETE /api/notes/:id` (soft; 404 when not live), `GET /api/tags` (live only), `GET /api/events` (SSE `note` events `{op,id}`), `POST /api/chat`. There is no restore endpoint and no deleted listing over HTTP. `/mcp` is guarded by `loopbackOnly` (`src/http/app.ts:24`): loopback Host, and loopback Origin when present. `/api/*` has no Origin check.

### Entry Point F: web UI
`App.tsx` holds `notes` (`useNotes`: fetch 2000 live notes + tags, SSE-driven debounced refetch, `upsertLocal/removeLocal`), `mode` (`text|images|all`), `active` tags, `editing` id. Wall → `NoteCard` (image via `NoteImage note` → `/api/notes/<id>/thumb`; inline `CardEditor` textarea commits on blur via `App.commit`: empty + no image → `removeLocal` + `DELETE`; changed → optimistic upsert + `PATCH`). "+" (rail `NotePencil`, header `.sticker` `Plus`) → `createNote('')` + editing. `mode === 'images'` → `Gallery` (one tile per image note) → `PhotoModal` (photos array, index, ←/→ wrap, copy id, "Show full screen" → `window.open('/full/<noteId>')`, Esc in capture phase). `DropOverlay` listens on `document` for dragover/drop/paste, uploads each image file to `POST /api/images`, calls `onImageAdded` (insert + text→all switch), `flashNote` on dedupe. `FullscreenApp` parses `/full/:id` and loads `/api/notes/:id/display`. Filters in `web/src/lib/filter.ts` use `n.image` (`visibleOnWall`, `photosOf`, `countLineFor`, `isHiddenByMode`). Tooltip: one document-level mouseover on `[data-tip]`. Copy label: `useCopied` (1.4 s) + `.copied.on` fade.

### Entry Point G: chat bar + answer panel (R6, R7)
`web/src/components/ChatBar.tsx` is a `<form className="chatbar">` with a single `<input>` (controlled by `App.q`) and a submit button; `App.send` (`App.tsx:330`) prevents default, switches `images`→`all`, calls `chat.ask(q)`, clears `q`. `.chatbar` is fixed `bottom:16px; height:54px` (`styles.css:117`). `AnswerPanel` (`web/src/components/AnswerPanel.tsx`) is fixed at `bottom: 86px` (`styles.css:99`), header = query (`.answer-q`) + caption (status while streaming, brain when done) + pin + dismiss; body = paragraphs; used-id chips. `useChat` (`web/src/hooks/useChat.ts`) state `{open, pinned, query, text, done, status, brain, threadId}`; `ask` sets open + resets; `close` clears open/pinned and the thread; `togglePin`. App's Esc handler closes an open, unpinned panel (`App.tsx:339-346`). Wall highlight derives from `chat.open && chat.text` (`App.tsx:256-258`).

### Data Persistence
- `notes` (`src/db/schema.ts:38`): id, body, tags[], image_path, image_meta jsonb, origin, created_at, updated_at, deleted_at. Indexes incl. `notes_image_sha256_live_uniq` (partial unique on `image_meta->>'sha256'` where image_meta not null and deleted_at null) and `notes_image_taken_at_idx`.
- `note_revisions` (FK cascade), `note_embeddings` (FK cascade).
- Files: `<dataDir>/images/YYYY/MM/<noteId>.<ext>` (originals), `<dataDir>/cache/<noteId>/` (derivatives), `<dataDir>/inbox`, `inbox/failed`. `dataDir` = `NOTES_DATA_DIR` or `~/mcp-notes-data` (`src/config.ts:231`).
- Migrations: drizzle-kit, `drizzle/0000_init.sql`, `drizzle/0001_note_embeddings.sql` (hand-prepended `CREATE EXTENSION`), journal `drizzle/meta/_journal.json`. `npm run db:migrate` uses the direct (unpooled) Neon URL (`drizzle.config.ts`). Integration tests migrate the Docker DB once (`tests/integration/globalSetup.ts`) and `truncateAll` per file (`setup.ts:53`: `note_embeddings, note_revisions, notes`).
- Neon migration in previous iterations was applied by the last phase of the set, before the merge; the installed daemon keeps running main's code until `scripts/install.sh` rebuilds and restarts it.

### Exit Points
JSON over HTTP, MCP tool results (text + image content), SSE note events, files streamed with immutable caching for originals.

---

## Key Data Structures

### `ImageMeta` — `src/db/schema.ts:13`
`{ sha256, mime, width, height, bytes, taken_at: string|null (UTC ISO Z), original_name, host }`. Used by ingest, records, rowToNote, schema tests.

### Wire `Note` — `src/notes/types.ts:154` / `web/src/types.ts:12`
`{ id, body, tags, created_at, updated_at, deleted_at?, origin, image: NoteImage|null }`; `NoteImage = { mime, width, height, bytes, taken_at, original_name, host, available }`. Read by MCP JSON results, HTTP, web (`NoteImage.tsx` structural `ImageNote`), `describeImageNote`.

### `ImageRecord` — `src/images/records.ts:6`
`{ id (note id), image_path, image_meta, deleted_at }`; `ImageRecords { bySha256, byId }`. Faked in `tests/helpers/fakeNotes.ts`.

### `LocatedImage` — `src/images/ingest.ts:59`
`ImageSource ({id, mime, originalPath}) & { relPath, available, host, deleted, meta }`; `id` keys the cache dir.

### `NoteFilter` — `src/notes/repo.ts:20`
`hasImage`, `takenFrom`, `takenTo`, `deleted`, tags, dates, paging.

---

## Dependencies

- Postgres (Neon live, Docker `pgvector/pgvector:pg16` for tests), drizzle-orm 0.45 / drizzle-kit 0.31.
- sharp, heic-convert, exifr, file-type (derivatives/probe).
- Hono 4 + @hono/node-server; MCP SDK 1.32 (streamable HTTP, stateless).
- Web: React 19, Vite 8, @phosphor-icons/react 2.1.10 (duotone via `IconContext`), Testing Library + jsdom.
- WSL: `/usr/bin/wslpath`, `/mnt/c/Windows/explorer.exe`, interop (`/proc/sys/fs/binfmt_misc/WSLInterop`, `WSL_INTEROP`/`WSL_DISTRO_NAME` env in user sessions — not guaranteed under systemd).

---

## Reference List (image model: every site that reads or writes the one-image shape)

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `notes.image_path`, `notes.image_meta`, `ImageMeta` | `src/db/schema.ts:13,47-48,60-63` | def | db |
| `notes_image_sha256_live_uniq`, `notes_image_taken_at_idx` | `drizzle/0000_init.sql` last lines | config | drizzle |
| `NoteImage`, `Note.image`, `toImage`, `rowToNote`, `imageAvailable` | `src/notes/types.ts:141-163,245-285` | def | notes |
| `InsertNote.imagePath/imageMeta`, `insertNote` | `src/notes/repo.ts:63-70,315-338` | def/call | notes |
| `filterConditions` hasImage / taken | `src/notes/repo.ts:127-137` | def | notes |
| `findNoteBySha256` | `src/notes/repo.ts:289` | def | notes |
| `CreateNoteInput.image`, `create`, `findBySha256`, `related` (photo-without-text message) | `src/notes/service.ts:53,143-149,195,291` | call | notes |
| `ImageRecord`, `dbImageRecords` | `src/images/records.ts` | def | images |
| `ingestImage`, `reuseExisting`, `locateImage`, `LocatedImage`, `ImageNotes` | `src/images/ingest.ts` | def | images |
| `originalRelPath`, `cacheDirFor` | `src/images/store.ts:250,266` | def | images |
| `derivativePaths`, `getDisplay/getThumb/getPreview`, `ImageSource.id` | `src/images/derive.ts:19-36,96-150` | def | images |
| inbox log line uses `note.id` | `src/images/inbox.ts:261` | call | images |
| `resolveImageFile`, `ingestFromUpload`, `ingestFromPath`, `toolImageDeps` | `src/http/imageAccess.ts` | def | http |
| `GET /api/notes/:id/:variant`, `POST /api/images` | `src/http/images.ts:301-333` | def | http |
| `GET /api/notes?has_image` | `src/http/api.ts:23-27,103-123` | def | http |
| `create_image`, `view_images`, `describeImageNote`, `VIEW_IMAGES_MAX` | `src/mcp/imageTools.ts` | def | mcp |
| `has_image`/`taken_*` descriptions, `IMAGE_FILTER_HINT` | `src/mcp/tools.ts:20-21,62-75` | doc | mcp |
| instructions "image field" paragraph | `src/mcp/instructions.ts:16,30` | doc | mcp |
| `NOTES_TOOL_NAMES`, `captionForToolUse` | `src/chat/status.ts:18-31,83-116` | config | chat |
| chat prompt "view_images with their ids" | `src/chat/prompt.ts:27` | doc | chat |
| web `NoteImageMeta`, `Note.image` | `web/src/types.ts:1-21` | def | web |
| `thumbUrl/displayUrl/originalUrl` | `web/src/api.ts:98-100` | def | web |
| `imageUrl`, `ImageNote`, `NoteImage` | `web/src/components/NoteImage.tsx` | def | web |
| `NoteCard` `hasImg`, `CardEditor` | `web/src/components/NoteCard.tsx` | call | web |
| `Gallery`, `galleryTile` | `web/src/components/Gallery.tsx` | call | web |
| `PhotoModal` photos/index, `/full/<noteId>` | `web/src/components/PhotoModal.tsx:349-466` | call | web |
| `idFromLocation`, `describeMissing` | `web/src/fullscreen/FullscreenApp.tsx` | call | web |
| `visibleOnWall`, `photosOf`, `countLineFor`, `isHiddenByMode` | `web/src/lib/filter.ts` | call | web |
| `fontSizeFor(body, hasImg)` | `web/src/lib/text.ts:28` | call | web |
| `App.commit` (`!note.image`), `photoCount`, `onImageAdded` | `web/src/App.tsx:254,297,321` | call | web |
| `DropOverlay`, `uploadImage`, `flashNote` | `web/src/components/DropOverlay.tsx` | def | web |
| image fields in tests | `tests/integration/{schema,notes.service,images,images.http,images.mcp,api,search.hybrid,embeddings.worker,related,mcp.tools,daemon}.int.test.ts`, `tests/integration/imageHarness.ts`, `tests/helpers/fakeNotes.ts`, `tests/unit/notes.helpers.test.ts`, `web/src/**/*.test.tsx` (App, NoteCard, NoteImage, Gallery, PhotoModal, DropOverlay, FullscreenApp, filter, text) | test | tests |
| README photos/gallery/modal/API/storage text | `README.md:92-150,170-180,439-490` | doc | docs |
| `/n` skill image section | `claude/skills/n/SKILL.md:25-35,160-167` | doc | skill |

---

## Impact Points (files that WILL need changes)

1. `src/db/schema.ts`, `drizzle/0002_*.sql` + `drizzle/meta/*` — new `note_images` table; old columns kept; hand-appended copy INSERT. **Phase 1.**
2. `src/notes/{types,repo,service}.ts` — wire `images`, filters via EXISTS on live images, batch image load for every read path, create-with-image, id allocation free in both tables, legacy reconcile. **Phase 1.**
3. `src/images/{records,ingest,store,derive}.ts`, `src/background.ts` (startup reconcile call) — per-image records, cache per image id, ingest writes `note_images`. **Phase 1.**
4. `src/http/{imageAccess,images}.ts`, new `src/http/sameOrigin.ts` — image-id routes + note-id alias; same-origin guard. **Phase 1.**
5. `src/mcp/{imageTools,instructions,tools}.ts`, `src/chat/prompt.ts` — `view_images` every image (capped), descriptions. **Phase 1.**
6. Service + ingest: attach/remove/restore image, bin listing, purge (rows + files); HTTP attach/remove/restore/bin/purge routes; MCP `attach_image`, `remove_image`, `restore_image`; `NoteEvents` `purged`; chat allow list + captions. **Phase 2.**
7. New `src/http/reveal.ts` + mount in `src/http/app.ts` — capabilities + reveal. **Phase 3.**
8. `web/src/{types,api}.ts`, `NoteImage`, `NoteCard`, `Gallery`, `PhotoModal`, `FullscreenApp`, `lib/filter.ts`, `lib/text.ts`, `App.tsx` — images[]. **Phase 4.**
9. New `web/src/components/NoteEditor.tsx`, `DropOverlay`, `NoteCard`, `App.tsx`, `api.ts` — editor modal + attach. **Phase 5.**
10. New `web/src/components/Bin.tsx` (+ undo), `Rail`, `Sidebar`, `NoteCard`, `NoteEditor`, `PhotoModal`, `App.tsx`, `api.ts`, `lib/filter.ts` — delete, undo, bin. **Phase 6.**
11. `web/src/hooks/useCapabilities.ts` (new), `NoteCard`, `PhotoModal`, `NoteEditor`, `Gallery`, `api.ts` — reveal icon. **Phase 7.**
12. `web/src/components/{ChatBar,AnswerPanel}.tsx`, `web/src/hooks/useChat.ts`, chat styles, the two JSX call sites in `App.tsx` — R6 + R7. **Phase 11.**
13. `README.md`, `claude/skills/n/SKILL.md`, `docs/INSTALL.md`; Neon `db:migrate`; acceptance smoke. **Phase 10.**

**This document describes. The plan files prescribe.**
