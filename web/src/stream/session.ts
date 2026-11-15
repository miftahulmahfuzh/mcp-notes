import { isEnglish } from './subtitles';

export type ManifestKind = 'hls' | 'dash' | 'mp4';

/** A separate subtitle file of the session (phase 3's `source: "request"` tracks). */
export interface SessionSubtitle {
  url: string;
  lang: string | null;
  label: string;
  /** Phase 3's `english` when it sent one, else isEnglish(lang, label). */
  english: boolean;
}

/** What the player needs from GET /api/stream/sessions/:id, checked once in parseSession. */
export interface StreamSession {
  id: string;
  title: string;
  manifestUrl: string;
  manifestKind: ManifestKind;
  subtitles: SessionSubtitle[];
  resumeS: number;
}

/** A failed session call. `code` is the daemon's `error` (`unknown_session`, `no_source`, ...) or one of ours. */
export class SessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'SessionError';
    this.code = code;
    this.status = status;
  }
}

export interface PositionReport {
  position_s: number;
  duration_s: number | null;
  ended: boolean;
}

const KINDS: readonly string[] = ['hls', 'dash', 'mp4'];

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Phase 3's SessionInfo, checked once. A `source: "manifest"` track is inside the manifest (the engine shows it), so it is not a file. */
export function parseSession(json: unknown): StreamSession {
  if (typeof json !== 'object' || json === null) throw new SessionError('bad_session', 0);
  const o = json as Record<string, unknown>;
  const id = text(o.session_id);
  const manifestUrl = text(o.manifest_url);
  const kind = text(o.manifest_kind);
  if (id === null || manifestUrl === null || kind === null || !KINDS.includes(kind)) {
    throw new SessionError('bad_session', 0);
  }
  const subtitles: SessionSubtitle[] = [];
  if (Array.isArray(o.subtitles)) {
    for (const entry of o.subtitles) {
      if (typeof entry !== 'object' || entry === null) continue;
      const s = entry as Record<string, unknown>;
      if (s.source === 'manifest') continue;
      const url = text(s.url);
      if (url === null) continue;
      const lang = text(s.lang);
      const label = text(s.label) ?? lang ?? 'Subtitle';
      subtitles.push({ url, lang, label, english: typeof s.english === 'boolean' ? s.english : isEnglish(lang, label) });
    }
  }
  const resume = o.resume_s;
  return {
    id,
    title: text(o.title) ?? 'Stream',
    manifestUrl,
    manifestKind: kind as ManifestKind,
    subtitles,
    resumeS: typeof resume === 'number' && Number.isFinite(resume) && resume > 0 ? resume : 0,
  };
}

/** `?muted=1`: phase 6's muted check. Muted from the start, never unmuted, never full screen. */
export function mutedFromLocation(loc: Pick<Location, 'search'>): boolean {
  return new URLSearchParams(loc.search).get('muted') === '1';
}

/** The session id from `/stream/<sessionId>`. */
export function sessionIdFromLocation(loc: Pick<Location, 'pathname'>): string | null {
  const m = /^\/stream\/([^/]+)\/?$/.exec(loc.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export const sessionUrl = (id: string): string => `/api/stream/sessions/${encodeURIComponent(id)}`;
export const refreshUrl = (id: string): string => `${sessionUrl(id)}/refresh`;
export const positionUrl = (id: string): string => `${sessionUrl(id)}/position`;

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return body !== null && typeof body.error === 'string' ? body.error : `http_${res.status}`;
}

export async function fetchSession(id: string, fetchImpl: typeof fetch): Promise<StreamSession> {
  let res: Response;
  try {
    res = await fetchImpl(sessionUrl(id), { headers: { accept: 'application/json' } });
  } catch {
    throw new SessionError('network', 0);
  }
  if (!res.ok) throw new SessionError(await errorCode(res), res.status);
  return parseSession(await res.json().catch(() => null));
}

/** Asks the daemon to resolve the session again. Returns the id to read next: the answer's `session_id` when it names one (phase 3 keeps the id). */
export async function refreshSession(id: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(refreshUrl(id), { method: 'POST' });
  } catch {
    throw new SessionError('network', 0);
  }
  if (!res.ok) throw new SessionError(await errorCode(res), res.status);
  const body = (await res.json().catch(() => null)) as { session_id?: unknown } | null;
  return body !== null && typeof body.session_id === 'string' && body.session_id !== '' ? body.session_id : id;
}

/** Fire and forget: a 404 (no movies store yet, or a session it does not know) and every other failure are ignored. */
export async function postPosition(id: string, report: PositionReport, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(positionUrl(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch {
    // ignored: the position is reported again in 5 s
  }
}

export async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}
