import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { AppDeps } from '../deps.js';
import type { EmbeddingWorker } from '../embeddings/worker.js';
import { sessionContextObserver } from './events.js';
import { startSessionIngest, type SessionIngester } from './ingest.js';
import { dbLinkStore, startLinkWorker, type LinkWorker } from './links.js';
import { readLiveSessions } from './registry.js';
import { dbReplyEmbeddingStore, startReplyEmbeddingWorker } from './replyEmbeddings.js';
import { SessionsRepo } from './repo.js';
import { DEFAULT_SUMMARY_IDLE_MS, dbSummaryStore, startSummaryWorker, type SummaryWorker } from './summaryWorker.js';
import { SUMMARIES_SUBDIR, createAgentSummarizer, type AgentSummarizerOptions, type Summarizer } from './summarize.js';

export interface SessionSummarizerIo {
  create?: (opts: AgentSummarizerOptions) => Summarizer | null;
  log?: (line: string) => void;
}

/**
 * The session summarizer startBackground hands the summary worker: the Agent SDK's Haiku, run in
 * `<dataDir>/session-summaries`. Null with NOTESD_SESSIONS=off, or when no claude binary is found (said once in the log).
 */
export function buildSessionSummarizer(config: Pick<Config, 'sessions' | 'chat' | 'dataDir'>, io: SessionSummarizerIo = {}): Summarizer | null {
  if (!config.sessions.enabled) return null;
  const summarizer = (io.create ?? createAgentSummarizer)({
    claudeBin: config.chat.claudeBin,
    cwd: join(config.dataDir, SUMMARIES_SUBDIR),
  });
  if (summarizer === null) {
    (io.log ?? ((line: string) => console.log(line)))(`[notesd] session summaries off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`);
  }
  return summarizer;
}

/** A busy session's replies are embedded at most this often (the reply worker's kick debounce). */
export const REPLY_EMBED_KICK_MS = 60_000;
/** How long after a session's idle time the summary worker is woken, so the idle test has passed. */
export const SUMMARY_DUE_MARGIN_MS = 30_000;

export interface SessionsBackgroundIo {
  ingest?: typeof startSessionIngest;
  links?: typeof startLinkWorker;
  replies?: typeof startReplyEmbeddingWorker;
  summaries?: typeof startSummaryWorker;
  host?: () => string;
  log?: (line: string) => void;
}

/** The session jobs' stop: `halt` (sync, first: the summary timer and deps.kickSummaries), then `closers` in parallel. */
export interface SessionsBackground {
  halt: () => void;
  closers: () => (Promise<void> | undefined)[];
}

/**
 * Claude Code sessions (iteration 8): the ingester (backfill in the background, then tail `<claudeHome>/projects`), its
 * parent linker, the reply embedding worker (with an embedder), and the summary worker (summaries only with a
 * summarizer, session vectors only with an embedder). While the old shared database is not copied in, the billed work
 * waits: the copy brings the replies' vectors and the summaries. Nothing with NOTESD_SESSIONS=off.
 */
