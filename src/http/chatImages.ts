import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ChatImageInputError,
  chatImageStoreFor,
  ingestChatImage,
  locateChatImage,
  MAX_CHAT_IMAGE_BYTES,
  toChatImage,
  type ChatImageStoreDeps,
  type ChatImageVariant,
} from '../chat/images.js';
import type { ChatImageSource } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { getDisplay, getPreview, getThumb, OriginalMissingError } from '../images/derive.js';
import { etagMatches } from './imageAccess.js';

export interface ChatImageRouteOptions {
  /** Upload cap in bytes. Default MAX_CHAT_IMAGE_BYTES (50 MB). Tests lower it. */
  maxUploadBytes?: number;
}

/** Room for multipart boundaries on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

const VARIANTS: readonly ChatImageVariant[] = ['original', 'display', 'thumb', 'preview'];

const DERIVED_MIME = { thumb: 'image/webp', preview: 'image/jpeg' } as const;

interface ServedChatFile {
  absPath: string;
  mime: string;
  etag: string;
  size: number;
  /** true for originals: bytes behind this URL never change. */
  immutable: boolean;
  /** Set when the original itself is served: becomes an inline Content-Disposition filename. */
  downloadName: string | null;
}

type VariantResult =
  | { status: 'ok'; file: ServedChatFile }
  | { status: 'not_found' }
  | { status: 'not_on_this_machine'; host: string | null };

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** One variant of a chat image as a file. Derivatives are generated into `cache/c_<id>/` on first request. */
async function resolveVariant(store: ChatImageStoreDeps, rawId: string, variant: ChatImageVariant): Promise<VariantResult> {
  const loc = await locateChatImage(store, rawId);
  if (loc === null) return { status: 'not_found' };
  const host = loc.row.host;
  if (!loc.available) return { status: 'not_on_this_machine', host };
  const sha = loc.row.sha256;
  try {
    let absPath: string;
    let mime: string;
    let servedOriginal = false;
    if (variant === 'original') {
      absPath = loc.source.originalPath;
      mime = loc.row.mime;
      servedOriginal = true;
    } else if (variant === 'display') {
      const d = await getDisplay(store.dataDir, loc.source);
      absPath = d.path;
      mime = d.mime;
      servedOriginal = d.path === loc.source.originalPath;
    } else if (variant === 'thumb') {
      absPath = await getThumb(store.dataDir, loc.source);
      mime = DERIVED_MIME.thumb;
    } else {
      absPath = await getPreview(store.dataDir, loc.source);
      mime = DERIVED_MIME.preview;
    }
    const st = await stat(absPath);
    return {
      status: 'ok',
      file: {
        absPath,
        mime,
        etag: servedOriginal ? `"${sha}"` : `"${sha}-${variant}"`,
        size: st.size,
        immutable: servedOriginal,
        downloadName: servedOriginal ? loc.row.originalName : null,
      },
    };
  } catch (err) {
    if (err instanceof OriginalMissingError) return { status: 'not_on_this_machine', host };
    throw err;
  }
}

function sendVariant(c: Context, r: VariantResult): Response {
  if (r.status === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (r.status === 'not_on_this_machine') return c.json({ error: 'not_on_this_machine', host: r.host }, 404);
  const f = r.file;
  const headers: Record<string, string> = {
    'Content-Type': f.mime,
    ETag: f.etag,
    'Cache-Control': f.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  if (f.downloadName) headers['Content-Disposition'] = contentDisposition(f.downloadName);
  if (etagMatches(c.req.header('if-none-match'), f.etag)) {
    return c.body(null, 304, headers);
  }
  headers['Content-Length'] = String(f.size);
  const stream = Readable.toWeb(createReadStream(f.absPath)) as unknown as ReadableStream<Uint8Array>;
  return c.body(stream, 200, headers);
}

/**
 * Chat image routes (pasted into the chat bar; never notes):
 * - POST /api/chat/images: multipart `file` (+ optional `source`: `wall` default | `claude_code`,
 *   sent by the Claude Code notes-paste hook, phase 8) -> 201 `{image, created: true}`, or 200
 *   `{image, created: false}` when the same bytes are already stored (the first upload's `source`
 *   is kept). 400 invalid_source, 413 too_large, 415 not_an_image.
 * - GET /api/chat/images/:id: the wire `ChatImage`.
 * - GET /api/chat/images/:id/{original|display|thumb|preview}: the file.
 */
export function chatImageRoutes(deps: AppDeps, opts: ChatImageRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_CHAT_IMAGE_BYTES;
  const store = chatImageStoreFor(deps);
  const r = new Hono();

  r.post(
    '/api/chat/images',
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
      const sourceField = Array.isArray(form['source']) ? form['source'][0] : form['source'];
      let source: ChatImageSource = 'wall';
      if (sourceField !== undefined) {
        if (sourceField !== 'wall' && sourceField !== 'claude_code') {
          return c.json({ error: 'invalid_source', message: 'source must be wall or claude_code' }, 400);
        }
        source = sourceField;
      }
      if (fileField.size > maxUpload) {
        return c.json(
          { error: 'too_large', message: `file is ${fileField.size} bytes; the limit is ${maxUpload}`, max_bytes: maxUpload },
          413,
        );
      }
      const bytes = Buffer.from(await fileField.arrayBuffer());
      try {
        const result = await ingestChatImage(store, {
          bytes,
          originalName: fileField.name || null,
          source,
          maxBytes: maxUpload,
        });
        return c.json(result, result.created ? 201 : 200);
      } catch (err) {
        if (err instanceof ChatImageInputError) {
          return c.json({ error: err.code, message: err.message }, err.code === 'too_large' ? 413 : 415);
        }
        throw err;
      }
    },
  );

  r.get('/api/chat/images/:id', async (c) => {
    const loc = await locateChatImage(store, c.req.param('id') ?? '');
    if (loc === null) return c.json({ error: 'not_found' }, 404);
    return c.json(toChatImage(loc.row, loc.available));
  });

  for (const variant of VARIANTS) {
    r.get(`/api/chat/images/:id/${variant}`, async (c) =>
      sendVariant(c, await resolveVariant(store, c.req.param('id') ?? '', variant)),
    );
  }

  return r;
}
