import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowArcLeft,
  ArrowArcRight,
  ArrowDown,
  ArrowsIn,
  ArrowsOut,
  Bug,
  CheckCircle,
  CircleNotch,
  ClosedCaptioning,
  CloudArrowDown,
  GearSix,
  HardDrive,
  IconContext,
  Magnet,
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
  UsersThree,
  WarningCircle,
} from '@phosphor-icons/react';
import { INITIAL_STATE, NO_OTHER_SOURCE, SUBTITLE_DELAY_STEP_MS, StreamController, type BugReportState, type ControllerDeps, type StreamState, type TorrentView } from './controller';
import { createEngine } from './createEngine';
import type { Quality } from './engine';
import type { CachedInfo, EpisodeNumber, TimeRange } from './session';
import { pickDefaultSubtitle } from './subtitles';

/**
 * window.notesdStream: the player's state for scripts (`kind`, `levels`, `level`, `errors`,
 * `refreshes` beside the <video>), and `start()`, which phase 1's
 * `open --fullscreen` evaluates as a user gesture so the film starts with sound.
 */
export interface NotesdStream extends StreamState {
  /** The heights offered, highest first. */
  levels: number[];
  /** The chosen quality's engine index; -1 for auto. */
  level: number;
  /** Go full screen (the page's own, so a double click leaves it), then unmute and play once ready; false (and nothing done) under ?muted=1. */
  start: () => Promise<boolean>;
}

export function notesdStreamOf(state: StreamState, start: () => Promise<boolean>): NotesdStream {
  return {
    ...state,
    levels: state.qualities.flatMap((q) => (q.height === null ? [] : [q.height])),
    level: state.quality,
    start,
  };
}

declare global {
  interface Window {
    notesdStream?: NotesdStream;
  }
}

const ICONS = { weight: 'duotone' as const, size: '1em', color: 'currentColor', mirrored: false };
export const IDLE_MS = 2_500;
const SEEK_STEP_S = 10;

const ERRORS: Record<string, string> = {
  no_session: 'There is no stream in this address.',
  unknown_session: 'This stream has ended. Start it again from Claude Code or the movies page.',
  direct_stream_off: 'Direct streaming is off on this machine.',
  no_source: 'No provider could play this title any more.',
  stream_expired: 'The stream host keeps refusing this stream.',
  session_over: 'This stream session has ended (the daemon no longer knows it). Start it again from Claude Code or the movies page.',
  bad_session: 'The daemon sent a stream this page cannot read.',
};

export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `S17E731`, as the page's title writes an episode. */
export function episodeLabel(e: EpisodeNumber): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `S${pad(e.season)}E${pad(e.episode)}`;
}

/** What the previous or next button could not do, in words. */
export function switchErrorText(to: 'previous' | 'next', code: string): string {
  if (code === 'no_source') return `No provider could stream the ${to} episode.`;
  if (code === 'no_episode') return `There is no ${to} episode.`;
  if (code === 'unknown_session') return 'This stream session has ended; start the episode again from Claude Code or the movies page.';
  return `The ${to} episode could not be started (${code}).`;
}

/** The cache mark's tooltip and accessible name. */
export function cachedLabel(cached: CachedInfo): string {
  const quality = cached.height === null ? '' : ` (${cached.height}p)`;
  return cached.state === 'ready' ? `Playing from this machine's cache${quality}` : `Playing from this machine's cache while it downloads${quality}`;
}

/** Icon only: a drive when the whole film is on disk, a cloud with an arrow while it still downloads. */
function CachedMark({ cached }: { cached: CachedInfo }) {
  const label = cachedLabel(cached);
  return (
    <span className="st-cached" role="img" aria-label={label} title={label} data-state={cached.state}>
      {cached.state === 'ready' ? <HardDrive /> : <CloudArrowDown />}
    </span>
  );
}

/** A download speed the daemon gives in kilobits per second, the way a torrent client writes it: `850 kB/s`, `3.4 MB/s`. */
export function formatSpeed(kbps: number): string {
  const bytesPerS = (Math.max(0, kbps) * 1000) / 8;
  return bytesPerS >= 1_000_000 ? `${(bytesPerS / 1_000_000).toFixed(1)} MB/s` : `${Math.round(bytesPerS / 1000)} kB/s`;
}

