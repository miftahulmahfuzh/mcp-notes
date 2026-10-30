# Phase 3: Embedding worker, background backfill, `embed:backfill`

**Plan set:** `SEMANTIC_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261030-140513-S6EM_code_analyzer.md`
**Satisfies:** R3 (background backfill in notesd plus `npm run embed:backfill`), R1 (write paths get embedded after commit; failures are retried; textless photos get nothing; deleted notes keep their vector), R6 (this phase's own tests: write paths enqueue and fill, a failed embedding does not fail the write and is retried, backfill is resumable)
**Depends on:** Phase 1, Phase 2
**Difficulty:** HARD
**Package:** `src/embeddings`, `src/background.ts`, `src/cli`

---

## Goal

After this phase every body write (create, update, append, revert, image ingest with text) ends with a current vector in `note_embeddings` without the write ever waiting on OpenRouter. A worker inside notesd, started beside the inbox watcher, reacts to `NoteEvents`, sweeps every 60 s for the other machine's writes and for retries that have come due, embeds in batches of 16 at a limited rate, isolates a bad input by falling back to per-note calls, and logs one line per batch that did work and nothing when idle. `npm run embed:backfill` runs the same drain loop once, prints progress, and can be stopped and resumed.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/embeddings/backfill.ts`: `DEFAULT_BATCH_SIZE` (16), `DEFAULT_MIN_INTERVAL_MS` (1000), `interface Clock`, `realClock`, `class RateLimiter`, `interface EmbeddingStore`, `dbEmbeddingStore(db: Db): EmbeddingStore`, `interface BackfillProgress`, `interface BatchReport`, `interface BackfillResult`, `interface BackfillOptions`, `runBackfill(opts): Promise<BackfillResult>`, `errorMessage(err: unknown): string`
- `src/embeddings/worker.ts`: `DEFAULT_SWEEP_MS` (60 000), `DEFAULT_DEBOUNCE_MS` (500), `DEFAULT_CLOSE_GRACE_MS` (5 000), `interface EmbeddingWorkerOptions` (incl. `closeGraceMs?`), `interface EmbeddingWorker { kick(); idle(); close() }`, `startEmbeddingWorker(opts): EmbeddingWorker`, `formatBatch(report): string`
- `src/cli/embedBackfill.ts`: `interface EmbedBackfillIo`, `defaultIo(signal)`, `embedBackfill(args, io): Promise<number>` plus a direct-run entry point
- `package.json` script `"embed:backfill": "tsx src/cli/embedBackfill.ts"`
- `tests/helpers/memoryEmbeddingStore.ts`: `MemoryEmbeddingStore`, `ScriptedEmbedder` (unit-test fakes owned by this phase)
- Tests: `tests/unit/embeddings/backfill.test.ts`, `tests/unit/embeddings/worker.test.ts`, `tests/unit/embeddings/embedBackfillCli.test.ts`, `tests/integration/embeddings.worker.int.test.ts`

**Signature changes:** none. `startBackground(deps: AppDeps): Promise<StopBackground>` keeps its signature and now also starts and stops the embedding worker.

**Requires (from earlier phases), used exactly as the plan index states:**
- Phase 1, `src/embeddings/state.ts`: `bodySha256(body)`, `embedInput(body)`, `retryDelayMs(attempts)`
- Phase 1, `src/embeddings/repo.ts`: `PendingNote { id; body; bodySha256 }`, `listPending(db, { model, limit, ignoreBackoff? })`, `saveEmbedding(db, { noteId, bodySha256, model, embedding })` returning `false` when the body moved on, `recordFailure(db, { noteId, bodySha256, model, error })`, `embeddingStats(db, model)` returning `{ withText, current, pending, failing }`
- Phase 1: table `note_embeddings` with the snake_case columns in the index's table (`note_id`, `embedding`, `body_sha256`, `model`, `attempts`, `last_error`, `next_attempt_at`); `truncateAll` in `tests/integration/setup.ts` also empties `note_embeddings`; the test container runs `pgvector/pgvector:pg16`
- Phase 2, `src/embeddings/embedder.ts`: `interface Embedder { model; dimensions; embed(inputs, opts?) }`, `class EmbeddingError`, `embeddingErrorText(err)`
- Phase 2, `src/embeddings/openrouter.ts`: `createOpenRouterEmbedder({ apiKey })`
- Phase 2, `src/config.ts`: `Config.embeddings: { apiKey: string | null }`, `DEFAULT_EMBEDDINGS_CONFIG`
- Phase 2, `src/deps.ts`: `AppDeps.embedder: Embedder | null`, set by `startDaemon` (null without a key, or the injected `StartDaemonOptions.embedder`)
- Phase 2: every existing `AppDeps` / `Config` literal in tests (`tests/integration/images.int.test.ts:120`, `tests/integration/imageHarness.ts:34`, `tests/integration/helpers/api-harness.ts:44`, `tests/integration/daemon.int.test.ts:17`, `tests/live/chat.live.test.ts`) already carries `embeddings` / `embedder`, with `embedder: null` wherever no test injects one
- Phase 2, `tests/helpers/fakeEmbedder.ts`: `createFakeEmbedder()` with no arguments returns an `Embedder` whose vectors are `EMBEDDING_DIMENSIONS` (1536) wide, so they fit `vector(1536)`. This phase relies on nothing else of the fake: it wraps it in its own probe for call counting, failures and delay (see Step 7), so the exact shape of `calls` / `failNext` / `failWhen` does not matter here.

**Leaves alone (owned by others):** `src/notes/service.ts`, `src/notes/repo.ts`, `src/notes/types.ts` (phases 2, 4, 5); `src/embeddings/{constants,state,repo,embedder,openrouter}.ts` (phases 1, 2, 5); `src/db/schema.ts`, `drizzle/**`, `scripts/test-int.sh`, `tests/integration/setup.ts` (phase 1); `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `tests/helpers/fakeEmbedder.ts` (phase 2); `src/search/**`, `src/mcp/**`, `src/chat/**` (phases 4, 5); `web/**` (nobody); `vitest.config.ts`, docs, `test:live:embeddings` script (phase 6).

## Files

| File | Action | What changes |
|---|---|---|
| `src/embeddings/backfill.ts` | create | the shared drain loop, rate limiter, clock, store adapter over phase 1's repo |
| `src/embeddings/worker.ts` | create | event-kicked, sweep-driven worker around `runBackfill`; batch log line |
| `src/background.ts:1-25` | modify | start the worker when `deps.embedder` is set, log once when it is null, close it on stop |
| `src/cli/embedBackfill.ts` | create | one-shot backfill with progress, `--retry-failed`, SIGINT stops after the current batch |
| `package.json:65` | modify | add `"embed:backfill"` after `"db:check"` |
| `tests/helpers/memoryEmbeddingStore.ts` | create | in-memory `EmbeddingStore` with the repo's rules + scripted embedder for unit tests |
| `tests/unit/embeddings/backfill.test.ts` | create | batching, fallback, backoff, abort/resume, rate limit, changed body |
| `tests/unit/embeddings/worker.test.ts` | create | events, sweep, idle silence, coalescing, close waits, bounded close grace, drain errors |
| `tests/unit/embeddings/embedBackfillCli.test.ts` | create | usage, missing key, config error |
| `tests/integration/embeddings.worker.int.test.ts` | create | write paths, image notes, failure + retry, slow embedder, resume, delete/restore, `startBackground`, CLI |

## Implementation Steps

### Step 1: The shared drain loop
**File:** `src/embeddings/backfill.ts` (new)
**Change:** One loop used by both the worker and the CLI. It reads pending notes through an `EmbeddingStore` (a thin adapter over phase 1's repo, so unit tests can use an in-memory store), embeds a batch in one call, and on a failed batch call retries each note alone so one bad input does not keep fifteen good ones from being embedded. A note that fails alone gets `recordFailure` (phase 1 sets the backoff). Each `(id, body hash)` that failed or was skipped is excluded for the rest of the run, so `ignoreBackoff` and a body that changes under the call can never make the loop spin. Every embed call waits on a shared `RateLimiter`. The abort signal is checked between batches and before every call; a call already in flight is finished and its result saved.

**Code:**
```ts
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
    if (signal?.aborted === true) return false;
    const wait = this.last + this.minIntervalMs - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait, signal);
    if (signal?.aborted === true) return false;
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
```
**Impact:** new module, nothing imports it yet. Typechecks against phase 1's `repo.ts` / `state.ts` and phase 2's `embedder.ts`.

### Step 2: The worker
**File:** `src/embeddings/worker.ts` (new)
**Change:** Wraps `runBackfill` in a lifecycle. `created` / `updated` events (update, append, revert and image ingest all emit one of these after commit; `deleted` / `restored` do not change the body and are ignored) call `kick()`, which schedules one drain after `debounceMs` and coalesces further kicks into it. A `setInterval` sweep (unref'd) drains every `sweepMs` for the other laptop's writes and for retries that came due. At start it drains once (the background backfill of old notes). A drain requested while one runs sets `again`, so the running drain does one more pass. The limiter is shared across drains. A drain that throws (database down) is logged as one line and the worker carries on. `idle()` flushes a pending debounce and resolves when no drain is running. `close()` unsubscribes, clears timers, aborts and waits for the in-flight batch, but at most `closeGraceMs` (5 s): `src/main.ts` force-exits 10 s after SIGTERM and an OpenRouter call may take up to its 15 s timeout, so a call still running after the grace is abandoned (its note stays pending and the next start embeds it).

**Code:**
```ts
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
```
**Impact:** new module. The vector and the body never reach a log line: `formatBatch` prints counts, ids and error messages only (invariant 6; phase 2's `EmbeddingError` messages never carry the key).

### Step 3: Start the worker in `startBackground`
**File:** `src/background.ts:1-25` (whole file replaced)
**Change:** After the inbox watcher, start the worker when `deps.embedder` is set (phase 2 makes it `Embedder | null`); otherwise log one line. Stop closes the inbox first (an ingest during shutdown only kicks the worker, which the sweep of the next start covers), then the worker, which waits for its in-flight batch. `startDaemon` (`src/daemon.ts:95,101`) already calls this and awaits the stop function before closing the db, so `daemon.ts` needs no change here.

**Code:**
```ts
import type { AppDeps } from './deps.js';
import { dbEmbeddingStore } from './embeddings/backfill.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './embeddings/worker.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { ensureDataDirs } from './images/store.js';

export type StopBackground = () => Promise<void>;

/**
 * Long-running work beside the HTTP server: the inbox watcher (iteration 2) and, when
 * OPENROUTER_API_KEY is set, the embedding worker (iteration 6).
 * Creates images/, cache/, inbox/, inbox/failed/ under the data dir first (idempotent; the
 * daemon already made them, but tests call this without startDaemon).
 */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  const img = imageDeps(deps);
  const dirs = await ensureDataDirs(img.dataDir);
  const inbox = await startInboxWatcher({
    inboxDir: dirs.inbox,
    failedDir: dirs.failed,
    ingest: (absPath) => ingestImage(img, { path: absPath, move: true, origin: { source: 'inbox' } }),
  });
  console.log(`[notesd] watching ${dirs.inbox}`);

  let embeddings: EmbeddingWorker | null = null;
  if (!deps.embedder) {
    console.log('[notesd] embeddings off: OPENROUTER_API_KEY is not set, search stays full text');
  } else {
    embeddings = startEmbeddingWorker({
      store: dbEmbeddingStore(deps.db),
      events: deps.events,
      embedder: deps.embedder,
    });
    console.log(`[notesd] embedding notes with ${deps.embedder.model}`);
  }

  return async () => {
    await inbox.close();
    await embeddings?.close();
  };
}
```
**Impact:** the daemon now embeds in the background when it has a key. `npm run test:int` stays offline: phase 2's test `Config` literals carry no key, so `startDaemon` builds a null embedder, and the existing `startBackground` caller (`tests/integration/images.int.test.ts:126`) passes `embedder: null` (phase 2 adds the field), which only logs the "embeddings off" line. If phase 2 has a daemon test that injects `StartDaemonOptions.embedder`, that daemon now also runs the worker against the injected fake; still no network.

### Step 4: The one-shot CLI
**File:** `src/cli/embedBackfill.ts` (new)
**Change:** `embedBackfill(args, io)` holds all the logic and takes its effects through `io` so tests can drive it; the bottom of the file runs `main()` only when the file is the process entry (`tsx src/cli/embedBackfill.ts`, or `node dist/cli/embedBackfill.js` after `build:server`). It parses `--retry-failed` / `--help`, loads config, exits 1 without `OPENROUTER_API_KEY` before opening the database, prints the stats line, runs `runBackfill` with a progress line per batch (`embedded 48/312, failed 0`) and one stderr line per failed note, prints a summary and always closes the database. First Ctrl-C aborts after the current batch (exit 130, rerun resumes); a second one exits at once.

Exit codes: 0 done with no failure, 1 any note failed / config error / store error, 2 bad argument, 130 interrupted.

**Code:**
```ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../config.js';
import { closeDb, createDb, type Db } from '../db/client.js';
import { dbEmbeddingStore, errorMessage, runBackfill } from '../embeddings/backfill.js';
import type { Embedder } from '../embeddings/embedder.js';
import { createOpenRouterEmbedder } from '../embeddings/openrouter.js';
import { embeddingStats } from '../embeddings/repo.js';

