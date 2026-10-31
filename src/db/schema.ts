import { sql } from 'drizzle-orm'
import { bigserial, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core'

/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`; migration 0002 (iteration 7, wall editing) adds `note_images` and copies every
 * legacy `notes.image_path` / `image_meta` image into it (hand-appended INSERT...SELECT, the same
 * SQL as src/images/legacy.ts `LEGACY_COPY_SQL`); migration 0003 (chat images) adds
 * `chat_images`, the images pasted into a chat. Change a table here, then `npm run db:generate`;
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

/** Where a chat image came from: pasted into the wall's chat bar, or captured from a Claude Code `/n` exchange. */
export type ChatImageSource = 'wall' | 'claude_code'

/**
 * One row per image pasted into a chat (migration 0003). Not a note image: a query image never
 * shows on the wall and never joins `note_images`. Stored once per byte content (sha256 unique,
 * no soft delete), so the same screenshot pasted twice is one row. Ids have the `A-B32` shape but
 * live in their own space and are always written `upload:ID`; their derivatives go to
 * `cache/c_<id>/` (src/chat/images.ts `chatImageCacheId`) so they can never meet a note image's
 * `cache/<id>/`.
 */
export const chatImages = pgTable(
  'chat_images',
  {
    /** `A-B32`, unique within this table only. */
    id: text('id').primaryKey(),
    /** Relative to the data dir: `chat-images/YYYY/MM/<id>.<ext>`. */
    path: text('path').notNull(),
    /** Lower-case hex sha256 of the original bytes. Unique: an upload of known bytes returns the existing row. */
    sha256: text('sha256').notNull(),
    /** Sniffed from magic bytes. */
    mime: text('mime').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Original size in bytes (the 50 MB chat cap fits int4). */
    bytes: integer('bytes').notNull(),
    originalName: text('original_name'),
    /** `os.hostname()` of the machine that first stored the file. */
    host: text('host'),
    source: text('source').$type<ChatImageSource>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_images_sha256_uniq').on(t.sha256),
    uniqueIndex('chat_images_path_uniq').on(t.path),
    index('chat_images_created_at_idx').on(t.createdAt),
    check('chat_images_source_check', sql`${t.source} in ('wall', 'claude_code')`),
  ],
)

export type NoteRow = typeof notes.$inferSelect
export type NewNoteRow = typeof notes.$inferInsert
export type NoteImageRow = typeof noteImages.$inferSelect
export type NewNoteImageRow = typeof noteImages.$inferInsert
export type NoteRevisionRow = typeof noteRevisions.$inferSelect
export type NewNoteRevisionRow = typeof noteRevisions.$inferInsert
export type ChatImageRow = typeof chatImages.$inferSelect
export type NewChatImageRow = typeof chatImages.$inferInsert
