// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ChatPage } from '../types';
import { makeMessage } from '../testing/chatFixtures';
import { useHistory } from './useHistory';

interface Frame {
  event: string;
  data: unknown;
}

const enc = new TextEncoder();
const sseText = (frames: Frame[]): string => frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

function handStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  return { body, send: (frames: Frame[]) => ctl.enqueue(enc.encode(sseText(frames))), end: () => ctl.close() };
}

class FakeES {
  static all: FakeES[] = [];
  private l = new Map<string, Array<(e?: unknown) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    for (const fn of this.l.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

let latest: ChatPage;
let older: Record<string, ChatPage>;
let calls: string[];
let posted: Array<Record<string, unknown>>;
let bodies: Array<string | ReadableStream<Uint8Array>>;

beforeEach(() => {
  latest = { messages: [], next_before: null };
  older = {};
  calls = [];
  posted = [];
  bodies = [];
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url.startsWith('/api/chat/messages')) {
        const before = new URL(url, 'http://x').searchParams.get('before');
        return json(before ? (older[before] ?? { messages: [], next_before: null }) : latest);
      }
      if (method === 'POST' && url === '/api/chat') {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(bodies.shift() ?? '', { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ids = (r: { current: ReturnType<typeof useHistory> }) => r.current.items.map((i) => i.msg.id || i.key);
const m = (id: string, min: number, over = {}) => makeMessage(id, { created_at: new Date(Date.UTC(2026, 9, 31, 1, min)).toISOString(), ...over });

describe('useHistory', () => {
  it('does nothing while disabled, loads when enabled', async () => {
    latest = { messages: [m('A001', 1)], next_before: null };
    const { result, rerender } = renderHook(({ on }) => useHistory(on), { initialProps: { on: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    rerender({ on: true });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(ids(result)).toEqual(['A001']);
  });

  it('shows the latest page ascending and pages older with the cursor', async () => {
    latest = { messages: [m('D004', 4), m('C003', 3)], next_before: 'c1' };
    older = { c1: { messages: [m('B002', 2), m('A001', 1)], next_before: null } };
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(calls).toContain('GET /api/chat/messages?limit=50');
    expect(ids(result)).toEqual(['C003', 'D004']);
    expect(result.current.hasMore).toBe(true);
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(calls).toContain('GET /api/chat/messages?before=c1&limit=50');
    expect(ids(result)).toEqual(['A001', 'B002', 'C003', 'D004']);
    expect(result.current.hasMore).toBe(false);
  });

  it('refreshes on event: chat without a second connection, and drops a deleted message', async () => {
    latest = { messages: [m('A001', 1)], next_before: null };
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    latest = { messages: [m('A001', 1), m('B002', 2, { source: 'claude_code', thread_id: 'T9' })], next_before: null };
    act(() => FakeES.all[0]?.emit('chat', { op: 'created', thread_id: 'T9', id: 'B002' }));
    await waitFor(() => expect(ids(result)).toEqual(['A001', 'B002']));
    latest = { messages: [m('A001', 1)], next_before: null };
    act(() => FakeES.all[0]?.emit('chat', { op: 'deleted', thread_id: 'T9', id: 'B002' }));
    expect(ids(result)).toEqual(['A001']);
    expect(FakeES.all).toHaveLength(1);
  });

  it('loadOlder resolves to the prepended page, [] at the start, and shares an in-flight load', async () => {
    latest = { messages: [m('C003', 3)], next_before: 'c1' };
    older = { c1: { messages: [m('A001', 1)], next_before: null } };
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let a: unknown;
    let b: unknown;
    await act(async () => {
      const p1 = result.current.loadOlder();
      const p2 = result.current.loadOlder();
      [a, b] = await Promise.all([p1, p2]);
    });
    expect((a as Array<{ id: string }>).map((x) => x.id)).toEqual(['A001']);
    expect(b).toEqual(a);
    expect(calls.filter((c) => c.includes('before=c1'))).toHaveLength(1);
    await act(async () => {
      expect(await result.current.loadOlder()).toEqual([]);
    });
  });

  it('mutate changes the server rows locally; includeDeleted fetches with include_deleted=1 and keeps deleted rows', async () => {
    latest = { messages: [m('A001', 1)], next_before: null };
    const { result } = renderHook(() => useHistory(true, { includeDeleted: true }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(calls).toContain('GET /api/chat/messages?limit=50&include_deleted=1');
    act(() => result.current.mutate((ms) => ms.map((x) => ({ ...x, text: 'edited' }))));
    expect(result.current.messages[0]?.text).toBe('edited');
    act(() => FakeES.all[0]?.emit('chat', { op: 'deleted', thread_id: 'T1', id: 'A001' }));
    expect(ids(result)).toEqual(['A001']);
  });

  it('send: optimistic question + streaming reply, continues the newest wall thread, then swaps in server rows', async () => {
    latest = { messages: [m('A001', 1, { thread_id: 'T1' }), m('A002', 2, { thread_id: 'T1', role: 'assistant' })], next_before: null };
    const s = handStream();
    bodies.push(s.body);
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let ok = false;
    act(() => {
      ok = result.current.send('  next one  ', []);
    });
    expect(ok).toBe(true);
    expect(result.current.sending).toBe(true);
    const tail = result.current.items.slice(-2);
    expect(tail.map((i) => [i.msg.role, i.msg.text, i.local?.streaming])).toEqual([
      ['user', 'next one', false],
      ['assistant', '', true],
    ]);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ message: 'next one', thread_id: 'T1' });

    s.send([
      { event: 'accepted', data: { thread_id: 'T1', user_message_id: 'U009' } },
      { event: 'status', data: { text: 'searching notes' } },
      { event: 'delta', data: { text: 'Hel' } },
      { event: 'delta', data: { text: 'lo' } },
    ]);
    await waitFor(() => expect(result.current.items.at(-1)?.msg.text).toBe('Hello'));
    expect(result.current.items.at(-1)?.local?.status).toBe('searching notes');

    latest = {
      messages: [...latest.messages, m('U009', 3, { thread_id: 'T1', text: 'next one' }), m('R009', 4, { thread_id: 'T1', role: 'assistant', text: 'Hello', brain: 'glm' })],
      next_before: null,
    };
    s.send([{ event: 'done', data: { thread_id: 'T1', user_message_id: 'U009', assistant_message_id: 'R009', reply_to: null, brain: 'glm' } }]);
    s.end();
    await waitFor(() => expect(ids(result)).toEqual(['A001', 'A002', 'U009', 'R009']));
    expect(result.current.items.every((i) => i.local === null)).toBe(true);
    expect(result.current.sending).toBe(false);
  });

  it('starts a new thread when the newest exchange came from Claude Code, and sends pasted image ids', async () => {
    latest = { messages: [m('A001', 1, { thread_id: 'T1' }), m('C001', 2, { thread_id: 'T9', source: 'claude_code' })], next_before: null };
    bodies.push(sseText([{ event: 'done', data: { thread_id: 'T2', user_message_id: 'U1', assistant_message_id: 'R1', reply_to: null, brain: 'claude' } }]));
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.send('look', ['U-AA1']);
    });
    expect(result.current.items.at(-2)?.msg.attachments).toEqual([
      { kind: 'chat_image', id: 'U-AA1', url: '/api/chat/images/U-AA1/display', thumb_url: '/api/chat/images/U-AA1/thumb' },
    ]);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ message: 'look', image_ids: ['U-AA1'] });
  });

  it('turns the reply into an error bubble on failure; refuses a second send while streaming', async () => {
    const s = handStream();
    bodies.push(s.body);
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.send('first', []);
    });
    let second = true;
    act(() => {
      second = result.current.send('second', []);
    });
    expect(second).toBe(false);
    expect(result.current.send('   ', [])).toBe(false);
    s.send([{ event: 'error', data: { error: 'boom' } }]);
    s.end();
    await waitFor(() => expect(result.current.sending).toBe(false));
    const [q, a] = result.current.items.slice(-2);
    expect(a?.local?.error).toBe('Chat failed: boom');
    expect(a?.local?.streaming).toBe(false);
    expect(q?.local?.error).toBe('not sent');
  });
});
