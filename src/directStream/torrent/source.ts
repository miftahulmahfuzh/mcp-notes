import { DEFAULT_TORRENT_FINDER_CONFIG, TORRENT_INDEX_NAMES, type Config, type TorrentIndexName } from '../../config.js';
import type { SessionTorrent } from '../sessions.js';
import { isEnglish, refLabel, type ResolveAttempt, type ResolveOutcome, type ResolvedSource, type SourceAudio, type StreamRef } from '../types.js';
import { candidateFromMagnet, defaultIndexes, findCandidates, IndexHealth, pickFile, type IndexAttempt, type TorrentCandidate, type TorrentIndex, type TorrentQuery } from './find/index.js';
import { audioLanguages, describeProbe, ffprobeFile, normalizeAudioLang, ProbeError, type MediaProbe, type ProbeFile } from './probe.js';
import { canRemux, pickAudioStream, type TorrentRemux } from './remux.js';
import { runSubtitleChain, type SubtitleContext, type SubtitleTier } from './subtitles/chain.js';
import { hasEnglishSubtitleFile } from './subtitles/files.js';
import type { TorrentSyncRequest } from './subtitles/synced.js';
import type { TorrentDownload, TorrentFileInfo, TorrentHandle, TorrentPick, TorrentStats } from './types.js';

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
/** Torrents opened per play (and per shuffle) before the answer is no_source: two rounds of TORRENT_RACE_WIDTH. */
export const MAX_TORRENT_TRIES = 6;
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
/** ffprobe must have read the file's header within this. */
export const TORRENT_PROBE_TIMEOUT_MS = 30_000;
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
export type FindTorrents = (query: FindQuery, signal: AbortSignal) => Promise<FindAnswer>;

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
  /** The video's length once the probe knows it: `/map` then answers seconds (phase 4's grey bar). */
  setDuration(infoHash: string, seconds: number): unknown;
  /** One user fewer, and with none left the swarm is left at once (a torrent that lost the race, or did not play). Absent: `release`. */
  drop?(infoHash: string): unknown;
  /** The peers connected and the download rate of an open torrent, now; null when it is not in the swarm. Absent in tests' fakes. */
  stats?(infoHash: string): Pick<TorrentStats, 'peers' | 'down_kbps'> | null;
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
  /** Default TORRENT_SETTLE_MS. */
  settleMs?: number;
  /** Default SUBTITLE_HEAD_MS. */
  subtitleHeadMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

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
  /** The title's IMDb id; null: no index can be asked. */
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

/** What one play knows besides the candidate: the same for every torrent it tries. */
interface PlayFacts {
  audioLang: string | null;
  imdbId: string;
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
  /** Seconds from its open to its header. */
  tookS: number;
  /** Lets go of it (once): it lost, or its remux did not start. */
  drop(): void;
}

type Raced = { ok: true; passed: Passed } | { ok: false; attempt: ResolveAttempt };

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

/** True when the swarm looks able to keep ahead of the picture: enough peers, or a rate at or above the film's bitrate. */
export function delivers(d: Delivery | null): boolean {
  return d !== null && (d.peers >= HEALTHY_PEERS || (d.filmKbps !== null && d.downKbps >= d.filmKbps));
}

/**
 * The torrents whose headers arrived, best first: one whose swarm delivers before one that does not, then one whose
 * files hold an English subtitle file (R3.2), then the one with more peers connected, then the finder's order.
 */
