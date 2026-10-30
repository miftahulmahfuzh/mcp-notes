> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 1. Source: `.workflows/plan/wall-editing/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: `note_images` table, migration 0002, legacy copy/reconcile, image repo

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R1 (per-image table, lossless live migration that keeps the old columns), R5 (the migration and repo integration tests)
**Depends on:** none
**Difficulty:** HARD
**Package:** `src/db`, `drizzle`, `src/notes`, `src/images`

---

## Goal

The database has a `note_images` table (exact Contract shape), created by `drizzle/0002_note_images.sql`. The same migration copies every legacy image (live notes and soft-deleted notes) into exactly one identical row. `reconcileLegacyImages` (`src/images/legacy.ts`) runs the identical copy statement idempotently, so phase 2 can call it at daemon start. `src/notes/imageRepo.ts` provides the contracted read/write primitives. No application code reads the new table yet. Every existing test passes unchanged, apart from the schema test's index list and migration count.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- table `note_images` + indexes `note_images_pkey`, `note_images_path_uniq`, `note_images_note_position_idx`, `note_images_sha256_live_uniq`, `note_images_taken_at_idx`, FK `note_images_note_id_notes_id_fk` (cascade) (`drizzle/0002_note_images.sql`, `drizzle/meta/0002_snapshot.json`, `drizzle/meta/_journal.json` entry idx 2 tag `0002_note_images`)
- `schema.noteImages`, `type NoteImageRow`, `type NewNoteImageRow` (`src/db/schema.ts`). `NewNoteImageRow` is not spelled out in the Contract's schema block, but the Contract's `insertImage(db, values: NewNoteImageRow)` uses it. It follows the file's `NewNoteRow` convention.
- `src/notes/imageRepo.ts`: `imagesForNotes`, `findImageById`, `findLiveImageBySha256`, `insertImage`, `nextPosition`, `imageIdTaken`, `setImageDeleted`, plus `interface LiveImageHit`, `const NOTE_IMAGES_SHA_LIVE_INDEX`, `function isLiveShaClash(err)` (exported so phase 2/3 can map a clash raised inside their own transactions)
- `src/images/legacy.ts`: `reconcileLegacyImages(db: Executor): Promise<number>`, `const LEGACY_COPY_SQL`
- `tests/integration/migration0002.int.test.ts`, `tests/integration/imageRepo.int.test.ts`

**Signature changes:** none. `truncateAll(db)` keeps its signature and now also empties `note_images`.

**Exact semantics phase 2+ may rely on:**
- `imagesForNotes(db, ids, opts?)` returns a Map with **one key for every distinct requested id**, each an array (empty when the note has no images). Rows come ordered by `position asc, id asc`. Removed images (`deleted_at` not null) are left out unless `includeRemoved: true`. An empty `ids` gives an empty Map with no query.
- `findImageById` returns the row in any state, or null.
- `findLiveImageBySha256(db, sha)` returns the single image row with `deleted_at is null` for that sha (its note may be soft-deleted: `noteDeletedAt` says so), or null.
- `insertImage` returns the inserted row. A 23505 on `note_images_sha256_live_uniq` becomes `NoteError('duplicate_image')`. Any other error, including 23505 on the PK or on `note_images_path_uniq`, is rethrown unchanged. Inside a transaction, the failed insert aborts that transaction (Postgres semantics), so callers that want to recover must run it outside the transaction or in a savepoint.
- `nextPosition(db, noteId)` = `max(position)` over **all** of the note's rows, removed included, + 1. It is 0 when the note has none.
- `imageIdTaken(db, id)` is true when `id` is a `notes.id` (any state) or a `note_images.id` (any state).
- `setImageDeleted(db, id, true)` sets `deleted_at = coalesce(deleted_at, now())`, which is idempotent and keeps the first removal time. `false` sets it to null. An unknown id gives `NoteError('not_found')`. Restoring into a live sha clash gives `NoteError('duplicate_image')`. The function does not touch the owning note.
- `reconcileLegacyImages` returns the number of rows inserted (0 when nothing is pending). It is safe to run concurrently with itself (`on conflict do nothing`).

**Requires (from earlier phases):** none.

**Leaves alone (owned by others):** `src/notes/{types,repo,service,events}.ts`, `src/images/{records,ingest,derive,store,inbox,probe}.ts`, `src/background.ts` (phase 2 adds the startup reconcile call), `src/http/**`, `src/mcp/**`, `src/chat/**`, `web/**`, `tests/helpers/**`, every other existing test file, README/docs (phase 10), Neon (phase 10 runs `db:migrate`).

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | legacy comments on `image_path`/`image_meta` + their indexes (lines 46-48, 60-63); header comment (lines 4-10); new `noteImages` table after `notes` (after line 65); `NoteImageRow`/`NewNoteImageRow` types (after line 122) |
| `drizzle/0002_note_images.sql` | create (generated + hand-appended) | `CREATE TABLE note_images` DDL, FK, 4 indexes; appended copy `INSERT…SELECT` (= `LEGACY_COPY_SQL`) |
| `drizzle/meta/0002_snapshot.json` | create (generated) | drizzle-kit snapshot; never hand-edited |
| `drizzle/meta/_journal.json` | modify (generated) | entry `{ idx: 2, tag: "0002_note_images" }` |
| `src/notes/imageRepo.ts` | create | contracted repo functions |
| `src/images/legacy.ts` | create | `LEGACY_COPY_SQL`, `reconcileLegacyImages` |
| `tests/integration/setup.ts` | modify (line 50) | `truncateAll` lists `note_images` |
| `tests/integration/schema.int.test.ts` | modify (lines 31, 44-65, 181-187; new test appended before line 215) | new index names, partial-index predicate, migration count 2 → 3 |
| `tests/integration/migration0002.int.test.ts` | create | iteration-6-shaped DB in a separate database → 0002 → lossless, files untouched, reconcile behaviour |
| `tests/integration/imageRepo.int.test.ts` | create | repo functions against the Docker DB |

## Implementation Steps

### Step 0: Prepare the worktree
**File:** worktree root
**Change:** The worktree has no `node_modules`. Run `npm ci` in `/home/miftah/.worktrees/mcp-notes/wall-editing`. `.env.local` is already a symlink in this worktree (checked). Per invariant 8, if it is missing, run `ln -sf /home/miftah/mcp-notes/.env.local .env.local`. drizzle-kit `generate` does not connect, but `drizzle.config.ts` throws without a direct URL. Never run `npm run db:migrate` in this phase: it targets Neon, which phase 10 owns.
**Impact:** none on the tree.

### Step 1: Add `noteImages` to the schema
**File:** `src/db/schema.ts:1-122`
**Change:** Replace the whole file with the version below. It keeps `notes`, `noteRevisions` and `noteEmbeddings` byte-for-byte except comments: legacy notes on `imagePath`, `imageMeta` and the two image indexes, and a header line for 0002. It adds `noteImages` exactly per the Contract and the two row types. Style follows the file (no semicolons).
**Code:**
```ts
import { sql } from 'drizzle-orm'
import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core'

/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`; migration 0002 (iteration 7, wall editing) adds `note_images` and copies every
 * legacy `notes.image_path` / `image_meta` image into it (hand-appended INSERT...SELECT, the same
 * SQL as src/images/legacy.ts `LEGACY_COPY_SQL`). Change a table here, then `npm run db:generate`;
 * never edit an applied migration. drizzle-kit does not emit `CREATE EXTENSION`, so 0001 carries a
 * hand-prepended `CREATE EXTENSION IF NOT EXISTS vector`.
 */

