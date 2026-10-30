import type { ImageNotes } from '../../src/images/ingest.js';
import type { ImageRecord, ImageRecords } from '../../src/images/records.js';
import { generateId } from '../../src/notes/ids.js';
import { NoteError, type ImageMeta, type Note, type Origin } from '../../src/notes/types.js';

type Row = {
  id: string;
  body: string;
  origin: Origin | null;
  image_path: string | null;
  image_meta: ImageMeta | null;
  created_at: string;
  deleted_at: string | null;
};

/**
 * In-memory stand-in for the slice of the notes service ingestion uses, plus the raw image
 * lookups, with the same unique rules as the schema: primary key on id
 * (NoteError 'conflict'), unique sha256 among non-deleted notes (NoteError 'duplicate_image').
 */
export class FakeNotes implements ImageNotes, ImageRecords {
  rows = new Map<string, Row>();
  /** Called inside create() before the uniqueness checks; lets a test interleave a competing insert. */
  beforeInsert: ((id: string) => Promise<void> | void) | null = null;
  failNextCreate: Error | null = null;

  private toNote(r: Row): Note {
    const note: Note = {
      id: r.id,
      body: r.body,
      tags: [],
      created_at: r.created_at,
      updated_at: r.created_at,
      origin: r.origin,
      image: r.image_meta
        ? {
            mime: r.image_meta.mime,
            width: r.image_meta.width,
            height: r.image_meta.height,
            bytes: r.image_meta.bytes,
            taken_at: r.image_meta.taken_at,
            original_name: r.image_meta.original_name,
            host: r.image_meta.host,
            available: true,
          }
        : null,
    };
    // As phase 2's rowToNote: deleted_at is present only on deleted notes.
    if (r.deleted_at !== null) note.deleted_at = r.deleted_at;
    return note;
  }

  private toRecord(r: Row): ImageRecord {
    return { id: r.id, image_path: r.image_path!, image_meta: r.image_meta!, deleted_at: r.deleted_at };
  }

  async newId(): Promise<string> {
    for (;;) {
      const id = generateId();
      if (!this.rows.has(id)) return id;
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
    if (this.rows.has(id)) throw new NoteError('conflict', `note ${id} already exists`);
    const sha = input.image?.meta.sha256;
    if (sha && [...this.rows.values()].some((r) => r.deleted_at === null && r.image_meta?.sha256 === sha)) {
      throw new NoteError('duplicate_image', 'a live note already holds these bytes');
    }
    const row: Row = {
      id,
      body: input.body,
      origin: input.origin ?? null,
      image_path: input.image?.path ?? null,
      image_meta: input.image?.meta ?? null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    this.rows.set(id, row);
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

  async bySha256(sha256: string): Promise<ImageRecord | null> {
    const matches = [...this.rows.values()].filter((r) => r.image_meta?.sha256 === sha256);
    const live = matches.find((r) => r.deleted_at === null);
    const pick = live ?? matches.sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''))[0];
    return pick ? this.toRecord(pick) : null;
  }

  async byId(id: string): Promise<ImageRecord | null> {
    const r = this.rows.get(id);
    return r && r.image_path && r.image_meta ? this.toRecord(r) : null;
  }
}
