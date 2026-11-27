import type { SessionTorrent } from '../../sessions.js';
import type { ResolveAttempt, ResolvedSource, StreamRef } from '../../types.js';
import type { AudioFinding } from '../../audioLang.js';
import type { findCandidates, ReleaseHeight, ScrapeTrackers, SwarmCount, TorrentCandidate, TorrentQuery } from '../find/index.js';
import type { TrackerBook } from '../origins.js';
import type { TrackerLists } from '../trackerLists.js';
import type { MediaProbe, ProbeFile } from '../probe.js';
import type { TorrentRemux } from '../remux.js';
import type { SubtitleTier } from '../subtitles/chain.js';
import type { TorrentSyncRequest } from '../subtitles/synced.js';
import type { TorrentMarks } from '../marks.js';
import type { TorrentDownload, TorrentFileInfo, TorrentHandle, TorrentPick, TorrentSlotRecord, TorrentStats } from '../types.js';

/**
 * The torrent source's types: the public ones (../source.ts re-exports them) first, then the ones its modules pass
 * between themselves during one play (PlayFacts, Passed, Raced, ...), which nothing outside source/ reads.
 */

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
  /** Fetches a used file's first and last pieces before its middle (what the probe reads). Absent: nothing asked. */
  headFirst?(infoHash: string, fileIndex: number): unknown;
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
  /** The trackers this host's row of a torrent keeps (what it was opened with), for opening it again by its info hash. Absent: none. */
  trackersOf?(infoHash: string): Promise<string[]>;
  /** `use` for one named episode of a torrent in the swarm (TorrentStreams.useSlot). Absent: open again for that episode, then `use`. */
  useSlot?(pick: TorrentPick, fileIndexes: readonly number[]): unknown;
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
  /**
   * Which of the found torrents may be tried at all (a download's band: 1080p with live seeds, or below 1080p), given
   * what the trackers said of its swarm (null: nobody answered for it). Unset: every one (a play).
   */
  only?: (c: TorrentCandidate, count: SwarmCount | null) => boolean;
}

export type TorrentResolve =
  | { ok: true; torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] }
  | { ok: false; error: 'no_source'; attempts: ResolveAttempt[] };

/** What a season download asks of the torrent source (TorrentSource.fetchPack). */
export interface PackOptions {
  /** The title's original language (TMDB's code); null: unknown. */
  audioLang: string | null;
  imdbId: string | null;
  /** The title's names, as for the season's first wanted episode; null: unknown. */
  names: TitleNames | null;
  /** `preferred`: only a pack at PREFERRED_TORRENT_HEIGHT (a download with no source named); `any`: every height, the preferred first. */
  heights: 'preferred' | 'any';
  /** The info hash this season was downloading from before a restart: tried first, with no index asked. */
  known?: string | null;
}

/** A season pack held for a season download: one `use` of the torrent per episode in `episodes`, until each is let go. */
export interface PackHold {
  infoHash: string;
  /** The release name as the index listed it. */
  name: string;
  /** The wanted episodes the pack holds, in episode order, with their chosen files (a video and its subtitles). */
  episodes: { episode: number; video: number; subtitles: number[] }[];
  /** The wanted episodes the pack holds no file of, in episode order: each downloads on its own. */
  lacking: number[];
  /** `Index: <name>` per index asked, then `Torrent: <release>` per pack tried. */
  attempts: ResolveAttempt[];
}

export type PackFetch = { ok: true; pack: PackHold } | { ok: false; error: 'no_pack'; attempts: ResolveAttempt[] };

/** What fetchKept answers: the torrent held for a download, or why none could be (`dubbed`: every torrent tried was a dub). */
export type KeptResolve =
  | { ok: true; torrent: SessionTorrent; attempts: ResolveAttempt[] }
  | { ok: false; error: 'no_source' | 'dubbed'; attempts: ResolveAttempt[] };

/** Where a kept download stands (TorrentSource.keptState). */
export interface KeptState {
  file: 'downloading' | 'whole';
  /** `none`: the file plays as is, or no remux runs for it. */
  remux: 'none' | 'running' | 'whole' | 'failed';
  subtitles: 'searching' | 'done';
}

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

// ---- Internal to source/: one play's facts and its racers. ----

/** What one play knows besides the candidate: the same for every torrent it tries. */
export interface PlayFacts {
  audioLang: string | null;
  /** Null: the title has none; the subtitle services are then asked by what else they take (Wyzie: the TMDB id). */
  imdbId: string | null;
  resumeS: number | null;
  cloudTried: boolean;
}

export type Tried =
  | { ok: true; torrent: SessionTorrent; source: ResolvedSource; attempt: ResolveAttempt; subtitleAttempts: ResolveAttempt[] }
  | { ok: false; attempt: ResolveAttempt };

/** A torrent whose header arrived and whose file may be played: it is selected and downloading, and may still lose to another. */
export interface Passed {
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
export type Raced = { ok: true; passed: Passed } | { ok: false; attempt: ResolveAttempt; lasting?: boolean };

/** Told of each torrent that was tried and did not play. */
export type NoteFailure = (c: TorrentCandidate, lasting: boolean, why?: string) => void;

export interface Racer {
  /** Stops caring for the result and lets go of the torrent, now or as soon as it is open. */
  cancel(): void;
  readonly result: Promise<Raced>;
}
