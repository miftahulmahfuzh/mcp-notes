import { DEFAULT_TORRENT_FINDER_CONFIG, TORRENT_INDEX_NAMES, type Config, type TorrentIndexName } from '../../config.js';
import type { SessionTorrent } from '../sessions.js';
import { isEnglish, refLabel, type ResolveAttempt, type ResolveOutcome, type ResolvedSource, type SourceAudio, type StreamRef } from '../types.js';
import { defaultIndexes, findCandidates, pickFile, type IndexAttempt, type TorrentCandidate, type TorrentIndex, type TorrentQuery } from './find/index.js';
import { audioLanguages, describeProbe, ffprobeFile, normalizeAudioLang, ProbeError, type MediaProbe, type ProbeFile } from './probe.js';
import { canRemux, type TorrentRemux } from './remux.js';
import { runSubtitleChain, type SubtitleTier } from './subtitles/chain.js';
import { FILE_LIST_TIMEOUT_MS, orderByFileLists } from './subtitles/files.js';
import type { TorrentSyncRequest } from './subtitles/synced.js';
import type { TorrentDownload, TorrentFileInfo, TorrentHandle, TorrentPick } from './types.js';

/**
 * The torrent source of direct streaming (torrent phase 3). DirectStreamService calls only this: it finds the
 * title's torrents by IMDb id (phase 2's findCandidates), opens each in turn in the swarm (phase 1's
 * TorrentStreams) until one holds a file that plays in the title's original language, and answers the session's
 * SessionTorrent and the ResolvedSource stand-in a session carries. Nothing here decides the order of the
 * candidates (phase 2 does) or how bytes are fetched (phase 1 does). It never runs inside
 * DirectStreamService.serial(): phase 6's borrow tier calls subtitleText, which queues there.
 */

/** The provider every torrent session carries (movie_plays, the stream on screen, the player). */
export const TORRENT_PROVIDER = 'Torrent';
/** Torrents opened per play (and per shuffle) before the answer is no_source. */
export const MAX_TORRENT_TRIES = 5;
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
  now?: () => number;
  log?: (line: string) => void;
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

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const seconds = (from: number, to: number): number => Math.round((to - from) / 100) / 10;
const pad = (n: number): string => String(n).padStart(2, '0');