/** The torrent mark's tooltip and accessible name. */
export function torrentLabel(t: TorrentView): string {
  if (t.state === 'ready') return `Playing a torrent download from this machine's disk (${t.name})`;
  if (t.state === 'failed') return `The torrent download stopped (${t.name})`;
  if (t.peers === null || t.downKbps === null) return `Playing from a torrent (${t.name}), finding peers`;
  const share = t.progress === null ? '' : `, ${Math.round(t.progress * 100)}% on disk`;
  return `Playing from a torrent (${t.name}): ${t.peers} ${t.peers === 1 ? 'peer' : 'peers'}, ${formatSpeed(t.downKbps)}${share}`;
}

/** Icons and two numbers, no words: a magnet with the peers and the speed while it downloads, a drive once the whole file is on disk. */
function TorrentMark({ torrent }: { torrent: TorrentView }) {
  const label = torrentLabel(torrent);
  return (
    <span className="st-torrent" role="img" aria-label={label} title={label} data-state={torrent.state}>
      {torrent.state === 'ready' ? <HardDrive /> : <Magnet />}
      {torrent.state === 'downloading' && torrent.peers !== null && (
        <span className="st-torrent-stat">
          <UsersThree />
          {torrent.peers}
        </span>
      )}
      {torrent.state === 'downloading' && torrent.downKbps !== null && (
        <span className="st-torrent-stat">
          <ArrowDown />
          {formatSpeed(torrent.downKbps)}
        </span>
      )}
    </span>
  );
}

/** The line over the picture after Wyzie Synced re-timed the subtitle, and how long it stays. */
export const SYNCED_NOTICE = 'Subtitles synced';
export const SYNCED_NOTICE_MS = 4000;

/**
 * The line over the picture about the last ask for another source; a torrent session speaks of torrents. A move the
 * daemon made by itself (`switched`: why) says so. Null: nothing to say.
 */
export function sourceLine(changing: boolean, notice: string | null, torrent: boolean, switched: string | null = null): string | null {
  if (changing) return torrent ? 'Looking for another torrent…' : 'Looking for another source…';
  if (switched !== null) return `Switched to another source: ${switched}`;
  if (notice === null) return null;
  if (notice === NO_OTHER_SOURCE) return torrent ? 'No other torrent' : NO_OTHER_SOURCE;
  return torrent ? `Torrent: ${notice}` : `Source: ${notice}`;
}

export const FETCHING_LABEL = 'Fetching this part from peers';

export function qualityLabel(q: Quality): string {
  if (q.height !== null) return `${q.height}p`;
  if (q.bitrate !== null) return `${Math.round(q.bitrate / 1000)} kbps`;
  return `Level ${q.index + 1}`;
}

/** localStorage, or nothing where the browser refuses it. */
function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** sessionStorage (this tab only, kept across a reload), or nothing where the browser refuses it. */
function tabStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The quiet line over the picture while the page asks the daemon to carry its play on. */
export const RECONNECTING_NOTICE = 'Reconnecting to notesd…';

/** "Subtitle delay +250 ms", as the player says it after G or H. */
export function delayText(ms: number): string {
  return `Subtitle delay ${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)} ms`;
}

function browserDeps(): ControllerDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    createEngine,
    // The address names the session on screen, so a reload plays the episode switched to.
    onSession: (id) => window.history.replaceState(null, '', `/stream/${encodeURIComponent(id)}`),
    textUrl: (vtt) => URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })),
    revokeTextUrl: (url) => URL.revokeObjectURL(url),
    storage: safeStorage(),
    memory: tabStorage(),
  };
}

const NO_SUBSCRIBE = () => () => {};
const initialSnapshot = () => INITIAL_STATE;

function useController(
  sessionId: string | null,
  video: HTMLVideoElement | null,
  deps: Partial<ControllerDeps> | undefined,
  muted: boolean,
): StreamController | null {
  const depsRef = useRef(deps);
  const [controller, setController] = useState<StreamController | null>(null);
  useEffect(() => {
    if (sessionId === null || video === null) return;
    const next = new StreamController(sessionId, video, { ...browserDeps(), ...depsRef.current, muted });
    setController(next);
    void next.start();
    return () => {
      next.dispose();
    };
  }, [sessionId, video, muted]);
  return controller;
}

