import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core'

/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`; migration 0002 (iteration 7, wall editing) adds `note_images` and copies every
 * legacy `notes.image_path` / `image_meta` image into it (hand-appended INSERT...SELECT, the same
 * SQL as src/images/legacy.ts `LEGACY_COPY_SQL`); migration 0003 (chat images) adds
 * `chat_images`, the images pasted into a chat; migration 0004 (note files) adds `note_files`:
 * non-image files attached to a note, stored under `files/<noteId>/<safeName>`, with
 * `extracted_text` / `extraction_status` ready for a later text extraction (v1 writes only
 * 'none'); migration 0005 (image similarity search) adds `note_image_embeddings`. Migration 0006
 * (chat history) adds `chat_threads`, `chat_messages`, `chat_message_revisions` and
 * `chat_message_attachments`: our own record of every wall chat turn and every captured Claude
 * Code `/n` exchange (src/chat/service.ts is the only writer).
 * Migration 0007 (project session graph) adds `cc_sessions`, `cc_session_embeddings`,
 * `cc_pending_spawns` and `app_settings`, and `chat_threads.project`; src/sessions/repo.ts is the
 * only writer of the three `cc_*` tables and of `app_settings`.
 * Migration 0009 (session note links) adds `note_session_links`; src/notes/sessionLinks.ts,
 * called only by NotesService, is its only writer.
 * Migration 0010 (node panel: summarize on demand, full prompts) adds
 * `cc_sessions.summary_requested_at`, `cc_sessions.prompts_version` and `cc_session_prompts`;
 * src/sessions/repo.ts is their only writer.
 * Migration 0011 (Seer Adversarial) adds `adversary_reviews`: one row per review attempt of the
 * reviewer (src/adversary/reviewsRepo.ts is its only writer), which is also the usage log and the
 * store of early "draft" verdicts that are never written to Seer.
 * Migration 0013 (session search context) adds commit subjects to the generated
 * `cc_sessions.search_tsv` (drop + re-add of the column; the GIN index is dropped and recreated by
 * hand-added statements, because drizzle-kit's drop/add does not re-emit it) and
 * `cc_session_embeddings.text_version`.
 * Migration 0014 (session replies) adds `cc_session_replies` (Claude's reply to each prompt of a
 * session, redacted), `cc_session_reply_embeddings` (one vector per reply, filled in the
 * background) and `cc_sessions.replies_version`; src/sessions/repo.ts is their only writer.
 * Change a table here, then `npm run db:generate`; never edit an applied migration. drizzle-kit
 * does not emit `CREATE EXTENSION`, so 0001 carries a hand-prepended `CREATE EXTENSION IF NOT EXISTS vector`.
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

/**
 * One row per note image that has (or had) an image embedding. Image similarity search,
 * migration 0005. A side table like `note_embeddings`, so no image listing drags 1536 floats.
 * Model `google/gemini-embedding-2`, a vector space separate from `note_embeddings`.
 *
 * The vector is *current* iff `embedding is not null`, `image_sha256` equals the image's
 * `note_images.sha256` and `model` equals IMAGE_EMBEDDING_MODEL (src/embeddings/imageRepo.ts).
 * Removed images and images of deleted notes keep their row, so a restore needs no call.
 * Width = IMAGE_EMBEDDING_DIMENSIONS (a unit test asserts it).
 */
export const noteImageEmbeddings = pgTable(
  'note_image_embeddings',
  {
    imageId: text('image_id')
      .primaryKey()
      .references(() => noteImages.id, { onDelete: 'cascade' }),
    /** Null while the latest attempt for `image_sha256` failed. */
    embedding: vector('embedding', { dimensions: 1536 }),
    /** `note_images.sha256` of the bytes this row refers to (embedded, or whose embedding failed). */
    imageSha256: text('image_sha256').notNull(),
    /** Model id the vector came from, e.g. `google/gemini-embedding-2`. */
    model: text('model').notNull(),
    /** Consecutive failures for this `image_sha256` + `model`; 0 after a success. */
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
    index('note_image_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('note_image_embeddings_next_attempt_idx').on(t.nextAttemptAt),
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

/** Where a chat thread came from: the wall's chat bar, or a captured Claude Code `/n` exchange (phase 8). */
export const CHAT_SOURCES = ['wall', 'claude_code'] as const
export type ChatSource = (typeof CHAT_SOURCES)[number]

export const CHAT_ROLES = ['user', 'assistant'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

/** `chat_image`: a chat_images row (phase 3); `note_image`: a note_images row; `note_file`: a note_files row (phase 4). */
export const CHAT_ATTACHMENT_KINDS = ['chat_image', 'note_file', 'note_image'] as const
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number]

/**
 * One conversation (migration 0006). Wall threads hold many turns; a captured Claude Code exchange
 * is one single-turn thread whose `external_key` (`<claude_session>:<user entry uuid>`) makes the
 * capture idempotent. Ids are random UUIDs; they never reach the model.
 */
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    source: text('source').$type<ChatSource>().notNull(),
    /** The brain of the latest answer (`claude`, `glm`, ...), or null before any answer. */
    brain: text('brain'),
    /** Idempotency key for captured exchanges (phase 8). Null for wall threads. */
    externalKey: text('external_key'),
    /**
     * Repo key (`cc_sessions.repo`, e.g. `mcp-notes`) of the project page the thread was started
     * from (migration 0007). Null for wall and captured threads.
     */
    project: text('project'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Bumped (never lowered) by every message written to the thread. */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_threads_external_key_uniq').on(t.externalKey),
    index('chat_threads_updated_at_idx').on(t.updatedAt),
    index('chat_threads_project_updated_idx').on(t.project, t.updatedAt),
    check('chat_threads_source_check', sql`${t.source} in ('wall', 'claude_code')`),
  ],
)

/**
 * One chat bubble. `id` is 4 characters from [0-9A-Z] (src/chat/ids.ts), shown to the model as
 * `[msg:K7F2]`. `seq` breaks ties in `created_at` so the timeline order is total and stable.
 * `text` is the current text; an edit (user rows only) keeps the old text in
 * `chat_message_revisions`. `deleted_at` is a soft delete: deleted rows leave the model context and
 * the default timeline, and restore brings them back. `reply_to` names the bubble this one replies
 * to, possibly in another thread; it becomes null if that row is ever removed for good.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: text('role').$type<ChatRole>().notNull(),
    text: text('text').notNull(),
    /** Copied from the thread at insert, so the timeline needs no join. */
    source: text('source').$type<ChatSource>().notNull(),
    /** Assistant rows: the brain that answered. Null for user rows. */
    brain: text('brain'),
    replyTo: text('reply_to').references((): AnyPgColumn => chatMessages.id, { onDelete: 'set null' }),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    /** UTC. Always written by ChatService from its clock (or the captured transcript's timestamp). */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('chat_messages_timeline_idx').on(t.createdAt, t.seq),
    index('chat_messages_thread_idx').on(t.threadId, t.createdAt, t.seq),
    index('chat_messages_reply_to_idx').on(t.replyTo),
    uniqueIndex('chat_messages_seq_uniq').on(t.seq),
    check('chat_messages_role_check', sql`${t.role} in ('user', 'assistant')`),
    check('chat_messages_source_check', sql`${t.source} in ('wall', 'claude_code')`),
  ],
)

/** The text of a chat message BEFORE an edit replaced it. */
export const chatMessageRevisions = pgTable(
  'chat_message_revisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('chat_message_revisions_message_saved_idx').on(t.messageId, t.savedAt.desc())],
)

/**
 * What a chat message carries, in order. `ref_id` names a row of the table `kind` points at; it is
 * not a foreign key because the kinds live in different tables.
 */
export const chatMessageAttachments = pgTable(
  'chat_message_attachments',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').$type<ChatAttachmentKind>().notNull(),
    refId: text('ref_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.position] }),
    index('chat_message_attachments_ref_idx').on(t.kind, t.refId),
    check('chat_message_attachments_kind_check', sql`${t.kind} in ('chat_image', 'note_file', 'note_image')`),
  ],
)

/**
 * How a session's parent link was learned, best first. src/sessions/types.ts PARENT_LINK_RANK
 * ranks them (fork 4 > env 3 > hook 2 > heuristic 1) and src/sessions/repo.ts enforces the order.
 * `fork`: Claude Code's own fork record (a background job's state.json, or the copied transcript
 * prefix) names the parent, so nothing else may replace it.
 */
export const PARENT_LINK_SOURCES = ['fork', 'env', 'hook', 'heuristic'] as const
export type ParentLinkSource = (typeof PARENT_LINK_SOURCES)[number]

/**
 * How a fork's parent and cut were found (`cc_sessions.fork_detected_by`, migration 0015).
 * `job`: the background job's `<claudeHome>/jobs/<short>/state.json` named the parent and a
 * copied-uuid set gave the cut. `uuid`: no job state; the parent shares the fork's head uuid and
 * the longest copied prefix. `time`: the job named the parent but only its `forkBoundaryAt` was
 * readable for the cut.
 */
export const FORK_DETECTED_BY = ['job', 'uuid', 'time'] as const
export type ForkDetectedBy = (typeof FORK_DETECTED_BY)[number]

/** One human prompt of a Claude Code session (`cc_sessions.prompts`). `at` is the record's ISO timestamp. */
export interface SessionPrompt {
  text: string
  at: string | null
}

/** One commit a session made (`cc_sessions.commits`). */
export interface SessionCommit {
  sha: string
  subject: string
  at: string | null
}

/** Token totals of one model within a session (`cc_sessions.models[<model>]`). */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Postgres `tsvector`; only ever written by a generated column, never selected by the app. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

/**
 * One row per Claude Code session (migration 0007), keyed by Claude Code's session UUID. Written
 * only by src/sessions/repo.ts: the transcript ingester fills most columns, the SessionStart hook
 * fills `name`/`tmux`/parent early, the summarizer fills `summary*`, the node panel's Summarize
 * button sets `summary_requested_at` (migration 0010). `node_id` (`A0-3G`, see
 * src/sessions/ids.ts) is assigned on first insert and never changes. `host` is the machine that
 * holds the transcript (`os.hostname()`); transcript reads and resume work only there.
 * `parent_session_id` has no foreign key: the parent may not be ingested yet.
 * `transcript_offset` is the byte offset just after the last complete JSONL line consumed.
 */
export const ccSessions = pgTable(
  'cc_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    nodeId: text('node_id').notNull(),
    host: text('host').notNull(),
    /** Resolved repo key, e.g. `mcp-notes` (worktree sessions map to their repo). */
    repo: text('repo'),
    cwd: text('cwd'),
    branch: text('branch'),
    /** `agent-name` record or the hook-reported name, e.g. `impl-project-session-graph-p3`. */
    name: text('name'),
    customTitle: text('custom_title'),
    aiTitle: text('ai_title'),
    firstPrompt: text('first_prompt'),
    lastPrompt: text('last_prompt'),
    /** `cli` for terminal sessions; `sdk-ts` / `sdk-cli` are never ingested. */
    entrypoint: text('entrypoint'),
    version: text('version'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    /** Latest `cost-state.totalCostUSD` seen (an absolute total, not a sum of deltas). */
    costUsd: numeric('cost_usd', { mode: 'number' }),
    models: jsonb('models').$type<Record<string, ModelUsage>>().notNull().default(sql`'{}'::jsonb`),
    parentSessionId: text('parent_session_id'),
    parentLinkSource: text('parent_link_source').$type<ParentLinkSource>(),
    /** tmux target reported by the live registry / SessionStart hook, e.g. `note:@0.%7`. */
    tmux: text('tmux'),
    transcriptPath: text('transcript_path'),
    transcriptOffset: bigint('transcript_offset', { mode: 'number' }).notNull().default(0),
    transcriptSize: bigint('transcript_size', { mode: 'number' }),
    /**
     * uuid of the transcript's first record that carries one (migration 0015). A fork's transcript
     * begins with a copy of its parent's records, so it shares this value with its parent: the
     * cheap key fork detection looks candidates up by (`cc_sessions_host_head_uuid_idx`).
     */
    headUuid: text('head_uuid'),
    /**
     * Fork metadata (migration 0015, src/sessions/types.ts ForkInfo); all null for a session that
     * is not a fork, and cc_sessions_fork_info_check keeps `fork_detected_by`, `fork_cut_offset`
     * and `fork_prompt_count` together. `fork_cut_offset`: byte offset of the fork's first own
     * record that has a uuid; every reader skips uuid records before it and always reads records
     * without one. `forked_at`: the fork point's time. `fork_prompt_count`: human prompts among the
     * copied records ("after prompt N" of the parent).
     */
    forkCutOffset: bigint('fork_cut_offset', { mode: 'number' }),
    forkedAt: timestamp('forked_at', { withTimezone: true, mode: 'date' }),
    forkPromptCount: integer('fork_prompt_count'),
    forkDetectedBy: text('fork_detected_by').$type<ForkDetectedBy>(),
    /**
     * Human prompts, oldest first: the excerpt list, capped and redacted (src/sessions/types.ts
     * MAX_PROMPTS / MAX_PROMPT_CHARS). The full list is `cc_session_prompts`.
     */
    prompts: jsonb('prompts').$type<SessionPrompt[]>().notNull().default(sql`'[]'::jsonb`),
    commits: jsonb('commits').$type<SessionCommit[]>().notNull().default(sql`'[]'::jsonb`),
    filesEdited: jsonb('files_edited').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    planDocs: jsonb('plan_docs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    finalMessage: text('final_message'),
    summary: text('summary'),
    /** Opaque hash of the summarizer input the summary came from (Phase 6 decides what it hashes). */
    summarySha: text('summary_sha'),
    summarizedAt: timestamp('summarized_at', { withTimezone: true, mode: 'date' }),
    /**
     * When someone asked for a summary of this session (the node panel's Summarize button,
     * migration 0010). Set once and kept on repeat requests; cleared when a summary is stored
     * (`SessionsRepo.setSummary`) or the request is dropped (`clearSummaryRequest`). Only the
     * owning host's summary worker serves it.
     */
    summaryRequestedAt: timestamp('summary_requested_at', { withTimezone: true, mode: 'date' }),
    /**
     * Which prompt storage this row's prompts follow (migration 0010). 0 = legacy: `prompts`
     * holds truncated, unredacted excerpts and `cc_session_prompts` is empty. Higher versions are
     * defined by src/sessions/types.ts; the owning host's backfill raises it once.
     */
    promptsVersion: integer('prompts_version').notNull().default(0),
    /**
     * Whether `cc_session_replies` was written by a read of the whole transcript (migration 0014).
     * 0 = ingested before replies were stored. src/sessions/types.ts REPLIES_VERSION; the owning
     * host's prompts backfill raises it once while the transcript is still on disk.
     */
    repliesVersion: integer('replies_version').notNull().default(0),
    /**
     * Full text (`simple`) over ids, names, titles, prompts, summary and commit subjects
     * (`commits[*].subject`, migration 0013; not the shas). Never selected by the app.
     */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", '') || ' ' || coalesce(jsonb_path_query_array("commits", '$[*].subject')::text, ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cc_sessions_node_id_uniq').on(t.nodeId),
    index('cc_sessions_repo_started_idx').on(t.repo, t.startedAt.desc()),
    index('cc_sessions_parent_idx').on(t.parentSessionId),
    index('cc_sessions_host_idx').on(t.host),
    index('cc_sessions_host_head_uuid_idx').on(t.host, t.headUuid),
    index('cc_sessions_name_idx').on(t.name),
    index('cc_sessions_last_active_idx').on(t.lastActiveAt),
    index('cc_sessions_search_gin').using('gin', t.searchTsv),
    check('cc_sessions_node_id_check', sql`${t.nodeId} ~ '^[0-9A-Z]{2}-[0-9A-Z]{2}$'`),
    check('cc_sessions_parent_link_source_check', sql`${t.parentLinkSource} in ('fork', 'env', 'hook', 'heuristic')`),
    check('cc_sessions_parent_pair_check', sql`(${t.parentSessionId} is null) = (${t.parentLinkSource} is null)`),
    check('cc_sessions_fork_detected_by_check', sql`${t.forkDetectedBy} in ('job', 'uuid', 'time')`),
    check(
      'cc_sessions_fork_info_check',
      sql`(${t.forkDetectedBy} is null) = (${t.forkCutOffset} is null) and (${t.forkDetectedBy} is null) = (${t.forkPromptCount} is null)`,
    ),
  ],
)

/**
 * One row per subagent transcript (`<claudeHome>/projects/<dir>/<session uuid>/subagents/agent-<id>.jsonl`,
 * migration 0008): what the Agent tool's subagents of a session used and committed. Written only by
 * src/sessions/repo.ts, in the same transaction that folds the change into the parent `cc_sessions`
 * row, whose token, model and commit columns are the session's totals including its subagents.
 * `transcript_offset` is this file's own resume point (same rules as `cc_sessions`).
 */
export const ccSubagentTranscripts = pgTable(
  'cc_subagent_transcripts',
  {
    transcriptPath: text('transcript_path').primaryKey(),
    /** The parent session (the folder the file sits in). No foreign key, like parent_session_id. */
    sessionId: text('session_id').notNull(),
    /** `agent-<id>` without the prefix. */
    agentId: text('agent_id').notNull(),
    host: text('host').notNull(),
    transcriptOffset: bigint('transcript_offset', { mode: 'number' }).notNull().default(0),
    transcriptSize: bigint('transcript_size', { mode: 'number' }),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    models: jsonb('models').$type<Record<string, ModelUsage>>().notNull().default(sql`'{}'::jsonb`),
    commits: jsonb('commits').$type<SessionCommit[]>().notNull().default(sql`'[]'::jsonb`),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('cc_subagent_transcripts_session_idx').on(t.sessionId), index('cc_subagent_transcripts_host_idx').on(t.host)],
)

/**
 * Every typed prompt of a session in full, redacted (migration 0010), one row per prompt in
 * transcript order (`seq` from 1, no gaps). `cc_sessions.prompts` stays the bounded excerpt list that
 * feeds full text, the summarizer and the embed text; this table is read only where the full
 * list is shown, never by the graph or the summary worker. `text` is stored only after
 * src/sessions/redact.ts `redactSecrets`; `truncated` marks a prompt cut at the sanity ceiling.
 * Written only by src/sessions/repo.ts. Removing the session drops its prompts.
 */
export const ccSessionPrompts = pgTable(
  'cc_session_prompts',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }),
    text: text('text').notNull(),
    truncated: boolean('truncated').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
)

/**
 * One pasted image carried by a prompt (migration 0012): links a `cc_session_prompts` row to a
 * `chat_images` row (`source: 'claude_code'`), so an image pasted into a Claude Code session gets
 * the same stable id a wall-chat image has, shows as a thumbnail in the Projects page's Prompts
 * view, and can be named later from wall chat or another session. Written only by
 * src/sessions/repo.ts, alongside the prompt row. A prompt rewritten by a from-byte-0 replace
 * (`replacePrompts`) drops and relinks its images the same way its text is rewritten; re-pasting the
 * same bytes is a no-op (`chat_images` dedupes by sha256).
 */
export const ccSessionPromptImages = pgTable(
  'cc_session_prompt_images',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    promptSeq: integer('prompt_seq').notNull(),
    /** Position of the image among its prompt's content blocks, 0-based. */
    position: integer('position').notNull(),
    imageId: text('image_id')
      .notNull()
      .references(() => chatImages.id, { onDelete: 'cascade' }),
    /** The `[Image #N]` Claude Code assigned, or the 1-based position when absent. */
    pasteId: integer('paste_id'),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.promptSeq, t.position] }),
    foreignKey({ columns: [t.sessionId, t.promptSeq], foreignColumns: [ccSessionPrompts.sessionId, ccSessionPrompts.seq] }).onDelete('cascade'),
    index('cc_session_prompt_images_image_idx').on(t.imageId),
  ],
)

