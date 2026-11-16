import { readFile } from 'node:fs/promises';
import { and, asc, desc, eq, gte, inArray, isNull, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  STREAM_ID_KINDS,
  moviePlays,
  movieTitles,
  streamCaches,
  streamProbeTitles,
  streamProviderHealth,
  streamProviders,
  type StreamCacheKind,
  type StreamCacheRow,
  type StreamHealthOutcome,
  type StreamIdKind,
  type StreamManifestKind,
  type StreamProviderHealthRow,
  type StreamProviderRow,
} from '../db/schema.js';
import { freshStreamSourceSql } from '../movies/repo.js';
import type { TitleKind } from '../movies/tmdb.js';
import type { ListedCandidate } from './candidates.js';
import type { ProbeRecord, ProbeStore, ProbeTarget } from './prober.js';
import type { ResolvedSource, StreamRef } from './types.js';

/** How many of a provider's latest times to a stream are kept per host. */
export const RECENT_TIMINGS = 10;
const MAX_DETAIL = 500;

/** One entry of claude/streaming/direct/providers.seed.json, read and checked. */
export interface SeedProvider {
  name: string;
  idKind: StreamIdKind;
  movie: string;
  tv: string | null;
  browserOnly: boolean;
  enSubtitle: boolean | null;
  notes: string;
}

