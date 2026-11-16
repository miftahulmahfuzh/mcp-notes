import { MAX_REDIRECTS, UPSTREAM_HEADERS_TIMEOUT_MS, upstreamHeaders, type FetchLike } from '../passThrough.js';
import { absoluteHttp } from '../rewrite.js';
import { allows, learn, type StreamSession } from '../sessions.js';
import type { ByteRange } from './hls.js';

/** A segment, key or chunk must arrive whole within this. */
export const BODY_TIMEOUT_MS = 120_000;
/** A single segment larger than this is refused (a runaway body, not a segment). */
export const SEGMENT_MAX_BYTES = 64 * 1024 * 1024;

/** How one request ended, for the downloader. Details never carry the address. */
export type Fetched =
  | { kind: 'ok'; url: string; status: number; body: Buffer; contentRange: string | null }
  | { kind: 'refused'; status: number }
  | { kind: 'retry'; status: number | null; detail: string }
  | { kind: 'fatal'; status: number | null; detail: string };

export interface UpstreamGet {
  range: ByteRange | null;
  maxBytes: number;
  signal: AbortSignal;
}

/** 401, 403, 410: the host refuses the token (a signed address that expired). */
const REFUSED: ReadonlySet<number> = new Set([401, 403, 410]);

function retryable(status: number): boolean {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readBody(res: Response, cap: number, truncate: boolean): Promise<Buffer | null> {
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (truncate && size >= cap) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * One GET for the cache with the session's captured headers, the pass-through's rules: only a host
 * the session may reach, redirects followed here (each target joins the session), no cookie. A
 * byte range is asked with `Range`; a host that answers it with 200 is read up to the range's end
 * and sliced. Throws only when `signal` was aborted (the download was cancelled).
 */
export async function fetchUpstream(fetchImpl: FetchLike, session: StreamSession, target: string, options: UpstreamGet): Promise<Fetched> {
  const first = absoluteHttp(target);
  if (first === null || !allows(session, first)) return { kind: 'fatal', status: null, detail: 'the address is not on a host this source may reach' };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });
  const headersTimer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
  const bodyTimer = setTimeout(abort, BODY_TIMEOUT_MS);
  const range = options.range;
  const headers = upstreamHeaders(session.source.headers, range === null ? null : `bytes=${range.offset}-${range.offset + range.length - 1}`);
  try {
    let url = first;
    let res = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal });
    for (let hops = 0; res.status >= 300 && res.status < 400 && res.headers.get('location') !== null; hops += 1) {
      await res.body?.cancel().catch(() => undefined);
      const next = absoluteHttp(res.headers.get('location') ?? '', url);
      if (next === null || hops >= MAX_REDIRECTS) {
        return { kind: 'fatal', status: res.status, detail: next === null ? 'redirected to an address that is not http(s)' : `redirected more than ${MAX_REDIRECTS} times` };
      }
      learn(session, next);
      url = next;
      res = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal });
    }
    clearTimeout(headersTimer);
    if (REFUSED.has(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'refused', status: res.status };
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      return retryable(res.status) ? { kind: 'retry', status: res.status, detail: `HTTP ${res.status}` } : { kind: 'fatal', status: res.status, detail: `HTTP ${res.status}` };
    }
    const end = range === null ? null : range.offset + range.length;
    const whole = end !== null && res.status === 200;
    const body = await readBody(res, whole ? end : options.maxBytes, whole);
    if (body === null) return { kind: 'fatal', status: res.status, detail: `the answer is larger than ${options.maxBytes} bytes` };
    if (range !== null && end !== null) {
      if (whole) {
        if (body.length < end) return { kind: 'retry', status: 200, detail: 'the answer ended before the byte range' };
        return { kind: 'ok', url, status: 200, body: body.subarray(range.offset, end), contentRange: null };
      }
      if (body.length !== range.length) return { kind: 'retry', status: 206, detail: `a byte range answer of ${body.length} bytes, not ${range.length}` };
    }
    return { kind: 'ok', url, status: res.status, body, contentRange: res.headers.get('content-range') };
  } catch (err) {
    if (options.signal.aborted) throw err;
    return { kind: 'retry', status: null, detail: `the stream host did not answer (${messageOf(err)})` };
  } finally {
    clearTimeout(headersTimer);
    clearTimeout(bodyTimer);
    options.signal.removeEventListener('abort', abort);
  }
}
