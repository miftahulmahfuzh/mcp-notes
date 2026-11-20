import { join } from 'node:path';
import { DEFAULT_TORRENT_FINDER_CONFIG, TORRENT_INDEX_NAMES, type Config, type TorrentIndexName } from '../../config.js';
import type { SessionTorrent } from '../sessions.js';
import { isEnglish, refLabel, type ResolveAttempt, type ResolveOutcome, type ResolvedSource, type SourceAudio, type StreamRef } from '../types.js';
import { candidateFromMagnet, deadLast, DEFAULT_TRACKERS, defaultIndexes, findCandidates, heightRank, IndexHealth, looksDead, parseRelease, pickFile, udpScraper, udpTrackerOf, type IndexAttempt, type ReleaseHeight, type ScrapeTrackers, type SwarmCount, type TorrentCandidate, type TorrentIndex, type TorrentQuery } from './find/index.js';
import { readMagnet, TRACKER_BOOK_FILE, TrackerBook, trackerKey } from './origins.js';
import { scrapeTrackerOrder } from './find/scrape.js';
import type { TrackerLists } from './trackerLists.js';
import { audioLanguages, describeProbe, ffprobeFile, normalizeAudioLang, ProbeError, type MediaProbe, type ProbeFile } from './probe.js';
import { canRemux, pickAudioStream, type TorrentRemux } from './remux.js';
import { runSubtitleChain, type SubtitleContext, type SubtitleTier } from './subtitles/chain.js';
import { rankOf } from './subtitles/disk.js';
import { hasEnglishSubtitleFile } from './subtitles/files.js';
import type { TorrentSyncRequest } from './subtitles/synced.js';
import type { AudioFinding } from '../audioLang.js';
import type { TorrentMark, TorrentMarks } from './marks.js';
import type { TorrentDownload, TorrentFileInfo, TorrentHandle, TorrentPick, TorrentSlotRecord, TorrentStats } from './types.js';
import { CANDIDATE_LIST_FIND_MS, CANDIDATE_LIST_TTL_MS, candidateRows, type Gathered, type TorrentCandidateList } from './candidates.js';

/**
 * The torrent source of direct streaming (torrent phase 3). DirectStreamService calls only this: it finds the
 * title's torrents by IMDb id (phase 2's findCandidates), opens the best of them side by side in the swarm (phase 1's
 * TorrentStreams) until one holds a file that plays in the title's original language, and answers the session's
 * SessionTorrent and the ResolvedSource stand-in a session carries. The finder ranks the candidates (phase 2);
 * which of the ones whose header arrived plays is decided here, by what their swarms deliver (chooseOrder). How
 * bytes are fetched is phase 1's. It never runs inside DirectStreamService.serial(): phase 6's borrow tier calls
 * subtitleText, which queues there.
 */

/** The provider every torrent session carries (movie_plays, the stream on screen, the player). */
export const TORRENT_PROVIDER = 'Torrent';
/** Seconds after where a play starts that a torrent's audio is heard (torrent audio check): its pieces are fetched soon anyway. */
export const TORRENT_HEAR_AFTER_S = 300;
/** How a torrent attempt whose swarm sent no file list in time begins (no peer answered): torrentWarp.ts reads it. */
export const NO_FILE_LIST = 'no file list from the swarm in time';
/** Torrents opened per play (and per shuffle) before the answer is no_source: two rounds of TORRENT_RACE_WIDTH. */
export const MAX_TORRENT_TRIES = 6;
/** A torrent whose swarm did not deliver is left out of the next plays of the title for this long: swarms wake up. */
export const SWARM_FAILURE_KEEP_MS = 30 * 60_000;
/** A torrent whose file will not change (a dub, a file Chrome cannot play, no file of the episode) is left out this long. */
export const FILE_FAILURE_KEEP_MS = 24 * 60 * 60_000;
/** The attempt a failed play ends with: how many torrents were found and not tried, so asking again tries those. */
export const TORRENTS_LEFT = 'Torrents: not tried yet';
/** A new tracker from a pasted magnet must answer a scrape within this to be kept (learnMagnet). */
export const TRACKER_PROBE_MS = 2_500;
/** The height a torrent play prefers (HEIGHT_PREFERENCE's first): a remembered torrent of another height goes after the indexes. */
export const PREFERRED_TORRENT_HEIGHT = 1080;
/** Torrents opened side by side: the index's seed count is not the swarm, so the swarms themselves are asked. */
export const TORRENT_RACE_WIDTH = 3;
/** Once one torrent's header has arrived, the others still opening get this long to arrive too before one is chosen. */
export const TORRENT_SETTLE_MS = 2_000;
/** A swarm with at least this many peers connected is not thin (/report-stream-bug calls 5 or fewer thin). */
export const HEALTHY_PEERS = 6;
/** The subtitle chain may hold the play's answer this long (a kept file answers at once); after it the chain goes on behind the play. */
export const SUBTITLE_HEAD_MS = 1_500;
/** The attempt a play answers while its subtitle chain is still running. */
export const SUBTITLES_PENDING = 'Subtitles: pending';
/** A torrent play's whole budget: finding, opening and probing (the subtitle chain has its own, SUBTITLE_BUDGET_MS). */
export const TORRENT_DEADLINE_MS = 90_000;
/** One torrent's file list must arrive within this. */
export const TORRENT_OPEN_TIMEOUT_MS = 20_000;
/** ffprobe must have read the file's header within this when the swarm cannot say what it received (tests' fakes). */
export const TORRENT_PROBE_TIMEOUT_MS = 30_000;
/**
 * A header probe goes on while the swarm delivers, up to the play's budget: it is given up only when the torrent
 * received less than PROBE_STALL_BYTES in the last PROBE_STALL_MS. A flat 30 s dropped three well seeded 1080p
 * torrents racing on a 9 Mbps link (a YTS MP4's header is ~10 MB, so each needed ~35 s with the link split three ways).
 */
export const PROBE_STALL_MS = 15_000;
export const PROBE_STALL_BYTES = 512 * 1024;
/** How often a probe's swarm is looked at. */
export const PROBE_SAMPLE_MS = 1_000;
/** Once a header of a less preferred height arrived, a racer of a preferred height (1080p) still opening gets up to this long to arrive too. */
export const HEIGHT_SETTLE_MS = 20_000;
/** The least time a probe is given, even late in the budget. */
const PROBE_MIN_MS = 5_000;

/** True for the provider name that asks the torrent source ("torrent", any case). */
export const namesTorrent = (provider: string | null | undefined): boolean => (provider ?? '').trim().toLowerCase() === 'torrent';

/** True for the provider name that asks the cloud providers and never a torrent ("cloud", any case). */
export const namesCloud = (provider: string | null | undefined): boolean => (provider ?? '').trim().toLowerCase() === 'cloud';

/** An attempt's provider for one torrent: `Torrent: <release name>`. */
export const torrentLabel = (name: string): string => `${TORRENT_PROVIDER}: ${name}`;

export type FindQuery = TorrentQuery;
export type FindAnswer = Awaited<ReturnType<typeof findCandidates>>;
/** `tried`: info hashes this title's earlier plays already failed on; the finder's fallback indexes are asked when nothing else is left. */
export type FindTorrents = (query: FindQuery, signal: AbortSignal, options?: { tried?: ReadonlySet<string> }) => Promise<FindAnswer>;

/** What open answers once the swarm sent the file list (nothing is selected yet): phase 1's TorrentHandle fits. */
export interface OpenedTorrent {
  readonly infoHash: string;
  readonly files: readonly TorrentFileInfo[];
  /** Phase 1's TorrentHandle.read (`end` inclusive); the subtitle tiers read bytes with it. Absent in tests' fakes. */
  read?: TorrentHandle['read'];
}

/** This host's record of a title's torrent download (phase 1's TorrentDownload fits). */
export type DownloadOnDisk = Pick<TorrentDownload, 'infoHash' | 'name' | 'fileIndex' | 'state'> & { release?: string | null };

/** The part of phase 1's TorrentStreams (AppDeps.torrents) this module calls. */
export interface TorrentSwarm {
  open(pick: TorrentPick, options: { timeoutMs: number }): Promise<OpenedTorrent>;
  /** Selects the files and marks the torrent in use (one more user). */
  use(infoHash: string, fileIndexes: readonly number[]): unknown;
  /** One user fewer; with none left the daemon leaves the swarm. Safe for a torrent opened and never used. */
  release(infoHash: string): unknown;
  find(ref: StreamRef): Promise<DownloadOnDisk | null>;
  /** The file's absolute path once it is whole on disk, else null. */
  filePath(infoHash: string, index: number): string | null | Promise<string | null>;
  /** `/api/stream/torrent/<hash>/f/<index>`. */
  localUrl(infoHash: string, index: number): string;
  /** True when the file lives as its whole remux only (its original was deleted, remuxOnly.ts). Absent: never. */
  remuxOnly?(infoHash: string, index: number): boolean | Promise<boolean>;
  /** The video's length once the probe knows it: `/map` then answers seconds (phase 4's grey bar). */
  setDuration(infoHash: string, seconds: number, fileIndex?: number): unknown;
  /** Gives back a hold taken with `use`; with none left the swarm is left at once (a torrent that lost the race, or did not play). Absent: `release`. */
  drop?(infoHash: string): unknown;
  /** For a torrent opened and not used: leaves its swarm at once when nothing uses it, and touches nobody's hold. Absent: `release`. */
  discard?(infoHash: string): unknown;
  /** The peers connected and the download rate of an open torrent, now; null when it is not in the swarm. Absent in tests' fakes. */
  stats?(infoHash: string): Pick<TorrentStats, 'peers' | 'down_kbps'> | null;
  /** The release name this host keeps for a torrent; null when none. Absent in tests' fakes. */
  releaseName?(infoHash: string): Promise<string | null>;
  /** Bytes an open torrent received from peers so far; null when it cannot say. Absent: the probe has the flat TORRENT_PROBE_TIMEOUT_MS. */
  received?(infoHash: string): number | null;
  /** This host's rows of a film or episode (every torrent opened for it), for the candidates list. Absent: none. */
  downloadsOf?(ref: StreamRef): Promise<TorrentSlotRecord[]>;
}

