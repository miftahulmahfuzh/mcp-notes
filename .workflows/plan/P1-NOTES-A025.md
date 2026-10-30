> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 3. Source: `.workflows/plan/wall-editing/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Attach / remove / restore one image: service, ingest, HTTP, MCP tools

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R1 (HTTP + MCP attach and soft remove of one image, per-live-image dedupe), R5 (this phase's own tests)
**Depends on:** Phase 2 (and through it Phase 1)
**Difficulty:** NORMAL
**Package:** `src/notes`, `src/images`, `src/http`, `src/mcp`, `src/chat`

---

## Goal

After this phase a live note can gain another image (HTTP multipart upload or MCP `attach_image` with a local path), and one image can be taken out of its note softly and put back at the same position (HTTP + MCP `remove_image` / `restore_image`). Dedupe stays per live image: attaching bytes that already live in any note returns that holder note (restoring it when it is deleted) and writes nothing. Restoring an image whose bytes went live elsewhere meanwhile is refused with a 409 naming the holder.

## Assumptions (what Phase 1 and Phase 2 have landed)

All code below is written against the tree **after phase 2**. Line numbers marked "today" refer to `f899905`; the implementer anchors on the named symbol, not the number.

Phase 1 (`src/notes/imageRepo.ts`, `src/db/schema.ts`), exactly as in the Contract:
- `noteImages` table and `export type NoteImageRow = typeof noteImages.$inferSelect` in `src/db/schema.ts`.
- `imageRepo.findImageById(db: Executor, id: string): Promise<NoteImageRow | null>` (any state).
- `imageRepo.findLiveImageBySha256(db, sha): Promise<{ image: NoteImageRow; noteDeletedAt: Date | null } | null>`.
- `imageRepo.insertImage(db, values)` returns the row; throws `NoteError('duplicate_image')` on 23505 of `note_images_sha256_live_uniq`. Values use the drizzle camelCase field names (`id, noteId, path, sha256, mime, width, height, bytes, takenAt, originalName, host, position`).
- `imageRepo.nextPosition(db, noteId)`: max(position over all rows incl. removed) + 1, or 0.
- `imageRepo.imageIdTaken(db, id)`: true if `id` is in `notes` or `note_images`.
- `imageRepo.setImageDeleted(db, id, deleted: boolean)` returns the row. Phase 1's plan maps a 23505 on un-delete to `NoteError('duplicate_image')` (without the holder's id); the service below also tolerates a raw pg 23505, so either works.
- All of them accept a transaction handle (`repo.Executor`).

Phase 2:
- `NotesService.newId()` returns an id free in **both** `notes.id` and `note_images.id` (Contract "Image ids").
- `NotesService` keeps `interface Mutation { row: NoteRow; op: NoteOp | null }`, `private lockLive(tx, id)`, and its `finish(result: Mutation)`, which emits the event and returns the wire `Note` **with `images[]` loaded after commit**. Phase 2 makes it `private async finish(result: Mutation): Promise<Note>` (with `toNote` / `toNotes` async too; phase-2.md Step 3i), and this plan calls `return this.finish(result);` from `async` methods.
- `src/notes/service.ts` imports phase 1's repo as `import * as imageRepo from './imageRepo.js';` (phase-2.md Step 3a). Phase 2's `create` writes the first image with an inline `imageRepo.insertImage(tx, { id, noteId: id, ... position: 0 })` values object; Step 3f below replaces it with `imageValues`.
- `src/images/records.ts`: `ImageRecord = { id; note_id; path; meta: ImageMeta; position; deleted_at: string | null; note_deleted_at: string | null }`, `ImageRecords.bySha256Live(sha): Promise<ImageRecord | null>`.
- `src/images/ingest.ts` keeps `withShaLock`, `placeOriginal`, `unplaceOriginal`, `MAX_ID_ATTEMPTS`, `ImageNotes`, `ImageDeps`, `imageDeps(app)`, `IngestInput`, `IngestResult`, and keeps **`reuseExisting(deps: ImageDeps, existing: ImageRecord, bytes: Uint8Array, sourcePath: string | null, move: boolean): Promise<IngestResult>`**: places the bytes at `existing.path` when the file is missing on this host, consumes a moved source, restores the holder note when `existing.note_deleted_at !== null`, returns `{ note, created: false }`. Confirmed against phase-2.md Step 5: same name, same parameters.
- `src/http/imageAccess.ts` keeps `toolImageDeps(deps: ToolDeps): ImageDeps`, `ImageInputError`, `MAX_IMAGE_BYTES`, `expandHome`.
- `src/http/images.ts` keeps `imageRoutes(deps: AppDeps, opts: ImageRouteOptions = {}): Hono`, the `const r = new Hono()` router, `MULTIPART_OVERHEAD`, and adds `GET /api/images/:imageId` + `GET /api/images/:imageId/:variant`. None of those share a method + path with the three routes added here.
- Wire `Note.images: NoteImage[]` (live images, ascending `position`) with `NoteImage.urls.thumb === '/api/images/<id>/thumb'`.
- `tests/integration/setup.ts` `truncateAll` empties `note_images` (phase 1); `tests/integration/imageHarness.ts` keeps `startHarness`, `makeImage`, `insertTextNote` (phase 2 may change `originalPathOf` / `setTakenAt`, which this phase does not use).
- `POST /api/images` and MCP `create_image` keep their contracts (`{ note, created }`; first image id = note id).

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `NotesService.attachImage(noteId: string, input: AttachImageInput): Promise<Note>`, `NotesService.removeImage(imageId: string): Promise<Note>`, `NotesService.restoreImage(imageId: string): Promise<Note>` (`src/notes/service.ts`), plus `export interface AttachImageInput { id: string; path: string; meta: ImageMeta }`.
- `DuplicateImageError extends NoteError` with `readonly noteId: string` (`src/notes/types.ts`). Code stays `'duplicate_image'`, so every existing `NoteError` mapping still works. **Not in the Contract:** the HTTP 409 body needs `note_id`, and `NoteError` has no field for it.
- `repo.touchNote(tx: Executor, id: string): Promise<NoteRow>` (`src/notes/repo.ts`), which bumps `updated_at`. **Not in the Contract:** attach, remove and restore change what the note shows, so they bump `updated_at` the way body edits do.
- `attachImage(deps: AttachDeps, noteId: string, input: IngestInput): Promise<AttachResult>`, `type AttachResult = { note: Note; attached: boolean }`, `type AttachNotes = ImageNotes & Pick<NotesService, 'attachImage'>`, `type AttachDeps = Omit<ImageDeps, 'notes'> & { notes: AttachNotes }`, `attachDeps(app: AppDeps): AttachDeps` (`src/images/ingest.ts`). **Why a separate deps type:** adding `'attachImage'` to `ImageNotes` would break `tests/helpers/fakeNotes.ts` (`class FakeNotes implements ImageNotes`, phase 2's file).
- `attachFromUpload(img: AttachDeps, noteId: string, file: File, maxBytes?: number): Promise<AttachResult>`, `attachFromPath(img: AttachDeps, noteId: string, rawPath: string): Promise<AttachResult>`, `toolAttachDeps(deps: ToolDeps): AttachDeps` (`src/http/imageAccess.ts`).
- HTTP: `POST /api/notes/:id/images`, `DELETE /api/images/:imageId`, `POST /api/images/:imageId/restore` (`src/http/images.ts`).
- MCP tools `attach_image`, `remove_image`, `restore_image` (`src/mcp/imageTools.ts`).
- `NOTES_TOOL_NAMES` gains the three names (14 -> 17), with captions `attaching a photo`, `removing a photo` and `restoring a photo` (`src/chat/status.ts`).
- A new `Attaching.` paragraph in the MCP instructions (`src/mcp/instructions.ts`).

**Signature changes:** none of the existing signatures change.
**HTTP status details beyond the Contract (additive):** a malformed id on any of the three routes returns `400 { error: 'invalid_id' }`, the same rule `src/http/api.ts` uses. `POST /api/notes/:id/images` without a `file` field returns `400 { error: 'file_required' }`, and a broken multipart body returns `400 { error: 'bad_multipart' }`, the same as `POST /api/images`. The 409 body is `{ error: 'duplicate_image', note_id, message }`. `note_id` is `null` only in a cross-host race, where the clash is caught by the unique index instead of the pre-check.
**Event ops:** `attachImage` emits `updated`. `removeImage` emits `updated` (nothing on a no-op). `restoreImage` emits `updated`, or `restored` when it also restores the deleted owning note (nothing on a no-op). All of them carry the **note id**. No new `NoteOp` is added; phase 4 adds `purged`.
**Requires (from earlier phases):** everything under Assumptions.
**Leaves alone (owned by others):** bin listing, purge, `removeImageFiles`, `not_deleted`, `purged`, `src/http/api.ts` (Phase 4); `src/http/reveal.ts`, `src/http/app.ts` (Phase 5); `web/**` (Phases 6–9, 11); `tests/helpers/fakeNotes.ts`, `view_images`, `create_image`, image serving routes, `records.ts`, `derive.ts`, `store.ts` (Phase 2); README / SKILL.md (Phase 10).

## Files

| File | Action | What changes |
|---|---|---|
| `src/notes/types.ts` | modify | add `DuplicateImageError` right after `class NoteError` (today :98-106) |
| `src/notes/repo.ts` | modify | add `touchNote` right after `setDeleted` (today :372-381) |
| `src/notes/service.ts` | modify | `AttachImageInput`; `attachImage`, `removeImage`, `restoreImage`, `requireImageId`, `lockImage`; module helpers `imageValues`, `imageNotFound`, `isUniqueViolation`; phase 2's `create` calls `imageValues` (Step 3f) |
| `src/images/ingest.ts` | modify | `AttachNotes`, `AttachDeps`, `AttachResult`, `attachDeps`, `attachImage` (appended after `ingestImage`) |
| `src/http/imageAccess.ts` | modify | `toolAttachDeps`, `runAttach`, `checkLocalImagePath`, `attachFromUpload`, `attachFromPath` (appended at the end) |
| `src/http/images.ts` | modify | three routes + `writeErrorResponse`; imports |
| `src/mcp/imageTools.ts` | modify | three tools registered at the end of `registerImageTools`; imports |
| `src/mcp/instructions.ts` | modify | new `Attaching.` section inserted before the `Connectors.` section |
| `src/chat/status.ts` | modify | three names in `NOTES_TOOL_NAMES`, doc comment count, three captions |
| `tests/integration/images.attach.int.test.ts` | create | HTTP + service + MCP integration tests |
| `tests/unit/chat-status.test.ts` | modify | count 14 -> 17, three caption rows |
| `tests/unit/mcp.instructions.test.ts` | modify | one test for the `Attaching.` paragraph |

## Implementation Steps

### Step 1: `DuplicateImageError`
**File:** `src/notes/types.ts`, immediately after `export class NoteError { ... }` (today :98-106; phase 2 does not move it, phase 4 later adds `'not_deleted'` to `NoteErrorCode` above it)
**Change:** a subclass that carries the holder note id. Its `code` is still `'duplicate_image'`.
**Code:**
```ts
/**
 * restoreImage refused: the same bytes already live in another image. `noteId` is the note
 * holding them (HTTP answers 409 { error: 'duplicate_image', note_id }).
 */
