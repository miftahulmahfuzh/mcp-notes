# Phase 1: Stream evidence log and snapshot

**Plan set:** `STREAM_CACHE_AND_BUG_REPORT_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-125845-K7QM_code_analyzer.md`
**Satisfies:** R2 — every pass-through answer and every page log line is kept on disk per host, and a session's evidence can be copied into one folder
**Criteria:** R2.1, R2.2, R2.3, R2.4
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/directStream`, `src/http`, `web/src/stream`

---

## Goal

After this phase every answer the pass-through gives is written to `<dataDir>/movies/stream-evidence-<host>.jsonl`.
Each record holds the session, the stream host and the path with no query, the upstream status, the time to first byte,
the bytes, the duration and the throughput, or the error that ended it. The record is written by a counting stream once
the body ends or is cancelled. Nothing is buffered, and a write failure never reaches the answer. The player page posts
every log line it writes to the same log. `POST /api/stream/evidence/snapshot` copies one session's source, records and
page lines into a new folder and answers with its path. Phases 3 and 4 build on this.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/directStream/evidence.ts`:
  - Classes and functions: `StreamEvidence`, `observeForward`, `sessionSource`, `sessionRecord`, `playerRecord`, `refusedRecord`, `safeRecord`, `redactQueries`, `hostPath`, `parseEvidenceLine`, `evidenceLogPath`, `previousEvidenceLogPath`, `reportStamp`.
  - Types: `EvidenceSink`, `EvidenceRecord`, `RequestRecord`, `PlayerRecord`, `SessionRecord`, `EvidenceInput`, `SessionSource`, `SnapshotResult`, `StreamEvidenceOptions`, `PlayerLineInput`, `HostPath`.
  - Constants: `REQUEST_OUTCOMES`, `SESSION_EVENTS`, `EVIDENCE_MAX_BYTES` (5 MB), `EVIDENCE_TAIL_BYTES`, `MAX_PENDING_LINES`, `STREAM_REPORTS_SUBDIR` (`stream-reports`), `DEFAULT_EVIDENCE_LIMIT` (200), `MAX_EVIDENCE_LIMIT` (2000).
- `src/http/streamEvidenceApi.ts`: `streamEvidenceRoutes`, `eventsBody`, `snapshotBody`.
- `src/directStream/passThrough.ts`: `ForwardTrace`, `ForwardKind`, `newForwardTrace`.
- `src/directStream/sessions.ts`: `StreamSession.refreshes`, `SessionStore.peek(id)`.
- `src/directStream/service.ts`: `DirectStreamServiceOptions.evidence`, `DirectStreamWiring.evidence`, `DirectStreamService.evidenceSource(id)`.
- `src/deps.ts`: `AppDeps.streamEvidence?: StreamEvidence | null`.
- `web/src/stream/session.ts`: `PlayerLogLine`, `eventsUrl`, `postEvents`.
- Routes:
  - `POST /api/stream/sessions/:id/events`, same-origin only. Body `{lines: [{text, at?, stage?, position_s?, buffer_s?}]}`, 1 to 50 lines, `text` 1 to 2000 characters. Answers 200 `{ok: true, recorded}`. Errors: 400 `invalid_session`, `invalid_json` or `invalid_body`; 503 `direct_stream_off`. The session does not have to be live.
  - `POST /api/stream/evidence/snapshot`, same-origin only. Body `{session_id?: string | null}`; an empty body counts as `{}`. Answers 200 `{ok: true, dir, session_id, complete, records, player_lines}`. Errors: 400 `invalid_json` or `invalid_body`; 500 `snapshot_failed`; 503 `direct_stream_off`.
  - `GET /api/stream/evidence?session=&limit=`, read only, no Origin check. Answers 200 `{host, file, records}`, oldest first. Errors: 400 `invalid_session` or `invalid_limit`; 503 `direct_stream_off`.
- Files on disk, all on this host only:
  - `<dataDir>/movies/stream-evidence-<host>.jsonl`, one JSON record per line. When a write would push it past 5 MB it is renamed to `stream-evidence-<host>.1.jsonl`. Only that one previous file is kept, as in `HealthLog`.
  - `<dataDir>/movies/stream-reports/<YYYYMMDD-HHMMSS UTC>-<first 6 characters of the session id, or "none">[-N]/`, holding:
    - `session.json`: `{session_id, host, taken_at, live, source: SessionSource | null, sessions: SessionRecord[]}`
    - `evidence.jsonl`: the session's `request` and `session` records
    - `player.json`: `{session_id, lines: PlayerRecord[]}`
- Record shapes (`type` decides which):
  - `request`: `{type, at, session, provider, stream_host, path, range, kind: hls|dash|vtt|media|null, status (the stream host's, or null), answer (what the player got), ttfb_ms, bytes, duration_ms, kbps, redirects, outcome: end|aborted|error|refused, error}`
  - `player`: `{type, at, session, text, page_at, stage, position_s, buffer_s}`
  - `session`: `{type, at, session, ref, event: created|refreshed|refresh_failed, provider, manifest_kind, stream_host, attempts, refreshes, error}`

**Signature changes:**
- `forward(session, req, fetchImpl)` becomes `forward(session, req, fetchImpl, trace: ForwardTrace | null = null)`. The new parameter is optional, so existing callers do not change.
- `DirectStreamService.passThrough(id, req)` keeps its signature. It now records evidence through `observeForward`.

**Requires (from earlier phases):** nothing.

**Leaves alone (owned by others):**
- `web/src/stream/hlsEngine.ts`, `dashEngine.ts`, `nativeEngine.ts`, `engine.ts`, and the controller's stages (phase 2).
- `web/src/stream/StreamApp.tsx` and `stream.css`, and every UI component (phase 4).
- `claude/skills/report-stream-bug/` (phase 3).
- `src/directStream/report.ts`, `src/sessions/resume.ts`, and tmux (phase 4).
- `src/directStream/cache/*`, `src/db/schema.ts`, and `drizzle/` (phase 5).
- `DirectStreamService.play` (phase 6).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/passThrough.ts` | modify | `ForwardTrace` filled by `forward()`: final target, redirects, upstream status, header time, kind, notesd's own error |
| `src/directStream/evidence.ts` | create | the log (async, batched, fsync'd, rotated), record builders, `observeForward` counting transform, snapshot writer |
| `src/directStream/sessions.ts` | modify | `refreshes` on `StreamSession`; `SessionStore.peek` |
| `src/directStream/service.ts` | modify | `evidence` option; `passThrough` observed; `session` records on create/refresh; `evidenceSource`; wiring |
| `src/http/streamEvidenceApi.ts` | create | the three routes |
| `src/http/app.ts` | modify | mount `streamEvidenceRoutes` |
| `src/deps.ts` | modify | `AppDeps.streamEvidence` |
| `src/daemon.ts` | modify | build `StreamEvidence`, hand it to the service and deps, flush on stop |
| `web/src/stream/session.ts` | modify | `PlayerLogLine`, `eventsUrl`, `postEvents` |
| `web/src/stream/controller.ts` | modify | `note()` / `fail()` also send the line, batched per tick, with position and buffer ahead |
| `web/src/stream/dashEngine.test.tsx` | modify | count refresh POSTs by URL (the page now also POSTs events) |
| `web/src/stream/controller.test.tsx` | modify | new describe: the page log reaches the daemon |
| `tests/unit/directStream/evidence.test.ts` | create | log, rotation, write failure, observation outcomes, redaction, snapshot |
| `tests/unit/directStream/sessions.test.ts` | modify | refresh count and `peek` |
| `tests/integration/directStream.evidence.int.test.ts` | create | real pass-through + fixture host + routes + snapshot |
| `scripts/docs/httpRoutes.ts` | modify | the three route descriptions |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` (never by hand) |
| `docs/guide/streaming.md` | modify | "Stream evidence" subsection, answers rows, code table rows |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | evidence sub-feature, journey stages |
| `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh` | modify | stages `evidence`, `playerlog`, `snapshot`, `unwritable` |
| `.claude/skills/verify-notesd/scripts/stream/dash-expiry.steps.mjs` | modify | `DASH EVIDENCE PASS` block |

## Implementation Steps

Before anything: the worktree has no `node_modules`. Run `npm ci` in `/home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report` first.

