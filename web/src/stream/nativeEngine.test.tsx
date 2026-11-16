// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_RETRY_LIMIT, networkRetryDelayMs, type EngineHandlers } from './engine';
import { createNativeEngine } from './nativeEngine';
import { fakeVideo } from '../testing/streamFakes';

const SRC = '/api/stream/sessions/S1/p?u=film.mp4';

afterEach(() => {
  vi.useRealTimers();
});

function handlers(): EngineHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onReady: () => calls.push('ready'),
    onAuthError: (status) => calls.push(`auth ${status}`),
    onSessionOver: (status) => calls.push(`over ${status}`),
    onRecovering: (attempt, message) => calls.push(`recovering ${attempt} ${message}`),
    onRecovered: () => calls.push('recovered'),
    onFatal: (message) => calls.push(`fatal ${message}`),
  };
}

/** A <video> whose MediaError the test sets, recording every address the engine hands it. */
function nativeVideo() {
  const { video, media, play, fire } = fakeVideo();
  let error: { code: number } | null = null;
  const loads: string[] = [];
  Object.defineProperty(video, 'error', { configurable: true, get: () => error });
  Object.defineProperty(video, 'src', {
    configurable: true,
    get: () => loads.at(-1) ?? '',
    set: (value: string) => {
      loads.push(value);
    },
  });
  video.load = vi.fn();
  return {
    video,
    media,
    play,
    fire,
    loads,
    fail(code: number) {
      error = { code };
      fire('error');
    },
  };
}

/** The engine's probe of the file through the pass-through. */
const probe = (status: number, upstream: string | null = String(status)) =>
  vi.fn(async () => new Response('', { status, headers: upstream === null ? {} : { 'x-notesd-upstream': upstream } }));

describe('createNativeEngine: a network error (R1.7)', () => {
  it('loads the file again after a wait and puts the picture back where it stopped', async () => {
    vi.useFakeTimers();
    const v = nativeVideo();
    const h = handlers();
    createNativeEngine({ kind: 'mp4', video: v.video, src: SRC, startAt: 0, handlers: h }, probe(206));
    expect(v.loads).toEqual([SRC]);
    v.fire('loadedmetadata');
    Object.assign(v.media, { currentTime: 1312.5, paused: false });
    v.fail(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['ready', 'recovering 1 media error 2']);
    await vi.advanceTimersByTimeAsync(networkRetryDelayMs(1));
    expect(v.loads).toEqual([SRC, SRC]);
    v.media.currentTime = 0;
    v.fire('loadedmetadata');
    expect(v.media.currentTime).toBe(1312.5);
    expect(h.calls).toEqual(['ready', 'recovering 1 media error 2', 'recovered']);
    expect(v.play).toHaveBeenCalled();
  });

  it(`stops with the error after ${NETWORK_RETRY_LIMIT} reloads that did not help`, async () => {
    vi.useFakeTimers();
    const v = nativeVideo();
    const h = handlers();
    createNativeEngine({ kind: 'mp4', video: v.video, src: SRC, startAt: 0, handlers: h }, probe(502, null));
    v.fire('loadedmetadata');
    for (let attempt = 1; attempt <= NETWORK_RETRY_LIMIT; attempt++) {
      v.fail(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.at(-1)).toBe(`recovering ${attempt} media error 2`);
      await vi.advanceTimersByTimeAsync(networkRetryDelayMs(attempt));
    }
    expect(v.loads).toHaveLength(1 + NETWORK_RETRY_LIMIT);
    v.fail(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.at(-1)).toBe('fatal media error 2');
  });

  it('a file the browser cannot play still stops at once, and a refusal is still a refusal', async () => {
    const broken = nativeVideo();
    const h = handlers();
    createNativeEngine({ kind: 'mp4', video: broken.video, src: SRC, startAt: 0, handlers: h }, probe(206));
    broken.fail(4);
    await vi.waitFor(() => expect(h.calls).toEqual(['fatal media error 4']));

    const refused = nativeVideo();
    const r = handlers();
    createNativeEngine({ kind: 'mp4', video: refused.video, src: SRC, startAt: 0, handlers: r }, probe(403));
    refused.fail(2);
    await vi.waitFor(() => expect(r.calls).toEqual(['auth 403']));
  });
});
