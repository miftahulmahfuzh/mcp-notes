import { describe, expect, it } from 'vitest';
import { decideEpisode, type ContinueFileView } from '../../../src/movies/continue.js';
import { MOVIE_ID_PATTERN, normalizeMovieId } from '../../../src/movies/ids.js';
import { ID_PATTERN } from '../../../src/notes/ids.js';
import { fileRow, playRow, T0 } from '../../fixtures/movies/rows.js';

describe('normalizeMovieId', () => {
  it('takes M-XXXX in any case and nothing else', () => {
    expect(normalizeMovieId(' m-23t4 ')).toBe('M-23T4');
    expect(normalizeMovieId('M-0909')).toBe('M-0909');
    for (const no of ['M3GAN', 'M23T4', 'M-23T', 'M-23T45', 'A-B32', 'N-23T4', 'movie-467905', 'm-23t!', '']) expect(normalizeMovieId(no)).toBeNull();
  });

  it('never looks like a note id', () => {
    expect(MOVIE_ID_PATTERN.test('A-B32')).toBe(false);
    expect(ID_PATTERN.test('M-23T4')).toBe(false);
  });
});

describe('decideEpisode', () => {
  const view = (id: number, episode: number, state: ContinueFileView['state'], present = true): ContinueFileView => ({
    file: fileRow({ id, titleId: 'tv-1', season: 1, episode }),
    last: state === 'unwatched' ? null : playRow({ id, fileId: id, startedAt: T0, endedAt: T0 }),
    state,
    present,
  });
  const slot = { season: 1, episode: 2, name: 'Two' };

  it('plays the asked episode whatever the continue rule would pick, resuming one left partway', () => {
    expect(decideEpisode([view(1, 1, 'in_progress'), view(2, 2, 'unwatched')], slot)).toMatchObject({ action: 'start', file: { id: 2 } });
    expect(decideEpisode([view(2, 2, 'in_progress')], slot)).toMatchObject({ action: 'resume', file: { id: 2 } });
    expect(decideEpisode([view(2, 2, 'finished')], slot)).toMatchObject({ action: 'start', file: { id: 2 } });
  });

  it('is missing without a file on this machine', () => {
    expect(decideEpisode([view(2, 2, 'unwatched', false), view(3, 3, 'unwatched')], slot)).toEqual({
      action: 'missing',
      missing: { file_id: null, season: 1, episode: 2, absolute_episode: null, name: 'Two' },
      present: [],
    });
  });
});
