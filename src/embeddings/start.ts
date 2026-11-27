import type { AppDeps } from '../deps.js';
import { dbEmbeddingStore } from './backfill.js';
import { dbImageEmbeddingStore } from './imageBackfill.js';
import { startImageEmbeddingWorker } from './imageWorker.js';
import { imageDeps } from '../images/ingest.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './worker.js';

export interface EmbeddingWorkersIo {
  notes?: typeof startEmbeddingWorker;
  images?: typeof startImageEmbeddingWorker;
  log?: (line: string) => void;
}

/**
 * The note embedding worker and the image embedding worker, each only with its embedder (OPENROUTER_API_KEY); without
 * one, search stays full text or similar_images cannot compare pictures, said once in the log. Returns their closes.
 */
export function startEmbeddingWorkers(deps: AppDeps, io: EmbeddingWorkersIo = {}): { closers: () => (Promise<void> | undefined)[] } {
  const log = io.log ?? ((line: string) => console.log(line));
  let embeddings: EmbeddingWorker | null = null;
  if (!deps.embedder) {
    log('[notesd] embeddings off: OPENROUTER_API_KEY is not set, search stays full text');
  } else {
    embeddings = (io.notes ?? startEmbeddingWorker)({ store: dbEmbeddingStore(deps.db), events: deps.events, embedder: deps.embedder });
    log(`[notesd] embedding notes with ${deps.embedder.model}`);
  }
  let imageEmbeddings: EmbeddingWorker | null = null;
  if (!deps.imageEmbedder) {
    log('[notesd] image search off: OPENROUTER_API_KEY is not set, similar_images cannot compare pictures');
  } else {
    imageEmbeddings = (io.images ?? startImageEmbeddingWorker)({
      store: dbImageEmbeddingStore(deps.db, imageDeps(deps).dataDir),
      events: deps.events,
      embedder: deps.imageEmbedder,
    });
    log(`[notesd] embedding images with ${deps.imageEmbedder.model}`);
  }
  return { closers: () => [embeddings?.close(), imageEmbeddings?.close()] };
}
