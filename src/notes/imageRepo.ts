import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { noteFiles, noteImages, notes, type NewNoteImageRow, type NoteImageRow } from '../db/schema.js';
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
