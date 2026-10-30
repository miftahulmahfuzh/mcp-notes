import { and, arrayContains, arrayOverlaps, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { noteRevisions, notes } from '../db/schema.js';
import { parseDateBound } from './dates.js';
import { NoteError, type ImageMeta, type NoteRow, type Origin } from './types.js';

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
  /** true = image notes only, false = text notes only, undefined = both. */
  hasImage?: boolean;
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
  imagePath: string | null;
  imageMeta: ImageMeta | null;
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

  if (filter.hasImage === true) conds.push(isNotNull(notes.imagePath));
  if (filter.hasImage === false) conds.push(isNull(notes.imagePath));
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

/** Live notes first, then the most recently changed deleted one. */
export async function findNoteBySha256(db: Executor, sha256: string, includeDeleted: boolean): Promise<NoteRow | null> {
  const conds: SQL[] = [sql`${notes.imageMeta}->>'sha256' = ${sha256}`];
  if (!includeDeleted) conds.push(isNull(notes.deletedAt));
  const rows = await db
    .select()
    .from(notes)
    .where(and(...conds))
    .orderBy(sql`${notes.deletedAt} is not null`, desc(notes.updatedAt))
    .limit(1);
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
 * Inserts a note. Returns null when the id is already taken (the caller retries with a new id).
 * A clash on the live-image sha256 unique index throws NoteError('duplicate_image').
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
        imagePath: values.imagePath,
        imageMeta: values.imageMeta,
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