**Shared files (reconciled).** This phase lands first; every later phase edits some of the same files
and quotes them as this phase leaves them: `src/directStream/service.ts` and `sessions.ts` (phase 6),
`src/deps.ts`, `src/daemon.ts`, `src/http/app.ts` (phases 4, 5, 6 insert next to this phase's lines),
`web/src/stream/session.ts` and `controller.ts` (phases 2, 4, 6), `web/src/stream/dashEngine.test.tsx`
(phase 2 keeps this phase's refresh-counting line), `scripts/docs/httpRoutes.ts`,
`docs/guide/streaming.md` and the verify-notesd feature map (every phase). Keep the names in this
plan's Interface Contract exactly: phases 3, 4 and 6 were reconciled against them. The generated
`docs/guide/reference/http-api.md` is only ever rewritten by `npm run docs:gen`.

### Step 1: `forward()` fills a trace
**File:** `src/directStream/passThrough.ts:1-167` (whole file)
**Change:** add `ForwardKind`, `ForwardTrace`, `newForwardTrace`, and a fourth optional parameter `trace`. Each early `jsonError` return now goes through `refuse()`, which writes `trace.error`. Nothing else changes in what `forward` answers.
**Code:**
```ts
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

/** What the answer carries: a rewritten playlist or manifest, a subtitle, or media streamed through. */
export type ForwardKind = 'hls' | 'dash' | 'vtt' | 'media';

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
 * session; everything else streams through as it arrives, with the stream host's status. `trace`,
 * when given, is filled in for the evidence log; the answer does not depend on it.
 */
export async function forward(session: StreamSession, req: ForwardRequest, fetchImpl: FetchLike, trace: ForwardTrace | null = null): Promise<Response> {
  const refuse = (status: number, error: string, message: string): Response => {
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
  const headers = upstreamHeaders(session.source.headers, req.range);
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
```
Keep the BOM character in `text.replace(/^﻿/, '')` exactly as it is in the current file. Copy that line from the existing source rather than retyping it.
**Impact:** none for existing callers. `readSubtitle` in `service.ts:294` still calls `forward` with three arguments.

### Step 2: `refreshes` and `peek` on sessions
**File:** `src/directStream/sessions.ts:15-30, 64-79, 90-109`
**Change:**
- Add `refreshes: number;` to `StreamSession`, directly after `refreshedAt: Date;` (line 28):
  ```ts
  /** Times a refresh replaced the source (a token expired); 0 for a fresh session. */
  refreshes: number;
  ```
- In `create()` (line 66-78), add `refreshes: 0,` to the object literal after `refreshedAt: at,`.
- Replace `replaceSource` (lines 104-109) with:
  ```ts
  /** A refresh: the new source, its hosts added to the ones the session already had. */
  replaceSource(session: StreamSession, source: ResolvedSource, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.attempts = attempts;
    for (const host of sourceHosts(source)) session.allowedHosts.add(host);
    session.refreshedAt = this.now();
    session.refreshes += 1;
  }
  ```
- Add after `get()` (after line 101):
  ```ts
  /** The live session with this id, without marking it used (a snapshot must not keep a session alive); null like get(). */
  peek(id: string): StreamSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    return this.now().getTime() >= this.expiresAt(session).getTime() ? null : session;
  }
  ```
**Impact:** sessions are only built through `SessionStore.create` (a grep for `allowedHosts:` finds no other place that writes one by hand), so the new field is always set.

### Step 3: The evidence module
**File:** `src/directStream/evidence.ts` (new)
**Change:** the log, the record builders, the observing wrapper around `forward`, and the snapshot.
**Code:**
```ts
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { forward, newForwardTrace, type FetchLike, type ForwardRequest } from './passThrough.js';
import { absoluteHttp } from './rewrite.js';
import type { StreamSession } from './sessions.js';
import { refLabel, type ManifestKind, type ResolveAttempt, type SourceAudio } from './types.js';

/**
 * Stream evidence (stream-cache-and-bug-report phase 1, R2). One JSON line per pass-through answer,
 * per line the player page posts, and per session made or refreshed, in
 * `<dataDir>/movies/stream-evidence-<host>.jsonl`. Rotated like the VLC health log (HealthLog in
 * src/movies/vlc/health.ts): past the cap the file becomes `.1.jsonl` and a new one starts.
 *
 * Unlike HealthLog, which fsyncs each line synchronously, this log is written in batches off the
 * answer's path: `record()` only queues a line, and a failed write is counted and logged at most once
 * a minute. Evidence never fails, delays or changes an answer (invariant 2).
 *
 * No signed address, token, cookie or captured header value is ever written (invariant 3):
 * addresses are kept as host and path, free text has its queries cut off by redactQueries, and the
 * captured headers appear by name only.
 */

export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
/** What a read of the log looks at: the newest bytes of the current file, then the previous one. */
export const EVIDENCE_TAIL_BYTES = 4 * 1024 * 1024;
/** Lines waiting for the disk past this are dropped (and counted) instead of growing memory. */
export const MAX_PENDING_LINES = 2000;
export const STREAM_REPORTS_SUBDIR = 'stream-reports';
export const DEFAULT_EVIDENCE_LIMIT = 200;
export const MAX_EVIDENCE_LIMIT = 2000;
/** A snapshot with no session copies at most this many of the newest records. */
const SNAPSHOT_MAX_RECORDS = 2000;
const PATH_MAX_CHARS = 300;
const TEXT_MAX_CHARS = 2000;
const WARN_EVERY_MS = 60_000;

export const REQUEST_OUTCOMES = ['end', 'aborted', 'error', 'refused'] as const;
export const SESSION_EVENTS = ['created', 'refreshed', 'refresh_failed'] as const;

const requestSchema = z.object({
  type: z.literal('request'),
  at: z.string(),
  session: z.string(),
  provider: z.string().nullable(),
  stream_host: z.string().nullable(),
  path: z.string().nullable(),
  range: z.string().nullable(),
  kind: z.enum(['hls', 'dash', 'vtt', 'media']).nullable(),
  status: z.number().int().nullable(),
  answer: z.number().int(),
  ttfb_ms: z.number().nullable(),
  bytes: z.number().int(),
  duration_ms: z.number(),
  kbps: z.number().nullable(),
  redirects: z.number().int(),
  outcome: z.enum(REQUEST_OUTCOMES),
  error: z.string().nullable(),
});

const playerSchema = z.object({
  type: z.literal('player'),
  at: z.string(),
  session: z.string(),
  text: z.string(),
  page_at: z.string().nullable(),
  stage: z.string().nullable(),
  position_s: z.number().nullable(),
  buffer_s: z.number().nullable(),
});

const sessionSchema = z.object({
  type: z.literal('session'),
  at: z.string(),
  session: z.string(),
  ref: z.string(),
  event: z.enum(SESSION_EVENTS),
  provider: z.string(),
  manifest_kind: z.string(),
  stream_host: z.string().nullable(),
  attempts: z.number().int(),
  refreshes: z.number().int(),
  error: z.string().nullable(),
});

const recordSchema = z.discriminatedUnion('type', [requestSchema, playerSchema, sessionSchema]);

export type RequestRecord = z.infer<typeof requestSchema>;
export type PlayerRecord = z.infer<typeof playerSchema>;
export type SessionRecord = z.infer<typeof sessionSchema>;
export type EvidenceRecord = z.infer<typeof recordSchema>;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];
export type SessionEvent = (typeof SESSION_EVENTS)[number];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A record before the log stamps its `at`. */
export type EvidenceInput = DistributiveOmit<EvidenceRecord, 'at'>;

/** Where evidence goes. StreamEvidence is the real one; `record` must return at once and never throw. */
export interface EvidenceSink {
  record(input: EvidenceInput): void;
}

/** Hands a record to the sink and swallows anything it throws: evidence never fails an answer. */
export function safeRecord(sink: EvidenceSink | null, input: EvidenceInput): void {
  if (sink === null) return;
  try {
    sink.record(input);
  } catch {
    // ignored on purpose (R2.4)
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Cuts the query and fragment off every address in free text (absolute, or a path such as the pass-through's). */
export function redactQueries(text: string): string {
  return text.replace(/((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1').slice(0, TEXT_MAX_CHARS);
}

export interface HostPath {
  host: string;
  path: string;
}

/** An http(s) address as host (with port) and path; never its query. Null for anything else. */
export function hostPath(url: string): HostPath | null {
  const abs = absoluteHttp(url);
  if (abs === null) return null;
  const u = new URL(abs);
  return { host: u.host.toLowerCase(), path: u.pathname.slice(0, PATH_MAX_CHARS) };
}

function safeHost(host: string): string {
  const s = host.replace(/[^A-Za-z0-9._-]/g, '_');
  return s === '' ? 'host' : s;
}

export function evidenceLogPath(dir: string, host: string): string {
  return path.join(dir, `stream-evidence-${safeHost(host)}.jsonl`);
}

export function previousEvidenceLogPath(dir: string, host: string): string {
  return path.join(dir, `stream-evidence-${safeHost(host)}.1.jsonl`);
}

/** `20261116-125845`: the UTC second a snapshot folder is named after. */
export function reportStamp(at: Date): string {
  return at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

/** One log line -> a record; null for a blank, torn or foreign line. */
export function parseEvidenceLine(line: string): EvidenceRecord | null {
  const text = line.trim();
  if (text === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = recordSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** What a snapshot keeps of a live session: no header value, no query, nothing that grants access. */
export interface SessionSource {
  session_id: string;
  ref: string;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  provider: string;
  embed: HostPath | null;
  manifest_kind: ManifestKind;
  manifest: HostPath | null;
  subtitles: Array<HostPath & { lang: string | null; label: string; format: string; source: string }>;
  best_height: number | null;
  en_subtitle: boolean;
  audio_lang: string | null;
  audio: SourceAudio | null;
  /** The names of the headers the resolve captured; never their values. */
  captured_headers: string[];
  attempts: ResolveAttempt[];
  hosts: string[];
  refreshes: number;
  created_at: string;
  refreshed_at: string;
  last_used_at: string;
  expires_at: string;
}

export function sessionSource(session: StreamSession, expiresAt: Date): SessionSource {
  const { ref, source } = session;
  const headers = source.headers;
  return {
    session_id: session.id,
    ref: refLabel(ref),
    kind: ref.kind,
    tmdb_id: ref.tmdbId,
    season: ref.kind === 'tv' ? ref.season : null,
    episode: ref.kind === 'tv' ? ref.episode : null,
    provider: source.provider,
    embed: hostPath(source.embed_url),
    manifest_kind: source.manifest_kind,
    manifest: hostPath(source.manifest_url),
    subtitles: source.subtitles.flatMap((t) => {
      const hp = hostPath(t.url);
      return hp === null ? [] : [{ ...hp, lang: t.lang, label: t.label, format: t.format, source: t.source }];
    }),
    best_height: source.best_height,
    en_subtitle: source.en_subtitle,
    audio_lang: session.audioLang,
    audio: source.audio ?? null,
    captured_headers: [
      ...(headers.referer !== null ? ['referer'] : []),
      ...(headers.origin !== null ? ['origin'] : []),
      ...(headers.user_agent !== null ? ['user_agent'] : []),
    ],
    attempts: session.attempts.map((a) => ({ ...a, detail: redactQueries(a.detail) })),
    hosts: [...session.allowedHosts].sort(),
    refreshes: session.refreshes,
    created_at: session.createdAt.toISOString(),
    refreshed_at: session.refreshedAt.toISOString(),
    last_used_at: session.lastUsedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

/** A session made, refreshed, or whose refresh failed: what the log keeps after the session is gone. */
export function sessionRecord(session: StreamSession, event: SessionEvent, error: string | null): EvidenceInput {
  return {
    type: 'session',
    session: session.id,
    ref: refLabel(session.ref),
    event,
    provider: session.source.provider,
    manifest_kind: session.source.manifest_kind,
    stream_host: hostPath(session.source.manifest_url)?.host ?? null,
    attempts: session.attempts.length,
    refreshes: session.refreshes,
    error: error === null ? null : redactQueries(error),
  };
}

/** What the player page posts for one line (validated by the events route). */
export interface PlayerLineInput {
  text: string;
  at?: string;
  stage?: string;
  position_s?: number | null;
  buffer_s?: number | null;
}

export function playerRecord(sessionId: string, line: PlayerLineInput): EvidenceInput {
  return {
    type: 'player',
    session: sessionId,
    text: redactQueries(line.text),
    page_at: line.at ?? null,
    stage: line.stage ?? null,
    position_s: line.position_s ?? null,
    buffer_s: line.buffer_s ?? null,
  };
}

/** A request notesd refused before forward() (an unknown or ended session). */
export function refusedRecord(sessionId: string, req: Pick<ForwardRequest, 'target' | 'range'>, answer: number, error: string): EvidenceInput {
  const hp = hostPath(req.target);
  return {
    type: 'request',
    session: sessionId,
    provider: null,
    stream_host: hp?.host ?? null,
    path: hp?.path ?? null,
    range: req.range,
    kind: null,
    status: null,
    answer,
    ttfb_ms: null,
    bytes: 0,
    duration_ms: 0,
    kbps: null,
    redirects: 0,
    outcome: 'refused',
    error,
  };
}

/**
 * forward(), observed (R2.1). The answer is the same Response forward() made, except that a body is
 * handed through a pull-driven stream that counts bytes as the player reads them (nothing is read
 * ahead or buffered). One record is written when the body ends, breaks off or is cancelled; a refusal
 * of notesd's own, or an answer without a body, is written at once. Without a sink this is forward().
 */
export async function observeForward(
  session: StreamSession,
  req: ForwardRequest,
  fetchImpl: FetchLike,
  sink: EvidenceSink | null,
  clock: () => number = () => performance.now(),
): Promise<Response> {
  if (sink === null) return forward(session, req, fetchImpl);
  const trace = newForwardTrace(clock);
  const started = clock();
  const res = await forward(session, req, fetchImpl, trace);
  let bytes = 0;
  let done = false;
  const finish = (outcome: RequestOutcome, error: string | null): void => {
    if (done) return;
    done = true;
    const end = clock();
    const where = hostPath(trace.target ?? req.target);
    const bodyMs = trace.headersAt === null ? null : Math.max(1, end - trace.headersAt);
    safeRecord(sink, {
      type: 'request',
      session: session.id,
      provider: session.source.provider,
      stream_host: where?.host ?? null,
      path: where?.path ?? null,
      range: req.range,
      kind: trace.kind,
      status: trace.upstreamStatus,
      answer: res.status,
      ttfb_ms: trace.headersAt === null ? null : Math.round(trace.headersAt - started),
      bytes,
      duration_ms: Math.round(end - started),
      kbps: bytes === 0 || bodyMs === null ? null : round1((bytes * 8) / bodyMs),
      redirects: trace.redirects,
      outcome,
      error: error === null ? null : redactQueries(error),
    });
  };
  if (trace.error !== null || res.body === null) {
    finish(trace.error === null ? 'end' : 'refused', trace.error);
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (req.signal.aborted) finish('aborted', 'the player went away');
          else finish('error', `the stream host broke off: ${messageOf(err)}`);
          controller.error(err);
          return;
        }
        if (chunk.done) {
          finish('end', null);
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        finish('aborted', 'the player went away');
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export interface StreamEvidenceOptions {
  /** `<dataDir>/movies`: the log and `stream-reports/` live here. */
  dir: string;
  /** This machine (os.hostname(), the movies service's host). */
  host: string;
  maxBytes?: number;
  /** The live session's source for a snapshot (DirectStreamService.evidenceSource); null once it ended. */
  source?: (sessionId: string) => SessionSource | null;
  /** The session of the stream on screen (StreamLive), for a snapshot asked without a session. */
  onScreen?: () => string | null;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface SnapshotResult {
  /** The new folder, absolute. */
  dir: string;
  session_id: string | null;
  /** True when the session was still live, so session.json holds its source. */
  complete: boolean;
  /** Request and session records written to evidence.jsonl. */
  records: number;
  /** Page lines written to player.json. */
  player_lines: number;
}

interface Tail {
  text: string;
  bytes: number;
  /** The whole file was read (no partial first line). */
  whole: boolean;
}

async function readLastBytes(file: string, max: number): Promise<Tail> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return { text: '', bytes: 0, whole: true };
  }
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, Math.max(0, max));
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, size - len);
    return { text: buf.toString('utf8'), bytes: len, whole: len === size };
  } catch {
    return { text: '', bytes: 0, whole: true };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** This host's stream evidence log and its snapshots. Held in AppDeps.streamEvidence. */
export class StreamEvidence implements EvidenceSink {
  readonly file: string;
  readonly previousFile: string;
  readonly reportsDir: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private pending: string[] = [];
  private flushing: Promise<void> | null = null;
  private failureCount = 0;
  private droppedCount = 0;
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: StreamEvidenceOptions) {
    this.file = evidenceLogPath(opts.dir, opts.host);
    this.previousFile = previousEvidenceLogPath(opts.dir, opts.host);
    this.reportsDir = path.join(opts.dir, STREAM_REPORTS_SUBDIR);
    this.maxBytes = opts.maxBytes ?? EVIDENCE_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.error(line));
  }

  get host(): string {
    return this.opts.host;
  }

  /** Records lost to a failed write. */
  get failures(): number {
    return this.failureCount;
  }

  /** Records dropped because the disk fell MAX_PENDING_LINES behind. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Queues one record (stamped with `at`) and returns at once; the disk is written in the background. Never throws. */
  record(input: EvidenceInput): void {
    try {
      if (this.pending.length >= MAX_PENDING_LINES) {
        this.droppedCount += 1;
        return;
      }
      this.pending.push(JSON.stringify({ type: input.type, at: this.now().toISOString(), ...input }));
      this.flushing ??= this.drain();
    } catch (err) {
      this.failureCount += 1;
      this.warn(err);
    }
  }

  /** Resolves when every record queued so far has been written or counted as lost. Never rejects. */
  async flushed(): Promise<void> {
    while (this.flushing !== null) await this.flushing;
  }

  /** The newest records, oldest first: the last `maxBytes` of the current file, then the previous one. */
  async readTail(maxBytes: number = EVIDENCE_TAIL_BYTES): Promise<EvidenceRecord[]> {
    const cur = await readLastBytes(this.file, maxBytes);
    let text = cur.text;
    let whole = cur.whole;
    if (cur.whole && cur.bytes < maxBytes) {
      const prev = await readLastBytes(this.previousFile, maxBytes - cur.bytes);
      if (prev.bytes > 0) {
        text = `${prev.text}${prev.text.endsWith('\n') ? '' : '\n'}${cur.text}`;
        whole = prev.whole;
      }
    }
    const lines = text.split('\n');
    if (!whole) lines.shift();
    const out: EvidenceRecord[] = [];
    for (const line of lines) {
      const r = parseEvidenceLine(line);
      if (r !== null) out.push(r);
    }
    return out;
  }

  /** GET /api/stream/evidence: the newest `limit` records, oldest first, of one session or of all. */
  async query(options: { session?: string | null; limit?: number } = {}): Promise<EvidenceRecord[]> {
    await this.flushed();
    const records = await this.readTail(EVIDENCE_TAIL_BYTES);
    const session = options.session ?? null;
    const mine = session === null ? records : records.filter((r) => r.session === session);
    return mine.slice(-(options.limit ?? DEFAULT_EVIDENCE_LIMIT));
  }

  /**
   * R2.3: a new folder under `stream-reports/` holding session.json (the live session's source, or
   * null once it ended), evidence.jsonl (its request and session records) and player.json (the
   * page's lines). Without a session id: the stream on screen, else the session of the newest record,
   * else none (the folder then holds the newest records of every session). Throws only when the
   * folder cannot be written.
   */
  async snapshot(sessionId: string | null): Promise<SnapshotResult> {
    await this.flushed();
    const records = await this.readTail(this.maxBytes * 2);
    const id = sessionId ?? this.opts.onScreen?.() ?? records.at(-1)?.session ?? null;
    const source = id === null ? null : (this.opts.source?.(id) ?? null);
    const mine = id === null ? records.slice(-SNAPSHOT_MAX_RECORDS) : records.filter((r) => r.session === id);
    const player = mine.filter((r): r is PlayerRecord => r.type === 'player');
    const trail = mine.filter((r) => r.type !== 'player');
    const takenAt = this.now();
    const dir = await this.newReportDir(takenAt, id);
    const sessions = trail.filter((r): r is SessionRecord => r.type === 'session');
    await writeFile(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ session_id: id, host: this.host, taken_at: takenAt.toISOString(), live: source !== null, source, sessions }, null, 2)}\n`,
    );
    await writeFile(path.join(dir, 'evidence.jsonl'), trail.map((r) => `${JSON.stringify(r)}\n`).join(''));
    await writeFile(path.join(dir, 'player.json'), `${JSON.stringify({ session_id: id, lines: player }, null, 2)}\n`);
    return { dir, session_id: id, complete: source !== null, records: trail.length, player_lines: player.length };
  }

  private async newReportDir(at: Date, id: string | null): Promise<string> {
    await mkdir(this.reportsDir, { recursive: true });
    const base = `${reportStamp(at)}-${id === null ? 'none' : id.slice(0, 6)}`;
    for (let n = 1; ; n += 1) {
      const dir = path.join(this.reportsDir, n === 1 ? base : `${base}-${n}`);
      try {
        await mkdir(dir);
        return dir;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw err;
      }
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const lines = this.pending.splice(0);
        try {
          await this.writeLines(lines);
        } catch (err) {
          this.failureCount += lines.length;
          this.warn(err);
        }
      }
    } finally {
      this.flushing = null;
    }
  }

  /** One batch: rotate first when it would pass maxBytes, repair a torn last line, append, fsync. */
  private async writeLines(lines: string[]): Promise<void> {
    const text = `${lines.join('\n')}\n`;
    await mkdir(this.opts.dir, { recursive: true });
    let size = 0;
    try {
      size = (await stat(this.file)).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(text) > this.maxBytes) {
      await rename(this.file, this.previousFile);
      size = 0;
    }
    const fh = await open(this.file, 'a+');
    try {
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) await fh.write('\n');
      }
      await fh.write(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private warn(err: unknown): void {
    const t = this.now().getTime();
    if (t - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = t;
    this.log(`[notesd] stream evidence: could not write ${this.file}: ${messageOf(err)} (${this.failureCount} record(s) lost so far)`);
  }
}
```
**Impact:** new module. It imports `passThrough.ts`, `rewrite.ts`, `sessions.ts` (types) and `types.ts`, and nothing from `src/movies`. That keeps to the rule at `service.ts:47`.

### Step 4: The service records through the evidence sink
**File:** `src/directStream/service.ts:9, 13, 129-144, 158-176, 195-202, 239-245, 310-314, 523-566`
**Change:**
- Imports. Line 9 stays. After line 9 add:
  ```ts
  import { observeForward, refusedRecord, safeRecord, sessionRecord, sessionSource, type EvidenceSink, type SessionSource } from './evidence.js';
  ```
  Line 13 becomes:
  ```ts
  import { SESSION_ID_PATTERN, SessionStore, type StreamSession } from './sessions.js';
  ```
- `DirectStreamServiceOptions` (lines 129-144): add after `log?: (line: string) => void;`:
  ```ts
  /** This host's stream evidence log (evidence.ts): every pass-through answer and session change is recorded into it. Null or unset: nothing is recorded. */
  evidence?: EvidenceSink | null;
  ```
- Class fields: after `private readonly fetchImpl: FetchLike;` (line 164) add `private readonly evidence: EvidenceSink | null;`. In the constructor, after `this.fetchImpl = ...` (line 175), add `this.evidence = opts.evidence ?? null;`.
- Replace `resolve` (lines 195-202):
  ```ts
  async resolve(input: StreamRefInput, options: { resumeS?: number | null; deadlineS?: number } = {}): Promise<StreamSession> {
    const ref = toStreamRef(input);
    const out = await this.resolveSource(ref, options.deadlineS);
    let resumeS = options.resumeS ?? null;
    const hook = this.opts.hooks?.resumeS;
    if (resumeS === null && hook !== undefined) resumeS = await this.hookValue('resumeS', () => hook(ref));
    const session = this.sessions.create(ref, out.source, out.attempts, resumeS, await this.audioLang(ref));
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }
  ```
- Replace `refresh` (lines 238-245):
  ```ts
  /** Resolves the session's title again (a token expired) and keeps the same id. A failure leaves the session as it was. */
  async refresh(id: string): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    let out: ResolvedOutput;
    try {
      out = await this.resolveSource(session.ref);
    } catch (err) {
      safeRecord(this.evidence, sessionRecord(session, 'refresh_failed', err instanceof DirectStreamError ? `${err.code}: ${err.message}` : messageOf(err)));
      throw err;
    }
    this.sessions.replaceSource(session, out.source, out.attempts);
    safeRecord(this.evidence, sessionRecord(session, 'refreshed', null));
    return this.sessionInfo(session);
  }
  ```
- Replace `passThrough` (lines 309-314), and add `evidenceSource` right after it:
  ```ts
  /**
   * GET /api/stream/sessions/:id/p: 403 `unknown_session` before anything else, then forward(),
   * observed for the evidence log (one record per answer, written when its body ends).
   */
  async passThrough(id: string, req: ForwardRequest): Promise<Response> {
    const session = this.sessions.get(id);
    if (session === null) {
      // A well-formed id the daemon no longer holds is evidence too ("the session ended").
      if (SESSION_ID_PATTERN.test(id)) safeRecord(this.evidence, refusedRecord(id, req, 403, 'unknown_session'));
      return jsonError(403, 'unknown_session', 'That stream session is unknown or has ended.');
    }
    return observeForward(session, req, this.fetchImpl, this.evidence);
  }

  /** A snapshot's view of a live session (no header value, no query); null when it ended. Does not mark it used. */
  evidenceSource(id: string): SessionSource | null {
    const session = this.sessions.peek(id);
    return session === null ? null : sessionSource(session, this.sessions.expiresAt(session));
  }
  ```
- `DirectStreamWiring` (lines 523-530): add after `hooks?: DirectStreamHooks;`:
  ```ts
  /** This host's stream evidence log; null or unset records nothing. */
  evidence?: EvidenceSink | null;
  ```
- `buildDirectStreamService` (lines 553-565): add `evidence: wiring.evidence ?? null,` after `hooks: wiring.hooks,`.

`ResolvedOutput` and `messageOf` are already in scope (lines 24 and 146).
**Impact:** the `evidence` option is optional. Every existing `new DirectStreamService({...})` in tests still compiles and records nothing.

### Step 5: The routes
**File:** `src/http/streamEvidenceApi.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { DEFAULT_EVIDENCE_LIMIT, MAX_EVIDENCE_LIMIT, playerRecord, type StreamEvidence } from '../directStream/evidence.js';
import { SESSION_ID_PATTERN } from '../directStream/sessions.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Stream evidence (stream-cache-and-bug-report phase 1): the player page's log lines, a snapshot of
 * one session's evidence, and a read of the log. The two POSTs write, so they are same-origin only;
 * a script without a browser (the /report-stream-bug skill) sends `Origin` equal to the address it
 * calls, e.g. `curl -H "Origin: http://127.0.0.1:7317" http://127.0.0.1:7317/...`. Mounted after
 * directStreamRoutes, whose `/api/stream/*` guard answers 503 direct_stream_off first.
 */

