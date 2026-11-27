import { readFile } from 'node:fs/promises';
import { and, asc, desc, eq, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  STREAM_ID_KINDS,
  streamCaches,
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
import type { ResolvedSource, StreamRef } from './types.js';
import type { Delivery, DeliveryVerdict } from './delivery.js';

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
  /** What the last try said: the resolver rests a provider that is down or behind a check (order.mjs restingUntil). */
  last_outcome?: StreamHealthOutcome | null;
  last_detail?: string | null;
  /** How the provider's host delivered its last play here (delivery.ts); set by the service, never stored. */
  delivery?: DeliveryVerdict | null;
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
      last_outcome: r.lastOutcome,
      last_detail: r.lastDetail,
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
  /** The provider's last play on this host, from the stream evidence log (delivery.ts); null: none recent or long enough. */
  delivery: Delivery | null;
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
    delivery: null,
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

/** How a `no_stream` attempt's detail starts when the provider's own page did not load (order.mjs UNREACHABLE, which resolve.mjs writes). */
export const UNREACHABLE_DETAIL = 'unreachable: ';

/**
 * Whether a try counts toward the provider's failures in a row (the rest, order.mjs restingUntil). A `no_stream`
 * from a page that loaded counts only when the title demonstrably exists: another cloud provider resolved it in the
 * same resolve, or a cloud provider or a torrent streamed it (the film, or that episode) on this machine before. A
 * provider is not put to rest for a title no source has: Smashy, VidRock, NexaStream and MovieVault rested for
 * a week for titles nothing streamed. Such a try is not recorded: it neither adds to nor resets the count. An
 * unreachable page, a bot check and an error count as before.
 */
export function countsTowardRest(attempt: { outcome: string; detail: string }, titleStreamed: boolean): boolean {
  if (attempt.outcome !== 'no_stream' || attempt.detail.startsWith(UNREACHABLE_DETAIL)) return true;
  return titleStreamed;
}

/** The only writer of `stream_providers`, `stream_provider_health` and `stream_caches`. */
export class DirectStreamRepo {
  constructor(private readonly db: Db) {}

  /**
   * Loads the seed: a missing provider is inserted (`origin_site` null); a seed row whose fields
   * changed in the file is updated. A seed row the files no longer name is deleted, with its health
   * rows (the foreign key cascades); what played from it (movie_stream_sources, movie_plays, the
   * channels) names it as text and stays. A row a site added (`origin_site` set) is never touched.
   * A seed provider whose entry changed after it was last tried on a host (a new address: Movies111
   * and MovieVault moved, and kept the 10 failures in a row of their old hosts) has that host's
   * failures in a row set to 0, so it is ordered and asked like a fresh one instead of resting.
   * An empty seed changes nothing. Returns how many rows were inserted and updated, the names
   * removed and the names whose failures in a row were reset.
   */
  async syncSeed(entries: readonly SeedProvider[], now: Date = new Date()): Promise<{ inserted: number; updated: number; removed: string[]; reset: string[] }> {
    if (entries.length === 0) return { inserted: 0, updated: 0, removed: [], reset: [] };
    const p = streamProviders;
    return this.db.transaction(async (tx) => {
      const gone = await tx
        .delete(p)
        .where(and(isNull(p.originSite), notInArray(p.name, entries.map((e) => e.name))))
        .returning({ name: p.name });
      const rows = await tx
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
      const h = streamProviderHealth;
      const reset = await tx
        .update(h)
        .set({ consecutiveFailures: 0 })
        .where(
          and(
            sql`${h.consecutiveFailures} > 0`,
            // Spelled out: both tables have `name` and `updated_at`, and an unqualified column would read the inner one.
            sql`exists (select 1 from stream_providers sp where sp.name = stream_provider_health.name and sp.origin_site is null and sp.updated_at > stream_provider_health.updated_at)`,
          ),
        )
        .returning({ name: h.name });
      return { inserted, updated: rows.length - inserted, removed: gone.map((r) => r.name).sort(), reset: [...new Set(reset.map((r) => r.name))].sort() };
    });
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
  async createCache(host: string, ref: StreamRef, maxHeight: number | null, now: Date = new Date(), auto = false): Promise<{ row: StreamCacheRow; created: boolean }> {
    const slot = cacheSlot(ref);
    const [inserted] = await this.db
      .insert(streamCaches)
      .values({ host, ...slot, maxHeight, auto, state: 'downloading', createdAt: now, updatedAt: now })
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

  /** The owner asked for a cache the player had started: it is kept like any other. */
  async cacheKept(id: string): Promise<void> {
    await this.db.update(streamCaches).set({ auto: false }).where(eq(streamCaches.id, id));
  }

  /** A paused play asked for a cache it had started before: its three days begin again. */
  async cacheTouched(id: string, now: Date = new Date()): Promise<void> {
    await this.db.update(streamCaches).set({ updatedAt: now }).where(eq(streamCaches.id, id));
  }

  /** This host's caches the player started that nothing has touched since `before`. */
  async staleAutoCaches(host: string, before: Date): Promise<StreamCacheRow[]> {
    return this.db
      .select()
      .from(streamCaches)
      .where(and(eq(streamCaches.host, host), eq(streamCaches.auto, true), lt(streamCaches.updatedAt, before)));
  }

  async deleteCache(id: string): Promise<boolean> {
    const rows = await this.db.delete(streamCaches).where(eq(streamCaches.id, id)).returning({ id: streamCaches.id });
    return rows.length > 0;
  }
}
