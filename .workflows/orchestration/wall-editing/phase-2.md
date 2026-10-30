# Phase 2: Cut the server over to per-image

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R1 (wire `images[]`, any-image filters, per-image dedupe and derivatives, image-id routes, `view_images` for every image), R5 (this phase's own tests)
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/notes`, `src/images`, `src/http`, `src/mcp`

---

## Goal

Every server read path returns `Note.images: NoteImage[]`, built from `note_images`. `Note.image` is gone, and no server code reads `notes.image_path` / `notes.image_meta` except phase 1's `src/images/legacy.ts`. A note created with an image (upload, inbox, `create_image`) is written as one note row plus its first image row (image id = note id, position 0) in one transaction. Dedupe looks for a live image with the same sha256. Derivatives live in `cache/<imageId>/`. `has_image` and the taken-date filters match when any live image matches. Images are served by image id (`/api/images/:imageId[/variant]`), and the old `/api/notes/:id/:variant` URLs stay as an alias for the first live image of a live note. `view_images` takes note ids or image ids and returns at most 8 images per call, with one overflow line. `sameOriginOnly` exists for phases 4 and 5. The daemon runs `reconcileLegacyImages` once at startup.

## Interface Contract

**Deletes:**
- `Note.image` and the old one-image `NoteImage` shape (`src/notes/types.ts:18-41`)
- private `toImage` (`src/notes/types.ts:135-148`)
- `InsertNote.imagePath`, `InsertNote.imageMeta` (`src/notes/repo.ts:68-69`) and their two values in `insertNote` (`repo.ts:324-325`)
- `repo.findNoteBySha256` (`src/notes/repo.ts:288-299`)
- `ImageRecord.image_path`, `ImageRecord.image_meta`, `ImageRecords.bySha256`, `ImageRecords.byId` (`src/images/records.ts`)
- `describeImageNote` (`src/mcp/imageTools.ts:34-46`)
- the local `LOOPBACK_HOSTNAMES` / `isLoopbackUrl` in `src/http/app.ts:9-17` (moved to `sameOrigin.ts`)

**Renames:**
- `ImageRecords.bySha256` -> `bySha256Live` (semantics: only an image with `deleted_at is null`; its note may be deleted)
- `ImageRecords.byId` -> `byImageId`
- `describeImageNote(note)` -> `describeImage(note, image, k, n)`

**Creates:**
- `src/notes/types.ts`: new `NoteImage` (Contract wire shape), `Note.images`, `imageUrls(imageId)`, `toNoteImage(row: NoteImageRow, dataDir: string): NoteImage` (the name phase 4 already uses; `deleted_at` is set only on removed rows)
- `src/images/records.ts`: `ImageRecord = { id; note_id; path; meta; position; deleted_at; note_deleted_at }`, `ImageRecords { bySha256Live, byImageId, firstLiveImageOfNote }`, `imageMetaOf(row)`, `dbImageRecords(db)` (rewritten)
- `src/images/ingest.ts`: `locateNoteImage(deps, noteId)`. `LocatedImage` gains `noteId`, `position`, `imageDeleted`, `noteDeleted`. `deleted` stays and means `imageDeleted || noteDeleted`
- `src/http/imageAccess.ts`: `resolveNoteImageFile(img, rawNoteId, variant)` (the note alias)
- `src/http/sameOrigin.ts` (new): `sameOriginOnly: MiddlewareHandler`, `isSameOrigin(origin, requestUrl)`, `isLoopbackUrl(value)`
- HTTP: `GET /api/images/:imageId` (`NoteImage` JSON, any state), `GET /api/images/:imageId/{original|display|thumb|preview}` (any existing row)
- `src/mcp/imageTools.ts`: `describeImage`, `describeNote`
- tests: `tests/unit/sameOrigin.test.ts`. Test helpers `FakeNotes.seed`, `FakeNotes.removeImage`, `FakeNotes.images`, and `addImage` in `tests/integration/imageHarness.ts`

**Signature changes:**
- `rowToNote(row, dataDir)` -> `rowToNote(row, dataDir, images: readonly NoteImageRow[])` (keeps live rows only, sorted by position)
- `resolveImageFile(img, rawId, variant)` now takes an **image id** and serves any state (removed images, images of deleted notes). The note-id behaviour moved to `resolveNoteImageFile`
- `locateImage(deps, id)` now takes an **image id** (`records.byImageId`)
- `NotesService.newId()` returns an id free in both `notes.id` and `note_images.id` (`imageIdTaken`)
- `NotesService.create` writes the note and, when `image` is given, its first image row in one transaction. A taken id (in either table) gives `conflict`, and a live sha clash gives `duplicate_image` (nothing is written)
- `NotesService.findBySha256(sha, opts)` reads the holder through `imageRepo.findLiveImageBySha256`. It returns the note holding a live image with those bytes, or a deleted holder only when `includeDeleted` is set
- private `NotesService.finish` / `toNote` become async. New private `toNotes(rows)` batch-loads images with one `imagesForNotes` call per read
- `repo.filterConditions`: `hasImage` -> `[not] exists (select 1 from "note_images" where note_id = notes.id and deleted_at is null)`. `takenFrom/To` -> **one** `exists` over a live image whose `taken_at` meets both bounds

**Requires (from earlier phases):** Phase 1 exactly as planned in `.workflows/plan/wall-editing/phase-1.md`:
- `src/db/schema.ts` exports `noteImages`, `NoteImageRow`, `NewNoteImageRow`, and still exports `ImageMeta`
- `src/notes/imageRepo.ts` exports `imagesForNotes(db, ids, opts?)` (a key for every id, live only by default), `findImageById(db, id): Promise<NoteImageRow | null>`, `findLiveImageBySha256(db, sha): Promise<{ image; noteDeletedAt } | null>`, `insertImage(db, values: NewNoteImageRow)` (sha clash -> `NoteError('duplicate_image')`, PK/path clash rethrown), `imageIdTaken(db, id)`, `setImageDeleted(db, id, deleted)` (tests only)
- `src/images/legacy.ts` exports `reconcileLegacyImages(db: Executor): Promise<number>`
- `tests/integration/setup.ts` `truncateAll` also empties `note_images`

**Leaves alone (owned by others):** `web/**` (phases 6-9, 11); `attachImage` / `removeImage` / `restoreImage` in service, ingest, HTTP and MCP, plus `src/chat/status.ts` (phase 3); bin, purge, `removeImageFiles`, `src/http/api.ts` (phase 4); `src/http/reveal.ts` and its mount in `app.ts` (phase 5); `src/db/schema.ts`, `src/notes/imageRepo.ts`, `src/images/legacy.ts`, drizzle files, `tests/integration/{setup,schema,migration0002,imageRepo}*` (phase 1); README, SKILL.md, INSTALL.md (phase 10). `src/images/inbox.ts` needs **no change**: its `IngestResult` (`{ note, created }`) is unchanged and its log line names the note id, which is still correct.

## Files

| File | Action | What changes |
|---|---|---|
| `src/notes/types.ts` | modify | whole file: new `NoteImage`, `Note.images`, `imageUrls`, `toNoteImage`, `rowToNote(row, dataDir, images)` |
| `src/notes/repo.ts` | modify | imports (1-6); `InsertNote` (63-70); `filterConditions` image part (127-137); delete `findNoteBySha256` (288-299); `insertNote` values (319-328) |
| `src/notes/service.ts` | modify | imports (1-33); `newId` (129-136); `create` (138-163); `getOne`/`get`/`findBySha256`/`list` (165-203); hybrid return (254-259); `textSearch` (263-268); `related` (289-296, 306-309); `finish`/`toNote` (429-436) |
| `src/images/records.ts` | rewrite | per-image records from `note_images` joined to `notes.deleted_at` |
| `src/images/ingest.ts` | rewrite | dedupe by `bySha256Live`, holder note restore, `locateImage` by image id, `locateNoteImage` |
| `src/images/derive.ts` | modify | doc comment on `ImageSource` (18-24): `id` is the image id |
| `src/images/store.ts` | modify | doc comment on `cacheDirFor` (59) |
| `src/http/sameOrigin.ts` | create | `sameOriginOnly`, `isSameOrigin`, `isLoopbackUrl` |
| `src/http/app.ts` | modify | lines 1-17: drop local loopback helpers, import `isLoopbackUrl` |
| `src/http/imageAccess.ts` | rewrite | `resolveImageFile` by image id (any state), `resolveNoteImageFile` alias, shared `resolveLocated` |
| `src/http/images.ts` | rewrite | `GET /api/images/:imageId`, `/api/images/:imageId/:variant`, alias `/api/notes/:id/:variant` |
| `src/mcp/imageTools.ts` | rewrite | `view_images` over note or image ids, 8-image cap, overflow line, `describeImage` |
| `src/mcp/tools.ts` | modify | `IMAGE_FILTER_HINT` (20-21), `has_image` (62-65), `taken_from` (66-71) descriptions |
| `src/mcp/instructions.ts` | modify | "Notes." paragraph (16) and "Images." paragraph (30) |
| `src/chat/prompt.ts` | modify | the view_images sentence (27) |
| `src/background.ts` | modify | startup `reconcileLegacyImages` (imports 1-5, body 16-24) |
| `tests/helpers/fakeNotes.ts` | rewrite | notes plus a separate image map; implements the new `ImageRecords` |
| `tests/unit/notes.helpers.test.ts` | modify | `rowToNote` 3-arg; image mapping tests on `NoteImageRow` |
| `tests/unit/takenFilter.test.ts` | rewrite | EXISTS assertions for `hasImage` and the taken range |
| `tests/unit/images/ingest.test.ts` | modify | `byImageId`/`path`/`meta`; `seed`; new removed-image dedupe test |
| `tests/unit/images/inbox.test.ts` | modify | lines 69-81: read image fields through `byImageId` |
| `tests/unit/sameOrigin.test.ts` | create | guard rules |
| `tests/integration/imageHarness.ts` | modify | `setTakenAt` on `note_images`, `originalPathOf` via `byImageId`, new `addImage` |
| `tests/integration/helpers/api-harness.ts` | modify | `insertImageNote` writes a `note_images` row (lines 72-89) |
| `tests/integration/images.int.test.ts` | modify | `.images[0]`; `byImageId`; rollback; removed-image dedupe; startup reconcile |
| `tests/integration/images.http.int.test.ts` | modify | `UploadResult` type; `.images[0]`; image-id routes, alias fallback, any-state serving; a reconciled legacy image is served (phase 1 handoff, R5) |
| `tests/integration/images.mcp.int.test.ts` | modify | `view_images` every image / image id / cap / removed |
| `tests/integration/notes.service.int.test.ts` | modify | `.images`; new images[] describe block |
| `tests/integration/api.int.test.ts` | modify | line 168: `images[0]` |

## Implementation Steps

### Step 1: Wire types
**File:** `src/notes/types.ts` (whole file, 163 lines today)
**Change:** Replace the one-image `NoteImage` with the Contract's per-image wire shape, add `Note.images`, add `imageUrls` and `toNoteImage`, and give `rowToNote` the images. `ImageMeta` is still re-exported because ingest uses it.
**Code:**
```ts
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { NoteImageRow, notes } from '../db/schema.js';

/** Where a note was saved from. Every field is optional; unknown keys are dropped. */
export interface Origin {
  cwd?: string | undefined;
  repo?: string | undefined;
  claude_session?: string | undefined;
  /** Free-form channel, e.g. 'mcp', 'web', 'inbox', 'upload'. */
  source?: string | undefined;
}

/** Image metadata as ingest probes it (also the legacy `notes.image_meta` shape). */
export type { ImageMeta } from '../db/schema.js';

/** One image of a note, as MCP, HTTP and the UI see it (iteration 7: a note holds several). */
export interface NoteImage {
  /** Image id, note-id format. A note's first image shares the note's id. */
  id: string;
  note_id: string;
  /** Attach order within the note; never renumbered. */
  position: number;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** EXIF taken time, ISO 8601 UTC, or null. */
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  /** The original file exists under this machine's data dir. */
  available: boolean;
  /** Served by image id: `/api/images/<id>/<variant>`. */
  urls: { thumb: string; display: string; original: string; preview: string };
  /** Present only on removed images (bin listings). */
  deleted_at?: string;
}

/** Wire shape shared by MCP, HTTP and the UI. */
export interface Note {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  origin: Origin | null;
  /** The note's live images (image deleted_at is null), ascending position. Empty for text notes. */
  images: NoteImage[];
}

export type NoteRow = typeof notes.$inferSelect;

export interface Revision {
  revision: number;
  note_id: string;
  body: string;
  saved_at: string;
}

export interface TagCount {
  tag: string;
  count: number;
  last_used: string;
}

/** One neighbour returned by `related`. similarity = 1 - cosine distance, rounded to 4 decimals. */
export interface RelatedNote {
  note: Note;
  similarity: number;
}

/** Result of `related`: the source note's canonical id and its neighbours, most similar first. */
export interface RelatedResult {
  note_id: string;
  related: RelatedNote[];
}

export interface NotePage {
  notes: Note[];
  next_cursor: string | null;
}

/** 'hybrid': full text + meaning + tags + recency. 'text': full-text ranking only (pre-iteration-6). */
export type SearchMode = 'hybrid' | 'text';

/** `search` result: a NotePage plus which ranking produced it. */
export interface SearchPage extends NotePage {
  /** The ranking actually used. 'text' when asked for, or when hybrid had to fall back. */
  mode: SearchMode;
  /** Present only when hybrid was asked for but could not run; says why, in a sentence for the user. */
  fallback?: string;
}

export type NoteErrorCode =
  | 'invalid_id'
  | 'invalid_input'
  | 'not_found'
  | 'deleted'
  | 'empty_body'
  | 'conflict'
  | 'duplicate_image'
  | 'invalid_revision'
  | 'not_embedded';

/** The only error type the notes service throws on purpose. HTTP maps `code` to a status. */
export class NoteError extends Error {
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
  }
}

