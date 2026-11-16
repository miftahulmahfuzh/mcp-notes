import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, type Config } from '../config.js';
import { STREAM_HEALTH_OUTCOMES, type StreamHealthOutcome } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { AnimeRef } from './anime.js';
import { CACHE_ID_PATTERN, CachePlayError, cacheRefusalError, cacheSource, playable, type CachePlayView, type CacheStanding, type PlayableCaches, type SessionCache } from './cachePlay.js';
import { DIALOGUE_MIN_CUES, parseCues, playlistTarget } from './dialogue.js';
import { deliveryByProvider, type Delivery } from './delivery.js';
import { forward, jsonError, type FetchLike, type ForwardRequest } from './passThrough.js';
import { observeForward, refusedRecord, safeRecord, sessionRecord, sessionSource, type EvidenceSink, type SessionSource } from './evidence.js';
import { DirectStreamRepo, healthMap, providerSeedJson, providerView, readSeedFile, type HealthAttempt, type ProviderView } from './repo.js';
import { proxiedUrl } from './rewrite.js';
import { directStreamScriptRunner, parseOpenOutput, parseResolveOutput, type DirectStreamRunner, type OpenOutput } from './runner.js';
import { SESSION_ID_PATTERN, SessionStore, type StreamSession } from './sessions.js';
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

/** One subtitle file or segment must answer within this. */
const SUBTITLE_TIMEOUT_MS = 30_000;
/** A subtitle playlist is read up to this many segments (a film in 6 s segments has about 1,200). */
const SUBTITLE_MAX_SEGMENTS = 1_500;
const SUBTITLE_PARALLEL = 8;

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
  /**
   * The stream cache on this host the session plays from (phase 6): `ready` (all on disk; nothing
   * was resolved) or `downloading` (missing segments are fetched by the cache's file route). Then
   * `manifest_url` and each subtitle `url` are that file route's addresses. Null: through the pass-through.
   */
  cached: { id: string; state: SessionCache['state']; height: number | null } | null;
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
  /** This host's stream evidence log (evidence.ts): every pass-through answer and session change is recorded into it. Null or unset: nothing is recorded. */
  evidence?: EvidenceSink | null;
  /**
   * This host's stream cache (phase 5's StreamCache, AppDeps.streamCache), read at play time
   * because it is built after this service. Unset or null: no cache, every play resolves.
   */
  caches?: () => PlayableCaches | null;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isHealthOutcome(outcome: ResolveOutcome): outcome is StreamHealthOutcome {
  return (STREAM_HEALTH_OUTCOMES as readonly string[]).includes(outcome);
}

/** A provider nothing has resolved yet, for a delivery verdict that outlived its health row. */
const NO_HEALTH = { en_subtitle: null, best_height: null, median_s: null, last_success_at: null, last_failure_at: null, consecutive_failures: 0 } as const;

/** cacheSession's answer: the session as it is now, whether this call moved it onto the cache, and where the download stands. */
export interface CacheSessionAnswer {
  moved: boolean;
  cache: CacheStanding | null;
  session: SessionInfo;
}

