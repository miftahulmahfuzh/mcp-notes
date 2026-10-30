> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 4. Source: `.workflows/plan/wall-editing/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Bin listing, note restore endpoint, purge (rows + files)

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R3 (server side of the recycle bin: listing, restore, delete forever), R5 (this phase's own tests)
**Depends on:** Phase 3 (and through it, phases 1 and 2)
**Difficulty:** NORMAL
**Package:** `src/notes`, `src/images`, `src/http`

---

## Goal

After this phase the daemon has a recycle bin over HTTP. `GET /api/bin` lists deleted notes and binned images, newest-deleted first, with the tag AND filter. `POST /api/notes/:id/restore` brings a deleted note back. Two same-origin-only `DELETE` routes purge a deleted note, or one removed image, for good: database rows, the original file and the derived files. Nothing else in `images/` or `cache/` is touched. No MCP tool can purge, and a test asserts it.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `BinImage`, `Bin`, `PurgeResult` interfaces (`src/notes/types.ts`)
- `NoteErrorCode` member `'not_deleted'` (`src/notes/types.ts`)
- `NoteOp` member `'purged'` (`src/notes/events.ts`)
- `NotesService.listBin(opts?: BinOptions): Promise<Bin>`, `NotesService.purgeNote(id): Promise<PurgeResult>`, `NotesService.purgeImage(imageId): Promise<PurgeResult>`, exported `BinOptions` interface (`src/notes/service.ts`)
- New module `src/notes/binRepo.ts`: `BinImageRow`, `listDeletedNoteIds`, `listBinImages`, `lockImageRow`, `deleteNoteRow`, `deleteImageRow`, `clearLegacyImage`. (Reconciled: an image by id and a note's image rows incl. removed ones come from phase 1's `imageRepo.findImageById` / `imageRepo.imagesForNotes(…, { includeRemoved: true })`, not from new duplicates here.)
- `removeImageFiles(dataDir, { id, path }): Promise<number>` (`src/images/store.ts`)
- HTTP routes (`src/http/api.ts`): `GET /api/bin?tag=`, `POST /api/notes/:id/restore`, `DELETE /api/bin/notes/:id` (behind `sameOriginOnly`), `DELETE /api/bin/images/:imageId` (behind `sameOriginOnly`)
- `noteErrorResponse` maps `not_deleted` to HTTP 409 `{ error: 'not_deleted' }`
- Tests: `tests/integration/bin.int.test.ts` (new), `tests/unit/images/removeImageFiles.test.ts` (new); one added `purged` emit in `tests/unit/embeddings/worker.test.ts`

**Signature changes:** none to existing symbols. Two unions widen: `NoteErrorCode` and `NoteOp`.

**Requires (from earlier phases):**
- Phase 1: `noteImages` table and `NoteImageRow` type exported from `src/db/schema.ts`. `notes.imagePath` / `notes.imageMeta` are still in the drizzle `notes` table (legacy, kept by contract). The `note_images.note_id` FK is `on delete cascade`. `reconcileLegacyImages(db)` exported from `src/images/legacy.ts` (used only by the test). `truncateAll` empties `note_images`.
- Phase 2: wire `Note.images: NoteImage[]` (live images only, position order) on every service read path, `NotesService.get(ids, { includeDeleted: true })` included. `get` still returns notes in the order the ids were asked for. **`toNoteImage(row: NoteImageRow, dataDir: string): NoteImage` exported from `src/notes/types.ts`** (confirmed in phase-2.md Step 1: that exact name and signature; it sets `deleted_at` only on removed rows). It is used in exactly one place here (`toBinImage`). Phase 2's `service.ts` imports phase 1's repo as `imageRepo`; Step 4 reuses `imageRepo.findImageById` and `imageRepo.imagesForNotes`. `sameOriginOnly: MiddlewareHandler` exported from `src/http/sameOrigin.ts`. `repo.lockNote`, `repo.normalizeTagInput`, `repo.Executor`, `repo.Tx` are unchanged in `src/notes/repo.ts`. `GET /api/images/:imageId/thumb` serves any existing row, which the test uses to build cache dirs. `startHarness`, `makeImage` and `Harness` still exist in `tests/integration/imageHarness.ts`.
- Phase 3: `POST /api/notes/:id/images` returns 201 `{ note, attached }`, with the new image last in `note.images`, and `DELETE /api/images/:imageId` soft-removes one image and returns 200 (test fixtures). In code: `DuplicateImageError` sits after `NoteError` in `types.ts` and is in `service.ts`'s `./types.js` import; `NotesService` has the private `requireImageId(input)` (Step 4 reuses it) and locks the note row before touching an image row (`lockImage`), the same order Step 4 uses.

**Leaves alone (owned by others):** `web/**` (phases 6–9, 11); every MCP file (`src/mcp/**`) and `src/chat/status.ts`, because no tool is added; `src/notes/repo.ts` and `src/notes/imageRepo.ts` (phases 1–2; this phase's queries go in the new `binRepo.ts` so nothing collides); `src/http/images.ts`, `src/http/imageAccess.ts`, `src/http/sameOrigin.ts` (phases 2–3); phase 3's `attachImage` / `removeImage` / `restoreImage` behaviour; `src/http/reveal.ts`, `src/http/app.ts` (phases 2 and 5); `src/embeddings/worker.ts` (not edited; checked below).

## Files

| File | Action | What changes |
|---|---|---|
| `src/notes/types.ts` | modify | add `'not_deleted'` to `NoteErrorCode`; add `BinImage`, `Bin`, `PurgeResult` |
| `src/notes/events.ts:3` | modify | `NoteOp` gains `'purged'` |
| `src/notes/binRepo.ts` | create | bin listing queries, image row lock and deletes for purge, legacy-column clear |
| `src/notes/service.ts` | modify | `listBin`, `purgeNote`, `purgeImage`, private `removeFiles`, module function `toBinImage`, imports |
| `src/images/store.ts` | modify | `removeImageFiles` appended; `lstat`, `readdir` imported |
| `src/http/api.ts` | modify | import `sameOriginOnly`; `not_deleted` → 409; four routes |
| `tests/integration/bin.int.test.ts` | create | bin, restore, purge, Origin and no-purge-tool tests |
| `tests/unit/images/removeImageFiles.test.ts` | create | path confinement and counting of `removeImageFiles` |
| `tests/unit/embeddings/worker.test.ts:56-77` | modify | the worker ignores `purged` |

## Checked, no change needed

- **Embeddings worker** (`src/embeddings/worker.ts:120-122`) kicks only on `created` / `updated`, so `purged` is ignored. A purged note's `note_embeddings` rows go with the cascade, and the sweep lists pending notes from `notes`, which no longer has the row. Step 8 adds a test.
- **SSE** (`src/http/api.ts:178-184`) forwards `{ op, id }` for any op.
- **Web `useNotes`** (`web/src/hooks/useNotes.ts:74`) refetches on every `note` event and never reads `op`. Nothing in `web/src` names `NoteOp`. A `purged` event only causes a harmless refetch.
- **`NoteErrorCode` consumers**: `src/mcp/tools.ts:131` and `src/mcp/imageTools.ts:73` format any code generically. `src/images/ingest.ts:181` compares to specific codes. `api.ts` has a `default` branch. Widening the union breaks no exhaustive switch.

## Implementation Steps

### Step 1: Error code, bin types and purge result
**File:** `src/notes/types.ts`. The `NoteErrorCode` union is at line 86 today; phase 2 leaves it in place. The new interfaces go directly after the `SearchPage` interface (line 84 today), which phase 2 also keeps.

**Change A:** replace the `NoteErrorCode` union with:
```ts
export type NoteErrorCode =
  | 'invalid_id'
  | 'invalid_input'
  | 'not_found'
  | 'deleted'
  | 'not_deleted'
  | 'empty_body'
  | 'conflict'
  | 'duplicate_image'
  | 'invalid_revision'
  | 'not_embedded';
```
If phase 2 or 3 adds members, keep theirs and add `'not_deleted'`.

**Change B:** insert after `SearchPage`:
```ts
/**
 * One tile of the bin's image grid.
 * 'note': an image (not itself removed) of a deleted note; restore / delete forever act on the note.
 * 'image': an image removed from its note; restore / delete forever act on the image. A removed
 * image of a deleted note is listed once, as 'image'.
 */
