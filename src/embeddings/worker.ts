import type { NoteEvents } from '../notes/events.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MIN_INTERVAL_MS,
  RateLimiter,
  errorMessage,
  realClock,
  runBackfill,
  type BatchReport,
  type Clock,
  type EmbeddingStore,
} from './backfill.js';
import type { Embedder } from './embedder.js';

/** Sweep period: the other machine's writes and due retries are picked up within this. */
export const DEFAULT_SWEEP_MS = 60_000;
/** Coalesces a burst of writes (an import, a quick edit loop) into one drain. */
export const DEFAULT_DEBOUNCE_MS = 500;
/**
 * close() waits this long for an in-flight batch. Kept well under src/main.ts's 10 s forced exit
 * (the OpenRouter timeout is 15 s); a call abandoned here loses nothing, its note stays pending.
 */
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
/** Error text in a log line is cut here; the full (≤ 500 char) text is in note_embeddings.last_error. */
const LOG_ERROR_CHARS = 200;

export interface EmbeddingWorkerOptions {
  store: EmbeddingStore;
  events: NoteEvents;
  embedder: Embedder;
  batchSize?: number;
  minIntervalMs?: number;
  sweepMs?: number;
  debounceMs?: number;
  /** How long close() waits for an in-flight batch. Default DEFAULT_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  clock?: Clock;
  /** One line per batch that made a call, and per failed drain. Default console.log. */
  log?: (line: string) => void;
}

export interface EmbeddingWorker {
  /** Schedule a drain (debounced). No-op after close. */
  kick(): void;
  /** Resolves once no drain is scheduled or running (a pending debounce runs now). For tests. */
  idle(): Promise<void>;
  /** Stops listening and sweeping, then waits (at most closeGraceMs) for the in-flight batch to finish and save. */
  close(): Promise<void>;
}

/** e.g. `[notesd] embeddings: 15/16 embedded, 1 failed (A-B32: OpenRouter ...), per-note fallback, 17 calls, 2310ms` */
export function formatBatch(r: BatchReport): string {
  const parts = [`[notesd] embeddings: ${r.embedded}/${r.notes} embedded`];
  if (r.skipped > 0) parts.push(`${r.skipped} changed meanwhile`);
  if (r.failed > 0) {
    const first = r.failures[0];
    const detail = first === undefined ? '' : ` (${first.id}: ${first.error.slice(0, LOG_ERROR_CHARS)})`;
    parts.push(`${r.failed} failed${detail}`);
  }
  if (r.fellBack) parts.push('per-note fallback');
  parts.push(`${r.calls} call${r.calls === 1 ? '' : 's'}, ${r.ms}ms`);
  return parts.join(', ');
}

export function startEmbeddingWorker(opts: EmbeddingWorkerOptions): EmbeddingWorker {
  const log = opts.log ?? ((line: string) => console.log(line));
  const clock = opts.clock ?? realClock;
  const limiter = new RateLimiter(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, clock);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const abort = new AbortController();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const drainOnce = async (): Promise<void> => {
    try {
      await runBackfill({
        store: opts.store,
        embedder: opts.embedder,
        batchSize,
        limiter,
        clock,
        signal: abort.signal,
        onBatch: (report) => log(formatBatch(report)),
      });
    } catch (err) {
      log(`[notesd] embeddings: drain failed: ${errorMessage(err).slice(0, LOG_ERROR_CHARS)}`);
    }
  };

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

  const kick = (): void => {
    if (closed || debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      drain();
    }, debounceMs);
  };

  const sweep = setInterval(drain, opts.sweepMs ?? DEFAULT_SWEEP_MS);
  sweep.unref();
  const unsubscribe = opts.events.on((event) => {
    if (event.op === 'created' || event.op === 'updated') kick();
  });
  drain();

  return {
    kick,
    async idle(): Promise<void> {
      for (;;) {
        if (debounce !== null) {
          clearTimeout(debounce);
          debounce = null;
          drain();
        }
        const current = running;
        if (current === null) return;
        await current;
      }
    },
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        unsubscribe();
        clearInterval(sweep);
        if (debounce !== null) {
          clearTimeout(debounce);
          debounce = null;
        }
        abort.abort();
      }
      const current = running;
      if (current === null) return;
      // Bounded: a call still in flight after the grace is abandoned; the daemon then closes the
      // pool, its save fails into the drain's catch, and the note stays pending for the next start.
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