const ORIGIN_KEYS = ['cwd', 'repo', 'claude_session', 'source'] as const;

/** Keeps only the known string fields of an origin; returns null when nothing is left. */
export function cleanOrigin(value: unknown): Origin | null {
  if (value === null || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const out: Origin = {};
  for (const key of ORIGIN_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** True when `imagePath` (relative to dataDir) names an existing file inside dataDir. */
export function imageAvailable(dataDir: string, imagePath: string): boolean {
  const root = resolve(dataDir);
  const full = resolve(root, imagePath);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return existsSync(full);
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** The four served variants of one image, by image id. */
export function imageUrls(imageId: string): NoteImage['urls'] {
  const base = `/api/images/${imageId}`;
  return {
    thumb: `${base}/thumb`,
    display: `${base}/display`,
    original: `${base}/original`,
    preview: `${base}/preview`,
  };
}

/** `note_images` row -> wire NoteImage. `deleted_at` is present only on removed images. */
export function toNoteImage(row: NoteImageRow, dataDir: string): NoteImage {
  const image: NoteImage = {
    id: row.id,
    note_id: row.noteId,
    position: row.position,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    taken_at: row.takenAt === null ? null : toIso(row.takenAt),
    original_name: row.originalName,
    host: row.host,
    available: imageAvailable(dataDir, row.path),
    urls: imageUrls(row.id),
  };
  if (row.deletedAt !== null) image.deleted_at = toIso(row.deletedAt);
  return image;
}

/**
 * DB row + its image rows -> wire Note. Only live images (deleted_at null) are kept, in
 * position order. `deleted_at` is present only on deleted notes.
 */
export function rowToNote(row: NoteRow, dataDir: string, images: readonly NoteImageRow[]): Note {
  const live = images.filter((i) => i.deletedAt === null).sort((a, b) => a.position - b.position);
  const note: Note = {
    id: row.id,
    body: row.body,
    tags: row.tags,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    origin: cleanOrigin(row.origin),
    images: live.map((i) => toNoteImage(i, dataDir)),
  };
  if (row.deletedAt !== null) note.deleted_at = toIso(row.deletedAt);
  return note;
}
```
**Impact:** Every `Note.image` reader stops compiling until Steps 3, 6, 10 and the test steps land. The `NoteErrorCode` union stays where it is; phase 4 appends `not_deleted` to it.

### Step 2: Repo filters and insert
**File:** `src/notes/repo.ts`

**2a: imports, lines 1-6.** Replace with:
```ts
import { and, arrayContains, arrayOverlaps, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { noteEmbeddings, noteImages, noteRevisions, notes } from '../db/schema.js';
import { isCurrentEmbeddingSql, toVectorLiteral } from '../embeddings/repo.js';
import { parseDateBound } from './dates.js';
import { NoteError, type NoteRow, type Origin } from './types.js';
```

**2b: `NoteFilter` doc fields, lines 31-36.** Replace the three image field comments with:
```ts
  /** true = notes with at least one live image, false = notes with none, undefined = both. */
  hasImage?: boolean;
  /** EXIF taken date, lower bound: YYYY-MM-DD (local day) or ISO datetime. Matches when any live image was taken in range. */
  takenFrom?: string;
  /** EXIF taken date, upper bound, inclusive: YYYY-MM-DD (whole local day) or ISO datetime. */
  takenTo?: string;
```

**2c: `InsertNote`, lines 63-70.** Replace with:
```ts
export interface InsertNote {
  id: string;
  body: string;
  tags: string[];
  origin: Origin | null;
}
```

**2d: `filterConditions`, lines 111-139.** Replace the whole function and add the helper above it:
```ts
/**
 * `exists (select 1 from note_images where note_id = notes.id and deleted_at is null [and extra...])`.
 * The subquery names "note_images" unaliased; an outer query that also joins note_images must alias its own copy.
 */
function liveImageExists(extra: readonly SQL[] = []): SQL {
  const conds: SQL[] = [sql`${noteImages.noteId} = ${notes.id}`, sql`${noteImages.deletedAt} is null`, ...extra];
  return sql`exists (select 1 from ${noteImages} where ${sql.join(conds, sql` and `)})`;
}

/** WHERE conditions for a filter (paging excluded). */
export function filterConditions(filter: NoteFilter): SQL[] {
  const conds: SQL[] = [];
  const deleted = filter.deleted ?? 'exclude';
  if (deleted === 'exclude') conds.push(isNull(notes.deletedAt));
  if (deleted === 'only') conds.push(isNotNull(notes.deletedAt));

  const any = normalizeTagInput(filter.tagsAny);
  if (any.length > 0) conds.push(arrayOverlaps(notes.tags, any));
  const all = normalizeTagInput(filter.tagsAll);
  if (all.length > 0) conds.push(arrayContains(notes.tags, all));

  const col = dateColumn(filter);
  if (filter.from !== undefined && filter.from !== '') conds.push(gte(col, parseDateBound(filter.from, 'from')));
  if (filter.to !== undefined && filter.to !== '') conds.push(lt(col, parseDateBound(filter.to, 'to')));

  // "Has an image" means at least one live image (iteration 7).
  if (filter.hasImage === true) conds.push(liveImageExists());
  if (filter.hasImage === false) conds.push(sql`not ${liveImageExists()}`);

  // Taken range: one image must meet both bounds (any image may match), served by note_images_taken_at_idx.
  const taken: SQL[] = [];
  if (filter.takenFrom !== undefined && filter.takenFrom !== '') {
    taken.push(sql`${noteImages.takenAt} >= ${parseDateBound(filter.takenFrom, 'from').toISOString()}::timestamptz`);
  }
  if (filter.takenTo !== undefined && filter.takenTo !== '') {
    taken.push(sql`${noteImages.takenAt} < ${parseDateBound(filter.takenTo, 'to').toISOString()}::timestamptz`);
  }
  if (taken.length > 0) conds.push(liveImageExists(taken));
  return conds;
}
```

**2e: delete `findNoteBySha256`, lines 288-299** (the doc comment line 288 and the function). The service now uses `imageRepo.findLiveImageBySha256`.

**2f: `insertNote` values, lines 317-328.** Replace the `.values({...})` object with the version below. The rest of `insertNote` (the `onConflictDoNothing`, `returning`, the try/catch and `pgErrorCode`) stays as it is:
```ts
      .values({
        id: values.id,
        body: values.body,
        tags: values.tags,
        origin: values.origin,
        createdAt: sql`now()`,
        updatedAt: sql`now()`,
      })
```
Also replace the doc comment above `insertNote` (lines 311-314) with:
```ts
/**
 * Inserts a note (never the legacy image columns). Returns null when the id is already taken (the
 * caller retries with a new id). Images go to note_images through imageRepo.insertImage.
 */
```
**Impact:** `takenFilter.test.ts` must be rewritten (Step 18). `has_image` and the taken filters now look only at `note_images`. A legacy note that has no `note_images` row yet counts as a text note until the startup reconcile copies it (Step 9).

### Step 3: Service
**File:** `src/notes/service.ts`

**3a: imports, lines 15-33.** Add the imageRepo import after line 16 (`import * as repo from './repo.js';`):
```ts
import * as imageRepo from './imageRepo.js';
```
The `./types.js` import block keeps every name it has today (including `rowToNote`, `ImageMeta`, `NoteRow`).

**3b: `CreateNoteInput.image` comment, line 52.** Replace with:
```ts
  /** First image of the note: written to note_images with the note's id and position 0. `path` is relative to dataDir. */
```

**3c: `newId`, lines 129-136.** Replace with:
```ts
  /** An id no note and no image (live or deleted) currently has. A note's first image takes the note's id. */
  async newId(): Promise<string> {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = generateId();
      if (!(await imageRepo.imageIdTaken(this.db, id))) return id;
    }
    throw new NoteError('conflict', 'Could not find a free note id.');
  }
```

**3d: `create`, lines 138-163.** Replace with:
```ts
  /**
   * Inserts a note and, when `image` is given, its first image (id = note id, position 0) in one
   * transaction. A clash on the live-image sha256 index throws NoteError('duplicate_image') and
   * leaves nothing behind. An id held by any note or image is never reused.
   */
  async create(input: CreateNoteInput): Promise<Note> {
    const body = input.body;
    if (!input.allowEmpty && body.trim() === '') {
      throw new NoteError('empty_body', 'A note needs some text.');
    }
    const values = { body, tags: parseTags(body), origin: cleanOrigin(input.origin ?? null) };
    const image = input.image ?? null;
    const fixedId = input.id !== undefined ? this.requireId(input.id) : null;

    const row = await this.db.transaction(async (tx): Promise<NoteRow> => {
      const attempts = fixedId !== null ? 1 : MAX_ID_ATTEMPTS;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const id = fixedId ?? generateId();
        const inserted = (await imageRepo.imageIdTaken(tx, id)) ? null : await repo.insertNote(tx, { id, ...values });
        if (inserted === null) continue;
        if (image !== null) {
          await imageRepo.insertImage(tx, {
            id,
            noteId: id,
            path: image.path,
            sha256: image.meta.sha256,
            mime: image.meta.mime,
            width: image.meta.width,
            height: image.meta.height,
            bytes: image.meta.bytes,
            takenAt: image.meta.taken_at === null ? null : new Date(image.meta.taken_at),
            originalName: image.meta.original_name,
            host: image.meta.host,
            position: 0,
          });
        }
        return inserted;
      }
      throw new NoteError('conflict', fixedId !== null ? `Note id ${fixedId} is already taken.` : 'Could not find a free note id.');
    });
    return this.finish({ row, op: 'created' });
  }
```

**3e: `getOne`, `get`, `findBySha256`, `list`, lines 165-203.** Replace with:
```ts
  async getOne(idInput: string, opts: GetOptions = {}): Promise<Note | null> {
    const id = normalizeId(idInput);
    if (id === null) return null;
    const row = await repo.findNoteById(this.db, id);
    if (row === null) return null;
    if (row.deletedAt !== null && !opts.includeDeleted) return null;
    return this.toNote(row);
  }

  async get(idInputs: readonly string[], opts: GetOptions = {}): Promise<GetResult> {
    const wanted: string[] = [];
    const missing: string[] = [];
    for (const input of idInputs) {
      const id = normalizeId(input);
      if (id === null) missing.push(input);
      else if (!wanted.includes(id)) wanted.push(id);
    }
    const rows = await repo.findNotesByIds(this.db, wanted);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const shown: NoteRow[] = [];
    const deleted: string[] = [];
    for (const id of wanted) {
      const row = byId.get(id);
      if (row === undefined) missing.push(id);
      else if (row.deletedAt !== null && !opts.includeDeleted) deleted.push(id);
      else shown.push(row);
    }
    return { notes: await this.toNotes(shown), missing, deleted };
  }

  /** The note holding a live image with these bytes. A deleted holder only when includeDeleted is set. */
  async findBySha256(sha256: string, opts: GetOptions = {}): Promise<Note | null> {
    const hit = await imageRepo.findLiveImageBySha256(this.db, sha256);
    if (hit === null) return null;
    return this.getOne(hit.image.noteId, opts);
  }

  async list(filter: NoteFilter = {}): Promise<NotePage> {
    const page = await repo.listNotes(this.db, filter);
    return { notes: await this.toNotes(page.rows), next_cursor: page.nextCursor };
  }
```

**3f: hybrid return, lines 254-259.** Replace with:
```ts
    const end = offset + limit;
    return {
      notes: await this.toNotes(ranked.slice(offset, end).map((c) => c.row)),
      next_cursor: ranked.length > end ? repo.encodeCursor(end) : null,
      mode: 'hybrid',
    };
```

**3g: `textSearch`, lines 263-268.** Replace with:
```ts
  private async textSearch(query: string, filter: NoteFilter, fallback?: string): Promise<SearchPage> {
    const page = await repo.searchNotes(this.db, query, filter);
    const result: SearchPage = { notes: await this.toNotes(page.rows), next_cursor: page.nextCursor, mode: 'text' };
    if (fallback !== undefined) result.fallback = fallback;
    return result;
  }
```

**3h: `related`, lines 289-296.** Replace the `if (input === null) { ... }` block with:
```ts
    if (input === null) {
      const hasImages = (await imageRepo.imagesForNotes(this.db, [id])).get(id)?.length ?? 0;
      const what = hasImages > 0 ? 'is a photo with no text' : 'has no text';
      throw new NoteError(
        'invalid_input',
        `Note ${id} ${what}, so there is nothing to compare by meaning. Add a description with append("${id}", ...) first, or use list with dates to find notes from the same time.`,
      );
    }
```
**and lines 306-309** (the final `return`) with:
```ts
    const neighbours = await this.toNotes(nearest.map((n) => n.row));
    return {
      note_id: id,
      related: nearest.map((n, i) => ({ note: neighbours[i]!, similarity: roundSimilarity(1 - n.distance) })),
    };
```

**3i: `finish` / `toNote`, lines 429-436.** Replace with:
```ts
  private async finish(result: Mutation): Promise<Note> {
    if (result.op !== null) this.events.emit(result.op, result.row.id);
    return this.toNote(result.row);
  }

  private async toNote(row: NoteRow): Promise<Note> {
    const [note] = await this.toNotes([row]);
    return note!;
  }

  /** Wire notes in input order, with every note's live images loaded in one query. */
  private async toNotes(rows: readonly NoteRow[]): Promise<Note[]> {
    if (rows.length === 0) return [];
    const images = await imageRepo.imagesForNotes(this.db, rows.map((r) => r.id));
    return rows.map((r) => rowToNote(r, this.dataDir, images.get(r.id) ?? []));
  }
```
`update`, `append`, `delete`, `restore`, `revert` keep `return this.finish(result);`. They are already `async`, so they now return the awaited promise.
**Impact:** Every service read costs one extra `note_images` query per call (not per note). Events are emitted before the image load, the same order as today.

### Step 4: Per-image records
**File:** `src/images/records.ts` (rewrite, 51 lines today)
**Code:**
```ts
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { noteImages, notes, type ImageMeta, type NoteImageRow } from '../db/schema.js';
import { normalizeId } from '../notes/ids.js';
import { findLiveImageBySha256 } from '../notes/imageRepo.js';

/** Raw storage fields of one image (not a wire shape). */
export type ImageRecord = {
  /** Image id (note-id format). A note's first image shares the note's id. */
  id: string;
  note_id: string;
  /** Relative to the data dir: images/YYYY/MM/<id>.<ext>. */
  path: string;
  meta: ImageMeta;
  position: number;
  /** ISO string when the image was removed from its note (in the bin), else null. */
  deleted_at: string | null;
  /** ISO string when the owning note is soft-deleted, else null. */
  note_deleted_at: string | null;
};

export interface ImageRecords {
  /** The image with these bytes and deleted_at null (at most one; its note may be deleted), else null. */
  bySha256Live(sha256: string): Promise<ImageRecord | null>;
  /** Case/dash-tolerant image id; any state (removed, or in a deleted note); null when unknown. */
  byImageId(id: string): Promise<ImageRecord | null>;
  /** The note's live image with the lowest position (whatever the note's state); null when it has none. */
  firstLiveImageOfNote(noteId: string): Promise<ImageRecord | null>;
}

/** The ImageMeta view of a note_images row (what ingest and serving read). */
export function imageMetaOf(row: NoteImageRow): ImageMeta {
  return {
    sha256: row.sha256,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    taken_at: row.takenAt === null ? null : row.takenAt.toISOString(),
    original_name: row.originalName,
    host: row.host,
  };
}

function toRecord(row: NoteImageRow, noteDeletedAt: Date | null): ImageRecord {
  return {
    id: row.id,
    note_id: row.noteId,
    path: row.path,
    meta: imageMetaOf(row),
    position: row.position,
    deleted_at: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    note_deleted_at: noteDeletedAt === null ? null : noteDeletedAt.toISOString(),
  };
}

export function dbImageRecords(db: Db): ImageRecords {
  const fields = { image: noteImages, noteDeletedAt: notes.deletedAt };
  return {
    async bySha256Live(sha256) {
      const hit = await findLiveImageBySha256(db, sha256);
      return hit ? toRecord(hit.image, hit.noteDeletedAt) : null;
    },
    async byImageId(input) {
      const id = normalizeId(input);
      if (id === null) return null;
      const rows = await db
        .select(fields)
        .from(noteImages)
        .innerJoin(notes, eq(notes.id, noteImages.noteId))
        .where(eq(noteImages.id, id))
        .limit(1);
      const r = rows[0];
      return r ? toRecord(r.image, r.noteDeletedAt) : null;
    },
    async firstLiveImageOfNote(input) {
      const id = normalizeId(input);
      if (id === null) return null;
      const rows = await db
        .select(fields)
        .from(noteImages)
        .innerJoin(notes, eq(notes.id, noteImages.noteId))
        .where(and(eq(noteImages.noteId, id), isNull(noteImages.deletedAt)))
        .orderBy(asc(noteImages.position), asc(noteImages.id))
        .limit(1);
      const r = rows[0];
      return r ? toRecord(r.image, r.noteDeletedAt) : null;
    },
  };
}
```
**Impact:** Nothing in `src/images` reads the legacy columns any more.

### Step 5: Ingest per image
**File:** `src/images/ingest.ts` (rewrite, 207 lines today)
**Change:** Dedupe goes through `bySha256Live`. The holder note is restored when it is deleted. The duplicate-race winner is reused even when its note is deleted (the live-image index covers deleted notes, so retrying would clash again). `locateImage` takes an image id. `locateNoteImage` is new.
**Code:**
```ts
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppDeps } from '../deps.js';
import type { NotesService } from '../notes/service.js';
import { NoteError, type ImageMeta, type Note, type Origin } from '../notes/types.js';
import type { ImageSource } from './derive.js';
import { probeImage, sha256Hex } from './probe.js';
import { dbImageRecords, type ImageRecord, type ImageRecords } from './records.js';
import {
  chooseExt,
  copyIntoNewFile,
  fileExists,
  moveIntoNewFile,
  originalRelPath,
  removeQuietly,
  resolveInDataDir,
  writeNewFile,
} from './store.js';

/** The slice of the notes service image ingestion uses. All writes go through it. */
export type ImageNotes = Pick<NotesService, 'create' | 'getOne' | 'restore' | 'newId'>;

export type ImageDeps = {
  dataDir: string;
  notes: ImageNotes;
  /** Raw image lookups (read-only). */
  records: ImageRecords;
  /** Defaults to os.hostname(). Tests override it. */
  hostname?: () => string;
  /** Defaults to new Date(). Decides images/YYYY/MM. */
  now?: () => Date;
};

/** ImageDeps for the running daemon (background.ts, the HTTP routes and MCP tools). */
export function imageDeps(app: AppDeps): ImageDeps {
  return { dataDir: app.config.dataDir, notes: app.service, records: dbImageRecords(app.db) };
}
type IngestCommon = {
  /** Name the file had on the user's side. Its extension (lower-cased) names the stored file. */
  originalName?: string | null;
  /** Note text. Defaults to ''. Hashtags in it become tags as for any note. */
  body?: string;
  origin?: Origin | null;
};

export type IngestInput =
  | (IngestCommon & { bytes: Uint8Array; path?: undefined; move?: undefined })
  | (IngestCommon & {
      path: string;
      bytes?: undefined;
      /** Rename the file into the store instead of copying it. On success the source is always consumed. */
      move?: boolean;
    });

export type IngestResult = { note: Note; created: boolean };

/** Where one image's original lives on this machine, and whether it is here. `id` is the image id (keys cache/<id>/). */
export type LocatedImage = ImageSource & {
  noteId: string;
  position: number;
  /** `note_images.path` as stored: relative to the data dir. */
  relPath: string;
  available: boolean;
  /** Host that ingested the file. */
  host: string | null;
  /** The image was removed from its note (in the bin). */
  imageDeleted: boolean;
  /** The owning note is soft-deleted. */
  noteDeleted: boolean;
  /** imageDeleted || noteDeleted. */
  deleted: boolean;
  meta: ImageMeta;
};

const MAX_ID_ATTEMPTS = 5;

/** Serialises ingests of the same bytes inside this process (the DB index covers other hosts). */
const shaLocks = new Map<string, Promise<unknown>>();

async function withShaLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const prev = shaLocks.get(sha256) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  shaLocks.set(sha256, tail);
  try {
    return await run;
  } finally {
    if (shaLocks.get(sha256) === tail) shaLocks.delete(sha256);
  }
}

/** Put a file's bytes at `dest` from wherever the caller's input lives. */
async function placeOriginal(dest: string, bytes: Uint8Array, sourcePath: string | null, move: boolean): Promise<void> {
  if (sourcePath === null) await writeNewFile(dest, bytes);
  else if (move) await moveIntoNewFile(sourcePath, dest);
  else await copyIntoNewFile(sourcePath, dest);
}

/** Undo placeOriginal after a failed insert: a moved source goes back where it was. */
async function unplaceOriginal(dest: string, sourcePath: string | null, move: boolean): Promise<void> {
  if (sourcePath !== null && move) {
    await moveIntoNewFile(dest, sourcePath).catch(() => removeQuietly(dest));
    return;
  }
  await removeQuietly(dest);
}

/**
 * The bytes are already a live image. Return the note that holds it (restoring the note when it
 * is soft-deleted). If this machine lacks the original (it was ingested on another host), the
 * identical bytes are put at the image's path here. With move=true the source is consumed either way.
 */
async function reuseExisting(
  deps: ImageDeps,
  existing: ImageRecord,
  bytes: Uint8Array,
  sourcePath: string | null,
  move: boolean,
): Promise<IngestResult> {
  const abs = resolveInDataDir(deps.dataDir, existing.path);
  if (!(await fileExists(abs))) {
    await placeOriginal(abs, bytes, sourcePath, move);
  } else if (sourcePath !== null && move && path.resolve(sourcePath) !== abs) {
    await unlink(sourcePath).catch(() => undefined);
  }
  const note =
    existing.note_deleted_at !== null ? await deps.notes.restore(existing.note_id) : await deps.notes.getOne(existing.note_id);
  if (!note) throw new Error(`note ${existing.note_id} holding image ${existing.id} vanished during ingest`);
  return { note, created: false };
}

/**
 * Store an image as a new note, or return the note that already holds these bytes.
 *
 * sha256 of the bytes -> a live image with them (deleted_at null) returns its note unchanged
 * (created: false), restoring the note first when it is soft-deleted. A removed image (in the bin)
 * does not count. Otherwise: probe (mime by magic bytes, size, EXIF taken_at), generate the id,
 * write the original byte for byte to images/YYYY/MM/<id>.<ext>, then create the note and its
 * first image (same id, position 0) through the notes service. If the insert fails the file is
 * removed (or moved back to its source); NoteError('duplicate_image') is a concurrent ingest of
 * the same bytes (return the winner), NoteError('conflict') an id clash (retry with a new id).
 *
 * Throws UnsupportedImageError (from probe.ts) for anything that is not a supported image.
 */
export async function ingestImage(deps: ImageDeps, input: IngestInput): Promise<IngestResult> {
  const sourcePath = input.path !== undefined ? path.resolve(input.path) : null;
  const move = sourcePath !== null && input.move === true;
  const bytes: Uint8Array = sourcePath !== null ? await readFile(sourcePath) : input.bytes!;
  const sha256 = sha256Hex(bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256Live(sha256);
    if (existing) return reuseExisting(deps, existing, bytes, sourcePath, move);

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
      const id = await deps.notes.newId();
      const relPath = originalRelPath(id, ext, savedAt);
      const abs = resolveInDataDir(deps.dataDir, relPath);
      if (await fileExists(abs)) continue;
      await placeOriginal(abs, bytes, sourcePath, move);
      try {
        const note = await deps.notes.create({
          id,
          body: input.body ?? '',
          origin: input.origin ?? null,
          image: { path: relPath, meta },
          allowEmpty: true,
        });
        return { note, created: true };
      } catch (err) {
        await unplaceOriginal(abs, sourcePath, move);
        if (!(err instanceof NoteError) || (err.code !== 'duplicate_image' && err.code !== 'conflict')) throw err;
        if (err.code === 'duplicate_image') {
          // The live-image index covers deleted notes too: reuse the winner (restoring its note) instead of retrying.
          const winner = await deps.records.bySha256Live(sha256);
          if (winner) return reuseExisting(deps, winner, bytes, sourcePath, move);
        }
      }
    }
    throw new Error(`could not allocate a free note id in ${MAX_ID_ATTEMPTS} attempts`);
  });
}

