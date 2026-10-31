import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackground } from '../../src/background.js';
import { embedImagesBackfill } from '../../src/cli/embedImagesBackfill.js';
import type { Db } from '../../src/db/client.js';
import { dbImageEmbeddingStore, runImageBackfill } from '../../src/embeddings/imageBackfill.js';
import { startImageEmbeddingWorker } from '../../src/embeddings/imageWorker.js';
import type { EmbeddingWorker } from '../../src/embeddings/worker.js';
import { imageDeps, ingestImage } from '../../src/images/ingest.js';
import { FakeImageEmbedder, type Rgb } from '../helpers/fakeImageEmbedder.js';
import { addImage, makeImage, originalPathOf, startHarness, type Harness } from './imageHarness.js';
import { closeTestDb, openTestDb } from './setup.js';

type EmbRow = { has_vector: boolean; attempts: number; last_error: string | null; due: boolean };

let h: Harness;
let worker: EmbeddingWorker | null = null;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});
afterEach(async () => {
  await worker?.close();
  worker = null;
});

async function row(imageId: string): Promise<EmbRow | null> {
  const r = await h.deps.db.execute<EmbRow>(sql`
    select embedding is not null as has_vector, attempts, last_error,
           (next_attempt_at is null or next_attempt_at <= now()) as due
    from note_image_embeddings where image_id = ${imageId}
  `);
  return r.rows[0] ?? null;
}

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function photo(rgb: Rgb): Promise<string> {
  const note = await h.deps.service.create({ body: 'a photo #pics' });
  return addImage(h, note.id, note.id, 0, rgb);
}

/** A photo whose original is then removed: it lives "on the other laptop". */
async function foreignPhoto(rgb: Rgb): Promise<string> {
  const id = await photo(rgb);
  await rm(await originalPathOf(h, id));
  return id;
}

function store() {
  return dbImageEmbeddingStore(h.deps.db, h.dataDir);
}

describe('image embedding worker', () => {
  it('embeds an image note as soon as it is created, and logs one summary line', async () => {
    const fake = new FakeImageEmbedder();
    const logs: string[] = [];
    worker = startImageEmbeddingWorker({
      store: store(),
      events: h.deps.events,
      embedder: fake,
      minIntervalMs: 0,
      debounceMs: 0,
      sweepMs: 3_600_000,
      log: (l) => logs.push(l),
    });
    await worker.idle();
    const { note } = await ingestImage(imageDeps(h.deps), {
      bytes: await makeImage('png', 40, 30, { r: 220, g: 20, b: 20 }),
      originalName: 'red.png',
      body: 'red top #pics',
    });
    await until(async () => (await row(note.images[0]!.id))?.has_vector === true);
    await worker.idle();
    expect(fake.calls).toEqual([{ kind: 'image', bytes: expect.any(Number) }]);
    expect(logs.some((l) => /^\[notesd\] image embeddings: 1 embedded, 1 call, \d+ms$/.test(l))).toBe(true);
  });

  it('skips images not on this machine without a failure, and still reaches a local one behind them', async () => {
    const local = await photo({ r: 1, g: 2, b: 3 });
    const foreign: string[] = [];
    for (let i = 0; i < 10; i += 1) foreign.push(await foreignPhoto({ r: 10 + i * 20, g: 50, b: 50 }));
    const fake = new FakeImageEmbedder();
    const r = await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0, pageSize: 3 });
    expect(r).toMatchObject({ embedded: 1, failed: 0, unavailable: 10, calls: 1 });
    expect((await row(local))?.has_vector).toBe(true);
    for (const id of foreign) expect(await row(id)).toBeNull();
  });

  it('a failing call is recorded with backoff and not retried before it is due', async () => {
    const id = await photo({ r: 220, g: 20, b: 20 });
    const fake = new FakeImageEmbedder();
    fake.failNext(1);
    expect(await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0 })).toMatchObject({ failed: 1, calls: 1 });
    expect(await row(id)).toMatchObject({ has_vector: false, attempts: 1, due: false });
    expect((await row(id))!.last_error).toMatch(/scripted failure/);
    expect((await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0 })).calls).toBe(0);
    expect((await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0, ignoreBackoff: true })).embedded).toBe(1);
  });
});

