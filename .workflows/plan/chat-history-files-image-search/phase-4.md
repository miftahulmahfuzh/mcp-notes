# Phase 4: Note files backend: schema, store, service, API, reveal, MCP visibility

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R2: a note can hold any file (sha256 store, extraction-ready schema), agents see each file's name, size and type, and there is a per-file and a note-level reveal. This phase is the server half; P5 builds the UI on top of it.
**Depends on:** Phase 3 (migration 0003 `chat_images` must already exist so this phase's migration is 0004 and the drizzle snapshot chain stays intact)
**Difficulty:** HARD
**Package:** `src/files` (new), `src/notes`, `src/http`, `src/db`, `src/mcp`

---

## Goal

After this phase a live note can hold non-image files. They are stored byte for byte under `files/<noteId>/<safeName>`, deduped by sha256 the same way images are, soft-removed and restored at their old position, and deleted from disk when their note is purged. Every `Note` on the wire (HTTP, MCP, chat agent) carries `files: NoteFile[]`, so Claude can name a note's files even when it cannot read them. Explorer can select one file, or open a note's files folder. Nothing in `web/` changes except an optional type, so the wall looks and behaves the same until P5.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- DB: table `note_files` (migration `drizzle/0004_note_files.sql`, snapshot `drizzle/meta/0004_snapshot.json`, journal entry idx 4, tag `0004_note_files`). Indexes `note_files_path_uniq`, `note_files_note_position_idx`, `note_files_sha256_live_uniq` (partial, `deleted_at is null`). Check constraint `note_files_extraction_status_check`.
- `src/db/schema.ts`: `noteFiles`, `EXTRACTION_STATUSES`, `ExtractionStatus`, `NoteFileRow`, `NewNoteFileRow`.
- `src/notes/fileRepo.ts` (new): `NOTE_FILES_SHA_LIVE_INDEX`, `NOTE_FILES_PATH_INDEX`, `LiveFileHit`, `isLiveFileShaClash`, `isFilePathClash`, `filesForNotes`, `findFileById`, `findLiveFileBySha256`, `filePathTaken`, `insertFile`, `nextFilePosition`, `setFileDeleted`.
- `src/notes/types.ts`: `NoteFile`, `FileMeta`, `ExtractionStatus` (re-export), `fileUrls`, `toNoteFile`, `DuplicateFileError`, `NoteErrorCode` gains `'duplicate_file'`, `Note.files: NoteFile[]`.
- `src/notes/service.ts`: `AttachFileInput`, `NotesService.attachFile`, `NotesService.removeFile`, `NotesService.restoreFile`.
- `src/files/name.ts` (new): `MAX_FILE_NAME_CHARS` (120), `MAX_FILE_NAME_BYTES` (240), `FALLBACK_FILE_NAME`, `sanitizeFileName`, `displayFileName`, `withNameSuffix`, `isSafeFileName`.
- `src/files/mime.ts` (new): `FALLBACK_MIME`, `EXTENSION_MIMES`, `isValidMime`, `detectFileMime`.
- `src/files/store.ts` (new): `FILES_SUBDIR`, `fileRelPath`, `isNoteFileRelPath`, `filesDirFor`, `removeNoteFile`, `removeNoteFolderIfEmpty`.
- `src/files/records.ts` (new): `FileRecord`, `FileRecords`, `dbFileRecords`.
- `src/files/ingest.ts` (new): `MAX_FILE_BYTES` (200 MB), `FileInputError`, `FileNotes`, `FileDeps`, `fileDeps`, `UploadDeps`, `uploadDeps`, `FileInput`, `FileAttachResult`, `UploadAttachResult`, `LocatedFile`, `attachFile`, `attachUpload`, `locateFile`.
- `src/http/files.ts` (new): `fileRoutes`, `FileRouteOptions`, `attachmentDisposition`, `DOWNLOAD_CSP`.
- `src/http/reveal.ts`: `RevealMode`, `NoteRevealPlan`, `noteRevealPlan`.
- `src/mcp/imageTools.ts`: `filesLine`.
- HTTP routes: `POST /api/notes/:id/files`, `DELETE /api/files/:fileId`, `POST /api/files/:fileId/restore`, `GET /api/files/:fileId`, `GET /api/files/:fileId/download`, `POST /api/files/:fileId/reveal`, `POST /api/notes/:id/reveal`.
- `web/src/types.ts`: `NoteFile`, `Note.files?: NoteFile[]` (optional, type only).

**Signature changes:**
- `rowToNote(row, dataDir, images)` -> `rowToNote(row, dataDir, images, files = [])` (new param defaults to `[]`; existing callers compile).
- `explorerArgs(winPath)` -> `explorerArgs(winPath, mode: RevealMode = 'select')`.
- `performReveal(target, reveal)` -> `performReveal(target, reveal, mode: RevealMode = 'select')`.
- `imageRepo.imageIdTaken(db, id)`: same signature, now also checks `note_files.id` (the id space is shared).
- `imageRepo.pgErrorInfo`: was module-private, now exported (fileRepo reuses it).
- `PurgeResult.files` now also counts note files removed from `files/<noteId>/`.

**Wire contract P5 builds on (exact):**
- `NoteFile` = `{ id, note_id, position, name, mime, bytes, host, available, extraction_status, urls: { download }, deleted_at? }`. `name` is the user's file name (control characters removed). `deleted_at` is present only on removed files. `Note.files` holds live files only, ascending `position`.
- `POST /api/notes/:id/files` (multipart field `file`): 201 `{note, attached: true, kind}`, or 200 `{note, attached: false, kind}` when the bytes already live in a note (`note` is the holder, restored if it was deleted). `kind` is `'image'` when the server sniffed a supported image and stored it through `attachImage` (it is then in `note.images`), else `'file'`. Errors: 400 `invalid_id` | `bad_multipart` | `file_required` | `empty_file`; 404 `not_found` (unknown or deleted note); 409 `duplicate_file` | `duplicate_image` (with `note_id`) | `conflict`; 413 `too_large` (with `max_bytes`).
- `DELETE /api/files/:fileId` -> 200 owning `Note`; `POST /api/files/:fileId/restore` -> 200 `Note`, 409 `{error: 'duplicate_file', note_id, message}`; both 404 `not_found`, 400 `invalid_id`.
- `GET /api/files/:fileId` -> `NoteFile` in any state, else 404.
- `GET /api/files/:fileId/download` -> 200 bytes, `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<rfc5987>`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `ETag: "<sha256>"` (304 on match); 404 `not_found` or `{error: 'not_on_this_machine', host}`.
- `POST /api/files/:fileId/reveal` (same origin only) -> Explorer with the file selected. `POST /api/notes/:id/reveal` (same origin only) -> live files: open `files/<noteId>/`; no live files: select the first live image; neither, unknown, malformed or deleted note: 404 `not_found`. Both share today's outcomes: 202 `{ok: true}`, 404 `not_found` / `not_on_this_machine`, 409 `reveal_unavailable`, 500 `spawn_failed`, 403 `forbidden_origin`.

**Requires (from earlier phases):**
- Phase 3 has landed `drizzle/0003_*.sql` and `drizzle/meta/0003_snapshot.json` (journal idx 3) for `chat_images`, and added `chat_images` to `truncateAll`. This phase runs `db:generate` on top of that and expects the generated SQL to contain only `note_files`.
- Phase 3 has added `CHAT_IMAGES_SUBDIR` (`'chat-images'`) to `DATA_SUBDIRS` (`src/daemon.ts`), `'chat-images'` to `tests/integration/imageHarness.ts`'s subdir loop and `reset()`, `startHarness(options: HarnessOptions = {})` with `HarnessOptions { chat?: ChatBackend }`, `check` in the `src/db/schema.ts` pg-core import, the 0003 sentence in the schema header, and `chatImageRoutes` mounted in `src/http/app.ts` after `imageRoutes`. Steps 1, 13, 15 and 17 quote that post-Phase-3 text.

**Leaves alone (owned by others):**
- Every `web/` file except `web/src/types.ts` (P5 owns the UI, `web/src/api.ts`, `RevealButton`, `NoteCard`, `NoteEditor`, `DropOverlay`, `App.tsx`).
- The bin view and `listBin` shape (out of scope: files are not in the bin view in v1).
- `src/images/*` behavior (only read; `attachImage` is called, not changed).
- `chat_images`, `src/chat/images.ts`, `src/http/chatImages.ts` (P3); `similar_images` and embeddings (P6); chat persistence (P7).
- No MCP tool is added (no `attach_file`), so tool-count assertions do not change.

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | `noteFiles` table, `EXTRACTION_STATUSES`, row types, header comment |
| `drizzle/0004_note_files.sql` | create (generated) | `npm run db:generate -- --name note_files` |
| `drizzle/meta/0004_snapshot.json` | create (generated) | same command |
| `drizzle/meta/_journal.json` | modify (generated) | entry idx 4 `0004_note_files` |
| `src/notes/imageRepo.ts` | modify | export `pgErrorInfo`; `imageIdTaken` checks `note_files` |
| `src/notes/fileRepo.ts` | create | data access for `note_files` |
| `src/notes/types.ts` | modify | `NoteFile`, `FileMeta`, `toNoteFile`, `fileUrls`, `DuplicateFileError`, `'duplicate_file'`, `Note.files`, `rowToNote` 4th param |
| `src/notes/service.ts` | modify | `attachFile`, `removeFile`, `restoreFile`, `lockFile`, `purgeNote` removes note files, `toNotes` loads files, `isUniqueViolation` |
| `src/files/name.ts` | create | name sanitiser and suffixing |
| `src/files/mime.ts` | create | mime by magic bytes, extension fallback |
| `src/files/store.ts` | create | safe `files/<noteId>/<name>` paths, removal for purge |
| `src/files/records.ts` | create | raw file lookups used by ingest, download, reveal |
| `src/files/ingest.ts` | create | `attachFile` (dedupe, place, attach), `attachUpload` (image delegation), `locateFile` |
| `src/http/files.ts` | create | the five file routes |
| `src/http/app.ts` | modify | mount `fileRoutes` after `imageRoutes` |
| `src/http/reveal.ts` | modify | `RevealMode`, `explorerArgs`/`performReveal` mode, `noteRevealPlan`, two routes |
| `src/daemon.ts` | modify | `files` in `DATA_SUBDIRS` |
| `src/mcp/imageTools.ts` | modify | `filesLine`; `describeNote`/`describeImage` list files |
| `src/mcp/instructions.ts` | modify | Notes paragraph mentions `files`; new `Files.` paragraph |
| `src/chat/prompt.ts` | modify | one sentence about files |
| `claude/skills/n/SKILL.md` | modify | files in "What a note is"; new "Files" section |
| `web/src/types.ts` | modify | `NoteFile`; `Note.files?` (type only) |
| `tests/integration/setup.ts` | modify | `note_files` in `truncateAll` |
| `tests/integration/imageHarness.ts` | modify | create and reset `files/` in the temp data dir |
| `tests/helpers/fakeNotes.ts` | modify | fake `Note` gets `files: []` |
| `tests/unit/notes.helpers.test.ts` | modify | `files: []` in the expected wire note; `toNoteFile` tests |
| `tests/unit/reveal.test.ts` | modify | open mode of `explorerArgs` / `performReveal` |
| `tests/unit/mcp.instructions.test.ts` | modify | Files paragraph |
| `tests/unit/chat-prompt.test.ts` | modify | files sentence |
| `tests/unit/files.name.test.ts` | create | sanitiser, suffix, display name, safe-name check |
| `tests/unit/files.store.test.ts` | create | safe paths, removal, mime, Content-Disposition |
| `tests/unit/mcp.describe.test.ts` | create | `describeNote`/`describeImage` files line |
| `tests/integration/files.int.test.ts` | create | attach, dedupe, delegate, errors, remove/restore, download, purge, ids |
| `tests/integration/files.reveal.int.test.ts` | create | per-file and note-level reveal with fake `RevealDeps` |
| `tests/integration/files.mcp.int.test.ts` | create | MCP `get`/`list`/`view_images` show files |
| `tests/integration/migration0004.int.test.ts` | create | 0004 on a 0003-shaped database |
| `README.md` | modify | HTTP API rows, storage layout |
| `CHANGELOG.md` | modify | one line under Unreleased |

## Implementation Steps

Setup for the session (Invariant 10): in the worktree run `npm ci` if `node_modules` is missing and `ln -s ~/mcp-notes/.env.local .env.local` if it is missing (`drizzle.config.ts` throws without a direct URL; `db:generate` does not connect, it only needs the config to load).

Line numbers below are from `main` @ `d3ef659`. Phase 3 edits `src/db/schema.ts`, `src/daemon.ts`, `tests/integration/setup.ts` and `tests/integration/imageHarness.ts` first, so anchor each edit on the symbol named, not on the number.

### Step 1: `note_files` in the schema
**File:** `src/db/schema.ts` header comment (as Phase 3 left it), new table after `noteImages` (ends `:121` on main), row types after `NewNoteImageRow`
**Change:** the table and its row types, and one sentence in the header comment. The pg-core import already has `check` (Phase 3 added it), so the import line does not change:
```ts
import { bigserial, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core'
```

Replace the whole header comment (Phase 3's text, with the 0004 sentence added before `Change a table here`):
```ts
/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`; migration 0002 (iteration 7, wall editing) adds `note_images` and copies every
 * legacy `notes.image_path` / `image_meta` image into it (hand-appended INSERT...SELECT, the same
 * SQL as src/images/legacy.ts `LEGACY_COPY_SQL`); migration 0003 (chat images) adds
 * `chat_images`, the images pasted into a chat; migration 0004 (note files) adds `note_files`:
 * non-image files attached to a note, stored under `files/<noteId>/<safeName>`, with
 * `extracted_text` / `extraction_status` ready for a later text extraction (v1 writes only
 * 'none'). Change a table here, then `npm run db:generate`; never edit an applied migration.
 * drizzle-kit does not emit `CREATE EXTENSION`, so 0001 carries a hand-prepended
 * `CREATE EXTENSION IF NOT EXISTS vector`.
 */
```

New block directly after the `noteImages` table:
```ts
/** `note_files.extraction_status`. v1 writes only 'none'; a later text extraction moves rows through the others. */
export const EXTRACTION_STATUSES = ['none', 'pending', 'done', 'failed', 'unsupported'] as const
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

/**
 * One row per non-image file of a note (migration 0004). Mirrors `note_images`: the id is in the
 * note-id format and free in `notes`, `note_images` and `note_files` alike (src/notes/imageRepo.ts
 * `imageIdTaken`); `position` is attach order, never renumbered; `deleted_at` is the file's own
 * soft delete (removed from its note), independent of `notes.deleted_at`; sha256 is unique among
 * rows with `deleted_at is null`. Files that sniff as a supported image are stored as images,
 * never here. `path` is `files/<noteId>/<safeName>` (src/files/store.ts), so one folder holds
 * all of a note's files. `extracted_text` stays null and `extraction_status` 'none' until text
 * extraction exists.
 */
export const noteFiles = pgTable(
  'note_files',
  {
    /** Note-id format (`A-B32`). */
    id: text('id').primaryKey(),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** Relative to the data dir: `files/<noteId>/<safeName>`. */
    path: text('path').notNull(),
    /** Lower-case hex sha256 of the bytes. */
    sha256: text('sha256').notNull(),
    /** Magic bytes first, then the extension, else application/octet-stream (src/files/mime.ts). */
    mime: text('mime').notNull(),
    /** Size in bytes; the 200 MB upload cap fits int4. */
    bytes: integer('bytes').notNull(),
    /** The name the user's file had (control characters removed). Shown in the UI and downloads. */
    originalName: text('original_name').notNull(),
    /** `os.hostname()` of the machine that holds the file. */
    host: text('host'),
    /** Attach order within the note; never renumbered (remove + restore keeps it). */
    position: integer('position').notNull(),
    /** Plain text pulled out of the file by a later extraction. Always null in v1. */
    extractedText: text('extracted_text'),
    extractionStatus: text('extraction_status').$type<ExtractionStatus>().notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Removed from its note. Null means part of the note. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('note_files_path_uniq').on(t.path),
    index('note_files_note_position_idx').on(t.noteId, t.position),
    uniqueIndex('note_files_sha256_live_uniq').on(t.sha256).where(sql`${t.deletedAt} is null`),
    check('note_files_extraction_status_check', sql`extraction_status in ('none', 'pending', 'done', 'failed', 'unsupported')`),
  ],
)
```

Row types, after `NewNoteImageRow`:
```ts
export type NoteFileRow = typeof noteFiles.$inferSelect
export type NewNoteFileRow = typeof noteFiles.$inferInsert
```
**Impact:** schema only; nothing reads it until Step 2.

### Step 2: Generate migration 0004
**File:** `drizzle/0004_note_files.sql`, `drizzle/meta/0004_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** run, from the worktree root:
```bash
npm run db:generate -- --name note_files
```
Then check what it wrote, and never hand-edit it:
```bash
cat drizzle/0004_note_files.sql
grep -c '"tag": "0004_note_files"' drizzle/meta/_journal.json   # 1
grep -E 'chat_images|note_images|notes"' drizzle/0004_note_files.sql | grep -v 'REFERENCES "public"."notes"'   # no output
```
Expected content (drizzle-kit 0.31 formatting; statement order may differ):
```sql
CREATE TABLE "note_files" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"original_name" text NOT NULL,
	"host" text,
	"position" integer NOT NULL,
	"extracted_text" text,
	"extraction_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "note_files_extraction_status_check" CHECK (extraction_status in ('none', 'pending', 'done', 'failed', 'unsupported'))
);
--> statement-breakpoint
ALTER TABLE "note_files" ADD CONSTRAINT "note_files_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_files_path_uniq" ON "note_files" USING btree ("path");--> statement-breakpoint
CREATE INDEX "note_files_note_position_idx" ON "note_files" USING btree ("note_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "note_files_sha256_live_uniq" ON "note_files" USING btree ("sha256") WHERE "note_files"."deleted_at" is null;
```
If the generated file contains anything for `chat_images` or other tables, Phase 3's snapshot is missing or stale: stop and fix the chain (do not edit the SQL). If the file is named `0003_*`, Phase 3 has not landed: stop.
**Impact:** `migrateTestDb` (globalSetup) and the daemon's `db:migrate` now create `note_files`.

### Step 3: Shared id space and the error helper
**File:** `src/notes/imageRepo.ts:2`, `:27`, `:132-139`
**Change:** import `noteFiles`; export `pgErrorInfo`; `imageIdTaken` checks the third table.

Import line:
```ts
import { noteFiles, noteImages, notes, type NewNoteImageRow, type NoteImageRow } from '../db/schema.js';
```
`:20-43` becomes (only `export` added to the interface and the function):
```ts
export interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
  message: string;
}

/** First object in the `cause` chain that carries a string `code` (pg DatabaseError, wrapped by Drizzle). */
export function pgErrorInfo(err: unknown): PgErrorInfo | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') {
      const constraint = (cur as { constraint?: unknown }).constraint;
      const message = (cur as { message?: unknown }).message;
      return {
        code,
        constraint: typeof constraint === 'string' ? constraint : undefined,
        message: typeof message === 'string' ? message : '',
      };
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
```
`:132-139` becomes:
```ts
/**
 * True when `id` is already used as a note id, an image id or a file id (any state). The three
 * share the `A-B32` space, so newId() and every insert check all of them.
 */
export async function imageIdTaken(db: Executor, id: string): Promise<boolean> {
  const res = await db.execute<{ taken: boolean }>(
    sql`select (exists (select 1 from ${notes} where ${notes.id} = ${id})
             or exists (select 1 from ${noteImages} where ${noteImages.id} = ${id})
             or exists (select 1 from ${noteFiles} where ${noteFiles.id} = ${id})) as taken`,
  );
  return res.rows[0]?.taken === true;
}
```
**Impact:** `NotesService.newId`, `create` and `attachImage` now never hand out or accept an id a file holds.

### Step 4: `fileRepo`
**File:** `src/notes/fileRepo.ts` (new)
**Code:**
```ts
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { noteFiles, notes, type NewNoteFileRow, type NoteFileRow } from '../db/schema.js';
import { pgErrorInfo } from './imageRepo.js';
import type { Executor } from './repo.js';
import { NoteError } from './types.js';

/**
 * Data access for `note_files` (plan phase 4). The same shape as imageRepo: the service is the
 * only writer, and every write runs inside its transaction after the owning note is locked.
 */

/** Partial unique index: sha256 is unique among live (non-removed) files. */
export const NOTE_FILES_SHA_LIVE_INDEX = 'note_files_sha256_live_uniq';
/** Unique index on `path`: one row per stored file name, whatever its state. */
export const NOTE_FILES_PATH_INDEX = 'note_files_path_uniq';

/** A live file found by sha256, with its note's soft-delete time (null = note is live). */
export interface LiveFileHit {
  file: NoteFileRow;
  noteDeletedAt: Date | null;
}

function isUniqueViolationOf(err: unknown, index: string): boolean {
  const info = pgErrorInfo(err);
  if (!info || info.code !== '23505') return false;
  if (info.constraint !== undefined) return info.constraint === index;
  return info.message.includes(index);
}

/** A 23505 on `note_files_sha256_live_uniq`: the bytes already live in another file. */
export function isLiveFileShaClash(err: unknown): boolean {
  return isUniqueViolationOf(err, NOTE_FILES_SHA_LIVE_INDEX);
}

/** A 23505 on `note_files_path_uniq`: another row (maybe from another host) took the name. */
export function isFilePathClash(err: unknown): boolean {
  return isUniqueViolationOf(err, NOTE_FILES_PATH_INDEX);
}

/**
 * Files of the given notes, keyed by note id, each list ordered by position (then id). Every
 * distinct requested id is a key; a note without files maps to []. Removed files are left out
 * unless `includeRemoved` is true.
 */
export async function filesForNotes(
  db: Executor,
  noteIds: readonly string[],
  opts: { includeRemoved?: boolean } = {},
): Promise<Map<string, NoteFileRow[]>> {
  const ids = [...new Set(noteIds)];
  const out = new Map<string, NoteFileRow[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  const conds: SQL[] = [inArray(noteFiles.noteId, ids)];
  if (!opts.includeRemoved) conds.push(isNull(noteFiles.deletedAt));
  const rows = await db
    .select()
    .from(noteFiles)
    .where(and(...conds))
    .orderBy(asc(noteFiles.noteId), asc(noteFiles.position), asc(noteFiles.id));
  for (const row of rows) out.get(row.noteId)?.push(row);
  return out;
}

/** One file in any state (live, removed, or in a deleted note), or null. */
export async function findFileById(db: Executor, id: string): Promise<NoteFileRow | null> {
  const rows = await db.select().from(noteFiles).where(eq(noteFiles.id, id)).limit(1);
  return rows[0] ?? null;
}

/** The non-removed file holding these bytes (at most one), with its note's deleted_at, or null. */
export async function findLiveFileBySha256(db: Executor, sha256: string): Promise<LiveFileHit | null> {
  const rows = await db
    .select({ file: noteFiles, noteDeletedAt: notes.deletedAt })
    .from(noteFiles)
    .innerJoin(notes, eq(notes.id, noteFiles.noteId))
    .where(and(eq(noteFiles.sha256, sha256), isNull(noteFiles.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { file: row.file, noteDeletedAt: row.noteDeletedAt } : null;
}

/** True when any row (any state, any host) already uses this data-dir-relative path. */
export async function filePathTaken(db: Executor, path: string): Promise<boolean> {
  const rows = await db.select({ id: noteFiles.id }).from(noteFiles).where(eq(noteFiles.path, path)).limit(1);
  return rows.length > 0;
}

/**
 * Inserts one file row and returns it. A live-sha256 clash throws NoteError('duplicate_file');
 * a path clash throws NoteError('conflict') so the caller retries with the next free name. Any
 * other error is rethrown. Inside a transaction a failed insert aborts that transaction.
 */
export async function insertFile(db: Executor, values: NewNoteFileRow): Promise<NoteFileRow> {
  let rows: NoteFileRow[];
  try {
    rows = await db.insert(noteFiles).values(values).returning();
  } catch (err) {
    if (isLiveFileShaClash(err)) {
      throw new NoteError('duplicate_file', 'A live file with the same sha256 already exists.');
    }
    if (isFilePathClash(err)) {
      throw new NoteError('conflict', `The file name ${values.path} was just taken.`);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw new Error(`insertFile: no row returned for file ${values.id}`);
  return row;
}

/** Position for the next file attached to `noteId`: max over all its file rows (removed included) + 1, or 0. */
export async function nextFilePosition(db: Executor, noteId: string): Promise<number> {
  const rows = await db
    .select({ next: sql<number>`coalesce(max(${noteFiles.position}) + 1, 0)::int` })
    .from(noteFiles)
    .where(eq(noteFiles.noteId, noteId));
  return Number(rows[0]?.next ?? 0);
}

/**
 * Removes (`deleted: true`) or restores (`false`) one file and returns the updated row. Removing
 * is idempotent and keeps the first removal time. Unknown id -> NoteError('not_found'); restoring
 * while another live file holds the same bytes -> NoteError('duplicate_file'). The note is not touched.
 */
export async function setFileDeleted(db: Executor, id: string, deleted: boolean): Promise<NoteFileRow> {
  let rows: NoteFileRow[];
  try {
    rows = await db
      .update(noteFiles)
      .set({ deletedAt: deleted ? sql`coalesce(${noteFiles.deletedAt}, now())` : null })
      .where(eq(noteFiles.id, id))
      .returning();
  } catch (err) {
    if (isLiveFileShaClash(err)) {
      throw new NoteError('duplicate_file', `Another live file already holds the same bytes as file ${id}.`);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `File ${id} does not exist.`);
  return row;
}
```
**Impact:** none until the service uses it.

### Step 5: Wire types
**File:** `src/notes/types.ts:3` (import), after `NoteImage` (`:38`), `Note` (`:41-51`), `PurgeResult` (`:117-123`), `NoteErrorCode` (`:125-135`), after `DuplicateImageError` (`:160`), after `toNoteImage` (`:218`), `rowToNote` (`:220-237`)
**Change:**

Import (`:3`) becomes:
```ts
import type { ExtractionStatus, NoteFileRow, NoteImageRow, notes } from '../db/schema.js';
```
After the `ImageMeta` re-export (`:15`) add:
```ts
/** Where a file's text extraction stands. v1 only ever writes 'none'. */
export type { ExtractionStatus } from '../db/schema.js';
```
After the `NoteImage` interface add:
```ts
/** What ingest knows about one non-image file before it becomes a `note_files` row. */
export interface FileMeta {
  /** Lower-case hex sha256 of the bytes. */
  sha256: string;
  mime: string;
  bytes: number;
  /** The user's file name, control characters removed (src/files/name.ts displayFileName). */
  original_name: string;
  /** `os.hostname()` of the machine that stored it. */
  host: string | null;
}

/** One non-image file of a note, as MCP, HTTP and the UI see it (plan phase 4). */
export interface NoteFile {
  /** File id, note-id format; never equal to any note or image id. */
  id: string;
  note_id: string;
  /** Attach order within the note; never renumbered. */
  position: number;
  /** The user's file name. The stored name may differ (Windows-safe, collision-suffixed). */
  name: string;
  mime: string;
  bytes: number;
  host: string | null;
  /** The file exists under this machine's data dir. */
  available: boolean;
  /** Always 'none' in v1: nobody has read the file's text. */
  extraction_status: ExtractionStatus;
  /** `/api/files/<id>/download`: always served as an attachment. */
  urls: { download: string };
  /** Present only on removed files. */
  deleted_at?: string;
}
```
`Note` gains, after `images`:
```ts
  /** The note's live files (file deleted_at is null), ascending position. Empty when it has none. */
  files: NoteFile[];
```
`PurgeResult.files` doc becomes:
```ts
  /** Files removed from disk: image originals, derived files under cache/<imageId>/, and the note's files under files/<noteId>/. */
  files: number;
```
`NoteErrorCode` becomes:
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
  | 'duplicate_file'
  | 'invalid_revision'
  | 'not_embedded';
```
After `DuplicateImageError`:
```ts
/**
 * restoreFile refused: the same bytes already live in another file. `noteId` is the note holding
 * them (HTTP answers 409 { error: 'duplicate_file', note_id }).
 */
export class DuplicateFileError extends NoteError {
  readonly noteId: string;

  constructor(noteId: string, message: string) {
    super('duplicate_file', message);
    this.name = 'DuplicateFileError';
    this.noteId = noteId;
  }
}
```
After `toNoteImage`:
```ts
/** The served URL of one file, by file id. */
export function fileUrls(fileId: string): NoteFile['urls'] {
  return { download: `/api/files/${fileId}/download` };
}

/** `note_files` row -> wire NoteFile. `deleted_at` is present only on removed files. */
export function toNoteFile(row: NoteFileRow, dataDir: string): NoteFile {
  const file: NoteFile = {
    id: row.id,
    note_id: row.noteId,
    position: row.position,
    name: row.originalName,
    mime: row.mime,
    bytes: row.bytes,
    host: row.host,
    available: imageAvailable(dataDir, row.path),
    extraction_status: row.extractionStatus,
    urls: fileUrls(row.id),
  };
  if (row.deletedAt !== null) file.deleted_at = toIso(row.deletedAt);
  return file;
}
```
`rowToNote` (`:220-237`) becomes:
```ts
/**
 * DB row + its image and file rows -> wire Note. Only live images and files (deleted_at null)
 * are kept, each in position order. `deleted_at` is present only on deleted notes.
 */
export function rowToNote(
  row: NoteRow,
  dataDir: string,
  images: readonly NoteImageRow[],
  files: readonly NoteFileRow[] = [],
): Note {
  const live = images.filter((i) => i.deletedAt === null).sort((a, b) => a.position - b.position);
  const liveFiles = files.filter((f) => f.deletedAt === null).sort((a, b) => a.position - b.position);
  const note: Note = {
    id: row.id,
    body: row.body,
    tags: row.tags,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    origin: cleanOrigin(row.origin),
    images: live.map((i) => toNoteImage(i, dataDir)),
    files: liveFiles.map((f) => toNoteFile(f, dataDir)),
  };
  if (row.deletedAt !== null) note.deleted_at = toIso(row.deletedAt);
  return note;
}
```
**Impact:** every `Note` literal in `src/` and `tests/` must carry `files`. Inside `src/` only `rowToNote` builds one; in `tests/` only `tests/helpers/fakeNotes.ts` (Step 17). `imageAvailable` is reused as is (it is a generic "path inside dataDir exists" check).

### Step 6: Name sanitiser
**File:** `src/files/name.ts` (new)
**Code:**
```ts
import path from 'node:path';

/** Longest stored file name, in code points (the extension is kept when cutting). */
export const MAX_FILE_NAME_CHARS = 120;
/** And in UTF-8 bytes, so a suffix like " (12)" still fits the 255-byte limit of ext4 and NTFS. */
export const MAX_FILE_NAME_BYTES = 240;
/** Used when nothing usable is left of the user's name. */
export const FALLBACK_FILE_NAME = 'file';

/** Longest extension (with its dot) kept apart from the stem; anything longer is part of the stem. */
const MAX_EXT_CHARS = 17;
/** Longest display name kept, in code points. */
const MAX_DISPLAY_CHARS = 255;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const WINDOWS_FORBIDDEN = /[\/\\:*?"<>|]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
const UNSAFE = /[\u0000-\u001f\u007f\/\\:*?"<>|]/;

function codePoints(s: string): string[] {
  return Array.from(s);
}

function fits(name: string): boolean {
  return codePoints(name).length <= MAX_FILE_NAME_CHARS && Buffer.byteLength(name, 'utf8') <= MAX_FILE_NAME_BYTES;
}

/** The last segment of a path, whichever separator the client used. */
function baseName(raw: string | null | undefined): string {
  return (raw ?? '').split(/[\\/]/).pop() ?? '';
}

/** `{stem, ext}` with `ext` including its dot; `.env` and over-long extensions have no ext. */
function splitExt(name: string): { stem: string; ext: string } {
  const ext = path.posix.extname(name);
  if (ext === '' || ext.length > MAX_EXT_CHARS) return { stem: name, ext: '' };
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/** Cuts `stem` by code points until `stem + ext` fits; an emptied stem becomes FALLBACK_FILE_NAME. */
function cut(stem: string, ext: string): string {
  const chars = codePoints(stem);
  while (chars.length > 0 && !fits(chars.join('') + ext)) chars.pop();
  const kept = chars.join('').replace(/[. ]+$/, '');
  return (kept === '' ? FALLBACK_FILE_NAME : kept) + ext;
}

/**
 * The name a file is stored under in `files/<noteId>/`: the basename only, NFC, control
 * characters dropped, Windows-forbidden characters (`/\:*?"<>|`) replaced by `_`, surrounding
 * spaces and trailing dots/spaces removed (Windows drops them), a Windows reserved device name
 * (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an extension) prefixed with `_`, and at
 * most MAX_FILE_NAME_CHARS code points / MAX_FILE_NAME_BYTES bytes with the extension kept.
 * Never empty, never `.` or `..`, never contains a separator.
 */
export function sanitizeFileName(raw: string | null | undefined): string {
  let name = baseName(raw)
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(WINDOWS_FORBIDDEN, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (name === '') name = FALLBACK_FILE_NAME;
  const firstSegment = name.split('.')[0]?.trim() ?? '';
  if (WINDOWS_RESERVED.test(firstSegment)) name = `_${name}`;
  if (!fits(name)) {
    const { stem, ext } = splitExt(name);
    name = cut(stem, ext);
  }
  return name;
}

/**
 * The name shown to people and put in Content-Disposition: the user's basename, NFC, control
 * characters removed, at most 255 code points. Falls back to the stored safe name.
 */
export function displayFileName(raw: string | null | undefined, safeName: string): string {
  const clean = baseName(raw).normalize('NFC').replace(CONTROL, '').trim();
  const kept = codePoints(clean).slice(0, MAX_DISPLAY_CHARS).join('');
  return kept === '' ? safeName : kept;
}

/** The k-th candidate for a name: k <= 1 is the name itself, then `stem (k).ext` (`notes (2).txt`). */
export function withNameSuffix(name: string, k: number): string {
  if (k <= 1) return name;
  const { stem, ext } = splitExt(name);
  return `${stem} (${k})${ext}`;
}

/** True for a single, Windows-safe path segment (what sanitizeFileName and withNameSuffix produce). */
export function isSafeFileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (UNSAFE.test(name)) return false;
  return Buffer.byteLength(name, 'utf8') <= 255;
}
```
**Impact:** pure functions; unit tested in Step 22.

### Step 7: Mime detection
**File:** `src/files/mime.ts` (new)
**Code:**
```ts
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';

/** Stored when neither the bytes nor the extension say what a file is. */
export const FALLBACK_MIME = 'application/octet-stream';

/**
 * Extension fallback for text-like formats magic bytes cannot identify. Raster image extensions
 * are deliberately absent: bytes that really are a supported image never reach the file store
 * (they are stored as images), so a `.png` that lands here is not a PNG.
 */
export const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/x-python',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  sh: 'application/x-sh',
  sql: 'application/sql',
  svg: 'image/svg+xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  rtf: 'application/rtf',
  srt: 'text/plain',
  vtt: 'text/vtt',
};

const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** True for a bare `type/subtype` safe to put in a Content-Type header. */
export function isValidMime(mime: string): boolean {
  return MIME_SHAPE.test(mime);
}

/** Magic bytes first (file-type), then the name's extension, else FALLBACK_MIME. */
export async function detectFileMime(bytes: Uint8Array, name: string): Promise<string> {
  const sniffed = await fileTypeFromBuffer(bytes);
  if (sniffed !== undefined && isValidMime(sniffed.mime)) return sniffed.mime;
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXTENSION_MIMES[ext] ?? FALLBACK_MIME;
}
```
**Impact:** none outside ingest.

### Step 8: Safe paths and purge-time removal
**File:** `src/files/store.ts` (new)
**Code:**
```ts
import { lstat, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveInDataDir } from '../images/store.js';
import { isValidId } from '../notes/ids.js';
import { isSafeFileName } from './name.js';

/** Data-dir subfolder holding one folder per note that has files. */
export const FILES_SUBDIR = 'files';

function requireCanonicalNoteId(noteId: string): string {
  if (!isValidId(noteId)) throw new Error(`not a canonical note id: ${JSON.stringify(noteId)}`);
  return noteId;
}

/** `files/<noteId>/<safeName>`, forward slashes. Throws on a non-canonical id or an unsafe name. */
export function fileRelPath(noteId: string, safeName: string): string {
  requireCanonicalNoteId(noteId);
  if (!isSafeFileName(safeName)) throw new Error(`unsafe file name: ${JSON.stringify(safeName)}`);
  return `${FILES_SUBDIR}/${noteId}/${safeName}`;
}

/** True when `rel` is exactly `files/<noteId>/<one safe segment>`. */
export function isNoteFileRelPath(noteId: string, rel: string): boolean {
  if (!isValidId(noteId)) return false;
  const prefix = `${FILES_SUBDIR}/${noteId}/`;
  if (!rel.startsWith(prefix)) return false;
  return isSafeFileName(rel.slice(prefix.length));
}

/** Absolute `<dataDir>/files/<noteId>`: the folder the note-level reveal opens. */
export function filesDirFor(dataDir: string, noteId: string): string {
  requireCanonicalNoteId(noteId);
  return resolveInDataDir(dataDir, `${FILES_SUBDIR}/${noteId}`);
}

/**
 * Delete forever, on disk, one file of a purged note. Touches `rel` only when it is exactly
 * `files/<noteId>/<safe name>` and is a regular file or a symlink (never a directory). Returns
 * 1 when something was removed, 0 when it was missing or refused. Other errors propagate (the
 * service logs them and carries on).
 */
export async function removeNoteFile(dataDir: string, noteId: string, rel: string): Promise<number> {
  if (!isNoteFileRelPath(noteId, rel)) return 0;
  const dir = filesDirFor(dataDir, noteId);
  const abs = resolveInDataDir(dataDir, rel);
  if (path.dirname(abs) !== dir) return 0;
  try {
    const st = await lstat(abs);
    if (!st.isFile() && !st.isSymbolicLink()) return 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  await rm(abs, { force: true });
  return 1;
}

/** Removes `files/<noteId>/` when it is empty. False when it is missing, not empty or not a folder. */
export async function removeNoteFolderIfEmpty(dataDir: string, noteId: string): Promise<boolean> {
  const dir = filesDirFor(dataDir, noteId);
  try {
    await rmdir(dir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return false;
    throw err;
  }
}
```
**Impact:** none outside service/ingest/reveal.

### Step 9: Raw file records
**File:** `src/files/records.ts` (new)
**Code:**
```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { noteFiles, notes, type NoteFileRow } from '../db/schema.js';
import { filePathTaken, findLiveFileBySha256 } from '../notes/fileRepo.js';
import { normalizeId } from '../notes/ids.js';

/** Raw storage fields of one file (not a wire shape). */
export type FileRecord = {
  id: string;
  note_id: string;
  /** Relative to the data dir: files/<noteId>/<safeName>. */
  path: string;
  sha256: string;
  mime: string;
  bytes: number;
  original_name: string;
  host: string | null;
  position: number;
  /** ISO string when the file was removed from its note, else null. */
  deleted_at: string | null;
  /** ISO string when the owning note is soft-deleted, else null. */
  note_deleted_at: string | null;
};

export interface FileRecords {
  /** The file with these bytes and deleted_at null (at most one; its note may be deleted), else null. */
  bySha256Live(sha256: string): Promise<FileRecord | null>;
  /** Case/dash-tolerant file id; any state; null when unknown. */
  byFileId(id: string): Promise<FileRecord | null>;
  /** True when any row already uses this data-dir-relative path. */
  pathTaken(rel: string): Promise<boolean>;
}

function toRecord(row: NoteFileRow, noteDeletedAt: Date | null): FileRecord {
  return {
    id: row.id,
    note_id: row.noteId,
    path: row.path,
    sha256: row.sha256,
    mime: row.mime,
    bytes: row.bytes,
    original_name: row.originalName,
    host: row.host,
    position: row.position,
    deleted_at: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    note_deleted_at: noteDeletedAt === null ? null : noteDeletedAt.toISOString(),
  };
}

export function dbFileRecords(db: Db): FileRecords {
  return {
    async bySha256Live(sha256) {
      const hit = await findLiveFileBySha256(db, sha256);
      return hit ? toRecord(hit.file, hit.noteDeletedAt) : null;
    },
    async byFileId(input) {
      const id = normalizeId(input);
      if (id === null) return null;
      const rows = await db
        .select({ file: noteFiles, noteDeletedAt: notes.deletedAt })
        .from(noteFiles)
        .innerJoin(notes, eq(notes.id, noteFiles.noteId))
        .where(eq(noteFiles.id, id))
        .limit(1);
      const r = rows[0];
      return r ? toRecord(r.file, r.noteDeletedAt) : null;
    },
    async pathTaken(rel) {
      return filePathTaken(db, rel);
    },
  };
}
```

### Step 10: Service writers, file loading and purge
**File:** `src/notes/service.ts` — imports (`:1-43`), after `AttachImageInput` (`:78`), `newId` doc (`:151`), after `restoreImage` (`:507`), `purgeNote` (`:523-549`), after `removeFiles` (`:598`), after `requireImageId` (`:635`), after `lockImage` (`:650`), `toNotes` (`:662-667`), after `imageValues` (`:706`), after `imageNotFound` (`:710`), `isUniqueViolation` (`:712-721`)
**Change:**

Imports: add these lines next to their siblings.
```ts
import type { NoteFileRow, NoteImageRow } from '../db/schema.js';
import { isNoteFileRelPath, removeNoteFile, removeNoteFolderIfEmpty } from '../files/store.js';
import * as fileRepo from './fileRepo.js';
```
(the first replaces `import type { NoteImageRow } from '../db/schema.js';`), and extend the `./types.js` import list with `DuplicateFileError` and `type FileMeta`.

After `AttachImageInput`:
```ts
/** One file to add to a live note. `id` comes from newId(); `path` is `files/<noteId>/<safeName>` (src/files/store.ts fileRelPath). */
export interface AttachFileInput {
  id: string;
  path: string;
  meta: FileMeta;
}
```
`newId` doc comment becomes:
```ts
  /** An id no note, image or file (live or deleted) currently has. A note's first image takes the note's id. */
```
After `restoreImage`, three new public methods:
```ts
  /**
   * Adds one non-image file to a live note, after every file it ever had (position = max over
   * all its file rows, removed included, + 1). `path` must be `files/<noteId>/<safe name>` ->
   * else NoteError('invalid_input'). The same bytes live in another file -> NoteError('duplicate_file');
   * a taken id or path -> NoteError('conflict'); a deleted note -> NoteError('deleted'). Emits `updated`.
   */
  async attachFile(noteIdInput: string, input: AttachFileInput): Promise<Note> {
    const noteId = this.requireId(noteIdInput);
    const fileId = this.requireFileId(input.id);
    if (!isNoteFileRelPath(noteId, input.path)) {
      throw new NoteError('invalid_input', `File path ${input.path} is not inside files/${noteId}/.`);
    }
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      await this.lockLive(tx, noteId);
      if (await imageRepo.imageIdTaken(tx, fileId)) {
        throw new NoteError('conflict', `File id ${fileId} is already taken.`);
      }
      const position = await fileRepo.nextFilePosition(tx, noteId);
      await fileRepo.insertFile(tx, fileValues(noteId, fileId, input.path, input.meta, position));
      return { row: await repo.touchNote(tx, noteId), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Soft-removes one file from its note (the bytes stay on disk; position is kept for restore).
   * Works whatever state the note is in. Removing a removed file is a no-op. Returns the owning
   * note. Emits `updated` with the note id.
   */
  async removeFile(fileIdInput: string): Promise<Note> {
    const fileId = this.requireFileId(fileIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, file } = await this.lockFile(tx, fileId);
      if (file.deletedAt !== null) return { row: note, op: null };
      await fileRepo.setFileDeleted(tx, fileId, true);
      return { row: await repo.touchNote(tx, note.id), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Puts a removed file back at its old position, and restores its note when the note is
   * deleted. The same bytes already live in another file -> DuplicateFileError naming that
   * file's note. A live file in a live note is a no-op. Emits `restored` when the note came back,
   * else `updated`, with the note id.
   */
  async restoreFile(fileIdInput: string): Promise<Note> {
    const fileId = this.requireFileId(fileIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, file } = await this.lockFile(tx, fileId);
      const fileRemoved = file.deletedAt !== null;
      const noteDeleted = note.deletedAt !== null;
      if (!fileRemoved && !noteDeleted) return { row: note, op: null };
      if (fileRemoved) {
        const holder = await fileRepo.findLiveFileBySha256(tx, file.sha256);
        if (holder !== null && holder.file.id !== file.id) {
          throw new DuplicateFileError(
            holder.file.noteId,
            `File ${fileId} cannot be restored: the same file is already in note ${holder.file.noteId}. Open that note instead, or remove the file there first.`,
          );
        }
        try {
          await fileRepo.setFileDeleted(tx, fileId, false);
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new NoteError(
              'duplicate_file',
              `File ${fileId} cannot be restored: the same file was just saved in another note. Try again to see which.`,
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
`purgeNote` (whole method, `:523-549`) becomes:
```ts
  /**
   * Delete forever: only a deleted note. Removes the notes row (images, files, revisions and
   * embeddings cascade) in one transaction, then, on disk, the original and derived files of
   * every image the note held and every file under files/<noteId>/ that one of its file rows
   * names, removed ones included, then that folder if it is empty. A file that cannot be removed
   * is logged, never fails the purge. UI-only: no MCP tool calls this.
   */
  async purgeNote(idInput: string): Promise<PurgeResult> {
    const id = this.requireId(idInput);
    type Target = { id: string; path: string };
    const targets = await this.db.transaction(async (tx): Promise<{ images: Target[]; files: Target[] }> => {
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt === null) {
        throw new NoteError('not_deleted', `Note ${id} is not deleted. Only notes in the bin can be deleted forever.`);
      }
      const rows = (await imageRepo.imagesForNotes(tx, [id], { includeRemoved: true })).get(id) ?? [];
      const images = rows.map((img) => ({ id: img.id, path: img.path }));
      // The legacy column names a file too; after the reconcile it is the same path as the
      // note's first image row, so this only adds something if that row is somehow missing.
      if (cur.imagePath !== null && !images.some((f) => f.path === cur.imagePath)) {
        images.push({ id, path: cur.imagePath });
      }
      const fileRows = (await fileRepo.filesForNotes(tx, [id], { includeRemoved: true })).get(id) ?? [];
      await bin.deleteNoteRow(tx, id);
      return { images, files: fileRows.map((f) => ({ id: f.id, path: f.path })) };
    });
    const removed = (await this.removeFiles(targets.images)) + (await this.removeNoteFiles(id, targets.files));
    this.events.emit('purged', id);
    return { purged: id, files: removed };
  }
```
After `removeFiles`:
```ts
  /**
   * Removes a purged note's files from files/<noteId>/, then the folder when it is empty. Each
   * failure is logged and skipped: the rows are already gone, and a leftover file is harmless.
   */
  private async removeNoteFiles(noteId: string, targets: ReadonlyArray<{ id: string; path: string }>): Promise<number> {
    let removed = 0;
    for (const target of targets) {
      try {
        removed += await removeNoteFile(this.dataDir, noteId, target.path);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`notesd: purge could not remove file ${target.id} (${target.path}) of note ${noteId}: ${reason}`);
      }
    }
    try {
      await removeNoteFolderIfEmpty(this.dataDir, noteId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`notesd: purge could not remove the files folder of note ${noteId}: ${reason}`);
    }
    return removed;
  }
```
After `requireImageId`:
```ts
  /** Canonical file id or NoteError('invalid_id'). File ids share the note-id format. */
  private requireFileId(input: string): string {
    const id = normalizeId(input);
    if (id === null) {
      throw new NoteError(
        'invalid_id',
        `"${input}" is not a file id. File ids look like A-B32 (case and the dash are optional); every note lists its files with their ids.`,
      );
    }
    return id;
  }
```
After `lockImage`:
```ts
  /** As lockImage, for files: the owning note row first, then the file is re-read. */
  private async lockFile(tx: repo.Tx, fileId: string): Promise<{ note: NoteRow; file: NoteFileRow }> {
    const first = await fileRepo.findFileById(tx, fileId);
    if (first === null) throw fileNotFound(fileId);
    const note = await repo.lockNote(tx, first.noteId);
    const file = await fileRepo.findFileById(tx, fileId);
    if (note === null || file === null) throw fileNotFound(fileId);
    return { note, file };
  }
```
`toNotes` becomes:
```ts
  /** Wire notes in input order, with every note's live images and live files loaded in one query each. */
  private async toNotes(rows: readonly NoteRow[]): Promise<Note[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const images = await imageRepo.imagesForNotes(this.db, ids);
    const files = await fileRepo.filesForNotes(this.db, ids);
    return rows.map((r) => rowToNote(r, this.dataDir, images.get(r.id) ?? [], files.get(r.id) ?? []));
  }
```
After `imageValues`:
```ts
/** note_files insert values for one file (drizzle field names). extraction_status takes its default 'none'. */
function fileValues(noteId: string, id: string, path: string, meta: FileMeta, position: number) {
  return {
    id,
    noteId,
    path,
    sha256: meta.sha256,
    mime: meta.mime,
    bytes: meta.bytes,
    originalName: meta.original_name,
    host: meta.host,
    position,
  };
}
```
After `imageNotFound`:
```ts
function fileNotFound(fileId: string): NoteError {
  return new NoteError('not_found', `File ${fileId} does not exist. File ids are listed in each note's files.`);
}
```
`isUniqueViolation` becomes:
```ts
/** A unique-index clash: NoteError('duplicate_image' | 'duplicate_file') or a raw Postgres 23505. */
function isUniqueViolation(err: unknown): boolean {
  if (err instanceof NoteError) return err.code === 'duplicate_image' || err.code === 'duplicate_file';
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth += 1) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
```
**Impact:** every read path (get/list/search/related/listBin, MCP and HTTP) now carries `files`; one extra query per page. The lock order (note row, then the file row) matches the image writers.

### Step 11: File ingest and image delegation
**File:** `src/files/ingest.ts` (new)
**Code:**
```ts
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import type { AppDeps } from '../deps.js';
import { attachDeps, attachImage, type AttachDeps } from '../images/ingest.js';
import { sha256Hex, sniffImageBytes, UnsupportedImageError } from '../images/probe.js';
import { DestinationExistsError, fileExists, removeQuietly, resolveInDataDir, writeNewFile } from '../images/store.js';
import type { NotesService } from '../notes/service.js';
import { NoteError, type FileMeta, type Note } from '../notes/types.js';
import { detectFileMime } from './mime.js';
import { displayFileName, sanitizeFileName, withNameSuffix } from './name.js';
import { dbFileRecords, type FileRecord, type FileRecords } from './records.js';
import { fileRelPath } from './store.js';

/** Upload cap for one file, the same as for images. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** `name (2).ext` ... `name (999).ext`, then give up. */
export const MAX_NAME_SUFFIX = 999;
const MAX_ATTEMPTS = 5;

export type FileInputErrorCode = 'empty_file' | 'too_large';

export class FileInputError extends Error {
  constructor(
    readonly code: FileInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileInputError';
  }
}

/** The slice of the notes service file ingestion uses. All writes go through it. */
export type FileNotes = Pick<NotesService, 'getOne' | 'restore' | 'newId' | 'attachFile'>;

export type FileDeps = {
  dataDir: string;
  notes: FileNotes;
  records: FileRecords;
  /** Defaults to os.hostname(). Tests override it. */
  hostname?: () => string;
};

/** FileDeps for the running daemon (HTTP routes and reveal). */
export function fileDeps(app: AppDeps): FileDeps {
  return { dataDir: app.config.dataDir, notes: app.service, records: dbFileRecords(app.db) };
}

/** What POST /api/notes/:id/files needs: the file store, and the image store for sniffed images. */
export type UploadDeps = { files: FileDeps; images: AttachDeps };

export function uploadDeps(app: AppDeps): UploadDeps {
  return { files: fileDeps(app), images: attachDeps(app) };
}

export type FileInput = {
  bytes: Uint8Array;
  /** The name the file had on the user's side (any path is cut to its basename). */
  originalName: string | null;
};

/** attachFile's result. attached: false = the bytes already live in `note` (this note or another). */
export type FileAttachResult = { note: Note; attached: boolean };

/** attachUpload's result: where the bytes went. 'image' = stored through attachImage (in note.images). */
export type UploadAttachResult = FileAttachResult & { kind: 'file' | 'image' };

/** Where one file lives on this machine, and whether it is here. Satisfies reveal's RevealTarget. */
export type LocatedFile = {
  id: string;
  noteId: string;
  /** Absolute path under this machine's data dir. */
  originalPath: string;
  relPath: string;
  available: boolean;
  host: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  originalName: string;
  fileDeleted: boolean;
  noteDeleted: boolean;
};

/** Serialises attaches of the same bytes inside this process (the DB index covers other hosts). */
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

/** True when anything (file, folder, link) sits at `abs`. */
async function occupied(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bytes already live in a file. Return the note that holds it (restoring the note when it is
 * soft-deleted). If this machine lacks the bytes (stored on another host), they are written to
 * the holder's path here.
 */
async function reuseExisting(deps: FileDeps, existing: FileRecord, bytes: Uint8Array): Promise<FileAttachResult> {
  const abs = resolveInDataDir(deps.dataDir, existing.path);
  if (!(await fileExists(abs))) {
    try {
      await writeNewFile(abs, bytes);
    } catch (err) {
      if (!(err instanceof DestinationExistsError)) throw err;
    }
  }
  const note =
    existing.note_deleted_at !== null ? await deps.notes.restore(existing.note_id) : await deps.notes.getOne(existing.note_id);
  if (!note) throw new Error(`note ${existing.note_id} holding file ${existing.id} vanished during attach`);
  return { note, attached: false };
}

/** The first `files/<noteId>/<name>` that nothing occupies on disk and no row (any host) uses. */
async function freeRelPath(deps: FileDeps, noteId: string, safeName: string): Promise<{ rel: string; abs: string }> {
  for (let k = 1; k <= MAX_NAME_SUFFIX; k += 1) {
    const rel = fileRelPath(noteId, withNameSuffix(safeName, k));
    const abs = resolveInDataDir(deps.dataDir, rel);
    if (await occupied(abs)) continue;
    if (await deps.records.pathTaken(rel)) continue;
    return { rel, abs };
  }
  throw new Error(`no free file name for ${safeName} in note ${noteId} after ${MAX_NAME_SUFFIX} tries`);
}

/**
 * Add one non-image file to an existing live note, or return the note that already holds these
 * bytes.
 *
 * The target must be live (unknown -> NoteError('not_found'), deleted -> NoteError('deleted');
 * nothing is written then). Empty bytes -> FileInputError('empty_file'). Under the sha lock: a
 * live file with the same sha256 anywhere -> that file's note is returned, restored if deleted
 * (attached: false; nothing new is stored). Otherwise: Windows-safe name, mime, a fresh id (free
 * in notes, note_images and note_files), the first free `files/<noteId>/<name>` (`name (2).ext`
 * on a clash), the bytes written byte for byte, then the row through the notes service. If that
 * fails the bytes are removed; NoteError('duplicate_file') is a concurrent save of the same bytes
 * (return the winner), NoteError('conflict') an id or name clash (retry).
 */
export async function attachFile(deps: FileDeps, noteIdInput: string, input: FileInput): Promise<FileAttachResult> {
  const target = await deps.notes.getOne(noteIdInput, { includeDeleted: true });
  if (target === null) throw new NoteError('not_found', `Note ${noteIdInput} does not exist.`);
  if (target.deleted_at !== undefined) {
    throw new NoteError('deleted', `Note ${target.id} is deleted. Restore it first if you want to attach to it.`);
  }
  if (input.bytes.byteLength === 0) throw new FileInputError('empty_file', 'the file is empty');
  const sha256 = sha256Hex(input.bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256Live(sha256);
    if (existing) return reuseExisting(deps, existing, input.bytes);

    const safeName = sanitizeFileName(input.originalName);
    const meta: FileMeta = {
      sha256,
      mime: await detectFileMime(input.bytes, safeName),
      bytes: input.bytes.byteLength,
      original_name: displayFileName(input.originalName, safeName),
      host: (deps.hostname ?? os.hostname)(),
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const fileId = await deps.notes.newId();
      const { rel, abs } = await freeRelPath(deps, target.id, safeName);
      try {
        await writeNewFile(abs, input.bytes);
      } catch (err) {
        if (err instanceof DestinationExistsError) continue;
        throw err;
      }
      try {
        const note = await deps.notes.attachFile(target.id, { id: fileId, path: rel, meta });
        return { note, attached: true };
      } catch (err) {
        await removeQuietly(abs);
        if (!(err instanceof NoteError) || (err.code !== 'duplicate_file' && err.code !== 'conflict')) throw err;
        if (err.code === 'duplicate_file') {
          const winner = await deps.records.bySha256Live(sha256);
          if (winner) return reuseExisting(deps, winner, input.bytes);
        }
      }
    }
    throw new Error(`could not attach the file in ${MAX_ATTEMPTS} attempts`);
  });
}

/**
 * HTTP POST /api/notes/:id/files: any file from the multipart form. Empty -> FileInputError
 * ('empty_file'); over `maxBytes` -> FileInputError('too_large'). Bytes that sniff as a supported
 * image go to the image store (attachImage, kind 'image'); if the image probe then refuses them
 * (corrupt picture) they are stored as a file instead. Everything else is attachFile (kind 'file').
 */
export async function attachUpload(
  deps: UploadDeps,
  noteId: string,
  file: File,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<UploadAttachResult> {
  if (file.size === 0) throw new FileInputError('empty_file', 'the uploaded file is empty');
  if (file.size > maxBytes) {
    throw new FileInputError('too_large', `file is ${file.size} bytes; the limit is ${maxBytes}`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const name = file.name !== '' ? file.name : null;
  if ((await sniffImageBytes(bytes)) !== null) {
    try {
      const result = await attachImage(deps.images, noteId, { bytes, originalName: name ?? 'upload' });
      return { ...result, kind: 'image' };
    } catch (err) {
      if (!(err instanceof UnsupportedImageError)) throw err;
    }
  }
  const result = await attachFile(deps.files, noteId, { bytes, originalName: name });
  return { ...result, kind: 'file' };
}

/** One file by id (any spelling), in any state, with whether its bytes are on this machine. null when unknown. */
export async function locateFile(deps: Pick<FileDeps, 'dataDir' | 'records'>, fileId: string): Promise<LocatedFile | null> {
  const rec = await deps.records.byFileId(fileId);
  if (rec === null) return null;
  const originalPath = resolveInDataDir(deps.dataDir, rec.path);
  return {
    id: rec.id,
    noteId: rec.note_id,
    originalPath,
    relPath: rec.path,
    available: await fileExists(originalPath),
    host: rec.host,
    mime: rec.mime,
    bytes: rec.bytes,
    sha256: rec.sha256,
    originalName: rec.original_name,
    fileDeleted: rec.deleted_at !== null,
    noteDeleted: rec.note_deleted_at !== null,
  };
}
```
**Impact:** none until the routes mount it.

### Step 12: HTTP routes for files
**File:** `src/http/files.ts` (new)
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps } from '../deps.js';
import { attachUpload, FileInputError, fileDeps, locateFile, MAX_FILE_BYTES, uploadDeps } from '../files/ingest.js';
import { FALLBACK_MIME, isValidMime } from '../files/mime.js';
import { findFileById } from '../notes/fileRepo.js';
import { normalizeId } from '../notes/ids.js';
import { DuplicateFileError, DuplicateImageError, NoteError, toNoteFile } from '../notes/types.js';
import { etagMatches } from './imageAccess.js';

export interface FileRouteOptions {
  /** Upload cap in bytes. Default MAX_FILE_BYTES (200 MB). Tests lower it. */
  maxUploadBytes?: number;
}

/** Room for multipart boundaries on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

/** A download is never rendered: no scripts, no subresources, sandboxed even if a browser tried. */
export const DOWNLOAD_CSP = "default-src 'none'; sandbox";

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>`. The ASCII fallback has
 * every non-printable or non-ASCII character, `"` and `\` replaced by `_`; the RFC 5987 value
 * carries the real name. Never `inline`.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  let encoded: string;
  try {
    encoded = rfc5987(name);
  } catch {
    encoded = rfc5987(ascii);
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** FileInputError / NoteError from the write routes -> HTTP. Anything else is rethrown (500). */
function writeErrorResponse(c: Context, err: unknown, maxUpload: number): Response {
  if (err instanceof FileInputError) {
    if (err.code === 'too_large') return c.json({ error: 'too_large', message: err.message, max_bytes: maxUpload }, 413);
    return c.json({ error: err.code, message: err.message }, 400);
  }
  if (!(err instanceof NoteError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'deleted':
      return c.json({ error: 'not_found' }, 404);
    case 'invalid_id':
      return c.json({ error: 'invalid_id' }, 400);
    case 'duplicate_file':
    case 'duplicate_image': {
      const noteId = err instanceof DuplicateFileError || err instanceof DuplicateImageError ? err.noteId : null;
      return c.json({ error: err.code, note_id: noteId, message: err.message }, 409);
    }
    case 'conflict':
      return c.json({ error: 'conflict' }, 409);
    default:
      return c.json({ error: `${err.code}: ${err.message}` }, 400);
  }
}

/**
 * Note file routes (plan phase 4):
 * - POST /api/notes/:id/files: attach one file (multipart `file`) to a live note, or return the
 *   note that already holds the bytes. Sniffed images are stored as images (kind 'image').
 * - DELETE /api/files/:fileId, POST /api/files/:fileId/restore: soft-remove / put back one file.
 * - GET /api/files/:fileId: the file's NoteFile JSON, in any state.
 * - GET /api/files/:fileId/download: the bytes, always as an attachment.
 * Reveal lives in reveal.ts.
 */
export function fileRoutes(deps: AppDeps, opts: FileRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_FILE_BYTES;
  const upload = uploadDeps(deps);
  const files = fileDeps(deps);
  const r = new Hono();

  r.post(
    '/api/notes/:id/files',
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
        const result = await attachUpload(upload, noteId, fileField, maxUpload);
        return c.json(result, result.attached ? 201 : 200);
      } catch (err) {
        return writeErrorResponse(c, err, maxUpload);
      }
    },
  );

  r.delete('/api/files/:fileId', async (c) => {
    const fileId = normalizeId(c.req.param('fileId') ?? '');
    if (fileId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.removeFile(fileId));
    } catch (err) {
      return writeErrorResponse(c, err, maxUpload);
    }
  });

  r.post('/api/files/:fileId/restore', async (c) => {
    const fileId = normalizeId(c.req.param('fileId') ?? '');
    if (fileId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.restoreFile(fileId));
    } catch (err) {
      return writeErrorResponse(c, err, maxUpload);
    }
  });

  r.get('/api/files/:fileId', async (c) => {
    const id = normalizeId(c.req.param('fileId') ?? '');
    const row = id === null ? null : await findFileById(deps.db, id);
    if (row === null) return c.json({ error: 'not_found' }, 404);
    return c.json(toNoteFile(row, deps.config.dataDir));
  });

  r.get('/api/files/:fileId/download', async (c) => {
    const id = normalizeId(c.req.param('fileId') ?? '');
    const loc = id === null ? null : await locateFile(files, id);
    if (loc === null) return c.json({ error: 'not_found' }, 404);
    if (!loc.available) return c.json({ error: 'not_on_this_machine', host: loc.host }, 404);
    const etag = `"${loc.sha256}"`;
    const headers: Record<string, string> = {
      'Content-Type': isValidMime(loc.mime) ? loc.mime : FALLBACK_MIME,
      'Content-Disposition': attachmentDisposition(loc.originalName),
      ETag: etag,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': DOWNLOAD_CSP,
    };
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304, headers);
    let size: number;
    try {
      size = (await stat(loc.originalPath)).size;
    } catch {
      return c.json({ error: 'not_on_this_machine', host: loc.host }, 404);
    }
    headers['Content-Length'] = String(size);
    const stream = Readable.toWeb(createReadStream(loc.originalPath)) as unknown as ReadableStream<Uint8Array>;
    return c.body(stream, 200, headers);
  });

  return r;
}
```

### Step 13: Mount the routes
**File:** `src/http/app.ts:8` (import), `:51-55` (doc comment), `:70` (mount)
**Change:** add `import { fileRoutes } from './files.js';` after Phase 3's `import { chatImageRoutes } from './chatImages.js';`; Phase 3's doc comment becomes
```ts
/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), imageRoutes (P5), chatImageRoutes (pasted chat images),
 * fileRoutes (note files), revealRoutes (iteration 7: capabilities + reveal; note files add file
 * and note reveal), staticRoutes (P6, last: it owns the SPA fallback; it reserves /api, so the
 * order is for clarity).
 */
```
and after Phase 3's `app.route('/', chatImageRoutes(deps));` (which follows `app.route('/', imageRoutes(deps));`):
```ts
  app.route('/', fileRoutes(deps));
```
Order among the `/api` routers does not matter (no overlapping paths).

### Step 14: Reveal: modes, file and note routes
**File:** `src/http/reveal.ts` — imports (`:7-10`), `explorerArgs` (`:176-179`), `RevealTarget` doc (`:199-205`), `performReveal` (`:218-236`), `revealRoutes` (`:238-258`)
**Change:** imports become
```ts
import type { AppDeps } from '../deps.js';
import { fileDeps, locateFile } from '../files/ingest.js';
import { filesDirFor } from '../files/store.js';
import { imageDeps, locateImage, type ImageDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import type { Note } from '../notes/types.js';
import { sameOriginOnly } from './sameOrigin.js';
```
`explorerArgs` becomes:
```ts
/** 'select': Explorer opens the parent folder with the file selected. 'open': Explorer opens the folder itself. */
export type RevealMode = 'select' | 'open';

/** explorer.exe's arguments: one `/select,<path>` argument (no space after the comma), or the folder path alone. */
export function explorerArgs(winPath: string, mode: RevealMode = 'select'): string[] {
  return mode === 'select' ? ['/select,' + winPath] : [winPath];
}
```
`RevealTarget` becomes:
```ts
/** What the reveal needs (LocatedImage, LocatedFile and a note's files folder satisfy it). */
export interface RevealTarget {
  /** Absolute path under this machine's data dir: the file to select, or the folder to open. */
  originalPath: string;
  available: boolean;
  host: string | null;
}
```
`performReveal` becomes:
```ts
/** 404s first (independent of the machine), then detect, wslpath, spawn. Success = spawned. */
export async function performReveal(
  target: RevealTarget | null,
  reveal: RevealDeps,
  mode: RevealMode = 'select',
): Promise<RevealOutcome> {
  if (target === null) return { status: 404, body: { error: 'not_found' } };
  if (!target.available) return { status: 404, body: { error: 'not_on_this_machine', host: target.host } };
  const env = await reveal.detect();
  if (env === null) return { status: 409, body: { error: 'reveal_unavailable' } };
  let winPath: string;
  try {
    winPath = await reveal.wslpath(target.originalPath);
  } catch (err) {
    return { status: 500, body: { error: 'spawn_failed', message: `wslpath failed: ${errorMessage(err)}` } };
  }
  try {
    await reveal.spawn(env.explorer, explorerArgs(winPath, mode));
  } catch (err) {
    return { status: 500, body: { error: 'spawn_failed', message: errorMessage(err) } };
  }
  return { status: 202, body: { ok: true } };
}

/** What a note-level reveal does: a target (null = 404 not_found) and how Explorer shows it. */
export interface NoteRevealPlan {
  target: RevealTarget | null;
  mode: RevealMode;
}

/**
 * Note-level "Show in Explorer". A missing or deleted note: not_found. A note with live files:
 * open `files/<noteId>/` (available when at least one of its live files is on this machine;
 * otherwise not_on_this_machine with the first file's host). No live files: select the first live
 * image, as the card button always did. Neither: not_found.
 */
export async function noteRevealPlan(
  dataDir: string,
  img: Pick<ImageDeps, 'dataDir' | 'records'>,
  note: Note | null,
): Promise<NoteRevealPlan> {
  if (note === null || note.deleted_at !== undefined) return { target: null, mode: 'select' };
  const firstFile = note.files[0];
  if (firstFile !== undefined) {
    return {
      mode: 'open',
      target: {
        originalPath: filesDirFor(dataDir, note.id),
        available: note.files.some((f) => f.available),
        host: firstFile.host,
      },
    };
  }
  const firstImage = note.images[0];
  if (firstImage === undefined) return { target: null, mode: 'select' };
  return { mode: 'select', target: await locateImage(img, firstImage.id) };
}
```
`revealRoutes` becomes:
```ts
/**
 * GET /api/capabilities -> { reveal }.
 * POST /api/images/:imageId/reveal (own Origin only) -> Explorer with the image's original selected.
 * POST /api/files/:fileId/reveal (own Origin only) -> Explorer with the file selected.
 * POST /api/notes/:id/reveal (own Origin only) -> the note's files folder, or its first image (noteRevealPlan).
 * Every route takes an id, never a path.
 */
export function revealRoutes(deps: AppDeps, opts: RevealRoutesOptions = {}): Hono {
  const reveal = opts.reveal ?? defaultRevealDeps();
  const img = imageDeps(deps);
  const files = fileDeps(deps);
  const r = new Hono();

  r.get('/api/capabilities', async (c) => c.json({ reveal: (await reveal.detect()) !== null }));

  r.post('/api/images/:imageId/reveal', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('imageId'));
    const target = id === null ? null : await locateImage(img, id);
    const out = await performReveal(target, reveal);
    return c.json(out.body, out.status);
  });

  r.post('/api/files/:fileId/reveal', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('fileId'));
    const target = id === null ? null : await locateFile(files, id);
    const out = await performReveal(target, reveal, 'select');
    return c.json(out.body, out.status);
  });

  r.post('/api/notes/:id/reveal', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('id'));
    const note = id === null ? null : await deps.service.getOne(id);
    const plan = await noteRevealPlan(deps.config.dataDir, img, note);
    const out = await performReveal(plan.target, reveal, plan.mode);
    return c.json(out.body, out.status);
  });

  return r;
}
```
**Impact:** existing image reveal behavior is unchanged (default mode `select`); existing unit tests call `explorerArgs(x)` / `performReveal(t, d)` and keep passing.

### Step 15: Data dir subfolder
**File:** `src/daemon.ts:20`
**Change:** append `'files'` to `DATA_SUBDIRS` as Phase 3 left it (Phase 3 added `CHAT_IMAGES_SUBDIR` and its import):
```ts
export const DATA_SUBDIRS = ['images', 'cache', 'inbox', join('inbox', 'failed'), CHAT_SUBDIR, CHAT_IMAGES_SUBDIR, 'files'] as const;
```
`src/images/store.ts` (`DataDirs`, Phase 3's `chatImages`) is not changed by this phase. `writeNewFile` creates `files/<noteId>/` on demand; this just makes the folder exist from start-up.

### Step 16: MCP text lists a note's files
**File:** `src/mcp/imageTools.ts:54-71`
**Change:** `describeNote` and `describeImage` gain a `files:` line (before the body) when the note has files.
```ts
/** `files: report.pdf (application/pdf, 1.2 MB); notes.txt (text/plain, 3 KB)`, or null when the note has none. */
export function filesLine(note: Note): string | null {
  if (note.files.length === 0) return null;
  return `files: ${note.files.map((f) => `${f.name} (${f.mime}, ${formatBytes(f.bytes)})`).join('; ')}`;
}

/** The metadata block for a note without an image. */
export function describeNote(note: Note): string {
  const files = filesLine(note);
  return [`id: ${note.id}`, `saved: ${note.created_at}`, tagLine(note), ...(files !== null ? [files] : []), bodyLine(note)].join('\n');
}

/** The metadata text block that precedes every image view_images returns. */
export function describeImage(note: Note, image: NoteImage, k: number, n: number): string {
  const files = filesLine(note);
  return [
    `id: ${note.id}`,
    `image: ${image.id} (image ${k} of ${n})`,
    `saved: ${note.created_at}`,
    `taken: ${image.taken_at ?? 'unknown (no EXIF date)'}`,
    `size: ${image.width}x${image.height} ${image.mime}, ${formatBytes(image.bytes)}` +
      (image.original_name ? `, original name ${image.original_name}` : ''),
    tagLine(note),
    ...(files !== null ? [files] : []),
    bodyLine(note),
  ].join('\n');
}
```
`get`, `list`, `search`, `related` already return whole `Note` JSON, so `files` appears there with no tool change.

### Step 17: Test helpers follow the wire shape
**File:** `tests/helpers/fakeNotes.ts:59-72`
**Change:** `toNote` adds `files: []` after `images`:
```ts
  private toNote(r: FakeNoteRow): Note {
    const note: Note = {
      id: r.id,
      body: r.body,
      tags: [],
      created_at: r.created_at,
      updated_at: r.created_at,
      origin: r.origin,
      images: this.liveImagesOf(r.id).map((i) => this.toWire(i)),
      files: [],
    };
    // As rowToNote: deleted_at is present only on deleted notes.
    if (r.deleted_at !== null) note.deleted_at = r.deleted_at;
    return note;
  }
```
**File:** `tests/integration/setup.ts:50`
**Change:** add `note_files` to the truncate list as Phase 3 left it (`chat_images, note_images, …`):
```ts
  await db.execute(sql`truncate table chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```

**File:** `tests/integration/imageHarness.ts` (`startHarness` subdir loop and `reset()`, as Phase 3 left them)
**Change:** the temp data dir gets `files/`, and `reset()` empties it. Phase 3's subdir loop becomes:
```ts
  for (const sub of ['images', 'cache', 'inbox', 'inbox/failed', 'chat-images', 'files']) {
```
Phase 3's `reset()` becomes:
```ts
    async reset() {
      await truncateAll(db);
      for (const sub of ['images', 'cache', 'chat-images', 'files']) {
        await rm(path.join(dataDir, sub), { recursive: true, force: true });
        await mkdir(path.join(dataDir, sub), { recursive: true });
      }
    },
```
Phase 3's `HarnessOptions` / `startHarness(options: HarnessOptions = {})` signature is unchanged.

**File:** `tests/unit/notes.helpers.test.ts:8-9`, `:98-108`, new tests after `:150`
**Change:** import `toNoteFile` and `NoteFileRow`; the text-note expectation gets `files: []`; add a fixture and two tests.
```ts
import { cleanOrigin, imageAvailable, NoteError, rowToNote, toNoteFile, toNoteImage, type NoteRow } from '../../src/notes/types.js';
import type { NoteFileRow, NoteImageRow } from '../../src/db/schema.js';
```
Fixture, after `imageRow`:
```ts
function fileRow(overrides: Partial<NoteFileRow> = {}): NoteFileRow {
  return {
    id: 'F-1L3',
    noteId: 'A-B32',
    path: 'files/A-B32/report.pdf',
    sha256: 'f',
    mime: 'application/pdf',
    bytes: 2048,
    originalName: 'report.pdf',
    host: 'lenovo',
    position: 0,
    extractedText: null,
    extractionStatus: 'none',
    createdAt: new Date('2026-10-30T01:02:03.004Z'),
    deletedAt: null,
    ...overrides,
  };
}
```
`it('maps a text note', ...)` expectation becomes:
```ts
    expect(rowToNote(row({ origin: { repo: 'seer' } }), dataDir, [])).toEqual({
      id: 'A-B32',
      body: 'hello #seer',
      tags: ['seer'],
      created_at: '2026-10-30T01:02:03.004Z',
      updated_at: '2026-10-30T02:00:00.000Z',
      origin: { repo: 'seer' },
      images: [],
      files: [],
    });
```
New tests inside `describe('wire mapping', ...)`, after the `imageAvailable` test:
```ts
  it('maps live files in position order and checks each file under dataDir', () => {
    mkdirSync(join(dataDir, 'files/A-B32'), { recursive: true });
    writeFileSync(join(dataDir, 'files/A-B32/report.pdf'), 'x');
    const first = fileRow();
    const away = fileRow({ id: 'G-2M4', path: 'files/A-B32/away.txt', position: 2, mime: 'text/plain', originalName: 'away.txt' });
    const removed = fileRow({ id: 'H-3N5', path: 'files/A-B32/gone.txt', position: 1, deletedAt: new Date('2026-10-31T00:00:00Z') });
    const n = rowToNote(row(), dataDir, [], [away, removed, first]);
    expect(n.files.map((f) => f.id)).toEqual(['F-1L3', 'G-2M4']);
    expect(n.files[0]).toEqual({
      id: 'F-1L3',
      note_id: 'A-B32',
      position: 0,
      name: 'report.pdf',
      mime: 'application/pdf',
      bytes: 2048,
      host: 'lenovo',
      available: true,
      extraction_status: 'none',
      urls: { download: '/api/files/F-1L3/download' },
    });
    expect(n.files[1]).toMatchObject({ available: false });
  });

  it('toNoteFile carries deleted_at only for removed files', () => {
    expect(toNoteFile(fileRow(), dataDir).deleted_at).toBeUndefined();
    expect(toNoteFile(fileRow({ deletedAt: new Date('2026-10-31T00:00:00Z') }), dataDir).deleted_at).toBe('2026-10-31T00:00:00.000Z');
  });
```

### Step 18: Web type only
**File:** `web/src/types.ts:19` (after `NoteImage`) and `:21-31` (`Note`)
**Change:** add the type and an optional field, so every existing web fixture still type-checks and P5 reads `note.files ?? []`.
```ts
/** One non-image file of a note, as the server sends it (src/notes/types.ts NoteFile). */
export interface NoteFile {
  id: string;
  note_id: string;
  position: number;
  /** The user's file name. */
  name: string;
  mime: string;
  bytes: number;
  host: string | null;
  /** The file exists under this machine's data dir. */
  available: boolean;
  extraction_status: 'none' | 'pending' | 'done' | 'failed' | 'unsupported';
  /** `/api/files/<id>/download`, always an attachment. */
  urls: { download: string };
  /** Present only on removed files. */
  deleted_at?: string;
}
```
In `Note`, after `images`:
```ts
  /** Live files, ascending `position`. The server always sends it; optional on the web type by plan decision (read `note.files ?? []`). */
  files?: NoteFile[];
```

### Step 19: Instructions for Claude
**File:** `src/mcp/instructions.ts:33` (Notes paragraph) and after `:51` (Attaching paragraph)
**Change:** in the Notes paragraph, the sentence ending
`origin (where it was saved from: cwd, repo, claude_session; may be null) and images (an array, empty for text notes).` becomes:
```
origin (where it was saved from: cwd, repo, claude_session; may be null), images (an array, empty for text notes) and files (an array, empty when the note has none).
```
Insert a new array element right after the `Attaching.` element:
```ts
    `Files. A note can also hold files that are not pictures (PDFs, documents, spreadsheets, archives, anything), attached by the user on the wall. Every note returned by get/list/search has a files array, empty when it has none, otherwise one entry per file in the order they were added, each {id, note_id, position, name, mime, bytes, host, available, extraction_status, urls}. You cannot open or read a file's contents from here (extraction_status says whether its text was extracted; today it is always "none"), but you can see that it exists: when the user asks what a note holds, name each file with its type and size. No tool attaches, removes or restores files, and view_images ignores them; the user manages files in the note's editor on the wall. available: false means the file lives on another machine (host).`,
```
**File:** `tests/unit/mcp.instructions.test.ts` — add inside `describe('buildInstructions', ...)`:
```ts
  it('has one Files paragraph: files are visible by name, type and size but not readable, and no tool writes them', () => {
    const text = buildInstructions('Asia/Jakarta');
    const paragraphs = text.split('\n\n').filter((p) => p.startsWith('Files.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toContain('files array');
    expect(p).toContain('cannot open or read');
    expect(p).toContain('extraction_status');
    expect(p).toContain('No tool attaches, removes or restores files');
    const notes = text.split('\n\n').find((s) => s.startsWith('Notes.'))!;
    expect(notes).toContain('files (an array, empty when the note has none)');
    const order = text.split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Files')).toBe(order.indexOf('Attaching') + 1);
  });
```

### Step 20: Chat prompt sentence
**File:** `src/chat/prompt.ts:27`
**Change:** the pictures paragraph becomes:
```ts
    `To look at pictures, find the notes with images first (list with has_image, or search), then call view_images with their note ids (each note id shows every image of that note, up to 8 images per call; image ids work too) and comment on what you actually see. A note may also hold files that are not pictures: you see each one's name, type and size in the note's files list but cannot open them, and you cannot attach files.`,
```
**File:** `tests/unit/chat-prompt.test.ts` — add inside the existing `describe`:
```ts
  it('says note files are visible by name, type and size but cannot be opened', () => {
    expect(prompt).toMatch(/files that are not pictures/);
    expect(prompt).toMatch(/cannot open them/);
  });
```

### Step 21: `/n` skill text
**File:** `claude/skills/n/SKILL.md` — "What a note is" list (after the image bullet ending `and \`available\`.`), and a new section after `## Images` (before `## Deleting`)
**Change:** add this bullet at the end of "What a note is":
```markdown
- A note may also hold files that are not pictures (PDFs, documents, archives, anything), added
  by the user on the wall. Every note in a result has a `files` list (empty when it has none);
  each file has an id, `name`, `mime`, `bytes`, `host`, `available` and `extraction_status`.
```
and this section:
```markdown
## Files

- You can see a note's files but not read them: their contents are not available through any
  tool (`extraction_status` is `none` for now). When the user asks what a note holds, list each
  file by name with its type and size, e.g. `report.pdf (application/pdf, 1.2 MB)`.
- There is no tool to attach, remove or restore a file. If the user asks for that, tell them to
  open the note on the wall and use the paperclip or the file's chip there.
- `view_images` shows pictures only; files never come back from it.
- A file with `available: false` lives on the machine that saved it (`host`).
```

### Step 22: Unit tests for names, paths, mime and headers
**File:** `tests/unit/files.name.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import {
  displayFileName,
  FALLBACK_FILE_NAME,
  isSafeFileName,
  MAX_FILE_NAME_BYTES,
  MAX_FILE_NAME_CHARS,
  sanitizeFileName,
  withNameSuffix,
} from '../../src/files/name.js';

describe('sanitizeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('Laporan Keuangan Q3 (final).xlsx')).toBe('Laporan Keuangan Q3 (final).xlsx');
  });

  it('keeps only the basename, whatever the separator', () => {
    expect(sanitizeFileName('/home/u/docs/report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
  });

  it('replaces Windows-forbidden characters and drops control characters', () => {
    expect(sanitizeFileName('a:b*c?d"e<f>g|h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeFileName('tab\there\u0000\u0085.txt')).toBe('tabhere.txt');
  });

  it('removes surrounding spaces and trailing dots', () => {
    expect(sanitizeFileName('  notes.txt  ')).toBe('notes.txt');
    expect(sanitizeFileName('trailing. . ')).toBe('trailing');
  });

  it('prefixes Windows reserved device names, with or without an extension', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('LPT1.log')).toBe('_LPT1.log');
    expect(sanitizeFileName('nul.tar.gz')).toBe('_nul.tar.gz');
    expect(sanitizeFileName('console.txt')).toBe('console.txt');
    expect(sanitizeFileName('com10.txt')).toBe('com10.txt');
  });

  it('falls back when nothing usable is left', () => {
    for (const raw of ['', '   ', '..', '.', null, undefined, '/', '\u0001']) {
      expect(sanitizeFileName(raw)).toBe(FALLBACK_FILE_NAME);
    }
  });

  it('keeps dotfiles', () => {
    expect(sanitizeFileName('.env')).toBe('.env');
  });

  it('normalises to NFC', () => {
    expect(sanitizeFileName('e\u0301.txt')).toBe('\u00e9.txt');
  });

  it('cuts long names to 120 code points and keeps the extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(300)}.pdf`);
    expect(Array.from(name)).toHaveLength(MAX_FILE_NAME_CHARS);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('cuts multi-byte names by bytes too, never splitting a character', () => {
    const name = sanitizeFileName(`${'\u{1F600}'.repeat(100)}.txt`);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(name.endsWith('.txt')).toBe(true);
    // A lone surrogate (a split emoji) makes encodeURIComponent throw.
    expect(() => encodeURIComponent(name)).not.toThrow();
  });

  it('treats an over-long extension as part of the stem', () => {
    const name = sanitizeFileName(`x.${'y'.repeat(200)}`);
    expect(Array.from(name)).toHaveLength(MAX_FILE_NAME_CHARS);
    expect(name.startsWith('x.')).toBe(true);
  });

  it('is always a safe single segment', () => {
    for (const raw of ['a/b', 'a\\b', 'CON', '..', 'x'.repeat(500), 'a:b', '\u0000']) {
      expect(isSafeFileName(sanitizeFileName(raw))).toBe(true);
    }
  });
});

describe('withNameSuffix', () => {
  it('numbers clashes before the extension', () => {
    expect(withNameSuffix('notes.txt', 1)).toBe('notes.txt');
    expect(withNameSuffix('notes.txt', 2)).toBe('notes (2).txt');
    expect(withNameSuffix('archive.tar.gz', 3)).toBe('archive.tar (3).gz');
    expect(withNameSuffix('.env', 2)).toBe('.env (2)');
    expect(withNameSuffix('README', 12)).toBe('README (12)');
  });
});

describe('displayFileName', () => {
  it('keeps the user name (minus control characters), else the safe name', () => {
    expect(displayFileName('C:\\x\\re:port?.txt', 're_port_.txt')).toBe('re:port?.txt');
    expect(displayFileName('a\u0000b.txt', 'ab.txt')).toBe('ab.txt');
    expect(displayFileName('', 'file')).toBe('file');
    expect(displayFileName(null, 'file')).toBe('file');
  });
});

describe('isSafeFileName', () => {
  it('refuses separators, dot names, forbidden and control characters', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a\u0000b', 'x'.repeat(256)]) {
      expect(isSafeFileName(bad)).toBe(false);
    }
    expect(isSafeFileName('notes (2).txt')).toBe(true);
  });
});
```

**File:** `tests/unit/files.store.test.ts` (new)
```ts
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFileMime, FALLBACK_MIME, isValidMime } from '../../src/files/mime.js';
import { fileRelPath, filesDirFor, isNoteFileRelPath, removeNoteFile, removeNoteFolderIfEmpty } from '../../src/files/store.js';
import { attachmentDisposition, DOWNLOAD_CSP } from '../../src/http/files.js';

let dataDir: string;
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'notes-files-unit-'));
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('file paths', () => {
  it('builds files/<noteId>/<name> only for a canonical id and a safe name', () => {
    expect(fileRelPath('A-B32', 'notes.txt')).toBe('files/A-B32/notes.txt');
    expect(fileRelPath('A-B32', 'notes (2).txt')).toBe('files/A-B32/notes (2).txt');
    expect(() => fileRelPath('ab32', 'notes.txt')).toThrow();
    expect(() => fileRelPath('../x', 'notes.txt')).toThrow();
    expect(() => fileRelPath('A-B32', '../notes.txt')).toThrow();
    expect(() => fileRelPath('A-B32', '..')).toThrow();
    expect(() => fileRelPath('A-B32', 'a:b')).toThrow();
  });

  it('recognises only one safe segment inside the note folder', () => {
    expect(isNoteFileRelPath('A-B32', 'files/A-B32/notes.txt')).toBe(true);
    expect(isNoteFileRelPath('A-B32', 'files/C-D45/notes.txt')).toBe(false);
    expect(isNoteFileRelPath('A-B32', 'files/A-B32/../C-D45/x.txt')).toBe(false);
    expect(isNoteFileRelPath('A-B32', 'files/A-B32/sub/x.txt')).toBe(false);
    expect(isNoteFileRelPath('A-B32', 'images/2026/10/A-B32.png')).toBe(false);
  });

  it('resolves the note folder inside the data dir', () => {
    expect(filesDirFor(dataDir, 'A-B32')).toBe(path.join(path.resolve(dataDir), 'files', 'A-B32'));
    expect(() => filesDirFor(dataDir, '..')).toThrow();
  });
});

describe('removeNoteFile / removeNoteFolderIfEmpty', () => {
  it('removes a named file of the note, then the empty folder', async () => {
    const dir = path.join(dataDir, 'files', 'A-B32');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'a.txt'), 'a');
    expect(await removeNoteFile(dataDir, 'A-B32', 'files/A-B32/a.txt')).toBe(1);
    expect(await removeNoteFile(dataDir, 'A-B32', 'files/A-B32/a.txt')).toBe(0);
    expect(await removeNoteFolderIfEmpty(dataDir, 'A-B32')).toBe(true);
    expect(await removeNoteFolderIfEmpty(dataDir, 'A-B32')).toBe(false);
  });

  it('refuses paths of another note, outside the folder, and directories', async () => {
    const dir = path.join(dataDir, 'files', 'C-D45');
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'keep.txt'), 'k');
    expect(await removeNoteFile(dataDir, 'A-B32', 'files/C-D45/keep.txt')).toBe(0);
    expect(await removeNoteFile(dataDir, 'C-D45', 'files/C-D45/../C-D45/keep.txt')).toBe(0);
    expect(await removeNoteFile(dataDir, 'C-D45', 'files/C-D45/sub')).toBe(0);
    expect(await removeNoteFolderIfEmpty(dataDir, 'C-D45')).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(['keep.txt', 'sub']);
  });

  it('removes a symlink without following it', async () => {
    const dir = path.join(dataDir, 'files', 'E-F67');
    await mkdir(dir, { recursive: true });
    const outside = path.join(dataDir, 'outside.txt');
    await writeFile(outside, 'o');
    await symlink(outside, path.join(dir, 'link.txt'));
    expect(await removeNoteFile(dataDir, 'E-F67', 'files/E-F67/link.txt')).toBe(1);
    expect(await readdir(dataDir)).toContain('outside.txt');
  });
});

describe('detectFileMime', () => {
  it('prefers magic bytes, then the extension, else octet-stream', async () => {
    expect(await detectFileMime(Buffer.from('%PDF-1.4\n%fake\n'), 'whatever.bin')).toBe('application/pdf');
    expect(await detectFileMime(Buffer.from('hello'), 'notes.txt')).toBe('text/plain');
    expect(await detectFileMime(Buffer.from('a,b\n1,2\n'), 'DATA.CSV')).toBe('text/csv');
    expect(await detectFileMime(Buffer.from('not really a png'), 'fake.png')).toBe(FALLBACK_MIME);
    expect(await detectFileMime(Buffer.from('???'), 'noext')).toBe(FALLBACK_MIME);
  });

  it('validates header-safe mime strings', () => {
    expect(isValidMime('application/pdf')).toBe(true);
    expect(isValidMime('text/plain; charset=utf-8')).toBe(false);
    expect(isValidMime('text/html\r\nX: y')).toBe(false);
  });
});

describe('download headers', () => {
  it('is always an attachment with an ASCII fallback and an RFC 5987 name', () => {
    expect(attachmentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(attachmentDisposition('résumé "final" (v2)*.pdf')).toBe(
      `attachment; filename="r_sum_ _final_ (v2)*.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%20%28v2%29%2A.pdf`,
    );
    expect(attachmentDisposition('a\r\nb.txt')).toBe(`attachment; filename="a__b.txt"; filename*=UTF-8''a%0D%0Ab.txt`);
  });

  it('sandboxes downloads', () => {
    expect(DOWNLOAD_CSP).toContain('sandbox');
    expect(DOWNLOAD_CSP).toContain("default-src 'none'");
  });
});
```

**File:** `tests/unit/mcp.describe.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { describeImage, describeNote, filesLine } from '../../src/mcp/imageTools.js';
import type { Note, NoteFile, NoteImage } from '../../src/notes/types.js';

function file(over: Partial<NoteFile> = {}): NoteFile {
  return {
    id: 'F-1L3',
    note_id: 'A-B32',
    position: 0,
    name: 'report.pdf',
    mime: 'application/pdf',
    bytes: 1258291,
    host: 'lenovo',
    available: true,
    extraction_status: 'none',
    urls: { download: '/api/files/F-1L3/download' },
    ...over,
  };
}

const image: NoteImage = {
  id: 'A-B32',
  note_id: 'A-B32',
  position: 0,
  mime: 'image/png',
  width: 10,
  height: 20,
  bytes: 2048,
  taken_at: null,
  original_name: null,
  host: 'lenovo',
  available: true,
  urls: { thumb: '', display: '', original: '', preview: '' },
};

function note(files: NoteFile[]): Note {
  return {
    id: 'A-B32',
    body: 'quarterly #finance',
    tags: ['finance'],
    created_at: '2026-10-31T00:00:00.000Z',
    updated_at: '2026-10-31T00:00:00.000Z',
    origin: null,
    images: [image],
    files,
  };
}

describe('files in MCP text', () => {
  it('lists every file as name (mime, size), before the body', () => {
    const n = note([file(), file({ id: 'G-2M4', name: 'notes.txt', mime: 'text/plain', bytes: 3000 })]);
    expect(filesLine(n)).toBe('files: report.pdf (application/pdf, 1.2 MB); notes.txt (text/plain, 3 KB)');
    const text = describeNote(n).split('\n');
    expect(text.indexOf('files: report.pdf (application/pdf, 1.2 MB); notes.txt (text/plain, 3 KB)')).toBe(text.length - 2);
    expect(describeImage(n, image, 1, 1)).toContain('files: report.pdf (application/pdf, 1.2 MB)');
  });

  it('adds no line for a note without files', () => {
    expect(filesLine(note([]))).toBeNull();
    expect(describeNote(note([]))).not.toContain('files:');
  });
});
```

**File:** `tests/unit/reveal.test.ts` — add at the end of the file:
```ts
describe('reveal modes', () => {
  it('selects by default and opens a folder in open mode', () => {
    expect(explorerArgs('C:\\x\\a.txt')).toEqual(['/select,C:\\x\\a.txt']);
    expect(explorerArgs('C:\\x\\a.txt', 'select')).toEqual(['/select,C:\\x\\a.txt']);
    expect(explorerArgs('C:\\x', 'open')).toEqual(['C:\\x']);
  });

  it('performReveal in open mode spawns explorer with the folder and no /select', async () => {
    const spawn = vi.fn(async (_cmd: string, _args: string[]): Promise<void> => undefined);
    const deps: RevealDeps = {
      detect: async () => ({ explorer: 'explorer.exe', wslpath: '/usr/bin/wslpath' }),
      wslpath: async (abs) => `W:${abs}`,
      spawn,
    };
    const target: RevealTarget = { originalPath: '/data/files/A-B32', available: true, host: 'h' };
    expect(await performReveal(target, deps, 'open')).toEqual({ status: 202, body: { ok: true } });
    expect(spawn).toHaveBeenCalledWith('explorer.exe', ['W:/data/files/A-B32']);
  });
});
```
(`explorerArgs`, `performReveal`, `RevealDeps`, `RevealTarget` and `vi` are already imported there.)

### Step 23: Integration tests
**File:** `tests/integration/files.int.test.ts` (new)
```ts
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileRoutes } from '../../src/http/files.js';
import type { NoteEvent } from '../../src/notes/events.js';
import { imageIdTaken } from '../../src/notes/imageRepo.js';
import { NoteError, type Note, type NoteFile } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

type AttachBody = { note: Note; attached: boolean; kind: 'file' | 'image' };
type Requester = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

const ID = /^[0-9A-Z]-[0-9A-Z]{3}$/;
const OWN_ORIGIN = 'http://localhost';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('note files over HTTP', () => {
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

  function upload(noteId: string, bytes: Buffer, name: string, app: Requester = h.app): Promise<Response> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name));
    return Promise.resolve(app.request(`/api/notes/${noteId}/files`, { method: 'POST', body: fd }));
  }

  async function attach(noteId: string, bytes: Buffer, name: string): Promise<AttachBody> {
    const res = await upload(noteId, bytes, name);
    expect([200, 201]).toContain(res.status);
    return (await res.json()) as AttachBody;
  }

  async function getNote(id: string): Promise<Note> {
    const res = await h.app.request(`/api/notes/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Note;
  }

  async function fileCount(): Promise<number> {
    const res = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_files`);
    return res.rows[0]?.n ?? -1;
  }

  it('attaches a non-image file under files/<noteId>/ with its metadata', async () => {
    await insertTextNote(h, 'A-B32', 'report');
    const res = await upload('a-b32', Buffer.from('hello notes'), 'notes.txt');
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(true);
    expect(body.kind).toBe('file');
    expect(body.note.id).toBe('A-B32');
    expect(body.note.images).toEqual([]);
    expect(body.note.files).toHaveLength(1);
    const f = body.note.files[0]!;
    expect(f.id).toMatch(ID);
    expect(f).toEqual({
      id: f.id,
      note_id: 'A-B32',
      position: 0,
      name: 'notes.txt',
      mime: 'text/plain',
      bytes: 11,
      host: os.hostname(),
      available: true,
      extraction_status: 'none',
      urls: { download: `/api/files/${f.id}/download` },
    });
    expect(await readFile(path.join(h.dataDir, 'files', 'A-B32', 'notes.txt'), 'utf8')).toBe('hello notes');
    const row = await h.deps.db.execute<{ path: string; extraction_status: string; extracted_text: string | null }>(
      sql`select path, extraction_status, extracted_text from note_files where id = ${f.id}`,
    );
    expect(row.rows[0]).toEqual({ path: 'files/A-B32/notes.txt', extraction_status: 'none', extracted_text: null });
    expect((await getNote('A-B32')).files.map((x) => x.id)).toEqual([f.id]);
  });

  it('shares the id space: a file id is taken for notes and images too', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attach('A-B32', Buffer.from('id space'), 'a.txt')).note.files[0]!;
    expect(await imageIdTaken(h.deps.db, f.id)).toBe(true);
    await expect(h.deps.service.create({ id: f.id, body: 'clash' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.deps.service.create({ id: f.id, body: 'clash' })).rejects.toBeInstanceOf(NoteError);
  });

  it('stores a Windows-safe name, keeps the user name for display, and suffixes a clash', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = await attach('A-B32', Buffer.from('first'), 're:port?.txt');
    const b = await attach('A-B32', Buffer.from('second'), 're:port?.txt');
    expect(a.note.files[0]!.name).toBe('re:port?.txt');
    expect(b.note.files.map((f) => [f.name, f.position])).toEqual([
      ['re:port?.txt', 0],
      ['re:port?.txt', 1],
    ]);
    expect((await readdir(path.join(h.dataDir, 'files', 'A-B32'))).sort()).toEqual(['re_port_ (2).txt', 're_port_.txt']);
  });

  it('skips a name another machine already used (row exists, file not here)', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = await attach('A-B32', Buffer.from('elsewhere'), 'same.txt');
    await rm(path.join(h.dataDir, 'files', 'A-B32', 'same.txt'));
    await attach('A-B32', Buffer.from('here'), 'same.txt');
    const rows = await h.deps.db.execute<{ id: string; path: string }>(sql`select id, path from note_files order by position`);
    expect(rows.rows).toEqual([
      { id: a.note.files[0]!.id, path: 'files/A-B32/same.txt' },
      { id: expect.stringMatching(ID), path: 'files/A-B32/same (2).txt' },
    ]);
  });

  it('returns the holder note for bytes that already live anywhere, restoring a deleted holder', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    await attach('A-B32', Buffer.from('same bytes'), 'a.txt');

    const res = await upload('C-D45', Buffer.from('same bytes'), 'b.txt');
    expect(res.status).toBe(200);
    const dup = (await res.json()) as AttachBody;
    expect(dup.attached).toBe(false);
    expect(dup.kind).toBe('file');
    expect(dup.note.id).toBe('A-B32');
    expect((await getNote('C-D45')).files).toEqual([]);

    expect((await h.app.request('/api/notes/A-B32', { method: 'DELETE' })).status).toBe(200);
    const again = await attach('C-D45', Buffer.from('same bytes'), 'b.txt');
    expect(again.attached).toBe(false);
    expect(again.note.id).toBe('A-B32');
    expect(again.note.deleted_at).toBeUndefined();
    expect(await fileCount()).toBe(1);
  });

  it('puts the bytes back at the holder path when this machine lacks them', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    await attach('A-B32', Buffer.from('travelled'), 'a.txt');
    const onDisk = path.join(h.dataDir, 'files', 'A-B32', 'a.txt');
    await rm(onDisk);
    const dup = await attach('C-D45', Buffer.from('travelled'), 'b.txt');
    expect(dup.attached).toBe(false);
    expect(await readFile(onDisk, 'utf8')).toBe('travelled');
    expect(dup.note.files[0]!.available).toBe(true);
  });

  it('stores concurrent uploads of the same bytes once', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    const bytes = Buffer.from('raced bytes');
    const [x, y] = await Promise.all([upload('A-B32', bytes, 'x.bin'), upload('C-D45', bytes, 'y.bin')]);
    const bodies = [(await x.json()) as AttachBody, (await y.json()) as AttachBody];
    expect(bodies.filter((b) => b.attached)).toHaveLength(1);
    expect(await fileCount()).toBe(1);
  });

  it('delegates bytes that sniff as a supported image to the image store', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const png = await makeImage('png', 16, 16, { r: 1, g: 2, b: 3 });
    const res = await upload('A-B32', png, 'screenshot.bin');
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.kind).toBe('image');
    expect(body.attached).toBe(true);
    expect(body.note.images).toHaveLength(1);
    expect(body.note.files).toEqual([]);
    expect(await exists(path.join(h.dataDir, 'files', 'A-B32'))).toBe(false);
    expect(await fileCount()).toBe(0);
  });

  it('stores a file named like an image whose bytes are not one', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const body = await attach('A-B32', Buffer.from('not really a png'), 'fake.png');
    expect(body.kind).toBe('file');
    expect(body.note.files[0]).toMatchObject({ name: 'fake.png', mime: 'application/octet-stream' });
  });

  it('refuses empty, missing, malformed, unknown, deleted and too large', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await insertTextNote(h, 'C-D45', 'gone');
    await h.app.request('/api/notes/C-D45', { method: 'DELETE' });

    const empty = await upload('A-B32', Buffer.alloc(0), 'empty.txt');
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe('empty_file');

    const fd = new FormData();
    fd.append('other', 'x');
    const missing = await h.app.request('/api/notes/A-B32/files', { method: 'POST', body: fd });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'file_required' });

    expect((await upload('not-an-id', Buffer.from('x'), 'x.txt')).status).toBe(400);
    const unknown = await upload('Z-ZZZ', Buffer.from('x'), 'x.txt');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
    expect((await upload('C-D45', Buffer.from('x'), 'x.txt')).status).toBe(404);

    const small = new Hono().route('/', fileRoutes(h.deps, { maxUploadBytes: 1024 }));
    const big = await upload('A-B32', Buffer.alloc(2048, 7), 'big.bin', small);
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string; max_bytes: number })).toMatchObject({ error: 'too_large', max_bytes: 1024 });
    expect(await fileCount()).toBe(0);
  });

  it('removes and restores a file at its old position, one updated event each', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = (await attach('A-B32', Buffer.from('a'), 'a.txt')).note.files[0]!;
    const b = (await attach('A-B32', Buffer.from('b'), 'b.txt')).note.files[1]!;
    const seen: NoteEvent[] = [];
    const off = h.deps.events.on((e) => seen.push(e));

    const removed = await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as Note).files.map((f) => f.id)).toEqual([b.id]);
    const json = (await (await h.app.request(`/api/files/${a.id}`)).json()) as NoteFile;
    expect(json.deleted_at).toBeDefined();
    expect(json.position).toBe(0);
    expect(await exists(path.join(h.dataDir, 'files', 'A-B32', 'a.txt'))).toBe(true);

    expect((await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' })).status).toBe(200);

    const restored = await h.app.request(`/api/files/${a.id.toLowerCase().replace('-', '')}/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as Note).files.map((f) => f.id)).toEqual([a.id, b.id]);
    off();
    expect(seen).toEqual([
      { type: 'note', op: 'updated', id: 'A-B32' },
      { type: 'note', op: 'updated', id: 'A-B32' },
    ]);
  });

  it('restoring a file of a deleted note restores the note', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = (await attach('A-B32', Buffer.from('a'), 'a.txt')).note.files[0]!;
    await h.app.request('/api/notes/A-B32', { method: 'DELETE' });
    const res = await h.app.request(`/api/files/${a.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const note = (await res.json()) as Note;
    expect(note.deleted_at).toBeUndefined();
    expect(note.files.map((f) => f.id)).toEqual([a.id]);
  });

  it('refuses to restore a file whose bytes now live in another note', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    const a = (await attach('A-B32', Buffer.from('moved'), 'a.txt')).note.files[0]!;
    await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' });
    const moved = await attach('C-D45', Buffer.from('moved'), 'a.txt');
    expect(moved.attached).toBe(true);
    const res = await h.app.request(`/api/files/${a.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'duplicate_file', note_id: 'C-D45' });
  });

  it('404s unknown file ids and 400s malformed ones on the write routes', async () => {
    expect((await h.app.request('/api/files/Z-ZZZ')).status).toBe(404);
    expect((await h.app.request('/api/files/nope')).status).toBe(404);
    expect((await h.app.request('/api/files/Z-ZZZ', { method: 'DELETE' })).status).toBe(404);
    expect((await h.app.request('/api/files/nope', { method: 'DELETE' })).status).toBe(400);
    expect((await h.app.request('/api/files/Z-ZZZ/restore', { method: 'POST' })).status).toBe(404);
    expect((await h.app.request('/api/files/Z-ZZZ/download')).status).toBe(404);
  });

  it('downloads as an attachment, never inline, in any state', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attach('A-B32', Buffer.from('%PDF-1.4\n%fake\n'), 'résumé final.pdf')).note.files[0]!;
    expect(f.mime).toBe('application/pdf');

    const res = await h.app.request(f.urls.download);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="r_sum_ final.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20final.pdf`,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.4\n%fake\n');

    const cached = await h.app.request(f.urls.download, { headers: { 'If-None-Match': etag! } });
    expect(cached.status).toBe(304);

    await h.app.request(`/api/files/${f.id}`, { method: 'DELETE' });
    expect((await h.app.request(f.urls.download)).status).toBe(200);

    await rm(path.join(h.dataDir, 'files', 'A-B32', 'résumé final.pdf'));
    const gone = await h.app.request(f.urls.download);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
  });

  it('purging a deleted note removes its files folder, removed files included, and nothing else', async () => {
    await insertTextNote(h, 'A-B32', 'doomed');
    await insertTextNote(h, 'C-D45', 'kept');
    const a = (await attach('A-B32', Buffer.from('a'), 'a.txt')).note.files[0]!;
    await attach('A-B32', Buffer.from('b'), 'b.txt');
    await attach('A-B32', await makeImage('png', 8, 8, { r: 9, g: 9, b: 9 }), 'pic.png');
    await attach('C-D45', Buffer.from('c'), 'c.txt');
    await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' });
    await h.app.request('/api/notes/A-B32', { method: 'DELETE' });

    const res = await h.app.request('/api/bin/notes/A-B32', { method: 'DELETE', headers: { Origin: OWN_ORIGIN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: string; files: number };
    expect(body.purged).toBe('A-B32');
    expect(body.files).toBeGreaterThanOrEqual(3);
    expect(await exists(path.join(h.dataDir, 'files', 'A-B32'))).toBe(false);
    expect(await readFile(path.join(h.dataDir, 'files', 'C-D45', 'c.txt'), 'utf8')).toBe('c');
    expect(await fileCount()).toBe(1);
  });

  it('a purge that cannot remove a file still succeeds and keeps the leftover', async () => {
    await insertTextNote(h, 'A-B32', 'doomed');
    await attach('A-B32', Buffer.from('a'), 'a.txt');
    const target = path.join(h.dataDir, 'files', 'A-B32', 'a.txt');
    await rm(target);
    await mkdir(target);
    await writeFile(path.join(target, 'inner'), 'i');
    await h.app.request('/api/notes/A-B32', { method: 'DELETE' });

    const res = await h.app.request('/api/bin/notes/A-B32', { method: 'DELETE', headers: { Origin: OWN_ORIGIN } });
    expect(res.status).toBe(200);
    expect(await fileCount()).toBe(0);
    expect(await exists(path.join(target, 'inner'))).toBe(true);
  });
});
```

**File:** `tests/integration/files.reveal.int.test.ts` (new)
```ts
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { RevealDeps, RevealEnv } from '../../src/http/reveal.js';
import type { Note } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

const ENV: RevealEnv = { explorer: '/mnt/c/Windows/explorer.exe', wslpath: '/usr/bin/wslpath' };
const OWN_ORIGIN = 'http://localhost';

function fakeReveal(over: { detect?: RevealDeps['detect'] } = {}) {
  return {
    detect: vi.fn(over.detect ?? (async (): Promise<RevealEnv | null> => ENV)),
    wslpath: vi.fn(async (abs: string): Promise<string> => `\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`),
    spawn: vi.fn(async (_cmd: string, _args: string[]): Promise<void> => undefined),
  } satisfies RevealDeps;
}

function win(abs: string): string {
  return `\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`;
}

describe('reveal for note files', () => {
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

  async function attachFile(noteId: string, text: string, name: string): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([Buffer.from(text)], name));
    const res = await h.app.request(`/api/notes/${noteId}/files`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  async function attachImage(noteId: string, rgb: { r: number; g: number; b: number }): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([await makeImage('png', 8, 8, rgb)], 'p.png'));
    const res = await h.app.request(`/api/notes/${noteId}/images`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  function post(app: { request: typeof h.app.request }, url: string, origin: string | undefined = OWN_ORIGIN): Promise<Response> {
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers.Origin = origin;
    return Promise.resolve(app.request(url, { method: 'POST', headers }));
  }

  it('selects one file in Explorer', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attachFile('A-B32', 'hello', 'notes.txt')).files[0]!;
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    const res = await post(app, `/api/files/${f.id}/reveal`);
    expect(res.status).toBe(202);
    const abs = path.join(h.dataDir, 'files', 'A-B32', 'notes.txt');
    expect(fake.wslpath).toHaveBeenCalledWith(abs);
    expect(fake.spawn).toHaveBeenCalledWith(ENV.explorer, [`/select,${win(abs)}`]);
  });

  it('refuses foreign origins and unknown ids, and reports a file on another machine', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attachFile('A-B32', 'hello', 'notes.txt')).files[0]!;
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    expect((await post(app, `/api/files/${f.id}/reveal`, undefined)).status).toBe(403);
    expect((await post(app, `/api/files/${f.id}/reveal`, 'http://evil.example')).status).toBe(403);
    const unknown = await post(app, '/api/files/Z-ZZZ/reveal');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
    await rm(path.join(h.dataDir, 'files', 'A-B32', 'notes.txt'));
    const away = await post(app, `/api/files/${f.id}/reveal`);
    expect(away.status).toBe(404);
    expect(await away.json()).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('opens the note files folder when the note has files (images or not)', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await attachImage('A-B32', { r: 1, g: 1, b: 1 });
    await attachFile('A-B32', 'hello', 'notes.txt');
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    const res = await post(app, '/api/notes/a-b32/reveal');
    expect(res.status).toBe(202);
    const dir = path.join(h.dataDir, 'files', 'A-B32');
    expect(fake.wslpath).toHaveBeenCalledWith(dir);
    expect(fake.spawn).toHaveBeenCalledWith(ENV.explorer, [win(dir)]);
  });

  it('selects the first image when the note has no live files', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const withImage = await attachImage('A-B32', { r: 2, g: 2, b: 2 });
    const f = (await attachFile('A-B32', 'gone soon', 'old.txt')).files[0]!;
    await h.app.request(`/api/files/${f.id}`, { method: 'DELETE' });
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    expect((await post(app, '/api/notes/A-B32/reveal')).status).toBe(202);
    const args = fake.spawn.mock.calls[0]![1];
    expect(args).toHaveLength(1);
    expect(args[0]!.startsWith('/select,')).toBe(true);
    expect(args[0]).toContain(`${withImage.images[0]!.id}.png`);
  });

  it('404s a text note, an unknown, malformed or deleted note', async () => {
    await insertTextNote(h, 'A-B32', 'just text');
    await insertTextNote(h, 'C-D45', 'deleted');
    await attachFile('C-D45', 'x', 'x.txt');
    await h.app.request('/api/notes/C-D45', { method: 'DELETE' });
    const fake = fakeReveal();
    const app = createApp(h.deps, { reveal: fake });
    for (const id of ['A-B32', 'Z-ZZZ', 'not-an-id', 'C-D45']) {
      const res = await post(app, `/api/notes/${id}/reveal`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect(fake.detect).not.toHaveBeenCalled();
  });

  it('reports not_on_this_machine when none of the note files is here', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await attachFile('A-B32', 'hello', 'notes.txt');
    await rm(path.join(h.dataDir, 'files', 'A-B32', 'notes.txt'));
    const app = createApp(h.deps, { reveal: fakeReveal() });
    const res = await post(app, '/api/notes/A-B32/reveal');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
  });

  it('answers 409 reveal_unavailable off WSL, and 403 for a foreign origin', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await attachFile('A-B32', 'hello', 'notes.txt');
    const off = createApp(h.deps, { reveal: fakeReveal({ detect: async () => null }) });
    const res = await post(off, '/api/notes/A-B32/reveal');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'reveal_unavailable' });
    expect((await post(off, '/api/notes/A-B32/reveal', 'http://localhost:5173')).status).toBe(403);
  });
});
```

**File:** `tests/integration/files.mcp.int.test.ts` (new)
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function firstText(r: ToolResult): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

describe('MCP sees note files', () => {
  let h: Harness;
  let client: Client;

  beforeAll(async () => {
    h = await startHarness();
    const base = await h.listen();
    client = new Client({ name: 'p4-files-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  afterAll(async () => {
    await client.close();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function attach(noteId: string, bytes: Buffer, name: string): Promise<void> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name));
    const res = await h.app.request(`/api/notes/${noteId}/${name.endsWith('.png') ? 'images' : 'files'}`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
  }

  it('get and list return each note with its files (name, mime, bytes)', async () => {
    await insertTextNote(h, 'A-B32', 'quarterly');
    await attach('A-B32', Buffer.from('a,b\n1,2\n'), 'q3.csv');
    const got = JSON.parse(firstText(await call('get', { ids: ['A-B32'] }))) as { notes: Note[] };
    expect(got.notes[0]!.files).toEqual([
      expect.objectContaining({ name: 'q3.csv', mime: 'text/csv', bytes: 8, extraction_status: 'none', available: true }),
    ]);
    const listed = JSON.parse(firstText(await call('list', {}))) as { notes: Note[] };
    expect(listed.notes.find((n) => n.id === 'A-B32')!.files.map((f) => f.name)).toEqual(['q3.csv']);
  });

  it('view_images names the files of a text note and of an image note', async () => {
    await insertTextNote(h, 'A-B32', 'text with a file');
    await attach('A-B32', Buffer.from('hello'), 'notes.txt');
    const text = await call('view_images', { ids: ['A-B32'] });
    expect(firstText(text)).toContain('files: notes.txt (text/plain, 5 B)');
    expect(firstText(text)).toContain('(text note: it has no image)');

    await insertTextNote(h, 'C-D45', 'photo with a file');
    await attach('C-D45', await makeImage('png', 8, 8, { r: 5, g: 5, b: 5 }), 'p.png');
    await attach('C-D45', Buffer.from('%PDF-1.4\n'), 'spec.pdf');
    const pic = await call('view_images', { ids: ['C-D45'] });
    expect(firstText(pic)).toMatch(/files: spec\.pdf \(application\/pdf, \d+ B\)/);
  });
});
```
(`insertTextNote` writes `tags = '{}'` directly, so the test lists without a tag filter.)