async function located(dataDir: string, rec: ImageRecord): Promise<LocatedImage> {
  const originalPath = resolveInDataDir(dataDir, rec.path);
  const imageDeleted = rec.deleted_at !== null;
  const noteDeleted = rec.note_deleted_at !== null;
  return {
    id: rec.id,
    mime: rec.meta.mime,
    originalPath,
    noteId: rec.note_id,
    position: rec.position,
    relPath: rec.path,
    available: await fileExists(originalPath),
    host: rec.meta.host ?? null,
    imageDeleted,
    noteDeleted,
    deleted: imageDeleted || noteDeleted,
    meta: rec.meta,
  };
}

/** Locate one image's original by image id, in any state. null when the id is unknown. */
export async function locateImage(deps: Pick<ImageDeps, 'dataDir' | 'records'>, imageId: string): Promise<LocatedImage | null> {
  const rec = await deps.records.byImageId(imageId);
  return rec ? located(deps.dataDir, rec) : null;
}

/** Locate a note's first live image (the `/api/notes/:id/:variant` alias). null when it has none. */
export async function locateNoteImage(deps: Pick<ImageDeps, 'dataDir' | 'records'>, noteId: string): Promise<LocatedImage | null> {
  const rec = await deps.records.firstLiveImageOfNote(noteId);
  return rec ? located(deps.dataDir, rec) : null;
}
```
**Impact:** `IngestResult` and `ingestImage`'s signature are unchanged, so `inbox.ts`, `background.ts` and `imageAccess.ts` callers keep compiling. Phase 3 adds `attachImage` to this file and may reuse `reuseExisting` / `placeOriginal`.

### Step 6: Derive / store doc comments (no code change)
**File:** `src/images/derive.ts:18-24`. Replace the `ImageSource` block with:
```ts
/** What the derivative getters need to know about one image. */
export type ImageSource = {
  /** Image id; names the cache dir `cache/<id>/` (a note's first image shares the note's id). */
  id: string;
  mime: string;
  /** Absolute path of the original. */
  originalPath: string;
};
```
**File:** `src/images/store.ts:59`. Insert above `export function cacheDirFor`:
```ts
/** `cache/<imageId>/`: derivatives of one image. */
```
**Impact:** none at runtime.

### Step 7: Same-origin guard
**File:** `src/http/sameOrigin.ts` (new)
**Code:**
```ts
import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when `value` parses as a URL whose host is loopback. */
export function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** True when the Origin header names exactly the request URL's origin (scheme, host, port). */
export function isSameOrigin(originHeader: string | undefined, requestUrl: string): boolean {
  if (originHeader === undefined || originHeader === '') return false;
  try {
    return new URL(originHeader).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Guard for endpoints only notesd's own page may call (purge, reveal). The request must come to a
 * loopback host, and carry an Origin equal to that host's origin. A missing, foreign or
 * unparseable Origin (`null` included) is refused with 403 `{ error: 'forbidden_origin' }`.
 */
export const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url) || !isSameOrigin(c.req.header('origin'), c.req.url)) {
    return c.json({ error: 'forbidden_origin' }, 403);
  }
  await next();
};
```
**File:** `src/http/app.ts:1-17`. Replace lines 1-17 with:
```ts
import { Hono, type MiddlewareHandler } from 'hono';
import type { ChatBackend } from '../chat/backend.js';
import type { AppDeps } from '../deps.js';
import { handleMcpRequest } from '../mcp/server.js';
import { apiRoutes } from './api.js';
import { imageRoutes } from './images.js';
import { isLoopbackUrl } from './sameOrigin.js';
import { staticRoutes } from './static.js';
```
`loopbackOnly` and `createApp` stay as they are (they now call the imported `isLoopbackUrl`).
**Impact:** Nothing mounts `sameOriginOnly` in this phase. Phases 4 and 5 do.

### Step 8: Image access: by image id, plus the note alias
**File:** `src/http/imageAccess.ts` (rewrite, 177 lines today)
**Code:**
```ts
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDisplay, getPreview, getThumb, OriginalMissingError } from '../images/derive.js';
import { ingestImage, locateImage, locateNoteImage, type ImageDeps, type LocatedImage } from '../images/ingest.js';
import { UnsupportedImageError } from '../images/probe.js';
import { dbImageRecords } from '../images/records.js';
import type { ToolDeps } from '../mcp/tools.js';
import { normalizeId } from '../notes/ids.js';
import type { Note, Origin } from '../notes/types.js';