const USAGE = [
  'usage: npm run embed:backfill [-- --retry-failed]',
  '  Embeds every note whose vector is missing, stale (body or model changed) or failed and due.',
  '  Safe to stop (Ctrl-C) and run again: finished notes are not embedded twice.',
  '  --retry-failed  also retry failed notes now, without waiting for their backoff',
].join('\n');

/** Everything the command touches, injectable for tests. */
export interface EmbedBackfillIo {
  loadConfig: () => Config;
  createDb: (url: string) => Db;
  closeDb: (db: Db) => Promise<void>;
  createEmbedder: (apiKey: string) => Embedder;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Aborted on Ctrl-C by main(). */
  signal?: AbortSignal;
  /** Overrides DEFAULT_MIN_INTERVAL_MS (tests pass 0). */
  minIntervalMs?: number;
}

export function defaultIo(signal: AbortSignal): EmbedBackfillIo {
  return {
    loadConfig: () => loadConfig(),
    createDb,
    closeDb,
    createEmbedder: (apiKey) => createOpenRouterEmbedder({ apiKey }),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    signal,
  };
}

/** Returns the process exit code. */
export async function embedBackfill(args: readonly string[], io: EmbedBackfillIo): Promise<number> {
  let retryFailed = false;
  for (const arg of args) {
    if (arg === '--retry-failed') {
      retryFailed = true;
    } else if (arg === '--help' || arg === '-h') {
      io.out(USAGE);
      return 0;
    } else {
      io.err(`embed:backfill: unknown argument ${arg}`);
      io.err(USAGE);
      return 2;
    }
  }

  let config: Config;
  try {
    config = io.loadConfig();
  } catch (err) {
    io.err(`embed:backfill: ${errorMessage(err)}`);
    return 1;
  }
  const apiKey = config.embeddings.apiKey;
  if (!apiKey) {
    io.err('embed:backfill: OPENROUTER_API_KEY is not set. Put it in .env.local (or export it) and run again.');
    return 1;
  }

  const embedder = io.createEmbedder(apiKey);
  const db = io.createDb(config.databaseUrl);
  try {
    const before = await embeddingStats(db, embedder.model);
    io.out(
      `embed:backfill: ${embedder.model}; ${before.withText} notes with text, ${before.current} current, ` +
        `${before.pending} pending (${before.failing} failing)`,
    );
    const total = before.pending;
    const result = await runBackfill({
      store: dbEmbeddingStore(db),
      embedder,
      ignoreBackoff: retryFailed,
      signal: io.signal,
      ...(io.minIntervalMs !== undefined ? { minIntervalMs: io.minIntervalMs } : {}),
      onBatch: (report) => {
        for (const f of report.failures) io.err(`failed ${f.id}: ${f.error}`);
      },
      onProgress: (p) => {
        // Notes written while the run is going raise the count past the starting total.
        io.out(`embedded ${p.embedded}/${Math.max(total, p.embedded + p.failed)}, failed ${p.failed}`);
      },
    });
    const after = await embeddingStats(db, embedder.model);
    if (result.aborted) {
      io.out(
        `stopped: embedded ${result.embedded}, failed ${result.failed}; ${after.pending} still pending, run again to resume`,
      );
      return 130;
    }
    if (result.calls === 0) io.out('nothing to embed');
    io.out(`done: embedded ${result.embedded}, failed ${result.failed}; ${after.pending} pending`);
    if (!retryFailed && after.failing > 0) {
      io.out(`${after.failing} failed note(s) wait for their retry backoff; run with -- --retry-failed to try them now`);
    }
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    io.err(`embed:backfill: ${errorMessage(err)}`);
    return 1;
  } finally {
    await io.closeDb(db);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error('embed:backfill: stopping after the current batch (Ctrl-C again to quit now)');
    controller.abort();
  });
  process.exitCode = await embedBackfill(process.argv.slice(2), defaultIo(controller.signal));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error('embed:backfill: failed', err);
    process.exitCode = 1;
  });
}
```
**Impact:** new file. `tsconfig.server.json` includes `src/**`, so it also builds to `dist/cli/embedBackfill.js`. Importing the module from tests does not run `main()` (the entry check fails under vitest).

### Step 5: npm script
**File:** `package.json:65`
**Change:** add the script after `"db:check"` (the last entry today). Phase 6 adds `test:live:embeddings` later; that is a separate line.
**Code:**
```json
    "db:check": "drizzle-kit check",
    "embed:backfill": "tsx src/cli/embedBackfill.ts"
```
**Impact:** `npm run embed:backfill` and `npm run embed:backfill -- --retry-failed` work. Phase 6 runs it against Neon.

### Step 6: Unit-test fakes
**File:** `tests/helpers/memoryEmbeddingStore.ts` (new)
**Change:** An in-memory `EmbeddingStore` that follows phase 1's rules (pending = missing / stale by hash or model / failed and due or `ignoreBackoff`; save only when the body still hashes the same; attempts reset on success, +1 on a failure of the same hash, else 1; backoff from `retryDelayMs`), and a scripted embedder with a gate (hold a call open), a hook on each call, and an input predicate that makes a call fail. Kept separate from phase 2's `fakeEmbedder.ts` so the unit tests do not depend on that helper's API.

**Code:**
```ts
import type { EmbeddingStore } from '../../src/embeddings/backfill.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import type { PendingNote } from '../../src/embeddings/repo.js';
import { bodySha256, retryDelayMs } from '../../src/embeddings/state.js';

export interface MemoryEmbeddingRow {
  bodySha256: string;
  model: string;
  embedding: number[] | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
}

/** Phase 1's pending/save/failure rules over two maps. Listing order is insertion order. */
export class MemoryEmbeddingStore implements EmbeddingStore {
  readonly bodies = new Map<string, string>();
  readonly rows = new Map<string, MemoryEmbeddingRow>();
  listCalls = 0;
  /** When set, listPending throws it (a database outage). */
  failList: Error | null = null;
  now: () => number = () => Date.now();

