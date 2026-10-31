import { lstat } from 'node:fs/promises';
import os from 'node:os';
import type { AppDeps } from '../deps.js';
import { attachDeps, attachImage, type AttachDeps } from '../images/ingest.js';
import { sha256Hex, sniffImageBytes, UnsupportedImageError } from '../images/probe.js';
import { DestinationExistsError, fileExists, removeQuietly, resolveInDataDir, writeNewFile } from '../images/store.js';
import type { NotesService } from '../notes/service.js';
import { NoteError, type FileMeta, type Note } from '../notes/types.js';
import { detectFileMime } from './mime.js';
import { displayFileName, sanitizeFileName, withNameSuffix } from './name.js';
import { dbFileRecords, type FileRecord, type FileRecords } from './records.js';
import { fileRelPath } from './store.js';

/** Upload cap for one file, the same as for images. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** `name (2).ext` ... `name (999).ext`, then give up. */
export const MAX_NAME_SUFFIX = 999;
const MAX_ATTEMPTS = 5;

export type FileInputErrorCode = 'empty_file' | 'too_large';

export class FileInputError extends Error {
  constructor(
    readonly code: FileInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileInputError';
  }
}

/** The slice of the notes service file ingestion uses. All writes go through it. */
export type FileNotes = Pick<NotesService, 'getOne' | 'restore' | 'newId' | 'attachFile'>;

export type FileDeps = {
  dataDir: string;
  notes: FileNotes;
  records: FileRecords;
  /** Defaults to os.hostname(). Tests override it. */
  hostname?: () => string;
};

/** FileDeps for the running daemon (HTTP routes and reveal). */
export function fileDeps(app: AppDeps): FileDeps {
  return { dataDir: app.config.dataDir, notes: app.service, records: dbFileRecords(app.db) };
}

/** What POST /api/notes/:id/files needs: the file store, and the image store for sniffed images. */
export type UploadDeps = { files: FileDeps; images: AttachDeps };

export function uploadDeps(app: AppDeps): UploadDeps {
  return { files: fileDeps(app), images: attachDeps(app) };
}

export type FileInput = {
  bytes: Uint8Array;
  /** The name the file had on the user's side (any path is cut to its basename). */
  originalName: string | null;
};

/** attachFile's result. attached: false = the bytes already live in `note` (this note or another). */
export type FileAttachResult = { note: Note; attached: boolean };

/** attachUpload's result: where the bytes went. 'image' = stored through attachImage (in note.images). */
export type UploadAttachResult = FileAttachResult & { kind: 'file' | 'image' };

/** Where one file lives on this machine, and whether it is here. Satisfies reveal's RevealTarget. */
export type LocatedFile = {
  id: string;
  noteId: string;
  /** Absolute path under this machine's data dir. */
  originalPath: string;
  relPath: string;
  available: boolean;
  host: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  originalName: string;
  fileDeleted: boolean;
  noteDeleted: boolean;
};

/** Serialises attaches of the same bytes inside this process (the DB index covers other hosts). */
const shaLocks = new Map<string, Promise<unknown>>();

async function withShaLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const prev = shaLocks.get(sha256) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  shaLocks.set(sha256, tail);
  try {
    return await run;
  } finally {
    if (shaLocks.get(sha256) === tail) shaLocks.delete(sha256);
  }
}