/** An index's outcome as an attempt's: an index that listed torrents `resolved`, an empty one `no_stream`. */
const INDEX_OUTCOMES: Record<IndexAttempt['outcome'], ResolveOutcome> = { ok: 'resolved', empty: 'no_stream', error: 'error', bot_check: 'bot_check' };

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
function refusalOf(probe: MediaProbe, audioLang: string | null, remux: TorrentRemux | null): { outcome: ResolveOutcome; detail: string } | null {
  const languages = audioLanguages(probe);
  if (audioLang !== null && languages.length > 0 && !languages.includes(audioLang)) {
    return { outcome: 'dubbed', detail: `its audio is ${languages.join(', ')}, not the original ${audioLang}` };
  }
  if (probe.direct) return null;
  if (remux === null) return { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is` };
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
    let found: FindAnswer;
    try {
      found = await this.opts.find(query, AbortSignal.timeout(TORRENT_DEADLINE_MS));
    } catch (err) {
      return { ok: false, error: 'no_source', attempts: [{ provider: 'Index: all', outcome: 'error', took_s: seconds(started, this.now()), detail: messageOf(err) }] };
    }
    const skip = new Set((options.skip ?? []).map((h) => h.toLowerCase()));
    let candidates = found.candidates.filter((c) => !skip.has(c.infoHash.toLowerCase()));
    // R3.2: of the best three, the one whose files hold an English subtitle file is tried first.
    candidates = await orderByFileLists(candidates, {
      listFiles: async (candidate) => {
        const handle = await this.opts.swarm.open(
          { infoHash: candidate.infoHash, trackers: candidate.trackers, name: candidate.name, ref, release: candidate.release },
          { timeoutMs: FILE_LIST_TIMEOUT_MS },
        );
        const picked = pickFile(handle.files, query);
        return picked === null ? null : { files: handle.files, video: picked.video, subtitles: picked.subtitles };
      },
      release: async (infoHash) => {
        await this.opts.swarm.release(infoHash);
      },
      log: this.log,
    });
    const indexes = found.indexes.map(indexAttempt);
    const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: options.resumeS ?? null, cloudTried: options.cloudTried === true };
    const out = await this.tryCandidates(ref, query, candidates, play, started + TORRENT_DEADLINE_MS);
    this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), ${out.ok ? `playing ${out.torrent.name}` : 'none played'}`);
    return out.ok ? { ...out, attempts: [...indexes, ...out.attempts] } : { ok: false, error: 'no_source', attempts: [...indexes, ...out.attempts] };
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
    const chain = await runSubtitleChain(
      this.opts.tiers,
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
      { log: this.log },
    );
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
      subtitles: chain.subtitles,
      subtitleRev: 0,
      candidates: [],
      durationS: probe.durationS,
      candidate: null,
      held: false,
      imdbId: null,
      query: null,
      stop,
    };
    this.startSync(torrent, { ref, imdbId: null, infoHash: download.infoHash, fileIndex: download.fileIndex, durationS: probe.durationS });
    return { torrent, source: standIn(torrent, probe, options.audioLang, null), attempts: chain.attempts };
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
    if (probe.direct || remux === null) return { manifestUrl: fileUrl, manifestKind: 'mp4' };
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

  private async tryCandidates(ref: StreamRef, query: FindQuery, candidates: readonly TorrentCandidate[], play: PlayFacts, deadline: number): Promise<TorrentResolve> {
    const attempts: ResolveAttempt[] = [];
    for (const [i, c] of candidates.entries()) {
      const left = deadline - this.now();
      if (i >= MAX_TORRENT_TRIES || left <= 0) break;
      const tried = await this.tryOne(ref, query, c, play, left);
      attempts.push(tried.attempt);
      if (tried.ok) {
        attempts.push(...tried.subtitleAttempts);
        // The same object, not a copy: the sync tryOne started writes its subtitle into it.
        tried.torrent.candidates = candidates.slice(i + 1);
        return { ok: true, torrent: tried.torrent, source: tried.source, attempts };
      }
    }
    return { ok: false, error: 'no_source', attempts };
  }

  private async tryOne(ref: StreamRef, query: FindQuery, c: TorrentCandidate, play: PlayFacts, budgetMs: number): Promise<Tried> {
    const started = this.now();
    const audioLang = play.audioLang;
    const attempt = (outcome: ResolveOutcome, detail: string): ResolveAttempt => ({ provider: torrentLabel(c.name), outcome, took_s: seconds(started, this.now()), detail });
    const fail = (outcome: ResolveOutcome, detail: string): Tried => {
      this.letGo(c.infoHash);
      return { ok: false, attempt: attempt(outcome, detail) };
    };
    let opened: OpenedTorrent;
    try {
      opened = await this.opts.swarm.open({ infoHash: c.infoHash, trackers: c.trackers, name: c.name, ref, release: c.release }, { timeoutMs: Math.min(TORRENT_OPEN_TIMEOUT_MS, budgetMs) });
    } catch (err) {
      return fail('no_stream', `no file list from the swarm in time (${messageOf(err)})`);
    }
    try {
      const picked = pickFile(opened.files, query);
      if (picked === null) {
        return fail('no_stream', ref.kind === 'tv' ? `the torrent holds no file of S${pad(ref.season)}E${pad(ref.episode)}` : 'the torrent holds no video file');
      }
      const selected = [picked.video, ...picked.subtitles];
      await this.opts.swarm.use(c.infoHash, selected);
      const manifestUrl = this.opts.swarm.localUrl(c.infoHash, picked.video);
      const probeMs = Math.max(PROBE_MIN_MS, Math.min(TORRENT_PROBE_TIMEOUT_MS, budgetMs - (this.now() - started)));
      let probe: MediaProbe;
      try {
        probe = await this.opts.probe(`${this.opts.localBase()}${manifestUrl}`, probeMs);
      } catch (err) {
        return err instanceof ProbeError && err.code === 'timeout'
          ? fail('no_stream', `the swarm sent too little of the file to read it within ${Math.round(probeMs / 1000)} s`)
          : fail('error', `ffprobe could not read the file: ${messageOf(err)}`);
      }
      const refusal = refusalOf(probe, audioLang, this.opts.remux ?? null);
      if (refusal !== null) return fail(refusal.outcome, refusal.detail);
      let page: { manifestUrl: string; manifestKind: 'mp4' | 'hls' };
      try {
        page = await this.fileForPage(c.infoHash, picked.video, probe, audioLang, Math.max(PROBE_MIN_MS, budgetMs - (this.now() - started)));
      } catch (err) {
        return fail('unplayable', `${describeProbe(probe)}: the remux did not start (${messageOf(err)})`);
      }
      this.noteDuration(c.infoHash, probe);
      const stop = new AbortController();
      const chain = await runSubtitleChain(
        this.opts.tiers,
        {
          ref,
          imdbId: play.imdbId,
          infoHash: c.infoHash,
          release: c.name,
          files: opened.files,
          fileIndex: picked.video,
          subtitleIndexes: picked.subtitles,
          handle: opened.read === undefined ? null : (opened as Pick<TorrentHandle, 'read'>),
          probe,
          audioLang,
          resumeS: play.resumeS,
          cloudTried: play.cloudTried,
          localBase: this.opts.localBase(),
          signal: stop.signal,
        },
        { log: this.log },
      );
      const torrent: SessionTorrent = {
        infoHash: c.infoHash,
        fileIndex: picked.video,
        selected,
        name: c.name,
        index: c.index,
        seeds: c.seeds,
        state: 'downloading',
        height: probe.video?.height ?? c.release.height ?? null,
        manifestUrl: page.manifestUrl,
        manifestKind: page.manifestKind,
        subtitles: chain.subtitles,
        subtitleRev: 0,
        candidates: [],
        durationS: probe.durationS,
        candidate: c,
        held: true,
        imdbId: play.imdbId,
        query,
        stop,
      };
      torrent.state = await this.state(torrent);
      this.startSync(torrent, { ref, imdbId: play.imdbId, infoHash: c.infoHash, fileIndex: picked.video, durationS: probe.durationS });
      const tookS = seconds(started, this.now());
      return { ok: true, torrent, source: standIn(torrent, probe, audioLang, tookS), attempt: attempt('resolved', `${describeProbe(probe)}${page.manifestKind === 'hls' ? ', remuxed' : ''}, ${c.seeds} seeds`), subtitleAttempts: chain.attempts };
    } catch (err) {
      return fail('error', messageOf(err));
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
  return new TorrentSource({
    swarm: torrents,
    find: (query, signal) =>
      findCandidates(query, {
        signal,
        indexes,
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
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