const MAX_SECONDS = 1_000_000;

const eventLine = z.object({
  text: z.string().min(1).max(2000),
  at: z.string().max(40).optional(),
  stage: z.string().max(40).optional(),
  position_s: z.number().finite().min(0).max(MAX_SECONDS).nullable().optional(),
  buffer_s: z.number().finite().min(0).max(MAX_SECONDS).nullable().optional(),
});

export const eventsBody = z.object({ lines: z.array(eventLine).min(1).max(50) });
export const snapshotBody = z.object({ session_id: z.string().regex(SESSION_ID_PATTERN).nullable().optional() });

const issues = (e: z.ZodError): string => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
const INVALID_SESSION = { error: 'invalid_session', message: 'That is not a stream session id.' } as const;
const INVALID_JSON = { error: 'invalid_json', message: 'The body is not JSON.' } as const;

export function streamEvidenceRoutes(deps: Pick<AppDeps, 'directStream' | 'streamEvidence'>): Hono {
  const r = new Hono();
  const evidence = (): StreamEvidence | null => ((deps.directStream ?? null) === null ? null : (deps.streamEvidence ?? null));

  // R2.2: the page's log lines, appended under the session id. The session need not be live: a page
  // whose session ended still says so.
  r.post('/api/stream/sessions/:id/events', sameOriginOnly, async (c) => {
    const ev = evidence();
    if (ev === null) return c.json(DIRECT_STREAM_OFF, 503);
    const id = c.req.param('id');
    if (!SESSION_ID_PATTERN.test(id)) return c.json(INVALID_SESSION, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(INVALID_JSON, 400);
    }
    const body = eventsBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: issues(body.error) }, 400);
    for (const line of body.data.lines) ev.record(playerRecord(id, line));
    return c.json({ ok: true, recorded: body.data.lines.length });
  });

  // R2.3: one session's evidence copied into a new folder on this host.
  r.post('/api/stream/evidence/snapshot', sameOriginOnly, async (c) => {
    const ev = evidence();
    if (ev === null) return c.json(DIRECT_STREAM_OFF, 503);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(INVALID_JSON, 400);
      }
    }
    const body = snapshotBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: issues(body.error) }, 400);
    try {
      return c.json({ ok: true, ...(await ev.snapshot(body.data.session_id ?? null)) });
    } catch (err) {
      return c.json({ error: 'snapshot_failed', message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Reads only: no Origin needed.
  r.get('/api/stream/evidence', async (c) => {
    const ev = evidence();
    if (ev === null) return c.json(DIRECT_STREAM_OFF, 503);
    const session = c.req.query('session') ?? null;
    if (session !== null && !SESSION_ID_PATTERN.test(session)) return c.json(INVALID_SESSION, 400);
    const limitText = c.req.query('limit');
    const limit = limitText === undefined ? DEFAULT_EVIDENCE_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_LIMIT) {
      return c.json({ error: 'invalid_limit', message: `limit must be a whole number from 1 to ${MAX_EVIDENCE_LIMIT}.` }, 400);
    }
    return c.json({ host: ev.host, file: ev.file, records: await ev.query({ session, limit }) });
  });

  return r;
}
```
**Impact:** new routes only.

### Step 6: Mount the routes
**File:** `src/http/app.ts:28, 107, 139`
**Change:**
- Line 28: after `import { streamProberRoutes } from './streamProberApi.js';` add `import { streamEvidenceRoutes } from './streamEvidenceApi.js';`.
- Docblock line 107: change `streamProberRoutes (direct-streaming phase 10: the prober's status), staticRoutes` to `streamProberRoutes (direct-streaming phase 10: the prober's status), streamEvidenceRoutes (stream bug reporting: the evidence log, page lines, snapshots), staticRoutes`.
- Line 139: after `app.route('/', streamProberRoutes(deps));` add `app.route('/', streamEvidenceRoutes(deps));`.

### Step 7: `AppDeps.streamEvidence`
**File:** `src/deps.ts:14, 73`
**Change:** after line 14 (`import type { StreamProberHandle } ...`) add `import type { StreamEvidence } from './directStream/evidence.js';`. After the `streamProber` field (line 73) add:
```ts
  /**
   * This host's stream evidence log (src/directStream/evidence.ts): every pass-through answer, the
   * player page's log lines, and snapshots under <dataDir>/movies/stream-reports/. The daemon builds
   * it with direct streaming; null or absent, the evidence routes answer 503 direct_stream_off.
   */
  streamEvidence?: StreamEvidence | null;
```

### Step 8: Daemon wiring
**File:** `src/daemon.ts:25, 31, 166-184, 205-222, 278-283`
**Change:**
- Line 25: `import { buildMoviesService } from './movies/service.js';` becomes `import { MOVIES_SUBDIR, buildMoviesService } from './movies/service.js';`.
- After line 31 (`import { buildDirectStreamService } ...`) add `import { StreamEvidence } from './directStream/evidence.js';`.
- Insert right before `const directStream = buildDirectStreamService(config, db, {` (line 170):
  ```ts
  // The stream on screen in the player page: built here so the evidence log can ask for it.
  const streamLive = movies === null ? null : new StreamLive();
  // Stream bug reporting phase 1: this machine's stream evidence log. The service records every
  // pass-through answer and session change into it; a snapshot reads the live session back through
  // the service (a closure: the service is built next) and the stream on screen through streamLive.
  const streamEvidence =
    movies === null || config.directStream?.enabled !== true
      ? null
      : new StreamEvidence({
          dir: join(config.dataDir, MOVIES_SUBDIR),
          host: movies.host,
          source: (id) => directStream?.evidenceSource(id) ?? null,
          onScreen: () => streamLive?.current()?.session_id ?? null,
        });
  ```
- In the `buildDirectStreamService(config, db, { ... })` wiring object, add `evidence: streamEvidence,` after `pageBase: ...,`.
- In `const deps: AppDeps = {...}` (line 205-222), replace `streamLive: movies === null ? null : new StreamLive(),` with `streamLive,` and add `streamEvidence,` after it.
- In `stop()`, after `await closeServer(server);` (line 281) add `await streamEvidence?.flushed();`. The records of answers that ended during shutdown reach the disk before the process exits.

**Impact:** with `NOTESD_DIRECT_STREAM=off` or movies off, `streamEvidence` is null and nothing is built.

### Step 9: The page posts its log lines (web)
**File:** `web/src/stream/session.ts:135, 199`
**Change:** after line 135 (`export const episodeUrl = ...`) add:
```ts
export const eventsUrl = (id: string): string => `${sessionUrl(id)}/events`;
```
After `postPosition` (after line 199) add:
```ts
/** One line of the page's log as it goes to the daemon's stream evidence log (POST /api/stream/sessions/:id/events). */
export interface PlayerLogLine {
  text: string;
  /** When the page wrote it (ISO 8601). */
  at: string;
  stage: string;
  /** The film's position then, in seconds; null when unknown. */
  position_s: number | null;
  /** Seconds buffered ahead of the position then; null when the browser cannot say. */
  buffer_s: number | null;
}

/**
 * Fire and forget, like postPosition: the daemon appends the lines to this machine's stream evidence
 * log. Every failure is ignored; the play never waits on it. Sent `keepalive`, so the lines of a page
 * that is closing still arrive.
 */
export async function postEvents(id: string, lines: readonly PlayerLogLine[], fetchImpl: typeof fetch): Promise<void> {
  if (lines.length === 0) return;
  try {
    await fetchImpl(eventsUrl(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines }),
      keepalive: true,
    });
  } catch {
    // ignored: evidence must never disturb the play
  }
}
```

**File:** `web/src/stream/controller.ts:2-12, 15-17, 107, 267-280`
**Change:**
- The import from `./session` (lines 2-12) gains `postEvents,` and `type PlayerLogLine,`:
  ```ts
  import {
    fetchSession,
    fetchText,
    postEvents,
    postPosition,
    refreshSession,
    SessionError,
    switchEpisode,
    type EpisodeNumber,
    type ManifestKind,
    type PlayerLogLine,
    type StreamSession,
  } from './session';
  ```
- After `const LOG_MAX = 20;` (line 17) add:
  ```ts
  /** The daemon refuses a longer line or a bigger batch (src/http/streamEvidenceApi.ts). */
  const EVENT_TEXT_MAX = 2_000;
  const EVENTS_PER_POST = 50;
  ```
- After `private disposed = false;` (line 107) add:
  ```ts
  /** Log lines waiting for this tick's post to the daemon, each under the session it was written in. */
  private unsent: { sessionId: string; line: PlayerLogLine }[] = [];
  ```
- Replace `note` and `fail` (lines 267-280) with these, and add the four private members after them:
  ```ts
  private note(line: string): void {
    this.set({ log: [...this.state.log, line].slice(-LOG_MAX) });
    this.send(line);
  }

  private fail(err: unknown): void {
    const code = err instanceof SessionError ? err.code : messageOf(err);
    this.set({
      stage: 'error',
      error: code,
      errors: [...this.state.errors, code].slice(-LOG_MAX),
      log: [...this.state.log, `error: ${code}`].slice(-LOG_MAX),
    });
    this.send(`error: ${code}`);
    this.settle();
  }

  /**
   * Every log line also goes to the daemon's stream evidence log (R2.2): errors, refreshes, subtitle
   * failures, and whatever else note() is given. Lines are batched per tick, so an error travels with
   * the line before it. Fire and forget: nothing here waits or throws.
   */
  private send(text: string): void {
    this.unsent.push({
      sessionId: this.sessionId,
      line: {
        text: text.slice(0, EVENT_TEXT_MAX),
        at: new Date().toISOString(),
        stage: this.state.stage,
        position_s: this.positionNow(),
        buffer_s: this.bufferAhead(),
      },
    });
    if (this.unsent.length === 1) queueMicrotask(this.flushUnsent);
  }

  private readonly flushUnsent = (): void => {
    const batch = this.unsent.splice(0);
    const bySession = new Map<string, PlayerLogLine[]>();
    for (const { sessionId, line } of batch) {
      const lines = bySession.get(sessionId) ?? [];
      lines.push(line);
      bySession.set(sessionId, lines);
    }
    for (const [sessionId, lines] of bySession) {
      for (let i = 0; i < lines.length; i += EVENTS_PER_POST) void postEvents(sessionId, lines.slice(i, i + EVENTS_PER_POST), this.deps.fetch);
    }
  };

  private positionNow(): number | null {
    const t = this.video.currentTime;
    return Number.isFinite(t) && t >= 0 ? round1(t) : null;
  }

  /** Seconds buffered ahead of the position: the end of the range holding it, else 0; null when the browser cannot say. */
  private bufferAhead(): number | null {
    try {
      const ranges = this.video.buffered;
      const t = this.video.currentTime;
      if (ranges === undefined || ranges === null || !Number.isFinite(t)) return null;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= t + 0.5 && t <= ranges.end(i)) return round1(Math.max(0, ranges.end(i) - t));
      }
      return 0;
    } catch {
      return null;
    }
  }
  ```
**Impact:**
- `window.notesdStream`, the stages and the overlay do not change.
- Phase 2's recovery lines reach the daemon without any extra code, because it writes them through `note()`.
- The page now makes one extra POST per tick in which it logged something.

### Step 10: Keep the DASH engine test counting only refreshes
**File:** `web/src/stream/dashEngine.test.tsx:118`
**Change:** the fake session numbers its manifest after the POSTs so far, and the page now also POSTs `/events`. Count only refreshes:
```ts
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ manifest_kind: 'dash', manifest_url: `${S1}/p?u=t${calls.filter((c) => c.method === 'POST' && c.url === `${S1}/refresh`).length + 1}.mpd` })),
```
**Impact:** the test proves what it proved before. Without this change it would expect `t2` and see `t3`.

### Step 11: Web test: the page log reaches the daemon
**File:** `web/src/stream/controller.test.tsx:512` (append at the end of the file)
**Code:**
```ts
describe('the page log reaches the daemon (R2.2)', () => {
  const lines = (t: ReturnType<typeof setup>) => t.posts(`${S1}/events`).flatMap((b) => (b as { lines: Record<string, unknown>[] }).lines);

  it('posts a refresh line and the error that followed, with the stage and the position', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({ error: 'no_source' }, 502),
      [`POST ${S1}/events`]: () => jsonResponse({ ok: true, recorded: 1 }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.media.currentTime = 42;
    t.fire('timeupdate');
    t.made[0].req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(t.controller.getState().stage).toBe('error'));
    await vi.waitFor(() => expect(lines(t)).toHaveLength(2));
    expect(lines(t)).toEqual([
      expect.objectContaining({ text: 'refresh after 403 at 42 s', stage: 'refreshing', position_s: 42 }),
      expect.objectContaining({ text: 'error: no_source', stage: 'error', position_s: 42 }),
    ]);
    expect(typeof lines(t)[0].at).toBe('string');
  });

  it('posts a fatal engine error as the page shows it', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onFatal('networkError fragLoadError');
    await vi.waitFor(() => expect(lines(t)).toHaveLength(1));
    expect(lines(t)[0]).toMatchObject({ text: 'error: networkError fragLoadError', stage: 'error' });
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'networkError fragLoadError' });
  });

  it('a daemon that refuses the lines changes nothing on the page', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/events`]: () => {
        throw new Error('daemon gone');
      },
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onFatal('networkError fragLoadError');
    await vi.waitFor(() => expect(t.posts(`${S1}/events`)).toHaveLength(1));
    expect(t.controller.getState()).toMatchObject({ stage: 'error', errors: ['networkError fragLoadError'] });
  });
});
```
`routeFetch` (`web/src/testing/streamFakes.ts:69`) records the call before it runs the route, so a route that throws still counts as a POST, and `postEvents` swallows the rejection.

### Step 12: Unit tests for the evidence module
**File:** `tests/unit/directStream/evidence.test.ts` (new)
**Code:**
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PENDING_LINES,
  StreamEvidence,
  observeForward,
  playerRecord,
  redactQueries,
  sessionSource,
  type EvidenceRecord,
  type EvidenceSink,
  type RequestRecord,
} from '../../../src/directStream/evidence.js';
import type { FetchLike, ForwardRequest } from '../../../src/directStream/passThrough.js';
import { SessionStore, type StreamSession } from '../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 787 };
const SOURCE: ResolvedSource = {
  provider: 'HyperLink',
  embed_url: 'https://hyper.example/tv/37854/18/787?key=EMBEDSECRET',
  manifest_url: 'https://cdn.example:8443/hls/master.m3u8?token=MANIFESTSECRET',
  manifest_kind: 'hls',
  headers: { referer: 'https://hyper.example/', origin: 'https://hyper.example', user_agent: 'Chrome/130 HEADERSECRET' },
  subtitles: [{ url: 'https://subs.example/en.vtt?sig=SUBSECRET', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
  best_height: 1080,
  en_subtitle: true,
  took_s: 3.1,
};
const SEG = 'https://cdn.example:8443/hls/720/seg-00042.ts?token=SEGSECRET';
/** Nothing of these may ever reach the disk: queries, header values. */
const SECRETS = ['EMBEDSECRET', 'MANIFESTSECRET', 'HEADERSECRET', 'SUBSECRET', 'SEGSECRET', 'ATTEMPTSECRET', 'https://hyper.example'];

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'stream-evidence-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function liveSession(): { store: SessionStore; session: StreamSession } {
  const store = new SessionStore();
  const session = store.create(REF, SOURCE, [
    { provider: 'VidFast', outcome: 'bot_check', took_s: 1.2, detail: 'refused https://vidfast.example/e/1?t=ATTEMPTSECRET' },
    { provider: 'HyperLink', outcome: 'resolved', took_s: 3.1, detail: '' },
  ]);
  return { store, session };
}

function request(target: string, over: Partial<ForwardRequest> = {}): ForwardRequest {
  return { target, range: null, vtt: false, signal: new AbortController().signal, ...over };
}

function answering(make: () => Response | Promise<Response>): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(url);
      return make();
    },
  };
}

