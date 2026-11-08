// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAdaptivePoll } from './pageActive';

let visibility: 'visible' | 'hidden';
const setVisibility = (v: 'visible' | 'hidden') => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startAdaptivePoll', () => {
  it('fires after baseMs while visible', async () => {
    const run = vi.fn(async () => true);
    const p = startAdaptivePoll({ baseMs: 1000, run });
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('never fires while hidden', async () => {
    visibility = 'hidden';
    const run = vi.fn(async () => true);
    const p = startAdaptivePoll({ baseMs: 1000, run });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    p.stop();
  });

  it('runs once on becoming visible after staleMs, then resumes', async () => {
    const run = vi.fn(async () => true);
    const p = startAdaptivePoll({ baseMs: 1000, staleMs: 3000, run });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('does not run on becoming visible before staleMs', async () => {
    const run = vi.fn(async () => true);
    const p = startAdaptivePoll({ baseMs: 10_000, staleMs: 5000, run });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(1000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    p.stop();
  });

  it('doubles the delay up to maxMs on unchanged answers and resets on a change', async () => {
    let changed = false;
    const run = vi.fn(async () => changed);
    const p = startAdaptivePoll({ baseMs: 1000, maxMs: 4000, run });
    await vi.advanceTimersByTimeAsync(1000); // run 1, next in 2000
    await vi.advanceTimersByTimeAsync(2000); // run 2, next in 4000
    await vi.advanceTimersByTimeAsync(4000); // run 3, next capped at 4000
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(run).toHaveBeenCalledTimes(3);
    changed = true;
    await vi.advanceTimersByTimeAsync(1); // run 4 sees a change, next in 1000
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(5);
    p.stop();
  });

  it('stop() clears the timer and the listener', async () => {
    const run = vi.fn(async () => true);
    const p = startAdaptivePoll({ baseMs: 1000, staleMs: 0, run });
    p.stop();
    await vi.advanceTimersByTimeAsync(5000);
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
