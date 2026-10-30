import { afterEach, describe, expect, it } from 'vitest';
import { startEmbeddingWorker, type EmbeddingWorker } from '../../../src/embeddings/worker.js';
import { NoteEvents } from '../../../src/notes/events.js';
import { MemoryEmbeddingStore, ScriptedEmbedder } from '../../helpers/memoryEmbeddingStore.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let worker: EmbeddingWorker | null = null;

afterEach(async () => {
  await worker?.close();
  worker = null;
});

function start(
  store: MemoryEmbeddingStore,
  embedder: ScriptedEmbedder,
  events = new NoteEvents(),
  sweepMs = 3_600_000,
): { events: NoteEvents; logs: string[]; worker: EmbeddingWorker } {
  const logs: string[] = [];
  worker = startEmbeddingWorker({
    store,
    events,
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs,
    log: (line) => logs.push(line),
  });
  return { events, logs, worker };
}

describe('startEmbeddingWorker', () => {
  it('drains existing notes at start and logs one line per batch', async () => {
    const store = new MemoryEmbeddingStore();
    for (let i = 0; i < 20; i += 1) store.setBody(`N-${i}`, `note ${i}`);
    const embedder = new ScriptedEmbedder();
    const { logs, worker: w } = start(store, embedder);
    await w.idle();
    expect(embedder.calls.map((c) => c.length)).toEqual([16, 4]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^\[notesd\] embeddings: 16\/16 embedded, 1 call, \d+ms$/);
  });

  it('an idle worker sweeps but makes no call and logs nothing', async () => {
    const store = new MemoryEmbeddingStore();
    const embedder = new ScriptedEmbedder();
    const { logs } = start(store, embedder, new NoteEvents(), 5);
    await sleep(60);
    expect(store.listCalls).toBeGreaterThanOrEqual(3);
    expect(embedder.calls).toHaveLength(0);
    expect(logs).toEqual([]);
  });

  it('created and updated events trigger a drain; deleted and restored do not', async () => {
    const store = new MemoryEmbeddingStore();
    const embedder = new ScriptedEmbedder();
    const { events, worker: w } = start(store, embedder);
    await w.idle();

    store.setBody('A-001', 'hello');
    events.emit('created', 'A-001');
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    store.setBody('A-001', 'hello again');
    events.emit('updated', 'A-001');
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    const lists = store.listCalls;
    events.emit('deleted', 'A-001');
    events.emit('restored', 'A-001');
    await w.idle();
    expect(store.listCalls).toBe(lists);
    expect(embedder.calls).toHaveLength(2);
  });

  it('a kick during a drain runs one more pass', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'first');
    const embedder = new ScriptedEmbedder();
    let release!: () => void;
    embedder.gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const { events, worker: w } = start(store, embedder);
    await callStarted;

    store.setBody('A-002', 'second');
    events.emit('created', 'A-002');
    await sleep(10);
    embedder.gate = null;
    release();
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);
    expect(store.isCurrent('A-002', embedder.model)).toBe(true);
  });

  it('logs a failed batch with the bad note id', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'fine');
    store.setBody('P-OIS', 'poison');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = (s) => s === 'poison';
    const { logs, worker: w } = start(store, embedder);
    await w.idle();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('1/2 embedded');
    expect(logs[0]).toContain('1 failed (P-OIS: scripted failure');
    expect(logs[0]).toContain('per-note fallback');
  });

  it('a store error is logged and the worker keeps going', async () => {
    const store = new MemoryEmbeddingStore();
    store.failList = new Error('db down');
    const embedder = new ScriptedEmbedder();
    const { logs, worker: w } = start(store, embedder);
    await w.idle();
    expect(logs).toEqual(['[notesd] embeddings: drain failed: db down']);

    store.failList = null;
    store.setBody('A-001', 'back up');
    w.kick();
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);
  });

  it('close waits for the in-flight batch, saves it, and ignores later events', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'in flight');
    const embedder = new ScriptedEmbedder();
    let release!: () => void;
    embedder.gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const { events, worker: w } = start(store, embedder);
    await callStarted;

    let closed = false;
    const closing = w.close().then(() => {
      closed = true;
    });
    await sleep(20);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    embedder.gate = null;
    store.setBody('A-002', 'after close');
    events.emit('created', 'A-002');
    w.kick();
    await w.idle();
    expect(embedder.calls).toHaveLength(1);
    expect(events.listenerCount()).toBe(0);
  });

  it('close gives up on an in-flight batch after closeGraceMs', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'stuck');
    const embedder = new ScriptedEmbedder();
    embedder.gate = new Promise<void>(() => {}); // never answers
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const w = startEmbeddingWorker({
      store,
      events: new NoteEvents(),
      embedder,
      minIntervalMs: 0,
      debounceMs: 0,
      sweepMs: 3_600_000,
      closeGraceMs: 30,
      log: () => {},
    });
    await callStarted;
    const t0 = Date.now();
    await w.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(store.isCurrent('A-001', embedder.model)).toBe(false);
  });
});
