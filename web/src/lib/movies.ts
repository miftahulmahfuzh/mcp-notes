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
  StreamLiveSnapshot,
  StreamListResponse,
  StreamRef,
  StreamSourceView,
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
/** The Stream side (`?side=stream`): nothing there plays in VLC. */
export const STREAM_HINT = 'Posters and credits come from TMDB. Play streams the title full screen in the streaming Chrome.';
export const MOVIES_PILL_PLACEHOLDER = 'Ask about your movies';
export const MOVIES_OFF_TEXT = 'Movies are off on this daemon. Set NOTESD_MOVIES=on and NOTESD_MOVIES_ROOTS, then restart notesd.';
export const STREAM_HEADING = 'Stream.';
export const STREAM_OFF_TEXT =
  'Direct streaming is off on this machine. It runs with NOTESD_MOVIES on and NOTESD_DIRECT_STREAM unset or on; restart notesd after changing either.';
export const STREAM_OPENING_NOTICE = 'opening in the streaming Chrome';

/** Which side of `/movies` is shown: the files on your machines, or the titles verified to stream here. */
export type MoviesSide = 'library' | 'stream';

/** The unmatched list belongs to the Library side whatever the query says. */
export function sideOf(route: MoviesRoute): MoviesSide {
  return route.stream === true && !route.unmatched ? 'stream' : 'library';
}

/** The Stream side's empty grid: why it is empty and how a title gets onto it. */
export function streamEmptyText(freshDays: number): string {
  return `Nothing is verified to stream on this machine yet. A title shows here once a provider returned a playable stream for it on this machine in the last ${plural(freshDays, 'day')}: play one with /direct-stream <title> in Claude Code, or turn on the background prober (NOTESD_STREAM_PROBER=on) to fill this grid.`;
}
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

/** Gone: no file left on any machine. The tile is dimmed, never hidden. A Stream title has no file by design: never gone there. */
export function isGone(t: TitleListItem, side: MoviesSide = 'library'): boolean {
  return side === 'library' && t.file_count === 0;
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

/** The state pills a side shows: `gone` is about files, so the Stream side has none. */
export function stateFilters(side: MoviesSide): readonly { key: StateFilter; label: string }[] {
  return side === 'stream' ? STATE_FILTERS.filter((s) => s.key !== 'gone') : STATE_FILTERS;
}

export const KIND_FILTERS: readonly { key: KindFilter; label: string }[] = [
  { key: 'all', label: 'All kinds' },
  { key: 'movie', label: 'Films' },
  { key: 'tv', label: 'Series' },
];

/** `finished` includes `seen` (opened, position unknown). `gone` is about files, not state: it overlaps the others. */
export function matchesFilter(t: TitleListItem, f: MoviesFilter, side: MoviesSide = 'library'): boolean {
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
      return isGone(t, side);
  }
}

/** How many titles each state pill would show under the current kind and text filter. */
export function stateCounts(titles: TitleListItem[], f: MoviesFilter, side: MoviesSide = 'library'): Record<StateFilter, number> {
  const out: Record<StateFilter, number> = { all: 0, unwatched: 0, in_progress: 0, finished: 0, gone: 0 };
  for (const t of titles) {
    for (const s of STATE_FILTERS) if (matchesFilter(t, { ...f, state: s.key }, side)) out[s.key] += 1;
  }
  return out;
}

function rank(t: TitleListItem, side: MoviesSide): number {
  if (isGone(t, side)) return 3;
  if (t.state === 'in_progress') return 0;
  if (t.state === 'unwatched') return 1;
  return 2;
}

