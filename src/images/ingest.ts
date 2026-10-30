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

/** ImageDeps for the running daemon (background.ts, phase 5's routes and MCP tools). */
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

/** Where an image note's original lives on this machine, and whether it is here. */
export type LocatedImage = ImageSource & {
  /** `image_path` as stored: relative to the data dir. */
  relPath: string;
  available: boolean;
  /** Host that ingested the file (`image_meta.host`). */
  host: string | null;
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
 * The bytes are already a note. Return it (restoring it when soft-deleted). If this machine
 * lacks the original (the note was ingested on another host), the identical bytes are put at
 * the note's image_path here. With move=true the source is consumed either way.
 */
async function reuseExisting(
  deps: ImageDeps,
  existing: ImageRecord,
  bytes: Uint8Array,
  sourcePath: string | null,
  move: boolean,
): Promise<IngestResult> {
  const abs = resolveInDataDir(deps.dataDir, existing.image_path);
  if (!(await fileExists(abs))) {
    await placeOriginal(abs, bytes, sourcePath, move);
  } else if (sourcePath !== null && move && path.resolve(sourcePath) !== abs) {
    await unlink(sourcePath).catch(() => undefined);
  }
  const note = existing.deleted_at !== null ? await deps.notes.restore(existing.id) : await deps.notes.getOne(existing.id);
  if (!note) throw new Error(`image note ${existing.id} vanished during ingest`);
  return { note, created: false };
}

/**
 * Store an image and create its note, or return the note that already holds these bytes.
 *
 * sha256 of the bytes -> a non-deleted match is returned unchanged (created: false); a
 * soft-deleted match is restored and returned (created: false). Otherwise: probe (mime by
 * magic bytes, size, EXIF taken_at), generate the id, write the original byte for byte to
 * images/YYYY/MM/<id>.<ext>, then create the note through the notes service. If the insert
 * fails the file is removed (or moved back to its source); NoteError('duplicate_image') is a
 * concurrent ingest of the same bytes (return the winner), NoteError('conflict') an id clash
 * (retry with a new id).
 *
 * Throws UnsupportedImageError (from probe.ts) for anything that is not a supported image.
 */
export async function ingestImage(deps: ImageDeps, input: IngestInput): Promise<IngestResult> {
  const sourcePath = input.path !== undefined ? path.resolve(input.path) : null;
  const move = sourcePath !== null && input.move === true;
  const bytes: Uint8Array = sourcePath !== null ? await readFile(sourcePath) : input.bytes!;
  const sha256 = sha256Hex(bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256(sha256);
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
          const winner = await deps.records.bySha256(sha256);
          if (winner && winner.deleted_at === null) return reuseExisting(deps, winner, bytes, sourcePath, move);
        }
      }
    }
    throw new Error(`could not allocate a free note id in ${MAX_ID_ATTEMPTS} attempts`);
  });
}

/** Locate an image note's original. null when the id is unknown or the note has no image. */
export async function locateImage(deps: Pick<ImageDeps, 'dataDir' | 'records'>, id: string): Promise<LocatedImage | null> {
  const rec = await deps.records.byId(id);
  if (!rec) return null;
  const originalPath = resolveInDataDir(deps.dataDir, rec.image_path);
  return {
    id: rec.id,
    mime: rec.image_meta.mime,
    originalPath,
    relPath: rec.image_path,
    available: await fileExists(originalPath),
    host: rec.image_meta.host ?? null,
    deleted: rec.deleted_at !== null,
    meta: rec.image_meta,
  };
}
