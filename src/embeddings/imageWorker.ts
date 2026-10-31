import type { NoteEvents } from '../notes/events.js';
import { DEFAULT_MIN_INTERVAL_MS, RateLimiter, errorMessage, realClock, type Clock } from './backfill.js';
import {
  DEFAULT_UNAVAILABLE_RECHECK_MS,
  UnavailableImages,
  runImageBackfill,
  type ImageBackfillResult,
  type ImageEmbeddingStore,
} from './imageBackfill.js';
import type { ImageEmbedder } from './imageEmbedder.js';
import { DEFAULT_CLOSE_GRACE_MS, DEFAULT_DEBOUNCE_MS, DEFAULT_SWEEP_MS, type EmbeddingWorker } from './worker.js';

/** Error text in a log line is cut here; the full (<= 500 char) text is in note_image_embeddings.last_error. */
const LOG_ERROR_CHARS = 200;

export interface ImageEmbeddingWorkerOptions {
  store: ImageEmbeddingStore;
  events: NoteEvents;
  embedder: ImageEmbedder;
  minIntervalMs?: number;
  sweepMs?: number;
  debounceMs?: number;
  /** How long close() waits for an in-flight call. Default DEFAULT_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  /** How long a missing original is not looked at again. Default DEFAULT_UNAVAILABLE_RECHECK_MS. */
  unavailableRecheckMs?: number;
  clock?: Clock;
  /** One line per drain that made a call or recorded a failure, and per failed drain. Default console.log. */
  log?: (line: string) => void;
}

export interface ImageDrainSummary extends ImageBackfillResult {
  ms: number;
  firstFailure: { id: string; error: string } | null;
}

/** e.g. `[notesd] image embeddings: 3 embedded, 1 failed (A-B32: ...), 40 not on this machine, 4 calls, 5210ms` */
export function formatImageDrain(s: ImageDrainSummary): string {
  const parts = [`[notesd] image embeddings: ${s.embedded} embedded`];
  if (s.skipped > 0) parts.push(`${s.skipped} changed meanwhile`);
  if (s.failed > 0) {
    const detail = s.firstFailure === null ? '' : ` (${s.firstFailure.id}: ${s.firstFailure.error.slice(0, LOG_ERROR_CHARS)})`;
    parts.push(`${s.failed} failed${detail}`);
  }
  if (s.unavailable > 0) parts.push(`${s.unavailable} not on this machine`);
  parts.push(`${s.calls} call${s.calls === 1 ? '' : 's'}, ${s.ms}ms`);
  return parts.join(', ');
}

export function startImageEmbeddingWorker(opts: ImageEmbeddingWorkerOptions): EmbeddingWorker {
  const log = opts.log ?? ((line: string) => console.log(line));
  const clock = opts.clock ?? realClock;
  const limiter = new RateLimiter(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, clock);
  const unavailable = new UnavailableImages(opts.unavailableRecheckMs ?? DEFAULT_UNAVAILABLE_RECHECK_MS, clock);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const abort = new AbortController();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const drainOnce = async (): Promise<void> => {
    const started = clock.now();
    const failures: Array<{ id: string; error: string }> = [];
    try {
      const result = await runImageBackfill({
        store: opts.store,
        embedder: opts.embedder,
        limiter,
        clock,
        signal: abort.signal,
        unavailable,
        onImage: (r) => {
          if (r.outcome === 'failed') failures.push({ id: r.imageId, error: r.error ?? '' });
        },
      });
      if (result.calls > 0 || result.failed > 0) {
        log(formatImageDrain({ ...result, ms: clock.now() - started, firstFailure: failures[0] ?? null }));
      }
    } catch (err) {
      log(`[notesd] image embeddings: drain failed: ${errorMessage(err).slice(0, LOG_ERROR_CHARS)}`);
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
  // Creating an image note emits `created`; attaching an image emits `updated` on its note.
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
      // Bounded, as for note embeddings: a call still in flight after the grace is abandoned and
      // its image stays pending for the next start.
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
