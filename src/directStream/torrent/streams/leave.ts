import { PROGRESS_STEP_BYTES } from '../types.js';
import type { StreamsCore } from './core.js';
import type { OriginalsKeeper } from './originals.js';
import type { Pruner } from './prune.js';
import type { Active } from './types.js';
import { episodeOf, messageOf, slotKey, sumRanges } from './util.js';

/**
 * How a torrent in the swarm moves on: its progress and finished episodes recorded (settle), and the swarm left once
 * nothing uses it (leave): at once when it is whole or does not play, else after `lingerMs` with no request. A
 * torrent is in the swarm only while something uses it.
 */

/** Records progress and a finished download, then lets the torrent go when nothing uses it. */
export async function settle(core: StreamsCore, pruner: Pruner, originals: OriginalsKeeper, hash: string, live: Active): Promise<void> {
  // Each episode chosen from the torrent is finished on its own: E01 is ready while E02 still downloads.
  let chosen = 0;
  let finished = 0;
  let readyNow = false;
  for (const row of [...live.rows.values()]) {
    if (row.fileIndex === null) continue;
    chosen += 1;
    // A ready episode of the pack is whole on disk already (another play finished it); it is not downloaded again.
    const done = row.state === 'ready' || row.files.every((f) => live.handle.done(f.index));
    if (done) finished += 1;
    if (done && row.state !== 'ready') {
      live.rows.set(slotKey(row), await core.repo.ready(core.host, row, row.fileLength ?? 0, core.now()));
      readyNow = true;
      core.log(`[notesd] torrent: ${row.name}${episodeOf(row)} is on disk (${Math.round((row.fileLength ?? 0) / 1_048_576)} MB)`);
    } else if (!done) {
      const bytes = sumRanges(live.handle.ranges(row.fileIndex));
      if (Math.abs(bytes - row.bytesDone) >= PROGRESS_STEP_BYTES) {
        await core.repo.progress(core.host, row, bytes, core.now());
        live.rows.set(slotKey(row), { ...row, bytesDone: bytes });
      }
    }
  }
  // A finished download may take the folder over the budget.
  if (readyNow && core.opts.budgetBytes !== undefined) void pruner.prune();
  const complete = chosen > 0 && finished === chosen;
  if (live.users > 0) return;
  if (complete) await leave(core, originals, hash, live, 'it is finished and nothing plays it');
  else if (core.nowMs() - live.lastRequestAt >= core.lingerMs) {
    await leave(core, originals, hash, live, `nothing asked for it for ${Math.round(core.lingerMs / 60_000)} min`);
  }
}

/**
 * Leaves the swarm. `forget`: the torrent does not play (it lost the race, its open gave up, its file was refused);
 * when this open made its row and nothing of it was ever played or finished, the row and the folder go too.
 */
export async function leave(core: StreamsCore, originals: OriginalsKeeper, hash: string, live: Active, why: string, options: { forget?: boolean } = {}): Promise<void> {
  if (core.active.get(hash) !== live) return;
  core.active.delete(hash);
  const rows = [...live.rows.values()];
  const name = live.handle.name;
  if (options.forget === true && live.fresh && rows.every((r) => r.playedAt === null && r.state !== 'ready')) {
    try {
      await core.engine.remove(hash, { deleteFiles: true });
      await core.folder.remove(hash);
      await core.repo.delete(core.host, hash);
    } catch (err) {
      core.log(`[notesd] torrent: could not clear ${name} after leaving its swarm: ${messageOf(err)}`);
    }
    core.log(`[notesd] torrent: left the swarm of ${name} (${hash.slice(0, 8)}) and deleted what it fetched: ${why}`);
    return;
  }
  try {
    await core.engine.remove(hash, { deleteFiles: false });
  } catch (err) {
    core.log(`[notesd] torrent: could not leave the swarm of ${name}: ${messageOf(err)}`);
  }
  try {
    // A file is unchosen only when no episode's row of this torrent chose it (a season pack keeps every episode).
    // A file that lives as its remux is not kept either: what is at its path is an edge piece's bytes.
    const stored = await core.repo.slots(core.host, hash);
    const chosen = new Set([...rows, ...stored].flatMap((r) => r.files.filter((f) => f.remuxed !== true).map((f) => f.index)));
    await core.folder.dropFiles(hash, live.handle.files.filter((f) => !chosen.has(f.index)).map((f) => f.path));
  } catch (err) {
    core.log(`[notesd] torrent: could not delete the edges of unchosen files of ${name}: ${messageOf(err)}`);
  }
  core.log(`[notesd] torrent: left the swarm of ${name} (${hash.slice(0, 8)}): ${why}`);
  // Out of the swarm, nothing reads the originals through it: one beside a whole remux can go now.
  await originals.dropOriginals(hash);
}
