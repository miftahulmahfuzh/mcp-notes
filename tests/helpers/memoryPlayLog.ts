import type { PlayLogInsert, PlayLogPatch, PlayLogWriter } from '../../src/directStream/playLog/repo.js';

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

  bySession(session: string): MemoryPlayLogRow | undefined {
    return this.rows.find((r) => r.session === session);
  }

  private reach(): void {
    this.writes += 1;
    if (this.failWith !== null) throw this.failWith;
  }
}