interface MediaView {
  paused: boolean;
  time: number;
  duration: number;
  muted: boolean;
  /** What the browser holds in memory, in seconds. */
  buffered: TimeRange[];
}

const MEDIA_EVENTS = ['play', 'pause', 'timeupdate', 'seeking', 'durationchange', 'loadedmetadata', 'volumechange', 'progress'] as const;

function bufferedOf(video: HTMLVideoElement): TimeRange[] {
  const out: TimeRange[] = [];
  // jsdom's <video> has no ranges.
  const ranges = video.buffered as TimeRanges | undefined;
  if (ranges === undefined) return out;
  for (let i = 0; i < ranges.length; i++) out.push([ranges.start(i), ranges.end(i)]);
  return out;
}

/**
 * The timeline's thick grey bar as a CSS gradient: every stretch that is loaded (in the browser's
 * memory, or on this machine's disk for a cached play), merged, as percentages of the duration.
 * 'none' when nothing is.
 */
export function loadedGradient(ranges: readonly TimeRange[], duration: number): string {
  if (!(duration > 0)) return 'none';
  const merged: TimeRange[] = [];
  for (const [from, to] of [...ranges].filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    // Half a second apart is one stretch: segments rarely meet to the millisecond.
    if (last !== undefined && from <= last[1] + 0.5) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  if (merged.length === 0) return 'none';
  const pct = (s: number): string => `${Math.round((Math.min(Math.max(s, 0), duration) / duration) * 10000) / 100}%`;
  const stops = merged.flatMap(([a, b]) => [`transparent ${pct(a)}`, `var(--st-loaded) ${pct(a)}`, `var(--st-loaded) ${pct(b)}`, `transparent ${pct(b)}`]);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function useMediaView(video: HTMLVideoElement | null): MediaView {
  const [view, setView] = useState<MediaView>({ paused: true, time: 0, duration: 0, muted: false, buffered: [] });
  useEffect(() => {
    if (video === null) return;
    const read = () =>
      setView({
        paused: video.paused,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        muted: video.muted,
        buffered: bufferedOf(video),
      });
    for (const type of MEDIA_EVENTS) video.addEventListener(type, read);
    read();
    return () => {
      for (const type of MEDIA_EVENTS) video.removeEventListener(type, read);
    };
  }, [video]);
  return view;
}

function useFullscreen(): boolean {
  const [on, setOn] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const read = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', read);
    return () => document.removeEventListener('fullscreenchange', read);
  }, []);
  return on;
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}

function IconButton({
  label,
  onClick,
  expanded,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="st-btn"
      aria-label={label}
      title={label}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface MenuItem {
  key: string;
  text: string;
  checked: boolean;
  onSelect: () => void;
}

function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <div className="st-menu" role="menu" aria-label={label}>
      {items.map((item) => (
        <button key={item.key} type="button" role="menuitemradio" aria-checked={item.checked} onClick={item.onSelect}>
          {item.text}
        </button>
      ))}
    </div>
  );
}

const BUSY_LABELS = { loading: 'Loading', refreshing: 'Reconnecting', recovering: 'Reconnecting after a network error' } as const;

/** The report button's name (its aria-label and title): it has no visible text. */
export function reportLabel(report: BugReportState): string {
  switch (report.status) {
    case 'sending':
      return 'Sending the report';
    case 'opened':
      return 'Report opened in tmux';
    case 'already':
      return 'Already reported';
    case 'saved':
      return 'Open the report again';
    default:
      return 'Report this stream bug';
  }
}

/** The line under the report button once the daemon answered; null before. */
export function reportText(report: BugReportState): string | null {
  switch (report.status) {
    case 'opened':
      return report.window !== '' ? `Report opened in tmux window ${report.window}: ${report.dir}` : `Report opened in tmux: ${report.dir}`;
    case 'already':
      return `Already reported: ${report.dir}`;
    case 'saved':
      return report.reason === 'no_tmux'
        ? `Report saved but not opened, no tmux is running: ${report.dir}`
        : `Report saved but not opened, Claude Code could not be started: ${report.dir}`;
    case 'failed':
      return `The report could not be made (${report.code}).`;
    default:
      return null;
  }
}

