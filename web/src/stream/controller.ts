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
  cacheSession,
  fetchCacheMap,
  type TimeRange,
  type EpisodeNumber,
  type ManifestKind,
  type PlayerLogLine,
  type ReportAnswer,
  type StreamSession,
  type CachedInfo,
} from './session';
import { isEnglish, pickDefaultSubtitle, toWebVtt, type SubtitleOption } from './subtitles';

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
/**
 * Where a subtitle's bottom edge sits, in percent of the picture's height from the top. A cue left
 * where the browser puts it lies on the very last line: under the control bar, and cut off in full screen.
 */
export const SUBTITLE_LINE_PERCENT = 88;
export const PAUSE_CACHE_DELAY_MS = 2_000;
/** How often the page asks where the download stands, and what is on disk. */
export const CACHE_POLL_MS = 4_000;
const LOG_MAX = 20;
  /** The daemon refuses a longer line or a bigger batch (src/http/streamEvidenceApi.ts). */
  const EVENT_TEXT_MAX = 2_000;
  const EVENTS_PER_POST = 50;

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
  /** How much later (positive) or earlier (negative) the subtitles show than their file says, in ms (G and H). */
  subtitleDelayMs: number;
  /** The stretches of the title on this machine's disk (a cached play), in seconds: the timeline's thick grey bar. */
  cachedRanges: TimeRange[];
  /** The player's error messages, oldest first (phase 6's playcheck reads them). */
  errors: string[];
  /** Recent notes for scripts and people: refreshes, subtitle failures, errors. */
  log: string[];
  /** The report button's state for this session; back to idle when the page plays another session. */
  bugReport: BugReportState;
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
  subtitleDelayMs: 0,
  cachedRanges: [],
  errors: [],
  log: [],
  bugReport: { status: 'idle' },
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
}