export function startSessionsBackground(deps: AppDeps, summarizer: Summarizer | null, io: SessionsBackgroundIo = {}): SessionsBackground {
  const log = io.log ?? ((line: string) => console.log(line));
  let sessionIngest: SessionIngester | null = null;
  let sessionLinks: LinkWorker | null = null;
  let replyEmbeddings: EmbeddingWorker | null = null;
  if (!deps.config.sessions.enabled) {
    log('[notesd] session ingest off: NOTESD_SESSIONS=off');
  } else {
    const sessionsHost = (io.host ?? hostname)();
    const sessionsRepo = new SessionsRepo(deps.db, { dataDir: deps.config.dataDir, hostname: () => sessionsHost });
    sessionLinks = (io.links ?? startLinkWorker)({
      store: dbLinkStore(deps.db, sessionsRepo),
      host: sessionsHost,
      backfillAfter: () => sessionIngest?.forkBackfill,
    });
    sessionIngest = (io.ingest ?? startSessionIngest)({
      claudeHome: deps.config.sessions.claudeHome,
      worktreesDir: deps.config.sessions.worktreesDir,
      store: sessionsRepo,
      hostname: () => sessionsHost,
      // The context observer feeds GET /api/sessions/:nodeId/context/stream (src/sessions/events.ts).
      observers: deps.sessionEvents === undefined ? [sessionLinks] : [sessionLinks, sessionContextObserver(deps.sessionEvents)],
    });
    log(`[notesd] ingesting Claude Code sessions from ${deps.config.sessions.claudeHome}/projects as ${sessionsHost}`);

    if (deps.importPending === true) {
      log('[notesd] session reply vectors wait: the old shared database is not copied in yet');
    } else if (deps.embedder === null) {
      log('[notesd] session reply vectors off: OPENROUTER_API_KEY is not set, replies are searched by words only');
    } else {
      const worker = (io.replies ?? startReplyEmbeddingWorker)({
        store: dbReplyEmbeddingStore(deps.db, sessionsRepo, sessionsHost),
        embedder: deps.embedder,
        debounceMs: REPLY_EMBED_KICK_MS,
      });
      replyEmbeddings = worker;
      // Only a kick: never awaited, never blocks or fails a read. Every committed read kicks, and the worker's long
      // debounce turns a busy session into one drain a minute; nothing is asked while no session writes.
      sessionIngest.addObserver({
        onBatch: () => worker.kick(),
        onPassComplete: (pass) => {
          if (pass.sessionIds.length > 0) worker.kick();
        },
      });
      log(`[notesd] embedding session replies with ${deps.embedder.model}`);
    }
  }

  let sessionSummaries: SummaryWorker | null = null;
  let summaryDue: ReturnType<typeof setTimeout> | null = null;
  if (deps.config.sessions.enabled && deps.importPending === true) {
    // The copy brings the old sessions with their summaries; summarizing them here first would be paid for twice.
    log('[notesd] session summaries wait: the old shared database is not copied in yet');
  } else if (deps.config.sessions.enabled) {
    if (summarizer === null && deps.embedder === null) {
      log('[notesd] session summaries and session embeddings off');
    } else {
      const claudeHome = deps.config.sessions.claudeHome;
      const summaries = (io.summaries ?? startSummaryWorker)({
        store: dbSummaryStore(deps.db, new SessionsRepo(deps.db)),
        summarizer,
        embedder: deps.embedder,
        liveSessionIds: async () => new Set((await readLiveSessions(claudeHome)).map((s) => s.sessionId)),
      });
      sessionSummaries = summaries;
      // A session is due once it has been quiet for the idle time: each read of this host re-arms one timer for that
      // moment, so the worker asks the database when something can be due, not every minute.
      deps.kickSummaries = () => summaries.kick();
      sessionIngest?.addObserver({
        onBatch: () => {
          if (summaryDue !== null) clearTimeout(summaryDue);
          summaryDue = setTimeout(() => {
            summaryDue = null;
            summaries.kick();
          }, DEFAULT_SUMMARY_IDLE_MS + SUMMARY_DUE_MARGIN_MS);
          summaryDue.unref();
        },
      });
      log(`[notesd] session summaries: ${summarizer === null ? 'off' : summarizer.model}, session embeddings: ${deps.embedder === null ? 'off' : deps.embedder.model}`);
    }
  }

  return {
    halt: () => {
      if (summaryDue !== null) clearTimeout(summaryDue);
      delete deps.kickSummaries;
    },
    closers: () => [
      // The linker closes after the ingester, once no more batches can arrive.
      (async () => {
        await sessionIngest?.close();
        await sessionLinks?.close();
      })(),
      replyEmbeddings?.close(),
      sessionSummaries?.close(),
    ],
  };
}
