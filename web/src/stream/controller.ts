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
    await this.loadFileSubtitles(session);
    if (this.disposed || this.session !== session) return;
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
    for (const track of this.fileTracks) {
      track.element.remove();
      this.deps.revokeTextUrl(track.url);
    }
    this.fileTracks = [];
    this.sessionId = nextId;
    this.lastPositionS = 0;
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
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('play', this.onPlay);
    this.video.removeEventListener('ended', this.onEnded);
    this.video.ownerDocument.defaultView?.removeEventListener('pagehide', this.onClose);
    this.engine?.destroy();
    this.engine = null;
    for (const track of this.fileTracks) {
      track.element.remove();
      this.deps.revokeTextUrl(track.url);
    }
    this.fileTracks = [];
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
    void this.playOrMute();
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
