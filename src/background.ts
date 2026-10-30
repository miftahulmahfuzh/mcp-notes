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