**File:** `tests/integration/migration0004.int.test.ts` (new)
```ts
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { noteFiles, notes } from '../../src/db/schema.js';
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js';

/**
 * Migration 0004 on a 0003-shaped database: it adds `note_files` and changes nothing else. Runs
 * in its own database inside the Docker container so the shared test DB is not disturbed.
 */

const DB_PREFIX = 'mcp_notes_mig0004_';

type Journal = { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;

function urlForDatabase(name: string): string {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

async function dropStaleDatabases(admin: Db): Promise<void> {
  const res = await admin.execute<{ datname: string }>(sql`select datname from pg_database where starts_with(datname, ${DB_PREFIX})`);
  for (const row of res.rows) await admin.execute(sql.raw(`drop database if exists "${row.datname}" with (force)`));
}

/** A migrations folder holding the journal entries with idx <= maxIdx. */
async function migrationsUpTo(maxIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0004-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 4 && kept[4]?.tag !== '0004_note_files') throw new Error('journal entry 4 is not 0004_note_files');
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

async function snapshot(db: Db): Promise<unknown[]> {
  const n = await db.execute(sql`select * from notes order by id`);
  const i = await db.execute(sql`select * from note_images order by id`);
  return [n.rows, i.rows];
}

describe('migration 0004 (note_files)', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: Db;
  let mig: Db;
  const dirs: string[] = [];
  let before: unknown[];

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl());
    await dropStaleDatabases(admin);
    await admin.execute(sql.raw(`create database "${dbName}"`));
    mig = createDb(urlForDatabase(dbName));

    const upTo3 = await migrationsUpTo(3);
    dirs.push(upTo3);
    await migrate(mig, { migrationsFolder: upTo3 });
    const t = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'note_files'`,
    );
    expect(t.rows[0]?.n).toBe(0);

    await mig.execute(sql`insert into notes (id, body, tags) values ('A-B32', 'kept #x', '{x}'), ('C-D45', 'photo', '{}')`);
    await mig.execute(
      sql`insert into note_images (id, note_id, path, sha256, mime, width, height, bytes, host, position)
          values ('C-D45', 'C-D45', 'images/2026/10/C-D45.png', 'img-sha', 'image/png', 4, 4, 10, 'h', 0)`,
    );
    before = await snapshot(mig);

    const upTo4 = await migrationsUpTo(4);
    dirs.push(upTo4);
    await migrate(mig, { migrationsFolder: upTo4 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0003', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(5);
  });

  it('leaves notes and note_images untouched', async () => {
    expect(await snapshot(mig)).toEqual(before);
  });

  it('creates note_files with the planned columns, defaults and indexes', async () => {
    const cols = await mig.execute<{ column_name: string; is_nullable: string; column_default: string | null }>(
      sql`select column_name, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'note_files' order by ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'id',
      'note_id',
      'path',
      'sha256',
      'mime',
      'bytes',
      'original_name',
      'host',
      'position',
      'extracted_text',
      'extraction_status',
      'created_at',
      'deleted_at',
    ]);
    const status = cols.rows.find((c) => c.column_name === 'extraction_status');
    expect(status?.is_nullable).toBe('NO');
    expect(status?.column_default).toContain("'none'");
    expect(cols.rows.find((c) => c.column_name === 'extracted_text')?.is_nullable).toBe('YES');

    const idx = await mig.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'note_files'`);
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([
      'note_files_note_position_idx',
      'note_files_path_uniq',
      'note_files_pkey',
      'note_files_sha256_live_uniq',
    ]);
  });

  it('defaults extraction to none, refuses unknown statuses, and keeps sha256 unique among live files', async () => {
    const base = { noteId: 'A-B32', mime: 'text/plain', bytes: 1, originalName: 'a.txt', host: 'h' };
    const [row] = await mig.insert(noteFiles).values({ ...base, id: 'F-1L3', path: 'files/A-B32/a.txt', sha256: 's1', position: 0 }).returning();
    expect(row?.extractionStatus).toBe('none');
    expect(row?.extractedText).toBeNull();
    expect(row?.deletedAt).toBeNull();

    const bad = await mig
      .execute(sql`update note_files set extraction_status = 'bogus' where id = 'F-1L3'`)
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(bad)).toBe('23514');

    const dupSha = await mig
      .insert(noteFiles)
      .values({ ...base, id: 'G-2M4', path: 'files/A-B32/b.txt', sha256: 's1', position: 1 })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(dupSha)).toBe('23505');

    const dupPath = await mig
      .insert(noteFiles)
      .values({ ...base, id: 'G-2M4', path: 'files/A-B32/a.txt', sha256: 's2', position: 1 })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(dupPath)).toBe('23505');

    await mig.update(noteFiles).set({ deletedAt: new Date() }).where(eq(noteFiles.id, 'F-1L3'));
    await mig.insert(noteFiles).values({ ...base, id: 'G-2M4', path: 'files/A-B32/b.txt', sha256: 's1', position: 1 });
  });

  it('cascades with its note', async () => {
    await mig.delete(notes).where(eq(notes.id, 'A-B32'));
    const left = await mig.execute<{ n: number }>(sql`select count(*)::int as n from note_files where note_id = 'A-B32'`);
    expect(left.rows[0]?.n).toBe(0);
  });
});
```
The `note_images` insert above uses the 0002 columns (`taken_at`, `original_name`, `created_at`, `deleted_at` take defaults/null). If Phase 3's 0003 changed `note_images` (it should not), adjust the insert to it.

### Step 24: Docs
**File:** `README.md:668-678` (HTTP API table) and `:684-705` (Where things are stored)
**Change:** after the `POST /api/images/:imageId/restore` row add:
```markdown
| `POST /api/notes/:id/files` | Multipart `file`, attached to that live note: 201 `{note, attached: true, kind}`, or 200 with the note that already holds the bytes. `kind` is `image` when the bytes are a picture (stored as a photo), else `file`. 413 `too_large` over 200 MB |
| `GET /api/files/:fileId` | One file's metadata (`name`, `mime`, `bytes`, `host`, `available`, `extraction_status`), whatever its state |
| `GET /api/files/:fileId/download` | The file, always as an attachment (`nosniff`, sandboxed); 404 `not_on_this_machine` when it lives elsewhere |
| `DELETE /api/files/:fileId` · `POST /api/files/:fileId/restore` | Remove one file from its note (soft) / put it back at its old place; 409 `duplicate_file` with the holder's `note_id` |
```
after the `POST /api/images/:imageId/reveal` row add:
```markdown
| `POST /api/files/:fileId/reveal` | Open Explorer with the file selected. Same-origin requests only |
| `POST /api/notes/:id/reveal` | Open the note's `files/<noteId>/` folder in Explorer, or select its first photo when it has no files. Same-origin requests only |
```
In the storage block add, after the `note_images(...)` lines:
```
           note_files(id, note_id, path, sha256, mime, bytes, original_name, host, position,
                      extracted_text, extraction_status, created_at, deleted_at)
