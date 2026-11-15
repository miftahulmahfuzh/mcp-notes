import { readFile } from 'node:fs/promises';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  STREAM_ID_KINDS,
  streamProviderHealth,
  streamProviders,
  type StreamHealthOutcome,
  type StreamIdKind,
  type StreamManifestKind,
  type StreamProviderHealthRow,
  type StreamProviderRow,
} from '../db/schema.js';
import type { ResolvedSource } from './types.js';

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

/** One provider's try in one resolve, to record. `source` is set on the try that resolved. */
export interface HealthAttempt {
  provider: string;
  outcome: StreamHealthOutcome;
  took_s: number | null;
  detail: string;
  source: ResolvedSource | null;
}

/** The only writer of `stream_providers` and `stream_provider_health`. */
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
}
