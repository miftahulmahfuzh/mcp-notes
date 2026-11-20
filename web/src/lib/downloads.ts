import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDownloads, type DownloadQueued, type DownloadRequest, type DownloadVia, type DownloadView, type DownloadsView, type StreamRef, type TitleDetail } from '../moviesApi';
import { episodeCode, sizeText } from './movies';
import { isPageVisible, onBecameVisible } from './pageActive';

/** How often the title page reads its downloads again while one is queued, running or paused (R3.1: at most 3 s apart). */
export const DOWNLOADS_POLL_MS = 2_500;

/** What one Download button downloads: the film, a whole season, or one episode. */
export type DownloadScope = { kind: 'movie' } | { kind: 'season'; season: number } | { kind: 'episode'; season: number; episode: number };

export type DownloadSource = DownloadView['source'];

type LivePhase = 'queued' | 'running' | 'paused';

/**
 * What a Download button shows. `active`: something of its scope is queued, running or paused (a
 * torrent play on screen pauses torrent downloads); `progress` is 0..1, a season's the mean of its
 * episodes' rows (a whole one counts 1), `left` how many are not whole yet, `ids` what a cancel
 * cancels. `here`: whole on this machine. `failed`: the last try failed, `error` its code.
 */
export type DownloadStatus =
  | { state: 'idle' }
  | { state: 'active'; phase: LivePhase; progress: number; left: number; source: DownloadSource; ids: Array<DownloadView['id']> }
  | { state: 'here'; source: DownloadSource; bytes: number | null }
  | { state: 'failed'; error: string; count: number };

const isLive = (r: DownloadView): boolean => r.state === 'queued' || r.state === 'running' || r.state === 'paused';

/** The row a film or episode is told by, when it has several: what downloads now, then what is here, then what failed. */
const RANK: Record<DownloadView['state'], number> = { running: 0, paused: 1, queued: 2, done: 3, failed: 4 };

function inScope(r: DownloadView, kind: TitleDetail['kind'], tmdbId: number, scope: DownloadScope): boolean {
  if (r.kind !== kind || r.tmdb_id !== tmdbId) return false;
  if (scope.kind === 'movie') return true;
  if (r.season !== scope.season) return false;
  return scope.kind === 'season' || r.episode === scope.episode;
}

/** One row per film or episode. */
function perSlot(rows: readonly DownloadView[]): DownloadView[] {
  const best = new Map<string, DownloadView>();
  for (const r of rows) {
    const key = `${r.season ?? 0}x${r.episode ?? 0}`;
    const was = best.get(key);
    if (was === undefined || RANK[r.state] < RANK[was.state]) best.set(key, r);
  }
  return [...best.values()];
}

/** The one source kind the rows name, or null when they name none or both. */
function oneSource(rows: readonly DownloadView[]): DownloadSource {
  const kinds = [...new Set(rows.map((r) => r.source).filter((s) => s !== null))];
  return kinds.length === 1 ? (kinds[0] ?? null) : null;
}

/** The episodes of a season that have aired by `today`; an episode with no air date counts (TMDB lists it). */
export function airedEpisodes(d: Pick<TitleDetail, 'seasons'>, season: number, today: Date = new Date()): number[] {
  const day = today.toISOString().slice(0, 10);
  const episodes = d.seasons.find((s) => s.season === season)?.episodes ?? [];
  return episodes.filter((e) => e.air_date === null || e.air_date.slice(0, 10) <= day).map((e) => e.episode);
}