/** True when anything (file, folder, link) sits at `abs`. */
async function occupied(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bytes already live in a file. Return the note that holds it (restoring the note when it is
 * soft-deleted). If this machine lacks the bytes (stored on another host), they are written to
 * the holder's path here.
 */
async function reuseExisting(deps: FileDeps, existing: FileRecord, bytes: Uint8Array): Promise<FileAttachResult> {
  const abs = resolveInDataDir(deps.dataDir, existing.path);
  if (!(await fileExists(abs))) {
    try {
      await writeNewFile(abs, bytes);
    } catch (err) {
      if (!(err instanceof DestinationExistsError)) throw err;
    }
  }
  const note =
    existing.note_deleted_at !== null ? await deps.notes.restore(existing.note_id) : await deps.notes.getOne(existing.note_id);
  if (!note) throw new Error(`note ${existing.note_id} holding file ${existing.id} vanished during attach`);
  return { note, attached: false };
}

/** The first `files/<noteId>/<name>` that nothing occupies on disk and no row (any host) uses. */
async function freeRelPath(deps: FileDeps, noteId: string, safeName: string): Promise<{ rel: string; abs: string }> {
  for (let k = 1; k <= MAX_NAME_SUFFIX; k += 1) {
    const rel = fileRelPath(noteId, withNameSuffix(safeName, k));
    const abs = resolveInDataDir(deps.dataDir, rel);
    if (await occupied(abs)) continue;
    if (await deps.records.pathTaken(rel)) continue;
    return { rel, abs };
  }
  throw new Error(`no free file name for ${safeName} in note ${noteId} after ${MAX_NAME_SUFFIX} tries`);
}

/**
 * Add one non-image file to an existing live note, or return the note that already holds these
 * bytes.
 *
 * The target must be live (unknown -> NoteError('not_found'), deleted -> NoteError('deleted');
 * nothing is written then). Empty bytes -> FileInputError('empty_file'). Under the sha lock: a
 * live file with the same sha256 anywhere -> that file's note is returned, restored if deleted
 * (attached: false; nothing new is stored). Otherwise: Windows-safe name, mime, a fresh id (free
 * in notes, note_images and note_files), the first free `files/<noteId>/<name>` (`name (2).ext`
 * on a clash), the bytes written byte for byte, then the row through the notes service. If that
 * fails the bytes are removed; NoteError('duplicate_file') is a concurrent save of the same bytes
 * (return the winner), NoteError('conflict') an id or name clash (retry).
 */
export async function attachFile(deps: FileDeps, noteIdInput: string, input: FileInput): Promise<FileAttachResult> {
  const target = await deps.notes.getOne(noteIdInput, { includeDeleted: true });
  if (target === null) throw new NoteError('not_found', `Note ${noteIdInput} does not exist.`);
  if (target.deleted_at !== undefined) {
    throw new NoteError('deleted', `Note ${target.id} is deleted. Restore it first if you want to attach to it.`);
  }
  if (input.bytes.byteLength === 0) throw new FileInputError('empty_file', 'the file is empty');
  const sha256 = sha256Hex(input.bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256Live(sha256);
    if (existing) return reuseExisting(deps, existing, input.bytes);

    const safeName = sanitizeFileName(input.originalName);
    const meta: FileMeta = {
      sha256,
      mime: await detectFileMime(input.bytes, safeName),
      bytes: input.bytes.byteLength,
      original_name: displayFileName(input.originalName, safeName),
      host: (deps.hostname ?? os.hostname)(),
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const fileId = await deps.notes.newId();
      const { rel, abs } = await freeRelPath(deps, target.id, safeName);
      try {
        await writeNewFile(abs, input.bytes);
      } catch (err) {
        if (err instanceof DestinationExistsError) continue;
        throw err;
      }
      try {
        const note = await deps.notes.attachFile(target.id, { id: fileId, path: rel, meta });
        return { note, attached: true };
      } catch (err) {
        await removeQuietly(abs);
        if (!(err instanceof NoteError) || (err.code !== 'duplicate_file' && err.code !== 'conflict')) throw err;
        if (err.code === 'duplicate_file') {
          const winner = await deps.records.bySha256Live(sha256);
          if (winner) return reuseExisting(deps, winner, input.bytes);
        }
      }
    }
    throw new Error(`could not attach the file in ${MAX_ATTEMPTS} attempts`);
  });
}

/**
 * HTTP POST /api/notes/:id/files: any file from the multipart form. Empty -> FileInputError
 * ('empty_file'); over `maxBytes` -> FileInputError('too_large'). Bytes that sniff as a supported
 * image go to the image store (attachImage, kind 'image'); if the image probe then refuses them
 * (corrupt picture) they are stored as a file instead. Everything else is attachFile (kind 'file').
 */
export async function attachUpload(
  deps: UploadDeps,
  noteId: string,
  file: File,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<UploadAttachResult> {
  if (file.size === 0) throw new FileInputError('empty_file', 'the uploaded file is empty');
  if (file.size > maxBytes) {
    throw new FileInputError('too_large', `file is ${file.size} bytes; the limit is ${maxBytes}`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const name = file.name !== '' ? file.name : null;
  if ((await sniffImageBytes(bytes)) !== null) {
    try {
      const result = await attachImage(deps.images, noteId, { bytes, originalName: name ?? 'upload' });
      return { ...result, kind: 'image' };
    } catch (err) {
      if (!(err instanceof UnsupportedImageError)) throw err;
    }
  }
  const result = await attachFile(deps.files, noteId, { bytes, originalName: name });
  return { ...result, kind: 'file' };
}

/** One file by id (any spelling), in any state, with whether its bytes are on this machine. null when unknown. */
export async function locateFile(deps: Pick<FileDeps, 'dataDir' | 'records'>, fileId: string): Promise<LocatedFile | null> {
  const rec = await deps.records.byFileId(fileId);
  if (rec === null) return null;
  const originalPath = resolveInDataDir(deps.dataDir, rec.path);
  return {
    id: rec.id,
    noteId: rec.note_id,
    originalPath,
    relPath: rec.path,
    available: await fileExists(originalPath),
    host: rec.host,
    mime: rec.mime,
    bytes: rec.bytes,
    sha256: rec.sha256,
    originalName: rec.original_name,
    fileDeleted: rec.deleted_at !== null,
    noteDeleted: rec.note_deleted_at !== null,
  };
}
