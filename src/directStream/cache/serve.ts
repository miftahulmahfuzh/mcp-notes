import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export function contentTypeOf(name: string): string {
  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (name.endsWith('.ts')) return 'video/mp2t';
  if (name.endsWith('.m4s')) return 'video/iso.segment';
  if (name.endsWith('.aac')) return 'audio/aac';
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * One `Range` header against a size: null without one, `invalid` for a range that cannot be
 * served (several ranges, or past the end), else the inclusive byte span.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (header === null || header.trim() === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return 'invalid';
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

/** A cache file from disk: 200, 206 for a Range, 416 for one that cannot be served. Playlists are never cached by the browser. */
export async function fileResponse(file: string, name: string, rangeHeader: string | null): Promise<Response> {
  const size = (await stat(file)).size;
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = new Headers({
    'content-type': contentTypeOf(name),
    'accept-ranges': 'bytes',
    'cache-control': name.endsWith('.m3u8') ? 'no-store' : 'private, max-age=3600',
    'content-length': String(size === 0 ? 0 : end - start + 1),
  });
  if (range !== null) headers.set('content-range', `bytes ${start}-${end}/${size}`);
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status: range === null ? 200 : 206, headers });
}
