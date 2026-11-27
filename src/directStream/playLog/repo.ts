import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { HealthRow, PlayOutcome, UnhandledEntry } from './health.js';
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

  // ---- Reads for the health view (stream-play-log phase 3). Every write above is phase 1's. ----

  /** This host's rows asked at or after `since`, newest first, each with its title's name and movie id. */
  async healthRows(host: string, since: Date): Promise<HealthRow[]> {
    const res = await this.db.execute<HealthDbRow>(sql`
      select l.id, l.asked_at, l.kind, l.tmdb_id, l.season, l.episode, l.asked, l.outcome, l.failure,
             l.cloud_failure, l.torrent_failure, l.resolve_ms, l.channel, l.provider_first, l.torrent_index,
             l.height, l.first_frame_ms, l.played_ms, l.stalls, l.stalled_ms, l.waits, l.waited_ms, l.ended,
             t.title as title_name, mi.id as movie_id
        from stream_play_log l
        left join movie_titles t on t.id = l.kind || '-' || l.tmdb_id::text
        left join movie_ids mi on mi.title_id = t.id
                              and mi.season is not distinct from l.season
                              and mi.episode is not distinct from l.episode
       where l.host = ${host} and l.asked_at >= ${since.toISOString()}::timestamptz
       order by l.asked_at desc, l.id desc`);
    return res.rows.map(toHealthRow);
  }

  /** When this host's first row was asked; null before any. */
  async firstAskedAt(host: string): Promise<Date | null> {
    const res = await this.db.execute<{ at: Date | string | null }>(sql`select min(asked_at) as at from stream_play_log where host = ${host}`);
    const at = res.rows[0]?.at ?? null;
    return at === null ? null : new Date(at);
  }

  /**
   * Every film and episode on this host, over all time, whose failed asks came after its last play that reached the
   * screen (outcome played or site), newest failure first. `cloud_failure` / `torrent_failure` are the words of its
   * latest failed ask that asked that channel.
   */
  async unhandled(host: string, limit: number): Promise<UnhandledEntry[]> {
    const res = await this.db.execute<UnhandledDbRow>(sql`
      with ok as (
        select kind, tmdb_id, season, episode, max(asked_at) as at
          from stream_play_log
         where host = ${host} and outcome in ('played', 'site')
         group by kind, tmdb_id, season, episode
      ), failed as (
        select l.kind, l.tmdb_id, l.season, l.episode,
               (count(*) filter (where ok.at is null or l.asked_at > ok.at))::int as asks,
               max(l.asked_at) as last_asked_at,
               (array_agg(l.cloud_failure order by l.asked_at desc, l.id desc) filter (where l.cloud_failure is not null))[1] as cloud_failure,
               (array_agg(l.torrent_failure order by l.asked_at desc, l.id desc) filter (where l.torrent_failure is not null))[1] as torrent_failure
          from stream_play_log l
          left join ok on ok.kind = l.kind and ok.tmdb_id = l.tmdb_id
                      and ok.season is not distinct from l.season
                      and ok.episode is not distinct from l.episode
         where l.host = ${host} and l.outcome = 'failed'
         group by l.kind, l.tmdb_id, l.season, l.episode
        having count(*) filter (where ok.at is null or l.asked_at > ok.at) > 0
      )
      select f.kind, f.tmdb_id, f.season, f.episode, f.asks, f.last_asked_at, f.cloud_failure, f.torrent_failure,
             t.title as title_name, mi.id as movie_id
        from failed f
        left join movie_titles t on t.id = f.kind || '-' || f.tmdb_id::text
        left join movie_ids mi on mi.title_id = t.id
                              and mi.season is not distinct from f.season
                              and mi.episode is not distinct from f.episode
       order by f.last_asked_at desc
       limit ${limit}`);
    return res.rows.map(toUnhandled);
  }
}

/** Type aliases, not interfaces: db.execute<T> needs T assignable to Record<string, unknown>. */
type HealthDbRow = {
  id: number | string;
  asked_at: Date | string;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  asked: string | null;
  outcome: PlayOutcome;
  failure: string | null;
  cloud_failure: string | null;
  torrent_failure: string | null;
  resolve_ms: number | null;
  channel: string | null;
  provider_first: string | null;
  torrent_index: string | null;
  height: number | null;
  first_frame_ms: number | null;
  played_ms: number;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  ended: string | null;
  title_name: string | null;
  movie_id: string | null;
};

type UnhandledDbRow = {
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  asks: number;
  last_asked_at: Date | string;
  cloud_failure: string | null;
  torrent_failure: string | null;
  title_name: string | null;
  movie_id: string | null;
};

function iso(v: Date | string): string {
  return new Date(v).toISOString();
}

function toHealthRow(r: HealthDbRow): HealthRow {
  return {
    id: Number(r.id),
    asked_at: new Date(r.asked_at),
    kind: r.kind,
    tmdb_id: Number(r.tmdb_id),
    season: r.season,
    episode: r.episode,
    asked: r.asked,
    outcome: r.outcome,
    failure: r.failure,
    cloud_failure: r.cloud_failure,
    torrent_failure: r.torrent_failure,
    resolve_ms: r.resolve_ms,
    channel: r.channel,
    provider_first: r.provider_first,
    torrent_index: r.torrent_index,
    height: r.height,
    first_frame_ms: r.first_frame_ms,
    played_ms: Number(r.played_ms),
    stalls: Number(r.stalls),
    stalled_ms: Number(r.stalled_ms),
    waits: Number(r.waits),
    waited_ms: Number(r.waited_ms),
    ended: r.ended,
    title: r.title_name ?? `${r.kind}-${r.tmdb_id}`,
    movie_id: r.movie_id,
  };
}

function toUnhandled(r: UnhandledDbRow): UnhandledEntry {
  return {
    title: r.title_name ?? `${r.kind}-${r.tmdb_id}`,
    movie_id: r.movie_id,
    kind: r.kind,
    tmdb_id: Number(r.tmdb_id),
    season: r.season,
    episode: r.episode,
    asks: Number(r.asks),
    last_asked_at: iso(r.last_asked_at),
    cloud_failure: r.cloud_failure,
    torrent_failure: r.torrent_failure,
  };
}
