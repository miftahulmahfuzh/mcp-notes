import {
  BUFFER_AHEAD_S,
  CACHED_BUFFER_AHEAD_S,
  MUTED_BUFFER_AHEAD_S,
  NETWORK_RETRY_LIMIT,
  type CreateEngine,
  type EngineReady,
  type PlayerEngine,
  type Quality,
} from './engine';
import {
  fetchSession,
  fetchText,
  postEvents,
  postPosition,
  refreshSession,
  reportStreamBug,
  SessionError,
  switchEpisode,
  switchSource,
  type SourceSwitch,
  cacheSession,
  continueSession,
  isDaemonDown,
  readPlayMemory,
  writePlayMemory,
  type PlayMemory,
  fetchCacheMap,
  fetchTorrentMap,
  fetchTorrentStatus,
  type TimeRange,
  type EpisodeNumber,
  type ManifestKind,
  type PlayerLogLine,
  type ReportAnswer,
  type StreamSession,
  type SessionSubtitle,
  type CachedInfo,
  type TorrentInfo,
  type TorrentState,
} from './session';
import { addFeedCue, followCueFeed, isEnglish, pickDefaultSubtitle, toWebVtt, type CueFeedFollower, type SubtitleOption } from './subtitles';
import { isPageVisible, startAdaptivePoll, type AdaptivePoll } from '../lib/pageActive';

export const POSITION_INTERVAL_MS = 5_000;
export const MAX_REFRESHES = 3;
/** The film waiting for data this long is a stall; a shorter wait is not counted. */
export const STALL_MIN_MS = 1_500;
/** This many stalls (or network recoveries) within the window, and the page asks for another source. */
export const STALLS_TO_SWITCH = 3;
export const STALL_WINDOW_MS = 120_000;
/** A film still waiting is counted again this often. */
export const STALL_REPEAT_MS = 10_000;
/** A wait this soon after a seek is the seek's own. */
export const SEEK_GRACE_MS = 5_000;
/** At most this many moves to another provider per session, and one ask per cooldown. */
export const MAX_SOURCE_SWITCHES = 2;
export const SOURCE_SWITCH_COOLDOWN_MS = 120_000;
/** A pause this long starts the download of the title to this machine; a quick pause and play does not. */
/** One press of G or H moves the subtitles this far, as in VLC. */
export const SUBTITLE_DELAY_STEP_MS = 50;
export const SUBTITLE_DELAY_MAX_MS = 60_000;

/** A cue's text as the page shows it: WebVTT's tags (<i>, <c.yellow>, <v Name>, timestamps) taken out, its entities read. */
export function cueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_all: string, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}
export const PAUSE_CACHE_DELAY_MS = 2_000;
/** While the daemon is down (a restart), the page asks to carry its play on this often... */
export const RECONNECT_RETRY_MS = 5_000;
/** ...and gives up, showing that the stream has ended, after this long. */
export const RECONNECT_GIVE_UP_MS = 180_000;
/** How often the page asks where the download stands, and what is on disk. */
export const CACHE_POLL_MS = 4_000;
/** How often a torrent session asks for its peers, its speed and what is on disk, while it downloads and the tab shows. */
export const TORRENT_POLL_MS = 2_000;
/** The label of a subtitle Wyzie Synced re-timed (`English (Wyzie, synced)`). */
const SYNCED_LABEL = /\bsynced\)\s*$/i;
/** `sourceNotice` after an ask that found nothing; the page words it for a cloud source or a torrent. */
export const NO_OTHER_SOURCE = 'No other source';
const LOG_MAX = 20;
  /** The daemon refuses a longer line or a bigger batch (src/http/streamEvidenceApi.ts). */
  const EVENT_TEXT_MAX = 2_000;
  const EVENTS_PER_POST = 50;

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

/** The position is inside a stretch on disk, with the half second of slack loadedGradient joins stretches by. */
export function onDisk(ranges: readonly TimeRange[], t: number): boolean {
  return ranges.some(([from, to]) => t >= from - 0.5 && t < to);
}

/**
 * A map's seconds on the film's own clock. The daemon maps a torrent's bytes to seconds by
 * proportion of the duration it knows, which may not be the one the browser reads from the file.
 */
export function scaleRanges(ranges: readonly TimeRange[], mapDurationS: number | null, filmDurationS: number): TimeRange[] {
  if (mapDurationS === null || !(mapDurationS > 0) || !(filmDurationS > 0) || Math.abs(mapDurationS - filmDurationS) < 0.5) return [...ranges];
  const k = filmDurationS / mapDurationS;
  return ranges.map(([from, to]): TimeRange => [from * k, to * k]);
}

/** `recovering`: a network error; the engine loads again after a wait while the film stays on the page. */
export type Stage = 'loading' | 'ready' | 'refreshing' | 'recovering' | 'error';

/** The report button (only shown in the error stage): nothing sent, being sent, or the daemon's answer. */
export type BugReportState = { status: 'idle' } | { status: 'sending' } | ReportAnswer;

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
  /** The player's error messages, oldest first (phase 6's playcheck reads them). */
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
  caption: '',
  subtitleDelayMs: 0,
  subtitleSyncs: 0,
  cachedRanges: [],
  torrent: null,
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
}

interface FileTrack {
  option: SubtitleOption;
  element: HTMLTrackElement;
  url: string;
  /** A growing subtitle's reader of its feed, once the track has loaded; null for a file. */
  follower: CueFeedFollower | null;
}

