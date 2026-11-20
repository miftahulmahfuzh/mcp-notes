import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  streamDownloads,
  type StreamDownloadRow,
  type StreamDownloadSource,
  type StreamDownloadState,
  type StreamDownloadVia,
} from '../../db/schema.js';
import { cacheSlot } from '../repo.js';
import type { StreamRef } from '../types.js';

/** Characters of a failure's detail kept on the row (as stream_caches keeps). */
export const MAX_DOWNLOAD_DETAIL = 500;
/** The error a download ends with when the owner cancelled it. */
export const DOWNLOAD_CANCELLED = 'cancelled';

/** What the owner asked for: one film or one episode, how to fetch it, and the season click it came from. */
export interface DownloadRequest {
  ref: StreamRef;
  via: StreamDownloadVia;
  /** A torrent picked by hand (40 lower-case hex); only with `via: 'torrent'` (the CHECK refuses it otherwise). */
  infoHash?: string | null;
  /** The season click that asked for it (one uuid per click); null for a single film or episode. */
  batch?: string | null;
}

/** What a download fetches from, once chosen: a torrent, or the cloud cache row. */
export type DownloadOn = { source: 'torrent'; infoHash: string } | { source: 'cloud'; cacheId: string };

/** The states of a download that is not finished. `done` and `failed` have their own writers. */
export type DownloadOpenState = Extract<StreamDownloadState, 'queued' | 'running' | 'paused'>;
export const DOWNLOAD_OPEN_STATES: readonly DownloadOpenState[] = ['queued', 'running', 'paused'];

/** Narrows `list`: one title (kind and TMDB id), some states. */
export interface DownloadFilter {
  kind?: 'movie' | 'tv';
  tmdbId?: number;
  states?: readonly StreamDownloadState[];
}

/** The title a row holds. */
export function downloadRef(row: Pick<StreamDownloadRow, 'kind' | 'tmdbId' | 'season' | 'episode'>): StreamRef {
  return row.kind === 'movie' ? { kind: 'movie', tmdbId: row.tmdbId } : { kind: 'tv', tmdbId: row.tmdbId, season: row.season, episode: row.episode };
}

/** What a row fetches from, or null before a source was chosen. */
export function downloadOn(row: Pick<StreamDownloadRow, 'source' | 'sourceId'>): DownloadOn | null {
  if (row.source === null || row.sourceId === null) return null;
  return row.source === 'torrent' ? { source: 'torrent', infoHash: row.sourceId } : { source: 'cloud', cacheId: row.sourceId };
}

/** The two columns a source is kept in. */
export function onColumns(on: DownloadOn): { source: StreamDownloadSource; sourceId: string } {
  return on.source === 'torrent' ? { source: 'torrent', sourceId: on.infoHash } : { source: 'cloud', sourceId: on.cacheId };
}

const own = (host: string, id: string): SQL | undefined => and(eq(streamDownloads.host, host), eq(streamDownloads.id, id));
const open = (): SQL => inArray(streamDownloads.state, [...DOWNLOAD_OPEN_STATES]);
const slotOf = (host: string, ref: StreamRef): SQL | undefined => {
  const s = cacheSlot(ref);
  return and(
    eq(streamDownloads.host, host),
    eq(streamDownloads.kind, s.kind),
    eq(streamDownloads.tmdbId, s.tmdbId),
    eq(streamDownloads.season, s.season),
    eq(streamDownloads.episode, s.episode),
  );
};
const startedNow = (now: Date): SQL => sql`coalesce(${streamDownloads.startedAt}, ${now.toISOString()}::timestamptz)`;