/** switchSource's answer: the session as it is now, and whether it moved to another provider. */
export interface SwitchSourceAnswer {
  switched: boolean;
  reason: 'cached' | 'no_other_source' | null;
  /** The provider the player was on when it asked. */
  from: string;
  session: SessionInfo;
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
  private readonly evidence: EvidenceSink | null;
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
    this.evidence = opts.evidence ?? null;
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
   * has run before this returns or throws. Always resolves: a cache is `play`'s business, and
   * `subtitleText` needs a resolved source.
   */
  async resolve(input: StreamRefInput, options: { resumeS?: number | null; deadlineS?: number } = {}): Promise<StreamSession> {
    const ref = toStreamRef(input);
    const out = await this.resolveSource(ref, options.deadlineS);
    const resumeS = await this.startAt(ref, options.resumeS ?? null);
    const session = this.sessions.create(ref, out.source, out.attempts, resumeS, await this.audioLang(ref));
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /**
   * Opens this daemon's player page for the title full screen in the streaming Chrome. This host's
   * cache of the title (phase 5), when it can be played (`playable`), makes the session with no
   * resolve; otherwise the title is resolved first, as before.
   */
  async play(input: StreamRefInput, options: { resumeS?: number | null } = {}): Promise<PlayResult> {
    const ref = toStreamRef(input);
    const session = (await this.cachedSession(ref, options.resumeS ?? null)) ?? (await this.resolve(ref, options));
    return this.openPage(session);
  }

  /**
   * POST /api/stream/cache/:id/play: plays one cache by its id, with no resolve. Throws
   * CachePlayError `unknown_cache`, `not_on_this_machine` (with the host that holds it),
   * `cache_failed` or `cache_language`; then `open_failed` as `play` does.
   */
  async playCache(cacheId: string, options: { resumeS?: number | null } = {}): Promise<PlayResult> {
    const caches = this.opts.caches?.() ?? null;
    const view = caches === null || !CACHE_ID_PATTERN.test(cacheId) ? null : await caches.get(cacheId);
    if (view === null) throw new CachePlayError('unknown_cache', 'There is no stream cache with that id.');
    const audioLang = await this.audioLang(view.ref);
    const check = playable(view, this.host, audioLang);
    if (!check.ok) throw cacheRefusalError(view, check.refusal, audioLang);
    return this.openPage(await this.sessionFromCache(view, check.cache, options.resumeS ?? null, audioLang));
  }

  /** Opens the session's player page full screen in the streaming Chrome (one at a time, like every resolve). */
  private async openPage(session: StreamSession): Promise<PlayResult> {
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
    this.log(
      session.cache === null
        ? `[notesd] direct stream: playing ${refLabel(session.ref)} from ${session.source.provider}`
        : `[notesd] direct stream: playing ${refLabel(session.ref)} from the cache ${session.cache.id} (${session.cache.state}, ${session.source.provider})`,
    );
    return { page_url: pageUrl, session: await this.sessionInfo(session), attempts: session.attempts };
  }

  /**
   * A session on this host's cache of `ref`, or null: no cache wiring, no cache, one that cannot be
   * played (another host's, failed, another language), or the lookup failed. A null makes the play
   * resolve; the cache never fails a play.
   */
  private async cachedSession(ref: StreamRef, resumeS: number | null): Promise<StreamSession | null> {
    const caches = this.opts.caches?.() ?? null;
    if (caches === null) return null;
    let view: CachePlayView | null;
    try {
      view = await caches.find(ref);
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the stream cache of ${refLabel(ref)}: ${messageOf(err)}`);
      return null;
    }
    if (view === null) return null;
    const audioLang = await this.audioLang(ref);
    const check = playable(view, this.host, audioLang);
    if (!check.ok) {
      if (check.refusal !== 'other_host') this.log(`[notesd] direct stream: the cache ${view.id} of ${refLabel(ref)} is not played (${check.refusal})`);
      return null;
    }
    return this.sessionFromCache(view, check.cache, resumeS, audioLang);
  }

  private async sessionFromCache(view: CachePlayView, cache: SessionCache, resumeS: number | null, audioLang: string | null): Promise<StreamSession> {
    const session = this.sessions.create(view.ref, cacheSource(view), [], await this.startAt(view.ref, resumeS), audioLang ?? view.audioLang, cache);
    // Made without resolve(): phase 1's `created` record is written here, so a snapshot of a cached play has a source line.
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /** One cache by id, or null (none, no cache wiring, or the lookup failed). */
  private async cacheById(id: string): Promise<CachePlayView | null> {
    const caches = this.opts.caches?.() ?? null;
    if (caches === null) return null;
    try {
      return await caches.get(id);
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the stream cache ${id}: ${messageOf(err)}`);
      return null;
    }
  }

  /** Where a new session starts: the asked position, else the resumeS hook's, else null. */
  private async startAt(ref: StreamRef, resumeS: number | null): Promise<number | null> {
    const hook = this.opts.hooks?.resumeS;
    if (resumeS !== null || hook === undefined) return resumeS;
    return this.hookValue('resumeS', () => hook(ref));
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

  /**
   * The player's refresh (a token expired) under the same id. A session on a cache that can still be
   * played keeps it and resolves nothing (its state is read again: a download may have finished);
   * once the cache is gone, failed or unreadable, the title is resolved and the session goes on
   * through the pass-through. A failed resolve leaves the session as it was.
   */
  async refresh(id: string): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    if (session.cache !== null) {
      const view = await this.cacheById(session.cache.id);
      const check = view === null ? null : playable(view, this.host, session.audioLang);
      if (check !== null && check.ok) {
        this.sessions.useCache(session, check.cache);
        return this.sessionInfo(session);
      }
      this.log(`[notesd] direct stream: the cache ${session.cache.id} of ${refLabel(session.ref)} can no longer be played (${check === null ? 'gone' : check.refusal}); resolving`);
    }
    let out: ResolvedOutput;
    try {
      out = await this.resolveSource(session.ref, undefined, session.avoid);
    } catch (err) {
      safeRecord(this.evidence, sessionRecord(session, 'refresh_failed', err instanceof DirectStreamError ? `${err.code}: ${err.message}` : messageOf(err)));
      throw err;
    }
    this.sessions.replaceSource(session, out.source, out.attempts);
    safeRecord(this.evidence, sessionRecord(session, 'refreshed', null));
    return this.sessionInfo(session);
  }

