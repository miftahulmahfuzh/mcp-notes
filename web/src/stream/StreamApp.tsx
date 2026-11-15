import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowArcLeft,
  ArrowArcRight,
  ArrowsIn,
  ArrowsOut,
  CircleNotch,
  ClosedCaptioning,
  GearSix,
  IconContext,
  Pause,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  WarningCircle,
} from '@phosphor-icons/react';
import { INITIAL_STATE, StreamController, type ControllerDeps, type StreamState } from './controller';
import { createEngine } from './createEngine';
import type { Quality } from './engine';
import { pickDefaultSubtitle } from './subtitles';

/**
 * window.notesdStream: the player's state for scripts (phase 6's playcheck reads `kind`, `levels`,
 * `level`, `errors`, `refreshes` beside the <video>), and `start()`, which phase 1's
 * `open --fullscreen` evaluates as a user gesture so the film starts with sound.
 */
export interface NotesdStream extends StreamState {
  /** The heights offered, highest first. */
  levels: number[];
  /** The chosen quality's engine index; -1 for auto. */
  level: number;
  /** Unmute and play once ready; false (and nothing done) under ?muted=1. */
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

export function qualityLabel(q: Quality): string {
  if (q.height !== null) return `${q.height}p`;
  if (q.bitrate !== null) return `${Math.round(q.bitrate / 1000)} kbps`;
  return `Level ${q.index + 1}`;
}

function browserDeps(): ControllerDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    createEngine,
    textUrl: (vtt) => URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })),
    revokeTextUrl: (url) => URL.revokeObjectURL(url),
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
}

const MEDIA_EVENTS = ['play', 'pause', 'timeupdate', 'seeking', 'durationchange', 'loadedmetadata', 'volumechange'] as const;

function useMediaView(video: HTMLVideoElement | null): MediaView {
  const [view, setView] = useState<MediaView>({ paused: true, time: 0, duration: 0, muted: false });
  useEffect(() => {
    if (video === null) return;
    const read = () =>
      setView({
        paused: video.paused,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        muted: video.muted,
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
  children,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
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

function StageOverlay({ state }: { state: StreamState }) {
  if (state.stage === 'loading' || state.stage === 'refreshing') {
    return (
      <div className="st-center" role="status" aria-label={state.stage === 'refreshing' ? 'Reconnecting' : 'Loading'}>
        <CircleNotch className="st-spin" />
      </div>
    );
  }
  if (state.stage === 'error') {
    const code = state.error ?? 'unknown';
    return (
      <div className="st-center st-error" role="alert">
        <WarningCircle />
        <span>{ERRORS[code] ?? `Playback stopped (${code}).`}</span>
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
    window.notesdStream = notesdStreamOf(state, () => controller?.playWithSound() ?? Promise.resolve(false));
  }, [state, controller]);

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
  const toggleSubtitles = useCallback(() => {
    if (controller === null) return;
    const s = controller.getState();
    controller.selectSubtitle(s.subtitle !== null ? null : (pickDefaultSubtitle(s.subtitles) ?? s.subtitles[0]?.id ?? null));
  }, [controller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === ' ' || key === 'k') togglePlay();
      else if (key === 'arrowleft') seekBy(-SEEK_STEP_S);
      else if (key === 'arrowright') seekBy(SEEK_STEP_S);
      else if (key === 'm') toggleMute();
      else if (key === 'c') toggleSubtitles();
      else if (key === 'f') fullscreenToggle();
      else if (key === 'escape') setMenu(null);
      else return;
      e.preventDefault();
      wake();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, toggleMute, toggleSubtitles, fullscreenToggle, wake]);

  const choose = (action: () => void) => {
    action();
    setMenu(null);
  };
  const hidden = idle && !view.paused && menu === null && state.stage === 'ready';
  const fill = view.duration > 0 ? (Math.min(view.time, view.duration) / view.duration) * 100 : 0;

  return (
    <IconContext.Provider value={ICONS}>
      <div className={hidden ? 'st-stage st-idle' : 'st-stage'} data-stage={state.stage} onMouseMove={wake}>
        <video ref={setVideo} className="st-video" playsInline muted={muted} onClick={togglePlay} onDoubleClick={fullscreenToggle} />
        <div className="st-top">
          <span className="st-title">{state.title}</span>
        </div>
        <StageOverlay state={state} />
        <div className="st-bar">
          <IconButton label={view.paused ? 'Play' : 'Pause'} onClick={togglePlay}>
            {view.paused ? <Play /> : <Pause />}
          </IconButton>
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
            style={{ ['--st-fill' as string]: `${fill}%` } as CSSProperties}
          />
          <span className="st-clock">
            {formatClock(view.time)} / {formatClock(view.duration)}
          </span>
          <IconButton label={view.muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
            {view.muted ? <SpeakerSlash /> : <SpeakerHigh />}
          </IconButton>
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
