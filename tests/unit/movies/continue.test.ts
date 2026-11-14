import { describe, expect, it } from 'vitest';
import { decideContinue, type ContinueFileView, type EpisodeSlot } from '../../../src/movies/continue.js';
import { fileRow, playRow, T0 } from '../../fixtures/movies/rows.js';

const day = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);
const EPS: EpisodeSlot[] = [1, 2, 3, 4, 5].map((e) => ({ season: 1, episode: e, name: `Episode ${e}` }));

function ep(id: number, e: number, o: { state: ContinueFileView['state']; present?: boolean; playedDay?: number }): ContinueFileView {
  const file = fileRow({ id, titleId: 'tv-1', season: 1, episode: e });
  const last = o.playedDay === undefined ? null : playRow({ id: id * 10, fileId: id, startedAt: day(o.playedDay), endedAt: day(o.playedDay) });
  return { file, last, state: o.state, present: o.present ?? true };
}

describe('decideContinue: series', () => {
  it('resumes the most recently played unfinished episode', () => {
    const d = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(2, 2, { state: 'in_progress', playedDay: 2 })], EPS);
    expect(d).toMatchObject({ action: 'resume', file: { id: 2 } });
  });

  it('starts the next present episode after the last played one', () => {
    const d = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(2, 2, { state: 'unwatched' })], EPS);
    expect(d).toMatchObject({ action: 'start', file: { id: 2 } });
  });

  it('names the missing next episode and the later present ones', () => {
    const d = decideContinue(
      'tv',
      null,
      [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(2, 2, { state: 'finished', playedDay: 2 }), ep(4, 4, { state: 'unwatched' }), ep(5, 5, { state: 'unwatched', present: false })],
      EPS,
    );
    expect(d).toEqual({
      action: 'missing',
      missing: { file_id: null, season: 1, episode: 3, absolute_episode: null, name: 'Episode 3' },
      present: [{ file_id: 4, season: 1, episode: 4, absolute_episode: null, name: 'Episode 4' }],
    });
  });

  it('skips episodes already finished after the anchor, and is caught up past the last one', () => {
    const skip = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 3 }), ep(2, 2, { state: 'finished' }), ep(3, 3, { state: 'unwatched' })], EPS);
    expect(skip).toMatchObject({ action: 'start', file: { id: 3 } });
    const done = decideContinue('tv', null, [ep(5, 5, { state: 'finished', playedDay: 4 })], EPS);
    expect(done).toMatchObject({ action: 'nothing', reason: 'caught_up', last: { file_id: 5, episode: 5 } });
  });

  it('with no plays, starts from the first episode; with no episode list, orders by the files', () => {
    expect(decideContinue('tv', null, [ep(1, 1, { state: 'unwatched' })], EPS)).toMatchObject({ action: 'start', file: { id: 1 } });
    const d = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(3, 3, { state: 'unwatched' })], []);
    expect(d).toMatchObject({ action: 'start', file: { id: 3 } });
    expect(decideContinue('tv', null, [], [])).toMatchObject({ action: 'nothing', reason: 'no_episodes' });
  });
});

describe('decideContinue: film', () => {
  const film = (o: { state: ContinueFileView['state']; present?: boolean }): ContinueFileView => ({
    file: fileRow({ id: 1 }),
    last: o.state === 'unwatched' ? null : playRow({ id: 1, fileId: 1, startedAt: day(1), endedAt: day(1) }),
    state: o.state,
    present: o.present ?? true,
  });

  it('resumes, starts, reports finished, or missing', () => {
    expect(decideContinue('movie', null, [film({ state: 'in_progress' })], [])).toMatchObject({ action: 'resume' });
    expect(decideContinue('movie', null, [film({ state: 'unwatched' })], [])).toMatchObject({ action: 'start' });
    expect(decideContinue('movie', null, [film({ state: 'finished' })], [])).toMatchObject({ action: 'nothing', reason: 'finished', finishedAt: day(1) });
    expect(decideContinue('movie', day(9), [], [])).toMatchObject({ action: 'nothing', reason: 'finished', finishedAt: day(9) });
    expect(decideContinue('movie', null, [film({ state: 'dropped', present: false })], [])).toMatchObject({ action: 'missing', present: [] });
  });
});