  setBody(id: string, body: string): void {
    this.bodies.set(id, body);
  }

  isCurrent(id: string, model: string): boolean {
    const body = this.bodies.get(id);
    const row = this.rows.get(id);
    return (
      body !== undefined &&
      row !== undefined &&
      row.embedding !== null &&
      row.model === model &&
      row.bodySha256 === bodySha256(body)
    );
  }

  async listPending(opts: { model: string; limit: number; ignoreBackoff?: boolean }): Promise<PendingNote[]> {
    this.listCalls += 1;
    if (this.failList !== null) throw this.failList;
    const out: PendingNote[] = [];
    for (const [id, body] of this.bodies) {
      if (out.length >= opts.limit) break;
      if (body.trim() === '') continue;
      const sha = bodySha256(body);
      const row = this.rows.get(id);
      const pending =
        row === undefined ||
        row.bodySha256 !== sha ||
        row.model !== opts.model ||
        (row.embedding === null && (opts.ignoreBackoff === true || (row.nextAttemptAt ?? 0) <= this.now()));
      if (pending) out.push({ id, body, bodySha256: sha });
    }
    return out;
  }

  async saveEmbedding(v: { noteId: string; bodySha256: string; model: string; embedding: number[] }): Promise<boolean> {
    const body = this.bodies.get(v.noteId);
    if (body === undefined || bodySha256(body) !== v.bodySha256) return false;
    this.rows.set(v.noteId, {
      bodySha256: v.bodySha256,
      model: v.model,
      embedding: v.embedding,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
    });
    return true;
  }

