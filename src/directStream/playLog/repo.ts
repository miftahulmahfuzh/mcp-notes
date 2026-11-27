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

/**
 * Which row a play carried on after a restart goes back to: its film or episode, the session id its page held
 * (null: the page did not say, and the newest row of the title is taken) and when this run's start closed the rows
 * the previous run left open (only a row it closed is reopened).
 */
export interface ReattachTo {
  kind: 'movie' | 'tv';
  tmdbId: number;
  season: number | null;
  episode: number | null;
  was: string | null;
  closedSince: Date;
}

/** What the new session says of the play: the provider it is on now, and its switch note and subtitle source. */
export type ReattachFollow = Required<Pick<PlayLogPatch, 'providerLast' | 'switchNote' | 'subtitleSource'>>;

/** The row a carry-on reopened: its id, and what it had counted before the restart (its counters keep summing). */
export interface ReattachedRow {
  id: number;
  outcome: 'no_picture' | 'played';
  infoHash: string | null;
  firstFrameMs: number | null;
  playedMs: number;
  stalls: number;
  stalledMs: number;
  waits: number;
  waitedMs: number;
  errors: number;
  autoSwitches: number;
  ownerSwitches: number;
  /** Already counting the carry-on as one more refresh. */
  refreshes: number;
}

/** What PlayLog writes through (PlayLogRepo; a memory one in tests). */
export interface PlayLogWriter {
  insert(row: PlayLogInsert, now: Date): Promise<number>;
  update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void>;
  closeLeftOpen(host: string, now: Date): Promise<number>;
  reattach(host: string, to: ReattachTo, session: string, follow: ReattachFollow, now: Date): Promise<ReattachedRow | null>;
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

  /**
   * A play carried on after a restart is not a new ask: the newest of this host's rows of the title that this start
   * closed as `restart` (the one of the page's session when it said which) is open again under the new session, with
   * one more refresh and the provider it is on now. The ask's own columns stay. Null: no such row (an older daemon
   * played it, or the row is gone), and nothing was written.
   */
  async reattach(host: string, to: ReattachTo, session: string, follow: ReattachFollow, now: Date): Promise<ReattachedRow | null> {
    const res = await this.db.execute<ReattachDbRow>(sql`
      update stream_play_log
         set session = ${session}, ended = null, ended_at = null, refreshes = refreshes + 1,
             provider_last = ${follow.providerLast}, switch_note = ${follow.switchNote}, subtitle_source = ${follow.subtitleSource},
             updated_at = ${now.toISOString()}::timestamptz
       where ended = 'restart' and host = ${host}
         and id = (
           select id from stream_play_log
            where host = ${host} and kind = ${to.kind} and tmdb_id = ${to.tmdbId}
              and season is not distinct from ${to.season}::int and episode is not distinct from ${to.episode}::int
              and ended = 'restart' and session is not null
              and ended_at >= ${to.closedSince.toISOString()}::timestamptz
              ${to.was === null ? sql`` : sql`and session = ${to.was}`}
            order by asked_at desc, id desc
            limit 1
              for update)
      returning id, outcome, info_hash, first_frame_ms, played_ms, stalls, stalled_ms, waits, waited_ms, errors,
                auto_switches, owner_switches, refreshes`);
    const r = res.rows[0];
    if (r === undefined) return null;
    return {
      id: Number(r.id),
      outcome: r.outcome === 'played' ? 'played' : 'no_picture',
      infoHash: r.info_hash,
      firstFrameMs: r.first_frame_ms,
      playedMs: Number(r.played_ms),
      stalls: Number(r.stalls),
      stalledMs: Number(r.stalled_ms),
      waits: Number(r.waits),
      waitedMs: Number(r.waited_ms),
      errors: Number(r.errors),
      autoSwitches: Number(r.auto_switches),
      ownerSwitches: Number(r.owner_switches),
      refreshes: Number(r.refreshes),
    };
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
   * latest failed ask since that play that asked that channel, or `no_picture` when that channel's latest answer since
   * then was a player that never showed the film (null: not asked there since).
   * A failed ask whose every asked channel ended `error` (an outage, not the title) is left out: it neither lists
   * the title nor counts in its asks.
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
               (array_agg(l.cloud_failure order by l.asked_at desc, l.id desc) filter (where l.cloud_failure is not null and (ok.at is null or l.asked_at > ok.at)))[1] as cloud_failure,
               (array_agg(l.torrent_failure order by l.asked_at desc, l.id desc) filter (where l.torrent_failure is not null and (ok.at is null or l.asked_at > ok.at)))[1] as torrent_failure,
               max(l.asked_at) filter (where l.cloud_failure is not null and (ok.at is null or l.asked_at > ok.at)) as cloud_at,
               max(l.asked_at) filter (where l.torrent_failure is not null and (ok.at is null or l.asked_at > ok.at)) as torrent_at
          from stream_play_log l
          left join ok on ok.kind = l.kind and ok.tmdb_id = l.tmdb_id
                      and ok.season is not distinct from l.season
                      and ok.episode is not distinct from l.episode
         where l.host = ${host} and l.outcome = 'failed'
           -- An ask whose every asked channel only errored (the network was down) says nothing about the title.
           and not (coalesce(l.cloud_failure, 'error') = 'error' and coalesce(l.torrent_failure, 'error') = 'error'
                    and (l.cloud_failure is not null or l.torrent_failure is not null))
         group by l.kind, l.tmdb_id, l.season, l.episode
        having count(*) filter (where ok.at is null or l.asked_at > ok.at) > 0
      ), blank as (
        -- A player that never showed the film since the last play: that channel's latest answer when it is newer than
        -- the channel's latest failed ask (it never lists a title on its own).
        select l.kind, l.tmdb_id, l.season, l.episode, l.channel, max(l.asked_at) as at
          from stream_play_log l
          left join ok on ok.kind = l.kind and ok.tmdb_id = l.tmdb_id
                      and ok.season is not distinct from l.season
                      and ok.episode is not distinct from l.episode
         where l.host = ${host} and l.outcome = 'no_picture' and l.channel in ('cloud', 'torrent')
           and (ok.at is null or l.asked_at > ok.at)
         group by l.kind, l.tmdb_id, l.season, l.episode, l.channel
      )
      select f.kind, f.tmdb_id, f.season, f.episode, f.asks, f.last_asked_at,
             case when bc.at is not null and (f.cloud_at is null or bc.at > f.cloud_at) then 'no_picture' else f.cloud_failure end as cloud_failure,
             case when bt.at is not null and (f.torrent_at is null or bt.at > f.torrent_at) then 'no_picture' else f.torrent_failure end as torrent_failure,
             t.title as title_name, mi.id as movie_id
        from failed f
        left join blank bc on bc.channel = 'cloud' and bc.kind = f.kind and bc.tmdb_id = f.tmdb_id
                          and bc.season is not distinct from f.season and bc.episode is not distinct from f.episode
        left join blank bt on bt.channel = 'torrent' and bt.kind = f.kind and bt.tmdb_id = f.tmdb_id
                          and bt.season is not distinct from f.season and bt.episode is not distinct from f.episode
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
type ReattachDbRow = {
  id: number | string;
  outcome: string;
  info_hash: string | null;
  first_frame_ms: number | null;
  played_ms: number;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  errors: number;
  auto_switches: number;
  owner_switches: number;
  refreshes: number;
};

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