export class DuplicateImageError extends NoteError {
  readonly noteId: string;

  constructor(noteId: string, message: string) {
    super('duplicate_image', message);
    this.name = 'DuplicateImageError';
    this.noteId = noteId;
  }
}
```
**Impact:** additive. `err instanceof NoteError` and `err.code === 'duplicate_image'` stay true, so `api.ts`'s `noteErrorResponse` and MCP's `errorResult` handle it unchanged.

### Step 2: `touchNote`
**File:** `src/notes/repo.ts`, right after `export async function setDeleted(...)` (today :372-381)
**Code:**
```ts
/** Bumps updated_at only: one of the note's images was attached, removed or restored. */
export async function touchNote(tx: Executor, id: string): Promise<NoteRow> {
  const rows = await tx.update(notes).set({ updatedAt: sql`now()` }).where(eq(notes.id, id)).returning();
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Note ${id} does not exist.`);
  return row;
}
```
**Impact:** additive. `notes`, `sql`, `eq`, `NoteError` and `NoteRow` are already imported in `repo.ts`.

### Step 3: Service writes
**File:** `src/notes/service.ts`

3a. **Imports** (top of file). Add `DuplicateImageError` to the existing `./types.js` import list (which already has `NoteError`, `type ImageMeta`, `type Note`, `type NoteRow`). Add the schema row type:
```ts
import type { NoteImageRow } from '../db/schema.js';
```
Make sure phase 1's repo is imported (see Assumptions):
```ts
import * as imageRepo from './imageRepo.js';
```

3b. **Input type.** Put it right after `export interface CreateNoteInput { ... }` (today :48-61):
```ts
/** One image to add to a live note. `id` comes from newId(); `path` is relative to dataDir (images/YYYY/MM/<id>.<ext>). */
export interface AttachImageInput {
  id: string;
  path: string;
  meta: ImageMeta;
}
```

3c. **Methods.** Insert these into `class NotesService` immediately after `async restore(...)` (today :392-402) and before `async revert(...)`:
```ts
  /**
   * Adds one image to a live note, after every image it ever had: position = max position over
   * all its images (removed ones included) + 1, so a removed image keeps its slot for restore.
   * The same bytes live anywhere -> NoteError('duplicate_image'); a taken image id ->
   * NoteError('conflict'); a deleted note -> NoteError('deleted'). Emits `updated`.
   */
  async attachImage(noteIdInput: string, input: AttachImageInput): Promise<Note> {
    const noteId = this.requireId(noteIdInput);
    const imageId = this.requireImageId(input.id);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      await this.lockLive(tx, noteId);
      if (await imageRepo.imageIdTaken(tx, imageId)) {
        throw new NoteError('conflict', `Image id ${imageId} is already taken.`);
      }
      const position = await imageRepo.nextPosition(tx, noteId);
      await imageRepo.insertImage(tx, imageValues(noteId, imageId, input.path, input.meta, position));
      return { row: await repo.touchNote(tx, noteId), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Soft-removes one image from its note (it goes to the bin; the file is untouched). Works
   * whatever state the note is in. Removing a removed image is a no-op. Returns the owning note.
   * Emits `updated` with the note id.
   */
  async removeImage(imageIdInput: string): Promise<Note> {
    const imageId = this.requireImageId(imageIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, image } = await this.lockImage(tx, imageId);
      if (image.deletedAt !== null) return { row: note, op: null };
      await imageRepo.setImageDeleted(tx, imageId, true);
      return { row: await repo.touchNote(tx, note.id), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Puts a removed image back at its old position, and restores its note when the note is
   * deleted (an image is only visible in a live note). The same bytes already live in another
   * image -> DuplicateImageError naming that image's note. A live image in a live note is a
   * no-op. Emits `restored` when the note came back, else `updated`, with the note id.
   */
  async restoreImage(imageIdInput: string): Promise<Note> {
    const imageId = this.requireImageId(imageIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, image } = await this.lockImage(tx, imageId);
      const imageRemoved = image.deletedAt !== null;
      const noteDeleted = note.deletedAt !== null;
      if (!imageRemoved && !noteDeleted) return { row: note, op: null };
      if (imageRemoved) {
        const holder = await imageRepo.findLiveImageBySha256(tx, image.sha256);
        if (holder !== null && holder.image.id !== image.id) {
          throw new DuplicateImageError(
            holder.image.noteId,
            `Image ${imageId} cannot be restored: the same picture is already in note ${holder.image.noteId}. Open that note instead, or remove the picture there first.`,
          );
        }
        try {
          await imageRepo.setImageDeleted(tx, imageId, false);
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new NoteError(
              'duplicate_image',
              `Image ${imageId} cannot be restored: the same picture was just saved in another note. Try again to see which.`,
            );
          }
          throw err;
        }
      }
      if (noteDeleted) await repo.setDeleted(tx, note.id, false);
      return { row: await repo.touchNote(tx, note.id), op: noteDeleted ? 'restored' : 'updated' };
    });
    return this.finish(result);
  }
```

3d. **Private helpers.** Put them in the class next to `lockLive` (today :420-427):
```ts
  /** Canonical image id or NoteError('invalid_id'). Image ids share the note-id format. */
  private requireImageId(input: string): string {
    const id = normalizeId(input);
    if (id === null) {
      throw new NoteError(
        'invalid_id',
        `"${input}" is not an image id. Image ids look like A-B32 (case and the dash are optional); every note lists its images with their ids.`,
      );
    }
    return id;
  }

  /**
   * Locks the image's owning note, then re-reads the image, so concurrent changes to one note's
   * images run one after another. Unknown image -> NoteError('not_found').
   * Lock order for the whole set: the note row first, then the image row (the image row is
   * locked implicitly by the UPDATE that follows). Phase 4's purgeImage uses the same order.
   */
  private async lockImage(tx: repo.Tx, imageId: string): Promise<{ note: NoteRow; image: NoteImageRow }> {
    const first = await imageRepo.findImageById(tx, imageId);
    if (first === null) throw imageNotFound(imageId);
    const note = await repo.lockNote(tx, first.noteId);
    const image = await imageRepo.findImageById(tx, imageId);
    if (note === null || image === null) throw imageNotFound(imageId);
    return { note, image };
  }
```

3e. **Module helpers.** Put them at the bottom of the file, after `roundSimilarity`:
```ts
/** note_images insert values for one image (drizzle field names). */
function imageValues(noteId: string, id: string, path: string, meta: ImageMeta, position: number) {
  return {
    id,
    noteId,
    path,
    sha256: meta.sha256,
    mime: meta.mime,
    width: meta.width,
    height: meta.height,
    bytes: meta.bytes,
    takenAt: meta.taken_at === null ? null : new Date(meta.taken_at),
    originalName: meta.original_name,
    host: meta.host,
    position,
  };
}

function imageNotFound(imageId: string): NoteError {
  return new NoteError('not_found', `Image ${imageId} does not exist. Image ids are listed in each note's images.`);
}

