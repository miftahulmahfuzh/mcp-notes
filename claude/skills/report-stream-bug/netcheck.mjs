#!/usr/bin/env node
/**
 * /report-stream-bug's network measurement, no dependencies.
 *   netcheck.mjs [--reference URL] [--daemon URL --session ID] [--host HOST [--host-scheme https|http]]
 *                [--max-bytes N] [--max-seconds S]
 * Prints one JSON object: a download from a reference host; while the session lives, a download of
 * its highest rendition's segments through the daemon's pass-through; and how long the stream host
 * takes to answer its root. The daemon's addresses carry the stream host's signed token, so they are
 * read in memory only: nothing but hosts, statuses, sizes and times leaves this script.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REFERENCE = 'https://speed.cloudflare.com/__down?bytes=25000000';
const DEFAULTS = { maxBytes: 25_000_000, maxSeconds: 10 };
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const mbps = (bytes, seconds) => (seconds > 0 ? round((bytes * 8) / seconds / 1e6) : null);
const errorCode = (err) => {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  return String(err?.cause?.code ?? err?.code ?? err?.name ?? 'error');
};
const upstreamOf = (res) => {
  const v = res.headers.get('x-notesd-upstream');
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function median(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function positive(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
  return n;
}

export function parseArgs(argv) {
  const o = { reference: DEFAULT_REFERENCE, daemon: null, session: null, host: null, hostScheme: 'https', maxBytes: DEFAULTS.maxBytes, maxSeconds: DEFAULTS.maxSeconds };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case '--reference':
        o.reference = value;
        break;
      case '--daemon':
        o.daemon = value.replace(/\/+$/, '');
        break;
      case '--session':
        o.session = value;
        break;
      case '--host':
        o.host = value;
        break;
      case '--host-scheme':
        if (value !== 'https' && value !== 'http') throw new Error('--host-scheme is https or http');
        o.hostScheme = value;
        break;
      case '--max-bytes':
        o.maxBytes = positive(value, flag);
        break;
      case '--max-seconds':
        o.maxSeconds = positive(value, flag);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
    i += 2;
  }
  return o;
}

/**
 * Downloads `url` until it ends, `maxBytes` arrive or `maxSeconds` pass (stopping early is not an
 * error: `truncated`). The rate is measured from the first byte. The address is never in the answer.
 */
export async function download(url, { maxBytes = DEFAULTS.maxBytes, maxSeconds = DEFAULTS.maxSeconds, headers = {}, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxSeconds * 1000);
  const started = performance.now();
  let headersAt = null;
  let bytes = 0;
  let truncated = false;
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
    headersAt = performance.now();
    if (res.body !== null) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes >= maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) throw err;
        truncated = true;
      }
    }
    const seconds = (performance.now() - headersAt) / 1000;
    return { ok: res.ok, status: res.status, upstream: upstreamOf(res), ttfb_ms: Math.round(headersAt - started), bytes, seconds: round(seconds, 3), mbps: mbps(bytes, seconds), truncated, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      upstream: null,
      ttfb_ms: headersAt === null ? null : Math.round(headersAt - started),
      bytes,
      seconds: null,
      mbps: null,
      truncated,
      error: controller.signal.aborted ? 'timeout' : errorCode(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, seconds, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(Math.ceil(seconds * 1000)) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, upstream: upstreamOf(res), text, error: null };
  } catch (err) {
    return { ok: false, status: null, upstream: null, text: '', error: errorCode(err) };
  }
}

/** The stream host a pass-through address leads to (the host of its `u` parameter), or null. */
export function targetHost(address) {
  try {
    const u = new URL(address).searchParams.get('u');
    return u === null ? null : new URL(u).host;
  } catch {
    return null;
  }
}

/** The address lines of an HLS playlist, resolved against `base`. */
export function playlistLines(text, base) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => new URL(l, base).href);
}

/** The variant with the highest BANDWIDTH (not AVERAGE-BANDWIDTH) of a master playlist; null for a media playlist. */
export function bestVariant(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]);
    if (m === null) continue;
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(m[1])?.[1] ?? 0);
    const next = lines.slice(i + 1).find((l) => l !== '' && !l.startsWith('#'));
    if (next === undefined) continue;
    if (best === null || bandwidth > best.bandwidth) best = { bandwidth, url: new URL(next, base).href };
  }
  return best;
}

/**
 * The stream host's speed now, through the daemon's pass-through of a live session (the daemon adds
 * the headers the host checks). HLS: the highest rendition's segments from the middle on; a plain
 * file: its first bytes by range; DASH: the manifest's first answer only.
 */
