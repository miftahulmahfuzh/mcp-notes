// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTORE_WAIT_MS, restoreScroll } from './scrollMemory';

let height = 0;
let now = 0;
let frames: FrameRequestCallback[] = [];
let scrollTo: ReturnType<typeof vi.fn>;

const frame = (ms = 16) => {
  now += ms;
  const run = frames;
  frames = [];
  for (const f of run) f(now);
};

beforeEach(() => {
  height = 0;
  now = 0;
  frames = [];
  scrollTo = vi.fn();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => height });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document.documentElement, 'scrollHeight');
});

describe('restoreScroll', () => {
  it('scrolls at once when the page is already tall enough', () => {
    height = 5000;
    const done = vi.fn();
    restoreScroll(3000, done);
    expect(scrollTo).toHaveBeenCalledWith(0, 3000);
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it('waits for a page that is still short, then scrolls to the remembered offset', () => {
    height = 900;
    const done = vi.fn();
    restoreScroll(3000, done);
    frame();
    frame();
    expect(scrollTo).not.toHaveBeenCalled();
    height = 3800;
    frame();
    expect(scrollTo).toHaveBeenCalledWith(0, 3000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('settles for the lowest point when the page never gets tall enough', () => {
    height = 2000;
    const done = vi.fn();
    restoreScroll(3000, done);
    frame(RESTORE_WAIT_MS);
    expect(scrollTo).toHaveBeenCalledWith(0, 1200);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('gives up as soon as the user scrolls by hand', () => {
    height = 900;
    const done = vi.fn();
    restoreScroll(3000, done);
    window.dispatchEvent(new Event('wheel'));
    height = 5000;
    frame();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('the returned cancel stops it without calling done', () => {
    height = 900;
    const done = vi.fn();
    const cancel = restoreScroll(3000, done);
    cancel();
    height = 5000;
    frame();
    window.dispatchEvent(new Event('wheel'));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});
