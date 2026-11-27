import { BUFFER_AHEAD_S, CACHED_BUFFER_AHEAD_S, MUTED_BUFFER_AHEAD_S, NETWORK_RETRY_LIMIT, type EngineReady, type PlayerEngine } from './engine';
import {
  fetchSession,
  isDaemonDown,
  NO_PREVIEWS,
  refreshSession,
  reportStreamBug,
  SessionError,
  switchEpisode,
  type PositionAnswer,
  type SourceSwitch,
  type StreamSession,
} from './session';
import { PlayStats } from './playStats';
import { INITIAL_STATE, LOG_MAX, codeOf, messageOf, round1, torrentView, type ControllerDeps, type PlayerHost, type StreamState } from './playerState';
import { EvidenceLog } from './evidenceLog';
import { Captions } from './captions';
import { SubtitleTracks } from './subtitleTracks';
import { StallWatch } from './stallWatch';
import { SourceSwitcher } from './sourceSwitch';
import { Reconnect } from './reconnect';
import { PauseCache } from './pauseCache';
import { TorrentWait } from './torrentWait';
import { PreviewFrames } from './previewFrames';
import { PositionReports, type ReportExtra } from './positionReports';

// The controller's public surface: what StreamApp.tsx and the tests read from here. Each rule lives
// in the module that applies it (playerState.ts lists them); this file wires them to one play.
export { INITIAL_STATE, torrentView, type BugReportState, type ControllerDeps, type Stage, type StreamState, type TorrentView } from './playerState';
export { cueText, SUBTITLE_DELAY_MAX_MS, SUBTITLE_DELAY_STEP_MS } from './captions';
export { SUBTITLE_HOLD_MS } from './subtitleTracks';
export { SEEK_GRACE_MS, STALL_MIN_MS, STALL_REPEAT_MS, STALL_WINDOW_MS, STALLS_TO_SWITCH, TORRENT_STALLS_TO_SWITCH } from './stallWatch';
export { MAX_SOURCE_SWITCHES, NO_OTHER_SOURCE, SOURCE_SWITCH_COOLDOWN_MS } from './sourceSwitch';
export { RECONNECT_GIVE_UP_MS, RECONNECT_RETRY_MS } from './reconnect';
export { CACHE_POLL_MS, PAUSE_CACHE_DELAY_MS } from './pauseCache';
export { onDisk, scaleRanges, TORRENT_POLL_MS } from './torrentWait';
export { POSITION_INTERVAL_MS } from './positionReports';

export const MAX_REFRESHES = 3;

