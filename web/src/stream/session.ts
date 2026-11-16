import { isEnglish } from './subtitles';

export type ManifestKind = 'hls' | 'dash' | 'mp4';

/** A separate subtitle file of the session (phase 3's `source: "request"` tracks). */
export interface SessionSubtitle {
  url: string;
  lang: string | null;
  label: string;
  /** Phase 3's `english` when it sent one, else isEnglish(lang, label). */
  english: boolean;
  /** A cue feed: `url` answers JSON cues after an index (subtitles.ts followCueFeed), read until complete. Absent: a WebVTT or SRT file. */
  growing?: true;
}

/** What the player needs from GET /api/stream/sessions/:id, checked once in parseSession. */
export interface StreamSession {
  id: string;
  title: string;
  manifestUrl: string;
  manifestKind: ManifestKind;
  subtitles: SessionSubtitle[];
  resumeS: number;
  /** The manifest's audio track in the title's original language (`audio.track`): the engine selects it. Null: none named. */
  audioTrack: AudioTrackRef | null;
  /** A series: the episodes before and after this one; null where there is none (always null for a film). */
  prevEpisode: EpisodeNumber | null;
  nextEpisode: EpisodeNumber | null;
  /** Played from this machine's stream cache; null: through the pass-through. */
  cached: CachedInfo | null;
  /** Played from a torrent on this machine (torrent-stream-source phase 3); null: not a torrent. Never set together with `cached`. */
  torrent: TorrentInfo | null;
}

export interface EpisodeNumber {
  season: number;
  episode: number;
}

/** A cache's state as a session names it (phase 6): the page plays this machine's local copy. */
export type CachedState = 'downloading' | 'ready';

/** SessionInfo.cached: the stream cache on this machine the session plays from. */
export interface CachedInfo {
  id: string;
  state: CachedState;
  height: number | null;
}

/** A torrent download's state, as the session and GET /api/stream/torrent/:hash name it. */
export type TorrentState = 'downloading' | 'ready' | 'failed';

/** SessionInfo.torrent: the torrent the session plays (torrent-stream-source phase 3). */
export interface TorrentInfo {
  /** 40 lower-case hex characters. */
  infoHash: string;
  /** The release name. */
  name: string;
  /** The index that listed it (`Torrentio`, `apibay`); null when the session names none. */
  index: string | null;
  /** The seeds the index counted; null when unknown. */
  seeds: number | null;
  state: TorrentState;
}

/** An audio track as the manifest writes it. */
export interface AudioTrackRef {
  lang: string | null;
  label: string | null;
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
  /** The film is paused: the Movies page shows "paused" on its poster. */
  paused: boolean;
  /** Sent only to say the paused page is still open; the position did not move. */
  beat?: boolean;
  /** The page is closing: its last report. */
  closed?: boolean;
}

const KINDS: readonly string[] = ['hls', 'dash', 'mp4'];

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function cachedInfo(value: unknown): CachedInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, state, height } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || (state !== 'downloading' && state !== 'ready')) return null;
  return { id, state, height: typeof height === 'number' && Number.isInteger(height) && height > 0 ? height : null };
}

const INFO_HASH = /^[0-9a-f]{40}$/i;

/** Any other word is a download still going: a torrent the page cannot name is still a torrent. */
function torrentState(value: unknown): TorrentState {
  return value === 'ready' || value === 'failed' ? value : 'downloading';
}

/** A count the daemon sent (peers, seeds); null when it is not one. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function torrentInfo(value: unknown): TorrentInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { info_hash, name, index, state, seeds } = value as Record<string, unknown>;
  if (typeof info_hash !== 'string' || !INFO_HASH.test(info_hash)) return null;
  const infoHash = info_hash.toLowerCase();
  return { infoHash, name: text(name) ?? infoHash, index: text(index), seeds: count(seeds), state: torrentState(state) };
}

function episodeNumber(value: unknown): EpisodeNumber | null {
  if (typeof value !== 'object' || value === null) return null;
  const { season, episode } = value as Record<string, unknown>;
  return typeof season === 'number' && Number.isInteger(season) && typeof episode === 'number' && Number.isInteger(episode) ? { season, episode } : null;
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
      subtitles.push({ url, lang, label, english: typeof s.english === 'boolean' ? s.english : isEnglish(lang, label), ...(s.growing === true ? { growing: true as const } : {}) });
    }
  }
  const resume = o.resume_s;
  const named = (o.audio as { track?: unknown } | null | undefined)?.track;
  const track = typeof named === 'object' && named !== null ? (named as Record<string, unknown>) : null;
  // A session plays either this machine's stream cache or a torrent, never both.
  const torrent = torrentInfo(o.torrent);
  return {
    id,
    title: text(o.title) ?? 'Stream',
    manifestUrl,
    manifestKind: kind as ManifestKind,
    subtitles,
    resumeS: typeof resume === 'number' && Number.isFinite(resume) && resume > 0 ? resume : 0,
    audioTrack: track === null || (text(track.lang) === null && text(track.label) === null) ? null : { lang: text(track.lang), label: text(track.label) },
    prevEpisode: episodeNumber(o.prev_episode),
    nextEpisode: episodeNumber(o.next_episode),
    cached: torrent === null ? cachedInfo(o.cached) : null,
    torrent,
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
export const sourceUrl = (id: string): string => `${sessionUrl(id)}/source`;
export const sessionCacheUrl = (id: string): string => `${sessionUrl(id)}/cache`;
export const cacheMapUrl = (cacheId: string): string => `/api/stream/cache/${encodeURIComponent(cacheId)}/map`;
export const torrentUrl = (infoHash: string): string => `/api/stream/torrent/${encodeURIComponent(infoHash)}`;
export const torrentMapUrl = (infoHash: string): string => `${torrentUrl(infoHash)}/map`;
export const episodeUrl = (id: string): string => `${sessionUrl(id)}/episode`;
export const eventsUrl = (id: string): string => `${sessionUrl(id)}/events`;
export const reportUrl = (id: string): string => `${sessionUrl(id)}/report`;

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

/** Where the download of a paused play's cache stands (POST /api/stream/sessions/:id/cache). */
export interface CacheStanding {
  id: string;
  state: 'downloading' | 'ready' | 'failed';
  error: string | null;
  /** 0 to 1. */
  progress: number;
}