/**
 * Claude's reply to each prompt of a session (migration 0014): the assistant text after the last
 * tool call of the turn the prompt started, i.e. what Claude said back to the user. Narration
 * between tool calls and subagent (sidechain) text are never stored. `seq` is the
 * `cc_session_prompts.seq` of the prompt it answers; a prompt whose turn ended in a tool call has
 * no row. `text` is stored only after src/sessions/redact.ts `redactSecrets` and is cut at
 * MAX_REPLY_STORE_CHARS (`truncated`). There is deliberately no foreign key to
 * `cc_session_prompts`: a from-byte-0 replace deletes and reinserts every prompt row, and a cascade
 * from it would drop every reply and its vector each time. Written only by src/sessions/repo.ts, in
 * the same transaction as the prompts. Removing the session drops its replies.
 */
export const ccSessionReplies = pgTable(
  'cc_session_replies',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }),
    text: text('text').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    /** Full text (`simple`) over the reply. Never selected by the app. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(sql`to_tsvector('simple', "text")`),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] }), index('cc_session_replies_search_gin').using('gin', t.searchTsv)],
)

/**
 * One vector per reply (migration 0014), mirroring `cc_session_embeddings`: current iff
 * `embedding is not null`, `sha` equals the sha256 of the reply's current `text`, and `model`
 * equals the embedder's model. A reply whose text changes keeps its row (stale by sha) until the
 * background worker re-embeds it; deleting the reply drops the vector. Width =
 * EMBEDDING_DIMENSIONS (a unit test asserts it).
 */
