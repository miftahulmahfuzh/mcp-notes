import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DirectStreamRepo } from '../../../../src/directStream/repo.js';
import { AUTO_CACHE_KEEP_MS, StreamCache } from '../../../../src/directStream/cache/service.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const ROW = 'aaaaaaaa-0000-4000-8000-000000000001';
const OLD = 'bbbbbbbb-0000-4000-8000-000000000002';
const YOUNG = 'cccccccc-0000-4000-8000-000000000003';
const WRITTEN = 'dddddddd-0000-4000-8000-000000000004';
const OLDER = AUTO_CACHE_KEEP_MS + 60_000;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A cache root with one folder per name, each holding one segment, last written `ageMs` ago. */
async function rootWith(folders: Record<string, number>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'notesd-cache-sweep-'));
  dirs.push(root);
  for (const [name, ageMs] of Object.entries(folders)) {
    const dir = path.join(root, name);
    await mkdir(dir);
    await writeFile(path.join(dir, 'v-00001.ts'), 'x');
    await utimes(path.join(dir, 'v-00001.ts'), ago(ageMs), ago(ageMs));
    await utimes(dir, ago(ageMs), ago(ageMs));
  }
  return root;
}

function cacheOn(root: string, options: { sweepOrphans?: boolean } = {}) {
  const logged: string[] = [];
  const repo = { staleAutoCaches: async () => [], unfinishedCaches: async () => [], caches: async () => [{ id: ROW }] } as unknown as DirectStreamRepo;
  const cache = new StreamCache({ repo, host: 'host-a', root, resolve: async () => Promise.reject(new Error('unused')), now: () => NOW, log: (line) => void logged.push(line), ...options });
  return { cache, logged };
}

describe('cache folders no row names', () => {
  it('a daemon start deletes the ones nothing wrote to for three days, and nothing else', async () => {
    const root = await rootWith({ [ROW]: OLDER, [OLD]: OLDER, [YOUNG]: AUTO_CACHE_KEEP_MS - 60_000, [WRITTEN]: OLDER, 'not-a-cache': OLDER });
    // An old folder a file was written to yesterday is still someone's.
    await utimes(path.join(root, WRITTEN, 'v-00001.ts'), ago(86_400_000), ago(86_400_000));
    await writeFile(path.join(root, 'notes.txt'), 'a file beside the folders');

    const { cache, logged } = cacheOn(root);
    expect(await cache.start()).toBe(0);
    expect((await readdir(root)).sort()).toEqual([ROW, YOUNG, WRITTEN, 'not-a-cache', 'notes.txt'].sort());
    expect(logged).toEqual([`[notesd] stream cache: deleted the folder ${OLD}: no cache names it, and nothing wrote to it for three days`]);
    expect(await cache.sweepOrphans()).toBe(0);
  });

  it('sweeps nothing while rows of this host may still arrive (the import is not merged), or with no cache folder at all', async () => {
    const root = await rootWith({ [OLD]: OLDER });
    const { cache, logged } = cacheOn(root, { sweepOrphans: false });
    await cache.start();
    expect(await readdir(root)).toEqual([OLD]);
    expect(logged).toEqual([]);
    expect(await cacheOn(path.join(root, 'missing')).cache.sweepOrphans()).toBe(0);
  });
});