export interface CacheSessionAnswer {
  /** This call moved the session onto the cache: the page loads `session` again. */
  moved: boolean;
  /** Null: this daemon caches nothing. */
  cache: CacheStanding | null;
  session: StreamSession;
}

/**
 * Asks the daemon to cache the session's title on this machine (`start`), or only where that
 * stands, and to move the session onto the cache once it can be played. Throws SessionError.
 */
export async function cacheSession(id: string, start: boolean, fetchImpl: typeof fetch): Promise<CacheSessionAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(sessionCacheUrl(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start }) });
  } catch {
    throw new SessionError('network', 0);
  }
  if (!res.ok) throw new SessionError(await errorCode(res), res.status);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const session = parseSession(body);
  const c = typeof body?.cache === 'object' && body.cache !== null ? (body.cache as Record<string, unknown>) : null;
  const state = c?.state;
  const cache: CacheStanding | null =
    c !== null && typeof c.id === 'string' && (state === 'downloading' || state === 'ready' || state === 'failed')
      ? { id: c.id, state, error: typeof c.error === 'string' ? c.error : null, progress: typeof c.progress === 'number' ? c.progress : 0 }
      : null;
  return { moved: body?.moved === true, cache, session };
}

/** A stretch of the title, in seconds: [from, to]. */
export type TimeRange = [number, number];

/** A map of what is on this machine's disk: its stretches in seconds, and the duration they were counted against (null: not said). */
export interface DiskMap {
  durationS: number | null;
  ranges: TimeRange[];
}

/** GET a `{ duration_s, ranges }` map (a cache's, a torrent's); null when the daemon cannot say. Never throws. */
async function fetchDiskMap(url: string, fetchImpl: typeof fetch): Promise<DiskMap | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { duration_s?: unknown; ranges?: unknown } | null;
    if (body === null || !Array.isArray(body.ranges)) return null;
    const duration = body.duration_s;
    return {
      durationS: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
      ranges: body.ranges.flatMap((r): TimeRange[] =>
        Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number' && r[1] > r[0] && r[0] >= 0 ? [[r[0], r[1]]] : [],
      ),
    };
  } catch {
    return null;
  }
}

/** The stretches of a cache that are on this machine's disk; [] when the daemon cannot say. Never throws. */
export async function fetchCacheMap(cacheId: string, fetchImpl: typeof fetch): Promise<TimeRange[]> {
  return (await fetchDiskMap(cacheMapUrl(cacheId), fetchImpl))?.ranges ?? [];
}

/** The stretches of a torrent's file on this machine's disk (GET /api/stream/torrent/:hash/map); null when the daemon cannot say. Never throws. */
export function fetchTorrentMap(infoHash: string, fetchImpl: typeof fetch): Promise<DiskMap | null> {
  return fetchDiskMap(torrentMapUrl(infoHash), fetchImpl);
}

/** GET /api/stream/torrent/:hash as the page uses it: where the download stands and its live numbers. */
export interface TorrentStatus {
  state: TorrentState;
  /** Peers connected now; null when the daemon does not say. */
  peers: number | null;
  /** Download speed in kilobits per second (bytes × 8 / ms, as the stream evidence log counts `kbps`); null when not said. */
  downKbps: number | null;
  /** 0 to 1 of the chosen file on disk; null when not said. */
  progress: number | null;
}

