import { randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatChange } from '../../src/chat/events.js';
import { ChatService } from '../../src/chat/service.js';
import { ID_ALPHABET } from '../../src/notes/ids.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const db = openTestDb();

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
});

/** A clock that advances one second per call, from 2026-10-31T00:00:00Z. */
function steppingClock(startIso = '2026-10-31T00:00:00Z'): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

/** Message ids come out of this queue first, then at random. */
function scriptedRandom(ids: string[]): (max: number) => number {
  const queue = ids.join('').split('').map((ch) => ID_ALPHABET.indexOf(ch));
  return (max) => queue.shift() ?? randomInt(max);
}

async function exchange(chat: ChatService, threadId: string | null, question: string, answer: string) {
  const start = await chat.addUserMessage({ threadId, source: 'wall', text: question });
  const reply = await chat.addAssistantMessage({ threadId: start.thread.id, text: answer, brain: 'claude' });
  return { threadId: start.thread.id, userId: start.message.id, answerId: reply.id, threadCreated: start.threadCreated };
}

describe('ChatService: threads and messages', () => {
  it('creates a wall thread on the first message and continues it after', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const first = await exchange(chat, null, 'what did I save?', 'You saved A-B32.');
    expect(first.threadCreated).toBe(true);
    const second = await exchange(chat, first.threadId, 'and last month?', 'Nothing.');
    expect(second.threadCreated).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    const thread = await chat.getThread(first.threadId);
    expect(thread?.thread).toMatchObject({ source: 'wall', brain: 'claude' });
    expect(thread?.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'what did I save?'],
      ['assistant', 'You saved A-B32.'],
      ['user', 'and last month?'],
      ['assistant', 'Nothing.'],
    ]);
    expect(thread?.messages[0]?.created_at).toBe('2026-10-31T00:00:00.000Z');
    expect(thread?.thread.updated_at).toBe('2026-10-31T00:00:03.000Z');
  });

  it('starts a new thread for an unknown id and for a thread of another source', async () => {
    const chat = new ChatService({ db });
    const unknown = await chat.addUserMessage({ threadId: 'sess-from-the-sdk', source: 'wall', text: 'hi' });
    expect(unknown.threadCreated).toBe(true);
    expect(unknown.thread.id).not.toBe('sess-from-the-sdk');
    const captured = await chat.createThread({ source: 'claude_code' });
    const wall = await chat.addUserMessage({ threadId: captured.id, source: 'wall', text: 'hi' });
    expect(wall.threadCreated).toBe(true);
    expect(wall.thread.id).not.toBe(captured.id);
  });

  it('retries a message id that is already taken', async () => {
    const chat = new ChatService({ db, random: scriptedRandom(['AAAA', 'AAAA', 'BBBB']) });
    const one = await chat.addUserMessage({ threadId: null, source: 'wall', text: 'one' });
    const two = await chat.addUserMessage({ threadId: one.thread.id, source: 'wall', text: 'two' });
    expect(one.message.id).toBe('AAAA');
    expect(two.message.id).toBe('BBBB');
  });

  it('refuses a reply to a missing or deleted message and writes nothing', async () => {
    const chat = new ChatService({ db });
    const a = await exchange(chat, null, 'q', 'a');
    await chat.deleteMessage(a.answerId);
    await expect(chat.addUserMessage({ threadId: null, source: 'wall', text: 'x', replyTo: 'ZZZZ' })).rejects.toMatchObject({ code: 'reply_not_found' });
    await expect(chat.addUserMessage({ threadId: null, source: 'wall', text: 'x', replyTo: a.answerId })).rejects.toMatchObject({ code: 'reply_not_found' });
    const page = await chat.listTimeline({ includeDeleted: true });
    expect(page.messages).toHaveLength(2);
  });

  it('records attachments in order and shows them with urls', async () => {
    const chat = new ChatService({ db });
    const start = await chat.addUserMessage({
      threadId: null,
      source: 'wall',
      text: '',
      attachments: [
        { kind: 'chat_image', id: 'C-AB12' },
        { kind: 'note_image', id: 'A-B32' },
        { kind: 'note_file', id: 'F-1LE' },
      ],
    });
    expect(start.message.attachments).toEqual([
      { kind: 'chat_image', id: 'C-AB12', url: '/api/chat/images/C-AB12/display', thumb_url: '/api/chat/images/C-AB12/thumb' },
      { kind: 'note_image', id: 'A-B32', url: '/api/images/A-B32/display', thumb_url: '/api/images/A-B32/thumb' },
      { kind: 'note_file', id: 'F-1LE', url: '/api/files/F-1LE/download', thumb_url: null },
    ]);
    await expect(chat.addUserMessage({ threadId: null, source: 'wall', text: '' })).rejects.toMatchObject({ code: 'empty_text' });
  });

  it('emits created events after commit', async () => {
    const chat = new ChatService({ db });
    const seen: ChatChange[] = [];
    const off = chat.events.on((c) => seen.push(c));
    const ex = await exchange(chat, null, 'q', 'a');
    off();
    expect(seen).toEqual([
      { type: 'chat', op: 'created', thread_id: ex.threadId, id: ex.userId },
      { type: 'chat', op: 'created', thread_id: ex.threadId, id: ex.answerId },
    ]);
  });
});

