import { describe, expect, it } from 'vitest';
import { makeFile, MOVIE, PLAYER_IDLE, SERIES, STATUS, TITLES } from '../testing/movieFixtures';
import {
  clock,
  continueNotice,
  creditRows,
  emptyLibraryText,
  filePlayLabel,
  matchesFilter,
  moviesChatMessage,
  moviesCountLine,
  NO_MOVIES_FILTER,
  playLabel,
  playPlan,
  reasonText,
  releaseText,
  seasonsShown,
  sortTitles,
  stateCounts,
  type MoviesFilter,
  type MoviesView,
} from './movies';

const ids = (f: MoviesFilter) => TITLES.filter((t) => matchesFilter(t, f)).map((t) => t.id);

describe('moviesChatMessage', () => {
  it('names the page, and the open title once its detail is loaded', () => {
    expect(moviesChatMessage('what next?', { title: null, unmatched: false }, null)).toBe('[Movies · library]\nwhat next?');
    expect(moviesChatMessage('why?', { title: null, unmatched: true }, null)).toBe('[Movies · unmatched files]\nwhy?');
    expect(moviesChatMessage('cast?', { title: 'movie-467905', unmatched: false }, MOVIE)).toBe('[Movies · How to Make a Killing (2026) · movie-467905]\ncast?');
    expect(moviesChatMessage('cast?', { title: 'movie-467905', unmatched: false }, SERIES)).toBe('[Movies · movie-467905]\ncast?');
  });
});

describe('grid order and filter', () => {
  it('puts in-progress titles first (newest play first) and titles with no file left last', () => {
    expect(sortTitles(TITLES).map((t) => t.id)).toEqual(['movie-467905', 'tv-247718', 'movie-9001']);
  });

  it('filters by state, kind and text, and counts each state under the other filters', () => {
    expect(ids({ ...NO_MOVIES_FILTER, state: 'gone' })).toEqual(['movie-9001']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'in_progress' })).toEqual(['tv-247718', 'movie-467905']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'unwatched' })).toEqual([]);
    expect(ids({ ...NO_MOVIES_FILTER, kind: 'tv' })).toEqual(['tv-247718']);
    expect(ids({ ...NO_MOVIES_FILTER, text: 'KILL' })).toEqual(['movie-467905']);
    expect(stateCounts(TITLES, NO_MOVIES_FILTER)).toEqual({ all: 3, unwatched: 0, in_progress: 2, finished: 0, gone: 1 });
    expect(stateCounts(TITLES, { ...NO_MOVIES_FILTER, kind: 'movie' })).toEqual({ all: 2, unwatched: 0, in_progress: 1, finished: 0, gone: 1 });
  });
});

describe('play plans', () => {
  it('a film resumes its file here; another machine or no file disables Play with the reason', () => {
    expect(playPlan(MOVIE)).toEqual({ kind: 'file', file: MOVIE.files[0] });
    expect(playLabel(playPlan(MOVIE), PLAYER_IDLE)).toEqual({ label: 'Resume at 45:00', disabled: false });
    expect(playLabel(playPlan(MOVIE), { available: false, reason: null, current: null })).toEqual({ label: 'VLC is not available on this machine', disabled: true });
    const elsewhere = { ...MOVIE, files: [makeFile(12, { host: 'gpd', available: false, unavailable_reason: 'not_on_this_machine' })] };
    expect(playLabel(playPlan(elsewhere), PLAYER_IDLE)).toEqual({ label: 'On gpd: play it on that machine', disabled: true });
    const gone = { ...MOVIE, files: [makeFile(13, { deleted: true, deleted_at: '2026-11-01T00:00:00.000Z', available: false, unavailable_reason: 'deleted' })] };
    expect(playPlan(gone)).toEqual({ kind: 'none' });
  });

  it('a series continues; each row says why it cannot play', () => {
    expect(playPlan(SERIES)).toEqual({ kind: 'continue' });
    const [e1, e2, e3] = SERIES.files;
    expect(filePlayLabel(e1!, PLAYER_IDLE, 'S01E01')).toEqual({ label: 'S01E01 is deleted', disabled: true });
    expect(filePlayLabel(e2!, PLAYER_IDLE, 'S01E02')).toEqual({ label: 'Resume S01E02 at 20:00', disabled: false });
    expect(filePlayLabel(e3!, PLAYER_IDLE, 'S01E03')).toEqual({ label: 'S01E03 is on gpd', disabled: true });
  });

  it('says what continue did', () => {
    const title = { id: 'tv-247718', title: 'MobLand', kind: 'tv' as const, year: 2025 };
    const ep = (season: number, episode: number, file_id: number | null = null) => ({ file_id, season, episode, absolute_episode: null, name: null });
    expect(continueNotice({ action: 'resumed', title, file: ep(1, 2, 22), position: 1200, play: {} })).toBe('resuming S01E02 at 20:00');
    expect(continueNotice({ action: 'missing', title, missing: ep(1, 5), present: [ep(1, 6, 26), ep(1, 7, 27)] })).toBe('S01E05 is not on this machine; S01E06, S01E07 are');
    expect(continueNotice({ action: 'nothing', title, reason: 'caught_up', finished_at: null, last: null })).toBe('caught up: nothing after the last episode');
    expect(continueNotice({ action: 'no_match', query: 'x' })).toBe('nothing to continue');
  });
});

describe('detail text', () => {
  it('lists studios and crew; seasons with no file are counted, not shown', () => {
    expect(creditRows(MOVIE)).toEqual([
      ['Studios', 'Blumhouse Productions'],
      ['Directed by', 'Ava Director'],
      ['Written by', 'Ava Director'],
      ['Produced by', 'Pat Producer'],
    ]);
    expect(creditRows(SERIES)).toEqual([['Created by', 'Ronan Creator']]);
    const shown = seasonsShown(SERIES);
    expect(shown.seasons.map((s) => s.season)).toEqual([1]);
    expect(shown.hidden).toBe(1);
  });

  it('formats times, dates and reasons', () => {
    expect(clock(2700)).toBe('45:00');
    expect(clock(7385)).toBe('2:03:05');
    expect(releaseText('2026-02-20')).toBe('Feb 20, 2026');
    expect(reasonText('too_short', 'unmatched')).toBe('shorter than 15 minutes');
    expect(reasonText(null, 'pending')).toBe('waiting for the next scan');
  });

  it('count lines and empty states', () => {
    const base: MoviesView = { titles: TITLES, listError: null, detail: null, detailError: null, unmatched: null, unmatchedError: null, status: STATUS };
    expect(moviesCountLine(base, { title: null, unmatched: false })).toBe('3 titles: 2 films, 1 series. 2 in progress.');
    expect(moviesCountLine({ ...base, detail: MOVIE }, { title: 'movie-467905', unmatched: false })).toBe('2026 · film · 1h 52m · in progress.');
    expect(moviesCountLine({ ...base, listError: 'movies_off' }, { title: null, unmatched: false })).toBe('Movies are off on this daemon.');
    expect(emptyLibraryText({ ...STATUS, roots: [] })).toContain('NOTESD_MOVIES_ROOTS');
    expect(emptyLibraryText(STATUS)).toContain('/lib');
  });
});
