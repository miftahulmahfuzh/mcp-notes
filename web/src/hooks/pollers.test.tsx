// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { GRAPH_POLL_MAX_MS, GRAPH_POLL_MS, useSessionGraph } from './useSessionGraph';
import { PROJECTS_POLL_MS, useProjects } from './useProjects';
import { NOTES_POLL_MS, useNotes } from './useNotes';

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

let visibility: 'visible' | 'hidden';
let urls: string[];
const count = (prefix: string) => urls.filter((u) => u.startsWith(prefix)).length;
const setVisibility = (v: 'visible' | 'hidden') => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};
const json = (v: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', ...extra } });

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  urls = [];
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('/api/projects/')) return json({ nodes: [] }, { etag: '"g1"' });
      if (url.startsWith('/api/projects')) return json({ projects: [] });
      if (url.startsWith('/api/tags')) return json({ tags: [] });
      if (url.startsWith('/api/notes')) return json({ notes: [] });
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  FakeES.all = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('hidden tabs make no poll requests', () => {
  it('useSessionGraph: slower cadence, none while hidden, one on show', async () => {
    renderHook(() => useSessionGraph('r'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = count('/api/projects/');
    expect(initial).toBe(1);
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GRAPH_POLL_MAX_MS * 5);
    });
    expect(count('/api/projects/')).toBe(initial);
    act(() => setVisibility('visible'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(count('/api/projects/')).toBe(initial + 1);
    expect(GRAPH_POLL_MS).toBe(30_000);
  });

  it('useProjects: none while hidden, one on show', async () => {
    renderHook(() => useProjects(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = count('/api/projects');
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECTS_POLL_MS * 5);
    });
    expect(count('/api/projects')).toBe(initial);
    act(() => setVisibility('visible'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(count('/api/projects')).toBe(initial + 1);
  });

  it('useNotes: a poll or SSE event while hidden fetches nothing; showing refetches once', async () => {
    renderHook(() => useNotes());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = count('/api/notes');
    expect(initial).toBe(1);
    act(() => setVisibility('hidden'));
    act(() => FakeES.all[0]?.emit('note'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTES_POLL_MS * 3);
    });
    expect(count('/api/notes')).toBe(initial);
    act(() => setVisibility('visible'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(count('/api/notes')).toBe(initial + 1);
  });
});
