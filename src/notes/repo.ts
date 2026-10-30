import { and, arrayContains, arrayOverlaps, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { noteEmbeddings, noteImages, noteRevisions, notes } from '../db/schema.js';
import { isCurrentEmbeddingSql, toVectorLiteral } from '../embeddings/repo.js';
import { parseDateBound } from './dates.js';
import { NoteError, type NoteRow, type Origin } from './types.js';

/** A transaction handle, as passed to the callback of `db.transaction`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything a query can run on: the pool-backed db or an open transaction. */
export type Executor = Db | Tx;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 5000;

/**
 * Filters shared by list and search. Phase 5 adds `takenFrom` / `takenTo` here and in
 * `filterConditions`; nothing else needs to change.
 */
export interface NoteFilter {
  /** Notes carrying at least one of these tags. `#` prefix and case are ignored. */
  tagsAny?: string[];
  /** Notes carrying every one of these tags. */
  tagsAll?: string[];
  /** Which timestamp `from` / `to` apply to (and list sorts by). Default 'created'. */
  dateField?: 'created' | 'updated';
  /** Inclusive lower bound: YYYY-MM-DD (local day) or ISO datetime. */
  from?: string;
  /** Inclusive upper bound: YYYY-MM-DD (local day) or ISO datetime. */
  to?: string;
  /** true = notes with at least one live image, false = notes with none, undefined = both. */
  hasImage?: boolean;
  /** EXIF taken date, lower bound: YYYY-MM-DD (local day) or ISO datetime. Matches when any live image was taken in range. */
  takenFrom?: string;
  /** EXIF taken date, upper bound, inclusive: YYYY-MM-DD (whole local day) or ISO datetime. */
  takenTo?: string;
  /** Default 'exclude'. */
  deleted?: 'exclude' | 'include' | 'only';
  /** 1..MAX_LIMIT, default DEFAULT_LIMIT. */
  limit?: number;
  /** Opaque value from a previous page's `next_cursor`. */
  cursor?: string;
}

export interface RowPage {
  rows: NoteRow[];
  nextCursor: string | null;
}

export interface TagRow {
  tag: string;
  count: number;
  lastUsed: Date;
}

export interface RevisionRow {
  id: number;
  noteId: string;
  body: string;
  savedAt: Date;
}

export interface InsertNote {
  id: string;
  body: string;
  tags: string[];
  origin: Origin | null;
}

/** `#Seer`, ` seer ` and `SEER` all become `seer`; empty entries are dropped. */
export function normalizeTagInput(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/^#+/, '').toLowerCase();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      const o = (parsed as { o?: unknown }).o;
      if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
    }
  } catch {
    // fall through
  }
  throw new NoteError('invalid_input', 'cursor is not valid; pass the next_cursor from a previous result unchanged.');
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function dateColumn(filter: NoteFilter) {
  return filter.dateField === 'updated' ? notes.updatedAt : notes.createdAt;
}

/**
 * `exists (select 1 from note_images where note_id = notes.id and deleted_at is null [and extra...])`.
 * The subquery names "note_images" unaliased; an outer query that also joins note_images must alias its own copy.
 */
function liveImageExists(extra: readonly SQL[] = []): SQL {
  const conds: SQL[] = [sql`${noteImages.noteId} = ${notes.id}`, sql`${noteImages.deletedAt} is null`, ...extra];
  return sql`exists (select 1 from ${noteImages} where ${sql.join(conds, sql` and `)})`;
}

/** WHERE conditions for a filter (paging excluded). */
export function filterConditions(filter: NoteFilter): SQL[] {
  const conds: SQL[] = [];
  const deleted = filter.deleted ?? 'exclude';
  if (deleted === 'exclude') conds.push(isNull(notes.deletedAt));
  if (deleted === 'only') conds.push(isNotNull(notes.deletedAt));

  const any = normalizeTagInput(filter.tagsAny);
  if (any.length > 0) conds.push(arrayOverlaps(notes.tags, any));
  const all = normalizeTagInput(filter.tagsAll);
  if (all.length > 0) conds.push(arrayContains(notes.tags, all));

  const col = dateColumn(filter);
  if (filter.from !== undefined && filter.from !== '') conds.push(gte(col, parseDateBound(filter.from, 'from')));
  if (filter.to !== undefined && filter.to !== '') conds.push(lt(col, parseDateBound(filter.to, 'to')));

  // "Has an image" means at least one live image (iteration 7).
  if (filter.hasImage === true) conds.push(liveImageExists());
  if (filter.hasImage === false) conds.push(sql`not ${liveImageExists()}`);

  // Taken range: one image must meet both bounds (any image may match), served by note_images_taken_at_idx.
  const taken: SQL[] = [];
  if (filter.takenFrom !== undefined && filter.takenFrom !== '') {
    taken.push(sql`${noteImages.takenAt} >= ${parseDateBound(filter.takenFrom, 'from').toISOString()}::timestamptz`);
  }
  if (filter.takenTo !== undefined && filter.takenTo !== '') {
    taken.push(sql`${noteImages.takenAt} < ${parseDateBound(filter.takenTo, 'to').toISOString()}::timestamptz`);
  }
  if (taken.length > 0) conds.push(liveImageExists(taken));
  return conds;
}