/** A body of the given chunk sizes that then closes, breaks off, or never ends. */
function chunked(sizes: number[], end: 'close' | 'error' | 'hold' = 'close'): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < sizes.length) {
        c.enqueue(new Uint8Array(sizes[i++]));
        return;
      }
      if (end === 'close') c.close();
      else if (end === 'error') c.error(new Error('socket hang up'));
      else return new Promise<void>(() => undefined);
    },
  });
}

async function logged(ev: StreamEvidence): Promise<EvidenceRecord[]> {
  await ev.flushed();
  return ev.readTail();
}

const requests = (records: EvidenceRecord[]): RequestRecord[] => records.filter((r): r is RequestRecord => r.type === 'request');

describe('observeForward (R2.1)', () => {
  it('records one line per answer: host and path without the query, status, first byte, bytes, duration and throughput', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl, urls } = answering(() => new Response(chunked([400, 600]), { status: 206, headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-999/5000' } }));
    const res = await observeForward(session, request(SEG, { range: 'bytes=0-999' }), fetchImpl, ev);
    expect(res.status).toBe(206);
    expect(res.headers.get('x-notesd-upstream')).toBe('206');
    expect(res.headers.get('content-range')).toBe('bytes 0-999/5000');
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(urls).toEqual([SEG]);
    const recs = requests(await logged(ev));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      session: session.id,
      provider: 'HyperLink',
      stream_host: 'cdn.example:8443',
      path: '/hls/720/seg-00042.ts',
      range: 'bytes=0-999',
      kind: 'media',
      status: 206,
      answer: 206,
      bytes: 1000,
      redirects: 0,
      outcome: 'end',
      error: null,
    });
    expect(recs[0].ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(recs[0].duration_ms).toBeGreaterThanOrEqual(recs[0].ttfb_ms ?? 0);
    expect(recs[0].kbps).toBeGreaterThan(0);
    expect(await readFile(ev.file, 'utf8')).not.toContain('SEGSECRET');
  });

  it('counts a playlist after its rewrite and marks it hls', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg-1.ts\n';
    const { fetchImpl } = answering(() => new Response(playlist, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
    const res = await observeForward(session, request('https://cdn.example:8443/hls/720/index.m3u8?token=SEGSECRET'), fetchImpl, ev);
    const text = await res.text();
    expect(text).toContain(`/api/stream/sessions/${session.id}/p?u=`);
    const [rec] = requests(await logged(ev));
    expect(rec).toMatchObject({ kind: 'hls', path: '/hls/720/index.m3u8', status: 200, outcome: 'end', bytes: Buffer.byteLength(text) });
  });

  it('records the player going away mid-body as aborted, with the bytes it got', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl } = answering(() => new Response(chunked([500], 'hold'), { status: 200 }));
    const res = await observeForward(session, request(SEG), fetchImpl, ev);
    const reader = res.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(500);
    await reader.cancel();
    const [rec] = requests(await logged(ev));
    expect(rec).toMatchObject({ outcome: 'aborted', bytes: 500, status: 200, error: 'the player went away' });
  });

  it('records a stream host that breaks off mid-body as an error, and the player sees it break', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl } = answering(() => new Response(chunked([300], 'error'), { status: 200 }));
    const res = await observeForward(session, request(SEG), fetchImpl, ev);
    await expect(res.arrayBuffer()).rejects.toThrow();
    const [rec] = requests(await logged(ev));
    expect(rec).toMatchObject({ outcome: 'error', bytes: 300 });
    expect(rec.error).toContain('socket hang up');
  });

  it("records notesd's own refusals at once: a foreign host (nothing fetched) and a host that does not answer", async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl, urls } = answering(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const foreign = await observeForward(session, request('https://evil.example/x.ts?token=SEGSECRET'), fetchImpl, ev);
    expect(foreign.status).toBe(403);
    expect(urls).toEqual([]);
    const silent = await observeForward(session, request(SEG), fetchImpl, ev);
    expect(silent.status).toBe(502);
    const recs = requests(await logged(ev));
    expect(recs[0]).toMatchObject({ outcome: 'refused', answer: 403, status: null, stream_host: 'evil.example', path: '/x.ts', ttfb_ms: null });
    expect(recs[0].error).toMatch(/^forbidden_host: /);
    expect(recs[1]).toMatchObject({ outcome: 'refused', answer: 502, status: null, stream_host: 'cdn.example:8443', ttfb_ms: null });
    expect(recs[1].error).toBe('upstream_error: The stream host did not answer: connect ECONNREFUSED');
    expect(await readFile(ev.file, 'utf8')).not.toContain('SEGSECRET');
  });
});