/** Where a torrent's download stands; null when the daemon cannot say (a 404, a network failure). Never throws. */
export async function fetchTorrentStatus(infoHash: string, fetchImpl: typeof fetch): Promise<TorrentStatus | null> {
  try {
    const res = await fetchImpl(torrentUrl(infoHash), { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object') return null;
    const down = body.down_kbps;
    const progress = body.progress;
    return {
      state: torrentState(body.state),
      peers: count(body.peers),
      downKbps: typeof down === 'number' && Number.isFinite(down) && down >= 0 ? down : null,
      progress: typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null,
    };
  } catch {
    return null;
  }
}

/** POST /api/stream/sessions/:id/source: the session as it is now, and whether it moved to another provider. */
export interface SourceSwitch {
  switched: boolean;
  /** Why not: `cached`, `no_other_source`. */
  reason: string | null;
  from: string | null;
  provider: string | null;
  session: StreamSession;
}

/**
 * Asks the daemon for another provider of the session's title (the film keeps stalling). It
 * resolves without the provider on screen, which takes seconds, like a play. Throws SessionError
 * with the daemon's code (`unknown_session`, ...).
 */
export async function switchSource(id: string, fetchImpl: typeof fetch): Promise<SourceSwitch> {
  let res: Response;
  try {
    res = await fetchImpl(sourceUrl(id), { method: 'POST' });
  } catch {
    throw new SessionError('network', 0);
  }
  if (!res.ok) throw new SessionError(await errorCode(res), res.status);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const session = parseSession(body);
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return { switched: body?.switched === true, reason: text(body?.reason), from: text(body?.from), provider: text(body?.provider), session };
}

/**
 * Asks the daemon for the episode before or after the session's. It resolves that episode (seconds,
 * like a play) and answers a new session; returns its id. Throws SessionError with the daemon's
 * code (`no_episode`, `no_source`, `resolve_failed`, `unknown_session`).
 */
export async function switchEpisode(id: string, to: 'prev' | 'next', fetchImpl: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(episodeUrl(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }) });
  } catch {
    throw new SessionError('network', 0);
  }
  if (!res.ok) throw new SessionError(await errorCode(res), res.status);
  const body = (await res.json().catch(() => null)) as { session_id?: unknown } | null;
  if (body === null || typeof body.session_id !== 'string' || body.session_id === '') throw new SessionError('bad_session', 0);
  return body.session_id;
}

/**
 * Fire and forget: a 404 (no movies store yet, or a session it does not know) and every other failure are ignored.
 * A closing page's report is sent `keepalive`, so it outlives the page.
 */
export async function postPosition(id: string, report: PositionReport, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(positionUrl(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      ...(report.closed === true ? { keepalive: true } : {}),
    });
  } catch {
    // ignored: the position is reported again in 5 s
  }
}

/** One line of the page's log as it goes to the daemon's stream evidence log (POST /api/stream/sessions/:id/events). */
export interface PlayerLogLine {
  text: string;
  /** When the page wrote it (ISO 8601). */
  at: string;
  stage: string;
  /** The film's position then, in seconds; null when unknown. */
  position_s: number | null;
  /** Seconds buffered ahead of the position then; null when the browser cannot say. */
  buffer_s: number | null;
}

/**
 * Fire and forget, like postPosition: the daemon appends the lines to this machine's stream evidence
 * log. Every failure is ignored; the play never waits on it. Sent `keepalive`, so the lines of a page
 * that is closing still arrive.
 */
export async function postEvents(id: string, lines: readonly PlayerLogLine[], fetchImpl: typeof fetch): Promise<void> {
  if (lines.length === 0) return;
  try {
    await fetchImpl(eventsUrl(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines }),
      keepalive: true,
    });
  } catch {
    // ignored: evidence must never disturb the play
  }
}

export async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}

/** What the page sends with a report: its own view of the failure (the daemon may no longer know the session). */
export interface PageReport {
  stage: string;
  error: string | null;
  errors: string[];
  log: string[];
  title: string;
  position_s: number | null;
}

/** The daemon's answer to a report, as the page shows it. */
export type ReportAnswer =
  | { status: 'opened'; dir: string; window: string }
  | { status: 'already'; dir: string }
  | { status: 'saved'; dir: string; reason: 'no_tmux' | 'spawn_failed' }
  | { status: 'failed'; code: string };

/**
 * The report button: POST /api/stream/sessions/:id/report with the page's log. Never throws: a
 * window opened, a report made before, a snapshot saved but not opened (`no_tmux`,
 * `spawn_failed`), or a failure with the daemon's code.
 */
export async function reportStreamBug(id: string, page: PageReport, fetchImpl: typeof fetch): Promise<ReportAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(reportUrl(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page }) });
  } catch {
    return { status: 'failed', code: 'network' };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const dir = body !== null && typeof body.dir === 'string' && body.dir !== '' ? body.dir : null;
  const error = body !== null && typeof body.error === 'string' ? body.error : null;
  const window = body !== null && typeof body.window === 'string' ? body.window : '';
  if (res.ok && dir !== null) return { status: 'opened', dir, window };
  if (dir !== null && error === 'already_reported') return { status: 'already', dir };
  if (dir !== null && (error === 'no_tmux' || error === 'spawn_failed')) return { status: 'saved', dir, reason: error };
  return { status: 'failed', code: error ?? `http_${res.status}` };
}
