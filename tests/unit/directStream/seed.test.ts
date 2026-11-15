import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { median, readSeedFile } from '../../../src/directStream/repo.js';
import { DEFAULT_SEED_FILE } from '../../../src/directStream/service.js';

describe('readSeedFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-seed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const seed = async (value: unknown): Promise<string> => {
    const file = path.join(dir, 'seed.json');
    await writeFile(file, JSON.stringify(value));
    return file;
  };

  it('reads entries and fills the defaults', async () => {
    expect(await readSeedFile(await seed([{ name: 'VidFast', movie: 'https://vidfast.pro/movie/{id}?autoPlay=true' }]))).toEqual([
      { name: 'VidFast', idKind: 'tmdb', movie: 'https://vidfast.pro/movie/{id}?autoPlay=true', tv: null, browserOnly: false, enSubtitle: null, notes: '' },
    ]);
  });

  it('refuses a repeated name, a template without {id} and a file that is not JSON', async () => {
    await expect(readSeedFile(await seed([{ name: 'A', movie: 'https://a/{id}' }, { name: 'A', movie: 'https://b/{id}' }]))).rejects.toThrow(/appears twice/);
    await expect(readSeedFile(await seed([{ name: 'A', movie: 'https://a/movie' }]))).rejects.toThrow(/\{id\}/);
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '[{');
    await expect(readSeedFile(broken)).rejects.toThrow(/not readable JSON/);
  });

  it('reads the checked-in seed: at least the 24 fmovies providers, each named once', async () => {
    expect(existsSync(DEFAULT_SEED_FILE)).toBe(true);
    const entries = await readSeedFile(DEFAULT_SEED_FILE);
    expect(entries.length).toBeGreaterThanOrEqual(24);
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
  });
});

describe('median', () => {
  it('is the middle value, or the mean of the two middle ones', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
