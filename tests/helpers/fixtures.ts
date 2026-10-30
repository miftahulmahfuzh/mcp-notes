import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/images');

/** 64x48 JPEG, EXIF DateTimeOriginal 2024:10:30 14:05:09, no offset. */
export const JPEG_EXIF = path.join(FIXTURES_DIR, 'exif.jpg');
/** 40x30 PNG, no EXIF. */
export const PNG_PLAIN = path.join(FIXTURES_DIR, 'plain.png');
/** 64x48 HEVC-coded HEIC (libheif/x265), EXIF DateTimeOriginal 2024:10:30 14:05:09. */
export const HEIC_PHOTO = path.join(FIXTURES_DIR, 'photo.heic');

export function fixtureBytes(p: string): Promise<Buffer> {
  return readFile(p);
}

export async function tempDir(prefix = 'mcp-notes-img-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
