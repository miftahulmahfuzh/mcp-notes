import type { Db } from './client.js';
import { mergeStagedImport, sharedImportState, startSharedImport, type SharedImportState } from './sharedImport.js';

/** How often a daemon that wants a restart looks whether something still plays. */
export const IMPORT_RESTART_CHECK_MS = 60_000;

/** Where the copy of the old shared database stands once the start has looked at it. */
export interface ImportAtStart {
  /** True until the old shared database has been copied in: the billed session work waits, no orphan folder is swept. */
  pending: boolean;
  /** True when this start should stage the old database behind the daemon (a failed merge is retried, never staged again). */
  stageable: boolean;
}

export interface ImportAtStartIo {
  state?: (db: Db) => Promise<SharedImportState>;
  merge?: (db: Db) => Promise<Record<string, number>>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * The old shared database is copied in once (src/db/sharedImport.ts). A stage that is complete is merged now, before
 * anything else uses the database; until then the copy is pending. No IMPORT_DATABASE_URL: nothing is pending.
 */
export async function mergeSharedImportAtStart(importDatabaseUrl: string | null | undefined, db: Db, io: ImportAtStartIo = {}): Promise<ImportAtStart> {
  if (importDatabaseUrl == null) return { pending: false, stageable: false };
  const state = io.state ?? sharedImportState;
  const merge = io.merge ?? ((d: Db) => mergeStagedImport(d));
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  try {
    let now: SharedImportState = await state(db);
    if (now === 'staged') {
      const rows = await merge(db);
      log(`[notesd] shared import: merged ${Object.entries(rows).map(([t, n]) => `${t} ${n}`).join(', ')}`);
      now = 'done';
    }
    const pending = now !== 'done';
    return { pending, stageable: pending };
  } catch (err) {
    // Left staged: the next start tries the merge again. Nothing is staged twice and nothing restarts for it.
    error(`[notesd] shared import: the merge failed, nothing was changed: ${err instanceof Error ? err.message : String(err)}`);
    return { pending: true, stageable: false };
  }
}

export interface SharedImportRestartOptions {
  importDatabaseUrl: string | null | undefined;
  db: Db;
  /** From mergeSharedImportAtStart: false starts nothing. */
  stageable: boolean;
  /** src/main.ts stops the daemon and exits, and systemd starts it again. Omitted (tests): the stage waits for the next start. */
  onRestartWanted?: () => void;
  /** True while a VLC play, a stream on screen or a stream being started exists: the restart waits. */
  busy: () => boolean;
  checkMs?: number;
  start?: (importUrl: string, db: Db, options: { onStaged: () => void }) => () => void;
  log?: (line: string) => void;
}

/**
 * The old shared database is staged behind the daemon as soon as it can be read. The merge needs a start with nothing
 * running, so once the stage is complete the daemon asks to be restarted, and waits with that while something plays.
 * Returns the stop, which ends the staging and the wait for a quiet moment.
 */
export function startSharedImportRestart(o: SharedImportRestartOptions): () => void {
  let restartTimer: ReturnType<typeof setInterval> | null = null;
  const start = o.start ?? startSharedImport;
  const log = o.log ?? ((line: string) => console.log(line));
  const checkMs = o.checkMs ?? IMPORT_RESTART_CHECK_MS;
  const stopSharedImport =
    o.stageable && o.importDatabaseUrl != null
      ? start(o.importDatabaseUrl, o.db, {
          onStaged: () => {
            if (o.onRestartWanted === undefined) return;
            const ask = (): void => {
              if (o.busy()) return;
              if (restartTimer !== null) clearInterval(restartTimer);
              restartTimer = null;
              log('[notesd] shared import: restarting to merge the staged rows');
              o.onRestartWanted?.();
            };
            restartTimer = setInterval(ask, checkMs);
            restartTimer.unref();
            ask();
          },
        })
      : (): void => {};
  return () => {
    stopSharedImport();
    if (restartTimer !== null) clearInterval(restartTimer);
  };
}
