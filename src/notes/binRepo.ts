import { and, arrayContains, desc, eq, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { noteImages, notes, type NoteImageRow } from '../db/schema.js';
import { normalizeTagInput, type Executor, type Tx } from './repo.js';

/** A binned image with its note's deleted_at (null when the note is live). */
export interface BinImageRow {
  image: NoteImageRow;
  noteDeletedAt: Date | null;
}

/** Tag AND filter on the owning note; `#` and case ignored. */
function tagConditions(tagsAll: readonly string[] | undefined): SQL[] {
  const all = normalizeTagInput(tagsAll);
  return all.length > 0 ? [arrayContains(notes.tags, all)] : [];
}

/** Ids of deleted notes carrying every tag in `tagsAll`, newest deleted_at first. */
export async function listDeletedNoteIds(db: Executor, tagsAll?: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNotNull(notes.deletedAt), ...tagConditions(tagsAll)))
    .orderBy(desc(notes.deletedAt), desc(notes.id));
  return rows.map((r) => r.id);
}

/**
 * Every image in the bin: removed images (of any note) and the non-removed images of deleted
 * notes, filtered by the owning note's tags, newest bin time first. The bin time of a removed
 * image is its own deleted_at, so a removed image of a deleted note appears once.
 */
export async function listBinImages(db: Executor, tagsAll?: readonly string[]): Promise<BinImageRow[]> {
  const binnedAt = sql`coalesce(${noteImages.deletedAt}, ${notes.deletedAt})`;
  return db
    .select({ image: noteImages, noteDeletedAt: notes.deletedAt })
    .from(noteImages)
    .innerJoin(notes, eq(noteImages.noteId, notes.id))
    .where(and(or(isNotNull(noteImages.deletedAt), isNotNull(notes.deletedAt)), ...tagConditions(tagsAll)))
    .orderBy(desc(binnedAt), desc(noteImages.id));
}

/** Reads an image row and locks it until the transaction ends. */
export async function lockImageRow(tx: Tx, id: string): Promise<NoteImageRow | null> {
  const rows = await tx.select().from(noteImages).where(eq(noteImages.id, id)).for('update');
  return rows[0] ?? null;
}

/** Deletes a notes row; note_images, note_revisions and note_embeddings go with it (FK cascade). */
export async function deleteNoteRow(tx: Executor, id: string): Promise<boolean> {
  const rows = await tx.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
  return rows.length > 0;
}

export async function deleteImageRow(tx: Executor, id: string): Promise<boolean> {
  const rows = await tx.delete(noteImages).where(eq(noteImages.id, id)).returning({ id: noteImages.id });
  return rows.length > 0;
}

/**
 * Forgets a note's legacy single image (notes.image_path / image_meta), so reconcileLegacyImages
 * cannot copy a purged image back. updated_at is left alone: the note's text did not change.
 */
export async function clearLegacyImage(tx: Executor, noteId: string): Promise<void> {
  await tx.update(notes).set({ imagePath: null, imageMeta: null }).where(eq(notes.id, noteId));
}