export interface TorrentSourceOptions {
  swarm: TorrentSwarm;
  find: FindTorrents;
  probe: ProbeFile;
  tiers: readonly SubtitleTier[];
  /** The remux for a file Chrome cannot play as is (torrent phase 5); null or unset: such a file is `unplayable`. */
  remux?: TorrentRemux | null;
  /** Wyzie Synced: re-times a subtitle that came from outside the torrent after the play started; null or unset: never. */
  sync?: { start(request: TorrentSyncRequest): unknown } | null;
  /** This daemon's origin as ffprobe reaches it (`http://127.0.0.1:<port>`); read at play time. */
  localBase: () => string;
  /** Asks the trackers for the candidates' real seeders before any swarm is joined (find/scrape.ts); null or unset: nobody is asked. */
  scrape?: ScrapeTrackers | null;
  /** The public trackers learned from pasted magnets (origins.ts), added to every torrent opened; null or unset: none. */
  book?: TrackerBook | null;
  /**
   * The public tracker lists' trackers that answered a connect (trackerLists.ts), added after the candidate's and the
   * book's to every torrent opened and every scrape; null or unset: none (NOTESD_TORRENT_TRACKER_LISTS or discovery off).
   */
  lists?: Pick<TrackerLists, 'list'> | null;
  /** The torrent sites' addresses by name (TorrentSitesConfig.origins; null: off), for what learnMagnet says of an index. */
  sites?: Readonly<Record<string, string | null>>;
  /** What this machine knows of each torrent whatever the title (marks.ts): blacklisted ones and heard dubs are never tried. Null or unset: none. */
  marks?: TorrentMarks | null;
  /**
   * Hears ~30 s of a torrent's file when its tags name no audio language (AudioLangCheck.hear over the shared Whisper
   * worker). Null or unset: never.
   */
  hear?: TorrentHearer | null;
  /** Default TORRENT_SETTLE_MS. */
  settleMs?: number;
  /** Default SUBTITLE_HEAD_MS. */
  subtitleHeadMs?: number;
  /** Default PROBE_STALL_MS, PROBE_SAMPLE_MS and HEIGHT_SETTLE_MS (tests shorten them). */
  probeStallMs?: number;
  probeSampleMs?: number;
  heightSettleMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** One hearing of a stream's audio, kept nowhere (AudioLangCheck.hear fits). */
export interface TorrentHearer {
  hear(source: ResolvedSource, audioLang: string, atS: number): Promise<AudioFinding>;
}

/** What a torrent's audio was heard as: a kept hearing (`kept`) answers without listening again. */
export type TorrentHearing = AudioFinding & { kept: boolean };

/** Where a torrent play stands while it is being started: what is being done now, and every attempt finished so far. */
export interface TorrentProgress {
  stage: string;
  attempts: ResolveAttempt[];
}

/** The title's names and year, for the finder's title check and phase 9's 1337x search. */
export interface TitleNames {
  title: string;
  originalTitle: string | null;
  year: number | null;
  /**
   * An episode's place in its season's list, from 1 (TMDB's season 21, episode 1000 of One Piece is the 109th);
   * null or absent: a film, or the list does not hold the episode.
   */
  episodeInSeason?: number | null;
}

export interface TorrentResolveOptions {
  /** The title's original language (TMDB's code); null: unknown. */
  audioLang: string | null;
  /** The title's IMDb id; null: it has none, and only the indexes asked by title (and the fallback sites) are asked. */
  imdbId: string | null;
  names?: TitleNames | null;
  /** Where the play starts, in seconds (phase 8's Whisper transcribes from there first). */
  resumeS?: number | null;
  /** The cloud providers were asked first and none could stream the title (phase 6's borrow tier then asks nothing). */
  cloudTried?: boolean;
  /** Info hashes not to try. */
  skip?: readonly string[];
  /** Told each time the play moves on (the indexes answered, a torrent was tried), for a caller that answers before the play does. */
  progress?: (progress: TorrentProgress) => void;
}

export type TorrentResolve =
  | { ok: true; torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] }
  | { ok: false; error: 'no_source'; attempts: ResolveAttempt[] };

/** Where the torrent that plays was found, for its log line: `from torrentio`, `from knaben, also listed by apibay`. */
function foundIn(c: Pick<TorrentCandidate, 'index' | 'listedBy'> | null): string {
  if (c === null) return '';
  const others = (c.listedBy ?? []).filter((name) => name !== c.index);
  return ` (from ${c.index}${others.length === 0 ? '' : `, also listed by ${others.join(', ')}`})`;
}

/** What one play knows besides the candidate: the same for every torrent it tries. */
interface PlayFacts {
  audioLang: string | null;
  /** Null: the title has none; the subtitle services are then asked by what else they take (Wyzie: the TMDB id). */
  imdbId: string | null;
  resumeS: number | null;
  cloudTried: boolean;
}

type Tried =
  | { ok: true; torrent: SessionTorrent; source: ResolvedSource; attempt: ResolveAttempt; subtitleAttempts: ResolveAttempt[] }
  | { ok: false; attempt: ResolveAttempt };

/** A torrent whose header arrived and whose file may be played: it is selected and downloading, and may still lose to another. */
interface Passed {
  /** Its place in the finder's order. */
  position: number;
  c: TorrentCandidate;
  opened: OpenedTorrent;
  video: number;
  subtitles: readonly number[];
  probe: MediaProbe;
  /** Its files hold an English subtitle file (R3.2). */
  english: boolean;
  /** The height its release name says (chooseOrder prefers 1080p). */
  height: ReleaseHeight | null;
  /** Seconds from its open to its header. */
  tookS: number;
  /** Lets go of it (once): it lost, or its remux did not start. */
  drop(): void;
}

/** `lasting`: the failure is the file's (a dub, the wrong files), not the swarm's, so it will be the same tomorrow. */
type Raced = { ok: true; passed: Passed } | { ok: false; attempt: ResolveAttempt; lasting?: boolean };

/** Told of each torrent that was tried and did not play. */
type NoteFailure = (c: TorrentCandidate, lasting: boolean, why?: string) => void;

/** What /update-cloud-source answers for a pasted magnet (TorrentSource.learnMagnet). */
export type MagnetReport =
  | { ok: false; error: 'bad_magnet'; detail: string }
  | {
      ok: true;
      info_hash: string;
      name: string | null;
      /** The index the magnet's own trackers name; null when they name none we know. */
      origin: { index: string; label: string; by: string; supported: boolean; enabled: boolean; site_origin: string | null; gate: string | null } | null;
      /** Tracker hosts that belong to no index we know and to no public tracker we hold: an index we lack may run them. */
      unknown_hosts: string[];
      trackers: {
        /** The origin index's own trackers (never added: they serve only that index's torrents). */
        own: string[];
        /** Public trackers the daemon already uses. */
        known: string[];
        /** New public UDP trackers that answered: now added to every torrent and every scrape. */
        added: string[];
        /** New UDP trackers that did not answer: not added. */
        silent: string[];
        /** Not UDP (their health cannot be asked cheaply): not added. */
        skipped: string[];
      };
      /** What the trackers know of this torrent now; null when none answered or none was asked. */
      swarm: SwarmCount | null;
      next: string;
    };

