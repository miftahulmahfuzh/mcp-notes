// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVideo, jsonResponse, routeFetch, streamSessionJson } from '../testing/streamFakes';
import { fakeHost, fakeSession, type FakeHost } from './fakeHost';
import { Reconnect } from './reconnect';
import type { SourceSwitch } from './session';
import { MAX_SOURCE_SWITCHES, NO_OTHER_SOURCE, SOURCE_SWITCH_COOLDOWN_MS, SourceSwitcher } from './sourceSwitch';
import { StallWatch } from './stallWatch';

const SOURCE = 'POST /api/stream/sessions/S1/source';

function setup(answer: () => Response, opts: { muted?: boolean } = {}) {
  const { fetchImpl, calls } = routeFetch({ [SOURCE]: answer });
  const host: FakeHost = fakeHost(fakeVideo({ currentTime: 30 }).video, { fetch: fetchImpl }, opts);
  host.current = { ...host.current, stage: 'ready' };
  host.currentSession = fakeSession();
  const moves: SourceSwitch[] = [];
  const switcher: SourceSwitcher = new SourceSwitcher(
    {
      ...host,
      moveTo: async (a) => {
        moves.push(a);
        switcher.moved();
      },
    },
    new StallWatch(host, () => {}),
    new Reconnect({ ...host, generation: () => 0, hasEngine: () => true, swapTo: async () => {} }),
  );
  const asks = () => calls.filter((c) => c.method === 'POST').map((c) => c.body);
  return { host, switcher, moves, asks };
}

const switched = () => jsonResponse({ ...streamSessionJson({ provider: 'VidNest' }), switched: true, reason: null, from: 'VidFast', provider: 'VidNest' });
const kept = () => jsonResponse({ ...streamSessionJson(), switched: false, reason: 'no_other_source' });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SourceSwitcher', () => {
  it("limits the page's own asks to one per cooldown and MAX_SOURCE_SWITCHES moves", async () => {
    const t = setup(switched);
    await t.switcher.change();
    await t.switcher.change();
    expect(t.asks()).toEqual([{ auto: 'stalled' }]);
    for (let i = 1; i < MAX_SOURCE_SWITCHES + 2; i++) {
      vi.advanceTimersByTime(SOURCE_SWITCH_COOLDOWN_MS);
      await t.switcher.change();
    }
    expect(t.moves).toHaveLength(MAX_SOURCE_SWITCHES);
  });

  it("never limits the owner's asks, and says when there was no other source", async () => {
    const t = setup(kept);
    await t.switcher.change(true);
    await t.switcher.change(true);
    expect(t.asks()).toEqual([undefined, undefined]);
    expect(t.host.current.sourceNotice).toBe(NO_OTHER_SOURCE);
    expect(t.host.notes).toContain('source kept: no_other_source');
    expect(t.host.current.changingSource).toBe(false);
  });

  it('never moves a muted check, and a cached play leaves the cache only by itself', async () => {
    const muted = setup(switched, { muted: true });
    await muted.switcher.change(true);
    await muted.switcher.change();
    expect(muted.asks()).toEqual([]);
    const cached = setup(switched);
    cached.host.currentSession = fakeSession({ cached: { id: 'c1', state: 'downloading', height: 720 } });
    await cached.switcher.change(true);
    expect(cached.asks()).toEqual([]);
    await cached.switcher.change();
    expect(cached.asks()).toEqual([{ leave_cache: true }]);
    expect(cached.host.notes[0]).toBe('0 stalls in 120 s: leaving the cache for the live stream');
  });

  it('stops the play with the error when a broken stream has no other source', async () => {
    const t = setup(kept);
    await t.switcher.leaveBroken('fragParsingError');
    expect(t.asks()).toEqual([{ auto: 'broken' }]);
    expect(t.host.notes).toEqual(['fragParsingError: asking for another source', 'source kept: no_other_source']);
    expect(t.host.failures).toHaveLength(1);
  });
});