export const ccSessionReplyEmbeddings = pgTable(
  'cc_session_reply_embeddings',
  {
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    /** Null while the latest attempt for `sha` failed. */
    embedding: vector('embedding', { dimensions: 1536 }),
    sha: text('sha').notNull(),
    model: text('model').notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** At most 500 chars, keys redacted (src/embeddings/state.ts `clampError`). */
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    foreignKey({
      name: 'cc_session_reply_embeddings_reply_fk',
      columns: [t.sessionId, t.seq],
      foreignColumns: [ccSessionReplies.sessionId, ccSessionReplies.seq],
    }).onDelete('cascade'),
    index('cc_session_reply_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('cc_session_reply_embeddings_next_attempt_idx').on(t.nextAttemptAt),
  ],
)

/**
 * An explicit link from an existing note to a Claude Code session (migration 0009), made with the
 * `link_note` MCP tool. Session detail lists the notes made in a session (`notes.origin
 * ->> 'claude_session'`) together with the notes linked here; a link never rewrites the note's
 * origin. Written only by src/notes/sessionLinks.ts through NotesService. Purging a note or
 * removing a session drops its links.
 */
export const noteSessionLinks = pgTable(
  'note_session_links',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.sessionId] }), index('note_session_links_session_idx').on(t.sessionId)],
)

