import { sql } from 'drizzle-orm'
import { bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * The whole schema for iterations 1-3. Phase 1 owns it and its single migration
 * (drizzle/0000_init.sql); no later phase adds a migration.
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
    /** Relative to the data dir: `images/YYYY/MM/<id>.<ext>`. */
    imagePath: text('image_path'),
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
    uniqueIndex('notes_image_sha256_live_uniq')
      .on(sql`(${t.imageMeta} ->> 'sha256')`)
      .where(sql`${t.imageMeta} is not null and ${t.deletedAt} is null`),
    index('notes_image_taken_at_idx').on(sql`(${t.imageMeta} ->> 'taken_at')`),
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

export type NoteRow = typeof notes.$inferSelect
export type NewNoteRow = typeof notes.$inferInsert
export type NoteRevisionRow = typeof noteRevisions.$inferSelect
export type NewNoteRevisionRow = typeof noteRevisions.$inferInsert
