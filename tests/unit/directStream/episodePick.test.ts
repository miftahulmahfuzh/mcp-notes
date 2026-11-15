import { describe, expect, it } from 'vitest';
import { pickEpisode, withListedEpisodes, type EpisodeProgress } from '../../../src/directStream/episodePick.js';

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