/**
 * One row per session that has (or had) a summary to embed (migration 0007). Mirrors
 * `note_embeddings`: the vector is current iff `embedding is not null`, `sha` equals the hash of
 * the session's current embed text (src/sessions/summarize.ts `buildEmbedText` / `embedTextSha`),
 * `model` equals EMBEDDING_MODEL and `text_version` equals `SESSION_EMBED_TEXT_VERSION` (migration
 * 0013; rows from before it are 0, and the summary worker rebuilds them once).
 * Width = EMBEDDING_DIMENSIONS (a unit test asserts it).
 */
export const ccSessionEmbeddings = pgTable(
  'cc_session_embeddings',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    /** Null while the latest attempt for `sha` failed. */
    embedding: vector('embedding', { dimensions: 1536 }),
    sha: text('sha').notNull(),
    model: text('model').notNull(),
    /** Layout version of the embed text the vector came from (src/sessions/summarize.ts SESSION_EMBED_TEXT_VERSION). */
    textVersion: integer('text_version').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    /** At most 500 chars, keys redacted (src/embeddings/state.ts `clampError`). */
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('cc_session_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('cc_session_embeddings_next_attempt_idx').on(t.nextAttemptAt),
  ],
)

/**
 * A `claude` launch inside tmux seen by the Bash PreToolUse hook (migration 0007): the parent is
 * the session that ran the command. The child's SessionStart claims it within
 * PENDING_SPAWN_WINDOW_MS by host + cwd (+ name). `cwd` is stored without trailing slashes.
 */