const template = z
  .string()
  .trim()
  .refine((s) => /^https?:\/\//.test(s) && s.includes('{id}'), 'must be an http(s) address with {id}');

const seedEntry = z.object({
  name: z.string().trim().min(1).max(80),
  id_kind: z.enum(STREAM_ID_KINDS).default('tmdb'),
  movie: template,
  tv: template.nullable().default(null),
  browser_only: z.boolean().default(false),
  en_subtitle: z.boolean().nullable().default(null),
  notes: z.string().default(''),
});

/** Reads and checks the seed file (the boundary for it). Throws with the file name on any problem, a repeated name included. */
export async function readSeedFile(file: string): Promise<SeedProvider[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: not readable JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = z.array(seedEntry).safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const seen = new Set<string>();
  return parsed.data.map((e) => {
    if (seen.has(e.name)) throw new Error(`${file}: provider "${e.name}" appears twice`);
    seen.add(e.name);
    return { name: e.name, idKind: e.id_kind, movie: e.movie, tv: e.tv, browserOnly: e.browser_only, enSubtitle: e.en_subtitle, notes: e.notes };
  });
}

/** A provider /update-cloud-source adds: its film and episode templates and the site it came from. */
export interface NewStreamProvider {
  name: string;
  movie: string;
  tv: string | null;
  /** The aggregator site's origin, `https://ww6-fmovies.com`; null for a seed row. */
  originSite: string | null;
}

/** A registry row in the seed file's shape: what `cli.mjs resolve --providers <file>` reads. */
export interface ProviderSeedJson {
  name: string;
  id_kind: StreamIdKind;
  movie: string;
  tv: string | null;
  browser_only: boolean;
  en_subtitle: boolean | null;
  notes: string;
}

export function providerSeedJson(row: StreamProviderRow): ProviderSeedJson {
  return { name: row.name, id_kind: row.idKind, movie: row.movie, tv: row.tv, browser_only: row.browserOnly, en_subtitle: row.enSubtitle, notes: row.notes };
}

/** One provider's health on this host, as `cli.mjs resolve --health <file>` reads it. */
export interface ProviderHealthJson {
  en_subtitle: boolean | null;
  best_height: number | null;
  median_s: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function healthMap(rows: readonly StreamProviderHealthRow[]): Record<string, ProviderHealthJson> {
  const out: Record<string, ProviderHealthJson> = {};
  for (const r of rows) {
    out[r.name] = {
      en_subtitle: r.enSubtitle,
      best_height: r.bestHeight,
      median_s: median(r.recentS),
      last_success_at: iso(r.lastSuccessAt),
      last_failure_at: iso(r.lastFailureAt),
      consecutive_failures: r.consecutiveFailures,
    };
  }
  return out;
}

/** What `providers()` (and phase 8's `direct_stream_sources`) shows of one provider. */
export interface ProviderView extends ProviderSeedJson {
  /** Null: from the checked-in seed. */
  origin_site: string | null;
  added_at: string;
  /** This host's health; null until a resolve tried the provider here. */
  health:
    | (ProviderHealthJson & {
        last_outcome: StreamHealthOutcome;
        last_detail: string;
        successes: number;
        failures: number;
        manifest_kind: StreamManifestKind | null;
      })
    | null;
}

export function providerView(row: StreamProviderRow, health: StreamProviderHealthRow | null): ProviderView {
  return {
    ...providerSeedJson(row),
    origin_site: row.originSite,
    added_at: row.addedAt.toISOString(),
    health:
      health === null
        ? null
        : {
            en_subtitle: health.enSubtitle,
            best_height: health.bestHeight,
            median_s: median(health.recentS),
            last_success_at: iso(health.lastSuccessAt),
            last_failure_at: iso(health.lastFailureAt),
            consecutive_failures: health.consecutiveFailures,
            last_outcome: health.lastOutcome,
            last_detail: health.lastDetail,
            successes: health.successes,
            failures: health.failures,
            manifest_kind: health.manifestKind,
          },
  };
}

/** A cache's title slot: a film is season 0, episode 0, as in movie_stream_sources. */
export function cacheSlot(ref: StreamRef): { kind: 'movie' | 'tv'; tmdbId: number; season: number; episode: number } {
  return ref.kind === 'movie'
    ? { kind: 'movie', tmdbId: ref.tmdbId, season: 0, episode: 0 }
    : { kind: 'tv', tmdbId: ref.tmdbId, season: ref.season, episode: ref.episode };
}

/** The title a cache row holds. */
export function cacheRef(row: StreamCacheRow): StreamRef {
  return row.kind === 'movie' ? { kind: 'movie', tmdbId: row.tmdbId } : { kind: 'tv', tmdbId: row.tmdbId, season: row.season, episode: row.episode };
}

/** What a cache learned from its source, written once the download is planned. */
export interface CachePlanned {
  provider: string;
  manifestKind: StreamCacheKind;
  height: number | null;
  audioLang: string | null;
  segmentsTotal: number;
  segmentsDone: number;
  bytes: number;
  durationS: number | null;
}

function slotWhere(ref: StreamRef) {
  const s = cacheSlot(ref);
  return and(eq(streamCaches.kind, s.kind), eq(streamCaches.tmdbId, s.tmdbId), eq(streamCaches.season, s.season), eq(streamCaches.episode, s.episode));
}

/** One provider's try in one resolve, to record. `source` is set on the try that resolved. */
export interface HealthAttempt {
  provider: string;
  outcome: StreamHealthOutcome;
  took_s: number | null;
  detail: string;
  source: ResolvedSource | null;
}

/** The only writer of `stream_providers`, `stream_provider_health` and `stream_caches`. */
export class DirectStreamRepo {
  constructor(private readonly db: Db) {}

  /**
   * Loads the seed: a missing provider is inserted (`origin_site` null); a seed row whose fields
   * changed in the file is updated. A row a site added (`origin_site` set) is never touched, and
   * nothing is deleted. Returns how many rows were inserted and updated.
   */
  async syncSeed(entries: readonly SeedProvider[], now: Date = new Date()): Promise<{ inserted: number; updated: number }> {
    if (entries.length === 0) return { inserted: 0, updated: 0 };
    const p = streamProviders;
    const rows = await this.db
      .insert(p)
      .values(
        entries.map((e) => ({
          name: e.name,
          idKind: e.idKind,
          movie: e.movie,
          tv: e.tv,
          browserOnly: e.browserOnly,
          enSubtitle: e.enSubtitle,
          notes: e.notes,
          originSite: null,
          addedAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: p.name,
        set: {
          idKind: sql`excluded.id_kind`,
          movie: sql`excluded.movie`,
          tv: sql`excluded.tv`,
          browserOnly: sql`excluded.browser_only`,
          enSubtitle: sql`excluded.en_subtitle`,
          notes: sql`excluded.notes`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`${p.originSite} is null and (${p.idKind} is distinct from excluded.id_kind or ${p.movie} is distinct from excluded.movie or ${p.tv} is distinct from excluded.tv or ${p.browserOnly} is distinct from excluded.browser_only or ${p.enSubtitle} is distinct from excluded.en_subtitle or ${p.notes} is distinct from excluded.notes)`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    const inserted = rows.filter((r) => r.inserted).length;
    return { inserted, updated: rows.length - inserted };
  }

  /** Every provider, by name. */
  async providers(): Promise<StreamProviderRow[]> {
    return this.db.select().from(streamProviders).orderBy(asc(streamProviders.name));
  }

  /** This host's health rows. */
  async healthFor(host: string): Promise<StreamProviderHealthRow[]> {
    return this.db.select().from(streamProviderHealth).where(eq(streamProviderHealth.host, host));
  }

  /** Records one resolve's tries for `host`, in one transaction. */
  async recordAttempts(host: string, attempts: readonly HealthAttempt[], now: Date = new Date()): Promise<void> {
    if (attempts.length === 0) return;
    const h = streamProviderHealth;
    await this.db.transaction(async (tx) => {
      for (const a of attempts) {
        const detail = a.detail.slice(0, MAX_DETAIL);
        if (a.outcome === 'resolved') {
          const seen =
            a.source === null
              ? {}
              : { manifestKind: a.source.manifest_kind, bestHeight: a.source.best_height, enSubtitle: a.source.en_subtitle };
          await tx
            .insert(h)
            .values({
              name: a.provider,
              host,
              lastOutcome: 'resolved',
              lastDetail: detail,
              successes: 1,
              failures: 0,
              consecutiveFailures: 0,
              lastSuccessAt: now,
              recentS: a.took_s === null ? [] : [a.took_s],
              ...seen,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [h.name, h.host],
              set: {
                lastOutcome: 'resolved',
                lastDetail: detail,
                successes: sql`${h.successes} + 1`,
                consecutiveFailures: 0,
                lastSuccessAt: now,
                recentS:
                  a.took_s === null
                    ? sql`${h.recentS}`
                    : sql`(array_append(${h.recentS}, ${a.took_s}::real))[greatest(1, cardinality(${h.recentS}) - ${RECENT_TIMINGS - 2}):]`,
                ...seen,
                updatedAt: now,
              },
            });
        } else {
          await tx
            .insert(h)
            .values({
              name: a.provider,
              host,
              lastOutcome: a.outcome,
              lastDetail: detail,
              successes: 0,
              failures: 1,
              consecutiveFailures: 1,
              lastFailureAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [h.name, h.host],
              set: {
                lastOutcome: a.outcome,
                lastDetail: detail,
                failures: sql`${h.failures} + 1`,
                consecutiveFailures: sql`${h.consecutiveFailures} + 1`,
                lastFailureAt: now,
                updatedAt: now,
              },
            });
        }
      }
    });
  }

  /**
   * Adds providers the registry lacks and returns the names inserted. A name already present is
   * left exactly as it is (on conflict do nothing): this never rewrites a seed row or one another
   * machine added. What the probe learns goes to stream_provider_health, not here.
   */
  async insertProviders(rows: NewStreamProvider[], now: Date = new Date()): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await this.db
      .insert(streamProviders)
      .values(
        rows.map((row) => ({
          name: row.name,
          idKind: 'tmdb' as const,
          movie: row.movie,
          tv: row.tv,
          browserOnly: false,
          enSubtitle: null,
          notes: '',
          originSite: row.originSite,
          addedAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({ target: streamProviders.name })
      .returning({ name: streamProviders.name });
    return inserted.map((row) => row.name);
  }

  /**
   * This host's cache of a title slot, made now (state downloading) when there is none.
   * `created` is false when the row was already there; its `max_height` is then left as it was.
   */
  async createCache(host: string, ref: StreamRef, maxHeight: number | null, now: Date = new Date()): Promise<{ row: StreamCacheRow; created: boolean }> {
    const slot = cacheSlot(ref);
    const [inserted] = await this.db
      .insert(streamCaches)
      .values({ host, ...slot, maxHeight, state: 'downloading', createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [streamCaches.kind, streamCaches.tmdbId, streamCaches.season, streamCaches.episode, streamCaches.host] })
      .returning();
    if (inserted !== undefined) return { row: inserted, created: true };
    const existing = await this.cacheFor(host, ref);
    if (existing === null) throw new Error(`the stream cache of ${slot.kind} ${slot.tmdbId} on ${host} vanished while it was made`);
    return { row: existing, created: false };
  }

  async cacheById(id: string): Promise<StreamCacheRow | null> {
    const [row] = await this.db.select().from(streamCaches).where(eq(streamCaches.id, id));
    return row ?? null;
  }

  /** One host's cache of a title slot, or null. */
  async cacheFor(host: string, ref: StreamRef): Promise<StreamCacheRow | null> {
    const [row] = await this.db.select().from(streamCaches).where(and(slotWhere(ref), eq(streamCaches.host, host)));
    return row ?? null;
  }

  /** Every host's cache of a title slot. */
  async cachesOf(ref: StreamRef): Promise<StreamCacheRow[]> {
    return this.db.select().from(streamCaches).where(slotWhere(ref)).orderBy(asc(streamCaches.host));
  }

  /** Every cache of both hosts, newest first. */
  async caches(): Promise<StreamCacheRow[]> {
    return this.db.select().from(streamCaches).orderBy(desc(streamCaches.createdAt), asc(streamCaches.id));
  }

  /** This host's caches still downloading, oldest first: what a daemon start carries on. */
  async unfinishedCaches(host: string): Promise<StreamCacheRow[]> {
    return this.db
      .select()
      .from(streamCaches)
      .where(and(eq(streamCaches.host, host), eq(streamCaches.state, 'downloading')))
      .orderBy(asc(streamCaches.createdAt));
  }

  async cacheResolved(id: string, now: Date = new Date()): Promise<void> {
    await this.db.update(streamCaches).set({ resolves: sql`${streamCaches.resolves} + 1`, updatedAt: now }).where(eq(streamCaches.id, id));
  }

  async cachePlanned(id: string, p: CachePlanned, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({
        provider: p.provider,
        manifestKind: p.manifestKind,
        height: p.height,
        audioLang: p.audioLang,
        segmentsTotal: p.segmentsTotal,
        segmentsDone: p.segmentsDone,
        bytes: p.bytes,
        durationS: p.durationS,
        updatedAt: now,
      })
      .where(eq(streamCaches.id, id));
  }

  async cacheProgress(id: string, segmentsDone: number, bytes: number, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({ segmentsDone, bytes, updatedAt: now })
      .where(and(eq(streamCaches.id, id), eq(streamCaches.state, 'downloading')));
  }

  async cacheSubtitle(id: string, subtitle: boolean, now: Date = new Date()): Promise<void> {
    await this.db.update(streamCaches).set({ subtitle, updatedAt: now }).where(eq(streamCaches.id, id));
  }

  async cacheReady(id: string, done: { segments: number; bytes: number; subtitle: boolean }, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({
        state: 'ready',
        segmentsTotal: done.segments,
        segmentsDone: done.segments,
        bytes: done.bytes,
        subtitle: done.subtitle,
        error: null,
        errorDetail: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(streamCaches.id, id));
  }

  async cacheFailed(id: string, error: string, detail: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({ state: 'failed', error, errorDetail: detail.slice(0, MAX_DETAIL), completedAt: null, updatedAt: now })
      .where(eq(streamCaches.id, id));
  }

  /** A failed cache asked for again: downloading, its error cleared; the files on disk stay for the resume. */
  async cacheRestarted(id: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({ state: 'downloading', error: null, errorDetail: null, completedAt: null, updatedAt: now })
      .where(eq(streamCaches.id, id));
  }

  async deleteCache(id: string): Promise<boolean> {
    const rows = await this.db.delete(streamCaches).where(eq(streamCaches.id, id)).returning({ id: streamCaches.id });
    return rows.length > 0;
  }
}

/** Rows per INSERT when a listing is written. */
const LISTING_CHUNK = 500;

function toTarget(kind: unknown, tmdbId: unknown, season: unknown, episode: unknown): ProbeTarget {
  const k: TitleKind = kind === 'tv' ? 'tv' : 'movie';
  return {
    kind: k,
    tmdbId: Number(tmdbId),
    season: k === 'tv' ? Number(season) : null,
    episode: k === 'tv' ? Number(episode) : null,
  };
}

/**
 * The direct-streaming prober's storage (phase 10): the only writer of stream_probe_titles, and
 * the prober's reads of movie_stream_sources, movie_plays and movie_titles (never their writer:
 * MoviesRepo is, through DirectStreamService.resolve's hooks).
 */
export class ProbeRepo implements ProbeStore {
  constructor(private readonly db: Db) {}

  /**
   * Titles with a fresh source on `host` as of `since` (phase 5's freshStreamSourceSql), each
   * counted once. A title the owner marked "not interested" or finished by hand is not counted:
   * its place in the catalog goes to another title.
   */
  async freshCount(host: string, since: Date): Promise<number> {
    const res = await this.db.execute<{ n: number | string }>(
      sql`select count(*) as n from movie_titles
          where ${freshStreamSourceSql(host, since)} and movie_titles.not_interested_at is null and movie_titles.watched_at is null`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Verified, not stale sources on `host` verified at or before `dueBefore`, oldest first: what a pass re-checks. A "not interested" title is not. */
  async dueRechecks(host: string, dueBefore: Date, limit: number): Promise<ProbeTarget[]> {
    const res = await this.db.execute<{ kind: string; tmdb_id: number; season: number; episode: number }>(sql`
      select t.kind, t.tmdb_id, s.season, s.episode
      from movie_stream_sources s
      join movie_titles t on t.id = s.title_id
      where s.host = ${host}
        and s.verified_at is not null
        and s.verified_at <= ${dueBefore}
        and s.stale_at is null
        and t.not_interested_at is null
      order by s.verified_at asc, s.title_id asc, s.season asc, s.episode asc
      limit ${limit}`);
    return res.rows.map((r) => toTarget(r.kind, r.tmdb_id, r.season, r.episode));
  }

  /** When this host's candidate listing was last written; null before the first one. */
  async listedAt(host: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(streamProbeTitles.listedAt) })
      .from(streamProbeTitles)
      .where(eq(streamProbeTitles.host, host));
    return row?.at ?? null;
  }

  /**
   * Replaces this host's listing in one transaction: every title is unlisted, then `entries` are
   * listed with their ranks. Probe outcomes and backoff survive, also for titles that left the lists.
   * `entries` hold each (kind, tmdbId) once (rankKind dedupes).
   */
  async replaceListing(host: string, entries: readonly ListedCandidate[], at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(streamProbeTitles)
        .set({ listSource: null, listRank: null, listedAt: null })
        .where(eq(streamProbeTitles.host, host));
      for (let i = 0; i < entries.length; i += LISTING_CHUNK) {
        const chunk = entries.slice(i, i + LISTING_CHUNK);
        await tx
          .insert(streamProbeTitles)
          .values(chunk.map((e) => ({ host, kind: e.kind, tmdbId: e.tmdbId, listSource: e.source, listRank: e.rank, listedAt: at })))
          .onConflictDoUpdate({
            target: [streamProbeTitles.host, streamProbeTitles.kind, streamProbeTitles.tmdbId],
            set: {
              listSource: sql`excluded.list_source`,
              listRank: sql`excluded.list_rank`,
              listedAt: sql`excluded.listed_at`,
            },
          });
      }
    });
  }

  /**
   * Listed titles of `kind` the prober may probe now, best rank first: out of backoff, and with no
   * source on `host` that is fresh as of `freshSince` (never a title already verified fresh), and
   * never a title the owner marked "not interested".
   */
  async eligible(host: string, kind: TitleKind, now: Date, freshSince: Date, limit: number): Promise<ProbeTarget[]> {
    const res = await this.db.execute<{ tmdb_id: number }>(sql`
      select c.tmdb_id
      from stream_probe_titles c
      where c.host = ${host}
        and c.kind = ${kind}
        and c.list_source is not null
        and (c.retry_after is null or c.retry_after <= ${now})
        and not exists (
          select 1 from movie_titles
          where movie_titles.id = c.kind || '-' || c.tmdb_id::text
            and (${freshStreamSourceSql(host, freshSince)} or movie_titles.not_interested_at is not null)
        )
      order by c.list_rank asc
      limit ${limit}`);
    return res.rows.map((r) => ({ kind, tmdbId: Number(r.tmdb_id), season: null, episode: null }));
  }

  /** Failed probes in a row of one title on `host`; 0 when it was never probed. */
  async failures(host: string, kind: TitleKind, tmdbId: number): Promise<number> {
    const [row] = await this.db
      .select({ failures: streamProbeTitles.failures })
      .from(streamProbeTitles)
      .where(and(eq(streamProbeTitles.host, host), eq(streamProbeTitles.kind, kind), eq(streamProbeTitles.tmdbId, tmdbId)));
    return row?.failures ?? 0;
  }

  /** Writes one probe's outcome. A re-check of a title no list holds creates an unlisted row. */
  async record(host: string, r: ProbeRecord): Promise<void> {
    await this.db
      .insert(streamProbeTitles)
      .values({
        host,
        kind: r.kind,
        tmdbId: r.tmdbId,
        probedAt: r.probedAt,
        outcome: r.outcome,
        failures: r.failures,
        retryAfter: r.retryAfter,
      })
      .onConflictDoUpdate({
        target: [streamProbeTitles.host, streamProbeTitles.kind, streamProbeTitles.tmdbId],
        set: { probedAt: r.probedAt, outcome: r.outcome, failures: r.failures, retryAfter: r.retryAfter },
      });
  }

  /**
   * True when a play on `host` is open and was updated at or after `since`: the VLC notesd follows,
   * or a stream whose player page posts its position (phase 5 keeps both on movie_plays).
   */
  async activePlay(host: string, since: Date): Promise<boolean> {
    const rows = await this.db
      .select({ id: moviePlays.id })
      .from(moviePlays)
      .where(and(eq(moviePlays.host, host), isNull(moviePlays.endedAt), gte(moviePlays.updatedAt, since)))
      .limit(1);
    return rows.length > 0;
  }

  /** The TMDB genre names stored on these titles, by title id. */
  async titleGenres(ids: readonly string[]): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: movieTitles.id, genres: movieTitles.genres })
      .from(movieTitles)
      .where(inArray(movieTitles.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r.genres]));
  }
}