```
and after the `images/YYYY/MM/<imageId>.<ext>` line:
```
  files/<noteId>/<name>            a note's other files, byte for byte, Windows-safe names
```
and after the paragraph that starts `Each photo is one note_images row` add:
```markdown
Any other file attached to a note is one `note_files` row with its own id from the same id
space. It is stored under `files/<noteId>/` with a Windows-safe version of its name (`name (2).ext`
when the name is taken), so one folder holds everything a note carries. Dedupe is by `sha256`
among files that have not been removed. `extracted_text` and `extraction_status` are there for a
later text extraction; nothing fills them yet. Delete forever on a note removes its files and
then its folder.
```
**File:** `CHANGELOG.md`
**Change:** under `## [Unreleased]` → `### Added` (create both headings above `## [v0.1.0]` if earlier phases have not), one line:
```markdown
- **Note files (server)**: `note_files` table (migration 0004), `files/<noteId>/` store with sha256 dedupe, attach/remove/restore/download routes, per-file and note-level reveal, and `files` on every note for MCP and the chat agent.
```

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test && npm run test:int`
Focused runs while implementing:
```bash
npx vitest run tests/unit/files.name.test.ts tests/unit/files.store.test.ts tests/unit/mcp.describe.test.ts tests/unit/reveal.test.ts tests/unit/notes.helpers.test.ts tests/unit/mcp.instructions.test.ts tests/unit/chat-prompt.test.ts
npm run test:int -- tests/integration/migration0004.int.test.ts tests/integration/files.int.test.ts tests/integration/files.reveal.int.test.ts tests/integration/files.mcp.int.test.ts
npm run test:int -- tests/integration/bin.int.test.ts tests/integration/images.attach.int.test.ts tests/integration/reveal.int.test.ts tests/integration/schema.int.test.ts
```
Migration chain:
```bash
ls drizzle/*.sql            # 0000 .. 0004_note_files.sql, no gaps
npx drizzle-kit check       # "Everything's fine"
```
**Manual check (optional, local daemon on a scratch data dir):** `curl -F file=@README.md http://127.0.0.1:7317/api/notes/<id>/files` returns 201 with `kind: "file"`; `curl -I http://127.0.0.1:7317/api/files/<fileId>/download` shows `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, CSP `sandbox`; `/n what is in note <id>` names the file with type and size. Never point a manual check at the production data dir.
**Exit criteria:** attach/dedupe/remove/restore/purge/download/reveal are covered by the new integration tests and pass; the same bytes uploaded to two notes return the holder (`attached: false`); downloads are `attachment` with `nosniff`; MCP `get`/`list` include `files` and `view_images` text names them; migration 0004 applies on a 0003 database and changes nothing else; `npm run typecheck`, `npm test`, `npm run test:int`, `npm run build` all pass; no file under `web/` changed except `web/src/types.ts`.

## Handoffs

- **Phase 5 (R2, UI):** consume the wire contract above. `web/src/types.ts` has `Note.files?: NoteFile[]`, and it stays optional (plan Decision): P5 reads `note.files ?? []` and is the only phase that adds `files: []` to the web `makeNote` fixture (`web/src/testing/fixtures.ts`); this phase touches no web fixture. `web/src/api.ts` needs `attachFile(noteId, file)` -> `POST /api/notes/:id/files` (handle `kind`), `removeFile`, `restoreFile`, `revealFile(fileId)` -> `POST /api/files/:id/reveal`, `revealNote(noteId)` -> `POST /api/notes/:id/reveal`, and a `DuplicateFileError` mirroring `DuplicateImageError` for 409 `duplicate_file`. The note-level reveal button should call the note route (it already falls back to the first image server-side). Empty-note rules must count `files`.
- **Phase 6 (R5):** edits `src/mcp/instructions.ts` and `claude/skills/n/SKILL.md` after this phase; keep the `Files.` paragraph and the `## Files` section. P6's migration is 0005 on top of `0004_note_files`. `similar_images` must never return files (they are not in `note_images`).
- **Phase 7 (R3):** chat message attachments that point at "note files by id" can rely on `note_files.id` (A-B32, shared id space) and `GET /api/files/:id`.
- **Not done (out of scope per the index):** text extraction (schema only), files in the recycle-bin view and `listBin`, `purgeFile`, an MCP `attach_file` tool, a `has_file` list filter. None of these serve a requirement this phase owns.

## Rollback

Revert this phase's commits. That removes the routes, service methods, `files` on the wire and the docs. The database keeps `note_files` (migration 0004 only adds it), which is harmless to older code. To drop it by hand, on a database where no later migration depends on it:
```sql
DROP TABLE IF EXISTS note_files;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations);  -- only if 0004 is the newest applied
```
and delete `drizzle/0004_note_files.sql`, `drizzle/meta/0004_snapshot.json` and its `_journal.json` entry in the same revert. Files already stored stay under `<dataDir>/files/`; remove that folder by hand if wanted.