/** `notes.image_meta`. Written by the image ingest (iteration 2). */
export interface ImageMeta {
  /** Lower-case hex sha256 of the original bytes. Unique among non-deleted notes. */
  sha256: string
  /** Sniffed from magic bytes, e.g. `image/jpeg`, `image/heic`. */
  mime: string
  width: number
  height: number
  /** Size of the original file in bytes. */
  bytes: number
  /** EXIF DateTimeOriginal as a UTC ISO-8601 string (`...Z`), or null. Indexed as text. */
  taken_at: string | null
  original_name: string | null
  /** `os.hostname()` of the machine that holds the file. */
  host: string | null
}

/** `notes.origin`: where a note was saved from. */
export interface NoteOrigin {
  cwd?: string
  repo?: string
  claude_session?: string
  /** Ingestion channel, e.g. `mcp`, `web`, `inbox`, `upload`. */
  source?: string
}

export const notes = pgTable(
  'notes',
  {
    /** `A-B32`, canonical upper-case form (see src/notes/ids.ts). */
    id: text('id').primaryKey(),
    body: text('body').notNull(),
    /** Parsed from `#hashtags` in `body` on every write (see src/notes/tags.ts). */
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /**
     * Legacy (iterations 2-6, one image per note), read only by the reconcile
     * (src/images/legacy.ts); dropped in a later migration. Relative to the data dir:
     * `images/YYYY/MM/<id>.<ext>`. Images live in `note_images` since iteration 7.
     */
    imagePath: text('image_path'),
    /** Legacy, read only by the reconcile; dropped in a later migration. See `imagePath`. */
    imageMeta: jsonb('image_meta').$type<ImageMeta>(),
    origin: jsonb('origin').$type<NoteOrigin>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Soft delete. Null means live. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('notes_tags_gin').using('gin', t.tags),
    index('notes_body_fts_gin').using('gin', sql`to_tsvector('simple', ${t.body})`),
    index('notes_created_at_idx').on(t.createdAt),
    index('notes_updated_at_idx').on(t.updatedAt),
    // Legacy, read only by the reconcile; dropped in a later migration (with the two columns).
    uniqueIndex('notes_image_sha256_live_uniq')
      .on(sql`(${t.imageMeta} ->> 'sha256')`)
      .where(sql`${t.imageMeta} is not null and ${t.deletedAt} is null`),
    // Legacy, read only by the reconcile; dropped in a later migration (with the two columns).
    index('notes_image_taken_at_idx').on(sql`(${t.imageMeta} ->> 'taken_at')`),
  ],
)

/**
 * One row per image (iteration 7, migration 0002). A note holds zero or more images, in attach
 * order (`position`, never renumbered). The first image of a note created with an image shares the
 * note's id (so `cache/<noteId>/`, `/full/<noteId>` and `/api/notes/<noteId>/<variant>` stay valid
 * for legacy images); later images get an id free in both `notes.id` and `note_images.id`
 * (src/notes/imageRepo.ts `imageIdTaken`).
 *
 * `deleted_at` is the image's own soft delete (removed from its note, shown in the bin). It is
 * independent of `notes.deleted_at`: the image of a deleted note keeps `deleted_at = null`. The
 * sha256 is unique among rows with `deleted_at is null` (dedupe per live image).
 */
export const noteImages = pgTable(
  'note_images',
  {
    /** Note-id format (`A-B32`). See the comment above. */
    id: text('id').primaryKey(),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** Relative to the data dir: `images/YYYY/MM/<id>.<ext>`. */
    path: text('path').notNull(),
    /** Lower-case hex sha256 of the original bytes. */
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Original size in bytes; the 200 MB upload cap fits int4. */
    bytes: integer('bytes').notNull(),
    /** EXIF DateTimeOriginal, or null. */
    takenAt: timestamp('taken_at', { withTimezone: true, mode: 'date' }),
    originalName: text('original_name'),
    /** `os.hostname()` of the machine that holds the file. */
    host: text('host'),
    /** Attach order within the note; never renumbered (remove + restore keeps it). */
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Removed from its note (in the bin). Null means part of the note. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('note_images_path_uniq').on(t.path),
    index('note_images_note_position_idx').on(t.noteId, t.position),
    uniqueIndex('note_images_sha256_live_uniq').on(t.sha256).where(sql`${t.deletedAt} is null`),
    index('note_images_taken_at_idx').on(t.takenAt),
  ],
)

export const noteRevisions = pgTable(
  'note_revisions',
  {
    /** Revision number used by the `revisions` / `revert` tools. */
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** The body as it was BEFORE the change that wrote this row. */
    body: text('body').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('note_revisions_note_saved_idx').on(t.noteId, t.savedAt.desc())],
)

/**
 * One row per note that has (or had) text to embed. Iteration 6 (semantic search), migration
 * 0001. A side table, not a column on `notes`, so `db.select().from(notes)` (every list, get and
 * search) never drags 1536 floats along, and the vector never enters `NoteRow`.
 *
 * The vector is *current* iff `embedding is not null`, `body_sha256` equals the note's current
 * body hash and `model` equals EMBEDDING_MODEL (src/embeddings/repo.ts `isCurrentEmbeddingSql`).
 * Deleted notes keep their row, so a restore needs no embedding call.
 */