describe('ChatService: edit, delete, restore', () => {
  it('edits user messages only, keeps the old text as a revision, and is a no-op for the same text', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const ex = await exchange(chat, null, 'what did I sav?', 'You saved A-B32.');
    const edited = await chat.editMessage(ex.userId.toLowerCase(), '  what did I save?  ');
    expect(edited.text).toBe('what did I save?');
    expect(edited.edited_at).not.toBeNull();
    expect((await chat.listRevisions(ex.userId)).map((r) => r.text)).toEqual(['what did I sav?']);
    await chat.editMessage(ex.userId, 'what did I save?');
    expect(await chat.listRevisions(ex.userId)).toHaveLength(1);
    await expect(chat.editMessage(ex.answerId, 'nope')).rejects.toMatchObject({ code: 'not_editable' });
    await expect(chat.editMessage(ex.userId, '   ')).rejects.toMatchObject({ code: 'empty_text' });
    await expect(chat.editMessage('A-B32', 'x')).rejects.toMatchObject({ code: 'invalid_id' });
    await chat.deleteMessage(ex.userId);
    await expect(chat.editMessage(ex.userId, 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deletes a question with its answer, leaves an unanswered question alone, and restores', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const ex = await exchange(chat, null, 'q1', 'a1');
    const lone = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'q2 (no answer)' });
    const later = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'q3' });

    expect(await chat.deleteMessage(ex.userId, { withAnswer: true })).toEqual({ deleted: [ex.userId, ex.answerId] });
    expect(await chat.deleteMessage(lone.message.id, { withAnswer: true })).toEqual({ deleted: [lone.message.id] });
    expect(await chat.deleteMessage(lone.message.id)).toEqual({ deleted: [] });

    const live = await chat.getThread(ex.threadId);
    expect(live?.messages.map((m) => m.id)).toEqual([later.message.id]);
    const all = await chat.getThread(ex.threadId, { includeDeleted: true });
    expect(all?.messages.filter((m) => m.deleted_at !== null).map((m) => m.id)).toEqual([ex.userId, ex.answerId, lone.message.id]);

    const restored = await chat.restoreMessage(ex.answerId);
    expect(restored.deleted_at).toBeNull();
    expect((await chat.restoreMessage(ex.answerId)).id).toBe(ex.answerId);
    await expect(chat.deleteMessage('ZZZZ')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('builds turn context from live rows with edited text, and the live reply target from another thread', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const other = await exchange(chat, null, 'red top photo?', 'That one is red.');
    const ex = await exchange(chat, null, 'typo qestion', 'answer one');
    await chat.editMessage(ex.userId, 'fixed question');
    const gone = await exchange(chat, ex.threadId, 'deleted q', 'deleted a');
    await chat.deleteMessage(gone.userId, { withAnswer: true });
    const now = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'now', replyTo: other.answerId });

    const ctx = await chat.loadTurnContext(ex.threadId, now.message.id);
    expect(ctx.history.map((m) => m.text)).toEqual(['fixed question', 'answer one']);
    expect(ctx.current.id).toBe(now.message.id);
    expect(ctx.replyTarget?.id).toBe(other.answerId);
    expect(now.message.reply_to).toEqual({ id: other.answerId, role: 'assistant', text: 'That one is red.', deleted: false });

    await chat.deleteMessage(other.answerId);
    expect((await chat.loadTurnContext(ex.threadId, now.message.id)).replyTarget).toBeNull();
    expect((await chat.getMessage(now.message.id))?.reply_to).toEqual({ id: other.answerId, role: 'assistant', text: '', deleted: true });
  });

  it('a new service on the same database sees the same conversation (restart)', async () => {
    const before = new ChatService({ db });
    const ex = await exchange(before, null, 'remember kestrel', 'Noted.');
    const after = new ChatService({ db });
    const next = await after.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'what word?' });
    expect(next.threadCreated).toBe(false);
    const ctx = await after.loadTurnContext(ex.threadId, next.message.id);
    expect(ctx.history.map((m) => m.text)).toEqual(['remember kestrel', 'Noted.']);
  });
});

