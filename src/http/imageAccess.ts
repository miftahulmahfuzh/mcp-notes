import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDisplay, getPreview, getThumb, OriginalMissingError } from '../images/derive.js';
import {
  attachImage,
  ingestImage,
  locateImage,
  locateNoteImage,
  type AttachDeps,
  type AttachResult,
  type ImageDeps,
  type LocatedImage,
} from '../images/ingest.js';
import { UnsupportedImageError } from '../images/probe.js';
import { dbImageRecords } from '../images/records.js';
import type { ToolDeps } from '../mcp/tools.js';
import { normalizeId } from '../notes/ids.js';
import type { Note, Origin } from '../notes/types.js';

/** Upload / create_image size cap. */
export const MAX_IMAGE_BYTES = 200 * 1024 * 1024;

export type ImageVariant = 'original' | 'display' | 'thumb' | 'preview';

export interface ServedFile {
  absPath: string;
  mime: string;
  etag: string;
  size: number;
  /** true for originals: bytes behind this URL never change. */
  immutable: boolean;
}

export type ResolveResult =
  | { status: 'ok'; loc: LocatedImage; file: ServedFile; servedOriginal: boolean }
  | { status: 'not_found' }
  /** Note alias only: a live note with no live image. */
  | { status: 'no_image'; id: string }
  | { status: 'not_on_this_machine'; id: string; host: string | null };

export type ImageInputErrorCode = 'not_absolute' | 'not_found' | 'not_a_file' | 'not_an_image' | 'too_large';

export class ImageInputError extends Error {
  constructor(
    readonly code: ImageInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageInputError';
  }
}

/** ImageDeps for the MCP tools (they get ToolDeps, not AppDeps). */
export function toolImageDeps(deps: ToolDeps): ImageDeps {
  return { dataDir: deps.dataDir, notes: deps.service, records: dbImageRecords(deps.db) };
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** True when an If-None-Match header value names this ETag (handles lists, weak tags and `*`). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

const DERIVED_MIME = { thumb: 'image/webp', preview: 'image/jpeg' } as const;

/** One variant of a located image as a file, or not_on_this_machine. Derivatives go to cache/<imageId>/. */
async function resolveLocated(img: ImageDeps, loc: LocatedImage, variant: ImageVariant): Promise<ResolveResult> {
  if (!loc.available) return { status: 'not_on_this_machine', id: loc.id, host: loc.host };
  const sha = loc.meta.sha256;
  try {
    let absPath: string;
    let mime: string;
    let servedOriginal = false;
    if (variant === 'original') {
      absPath = loc.originalPath;
      mime = loc.mime;
      servedOriginal = true;
    } else if (variant === 'display') {
      const d = await getDisplay(img.dataDir, loc);
      absPath = d.path;
      mime = d.mime;
      servedOriginal = d.path === loc.originalPath;
    } else if (variant === 'thumb') {
      absPath = await getThumb(img.dataDir, loc);
      mime = DERIVED_MIME.thumb;
    } else {
      absPath = await getPreview(img.dataDir, loc);
      mime = DERIVED_MIME.preview;
    }
    const st = await stat(absPath);
    return {
      status: 'ok',
      loc,
      servedOriginal,
      file: {
        absPath,
        mime,
        etag: servedOriginal ? `"${sha}"` : `"${sha}-${variant}"`,
        size: st.size,
        immutable: servedOriginal,
      },
    };
  } catch (err) {
    if (err instanceof OriginalMissingError) return { status: 'not_on_this_machine', id: loc.id, host: loc.host };
    throw err;
  }
}

/**
 * One variant of an image, by image id (any spelling). Serves any existing row: live, removed
 * from its note, or in a deleted note (the bin shows their thumbnails). Unknown id: not_found.
 */
export async function resolveImageFile(img: ImageDeps, rawImageId: string, variant: ImageVariant): Promise<ResolveResult> {
  const id = normalizeId(rawImageId);
  if (id === null) return { status: 'not_found' };
  const loc = await locateImage(img, id);
  if (loc === null) return { status: 'not_found' };
  return resolveLocated(img, loc, variant);
}

/**
 * The legacy `/api/notes/:id/:variant` alias: the first live image of a live note. Unknown or
 * deleted note: not_found. Live note without a live image: no_image.
 */
export async function resolveNoteImageFile(img: ImageDeps, rawNoteId: string, variant: ImageVariant): Promise<ResolveResult> {
  const id = normalizeId(rawNoteId);
  if (id === null) return { status: 'not_found' };
  const loc = await locateNoteImage(img, id);
  if (loc === null) {
    return (await img.notes.getOne(id)) ? { status: 'no_image', id } : { status: 'not_found' };
  }
  if (loc.noteDeleted) return { status: 'not_found' };
  return resolveLocated(img, loc, variant);
}

function blankToUndefined(s: string | undefined | null): string | undefined {
  return s != null && s.trim() !== '' ? s : undefined;
}

async function runIngest(
  img: ImageDeps,
  input: Parameters<typeof ingestImage>[1],
): Promise<{ note: Note; created: boolean }> {
  try {
    return await ingestImage(img, input);
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      throw new ImageInputError('not_an_image', `not an image: ${err.message}`);
    }
    throw err;
  }
}