function page(rows: NoteRow[], limit: number, offset: number): RowPage {
  if (rows.length > limit) return { rows: rows.slice(0, limit), nextCursor: encodeCursor(offset + limit) };
  return { rows, nextCursor: null };
}

export async function listNotes(db: Executor, filter: NoteFilter): Promise<RowPage> {
  const limit = clampLimit(filter.limit);
  const offset = decodeCursor(filter.cursor);
  const col = dateColumn(filter);
  const rows = await db
    .select()
    .from(notes)
    .where(and(...filterConditions(filter)))
    .orderBy(desc(col), desc(notes.id))
    .limit(limit + 1)
    .offset(offset);
  return page(rows, limit, offset);
}

export async function searchNotes(db: Executor, query: string, filter: NoteFilter): Promise<RowPage> {
  const limit = clampLimit(filter.limit);
  const offset = decodeCursor(filter.cursor);
  // Must match the expression of phase 1's GIN index so the planner can use it.
  const vector = sql`to_tsvector('simple', ${notes.body})`;
  const tsquery = sql`websearch_to_tsquery('simple', ${query})`;
  const rows = await db
    .select()
    .from(notes)
    .where(and(sql`${vector} @@ ${tsquery}`, ...filterConditions(filter)))
    .orderBy(desc(sql`ts_rank(${vector}, ${tsquery})`), desc(notes.updatedAt), desc(notes.id))
    .limit(limit + 1)
    .offset(offset);
  return page(rows, limit, offset);
}

/** Input of the hybrid candidate query. */
export interface CandidateQuery {
  /** The raw query, for websearch_to_tsquery (same as text mode). */
  query: string;
  /** The query's embedding (EMBEDDING_DIMENSIONS wide). */
  vector: readonly number[];
  /** Model whose vectors count as current (the embedder's). */
  model: string;
  /** Note ids named in the query: always candidates, if they pass the filter. */
  ids: readonly string[];
  /** websearch "-word" exclusions; also applied to the meaning-only side. */
  excluded: readonly string[];
  /** Max full-text matches, best ts_rank first. */
  textLimit: number;
  /** Max nearest notes by meaning. */
  vectorLimit: number;
}

export interface CandidateRow {
  row: NoteRow;
  /** Raw ts_rank; null when the note does not match the full-text query. */
  textRank: number | null;
  /** 1 - cosine distance of the note's current vector; null when it has none. */
  similarity: number | null;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Candidates for hybrid search: full-text matches ∪ nearest current vectors ∪ notes named by
 * id, every source under the same filterConditions, so filters apply before ranking. Each row
 * carries both signals (text rank and similarity) whichever source found it. Unordered;
 * src/search/blend.ts ranks. `notes` and `note_embeddings` are never aliased, because
 * isCurrentEmbeddingSql interpolates their columns by real name.
 */
export async function searchCandidates(db: Db, q: CandidateQuery, filter: NoteFilter): Promise<CandidateRow[]> {
  const filters = filterConditions(filter);
  // Same expressions as searchNotes / the GIN index.
  const tsv = sql`to_tsvector('simple', ${notes.body})`;
  const tsq = sql`websearch_to_tsquery('simple', ${q.query})`;
  const qvec = sql`${toVectorLiteral(q.vector)}::vector`;
  const distance = sql`(${noteEmbeddings.embedding} <=> ${qvec})`;
  const joinCurrent = sql`${noteEmbeddings.noteId} = ${notes.id} and ${isCurrentEmbeddingSql(q.model)}`;
  const fields = {
    note: notes,
    textRank: sql<number | null>`(case when ${tsv} @@ ${tsq} then ts_rank(${tsv}, ${tsq}) end)::float8`,
    similarity: sql<number | null>`(1 - ${distance})::float8`,
  };

  // 1. Full-text matches, in text mode's order, with their similarity when they have a current vector.
  const textRows = await db
    .select(fields)
    .from(notes)
    .leftJoin(noteEmbeddings, joinCurrent)
    .where(and(sql`${tsv} @@ ${tsq}`, ...filters))
    .orderBy(desc(sql`ts_rank(${tsv}, ${tsq})`), desc(notes.updatedAt), desc(notes.id))
    .limit(q.textLimit);

  // 2. Nearest current vectors. ORDER BY <distance> LIMIT is the shape the HNSW cosine index
  // serves; iterative_scan keeps walking the index when filters drop rows (pgvector >= 0.8,
  // same setting phase 5's nearestNotes uses), so selective filters still get up to K rows.
  const excludedConds: SQL[] =
    q.excluded.length > 0 ? [sql`not (${tsv} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`] : [];
  const vectorRows = await db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
    return tx
      .select(fields)
      .from(notes)
      .innerJoin(noteEmbeddings, joinCurrent)
      .where(and(...filters, ...excludedConds))
      .orderBy(distance)
      .limit(q.vectorLimit);
  });

  // 3. Notes the query names by id.
  const idRows =
    q.ids.length > 0
      ? await db
          .select(fields)
          .from(notes)
          .leftJoin(noteEmbeddings, joinCurrent)
          .where(and(inArray(notes.id, [...q.ids]), ...filters))
      : [];

  const byId = new Map<string, CandidateRow>();
  for (const r of [...textRows, ...vectorRows, ...idRows]) {
    if (byId.has(r.note.id)) continue;
    byId.set(r.note.id, { row: r.note, textRank: toNumberOrNull(r.textRank), similarity: toNumberOrNull(r.similarity) });
  }
  return [...byId.values()];
}

