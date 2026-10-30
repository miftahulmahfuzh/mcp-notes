import type { ImageNotes } from '../../src/images/ingest.js';
import type { ImageRecord, ImageRecords } from '../../src/images/records.js';
import { generateId, normalizeId } from '../../src/notes/ids.js';
import { imageUrls, NoteError, type ImageMeta, type Note, type NoteImage, type Origin } from '../../src/notes/types.js';

export type FakeNoteRow = {
  id: string;
  body: string;
  origin: Origin | null;
  created_at: string;
  deleted_at: string | null;
};

export type FakeImageRow = {
  id: string;
  note_id: string;
  path: string;
  meta: ImageMeta;
  position: number;
  deleted_at: string | null;
};

/**
 * In-memory stand-in for the slice of the notes service ingestion uses, plus the raw image
 * lookups, with the same unique rules as the schema: an id is taken when a note or an image has
 * it (NoteError 'conflict'); sha256 is unique among images with deleted_at null, whatever their
 * note's state (NoteError 'duplicate_image').
 */
export class FakeNotes implements ImageNotes, ImageRecords {
  rows = new Map<string, FakeNoteRow>();
  images = new Map<string, FakeImageRow>();
  /** Called inside create() before the uniqueness checks; lets a test interleave a competing insert. */
  beforeInsert: ((id: string) => Promise<void> | void) | null = null;
  failNextCreate: Error | null = null;

  private liveImagesOf(noteId: string): FakeImageRow[] {
    return [...this.images.values()]
      .filter((i) => i.note_id === noteId && i.deleted_at === null)
      .sort((a, b) => a.position - b.position);
  }

  private toWire(i: FakeImageRow): NoteImage {
    return {
      id: i.id,
      note_id: i.note_id,
      position: i.position,
      mime: i.meta.mime,
      width: i.meta.width,
      height: i.meta.height,
      bytes: i.meta.bytes,
      taken_at: i.meta.taken_at,
      original_name: i.meta.original_name,
      host: i.meta.host,
      available: true,
      urls: imageUrls(i.id),
    };
  }

  private toNote(r: FakeNoteRow): Note {
    const note: Note = {
      id: r.id,
      body: r.body,
      tags: [],
      created_at: r.created_at,
      updated_at: r.created_at,
      origin: r.origin,
      images: this.liveImagesOf(r.id).map((i) => this.toWire(i)),
    };
    // As rowToNote: deleted_at is present only on deleted notes.
    if (r.deleted_at !== null) note.deleted_at = r.deleted_at;
    return note;
  }

  private toRecord(i: FakeImageRow): ImageRecord {
    return {
      id: i.id,
      note_id: i.note_id,
      path: i.path,
      meta: i.meta,
      position: i.position,
      deleted_at: i.deleted_at,
      note_deleted_at: this.rows.get(i.note_id)?.deleted_at ?? null,
    };
  }

  /** Put a note (and its first image, same id, position 0) straight into the store, skipping every check. */
  seed(input: { id: string; body?: string; origin?: Origin | null; image?: { path: string; meta: ImageMeta } }): void {
    this.rows.set(input.id, {
      id: input.id,
      body: input.body ?? '',
      origin: input.origin ?? null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    });
    if (input.image) {
      this.images.set(input.id, {
        id: input.id,
        note_id: input.id,
        path: input.image.path,
        meta: input.image.meta,
        position: 0,
        deleted_at: null,
      });
    }
  }

  async newId(): Promise<string> {
    for (;;) {
      const id = generateId();
      if (!this.rows.has(id) && !this.images.has(id)) return id;
    }
  }

  async create(input: Parameters<ImageNotes['create']>[0]): Promise<Note> {
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    const id = input.id ?? (await this.newId());
    await this.beforeInsert?.(id);
    if (this.rows.has(id) || this.images.has(id)) throw new NoteError('conflict', `note ${id} already exists`);
    const sha = input.image?.meta.sha256;
    if (sha && [...this.images.values()].some((i) => i.deleted_at === null && i.meta.sha256 === sha)) {
      throw new NoteError('duplicate_image', 'a live image already holds these bytes');
    }
    const row: FakeNoteRow = {
      id,
      body: input.body,
      origin: input.origin ?? null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    this.rows.set(id, row);
    if (input.image) {
      this.images.set(id, { id, note_id: id, path: input.image.path, meta: input.image.meta, position: 0, deleted_at: null });
    }
    return this.toNote(row);
  }

  async getOne(id: string, opts?: { includeDeleted?: boolean }): Promise<Note | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    return r.deleted_at === null || opts?.includeDeleted ? this.toNote(r) : null;
  }

  async restore(id: string): Promise<Note> {
    const r = this.rows.get(id);
    if (!r) throw new NoteError('not_found', `no note ${id}`);
    r.deleted_at = null;
    return this.toNote(r);
  }

  softDelete(id: string): void {
    const r = this.rows.get(id);
    if (r) r.deleted_at = new Date().toISOString();
  }

  /** Mark one image removed (in the bin), as phase 3's removeImage will. */
  removeImage(imageId: string): void {
    const i = this.images.get(imageId);
    if (i) i.deleted_at = new Date().toISOString();
  }

  async bySha256Live(sha256: string): Promise<ImageRecord | null> {
    const hit = [...this.images.values()].find((i) => i.deleted_at === null && i.meta.sha256 === sha256);
    return hit ? this.toRecord(hit) : null;
  }

  async byImageId(input: string): Promise<ImageRecord | null> {
    const id = normalizeId(input);
    const hit = id === null ? undefined : this.images.get(id);
    return hit ? this.toRecord(hit) : null;
  }

  async firstLiveImageOfNote(input: string): Promise<ImageRecord | null> {
    const id = normalizeId(input);
    if (id === null) return null;
    const [first] = this.liveImagesOf(id);
    return first ? this.toRecord(first) : null;
  }
}