  /**
   * The player page was paused: download the session's title to this host's cache, and once the
   * cache knows its source, move the session onto it under the same id, so the film plays from the
   * local files (those on disk at once, the rest fetched as it reaches them) and the page can show
   * what is on disk. `start` begins the download (or carries a failed one on); without it the call
   * only looks, which is what the page's polls do. `moved` says the session plays from the cache
   * now; `cache` is where the download stands (null: this daemon caches nothing). A cache made for
   * another language, or one that failed, is never played. Throws `unknown_session`.
   */
  async cacheSession(id: string, options: { start: boolean }): Promise<CacheSessionAnswer> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const caches = this.opts.caches?.() ?? null;
    const answer = async (moved: boolean, cache: CacheStanding | null): Promise<CacheSessionAnswer> => ({ moved, cache, session: await this.sessionInfo(session) });
    if (caches === null || caches.start === undefined || caches.standing === undefined) return answer(false, null);
    let standing: CacheStanding | null;
    try {
      standing = session.cache === null && options.start ? await caches.start(session.ref) : await caches.standing(session.ref);
    } catch (err) {
      this.log(`[notesd] direct stream: could not cache ${refLabel(session.ref)} for its paused play: ${messageOf(err)}`);
      return answer(false, null);
    }
    if (standing === null || standing.state === 'failed') return answer(false, standing);
    const view = await this.cacheById(standing.id);
    const check = view === null ? null : playable(view, this.host, session.audioLang);
    if (view === null || check === null || !check.ok) return answer(false, standing);
    if (session.cache !== null) {
      // Already on it: only its state is read again (the download may have finished).
      if (session.cache.id === view.id) this.sessions.useCache(session, check.cache);
      return answer(false, standing);
    }
    session.source = cacheSource(view);
    session.attempts = [];
    session.allowedHosts = new Set();
    this.sessions.useCache(session, check.cache);
    safeRecord(this.evidence, sessionRecord(session, 'cached', null));
    this.log(`[notesd] direct stream: ${refLabel(session.ref)} now plays from the cache ${view.id} (${check.cache.state})`);
    return answer(true, standing);
  }

  /**
   * The player says the stream keeps stalling: move the session to another provider under the same
   * id. The title is resolved again without the provider it plays from (and those it left before);
   * when one answers, the session takes its source and never goes back. `switched: false` leaves the
   * session as it was: `cached` (a cache has no provider to leave) or `no_other_source`. The
   * recordResolve hook runs only for a resolve that found a source, so a title whose other providers
   * all failed is not marked stale while it plays. Throws `unknown_session`.
   */
  async switchSource(id: string): Promise<SwitchSourceAnswer> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    if (session.cache !== null) return { switched: false, reason: 'cached', from: session.source.provider, session: await this.sessionInfo(session) };
    const from = session.source.provider;
    const out = await this.runResolve(session.ref, { skip: [...session.avoid, from] });
    if (!out.ok) {
      this.log(`[notesd] direct stream: ${refLabel(session.ref)} stalls on ${from} and no other provider answered (${out.error})`);
      return { switched: false, reason: 'no_other_source', from, session: await this.sessionInfo(session) };
    }
    const hook = this.opts.hooks?.recordResolve;
    if (hook !== undefined) {
      try {
        await hook(session.ref, out);
      } catch (err) {
        this.log(`[notesd] direct stream: the recordResolve hook failed: ${messageOf(err)}`);
      }
    }
    session.avoid.push(from);
    this.sessions.replaceSource(session, out.source, out.attempts);
    safeRecord(this.evidence, sessionRecord(session, 'switched', null));
    this.log(`[notesd] direct stream: ${refLabel(session.ref)} moved from ${from} to ${out.source.provider} (the stream stalled)`);
    return { switched: true, reason: null, from, session: await this.sessionInfo(session) };
  }

  /**
   * The player's previous / next button: a new session for the neighbouring episode of the session's
   * (the old one is left to expire; the page reports it closed), from that episode's cache on this
   * host when it can be played, else resolved. Throws `unknown_session`, `no_episode` (a film, or no
   * episode on that side), or what `resolve` throws.
   */
  async switchEpisode(id: string, to: 'prev' | 'next'): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const target = (await this.neighborsOf(session.ref))[to];
    if (target === null || session.ref.kind !== 'tv') {
      throw new DirectStreamError('no_episode', to === 'next' ? 'There is no next episode to stream.' : 'There is no previous episode.');
    }
    const ref: StreamRef = { kind: 'tv', tmdbId: session.ref.tmdbId, season: target.season, episode: target.episode };
    const next = (await this.cachedSession(ref, null)) ?? (await this.resolve(ref));
    this.log(
      `[notesd] direct stream: ${refLabel(session.ref)} -> ${refLabel(next.ref)} (${to} episode) ${next.cache === null ? `from ${next.source.provider}` : `from the cache ${next.cache.id}`}`,
    );
    return this.sessionInfo(next);
  }

  /**
   * The text of the title's English subtitle, for its dialogue (dialogue.ts). Resolves the title
   * like a play does, out of sight, and opens no player: then reads the first English track that
   * holds cues, through the same pass-through rules as the player (the session's hosts, the
   * captured headers). A separate file is tried before a track inside the manifest. Throws what
   * `resolve` throws, or `no_subtitle` when the source that resolved has no English track that
   * can be read.
   */
  async subtitleText(input: StreamRefInput): Promise<{ provider: string; label: string; vtt: string; attempts: ResolveAttempt[] }> {
    const session = await this.resolve(input);
    const english = session.source.subtitles.filter((t) => isEnglish(t));
    const tracks = [...english.filter((t) => t.source === 'request'), ...english.filter((t) => t.source !== 'request')];
    for (const track of tracks) {
      const vtt = await this.readSubtitle(session, track.url, track.format).catch(() => null);
      if (vtt !== null && parseCues(vtt).length >= DIALOGUE_MIN_CUES) {
        return { provider: session.source.provider, label: track.label, vtt, attempts: session.attempts };
      }
    }
    throw new DirectStreamError(
      'no_subtitle',
      tracks.length === 0
        ? `${session.source.provider} streams ${refLabel(session.ref)} without an English subtitle.`
        : `${session.source.provider} names an English subtitle for ${refLabel(session.ref)}, but it could not be read.`,
      { attempts: session.attempts },
    );
  }

  /** One subtitle track as WebVTT text: a file, or the segments of an HLS subtitle playlist joined. Null when the host refuses it. */
  private async readSubtitle(session: StreamSession, url: string, format: string): Promise<string | null> {
    const get = async (target: string, vtt: boolean): Promise<string | null> => {
      const res = await forward(session, { target, range: null, vtt, signal: AbortSignal.timeout(SUBTITLE_TIMEOUT_MS) }, this.fetchImpl);
      return res.ok ? res.text() : null;
    };
    if (format !== 'hls') return get(url, true);
    // The pass-through answers a playlist with every address pointing back at itself.
    const playlist = await get(url, false);
    if (playlist === null) return null;
    const targets = playlist.split('\n').flatMap((line) => playlistTarget(line) ?? []).slice(0, SUBTITLE_MAX_SEGMENTS);
    const parts: string[] = [];
    for (let i = 0; i < targets.length; i += SUBTITLE_PARALLEL) {
      parts.push(...(await Promise.all(targets.slice(i, i + SUBTITLE_PARALLEL).map((target) => get(target, true).catch(() => null)))).flatMap((text) => text ?? []));
    }
    return parts.length === 0 ? null : parts.join('\n\n');
  }

  /**
   * GET /api/stream/sessions/:id/p: 403 `unknown_session` before anything else, then forward(),
   * observed for the evidence log (one record per answer, written when its body ends).
   */
  async passThrough(id: string, req: ForwardRequest): Promise<Response> {
    const session = this.sessions.get(id);
    if (session === null) {
      // A well-formed id the daemon no longer holds is evidence too ("the session ended").
      if (SESSION_ID_PATTERN.test(id)) safeRecord(this.evidence, refusedRecord(id, req, 403, 'unknown_session'));
      return jsonError(403, 'unknown_session', 'That stream session is unknown or has ended.');
    }
    return observeForward(session, req, this.fetchImpl, this.evidence);
  }

  /** A snapshot's view of a live session (no header value, no query); null when it ended. Does not mark it used. */
  evidenceSource(id: string): SessionSource | null {
    const session = this.sessions.peek(id);
    return session === null ? null : sessionSource(session, this.sessions.expiresAt(session));
  }

  /** Every provider with this host's health. */
  async providers(): Promise<ProviderView[]> {
    const [rows, health, delivery] = await Promise.all([this.repo.providers(), this.repo.healthFor(this.host), this.delivery()]);
    const byName = new Map(health.map((h) => [h.name, h]));
    return rows.map((row) => ({ ...providerView(row, byName.get(row.name) ?? null), delivery: delivery.get(row.name) ?? null }));
  }

  /**
   * Each provider's delivery on this host, from the evidence log (delivery.ts). Empty without a log
   * that can be read, or when reading it fails: delivery only orders providers, it never fails a resolve.
   */
  async delivery(): Promise<Map<string, Delivery>> {
    const recent = this.evidence?.recent;
    if (recent === undefined) return new Map();
    try {
      return deliveryByProvider(await recent.call(this.evidence), this.now().getTime());
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the evidence log for the providers' delivery: ${messageOf(err)}`);
      return new Map();
    }
  }

  /**
   * One resolver run: writes the registry and this host's health to the files `resolve` reads, runs it
   * (one at a time), and records each provider's outcome for this host. Never throws for a failed
   * resolve: `{ok: false}` names why (`no_source`, or `script_failed` / `bad_output` / the resolver's
   * error). Does not call the recordResolve hook. Phase 8 probes one provider with `{ only }`;
   * `deadlineS` becomes the resolver's `--deadline-s` (phase 10's per-pass budget). `skip` names
   * providers the resolver must not try (a session that left them, switchSource). The health file
   * also carries each provider's delivery, which the resolver's order puts before its resolve health.
   */
  async runResolve(ref: StreamRef, options: { only?: string; deadlineS?: number; skip?: readonly string[] } = {}): Promise<ResolveOutput> {
    const audioLang = await this.audioLang(ref);
    const anime = await this.animeRef(ref);
    return this.serial(async () => {
      const providers = await this.repo.providers();
      const health = await this.repo.healthFor(this.host);
      const healthJson = healthMap(health);
      for (const [name, delivery] of await this.delivery()) {
        healthJson[name] = { ...(healthJson[name] ?? NO_HEALTH), delivery: delivery.verdict };
      }
      const skip = (options.skip ?? []).filter((name) => name !== '' && !name.includes(','));
      const dir = await mkdtemp(path.join(tmpdir(), 'notesd-direct-'));
      let out: ResolveOutput;
      try {
        const providersFile = path.join(dir, 'providers.json');
        const healthFile = path.join(dir, 'health.json');
        await writeFile(providersFile, JSON.stringify(providers.map(providerSeedJson)));
        await writeFile(healthFile, JSON.stringify(healthJson));
        const args = [
          'resolve',
          ref.kind,
          String(ref.tmdbId),
          ...(ref.kind === 'tv' ? [String(ref.season), String(ref.episode)] : []),
          ...(options.only !== undefined ? ['--only', options.only] : []),
          ...(skip.length > 0 ? ['--skip', skip.join(',')] : []),
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
  private async resolveSource(ref: StreamRef, deadlineS?: number, skip: readonly string[] = []): Promise<ResolvedOutput> {
    const out = await this.runResolve(ref, { ...(deadlineS === undefined ? {} : { deadlineS }), skip });
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
    const { ref, source, cache } = session;
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
      // A cache's files come from its own route on this daemon, never through the pass-through.
      manifest_url: cache === null ? proxiedUrl(session.id, source.manifest_url) : cache.manifestUrl,
      subtitles:
        cache === null
          ? source.subtitles.map((t) => {
              const srt = t.format === 'srt' || /\.srt$/i.test(new URL(t.url).pathname);
              return {
                url: proxiedUrl(session.id, t.url, { vtt: srt }),
                lang: t.lang,
                label: t.label,
                format: srt ? 'vtt' : t.format,
                source: t.source,
                english: isEnglish(t),
              };
            })
          : cache.subtitles.map((t) => ({ url: t.url, lang: t.lang, label: t.label, format: 'vtt', source: 'request' as const, english: isEnglish(t) })),
      best_height: source.best_height,
      audio_lang: session.audioLang,
      audio: source.audio ?? null,
      resume_s: session.resumeS,
      prev_episode: neighbors.prev,
      next_episode: neighbors.next,
      created_at: session.createdAt.toISOString(),
      refreshed_at: session.refreshedAt.toISOString(),
      expires_at: this.sessions.expiresAt(session).toISOString(),
      cached: cache === null ? null : { id: cache.id, state: cache.state, height: cache.height },
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
  /** This host's stream evidence log; null or unset records nothing. */
  evidence?: EvidenceSink | null;
  /** Phase 6: this host's stream cache, read at play time (phase 5 builds it after this service). */
  caches?: () => PlayableCaches | null;
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
    evidence: wiring.evidence ?? null,
    caches: wiring.caches,
    fetch: overrides.fetch,
    now: overrides.now,
    log: overrides.log,
  });
}
