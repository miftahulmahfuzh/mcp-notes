import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, type Config } from '../config.js';
import { STREAM_HEALTH_OUTCOMES, type StreamHealthOutcome } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { AnimeRef } from './anime.js';
import { forward, jsonError, type FetchLike, type ForwardRequest } from './passThrough.js';
import { DirectStreamRepo, healthMap, providerSeedJson, providerView, readSeedFile, type HealthAttempt, type ProviderView } from './repo.js';
import { proxiedUrl } from './rewrite.js';
import { directStreamScriptRunner, parseOpenOutput, parseResolveOutput, type DirectStreamRunner, type OpenOutput } from './runner.js';
import { SessionStore, type StreamSession } from './sessions.js';
import { loadKnownTitles, toProbeResult, updateSource, type UpdateSourceAnswer, type WatchPages } from './updateSource.js';
import {
  DirectStreamError,
  isEnglish,
  refLabel,
  toStreamRef,
  type ManifestKind,
  type ResolveAttempt,
  type ResolveOutcome,
  type ResolveOutput,
  type ResolvedOutput,
  type SourceAudio,
  type StreamRef,
  type EpisodeNeighbors,
  type EpisodeNumber,
  type StreamRefInput,
} from './types.js';

/** The checked-in provider seed (direct streaming phase 1), loaded into stream_providers at every start. */
export const DEFAULT_SEED_FILE = path.join(REPO_ROOT, 'claude', 'streaming', 'direct', 'providers.seed.json');
/**
 * The anime embeds (`id_kind: "anilist"`), loaded into the same table. They are kept apart from the
 * provider seed because the probe campaign and its findings are about that file's 24 TMDB templates.
 */
export const DEFAULT_ANIME_SEED_FILE = path.join(REPO_ROOT, 'claude', 'streaming', 'direct', 'anime.seed.json');

/**
 * What the movies store hangs on direct streaming (phase 5 implements them; this module never imports
 * src/movies). Each is optional; a hook that throws is logged and ignored.
 */
export interface DirectStreamHooks {
  /**
   * Awaited after every resolve made by `resolve()`, `play()` or `refresh()`, success or failure, before
   * the caller gets its answer. `result.error` is `no_source` when no provider could stream the title;
   * any other error means the resolve could not run (the streaming Chrome is down) and says nothing
   * about the title. Not called by `runResolve` alone (phase 8's probes).
   */
  recordResolve?: (ref: StreamRef, result: ResolveOutput) => Promise<void>;
  /** Where a new session starts, in seconds, when the caller passed no `resumeS`. */
  resumeS?: (ref: StreamRef) => Promise<number | null>;
  /**
   * The title's original language (TMDB's code, "ko"): every resolve passes it to the resolver, which
   * skips a stream dubbed into another language, and the player picks that audio track. Null: unknown.
   */
  originalLanguage?: (ref: StreamRef) => Promise<string | null>;
  /** The title the player shows; default `refLabel(ref)`. */
  titleLabel?: (ref: StreamRef) => Promise<string | null>;
  /**
   * An anime's key for the anime embeds (anime.ts): its AniList id and the episode counted through
   * the whole series. Every resolve passes it to the resolver as `--anime`, which then tries the
   * providers keyed by AniList id first. Null: not an anime, or not mapped.
   */
  anime?: (ref: StreamRef) => Promise<AnimeRef | null>;
  /** The episodes before and after an episode, for the player's previous and next buttons. */
  neighbors?: (ref: StreamRef) => Promise<EpisodeNeighbors | null>;
}

export interface SessionSubtitle {
  /** Pass-through address on this daemon; an `.srt` track's carries `&vtt=1`. */
  url: string;
  lang: string | null;
  label: string;
  /** `vtt` for an `.srt` track (served converted); otherwise the resolver's format. */
  format: string;
  source: 'request' | 'manifest';
  english: boolean;
}

/** What GET /api/stream/sessions/:id answers: what the player page needs. */
export interface SessionInfo {
  session_id: string;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  title: string;
  provider: string;
  manifest_kind: ManifestKind;
  /** Pass-through address on this daemon. */
  manifest_url: string;
  subtitles: SessionSubtitle[];
  best_height: number | null;
  /** The title's original language (TMDB's code): the audio track the player picks. Null: unknown. */
  audio_lang: string | null;
  /** What the resolver heard in the stream; null when it was not asked. */
  audio: SourceAudio | null;
  resume_s: number | null;
  /** A series only: the episode before this one, or null (the first episode, a film, or not known). */
  prev_episode: EpisodeNumber | null;
  /** A series only: the episode after this one, or null (the last one aired, a film, or not known). */
  next_episode: EpisodeNumber | null;
  created_at: string;
  refreshed_at: string;
  expires_at: string;
}

