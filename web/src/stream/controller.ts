import type { CreateEngine, EngineReady, PlayerEngine, Quality } from './engine';
import {
  fetchSession,
  fetchText,
  postPosition,
  refreshSession,
  SessionError,
  type ManifestKind,
  type StreamSession,
} from './session';
import { isEnglish, pickDefaultSubtitle, toWebVtt, type SubtitleOption } from './subtitles';

export const POSITION_INTERVAL_MS = 5_000;
export const MAX_REFRESHES = 3;
const LOG_MAX = 20;

export type Stage = 'loading' | 'ready' | 'refreshing' | 'error';

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
  /** The player's error messages, oldest first (phase 6's playcheck reads them). */
  errors: string[];
  /** Recent notes for scripts and people: refreshes, subtitle failures, errors. */
  log: string[];
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
  errors: [],
  log: [],
};

export interface ControllerDeps {
  fetch: typeof fetch;
  createEngine: CreateEngine;
  /** A URL a <track> can load WebVTT text from (a blob: URL in the browser). */
  textUrl: (vtt: string) => string;
  revokeTextUrl: (url: string) => void;
  /** `?muted=1` (mutedFromLocation). Default false. */
  muted?: boolean;
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
    if (this.disposed || this.state.stage !== 'ready') return false;
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
    this.session = session;
    this.set({ title: session.title, kind: session.manifestKind });
    await this.loadFileSubtitles(session);
    if (this.disposed) return;
    await this.attach(session, session.resumeS);
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
  }

  private fail(err: unknown): void {
    const code = err instanceof SessionError ? err.code : messageOf(err);
    this.set({
      stage: 'error',
      error: code,
      errors: [...this.state.errors, code].slice(-LOG_MAX),
      log: [...this.state.log, `error: ${code}`].slice(-LOG_MAX),
    });
    this.settle();
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
    if (this.state.stage === 'ready' && this.video.currentTime > 0) this.lastPositionS = this.video.currentTime;
  };

  // Every 5 s while the page is open: the position while it plays, and a beat while it is paused, so
  // the Movies page knows the film is still on screen (src/movies/streamLive.ts).
  private readonly onTick = (): void => {
    if (this.state.stage !== 'ready' || this.video.ended) return;
    this.report(this.video.paused ? { beat: true } : {});
  };

  private readonly onPause = (): void => {
    if (this.state.stage === 'ready' && !this.video.ended) this.report();
  };

  // Play after a pause: say so at once, not at the next tick.
  private readonly onPlay = (): void => {
    if (this.state.stage === 'ready' && !this.video.ended) this.report();
  };

  private readonly onEnded = (): void => {
    if (this.state.stage === 'ready') this.report({ ended: true });
  };

  // The tab or the window closes: the last position, and the film is no longer on screen.
  private readonly onClose = (): void => {
    if (this.state.stage === 'ready' && !this.video.ended) this.report({ closed: true });
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
      await this.attach(session, continueAt);
    } catch (err) {
      if (!this.disposed) this.fail(err);
    }
  }
}
