import { readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  derivativePaths,
  getDisplay,
  getPreview,
  getThumb,
  OriginalMissingError,
  PREVIEW_LONG_EDGE,
  PREVIEW_MAX_BYTES,
  type ImageSource,
} from '../../../src/images/derive.js';
import { HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN, tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(async () => cleanup());

async function place(fixture: string, id: string, mime: string, ext: string): Promise<ImageSource> {
  const originalPath = path.join(dir, 'images/2026/10', `${id}.${ext}`);
  await mkdir(path.dirname(originalPath), { recursive: true });
  await copyFile(fixture, originalPath);
  return { id, mime, originalPath };
}

describe('getThumb', () => {
  it('writes cache/<id>/thumb.webp, never enlarged', async () => {
    const src = await place(PNG_PLAIN, 'P-0001', 'image/png', 'png');
    const out = await getThumb(dir, src);
    expect(out).toBe(derivativePaths(dir, 'P-0001').thumb);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(40);
  });

  it('scales wide images to 480 px', async () => {
    const originalPath = path.join(dir, 'images/2026/10/W-0001.jpg');
    await mkdir(path.dirname(originalPath), { recursive: true });
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#345' } })
      .jpeg()
      .toFile(originalPath);
    const out = await getThumb(dir, { id: 'W-0001', mime: 'image/jpeg', originalPath });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([480, 240]);
  });

  it('leaves the original byte-identical', async () => {
    const src = await place(JPEG_EXIF, 'J-0001', 'image/jpeg', 'jpg');
    const before = await readFile(src.originalPath);
    await getThumb(dir, src);
    await getPreview(dir, src);
    expect(Buffer.compare(await readFile(src.originalPath), before)).toBe(0);
  });

  it('throws OriginalMissingError when the original is not here', async () => {
    const src = { id: 'G-0001', mime: 'image/jpeg', originalPath: path.join(dir, 'images/nope.jpg') };
    await expect(getThumb(dir, src)).rejects.toBeInstanceOf(OriginalMissingError);
  });
});

describe('getPreview', () => {
  it('caps the long edge at 1568 and stays under the byte budget', async () => {
    const originalPath = path.join(dir, 'images/2026/10/B-0001.png');
    await mkdir(path.dirname(originalPath), { recursive: true });
    const noise = Buffer.alloc(3000 * 2000 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    await sharp(noise, { raw: { width: 3000, height: 2000, channels: 3 } }).png().toFile(originalPath);
    const out = await getPreview(dir, { id: 'B-0001', mime: 'image/png', originalPath });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(PREVIEW_LONG_EDGE);
    expect((await stat(out)).size).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
  });

  it('regenerates after the cache is wiped', async () => {
    const src = await place(JPEG_EXIF, 'R-0001', 'image/jpeg', 'jpg');
    const first = await getPreview(dir, src);
    await rm(path.join(dir, 'cache'), { recursive: true, force: true });
    const second = await getPreview(dir, src);
    expect(second).toBe(first);
    expect((await stat(second)).size).toBeGreaterThan(0);
  });

  it('concurrent requests share one generation', async () => {
    const src = await place(JPEG_EXIF, 'C-0001', 'image/jpeg', 'jpg');
    const outs = await Promise.all(Array.from({ length: 8 }, () => getPreview(dir, src)));
    expect(new Set(outs).size).toBe(1);
    const leftovers = readdirSync(path.dirname(outs[0]!)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect((await sharp(outs[0]!).metadata()).format).toBe('jpeg');
  });
});

describe('getDisplay', () => {
  it('returns the original for browser-displayable formats', async () => {
    const src = await place(JPEG_EXIF, 'D-0001', 'image/jpeg', 'jpg');
    expect(await getDisplay(dir, src)).toEqual({ path: src.originalPath, mime: 'image/jpeg' });
  });

  it('HEIC gets a full-resolution display.jpg, and thumb/preview derive from it', async () => {
    const src = await place(HEIC_PHOTO, 'H-0001', 'image/heic', 'heic');
    const display = await getDisplay(dir, src);
    expect(display).toEqual({ path: derivativePaths(dir, 'H-0001').display, mime: 'image/jpeg' });
    const meta = await sharp(display.path).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 64, 48]);
    expect((await sharp(await getThumb(dir, src)).metadata()).format).toBe('webp');
    expect((await sharp(await getPreview(dir, src)).metadata()).format).toBe('jpeg');
  });

  it('TIFF gets a display.jpg through sharp', async () => {
    const originalPath = path.join(dir, 'images/2026/10/T-0001.tif');
    await mkdir(path.dirname(originalPath), { recursive: true });
    await writeFile(
      originalPath,
      await sharp({ create: { width: 20, height: 10, channels: 3, background: '#f00' } }).tiff().toBuffer(),
    );
    const display = await getDisplay(dir, { id: 'T-0001', mime: 'image/tiff', originalPath });
    expect(display.mime).toBe('image/jpeg');
    expect((await sharp(display.path).metadata()).width).toBe(20);
  });
});