export const ccPendingSpawns = pgTable(
  'cc_pending_spawns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    parentSessionId: text('parent_session_id').notNull(),
    cwd: text('cwd').notNull(),
    name: text('name'),
    host: text('host').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Session id of the child that claimed this spawn. */
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('cc_pending_spawns_open_idx').on(t.host, t.cwd, t.createdAt).where(sql`${t.claimedBy} is null`),
    index('cc_pending_spawns_created_idx').on(t.createdAt),
  ],
)

/**
 * Small key/value settings shared by both machines (migration 0007), e.g. `projects.selected`
 * (src/sessions/types.ts SELECTED_PROJECT_KEY). Written only through src/sessions/repo.ts.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})

/** One source a Seer Adversarial verdict cites: a page the reviewer opened with its fetch_url tool. */
export interface AdversarySource {
  url: string
  title: string | null
  publisher: string | null
  /** ISO 8601 when the page said when it was published, else null. */
  published_at: string | null
  /** ISO 8601, when the reviewer fetched it (before the session opened). */
  fetched_at: string
}

/** `adversary_reviews.verdict`: what one review concluded. */
export interface AdversaryStoredVerdict {
  verdict: 'agree' | 'object' | 'unsure'
  /** Plain words, 1..600 characters. */
  reason: string
  sources: AdversarySource[]
  /** The method brief's id@version, `<object_name>@<8 hex>`. */
  lens: string
  /** adversary_verdicts.id in Seer's DB once written; null for a draft (and a failed write). */
  seer_verdict_id: number | null
  /** True when an agree/object that cited no fetched page was turned into unsure. */
  downgraded: boolean
}