describe('the evidence log (R2.4)', () => {
  it('record() returns before anything touches the disk', async () => {
    const ev = new StreamEvidence({ dir: path.join(tmp, 'movies'), host: 'laptop' });
    ev.record(playerRecord('S'.repeat(32), { text: 'error: x' }));
    expect(existsSync(ev.file)).toBe(false);
    await ev.flushed();
    expect(existsSync(ev.file)).toBe(true);
  });

  it('rotates into .1.jsonl past its cap, like the VLC health log, and reads across both files', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop', maxBytes: 1500 });
    expect(path.basename(ev.file)).toBe('stream-evidence-laptop.jsonl');
    expect(path.basename(ev.previousFile)).toBe('stream-evidence-laptop.1.jsonl');
    for (let i = 0; i < 20; i += 1) {
      ev.record(playerRecord('S'.repeat(32), { text: `line ${i} ${'x'.repeat(100)}` }));
      await ev.flushed();
    }
    expect(existsSync(ev.previousFile)).toBe(true);
    expect((await stat(ev.file)).size).toBeLessThanOrEqual(1500);
    const numbers = (await ev.readTail()).map((r) => (r.type === 'player' ? Number(r.text.split(' ')[1]) : -1));
    expect(numbers.at(-1)).toBe(19);
    expect(numbers).toEqual(numbers.map((_, k) => 20 - numbers.length + k));
  });

  it('repairs a torn last line before it appends', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    await writeFile(ev.file, '{"type":"player","at":"2026');
    ev.record(playerRecord('S'.repeat(32), { text: 'after the crash' }));
    const recs = await logged(ev);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ type: 'player', text: 'after the crash' });
  });

  it('a log that cannot be written never fails or holds up an answer, and says so once a minute', async () => {
    const blocker = path.join(tmp, 'blocker');
    await writeFile(blocker, 'not a folder');
    const warnings: string[] = [];
    const ev = new StreamEvidence({ dir: path.join(blocker, 'movies'), host: 'laptop', log: (l) => warnings.push(l) });
    const { session } = liveSession();
    const { fetchImpl } = answering(() => new Response(chunked([1000]), { status: 200 }));
    const res = await observeForward(session, request(SEG), fetchImpl, ev);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    await expect(ev.flushed()).resolves.toBeUndefined();
    expect(ev.failures).toBe(1);
    expect(warnings).toEqual([expect.stringContaining('[notesd] stream evidence: could not write')]);
    ev.record(playerRecord(session.id, { text: 'again' }));
    await ev.flushed();
    expect(ev.failures).toBe(2);
    expect(warnings).toHaveLength(1);
    // A sink that throws is ignored just the same.
    const throwing: EvidenceSink = {
      record: () => {
        throw new Error('disk on fire');
      },
    };
    const again = await observeForward(session, request(SEG), fetchImpl, throwing);
    expect((await again.arrayBuffer()).byteLength).toBe(1000);
  });

  it('drops lines past its backlog instead of growing without bound', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    for (let i = 0; i < MAX_PENDING_LINES + 10; i += 1) ev.record(playerRecord('S'.repeat(32), { text: `l${i}` }));
    expect(ev.dropped).toBeGreaterThan(0);
    await ev.flushed();
  });
});

