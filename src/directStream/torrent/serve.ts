import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parseRange } from '../cache/serve.js';
import { torrentContentType, type TorrentHandle } from './types.js';

function refused(size: number): Response {
  return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' } });
}

function answer(body: ReadableStream<Uint8Array> | null, name: string, size: number, range: { start: number; end: number } | null, cacheControl: string): Response {
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = new Headers({
    'content-type': torrentContentType(name),
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'cache-control': cacheControl,
    'content-length': String(size === 0 ? 0 : end - start + 1),
  });
  if (range !== null) headers.set('content-range', `bytes ${start}-${end}/${size}`);
  return new Response(body, { status: range === null ? 200 : 206, headers });
}

/** A finished torrent file from this machine's disk: 200, 206 for one Range, 416 for one that cannot be served. */
export async function diskFileResponse(file: string, name: string, rangeHeader: string | null): Promise<Response> {
  const size = (await stat(file)).size;
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') return refused(size);
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return answer(body, name, size, range, 'private, max-age=3600');
}

/**
 * A chosen file that is still coming: the range's bytes are read through the handle, whose engine fetches
 * their pieces before the rest of the file. Never cached by the browser (the file is not whole yet).
 */
export function swarmFileResponse(handle: TorrentHandle, file: { index: number; path: string; length: number }, rangeHeader: string | null): Response {
  const size = file.length;
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') return refused(size);
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const body = size === 0 ? null : (Readable.toWeb(handle.read(file.index, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return answer(body, file.path, size, range, 'no-store');
}

export function notOnThisMachine(host: string): Response {
  return new Response(JSON.stringify({ error: 'not_on_this_machine', host, message: `This torrent was downloaded on ${host}; its files are only there.` }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
