import type {
  CastCredit,
  ContinueEpisodeRef,
  ContinueResult,
  CrewCredit,
  EpisodeView,
  FileReason,
  FileView,
  MoviesStatusResponse,
  PlayerState,
  ProgressView,
  SeasonView,
  TitleDetail,
  TitleKind,
  TitleListItem,
  UnmatchedFile,
  WatchState,
} from '../moviesApi';
import type { MoviesRoute } from './route';

export const MOVIES_HEADING = 'Movies.';
export const UNMATCHED_HEADING = 'Unmatched.';
export const MOVIES_HINT = 'Posters and credits come from TMDB. Play opens VLC on the machine that holds the file.';
export const MOVIES_PILL_PLACEHOLDER = 'Ask about your movies';
export const MOVIES_OFF_TEXT = 'Movies are off on this daemon. Set NOTESD_MOVIES=on and NOTESD_MOVIES_ROOTS, then restart notesd.';
export const PLAYER_OFF_LABEL = 'VLC is not available on this machine';
/** Producers beyond this are counted ("and 12 more"): TMDB lists every executive producer. */
export const PRODUCER_LIMIT = 8;
/** Cast shown before the "show all" icon. */
export const CAST_LIMIT = 18;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const STATE_LABEL: Record<WatchState, string> = {
  finished: 'finished',
  in_progress: 'in progress',
  unwatched: 'unwatched',
  dropped: 'dropped',
  removed_unwatched: 'removed unwatched',
  seen: 'seen',
};

export function kindLabel(kind: TitleKind): string {
  return kind === 'movie' ? 'film' : 'series';
}

/** The chip on a poster. Unwatched shows nothing: a clean poster is the invitation. */
export function stateBadge(state: WatchState): string | null {
  return state === 'unwatched' ? null : STATE_LABEL[state];
}

