import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { NewStreamProvider } from './repo.js';
import type { DirectStreamRunner } from './runner.js';
import type { ResolveOutcome, ResolveOutput, StreamRef } from './types.js';

/** `claude/streaming/direct/known-titles.json`, two folders up from src/directStream or dist/directStream. */
export const DEFAULT_KNOWN_TITLES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'claude',
  'streaming',
  'direct',
  'known-titles.json',
);

/** A title every provider is probed against (phase 2's list; Fight Club, TMDB 550, among them). */
export interface KnownTitle {
  label: string;
  ref: StreamRef;
}

const KnownTitlesFile = z
  .array(
    z.object({
      label: z.string().min(1),
      kind: z.enum(['movie', 'tv']),
      tmdb_id: z.number().int().positive(),
      season: z.number().int().positive().optional(),
      episode: z.number().int().positive().optional(),
    }),
  )
  .min(1);

export async function loadKnownTitles(file: string = DEFAULT_KNOWN_TITLES_PATH): Promise<KnownTitle[]> {
  const rows = KnownTitlesFile.parse(JSON.parse(await readFile(file, 'utf8')));
  return rows.map((row) => ({
    label: row.label,
    ref:
      row.kind === 'movie'
        ? { kind: 'movie', tmdbId: row.tmdb_id }
        : { kind: 'tv', tmdbId: row.tmdb_id, season: row.season ?? 1, episode: row.episode ?? 1 },
  }));
}

const filmTemplate = z.string().startsWith('https://').includes('{id}');
const episodeTemplate = z.string().startsWith('https://').includes('{id}').includes('{season}').includes('{episode}');

/** Which reader found a provider: the site's scripts (plain requests), or the frames a watch page loads in the streaming Chrome. */
export type TemplateReader = 'scripts' | 'frames';
const readerField = z.enum(['scripts', 'frames']).default('scripts');

/** What `cli.mjs templates <site>` prints (claude/streaming/direct/templates.mjs). */
export const TemplatesAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    site: z.string().url(),
    reader: readerField,
    scripts_read: z.number().int().nonnegative(),
    frames_read: z.number().int().nonnegative().optional(),
    providers: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(60),
          movie: filmTemplate,
          tv: episodeTemplate.nullable(),
          found_in: z.string().nullable(),
          reader: readerField,
        }),
      )
      .min(1),
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
  z.object({
    ok: z.literal(false),
    site: z.string().nullable(),
    error: z.enum(['bad_url', 'unreachable', 'bot_check', 'no_templates', 'chrome_unavailable', 'no_tab', 'usage']),
    detail: z.string(),
    scripts_read: z.number().int().nonnegative(),
  }),
]);

/** Phase 3's ResolveOutcome (attempt outcomes), plus not_probed for a probe this phase did not run. */
export type ProbeOutcome = ResolveOutcome | 'not_probed';

/** One known title tried against one new provider. */
export interface ProbeResult {
  title: string;
  outcome: ProbeOutcome;
  took_s: number | null;
  manifest_kind: string | null;
  best_height: number | null;
  en_subtitle: boolean | null;
  detail: string;
}

export interface AddedProvider {
  name: string;
  movie: string;
  tv: string | null;
  /** The reader that found it. */
  reader: TemplateReader;
  /** The site's name for it when that name was already taken by another provider. */
  renamed_from: string | null;
  /** True when at least one known film resolved through it. */
  resolves: boolean;
  probes: ProbeResult[];
}

export type UpdateSourceError = 'bad_url' | 'unreachable' | 'bot_check' | 'no_templates' | 'chrome_unavailable' | 'no_tab' | 'usage' | 'reader_failed' | 'busy';

export type UpdateSourceAnswer =
  | {
      ok: true;
      site: string;
      /** The reader that found the providers: `frames` only when the scripts held none. */
      reader: TemplateReader;
      scripts_read: number;
      /** Frame addresses read in the streaming Chrome; 0 when the scripts answered. */
      frames_read: number;
      found: number;
      added: AddedProvider[];
      /** Found on the site and already in the registry (same template host and path), under registry_name. */
      known: Array<{ name: string; registry_name: string }>;
      skipped: Array<{ name: string; reason: string }>;
    }
  | { ok: false; site: string; error: UpdateSourceError; detail: string; registry_changed: false };

