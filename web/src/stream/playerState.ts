import type { CreateEngine, Quality } from './engine';
import {
  NO_PREVIEWS,
  SessionError,
  type CachedInfo,
  type EpisodeNumber,
  type ManifestKind,
  type Previews,
  type ReportAnswer,
  type StreamSession,
  type TimeRange,
  type TorrentInfo,
  type TorrentState,
} from './session';
import type { SubtitleOption } from './subtitles';
import type { PlayStats } from './playStats';

/**
 * What the player page shows (StreamState) and what every part of the controller is handed to do
 * its work (PlayerHost). The controller (controller.ts) owns the state and the engine; each part
 * beside it owns one concern and reaches the rest only through the host:
 *
 *   evidenceLog.ts      the page's log lines, batched to the daemon
 *   captions.ts         the caption on the picture and the subtitle delay (G and H)
 *   subtitleTracks.ts   the subtitle files, the menu's choice, a subtitle the daemon replaced
 *   stallWatch.ts       what counts as a stall, and when stalls ask for another source
 *   sourceSwitch.ts     the asks for another source: stalls, a broken stream, the owner, the daemon
 *   reconnect.ts        the play carried on after the daemon lost the session
 *   pauseCache.ts       a pause that caches the film on this machine, and the cache's map
 *   torrentWait.ts      a torrent session's numbers, its map, and the wait for a part not on disk
 *   previewFrames.ts    the seek-preview frames
 *   positionReports.ts  the position reports and what their answers start
 */

/** `recovering`: a network error; the engine loads again after a wait while the film stays on the page. */
export type Stage = 'loading' | 'ready' | 'refreshing' | 'recovering' | 'error';

/** The report button (only shown in the error stage): nothing sent, being sent, or the daemon's answer. */
export type BugReportState = { status: 'idle' } | { status: 'sending' } | ReportAnswer;

/** A torrent session as the page shows it: the session's torrent, its live numbers once the daemon answered, and the wait for a part not on disk. */
export interface TorrentView {
  /** 40 lower-case hex characters. */
  infoHash: string;
  /** The release name. */
  name: string;
  /** The index that listed it; null when the session named none. */
  index: string | null;
  seeds: number | null;
  state: TorrentState;
  /** Peers connected now; null until the daemon answered. */
  peers: number | null;
  /** Download speed in kilobits per second; null until the daemon answered. */
  downKbps: number | null;
  /** 0 to 1 of the file on disk; null until the daemon answered. */
  progress: number | null;
  /** The play or a seek reached a part that is not on disk yet: the page shows that it waits for it. */
  fetching: boolean;
}

/** The view of a session's torrent before the daemon has said anything about it. */
export function torrentView(info: TorrentInfo | null): TorrentView | null {
  if (info === null) return null;
  return { ...info, peers: null, downKbps: null, progress: info.state === 'ready' ? 1 : null, fetching: false };
}

export interface StreamState {
  stage: Stage;
  title: string;
  kind: ManifestKind | null;
  /** Highest first. */
  qualities: Quality[];
  /** -1 = auto. */
  quality: number;
  subtitles: SubtitleOption[];
  subtitle: string | null;
  /** The code behind stage 'error'. */
  error: string | null;
  refreshes: number;
  /** The last position sent to the daemon. */
  reportedS: number | null;
  /** `?muted=1`: muted from the start, never unmuted, never full screen (phase 6's checks). */
  muted: boolean;
  /** A series: the episodes the previous and next buttons go to; null where there is none. */
  prevEpisode: EpisodeNumber | null;
  nextEpisode: EpisodeNumber | null;
  /** The side being resolved after its button was pressed; the episode on screen keeps playing meanwhile. */
  switching: 'prev' | 'next' | null;
  /** Why the last press of a previous / next button started nothing (which side, and the daemon's code); null once another press begins. */
  switchError: { to: 'prev' | 'next'; code: string } | null;
  /** Played from this machine's stream cache (phase 6): the page marks it beside the title. Null: through the pass-through. */
  cached: CachedInfo | null;
  /** Another source is being resolved (the film plays on meanwhile). */
  changingSource: boolean;
  /** What the last ask for another source came to, for the line over the picture: the new provider's name, or "No other source". */
  sourceNotice: string | null;
  /** Why the daemon moved the play to another source by itself (`a burned-in watermark`, `the torrent kept stalling`); null when it did not, or the owner asked since. */
  switchedWhy: string | null;
  /**
   * The subtitle lines to show now, one per line; '' for none. The page draws them itself: Chrome's
   * own drawing of a text track vanished in full screen on the owner's laptop and sat under the
   * control bar, so every track is kept `hidden` (its cues still run) and read from here.
   */
  caption: string;
  /** How much later (positive) or earlier (negative) the subtitles show than their file says, in ms (G and H). */
  subtitleDelayMs: number;
  /** Times the daemon replaced the subtitle with a re-timed one while the film played (Wyzie Synced); the page says `Subtitles synced` each time it goes up. */
  subtitleSyncs: number;
  /** The stretches of the title on this machine's disk (a cached play or a torrent), in seconds: the timeline's thick grey bar. */
  cachedRanges: TimeRange[];
  /** A torrent session (torrent-stream-source phase 4): the mark beside the title and the wait for a part not on disk. Null: not a torrent. */
  torrent: TorrentView | null;
  /**
   * The session's seek-preview frames (GET /api/stream/sessions/:id/previews) as last read; NO_PREVIEWS
   * before the first read, in a new session, and for a daemon that has none. The box over the timeline
   * draws them.
   */
  previews: Previews;
  /** The player's error messages, oldest first. */
  errors: string[];
  /** Recent notes for scripts and people: refreshes, subtitle failures, errors. */
  log: string[];
  /** The report button's state for this session; back to idle when the page plays another session. */
  bugReport: BugReportState;
  /** The daemon lost the session (a restart) or cannot be reached: the page is asking for a fresh session for its play. */
  reconnecting: boolean;
}