/** Seconds -> `45:00` / `2:03:05`. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Minutes -> `1h 52m` / `2h` / `48m`; '' when unknown. */
export function runtimeText(min: number | null): string {
  if (min === null || min <= 0) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** `2026-02-20` (or a datetime starting with it) -> `Feb 20, 2026`, no time zone shift; '' when null. */
export function releaseText(iso: string | null): string {
  if (iso === null) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** An ISO datetime -> its local `Nov 4, 2026`. */
export function dayText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function sizeText(bytes: number | null): string {
  if (bytes === null) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** `S01E05`; '' when either number is unknown. */
export function episodeCode(season: number | null, episode: number | null): string {
  if (season === null || episode === null) return '';
  return `S${pad(season)}E${pad(episode)}`;
}

export function seasonsText(n: number | null): string {
  return n === null ? '' : plural(n, 'season');
}

/** Gone: no file left on any machine. The tile is dimmed, never hidden. */
export function isGone(t: TitleListItem): boolean {
  return t.file_count === 0;
}

/** The bar under a poster while a title is in progress: how far into a film, or the share of episodes finished. */
export function tileProgress(t: TitleListItem): number | null {
  if (t.state !== 'in_progress') return null;
  const p = t.progress;
  if (p.kind === 'movie') return p.ratio;
  const total = p.episodes_total ?? p.episodes_present;
  return total > 0 ? Math.min(1, p.episodes_finished / total) : null;
}

export type StateFilter = 'all' | 'unwatched' | 'in_progress' | 'finished' | 'gone';
export type KindFilter = 'all' | TitleKind;

export interface MoviesFilter {
  state: StateFilter;
  kind: KindFilter;
  text: string;
}

export const NO_MOVIES_FILTER: MoviesFilter = { state: 'all', kind: 'all', text: '' };

export const STATE_FILTERS: readonly { key: StateFilter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'unwatched', label: 'unwatched' },
  { key: 'in_progress', label: 'in progress' },
  { key: 'finished', label: 'finished' },
  { key: 'gone', label: 'gone' },
];

export const KIND_FILTERS: readonly { key: KindFilter; label: string }[] = [
  { key: 'all', label: 'All kinds' },
  { key: 'movie', label: 'Films' },
  { key: 'tv', label: 'Series' },
];

/** `finished` includes `seen` (opened, position unknown). `gone` is about files, not state: it overlaps the others. */
export function matchesFilter(t: TitleListItem, f: MoviesFilter): boolean {
  if (f.kind !== 'all' && t.kind !== f.kind) return false;
  const q = f.text.trim().toLowerCase();
  if (q !== '' && !`${t.title} ${t.year ?? ''}`.toLowerCase().includes(q)) return false;
  switch (f.state) {
    case 'all':
      return true;
    case 'unwatched':
      return t.state === 'unwatched';
    case 'in_progress':
      return t.state === 'in_progress';
    case 'finished':
      return t.state === 'finished' || t.state === 'seen';
    case 'gone':
      return isGone(t);
  }
}

/** How many titles each state pill would show under the current kind and text filter. */
export function stateCounts(titles: TitleListItem[], f: MoviesFilter): Record<StateFilter, number> {
  const out: Record<StateFilter, number> = { all: 0, unwatched: 0, in_progress: 0, finished: 0, gone: 0 };
  for (const t of titles) {
    for (const s of STATE_FILTERS) if (matchesFilter(t, { ...f, state: s.key })) out[s.key] += 1;
  }
  return out;
}

function rank(t: TitleListItem): number {
  if (isGone(t)) return 3;
  if (t.state === 'in_progress') return 0;
  if (t.state === 'unwatched') return 1;
  return 2;
}

/** In progress first (what to continue), then unwatched (what to start), then finished, then gone; newest play, newest year, title. */
export function sortTitles(titles: TitleListItem[]): TitleListItem[] {
  return [...titles].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.last_played_at ?? '').localeCompare(a.last_played_at ?? '') ||
      (b.year ?? 0) - (a.year ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

/** What the big Play button does. One shape per case, so a disabled reason never travels with a playable file. */
export type PlayPlan =
  | { kind: 'file'; file: FileView }
  | { kind: 'continue' }
  | { kind: 'elsewhere'; host: string }
  | { kind: 'none' };

export interface PlayButtonState {
  label: string;
  disabled: boolean;
}

/**
 * A film plays its most recently played file on this machine (the server resumes it, or starts over
 * when finished). A series asks phase 5's continue (resume the open episode, else the next one with
 * a file). With no present file here: `elsewhere` when another machine holds one, else `none`.
 */
export function playPlan(d: TitleDetail): PlayPlan {
  const present = d.files.filter((f) => !f.deleted);
  const here = present.filter((f) => f.available);
  const first = present[0];
  if (here.length === 0) return first !== undefined ? { kind: 'elsewhere', host: first.host } : { kind: 'none' };
  if (d.kind === 'tv') return { kind: 'continue' };
  const file = here.reduce((best, f) => ((f.last_played_at ?? '') > (best.last_played_at ?? '') ? f : best));
  return { kind: 'file', file };
}

export function playLabel(plan: PlayPlan, player: PlayerState | null): PlayButtonState {
  if (plan.kind === 'none') return { label: 'No file left to play', disabled: true };
  if (plan.kind === 'elsewhere') return { label: `On ${plan.host}: play it on that machine`, disabled: true };
  if (player !== null && !player.available) return { label: PLAYER_OFF_LABEL, disabled: true };
  if (plan.kind === 'continue') return { label: 'Continue: resume the open episode or play the next one', disabled: false };
  const at = plan.file.resume_position_s;
  return { label: at > 0 ? `Resume at ${clock(at)}` : 'Play', disabled: false };
}

/** A row's play icon. `what` names the row: `S01E02`, or `this file`. */
export function filePlayLabel(f: FileView, player: PlayerState | null, what: string): PlayButtonState {
  if (f.deleted) return { label: `${what} is deleted`, disabled: true };
  if (!f.available) return { label: `${what} is on ${f.host}`, disabled: true };
  if (player !== null && !player.available) return { label: PLAYER_OFF_LABEL, disabled: true };
  const at = f.resume_position_s;
  return { label: at > 0 ? `Resume ${what} at ${clock(at)}` : `Play ${what}`, disabled: false };
}

export function startedNotice(f: FileView): string {
  return f.resume_position_s > 0 ? `resuming at ${clock(f.resume_position_s)}` : 'playing in VLC';
}

/** `detail` is the server's sentence: for `player_unavailable` it names the cause (no vlc.exe, no free port, ...). */
export function playErrorText(code: string, detail: string | null = null): string {
  if (code === 'not_on_this_machine') return 'that file is on another machine';
  if (code === 'player_unavailable') return detail ?? PLAYER_OFF_LABEL;
  if (code === 'file_missing') return 'the file is gone from disk; rescan to update the library';
  if (code === 'not_found') return 'no such file';
  return `could not play (${code})`;
}

function refCode(e: ContinueEpisodeRef): string {
  return episodeCode(e.season, e.episode);
}

export function continueNotice(r: ContinueResult): string {
  if (r.action === 'resumed' || r.action === 'started') {
    const what = episodeCode(r.file.season, r.file.episode) || 'it';
    if (r.action === 'started') return `playing ${what}`;
    return r.position > 0 ? `resuming ${what} at ${clock(r.position)}` : `resuming ${what}`;
  }
  if (r.action === 'missing') {
    const miss = refCode(r.missing) || 'the next episode';
    const have = r.present.map(refCode).filter((c) => c !== '').join(', ');
    return have ? `${miss} is not on this machine; ${have} ${r.present.length === 1 ? 'is' : 'are'}` : `${miss} is not on this machine`;
  }
  if (r.action === 'nothing') return r.reason === 'finished' ? 'already finished' : r.reason === 'caught_up' ? 'caught up: nothing after the last episode' : 'nothing to continue';
  return 'nothing to continue';
}

/** Progress text of a file or episode: `in progress · 40%`, else the state's label. */
export function meterText(state: WatchState, p: ProgressView): string {
  return state === 'in_progress' && p.ratio !== null ? `${STATE_LABEL[state]} · ${Math.round(p.ratio * 100)}%` : STATE_LABEL[state];
}

export function meterRatio(state: WatchState, p: ProgressView): number {
  if (state === 'finished') return 1;
  return p.ratio === null ? 0 : Math.min(1, Math.max(0, p.ratio));
}

/** The file an episode's row speaks for: phase 4's primary file. */
export function primaryFile(e: EpisodeView): FileView | null {
  return e.files.find((f) => f.id === e.file_id) ?? e.files[0] ?? null;
}

export interface SeasonsShown {
  seasons: SeasonView[];
  /** Seasons with no file on any machine: counted, not listed (a long series would list hundreds of empty rows). */
  hidden: number;
}

export function seasonsShown(d: TitleDetail): SeasonsShown {
  const seasons = d.seasons.filter((s) => s.episodes.some((e) => e.has_file));
  return { seasons, hidden: d.seasons.length - seasons.length };
}

export function namesText(people: (CrewCredit | CastCredit)[], limit = Number.POSITIVE_INFINITY): string {
  const shown = people.slice(0, limit).map((c) => c.name).join(', ');
  return people.length > limit ? `${shown} and ${people.length - limit} more` : shown;
}

/** The credits block: studios, then the crew the owner asked for. Empty groups are left out. */
export function creditRows(d: TitleDetail): [string, string][] {
  const rows: [string, string][] = [];
  if (d.companies.length > 0) rows.push(['Studios', d.companies.map((c) => c.name).join(', ')]);
  if (d.creators.length > 0) rows.push(['Created by', namesText(d.creators)]);
  if (d.directors.length > 0) rows.push(['Directed by', namesText(d.directors)]);
  if (d.writers.length > 0) rows.push(['Written by', namesText(d.writers)]);
  if (d.producers.length > 0) rows.push(['Produced by', namesText(d.producers, PRODUCER_LIMIT)]);
  return rows;
}

const REASON_TEXT: Record<FileReason, string> = {
  too_short: 'shorter than 15 minutes',
  no_match: 'no TMDB match',
  low_confidence: 'TMDB match not confident',
  tmdb_error: 'TMDB could not be reached',
  no_tmdb_credentials: 'no TMDB credentials',
  probe_failed: 'ffprobe could not read it',
};

export function reasonText(reason: FileReason | null, status: UnmatchedFile['status']): string {
  if (reason !== null) return REASON_TEXT[reason] ?? reason;
  return status === 'pending' ? 'waiting for the next scan' : 'unmatched';
}

/** `2026 · film · 1h 52m · in progress`. */
export function factsLine(d: TitleDetail): string {
  const length = d.kind === 'tv' ? seasonsText(d.season_count) : runtimeText(d.runtime_min);
  return [d.year === null ? '' : String(d.year), kindLabel(d.kind), length, STATE_LABEL[d.state]].filter((s) => s !== '').join(' · ');
}

/** What the header and the page read from the store (structurally `MoviesStore` minus its actions). */
export interface MoviesView {
  titles: TitleListItem[] | null;
  listError: string | null;
  detail: TitleDetail | null;
  detailError: string | null;
  unmatched: UnmatchedFile[] | null;
  unmatchedError: string | null;
  status: MoviesStatusResponse | null;
}

export function isMoviesOff(s: MoviesView): boolean {
  return s.listError === 'movies_off' || s.detailError === 'movies_off' || s.unmatchedError === 'movies_off';
}

export function moviesErrorText(code: string, titleId: string | null = null): string {
  if (code === 'movies_off') return MOVIES_OFF_TEXT;
  if (code === 'not_found') return titleId ? `No title ${titleId} in the library.` : 'Not found.';
  return `Could not load the movies library (${code}).`;
}

export function emptyLibraryText(status: MoviesStatusResponse | null): string {
  if (status === null) return 'No titles yet.';
  if (status.roots.length === 0) return 'No library folders are set on this machine. Add them to NOTESD_MOVIES_ROOTS and restart notesd.';
  const tmdb =
    status.tmdb === 'no_credentials'
      ? ' TMDB credentials are missing, so every file waits in the unmatched list.'
      : status.tmdb === 'unreachable'
        ? ' TMDB could not be reached; new files wait and are retried on the next pass.'
        : '';
  return `No titles yet. notesd scans ${status.roots.join(' and ')} every few minutes; the arrows above rescan now.${tmdb}`;
}

/** Files waiting for a hand: unmatched plus pending, on this machine. Null until the status answers. */
export function unmatchedCount(status: MoviesStatusResponse | null): number | null {
  return status === null ? null : status.counts.unmatched_here + status.counts.pending_here;
}

export function moviesHeading(s: MoviesView, route: MoviesRoute): string {
  if (route.unmatched) return UNMATCHED_HEADING;
  if (route.title !== null && s.detail !== null && s.detail.id === route.title) return `${s.detail.title}.`;
  return MOVIES_HEADING;
}

export function moviesCountLine(s: MoviesView, route: MoviesRoute): string {
  if (isMoviesOff(s)) return 'Movies are off on this daemon.';
  if (route.unmatched) {
    if (s.unmatchedError !== null) return moviesErrorText(s.unmatchedError);
    if (s.unmatched === null) return 'Loading unmatched files.';
    const n = s.unmatched.length;
    return n === 0 ? 'Every file on this machine matched a title.' : `${plural(n, 'file')} on this machine matched no title. Assign one by hand.`;
  }
  if (route.title !== null) {
    if (s.detailError !== null) return moviesErrorText(s.detailError, route.title);
    if (s.detail === null || s.detail.id !== route.title) return 'Loading.';
    return `${factsLine(s.detail)}.`;
  }
  if (s.listError !== null) return moviesErrorText(s.listError);
  if (s.titles === null) return 'Loading the library.';
  if (s.titles.length === 0) return 'No titles yet.';
  const films = s.titles.filter((t) => t.kind === 'movie').length;
  const series = s.titles.length - films;
  const going = s.titles.filter((t) => t.state === 'in_progress').length;
  return `${plural(s.titles.length, 'title')}: ${plural(films, 'film')}, ${series} series.${going > 0 ? ` ${going} in progress.` : ''}`;
}

/**
 * The chat bar has no page field (POST /api/chat carries message, thread_id, image_ids). The page's
 * context rides on the message's first line, as on Seer Adversarial: `[Movies · library]`,
 * `[Movies · unmatched files]`, or `[Movies · <title> (<year>) · <title id>]` once the open title's
 * detail is loaded (the bare id before). The chat agent reads it with phase 7's movies_* tools.
 */
export function moviesChatMessage(text: string, route: MoviesRoute, detail: TitleDetail | null): string {
  let where: string;
  if (route.unmatched) where = 'unmatched files';
  else if (route.title === null) where = 'library';
  else if (detail !== null && detail.id === route.title) where = `${detail.title}${detail.year !== null ? ` (${detail.year})` : ''} · ${route.title}`;
  else where = route.title;
  return `[Movies · ${where}]\n${text}`;
}