describe('what evidence keeps of addresses and sessions (invariant 3)', () => {
  it('cuts the query off every address in free text', () => {
    expect(redactQueries('fragLoadError https://cdn.example/a/seg-1.ts?token=abc&e=1 at 61 s')).toBe('fragLoadError https://cdn.example/a/seg-1.ts at 61 s');
    expect(redactQueries('GET /api/stream/sessions/abc/p?u=https%3A%2F%2Fcdn%2Fx.ts%3Ftoken%3Dabc failed')).toBe('GET /api/stream/sessions/abc/p failed');
    expect(redactQueries('what? nothing to cut')).toBe('what? nothing to cut');
  });

  it("keeps a session's source as hosts and paths, header names only, and its refreshes", () => {
    const { store, session } = liveSession();
    store.replaceSource(session, SOURCE, session.attempts);
    const src = sessionSource(session, store.expiresAt(session));
    expect(src).toMatchObject({
      provider: 'HyperLink',
      ref: 'TMDB tv 37854 S18E787',
      embed: { host: 'hyper.example', path: '/tv/37854/18/787' },
      manifest: { host: 'cdn.example:8443', path: '/hls/master.m3u8' },
      subtitles: [{ host: 'subs.example', path: '/en.vtt', lang: 'en' }],
      captured_headers: ['referer', 'origin', 'user_agent'],
      refreshes: 1,
    });
    expect(src.hosts).toEqual(['cdn.example:8443', 'subs.example']);
    expect(src.attempts[0].detail).toBe('refused https://vidfast.example/e/1');
    const text = JSON.stringify(src);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe('snapshot (R2.3)', () => {
  it("writes the session's source, its records and the page's lines into one new folder", async () => {
    const { store, session } = liveSession();
    const other = store.create(REF, SOURCE, []);
    const ev = new StreamEvidence({
      dir: tmp,
      host: 'laptop',
      source: (id) => {
        const s = store.peek(id);
        return s === null ? null : sessionSource(s, store.expiresAt(s));
      },
      now: () => new Date('2026-11-16T12:58:45Z'),
    });
    const { fetchImpl } = answering(() => new Response(chunked([1000]), { status: 200 }));
    await (await observeForward(session, request(SEG), fetchImpl, ev)).arrayBuffer();
    await (await observeForward(other, request(SEG), fetchImpl, ev)).arrayBuffer();
    ev.record(playerRecord(session.id, { text: 'error: networkError fragLoadError https://cdn.example:8443/x.ts?token=SEGSECRET', stage: 'error', position_s: 61.2, buffer_s: 0 }));
    const snap = await ev.snapshot(session.id);
    expect(snap).toEqual({
      dir: path.join(tmp, 'stream-reports', `20261116-125845-${session.id.slice(0, 6)}`),
      session_id: session.id,
      complete: true,
      records: 1,
      player_lines: 1,
    });
    expect((await readdir(snap.dir)).sort()).toEqual(['evidence.jsonl', 'player.json', 'session.json']);
    const sessionJson = JSON.parse(await readFile(path.join(snap.dir, 'session.json'), 'utf8')) as Record<string, unknown>;
    expect(sessionJson).toMatchObject({ session_id: session.id, host: 'laptop', live: true, source: { provider: 'HyperLink', refreshes: 0 } });
    const trail = (await readFile(path.join(snap.dir, 'evidence.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(trail).toEqual([expect.objectContaining({ type: 'request', session: session.id, path: '/hls/720/seg-00042.ts' })]);
    const player = JSON.parse(await readFile(path.join(snap.dir, 'player.json'), 'utf8')) as { lines: Record<string, unknown>[] };
    expect(player.lines).toEqual([expect.objectContaining({ text: 'error: networkError fragLoadError https://cdn.example:8443/x.ts', position_s: 61.2 })]);
    const files = await Promise.all((await readdir(snap.dir)).map((f) => readFile(path.join(snap.dir, f), 'utf8')));
    for (const secret of SECRETS) expect(files.join('\n')).not.toContain(secret);
    // A second snapshot in the same second gets its own folder.
    expect((await ev.snapshot(session.id)).dir).toBe(`${snap.dir}-2`);
  });

  it('a session that has ended leaves its log records, and the snapshot says it is not complete', async () => {
    const { session } = liveSession();
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop', source: () => null });
    const { fetchImpl } = answering(() => new Response(chunked([10]), { status: 200 }));
    await (await observeForward(session, request(SEG), fetchImpl, ev)).arrayBuffer();
    const snap = await ev.snapshot(session.id);
    expect(snap).toMatchObject({ session_id: session.id, complete: false, records: 1, player_lines: 0 });
    expect(JSON.parse(await readFile(path.join(snap.dir, 'session.json'), 'utf8'))).toMatchObject({ live: false, source: null });
  });

  it("without a session id: the stream on screen, else the newest record's session, else none", async () => {
    let onScreen: string | null = null;
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop', onScreen: () => onScreen });
    const none = await ev.snapshot(null);
    expect(none).toMatchObject({ session_id: null, complete: false, records: 0, player_lines: 0 });
    expect(path.basename(none.dir)).toMatch(/^\d{8}-\d{6}-none$/);
    ev.record(playerRecord('B'.repeat(32), { text: 'x' }));
    expect((await ev.snapshot(null)).session_id).toBe('B'.repeat(32));
    onScreen = 'C'.repeat(32);
    expect((await ev.snapshot(null)).session_id).toBe('C'.repeat(32));
  });
});
```

### Step 13: Session store test
**File:** `tests/unit/directStream/sessions.test.ts:75` (inside `describe('SessionStore')`, after the test `'drops the least recently used session past the cap'`, before its closing `});` on line 76)
**Code:**
```ts
  it('counts refreshes, and peek() reads a session without keeping it alive', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const s = store.create(REF, SOURCE, []);
    expect(s.refreshes).toBe(0);
    store.replaceSource(s, SOURCE, []);
    store.replaceSource(s, SOURCE, []);
    expect(s.refreshes).toBe(2);
    c.advance(SESSION_IDLE_MS - 1000);
    expect(store.peek(s.id)).toBe(s);
    c.advance(1000);
    expect(store.peek(s.id)).toBeNull();
    expect(store.peek('nope')).toBeNull();
  });
```
(`SESSION_IDLE_MS` is already imported at line 2.)

### Step 14: Integration test: real pass-through, fixture host, routes, snapshot
**File:** `tests/integration/directStream.evidence.int.test.ts` (new)
**Code:**
```ts
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { StreamEvidence, type EvidenceRecord } from '../../src/directStream/evidence.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { directStreamScriptRunner } from '../../src/directStream/runner.js';
import { DirectStreamService, type SessionInfo } from '../../src/directStream/service.js';
import { directStreamRoutes } from '../../src/http/directStreamApi.js';
import { streamEvidenceRoutes } from '../../src/http/streamEvidenceApi.js';
// @ts-expect-error -- plain .mjs fixture without type declarations
import { startUpstream } from '../fixtures/direct-stream/upstream.mjs';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/direct-stream');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.mjs');
const SAME_ORIGIN = { origin: 'http://localhost' };
const SEED = [
  { name: 'Alpha', movie: 'https://alpha.example/movie/{id}', en_subtitle: true },
  { name: 'Bravo', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}' },
];

interface Upstream {
  origin: string;
  altOrigin: string;
  requests: unknown[];
  close(): Promise<void>;
}

let db: Db;
let up: Upstream;
let fakeDir: string;
let dataDir: string;
let evidence: StreamEvidence;
let app: Hono;

const through = (sid: string, u: string): string => `/api/stream/sessions/${sid}/p?u=${encodeURIComponent(u)}`;
const post = (p: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> =>
  Promise.resolve(app.request(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

async function play(): Promise<SessionInfo> {
  const res = await post('/api/stream/play', { kind: 'movie', tmdb_id: 550 });
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: SessionInfo }).session;
}

async function records(query: string): Promise<EvidenceRecord[]> {
  const res = await app.request(`/api/stream/evidence?${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { records: EvidenceRecord[] }).records;
}

beforeAll(async () => {
  db = openTestDb();
  up = (await startUpstream()) as Upstream;
  fakeDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-evidence-'));
  await writeFile(path.join(fakeDir, 'upstream.json'), JSON.stringify({ origin: up.origin, alt_origin: up.altOrigin }));
  await writeFile(path.join(fakeDir, 'seed.json'), JSON.stringify(SEED));
  process.env.DIRECT_STREAM_FAKE_DIR = fakeDir;
});

afterAll(async () => {
  delete process.env.DIRECT_STREAM_FAKE_DIR;
  await up.close();
  await rm(fakeDir, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  await rm(path.join(fakeDir, 'calls.jsonl'), { force: true });
  await writeFile(path.join(fakeDir, 'mode'), 'hls\n');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-evidence-data-'));
  let svc: DirectStreamService | null = null;
  evidence = new StreamEvidence({ dir: dataDir, host: 'host-a', source: (id) => svc?.evidenceSource(id) ?? null });
  svc = new DirectStreamService({
    repo: new DirectStreamRepo(db),
    runner: directStreamScriptRunner({ cliPath: FAKE_CLI }),
    host: 'host-a',
    seedFile: path.join(fakeDir, 'seed.json'),
    pageBase: () => 'http://localhost:4321',
    evidence,
    log: () => undefined,
  });
  await svc.syncSeed();
  app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  app.route('/', streamEvidenceRoutes({ directStream: svc, streamEvidence: evidence }));
});

describe('the evidence log through the real pass-through (R2.1)', () => {
  it('records every answer with host and path, never the query, and an ended session as refused', async () => {
    const session = await play();
    const sid = session.session_id;
    expect((await app.request(session.manifest_url)).status).toBe(200);
    await (await app.request(session.manifest_url)).text();
    const seg = await app.request(through(sid, `${up.origin}/hls/720/seg1.ts?token=SECRET123`), { headers: { range: 'bytes=0-99' } });
    expect(seg.status).toBe(206);
    expect((await seg.arrayBuffer()).byteLength).toBe(100);
    const gone = 'A'.repeat(32);
    expect((await app.request(through(gone, `${up.origin}/hls/master.m3u8`))).status).toBe(403);

    const mine = await records(`session=${sid}&limit=50`);
    const host = new URL(up.origin).host;
    expect(mine.filter((r) => r.type === 'session')).toEqual([expect.objectContaining({ event: 'created', provider: session.provider, stream_host: host })]);
    const reqs = mine.filter((r) => r.type === 'request');
    expect(reqs.find((r) => r.path === '/hls/master.m3u8')).toMatchObject({ kind: 'hls', status: 200, answer: 200, outcome: 'end', stream_host: host, provider: session.provider });
    const segRec = reqs.find((r) => r.path === '/hls/720/seg1.ts');
    expect(segRec).toMatchObject({ kind: 'media', status: 206, answer: 206, bytes: 100, range: 'bytes=0-99', outcome: 'end' });
    expect(typeof (segRec as { ttfb_ms: unknown }).ttfb_ms).toBe('number');
    expect(typeof (segRec as { kbps: unknown }).kbps).toBe('number');
    expect(await records(`session=${gone}`)).toEqual([expect.objectContaining({ type: 'request', outcome: 'refused', answer: 403, error: 'unknown_session' })]);
    const onDisk = await readFile(evidence.file, 'utf8');
    expect(onDisk).not.toContain('SECRET123');
    expect(onDisk).not.toContain('FixtureChrome');
  });
});

describe('the page log (R2.2)', () => {
  it('appends posted lines under the session id, queries cut off; same-origin only', async () => {
    const session = await play();
    const sid = session.session_id;
    const line = { text: `error: networkError fragLoadError ${through(sid, `${up.origin}/hls/720/seg1.ts?token=SECRET9`)}`, stage: 'error', position_s: 61.2, buffer_s: 0, at: '2026-11-16T05:58:45.000Z' };
    expect((await post(`/api/stream/sessions/${sid}/events`, { lines: [line] }, {})).status).toBe(403);
    const res = await post(`/api/stream/sessions/${sid}/events`, { lines: [line] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 1 });
    const player = (await records(`session=${sid}`)).filter((r) => r.type === 'player');
    expect(player).toEqual([
      expect.objectContaining({ text: `error: networkError fragLoadError /api/stream/sessions/${sid}/p`, stage: 'error', position_s: 61.2, buffer_s: 0, page_at: line.at }),
    ]);
    expect((await post(`/api/stream/sessions/${sid}/events`, { lines: [] })).status).toBe(400);
    expect(((await (await post('/api/stream/sessions/nope/events', { lines: [line] })).json()) as { error: string }).error).toBe('invalid_session');
  });
});

describe('snapshot (R2.3)', () => {
  it("writes the live session's source, its records and the page's lines into one new folder", async () => {
    const session = await play();
    const sid = session.session_id;
    await (await app.request(session.manifest_url)).text();
    expect((await post(`/api/stream/sessions/${sid}/events`, { lines: [{ text: 'refresh after 403 at 100 s', stage: 'refreshing' }] })).status).toBe(200);
    expect((await post(`/api/stream/sessions/${sid}/refresh`, {})).status).toBe(200);
    expect((await post('/api/stream/evidence/snapshot', { session_id: sid }, {})).status).toBe(403);

    const res = await post('/api/stream/evidence/snapshot', { session_id: sid });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { ok: true; dir: string; session_id: string; complete: boolean; records: number; player_lines: number };
    expect(snap).toMatchObject({ ok: true, session_id: sid, complete: true, player_lines: 1 });
    expect(path.dirname(snap.dir)).toBe(path.join(dataDir, 'stream-reports'));
    expect(path.basename(snap.dir)).toMatch(new RegExp(`^\\d{8}-\\d{6}-${sid.slice(0, 6).replace(/[-_]/g, '\\$&')}$`));
    expect((await readdir(snap.dir)).sort()).toEqual(['evidence.jsonl', 'player.json', 'session.json']);
    const sessionJson = JSON.parse(await readFile(path.join(snap.dir, 'session.json'), 'utf8')) as {
      live: boolean;
      source: { provider: string; attempts: unknown[]; hosts: string[]; refreshes: number; captured_headers: string[] };
      sessions: { event: string }[];
    };
    expect(sessionJson.live).toBe(true);
    expect(sessionJson.source.provider).toBe(session.provider);
    expect(sessionJson.source.attempts).toHaveLength(2);
    expect(sessionJson.source.hosts).toContain(new URL(up.origin).host);
    expect(sessionJson.source.refreshes).toBe(1);
    expect(sessionJson.source.captured_headers).toEqual(['referer', 'origin', 'user_agent']);
    expect(sessionJson.sessions.map((s) => s.event)).toEqual(['created', 'refreshed']);
    const trail = (await readFile(path.join(snap.dir, 'evidence.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { session: string; type: string });
    expect(trail.every((r) => r.session === sid && r.type !== 'player')).toBe(true);
    expect(trail.some((r) => r.type === 'request')).toBe(true);
    const files = await Promise.all((await readdir(snap.dir)).map((f) => readFile(path.join(snap.dir, f), 'utf8')));
    expect(files.join('\n')).not.toContain('FixtureChrome');
    expect(files.join('\n')).not.toContain('https://embed.fixture/');

    const ended = (await (await post('/api/stream/evidence/snapshot', { session_id: 'B'.repeat(32) })).json()) as { complete: boolean; records: number };
    expect(ended).toMatchObject({ complete: false, records: 0 });
    const newest = (await (await post('/api/stream/evidence/snapshot', {})).json()) as { session_id: string };
    expect(newest.session_id).toBe(sid);
    expect((await post('/api/stream/evidence/snapshot', { session_id: 'bad' })).status).toBe(400);
  });
});

describe('GET /api/stream/evidence', () => {
  it('validates its query and keeps the newest records', async () => {
    const session = await play();
    await (await app.request(session.manifest_url)).text();
    expect((await app.request('/api/stream/evidence?limit=0')).status).toBe(400);
    expect((await app.request('/api/stream/evidence?limit=2001')).status).toBe(400);
    expect((await app.request('/api/stream/evidence?session=bad')).status).toBe(400);
    const one = await records('limit=1');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ type: 'request', path: '/hls/master.m3u8' });
  });

  it('answers direct_stream_off without direct streaming', async () => {
    const off = new Hono();
    off.route('/', directStreamRoutes({ directStream: null }));
    off.route('/', streamEvidenceRoutes({ directStream: null, streamEvidence: null }));
    expect((await off.request('/api/stream/evidence')).status).toBe(503);
    const sid = 'A'.repeat(32);
    expect((await off.request(`/api/stream/sessions/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...SAME_ORIGIN }, body: '{"lines":[{"text":"x"}]}' })).status).toBe(503);
    expect((await off.request('/api/stream/evidence/snapshot', { method: 'POST', headers: SAME_ORIGIN, body: '{}' })).status).toBe(503);
  });
});
```
The fake resolver's provider is whichever seed row the registry lists second, so the test compares against `session.provider` and does not name one. If `SessionInfo.provider` is ever missing, use the `provider` field of the answer.

### Step 15: Route descriptions and generated reference
**File:** `scripts/docs/httpRoutes.ts:233` (after the `'POST /api/stream/sessions/:id/position'` entry, inside the "Direct streaming" group)
**Code:**
```ts
      'POST /api/stream/sessions/:id/events':
        '`{lines: [{text, at?, stage?, position_s?, buffer_s?}]}` (1 to 50 lines, `text` up to 2000 characters) from the player page: its log lines as it writes them (refreshes, recoveries, errors, subtitle failures), with the position and the seconds buffered ahead, appended to this machine\'s stream evidence log under the session id. Any address in a line keeps only its host and path. The session need not be live. 200 `{ok: true, recorded}`. 400 `invalid_session` (not a session id), `invalid_json`, `invalid_body`. Same-origin only.',
      'POST /api/stream/evidence/snapshot':
        '`{session_id?}` (an empty body is `{}`): writes a new folder `<data dir>/movies/stream-reports/<UTC stamp>-<first 6 characters of the id>/` on this machine holding `session.json` (the live session\'s source: provider, attempts, hosts, refreshes, addresses as host and path, captured header names only), `evidence.jsonl` (its pass-through and session records) and `player.json` (the page\'s posted lines). Without `session_id`: the stream on screen, else the session of the newest record. 200 `{ok: true, dir, session_id, complete, records, player_lines}`; `complete` is false when the session has ended (only its log records are left) or there is none. 400 `invalid_json` / `invalid_body`, 500 `snapshot_failed`. Same-origin only: a script sends an `Origin` equal to the address it calls.',
      'GET /api/stream/evidence':
        'This machine\'s stream evidence log, oldest first: `{host, file, records}`. A `request` record is one pass-through answer: `stream_host`, `path` (never the query), `range`, `kind`, `status` (the stream host\'s; null when it never answered), `answer` (what the player got), `ttfb_ms`, `bytes`, `duration_ms`, `kbps`, `redirects`, `outcome` (`end`, `aborted`, `error`, `refused`) and `error`. A `player` record is a posted page line; a `session` record is a session `created`, `refreshed` or `refresh_failed`. Query: `session` (a session id), `limit` (1 to 2000, default 200). 400 `invalid_session` / `invalid_limit`. Reads only.',
