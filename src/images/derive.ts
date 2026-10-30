import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { decodeHeicToJpeg, isBrowserDisplayable, isHeifMime } from './probe.js';
import { cacheDirFor, fileExists, removeQuietly } from './store.js';

export const THUMB_WIDTH = 480;
export const PREVIEW_LONG_EDGE = 1568;
/**
 * Claude rejects images over 5 MB. MCP image content is base64 (4/3 inflation), so the raw
 * JPEG budget is 3.75 MB: its base64 stays under 5,000,000 bytes.
 */
export const PREVIEW_MAX_BYTES = 3_750_000;
const PREVIEW_QUALITIES = [85, 75, 65, 50, 35] as const;
const DISPLAY_QUALITY = 92;

/** What the derivative getters need to know about one image. */
export type ImageSource = {
  /** Image id; names the cache dir `cache/<id>/` (a note's first image shares the note's id). */
  id: string;
  mime: string;
  /** Absolute path of the original. */
  originalPath: string;
};

export type DerivativePaths = { dir: string; thumb: string; preview: string; display: string };

export function derivativePaths(dataDir: string, id: string): DerivativePaths {
  const dir = cacheDirFor(dataDir, id);
  return {
    dir,
    thumb: path.join(dir, 'thumb.webp'),
    preview: path.join(dir, 'preview.jpg'),
    display: path.join(dir, 'display.jpg'),
  };
}

export class OriginalMissingError extends Error {
  readonly id: string;
  constructor(id: string, originalPath: string) {
    super(`original of ${id} is not on this machine (${originalPath})`);
    this.name = 'OriginalMissingError';
    this.id = id;
  }
}

/** One generation per output path at a time; concurrent callers share the promise. */
const inFlight = new Map<string, Promise<string>>();

async function nonEmptyFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function ensureDerivative(out: string, make: (tmp: string) => Promise<void>): Promise<string> {
  const running = inFlight.get(out);
  if (running) return running;
  const job = (async () => {
    if (await nonEmptyFile(out)) return out;
    await mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await make(tmp);
      await rename(tmp, out);
    } catch (err) {
      await removeQuietly(tmp);
      throw err;
    }
    return out;
  })().finally(() => inFlight.delete(out));
  inFlight.set(out, job);
  return job;
}

async function assertOriginal(src: ImageSource): Promise<void> {
  if (!(await fileExists(src.originalPath))) throw new OriginalMissingError(src.id, src.originalPath);
}

async function isHevc(originalPath: string): Promise<boolean> {
  try {
    const meta = await sharp(originalPath).metadata();
    return meta.compression === 'hevc';
  } catch {
    return true;
  }
}

/**
 * The browser-viewable full-resolution file: the original itself for JPEG/PNG/GIF/WebP/AVIF,
 * else `cache/<id>/display.jpg` (HEIC/HEIF/TIFF), generated on first request.
 */
export async function getDisplay(dataDir: string, src: ImageSource): Promise<{ path: string; mime: string }> {
  await assertOriginal(src);
  if (isBrowserDisplayable(src.mime)) return { path: src.originalPath, mime: src.mime };
  const out = derivativePaths(dataDir, src.id).display;
  const file = await ensureDerivative(out, async (tmp) => {
    if (isHeifMime(src.mime) && (await isHevc(src.originalPath))) {
      await writeFile(tmp, await decodeHeicToJpeg(await readFile(src.originalPath), DISPLAY_QUALITY / 100));
      return;
    }
    await sharp(src.originalPath, { failOn: 'none' })
      .rotate()
      .jpeg({ quality: DISPLAY_QUALITY, mozjpeg: true })
      .toFile(tmp);
  });
  return { path: file, mime: 'image/jpeg' };
}

/** A sharp pipeline over decodable pixels: the original, or display.jpg when sharp cannot decode it. */
async function decodable(dataDir: string, src: ImageSource): Promise<Sharp> {
  if (isBrowserDisplayable(src.mime)) return sharp(src.originalPath, { failOn: 'none' }).rotate();
  const display = await getDisplay(dataDir, src);
  return sharp(display.path, { failOn: 'none' }).rotate();
}

/** `cache/<id>/thumb.webp`: 480 px wide (never enlarged), WebP. */
export async function getThumb(dataDir: string, src: ImageSource): Promise<string> {
  await assertOriginal(src);
  const out = derivativePaths(dataDir, src.id).thumb;
  return ensureDerivative(out, async (tmp) => {
    const img = await decodable(dataDir, src);
    await img.resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toFile(tmp);
  });
}

/** `cache/<id>/preview.jpg`: long edge <= 1568 px, JPEG, under PREVIEW_MAX_BYTES. What Claude sees. */
export async function getPreview(dataDir: string, src: ImageSource): Promise<string> {
  await assertOriginal(src);
  const out = derivativePaths(dataDir, src.id).preview;
  return ensureDerivative(out, async (tmp) => {
    const img = await decodable(dataDir, src);
    const resized = await img
      .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toBuffer();
    let jpeg: Buffer | null = null;
    for (const quality of PREVIEW_QUALITIES) {
      jpeg = await sharp(resized).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (jpeg.length <= PREVIEW_MAX_BYTES) break;
    }
    if (!jpeg || jpeg.length > PREVIEW_MAX_BYTES) {
      throw new Error(`preview of ${src.id} stays over ${PREVIEW_MAX_BYTES} bytes`);
    }
    await writeFile(tmp, jpeg);
  });
}
