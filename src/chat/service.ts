import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { ChatMessageRow, ChatSource, ChatThreadRow } from '../db/schema.js';
import type { TurnContextInput } from './context.js';
import { ChatEvents } from './events.js';
import { generateMessageId, normalizeMessageId } from './ids.js';
import * as repo from './repo.js';
import {
  ChatError,
  toMessageView,
  toThreadView,
  type AttachmentRef,
  type ChatMessageView,
  type ChatThreadDetail,
  type ChatThreadView,
  type ChatTimelinePage,
} from './types.js';

export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 200;
const MAX_MESSAGE_ID_ATTEMPTS = 20;

export interface ChatServiceDeps {
  db: Db;
  /** Default: a fresh bus. */
  events?: ChatEvents;
  /** Default: `() => new Date()`. Every created_at / edited_at / deleted_at comes from here. */
  now?: () => Date;
  /** Index source for message ids. Default: crypto.randomInt. */
  random?: (max: number) => number;
}

export interface AddUserMessageInput {
  /** The thread to continue. Null, unknown, of another source or of another project: a new thread is created. */
  threadId: string | null;
  source: ChatSource;
  /** Trimmed by the caller. May be '' only when attachments are given. */
  text: string;
  attachments?: readonly AttachmentRef[];
  /** Canonical message id of a live message (any thread), or null. */
  replyTo?: string | null;
  /** Repo key from the Projects page (phase 12). Absent or null: wall chat. A thread never changes project. */
  project?: string | null;
  createdAt?: Date;
}

export interface UserTurnStart {
  thread: ChatThreadView;
  message: ChatMessageView;
  threadCreated: boolean;
}

export interface AddAssistantMessageInput {
  threadId: string;
  text: string;
  brain: string | null;
  /** Validated by the caller; a target that is gone by now is dropped silently. */
  replyTo?: string | null;
  createdAt?: Date;
}

/** One captured exchange (phase 8): one single-turn thread, idempotent on `externalKey`. */
export interface RecordExchangeInput {
  source: ChatSource;
  /** `<claude_session>:<user entry uuid>`. */
  externalKey: string;
  brain?: string | null;
  user: { text: string; createdAt: Date; attachments?: readonly AttachmentRef[] };
  assistant: { text: string; createdAt: Date } | null;
}

export interface RecordedExchange {
  /** False when the key was already recorded: nothing was written. */
  created: boolean;
  thread: ChatThreadView;
  /** The thread's message ids, ascending. */
  messageIds: string[];
}

export interface IncludeDeleted {
  includeDeleted?: boolean;
}

/**
 * The only writer of the chat tables (Invariant 3). Every write is one transaction that locks the
 * thread or message row first; ChatEvents fire after commit. Routes never touch rows directly.
 */
export class ChatService {
  readonly events: ChatEvents;
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly random: ((max: number) => number) | undefined;

  constructor(deps: ChatServiceDeps) {
    this.db = deps.db;
    this.events = deps.events ?? new ChatEvents();
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random;
  }

  /** Canonical message id or ChatError('invalid_id'). */
  requireMessageId(input: string): string {
    const id = normalizeMessageId(input);
    if (id === null) throw new ChatError('invalid_id', `"${input}" is not a chat message id. Ids look like K7F2.`);
    return id;
  }

  async createThread(input: {
    source: ChatSource;
    brain?: string | null;
    externalKey?: string | null;
    createdAt?: Date;
  }): Promise<ChatThreadView> {
    const row = await repo.insertThread(this.db, {
      id: randomUUID(),
      source: input.source,
      brain: input.brain ?? null,
      externalKey: input.externalKey ?? null,
      createdAt: input.createdAt ?? this.now(),
    });
    if (row === null) throw new ChatError('conflict', 'A thread with this id or external key already exists.');
    return toThreadView(row);
  }

