import { and, asc, eq, max } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { streamTrending, type StreamTrendingRow, type TrendingProbeOutcome } from '../../db/schema.js';

const MAX_DETAIL = 300;

/** One title of a build: what the indexes listed, and a probe carried over from the last build when it is still the same torrent. */
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
  probe: { outcome: TrendingProbeOutcome; detail: string | null; at: Date } | null;
}

/** TrendingRepo's surface; tests use an in-memory store with the same rules. */
export interface TrendingStore {
  /** Replaces this host's rows with `entries`, listed at `at`. */
  replace(host: string, entries: readonly TrendingEntry[], at: Date): Promise<void>;
  rows(host: string): Promise<StreamTrendingRow[]>;
  listedAt(host: string): Promise<Date | null>;
  /** Writes the probe of one title's listed torrent; a row that changed hash since is left alone. */
  recordProbe(host: string, titleId: string, infoHash: string, outcome: TrendingProbeOutcome, detail: string | null, at: Date): Promise<void>;
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
          probeOutcome: e.probe?.outcome ?? null,
          probeDetail: e.probe?.detail?.slice(0, MAX_DETAIL) ?? null,
          probedAt: e.probe?.at ?? null,
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

  async recordProbe(host: string, titleId: string, infoHash: string, outcome: TrendingProbeOutcome, detail: string | null, at: Date): Promise<void> {
    await this.db
      .update(streamTrending)
      .set({ probeOutcome: outcome, probeDetail: detail === null ? null : detail.slice(0, MAX_DETAIL), probedAt: at })
      .where(and(eq(streamTrending.host, host), eq(streamTrending.titleId, titleId), eq(streamTrending.infoHash, infoHash)));
  }
}
