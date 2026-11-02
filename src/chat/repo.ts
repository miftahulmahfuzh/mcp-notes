import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  chatMessageAttachments,
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  type ChatMessageRevisionRow,
  type ChatMessageRow,
  type ChatRole,
  type ChatSource,
  type ChatThreadRow,
} from '../db/schema.js';
import type { AttachmentRef } from './types.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/** Timeline position: the row's exact created_at (microseconds, UTC text) and its seq. */
export interface TimelineCursor {
  ts: string;
  seq: number;
}

/**
 * Exact text of created_at. A JS Date keeps milliseconds only, so a cursor built from one could
 * skip rows written within the same millisecond; the text form round-trips exactly.
 */
const CURSOR_TS_SQL = sql<string>`to_char(${chatMessages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_TEXT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(\d{1,18})$/;

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(`${cursor.ts}|${cursor.seq}`, 'utf8').toString('base64url');
}

/** Null for anything encodeTimelineCursor did not produce. */
export function decodeTimelineCursor(raw: string): TimelineCursor | null {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const m = CURSOR_TEXT.exec(decoded);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq) || Number.isNaN(Date.parse(m[1]))) return null;
  return { ts: m[1], seq };
}

// ---------- threads ----------

export interface InsertThread {
  id: string;
  source: ChatSource;
  brain: string | null;
  externalKey: string | null;
  /** Repo key of a project-scoped thread (phase 12). Absent or null: not a project thread. */
  project?: string | null;
  createdAt: Date;
}

/** Null when the id or the external key is already taken. */
export async function insertThread(ex: Executor, values: InsertThread): Promise<ChatThreadRow | null> {
  const rows = await ex
    .insert(chatThreads)
    .values({
      id: values.id,
      source: values.source,
      brain: values.brain,
      externalKey: values.externalKey,
      project: values.project ?? null,
      createdAt: values.createdAt,
      updatedAt: values.createdAt,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function findThread(ex: Executor, id: string): Promise<ChatThreadRow | null> {
  const rows = await ex.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function lockThread(tx: Tx, id: string): Promise<ChatThreadRow | null> {
  const rows = await tx.select().from(chatThreads).where(eq(chatThreads.id, id)).for('update');
  return rows[0] ?? null;
}

export async function findThreadByExternalKey(ex: Executor, key: string): Promise<ChatThreadRow | null> {
  const rows = await ex.select().from(chatThreads).where(eq(chatThreads.externalKey, key)).limit(1);
  return rows[0] ?? null;
}

/** updated_at = greatest(updated_at, at); brain replaced when given. */
export async function touchThread(ex: Executor, id: string, at: Date, brain: string | null = null): Promise<void> {
  await ex
    .update(chatThreads)
    .set({
      updatedAt: sql`greatest(${chatThreads.updatedAt}, ${at.toISOString()}::timestamptz)`,
      ...(brain !== null ? { brain } : {}),
    })
    .where(eq(chatThreads.id, id));
}

// ---------- messages ----------

export interface InsertMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  text: string;
  source: ChatSource;
  brain: string | null;
  replyTo: string | null;
  createdAt: Date;
}

/** Null when the id is taken (the caller retries with a fresh id). */
export async function insertMessage(ex: Executor, values: InsertMessage): Promise<ChatMessageRow | null> {
  const rows = await ex
    .insert(chatMessages)
    .values(values)
    .onConflictDoNothing({ target: chatMessages.id })
    .returning();
  return rows[0] ?? null;
}

export async function findMessage(ex: Executor, id: string): Promise<ChatMessageRow | null> {
  const rows = await ex.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function lockMessage(tx: Tx, id: string): Promise<ChatMessageRow | null> {
  const rows = await tx.select().from(chatMessages).where(eq(chatMessages.id, id)).for('update');
  return rows[0] ?? null;
}

export async function findMessagesByIds(ex: Executor, ids: readonly string[]): Promise<ChatMessageRow[]> {
  if (ids.length === 0) return [];
  return ex.select().from(chatMessages).where(inArray(chatMessages.id, [...ids]));
}

/** The message right after `row` in its thread (any state), or null. */
export async function nextMessageInThread(tx: Tx, row: ChatMessageRow): Promise<ChatMessageRow | null> {
  const rows = await tx
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, row.threadId),
        sql`(${chatMessages.createdAt}, ${chatMessages.seq}) > (select m.created_at, m.seq from chat_messages m where m.id = ${row.id})`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.seq))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/** A thread's messages, ascending (created_at, seq). */
export async function listThreadMessages(
  ex: Executor,
  threadId: string,
  includeDeleted: boolean,
): Promise<ChatMessageRow[]> {
  const conds: SQL[] = [eq(chatMessages.threadId, threadId)];
  if (!includeDeleted) conds.push(isNull(chatMessages.deletedAt));
  return ex
    .select()
    .from(chatMessages)
    .where(and(...conds))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.seq));
}

export interface TimelineRow {
  row: ChatMessageRow;
  cursorTs: string;
}

/** Newest first, strictly older than `before` when given; only threads of `project` when given (phase 12). */
export async function listTimelineRows(
  ex: Executor,
  options: { before: TimelineCursor | null; limit: number; includeDeleted: boolean; project?: string | null },
): Promise<TimelineRow[]> {
  const conds: SQL[] = [];
  if (!options.includeDeleted) conds.push(isNull(chatMessages.deletedAt));
  if (options.project !== undefined && options.project !== null) {
    conds.push(
      sql`${chatMessages.threadId} in (select ${chatThreads.id} from ${chatThreads} where ${chatThreads.project} = ${options.project})`,
    );
  }
  if (options.before !== null) {
    conds.push(
      sql`(${chatMessages.createdAt}, ${chatMessages.seq}) < (${options.before.ts}::timestamptz, ${options.before.seq}::bigint)`,
    );
  }
  const rows = await ex
    .select({ ...getTableColumns(chatMessages), cursorTs: CURSOR_TS_SQL })
    .from(chatMessages)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.seq))
    .limit(options.limit);
  return rows.map(({ cursorTs, ...row }) => ({ row, cursorTs }));
}

export async function setMessageText(tx: Tx, id: string, text: string, at: Date): Promise<ChatMessageRow> {
  const rows = await tx.update(chatMessages).set({ text, editedAt: at }).where(eq(chatMessages.id, id)).returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`chat message ${id} vanished inside its own transaction`);
  return row;
}

export async function setMessageDeleted(tx: Tx, id: string, at: Date | null): Promise<ChatMessageRow> {
  const rows = await tx.update(chatMessages).set({ deletedAt: at }).where(eq(chatMessages.id, id)).returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`chat message ${id} vanished inside its own transaction`);
  return row;
}

// ---------- revisions ----------

export async function insertMessageRevision(tx: Tx, messageId: string, text: string, at: Date): Promise<void> {
  await tx.insert(chatMessageRevisions).values({ messageId, text, savedAt: at });
}

/** Newest first. */
export async function listMessageRevisions(ex: Executor, messageId: string): Promise<ChatMessageRevisionRow[]> {
  return ex
    .select()
    .from(chatMessageRevisions)
    .where(eq(chatMessageRevisions.messageId, messageId))
    .orderBy(desc(chatMessageRevisions.savedAt), desc(chatMessageRevisions.id));
}

// ---------- attachments ----------

export async function insertAttachments(ex: Executor, messageId: string, refs: readonly AttachmentRef[]): Promise<void> {
  if (refs.length === 0) return;
  await ex
    .insert(chatMessageAttachments)
    .values(refs.map((ref, position) => ({ messageId, position, kind: ref.kind, refId: ref.id })));
}

/** message id -> its attachments in position order. Messages without any are absent. */
export async function attachmentsFor(ex: Executor, messageIds: readonly string[]): Promise<Map<string, AttachmentRef[]>> {
  const out = new Map<string, AttachmentRef[]>();
  if (messageIds.length === 0) return out;
  const rows = await ex
    .select()
    .from(chatMessageAttachments)
    .where(inArray(chatMessageAttachments.messageId, [...messageIds]))
    .orderBy(asc(chatMessageAttachments.messageId), asc(chatMessageAttachments.position));
  for (const row of rows) {
    const list = out.get(row.messageId) ?? [];
    list.push({ kind: row.kind, id: row.refId });
    out.set(row.messageId, list);
  }
  return out;
}
