import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/embeddings/backfill.js';
import {
  UnavailableImages,
  runImageBackfill,
  type ImageEmbeddingStore,
  type ImageReport,
} from '../../../src/embeddings/imageBackfill.js';
import type { ImageEmbedder } from '../../../src/embeddings/imageEmbedder.js';
import type { PendingImage } from '../../../src/embeddings/imageRepo.js';
import { OriginalMissingError } from '../../../src/images/derive.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

function image(id: string): PendingImage {
  return { id, noteId: id, path: `images/2026/10/${id}.png`, mime: 'image/png', sha256: `sha-${id}`, width: 12, height: 12, host: 'here', live: true };
}

class MemoryImageStore implements ImageEmbeddingStore {
  images: PendingImage[] = [];
  readonly available = new Set<string>();
  readonly vectors = new Map<string, number[]>();
  readonly failures = new Map<string, { attempts: number; error: string }>();
  readonly missingOnLoad = new Set<string>();
  readonly corrupt = new Set<string>();
  listCalls = 0;
  lastExclude: readonly string[] = [];
  /** List failed images again (as with ignoreBackoff), to prove the run settles them. */
  listFailed = false;

  add(id: string, available = true): void {
    this.images.push(image(id));
    if (available) this.available.add(id);
  }

  async listPending(opts: { model: string; limit: number; excludeIds: readonly string[] }): Promise<PendingImage[]> {
    this.listCalls += 1;
    this.lastExclude = opts.excludeIds;
    const exclude = new Set(opts.excludeIds);
    return this.images
      .filter((i) => !this.vectors.has(i.id) && (this.listFailed || !this.failures.has(i.id)) && !exclude.has(i.id))
      .slice(0, opts.limit);
  }

  async isAvailable(i: PendingImage): Promise<boolean> {
    return this.available.has(i.id);
  }

  async loadPng(i: PendingImage): Promise<Uint8Array> {
    if (this.missingOnLoad.has(i.id)) throw new OriginalMissingError(i.id, `/data/${i.path}`);
    if (this.corrupt.has(i.id)) throw new Error('Input buffer contains unsupported image format');
    return PNG;
  }

  async save(v: { imageId: string; embedding: number[] }): Promise<boolean> {
    this.vectors.set(v.imageId, v.embedding);
    return true;
  }

  async recordFailure(v: { imageId: string; error: string }): Promise<void> {
    const prev = this.failures.get(v.imageId);
    this.failures.set(v.imageId, { attempts: (prev?.attempts ?? 0) + 1, error: v.error });
  }
}

class ScriptedImageEmbedder implements ImageEmbedder {
  readonly model = 'test/images';
  readonly dimensions = 3;
  calls = 0;
  failIf: ((call: number) => boolean) | null = null;

  async embedImage(): Promise<number[]> {
    this.calls += 1;
    if (this.failIf?.(this.calls)) throw new Error(`scripted image failure ${this.calls}`);
    return [1, 0, 0];
  }

  async embedText(): Promise<number[]> {
    return [0, 1, 0];
  }
}

function fakeClock(): Clock & { t: number; slept: number[] } {
  const c = {
    t: 0,
    slept: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
    },
  };
  return c;
}

