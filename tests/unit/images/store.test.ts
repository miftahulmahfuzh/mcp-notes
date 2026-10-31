import { statSync } from 'node:fs';
import { readFile, unlink as fsUnlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseExt,
  DestinationExistsError,
  ensureDataDirs,
  fileExists,
  moveIntoNewFile,
  originalRelPath,
  resolveInDataDir,
  writeNewFile,
} from '../../../src/images/store.js';
import { tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(async () => cleanup());

describe('paths', () => {
  it('chooseExt prefers the original filename, lower-cased', () => {
    expect(chooseExt('IMG_0001.HEIC', 'heic')).toBe('heic');
    expect(chooseExt('photo.JPEG', 'jpg')).toBe('jpeg');
    expect(chooseExt('noext', 'png')).toBe('png');
    expect(chooseExt(null, 'png')).toBe('png');
    expect(chooseExt('weird.<script>', 'gif')).toBe('gif');
  });
  it('originalRelPath uses local YYYY/MM of the save time', () => {
    expect(originalRelPath('A-B32', 'jpg', new Date(2026, 0, 5, 10))).toBe('images/2026/01/A-B32.jpg');
  });
  it('resolveInDataDir refuses escapes', () => {
    expect(resolveInDataDir(dir, 'images/2026/01/A-B32.jpg')).toBe(path.join(dir, 'images/2026/01/A-B32.jpg'));
    expect(() => resolveInDataDir(dir, '../etc/passwd')).toThrow(/escapes/);
  });
  it('ensureDataDirs creates the layout', async () => {
    const dirs = await ensureDataDirs(dir);
    for (const d of [dirs.images, dirs.cache, dirs.inbox, dirs.failed, dirs.chatImages]) {
      expect(statSync(d).isDirectory()).toBe(true);
    }
    expect(dirs.chatImages).toBe(path.join(path.resolve(dir), 'chat-images'));
  });
});

describe('writes', () => {
  it('writeNewFile is byte-exact and refuses to overwrite', async () => {
    const dest = path.join(dir, 'a/b/c.bin');
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    await writeNewFile(dest, bytes);
    expect(Buffer.compare(await readFile(dest), bytes)).toBe(0);
    await expect(writeNewFile(dest, Buffer.from('x'))).rejects.toBeInstanceOf(DestinationExistsError);
  });

  it('moveIntoNewFile renames on the same filesystem', async () => {
    const src = path.join(dir, 'src.bin');
    await writeFile(src, 'payload');
    const dest = path.join(dir, 'x/dest.bin');
    await moveIntoNewFile(src, dest);
    expect(await fileExists(src)).toBe(false);
    expect(await readFile(dest, 'utf8')).toBe('payload');
  });

  it('moveIntoNewFile falls back to copy + unlink on EXDEV', async () => {
    const src = path.join(dir, 'src.bin');
    await writeFile(src, 'cross-device');
    const dest = path.join(dir, 'y/dest.bin');
    const unlink = vi.fn((p: string) => fsUnlink(p));
    const rename = vi.fn(async () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });
    await moveIntoNewFile(src, dest, { rename, unlink });
    expect(rename).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledWith(src);
    expect(await readFile(dest, 'utf8')).toBe('cross-device');
    expect(await fileExists(src)).toBe(false);
  });
});
