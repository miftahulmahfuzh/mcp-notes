// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { deleteChatMessage, editChatMessage, fetchChatMessages, restoreChatMessage, streamChat } from './chatHistoryApi';
import { makeMessage } from './testing/chatFixtures';

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function stub(status: number, body: unknown): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('chat message actions API (phase 7 wire)', () => {
  it('editChatMessage PATCHes {text} and returns the bare message', async () => {
    const msg = makeMessage('K7F2', { text: 'fixed', edited_at: '2026-10-31T02:00:00.000Z' });
    const seen = stub(200, msg);
    expect(await editChatMessage('K7F2', 'fixed')).toEqual(msg);
    expect(seen[0]).toEqual({ url: '/api/chat/messages/K7F2', method: 'PATCH', body: { text: 'fixed' } });
  });

  it('deleteChatMessage adds with_answer=1 only when asked and returns the deleted ids', async () => {
    const seen = stub(200, { deleted: ['K7F2', 'K7F3'] });
    expect(await deleteChatMessage('K7F2', false)).toEqual(['K7F2', 'K7F3']);
    await deleteChatMessage('K7F2', true);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'DELETE /api/chat/messages/K7F2',
      'DELETE /api/chat/messages/K7F2?with_answer=1',
    ]);
  });

  it('restoreChatMessage POSTs to /restore', async () => {
    const seen = stub(200, makeMessage('K7F2'));
    expect((await restoreChatMessage('K7F2')).id).toBe('K7F2');
    expect(`${seen[0].method} ${seen[0].url}`).toBe('POST /api/chat/messages/K7F2/restore');
  });

  it('fetchChatMessages sends include_deleted=1 when asked', async () => {
    const seen = stub(200, { messages: [], next_before: null });
    await fetchChatMessages({ includeDeleted: true });
    expect(seen[0].url).toContain('include_deleted=1');
  });

  it('streamChat sends reply_to only when replyTo is set', async () => {
    const seen = stub(200, {});
    const signal = new AbortController().signal;
    await streamChat({ message: 'more', threadId: 'T1', replyTo: 'A001', signal });
    await streamChat({ message: 'more', signal });
    expect(seen[0].body).toEqual({ message: 'more', thread_id: 'T1', reply_to: 'A001' });
    expect(seen[1].body).toEqual({ message: 'more' });
  });

  it('errors surface as ApiError with the server error code', async () => {
    stub(400, { error: 'not_editable' });
    await expect(editChatMessage('K7F2', 'x')).rejects.toEqual(new ApiError(400, 'not_editable'));
  });
});
