import { lstat, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveInDataDir } from '../images/store.js';
import { isValidId } from '../notes/ids.js';
import { isSafeFileName } from './name.js';

/** Data-dir subfolder holding one folder per note that has files. */
export const FILES_SUBDIR = 'files';

function requireCanonicalNoteId(noteId: string): string {
  if (!isValidId(noteId)) throw new Error(`not a canonical note id: ${JSON.stringify(noteId)}`);
  return noteId;
}

/** `files/<noteId>/<safeName>`, forward slashes. Throws on a non-canonical id or an unsafe name. */
export function fileRelPath(noteId: string, safeName: string): string {
  requireCanonicalNoteId(noteId);
  if (!isSafeFileName(safeName)) throw new Error(`unsafe file name: ${JSON.stringify(safeName)}`);
  return `${FILES_SUBDIR}/${noteId}/${safeName}`;
}

/** True when `rel` is exactly `files/<noteId>/<one safe segment>`. */
export function isNoteFileRelPath(noteId: string, rel: string): boolean {
  if (!isValidId(noteId)) return false;
  const prefix = `${FILES_SUBDIR}/${noteId}/`;
  if (!rel.startsWith(prefix)) return false;
  return isSafeFileName(rel.slice(prefix.length));
}

/** Absolute `<dataDir>/files/<noteId>`: the folder the note-level reveal opens. */
export function filesDirFor(dataDir: string, noteId: string): string {
  requireCanonicalNoteId(noteId);
  return resolveInDataDir(dataDir, `${FILES_SUBDIR}/${noteId}`);
}

/**
 * Delete forever, on disk, one file of a purged note. Touches `rel` only when it is exactly
 * `files/<noteId>/<safe name>` and is a regular file or a symlink (never a directory). Returns
 * 1 when something was removed, 0 when it was missing or refused. Other errors propagate (the
 * service logs them and carries on).
 */
export async function removeNoteFile(dataDir: string, noteId: string, rel: string): Promise<number> {
  if (!isNoteFileRelPath(noteId, rel)) return 0;
  const dir = filesDirFor(dataDir, noteId);
  const abs = resolveInDataDir(dataDir, rel);
  if (path.dirname(abs) !== dir) return 0;
  try {
    const st = await lstat(abs);
    if (!st.isFile() && !st.isSymbolicLink()) return 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  await rm(abs, { force: true });
  return 1;
}

/** Removes `files/<noteId>/` when it is empty. False when it is missing, not empty or not a folder. */
export async function removeNoteFolderIfEmpty(dataDir: string, noteId: string): Promise<boolean> {
  const dir = filesDirFor(dataDir, noteId);
  try {
    await rmdir(dir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return false;
    throw err;
  }
}