  /** Writes the user row (and its attachments) before anything else happens to the turn. */
  async addUserMessage(input: AddUserMessageInput): Promise<UserTurnStart> {
    const attachments = input.attachments ?? [];
    if (input.text === '' && attachments.length === 0) {
      throw new ChatError('empty_text', 'A chat message needs text or an image.');
    }
    const at = input.createdAt ?? this.now();
    const replyTo = input.replyTo ?? null;
    const project = input.project ?? null;
    const result = await this.db.transaction(async (tx) => {
      let thread: ChatThreadRow | null = input.threadId === null ? null : await repo.lockThread(tx, input.threadId);
      if (thread !== null && (thread.source !== input.source || (thread.project ?? null) !== project)) thread = null;
      let threadCreated = false;
      if (thread === null) {
        thread = await repo.insertThread(tx, {
          id: randomUUID(),
          source: input.source,
          brain: null,
          externalKey: null,
          project,
          createdAt: at,
        });
        if (thread === null) throw new ChatError('conflict', 'Could not create a chat thread.');
        threadCreated = true;
      }
      if (replyTo !== null) {
        const target = await repo.findMessage(tx, replyTo);
        if (target === null || target.deletedAt !== null) {
          throw new ChatError('reply_not_found', `No live chat message ${replyTo} to reply to.`);
        }
      }
      const message = await this.insertWithFreshId(tx, {
        threadId: thread.id,
        role: 'user',
        text: input.text,
        source: input.source,
        brain: null,
        replyTo,
        createdAt: at,
      });
      await repo.insertAttachments(tx, message.id, attachments);
      await repo.touchThread(tx, thread.id, at);
      const touched = await repo.findThread(tx, thread.id);
      return { thread: touched ?? thread, message, threadCreated };
    });
    this.events.emit('created', result.thread.id, result.message.id);
    const [view] = await this.viewsFor([result.message]);
    return { thread: toThreadView(result.thread), message: view as ChatMessageView, threadCreated: result.threadCreated };
  }

  async addAssistantMessage(input: AddAssistantMessageInput): Promise<ChatMessageView> {
    const at = input.createdAt ?? this.now();
    const message = await this.db.transaction(async (tx) => {
      const thread = await repo.lockThread(tx, input.threadId);
      if (thread === null) throw new ChatError('thread_not_found', `No chat thread ${input.threadId}.`);
      let replyTo = input.replyTo ?? null;
      if (replyTo !== null) {
        const target = await repo.findMessage(tx, replyTo);
        if (target === null || target.deletedAt !== null) replyTo = null;
      }
      const row = await this.insertWithFreshId(tx, {
        threadId: thread.id,
        role: 'assistant',
        text: input.text,
        source: thread.source,
        brain: input.brain,
        replyTo,
        createdAt: at,
      });
      await repo.touchThread(tx, thread.id, at, input.brain);
      return row;
    });
    this.events.emit('created', message.threadId, message.id);
    const [view] = await this.viewsFor([message]);
    return view as ChatMessageView;
  }

  /** User messages only. The old text becomes a revision; the answer is not regenerated. */
  async editMessage(idInput: string, textInput: string): Promise<ChatMessageView> {
    const id = this.requireMessageId(idInput);
    const text = textInput.trim();
    if (text === '') throw new ChatError('empty_text', 'The new text is blank.');
    const at = this.now();
    const result = await this.db.transaction(async (tx) => {
      const row = await repo.lockMessage(tx, id);
      if (row === null || row.deletedAt !== null) throw new ChatError('not_found', `No live chat message ${id}.`);
      if (row.role !== 'user') throw new ChatError('not_editable', 'Only your own messages can be edited.');
      if (row.text === text) return { row, changed: false };
      await repo.insertMessageRevision(tx, row.id, row.text, at);
      return { row: await repo.setMessageText(tx, row.id, text, at), changed: true };
    });
    if (result.changed) this.events.emit('updated', result.row.threadId, result.row.id);
    const [view] = await this.viewsFor([result.row]);
    return view as ChatMessageView;
  }

  /**
   * Soft delete. With `withAnswer` on a user message, the assistant message that directly follows
   * it in its thread is deleted too. Returns the ids this call changed (already-deleted rows are
   * left alone and not listed).
   */
  async deleteMessage(idInput: string, options: { withAnswer?: boolean } = {}): Promise<{ deleted: string[] }> {
    const id = this.requireMessageId(idInput);
    const at = this.now();
    const changed = await this.db.transaction(async (tx) => {
      const row = await repo.lockMessage(tx, id);
      if (row === null) throw new ChatError('not_found', `No chat message ${id}.`);
      const out: ChatMessageRow[] = [];
      if (row.deletedAt === null) out.push(await repo.setMessageDeleted(tx, row.id, at));
      if (options.withAnswer === true && row.role === 'user') {
        const next = await repo.nextMessageInThread(tx, row);
        if (next !== null && next.role === 'assistant' && next.deletedAt === null) {
          out.push(await repo.setMessageDeleted(tx, next.id, at));
        }
      }
      return out;
    });
    for (const row of changed) this.events.emit('deleted', row.threadId, row.id);
    return { deleted: changed.map((row) => row.id) };
  }

