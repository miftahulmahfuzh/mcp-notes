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

/** One episode's row of a torrent (a film is season 0, episode 0): a row itself will do. */
export type TorrentSlot = Pick<StreamTorrentRow, 'infoHash' | 'season' | 'episode'>;

/** The slot a ref takes in a torrent. */
export function slotOf(infoHash: string, ref: StreamRef): TorrentSlot {
  const s = cacheSlot(ref);
  return { infoHash, season: s.season, episode: s.episode };
}

const torrentKey = (host: string, infoHash: string) => and(eq(streamTorrents.host, host), eq(streamTorrents.infoHash, infoHash));
const key = (host: string, slot: TorrentSlot) =>
  and(eq(streamTorrents.host, host), eq(streamTorrents.infoHash, slot.infoHash), eq(streamTorrents.season, slot.season), eq(streamTorrents.episode, slot.episode));

/** The only writer of `stream_torrents`. */
export class TorrentsRepo {
  constructor(private readonly db: Db) {}

  /**
   * This host's row of a torrent's episode (a film: its one row), made now (downloading) when there is none.
   * Another episode of the same torrent gets its own row, so a season pack keeps every episode chosen from it.
   * An existing one takes the new name and trackers; a failed one, or one opened for another title, starts
   * over (downloading); another title also forgets the chosen files.
   */
  async record(host: string, spec: TorrentRecordSpec, now: Date): Promise<StreamTorrentRow> {
    const slot = cacheSlot(spec.ref);
    const [inserted] = await this.db
      .insert(streamTorrents)
      .values({ host, infoHash: spec.infoHash, ...slot, name: spec.name, release: spec.release, trackers: [...spec.trackers], state: 'downloading', createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [streamTorrents.host, streamTorrents.infoHash, streamTorrents.season, streamTorrents.episode] })
      .returning();
    if (inserted !== undefined) return inserted;
    const existing = await this.get(host, spec.infoHash, spec.ref);
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
      .where(key(host, { infoHash: spec.infoHash, season: slot.season, episode: slot.episode }))
      .returning();
    if (row === undefined) throw new Error(`the torrent ${spec.infoHash} on ${host} vanished while it was recorded`);
    return row;
  }

  /** This host's row of a torrent for `ref`'s episode; without a ref, its most recently written row. */
  async get(host: string, infoHash: string, ref?: StreamRef): Promise<StreamTorrentRow | null> {
    const where = ref === undefined ? torrentKey(host, infoHash) : key(host, slotOf(infoHash, ref));
    const [row] = await this.db.select().from(streamTorrents).where(where).orderBy(desc(streamTorrents.updatedAt)).limit(1);
    return row ?? null;
  }

  /** This host's rows of a torrent, one per episode chosen from it, the most recently written first. */
  async slots(host: string, infoHash: string): Promise<StreamTorrentRow[]> {
    return this.db.select().from(streamTorrents).where(torrentKey(host, infoHash)).orderBy(desc(streamTorrents.updatedAt), asc(streamTorrents.season), asc(streamTorrents.episode));
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
    return this.db
      .select()
      .from(streamTorrents)
      .orderBy(desc(streamTorrents.createdAt), asc(streamTorrents.host), asc(streamTorrents.infoHash), asc(streamTorrents.season), asc(streamTorrents.episode));
  }

  async chosen(host: string, slot: TorrentSlot, choice: TorrentChoice, now: Date): Promise<StreamTorrentRow> {
    const [row] = await this.db
      .update(streamTorrents)
      .set({ files: choice.files, fileIndex: choice.fileIndex, fileLength: choice.fileLength, updatedAt: now })
      .where(key(host, slot))
      .returning();
    if (row === undefined) throw new Error(`no torrent ${slot.infoHash} (${slot.season}x${slot.episode}) on ${host}`);
    return row;
  }

  async progress(host: string, slot: TorrentSlot, bytesDone: number, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ bytesDone, updatedAt: now }).where(key(host, slot));
  }

  /** Every chosen file is whole on disk. Needs a chosen video (the CHECK refuses otherwise). */
  async ready(host: string, slot: TorrentSlot, bytesDone: number, now: Date): Promise<StreamTorrentRow> {
    const [row] = await this.db
      .update(streamTorrents)
      .set({ state: 'ready', error: null, completedAt: now, bytesDone, updatedAt: now })
      .where(key(host, slot))
      .returning();
    if (row === undefined) throw new Error(`no torrent ${slot.infoHash} (${slot.season}x${slot.episode}) on ${host}`);
    return row;
  }

  async failed(host: string, slot: TorrentSlot, error: string, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ state: 'failed', error, completedAt: null, updatedAt: now }).where(key(host, slot));
  }

  /** A ready download whose files are gone: downloading again from nothing. A file that lived as its remux is a plain chosen file again. */
  async restarted(host: string, slot: TorrentSlot, now: Date): Promise<void> {
    await this.db
      .update(streamTorrents)
      .set({
        state: 'downloading',
        error: null,
        completedAt: null,
        bytesDone: 0,
        updatedAt: now,
        files: sql`(select coalesce(jsonb_agg(e.f - 'remuxed' order by e.o), '[]'::jsonb) from jsonb_array_elements(${streamTorrents.files}) with ordinality as e(f, o))`,
      })
      .where(key(host, slot));
  }

  /**
   * The episode's video lives as its whole remux only: its original was deleted, so its file entry is marked
   * `remuxed` (nothing fetches or seeds it again). `updated_at` is left alone: no play, no choice changed.
   */
  async remuxed(host: string, slot: TorrentSlot, fileIndex: number): Promise<StreamTorrentRow> {
    const [row] = await this.db
      .update(streamTorrents)
      .set({
        files: sql`(select coalesce(jsonb_agg(case when (e.f->>'index')::int = ${fileIndex} then e.f || '{"remuxed":true}'::jsonb else e.f end order by e.o), '[]'::jsonb) from jsonb_array_elements(${streamTorrents.files}) with ordinality as e(f, o))`,
      })
      .where(key(host, slot))
      .returning();
    if (row === undefined) throw new Error(`no torrent ${slot.infoHash} (${slot.season}x${slot.episode}) on ${host}`);
    return row;
  }

  async played(host: string, slot: TorrentSlot, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ playedAt: now }).where(key(host, slot));
  }

  async duration(host: string, slot: TorrentSlot, seconds: number, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ durationS: seconds, updatedAt: now }).where(key(host, slot));
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

  /** Deletes every row of the torrent on this host (all its episodes). */
  async delete(host: string, infoHash: string): Promise<boolean> {
    const rows = await this.db.delete(streamTorrents).where(torrentKey(host, infoHash)).returning({ infoHash: streamTorrents.infoHash });
    return rows.length > 0;
  }
}

/** What TorrentStreams needs of the repository (tests pass an in-memory one). */
export type TorrentRecords = Pick<
  TorrentsRepo,
  'record' | 'get' | 'slots' | 'byHash' | 'forRef' | 'all' | 'chosen' | 'progress' | 'ready' | 'failed' | 'restarted' | 'remuxed' | 'played' | 'duration' | 'stale' | 'delete'
>;
