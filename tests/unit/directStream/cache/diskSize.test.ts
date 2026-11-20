import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamCacheRow } from '../../../../src/db/schema.js';
import type { DirectStreamRepo } from '../../../../src/directStream/repo.js';
import { StreamCache } from '../../../../src/directStream/cache/service.js';
import { CacheStore } from '../../../../src/directStream/cache/store.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function cacheWithPreviews(): Promise<{ root: string; files: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'notesd-cache-size-'));
  dirs.push(root);
  const folder = path.join(root, ID);
  await mkdir(path.join(folder, 'previews'), { recursive: true });
  const files = [path.join(folder, 'v-00001.ts'), path.join(folder, 'previews', 'sheet-00000.jpg'), path.join(folder, 'previews', 'previews.json')];
  await writeFile(files[0] ?? '', Buffer.alloc(40_000, 1));
  await writeFile(files[1] ?? '', Buffer.alloc(90_000, 2));
  await writeFile(files[2] ?? '', '{}');
  return { root, files };
}

const blocks = async (files: string[]): Promise<number> => {
  let total = 0;
  for (const f of files) {
    const s = await stat(f);
    total += s.blocks > 0 ? s.blocks * 512 : s.size;
  }
  return total;
};

describe('a cloud cache\'s seek previews on disk', () => {
  it('count in the cache\'s size on disk', async () => {
    const { root, files } = await cacheWithPreviews();
    const size = await new CacheStore(root).diskSize(ID);
    expect(size).toBe(await blocks(files));
    expect(size).toBeGreaterThan(await blocks(files.slice(0, 1)));
  });

  it('go with the cache when it is deleted, and count in the Cache page until then', async () => {
    const { root, files } = await cacheWithPreviews();
    const row = { id: ID, host: 'host-a', kind: 'movie', tmdbId: 550, season: null, episode: null, state: 'ready' } as unknown as StreamCacheRow;
    const repo = { cacheById: async () => row, caches: async () => [row], deleteCache: async () => undefined } as unknown as DirectStreamRepo;
    const cache = new StreamCache({ repo, host: 'host-a', root, resolve: async () => Promise.reject(new Error('unused')), log: () => undefined });
    expect(await cache.diskUsage()).toEqual([{ row, bytes: await blocks(files) }]);
    await cache.remove(ID);
    await expect(stat(path.join(root, ID))).rejects.toThrow();
  });
});
