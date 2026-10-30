import { describe, expect, it } from 'vitest';
import { RateLimiter, runBackfill, type BatchReport, type Clock } from '../../../src/embeddings/backfill.js';
import { MemoryEmbeddingStore, ScriptedEmbedder } from '../../helpers/memoryEmbeddingStore.js';

function seed(store: MemoryEmbeddingStore, n: number, prefix = 'note'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `N-${String(i).padStart(3, '0')}`;
    store.setBody(id, `${prefix} ${i}`);
    ids.push(id);
  }
  return ids;
}

function fakeClock(): { clock: Clock; sleeps: number[]; now: () => number } {
  let t = 0;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { clock, sleeps, now: () => t };
}

describe('runBackfill', () => {
  it('drains in batches of batchSize and reports progress', async () => {
    const store = new MemoryEmbeddingStore();
    const ids = seed(store, 40);
    const embedder = new ScriptedEmbedder();
    const progress: number[] = [];
    const result = await runBackfill({
      store,
      embedder,
      batchSize: 16,
      minIntervalMs: 0,
      onProgress: (p) => progress.push(p.embedded),
    });
    expect(embedder.calls.map((c) => c.length)).toEqual([16, 16, 8]);
    expect(progress).toEqual([16, 32, 40]);
    expect(result).toEqual({ batches: 3, calls: 3, embedded: 40, failed: 0, skipped: 0, aborted: false });
    for (const id of ids) expect(store.isCurrent(id, embedder.model)).toBe(true);
  });

  it('falls back to per-note calls when a batch fails and records only the bad note', async () => {
    const store = new MemoryEmbeddingStore();
    seed(store, 4);
    store.setBody('P-OIS', 'poison input');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = (s) => s.includes('poison');
    const reports: BatchReport[] = [];
    const result = await runBackfill({ store, embedder, minIntervalMs: 0, onBatch: (r) => reports.push(r) });

    expect(embedder.calls.map((c) => c.length)).toEqual([5, 1, 1, 1, 1, 1]);
    expect(result).toMatchObject({ embedded: 4, failed: 1, calls: 6, aborted: false });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ notes: 5, fellBack: true, failed: 1 });
    expect(reports[0]?.failures[0]?.id).toBe('P-OIS');
    const row = store.rows.get('P-OIS');
    expect(row).toMatchObject({ embedding: null, attempts: 1 });
    expect(row?.nextAttemptAt ?? 0).toBeGreaterThan(Date.now());
  });

  it('records a single-note batch failure without a second call', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('P-OIS', 'poison input');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = () => true;
    const result = await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(embedder.calls).toHaveLength(1);
    expect(result).toMatchObject({ failed: 1, calls: 1 });
  });

  it('leaves a failed note alone until it is due; ignoreBackoff tries it once per run', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('P-OIS', 'poison input');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = () => true;
    await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(embedder.calls).toHaveLength(1);

    const notDue = await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(notDue.calls).toBe(0);

    const forced = await runBackfill({ store, embedder, minIntervalMs: 0, ignoreBackoff: true });
    expect(forced).toMatchObject({ calls: 1, failed: 1, aborted: false });
    expect(store.rows.get('P-OIS')?.attempts).toBe(2);

    embedder.failIf = null;
    const healed = await runBackfill({ store, embedder, minIntervalMs: 0, ignoreBackoff: true });
    expect(healed).toMatchObject({ embedded: 1, failed: 0 });
    expect(store.rows.get('P-OIS')).toMatchObject({ attempts: 0, lastError: null });
  });

  it('stops on abort and a second run finishes without re-embedding', async () => {
    const store = new MemoryEmbeddingStore();
    const ids = seed(store, 40);
    const embedder = new ScriptedEmbedder();
    const stop = new AbortController();
    const first = await runBackfill({
      store,
      embedder,
      batchSize: 16,
      minIntervalMs: 0,
      signal: stop.signal,
      onBatch: () => stop.abort(),
    });
    expect(first).toMatchObject({ aborted: true, embedded: 16 });

    const second = await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 0 });
    expect(second).toMatchObject({ aborted: false, embedded: 24 });
    const sent = embedder.calls.flat();
    expect(sent).toHaveLength(40);
    expect(new Set(sent).size).toBe(40);
    for (const id of ids) expect(store.isCurrent(id, embedder.model)).toBe(true);
  });

  it('makes no call when aborted before it starts', async () => {
    const store = new MemoryEmbeddingStore();
    seed(store, 3);
    const embedder = new ScriptedEmbedder();
    const stop = new AbortController();
    stop.abort();
    const result = await runBackfill({ store, embedder, minIntervalMs: 0, signal: stop.signal });
    expect(result).toMatchObject({ aborted: true, calls: 0 });
    expect(embedder.calls).toHaveLength(0);
  });

  it('skips a vector whose body changed during the call and embeds the new body', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'first body');
    const embedder = new ScriptedEmbedder();
    let edited = false;
    embedder.onCall = () => {
      if (!edited) {
        edited = true;
        store.setBody('A-001', 'second body');
      }
    };
    const result = await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(result).toMatchObject({ embedded: 1, skipped: 1, calls: 2 });
    expect(embedder.calls).toEqual([['first body'], ['second body']]);
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);
  });

  it('spaces calls by minIntervalMs', async () => {
    const store = new MemoryEmbeddingStore();
    seed(store, 40);
    const embedder = new ScriptedEmbedder();
    const { clock, sleeps, now } = fakeClock();
    const callTimes: number[] = [];
    embedder.onCall = () => callTimes.push(now());
    await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 1000, clock });
    expect(callTimes).toEqual([0, 1000, 2000]);
    expect(sleeps).toEqual([1000, 1000]);
  });
});

describe('RateLimiter', () => {
  it('returns false without a slot when the signal is aborted', async () => {
    const limiter = new RateLimiter(10_000);
    expect(await limiter.acquire()).toBe(true);
    const stop = new AbortController();
    const pending = limiter.acquire(stop.signal);
    stop.abort();
    expect(await pending).toBe(false);
  });
});
