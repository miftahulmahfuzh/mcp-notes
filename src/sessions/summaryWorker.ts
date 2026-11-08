import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { RateLimiter, errorMessage, realClock, type Clock } from '../embeddings/backfill.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings/constants.js';
import { embeddingErrorText, type Embedder } from '../embeddings/embedder.js';
import { clampError, retryDelayMs } from '../embeddings/state.js';
import type { SessionsRepo } from './repo.js';
import {
  SESSION_EMBED_TEXT_VERSION,
  buildEmbedText,
  buildSummaryInput,
  cleanSummary,
  embedTextSha,
  summaryInputSha,
  type SessionSummarySource,
  type Summarizer,
} from './summarize.js';

/** A session must be quiet this long (and not live) before it is summarized. */
export const DEFAULT_SUMMARY_IDLE_MS = 15 * 60_000;
/** Sweep period: new idle sessions are picked up within this. */
export const DEFAULT_SUMMARY_SWEEP_MS = 60_000;
/** Minimum spacing between two summarizer calls (backlog rate limit). */
export const DEFAULT_SUMMARY_MIN_INTERVAL_MS = 5_000;
/** Minimum spacing between two embedder calls. */
export const DEFAULT_SUMMARY_EMBED_INTERVAL_MS = 1_000;
/** Full rows loaded per round trip. */
export const DEFAULT_SUMMARY_BATCH = 20;
/** Most candidates one sweep looks at. */
export const SUMMARY_SCAN_LIMIT = 5_000;
/** Most requested sessions one sweep serves (each still waits for the summary rate limiter). */
export const SUMMARY_REQUEST_LIMIT = 100;
/**
 * The idle scan runs at most this often unless the host's sessions changed, a retry is due or a
 * kick arrived: idleness crosses its threshold with no row change, so the scan cannot be dropped.
 */
export const SUMMARY_SCAN_FLOOR_MS = 5 * 60_000;
/** A session the worker finished is left out of the idle scan this long (unless it changes). */
export const SUMMARY_SETTLED_TTL_MS = 30 * 60_000;
/** Most settled ids one scan excludes in SQL. */
const SETTLED_EXCLUDE_MAX = 2_000;
/** changedSince looks back this much before the last scan, so DB/app clock skew cannot hide a write. */
const SCAN_SINCE_MARGIN_MS = 30_000;
/** close() waits this long for the in-flight call, like the embedding workers. */
export const DEFAULT_SUMMARY_CLOSE_GRACE_MS = 5_000;
/** Consecutive summarizer failures before summaries pause globally (usage limit, logged out). */
const PAUSE_AFTER_FAILURES = 3;
const LOG_ERROR_CHARS = 200;

/** One idle session as the light candidate query returns it. */
export interface SummaryCandidate {
  sessionId: string;
  lastActiveAt: Date;
  summarySha: string | null;
  summarizedAt: Date | null;
  /** Stored embedding's sha / model / embed-text version; null when there is none. */
  embeddingSha: string | null;
  embeddingModel: string | null;
  embeddingTextVersion: number | null;
}

