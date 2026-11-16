import { describe, expect, it } from 'vitest';
import { pickAbsoluteEpisode, pickEpisode, pickEpisodeInSeason, withListedEpisodes, type EpisodeProgress } from '../../../src/directStream/episodePick.js';

const TODAY = '2026-11-16';
const ep = (season: number, episode: number, state: EpisodeProgress['state'] = 'unwatched', lastPlayedAt: string | null = null, airDate: string | null = null): EpisodeProgress => ({
  season, episode, state, lastPlayedAt, airDate,
});

describe('pickEpisode', () => {
  it('starts at the first episode when nothing was played, skipping specials, and at 1x1 when no episode is known', () => {
    expect(pickEpisode([ep(1, 2), ep(0, 1), ep(1, 1)], TODAY)).toEqual({ pick: 'first', season: 1, episode: 1 });
    expect(pickEpisode([], TODAY)).toEqual({ pick: 'first', season: 1, episode: 1 });
    expect(pickEpisode([ep(0, 1, 'finished', '2026-11-01T00:00:00.000Z')], TODAY)).toEqual({ pick: 'first', season: 1, episode: 1 });
  });

  it('resumes the episode played last while it is unfinished', () => {
    const list = [ep(1, 1, 'finished', '2026-11-10T00:00:00.000Z'), ep(1, 2, 'in_progress', '2026-11-12T00:00:00.000Z'), ep(1, 3, 'in_progress', '2026-11-11T00:00:00.000Z')];
    expect(pickEpisode(list, TODAY)).toEqual({ pick: 'resume', season: 1, episode: 2 });
    // Opened in VLC with no position known: still the one to carry on.
    expect(pickEpisode([ep(1, 1, 'seen', '2026-11-10T00:00:00.000Z'), ep(1, 2)], TODAY)).toEqual({ pick: 'resume', season: 1, episode: 1 });
  });

  it('takes the first unfinished episode after the last finished one, across seasons', () => {
    const list = [ep(1, 1, 'finished', '2026-11-10T00:00:00.000Z'), ep(1, 2, 'finished', '2026-11-12T00:00:00.000Z'), ep(1, 3, 'finished'), ep(2, 1)];
    expect(pickEpisode(list, TODAY)).toEqual({ pick: 'next', season: 2, episode: 1 });
  });

  it('says caught_up when nothing unfinished comes after the last episode played', () => {
    const list = [ep(1, 1), ep(1, 2, 'finished', '2026-11-12T00:00:00.000Z')];
    expect(pickEpisode(list, TODAY)).toEqual({ pick: 'caught_up', last: { season: 1, episode: 2 } });
  });

  it('does not start an episode that airs after today; one that airs today starts', () => {
    const played = ep(1, 1, 'finished', '2026-11-12T00:00:00.000Z');
    expect(pickEpisode([played, ep(1, 2, 'unwatched', null, '2026-11-20')], TODAY)).toEqual({ pick: 'not_aired', season: 1, episode: 2, airDate: '2026-11-20' });
    expect(pickEpisode([played, ep(1, 2, 'unwatched', null, TODAY)], TODAY)).toEqual({ pick: 'next', season: 1, episode: 2 });
    expect(pickEpisode([ep(1, 1, 'unwatched', null, '2027-01-01')], TODAY)).toEqual({ pick: 'not_aired', season: 1, episode: 1, airDate: '2027-01-01' });
  });
});

describe('withListedEpisodes', () => {
  it('adds the episodes only the list names as unwatched, and keeps the stored ones as they are', () => {
    const stored = [ep(1, 1, 'finished', '2026-11-12T00:00:00.000Z', '2026-10-09')];
    expect(withListedEpisodes(stored, [{ season: 1, episode: 1, airDate: null }, { season: 1, episode: 2, airDate: '2026-10-16' }])).toEqual([
      stored[0],
      ep(1, 2, 'unwatched', null, '2026-10-16'),
    ]);
  });
});

describe('pickEpisode with episodes marked finished and never played', () => {
  it('starts after a season the owner marked finished, and says caught_up when every episode is marked', () => {
    const marked = [ep(1, 1, 'finished'), ep(1, 2, 'finished'), ep(2, 1), ep(2, 2)];
    expect(pickEpisode(marked, TODAY)).toEqual({ pick: 'next', season: 2, episode: 1 });
    expect(pickEpisode([ep(1, 1, 'finished'), ep(1, 2, 'finished')], TODAY)).toEqual({ pick: 'caught_up', last: { season: 1, episode: 2 } });
  });
});

