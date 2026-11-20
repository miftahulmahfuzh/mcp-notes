import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, type Config } from '../config.js';
import { STREAM_HEALTH_OUTCOMES, type StreamHealthOutcome } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { EpisodeAhead, type AheadReport } from './ahead.js';
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
import { MAX_SESSIONS, SESSION_ID_PATTERN, SessionStore, type SessionTorrent, type StreamSession } from './sessions.js';
import { showsEnglish, type OutsideSubtitles } from './outsideSubtitles.js';
import { readMagnet } from './torrent/origins.js';
import { namesCloud, namesTorrent, PREFERRED_TORRENT_HEIGHT, SUBTITLES_PENDING, TORRENT_PROVIDER, type TorrentSource, type TorrentResolve, type TorrentResolveOptions, type MagnetReport } from './torrent/source.js';
import type { TorrentCandidateList } from './torrent/candidates.js';
import type { TorrentMark, TorrentMarks } from './torrent/marks.js';
import { TORRENT_WARP_AUTO, torrentThroughWarp, WARP_ATTEMPT, WarpHolds, type TorrentWarp } from './torrentWarp.js';
import type { WarpSwitch } from '../streaming/warp.js';
import { downloadWarpOf, type DownloadWarp } from './downloads/warp.js';
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
  type ResolvedSource,
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
 * provider seed, which holds the TMDB and IMDb templates.
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
  /**
   * Sets the audio language the title plays in ("en"; null: back to TMDB's original language), which the
   * originalLanguage hook answers from then on. False when it could not be stored.
   */
  setAudioLanguage?: (ref: StreamRef, language: string | null) => Promise<boolean>;
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
  /**
   * The day the film came out, or the episode aired (`2026-12-18`), as TMDB gives it. Null: unknown. A play of a
   * title whose day is still to come asks nothing (`refuseUnreleased`).
   */
  releaseDate?: (ref: StreamRef) => Promise<string | null>;
  /** Every cloud provider (`cloud`) or every torrent (`torrent`) found nothing for the title. */
  channelFailed?: (ref: StreamRef, kind: 'cloud' | 'torrent') => Promise<void>;
  /** A torrent was blacklisted: every title forgets it as the torrent it last played through. The ids of those titles. */
  forgetTorrent?: (infoHash: string) => Promise<string[]>;
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
  /**
   * Counts the times the daemon moved the session to another source by itself (a check behind the play rejected the
   * stream, or a torrent kept stalling: autoSwitch); 0 for a session it never happened to. The answer to a position
   * report carries it too: when it is no longer this number, the page reads the session again and loads its stream at
   * the position the film had reached.
   */
  source_rev: number;
  /** Why the last of those moves was made (`a burned-in watermark`, `the torrent kept stalling`); null before the first. */
  source_note: string | null;
  /**
   * Counts the times the session's seek-preview frames changed (GET /api/stream/sessions/:id/previews); 0 for a session
   * with none yet. The answer to a position report carries it too: when it is higher than the page's, the page fetches
   * the previews again.
   */
  preview_rev: number;
}

/** What `play` answers (JSON-ready; the route adds `ok: true`). */
export interface PlayResult {
  page_url: string;
  session: SessionInfo;
  attempts: ResolveAttempt[];
}

/**
 * A play that went to a streaming site because direct streaming found nothing (`siteFallback`): the site, the
 * title's page there and the streaming command's `play` object. There is no session: the site's own player plays.
 */
export interface SitePlay {
  site: string;
  site_url: string | null;
  site_play: unknown;
}

/** `play`'s answer when the streaming sites played it: every attempt, the direct ones first, then each site asked. */
export interface SitePlayResult extends SitePlay {
  attempts: ResolveAttempt[];
}

/** What a play answers: the player page opened on a direct stream, or a streaming site's player. */
export type PlayAnswer = PlayResult | SitePlayResult;

export function isSitePlay(answer: PlayAnswer): answer is SitePlayResult {
  return 'site' in answer && typeof answer.site === 'string';
}

/**
 * The streaming sites, asked only when a play with no source named found nothing to play through direct streaming
 * (every cloud provider and every torrent): the site the title was last played on, then the others in a fixed
 * order (src/streaming/fallback.ts). `attempt` is called once per site asked, as it ends. Null: no site started it.
 */
export type SiteFallback = (ref: StreamRef, progress: { stage: (words: string) => void; attempt: (attempt: ResolveAttempt) => void }) => Promise<SitePlay | null>;

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
  promise: Promise<PlayAnswer>;
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
/** At most this many such outcomes are kept; the oldest goes first. */
export const PLAY_OUTCOMES_MAX = 50;

