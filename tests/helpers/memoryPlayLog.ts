import type { PlayLogInsert, PlayLogPatch, PlayLogWriter, ReattachedRow, ReattachFollow, ReattachTo } from '../../src/directStream/playLog/repo.js';

export type MemoryPlayLogRow = PlayLogInsert & PlayLogPatch & { id: number; updatedAt: Date };

/** PlayLogRepo in memory: the rows, and how many writes reached it (one per insert, update or close). */
export class MemoryPlayLog implements PlayLogWriter {
  readonly rows: MemoryPlayLogRow[] = [];
  writes = 0;
  /** Set: every write throws it (the database is down). */
  failWith: Error | null = null;

  async insert(row: PlayLogInsert, now: Date): Promise<number> {
    this.reach();
    const made: MemoryPlayLogRow = { ...row, id: this.rows.length + 1, updatedAt: now };
    this.rows.push(made);
    return made.id;
  }

  async update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void> {
    this.reach();
    const row = this.rows.find((r) => r.id === id && r.host === host);
    if (row !== undefined) Object.assign(row, patch, { updatedAt: now });
  }

  async closeLeftOpen(host: string, now: Date): Promise<number> {
    this.reach();
    const open = this.rows.filter((r) => r.host === host && r.session != null && (r.ended ?? null) === null);
    for (const r of open) Object.assign(r, { ended: 'restart', endedAt: now, updatedAt: now });
    return open.length;
  }

  async reattach(host: string, to: ReattachTo, session: string, follow: ReattachFollow, now: Date): Promise<ReattachedRow | null> {
    this.reach();
    const row = this.rows
      .filter(
        (r) =>
          r.host === host && r.kind === to.kind && r.tmdbId === to.tmdbId && (r.season ?? null) === to.season && (r.episode ?? null) === to.episode &&
          r.ended === 'restart' && r.session != null && r.endedAt != null && r.endedAt.getTime() >= to.closedSince.getTime() && (to.was === null || r.session === to.was),
      )
      .sort((a, b) => b.askedAt.getTime() - a.askedAt.getTime() || b.id - a.id)[0];
    if (row === undefined) return null;
    Object.assign(row, follow, { session, ended: null, endedAt: null, refreshes: (row.refreshes ?? 0) + 1, updatedAt: now });
    return {
      id: row.id,
      outcome: row.outcome === 'played' ? 'played' : 'no_picture',
      infoHash: row.infoHash ?? null,
      firstFrameMs: row.firstFrameMs ?? null,
      playedMs: row.playedMs ?? 0,
      stalls: row.stalls ?? 0,
      stalledMs: row.stalledMs ?? 0,
      waits: row.waits ?? 0,
      waitedMs: row.waitedMs ?? 0,
      errors: row.errors ?? 0,
      autoSwitches: row.autoSwitches ?? 0,
      ownerSwitches: row.ownerSwitches ?? 0,
      refreshes: row.refreshes ?? 0,
    };
  }

  bySession(session: string): MemoryPlayLogRow | undefined {
    return this.rows.find((r) => r.session === session);
  }

  private reach(): void {
    this.writes += 1;
    if (this.failWith !== null) throw this.failWith;
  }
}