const refKey = (ref: StreamRef): string => (ref.kind === 'tv' ? `tv:${ref.tmdbId}:${ref.season}:${ref.episode}` : `movie:${ref.tmdbId}`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Racer {
  /** Stops caring for the result and lets go of the torrent, now or as soon as it is open. */
  cancel(): void;
  readonly result: Promise<Raced>;
}

/** What a swarm delivers for a file, as far as it is known: the peers connected, the rate, and the film's own bitrate. */
interface Delivery {
  peers: number;
  downKbps: number;
  /** The file's bytes over its length; null when the probe gave no length. */
  filmKbps: number | null;
}

const mbps = (kbps: number): string => (kbps / 1000).toFixed(1);

/**
 * Where a torrent's audio is heard: TORRENT_HEAR_AFTER_S after where the play starts (those pieces are fetched for the
 * play soon anyway), but never past the middle of a film whose length is known.
 */
export function hearAt(durationS: number | null, startS: number | null): number {
  const at = Math.max(0, startS ?? 0) + TORRENT_HEAR_AFTER_S;
  if (durationS === null || durationS <= 0) return at;
  return Math.max(0, Math.min(at, durationS / 2));
}

/** A file's bitrate in kbit/s: its bytes over its length; null when either is unknown. */
function filmKbpsOf(length: number | null, durationS: number | null): number | null {
  return length !== null && durationS !== null && durationS > 0 ? Math.round((length * 8) / 1000 / durationS) : null;
}

/**
 * Above this bitrate many peers are no promise: this machine's link carries about 9 Mbps, and Amélie's 18.3 Mbps
 * BDRip (four audio tracks) was chosen for its 7 peers and never moved past its first frame.
 */
export const PEERS_ALONE_MAX_FILM_KBPS = 8_000;

/**
 * True when the swarm looks able to keep ahead of the picture: a rate at or above the film's bitrate, or enough peers
 * for a film whose bitrate this link can carry (PEERS_ALONE_MAX_FILM_KBPS; unknown counts as carried).
 */
export function delivers(d: Delivery | null): boolean {
  if (d === null) return false;
  if (d.filmKbps !== null && d.downKbps >= d.filmKbps) return true;
  return d.peers >= HEALTHY_PEERS && (d.filmKbps === null || d.filmKbps <= PEERS_ALONE_MAX_FILM_KBPS);
}

/**
 * The torrents whose headers arrived, best first: one whose swarm delivers before one that does not, then the
 * preferred height (1080p, then 720p, 2160p, 480p: HEIGHT_PREFERENCE), then one whose files hold an English subtitle
 * file (R3.2), then the one with more peers connected, then the finder's order.
 */
export function chooseOrder<T extends { position: number; english: boolean; height?: ReleaseHeight | null }>(passed: readonly T[], deliveryOf: (p: T) => Delivery | null): T[] {
  const scored = passed.map((p) => ({ p, d: deliveryOf(p) }));
  return scored
    .sort(
      (a, b) =>
        Number(delivers(b.d)) - Number(delivers(a.d)) ||
        heightRank(a.p.height ?? null) - heightRank(b.p.height ?? null) ||
        Number(b.p.english) - Number(a.p.english) ||
        (b.d?.peers ?? 0) - (a.d?.peers ?? 0) ||
        a.p.position - b.p.position,
    )
    .map((x) => x.p);
}

function sleep(ms: number): { done: Promise<void>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return { done, clear: () => clearTimeout(timer) };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const seconds = (from: number, to: number): number => Math.round((to - from) / 100) / 10;
const pad = (n: number): string => String(n).padStart(2, '0');

/** An index's outcome as an attempt's: an index that listed torrents `resolved`, an empty one `no_stream`. */
const INDEX_OUTCOMES: Record<IndexAttempt['outcome'], ResolveOutcome> = { ok: 'resolved', empty: 'no_stream', error: 'error', bot_check: 'bot_check', skipped: 'skipped' };

function indexAttempt(a: IndexAttempt): ResolveAttempt {
  return { provider: `Index: ${a.index}`, outcome: INDEX_OUTCOMES[a.outcome], took_s: a.took_s, detail: a.detail };
}

/** The finder's query: the IMDb id, the title's names and year, its original language, and the episode for a series. */
function queryOf(ref: StreamRef, imdbId: string | null, names: TitleNames | null, audioLang: string | null): FindQuery {
  const common = { imdbId, title: names?.title ?? null, originalTitle: names?.originalTitle ?? null, year: names?.year ?? null, originalLanguage: audioLang };
  if (ref.kind === 'movie') return { ...common, kind: 'movie' };
  // TMDB's number runs on across seasons (a long anime): the indexes and many releases count within the season.
  const place = names?.episodeInSeason ?? null;
  const runsOn = place !== null && place >= 1 && place < ref.episode;
  return { ...common, kind: 'tv', season: ref.season, episode: ref.episode, ...(runsOn ? { absoluteEpisode: ref.episode, alt: { season: ref.season, episode: place } } : {}) };
}

/**
 * Why a probed file is not played, or null when it plays: a dub first (original language only), then a file Chrome
 * cannot play that the remux cannot help either (the remux off, or video Chrome cannot decode).
 */
/**
 * A file Chrome plays as is AND whose default audio is the original: a dual-audio file whose original track is not
 * the first needs the remux to force it, or Chrome would play the dub. Single-audio, or the original at index 0, is fine.
 */
function playsOriginalDirect(probe: MediaProbe, audioLang: string | null): boolean {
  if (!probe.direct) return false;
  if (audioLang === null || probe.audio.length <= 1) return true;
  return pickAudioStream(probe.audio, audioLang) === 0;
}

function refusalOf(probe: MediaProbe, audioLang: string | null, remux: TorrentRemux | null): { outcome: ResolveOutcome; detail: string } | null {
  const languages = audioLanguages(probe);
  if (audioLang !== null && languages.length > 0 && !languages.includes(audioLang)) {
    return { outcome: 'dubbed', detail: `its audio is ${languages.join(', ')}, not the original ${audioLang}` };
  }
  // Direct, and the original track is the one Chrome would play: nothing to do.
  if (playsOriginalDirect(probe, audioLang)) return null;
  // A dual-audio file whose original is not the default: the remux maps the original track, so a dub never plays.
  // Without a remux it would, so it is refused rather than played in the wrong language.
  if (remux === null) {
    return probe.direct
      ? { outcome: 'dubbed', detail: `${describeProbe(probe)}: ${probe.audio.length} audio tracks and the original ${audioLang} is not the default; a remux is needed to force it, and the remux is off` }
      : { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is` };
  }
  if (!canRemux(probe)) return { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is, and a remux cannot make its video playable` };
  return null;
}

/**
 * The ResolvedSource a torrent session carries, so whatever reads `session.source` (movie_plays, the stream on
 * screen, the evidence snapshot) reads the torrent's. Its manifest is the local, relative file route, so
 * `sourceHosts` finds no host and the pass-through refuses every address for the session, as for a cache.
 */
function standIn(torrent: SessionTorrent, probe: MediaProbe, audioLang: string | null, tookS: number | null): ResolvedSource {
  const languages = audioLanguages(probe);
  const original = audioLang === null ? undefined : probe.audio.find((a) => normalizeAudioLang(a.lang) === audioLang);
  const audio: SourceAudio = {
    languages,
    tracks: probe.audio.length > 1 ? probe.audio.length : 0,
    original: audioLang === null || languages.length === 0 ? null : languages.includes(audioLang),
    track: original === undefined ? null : { lang: original.lang, label: null },
  };
  return {
    provider: TORRENT_PROVIDER,
    embed_url: '',
    manifest_url: torrent.manifestUrl,
    manifest_kind: torrent.manifestKind,
    headers: { referer: null, origin: null, user_agent: null },
    subtitles: [],
    best_height: torrent.height,
    en_subtitle: torrent.subtitles.some((t) => isEnglish(t)),
    audio,
    took_s: tookS,
  };
}

export class TorrentSource {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** What a session's sync was asked with, to start it again when the session takes its torrent back (a reload of the page). */
  private readonly syncs = new WeakMap<SessionTorrent, Omit<TorrentSyncRequest, 'signal' | 'target'>>();
  /**
   * Per film or episode, the torrents that were tried and did not play, in memory (one per daemon run): the info hash,
   * until when it is left out, and whether the failure was the file's. Asking again then tries the next candidates
   * instead of the same ones.
   */
  private readonly failed = new Map<string, Map<string, { until: number; lasting: boolean; why: string | null }>>();
  /** Per film or episode, in memory: each magnet the owner pasted for it, its name and how its play went (null: it played). */
  private readonly pasted = new Map<string, Map<string, { name: string; failed: string | null }>>();
  /** Per film or episode, in memory: the finder's last answer and when, for the candidates list (CANDIDATE_LIST_TTL_MS). */
  private readonly listings = new Map<string, { at: number; found: FindAnswer }>();

  constructor(private readonly opts: TorrentSourceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * Finds the title's torrents and plays the first that works, trying at most MAX_TORRENT_TRIES within
   * TORRENT_DEADLINE_MS, one budget for the whole ask (the dub-named round gets what the proper round left). `attempts` holds one `Index: <name>` per index asked, then per torrent tried one
   * `Torrent: <release>`, and after the one that plays its `Subtitles: <tier>` attempts. Never throws.
   */
  async resolve(ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
    const started = this.now();
    // No IMDb id (TMDB lists none, or could not be asked): the indexes asked by title and the fallback sites still are.
    const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
    options.progress?.({ stage: 'asking the torrent indexes', attempts: [] });
    // Blacklisted by the owner, or heard speaking another language than this title's: never tried.
    const marked = await this.leftOutByMarks(options.audioLang);
    let found: FindAnswer;
    try {
      // What earlier asks for this title already failed on: with nothing new among the JSON indexes' candidates, the finder asks its fallback sites.
      const before = new Set([...(options.skip ?? []).map((h) => h.toLowerCase()), ...this.remembered(refKey(ref)).keys(), ...marked]);
      found = await this.opts.find(query, AbortSignal.timeout(TORRENT_DEADLINE_MS), { tried: before });
    } catch (err) {
      return { ok: false, error: 'no_source', attempts: [{ provider: 'Index: all', outcome: 'error', took_s: seconds(started, this.now()), detail: messageOf(err) }] };
    }
    const key = refKey(ref);
    this.keepListing(key, found);
    const asked = (options.skip ?? []).map((h) => h.toLowerCase());
    const leftOut = (): Set<string> => new Set([...asked, ...this.remembered(key).keys(), ...marked]);
    const pick = (skip: ReadonlySet<string>): { candidates: TorrentCandidate[]; dubs: TorrentCandidate[] } => {
      const proper = found.candidates.filter((c) => !skip.has(c.infoHash.toLowerCase()));
      // Releases the name read as a dub: many are dual-audio and still carry the original track (the probe decides).
      return { candidates: proper, dubs: (found.lastResort ?? []).filter((c) => !skip.has(c.infoHash.toLowerCase()) && !proper.some((k) => k.infoHash === c.infoHash)) };
    };
    let { candidates, dubs } = pick(leftOut());
    if (candidates.length === 0 && dubs.length === 0 && this.forgetSwarmFailures(key)) {
      // Every torrent found was tried on earlier asks: start over with the ones whose swarm did not deliver then.
      ({ candidates, dubs } = pick(leftOut()));
      if (candidates.length + dubs.length > 0) this.log(`[notesd] torrent: ${refLabel(ref)}: every torrent found was tried before; starting over with ${plural(candidates.length + dubs.length, 'torrent')} whose swarm did not deliver`);
    }
    const counts = await this.swarmCounts([...candidates, ...dubs]);
    const dead = [...candidates, ...dubs].filter((c) => looksDead(counts.get(c.infoHash))).length;
    if (dead > 0) this.log(`[notesd] torrent: ${refLabel(ref)}: the trackers know no seeder for ${dead} of ${candidates.length + dubs.length} torrent(s); those are tried last`);
    candidates = deadLast(candidates, counts);
    dubs = deadLast(dubs, counts);
    const indexes = found.indexes.map(indexAttempt);
    const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: options.resumeS ?? null, cloudTried: options.cloudTried === true };
    const progress = options.progress;
    const tried = new Set<string>();
    const note: NoteFailure = (c, lasting, why) => {
      tried.add(c.infoHash);
      this.remember(key, c.infoHash, lasting, why ?? null);
    };
    /** The last attempt of a play that started nothing: what asking again would try. */
    const left = (): ResolveAttempt[] => {
      if (tried.size === 0) return [];
      const untried = [...candidates, ...dubs].filter((c) => !tried.has(c.infoHash)).length;
      const detail =
        untried > 0
          ? `${plural(untried, 'more torrent')} of this title ${untried === 1 ? 'was' : 'were'} found and not tried yet: ask again and the next ones are tried`
          : 'every torrent found was tried; asking again starts over with the ones whose swarm did not deliver';
      return [{ provider: TORRENTS_LEFT, outcome: 'skipped', took_s: null, detail }];
    };
    const out = await this.tryCandidates(ref, query, candidates, play, started + TORRENT_DEADLINE_MS, progress === undefined ? undefined : (p) => progress({ stage: p.stage, attempts: [...indexes, ...p.attempts] }), note);
    if (out.ok) {
      this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), playing ${out.torrent.name}${foundIn(out.torrent.candidate)}`);
      return { ...out, attempts: [...indexes, ...out.attempts] };
    }
    // Nothing proper played: the dub-named releases are tried now, in their own round.
    const firstAttempts = [...indexes, ...out.attempts];
    if (dubs.length === 0 || started + TORRENT_DEADLINE_MS - this.now() < PROBE_MIN_MS) {
      this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), none played`);
      return { ok: false, error: 'no_source', attempts: [...firstAttempts, ...left()] };
    }
    options.progress?.({ stage: 'trying releases whose name reads as a dub (the file may still carry the original)', attempts: firstAttempts });
    // The same budget as the proper round: one ask never takes longer than TORRENT_DEADLINE_MS in all.
    const dubbed = await this.tryCandidates(ref, query, dubs, play, started + TORRENT_DEADLINE_MS, progress === undefined ? undefined : (p) => progress({ stage: p.stage, attempts: [...firstAttempts, ...p.attempts] }), note);
    this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s) and ${dubs.length} dub-named, ${dubbed.ok ? `playing ${dubbed.torrent.name}${foundIn(dubbed.torrent.candidate)} (its file carries the original ${options.audioLang ?? 'language'})` : 'none played'}`);
    return dubbed.ok ? { ...dubbed, attempts: [...firstAttempts, ...dubbed.attempts] } : { ok: false, error: 'no_source', attempts: [...firstAttempts, ...dubbed.attempts, ...left()] };
  }

  /** The torrents of `key` still left out, by info hash (true: the failure was the file's). Expired ones are dropped. */
  private remembered(key: string): Map<string, boolean> {
    const kept = new Map<string, boolean>();
    const entries = this.failed.get(key);
    if (entries === undefined) return kept;
    const now = this.now();
    for (const [hash, entry] of entries) {
      if (entry.until <= now) entries.delete(hash);
      else kept.set(hash, entry.lasting);
    }
    if (entries.size === 0) this.failed.delete(key);
    return kept;
  }

  private remember(key: string, infoHash: string, lasting: boolean, why: string | null = null): void {
    const entries = this.failed.get(key) ?? new Map<string, { until: number; lasting: boolean; why: string | null }>();
    const hash = infoHash.toLowerCase();
    // A file's failure (a dub) is never shortened to a swarm's by a later stall of the same torrent.
    const before = entries.get(hash);
    if (before !== undefined && before.lasting && !lasting && before.until > this.now()) return;
    entries.set(hash, { until: this.now() + (lasting ? FILE_FAILURE_KEEP_MS : SWARM_FAILURE_KEEP_MS), lasting, why: why ?? before?.why ?? null });
    this.failed.set(key, entries);
  }

  /**
   * Forgets the torrents of this film or episode whose swarm did not deliver, so the next `resolve` tries them again:
   * the torrent play on the office network asks again through WARP (torrentWarp.ts), where the same swarms may answer.
   */
  forgetNoPeers(ref: StreamRef): void {
    this.forgetSwarmFailures(refKey(ref));
  }

  /** Forgets the torrents of `key` whose swarm did not deliver (a file's failure stays); true when any was forgotten. */
  private forgetSwarmFailures(key: string): boolean {
    const entries = this.failed.get(key);
    if (entries === undefined) return false;
    let any = false;
    for (const [hash, entry] of entries) {
      if (entry.lasting) continue;
      entries.delete(hash);
      any = true;
    }
    return any;
  }

  /**
   * A candidate's trackers, then the learned ones (the tracker book), then the public lists' (trackerLists.ts),
   * without repeats: two spellings of one tracker (trackerKey) are one, the first kept.
   */
  private trackersOf(c: Pick<TorrentCandidate, 'trackers'>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const url of [...c.trackers, ...(this.opts.book?.list() ?? []), ...(this.opts.lists?.list() ?? [])]) {
      const key = trackerKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
    return out;
  }

  /**
   * What the trackers know of each candidate's swarm, asked before any is joined; empty when nobody is asked or
   * answers. The defaults, the book and the candidates' own trackers come first; the list trackers get the last
   * places (scrapeTrackerOrder), so they are asked without making the scrape longer.
   */
  private async swarmCounts(candidates: readonly TorrentCandidate[], timeoutMs?: number): Promise<Map<string, SwarmCount>> {
    const scrape = this.opts.scrape ?? null;
    if (scrape === null || candidates.length === 0) return new Map();
    const trackers = scrapeTrackerOrder([...DEFAULT_TRACKERS, ...(this.opts.book?.list() ?? []), ...candidates.flatMap((c) => c.trackers)], this.opts.lists?.list() ?? []);
    try {
      return await scrape(candidates.map((c) => c.infoHash), trackers, timeoutMs === undefined ? {} : { timeoutMs });
    } catch (err) {
      this.log(`[notesd] torrent: the trackers could not be asked: ${messageOf(err)}`);
      return new Map();
    }
  }

  /**
   * /update-cloud-source <magnet>: reads where a pasted magnet comes from (the index its own trackers name), asks
   * the trackers for its swarm, and keeps its public UDP trackers that answer in the tracker book, so every later
   * torrent is opened and scraped with them too. Joins no swarm and plays nothing. Never throws.
   */
  async learnMagnet(magnet: string): Promise<MagnetReport> {
    const book = this.opts.book ?? null;
    const facts = readMagnet(magnet, [...DEFAULT_TRACKERS, ...(book?.list() ?? [])]);
    if (facts === null) return { ok: false, error: 'bad_magnet', detail: 'not a magnet link or a 40-character info hash' };
    const scrape = this.opts.scrape ?? null;
    const knownKeys = new Set([...DEFAULT_TRACKERS, ...(book?.list() ?? [])].map(trackerKey));
    const known = facts.others.filter((t) => knownKeys.has(trackerKey(t)));
    const fresh = facts.others.filter((t) => !knownKeys.has(trackerKey(t)));
    const udp = fresh.filter((t) => udpTrackerOf(t) !== null);
    const skipped = fresh.filter((t) => udpTrackerOf(t) === null);
    const answered = new Set<string>();
    let swarm: SwarmCount | null = null;
    if (scrape !== null) {
      const asks = udp.map(async (tracker) => {
        try {
          if ((await scrape([facts.infoHash], [tracker], { timeoutMs: TRACKER_PROBE_MS })).has(facts.infoHash)) answered.add(tracker);
        } catch {
          // A tracker that cannot be asked is a silent one.
        }
      });
      const whole = scrape([facts.infoHash], [...facts.trackers, ...DEFAULT_TRACKERS, ...(book?.list() ?? [])], { timeoutMs: TRACKER_PROBE_MS }).then(
        (counts) => counts.get(facts.infoHash) ?? null,
        () => null,
      );
      await Promise.all(asks);
      swarm = await whole;
    }
    let added: string[] = [];
    try {
      added = book === null ? [] : book.add(udp.filter((t) => answered.has(t)), facts.infoHash);
    } catch (err) {
      this.log(`[notesd] torrent: the tracker book could not be written: ${messageOf(err)}`);
    }
    const silent = udp.filter((t) => !added.includes(t));
    const o = facts.origin;
    const siteOrigin = o === null || o.known.site === null ? null : (this.opts.sites?.[o.known.site] ?? null);
    const origin = o === null ? null : { index: o.known.index, label: o.known.label, by: o.by, supported: o.known.site !== null, enabled: siteOrigin !== null, site_origin: siteOrigin, gate: o.known.site === null ? null : o.known.gate };
    const next =
      origin === null
        ? facts.unknownHosts.length > 0
          ? `No index we know signs its magnets with these trackers. The hosts ${facts.unknownHosts.join(', ')} are not public trackers we hold: find out which site runs them (a web search of the host, and the name's format), and when it is a torrent index worth asking, add it as a torrent site (claude/streaming/torrent/sites/, TORRENT_SITES, KNOWN_ORIGINS).`
          : 'The magnet carries only public trackers: nothing tells which index it came from.'
        : origin.supported
          ? origin.enabled
            ? `The magnet is from ${origin.label} (its tracker ${origin.by}), an index the torrent finder already asks at ${origin.site_origin} when the JSON indexes have nothing new.${origin.gate === null ? '' : ` Tell the owner: ${origin.gate}.`}`
            : `The magnet is from ${origin.label} (its tracker ${origin.by}); its site module exists and is switched off in this daemon's settings.`
          : `The magnet is from ${origin.label} (its tracker ${origin.by}), an index the torrent finder cannot ask yet: add it as a torrent site (claude/streaming/torrent/sites/, TORRENT_SITES, and its \`site\` in KNOWN_ORIGINS).`;
    this.log(`[notesd] torrent: magnet ${facts.infoHash.slice(0, 8)} read: ${origin === null ? 'no known index' : origin.label}, ${plural(added.length, 'tracker')} added${swarm === null ? '' : `, ${plural(swarm.seeders, 'seeder')} known`}`);
    return { ok: true, info_hash: facts.infoHash, name: facts.name, origin, unknown_hosts: facts.unknownHosts, trackers: { own: facts.own, known, added, silent, skipped }, swarm, next };
  }

  /**
   * The next episode, fetched while another plays (ahead.ts): `resolve`, and then everything a page would
   * need is stopped (the subtitle tiers still running, the sync, a remux), so only the download goes on. The
   * torrent stays in the swarm until `releaseAhead`. A later play finds the file with `fromDisk`.
   */
  async fetchAhead(ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
    const out = await this.resolve(ref, options);
    if (!out.ok) return out;
    out.torrent.stop.abort();
    if (out.torrent.manifestKind === 'hls') this.opts.remux?.release(out.torrent.infoHash, out.torrent.fileIndex);
    return out;
  }

  /** Lets go of a torrent `fetchAhead` took (once): with no other user the daemon leaves its swarm. */
  releaseAhead(torrent: SessionTorrent): void {
    if (!torrent.held) return;
    torrent.held = false;
    this.letGo(torrent.infoHash);
  }

  /** The picture height a torrent's release name says (from this host's row), or null when nothing says. Never throws. */
  async releaseHeight(infoHash: string): Promise<ReleaseHeight | null> {
    try {
      const name = (await this.opts.swarm.releaseName?.(infoHash)) ?? null;
      return name === null ? null : parseRelease(name).height;
    } catch {
      return null;
    }
  }

  /** True when this host holds a finished download of `ref`. */
  async onDisk(ref: StreamRef): Promise<boolean> {
    try {
      const download = await this.opts.swarm.find(ref);
      return download !== null && download.state === 'ready';
    } catch {
      return false;
    }
  }

  /**
   * One torrent the owner pasted (a magnet link or a bare 40-hex info hash), played without asking any index:
   * the swarm is opened, the title's file picked and probed, and the original-language check still applies (a
   * dub, or a torrent with no video file, is refused). `attempts` holds the one `Torrent: <name>`. Never throws.
   */
  async playMagnet(ref: StreamRef, options: TorrentResolveOptions & { magnet: string; pasted?: boolean }): Promise<TorrentResolve> {
    const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
    const candidate = candidateFromMagnet(options.magnet, query);
    if (candidate === null) {
      return { ok: false, error: 'no_source', attempts: [{ provider: 'Torrent: magnet', outcome: 'error', took_s: 0, detail: 'not a magnet link or a 40-character info hash' }] };
    }
    const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: options.resumeS ?? null, cloudTried: false };
    options.progress?.({ stage: `opening the torrent ${candidate.name}`, attempts: [] });
    // Asked beside the play, without joining anything: when the swarm sends nothing, the answer says how thin it is.
    const known = this.swarmCounts([candidate], TRACKER_PROBE_MS).then((counts) => counts.get(candidate.infoHash) ?? null);
    const tried = await this.tryCandidates(ref, query, [candidate], play, this.now() + TORRENT_DEADLINE_MS, options.progress);
    const swarm = tried.ok ? null : await known;
    const out: TorrentResolve =
      tried.ok || swarm === null
        ? tried
        : { ...tried, attempts: tried.attempts.map((a) => (a.outcome === 'no_stream' ? { ...a, detail: `${a.detail}; the trackers asked know ${plural(swarm.seeders, 'seeder')} and ${plural(swarm.leechers, 'leecher')} for it` } : a)) };
    if (options.pasted === true) {
      const kept = this.pasted.get(refKey(ref)) ?? new Map<string, { name: string; failed: string | null }>();
      const last = out.attempts.at(-1);
      kept.set(candidate.infoHash, { name: out.ok ? out.torrent.name : candidate.name, failed: out.ok ? null : last === undefined ? 'did not play' : `${last.outcome}: ${last.detail}` });
      this.pasted.set(refKey(ref), kept);
    }
    this.log(`[notesd] torrent: ${refLabel(ref)} from a pasted magnet (${candidate.infoHash.slice(0, 8)}): ${out.ok ? `playing ${out.torrent.name}` : 'did not play'}`);
    return out;
  }

  /** The shuffle button: the session's remaining candidates, in their order, without asking the indexes again. Torrents that failed this title lately are left out. */
  async next(ref: StreamRef, torrent: SessionTorrent, audioLang: string | null): Promise<TorrentResolve> {
    const key = refKey(ref);
    const failed = this.remembered(key);
    const marked = await this.leftOutByMarks(audioLang);
    const candidates = torrent.candidates.filter((c) => !failed.has(c.infoHash.toLowerCase()) && !marked.has(c.infoHash.toLowerCase()));
    if (torrent.query === null || candidates.length === 0) return { ok: false, error: 'no_source', attempts: [] };
    const play: PlayFacts = { audioLang, imdbId: torrent.imdbId, resumeS: null, cloudTried: false };
    // A torrent the shuffle tried and could not play is left out of the title's next plays too.
    return this.tryCandidates(ref, torrent.query, candidates, play, this.now() + TORRENT_DEADLINE_MS, undefined, (c, lasting, why) => this.remember(key, c.infoHash, lasting, why ?? null));
  }

  /**
   * A session's torrent kept stalling while it played (autoSwitch in service.ts): it is left out of this title's next
   * asks like a swarm that did not deliver (SWARM_FAILURE_KEEP_MS), so `next` and `resolve` try the others.
   */
  noteStalled(ref: StreamRef, infoHash: string): void {
    this.remember(refKey(ref), infoHash, false);
  }

  /** A torrent heard as a dub of this title: left out of its asks like a file that will not change (it is kept in the marks too). */
  noteDubbed(ref: StreamRef, infoHash: string, why: string | null = null): void {
    this.remember(refKey(ref), infoHash, true, why === null ? 'dubbed: heard' : `dubbed: ${why}`);
  }

  /** The info hashes the marks keep out of a play of a title whose original is `audioLang`; empty when the marks cannot be read. */
  async leftOutByMarks(audioLang: string | null): Promise<Set<string>> {
    const marks = this.opts.marks ?? null;
    if (marks === null) return new Set();
    try {
      return await marks.leftOut(audioLang);
    } catch (err) {
      this.log(`[notesd] torrent: the torrent marks could not be read: ${messageOf(err)}`);
      return new Set();
    }
  }

  /** The torrent marks (the blacklist, heard languages); null when none are wired. */
  get marks(): TorrentMarks | null {
    return this.opts.marks ?? null;
  }

  private keepListing(key: string, found: FindAnswer): void {
    this.listings.set(key, { at: this.now(), found });
    // A few dozen titles at most: the oldest goes first.
    while (this.listings.size > 64) this.listings.delete(this.listings.keys().next().value as string);
  }

  /**
   * Every candidate torrent of a film or episode, for the candidates list: what the indexes list (asked now, or their
   * answer of the last CANDIDATE_LIST_TTL_MS, a play's own included; `fresh` always asks), the torrents this machine
   * opened for it before, and the magnets pasted for it, each with its marks, how it went and what the trackers know.
   * Joins no swarm. `remembered` is the info hash a Torrent Stream play opens again first.
   */
  async listCandidates(ref: StreamRef, options: { audioLang: string | null; imdbId: string | null; names?: TitleNames | null; fresh?: boolean; remembered?: string | null }): Promise<TorrentCandidateList> {
    const key = refKey(ref);
    const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
    let kept = this.listings.get(key) ?? null;
    let cached = true;
    if (kept !== null && this.now() - kept.at >= CANDIDATE_LIST_TTL_MS) kept = null;
    if (options.fresh === true || kept === null) {
      cached = false;
      try {
        const found = await this.opts.find(query, AbortSignal.timeout(CANDIDATE_LIST_FIND_MS));
        this.keepListing(key, found);
        kept = this.listings.get(key) ?? null;
      } catch (err) {
        this.log(`[notesd] torrent: the indexes could not be asked for the candidates of ${refLabel(ref)}: ${messageOf(err)}`);
      }
    }
    const found = kept?.found ?? null;
    const failures = this.failed.get(key) ?? new Map<string, { until: number; lasting: boolean; why: string | null }>();
    const failedOf = (hash: string): string | null => failures.get(hash)?.why ?? null;
    const releaseOf = (name: string) => parseRelease(name, { title: query.title ?? null, originalTitle: query.originalTitle ?? null, originalLanguage: query.originalLanguage ?? null });
    const gathered: Gathered[] = [];
    const seen = new Set<string>();
    const add = (g: Gathered): void => {
      if (seen.has(g.infoHash)) return;
      seen.add(g.infoHash);
      gathered.push(g);
    };
    for (const [list, dubNamed] of [[found?.candidates ?? [], false], [found?.lastResort ?? [], true]] as const) {
      for (const c of list) {
        add({ infoHash: c.infoHash, name: c.name, release: c.release, sizeBytes: c.sizeBytes, seeds: c.seeds, from: c.listedBy.length > 0 ? c.listedBy : [c.index], dubNamed, leftOut: null, failed: failedOf(c.infoHash), worked: false, onDisk: false });
      }
    }
    for (const [hash, p] of this.pasted.get(key) ?? []) {
      add({ infoHash: hash, name: p.name, release: releaseOf(p.name), sizeBytes: null, seeds: null, from: ['magnet'], dubNamed: false, leftOut: null, failed: p.failed, worked: p.failed === null, onDisk: false });
    }
    let rows: TorrentSlotRecord[] = [];
    try {
      rows = (await this.opts.swarm.downloadsOf?.(ref)) ?? [];
    } catch (err) {
      this.log(`[notesd] torrent: this machine's torrents of ${refLabel(ref)} could not be read: ${messageOf(err)}`);
    }
    for (const r of rows) {
      const name = r.release ?? r.name;
      add({ infoHash: r.infoHash, name, release: releaseOf(name), sizeBytes: r.fileLength, seeds: null, from: ['played before'], dubNamed: false, leftOut: null, failed: failedOf(r.infoHash), worked: false, onDisk: false });
    }
    const remembered = options.remembered?.toLowerCase() ?? null;
    if (remembered !== null && !seen.has(remembered)) {
      add({ infoHash: remembered, name: (await this.opts.swarm.releaseName?.(remembered).catch(() => null)) ?? remembered, release: { height: null, languages: [], dubGroup: null }, sizeBytes: null, seeds: null, from: ['played before'], dubNamed: false, leftOut: null, failed: failedOf(remembered), worked: true, onDisk: false });
    }
    for (const e of found?.excluded ?? []) {
      if (e.reason === 'bad_hash' || e.reason === 'other_title' || e.reason === 'other_year' || e.reason === 'other_episode') continue;
      add({ infoHash: e.infoHash, name: e.name, release: releaseOf(e.name), sizeBytes: null, seeds: e.seeds, from: [e.index], dubNamed: false, leftOut: e.reason, failed: failedOf(e.infoHash), worked: false, onDisk: false });
    }
    const hashes = gathered.map((g) => g.infoHash);
    let marks = new Map<string, TorrentMark>();
    try {
      marks = (await this.opts.marks?.many(hashes)) ?? new Map();
    } catch (err) {
      this.log(`[notesd] torrent: the torrent marks could not be read: ${messageOf(err)}`);
    }
    const counts = await this.swarmCounts(gathered.map((g) => ({ infoHash: g.infoHash, trackers: [] }) as unknown as TorrentCandidate), TRACKER_PROBE_MS);
    return {
      original_language: options.audioLang,
      listed_at: kept === null ? null : new Date(kept.at).toISOString(),
      cached: kept !== null && cached,
      indexes: found?.indexes ?? [],
      candidates: candidateRows(gathered, { audioLang: options.audioLang, marks, rows, counts, remembered }),
    };
  }

  /** True when a hearing can run at all (a hearer is wired). */
  get hears(): boolean {
    return (this.opts.hear ?? null) !== null;
  }

  /**
   * The torrent audio check: a session's torrent whose file tags no audio language is heard (~30 s through Whisper,
   * TORRENT_HEAR_AFTER_S after where the play starts, from the daemon's own file route) and the language heard is
   * kept on the torrent (marks.ts), whatever the verdict but `unsure`. A torrent heard before answers from the marks.
   * Null when no hearer is wired. Never throws: a failure is `unsure`.
   */
  async hearAudio(torrent: Pick<SessionTorrent, 'infoHash' | 'fileIndex' | 'name' | 'durationS'>, audioLang: string, startS: number | null): Promise<TorrentHearing | null> {
    const hear = this.opts.hear ?? null;
    if (hear === null) return null;
    const original = normalizeAudioLang(audioLang);
    try {
      const mark = (await this.opts.marks?.get(torrent.infoHash)) ?? null;
      if (mark?.heardLanguage != null && original !== null) {
        const dub = mark.heardLanguage !== original;
        return {
          verdict: dub ? 'dubbed' : 'original',
          detected: mark.heardLanguage,
          probability: mark.heardProbability,
          reason: dub ? `heard before: the audio is spoken ${mark.heardLanguage}, not the original ${original}` : `heard before: the audio is spoken ${mark.heardLanguage}, the original`,
          kept: true,
        };
      }
      const url = `${this.opts.localBase()}${this.opts.swarm.localUrl(torrent.infoHash, torrent.fileIndex)}`;
      const source: ResolvedSource = {
        provider: TORRENT_PROVIDER,
        embed_url: '',
        manifest_url: url,
        manifest_kind: 'mp4',
        headers: { referer: null, origin: null, user_agent: null },
        subtitles: [],
        best_height: null,
        en_subtitle: false,
        took_s: null,
      };
      const finding = await hear.hear(source, audioLang, hearAt(torrent.durationS ?? null, startS));
      if (finding.verdict !== 'unsure' && finding.detected !== null && finding.probability !== null) {
        await this.opts.marks?.noteHeard(torrent.infoHash, torrent.name, finding.detected, finding.probability);
      }
      this.log(`[notesd] torrent: audio of ${torrent.name} (${torrent.infoHash.slice(0, 8)}), whose file tags no language: ${finding.verdict} (${finding.reason})`);
      return { ...finding, kept: false };
    } catch (err) {
      this.log(`[notesd] torrent: the audio of ${torrent.name} (${torrent.infoHash.slice(0, 8)}) could not be heard: ${messageOf(err)}`);
      return { verdict: 'unsure', detected: null, probability: null, reason: messageOf(err).slice(0, 200), kept: false };
    }
  }

  /** Keeps the audio languages a probed file's tags name (marks.ts), behind the play. */
  private noteTags(infoHash: string, name: string, languages: readonly string[]): void {
    const marks = this.opts.marks ?? null;
    if (marks === null) return;
    void marks.noteTags(infoHash, name, languages).catch((err: unknown) => this.log(`[notesd] torrent: the tags of ${infoHash.slice(0, 8)} could not be kept: ${messageOf(err)}`));
  }

  /**
   * What the session's swarm delivers now: the peers, the rate and the film's own bitrate (null when unknown). Null
   * when the torrent is not in the swarm or the engine cannot say.
   */
  delivery(torrent: SessionTorrent): { peers: number; downKbps: number; filmKbps: number | null } | null {
    let stats: Pick<TorrentStats, 'peers' | 'down_kbps'> | null = null;
    try {
      stats = this.opts.swarm.stats?.(torrent.infoHash) ?? null;
    } catch {
      stats = null;
    }
    return stats === null ? null : { peers: stats.peers, downKbps: stats.down_kbps, filmKbps: torrent.filmKbps ?? null };
  }

  /**
   * R2.9: this host's finished download of the title, played from disk with no index asked and no swarm
   * joined. Null when there is none, it is not whole, or its file does not play (another language, a file
   * Chrome cannot play): the play then goes on as if there were none. `attempts` are the subtitle tiers' only.
   */
  async fromDisk(ref: StreamRef, options: { audioLang: string | null; resumeS?: number | null }): Promise<{ torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] } | null> {
    let download: DownloadOnDisk | null;
    let remuxOnly = false;
    try {
      download = await this.opts.swarm.find(ref);
      if (download === null || download.state !== 'ready') return null;
      if ((await this.opts.swarm.filePath(download.infoHash, download.fileIndex)) === null) {
        // Its original was deleted beside its whole remux: the remux plays, with the probe kept beside it.
        remuxOnly = (await this.opts.swarm.remuxOnly?.(download.infoHash, download.fileIndex)) === true;
        if (!remuxOnly) return null;
      }
    } catch (err) {
      this.log(`[notesd] torrent: could not read this machine's downloads of ${refLabel(ref)}: ${messageOf(err)}`);
      return null;
    }
    if ((await this.leftOutByMarks(options.audioLang)).has(download.infoHash.toLowerCase())) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} is not played again: it is blacklisted, or was heard as a dub`);
      return null;
    }
    const manifestUrl = this.opts.swarm.localUrl(download.infoHash, download.fileIndex);
    let probe: MediaProbe;
    try {
      const kept = remuxOnly ? ((await this.opts.remux?.savedProbe(download.infoHash, download.fileIndex)) ?? null) : null;
      if (remuxOnly && kept === null) throw new Error('it lives as its remux, and no probe of it is kept beside the remux');
      probe = kept ?? (await this.opts.probe(`${this.opts.localBase()}${manifestUrl}`, TORRENT_PROBE_TIMEOUT_MS));
    } catch (err) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} could not be read: ${messageOf(err)}`);
      return null;
    }
    const refusal = refusalOf(probe, options.audioLang, this.opts.remux ?? null);
    if (refusal !== null) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} is not played again (${refusal.outcome}: ${refusal.detail})`);
      return null;
    }
    let page: { manifestUrl: string; manifestKind: 'mp4' | 'hls' };
    try {
      page = await this.fileForPage(download.infoHash, download.fileIndex, probe, options.audioLang, undefined, remuxOnly);
    } catch (err) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} could not be remuxed: ${messageOf(err)}`);
      return null;
    }
    this.noteDuration(download.infoHash, probe, download.fileIndex);
    const stop = new AbortController();
    const torrent: SessionTorrent = {
      infoHash: download.infoHash,
      fileIndex: download.fileIndex,
      selected: [download.fileIndex],
      name: download.name,
      index: null,
      seeds: null,
      state: 'ready',
      height: probe.video?.height ?? null,
      manifestUrl: page.manifestUrl,
      manifestKind: page.manifestKind,
      subtitles: [],
      subtitleRev: 0,
      candidates: [],
      durationS: probe.durationS,
      candidate: null,
      held: false,
      imdbId: null,
      query: null,
      stop,
    };
    const attempts = await this.startSubtitles(
      torrent,
      {
        ref,
        imdbId: null,
        infoHash: download.infoHash,
        release: download.release ?? download.name,
        files: [],
        fileIndex: download.fileIndex,
        subtitleIndexes: [],
        handle: null,
        probe,
        audioLang: options.audioLang,
        resumeS: options.resumeS ?? null,
        cloudTried: false,
        localBase: this.opts.localBase(),
        signal: stop.signal,
      },
      { ref, imdbId: null, infoHash: download.infoHash, fileIndex: download.fileIndex, durationS: probe.durationS },
    );
    return { torrent, source: standIn(torrent, probe, options.audioLang, null), attempts };
  }

  /** Takes the session's torrent again after a release (a reload of the page, a refresh). Throws when the swarm cannot open it. */
  async hold(ref: StreamRef, torrent: SessionTorrent): Promise<void> {
    const c = torrent.candidate;
    if (torrent.held || c === null) return;
    await this.opts.swarm.open({ infoHash: c.infoHash, trackers: this.trackersOf(c), name: c.name, ref, release: c.release }, { timeoutMs: TORRENT_OPEN_TIMEOUT_MS });
    await this.opts.swarm.use(c.infoHash, [...torrent.selected]);
    if (torrent.stop.signal.aborted) torrent.stop = new AbortController();
    torrent.held = true;
    // A sync the release stopped starts over; one that finished changed the subtitle, and nothing starts.
    const sync = this.syncs.get(torrent);
    if (sync !== undefined) this.startSync(torrent, sync);
    // A remux stopped with the release starts again (torrent phase 5); its playlist keeps its address.
    if (torrent.manifestKind === 'hls') await this.opts.remux?.resume(torrent.infoHash, torrent.fileIndex);
  }

  /** Lets go of the session's torrent (once), and stops its growing subtitle tiers. */
  release(torrent: SessionTorrent): void {
    torrent.stop.abort();
    if (!torrent.held) return;
    torrent.held = false;
    if (torrent.manifestKind === 'hls') this.opts.remux?.release(torrent.infoHash, torrent.fileIndex);
    this.letGo(torrent.infoHash);
  }

  /** `ready` once the chosen file is whole on disk, else `downloading`. */
  async state(torrent: SessionTorrent): Promise<SessionTorrent['state']> {
    try {
      if ((await this.opts.swarm.filePath(torrent.infoHash, torrent.fileIndex)) !== null) return 'ready';
      return (await this.opts.swarm.remuxOnly?.(torrent.infoHash, torrent.fileIndex)) === true ? 'ready' : 'downloading';
    } catch {
      return torrent.state;
    }
  }

  /**
   * The address the page plays the file from: its file route when Chrome plays it as is, else the remux playlist
   * (torrent phase 5), answered once the remux's first segment is on disk. ffmpeg reads the file from disk once it is
   * whole, else through the file route. Throws RemuxError.
   */
  private async fileForPage(
    infoHash: string,
    fileIndex: number,
    probe: MediaProbe,
    audioLang: string | null,
    timeoutMs?: number,
    remuxOnly = false,
  ): Promise<{ manifestUrl: string; manifestKind: 'mp4' | 'hls' }> {
    const fileUrl = this.opts.swarm.localUrl(infoHash, fileIndex);
    const remux = this.opts.remux ?? null;
    // A file that lives as its remux has no original to hand out: its finished remux plays, whatever the probe says.
    if (remux === null) {
      if (remuxOnly) throw new Error('it lives as its remux, and the remux is off');
      // With no remux, refusalOf already refused a file Chrome cannot play, so this only serves truly direct ones.
      return { manifestUrl: fileUrl, manifestKind: 'mp4' };
    }
    // playsOriginalDirect, not probe.direct: a dual-audio file whose original is not the default is remuxed, so the
    // original track plays.
    if (!remuxOnly && playsOriginalDirect(probe, audioLang)) return { manifestUrl: fileUrl, manifestKind: 'mp4' };
    const input = (await this.opts.swarm.filePath(infoHash, fileIndex)) ?? `${this.opts.localBase()}${fileUrl}`;
    const play = await remux.start({ infoHash, fileIndex, input, probe, audioLang }, timeoutMs === undefined ? {} : { timeoutMs });
    return { manifestUrl: play.manifestUrl, manifestKind: 'hls' };
  }

  /** Wyzie Synced for the session's subtitle, behind the play: it starts only for a subtitle from outside the torrent (synced.ts). */
  private startSync(torrent: SessionTorrent, request: Omit<TorrentSyncRequest, 'signal' | 'target'>): void {
    if (this.opts.sync == null) return;
    this.syncs.set(torrent, request);
    void this.opts.sync.start({ ...request, signal: torrent.stop.signal, target: torrent });
  }

  private letGo(infoHash: string): void {
    void Promise.resolve()
      .then(() => this.opts.swarm.release(infoHash))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not release ${infoHash}: ${messageOf(err)}`));
  }

  /** Phase 1's map turns bytes into seconds once it knows the length (the page's grey bar). */
  private noteDuration(infoHash: string, probe: MediaProbe, fileIndex: number): void {
    if (probe.durationS === null) return;
    const seconds = probe.durationS;
    void Promise.resolve()
      .then(() => this.opts.swarm.setDuration(infoHash, seconds, fileIndex))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not record the length of ${infoHash}: ${messageOf(err)}`));
  }