export function downloadStatus(d: Pick<TitleDetail, 'kind' | 'tmdb_id' | 'seasons'>, scope: DownloadScope, rows: readonly DownloadView[], today: Date = new Date()): DownloadStatus {
  const slots = perSlot(rows.filter((r) => inScope(r, d.kind, d.tmdb_id, scope)));
  const live = slots.filter(isLive);
  const done = slots.filter((r) => r.state === 'done');
  const failed = slots.filter((r) => r.state === 'failed');
  if (live.length > 0) {
    const counted = [...live, ...done];
    const progress = counted.reduce((n, r) => n + (r.state === 'done' ? 1 : r.progress), 0) / counted.length;
    const phase: LivePhase = live.some((r) => r.state === 'running') ? 'running' : live.some((r) => r.state === 'paused') ? 'paused' : 'queued';
    return { state: 'active', phase, progress, left: live.length, source: oneSource(live), ids: live.map((r) => r.id) };
  }
  if (scope.kind === 'season') {
    const aired = airedEpisodes(d, scope.season, today);
    const whole = new Set(done.map((r) => r.episode));
    if (aired.length > 0 && aired.every((e) => whole.has(e))) {
      const sizes = done.map((r) => r.bytes_total);
      const bytes = sizes.every((b) => b !== null) ? sizes.reduce<number>((n, b) => n + (b ?? 0), 0) : null;
      return { state: 'here', source: oneSource(done), bytes };
    }
  } else {
    const whole = done[0];
    if (whole !== undefined) return { state: 'here', source: whole.source, bytes: whole.bytes_total };
  }
  const first = failed[0];
  if (first !== undefined) return { state: 'failed', error: first.error ?? 'download_failed', count: failed.length };
  return { state: 'idle' };
}

/** "How to Make a Killing", "MobLand season 1", "MobLand specials", "MobLand S01E03". */
export function downloadName(d: Pick<TitleDetail, 'title'>, scope: DownloadScope): string {
  if (scope.kind === 'movie') return d.title;
  if (scope.kind === 'season') return scope.season === 0 ? `${d.title} specials` : `${d.title} season ${scope.season}`;
  return `${d.title} ${episodeCode(scope.season, scope.episode)}`;
}

/** The body of POST /api/stream/downloads: a season names no episode (the server queues its aired episodes) and no torrent. */
export function downloadBody(d: Pick<TitleDetail, 'tmdb_id'>, scope: DownloadScope, via: DownloadVia, infoHash: string | null = null): DownloadRequest {
  const hash = infoHash === null ? {} : { info_hash: infoHash };
  if (scope.kind === 'movie') return { kind: 'movie', tmdb_id: d.tmdb_id, via, ...hash };
  if (scope.kind === 'season') return { kind: 'tv', tmdb_id: d.tmdb_id, season: scope.season, via };
  return { kind: 'tv', tmdb_id: d.tmdb_id, season: scope.season, episode: scope.episode, via, ...hash };
}

/** The film or episode whose torrents the pick lists; null for a season (no one torrent is picked for a season). */
export function downloadRef(d: Pick<TitleDetail, 'tmdb_id'>, scope: DownloadScope): StreamRef | null {
  if (scope.kind === 'movie') return { kind: 'movie', tmdb_id: d.tmdb_id };
  if (scope.kind === 'episode') return { kind: 'tv', tmdb_id: d.tmdb_id, season: scope.season, episode: scope.episode };
  return null;
}

const DOWNLOAD_ERRORS: Record<string, string> = {
  no_source: 'no torrent and no cloud source could be downloaded',
  no_peers_here: 'no torrent peers on this network',
  dubbed: 'every release found is dubbed',
  download_failed: 'the download stopped',
  cancelled: 'cancelled',
  downloads_off: 'downloads are off on this daemon',
  invalid_body: 'the daemon did not understand the request',
  unknown_download: 'that download is gone',
};

export function downloadErrorText(code: string): string {
  return DOWNLOAD_ERRORS[code] ?? code.replace(/_/g, ' ');
}

const FROM: Record<string, string> = { torrent: ' from a torrent', cloud: ' from a cloud provider' };

