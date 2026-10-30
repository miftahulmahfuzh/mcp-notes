import type { AppDeps } from './deps.js';
import { dbEmbeddingStore } from './embeddings/backfill.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './embeddings/worker.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { reconcileLegacyImages } from './images/legacy.js';
import { ensureDataDirs } from './images/store.js';

export type StopBackground = () => Promise<void>;

/**
 * Long-running work beside the HTTP server: the inbox watcher (iteration 2) and, when
 * OPENROUTER_API_KEY is set, the embedding worker (iteration 6).
 * Creates images/, cache/, inbox/, inbox/failed/ under the data dir first (idempotent; the
 * daemon already made them, but tests call this without startDaemon). Then copies any legacy
 * image (notes.image_path/image_meta without a note_images row, e.g. ingested by an older daemon
 * after migration 0002 ran) into note_images, once, before the inbox can dedupe against it.
 */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  const img = imageDeps(deps);
  const dirs = await ensureDataDirs(img.dataDir);
  try {
    const copied = await reconcileLegacyImages(deps.db);
    console.log(`[notesd] legacy images reconciled into note_images: ${copied}`);
  } catch (err) {
    // Never block the daemon on it: the next start retries (the copy is idempotent).
    console.error(`[notesd] legacy image reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