/** A unique-index clash: phase 1's NoteError('duplicate_image') or a raw Postgres 23505. */
function isUniqueViolation(err: unknown): boolean {
  if (err instanceof NoteError) return err.code === 'duplicate_image';
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth += 1) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
```
**Impact:** the service gains three writers. Read paths are unchanged. Phase 4 later adds `listBin` / `purgeNote` / `purgeImage` to the same class; it inserts after `restoreImage`.

3f. **`create` uses `imageValues`** (reconciled: phase 2 has no helper; it inlines the mapping). In phase 2's `create` (phase-2.md Step 3d), replace the whole `await imageRepo.insertImage(tx, { id, noteId: id, path: image.path, sha256: ..., position: 0 });` call with:
```ts
          await imageRepo.insertImage(tx, imageValues(id, id, image.path, image.meta, 0));
```
Behaviour is unchanged (same fields, same values); the ImageMeta-to-row mapping now lives in one place.

### Step 4: Ingest `attachImage`
**File:** `src/images/ingest.ts`

4a. **Types and deps.** Put them right after `export type IngestResult = ...` (today :56):
```ts
/** attachImage's result. attached: false = the bytes already live in `note` (this note or another). */
export type AttachResult = { note: Note; attached: boolean };

/** ImageNotes plus the one writer attaching needs. Kept separate so ImageNotes fakes stay valid. */
export type AttachNotes = ImageNotes & Pick<NotesService, 'attachImage'>;

export type AttachDeps = Omit<ImageDeps, 'notes'> & { notes: AttachNotes };

/** AttachDeps for the running daemon's HTTP routes. */
export function attachDeps(app: AppDeps): AttachDeps {
  return { ...imageDeps(app), notes: app.service };
}
```

4b. **Function.** Append it after `ingestImage` and before `locateImage`:
```ts
/**
 * Add an image to an existing live note, or return the note that already holds these bytes.
 *
 * The target must be live (unknown -> NoteError('not_found'), deleted -> NoteError('deleted');
 * nothing is read or written then). Under the sha lock: a live image with the same sha256
 * anywhere -> that image's note is returned, restored if deleted (attached: false; nothing is
 * stored). Otherwise: probe, fresh image id (free in notes and note_images), write the original
 * byte for byte to images/YYYY/MM/<imageId>.<ext>, then attach through the notes service. If the
 * attach fails the file is removed (or moved back): NoteError('duplicate_image') is a concurrent
 * save of the same bytes (return the winner), NoteError('conflict') an id clash (retry).
 * `input.body` and `input.origin` are ignored: attaching never changes the note's text.
 *
 * Throws UnsupportedImageError (probe.ts) for anything that is not a supported image.
 */