export interface SyncSeedResult {
  total: number;
  inserted: number;
  updated: number;
  /** Seed providers the file no longer names, deleted with their health. */
  removed: string[];
  /** Seed providers whose entry changed since their last try here: their failures in a row were set to 0. */
  reset: string[];
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
  /**
   * Cloudflare WARP for a torrent play that found no peer at all on the office network (torrentWarp.ts): a hint, or
   * with `auto` one more ask through WARP. Never for a cloud stream. Unset or null (NOTESD_STREAM_WARP=off, tests): nothing.
   */
  warp?: TorrentWarp | null;
  /** How long a play waits for the stream checks before it opens; default CHECK_HEAD_MS (a test's seam). */
  checkHeadMs?: number;
  /**
   * The streaming sites, the last resort of a play with no provider, codename or magnet named, after every cloud
   * provider and every torrent found nothing. Unset or null: such a play fails as it always did.
   */
  siteFallback?: SiteFallback | null;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * True when a play ended with nothing to play: every cloud provider and every torrent found nothing (`no_source`), or
 * the cloud resolve could not run and the torrents found nothing either (`resolve_failed`). Not for a title that is
 * not out yet: a site's copy of it is a trailer or a fake too.
 */
function nothingToPlay(err: unknown): err is DirectStreamError {
  if (!(err instanceof DirectStreamError) || (err.code !== 'no_source' && err.code !== 'resolve_failed')) return false;
  return !err.attempts.some((a) => a.provider === NOT_RELEASED);
}

/** `work`'s answer when it comes within `ms`, else null; `work` goes on either way. */
async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A pasted magnet as a play's key reads it: its info hash, or the text itself when it names none (the play then fails by itself). */
function magnetKey(magnet: string): string {
  try {
    return readMagnet(magnet)?.infoHash ?? magnet.trim().toLowerCase();
  } catch {
    return magnet.trim().toLowerCase();
  }
}

/** One play in flight per title (a film, an episode), named provider and pasted magnet: another magnet for the same title is another play. */
export function playKey(ref: StreamRef, provider: string | null, magnet: string | null = null): string {
  const title = `${ref.kind}-${ref.tmdbId}${ref.kind === 'tv' ? `-${ref.season}-${ref.episode}` : ''}`;
  return `${title}|${(provider ?? '').trim().toLowerCase()}${magnet === null ? '' : `|${magnetKey(magnet)}`}`;
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
/**
 * How long a play waits for the stream checks (picture.ts, audioLang.ts) of the stream it is about to open. A kept
 * verdict answers at once; a look that takes longer finishes behind the play and keeps its verdict for the next one.
 */
export const CHECK_HEAD_MS = 4_000;
/** What a resolved attempt's detail says while its checks still run behind the play; the verdicts take its place once they are in. */
export const CHECKS_PENDING = 'checks: running behind the play';

/** A provider nothing has resolved yet, for a delivery verdict that outlived its health row. */
/** The one attempt of a play refused because the title is not out yet. */
export const NOT_RELEASED = 'Release date';

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

/** How many times one play may be moved to another source by the daemon itself (autoSwitch); then it is left as it is. */
export const MAX_AUTO_SWITCHES = 2;

/** Why the player page asks for another source by itself: the film keeps stalling, or the stream cannot be played at all. */
export type AutoAsk = 'stalled' | 'broken';

/** switchSource's answer: the session as it is now, and whether it moved to another provider. */
export interface SwitchSourceAnswer {
  switched: boolean;
  /**
   * Why not: `cached`, `no_other_source`; for a move the page asked for by itself (`auto`) also `named_provider` (the
   * owner named the provider), `switching` (another move runs), `limit` (MAX_AUTO_SWITCHES made) and `delivering`
   * (a torrent whose swarm keeps up with the film's bitrate, or whose file is whole: its stalls are not the swarm's).
   */
  reason: 'cached' | 'no_other_source' | 'named_provider' | 'switching' | 'limit' | 'delivering' | null;
  /** The provider the player was on when it asked. */
  from: string;
  session: SessionInfo;
}

/** `from` in leaveCache's answer: the session was on this machine's cache, not on a provider. */
export const CACHE_SOURCE = 'cache';

/** What a player page whose session the daemon lost says of its play (continueSession). */
export interface ContinueFrom {
  /** The session id the page holds. */
  was?: string | null;
  /** The provider it streamed from; ignored for a torrent. */
  provider?: string | null;
  /** The torrent it played, lower-case hex. */
  infoHash?: string | null;
  /** Where the film is, in seconds: the new session starts there. */
  positionS?: number | null;
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
  private readonly outcomes = new Map<string, { at: number; result: PlayAnswer | null; error: unknown }>();
  /** The session made for a page whose own session a restart ended, by the id that page holds; and those being made (continueSession). */
  private readonly continued = new Map<string, string>();
  private readonly continuing = new Map<string, Promise<StreamSession>>();
  /** The torrent asks holding WARP on (torrentWarp.ts): the last to let go puts back what this service switched on. */
  private readonly warpHolds: WarpHolds | null;
  /** The next episode, fetched while this one plays; null when the daemon does not (ahead.ts). */
  private readonly ahead: EpisodeAhead | null;

  constructor(private readonly opts: DirectStreamServiceOptions) {
    this.repo = opts.repo;
    this.warpHolds = opts.warp == null ? null : new WarpHolds(opts.warp.switch);
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
  watched(id: string, report: AheadReport): void {
    const session = this.ahead === null ? null : this.sessions.peek(id);
    if (session === null) return;
    // A cache holds HLS and plain files: a DASH stream's next episode would most likely resolve to the same provider.
    const cacheable = session.cache !== null || session.source.manifest_kind !== 'dash';
    this.ahead?.watched({ id: session.id, ref: session.ref, via: session.torrent !== null ? 'torrent' : 'cloud', cacheable }, report);
  }

  /** What a download's torrent search needs of a title (src/directStream/downloads/): its original language, IMDb id, names and year. */
  async downloadFacts(ref: StreamRef): Promise<Pick<TorrentResolveOptions, 'audioLang' | 'imdbId' | 'names'>> {
    const namesHook = this.opts.hooks?.titleNames;
    return {
      audioLang: await this.audioLang(ref),
      imdbId: await this.imdbIdOf(ref),
      names: namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref)),
    };
  }

  /**
   * The info hashes of the torrents stream sessions hold in the swarm now: a play from a torrent, on screen or being
   * reloaded. A replay from disk holds none (it joins no swarm). Downloads give way to these (play first).
   */
  torrentsOnScreen(): string[] {
    const out: string[] = [];
    for (const session of this.sessions.live()) if (session.torrent !== null && session.torrent.held) out.push(session.torrent.infoHash);
    return out;
  }

  /** The next episode a torrent is fetched for now (ahead.ts), for the Cache page; null without `ahead` or with none held. */
  aheadFetching(): StreamRef | null {
    return this.ahead?.fetching() ?? null;
  }

  get host(): string {
    return this.opts.host;
  }

  /** Loads the seed files into the registry (insert missing, update changed seed rows, delete seed rows the files no longer name). */
  async syncSeed(): Promise<SyncSeedResult> {
    const animeFile = this.opts.animeSeedFile ?? null;
    const entries = [...(await readSeedFile(this.opts.seedFile)), ...(animeFile === null ? [] : await readSeedFile(animeFile))];
    const { inserted, updated, removed, reset } = await this.repo.syncSeed(entries, this.now());
    return { total: entries.length, inserted, updated, removed, reset };
  }

  /**
   * Resolves the title and makes a session for it. Throws `no_source` (every attempt in `attempts`) or
   * `resolve_failed` (with `reason`; `deadline` when `deadlineS` cut it short). The recordResolve hook
   * has run before this returns or throws. Always resolves: a cache is `play`'s business, and
   * `subtitleText` needs a resolved source.
   */
  async resolve(input: StreamRefInput, options: { resumeS?: number | null; deadlineS?: number; only?: string; vet?: boolean; waiting?: boolean; skip?: readonly string[] } = {}): Promise<StreamSession> {
    const ref = toStreamRef(input);
    const left = options.skip ?? [];
    // Something is about to be watched or kept: not of a title that is not out yet.
    if (options.vet === true) await this.refuseUnreleased(ref);
    // `vet`: something is about to be watched or kept (a play, a cache), so the stream is looked at (picture.ts,
    // audioLang.ts). Not for a provider the owner named, and not for a resolve that only reads a subtitle.
    // `waiting`: somebody waits for the player page, so the checks get CHECK_HEAD_MS and finish behind the play.
    const vet = options.vet === true && options.only === undefined;
    const headMs = options.waiting === true ? (this.opts.checkHeadMs ?? CHECK_HEAD_MS) : null;
    const { out, late } = vet
      ? await this.vetted(ref, left, (skip, later) => (later ? this.resolveQuietly(ref, skip) : this.resolveSource(ref, options.deadlineS, skip)), headMs)
      : { out: await this.resolveSource(ref, options.deadlineS, left, options.only), late: null };
    const resumeS = await this.startAt(ref, options.resumeS ?? null);
    const session = this.sessions.create(ref, out.source, out.attempts, resumeS, await this.audioLang(ref));
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    // Checks that outlasted the head: what they said takes the place of `checks: running behind the play` in the session's attempts.
    if (late !== null) {
      const provider = out.source.provider;
      void late.then((done) => {
        session.attempts = session.attempts.map((a) => (a.detail.includes(CHECKS_PENDING) ? { ...a, detail: a.detail.replace(CHECKS_PENDING, done.said) } : a));
        if (done.bad) this.rejectedBehind(session, provider, done);
      });
    }
    return session;
  }

  /**
   * Opens this daemon's player page for the title full screen in the streaming Chrome. This host's
   * cache of the title (phase 5), when it can be played (`playable`), makes the session with no
   * resolve; otherwise the title is resolved first, as before.
   */
  async play(input: StreamRefInput, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null } = {}): Promise<PlayAnswer> {
    return this.begin(toStreamRef(input), options).promise;
  }