/** The reads and writes the worker needs. `dbSummaryStore` is the real one; tests use memory. */
export interface SummaryStore {
  /**
   * Idle sessions of `host` (last_active_at < idleBefore) that may need work, newest first.
   * May return rows that turn out up to date; the worker re-checks by sha.
   */
  listIdle(opts: {
    host: string;
    idleBefore: Date;
    limit: number;
    /** Include rows whose summary may be stale. */
    wantSummary: boolean;
    /** Include rows whose embedding for this model may be stale; null = no embedder. */
    embeddingModel: string | null;
    /** Session ids to leave out of the result (settled in this process, unchanged since). */
    excludeIds?: readonly string[];
  }): Promise<SummaryCandidate[]>;
  /**
   * A tiny change marker for `host`'s sessions (count and newest updated/active time). Optional:
   * a store without it is scanned on every sweep.
   */
  fingerprint?(host: string): Promise<string>;
  /** Ids of `host`'s sessions written after `since`. Optional, like `fingerprint`. */
  changedSince?(opts: { host: string; since: Date }): Promise<string[]>;
  /**
   * Sessions of `host` someone asked to summarize (`summary_requested_at` set; the wall's
   * Summarize button), oldest request first. Not filtered by idleness or liveness.
   */
  listRequested(opts: { host: string; limit: number }): Promise<SummaryCandidate[]>;
  load(sessionIds: readonly string[]): Promise<SessionSummarySource[]>;
  /** Saves a summary. The real store goes through SessionsRepo.setSummary, which also clears a pending request. */
  saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void>;
  saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[]; textVersion: number }): Promise<void>;
  /** Drops a request that can never be served (nothing to summarize). Through SessionsRepo. */
  clearRequest(sessionId: string): Promise<void>;
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

type CandidateDbRow = {
  session_id: string;
  last_active_at: Date | string;
  summary_sha: string | null;
  summarized_at: Date | string | null;
  embedding_sha: string | null;
  embedding_model: string | null;
  embedding_text_version: number | null;
};

type SourceDbRow = {
  session_id: string;
  node_id: string;
  repo: string | null;
  branch: string | null;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  prompts: unknown;
  commits: unknown;
  files_edited: unknown;
  plan_docs: unknown;
  final_message: string | null;
  summary: string | null;
  summary_sha: string | null;
};

function toCandidates(rows: readonly CandidateDbRow[]): SummaryCandidate[] {
  const out: SummaryCandidate[] = [];
  for (const r of rows) {
    const lastActiveAt = toDate(r.last_active_at);
    if (lastActiveAt === null) continue;
    out.push({
      sessionId: r.session_id,
      lastActiveAt,
      summarySha: r.summary_sha,
      summarizedAt: toDate(r.summarized_at),
      embeddingSha: r.embedding_sha,
      embeddingModel: r.embedding_model,
      embeddingTextVersion: r.embedding_text_version,
    });
  }
  return out;
}