export async function attachImage(deps: AttachDeps, noteIdInput: string, input: IngestInput): Promise<AttachResult> {
  const target = await deps.notes.getOne(noteIdInput, { includeDeleted: true });
  if (target === null) throw new NoteError('not_found', `Note ${noteIdInput} does not exist.`);
  if (target.deleted_at !== undefined) {
    throw new NoteError('deleted', `Note ${target.id} is deleted. Call restore("${target.id}") first if you want to attach to it.`);
  }

  const sourcePath = input.path !== undefined ? path.resolve(input.path) : null;
  const move = sourcePath !== null && input.move === true;
  const bytes: Uint8Array = sourcePath !== null ? await readFile(sourcePath) : input.bytes!;
  const sha256 = sha256Hex(bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256Live(sha256);
    if (existing) {
      const reused = await reuseExisting(deps, existing, bytes, sourcePath, move);
      return { note: reused.note, attached: false };
    }

    const probe = await probeImage(bytes);
    const nameSource = input.originalName ?? (sourcePath !== null ? path.basename(sourcePath) : null);
    const originalName = nameSource ? path.basename(nameSource) : null;
    const ext = chooseExt(originalName, probe.mimeExt);
    const savedAt = (deps.now ?? (() => new Date()))();
    const meta: ImageMeta = {
      sha256,
      mime: probe.mime,
      width: probe.width,
      height: probe.height,
      bytes: bytes.byteLength,
      taken_at: probe.taken_at,
      original_name: originalName,
      host: (deps.hostname ?? os.hostname)(),
    };

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const imageId = await deps.notes.newId();
      const relPath = originalRelPath(imageId, ext, savedAt);
      const abs = resolveInDataDir(deps.dataDir, relPath);
      if (await fileExists(abs)) continue;
      await placeOriginal(abs, bytes, sourcePath, move);
      try {
        const note = await deps.notes.attachImage(target.id, { id: imageId, path: relPath, meta });
        return { note, attached: true };
      } catch (err) {
        await unplaceOriginal(abs, sourcePath, move);
        if (!(err instanceof NoteError) || (err.code !== 'duplicate_image' && err.code !== 'conflict')) throw err;
        if (err.code === 'duplicate_image') {
          const winner = await deps.records.bySha256Live(sha256);
          if (winner) {
            const reused = await reuseExisting(deps, winner, bytes, sourcePath, move);
            return { note: reused.note, attached: false };
          }
        }
      }
    }
    throw new Error(`could not allocate a free image id in ${MAX_ID_ATTEMPTS} attempts`);
  });
}
```
**Impact:** additive. Every identifier it uses (`readFile`, `os`, `path`, `NoteError`, `ImageMeta`, `Note`, `NotesService` type, `AppDeps` type, `probeImage`, `sha256Hex`, `chooseExt`, `originalRelPath`, `resolveInDataDir`, `fileExists`, `withShaLock`, `placeOriginal`, `unplaceOriginal`, `reuseExisting`, `MAX_ID_ATTEMPTS`, `imageDeps`) is already imported or defined in `ingest.ts` today. `AttachDeps` is assignable to `ImageDeps`, so `reuseExisting(deps, ...)` typechecks. The inbox and `ingestImage` stay one-note-per-file (brief R1).

### Step 5: Upload and path front doors
**File:** `src/http/imageAccess.ts`

5a. **Imports.** Extend the `../images/ingest.js` import (phase 2's list plus these names):
```ts
import { attachImage, type AttachDeps, type AttachResult } from '../images/ingest.js';
```
Merge it into the existing import line rather than adding a second import of the same module.

5b. **Append** at the end of the file:
```ts
/** AttachDeps for the MCP tools. */
export function toolAttachDeps(deps: ToolDeps): AttachDeps {
  return { ...toolImageDeps(deps), notes: deps.service };
}

async function runAttach(img: AttachDeps, noteId: string, input: Parameters<typeof attachImage>[2]): Promise<AttachResult> {
  try {
    return await attachImage(img, noteId, input);
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      throw new ImageInputError('not_an_image', `not an image: ${err.message}`);
    }
    throw err;
  }
}