```
Then run `npm run docs:gen`, which rewrites `docs/guide/reference/http-api.md`. Never edit that file by hand.

### Step 16: The streaming guide
**File:** `docs/guide/streaming.md:410` (end of "### Sessions and the pass-through", before "### Direct streaming answers" at line 412), the answers table (lines 414-422), and "Where the code is" (line 800, after the `src/http/directStreamApi.ts` row)
**Change:** insert this subsection before `### Direct streaming answers`:
````markdown
### Stream evidence

Every answer the pass-through gives goes to this machine's evidence log,
`<data dir>/movies/stream-evidence-<host>.jsonl`, as one JSON line. The line is written once the
body has ended, broken off, or been dropped by the player. It holds:

- the session id and the provider
- the stream host and the path, never the query, which is where the signed tokens are
- the stream host's status and what the player got
- the time until the stream host answered, the bytes sent, the duration and the throughput in kbit/s
- how it ended (`end`, `aborted`, `error`, `refused`), with the error

A request notesd turns away (an unknown or ended session, a host the session may not reach) is
logged too. Each session created and each refresh is a `session` line.

The player page posts every line it adds to its own log to
`POST /api/stream/sessions/<id>/events`: refreshes, recoveries, errors and subtitle failures. Each
line goes with the position and the seconds buffered ahead, and lands in the same log as a `player`
line. `GET /api/stream/evidence?session=<id>` reads the log back.

The log is written in batches in the background. A write that fails is counted, logged at most
once a minute (`[notesd] stream evidence: could not write ...`), and never fails or delays an
answer. Like the VLC health log it is capped at 5 MB. When it is full it becomes
`stream-evidence-<host>.1.jsonl` and a new file starts.

`POST /api/stream/evidence/snapshot` copies one session's evidence into a new folder,
`<data dir>/movies/stream-reports/<stamp>-<first 6 characters of the id>/`, with three files:

- `session.json`: the source, meaning the provider, the attempts, the hosts and the refreshes
- `evidence.jsonl`: the session's records
- `player.json`: the page's lines

Take a snapshot while the session lives. Sessions are kept only in memory, and once a session
ends only its log lines are left (`complete: false`). No header value captured by the resolve is
written anywhere in the evidence, only the header names.

The two POSTs are same-origin only. A script with no browser sends the origin of the address it
calls:

```sh
curl -s -X POST -H 'Origin: http://127.0.0.1:7317' -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:7317/api/stream/evidence/snapshot
```
````
Add rows to the answers table:
```markdown
| `invalid_session` | An evidence route was given something that is not a stream session id |
| `snapshot_failed` | The snapshot folder could not be written; the evidence log is untouched |
```
Add rows to "Where the code is":
```markdown
| `src/directStream/evidence.ts` | The stream evidence log, the pass-through's observer, snapshots |
| `src/http/streamEvidenceApi.ts` | The page's log lines, the snapshot and the evidence read routes |
```

### Step 17: The verify-notesd feature map and journeys
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md`. Add a bullet after "- Refresh: ..." (line 16). Rewrite the `journey.sh` bullet under "Driving it with verify.sh". Add a sentence to the DASH bullet.
**Code:**

New sub-feature bullet:
```markdown
- Stream evidence (stream-cache-and-bug-report phase 1): every pass-through answer is one line in
  `<data dir>/movies/stream-evidence-<host>.jsonl` (host and path, never the query; upstream status,
  `ttfb_ms`, `bytes`, `duration_ms`, `kbps`, `outcome`), the page's log lines arrive through
  `POST /api/stream/sessions/:id/events` (same-origin), and `POST /api/stream/evidence/snapshot`
  writes `stream-reports/<stamp>-<id start>/` with `session.json`, `evidence.jsonl`, `player.json`.
  Rotated at 5 MB into `.1.jsonl`; a failed write never fails an answer. Proven by
  `npx vitest run tests/unit/directStream/evidence.test.ts web/src/stream/controller.test.tsx`,
  `npm run test:int -- tests/integration/directStream.evidence.int.test.ts`,
  `journey.sh RUN evidence playerlog snapshot unwritable`, and `DASH EVIDENCE PASS` in
  `dash-expiry.steps.mjs`.
```
Replace the journey bullet's first line with:
```markdown
- `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN [seed|hls|dash|refuse|evidence|playerlog|snapshot|unwritable]`: every check,
  saved as evidence; ends with `journey: PASS (...)`. Run `seed` first on a fresh run (it counts health
  after exactly one play). `evidence`, `playerlog`, `snapshot` and `unwritable` read
  `<run>/data/movies/stream-evidence-<hostname>.jsonl` and `<run>/data/movies/stream-reports/`.
```
In the DASH bullet, after "`DASH OVER PASS` (a 403 without `X-Notesd-Upstream` ends the session, no refresh)", add: "and `DASH EVIDENCE PASS` (the daemon's evidence log holds the 403s under the old token, the manifest under the new one, and the page's `refresh after 403` and `error: session_over` lines)".

**File:** `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh`
- Line 7, the header comment: change `No stage named: all four, in order` to `No stage named: all eight, in order`. Change the usage in line 1's comment and on the `RUN=` line (line 13) to `[seed|hls|dash|refuse|evidence|playerlog|snapshot|unwritable ...]`.
- Line 16: `if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(seed hls dash refuse evidence playerlog snapshot unwritable); fi`.
- After `DIRECT="$DIR/direct"` (line 18) add:
  ```bash
  EVLOG="$DIR/data/movies/stream-evidence-$(hostname).jsonl"
  ```
- Add these functions after `stage_refuse` (before the `for s in` loop):
  ```bash
  stage_evidence() {
    stage evidence
    printf 'hls\n' >"$DIRECT/mode"
    play '{"kind":"movie","tmdb_id":550}'
    local n
    get "$MANIFEST" ev-master
    [ "$CODE" = 200 ] || fail "the master playlist answered $CODE"
    get "/api/stream/sessions/$SID/p?u=$(enc "$UP/hls/720/seg1.ts?token=JOURNEYSECRET")" ev-seg -H 'Range: bytes=0-99'
    [ "$CODE" = 206 ] || fail "the ranged segment answered $CODE"
    get "/api/stream/sessions/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/p?u=$(enc "$UP/hls/master.m3u8")" ev-gone
    [ "$CODE" = 403 ] || fail "an ended session answered $CODE"
    api GET "/api/stream/evidence?session=$SID&limit=50"
    [ "$CODE" = 200 ] || fail "GET /api/stream/evidence answered $CODE: $BODY"
    n="$(jq '[.records[] | select(.type == "request" and .path == "/hls/720/seg1.ts" and .status == 206 and .answer == 206 and .bytes == 100 and .outcome == "end" and (.ttfb_ms|type) == "number" and (.duration_ms|type) == "number" and (.kbps|type) == "number")] | length' <<<"$BODY")"
    [ "$n" = 1 ] || fail "no single complete record for the segment: $BODY"
    n="$(jq '[.records[] | select(.type == "request" and .path == "/hls/master.m3u8" and .kind == "hls" and .status == 200)] | length' <<<"$BODY")"
    [ "$n" -ge 1 ] || fail "no record for the master playlist"
    ok "the segment's record has status 206, 100 bytes, time to first byte, duration and throughput; the playlist's is marked hls"
    api GET "/api/stream/evidence?session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    [ "$(jq -r '.records[-1] | "\(.outcome) \(.answer) \(.error)"' <<<"$BODY")" = "refused 403 unknown_session" ] || fail "the ended session's request is not recorded as refused: $BODY"
    ok "a request for an ended session is recorded as refused with unknown_session"
    [ -s "$EVLOG" ] || fail "no evidence log at $EVLOG"
    cp "$EVLOG" "$EV/direct-evidence.jsonl"
    ! grep -q JOURNEYSECRET "$EVLOG" || fail "the token in the query reached the evidence log"
    ! grep -q FixtureChrome "$EVLOG" || fail "a captured header value reached the evidence log"
    ok "the log on disk holds host and path only: no query token, no captured header value"
  }

  stage_playerlog() {
    stage playerlog
    printf 'hls\n' >"$DIRECT/mode"
    play '{"kind":"movie","tmdb_id":550}'
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"lines":[{"text":"x"}]}' "$URL/api/stream/sessions/$SID/events")"
    [ "$code" = 403 ] || fail "events without an Origin answered $code"
    api POST "/api/stream/sessions/$SID/events" '{"lines":[{"text":"refresh after 403 at 61.2 s","stage":"refreshing","position_s":61.2,"buffer_s":3.5},{"text":"error: networkError fragLoadError /api/stream/sessions/x/p?u=SECRETLINE","stage":"error","position_s":61.2,"buffer_s":0}]}'
    [ "$CODE" = 200 ] && [ "$(jq -r .recorded <<<"$BODY")" = 2 ] || fail "POST events answered $CODE: $BODY"
    api GET "/api/stream/evidence?session=$SID"
    [ "$(jq -c '[.records[] | select(.type == "player") | [.stage, .text, .position_s, .buffer_s]]' <<<"$BODY")" = '[["refreshing","refresh after 403 at 61.2 s",61.2,3.5],["error","error: networkError fragLoadError /api/stream/sessions/x/p",61.2,0]]' ] \
      || fail "the page's lines are not in the log as posted: $BODY"
    ! grep -q SECRETLINE "$EVLOG" || fail "a query in a page line reached the evidence log"
    ok "the page's two lines are in the evidence log under the session, the query cut off; no Origin is refused"
  }

  stage_snapshot() {
    stage snapshot
    printf 'hls\n' >"$DIRECT/mode"
    play '{"kind":"movie","tmdb_id":550}'
    local prov sdir
    prov="$(jq -r .session.provider <<<"$BODY")"
    get "$MANIFEST" snap-master
    api POST "/api/stream/sessions/$SID/events" '{"lines":[{"text":"error: networkError fragLoadError","stage":"error","position_s":12.5,"buffer_s":0}]}'
    api POST "/api/stream/sessions/$SID/refresh"
    [ "$CODE" = 200 ] || fail "the refresh answered $CODE: $BODY"
    api POST /api/stream/evidence/snapshot "{\"session_id\":\"$SID\"}"
    [ "$CODE" = 200 ] || fail "the snapshot answered $CODE: $BODY"
    [ "$(jq -r .complete <<<"$BODY")" = true ] || fail "the snapshot of a live session is not complete: $BODY"
    sdir="$(jq -r .dir <<<"$BODY")"
    [[ $sdir == "$DIR/data/movies/stream-reports/"*"-${SID:0:6}" ]] || fail "the snapshot folder [$sdir] is not under stream-reports named after the session"
    for f in session.json evidence.jsonl player.json; do [ -s "$sdir/$f" ] || fail "$f is missing from $sdir"; done
    [ "$(jq -r '"\(.live) \(.source.provider) \(.source.refreshes) \(.source.attempts|length) \(.source.captured_headers|join(","))"' "$sdir/session.json")" = "true $prov 1 2 referer,origin,user_agent" ] \
      || fail "session.json does not hold the source: $(jq -c .source "$sdir/session.json")"
    jq -e '.lines | map(select(.text == "error: networkError fragLoadError" and .position_s == 12.5)) | length == 1' "$sdir/player.json" >/dev/null || fail "player.json does not hold the posted line"
    grep -q '"path":"/hls/master.m3u8"' "$sdir/evidence.jsonl" || fail "evidence.jsonl does not hold the playlist's record"
    ! grep -rq FixtureChrome "$sdir" || fail "a captured header value reached the snapshot"
    cp -r "$sdir" "$EV/direct-snapshot"
    ok "the snapshot folder holds the source ($prov, 2 attempts, 1 refresh), the records and the page's line, and no captured header value"
  }

  stage_unwritable() {
    stage unwritable
    printf 'hls\n' >"$DIRECT/mode"
    play '{"kind":"movie","tmdb_id":550}'
    local kept="$DIR/data/movies/stream-evidence.kept" code bytes warned=no
    [ -f "$EVLOG" ] && mv "$EVLOG" "$kept"
    mkdir -p "$EVLOG"
    get "/api/stream/sessions/$SID/p?u=$(enc "$UP/hls/720/seg1.ts")" unw-seg -H 'Range: bytes=0-99'
    code="$CODE"
    bytes="$(wc -c <"$EV/direct-unw-seg.body" | tr -d ' ')"
    sleep 1
    grep -q 'stream evidence: could not write' "$DIR/daemon.log" && warned=yes
    rmdir "$EVLOG"
    [ -f "$kept" ] && mv "$kept" "$EVLOG"
    [ "$code" = 206 ] && [ "$bytes" = 100 ] || fail "with the log unwritable the segment answered $code with $bytes bytes"
    [ "$warned" = yes ] || fail "the daemon did not log the failed write"
    ok "with the evidence log unwritable the segment still answered 206 with 100 bytes, and the daemon logged the failure"
  }
  ```
- In the `case` (line 162-168) add:
  ```bash
      evidence) stage_evidence ;;
      playerlog) stage_playerlog ;;
      snapshot) stage_snapshot ;;
      unwritable) stage_unwritable ;;
  ```

**File:** `.claude/skills/verify-notesd/scripts/stream/dash-expiry.steps.mjs`
- Line 9, the header comment: change to `Logs "DASH PLAY PASS", "DASH EXPIRY PASS", "DASH OVER PASS", "DASH EVIDENCE PASS"; ...`.
- Append before the closing `}` of the default export (after line 88):
  ```js
    // Stream evidence: the daemon kept the pass-through's answers and the page's own lines for this session.
    let evidence = []
    for (let i = 0; i < 20; i++) {
      const res = await page.request.get(`${base}/api/stream/evidence?session=${sid}&limit=2000`)
      check(res.ok(), `GET /api/stream/evidence answered ${res.status()}`)
      evidence = (await res.json()).records
      const said = evidence.filter((r) => r.type === 'player').map((r) => r.text)
      if (said.some((t) => t.startsWith('refresh after 403')) && said.includes('error: session_over')) break
      await page.waitForTimeout(250)
    }
    const said = evidence.filter((r) => r.type === 'player').map((r) => r.text)
    const reqs = evidence.filter((r) => r.type === 'request')
    log(`DASH EVIDENCE ${reqs.length} request record(s); page lines ${JSON.stringify(said)}`)
    check(reqs.some((r) => (r.path ?? '').startsWith('/film/t1/') && r.status === 403 && r.answer === 403), 'the evidence log holds a 403 from the stream host under the old token')
    check(reqs.some((r) => r.path === '/film/t2/manifest.mpd' && r.status === 200 && r.kind === 'dash'), 'the evidence log holds the manifest read under the new token')
    check(reqs.some((r) => r.kind === 'media' && r.bytes > 0 && typeof r.kbps === 'number' && typeof r.ttfb_ms === 'number'), 'segments carry bytes, time to first byte and throughput')
    check(said.some((t) => t.startsWith('refresh after 403')), "the page's refresh line reached the daemon")
    check(said.includes('error: session_over'), "the page's error line reached the daemon")
    check(evidence.some((r) => r.type === 'session' && r.event === 'refreshed'), 'the refresh is a session record')
    log('DASH EVIDENCE PASS the daemon recorded each answer of the play and the page posted its refresh and error lines')
  ```

## Principles applied

- **Laziness protocol.** I copied `HealthLog`'s rotation scheme (same 5 MB cap, same `.1.jsonl` naming, same torn-line repair) and did not invent another. I did not build a general log framework.
- **Fix the root cause of "the answer must never slow".** `HealthLog.append` fsyncs one line at a time with sync I/O. Calling it for every segment would block the event loop that streams the film. So `StreamEvidence.record` only queues the line, a background `drain()` writes and fsyncs in batches, and Step 12 tests that `record()` returns before the file exists.
- **Boundary discipline.**
  - Page lines and snapshot bodies are checked once, by zod in `streamEvidenceApi.ts`.
  - Queries are stripped once, where data enters the log: `hostPath` for addresses and `redactQueries` for free text, both inside the record builders. Readers and the snapshot trust what is stored.
  - Header values are left out once, in `sessionSource`, which writes header names only.
- **Make illegal states unrepresentable.** A record is a zod discriminated union on `type`. How a request ended is a single `outcome` enum (`end | aborted | error | refused`), not a set of flags. `forward()` reports its own refusals in `trace.error`, so "refused" cannot be mixed up with an upstream 4xx.
- **Prove it works / Test behavior, not implementation.**
  - Every journey reads the real log, a route answer or the snapshot folder on a throwaway daemon. They do not inspect private calls.
  - The DASH journey drives the real page and dash.js through the real pass-through.
  - The "never fails" claim is checked on the daemon by replacing the log with a directory (`unwritable` stage). It is not only mocked.
- **Encode lessons in structure.** Invariant 3 (no tokens) is enforced by a test and a journey. Each one greps the log and the snapshot for a token planted in a query and for a captured header value, so the next record field that leaks one fails.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report && npm ci && npm run typecheck && npm run build`
**Tests:**
- `npm test`. This includes `tests/unit/directStream/evidence.test.ts`, `sessions.test.ts`, `web/src/stream/*.test.tsx`, and `tests/unit/docs/reference.test.ts`, which checks the new route descriptions.
- `npm run test:int`. This includes `tests/integration/directStream.evidence.int.test.ts`, and the existing `directStream.api.int.test.ts` must still pass.
- `npm run docs:check`.