  async recordFailure(v: { noteId: string; bodySha256: string; model: string; error: string }): Promise<void> {
    const prev = this.rows.get(v.noteId);
    const attempts = prev !== undefined && prev.bodySha256 === v.bodySha256 ? prev.attempts + 1 : 1;
    this.rows.set(v.noteId, {
      bodySha256: v.bodySha256,
      model: v.model,
      embedding: null,
      attempts,
      lastError: v.error.slice(0, 500),
      nextAttemptAt: this.now() + retryDelayMs(attempts),
    });
  }
}

/** A 3-wide embedder whose behaviour each test scripts. */
export class ScriptedEmbedder implements Embedder {
  readonly model = 'test/scripted';
  readonly dimensions = 3;
  readonly calls: string[][] = [];
  /** A call fails when any of its inputs matches. */
  failIf: ((input: string) => boolean) | null = null;
  /** When set, every call waits for it before answering. */
  gate: Promise<void> | null = null;
  /** Runs at the start of every call, before the gate. */
  onCall: ((inputs: readonly string[]) => void) | null = null;

  async embed(inputs: readonly string[]): Promise<number[][]> {
    this.calls.push([...inputs]);
    this.onCall?.(inputs);
    if (this.gate !== null) await this.gate;
    const failIf = this.failIf;
    if (failIf !== null && inputs.some((s) => failIf(s))) {
      throw new Error(`scripted failure on ${inputs.length} input(s)`);
    }
    return inputs.map((s) => [s.length, 1, 0]);
  }
}
```
**Impact:** test-only.

### Step 7: Unit tests for the drain loop
**File:** `tests/unit/embeddings/backfill.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { RateLimiter, runBackfill, type BatchReport, type Clock } from '../../../src/embeddings/backfill.js';
import { MemoryEmbeddingStore, ScriptedEmbedder } from '../../helpers/memoryEmbeddingStore.js';

function seed(store: MemoryEmbeddingStore, n: number, prefix = 'note'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `N-${String(i).padStart(3, '0')}`;
    store.setBody(id, `${prefix} ${i}`);
    ids.push(id);
  }
  return ids;
}

function fakeClock(): { clock: Clock; sleeps: number[]; now: () => number } {
  let t = 0;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { clock, sleeps, now: () => t };
}

describe('runBackfill', () => {
  it('drains in batches of batchSize and reports progress', async () => {
    const store = new MemoryEmbeddingStore();
    const ids = seed(store, 40);
    const embedder = new ScriptedEmbedder();
    const progress: number[] = [];
    const result = await runBackfill({
      store,
      embedder,
      batchSize: 16,
      minIntervalMs: 0,
      onProgress: (p) => progress.push(p.embedded),
    });
    expect(embedder.calls.map((c) => c.length)).toEqual([16, 16, 8]);
    expect(progress).toEqual([16, 32, 40]);
    expect(result).toEqual({ batches: 3, calls: 3, embedded: 40, failed: 0, skipped: 0, aborted: false });
    for (const id of ids) expect(store.isCurrent(id, embedder.model)).toBe(true);
  });

  it('falls back to per-note calls when a batch fails and records only the bad note', async () => {
    const store = new MemoryEmbeddingStore();
    seed(store, 4);
    store.setBody('P-OIS', 'poison input');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = (s) => s.includes('poison');
    const reports: BatchReport[] = [];
    const result = await runBackfill({ store, embedder, minIntervalMs: 0, onBatch: (r) => reports.push(r) });

    expect(embedder.calls.map((c) => c.length)).toEqual([5, 1, 1, 1, 1, 1]);
    expect(result).toMatchObject({ embedded: 4, failed: 1, calls: 6, aborted: false });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ notes: 5, fellBack: true, failed: 1 });
    expect(reports[0]?.failures[0]?.id).toBe('P-OIS');
    const row = store.rows.get('P-OIS');
    expect(row).toMatchObject({ embedding: null, attempts: 1 });
    expect(row?.nextAttemptAt ?? 0).toBeGreaterThan(Date.now());
  });

  it('records a single-note batch failure without a second call', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('P-OIS', 'poison input');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = () => true;
    const result = await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(embedder.calls).toHaveLength(1);
    expect(result).toMatchObject({ failed: 1, calls: 1 });
  });

  it('leaves a failed note alone until it is due; ignoreBackoff tries it once per run', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('P-OIS', 'poison input');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = () => true;
    await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(embedder.calls).toHaveLength(1);

    const notDue = await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(notDue.calls).toBe(0);

    const forced = await runBackfill({ store, embedder, minIntervalMs: 0, ignoreBackoff: true });
    expect(forced).toMatchObject({ calls: 1, failed: 1, aborted: false });
    expect(store.rows.get('P-OIS')?.attempts).toBe(2);

    embedder.failIf = null;
    const healed = await runBackfill({ store, embedder, minIntervalMs: 0, ignoreBackoff: true });
    expect(healed).toMatchObject({ embedded: 1, failed: 0 });
    expect(store.rows.get('P-OIS')).toMatchObject({ attempts: 0, lastError: null });
  });

  it('stops on abort and a second run finishes without re-embedding', async () => {
    const store = new MemoryEmbeddingStore();
    const ids = seed(store, 40);
    const embedder = new ScriptedEmbedder();
    const stop = new AbortController();
    const first = await runBackfill({
      store,
      embedder,
      batchSize: 16,
      minIntervalMs: 0,
      signal: stop.signal,
      onBatch: () => stop.abort(),
    });
    expect(first).toMatchObject({ aborted: true, embedded: 16 });

    const second = await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 0 });
    expect(second).toMatchObject({ aborted: false, embedded: 24 });
    const sent = embedder.calls.flat();
    expect(sent).toHaveLength(40);
    expect(new Set(sent).size).toBe(40);
    for (const id of ids) expect(store.isCurrent(id, embedder.model)).toBe(true);
  });

  it('makes no call when aborted before it starts', async () => {
    const store = new MemoryEmbeddingStore();
    seed(store, 3);
    const embedder = new ScriptedEmbedder();
    const stop = new AbortController();
    stop.abort();
    const result = await runBackfill({ store, embedder, minIntervalMs: 0, signal: stop.signal });
    expect(result).toMatchObject({ aborted: true, calls: 0 });
    expect(embedder.calls).toHaveLength(0);
  });

  it('skips a vector whose body changed during the call and embeds the new body', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'first body');
    const embedder = new ScriptedEmbedder();
    let edited = false;
    embedder.onCall = () => {
      if (!edited) {
        edited = true;
        store.setBody('A-001', 'second body');
      }
    };
    const result = await runBackfill({ store, embedder, minIntervalMs: 0 });
    expect(result).toMatchObject({ embedded: 1, skipped: 1, calls: 2 });
    expect(embedder.calls).toEqual([['first body'], ['second body']]);
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);
  });

  it('spaces calls by minIntervalMs', async () => {
    const store = new MemoryEmbeddingStore();
    seed(store, 40);
    const embedder = new ScriptedEmbedder();
    const { clock, sleeps, now } = fakeClock();
    const callTimes: number[] = [];
    embedder.onCall = () => callTimes.push(now());
    await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 1000, clock });
    expect(callTimes).toEqual([0, 1000, 2000]);
    expect(sleeps).toEqual([1000, 1000]);
  });
});