function ReportButton({ report, onReport }: { report: BugReportState; onReport: () => void }) {
  const label = reportLabel(report);
  const text = reportText(report);
  const spent = report.status === 'sending' || report.status === 'opened' || report.status === 'already';
  return (
    <div className="st-report">
      <button type="button" className="st-btn" aria-label={label} title={label} disabled={spent} onClick={onReport}>
        {report.status === 'sending' ? <CircleNotch className="st-spin" /> : report.status === 'opened' || report.status === 'already' ? <CheckCircle /> : <Bug />}
      </button>
      {text !== null && (
        <span className="st-report-text" role="status">
          {text}
        </span>
      )}
    </div>
  );
}

function StageOverlay({ state, onReport }: { state: StreamState; onReport?: () => void }) {
  if (state.stage === 'loading' || state.stage === 'refreshing' || state.stage === 'recovering') {
    return (
      <div className="st-center" role="status" aria-label={BUSY_LABELS[state.stage]}>
        <CircleNotch className="st-spin" />
      </div>
    );
  }
  if (state.stage === 'ready' && state.torrent?.fetching === true) {
    return (
      <div className="st-center st-fetching" role="status" aria-label={FETCHING_LABEL}>
        <CircleNotch className="st-spin" />
        <span>{FETCHING_LABEL}</span>
      </div>
    );
  }
  if (state.stage === 'error') {
    const code = state.error ?? 'unknown';
    return (
      <div className="st-center st-error" role="alert">
        <WarningCircle />
        <span>{ERRORS[code] ?? `Playback stopped (${code}).`}</span>
        {onReport !== undefined && <ReportButton report={state.bugReport} onReport={onReport} />}
      </div>
    );
  }
  return null;
}

type MenuName = 'subtitles' | 'quality';

