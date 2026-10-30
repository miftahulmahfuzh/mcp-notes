import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppDeps } from '../deps.js';
import type { NotesService } from '../notes/service.js';
import { NoteError, type ImageMeta, type Note, type Origin } from '../notes/types.js';
import type { ImageSource } from './derive.js';
import { probeImage, sha256Hex } from './probe.js';
import { dbImageRecords, type ImageRecord, type ImageRecords } from './records.js';
import {
  chooseExt,
  copyIntoNewFile,
  fileExists,
  moveIntoNewFile,
  originalRelPath,
  removeQuietly,
  resolveInDataDir,
  writeNewFile,
} from './store.js';

/** The slice of the notes service image ingestion uses. All writes go through it. */
export type ImageNotes = Pick<NotesService, 'create' | 'getOne' | 'restore' | 'newId'>;

export type ImageDeps = {
  dataDir: string;
  notes: ImageNotes;
  /** Raw image lookups (read-only). */
  records: ImageRecords;
  /** Defaults to os.hostname(). Tests override it. */
  hostname?: () => string;
  /** Defaults to new Date(). Decides images/YYYY/MM. */
  now?: () => Date;
};

/** ImageDeps for the running daemon (background.ts, the HTTP routes and MCP tools). */
export function imageDeps(app: AppDeps): ImageDeps {
  return { dataDir: app.config.dataDir, notes: app.service, records: dbImageRecords(app.db) };
}
type IngestCommon = {
  /** Name the file had on the user's side. Its extension (lower-cased) names the stored file. */
  originalName?: string | null;
  /** Note text. Defaults to ''. Hashtags in it become tags as for any note. */
  body?: string;
  origin?: Origin | null;
};

export type IngestInput =
  | (IngestCommon & { bytes: Uint8Array; path?: undefined; move?: undefined })
  | (IngestCommon & {
      path: string;
      bytes?: undefined;
      /** Rename the file into the store instead of copying it. On success the source is always consumed. */
      move?: boolean;
    });

export type IngestResult = { note: Note; created: boolean };

/** attachImage's result. attached: false = the bytes already live in `note` (this note or another). */
export type AttachResult = { note: Note; attached: boolean };

/** ImageNotes plus the one writer attaching needs. Kept separate so ImageNotes fakes stay valid. */
export type AttachNotes = ImageNotes & Pick<NotesService, 'attachImage'>;

export type AttachDeps = Omit<ImageDeps, 'notes'> & { notes: AttachNotes };

/** AttachDeps for the running daemon's HTTP routes. */
export function attachDeps(app: AppDeps): AttachDeps {
  return { ...imageDeps(app), notes: app.service };
}

/** Where one image's original lives on this machine, and whether it is here. `id` is the image id (keys cache/<id>/). */
export type LocatedImage = ImageSource & {
  noteId: string;
  position: number;
  /** `note_images.path` as stored: relative to the data dir. */
  relPath: string;
  available: boolean;
  /** Host that ingested the file. */
  host: string | null;
  /** The image was removed from its note (in the bin). */
  imageDeleted: boolean;
  /** The owning note is soft-deleted. */
  noteDeleted: boolean;
  /** imageDeleted || noteDeleted. */
  deleted: boolean;
  meta: ImageMeta;
};

const MAX_ID_ATTEMPTS = 5;

/** Serialises ingests of the same bytes inside this process (the DB index covers other hosts). */
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

/** Put a file's bytes at `dest` from wherever the caller's input lives. */
async function placeOriginal(dest: string, bytes: Uint8Array, sourcePath: string | null, move: boolean): Promise<void> {
  if (sourcePath === null) await writeNewFile(dest, bytes);
  else if (move) await moveIntoNewFile(sourcePath, dest);
  else await copyIntoNewFile(sourcePath, dest);
}

/** Undo placeOriginal after a failed insert: a moved source goes back where it was. */
async function unplaceOriginal(dest: string, sourcePath: string | null, move: boolean): Promise<void> {
  if (sourcePath !== null && move) {
    await moveIntoNewFile(dest, sourcePath).catch(() => removeQuietly(dest));
    return;
  }
  await removeQuietly(dest);
}

/**
 * The bytes are already a live image. Return the note that holds it (restoring the note when it
 * is soft-deleted). If this machine lacks the original (it was ingested on another host), the
 * identical bytes are put at the image's path here. With move=true the source is consumed either way.
 */