/** A local file path a tool may read: absolute (or ~/), an existing non-empty regular file under the cap. */
async function checkLocalImagePath(rawPath: string): Promise<string> {
  const p = expandHome(rawPath.trim());
  if (!path.isAbsolute(p)) {
    throw new ImageInputError('not_absolute', `path must be absolute (or start with ~/): ${rawPath}`);
  }
  let st;
  try {
    st = await stat(p);
  } catch {
    throw new ImageInputError('not_found', `no such file: ${p}`);
  }
  if (!st.isFile()) throw new ImageInputError('not_a_file', `not a regular file: ${p}`);
  if (st.size === 0) throw new ImageInputError('not_an_image', `empty file: ${p}`);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new ImageInputError('too_large', `file is ${st.size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  }
  return p;
}

/** HTTP POST /api/notes/:id/images: bytes come from the multipart File. */
export async function attachFromUpload(
  img: AttachDeps,
  noteId: string,
  file: File,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<AttachResult> {
  if (file.size === 0) throw new ImageInputError('not_an_image', 'the uploaded file is empty');
  if (file.size > maxBytes) {
    throw new ImageInputError('too_large', `file is ${file.size} bytes; the limit is ${maxBytes}`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  return runAttach(img, noteId, { bytes, originalName: file.name || 'upload' });
}

/** MCP attach_image: a local file, copied (never moved). */
export async function attachFromPath(img: AttachDeps, noteId: string, rawPath: string): Promise<AttachResult> {
  const p = await checkLocalImagePath(rawPath);
  return runAttach(img, noteId, { path: p, originalName: path.basename(p), move: false });
}
```
**Impact:** additive. `stat`, `path`, `UnsupportedImageError`, `ImageInputError`, `MAX_IMAGE_BYTES`, `expandHome`, `toolImageDeps` and `ToolDeps` are already in the file. `checkLocalImagePath` repeats the checks in `ingestFromPath`, which is left alone on purpose (see Handoffs).

### Step 6: HTTP routes
**File:** `src/http/images.ts`

6a. **Imports.** Add these to what phase 2 leaves (keep phase 2's imports; merge names into existing import lines from the same module):
```ts
import { attachDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import { DuplicateImageError, NoteError } from '../notes/types.js';
import { attachFromUpload } from './imageAccess.js';
```
(`ImageInputError`, `MAX_IMAGE_BYTES`, `Hono`, `Context`, `bodyLimit` are already imported.)

6b. **Error mapping.** Put this module-level function right after `contentDisposition` (today :26-29):
```ts
/** ImageInputError / NoteError from the attach, remove and restore routes -> HTTP. Anything else is rethrown (500). */
function writeErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof ImageInputError) {
    const status = err.code === 'too_large' ? 413 : 415;
    return c.json({ error: err.code, message: err.message }, status);
  }
  if (!(err instanceof NoteError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'deleted':
      return c.json({ error: 'not_found' }, 404);
    case 'invalid_id':
      return c.json({ error: 'invalid_id' }, 400);
    case 'duplicate_image':
      return c.json(
        { error: 'duplicate_image', note_id: err instanceof DuplicateImageError ? err.noteId : null, message: err.message },
        409,
      );
    case 'conflict':
      return c.json({ error: 'conflict' }, 409);
    default:
      return c.json({ error: `${err.code}: ${err.message}` }, 400);
  }
}
```

6c. **Routes.** Inside `imageRoutes`, right after `const img = imageDeps(deps);` add:
```ts
  const attach = attachDeps(deps);
```
Then, immediately after the existing `r.post('/api/images', ...)` registration and before the variant `GET` loops, add:
```ts
  r.post(
    '/api/notes/:id/images',
    bodyLimit({
      maxSize: maxUpload + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: 'too_large', max_bytes: maxUpload }, 413),
    }),
    async (c) => {
      const noteId = normalizeId(c.req.param('id') ?? '');
      if (noteId === null) return c.json({ error: 'invalid_id' }, 400);
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'bad_multipart' }, 400);
      }
      const fileField = Array.isArray(form['file']) ? form['file'][0] : form['file'];
      if (!(fileField instanceof File)) return c.json({ error: 'file_required' }, 400);
      try {
        const result = await attachFromUpload(attach, noteId, fileField, maxUpload);
        return c.json(result, result.attached ? 201 : 200);
      } catch (err) {
        return writeErrorResponse(c, err);
      }
    },
  );

  r.delete('/api/images/:imageId', async (c) => {
    const imageId = normalizeId(c.req.param('imageId') ?? '');
    if (imageId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.removeImage(imageId));
    } catch (err) {
      return writeErrorResponse(c, err);
    }
  });

  r.post('/api/images/:imageId/restore', async (c) => {
    const imageId = normalizeId(c.req.param('imageId') ?? '');
    if (imageId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.restoreImage(imageId));
    } catch (err) {
      return writeErrorResponse(c, err);
    }
  });
```
**Impact:** three new routes. They are not behind `sameOriginOnly`, because none of them destroys data (Contract: only purge and reveal are guarded). Statuses: attach 201 / 200 / 400 / 404 / 413 / 415; remove 200 / 400 / 404; restore 200 / 400 / 404 / 409.

### Step 7: MCP tools
**File:** `src/mcp/imageTools.ts`

7a. **Imports.** Add these to the existing lines (merge with phase 2's names):
```ts
import { attachFromPath, ImageInputError, toolAttachDeps } from '../http/imageAccess.js';
import { errorResult, run, type ToolDeps } from './tools.js';
```
`ImageInputError` and `ToolDeps` are already imported. Turn the `import type { ToolDeps } from './tools.js'` line into the mixed import shown above. There is no import cycle: `tools.ts` does not import `imageTools.ts`.

7b. **Registrations.** At the end of `registerImageTools(server, deps)`, after the `view_images` registration and before the closing brace:
```ts
  const attach = toolAttachDeps(deps);

  server.registerTool(
    'attach_image',
    {
      title: 'Attach image to note',
      description:
        'Add a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...) to an existing note; a note can hold several images, kept in attach order. ' +
        'Give the note id and an absolute path (~/ is expanded). The file is COPIED byte for byte into the notes store; the source is left where it is. ' +
        'If the exact same file already lives in a note (this one or another), nothing is copied and that note is returned with attached: false: tell the user which note holds it (a deleted holder note is restored). ' +
        'The note must not be deleted (restore it first). Non-image files are refused. Returns { note, attached }; a new image is the last entry of note.images.',
      inputSchema: {
        id: z.string().min(1).describe('Note id like A-B32 to attach to. Case-insensitive; the dash may be omitted.'),
        path: z.string().min(1).describe('Absolute path to the image file, or a path starting with ~/.'),
        origin: originShape,
      },
    },
    async ({ id, path }): Promise<CallToolResult> => {
      try {
        const result = await attachFromPath(attach, id, path);
        return { content: [text(JSON.stringify(result, null, 2))] };
      } catch (err) {
        if (err instanceof ImageInputError) {
          return { isError: true, content: [text(`attach_image refused (${err.code}): ${err.message}`)] };
        }
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'remove_image',
    {
      title: 'Remove image from note',
      description:
        "Take one image out of its note. This is soft and reversible: the image moves to the recycle bin, its file stays on disk, and restore_image(image_id) puts it back at the same position. " +
        "Pass the image's id (each entry of a note's images has one; the first image of a note saved from a picture has the note's own id). " +
        'Removing an image that is already removed changes nothing. Returns { note }: the owning note without that image.',
      inputSchema: {
        image_id: z.string().min(1).describe('Image id like A-B32 (from note.images[].id). Case-insensitive; the dash may be omitted.'),
      },
    },
    async ({ image_id }): Promise<CallToolResult> => run(async () => ({ note: await deps.service.removeImage(image_id) })),
  );

  server.registerTool(
    'restore_image',
    {
      title: 'Restore removed image',
      description:
        'Undo remove_image: put a removed image back into its note at its old position. If the note itself was deleted it is restored too. ' +
        'Refused (duplicate_image) when the same picture has since been saved again and is live in another note; the error names that note. ' +
        'Returns { note }.',
      inputSchema: {
        image_id: z.string().min(1).describe('Id of the removed image, like A-B32. Case-insensitive; the dash may be omitted.'),
      },
    },
    async ({ image_id }): Promise<CallToolResult> => run(async () => ({ note: await deps.service.restoreImage(image_id) })),
  );
```
**Impact:** three new tools. `origin` is accepted for symmetry with `create_image`, so the `/n` skill can pass it unconditionally, but it is not stored: an image row has no origin, and attaching never changes the note's own origin. No MCP tool deletes permanently (invariant 3). `remove_image` is soft and `restore_image` reverses it.

### Step 8: Instructions paragraph
**File:** `src/mcp/instructions.ts`, in `buildInstructions`'s `sections` array. Insert a new element **immediately before** the element that starts with `` `Connectors. ``. That puts it right after the `Images.` element, whatever text phase 2 gives that paragraph.
**Code:**
```ts
    `Attaching. A note can hold several images, in attach order; each entry of a note's images has its own id (image ids look like note ids; the first image of a note saved from a picture has the note's own id). attach_image(id, path) adds a local image file to an existing note: the file is copied, not moved. If the same file already lives in a note (that one or another), nothing is copied and that note comes back with attached: false, so tell the user where the picture already is. remove_image(image_id) takes one image out of its note: it is soft, the image goes to the recycle bin with its file untouched, and restore_image(image_id) puts it back at its old position (restoring its note too if the note was deleted). Nothing you can call deletes a note or an image permanently; only the user can, from the recycle bin in the web page.`,
```
**Impact:** the server instructions get one paragraph longer. The doc comment above `buildInstructions` is not touched.

### Step 9: Chat tool surface and captions
**File:** `src/chat/status.ts`

9a. Replace `NOTES_TOOL_NAMES` (today :18-31):
```ts
export const NOTES_TOOL_NAMES = [
  'create',
  'get',
  'update',
  'append',
  'delete',
  'restore',
  'list',
  'search',
  'tags',
  'related',
  'revisions',
  'revert',
  'create_image',
  'view_images',
  'attach_image',
  'remove_image',
  'restore_image',
] as const;
```

9b. Replace the doc comment above `allowedChatTools` (today :46-50):
```ts
/**
 * Exactly the 17 notes tools, the 15 connector tools and WebSearch + WebFetch
 * (CONNECTORS_PLAN invariant 8, which supersedes CHAT_BAR_BRAIN_PLAN invariant 4;
 * SEMANTIC_SEARCH_PLAN phase 5 adds `related`; WALL_EDITING_PLAN phase 3 adds
 * `attach_image`, `remove_image` and `restore_image`).
 */
```

9c. In `captionForToolUse`'s `switch (tool)`, add these cases immediately before `default:`:
```ts
    case 'attach_image':
      return 'attaching a photo';
    case 'remove_image':
      return 'removing a photo';
    case 'restore_image':
      return 'restoring a photo';
```
**Impact:** the chat brain may call the three tools (`src/chat/agent.ts` reads `allowedChatTools()`; no change there). Removal through chat stays soft.

### Step 10: Unit tests
**File:** `tests/unit/chat-status.test.ts`

10a. Replace the whole `describe('allowedChatTools', ...)` block (today :7-22):
```ts
describe('allowedChatTools', () => {
  it('is exactly the 17 notes tools, the 15 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(17);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(tools).toHaveLength(17 + 15 + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('mcp__notes__related');
    expect(tools).toContain('mcp__notes__attach_image');
    expect(tools).toContain('mcp__notes__remove_image');
    expect(tools).toContain('mcp__notes__restore_image');
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });

  it('offers no tool that deletes permanently', () => {
    expect(NOTES_TOOL_NAMES.filter((name) => /purge|forever|destroy/.test(name))).toEqual([]);
  });
});
```

10b. In the first `it.each([...])` table of `describe('captionForToolUse')`, insert these three rows right after `[n('restore'), {}, 'restoring a note'],`:
```ts
    [n('attach_image'), { id: 'A-B32', path: '/tmp/a.png' }, 'attaching a photo'],
    [n('remove_image'), { image_id: 'C-D54' }, 'removing a photo'],
    [n('restore_image'), { image_id: 'C-D54' }, 'restoring a photo'],
```

**File:** `tests/unit/mcp.instructions.test.ts`. Add this test inside `describe('buildInstructions', ...)`, after the `Related` test:
```ts
  it('has one Attaching paragraph: attach_image copies and dedupes, remove_image is soft, restore_image undoes it', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Attaching.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['attach_image(id, path)', 'remove_image(image_id)', 'restore_image(image_id)', 'attached: false', 'soft', 'old position']) {
      expect(p).toContain(word);
    }
    expect(p).toContain('copied, not moved');
    expect(p).toContain('Nothing you can call deletes a note or an image permanently');
  });
```

### Step 11: Integration tests
**File:** `tests/integration/images.attach.int.test.ts` (new)
**Code:**
```ts
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageRoutes } from '../../src/http/images.js';
import type { NoteEvent } from '../../src/notes/events.js';
import type { Note } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

type AttachBody = { note: Note; attached: boolean };
type ImageRow = { id: string; position: number; deleted_at: Date | null; path: string; sha256: string };
type ToolResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string } | { type: string }>;
};

const ID = /^[0-9A-Z]-[0-9A-Z]{3}$/;

async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out.sort();
}

function solid(r: number, g: number, b: number): Promise<Buffer> {
  return makeImage('png', 32, 32, { r, g, b });
}

async function imageRows(h: Harness, noteId: string): Promise<ImageRow[]> {
  const res = await h.deps.db.execute<ImageRow>(
    sql`select id, position, deleted_at, path, sha256 from note_images where note_id = ${noteId} order by position`,
  );
  return res.rows;
}

describe('HTTP attach / remove / restore one image', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function upload(bytes: Buffer, name = 'shot.png'): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name, { type: 'image/png' }));
    const res = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  async function attach(noteId: string, bytes: Buffer, name = 'more.png', app: Hono = h.app): Promise<Response> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name, { type: 'image/png' }));
    return app.request(`/api/notes/${noteId}/images`, { method: 'POST', body: fd });
  }

  async function attachOk(noteId: string, bytes: Buffer, name = 'more.png'): Promise<AttachBody> {
    const res = await attach(noteId, bytes, name);
    expect(res.status).toBe(201);
    return (await res.json()) as AttachBody;
  }

  async function removeImg(imageId: string): Promise<Response> {
    return h.app.request(`/api/images/${imageId}`, { method: 'DELETE' });
  }

  async function restoreImg(imageId: string): Promise<Response> {
    return h.app.request(`/api/images/${imageId}/restore`, { method: 'POST' });
  }

  it('attaches more images to a note that already has one, in order, as new files', async () => {
    const first = await upload(await solid(10, 20, 30));
    expect(first.images.map((i) => i.id)).toEqual([first.id]);

    const bytes2 = await solid(40, 50, 60);
    const res = await attach(first.id, bytes2, 'second.png');
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(true);
    expect(body.note.id).toBe(first.id);
    expect(body.note.images).toHaveLength(2);
    expect(body.note.images[0]!.id).toBe(first.id);
    const second = body.note.images[1]!;
    expect(second.id).toMatch(ID);
    expect(second.id).not.toBe(first.id);
    expect(second.position).toBe(1);
    expect(second.note_id).toBe(first.id);
    expect(second.original_name).toBe('second.png');
    expect(second.available).toBe(true);
    expect(second.urls.thumb).toBe(`/api/images/${second.id}/thumb`);
    // A fresh image id is never also a note id.
    expect(await h.deps.service.getOne(second.id, { includeDeleted: true })).toBeNull();

    const rows = await imageRows(h, first.id);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[1]!.path).toMatch(new RegExp(`^images/\\d{4}/\\d{2}/${second.id}\\.png$`));
    expect(await readFile(path.join(h.dataDir, rows[1]!.path))).toEqual(bytes2);
    expect((await h.app.request(`/api/images/${second.id}/thumb`)).status).toBe(200);

    const third = await attachOk(first.id, await solid(70, 80, 90), 'third.png');
    expect(third.note.images.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it('attaches to a text note and accepts any id spelling', async () => {
    await insertTextNote(h, 'T-XT1', 'just words');
    const res = await attach('txt1', await solid(1, 200, 1));
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.note.id).toBe('T-XT1');
    expect(body.note.body).toBe('just words');
    expect(body.note.images).toHaveLength(1);
    expect(body.note.images[0]!.position).toBe(0);
  });

  it('dedupes per live image across notes: the holder comes back and nothing is copied', async () => {
    const bytes = await solid(1, 2, 3);
    const holder = await upload(bytes);
    await insertTextNote(h, 'T-XT1', 'another note');
    const before = await filesUnder(path.join(h.dataDir, 'images'));

    const res = await attach('T-XT1', bytes, 'copy.png');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(false);
    expect(body.note.id).toBe(holder.id);
    expect(await imageRows(h, 'T-XT1')).toEqual([]);
    expect(await filesUnder(path.join(h.dataDir, 'images'))).toEqual(before);
  });

  it('dedupes within the same note', async () => {
    const n = await upload(await solid(9, 9, 9));
    const bytes = await solid(8, 8, 8);
    await attachOk(n.id, bytes);
    const again = await attach(n.id, bytes, 'same-again.png');
    expect(again.status).toBe(200);
    const body = (await again.json()) as AttachBody;
    expect(body.attached).toBe(false);
    expect(body.note.id).toBe(n.id);
    expect(body.note.images).toHaveLength(2);
    expect(await imageRows(h, n.id)).toHaveLength(2);
  });

  it('a deleted holder note is restored and returned', async () => {
    const bytes = await solid(11, 12, 13);
    const holder = await upload(bytes);
    await h.deps.service.delete(holder.id);
    await insertTextNote(h, 'T-XT1', 'target');

    const res = await attach('T-XT1', bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(false);
    expect(body.note.id).toBe(holder.id);
    expect(body.note.deleted_at).toBeUndefined();
    expect(await h.deps.service.getOne(holder.id)).not.toBeNull();
  });

  it('a removed image does not count for dedupe', async () => {
    const n = await upload(await solid(20, 21, 22));
    const bytes = await solid(23, 24, 25);
    const b = (await attachOk(n.id, bytes)).note.images[1]!;
    expect((await removeImg(b.id)).status).toBe(200);
    await insertTextNote(h, 'T-XT1', 'target');

    const body = await attachOk('T-XT1', bytes);
    expect(body.attached).toBe(true);
    expect(body.note.id).toBe('T-XT1');
    expect(body.note.images[0]!.id).not.toBe(b.id);
  });

  it('refuses unknown, deleted and malformed note ids, non-images, oversized uploads and a missing file', async () => {
    const png = await solid(30, 31, 32);

    const unknown = await attach('Z-ZZZ', png);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe('not_found');

    const gone = await h.deps.service.create({ body: 'soon deleted' });
    await h.deps.service.delete(gone.id);
    expect((await attach(gone.id, png)).status).toBe(404);

    const bad = await attach('not-an-id', png);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_id');

    await insertTextNote(h, 'T-XT1', 'target');
    const notImage = await attach('T-XT1', Buffer.from('hello, not a picture'), 'a.txt');
    expect(notImage.status).toBe(415);
    expect(((await notImage.json()) as { error: string }).error).toBe('not_an_image');

    const small = new Hono().route('/', imageRoutes(h.deps, { maxUploadBytes: 1024 }));
    const big = Buffer.concat([await makeImage('png', 300, 300, { r: 250, g: 1, b: 250 }), Buffer.alloc(4096, 7)]);
    const tooBig = await attach('T-XT1', big, 'big.png', small);
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: string }).error).toBe('too_large');

    const fd = new FormData();
    fd.append('body', 'no file');
    const noFile = await h.app.request('/api/notes/T-XT1/images', { method: 'POST', body: fd });
    expect(noFile.status).toBe(400);
    expect(((await noFile.json()) as { error: string }).error).toBe('file_required');

    expect(await filesUnder(path.join(h.dataDir, 'images'))).toEqual([]);
    expect(await imageRows(h, 'T-XT1')).toEqual([]);
  });

  it('remove keeps the file and the slot; restore puts the image back at its old position', async () => {
    const n = await upload(await solid(40, 41, 42));
    const b = (await attachOk(n.id, await solid(43, 44, 45))).note.images[1]!;
    const c = (await attachOk(n.id, await solid(46, 47, 48))).note.images[2]!;

    const removed = await removeImg(b.id);
    expect(removed.status).toBe(200);
    const afterRemove = (await removed.json()) as Note;
    expect(afterRemove.id).toBe(n.id);
    expect(afterRemove.images.map((i) => i.id)).toEqual([n.id, c.id]);

    // Idempotent.
    const again = await removeImg(b.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Note).images.map((i) => i.id)).toEqual([n.id, c.id]);

    const rowB = (await imageRows(h, n.id)).find((r) => r.id === b.id)!;
    expect(rowB.deleted_at).not.toBeNull();
    await access(path.join(h.dataDir, rowB.path)); // the original stays on disk
    // The bin still serves its thumbnail (phase 2: any existing row is served).
    expect((await h.app.request(`/api/images/${b.id}/thumb`)).status).toBe(200);

    // A later attach goes after every slot, removed ones included.
    const d = (await attachOk(n.id, await solid(49, 50, 51))).note.images[2]!;
    expect(d.position).toBe(3);

    const restored = await restoreImg(b.id);
    expect(restored.status).toBe(200);
    const afterRestore = (await restored.json()) as Note;
    expect(afterRestore.images.map((i) => i.id)).toEqual([n.id, b.id, c.id, d.id]);
    expect(afterRestore.images.map((i) => i.position)).toEqual([0, 1, 2, 3]);

    // Restoring a live image of a live note changes nothing.
    const noop = await restoreImg(b.id);
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as Note).images.map((i) => i.id)).toEqual([n.id, b.id, c.id, d.id]);
  });

  it('restoring an image whose bytes are live elsewhere is a 409 naming the holder', async () => {
    const bytes = await solid(60, 61, 62);
    const n1 = await upload(bytes);
    expect((await removeImg(n1.id)).status).toBe(200);
    const n2 = await upload(bytes); // the removed image does not dedupe, so this is a new note
    expect(n2.id).not.toBe(n1.id);

    const res = await restoreImg(n1.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; note_id: string | null };
    expect(body.error).toBe('duplicate_image');
    expect(body.note_id).toBe(n2.id);
    expect((await imageRows(h, n1.id))[0]!.deleted_at).not.toBeNull();
  });

  it('restoring a removed image of a deleted note restores the note too', async () => {
    const n = await upload(await solid(70, 71, 72));
    const b = (await attachOk(n.id, await solid(73, 74, 75))).note.images[1]!;
    expect((await removeImg(b.id)).status).toBe(200);
    await h.deps.service.delete(n.id);

    const res = await restoreImg(b.id);
    expect(res.status).toBe(200);
    const note = (await res.json()) as Note;
    expect(note.id).toBe(n.id);
    expect(note.deleted_at).toBeUndefined();
    expect(note.images.map((i) => i.id)).toEqual([n.id, b.id]);
  });

  it('answers 404 for unknown image ids and 400 for malformed ones', async () => {
    expect((await removeImg('Z-ZZZ')).status).toBe(404);
    expect((await restoreImg('Z-ZZZ')).status).toBe(404);
    const bad = await removeImg('nope!!');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_id');
    expect((await restoreImg('nope!!')).status).toBe(400);
  });

  it('emits one updated event with the note id per change, none for a no-op', async () => {
    const n = await upload(await solid(80, 81, 82));
    const seen: NoteEvent[] = [];
    const off = h.deps.events.on((e) => seen.push(e));
    try {
      const b = (await attachOk(n.id, await solid(83, 84, 85))).note.images[1]!;
      await removeImg(b.id);
      await removeImg(b.id);
      await restoreImg(b.id);
    } finally {
      off();
    }
    const updated = { type: 'note', op: 'updated', id: n.id };
    expect(seen).toEqual([updated, updated, updated]);
  });

  it('two concurrent attaches of the same bytes leave exactly one live image', async () => {
    await insertTextNote(h, 'T-XT1', 'one');
    await insertTextNote(h, 'T-XT2', 'two');
    const bytes = await solid(90, 91, 92);
    const [r1, r2] = await Promise.all([attach('T-XT1', bytes), attach('T-XT2', bytes)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const b1 = (await r1.json()) as AttachBody;
    const b2 = (await r2.json()) as AttachBody;
    expect(b1.note.id).toBe(b2.note.id);
    const sha = (await imageRows(h, b1.note.id))[0]!.sha256;
    const live = await h.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from note_images where sha256 = ${sha} and deleted_at is null`,
    );
    expect(live.rows[0]?.n).toBe(1);
  });
});

