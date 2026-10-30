import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps } from '../deps.js';
import { attachDeps, imageDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import { findImageById } from '../notes/imageRepo.js';
import { DuplicateImageError, NoteError, toNoteImage } from '../notes/types.js';
import {
  attachFromUpload,
  etagMatches,
  ImageInputError,
  ingestFromUpload,
  MAX_IMAGE_BYTES,
  resolveImageFile,
  resolveNoteImageFile,
  type ImageVariant,
  type ResolveResult,
} from './imageAccess.js';

export interface ImageRouteOptions {
  /** Upload cap in bytes. Default MAX_IMAGE_BYTES (200 MB). Tests lower it. */
  maxUploadBytes?: number;
}

/** Room for multipart boundaries and the optional body field on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

const VARIANTS: readonly ImageVariant[] = ['original', 'display', 'thumb', 'preview'];

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** ImageInputError / NoteError from the attach, remove and restore routes -> HTTP. Anything else is rethrown (500). */
function writeErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof ImageInputError) {
    const status = err.code === 'too_large' ? 413 : 415;
    return c.json({ error: err.code, message: err.message }, status);
  }
  if (!(err instanceof NoteError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'deleted':
      return c.json({ error: 'not_found' }, 404);
    case 'invalid_id':
      return c.json({ error: 'invalid_id' }, 400);
    case 'duplicate_image':
      return c.json(
        { error: 'duplicate_image', note_id: err instanceof DuplicateImageError ? err.noteId : null, message: err.message },
        409,
      );
    case 'conflict':
      return c.json({ error: 'conflict' }, 409);
    default:
      return c.json({ error: `${err.code}: ${err.message}` }, 400);
  }
}

function sendResolved(c: Context, r: ResolveResult): Response {
  switch (r.status) {
    case 'not_found':
      return c.json({ error: 'not_found' }, 404);
    case 'no_image':
      return c.json({ error: 'no_image', id: r.id }, 404);
    case 'not_on_this_machine':
      return c.json({ error: 'not_on_this_machine', host: r.host }, 404);
    case 'ok':
      break;
  }
  const f = r.file;
  const headers: Record<string, string> = {
    'Content-Type': f.mime,
    ETag: f.etag,
    'Cache-Control': f.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  const originalName = r.loc.meta.original_name;
  if (r.servedOriginal && originalName) headers['Content-Disposition'] = contentDisposition(originalName);
  if (etagMatches(c.req.header('if-none-match'), f.etag)) {
    return c.body(null, 304, headers);
  }
  headers['Content-Length'] = String(f.size);
  const stream = Readable.toWeb(createReadStream(f.absPath)) as unknown as ReadableStream<Uint8Array>;
  return c.body(stream, 200, headers);
}

/**
 * Image routes:
 * - POST /api/images: upload one file as a new note (or the note already holding it).
 * - POST /api/notes/:id/images: attach one more file to a live note (or return the holder).
 * - DELETE /api/images/:imageId, POST /api/images/:imageId/restore: soft-remove / put back one image.
 * - GET /api/images/:imageId: the image's NoteImage JSON, in any state.
 * - GET /api/images/:imageId/{original|display|thumb|preview}: any existing image row's file.
 * - GET /api/notes/:id/{variant}: alias, the first live image of a live note.
 */
export function imageRoutes(deps: AppDeps, opts: ImageRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_IMAGE_BYTES;
  const img = imageDeps(deps);
  const attach = attachDeps(deps);
  const r = new Hono();

  r.post(
    '/api/images',
    bodyLimit({
      maxSize: maxUpload + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: 'too_large', max_bytes: maxUpload }, 413),
    }),
    async (c) => {
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'bad_multipart' }, 400);
      }
      const fileField = Array.isArray(form['file']) ? form['file'][0] : form['file'];
      if (!(fileField instanceof File)) return c.json({ error: 'file_required' }, 400);
      const bodyField = Array.isArray(form['body']) ? form['body'][0] : form['body'];
      const body = typeof bodyField === 'string' ? bodyField : undefined;
      try {
        const result = await ingestFromUpload(img, fileField, body, maxUpload);
        return c.json(result, result.created ? 201 : 200);
      } catch (err) {
        if (err instanceof ImageInputError) {
          const status = err.code === 'too_large' ? 413 : 415;
          return c.json({ error: err.code, message: err.message }, status);
        }
        throw err;
      }
    },
  );

  r.post(
    '/api/notes/:id/images',
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
        const result = await attachFromUpload(attach, noteId, fileField, maxUpload);
        return c.json(result, result.attached ? 201 : 200);
      } catch (err) {
        return writeErrorResponse(c, err);
      }
    },
  );

  r.delete('/api/images/:imageId', async (c) => {
    const imageId = normalizeId(c.req.param('imageId') ?? '');
    if (imageId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.removeImage(imageId));
    } catch (err) {
      return writeErrorResponse(c, err);
    }
  });

  r.post('/api/images/:imageId/restore', async (c) => {
    const imageId = normalizeId(c.req.param('imageId') ?? '');
    if (imageId === null) return c.json({ error: 'invalid_id' }, 400);
    try {
      return c.json(await deps.service.restoreImage(imageId));
    } catch (err) {
      return writeErrorResponse(c, err);
    }
  });

  r.get('/api/images/:imageId', async (c) => {
    const id = normalizeId(c.req.param('imageId') ?? '');
    const row = id === null ? null : await findImageById(deps.db, id);
    if (row === null) return c.json({ error: 'not_found' }, 404);
    return c.json(toNoteImage(row, deps.config.dataDir));
  });

  for (const variant of VARIANTS) {
    r.get(`/api/images/:imageId/${variant}`, async (c) =>
      sendResolved(c, await resolveImageFile(img, c.req.param('imageId') ?? '', variant)),
    );
    r.get(`/api/notes/:id/${variant}`, async (c) =>
      sendResolved(c, await resolveNoteImageFile(img, c.req.param('id') ?? '', variant)),
    );
  }

  return r;
}
