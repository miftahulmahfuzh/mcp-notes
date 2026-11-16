/**
 * The torrent finder's shapes (TORRENT_STREAM_SOURCE_PLAN phase 2). An index's JSON is read once, in
 * that index's module, into an IndexRow; candidateFrom (candidate.ts) turns a row into a
 * TorrentCandidate with a normalized info hash and a parsed release. Everything after that trusts
 * the candidate. Nothing here reads settings: findCandidates takes plain options with defaults.
 */

interface QueryCommon {
  /** `tt` and at least seven digits; findCandidates normalizes it once. */
  imdbId: string;
  /** The title's English name. When set, a release that names neither it nor `originalTitle` is left out. */
  title?: string | null;
  originalTitle?: string | null;
  year?: number | null;
  /** ISO 639-1 code of the title's original language. Null or absent: only an explicit dub marker leaves a release out. */
  originalLanguage?: string | null;
}

/** What to find: a film, or one episode of a series (TMDB's season and episode). A series without an episode cannot be built. */
export type TorrentQuery =
  | (QueryCommon & { kind: 'movie' })
  | (QueryCommon & {
      kind: 'tv';
      season: number;
      episode: number;
      /** The episode's number counted over the whole series (anime); read by pickFile only. */
      absoluteEpisode?: number | null;
      /**
       * The same episode numbered within its season, when TMDB's number runs on across seasons (One Piece: TMDB's
       * season 21, episode 1000 is the season's 109th). Torrentio is keyed by it, and a release that names the season
       * ("S21E109") uses it. Null or absent: TMDB's number is already the one within the season.
       */
      alt?: { season: number; episode: number } | null;
    });

export type TvQuery = Extract<TorrentQuery, { kind: 'tv' }>;

/** Nominal picture height: 2160 for 4K/UHD, 1080, 720, 480 for SD and anything smaller. */
export type ReleaseHeight = 2160 | 1080 | 720 | 480;
export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'xvid';
export type AudioCodec = 'aac' | 'ac3' | 'eac3' | 'dts' | 'truehd' | 'flac' | 'opus' | 'mp3';
export type Container = 'mp4' | 'mkv' | 'avi' | 'webm' | 'other';
export type ReleaseSource = 'cam' | 'telesync' | 'telecine' | 'web' | 'bluray' | 'hdtv' | 'dvd';

/** What a release name (and the file name, when the index gave it) says. parseRelease builds it. */
export interface ReleaseInfo {
  height: ReleaseHeight | null;
  videoCodec: VideoCodec | null;
  audioCodec: AudioCodec | null;
  container: Container | null;
  source: ReleaseSource | null;
  /** ISO 639-1 codes the name gives as audio (subtitle languages are not counted), sorted. */
  languages: string[];
  /** More than one audio track: MULTI, DUAL, two languages, a dub next to the original. Chrome would play the first track. */
  multiAudio: boolean;
  /** A dub without the original track. Never a candidate. */
  dubbed: boolean;
  /** A cinema recording: CAM, TS/TELESYNC, TC/TELECINE. Never a candidate. */
  cam: boolean;
  threeD: boolean;
  /** The file's season when the file names its episode, else the first season the release names. */
  season: number | null;
  /** The last season of a multi-season pack. */
  seasonTo: number | null;
  episode: number | null;
  episodeTo: number | null;
  /** The release says COMPLETE / Integrale / Box Set. */
  complete: boolean;
  /** The torrent holds more than one episode. */
  pack: boolean;
  /** Chrome plays it as is, as far as the names say: H.264, AAC, MP4, one audio track, not a dub. */
  direct: boolean;
}

/** What an index knows beyond the name (YTS ships MP4 with AAC). Wins over the name. */
export type ReleaseHints = Partial<Pick<ReleaseInfo, 'container' | 'audioCodec' | 'videoCodec' | 'height' | 'threeD'>>;

