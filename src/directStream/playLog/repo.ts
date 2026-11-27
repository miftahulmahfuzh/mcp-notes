import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { streamPlayLog, type NewStreamPlayLogRow, type StreamPlayLogRow } from '../../db/schema.js';

/** A new row: everything but the id and `updated_at` (set to the write's time). */
export type PlayLogInsert = Omit<NewStreamPlayLogRow, 'id' | 'updatedAt'>;

/** What a session's later writes change: how it went, and how it ended. */
export type PlayLogPatch = Partial<
  Pick<
    NewStreamPlayLogRow,
    | 'outcome'
    | 'providerLast'
    | 'filmKbps'
    | 'firstFrameMs'
    | 'playedMs'
    | 'stalls'
    | 'stalledMs'
    | 'waits'
    | 'waitedMs'
    | 'errors'
    | 'autoSwitches'
    | 'ownerSwitches'
    | 'refreshes'
    | 'switchNote'
    | 'subtitleSource'
    | 'ended'
    | 'endedAt'
  >
>;

/** What PlayLog writes through (PlayLogRepo; a memory one in tests). */
export interface PlayLogWriter {
  insert(row: PlayLogInsert, now: Date): Promise<number>;
  update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void>;
  closeLeftOpen(host: string, now: Date): Promise<number>;
}

/** The only writer of `stream_play_log`. Every write acts on one host's rows. Phase 3's reads live here too. */
export class PlayLogRepo implements PlayLogWriter {
  constructor(private readonly db: Db) {}

  /** One row; its id. */
  async insert(row: PlayLogInsert, now: Date): Promise<number> {
    const [made] = await this.db.insert(streamPlayLog).values({ ...row, updatedAt: now }).returning({ id: streamPlayLog.id });
    if (made === undefined) throw new Error('the play log row was not inserted');
    return made.id;
  }

  async update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void> {
    await this.db
      .update(streamPlayLog)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(streamPlayLog.host, host), eq(streamPlayLog.id, id)));
  }

  /** Daemon start: the session rows this host left open (sessions live in memory) are closed as `restart`. How many. */
  async closeLeftOpen(host: string, now: Date): Promise<number> {
    const closed = await this.db
      .update(streamPlayLog)
      .set({ ended: 'restart', endedAt: now, updatedAt: now })
      .where(and(eq(streamPlayLog.host, host), isNull(streamPlayLog.ended), isNotNull(streamPlayLog.session)))
      .returning({ id: streamPlayLog.id });
    return closed.length;
  }

  /** This host's row of one stream session, or null. */
  async bySession(host: string, session: string): Promise<StreamPlayLogRow | null> {
    const [row] = await this.db
      .select()
      .from(streamPlayLog)
      .where(and(eq(streamPlayLog.host, host), eq(streamPlayLog.session, session)))
      .limit(1);
    return row ?? null;
  }
}