/**
 * One row per Seer Adversarial review attempt (migration 0011), from either machine. stage
 * 'draft' is an early look at a book's next rebalance (from Seer's book_previews), kept here only;
 * stage 'final' is a review of a real decision, written to Seer's adversary_verdicts when it
 * succeeds. status 'late' means the Seer verdict was decided after the session opened (the engine
 * ignores it); 'skipped_budget' means the daily cap was reached. Deep reviews counted against the
 * cap: status ok/failed/late with reused_from null. Written only through src/adversary/reviewsRepo.ts.
 */
export const adversaryReviews = pgTable(
  'adversary_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    strategyId: text('strategy_id').notNull(),
    sessionDate: date('session_date', { mode: 'string' }).notNull(),
    symbol: text('symbol').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull(),
    verdict: jsonb('verdict').$type<AdversaryStoredVerdict>(),
    promptVersion: text('prompt_version').notNull(),
    gatherModel: text('gather_model'),
    verdictModel: text('verdict_model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    turns: integer('turns').notNull().default(0),
    error: text('error'),
    host: text('host').notNull(),
    /** The draft row whose verdict this final row reused (no tokens spent). */
    reusedFrom: bigint('reused_from', { mode: 'number' }).references((): AnyPgColumn => adversaryReviews.id),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('adversary_reviews_stage_check', sql`${t.stage} in ('draft', 'final')`),
    check('adversary_reviews_status_check', sql`${t.status} in ('ok', 'failed', 'skipped_budget', 'late')`),
    index('adversary_reviews_started_idx').on(t.startedAt),
    index('adversary_reviews_key_idx').on(t.strategyId, t.sessionDate, t.symbol, t.startedAt),
  ],
)

