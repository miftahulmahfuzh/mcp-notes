import type { Db } from '../db/client.js';
import { EmbeddingError, embeddingErrorText, type Embedder } from './embedder.js';
import { listPending, recordFailure, saveEmbedding, type PendingNote } from './repo.js';
import { embedInput } from './state.js';

/** Inputs per embeddings call. OpenRouter accepts arrays; 16 short notes stay far under any request cap. */
export const DEFAULT_BATCH_SIZE = 16;
/** Minimum gap between the starts of two embeddings calls (batch or per-note fallback). */
export const DEFAULT_MIN_INTERVAL_MS = 1_000;

/** Time source; tests inject a fake so the rate limit runs without real waiting. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`, or early when `signal` aborts. Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: abortableSleep,
};

/** Spaces calls at least `minIntervalMs` apart. One instance is shared by every drain of a worker. */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly clock: Clock;
  private last = Number.NEGATIVE_INFINITY;

  constructor(minIntervalMs: number, clock: Clock = realClock) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.clock = clock;
  }

  /** Waits for the next slot. Returns false (and takes no slot) when `signal` aborted. */
  async acquire(signal?: AbortSignal): Promise<boolean> {
    // A function, not the property: TS would narrow `aborted` to false across the await.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) return false;
    const wait = this.last + this.minIntervalMs - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait, signal);
    if (aborted()) return false;
    this.last = this.clock.now();
    return true;
  }
}

/** The three repo operations the drain loop needs. `dbEmbeddingStore` is the real one. */
export interface EmbeddingStore {
  listPending(opts: { model: string; limit: number; ignoreBackoff?: boolean }): Promise<PendingNote[]>;
  saveEmbedding(v: { noteId: string; bodySha256: string; model: string; embedding: number[] }): Promise<boolean>;
  recordFailure(v: { noteId: string; bodySha256: string; model: string; error: string }): Promise<void>;
}

export function dbEmbeddingStore(db: Db): EmbeddingStore {
  return {
    listPending: (opts) => listPending(db, opts),
    saveEmbedding: (v) => saveEmbedding(db, v),
    recordFailure: (v) => recordFailure(db, v),
  };
}

export interface BackfillProgress {
  /** Batches that made at least one embeddings call. */
  batches: number;
  /** Embeddings calls made (batch calls plus per-note fallback calls). */
  calls: number;
  /** Vectors saved. */
  embedded: number;
  /** Notes whose own call failed; each got recordFailure. */
  failed: number;
  /** Vectors not saved because the note's body changed during the call (re-listed with the new body). */
  skipped: number;
}

export interface BatchReport {
  notes: number;
  calls: number;
  embedded: number;
  failed: number;
  skipped: number;
  /** The batch call failed and each note was tried alone. */
  fellBack: boolean;
  ms: number;
  failures: Array<{ id: string; error: string }>;
}

export interface BackfillResult extends BackfillProgress {
  /** The signal stopped the run before the queue was empty. */
  aborted: boolean;
}

export interface BackfillOptions {
  store: EmbeddingStore;
  embedder: Embedder;
  batchSize?: number;
  /** Shared limiter (the worker passes its own so the gap holds across drains). */
  limiter?: RateLimiter;
  /** Used only when `limiter` is not given. */
  minIntervalMs?: number;
  /** Also take failed notes whose next_attempt_at is still in the future (`embed:backfill --retry-failed`). */
  ignoreBackoff?: boolean;
  /** Checked between batches and before every call; an in-flight call is finished and saved. */
  signal?: AbortSignal;
  clock?: Clock;
  /** After every batch that made a call. */
  onBatch?: (report: BatchReport) => void;
  /** After every batch that made a call, with running totals. */
  onProgress?: (progress: BackfillProgress) => void;
}

/**
 * One line for logs and note_embeddings.last_error. An EmbeddingError keeps its transport detail
 * (phase 2's embeddingErrorText, e.g. "embedding request failed - detail: TypeError: fetch failed
 * (connect ECONNREFUSED ...)"), minus the class-name prefix. recordFailure clamps and redacts it.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof EmbeddingError) return embeddingErrorText(err).replace(/^EmbeddingError: /, '');
  return err instanceof Error ? err.message : String(err);
}

interface BatchItem {
  note: PendingNote;
  input: string;
}

interface BatchContext {
  store: EmbeddingStore;
  embedder: Embedder;
  model: string;
  limiter: RateLimiter;
  clock: Clock;
  signal: AbortSignal | undefined;
  /** `${id}:${bodySha256}` that failed or were skipped in this run; never offered again in it. */
  settled: Set<string>;
}

