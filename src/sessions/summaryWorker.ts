import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { RateLimiter, errorMessage, realClock, type Clock } from '../embeddings/backfill.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings/constants.js';
import { embeddingErrorText, type Embedder } from '../embeddings/embedder.js';
import { clampError, retryDelayMs } from '../embeddings/state.js';
import type { SessionsRepo } from './repo.js';
import {
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
  /** Stored embedding's sha / model; null when there is none. */
  embeddingSha: string | null;
  embeddingModel: string | null;
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
  }): Promise<SummaryCandidate[]>;
  load(sessionIds: readonly string[]): Promise<SessionSummarySource[]>;
  saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void>;
  saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[] }): Promise<void>;
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

/** Reads by raw SQL on the phase-1 column names; writes only through SessionsRepo (invariant 3). */
export function dbSummaryStore(db: Db, repo: SessionsRepo): SummaryStore {
  return {
    async listIdle(o) {
      const needSummary = o.wantSummary
        ? sql`(s.summarized_at is null or s.summarized_at < s.last_active_at)`
        : sql`false`;
      const needEmbedding =
        o.embeddingModel !== null
          ? sql`(e.session_id is null or e.embedding is null or e.embedded_at is null or e.model <> ${o.embeddingModel} or e.embedded_at < s.last_active_at or (s.summarized_at is not null and e.embedded_at < s.summarized_at))`
          : sql`false`;
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id, s.last_active_at, s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.last_active_at is not null
          and s.last_active_at < ${o.idleBefore.toISOString()}::timestamptz
          and (${needSummary} or ${needEmbedding})
        order by s.last_active_at desc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      const out: SummaryCandidate[] = [];
      for (const r of res.rows) {
        const lastActiveAt = toDate(r.last_active_at);
        if (lastActiveAt === null) continue;
        out.push({
          sessionId: r.session_id,
          lastActiveAt,
          summarySha: r.summary_sha,
          summarizedAt: toDate(r.summarized_at),
          embeddingSha: r.embedding_sha,
          embeddingModel: r.embedding_model,
        });
      }
      return out;
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
      await repo.saveEmbedding(v.sessionId, { sha: v.sha, model: v.model, embedding: v.embedding });
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
 * Summarizes and embeds idle sessions of this host in the background. Starts a drain at once
 * (the backlog, newest first), then one per sweep. Never throws into its caller.
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
  }

  async function processOne(row: SessionSummarySource, c: SummaryCandidate, report: SummaryDrainReport): Promise<void> {
    const id = row.sessionId;
    const signal = abort.signal;
    let summary = row.summary;
    let failure: string | null = null;
    const summarize = summarizer !== null && !summariesPaused();
    const deferred = summarizer !== null && !summarize;

    if (summarize && summarizer !== null) {
      const input = buildSummaryInput(row);
      if (input !== null) {
        const sha = summaryInputSha(input);
        if (sha === row.summarySha && row.summary !== null) {
          if (c.summarizedAt === null || c.summarizedAt.getTime() < c.lastActiveAt.getTime()) {
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
        if (sha !== c.embeddingSha || c.embeddingModel !== embedder.model) {
          if (!(await embedLimiter.acquire(signal))) return;
          try {
            const vectors = await embedder.embed([text]);
            const vector = vectors[0];
            if (vector === undefined || vector.length !== EMBEDDING_DIMENSIONS) {
              throw new Error(`the embedder returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
            }
            await store.saveEmbedding({ sessionId: id, sha, model: embedder.model, embedding: vector });
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
    attempts.delete(id);
    retryAt.delete(id);
  }

  async function drainOnce(): Promise<void> {
    const started = clock.now();
    if (summariesPaused()) return;
    const report: SummaryDrainReport = { considered: 0, summarized: 0, embedded: 0, failed: 0, failures: [], ms: 0 };
    try {
      const live = await liveSet();
      const candidates = await store.listIdle({
        host,
        idleBefore: new Date(started - idleMs),
        limit: SUMMARY_SCAN_LIMIT,
        wantSummary: summarizer !== null,
        embeddingModel: embedder?.model ?? null,
      });
      const now = clock.now();
      const due = candidates.filter(
        (c) =>
          !live.has(c.sessionId) &&
          seen.get(c.sessionId) !== c.lastActiveAt.getTime() &&
          (retryAt.get(c.sessionId) ?? 0) <= now,
      );
      report.considered = due.length;
      for (let i = 0; i < due.length && !abort.signal.aborted; i += batchSize) {
        if (summariesPaused()) break;
        const batch = due.slice(i, i + batchSize);
        const byId = new Map(batch.map((c) => [c.sessionId, c]));
        const rows = await store.load([...byId.keys()]);
        for (const row of rows) {
          if (abort.signal.aborted) break;
          const c = byId.get(row.sessionId);
          if (c === undefined) continue;
          try {
            await processOne(row, c, report);
          } catch (err) {
            if (abort.signal.aborted) break;
            fail(report, row.sessionId, errorMessage(err));
          }
        }
      }
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
    kick: drain,
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