export interface BinImage {
  image: NoteImage;
  note_id: string;
  kind: 'note' | 'image';
  /** When it went to the bin (ISO 8601 UTC): the note's deleted_at for 'note', the image's for 'image'. */
  deleted_at: string;
}

/** GET /api/bin. Both lists newest deleted_at first. */
export interface Bin {
  /** Deleted notes, each with its non-removed images (Note.images). */
  notes: Note[];
  images: BinImage[];
}

/** Result of purgeNote / purgeImage. */
export interface PurgeResult {
  /** The purged note id or image id. */
  purged: string;
  /** Files removed from disk: originals plus derived files under cache/<imageId>/. */
  files: number;
}
```
**Impact:** additive. `NoteImage` and `Note` are phase 2's wire types.

### Step 2: `purged` op
**File:** `src/notes/events.ts:3`
**Change:** widen the union.
**Code:**
```ts
export type NoteOp = 'created' | 'updated' | 'deleted' | 'restored' | 'purged';
```
**Impact:** the emitter is unchanged. Consumers are covered under "Checked, no change needed".

### Step 3: Bin queries
**File:** `src/notes/binRepo.ts` (new)
**Change:** every SQL this phase needs. It lives in its own module so it never collides with phase 1's `imageRepo.ts` or phase 2's `repo.ts`.
**Code:**
```ts
import { and, arrayContains, desc, eq, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { noteImages, notes, type NoteImageRow } from '../db/schema.js';
import { normalizeTagInput, type Executor, type Tx } from './repo.js';

/** A binned image with its note's deleted_at (null when the note is live). */
export interface BinImageRow {
  image: NoteImageRow;
  noteDeletedAt: Date | null;
}

/** Tag AND filter on the owning note; `#` and case ignored. */
function tagConditions(tagsAll: readonly string[] | undefined): SQL[] {
  const all = normalizeTagInput(tagsAll);
  return all.length > 0 ? [arrayContains(notes.tags, all)] : [];
}

/** Ids of deleted notes carrying every tag in `tagsAll`, newest deleted_at first. */
export async function listDeletedNoteIds(db: Executor, tagsAll?: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNotNull(notes.deletedAt), ...tagConditions(tagsAll)))
    .orderBy(desc(notes.deletedAt), desc(notes.id));
  return rows.map((r) => r.id);
}

/**
 * Every image in the bin: removed images (of any note) and the non-removed images of deleted
 * notes, filtered by the owning note's tags, newest bin time first. The bin time of a removed
 * image is its own deleted_at, so a removed image of a deleted note appears once.
 */
export async function listBinImages(db: Executor, tagsAll?: readonly string[]): Promise<BinImageRow[]> {
  const binnedAt = sql`coalesce(${noteImages.deletedAt}, ${notes.deletedAt})`;
  return db
    .select({ image: noteImages, noteDeletedAt: notes.deletedAt })
    .from(noteImages)
    .innerJoin(notes, eq(noteImages.noteId, notes.id))
    .where(and(or(isNotNull(noteImages.deletedAt), isNotNull(notes.deletedAt)), ...tagConditions(tagsAll)))
    .orderBy(desc(binnedAt), desc(noteImages.id));
}

/** Reads an image row and locks it until the transaction ends. */
export async function lockImageRow(tx: Tx, id: string): Promise<NoteImageRow | null> {
  const rows = await tx.select().from(noteImages).where(eq(noteImages.id, id)).for('update');
  return rows[0] ?? null;
}

