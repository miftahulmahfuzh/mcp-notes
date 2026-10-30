import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { NoteImageRow, notes } from '../db/schema.js';

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

export type NoteErrorCode =
  | 'invalid_id'
  | 'invalid_input'
  | 'not_found'
  | 'deleted'
  | 'empty_body'
  | 'conflict'
  | 'duplicate_image'
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

/**
 * DB row + its image rows -> wire Note. Only live images (deleted_at null) are kept, in
 * position order. `deleted_at` is present only on deleted notes.
 */
export function rowToNote(row: NoteRow, dataDir: string, images: readonly NoteImageRow[]): Note {
  const live = images.filter((i) => i.deletedAt === null).sort((a, b) => a.position - b.position);
  const note: Note = {
    id: row.id,
    body: row.body,
    tags: row.tags,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    origin: cleanOrigin(row.origin),
    images: live.map((i) => toNoteImage(i, dataDir)),
  };
  if (row.deletedAt !== null) note.deleted_at = toIso(row.deletedAt);
  return note;
}
