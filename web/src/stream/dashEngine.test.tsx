// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeVideo, jsonResponse, routeFetch, streamSessionJson } from '../testing/streamFakes';

/** One dash.js player as the engine drives it: what it was told, and hooks to answer as dash.js would. */
interface FakePlayer {
  src: string;
  startAt: number | undefined;
  reset: ReturnType<typeof vi.fn>;
  /** A response dash.js finished loading: runs the engine's response interceptor. */
  respond(status: number, headers?: Record<string, string>): Promise<void>;
  emit(event: string, payload?: unknown): void;
}

const players = vi.hoisted(() => [] as FakePlayer[]);

vi.mock('dashjs', () => {
  const events = { STREAM_INITIALIZED: 'streamInitialized', ERROR: 'error' };
  const MediaPlayer = () => ({
    create() {
      const listeners = new Map<string, ((payload: unknown) => void)[]>();
      const interceptors: ((response: unknown) => Promise<unknown>)[] = [];
      const player: FakePlayer = {
        src: '',
        startAt: undefined,
        reset: vi.fn(),
        async respond(status, headers = {}) {
          for (const interceptor of interceptors) await interceptor({ status, headers });
        },
        emit(event, payload) {
          for (const listener of listeners.get(event) ?? []) listener(payload);
        },
      };
      players.push(player);
      return {
        updateSettings() {},
        addResponseInterceptor(fn: (response: unknown) => Promise<unknown>) {
          interceptors.push(fn);
        },
        on(event: string, fn: (payload: unknown) => void) {
          listeners.set(event, [...(listeners.get(event) ?? []), fn]);
        },
        initialize(_video: unknown, src: string, _autoplay: boolean, startAt?: number) {
          player.src = src;
          player.startAt = startAt;
        },
        getTracksFor: () => [],
        getRepresentationsByType: () => [{ height: 360, bandwidth: 700_000 }],
        setCurrentTrack() {},
        enableText() {},
        setRepresentationForTypeByIndex() {},
        reset: player.reset,
      };
    },
  });
  MediaPlayer.events = events;
  return { MediaPlayer };
});

import { StreamController } from './controller';
import { createEngine } from './createEngine';
import { createDashEngine } from './dashEngine';
import type { EngineHandlers } from './engine';

const S1 = '/api/stream/sessions/S1';
const UPSTREAM = { 'x-notesd-upstream': '403' };

afterEach(() => {
  players.length = 0;
});

function handlers(): EngineHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onReady: () => calls.push('ready'),
    onAuthError: (status) => calls.push(`auth ${status}`),
    onSessionOver: (status) => calls.push(`over ${status}`),
    onFatal: (message) => calls.push(`fatal ${message}`),
  };
}

describe('createDashEngine: what a refused answer means', () => {
  it.each([401, 403, 410])('a %i the stream host sent through the pass-through is an expired token', async (status) => {
    const h = handlers();
    createDashEngine({ kind: 'dash', video: fakeVideo().video, src: `${S1}/p?u=m1`, startAt: 0, handlers: h });
    await players[0]!.respond(200, { 'x-notesd-upstream': '200' });
    await players[0]!.respond(status, { 'x-notesd-upstream': String(status) });
    expect(h.calls).toEqual([`auth ${status}`]);
  });

  it("notesd's own 403 (no X-Notesd-Upstream) ends the session; other failures are left to dash.js", async () => {
    const h = handlers();
    createDashEngine({ kind: 'dash', video: fakeVideo().video, src: `${S1}/p?u=m1`, startAt: 0, handlers: h });
    await players[0]!.respond(404, { 'x-notesd-upstream': '404' });
    await players[0]!.respond(502);
    expect(h.calls).toEqual([]);
    await players[0]!.respond(403);
    expect(h.calls).toEqual(['over 403']);
  });

  it('says nothing once destroyed: a late answer or error of a replaced player is dropped', async () => {
    const h = handlers();
    const engine = createDashEngine({ kind: 'dash', video: fakeVideo().video, src: `${S1}/p?u=m1`, startAt: 30, handlers: h });
    expect(players[0]).toMatchObject({ src: `${S1}/p?u=m1`, startAt: 30 });
    engine.destroy();
    expect(players[0]!.reset).toHaveBeenCalled();
    await players[0]!.respond(403, UPSTREAM);
    players[0]!.emit('error', { error: { code: 27 } });
    players[0]!.emit('streamInitialized');
    expect(h.calls).toEqual([]);
  });
});

describe('a DASH stream whose token expires (R2.5 through dashEngine)', () => {
  it('refreshes once and continues from the last position in a new dash.js player', async () => {
    const { fetchImpl, calls } = routeFetch({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ manifest_kind: 'dash', manifest_url: `${S1}/p?u=t${calls.filter((c) => c.method === 'POST').length + 1}.mpd` })),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson({ manifest_kind: 'dash' })),
    });
    const { video, media, fire } = fakeVideo();
    const controller = new StreamController('S1', video, { fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} });
    try {
      void controller.start();
      await vi.waitFor(() => expect(players).toHaveLength(1));
      const first = players[0]!;
      expect(first).toMatchObject({ src: `${S1}/p?u=t1.mpd`, startAt: undefined });
      first.emit('streamInitialized');
      await vi.waitFor(() => expect(controller.getState()).toMatchObject({ stage: 'ready', kind: 'dash' }));
      media.currentTime = 100;
      fire('timeupdate');

      // The stream host refuses the token on the segments of a seek: dash.js asks for video and audio at once.
      await Promise.all([first.respond(403, UPSTREAM), first.respond(403, UPSTREAM)]);
      expect(first.reset).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(players).toHaveLength(2));
      const second = players[1]!;
      expect(second).toMatchObject({ src: `${S1}/p?u=t2.mpd`, startAt: 100 });
      expect(calls.filter((c) => c.method === 'POST' && c.url === `${S1}/refresh`)).toHaveLength(1);

      // dash.js's retries of the old player run out after it was replaced: nothing comes of it.
      await first.respond(403, UPSTREAM);
      first.emit('error', { error: { code: 27, message: 'segment not available' } });
      second.emit('streamInitialized');
      await second.respond(200, { 'x-notesd-upstream': '200' });
      expect(controller.getState()).toMatchObject({ stage: 'ready', refreshes: 1, error: null, errors: [] });
    } finally {
      controller.dispose();
    }
  });

  it('stops with stream_expired when the refreshed DASH stream is refused before it plays', async () => {
    const { fetchImpl } = routeFetch({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ manifest_kind: 'dash' })),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson({ manifest_kind: 'dash' })),
    });
    const controller = new StreamController('S1', fakeVideo().video, { fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} });
    try {
      void controller.start();
      await vi.waitFor(() => expect(players).toHaveLength(1));
      players[0]!.emit('streamInitialized');
      await players[0]!.respond(410, { 'x-notesd-upstream': '410' });
      await vi.waitFor(() => expect(players).toHaveLength(2));
      await players[1]!.respond(410, { 'x-notesd-upstream': '410' });
      expect(controller.getState()).toMatchObject({ stage: 'error', error: 'stream_expired', refreshes: 1 });
    } finally {
      controller.dispose();
    }
  });
});
