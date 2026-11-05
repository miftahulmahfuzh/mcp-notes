// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { METHOD_BOOK, OVERVIEW, TOGGLE_ON } from '../testing/adversaryFixtures';
import { useAdversary } from './useAdversary';

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
  emit(type: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data: '{}' });
  }
}

let calls: string[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/adversary/overview') return json(OVERVIEW);
      if (url === '/api/adversary/toggle') return method === 'PUT' ? json({ ...TOGGLE_ON, ...(JSON.parse(String(init?.body)) as object) }) : json(TOGGLE_ON);
      if (url === '/api/adversary/methods/RAW35-FR-GT') return json(METHOD_BOOK);
      if (url === '/api/adversary/methods/GONE') return json({ error: 'not_found' }, 404);
      return json({ error: 'seer_unavailable' }, 503);
    }),
  );
});

afterEach(() => {
  // Unmount first: lib/events keeps one shared EventSource per page, and a leftover hook would keep a stale one open.
  cleanup();
  FakeES.all = [];
  vi.unstubAllGlobals();
});

describe('useAdversary', () => {
  it('fetches nothing while disabled', async () => {
    renderHook(() => useAdversary(false, null));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });

  it('loads the overview, the toggle and the method', async () => {
    const { result } = renderHook(() => useAdversary(true, 'RAW35-FR-GT'));
    await waitFor(() => expect(result.current.method?.method.strategy_id).toBe('RAW35-FR-GT'));
    expect(result.current.overview?.methods).toHaveLength(3);
    expect(result.current.toggle?.on).toBe(true);
  });

  it('reports an unknown method by its code', async () => {
    const { result } = renderHook(() => useAdversary(true, 'GONE'));
    await waitFor(() => expect(result.current.methodError).toBe('not_found'));
  });

  it('refetches on the SSE adversary event', async () => {
    renderHook(() => useAdversary(true, null));
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/adversary/overview')).toHaveLength(1));
    act(() => FakeES.all[0]?.emit('adversary'));
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/adversary/overview')).toHaveLength(2));
  });

  it('PUTs the toggle and keeps the server answer', async () => {
    const { result } = renderHook(() => useAdversary(true, null));
    await waitFor(() => expect(result.current.toggle?.on).toBe(true));
    let ok = false;
    await act(async () => {
      ok = await result.current.setAuto(false);
    });
    expect(ok).toBe(true);
    expect(calls).toContain('PUT /api/adversary/toggle');
    expect(result.current.toggle?.on).toBe(false);
  });
});