describe('ChatService: timeline', () => {
  it('pages newest-first, returns each page ascending, across threads, and hides deleted rows by default', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const ex = await exchange(chat, null, `q${i}`, `a${i}`);
      ids.push(ex.userId, ex.answerId);
    }
    const p1 = await chat.listTimeline({ limit: 4 });
    expect(p1.messages.map((m) => m.id)).toEqual(ids.slice(6, 10));
    expect(p1.next_before).not.toBeNull();
    const p2 = await chat.listTimeline({ limit: 4, before: p1.next_before });
    expect(p2.messages.map((m) => m.id)).toEqual(ids.slice(2, 6));
    const p3 = await chat.listTimeline({ limit: 4, before: p2.next_before });
    expect(p3.messages.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(p3.next_before).toBeNull();

    await chat.deleteMessage(ids[9]!);
    expect((await chat.listTimeline({ limit: 2 })).messages.map((m) => m.id)).toEqual([ids[7], ids[8]]);
    expect((await chat.listTimeline({ limit: 2, includeDeleted: true })).messages.map((m) => m.id)).toEqual([ids[8], ids[9]]);
  });

  it('orders by created_at then seq, so equal timestamps keep insert order', async () => {
    const fixed = new Date('2026-10-31T00:00:00Z');
    const chat = new ChatService({ db, now: () => fixed });
    const ex = await exchange(chat, null, 'same', 'time');
    const extra = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'third' });
    const p1 = await chat.listTimeline({ limit: 2 });
    expect(p1.messages.map((m) => m.id)).toEqual([ex.answerId, extra.message.id]);
    const p2 = await chat.listTimeline({ limit: 2, before: p1.next_before });
    expect(p2.messages.map((m) => m.id)).toEqual([ex.userId]);
  });

  it('rejects a cursor it did not issue', async () => {
    const chat = new ChatService({ db });
    await expect(chat.listTimeline({ before: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
});

describe('ChatService.recordExchange (phase 8 capture)', () => {
  const input = {
    source: 'claude_code' as const,
    externalKey: 'sess-1:entry-1',
    brain: 'claude',
    user: { text: '/n find red tops', createdAt: new Date('2026-10-30T10:00:00Z'), attachments: [{ kind: 'chat_image' as const, id: 'C-AB12' }] },
    assistant: { text: 'Found A-B32.', createdAt: new Date('2026-10-30T10:00:20Z') },
  };

  it('writes one single-turn thread and is a no-op on replay', async () => {
    const chat = new ChatService({ db });
    const first = await chat.recordExchange(input);
    expect(first.created).toBe(true);
    expect(first.thread.source).toBe('claude_code');
    expect(first.messageIds).toHaveLength(2);
    const again = await chat.recordExchange(input);
    expect(again).toEqual({ ...first, created: false });
    const thread = await chat.getThread(first.thread.id);
    expect(thread?.messages.map((m) => [m.role, m.source, m.created_at])).toEqual([
      ['user', 'claude_code', '2026-10-30T10:00:00.000Z'],
      ['assistant', 'claude_code', '2026-10-30T10:00:20.000Z'],
    ]);
    expect(thread?.messages[0]?.attachments.map((a) => a.id)).toEqual(['C-AB12']);
  });

  it('survives two concurrent captures of the same exchange', async () => {
    const a = new ChatService({ db });
    const b = new ChatService({ db });
    const [x, y] = await Promise.all([a.recordExchange(input), b.recordExchange(input)]);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(x.thread.id).toBe(y.thread.id);
    const count = await db.execute(sql`select count(*)::int as n from chat_threads where external_key = ${input.externalKey}`);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });
});

describe('chat tables: foreign keys', () => {
  it('cascades a thread to its messages and nulls reply_to when a target row is removed for good', async () => {
    const chat = new ChatService({ db });
    const a = await exchange(chat, null, 'q', 'a');
    const b = await chat.addUserMessage({ threadId: null, source: 'wall', text: 'reply', replyTo: a.answerId });
    await db.execute(sql`delete from chat_threads where id = ${a.threadId}`);
    expect(await chat.getMessage(a.userId, { includeDeleted: true })).toBeNull();
    const after = await chat.getMessage(b.message.id);
    expect(after?.reply_to).toBeNull();
  });
});