interface FileTrack {
  option: SubtitleOption;
  element: HTMLTrackElement;
  url: string;
}

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
  private lastPositionS = 0;
  private fileTracks: FileTrack[] = [];
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
  /** The move onto the cache loads the film again: it stays paused when it was. */
  private holdPaused = false;
  /** Each cue's times as its file gave them, so a delay is always counted from there. */
  private readonly cueTimes = new WeakMap<object, { start: number; end: number; applied: number }>();
  /** How many cues the text tracks held when they were last gone through, and under which delay: nothing new, nothing to do. */
  private cuesTended = { count: -1, delay: 0 };
  /** Log lines waiting for this tick's post to the daemon, each under the session it was written in. */
  private unsent: { sessionId: string; line: PlayerLogLine }[] = [];
  private readonly mutedMode: boolean;
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
      if (!this.disposed) this.fail(err);
      return;
    }
    if (this.disposed) return;
    await this.open(session);
  }

  /** Plays a session read from the daemon: its name, neighbours and cache, its subtitle files, then the engine at its resume position. */
  private async open(session: StreamSession): Promise<void> {
    this.session = session;
    this.set({ title: session.title, kind: session.manifestKind, prevEpisode: session.prevEpisode, nextEpisode: session.nextEpisode, cached: session.cached });
    if (session.cached !== null) this.note(`from cache ${session.cached.id.slice(0, 8)} (${session.cached.state})`);
    this.restoreSubtitleDelay();
    await this.loadFileSubtitles(session);
    if (this.disposed || this.session !== session) return;
    if (session.cached !== null) this.followCache(session.cached.id);
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
    this.set({ cachedRanges: [] });
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
   * Goes through every cue of every text track: lifts it off the bottom line (a cue the file placed
   * itself, a sign at the top, is left where it is) and moves it to its own time plus the delay.
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
        const placed = cue as Partial<VTTCue>;
        if (placed.line === 'auto') {
          placed.snapToLines = false;
          placed.line = SUBTITLE_LINE_PERCENT;
          placed.lineAlign = 'end';
        }
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
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('playing', this.onMoving);
    this.clearStallTimer();
    this.clearCacheTimers();
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

  private async loadFileSubtitles(session: StreamSession): Promise<void> {
    for (const [index, sub] of session.subtitles.entries()) {
      try {
        // One more try: a stream host that fails once would leave the whole film without the track.
        const text = await fetchText(sub.url, this.deps.fetch).catch(() => fetchText(sub.url, this.deps.fetch));
        const vtt = toWebVtt(text);
        const url = this.deps.textUrl(vtt);
        const element = this.video.ownerDocument.createElement('track');
        element.kind = 'subtitles';
        element.label = sub.label;
        if (sub.lang !== null) element.srclang = sub.lang;
        element.src = url;
        this.video.appendChild(element);
        this.fileTracks.push({
          option: { id: `file-${index}`, source: 'file', index, label: sub.label, lang: sub.lang, english: sub.english },
          element,
          url,
        });
      } catch (err) {
        this.note(`subtitle ${sub.label}: ${messageOf(err)}`);
      }
    }
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
            // notesd's own refusal (no X-Notesd-Upstream): the session is gone; a refresh cannot help.
            if (current() && this.state.stage !== 'error') this.fail(new SessionError('session_over', status));
          },
          onRecovering: (attempt, message) => {
            if (current()) this.onRecovering(attempt, message);
          },
          onRecovered: () => {
            if (current()) this.onRecovered();
          },
          onFatal: (message) => {
            if (current()) this.fail(new SessionError(message, 0));
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
  };

  // The film ran out of data while it should be playing. A wait that outlasts STALL_MIN_MS is a
  // stall; a seek's own wait, a pause and the first load are not.
  private readonly onWaiting = (): void => {
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
  };

  private countStall(): void {
    const now = Date.now();
    this.stalls = [...this.stalls.filter((at) => now - at < STALL_WINDOW_MS), now];
    if (this.stalls.length >= STALLS_TO_SWITCH) void this.changeSource();
  }

  /**
   * The film keeps stalling: ask the daemon for another provider of the same title. The film on
   * screen plays on while the daemon resolves; only when another provider answered does the page
   * load its stream, at the position it had reached. A cached play has no provider to leave, and a
   * muted check never moves (it measures the provider it was given).
   */
  private async changeSource(byOwner = false): Promise<void> {
    const now = Date.now();
    if (this.disposed || this.askingSource || this.mutedMode || this.session === null || this.session.cached !== null || !this.onFilm()) return;
    // The page's own asks are limited; the owner's (the button, S) are not.
    if (!byOwner && (this.sourceSwitches >= MAX_SOURCE_SWITCHES || (this.lastSourceAskAt > 0 && now - this.lastSourceAskAt < SOURCE_SWITCH_COOLDOWN_MS))) return;
    this.askingSource = true;
    this.lastSourceAskAt = now;
    const asked = this.sessionId;
    this.note(byOwner ? 'asked for another source' : `${this.stalls.length} stalls in ${Math.round(STALL_WINDOW_MS / 1000)} s: asking for another source`);
    this.stalls = [];
    this.set({ changingSource: true, sourceNotice: null });
    try {
      const answer = await switchSource(asked, this.deps.fetch);
      if (this.disposed || this.sessionId !== asked || this.state.stage === 'error') return;
      if (!answer.switched) {
        this.note(`source kept: ${answer.reason ?? 'no_other_source'}`);
        if (byOwner) this.set({ sourceNotice: 'No other source' });
        return;
      }
      this.sourceSwitches += 1;
      const continueAt = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
      this.generation += 1;
      this.engine?.destroy();
      this.engine = null;
      this.ready = null;
      this.clearFileTracks();
      this.session = answer.session;
      this.subtitleChosen = false;
      this.set({ stage: 'refreshing', kind: answer.session.manifestKind, qualities: [], quality: -1, subtitles: [], cached: answer.session.cached });
      this.note(`source: ${answer.from ?? '?'} -> ${answer.provider ?? '?'} at ${round1(continueAt)} s`);
      this.set({ sourceNotice: answer.provider });
      await this.loadFileSubtitles(answer.session);
      if (this.disposed || this.session !== answer.session) return;
      await this.attach(answer.session, continueAt);
    } catch (err) {
      if (!this.disposed && this.sessionId === asked) this.note(`source kept: ${err instanceof SessionError ? err.code : messageOf(err)}`);
    } finally {
      this.askingSource = false;
      if (!this.disposed) this.set({ changingSource: false });
    }
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
  // machine meanwhile. Once per session; not for a play that is already a cache, a muted check,
  // or DASH (which is never cached).
  private armPauseCache(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const session = this.session;
    if (this.mutedMode || session === null || session.cached !== null || session.manifestKind === 'dash' || this.cacheAskedFor === this.sessionId || !this.onFilm() || this.video.ended) return;
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
    if (this.disposed || this.sessionId !== asked || this.state.stage === 'error') return;
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

  // Chrome keeps a cue on the picture when its track is taken away while the film is detached (the
  // last line of episode 787 stayed over the whole of 788), so a track is switched off before it goes.
  private clearFileTracks(): void {
    for (const track of this.fileTracks) {
      if (track.element.track) track.element.track.mode = 'disabled';
      track.element.remove();
      this.deps.revokeTextUrl(track.url);
    }
    this.fileTracks = [];
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
      if (track.element.track) track.element.track.mode = on ? 'showing' : 'disabled';
    }
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
    void postPosition(this.sessionId, report, this.deps.fetch);
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
      this.set({ cached: session.cached });
      await this.attach(session, continueAt);
    } catch (err) {
      if (!this.disposed) this.fail(err);
    }
  }
}
