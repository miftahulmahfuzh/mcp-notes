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