export type NoteRow = typeof notes.$inferSelect
export type NewNoteRow = typeof notes.$inferInsert
export type NoteImageRow = typeof noteImages.$inferSelect
export type NewNoteImageRow = typeof noteImages.$inferInsert
export type NoteFileRow = typeof noteFiles.$inferSelect
export type NewNoteFileRow = typeof noteFiles.$inferInsert
export type NoteRevisionRow = typeof noteRevisions.$inferSelect
export type NewNoteRevisionRow = typeof noteRevisions.$inferInsert
export type ChatImageRow = typeof chatImages.$inferSelect
export type NewChatImageRow = typeof chatImages.$inferInsert
export type NoteImageEmbeddingRow = typeof noteImageEmbeddings.$inferSelect
export type ChatThreadRow = typeof chatThreads.$inferSelect
export type ChatMessageRow = typeof chatMessages.$inferSelect
export type ChatMessageRevisionRow = typeof chatMessageRevisions.$inferSelect
export type ChatMessageAttachmentRow = typeof chatMessageAttachments.$inferSelect
export type CcSessionRow = typeof ccSessions.$inferSelect
export type NewCcSessionRow = typeof ccSessions.$inferInsert
export type CcSessionEmbeddingRow = typeof ccSessionEmbeddings.$inferSelect
export type CcSessionPromptRow = typeof ccSessionPrompts.$inferSelect
export type NewCcSessionPromptRow = typeof ccSessionPrompts.$inferInsert
export type CcSessionPromptImageRow = typeof ccSessionPromptImages.$inferSelect
export type NewCcSessionPromptImageRow = typeof ccSessionPromptImages.$inferInsert
export type CcSessionReplyRow = typeof ccSessionReplies.$inferSelect
export type NewCcSessionReplyRow = typeof ccSessionReplies.$inferInsert
export type CcSessionReplyEmbeddingRow = typeof ccSessionReplyEmbeddings.$inferSelect
export type CcPendingSpawnRow = typeof ccPendingSpawns.$inferSelect
export type AppSettingRow = typeof appSettings.$inferSelect
export type AdversaryReviewRow = typeof adversaryReviews.$inferSelect
export type NewAdversaryReviewRow = typeof adversaryReviews.$inferInsert