/** Reads by raw SQL on the phase-1 column names; writes only through SessionsRepo (invariant 3). */
export function dbSummaryStore(db: Db, repo: SessionsRepo): SummaryStore {
  return {
    async listIdle(o) {
      const needSummary = o.wantSummary
        ? sql`(s.summarized_at is null or s.summarized_at < s.last_active_at)`
        : sql`false`;
      // text_version below the current layout: the vector predates it (e.g. migration 0013), so
      // every such session is listed until processOne re-embeds it once.
      const needEmbedding =
        o.embeddingModel !== null
          ? sql`(e.session_id is null or e.embedding is null or e.embedded_at is null or e.model <> ${o.embeddingModel} or e.text_version < ${SESSION_EMBED_TEXT_VERSION}::integer or e.embedded_at < s.last_active_at or (s.summarized_at is not null and e.embedded_at < s.summarized_at))`
          : sql`false`;
      const exclude =
        o.excludeIds !== undefined && o.excludeIds.length > 0
          ? sql`and s.session_id <> all(array(select jsonb_array_elements_text(${JSON.stringify(o.excludeIds)}::jsonb)))`
          : sql``;
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id, s.last_active_at, s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model, e.text_version as embedding_text_version
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.last_active_at is not null
          and s.last_active_at < ${o.idleBefore.toISOString()}::timestamptz
          and (${needSummary} or ${needEmbedding})
          ${exclude}
        order by s.last_active_at desc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      return toCandidates(res.rows);
    },
    async fingerprint(host) {
      const res = await db.execute<{ n: number; u: Date | string | null; a: Date | string | null }>(sql`
        select count(*)::int as n, max(updated_at) as u, max(last_active_at) as a
        from cc_sessions
        where host = ${host}
      `);
      const r = res.rows[0];
      const iso = (v: Date | string | null | undefined): string => toDate(v)?.toISOString() ?? '';
      return `${r?.n ?? 0}|${iso(r?.u)}|${iso(r?.a)}`;
    },
    async changedSince(o) {
      const res = await db.execute<{ session_id: string }>(sql`
        select session_id from cc_sessions
        where host = ${o.host} and updated_at > ${o.since.toISOString()}::timestamptz
      `);
      return res.rows.map((r) => r.session_id);
    },
    async listRequested(o) {
      // last_active_at can be null on a row that has only just been created; the request time
      // stands in so the candidate (and the `seen` bookkeeping keyed on it) stays well defined.
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id,
               coalesce(s.last_active_at, s.started_at, s.summary_requested_at) as last_active_at,
               s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model, e.text_version as embedding_text_version
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.summary_requested_at is not null
        order by s.summary_requested_at asc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      return toCandidates(res.rows);
    },
    async load(sessionIds) {
      if (sessionIds.length === 0) return [];
      const res = await db.execute<SourceDbRow>(sql`
        select session_id, node_id, repo, branch, name, custom_title, ai_title, first_prompt,
               prompts, commits, files_edited, plan_docs, final_message, summary, summary_sha
        from cc_sessions
        where session_id in (${idList(sessionIds)})
      `);
      return res.rows.map((r) => ({
        sessionId: r.session_id,
        nodeId: r.node_id,
        repo: r.repo,
        branch: r.branch,
        name: r.name,
        customTitle: r.custom_title,
        aiTitle: r.ai_title,
        firstPrompt: r.first_prompt,
        prompts: r.prompts,
        commits: r.commits,
        filesEdited: r.files_edited,
        planDocs: r.plan_docs,
        finalMessage: r.final_message,
        summary: r.summary,
        summarySha: r.summary_sha,
      }));
    },
    async saveSummary(v) {
      await repo.setSummary(v.sessionId, { summary: v.summary, sha: v.summarySha });
    },
    async saveEmbedding(v) {
      await repo.saveEmbedding(v.sessionId, { sha: v.sha, model: v.model, embedding: v.embedding, textVersion: v.textVersion });
    },
    async clearRequest(sessionId) {
      await repo.clearSummaryRequest(sessionId);
    },
  };
}

export interface SummaryWorkerOptions {
  store: SummaryStore;
  /** Null: summaries off (no claude binary); embeddings still run when an embedder is set. */
  summarizer: Summarizer | null;
  /** Null: embeddings off (no OPENROUTER_API_KEY). */
  embedder: Embedder | null;
  /** This machine. Default os.hostname(). */
  host?: string;
  /** Session ids live in the registry right now. Default: none. A throw counts as none. */
  liveSessionIds?: () => Promise<ReadonlySet<string>>;
  idleMs?: number;
  sweepMs?: number;
  minIntervalMs?: number;
  embedMinIntervalMs?: number;
  batchSize?: number;
  closeGraceMs?: number;
  clock?: Clock;
  /** One line per drain that did work, and per failed drain. Default console.log. */
  log?: (line: string) => void;
}

export interface SummaryWorker {
  /** Schedule a drain now (no-op while one runs: it re-runs once after). No-op after close. */
  kick(): void;
  /** Resolves once no drain is running. For tests. */
  idle(): Promise<void>;
  /** Stops sweeping, aborts the in-flight call, waits at most closeGraceMs. */
  close(): Promise<void>;
}

export interface SummaryDrainReport {
  considered: number;
  summarized: number;
  embedded: number;
  failed: number;
  failures: Array<{ sessionId: string; error: string }>;
  ms: number;
}