async function reuseExisting(
  deps: ImageDeps,
  existing: ImageRecord,
  bytes: Uint8Array,
  sourcePath: string | null,
  move: boolean,
): Promise<IngestResult> {
  const abs = resolveInDataDir(deps.dataDir, existing.path);
  if (!(await fileExists(abs))) {
    await placeOriginal(abs, bytes, sourcePath, move);
  } else if (sourcePath !== null && move && path.resolve(sourcePath) !== abs) {
    await unlink(sourcePath).catch(() => undefined);
  }
  const note =
    existing.note_deleted_at !== null ? await deps.notes.restore(existing.note_id) : await deps.notes.getOne(existing.note_id);
  if (!note) throw new Error(`note ${existing.note_id} holding image ${existing.id} vanished during ingest`);
  return { note, created: false };
}

/**
 * Store an image as a new note, or return the note that already holds these bytes.
 *
 * sha256 of the bytes -> a live image with them (deleted_at null) returns its note unchanged
 * (created: false), restoring the note first when it is soft-deleted. A removed image (in the bin)
 * does not count. Otherwise: probe (mime by magic bytes, size, EXIF taken_at), generate the id,
 * write the original byte for byte to images/YYYY/MM/<id>.<ext>, then create the note and its
 * first image (same id, position 0) through the notes service. If the insert fails the file is
 * removed (or moved back to its source); NoteError('duplicate_image') is a concurrent ingest of
 * the same bytes (return the winner), NoteError('conflict') an id clash (retry with a new id).
 *
 * Throws UnsupportedImageError (from probe.ts) for anything that is not a supported image.
 */
export async function ingestImage(deps: ImageDeps, input: IngestInput): Promise<IngestResult> {
  const sourcePath = input.path !== undefined ? path.resolve(input.path) : null;
  const move = sourcePath !== null && input.move === true;
  const bytes: Uint8Array = sourcePath !== null ? await readFile(sourcePath) : input.bytes!;
  const sha256 = sha256Hex(bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256Live(sha256);
    if (existing) return reuseExisting(deps, existing, bytes, sourcePath, move);

    const probe = await probeImage(bytes);
    const nameSource = input.originalName ?? (sourcePath !== null ? path.basename(sourcePath) : null);
    const originalName = nameSource ? path.basename(nameSource) : null;
    const ext = chooseExt(originalName, probe.mimeExt);
    const savedAt = (deps.now ?? (() => new Date()))();
    const meta: ImageMeta = {
      sha256,
      mime: probe.mime,
      width: probe.width,
      height: probe.height,
      bytes: bytes.byteLength,
      taken_at: probe.taken_at,
      original_name: originalName,
      host: (deps.hostname ?? os.hostname)(),
    };

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = await deps.notes.newId();
      const relPath = originalRelPath(id, ext, savedAt);
      const abs = resolveInDataDir(deps.dataDir, relPath);
      if (await fileExists(abs)) continue;
      await placeOriginal(abs, bytes, sourcePath, move);
      try {
        const note = await deps.notes.create({
          id,
          body: input.body ?? '',
          origin: input.origin ?? null,
          image: { path: relPath, meta },
          allowEmpty: true,
        });
        return { note, created: true };
      } catch (err) {
        await unplaceOriginal(abs, sourcePath, move);
        if (!(err instanceof NoteError) || (err.code !== 'duplicate_image' && err.code !== 'conflict')) throw err;
        if (err.code === 'duplicate_image') {
          // The live-image index covers deleted notes too: reuse the winner (restoring its note) instead of retrying.
          const winner = await deps.records.bySha256Live(sha256);
          if (winner) return reuseExisting(deps, winner, bytes, sourcePath, move);
        }
      }
    }
    throw new Error(`could not allocate a free note id in ${MAX_ID_ATTEMPTS} attempts`);
  });
}

/**
 * Add an image to an existing live note, or return the note that already holds these bytes.
 *
 * The target must be live (unknown -> NoteError('not_found'), deleted -> NoteError('deleted');
 * nothing is read or written then). Under the sha lock: a live image with the same sha256
 * anywhere -> that image's note is returned, restored if deleted (attached: false; nothing is
 * stored). Otherwise: probe, fresh image id (free in notes and note_images), write the original
 * byte for byte to images/YYYY/MM/<imageId>.<ext>, then attach through the notes service. If the
 * attach fails the file is removed (or moved back): NoteError('duplicate_image') is a concurrent
 * save of the same bytes (return the winner), NoteError('conflict') an id clash (retry).
 * `input.body` and `input.origin` are ignored: attaching never changes the note's text.
 *
 * Throws UnsupportedImageError (probe.ts) for anything that is not a supported image.
 */
