import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { notes } from '../db/schema.js';

/** Where a note was saved from. Every field is optional; unknown keys are dropped. */
export interface Origin {
  cwd?: string | undefined;
  repo?: string | undefined;
  claude_session?: string | undefined;
  /** Free-form channel, e.g. 'mcp', 'web', 'inbox', 'upload'. */
  source?: string | undefined;
}

/** Stored in notes.image_meta. Written by the image ingest (phase 4). Owned by phase 1's schema. */
export type { ImageMeta } from '../db/schema.js';
import type { ImageMeta } from '../db/schema.js';

/** The `image` field of the wire Note. */
export interface NoteImage {
  mime: string;
  width: number;
  height: number;
  bytes: number;
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  /** The original file exists under this machine's data dir. */
  available: boolean;
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
  image: NoteImage | null;
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

export interface NotePage {
  notes: Note[];
  next_cursor: string | null;
}

export type NoteErrorCode =
  | 'invalid_id'
  | 'invalid_input'
  | 'not_found'
  | 'deleted'
  | 'empty_body'
  | 'conflict'
  | 'duplicate_image'
  | 'invalid_revision';

/** The only error type the notes service throws on purpose. HTTP maps `code` to a status. */
export class NoteError extends Error {
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
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

function toImage(row: NoteRow, dataDir: string): NoteImage | null {
  if (row.imagePath === null || row.imageMeta === null || typeof row.imageMeta !== 'object') return null;
  const meta = row.imageMeta as Partial<ImageMeta>;
  return {
    mime: typeof meta.mime === 'string' ? meta.mime : 'application/octet-stream',
    width: typeof meta.width === 'number' ? meta.width : 0,
    height: typeof meta.height === 'number' ? meta.height : 0,
    bytes: typeof meta.bytes === 'number' ? meta.bytes : 0,
    taken_at: typeof meta.taken_at === 'string' ? meta.taken_at : null,
    original_name: typeof meta.original_name === 'string' ? meta.original_name : null,
    host: typeof meta.host === 'string' ? meta.host : null,
    available: imageAvailable(dataDir, row.imagePath),
  };
}

/** DB row -> wire Note. `deleted_at` is present only on deleted notes. */
export function rowToNote(row: NoteRow, dataDir: string): Note {
  const note: Note = {
    id: row.id,
    body: row.body,
    tags: row.tags,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    origin: cleanOrigin(row.origin),
    image: toImage(row, dataDir),
  };
  if (row.deletedAt !== null) note.deleted_at = toIso(row.deletedAt);
  return note;
}
