import { asc, eq, max } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { streamTrending, type StreamTrendingRow } from '../../db/schema.js';

/** One title of a build: what the indexes listed. */
export interface TrendingEntry {
  titleId: string;
  kind: 'movie' | 'tv';
  imdbId: string;
  rank: number;
  seeds: number;
  index: string;
  infoHash: string;
  releaseName: string;
  sizeBytes: number | null;
}

/** TrendingRepo's surface; tests use an in-memory store with the same rules. */
export interface TrendingStore {
  /** Replaces this host's rows with `entries`, listed at `at`. */
  replace(host: string, entries: readonly TrendingEntry[], at: Date): Promise<void>;
  rows(host: string): Promise<StreamTrendingRow[]>;
  listedAt(host: string): Promise<Date | null>;
}

/**
 * The only writer of stream_trending (the trending list of the Stream side, src/directStream/trending/job.ts).
 * It writes nothing else: titles are stored through MovieStreams.ensureTitle, and what the owner has seen or does
 * not want is read from movie_titles when the list is read, never copied here.
 */
export class TrendingRepo implements TrendingStore {
  constructor(private readonly db: Db) {}

  async replace(host: string, entries: readonly TrendingEntry[], at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(streamTrending).where(eq(streamTrending.host, host));
      if (entries.length === 0) return;
      await tx.insert(streamTrending).values(
        entries.map((e) => ({
          host,
          titleId: e.titleId,
          kind: e.kind,
          imdbId: e.imdbId,
          rank: e.rank,
          seeds: e.seeds,
          index: e.index,
          infoHash: e.infoHash,
          releaseName: e.releaseName,
          sizeBytes: e.sizeBytes,
          listedAt: at,
        })),
      );
    });
  }

  rows(host: string): Promise<StreamTrendingRow[]> {
    return this.db
      .select()
      .from(streamTrending)
      .where(eq(streamTrending.host, host))
      .orderBy(asc(streamTrending.kind), asc(streamTrending.rank));
  }

  async listedAt(host: string): Promise<Date | null> {
    const [row] = await this.db.select({ at: max(streamTrending.listedAt) }).from(streamTrending).where(eq(streamTrending.host, host));
    return row?.at ?? null;
  }
}
