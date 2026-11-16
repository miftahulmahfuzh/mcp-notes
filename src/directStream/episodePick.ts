import type { WatchState } from '../movies/types.js';

/** One episode of a series as the pick reads it: its watch state (files and streams, movies/read.ts) and when it was last played. */
export interface EpisodeProgress {
  season: number;
  episode: number;
  state: WatchState;
  /** ISO; null: never played. */
  lastPlayedAt: string | null;
  /** `YYYY-MM-DD`; null: unknown. */
  airDate: string | null;
}

export interface EpisodeRef {
  season: number;
  episode: number;
}

/**
 * Which episode a series named without one streams:
 * `first` (nothing played yet), `resume` (the episode played last is unfinished), `next` (the first
 * unfinished episode after it, or after the episodes marked finished when none was played); or nothing: `caught_up` (no episode after the last one played) and
 * `not_aired` (the episode to play airs after today).
 */
export type EpisodeChoice =
  | ({ pick: 'first' | 'resume' | 'next' } & EpisodeRef)
  | { pick: 'caught_up'; last: EpisodeRef }
  | ({ pick: 'not_aired'; airDate: string } & EpisodeRef);

function inOrder(a: EpisodeRef, b: EpisodeRef): number {
  return a.season - b.season || a.episode - b.episode;
}

/**
 * The episode to stream for a series named without one. Specials (season 0) are never picked. A
 * series with no known episode starts at season 1, episode 1. `today` is `YYYY-MM-DD`.
 */
export function pickEpisode(episodes: readonly EpisodeProgress[], today: string): EpisodeChoice {
  const list = episodes.filter((e) => e.season >= 1).sort(inOrder);
  const first = list[0];
  if (first === undefined) return { pick: 'first', season: 1, episode: 1 };
  const aired = (e: EpisodeProgress, pick: 'first' | 'resume' | 'next'): EpisodeChoice =>
    e.airDate !== null && e.airDate > today
      ? { pick: 'not_aired', season: e.season, episode: e.episode, airDate: e.airDate }
      : { pick, season: e.season, episode: e.episode };

  let last: EpisodeProgress | null = null;
  for (const e of list) {
    if (e.lastPlayedAt !== null && (last === null || last.lastPlayedAt === null || e.lastPlayedAt >= last.lastPlayedAt)) last = e;
  }
  if (last === null) {
    // Nothing was played, but the owner may have marked episodes finished ("I watched season 1 last year").
    const open = list.find((e) => e.state !== 'finished');
    if (open === undefined) {
      const end = list[list.length - 1] ?? first;
      return { pick: 'caught_up', last: { season: end.season, episode: end.episode } };
    }
    return aired(open, open === first ? 'first' : 'next');
  }
  if (last.state !== 'finished') return { pick: 'resume', season: last.season, episode: last.episode };
  const played = last;
  const next = list.find((e) => inOrder(e, played) > 0 && e.state !== 'finished');
  return next === undefined ? { pick: 'caught_up', last: { season: played.season, episode: played.episode } } : aired(next, 'next');
}

/** `stored` plus the episodes only `listed` names (unwatched): a series still airing has episodes newer than its stored list. */
export function withListedEpisodes(stored: readonly EpisodeProgress[], listed: readonly (EpisodeRef & { airDate: string | null })[]): EpisodeProgress[] {
  const known = new Set(stored.map((e) => `${e.season}x${e.episode}`));
  return [
    ...stored,
    ...listed
      .filter((e) => !known.has(`${e.season}x${e.episode}`))
      .map((e) => ({ season: e.season, episode: e.episode, state: 'unwatched' as const, lastPlayedAt: null, airDate: e.airDate })),
  ];
}

/** How an absolute episode number was read: `count`, the n-th episode over seasons 1 and up; `number`, the episode whose own number is n. */
export type AbsoluteReading = 'count' | 'number';

export type AbsoluteChoice =
  | ({ pick: 'absolute' } & EpisodeRef)
  /** The two readings name different episodes: nothing is certain, so nothing starts. */
  | { pick: 'unclear'; candidates: (EpisodeRef & { reading: AbsoluteReading })[] }
  | { pick: 'unknown'; /** Episodes in seasons 1 and up. */ episodes: number };

/**
 * The season and episode of an episode named by one number alone ("One Piece episode 730").
 * Two readings: the n-th episode counted over seasons 1 and up in order (absoluteToSeasonEpisode,
 * the rule a file named "One Piece - 730" is placed by), and the episode whose own number is n
 * (a long anime's numbers run on across seasons). The answer is certain when the counted episode
 * is also numbered n in its season, or when no episode is numbered n; otherwise both readings come
 * back as candidates. Specials (season 0) never count.
 */
export function pickAbsoluteEpisode(episodes: readonly EpisodeRef[], n: number): AbsoluteChoice {
  const list = episodes.filter((e) => e.season >= 1).sort(inOrder);
  const counted = Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined;
  const numbered = list.filter((e) => e.episode === n);
  if (counted === undefined) {
    const [only] = numbered;
    return numbered.length === 1 && only !== undefined ? { pick: 'absolute', season: only.season, episode: only.episode } : { pick: 'unknown', episodes: list.length };
  }
  if (numbered.length === 0 || numbered.some((e) => inOrder(e, counted) === 0)) return { pick: 'absolute', season: counted.season, episode: counted.episode };
  return {
    pick: 'unclear',
    candidates: [
      { season: counted.season, episode: counted.episode, reading: 'count' },
      ...numbered.map((e) => ({ season: e.season, episode: e.episode, reading: 'number' as const })),
    ],
  };
}
