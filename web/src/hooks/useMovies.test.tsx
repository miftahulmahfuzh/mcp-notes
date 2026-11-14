// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MOVIE, PLAYER_IDLE, PLAYING, STATUS, TITLES, UNMATCHED } from '../testing/movieFixtures';
import type { PlayerState } from '../moviesApi';
import { NO_MOVIES_ROUTE } from '../lib/route';
import { PLAY_POLL_MS, useMovies } from './useMovies';

class FakeES {
  static all: FakeES[] = [];
  closed = false;
  private l = new Map<string, Array<(e?: unknown) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data: '{"op":"sync","title_id":null,"file_id":null}' });
  }
}

let calls: string[];
let players: PlayerState[];
let off: boolean;
/** A plain object, not a `Response`: its body resolves in microtasks only, so the fake-timer test can flush it. */
const json = (v: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', json: async () => v }) as unknown as Response;
const count = (c: string) => calls.filter((x) => x === c).length;
/** Under fake timers: run due timers and let every fetch -> json -> setState chain settle. */
const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

beforeEach(() => {
  calls = [];
  players = [PLAYER_IDLE];
  off = false;
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (off) return json({ error: 'movies_off', message: 'off' }, 503);
      if (url === '/api/movies') return json({ titles: TITLES });
      if (url === '/api/movies/status') return json(STATUS);
      if (url === '/api/movies/player') return json(players.length > 1 ? players.shift() : players[0]);
      if (url === '/api/movies/unmatched') return json({ files: UNMATCHED });
      if (url === '/api/movies/movie-467905') return json(MOVIE);
      return json({ error: 'not_found' }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  FakeES.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useMovies', () => {
  it('fetches nothing while disabled', async () => {
    renderHook(() => useMovies(false, NO_MOVIES_ROUTE));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
    expect(FakeES.all).toHaveLength(0);
  });

  it('loads the library, status and player; the title or unmatched list only when the route asks', async () => {
    const { result, rerender } = renderHook(({ title, unmatched }) => useMovies(true, { title, unmatched }), {
      initialProps: { title: null as string | null, unmatched: false },
    });
    await waitFor(() => expect(result.current.titles).toHaveLength(3));
    await waitFor(() => expect(result.current.status?.counts.unmatched_here).toBe(2));
    await waitFor(() => expect(result.current.player?.available).toBe(true));
    expect(count('GET /api/movies/unmatched')).toBe(0);
    rerender({ title: 'movie-467905', unmatched: false });
    await waitFor(() => expect(result.current.detail?.id).toBe('movie-467905'));
    rerender({ title: null, unmatched: true });
    await waitFor(() => expect(result.current.unmatched).toHaveLength(2));
    expect(result.current.detail).toBeNull();
  });

  it('refetches when /api/movies/events says changed, and closes the stream when the page closes', async () => {
    const { result, rerender } = renderHook(({ on }) => useMovies(on, NO_MOVIES_ROUTE), { initialProps: { on: true } });
    await waitFor(() => expect(result.current.titles).toHaveLength(3));
    const es = FakeES.all.find((e) => e.url === '/api/movies/events');
    expect(es).toBeDefined();
    act(() => es!.emit('changed'));
    await waitFor(() => expect(count('GET /api/movies')).toBe(2));
    rerender({ on: false });
    expect(es!.closed).toBe(true);
  });

  it('reports movies_off from a 503', async () => {
    off = true;
    const { result } = renderHook(() => useMovies(true, NO_MOVIES_ROUTE));
    await waitFor(() => expect(result.current.listError).toBe('movies_off'));
    expect(result.current.titles).toBeNull();
  });

  it('polls the player and the open title every 5 s while a play is active, then refreshes everything once', async () => {
    vi.useFakeTimers();
    players = [PLAYING, PLAYING, PLAYER_IDLE];
    renderHook(() => useMovies(true, { title: 'movie-467905', unmatched: false }));
    await flush(0);
    expect(count('GET /api/movies/player')).toBe(1);
    expect(count('GET /api/movies')).toBe(1);
    expect(count('GET /api/movies/movie-467905')).toBe(1);
    await flush(PLAY_POLL_MS);
    expect(count('GET /api/movies/player')).toBe(2);
    expect(count('GET /api/movies/movie-467905')).toBe(2);
    expect(count('GET /api/movies')).toBe(1);
    await flush(PLAY_POLL_MS);
    // The third read says idle: the play ended, so the library is read once more.
    expect(count('GET /api/movies')).toBe(2);
    const players3 = count('GET /api/movies/player');
    await flush(PLAY_POLL_MS * 3);
    expect(count('GET /api/movies/player')).toBe(players3);
  });
});