/** Deletes a notes row; note_images, note_revisions and note_embeddings go with it (FK cascade). */
export async function deleteNoteRow(tx: Executor, id: string): Promise<boolean> {
  const rows = await tx.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
  return rows.length > 0;
}

export async function deleteImageRow(tx: Executor, id: string): Promise<boolean> {
  const rows = await tx.delete(noteImages).where(eq(noteImages.id, id)).returning({ id: noteImages.id });
  return rows.length > 0;
}

/**
 * Forgets a note's legacy single image (notes.image_path / image_meta), so reconcileLegacyImages
 * cannot copy a purged image back. updated_at is left alone: the note's text did not change.
 */
export async function clearLegacyImage(tx: Executor, noteId: string): Promise<void> {
  await tx.update(notes).set({ imagePath: null, imageMeta: null }).where(eq(notes.id, noteId));
}
```
**Impact:** new module. It reads the legacy columns only through `clearLegacyImage` and the `lockNote` row in Step 4, and the contract allows "purge clearing them".

### Step 4: Service: `listBin`, `purgeNote`, `purgeImage`
**File:** `src/notes/service.ts`

**Change A, imports.** Add to the import block at the top of the file (lines 1–33 today). `import * as imageRepo from './imageRepo.js';` is already there (phase 2):
```ts
import { removeImageFiles } from '../images/store.js';
import * as bin from './binRepo.js';
import type { BinImageRow } from './binRepo.js';
```
Extend the existing `./types.js` import list with `type Bin`, `type BinImage`, `type PurgeResult` and `toNoteImage` (phase 2's converter; see Requires). After phases 2 and 3 the import reads, in full (`DuplicateImageError` is phase 3's):
```ts
import {
  DuplicateImageError,
  NoteError,
  cleanOrigin,
  rowToNote,
  toNoteImage,
  type Bin,
  type BinImage,
  type ImageMeta,
  type Note,
  type NotePage,
  type NoteRow,
  type Origin,
  type PurgeResult,
  type RelatedResult,
  type Revision,
  type SearchMode,
  type SearchPage,
  type TagCount,
} from './types.js';
```
Keep any names phases 2 and 3 added to this import. Add only `toNoteImage`, `Bin`, `BinImage` and `PurgeResult`, and drop nothing.

**Change B, options type.** Add next to the other option interfaces (after `RelatedOptions`, line 89 today):
```ts
export interface BinOptions {
  /** Entries whose note carries every one of these tags. `#` prefix and case are ignored. */
  tagsAll?: string[];
}
```

**Change C, methods.** Insert into `NotesService` directly after `restore` (lines 393–402 today; phase 3's image methods may sit nearby, so put these after whichever of `restore` / `restoreImage` comes last and before `revert`):
```ts
  /**
   * The recycle bin: deleted notes (each with its non-removed images) and every binned image,
   * both newest-deleted first, optionally narrowed to notes carrying every tag in `tagsAll`.
   * Read-only; live notes' sidebar counts (tags()) are unaffected.
   */
  async listBin(opts: BinOptions = {}): Promise<Bin> {
    const ids = await bin.listDeletedNoteIds(this.db, opts.tagsAll);
    // get() keeps the asked order and attaches each note's live images (phase 2). A note purged
    // between the two queries lands in `missing` and is simply not listed.
    const { notes } = await this.get(ids, { includeDeleted: true });
    const rows = await bin.listBinImages(this.db, opts.tagsAll);
    return { notes, images: rows.map((r) => toBinImage(r, this.dataDir)) };
  }

  /**
   * Delete forever: only a deleted note. Removes the notes row (images, revisions and embeddings
   * cascade) in one transaction, then the original and derived files of every image the note
   * held, removed ones included. UI-only: no MCP tool calls this.
   */
  async purgeNote(idInput: string): Promise<PurgeResult> {
    const id = this.requireId(idInput);
    const targets = await this.db.transaction(async (tx): Promise<Array<{ id: string; path: string }>> => {
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt === null) {
        throw new NoteError('not_deleted', `Note ${id} is not deleted. Only notes in the bin can be deleted forever.`);
      }
      const rows = (await imageRepo.imagesForNotes(tx, [id], { includeRemoved: true })).get(id) ?? [];
      const files = rows.map((img) => ({ id: img.id, path: img.path }));
      // The legacy column names a file too; after the reconcile it is the same path as the
      // note's first image row, so this only adds something if that row is somehow missing.
      if (cur.imagePath !== null && !files.some((f) => f.path === cur.imagePath)) {
        files.push({ id, path: cur.imagePath });
      }
      await bin.deleteNoteRow(tx, id);
      return files;
    });
    const files = await this.removeFiles(targets);
    this.events.emit('purged', id);
    return { purged: id, files };
  }

  /**
   * Delete forever: only an image removed from its note (its own deleted_at set). An image of a
   * deleted note that was never removed is purged with its note (purgeNote), not here. When the
   * row is the note's legacy image (same id as the note and the path in notes.image_path), the
   * legacy columns are cleared in the same transaction so reconcileLegacyImages cannot bring it
   * back. Then its original and derived files are removed.
   */
  async purgeImage(idInput: string): Promise<PurgeResult> {
    const imageId = this.requireImageId(idInput);
    const first = await imageRepo.findImageById(this.db, imageId);
    if (first === null) throw new NoteError('not_found', `Image ${imageId} does not exist.`);
    const target = await this.db.transaction(async (tx) => {
      // Note first, then image: the same order as the image writes of phase 3.
      const note = await repo.lockNote(tx, first.noteId);
      const img = await bin.lockImageRow(tx, imageId);
      if (note === null || img === null) throw new NoteError('not_found', `Image ${imageId} does not exist.`);
      if (img.deletedAt === null) {
        throw new NoteError(
          'not_deleted',
          `Image ${imageId} is not removed from note ${img.noteId}. Only images in the bin can be deleted forever.`,
        );
      }
      await bin.deleteImageRow(tx, imageId);
      if (img.id === img.noteId && note.imagePath === img.path) await bin.clearLegacyImage(tx, note.id);
      return img;
    });
    const files = await this.removeFiles([{ id: target.id, path: target.path }]);
    this.events.emit('purged', target.noteId);
    return { purged: imageId, files };
  }

  /**
   * Removes each image's original and cache dir after the rows are gone. A file that cannot be
   * removed is logged and skipped: the purge already committed, and a leftover file is
   * harmless (no row points at it).
   */
  private async removeFiles(targets: ReadonlyArray<{ id: string; path: string }>): Promise<number> {
    let removed = 0;
    for (const target of targets) {
      try {
        removed += await removeImageFiles(this.dataDir, target);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`notesd: purge could not remove the files of image ${target.id} (${target.path}): ${reason}`);
      }
    }
    return removed;
  }
