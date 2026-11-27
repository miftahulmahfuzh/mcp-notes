// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVideo, jsonResponse, routeFetch, streamSessionJson } from '../testing/streamFakes';
import { fakeHost, fakeSession, type FakeHost } from './fakeHost';
import { CACHE_POLL_MS, PAUSE_CACHE_DELAY_MS, PauseCache } from './pauseCache';
import type { StreamSession } from './session';

const CACHE = 'POST /api/stream/sessions/S1/cache';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(answers: (() => Response)[], opts: { muted?: boolean } = {}) {
  const { fetchImpl, calls } = routeFetch({ [CACHE]: () => (answers.shift() ?? answers[0] ?? (() => jsonResponse({}, 500)))() });
  const v = fakeVideo({ currentTime: 300, paused: true });
  const host: FakeHost = fakeHost(v.video, { fetch: fetchImpl }, opts);
  host.current = { ...host.current, stage: 'ready' };
  host.currentSession = fakeSession();
  const moved: StreamSession[] = [];
  const cache = new PauseCache({ ...host, moveOntoCache: async (s) => void moved.push(s), replaceSession: (s) => (host.currentSession = s) });
  const asks = () => calls.filter((c) => c.url.endsWith('/cache')).map((c) => c.body);
  return { v, host, cache, moved, asks };
}

const standing = (state: string, moved = false) => () =>
  jsonResponse({ ...streamSessionJson(moved ? { cached: { id: 'c1', state: 'downloading', height: 720 } } : {}), moved, cache: { id: 'c1', state, error: null, progress: 0.1 } });

describe('PauseCache', () => {
  it('asks for a cache after a pause of PAUSE_CACHE_DELAY_MS, once per session, and moves onto it when the daemon does', async () => {
    const t = setup([standing('downloading'), standing('downloading', true)]);
    t.cache.arm();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS - 1);
    expect(t.asks()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.asks()).toEqual([{ start: true }]);
    expect(t.host.notes).toEqual(['paused: caching on this machine (c1)']);
    await vi.advanceTimersByTimeAsync(CACHE_POLL_MS);
    expect(t.asks()).toEqual([{ start: true }, { start: false }]);
    expect(t.moved.map((s) => s.cached?.id)).toEqual(['c1']);
    t.cache.arm();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS * 2);
    expect(t.asks()).toHaveLength(2);
  });

  it('asks nothing for a quick pause, a muted check, a torrent, a cache, or DASH', async () => {
    const quick = setup([standing('downloading')]);
    quick.cache.arm();
    quick.v.media.paused = false;
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS);
    expect(quick.asks()).toEqual([]);
    for (const [session, muted] of [
      [fakeSession(), true],
      [fakeSession({ torrent: { infoHash: 'a'.repeat(40), name: 'F', index: null, seeds: 1, state: 'downloading' } }), false],
      [fakeSession({ cached: { id: 'c0', state: 'ready', height: 1080 } }), false],
      [fakeSession({ manifestKind: 'dash' }), false],
    ] as const) {
      const t = setup([standing('downloading')], { muted });
      t.host.currentSession = session;
      t.cache.arm();
      await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS);
      expect(t.asks()).toEqual([]);
    }
  });

  it('says so and stops asking when the cache failed', async () => {
    const t = setup([standing('failed')]);
    t.cache.arm();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS + CACHE_POLL_MS * 3);
    expect(t.asks()).toHaveLength(1);
    expect(t.host.notes).toEqual(['paused: caching on this machine (c1)', 'cache: failed']);
  });
});