/** The only writer of `stream_downloads`. Every method acts on one host's rows; ids are the table's own (uuid). */
export class DownloadsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Queues one film or episode on this host. A slot already queued, running or paused is answered as it is
   * (`created: false`). A failed one is queued again from nothing with what is asked now (`created: true`), and so is a
   * new one. A finished (`done`) row does not hold its slot: whether the title is still whole on disk is the caller's to know.
   */
  async create(host: string, req: DownloadRequest, now: Date): Promise<{ row: StreamDownloadRow; created: boolean }> {
    const slot = cacheSlot(req.ref);
    const ask = { via: req.via, infoHash: req.infoHash ?? null, batch: req.batch ?? null };
    const [inserted] = await this.db
      .insert(streamDownloads)
      .values({ host, ...slot, ...ask, state: 'queued', createdAt: now, updatedAt: now })
      .onConflictDoNothing({
        target: [streamDownloads.host, streamDownloads.kind, streamDownloads.tmdbId, streamDownloads.season, streamDownloads.episode],
        // Must match the partial unique index stream_downloads_open_slot_idx.
        where: sql`state <> 'done'`,
      })
      .returning();
    if (inserted !== undefined) return { row: inserted, created: true };
    const existing = await this.openFor(host, req.ref);
    if (existing === null) throw new Error(`the download of ${slot.kind} ${slot.tmdbId} on ${host} vanished while it was queued`);
    if (existing.state !== 'failed') return { row: existing, created: false };
    const [requeued] = await this.db
      .update(streamDownloads)
      .set({
        ...ask,
        state: 'queued',
        source: null,
        sourceId: null,
        bytesDone: 0,
        bytesTotal: null,
        error: null,
        errorDetail: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(and(own(host, existing.id), eq(streamDownloads.state, 'failed')))
      .returning();
    if (requeued === undefined) return { row: (await this.get(host, existing.id)) ?? existing, created: false };
    return { row: requeued, created: true };
  }

  /** This host's row of a slot that is not done (queued, running, paused or failed), or null. */
  async openFor(host: string, ref: StreamRef): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .select()
      .from(streamDownloads)
      .where(and(slotOf(host, ref), sql`${streamDownloads.state} <> 'done'`))
      .limit(1);
    return row ?? null;
  }

  /** One row of this host by id, or null (another host's row is null here). `id` must be a uuid: the route checks it. */
  async get(host: string, id: string): Promise<StreamDownloadRow | null> {
    const [row] = await this.db.select().from(streamDownloads).where(own(host, id));
    return row ?? null;
  }

  /**
   * This host's rows in the queue's order, narrowed by `filter`: oldest first, and the rows of one season click
   * (made in the same instant) in episode order, so a season downloads E01, E02, … (phase 3).
   */
  async list(host: string, filter: DownloadFilter = {}): Promise<StreamDownloadRow[]> {
    const where = and(
      eq(streamDownloads.host, host),
      filter.kind === undefined ? undefined : eq(streamDownloads.kind, filter.kind),
      filter.tmdbId === undefined ? undefined : eq(streamDownloads.tmdbId, filter.tmdbId),
      filter.states === undefined ? undefined : inArray(streamDownloads.state, [...filter.states]),
    );
    return this.db
      .select()
      .from(streamDownloads)
      .where(where)
      .orderBy(asc(streamDownloads.createdAt), asc(streamDownloads.season), asc(streamDownloads.episode), asc(streamDownloads.id));
  }

  /** The oldest queued download of this host (in `list`'s order), now running; null when none waits. Two callers never get the same row. */
  async claimNext(host: string, now: Date): Promise<StreamDownloadRow | null> {
    const next = sql`(select d.id from stream_downloads d where d.host = ${host} and d.state = 'queued' order by d.created_at asc, d.season asc, d.episode asc, d.id asc limit 1 for update skip locked)`;
    const [row] = await this.db
      .update(streamDownloads)
      .set({ state: 'running', startedAt: startedNow(now), updatedAt: now })
      .where(eq(streamDownloads.id, next))
      .returning();
    return row ?? null;
  }

  /** Moves a download that is not finished between queued, running and paused. Null when there is none, or it is done or failed. */
  async setState(host: string, id: string, state: DownloadOpenState, now: Date): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ state, updatedAt: now, ...(state === 'running' ? { startedAt: startedNow(now) } : {}) })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** What a download that is not finished fetches from. */
  async on(host: string, id: string, on: DownloadOn, now: Date): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ ...onColumns(on), updatedAt: now })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** The bytes a download that is not finished holds on disk, and of how many. */
  async progress(host: string, id: string, bytesDone: number, bytesTotal: number | null, now: Date): Promise<void> {
    await this.db.update(streamDownloads).set({ bytesDone, bytesTotal, updatedAt: now }).where(and(own(host, id), open()));
  }

  /** A download whose files are whole. Null when there is none, or it was already done or failed. */
  async done(
    host: string,
    id: string,
    on: DownloadOn,
    bytes: { bytesDone: number; bytesTotal: number | null },
    now: Date,
  ): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ ...onColumns(on), ...bytes, state: 'done', error: null, errorDetail: null, completedAt: now, updatedAt: now })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** A download that cannot go on, with a code (`no_source`, `dubbed`, …) and what was seen. Null when it was not open. */
  async failed(host: string, id: string, error: string, detail: string | null, now: Date): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ state: 'failed', error, errorDetail: detail === null ? null : detail.slice(0, MAX_DOWNLOAD_DETAIL), completedAt: null, updatedAt: now })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** The owner cancelled a download that is not finished: failed with `cancelled`. Null when there was none to cancel. */
  async cancel(host: string, id: string, now: Date): Promise<StreamDownloadRow | null> {
    return this.failed(host, id, DOWNLOAD_CANCELLED, null, now);
  }

  /**
   * What a daemon start carries on: every download of this host that was queued, running or paused when the last
   * daemon stopped, queued again and answered oldest first. Each keeps its source and bytes, so the engine carries on
   * from what is on disk. Another host's rows, and finished and failed ones, are left alone.
   */
  async toResume(host: string, now: Date): Promise<StreamDownloadRow[]> {
    await this.db
      .update(streamDownloads)
      .set({ state: 'queued', updatedAt: now })
      .where(and(eq(streamDownloads.host, host), inArray(streamDownloads.state, ['running', 'paused'])));
    return this.list(host, { states: ['queued'] });
  }

  /** Deletes one row of this host. */
  async delete(host: string, id: string): Promise<boolean> {
    const rows = await this.db.delete(streamDownloads).where(own(host, id)).returning({ id: streamDownloads.id });
    return rows.length > 0;
  }

  /** Deletes every row of this host for a slot whose files were deleted (the Cache page), finished ones too. Answers how many. */
  async deleteSlot(host: string, ref: StreamRef): Promise<number> {
    const rows = await this.db.delete(streamDownloads).where(slotOf(host, ref)).returning({ id: streamDownloads.id });
    return rows.length;
  }
}

/** What the download engine needs of the repository (tests pass an in-memory one: tests/helpers/memoryDownloadRecords.ts). */
export type DownloadRecords = Pick<
  DownloadsRepo,
  'create' | 'openFor' | 'get' | 'list' | 'claimNext' | 'setState' | 'on' | 'progress' | 'done' | 'failed' | 'cancel' | 'toResume' | 'delete' | 'deleteSlot'
>;