/** In progress first (what to continue), then unwatched (what to start), then finished, then gone; newest play, newest year, title. */
export function sortTitles(titles: TitleListItem[], side: MoviesSide = 'library'): TitleListItem[] {
  return [...titles].sort(
    (a, b) =>
      rank(a, side) - rank(b, side) ||
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

/** The followed VLC plays without video: what the page says, or null while it is fine. */
export function stalledText(player: PlayerState | null): string | null {
  const c = player?.current ?? null;
  if (c === null || c.video_stalled !== true) return null;
  return `VLC lost its picture at ${clock(c.position)} (the graphics driver was reset). Close that VLC window and press Play again; /trace-vlc-bug has the evidence.`;
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

/** A stream the page can start: the body of POST /api/stream/play, what it names (`S01E02`; '' for a film) and this machine's source row for it. */
export interface StreamTarget {
  ref: StreamRef;
  code: string;
  source: StreamSourceView | null;
}

/** This machine's source row for a film (season 0, episode 0) or one episode; null when none was ever recorded. */
export function sourceOf(d: TitleDetail, season: number, episode: number): StreamSourceView | null {
  return d.stream_sources.find((s) => s.season === season && s.episode === episode) ?? null;
}

export function episodeStreamTarget(d: TitleDetail, e: EpisodeView): StreamTarget {
  return {
    ref: { kind: 'tv', tmdb_id: d.tmdb_id, season: e.season, episode: e.episode },
    code: episodeCode(e.season, e.episode),
    source: sourceOf(d, e.season, e.episode),
  };
}

/**
 * What streaming the whole title starts: the film, or a series' first episode (season 1 on) that is
 * not finished, else its first episode. Null for a series with no episode listed.
 */
export function streamTarget(d: TitleDetail): StreamTarget | null {
  if (d.kind === 'movie') return { ref: { kind: 'movie', tmdb_id: d.tmdb_id }, code: '', source: sourceOf(d, 0, 0) };
  const episodes = d.seasons.filter((s) => s.season >= 1).flatMap((s) => s.episodes);
  const next = episodes.find((e) => e.state !== 'finished' && e.state !== 'seen') ?? episodes[0];
  return next === undefined ? null : episodeStreamTarget(d, next);
}

function isFresh(t: StreamTarget | null): t is StreamTarget {
  return t !== null && t.source !== null && t.source.fresh;
}

/**
 * The big Play button. File first (R5.5): a file on this machine always plays in VLC, and a fresh
 * stream is then the second icon. Without a file here it streams on the Stream side, or on the
 * Library side when a fresh source exists; otherwise it keeps today's disabled reason.
 */
export type TitleAction =
  | { kind: 'vlc'; plan: { kind: 'file'; file: FileView } | { kind: 'continue' }; stream: StreamTarget | null }
  | { kind: 'stream'; target: StreamTarget }
  | { kind: 'idle'; plan: { kind: 'elsewhere'; host: string } | { kind: 'none' } };

export function titleAction(d: TitleDetail, side: MoviesSide): TitleAction {
  const plan = playPlan(d);
  const target = streamTarget(d);
  if (plan.kind === 'file' || plan.kind === 'continue') return { kind: 'vlc', plan, stream: isFresh(target) ? target : null };
  if (target !== null && (side === 'stream' || isFresh(target))) return { kind: 'stream', target };
  return { kind: 'idle', plan };
}

/** One episode row's play icon, by the same rule as the title's. */
export type EpisodeAction = { kind: 'vlc'; file: FileView; stream: StreamTarget | null } | { kind: 'stream'; target: StreamTarget } | { kind: 'idle' };

export function episodeAction(d: TitleDetail, e: EpisodeView, side: MoviesSide): EpisodeAction {
  const file = primaryFile(e);
  const target = episodeStreamTarget(d, e);
  if (file !== null && file.available) return { kind: 'vlc', file, stream: isFresh(target) ? target : null };
  if (side === 'stream' || isFresh(target)) return { kind: 'stream', target };
  return { kind: 'idle' };
}

/** `VidFast · 2160p · English subtitle`. */
export function streamSourceText(s: StreamSourceView): string {
  const sub = s.en_subtitle === true ? 'English subtitle' : s.en_subtitle === false ? 'no English subtitle' : 'subtitle unknown';
  return [s.provider, s.best_height !== null ? `${s.best_height}p` : '', sub].filter((x) => x !== '').join(' · ');
}

/** The stream line on a title's page: provider, quality and English subtitle; null when there is nothing to say. */
export function streamLine(d: TitleDetail, side: MoviesSide): string | null {
  if (d.kind === 'tv') {
    const verified = new Set(d.stream_sources.filter((s) => s.fresh).map((s) => `${s.season}x${s.episode}`)).size;
    if (verified > 0) return `Stream: ${plural(verified, 'episode')} verified on this machine; any other episode is checked when you play it`;
    return side === 'stream' ? 'Stream: an episode is checked when you play it' : null;
  }
  const s = sourceOf(d, 0, 0);
  if (s !== null && s.fresh) return `Stream: ${streamSourceText(s)}`;
  if (s !== null && s.stale_at !== null) return `Stream: no source answered on ${dayText(s.stale_at)}`;
  return side === 'stream' ? 'Stream: not verified yet; Play checks it' : null;
}

/** A stream button's label: what it starts and from where, or why it cannot. */
export function streamLabel(t: StreamTarget, enabled: boolean): PlayButtonState {
  if (!enabled) return { label: 'Direct streaming is off on this machine', disabled: true };
  const what = t.code === '' ? 'Stream' : `Stream ${t.code}`;
  const s = t.source;
  if (s !== null && s.fresh) return { label: `${what} (${streamSourceText(s)})`, disabled: false };
  if (s !== null && s.stale_at !== null) return { label: `${what}: no source answered last time, try again`, disabled: false };
  return { label: `${what}: checked when it starts`, disabled: false };
}

/** What a failed stream play says. `no_source`: phase 5 marked the source stale, so a film leaves the Stream grid. */
export function streamErrorText(code: string, detail: string | null, t: StreamTarget, title: string): string {
  if (code === 'no_source') return t.code === '' ? `no provider could stream ${title} now; it leaves the Stream grid` : `no provider could stream ${t.code} now`;
  if (code === 'direct_stream_off') return 'direct streaming is off on this machine';
  return detail ?? `could not stream ${t.code === '' ? title : t.code} (${code})`;
}

/** A row's play icon. `what` names the row: `S01E02`, or `this file`. */
export function filePlayLabel(f: FileView, player: PlayerState | null, what: string): PlayButtonState {
  if (f.deleted) return { label: `${what} is deleted`, disabled: true };
  if (!f.available) return { label: `${what} is on ${f.host}`, disabled: true };
  if (player !== null && !player.available) return { label: PLAYER_OFF_LABEL, disabled: true };
  const at = f.resume_position_s;
  return { label: at > 0 ? `Resume ${what} at ${clock(at)}` : `Play ${what}`, disabled: false };
}

export const ALREADY_PLAYING_NOTICE = 'already open in VLC: brought to the front';

export type TileLive = 'playing' | 'paused' | 'stalled';

/** The followed VLC play, when it is this title: what its poster shows. A stopped VLC shows nothing. */
function vlcLive(titleId: string, player: PlayerState | null): TileLive | null {
  const c = player?.current ?? null;
  if (c === null || c.title_id !== titleId) return null;
  if (c.video_stalled === true) return 'stalled';
  return c.state === 'playing' ? 'playing' : c.state === 'paused' ? 'paused' : null;
}

/** The stream on screen in the player page, when it is this title. */
export function streamLive(titleId: string, player: PlayerState | null): StreamLiveSnapshot | null {
  const s = player?.stream ?? null;
  return s !== null && s.title_id === titleId ? s : null;
}

/** Where a title is on screen: the VLC notesd follows, or the stream player page. */
export type LivePlace = 'VLC' | 'the stream player';

/** What a title's poster shows while it is on screen: the followed VLC first, else its stream. Null when neither shows it. */
export function tileLive(titleId: string, player: PlayerState | null): TileLive | null {
  return vlcLive(titleId, player) ?? streamLive(titleId, player)?.state ?? null;
}

/** Where tileLive's answer is playing. */
export function tileLivePlace(titleId: string, player: PlayerState | null): LivePlace {
  return vlcLive(titleId, player) === null && streamLive(titleId, player) !== null ? 'the stream player' : 'VLC';
}

/** playing / paused when this episode is the one on screen (its file in the followed VLC, or its stream); else null. */
export function episodeLive(titleId: string, e: EpisodeView, player: PlayerState | null): TileLive | null {
  const c = player?.current ?? null;
  if (c !== null && e.files.some((f) => f.id === c.file_id)) return vlcLive(titleId, player);
  const s = streamLive(titleId, player);
  return s !== null && s.season === e.season && s.episode === e.episode ? s.state : null;
}

/** Any play notesd follows right now, in VLC or in the stream player: the page then re-reads every few seconds. */
export function anyLive(player: PlayerState | null): boolean {
  return player !== null && (player.current !== null || (player.stream ?? null) !== null);
}

export const TILE_LIVE_LABEL: Record<TileLive, string> = { playing: 'playing', paused: 'paused', stalled: 'no picture' };

export function startedNotice(f: FileView, already = false): string {
  if (already) return ALREADY_PLAYING_NOTICE;
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
  if (r.action === 'already_playing') return ALREADY_PLAYING_NOTICE;
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

/**
 * `focus`: an episode's movie id whose season is shown even when no machine holds a file of it.
 * The Stream side lists every season: any episode can be streamed, and is verified when clicked.
 */
export function seasonsShown(d: TitleDetail, focus: string | null = null, side: MoviesSide = 'library'): SeasonsShown {
  if (side === 'stream') return { seasons: d.seasons.filter((s) => s.episodes.length > 0), hidden: 0 };
  const seasons = d.seasons.filter((s) => s.episodes.some((e) => e.has_file || (focus !== null && e.movie_id === focus)));
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
  /** The Stream side's list; null until it is asked for (only on the Stream side). */
  stream: StreamListResponse | null;
  streamError: string | null;
}

export function isMoviesOff(s: MoviesView): boolean {
  return s.listError === 'movies_off' || s.detailError === 'movies_off' || s.unmatchedError === 'movies_off' || s.streamError === 'movies_off';
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

/** `M-23T4`, the id the owner reads and types (src/movies/ids.ts); the dash is required. */
const MOVIE_ID = /^M-[0-9A-Z]{4}$/;

/** `m-23t4` -> `M-23T4`; null for anything that is not a movie id. */
export function normalizeMovieId(input: string): string | null {
  const v = input.trim().toUpperCase();
  return MOVIE_ID.test(v) ? v : null;
}

/** `/movies/M-23T4`: the title's page, scrolled to the episode when the id is an episode's. */
export function movieIdHref(movieId: string): string {
  return `/movies/${encodeURIComponent(movieId)}`;
}

/** The episode of `d` that `movieId` names, or null (the id is the title's own, or someone else's). */
export function episodeByMovieId(d: TitleDetail, movieId: string | null): EpisodeView | null {
  if (movieId === null) return null;
  for (const s of d.seasons) for (const e of s.episodes) if (e.movie_id === movieId) return e;
  return null;
}

/**
 * Is `d` what `/movies/<segment>` asks for? The segment is a title id (`movie-467905`), the title's
 * movie id, or the movie id of one of its episodes.
 */
export function detailIsFor(d: TitleDetail | null, segment: string | null): d is TitleDetail {
  if (d === null || segment === null) return false;
  if (d.id === segment) return true;
  const movieId = normalizeMovieId(segment);
  return movieId !== null && (d.movie_id === movieId || episodeByMovieId(d, movieId) !== null);
}

export function moviesHeading(s: MoviesView, route: MoviesRoute): string {
  if (route.unmatched) return UNMATCHED_HEADING;
  if (detailIsFor(s.detail, route.title)) return `${s.detail.title}.`;
  if (route.title === null && sideOf(route) === 'stream') return STREAM_HEADING;
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
    if (!detailIsFor(s.detail, route.title)) return 'Loading.';
    return `${factsLine(s.detail)}.`;
  }
  if (sideOf(route) === 'stream') {
    if (s.streamError !== null) return moviesErrorText(s.streamError);
    if (s.stream === null) return 'Loading the Stream titles.';
    if (!s.stream.enabled) return 'Direct streaming is off on this machine.';
    const n = s.stream.titles.length;
    return n === 0 ? 'Nothing verified to stream on this machine yet.' : `${plural(n, 'title')} verified to stream on this machine in the last ${plural(s.stream.fresh_days, 'day')}.`;
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
 * `[Movies · unmatched files]`, or `[Movies · <title> (<year>) · <movie id>]` (`M-23T4`) once the open
 * title's detail is loaded (the bare title id before, and from a server without movie ids). The chat agent reads it with phase 7's movies_* tools.
 */
/** The pill's hint: the open title by name once its detail is loaded, so "this film" visibly has a meaning. */
export function moviesPillPlaceholder(route: MoviesRoute, detail: TitleDetail | null): string {
  if (!route.unmatched && detailIsFor(detail, route.title)) return `Ask about ${detail.title}`;
  return MOVIES_PILL_PLACEHOLDER;
}

/** How far the owner is into the open title, read when the question is sent: the spoiler line. */
export interface WatchPosition {
  /** Seconds. */
  at: number;
  of: number | null;
}

/**
 * Where the owner is in this title right now: the followed VLC when it shows this title (not
 * stopped), else its stream on screen, else a film's saved resume point. Null for a title that is finished, not started, or
 * a series nobody is playing (its position is per episode).
 */
export function watchPosition(d: TitleDetail | null, player: PlayerState | null): WatchPosition | null {
  if (d === null || d.watched || d.state === 'finished') return null;
  const c = player?.current ?? null;
  if (c !== null && c.title_id === d.id && c.state !== 'stopped') return { at: c.position, of: c.duration };
  const s = streamLive(d.id, player);
  if (s !== null) return { at: s.position, of: s.duration };
  if (d.kind === 'tv') return null;
  const plan = playPlan(d);
  if (plan.kind !== 'file' || !(plan.file.resume_position_s > 0)) return null;
  return { at: plan.file.resume_position_s, of: plan.file.duration_s };
}

/** What a question from the Movies page carries besides its text. */
export interface MoviesAskExtra {
  /** Where the owner is in the open title (watchPosition), so the answer holds back what comes after. */
  position?: WatchPosition | null;
  /** `person 1202689`: the TMDB id of the person an entity link asked about. */
  hint?: string | null;
}

export function moviesChatMessage(text: string, route: MoviesRoute, detail: TitleDetail | null, extra: MoviesAskExtra = {}): string {
  let where: string;
  if (route.unmatched) where = 'unmatched files';
  else if (route.title === null) where = sideOf(route) === 'stream' ? 'stream' : 'library';
  else if (detailIsFor(detail, route.title)) where = `${detail.title}${detail.year !== null ? ` (${detail.year})` : ''} · ${detail.movie_id ?? route.title}`;
  else where = route.title;
  const p = extra.position ?? null;
  const at = p === null ? '' : ` · at ${clock(p.at)}${p.of !== null && p.of > 0 ? ` of ${clock(p.of)}` : ''}`;
  const hint = extra.hint ? ` · ${extra.hint}` : '';
  return `[Movies · ${where}${at}${hint}]\n${text}`;
}

/** Something on a title's page that can be asked about with one click. */
export type MovieEntity =
  | { kind: 'person'; name: string; personId: number; /** "Ruth" for a cast member, "director" for crew; null when unknown. */ role: string | null; cast: boolean }
  | { kind: 'character'; name: string; actor: string; personId: number }
  | { kind: 'company'; name: string }
  | { kind: 'genre'; name: string };

const workWord = (d: TitleDetail): string => (d.kind === 'tv' ? 'series' : 'film');

/** The question an entity link sends. Never a pronoun for the person: a name does not say which. */
export function entityQuestion(e: MovieEntity, d: TitleDetail): string {
  const w = workWord(d);
  if (e.kind === 'genre') {
    return `Recommend other ${e.name} ${d.kind === 'tv' ? 'series' : 'films'} similar to ${d.title}: the same tone and premise, not just the genre. Prefer ones I have not seen, and say which are already in my library.`;
  }
  if (e.kind === 'character') return `Who is ${e.name}, played by ${e.actor}, in this ${w}?`;
  if (e.kind === 'company') return `Tell me about ${e.name} and list their other films and series. Mark the ones in my library.`;
  const role = e.role === null || e.role === '' ? '' : e.cast ? ` (${e.role} in this ${w})` : ` (${e.role} of this ${w})`;
  return `Tell me about ${e.name}${role} and list their other films and series. Mark the ones in my library.`;
}

/** What the Google icon under the answer searches for. */
export function entitySearchQuery(e: MovieEntity, d: TitleDetail): string {
  const title = `${d.title}${d.year !== null ? ` ${d.year}` : ''}`;
  if (e.kind === 'genre') return `${e.name} ${d.kind === 'tv' ? 'series' : 'films'} like ${title}`;
  if (e.kind === 'character') return `${e.name} ${title} character`;
  if (e.kind === 'company') return `${e.name} films and series`;
  return `${e.name} movies and series`;
}

/** A trailer the title page can show: the title's own, or one season's. */
export interface TrailerTarget {
  /** YouTube video id; null when TMDB lists no trailer, and the button searches YouTube instead. */
  key: string | null;
  /** What the trailer is of: "How to Make a Killing (2026)", "MobLand, season 1". */
  name: string;
  /** The button's label, which says whether it plays here or searches. */
  label: string;
  /** The YouTube search that stands in for a missing trailer. */
  searchUrl: string;
}

function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

/** The trailer of a title (`season` null) or of one season of a series. */
export function trailerTarget(d: TitleDetail, season: number | null = null): TrailerTarget {
  if (season === null) {
    const key = d.trailer_key;
    return {
      key,
      name: `${d.title}${d.year !== null ? ` (${d.year})` : ''}`,
      label: key !== null ? 'Watch the trailer' : 'Find the trailer on YouTube',
      searchUrl: youtubeSearchUrl(`${d.title}${d.year !== null ? ` ${d.year}` : ''} trailer`),
    };
  }
  const key = d.seasons.find((s) => s.season === season)?.trailer_key ?? null;
  return {
    key,
    name: `${d.title}, season ${season}`,
    label: key !== null ? `Watch the season ${season} trailer` : `Find the season ${season} trailer on YouTube`,
    searchUrl: youtubeSearchUrl(`${d.title} season ${season} trailer`),
  };
}

/** The YouTube player for a video id, on the domain that sets no cookies until it plays; it starts at once. */
export function trailerEmbedUrl(key: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0`;
}

export function trailerWatchUrl(key: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;
}

export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export function entityHint(e: MovieEntity): string | null {
  return e.kind === 'person' || e.kind === 'character' ? `person ${e.personId}` : null;
}

export function entityTip(e: MovieEntity): string {
  if (e.kind === 'genre') return `Find ${e.name} titles like this one`;
  if (e.kind === 'character') return `Ask who ${e.name} is`;
  return `Ask about ${e.name}`;
}

export interface CreditGroup {
  label: string;
  entities: MovieEntity[];
  /** People left out of a long list ("and 3 more"). */
  more: number;
}

/** creditRows, as entities to click instead of joined text. */
export function creditGroups(d: TitleDetail): CreditGroup[] {
  const crew = (label: string, role: string, people: CrewCredit[], limit = Number.POSITIVE_INFINITY): CreditGroup => ({
    label,
    entities: people.slice(0, limit).map((c) => ({ kind: 'person', name: c.name, personId: c.person_id, role, cast: false })),
    more: Math.max(0, people.length - limit),
  });
  const rows: CreditGroup[] = [];
  if (d.companies.length > 0) rows.push({ label: 'Studios', entities: d.companies.map((c) => ({ kind: 'company', name: c.name })), more: 0 });
  if (d.creators.length > 0) rows.push(crew('Created by', 'creator', d.creators));
  if (d.directors.length > 0) rows.push(crew('Directed by', 'director', d.directors));
  if (d.writers.length > 0) rows.push(crew('Written by', 'writer', d.writers));
  if (d.producers.length > 0) rows.push(crew('Produced by', 'producer', d.producers, PRODUCER_LIMIT));
  return rows;
}
