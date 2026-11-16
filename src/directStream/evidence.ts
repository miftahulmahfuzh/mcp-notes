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
      // `type` first, then `at`, so a line reads the same way whatever the record.
      const { type, ...rest } = input;
      this.pending.push(JSON.stringify({ type, at: this.now().toISOString(), ...rest }));
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
