import type { Db } from '../db/client.js';
import { EMBEDDING_MODEL } from '../embeddings/constants.js';
import type { Embedder } from '../embeddings/embedder.js';
import * as embeddings from '../embeddings/repo.js';
import { bodySha256, embedInput } from '../embeddings/state.js';
import { BLEND, queryTerms, rankCandidates, tagMatch } from '../search/blend.js';
import {
  QUERY_EMBED_TIMEOUT_MS,
  QueryVectorCache,
  SEMANTIC_OFF_FALLBACK,
  embedFailedFallback,
  embedQuery,
} from '../search/queryVector.js';
import type { NoteEvents, NoteOp } from './events.js';
import { generateId, normalizeId } from './ids.js';
import * as repo from './repo.js';
import * as imageRepo from './imageRepo.js';
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
  type RelatedResult,
  type Revision,
  type SearchMode,
  type SearchPage,
  type TagCount,
} from './types.js';

export const MAX_ID_ATTEMPTS = 20;

export interface NotesServiceDeps {
  db: Db;
  dataDir: string;
  events: NoteEvents;
  /**
   * Query embedder for hybrid search and `related` (phases 4-5). Omitted or null: those fall back
   * or report that semantic search is off. Writes never use it.
   */
  embedder?: Embedder | null;
}

export interface CreateNoteInput {
  /** May be empty only when `allowEmpty` is true. */
  body: string;
  origin?: Origin | null;
  /** First image of the note: written to note_images with the note's id and position 0. `path` is relative to dataDir. */
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

export interface SearchOptions {
  /** 'hybrid' (default): full text + meaning + tags + recency. 'text': today's full-text ranking only. */
  mode?: SearchMode | undefined;
  /** Ceiling for the query embedding call. Default QUERY_EMBED_TIMEOUT_MS; tests shorten it. */
  queryTimeoutMs?: number | undefined;
}

/** related(): neighbours returned when no limit is given, and the most it returns. */
export const RELATED_DEFAULT_LIMIT = 10;
export const RELATED_MAX_LIMIT = 50;

export interface RelatedOptions {
  /** 1..RELATED_MAX_LIMIT, default RELATED_DEFAULT_LIMIT. Out-of-range values are clamped. */
  limit?: number;
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
  private readonly embedder: Embedder | null;
  /** Query vectors, so paging through one search embeds its query once. */
  private readonly queryVectors = new QueryVectorCache();

  constructor(deps: NotesServiceDeps) {
    this.db = deps.db;
    this.dataDir = deps.dataDir;
    this.events = deps.events;
    this.embedder = deps.embedder ?? null;
  }

  /** Canonical id or NoteError('invalid_id'). */
  requireId(input: string): string {
    const id = normalizeId(input);
    if (id === null) {
      throw new NoteError('invalid_id', `"${input}" is not a note id. Ids look like A-B32 (case and the dash are optional).`);
    }
    return id;
  }

  /** An id no note and no image (live or deleted) currently has. A note's first image takes the note's id. */
  async newId(): Promise<string> {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = generateId();
      if (!(await imageRepo.imageIdTaken(this.db, id))) return id;
    }
    throw new NoteError('conflict', 'Could not find a free note id.');
  }