export async function findNotesByIds(db: Executor, ids: readonly string[]): Promise<NoteRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(notes).where(inArray(notes.id, [...ids]));
}

export async function findNoteById(db: Executor, id: string): Promise<NoteRow | null> {
  const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Reads a note and locks its row until the transaction ends. */
export async function lockNote(tx: Tx, id: string): Promise<NoteRow | null> {
  const rows = await tx.select().from(notes).where(eq(notes.id, id)).for('update');
  return rows[0] ?? null;
}

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Inserts a note (never the legacy image columns). Returns null when the id is already taken (the
 * caller retries with a new id). Images go to note_images through imageRepo.insertImage.
 */
export async function insertNote(db: Executor, values: InsertNote): Promise<NoteRow | null> {
  try {
    const rows = await db
      .insert(notes)
      .values({
        id: values.id,
        body: values.body,
        tags: values.tags,
        origin: values.origin,
        createdAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .onConflictDoNothing({ target: notes.id })
      .returning();
    return rows[0] ?? null;
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      throw new NoteError('duplicate_image', 'A live note already holds an image with the same sha256.');
    }
    throw err;
  }
}

export async function idExists(db: Executor, id: string): Promise<boolean> {
  const rows = await db.select({ id: notes.id }).from(notes).where(eq(notes.id, id)).limit(1);
  return rows.length > 0;
}

/** Replaces body and tags (and origin when given), bumping updated_at. */
export async function setBody(
  tx: Executor,
  id: string,
  body: string,
  tags: string[],
  origin: Origin | null | undefined,
): Promise<NoteRow> {
  const values: { body: string; tags: string[]; updatedAt: SQL; origin?: Origin | null } = {
    body,
    tags,
    updatedAt: sql`now()`,
  };
  if (origin !== undefined) values.origin = origin;
  const rows = await tx.update(notes).set(values).where(eq(notes.id, id)).returning();
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Note ${id} does not exist.`);
  return row;
}

export async function setOrigin(tx: Executor, id: string, origin: Origin | null): Promise<NoteRow> {
  const rows = await tx.update(notes).set({ origin, updatedAt: sql`now()` }).where(eq(notes.id, id)).returning();
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Note ${id} does not exist.`);
  return row;
}

export async function setDeleted(tx: Executor, id: string, deleted: boolean): Promise<NoteRow> {
  const rows = await tx
    .update(notes)
    .set({ deletedAt: deleted ? sql`now()` : null })
    .where(eq(notes.id, id))
    .returning();
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Note ${id} does not exist.`);
  return row;
}

export async function insertRevision(tx: Executor, noteId: string, body: string): Promise<void> {
  await tx.insert(noteRevisions).values({ noteId, body });
}

/** Newest first. */
export async function listRevisions(db: Executor, noteId: string): Promise<RevisionRow[]> {
  return db
    .select({ id: noteRevisions.id, noteId: noteRevisions.noteId, body: noteRevisions.body, savedAt: noteRevisions.savedAt })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, noteId))
    .orderBy(desc(noteRevisions.savedAt), desc(noteRevisions.id));
}

export async function getRevision(db: Executor, noteId: string, revisionId: number): Promise<RevisionRow | null> {
  const rows = await db
    .select({ id: noteRevisions.id, noteId: noteRevisions.noteId, body: noteRevisions.body, savedAt: noteRevisions.savedAt })
    .from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, noteId), eq(noteRevisions.id, revisionId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Every tag on a live note, most used first, with the newest updated_at among its notes. */
export async function listTags(db: Executor): Promise<TagRow[]> {
  const sub = db
    .select({ tag: sql<string>`unnest(${notes.tags})`.as('tag'), updatedAt: notes.updatedAt })
    .from(notes)
    .where(isNull(notes.deletedAt))
    .as('t');
  const rows = await db
    .select({
      tag: sub.tag,
      count: sql<number>`count(*)::int`,
      // Epoch milliseconds: driver-independent, unlike a raw timestamptz string.
      lastUsedMs: sql<number>`(extract(epoch from max(${sub.updatedAt})) * 1000)::float8`,
    })
    .from(sub)
    .groupBy(sub.tag)
    .orderBy(desc(sql`count(*)`), asc(sub.tag));
  return rows.map((r) => ({
    tag: r.tag,
    count: Number(r.count),
    lastUsed: new Date(Number(r.lastUsedMs)),
  }));
}