describe('RateLimiter', () => {
  it('returns false without a slot when the signal is aborted', async () => {
    const limiter = new RateLimiter(10_000);
    expect(await limiter.acquire()).toBe(true);
    const stop = new AbortController();
    const pending = limiter.acquire(stop.signal);
    stop.abort();
    expect(await pending).toBe(false);
  });
});
```
**Impact:** test-only; no network, no database.

### Step 8: Unit tests for the worker
**File:** `tests/unit/embeddings/worker.test.ts` (new)
**Code:**
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { startEmbeddingWorker, type EmbeddingWorker } from '../../../src/embeddings/worker.js';
import { NoteEvents } from '../../../src/notes/events.js';
import { MemoryEmbeddingStore, ScriptedEmbedder } from '../../helpers/memoryEmbeddingStore.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let worker: EmbeddingWorker | null = null;

afterEach(async () => {
  await worker?.close();
  worker = null;
});

function start(
  store: MemoryEmbeddingStore,
  embedder: ScriptedEmbedder,
  events = new NoteEvents(),
  sweepMs = 3_600_000,
): { events: NoteEvents; logs: string[]; worker: EmbeddingWorker } {
  const logs: string[] = [];
  worker = startEmbeddingWorker({
    store,
    events,
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs,
    log: (line) => logs.push(line),
  });
  return { events, logs, worker };
}

describe('startEmbeddingWorker', () => {
  it('drains existing notes at start and logs one line per batch', async () => {
    const store = new MemoryEmbeddingStore();
    for (let i = 0; i < 20; i += 1) store.setBody(`N-${i}`, `note ${i}`);
    const embedder = new ScriptedEmbedder();
    const { logs, worker: w } = start(store, embedder);
    await w.idle();
    expect(embedder.calls.map((c) => c.length)).toEqual([16, 4]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^\[notesd\] embeddings: 16\/16 embedded, 1 call, \d+ms$/);
  });

  it('an idle worker sweeps but makes no call and logs nothing', async () => {
    const store = new MemoryEmbeddingStore();
    const embedder = new ScriptedEmbedder();
    const { logs } = start(store, embedder, new NoteEvents(), 5);
    await sleep(60);
    expect(store.listCalls).toBeGreaterThanOrEqual(3);
    expect(embedder.calls).toHaveLength(0);
    expect(logs).toEqual([]);
  });

  it('created and updated events trigger a drain; deleted and restored do not', async () => {
    const store = new MemoryEmbeddingStore();
    const embedder = new ScriptedEmbedder();
    const { events, worker: w } = start(store, embedder);
    await w.idle();

    store.setBody('A-001', 'hello');
    events.emit('created', 'A-001');
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    store.setBody('A-001', 'hello again');
    events.emit('updated', 'A-001');
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    const lists = store.listCalls;
    events.emit('deleted', 'A-001');
    events.emit('restored', 'A-001');
    await w.idle();
    expect(store.listCalls).toBe(lists);
    expect(embedder.calls).toHaveLength(2);
  });

  it('a kick during a drain runs one more pass', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'first');
    const embedder = new ScriptedEmbedder();
    let release!: () => void;
    embedder.gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const { events, worker: w } = start(store, embedder);
    await callStarted;

    store.setBody('A-002', 'second');
    events.emit('created', 'A-002');
    await sleep(10);
    embedder.gate = null;
    release();
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);
    expect(store.isCurrent('A-002', embedder.model)).toBe(true);
  });

  it('logs a failed batch with the bad note id', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'fine');
    store.setBody('P-OIS', 'poison');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = (s) => s === 'poison';
    const { logs, worker: w } = start(store, embedder);
    await w.idle();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('1/2 embedded');
    expect(logs[0]).toContain('1 failed (P-OIS: scripted failure');
    expect(logs[0]).toContain('per-note fallback');
  });

  it('a store error is logged and the worker keeps going', async () => {
    const store = new MemoryEmbeddingStore();
    store.failList = new Error('db down');
    const embedder = new ScriptedEmbedder();
    const { logs, worker: w } = start(store, embedder);
    await w.idle();
    expect(logs).toEqual(['[notesd] embeddings: drain failed: db down']);

    store.failList = null;
    store.setBody('A-001', 'back up');
    w.kick();
    await w.idle();
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);
  });

  it('close waits for the in-flight batch, saves it, and ignores later events', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'in flight');
    const embedder = new ScriptedEmbedder();
    let release!: () => void;
    embedder.gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const { events, worker: w } = start(store, embedder);
    await callStarted;

    let closed = false;
    const closing = w.close().then(() => {
      closed = true;
    });
    await sleep(20);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(store.isCurrent('A-001', embedder.model)).toBe(true);

    embedder.gate = null;
    store.setBody('A-002', 'after close');
    events.emit('created', 'A-002');
    w.kick();
    await w.idle();
    expect(embedder.calls).toHaveLength(1);
    expect(events.listenerCount()).toBe(0);
  });

  it('close gives up on an in-flight batch after closeGraceMs', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('A-001', 'stuck');
    const embedder = new ScriptedEmbedder();
    embedder.gate = new Promise<void>(() => {}); // never answers
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const w = startEmbeddingWorker({
      store,
      events: new NoteEvents(),
      embedder,
      minIntervalMs: 0,
      debounceMs: 0,
      sweepMs: 3_600_000,
      closeGraceMs: 30,
      log: () => {},
    });
    await callStarted;
    const t0 = Date.now();
    await w.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(store.isCurrent('A-001', embedder.model)).toBe(false);
  });
});
```
**Impact:** test-only. Real timers with `debounceMs: 0`; the only real waits are the 60 ms idle-sweep test, two 10–20 ms pauses and the 30 ms close grace.