/** e.g. `[notesd] session summaries: 3 summarized, 5 embedded, 1 failed (abc...: timeout), 2310ms` */
export function formatSummaryReport(r: SummaryDrainReport): string {
  const parts = [`[notesd] session summaries: ${r.summarized} summarized`, `${r.embedded} embedded`];
  if (r.failed > 0) {
    const first = r.failures[0];
    const detail = first === undefined ? '' : ` (${first.sessionId}: ${first.error.slice(0, LOG_ERROR_CHARS)})`;
    parts.push(`${r.failed} failed${detail}`);
  }
  parts.push(`${r.ms}ms`);
  return parts.join(', ');
}

/**
 * Summarizes and embeds sessions of this host in the background. Each drain serves requested
 * sessions first (summary_requested_at; no idle wait, live ones included), then the idle backlog,
 * newest first. Starts a drain at once, then one per sweep. Never throws into its caller.
 */
export function startSummaryWorker(opts: SummaryWorkerOptions): SummaryWorker {
  const { store, summarizer, embedder } = opts;
  const host = opts.host ?? hostname();
  const log = opts.log ?? ((line: string) => console.log(line));
  const clock = opts.clock ?? realClock;
  const idleMs = opts.idleMs ?? DEFAULT_SUMMARY_IDLE_MS;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_SUMMARY_BATCH);
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_SUMMARY_CLOSE_GRACE_MS;
  const readLive = opts.liveSessionIds ?? (async () => new Set<string>());
  const summaryLimiter = new RateLimiter(opts.minIntervalMs ?? DEFAULT_SUMMARY_MIN_INTERVAL_MS, clock);
  const embedLimiter = new RateLimiter(opts.embedMinIntervalMs ?? DEFAULT_SUMMARY_EMBED_INTERVAL_MS, clock);
  const abort = new AbortController();

  /** session id -> last_active_at (ms) already handled in this process. */
  const seen = new Map<string, number>();
  const attempts = new Map<string, number>();
  const retryAt = new Map<string, number>();
  let consecutiveSummaryFailures = 0;
  let pausedUntil = 0;
  let closed = false;
  let running: Promise<void> | null = null;
  let again = false;
  // Idle-scan gating (see drainOnce). settledAt: ids finished in this process, left out of the SQL
  // scan for SUMMARY_SETTLED_TTL_MS unless changedSince reports a write. In memory on purpose: a
  // persisted marker needs a migration, so a restart costs one load per stuck row.
  let lastScanAt = 0;
  let lastFingerprint: string | null = null;
  let forceScan = true;
  const settledAt = new Map<string, number>();

  const summariesPaused = (): boolean => summarizer !== null && clock.now() < pausedUntil;

  async function liveSet(): Promise<ReadonlySet<string>> {
    try {
      return await readLive();
    } catch (err) {
      log(`[notesd] session summaries: live registry unreadable (${errorMessage(err).slice(0, LOG_ERROR_CHARS)}); treating no session as live`);
      return new Set<string>();
    }
  }

  function fail(report: SummaryDrainReport, sessionId: string, error: string): void {
    report.failed += 1;
    report.failures.push({ sessionId, error: clampError(error) });
    const n = (attempts.get(sessionId) ?? 0) + 1;
    attempts.set(sessionId, n);
    retryAt.set(sessionId, clock.now() + retryDelayMs(n));
    settledAt.delete(sessionId);
  }

  /**
   * One session: its summary (summarizer on and not paused), then its embedding. `requested`: the
   * row carries summary_requested_at. An up-to-date summary is then saved again (setSummary clears
   * the request, no model call), and a row with nothing to summarize has its request dropped.
   * The vector is rebuilt when the embed text's sha or the model changed, or when it was made from
   * an older embed-text layout (text_version < SESSION_EMBED_TEXT_VERSION), even if the text is the same.
   */
  async function processOne(
    row: SessionSummarySource,
    c: SummaryCandidate,
    report: SummaryDrainReport,
    requested: boolean,
  ): Promise<void> {
    const id = row.sessionId;
    const signal = abort.signal;
    let summary = row.summary;
    let failure: string | null = null;
    const summarize = summarizer !== null && !summariesPaused();
    const deferred = summarizer !== null && !summarize;

    if (summarize && summarizer !== null) {
      const input = buildSummaryInput(row);
      if (input === null) {
        // No prompts and no final message: a request for this row can never be served.
        if (requested) await store.clearRequest(id);
      } else {
        const sha = summaryInputSha(input);
        if (sha === row.summarySha && row.summary !== null) {
          const stale = c.summarizedAt === null || c.summarizedAt.getTime() < c.lastActiveAt.getTime();
          if (requested || stale) {
            await store.saveSummary({ sessionId: id, summary: row.summary, summarySha: sha });
          }
        } else {
          if (!(await summaryLimiter.acquire(signal))) return;
          try {
            const clean = cleanSummary(await summarizer.summarize({ sessionId: id, input, signal }));
            if (clean === '') throw new Error('the summarizer returned an empty summary');
            await store.saveSummary({ sessionId: id, summary: clean, summarySha: sha });
            summary = clean;
            report.summarized += 1;
            consecutiveSummaryFailures = 0;
          } catch (err) {
            if (signal.aborted) return;
            failure = errorMessage(err);
            consecutiveSummaryFailures += 1;
            if (consecutiveSummaryFailures >= PAUSE_AFTER_FAILURES) {
              const wait = retryDelayMs(consecutiveSummaryFailures - PAUSE_AFTER_FAILURES + 1);
              pausedUntil = clock.now() + wait;
              log(`[notesd] session summaries: ${consecutiveSummaryFailures} failures in a row, pausing summaries for ${Math.round(wait / 1000)} s`);
            }
          }
        }
      }
    }

    if (embedder !== null) {
      const text = buildEmbedText({ ...row, summary });
      if (text !== null) {
        const sha = embedTextSha(text);
        const olderLayout = (c.embeddingTextVersion ?? 0) < SESSION_EMBED_TEXT_VERSION;
        if (sha !== c.embeddingSha || c.embeddingModel !== embedder.model || olderLayout) {
          if (!(await embedLimiter.acquire(signal))) return;
          try {
            const vectors = await embedder.embed([text]);
            const vector = vectors[0];
            if (vector === undefined || vector.length !== EMBEDDING_DIMENSIONS) {
              throw new Error(`the embedder returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
            }
            await store.saveEmbedding({ sessionId: id, sha, model: embedder.model, embedding: vector, textVersion: SESSION_EMBED_TEXT_VERSION });
            report.embedded += 1;
          } catch (err) {
            if (signal.aborted) return;
            failure ??= embeddingErrorText(err);
          }
        }
      }
    }

    if (failure !== null) {
      fail(report, id, failure);
      return;
    }
    // A row whose summary step was skipped by the pause is picked up again after it.
    if (deferred) return;
    seen.set(id, c.lastActiveAt.getTime());
    settledAt.set(id, clock.now());
    attempts.delete(id);
    retryAt.delete(id);
  }

  /** Loads and processes `list` in batches, in list order. Stops on abort or once summaries pause. */
  async function processAll(list: readonly SummaryCandidate[], requested: boolean, report: SummaryDrainReport): Promise<void> {
    for (let i = 0; i < list.length && !abort.signal.aborted; i += batchSize) {
      if (summariesPaused()) return;
      const batch = list.slice(i, i + batchSize);
      const rows = new Map((await store.load(batch.map((c) => c.sessionId))).map((r) => [r.sessionId, r]));
      for (const c of batch) {
        if (abort.signal.aborted) return;
        const row = rows.get(c.sessionId);
        if (row === undefined) continue;
        try {
          await processOne(row, c, report, requested);
        } catch (err) {
          if (abort.signal.aborted) return;
          fail(report, row.sessionId, errorMessage(err));
        }
      }
    }
  }

  async function drainOnce(): Promise<void> {
    const started = clock.now();
    if (summariesPaused()) return;
    const report: SummaryDrainReport = { considered: 0, summarized: 0, embedded: 0, failed: 0, failures: [], ms: 0 };
    try {
      // Requests first. They skip the idle wait, the live filter and `seen` (a live session gets a
      // summary so far; one summarized earlier in this process is served again), but not the
      // per-session retry backoff, the global pause or the summary rate limiter. Without a
      // summarizer nothing can serve them, so they wait for a daemon that has one.
      const requested = summarizer === null ? [] : await store.listRequested({ host, limit: SUMMARY_REQUEST_LIMIT });
      const live = await liveSet();
      // The idle scan re-reads up to SUMMARY_SCAN_LIMIT rows from Neon, so it only runs when
      // something may have changed: first drain, a kick, a due retry, the host's sessions changed
      // (fingerprint), or the floor passed (idleness crosses its threshold with no row change).
      const scanNow = clock.now();
      let scan =
        forceScan ||
        scanNow - lastScanAt >= SUMMARY_SCAN_FLOOR_MS ||
        [...retryAt.values()].some((t) => t <= scanNow);
      if (store.fingerprint) {
        const fp = await store.fingerprint(host);
        if (fp !== lastFingerprint) {
          scan = true;
          lastFingerprint = fp;
        }
      } else {
        scan = true; // no cheap change marker: scan every sweep
      }
      let candidates: SummaryCandidate[] = [];
      if (scan) {
        if (store.changedSince && lastScanAt > 0) {
          for (const id of await store.changedSince({ host, since: new Date(lastScanAt - SCAN_SINCE_MARGIN_MS) })) {
            settledAt.delete(id);
          }
        }
        const excludeIds = [...settledAt.entries()]
          .filter(([, t]) => scanNow - t < SUMMARY_SETTLED_TTL_MS)
          .sort((a, b) => b[1] - a[1])
          .slice(0, SETTLED_EXCLUDE_MAX)
          .map(([id]) => id);
        candidates = await store.listIdle({
          host,
          idleBefore: new Date(started - idleMs),
          limit: SUMMARY_SCAN_LIMIT,
          wantSummary: summarizer !== null,
          embeddingModel: embedder?.model ?? null,
          excludeIds,
        });
        lastScanAt = scanNow;
        forceScan = false;
      }
      const now = clock.now();
      const requestedIds = new Set(requested.map((c) => c.sessionId));
      const dueRequested = requested.filter((c) => (retryAt.get(c.sessionId) ?? 0) <= now);
      const dueIdle = candidates.filter(
        (c) =>
          !requestedIds.has(c.sessionId) &&
          !live.has(c.sessionId) &&
          seen.get(c.sessionId) !== c.lastActiveAt.getTime() &&
          (retryAt.get(c.sessionId) ?? 0) <= now,
      );
      report.considered = dueRequested.length + dueIdle.length;
      await processAll(dueRequested, true, report);
      await processAll(dueIdle, false, report);
    } catch (err) {
      if (!abort.signal.aborted) log(`[notesd] session summaries: drain failed: ${errorMessage(err).slice(0, LOG_ERROR_CHARS)}`);
    }
    report.ms = clock.now() - started;
    if (report.summarized + report.embedded + report.failed > 0) log(formatSummaryReport(report));
  }

  const drain = (): void => {
    if (closed) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await drainOnce();
      } while (again && !closed);
    })().finally(() => {
      running = null;
    });
  };

  const sweep = setInterval(drain, opts.sweepMs ?? DEFAULT_SUMMARY_SWEEP_MS);
  sweep.unref();
  drain();

  return {
    kick(): void {
      forceScan = true;
      drain();
    },
    async idle(): Promise<void> {
      for (;;) {
        const current = running;
        if (current === null) return;
        await current;
      }
    },
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        clearInterval(sweep);
        abort.abort();
      }
      const current = running;
      if (current === null) return;
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        current,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, closeGraceMs);
          grace.unref();
        }),
      ]);
      clearTimeout(grace);
    },
  };
}