/** How long the film waits for its subtitle files. */
export const SUBTITLE_HOLD_MS = 3_000;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class StreamController {
  private sessionId: string;
  private readonly video: HTMLVideoElement;
  private readonly deps: ControllerDeps;
  private state: StreamState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private session: StreamSession | null = null;
  private engine: PlayerEngine | null = null;
  private ready: EngineReady | null = null;
  private generation = 0;
  private readySinceAttach = false;
  private subtitleChosen = false;
  /** The session is being read again for a subtitle the daemon replaced. */
  private readingSubtitles = false;
  private lastPositionS = 0;
  private fileTracks: FileTrack[] = [];
  /** Counts every clearing of the file tracks: a file read for an earlier set is dropped when it arrives. */
  private subtitleLoad = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** When the film stalled lately (ms), for the move to another source. */
  private stalls: number[] = [];
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeekAt = 0;
  private sourceSwitches = 0;
  private lastSourceAskAt = 0;
  private askingSource = false;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  /** The session a pause already asked a cache for: once per session. */
  private cacheAskedFor: string | null = null;
  /** The torrent whose numbers and map are being read, and its poll; null once it is complete, failed or left. */
  private torrentHash: string | null = null;
  private torrentPoll: AdaptivePoll | null = null;
  /** The move onto the cache loads the film again: it stays paused when it was. */
  private holdPaused = false;
  /** Each cue's times as its file gave them, so a delay is always counted from there. */
  private readonly cueTimes = new WeakMap<object, { start: number; end: number; applied: number }>();
  /** How many cues the text tracks held when they were last gone through, and under which delay: nothing new, nothing to do. */
  private cuesTended = { count: -1, delay: 0 };
  /** The text tracks already listened to for `cuechange`. */
  private readonly heardTracks = new WeakSet<object>();
  /** Log lines waiting for this tick's post to the daemon, each under the session it was written in. */
  private unsent: { sessionId: string; line: PlayerLogLine }[] = [];
  private readonly mutedMode: boolean;
  /** What the page knows of its play (title, provider or torrent, position), to carry it on after the daemon lost the session. */
  private memory: PlayMemory | null = null;
  /** The page is asking the daemon to carry the play on (carryOn). */
  private carrying = false;
  /** The page is asking the daemon whether it still holds the session (endedOrCarryOn). */
  private judging = false;
  /** Resolved the first time the stream is ready or the play has failed (playWithSound waits on it). */
  private settle: () => void = () => {};
  private readonly settled: Promise<void>;

  constructor(sessionId: string, video: HTMLVideoElement, deps: ControllerDeps) {
    this.sessionId = sessionId;
    this.video = video;
    this.deps = deps;
    this.mutedMode = deps.muted === true;
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    if (this.mutedMode) {
      // Before any play(): phase 6's muted checks must never make a sound.
      this.video.muted = true;
      this.state = { ...this.state, muted: true };
    }
  }

  /**
   * window.notesdStream.start(): phase 1's `open --fullscreen` evaluates it as a user gesture, so
   * Chrome lets the film play with sound. Waits until the stream is ready, then unmutes and plays.
   * Does nothing under ?muted=1. True when the film is playing with sound.
   */
  async playWithSound(): Promise<boolean> {
    if (this.mutedMode || this.disposed) return false;
    await this.settled;
    if (this.disposed || !this.onFilm()) return false;
    this.video.muted = false;
    try {
      await this.video.play();
    } catch (err) {
      this.note(`start: ${messageOf(err)}`);
      return false;
    }
    return !this.video.muted && !this.video.paused;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): StreamState => this.state;

  async start(): Promise<void> {
    this.video.addEventListener('timeupdate', this.onTime);
    this.video.addEventListener('seeking', this.onTime);
    this.video.addEventListener('seeking', this.onSeek);
    this.video.addEventListener('seeked', this.readCaption);
    this.video.addEventListener('seeked', this.onArrived);
    this.video.addEventListener('canplay', this.onArrived);
    (this.video.textTracks as TextTrackList | undefined)?.addEventListener?.('change', this.readCaption);
    this.video.addEventListener('waiting', this.onWaiting);
    this.video.addEventListener('playing', this.onMoving);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('play', this.onPlay);
    this.video.addEventListener('ended', this.onEnded);
    this.video.ownerDocument.defaultView?.addEventListener('pagehide', this.onClose);
    this.timer = setInterval(this.onTick, POSITION_INTERVAL_MS);
    let session: StreamSession;
    try {
      session = await fetchSession(this.sessionId, this.deps.fetch);
    } catch (err) {
      if (this.disposed) return;
      // A reload after the daemon restarted: the tab still knows what it played.
      this.memory = readPlayMemory(this.deps.memory, this.sessionId);
      if (this.memory !== null && (isDaemonDown(err) || (err instanceof SessionError && err.code === 'unknown_session'))) void this.carryOn((err as SessionError).code);
      else this.fail(err);
      return;
    }
    if (this.disposed) return;
    await this.open(session);
  }

  /** Plays a session read from the daemon: its name, neighbours, cache or torrent, its subtitle files, then the engine at its resume position. */
  private async open(session: StreamSession): Promise<void> {
    this.session = session;
    this.remember(session, session.resumeS > 0 ? session.resumeS : null);
    this.set({
      title: session.title,
      kind: session.manifestKind,
      prevEpisode: session.prevEpisode,
      nextEpisode: session.nextEpisode,
      cached: session.cached,
      torrent: torrentView(session.torrent),
    });
    if (session.cached !== null) this.note(`from cache ${session.cached.id.slice(0, 8)} (${session.cached.state})`);
    if (session.torrent !== null) this.note(`from torrent ${session.torrent.infoHash.slice(0, 8)} ${session.torrent.name} (${session.torrent.state})`);
    this.restoreSubtitleDelay();
    await this.loadFileSubtitles(session);
    if (this.disposed || this.session !== session) return;
    if (session.cached !== null) this.followCache(session.cached.id);
    if (session.torrent !== null) this.followTorrent(session.torrent.infoHash);
    await this.attach(session, session.resumeS);
  }

  /**
   * The previous / next episode button. The daemon resolves that episode first, while the one on
   * screen keeps playing; only when it has a stream does the page let go of this one (a last
   * `closed` report) and play the new session, without leaving full screen. When the episode
   * cannot be streamed, nothing changes and `switchError` says why.
   */
  async goToEpisode(to: 'prev' | 'next'): Promise<void> {
    if (this.disposed || this.session === null || this.state.switching !== null) return;
    if ((to === 'next' ? this.state.nextEpisode : this.state.prevEpisode) === null) return;
    this.set({ switching: to, switchError: null });
    let nextId: string;
    try {
      nextId = await switchEpisode(this.sessionId, to, this.deps.fetch);
    } catch (err) {
      if (this.disposed) return;
      const code = err instanceof SessionError ? err.code : messageOf(err);
      this.set({ switching: null, switchError: { to, code } });
      this.note(`${to} episode: ${code}`);
      return;
    }
    if (this.disposed) return;
    if (this.onFilm() && !this.video.ended) this.report({ closed: true });
    this.generation += 1;
    this.engine?.destroy();
    this.engine = null;
    this.ready = null;
    this.clearFileTracks();
    this.sessionId = nextId;
    this.lastPositionS = 0;
    this.stalls = [];
    this.sourceSwitches = 0;
    this.lastSourceAskAt = 0;
    this.clearCacheTimers();
    this.stopTorrent();
    this.set({ cachedRanges: [], torrent: null });
    this.set({ stage: 'loading', switching: null, error: null, refreshes: 0, qualities: [], quality: -1, subtitles: [], reportedS: null, bugReport: { status: 'idle' } });
    this.note(`${to} episode: session ${nextId.slice(0, 6)}`);
    this.deps.onSession?.(nextId);
    try {
      const session = await fetchSession(nextId, this.deps.fetch);
      if (this.disposed) return;
      await this.open(session);
    } catch (err) {
      if (!this.disposed) this.fail(err);
    }
  }

  /**
   * The report button: asks the daemon to snapshot this session's evidence and open a Claude Code
   * window on it, sending the page's own log (the daemon may have lost the session). One report per
   * session: a click while one is being sent, after a window opened, or after the daemon said it
   * was reported before does nothing. A report saved but not opened may be sent again; the daemon
   * reuses its folder.
   */
  async reportBug(): Promise<void> {
    if (this.disposed) return;
    const now = this.state.bugReport.status;
    if (now === 'sending' || now === 'opened' || now === 'already') return;
    const sessionId = this.sessionId;
    this.set({ bugReport: { status: 'sending' } });
    const answer = await reportStreamBug(
      sessionId,
      {
        stage: this.state.stage,
        error: this.state.error,
        errors: this.state.errors,
        log: this.state.log,
        title: this.state.title,
        position_s: this.lastPositionS > 0 ? round1(this.lastPositionS) : null,
      },
      this.deps.fetch,
    );
    if (this.disposed || sessionId !== this.sessionId) return;
    this.set({ bugReport: answer });
    this.note(answer.status === 'failed' ? `report: failed ${answer.code}` : `report: ${answer.status} ${answer.dir}`);
  }

  selectSubtitle(id: string | null): void {
    if (id !== null && !this.state.subtitles.some((o) => o.id === id)) return;
    this.subtitleChosen = true;
    this.showSubtitle(this.state.subtitles, id);
    this.set({ subtitle: id });
  }

  /**
   * G and H: the subtitles show `deltaMs` later (positive) or earlier, on top of what was set
   * before. For a subtitle that came from another source than the picture and runs ahead of or
   * behind the voices. Kept per title, so the next play of it starts with the same delay.
   */
  shiftSubtitles(deltaMs: number): void {
    const next = Math.max(-SUBTITLE_DELAY_MAX_MS, Math.min(SUBTITLE_DELAY_MAX_MS, this.state.subtitleDelayMs + deltaMs));
    if (next === this.state.subtitleDelayMs) return;
    this.set({ subtitleDelayMs: next });
    this.applySubtitleDelay();
    const key = this.delayKey();
    if (key === null) return;
    try {
      if (next === 0) this.deps.storage?.removeItem(key);
      else this.deps.storage?.setItem(key, String(next));
    } catch {
      // A full or closed storage only means the delay is not remembered.
    }
  }

  private delayKey(): string | null {
    return this.session === null ? null : `notesd-subtitle-delay:${this.session.title}`;
  }

  private restoreSubtitleDelay(): void {
    const key = this.delayKey();
    let kept = 0;
    try {
      kept = Number(key === null ? 0 : (this.deps.storage?.getItem(key) ?? 0));
    } catch {
      kept = 0;
    }
    this.set({ subtitleDelayMs: Number.isFinite(kept) && Math.abs(kept) <= SUBTITLE_DELAY_MAX_MS ? Math.round(kept) : 0 });
  }

  /**
   * Reads what the subtitles say now into `caption`. A track an engine or the page turned on
   * (`showing`) is set to `hidden`: its cues keep running and Chrome draws nothing. Runs when a
   * track's cues change, when a track is turned on or off, and as the film plays.
   */
  private readonly readCaption = (): void => {
    // jsdom has no text tracks; a browser always does.
    const tracks = this.video.textTracks as TextTrackList | undefined;
    if (tracks === undefined) return;
    const lines: string[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track === undefined || (track.kind !== 'subtitles' && track.kind !== 'captions')) continue;
      if (!this.heardTracks.has(track)) {
        this.heardTracks.add(track);
        track.addEventListener?.('cuechange', this.readCaption);
      }
      if (track.mode === 'showing') track.mode = 'hidden';
      if (track.mode !== 'hidden' || !track.activeCues) continue;
      for (let j = 0; j < track.activeCues.length; j++) {
        const text = cueText((track.activeCues[j] as Partial<VTTCue> | undefined)?.text ?? '');
        if (text !== '' && !lines.includes(text)) lines.push(text);
      }
    }
    const caption = lines.join('\n');
    if (caption !== this.state.caption) this.set({ caption });
  };

  /**
   * Moves every cue of every text track to its own time plus the delay.
   * Cues arrive late (a file loads, hls.js adds a part), so this runs again as the film plays.
   */
  private applySubtitleDelay(): void {
    const delay = this.state.subtitleDelayMs;
    // jsdom has no text tracks; a browser always does.
    const tracks = this.video.textTracks as TextTrackList | undefined;
    if (tracks === undefined) return;
    let count = 0;
    for (let i = 0; i < tracks.length; i++) count += tracks[i]?.cues?.length ?? 0;
    if (count === this.cuesTended.count && delay === this.cuesTended.delay) return;
    this.cuesTended = { count, delay };
    for (let i = 0; i < tracks.length; i++) {
      const cues = tracks[i]?.cues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        const cue = cues[j];
        if (cue === undefined) continue;
        let times = this.cueTimes.get(cue);
        if (times === undefined) {
          if (delay === 0) continue;
          times = { start: cue.startTime, end: cue.endTime, applied: 0 };
          this.cueTimes.set(cue, times);
        }
        if (times.applied === delay) continue;
        const start = Math.max(0, times.start + delay / 1000);
        // Lengthening first keeps start before end whichever way the cue moves.
        cue.endTime = Math.max(cue.endTime, start + 0.001);
        cue.startTime = start;
        cue.endTime = Math.max(start + 0.001, times.end + delay / 1000);
        times.applied = delay;
      }
    }
  }

  selectQuality(index: number): void {
    if (index !== -1 && !this.state.qualities.some((q) => q.index === index)) return;
    this.engine?.setQuality(index);
    this.set({ quality: index });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.video.removeEventListener('timeupdate', this.onTime);
    this.video.removeEventListener('seeking', this.onTime);
    this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('seeked', this.readCaption);
    this.video.removeEventListener('seeked', this.onArrived);
    this.video.removeEventListener('canplay', this.onArrived);
    (this.video.textTracks as TextTrackList | undefined)?.removeEventListener?.('change', this.readCaption);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('playing', this.onMoving);
    this.clearStallTimer();
    this.clearCacheTimers();
    this.stopTorrent();
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('play', this.onPlay);
    this.video.removeEventListener('ended', this.onEnded);
    this.video.ownerDocument.defaultView?.removeEventListener('pagehide', this.onClose);
    this.engine?.destroy();
    this.engine = null;
    this.clearFileTracks();
  }

  private set(patch: Partial<StreamState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private note(line: string): void {
    this.set({ log: [...this.state.log, line].slice(-LOG_MAX) });
    this.send(line);
  }

  private fail(err: unknown): void {
    const code = err instanceof SessionError ? err.code : messageOf(err);
    this.set({
      stage: 'error',
      error: code,
      errors: [...this.state.errors, code].slice(-LOG_MAX),
      log: [...this.state.log, `error: ${code}`].slice(-LOG_MAX),
    });
    this.send(`error: ${code}`);
    this.settle();
  }

  /**
   * Every log line also goes to the daemon's stream evidence log (R2.2): errors, refreshes, subtitle
   * failures, and whatever else note() is given. Lines are batched per tick, so an error travels with
   * the line before it. Fire and forget: nothing here waits or throws.
   */
  private send(text: string): void {
    this.unsent.push({
      sessionId: this.sessionId,
      line: {
        text: text.slice(0, EVENT_TEXT_MAX),
        at: new Date().toISOString(),
        stage: this.state.stage,
        position_s: this.positionNow(),
        buffer_s: this.bufferAhead(),
      },
    });
    if (this.unsent.length === 1) queueMicrotask(this.flushUnsent);
  }

  private readonly flushUnsent = (): void => {
    const batch = this.unsent.splice(0);
    const bySession = new Map<string, PlayerLogLine[]>();
    for (const { sessionId, line } of batch) {
      const lines = bySession.get(sessionId) ?? [];
      lines.push(line);
      bySession.set(sessionId, lines);
    }
    for (const [sessionId, lines] of bySession) {
      for (let i = 0; i < lines.length; i += EVENTS_PER_POST) void postEvents(sessionId, lines.slice(i, i + EVENTS_PER_POST), this.deps.fetch);
    }
  };

  private positionNow(): number | null {
    const t = this.video.currentTime;
    return Number.isFinite(t) && t >= 0 ? round1(t) : null;
  }

  /** Seconds buffered ahead of the position: the end of the range holding it, else 0; null when the browser cannot say. */
  private bufferAhead(): number | null {
    try {
      const ranges = this.video.buffered;
      const t = this.video.currentTime;
      if (ranges === undefined || ranges === null || !Number.isFinite(t)) return null;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= t + 0.5 && t <= ranges.end(i)) return round1(Math.max(0, ranges.end(i) - t));
      }
      return 0;
    } catch {
      return null;
    }
  }

  /**
   * Reads the session's subtitle files, all at once, and holds the film for them at most `holdMs`:
   * a subtitle host that stalls on one file (Fake Profile S02E01: three of 31 took 18 to 20 s each,
   * read one after another) must not keep the picture back. A file that arrives after the hold
   * joins the menu then. `holdMs` null waits for every file and leaves the menu to the caller.
   */
  private async loadFileSubtitles(session: StreamSession, holdMs: number | null = SUBTITLE_HOLD_MS): Promise<void> {
    const load = this.subtitleLoad;
    let held = true;
    const all = Promise.all(
      [...session.subtitles.entries()].map(async ([index, sub]) => {
        try {
          // A growing subtitle (a cue feed) starts as an empty file; its cues are added as they come.
          // One more try for a file: a stream host that fails once would leave the whole film without the track.
          const vtt = sub.growing === true ? 'WEBVTT\n\n' : toWebVtt(await fetchText(sub.url, this.deps.fetch).catch(() => fetchText(sub.url, this.deps.fetch)));
          // The tracks were cleared meanwhile (another source, a subtitle read anew): this file is of the old set.
          if (this.disposed || load !== this.subtitleLoad) return;
          const url = this.deps.textUrl(vtt);
          const element = this.video.ownerDocument.createElement('track');
          element.kind = 'subtitles';
          element.label = sub.label;
          if (sub.lang !== null) element.srclang = sub.lang;
          element.src = url;
          const fileTrack: FileTrack = {
            option: { id: `file-${index}`, source: 'file', index, label: sub.label, lang: sub.lang, english: sub.english },
            element,
            url,
            follower: null,
          };
          // In the session's order, whichever file answered first.
          const after = this.fileTracks.findIndex((t) => t.option.index > index);
          if (after === -1) {
            this.video.appendChild(element);
            this.fileTracks.push(fileTrack);
          } else {
            this.video.insertBefore(element, this.fileTracks[after].element);
            this.fileTracks.splice(after, 0, fileTrack);
          }
          if (sub.growing === true) this.followGrowing(fileTrack, sub);
          if (!held) this.addLateFileTracks();
        } catch (err) {
          if (!this.disposed && load === this.subtitleLoad) this.note(`subtitle ${sub.label}: ${messageOf(err)}`);
        }
      }),
    );
    if (holdMs === null) {
      await all;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inTime = await Promise.race([all.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), holdMs)))]);
    clearTimeout(timer);
    held = false;
    if (!inTime && !this.disposed && load === this.subtitleLoad) this.note(`subtitles: ${this.fileTracks.length} of ${session.subtitles.length} file(s) in after ${holdMs / 1000} s, the rest join as they arrive`);
  }

  /** A subtitle file that arrived after the hold: it joins the menu, and is shown only where the default would have shown it. */
  private addLateFileTracks(): void {
    if (this.ready === null || !this.onFilm()) return;
    const subtitles = [...this.state.subtitles.filter((o) => o.source === 'manifest'), ...this.fileTracks.map((t) => t.option)];
    const was = this.state.subtitle;
    const subtitle = was !== null || this.subtitleChosen ? was : pickDefaultSubtitle(subtitles);
    this.showSubtitle(subtitles, subtitle);
    this.set({ subtitles, subtitle });
  }

  /**
   * A growing subtitle's cues come from its feed, read again every few seconds until it is complete.
   * Chrome empties a <track>'s cues when it first loads its file, and loads it only when the track is
   * first turned on, so the feed is read from then on: at once for the English track shown by default.
   */
  private followGrowing(fileTrack: FileTrack, sub: SessionSubtitle): void {
    fileTrack.element.addEventListener(
      'load',
      () => {
        const track = fileTrack.element.track;
        if (this.disposed || fileTrack.follower !== null || !this.fileTracks.includes(fileTrack) || !track) return;
        fileTrack.follower = followCueFeed(sub.url, {
          fetch: this.deps.fetch,
          add: (cue) => addFeedCue(track, cue),
          onError: (message) => this.note(`subtitle ${sub.label}: ${message}`),
          onComplete: (count) => this.note(`subtitle ${sub.label}: complete, ${count} cues`),
        });
      },
      { once: true },
    );
  }

  private async attach(session: StreamSession, startAt: number): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation && !this.disposed;
    this.ready = null;
    this.readySinceAttach = false;
    let engine: PlayerEngine;
    try {
      engine = await this.deps.createEngine({
        kind: session.manifestKind,
        video: this.video,
        src: session.manifestUrl,
        startAt,
        audioTrack: session.audioTrack,
        // R1.8: 120 s ahead; ?muted=1 keeps 30 s for the expiry checks; a complete cache (phase 6)
        // is on disk, so it buffers as far as hls.js goes by itself.
        bufferAheadS: this.mutedMode ? MUTED_BUFFER_AHEAD_S : session.cached?.state === 'ready' ? CACHED_BUFFER_AHEAD_S : BUFFER_AHEAD_S,
        handlers: {
          onReady: (ready) => {
            if (current()) this.onReady(ready);
          },
          onAuthError: (status) => {
            if (current()) void this.refresh(status);
          },
          onSessionOver: (status) => {
            // notesd's own refusal (no X-Notesd-Upstream): the session is gone (a restart); a refresh cannot help, a fresh session can.
            if (current() && this.state.stage !== 'error') void this.endedOrCarryOn(new SessionError('session_over', status));
          },
          onRecovering: (attempt, message) => {
            if (current()) this.onRecovering(attempt, message);
          },
          onRecovered: () => {
            if (current()) this.onRecovered();
          },
          onFatal: (message) => {
            if (current()) void this.leaveBrokenSource(message);
          },
        },
      });
    } catch (err) {
      if (current()) this.fail(err);
      return;
    }
    if (!current()) {
      engine.destroy();
      return;
    }
    this.engine = engine;
    if (this.ready !== null) this.applyChoices();
  }

  private onReady(ready: EngineReady): void {
    this.ready = ready;
    this.readySinceAttach = true;
    if (this.engine !== null) this.applyChoices();
  }

  /**
   * R1.7: the engine lost the network and loads again after a wait. The film stays on the page
   * (it plays on from its buffer meanwhile); the error is shown only when the engine gives up.
   */
  private onRecovering(attempt: number, message: string): void {
    if (this.state.stage === 'error') return;
    const at = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.set({ stage: 'recovering' });
    this.note(`recovering ${attempt}/${NETWORK_RETRY_LIMIT} after ${message} at ${round1(at)} s`);
    this.countStall();
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private readonly onSeek = (): void => {
    this.lastSeekAt = Date.now();
    this.clearStallTimer();
    this.markFetching(true);
  };

  // The film ran out of data while it should be playing. A wait that outlasts STALL_MIN_MS is a
  // stall; a seek's own wait, a pause and the first load are not. A torrent's wait for a part that
  // is not on disk yet is also shown as such.
  private readonly onWaiting = (): void => {
    if (this.state.stage === 'ready') this.markFetching(true);
    if (this.state.stage !== 'ready' || this.video.paused) return;
    // A seek's own wait is not a stall, unless it outlasts the grace.
    this.armStall(STALL_MIN_MS + Math.max(0, this.lastSeekAt + SEEK_GRACE_MS - Date.now()));
  };

  // A film that stays frozen is counted again every STALL_REPEAT_MS, so one long freeze moves the
  // source as three short ones do. `playing`, a seek and a pause end the wait.
  private armStall(delayMs: number): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.disposed || this.state.stage !== 'ready' || this.video.paused) return;
      this.note(`stalled at ${round1(this.video.currentTime)} s`);
      this.countStall();
      if (this.state.stage === 'ready') this.armStall(STALL_REPEAT_MS);
    }, delayMs);
  }

  private readonly onMoving = (): void => {
    this.clearStallTimer();
    this.markFetching(false);
  };

  private countStall(): void {
    const now = Date.now();
    this.stalls = [...this.stalls.filter((at) => now - at < STALL_WINDOW_MS), now];
    if (this.stalls.length >= STALLS_TO_SWITCH) void this.changeSource();
  }

  /**
   * The film keeps stalling: ask the daemon for another provider of the same title. The film on
   * screen plays on while the daemon resolves; only when another provider answered does the page
   * load its stream, at the position it had reached. A cached play has no provider to leave, a
   * muted check never moves (it measures the provider it was given), and a torrent that buffers is
   * still filling, so only the owner moves a torrent session (to the next torrent).
   */
  private async changeSource(byOwner = false): Promise<void> {
    const now = Date.now();
    if (this.disposed || this.askingSource || this.carrying || this.mutedMode || this.session === null || !this.onFilm()) return;
    if (!byOwner && this.session.torrent !== null) return;
    // A cached play that keeps stalling (a part not on disk fetched from a slow host) goes back to the live stream.
    const leaveCache = this.session.cached !== null;
    if (leaveCache && byOwner) return;
    // The page's own asks are limited; the owner's (the button, S) are not.
    if (!byOwner && (this.sourceSwitches >= MAX_SOURCE_SWITCHES || (this.lastSourceAskAt > 0 && now - this.lastSourceAskAt < SOURCE_SWITCH_COOLDOWN_MS))) return;
    this.askingSource = true;
    this.lastSourceAskAt = now;
    const asked = this.sessionId;
    this.note(
      byOwner
        ? 'asked for another source'
        : `${this.stalls.length} stalls in ${Math.round(STALL_WINDOW_MS / 1000)} s: ${leaveCache ? 'leaving the cache for the live stream' : 'asking for another source'}`,
    );
    this.stalls = [];
    this.set({ changingSource: true, sourceNotice: null });
    try {
      const answer = await switchSource(asked, this.deps.fetch, { leaveCache });
      if (this.disposed || this.sessionId !== asked || this.state.stage === 'error') return;
      if (!answer.switched) {
        this.note(`source kept: ${answer.reason ?? 'no_other_source'}`);
        if (byOwner) this.set({ sourceNotice: NO_OTHER_SOURCE });
        return;
      }
      await this.moveTo(answer);
    } catch (err) {
      if (!this.disposed && this.sessionId === asked) {
        this.note(`source kept: ${err instanceof SessionError ? err.code : messageOf(err)}`);
        if (isDaemonDown(err) || (err instanceof SessionError && err.code === 'unknown_session')) void this.carryOn((err as SessionError).code);
      }
    } finally {
      this.askingSource = false;
      if (!this.disposed) this.set({ changingSource: false });
    }
  }

  /** Loads the stream of the provider the daemon moved the session to, at the position the film had reached. */
  private async moveTo(answer: SourceSwitch): Promise<void> {
    this.sourceSwitches += 1;
    // A play that left the cache never goes back to it with a pause.
    if (this.session?.cached != null && answer.session.cached === null) this.cacheAskedFor = this.sessionId;
    this.remember(answer.session, null);
    const continueAt = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.generation += 1;
    this.engine?.destroy();
    this.engine = null;
    this.ready = null;
    this.clearFileTracks();
    this.stopTorrent();
    this.session = answer.session;
    this.subtitleChosen = false;
    this.set({
      stage: 'refreshing',
      kind: answer.session.manifestKind,
      qualities: [],
      quality: -1,
      subtitles: [],
      cached: answer.session.cached,
      torrent: torrentView(answer.session.torrent),
      cachedRanges: [],
    });
    this.note(`source: ${answer.from ?? '?'} -> ${answer.provider ?? '?'} at ${round1(continueAt)} s`);
    // Every torrent's provider is `Torrent`: a torrent is named by its release.
    this.set({ sourceNotice: answer.session.torrent?.name ?? answer.provider });
    if (answer.session.torrent !== null) this.followTorrent(answer.session.torrent.infoHash);
    await this.loadFileSubtitles(answer.session);
    if (this.disposed || this.session !== answer.session) return;
    await this.attach(answer.session, continueAt);
  }

  /**
   * The stream cannot be played at all (a segment that does not parse, a manifest the player
   * refuses, a network error the restarts did not cure): a provider's broken stream should not be
   * the end of the play. The daemon is asked for another provider of the same title, and the play
   * stops with the error only when there is none, or the session has moved as often as it may. A
   * cached play, a torrent and a muted check have no other provider to go to.
   */
  private async leaveBrokenSource(message: string): Promise<void> {
    const session = this.session;
    if (this.carrying) {
      // The daemon is being asked for a fresh session: the engine giving up meanwhile changes nothing.
      this.note(`${message} while reconnecting`);
      if (this.state.stage !== 'error') this.set({ stage: 'refreshing' });
      return;
    }
    if (this.disposed || this.mutedMode || this.askingSource || session === null || session.torrent !== null || this.sourceSwitches >= MAX_SOURCE_SWITCHES) {
      // A torrent's file route is the daemon's own: a stream that broke because the daemon went away carries on.
      await this.endedOrCarryOn(new SessionError(message, 0));
      return;
    }
    this.askingSource = true;
    this.lastSourceAskAt = Date.now();
    const asked = this.sessionId;
    this.stalls = [];
    this.note(`${message}: asking for another source`);
    this.set({ stage: 'refreshing', changingSource: true, sourceNotice: null });
    let gone = false;
    try {
      const answer = await switchSource(asked, this.deps.fetch, { leaveCache: session.cached !== null });
      if (this.disposed || this.sessionId !== asked) return;
      if (!answer.switched) {
        this.note(`source kept: ${answer.reason ?? 'no_other_source'}`);
        this.fail(new SessionError(message, 0));
        return;
      }
      await this.moveTo(answer);
    } catch (err) {
      if (this.disposed || this.sessionId !== asked) return;
      this.note(`source kept: ${err instanceof SessionError ? err.code : messageOf(err)}`);
      gone = isDaemonDown(err) || (err instanceof SessionError && err.code === 'unknown_session');
      if (!gone) this.fail(new SessionError(message, 0));
    } finally {
      this.askingSource = false;
      if (!this.disposed) this.set({ changingSource: false });
    }
    if (gone) void this.carryOn(message);
  }

  /** The play cannot go on as it is: when the daemon lost the session or cannot be reached, it is carried on; else it stops with `err`. */
  private async endedOrCarryOn(err: SessionError): Promise<void> {
    if (this.disposed || this.carrying || this.judging) return;
    if (this.mutedMode || this.memory === null) {
      this.fail(err);
      return;
    }
    const asked = this.sessionId;
    // A move (another source, the cache) that began meanwhile has replaced what failed.
    const generation = this.generation;
    let gone = false;
    this.judging = true;
    try {
      await fetchSession(asked, this.deps.fetch);
    } catch (e) {
      gone = isDaemonDown(e) || (e instanceof SessionError && e.code === 'unknown_session');
    } finally {
      this.judging = false;
    }
    if (this.disposed || this.sessionId !== asked || this.generation !== generation || this.state.stage === 'error') return;
    if (gone) void this.carryOn(err.code);
    else this.fail(err);
  }

  /** Keeps what the page knows of its play, in memory and in the tab's storage. */
  private remember(session: StreamSession, positionS: number | null): void {
    if (session.ref === null) return;
    const keep = this.memory !== null && this.memory.sessionId === session.id ? this.memory.positionS : null;
    this.memory = { sessionId: session.id, ref: session.ref, provider: session.provider, infoHash: session.torrent?.infoHash ?? null, positionS: positionS ?? keep };
    writePlayMemory(this.deps.memory, this.memory);
  }

  /**
   * The daemon lost the session (it restarted: sessions live in its memory) or cannot be reached.
   * The page asks for a fresh session for the same play (POST /api/stream/continue) with what it
   * knows: the title, the provider or the torrent, the position. While the daemon is down it asks
   * again every RECONNECT_RETRY_MS with a quiet note, and only after RECONNECT_GIVE_UP_MS says the
   * stream has ended. The film on screen plays on from its buffer meanwhile; the new session is
   * loaded at the position the film reached, and the address bar follows it.
   */
  private async carryOn(reason: string): Promise<void> {
    if (this.disposed || this.carrying) return;
    const memory = this.memory;
    if (this.mutedMode || memory === null) {
      this.fail(new SessionError(reason === 'unknown_session' ? reason : 'session_over', 0));
      return;
    }
    this.carrying = true;
    this.set({ reconnecting: true });
    this.note(`${reason}: carrying the play on in a fresh session`);
    const asked = this.sessionId;
    const giveUpAt = Date.now() + RECONNECT_GIVE_UP_MS;
    try {
      for (;;) {
        const at = this.continueAt();
        try {
          const answer = await continueSession({ ...memory, positionS: at > 0 ? at : memory.positionS }, this.deps.fetch);
          if (this.disposed || this.sessionId !== asked) return;
          if (!answer.continued && answer.session.id === asked && this.onFilm() && this.engine !== null) {
            this.note('the daemon still holds the session');
            return;
          }
          await this.swapTo(answer.session);
          return;
        } catch (err) {
          if (this.disposed || this.sessionId !== asked) return;
          if (!isDaemonDown(err) || Date.now() >= giveUpAt) {
            const code = err instanceof SessionError && !isDaemonDown(err) ? err.code : 'session_over';
            this.note(`could not carry the play on: ${err instanceof SessionError ? err.code : messageOf(err)}`);
            this.fail(new SessionError(code, 0));
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_RETRY_MS));
        if (this.disposed || this.sessionId !== asked) return;
      }
    } finally {
      this.carrying = false;
      if (!this.disposed) this.set({ reconnecting: false });
    }
  }

  /** Where the film is: the picture's position while it is on the page, else the last one known. */
  private continueAt(): number {
    if (this.onFilm() && this.video.currentTime > 0) return this.video.currentTime;
    if (this.lastPositionS > 0) return this.lastPositionS;
    return this.memory?.positionS ?? 0;
  }

  /** Plays the fresh session carryOn got, at the position the film reached; paused if it was. */
  private async swapTo(session: StreamSession): Promise<void> {
    const at = this.continueAt() > 0 ? this.continueAt() : session.resumeS;
    this.holdPaused = this.onFilm() && this.video.paused && !this.video.ended;
    this.generation += 1;
    this.engine?.destroy();
    this.engine = null;
    this.ready = null;
    this.clearFileTracks();
    this.clearCacheTimers();
    this.stopTorrent();
    this.sessionId = session.id;
    this.stalls = [];
    this.sourceSwitches = 0;
    this.lastSourceAskAt = 0;
    this.subtitleChosen = false;
    this.cacheAskedFor = null;
    this.set({ stage: 'refreshing', error: null, refreshes: 0, qualities: [], quality: -1, subtitles: [], cachedRanges: [], bugReport: { status: 'idle' } });
    this.note(`carried on in session ${session.id.slice(0, 6)} at ${round1(at)} s`);
    this.deps.onSession?.(session.id);
    await this.open({ ...session, resumeS: at });
    if (this.session?.id === session.id) this.remember(session, at > 0 ? at : null);
  }

  /**
   * The owner wants another source (the button, S): the picture is poor, a cinema recording, the
   * wrong cut. The daemon resolves the title without the provider on screen while the film plays
   * on; the session never goes back to a provider it left.
   */
  anotherSource(): void {
    void this.changeSource(true);
  }

  private clearCacheTimers(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    if (this.cacheTimer !== null) clearTimeout(this.cacheTimer);
    this.pauseTimer = null;
    this.cacheTimer = null;
  }

  // A pause that lasts: the owner waits for the film to load, so the daemon downloads it to this
  // machine meanwhile. Once per session; not for a play that is already a cache, a torrent (its
  // download is already on this machine's disk), a muted check, or DASH (which is never cached).
  private armPauseCache(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const session = this.session;
    if (
      this.mutedMode ||
      session === null ||
      session.cached !== null ||
      session.torrent !== null ||
      session.manifestKind === 'dash' ||
      this.cacheAskedFor === this.sessionId ||
      !this.onFilm() ||
      this.video.ended
    ) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (this.disposed || !this.video.paused || this.video.ended || !this.onFilm() || this.session !== session) return;
      this.cacheAskedFor = this.sessionId;
      void this.askCache(this.sessionId, true);
    }, PAUSE_CACHE_DELAY_MS);
  }

  /** One ask of the daemon about the paused play's cache; asks again until the session moved onto it or it failed. */
  private async askCache(asked: string, start: boolean): Promise<void> {
    let answer;
    try {
      answer = await cacheSession(asked, start, this.deps.fetch);
    } catch (err) {
      if (!this.disposed && this.sessionId === asked) this.note(`cache: ${err instanceof SessionError ? err.code : messageOf(err)}`);
      return;
    }
    if (this.disposed || this.sessionId !== asked) return;
    const moving = answer.moved && answer.session.cached !== null;
    // The daemon clears the old pass-through's allowed hosts the moment it answers `moved`, which can
    // race a segment the outgoing engine was still buffering into a stray `session_over`. The move
    // itself is authoritative (the daemon confirmed it), so it goes ahead and a stale error does not
    // stop it; an unrelated error with no move still does.
    if (this.state.stage === 'error' && !moving) return;
    if (start && answer.cache !== null) this.note(`paused: caching on this machine (${answer.cache.id.slice(0, 8)})`);
    if (answer.cache === null || answer.cache.state === 'failed') {
      this.note(`cache: ${answer.cache === null ? 'not available' : (answer.cache.error ?? 'failed')}`);
      return;
    }
    if (!answer.moved || answer.session.cached === null) {
      this.cacheTimer = setTimeout(() => {
        this.cacheTimer = null;
        void this.askCache(asked, false);
      }, CACHE_POLL_MS);
      return;
    }
    // The film loads again from the local files, at the same place, paused if it was.
    const continueAt = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.holdPaused = this.video.paused;
    this.generation += 1;
    this.engine?.destroy();
    this.engine = null;
    this.ready = null;
    this.clearFileTracks();
    this.session = answer.session;
    this.stalls = [];
    this.set({ stage: 'refreshing', kind: answer.session.manifestKind, qualities: [], quality: -1, subtitles: [], cached: answer.session.cached });
    this.note(`from cache ${answer.session.cached.id.slice(0, 8)} (${answer.session.cached.state}) at ${round1(continueAt)} s`);
    this.followCache(answer.session.cached.id);
    await this.loadFileSubtitles(answer.session);
    if (this.disposed || this.session !== answer.session) return;
    await this.attach(answer.session, continueAt);
  }

  /** Keeps `cachedRanges` current while the session plays from a cache: now, then every poll until the download is complete. */
  private followCache(cacheId: string): void {
    if (this.cacheTimer !== null) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    const asked = this.sessionId;
    const tick = async (): Promise<void> => {
      const ranges = await fetchCacheMap(cacheId, this.deps.fetch);
      if (this.disposed || this.sessionId !== asked || this.session?.cached?.id !== cacheId) return;
      this.set({ cachedRanges: ranges });
      if (this.session.cached.state === 'ready') return;
      // The download may have finished: the daemon says so, and the mark beside the title follows.
      const now = await cacheSession(asked, false, this.deps.fetch).catch(() => null);
      if (this.disposed || this.sessionId !== asked || this.session?.cached?.id !== cacheId) return;
      if (now?.cache?.state === 'ready' && now.session.cached !== null) {
        this.session = { ...this.session, cached: now.session.cached };
        this.set({ cached: now.session.cached, cachedRanges: await fetchCacheMap(cacheId, this.deps.fetch) });
        return;
      }
      if (now?.cache?.state === 'failed') return;
      this.cacheTimer = setTimeout(() => void tick(), CACHE_POLL_MS);
    };
    void tick();
  }

  /**
   * Keeps a torrent session's numbers and `cachedRanges` current: now, then every TORRENT_POLL_MS
   * while the tab shows, until the download is complete or failed. A hidden tab asks nothing and
   * asks again as soon as it shows (startAdaptivePoll). Reads only.
   */
  private followTorrent(infoHash: string): void {
    this.stopTorrent();
    this.torrentHash = infoHash;
    const run = async (): Promise<boolean> => {
      const done = await this.readTorrent(infoHash);
      if (done && this.torrentHash === infoHash) this.stopTorrent();
      return true;
    };
    if (isPageVisible()) void run();
    this.torrentPoll = startAdaptivePoll({ baseMs: TORRENT_POLL_MS, run });
  }

  private stopTorrent(): void {
    this.torrentPoll?.stop();
    this.torrentPoll = null;
    this.torrentHash = null;
  }

  /** One read of the torrent's status and map. True once there is nothing more to follow (complete or failed). */
  private async readTorrent(infoHash: string): Promise<boolean> {
    const [status, map] = await Promise.all([fetchTorrentStatus(infoHash, this.deps.fetch), fetchTorrentMap(infoHash, this.deps.fetch)]);
    const torrent = this.state.torrent;
    if (this.disposed || this.torrentHash !== infoHash || torrent === null || torrent.infoHash !== infoHash) return false;
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.set({
      // A map the daemon could not give leaves the bar as it was.
      cachedRanges: map === null ? this.state.cachedRanges : scaleRanges(map.ranges, map.durationS, duration),
      torrent: status === null ? torrent : { ...torrent, state: status.state, peers: status.peers, downKbps: status.downKbps, progress: status.progress },
    });
    const state = status?.state ?? torrent.state;
    if (state === 'downloading') return false;
    this.note(state === 'ready' ? `torrent ${infoHash.slice(0, 8)} on disk` : `torrent ${infoHash.slice(0, 8)} failed`);
    return true;
  }

  /**
   * A torrent's play or a seek reached a part that is not on disk yet (`on`), or that part arrived.
   * Only a torrent session waits this way, and a part on disk is never waited for.
   */
  private markFetching(on: boolean): void {
    const torrent = this.state.torrent;
    if (torrent === null || torrent.fetching === on) return;
    if (on && (torrent.state === 'ready' || onDisk(this.state.cachedRanges, this.video.currentTime))) return;
    this.set({ torrent: { ...torrent, fetching: on } });
    if (on) this.note(`waiting for the torrent at ${round1(this.video.currentTime)} s`);
  }

  // The part a torrent's play waited for is here: the seek landed, or the film can play.
  private readonly onArrived = (): void => {
    this.markFetching(false);
  };

  // Chrome keeps a cue on the picture when its track is taken away while the film is detached (the
  // last line of episode 787 stayed over the whole of 788), so a track is switched off before it goes.
  private clearFileTracks(): void {
    for (const track of this.fileTracks) {
      track.follower?.stop();
      if (track.element.track) track.element.track.mode = 'disabled';
      track.element.remove();
      this.deps.revokeTextUrl(track.url);
    }
    this.fileTracks = [];
    this.subtitleLoad += 1;
    if (this.state.caption !== '') this.set({ caption: '' });
  }

  /** A load succeeded after a restart: back to the film (or to loading, when it never played since attach). */
  private onRecovered(): void {
    if (this.state.stage === 'error') return;
    if (this.state.stage === 'recovering') this.set({ stage: this.readySinceAttach ? 'ready' : 'loading' });
    this.note(`recovered at ${round1(this.video.currentTime)} s`);
  }

  /** The film is on the page: playing, paused, or riding out a network error on its buffer. */
  private onFilm(): boolean {
    return this.state.stage === 'ready' || this.state.stage === 'recovering';
  }

  private applyChoices(): void {
    const ready = this.ready;
    const engine = this.engine;
    if (ready === null || engine === null) return;
    const embedded: SubtitleOption[] = ready.subtitles.map((s) => ({
      id: `manifest-${s.index}`,
      source: 'manifest',
      index: s.index,
      label: s.label,
      lang: s.lang,
      english: isEnglish(s.lang, s.label),
    }));
    const subtitles = [...embedded, ...this.fileTracks.map((t) => t.option)];
    const keep =
      this.subtitleChosen && (this.state.subtitle === null || subtitles.some((o) => o.id === this.state.subtitle));
    const subtitle = keep ? this.state.subtitle : pickDefaultSubtitle(subtitles);
    const qualities = [...ready.qualities].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const quality = qualities.some((q) => q.index === this.state.quality) ? this.state.quality : -1;
    this.showSubtitle(subtitles, subtitle);
    if (quality !== -1) engine.setQuality(quality);
    this.set({ stage: 'ready', qualities, quality, subtitles, subtitle, error: null });
    this.settle();
    if (this.holdPaused) this.holdPaused = false;
    else void this.playOrMute();
  }

  private showSubtitle(options: readonly SubtitleOption[], id: string | null): void {
    const chosen = options.find((o) => o.id === id) ?? null;
    this.engine?.setEmbeddedSubtitle(chosen !== null && chosen.source === 'manifest' ? chosen.index : null);
    for (const track of this.fileTracks) {
      const on = chosen !== null && chosen.source === 'file' && chosen.index === track.option.index;
      track.element.default = on;
      // jsdom has no TextTrack; a browser always does.
      // `hidden`: the cues run and readCaption shows them; Chrome draws nothing.
      if (track.element.track) track.element.track.mode = on ? 'hidden' : 'disabled';
    }
    this.readCaption();
  }

  /**
   * Sound first; when the browser refuses autoplay with sound, play muted (the mute icon shows it,
   * and phase 1's start() call unmutes it as a user gesture). Under ?muted=1, muted only.
   */
  private async playOrMute(): Promise<void> {
    if (this.mutedMode) {
      this.video.muted = true;
    } else {
      try {
        await this.video.play();
        return;
      } catch {
        // autoplay with sound refused
      }
    }
    this.video.muted = true;
    try {
      await this.video.play();
    } catch (err) {
      this.note(`play: ${messageOf(err)}`);
    }
  }

  private readonly onTime = (): void => {
    this.applySubtitleDelay();
    this.readCaption();
    if (this.onFilm() && this.video.currentTime > 0) this.lastPositionS = this.video.currentTime;
  };

  // Every 5 s while the page is open: the position while it plays, and a beat while it is paused, so
  // the Movies page knows the film is still on screen (src/movies/streamLive.ts). A recovery is still
  // the film on screen: it plays on from its buffer.
  private readonly onTick = (): void => {
    if (!this.onFilm() || this.video.ended) return;
    this.report(this.video.paused ? { beat: true } : {});
  };

  private readonly onPause = (): void => {
    this.clearStallTimer();
    this.armPauseCache();
    if (this.onFilm() && !this.video.ended) this.report();
  };

  // Play after a pause: say so at once, not at the next tick.
  private readonly onPlay = (): void => {
    if (this.onFilm() && !this.video.ended) this.report();
  };

  private readonly onEnded = (): void => {
    if (this.onFilm()) this.report({ ended: true });
  };

  // The tab or the window closes: the last position, and the film is no longer on screen.
  private readonly onClose = (): void => {
    if (this.onFilm() && !this.video.ended) this.report({ closed: true });
  };

  private report(extra: { ended?: boolean; beat?: boolean; closed?: boolean } = {}): void {
    if (this.session === null) return;
    const ended = extra.ended === true;
    const duration = Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : null;
    const position = ended && duration !== null ? duration : this.video.currentTime;
    if (!(position > 0)) return;
    const report = {
      position_s: round1(position),
      duration_s: duration === null ? null : round1(duration),
      ended,
      paused: !ended && this.video.paused,
      ...(extra.beat === true ? { beat: true } : {}),
      ...(extra.closed === true ? { closed: true } : {}),
    };
    this.set({ reportedS: report.position_s });
    const asked = this.sessionId;
    if (this.memory !== null && this.memory.sessionId === asked && !ended) {
      this.memory = { ...this.memory, positionS: report.position_s };
      writePlayMemory(this.deps.memory, this.memory);
    }
    void postPosition(asked, report, this.deps.fetch).then((answer) => {
      if (answer.rev !== null) void this.followSubtitleRev(asked, answer.rev);
      // The daemon restarted under the film (or is restarting): a fresh session for the same play.
      if (answer.gone && !this.disposed && this.sessionId === asked && !this.carrying) void this.carryOn('unknown_session');
    });
  }

  /**
   * The daemon changed the session's subtitle while the film plays, and the answer to a position report
   * said so: Wyzie Synced re-timed a subtitle that came from outside the stream, or a cloud stream with
   * no English subtitle got one from a subtitle service. The session is read again and its subtitle
   * files loaded anew: the film and its position stay as they are, subtitles the viewer turned off stay
   * off, and a subtitle that arrives where there was none is shown like any English one. A re-timed
   * file sets the owner's G/H delay for the title back to 0, since it was set against the old timing.
   */
  private async followSubtitleRev(asked: string, rev: number): Promise<void> {
    const session = this.session;
    if (this.disposed || this.readingSubtitles || session === null || this.sessionId !== asked || rev === session.subtitleRev || !this.onFilm()) return;
    this.readingSubtitles = true;
    try {
      const fresh = await fetchSession(asked, this.deps.fetch);
      if (this.disposed || this.session !== session || this.sessionId !== asked || fresh.subtitleRev === session.subtitleRev) return;
      session.subtitles = fresh.subtitles;
      session.subtitleRev = fresh.subtitleRev;
      this.clearFileTracks();
      await this.loadFileSubtitles(session, null);
      if (this.disposed || this.session !== session) return;
      const subtitles = [...this.state.subtitles.filter((o) => o.source === 'manifest'), ...this.fileTracks.map((t) => t.option)];
      const was = this.state.subtitle;
      const subtitle = was !== null && subtitles.some((o) => o.id === was) ? was : was === null && this.subtitleChosen ? null : pickDefaultSubtitle(subtitles);
      this.showSubtitle(subtitles, subtitle);
      const synced = fresh.subtitles.some((s) => SYNCED_LABEL.test(s.label));
      this.set({ subtitles, subtitle, ...(synced ? { subtitleSyncs: this.state.subtitleSyncs + 1 } : {}) });
      if (synced && this.state.subtitleDelayMs !== 0) this.shiftSubtitles(-this.state.subtitleDelayMs);
      this.note(`subtitles ${synced ? 'synced' : 'changed'}: ${fresh.subtitles.map((s) => s.label).join(', ') || 'none'}`);
    } catch (err) {
      this.note(`subtitles not reloaded: ${err instanceof SessionError ? err.code : messageOf(err)}`);
    } finally {
      this.readingSubtitles = false;
    }
  }

  private async refresh(status: number): Promise<void> {
    if (this.state.stage === 'error') return;
    // Only the engine a refresh just attached can call in while the stage is still `refreshing`
    // (the replaced one is dropped by the generation counter): refused again before it played.
    if (
      this.state.stage === 'refreshing' ||
      this.state.refreshes >= MAX_REFRESHES ||
      (this.state.refreshes > 0 && !this.readySinceAttach)
    ) {
      this.fail(new SessionError('stream_expired', status));
      return;
    }
    const continueAt = this.lastPositionS > 0 ? this.lastPositionS : (this.session?.resumeS ?? 0);
    this.generation += 1;
    this.set({ stage: 'refreshing', refreshes: this.state.refreshes + 1 });
    this.note(`refresh after ${status} at ${round1(continueAt)} s`);
    this.engine?.destroy();
    this.engine = null;
    this.ready = null;
    try {
      this.sessionId = await refreshSession(this.sessionId, this.deps.fetch);
      const session = await fetchSession(this.sessionId, this.deps.fetch);
      if (this.disposed) return;
      this.session = session;
      // A refresh of a cached session either keeps the cache or moves to the pass-through (the cache was cleared).
      this.set({ cached: session.cached, torrent: torrentView(session.torrent) });
      if (session.torrent !== null) this.followTorrent(session.torrent.infoHash);
      else this.stopTorrent();
      await this.attach(session, continueAt);
    } catch (err) {
      if (!this.disposed) this.fail(err);
    }
  }
}