/** The button's tip: what it does, or where its download is. */
export function downloadTip(name: string, s: DownloadStatus): string {
  switch (s.state) {
    case 'idle':
      return `Download ${name} to this machine: a 1080p torrent, else a cloud provider`;
    case 'active': {
      const pct = `${Math.round(s.progress * 100)}%`;
      const left = s.left > 1 ? ` (${s.left} episodes left)` : '';
      if (s.phase === 'queued') return `${name}: download queued, ${pct}${left}`;
      if (s.phase === 'paused') return `${name}: download paused while a torrent plays, ${pct}${left}`;
      return `${name}: downloading${s.source === null ? '' : (FROM[s.source] ?? '')}, ${pct}${left}`;
    }
    case 'here': {
      const facts = [s.source ?? '', s.bytes === null ? '' : sizeText(s.bytes)].filter((x) => x !== '');
      return `${name} is on this machine${facts.length === 0 ? '' : ` (${facts.join(', ')})`}`;
    }
    case 'failed':
      return `${name}: the download failed (${downloadErrorText(s.error)})${s.count > 1 ? ` for ${s.count} episodes` : ''}. Click to try again`;
  }
}

/**
 * The page's notice after a click, from what the daemon answered (`created` new, the rest already queued or whole).
 * A season's episodes the server left out for not having aired, or for having no air date (phase 4's `not_aired`
 * counts both), are named by count, so the season click never promises an episode the engine leaves out unsaid.
 */
export function downloadNotice(name: string, via: DownloadVia, queued: Pick<DownloadQueued, 'created' | 'downloads' | 'not_aired'>): string {
  const from = via === 'torrent' ? ', from a torrent' : via === 'cloud' ? ', from a cloud provider' : '';
  const later = queued.not_aired > 0 ? `; ${queued.not_aired === 1 ? '1 episode' : `${queued.not_aired} episodes`} left out (not aired yet, or no air date)` : '';
  if (queued.created === 0) return `${queued.downloads.length > 0 ? `${name}: already downloading` : `${name}: nothing left to download`}${later}`;
  return `${queued.created === 1 ? `${name}: download queued${from}` : `${name}: ${queued.created} episodes queued${from}`}${later}`;
}

export interface TitleDownloads {
  /** The title's download rows as the daemon last answered them; [] before the first answer, or when `titleId` is null. */
  rows: readonly DownloadView[];
  /** Ask again now (after a click or a cancel); asking then goes on every DOWNLOADS_POLL_MS while one is queued, running or paused. */
  reload: () => void;
}

const NO_ROWS: readonly DownloadView[] = [];

/**
 * A title's downloads for its page. `titleId` null (the Library side, or streaming off): never asks.
 * Asks once when the title opens and again whenever `refreshKey` changes (the page passes its
 * TitleDetail, a new object only when the page re-read the title: its normal refresh, R3.3). While
 * the answer has something queued, running or paused (`active` and a live row) and the tab is
 * visible, asks again every DOWNLOADS_POLL_MS (R3.1); a hidden tab asks nothing and asks at once on
 * becoming visible. A failed ask stops the polling until the next refresh.
 */
export function useDownloads(titleId: string | null, refreshKey: unknown): TitleDownloads {
  const [view, setView] = useState<DownloadsView | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);
  const active = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    if (titleId === null) return;
    const mine = ++seq.current;
    let again = false;
    try {
      const v = await fetchDownloads(titleId);
      if (mine !== seq.current) return;
      setView(v);
      again = v.active && v.downloads.some(isLive);
    } catch {
      if (mine !== seq.current) return;
    }
    active.current = again;
    if (again) {
      timer.current = window.setTimeout(() => {
        if (isPageVisible()) void load();
      }, DOWNLOADS_POLL_MS);
    }
  }, [titleId]);

  useEffect(() => {
    setView(null);
    active.current = false;
  }, [titleId]);

  useEffect(() => {
    void load();
    return () => {
      seq.current += 1;
      window.clearTimeout(timer.current);
    };
  }, [load, refreshKey]);

  useEffect(
    () =>
      onBecameVisible(() => {
        if (active.current) void load();
      }),
    [load],
  );

  const reload = useCallback(() => void load(), [load]);
  return { rows: titleId === null || view === null ? NO_ROWS : view.downloads, reload };
}
