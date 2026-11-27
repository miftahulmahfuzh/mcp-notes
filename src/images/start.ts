import type { AppDeps } from '../deps.js';
import { imageDeps, ingestImage } from './ingest.js';
import { startInboxWatcher } from './inbox.js';
import { reconcileLegacyImages } from './legacy.js';
import { ensureDataDirs } from './store.js';

export interface ImagesBackgroundIo {
  reconcile?: (db: AppDeps['db']) => Promise<number>;
  watch?: typeof startInboxWatcher;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Creates images/, cache/, inbox/, inbox/failed/, chat-images/ under the data dir (idempotent; the daemon already made
 * them, but tests start the background without it). Then copies any legacy image (notes.image_path/image_meta without a
 * note_images row) into note_images, once, before the inbox can dedupe against it, and watches the inbox.
 * Returns the inbox's close.
 */
export async function startImagesBackground(deps: AppDeps, io: ImagesBackgroundIo = {}): Promise<{ close: () => Promise<void> }> {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const img = imageDeps(deps);
  const dirs = await ensureDataDirs(img.dataDir);
  try {
    const copied = await (io.reconcile ?? reconcileLegacyImages)(deps.db);
    log(`[notesd] legacy images reconciled into note_images: ${copied}`);
  } catch (err) {
    // Never block the daemon on it: the next start retries (the copy is idempotent).
    error(`[notesd] legacy image reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const inbox = await (io.watch ?? startInboxWatcher)({
    inboxDir: dirs.inbox,
    failedDir: dirs.failed,
    ingest: (absPath) => ingestImage(img, { path: absPath, move: true, origin: { source: 'inbox' } }),
  });
  log(`[notesd] watching ${dirs.inbox}`);
  return { close: () => inbox.close() };
}