### Step 9: Unit tests for the CLI's early exits
**File:** `tests/unit/embeddings/embedBackfillCli.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { embedBackfill, type EmbedBackfillIo } from '../../../src/cli/embedBackfill.js';
import { ConfigError, DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../../src/config.js';

interface Captured {
  io: EmbedBackfillIo;
  out: string[];
  err: string[];
  dbsOpened: () => number;
}

function capture(loadConfig: () => Config): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let dbs = 0;
  const io: EmbedBackfillIo = {
    loadConfig,
    createDb: () => {
      dbs += 1;
      throw new Error('createDb must not be called');
    },
    closeDb: async () => {},
    createEmbedder: () => {
      throw new Error('createEmbedder must not be called');
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err, dbsOpened: () => dbs };
}

const noKey = (): Config => ({
  databaseUrl: 'postgres://u:p@127.0.0.1:1/x',
  port: 0,
  host: '127.0.0.1',
  dataDir: '/tmp/mcp-notes-unused',
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
});

describe('embedBackfill CLI', () => {
  it('prints usage for --help and exits 0 without loading config', async () => {
    const c = capture(() => {
      throw new Error('loadConfig must not be called');
    });
    expect(await embedBackfill(['--help'], c.io)).toBe(0);
    expect(c.out.join('\n')).toMatch(/--retry-failed/);
  });

  it('rejects an unknown argument with exit 2', async () => {
    const c = capture(noKey);
    expect(await embedBackfill(['--fast'], c.io)).toBe(2);
    expect(c.err[0]).toBe('embed:backfill: unknown argument --fast');
  });

  it('exits 1 without OPENROUTER_API_KEY and never opens the database', async () => {
    const c = capture(noKey);
    expect(await embedBackfill([], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/OPENROUTER_API_KEY is not set/);
    expect(c.dbsOpened()).toBe(0);
  });

  it('exits 1 on a config error', async () => {
    const c = capture(() => {
      throw new ConfigError('DATABASE_URL is not set.');
    });
    expect(await embedBackfill([], c.io)).toBe(1);
    expect(c.err).toEqual(['embed:backfill: DATABASE_URL is not set.']);
  });
});
```
**Impact:** test-only; relies on phase 2's `DEFAULT_EMBEDDINGS_CONFIG` and `Config.embeddings`.

### Step 10: Integration tests on the pgvector container
**File:** `tests/integration/embeddings.worker.int.test.ts` (new)
**Change:** Uses phase 2's `createFakeEmbedder()` for real 1536-wide vectors, wrapped in a probe that records inputs and can fail or delay calls, so assertions depend only on this phase's code. Checks rows in `note_embeddings` directly against `bodySha256` (phase 1).

