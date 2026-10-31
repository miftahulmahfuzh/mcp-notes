// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useHistory } from './useHistory';
import { makeMessage } from '../testing/chatFixtures';

const W_Q = makeMessage('W001', { thread_id: 'TW01', source: 'wall', created_at: '2026-10-31T01:00:00.000Z' });
const W_A = makeMessage('W002', { role: 'assistant', thread_id: 'TW01', source: 'wall', created_at: '2026-10-31T01:01:00.000Z' });
const C_Q = makeMessage('C001', { thread_id: 'TC01', source: 'claude_code', created_at: '2026-10-31T01:02:00.000Z' });
const C_A = makeMessage('C002', { role: 'assistant', thread_id: 'TC01', source: 'claude_code', created_at: '2026-10-31T01:03:00.000Z' });

let gets: string[];
let posts: Array<Record<string, unknown>>;

class FakeES {
  constructor(public url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const sse = (frames: Array<{ event: string; data: unknown }>) =>
  frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');

beforeEach(() => {
  gets = [];
  posts = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        gets.push(url);
        return new Response(JSON.stringify({ messages: [W_Q, W_A, C_Q, C_A], next_before: null }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = sse([
        { event: 'accepted', data: { thread_id: 'TNEW', user_message_id: 'N001' } },
        { event: 'done', data: { thread_id: 'TNEW', user_message_id: 'N001', assistant_message_id: 'N002', reply_to: null, brain: 'claude' } },
      ]);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => renderHook(() => useHistory(true, { includeDeleted: true }));

describe('useHistory (phase 10 contract)', () => {
  it('fetches with include_deleted=1 and loadOlder resolves [] when nothing older remains', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.every((u) => u.includes('include_deleted=1'))).toBe(true);
    let page: unknown;
    await act(async () => {
      page = await result.current.loadOlder();
    });
    expect(page).toEqual([]);
  });

  it('a reply to a wall bubble continues its thread and carries reply_to', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    act(() => {
      expect(result.current.send('more on that', [], W_A)).toBe(true);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ message: 'more on that', thread_id: 'TW01', reply_to: 'W002' });
  });

  it('a reply to a claude_code bubble starts a new thread (no thread_id) with reply_to', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    act(() => {
      result.current.send('follow up', [], C_A);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].reply_to).toBe('C002');
    expect(posts[0]).not.toHaveProperty('thread_id');
  });

  it('without a reply target P9 rule applies and no reply_to is sent', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    act(() => {
      result.current.send('new question', []);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    // Newest live message is a claude_code answer: a new thread (P9 threadForSend).
    expect(posts[0]).not.toHaveProperty('thread_id');
    expect(posts[0]).not.toHaveProperty('reply_to');
  });
});
