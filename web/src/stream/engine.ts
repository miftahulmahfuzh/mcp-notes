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
