import type { Db } from '../db/client.js';
import { OriginalMissingError } from '../images/derive.js';
import { fileExists, resolveInDataDir } from '../images/store.js';
import { DEFAULT_MIN_INTERVAL_MS, RateLimiter, errorMessage, realClock, type Clock } from './backfill.js';
import type { ImageEmbedder } from './imageEmbedder.js';
import { notePngForEmbedding } from './imageInput.js';
import { listPendingImages, recordImageFailure, saveImageEmbedding, type PendingImage } from './imageRepo.js';

/** Pending rows read per query. */
export const DEFAULT_IMAGE_PAGE_SIZE = 32;
/** An image found missing on this machine is not looked at again for this long (worker memo). */
export const DEFAULT_UNAVAILABLE_RECHECK_MS = 60 * 60_000;

/** What the drain loop needs. `dbImageEmbeddingStore` is the real one; unit tests use a memory one. */
export interface ImageEmbeddingStore {
  listPending(opts: {
    model: string;
    limit: number;
    ignoreBackoff?: boolean;
    excludeIds: readonly string[];
  }): Promise<PendingImage[]>;
  /** True when the image's original is on this machine. */
  isAvailable(image: PendingImage): Promise<boolean>;
  /** The PNG to send. Throws OriginalMissingError when the original vanished after isAvailable. */
  loadPng(image: PendingImage): Promise<Uint8Array>;
  save(v: { imageId: string; imageSha256: string; model: string; embedding: number[] }): Promise<boolean>;
  recordFailure(v: { imageId: string; imageSha256: string; model: string; error: string }): Promise<void>;
}

export function dbImageEmbeddingStore(db: Db, dataDir: string): ImageEmbeddingStore {
  const originalOf = (image: PendingImage): string | null => {
    try {
      return resolveInDataDir(dataDir, image.path);
    } catch {
      return null;
    }
  };
  return {
    listPending: (opts) => listPendingImages(db, opts),
    async isAvailable(image) {
      const p = originalOf(image);
      return p !== null && (await fileExists(p));
    },
    async loadPng(image) {
      const p = originalOf(image);
      if (p === null) throw new OriginalMissingError(image.id, image.path);
      return notePngForEmbedding(dataDir, { id: image.id, mime: image.mime, originalPath: p });
    },
    save: (v) => saveImageEmbedding(db, v),
    recordFailure: (v) => recordImageFailure(db, v),
  };
}

/** Image ids whose original was missing here, each remembered until `recheckMs` has passed. */
export class UnavailableImages {
  private readonly until = new Map<string, number>();
  private readonly recheckMs: number;
  private readonly clock: Clock;

  constructor(recheckMs: number = DEFAULT_UNAVAILABLE_RECHECK_MS, clock: Clock = realClock) {
    this.recheckMs = Math.max(0, recheckMs);
    this.clock = clock;
  }

  add(id: string): void {
    this.until.set(id, this.clock.now() + this.recheckMs);
  }

  /** Ids still remembered; expired ones are dropped (and so looked at again). */
  ids(): string[] {
    const now = this.clock.now();
    const out: string[] = [];
    for (const [id, until] of this.until) {
      if (until > now) out.push(id);
      else this.until.delete(id);
    }
    return out;
  }
}

export type ImageOutcome = 'embedded' | 'failed' | 'skipped' | 'unavailable';

export interface ImageReport {
  imageId: string;
  outcome: ImageOutcome;
  /** Set when outcome is 'failed'. */
  error?: string;
  ms: number;
}

export interface ImageBackfillProgress {
  /** Embedding calls made. */
  calls: number;
  embedded: number;
  /** Images whose call (or PNG preparation) failed; each got recordFailure. */
  failed: number;
  /** Vectors not saved because the image's bytes changed or it was purged during the call. */
  skipped: number;
  /** Images whose original is not on this machine: left pending, no failure recorded. */
  unavailable: number;
}

export interface ImageBackfillResult extends ImageBackfillProgress {
  /** The signal stopped the run before the queue was empty. */
  aborted: boolean;
  /** maxImages was reached while images were still pending. */
  limited: boolean;
}

