import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ExtractionStatus, NoteFileRow, NoteImageRow, notes } from '../db/schema.js';

/** Where a note was saved from. Every field is optional; unknown keys are dropped. */
export interface Origin {
  cwd?: string | undefined;
  repo?: string | undefined;
  claude_session?: string | undefined;
  /** Free-form channel, e.g. 'mcp', 'web', 'inbox', 'upload'. */
  source?: string | undefined;
}

/** Image metadata as ingest probes it (also the legacy `notes.image_meta` shape). */
export type { ImageMeta } from '../db/schema.js';

/** Where a file's text extraction stands. v1 only ever writes 'none'. */
export type { ExtractionStatus } from '../db/schema.js';

/** One image of a note, as MCP, HTTP and the UI see it (iteration 7: a note holds several). */
export interface NoteImage {
  /** Image id, note-id format. A note's first image shares the note's id. */
  id: string;
  note_id: string;
  /** Attach order within the note; never renumbered. */
  position: number;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** EXIF taken time, ISO 8601 UTC, or null. */
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  /** The original file exists under this machine's data dir. */
  available: boolean;
  /** Served by image id: `/api/images/<id>/<variant>`. */
  urls: { thumb: string; display: string; original: string; preview: string };
  /** Present only on removed images (bin listings). */
  deleted_at?: string;
}

/** What ingest knows about one non-image file before it becomes a `note_files` row. */
export interface FileMeta {
  /** Lower-case hex sha256 of the bytes. */
  sha256: string;
  mime: string;
  bytes: number;
  /** The user's file name, control characters removed (src/files/name.ts displayFileName). */
  original_name: string;
  /** `os.hostname()` of the machine that stored it. */
  host: string | null;
}

/** One non-image file of a note, as MCP, HTTP and the UI see it (plan phase 4). */
export interface NoteFile {
  /** File id, note-id format; never equal to any note or image id. */
  id: string;
  note_id: string;
  /** Attach order within the note; never renumbered. */
  position: number;
  /** The user's file name. The stored name may differ (Windows-safe, collision-suffixed). */
  name: string;
  mime: string;
  bytes: number;
  host: string | null;
  /** The file exists under this machine's data dir. */
  available: boolean;
  /** Always 'none' in v1: nobody has read the file's text. */
  extraction_status: ExtractionStatus;
  /** `/api/files/<id>/download`: always served as an attachment. */
  urls: { download: string };
  /** Present only on removed files. */
  deleted_at?: string;
}

/** Wire shape shared by MCP, HTTP and the UI. */
export interface Note {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  origin: Origin | null;
  /** The note's live images (image deleted_at is null), ascending position. Empty for text notes. */
  images: NoteImage[];
  /** The note's live files (file deleted_at is null), ascending position. Empty when it has none. */
  files: NoteFile[];
}

export type NoteRow = typeof notes.$inferSelect;

export interface Revision {
  revision: number;
  note_id: string;
  body: string;
  saved_at: string;
}

export interface TagCount {
  tag: string;
  count: number;
  last_used: string;
}

/** One neighbour returned by `related`. similarity = 1 - cosine distance, rounded to 4 decimals. */
export interface RelatedNote {
  note: Note;
  similarity: number;
}

/** Result of `related`: the source note's canonical id and its neighbours, most similar first. */
export interface RelatedResult {
  note_id: string;
  related: RelatedNote[];
}

export interface NotePage {
  notes: Note[];
  next_cursor: string | null;
}

/** 'hybrid': full text + meaning + tags + recency. 'text': full-text ranking only (pre-iteration-6). */
export type SearchMode = 'hybrid' | 'text';

/** `search` result: a NotePage plus which ranking produced it. */
export interface SearchPage extends NotePage {
  /** The ranking actually used. 'text' when asked for, or when hybrid had to fall back. */
  mode: SearchMode;
  /** Present only when hybrid was asked for but could not run; says why, in a sentence for the user. */
  fallback?: string;
}

/**
 * One tile of the bin's image grid.
 * 'note': an image (not itself removed) of a deleted note; restore / delete forever act on the note.
 * 'image': an image removed from its note; restore / delete forever act on the image. A removed
 * image of a deleted note is listed once, as 'image'.
 */
export interface BinImage {
  image: NoteImage;
  note_id: string;
  kind: 'note' | 'image';
  /** When it went to the bin (ISO 8601 UTC): the note's deleted_at for 'note', the image's for 'image'. */
  deleted_at: string;
}

/** GET /api/bin. Both lists newest deleted_at first. */
export interface Bin {
  /** Deleted notes, each with its non-removed images (Note.images). */
  notes: Note[];
  images: BinImage[];
}

