import type { FileStateInput, PlayStateInput, TitleKind, WatchState } from './types.js';

/**
 * Watch state, derived at read time from a file row and its last play (MOVIES_LIBRARY_PLAN
 * R3.4). "Last play" is `MoviesRepo.lastPlay`: the newest play whose position is known, else the
 * newest play (whose position is then unknown). The same "reached the end" rule is written in SQL
 * in src/movies/repo.ts (`finishEventsSql`); tests/integration/movies.repo.int.test.ts proves the
 * two agree.
 */

/** A play at or past this share of the duration finishes the file. */
export const FINISHED_RATIO = 0.9;

/** The duration a position is measured against: the player's own reading, else ffprobe's. */
export function playDuration(file: FileStateInput, play: PlayStateInput): number | null {
  const duration = play.durationS ?? file.durationS;
  return duration !== null && duration > 0 ? duration : null;
}

/** True when the play's position is at least FINISHED_RATIO of the duration. */
export function reachedEnd(file: FileStateInput, play: PlayStateInput): boolean {
  if (play.positionS === null) return false;
  const duration = playDuration(file, play);
  return duration !== null && play.positionS >= FINISHED_RATIO * duration;
}

/**
 * - finished: manual flag, done signal, or the last play reached FINISHED_RATIO
 * - present file: in_progress when it was played (a position above 0, or opened with the
 *   position unknown), else unwatched
 * - deleted file: dropped when played partway, seen when only opened with the position unknown,
 *   removed_unwatched when never played (or left at 0)
 */
export function fileState(file: FileStateInput, lastPlay: PlayStateInput | null): WatchState {
  if (file.watchedAt !== null || file.doneAt !== null) return 'finished';
  if (lastPlay !== null && reachedEnd(file, lastPlay)) return 'finished';
  const positionUnknown = lastPlay !== null && lastPlay.positionS === null;
  const played = positionUnknown || (lastPlay !== null && lastPlay.positionS !== null && lastPlay.positionS > 0);
  if (file.deletedAt !== null) {
    if (!played) return 'removed_unwatched';
    return positionUnknown ? 'seen' : 'dropped';
  }
  return played ? 'in_progress' : 'unwatched';
}

/** Where Play/Resume starts: the last known position, or 0 when there is none or the file is finished. */
export function resumePosition(file: FileStateInput, lastPlay: PlayStateInput | null): number {
  if (lastPlay === null || lastPlay.positionS === null || lastPlay.positionS <= 0) return 0;
  if (fileState(file, lastPlay) === 'finished') return 0;
  return lastPlay.positionS;
}

/** For a movie with several files, the most-watched state of any of them wins. */
const MOVIE_PRECEDENCE: readonly WatchState[] = ['finished', 'in_progress', 'dropped', 'seen', 'unwatched', 'removed_unwatched'];

/**
 * A title's state from its files' states. `watched` is the title's own manual flag.
 * Movie: the first state of MOVIE_PRECEDENCE any file has. Series: finished when every file is;
 * in_progress when something was watched and a present file is still unfinished; unwatched or
 * removed_unwatched when nothing was watched; otherwise (watched, nothing present left to
 * watch) dropped when a file was dropped or deleted unwatched, else seen.
 */
export function titleState(kind: TitleKind, fileStates: readonly WatchState[], watched = false): WatchState {
  if (watched) return 'finished';
  if (fileStates.length === 0) return 'unwatched';
  if (kind === 'movie') return MOVIE_PRECEDENCE.find((s) => fileStates.includes(s)) ?? 'unwatched';
  if (fileStates.every((s) => s === 'finished')) return 'finished';
  const started = fileStates.some((s) => s === 'finished' || s === 'in_progress' || s === 'dropped' || s === 'seen');
  const presentUnfinished = fileStates.some((s) => s === 'in_progress' || s === 'unwatched');
  if (!started) return presentUnfinished ? 'unwatched' : 'removed_unwatched';
  if (presentUnfinished) return 'in_progress';
  if (fileStates.some((s) => s === 'dropped' || s === 'removed_unwatched')) return 'dropped';
  return 'seen';
}
