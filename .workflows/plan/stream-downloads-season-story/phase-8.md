# Phase 8: The title page: Download buttons, the choose menu, progress bars

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R1, R2, R3 — the owner downloads a film, a season or an episode from its Stream-side title page, chooses the source by hand when he wants, and watches the download's progress there
**Criteria:** R1.1, R1.3, R2.1, R2.2, R3.1, R3.3
**Depends on:** Phase 4 (the `/api/stream/downloads` routes and the `web/src/moviesApi.ts` client seam), Phase 7 (lands its season story button in the same two files first)
**Difficulty:** NORMAL
**Package:** `web/src/components/movies`, `web/src/lib`

---

## Goal

After this phase the Stream side of a title page has a Download button: beside Play for a film, on every season head and on every episode row of a series. A click queues a download with no source named (`via: auto`); its caret opens "Choose how to download <name>" with Best torrent (1080p), Cloud and Pick a torrent… (the existing torrent candidates list, with a download action per row). While anything of the title is queued, running or paused and the tab is visible, the page reads `GET /api/stream/downloads?title=` every 2.5 s and draws a thin progress bar under each button concerned (a season's bar is the mean of its rows); when nothing runs it asks only with the page's own refresh of the title.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/lib/downloads.ts`: `DOWNLOADS_POLL_MS` (2500), `type DownloadScope`, `type DownloadSource`, `type DownloadStatus`, `airedEpisodes`, `downloadStatus`, `downloadName`, `downloadBody`, `downloadRef`, `downloadErrorText`, `downloadTip`, `downloadNotice`, `interface TitleDownloads`, `useDownloads(titleId: string | null, refreshKey: unknown): TitleDownloads`.
- `web/src/lib/downloads.test.tsx`.
- `web/src/components/movies/DownloadButton.tsx`: `DownloadButton`, `interface DownloadButtonProps`, `interface DownloadsBinding`, `type DownloadSize = 'page' | 'season' | 'row'`.
- `web/src/components/movies/DownloadButton.test.tsx`.
- `web/src/testing/downloadFixtures.ts`: `makeDownload(over)`, `downloadId(n)`.
- `.claude/skills/verify-notesd/scripts/stream/download-buttons.steps.mjs` (this phase's Proof drive).
- CSS classes in `web/src/components/movies/Movies.css`: `.mv-dl`, `.mv-dl-bar`, `.mv-dl-bar.queued`, `.mv-dl-bar.paused`, `.mv-dl-failed`, `.mv-dl-cancel`.

**Signature changes:**
- `TorrentsModalProps.onPlay: (infoHash, name) => void` -> `onPlay?: ((infoHash: string, name: string) => void) | undefined`, plus new `onDownload?: ((infoHash: string, name: string) => void) | undefined`. A row shows Play only when `onPlay` is given and Download only when `onDownload` is given. `PlayMenu` (the only caller today) still passes `onPlay`, so it behaves as before.
- `EpisodeListProps` gains `downloads?: DownloadsBinding | undefined` (after phase 7's `onSeasonStory`). Left out, no Download button anywhere in the list.
- `EpisodeItemProps` (internal) gains `downloads?: DownloadsBinding | undefined`.

**Requires (from earlier phases):** phase 4's client seam in `web/src/moviesApi.ts`, exactly as phase 4's plan writes it (reconciled; phase 4's shape wins):
```ts
export type DownloadVia = 'auto' | 'torrent' | 'cloud';
export type DownloadState = 'queued' | 'running' | 'paused' | 'done' | 'failed';
export type DownloadSource = 'torrent' | 'cloud';
export interface DownloadView {
  id: string;                       // a uuid; opaque here: only sent back to cancelDownload
  host: string; available: boolean;
  title_id: string;                 // `movie-<tmdb id>` / `tv-<tmdb id>`
  kind: TitleKind; tmdb_id: number;
  season: number | null;            // null for a film
  episode: number | null;
  state: DownloadState;             // `done` only in an answer narrowed by ?title=
  via: DownloadVia; info_hash: string | null;
  source: DownloadSource | null; source_id: string | null;
  progress: number;                 // 0..1, clamped by fetchDownloads
  bytes_done: number; bytes_total: number | null; peers: number | null; down_kbps: number | null;
  error: string | null;             // a code: no_source, no_peers_here, dubbed, download_failed, ...
  detail: string | null; batch: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
}
export interface DownloadsView { host: string; active: boolean; downloads: DownloadView[] }
export type DownloadRequest =
  | { kind: 'movie'; tmdb_id: number; via?: DownloadVia; info_hash?: string }
  | { kind: 'tv'; tmdb_id: number; season: number; episode: number; via?: DownloadVia; info_hash?: string }
  | { kind: 'tv'; tmdb_id: number; season: number; episode?: never; via?: DownloadVia; info_hash?: never };
export interface DownloadQueued { created: number; whole: number; not_aired: number; downloads: DownloadView[] }
/** POST /api/stream/downloads; answers at once. Throws ApiError downloads_off, invalid_body, unknown_season. */
export async function requestDownload(ask: DownloadRequest): Promise<DownloadQueued>;
/** GET /api/stream/downloads[?title=<TitleDetail.id>]. */
export async function fetchDownloads(titleId?: string | null, signal?: AbortSignal): Promise<DownloadsView>;
/** DELETE /api/stream/downloads/:id. Throws ApiError unknown_download. */
export async function cancelDownload(id: string): Promise<void>;
```
What the server answers, as phases 2 and 4 state it (reconciled):
1. `?title=` takes the title page's `TitleDetail.id` (`movie-990001`, `tv-247718`) and narrows `downloads` to that title.
2. With `?title=`, `downloads` also lists the title's `done` rows (the latest per film or episode, and only while it is still whole on this machine), so the button says "on this machine" with the source and size. `active` is computed from queued, running and paused rows only.
3. `active` counts a `paused` row (a torrent play on screen holds the download back): the page keeps reading every 2.5 s while one is paused and sees it resume (R3.1 reads "queued or running" to include paused).
4. `POST` answers at once, 202 `{ok, created, whole, not_aired, downloads}` when it queued something, 200 in the same shape otherwise. For a season, `not_aired` counts the episodes phase 3 left out for not having aired and for having no air date (phase 4 maps both `left_out` reasons to it); `downloadNotice` says that count (reconciled, round 2).

From phase 7 (lands before this phase): `EpisodeList.tsx`'s season head is, in order, `SeasonFoldButton` · `<h3 className="mv-season-h">` · `TrailerButton` (season > 0) · `SeasonStoryButton` (season > 0, `onSeasonStory` given) · `SeasonWatchedButton` · the folded summary span; `EpisodeList`'s destructuring ends `…, onTrailer, onStory, onSeasonStory }`; `MovieDetail.tsx` passes `onTrailer={setTrailer}` unchanged and replaces `onStory={setStory}` with two lines (`onStory=…`, `onSeasonStory=…`). This phase anchors only on code phase 7 does not change: `onTrailer={setTrailer}`, the `<SeasonWatchedButton … />` line, the `{isFolded(s) && <span className="mv-dim mv-season-sum">` line, the `<PlayMenu … size="page" … />` line, the `.mv-row-play` span.

**Names phase 9's drive uses, pinned by this phase's tests (reconciled):** the button is named `Download <name>` (`<name>`: `How to Make a Killing`, `MobLand season 1`, `MobLand S01E03`); its bar is `role="progressbar"` named `Download of <name>` with `aria-valuenow` 0–100, inside `.mv-actions` for a film's head button, inside `.mv-season-head` for a season's and inside `li[data-episode="S01E03"]` (the row's existing `data-episode={code}`) for an episode's; the caret is named `Choose how to download <name>` and opens a `role="menu"` of the same name whose items are `Best torrent (1080p)`, `Cloud` and `Pick a torrent…` (no pick for a season); the cancel icon is named `Cancel the download of <name>` and shows while queued, running or paused. `DownloadButton.test.tsx` and `EpisodeList.test.tsx` assert these; keep them. A paused row is live (bar shown, polling on), per R3.1 as reconciled.

**Leaves alone (owned by others):** the Cache page (`CachePage.tsx`/`.css`/`.test.tsx`, phase 5); the season story button, `StoryModal.tsx` and the story state in `MovieDetail.tsx` (phase 7); every server file, `scripts/docs/*` and the generated references (phases 1–4, 6); `web/src/moviesApi.ts` (phase 4 adds the download client; this phase only imports it); `.claude/skills/verify-notesd/features/*.md`, `docs/guide/*`, pictures (phase 9).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/lib/downloads.ts` | create | status per film / season / episode, names, request bodies, tips, the `useDownloads` hook |
| `web/src/lib/downloads.test.tsx` | create | the hook's asking rule (once, every 2.5 s only while active and visible, with the page's refresh) and the pure status rules |
| `web/src/testing/downloadFixtures.ts` | create | `makeDownload`, `downloadId` for the two test files |
| `web/src/components/movies/DownloadButton.tsx` | create | the icon button, its caret menu, the cancel icon, the bar, the torrent pick |
| `web/src/components/movies/DownloadButton.test.tsx` | create | what each click sends, the menu, the bar, cancel, here / failed |
| `web/src/components/movies/TorrentsModal.tsx` | modify | line 3 import; lines 7–14 props; line 54 signature; lines 143–152 the row's buttons |
| `web/src/components/movies/TorrentsModal.test.tsx` | modify | one new `it` after line 97 |
| `web/src/components/movies/EpisodeList.tsx` | modify | imports (after line 6); `downloads` prop (after phase 7's `onSeasonStory`); destructuring (line 91 / phase 7's 463); season head (before the summary span, line 126 / phase 7's 499); `EpisodeItem` props (line 166–182), its destructuring (line 184) and `.mv-row-play` (lines 269–271) |
| `web/src/components/movies/EpisodeList.test.tsx` | modify | new `describe('EpisodeList: downloads')` appended at the end |
| `web/src/components/movies/MovieDetail.tsx` | modify | two imports (after line 35 and line 37); the hook after line 104; the film's head button after line 309; `downloads={downloads}` after line 395 |
| `web/src/components/movies/Movies.css` | modify | append after line 236 |
| `.claude/skills/verify-notesd/scripts/stream/download-buttons.steps.mjs` | create | the Playwright drive the Proof runs |

## Implementation Steps

### Step 1: Test fixtures for download rows
**File:** `web/src/testing/downloadFixtures.ts` (new)
**Change:** one builder both test files share, so no test file duplicates it.
**Code:**
```ts
import type { DownloadView } from '../moviesApi';

/** A download id as the wire carries it (opaque to the page: it is only sent back to cancel). */
export const downloadId = (n: number): DownloadView['id'] => n as unknown as DownloadView['id'];

/** A running torrent download of How to Make a Killing (the MOVIE fixture), 42 % done; `over` changes any field. */
export function makeDownload(over: Partial<DownloadView> = {}): DownloadView {
  return {
    id: downloadId(1),
    title_id: 'movie-467905',
    kind: 'movie',
    tmdb_id: 467905,
    season: null,
    episode: null,
    state: 'running',
    via: 'auto',
    source: 'torrent',
    progress: 0.42,
    bytes_done: 630_000_000,
    bytes_total: 1_500_000_000,
    peers: 4,
    down_kbps: 2400,
    error: null,
    batch: null,
    ...over,
  } as DownloadView;
}
```
**Impact:** none outside tests.

### Step 2: The rules: what a button shows, names, bodies, tips, and the asking hook
**File:** `web/src/lib/downloads.ts` (new)
**Change:** every rule the button and the page follow, pure where it can be. The status is a discriminated union, so a button cannot be "here" and "downloading" at once, and a season scope cannot carry an episode (principle 5). The hook asks once per title and with each refresh of the title (`refreshKey` is the `TitleDetail` object, a new object only when the page re-fetched it), then every 2.5 s only while the answer has something queued, running or paused and the tab is visible. `startAdaptivePoll` (`lib/pageActive.ts`) is not reused: it polls unconditionally and backs off, the opposite of "nothing at all while idle, fixed 2.5 s while active".
**Code:**
```ts
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
```
**Impact:** new module; nothing imports it until Steps 4–6.

### Step 3: The hook's and the rules' tests
**File:** `web/src/lib/downloads.test.tsx` (new)
**Change:** tests of what a caller observes: how many times `GET /api/stream/downloads` is asked, and what a button would show. Real `fetchDownloads` over a stubbed `fetch`, fake timers.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { DownloadView } from '../moviesApi';
import { DOWNLOADS_POLL_MS, downloadBody, downloadName, downloadNotice, downloadStatus, downloadTip, useDownloads } from './downloads';
import { makeDownload } from '../testing/downloadFixtures';
import { MOVIE, SERIES } from '../testing/movieFixtures';

let answers: boolean[];
let asked: string[];

function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}
const downloadAsks = (): string[] => asked.filter((u) => u.startsWith('/api/stream/downloads'));
const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      const active = answers.shift() ?? false;
      const downloads = active ? [makeDownload({ state: 'running' })] : [makeDownload({ state: 'done', progress: 1 })];
      return new Response(JSON.stringify({ host: 'lenovo', active, downloads }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility('visible');
});

describe('useDownloads: when the title page asks', () => {
  it('asks once when nothing downloads, never on a timer, and again only with the page refresh', async () => {
    const { rerender } = renderHook(({ key }) => useDownloads('movie-467905', key), { initialProps: { key: 1 } });
    await flush(60_000);
    expect(downloadAsks()).toHaveLength(1);
    expect(downloadAsks()[0]).toContain('title=movie-467905');
    rerender({ key: 2 });
    await flush(10_000);
    expect(downloadAsks()).toHaveLength(2);
    rerender({ key: 2 });
    await flush(10_000);
    expect(downloadAsks()).toHaveLength(2);
  });

  it('asks every 2.5 s while a download runs, and stops when none does', async () => {
    answers = [true, true, false];
    renderHook(() => useDownloads('movie-467905', 1));
    await flush();
    expect(downloadAsks()).toHaveLength(1);
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(2);
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(3);
    await flush(30_000);
    expect(downloadAsks()).toHaveLength(3);
  });

  it('asks nothing while the tab is hidden, and at once when it is visible again', async () => {
    answers = [true, true, true];
    renderHook(() => useDownloads('movie-467905', 1));
    await flush();
    expect(downloadAsks()).toHaveLength(1);
    act(() => setVisibility('hidden'));
    await flush(10_000);
    expect(downloadAsks()).toHaveLength(1);
    act(() => setVisibility('visible'));
    await flush();
    expect(downloadAsks()).toHaveLength(2);
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(3);
  });

  it('never asks without a title (the Library side, or streaming off)', async () => {
    renderHook(() => useDownloads(null, 1));
    await flush(60_000);
    expect(downloadAsks()).toHaveLength(0);
  });

  it('asks again at once on reload, then keeps the 2.5 s pace while active', async () => {
    answers = [false, true, false];
    const { result } = renderHook(() => useDownloads('movie-467905', 1));
    await flush();
    act(() => result.current.reload());
    await flush();
    expect(downloadAsks()).toHaveLength(2);
    expect(result.current.rows[0]?.state).toBe('running');
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(3);
    await flush(30_000);
    expect(downloadAsks()).toHaveLength(3);
  });
});

describe('downloadStatus: what a button shows', () => {
  const ep = (episode: number, over: Partial<DownloadView> = {}) => makeDownload({ title_id: SERIES.id, kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode, ...over });

  it("a season's progress is the mean of its rows; another season's rows do not count", () => {
    const rows = [ep(1, { state: 'done', progress: 1 }), ep(2, { state: 'running', progress: 0.5 }), ep(3, { state: 'queued', progress: 0, source: null }), makeDownload({ kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 2, episode: 1, progress: 0.9 })];
    const s = downloadStatus(SERIES, { kind: 'season', season: 1 }, rows);
    expect(s).toEqual({ state: 'active', phase: 'running', progress: 0.5, left: 2, source: 'torrent', ids: [rows[1]!.id, rows[2]!.id] });
    expect(downloadTip('MobLand season 1', s)).toBe('MobLand season 1: downloading from a torrent, 50% (2 episodes left)');
    expect(downloadStatus(SERIES, { kind: 'episode', season: 1, episode: 3 }, rows)).toMatchObject({ state: 'active', phase: 'queued', progress: 0 });
  });

  it('a season is on this machine only when every aired episode is', () => {
    const all = [1, 2, 3, 4].map((e) => ep(e, { state: 'done', progress: 1, bytes_total: 1024 ** 3 }));
    expect(downloadStatus(SERIES, { kind: 'season', season: 1 }, all)).toEqual({ state: 'here', source: 'torrent', bytes: 4 * 1024 ** 3 });
    expect(downloadStatus(SERIES, { kind: 'season', season: 1 }, all.slice(0, 3))).toEqual({ state: 'idle' });
    const unaired = { ...SERIES, seasons: SERIES.seasons.map((s) => (s.season === 1 ? { ...s, episodes: s.episodes.map((e) => (e.episode === 4 ? { ...e, air_date: '2099-01-01' } : e)) } : s)) };
    expect(downloadStatus(unaired, { kind: 'season', season: 1 }, all.slice(0, 3), new Date('2026-11-20T00:00:00Z'))).toMatchObject({ state: 'here' });
  });

  it('says a failure with its reason, and a film is matched by its own TMDB id only', () => {
    expect(downloadStatus(MOVIE, { kind: 'movie' }, [makeDownload({ state: 'failed', progress: 0, error: 'no_source' })])).toEqual({ state: 'failed', error: 'no_source', count: 1 });
    expect(downloadStatus(MOVIE, { kind: 'movie' }, [makeDownload({ tmdb_id: 1 })])).toEqual({ state: 'idle' });
  });

  it('names what it downloads and builds the body the route takes', () => {
    expect(downloadName(SERIES, { kind: 'season', season: 0 })).toBe('MobLand specials');
    expect(downloadName(SERIES, { kind: 'episode', season: 1, episode: 3 })).toBe('MobLand S01E03');
    expect(downloadBody(SERIES, { kind: 'season', season: 1 }, 'auto')).toEqual({ kind: 'tv', tmdb_id: 247718, season: 1, via: 'auto' });
    expect(downloadBody(MOVIE, { kind: 'movie' }, 'torrent', 'a'.repeat(40))).toEqual({ kind: 'movie', tmdb_id: 467905, via: 'torrent', info_hash: 'a'.repeat(40) });
  });

  it("a season's notice says how many episodes the server left out for not having aired (or having no air date)", () => {
    const q = (created: number, not_aired: number, downloads: DownloadView[] = []) => ({ created, whole: 0, not_aired, downloads });
    expect(downloadNotice('MobLand season 1', 'auto', q(3, 0))).toBe('MobLand season 1: 3 episodes queued');
    expect(downloadNotice('MobLand season 1', 'torrent', q(2, 1))).toBe('MobLand season 1: 2 episodes queued, from a torrent; 1 episode left out (not aired yet, or no air date)');
    expect(downloadNotice('MobLand season 1', 'auto', q(0, 2))).toBe('MobLand season 1: nothing left to download; 2 episodes left out (not aired yet, or no air date)');
  });
});
```
**Impact:** `npx vitest run web/src/lib/downloads.test.tsx` must pass before Step 4 (a check that can fail on its own).

### Step 4: The torrent list learns a download action
**File:** `web/src/components/movies/TorrentsModal.tsx`
**Change:** `onPlay` becomes optional and `onDownload` is added; a row shows Play only with `onPlay`, Download only with `onDownload`. Opened from a Download button's "Pick a torrent…", the list downloads; opened from the play menu, it plays as today. The list itself (rows, blacklist, refresh) is reused unchanged (principle 2).

**4a. Line 3**, the icon import: replace with
```tsx
import { ArrowClockwise, ArrowUUpLeft, CircleNotch, DownloadSimple, Play, Prohibit, X } from '@phosphor-icons/react';
```
**4b. Lines 7–14**, the props: replace with
```tsx
export interface TorrentsModalProps {
  /** The film or episode the list is of (`what` names it: "Eternally Yours S01E07"). */
  target: StreamRef;
  what: string;
  /** Plays one torrent for the title, as a pasted magnet; the page shows the play's notice. Left out, the rows have no Play. */
  onPlay?: ((infoHash: string, name: string) => void) | undefined;
  /** Downloads that one torrent to this machine (the Download button's "Pick a torrent…"). Left out, the rows have no Download. */
  onDownload?: ((infoHash: string, name: string) => void) | undefined;
  onClose: () => void;
}
```
**4c. Lines 48–54**, the doc comment and signature: replace with
```tsx
/**
 * Every candidate torrent of a film or episode, opened from the play menu's Torrent stream row (each row plays) or from
 * a Download button's "Pick a torrent…" (each row downloads): what the indexes list (their answer of the last ten
 * minutes, or asked again with the refresh button), the torrents this machine opened for it and the magnets pasted for
 * it. Per row its facts and status, its play or download button, and blacklist it (for every title) or take it off
 * the blacklist. Listing joins no swarm.
 */
export function TorrentsModal({ target, what, onPlay, onDownload, onClose }: TorrentsModalProps) {
```
**4d. Lines 143–152**, the row's Play button: replace with
```tsx
                  {onPlay !== undefined && (
                    <button
                      type="button"
                      className="ibtn hov"
                      data-tip="Play this one"
                      aria-label={`Play ${c.name}`}
                      disabled={c.blacklisted !== null || busy !== null}
                      onClick={() => onPlay(c.info_hash, c.name)}
                    >
                      <Play weight="duotone" />
                    </button>
                  )}
                  {onDownload !== undefined && (
                    <button
                      type="button"
                      className="ibtn hov"
                      data-tip="Download this one to this machine"
                      aria-label={`Download ${c.name}`}
                      disabled={c.blacklisted !== null || busy !== null}
                      onClick={() => onDownload(c.info_hash, c.name)}
                    >
                      <DownloadSimple weight="duotone" />
                    </button>
                  )}
```
**Impact:** `PlayMenu.tsx:179–196` still passes `onPlay` and no `onDownload`: unchanged behaviour, and `TorrentsModal.test.tsx`'s existing tests (which pass `onPlay`) still pass.

### Step 5: Test the download action of the torrent list
**File:** `web/src/components/movies/TorrentsModal.test.tsx`
**Change:** append one `it` inside `describe('TorrentsModal', …)`, after the `closes on Esc …` test (line 97).
**Code:**
```tsx
  it('downloads a row by its hash when opened for a download, and offers no Play there', async () => {
    const onDownload = vi.fn();
    render(<TorrentsModal target={TARGET} what="Eternally Yours S01E07" onDownload={onDownload} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /^Play / })).toBeNull();
    expect((screen.getByRole('button', { name: 'Download Eternally.Yours.S01E07.1080p.ColdFilm.mkv' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Download Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL' }));
    expect(onDownload).toHaveBeenCalledWith('a'.repeat(40), 'Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL');
  });
```
**Impact:** none.

### Step 6: The Download button
**File:** `web/src/components/movies/DownloadButton.tsx` (new)
**Change:** an icon-only button (Phosphor `DownloadSimple`, `ibtn` on the page head, `pbtn` on a season head and an episode row; constant aria-label `Download <name>`, the state in `data-tip` and `data-download`), its caret (the play menu's `mv-menu-btn` and `mv-menu-list` classes, so `isPlayMenuOpen` and the pop-up's Esc rule cover it too), a cancel icon while queued or downloading, and a thin `role="progressbar"` bar under it while queued, running or paused. "Pick a torrent…" opens `TorrentsModal` with `onDownload` only, and is left out for a season (`downloadRef` is null for one).
**Code:**
```tsx
import { useEffect, useRef, useState } from 'react';
import { CaretDown, Cloud, DownloadSimple, ListMagnifyingGlass, Magnet, X } from '@phosphor-icons/react';
import { cancelDownload, errorCode, requestDownload, type DownloadVia, type DownloadView, type TitleDetail } from '../../moviesApi';
import { downloadBody, downloadErrorText, downloadName, downloadNotice, downloadRef, downloadStatus, downloadTip, type DownloadScope } from '../../lib/downloads';
import { TorrentsModal } from './TorrentsModal';

/** The page's downloads, handed to every Download button on it (MovieDetail reads them once for the whole page). */
export interface DownloadsBinding {
  rows: readonly DownloadView[];
  onNotice: (text: string) => void;
  /** Read the downloads again now (after a click or a cancel). */
  onChanged: () => void;
}

/** `page`: an ibtn beside a film's Play; `season`: a pbtn on a season head; `row`: a pbtn in an episode row (its menu opens to the left). */
export type DownloadSize = 'page' | 'season' | 'row';

export interface DownloadButtonProps extends DownloadsBinding {
  detail: TitleDetail;
  scope: DownloadScope;
  size: DownloadSize;
}

/**
 * Download a film, a season or an episode to this machine's stream store (Stream side only). The
 * click asks for it with no source named (`via: auto`: a 1080p torrent with live seeds, else a cloud
 * provider, else a lower torrent). The caret names the source by hand: the best torrent, a cloud
 * provider, or one torrent picked from the candidates list (a film or an episode). While its
 * download is queued, running or paused a thin bar shows its progress (a season's: the mean of its
 * episodes) and an X cancels it; once whole the icon is filled; a failure says why, and a click asks again.
 */
export function DownloadButton({ detail: d, scope, rows, size, onNotice, onChanged }: DownloadButtonProps) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open]);

  const name = downloadName(d, scope);
  const status = downloadStatus(d, scope, rows);
  const tip = downloadTip(name, status);
  const menuLabel = `Choose how to download ${name}`;
  const ref = downloadRef(d, scope);
  const page = size === 'page';
  const btn = page ? 'ibtn' : 'pbtn';
  const side = page ? 'below' : undefined;
  const pct = status.state === 'active' ? Math.round(status.progress * 100) : null;
  const barClass = status.state === 'active' && status.phase !== 'running' ? `mv-dl-bar ${status.phase}` : 'mv-dl-bar';

  const send = async (via: DownloadVia, infoHash: string | null = null) => {
    setOpen(false);
    setSending(true);
    try {
      const queued = await requestDownload(downloadBody(d, scope, via, infoHash));
      onNotice(downloadNotice(name, via, queued));
    } catch (e) {
      onNotice(`could not download ${name}: ${downloadErrorText(errorCode(e))}`);
    } finally {
      setSending(false);
      onChanged();
    }
  };

  const cancel = async () => {
    if (status.state !== 'active') return;
    try {
      await Promise.all(status.ids.map((id) => cancelDownload(id)));
      onNotice(`${name}: download cancelled`);
    } catch (e) {
      onNotice(`could not cancel the download of ${name}: ${downloadErrorText(errorCode(e))}`);
    } finally {
      onChanged();
    }
  };

  const click = () => {
    if (status.state === 'here') onNotice(`${name} is already on this machine`);
    else if (status.state === 'active') onChanged();
    else void send('auto');
  };

  return (
    <span className={`mv-dl ${size}`} ref={box} data-download={status.state}>
      <button
        type="button"
        className={`${btn} ${status.state === 'here' ? 'on' : 'hov'}${status.state === 'failed' ? ' mv-dl-failed' : ''}`}
        data-tip={open ? undefined : tip}
        data-tip-side={side}
        aria-label={`Download ${name}`}
        disabled={sending}
        onClick={click}
      >
        <DownloadSimple weight={status.state === 'here' ? 'fill' : 'duotone'} />
      </button>
      <button
        type="button"
        className={`${btn} hov mv-menu-btn`}
        data-tip={open ? undefined : menuLabel}
        data-tip-side={side}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={sending}
        onClick={() => setOpen((o) => !o)}
      >
        <CaretDown weight="bold" />
      </button>
      {status.state === 'active' && (
        <button type="button" className={`${btn} hov mv-dl-cancel`} data-tip={`Cancel the download of ${name}`} data-tip-side={side} aria-label={`Cancel the download of ${name}`} onClick={() => void cancel()}>
          <X weight="bold" />
        </button>
      )}
      {pct !== null && (
        <span className={barClass} role="progressbar" aria-label={`Download of ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {open && (
        <span className={size === 'row' ? 'mv-menu-list right' : 'mv-menu-list'} role="menu" aria-label={menuLabel}>
          <span className="mv-menu-head">{menuLabel}</span>
          <button type="button" role="menuitem" className="mv-menu-item" data-via="torrent" onClick={() => void send('torrent')}>
            <Magnet weight="duotone" />
            <span className="mv-menu-t">
              <span className="mv-menu-label">Best torrent (1080p)</span>
              <span className="mv-menu-hint">a torrent only: the 1080p release with live seeds, a lower one when there is none</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="mv-menu-item" data-via="cloud" onClick={() => void send('cloud')}>
            <Cloud weight="duotone" />
            <span className="mv-menu-t">
              <span className="mv-menu-label">Cloud</span>
              <span className="mv-menu-hint">a cloud provider at 1080p or lower, never a torrent</span>
            </span>
          </button>
          {ref !== null && (
            <button
              type="button"
              role="menuitem"
              className="mv-menu-item"
              data-via="pick"
              onClick={() => {
                setOpen(false);
                setPicking(true);
              }}
            >
              <ListMagnifyingGlass weight="duotone" />
              <span className="mv-menu-t">
                <span className="mv-menu-label">Pick a torrent…</span>
                <span className="mv-menu-hint">every torrent of {name}: the one picked, and no other</span>
              </span>
            </button>
          )}
        </span>
      )}
      {picking && ref !== null && (
        <TorrentsModal
          target={ref}
          what={name}
          onDownload={(infoHash) => {
            setPicking(false);
            void send('torrent', infoHash);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </span>
  );
}
```
**Impact:** new component; placed by Steps 8 and 10.

### Step 7: The button's tests
**File:** `web/src/components/movies/DownloadButton.test.tsx` (new)
**Change:** what each click and choice sends to `POST /api/stream/downloads` (URL, method, body), what the menu offers, the bar, cancel, and the here / failed tips. Real `requestDownload` / `cancelDownload` / `fetchTorrentCandidates` over a stubbed `fetch`.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DownloadView, TorrentCandidateView } from '../../moviesApi';
import { downloadId, makeDownload } from '../../testing/downloadFixtures';
import { MOVIE, SERIES } from '../../testing/movieFixtures';
import { DownloadButton, type DownloadButtonProps } from './DownloadButton';

const HASH = 'b'.repeat(40);
const CANDIDATE: TorrentCandidateView = {
  info_hash: HASH,
  name: 'How.to.Make.a.Killing.2026.1080p.WEB.h264-ETHEL',
  height: 1080,
  size_bytes: 1_500_000_000,
  seeds: 40,
  scrape: { seeders: 12, leechers: 3 },
  from: ['torrentio'],
  audio: { languages: ['en'], how: 'tags', heard_probability: null },
  worked: false,
  failed: null,
  blacklisted: null,
  dub_group: null,
  heard_dub: false,
  dub_named: false,
  left_out: null,
  remembered: false,
  on_disk: false,
};

let calls: Array<{ url: string; method: string; body: unknown }>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (url.startsWith('/api/stream/torrents?')) return json({ original_language: 'en', listed_at: '2026-11-20T08:00:00Z', cached: true, candidates: [CANDIDATE] });
      if (method === 'POST' && url === '/api/stream/downloads') return json({ ok: true, created: 1, whole: 0, not_aired: 0, downloads: [makeDownload({ state: 'queued', progress: 0, source: null })] }, 202);
      if (method === 'DELETE' && url.startsWith('/api/stream/downloads/')) return json({ ok: true });
      return new Response('not found', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function props(over: Partial<DownloadButtonProps> = {}): DownloadButtonProps {
  return { detail: MOVIE, scope: { kind: 'movie' }, rows: [], size: 'page', onNotice: vi.fn(), onChanged: vi.fn(), ...over };
}
const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/stream/downloads').map((c) => c.body);
const labels = (menu: HTMLElement) => [...menu.querySelectorAll('.mv-menu-label')].map((n) => n.textContent);

describe('DownloadButton: a film on its title page', () => {
  it('queues the film with no source named on a click, and says so', async () => {
    const p = props();
    render(<DownloadButton {...p} />);
    const button = screen.getByRole('button', { name: 'Download How to Make a Killing' });
    expect(button.getAttribute('data-tip')).toBe('Download How to Make a Killing to this machine: a 1080p torrent, else a cloud provider');
    fireEvent.click(button);
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([{ kind: 'movie', tmdb_id: 467905, via: 'auto' }]);
    expect(p.onNotice).toHaveBeenCalledWith('How to Make a Killing: download queued');
  });

  it('opens "Choose how to download <name>" with three choices, and each sends only its own source', async () => {
    const p = props();
    render(<DownloadButton {...p} />);
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Choose how to download How to Make a Killing' }));
    openMenu();
    const menu = screen.getByRole('menu', { name: 'Choose how to download How to Make a Killing' });
    expect(menu.querySelector('.mv-menu-head')?.textContent).toBe('Choose how to download How to Make a Killing');
    expect(labels(menu)).toEqual(['Best torrent (1080p)', 'Cloud', 'Pick a torrent…']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Best torrent/ }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('menu')).toBeNull();

    openMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Cloud/ }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(2));

    openMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Pick a torrent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Torrents of How to Make a Killing' });
    await waitFor(() => expect(dialog.querySelectorAll('.mt-row')).toHaveLength(1));
    expect(calls.some((c) => c.url === '/api/stream/torrents?kind=movie&tmdb_id=467905')).toBe(true);
    expect(within(dialog).queryByRole('button', { name: /^Play / })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: `Download ${CANDIDATE.name}` }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(posts()).toEqual([
      { kind: 'movie', tmdb_id: 467905, via: 'torrent' },
      { kind: 'movie', tmdb_id: 467905, via: 'cloud' },
      { kind: 'movie', tmdb_id: 467905, via: 'torrent', info_hash: HASH },
    ]);
  });

  it('closes the menu on Esc and on a click outside, sending nothing', () => {
    render(<DownloadButton {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download How to Make a Killing' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download How to Make a Killing' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe('DownloadButton: a season and an episode', () => {
  it('queues a whole season with no episode named, and its menu has no pick row', async () => {
    const p = props({ detail: SERIES, scope: { kind: 'season', season: 1 }, size: 'season' });
    render(<DownloadButton {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download MobLand season 1' }));
    expect(labels(screen.getByRole('menu', { name: 'Choose how to download MobLand season 1' }))).toEqual(['Best torrent (1080p)', 'Cloud']);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Download MobLand season 1' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([{ kind: 'tv', tmdb_id: 247718, season: 1, via: 'auto' }]);
  });

  it('queues one episode from its row, and its pick lists that episode', async () => {
    const p = props({ detail: SERIES, scope: { kind: 'episode', season: 1, episode: 3 }, size: 'row' });
    render(<DownloadButton {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download MobLand S01E03' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([{ kind: 'tv', tmdb_id: 247718, season: 1, episode: 3, via: 'auto' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download MobLand S01E03' }));
    expect(screen.getByRole('menu').className).toBe('mv-menu-list right');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pick a torrent/ }));
    await screen.findByRole('dialog', { name: 'Torrents of MobLand S01E03' });
    expect(calls.some((c) => c.url === '/api/stream/torrents?kind=tv&tmdb_id=247718&season=1&episode=3')).toBe(true);
  });
});

describe('DownloadButton: what it shows', () => {
  it('shows a bar and the percentage while downloading, and its X cancels', async () => {
    const p = props({ rows: [makeDownload({ id: downloadId(7), state: 'running', progress: 0.42 })] });
    render(<DownloadButton {...p} />);
    const bar = screen.getByRole('progressbar', { name: 'Download of How to Make a Killing' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByRole('button', { name: 'Download How to Make a Killing' }).getAttribute('data-tip')).toBe('How to Make a Killing: downloading from a torrent, 42%');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the download of How to Make a Killing' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/stream/downloads/7']);
    expect(p.onNotice).toHaveBeenCalledWith('How to Make a Killing: download cancelled');
    expect(posts()).toEqual([]);
  });

  it('shows a queued download as an empty bar with its X', () => {
    render(<DownloadButton {...props({ rows: [makeDownload({ state: 'queued', progress: 0, source: null })] })} />);
    const bar = screen.getByRole('progressbar', { name: 'Download of How to Make a Killing' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.className).toBe('mv-dl-bar queued');
    expect(screen.getByRole('button', { name: 'Download How to Make a Killing' }).getAttribute('data-tip')).toBe('How to Make a Killing: download queued, 0%');
    expect(screen.getByRole('button', { name: 'Cancel the download of How to Make a Killing' })).toBeTruthy();
  });

  it('says a whole download is on this machine, and a failed one why; a click then asks again', async () => {
    const p = props({ rows: [makeDownload({ state: 'done', progress: 1, bytes_total: 1.5 * 1024 ** 3 })] });
    const view = render(<DownloadButton {...p} />);
    const here = screen.getByRole('button', { name: 'Download How to Make a Killing' });
    expect(here.className.split(' ')).toContain('on');
    expect(here.getAttribute('data-tip')).toBe('How to Make a Killing is on this machine (torrent, 1.5 GB)');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull();
    fireEvent.click(here);
    expect(p.onNotice).toHaveBeenCalledWith('How to Make a Killing is already on this machine');
    expect(posts()).toEqual([]);

    view.rerender(<DownloadButton {...p} rows={[makeDownload({ state: 'failed', progress: 0, error: 'no_source' })]} />);
    const failed = screen.getByRole('button', { name: 'Download How to Make a Killing' });
    expect(failed.getAttribute('data-tip')).toBe('How to Make a Killing: the download failed (no torrent and no cloud source could be downloaded). Click to try again');
    fireEvent.click(failed);
    await waitFor(() => expect(posts()).toEqual([{ kind: 'movie', tmdb_id: 467905, via: 'auto' }]));
  });

  it("draws a season's bar as the mean of its episodes' rows", () => {
    const ep = (episode: number, over: Partial<DownloadView> = {}) => makeDownload({ title_id: SERIES.id, kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode, ...over });
    const rows = [ep(1, { state: 'done', progress: 1 }), ep(2, { state: 'running', progress: 0.5 }), ep(3, { state: 'queued', progress: 0, source: null })];
    render(<DownloadButton {...props({ detail: SERIES, scope: { kind: 'season', season: 1 }, size: 'season', rows })} />);
    expect(screen.getByRole('progressbar', { name: 'Download of MobLand season 1' }).getAttribute('aria-valuenow')).toBe('50');
  });
});
```
**Impact:** `npx vitest run web/src/components/movies/DownloadButton.test.tsx` must pass before Step 8.

### Step 8: The season head and the episode rows carry the button
**File:** `web/src/components/movies/EpisodeList.tsx` (as phase 7 left it)
**Change:**

**8a. Imports** — add one line after `import { PlayMenu, type PlayMenuProps } from './PlayMenu';` (line 6 today):
```tsx
import { DownloadButton, type DownloadsBinding } from './DownloadButton';
```
**8b. `EpisodeListProps`** — add after phase 7's `onSeasonStory?: (s: SeasonView) => void;` member (after `onStory` at line 32 if phase 7 has not landed):
```tsx
  /** The title's downloads (the Stream side with streaming on): each season head and episode row gets a Download button. Left out, none. */
  downloads?: DownloadsBinding | undefined;
```
**8c. `EpisodeList`'s destructuring** (line 91 today; phase 7's line 463) — append `downloads` after the last name, so it ends:
```tsx
… onTrailer, onStory, onSeasonStory, downloads }: EpisodeListProps) {
```
**8d. Season head** — insert one line immediately after the `<SeasonWatchedButton … />` line and before `{isFolded(s) && <span className="mv-dim mv-season-sum">…}` (line 125/126 today; phase 7's 498/499):
```tsx
            {downloads !== undefined && <DownloadButton detail={detail} scope={{ kind: 'season', season: s.season }} rows={downloads.rows} size="season" onNotice={downloads.onNotice} onChanged={downloads.onChanged} />}
```
**8e. Pass it to each row** — in the `<EpisodeItem … />` element, add after `onStory={onStory}`:
```tsx
                downloads={downloads}
```
**8f. `EpisodeItemProps`** (lines 166–182) — add after `onStory?: ((e: EpisodeView) => void) | undefined;`:
```tsx
  downloads?: DownloadsBinding | undefined;
```
**8g. `EpisodeItem`'s destructuring** (line 184) — replace with:
```tsx
function EpisodeItem({ detail, episode: e, focused, player, busy, side, streamEnabled, onPlay, onStream, onRun, starting, onWatched, onEpisodeWatched, onStory, downloads }: EpisodeItemProps) {
```
**8h. `.mv-row-play`** (lines 269–271) — after the `{onRun !== undefined && ( <PlayMenu … /> )}` block and before `</span>`, add:
```tsx
        {downloads !== undefined && (
          <DownloadButton detail={detail} scope={{ kind: 'episode', season: e.season, episode: e.episode }} rows={downloads.rows} size="row" onNotice={downloads.onNotice} onChanged={downloads.onChanged} />
        )}
```
**Impact:** without `downloads` (the Library side, every existing test) the list renders exactly as before. The episode row's grid (`Movies.css:135,138`) is unchanged: the button sits in the last, auto-width cell (`.mv-row-play`). The season head's `.mv-season-head > .pbtn:first-child` rule still matches the fold button only (the download button is wrapped in `.mv-dl`).

### Step 9: Test the list's placements and bars
**File:** `web/src/components/movies/EpisodeList.test.tsx`
**Change:** add `within` to the testing-library import on line 3 (`import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';`), add `import { makeDownload } from '../../testing/downloadFixtures';` after line 5, and append at the end of the file:
```tsx
describe('EpisodeList: downloads', () => {
  const binding = (rows = [] as ReturnType<typeof makeDownload>[]) => ({ rows, onNotice: noop, onChanged: noop });
  const rowOf = (code: string) => document.querySelector(`[data-episode="${code}"]`) as HTMLElement;

  it('puts a Download button on every season head and episode row only when the page hands it the downloads', () => {
    render(<EpisodeList {...props({ side: 'stream', streamEnabled: true })} />);
    expect(screen.queryByRole('button', { name: /^Download / })).toBeNull();
    cleanup();
    render(<EpisodeList {...props({ side: 'stream', streamEnabled: true, downloads: binding() })} />);
    for (const s of SERIES.seasons) expect(screen.getByRole('button', { name: `Download MobLand season ${s.season}` })).toBeTruthy();
    for (const e of season.episodes) {
      const code = `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
      expect(within(rowOf(code)).getByRole('button', { name: `Download MobLand ${code}` })).toBeTruthy();
    }
  });

  it('draws the bar on the season head and on the episode row the download belongs to, and nowhere else', () => {
    const rows = [makeDownload({ title_id: SERIES.id, kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode: 2, state: 'running', progress: 0.3 })];
    render(<EpisodeList {...props({ side: 'stream', streamEnabled: true, downloads: binding(rows) })} />);
    expect(screen.getByRole('progressbar', { name: 'Download of MobLand season 1' }).getAttribute('aria-valuenow')).toBe('30');
    // Phase 9's drive finds the season's bar inside the season head.
    expect(screen.getByRole('progressbar', { name: 'Download of MobLand season 1' }).closest('.mv-season-head')).not.toBeNull();
    expect(within(rowOf('S01E02')).getByRole('progressbar', { name: 'Download of MobLand S01E02' }).getAttribute('aria-valuenow')).toBe('30');
    expect(within(rowOf('S01E01')).queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Download of MobLand season 2' })).toBeNull();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });
});
```
**Impact:** none on the existing tests (they pass no `downloads`).

### Step 10: The title page reads the downloads once for the page and places the film's button
**File:** `web/src/components/movies/MovieDetail.tsx` (as phase 7 left it)
**Change:** one `useDownloads` per page, so every button on it shares one `GET` (R3.3); it asks only on the Stream side with streaming on, with the page's own refresh of the title (`refreshKey = d`) and every 2.5 s while something runs (R3.1). A film gets the head button beside Play; a series gets none at the head (Decisions: the season and episode rows carry it).

**10a. Imports** — add after `import { usePlayProgress } from '../../hooks/usePlayProgress';` (line 35):
```tsx
import { useDownloads } from '../../lib/downloads';
```
and after `import { EpisodeList } from './EpisodeList';` (line 37):
```tsx
import { DownloadButton, type DownloadsBinding } from './DownloadButton';
```
**10b. The hook** — insert after `const now = tileLive(d.id, player);` (line 104):
```tsx

  /** Downloads to this machine, Stream side with streaming on only: read with each refresh of the title, and every 2.5 s while one is queued, running or paused (useDownloads). */
  const downloadsOn = side === 'stream' && streamEnabled;
  const titleDownloads = useDownloads(downloadsOn ? d.id : null, d);
  const downloads: DownloadsBinding | undefined = downloadsOn ? { rows: titleDownloads.rows, onNotice: (text) => onNotice(text), onChanged: titleDownloads.reload } : undefined;
```
**10c. The film's head button** — insert after `{alt !== null && <StreamAltButton size="page" … />}` (line 309), before `<TrailerButton … />`:
```tsx
            {downloads !== undefined && d.kind === 'movie' && (
              <DownloadButton detail={d} scope={{ kind: 'movie' }} rows={downloads.rows} size="page" onNotice={downloads.onNotice} onChanged={downloads.onChanged} />
            )}
```
**10d. `EpisodeList`** — add after `onTrailer={setTrailer}` (line 395):
```tsx
          downloads={downloads}
```
**Impact:** the Library side and a daemon with streaming off render and ask exactly as before (`titleId` null: no `GET /api/stream/downloads`). `App.stream.test.tsx`'s fetch stub answers the new `GET` with 404, which the hook swallows (no rows, no polling), so its tests are unaffected.

### Step 11: Styles
**File:** `web/src/components/movies/Movies.css` — append after line 236.
**Code:**
```css
/* The Download button (Stream side): the icon, its caret (the play menu's), an X while it downloads, and a thin bar under them. */
.mv-dl { position: relative; display: inline-flex; align-items: center; }
.mv-dl-bar { position: absolute; left: 6px; right: 6px; bottom: -2px; height: 2px; background: var(--chip-bg); pointer-events: none; }
.mv-dl.page .mv-dl-bar { bottom: -4px; height: 3px; }
.mv-dl-bar > span { display: block; height: 100%; background: var(--fg); transition: width .4s; }
.mv-dl-bar.queued, .mv-dl-bar.paused { background: repeating-linear-gradient(90deg, var(--chip-bg) 0 4px, transparent 4px 8px); }
.mv-dl-bar.paused > span { background: var(--soft); }
.mv-dl-failed { color: var(--band-red); }
.mv-dl .mv-dl-cancel { color: var(--soft); }
.mv-dl .mv-dl-cancel:hover { color: var(--fg); }
.mv-dl.season .mv-dl-cancel, .mv-dl.row .mv-dl-cancel { width: 26px; font-size: 13px; }
.mv-dl.page .mv-dl-cancel { width: 32px; font-size: 16px; }
.mv-actions .mv-dl .ibtn:disabled, .mv-season-head .mv-dl .pbtn:disabled { opacity: .35; cursor: default; }
@media (prefers-reduced-motion: reduce) { .mv-dl-bar > span { transition: none; } }
```
**Impact:** none outside `.mv-dl`.

### Step 12: The Proof drive
**File:** `.claude/skills/verify-notesd/scripts/stream/download-buttons.steps.mjs` (new)
**Change:** the Playwright drive the Proof journeys J1–J7 run against a `verify.sh up --web --torrent` daemon (real routes and engine of phases 2–4, the loopback seeder, the fake index and TMDB). It logs `J<k> PASS …` per journey; the first failed check throws and fails the run.
**Code:**
```js
// Download buttons on the Stream-side title page (stream-downloads-season-story phase 8), end to end on a throwaway
// daemon (verify.sh up --web --torrent): the real wall, the real /api/stream/downloads routes and download engine, the
// loopback seeder's fixture film (the fake index lists it for every film), the fake TMDB. Chromium here, never the
// owner's streaming Chrome.
//   TORRENT=<the TORRENT= path `up` printed> verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/download-buttons.steps.mjs
// Logs "J1 PASS" .. "J7 PASS" and "NEIGHBOR PASS"; the first failed check throws and fails the run.
// J4 needs the seeded film to take longer than ~12 s to download (8 MB at the seeder's 200 kB/s does); with a faster
// fixture it fails saying so: rerun with TORRENT_FIXTURE_FILE=<a bigger video> on `up`.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const T = process.env.TORRENT

function check(ok, what) {
  if (!ok) throw new Error(what)
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

export default async ({ page, base, shot, log }) => {
  check(T && existsSync(path.join(T, 'fixture.json')), 'set TORRENT to the path `verify.sh up --torrent` printed')
  const FILM_HASH = JSON.parse(readFileSync(path.join(T, 'fixture.json'), 'utf8')).info_hash
  const origin = new URL(base).origin
  const seen = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/')) seen.push({ at: Date.now(), method: r.method(), path: u.pathname, search: u.search })
  })
  const gets = (pathname, since, until = Date.now()) => seen.filter((s) => s.method === 'GET' && s.path === pathname && s.at >= since && s.at <= until)
  const gaps = (list) => list.slice(1).map((s, i) => s.at - list[i].at)
  const ensure = async (kind, tmdb_id) => {
    const res = await page.request.post(`${base}/api/movies/ensure`, { headers: { origin }, data: { kind, tmdb_id } })
    check(res.ok(), `POST /api/movies/ensure ${kind} ${tmdb_id} answered ${res.status()} ${await res.text()}`)
  }
  const rows = async (title) => {
    const res = await page.request.get(`${base}/api/stream/downloads?title=${title}`)
    check(res.ok(), `GET /api/stream/downloads?title=${title} answered ${res.status()}`)
    return (await res.json()).downloads
  }
  const cancelAll = async (title) => {
    for (const r of await rows(title)) {
      if (['queued', 'running', 'paused'].includes(r.state)) await page.request.delete(`${base}/api/stream/downloads/${r.id}`, { headers: { origin } })
    }
  }
  const open = async (title, name) => {
    await page.goto(`${base}/movies/${title}?side=stream`)
    await page.getByRole('article', { name }).waitFor({ timeout: 20_000 })
  }
  /** Clicks, and answers the POST /api/stream/downloads it sent: its body, its status and how long the answer took from the click. */
  const posted = async (click) => {
    const t0 = Date.now()
    const [req] = await Promise.all([page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/stream/downloads'), click()])
    const res = await req.response()
    const ms = Date.now() - t0
    return { body: JSON.parse(req.postData() ?? 'null'), status: res?.status() ?? 0, ms, answer: res === null ? null : await res.json().catch(() => null) }
  }

  // J1 (R3.3): a title with nothing downloading asks GET /api/stream/downloads only with the page's own refresh of the title.
  await ensure('movie', 990004)
  const j1 = Date.now()
  await open('movie-990004', 'Oldboy')
  await page.waitForTimeout(15_000)
  const j1Downloads = gets('/api/stream/downloads', j1)
  const j1Detail = gets('/api/movies/movie-990004', j1)
  check(j1Downloads.length >= 1, 'the page asked its downloads once when it opened')
  check(j1Downloads.length <= j1Detail.length, `idle: ${j1Downloads.length} downloads asks but only ${j1Detail.length} reads of the title in 15 s`)
  await shot('j1-idle')
  log(`J1 PASS idle title page: ${j1Downloads.length} GET /api/stream/downloads vs ${j1Detail.length} GET /api/movies/movie-990004 in 15 s`)

  // J2 (R1.1): the film's Download button queues it through POST /api/stream/downloads, answered at once.
  await ensure('movie', 990001)
  await open('movie-990001', 'The Rivals of Amziah King')
  const j2 = await posted(() => page.getByRole('button', { name: 'Download The Rivals of Amziah King', exact: true }).click())
  check(JSON.stringify(j2.body) === JSON.stringify({ kind: 'movie', tmdb_id: 990001, via: 'auto' }), `the click sent ${JSON.stringify(j2.body)}`)
  check(j2.status === 202 || j2.status === 200, `POST answered ${j2.status}`)
  check(j2.ms < 2000, `POST took ${j2.ms} ms to answer`)
  const j2Rows = await rows('movie-990001')
  check(j2Rows.some((r) => r.kind === 'movie' && r.tmdb_id === 990001 && r.via === 'auto'), `GET lists no download of 990001: ${JSON.stringify(j2Rows)}`)
  const cancel = page.getByRole('button', { name: 'Cancel the download of The Rivals of Amziah King' })
  if (await cancel.isVisible({ timeout: 4000 }).catch(() => false)) {
    const [del] = await Promise.all([page.waitForRequest((r) => r.method() === 'DELETE' && new URL(r.url()).pathname.startsWith('/api/stream/downloads/')), cancel.click()])
    log(`J2 cancel sent ${del.method()} ${new URL(del.url()).pathname}`)
  }
  await cancelAll('movie-990001')
  log(`J2 PASS click -> POST ${JSON.stringify(j2.body)} answered ${j2.status} in ${j2.ms} ms; GET lists the row`)

  // J3 (R1.3): the caret's menu "Choose how to download <name>" offers three choices, and each sends only its source.
  const menuOf = async (name) => {
    await page.getByRole('button', { name: `Choose how to download ${name}`, exact: true }).click()
    const menu = page.getByRole('menu', { name: `Choose how to download ${name}` })
    await menu.waitFor()
    return menu
  }
  await ensure('movie', 467905)
  await open('movie-467905', 'How to Make a Killing')
  let menu = await menuOf('How to Make a Killing')
  check((await menu.locator('.mv-menu-head').textContent()) === 'Choose how to download How to Make a Killing', 'the menu is titled "Choose how to download How to Make a Killing"')
  const offered = await menu.locator('.mv-menu-label').allTextContents()
  check(JSON.stringify(offered) === JSON.stringify(['Best torrent (1080p)', 'Cloud', 'Pick a torrent…']), `the menu offers ${JSON.stringify(offered)}`)
  await shot('j3-menu')
  const best = await posted(() => menu.getByRole('menuitem', { name: /^Best torrent/ }).click())
  check(JSON.stringify(best.body) === JSON.stringify({ kind: 'movie', tmdb_id: 467905, via: 'torrent' }), `Best torrent sent ${JSON.stringify(best.body)}`)
  check((await rows('movie-467905')).every((r) => r.via === 'torrent' && r.source !== 'cloud'), 'a Best torrent download never names a cloud source')
  await cancelAll('movie-467905')

  await ensure('movie', 990002)
  await open('movie-990002', 'The Dog Stars')
  menu = await menuOf('The Dog Stars')
  const cloud = await posted(() => menu.getByRole('menuitem', { name: /^Cloud/ }).click())
  check(JSON.stringify(cloud.body) === JSON.stringify({ kind: 'movie', tmdb_id: 990002, via: 'cloud' }), `Cloud sent ${JSON.stringify(cloud.body)}`)
  check((await rows('movie-990002')).every((r) => r.via === 'cloud' && r.source !== 'torrent'), 'a Cloud download never names a torrent source')
  await cancelAll('movie-990002')

  await ensure('movie', 990003)
  await open('movie-990003', 'Bad Apples')
  menu = await menuOf('Bad Apples')
  await menu.getByRole('menuitem', { name: /^Pick a torrent/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Torrents of Bad Apples' })
  const pickRow = dialog.locator(`[data-hash="${FILM_HASH}"]`)
  await pickRow.waitFor({ timeout: 30_000 })
  check((await dialog.getByRole('button', { name: /^Play / }).count()) === 0, 'the pick list offers no Play')
  await shot('j3-pick')
  const pick = await posted(() => pickRow.locator('button[aria-label^="Download "]').click())
  check(JSON.stringify(pick.body) === JSON.stringify({ kind: 'movie', tmdb_id: 990003, via: 'torrent', info_hash: FILM_HASH }), `the pick sent ${JSON.stringify(pick.body)}`)
  const pickRows = await rows('movie-990003')
  check(pickRows.length >= 1 && pickRows.every((r) => r.via === 'torrent' && r.source !== 'cloud'), `the picked download is a torrent one: ${JSON.stringify(pickRows)}`)
  log('J3 PASS "Choose how to download …" offers Best torrent (1080p), Cloud, Pick a torrent…; each sent its own via (torrent / cloud / torrent + the picked info_hash) and no row named the other source')

  // J4 (R3.1, R3.3): while Bad Apples downloads, its bar shows and the page reads again at most 3 s apart; once whole, it stops asking.
  const bar = page.getByRole('progressbar', { name: 'Download of Bad Apples' })
  await bar.waitFor({ timeout: 20_000 })
  const v0 = Number(await bar.getAttribute('aria-valuenow'))
  const j4 = Date.now()
  await page.waitForTimeout(9_000)
  const live = gets('/api/stream/downloads', j4)
  check(live.length >= 3, `only ${live.length} reads in 9 s while downloading: the download ended too fast to watch (rerun with TORRENT_FIXTURE_FILE=<a bigger video>), or the page did not poll`)
  check(gaps(live).every((g) => g <= 3000), `reads were ${JSON.stringify(gaps(live))} ms apart`)
  const v1 = Number((await bar.getAttribute('aria-valuenow').catch(() => '100')) ?? '100')
  check(v1 >= v0, `the bar went back from ${v0} to ${v1}`)
  const tip = await page.getByRole('button', { name: 'Download Bad Apples', exact: true }).getAttribute('data-tip')
  await shot('j4-downloading')
  log(`J4 bar ${v0}% -> ${v1}%, tip "${tip}", reads ${JSON.stringify(gaps(live))} ms apart`)
  let state = ''
  for (let waited = 0; waited < 240_000; waited += 2000) {
    state = (await rows('movie-990003')).find((r) => r.tmdb_id === 990003)?.state ?? 'gone'
    if (state === 'done' || state === 'failed') break
    await page.waitForTimeout(2000)
  }
  check(state === 'done', `the picked torrent download ended ${state}`)
  await page.waitForTimeout(4000)
  const j4After = Date.now()
  await page.waitForTimeout(8000)
  check(gets('/api/stream/downloads', j4After).length === 0, 'the page kept asking after the download finished')
  check((await bar.count()) === 0, 'the bar is gone once the download is whole')
  await shot('j4-done')
  log(`J4 PASS bar shown, reads <= 3 s apart while downloading, none in 8 s once whole; button data-download=${await page.locator('.mv-dl.page').getAttribute('data-download')}`)

  // J5 (R2.2): an episode row's Download queues that episode only.
  await ensure('tv', 247718)
  await open('tv-247718', 'MobLand')
  const j5 = await posted(() => page.getByRole('button', { name: 'Download MobLand S01E02', exact: true }).click())
  check(JSON.stringify(j5.body) === JSON.stringify({ kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, via: 'auto' }), `the row sent ${JSON.stringify(j5.body)}`)
  check(j5.status === 202 || j5.status === 200, `POST answered ${j5.status}`)
  const j5Rows = (await rows('tv-247718')).filter((r) => r.season === 1)
  check(j5Rows.length >= 1 && j5Rows.every((r) => r.episode === 2), `the episode click made rows for ${JSON.stringify(j5Rows.map((r) => r.episode))}`)
  log('J5 PASS S01E02 row -> POST {season:1, episode:2}; GET lists season 1 episode 2 only')

  // J6 (R2.1): the season head's Download queues every aired episode of the season that is not whole here.
  const j6 = await posted(() => page.getByRole('button', { name: 'Download MobLand season 1', exact: true }).click())
  check(JSON.stringify(j6.body) === JSON.stringify({ kind: 'tv', tmdb_id: 247718, season: 1, via: 'auto' }) && !('episode' in j6.body), `the season sent ${JSON.stringify(j6.body)}`)
  check(j6.status === 202 || j6.status === 200, `POST answered ${j6.status}`)
  const j6Eps = [...new Set((await rows('tv-247718')).filter((r) => r.season === 1).map((r) => r.episode))]
  check(j6Eps.includes(1) && j6Eps.includes(3), `season 1 rows are for episodes ${JSON.stringify(j6Eps)}`)
  check(sameSet([...new Set([...j6Eps, 2])].sort(), [1, 2, 3]), `season 1 rows name an episode the season does not have: ${JSON.stringify(j6Eps)}`)
  await shot('j6-season')
  log(`J6 PASS season 1 head -> POST {season:1}, no episode; rows for episodes ${JSON.stringify(j6Eps.sort())} (MobLand season 1 has 3 aired)`)
  await cancelAll('tv-247718')

  // J7 (R3.1): the season row's and the episode row's bars, with GET /api/stream/downloads answered by a running S01E03
  // (the fixture pack downloads in a few seconds, too fast to watch); the page still reads every <= 3 s.
  let n = 0
  const stub = (url) => url.pathname === '/api/stream/downloads'
  await page.route(stub, (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    n += 1
    const progress = Math.min(0.9, 0.2 + 0.1 * n)
    return route.fulfill({
      json: { host: 'verify', active: true, downloads: [{ id: 900001, title_id: 'tv-247718', kind: 'tv', tmdb_id: 247718, season: 1, episode: 3, state: 'running', via: 'auto', source: 'torrent', progress, bytes_done: Math.round(progress * 1e9), bytes_total: 1e9, peers: 3, down_kbps: 900, error: null, batch: 'verify' }] },
    })
  })
  await open('tv-247718', 'MobLand')
  const seasonBar = page.getByRole('progressbar', { name: 'Download of MobLand season 1' })
  const episodeBar = page.locator('[data-episode="S01E03"]').getByRole('progressbar', { name: 'Download of MobLand S01E03' })
  await seasonBar.waitFor({ timeout: 10_000 })
  await episodeBar.waitFor({ timeout: 10_000 })
  check((await page.locator('[data-episode="S01E01"]').getByRole('progressbar').count()) === 0, 'S01E01 shows no bar')
  const j7 = Date.now()
  const s0 = Number(await seasonBar.getAttribute('aria-valuenow'))
  await page.waitForTimeout(8000)
  const s1 = Number(await seasonBar.getAttribute('aria-valuenow'))
  const e1 = Number(await episodeBar.getAttribute('aria-valuenow'))
  const j7Reads = gets('/api/stream/downloads', j7)
  check(j7Reads.length >= 3 && gaps(j7Reads).every((g) => g <= 3000), `reads were ${JSON.stringify(gaps(j7Reads))} ms apart`)
  check(s1 > s0 && s1 === e1, `season bar ${s0} -> ${s1}, episode bar ${e1}`)
  await shot('j7-series-bars')
  await page.unroute(stub)
  log(`J7 PASS season 1 bar and S01E03 bar move together (${s0}% -> ${s1}%), reads ${JSON.stringify(gaps(j7Reads))} ms apart`)

  // Neighbor: the Library side of the same title has no Download button and never asks the downloads.
  const nb = Date.now()
  await page.goto(`${base}/movies/movie-990004`)
  await page.getByRole('article', { name: 'Oldboy' }).waitFor({ timeout: 20_000 })
  await page.waitForTimeout(3000)
  check((await page.getByRole('button', { name: /^Download / }).count()) === 0, 'the Library side shows a Download button')
  check(gets('/api/stream/downloads', nb).length === 0, 'the Library side asked GET /api/stream/downloads')
  log('NEIGHBOR PASS the Library side shows no Download button and asks no downloads')
}
```
**Impact:** a new verify-notesd drive; nothing runs it but the Proof (phase 9 cites it from the feature map).

## Principles applied

- Laziness protocol: the torrent pick reuses `TorrentsModal` (one optional `onDownload` prop, `onPlay` made optional) instead of a second candidates list, and the menu reuses the play menu's `mv-menu-*` classes, so `isPlayMenuOpen` and the title pop-up's Esc rule cover the new menu with no change.
- Make illegal states unrepresentable: `DownloadStatus` is a discriminated union (a button cannot be "here" and "downloading" at once) and `DownloadScope` cannot give a season an episode; the pick row exists only where `downloadRef` returns a ref, so a season has no pick by type, not by a runtime check.
- Boundary discipline: rows are trusted as `fetchDownloads` (phase 4) normalized them; the component never re-validates `progress` or state strings. The only filter is by title (`kind`, `tmdb_id`), which is the scope rule, not validation.
- Prove it works / Sequence into verifiable units: Steps 3, 5, 7 and 9 each end in a runnable test of the step before; the Proof drives the real daemon's routes and engine through the real page (Step 12), not the unit tests alone.
- Test behavior, not implementation: every test asserts the request a click sends (URL, method, body), the count of `GET /api/stream/downloads`, or what a user sees by role and tip; none mocks the module under test (the real client functions run over a stubbed `fetch`).
- (R3.3 by construction) The hook's only clocks are the 2.5 s timer, armed only after an answer with a live row, and `refreshKey`, which is the page's own `TitleDetail`; `startAdaptivePoll` was not reused because it polls unconditionally.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npx vitest run web/src/lib/downloads.test.tsx web/src/components/movies/DownloadButton.test.tsx web/src/components/movies/EpisodeList.test.tsx web/src/components/movies/TorrentsModal.test.tsx web/src/App.stream.test.tsx web/src/App.movies.test.tsx && npm test`
**Proof:** the real wall built from this checkout, against a throwaway daemon with torrents on (phases 2–4's real routes and engine, the loopback seeder's 8 MB fixture film, the fake index listing it for every film, the fake TMDB), driven by Playwright through the buttons a user clicks; plus the jsdom suites for the asking rule under a fake clock.
- Harness: `.claude/skills/verify-notesd` — setup for J1–J7:
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  $V up --web --torrent          # prints RUN=…, TORRENT=…
  $V doctor $RUN
  TORRENT=<TORRENT from up> $V ui $RUN .claude/skills/verify-notesd/scripts/stream/download-buttons.steps.mjs
  $V sql $RUN "select kind, tmdb_id, season, episode, via, state, source, error from stream_downloads order by id"
  $V down $RUN
  ```
  Every `J<k> PASS` line is in the `ui` run's output and in `~/.local/state/notesd-verify/<RUN>/evidence/LOG.md`, with screenshots `j1-idle`, `j3-menu`, `j3-pick`, `j4-downloading`, `j4-done`, `j6-season`, `j7-series-bars`.
- Feature-map entries: none edited in this phase (phase 9 owns `features/{movies,direct-streaming}.md`; see Handoffs).
- Journeys:
  - **J1** · traces R3.3 — the `ui` drive above, section J1: `POST /api/movies/ensure {kind:"movie",tmdb_id:990004}`, open `/movies/movie-990004?side=stream`, wait 15 s, count the page's requests → passes when the log has `J1 PASS` with at least 1 and no more `GET /api/stream/downloads` than `GET /api/movies/movie-990004` in those 15 s (the page's own refresh is 60 s, so in practice exactly 1 and 1)
  - **J2** · traces R1.1 — section J2: on `/movies/movie-990001?side=stream` click the button named `Download The Rivals of Amziah King` → passes when the log has `J2 PASS`: the click sent exactly `POST /api/stream/downloads {"kind":"movie","tmdb_id":990001,"via":"auto"}`, answered 202 or 200 in under 2000 ms, and `GET /api/stream/downloads?title=movie-990001` lists a `movie` row of 990001 with `via` `auto`
  - **J3** · traces R1.3 — section J3: open the caret `Choose how to download How to Make a Killing`, then Best torrent; on The Dog Stars, Cloud; on Bad Apples, Pick a torrent… and the fixture's row's Download → passes when the log has `J3 PASS`: the menu's head reads `Choose how to download How to Make a Killing`, its labels are exactly `["Best torrent (1080p)","Cloud","Pick a torrent…"]`, the three POST bodies are `{via:"torrent"}`, `{via:"cloud"}` and `{via:"torrent",info_hash:<fixture.json info_hash>}`, the pick list has no Play button, and no torrent download's row names `source: "cloud"` nor the cloud one's `source: "torrent"`
  - **J4** · traces R3.1, R3.3 — section J4, on Bad Apples while the picked torrent downloads → passes when the log has `J4 PASS`: the `progressbar` named `Download of Bad Apples` is shown, at least 3 `GET /api/stream/downloads` in 9 s with every gap ≤ 3000 ms and a non-decreasing `aria-valuenow`; then once `GET` says `done`, zero `GET /api/stream/downloads` in the next 8 s, the bar is gone and `.mv-dl.page` has `data-download="here"`
  - **J5** · traces R2.2 — section J5: on `/movies/tv-247718?side=stream` click `Download MobLand S01E02` → passes when the log has `J5 PASS`: the body is exactly `{"kind":"tv","tmdb_id":247718,"season":1,"episode":2,"via":"auto"}`, answered 2xx, and every season-1 row `GET` lists is episode 2
  - **J6** · traces R2.1 — section J6: click `Download MobLand season 1` → passes when the log has `J6 PASS`: the body is exactly `{"kind":"tv","tmdb_id":247718,"season":1,"via":"auto"}` with no `episode` key, answered 2xx, and season 1's rows cover episodes 1 and 3 (2 was already queued by J5) and name no episode outside 1–3 (the fake TMDB's MobLand season 1 has 3 episodes, all aired 2025)
  - **J7** · traces R3.1 — section J7: Playwright answers `GET /api/stream/downloads` with a running S01E03 whose progress grows per read (the fixture pack downloads in seconds, too fast to watch), open MobLand → passes when the log has `J7 PASS`: the bars named `Download of MobLand season 1` and (inside `[data-episode="S01E03"]`) `Download of MobLand S01E03` are shown with equal, growing `aria-valuenow`, S01E01 has none, and the reads in 8 s are ≥ 3 with every gap ≤ 3000 ms
  - **J8** · traces R3.1, R3.3 — `npx vitest run web/src/lib/downloads.test.tsx` → passes when all tests pass: one ask and none in 60 s while idle, one more per `refreshKey` change only; every 2500 ms while active and none after the answer turns inactive; none while hidden and one at once on becoming visible; none with no title; a season's notice counts the episodes left out as not aired or undated
  - **J9** · traces R1.1, R1.3, R2.1, R2.2, R3.1 — `npx vitest run web/src/components/movies/DownloadButton.test.tsx web/src/components/movies/EpisodeList.test.tsx web/src/components/movies/TorrentsModal.test.tsx` → passes when all tests pass: the film click sends `{kind:"movie",tmdb_id:467905,via:"auto"}`, the menu's three rows send `torrent` / `cloud` / `torrent`+`info_hash`, the season sends `{season:1}` with no episode and has no pick row, the episode sends `{season:1,episode:3}`, the bars show on exactly the season head and the episode row (`aria-valuenow` 30), a season's bar is the mean (50), the X sends `DELETE /api/stream/downloads/7`
- Neighbor check: the play menu's torrent list and the title page's other buttons. `npx vitest run web/src/components/movies/TorrentsModal.test.tsx web/src/App.movies.test.tsx web/src/App.stream.test.tsx` passes unchanged (the list still plays a row by its hash; "Choose how to play …" still opens `Play … from`), and the drive's `NEIGHBOR PASS` line: the Library side of `movie-990004` shows no `Download …` button and sends no `GET /api/stream/downloads`.
- Cost: none billed (no LLM turn; fake index, fake TMDB, loopback seeder).
**Exit criteria:** `npm run typecheck` and `npm test` pass; on a `verify.sh up --web --torrent` run the drive logs `J1 PASS` through `J7 PASS` and `NEIGHBOR PASS`, and `stream_downloads` holds the rows the journeys asked for (990001 auto, 467905 torrent, 990002 cloud, 990003 torrent done, MobLand season 1 episodes 1–3).

## Handoffs

- **Phase 9 (feature map, guides, pictures):** add the Download buttons to `.claude/skills/verify-notesd/features/movies.md` (or `direct-streaming.md`) citing `scripts/stream/download-buttons.steps.mjs` (created here) and this phase's tests; describe the head / season / episode buttons, the "Choose how to download <name>" menu, the bars and cancel in `docs/guide/movies.md` and `docs/guide/streaming.md`; take the pictures (`docs:shots`: fixture pictures in the streaming guide; the movies guide's real-library title page only as a read-only `--live` retake, no download started for a picture). This phase changes what a user can do, but the plan index gives every `features/*.md` entry and guide to phase 9, so none is edited here.
- **Phase 4 (reconciled):** this phase imports phase 4's seam as **Requires** quotes it: `requestDownload(ask): Promise<DownloadQueued>` (the notice reads `created`), `fetchDownloads(titleId?, signal?)`, `cancelDownload(id: string)`, `DownloadView` (`id` a string uuid, opaque here), `DownloadRequest` (a three-way union, so `downloadBody` builds each variant itself). `?title=` takes `TitleDetail.id`; with it the answer includes the title's `done` rows still on this machine; `active` counts paused rows.
- **Phase 7:** none required; this phase anchors on code phase 7 leaves as is (see **Requires**). If phase 7's final season head differs from its plan, the season `DownloadButton` still goes immediately before the folded summary span.
- **Phase 5:** none. The Cache page keeps its own 15 s / 3 s refresh and does not use `useDownloads`.
- Not asked and left out: a Download button in the title pop-up (`MovieModal.tsx`) and on the guides' listed titles; a whole-series head button (Decisions table).

## Rollback

Revert this phase's commit: it adds four files and one steps file, and its edits to `MovieDetail.tsx`, `EpisodeList.tsx`, `TorrentsModal.tsx`, `Movies.css` and two test files are additive (one optional prop each). Nothing on the server or in the database changes, and downloads already queued keep running and stay visible on the Cache page (phase 5).
