import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps } from '../deps.js';
import { attachUpload, FileInputError, fileDeps, locateFile, MAX_FILE_BYTES, uploadDeps } from '../files/ingest.js';
import { FALLBACK_MIME, isValidMime } from '../files/mime.js';
import { findFileById } from '../notes/fileRepo.js';
import { normalizeId } from '../notes/ids.js';
import { DuplicateFileError, DuplicateImageError, NoteError, toNoteFile } from '../notes/types.js';
import { etagMatches } from './imageAccess.js';

export interface FileRouteOptions {
  /** Upload cap in bytes. Default MAX_FILE_BYTES (200 MB). Tests lower it. */
  maxUploadBytes?: number;
}

/** Room for multipart boundaries on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

/** A download is never rendered: no scripts, no subresources, sandboxed even if a browser tried. */
export const DOWNLOAD_CSP = "default-src 'none'; sandbox";

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>`. The ASCII fallback has
 * every non-printable or non-ASCII character, `"` and `\` replaced by `_`; the RFC 5987 value
 * carries the real name. Never `inline`.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  let encoded: string;
  try {
    encoded = rfc5987(name);
  } catch {
    encoded = rfc5987(ascii);
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** FileInputError / NoteError from the write routes -> HTTP. Anything else is rethrown (500). */
function writeErrorResponse(c: Context, err: unknown, maxUpload: number): Response {
  if (err instanceof FileInputError) {
    if (err.code === 'too_large') return c.json({ error: 'too_large', message: err.message, max_bytes: maxUpload }, 413);
    return c.json({ error: err.code, message: err.message }, 400);
  }
  if (!(err instanceof NoteError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'deleted':
      return c.json({ error: 'not_found' }, 404);
    case 'invalid_id':
      return c.json({ error: 'invalid_id' }, 400);
    case 'duplicate_file':
    case 'duplicate_image': {
      const noteId = err instanceof DuplicateFileError || err instanceof DuplicateImageError ? err.noteId : null;
      return c.json({ error: err.code, note_id: noteId, message: err.message }, 409);
    }
    case 'conflict':
      return c.json({ error: 'conflict' }, 409);
    default:
      return c.json({ error: `${err.code}: ${err.message}` }, 400);
  }
}

/**
 * Note file routes (plan phase 4):
 * - POST /api/notes/:id/files: attach one file (multipart `file`) to a live note, or return the
 *   note that already holds the bytes. Sniffed images are stored as images (kind 'image').
 * - DELETE /api/files/:fileId, POST /api/files/:fileId/restore: soft-remove / put back one file.
 * - GET /api/files/:fileId: the file's NoteFile JSON, in any state.
 * - GET /api/files/:fileId/download: the bytes, always as an attachment.
 * Reveal lives in reveal.ts.
 */
export function fileRoutes(deps: AppDeps, opts: FileRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_FILE_BYTES;
  const upload = uploadDeps(deps);
  const files = fileDeps(deps);
  const r = new Hono();

  r.post(
    '/api/notes/:id/files',
    bodyLimit({
      maxSize: maxUpload + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: 'too_large', max_bytes: maxUpload }, 413),
    }),
    async (c) => {
      const noteId = normalizeId(c.req.param('id') ?? '');
      if (noteId === null) return c.json({ error: 'invalid_id' }, 400);
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'bad_multipart' }, 400);
      }
      const fileField = Array.isArray(form['file']) ? form['file'][0] : form['file'];
      if (!(fileField instanceof File)) return c.json({ error: 'file_required' }, 400);
      try {
        const result = await attachUpload(upload, noteId, fileField, maxUpload);
        return c.json(result, result.attached ? 201 : 200);
      } catch (err) {
        return writeErrorResponse(c, err, maxUpload);
      }
    },
  );

  r.delete('/api/files/:fileId', async (c) => {
    const fileId = normalizeId(c.req.param('fileId') ?? '');
    if (fileId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.removeFile(fileId));
    } catch (err) {
      return writeErrorResponse(c, err, maxUpload);
    }
  });

  r.post('/api/files/:fileId/restore', async (c) => {
    const fileId = normalizeId(c.req.param('fileId') ?? '');
    if (fileId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.restoreFile(fileId));
    } catch (err) {
      return writeErrorResponse(c, err, maxUpload);
    }
  });

  r.get('/api/files/:fileId', async (c) => {
    const id = normalizeId(c.req.param('fileId') ?? '');
    const row = id === null ? null : await findFileById(deps.db, id);
    if (row === null) return c.json({ error: 'not_found' }, 404);
    return c.json(toNoteFile(row, deps.config.dataDir));
  });

  r.get('/api/files/:fileId/download', async (c) => {
    const id = normalizeId(c.req.param('fileId') ?? '');
    const loc = id === null ? null : await locateFile(files, id);
    if (loc === null) return c.json({ error: 'not_found' }, 404);
    if (!loc.available) return c.json({ error: 'not_on_this_machine', host: loc.host }, 404);
    const etag = `"${loc.sha256}"`;
    const headers: Record<string, string> = {
      'Content-Type': isValidMime(loc.mime) ? loc.mime : FALLBACK_MIME,
      'Content-Disposition': attachmentDisposition(loc.originalName),
      ETag: etag,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': DOWNLOAD_CSP,
    };
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304, headers);
    let size: number;
    try {
      size = (await stat(loc.originalPath)).size;
    } catch {
      return c.json({ error: 'not_on_this_machine', host: loc.host }, 404);
    }
    headers['Content-Length'] = String(size);
    const stream = Readable.toWeb(createReadStream(loc.originalPath)) as unknown as ReadableStream<Uint8Array>;
    return c.body(stream, 200, headers);
  });

  return r;
}