/**
   * The subtitle chain for a session's torrent. It may hold the answer for `subtitleHeadMs` (a kept file, a replay);
   * after that the play is answered with `Subtitles: pending` and the chain goes on behind it: when it ends the
   * track is put on the session, `subtitleRev` goes up (the open page loads it on its next position report) and
   * `subtitlesPending` answers the chain's attempts. Wyzie Synced starts once the chain has ended, either way.
   */
  private async startSubtitles(torrent: SessionTorrent, ctx: Omit<SubtitleContext, 'deadline'>, sync: Omit<TorrentSyncRequest, 'signal' | 'target'>): Promise<ResolveAttempt[]> {
    const started = this.now();
    let late = false;
    const said = (attempts: readonly ResolveAttempt[]): string => attempts.map((a) => `${a.provider.replace(/^Subtitles: /, '')} ${a.outcome} ${a.took_s ?? 0} s`).join(', ');
    const chain = runSubtitleChain(this.opts.tiers, ctx, { log: this.log }).then((out) => {
      // A subtitle put on the session meanwhile (/sync-subtitle's checked file) is never replaced by one that ranks lower.
      const takes = out.subtitles.length > 0 && rankOf(out.subtitles) >= rankOf(torrent.subtitles);
      if (takes || torrent.subtitles.length === 0) torrent.subtitles = out.subtitles;
      if (late) {
        if (takes) torrent.subtitleRev += 1;
        torrent.subtitlesPending = null;
        this.log(`[notesd] torrent: subtitles of ${ctx.infoHash.slice(0, 8)} ${out.subtitles.length > 0 ? 'arrived' : 'not found'} behind the play, ${seconds(started, this.now())} s after the search began (${said(out.attempts)})`);
      }
      this.startSync(torrent, sync);
      // The release's own subtitle file, still downloading when the chain ended, takes the place of what it answered.
      void out.later?.then((more) => {
        if (more.subtitles.length === 0 || torrent.stop.signal.aborted || rankOf(more.subtitles) <= rankOf(torrent.subtitles)) return;
        torrent.subtitles = more.subtitles;
        torrent.subtitleRev += 1;
        this.log(`[notesd] torrent: the release's own subtitle of ${ctx.infoHash.slice(0, 8)} arrived ${seconds(started, this.now())} s after the search began and takes the place of the one shown (${said(more.attempts)})`);
      });
      return out.attempts;
    });
    const headMs = this.opts.subtitleHeadMs ?? SUBTITLE_HEAD_MS;
    const timer = sleep(headMs);
    const head = await Promise.race([chain, timer.done.then(() => null)]);
    timer.clear();
    if (head !== null) return head;
    late = true;
    torrent.subtitlesPending = chain;
    return [{ provider: SUBTITLES_PENDING, outcome: 'skipped', took_s: seconds(started, this.now()), detail: 'the subtitle search goes on behind the play; the player loads the track when it arrives' }];
  }

  /**
   * Lets go of a torrent that will not play, leaving its swarm at once where the swarm can. `held`: this caller's
   * `use` took a hold, which is given back (`drop`); without one nobody's hold is touched (`discard`).
   */
  private dropNow(infoHash: string, held: boolean): void {
    const swarm = this.opts.swarm;
    const letGo = held ? swarm.drop : swarm.discard;
    void Promise.resolve()
      .then(() => (letGo === undefined ? swarm.release(infoHash) : letGo.call(swarm, infoHash)))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not release ${infoHash}: ${messageOf(err)}`));
  }

  /** What a torrent received so far, for a log line: `4.1 MB, 5 peers, 1.3 Mbps`; empty words when the swarm cannot say. */
  private receivedText(infoHash: string): string {
    let bytes: number | null = null;
    let stats: Pick<TorrentStats, 'peers' | 'down_kbps'> | null = null;
    try {
      bytes = this.opts.swarm.received?.(infoHash) ?? null;
      stats = this.opts.swarm.stats?.(infoHash) ?? null;
    } catch {
      // A torrent that is gone says nothing.
    }
    const parts = [bytes === null ? null : `${(bytes / 1e6).toFixed(1)} MB received`, stats === null ? null : `${plural(stats.peers, 'peer')}, ${mbps(stats.down_kbps)} Mbps`].filter((x) => x !== null);
    return parts.length === 0 ? 'nothing known of its swarm' : parts.join(', ');
  }

  /**
   * ffprobe on a racer's file, given as long as its swarm delivers (up to `budgetMs`, the play's whole budget left):
   * it is stopped when the torrent received less than PROBE_STALL_BYTES in the last PROBE_STALL_MS. A swarm that
   * cannot say what it received gets the flat TORRENT_PROBE_TIMEOUT_MS. Never throws.
   */
  private async probeWhileDelivering(
    url: string,
    infoHash: string,
    budgetMs: number,
    cancelled: () => boolean,
  ): Promise<{ ok: true; probe: MediaProbe } | { ok: false; outcome: ResolveOutcome; detail: string }> {
    const received = (): number | null => {
      try {
        return this.opts.swarm.received?.(infoHash) ?? null;
      } catch {
        return null;
      }
    };
    const started = this.now();
    const first = received();
    if (first === null) {
      const probeMs = Math.max(PROBE_MIN_MS, Math.min(TORRENT_PROBE_TIMEOUT_MS, budgetMs));
      try {
        return { ok: true, probe: await this.opts.probe(url, probeMs) };
      } catch (err) {
        return err instanceof ProbeError && err.code === 'timeout'
          ? { ok: false, outcome: 'no_stream', detail: `the swarm sent too little of the file to read it within ${Math.round(probeMs / 1000)} s` }
          : { ok: false, outcome: 'error', detail: `ffprobe could not read the file: ${messageOf(err)}` };
      }
    }
    const stallMs = this.opts.probeStallMs ?? PROBE_STALL_MS;
    const probeMs = Math.max(PROBE_MIN_MS, budgetMs);
    const controller = new AbortController();
    const samples: Array<{ at: number; bytes: number }> = [{ at: started, bytes: first }];
    let stalled: string | null = null;
    const watch = setInterval(() => {
      if (cancelled()) {
        controller.abort();
        return;
      }
      const at = this.now();
      const bytes = received() ?? samples.at(-1)!.bytes;
      samples.push({ at, bytes });
      // The newest sample at least stallMs old is the window's start; older ones are no longer needed.
      while (samples.length > 2 && at - samples[1]!.at >= stallMs) samples.shift();
      const from = samples[0]!;
      if (at - from.at < stallMs || bytes - from.bytes >= PROBE_STALL_BYTES) return;
      stalled = `the swarm stalled before the header arrived: ${((bytes - from.bytes) / 1e6).toFixed(1)} MB in the last ${Math.round((at - from.at) / 1000)} s (${this.receivedText(infoHash)} in ${seconds(started, at)} s)`;
      controller.abort();
    }, this.opts.probeSampleMs ?? PROBE_SAMPLE_MS);
    try {
      return { ok: true, probe: await this.opts.probe(url, probeMs, { signal: controller.signal }) };
    } catch (err) {
      if (stalled !== null) return { ok: false, outcome: 'no_stream', detail: stalled };
      if (err instanceof ProbeError && (err.code === 'timeout' || err.code === 'aborted')) {
        return { ok: false, outcome: 'no_stream', detail: `the play's budget ran out before the header arrived (${this.receivedText(infoHash)} in ${seconds(started, this.now())} s)` };
      }
      return { ok: false, outcome: 'error', detail: `ffprobe could not read the file: ${messageOf(err)}` };
    } finally {
      clearInterval(watch);
    }
  }

  private deliveryOf(p: Pick<Passed, 'c' | 'opened' | 'video' | 'probe'>): Delivery | null {
    let stats: Pick<TorrentStats, 'peers' | 'down_kbps'> | null = null;
    try {
      stats = this.opts.swarm.stats?.(p.c.infoHash) ?? null;
    } catch {
      stats = null;
    }
    if (stats === null) return null;
    const filmKbps = filmKbpsOf(p.opened.files.find((f) => f.index === p.video)?.length ?? null, p.probe.durationS);
    return { peers: stats.peers, downKbps: stats.down_kbps, filmKbps };
  }

  private deliveryText(d: Delivery | null): string {
    if (d === null) return '';
    return ` listed; ${d.peers} peer${d.peers === 1 ? '' : 's'} connected, ${mbps(d.downKbps)} Mbps${d.filmKbps === null ? '' : ` for a ${mbps(d.filmKbps)} Mbps film`}`;
  }

  /**
   * Opens up to TORRENT_RACE_WIDTH candidates side by side, in the finder's order, and plays the best of those whose
   * header arrives (chooseOrder), giving the others TORRENT_SETTLE_MS to arrive too. A torrent that fails makes room
   * for the next candidate, up to MAX_TORRENT_TRIES in all and until `deadline`. The ones not chosen leave their
   * swarms at once and stay first in line for the shuffle button. `attempts` are in the finder's order.
   */
  private async tryCandidates(
    ref: StreamRef,
    query: FindQuery,
    candidates: readonly TorrentCandidate[],
    play: PlayFacts,
    deadline: number,
    progress?: (progress: TorrentProgress) => void,
    note?: NoteFailure,
  ): Promise<TorrentResolve> {
    const pool = candidates.slice(0, MAX_TORRENT_TRIES);
    const results = new Map<number, ResolveAttempt>();
    const passed: Passed[] = [];
    const running = new Map<number, { racer: Racer; done: Promise<void>; c: TorrentCandidate }>();
    let next = 0;
    const attemptsNow = (): ResolveAttempt[] => [...results.entries()].sort((a, b) => a[0] - b[0]).map(([, a]) => a);
    const report = (): void => {
      if (progress === undefined) return;
      const names = [...running.values()].map((r) => r.c.name);
      progress({ stage: names.length === 0 ? 'choosing a torrent' : `opening ${names.length} torrent${names.length === 1 ? '' : 's'}: ${names.join('; ')}`, attempts: attemptsNow() });
    };
    const launch = (): void => {
      while (running.size < TORRENT_RACE_WIDTH && next < pool.length && deadline - this.now() > 0) {
        const position = next++;
        const c = pool[position]!;
        const racer = this.race(ref, query, c, position, play, deadline - this.now());
        const done = racer.result.then((raced) => {
          if (!running.delete(position)) return;
          if (raced.ok) passed.push(raced.passed);
          else {
            results.set(position, raced.attempt);
            if (raced.attempt.outcome !== 'skipped') this.log(`[notesd] torrent: ${refLabel(ref)}: ${c.name} (${c.infoHash.slice(0, 8)}) lost: ${raced.attempt.outcome} after ${raced.attempt.took_s ?? 0} s, ${raced.attempt.detail}`);
            if (raced.attempt.outcome !== 'skipped') note?.(c, raced.lasting === true, `${raced.attempt.outcome}: ${raced.attempt.detail}`);
          }
          report();
        });
        running.set(position, { racer, done, c });
      }
      report();
    };
    for (;;) {
      if (passed.length === 0) launch();
      if (running.size === 0 && passed.length === 0) break;
      if (passed.length === 0) {
        await Promise.race([...running.values()].map((r) => r.done));
        if (passed.length === 0) continue;
        // One header is here: the others still opening get a moment to arrive too, then the swarms are compared. A racer
        // of a preferred height (1080p while a 720p arrived) gets longer: it plays when it arrives, and gives up by itself
        // when its swarm stalls.
        const bestHeight = Math.min(...passed.map((p) => heightRank(p.height)));
        const better = [...running.values()].filter((r) => heightRank(r.c.release.height) < bestHeight);
        const settleMs = Math.min(better.length > 0 ? (this.opts.heightSettleMs ?? HEIGHT_SETTLE_MS) : (this.opts.settleMs ?? TORRENT_SETTLE_MS), deadline - this.now());
        if (running.size > 0 && settleMs > 0) {
          if (better.length > 0) this.log(`[notesd] torrent: ${refLabel(ref)}: ${passed[0]!.c.name} arrived; waiting up to ${Math.round(settleMs / 1000)} s for ${better.map((r) => r.c.name).join('; ')} (preferred height)`);
          const timer = sleep(settleMs);
          await Promise.race([Promise.all((better.length > 0 ? better : [...running.values()]).map((r) => r.done)), timer.done]);
          timer.clear();
        }
      }
      const best = chooseOrder(passed, (p) => this.deliveryOf(p))[0]!;
      passed.splice(passed.indexOf(best), 1);
      const delivery = this.deliveryOf(best);
      const won = await this.finish(ref, query, best, play, delivery, Math.max(PROBE_MIN_MS, deadline - this.now()));
      results.set(best.position, won.attempt);
      if (!won.ok) {
        best.drop();
        note?.(best.c, false, `${won.attempt.outcome}: ${won.attempt.detail}`);
        continue;
      }
      const later: TorrentCandidate[] = [];
      for (const p of chooseOrder(passed, (x) => this.deliveryOf(x))) {
        this.log(`[notesd] torrent: ${refLabel(ref)}: ${p.c.name} (${p.c.infoHash.slice(0, 8)}) lost: its header arrived too (${p.height ?? '?'}p${this.deliveryText(this.deliveryOf(p))}); ${best.c.name} was chosen`);
        results.set(p.position, {
          provider: torrentLabel(p.c.name),
          outcome: 'skipped',
          took_s: p.tookS,
          detail: `its header arrived too (${p.c.seeds} seeds${this.deliveryText(this.deliveryOf(p))}); ${best.c.name} was chosen`,
        });
        p.drop();
        later.push(p.c);
      }
      for (const [position, r] of [...running.entries()].sort((a, b) => a[0] - b[0])) {
        running.delete(position);
        this.log(`[notesd] torrent: ${refLabel(ref)}: ${r.c.name} (${r.c.infoHash.slice(0, 8)}) lost: still opening (${this.receivedText(r.c.infoHash)}) when ${best.c.name} was chosen`);
        r.racer.cancel();
        results.set(position, { provider: torrentLabel(r.c.name), outcome: 'skipped', took_s: null, detail: `still opening when ${best.c.name} was chosen` });
        later.push(r.c);
      }
      // The same object, not a copy: the sync and a late subtitle chain write into it.
      won.torrent.candidates = [...later, ...candidates.slice(next)];
      return { ok: true, torrent: won.torrent, source: won.source, attempts: [...attemptsNow(), ...won.subtitleAttempts] };
    }
    return { ok: false, error: 'no_source', attempts: attemptsNow() };
  }

  /**
   * One candidate up to its header: the file list from the swarm, the film's file, its selection, and ffprobe reading
   * the header through the file route. A torrent that fails lets go of itself; one that passes stays selected (it
   * keeps downloading) until it is chosen or dropped.
   */
  private race(ref: StreamRef, query: FindQuery, c: TorrentCandidate, position: number, play: PlayFacts, budgetMs: number): Racer {
    const started = this.now();
    // `held`: this racer's `use` counted it as a user of the torrent; only then is there a hold to give back.
    const state = { cancelled: false, opened: false, held: false, gone: false };
    const drop = (): void => {
      if (!state.opened || state.gone) return;
      state.gone = true;
      this.dropNow(c.infoHash, state.held);
    };
    const attempt = (outcome: ResolveOutcome, detail: string): ResolveAttempt => ({ provider: torrentLabel(c.name), outcome, took_s: seconds(started, this.now()), detail });
    const fail = (outcome: ResolveOutcome, detail: string, lasting = false): Raced => {
      drop();
      return { ok: false, attempt: attempt(outcome, detail), lasting };
    };
    const left = (): Raced => fail('skipped', 'another torrent was chosen');
    const run = async (): Promise<Raced> => {
      let opened: OpenedTorrent;
      try {
        opened = await this.opts.swarm.open({ infoHash: c.infoHash, trackers: this.trackersOf(c), name: c.name, ref, release: c.release }, { timeoutMs: Math.min(TORRENT_OPEN_TIMEOUT_MS, budgetMs) });
      } catch (err) {
        // Released too: an open that gave up may still have left the torrent in the swarm.
        state.opened = true;
        return fail('no_stream', `${NO_FILE_LIST} (${messageOf(err)})`);
      }
      state.opened = true;
      if (state.cancelled) return left();
      try {
        const picked = pickFile(opened.files, query);
        if (picked === null) {
          return fail('no_stream', ref.kind === 'tv' ? `the torrent holds no file of S${pad(ref.season)}E${pad(ref.episode)}` : 'the torrent holds no video file', true);
        }
        // Set before the call: the swarm counts the user at once, and a cancel while the row is written must give it back.
        state.held = true;
        try {
          await this.opts.swarm.use(c.infoHash, [picked.video, ...picked.subtitles]);
        } catch (err) {
          state.held = false;
          throw err;
        }
        if (state.cancelled) return left();
        const manifestUrl = this.opts.swarm.localUrl(c.infoHash, picked.video);
        let probe: MediaProbe;
        const probed = await this.probeWhileDelivering(`${this.opts.localBase()}${manifestUrl}`, c.infoHash, budgetMs - (this.now() - started), () => state.cancelled);
        if (state.cancelled) return left();
        if (!probed.ok) return fail(probed.outcome, probed.detail);
        probe = probed.probe;
        this.noteTags(c.infoHash, c.name, audioLanguages(probe));
        if (state.cancelled) return left();
        const refusal = refusalOf(probe, play.audioLang, this.opts.remux ?? null);
        if (refusal !== null) return fail(refusal.outcome, refusal.detail, true);
        const videoName = opened.files.find((f) => f.index === picked.video)?.name ?? '';
        return {
          ok: true,
          passed: { position, c, opened, video: picked.video, subtitles: picked.subtitles, probe, height: c.release.height ?? null, english: hasEnglishSubtitleFile(opened.files, picked.subtitles, videoName), tookS: seconds(started, this.now()), drop },
        };
      } catch (err) {
        return fail('error', messageOf(err));
      }
    };
    return {
      cancel: () => {
        state.cancelled = true;
        drop();
      },
      result: run(),
    };
  }

  /** The chosen torrent becomes the session's: the address the page plays (a remux starts here), then its subtitles. */
  private async finish(ref: StreamRef, query: FindQuery, p: Passed, play: PlayFacts, delivery: Delivery | null, budgetMs: number): Promise<Tried> {
    const { c, probe } = p;
    const audioLang = play.audioLang;
    try {
      let page: { manifestUrl: string; manifestKind: 'mp4' | 'hls' };
      try {
        page = await this.fileForPage(c.infoHash, p.video, probe, audioLang, budgetMs);
      } catch (err) {
        return { ok: false, attempt: { provider: torrentLabel(c.name), outcome: 'unplayable', took_s: p.tookS, detail: `${describeProbe(probe)}: the remux did not start (${messageOf(err)})` } };
      }
      this.noteDuration(c.infoHash, probe, p.video);
      const stop = new AbortController();
      const torrent: SessionTorrent = {
        infoHash: c.infoHash,
        fileIndex: p.video,
        selected: [p.video, ...p.subtitles],
        name: c.name,
        index: c.index,
        seeds: c.seeds,
        state: 'downloading',
        height: probe.video?.height ?? c.release.height ?? null,
        manifestUrl: page.manifestUrl,
        manifestKind: page.manifestKind,
        subtitles: [],
        subtitleRev: 0,
        candidates: [],
        durationS: probe.durationS,
        filmKbps: filmKbpsOf(p.opened.files.find((f) => f.index === p.video)?.length ?? null, probe.durationS),
        candidate: c,
        held: true,
        imdbId: play.imdbId,
        query,
        stop,
      };
      const subtitleAttempts = await this.startSubtitles(
        torrent,
        {
          ref,
          imdbId: play.imdbId,
          infoHash: c.infoHash,
          release: c.name,
          files: p.opened.files,
          fileIndex: p.video,
          subtitleIndexes: p.subtitles,
          handle: p.opened.read === undefined ? null : (p.opened as Pick<TorrentHandle, 'read'>),
          probe,
          audioLang,
          resumeS: play.resumeS,
          cloudTried: play.cloudTried,
          localBase: this.opts.localBase(),
          signal: stop.signal,
        },
        { ref, imdbId: play.imdbId, infoHash: c.infoHash, fileIndex: p.video, durationS: probe.durationS },
      );
      torrent.state = await this.state(torrent);
      const detail = `${describeProbe(probe)}${page.manifestKind === 'hls' ? ', remuxed' : ''}, ${c.seeds} seeds${this.deliveryText(delivery)}`;
      return { ok: true, torrent, source: standIn(torrent, probe, audioLang, p.tookS), attempt: { provider: torrentLabel(c.name), outcome: 'resolved', took_s: p.tookS, detail }, subtitleAttempts };
    } catch (err) {
      return { ok: false, attempt: { provider: torrentLabel(c.name), outcome: 'error', took_s: p.tookS, detail: messageOf(err) } };
    }
  }
}