/** Result of purgeNote / purgeImage. */
export interface PurgeResult {
  /** The purged note id or image id. */
  purged: string;
  /** Files removed from disk: image originals, derived files under cache/<imageId>/, and the note's files under files/<noteId>/. */
  files: number;
}

export type NoteErrorCode =
  | 'invalid_id'
  | 'invalid_input'
  | 'not_found'
  | 'deleted'
  | 'not_deleted'
  | 'empty_body'
  | 'conflict'
  | 'duplicate_image'
  | 'duplicate_file'
  | 'invalid_revision'
  | 'not_embedded';

/** The only error type the notes service throws on purpose. HTTP maps `code` to a status. */
export class NoteError extends Error {
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
  }
}

/**
 * restoreImage refused: the same bytes already live in another image. `noteId` is the note
 * holding them (HTTP answers 409 { error: 'duplicate_image', note_id }).
 */
export class DuplicateImageError extends NoteError {
  readonly noteId: string;

  constructor(noteId: string, message: string) {
    super('duplicate_image', message);
    this.name = 'DuplicateImageError';
    this.noteId = noteId;
  }
}

/**
 * restoreFile refused: the same bytes already live in another file. `noteId` is the note holding
 * them (HTTP answers 409 { error: 'duplicate_file', note_id }).
 */
export class DuplicateFileError extends NoteError {
  readonly noteId: string;

  constructor(noteId: string, message: string) {
    super('duplicate_file', message);
    this.name = 'DuplicateFileError';
    this.noteId = noteId;
  }
}

const ORIGIN_KEYS = ['cwd', 'repo', 'claude_session', 'source'] as const;

/** Keeps only the known string fields of an origin; returns null when nothing is left. */
export function cleanOrigin(value: unknown): Origin | null {
  if (value === null || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const out: Origin = {};
  for (const key of ORIGIN_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** True when `imagePath` (relative to dataDir) names an existing file inside dataDir. */
export function imageAvailable(dataDir: string, imagePath: string): boolean {
  const root = resolve(dataDir);
  const full = resolve(root, imagePath);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return existsSync(full);
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** The four served variants of one image, by image id. */
export function imageUrls(imageId: string): NoteImage['urls'] {
  const base = `/api/images/${imageId}`;
  return {
    thumb: `${base}/thumb`,
    display: `${base}/display`,
    original: `${base}/original`,
    preview: `${base}/preview`,
  };
}

/** `note_images` row -> wire NoteImage. `deleted_at` is present only on removed images. */
export function toNoteImage(row: NoteImageRow, dataDir: string): NoteImage {
  const image: NoteImage = {
    id: row.id,
    note_id: row.noteId,
    position: row.position,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    taken_at: row.takenAt === null ? null : toIso(row.takenAt),
    original_name: row.originalName,
    host: row.host,
    available: imageAvailable(dataDir, row.path),
    urls: imageUrls(row.id),
  };
  if (row.deletedAt !== null) image.deleted_at = toIso(row.deletedAt);
  return image;
}

/** The served URL of one file, by file id. */
export function fileUrls(fileId: string): NoteFile['urls'] {
  return { download: `/api/files/${fileId}/download` };
}

/** `note_files` row -> wire NoteFile. `deleted_at` is present only on removed files. */
export function toNoteFile(row: NoteFileRow, dataDir: string): NoteFile {
  const file: NoteFile = {
    id: row.id,
    note_id: row.noteId,
    position: row.position,
    name: row.originalName,
    mime: row.mime,
    bytes: row.bytes,
    host: row.host,
    available: imageAvailable(dataDir, row.path),
    extraction_status: row.extractionStatus,
    urls: fileUrls(row.id),
  };
  if (row.deletedAt !== null) file.deleted_at = toIso(row.deletedAt);
  return file;
}

/**
 * DB row + its image and file rows -> wire Note. Only live images and files (deleted_at null)
 * are kept, each in position order. `deleted_at` is present only on deleted notes.
 */
export function rowToNote(
  row: NoteRow,
  dataDir: string,
  images: readonly NoteImageRow[],
  files: readonly NoteFileRow[] = [],
): Note {
  const live = images.filter((i) => i.deletedAt === null).sort((a, b) => a.position - b.position);
  const liveFiles = files.filter((f) => f.deletedAt === null).sort((a, b) => a.position - b.position);
  const note: Note = {
    id: row.id,
    body: row.body,
    tags: row.tags,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    origin: cleanOrigin(row.origin),
    images: live.map((i) => toNoteImage(i, dataDir)),
    files: liveFiles.map((f) => toNoteFile(f, dataDir)),
  };
  if (row.deletedAt !== null) note.deleted_at = toIso(row.deletedAt);
  return note;
}