**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackground } from '../../src/background.js';
import { embedBackfill } from '../../src/cli/embedBackfill.js';
import { DEFAULT_CHAT_CONFIG, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { dbEmbeddingStore, runBackfill } from '../../src/embeddings/backfill.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import { bodySha256 } from '../../src/embeddings/state.js';
import { startEmbeddingWorker, type EmbeddingWorker } from '../../src/embeddings/worker.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import type { ImageMeta } from '../../src/notes/types.js';
import { createFakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

interface Probe extends Embedder {
  inputs: string[][];
  failIf: ((input: string) => boolean) | null;
  delayMs: number;
}

function probe(inner: Embedder = createFakeEmbedder()): Probe {
  const p: Probe = {
    model: inner.model,
    dimensions: inner.dimensions,
    inputs: [],
    failIf: null,
    delayMs: 0,
    async embed(inputs, opts) {
      p.inputs.push([...inputs]);
      if (p.delayMs > 0) await new Promise((r) => setTimeout(r, p.delayMs));
      const failIf = p.failIf;
      if (failIf !== null && inputs.some((s) => failIf(s))) throw new Error('probe: embedding refused');
      return inner.embed(inputs, opts);
    },
  };
  return p;
}

// A type alias, not an interface: db.execute<T> needs T assignable to Record<string, unknown>.
type EmbRow = {
  body_sha256: string;
  model: string;
  has_vector: boolean;
  attempts: number;
  last_error: string | null;
  due: boolean;
};

let db: Db;
let dataDir: string;
let worker: EmbeddingWorker | null = null;

async function embRow(id: string): Promise<EmbRow | null> {
  const res = await db.execute<EmbRow>(sql`
    select body_sha256, model, embedding is not null as has_vector, attempts, last_error,
           (next_attempt_at is null or next_attempt_at <= now()) as due
    from note_embeddings where note_id = ${id}
  `);
  return res.rows[0] ?? null;
}

async function expectCurrent(id: string, body: string, model: string): Promise<void> {
  expect(await embRow(id)).toMatchObject({ body_sha256: bodySha256(body), model, has_vector: true, attempts: 0 });
}

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function imageMeta(): ImageMeta {
  return {
    sha256: randomBytes(32).toString('hex'),
    mime: 'image/jpeg',
    width: 10,
    height: 10,
    bytes: 100,
    taken_at: null,
    original_name: 'x.jpg',
    host: 'test-host',
  };
}

function config(apiKey: string | null): Config {
  return {
    databaseUrl: testDatabaseUrl(),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    chat: DEFAULT_CHAT_CONFIG,
    embeddings: { apiKey },
  };
}

/** A service whose writes nobody listens to (notes written "before" the worker or by the other laptop). */
function quietService(): NotesService {
  return new NotesService({ db, dataDir, events: new NoteEvents() });
}

function rig(sweepMs = 3_600_000): { notes: NotesService; embedder: Probe; logs: string[]; worker: EmbeddingWorker } {
  const events = new NoteEvents();
  const notes = new NotesService({ db, dataDir, events });
  const embedder = probe();
  const logs: string[] = [];
  worker = startEmbeddingWorker({
    store: dbEmbeddingStore(db),
    events,
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs,
    log: (line) => logs.push(line),
  });
  return { notes, embedder, logs, worker };
}

beforeAll(async () => {
  db = openTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-emb-'));
});

afterAll(async () => {
  await closeTestDb(db);
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(db);
});

afterEach(async () => {
  await worker?.close();
  worker = null;
});

describe('embedding worker against Postgres', () => {
  it('create, update, append and revert each end with a current vector', async () => {
    const { notes, embedder, logs, worker: w } = rig();
    await w.idle();
    expect(logs).toEqual([]);

    const a = await notes.create({ body: 'arango root password is in the vault #ops' });
    await w.idle();
    await expectCurrent(a.id, a.body, embedder.model);

    const u = await notes.update(a.id, 'arango root password moved to the team vault');
    await w.idle();
    await expectCurrent(a.id, u.body, embedder.model);

    const ap = await notes.append(a.id, 'rotated on friday');
    await w.idle();
    await expectCurrent(a.id, ap.body, embedder.model);

    const original = (await notes.revisions(a.id)).find((r) => r.body === a.body);
    expect(original).toBeDefined();
    const rv = await notes.revert(a.id, original!.revision);
    expect(rv.body).toBe(a.body);
    await w.idle();
    await expectCurrent(a.id, rv.body, embedder.model);

    expect(embedder.inputs).toHaveLength(4);
    expect(logs).toHaveLength(4);
  });

  it('embeds an image note by its text and leaves a textless photo alone', async () => {
    const { notes, embedder, worker: w } = rig();
    const withText = await notes.create({
      body: 'whiteboard of the arango cluster layout',
      allowEmpty: true,
      image: { path: 'images/2026/10/t1.jpg', meta: imageMeta() },
    });
    const bare = await notes.create({
      body: '',
      allowEmpty: true,
      image: { path: 'images/2026/10/t2.jpg', meta: imageMeta() },
    });
    await w.idle();
    await expectCurrent(withText.id, withText.body, embedder.model);
    expect(await embRow(bare.id)).toBeNull();
    expect(embedder.inputs.flat()).toEqual(['whiteboard of the arango cluster layout']);
  });

  it('a failing embedder never fails the write; the note is marked and retried after backoff', async () => {
    const { notes, embedder, logs, worker: w } = rig();
    await w.idle();
    embedder.failIf = () => true;

    const n = await notes.create({ body: 'the login broke after the laptop slept' });
    expect((await notes.getOne(n.id))?.body).toBe(n.body);
    await w.idle();

    const failed = await embRow(n.id);
    expect(failed).toMatchObject({ body_sha256: bodySha256(n.body), has_vector: false, attempts: 1, due: false });
    expect(failed?.last_error).toMatch(/refused/);
    expect(logs.some((l) => l.includes(n.id) && l.includes('1 failed'))).toBe(true);

    embedder.failIf = null;
    const callsAfterFailure = embedder.inputs.length;
    w.kick();
    await w.idle();
    expect(embedder.inputs.length).toBe(callsAfterFailure);

    await db.execute(sql`update note_embeddings set next_attempt_at = now() - interval '1 second' where note_id = ${n.id}`);
    w.kick();
    await w.idle();
    await expectCurrent(n.id, n.body, embedder.model);
  });

  it('an edit after a failure is embedded at once (the body changed since the failure)', async () => {
    const { notes, embedder, worker: w } = rig();
    embedder.failIf = () => true;
    const n = await notes.create({ body: 'auth failures after resume' });
    await w.idle();
    expect(await embRow(n.id)).toMatchObject({ has_vector: false, due: false });

    embedder.failIf = null;
    const u = await notes.update(n.id, 'auth failures after resume, fixed by restarting the agent');
    await w.idle();
    await expectCurrent(n.id, u.body, embedder.model);
  });

  it('a slow embedder does not slow a write', async () => {
    const { notes, embedder, worker: w } = rig();
    await w.idle();
    embedder.delayMs = 1500;
    const t0 = Date.now();
    const n = await notes.create({ body: 'written while the embedder is slow' });
    expect(Date.now() - t0).toBeLessThan(500);
    await w.idle();
    await expectCurrent(n.id, n.body, embedder.model);
  });

  it('an idle worker makes no call and logs nothing', async () => {
    const { embedder, logs } = rig(20);
    await new Promise((r) => setTimeout(r, 150));
    expect(embedder.inputs).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('picks up writes it got no event for (the other laptop) on the sweep', async () => {
    const other = quietService();
    const { embedder } = rig(50);
    const n = await other.create({ body: 'written on the GPD' });
    await until(async () => (await embRow(n.id))?.has_vector === true);
    await expectCurrent(n.id, n.body, embedder.model);
  });

  it('keeps a deleted note\'s vector, embeds a note deleted before it was embedded, and restore makes no call', async () => {
    const early = await quietService().create({ body: 'deleted before any embedding' });
    await quietService().delete(early.id);

    const { notes, embedder, worker: w } = rig();
    await w.idle();
    await expectCurrent(early.id, early.body, embedder.model);

    const n = await notes.create({ body: 'kept through delete and restore' });
    await w.idle();
    const calls = embedder.inputs.length;

    await notes.delete(n.id);
    await w.idle();
    await expectCurrent(n.id, n.body, embedder.model);

    await notes.restore(n.id);
    await notes.restore(early.id);
    w.kick();
    await w.idle();
    expect(embedder.inputs.length).toBe(calls);
    await expectCurrent(n.id, n.body, embedder.model);
    await expectCurrent(early.id, early.body, embedder.model);
  });
});

describe('runBackfill against Postgres', () => {
  it('a backfill stopped mid-way resumes without re-embedding finished notes', async () => {
    const notes = quietService();
    const created: Array<{ id: string; body: string }> = [];
    for (let i = 0; i < 40; i += 1) {
      const n = await notes.create({ body: `backfill note ${i} about topic ${i % 7}` });
      created.push({ id: n.id, body: n.body });
    }
    const embedder = probe();
    const store = dbEmbeddingStore(db);
    const stop = new AbortController();
    const first = await runBackfill({
      store,
      embedder,
      batchSize: 16,
      minIntervalMs: 0,
      signal: stop.signal,
      onBatch: () => stop.abort(),
    });
    expect(first).toMatchObject({ aborted: true, embedded: 16, failed: 0 });

    const second = await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 0 });
    expect(second).toMatchObject({ aborted: false, embedded: 24, failed: 0 });

    const sent = embedder.inputs.flat();
    expect(sent).toHaveLength(40);
    expect(new Set(sent).size).toBe(40);
    for (const n of created) await expectCurrent(n.id, n.body, embedder.model);

    const third = await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 0 });
    expect(third.calls).toBe(0);
  });
});