export const INITIAL_STATE: StreamState = {
  stage: 'loading',
  title: 'Stream',
  kind: null,
  qualities: [],
  quality: -1,
  subtitles: [],
  subtitle: null,
  error: null,
  refreshes: 0,
  reportedS: null,
  muted: false,
  prevEpisode: null,
  nextEpisode: null,
  switching: null,
  switchError: null,
  cached: null,
  changingSource: false,
  sourceNotice: null,
  switchedWhy: null,
  caption: '',
  subtitleDelayMs: 0,
  subtitleSyncs: 0,
  cachedRanges: [],
  torrent: null,
  previews: NO_PREVIEWS,
  errors: [],
  log: [],
  bugReport: { status: 'idle' },
  reconnecting: false,
};

export interface ControllerDeps {
  fetch: typeof fetch;
  createEngine: CreateEngine;
  /** A URL a <track> can load WebVTT text from (a blob: URL in the browser). */
  textUrl: (vtt: string) => string;
  revokeTextUrl: (url: string) => void;
  /** `?muted=1` (mutedFromLocation). Default false. */
  muted?: boolean;
  /** The page now plays another session (the next or previous episode): the address bar follows. */
  onSession?: (sessionId: string) => void;
  /** Where the subtitle delay of a title is kept between plays (localStorage in the browser). Without it nothing is kept. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Where the page keeps what it knows of its play, so a reload after a daemon restart can carry it on (sessionStorage in the browser). */
  memory?: Pick<Storage, 'getItem' | 'setItem'>;
  /** A monotonic clock in ms for the play's counters (performance.now() by default). Never the wall clock: it steps on this machine. */
  now?: () => number;
}

/**
 * The controller as its parts see it. Every getter reads the controller's value at the moment of the
 * call (the session, its id and the counters change when the page plays another session), so a part
 * never keeps one across an `await` without checking it again.
 */
export interface PlayerHost {
  readonly video: HTMLVideoElement;
  readonly deps: ControllerDeps;
  /** `?muted=1`: a muted check never moves, caches or carries on. */
  readonly muted: boolean;
  /** The session the page plays now. */
  sessionId(): string;
  /** That session as last read from the daemon; null before the first read. */
  session(): StreamSession | null;
  state(): StreamState;
  set(patch: Partial<StreamState>): void;
  /** A line for the page's log and the daemon's stream evidence log. */
  note(line: string): void;
  /** The play stops with this error. */
  fail(err: unknown): void;
  disposed(): boolean;
  /** The film is on the page: playing, paused, or riding out a network error on its buffer. */
  onFilm(): boolean;
  /** The counters of this page load of this session (playStats.ts); new when the page plays another session. */
  stats(): PlayStats;
  /** The last position the film was seen at while on the page; 0 before any. */
  lastPositionS(): number;
}

/** The newest lines the page keeps of its log and of its errors. */
export const LOG_MAX = 20;

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** The daemon's code for a SessionError, else the error's own words. */
export const codeOf = (err: unknown): string => (err instanceof SessionError ? err.code : messageOf(err));
