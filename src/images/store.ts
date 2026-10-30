import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DataDirs = {
  root: string;
  images: string;
  cache: string;
  inbox: string;
  failed: string;
};

export function dataDirs(dataDir: string): DataDirs {
  const root = path.resolve(dataDir);
  return {
    root,
    images: path.join(root, 'images'),
    cache: path.join(root, 'cache'),
    inbox: path.join(root, 'inbox'),
    failed: path.join(root, 'inbox', 'failed'),
  };
}

/** Create images/, cache/, inbox/ and inbox/failed/ under the data dir if missing. */
export async function ensureDataDirs(dataDir: string): Promise<DataDirs> {
  const dirs = dataDirs(dataDir);
  for (const d of [dirs.images, dirs.cache, dirs.failed]) await mkdir(d, { recursive: true });
  return dirs;
}

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

/** Extension of the stored original: the original filename's, lower-cased, else the mime's. */
export function chooseExt(originalName: string | null | undefined, mimeExt: string): string {
  if (originalName) {
    const ext = path.extname(originalName).slice(1).toLowerCase();
    if (SAFE_EXT.test(ext)) return ext;
  }
  return mimeExt.toLowerCase();
}

/** `images/YYYY/MM/<id>.<ext>`, forward slashes, YYYY/MM in process-local time of `savedAt`. */
export function originalRelPath(id: string, ext: string, savedAt: Date): string {
  const yyyy = String(savedAt.getFullYear()).padStart(4, '0');
  const mm = String(savedAt.getMonth() + 1).padStart(2, '0');
  return `images/${yyyy}/${mm}/${id}.${ext}`;
}

/** Absolute path of a data-dir-relative path. Refuses anything that escapes the data dir. */
export function resolveInDataDir(dataDir: string, rel: string): string {
  const root = path.resolve(dataDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the data dir: ${rel}`);
  }
  return abs;
}

/** `cache/<imageId>/`: derivatives of one image. */
export function cacheDirFor(dataDir: string, id: string): string {
  return path.join(dataDirs(dataDir).cache, id);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function removeQuietly(p: string): Promise<void> {
  await rm(p, { force: true, recursive: true }).catch(() => undefined);
}

export class DestinationExistsError extends Error {
  constructor(dest: string) {
    super(`refusing to overwrite existing file ${dest}`);
    this.name = 'DestinationExistsError';
  }
}

function tmpSibling(dest: string): string {
  return `${dest}.${process.pid}.${randomUUID()}.tmp`;
}

async function prepareDest(dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  if (await fileExists(dest)) throw new DestinationExistsError(dest);
}

/** Write bytes byte for byte to a new file: temp sibling, then rename, so no reader sees a partial file. */
export async function writeNewFile(dest: string, bytes: Uint8Array): Promise<void> {
  await prepareDest(dest);
  const tmp = tmpSibling(dest);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, dest);
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}

/** Copy a file to a new destination (source untouched). */
export async function copyIntoNewFile(src: string, dest: string): Promise<void> {
  await prepareDest(dest);
  const tmp = tmpSibling(dest);
  try {
    await copyFile(src, tmp);
    await rename(tmp, dest);
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}

export type MoveFs = {
  rename: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
};

const realMoveFs: MoveFs = { rename, unlink };

/**
 * Move a file to a new destination. rename() when on the same filesystem; on EXDEV
 * (inbox on another mount) copy to a temp sibling, rename into place, then unlink the source.
 */
export async function moveIntoNewFile(src: string, dest: string, fs: MoveFs = realMoveFs): Promise<void> {
  await prepareDest(dest);
  try {
    await fs.rename(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await copyIntoNewFile(src, dest);
  await fs.unlink(src);
}
