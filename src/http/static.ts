import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import type { AppDeps } from '../deps.js';

/** `<repo>/web/dist`: src/http/static.ts (tsx/vitest) and dist/http/static.js (built) are both two levels down. */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export const WEB_NOT_BUILT_TEXT = 'web UI not built: run npm run build';

export interface StaticOptions {
  /** Absolute path of the built SPA. Defaults to DEFAULT_WEB_DIST. */
  webDist?: string;
}

const RESERVED_PREFIXES = ['/api', '/mcp', '/health'];
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=3600';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function isReserved(pathname: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Reads `<root>/<urlPath>` if it is a regular file inside root; null otherwise (missing, dir, traversal). */
async function readInside(root: string, urlPath: string): Promise<Buffer | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(root, decoded.replace(/^\/+/, ''));
  if (!full.startsWith(root + path.sep)) return null;
  try {
    const info = await stat(full);
    if (!info.isFile()) return null;
    return await readFile(full);
  } catch {
    return null;
  }
}

function sendFile(c: Context, bytes: Buffer, filePath: string, cacheControl: string): Response {
  return c.body(new Uint8Array(bytes), 200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': cacheControl,
  });
}

function sendHtml(c: Context, bytes: Buffer): Response {
  return sendFile(c, bytes, 'page.html', 'no-cache');
}

/** `deps` is unused (P2's factory shape); tests call `staticRoutes(undefined, { webDist })`. */
export function staticRoutes(deps?: AppDeps, options: StaticOptions = {}): Hono {
  void deps;
  const root = path.resolve(options.webDist ?? DEFAULT_WEB_DIST);
  const app = new Hono();

  app.get('*', async (c) => {
    const pathname = c.req.path;
    if (isReserved(pathname)) return c.notFound();

    const index = await readInside(root, 'index.html');
    if (index === null) {
      return c.text(WEB_NOT_BUILT_TEXT, 503, { 'Cache-Control': 'no-store' });
    }

    if (pathname.startsWith('/assets/')) {
      const asset = await readInside(root, pathname);
      if (asset === null) return c.text('not found', 404);
      return sendFile(c, asset, pathname, IMMUTABLE);
    }

    if (/^\/full\/[^/]+\/?$/.test(pathname)) {
      const fullscreen = await readInside(root, 'fullscreen.html');
      return sendHtml(c, fullscreen ?? index);
    }

    if (pathname !== '/') {
      const file = await readInside(root, pathname);
      if (file !== null) {
        if (pathname.toLowerCase().endsWith('.html')) return sendHtml(c, file);
        return sendFile(c, file, pathname, SHORT_CACHE);
      }
    }

    return sendHtml(c, index);
  });

  return app;
}