type EmbedOutcome = { ok: true; vectors: number[][] } | { ok: false; error: string };

function settleKey(note: PendingNote): string {
  return `${note.id}:${note.bodySha256}`;
}

async function tryEmbed(embedder: Embedder, inputs: string[]): Promise<EmbedOutcome> {
  try {
    const vectors = await embedder.embed(inputs);
    if (vectors.length !== inputs.length) {
      return { ok: false, error: `embedder returned ${vectors.length} vectors for ${inputs.length} inputs` };
    }
    return { ok: true, vectors };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function saveOne(ctx: BatchContext, report: BatchReport, item: BatchItem, embedding: number[]): Promise<void> {
  const saved = await ctx.store.saveEmbedding({
    noteId: item.note.id,
    bodySha256: item.note.bodySha256,
    model: ctx.model,
    embedding,
  });
  if (saved) {
    report.embedded += 1;
  } else {
    report.skipped += 1;
    ctx.settled.add(settleKey(item.note));
  }
}

async function failOne(ctx: BatchContext, report: BatchReport, item: BatchItem, error: string): Promise<void> {
  await ctx.store.recordFailure({
    noteId: item.note.id,
    bodySha256: item.note.bodySha256,
    model: ctx.model,
    error,
  });
  report.failed += 1;
  report.failures.push({ id: item.note.id, error });
  ctx.settled.add(settleKey(item.note));
}

/** One batch: one call for all, or on failure one call per note. Null when aborted before the first call. */
async function embedBatch(batch: BatchItem[], ctx: BatchContext): Promise<BatchReport | null> {
  if (!(await ctx.limiter.acquire(ctx.signal))) return null;
  const started = ctx.clock.now();
  const report: BatchReport = {
    notes: batch.length,
    calls: 1,
    embedded: 0,
    failed: 0,
    skipped: 0,
    fellBack: false,
    ms: 0,
    failures: [],
  };
  const whole = await tryEmbed(ctx.embedder, batch.map((b) => b.input));
  if (whole.ok) {
    for (let i = 0; i < batch.length; i += 1) {
      await saveOne(ctx, report, batch[i]!, whole.vectors[i]!);
    }
  } else if (batch.length === 1) {
    await failOne(ctx, report, batch[0]!, whole.error);
  } else {
    report.fellBack = true;
    for (const item of batch) {
      // Aborted: the notes not yet tried stay pending and are picked up by the next run.
      if (!(await ctx.limiter.acquire(ctx.signal))) break;
      report.calls += 1;
      const one = await tryEmbed(ctx.embedder, [item.input]);
      if (one.ok) await saveOne(ctx, report, item, one.vectors[0]!);
      else await failOne(ctx, report, item, one.error);
    }
  }
  report.ms = ctx.clock.now() - started;
  return report;
}

/**
 * Embeds pending notes until none is left (or the signal aborts). "Pending" is phase 1's
 * definition (missing, stale by hash or model, or failed and due), so a stopped run resumes
 * where it left off: finished notes are current and are never listed again.
 * Store errors (database down) reject; embedding errors never do.
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const clock = opts.clock ?? realClock;
  const ctx: BatchContext = {
    store: opts.store,
    embedder: opts.embedder,
    model: opts.embedder.model,
    limiter: opts.limiter ?? new RateLimiter(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, clock),
    clock,
    signal: opts.signal,
    settled: new Set<string>(),
  };
  const totals: BackfillProgress = { batches: 0, calls: 0, embedded: 0, failed: 0, skipped: 0 };

  while (opts.signal?.aborted !== true) {
    // Ask for enough rows that the settled ones (which may be listed again) cannot hide fresh work.
    const page = await ctx.store.listPending({
      model: ctx.model,
      limit: batchSize + ctx.settled.size,
      ignoreBackoff: opts.ignoreBackoff === true,
    });
    const batch: BatchItem[] = [];
    for (const note of page) {
      if (ctx.settled.has(settleKey(note))) continue;
      const input = embedInput(note.body);
      if (input === null) continue;
      batch.push({ note, input });
      if (batch.length === batchSize) break;
    }
    if (batch.length === 0) break;

    const report = await embedBatch(batch, ctx);
    if (report === null) break;
    totals.batches += 1;
    totals.calls += report.calls;
    totals.embedded += report.embedded;
    totals.failed += report.failed;
    totals.skipped += report.skipped;
    opts.onBatch?.(report);
    opts.onProgress?.({ ...totals });
  }
  return { ...totals, aborted: opts.signal?.aborted === true };
}
