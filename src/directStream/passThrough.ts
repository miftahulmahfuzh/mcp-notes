import { absoluteHttp, rewriteDash, rewriteHls, srtToVtt } from './rewrite.js';
import { allows, learn, type StreamSession } from './sessions.js';
import type { CapturedHeaders } from './types.js';

/** A playlist or manifest larger than this is refused (they are kilobytes; this stops a runaway body). */
export const PLAYLIST_MAX_BYTES = 8 * 1024 * 1024;
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
  /** The player's `Range` header, forwarded as is. */
  range: string | null;
  /** `vtt=1`: the answer is a subtitle file to hand back as WebVTT. */
  vtt: boolean;
  /** Aborted when the player goes away; the stream host request is aborted with it. */
  signal: AbortSignal;
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

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (res.body === null) return '';
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Fetches `req.target` for a live session and hands the answer back. Refuses with 403 `forbidden_host`,
 * before any request, an address that is not http(s) or not on a host the session may reach. Follows
 * redirects itself (a redirect answered by the session's host vouches for its target, like a playlist
 * entry). Playlists and manifests are read whole and rewritten, and the hosts they name join the
 * session; everything else streams through as it arrives, with the stream host's status.
 */
export async function forward(session: StreamSession, req: ForwardRequest, fetchImpl: FetchLike): Promise<Response> {
  const first = absoluteHttp(req.target);
  if (first === null || !allows(session, first)) {
    return jsonError(403, 'forbidden_host', 'That address is not on a host this stream session may reach.');
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (req.signal.aborted) abort();
  else req.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
  const headers = upstreamHeaders(session.source.headers, req.range);
  let target = first;
  let upstream: Response;
  try {
    let hops = 0;
    for (;;) {
      const res = await fetchImpl(target, { headers, redirect: 'manual', signal: controller.signal });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location === null) {
        upstream = res;
        break;
      }
      await res.body?.cancel().catch(() => undefined);
      const next = absoluteHttp(location, target);
      hops += 1;
      if (next === null || hops > MAX_REDIRECTS) {
        req.signal.removeEventListener('abort', abort);
        return jsonError(
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
    return jsonError(502, 'upstream_error', `The stream host did not answer: ${messageOf(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const out = new Headers({ 'cache-control': 'no-store', [UPSTREAM_STATUS_HEADER]: String(upstream.status) });
  const contentType = upstream.headers.get('content-type') ?? '';
  const nullBody = NULL_BODY_STATUSES.has(upstream.status);
  const kind = textKind(target, contentType, req.vtt);
  if (kind !== null && !nullBody) {
    let text: string | null;
    try {
      text = await readCapped(upstream, PLAYLIST_MAX_BYTES);
    } catch (err) {
      return jsonError(502, 'upstream_error', `The stream host broke off: ${messageOf(err)}`);
    } finally {
      req.signal.removeEventListener('abort', abort);
    }
    if (text === null) return jsonError(502, 'upstream_error', `The playlist is larger than ${PLAYLIST_MAX_BYTES} bytes.`);
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
