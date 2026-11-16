import type { AudioTrackRef, ManifestKind } from './session';

export interface Quality {
  /** The engine's own index for this rendition. */
  index: number;
  height: number | null;
  bitrate: number | null;
}

export interface EmbeddedSubtitle {
  index: number;
  label: string;
  lang: string | null;
}

export interface EngineReady {
  qualities: Quality[];
  subtitles: EmbeddedSubtitle[];
}

export interface EngineHandlers {
  /** The manifest is read: its renditions and subtitle tracks are known. */
  onReady(ready: EngineReady): void;
  /**
   * A request through the pass-through came back 401, 403 or 410 with `X-Notesd-Upstream`: the
   * stream host refused the token. The controller refreshes the session.
   */
  onAuthError(status: number): void;
  /**
   * A 401, 403 or 410 without `X-Notesd-Upstream`: notesd itself refused (`unknown_session`,
   * `forbidden_host`). The session is over; a refresh cannot help.
   */
  onSessionOver(status: number): void;
  /**
   * A fatal network error that is not a refusal (hls.js `fragLoadError`, `fragLoadTimeOut`,
   * `levelLoadError`, `manifestLoadError` and kin; a dash.js download error; a plain file's
   * network error). The engine loads again from where the film is after
   * `networkRetryDelayMs(attempt)`; the film stays on the page. `attempt` runs 1..NETWORK_RETRY_LIMIT,
   * and when it is spent the next failure comes as onFatal.
   */
  onRecovering(attempt: number, message: string): void;
  /** A load succeeded after a restart: the play goes on and the attempts start again. */
  onRecovered(): void;
  /** Playback cannot go on for another reason. */
  onFatal(message: string): void;
}

export interface PlayerEngine {
  /** -1 lets the engine choose (auto). */
  setQuality(index: number): void;
  /** null turns the manifest's subtitles off. */
  setEmbeddedSubtitle(index: number | null): void;
  destroy(): void;
}

export interface EngineRequest {
  kind: ManifestKind;
  video: HTMLVideoElement;
  src: string;
  /** Seconds to start at; 0 = the start. */
  startAt: number;
  /** The audio track to play (the title's original language) when the manifest names several; null: the manifest's default. */
  audioTrack?: AudioTrackRef | null;
  /** Seconds of the film to keep loaded ahead of the picture (HLS); BUFFER_AHEAD_S when left out. */
  bufferAheadS?: number;
  handlers: EngineHandlers;
}

/**
 * The index of the wanted audio track among a manifest's: the same language tag, and the same
 * name when both have one. -1 when `wanted` is null or no track fits.
 */
export function audioTrackIndex(tracks: readonly AudioTrackRef[], wanted: AudioTrackRef | null | undefined): number {
  if (wanted === null || wanted === undefined) return -1;
  const sameLang = (t: AudioTrackRef): boolean => (t.lang ?? '').toLowerCase() === (wanted.lang ?? '').toLowerCase();
  const exact = tracks.findIndex((t) => sameLang(t) && (t.label ?? '') === (wanted.label ?? ''));
  if (exact !== -1) return exact;
  return wanted.lang === null ? tracks.findIndex((t) => t.label === wanted.label) : tracks.findIndex(sameLang);
}

export type CreateEngine = (request: EngineRequest) => Promise<PlayerEngine>;

export const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403, 410]);

export function isAuthStatus(status: unknown): status is number {
  return typeof status === 'number' && AUTH_STATUSES.has(status);
}

/** Phase 3's pass-through puts the stream host's status here on every answer it forwarded. */
export const UPSTREAM_HEADER = 'x-notesd-upstream';

/**
 * What a refused answer means: `expired` (the stream host's 401/403/410, forwarded with
 * X-Notesd-Upstream: refresh), `over` (notesd's own 401/403/410 without it: stop), or null (not a refusal).
 */
export function classifyRefusal(status: unknown, upstreamHeader: string | null | undefined): 'expired' | 'over' | null {
  if (!isAuthStatus(status)) return null;
  return upstreamHeader !== null && upstreamHeader !== undefined && upstreamHeader !== '' ? 'expired' : 'over';
}

/** Hands a refusal to the right handler; true when it was one. */
export function reportRefusal(handlers: EngineHandlers, status: unknown, upstreamHeader: string | null | undefined): boolean {
  const kind = classifyRefusal(status, upstreamHeader);
  if (kind === 'expired') handlers.onAuthError(status as number);
  else if (kind === 'over') handlers.onSessionOver(status as number);
  return kind !== null;
}

/** How far ahead of the picture a play keeps the film loaded (R1.8); hls.js held 30 s before. */
export const BUFFER_AHEAD_S = 120;

/**
 * The same under `?muted=1`: the expiry checks (playcheck.mjs, player.steps.mjs J3) need segments
 * that are not loaded yet when the token expires.
 */
export const MUTED_BUFFER_AHEAD_S = 30;

/** Restarts after a fatal network error before the play stops with the error (R1.7). */
export const NETWORK_RETRY_LIMIT = 5;

/** The wait before restart `attempt` (1-based): 2, 4, 8, 16, 16 s. The libraries' own per-request retries come first. */
export function networkRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** (attempt - 1), 16_000);
}

export interface NetworkRecovery {
  /** A fatal network error: the next restart after its wait, or `message` to onFatal once the restarts are spent. */
  fail(message: string): void;
  /** A load succeeded: after a restart, the recovery is over and the count starts again. */
  loaded(): void;
  /** No restart from now on (the engine is destroyed, or its session refused). */
  stop(): void;
}

/**
 * The restart loop all three engines share. `restart` loads again from where the film is; it runs
 * only after the wait and never after stop(). A failure while a restart is waiting is the same
 * failure (several loads fail at once) and is not counted twice.
 */
export function networkRecovery(handlers: EngineHandlers, restart: () => void): NetworkRecovery {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  return {
    fail(message) {
      if (stopped || timer !== null) return;
      if (attempt >= NETWORK_RETRY_LIMIT) {
        stopped = true;
        handlers.onFatal(message);
        return;
      }
      attempt += 1;
      handlers.onRecovering(attempt, message);
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) restart();
      }, networkRetryDelayMs(attempt));
    },
    loaded() {
      if (stopped || timer !== null || attempt === 0) return;
      attempt = 0;
      handlers.onRecovered();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