  /**
   * Inserts a note and, when `image` is given, its first image (id = note id, position 0) in one
   * transaction. A clash on the live-image sha256 index throws NoteError('duplicate_image') and
   * leaves nothing behind. An id held by any note or image is never reused.
   */
  async create(input: CreateNoteInput): Promise<Note> {
    const body = input.body;
    if (!input.allowEmpty && body.trim() === '') {
      throw new NoteError('empty_body', 'A note needs some text.');
    }
    const values = { body, tags: parseTags(body), origin: cleanOrigin(input.origin ?? null) };
    const image = input.image ?? null;
    const fixedId = input.id !== undefined ? this.requireId(input.id) : null;

    const row = await this.db.transaction(async (tx): Promise<NoteRow> => {
      const attempts = fixedId !== null ? 1 : MAX_ID_ATTEMPTS;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const id = fixedId ?? generateId();
        const inserted = (await imageRepo.imageIdTaken(tx, id)) ? null : await repo.insertNote(tx, { id, ...values });
        if (inserted === null) continue;
        if (image !== null) {
          await imageRepo.insertImage(tx, {
            id,
            noteId: id,
            path: image.path,
            sha256: image.meta.sha256,
            mime: image.meta.mime,
            width: image.meta.width,
            height: image.meta.height,
            bytes: image.meta.bytes,
            takenAt: image.meta.taken_at === null ? null : new Date(image.meta.taken_at),
            originalName: image.meta.original_name,
            host: image.meta.host,
            position: 0,
          });
        }
        return inserted;
      }
      throw new NoteError('conflict', fixedId !== null ? `Note id ${fixedId} is already taken.` : 'Could not find a free note id.');
    });
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
    const shown: NoteRow[] = [];
    const deleted: string[] = [];
    for (const id of wanted) {
      const row = byId.get(id);
      if (row === undefined) missing.push(id);
      else if (row.deletedAt !== null && !opts.includeDeleted) deleted.push(id);
      else shown.push(row);
    }
    return { notes: await this.toNotes(shown), missing, deleted };
  }

  /** The note holding a live image with these bytes. A deleted holder only when includeDeleted is set. */
  async findBySha256(sha256: string, opts: GetOptions = {}): Promise<Note | null> {
    const hit = await imageRepo.findLiveImageBySha256(this.db, sha256);
    if (hit === null) return null;
    return this.getOne(hit.image.noteId, opts);
  }

  async list(filter: NoteFilter = {}): Promise<NotePage> {
    const page = await repo.listNotes(this.db, filter);
    return { notes: await this.toNotes(page.rows), next_cursor: page.nextCursor };
  }

  /**
   * Hybrid by default: full-text rank, closeness in meaning, tag match and recency, blended by
   * src/search/blend.ts over candidates that already passed the filter. Falls back to the
   * full-text ranking, with `fallback` saying why, when there is no embedder or the query
   * cannot be embedded in time. mode 'text' is exactly the pre-iteration-6 ranking. The cursor
   * is an offset into whichever ranking produced the page.
   */
  async search(query: string, filter: NoteFilter = {}, opts: SearchOptions = {}): Promise<SearchPage> {
    if (query.trim() === '') throw new NoteError('invalid_input', 'search needs a non-empty query.');
    if (opts.mode === 'text') return this.textSearch(query, filter);
    // Reject a bad cursor before spending an embedding call on it.
    const offset = repo.decodeCursor(filter.cursor);
    const limit = repo.clampLimit(filter.limit);
    const embedder = this.embedder;
    if (embedder === null) return this.textSearch(query, filter, SEMANTIC_OFF_FALLBACK);

    let vector: number[];
    try {
      vector = await embedQuery(embedder, this.queryVectors, query, opts.queryTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS);
    } catch (err) {
      return this.textSearch(query, filter, embedFailedFallback(err));
    }

    const terms = queryTerms(query);
    const rows = await repo.searchCandidates(
      this.db,
      {
        query,
        vector,
        model: embedder.model,
        ids: terms.ids,
        excluded: terms.excluded,
        textLimit: BLEND.textCandidates,
        vectorLimit: BLEND.vectorCandidates,
      },
      filter,
    );
    const ranked = rankCandidates(
      rows.map((r) => ({
        id: r.row.id,
        textRank: r.textRank,
        similarity: r.similarity,
        tagMatch: tagMatch(r.row.tags, terms),
        updatedAt: r.row.updatedAt,
        exactId: terms.ids.includes(r.row.id),
        row: r.row,
      })),
      { now: new Date() },
    );
    const end = offset + limit;
    return {
      notes: await this.toNotes(ranked.slice(offset, end).map((c) => c.row)),
      next_cursor: ranked.length > end ? repo.encodeCursor(end) : null,
      mode: 'hybrid',
    };
  }

  /** Today's full-text ranking (repo.searchNotes, unchanged), optionally marked as a fallback. */
  private async textSearch(query: string, filter: NoteFilter, fallback?: string): Promise<SearchPage> {
    const page = await repo.searchNotes(this.db, query, filter);
    const result: SearchPage = { notes: await this.toNotes(page.rows), next_cursor: page.nextCursor, mode: 'text' };
    if (fallback !== undefined) result.fallback = fallback;
    return result;
  }

  async tags(): Promise<TagCount[]> {
    const rows = await repo.listTags(this.db);
    return rows.map((r) => ({ tag: r.tag, count: r.count, last_used: r.lastUsed.toISOString() }));
  }

  /**
   * Live notes nearest in meaning to one note, most similar first. The note itself, deleted
   * notes and notes whose vector no longer matches their body are never returned. A source note
   * with no current vector is embedded here when an embedder is configured (the same guarded
   * upsert the background worker does); without one this fails with NoteError('not_embedded').
   */
  async related(idInput: string, opts: RelatedOptions = {}): Promise<RelatedResult> {
    const id = this.requireId(idInput);
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? RELATED_DEFAULT_LIMIT), 1), RELATED_MAX_LIMIT);
    const row = await repo.findNoteById(this.db, id);
    if (row === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
    if (row.deletedAt !== null) {
      throw new NoteError('deleted', `Note ${id} is deleted. Call restore("${id}") first if you want notes related to it.`);
    }
    const input = embedInput(row.body);
    if (input === null) {
      const hasImages = (await imageRepo.imagesForNotes(this.db, [id])).get(id)?.length ?? 0;
      const what = hasImages > 0 ? 'is a photo with no text' : 'has no text';
      throw new NoteError(
        'invalid_input',
        `Note ${id} ${what}, so there is nothing to compare by meaning. Add a description with append("${id}", ...) first, or use list with dates to find notes from the same time.`,
      );
    }
    const model = this.embedder?.model ?? EMBEDDING_MODEL;
    let nearest = await embeddings.nearestNotes(this.db, { noteId: id, model, limit });
    if (nearest === null) {
      await this.embedNow(id, row.body, input);
      nearest = await embeddings.nearestNotes(this.db, { noteId: id, model, limit });
      if (nearest === null) {
        throw new NoteError('not_embedded', `Note ${id} changed while it was being embedded. Try again.`);
      }
    }
    const neighbours = await this.toNotes(nearest.map((n) => n.row));
    return {
      note_id: id,
      related: nearest.map((n, i) => ({ note: neighbours[i]!, similarity: roundSimilarity(1 - n.distance) })),
    };
  }

  /** Embeds one note's body now and stores the vector (skipped by saveEmbedding if the body changed meanwhile). */
  private async embedNow(id: string, body: string, input: string): Promise<void> {
    const embedder = this.embedder;
    if (!embedder) {
      throw new NoteError(
        'not_embedded',
        `Note ${id} has no embedding yet and semantic search is off on this daemon (OPENROUTER_API_KEY is not set), so related notes cannot be found for it. Use search with words from the note instead.`,
      );
    }
    let vectors: number[][];
    try {
      vectors = await embedder.embed([input]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new NoteError(
        'not_embedded',
        `Note ${id} has no embedding yet and embedding it now failed (${reason}). The background job retries it; try again later, or use search with words from the note.`,
      );
    }
    const vector = vectors[0];
    if (vector === undefined) {
      throw new NoteError('not_embedded', `Note ${id} has no embedding yet and the embedder returned none. Try again later.`);
    }
    await embeddings.saveEmbedding(this.db, { noteId: id, bodySha256: bodySha256(body), model: embedder.model, embedding: vector });
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

  private async finish(result: Mutation): Promise<Note> {
    if (result.op !== null) this.events.emit(result.op, result.row.id);
    return this.toNote(result.row);
  }

  private async toNote(row: NoteRow): Promise<Note> {
    const [note] = await this.toNotes([row]);
    return note!;
  }

  /** Wire notes in input order, with every note's live images loaded in one query. */
  private async toNotes(rows: readonly NoteRow[]): Promise<Note[]> {
    if (rows.length === 0) return [];
    const images = await imageRepo.imagesForNotes(this.db, rows.map((r) => r.id));
    return rows.map((r) => rowToNote(r, this.dataDir, images.get(r.id) ?? []));
  }
}

/** 4 decimals: enough to order and compare, short enough to read in a tool result. */
function roundSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
