import type { Db } from '../db/client.js';
import type { NoteEvents, NoteOp } from './events.js';
import { generateId, normalizeId } from './ids.js';
import * as repo from './repo.js';
import type { NoteFilter } from './repo.js';
import { parseTags } from './tags.js';
import {
  NoteError,
  cleanOrigin,
  rowToNote,
  type ImageMeta,
  type Note,
  type NotePage,
  type NoteRow,
  type Origin,
  type Revision,
  type TagCount,
} from './types.js';

export const MAX_ID_ATTEMPTS = 20;

export interface NotesServiceDeps {
  db: Db;
  dataDir: string;
  events: NoteEvents;
}

export interface CreateNoteInput {
  /** May be empty only when `allowEmpty` is true. */
  body: string;
  origin?: Origin | null;
  /** Image notes (phase 4): `path` is relative to dataDir, e.g. images/2026/10/A-B32.jpg. */
  image?: { path: string; meta: ImageMeta } | null;
  /** HTTP "+" (phase 6) and image notes create with an empty body; MCP never sets this. */
  allowEmpty?: boolean;
  /**
   * Use this id instead of generating one (phase 4 names the image file before inserting).
   * Get it from `newId()`. A taken id throws NoteError('conflict'); no retry.
   */
  id?: string;
}

export interface UpdateOptions {
  /** Replaces the stored origin when given. */
  origin?: Origin | null;
  /** HTTP inline edit may empty a note; MCP never sets this. */
  allowEmpty?: boolean;
}

export interface GetOptions {
  includeDeleted?: boolean;
}

export interface GetResult {
  /** In the order the ids were asked for, without duplicates. */
  notes: Note[];
  /** Inputs that are not ids, or ids no note has. */
  missing: string[];
  /** Ids of soft-deleted notes, reported here when includeDeleted is false. */
  deleted: string[];
}

interface Mutation {
  row: NoteRow;
  op: NoteOp | null;
}

/** The only writer of notes. Every mutation is atomic and emits one event after commit. */
export class NotesService {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly events: NoteEvents;

  constructor(deps: NotesServiceDeps) {
    this.db = deps.db;
    this.dataDir = deps.dataDir;
    this.events = deps.events;
  }

  /** Canonical id or NoteError('invalid_id'). */
  requireId(input: string): string {
    const id = normalizeId(input);
    if (id === null) {
      throw new NoteError('invalid_id', `"${input}" is not a note id. Ids look like A-B32 (case and the dash are optional).`);
    }
    return id;
  }

