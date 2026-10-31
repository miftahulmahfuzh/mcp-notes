import type { Db } from '../db/client.js';
import type { NoteFileRow, NoteImageRow } from '../db/schema.js';
import { isNoteFileRelPath, removeNoteFile, removeNoteFolderIfEmpty } from '../files/store.js';
import { removeImageFiles } from '../images/store.js';
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
import * as fileRepo from './fileRepo.js';
import * as bin from './binRepo.js';
import type { BinImageRow } from './binRepo.js';
import type { NoteFilter } from './repo.js';
import { parseTags } from './tags.js';
import {
  DuplicateFileError,
  DuplicateImageError,
  NoteError,
  cleanOrigin,
  rowToNote,
  toNoteImage,
  type Bin,
  type BinImage,
  type FileMeta,
  type ImageMeta,
  type Note,
  type NotePage,
  type NoteRow,
  type Origin,
  type PurgeResult,
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

/** One image to add to a live note. `id` comes from newId(); `path` is relative to dataDir (images/YYYY/MM/<id>.<ext>). */
export interface AttachImageInput {
  id: string;
  path: string;
  meta: ImageMeta;
}

/** One file to add to a live note. `id` comes from newId(); `path` is `files/<noteId>/<safeName>` (src/files/store.ts fileRelPath). */
export interface AttachFileInput {
  id: string;
  path: string;
  meta: FileMeta;
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

export interface BinOptions {
  /** Entries whose note carries every one of these tags. `#` prefix and case are ignored. */
  tagsAll?: string[];
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

  /** An id no note, image or file (live or deleted) currently has. A note's first image takes the note's id. */
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
          await imageRepo.insertImage(tx, imageValues(id, id, image.path, image.meta, 0));
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

  /**
   * Adds one image to a live note, after every image it ever had: position = max position over
   * all its images (removed ones included) + 1, so a removed image keeps its slot for restore.
   * The same bytes live anywhere -> NoteError('duplicate_image'); a taken image id ->
   * NoteError('conflict'); a deleted note -> NoteError('deleted'). Emits `updated`.
   */
  async attachImage(noteIdInput: string, input: AttachImageInput): Promise<Note> {
    const noteId = this.requireId(noteIdInput);
    const imageId = this.requireImageId(input.id);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      await this.lockLive(tx, noteId);
      if (await imageRepo.imageIdTaken(tx, imageId)) {
        throw new NoteError('conflict', `Image id ${imageId} is already taken.`);
      }
      const position = await imageRepo.nextPosition(tx, noteId);
      await imageRepo.insertImage(tx, imageValues(noteId, imageId, input.path, input.meta, position));
      return { row: await repo.touchNote(tx, noteId), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Soft-removes one image from its note (it goes to the bin; the file is untouched). Works
   * whatever state the note is in. Removing a removed image is a no-op. Returns the owning note.
   * Emits `updated` with the note id.
   */
  async removeImage(imageIdInput: string): Promise<Note> {
    const imageId = this.requireImageId(imageIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, image } = await this.lockImage(tx, imageId);
      if (image.deletedAt !== null) return { row: note, op: null };
      await imageRepo.setImageDeleted(tx, imageId, true);
      return { row: await repo.touchNote(tx, note.id), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Puts a removed image back at its old position, and restores its note when the note is
   * deleted (an image is only visible in a live note). The same bytes already live in another
   * image -> DuplicateImageError naming that image's note. A live image in a live note is a
   * no-op. Emits `restored` when the note came back, else `updated`, with the note id.
   */
  async restoreImage(imageIdInput: string): Promise<Note> {
    const imageId = this.requireImageId(imageIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, image } = await this.lockImage(tx, imageId);
      const imageRemoved = image.deletedAt !== null;
      const noteDeleted = note.deletedAt !== null;
      if (!imageRemoved && !noteDeleted) return { row: note, op: null };
      if (imageRemoved) {
        const holder = await imageRepo.findLiveImageBySha256(tx, image.sha256);
        if (holder !== null && holder.image.id !== image.id) {
          throw new DuplicateImageError(
            holder.image.noteId,
            `Image ${imageId} cannot be restored: the same picture is already in note ${holder.image.noteId}. Open that note instead, or remove the picture there first.`,
          );
        }
        try {
          await imageRepo.setImageDeleted(tx, imageId, false);
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new NoteError(
              'duplicate_image',
              `Image ${imageId} cannot be restored: the same picture was just saved in another note. Try again to see which.`,
            );
          }
          throw err;
        }
      }
      if (noteDeleted) await repo.setDeleted(tx, note.id, false);
      return { row: await repo.touchNote(tx, note.id), op: noteDeleted ? 'restored' : 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Adds one non-image file to a live note, after every file it ever had (position = max over
   * all its file rows, removed included, + 1). `path` must be `files/<noteId>/<safe name>` ->
   * else NoteError('invalid_input'). The same bytes live in another file -> NoteError('duplicate_file');
   * a taken id or path -> NoteError('conflict'); a deleted note -> NoteError('deleted'). Emits `updated`.
   */
  async attachFile(noteIdInput: string, input: AttachFileInput): Promise<Note> {
    const noteId = this.requireId(noteIdInput);
    const fileId = this.requireFileId(input.id);
    if (!isNoteFileRelPath(noteId, input.path)) {
      throw new NoteError('invalid_input', `File path ${input.path} is not inside files/${noteId}/.`);
    }
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      await this.lockLive(tx, noteId);
      if (await imageRepo.imageIdTaken(tx, fileId)) {
        throw new NoteError('conflict', `File id ${fileId} is already taken.`);
      }
      const position = await fileRepo.nextFilePosition(tx, noteId);
      await fileRepo.insertFile(tx, fileValues(noteId, fileId, input.path, input.meta, position));
      return { row: await repo.touchNote(tx, noteId), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Soft-removes one file from its note (the bytes stay on disk; position is kept for restore).
   * Works whatever state the note is in. Removing a removed file is a no-op. Returns the owning
   * note. Emits `updated` with the note id.
   */
  async removeFile(fileIdInput: string): Promise<Note> {
    const fileId = this.requireFileId(fileIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, file } = await this.lockFile(tx, fileId);
      if (file.deletedAt !== null) return { row: note, op: null };
      await fileRepo.setFileDeleted(tx, fileId, true);
      return { row: await repo.touchNote(tx, note.id), op: 'updated' };
    });
    return this.finish(result);
  }

  /**
   * Puts a removed file back at its old position, and restores its note when the note is
   * deleted. The same bytes already live in another file -> DuplicateFileError naming that
   * file's note. A live file in a live note is a no-op. Emits `restored` when the note came back,
   * else `updated`, with the note id.
   */
  async restoreFile(fileIdInput: string): Promise<Note> {
    const fileId = this.requireFileId(fileIdInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const { note, file } = await this.lockFile(tx, fileId);
      const fileRemoved = file.deletedAt !== null;
      const noteDeleted = note.deletedAt !== null;
      if (!fileRemoved && !noteDeleted) return { row: note, op: null };
      if (fileRemoved) {
        const holder = await fileRepo.findLiveFileBySha256(tx, file.sha256);
        if (holder !== null && holder.file.id !== file.id) {
          throw new DuplicateFileError(
            holder.file.noteId,
            `File ${fileId} cannot be restored: the same file is already in note ${holder.file.noteId}. Open that note instead, or remove the file there first.`,
          );
        }
        try {
          await fileRepo.setFileDeleted(tx, fileId, false);
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new NoteError(
              'duplicate_file',
              `File ${fileId} cannot be restored: the same file was just saved in another note. Try again to see which.`,
            );
          }
          throw err;
        }
      }
      if (noteDeleted) await repo.setDeleted(tx, note.id, false);
      return { row: await repo.touchNote(tx, note.id), op: noteDeleted ? 'restored' : 'updated' };
    });
    return this.finish(result);
  }

  /**
   * The recycle bin: deleted notes (each with its non-removed images) and every binned image,
   * both newest-deleted first, optionally narrowed to notes carrying every tag in `tagsAll`.
   * Read-only; live notes' sidebar counts (tags()) are unaffected.
   */
  async listBin(opts: BinOptions = {}): Promise<Bin> {
    const ids = await bin.listDeletedNoteIds(this.db, opts.tagsAll);
    // get() keeps the asked order and attaches each note's live images. A note purged between
    // the two queries lands in `missing` and is simply not listed.
    const { notes } = await this.get(ids, { includeDeleted: true });
    const rows = await bin.listBinImages(this.db, opts.tagsAll);
    return { notes, images: rows.map((r) => toBinImage(r, this.dataDir)) };
  }

  /**
   * Delete forever: only a deleted note. Removes the notes row (images, files, revisions and
   * embeddings cascade) in one transaction, then, on disk, the original and derived files of
   * every image the note held and every file under files/<noteId>/ that one of its file rows
   * names, removed ones included, then that folder if it is empty. A file that cannot be removed
   * is logged, never fails the purge. UI-only: no MCP tool calls this.
   */
  async purgeNote(idInput: string): Promise<PurgeResult> {
    const id = this.requireId(idInput);
    type Target = { id: string; path: string };
    const targets = await this.db.transaction(async (tx): Promise<{ images: Target[]; files: Target[] }> => {
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt === null) {
        throw new NoteError('not_deleted', `Note ${id} is not deleted. Only notes in the bin can be deleted forever.`);
      }
      const rows = (await imageRepo.imagesForNotes(tx, [id], { includeRemoved: true })).get(id) ?? [];
      const images = rows.map((img) => ({ id: img.id, path: img.path }));
      // The legacy column names a file too; after the reconcile it is the same path as the
      // note's first image row, so this only adds something if that row is somehow missing.
      if (cur.imagePath !== null && !images.some((f) => f.path === cur.imagePath)) {
        images.push({ id, path: cur.imagePath });
      }
      const fileRows = (await fileRepo.filesForNotes(tx, [id], { includeRemoved: true })).get(id) ?? [];
      await bin.deleteNoteRow(tx, id);
      return { images, files: fileRows.map((f) => ({ id: f.id, path: f.path })) };
    });
    const removed = (await this.removeFiles(targets.images)) + (await this.removeNoteFiles(id, targets.files));
    this.events.emit('purged', id);
    return { purged: id, files: removed };
  }

  /**
   * Delete forever: only an image removed from its note (its own deleted_at set). An image of a
   * deleted note that was never removed is purged with its note (purgeNote), not here. When the
   * row is the note's legacy image (same id as the note and the path in notes.image_path), the
   * legacy columns are cleared in the same transaction so reconcileLegacyImages cannot bring it
   * back. Then its original and derived files are removed.
   */
  async purgeImage(idInput: string): Promise<PurgeResult> {
    const imageId = this.requireImageId(idInput);
    const first = await imageRepo.findImageById(this.db, imageId);
    if (first === null) throw new NoteError('not_found', `Image ${imageId} does not exist.`);
    const target = await this.db.transaction(async (tx) => {
      // Note first, then image: the same order as the image writes (lockImage).
      const note = await repo.lockNote(tx, first.noteId);
      const img = await bin.lockImageRow(tx, imageId);
      if (note === null || img === null) throw new NoteError('not_found', `Image ${imageId} does not exist.`);
      if (img.deletedAt === null) {
        throw new NoteError(
          'not_deleted',
          `Image ${imageId} is not removed from note ${img.noteId}. Only images in the bin can be deleted forever.`,
        );
      }
      await bin.deleteImageRow(tx, imageId);
      if (img.id === img.noteId && note.imagePath === img.path) await bin.clearLegacyImage(tx, note.id);
      return img;
    });
    const files = await this.removeFiles([{ id: target.id, path: target.path }]);
    this.events.emit('purged', target.noteId);
    return { purged: imageId, files };
  }

  /**
   * Removes each image's original and cache dir after the rows are gone. A file that cannot be
   * removed is logged and skipped: the purge already committed, and a leftover file is
   * harmless (no row points at it).
   */
  private async removeFiles(targets: ReadonlyArray<{ id: string; path: string }>): Promise<number> {
    let removed = 0;
    for (const target of targets) {
      try {
        removed += await removeImageFiles(this.dataDir, target);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`notesd: purge could not remove the files of image ${target.id} (${target.path}): ${reason}`);
      }
    }
    return removed;
  }

  /**
   * Removes a purged note's files from files/<noteId>/, then the folder when it is empty. Each
   * failure is logged and skipped: the rows are already gone, and a leftover file is harmless.
   */
  private async removeNoteFiles(noteId: string, targets: ReadonlyArray<{ id: string; path: string }>): Promise<number> {
    let removed = 0;
    for (const target of targets) {
      try {
        removed += await removeNoteFile(this.dataDir, noteId, target.path);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`notesd: purge could not remove file ${target.id} (${target.path}) of note ${noteId}: ${reason}`);
      }
    }
    try {
      await removeNoteFolderIfEmpty(this.dataDir, noteId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`notesd: purge could not remove the files folder of note ${noteId}: ${reason}`);
    }
    return removed;
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

  /** Canonical image id or NoteError('invalid_id'). Image ids share the note-id format. */
  private requireImageId(input: string): string {
    const id = normalizeId(input);
    if (id === null) {
      throw new NoteError(
        'invalid_id',
        `"${input}" is not an image id. Image ids look like A-B32 (case and the dash are optional); every note lists its images with their ids.`,
      );
    }
    return id;
  }

  /** Canonical file id or NoteError('invalid_id'). File ids share the note-id format. */
  private requireFileId(input: string): string {
    const id = normalizeId(input);
    if (id === null) {
      throw new NoteError(
        'invalid_id',
        `"${input}" is not a file id. File ids look like A-B32 (case and the dash are optional); every note lists its files with their ids.`,
      );
    }
    return id;
  }

  /**
   * Locks the image's owning note, then re-reads the image, so concurrent changes to one note's
   * images run one after another. Unknown image -> NoteError('not_found').
   * Lock order for the whole set: the note row first, then the image row (the image row is
   * locked implicitly by the UPDATE that follows). Phase 4's purgeImage uses the same order.
   */
  private async lockImage(tx: repo.Tx, imageId: string): Promise<{ note: NoteRow; image: NoteImageRow }> {
    const first = await imageRepo.findImageById(tx, imageId);
    if (first === null) throw imageNotFound(imageId);
    const note = await repo.lockNote(tx, first.noteId);
    const image = await imageRepo.findImageById(tx, imageId);
    if (note === null || image === null) throw imageNotFound(imageId);
    return { note, image };
  }

  /** As lockImage, for files: the owning note row first, then the file is re-read. */
  private async lockFile(tx: repo.Tx, fileId: string): Promise<{ note: NoteRow; file: NoteFileRow }> {
    const first = await fileRepo.findFileById(tx, fileId);
    if (first === null) throw fileNotFound(fileId);
    const note = await repo.lockNote(tx, first.noteId);
    const file = await fileRepo.findFileById(tx, fileId);
    if (note === null || file === null) throw fileNotFound(fileId);
    return { note, file };
  }

  private async finish(result: Mutation): Promise<Note> {
    if (result.op !== null) this.events.emit(result.op, result.row.id);
    return this.toNote(result.row);
  }

  private async toNote(row: NoteRow): Promise<Note> {
    const [note] = await this.toNotes([row]);
    return note!;
  }

  /** Wire notes in input order, with every note's live images and live files loaded in one query each. */
  private async toNotes(rows: readonly NoteRow[]): Promise<Note[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const images = await imageRepo.imagesForNotes(this.db, ids);
    const files = await fileRepo.filesForNotes(this.db, ids);
    return rows.map((r) => rowToNote(r, this.dataDir, images.get(r.id) ?? [], files.get(r.id) ?? []));
  }
}

/** 4 decimals: enough to order and compare, short enough to read in a tool result. */
function roundSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** One bin listing row -> wire BinImage. The bin query guarantees one of the two times is set. */
function toBinImage(row: BinImageRow, dataDir: string): BinImage {
  const removedAt = row.image.deletedAt;
  const binnedAt = removedAt ?? row.noteDeletedAt;
  if (binnedAt === null) throw new Error(`image ${row.image.id} is not in the bin`);
  const image = toNoteImage(row.image, dataDir);
  return {
    // deleted_at on the image itself marks a removed image (contract: present only on those).
    image: removedAt !== null ? { ...image, deleted_at: removedAt.toISOString() } : image,
    note_id: row.image.noteId,
    kind: removedAt !== null ? 'image' : 'note',
    deleted_at: binnedAt.toISOString(),
  };
}

/** note_images insert values for one image (drizzle field names). */
function imageValues(noteId: string, id: string, path: string, meta: ImageMeta, position: number) {
  return {
    id,
    noteId,
    path,
    sha256: meta.sha256,
    mime: meta.mime,
    width: meta.width,
    height: meta.height,
    bytes: meta.bytes,
    takenAt: meta.taken_at === null ? null : new Date(meta.taken_at),
    originalName: meta.original_name,
    host: meta.host,
    position,
  };
}

/** note_files insert values for one file (drizzle field names). extraction_status takes its default 'none'. */
function fileValues(noteId: string, id: string, path: string, meta: FileMeta, position: number) {
  return {
    id,
    noteId,
    path,
    sha256: meta.sha256,
    mime: meta.mime,
    bytes: meta.bytes,
    originalName: meta.original_name,
    host: meta.host,
    position,
  };
}

function imageNotFound(imageId: string): NoteError {
  return new NoteError('not_found', `Image ${imageId} does not exist. Image ids are listed in each note's images.`);
}

function fileNotFound(fileId: string): NoteError {
  return new NoteError('not_found', `File ${fileId} does not exist. File ids are listed in each note's files.`);
}

/** A unique-index clash: NoteError('duplicate_image' | 'duplicate_file') or a raw Postgres 23505. */
function isUniqueViolation(err: unknown): boolean {
  if (err instanceof NoteError) return err.code === 'duplicate_image' || err.code === 'duplicate_file';
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth += 1) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
