import type { StreamTorrentRow } from '../../../db/schema.js';
import { TORRENT_PRUNE_EVERY_MS } from '../types.js';
import type { StreamsCore } from './core.js';
import type { OriginalsKeeper } from './originals.js';
import { gb, keptHashes, messageOf } from './util.js';

/** A ready download played (or finished) within this long goes last in the budget's order. */
export const TORRENT_RECENT_MS = 86_400_000;

/** Per torrent: its last play (null: never played), its last play or finish or make (`touched`), and a name. */
export interface Activity {
  played: number | null;
  touched: number;
  name: string;
}

/**
 * Per torrent, over all its episodes: the last play (null: never played), the last play or finish or make
 * (`touched`), and a name. Pure.
 */
export function lastActivity(rows: readonly StreamTorrentRow[]): Map<string, Activity> {
  const out = new Map<string, Activity>();
  for (const r of rows) {
    const played = r.playedAt?.getTime() ?? null;
    const touched = Math.max(played ?? 0, (r.completedAt ?? r.createdAt).getTime());
    const was = out.get(r.infoHash);
    out.set(r.infoHash, {
      played: was === undefined ? played : played === null ? was.played : Math.max(played, was.played ?? 0),
      touched: Math.max(touched, was?.touched ?? 0),
      name: was?.name ?? r.name,
    });
  }
  return out;
}

/** One torrent the budget may delete, with what orders it. */
export type BudgetCandidate = { hash: string; recent: boolean; dismissed: boolean } & Activity;

/**
 * The order the budget deletes torrents in. Pure. First the downloads of titles the owner marked watched or not
 * interested (`dismissed`), then the never played ones, oldest first, then the played ones, least recently played
 * first; a download played or finished within TORRENT_RECENT_MS (`recent`) goes only when that was not enough
 * (within each group).
 */
export function budgetOrder(candidates: readonly BudgetCandidate[]): BudgetCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      Number(b.dismissed) - Number(a.dismissed) ||
      Number(a.recent) - Number(b.recent) ||
      Number(a.played !== null) - Number(b.played !== null) ||
      (a.played ?? a.touched) - (b.played ?? b.touched),
  );
}

/**
 * The prune of this host's downloads: by age (`keepDays`), folders no row names, originals beside their remux, and
 * the budget. One at a time; the tick runs it every TORRENT_PRUNE_EVERY_MS (`due`).
 */
export class Pruner {
  private lastPrune = 0;
  private pruning: Promise<number> | null = null;

  constructor(
    private readonly core: StreamsCore,
    private readonly originals: OriginalsKeeper,
  ) {}

  /** True when the last prune began TORRENT_PRUNE_EVERY_MS ago or more. */
  due(): boolean {
    return this.core.nowMs() - this.lastPrune >= TORRENT_PRUNE_EVERY_MS;
  }

