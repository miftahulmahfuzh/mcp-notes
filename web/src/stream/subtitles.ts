export interface SubtitleOption {
  /** `manifest-<index>` or `file-<index>`: a stable key for menus and state. */
  id: string;
  /** A track inside the manifest (the engine shows it) or a separate file from the resolve (a <track>). */
  source: 'manifest' | 'file';
  index: number;
  label: string;
  lang: string | null;
  english: boolean;
}

const ENGLISH_LANG = /^(en|eng)(?:[-_].*)?$/i;

export function isEnglish(lang: string | null, label: string | null): boolean {
  if (lang !== null && ENGLISH_LANG.test(lang.trim())) return true;
  return label !== null && /\benglish\b/i.test(label);
}

/** A label that says nothing about the language ("", "Subtitle", "Track 1"; parseSession names an unlabelled file "Subtitle"). */
const NO_NAME = /^(subtitles?|captions?|cc|default|unknown|und|track ?\d*)?$/i;

/** True for a track that names no language at all: no language tag and a label that is empty or generic. */
export function isUnnamed(option: Pick<SubtitleOption, 'lang' | 'label'>): boolean {
  return (option.lang === null || option.lang.trim() === '' || /^und$/i.test(option.lang.trim())) && NO_NAME.test(option.label.trim());
}

/**
 * English on by default: the first English track inside the manifest, else the first English file.
 * Without one, a source's only subtitle is shown when it names no language: a provider that hands
 * out one unnamed file means it for the viewer (Fake Profile S02E01 on VidLink). A track that
 * names another language, or several tracks none of which is English, stay off.
 */
export function pickDefaultSubtitle(options: readonly SubtitleOption[]): string | null {
  const english = options.filter((o) => o.english);
  const chosen = english.find((o) => o.source === 'manifest') ?? english[0];
  if (chosen) return chosen.id;
  const [only] = options;
  return options.length === 1 && only !== undefined && isUnnamed(only) ? only.id : null;
}

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

/** WebVTT from an SRT or WebVTT file. WebVTT comes back as it came (BOM and CR removed). */
export function toWebVtt(input: string): string {
  const clean = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(clean)) return clean;
  const body = clean
    .split('\n')
    .map((line) =>
      line.includes('-->')
        ? line.replace(SRT_TIME, (_all: string, h: string, m: string, s: string, ms: string) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`)
        : line,
    )
    .join('\n');
  return `WEBVTT\n\n${body.trim()}\n`;
}

/** One cue of a growing subtitle, as GET /api/stream/torrent/:hash/cues/:track answers it. */
export interface FeedCue {
  start_s: number;
  end_s: number;
  text: string;
}

/** One answer of a cue feed. */
export interface CueFeedPage {
  cues: FeedCue[];
  next: number;
  complete: boolean;
}

/** How often a growing subtitle is read again while it is not complete. */
export const CUE_FEED_POLL_MS = 4_000;

/** A feed answer, checked once; null when it is not one. A cue without text or length is left out. */
export function parseCueFeed(json: unknown): CueFeedPage | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.cues) || typeof o.next !== 'number' || !Number.isInteger(o.next) || o.next < 0 || typeof o.complete !== 'boolean') return null;
  const cues: FeedCue[] = [];
  for (const entry of o.cues) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { start_s: start, end_s: end, text } = entry as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    cues.push({ start_s: start, end_s: end, text });
  }
  return { cues, next: o.next, complete: o.complete };
}

export interface CueFeedFollower {
  stop(): void;
}

export interface FollowCueFeedDeps {
  fetch: typeof fetch;
  /** Each cue, as it arrives. */
  add: (cue: FeedCue) => void;
  /** A read failed: said once per run of failures. A 404 (no such feed on this machine) ends the following. */
  onError?: (message: string) => void;
  /** The feed is complete: `count` cues in all. */
  onComplete?: (count: number) => void;
  pollMs?: number;
}

/**
 * Reads a growing subtitle from the start, adds each cue, and reads it again every `pollMs` from
 * where it stopped until the feed says it is complete. A failed read is tried again at the next
 * poll; a 404 stops.
 */
export function followCueFeed(url: string, deps: FollowCueFeedDeps): CueFeedFollower {
  const fetchImpl = deps.fetch;
  const pollMs = deps.pollMs ?? CUE_FEED_POLL_MS;
  let next = 0;
  let stopped = false;
  let failing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fail = (message: string): void => {
    if (!failing) deps.onError?.(message);
    failing = true;
  };
  const later = (): void => {
    if (!stopped) timer = setTimeout(() => void read(), pollMs);
  };
  const read = async (): Promise<void> => {
    timer = null;
    let page: CueFeedPage | null = null;
    try {
      const res = await fetchImpl(`${url}${url.includes('?') ? '&' : '?'}after=${next}`, { cache: 'no-store' });
      if (res.status === 404) {
        if (!stopped) deps.onError?.('http_404');
        stopped = true;
        return;
      }
      page = res.ok ? parseCueFeed(await res.json()) : null;
      if (page === null) fail(res.ok ? 'not a cue feed' : `http_${res.status}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (stopped) return;
    if (page === null) {
      later();
      return;
    }
    failing = false;
    for (const cue of page.cues) deps.add(cue);
    next = Math.max(next, page.next);
    if (page.complete) {
      stopped = true;
      deps.onComplete?.(next);
      return;
    }
    later();
  };
  void read();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Adds a feed's cue to a text track as a browser cue. Without VTTCue (not a browser) nothing is added. */
export function addFeedCue(track: Pick<TextTrack, 'addCue'>, cue: FeedCue): void {
  const Cue = (globalThis as { VTTCue?: new (start: number, end: number, text: string) => TextTrackCue }).VTTCue;
  if (Cue === undefined) return;
  track.addCue(new Cue(cue.start_s, cue.end_s, cue.text));
}