describe('pickAbsoluteEpisode', () => {
  const range = (season: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ season, episode: from + i }));

  it('maps a running number to its season when the numbers run on across seasons (One Piece)', () => {
    const onePiece = [{ season: 0, episode: 1 }, ...range(1, 1, 61), ...range(2, 62, 77), ...range(3, 78, 92)];
    expect(pickAbsoluteEpisode(onePiece, 70)).toEqual({ pick: 'absolute', season: 2, episode: 70 });
    expect(pickAbsoluteEpisode(onePiece, 92)).toEqual({ pick: 'absolute', season: 3, episode: 92 });
    expect(pickAbsoluteEpisode(onePiece, 93)).toEqual({ pick: 'unknown', episodes: 92 });
  });

  it('counts over seasons when each season starts again at 1', () => {
    const series = [...range(1, 1, 10), ...range(2, 1, 8)];
    expect(pickAbsoluteEpisode(series, 3)).toEqual({ pick: 'absolute', season: 1, episode: 3 });
    expect(pickAbsoluteEpisode(series, 15)).toEqual({ pick: 'absolute', season: 2, episode: 5 });
    expect(pickAbsoluteEpisode(series, 0)).toEqual({ pick: 'unknown', episodes: 18 });
  });

  it('is unclear when the count and the numbering name different episodes', () => {
    const longer = [...range(1, 1, 10), ...range(2, 1, 13)];
    expect(pickAbsoluteEpisode(longer, 12)).toEqual({
      pick: 'unclear',
      candidates: [
        { season: 2, episode: 2, reading: 'count' },
        { season: 2, episode: 12, reading: 'number' },
      ],
    });
    // A list with a gap: the 70th listed episode is numbered 71.
    const gap = [...range(1, 1, 61), ...range(2, 63, 80)];
    expect(pickAbsoluteEpisode(gap, 70)).toEqual({
      pick: 'unclear',
      candidates: [
        { season: 2, episode: 71, reading: 'count' },
        { season: 2, episode: 70, reading: 'number' },
      ],
    });
  });

  it('takes the one episode with that number when the list is shorter than the number', () => {
    expect(pickAbsoluteEpisode([...range(1, 1, 5), ...range(2, 700, 730)], 730)).toEqual({ pick: 'absolute', season: 2, episode: 730 });
  });
});

describe('pickEpisodeInSeason', () => {
  it('starts the season at its first unfinished episode, whatever was played in other seasons', () => {
    const list = [ep(1, 1, 'finished', '2026-11-10T10:00:00Z'), ep(1, 2, 'in_progress', '2026-11-11T10:00:00Z'), ep(2, 1), ep(2, 2)];
    expect(pickEpisodeInSeason(list, 2, TODAY)).toEqual({ pick: 'first', season: 2, episode: 1 });
    expect(pickEpisodeInSeason([...list.slice(0, 2), ep(2, 1, 'finished'), ep(2, 2)], 2, TODAY)).toEqual({ pick: 'next', season: 2, episode: 2 });
  });

  it('resumes the episode of the season played last, else goes on after it', () => {
    expect(pickEpisodeInSeason([ep(2, 1, 'finished', '2026-11-10T10:00:00Z'), ep(2, 2, 'in_progress', '2026-11-11T10:00:00Z'), ep(2, 3)], 2, TODAY)).toEqual({ pick: 'resume', season: 2, episode: 2 });
    expect(pickEpisodeInSeason([ep(2, 1), ep(2, 2, 'finished', '2026-11-11T10:00:00Z'), ep(2, 3)], 2, TODAY)).toEqual({ pick: 'next', season: 2, episode: 3 });
  });

  it('starts a season finished to its end again at its first episode', () => {
    expect(pickEpisodeInSeason([ep(2, 1, 'finished', '2026-11-10T10:00:00Z'), ep(2, 2, 'finished', '2026-11-11T10:00:00Z')], 2, TODAY)).toEqual({ pick: 'first', season: 2, episode: 1 });
  });

  it('does not start an episode that airs after today, and answers null for a season the list does not hold', () => {
    expect(pickEpisodeInSeason([ep(3, 1, 'unwatched', null, '2027-01-01')], 3, TODAY)).toEqual({ pick: 'not_aired', season: 3, episode: 1, airDate: '2027-01-01' });
    expect(pickEpisodeInSeason([ep(1, 1)], 2, TODAY)).toBeNull();
  });
});
