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