/** Upload / create_image size cap. */
export const MAX_IMAGE_BYTES = 200 * 1024 * 1024;

export type ImageVariant = 'original' | 'display' | 'thumb' | 'preview';

export interface ServedFile {
  absPath: string;
  mime: string;
  etag: string;
  size: number;
  /** true for originals: bytes behind this URL never change. */
  immutable: boolean;
}

export type ResolveResult =
  | { status: 'ok'; loc: LocatedImage; file: ServedFile; servedOriginal: boolean }
  | { status: 'not_found' }
  /** Note alias only: a live note with no live image. */
  | { status: 'no_image'; id: string }
  | { status: 'not_on_this_machine'; id: string; host: string | null };

export type ImageInputErrorCode = 'not_absolute' | 'not_found' | 'not_a_file' | 'not_an_image' | 'too_large';

export class ImageInputError extends Error {
  constructor(
    readonly code: ImageInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageInputError';
  }
}

/** ImageDeps for the MCP tools (they get ToolDeps, not AppDeps). */
export function toolImageDeps(deps: ToolDeps): ImageDeps {
  return { dataDir: deps.dataDir, notes: deps.service, records: dbImageRecords(deps.db) };
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** True when an If-None-Match header value names this ETag (handles lists, weak tags and `*`). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

const DERIVED_MIME = { thumb: 'image/webp', preview: 'image/jpeg' } as const;

/** One variant of a located image as a file, or not_on_this_machine. Derivatives go to cache/<imageId>/. */
async function resolveLocated(img: ImageDeps, loc: LocatedImage, variant: ImageVariant): Promise<ResolveResult> {
  if (!loc.available) return { status: 'not_on_this_machine', id: loc.id, host: loc.host };
  const sha = loc.meta.sha256;
  try {
    let absPath: string;
    let mime: string;
    let servedOriginal = false;
    if (variant === 'original') {
      absPath = loc.originalPath;
      mime = loc.mime;
      servedOriginal = true;
    } else if (variant === 'display') {
      const d = await getDisplay(img.dataDir, loc);
      absPath = d.path;
      mime = d.mime;
      servedOriginal = d.path === loc.originalPath;
    } else if (variant === 'thumb') {
      absPath = await getThumb(img.dataDir, loc);
      mime = DERIVED_MIME.thumb;
    } else {
      absPath = await getPreview(img.dataDir, loc);
      mime = DERIVED_MIME.preview;
    }
    const st = await stat(absPath);
    return {
      status: 'ok',
      loc,
      servedOriginal,
      file: {
        absPath,
        mime,
        etag: servedOriginal ? `"${sha}"` : `"${sha}-${variant}"`,
        size: st.size,
        immutable: servedOriginal,
      },
    };
  } catch (err) {
    if (err instanceof OriginalMissingError) return { status: 'not_on_this_machine', id: loc.id, host: loc.host };
    throw err;
  }
}

/**
 * One variant of an image, by image id (any spelling). Serves any existing row: live, removed
 * from its note, or in a deleted note (the bin shows their thumbnails). Unknown id: not_found.
 */
export async function resolveImageFile(img: ImageDeps, rawImageId: string, variant: ImageVariant): Promise<ResolveResult> {
  const id = normalizeId(rawImageId);
  if (id === null) return { status: 'not_found' };
  const loc = await locateImage(img, id);
  if (loc === null) return { status: 'not_found' };
  return resolveLocated(img, loc, variant);
}

/**
 * The legacy `/api/notes/:id/:variant` alias: the first live image of a live note. Unknown or
 * deleted note: not_found. Live note without a live image: no_image.
 */
export async function resolveNoteImageFile(img: ImageDeps, rawNoteId: string, variant: ImageVariant): Promise<ResolveResult> {
  const id = normalizeId(rawNoteId);
  if (id === null) return { status: 'not_found' };
  const loc = await locateNoteImage(img, id);
  if (loc === null) {
    return (await img.notes.getOne(id)) ? { status: 'no_image', id } : { status: 'not_found' };
  }
  if (loc.noteDeleted) return { status: 'not_found' };
  return resolveLocated(img, loc, variant);
}

function blankToUndefined(s: string | undefined | null): string | undefined {
  return s != null && s.trim() !== '' ? s : undefined;
}

async function runIngest(
  img: ImageDeps,
  input: Parameters<typeof ingestImage>[1],
): Promise<{ note: Note; created: boolean }> {
  try {
    return await ingestImage(img, input);
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      throw new ImageInputError('not_an_image', `not an image: ${err.message}`);
    }
    throw err;
  }
}