describe('startBackground', () => {
  function deps(embedder: Embedder | null): AppDeps {
    const events = new NoteEvents();
    return {
      config: config(null),
      db,
      events,
      service: new NotesService({ db, dataDir, events }),
      embedder,
    };
  }

  it('runs the worker when an embedder is configured and stops it on shutdown', async () => {
    const embedder = probe();
    const d = deps(embedder);
    const stop = await startBackground(d);
    try {
      const n = await d.service.create({ body: 'from the daemon path' });
      await until(async () => (await embRow(n.id))?.has_vector === true);
      await expectCurrent(n.id, n.body, embedder.model);
    } finally {
      await stop();
    }
  });

  it('logs once and embeds nothing without an embedder', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps(null);
    const stop = await startBackground(d);
    try {
      const n = await d.service.create({ body: 'no key, no vector' });
      await new Promise((r) => setTimeout(r, 200));
      expect(await embRow(n.id)).toBeNull();
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('embeddings off'))).toHaveLength(1);
    } finally {
      await stop();
      log.mockRestore();
    }
  });
});

describe('npm run embed:backfill', () => {
  function cli(embedder: Probe, out: string[], err: string[], closed: { n: number }) {
    return {
      loadConfig: () => config('test-key'),
      createDb: () => openTestDb(),
      closeDb: async (d: Db) => {
        closed.n += 1;
        await closeTestDb(d);
      },
      createEmbedder: (key: string) => {
        expect(key).toBe('test-key');
        return embedder;
      },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      minIntervalMs: 0,
    };
  }

  it('prints progress, finishes, and closes the database', async () => {
    const notes = quietService();
    for (let i = 0; i < 20; i += 1) await notes.create({ body: `cli note ${i}` });
    const embedder = probe();
    const out: string[] = [];
    const err: string[] = [];
    const closed = { n: 0 };
    const code = await embedBackfill([], cli(embedder, out, err, closed));
    expect(code).toBe(0);
    expect(closed.n).toBe(1);
    expect(out[0]).toMatch(/20 pending/);
    expect(out).toContain('embedded 16/20, failed 0');
    expect(out).toContain('embedded 20/20, failed 0');
    expect(out.at(-1)).toBe('done: embedded 20, failed 0; 0 pending');
    expect(err).toEqual([]);
  });

  it('--retry-failed retries a failed note without waiting for its backoff', async () => {
    const n = await quietService().create({ body: 'flaky note' });
    const failing = probe();
    failing.failIf = () => true;
    await runBackfill({ store: dbEmbeddingStore(db), embedder: failing, minIntervalMs: 0 });
    expect(await embRow(n.id)).toMatchObject({ has_vector: false, due: false });

    const healthy = probe();
    const out1: string[] = [];
    expect(await embedBackfill([], cli(healthy, out1, [], { n: 0 }))).toBe(0);
    expect(healthy.inputs).toEqual([]);
    expect(out1.join('\n')).toMatch(/--retry-failed/);

    const stillFailing = probe();
    stillFailing.failIf = () => true;
    const err2: string[] = [];
    expect(await embedBackfill(['--retry-failed'], cli(stillFailing, [], err2, { n: 0 }))).toBe(1);
    expect(err2).toEqual([`failed ${n.id}: probe: embedding refused`]);

    const out3: string[] = [];
    expect(await embedBackfill(['--retry-failed'], cli(healthy, out3, [], { n: 0 }))).toBe(0);
    await expectCurrent(n.id, 'flaky note', healthy.model);
  });
});
```
**Impact:** test-only. Needs phase 1's `truncateAll` to clear `note_embeddings` (the `ON DELETE CASCADE` FK makes `truncate ... notes cascade` cover it too) and phase 2's `fakeEmbedder.ts`. No network: every embedder here is the probe around the fake.

## Verification

**Build:** `npm run typecheck && npm run build:server`
**Tests:** `npm test` (adds `tests/unit/embeddings/{backfill,worker,embedBackfillCli}.test.ts`) and `npm run test:int` (adds `tests/integration/embeddings.worker.int.test.ts`; every existing integration file still passes, `images.int.test.ts`'s `startBackground` case now also prints the "embeddings off" line)
**Manual check:**
- `npm run embed:backfill -- --help` prints the usage and exits 0.
- With `OPENROUTER_API_KEY` removed from the environment and `.env.local` absent: `npm run embed:backfill` exits 1 with the "not set" line. (Running it for real against Neon is phase 6.)
- `grep -rn "embedding" src/embeddings/worker.ts src/cli/embedBackfill.ts` shows no line that logs a vector, a body or the key.
**Exit criteria:** with the fake embedder, every write path (create, update, append, revert, image with text) has a current vector after `idle()`; a textless photo has no row; a failing embedder leaves the write intact, records `attempts = 1` and a future `next_attempt_at`, makes no call before it is due and embeds after; an aborted backfill resumes and sends each body exactly once across both runs; deleted notes keep their vectors and restore makes no call; an idle worker logs nothing; `close()` returns within `closeGraceMs` even when a call hangs; `npm run embed:backfill` prints `embedded n/total, failed f` per batch, honours `--retry-failed`, exits non-zero without a key and always closes the database.

## Handoffs

- **Phase 6 (docs, R6 acceptance):** README / `docs/INSTALL.md` should document `npm run embed:backfill [-- --retry-failed]`, its exit codes (0, 1, 2, 130), the daemon log lines `[notesd] embedding notes with <model>`, `[notesd] embeddings off: ...`, the per-batch `[notesd] embeddings: ...` line, and that both laptops run the worker harmlessly. Phase 6 runs the first backfill against Neon with this command.
- **Phase 2 (R1, config):** batch size, rate interval and sweep period are constants (`DEFAULT_BATCH_SIZE`, `DEFAULT_MIN_INTERVAL_MS`, `DEFAULT_SWEEP_MS`) and are not read from the environment. If phase 2 wants env overrides in `Config.embeddings`, `startBackground` is where they would be passed; this phase does not add config keys.
- **Phase 4 / Phase 5 tests:** neither depends on this phase, so neither imports `runBackfill` / `dbEmbeddingStore`; both seed vectors with phase 1's `saveEmbedding` directly (confirmed in their plans; no edge added).
- **Shutdown budget (reconciled, owned here):** phase 2's OpenRouter timeout is 15 s and `src/main.ts:11` force-exits after 10 s, so `close()` waits for an in-flight call at most `DEFAULT_CLOSE_GRACE_MS` (5 s), leaving the rest of the budget for `closeServer` / `closeDb`. An abandoned call loses nothing (the note stays pending). `main.ts` and phase 2's timeout are unchanged.

## Rollback

Revert this phase's commit: deletes `src/embeddings/{backfill,worker}.ts`, `src/cli/embedBackfill.ts`, the four test files and the helper, restores `src/background.ts` to the inbox-only version and drops the `embed:backfill` script. Phases 1 and 2 keep working (no vectors get written; search falls back to text in phase 4). Rows already written to `note_embeddings` are harmless and stay valid.