```
`requireImageId` is phase 3's private helper (phase-3.md Step 3d). Lock order is confirmed against phase 3's `lockImage`: both lock the note row first, then the image row, so purge and remove/restore cannot deadlock.

**Change D, module function.** Append after `roundSimilarity` at the end of the file:
```ts
/** One bin listing row -> wire BinImage. The bin query guarantees one of the two times is set. */
function toBinImage(row: BinImageRow, dataDir: string): BinImage {
  const removedAt = row.image.deletedAt;
  const binnedAt = removedAt ?? row.noteDeletedAt;
  if (binnedAt === null) throw new Error(`image ${row.image.id} is not in the bin`);
  const image = toNoteImage(row.image, dataDir);
  return {
    // deleted_at on the image itself marks a removed image (contract: present only on those).
    image: removedAt !== null ? { ...image, deleted_at: removedAt.toISOString() } : image,
    note_id: row.image.noteId,
    kind: removedAt !== null ? 'image' : 'note',
    deleted_at: binnedAt.toISOString(),
  };
}
```
**Impact:** three new public methods plus one private one. Existing methods are unchanged. The only new emits are `purged` events, one per successful purge.

### Step 5: `removeImageFiles`
**File:** `src/images/store.ts`. Change the import at line 2, and append after `moveIntoNewFile` (ends at line 138 today). Phase 2 edits this file elsewhere; this is an append only.

**Change A, import line 2** becomes:
```ts
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
```
Keep any names phase 2 added to this import.

**Change B, append:**
```ts
async function isFileOrLink(p: string): Promise<boolean> {
  try {
    const s = await lstat(p);
    return s.isFile() || s.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Delete forever, on disk: unlinks one image's original and removes its derived files
 * (`cache/<id>/`). The original is touched only when `path` resolves strictly inside
 * `<dataDir>/images/`; anything else (a path escaping the data dir, the inbox, the cache) is left
 * alone. The cache dir is touched only when `id` is a single path segment. Returns how many files
 * were removed: 1 for the original plus one per entry of the cache dir. Missing files count 0.
 * Never touches any other file, and leaves the (possibly empty) images/YYYY/MM dirs in place.
 */
export async function removeImageFiles(dataDir: string, image: { id: string; path: string }): Promise<number> {
  const dirs = dataDirs(dataDir);
  let removed = 0;

  const original = path.resolve(dirs.root, image.path);
  if (original.startsWith(dirs.images + path.sep) && (await isFileOrLink(original))) {
    await rm(original, { force: true });
    removed += 1;
  }

  const id = image.id;
  if (id === '' || id === '.' || id === '..' || path.basename(id) !== id) return removed;
  const cacheDir = path.join(dirs.cache, id);
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return removed;
    throw err;
  }
  await rm(cacheDir, { recursive: true, force: true });
  return removed + entries.length;
}
```
**Impact:** new export. Nothing existing calls it. This is the only code in the repo that unlinks an original (invariant 2).

### Step 6: HTTP routes and the 409 mapping
**File:** `src/http/api.ts` (phases 2 and 3 do not edit this file, so the line numbers are today's)

**Change A, import:** add after line 10 (`import { NoteError } from '../notes/types.js';`):
```ts
import { sameOriginOnly } from './sameOrigin.js';
```

**Change B, `noteErrorResponse` (lines 53–67)** becomes:
```ts
/** The one NoteError → HTTP mapping. Anything else is rethrown (Hono answers 500). */
function noteErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof NoteError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'deleted':
      return notFound(c);
    case 'conflict':
    case 'duplicate_image':
    case 'not_deleted':
      return c.json({ error: err.code }, 409);
    case 'invalid_id':
      return badRequest(c, 'invalid_id');
    default:
      return badRequest(c, `${err.code}: ${err.message}`);
  }
}
```

**Change C, routes:** insert after the `api.delete('/api/notes/:id', …)` handler (lines 160–170) and before `api.get('/api/tags', …)` (line 172):
```ts
  /** The recycle bin: deleted notes and binned images, newest-deleted first. `?tag=` is AND. */
  api.get('/api/bin', async (c) => {
    const tags = parseTagParams(c.req.queries('tag'));
    try {
      return c.json(await service.listBin(tags.length > 0 ? { tagsAll: tags } : {}));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  /** Undo a soft delete. Restoring a live note is a no-op that returns it. */
  api.post('/api/notes/:id/restore', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    try {
      return c.json(await service.restore(id));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  /** Delete forever (UI only): a deleted note, its rows and every file of its images. */
  api.delete('/api/bin/notes/:id', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    try {
      return c.json(await service.purgeNote(id));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  /** Delete forever (UI only): one image removed from its note, its row and its files. */
  api.delete('/api/bin/images/:imageId', sameOriginOnly, async (c) => {
    const imageId = normalizeId(c.req.param('imageId'));
    if (imageId === null) return badRequest(c, 'invalid_id');
    try {
      return c.json(await service.purgeImage(imageId));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });
```
**Impact:** four new routes. `apiRoutes` is mounted before `imageRoutes` (`src/http/app.ts`). None of these method+path pairs collides with phase 2/3 routes: `GET /api/notes/:id/:variant` is GET only, `POST /api/notes/:id/images` has a different last segment, and `DELETE /api/images/:imageId` has a different prefix. The guard runs before id validation, so a cross-origin request gets 403 even for a bad id.

### Step 7: Unit test for `removeImageFiles`
**File:** `tests/unit/images/removeImageFiles.test.ts` (new)
**Code:**
```ts
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileExists, removeImageFiles } from '../../../src/images/store.js';
import { tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(async () => cleanup());

async function put(rel: string, text = 'x'): Promise<string> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text);
  return abs;
}

describe('removeImageFiles', () => {
  it('removes the original and every derived file, and nothing else', async () => {
    const original = await put('images/2026/10/A-B32.png');
    const sibling = await put('images/2026/10/C-D45.png');
    await put('cache/A-B32/thumb.webp');
    await put('cache/A-B32/display.jpg');
    const otherCache = await put('cache/C-D45/thumb.webp');

    const n = await removeImageFiles(dir, { id: 'A-B32', path: 'images/2026/10/A-B32.png' });

    expect(n).toBe(3);
    expect(await fileExists(original)).toBe(false);
    expect(await fileExists(sibling)).toBe(true);
    expect(await fileExists(otherCache)).toBe(true);
    expect(await readdir(path.join(dir, 'cache'))).toEqual(['C-D45']);
    // The month dir stays even if it were empty; only files go.
    expect(await readdir(path.join(dir, 'images/2026/10'))).toEqual(['C-D45.png']);
  });

  it('counts 0 for files that are already gone', async () => {
    expect(await removeImageFiles(dir, { id: 'A-B32', path: 'images/2026/10/A-B32.png' })).toBe(0);
  });

  it('never unlinks an original outside <dataDir>/images/', async () => {
    const inbox = await put('inbox/A-B32.png');
    const cacheFile = await put('cache/keep.png');
    const outside = await put('../outside-A-B32.png');
    try {
      expect(await removeImageFiles(dir, { id: 'Z-ZZ1', path: 'inbox/A-B32.png' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ2', path: 'cache/keep.png' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ3', path: '../outside-A-B32.png' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ4', path: outside })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ5', path: 'images' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ6', path: 'images/../inbox/A-B32.png' })).toBe(0);
      expect(await fileExists(inbox)).toBe(true);
      expect(await fileExists(cacheFile)).toBe(true);
      expect(await fileExists(outside)).toBe(true);
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(outside, { force: true }));
    }
  });

  it('never removes the cache root or a dir outside it for a malformed id', async () => {
    const keep = await put('cache/A-B32/thumb.webp');
    for (const id of ['', '.', '..', '../cache', 'A-B32/..', 'x/y']) {
      expect(await removeImageFiles(dir, { id, path: 'images/none.png' })).toBe(0);
    }
    expect(await fileExists(keep)).toBe(true);
  });
});
```
**Impact:** new unit test, runs in `npm test`.

### Step 8: Worker ignores `purged`
**File:** `tests/unit/embeddings/worker.test.ts:56-77`
**Change:** rename the test and emit `purged` beside `deleted` / `restored`. The full replacement test:
```ts
  it('created and updated events trigger a drain; deleted, restored and purged do not', async () => {
    const store = new MemoryEmbeddingStore();
    const embedder = new ScriptedEmbedder();
    const { events, worker: w } = start(store, embedder);
    await w.idle();

    store.setBody('A-001', 'hello');
    events.emit('created', 'A-001');
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    store.setBody('A-001', 'hello again');
    events.emit('updated', 'A-001');
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    const lists = store.listCalls;
    events.emit('deleted', 'A-001');
    events.emit('restored', 'A-001');
    events.emit('purged', 'A-001');
    await w.idle();
    expect(store.listCalls).toBe(lists);
    expect(embedder.calls).toHaveLength(2);
  });
```
**Impact:** test only. `src/embeddings/worker.ts` is not edited.

### Step 9: Integration test
**File:** `tests/integration/bin.int.test.ts` (new)
**Code:**
```ts
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOTES_TOOL_NAMES } from '../../src/chat/status.js';
import { reconcileLegacyImages } from '../../src/images/legacy.js';
import type { NoteEvent } from '../../src/notes/events.js';
import type { Bin, Note, PurgeResult, TagCount } from '../../src/notes/types.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

/** app.request builds http://localhost/... URLs, so this is the page's own origin. */
const ORIGIN = 'http://localhost';

describe('recycle bin, restore and delete forever', () => {
  let h: Harness;
  const seen: NoteEvent[] = [];
  let unsubscribe: () => void = () => {};
  let colour = 0;

  beforeAll(async () => {
    h = await startHarness();
    unsubscribe = h.deps.events.on((e) => seen.push(e));
  });
  afterAll(async () => {
    unsubscribe();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    seen.length = 0;
  });

  // ---------- fixtures over the public HTTP surface ----------

  /** Distinct bytes on every call so nothing dedupes by accident. */
  async function png(): Promise<Buffer> {
    colour += 1;
    return makeImage('png', 16, 16, { r: colour % 256, g: Math.floor(colour / 256) % 256, b: 77 });
  }

  async function textNote(body: string): Promise<Note> {
    const res = await h.app.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Note;
  }

  async function upload(body: string): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([await png()], 'shot.png', { type: 'image/png' }));
    fd.append('body', body);
    const res = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  /** Attaches a new image; returns the note and the new image's id (the last by position). */
  async function attach(noteId: string): Promise<{ note: Note; imageId: string }> {
    const fd = new FormData();
    fd.append('file', new File([await png()], 'more.png', { type: 'image/png' }));
    const res = await h.app.request(`/api/notes/${noteId}/images`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const { note } = (await res.json()) as { note: Note; attached: boolean };
    const last = note.images[note.images.length - 1];
    if (!last) throw new Error('attach returned a note without images');
    return { note, imageId: last.id };
  }

  function firstImageId(note: Note): string {
    const first = note.images[0];
    if (!first) throw new Error(`note ${note.id} has no image`);
    return first.id;
  }

  async function removeImage(imageId: string): Promise<void> {
    expect((await h.app.request(`/api/images/${imageId}`, { method: 'DELETE' })).status).toBe(200);
  }

  async function deleteNote(id: string): Promise<void> {
    expect((await h.app.request(`/api/notes/${id}`, { method: 'DELETE' })).status).toBe(200);
  }

  /** Builds cache/<imageId>/thumb.webp. */
  async function thumb(imageId: string): Promise<void> {
    const res = await h.app.request(`/api/images/${imageId}/thumb`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  }

  async function setNoteDeletedAt(id: string, iso: string): Promise<void> {
    await h.deps.db.execute(sql`update notes set deleted_at = ${iso}::timestamptz where id = ${id}`);
  }

  async function setImageDeletedAt(id: string, iso: string): Promise<void> {
    await h.deps.db.execute(sql`update note_images set deleted_at = ${iso}::timestamptz where id = ${id}`);
  }

  async function fetchBin(query = ''): Promise<Bin> {
    const res = await h.app.request(`/api/bin${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Bin;
  }

  function purge(kind: 'notes' | 'images', id: string, origin: string | null = ORIGIN): Promise<Response> {
    const headers: Record<string, string> = origin === null ? {} : { origin };
    return h.app.request(`/api/bin/${kind}/${id}`, { method: 'DELETE', headers });
  }

  async function imageRow(id: string): Promise<{ id: string; note_id: string; path: string } | undefined> {
    const res = await h.deps.db.execute<{ id: string; note_id: string; path: string }>(
      sql`select id, note_id, path from note_images where id = ${id}`,
    );
    return res.rows[0];
  }

  async function countRows(table: 'notes' | 'note_images' | 'note_revisions', noteId: string): Promise<number> {
    const column = table === 'notes' ? sql.raw('id') : sql.raw('note_id');
    const res = await h.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.raw(table)} where ${column} = ${noteId}`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Every file (not dir) under the data dir's images/ and cache/, relative to the data dir. */
  async function dataFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(path.relative(h.dataDir, p));
      }
    };
    await walk(path.join(h.dataDir, 'images'));
    await walk(path.join(h.dataDir, 'cache'));
    return out.sort();
  }

  /** The files a purge of these images must remove: each original plus its cache dir's files. */
  function filesOf(before: string[], images: Array<{ id: string; path: string }>): string[] {
    return before.filter((f) => images.some((img) => f === img.path || f.startsWith(`cache/${img.id}/`))).sort();
  }

  // ---------- listing ----------

  /**
   * T  text note "first #a"                     deleted   2026-10-01
   * L  live note "live #a", image L1 live, L2 removed 2026-10-02
   * N  note "photo #a #b", image N1, N2 removed 2026-10-04, note deleted 2026-10-03
   */
  async function seedBin(): Promise<{ t: Note; l: Note; n: Note; l2: string; n1: string; n2: string }> {
    const t = await textNote('first #a');
    const l = await upload('live #a');
    const { imageId: l2 } = await attach(l.id);
    const n = await upload('photo #a #b');
    const { imageId: n2 } = await attach(n.id);
    await removeImage(l2);
    await removeImage(n2);
    await deleteNote(t.id);
    await deleteNote(n.id);
    await setNoteDeletedAt(t.id, '2026-10-01T00:00:00Z');
    await setImageDeletedAt(l2, '2026-10-02T00:00:00Z');
    await setNoteDeletedAt(n.id, '2026-10-03T00:00:00Z');
    await setImageDeletedAt(n2, '2026-10-04T00:00:00Z');
    return { t, l, n, l2, n1: firstImageId(n), n2 };
  }

  it('lists deleted notes and binned images newest-deleted first, each image once', async () => {
    const { t, n, l, l2, n1, n2 } = await seedBin();
    const bin = await fetchBin();

    expect(bin.notes.map((x) => x.id)).toEqual([n.id, t.id]);
    expect(bin.notes[0]?.deleted_at).toBe('2026-10-03T00:00:00.000Z');
    // A deleted note carries its non-removed images only.
    expect(bin.notes[0]?.images.map((i) => i.id)).toEqual([n1]);
    expect(bin.notes[1]?.images).toEqual([]);

    expect(bin.images.map((b) => [b.image.id, b.kind, b.note_id, b.deleted_at])).toEqual([
      [n2, 'image', n.id, '2026-10-04T00:00:00.000Z'],
      [n1, 'note', n.id, '2026-10-03T00:00:00.000Z'],
      [l2, 'image', l.id, '2026-10-02T00:00:00.000Z'],
    ]);
    // deleted_at on the image itself marks removed images only.
    expect(bin.images[0]?.image.deleted_at).toBe('2026-10-04T00:00:00.000Z');
    expect(bin.images[1]?.image.deleted_at).toBeUndefined();
    expect(new Set(bin.images.map((b) => b.image.id)).size).toBe(bin.images.length);
    // The live image of the live note is not in the bin.
    expect(bin.images.some((b) => b.image.id === firstImageId(l))).toBe(false);
  });

  it('applies tag filters as AND on the owning note', async () => {
    const { t, n, l2, n1, n2 } = await seedBin();

    const ab = await fetchBin('?tag=a&tag=%23B');
    expect(ab.notes.map((x) => x.id)).toEqual([n.id]);
    expect(ab.images.map((b) => b.image.id)).toEqual([n2, n1]);

    const a = await fetchBin('?tag=a');
    expect(a.notes.map((x) => x.id)).toEqual([n.id, t.id]);
    expect(a.images.map((b) => b.image.id)).toEqual([n2, n1, l2]);

    const none = await fetchBin('?tag=zzz');
    expect(none).toEqual({ notes: [], images: [] });
  });

  it('sidebar tags still count live notes only', async () => {
    await seedBin();
    const res = await h.app.request('/api/tags');
    const tags = (await res.json()) as TagCount[];
    expect(tags.map((x) => [x.tag, x.count])).toEqual([['a', 1]]);
  });

  it('an empty bin is two empty lists', async () => {
    await textNote('alive');
    expect(await fetchBin()).toEqual({ notes: [], images: [] });
  });

  // ---------- restore ----------

  it('POST /api/notes/:id/restore brings a deleted note back with its images', async () => {
    const note = await upload('two pictures');
    await attach(note.id);
    await deleteNote(note.id);
    expect((await h.app.request(`/api/notes/${note.id}`)).status).toBe(404);

    const res = await h.app.request(`/api/notes/${note.id.replace('-', '').toLowerCase()}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const back = (await res.json()) as Note;
    expect(back.id).toBe(note.id);
    expect(back.deleted_at).toBeUndefined();
    expect(back.images).toHaveLength(2);
    expect(seen).toContainEqual({ type: 'note', op: 'restored', id: note.id });
    expect((await h.app.request(`/api/notes/${note.id}`)).status).toBe(200);
    expect((await fetchBin()).notes).toEqual([]);

    // Restoring a live note is a no-op that returns it.
    const again = await h.app.request(`/api/notes/${note.id}/restore`, { method: 'POST' });
    expect(again.status).toBe(200);
  });

  it('restore answers 404 for an unknown note and 400 for a non-id', async () => {
    expect((await h.app.request('/api/notes/Z-ZZZ/restore', { method: 'POST' })).status).toBe(404);
    expect((await h.app.request('/api/notes/not-an-id/restore', { method: 'POST' })).status).toBe(400);
  });

  // ---------- delete forever ----------

  it('purging a deleted note removes its rows, originals and derived files, and nothing else', async () => {
    const doomed = await upload('doomed #x');
    const { imageId: doomed2 } = await attach(doomed.id);
    const doomed3 = (await attach(doomed.id)).imageId;
    await removeImage(doomed3); // a removed image goes with its note too
    const keep = await upload('keep');
    const keepRemoved = await attach(keep.id);
    await removeImage(keepRemoved.imageId);
    const deletedOther = await upload('also deleted');
    await deleteNote(deletedOther.id);

    const doomedIds = [firstImageId(doomed), doomed2, doomed3];
    const allIds = [...doomedIds, firstImageId(keep), keepRemoved.imageId, firstImageId(deletedOther)];
    for (const id of allIds) await thumb(id);
    const doomedRows = await Promise.all(doomedIds.map(async (id) => (await imageRow(id))!));

    await deleteNote(doomed.id);
    const before = await dataFiles();
    const expectedGone = filesOf(before, doomedRows);
    expect(expectedGone).toHaveLength(6); // 3 originals + 3 thumbs

    const res = await purge('notes', doomed.id);
    expect(res.status).toBe(200);
    expect((await res.json()) as PurgeResult).toEqual({ purged: doomed.id, files: 6 });

    const after = await dataFiles();
    expect(after).toEqual(before.filter((f) => !expectedGone.includes(f)));
    expect(await countRows('notes', doomed.id)).toBe(0);
    expect(await countRows('note_images', doomed.id)).toBe(0);
    expect(await countRows('note_revisions', doomed.id)).toBe(0);
    expect(seen).toContainEqual({ type: 'note', op: 'purged', id: doomed.id });

    // Everything else is still there and still served.
    expect((await h.app.request(`/api/notes/${keep.id}`)).status).toBe(200);
    expect((await h.app.request(`/api/images/${keepRemoved.imageId}/original`)).status).toBe(200);
    expect((await fetchBin()).notes.map((x) => x.id)).toEqual([deletedOther.id]);
  });

  it('purging a removed image deletes its row and files only; its note stays', async () => {
    const note = await upload('keeps one #y');
    const { imageId: gone } = await attach(note.id);
    const control = await upload('control');
    for (const id of [firstImageId(note), gone, firstImageId(control)]) await thumb(id);
    await removeImage(gone);
    const row = (await imageRow(gone))!;
    const before = await dataFiles();
    const expectedGone = filesOf(before, [row]);
    expect(expectedGone).toHaveLength(2);

    const res = await purge('images', gone);
    expect(res.status).toBe(200);
    expect((await res.json()) as PurgeResult).toEqual({ purged: gone, files: 2 });

    expect(await dataFiles()).toEqual(before.filter((f) => !expectedGone.includes(f)));
    expect(await imageRow(gone)).toBeUndefined();
    expect(seen).toContainEqual({ type: 'note', op: 'purged', id: note.id });
    const live = (await (await h.app.request(`/api/notes/${note.id}`)).json()) as Note;
    expect(live.images.map((i) => i.id)).toEqual([firstImageId(note)]);
    expect((await fetchBin()).images).toEqual([]);
  });

  it('purging the legacy image clears notes.image_path / image_meta so the reconcile cannot bring it back', async () => {
    const note = await upload('legacy');
    const legacyId = firstImageId(note);
    expect(legacyId).toBe(note.id);
    await attach(note.id);
    // Make the first image look like an iteration-6 image: the legacy columns name it too.
    await h.deps.db.execute(sql`
      update notes n set image_path = i.path,
        image_meta = jsonb_build_object('sha256', i.sha256, 'mime', i.mime, 'width', i.width, 'height', i.height,
          'bytes', i.bytes, 'taken_at', null, 'original_name', i.original_name, 'host', i.host)
      from note_images i where i.id = n.id and n.id = ${note.id}`);
    await removeImage(legacyId);

    const res = await purge('images', legacyId);
    expect(res.status).toBe(200);

    const legacy = await h.deps.db.execute<{ image_path: string | null; image_meta: unknown }>(
      sql`select image_path, image_meta from notes where id = ${note.id}`,
    );
    expect(legacy.rows[0]).toEqual({ image_path: null, image_meta: null });
    expect(await reconcileLegacyImages(h.deps.db)).toBe(0);
    expect(await imageRow(legacyId)).toBeUndefined();
  });

  it('refuses to purge live items with 409 not_deleted and touches nothing', async () => {
    const live = await upload('live');
    const liveImage = firstImageId(live);
    const deleted = await upload('deleted, image not removed');
    await deleteNote(deleted.id);
    for (const id of [liveImage, firstImageId(deleted)]) await thumb(id);
    const before = await dataFiles();

    for (const [kind, id] of [
      ['notes', live.id],
      ['images', liveImage],
      // An image of a deleted note that was never removed is purged with its note, not alone.
      ['images', firstImageId(deleted)],
    ] as const) {
      const res = await purge(kind, id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'not_deleted' });
    }
    expect(await dataFiles()).toEqual(before);
    expect(seen.some((e) => e.op === 'purged')).toBe(false);
  });

  it('answers 404 for unknown ids and 400 for non-ids', async () => {
    expect((await purge('notes', 'Z-ZZZ')).status).toBe(404);
    expect((await purge('images', 'Z-ZZZ')).status).toBe(404);
    expect((await purge('notes', 'nope')).status).toBe(400);
    expect((await purge('images', 'nope')).status).toBe(400);
  });

  // ---------- Origin guard ----------

  it('purge routes answer 403 without an Origin or with a foreign one, and 200 for the page itself', async () => {
    const note = await upload('guarded');
    const { imageId } = await attach(note.id);
    await removeImage(imageId);
    const other = await upload('guarded too');
    await deleteNote(other.id);
    const before = await dataFiles();

    for (const origin of [null, 'http://evil.example', 'http://localhost:9999', 'null']) {
      for (const [kind, id] of [
        ['notes', other.id],
        ['images', imageId],
      ] as const) {
        const res = await purge(kind, id, origin);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden_origin' });
      }
    }
    expect(await dataFiles()).toEqual(before);

    expect((await purge('images', imageId)).status).toBe(200);
    expect((await purge('notes', other.id)).status).toBe(200);
  });

  // ---------- MCP can never delete forever ----------

  it('no MCP tool, and no chat-allowed tool, can purge', async () => {
    const client = new Client({ name: 'bin-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: async (input, init) => h.app.request(String(input), init),
      }),
    );
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => /purge|forever/i.test(n))).toEqual([]);
    } finally {
      await client.close();
    }
    expect(NOTES_TOOL_NAMES.filter((n) => /purge|forever/i.test(n))).toEqual([]);
  });
});
```
Notes for the implementer:
- `tests/integration/imageHarness.ts` creates `images/` and `cache/` and `reset()` empties both, so `dataFiles()` sees only this test's files.
- Bin times are pinned with SQL `update`s so ordering never depends on `now()` resolution.
- A thumb request may also write other derivatives (for example `display.jpg` when the source needs conversion). `filesOf` therefore derives the expected set from the real listing, and the count assertions (`6`, `2`) assume PNG thumbs write `thumb.webp` alone (true for `getThumb` on PNG today). If phase 2 changes that, replace the literal with `expectedGone.length`. The assertion that matters is the exact before/after diff.
- `sameOriginOnly` (phase-2.md Step 7) answers 403 `{ error: 'forbidden_origin' }` to a missing Origin and to the literal `'null'` (its `isSameOrigin` returns false when `new URL('null')` throws), so the loop above passes as written.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit, includes `removeImageFiles.test.ts` and the worker test) and `npm run test:int` (the Docker Postgres; includes `bin.int.test.ts`)
**Manual check:** with a dev daemon, `curl -s localhost:7317/api/bin | jq` after deleting a note in the UI. `curl -X DELETE localhost:7317/api/bin/notes/<id>` without an Origin header must answer 403. With `-H 'Origin: http://localhost:7317'` it must answer 200, and the file must be gone from `<dataDir>/images/`.
**Exit criteria:** the four contract routes behave as specified. A purge removes exactly the purged rows' originals and `cache/<imageId>/` files, verified by a before/after file listing. Live items get 409 `not_deleted`. Cross-origin or Origin-less purges get 403. No MCP tool name contains `purge` or `forever`. The three suites are green.

## Handoffs

- **Phase 8 (web):** consumes `GET /api/bin?tag=` (`Bin`), `POST /api/notes/:id/restore` (`Note`), `DELETE /api/bin/notes/:id` and `DELETE /api/bin/images/:imageId` (`PurgeResult`). The browser sends `Origin` automatically on `DELETE` fetches, so `sameOriginOnly` passes from the served page. On a `'note'` tile, restore uses `POST /api/notes/:note_id/restore` and delete forever uses `DELETE /api/bin/notes/:note_id`. On an `'image'` tile, restore is phase 3's `POST /api/images/:id/restore` (409 `duplicate_image` + `note_id` possible) and delete forever is `DELETE /api/bin/images/:id`. A 409 `not_deleted` means the item was restored elsewhere; refetch the bin. `web/src/types.ts` needs `BinImage` / `Bin` / `PurgeResult` mirrored (R3, phase 8).
- **Phase 10 (docs, R5):** README API table rows for the four routes. The storage section should say that "delete forever" is the only code path that removes originals.
- **Reconciled:** `toNoteImage(row, dataDir)` is phase 2's name and leaves `deleted_at` off for non-removed rows. Phase 3 locks note, then image, like this phase. `sameOriginOnly` answers 403 `{ error: 'forbidden_origin' }` to a missing and to the literal `'null'` Origin (phase 2's `isSameOrigin` catches the `new URL('null')` throw).

## Rollback

Revert this phase's commit. The changes are additive: no migration, no change to existing routes or service methods. Removing them leaves phases 1–3 intact. Anything already purged stays purged, by design.
