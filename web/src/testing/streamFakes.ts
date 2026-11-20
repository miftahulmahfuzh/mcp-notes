import { vi, type Mock } from 'vitest';
import type { CreateEngine, EngineRequest, PlayerEngine } from '../stream/engine';
import type { SheetSize } from '../stream/previews';

export interface FakeEngine extends PlayerEngine {
  req: EngineRequest;
  setQuality: Mock<(index: number) => void>;
  setEmbeddedSubtitle: Mock<(index: number | null) => void>;
  destroy: Mock<() => void>;
}

/** A CreateEngine that records each engine the page asked for; tests drive its handlers. */
export function fakeEngines(): { made: FakeEngine[]; createEngine: CreateEngine } {
  const made: FakeEngine[] = [];
  const createEngine: CreateEngine = async (req) => {
    const engine: FakeEngine = {
      req,
      setQuality: vi.fn<(index: number) => void>(),
      setEmbeddedSubtitle: vi.fn<(index: number | null) => void>(),
      destroy: vi.fn<() => void>(),
    };
    made.push(engine);
    return engine;
  };
  return { made, createEngine };
}

export interface FakeMedia {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
}

/** A real <video> whose media fields the test sets (jsdom plays nothing). */
export function fakeVideo(init: Partial<FakeMedia> = {}) {
  const video = document.createElement('video');
  const media: FakeMedia = { currentTime: 0, duration: Number.NaN, paused: true, ended: false, muted: false, ...init };
  for (const key of Object.keys(media) as (keyof FakeMedia)[]) {
    Object.defineProperty(video, key, {
      configurable: true,
      get: () => media[key],
      set: (value: never) => {
        media[key] = value;
      },
    });
  }
  const play = vi.fn(async () => {
    media.paused = false;
  });
  video.play = play;
  const fire = (type: string) => {
    video.dispatchEvent(new Event(type));
  };
  return { video, media, play, fire };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

/** A fetch answered by `"<METHOD> <url>"` routes; anything else is a 404 `not_found`. */
export function routeFetch(routes: Record<string, (call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call = { method, url, body };
    calls.push(call);
    const route = routes[`${method} ${url}`];
    return route ? route(call) : jsonResponse({ error: 'not_found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** GET /api/stream/sessions/S1 as phase 3 answers it (its SessionInfo; see phase 4's interface contract). */
export function streamSessionJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'S1',
    kind: 'movie',
    tmdb_id: 550,
    season: null,
    episode: null,
    title: 'Fight Club (1999)',
    provider: 'VidFast',
    manifest_kind: 'hls',
    manifest_url: '/api/stream/sessions/S1/p?u=m1',
    subtitles: [],
    best_height: 1080,
    resume_s: 0,
    created_at: '2026-11-15T12:00:00.000Z',
    refreshed_at: '2026-11-15T12:00:00.000Z',
    expires_at: '2026-11-15T16:00:00.000Z',
    ...over,
  };
}

/** One subtitle track of a SessionInfo: a separate file (`source: "request"`) unless said otherwise. */
export function sessionTrack(url: string, lang: string | null, label: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { url, lang, label, format: 'vtt', source: 'request', english: lang === 'en', ...over };
}

/** GET /api/stream/sessions/:id/previews as the plan set's interface contract answers it. */
export function previewsJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: 'partial', rev: 0, source: 'local', cues: [], ...over };
}

/** One cue of that answer: frame `index` of a sheet of 6 × 6 frames of 240 × 135 px, standing for the 10 s from `startS`. */
export function previewCueJson(url: string, startS: number, index: number): Record<string, unknown> {
  return { start_s: startS, end_s: startS + 10, url, x: (index % 6) * 240, y: Math.floor(index / 6) * 135, w: 240, h: 135 };
}

export interface FakeSheets {
  /** The page's LoadSheet: each call waits until the test answers it. */
  load: Mock<(url: string) => Promise<SheetSize>>;
  /** Answers the pending load of `url` with the picture's size, or as a picture that did not load (a 404, bytes that do not decode). */
  answer: (url: string, size: SheetSize | 'fail') => void;
}

export function fakeSheets(): FakeSheets {
  const pending = new Map<string, { resolve: (size: SheetSize) => void; reject: (err: Error) => void }>();
  const load = vi.fn<(url: string) => Promise<SheetSize>>(
    (url) =>
      new Promise<SheetSize>((resolve, reject) => {
        pending.set(url, { resolve, reject });
      }),
  );
  return {
    load,
    answer: (url, size) => {
      const waiting = pending.get(url);
      if (waiting === undefined) throw new Error(`no load of ${url} is pending`);
      pending.delete(url);
      if (size === 'fail') waiting.reject(new Error('sheet_failed'));
      else waiting.resolve(size);
    },
  };
}
