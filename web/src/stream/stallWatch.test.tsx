// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVideo } from '../testing/streamFakes';
import { fakeHost, fakeSession, type FakeHost } from './fakeHost';
import { SEEK_GRACE_MS, STALL_MIN_MS, STALL_REPEAT_MS, STALL_WINDOW_MS, STALLS_TO_SWITCH, StallWatch, TORRENT_STALLS_TO_SWITCH } from './stallWatch';

let host: FakeHost;
let media: ReturnType<typeof fakeVideo>['media'];
let tooMany: ReturnType<typeof vi.fn<() => void>>;
let watch: StallWatch;

beforeEach(() => {
  vi.useFakeTimers();
  const v = fakeVideo({ paused: false, currentTime: 42 });
  media = v.media;
  host = fakeHost(v.video);
  host.current = { ...host.current, stage: 'ready' };
  host.currentSession = fakeSession();
  tooMany = vi.fn<() => void>();
  watch = new StallWatch(host, tooMany);
});

afterEach(() => {
  watch.clearTimer();
  vi.useRealTimers();
});

describe('StallWatch', () => {
  it('does not count a wait shorter than STALL_MIN_MS', () => {
    watch.waiting();
    vi.advanceTimersByTime(STALL_MIN_MS - 1);
    watch.moving();
    vi.advanceTimersByTime(STALL_REPEAT_MS * 3);
    expect(host.notes).toEqual([]);
    expect(watch.count).toBe(0);
    expect(host.stats().report().stalls).toBe(0);
  });

  it('counts a wait that outlasts it, again every STALL_REPEAT_MS, and asks for another source at STALLS_TO_SWITCH', () => {
    watch.waiting();
    vi.advanceTimersByTime(STALL_MIN_MS);
    expect(host.notes).toEqual(['stalled at 42 s']);
    expect(watch.count).toBe(1);
    vi.advanceTimersByTime(STALL_REPEAT_MS * (STALLS_TO_SWITCH - 1));
    expect(watch.count).toBe(STALLS_TO_SWITCH);
    expect(tooMany).toHaveBeenCalledTimes(1);
    // One freeze is one stall in the play's counters, however often it is counted for the switch.
    expect(host.stats().report().stalls).toBe(1);
  });

  it("does not count a seek's own wait unless it outlasts the grace", () => {
    watch.seeked();
    watch.waiting();
    vi.advanceTimersByTime(STALL_MIN_MS);
    expect(host.notes).toEqual([]);
    vi.advanceTimersByTime(SEEK_GRACE_MS);
    expect(host.notes).toEqual(['stalled at 42 s']);
  });

  it('counts nothing while paused or not ready, and a pause ends the wait', () => {
    media.paused = true;
    watch.waiting();
    vi.advanceTimersByTime(STALL_MIN_MS * 2);
    expect(watch.count).toBe(0);
    media.paused = false;
    host.current = { ...host.current, stage: 'loading' };
    watch.waiting();
    vi.advanceTimersByTime(STALL_MIN_MS * 2);
    expect(watch.count).toBe(0);
    host.current = { ...host.current, stage: 'ready' };
    watch.waiting();
    watch.paused();
    vi.advanceTimersByTime(STALL_MIN_MS * 2);
    expect(watch.count).toBe(0);
  });

  it('lets a torrent stall TORRENT_STALLS_TO_SWITCH times before it asks', () => {
    host.currentSession = fakeSession({ torrent: { infoHash: 'a'.repeat(40), name: 'Film.1080p', index: null, seeds: 9, state: 'downloading' } });
    for (let i = 0; i < TORRENT_STALLS_TO_SWITCH - 1; i++) watch.add();
    expect(tooMany).not.toHaveBeenCalled();
    watch.add();
    expect(tooMany).toHaveBeenCalledTimes(1);
  });

  it('forgets stalls older than the window, and on reset', () => {
    for (let i = 0; i < STALLS_TO_SWITCH - 1; i++) watch.add();
    vi.advanceTimersByTime(STALL_WINDOW_MS);
    watch.add();
    expect(watch.count).toBe(1);
    expect(tooMany).not.toHaveBeenCalled();
    watch.reset();
    expect(watch.count).toBe(0);
  });

  it('counts the first frame only when the film moves on the page', () => {
    host.current = { ...host.current, stage: 'loading' };
    watch.moving();
    expect(host.stats().report().first_frame_ms).toBeNull();
    host.current = { ...host.current, stage: 'ready' };
    watch.moving();
    expect(host.stats().report().first_frame_ms).toBe(0);
  });
});
