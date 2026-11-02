import { hostname } from 'node:os';
import type { AppDeps } from './deps.js';
import { dbEmbeddingStore } from './embeddings/backfill.js';
import { dbImageEmbeddingStore } from './embeddings/imageBackfill.js';
import { startImageEmbeddingWorker } from './embeddings/imageWorker.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './embeddings/worker.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { reconcileLegacyImages } from './images/legacy.js';
import { ensureDataDirs } from './images/store.js';
import { startSessionIngest, type SessionIngester } from './sessions/ingest.js';
import { SessionsRepo } from './sessions/repo.js';

export type StopBackground = () => Promise<void>;

/**
 * Long-running work beside the HTTP server: the inbox watcher (iteration 2) and, when
 * OPENROUTER_API_KEY is set, the note embedding worker (iteration 6) and the image embedding
 * worker (image similarity search); with `config.sessions.enabled`, the Claude Code session
 * ingester (iteration 8: backfill, then tail `<claudeHome>/projects`).
 * Creates images/, cache/, inbox/, inbox/failed/, chat-images/ under the data dir first (idempotent; the
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

  let imageEmbeddings: EmbeddingWorker | null = null;
  if (!deps.imageEmbedder) {
    console.log('[notesd] image search off: OPENROUTER_API_KEY is not set, similar_images cannot compare pictures');
  } else {
    imageEmbeddings = startImageEmbeddingWorker({
      store: dbImageEmbeddingStore(deps.db, img.dataDir),
      events: deps.events,
      embedder: deps.imageEmbedder,
    });
    console.log(`[notesd] embedding images with ${deps.imageEmbedder.model}`);
  }

  // Session ingest (iteration 8). The backfill runs in the background: startBackground does not
  // wait for it, and a failure is logged, never thrown. Later session work (phase 4 links, phase 6
  // summaries) hangs off `sessionIngest` / `sessionsRepo` / `sessionsHost` here.
  let sessionIngest: SessionIngester | null = null;
  if (!deps.config.sessions.enabled) {
    console.log('[notesd] session ingest off: NOTESD_SESSIONS=off');
  } else {
    const sessionsRepo = new SessionsRepo(deps.db);
    const sessionsHost = hostname();
    sessionIngest = startSessionIngest({
      claudeHome: deps.config.sessions.claudeHome,
      worktreesDir: deps.config.sessions.worktreesDir,
      store: sessionsRepo,
      hostname: () => sessionsHost,
    });
    console.log(`[notesd] ingesting Claude Code sessions from ${deps.config.sessions.claudeHome}/projects as ${sessionsHost}`);
  }

  return async () => {
    await inbox.close();
    // In parallel: each close is bounded by its grace (5 s), well under main.ts's 10 s exit.
    await Promise.all([embeddings?.close(), imageEmbeddings?.close(), sessionIngest?.close()]);
  };
}
