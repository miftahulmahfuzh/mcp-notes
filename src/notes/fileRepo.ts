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