export async function attachImage(deps: AttachDeps, noteIdInput: string, input: IngestInput): Promise<AttachResult> {
  const target = await deps.notes.getOne(noteIdInput, { includeDeleted: true });
  if (target === null) throw new NoteError('not_found', `Note ${noteIdInput} does not exist.`);
  if (target.deleted_at !== undefined) {
    throw new NoteError('deleted', `Note ${target.id} is deleted. Call restore("${target.id}") first if you want to attach to it.`);
  }

  const sourcePath = input.path !== undefined ? path.resolve(input.path) : null;
  const move = sourcePath !== null && input.move === true;
  const bytes: Uint8Array = sourcePath !== null ? await readFile(sourcePath) : input.bytes!;
  const sha256 = sha256Hex(bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256Live(sha256);
    if (existing) {
      const reused = await reuseExisting(deps, existing, bytes, sourcePath, move);
      return { note: reused.note, attached: false };
    }

    const probe = await probeImage(bytes);
    const nameSource = input.originalName ?? (sourcePath !== null ? path.basename(sourcePath) : null);
    const originalName = nameSource ? path.basename(nameSource) : null;
    const ext = chooseExt(originalName, probe.mimeExt);
    const savedAt = (deps.now ?? (() => new Date()))();
    const meta: ImageMeta = {
      sha256,
      mime: probe.mime,
      width: probe.width,
      height: probe.height,
      bytes: bytes.byteLength,
      taken_at: probe.taken_at,
      original_name: originalName,
      host: (deps.hostname ?? os.hostname)(),
    };

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const imageId = await deps.notes.newId();
      const relPath = originalRelPath(imageId, ext, savedAt);
      const abs = resolveInDataDir(deps.dataDir, relPath);
      if (await fileExists(abs)) continue;
      await placeOriginal(abs, bytes, sourcePath, move);
      try {
        const note = await deps.notes.attachImage(target.id, { id: imageId, path: relPath, meta });
        return { note, attached: true };
      } catch (err) {
        await unplaceOriginal(abs, sourcePath, move);
        if (!(err instanceof NoteError) || (err.code !== 'duplicate_image' && err.code !== 'conflict')) throw err;
        if (err.code === 'duplicate_image') {
          const winner = await deps.records.bySha256Live(sha256);
          if (winner) {
            const reused = await reuseExisting(deps, winner, bytes, sourcePath, move);
            return { note: reused.note, attached: false };
          }
        }
      }
    }
    throw new Error(`could not allocate a free image id in ${MAX_ID_ATTEMPTS} attempts`);
  });
}

async function located(dataDir: string, rec: ImageRecord): Promise<LocatedImage> {
  const originalPath = resolveInDataDir(dataDir, rec.path);
  const imageDeleted = rec.deleted_at !== null;
  const noteDeleted = rec.note_deleted_at !== null;
  return {
    id: rec.id,
    mime: rec.meta.mime,
    originalPath,
    noteId: rec.note_id,
    position: rec.position,
    relPath: rec.path,
    available: await fileExists(originalPath),
    host: rec.meta.host ?? null,
    imageDeleted,
    noteDeleted,
    deleted: imageDeleted || noteDeleted,
    meta: rec.meta,
  };
}

/** Locate one image's original by image id, in any state. null when the id is unknown. */
export async function locateImage(deps: Pick<ImageDeps, 'dataDir' | 'records'>, imageId: string): Promise<LocatedImage | null> {
  const rec = await deps.records.byImageId(imageId);
  return rec ? located(deps.dataDir, rec) : null;
}

/** Locate a note's first live image (the `/api/notes/:id/:variant` alias). null when it has none. */
export async function locateNoteImage(deps: Pick<ImageDeps, 'dataDir' | 'records'>, noteId: string): Promise<LocatedImage | null> {
  const rec = await deps.records.firstLiveImageOfNote(noteId);
  return rec ? located(deps.dataDir, rec) : null;
}
