import { absoluteHttp, rewriteDash, rewriteHls, srtToVtt } from './rewrite.js';
import { allows, learn, type StreamSession } from './sessions.js';
import type { CapturedHeaders } from './types.js';

/** A playlist or manifest larger than this is refused (they are kilobytes; this stops a runaway body). */
export const PLAYLIST_MAX_BYTES = 8 * 1024 * 1024;
/** A seek-preview picture (`img=1`) larger than this is refused: a sprite sheet is tens or hundreds of kilobytes. */
export const PREVIEW_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The stream host must start answering within this; a body then streams for as long as it takes. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 5;
/** Carries the stream host's own status on every forwarded answer; notesd's own refusals never carry it. */
export const UPSTREAM_STATUS_HEADER = 'x-notesd-upstream';
const PASSED_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'] as const;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ForwardRequest {
  /** The `u` query parameter: the stream host address to fetch (empty when missing). */
  target: string;
  /** The player's `Range` header, forwarded as is (never for an `image` request). */
  range: string | null;
  /** `vtt=1`: the answer is a subtitle file to hand back as WebVTT. */
  vtt: boolean;
  /**
   * A seek preview's request (previews/providerSource.ts), sent with the headers the resolve captured for the
   * provider's preview track: `track`, that WebVTT file, read by the daemon; `image` (`img=1`), one of its
   * pictures, answered only as an image/* body under PREVIEW_IMAGE_MAX_BYTES. Unset: a request of the play.
   */
  preview?: 'track' | 'image';
  /** Aborted when the player goes away; the stream host request is aborted with it. */
  signal: AbortSignal;
}

/** What the answer carries: a rewritten playlist or manifest, a subtitle, media streamed through, or a seek-preview picture. */
export type ForwardKind = 'hls' | 'dash' | 'vtt' | 'media' | 'image';

/**
 * What forward() saw, for the stream evidence log (evidence.ts). forward() only writes it, as it
 * goes; it never reads it back, so an answer is the same with or without one.
 */
export interface ForwardTrace {
  /** The clock `headersAt` is read from (milliseconds, monotonic). */
  readonly clock: () => number;
  /** The address last asked for (after redirects); null when nothing was fetched. */
  target: string | null;
  redirects: number;
  /** The stream host's status; null when it never answered. */
  upstreamStatus: number | null;
  /** clock() when the stream host's headers arrived; null when they never did. */
  headersAt: number | null;
  kind: ForwardKind | null;
  /** `<code>: <message>` when notesd answered with its own error (forbidden_host, upstream_error); else null. */
  error: string | null;
}

export function newForwardTrace(clock: () => number = () => performance.now()): ForwardTrace {
  return { clock, target: null, redirects: 0, upstreamStatus: null, headersAt: null, kind: null, error: null };
}

export function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Only what the real Chrome's manifest request carried, plus the player's Range. No cookie, nothing invented. */
export function upstreamHeaders(captured: CapturedHeaders, range: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (captured.referer !== null) headers.referer = captured.referer;
  if (captured.origin !== null) headers.origin = captured.origin;
  if (captured.user_agent !== null) headers['user-agent'] = captured.user_agent;
  if (range !== null && range !== '') headers.range = range;
  return headers;
}

/**
 * The captured headers a request goes with: a seek preview's, those the provider's preview track was asked
 * with (the player asks for the track's pictures from the same page); everything else, and a preview request
 * of a source with no track, the manifest's.
 */
function capturedFor(session: StreamSession, req: ForwardRequest): CapturedHeaders {
  const track = session.source.thumbnails ?? null;
  if (req.preview === undefined || track === null) return session.source.headers;
  return { referer: track.referer, origin: track.origin, user_agent: track.user_agent };
}

type TextKind = 'hls' | 'dash' | 'vtt';