export async function measureStream({ daemon, session, maxBytes = DEFAULTS.maxBytes, maxSeconds = DEFAULTS.maxSeconds, fetchImpl = fetch }) {
  if (!SESSION_ID.test(session)) return { ok: false, reason: 'bad_session_id' };
  let info;
  try {
    const res = await fetchImpl(`${daemon}/api/stream/sessions/${session}`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 403 || res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: 'session_ended', status: res.status };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `http_${res.status}`, status: res.status };
    }
    info = await res.json();
  } catch (err) {
    return { ok: false, reason: 'daemon_unreachable', error: errorCode(err) };
  }
  if (typeof info?.manifest_url !== 'string' || !info.manifest_url.startsWith('/api/stream/sessions/')) return { ok: false, reason: 'bad_session_info' };
  const manifest = new URL(info.manifest_url, daemon).href;
  const kind = String(info.manifest_kind);
  const provider = typeof info.provider === 'string' ? info.provider : null;
  const host = targetHost(manifest);
  const deadline = performance.now() + maxSeconds * 1000;
  const left = () => Math.max(0.5, (deadline - performance.now()) / 1000);

  if (kind === 'file') {
    const r = await download(manifest, { maxBytes, maxSeconds, headers: { range: `bytes=0-${Math.floor(maxBytes) - 1}` }, fetchImpl });
    return {
      ok: r.ok,
      kind,
      host,
      provider,
      variant_bandwidth: null,
      segments_tried: 1,
      segments_ok: r.ok ? 1 : 0,
      statuses: { [String(r.upstream ?? r.status ?? r.error)]: 1 },
      bytes: r.bytes,
      seconds: r.seconds,
      mbps: r.mbps,
      ttfb_ms_median: r.ttfb_ms,
      error: r.error,
    };
  }
  if (kind !== 'hls') {
    const r = await download(manifest, { maxBytes: 1_000_000, maxSeconds: Math.min(maxSeconds, 5), fetchImpl });
    return { ok: false, kind, host, provider, reason: 'segments_not_measured', manifest_status: r.upstream ?? r.status, manifest_ttfb_ms: r.ttfb_ms, error: r.error };
  }

  let playlist = await fetchText(manifest, left(), fetchImpl);
  if (!playlist.ok) return { ok: false, kind, host, provider, reason: 'manifest_refused', status: playlist.upstream ?? playlist.status, error: playlist.error };
  let mediaUrl = manifest;
  let variantBandwidth = null;
  const variant = bestVariant(playlist.text, manifest);
  if (variant !== null) {
    variantBandwidth = variant.bandwidth;
    mediaUrl = variant.url;
    playlist = await fetchText(mediaUrl, left(), fetchImpl);
    if (!playlist.ok) return { ok: false, kind, host, provider, reason: 'playlist_refused', status: playlist.upstream ?? playlist.status, error: playlist.error };
  }
  const segments = playlistLines(playlist.text, mediaUrl);
  if (segments.length === 0) return { ok: false, kind, host, provider, reason: 'no_segments' };

  const statuses = {};
  const ttfbs = [];
  let bytes = 0;
  let seconds = 0;
  let tried = 0;
  let okCount = 0;
  let lastError = null;
  let segmentHost = null;
  for (let i = Math.floor(segments.length / 2); i < segments.length && performance.now() < deadline && bytes < maxBytes; i++) {
    const r = await download(segments[i], { maxBytes: maxBytes - bytes, maxSeconds: left(), fetchImpl });
    tried += 1;
    segmentHost ??= targetHost(segments[i]);
    const key = String(r.upstream ?? r.status ?? r.error);
    statuses[key] = (statuses[key] ?? 0) + 1;
    if (r.ttfb_ms !== null) ttfbs.push(r.ttfb_ms);
    if (r.ok) {
      okCount += 1;
      bytes += r.bytes;
      seconds += r.seconds ?? 0;
    } else {
      lastError = r.error ?? `http_${r.upstream ?? r.status}`;
    }
  }
  return {
    ok: okCount > 0,
    kind,
    host: segmentHost ?? host,
    playlist_host: host,
    provider,
    variant_bandwidth: variantBandwidth,
    segments_tried: tried,
    segments_ok: okCount,
    statuses,
    bytes,
    seconds: round(seconds, 3),
    mbps: mbps(bytes, seconds),
    ttfb_ms_median: median(ttfbs),
    error: lastError,
  };
}

/** How long `host` takes to answer its root, without any token: a far or slow host shows here even after the session ended. */
export async function probeHost(host, { scheme = 'https', maxSeconds = 5, fetchImpl = fetch } = {}) {
  if (!HOST.test(host)) return { ok: false, host, status: null, ttfb_ms: null, error: 'bad_host' };
  const started = performance.now();
  try {
    const res = await fetchImpl(`${scheme}://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(Math.ceil(maxSeconds * 1000)) });
    const ttfb = Math.round(performance.now() - started);
    await res.body?.cancel().catch(() => {});
    return { ok: true, host, status: res.status, ttfb_ms: ttfb, error: null };
  } catch (err) {
    return { ok: false, host, status: null, ttfb_ms: null, error: errorCode(err) };
  }
}

/** All three, in order. `measured_at` comes first: records the pass-through writes for these requests are later. */
export async function netcheck(o, fetchImpl = fetch) {
  const measured_at = new Date().toISOString();
  const reference = { url: o.reference, ...(await download(o.reference, { maxBytes: o.maxBytes, maxSeconds: o.maxSeconds, fetchImpl })) };
  let stream = null;
  let stream_skipped = null;
  if (o.session === null) stream_skipped = 'no_session';
  else if (o.daemon === null) stream_skipped = 'no_daemon';
  else stream = await measureStream({ daemon: o.daemon, session: o.session, maxBytes: o.maxBytes, maxSeconds: o.maxSeconds, fetchImpl });
  const host_probe = o.host === null ? null : await probeHost(o.host, { scheme: o.hostScheme, fetchImpl });
  return { measured_at, reference, stream, stream_skipped, host_probe };
}

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`netcheck: ${err.message}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(await netcheck(o), null, 2)}\n`);
}

function isMain() {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) await main(process.argv.slice(2));