/** HTTP upload path: bytes come from the multipart File. */
export async function ingestFromUpload(
  img: ImageDeps,
  file: File,
  body: string | undefined,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<{ note: Note; created: boolean }> {
  if (file.size === 0) throw new ImageInputError('not_an_image', 'the uploaded file is empty');
  if (file.size > maxBytes) {
    throw new ImageInputError('too_large', `file is ${file.size} bytes; the limit is ${maxBytes}`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const origin: Origin = { source: 'web' };
  const b = blankToUndefined(body);
  return runIngest(img, { bytes, originalName: file.name || 'upload', origin, ...(b !== undefined ? { body: b } : {}) });
}

/** MCP create_image path: a local file, copied (never moved). */
export async function ingestFromPath(
  img: ImageDeps,
  rawPath: string,
  body: string | undefined,
  origin: Origin | null,
): Promise<{ note: Note; created: boolean }> {
  const p = expandHome(rawPath.trim());
  if (!path.isAbsolute(p)) {
    throw new ImageInputError('not_absolute', `path must be absolute (or start with ~/): ${rawPath}`);
  }
  let st;
  try {
    st = await stat(p);
  } catch {
    throw new ImageInputError('not_found', `no such file: ${p}`);
  }
  if (!st.isFile()) throw new ImageInputError('not_a_file', `not a regular file: ${p}`);
  if (st.size === 0) throw new ImageInputError('not_an_image', `empty file: ${p}`);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new ImageInputError('too_large', `file is ${st.size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  }
  const b = blankToUndefined(body);
  return runIngest(img, { path: p, originalName: path.basename(p), origin, move: false, ...(b !== undefined ? { body: b } : {}) });
}

/** AttachDeps for the MCP tools. */
export function toolAttachDeps(deps: ToolDeps): AttachDeps {
  return { ...toolImageDeps(deps), notes: deps.service };
}

async function runAttach(img: AttachDeps, noteId: string, input: Parameters<typeof attachImage>[2]): Promise<AttachResult> {
  try {
    return await attachImage(img, noteId, input);
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      throw new ImageInputError('not_an_image', `not an image: ${err.message}`);
    }
    throw err;
  }
}

/** A local file path a tool may read: absolute (or ~/), an existing non-empty regular file under the cap. */
async function checkLocalImagePath(rawPath: string): Promise<string> {
  const p = expandHome(rawPath.trim());
  if (!path.isAbsolute(p)) {
    throw new ImageInputError('not_absolute', `path must be absolute (or start with ~/): ${rawPath}`);
  }
  let st;
  try {
    st = await stat(p);
  } catch {
    throw new ImageInputError('not_found', `no such file: ${p}`);
  }
  if (!st.isFile()) throw new ImageInputError('not_a_file', `not a regular file: ${p}`);
  if (st.size === 0) throw new ImageInputError('not_an_image', `empty file: ${p}`);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new ImageInputError('too_large', `file is ${st.size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  }
  return p;
}

/** HTTP POST /api/notes/:id/images: bytes come from the multipart File. */
export async function attachFromUpload(
  img: AttachDeps,
  noteId: string,
  file: File,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<AttachResult> {
  if (file.size === 0) throw new ImageInputError('not_an_image', 'the uploaded file is empty');
  if (file.size > maxBytes) {
    throw new ImageInputError('too_large', `file is ${file.size} bytes; the limit is ${maxBytes}`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  return runAttach(img, noteId, { bytes, originalName: file.name || 'upload' });
}

/** MCP attach_image: a local file, copied (never moved). */
export async function attachFromPath(img: AttachDeps, noteId: string, rawPath: string): Promise<AttachResult> {
  const p = await checkLocalImagePath(rawPath);
  return runAttach(img, noteId, { path: p, originalName: path.basename(p), move: false });
}