/** The finder's index list from the settings: the default indexes at their addresses, minus the ones set `off`. */
export function indexesOf(finder: NonNullable<Config['torrent']>['finder']): TorrentIndex[] {
  const set = finder?.indexes ?? {};
  const bases = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null && v !== undefined)) as Partial<Record<TorrentIndexName, string>>;
  const off = new Set(TORRENT_INDEX_NAMES.filter((name) => set[name] === null));
  return defaultIndexes({ bases }).filter((index) => !off.has(index.name as TorrentIndexName));
}

/** The daemon's torrent source, or null when torrents are off (`NOTESD_TORRENT=off`) or phase 1 built no TorrentStreams. */
export function buildTorrentSource(
  config: Config,
  torrents: TorrentSwarm | null,
  wiring: {
    localBase: () => string;
    log?: (line: string) => void;
    /** buildSubtitleTiers(...) in src/daemon.ts; none: a torrent session has no subtitle. */
    tiers?: readonly SubtitleTier[];
    /** 1337x and ext.to (phase 9), asked only when the JSON indexes leave no usable candidate. */
    fallback?: readonly TorrentIndex[];
    /** The remux of files Chrome cannot play as is (torrent phase 5); null or unset: such a file is `unplayable`. */
    remux?: TorrentRemux | null;
    /** Wyzie Synced (buildSubtitleSync); null or unset: no subtitle is re-timed. */
    sync?: { start(request: TorrentSyncRequest): unknown } | null;
    /** The public tracker lists (buildTrackerLists in src/daemon.ts, which reads the switches); null or unset: none. */
    lists?: Pick<TrackerLists, 'list'> | null;
    /** The torrent marks (marks.ts): the blacklist and heard languages; null or unset: none. */
    marks?: TorrentMarks | null;
    /** The torrent audio check's hearer (AudioLangCheck over the shared Whisper worker); null or unset: off. */
    hear?: TorrentHearer | null;
  },
): TorrentSource | null {
  if (config.torrent?.enabled !== true || torrents === null) return null;
  const finder = config.torrent.finder ?? DEFAULT_TORRENT_FINDER_CONFIG;
  const indexes = indexesOf(finder);
  // Per daemon run: an index that keeps timing out is left out of the next plays for a while.
  const health = new IndexHealth();
  return new TorrentSource({
    swarm: torrents,
    find: (query, signal, options) =>
      findCandidates(query, {
        signal,
        ...(options?.tried === undefined ? {} : { tried: options.tried }),
        indexes,
        health,
        ...(finder.minSeeds === undefined ? {} : { minSeeds: finder.minSeeds }),
        ...(finder.maxSizeBytes === undefined ? {} : { maxSizeBytes: finder.maxSizeBytes }),
        ...(finder.indexTimeoutMs === undefined ? {} : { timeoutMs: finder.indexTimeoutMs }),
        ...(wiring.fallback === undefined ? {} : { fallback: wiring.fallback }),
      }),
    probe: ffprobeFile({ ffprobeBin: config.movies.ffprobeBin }),
    tiers: wiring.tiers ?? [],
    remux: wiring.remux ?? null,
    sync: wiring.sync ?? null,
    // NOTESD_TORRENT_DISCOVERY=off asks no tracker at all, so nothing is scraped either.
    scrape: config.torrent.discovery ? udpScraper() : null,
    book: new TrackerBook(join(config.torrent.dir, TRACKER_BOOK_FILE)),
    lists: wiring.lists ?? null,
    marks: wiring.marks ?? null,
    hear: wiring.hear ?? null,
    ...(config.torrent.sites === undefined ? {} : { sites: config.torrent.sites.origins }),
    localBase: wiring.localBase,
    ...(config.torrent.subtitleWaitMs === undefined ? {} : { subtitleHeadMs: config.torrent.subtitleWaitMs }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