export function chooseOrder<T extends { position: number; english: boolean }>(passed: readonly T[], deliveryOf: (p: T) => Delivery | null): T[] {
  const scored = passed.map((p) => ({ p, d: deliveryOf(p) }));
  return scored
    .sort((a, b) => Number(delivers(b.d)) - Number(delivers(a.d)) || Number(b.p.english) - Number(a.p.english) || (b.d?.peers ?? 0) - (a.d?.peers ?? 0) || a.p.position - b.p.position)
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
function queryOf(ref: StreamRef, imdbId: string, names: TitleNames | null, audioLang: string | null): FindQuery {
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

  constructor(private readonly opts: TorrentSourceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * Finds the title's torrents and plays the first that works, trying at most MAX_TORRENT_TRIES within
   * TORRENT_DEADLINE_MS. `attempts` holds one `Index: <name>` per index asked, then per torrent tried one
   * `Torrent: <release>`, and after the one that plays its `Subtitles: <tier>` attempts. Never throws.
   */
  async resolve(ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
    const started = this.now();
    if (options.imdbId === null) {
      return {
        ok: false,
        error: 'no_source',
        attempts: [{ provider: 'Index: all', outcome: 'error', took_s: 0, detail: 'no IMDb id is known for this title (TMDB has none or cannot be asked), and the torrent indexes are asked by it' }],
      };
    }
    const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
    options.progress?.({ stage: 'asking the torrent indexes', attempts: [] });
    let found: FindAnswer;
    try {
      found = await this.opts.find(query, AbortSignal.timeout(TORRENT_DEADLINE_MS));
    } catch (err) {
      return { ok: false, error: 'no_source', attempts: [{ provider: 'Index: all', outcome: 'error', took_s: seconds(started, this.now()), detail: messageOf(err) }] };
    }
    const skip = new Set((options.skip ?? []).map((h) => h.toLowerCase()));
    const candidates = found.candidates.filter((c) => !skip.has(c.infoHash.toLowerCase()));
    const indexes = found.indexes.map(indexAttempt);
    const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: options.resumeS ?? null, cloudTried: options.cloudTried === true };
    const progress = options.progress;
    const out = await this.tryCandidates(ref, query, candidates, play, started + TORRENT_DEADLINE_MS, progress === undefined ? undefined : (p) => progress({ stage: p.stage, attempts: [...indexes, ...p.attempts] }));
    if (out.ok) {
      this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), playing ${out.torrent.name}`);
      return { ...out, attempts: [...indexes, ...out.attempts] };
    }
    // Nothing proper played. Releases the name read as a dub are tried now, in their own round: many are
    // dual-audio and still carry the original track, and the file probe (refusalOf) keeps only those that do.
    const dubs = (found.lastResort ?? []).filter((c) => !skip.has(c.infoHash.toLowerCase()) && !candidates.some((k) => k.infoHash === c.infoHash));
    const firstAttempts = [...indexes, ...out.attempts];
    if (dubs.length === 0 || started + TORRENT_DEADLINE_MS - this.now() < PROBE_MIN_MS) {
      this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), none played`);
      return { ok: false, error: 'no_source', attempts: firstAttempts };
    }
    options.progress?.({ stage: 'trying releases whose name reads as a dub (the file may still carry the original)', attempts: firstAttempts });
    const dubbed = await this.tryCandidates(ref, query, dubs, play, this.now() + TORRENT_DEADLINE_MS, progress === undefined ? undefined : (p) => progress({ stage: p.stage, attempts: [...firstAttempts, ...p.attempts] }));
    this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s) and ${dubs.length} dub-named, ${dubbed.ok ? `playing ${dubbed.torrent.name} (its file carries the original ${options.audioLang ?? 'language'})` : 'none played'}`);
    return dubbed.ok ? { ...dubbed, attempts: [...firstAttempts, ...dubbed.attempts] } : { ok: false, error: 'no_source', attempts: [...firstAttempts, ...dubbed.attempts] };
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
  async playMagnet(ref: StreamRef, options: TorrentResolveOptions & { magnet: string }): Promise<TorrentResolve> {
    const query = queryOf(ref, options.imdbId ?? '', options.names ?? null, options.audioLang);
    const candidate = candidateFromMagnet(options.magnet, query);
    if (candidate === null) {
      return { ok: false, error: 'no_source', attempts: [{ provider: 'Torrent: magnet', outcome: 'error', took_s: 0, detail: 'not a magnet link or a 40-character info hash' }] };
    }
    const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId ?? '', resumeS: options.resumeS ?? null, cloudTried: false };
    options.progress?.({ stage: `opening the torrent ${candidate.name}`, attempts: [] });
    const out = await this.tryCandidates(ref, query, [candidate], play, this.now() + TORRENT_DEADLINE_MS, options.progress);
    this.log(`[notesd] torrent: ${refLabel(ref)} from a pasted magnet (${candidate.infoHash.slice(0, 8)}): ${out.ok ? `playing ${out.torrent.name}` : 'did not play'}`);
    return out;
  }

  /** The shuffle button: the session's remaining candidates, in their order, without asking the indexes again. */
  async next(ref: StreamRef, torrent: SessionTorrent, audioLang: string | null): Promise<TorrentResolve> {
    if (torrent.query === null || torrent.imdbId === null || torrent.candidates.length === 0) return { ok: false, error: 'no_source', attempts: [] };
    const play: PlayFacts = { audioLang, imdbId: torrent.imdbId, resumeS: null, cloudTried: false };
    return this.tryCandidates(ref, torrent.query, torrent.candidates, play, this.now() + TORRENT_DEADLINE_MS);
  }

  /**
   * R2.9: this host's finished download of the title, played from disk with no index asked and no swarm
   * joined. Null when there is none, it is not whole, or its file does not play (another language, a file
   * Chrome cannot play): the play then goes on as if there were none. `attempts` are the subtitle tiers' only.
   */
  async fromDisk(ref: StreamRef, options: { audioLang: string | null; resumeS?: number | null }): Promise<{ torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] } | null> {
    let download: DownloadOnDisk | null;
    try {
      download = await this.opts.swarm.find(ref);
      if (download === null || download.state !== 'ready') return null;
      if ((await this.opts.swarm.filePath(download.infoHash, download.fileIndex)) === null) return null;
    } catch (err) {
      this.log(`[notesd] torrent: could not read this machine's downloads of ${refLabel(ref)}: ${messageOf(err)}`);
      return null;
    }
    const manifestUrl = this.opts.swarm.localUrl(download.infoHash, download.fileIndex);
    let probe: MediaProbe;
    try {
      probe = await this.opts.probe(`${this.opts.localBase()}${manifestUrl}`, TORRENT_PROBE_TIMEOUT_MS);
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
      page = await this.fileForPage(download.infoHash, download.fileIndex, probe, options.audioLang);
    } catch (err) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} could not be remuxed: ${messageOf(err)}`);
      return null;
    }
    this.noteDuration(download.infoHash, probe);
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
    await this.opts.swarm.open({ infoHash: c.infoHash, trackers: c.trackers, name: c.name, ref, release: c.release }, { timeoutMs: TORRENT_OPEN_TIMEOUT_MS });
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
      return (await this.opts.swarm.filePath(torrent.infoHash, torrent.fileIndex)) === null ? 'downloading' : 'ready';
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
  ): Promise<{ manifestUrl: string; manifestKind: 'mp4' | 'hls' }> {
    const fileUrl = this.opts.swarm.localUrl(infoHash, fileIndex);
    const remux = this.opts.remux ?? null;
    // playsOriginalDirect, not probe.direct: a dual-audio file whose original is not the default is remuxed, so the
    // original track plays. With no remux, refusalOf already refused such a file, so this only serves truly direct ones.
    if (playsOriginalDirect(probe, audioLang) || remux === null) return { manifestUrl: fileUrl, manifestKind: 'mp4' };
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
  private noteDuration(infoHash: string, probe: MediaProbe): void {
    if (probe.durationS === null) return;
    const seconds = probe.durationS;
    void Promise.resolve()
      .then(() => this.opts.swarm.setDuration(infoHash, seconds))
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
    const chain = runSubtitleChain(this.opts.tiers, ctx, { log: this.log }).then((out) => {
      torrent.subtitles = out.subtitles;
      if (late) {
        if (out.subtitles.length > 0) torrent.subtitleRev += 1;
        torrent.subtitlesPending = null;
        const said = out.attempts.map((a) => `${a.provider.replace(/^Subtitles: /, '')} ${a.outcome} ${a.took_s ?? 0} s`).join(', ');
        this.log(`[notesd] torrent: subtitles of ${ctx.infoHash.slice(0, 8)} ${out.subtitles.length > 0 ? 'arrived' : 'not found'} behind the play, ${seconds(started, this.now())} s after the search began (${said})`);
      }
      this.startSync(torrent, sync);
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

  /** One user fewer for a torrent that will not play, leaving its swarm at once where the swarm can (`drop`). */
  private dropNow(infoHash: string): void {
    const swarm = this.opts.swarm;
    void Promise.resolve()
      .then(() => (swarm.drop === undefined ? swarm.release(infoHash) : swarm.drop(infoHash)))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not release ${infoHash}: ${messageOf(err)}`));
  }

  private deliveryOf(p: Pick<Passed, 'c' | 'opened' | 'video' | 'probe'>): Delivery | null {
    let stats: Pick<TorrentStats, 'peers' | 'down_kbps'> | null = null;
    try {
      stats = this.opts.swarm.stats?.(p.c.infoHash) ?? null;
    } catch {
      stats = null;
    }
    if (stats === null) return null;
    const length = p.opened.files.find((f) => f.index === p.video)?.length ?? null;
    const filmKbps = length !== null && p.probe.durationS !== null && p.probe.durationS > 0 ? Math.round((length * 8) / 1000 / p.probe.durationS) : null;
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
          else results.set(position, raced.attempt);
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
        // One header is here: the others still opening get a moment to arrive too, then the swarms are compared.
        const settleMs = Math.min(this.opts.settleMs ?? TORRENT_SETTLE_MS, deadline - this.now());
        if (running.size > 0 && settleMs > 0) {
          const timer = sleep(settleMs);
          await Promise.race([Promise.all([...running.values()].map((r) => r.done)), timer.done]);
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
        continue;
      }
      const later: TorrentCandidate[] = [];
      for (const p of chooseOrder(passed, (x) => this.deliveryOf(x))) {
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
    const state = { cancelled: false, opened: false, gone: false };
    const drop = (): void => {
      if (!state.opened || state.gone) return;
      state.gone = true;
      this.dropNow(c.infoHash);
    };
    const attempt = (outcome: ResolveOutcome, detail: string): ResolveAttempt => ({ provider: torrentLabel(c.name), outcome, took_s: seconds(started, this.now()), detail });
    const fail = (outcome: ResolveOutcome, detail: string): Raced => {
      drop();
      return { ok: false, attempt: attempt(outcome, detail) };
    };
    const left = (): Raced => fail('skipped', 'another torrent was chosen');
    const run = async (): Promise<Raced> => {
      let opened: OpenedTorrent;
      try {
        opened = await this.opts.swarm.open({ infoHash: c.infoHash, trackers: c.trackers, name: c.name, ref, release: c.release }, { timeoutMs: Math.min(TORRENT_OPEN_TIMEOUT_MS, budgetMs) });
      } catch (err) {
        // Released too: an open that gave up may still have left the torrent in the swarm.
        state.opened = true;
        return fail('no_stream', `no file list from the swarm in time (${messageOf(err)})`);
      }
      state.opened = true;
      if (state.cancelled) return left();
      try {
        const picked = pickFile(opened.files, query);
        if (picked === null) {
          return fail('no_stream', ref.kind === 'tv' ? `the torrent holds no file of S${pad(ref.season)}E${pad(ref.episode)}` : 'the torrent holds no video file');
        }
        await this.opts.swarm.use(c.infoHash, [picked.video, ...picked.subtitles]);
        if (state.cancelled) return left();
        const manifestUrl = this.opts.swarm.localUrl(c.infoHash, picked.video);
        const probeMs = Math.max(PROBE_MIN_MS, Math.min(TORRENT_PROBE_TIMEOUT_MS, budgetMs - (this.now() - started)));
        let probe: MediaProbe;
        try {
          probe = await this.opts.probe(`${this.opts.localBase()}${manifestUrl}`, probeMs);
        } catch (err) {
          if (state.cancelled) return left();
          return err instanceof ProbeError && err.code === 'timeout'
            ? fail('no_stream', `the swarm sent too little of the file to read it within ${Math.round(probeMs / 1000)} s`)
            : fail('error', `ffprobe could not read the file: ${messageOf(err)}`);
        }
        if (state.cancelled) return left();
        const refusal = refusalOf(probe, play.audioLang, this.opts.remux ?? null);
        if (refusal !== null) return fail(refusal.outcome, refusal.detail);
        const videoName = opened.files.find((f) => f.index === picked.video)?.name ?? '';
        return {
          ok: true,
          passed: { position, c, opened, video: picked.video, subtitles: picked.subtitles, probe, english: hasEnglishSubtitleFile(opened.files, picked.subtitles, videoName), tookS: seconds(started, this.now()), drop },
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
      this.noteDuration(c.infoHash, probe);
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

/** The finder's index list from the settings: the default four at their addresses, minus the ones set `off`. */
function indexesOf(finder: NonNullable<Config['torrent']>['finder']): TorrentIndex[] {
  const set = finder?.indexes ?? {};
  const bases = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null && v !== undefined)) as Partial<Record<TorrentIndexName, string>>;
  const off = new Set(TORRENT_INDEX_NAMES.filter((name) => set[name] === null));
  return defaultIndexes({ bases, yts: !off.has('yts') }).filter((index) => !off.has(index.name as TorrentIndexName));
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
  },
): TorrentSource | null {
  if (config.torrent?.enabled !== true || torrents === null) return null;
  const finder = config.torrent.finder ?? DEFAULT_TORRENT_FINDER_CONFIG;
  const indexes = indexesOf(finder);
  // Per daemon run: an index that keeps timing out is left out of the next plays for a while.
  const health = new IndexHealth();
  return new TorrentSource({
    swarm: torrents,
    find: (query, signal) =>
      findCandidates(query, {
        signal,
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
    localBase: wiring.localBase,
    ...(config.torrent.subtitleWaitMs === undefined ? {} : { subtitleHeadMs: config.torrent.subtitleWaitMs }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
