import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps } from '../deps.js';
import { imageDeps, type ImageDeps } from '../images/ingest.js';
import {
  etagMatches,
  ImageInputError,
  ingestFromUpload,
  MAX_IMAGE_BYTES,
  resolveImageFile,
  type ImageVariant,
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

async function sendImage(c: Context, img: ImageDeps, variant: ImageVariant): Promise<Response> {
  const r = await resolveImageFile(img, c.req.param('id') ?? '', variant);
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

export function imageRoutes(deps: AppDeps, opts: ImageRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_IMAGE_BYTES;
  const img = imageDeps(deps);
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

  for (const variant of VARIANTS) {
    r.get(`/api/notes/:id/${variant}`, (c) => sendImage(c, img, variant));
  }

  return r;
}
