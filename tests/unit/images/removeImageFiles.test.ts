import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileExists, removeImageFiles } from '../../../src/images/store.js';
import { tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(async () => cleanup());

async function put(rel: string, text = 'x'): Promise<string> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text);
  return abs;
}

describe('removeImageFiles', () => {
  it('removes the original and every derived file, and nothing else', async () => {
    const original = await put('images/2026/10/A-B32.png');
    const sibling = await put('images/2026/10/C-D45.png');
    await put('cache/A-B32/thumb.webp');
    await put('cache/A-B32/display.jpg');
    const otherCache = await put('cache/C-D45/thumb.webp');

    const n = await removeImageFiles(dir, { id: 'A-B32', path: 'images/2026/10/A-B32.png' });

    expect(n).toBe(3);
    expect(await fileExists(original)).toBe(false);
    expect(await fileExists(sibling)).toBe(true);
    expect(await fileExists(otherCache)).toBe(true);
    expect(await readdir(path.join(dir, 'cache'))).toEqual(['C-D45']);
    // The month dir stays even if it were empty; only files go.
    expect(await readdir(path.join(dir, 'images/2026/10'))).toEqual(['C-D45.png']);
  });

  it('counts 0 for files that are already gone', async () => {
    expect(await removeImageFiles(dir, { id: 'A-B32', path: 'images/2026/10/A-B32.png' })).toBe(0);
  });

  it('never unlinks an original outside <dataDir>/images/', async () => {
    const inbox = await put('inbox/A-B32.png');
    const cacheFile = await put('cache/keep.png');
    const outside = await put('../outside-A-B32.png');
    try {
      expect(await removeImageFiles(dir, { id: 'Z-ZZ1', path: 'inbox/A-B32.png' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ2', path: 'cache/keep.png' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ3', path: '../outside-A-B32.png' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ4', path: outside })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ5', path: 'images' })).toBe(0);
      expect(await removeImageFiles(dir, { id: 'Z-ZZ6', path: 'images/../inbox/A-B32.png' })).toBe(0);
      expect(await fileExists(inbox)).toBe(true);
      expect(await fileExists(cacheFile)).toBe(true);
      expect(await fileExists(outside)).toBe(true);
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(outside, { force: true }));
    }
  });

  it('never removes the cache root or a dir outside it for a malformed id', async () => {
    const keep = await put('cache/A-B32/thumb.webp');
    for (const id of ['', '.', '..', '../cache', 'A-B32/..', 'x/y']) {
      expect(await removeImageFiles(dir, { id, path: 'images/none.png' })).toBe(0);
    }
    expect(await fileExists(keep)).toBe(true);
  });
});