/** HTTP upload path: bytes come from the multipart File. */
export async function ingestFromUpload(
  img: ImageDeps,
  file: File,
  body: string | undefined,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<{ note: Note; created: boolean }> {
  if (file.size === 0) throw new ImageInputError('not_an_image', 'the uploaded file is empty');
  if (file.size > maxBytes) {
    throw new ImageInputError('too_large', `file is ${file.size} bytes; the limit is ${maxBytes}`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const origin: Origin = { source: 'web' };
  const b = blankToUndefined(body);
  return runIngest(img, { bytes, originalName: file.name || 'upload', origin, ...(b !== undefined ? { body: b } : {}) });
}

/** MCP create_image path: a local file, copied (never moved). */
export async function ingestFromPath(
  img: ImageDeps,
  rawPath: string,
  body: string | undefined,
  origin: Origin | null,
): Promise<{ note: Note; created: boolean }> {
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
  const b = blankToUndefined(body);
  return runIngest(img, { path: p, originalName: path.basename(p), origin, move: false, ...(b !== undefined ? { body: b } : {}) });
}
```
**Impact:** A removed image, or an image of a deleted note, is now served by its image id. The alias keeps today's 404 bodies. Phase 3 adds `attachFromUpload` / `attachFromPath` to this file.

### Step 9: Image routes
**File:** `src/http/images.ts` (rewrite, 101 lines today)
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps } from '../deps.js';
import { imageDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import { findImageById } from '../notes/imageRepo.js';
import { toNoteImage } from '../notes/types.js';
import {
  etagMatches,
  ImageInputError,
  ingestFromUpload,
  MAX_IMAGE_BYTES,
  resolveImageFile,
  resolveNoteImageFile,
  type ImageVariant,
  type ResolveResult,
} from './imageAccess.js';

export interface ImageRouteOptions {
  /** Upload cap in bytes. Default MAX_IMAGE_BYTES (200 MB). Tests lower it. */
  maxUploadBytes?: number;
}

/** Room for multipart boundaries and the optional body field on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

const VARIANTS: readonly ImageVariant[] = ['original', 'display', 'thumb', 'preview'];

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendResolved(c: Context, r: ResolveResult): Response {
  switch (r.status) {
    case 'not_found':
      return c.json({ error: 'not_found' }, 404);
    case 'no_image':
      return c.json({ error: 'no_image', id: r.id }, 404);
    case 'not_on_this_machine':
      return c.json({ error: 'not_on_this_machine', host: r.host }, 404);
    case 'ok':
      break;
  }
  const f = r.file;
  const headers: Record<string, string> = {
    'Content-Type': f.mime,
    ETag: f.etag,
    'Cache-Control': f.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  const originalName = r.loc.meta.original_name;
  if (r.servedOriginal && originalName) headers['Content-Disposition'] = contentDisposition(originalName);
  if (etagMatches(c.req.header('if-none-match'), f.etag)) {
    return c.body(null, 304, headers);
  }
  headers['Content-Length'] = String(f.size);
  const stream = Readable.toWeb(createReadStream(f.absPath)) as unknown as ReadableStream<Uint8Array>;
  return c.body(stream, 200, headers);
}

/**
 * Image routes:
 * - POST /api/images: upload one file as a new note (or the note already holding it).
 * - GET /api/images/:imageId: the image's NoteImage JSON, in any state.
 * - GET /api/images/:imageId/{original|display|thumb|preview}: any existing image row's file.
 * - GET /api/notes/:id/{variant}: alias, the first live image of a live note.
 */
export function imageRoutes(deps: AppDeps, opts: ImageRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_IMAGE_BYTES;
  const img = imageDeps(deps);
  const r = new Hono();

  r.post(
    '/api/images',
    bodyLimit({
      maxSize: maxUpload + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: 'too_large', max_bytes: maxUpload }, 413),
    }),
    async (c) => {
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'bad_multipart' }, 400);
      }
      const fileField = Array.isArray(form['file']) ? form['file'][0] : form['file'];
      if (!(fileField instanceof File)) return c.json({ error: 'file_required' }, 400);
      const bodyField = Array.isArray(form['body']) ? form['body'][0] : form['body'];
      const body = typeof bodyField === 'string' ? bodyField : undefined;
      try {
        const result = await ingestFromUpload(img, fileField, body, maxUpload);
        return c.json(result, result.created ? 201 : 200);
      } catch (err) {
        if (err instanceof ImageInputError) {
          const status = err.code === 'too_large' ? 413 : 415;
          return c.json({ error: err.code, message: err.message }, status);
        }
        throw err;
      }
    },
  );

  r.get('/api/images/:imageId', async (c) => {
    const id = normalizeId(c.req.param('imageId') ?? '');
    const row = id === null ? null : await findImageById(deps.db, id);
    if (row === null) return c.json({ error: 'not_found' }, 404);
    return c.json(toNoteImage(row, deps.config.dataDir));
  });

  for (const variant of VARIANTS) {
    r.get(`/api/images/:imageId/${variant}`, async (c) =>
      sendResolved(c, await resolveImageFile(img, c.req.param('imageId') ?? '', variant)),
    );
    r.get(`/api/notes/:id/${variant}`, async (c) =>
      sendResolved(c, await resolveNoteImageFile(img, c.req.param('id') ?? '', variant)),
    );
  }

  return r;
}
```
**Impact:** New GET routes only. Phase 3 adds `POST /api/notes/:id/images`, `DELETE /api/images/:imageId` and `POST /api/images/:imageId/restore`, and phase 5 adds `POST /api/images/:imageId/reveal` in its own router. None of them collides on method + path.

### Step 10: MCP `view_images`
**File:** `src/mcp/imageTools.ts` (rewrite, 142 lines today)
**Code:**
```ts
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ImageInputError, ingestFromPath, resolveImageFile, toolImageDeps, type ResolveResult } from '../http/imageAccess.js';
import type { ImageDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import type { Note, NoteImage } from '../notes/types.js';
import type { ToolDeps } from './tools.js';

/** Most ids per call, and most images returned per call. */
export const VIEW_IMAGES_MAX = 8;

type Content = CallToolResult['content'][number];

/** One image to show: its note, the image, and its 1-based place among the note's live images. */
type ViewItem = { note: Note; image: NoteImage; k: number; n: number };

const originShape = z
  .object({
    cwd: z.string().optional().describe('Working directory the note was saved from.'),
    repo: z.string().optional().describe('Repository name or remote.'),
    claude_session: z.string().optional().describe('Claude Code session id.'),
  })
  .optional()
  .describe('Where this note came from. Pass the current cwd/repo when saving from a repo.');

function text(t: string): Content {
  return { type: 'text', text: t };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function tagLine(note: Note): string {
  return `tags: ${note.tags.length > 0 ? note.tags.map((t) => `#${t}`).join(' ') : 'none'}`;
}

function bodyLine(note: Note): string {
  return `body: ${note.body.trim() === '' ? '(empty)' : note.body}`;
}

/** The metadata block for a note without an image. */
export function describeNote(note: Note): string {
  return [`id: ${note.id}`, `saved: ${note.created_at}`, tagLine(note), bodyLine(note)].join('\n');
}

/** The metadata text block that precedes every image view_images returns. */
export function describeImage(note: Note, image: NoteImage, k: number, n: number): string {
  return [
    `id: ${note.id}`,
    `image: ${image.id} (image ${k} of ${n})`,
    `saved: ${note.created_at}`,
    `taken: ${image.taken_at ?? 'unknown (no EXIF date)'}`,
    `size: ${image.width}x${image.height} ${image.mime}, ${formatBytes(image.bytes)}` +
      (image.original_name ? `, original name ${image.original_name}` : ''),
    tagLine(note),
    bodyLine(note),
  ].join('\n');
}

/** Text block + picture for one image, or a text block saying why there is no picture. */
async function viewOne(img: ImageDeps, item: ViewItem): Promise<Content[]> {
  const head = describeImage(item.note, item.image, item.k, item.n);
  let resolved: ResolveResult;
  try {
    resolved = await resolveImageFile(img, item.image.id, 'preview');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [text(`${head}\n(the preview could not be generated: ${msg})`)];
  }
  if (resolved.status === 'ok') {
    const data = (await readFile(resolved.file.absPath)).toString('base64');
    return [text(head), { type: 'image', data, mimeType: resolved.file.mime }];
  }
  if (resolved.status === 'not_on_this_machine') {
    return [text(`${head}\n(image not on this machine: the file lives on ${resolved.host ?? 'another machine'})`)];
  }
  return [text(`${head}\n(no image available)`)];
}

export function registerImageTools(server: McpServer, deps: ToolDeps): void {
  const img = toolImageDeps(deps);

  server.registerTool(
    'create_image',
    {
      title: 'Create image note',
      description:
        'Save a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...) as a new note with that one image. ' +
        'Give an absolute path (~/ is expanded). The file is COPIED byte for byte into the notes store; the source is left where it is. ' +
        'Optional body is the note text; #hashtags in it become tags. ' +
        'If the exact same file already lives in a note, that note is returned (created: false) instead of a duplicate. ' +
        'Non-image files are refused. Returns { note, created }.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path to the image file, or a path starting with ~/.'),
        body: z.string().optional().describe('Text for the note. #hashtags become tags.'),
        origin: originShape,
      },
    },
    async ({ path, body, origin }): Promise<CallToolResult> => {
      try {
        const { note, created } = await ingestFromPath(img, path, body, { ...(origin ?? {}), source: 'mcp' });
        return { content: [text(JSON.stringify({ note, created }, null, 2))] };
      } catch (err) {
        if (err instanceof ImageInputError) {
          return { isError: true, content: [text(`create_image refused (${err.code}): ${err.message}`)] };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'view_images',
    {
      title: 'View images',
      description:
        `Look at the pictures in notes. Takes 1 to ${VIEW_IMAGES_MAX} ids (any case, dash optional): a note id shows every image of that note in order, ` +
        "an image id (from a note's images[].id) shows that one image. " +
        'Each picture comes after its metadata (note id, image id and "image k of n", saved date, EXIF taken date, dimensions, tags, body), ' +
        'downscaled to at most 1568 px on the long edge. Find ids first with list/search (has_image: true means at least one image). ' +
        `At most ${VIEW_IMAGES_MAX} images come back per call; a last text line lists the image ids left out, to pass to the next call. ` +
        'Text notes, deleted notes, removed images, unknown ids and images whose file lives on another machine come back as a text line saying so.',
      inputSchema: {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(VIEW_IMAGES_MAX)
          .describe(`Note ids or image ids, 1 to ${VIEW_IMAGES_MAX}.`),
      },
    },
    async ({ ids }): Promise<CallToolResult> => {
      const found = await deps.service.get(ids, { includeDeleted: true });
      const byId = new Map(found.notes.map((n) => [n.id, n]));
      const content: Content[] = [];
      const seen = new Set<string>();
      const overflow: string[] = [];
      let shown = 0;

      for (const raw of ids) {
        const id = normalizeId(raw);
        if (id === null) {
          content.push(text(`${raw}: no such note or image.`));
          continue;
        }
        let items: ViewItem[];
        const note = byId.get(id);
        if (note) {
          if (note.deleted_at !== undefined) {
            content.push(text(`${note.id}: this note is deleted (restore it to view it).`));
            continue;
          }
          if (note.images.length === 0) {
            content.push(text(`${describeNote(note)}\n(text note: it has no image)`));
            continue;
          }
          items = note.images.map((image, i) => ({ note, image, k: i + 1, n: note.images.length }));
        } else {
          const rec = await img.records.byImageId(id);
          if (!rec) {
            content.push(text(`${raw}: no such note or image.`));
            continue;
          }
          if (rec.note_deleted_at !== null) {
            content.push(text(`${id}: this image belongs to note ${rec.note_id}, which is deleted (restore the note to view it).`));
            continue;
          }
          if (rec.deleted_at !== null) {
            content.push(text(`${id}: this image was removed from note ${rec.note_id}.`));
            continue;
          }
          const owner = await deps.service.getOne(rec.note_id);
          const index = owner ? owner.images.findIndex((i) => i.id === id) : -1;
          const image = owner ? owner.images[index] : undefined;
          if (!owner || !image) {
            content.push(text(`${raw}: no such note or image.`));
            continue;
          }
          items = [{ note: owner, image, k: index + 1, n: owner.images.length }];
        }
        for (const item of items) {
          if (seen.has(item.image.id)) continue;
          seen.add(item.image.id);
          if (shown >= VIEW_IMAGES_MAX) {
            overflow.push(item.image.id);
            continue;
          }
          shown += 1;
          content.push(...(await viewOne(img, item)));
        }
      }

      if (overflow.length > 0) {
        content.push(
          text(
            `${overflow.length} more image(s) not shown (at most ${VIEW_IMAGES_MAX} per call): ${overflow.join(', ')}. Call view_images again with these ids.`,
          ),
        );
      }
      return { content };
    },
  );
}
```
**Impact:** The `ids` cap stays at 8 (the existing 9-id refusal test holds). The chat caption (`src/chat/status.ts`) counts `ids`, which is unchanged. Phase 3 appends `attach_image` / `remove_image` / `restore_image` registrations to `registerImageTools`.

### Step 11: MCP filter descriptions
**File:** `src/mcp/tools.ts`
**Lines 19-21.** Replace with:
```ts
/** Appended to the `list` and `search` descriptions. */
export const IMAGE_FILTER_HINT =
  ' Filter notes with images by has_image (true = at least one image), and by when a photo was taken with taken_from/taken_to (EXIF; a note matches when any of its images does). To look at the pictures, pass the note ids to view_images.';
```
**Lines 62-75.** Replace the `has_image`, `taken_from`, `taken_to` fields with:
```ts
  has_image: z
    .boolean()
    .optional()
    .describe('true: only notes with at least one image (photos, screenshots). false: only notes with no image. Omit for both.'),
  taken_from: z
    .string()
    .optional()
    .describe(
      'Earliest EXIF "taken" date: YYYY-MM-DD (start of that local day) or an ISO 8601 datetime. A note matches when any of its images was taken in range; images without a camera date never match. For the day a picture was SAVED use from/to instead.',
    ),
  taken_to: z
    .string()
    .optional()
    .describe('Latest EXIF "taken" date, inclusive: YYYY-MM-DD (the whole local day) or an ISO 8601 datetime. Same any-image rule as taken_from.'),
```
**Impact:** Text only. The `images.mcp` test checks only the property names.

### Step 12: Server instructions
**File:** `src/mcp/instructions.ts`
**Line 16 ("Notes." paragraph).** Replace the end of the paragraph, `... origin (where it was saved from: cwd, repo, claude_session; may be null) and image (null for text notes).`, so the whole line reads:
```ts
    `Notes. A note is a single plain-text body: no title, no fields, no other structure. Put everything in the body. Tags are the #hashtags written in the body (#seer, #v250, #from_phone); the server re-parses them from the body on every write and lower-cases them. To tag a note, write the hashtag into its body (update or append); to untag it, remove the hashtag from the body. Tag filters accept "seer" or "#seer". Every note returned has id, body, tags, created_at and updated_at (ISO 8601, UTC), origin (where it was saved from: cwd, repo, claude_session; may be null) and images (an array, empty for text notes).`,
```
**Line 30 ("Images." paragraph).** Replace with:
```ts
    `Images. A note can hold several images: photos or screenshots saved on the laptop that stored them. Every note returned by get/list/search has an images array, empty for text notes, otherwise one entry per image in the order they were added, each {id, note_id, position, mime, width, height, bytes, taken_at, original_name, host, available, urls}. An image id looks like a note id; a note's first image shares the note's id. To look at pictures, find the ids first, then call view_images with up to 8 note ids or image ids: a note id shows every image of that note, at most 8 images come back per call, and a last line lists the image ids left for the next call. "Show me pictures I saved on 30 oct" means list with has_image: true (notes with at least one image) and from/to for that day, then view_images on the ids. "Photos taken last week" uses taken_from/taken_to (the camera's EXIF date; a note matches when any of its images was taken then). To save a local image file (for example a screenshot path you have), call create_image with its absolute path and optional body text; it becomes a new note, the file is copied, not moved, and saving a file that already lives in a note returns that note. available: false means that image's file lives on another machine (host): the note's text is still there, but that picture cannot be viewed here.`,
```
**Impact:** Text only (`mcp.instructions.test.ts` asserts none of this wording). Phase 3 extends this paragraph (or adds one) for `attach_image` / `remove_image` / `restore_image`.

### Step 13: Chat prompt sentence
**File:** `src/chat/prompt.ts:27`. Replace with:
```ts
    `To look at pictures, find the notes with images first (list with has_image, or search), then call view_images with their note ids (each note id shows every image of that note, up to 8 images per call; image ids work too) and comment on what you actually see.`,
```
**Impact:** Text only (`chat-prompt.test.ts` asserts none of it).

### Step 14: Startup reconcile
**File:** `src/background.ts`
**Imports, lines 1-5.** Replace with:
```ts
import type { AppDeps } from './deps.js';
import { dbEmbeddingStore } from './embeddings/backfill.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './embeddings/worker.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { reconcileLegacyImages } from './images/legacy.js';
import { ensureDataDirs } from './images/store.js';
```
**Doc + start of `startBackground`, lines 9-18.** Replace from the doc comment down to and including `const dirs = await ensureDataDirs(img.dataDir);` with:
```ts
/**
 * Long-running work beside the HTTP server: the inbox watcher (iteration 2) and, when
 * OPENROUTER_API_KEY is set, the embedding worker (iteration 6).
 * Creates images/, cache/, inbox/, inbox/failed/ under the data dir first (idempotent; the
 * daemon already made them, but tests call this without startDaemon). Then copies any legacy
 * image (notes.image_path/image_meta without a note_images row, e.g. ingested by an older daemon
 * after migration 0002 ran) into note_images, once, before the inbox can dedupe against it.
 */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  const img = imageDeps(deps);
  const dirs = await ensureDataDirs(img.dataDir);
  try {
    const copied = await reconcileLegacyImages(deps.db);
    console.log(`[notesd] legacy images reconciled into note_images: ${copied}`);
  } catch (err) {
    // Never block the daemon on it: the next start retries (the copy is idempotent).
    console.error(`[notesd] legacy image reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
```
The rest of the function (inbox watcher, embedding worker, stop function) is unchanged.
**Impact:** One INSERT…SELECT per daemon start. `daemon.int.test.ts` and `images.int.test.ts` exercise it.

### Step 15: In-memory fake
**File:** `tests/helpers/fakeNotes.ts` (rewrite)
**Code:**
```ts
import type { ImageNotes } from '../../src/images/ingest.js';
import type { ImageRecord, ImageRecords } from '../../src/images/records.js';
import { generateId, normalizeId } from '../../src/notes/ids.js';
import { imageUrls, NoteError, type ImageMeta, type Note, type NoteImage, type Origin } from '../../src/notes/types.js';

export type FakeNoteRow = {
  id: string;
  body: string;
  origin: Origin | null;
  created_at: string;
  deleted_at: string | null;
};

export type FakeImageRow = {
  id: string;
  note_id: string;
  path: string;
  meta: ImageMeta;
  position: number;
  deleted_at: string | null;
};

/**
 * In-memory stand-in for the slice of the notes service ingestion uses, plus the raw image
 * lookups, with the same unique rules as the schema: an id is taken when a note or an image has
 * it (NoteError 'conflict'); sha256 is unique among images with deleted_at null, whatever their
 * note's state (NoteError 'duplicate_image').
 */
export class FakeNotes implements ImageNotes, ImageRecords {
  rows = new Map<string, FakeNoteRow>();
  images = new Map<string, FakeImageRow>();
  /** Called inside create() before the uniqueness checks; lets a test interleave a competing insert. */
  beforeInsert: ((id: string) => Promise<void> | void) | null = null;
  failNextCreate: Error | null = null;

  private liveImagesOf(noteId: string): FakeImageRow[] {
    return [...this.images.values()]
      .filter((i) => i.note_id === noteId && i.deleted_at === null)
      .sort((a, b) => a.position - b.position);
  }

  private toWire(i: FakeImageRow): NoteImage {
    return {
      id: i.id,
      note_id: i.note_id,
      position: i.position,
      mime: i.meta.mime,
      width: i.meta.width,
      height: i.meta.height,
      bytes: i.meta.bytes,
      taken_at: i.meta.taken_at,
      original_name: i.meta.original_name,
      host: i.meta.host,
      available: true,
      urls: imageUrls(i.id),
    };
  }

  private toNote(r: FakeNoteRow): Note {
    const note: Note = {
      id: r.id,
      body: r.body,
      tags: [],
      created_at: r.created_at,
      updated_at: r.created_at,
      origin: r.origin,
      images: this.liveImagesOf(r.id).map((i) => this.toWire(i)),
    };
    // As rowToNote: deleted_at is present only on deleted notes.
    if (r.deleted_at !== null) note.deleted_at = r.deleted_at;
    return note;
  }

  private toRecord(i: FakeImageRow): ImageRecord {
    return {
      id: i.id,
      note_id: i.note_id,
      path: i.path,
      meta: i.meta,
      position: i.position,
      deleted_at: i.deleted_at,
      note_deleted_at: this.rows.get(i.note_id)?.deleted_at ?? null,
    };
  }

  /** Put a note (and its first image, same id, position 0) straight into the store, skipping every check. */
  seed(input: { id: string; body?: string; origin?: Origin | null; image?: { path: string; meta: ImageMeta } }): void {
    this.rows.set(input.id, {
      id: input.id,
      body: input.body ?? '',
      origin: input.origin ?? null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    });
    if (input.image) {
      this.images.set(input.id, {
        id: input.id,
        note_id: input.id,
        path: input.image.path,
        meta: input.image.meta,
        position: 0,
        deleted_at: null,
      });
    }
  }

  async newId(): Promise<string> {
    for (;;) {
      const id = generateId();
      if (!this.rows.has(id) && !this.images.has(id)) return id;
    }
  }

  async create(input: Parameters<ImageNotes['create']>[0]): Promise<Note> {
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    const id = input.id ?? (await this.newId());
    await this.beforeInsert?.(id);
    if (this.rows.has(id) || this.images.has(id)) throw new NoteError('conflict', `note ${id} already exists`);
    const sha = input.image?.meta.sha256;
    if (sha && [...this.images.values()].some((i) => i.deleted_at === null && i.meta.sha256 === sha)) {
      throw new NoteError('duplicate_image', 'a live image already holds these bytes');
    }
    const row: FakeNoteRow = {
      id,
      body: input.body,
      origin: input.origin ?? null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    this.rows.set(id, row);
    if (input.image) {
      this.images.set(id, { id, note_id: id, path: input.image.path, meta: input.image.meta, position: 0, deleted_at: null });
    }
    return this.toNote(row);
  }

  async getOne(id: string, opts?: { includeDeleted?: boolean }): Promise<Note | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    return r.deleted_at === null || opts?.includeDeleted ? this.toNote(r) : null;
  }

  async restore(id: string): Promise<Note> {
    const r = this.rows.get(id);
    if (!r) throw new NoteError('not_found', `no note ${id}`);
    r.deleted_at = null;
    return this.toNote(r);
  }

  softDelete(id: string): void {
    const r = this.rows.get(id);
    if (r) r.deleted_at = new Date().toISOString();
  }

  /** Mark one image removed (in the bin), as phase 3's removeImage will. */
  removeImage(imageId: string): void {
    const i = this.images.get(imageId);
    if (i) i.deleted_at = new Date().toISOString();
  }

  async bySha256Live(sha256: string): Promise<ImageRecord | null> {
    const hit = [...this.images.values()].find((i) => i.deleted_at === null && i.meta.sha256 === sha256);
    return hit ? this.toRecord(hit) : null;
  }

  async byImageId(input: string): Promise<ImageRecord | null> {
    const id = normalizeId(input);
    const hit = id === null ? undefined : this.images.get(id);
    return hit ? this.toRecord(hit) : null;
  }

  async firstLiveImageOfNote(input: string): Promise<ImageRecord | null> {
    const id = normalizeId(input);
    if (id === null) return null;
    const [first] = this.liveImagesOf(id);
    return first ? this.toRecord(first) : null;
  }
}
```

### Step 16: Unit tests for ingest and inbox
**File:** `tests/unit/images/ingest.test.ts`
- Lines 36-48: replace `notes.byId(note.id)` with `notes.byImageId(note.id)`, every `rec.image_path` with `rec.path` and every `rec.image_meta` with `rec.meta`. After the `expect(note.body)` line, add:
  ```ts
    expect(note.images.map((i) => i.id)).toEqual([note.id]);
    expect(rec).toMatchObject({ id: note.id, note_id: note.id, position: 0, deleted_at: null, note_deleted_at: null });
  ```
- Lines 81-85 and 94-99: make the same `byId` -> `byImageId`, `image_path` -> `path`, `image_meta` -> `meta` replacements.
- Lines 144-165 (the concurrent-insert `beforeInsert`): replace the `notes.rows.set('G-PD1', {...})` call with:
  ```ts
      notes.seed({
        id: 'G-PD1',
        image: {
          path: relPath,
          meta: {
            sha256: sha256Hex(bytes),
            mime: 'image/png',
            width: 40,
            height: 30,
            bytes: bytes.byteLength,
            taken_at: null,
            original_name: null,
            host: 'gpd',
          },
        },
      });
  ```
- Lines 176-186 (the squatter): replace the `notes.rows.set(id, {...})` call with `notes.seed({ id, body: 'squatter' });`.
- Add these tests at the end of the `describe('ingestImage')` block (before line 193):
  ```ts
  it('a removed image does not dedupe: the same bytes become a new note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    notes.removeImage(first.note.id);
    const again = await ingestImage(deps, { bytes });
    expect(again.created).toBe(true);
    expect(again.note.id).not.toBe(first.note.id);
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(2);
  });

  it('a live image in a deleted note restores that note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    notes.softDelete(first.note.id);
    expect((await notes.bySha256Live(sha256Hex(bytes)))!.note_deleted_at).not.toBeNull();
    const again = await ingestImage(deps, { bytes });
    expect(again).toMatchObject({ created: false, note: { id: first.note.id } });
    expect(again.note.deleted_at).toBeUndefined();
  });
  ```
- In `describe('locateImage')`, after line 199 add:
  ```ts
    expect(loc).toMatchObject({ noteId: note.id, position: 0, imageDeleted: false, noteDeleted: false });
    notes.removeImage(note.id);
    expect((await locateImage(deps, note.id))!).toMatchObject({ imageDeleted: true, deleted: true });
  ```
  Insert these lines **before** the existing `await rm(loc.originalPath);` line. The removed image is still located, and `available` keeps working after it.

**File:** `tests/unit/images/inbox.test.ts:69-81`. Replace the two row reads:
```ts
    const [row] = [...notes.rows.values()];
    expect(row!.origin).toEqual({ source: 'inbox' });
    expect((await notes.byImageId(row!.id))!.meta.original_name).toBe('early.jpg');
```
and
```ts
    const [row] = [...notes.rows.values()];
    expect(await fileExists(path.join(dir, (await notes.byImageId(row!.id))!.path))).toBe(true);
```

### Step 17: Unit tests for the wire mapping
**File:** `tests/unit/notes.helpers.test.ts`
- Line 8: replace the import with:
  ```ts
  import { cleanOrigin, imageAvailable, NoteError, rowToNote, toNoteImage, type NoteRow } from '../../src/notes/types.js';
  import type { NoteImageRow } from '../../src/db/schema.js';
  ```
- After `function row(...)` (ends line 26), add:
  ```ts
  function imageRow(overrides: Partial<NoteImageRow> = {}): NoteImageRow {
    return {
      id: 'A-B32',
      noteId: 'A-B32',
      path: 'images/2026/10/A-B32.jpg',
      sha256: 'h',
      mime: 'image/jpeg',
      width: 4,
      height: 3,
      bytes: 1,
      takenAt: new Date('2026-10-29T08:00:00.000Z'),
      originalName: 'IMG_1.jpg',
      host: 'lenovo',
      position: 0,
      createdAt: new Date('2026-10-30T01:02:03.004Z'),
      deletedAt: null,
      ...overrides,
    };
  }
  ```
- Lines 78-103 (the tests `maps a text note`, `adds deleted_at only for deleted notes` and `maps image meta and checks the file under dataDir`): replace with:
  ```ts
  it('maps a text note', () => {
    expect(rowToNote(row({ origin: { repo: 'seer' } }), dataDir, [])).toEqual({
      id: 'A-B32',
      body: 'hello #seer',
      tags: ['seer'],
      created_at: '2026-10-30T01:02:03.004Z',
      updated_at: '2026-10-30T02:00:00.000Z',
      origin: { repo: 'seer' },
      images: [],
    });
  });

  it('adds deleted_at only for deleted notes', () => {
    const n = rowToNote(row({ deletedAt: new Date('2026-10-31T00:00:00Z') }), dataDir, []);
    expect(n.deleted_at).toBe('2026-10-31T00:00:00.000Z');
  });

  it('maps live images in position order and checks each file under dataDir', () => {
    mkdirSync(join(dataDir, 'images/2026/10'), { recursive: true });
    writeFileSync(join(dataDir, 'images/2026/10/A-B32.jpg'), 'x');
    const first = imageRow();
    const away = imageRow({ id: 'C-D45', path: 'images/2026/10/missing.jpg', position: 2, takenAt: null });
    const removed = imageRow({ id: 'E-F67', path: 'images/2026/10/E-F67.jpg', position: 1, deletedAt: new Date('2026-10-31T00:00:00Z') });
    const n = rowToNote(row(), dataDir, [away, removed, first]);
    expect(n.images.map((i) => i.id)).toEqual(['A-B32', 'C-D45']);
    expect(n.images[0]).toEqual({
      id: 'A-B32',
      note_id: 'A-B32',
      position: 0,
      mime: 'image/jpeg',
      width: 4,
      height: 3,
      bytes: 1,
      taken_at: '2026-10-29T08:00:00.000Z',
      original_name: 'IMG_1.jpg',
      host: 'lenovo',
      available: true,
      urls: {
        thumb: '/api/images/A-B32/thumb',
        display: '/api/images/A-B32/display',
        original: '/api/images/A-B32/original',
        preview: '/api/images/A-B32/preview',
      },
    });
    expect(n.images[1]).toMatchObject({ available: false, taken_at: null });
  });

  it('toNoteImage carries deleted_at only for removed images', () => {
    expect(toNoteImage(imageRow(), dataDir).deleted_at).toBeUndefined();
    expect(toNoteImage(imageRow({ deletedAt: new Date('2026-10-31T00:00:00Z') }), dataDir).deleted_at).toBe('2026-10-31T00:00:00.000Z');
  });
  ```
The `never reports a path outside dataDir as available` test stays.

### Step 18: Unit test for the filters
**File:** `tests/unit/takenFilter.test.ts` (rewrite)
```ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { filterConditions } from '../../src/notes/repo.js';
import { NoteError } from '../../src/notes/types.js';

const dialect = new PgDialect();
const render = (f: Parameters<typeof filterConditions>[0]) =>
  filterConditions(f).map((c) => dialect.sqlToQuery(c));
const imageConds = (f: Parameters<typeof filterConditions>[0]) => render(f).filter((q) => q.sql.includes('note_images'));

describe('filterConditions: images', () => {
  it('adds nothing about images without image filters', () => {
    expect(imageConds({})).toEqual([]);
  });

  it('hasImage is an EXISTS over the note\'s live images', () => {
    const [yes] = imageConds({ hasImage: true });
    expect(yes!.sql).toContain('exists (select 1 from "note_images" where "note_images"."note_id" = "notes"."id"');
    expect(yes!.sql).toContain('"note_images"."deleted_at" is null');
    expect(yes!.sql.startsWith('not ')).toBe(false);
    const [no] = imageConds({ hasImage: false });
    expect(no!.sql.startsWith('not exists (select 1 from "note_images"')).toBe(true);
  });

  it('the taken range is one EXISTS with both bounds on the same image (whole local days, UTC params)', () => {
    const qs = imageConds({ takenFrom: '2026-10-30', takenTo: '2026-10-30' });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.sql).toContain('"note_images"."taken_at" >= $1::timestamptz');
    expect(qs[0]!.sql).toContain('"note_images"."taken_at" < $2::timestamptz');
    expect(qs[0]!.sql).toContain('"note_images"."deleted_at" is null');
    expect(qs[0]!.params).toEqual([new Date(2026, 9, 30).toISOString(), new Date(2026, 9, 31).toISOString()]);
  });

  it('a single bound still gives one EXISTS', () => {
    const qs = imageConds({ takenTo: '2026-10-29' });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.sql).toContain('"note_images"."taken_at" <');
  });

  it('rejects garbage with invalid_input', () => {
    expect(() => filterConditions({ takenFrom: 'yesterday' })).toThrow(NoteError);
  });
});
```
(Each condition is rendered on its own, so the parameter numbers start at `$1` in every rendered fragment.)

### Step 19: Unit test for the same-origin guard
**File:** `tests/unit/sameOrigin.test.ts` (new)
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, isSameOrigin, sameOriginOnly } from '../../src/http/sameOrigin.js';

function guarded(): Hono {
  const app = new Hono();
  app.use('/guarded', sameOriginOnly);
  app.post('/guarded', (c) => c.json({ ok: true }));
  return app;
}

async function post(url: string, origin?: string): Promise<Response> {
  return guarded().request(url, { method: 'POST', headers: origin === undefined ? {} : { origin } });
}

describe('sameOriginOnly', () => {
  it("lets notesd's own page through on every loopback spelling", async () => {
    expect((await post('http://localhost:7317/guarded', 'http://localhost:7317')).status).toBe(200);
    expect((await post('http://127.0.0.1:7317/guarded', 'http://127.0.0.1:7317')).status).toBe(200);
    expect((await post('http://[::1]:7317/guarded', 'http://[::1]:7317')).status).toBe(200);
  });

  it('refuses a request without an Origin', async () => {
    const res = await post('http://localhost:7317/guarded');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
  });

  it('refuses a foreign, cross-port, cross-spelling or unparseable Origin', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:9999', 'http://127.0.0.1:7317', 'null', 'not a url', '']) {
      const res = await post('http://localhost:7317/guarded', origin);
      expect(res.status, origin).toBe(403);
      expect(await res.json(), origin).toEqual({ error: 'forbidden_origin' });
    }
  });

  it('refuses a non-loopback host even when the Origin matches it', async () => {
    expect((await post('http://notes.example.com/guarded', 'http://notes.example.com')).status).toBe(403);
  });
});

describe('isLoopbackUrl / isSameOrigin', () => {
  it('recognises loopback hosts only', () => {
    expect(isLoopbackUrl('http://localhost:7317/x')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:1/')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.2/')).toBe(false);
    expect(isLoopbackUrl('garbage')).toBe(false);
  });

  it('compares scheme, host and port', () => {
    expect(isSameOrigin('http://localhost:7317', 'http://localhost:7317/api/x')).toBe(true);
    expect(isSameOrigin('https://localhost:7317', 'http://localhost:7317/api/x')).toBe(false);
    expect(isSameOrigin(undefined, 'http://localhost:7317/api/x')).toBe(false);
  });
});
```
The existing `loopbackOnly` tests in `tests/unit/mcp.instructions.test.ts:73-83` keep passing unchanged.

### Step 20: Integration harnesses
**File:** `tests/integration/imageHarness.ts`
- Imports, lines 1-13. Replace with:
  ```ts
  import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
  import os from 'node:os';
  import path from 'node:path';
  import { serve, type ServerType } from '@hono/node-server';
  import { sql } from 'drizzle-orm';
  import sharp from 'sharp';
  import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG } from '../../src/config.js';
  import type { AppDeps } from '../../src/deps.js';
  import { createApp } from '../../src/http/app.js';
  import { sha256Hex } from '../../src/images/probe.js';
  import { dbImageRecords } from '../../src/images/records.js';
  import { NoteEvents } from '../../src/notes/events.js';
  import { insertImage } from '../../src/notes/imageRepo.js';
  import { NotesService } from '../../src/notes/service.js';
  import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';
  ```
- Lines 94-112 (`setTakenAt`, `originalPathOf`, `cacheDirOf`). Replace with:
  ```ts
  /** Set taken_at on every image of a note directly (the EXIF path itself is the ingest tests' subject). */
  export async function setTakenAt(h: Harness, noteId: string, takenAtIso: string | null): Promise<void> {
    await h.deps.db.execute(
      sql`update note_images
          set taken_at = ${takenAtIso === null ? sql`null` : sql`${takenAtIso}::timestamptz`}
          where note_id = ${noteId}`,
    );
  }

  /** Absolute path of an image's original on disk, by image id (a note's first image has the note's id). */
  export async function originalPathOf(h: Harness, imageId: string): Promise<string> {
    const rec = await dbImageRecords(h.deps.db).byImageId(imageId);
    if (!rec) throw new Error(`no image ${imageId}`);
    return path.join(h.dataDir, rec.path);
  }

  export function cacheDirOf(h: Harness, imageId: string): string {
    return path.join(h.dataDir, 'cache', imageId);
  }

  /**
   * Add one more image to an existing note directly (attach is phase 3): a 12x12 PNG of colour
   * `rgb` written to images/2026/10/<imageId>.png plus its note_images row. Returns the image id.
   */
  export async function addImage(
    h: Harness,
    noteId: string,
    imageId: string,
    position: number,
    rgb: { r: number; g: number; b: number },
  ): Promise<string> {
    const bytes = await makeImage('png', 12, 12, rgb);
    const rel = `images/2026/10/${imageId}.png`;
    await mkdir(path.join(h.dataDir, 'images/2026/10'), { recursive: true });
    await writeFile(path.join(h.dataDir, rel), bytes);
    await insertImage(h.deps.db, {
      id: imageId,
      noteId,
      path: rel,
      sha256: sha256Hex(bytes),
      mime: 'image/png',
      width: 12,
      height: 12,
      bytes: bytes.byteLength,
      takenAt: null,
      originalName: `${imageId}.png`,
      host: os.hostname(),
      position,
    });
    return imageId;
  }
  ```

**File:** `tests/integration/helpers/api-harness.ts:72-89` (`insertImageNote`). Replace the `await db.execute(sql\`INSERT INTO notes ...\`)` call with two inserts:
```ts
      await db.execute(sql`
        INSERT INTO notes (id, body, tags, origin, created_at, updated_at)
        VALUES (${id}, ${`photo #${tag}`}, ARRAY[${tag}]::text[], ${JSON.stringify({ source: 'test' })}::jsonb, now(), now())
      `);
      await db.execute(sql`
        INSERT INTO note_images (id, note_id, path, sha256, mime, width, height, bytes, taken_at, original_name, host, position, created_at)
        VALUES (${id}, ${id}, ${`images/2026/10/${id}.jpg`}, ${meta.sha256}, ${meta.mime}, ${meta.width}, ${meta.height},
                ${meta.bytes}, null, ${meta.original_name}, ${meta.host}, 0, now())
      `);
```
(The `meta` object above it stays and supplies the values.)

### Step 21: Integration tests
**File:** `tests/integration/notes.service.int.test.ts`
- Line 9: add after it:
  ```ts
  import { insertImage, setImageDeleted } from '../../src/notes/imageRepo.js';
  ```
- Line 68: `expect(note.image).toBeNull();` -> `expect(note.images).toEqual([]);`
- Lines 272-273: replace with:
  ```ts
    expect(here.images).toHaveLength(1);
    expect(here.images[0]).toMatchObject({ id: here.id, note_id: here.id, position: 0, mime: 'image/png', width: 2, height: 1, host: 'lenovo', available: true });
    expect(away.images[0]?.available).toBe(false);
  ```
- After `const meta = ...` (ends line 47), add:
  ```ts
  /** One more image row for a note, straight into note_images (attach is phase 3). */
  async function addImageRow(noteId: string, imageId: string, position: number, takenAt: Date | null = null): Promise<void> {
    await insertImage(db, {
      id: imageId,
      noteId,
      path: `images/2026/10/${imageId}.png`,
      sha256: `sha-${imageId}`,
      mime: 'image/png',
      width: 2,
      height: 1,
      bytes: 70,
      takenAt,
      originalName: `${imageId}.png`,
      host: 'lenovo',
      position,
    });
  }

  const idsOf = (notes: { id: string }[]) => notes.map((n) => n.id);
  ```
- Append at the end of the file:
  ```ts
  describe('NotesService images[] (iteration 7)', () => {
    it('create writes the first image with the note id at position 0', async () => {
      const n = await service.create({ body: '', allowEmpty: true, image: { path: 'images/2026/10/f.png', meta: meta('first') } });
      expect(n.images).toHaveLength(1);
      expect(n.images[0]).toMatchObject({
        id: n.id,
        note_id: n.id,
        position: 0,
        urls: { original: `/api/images/${n.id}/original`, thumb: `/api/images/${n.id}/thumb` },
      });
    });

    it('a duplicate first image rolls the whole create back', async () => {
      await service.create({ body: 'one', image: { path: 'images/2026/10/a2.png', meta: meta('dup2') } });
      const before = idsOf((await service.list({ limit: 100, deleted: 'include' })).notes);
      await expectNoteError(service.create({ body: 'two', image: { path: 'images/2026/10/b2.png', meta: meta('dup2') } }), 'duplicate_image');
      expect(idsOf((await service.list({ limit: 100, deleted: 'include' })).notes)).toEqual(before);
    });

    it('an id held by an image is not free for a new note', async () => {
      const n = await service.create({ body: 'host', image: { path: 'images/2026/10/h.png', meta: meta('host') } });
      await addImageRow(n.id, 'Q-IM2', 1);
      await expectNoteError(service.create({ id: 'Q-IM2', body: 'clash' }), 'conflict');
    });

    it('every read path returns live images only, in position order', async () => {
      const n = await service.create({ body: 'pool party', image: { path: 'images/2026/10/p0.png', meta: meta('p0') } });
      await addImageRow(n.id, 'P-OS2', 2);
      await addImageRow(n.id, 'P-OS1', 1);
      await setImageDeleted(db, 'P-OS1', true);
      const want = [n.id, 'P-OS2'];
      expect((await service.getOne(n.id))!.images.map((i) => i.id)).toEqual(want);
      expect((await service.get([n.id])).notes[0]!.images.map((i) => i.id)).toEqual(want);
      expect((await service.list({})).notes.find((x) => x.id === n.id)!.images.map((i) => i.id)).toEqual(want);
      expect((await service.search('pool', {}, { mode: 'text' })).notes[0]!.images.map((i) => i.id)).toEqual(want);
      expect((await service.append(n.id, 'more')).images.map((i) => i.id)).toEqual(want);
    });

    it('hasImage means at least one live image', async () => {
      const n = await service.create({ body: 'one shot', image: { path: 'images/2026/10/o.png', meta: meta('only') } });
      expect(idsOf((await service.list({ hasImage: true })).notes)).toContain(n.id);
      await setImageDeleted(db, n.id, true);
      expect(idsOf((await service.list({ hasImage: true })).notes)).not.toContain(n.id);
      expect(idsOf((await service.list({ hasImage: false })).notes)).toContain(n.id);
    });

    it('the taken range matches when any live image was taken in it', async () => {
      const n = await service.create({ body: 'trip', image: { path: 'images/2026/10/t0.png', meta: meta('t0') } });
      await addImageRow(n.id, 'T-AK1', 1, new Date(2026, 9, 30, 10, 0));
      expect(idsOf((await service.list({ takenFrom: '2026-10-30', takenTo: '2026-10-30' })).notes)).toEqual([n.id]);
      expect(idsOf((await service.list({ takenTo: '2026-10-29' })).notes)).toEqual([]);
      await setImageDeleted(db, 'T-AK1', true);
      expect(idsOf((await service.list({ takenFrom: '2026-10-30' })).notes)).toEqual([]);
    });
  });
  ```
The `findBySha256` test (lines 276-288) is unchanged and still passes: the image row stays live when its note is deleted, so the holder is found only with `includeDeleted`.

**File:** `tests/integration/images.int.test.ts`
- Line 1 imports: add `import { sql } from 'drizzle-orm';` after line 5 (`import sharp`), and `import { setImageDeleted } from '../../src/notes/imageRepo.js';` after line 15 (`NotesService`).
- Line 56: `expect(note.image).toMatchObject({` -> `expect(note.images[0]).toMatchObject({`, and add `id: note.id, note_id: note.id, position: 0,` as the first properties of that object.
- Lines 88-96 (the sha256 index test): replace the test with:
  ```ts
  it('the live-image sha256 index rejects a second note with the same bytes, and leaves no note behind', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const rec = (await deps.records.byImageId(note.id))!;
    const before = (await notes.list({ limit: 100, deleted: 'include' })).notes.map((n) => n.id);
    const err = await notes
      .create({ body: '', image: { path: 'images/2000/01/X-XXX.png', meta: rec.meta }, allowEmpty: true })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NoteError);
    expect((err as NoteError).code).toBe('duplicate_image');
    expect((await notes.list({ limit: 100, deleted: 'include' })).notes.map((n) => n.id)).toEqual(before);
  });

  it('a removed image does not dedupe: the same bytes make a new note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes });
    await setImageDeleted(db, a.note.id, true);
    const b = await ingestImage(deps, { bytes });
    expect(b.created).toBe(true);
    expect(b.note.id).not.toBe(a.note.id);
    expect(b.note.images.map((i) => i.id)).toEqual([b.note.id]);
  });
  ```
- Line 114: `expect((await notes.getOne(note.id))!.image!.available).toBe(false);` -> `expect((await notes.getOne(note.id))!.images[0]!.available).toBe(false);`
- Line 138: `expect(note.image!.original_name).toBe('phone.jpg');` -> `expect(note.images[0]!.original_name).toBe('phone.jpg');`
- Add a second test inside `describe('inbox via startBackground')`:
  ```ts
  it('startBackground copies a legacy image (old columns only) into note_images', async () => {
    const legacyMeta = { sha256: 'f'.repeat(64), mime: 'image/png', width: 1, height: 1, bytes: 1, taken_at: null, original_name: 'old.png', host: 'lenovo' };
    await db.execute(sql`
      insert into notes (id, body, tags, image_path, image_meta, created_at, updated_at)
      values ('L-EG1', 'old photo', '{}'::text[], 'images/2026/09/L-EG1.png', ${JSON.stringify(legacyMeta)}::jsonb, now(), now())
    `);
    expect((await notes.getOne('L-EG1'))!.images).toEqual([]);
    const app: AppDeps = {
      config: { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG },
      db,
      events: new NoteEvents(),
      service: notes,
      embedder: null,
    };
    stop = await startBackground(app);
    const note = (await notes.getOne('L-EG1'))!;
    expect(note.images).toHaveLength(1);
    expect(note.images[0]).toMatchObject({ id: 'L-EG1', note_id: 'L-EG1', position: 0, mime: 'image/png', original_name: 'old.png' });
  });
  ```

**File:** `tests/integration/images.http.int.test.ts`
- Lines 1-14 imports: add `import { setImageDeleted } from '../../src/notes/imageRepo.js';` after line 6, and add `addImage,` to the `./imageHarness.js` import list.
- Lines 16-19 (`UploadResult`): replace with:
  ```ts
  interface UploadResult {
    note: {
      id: string;
      body: string;
      tags: string[];
      images: Array<{ id: string; note_id: string; position: number; mime: string; width: number; height: number; available: boolean; host: string | null }>;
    };
    created: boolean;
  }
  ```
- Line 49: `expect(j1.note.image).toMatchObject({ ... })` -> `expect(j1.note.images[0]).toMatchObject({ id: j1.note.id, position: 0, mime: 'image/png', width: 64, height: 32, available: true });`
- Append inside the `describe` block (before the closing `});` on line 174):
  ```ts
  it('GET /api/images/:id returns the image JSON; unknown ids 404', async () => {
    const png = await makeImage('png', 16, 8, { r: 4, g: 4, b: 250 });
    const { note } = (await (await upload(png, 'j.png', 'image/png')).json()) as UploadResult;
    const res = await h.app.request(`/api/images/${note.id.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: note.id,
      note_id: note.id,
      position: 0,
      mime: 'image/png',
      width: 16,
      height: 8,
      available: true,
      urls: {
        thumb: `/api/images/${note.id}/thumb`,
        display: `/api/images/${note.id}/display`,
        original: `/api/images/${note.id}/original`,
        preview: `/api/images/${note.id}/preview`,
      },
    });
    const unknown = await h.app.request('/api/images/Z-ZZZ');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
    expect((await h.app.request('/api/images/Z-ZZZ/thumb')).status).toBe(404);
  });

  it('serves by image id in any state; the note alias is the first live image of a live note', async () => {
    const png = await makeImage('png', 20, 20, { r: 250, g: 250, b: 4 });
    const { note } = (await (await upload(png, 'first.png', 'image/png')).json()) as UploadResult;
    const second = await addImage(h, note.id, 'S-EC2', 1, { r: 9, g: 99, b: 199 });
    const secondBytes = await readFile(await originalPathOf(h, second));

    const byImage = await h.app.request(`/api/images/${second}/original`);
    expect(byImage.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await byImage.arrayBuffer()), secondBytes)).toBe(0);

    // Remove the first image: the alias falls to the second; the removed one is still served by its id.
    await setImageDeleted(h.deps.db, note.id, true);
    const alias = await h.app.request(`/api/notes/${note.id}/original`);
    expect(alias.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await alias.arrayBuffer()), secondBytes)).toBe(0);
    expect((await h.app.request(`/api/images/${note.id}/thumb`)).status).toBe(200);

    // Delete the note: the alias 404s, the image routes keep serving (the bin needs thumbnails).
    await h.deps.service.delete(note.id);
    const gone = await h.app.request(`/api/notes/${note.id}/original`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'not_found' });
    expect((await h.app.request(`/api/images/${second}/thumb`)).status).toBe(200);
    expect((await h.app.request(`/api/images/${second}`)).status).toBe(200);
  });

  it('a note whose only image was removed answers no_image on the alias', async () => {
    const png = await makeImage('png', 14, 14, { r: 1, g: 250, b: 1 });
    const { note } = (await (await upload(png, 'lone.png', 'image/png')).json()) as UploadResult;
    await setImageDeleted(h.deps.db, note.id, true);
    const res = await h.app.request(`/api/notes/${note.id}/thumb`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_image', id: note.id });
  });

  it('a reconciled legacy image (old columns only) is served by image id and by the note alias', async () => {
    // R5 "every image is still served" half of the migration test (phase 1 handoff): an
    // iteration-6 row whose file sits at the legacy path, copied by the reconcile, then served.
    const png = await makeImage('png', 12, 10, { r: 77, g: 7, b: 177 });
    const rel = 'images/2026/09/L-EG2.png';
    await mkdir(path.join(h.dataDir, 'images/2026/09'), { recursive: true });
    await writeFile(path.join(h.dataDir, rel), png);
    const meta = { sha256: createHash('sha256').update(png).digest('hex'), mime: 'image/png', width: 12, height: 10, bytes: png.byteLength, taken_at: null, original_name: 'old.png', host: 'lenovo' };
    await h.deps.db.execute(sql`
      insert into notes (id, body, tags, image_path, image_meta, created_at, updated_at)
      values ('L-EG2', 'old photo', '{}'::text[], ${rel}, ${JSON.stringify(meta)}::jsonb, now(), now())
    `);
    expect(await reconcileLegacyImages(h.deps.db)).toBe(1);
    for (const url of ['/api/images/L-EG2/thumb', '/api/notes/L-EG2/thumb', '/api/images/L-EG2/original']) {
      expect((await h.app.request(url)).status).toBe(200);
    }
    const original = await h.app.request('/api/images/L-EG2/original');
    expect(Buffer.compare(Buffer.from(await original.arrayBuffer()), png)).toBe(0);
  });
  ```
  Imports for that last test: add `import { createHash } from 'node:crypto';`, `import { reconcileLegacyImages } from '../../src/images/legacy.js';`, add `mkdir` and `writeFile` to the `node:fs/promises` import (the file already imports `readFile` from it), and `import path from 'node:path';` / `import { sql } from 'drizzle-orm';` if the file does not already have them.

**File:** `tests/integration/images.mcp.int.test.ts`
- Lines 1-16 imports: add `import { setImageDeleted } from '../../src/notes/imageRepo.js';` after line 7, and add `addImage,` to the `./imageHarness.js` import list.
- Line 133: `expect(t).toContain('Q-QQQ: no such note');` stays (the new text is `Q-QQQ: no such note or image.`).
- Append inside the `describe` block (before the closing `});` on line 175):
  ```ts
  it('view_images on a note id shows every image in order, each labelled k of n', async () => {
    const { id } = await createFromFile('first.png', await makeImage('png', 30, 20, { r: 10, g: 20, b: 30 }), 'three shots');
    await addImage(h, id, 'S-EC2', 1, { r: 40, g: 50, b: 60 });
    await addImage(h, id, 'T-HR3', 2, { r: 70, g: 80, b: 90 });
    const r = await call('view_images', { ids: [id] });
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(3);
    const t = texts(r).join('\n');
    expect(t).toContain(`image: ${id} (image 1 of 3)`);
    expect(t).toContain('image: S-EC2 (image 2 of 3)');
    expect(t).toContain('image: T-HR3 (image 3 of 3)');
    expect(t.indexOf('S-EC2')).toBeLessThan(t.indexOf('T-HR3'));
  });

  it('view_images takes an image id', async () => {
    const { id } = await createFromFile('host.png', await makeImage('png', 30, 20, { r: 11, g: 21, b: 31 }), 'two shots');
    await addImage(h, id, 'S-EC2', 1, { r: 41, g: 51, b: 61 });
    const r = await call('view_images', { ids: ['s-ec2'] });
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(1);
    const t = texts(r).join('\n');
    expect(t).toContain(`id: ${id}`);
    expect(t).toContain('image: S-EC2 (image 2 of 2)');
  });

  it('view_images returns at most 8 images and lists the image ids it left out', async () => {
    const { id } = await createFromFile('many.png', await makeImage('png', 30, 20, { r: 12, g: 22, b: 32 }), 'ten shots');
    for (let i = 1; i <= 9; i += 1) await addImage(h, id, `M-00${i}`, i, { r: 20 * i, g: 7, b: 200 - 10 * i });
    const r = await call('view_images', { ids: [id] });
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(8);
    const t = texts(r).join('\n');
    expect(t).toContain('image: M-007 (image 8 of 10)');
    expect(t).not.toContain('image: M-008 (');
    expect(t).toContain('M-008, M-009');
    expect(t).toMatch(/call view_images again/i);
  });

  it('view_images says when an image was removed', async () => {
    const { id } = await createFromFile('keep.png', await makeImage('png', 30, 20, { r: 13, g: 23, b: 33 }), 'kept');
    await addImage(h, id, 'R-EM2', 1, { r: 43, g: 53, b: 63 });
    await setImageDeleted(h.deps.db, 'R-EM2', true);
    const r = await call('view_images', { ids: ['R-EM2'] });
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
    expect(texts(r).join('\n')).toContain(`R-EM2: this image was removed from note ${id}`);
  });
  ```
The existing has_image / taken-range test (lines 150-174) keeps working through the reworked `setTakenAt` (it updates `note_images` by note id).

**File:** `tests/integration/api.int.test.ts:168`. Replace with:
```ts
    expect(imageNote?.images[0]).toMatchObject({ id: imageId, mime: 'image/jpeg', available: false });
