import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingWorker } from '../../../src/embeddings/worker.js';
import { REPLY_EMBEDDINGS_LABEL, startReplyEmbeddingWorker } from '../../../src/sessions/replyEmbeddings.js';
import { MemoryEmbeddingStore, ScriptedEmbedder } from '../../helpers/memoryEmbeddingStore.js';

let worker: EmbeddingWorker | null = null;

afterEach(async () => {
  await worker?.close();
  worker = null;
});

function start(store: MemoryEmbeddingStore, embedder: ScriptedEmbedder, closeGraceMs?: number): { logs: string[]; w: EmbeddingWorker } {
  const logs: string[] = [];
  const w = startReplyEmbeddingWorker({
    store,
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs: 3_600_000,
    ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
    log: (line) => logs.push(line),
  });
  worker = w;
  return { logs, w };
}

describe('startReplyEmbeddingWorker', () => {
  it('embeds pending replies at start and logs under its own label', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('s1#0', 'the adversary shows zero trades because the lease expired');
    store.setBody('s1#1', 'fixed by renewing the lease before the open');
    const embedder = new ScriptedEmbedder();
    const { logs, w } = start(store, embedder);
    await w.idle();
    expect(store.isCurrent('s1#0', embedder.model)).toBe(true);
    expect(store.isCurrent('s1#1', embedder.model)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(new RegExp(`^\\[notesd\\] ${REPLY_EMBEDDINGS_LABEL}: 2/2 embedded, 1 call, \\d+ms$`));
  });

  it('a failing batch falls back per reply and says so', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('s1#0', 'good reply');
    store.setBody('s1#1', 'bad reply');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = (s) => s === 'bad reply';
    const { logs, w } = start(store, embedder);
    await w.idle();
    expect(store.isCurrent('s1#0', embedder.model)).toBe(true);
    expect(store.isCurrent('s1#1', embedder.model)).toBe(false);
    expect(store.rows.get('s1#1')?.attempts).toBe(1);
    expect(logs[0]).toContain('per-reply fallback');
    expect(logs[0]).toContain('1 failed (s1#1:');
  });

  it('a store outage is logged, never thrown', async () => {
    const store = new MemoryEmbeddingStore();
    store.failList = new Error('db down');
    const { logs, w } = start(store, new ScriptedEmbedder());
    await w.idle();
    expect(logs).toEqual([`[notesd] ${REPLY_EMBEDDINGS_LABEL}: drain failed: db down`]);
  });

  it('close gives up on an in-flight call after closeGraceMs', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('s1#0', 'stuck');
    const embedder = new ScriptedEmbedder();
    embedder.gate = new Promise<void>(() => {}); // never answers
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const { w } = start(store, embedder, 30);
    await callStarted;
    const t0 = Date.now();
    await w.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(store.isCurrent('s1#0', embedder.model)).toBe(false);
  });
});