export const noteEmbeddings = pgTable(
  'note_embeddings',
  {
    noteId: text('note_id')
      .primaryKey()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** Null while the latest attempt for `body_sha256` failed. Width = EMBEDDING_DIMENSIONS (unit test asserts it). */
    embedding: vector('embedding', { dimensions: 1536 }),
    /** Hex sha256 of the UTF-8 body this row refers to (embedded, or whose embedding failed). */
    bodySha256: text('body_sha256').notNull(),
    /** Model id the vector came from, e.g. `openai/text-embedding-3-small`. */
    model: text('model').notNull(),
    /** Consecutive failures for this `body_sha256` + `model`; 0 after a success. */
    attempts: integer('attempts').notNull().default(0),
    /** At most 500 chars, keys redacted (src/embeddings/state.ts `clampError`). */
    lastError: text('last_error'),
    /** Failures only: not retried before this time. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    /** When `embedding` was written. Null on a failure row. */
    embeddedAt: timestamp('embedded_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('note_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('note_embeddings_next_attempt_idx').on(t.nextAttemptAt),
  ],
)

export type NoteRow = typeof notes.$inferSelect
export type NewNoteRow = typeof notes.$inferInsert
export type NoteImageRow = typeof noteImages.$inferSelect
export type NewNoteImageRow = typeof noteImages.$inferInsert
export type NoteRevisionRow = typeof noteRevisions.$inferSelect
export type NewNoteRevisionRow = typeof noteRevisions.$inferInsert
```
**Impact:** Additive. `NoteRow` is unchanged, so every consumer still compiles. `noteImages` placed between `notes` and `noteRevisions` only changes table order in drizzle-kit's snapshot, not any existing DDL.

### Step 2: Create `src/images/legacy.ts`
**File:** `src/images/legacy.ts` (new)
**Change:** One exported SQL constant and the reconcile function. The constant is the single source of truth. Step 3 pastes it into the migration, and the migration test asserts the two match (whitespace-normalised).

How the rule works (Contract "Legacy copy + reconcile"):
- Candidates are `notes` rows with both legacy columns set and no `note_images` row with `id = notes.id`.
- `row_number()` per sha256 ranks them: live notes first, then by `notes.deleted_at desc`, then id for determinism. The legacy partial index guarantees at most one live note per sha.
- A candidate gets `deleted_at = null` only when it ranks 1 **and** no live `note_images` row already holds its sha. Otherwise it gets `coalesce(notes.deleted_at, now())`, so the image is kept and shows in the bin.
- `on conflict do nothing` (no target, so it covers the PK and both unique indexes) makes concurrent runs harmless. A row skipped because a concurrent writer took its sha slot is picked up, and binned, by the next run, because its id is still missing.
- The statement must not contain the text `--> statement-breakpoint`, backticks or `${`.

**Code:**
```ts
import { sql } from 'drizzle-orm';
import type { Executor } from '../notes/repo.js';

/**
 * Copies legacy one-image-per-note images (`notes.image_path` + `notes.image_meta`, iterations
 * 2-6) into `note_images`. One INSERT...SELECT, idempotent.
 *
 * Every `notes` row (live or soft-deleted) with both legacy columns set and no `note_images` row
 * whose id is the note id gets exactly one row: id = note_id = notes.id, path = image_path, the
 * metadata from image_meta (taken_at cast to timestamptz), position 0, created_at =
 * notes.created_at. deleted_at is null, except when that would break
 * `note_images_sha256_live_uniq` (an existing live row, or an earlier candidate of the same batch,
 * has the same sha256; candidates are ranked live notes first, then most recently deleted): then
 * deleted_at = coalesce(notes.deleted_at, now()), so the image is kept and shows in the bin.
 *
 * drizzle/0002_note_images.sql ends with this exact statement (tests/integration/
 * migration0002.int.test.ts asserts it). Keep the two identical; never edit the applied migration.
 */
export const LEGACY_COPY_SQL = `insert into note_images (id, note_id, path, sha256, mime, width, height, bytes, taken_at, original_name, host, position, created_at, deleted_at)
select
  c.id,
  c.id,
  c.image_path,
  c.sha256,
  c.image_meta ->> 'mime',
  (c.image_meta ->> 'width')::integer,
  (c.image_meta ->> 'height')::integer,
  (c.image_meta ->> 'bytes')::integer,
  (c.image_meta ->> 'taken_at')::timestamptz,
  c.image_meta ->> 'original_name',
  c.image_meta ->> 'host',
  0,
  c.created_at,
  case
    when c.sha_rank = 1
      and not exists (
        select 1 from note_images l where l.sha256 = c.sha256 and l.deleted_at is null
      )
    then null
    else coalesce(c.deleted_at, now())
  end
from (
  select
    n.id,
    n.image_path,
    n.image_meta,
    n.image_meta ->> 'sha256' as sha256,
    n.created_at,
    n.deleted_at,
    row_number() over (
      partition by n.image_meta ->> 'sha256'
      order by n.deleted_at is not null, n.deleted_at desc, n.id
    ) as sha_rank
  from notes n
  where n.image_path is not null
    and n.image_meta is not null
    and not exists (select 1 from note_images i where i.id = n.id)
) c
on conflict do nothing`;

/**
 * Runs `LEGACY_COPY_SQL`. Returns the number of `note_images` rows inserted (0 when every legacy
 * image already has its row). Phase 2 calls it once at daemon start, so images the old daemon
 * ingested between the Neon migration and the restart are picked up.
 */
export async function reconcileLegacyImages(db: Executor): Promise<number> {
  const res = await db.execute(sql.raw(LEGACY_COPY_SQL));
  return res.rowCount ?? 0;
}
```
**Impact:** New module with no callers in this phase. It reads `notes` and writes `note_images` only.

### Step 3: Generate migration 0002 and append the copy statement
**File:** `drizzle/0002_note_images.sql` (new), `drizzle/meta/0002_snapshot.json` (new), `drizzle/meta/_journal.json` (modified)
**Change:**
1. In the worktree root: `npx drizzle-kit generate --name note_images`. It must produce exactly `drizzle/0002_note_images.sql`, a new snapshot, and a third journal entry (`"idx": 2`, `"tag": "0002_note_images"`, `when` greater than 0001's `1793345807038`). If drizzle-kit asks any rename/drop question, or the generated SQL contains anything that touches `notes`, `note_revisions` or `note_embeddings`, stop: the schema edit is wrong.
2. The generated file should read as below (drizzle-kit 0.31 output for Step 1's table; compare it, do not retype it):
```sql
CREATE TABLE "note_images" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"taken_at" timestamp with time zone,
	"original_name" text,
	"host" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "note_images" ADD CONSTRAINT "note_images_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_images_path_uniq" ON "note_images" USING btree ("path");--> statement-breakpoint
CREATE INDEX "note_images_note_position_idx" ON "note_images" USING btree ("note_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "note_images_sha256_live_uniq" ON "note_images" USING btree ("sha256") WHERE "note_images"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "note_images_taken_at_idx" ON "note_images" USING btree ("taken_at");
```
3. Hand-append, directly after the last generated line, a breakpoint and the copy statement. Paste it **verbatim** from `LEGACY_COPY_SQL` (Step 2), ending with `;`. The file's tail becomes:
```sql
CREATE INDEX "note_images_taken_at_idx" ON "note_images" USING btree ("taken_at");--> statement-breakpoint
insert into note_images (id, note_id, path, sha256, mime, width, height, bytes, taken_at, original_name, host, position, created_at, deleted_at)
select
  c.id,
  c.id,
  c.image_path,
  c.sha256,
  c.image_meta ->> 'mime',
  (c.image_meta ->> 'width')::integer,
  (c.image_meta ->> 'height')::integer,
  (c.image_meta ->> 'bytes')::integer,
  (c.image_meta ->> 'taken_at')::timestamptz,
  c.image_meta ->> 'original_name',
  c.image_meta ->> 'host',
  0,
  c.created_at,
  case
    when c.sha_rank = 1
      and not exists (
        select 1 from note_images l where l.sha256 = c.sha256 and l.deleted_at is null
      )
    then null
    else coalesce(c.deleted_at, now())
  end
from (
  select
    n.id,
    n.image_path,
    n.image_meta,
    n.image_meta ->> 'sha256' as sha256,
    n.created_at,
    n.deleted_at,
    row_number() over (
      partition by n.image_meta ->> 'sha256'
      order by n.deleted_at is not null, n.deleted_at desc, n.id
    ) as sha_rank
  from notes n
  where n.image_path is not null
    and n.image_meta is not null
    and not exists (select 1 from note_images i where i.id = n.id)
) c
on conflict do nothing;
```
4. Do not edit `0002_snapshot.json` or the journal by hand. The appended DML is invisible to the snapshot. Run `npx drizzle-kit check`: it must report no issues.
5. Append before the first `npm run test:int`. The drizzle migrator records only `created_at`, not a hash check, so a Docker DB migrated with a DDL-only 0002 will not re-run it. That is harmless (the test DB is truncated and `migration0002.int.test.ts` uses its own fresh database), but it means the Docker DB never exercised the appended statement.

**Impact:** `migrateTestDb()` (globalSetup) applies 0002 to the Docker DB on the next `test:int`. On an empty or truncated DB the copy inserts 0 rows. Migration is additive (invariant 4): no `ALTER`/`DROP` on existing objects.

### Step 4: Create `src/notes/imageRepo.ts`
**File:** `src/notes/imageRepo.ts` (new)
**Change:** The Contract's repo functions. It imports `Executor` from `./repo.js` (type only; `repo.ts` is not modified) and `NoteError` from `./types.js`. A local error walker mirrors `repo.ts`'s private `pgErrorCode`, because that file belongs to phase 2. The walker also reads `constraint`, falling back to the message text for drivers that do not set it.
**Code:**
```ts
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { noteImages, notes, type NewNoteImageRow, type NoteImageRow } from '../db/schema.js';
import type { Executor } from './repo.js';
import { NoteError } from './types.js';

/**
 * Data access for `note_images` (iteration 7). Nothing here touches `notes.image_path` /
 * `notes.image_meta`; the one-off copy of those legacy columns lives in src/images/legacy.ts.
 */

/** Name of the partial unique index that keeps sha256 unique among live (non-removed) images. */
export const NOTE_IMAGES_SHA_LIVE_INDEX = 'note_images_sha256_live_uniq';

/** A live image found by sha256, with its note's soft-delete time (null = note is live). */
export interface LiveImageHit {
  image: NoteImageRow;
  noteDeletedAt: Date | null;
}

interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
  message: string;
}

/** First object in the `cause` chain that carries a string `code` (pg DatabaseError, wrapped by Drizzle). */
function pgErrorInfo(err: unknown): PgErrorInfo | undefined {
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

/**
 * True when `err` is a unique violation (23505) of `note_images_sha256_live_uniq`: the image's
 * bytes already live in another non-removed image. Exported so callers can map a clash raised
 * inside their own transaction.
 */
export function isLiveShaClash(err: unknown): boolean {
  const info = pgErrorInfo(err);
  if (!info || info.code !== '23505') return false;
  if (info.constraint !== undefined) return info.constraint === NOTE_IMAGES_SHA_LIVE_INDEX;
  return info.message.includes(NOTE_IMAGES_SHA_LIVE_INDEX);
}

/**
 * Images of the given notes, keyed by note id, each list ordered by position (then id). Every
 * distinct requested id is a key; a note without images maps to []. Removed images
 * (`deleted_at` set) are left out unless `includeRemoved` is true.
 */
export async function imagesForNotes(
  db: Executor,
  noteIds: readonly string[],
  opts: { includeRemoved?: boolean } = {},
): Promise<Map<string, NoteImageRow[]>> {
  const ids = [...new Set(noteIds)];
  const out = new Map<string, NoteImageRow[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  const conds: SQL[] = [inArray(noteImages.noteId, ids)];
  if (!opts.includeRemoved) conds.push(isNull(noteImages.deletedAt));
  const rows = await db
    .select()
    .from(noteImages)
    .where(and(...conds))
    .orderBy(asc(noteImages.noteId), asc(noteImages.position), asc(noteImages.id));
  for (const row of rows) out.get(row.noteId)?.push(row);
  return out;
}

/** One image in any state (live, removed, or in a deleted note), or null. */
export async function findImageById(db: Executor, id: string): Promise<NoteImageRow | null> {
  const rows = await db.select().from(noteImages).where(eq(noteImages.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * The non-removed image holding these bytes, or null. At most one exists
 * (`note_images_sha256_live_uniq`). Its note may be soft-deleted: `noteDeletedAt` says so.
 */
export async function findLiveImageBySha256(db: Executor, sha256: string): Promise<LiveImageHit | null> {
  const rows = await db
    .select({ image: noteImages, noteDeletedAt: notes.deletedAt })
    .from(noteImages)
    .innerJoin(notes, eq(notes.id, noteImages.noteId))
    .where(and(eq(noteImages.sha256, sha256), isNull(noteImages.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { image: row.image, noteDeletedAt: row.noteDeletedAt } : null;
}

/**
 * Inserts one image row and returns it. A clash on the live-sha256 index throws
 * NoteError('duplicate_image'); any other error (including a taken id or path) is rethrown as is.
 * Inside a transaction a failed insert aborts that transaction.
 */
export async function insertImage(db: Executor, values: NewNoteImageRow): Promise<NoteImageRow> {
  let rows: NoteImageRow[];
  try {
    rows = await db.insert(noteImages).values(values).returning();
  } catch (err) {
    if (isLiveShaClash(err)) {
      throw new NoteError('duplicate_image', 'A live image with the same sha256 already exists.');
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw new Error(`insertImage: no row returned for image ${values.id}`);
  return row;
}

/** Position for the next image attached to `noteId`: max over all its rows (removed included) + 1, or 0. */
export async function nextPosition(db: Executor, noteId: string): Promise<number> {
  const rows = await db
    .select({ next: sql<number>`coalesce(max(${noteImages.position}) + 1, 0)::int` })
    .from(noteImages)
    .where(eq(noteImages.noteId, noteId));
  return Number(rows[0]?.next ?? 0);
}

/** True when `id` is already used as a note id or an image id (any state). */
export async function imageIdTaken(db: Executor, id: string): Promise<boolean> {
  const res = await db.execute<{ taken: boolean }>(
    sql`select (exists (select 1 from ${notes} where ${notes.id} = ${id})
             or exists (select 1 from ${noteImages} where ${noteImages.id} = ${id})) as taken`,
  );
  return res.rows[0]?.taken === true;
}

/**
 * Removes (`deleted: true`) or restores (`false`) one image and returns the updated row. Removing
 * is idempotent and keeps the first removal time. Unknown id → NoteError('not_found'); restoring
 * while another live image holds the same bytes → NoteError('duplicate_image'). The owning note
 * is not touched.
 */
export async function setImageDeleted(db: Executor, id: string, deleted: boolean): Promise<NoteImageRow> {
  let rows: NoteImageRow[];
  try {
    rows = await db
      .update(noteImages)
      .set({ deletedAt: deleted ? sql`coalesce(${noteImages.deletedAt}, now())` : null })
      .where(eq(noteImages.id, id))
      .returning();
  } catch (err) {
    if (isLiveShaClash(err)) {
      throw new NoteError('duplicate_image', `Another live image already holds the same bytes as image ${id}.`);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Image ${id} does not exist.`);
  return row;
}
```
**Impact:** New module with no callers in this phase.

### Step 5: `truncateAll` empties `note_images`
**File:** `tests/integration/setup.ts:48-51`
**Change:** Replace the function.
**Code:**
```ts
/** Empties every app table. Call in `beforeEach` of any file that writes. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table note_images, note_embeddings, note_revisions, notes restart identity cascade`)
}
```
**Impact:** Every integration file that truncates now also empties `note_images`. `cascade` already covered it through the FK; listing it makes the intent explicit.

### Step 6: Schema test knows 0002
**File:** `tests/integration/schema.int.test.ts`
**Change:**
- (a) line 31: describe title.
- (b) lines 44-65: index list gains the five `note_images` indexes.
- (c) lines 181-187: migration count 2 → 3.
- (d) a new test before the closing `})` on line 215: the partial predicate, path uniqueness and cascade.
- Add `noteImages` to the schema import on line 5.

**Code:** line 5 becomes
```ts
import { noteEmbeddings, noteImages, noteRevisions, notes, type ImageMeta } from '../../src/db/schema.js'
```
line 31 becomes
```ts
describe('schema (migrations 0000 + 0001 + 0002)', () => {
```
lines 44-65 become
```ts
  it('creates every index the plan set relies on', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' order by indexname`,
    )
    const names = res.rows.map((r) => r.indexname)
    expect(names).toEqual(
      expect.arrayContaining([
        'notes_pkey',
        'notes_tags_gin',
        'notes_body_fts_gin',
        'notes_created_at_idx',
        'notes_updated_at_idx',
        'notes_image_sha256_live_uniq',
        'notes_image_taken_at_idx',
        'note_revisions_pkey',
        'note_revisions_note_saved_idx',
        'note_embeddings_pkey',
        'note_embeddings_embedding_hnsw_idx',
        'note_embeddings_next_attempt_idx',
        'note_images_pkey',
        'note_images_path_uniq',
        'note_images_note_position_idx',
        'note_images_sha256_live_uniq',
        'note_images_taken_at_idx',
      ]),
    )
  })
```
lines 181-187 become
```ts
  it('re-applying the migrations is a no-op', async () => {
    const count = async () =>
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]?.n
    expect(await count()).toBe(3)
    await migrateTestDb()
    expect(await count()).toBe(3)
  })
```
new test, inserted after the `'cascades note_embeddings when a note row is removed'` test (before the final `})`):
```ts
  it('keeps note_images sha256 unique among live images, paths unique, and cascades on note removal', async () => {
    const def = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'note_images_sha256_live_uniq'`,
    )
    expect(def.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* USING btree \(sha256\) WHERE \(deleted_at IS NULL\)/)

    await db.insert(notes).values({ id: 'A-A01', body: '' })
    const base = { noteId: 'A-A01', sha256: 'same', mime: 'image/png', width: 1, height: 1, bytes: 1 }
    await db.insert(noteImages).values({ ...base, id: 'A-A01', path: 'images/2026/10/A-A01.png', position: 0 })
    const dupSha = await db
      .insert(noteImages)
      .values({ ...base, id: 'B-B01', path: 'images/2026/10/B-B01.png', position: 1 })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(dupSha)).toBe('23505')

    await db.insert(noteImages).values({
      ...base,
      id: 'B-B01',
      path: 'images/2026/10/B-B01.png',
      position: 1,
      deletedAt: new Date(),
    })
    const dupPath = await db
      .insert(noteImages)
      .values({ ...base, sha256: 'other', id: 'C-C01', path: 'images/2026/10/A-A01.png', position: 2 })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(dupPath)).toBe('23505')

    await db.delete(notes).where(eq(notes.id, 'A-A01'))
    expect(await db.select().from(noteImages)).toHaveLength(0)
  })
```
**Impact:** The schema test now asserts 0002. No other existing test counts migrations or lists tables (grepped).

### Step 7: Migration integration test
**File:** `tests/integration/migration0002.int.test.ts` (new)
**Change:** The test builds a separate database `mcp_notes_mig0002_<pid>_<rand>` in the Docker container, using the `TEST_DATABASE_URL` connection (superuser `postgres`; `testDatabaseUrl()` refuses Neon). It migrates 0000+0001 from a temp folder holding copies of those two SQL files and a journal trimmed to their two entries. Then it inserts iteration-6-shaped rows through the unchanged `notes` table object and writes their originals into a temp data dir. Next it applies the real `drizzle/` folder: the migrator skips 0000/0001 by `created_at` and applies only 0002. Finally it asserts. `afterAll` drops the database with `(force)`. `beforeAll` first drops leftovers from crashed runs.

Fixture set:
- **live:** `A-001` (HEIC, taken_at, name, host), `A-002` (PNG, taken/name/host null)
- **deleted:** `B-001`
- **text:** `C-001` live, `C-002` deleted
- **sha clash with a live holder:** `D-001` live, `D-002` deleted 10-01, `D-003` deleted 10-20, same bytes
- **sha clash with no live holder:** `E-001` deleted 10-05, `E-002` deleted 10-25, same bytes

Expected `deleted_at`: null for A-001, A-002, B-001, D-001 and E-002 (rank 1); D-002 gets 10-01, D-003 gets 10-20, E-001 gets 10-05 (each its note's own deleted time).

**Code:**
```ts
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { asc, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb, createDb, type Db } from '../../src/db/client.js'
import { noteImages, notes, type ImageMeta, type NoteImageRow } from '../../src/db/schema.js'
import { LEGACY_COPY_SQL, reconcileLegacyImages } from '../../src/images/legacy.js'
import { insertImage } from '../../src/notes/imageRepo.js'
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js'

/**
 * Migration 0002 on an iteration-6-shaped database: every legacy image (live notes, soft-deleted
 * notes, sha256 clashes) gets exactly one identical `note_images` row, nothing else changes, and
 * the image files are untouched. Runs in its own database inside the Docker container so the
 * shared test DB (already at 0002) is not disturbed.
 */

const DB_PREFIX = 'mcp_notes_mig0002_'

interface LegacyImage {
  bytes: Buffer
  ext: string
  mime: string
  width: number
  height: number
  takenAt: string | null
  originalName: string | null
  host: string | null
}

interface LegacyNote {
  id: string
  body: string
  createdAt: string
  deletedAt: string | null
  image: LegacyImage | null
}

interface FileFacts {
  sha256: string
  size: number
  mtimeMs: number
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function imagePathOf(n: LegacyNote): string | null {
  return n.image ? `images/2026/09/${n.id}.${n.image.ext}` : null
}

function metaOf(n: LegacyNote): ImageMeta | null {
  if (!n.image) return null
  return {
    sha256: sha256Hex(n.image.bytes),
    mime: n.image.mime,
    width: n.image.width,
    height: n.image.height,
    bytes: n.image.bytes.length,
    taken_at: n.image.takenAt,
    original_name: n.image.originalName,
    host: n.image.host,
  }
}

const SAME_D = Buffer.from('legacy photo D, uploaded three times')
const SAME_E = Buffer.from('legacy photo E, uploaded twice, both deleted')

function jpeg(bytes: Buffer): LegacyImage {
  return { bytes, ext: 'jpg', mime: 'image/jpeg', width: 640, height: 480, takenAt: null, originalName: 'dup.jpg', host: 'laptop-a' }
}

const FIXTURES: LegacyNote[] = [
  {
    id: 'A-001',
    body: 'live photo with exif #trip',
    createdAt: '2026-09-01T10:00:00.123Z',
    deletedAt: null,
    image: {
      bytes: Buffer.from('legacy photo A-001'),
      ext: 'heic',
      mime: 'image/heic',
      width: 4032,
      height: 3024,
      takenAt: '2026-08-14T09:30:00.000Z',
      originalName: 'IMG_0001.HEIC',
      host: 'laptop-a',
    },
  },
  {
    id: 'A-002',
    body: '',
    createdAt: '2026-09-02T11:00:00.000Z',
    deletedAt: null,
    image: {
      bytes: Buffer.from('legacy screenshot A-002'),
      ext: 'png',
      mime: 'image/png',
      width: 1920,
      height: 1080,
      takenAt: null,
      originalName: null,
      host: null,
    },
  },
  {
    id: 'B-001',
    body: 'deleted photo',
    createdAt: '2026-09-03T12:00:00.000Z',
    deletedAt: '2026-10-10T08:00:00.000Z',
    image: jpeg(Buffer.from('legacy photo B-001')),
  },
  { id: 'C-001', body: 'a text note #seer', createdAt: '2026-09-04T13:00:00.000Z', deletedAt: null, image: null },
  { id: 'C-002', body: 'a deleted text note', createdAt: '2026-09-05T14:00:00.000Z', deletedAt: '2026-10-11T09:00:00.000Z', image: null },
  { id: 'D-001', body: 'live holder of D', createdAt: '2026-09-06T15:00:00.000Z', deletedAt: null, image: jpeg(SAME_D) },
  { id: 'D-002', body: 'older deleted copy of D', createdAt: '2026-09-07T16:00:00.000Z', deletedAt: '2026-10-01T10:00:00.000Z', image: jpeg(SAME_D) },
  { id: 'D-003', body: 'newer deleted copy of D', createdAt: '2026-09-08T17:00:00.000Z', deletedAt: '2026-10-20T10:00:00.000Z', image: jpeg(SAME_D) },
  { id: 'E-001', body: 'older deleted copy of E', createdAt: '2026-09-09T18:00:00.000Z', deletedAt: '2026-10-05T10:00:00.000Z', image: jpeg(SAME_E) },
  { id: 'E-002', body: 'newer deleted copy of E', createdAt: '2026-09-10T19:00:00.000Z', deletedAt: '2026-10-25T10:00:00.000Z', image: jpeg(SAME_E) },
]

/** The image row's expected deleted_at (ISO) per note id; null = part of its note. */
const EXPECTED_IMAGE_DELETED_AT: Record<string, string | null> = {
  'A-001': null,
  'A-002': null,
  'B-001': null,
  'D-001': null,
  'D-002': '2026-10-01T10:00:00.000Z',
  'D-003': '2026-10-20T10:00:00.000Z',
  'E-001': '2026-10-05T10:00:00.000Z',
  'E-002': null,
}

function urlForDatabase(name: string): string {
  const u = new URL(testDatabaseUrl())
  u.pathname = `/${name}`
  return u.toString()
}

async function dropStaleDatabases(admin: Db): Promise<void> {
  const res = await admin.execute<{ datname: string }>(
    sql`select datname from pg_database where starts_with(datname, ${DB_PREFIX})`,
  )
  for (const row of res.rows) {
    await admin.execute(sql.raw(`drop database if exists "${row.datname}" with (force)`))
  }
}

/** A migrations folder holding only 0000 and 0001: the iteration-6 schema. */
async function iteration6MigrationsFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-mig0002-migrations-'))
  await mkdir(path.join(dir, 'meta'))
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[]
  } & Record<string, unknown>
  const kept = journal.entries.filter((e) => e.tag === '0000_init' || e.tag === '0001_note_embeddings')
  if (kept.length !== 2) throw new Error('drizzle/meta/_journal.json lost 0000_init or 0001_note_embeddings')
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2))
  for (const e of kept) {
    await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`))
  }
  return dir
}

async function snapshotFiles(root: string): Promise<Record<string, FileFacts>> {
  const out: Record<string, FileFacts> = {}
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else {
        const buf = await readFile(abs)
        const st = await stat(abs)
        out[path.relative(root, abs)] = { sha256: sha256Hex(buf), size: st.size, mtimeMs: st.mtimeMs }
      }
    }
  }
  await walk(root)
  return out
}

async function insertLegacyNote(db: Db, n: LegacyNote): Promise<void> {
  await db.insert(notes).values({
    id: n.id,
    body: n.body,
    imagePath: imagePathOf(n),
    imageMeta: metaOf(n),
    createdAt: new Date(n.createdAt),
    updatedAt: new Date(n.deletedAt ?? n.createdAt),
    deletedAt: n.deletedAt === null ? null : new Date(n.deletedAt),
  })
}

async function writeOriginal(dataDir: string, n: LegacyNote): Promise<void> {
  const rel = imagePathOf(n)
  if (!rel || !n.image) return
  const abs = path.join(dataDir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, n.image.bytes)
}

function expectedRow(n: LegacyNote, deletedAt: Date | null): NoteImageRow {
  const meta = metaOf(n)
  const rel = imagePathOf(n)
  if (!meta || !rel) throw new Error(`${n.id} is not an image note`)
  return {
    id: n.id,
    noteId: n.id,
    path: rel,
    sha256: meta.sha256,
    mime: meta.mime,
    width: meta.width,
    height: meta.height,
    bytes: meta.bytes,
    takenAt: meta.taken_at === null ? null : new Date(meta.taken_at),
    originalName: meta.original_name,
    host: meta.host,
    position: 0,
    createdAt: new Date(n.createdAt),
    deletedAt,
  }
}

async function notesSnapshot(db: Db) {
  return db.select().from(notes).orderBy(asc(notes.id))
}

describe('migration 0002 on an iteration-6 database', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`
  let admin: Db
  let mig: Db
  let migrationsDir: string
  let dataDir: string
  let notesBefore: Awaited<ReturnType<typeof notesSnapshot>>
  let filesBefore: Record<string, FileFacts>

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl())
    await dropStaleDatabases(admin)
    await admin.execute(sql.raw(`create database "${dbName}"`))
    mig = createDb(urlForDatabase(dbName))

    migrationsDir = await iteration6MigrationsFolder()
    await migrate(mig, { migrationsFolder: migrationsDir })
    const tables = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'note_images'`,
    )
    expect(tables.rows[0]?.n).toBe(0)

    dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-mig0002-data-'))
    for (const n of FIXTURES) {
      await insertLegacyNote(mig, n)
      await writeOriginal(dataDir, n)
    }
    notesBefore = await notesSnapshot(mig)
    filesBefore = await snapshotFiles(dataDir)

    await migrate(mig, { migrationsFolder: MIGRATIONS_DIR })
  })

  afterAll(async () => {
    if (mig) await closeDb(mig)
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`))
      await closeDb(admin)
    }
    if (migrationsDir) await rm(migrationsDir, { recursive: true, force: true })
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
  })

  it('applies only 0002 on top of 0000 + 0001', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
    expect(res.rows[0]?.n).toBe(3)
  })

  it('copies every legacy image into exactly one identical note_images row', async () => {
    const rows = await mig.select().from(noteImages).orderBy(asc(noteImages.id))
    const imageNotes = FIXTURES.filter((n) => n.image !== null)
    expect(rows.map((r) => r.id)).toEqual(imageNotes.map((n) => n.id).sort())
    for (const n of imageNotes) {
      const row = rows.find((r) => r.id === n.id)
      const iso = EXPECTED_IMAGE_DELETED_AT[n.id]
      if (iso === undefined) throw new Error(`no expectation for ${n.id}`)
      expect(row).toEqual(expectedRow(n, iso === null ? null : new Date(iso)))
    }
  })

  it('gives text notes no image rows', async () => {
    const rows = await mig.select().from(noteImages).where(sql`${noteImages.noteId} in ('C-001', 'C-002')`)
    expect(rows).toHaveLength(0)
  })

  it('leaves at most one live row per sha256, the live note first, else the most recently deleted', async () => {
    const res = await mig.execute<{ sha256: string; ids: string }>(
      sql`select sha256, string_agg(id, ',' order by id) as ids from note_images where deleted_at is null group by sha256 having count(*) > 0 order by ids`,
    )
    expect(res.rows.map((r) => r.ids)).toEqual(['A-001', 'A-002', 'B-001', 'D-001', 'E-002'])
  })

  it('leaves every notes row, the legacy columns and their indexes unchanged', async () => {
    expect(await notesSnapshot(mig)).toEqual(notesBefore)
    const idx = await mig.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'notes' order by indexname`,
    )
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['notes_image_sha256_live_uniq', 'notes_image_taken_at_idx']),
    )
  })

  it('does not touch the image files', async () => {
    expect(await snapshotFiles(dataDir)).toEqual(filesBefore)
    expect(Object.keys(filesBefore)).toHaveLength(FIXTURES.filter((n) => n.image !== null).length)
  })

  it('ends with the exact reconcileLegacyImages statement and alters nothing that existed', async () => {
    const text = await readFile(path.join(MIGRATIONS_DIR, '0002_note_images.sql'), 'utf8')
    const chunks = text.split('--> statement-breakpoint')
    const last = (chunks[chunks.length - 1] ?? '').trim().replace(/;\s*$/, '')
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
    expect(norm(last)).toBe(norm(LEGACY_COPY_SQL))
    expect(text).not.toMatch(/\bdrop\b/i)
    expect(text).not.toMatch(/alter table "(notes|note_revisions|note_embeddings)"/i)
  })

  it('reconcile after the migration inserts nothing', async () => {
    const before = await mig.select().from(noteImages).orderBy(asc(noteImages.id))
    expect(await reconcileLegacyImages(mig)).toBe(0)
    expect(await mig.select().from(noteImages).orderBy(asc(noteImages.id))).toEqual(before)
  })

  it('reconcile picks up an image the old daemon ingested after the migration, once', async () => {
    const late: LegacyNote = {
      id: 'F-001',
      body: 'ingested by the old daemon after the Neon migration',
      createdAt: '2026-10-29T10:00:00.000Z',
      deletedAt: null,
      image: { ...jpeg(Buffer.from('legacy photo F-001')), takenAt: '2026-10-28T07:15:00.000Z' },
    }
    await insertLegacyNote(mig, late)
    expect(await reconcileLegacyImages(mig)).toBe(1)
    const [row] = await mig.select().from(noteImages).where(eq(noteImages.id, 'F-001'))
    expect(row).toEqual(expectedRow(late, null))
    expect(await reconcileLegacyImages(mig)).toBe(0)
  })

  it('reconcile bins a late legacy image whose bytes already live in note_images', async () => {
    const bytes = Buffer.from('attached by the new daemon, then ingested by the old one')
    await mig.insert(notes).values({ id: 'G-001', body: 'new-daemon note' })
    await insertImage(mig, {
      id: 'G-001',
      noteId: 'G-001',
      path: 'images/2026/10/G-001.jpg',
      sha256: sha256Hex(bytes),
      mime: 'image/jpeg',
      width: 640,
      height: 480,
      bytes: bytes.length,
      position: 0,
    })
    const late: LegacyNote = {
      id: 'G-002',
      body: 'same bytes through the old daemon',
      createdAt: '2026-10-29T11:00:00.000Z',
      deletedAt: null,
      image: jpeg(bytes),
    }
    await insertLegacyNote(mig, late)
    expect(await reconcileLegacyImages(mig)).toBe(1)
    const [row] = await mig.select().from(noteImages).where(eq(noteImages.id, 'G-002'))
    expect(row).toEqual(expectedRow(late, expect.any(Date) as unknown as Date))
    const [holder] = await mig.select().from(noteImages).where(eq(noteImages.id, 'G-001'))
    expect(holder?.deletedAt).toBeNull()
  })
})
```
**Impact:** One extra database is created and dropped per `test:int` run in `mcp-notes-pg-test`. The shared test DB is untouched. Leftovers from a crashed run are dropped on the next run.

### Step 8: Image repo integration test
**File:** `tests/integration/imageRepo.int.test.ts` (new)
**Change:** Exercises every Contract function against the Docker DB (already migrated to 0002 by globalSetup).
**Code:**
```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { noteImages, notes, type NewNoteImageRow } from '../../src/db/schema.js'
import {
  findImageById,
  findLiveImageBySha256,
  imageIdTaken,
  imagesForNotes,
  insertImage,
  isLiveShaClash,
  nextPosition,
  setImageDeleted,
} from '../../src/notes/imageRepo.js'
import { NoteError } from '../../src/notes/types.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

