// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useChat } from './useChat';

interface Frame {
  event: string;
  data: unknown;
}
interface Posted {
  message: string;
  thread_id?: string;
  image_ids?: string[];
}

const enc = new TextEncoder();
const sse = (frames: Frame[]): string => frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
const sseHeaders = { 'content-type': 'text/event-stream' };

/** Stubs fetch with one queued body per POST /api/chat and records what each POST sent. */
function stubChat(...bodies: Array<string | ReadableStream<Uint8Array>>): Posted[] {
  const posted: Posted[] = [];
  const queue = [...bodies];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)) as Posted);
      return new Response(queue.shift() ?? '', { headers: sseHeaders });
    }),
  );
  return posted;
}

/** A response body the test writes frames into by hand. */
function handStream(): { body: ReadableStream<Uint8Array>; send: (frames: Frame[]) => void; end: () => void } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  return { body, send: (frames) => ctl.enqueue(enc.encode(sse(frames))), end: () => ctl.close() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useChat', () => {
  it('shows status captions while streaming, clears on "", and stores the brain on done', async () => {
    const s = handStream();
    stubChat(s.body);
    const { result } = renderHook(() => useChat());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('what did I note about seer?');
    });

    s.send([{ event: 'status', data: { text: 'searching notes' } }]);
    await waitFor(() => expect(result.current.status).toBe('searching notes'));
    expect(result.current.done).toBe(false);
    expect(result.current.brain).toBeNull();

    s.send([
      { event: 'status', data: { text: '' } },
      { event: 'delta', data: { text: 'Found it.' } },
    ]);
    await waitFor(() => expect(result.current.text).toBe('Found it.'));
    expect(result.current.status).toBe('');

    s.send([
      { event: 'status', data: { text: 'reading 3 notes' } },
      { event: 'done', data: { thread_id: 's-1', brain: 'glm' } },
    ]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.done).toBe(true);
    expect(result.current.status).toBe('');
    expect(result.current.brain).toBe('glm');
  });

  it('leaves brain null when done names none (the stub)', async () => {
    stubChat(sse([{ event: 'delta', data: { text: 'hi' } }, { event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('hi');
    });
    expect(result.current.done).toBe(true);
    expect(result.current.brain).toBeNull();
  });

  it('clears the status and shows no brain when the turn errors', async () => {
    stubChat(sse([{ event: 'status', data: { text: 'searching the web' } }, { event: 'error', data: { error: 'boom' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('news?');
    });
    expect(result.current.done).toBe(true);
    expect(result.current.status).toBe('');
    expect(result.current.brain).toBeNull();
    expect(result.current.text).toBe('Chat failed: boom');
  });

  it('continues the thread on a follow-up while the panel stays open', async () => {
    const posted = stubChat(
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
    );
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    await act(async () => {
      await result.current.ask('and compare it to last month');
    });
    expect(posted[0].thread_id).toBeUndefined();
    expect(posted[1].thread_id).toBe('t1');
  });

  it('a pinned panel keeps its thread', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]), sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    act(() => result.current.togglePin());
    expect(result.current.pinned).toBe(true);
    await act(async () => {
      await result.current.ask('second');
    });
    expect(posted[1].thread_id).toBe('t1');
  });

  it('dismissing the panel starts a new thread on the next message', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]), sse([{ event: 'done', data: { thread_id: 't2' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.brain).toBeNull();
    await act(async () => {
      await result.current.ask('unrelated');
    });
    expect(posted[1].thread_id).toBeUndefined();
  });

  it('a late done from a dismissed stream does not restore the old thread', async () => {
    const s = handStream();
    const posted = stubChat(s.body, sse([{ event: 'done', data: { thread_id: 't2' } }]));
    const { result } = renderHook(() => useChat());
    act(() => {
      void result.current.ask('first');
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    act(() => result.current.close());
    await act(async () => {
      await result.current.ask('second');
    });
    expect(posted[1].thread_id).toBeUndefined();
  });

  it('a new ask clears the previous brain and status', async () => {
    const s = handStream();
    stubChat(sse([{ event: 'done', data: { thread_id: 't1', brain: 'glm' } }]), s.body);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    expect(result.current.brain).toBe('glm');
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('second');
    });
    expect(result.current.brain).toBeNull();
    expect(result.current.status).toBe('');
    expect(result.current.done).toBe(false);
    s.send([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.brain).toBe('claude');
  });

  it('every new answer opens expanded, and dismissing resets the collapse', async () => {
    stubChat(
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
    );
    const { result } = renderHook(() => useChat());
    expect(result.current.collapsed).toBe(false);
    await act(async () => {
      await result.current.ask('first');
    });
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);
    await act(async () => {
      await result.current.ask('second');
    });
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.collapsed).toBe(false);
  });

  it('collapsing does not stop a streaming answer', async () => {
    const s = handStream();
    stubChat(s.body);
    const { result } = renderHook(() => useChat());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('line one\nline two');
    });
    expect(result.current.query).toBe('line one\nline two');
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);

    s.send([{ event: 'status', data: { text: 'searching notes' } }]);
    await waitFor(() => expect(result.current.status).toBe('searching notes'));
    s.send([{ event: 'delta', data: { text: 'Found it.' } }]);
    await waitFor(() => expect(result.current.text).toBe('Found it.'));
    s.send([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.collapsed).toBe(true);
    expect(result.current.done).toBe(true);
    expect(result.current.brain).toBe('claude');
  });

  it('sends a multi-line message with its inner newlines, trimming only the ends', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('  first line\nsecond line\n\n');
    });
    expect(posted[0].message).toBe('first line\nsecond line');
  });

  it('sends pasted image ids with the message and keeps them on the state', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('  what is this? ', ['U-PL1', 'V-QM2']);
    });
    expect(posted[0]).toEqual({ message: 'what is this?', image_ids: ['U-PL1', 'V-QM2'] });
    expect(result.current.images).toEqual(['U-PL1', 'V-QM2']);
    expect(result.current.query).toBe('what is this?');
  });

  it('sends an image-only message with empty text', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('   ', ['U-PL1']);
    });
    expect(posted[0]).toEqual({ message: '', image_ids: ['U-PL1'] });
    expect(result.current.open).toBe(true);
  });

  it('sends nothing without text or images, and a text-only message carries no image_ids', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('  ', []);
    });
    expect(posted).toHaveLength(0);
    await act(async () => {
      await result.current.ask('hello');
    });
    expect(posted[0]).toEqual({ message: 'hello' });
    expect(result.current.images).toEqual([]);
  });

  it('dismissing clears the images', async () => {
    stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('x', ['U-PL1']);
    });
    act(() => result.current.close());
    expect(result.current.images).toEqual([]);
  });

  it('exposes our thread id from accepted, keeps it on done, clears it on close', async () => {
    const s = handStream();
    stubChat(s.body);
    const { result } = renderHook(() => useChat());
    expect(result.current.threadId).toBeNull();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('hello');
    });
    s.send([{ event: 'accepted', data: { thread_id: 'T-7', user_message_id: 'U001' } }]);
    await waitFor(() => expect(result.current.threadId).toBe('T-7'));
    s.send([{ event: 'done', data: { thread_id: 'T-7', user_message_id: 'U001', assistant_message_id: 'A001', reply_to: null, brain: 'claude' } }]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.threadId).toBe('T-7');
    act(() => result.current.close());
    expect(result.current.threadId).toBeNull();
  });
});