  /** TorrentStreams.prune: one run at a time; a call while one runs answers that run. Never throws. */
  async prune(): Promise<number> {
    this.pruning ??= this.pruneNow().finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  private async pruneNow(): Promise<number> {
    const { core } = this;
    this.lastPrune = core.nowMs();
    let cleared = 0;
    const held = (hash: string): boolean => core.held(hash);
    try {
      // A torrent goes when none of its episodes was played (else finished, else made) within keepDays; never one the owner keeps.
      const before = core.nowMs() - core.opts.keepDays * 86_400_000;
      const rows = await core.hostRows();
      const kept = keptHashes(rows);
      for (const [hash, { touched, name }] of lastActivity(rows)) {
        if (touched >= before || held(hash) || kept.has(hash)) continue;
        await core.folder.remove(hash);
        await core.repo.delete(core.host, hash);
        cleared += 1;
        core.log(`[notesd] torrent: cleared ${name}, not played for ${core.opts.keepDays} days`);
      }
    } catch (err) {
      core.log(`[notesd] torrent: could not clear old downloads: ${messageOf(err)}`);
    }
    try {
      const named = new Set((await core.hostRows()).map((r) => r.infoHash));
      // Skipped while the shared import is pending; the budget below still runs (it deletes only torrents with a row here).
      for (const hash of core.opts.sweepOrphans === false ? [] : await core.folder.hashes()) {
        if (named.has(hash) || held(hash)) continue;
        await core.folder.remove(hash);
        cleared += 1;
        core.log(`[notesd] torrent: cleared the folder ${hash.slice(0, 8)}, which no download names`);
      }
    } catch (err) {
      core.log(`[notesd] torrent: could not clear folders no download names: ${messageOf(err)}`);
    }
    // An original kept back before (its cue feed was not complete yet) may go now, before whole torrents are weighed.
    if ((core.opts.remuxes ?? null) !== null) {
      try {
        for (const hash of new Set((await core.hostRows()).map((r) => r.infoHash))) await this.originals.dropOriginals(hash);
      } catch (err) {
        core.log(`[notesd] torrent: could not look for originals beside their remux: ${messageOf(err)}`);
      }
    }
    try {
      cleared += await this.keepBudget(held);
    } catch (err) {
      core.log(`[notesd] torrent: could not keep the downloads under the budget: ${messageOf(err)}`);
    }
    return cleared;
  }

  /**
   * Deletes whole torrents (folder with its remux and cue files, and every row) until the torrent folder takes less
   * than `budgetBytes`, in budgetOrder. Never one in use, and never one the owner keeps as a download (its bytes still
   * count).
   */
  private async keepBudget(held: (hash: string) => boolean): Promise<number> {
    const { core } = this;
    const budget = core.opts.budgetBytes;
    if (budget === undefined) return 0;
    const sizes = new Map<string, number>();
    for (const hash of await core.folder.hashes()) sizes.set(hash, await core.folder.size(hash));
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (total <= budget) return 0;
    const recentFrom = core.nowMs() - TORRENT_RECENT_MS;
    const rows = await core.hostRows();
    const kept = keptHashes(rows);
    // The titles the owner marked watched or not interested go first, whatever their age.
    const titleOf = (r: Pick<StreamTorrentRow, 'kind' | 'tmdbId'>): string => `${r.kind}-${r.tmdbId}`;
    let marked: ReadonlySet<string> = new Set();
    try {
      marked = (await core.opts.marked?.([...new Set(rows.map(titleOf))])) ?? new Set();
    } catch (err) {
      core.log(`[notesd] torrent: could not read which titles are watched or not interested: ${messageOf(err)}`);
    }
    const dismissed = new Set(rows.filter((r) => marked.has(titleOf(r))).map((r) => r.infoHash));
    const order = budgetOrder(
      [...lastActivity(rows)]
        .filter(([hash]) => !held(hash) && !kept.has(hash) && (sizes.get(hash) ?? 0) > 0)
        .map(([hash, last]) => ({ hash, ...last, recent: last.touched >= recentFrom, dismissed: dismissed.has(hash) })),
    );
    let cleared = 0;
    for (const t of order) {
      if (total <= budget) break;
      const size = sizes.get(t.hash) ?? 0;
      await core.folder.remove(t.hash);
      await core.repo.delete(core.host, t.hash);
      total -= size;
      cleared += 1;
      const why = `${t.dismissed ? 'watched or not interested, ' : ''}${t.played !== null ? `last played ${new Date(t.played).toISOString().slice(0, 10)}` : 'never played'}`;
      core.log(`[notesd] torrent: cleared ${t.name} (${gb(size)}, ${why}): the downloads took more than the ${gb(budget)} budget, ${gb(total)} now`);
    }
    if (total > budget) {
      const keptOnDisk = [...kept].filter((hash) => (sizes.get(hash) ?? 0) > 0);
      const keptBytes = keptOnDisk.reduce((n, hash) => n + (sizes.get(hash) ?? 0), 0);
      core.log(
        keptOnDisk.length === 0
          ? `[notesd] torrent: the downloads take ${gb(total)}, over the ${gb(budget)} budget, and what is left is in use`
          : `[notesd] torrent: the downloads take ${gb(total)}, over the ${gb(budget)} budget, and what is left is in use or kept by the owner (${keptOnDisk.length} kept download${keptOnDisk.length === 1 ? '' : 's'}, ${gb(keptBytes)})`,
      );
    }
    return cleared;
  }
}