function image(id: string, noteId: string, sha256: string, position: number, extra: Partial<NewNoteImageRow> = {}): NewNoteImageRow {
  return {
    id,
    noteId,
    path: `images/2026/10/${id}.png`,
    sha256,
    mime: 'image/png',
    width: 10,
    height: 20,
    bytes: 300,
    position,
    ...extra,
  }
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  )
}

async function expectNoteError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await caught(p)
  expect(err).toBeInstanceOf(NoteError)
  expect((err as NoteError).code).toBe(code)
}

describe('imageRepo', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
    await db.insert(notes).values([
      { id: 'N-001', body: 'first' },
      { id: 'N-002', body: 'second' },
      { id: 'N-003', body: 'no images' },
    ])
  })

  it('inserts a row with defaults and finds it by id', async () => {
    const row = await insertImage(
      db,
      image('N-001', 'N-001', 'sha-a', 0, { takenAt: new Date('2026-08-14T09:30:00.000Z'), originalName: 'a.png', host: 'h' }),
    )
    expect(row).toMatchObject({ id: 'N-001', noteId: 'N-001', position: 0, deletedAt: null, originalName: 'a.png', host: 'h' })
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.takenAt?.toISOString()).toBe('2026-08-14T09:30:00.000Z')
    expect(await findImageById(db, 'N-001')).toEqual(row)
    expect(await findImageById(db, 'Z-ZZZ')).toBeNull()
  })

  it('refuses a second live image with the same bytes, in any note, as duplicate_image', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await expectNoteError(insertImage(db, image('X-001', 'N-002', 'sha-a', 0)), 'duplicate_image')
    await expectNoteError(insertImage(db, image('X-002', 'N-001', 'sha-a', 1)), 'duplicate_image')
  })

  it('lets a removed image release its sha256', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await setImageDeleted(db, 'N-001', true)
    const again = await insertImage(db, image('X-001', 'N-002', 'sha-a', 0))
    expect(again.deletedAt).toBeNull()
  })

  it('rethrows a taken path or id unchanged (not duplicate_image)', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    const pathClash = await caught(insertImage(db, image('X-001', 'N-002', 'sha-b', 0, { path: 'images/2026/10/N-001.png' })))
    expect(pathClash).not.toBeInstanceOf(NoteError)
    expect(isLiveShaClash(pathClash)).toBe(false)
    const idClash = await caught(insertImage(db, image('N-001', 'N-002', 'sha-c', 0, { path: 'images/2026/10/other.png' })))
    expect(idClash).not.toBeInstanceOf(NoteError)
  })

  it('finds the live holder of a sha256 with its note deleted time', async () => {
    expect(await findLiveImageBySha256(db, 'sha-a')).toBeNull()
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    const live = await findLiveImageBySha256(db, 'sha-a')
    expect(live?.image.id).toBe('N-001')
    expect(live?.noteDeletedAt).toBeNull()

    await db.update(notes).set({ deletedAt: new Date('2026-10-30T00:00:00.000Z') }).where(eq(notes.id, 'N-001'))
    const inDeletedNote = await findLiveImageBySha256(db, 'sha-a')
    expect(inDeletedNote?.image.id).toBe('N-001')
    expect(inDeletedNote?.noteDeletedAt?.toISOString()).toBe('2026-10-30T00:00:00.000Z')

    await setImageDeleted(db, 'N-001', true)
    expect(await findLiveImageBySha256(db, 'sha-a')).toBeNull()
  })

  it('computes the next position over every row of the note, removed included', async () => {
    expect(await nextPosition(db, 'N-001')).toBe(0)
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await insertImage(db, image('X-001', 'N-001', 'sha-b', 1))
    await insertImage(db, image('X-002', 'N-001', 'sha-c', 2))
    expect(await nextPosition(db, 'N-001')).toBe(3)
    await setImageDeleted(db, 'X-002', true)
    expect(await nextPosition(db, 'N-001')).toBe(3)
    expect(await nextPosition(db, 'N-002')).toBe(0)
  })

  it('treats an id as taken when it is a note id or an image id', async () => {
    await insertImage(db, image('X-001', 'N-001', 'sha-a', 0))
    expect(await imageIdTaken(db, 'N-003')).toBe(true)
    expect(await imageIdTaken(db, 'X-001')).toBe(true)
    expect(await imageIdTaken(db, 'Q-999')).toBe(false)
    await setImageDeleted(db, 'X-001', true)
    expect(await imageIdTaken(db, 'X-001')).toBe(true)
  })

  it('removes idempotently (keeping the first time), restores, and reports unknown ids', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    const removed = await setImageDeleted(db, 'N-001', true)
    expect(removed.deletedAt).toBeInstanceOf(Date)
    const again = await setImageDeleted(db, 'N-001', true)
    expect(again.deletedAt?.getTime()).toBe(removed.deletedAt?.getTime())
    const restored = await setImageDeleted(db, 'N-001', false)
    expect(restored.deletedAt).toBeNull()
    expect(restored.position).toBe(0)
    await expectNoteError(setImageDeleted(db, 'Z-ZZZ', true), 'not_found')
  })

  it('refuses to restore an image whose bytes now live elsewhere', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await setImageDeleted(db, 'N-001', true)
    await insertImage(db, image('X-001', 'N-002', 'sha-a', 0))
    await expectNoteError(setImageDeleted(db, 'N-001', false), 'duplicate_image')
    expect((await findImageById(db, 'N-001'))?.deletedAt).toBeInstanceOf(Date)
  })

  it('loads images per note in position order, with a key for every requested note', async () => {
    await insertImage(db, image('X-003', 'N-001', 'sha-c', 2))
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await insertImage(db, image('X-001', 'N-001', 'sha-b', 1))
    await insertImage(db, image('N-002', 'N-002', 'sha-d', 0))
    await setImageDeleted(db, 'X-001', true)

    const live = await imagesForNotes(db, ['N-001', 'N-002', 'N-003', 'N-001'])
    expect([...live.keys()]).toEqual(['N-001', 'N-002', 'N-003'])
    expect(live.get('N-001')?.map((r) => r.id)).toEqual(['N-001', 'X-003'])
    expect(live.get('N-002')?.map((r) => r.id)).toEqual(['N-002'])
    expect(live.get('N-003')).toEqual([])

    const all = await imagesForNotes(db, ['N-001'], { includeRemoved: true })
    expect(all.get('N-001')?.map((r) => r.id)).toEqual(['N-001', 'X-001', 'X-003'])

    expect((await imagesForNotes(db, [])).size).toBe(0)
  })

  it('cascades a note row removal to its images', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await insertImage(db, image('X-001', 'N-001', 'sha-b', 1))
    await db.delete(notes).where(eq(notes.id, 'N-001'))
    expect(await db.select().from(noteImages)).toHaveLength(0)
  })
})
```
**Impact:** New test file only.

## Verification

**Build:** `npm ci && npm run typecheck`
**Tests:** `npm test` (unit + web, must be unchanged and green) and `npm run test:int` (Docker; applies 0002 to `mcp-notes-pg-test`, runs the new and updated files plus every existing integration file). Focused runs: `npm run test:int -- tests/integration/migration0002.int.test.ts tests/integration/imageRepo.int.test.ts tests/integration/schema.int.test.ts`.
**Manual check:**
- `npx drizzle-kit check` reports no issues.
- `git diff --stat drizzle/` shows only the new `0002_note_images.sql`, `meta/0002_snapshot.json` and the journal's one added entry; `0000`/`0001` and their snapshots are byte-identical.
- `grep -rn "noteImages\|note_images\|imageRepo\|legacy.js" src` hits only `src/db/schema.ts`, `src/notes/imageRepo.ts`, `src/images/legacy.ts` (nothing consumes the table yet).
- `docker exec mcp-notes-pg-test psql -U postgres -l` shows no `mcp_notes_mig0002_*` database after the run.

**Exit criteria:**
- Migration 0002 applies on the Docker DB.
- `migration0002.int.test.ts` proves that every legacy image (live note, deleted note, both sha-clash shapes) has exactly one row with identical metadata, that `notes`, the legacy indexes and the files are untouched, and that reconcile is idempotent, picks up late legacy ingests and bins a late clash.
- `imageRepo.int.test.ts` covers every Contract function.
- `npm run typecheck`, `npm test`, `npm run test:int` are green, with no existing test changed except `schema.int.test.ts` and `setup.ts`.

## Handoffs

- **Phase 2 (R1):** call `reconcileLegacyImages(deps.db)` once at daemon start in `src/background.ts`, and log the count when > 0.
- **Phase 2 (R1):** `NotesService.newId()` must also check `imageIdTaken`.
- **Phase 2 (R1):** `create` with a first image should call `insertImage` in the same transaction as `insertNote`. A sha clash aborts that transaction, so map `isLiveShaClash` / `NoteError('duplicate_image')` and retry or return the holder outside it.
- **Phase 2 (R1):** stop writing `notes.image_path`/`image_meta`. If a new-daemon write ever filled them, the reconcile would pick that note up again.
- **Phase 2 (R1, R5):** the brief's "every image is still served" half of the migration test belongs to phase 2, because serving only reads `note_images` once phase 2 lands. Phase 2 should add a serving assertion over a migrated legacy row: `/api/images/<noteId>/thumb` and the `/api/notes/<noteId>/thumb` alias both return 200 for a reconciled legacy image whose file sits at the legacy path.
- **Phase 2:** `tests/helpers/fakeNotes.ts` may want in-memory equivalents of the repo semantics stated in the Interface Contract.
- **Phase 3 (R1):** `restoreImage` gets `NoteError('duplicate_image')` from `setImageDeleted` without the holder's note id. Look up `findLiveImageBySha256(row.sha256)` to build the Contract's `'... already in note X-XXX'` message and the 409 `note_id`. `removeImage` can rely on `setImageDeleted(true)` being idempotent and keeping the first removal time.
- **Phase 4 (R3):** `purgeImage` on a legacy row (`id = note_id` and `notes.image_path = row.path`) must null `notes.image_path`/`image_meta`. Otherwise `reconcileLegacyImages` (whose candidate test is "no `note_images` row with `id = notes.id`") resurrects it at the next daemon start.
- **Phase 10 (R5 / Neon):** before `db:migrate` on Neon, run a pre-check: `select id from notes where image_path is not null and image_meta is not null and (image_meta->>'sha256' is null or image_meta->>'mime' is null or image_meta->>'width' is null or image_meta->>'height' is null or image_meta->>'bytes' is null)`. It must return 0 rows, or the copy hits a NOT NULL violation and the whole migration rolls back (safe, but blocking). After migrating, verify `select count(*) from note_images` = `select count(*) from notes where image_path is not null and image_meta is not null`. The index's Phase 10 exit criterion counts `image_path is not null` alone, which is equal unless a half-written row exists, so check both.

## Rollback

Revert the phase commit. That removes the schema entries, the two new modules, the tests and the three drizzle files. A Docker test DB that already applied 0002 keeps a stray `note_images` table plus a third `__drizzle_migrations` row. Fix it with `docker exec mcp-notes-pg-test psql -U postgres -d mcp_notes_test -c 'drop table note_images; delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations);'` or recreate the container. Neon is never touched in this phase.