describe('startBackground', () => {
  it('runs the image worker when an image embedder is configured', async () => {
    const fake = new FakeImageEmbedder();
    const id = await photo({ r: 20, g: 20, b: 220 });
    const stop = await startBackground({ ...h.deps, imageEmbedder: fake });
    try {
      await until(async () => (await row(id))?.has_vector === true);
    } finally {
      await stop();
    }
  });

  it('logs "image search off" once and embeds nothing without one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const id = await photo({ r: 20, g: 200, b: 20 });
    const stop = await startBackground({ ...h.deps, imageEmbedder: null });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(await row(id)).toBeNull();
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('image search off'))).toHaveLength(1);
      expect(lines.filter((l) => l.includes('embeddings off'))).toHaveLength(1);
    } finally {
      await stop();
      log.mockRestore();
    }
  });
});

describe('npm run embed:images:backfill', () => {
  function cli(fake: FakeImageEmbedder | null, out: string[], err: string[], apiKey: string | null = 'test-key') {
    return {
      loadConfig: () => ({ ...h.deps.config, embeddings: { apiKey } }),
      createDb: () => openTestDb(),
      closeDb: async (d: Db) => closeTestDb(d),
      createEmbedder: (key: string) => {
        expect(key).toBe('test-key');
        if (fake === null) throw new Error('a dry run must not build an embedder');
        return fake;
      },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      minIntervalMs: 0,
    };
  }

  it('--dry-run counts and estimates without a key, a call or a write', async () => {
    await photo({ r: 220, g: 20, b: 20 });
    await photo({ r: 20, g: 20, b: 220 });
    await foreignPhoto({ r: 20, g: 200, b: 20 });
    const out: string[] = [];
    const err: string[] = [];
    expect(await embedImagesBackfill(['--dry-run'], cli(null, out, err, null))).toBe(0);
    expect(out[0]).toMatch(/3 images, 0 current, 3 pending \(0 failing\)/);
    expect(out).toContain('dry run: 3 due now, 2 on this machine, 1 on another machine (skipped here)');
    expect(out.join('\n')).toMatch(/would send 2 image\(s\): about 516 image tokens, about \$0\.0002 at \$0\.45 per million image tokens \(estimate\)/);
    expect(out.at(-1)).toBe('dry run: nothing was sent and nothing was written');
    expect(err).toEqual([]);
    const rows = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_image_embeddings`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('--limit N sends at most N images and says so', async () => {
    for (const r of [200, 210, 220]) await photo({ r, g: 20, b: 20 });
    const fake = new FakeImageEmbedder();
    const out: string[] = [];
    expect(await embedImagesBackfill(['--limit', '2'], cli(fake, out, []))).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(out).toContain('stopped at --limit 2; run again for the rest');
    expect(out.join('\n')).toMatch(/done: embedded 2, failed 0, 0 not on this machine; 1 pending/);
  });

  it('refuses bad arguments and a missing key', async () => {
    const err: string[] = [];
    expect(await embedImagesBackfill(['--limit', '0'], cli(null, [], err))).toBe(2);
    expect(await embedImagesBackfill(['--nope'], cli(null, [], err))).toBe(2);
    expect(await embedImagesBackfill([], cli(null, [], err, null))).toBe(1);
    expect(err.join('\n')).toMatch(/OPENROUTER_API_KEY is not set/);
  });

  it('--retry-failed retries a failed image without waiting for its backoff', async () => {
    const id = await photo({ r: 220, g: 20, b: 20 });
    const failing = new FakeImageEmbedder();
    failing.failNext(1);
    expect(await embedImagesBackfill([], cli(failing, [], []))).toBe(1);
    const healthy = new FakeImageEmbedder();
    const out1: string[] = [];
    expect(await embedImagesBackfill([], cli(healthy, out1, []))).toBe(0);
    expect(healthy.calls).toEqual([]);
    expect(out1.join('\n')).toMatch(/--retry-failed/);
    expect(await embedImagesBackfill(['--retry-failed'], cli(healthy, [], []))).toBe(0);
    expect((await row(id))?.has_vector).toBe(true);
  });
});