describe('MCP attach_image / remove_image / restore_image', () => {
  let h: Harness;
  let client: Client;
  let srcDir: string;

  beforeAll(async () => {
    h = await startHarness();
    const base = await h.listen();
    client = new Client({ name: 'p3-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    srcDir = path.join(h.dataDir, '..', `p3-src-${process.pid}`);
  });
  afterAll(async () => {
    await client.close();
    await rm(srcDir, { recursive: true, force: true });
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    await rm(srcDir, { recursive: true, force: true });
    await mkdir(srcDir, { recursive: true });
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  function textOf(r: ToolResult): string {
    return r.content.flatMap((c) => (c.type === 'text' ? [(c as { text: string }).text] : [])).join('\n');
  }

  async function file(name: string, bytes: Buffer): Promise<string> {
    const p = path.join(srcDir, name);
    await writeFile(p, bytes);
    return p;
  }

  async function attachTool(id: string, p: string): Promise<AttachBody> {
    const r = await call('attach_image', { id, path: p });
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r)) as AttachBody;
  }

  it('lists the three tools and no tool that deletes permanently', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['attach_image', 'remove_image', 'restore_image']));
    expect(names.filter((n) => /purge|forever|destroy/.test(n))).toEqual([]);
  });

  it('attach_image copies the file into the note, dedupes, and leaves the source in place', async () => {
    const n = await h.deps.service.create({ body: 'words #seer' });
    const p = await file('shot.png', await solid(100, 101, 102));

    const r = await call('attach_image', { id: n.id.toLowerCase().replace('-', ''), path: p, origin: { cwd: '/tmp' } });
    expect(r.isError, textOf(r)).toBeFalsy();
    const first = JSON.parse(textOf(r)) as AttachBody;
    expect(first.attached).toBe(true);
    expect(first.note.id).toBe(n.id);
    expect(first.note.body).toBe('words #seer');
    expect(first.note.images).toHaveLength(1);
    expect(first.note.images[0]!.original_name).toBe('shot.png');
    await access(p);

    const again = await attachTool(n.id, p);
    expect(again.attached).toBe(false);
    expect(again.note.id).toBe(n.id);
    expect(again.note.images).toHaveLength(1);
  });

  it('remove_image and restore_image round-trip and keep the position', async () => {
    const n = await h.deps.service.create({ body: 'two pictures' });
    const a = (await attachTool(n.id, await file('a.png', await solid(110, 0, 0)))).note.images[0]!;
    const b = (await attachTool(n.id, await file('b.png', await solid(0, 110, 0)))).note.images[1]!;

    const removed = await call('remove_image', { image_id: a.id });
    expect(removed.isError, textOf(removed)).toBeFalsy();
    expect((JSON.parse(textOf(removed)) as { note: Note }).note.images.map((i) => i.id)).toEqual([b.id]);

    const restored = await call('restore_image', { image_id: a.id.toLowerCase() });
    expect(restored.isError, textOf(restored)).toBeFalsy();
    const note = (JSON.parse(textOf(restored)) as { note: Note }).note;
    expect(note.images.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(note.images.map((i) => i.position)).toEqual([0, 1]);
  });

  it('reports clashes, deleted notes, relative paths and unknown image ids as tool errors', async () => {
    const bytes = await solid(120, 121, 122);
    const n1 = await h.deps.service.create({ body: 'first holder' });
    const x1 = (await attachTool(n1.id, await file('x.png', bytes))).note.images[0]!;
    expect((await call('remove_image', { image_id: x1.id })).isError).toBeFalsy();
    const n2 = await h.deps.service.create({ body: 'second holder' });
    expect((await attachTool(n2.id, await file('x-again.png', bytes))).attached).toBe(true);

    const clash = await call('restore_image', { image_id: x1.id });
    expect(clash.isError).toBe(true);
    expect(textOf(clash)).toMatch(/^duplicate_image: /);
    expect(textOf(clash)).toContain(`already in note ${n2.id}`);

    const n3 = await h.deps.service.create({ body: 'deleted target' });
    await h.deps.service.delete(n3.id);
    const deleted = await call('attach_image', { id: n3.id, path: await file('y.png', await solid(1, 1, 1)) });
    expect(deleted.isError).toBe(true);
    expect(textOf(deleted)).toMatch(/^deleted: /);

    const relative = await call('attach_image', { id: n2.id, path: 'relative/shot.png' });
    expect(relative.isError).toBe(true);
    expect(textOf(relative)).toContain('not_absolute');

    const unknown = await call('remove_image', { image_id: 'Z-ZZZ' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/^not_found: /);
  });
});
```
**Impact:** this file is new and needs Docker Postgres (`npm run test:int`). It covers the R5 items "attach/remove image" and "per-image dedupe" for both HTTP and MCP. Phase 4 owns the bin listing and purge tests.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit: `chat-status`, `mcp.instructions`), then `npm run test:int` (new `images.attach.int.test.ts`, plus every existing file unchanged and green).
**Manual check:** optional. With the worktree daemon running on a scratch data dir (`NOTES_DATA_DIR=/tmp/p3 npm run dev`, Docker DB), run `curl -F file=@a.png localhost:<port>/api/notes/<id>/images`, then `curl -X DELETE .../api/images/<imgId>`, then `curl -X POST .../api/images/<imgId>/restore`. `images[]` should change shape accordingly.
**Exit criteria:**
- The three HTTP routes and the three MCP tools behave as contracted.
- Dedupe returns the holder (restoring a deleted holder).
- A removed image is invisible in `images[]`, still on disk, and comes back at its old position.
- A restore clash answers 409 `{ error: 'duplicate_image', note_id }`.
- `NOTES_TOOL_NAMES` has 17 entries with captions.
- typecheck, unit and integration suites are green.

## Handoffs

- **Phase 4 (R3):** `listBin` must list images whose `deleted_at` is set, which this phase produces through `removeImage`. `POST /api/notes/:id/restore` and the purge routes are phase 4's. Phase 4 adds `'not_deleted'` to `NoteErrorCode` in `types.ts` above `DuplicateImageError` (no overlap), and its new service methods go after `restoreImage`. `writeErrorResponse` in `images.ts` falls through `default` to 400 for any code it does not know, so `not_deleted` never reaches these routes.
- **Phase 7 (R2):** uses `POST /api/notes/:id/images`: 201 `{ note, attached: true }`, 200 `{ note, attached: false }` where `note` may be **another** note (the holder) the editor should mention quietly, 404 when the edited note is gone. It also uses `DELETE /api/images/:id` (200 owner note).
- **Phase 8 (R3):** uses `POST /api/images/:id/restore` (200 note, 409 `{ error: 'duplicate_image', note_id, message }`). Undo of an image removal calls this route.
- **Phase 10 (R5 docs):** the README API table and MCP tool table need `POST /api/notes/:id/images`, `DELETE /api/images/:id`, `POST /api/images/:id/restore` and `attach_image` / `remove_image` / `restore_image`. `claude/skills/n/SKILL.md` needs "attach <path> to note <id>".
- **Cleanup (any later phase / follow-up, not R-bound):** `checkLocalImagePath` duplicates the checks inside `ingestFromPath`, and `attachImage`'s probe/meta block duplicates `ingestImage`'s. Folding them is a refactor that touches phase 2's code and was left out on purpose.
- **Reconciled:** phase 2 has no ImageMeta-to-row helper, so `imageValues` is the one and `create` now uses it (Step 3f). `reuseExisting` keeps its phase-2 name and parameters. Lock order is note row, then image row, here and in phase 4's `purgeImage`.
- **Phase 4 (R3):** `requireImageId` (private, Step 3d) is reused by `purgeImage`.

## Rollback

Revert this phase's commit. Nothing in the schema changes. Images attached while this phase was live stay as ordinary `note_images` rows and files that phase 2's code already reads and serves. Removed images keep `deleted_at` set until phase 4's restore or bin handles them, or until a manual `update note_images set deleted_at = null where id = ...`.