export function StreamApp({ sessionId, muted = false, deps }: { sessionId: string | null; muted?: boolean; deps?: Partial<ControllerDeps> }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const controller = useController(sessionId, video, deps, muted);
  const live = useSyncExternalStore(controller?.subscribe ?? NO_SUBSCRIBE, controller?.getState ?? initialSnapshot);
  const state: StreamState = sessionId === null ? { ...INITIAL_STATE, stage: 'error', error: 'no_session' } : live;
  const view = useMediaView(video);
  const fullscreen = useFullscreen();
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => {
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    };
  }, [wake]);

  useEffect(() => {
    // Never empty, never the address or host: cdp.ps1 (phase 1's `open`) only takes a tab whose
    // title differs from both.
    document.title = state.title.trim() === '' ? 'Stream' : state.title;
  }, [state.title]);
  useEffect(() => {
    window.notesdStream = notesdStreamOf(state, async () => {
      if (muted || controller === null) return false;
      // First, while the caller's user gesture still counts: Chrome gives the screen only then.
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.().catch(() => {});
      return controller.playWithSound();
    });
  }, [state, controller, muted]);

  const togglePlay = useCallback(() => {
    if (video === null) return;
    if (video.paused) void Promise.resolve(video.play()).catch(() => {});
    else video.pause();
  }, [video]);
  const seekBy = useCallback(
    (delta: number) => {
      if (video === null) return;
      const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
      video.currentTime = Math.min(Math.max(0, video.currentTime + delta), end);
    },
    [video],
  );
  const toggleMute = useCallback(() => {
    // ?muted=1 is never unmuted (phase 6's checks).
    if (video !== null && !muted) video.muted = !video.muted;
  }, [video, muted]);
  const fullscreenToggle = useCallback(() => {
    // ?muted=1 never asks for full screen.
    if (!muted) toggleFullscreen();
  }, [muted]);
  const goToEpisode = useCallback(
    (to: 'prev' | 'next') => {
      void controller?.goToEpisode(to);
    },
    [controller],
  );
  const reportBug = useCallback(() => {
    void controller?.reportBug();
  }, [controller]);
  const toggleSubtitles = useCallback(() => {
    if (controller === null) return;
    const s = controller.getState();
    controller.selectSubtitle(s.subtitle !== null ? null : (pickDefaultSubtitle(s.subtitles) ?? s.subtitles[0]?.id ?? null));
  }, [controller]);

  // The delay is shown for a moment after a press, not all the time.
  const [delayShown, setDelayShown] = useState(false);
  const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shiftSubtitles = useCallback(
    (deltaMs: number) => {
      if (controller === null) return;
      controller.shiftSubtitles(deltaMs);
      setDelayShown(true);
      if (delayTimer.current !== null) clearTimeout(delayTimer.current);
      delayTimer.current = setTimeout(() => setDelayShown(false), 2500);
    },
    [controller],
  );
  // `Subtitles synced`, for a moment, each time the daemon replaced the subtitle with a re-timed one.
  const [syncShown, setSyncShown] = useState(false);
  useEffect(() => {
    if (state.subtitleSyncs === 0) return;
    setSyncShown(true);
    const timer = setTimeout(() => setSyncShown(false), SYNCED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.subtitleSyncs]);
  useEffect(
    () => () => {
      if (delayTimer.current !== null) clearTimeout(delayTimer.current);
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === ' ' || key === 'k') togglePlay();
      else if (key === 'arrowleft') seekBy(-SEEK_STEP_S);
      else if (key === 'arrowright') seekBy(SEEK_STEP_S);
      else if (key === 'm') toggleMute();
      else if (key === 'c') toggleSubtitles();
      else if (key === 's' && !e.shiftKey && !e.ctrlKey && !e.metaKey) controller?.anotherSource();
      // G and H, as VLC has them: the subtitles 50 ms earlier, 50 ms later.
      else if (key === 'g' || key === 'h') shiftSubtitles(key === 'h' ? SUBTITLE_DELAY_STEP_MS : -SUBTITLE_DELAY_STEP_MS);
      else if (key === 'f') fullscreenToggle();
      // Shift+N and Shift+P, as other players have them: the next and the previous episode.
      else if (key === 'n' && e.shiftKey) goToEpisode('next');
      else if (key === 'p' && e.shiftKey) goToEpisode('prev');
      else if (key === 'escape') setMenu(null);
      else return;
      e.preventDefault();
      wake();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, toggleMute, toggleSubtitles, shiftSubtitles, fullscreenToggle, goToEpisode, wake, controller]);

  const choose = (action: () => void) => {
    action();
    setMenu(null);
  };
  const hidden = idle && !view.paused && menu === null && (state.stage === 'ready' || state.stage === 'recovering') && state.switching === null;
  // A series' session names a neighbour on at least one side; a film's never does.
  const series = state.prevEpisode !== null || state.nextEpisode !== null;
  const fill = view.duration > 0 ? (Math.min(view.time, view.duration) / view.duration) * 100 : 0;
  const sourceText = sourceLine(state.changingSource, state.sourceNotice, state.torrent !== null, state.switchedWhy);

  return (
    <IconContext.Provider value={ICONS}>
      <div className={hidden ? 'st-stage st-idle' : 'st-stage'} data-stage={state.stage} onMouseMove={wake}>
        <video ref={setVideo} className="st-video" playsInline muted={muted} onClick={togglePlay} onDoubleClick={fullscreenToggle} />
        <div className="st-top">
          <span className="st-title">{state.title}</span>
          {state.cached !== null && <CachedMark cached={state.cached} />}
          {state.torrent !== null && <TorrentMark torrent={state.torrent} />}
          {state.reconnecting && (
            <span className="st-notice" role="status">
              {RECONNECTING_NOTICE}
            </span>
          )}
          {sourceText !== null && (
            <span className="st-notice" role="status">
              {sourceText}
            </span>
          )}
          {syncShown && (
            <span className="st-notice" role="status">
              {SYNCED_NOTICE}
            </span>
          )}
          {delayShown && !syncShown && (
            <span className="st-notice" role="status">
              {delayText(state.subtitleDelayMs)}
            </span>
          )}
          {state.switchError !== null && (
            <span className="st-notice" role="status">
              {switchErrorText(state.switchError.to === 'prev' ? 'previous' : 'next', state.switchError.code)}
            </span>
          )}
        </div>
        {state.caption !== '' && (
          <div className="st-caption" aria-live="off" data-testid="caption">
            {state.caption.split('\n').map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </div>
        )}
        <StageOverlay state={state} onReport={controller !== null && sessionId !== null ? reportBug : undefined} />
        <div className="st-bar">
          <IconButton label={view.paused ? 'Play' : 'Pause'} onClick={togglePlay}>
            {view.paused ? <Play /> : <Pause />}
          </IconButton>
          {series && (
            <IconButton
              label={state.prevEpisode === null ? 'No previous episode' : `Previous episode (${episodeLabel(state.prevEpisode)})`}
              disabled={state.prevEpisode === null || state.switching !== null}
              onClick={() => goToEpisode('prev')}
            >
              {state.switching === 'prev' ? <CircleNotch className="st-spin" /> : <SkipBack />}
            </IconButton>
          )}
          {series && (
            <IconButton
              label={state.nextEpisode === null ? 'No next episode' : `Next episode (${episodeLabel(state.nextEpisode)})`}
              disabled={state.nextEpisode === null || state.switching !== null}
              onClick={() => goToEpisode('next')}
            >
              {state.switching === 'next' ? <CircleNotch className="st-spin" /> : <SkipForward />}
            </IconButton>
          )}
          <IconButton label="Back 10 seconds" onClick={() => seekBy(-SEEK_STEP_S)}>
            <ArrowArcLeft />
          </IconButton>
          <IconButton label="Forward 10 seconds" onClick={() => seekBy(SEEK_STEP_S)}>
            <ArrowArcRight />
          </IconButton>
          <input
            className="st-seek"
            type="range"
            aria-label="Position"
            min={0}
            max={view.duration}
            step={1}
            value={Math.min(view.time, view.duration)}
            onChange={(e) => {
              if (video !== null) video.currentTime = Number(e.currentTarget.value);
            }}
            style={{ ['--st-fill' as string]: `${fill}%`, ['--st-loaded-bar' as string]: loadedGradient([...view.buffered, ...state.cachedRanges], view.duration) } as CSSProperties}
          />
          <span className="st-clock">
            {formatClock(view.time)} / {formatClock(view.duration)}
          </span>
          <IconButton label={view.muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
            {view.muted ? <SpeakerSlash /> : <SpeakerHigh />}
          </IconButton>
          {state.cached === null && !muted && (
            <IconButton label={state.torrent !== null ? 'Another torrent (S)' : 'Another source (S)'} disabled={state.changingSource} onClick={() => controller?.anotherSource()}>
              {state.changingSource ? <CircleNotch className="st-spin" /> : <Shuffle />}
            </IconButton>
          )}
          <div className="st-pop">
            <IconButton label="Subtitles" expanded={menu === 'subtitles'} onClick={() => setMenu(menu === 'subtitles' ? null : 'subtitles')}>
              <ClosedCaptioning weight={state.subtitle !== null ? 'fill' : 'duotone'} />
            </IconButton>
            {menu === 'subtitles' && (
              <Menu
                label="Subtitles"
                items={[
                  { key: 'off', text: 'Off', checked: state.subtitle === null, onSelect: () => choose(() => controller?.selectSubtitle(null)) },
                  ...state.subtitles.map((o) => ({
                    key: o.id,
                    text: o.label,
                    checked: o.id === state.subtitle,
                    onSelect: () => choose(() => controller?.selectSubtitle(o.id)),
                  })),
                ]}
              />
            )}
          </div>
          <div className="st-pop">
            <IconButton label="Quality" expanded={menu === 'quality'} onClick={() => setMenu(menu === 'quality' ? null : 'quality')}>
              <GearSix />
            </IconButton>
            {menu === 'quality' && (
              <Menu
                label="Quality"
                items={[
                  { key: 'auto', text: 'Auto', checked: state.quality === -1, onSelect: () => choose(() => controller?.selectQuality(-1)) },
                  ...state.qualities.map((q) => ({
                    key: String(q.index),
                    text: qualityLabel(q),
                    checked: q.index === state.quality,
                    onSelect: () => choose(() => controller?.selectQuality(q.index)),
                  })),
                ]}
              />
            )}
          </div>
          <IconButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={fullscreenToggle}>
            {fullscreen ? <ArrowsIn /> : <ArrowsOut />}
          </IconButton>
        </div>
      </div>
    </IconContext.Provider>
  );
}
