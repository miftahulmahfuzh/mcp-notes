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
 * unfinished episode after it); or nothing: `caught_up` (no episode after the last one played) and
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
  if (last === null) return aired(first, 'first');
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
