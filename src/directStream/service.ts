import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, type Config } from '../config.js';
import { STREAM_HEALTH_OUTCOMES, type StreamHealthOutcome } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { EpisodeAhead } from './ahead.js';
import type { AnimeRef } from './anime.js';
import { CACHE_ID_PATTERN, CachePlayError, cacheRefusalError, cacheSource, playable, type CachePlayView, type CacheStanding, type CacheSubtitleView, type PlayableCaches, type SessionCache } from './cachePlay.js';
import { DIALOGUE_MIN_CUES, parseCues, playlistTarget } from './dialogue.js';
import { deliveryByProvider, type Delivery } from './delivery.js';
import { passesOver, type PictureCheck } from './picture.js';
import { passesOverAudio, type AudioLangCheck } from './audioLang.js';
import { normalizeAudioLang } from './torrent/probe.js';
import { forward, jsonError, type FetchLike, type ForwardRequest } from './passThrough.js';
import { observeForward, refusedRecord, safeRecord, sessionRecord, sessionSource, type EvidenceSink, type SessionSource } from './evidence.js';
import { DirectStreamRepo, healthMap, providerSeedJson, providerView, readSeedFile, type HealthAttempt, type ProviderView } from './repo.js';
import { proxiedUrl } from './rewrite.js';
import { directStreamScriptRunner, parseOpenOutput, parseResolveOutput, type DirectStreamRunner, type OpenOutput } from './runner.js';
import { SESSION_ID_PATTERN, SessionStore, type SessionTorrent, type StreamSession } from './sessions.js';
import { showsEnglish, type OutsideSubtitles } from './outsideSubtitles.js';
import { namesCloud, namesTorrent, SUBTITLES_PENDING, TORRENT_PROVIDER, type TorrentSource } from './torrent/source.js';
import type { SyncInput } from './torrent/subtitles/synced.js';
import { loadKnownTitles, toProbeResult, updateSource, type UpdateSourceAnswer, type WatchPages } from './updateSource.js';
import {
  DirectStreamError,
  type RememberedChannel,
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
  /**
   * The title's IMDb id (`tt0137523`; a series' own id for an episode), which the torrent indexes are asked by
   * (torrent phase 3). Null: none is known; the torrent source then asks no index.
   */
  imdbId?: (ref: StreamRef) => Promise<string | null>;
  /**
   * The title's names and year (the stored title), for the torrent finder's title check and phase 9's 1337x search
   * (torrent phase 3). Null: unknown; the finder then checks no title.
   */
  titleNames?: (ref: StreamRef) => Promise<{ title: string; originalTitle: string | null; year: number | null; episodeInSeason?: number | null } | null>;
  /**
   * How the title was last streamed on this machine and which kinds of stream last found nothing. A play with no
   * provider named asks that channel first. Null: nothing is known, and the play goes the long way.
   */
  channel?: (ref: StreamRef) => Promise<RememberedChannel | null>;
  /** Every cloud provider (`cloud`) or every torrent (`torrent`) found nothing for the title. */
  channelFailed?: (ref: StreamRef, kind: 'cloud' | 'torrent') => Promise<void>;
}

export interface SessionSubtitle {
  /** Pass-through address on this daemon; an `.srt` track's carries `&vtt=1`. A cache's or a torrent's: its local route. */
  url: string;
  lang: string | null;
  label: string;
  /** `vtt` for an `.srt` track (served converted); `cues` for a cue feed; otherwise the resolver's format. */
  format: string;
  source: 'request' | 'manifest';
  english: boolean;
  /** A cue feed (`format: "cues"`): the page reads `url` again, from where it stopped, until the feed is complete. */
  growing?: true;
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
  /**
   * The torrent the session plays from (torrent phase 3): its info hash, the chosen file's index, the release
   * name, the index that listed it (null for a replay from disk), `ready` (the file is whole on disk) or
   * `downloading`, and the seed count listed (null for a replay). Then `provider` is `Torrent` and
   * `manifest_url` is the torrent's file route (`/api/stream/torrent/<hash>/f/<index>`). Null: not a torrent.
   */
  torrent: { info_hash: string; file_index: number; name: string; index: string | null; state: SessionTorrent['state']; seeds: number | null } | null;
  /**
   * Counts the times the session's subtitle changed after the play started (Wyzie Synced re-timed a subtitle from
   * outside the stream, or a cloud session's outside subtitle arrived late); 0 for a session it never happened to. The answer to a position report carries it too: when it is no
   * longer this number, the page reads the session again and loads `subtitles` anew.
   */
  subtitle_rev: number;
}

/** What `play` answers (JSON-ready; the route adds `ok: true`). */
export interface PlayResult {
  page_url: string;
  session: SessionInfo;
  attempts: ResolveAttempt[];
}

/**
 * A play that was asked for and whose player page does not report yet, as `GET /api/movies/player` lists it
 * (`starting`): being resolved (a cloud resolve, a torrent's indexes and swarms), or opened a moment ago. While
 * there is one the daemon is busy, whatever `stream` and `current` say.
 */
export interface StartingPlay {
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  /** The title the player will show; `TMDB movie 550` until the name is read. */
  title: string;
  /** The provider the play named (`torrent`, `cloud`, a provider's name), or null. */
  provider: string | null;
  since: string;
  /** What is being done now, in words. */
  stage: string;
}

/** playWithin's answer when the play outlasted the wait: it goes on in the daemon, and the same call again joins it. */
export interface PendingPlay {
  pending: true;
  since: string;
  waited_s: number;
  stage: string;
  /** Every attempt finished so far. */
  attempts: ResolveAttempt[];
}

/** What a play in flight tells of itself (the `starting` entry, a pending answer). */
interface PlayTrack {
  stage: string;
  attempts: ResolveAttempt[];
}

interface PlayInFlight extends PlayTrack {
  ref: StreamRef;
  provider: string | null;
  title: string;
  since: Date;
  promise: Promise<PlayResult>;
  /** A caller was answered `pending`: the outcome is kept for the next ask. */
  waited: boolean;
  /** Set once the page was opened: the session, and when. */
  opened: { sessionId: string; at: number } | null;
  failed: boolean;
  /** The title's name is being read. */
  naming: boolean;
}