/** The two registry calls this needs (DirectStreamRepo through the service). */
export interface ProviderRegistry {
  list(): Promise<Array<{ name: string; movie: string; tv: string | null }>>;
  insert(rows: NewStreamProvider[]): Promise<string[]>;
}

export interface UpdateSourceDeps {
  runner: DirectStreamRunner;
  registry: ProviderRegistry;
  knownTitles: () => Promise<KnownTitle[]>;
  /** Resolves one known title with only this provider and records its health on this host. */
  probe: (provider: string, title: KnownTitle) => Promise<ProbeResult>;
}

const PLACEHOLDER = /\{(id|season|episode)\}/g;

/**
 * Two templates are the same provider when they reach the same host (without `www.`) and path
 * (without a trailing slash), with the id in the same query parameters. Other query parameters
 * (`autoPlay`, `color`, `theme`) are cosmetic and do not count.
 */
export function providerKey(template: string): string {
  const url = new URL(template.replace(PLACEHOLDER, '__$1__'));
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
  const idParams = [...url.searchParams]
    .filter(([, value]) => value.includes('__id__'))
    .map(([key]) => key.toLowerCase())
    .sort();
  return idParams.length === 0 ? `${host}${pathname}` : `${host}${pathname}?${idParams.join('&')}`;
}

function hostOf(template: string): string {
  return new URL(template.replace(PLACEHOLDER, '__$1__')).hostname.replace(/^www\./, '');
}

/**
 * Which found providers are new. Known: the registry (or an earlier entry of this site) has the
 * same provider key. New with a taken name: stored as `<name> (<host>)`, or skipped when that is
 * taken too.
 */
export function planInsert(
  found: Array<{ name: string; movie: string; tv: string | null }>,
  existing: Array<{ name: string; movie: string }>,
  originSite: string,
): {
  rows: NewStreamProvider[];
  renamed: Map<string, string>;
  known: Array<{ name: string; registry_name: string }>;
  skipped: Array<{ name: string; reason: string }>;
} {
  const byKey = new Map(existing.map((p) => [providerKey(p.movie), p.name]));
  const names = new Set(existing.map((p) => p.name.toLowerCase()));
  const rows: NewStreamProvider[] = [];
  const renamed = new Map<string, string>();
  const known: Array<{ name: string; registry_name: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const p of found) {
    const key = providerKey(p.movie);
    const match = byKey.get(key);
    if (match !== undefined) {
      known.push({ name: p.name, registry_name: match });
      continue;
    }
    let name = p.name;
    if (names.has(name.toLowerCase())) {
      name = `${p.name} (${hostOf(p.movie)})`;
      if (names.has(name.toLowerCase())) {
        skipped.push({ name: p.name, reason: 'name_taken' });
        continue;
      }
      renamed.set(name, p.name);
    }
    names.add(name.toLowerCase());
    byKey.set(key, name);
    rows.push({ name, movie: p.movie, tv: p.tv, originSite });
  }
  return { rows, renamed, known, skipped };
}

/** One resolve answer (phase 3's ResolveOutput), read for the provider that was asked about. */
export function toProbeResult(title: KnownTitle, provider: string, answer: ResolveOutput): ProbeResult {
  if (answer.ok && answer.source.provider === provider) {
    return {
      title: title.label,
      outcome: 'resolved',
      took_s: answer.source.took_s,
      manifest_kind: answer.source.manifest_kind,
      best_height: answer.source.best_height,
      en_subtitle: answer.source.en_subtitle,
      detail: '',
    };
  }
  const attempt = answer.attempts.find((a) => a.provider === provider);
  return {
    title: title.label,
    outcome: attempt?.outcome ?? 'error',
    took_s: attempt?.took_s ?? null,
    manifest_kind: null,
    best_height: null,
    en_subtitle: null,
    detail: attempt?.detail ?? (answer.ok ? 'the resolve did not try this provider' : answer.error),
  };
}