export interface ImageBackfillOptions {
  store: ImageEmbeddingStore;
  embedder: ImageEmbedder;
  /** Shared limiter (the worker passes its own so the gap holds across drains). */
  limiter?: RateLimiter;
  /** Used only when `limiter` is not given. */
  minIntervalMs?: number;
  /** Also take failed images whose next_attempt_at is in the future (`--retry-failed`). */
  ignoreBackoff?: boolean;
  /** Checked before every image and before every call; an in-flight call is finished and saved. */
  signal?: AbortSignal;
  clock?: Clock;
  /** Stop after this many embedded + failed + skipped images (`--limit`). */
  maxImages?: number;
  pageSize?: number;
  /** Cross-run memo of missing originals (the worker's). Seeds this run's exclusions. */
  unavailable?: UnavailableImages;
  /** After every image, with its outcome. */
  onImage?: (report: ImageReport) => void;
  /** After every image, with running totals. */
  onProgress?: (progress: ImageBackfillProgress) => void;
}

/**
 * Embeds pending images until none is left on this machine (or the signal aborts, or maxImages
 * is reached). Each image is offered at most once per run; images listed but not on this machine
 * are settled without a failure, and the settled set is excluded in SQL, so a long tail of the
 * other laptop's images never hides a local one. Store errors (database down) reject; embedding
 * and PNG errors never do.
 */
export async function runImageBackfill(opts: ImageBackfillOptions): Promise<ImageBackfillResult> {
  const clock = opts.clock ?? realClock;
  const limiter = opts.limiter ?? new RateLimiter(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, clock);
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_IMAGE_PAGE_SIZE));
  const maxImages =
    opts.maxImages === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(opts.maxImages));
  const model = opts.embedder.model;
  const settled = new Set<string>(opts.unavailable?.ids() ?? []);
  const totals: ImageBackfillProgress = { calls: 0, embedded: 0, failed: 0, skipped: 0, unavailable: 0 };
  // A function, not the property: TS would narrow `aborted` to false across the awaits.
  const aborted = (): boolean => opts.signal?.aborted === true;
  let limited = false;

  const report = (r: ImageReport): void => {
    opts.onImage?.(r);
    opts.onProgress?.({ ...totals });
  };

  const markUnavailable = (image: PendingImage): void => {
    totals.unavailable += 1;
    opts.unavailable?.add(image.id);
    report({ imageId: image.id, outcome: 'unavailable', ms: 0 });
  };

  const fail = async (image: PendingImage, error: string, started: number): Promise<void> => {
    await opts.store.recordFailure({ imageId: image.id, imageSha256: image.sha256, model, error });
    totals.failed += 1;
    report({ imageId: image.id, outcome: 'failed', error, ms: clock.now() - started });
  };

  drain: while (!aborted()) {
    const page = await opts.store.listPending({
      model,
      limit: pageSize,
      ignoreBackoff: opts.ignoreBackoff === true,
      excludeIds: [...settled],
    });
    let fresh = 0;
    for (const image of page) {
      if (aborted()) break drain;
      if (settled.has(image.id)) continue;
      if (totals.embedded + totals.failed + totals.skipped >= maxImages) {
        limited = true;
        break drain;
      }
      fresh += 1;
      settled.add(image.id);
      const started = clock.now();

      if (!(await opts.store.isAvailable(image))) {
        markUnavailable(image);
        continue;
      }

      let png: Uint8Array;
      try {
        png = await opts.store.loadPng(image);
      } catch (err) {
        if (err instanceof OriginalMissingError) {
          markUnavailable(image);
          continue;
        }
        await fail(image, `could not prepare the image: ${errorMessage(err)}`, started);
        continue;
      }

      // Aborted while waiting for a slot: the image stays pending for the next run.
      if (!(await limiter.acquire(opts.signal))) break drain;
      totals.calls += 1;
      let vector: number[];
      try {
        vector = await opts.embedder.embedImage(png);
      } catch (err) {
        await fail(image, errorMessage(err), started);
        continue;
      }
      const saved = await opts.store.save({ imageId: image.id, imageSha256: image.sha256, model, embedding: vector });
      if (saved) totals.embedded += 1;
      else totals.skipped += 1;
      report({ imageId: image.id, outcome: saved ? 'embedded' : 'skipped', ms: clock.now() - started });
    }
    // Nothing new on this page (empty, or a store that ignored excludeIds): done.
    if (fresh === 0) break;
  }
  return { ...totals, aborted: aborted(), limited };
}