describe('runImageBackfill', () => {
  it('embeds every available image once, one call per image', async () => {
    const store = new MemoryImageStore();
    for (const id of ['A-001', 'A-002', 'A-003']) store.add(id);
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0 });
    expect(r).toMatchObject({ calls: 3, embedded: 3, failed: 0, unavailable: 0, aborted: false, limited: false });
    expect([...store.vectors.keys()].sort()).toEqual(['A-001', 'A-002', 'A-003']);
  });

  it('skips images not on this machine without a failure, and is not starved behind them', async () => {
    const store = new MemoryImageStore();
    for (let i = 0; i < 50; i += 1) store.add(`U-${String(i).padStart(3, '0')}`, false);
    store.add('L-001');
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0, pageSize: 4 });
    expect(r).toMatchObject({ calls: 1, embedded: 1, failed: 0, unavailable: 50 });
    expect(store.failures.size).toBe(0);
    expect(store.vectors.has('L-001')).toBe(true);
  });

  it('remembers missing originals across runs until the recheck time', async () => {
    const store = new MemoryImageStore();
    for (let i = 0; i < 10; i += 1) store.add(`U-${String(i).padStart(3, '0')}`, false);
    const clock = fakeClock();
    const memo = new UnavailableImages(1_000, clock);
    const embedder = new ScriptedImageEmbedder();
    expect((await runImageBackfill({ store, embedder, clock, minIntervalMs: 0, unavailable: memo })).unavailable).toBe(10);
    store.listCalls = 0;
    const second = await runImageBackfill({ store, embedder, clock, minIntervalMs: 0, unavailable: memo });
    expect(second.unavailable).toBe(0);
    expect(store.listCalls).toBe(1);
    expect(store.lastExclude).toHaveLength(10);
    clock.t += 1_001;
    expect((await runImageBackfill({ store, embedder, clock, minIntervalMs: 0, unavailable: memo })).unavailable).toBe(10);
  });

  it('an original vanishing after the check is unavailable, a bad PNG is a recorded failure', async () => {
    const store = new MemoryImageStore();
    store.add('V-001');
    store.add('C-001');
    store.missingOnLoad.add('V-001');
    store.corrupt.add('C-001');
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0 });
    expect(r).toMatchObject({ calls: 0, unavailable: 1, failed: 1 });
    expect(store.failures.has('V-001')).toBe(false);
    expect(store.failures.get('C-001')?.error).toMatch(/^could not prepare the image: /);
  });

  it('records an embedding failure and never retries it in the same run', async () => {
    const store = new MemoryImageStore();
    store.listFailed = true;
    store.add('F-001');
    store.add('F-002');
    const embedder = new ScriptedImageEmbedder();
    embedder.failIf = (n) => n === 1;
    const reports: ImageReport[] = [];
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0, onImage: (x) => reports.push(x) });
    expect(r).toMatchObject({ calls: 2, embedded: 1, failed: 1 });
    expect(store.failures.get('F-001')).toEqual({ attempts: 1, error: 'scripted image failure 1' });
    expect(reports.map((x) => x.outcome)).toEqual(['failed', 'embedded']);
  });

  it('stops at maxImages and says so', async () => {
    const store = new MemoryImageStore();
    for (const id of ['A-001', 'A-002', 'A-003']) store.add(id);
    const r = await runImageBackfill({ store, embedder: new ScriptedImageEmbedder(), minIntervalMs: 0, maxImages: 2 });
    expect(r).toMatchObject({ embedded: 2, limited: true });
  });

  it('makes no call once the signal has aborted', async () => {
    const store = new MemoryImageStore();
    store.add('A-001');
    const stop = new AbortController();
    stop.abort();
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0, signal: stop.signal });
    expect(r).toMatchObject({ calls: 0, aborted: true });
    expect(embedder.calls).toBe(0);
  });

  it('spaces calls by minIntervalMs on the injected clock', async () => {
    const store = new MemoryImageStore();
    for (const id of ['A-001', 'A-002', 'A-003']) store.add(id);
    const clock = fakeClock();
    await runImageBackfill({ store, embedder: new ScriptedImageEmbedder(), minIntervalMs: 1_000, clock });
    expect(clock.slept).toEqual([1_000, 1_000]);
  });

  it('stops when a store ignores excludeIds and lists only settled images', async () => {
    const store = new MemoryImageStore();
    store.add('U-001', false);
    store.listPending = async () => [image('U-001')];
    const r = await runImageBackfill({ store, embedder: new ScriptedImageEmbedder(), minIntervalMs: 0 });
    expect(r.unavailable).toBe(1);
  });
});