function notProbed(title: KnownTitle, detail: string): ProbeResult {
  return { title: title.label, outcome: 'not_probed', took_s: null, manifest_kind: null, best_height: null, en_subtitle: null, detail };
}

async function probeProvider(
  row: NewStreamProvider,
  reader: TemplateReader,
  renamedFrom: string | null,
  titles: KnownTitle[],
  probe: UpdateSourceDeps['probe'],
): Promise<AddedProvider> {
  const probes: ProbeResult[] = [];
  for (const title of titles.filter((t) => t.ref.kind === 'movie')) probes.push(await probe(row.name, title));
  const resolves = probes.some((p) => p.outcome === 'resolved');
  if (row.tv !== null) {
    for (const title of titles.filter((t) => t.ref.kind === 'tv')) {
      probes.push(resolves ? await probe(row.name, title) : notProbed(title, 'no known film resolved through it'));
    }
  }
  return { name: row.name, movie: row.movie, tv: row.tv, reader, renamed_from: renamedFrom, resolves, probes };
}

function failed(site: string, error: UpdateSourceError, detail: string): UpdateSourceAnswer {
  return { ok: false, site, error, detail, registry_changed: false };
}

/** Watch pages of the site for the frame reader: a film's page, and an episode's for the episode template. */
export interface WatchPages {
  watchPage?: string | undefined;
  episodePage?: string | undefined;
  /**
   * Read the frames of a tab the owner already solved a Cloudflare challenge in by hand
   * (`cli.mjs gate <origin>`), instead of the sniffer's fresh navigation, which would show the
   * challenge again. The owner gates the tab themselves; nothing here solves anything.
   */
  fromTab?: boolean | undefined;
}

/**
 * /update-cloud-source: read the site's templates (its scripts; when they hold none, the frames a
 * watch page loads in the streaming Chrome), add the providers the registry lacks, probe
 * each new one against the known titles, and report per provider. Nothing is written unless the
 * read succeeded.
 */
export async function updateSource(site: string, deps: UpdateSourceDeps, pages: WatchPages = {}): Promise<UpdateSourceAnswer> {
  const titles = await deps.knownTitles();
  let raw: unknown;
  try {
    raw = await deps.runner([
      'templates',
      site,
      ...(pages.watchPage === undefined ? [] : ['--watch', pages.watchPage]),
      ...(pages.episodePage === undefined ? [] : ['--episode', pages.episodePage]),
      ...(pages.fromTab === true ? ['--from-tab'] : []),
    ]);
  } catch (err) {
    return failed(site, 'reader_failed', err instanceof Error ? err.message : String(err));
  }
  const parsed = TemplatesAnswerSchema.safeParse(raw);
  if (!parsed.success) return failed(site, 'reader_failed', `the template reader answered something unexpected: ${parsed.error.message.slice(0, 300)}`);
  const answer = parsed.data;
  if (!answer.ok) return failed(answer.site ?? site, answer.error, answer.detail);

  const origin = new URL(answer.site).origin;
  const plan = planInsert(answer.providers, await deps.registry.list(), origin);
  const inserted = new Set(await deps.registry.insert(plan.rows));
  const added: AddedProvider[] = [];
  const known = [...plan.known];
  for (const row of plan.rows) {
    // Inserted meanwhile by the other machine: it is known now, and that machine probes it.
    if (!inserted.has(row.name)) {
      known.push({ name: plan.renamed.get(row.name) ?? row.name, registry_name: row.name });
      continue;
    }
    const reader = answer.providers.find((p) => p.movie === row.movie)?.reader ?? answer.reader;
    added.push(await probeProvider(row, reader, plan.renamed.get(row.name) ?? null, titles, deps.probe));
  }
  return {
    ok: true,
    site: answer.site,
    reader: answer.reader,
    scripts_read: answer.scripts_read,
    frames_read: answer.frames_read ?? 0,
    found: answer.providers.length,
    added,
    known,
    skipped: [...answer.skipped, ...plan.skipped],
  };
}
