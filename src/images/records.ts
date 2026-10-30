import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notes, type ImageMeta, type NoteRow } from '../db/schema.js';
import { normalizeId } from '../notes/ids.js';

/** Raw storage fields of an image note (not a wire shape). */
export type ImageRecord = {
  id: string;
  /** Relative to the data dir: images/YYYY/MM/<id>.<ext>. */
  image_path: string;
  image_meta: ImageMeta;
  /** ISO string, or null for a live note. */
  deleted_at: string | null;
};

export interface ImageRecords {
  /** The live note holding these bytes, else the most recently deleted one, else null. */
  bySha256(sha256: string): Promise<ImageRecord | null>;
  /** Case/dash-tolerant id; soft-deleted notes included; null when unknown or not an image note. */
  byId(id: string): Promise<ImageRecord | null>;
}

function toRecord(row: NoteRow): ImageRecord | null {
  if (row.imagePath === null || row.imageMeta === null) return null;
  return {
    id: row.id,
    image_path: row.imagePath,
    image_meta: row.imageMeta,
    deleted_at: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

export function dbImageRecords(db: Db): ImageRecords {
  return {
    async bySha256(sha256) {
      const rows = await db
        .select()
        .from(notes)
        .where(and(isNotNull(notes.imagePath), eq(sql`${notes.imageMeta} ->> 'sha256'`, sha256)))
        .orderBy(sql`${notes.deletedAt} is not null`, desc(notes.deletedAt))
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async byId(input) {
      const id = normalizeId(input);
      if (id === null) return null;
      const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
  };
}