```

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int`
**Manual check:**
- `grep -rnE "imagePath|imageMeta|image_path|image_meta" src --include='*.ts' | grep -v -e src/db/schema.ts -e src/images/legacy.ts` prints only doc comments (no code).
- `grep -rn "\.image\b" src` prints nothing.
- Optionally run notesd against the Docker DB and `curl -s localhost:7317/api/notes?has_image=true | jq '.notes[0].images'`.

**Exit criteria:** typecheck plus both suites are green. No server code reads `notes.image_path` / `image_meta` except `src/images/legacy.ts`. Every read path returns `images[]`. `has_image` and the taken filters are any-live-image. `view_images` returns every image capped at 8 with an overflow line, and accepts image ids. `/api/notes/:id/:variant` (alias) and `/api/images/:id/:variant` (any state) both serve, and `GET /api/images/:id` returns `NoteImage` JSON. `sameOriginOnly` passes its unit test. The daemon logs the reconcile count at start.

## Handoffs

- **Phase 3 (R1):** `attachImage`, `removeImage`, `restoreImage` in `NotesService` (use the private `toNotes` / async `finish` added here); `attachImage(deps, noteId, input)` in `ingest.ts`, which can reuse `withShaLock`, `placeOriginal`, `unplaceOriginal` and `reuseExisting` (the dedupe holder rule is already per live image); `attachFromUpload` / `attachFromPath` in `imageAccess.ts`; the three routes in `images.ts`; the three MCP tools in `imageTools.ts`, plus their sentence in the instructions "Images." paragraph written here; `src/chat/status.ts`. `ImageNotes` (`Pick<NotesService, ...>`) will need `'attachImage'` if ingest calls it through that type.
- **Phase 4 (R3):** `toNoteImage(row, dataDir)` exists under the name phase 4 already uses. It sets `deleted_at` only on removed rows, so a spread override is harmless. `filterConditions` renders its image subqueries against the unaliased `"note_images"`. If `binRepo` joins `note_images` in an outer query **and** reuses `filterConditions` with `hasImage` / `taken*`, alias the outer copy. (Phase 4's plan says it filters only by tags, so this should not arise.) `NotesService.get(ids, { includeDeleted: true })` keeps the asked order and attaches live images.
- **Phase 3 (R1, reconciled):** phase 3 replaces the inline `insertImage` values object in `create` (Step 3d) with its module helper `imageValues(id, id, image.path, image.meta, 0)`, so the ImageMeta-to-row mapping exists once. Behaviour is identical.
- **Phase 5 (R4):** `locateImage(deps, imageId)` resolves any state. `LocatedImage` keeps `originalPath`, `available`, `host`. `sameOriginOnly` returns 403 `{ error: 'forbidden_origin' }` for a missing or unparseable Origin (`null` included) and never throws. After this phase, `app.ts` imports `isLoopbackUrl` from `./sameOrigin.js` (lines 1-8).
- **Phase 6 (R1):** the web client still reads `Note.image` until phase 6 lands. Against a phase-2 server, the wall shows no photos (`image` is undefined), but it does not crash. Web tests are unaffected (their own `web/src/types.ts`). New URLs: `/api/images/<id>/<variant>`, `GET /api/images/<id>`; `/full/<noteId>` keeps meaning the note's first image through the alias.
- **Phase 10 (R5):** README API table (new image routes and alias), storage section (`cache/<imageId>/`), MCP table (`view_images` takes note or image ids, 8-image cap), SKILL.md images list.
- Drive-by not done: `NotesService.findBySha256` has no `src` caller left (only tests). It is kept, with the new semantics, to avoid churn. A later cleanup may delete it together with its test.

## Rollback

Revert the phase-2 commit. Phase 1's table and repo stay, and nothing else reads them. The legacy columns were never written or altered by this phase, so main's read paths work again as soon as the code is reverted. Images ingested while phase 2 was live exist only in `note_images` (their notes have null legacy columns) and would show as text notes after a revert. Their files stay on disk.