/** What `play` answers (JSON-ready; the route adds `ok: true`). */
export interface PlayResult {
  page_url: string;
  session: SessionInfo;
  attempts: ResolveAttempt[];
}

export interface SyncSeedResult {
  total: number;
  inserted: number;
  updated: number;
}

export interface DirectStreamServiceOptions {
  repo: DirectStreamRepo;
  runner: DirectStreamRunner;
  /** os.hostname() (the movies service's host): health rows are written under it. */
  host: string;
  seedFile: string;
  /** The anime embeds' seed; null or unset loads none (tests that count the provider seed's rows). */
  animeSeedFile?: string | null;
  /** The daemon's origin as the streaming Chrome reaches it, e.g. `http://localhost:7317`. Read at play time. */
  pageBase: () => string;
  hooks?: DirectStreamHooks;
  sessions?: SessionStore;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isHealthOutcome(outcome: ResolveOutcome): outcome is StreamHealthOutcome {
  return (STREAM_HEALTH_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * Direct streaming on this host: the registry, resolves through the resolver CLI, sessions and the
 * pass-through. Every resolve and every `open` runs one at a time, since they share the one streaming
 * Chrome. Held in AppDeps.directStream; the routes (src/http/directStreamApi.ts) and the tools
 * (phase 7, 8) call it.
 */
export class DirectStreamService {
  private readonly repo: DirectStreamRepo;
  private readonly runner: DirectStreamRunner;
  private readonly sessions: SessionStore;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: FetchLike;
  private chain: Promise<void> = Promise.resolve();
  /** The running /update-cloud-source, if any: one at a time through the one streaming Chrome. */
  private updatingSource: Promise<UpdateSourceAnswer> | null = null;

  constructor(private readonly opts: DirectStreamServiceOptions) {
    this.repo = opts.repo;
    this.runner = opts.runner;
    this.now = opts.now ?? (() => new Date());
    this.sessions = opts.sessions ?? new SessionStore(this.now);
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  get host(): string {
    return this.opts.host;
  }

  /** Loads the seed file into the shared registry (insert missing, update changed seed rows). */
  async syncSeed(): Promise<SyncSeedResult> {
    const animeFile = this.opts.animeSeedFile ?? null;
    const entries = [...(await readSeedFile(this.opts.seedFile)), ...(animeFile === null ? [] : await readSeedFile(animeFile))];
    const { inserted, updated } = await this.repo.syncSeed(entries, this.now());
    return { total: entries.length, inserted, updated };
  }

  /**
   * Resolves the title and makes a session for it. Throws `no_source` (every attempt in `attempts`) or
   * `resolve_failed` (with `reason`; `deadline` when `deadlineS` cut it short). The recordResolve hook
   * has run before this returns or throws.
   */
  async resolve(input: StreamRefInput, options: { resumeS?: number | null; deadlineS?: number } = {}): Promise<StreamSession> {
    const ref = toStreamRef(input);
    const out = await this.resolveSource(ref, options.deadlineS);
    let resumeS = options.resumeS ?? null;
    const hook = this.opts.hooks?.resumeS;
    if (resumeS === null && hook !== undefined) resumeS = await this.hookValue('resumeS', () => hook(ref));
    return this.sessions.create(ref, out.source, out.attempts, resumeS, await this.audioLang(ref));
  }

  /** Resolves, then opens this daemon's player page for the session full screen in the streaming Chrome. */
  async play(input: StreamRefInput, options: { resumeS?: number | null } = {}): Promise<PlayResult> {
    const session = await this.resolve(input, options);
    const pageUrl = `${this.opts.pageBase()}/stream/${session.id}`;
    const opened = await this.serial(async (): Promise<OpenOutput> => {
      try {
        return parseOpenOutput(await this.runner(['open', pageUrl, '--fullscreen']));
      } catch (err) {
        return { ok: false, error: 'script_failed', detail: messageOf(err) };
      }
    });
    if (!opened.ok) {
      throw new DirectStreamError('open_failed', `The player page could not be opened in the streaming Chrome: ${opened.detail || opened.error}`, {
        reason: opened.error,
        sessionId: session.id,
        pageUrl,
        attempts: session.attempts,
      });
    }
    this.log(`[notesd] direct stream: playing ${refLabel(session.ref)} from ${session.source.provider}`);
    return { page_url: pageUrl, session: await this.sessionInfo(session), attempts: session.attempts };
  }

  /** The live session, or null for an unknown or ended id. Marks it used. */
  session(id: string): StreamSession | null {
    return this.sessions.get(id);
  }

  /** What the player page reads, or null for an unknown or ended id. */
  async info(id: string): Promise<SessionInfo | null> {
    const session = this.sessions.get(id);
    return session === null ? null : this.sessionInfo(session);
  }

  /** Resolves the session's title again (a token expired) and keeps the same id. A failure leaves the session as it was. */
  async refresh(id: string): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const out = await this.resolveSource(session.ref);
    this.sessions.replaceSource(session, out.source, out.attempts);
    return this.sessionInfo(session);
  }

  /**
   * The player's previous / next button: resolves the neighbouring episode of the session's and
   * makes a new session for it (the old one is left to expire; the page reports it closed). Throws
   * `unknown_session`, `no_episode` (a film, or no episode on that side), or what `resolve` throws.
   */
  async switchEpisode(id: string, to: 'prev' | 'next'): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const target = (await this.neighborsOf(session.ref))[to];
    if (target === null || session.ref.kind !== 'tv') {
      throw new DirectStreamError('no_episode', to === 'next' ? 'There is no next episode to stream.' : 'There is no previous episode.');
    }
    const next = await this.resolve({ kind: 'tv', tmdbId: session.ref.tmdbId, season: target.season, episode: target.episode });
    this.log(`[notesd] direct stream: ${refLabel(session.ref)} -> ${refLabel(next.ref)} (${to} episode) from ${next.source.provider}`);
    return this.sessionInfo(next);
  }

  /** GET /api/stream/sessions/:id/p: 403 `unknown_session` before anything else, then forward(). */
  async passThrough(id: string, req: ForwardRequest): Promise<Response> {
    const session = this.sessions.get(id);
    if (session === null) return jsonError(403, 'unknown_session', 'That stream session is unknown or has ended.');
    return forward(session, req, this.fetchImpl);
  }

  /** Every provider with this host's health. */
  async providers(): Promise<ProviderView[]> {
    const [rows, health] = await Promise.all([this.repo.providers(), this.repo.healthFor(this.host)]);
    const byName = new Map(health.map((h) => [h.name, h]));
    return rows.map((row) => providerView(row, byName.get(row.name) ?? null));
  }

  /**
   * One resolver run: writes the registry and this host's health to the files `resolve` reads, runs it
   * (one at a time), and records each provider's outcome for this host. Never throws for a failed
   * resolve: `{ok: false}` names why (`no_source`, or `script_failed` / `bad_output` / the resolver's
   * error). Does not call the recordResolve hook. Phase 8 probes one provider with `{ only }`;
   * `deadlineS` becomes the resolver's `--deadline-s` (phase 10's per-pass budget).
   */
  async runResolve(ref: StreamRef, options: { only?: string; deadlineS?: number } = {}): Promise<ResolveOutput> {
    const audioLang = await this.audioLang(ref);
    const anime = await this.animeRef(ref);
    return this.serial(async () => {
      const providers = await this.repo.providers();
      const health = await this.repo.healthFor(this.host);
      const dir = await mkdtemp(path.join(tmpdir(), 'notesd-direct-'));
      let out: ResolveOutput;
      try {
        const providersFile = path.join(dir, 'providers.json');
        const healthFile = path.join(dir, 'health.json');
        await writeFile(providersFile, JSON.stringify(providers.map(providerSeedJson)));
        await writeFile(healthFile, JSON.stringify(healthMap(health)));
        const args = [
          'resolve',
          ref.kind,
          String(ref.tmdbId),
          ...(ref.kind === 'tv' ? [String(ref.season), String(ref.episode)] : []),
          ...(options.only !== undefined ? ['--only', options.only] : []),
          ...(options.deadlineS !== undefined ? ['--deadline-s', String(Math.max(1, Math.floor(options.deadlineS)))] : []),
          ...(audioLang !== null ? ['--audio-lang', audioLang] : []),
          ...(anime !== null ? ['--anime', `${anime.id}:${anime.episode}`] : []),
          '--providers',
          providersFile,
          '--health',
          healthFile,
        ];
        try {
          out = parseResolveOutput(await this.runner(args));
        } catch (err) {
          const reason = err instanceof DirectStreamError ? (err.reason ?? 'bad_output') : 'script_failed';
          out = { ok: false, source: null, error: reason, detail: messageOf(err), attempts: [] };
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      await this.recordHealth(out, new Set(providers.map((p) => p.name)));
      this.log(
        out.ok
          ? `[notesd] direct stream: ${refLabel(ref)} resolved by ${out.source.provider} (${out.source.manifest_kind}${out.source.best_height === null ? '' : `, ${out.source.best_height}p`}) after ${out.attempts.length} tries`
          : `[notesd] direct stream: ${refLabel(ref)} did not resolve: ${out.error}${out.detail === '' ? '' : ` (${out.detail})`}`,
      );
      return out;
    });
  }

  /**
   * /update-cloud-source: reads a site's provider templates (scripts first; the frames of a watch
   * page in the streaming Chrome when the scripts hold none), adds the providers the registry
   * lacks and probes each against the known titles (resolve --only, health recorded for this
   * host). The probes open tabs in the streaming Chrome out of sight; nothing plays. A failed
   * probe marks no title stale: it goes through runResolve, not resolve().
   */
  async updateSource(site: string, pages: WatchPages = {}): Promise<UpdateSourceAnswer> {
    if (this.updatingSource !== null) {
      return { ok: false, site, error: 'busy', detail: 'another /update-cloud-source is still probing; ask again when it has answered', registry_changed: false };
    }
    const running = updateSource(site, {
      runner: this.runner,
      registry: {
        list: () => this.repo.providers(),
        insert: (rows) => this.repo.insertProviders(rows),
      },
      knownTitles: () => loadKnownTitles(),
      probe: async (provider, title) => {
        try {
          return toProbeResult(title, provider, await this.runResolve(title.ref, { only: provider }));
        } catch (err) {
          return { title: title.label, outcome: 'error', took_s: null, manifest_kind: null, best_height: null, en_subtitle: null, detail: err instanceof Error ? err.message : String(err) };
        }
      },
    }, pages);
    this.updatingSource = running;
    try {
      return await running;
    } finally {
      this.updatingSource = null;
    }
  }

  /** runResolve, then the recordResolve hook, then a typed failure. */
  private async resolveSource(ref: StreamRef, deadlineS?: number): Promise<ResolvedOutput> {
    const out = await this.runResolve(ref, deadlineS === undefined ? {} : { deadlineS });
    const hook = this.opts.hooks?.recordResolve;
    if (hook !== undefined) {
      try {
        await hook(ref, out);
      } catch (err) {
        this.log(`[notesd] direct stream: the recordResolve hook failed: ${messageOf(err)}`);
      }
    }
    if (out.ok) return out;
    if (out.error === 'no_source') {
      throw new DirectStreamError('no_source', `No provider could stream ${refLabel(ref)}.`, { attempts: out.attempts });
    }
    throw new DirectStreamError('resolve_failed', out.detail === '' ? `The resolve could not run: ${out.error}.` : out.detail, {
      reason: out.error,
      attempts: out.attempts,
    });
  }

  /** The originalLanguage hook's answer when it is a plain language code; else null (the resolver is then not asked to check). */
  private async audioLang(ref: StreamRef): Promise<string | null> {
    const hook = this.opts.hooks?.originalLanguage;
    if (hook === undefined) return null;
    const language = await this.hookValue('originalLanguage', () => hook(ref));
    return language !== null && /^[A-Za-z]{2,3}$/.test(language) ? language.toLowerCase() : null;
  }

  private async neighborsOf(ref: StreamRef): Promise<EpisodeNeighbors> {
    const hook = this.opts.hooks?.neighbors;
    if (ref.kind !== 'tv' || hook === undefined) return { prev: null, next: null };
    return (await this.hookValue('neighbors', () => hook(ref))) ?? { prev: null, next: null };
  }

  private async animeRef(ref: StreamRef): Promise<AnimeRef | null> {
    const hook = this.opts.hooks?.anime;
    if (hook === undefined) return null;
    const anime = await this.hookValue('anime', () => hook(ref));
    return anime !== null && Number.isSafeInteger(anime.id) && anime.id > 0 && Number.isSafeInteger(anime.episode) && anime.episode > 0 ? anime : null;
  }

  private async recordHealth(out: ResolveOutput, known: ReadonlySet<string>): Promise<void> {
    const rows: HealthAttempt[] = [];
    for (const a of out.attempts) {
      if (!isHealthOutcome(a.outcome) || !known.has(a.provider)) continue;
      const source = out.ok && a.outcome === 'resolved' && a.provider === out.source.provider ? out.source : null;
      rows.push({ provider: a.provider, outcome: a.outcome, took_s: a.took_s, detail: a.detail, source });
    }
    try {
      await this.repo.recordAttempts(this.host, rows, this.now());
    } catch (err) {
      this.log(`[notesd] direct stream: could not record provider health: ${messageOf(err)}`);
    }
  }

  private async sessionInfo(session: StreamSession): Promise<SessionInfo> {
    const { ref, source } = session;
    const titleHook = this.opts.hooks?.titleLabel;
    const title = (titleHook === undefined ? null : await this.hookValue('titleLabel', () => titleHook(ref))) ?? refLabel(ref);
    const neighbors = await this.neighborsOf(ref);
    return {
      session_id: session.id,
      kind: ref.kind,
      tmdb_id: ref.tmdbId,
      season: ref.kind === 'tv' ? ref.season : null,
      episode: ref.kind === 'tv' ? ref.episode : null,
      title,
      provider: source.provider,
      manifest_kind: source.manifest_kind,
      manifest_url: proxiedUrl(session.id, source.manifest_url),
      subtitles: source.subtitles.map((t) => {
        const srt = t.format === 'srt' || /\.srt$/i.test(new URL(t.url).pathname);
        return {
          url: proxiedUrl(session.id, t.url, { vtt: srt }),
          lang: t.lang,
          label: t.label,
          format: srt ? 'vtt' : t.format,
          source: t.source,
          english: isEnglish(t),
        };
      }),
      best_height: source.best_height,
      audio_lang: session.audioLang,
      audio: source.audio ?? null,
      resume_s: session.resumeS,
      prev_episode: neighbors.prev,
      next_episode: neighbors.next,
      created_at: session.createdAt.toISOString(),
      refreshed_at: session.refreshedAt.toISOString(),
      expires_at: this.sessions.expiresAt(session).toISOString(),
    };
  }

  private async hookValue<T>(name: string, call: () => Promise<T | null>): Promise<T | null> {
    try {
      return await call();
    } catch (err) {
      this.log(`[notesd] direct stream: the ${name} hook failed: ${messageOf(err)}`);
      return null;
    }
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export interface DirectStreamWiring {
  /** The movies service (only its host is read; direct streaming needs movies on). Null: movies off. */
  movies: { readonly host: string } | null;
  /** The daemon's origin as the streaming Chrome reaches it; the port is known only after listen. */
  pageBase: () => string;
  /** Phase 5's movie-store hooks. */
  hooks?: DirectStreamHooks;
}

/** Test seams. */
export interface DirectStreamOverrides {
  runner?: DirectStreamRunner;
  seedFile?: string;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's direct-stream service, or null (nothing built, nothing can start Chrome) when
 * NOTESD_DIRECT_STREAM is off or unset in the config, NOTESD_MOVIES is off, or there is no movies service.
 */
export function buildDirectStreamService(
  config: Config,
  db: Db,
  wiring: DirectStreamWiring,
  overrides: DirectStreamOverrides = {},
): DirectStreamService | null {
  const ds = config.directStream;
  if (ds === undefined || !ds.enabled || !config.movies.enabled || wiring.movies === null) return null;
  return new DirectStreamService({
    repo: new DirectStreamRepo(db),
    runner: overrides.runner ?? directStreamScriptRunner({ cliPath: ds.cli }),
    host: wiring.movies.host,
    seedFile: overrides.seedFile ?? DEFAULT_SEED_FILE,
    // A caller that names its own seed (a test) gets exactly that file's providers.
    animeSeedFile: overrides.seedFile === undefined ? DEFAULT_ANIME_SEED_FILE : null,
    pageBase: wiring.pageBase,
    hooks: wiring.hooks,
    fetch: overrides.fetch,
    now: overrides.now,
    log: overrides.log,
  });
}
