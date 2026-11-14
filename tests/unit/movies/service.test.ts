import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVIES_CONFIG } from '../../../src/config.js';
import type { MoviesRepo } from '../../../src/movies/repo.js';
import { MoviesService, type MovieChangeEvent } from '../../../src/movies/service.js';
import { emptySyncReport, type SyncDeps, type SyncReport } from '../../../src/movies/sync.js';

type Pass = (deps: SyncDeps) => Promise<SyncReport>;

function report(deps: SyncDeps, changes: Partial<SyncReport> = {}): SyncReport {
  return { ...emptySyncReport(deps.host, deps.roots, new Date(), 'no_credentials'), ...changes };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function service(pass: Pass, roots: string[] = ['/lib']): MoviesService {
  return new MoviesService({
    config: { ...DEFAULT_MOVIES_CONFIG, enabled: true, roots, scanMs: 1_000 },
    host: 'test-host',
    repo: {} as MoviesRepo,
    tmdb: null,
    resolver: null,
    probe: async () => 0,
    pass,
    log: () => {},
  });
}

describe('MoviesService loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never scans without roots', async () => {
    const pass = vi.fn<Pass>(async (d) => report(d));
    const s = service(pass, []);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pass).not.toHaveBeenCalled();
    expect(s.status().scanning).toBe(false);
    await s.close();
  });

  it('runs one pass at a time and schedules the next scanMs after it ends', async () => {
    const gate = deferred();
    const pass = vi.fn<Pass>(async (d) => {
      if (pass.mock.calls.length === 1) await gate.promise;
      return report(d);
    });
    const s = service(pass);
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pass).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pass).toHaveBeenCalledTimes(2);
    await s.close();
  });

  it('shares one follow-up pass between every syncNow made while a pass runs', async () => {
    const gate = deferred();
    const pass = vi.fn<Pass>(async (d) => {
      if (pass.mock.calls.length === 1) await gate.promise;
      return report(d);
    });
    const s = service(pass);
    const first = s.syncNow();
    const second = s.syncNow();
    const third = s.syncNow();
    expect(second).toBe(third);
    expect(pass).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    await second;
    expect(pass).toHaveBeenCalledTimes(2);
    await s.close();
  });

  it('reports a pass that throws and keeps polling', async () => {
    const pass = vi.fn<Pass>(async (d) => report(d));
    pass.mockRejectedValueOnce(new Error('database down'));
    const s = service(pass);
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.status().last_pass?.error).toBe('database down');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(s.status().last_pass?.error).toBeNull();
    await s.close();
  });

  it('emits changed after a pass that wrote something, and stays quiet otherwise', async () => {
    const pass = vi.fn<Pass>(async (d) => report(d));
    pass.mockImplementationOnce(async (d) => report(d, { new: 2, matched: 2 }));
    const s = service(pass);
    const events: MovieChangeEvent[] = [];
    s.events.on((e) => events.push(e));
    await s.syncNow();
    await s.syncNow();
    expect(events.map((e) => e.reason)).toEqual(['sync']);
    await s.close();
  });

  it('close aborts the running pass and stops the loop', async () => {
    let signal: AbortSignal | undefined;
    const pass = vi.fn<Pass>(
      (d) =>
        new Promise<SyncReport>((resolve) => {
          signal = d.signal;
          d.signal?.addEventListener('abort', () => resolve(report(d, { error: 'aborted' })));
        }),
    );
    const s = service(pass);
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await s.close();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('hands registered hooks to the pass until they are removed', async () => {
    const seen: number[] = [];
    const s = service(async (d) => {
      seen.push(d.hooks?.length ?? 0);
      return report(d);
    });
    const remove = s.addSyncHook({ name: 'recents', afterScan: async () => 0 });
    await s.syncNow();
    remove();
    await s.syncNow();
    expect(seen).toEqual([1, 0]);
    await s.close();
  });
});
