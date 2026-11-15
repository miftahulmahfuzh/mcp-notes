import { STREAM_HEALTH_OUTCOMES, STREAM_MANIFEST_KINDS, type StreamManifestKind } from '../db/schema.js';

/**
 * The shapes direct streaming passes around (DIRECT_STREAMING_PLAN phase 3). They are validated once
 * where they enter: the routes (src/http/directStreamApi.ts), the tools (phase 7) and the resolver's
 * printed answer (runner.ts). Everything inside trusts them. Data that comes from or goes back out as
 * JSON (attempts, the source) keeps the resolver's snake_case names.
 */

/** What is streamed: one film, or one episode of a series. A film never carries a season or episode. */
export type StreamRef =
  | { kind: 'movie'; tmdbId: number }
  | { kind: 'tv'; tmdbId: number; season: number; episode: number };

/** What a caller may hand the service (phase 7's StreamTarget fits). `toStreamRef` makes it a StreamRef. */
export interface StreamRefInput {
  kind: 'movie' | 'tv';
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
}

/** The one place a loose target becomes a StreamRef. Callers validate first; a series without an episode is a programming error. */
export function toStreamRef(input: StreamRefInput): StreamRef {
  if (input.kind === 'movie') return { kind: 'movie', tmdbId: input.tmdbId };
  if (input.season === undefined || input.season === null || input.episode === undefined || input.episode === null) {
    throw new RangeError(`a series needs a season and an episode (tv ${input.tmdbId})`);
  }
  return { kind: 'tv', tmdbId: input.tmdbId, season: input.season, episode: input.episode };
}

/**
 * How one provider's try ended, as claude/streaming/direct/cli.mjs reports it. The two skips are not
 * health, and neither is `dubbed` (a stream was found, in another language than the title's
 * original): it is about the title, not the provider.
 */
export const RESOLVE_OUTCOMES = [...STREAM_HEALTH_OUTCOMES, 'dubbed', 'skipped_browser_only', 'skipped_no_template'] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number];

export const MANIFEST_KINDS = STREAM_MANIFEST_KINDS;
export type ManifestKind = StreamManifestKind;

export interface ResolveAttempt {
  provider: string;
  outcome: ResolveOutcome;
  took_s: number | null;
  detail: string;
}

/** The request headers the real Chrome's manifest request carried. Null: that header was not sent. */
export interface CapturedHeaders {
  referer: string | null;
  origin: string | null;
  user_agent: string | null;
}

export interface SubtitleTrack {
  /** Absolute http(s) address on the stream host. */
  url: string;
  lang: string | null;
  label: string;
  /** `vtt`, `srt`, `hls`, `ttml`, `dash` (lower case). */
  format: string;
  /** `request`: a separate subtitle request; `manifest`: a track inside the manifest. */
  source: 'request' | 'manifest';
}

/** What a resolved stream speaks, as the resolver's audio probe read it (claude/streaming/direct/audio.mjs). */
export interface SourceAudio {
  /** Normalized codes ("ko"); empty when nothing names the language. */
  languages: string[];
  /** Audio tracks the manifest names; 0: one muxed audio. */
  tracks: number;
  /** One of `languages` is the title's original; null: unknown. Never false: a dub is not a source. */
  original: boolean | null;
  /** The manifest's audio track in the original language, as the manifest writes it; null: none named (one muxed audio). */
  track: { lang: string | null; label: string | null } | null;
}

/** The resolver's `source`, normalized. */
export interface ResolvedSource {
  provider: string;
  embed_url: string;
  manifest_url: string;
  manifest_kind: ManifestKind;
  headers: CapturedHeaders;
  subtitles: SubtitleTrack[];
  best_height: number | null;
  en_subtitle: boolean;
  /** Absent or null when the resolve was not told the title's original language. */
  audio?: SourceAudio | null;
  took_s: number | null;
}

/** One resolve's answer. `error` on failure: `no_source`, or why the resolve could not run. */
export type ResolveOutput =
  | { ok: true; source: ResolvedSource; attempts: ResolveAttempt[] }
  | { ok: false; source: null; error: string; detail: string; attempts: ResolveAttempt[] };

export type ResolvedOutput = Extract<ResolveOutput, { ok: true }>;

export type DirectStreamErrorCode = 'no_source' | 'resolve_failed' | 'open_failed' | 'unknown_session';

export interface DirectStreamErrorExtra {
  reason?: string;
  attempts?: ResolveAttempt[];
  sessionId?: string;
  pageUrl?: string;
}

/** A failure the routes and tools answer by name (src/http/directStreamApi.ts maps it to HTTP). */
export class DirectStreamError extends Error {
  override name = 'DirectStreamError';
  /** `resolve_failed` / `open_failed`: no_chrome, chrome_not_reachable, unknown_provider, script_failed, bad_output, ... */
  readonly reason: string | null;
  /** Every provider's outcome, as the resolver printed them. */
  readonly attempts: ResolveAttempt[];
  readonly sessionId: string | null;
  readonly pageUrl: string | null;

  constructor(
    readonly code: DirectStreamErrorCode,
    message: string,
    extra: DirectStreamErrorExtra = {},
  ) {
    super(message);
    this.reason = extra.reason ?? null;
    this.attempts = extra.attempts ?? [];
    this.sessionId = extra.sessionId ?? null;
    this.pageUrl = extra.pageUrl ?? null;
  }
}

/** True for an English track: a language tag `en`, `eng`, `en-US`..., or a label naming English. */
export function isEnglish(track: { lang: string | null; label: string }): boolean {
  return /^(en|eng)(?:[-_]|$)/i.test((track.lang ?? '').trim()) || /\benglish\b/i.test(track.label);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `TMDB movie 550`, `TMDB tv 1399 S01E02`: the label when no title hook names it better. */
export function refLabel(ref: StreamRef): string {
  return ref.kind === 'movie' ? `TMDB movie ${ref.tmdbId}` : `TMDB tv ${ref.tmdbId} S${pad(ref.season)}E${pad(ref.episode)}`;
}