  /**
   * `play`, answered within `waitMs`: a caller with a time limit of its own (an MCP client gives a tool call about
   * 60 s) gets `pending` with the stage and the attempts so far instead of nothing. The play goes on in the daemon
   * and opens the player by itself; the same call again joins it, or reads its outcome once it has one.
   */
  async playWithin(input: StreamRefInput, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null }, waitMs: number): Promise<{ pending: false; result: PlayAnswer } | PendingPlay> {
    const ref = toStreamRef(input);
    const key = playKey(ref, options.provider ?? null, options.magnet ?? null);
    this.sweepOutcomes();
    const kept = this.outcomes.get(key);
    if (kept !== undefined && !this.inFlightNow(key)) {
      // Read once. A session's outcome only while that session lives: an ask after its play ended starts a new play.
      this.outcomes.delete(key);
      const result = kept.result;
      if (result === null) throw kept.error;
      if (isSitePlay(result) || this.sessions.get(result.session.session_id) !== null) return { pending: false, result };
    }
    const entry = this.begin(ref, options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, waitMs));
    });
    // A caller that gets the outcome here takes it: the copy kept for a later ask is dropped, or a new ask of the same
    // play (another try of a pasted magnet a minute later) would read this answer again and start nothing.
    let result: PlayAnswer | null;
    try {
      result = await Promise.race([entry.promise, late]).finally(() => clearTimeout(timer));
    } catch (err) {
      this.outcomes.delete(key);
      throw err;
    }
    if (result !== null) {
      this.outcomes.delete(key);
      return { pending: false, result };
    }
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
    const key = playKey(ref, provider, options.magnet ?? null);
    const running = this.inFlight.get(key);
    if (running !== undefined && this.inFlightNow(key)) return running;
    const entry: PlayInFlight = {
      ref,
      provider,
      title: refLabel(ref),
      since: this.now(),
      stage: 'starting',
      attempts: [],
      promise: Promise.resolve(null as unknown as PlayAnswer),
      waited: false,
      opened: null,
      failed: false,
      naming: false,
    };
    this.nameIt(entry);
    entry.promise = this.playNow(ref, options, entry).then(
      (result) => {
        if (isSitePlay(result)) {
          // A streaming site's own player plays it: no page of this daemon will report, so the play is no longer starting.
          entry.opened = { sessionId: '', at: this.now().getTime() };
          entry.stage = `playing on ${result.site}`;
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
        } else {
          entry.opened = { sessionId: result.session.session_id, at: this.now().getTime() };
          entry.stage = 'opened: waiting for the player page';
        }
        if (entry.waited) this.keepOutcome(key, result, null);
        return result;
      },
      (err: unknown) => {
        entry.failed = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
        this.logFailedPlay(entry, err);
        if (entry.waited) this.keepOutcome(key, null, err);
        throw err;
      },
    );
    // A caller answered `pending` no longer waits: the failure was logged above.
    entry.promise.catch(() => undefined);
    this.inFlight.set(key, entry);
    return entry;
  }

  /** Keeps the outcome of a play answered `pending` for its next ask: for PLAY_OUTCOME_KEEP_MS, and never more than PLAY_OUTCOMES_MAX of them. */
  private keepOutcome(key: string, result: PlayAnswer | null, error: unknown): void {
    this.sweepOutcomes();
    this.outcomes.delete(key);
    this.outcomes.set(key, { at: this.now().getTime(), result, error });
    // A Map lists its keys oldest first: the outcomes nobody came back for go first.
    for (const oldest of this.outcomes.keys()) {
      if (this.outcomes.size <= PLAY_OUTCOMES_MAX) break;
      this.outcomes.delete(oldest);
    }
  }

  /** Drops the kept outcomes nobody asked for again within PLAY_OUTCOME_KEEP_MS. */
  private sweepOutcomes(): void {
    const now = this.now().getTime();
    for (const [key, kept] of this.outcomes) if (now - kept.at >= PLAY_OUTCOME_KEEP_MS) this.outcomes.delete(key);
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

  /**
   * The play: direct streaming, and when that found nothing to play and no source was named, the streaming sites
   * (`siteFallback`). It runs inside the play in flight, so a caller answered `pending` gets the site's outcome on its
   * next ask, a second ask joins it, and `starting()` lists the play until a site's player starts or every site failed.
   */
  private async playNow(ref: StreamRef, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null }, track: PlayTrack): Promise<PlayAnswer> {
    const fallback = this.opts.siteFallback ?? null;
    if (fallback === null || (options.provider ?? null) !== null || (options.magnet ?? null) !== null) return this.playDirect(ref, options, track);
    try {
      return await this.playDirect(ref, options, track);
    } catch (err) {
      if (!nothingToPlay(err)) throw err;
      return this.playOnSites(ref, err, fallback, track);
    }
  }

  /** The streaming sites, after direct streaming failed with `failure`. Throws `failure` again, with each site's attempt added, when none started it. */
  private async playOnSites(ref: StreamRef, failure: DirectStreamError, fallback: SiteFallback, track: PlayTrack): Promise<SitePlayResult> {
    const sites: ResolveAttempt[] = [];
    track.attempts = [...failure.attempts];
    track.stage = 'asking the streaming sites: no cloud provider or torrent could stream it';
    this.log(`[notesd] direct stream: no cloud provider or torrent could stream ${refLabel(ref)}; asking the streaming sites`);
    let played: SitePlay | null = null;
    try {
      played = await fallback(ref, {
        stage: (words) => {
          track.stage = words;
        },
        attempt: (attempt) => {
          sites.push(attempt);
          track.attempts = [...failure.attempts, ...sites];
        },
      });
    } catch (err) {
      this.log(`[notesd] direct stream: the streaming sites could not be asked for ${refLabel(ref)}: ${messageOf(err)}`);
    }
    const attempts = [...failure.attempts, ...sites];
    if (played === null) throw new DirectStreamError(failure.code, failure.message, { ...(failure.reason === null ? {} : { reason: failure.reason }), attempts });
    return { ...played, attempts };
  }

  private async playDirect(ref: StreamRef, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null }, track: PlayTrack): Promise<PlayResult> {
    const resumeS = options.resumeS ?? null;
    // The owner named a provider ("stream it from VidLink"): only that one is asked, and a cache is passed over.
    // "torrent" asks the torrent source alone: a finished download on this machine first, else the swarm.
    // "cloud" asks the cloud providers alone: this host's stream cache first, and never a torrent, on disk or in the swarm.
    const only = options.provider ?? null;
    const magnet = options.magnet ?? null;
    // A magnet is the owner's own word for what to play; anything else of a title not out yet is a trailer or a fake.
    if (magnet === null) await this.refuseUnreleased(ref);
    track.stage = "looking at this machine's cache and downloads";
    let session: StreamSession;
    // The owner pasted a magnet: only that torrent is opened, for the title they named. No index, no cache.
    if (magnet !== null) session = await this.magnetSession(ref, resumeS, magnet, track, true);
    else if (only === null) session = await this.sessionFor(ref, resumeS, track);
    else if (namesTorrent(only)) session = (await this.diskSession(ref, resumeS)) ?? (await this.torrentAgain(ref, resumeS, track));
    else if (namesCloud(only)) session = (await this.cachedSession(ref, resumeS)) ?? (await this.cloudAgain(ref, resumeS, track));
    else session = await this.cloudSession(ref, { resumeS, only }, track);
    // Where an automatic move may take the play: nowhere for a provider named, within the kind for a codename or a magnet.
    session.lock = magnet !== null || (only !== null && namesTorrent(only)) ? 'torrent' : only === null ? null : namesCloud(only) ? 'cloud' : 'provider';
    // The owner's own torrent: a dub heard in it is reported, and the play stays on it.
    if (magnet !== null) session.pastedTorrent = session.torrent?.infoHash ?? null;
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
    return this.lastTorrentOrIndexes(ref, resumeS, last, track);
  }

  /**
   * The torrent that last played this very film or episode (`last`), opened again with no index asked; the indexes
   * are searched when none is remembered for it, or when its swarm has nothing now.
   */
  private async lastTorrentOrIndexes(ref: StreamRef, resumeS: number | null, last: Pick<RememberedChannel, 'infoHash' | 'season' | 'episode'> | null, track: PlayTrack | null): Promise<StreamSession> {
    if (last === null || last.infoHash === null || !sameSlot(ref, last)) return this.torrentSession(ref, resumeS, null, track);
    // Blacklisted since, or heard as a dub of this title: never opened again; the indexes are asked.
    if ((await this.torrentSource()?.leftOutByMarks(await this.audioLang(ref)))?.has(last.infoHash.toLowerCase()) === true) {
      this.log(`[notesd] direct stream: the torrent that played ${refLabel(ref)} last time is blacklisted or was heard as a dub; asking the indexes`);
      return this.torrentSession(ref, resumeS, null, track);
    }
    // 1080p by default: a remembered torrent of a lower height (720p) goes after the indexes' search, not before it.
    const height = (await this.torrentSource()?.releaseHeight(last.infoHash)) ?? null;
    if (height !== null && height !== PREFERRED_TORRENT_HEIGHT) {
      const infoHash = last.infoHash;
      this.log(`[notesd] direct stream: the torrent that played ${refLabel(ref)} last time is ${height}p; asking the indexes for ${PREFERRED_TORRENT_HEIGHT}p first`);
      // One ask, the search then that torrent: WARP is tried once around both, and the title fails only when both did.
      return this.torrentSession(ref, resumeS, null, track, infoHash);
    }
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
  private cloudSession(ref: StreamRef, options: { resumeS?: number | null; only?: string; vet?: boolean; waiting?: boolean; skip?: readonly string[] }, track: PlayTrack | null): Promise<StreamSession> {
    if (track !== null) track.stage = options.only === undefined ? 'asking the cloud providers' : `asking ${options.only}`;
    return this.resolve(ref, options);
  }

  /**
   * How the title was last streamed on this machine (the `channel` hook), or null. A remembered streaming site
   * (`channel: "site"`) means nothing here: a play goes the direct way first, and the site is asked only when that
   * found nothing (`siteFallback`).
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
        return await this.lastTorrentOrIndexes(ref, resumeS, known.channel === 'torrent' ? known : null, track);
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
    await this.recordResolve(ref, out);
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

  /**
   * Every cloud provider but `skip`, for a play: the stream is looked at (picture.ts, audioLang.ts) for CHECK_HEAD_MS
   * at most before the page opens. When none has the title, that is kept (`channelFailed`).
   */
  private async everyCloud(ref: StreamRef, resumeS: number | null, track: PlayTrack | null, skip: readonly string[] = []): Promise<StreamSession> {
    try {
      return await this.cloudSession(ref, { resumeS, vet: true, waiting: true, skip }, track);
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
  private async torrentSession(ref: StreamRef, resumeS: number | null, cloud: DirectStreamError | null, track: PlayTrack | null = null, thenTorrent: string | null = null): Promise<StreamSession> {
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
    const search = (): Promise<TorrentResolve> =>
      source.resolve(ref, {
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
    // `thenTorrent`: the remembered torrent of a lower height, opened with no index asked when the search found none.
    const ask = async (): Promise<TorrentResolve> => {
      const found = await search();
      if (found.ok || thenTorrent === null) return found;
      const last = await source.playMagnet(ref, {
        magnet: thenTorrent,
        audioLang,
        imdbId,
        names,
        resumeS: startS,
        ...(track === null ? {} : { progress: (p) => { track.stage = p.stage; track.attempts = [...before, ...found.attempts, ...p.attempts]; } }),
      });
      return { ...last, attempts: [...found.attempts, ...last.attempts] };
    };
    const out = await this.throughWarp(ref, await ask(), ask);
    const attempts = [...before, ...out.attempts];
    if (!out.ok) {
      await this.failed(ref, 'torrent');
      if (cloud !== null && cloud.code === 'resolve_failed') {
        throw new DirectStreamError('resolve_failed', cloud.message, { ...(cloud.reason === null ? {} : { reason: cloud.reason }), attempts });
      }
      throw new DirectStreamError('no_source', `No provider or torrent could stream ${refLabel(ref)}.`, { attempts });
    }
    const session = this.sessions.createTorrent(ref, out.source, attempts, startS, audioLang, out.torrent);
    this.followTorrent(session);
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
  private async magnetSession(ref: StreamRef, resumeS: number | null, magnet: string, track: PlayTrack | null = null, pasted = false): Promise<StreamSession> {
    const source = this.torrentSource();
    if (source === null) throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).');
    const audioLang = await this.audioLang(ref);
    const imdbId = await this.imdbIdOf(ref);
    const namesHook = this.opts.hooks?.titleNames;
    const names = namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref));
    const startS = await this.startAt(ref, resumeS);
    const ask = (): Promise<TorrentResolve> =>
      source.playMagnet(ref, {
        magnet,
        pasted,
        audioLang,
        imdbId,
        names,
        resumeS: startS,
        ...(track === null ? {} : { progress: (p) => { track.stage = p.stage; track.attempts = [...p.attempts]; } }),
      });
    const out = await this.throughWarp(ref, await ask(), ask);
    if (!out.ok) throw new DirectStreamError('no_source', `The pasted torrent could not stream ${refLabel(ref)}.`, { attempts: out.attempts });
    const session = this.sessions.createTorrent(ref, out.source, out.attempts, startS, audioLang, out.torrent);
    this.followTorrent(session);
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
    this.followTorrent(session);
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /**
   * A torrent session answered while its subtitle chain still runs (`Subtitles: pending`): once the chain ends its
   * attempts take that one's place in the session's, so a snapshot of the session says what the subtitles cost.
   */
  private followTorrent(session: StreamSession): void {
    this.hearTorrent(session);
    this.followSubtitles(session);
  }

  /**
   * The torrent audio check, behind the play: a session's torrent whose file tags no audio language (or only `und`)
   * is heard through Whisper (TorrentSource.hearAudio), for any title whose original language is known (English too:
   * a Russian voice-over of an English series is the case it is for). What was heard goes into the torrent's attempt
   * and its marks. A dub moves the play by itself at the page's next report of the film playing (autoSwitch), and the
   * torrent is not chosen again for the title; a torrent the owner pasted stays, the dub said in its attempt.
   */
  private hearTorrent(session: StreamSession): void {
    const torrent = session.torrent;
    const source = this.torrentSource();
    const audioLang = session.audioLang;
    if (torrent === null || source === null || audioLang === null || !source.hears) return;
    if ((session.source.audio?.languages.length ?? 0) > 0) return;
    const label = `${TORRENT_PROVIDER}: ${torrent.name}`;
    void source.hearAudio(torrent, audioLang, session.resumeS ?? null).then((heard) => {
      if (heard === null || session.torrent !== torrent) return;
      const said = `audio heard: ${heard.verdict} (${heard.reason})`;
      session.attempts = session.attempts.map((a) => (a.provider === label && a.outcome === 'resolved' ? { ...a, detail: a.detail === '' ? said : `${a.detail}; ${said}` } : a));
      if (heard.verdict !== 'dubbed') return;
      source.noteDubbed(session.ref, torrent.infoHash, heard.reason);
      if (session.pastedTorrent === torrent.infoHash) {
        this.log(`[notesd] direct stream: ${refLabel(session.ref)} keeps the pasted torrent ${torrent.name}, though it was heard as a dub (${heard.reason})`);
        return;
      }
      session.pendingMove = `dubbed audio (heard ${heard.detected ?? 'another language'})`;
    });
  }

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

  /**
   * A torrent ask that found no peer at all, on the office network with WARP off (torrentWarp.ts): a hint in the
   * answer, or with the automatic flip WARP on and one more ask, the failed swarms tried again. Anything else as is.
   */
  private async throughWarp(ref: StreamRef, out: TorrentResolve, again: () => Promise<TorrentResolve>): Promise<TorrentResolve> {
    const warp = this.opts.warp ?? null;
    if (out.ok || warp === null || this.warpHolds === null) return out;
    const next = await torrentThroughWarp(warp, this.warpHolds, out, () => {
      this.torrentSource()?.forgetNoPeers(ref);
      return again();
    });
    const added = next.attempts.find((a) => a.provider === WARP_ATTEMPT);
    if (added !== undefined) this.log(`[notesd] direct stream: ${refLabel(ref)}: WARP: ${added.outcome}: ${added.detail}`);
    return next;
  }

  /**
   * Cloudflare WARP as a torrent download uses it (downloads/warp.ts): this service's one WarpHolds, so a play and a
   * download hold WARP together and the last to let go puts back what this service switched on, plus the switch's
   * status, read only. Never the switch itself: a download cannot `set` WARP. Null with NOTESD_STREAM_WARP=off, or
   * without the automatic flip.
   */
  warpForDownloads(): DownloadWarp | null {
    const warp = this.opts.warp ?? null;
    if (warp === null || !warp.auto || this.warpHolds === null) return null;
    return downloadWarpOf(this.warpHolds, warp.switch);
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
    // Nor is its kept outcome an answer any more: the next ask of that play starts it again.
    for (const [key, kept] of this.outcomes) if (kept.result !== null && !isSitePlay(kept.result) && kept.result.session.session_id === id) this.outcomes.delete(key);
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

  /** The live session, without marking it used (the seek previews' background work must not keep a session alive); null for an unknown or ended id. */
  peek(id: string): StreamSession | null {
    return this.sessions.peek(id);
  }

  /** The fetch the pass-through uses (a test's injected one included): the seek previews' provider source reads a track through forward() with it. */
  get passThroughFetch(): FetchLike {
    return this.fetchImpl;
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
  async switchSource(id: string, options: { auto?: AutoAsk } = {}): Promise<SwitchSourceAnswer> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    // The page asks by itself: the daemon's rules for a move nobody asked for (autoSwitch).
    if (options.auto !== undefined && session.cache === null) {
      const stalled = options.auto === 'stalled';
      const why = stalled ? (session.torrent !== null ? 'the torrent kept stalling' : 'the stream kept stalling') : 'the stream stopped playing';
      if (stalled) this.ahead?.stalled(session.id);
      return this.autoSwitch(session, why, stalled ? 'stall' : 'broken');
    }
    // The stream on screen cannot keep up: a next episode being cached beside it stops.
    this.ahead?.stalled(session.id);
    if (session.cache !== null) return { switched: false, reason: 'cached', from: session.source.provider, session: await this.sessionInfo(session) };
    if (session.torrent !== null) return this.nextTorrent(session, session.torrent);
    const from = session.source.provider;
    let out: ResolvedOutput;
    try {
      // The next provider's picture is looked at too: the owner leaves a cinema recording for a proper copy, not for the next recording.
      out = (await this.vetted(session.ref, [...session.avoid, from], (skip) => this.resolveQuietly(session.ref, skip), null)).out;
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
   * A check that finished behind the play (picture.ts, audioLang.ts) rejected the stream the session plays: the move to
   * another source waits for the page's next report of the film playing (`reported`), so a paused play is never moved.
   * Nothing when the session has left that provider already. The verdict itself is kept by the check, as always.
   */
  private rejectedBehind(session: StreamSession, provider: string, done: { said: string; why: string }): void {
    if (session.cache !== null || session.torrent !== null || session.source.provider !== provider) return;
    if (session.lock === 'provider') {
      this.log(`[notesd] direct stream: ${refLabel(session.ref)} keeps ${provider}, which the owner named, though its check found ${done.why}`);
      return;
    }
    session.pendingMove = done.why;
  }

  /**
   * A position report of the session's page (the position route): a move a check behind the play asked for
   * (`rejectedBehind`) is carried out now, while the film plays. Never for a paused page, a closing one or an
   * unknown id; the page learns of the move from `source_rev` in a later report's answer.
   */
  reported(id: string, report: { paused: boolean; over: boolean }): void {
    const session = this.sessions.peek(id);
    if (session === null || session.pendingMove === null || report.paused || report.over || session.moving) return;
    const why = session.pendingMove;
    session.pendingMove = null;
    void this.autoSwitch(session, why, 'verdict').catch((err: unknown) => this.log(`[notesd] direct stream: the move of ${refLabel(session.ref)} away from ${session.source.provider} failed: ${messageOf(err)}`));
  }

  /** What the session plays from, for a log line: the provider, `Torrent: <release>` or the cache. */
  private sourceName(session: StreamSession): string {
    if (session.torrent !== null) return `${TORRENT_PROVIDER}: ${session.torrent.name}`;
    return session.cache !== null ? `the cache ${session.cache.id}` : session.source.provider;
  }

  /**
   * A move nobody asked for, under the same session id: a check behind the play rejected the stream (`verdict`), or
   * the page says the film keeps stalling (`stall`) or cannot be played (`broken`). The next good source of the same
   * title: from a cloud provider another cloud provider (looked at whole, passing over the rejected ones), then a
   * torrent; from a torrent the next torrent (the stalled one left out), then a cloud provider. A play the owner started
   * with a provider named never moves; a codename or a magnet keeps the play within its kind. One move at a time, at most
   * MAX_AUTO_SWITCHES per session; a torrent whose swarm keeps up with the film's bitrate, or whose file is whole, is
   * not moved for its stalls. The page loads the new source at the position it reached (it reads `source_rev`). One
   * log line per move, with the reason.
   */
  private async autoSwitch(session: StreamSession, why: string, cause: 'verdict' | 'stall' | 'broken'): Promise<SwitchSourceAnswer> {
    const from = this.sourceName(session);
    const keep = async (reason: NonNullable<SwitchSourceAnswer['reason']>): Promise<SwitchSourceAnswer> => ({ switched: false, reason, from, session: await this.sessionInfo(session) });
    if (session.lock === 'provider') return keep('named_provider');
    if (session.moving) return keep('switching');
    if (session.autoSwitches >= MAX_AUTO_SWITCHES) {
      this.log(`[notesd] direct stream: ${refLabel(session.ref)} stays on ${from} (${why}): it was moved ${MAX_AUTO_SWITCHES} times by itself already`);
      return keep('limit');
    }
    const torrent = session.torrent;
    const source = this.torrentSource();
    if (cause === 'stall' && torrent !== null && source !== null) {
      // A torrent buffers while it fills: only a swarm that cannot keep up with the film is left.
      const onDisk = (await source.state(torrent)) === 'ready';
      const d = source.delivery(torrent);
      if (onDisk || (d !== null && d.filmKbps !== null && d.downKbps >= d.filmKbps)) {
        this.log(`[notesd] direct stream: ${refLabel(session.ref)} stalls on ${from}, which ${onDisk ? 'is whole on disk' : `delivers ${d?.downKbps} kbit/s for a ${d?.filmKbps} kbit/s film`}: not moved`);
        return keep('delivering');
      }
    }
    session.moving = true;
    try {
      const moved = torrent !== null ? await this.awayFromTorrent(session, torrent) : await this.awayFromCloud(session);
      if (!moved) {
        this.log(`[notesd] direct stream: ${refLabel(session.ref)} stays on ${from} (${why}): no other source plays it now`);
        return keep('no_other_source');
      }
      session.autoSwitches += 1;
      session.sourceRev += 1;
      session.sourceNote = why;
      safeRecord(this.evidence, sessionRecord(session, 'switched', null));
      this.log(`[notesd] direct stream: ${refLabel(session.ref)} switched by itself from ${from} to ${this.sourceName(session)} (${why}; ${session.autoSwitches} of ${MAX_AUTO_SWITCHES})`);
      return { switched: true, reason: null, from, session: await this.sessionInfo(session) };
    } finally {
      session.moving = false;
    }
  }

  /**
   * autoSwitch from a cloud provider: the other cloud providers, each stream looked at whole (a recording or a dub is
   * passed over, and the move is made only to one that passed), then, unless the play is held to the cloud, the
   * torrents. True when the session moved.
   */
  private async awayFromCloud(session: StreamSession): Promise<boolean> {
    const ref = session.ref;
    const from = session.source.provider;
    try {
      const { out, passed } = await this.vetted(ref, [...session.avoid, from], (skip) => this.resolveQuietly(ref, skip), null);
      if (passed) {
        session.avoid.push(from);
        this.sessions.replaceSource(session, out.source, out.attempts);
        return true;
      }
    } catch {
      // No other cloud provider: the torrents, below.
    }
    if (session.lock === 'cloud') return false;
    const out = await this.torrentFor(ref, session.audioLang, []);
    if (!out.ok) return false;
    session.avoid.push(from);
    this.sessions.replaceTorrent(session, out.source, out.torrent, out.attempts);
    this.followTorrent(session);
    this.watchTorrents();
    return true;
  }

  /**
   * autoSwitch from a torrent: the session's other candidates (chooseOrder: a swarm that delivers first, then 1080p),
   * else the indexes asked again, the stalled torrent left out; then, unless the play is held to the torrents, the
   * cloud providers, looked at whole. True when the session moved.
   */
  private async awayFromTorrent(session: StreamSession, torrent: SessionTorrent): Promise<boolean> {
    const ref = session.ref;
    const source = this.torrentSource();
    if (source !== null && session.lock !== 'cloud') {
      source.noteStalled(ref, torrent.infoHash);
      let out = await source.next(ref, torrent, session.audioLang);
      if (!out.ok) out = await this.torrentFor(ref, session.audioLang, [torrent.infoHash]);
      if (out.ok) {
        this.letGoTorrent(session);
        this.sessions.replaceTorrent(session, out.source, out.torrent, out.attempts);
        this.followTorrent(session);
        this.watchTorrents();
        return true;
      }
    }
    if (session.lock === 'torrent') return false;
    try {
      const { out, passed } = await this.vetted(ref, session.avoid, (skip) => this.resolveQuietly(ref, skip), null);
      if (!passed) return false;
      this.letGoTorrent(session);
      this.sessions.replaceSource(session, out.source, out.attempts);
      return true;
    } catch {
      return false;
    }
  }

  /** The indexes asked for the title's torrents while a play goes on, `skip` left out. Torrents off: `no_source`. */
  private async torrentFor(ref: StreamRef, audioLang: string | null, skip: readonly string[]): Promise<TorrentResolve> {
    const source = this.torrentSource();
    if (source === null) return { ok: false, error: 'no_source', attempts: [] };
    const namesHook = this.opts.hooks?.titleNames;
    return source.resolve(ref, {
      audioLang,
      imdbId: await this.imdbIdOf(ref),
      names: namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref)),
      resumeS: null,
      cloudTried: true,
      skip,
    });
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
    this.followTorrent(session);
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
   * The player page holds a session this daemon does not know: the daemon restarted while the film played
   * (sessions live in memory). The page says what it was playing (`was`: its session id; the provider, or the
   * torrent's info hash; where the film is) and gets a fresh session for the same source, with no page opened:
   *
   * - a torrent: this host's finished download, else that very torrent again with no index asked;
   * - anything else: this host's stream cache of the title (ready or downloading), else the provider it streamed
   *   from, asked alone;
   * - and when that has nothing now, what a play with no source named does (`sessionFor`).
   *
   * `continued: false`: the page's session is still alive here (the daemon was only slow to answer), and it is
   * answered as it is. One session per `was`: a second ask of the same page joins the first or gets its session.
   * Throws what a play throws (`no_source`, `resolve_failed`, `torrent_off`).
   */
  async continueSession(input: StreamRefInput, from: ContinueFrom = {}): Promise<{ continued: boolean; session: SessionInfo }> {
    const ref = toStreamRef(input);
    const was = from.was ?? null;
    if (was !== null) {
      const alive = this.sessions.get(was);
      if (alive !== null) return { continued: false, session: await this.sessionInfo(alive) };
      const made = this.sessions.get(this.continued.get(was) ?? '');
      if (made !== null) return { continued: true, session: await this.sessionInfo(made) };
    }
    const key = was ?? playKey(ref, null);
    let run = this.continuing.get(key);
    if (run === undefined) {
      // A play being started all the while (a torrent can take 90 s): `starting()` lists it, so the player route says
      // busy and no restart ends it. Cleared once the new session exists or the continue failed.
      const flightKey = `continue|${key}`;
      const entry: PlayInFlight = {
        ref,
        provider: from.provider ?? null,
        title: refLabel(ref),
        since: this.now(),
        stage: 'carrying on after a restart',
        attempts: [],
        promise: Promise.resolve(null as unknown as PlayAnswer),
        waited: false,
        opened: null,
        failed: false,
        naming: false,
      };
      this.nameIt(entry);
      this.inFlight.set(flightKey, entry);
      run = this.sessionAgain(ref, from).finally(() => {
        this.continuing.delete(key);
        if (this.inFlight.get(flightKey) === entry) this.inFlight.delete(flightKey);
      });
      this.continuing.set(key, run);
    }
    const session = await run;
    if (was !== null) {
      this.continued.set(was, session.id);
      if (this.continued.size > MAX_SESSIONS) this.continued.delete(this.continued.keys().next().value as string);
    }
    this.log(
      `[notesd] direct stream: ${refLabel(ref)} carries on${session.resumeS === null ? '' : ` at ${Math.round(session.resumeS)} s`} after a restart, ${
        session.torrent !== null ? `from the torrent ${session.torrent.name}` : session.cache === null ? `from ${session.source.provider}` : `from the cache ${session.cache.id}`
      }`,
    );
    return { continued: true, session: await this.sessionInfo(session) };
  }

  /** continueSession's session: the source the page was on first, then what a play with no source named finds. */
  private async sessionAgain(ref: StreamRef, from: ContinueFrom): Promise<StreamSession> {
    const resumeS = from.positionS !== null && from.positionS !== undefined && from.positionS > 0 ? from.positionS : null;
    const marked = from.infoHash == null ? false : ((await this.torrentSource()?.leftOutByMarks(await this.audioLang(ref)))?.has(from.infoHash.toLowerCase()) ?? false);
    // A torrent blacklisted, or heard as a dub, since: the play carries on the way a new one would.
    const hash = marked ? null : (from.infoHash ?? null);
    if (hash !== null && this.torrentSource() !== null) {
      const disk = await this.diskSession(ref, resumeS);
      if (disk !== null) return disk;
      try {
        return await this.magnetSession(ref, resumeS, hash);
      } catch (err) {
        if (!(err instanceof DirectStreamError) || err.code !== 'no_source') throw err;
        this.log(`[notesd] direct stream: the torrent ${refLabel(ref)} played before the restart does not play now; asking as a new play does`);
        return this.after(err.attempts, () => this.sessionFor(ref, resumeS));
      }
    }
    const cached = await this.cachedSession(ref, resumeS);
    if (cached !== null) return cached;
    const provider = from.provider ?? null;
    if (hash === null && provider !== null && provider !== TORRENT_PROVIDER) {
      const tried: ResolveAttempt[] = [];
      const again = await this.rememberedCloud(ref, provider, resumeS, null, tried);
      if (again !== null) return again;
      return this.after(tried, () => this.resolveOrTorrent(ref, resumeS, null, [provider]));
    }
    return this.sessionFor(ref, resumeS);
  }

  /**
   * The player says a play from this machine's cache keeps stalling, or cannot be played at all: the session
   * leaves the cache for the live stream of the same title, under the same id (the reverse of `cacheSession`'s
   * move). The provider the cache was downloaded from is asked alone first, then the others; the recordResolve
   * hook runs only for a resolve that found a source. The cache and its download are left as they are.
   * `switched: false` with `no_other_source` leaves the session on the cache. A session not on a cache is
   * `switchSource`'s. Throws `unknown_session`.
   */
  async leaveCache(id: string): Promise<SwitchSourceAnswer> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const cache = session.cache;
    if (cache === null) return this.switchSource(id);
    this.ahead?.stalled(session.id);
    const provider = session.source.provider;
    let out: ResolveOutput = await this.runResolve(session.ref, { only: provider });
    if (out.ok) {
      const hook = this.opts.hooks?.recordResolve;
      if (hook !== undefined) await this.hookValue('recordResolve', async () => (await hook(session.ref, out), null));
    } else {
      try {
        const skip = [...session.avoid, provider];
        out = await this.resolveQuietly(session.ref, [...skip, ...(await this.rejectedProviders(session.ref, skip))]);
      } catch (err) {
        this.log(`[notesd] direct stream: ${refLabel(session.ref)} stalls on the cache ${cache.id} and no provider streams it now (${err instanceof DirectStreamError ? (err.reason ?? err.code) : messageOf(err)})`);
        return { switched: false, reason: 'no_other_source', from: CACHE_SOURCE, session: await this.sessionInfo(session) };
      }
    }
    if (!out.ok) return { switched: false, reason: 'no_other_source', from: CACHE_SOURCE, session: await this.sessionInfo(session) };
    this.sessions.replaceSource(session, out.source, out.attempts);
    safeRecord(this.evidence, sessionRecord(session, 'switched', null));
    this.log(`[notesd] direct stream: ${refLabel(session.ref)} left the cache ${cache.id} for the stream of ${out.source.provider} (the cached play stalled)`);
    return { switched: true, reason: null, from: CACHE_SOURCE, session: await this.sessionInfo(session) };
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
   * /update-cloud-source <magnet>: what a pasted magnet says of its index, its swarm as the trackers know it, and
   * its public trackers kept for every later torrent (TorrentSource.learnMagnet). Joins no swarm. Throws `torrent_off`.
   */
  async learnMagnet(magnet: string): Promise<MagnetReport> {
    const source = this.torrentSource();
    if (source === null) throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).');
    return source.learnMagnet(magnet);
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
   * `headMs` is how long the caller waits for the two checks of one stream (a play: somebody waits for the
   * page); null waits for them whole (a cache, the shuffle button, which runs while the film plays on). Checks
   * that outlast it finish behind the play: the stream is answered with `checks: running behind the play`, the
   * verdict is kept as always, so the next play passes a rejected provider over from the start, and `late`
   * resolves with what they said. Only a verdict rejects: a stream no frame or no audio could be read from,
   * and one nobody could judge, plays, and never costs another round.
   *
   * The audio check is only run on this cloud path, and only when the title's original language is known
   * and is not English (there is no dub into English of an English film to hear).
   */
  private async vetted(
    ref: StreamRef,
    skip: readonly string[],
    one: (skip: readonly string[], later: boolean) => Promise<ResolvedOutput>,
    headMs: number | null,
  ): Promise<{ out: ResolvedOutput; late: Promise<{ said: string; bad: boolean; why: string }> | null; passed: boolean }> {
    const picture = this.opts.picture ?? null;
    const audio = this.opts.audioCheck ?? null;
    const original = audio === null ? null : await this.audioLang(ref);
    const heard = audio !== null && original !== null && normalizeAudioLang(original) !== 'en' ? { audio, original } : null;
    if (picture === null && heard === null) return { out: await one(skip, false), late: null, passed: true };
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
        return { out: await one(skip, true), late: null, passed: false };
      }
      const provider = out.source.provider;
      const looking = this.lookAt(ref, out.source, title, picture, heard);
      const look = headMs === null ? await looking : await withinMs(looking, headMs);
      const said = look === null ? CHECKS_PENDING : look.said;
      const attempts = out.attempts
        .filter((a) => round === 0 || !a.outcome.startsWith('skipped_'))
        .map((a) => (a.provider === provider && a.outcome === 'resolved' ? { ...a, detail: a.detail === '' ? said : `${a.detail}; ${said}` } : a));
      seen = [...seen, ...attempts];
      out = { ...out, attempts: seen };
      if (look === null) {
        this.log(`[notesd] direct stream: ${refLabel(ref)} plays from ${provider} while its stream is still being checked`);
        const late = looking.then((done) => {
          this.log(`[notesd] direct stream: ${refLabel(ref)} from ${provider}, checked behind the play: ${done.said}${done.bad ? '; the next play passes this provider over' : ''}`);
          return done;
        });
        return { out, late, passed: true };
      }
      if (!look.bad) return { out, late: null, passed: true };
      first ??= out;
      rejected.push(provider);
    }
    if (first === null) throw new DirectStreamError('no_source', `No provider could stream ${refLabel(ref)}.`, { attempts: seen });
    this.log(`[notesd] direct stream: no provider passed the stream checks for ${refLabel(ref)}; playing ${first.source.provider}`);
    return { out: { ...first, attempts: seen }, late: null, passed: false };
  }

  /**
   * Both checks of one stream, side by side: what each said (`picture: clean; audio: original`) and whether either
   * rejects it. Never rejects: a check that throws is `unsure`.
   */
  private async lookAt(
    ref: StreamRef,
    source: ResolvedSource,
    title: string,
    picture: PictureCheck | null,
    heard: { audio: AudioLangCheck; original: string } | null,
  ): Promise<{ said: string; bad: boolean; why: string }> {
    type Said = { said: string; bad: boolean; why?: string };
    const line = (what: string, look: { verdict: string; reason: string }): string => `${what}: ${look.verdict}${look.reason === '' ? '' : ` (${look.reason})`}`;
    const failed = (what: string) => (err: unknown): Said => ({ said: `${what}: unsure (${messageOf(err).slice(0, 200)})`, bad: false });
    const [seen, sound] = await Promise.all([
      picture === null
        ? null
        : picture.check(ref, source, title).then((look): Said => ({ said: line('picture', look), bad: passesOver(look), why: look.verdict === 'recording' ? 'a cinema recording' : 'a burned-in watermark' }), failed('picture')),
      heard === null ? null : heard.audio.check(ref, source, heard.original).then((look): Said => ({ said: line('audio', look), bad: passesOverAudio(look), why: 'dubbed audio' }), failed('audio')),
    ]);
    const both = [seen, sound].filter((l): l is Said => l !== null);
    // `why`: the faults in plain words, for the line over the picture when the play moves away from this stream.
    return { said: both.map((l) => l.said).join('; '), bad: both.some((l) => l.bad), why: both.filter((l) => l.bad).map((l) => l.why ?? '').join(' and ') };
  }

  /** One resolve for a title that is already playing or already has a stream in hand: the recordResolve hook runs only when a source was found, so a round that finds none does not mark the title stale. Throws `no_source` / `resolve_failed`. */
  private async resolveQuietly(ref: StreamRef, skip: readonly string[]): Promise<ResolvedOutput> {
    const out = await this.runResolve(ref, { skip });
    if (!out.ok) {
      if (out.error === 'no_source') throw new DirectStreamError('no_source', `No provider could stream ${refLabel(ref)}.`, { attempts: out.attempts });
      throw new DirectStreamError('resolve_failed', out.detail === '' ? `The resolve could not run: ${out.error}.` : out.detail, { reason: out.error, attempts: out.attempts });
    }
    await this.recordResolve(ref, out);
    return out;
  }

  /** The recordResolve hook, when there is one. It never fails a resolve: a hook that throws is logged. */
  private async recordResolve(ref: StreamRef, out: ResolveOutput): Promise<void> {
    const hook = this.opts.hooks?.recordResolve;
    if (hook === undefined) return;
    try {
      await hook(ref, out);
    } catch (err) {
      this.log(`[notesd] direct stream: the recordResolve hook failed: ${messageOf(err)}`);
    }
  }

  /** runResolve, then the recordResolve hook, then a typed failure. */
  private async resolveSource(ref: StreamRef, deadlineS?: number, skip: readonly string[] = [], only?: string): Promise<ResolvedOutput> {
    const out = await this.runResolve(ref, { ...(deadlineS === undefined ? {} : { deadlineS }), skip, ...(only === undefined ? {} : { only }) });
    await this.recordResolve(ref, out);
    if (out.ok) return out;
    if (out.error === 'no_source') {
      throw new DirectStreamError('no_source', `No provider could stream ${refLabel(ref)}.`, { attempts: out.attempts });
    }
    throw new DirectStreamError('resolve_failed', out.detail === '' ? `The resolve could not run: ${out.error}.` : out.detail, {
      reason: out.error,
      attempts: out.attempts,
    });
  }

  /**
   * The torrent candidates of a film or episode (the title page's candidates list, `direct_stream_torrents`): what the
   * indexes list, read fresh with `fresh` or from the last answer of the last ten minutes, the torrents this machine
   * opened for it, the magnets pasted for it, each with its audio, its marks and how it went. Joins no swarm. Throws
   * `torrent_off`.
   */
  async torrentCandidates(input: StreamRefInput, options: { fresh?: boolean } = {}): Promise<TorrentCandidateList & { ref: StreamRef }> {
    const source = this.torrentSource();
    if (source === null) throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).');
    const ref = toStreamRef(input);
    const audioLang = await this.audioLang(ref);
    const imdbId = await this.imdbIdOf(ref);
    const namesHook = this.opts.hooks?.titleNames;
    const names = namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref));
    const last = (await this.remembered(ref))?.methods?.torrent ?? null;
    const remembered = last !== null && last.infoHash !== null && sameSlot(ref, last) ? last.infoHash : null;
    return { ref, ...(await source.listCandidates(ref, { audioLang, imdbId, names, fresh: options.fresh === true, remembered })) };
  }

  /**
   * The torrent "that one" means for a film or episode: the torrent a live session of it plays now, else the one the
   * title last played through for that very film or episode. Null when there is neither. Asks no index.
   */
  async currentTorrent(input: StreamRefInput): Promise<{ infoHash: string; name: string | null } | null> {
    const ref = toStreamRef(input);
    const live = this.sessions
      .live()
      .filter((s) => s.torrent !== null && refLabel(s.ref) === refLabel(ref))
      .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())[0];
    if (live?.torrent != null) return { infoHash: live.torrent.infoHash.toLowerCase(), name: live.torrent.name };
    const last = (await this.remembered(ref))?.methods?.torrent ?? null;
    if (last === null || last.infoHash === null || !sameSlot(ref, last)) return null;
    return { infoHash: last.infoHash.toLowerCase(), name: null };
  }

  /** The torrent marks, or `torrent_off`. */
  private torrentMarks(): TorrentMarks {
    const marks = this.torrentSource()?.marks ?? null;
    if (marks === null) throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).');
    return marks;
  }

  /**
   * The owner blacklisted a torrent, by info hash (a dub is a dub for every title): it is never a candidate again, no
   * title remembers it as the torrent it last played through (the forgetTorrent hook), and a play on it now moves by
   * itself to another source at the page's next report of the film playing (a pasted one too: the owner said so).
   */
  async blacklistTorrent(infoHash: string, options: { reason?: string | null; name?: string | null } = {}): Promise<{ mark: TorrentMark; forgotten: string[]; moving: string[] }> {
    const hash = infoHash.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new DirectStreamError('bad_info_hash', 'An info hash is 40 hexadecimal characters.');
    const marks = this.torrentMarks();
    const playing = this.sessions.live().filter((s) => s.torrent?.infoHash.toLowerCase() === hash);
    const name = options.name ?? playing[0]?.torrent?.name ?? null;
    const mark = await marks.blacklist(hash, name, options.reason ?? null);
    const hook = this.opts.hooks?.forgetTorrent;
    const forgotten = hook === undefined ? [] : ((await this.hookValue('forgetTorrent', () => hook(hash))) ?? []);
    for (const session of playing) {
      session.pastedTorrent = null;
      session.pendingMove = 'the torrent was blacklisted';
    }
    this.log(`[notesd] direct stream: the torrent ${mark.name ?? hash} (${hash.slice(0, 8)}) is blacklisted${options.reason ? ` (${options.reason})` : ''}; ${forgotten.length === 0 ? 'no title remembered it' : `forgotten by ${forgotten.join(', ')}`}${playing.length === 0 ? '' : `; ${playing.length} play(s) on it move at the next report`}`);
    return { mark, forgotten, moving: playing.map((s) => s.id) };
  }

  /** Takes a torrent off the blacklist; false when it was not on it. */
  async unblacklistTorrent(infoHash: string): Promise<boolean> {
    const hash = infoHash.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new DirectStreamError('bad_info_hash', 'An info hash is 40 hexadecimal characters.');
    const done = await this.torrentMarks().unblacklist(hash);
    if (done) this.log(`[notesd] direct stream: the torrent ${hash.slice(0, 8)} is off the blacklist`);
    return done;
  }

  /** Every blacklisted torrent, the most recent first. */
  async blacklistedTorrents(): Promise<TorrentMark[]> {
    return this.torrentMarks().blacklisted();
  }

  /**
   * The owner's audio language for the title ("en"), or null to go back to TMDB's original language: stored through
   * the setAudioLanguage hook, before a play, so that play and every later one check for that language. False when
   * it could not be stored (no hook, or the title cannot be stored).
   */
  async setAudioLanguage(ref: StreamRef, language: string | null): Promise<boolean> {
    const hook = this.opts.hooks?.setAudioLanguage;
    if (hook === undefined) return false;
    return (await this.hookValue('setAudioLanguage', () => hook(ref, language))) ?? false;
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
      // Some hosts wrap every segment in a picture file, which ffmpeg cannot read: the cutter then fetches the segments itself.
      ...(session.source.manifest_kind === 'hls' ? { hls: { manifest_kind: session.source.manifest_kind, manifest_url: session.source.manifest_url, headers: session.source.headers } } : {}),
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
      source_rev: session.sourceRev,
      source_note: session.sourceNote,
      preview_rev: session.previewRev,
    };
  }

  /**
   * Throws `no_source` for a film that is not out yet, or an episode that has not aired, by TMDB's day: nothing is
   * asked. The soak of 2026-11-19 found both unreleased films it asked for "resolved" by a cloud provider (The
   * Batman: Part II of 2028 as a Hindi/English stream) and offered as trailers and fakes by the torrent indexes. A
   * title with no known day, and a day that is today, play as usual.
   */
  private async refuseUnreleased(ref: StreamRef): Promise<void> {
    const hook = this.opts.hooks?.releaseDate;
    if (hook === undefined) return;
    const day = await this.hookValue('releaseDate', () => hook(ref));
    if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day <= this.now().toISOString().slice(0, 10)) return;
    const what = ref.kind === 'movie' ? 'is not released yet' : 'has not aired yet';
    const detail = `${what}: TMDB gives ${day}. No provider and no torrent index was asked: until then a stream or a torrent of it is a trailer or a fake`;
    throw new DirectStreamError('no_source', `${refLabel(ref)} ${what} (${day}).`, { attempts: [{ provider: NOT_RELEASED, outcome: 'skipped', took_s: 0, detail }] });
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
  /** The streaming sites, the last resort of a play with no source named (src/streaming/fallback.ts); null or unset: none. */
  siteFallback?: SiteFallback | null;
  /** Cloudflare WARP's switch (src/streaming/warp.ts), for a torrent play on the office network; used only with NOTESD_STREAM_WARP on. */
  warp?: WarpSwitch | null;
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
    siteFallback: wiring.siteFallback ?? null,
    ahead: ds.ahead === true,
    firstProvider: ds.firstProvider ?? null,
    warp: ds.warp === true && wiring.warp != null ? { switch: wiring.warp, auto: TORRENT_WARP_AUTO } : null,
    fetch: overrides.fetch,
    now: overrides.now,
    log: overrides.log,
  });
}