  /** An id no note (live or deleted) currently has. */
  async newId(): Promise<string> {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = generateId();
      if (!(await repo.idExists(this.db, id))) return id;
    }
    throw new NoteError('conflict', 'Could not find a free note id.');
  }

  async create(input: CreateNoteInput): Promise<Note> {
    const body = input.body;
    if (!input.allowEmpty && body.trim() === '') {
      throw new NoteError('empty_body', 'A note needs some text.');
    }
    const values = {
      body,
      tags: parseTags(body),
      origin: cleanOrigin(input.origin ?? null),
      imagePath: input.image?.path ?? null,
      imageMeta: input.image?.meta ?? null,
    };

    let row: NoteRow | null = null;
    if (input.id !== undefined) {
      const id = this.requireId(input.id);
      row = await repo.insertNote(this.db, { id, ...values });
      if (row === null) throw new NoteError('conflict', `Note id ${id} is already taken.`);
    } else {
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && row === null; attempt += 1) {
        row = await repo.insertNote(this.db, { id: generateId(), ...values });
      }
      if (row === null) throw new NoteError('conflict', 'Could not find a free note id.');
    }
    return this.finish({ row, op: 'created' });
  }

  async getOne(idInput: string, opts: GetOptions = {}): Promise<Note | null> {
    const id = normalizeId(idInput);
    if (id === null) return null;
    const row = await repo.findNoteById(this.db, id);
    if (row === null) return null;
    if (row.deletedAt !== null && !opts.includeDeleted) return null;
    return this.toNote(row);
  }

  async get(idInputs: readonly string[], opts: GetOptions = {}): Promise<GetResult> {
    const wanted: string[] = [];
    const missing: string[] = [];
    for (const input of idInputs) {
      const id = normalizeId(input);
      if (id === null) missing.push(input);
      else if (!wanted.includes(id)) wanted.push(id);
    }
    const rows = await repo.findNotesByIds(this.db, wanted);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const notes: Note[] = [];
    const deleted: string[] = [];
    for (const id of wanted) {
      const row = byId.get(id);
      if (row === undefined) missing.push(id);
      else if (row.deletedAt !== null && !opts.includeDeleted) deleted.push(id);
      else notes.push(this.toNote(row));
    }
    return { notes, missing, deleted };
  }

  async findBySha256(sha256: string, opts: GetOptions = {}): Promise<Note | null> {
    const row = await repo.findNoteBySha256(this.db, sha256, opts.includeDeleted ?? false);
    return row === null ? null : this.toNote(row);
  }

  async list(filter: NoteFilter = {}): Promise<NotePage> {
    const page = await repo.listNotes(this.db, filter);
    return { notes: page.rows.map((r) => this.toNote(r)), next_cursor: page.nextCursor };
  }

  async search(query: string, filter: NoteFilter = {}): Promise<NotePage> {
    if (query.trim() === '') throw new NoteError('invalid_input', 'search needs a non-empty query.');
    const page = await repo.searchNotes(this.db, query, filter);
    return { notes: page.rows.map((r) => this.toNote(r)), next_cursor: page.nextCursor };
  }

  async tags(): Promise<TagCount[]> {
    const rows = await repo.listTags(this.db);
    return rows.map((r) => ({ tag: r.tag, count: r.count, last_used: r.lastUsed.toISOString() }));
  }

  async revisions(idInput: string): Promise<Revision[]> {
    const id = this.requireId(idInput);
    if (!(await repo.idExists(this.db, id))) throw new NoteError('not_found', `Note ${id} does not exist.`);
    const rows = await repo.listRevisions(this.db, id);
    return rows.map((r) => ({ revision: r.id, note_id: r.noteId, body: r.body, saved_at: r.savedAt.toISOString() }));
  }

  /** Full body replace. The previous body becomes a revision in the same transaction. */
  async update(idInput: string, body: string, opts: UpdateOptions = {}): Promise<Note> {
    const id = this.requireId(idInput);
    if (!opts.allowEmpty && body.trim() === '') {
      throw new NoteError('empty_body', 'update needs a non-empty body. To remove a note use delete.');
    }
    const origin = opts.origin === undefined ? undefined : cleanOrigin(opts.origin);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await this.lockLive(tx, id);
      if (cur.body === body) {
        if (origin === undefined) return { row: cur, op: null };
        return { row: await repo.setOrigin(tx, id, origin), op: 'updated' };
      }
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setBody(tx, id, body, parseTags(body), origin), op: 'updated' };
    });
    return this.finish(result);
  }

  /** Adds text at the end, separated from the existing body by a blank line. */
  async append(idInput: string, text: string, opts: Pick<UpdateOptions, 'origin'> = {}): Promise<Note> {
    const id = this.requireId(idInput);
    if (text.trim() === '') throw new NoteError('empty_body', 'append needs some text.');
    const origin = opts.origin === undefined ? undefined : cleanOrigin(opts.origin);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await this.lockLive(tx, id);
      const head = cur.body.replace(/\s+$/, '');
      const body = head === '' ? text : `${head}\n\n${text}`;
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setBody(tx, id, body, parseTags(body), origin), op: 'updated' };
    });
    return this.finish(result);
  }

  /** Soft delete. The body is kept as a revision. Deleting a deleted note is a no-op. */
  async delete(idInput: string): Promise<Note> {
    const id = this.requireId(idInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt !== null) return { row: cur, op: null };
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setDeleted(tx, id, true), op: 'deleted' };
    });
    return this.finish(result);
  }

  /** Undoes a soft delete. Restoring a live note is a no-op. */
  async restore(idInput: string): Promise<Note> {
    const id = this.requireId(idInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt === null) return { row: cur, op: null };
      return { row: await repo.setDeleted(tx, id, false), op: 'restored' };
    });
    return this.finish(result);
  }

  /** Brings back a revision's body; the body it replaces becomes a new revision. */
  async revert(idInput: string, revision: number): Promise<Note> {
    const id = this.requireId(idInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await this.lockLive(tx, id);
      const rev = await repo.getRevision(tx, id, revision);
      if (rev === null) {
        throw new NoteError('invalid_revision', `Note ${id} has no revision ${revision}. Call revisions("${id}") to see them.`);
      }
      if (rev.body === cur.body) return { row: cur, op: null };
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setBody(tx, id, rev.body, parseTags(rev.body), undefined), op: 'updated' };
    });
    return this.finish(result);
  }

  private async lockLive(tx: repo.Tx, id: string): Promise<NoteRow> {
    const cur = await repo.lockNote(tx, id);
    if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
    if (cur.deletedAt !== null) {
      throw new NoteError('deleted', `Note ${id} is deleted. Call restore("${id}") first if you want to change it.`);
    }
    return cur;
  }

  private finish(result: Mutation): Note {
    if (result.op !== null) this.events.emit(result.op, result.row.id);
    return this.toNote(result.row);
  }

  private toNote(row: NoteRow): Note {
    return rowToNote(row, this.dataDir);
  }
}