  /** Undo a soft delete. Restoring a live message is a no-op that returns it. */
  async restoreMessage(idInput: string): Promise<ChatMessageView> {
    const id = this.requireMessageId(idInput);
    const result = await this.db.transaction(async (tx) => {
      const row = await repo.lockMessage(tx, id);
      if (row === null) throw new ChatError('not_found', `No chat message ${id}.`);
      if (row.deletedAt === null) return { row, changed: false };
      return { row: await repo.setMessageDeleted(tx, row.id, null), changed: true };
    });
    if (result.changed) this.events.emit('restored', result.row.threadId, result.row.id);
    const [view] = await this.viewsFor([result.row]);
    return view as ChatMessageView;
  }

  /**
   * One page of the unified timeline (every thread, every source), or of one project's threads when
   * `project` is given (phase 12). The page holds the newest `limit` messages older than `before`,
   * returned ascending; `next_before` fetches the page before it.
   */
  async listTimeline(
    options: { before?: string | null; limit?: number; includeDeleted?: boolean; project?: string | null } = {},
  ): Promise<ChatTimelinePage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_TIMELINE_LIMIT), 1), MAX_TIMELINE_LIMIT);
    let before: repo.TimelineCursor | null = null;
    if (options.before !== undefined && options.before !== null && options.before !== '') {
      before = repo.decodeTimelineCursor(options.before);
      if (before === null) throw new ChatError('invalid_cursor', 'Unknown timeline cursor.');
    }
    const rows = await repo.listTimelineRows(this.db, {
      before,
      limit: limit + 1,
      includeDeleted: options.includeDeleted ?? false,
      project: options.project ?? null,
    });
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    const next_before =
      rows.length > limit && oldest !== undefined
        ? repo.encodeTimelineCursor({ ts: oldest.cursorTs, seq: oldest.row.seq })
        : null;
    const messages = await this.viewsFor(page.map((entry) => entry.row).reverse());
    return { messages, next_before };
  }

  async getThread(id: string, options: IncludeDeleted = {}): Promise<ChatThreadDetail | null> {
    const thread = await repo.findThread(this.db, id);
    if (thread === null) return null;
    const rows = await repo.listThreadMessages(this.db, id, options.includeDeleted ?? false);
    return { thread: toThreadView(thread), messages: await this.viewsFor(rows) };
  }

  async getMessage(idInput: string, options: IncludeDeleted = {}): Promise<ChatMessageView | null> {
    const id = normalizeMessageId(idInput);
    if (id === null) return null;
    const row = await repo.findMessage(this.db, id);
    if (row === null || (row.deletedAt !== null && options.includeDeleted !== true)) return null;
    const [view] = await this.viewsFor([row]);
    return view ?? null;
  }

  /** Older texts of a message, newest first. */
  async listRevisions(idInput: string): Promise<Array<{ text: string; saved_at: string }>> {
    const id = this.requireMessageId(idInput);
    const rows = await repo.listMessageRevisions(this.db, id);
    return rows.map((row) => ({ text: row.text, saved_at: row.savedAt.toISOString() }));
  }

  async liveMessageExists(id: string): Promise<boolean> {
    const row = await repo.findMessage(this.db, id);
    return row !== null && row.deletedAt === null;
  }

  /**
   * The rows behind one wall turn: the thread's live messages before `currentMessageId` (edited
   * text, deleted ones left out), the current message, its live reply target from any thread, and
   * the thread's project (phase 12; null for wall chat).
   */
  async loadTurnContext(threadId: string, currentMessageId: string): Promise<TurnContextInput> {
    const thread = await repo.findThread(this.db, threadId);
    const rows = await repo.listThreadMessages(this.db, threadId, false);
    const index = rows.findIndex((row) => row.id === currentMessageId);
    const current = rows[index];
    if (index < 0 || current === undefined) {
      throw new ChatError('not_found', `Chat message ${currentMessageId} is not a live message of thread ${threadId}.`);
    }
    const before = rows.slice(0, index);
    const target = current.replyTo === null ? null : await repo.findMessage(this.db, current.replyTo);
    const liveTarget = target !== null && target.deletedAt === null ? target : null;
    const attachments = await repo.attachmentsFor(
      this.db,
      [...before, current, ...(liveTarget !== null ? [liveTarget] : [])].map((row) => row.id),
    );
    const toContext = (row: ChatMessageRow) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      createdAt: row.createdAt,
      attachments: attachments.get(row.id) ?? [],
    });
    return {
      history: before.map(toContext),
      current: toContext(current),
      replyTarget: liveTarget !== null ? toContext(liveTarget) : null,
      project: thread?.project ?? null,
    };
  }

  /**
   * Phase 8's capture: one single-turn thread per external key. A second call with the same key
   * (a replayed hook, a retry from the outbox, a race with another laptop) writes nothing and
   * returns the existing thread.
   */
  async recordExchange(input: RecordExchangeInput): Promise<RecordedExchange> {
    const key = input.externalKey.trim();
    if (key === '') throw new ChatError('invalid_id', 'externalKey is blank.');
    const attachments = input.user.attachments ?? [];
    if (input.user.text === '' && attachments.length === 0) {
      throw new ChatError('empty_text', 'A captured question needs text or an image.');
    }
    const brain = input.brain ?? null;
    const result = await this.db.transaction(async (tx) => {
      const existing = await repo.findThreadByExternalKey(tx, key);
      if (existing !== null) {
        return { created: false, thread: existing, messages: await repo.listThreadMessages(tx, existing.id, true) };
      }
      const inserted = await repo.insertThread(tx, {
        id: randomUUID(),
        source: input.source,
        brain,
        externalKey: key,
        createdAt: input.user.createdAt,
      });
      if (inserted === null) {
        // Another writer committed the same key between our read and our insert.
        const winner = await repo.findThreadByExternalKey(tx, key);
        if (winner === null) throw new ChatError('conflict', 'Could not record the exchange.');
        return { created: false, thread: winner, messages: await repo.listThreadMessages(tx, winner.id, true) };
      }
      const user = await this.insertWithFreshId(tx, {
        threadId: inserted.id,
        role: 'user',
        text: input.user.text,
        source: input.source,
        brain: null,
        replyTo: null,
        createdAt: input.user.createdAt,
      });
      await repo.insertAttachments(tx, user.id, attachments);
      const messages: ChatMessageRow[] = [user];
      if (input.assistant !== null) {
        const answer = await this.insertWithFreshId(tx, {
          threadId: inserted.id,
          role: 'assistant',
          text: input.assistant.text,
          source: input.source,
          brain,
          replyTo: null,
          createdAt: input.assistant.createdAt,
        });
        messages.push(answer);
        await repo.touchThread(tx, inserted.id, input.assistant.createdAt, brain);
      }
      const thread = (await repo.findThread(tx, inserted.id)) ?? inserted;
      return { created: true, thread, messages };
    });
    if (result.created) {
      for (const message of result.messages) this.events.emit('created', result.thread.id, message.id);
    }
    return {
      created: result.created,
      thread: toThreadView(result.thread),
      messageIds: result.messages.map((message) => message.id),
    };
  }

  private async insertWithFreshId(tx: repo.Tx, values: Omit<repo.InsertMessage, 'id'>): Promise<ChatMessageRow> {
    for (let attempt = 0; attempt < MAX_MESSAGE_ID_ATTEMPTS; attempt += 1) {
      const id = generateMessageId(this.random);
      const row = await repo.insertMessage(tx, { ...values, id });
      if (row !== null) return row;
    }
    throw new ChatError('conflict', 'Could not find a free chat message id.');
  }

  private async viewsFor(rows: readonly ChatMessageRow[]): Promise<ChatMessageView[]> {
    if (rows.length === 0) return [];
    const attachments = await repo.attachmentsFor(this.db, rows.map((row) => row.id));
    const replyIds = [...new Set(rows.map((row) => row.replyTo).filter((id): id is string => id !== null))];
    const targets = new Map((await repo.findMessagesByIds(this.db, replyIds)).map((row) => [row.id, row]));
    return rows.map((row) =>
      toMessageView(row, attachments.get(row.id) ?? [], row.replyTo === null ? null : (targets.get(row.replyTo) ?? null)),
    );
  }
}