/** One torrent as an index listed it, read from its JSON. */
export interface IndexRow {
  /** 40 hex or 32 base32 characters, any case. */
  infoHash: string;
  name: string;
  fileName?: string | null;
  fileIdx?: number | null;
  seeds: number;
  sizeBytes: number | null;
  trackers?: readonly string[];
  /** The site the listing comes from (Torrentio aggregates: "YTS", "1337x", "ThePirateBay"). */
  site?: string | null;
  hints?: ReleaseHints;
}

export interface TorrentCandidate {
  /** 40 lower-case hex characters (rank leaves out anything else). */
  infoHash: string;
  /** The release name. */
  name: string;
  /** The video file the index named (a pack's episode file); null when it named none. */
  fileName: string | null;
  fileIdx: number | null;
  seeds: number;
  /** For a pack, often the whole torrent. Null when unknown. */
  sizeBytes: number | null;
  /** The index that gave the richest listing. */
  index: string;
  /** Every index that listed this info hash, in the order they were asked. */
  listedBy: string[];
  site: string | null;
  /** The index's trackers followed by DEFAULT_TRACKERS, without repeats. */
  trackers: string[];
  /** The index answered for this exact episode (Torrentio's series address), so a name that says nothing still fits. */
  scoped: boolean;
  release: ReleaseInfo;
}

/** `skipped`: the index was not asked, because it failed several plays in a row (IndexHealth in find.ts); only an attempt carries it. */
export type IndexOutcome = 'ok' | 'empty' | 'error' | 'bot_check' | 'skipped';

export interface IndexAnswer {
  outcome: IndexOutcome;
  detail: string;
  candidates: TorrentCandidate[];
}

/**
 * The only fetch an index gets. findCandidates builds it: it sets notesd's User-Agent last (an
 * index cannot replace it) and binds the index's timeout signal.
 */
export type IndexFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface IndexContext {
  fetch: IndexFetch;
  /** Aborted when the index's time is up or the caller gives up. */
  signal: AbortSignal;
}

export interface TorrentIndex {
  /** Lower case; an attempt and a candidate's `index` carry it. */
  name: string;
  /** The kinds it lists; absent: both. */
  kinds?: ReadonlyArray<TorrentQuery['kind']>;
  /**
   * A shorter limit than findCandidates' timeoutMs; the shorter of the two applies. A `fallback` index's own limit
   * applies even when it is longer (phase 9's browser-driven sites need about 40 s).
   */
  timeoutMs?: number;
  find(query: TorrentQuery, ctx: IndexContext): Promise<IndexAnswer>;
}

/** What findCandidates calls. The global fetch fits. */
export type FetchLike = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;

/** One index's outcome; phase 3 turns it into a ResolveAttempt named `Index: <index>`. */
export interface IndexAttempt {
  index: string;
  outcome: IndexOutcome;
  detail: string;
  took_s: number;
  /** Candidates the index answered, before dedupe and exclusions. */
  listed: number;
}

export type ExcludeReason = 'bad_hash' | 'other_title' | 'dubbed' | 'cam' | 'three_d' | 'other_episode' | 'few_seeds' | 'too_big';

export interface ExcludedCandidate {
  infoHash: string;
  name: string;
  index: string;
  seeds: number;
  reason: ExcludeReason;
}

export interface FoundCandidates {
  /** Ranked best first, at most `maxCandidates`. */
  candidates: TorrentCandidate[];
  indexes: IndexAttempt[];
  excluded: ExcludedCandidate[];
}

/** A file inside a torrent; phase 1's TorrentFileInfo fits. `path` is relative to the torrent, `/` or `\` separated. */
export interface TorrentFileLike {
  index: number;
  path: string;
  length: number;
}

export interface FilePick {
  video: number;
  /** .srt/.vtt/.ass/.ssa files beside the video or in a Subs folder; for a pack, only the episode's. */
  subtitles: number[];
}
