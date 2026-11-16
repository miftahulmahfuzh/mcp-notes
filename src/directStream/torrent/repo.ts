import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { streamTorrents, type StreamTorrentFile, type StreamTorrentRow } from '../../db/schema.js';
import { cacheSlot } from '../repo.js';
import type { StreamRef } from '../types.js';

/** What `record` writes for an open torrent. */
export interface TorrentRecordSpec {
  infoHash: string;
  ref: StreamRef;
  /** The torrent's own name. */
  name: string;
  /** The release name the index listed. */
  release: string | null;
  trackers: readonly string[];
}

/** The chosen files: the video (`fileIndex`) and its subtitles. */
export interface TorrentChoice {
  files: StreamTorrentFile[];
  fileIndex: number | null;
  fileLength: number | null;
}

/** The title a row holds. */
export function torrentRef(row: Pick<StreamTorrentRow, 'kind' | 'tmdbId' | 'season' | 'episode'>): StreamRef {
  return row.kind === 'movie' ? { kind: 'movie', tmdbId: row.tmdbId } : { kind: 'tv', tmdbId: row.tmdbId, season: row.season, episode: row.episode };
}

const key = (host: string, infoHash: string) => and(eq(streamTorrents.host, host), eq(streamTorrents.infoHash, infoHash));

/** The only writer of `stream_torrents`. */
export class TorrentsRepo {
  constructor(private readonly db: Db) {}

  /**
   * This host's row of a torrent, made now (downloading) when there is none. An existing one takes the
   * new title slot, name and trackers; a failed one, or one opened for another slot, starts over
   * (downloading); another slot also forgets the chosen files.
   */
  async record(host: string, spec: TorrentRecordSpec, now: Date): Promise<StreamTorrentRow> {
    const slot = cacheSlot(spec.ref);
    const [inserted] = await this.db
      .insert(streamTorrents)
      .values({ host, infoHash: spec.infoHash, ...slot, name: spec.name, release: spec.release, trackers: [...spec.trackers], state: 'downloading', createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [streamTorrents.host, streamTorrents.infoHash] })
      .returning();
    if (inserted !== undefined) return inserted;
    const existing = await this.get(host, spec.infoHash);
    if (existing === null) throw new Error(`the torrent ${spec.infoHash} on ${host} vanished while it was recorded`);
    const sameSlot = existing.kind === slot.kind && existing.tmdbId === slot.tmdbId && existing.season === slot.season && existing.episode === slot.episode;
    const restart = !sameSlot || existing.state === 'failed';
    const [row] = await this.db
      .update(streamTorrents)
      .set({
        ...slot,
        name: spec.name,
        release: spec.release ?? existing.release,
        trackers: spec.trackers.length > 0 ? [...spec.trackers] : existing.trackers,
        updatedAt: now,
        ...(restart ? { state: 'downloading' as const, error: null, completedAt: null } : {}),
        ...(sameSlot ? {} : { fileIndex: null, files: [], fileLength: null, bytesDone: 0, durationS: null }),
      })
      .where(key(host, spec.infoHash))
      .returning();
    if (row === undefined) throw new Error(`the torrent ${spec.infoHash} on ${host} vanished while it was recorded`);
    return row;
  }

  async get(host: string, infoHash: string): Promise<StreamTorrentRow | null> {
    const [row] = await this.db.select().from(streamTorrents).where(key(host, infoHash));
    return row ?? null;
  }

  /** Every host's row of a torrent. */
  async byHash(infoHash: string): Promise<StreamTorrentRow[]> {
    return this.db.select().from(streamTorrents).where(eq(streamTorrents.infoHash, infoHash)).orderBy(asc(streamTorrents.host));
  }

  /** One host's rows of a title slot: ready ones first, then the most recently written. */
  async forRef(host: string, ref: StreamRef): Promise<StreamTorrentRow[]> {
    const s = cacheSlot(ref);
    return this.db
      .select()
      .from(streamTorrents)
      .where(
        and(
          eq(streamTorrents.host, host),
          eq(streamTorrents.kind, s.kind),
          eq(streamTorrents.tmdbId, s.tmdbId),
          eq(streamTorrents.season, s.season),
          eq(streamTorrents.episode, s.episode),
        ),
      )
      .orderBy(sql`(${streamTorrents.state} = 'ready') desc`, desc(streamTorrents.updatedAt));
  }

  /** Every row of both hosts, newest first. */
  async all(): Promise<StreamTorrentRow[]> {
    return this.db.select().from(streamTorrents).orderBy(desc(streamTorrents.createdAt), asc(streamTorrents.host), asc(streamTorrents.infoHash));
  }

  async chosen(host: string, infoHash: string, choice: TorrentChoice, now: Date): Promise<StreamTorrentRow> {
    const [row] = await this.db
      .update(streamTorrents)
      .set({ files: choice.files, fileIndex: choice.fileIndex, fileLength: choice.fileLength, updatedAt: now })
      .where(key(host, infoHash))
      .returning();
    if (row === undefined) throw new Error(`no torrent ${infoHash} on ${host}`);
    return row;
  }

  async progress(host: string, infoHash: string, bytesDone: number, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ bytesDone, updatedAt: now }).where(key(host, infoHash));
  }

  /** Every chosen file is whole on disk. Needs a chosen video (the CHECK refuses otherwise). */
  async ready(host: string, infoHash: string, bytesDone: number, now: Date): Promise<StreamTorrentRow> {
    const [row] = await this.db
      .update(streamTorrents)
      .set({ state: 'ready', error: null, completedAt: now, bytesDone, updatedAt: now })
      .where(key(host, infoHash))
      .returning();
    if (row === undefined) throw new Error(`no torrent ${infoHash} on ${host}`);
    return row;
  }

  async failed(host: string, infoHash: string, error: string, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ state: 'failed', error, completedAt: null, updatedAt: now }).where(key(host, infoHash));
  }

  /** A ready download whose files are gone: downloading again from nothing. */
  async restarted(host: string, infoHash: string, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ state: 'downloading', error: null, completedAt: null, bytesDone: 0, updatedAt: now }).where(key(host, infoHash));
  }

  async played(host: string, infoHash: string, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ playedAt: now }).where(key(host, infoHash));
  }

  async duration(host: string, infoHash: string, seconds: number, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ durationS: seconds, updatedAt: now }).where(key(host, infoHash));
  }

  /** One host's rows last played (else finished, else made) before `before`. */
  async stale(host: string, before: Date): Promise<StreamTorrentRow[]> {
    return this.db
      .select()
      .from(streamTorrents)
      .where(
        and(
          eq(streamTorrents.host, host),
          sql`coalesce(${streamTorrents.playedAt}, ${streamTorrents.completedAt}, ${streamTorrents.createdAt}) < ${before.toISOString()}::timestamptz`,
        ),
      );
  }

  async delete(host: string, infoHash: string): Promise<boolean> {
    const rows = await this.db.delete(streamTorrents).where(key(host, infoHash)).returning({ infoHash: streamTorrents.infoHash });
    return rows.length > 0;
  }
}

/** What TorrentStreams needs of the repository (tests pass an in-memory one). */
export type TorrentRecords = Pick<
  TorrentsRepo,
  'record' | 'get' | 'byHash' | 'forRef' | 'all' | 'chosen' | 'progress' | 'ready' | 'failed' | 'restarted' | 'played' | 'duration' | 'stale' | 'delete'
>;