function textKind(target: string, contentType: string, vtt: boolean): TextKind | null {
  if (vtt) return 'vtt';
  const pathname = new URL(target).pathname.toLowerCase();
  if (/mpegurl/i.test(contentType) || /\.m3u8?$/.test(pathname)) return 'hls';
  if (/dash\+xml/i.test(contentType) || pathname.endsWith('.mpd')) return 'dash';
  // VidNest serves its master playlist as master.txt.
  if (pathname.endsWith('.txt') && !/^(video|audio|image)\//i.test(contentType)) return 'hls';
  return null;
}

/** The whole body, or null (the body cancelled) as soon as it passes `max` bytes. */
export async function readCappedBytes(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The whole body as text, or null as soon as it passes `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  const bytes = await readCappedBytes(res, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Refuse = (status: number, error: string, message: string) => Response;

/**
 * A seek-preview picture (`img=1`): the host's answer only when it is 2xx, an image/* type and at most
 * PREVIEW_IMAGE_MAX_BYTES, read whole so the page never gets half a picture; else 502 `not_an_image` or
 * `image_too_large`. Cacheable by the browser: the address names the session and the picture.
 */
async function answerImage(upstream: Response, out: Headers, refuse: Refuse): Promise<Response> {
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !/^image\//i.test(contentType)) {
    await upstream.body?.cancel().catch(() => undefined);
    const type = contentType === '' ? 'no type' : (contentType.split(';')[0] ?? '').trim();
    return refuse(502, 'not_an_image', `The stream host answered ${upstream.status} with ${type}, not a picture.`);
  }
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  if (Number(upstream.headers.get('content-length') ?? '0') > PREVIEW_IMAGE_MAX_BYTES) {
    await upstream.body?.cancel().catch(() => undefined);
  } else {
    try {
      bytes = await readCappedBytes(upstream, PREVIEW_IMAGE_MAX_BYTES);
    } catch (err) {
      return refuse(502, 'upstream_error', `The stream host broke off: ${messageOf(err)}`);
    }
  }
  if (bytes === null) return refuse(502, 'image_too_large', `The picture is larger than ${PREVIEW_IMAGE_MAX_BYTES} bytes.`);
  out.set('content-type', contentType);
  out.set('content-length', String(bytes.byteLength));
  out.set('cache-control', 'private, max-age=86400');
  return new Response(bytes, { status: upstream.status, headers: out });
}

/**
 * Fetches `req.target` for a live session and hands the answer back. Refuses with 403 `forbidden_host`,
 * before any request, an address that is not http(s) or not on a host the session may reach. Follows
 * redirects itself (a redirect answered by the session's host vouches for its target, like a playlist
 * entry). Playlists and manifests are read whole and rewritten, and the hosts they name join the
 * session; a seek-preview picture is checked and read whole (answerImage); everything else streams
 * through as it arrives, with the stream host's status. `trace`, when given, is filled in for the
 * evidence log; the answer does not depend on it.
 */
export async function forward(session: StreamSession, req: ForwardRequest, fetchImpl: FetchLike, trace: ForwardTrace | null = null): Promise<Response> {
  const refuse: Refuse = (status, error, message) => {
    if (trace !== null) trace.error = `${error}: ${message}`;
    return jsonError(status, error, message);
  };
  const first = absoluteHttp(req.target);
  if (first === null || !allows(session, first)) {
    return refuse(403, 'forbidden_host', 'That address is not on a host this stream session may reach.');
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (req.signal.aborted) abort();
  else req.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
  const image = req.preview === 'image';
  const headers = upstreamHeaders(capturedFor(session, req), image ? null : req.range);
  let target = first;
  let upstream: Response;
  try {
    let hops = 0;
    for (;;) {
      if (trace !== null) trace.target = target;
      const res = await fetchImpl(target, { headers, redirect: 'manual', signal: controller.signal });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location === null) {
        upstream = res;
        break;
      }
      await res.body?.cancel().catch(() => undefined);
      const next = absoluteHttp(location, target);
      hops += 1;
      if (trace !== null) trace.redirects = hops;
      if (next === null || hops > MAX_REDIRECTS) {
        req.signal.removeEventListener('abort', abort);
        return refuse(
          502,
          'upstream_error',
          next === null ? 'The stream host redirected to an address that is not http(s).' : `The stream host redirected more than ${MAX_REDIRECTS} times.`,
        );
      }
      learn(session, next);
      target = next;
    }
  } catch (err) {
    req.signal.removeEventListener('abort', abort);
    return refuse(502, 'upstream_error', `The stream host did not answer: ${messageOf(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (trace !== null) {
    trace.upstreamStatus = upstream.status;
    trace.headersAt = trace.clock();
  }

  const out = new Headers({ 'cache-control': 'no-store', [UPSTREAM_STATUS_HEADER]: String(upstream.status) });
  if (image) {
    if (trace !== null) trace.kind = 'image';
    try {
      return await answerImage(upstream, out, refuse);
    } finally {
      req.signal.removeEventListener('abort', abort);
    }
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  const nullBody = NULL_BODY_STATUSES.has(upstream.status);
  const kind = textKind(target, contentType, req.vtt);
  if (trace !== null) trace.kind = kind ?? 'media';
  if (kind !== null && !nullBody) {
    let text: string | null;
    try {
      text = await readCapped(upstream, PLAYLIST_MAX_BYTES);
    } catch (err) {
      return refuse(502, 'upstream_error', `The stream host broke off: ${messageOf(err)}`);
    } finally {
      req.signal.removeEventListener('abort', abort);
    }
    if (text === null) return refuse(502, 'upstream_error', `The playlist is larger than ${PLAYLIST_MAX_BYTES} bytes.`);
    let body = text;
    let type = contentType === '' ? 'text/plain; charset=utf-8' : contentType;
    if (kind === 'hls' && text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) {
      const r = rewriteHls(text, target, session.id);
      for (const url of r.urls) learn(session, url);
      body = r.text;
      type = 'application/vnd.apple.mpegurl';
    } else if (kind === 'dash' && /<MPD[\s>]/.test(text)) {
      const r = rewriteDash(text, target, session.id);
      for (const url of r.urls) learn(session, url);
      body = r.text;
      type = 'application/dash+xml';
    } else if (kind === 'vtt' && upstream.ok) {
      body = srtToVtt(text);
      type = 'text/vtt; charset=utf-8';
    }
    out.set('content-type', type);
    return new Response(body, { status: upstream.status, headers: out });
  }
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  const length = upstream.headers.get('content-length');
  if (length !== null && upstream.headers.get('content-encoding') === null) out.set('content-length', length);
  return new Response(nullBody ? null : upstream.body, { status: upstream.status, headers: out });
}
