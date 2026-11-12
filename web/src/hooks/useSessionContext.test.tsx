// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SessionContext } from '../sessionDetailApi';
import { CONTEXT_POLL_MS, contextFeed, newerContext, useHandoffEstimate, useSessionContext } from './useSessionContext';

class FakeES {
  static all: FakeES[] = [];
  closed = false;
  private l = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emitRaw(type: string, data: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data });
  }
  emit(type: string, payload: unknown) {
    this.emitRaw(type, JSON.stringify(payload));
  }
}

const T0 = '2026-11-12T02:00:00.000Z';
const T1 = '2026-11-12T02:01:00.000Z';
const T2 = '2026-11-12T03:01:00.000Z';

const ctx = (tokens: number, at: string): SessionContext => ({
  tokens,
  window: 1_000_000,
  percent: tokens / 10_000,
  band: tokens >= 700_000 ? 'red' : tokens >= 400_000 ? 'amber' : 'green',
  model: 'claude-opus-5-5',
  at,
  window_source: 'model',
  peak_tokens: tokens,
});

const wire = (c: SessionContext | null, host = 'lenovo') => ({ node_id: 'A0-3G', host, available: host === 'lenovo', context: c });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const EST = { node_id: 'A0-3G', tokens: 120_000, window: 1_000_000, percent: 12, baseline: 48_000, exchanges_included: 40, exchanges_total: 40, truncated: false };

let calls: string[];
let contextReply: unknown;
let handoffReply: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  contextReply = wire(ctx(450_000, T1), 'GPD');
  handoffReply = { status: 200, body: EST };
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/handoff')) return json(handoffReply.status, handoffReply.body);
      return json(200, contextReply);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('contextFeed', () => {
  it('streams a live session of this host, polls another host, follows the detail otherwise', () => {
    expect(contextFeed(true, true)).toBe('stream');
    expect(contextFeed(false, true)).toBe('detail');
    expect(contextFeed(true, false)).toBe('poll');
    expect(contextFeed(false, false)).toBe('poll');
  });
});

describe('newerContext', () => {
  it('keeps the later reading and never goes back to null', () => {
    expect(newerContext(ctx(1, T1), ctx(2, T0))?.tokens).toBe(1);
    expect(newerContext(ctx(1, T0), ctx(2, T1))?.tokens).toBe(2);
    expect(newerContext(ctx(1, T0), null)?.tokens).toBe(1);
    expect(newerContext(null, ctx(2, T0))?.tokens).toBe(2);
  });
});

describe('useSessionContext', () => {
  it('opens one stream for a live session of this host and takes its context events', () => {
    const { result } = renderHook(() => useSessionContext({ nodeId: 'a0-3g', live: true, available: true, initial: ctx(100_000, T0) }));
    expect(FakeES.all.map((e) => e.url)).toEqual(['/api/sessions/A0-3G/context/stream']);
    expect(result.current?.tokens).toBe(100_000);
    act(() => FakeES.all[0].emit('context', wire(ctx(420_000, T1))));
    expect(result.current).toMatchObject({ tokens: 420_000, band: 'amber' });
    expect(calls).toEqual([]);
  });

  it('keeps a newer context over an older or malformed event', () => {
    const { result } = renderHook(() => useSessionContext({ nodeId: 'A0-3G', live: true, available: true, initial: ctx(420_000, T1) }));
    act(() => FakeES.all[0].emit('context', wire(ctx(100_000, T0))));
    act(() => FakeES.all[0].emitRaw('context', 'not json'));
    act(() => FakeES.all[0].emit('context', wire(null)));
    expect(result.current?.tokens).toBe(420_000);
  });

  it('closes the stream on node change and on unmount', () => {
    const { rerender, unmount } = renderHook((p: { nodeId: string }) => useSessionContext({ nodeId: p.nodeId, live: true, available: true, initial: null }), {
      initialProps: { nodeId: 'A0-3G' },
    });
    rerender({ nodeId: 'B1-11' });
    expect(FakeES.all.map((e) => [e.url, e.closed])).toEqual([
      ['/api/sessions/A0-3G/context/stream', true],
      ['/api/sessions/B1-11/context/stream', false],
    ]);
    unmount();
    expect(FakeES.all[1].closed).toBe(true);
  });

  it('closes the stream when the session stops being live', () => {
    const { rerender } = renderHook((p: { live: boolean }) => useSessionContext({ nodeId: 'A0-3G', live: p.live, available: true, initial: null }), {
      initialProps: { live: true },
    });
    rerender({ live: false });
    expect(FakeES.all.map((e) => e.closed)).toEqual([true]);
  });

  it('polls GET /context every 60 s for another host and opens no stream', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { result, unmount } = renderHook(() => useSessionContext({ nodeId: 'A0-3G', live: false, available: false, initial: ctx(100_000, T0) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toEqual(['/api/sessions/A0-3G/context']);
    expect(result.current?.tokens).toBe(450_000);

    contextReply = wire(ctx(720_000, T2), 'GPD');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS - 1);
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(calls).toHaveLength(2);
    expect(result.current).toMatchObject({ tokens: 720_000, band: 'red' });
    expect(FakeES.all).toEqual([]);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS * 3);
    });
    expect(calls).toHaveLength(2);
  });

  it('follows the detail for an idle session of this host: no stream, no fetch', () => {
    const { result, rerender } = renderHook<SessionContext | null, { initial: SessionContext | null }>(
      (p) => useSessionContext({ nodeId: 'A0-3G', live: false, available: true, initial: p.initial }),
      { initialProps: { initial: null } },
    );
    expect(result.current).toBeNull();
    rerender({ initial: ctx(300_000, T1) });
    expect(result.current?.tokens).toBe(300_000);
    expect(FakeES.all).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('useHandoffEstimate', () => {
  it('loads the estimate and reloads it when the refresh key changes', async () => {
    const { result, rerender } = renderHook((p: { k: string }) => useHandoffEstimate('A0-3G', p.k), { initialProps: { k: 'a' } });
    await waitFor(() => expect(result.current?.exchanges_total).toBe(40));
    rerender({ k: 'b' });
    await waitFor(() => expect(calls.filter((u) => u === '/api/sessions/A0-3G/handoff')).toHaveLength(2));
  });

  it('is null when the route fails', async () => {
    handoffReply = { status: 500, body: { error: 'boom' } };
    const { result } = renderHook(() => useHandoffEstimate('A0-3G', 'a'));
    await waitFor(() => expect(calls).toEqual(['/api/sessions/A0-3G/handoff']));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBeNull();
  });
});
