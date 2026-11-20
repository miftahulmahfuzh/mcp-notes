import { readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { SYNC_DIR } from './torrent/subtitles/synced.js';

/**
 * The daemon's own audio leftovers, swept once at start: the WAV of a stretch a sync, a Whisper tier or the subtitle
 * checker was cutting when notesd stopped (often 0 bytes), and the empty `notesd-sync` folders it left. Nothing runs
 * yet at start, so every WAV in these folders is a leftover. Nothing else is touched: a Whisper progress file, a cue
 * feed and a kept subtitle stay.
 */

/** The folders, below a root's entries, that only ever hold a stretch in progress. */
const WORK_DIRS = [SYNC_DIR, 'notesd-whisper'];

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Deletes the WAVs in `dir`; answers how many. */
async function wavsIn(dir: string): Promise<number> {
  let n = 0;
  for (const name of await entries(dir)) {
    if (!name.toLowerCase().endsWith('.wav')) continue;
    await rm(path.join(dir, name), { force: true }).then(() => (n += 1), () => undefined);
  }
  return n;
}

/**
 * `perItem`: folders whose every entry (`<torrent dir>/<info hash>`, `stream-subs/<title>`) may hold a work folder.
 * `flat`: folders that hold WAVs directly (the subtitle checker's). Never throws.
 */
export async function sweepAudioLeftovers(roots: { perItem: readonly string[]; flat: readonly string[] }, log: (line: string) => void): Promise<number> {
  let wavs = 0;
  let dirs = 0;
  for (const root of roots.perItem) {
    for (const item of await entries(root)) {
      for (const work of WORK_DIRS) {
        const dir = path.join(root, item, work);
        wavs += await wavsIn(dir);
        if (work === SYNC_DIR && (await entries(dir)).length === 0) await rmdir(dir).then(() => (dirs += 1), () => undefined);
      }
    }
  }
  for (const dir of roots.flat) wavs += await wavsIn(dir);
  if (wavs + dirs > 0) log(`[notesd] swept ${wavs} leftover WAV file(s) and ${dirs} empty ${SYNC_DIR} folder(s)`);
  return wavs + dirs;
}