**Proof:**
- Harness: `.claude/skills/verify-notesd`, run as `V=.claude/skills/verify-notesd/scripts/verify.sh`. Start a run with `$V up --web --direct-stream` and note `RUN` and `DIRECT=` from its output. That gives a throwaway daemon with a fake resolver and a fixture stream host. It never touches the live daemon, the streaming Chrome or a provider.
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md`
- Journeys:
  - **J1** · traces R2.1 — `bash .claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN seed evidence` → passes when it prints `journey: PASS (seed evidence)`. That means:
    - the segment fetched with `Range: bytes=0-99` has exactly one `request` record with `status` and `answer` 206, `bytes` 100, `outcome` `end`, and numeric `ttfb_ms`, `duration_ms` and `kbps`
    - the playlist's record is `kind` `hls`
    - an ended session's request is recorded as `refused 403 unknown_session`
    - `<run>/data/movies/stream-evidence-$(hostname).jsonl` contains neither `JOURNEYSECRET` (the token planted in the query) nor `FixtureChrome` (the captured User-Agent value)
  - **J2** · traces R2.1, R2.2 — `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-dash-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-dash")`, then `DIRECT=<the DIRECT= path> DASH_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/dash-expiry.steps.mjs` → passes when the transcript has `DASH PLAY PASS`, `DASH EXPIRY PASS`, `DASH OVER PASS` and `DASH EVIDENCE PASS`. That means the log holds:
    - the 403 under `/film/t1/`
    - `/film/t2/manifest.mpd` with status 200, kind `dash`
    - media records with bytes, `ttfb_ms` and `kbps`
    - the real page's `refresh after 403 ...` and `error: session_over` lines, posted by the controller
    - a `session` record for the refresh
  - **J3** · traces R2.2 — `bash .claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN playerlog` → passes when it prints `journey: PASS (playerlog)`. That means:
    - an events POST without an Origin is answered 403
    - with the Origin, both lines are in `GET /api/stream/evidence?session=` exactly as `[["refreshing","refresh after 403 at 61.2 s",61.2,3.5],["error","error: networkError fragLoadError /api/stream/sessions/x/p",61.2,0]]`
    - `SECRETLINE` is not in the log
  - **J4** · traces R2.2 — `npx vitest run web/src/stream/controller.test.tsx -t "page log reaches the daemon"` → passes when all 3 tests pass. The controller POSTs `/api/stream/sessions/S1/events` with `refresh after 403 at 42 s` (stage `refreshing`, `position_s` 42) followed by `error: no_source`, and a failing POST leaves the page's state unchanged.
  - **J5** · traces R2.3 — `bash .claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN snapshot` → passes when it prints `journey: PASS (snapshot)`. That means:
    - the snapshot answers `complete: true`
    - its `dir` is `<run>/data/movies/stream-reports/<stamp>-<first 6 of the session id>`
    - the folder holds `session.json` with `live` true, the provider, 1 refresh, 2 attempts and header names only
    - it holds `evidence.jsonl` with the playlist's record, and `player.json` with the posted line
    - nothing in the folder contains `FixtureChrome`
  - **J6** · traces R2.4 — `bash .claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN unwritable` → passes when it prints `journey: PASS (unwritable)`. With the log path replaced by a directory, the ranged segment still answers 206 with 100 bytes, `<run>/daemon.log` contains `stream evidence: could not write`, and the log is restored afterwards.
  - **J7** · traces R2.4 — `npx vitest run tests/unit/directStream/evidence.test.ts -t "the evidence log"` → passes when all 5 tests pass:
    - `stream-evidence-laptop.1.jsonl` exists after 20 lines against a 1500-byte cap, and the current file is at most 1500 bytes
    - the tail reads consecutive line numbers ending at 19
    - `record()` returns before the file exists
    - an unwritable log gives a full 1000-byte answer, `failures` 1 and one warning per minute
    - the backlog drops lines past `MAX_PENDING_LINES`
- Neighbor check: the pass-through and the HLS/DASH player, which this phase wraps and adds a POST to. Run `bash .claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN hls dash refuse`, which prints `journey: PASS (hls dash refuse)`. Then build the HLS fixture and run the player script: `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")` and `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs`. Its transcript has `J1 PASS`, `API PASS`, `J3 PASS`, `J2 PASS`, `MUTED PASS` and `CDN PASS` as before, and `npx vitest run web/src/stream` passes.
- Cost: none. No LLM turns and no live provider. Everything runs against the fake resolver and the fixture host.

**Exit criteria:**
- A play through the fixture stream host leaves one `request` record per pass-through answer, with host and path only.
- A posted page line is in the same log.
- `POST /api/stream/evidence/snapshot` writes a folder holding `session.json`, `evidence.jsonl` and `player.json`.
- Rotation and write failure are proven by J6 and J7.
- `npm run typecheck`, `npm test`, `npm run test:int` and `npm run docs:check` pass.

## Handoffs

- **Phase 2 (R1.7, R1.8):**
  - The recovery lines and the `recovering` stage must be written through `StreamController.note()` (or `fail()`). That is all it takes for them to reach the daemon (R2.2's "a recovery"). `stage` is sent as any string of up to 40 characters, so `'recovering'` needs no daemon change.
  - Phase 2 must not post events itself.
  - `web/src/stream/dashEngine.test.tsx:118` now counts refresh POSTs by URL. Keep it that way if those lines are touched.
- **Phase 3 (R3):**
  - The skill's `collect.sh` calls `POST /api/stream/evidence/snapshot` with `-H "Origin: <exactly the base it calls>"`, for example `http://127.0.0.1:7317` with `http://127.0.0.1:7317/...`. `sameOriginOnly` compares that header with the request URL's origin.
  - `GET /api/stream/evidence?session=&limit=` needs no header.
  - The snapshot answer is `{ok, dir, session_id, complete, records, player_lines}`. `complete: false` means the session ended (R3.3).
  - The raw log is `<dataDir>/movies/stream-evidence-<hostname>.jsonl`, plus `.1.jsonl`, for when the daemon does not answer.
  - Record fields are listed in the Interface Contract. The daemon logs a failed write as `[notesd] stream evidence: could not write ...`.
- **Phase 4 (R4):**
  - `StreamReporter` calls `deps.streamEvidence.snapshot(sessionId)` and gets a `SnapshotResult`. `deps.streamEvidence` is null when direct streaming is off; answer `direct_stream_off`.
  - The one-report marker belongs in `result.dir`. This phase writes no marker.
  - The button and `POST /api/stream/sessions/:id/report` are phase 4's.
- **Phase 5 (R1.1, R1.2):**
  - The cache downloader may record its own fetches with `safeRecord(deps.streamEvidence, ...)`, but it does not have to.
  - The pass-through itself already records every player request.
  - If the cache's file route fetches a missing segment on demand, recording it is phase 5's or phase 6's choice. That route is not `DirectStreamService.passThrough`.
- **Phase 6 (R1.4), reconciled:**
  - A session made from a cache through `SessionStore.create` gets `refreshes: 0`; phase 6 makes it without `resolve()` and calls `safeRecord(this.evidence, sessionRecord(session, 'created', null))` itself, and keeps this phase's records in `resolve` / `refresh`.
  - Phase 6 adds one field to this phase's `SessionSource`: `cache: {id, state} | null` (filled in `sessionSource()`), so a snapshot names the cache a play came from. This phase's tests use `toMatchObject` and keep passing.
- **Drive-by, not done:** `HealthLog` (`src/movies/vlc/health.ts:251`) still fsyncs synchronously, line by line. That is fine for its 30 s sampler, and it is not changed here.

## Rollback

- Revert this phase's commits.
- The only state this phase creates is plain files under `<dataDir>/movies/`: `stream-evidence-<host>.jsonl`, `stream-evidence-<host>.1.jsonl` and `stream-reports/`. Delete them by hand if wanted.
- There is no schema change, no new env var and no config change.
- Reverting also removes the three routes and the page's events POST. A player page left open from before the revert gets 404s on its events POST, which `postEvents` ignores.
