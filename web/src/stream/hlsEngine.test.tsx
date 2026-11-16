// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fakeVideo } from '../testing/streamFakes';

/** One hls.js instance as the engine drives it: its config, what it was told, and a hook to fire its events. */
interface FakeHls {
  config: Record<string, unknown>;
  loadSource: Mock<(src: string) => void>;
  startLoad: Mock<(position: number) => void>;
  recoverMediaError: Mock<() => void>;
  destroy: Mock<() => void>;
  emit(event: string, data?: unknown): void;
}

const instances = vi.hoisted(() => [] as FakeHls[]);

vi.mock('hls.js', () => {
  const Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError', FRAG_LOADED: 'hlsFragLoaded' };
  const ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };
  class Hls {
    static isSupported(): boolean {
      return true;
    }
    audioTrack = -1;
    currentLevel = -1;
    subtitleTrack = -1;
    subtitleDisplay = false;
    private readonly listeners = new Map<string, ((event: string, data: unknown) => void)[]>();
    private readonly fake: FakeHls;
    constructor(config: Record<string, unknown>) {
      this.fake = {
        config,
        loadSource: vi.fn(),
        startLoad: vi.fn(),
        recoverMediaError: vi.fn(),
        destroy: vi.fn(),
        emit: (event, data) => {
          for (const listener of this.listeners.get(event) ?? []) listener(event, data);
        },
      };
      instances.push(this.fake);
    }
    on(event: string, listener: (event: string, data: unknown) => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    loadSource(src: string): void {
      this.fake.loadSource(src);
    }
    attachMedia(): void {}
    startLoad(position: number): void {
      this.fake.startLoad(position);
    }
    recoverMediaError(): void {
      this.fake.recoverMediaError();
    }
    setSubtitleOption(): void {}
    destroy(): void {
      this.fake.destroy();
    }
  }
  return { default: Hls, Events, ErrorTypes };
});

import { BUFFER_AHEAD_S, MUTED_BUFFER_AHEAD_S, NETWORK_RETRY_LIMIT, networkRetryDelayMs, type EngineHandlers } from './engine';
import { createHlsEngine } from './hlsEngine';

const SRC = '/api/stream/sessions/S1/p?u=m1';
const PARSED = { levels: [{ height: 720, bitrate: 2_000_000 }], audioTracks: [], subtitleTracks: [] };
const fragError = (details = 'fragLoadError') => ({ type: 'networkError', details, fatal: true, response: { code: 0 } });

afterEach(() => {
  instances.length = 0;
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

function start(over: { bufferAheadS?: number; startAt?: number } = {}) {
  const { video, media } = fakeVideo();
  const h = handlers();
  const engine = createHlsEngine({
    kind: 'hls',
    video,
    src: SRC,
    startAt: over.startAt ?? 0,
    handlers: h,
    ...(over.bufferAheadS === undefined ? {} : { bufferAheadS: over.bufferAheadS }),
  });
  return { engine, hls: instances.at(-1)!, media, h };
}

describe('createHlsEngine: how far ahead it loads (R1.8)', () => {
  it('keeps 120 s ahead whatever the bitrate, and 30 s when the page asks for it (?muted=1)', () => {
    expect(BUFFER_AHEAD_S).toBe(120);
    expect(start().hls.config).toMatchObject({ maxBufferLength: 120, maxMaxBufferLength: 120 });
    expect(start({ bufferAheadS: MUTED_BUFFER_AHEAD_S }).hls.config).toMatchObject({ maxBufferLength: 30, maxMaxBufferLength: 30 });
  });
});

describe('createHlsEngine: a fatal network error (R1.7)', () => {
  it('waits, loads again from where the film is, and goes on once a fragment loads', () => {
    vi.useFakeTimers();
    const { hls, media, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    media.currentTime = 312.4;
    hls.emit('hlsError', fragError());
    expect(h.calls).toEqual(['ready', 'recovering 1 networkError fragLoadError']);
    vi.advanceTimersByTime(networkRetryDelayMs(1) - 1);
    expect(hls.startLoad).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hls.startLoad).toHaveBeenCalledWith(312.4);
    hls.emit('hlsFragLoaded', {});
    expect(h.calls.at(-1)).toBe('recovered');
    // The count started again: the next failure is a first try again.
    hls.emit('hlsError', fragError());
    expect(h.calls.at(-1)).toBe('recovering 1 networkError fragLoadError');
  });

  it(`stops with the error only after ${NETWORK_RETRY_LIMIT} restarts that did not help, waiting longer each time`, () => {
    vi.useFakeTimers();
    const { hls, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    for (let attempt = 1; attempt <= NETWORK_RETRY_LIMIT; attempt++) {
      hls.emit('hlsError', fragError('fragLoadTimeOut'));
      // A second fatal error while the restart waits (audio and video at once) is the same failure.
      hls.emit('hlsError', fragError('fragLoadTimeOut'));
      expect(h.calls.at(-1)).toBe(`recovering ${attempt} networkError fragLoadTimeOut`);
      vi.advanceTimersByTime(networkRetryDelayMs(attempt));
      expect(hls.startLoad).toHaveBeenCalledTimes(attempt);
    }
    hls.emit('hlsError', fragError('fragLoadTimeOut'));
    expect(h.calls.at(-1)).toBe('fatal networkError fragLoadTimeOut');
    expect(h.calls.filter((c) => c.startsWith('recovering'))).toHaveLength(NETWORK_RETRY_LIMIT);
    hls.emit('hlsError', fragError('fragLoadTimeOut'));
    expect(h.calls.filter((c) => c.startsWith('fatal'))).toHaveLength(1);
    expect([1, 2, 3, 4, 5].map(networkRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 16_000]);
  });

  it('asks for the manifest again when it never loaded', () => {
    vi.useFakeTimers();
    const { hls, h } = start({ startAt: 600 });
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
    hls.emit('hlsError', { type: 'networkError', details: 'manifestLoadError', fatal: true, response: { code: 0 } });
    expect(h.calls).toEqual(['recovering 1 networkError manifestLoadError']);
    vi.advanceTimersByTime(networkRetryDelayMs(1));
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(hls.loadSource).toHaveBeenLastCalledWith(SRC);
    expect(hls.startLoad).not.toHaveBeenCalled();
  });

  it('a refused token is still a refresh, never a retry', () => {
    vi.useFakeTimers();
    const { hls, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    hls.emit('hlsError', { ...fragError(), response: { code: 403 }, networkDetails: { getResponseHeader: () => '403' } });
    hls.emit('hlsError', fragError());
    vi.advanceTimersByTime(60_000);
    expect(h.calls).toEqual(['ready', 'auth 403']);
    expect(hls.startLoad).not.toHaveBeenCalled();
  });

  it('a destroyed engine restarts nothing', () => {
    vi.useFakeTimers();
    const { engine, hls, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    hls.emit('hlsError', fragError());
    engine.destroy();
    vi.advanceTimersByTime(60_000);
    expect(hls.destroy).toHaveBeenCalled();
    expect(hls.startLoad).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['ready', 'recovering 1 networkError fragLoadError']);
  });

  it('a media error is still recovered once, and the second one stops the play', () => {
    const { hls, h } = start();
    hls.emit('hlsError', { type: 'mediaError', details: 'bufferStalledError', fatal: true });
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
    hls.emit('hlsError', { type: 'mediaError', details: 'bufferStalledError', fatal: true });
    expect(h.calls).toEqual(['fatal mediaError bufferStalledError']);
  });
});