/** A play whose page was opened still counts as starting this long, unless its page reports first. */
export const PLAY_PAGE_GRACE_MS = 30_000;
/** The outcome of a play answered `pending` is kept this long for the caller to ask again. */
export const PLAY_OUTCOME_KEEP_MS = 10 * 60_000;

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
  /** Looks at a stream's picture before a play or a cache keeps it (picture.ts). Null or unset: nothing is looked at. */
  picture?: PictureCheck | null;
  /**
   * Hears a cloud stream's audio before a play, for a dub of a foreign film (audioLang.ts). Named
   * `audioCheck`, not `audioLang`, so it does not clash with the private `audioLang(ref)` method. Null
   * or unset: no cloud stream's audio is heard, and cloud plays are exactly as without it.
   */
  audioCheck?: AudioLangCheck | null;
  /**
   * This host's stream cache (phase 5's StreamCache, AppDeps.streamCache), read at play time
   * because it is built after this service. Unset or null: no cache, every play resolves.
   */
  caches?: () => PlayableCaches | null;
  /**
   * The torrent source (torrent phase 3), read at play time because it is built from phase 1's TorrentStreams
   * after this service. Unset or null: torrents are off, and every play is exactly as without them.
   */
  torrent?: () => TorrentSource | null;
  /**
   * An English subtitle from outside the stream for a cloud session that has none (outsideSubtitles.ts), read at
   * play time. Unset or null: such a session plays without one, as before.
   */
  outside?: () => OutsideSubtitles | null;
  /** True: the next episode of a series being watched is fetched to this machine while this one plays (ahead.ts). Unset: never. */
  ahead?: boolean;
  /** The provider every resolve tries before the others while it keeps working (order.mjs `first`). Unset or null: none. */
  firstProvider?: string | null;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One play in flight per title (a film, an episode) and named provider. */
function playKey(ref: StreamRef, provider: string | null): string {
  return `${ref.kind}-${ref.tmdbId}${ref.kind === 'tv' ? `-${ref.season}-${ref.episode}` : ''}|${(provider ?? '').trim().toLowerCase()}`;
}

/** True when what is remembered was a play of this very film or episode: its torrent holds the file asked for. */
function sameSlot(ref: StreamRef, known: Pick<RememberedChannel, 'season' | 'episode'>): boolean {
  return ref.kind === 'movie' ? known.season === null && known.episode === null : known.season === ref.season && known.episode === ref.episode;
}

function isHealthOutcome(outcome: ResolveOutcome): outcome is StreamHealthOutcome {
  return (STREAM_HEALTH_OUTCOMES as readonly string[]).includes(outcome);
}

/** How many streams of one title may be rejected for their picture in one play before the first one found plays anyway. */
export const PICTURE_MAX_REJECTIONS = 3;

/** A provider nothing has resolved yet, for a delivery verdict that outlived its health row. */
const NO_HEALTH = { en_subtitle: null, best_height: null, median_s: null, last_success_at: null, last_failure_at: null, consecutive_failures: 0 } as const;

/** A torrent session no page asked about for this long lets go of its torrent (the page reports every 5 s, paused or not). */
export const TORRENT_IDLE_MS = 2 * 60_000;
/**
 * A play with no provider named goes to the torrents before the cloud providers while the title's last
 * cloud search found nothing less than this long ago (and no torrent search failed since): the cloud search is
 * the slow one, and it has just been made.
 */
export const CLOUD_FAILURE_KEEP_MS = 3 * 24 * 60 * 60_000;
const TORRENT_SWEEP_MS = 60_000;

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

