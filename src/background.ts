import type { AppDeps } from './deps.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { ensureDataDirs } from './images/store.js';

export type StopBackground = () => Promise<void>;

/**
 * Long-running work beside the HTTP server. Iteration 2: the inbox watcher.
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
  return async () => {
    await inbox.close();
  };
}