/**
 * One play on the player page: the session, the engine on the <video>, the page's state, and every
 * load of another stream (the next episode, another source, the cache, a fresh session after a daemon
 * restart, a refreshed token). The rules of each concern are in their own module; see playerState.ts.
 */
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
  private lastPositionS = 0;
  private disposed = false;
  /** The move onto the cache loads the film again: it stays paused when it was. */
  private holdPaused = false;
  private readonly mutedMode: boolean;
  /** Resolved the first time the stream is ready or the play has failed (playWithSound waits on it). */
  private settle: () => void = () => {};
  private readonly settled: Promise<void>;
  /** The monotonic clock the counters use. */
  private readonly now: () => number;
  /** The counters of this page load of this session, sent with every position report; new when the page plays another session. */
  private stats: PlayStats;

  private readonly log: EvidenceLog;
  private readonly captions: Captions;
  private readonly previews: PreviewFrames;
  private readonly tracks: SubtitleTracks;
  private readonly torrent: TorrentWait;
  private readonly reconnect: Reconnect;
  private readonly stalls: StallWatch;
  private readonly switcher: SourceSwitcher;
  private readonly pauseCache: PauseCache;
  private readonly reports: PositionReports;

  constructor(sessionId: string, video: HTMLVideoElement, deps: ControllerDeps) {
    this.sessionId = sessionId;
    this.video = video;
    this.deps = deps;
    this.mutedMode = deps.muted === true;
    this.now = deps.now ?? (() => performance.now());
    this.stats = new PlayStats(this.now);
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    if (this.mutedMode) {
      // Before any play(): phase 6's muted checks must never make a sound.
      this.video.muted = true;
      this.state = { ...this.state, muted: true };
    }
    const host: PlayerHost = {
      video,
      deps,
      muted: this.mutedMode,
      sessionId: () => this.sessionId,
      session: () => this.session,
      state: () => this.state,
      set: (patch) => this.set(patch),
      note: (line) => this.note(line),
      fail: (err) => this.fail(err),
      disposed: () => this.disposed,
      onFilm: () => this.onFilm(),
      stats: () => this.stats,
      lastPositionS: () => this.lastPositionS,
    };
    this.log = new EvidenceLog(video, deps.fetch);
    this.captions = new Captions(host);
    this.previews = new PreviewFrames(host);
    this.tracks = new SubtitleTracks({ ...host, engine: () => this.engine, engineReady: () => this.ready !== null }, this.captions, this.previews);
    this.torrent = new TorrentWait(host);
    this.reconnect = new Reconnect({ ...host, generation: () => this.generation, hasEngine: () => this.engine !== null, swapTo: (session) => this.swapTo(session) });
    this.stalls = new StallWatch(host, () => void this.switcher.change());
    this.switcher = new SourceSwitcher({ ...host, moveTo: (answer) => this.moveTo(answer) }, this.stalls, this.reconnect);
    this.pauseCache = new PauseCache({
      ...host,
      moveOntoCache: (session) => this.moveOntoCache(session),
      replaceSession: (session) => {
        this.session = session;
      },
    });
    this.reports = new PositionReports({
      ...host,
      rememberPosition: (id, positionS) => this.reconnect.rememberPosition(id, positionS),
      onAnswer: (asked, answer) => this.onPositionAnswer(asked, answer),
    });
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
    this.video.addEventListener('seeked', this.captions.read);
    this.video.addEventListener('seeked', this.torrent.arrived);
    this.video.addEventListener('canplay', this.torrent.arrived);
    (this.video.textTracks as TextTrackList | undefined)?.addEventListener?.('change', this.captions.read);
    this.video.addEventListener('waiting', this.onWaiting);
    this.video.addEventListener('playing', this.onMoving);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('play', this.reports.played);
    this.video.addEventListener('ended', this.reports.ended);
    this.video.ownerDocument.defaultView?.addEventListener('pagehide', this.reports.closed);
    this.reports.start();
    let session: StreamSession;
    try {
      session = await fetchSession(this.sessionId, this.deps.fetch);
    } catch (err) {
      if (this.disposed) return;
      // A reload after the daemon restarted: the tab still knows what it played.
      if (this.reconnect.readFromTab(this.sessionId) && (isDaemonDown(err) || (err instanceof SessionError && err.code === 'unknown_session'))) void this.reconnect.carryOn((err as SessionError).code);
      else this.fail(err);
      return;
    }
    if (this.disposed) return;
    await this.open(session);
  }

  /** Plays a session read from the daemon: its name, neighbours, cache or torrent, its subtitle files, then the engine at its resume position. */
  private async open(session: StreamSession): Promise<void> {
    this.session = session;
    this.reconnect.remember(session, session.resumeS > 0 ? session.resumeS : null);
    this.set({
      title: session.title,
      kind: session.manifestKind,
      prevEpisode: session.prevEpisode,
      nextEpisode: session.nextEpisode,
      cached: session.cached,
      torrent: torrentView(session.torrent),
    });
    // The seek-preview frames: read once now, and again only when the daemon says they changed.
    this.previews.follow(this.sessionId, session.previewRev);
    if (session.cached !== null) this.note(`from cache ${session.cached.id.slice(0, 8)} (${session.cached.state})`);
    if (session.torrent !== null) this.note(`from torrent ${session.torrent.infoHash.slice(0, 8)} ${session.torrent.name} (${session.torrent.state})`);
    this.captions.restoreDelay();
    await this.tracks.loadFiles(session);
    if (this.disposed || this.session !== session) return;
    if (session.cached !== null) this.pauseCache.follow(session.cached.id);
    if (session.torrent !== null) this.torrent.follow(session.torrent.infoHash);
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
      const code = codeOf(err);
      this.set({ switching: null, switchError: { to, code } });
      this.note(`${to} episode: ${code}`);
      return;
    }
    if (this.disposed) return;
    if (this.onFilm() && !this.video.ended) this.report({ closed: true });
    this.dropEngine();
    this.tracks.clear();
    this.sessionId = nextId;
    // Another session: its own load id and counters, so no load id ever spans two sessions.
    this.stats = new PlayStats(this.now);
    this.lastPositionS = 0;
    this.stalls.reset();
    this.switcher.reset();
    this.pauseCache.clearTimers();
    this.torrent.stop();
    this.previews.forget();
    this.set({ cachedRanges: [], torrent: null, previews: NO_PREVIEWS });
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
    this.tracks.select(id);
  }

  /**
   * G and H: the subtitles show `deltaMs` later (positive) or earlier, on top of what was set
   * before. Kept per title, so the next play of it starts with the same delay.
   */
  shiftSubtitles(deltaMs: number): void {
    this.captions.shift(deltaMs);
  }

  selectQuality(index: number): void {
    if (index !== -1 && !this.state.qualities.some((q) => q.index === index)) return;
    this.engine?.setQuality(index);
    this.set({ quality: index });
  }

  /**
   * The owner wants another source (the button, S): the picture is poor, a cinema recording, the
   * wrong cut. The daemon resolves the title without the provider on screen while the film plays
   * on; the session never goes back to a provider it left.
   */
  anotherSource(): void {
    void this.switcher.change(true);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.reports.stop();
    this.video.removeEventListener('timeupdate', this.onTime);
    this.video.removeEventListener('seeking', this.onTime);
    this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('seeked', this.captions.read);
    this.video.removeEventListener('seeked', this.torrent.arrived);
    this.video.removeEventListener('canplay', this.torrent.arrived);
    (this.video.textTracks as TextTrackList | undefined)?.removeEventListener?.('change', this.captions.read);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('playing', this.onMoving);
    this.stalls.clearTimer();
    this.pauseCache.clearTimers();
    this.torrent.stop();
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('play', this.reports.played);
    this.video.removeEventListener('ended', this.reports.ended);
    this.video.ownerDocument.defaultView?.removeEventListener('pagehide', this.reports.closed);
    this.engine?.destroy();
    this.engine = null;
    this.tracks.clear();
  }

  private set(patch: Partial<StreamState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** A line for the page's log and, batched per tick, the daemon's stream evidence log (R2.2). */
  private note(line: string): void {
    this.set({ log: [...this.state.log, line].slice(-LOG_MAX) });
    this.log.send(this.sessionId, this.state.stage, line);
  }

  private fail(err: unknown): void {
    const code = codeOf(err);
    this.set({
      stage: 'error',
      error: code,
      errors: [...this.state.errors, code].slice(-LOG_MAX),
      log: [...this.state.log, `error: ${code}`].slice(-LOG_MAX),
    });
    this.log.send(this.sessionId, this.state.stage, `error: ${code}`);
    this.settle();
  }

  /** The film is on the page: playing, paused, or riding out a network error on its buffer. */
  private onFilm(): boolean {
    return this.state.stage === 'ready' || this.state.stage === 'recovering';
  }

  private report(extra: ReportExtra = {}): void {
    this.reports.send(extra);
  }

  /** The engine on the page is let go of: anything it still says is dropped by the generation counter. */
  private dropEngine(): void {
    this.generation += 1;
    this.engine?.destroy();
    this.engine = null;
    this.ready = null;
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
            if (current() && this.state.stage !== 'error') void this.reconnect.endedOrCarryOn(new SessionError('session_over', status));
          },
          onRecovering: (attempt, message) => {
            if (current()) this.onRecovering(attempt, message);
          },
          onRecovered: () => {
            if (current()) this.onRecovered();
          },
          onFatal: (message) => {
            if (!current()) return;
            this.stats.error();
            void this.switcher.leaveBroken(message);
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
    // One network error per episode of restarts, however many restarts it takes.
    if (attempt === 1) this.stats.error();
    const at = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.set({ stage: 'recovering' });
    this.note(`recovering ${attempt}/${NETWORK_RETRY_LIMIT} after ${message} at ${round1(at)} s`);
    this.stalls.add();
  }

  /** A load succeeded after a restart: back to the film (or to loading, when it never played since attach). */
  private onRecovered(): void {
    if (this.state.stage === 'error') return;
    if (this.state.stage === 'recovering') this.set({ stage: this.readySinceAttach ? 'ready' : 'loading' });
    this.note(`recovered at ${round1(this.video.currentTime)} s`);
  }

  private applyChoices(): void {
    const ready = this.ready;
    const engine = this.engine;
    if (ready === null || engine === null) return;
    const { subtitles, subtitle } = this.tracks.choose(ready);
    const qualities = [...ready.qualities].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const quality = qualities.some((q) => q.index === this.state.quality) ? this.state.quality : -1;
    this.tracks.show(subtitles, subtitle);
    if (quality !== -1) engine.setQuality(quality);
    this.set({ stage: 'ready', qualities, quality, subtitles, subtitle, error: null });
    this.settle();
    if (this.holdPaused) this.holdPaused = false;
    else void this.playOrMute();
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

  /**
   * Loads the stream of the provider the daemon moved the session to, at the position the film had reached. A move
   * the daemon made by itself (its `source_rev` went up) says why over the picture: `Switched to another source: …`.
   */
  private async moveTo(answer: SourceSwitch): Promise<void> {
    const byDaemon = answer.session.sourceRev !== (this.session?.sourceRev ?? 0) && answer.session.sourceNote !== null;
    this.switcher.moved();
    // A play that left the cache never goes back to it with a pause.
    if (this.session?.cached != null && answer.session.cached === null) this.pauseCache.markAsked(this.sessionId);
    this.reconnect.remember(answer.session, null);
    const continueAt = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.dropEngine();
    this.tracks.clear();
    this.torrent.stop();
    this.session = answer.session;
    this.previews.follow(this.sessionId, answer.session.previewRev);
    this.tracks.chosen = false;
    // The new source's view has no fetching mark: the wait for the old one's part is over.
    this.stats.waitEnded();
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
    this.set({ sourceNotice: answer.session.torrent?.name ?? answer.provider, switchedWhy: byDaemon ? answer.session.sourceNote : null });
    if (byDaemon) this.note(`switched by the daemon: ${answer.session.sourceNote ?? ''}`);
    if (answer.session.torrent !== null) this.torrent.follow(answer.session.torrent.infoHash);
    await this.tracks.loadFiles(answer.session);
    if (this.disposed || this.session !== answer.session) return;
    await this.attach(answer.session, continueAt);
  }

  /** The daemon moved the paused play onto its cache: the film loads again from the local files, at the same place, paused if it was. */
  private async moveOntoCache(session: StreamSession): Promise<void> {
    const cached = session.cached;
    if (cached === null) return;
    const continueAt = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.holdPaused = this.video.paused;
    this.dropEngine();
    this.tracks.clear();
    this.session = session;
    this.previews.follow(this.sessionId, session.previewRev);
    this.stalls.reset();
    this.set({ stage: 'refreshing', kind: session.manifestKind, qualities: [], quality: -1, subtitles: [], cached });
    this.note(`from cache ${cached.id.slice(0, 8)} (${cached.state}) at ${round1(continueAt)} s`);
    this.pauseCache.follow(cached.id);
    await this.tracks.loadFiles(session);
    if (this.disposed || this.session !== session) return;
    await this.attach(session, continueAt);
  }

  /** Plays the fresh session a carry-on got, at the position the film reached; paused if it was. */
  private async swapTo(session: StreamSession): Promise<void> {
    const at = this.reconnect.continueAt() > 0 ? this.reconnect.continueAt() : session.resumeS;
    this.holdPaused = this.onFilm() && this.video.paused && !this.video.ended;
    this.dropEngine();
    this.tracks.clear();
    this.pauseCache.clearTimers();
    this.torrent.stop();
    this.sessionId = session.id;
    // Another session: its own load id and counters.
    this.stats = new PlayStats(this.now);
    this.stalls.reset();
    this.switcher.reset();
    this.tracks.chosen = false;
    this.pauseCache.forget();
    this.previews.forget();
    this.set({ stage: 'refreshing', error: null, refreshes: 0, qualities: [], quality: -1, subtitles: [], cachedRanges: [], previews: NO_PREVIEWS, bugReport: { status: 'idle' } });
    this.note(`carried on in session ${session.id.slice(0, 6)} at ${round1(at)} s`);
    this.deps.onSession?.(session.id);
    await this.open({ ...session, resumeS: at });
    if (this.session?.id === session.id) this.reconnect.remember(session, at > 0 ? at : null);
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
      this.previews.follow(this.sessionId, session.previewRev);
      // A refresh of a cached session either keeps the cache or moves to the pass-through (the cache was cleared).
      this.set({ cached: session.cached, torrent: torrentView(session.torrent) });
      if (session.torrent !== null) this.torrent.follow(session.torrent.infoHash);
      else this.torrent.stop();
      await this.attach(session, continueAt);
    } catch (err) {
      if (!this.disposed) this.fail(err);
    }
  }

  /** What the answer to a position report for `asked` says changed behind the play. */
  private onPositionAnswer(asked: string, answer: PositionAnswer): void {
    // The daemon moved the session to another source by itself: that reload brings its subtitles too.
    if (answer.sourceRev !== null && this.session !== null && answer.sourceRev !== this.session.sourceRev) void this.switcher.followRev(asked, answer.sourceRev);
    else if (answer.rev !== null) void this.tracks.followRev(asked, answer.rev);
    // New seek-preview frames (a sheet finished, a provider's track was read): the box over the timeline uses them at once.
    if (answer.previewRev !== null) this.previews.follow(asked, answer.previewRev);
    // The daemon restarted under the film (or is restarting): a fresh session for the same play.
    if (answer.gone && !this.disposed && this.sessionId === asked && !this.reconnect.active) void this.reconnect.carryOn('unknown_session');
  }

  private readonly onTime = (): void => {
    this.captions.applyDelay();
    this.captions.read();
    if (this.onFilm() && this.video.currentTime > 0) this.lastPositionS = this.video.currentTime;
    this.stats.tick(this.video.currentTime, this.onFilm() && !this.video.ended && !this.video.paused);
  };

  private readonly onSeek = (): void => {
    this.stalls.seeked();
    this.torrent.markFetching(true);
  };

  // The film ran out of data while it should be playing (stallWatch.ts decides what is a stall). A
  // torrent's wait for a part that is not on disk yet is also shown as such.
  private readonly onWaiting = (): void => {
    if (this.state.stage === 'ready') this.torrent.markFetching(true);
    this.stalls.waiting();
  };

  private readonly onMoving = (): void => {
    this.stalls.moving();
    this.torrent.markFetching(false);
  };

  private readonly onPause = (): void => {
    this.stalls.paused();
    // And play stops counting here, whether or not a time update follows the pause: the first
    // update after it only starts the count again (the plan's R1.6 test decides this).
    this.stats.tick(this.video.currentTime, false);
    this.pauseCache.arm();
    if (this.onFilm() && !this.video.ended) this.report();
  };
}