/** A local subtitle (a cache's file, a torrent's file or cue feed) as the page reads it. */
function localSubtitle(view: CacheSubtitleView): SessionSubtitle {
  return {
    url: view.url,
    lang: view.lang,
    label: view.label,
    format: view.growing === true ? 'cues' : 'vtt',
    source: 'request',
    english: isEnglish(view),
    ...(view.growing === true ? { growing: true as const } : {}),
  };
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
  /** Runs sweepTorrents every minute while a torrent session holds its torrent. */
  private torrentTimer: ReturnType<typeof setInterval> | null = null;
  /** The plays being started, by title and named provider: a second ask of the same play joins the first. */
  private readonly inFlight = new Map<string, PlayInFlight>();
  /** The outcomes of plays that were answered `pending`, for the next ask of the same play. */
  private readonly outcomes = new Map<string, { at: number; result: PlayResult | null; error: unknown }>();
  /** The next episode, fetched while this one plays; null when the daemon does not (ahead.ts). */
  private readonly ahead: EpisodeAhead | null;

  constructor(private readonly opts: DirectStreamServiceOptions) {
    this.repo = opts.repo;
    this.runner = opts.runner;
    this.now = opts.now ?? (() => new Date());
    this.sessions = opts.sessions ?? new SessionStore(this.now);
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.evidence = opts.evidence ?? null;
    // A session the store drops (expired, or past MAX_SESSIONS) lets go of its torrent.
    this.sessions.onEnd((session) => this.letGoTorrent(session));
    this.ahead = opts.ahead === true ? this.buildAhead() : null;
  }

  private buildAhead(): EpisodeAhead {
    return new EpisodeAhead({
      next: async (ref) => {
        const next = (await this.neighborsOf(ref)).next;
        return next === null ? null : { kind: 'tv', tmdbId: ref.tmdbId, season: next.season, episode: next.episode };
      },
      onDisk: async (watched) => {
        const session = this.sessions.peek(watched.id);
        if (session === null) return false;
        if (session.torrent !== null) return (await this.torrentSource()?.state(session.torrent)) === 'ready';
        if (session.cache === null) return false;
        return (await this.opts.caches?.()?.standing?.(session.ref))?.state === 'ready';
      },
      cloud: () => {
        const caches = this.opts.caches?.() ?? null;
        if (caches === null || caches.ahead === undefined || caches.pause === undefined) return null;
        return { start: caches.ahead.bind(caches), pause: caches.pause.bind(caches) };
      },
      torrent: () => {
        const source = this.torrentSource();
        if (source === null) return null;
        return {
          has: (ref) => source.onDisk(ref),
          fetch: async (ref) => {
            const namesHook = this.opts.hooks?.titleNames;
            const out = await source.fetchAhead(ref, {
              audioLang: await this.audioLang(ref),
              imdbId: await this.imdbIdOf(ref),
              names: namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref)),
              resumeS: null,
            });
            if (!out.ok) return null;
            const torrent = out.torrent;
            return { name: torrent.name, ready: async () => (await source.state(torrent)) === 'ready', release: () => source.releaseAhead(torrent) };
          },
        };
      },
      now: () => this.now().getTime(),
      log: this.log,
    });
  }

  /**
   * A position report of the session's page (the position route): an episode that is really being watched has
   * its next one fetched to this machine (ahead.ts). Nothing without `ahead`, for a film, or for an unknown id.
   */
  watched(id: string, report: { paused: boolean; over: boolean }): void {
    const session = this.ahead === null ? null : this.sessions.peek(id);
    if (session !== null) this.ahead?.watched({ id: session.id, ref: session.ref, via: session.torrent !== null ? 'torrent' : 'cloud' }, report);
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
  async resolve(input: StreamRefInput, options: { resumeS?: number | null; deadlineS?: number; only?: string; vet?: boolean; skip?: readonly string[] } = {}): Promise<StreamSession> {
    const ref = toStreamRef(input);
    const left = options.skip ?? [];
    // `vet`: something is about to be watched or kept (a play, a cache), so the picture is looked at
    // (picture.ts). Not for a provider the owner named, and not for a resolve that only reads a subtitle.
    const out =
      options.vet === true && options.only === undefined
        ? await this.vetted(ref, left, (skip, later) => (later ? this.resolveQuietly(ref, skip) : this.resolveSource(ref, options.deadlineS, skip)))
        : await this.resolveSource(ref, options.deadlineS, left, options.only);
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
  async play(input: StreamRefInput, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null } = {}): Promise<PlayResult> {
    return this.begin(toStreamRef(input), options).promise;
  }

  /**
   * `play`, answered within `waitMs`: a caller with a time limit of its own (an MCP client gives a tool call about
   * 60 s) gets `pending` with the stage and the attempts so far instead of nothing. The play goes on in the daemon
   * and opens the player by itself; the same call again joins it, or reads its outcome once it has one.
   */
  async playWithin(input: StreamRefInput, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null }, waitMs: number): Promise<{ pending: false; result: PlayResult } | PendingPlay> {
    const ref = toStreamRef(input);
    const key = playKey(ref, options.provider ?? null);
    const kept = this.outcomes.get(key);
    if (kept !== undefined && !this.inFlightNow(key)) {
      this.outcomes.delete(key);
      if (this.now().getTime() - kept.at < PLAY_OUTCOME_KEEP_MS) {
        if (kept.result === null) throw kept.error;
        return { pending: false, result: kept.result };
      }
    }
    const entry = this.begin(ref, options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, waitMs));
    });
    const result = await Promise.race([entry.promise, late]).finally(() => clearTimeout(timer));
    if (result !== null) return { pending: false, result };
    entry.waited = true;
    return {
      pending: true,
      since: entry.since.toISOString(),
      waited_s: Math.round((this.now().getTime() - entry.since.getTime()) / 100) / 10,
      stage: entry.stage,
      attempts: [...entry.attempts],
    };
  }

  /**
   * The plays being started now: asked for and not answered yet, or opened within PLAY_PAGE_GRACE_MS with a page
   * that does not report yet (`onScreen` is the session the stream on screen belongs to).
   */
  starting(onScreen: string | null = null): StartingPlay[] {
    const now = this.now().getTime();
    const out: StartingPlay[] = [];
    for (const [key, e] of this.inFlight) {
      if (e.failed || (e.opened !== null && (e.opened.sessionId === onScreen || now - e.opened.at >= PLAY_PAGE_GRACE_MS))) {
        this.inFlight.delete(key);
        continue;
      }
      this.nameIt(e);
      out.push({
        kind: e.ref.kind,
        tmdb_id: e.ref.tmdbId,
        season: e.ref.kind === 'tv' ? e.ref.season : null,
        episode: e.ref.kind === 'tv' ? e.ref.episode : null,
        title: e.title,
        provider: e.provider,
        since: e.since.toISOString(),
        stage: e.stage,
      });
    }
    return out;
  }

  /** Reads the title's name for a play in flight that still shows its TMDB reference (a title not stored when the play began). */
  private nameIt(entry: PlayInFlight): void {
    const hook = this.opts.hooks?.titleLabel;
    if (hook === undefined || entry.naming || entry.title !== refLabel(entry.ref)) return;
    entry.naming = true;
    void this.hookValue('titleLabel', () => hook(entry.ref)).then((title) => {
      entry.naming = false;
      if (title !== null) entry.title = title;
    });
  }

  private inFlightNow(key: string): boolean {
    const e = this.inFlight.get(key);
    return e !== undefined && !e.failed && e.opened === null;
  }

  /** The play of `ref` in flight, or a new one. Its promise is the play's answer; a rejection nobody waits for is logged, not thrown away. */
  private begin(ref: StreamRef, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null }): PlayInFlight {
    const provider = options.provider ?? null;
    const key = playKey(ref, provider);
    const running = this.inFlight.get(key);
    if (running !== undefined && this.inFlightNow(key)) return running;
    const entry: PlayInFlight = {
      ref,
      provider,
      title: refLabel(ref),
      since: this.now(),
      stage: 'starting',
      attempts: [],
      promise: Promise.resolve(null as unknown as PlayResult),
      waited: false,
      opened: null,
      failed: false,
      naming: false,
    };
    this.nameIt(entry);
    entry.promise = this.playNow(ref, options, entry).then(
      (result) => {
        entry.opened = { sessionId: result.session.session_id, at: this.now().getTime() };
        entry.stage = 'opened: waiting for the player page';
        if (entry.waited) this.outcomes.set(key, { at: this.now().getTime(), result, error: null });
        return result;
      },
      (err: unknown) => {
        entry.failed = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
        this.logFailedPlay(entry, err);
        if (entry.waited) this.outcomes.set(key, { at: this.now().getTime(), result: null, error: err });
        throw err;
      },
    );
    // A caller answered `pending` no longer waits: the failure was logged above.
    entry.promise.catch(() => undefined);
    this.inFlight.set(key, entry);
    return entry;
  }

  /**
   * A play that started nothing, with every attempt, in the daemon's log: the caller may have stopped waiting, and
   * /report-stream-bug reads a play that never made a session from these lines.
   */
  private logFailedPlay(entry: PlayInFlight, err: unknown): void {
    const tookS = Math.round((this.now().getTime() - entry.since.getTime()) / 100) / 10;
    const code = err instanceof DirectStreamError ? err.code : err instanceof CachePlayError ? err.code : 'error';
    const attempts = err instanceof DirectStreamError && err.attempts.length > 0 ? err.attempts : entry.attempts;
    this.log(
      `[notesd] direct stream: play of ${refLabel(entry.ref)}${entry.provider === null ? '' : ` (${entry.provider})`} started nothing after ${tookS} s: ${code}${code === 'error' ? ` (${messageOf(err)})` : ''}, ${attempts.length} attempt(s)`,
    );
    for (const a of attempts) {
      this.log(`[notesd] direct stream:   attempt ${a.provider}: ${a.outcome}${a.took_s === null ? '' : ` after ${a.took_s} s`}${a.detail === '' ? '' : ` (${a.detail})`}`);
    }
  }

  private async playNow(ref: StreamRef, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null }, track: PlayTrack): Promise<PlayResult> {
    const resumeS = options.resumeS ?? null;
    // The owner named a provider ("stream it from VidLink"): only that one is asked, and a cache is passed over.
    // "torrent" asks the torrent source alone: a finished download on this machine first, else the swarm.
    // "cloud" asks the cloud providers alone: this host's stream cache first, and never a torrent, on disk or in the swarm.
    const only = options.provider ?? null;
    const magnet = options.magnet ?? null;
    track.stage = "looking at this machine's cache and downloads";
    let session: StreamSession;
    // The owner pasted a magnet: only that torrent is opened, for the title they named. No index, no cache.
    if (magnet !== null) session = await this.magnetSession(ref, resumeS, magnet, track);
    else if (only === null) session = await this.sessionFor(ref, resumeS, track);
    else if (namesTorrent(only)) session = (await this.diskSession(ref, resumeS)) ?? (await this.torrentAgain(ref, resumeS, track));
    else if (namesCloud(only)) session = (await this.cachedSession(ref, resumeS)) ?? (await this.cloudAgain(ref, resumeS, track));
    else session = await this.cloudSession(ref, { resumeS, only }, track);
    track.stage = 'opening the player page';
    track.attempts = session.attempts;
    return this.openPage(session);
  }

  /**
   * "torrent" named: the very torrent that last played this film or this episode is opened again, with no index
   * asked, whatever played the title since. Only when none is remembered, or its swarm has nothing now, are the
   * indexes searched.
   */
  private async torrentAgain(ref: StreamRef, resumeS: number | null, track: PlayTrack | null): Promise<StreamSession> {
    const last = (await this.remembered(ref))?.methods?.torrent ?? null;
    if (last === null || last.infoHash === null || !sameSlot(ref, last)) return this.torrentSession(ref, resumeS, null, track);
    if (track !== null) track.stage = 'opening the torrent that played it last time';
    try {
      return await this.magnetSession(ref, resumeS, last.infoHash, track);
    } catch (err) {
      if (!(err instanceof DirectStreamError) || err.code !== 'no_source') throw err;
      this.log(`[notesd] direct stream: the torrent that played ${refLabel(ref)} last time does not play now; asking the indexes`);
      return this.after(err.attempts, () => this.torrentSession(ref, resumeS, null, track));
    }
  }

  /** "cloud" named: the cloud provider that last streamed the title is asked alone first, whatever played it since; then the others, without it. */
  private async cloudAgain(ref: StreamRef, resumeS: number | null, track: PlayTrack | null): Promise<StreamSession> {
    const provider = (await this.remembered(ref))?.methods?.cloud?.provider ?? null;
    if (provider === null) return this.everyCloud(ref, resumeS, track);
    const tried: ResolveAttempt[] = [];
    const again = await this.rememberedCloud(ref, provider, resumeS, track, tried);
    if (again !== null) return again;
    return this.after(tried, () => this.everyCloud(ref, resumeS, track, [provider]));
  }

  /** `resolve`, with the play's stage said first: the cloud resolver answers its attempts only at its end. */
  private cloudSession(ref: StreamRef, options: { resumeS?: number | null; only?: string; vet?: boolean; skip?: readonly string[] }, track: PlayTrack | null): Promise<StreamSession> {
    if (track !== null) track.stage = options.only === undefined ? 'asking the cloud providers' : `asking ${options.only}`;
    return this.resolve(ref, options);
  }

  /**
   * How the title was last streamed on this machine (the `channel` hook), or null. The routes and tools read it
   * to send a play with no provider named back to a streaming site.
   */
  async remembered(input: StreamRefInput): Promise<RememberedChannel | null> {
    const hook = this.opts.hooks?.channel;
    if (hook === undefined) return null;
    const ref = toStreamRef(input);
    return this.hookValue('channel', () => hook(ref));
  }

  private async failed(ref: StreamRef, kind: 'cloud' | 'torrent'): Promise<void> {
    const hook = this.opts.hooks?.channelFailed;
    if (hook !== undefined) await this.hookValue('channelFailed', async () => (await hook(ref, kind), null));
  }

  /**
   * A play with no provider named. This host's stream cache, then this host's finished torrent download of the
   * title (R2.9: no index, no swarm). Then what streamed the title last time: that cloud provider alone, or the
   * torrents; a title never streamed whose cloud search just found nothing goes to the torrents too. Only when
   * that finds nothing does the play go the long way: every cloud provider, and after them the torrent source.
   */
  private async sessionFor(ref: StreamRef, resumeS: number | null, track: PlayTrack | null = null): Promise<StreamSession> {
    const local = (await this.cachedSession(ref, resumeS)) ?? (await this.diskSession(ref, resumeS));
    if (local !== null) return local;
    const known = await this.remembered(ref);
    if (known !== null && known.channel === 'cloud' && known.provider !== null) {
      const provider = known.provider;
      const tried: ResolveAttempt[] = [];
      const again = await this.rememberedCloud(ref, provider, resumeS, track, tried);
      if (again !== null) return again;
      return this.after(tried, () => this.resolveOrTorrent(ref, resumeS, track, [provider]));
    }
    if (known !== null && this.torrentSource() !== null && this.torrentsFirst(known)) {
      try {
        if (track !== null) track.stage = known.channel === 'torrent' ? 'asking the torrents, which streamed it last time' : 'asking the torrents: no cloud provider had it last time';
        // The very torrent that played this film or this episode is opened again, with no index asked;
        // only when its swarm has nothing now are the indexes searched.
        if (known.channel === 'torrent' && known.infoHash !== null && sameSlot(ref, known)) {
          const hash = known.infoHash;
          if (track !== null) track.stage = 'opening the torrent that played it last time';
          try {
            return await this.magnetSession(ref, resumeS, hash, track);
          } catch (err) {
            if (!(err instanceof DirectStreamError) || err.code !== 'no_source') throw err;
            this.log(`[notesd] direct stream: the torrent that played ${refLabel(ref)} last time does not play now; asking the indexes`);
            return await this.after(err.attempts, () => this.torrentSession(ref, resumeS, null, track));
          }
        }
        return await this.torrentSession(ref, resumeS, null, track);
      } catch (err) {
        if (!(err instanceof DirectStreamError) || err.code !== 'no_source') throw err;
        return this.after(err.attempts, () => this.everyCloud(ref, resumeS, track));
      }
    }
    return this.resolveOrTorrent(ref, resumeS, track);
  }

  /** True when the torrents are asked before the cloud providers: they streamed the title last, or the title never streamed and its last cloud search, a recent one, found nothing. */
  private torrentsFirst(known: RememberedChannel): boolean {
    if (known.channel === 'torrent') return true;
    if (known.channel === 'cloud' || known.cloudFailedAt === null) return false;
    const cloudAt = known.cloudFailedAt.getTime();
    if (this.now().getTime() - cloudAt >= CLOUD_FAILURE_KEEP_MS) return false;
    return known.torrentFailedAt === null || known.torrentFailedAt.getTime() < cloudAt;
  }

  /**
   * The provider that streamed the title last time, asked alone. Null when it has no stream now (`tried` gets its
   * attempts): the play then asks the others. A failure here says nothing of the title, so the recordResolve hook
   * runs only on a success.
   */
  private async rememberedCloud(ref: StreamRef, provider: string, resumeS: number | null, track: PlayTrack | null, tried: ResolveAttempt[]): Promise<StreamSession | null> {
    if (track !== null) track.stage = `asking ${provider}, which streamed it last time`;
    const out = await this.runResolve(ref, { only: provider });
    if (!out.ok) {
      tried.push(...out.attempts);
      if (track !== null) track.attempts = [...tried];
      this.log(`[notesd] direct stream: ${provider} streamed ${refLabel(ref)} last time and has no stream now (${out.error}); asking the others`);
      return null;
    }
    const hook = this.opts.hooks?.recordResolve;
    if (hook !== undefined) {
      try {
        await hook(ref, out);
      } catch (err) {
        this.log(`[notesd] direct stream: the recordResolve hook failed: ${messageOf(err)}`);
      }
    }
    const session = this.sessions.create(ref, out.source, out.attempts, await this.startAt(ref, resumeS), await this.audioLang(ref));
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /** `run`, with the attempts made before it put first in its session's, or in its failure's. */
  private async after(earlier: readonly ResolveAttempt[], run: () => Promise<StreamSession>): Promise<StreamSession> {
    if (earlier.length === 0) return run();
    try {
      const session = await run();
      session.attempts = [...earlier, ...session.attempts];
      return session;
    } catch (err) {
      if (!(err instanceof DirectStreamError)) throw err;
      throw new DirectStreamError(err.code, err.message, { ...(err.reason === null ? {} : { reason: err.reason }), attempts: [...earlier, ...err.attempts] });
    }
  }

  /** Every cloud provider but `skip`, with the picture looked at (picture.ts). When none has the title, that is kept (`channelFailed`). */
  private async everyCloud(ref: StreamRef, resumeS: number | null, track: PlayTrack | null, skip: readonly string[] = []): Promise<StreamSession> {
    try {
      return await this.cloudSession(ref, { resumeS, vet: true, skip }, track);
    } catch (err) {
      if (err instanceof DirectStreamError && err.code === 'no_source') await this.failed(ref, 'cloud');
      throw err;
    }
  }

  /**
   * The cloud resolve, and when no provider resolves the title (`no_source`) or the resolve could not run
   * (`resolve_failed`: a torrent needs no Chrome), the torrent source. Torrents off: exactly `resolve`.
   */
  private async resolveOrTorrent(ref: StreamRef, resumeS: number | null, track: PlayTrack | null, skip: readonly string[] = []): Promise<StreamSession> {
    try {
      return await this.everyCloud(ref, resumeS, track, skip);
    } catch (err) {
      if (!(err instanceof DirectStreamError) || (err.code !== 'no_source' && err.code !== 'resolve_failed') || this.torrentSource() === null) throw err;
      return this.torrentSession(ref, resumeS, err, track);
    }
  }

  /**
   * A session on a torrent found and opened now. `cloud` is the cloud resolve's failure it follows, if any: its
   * attempts come first in the answer's. Throws `torrent_off`; `no_source` with every attempt (cloud, index,
   * torrent); or, after a cloud `resolve_failed`, that error again with the torrent attempts added. The
   * recordResolve hook is not called: a torrent says nothing of the title's cloud sources.
   */
  private async torrentSession(ref: StreamRef, resumeS: number | null, cloud: DirectStreamError | null, track: PlayTrack | null = null): Promise<StreamSession> {
    const source = this.torrentSource();
    if (source === null) throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).');
    const audioLang = await this.audioLang(ref);
    const imdbId = await this.imdbIdOf(ref);
    const namesHook = this.opts.hooks?.titleNames;
    const names = namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref));
    const startS = await this.startAt(ref, resumeS);
    // Never inside serial(): the cloud resolve above has returned, and phase 6's borrow tier queues on serial().
    const before = cloud?.attempts ?? [];
    if (track !== null) track.attempts = [...before];
    const out = await source.resolve(ref, {
      audioLang,
      imdbId,
      names,
      resumeS: startS,
      cloudTried: cloud !== null && cloud.code === 'no_source',
      ...(track === null
        ? {}
        : {
            progress: (p) => {
              track.stage = p.stage;
              track.attempts = [...before, ...p.attempts];
            },
          }),
    });
    const attempts = [...before, ...out.attempts];
    if (!out.ok) {
      await this.failed(ref, 'torrent');
      if (cloud !== null && cloud.code === 'resolve_failed') {
        throw new DirectStreamError('resolve_failed', cloud.message, { ...(cloud.reason === null ? {} : { reason: cloud.reason }), attempts });
      }
      throw new DirectStreamError('no_source', `No provider or torrent could stream ${refLabel(ref)}.`, { attempts });
    }
    const session = this.sessions.createTorrent(ref, out.source, attempts, startS, audioLang, out.torrent);
    this.followSubtitles(session);
    this.watchTorrents();
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /**
   * A session on a torrent the owner pasted (a magnet link or a bare info hash), for a title they also named:
   * no index is asked, only that torrent is opened, and the original-language check still applies. Throws
   * `torrent_off`; `no_source` with the one `Torrent: <name>` attempt when it does not play (a dub, no video
   * file in it, or the swarm sent nothing in time).
   */
  private async magnetSession(ref: StreamRef, resumeS: number | null, magnet: string, track: PlayTrack | null = null): Promise<StreamSession> {
    const source = this.torrentSource();
    if (source === null) throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).');
    const audioLang = await this.audioLang(ref);
    const imdbId = await this.imdbIdOf(ref);
    const namesHook = this.opts.hooks?.titleNames;
    const names = namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref));
    const startS = await this.startAt(ref, resumeS);
    const out = await source.playMagnet(ref, {
      magnet,
      audioLang,
      imdbId,
      names,
      resumeS: startS,
      ...(track === null ? {} : { progress: (p) => { track.stage = p.stage; track.attempts = [...p.attempts]; } }),
    });
    if (!out.ok) throw new DirectStreamError('no_source', `The pasted torrent could not stream ${refLabel(ref)}.`, { attempts: out.attempts });
    const session = this.sessions.createTorrent(ref, out.source, out.attempts, startS, audioLang, out.torrent);
    this.followSubtitles(session);
    this.watchTorrents();
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /** A session on this host's finished torrent download of `ref` (R2.9), or null (torrents off, none, not whole, or its file does not play). */
  private async diskSession(ref: StreamRef, resumeS: number | null): Promise<StreamSession | null> {
    const source = this.torrentSource();
    if (source === null) return null;
    const audioLang = await this.audioLang(ref);
    const startS = await this.startAt(ref, resumeS);
    const disk = await source.fromDisk(ref, { audioLang, resumeS: startS });
    if (disk === null) return null;
    // A replay's attempts are only its subtitle tiers' (`Subtitles: <tier>`): no index, no torrent was tried.
    const session = this.sessions.createTorrent(ref, disk.source, disk.attempts, startS, audioLang, disk.torrent);
    this.followSubtitles(session);
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /**
   * A torrent session answered while its subtitle chain still runs (`Subtitles: pending`): once the chain ends its
   * attempts take that one's place in the session's, so a snapshot of the session says what the subtitles cost.
   */
  private followSubtitles(session: StreamSession): void {
    const torrent = session.torrent;
    const pending = torrent?.subtitlesPending ?? null;
    if (torrent === null || pending === null) return;
    void pending.then((late) => {
      if (session.torrent !== torrent) return;
      session.attempts = [...session.attempts.filter((a) => a.provider !== SUBTITLES_PENDING), ...late];
    });
  }

  private torrentSource(): TorrentSource | null {
    return this.opts.torrent?.() ?? null;
  }

  private async imdbIdOf(ref: StreamRef): Promise<string | null> {
    const hook = this.opts.hooks?.imdbId;
    return hook === undefined ? null : this.hookValue('imdbId', () => hook(ref));
  }

  /** Lets go of the session's torrent, if it holds one: with no other user the daemon leaves the swarm. */
  private letGoTorrent(session: StreamSession): void {
    if (session.torrent !== null) this.torrentSource()?.release(session.torrent);
  }

  /** Takes a released torrent again (a reload of the page). A failure is logged: the page's refresh says it. */
  private async holdTorrent(session: StreamSession, torrent: SessionTorrent): Promise<void> {
    const source = this.torrentSource();
    if (source === null || torrent.held || torrent.candidate === null) return;
    await source.hold(session.ref, torrent);
    this.watchTorrents();
  }

  /**
   * The player page closed or the film ended (a `closed` / `ended` position report): the session lets go of its
   * torrent. A reload of the page takes it again (info, refresh). Unknown ids are ignored.
   */
  letGo(id: string): void {
    // A page that says it closed has reported: its play is not being started any more.
    for (const [key, e] of this.inFlight) if (e.opened?.sessionId === id) this.inFlight.delete(key);
    const session = this.sessions.peek(id);
    if (session !== null) this.letGoTorrent(session);
  }

  /**
   * What a timer runs every minute while a torrent session holds its torrent: ended sessions are dropped (their
   * torrents released by the store's end listener), and a torrent no page asked about for TORRENT_IDLE_MS is
   * released. The timer stops once no session holds a torrent.
   */
  sweepTorrents(): void {
    const now = this.now().getTime();
    let holding = false;
    for (const session of this.sessions.live()) {
      const torrent = session.torrent;
      if (torrent === null || !torrent.held) continue;
      if (now - session.lastUsedAt.getTime() >= TORRENT_IDLE_MS) this.letGoTorrent(session);
      else holding = true;
    }
    if (!holding && this.torrentTimer !== null) {
      clearInterval(this.torrentTimer);
      this.torrentTimer = null;
    }
  }

  private watchTorrents(): void {
    if (this.torrentTimer !== null) return;
    this.torrentTimer = setInterval(() => this.sweepTorrents(), TORRENT_SWEEP_MS);
    this.torrentTimer.unref();
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
      session.torrent !== null
        ? `[notesd] direct stream: playing ${refLabel(session.ref)} from the torrent ${session.torrent.name} (${session.torrent.state}${session.torrent.candidate === null ? ', from disk' : ''})`
        : session.cache === null
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

  /** What the player page reads, or null for an unknown or ended id. A torrent session that let go of its torrent (the page closed and is back) takes it again. */
  async info(id: string): Promise<SessionInfo | null> {
    const session = this.sessions.get(id);
    if (session === null) return null;
    if (session.torrent !== null) {
      await this.holdTorrent(session, session.torrent).catch((err: unknown) => this.log(`[notesd] direct stream: could not open the torrent ${session.torrent?.name ?? ''} again: ${messageOf(err)}`));
    }
    return this.sessionInfo(session);
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
    if (session.torrent !== null) {
      // A torrent has no token to renew: the session keeps it, taking it again when it was let go.
      try {
        await this.holdTorrent(session, session.torrent);
      } catch (err) {
        safeRecord(this.evidence, sessionRecord(session, 'refresh_failed', messageOf(err)));
        throw new DirectStreamError('resolve_failed', `The torrent ${session.torrent.name} could not be opened again: ${messageOf(err)}`, { reason: 'torrent_gone' });
      }
      session.refreshedAt = this.now();
      safeRecord(this.evidence, sessionRecord(session, 'refreshed', null));
      return this.sessionInfo(session);
    }
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
      // A token refresh looks at nothing new, but keeps away from the providers whose picture was rejected or whose audio was a dub.
      out = await this.resolveSource(session.ref, undefined, [...session.avoid, ...(await this.rejectedProviders(session.ref, session.avoid))]);
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
    // A torrent session is never cached: its download is its own copy on this machine.
    if (session.torrent !== null || caches === null || caches.start === undefined || caches.standing === undefined) return answer(false, null);
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
    // The stream on screen cannot keep up: a next episode being cached beside it stops.
    this.ahead?.stalled(session.id);
    if (session.cache !== null) return { switched: false, reason: 'cached', from: session.source.provider, session: await this.sessionInfo(session) };
    if (session.torrent !== null) return this.nextTorrent(session, session.torrent);
    const from = session.source.provider;
    let out: ResolvedOutput;
    try {
      // The next provider's picture is looked at too: the owner leaves a cinema recording for a proper copy, not for the next recording.
      out = await this.vetted(session.ref, [...session.avoid, from], (skip) => this.resolveQuietly(session.ref, skip));
    } catch (err) {
      this.log(`[notesd] direct stream: ${refLabel(session.ref)} leaves ${from} and no other provider answered (${err instanceof DirectStreamError ? (err.reason ?? err.code) : messageOf(err)})`);
      return { switched: false, reason: 'no_other_source', from, session: await this.sessionInfo(session) };
    }
    session.avoid.push(from);
    this.sessions.replaceSource(session, out.source, out.attempts);
    safeRecord(this.evidence, sessionRecord(session, 'switched', null));
    this.log(`[notesd] direct stream: ${refLabel(session.ref)} moved from ${from} to ${out.source.provider} (the stream stalled)`);
    return { switched: true, reason: null, from, session: await this.sessionInfo(session) };
  }

  /**
   * The shuffle button on a torrent session: the next of the session's remaining candidates, without asking the
   * indexes again. The old torrent is released once the new one plays; `no_other_source` leaves the session as
   * it was. `from` is `Torrent: <release>`.
   */
  private async nextTorrent(session: StreamSession, torrent: SessionTorrent): Promise<SwitchSourceAnswer> {
    const from = `${TORRENT_PROVIDER}: ${torrent.name}`;
    const source = this.torrentSource();
    const out = source === null ? null : await source.next(session.ref, torrent, session.audioLang);
    if (out === null || !out.ok) {
      this.log(`[notesd] direct stream: ${refLabel(session.ref)} stalls on the torrent ${torrent.name} and no other torrent could be played`);
      return { switched: false, reason: 'no_other_source', from, session: await this.sessionInfo(session) };
    }
    this.letGoTorrent(session);
    this.sessions.replaceTorrent(session, out.source, out.torrent, out.attempts);
    this.followSubtitles(session);
    this.watchTorrents();
    safeRecord(this.evidence, sessionRecord(session, 'switched', null));
    this.log(`[notesd] direct stream: ${refLabel(session.ref)} moved from the torrent ${torrent.name} to ${out.torrent.name}`);
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
    const next = await this.sessionFor(ref, null);
    this.log(
      `[notesd] direct stream: ${refLabel(session.ref)} -> ${refLabel(next.ref)} (${to} episode) ${
        next.torrent !== null ? `from the torrent ${next.torrent.name}` : next.cache === null ? `from ${next.source.provider}` : `from the cache ${next.cache.id}`
      }`,
    );
    return this.sessionInfo(next);
  }

  /**
   * The text of the title's English subtitle, for its dialogue (dialogue.ts) and for a torrent
   * session that has none (the borrow tier, torrent/subtitles/borrow.ts). Resolves the title like
   * a play does, out of sight, and opens no player: then reads the first English track that
   * holds cues, through the same pass-through rules as the player (the session's hosts, the
   * captured headers). A separate file is tried before a track inside the manifest. `deadlineS`
   * becomes the resolver's `--deadline-s`. Throws what `resolve` throws, or `no_subtitle` when the
   * source that resolved has no English track that can be read.
   */
  async subtitleText(input: StreamRefInput, options: { deadlineS?: number; outside?: boolean } = {}): Promise<{ provider: string; label: string; vtt: string; attempts: ResolveAttempt[] }> {
    const session = await this.resolve(input, options.deadlineS === undefined ? {} : { deadlineS: options.deadlineS });
    const english = session.source.subtitles.filter((t) => isEnglish(t));
    const tracks = [...english.filter((t) => t.source === 'request'), ...english.filter((t) => t.source !== 'request')];
    for (const track of tracks) {
      const vtt = await this.readSubtitle(session, track.url, track.format).catch(() => null);
      if (vtt !== null && parseCues(vtt).length >= DIALOGUE_MIN_CUES) {
        return { provider: session.source.provider, label: track.label, vtt, attempts: session.attempts };
      }
    }
    // The dialogue reader (`outside`): the title's subtitle from outside the stream stands in (outsideSubtitles.ts).
    const outside = options.outside === true ? await this.opts.outside?.()?.text(session.ref) : null;
    if (outside != null && parseCues(outside.vtt).length >= DIALOGUE_MIN_CUES) {
      return { provider: session.source.provider, label: outside.label, vtt: outside.vtt, attempts: session.attempts };
    }
    throw new DirectStreamError(
      'no_subtitle',
      tracks.length === 0
        ? `${session.source.provider} streams ${refLabel(session.ref)} without an English subtitle.`
        : `${session.source.provider} names an English subtitle for ${refLabel(session.ref)}, but it could not be read.`,
      { attempts: session.attempts },
    );
  }

  /**
   * The English subtitle a cloud session's own source carries, as text: the track the page shows by default (an
   * English one, a separate file before a track inside the manifest, or the source's one unnamed file). Null for a
   * torrent session, an unknown id, or a source with none that can be read. For /sync-subtitle (subtitleCheck/).
   */
  async ownSubtitleText(id: string): Promise<{ label: string; vtt: string } | null> {
    const session = this.sessions.peek(id);
    if (session === null || session.torrent !== null) return null;
    const byDefault = <T extends { lang: string | null; label: string }>(tracks: readonly T[]): T[] => {
      const english = tracks.filter((t) => isEnglish(t));
      return english.length > 0 ? english : showsEnglish(tracks) ? [...tracks] : [];
    };
    if (session.cache !== null) {
      for (const track of byDefault(session.cache.subtitles)) {
        if (track.growing === true) continue;
        const res = await this.fetchImpl(`${this.opts.pageBase()}${track.url}`, { signal: AbortSignal.timeout(SUBTITLE_TIMEOUT_MS) }).catch(() => null);
        const vtt = res !== null && res.ok ? await res.text() : null;
        if (vtt !== null && parseCues(vtt).length >= DIALOGUE_MIN_CUES) return { label: track.label || 'English', vtt };
      }
      return null;
    }
    const mine = byDefault(session.source.subtitles);
    for (const track of [...mine.filter((t) => t.source === 'request'), ...mine.filter((t) => t.source !== 'request')]) {
      const vtt = await this.readSubtitle(session, track.url, track.format).catch(() => null);
      if (vtt !== null && parseCues(vtt).length >= DIALOGUE_MIN_CUES) return { label: track.label || 'English', vtt };
    }
    return null;
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
          ...(typeof this.opts.firstProvider === 'string' && options.only === undefined ? ['--first', this.opts.firstProvider] : []),
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

  /**
   * The providers a play of `ref` leaves out from the start: those whose picture this machine rejected
   * and those it heard as a dub (audioLang.ts), without the ones `skip` already names. Empty without
   * either check.
   */
  private async rejectedProviders(ref: StreamRef, skip: readonly string[]): Promise<string[]> {
    const picture = this.opts.picture ?? null;
    const audio = this.opts.audioCheck ?? null;
    const left = new Set(skip.map((name) => name.toLowerCase()));
    const [badPicture, badAudio] = await Promise.all([picture === null ? [] : picture.badFor(ref), audio === null ? [] : audio.badFor(ref)]);
    const out: string[] = [];
    for (const name of [...badPicture, ...badAudio]) {
      if (!left.has(name.toLowerCase()) && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
    return out;
  }

  /**
   * Resolves until a cloud stream passes both checks (picture.ts and audioLang.ts). `one(skip, later)`
   * runs one resolve without the providers in `skip` and throws when it finds none; `later` is true from
   * the second round on. Providers rejected before (a bad picture or a dub) are left out from the start.
   * A rejected stream's provider is skipped and the next round asks again, at most PICTURE_MAX_REJECTIONS
   * times. When nothing passes, the first stream found plays: a poor picture, or a dub, is better than
   * none. Each round's attempts are kept, and the looked-at provider's says `picture: <verdict>` and, when
   * the audio was heard, `audio: <verdict>`.
   *
   * The audio check is only run on this cloud path, and only when the title's original language is known
   * and is not English (there is no dub into English of an English film to hear).
   */
  private async vetted(ref: StreamRef, skip: readonly string[], one: (skip: readonly string[], later: boolean) => Promise<ResolvedOutput>): Promise<ResolvedOutput> {
    const picture = this.opts.picture ?? null;
    const audio = this.opts.audioCheck ?? null;
    const original = audio === null ? null : await this.audioLang(ref);
    const hearAudio = audio !== null && original !== null && normalizeAudioLang(original) !== 'en';
    if (picture === null && !hearAudio) return one(skip, false);
    const rejected = await this.rejectedProviders(ref, skip);
    const titleHook = this.opts.hooks?.titleLabel;
    const title = (titleHook === undefined ? null : await this.hookValue('titleLabel', () => titleHook(ref))) ?? refLabel(ref);
    let first: ResolvedOutput | null = null;
    let seen: ResolveAttempt[] = [];
    for (let round = 0; round <= PICTURE_MAX_REJECTIONS; round++) {
      let out: ResolvedOutput;
      try {
        out = await one([...skip, ...rejected], round > 0);
      } catch (err) {
        if (first !== null) break;
        if (rejected.length === 0 || !(err instanceof DirectStreamError) || err.code !== 'no_source') throw err;
        // Only providers rejected on an earlier play are left: one of them plays.
        this.log(`[notesd] direct stream: ${refLabel(ref)} has no provider left but ${rejected.join(', ')}, rejected before (a poor picture or a dub)`);
        return one(skip, true);
      }
      // Both checks run so the attempt detail says both, but a bad picture or a dub either one passes the provider over.
      const findings: string[] = [];
      let bad = false;
      if (picture !== null) {
        const finding = await picture.check(ref, out.source, title);
        findings.push(`picture: ${finding.verdict}${finding.reason === '' ? '' : ` (${finding.reason})`}`);
        if (passesOver(finding)) bad = true;
      }
      if (hearAudio && original !== null) {
        const look = await audio!.check(ref, out.source, original);
        findings.push(`audio: ${look.verdict}${look.reason === '' ? '' : ` (${look.reason})`}`);
        if (passesOverAudio(look)) bad = true;
      }
      const said = findings.join('; ');
      const attempts = out.attempts
        .filter((a) => round === 0 || !a.outcome.startsWith('skipped_'))
        .map((a) => (a.provider === out.source.provider && a.outcome === 'resolved' ? { ...a, detail: a.detail === '' ? said : `${a.detail}; ${said}` } : a));
      seen = [...seen, ...attempts];
      out = { ...out, attempts: seen };
      if (!bad) return out;
      first ??= out;
      rejected.push(out.source.provider);
    }
    if (first === null) throw new DirectStreamError('no_source', `No provider could stream ${refLabel(ref)}.`, { attempts: seen });
    this.log(`[notesd] direct stream: no provider passed the stream checks for ${refLabel(ref)}; playing ${first.source.provider}`);
    return { ...first, attempts: seen };
  }

  /** One resolve for a title that is already playing or already has a stream in hand: the recordResolve hook runs only when a source was found, so a round that finds none does not mark the title stale. Throws `no_source` / `resolve_failed`. */
  private async resolveQuietly(ref: StreamRef, skip: readonly string[]): Promise<ResolvedOutput> {
    const out = await this.runResolve(ref, { skip });
    if (!out.ok) {
      if (out.error === 'no_source') throw new DirectStreamError('no_source', `No provider could stream ${refLabel(ref)}.`, { attempts: out.attempts });
      throw new DirectStreamError('resolve_failed', out.detail === '' ? `The resolve could not run: ${out.error}.` : out.detail, { reason: out.error, attempts: out.attempts });
    }
    const hook = this.opts.hooks?.recordResolve;
    if (hook !== undefined) {
      try {
        await hook(ref, out);
      } catch (err) {
        this.log(`[notesd] direct stream: the recordResolve hook failed: ${messageOf(err)}`);
      }
    }
    return out;
  }

  /** runResolve, then the recordResolve hook, then a typed failure. */
  private async resolveSource(ref: StreamRef, deadlineS?: number, skip: readonly string[] = [], only?: string): Promise<ResolvedOutput> {
    const out = await this.runResolve(ref, { ...(deadlineS === undefined ? {} : { deadlineS }), skip, ...(only === undefined ? {} : { only }) });
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

  /**
   * What ffmpeg reads a cloud session's audio from, for Wyzie Synced: this machine's cache of it when the session
   * plays from one (its local playlist; the cache's route fetches what is missing), else the provider's manifest
   * with the headers the resolve captured, as picture.ts hands them over.
   */
  audioInput(id: string): SyncInput {
    const session = this.sessions.peek(id);
    if (session === null) throw new Error('the stream session ended');
    if (session.cache !== null) return { url: `${this.opts.pageBase()}${session.cache.manifestUrl}` };
    const { referer, origin, user_agent: userAgent } = session.source.headers;
    const headers = [referer === null ? null : `Referer: ${referer}`, origin === null ? null : `Origin: ${origin}`].filter((h): h is string => h !== null);
    return {
      url: session.source.manifest_url,
      inputArgs: [...(userAgent === null ? [] : ['-user_agent', userAgent]), ...(headers.length === 0 ? [] : ['-headers', headers.map((h) => `${h}\r\n`).join('')])],
    };
  }

  private async sessionInfo(session: StreamSession): Promise<SessionInfo> {
    const { ref, source, cache, torrent } = session;
    // A cache's or a torrent's files come from their own routes on this daemon, never through the pass-through.
    const local = torrent ?? cache;
    // A cloud session whose source shows no English subtitle gets the title's outside one (outsideSubtitles.ts).
    // /sync-subtitle may have found this provider's own English track wrong and kept a checked file in its place.
    const replaced = torrent === null && (await this.opts.outside?.()?.replaces(ref, source.provider)) === true;
    const shown = <T extends { lang: string | null; label: string }>(tracks: readonly T[]): T[] => (replaced ? tracks.filter((t) => !isEnglish(t) && !showsEnglish([t])) : [...tracks]);
    const lacksEnglish = torrent === null && (replaced || !showsEnglish(cache === null ? source.subtitles : cache.subtitles));
    if (lacksEnglish) await this.opts.outside?.()?.attach(session, () => this.audioInput(session.id));
    const outside = lacksEnglish ? session.outside.subtitles.map(localSubtitle) : [];
    const titleHook = this.opts.hooks?.titleLabel;
    const title = (titleHook === undefined ? null : await this.hookValue('titleLabel', () => titleHook(ref))) ?? refLabel(ref);
    const neighbors = await this.neighborsOf(ref);
    if (torrent !== null) torrent.state = (await this.torrentSource()?.state(torrent)) ?? torrent.state;
    return {
      session_id: session.id,
      kind: ref.kind,
      tmdb_id: ref.tmdbId,
      season: ref.kind === 'tv' ? ref.season : null,
      episode: ref.kind === 'tv' ? ref.episode : null,
      title,
      provider: source.provider,
      manifest_kind: source.manifest_kind,
      manifest_url: local === null ? proxiedUrl(session.id, source.manifest_url) : local.manifestUrl,
      subtitles: [
        ...(local === null
          ? shown(source.subtitles).map((t) => {
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
          : shown(local.subtitles).map(localSubtitle)),
        ...outside,
      ],
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
      torrent:
        torrent === null
          ? null
          : { info_hash: torrent.infoHash, file_index: torrent.fileIndex, name: torrent.name, index: torrent.index, state: torrent.state, seeds: torrent.seeds },
      subtitle_rev: torrent === null ? session.outside.subtitleRev : torrent.subtitleRev,
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
  /** Looks at a stream's picture before it plays (picture.ts); null or unset: nothing is looked at. */
  picture?: PictureCheck | null;
  /** Hears a cloud stream's audio before it plays, for a dub of a foreign film (audioLang.ts); null or unset: nothing is heard. */
  audioCheck?: AudioLangCheck | null;
  /** Torrent phase 3: the torrent source, read at play time (built from phase 1's TorrentStreams after this service). */
  torrent?: () => TorrentSource | null;
  /** An English subtitle from outside the stream for a cloud session that has none, read at play time. */
  outside?: () => OutsideSubtitles | null;
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
    picture: wiring.picture ?? null,
    audioCheck: wiring.audioCheck ?? null,
    torrent: wiring.torrent,
    outside: wiring.outside,
    ahead: ds.ahead === true,
    firstProvider: ds.firstProvider ?? null,
    fetch: overrides.fetch,
    now: overrides.now,
    log: overrides.log,
  });
}
