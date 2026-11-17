import { describe, expect, it } from 'vitest';
import { FIGHT_CLUB, makeFile, makeSource, MOVIE, MOVIE_STREAMABLE, PLAYER_IDLE, PLAYING, SERIES, STATUS, TITLES } from '../testing/movieFixtures';
import {
  clock,
  continueNotice,
  creditRows,
  emptyLibraryText,
  filePlayLabel,
  matchesFilter,
  moviesChatMessage,
  watchPosition,
  creditGroups,
  entityQuestion,
  entitySearchQuery,
  moviesCountLine,
  moviesPillPlaceholder,
  detailIsFor,
  episodeByMovieId,
  NO_MOVIES_FILTER,
  PLAYER_OFF_LABEL,
  playErrorText,
  playLabel,
  playPlan,
  reasonText,
  releaseText,
  seasonsShown,
  sortTitles,
  stateCounts,
  stateFilters,
  type MoviesFilter,
  type MoviesView,
  streamLabel,
  streamLine,
  streamTarget,
  titleAction,
  agoText,
  magnetQuality,
} from './movies';
import type { TrendingTitle } from '../moviesApi';

const ids = (f: MoviesFilter) => TITLES.filter((t) => matchesFilter(t, f)).map((t) => t.id);

describe('moviesChatMessage', () => {
  it('names the page, and the open title once its detail is loaded', () => {
    expect(moviesChatMessage('what next?', { title: null, unmatched: false }, null)).toBe('[Movies · library]\nwhat next?');
    expect(moviesChatMessage('why?', { title: null, unmatched: true }, null)).toBe('[Movies · unmatched files]\nwhy?');
    expect(moviesChatMessage('cast?', { title: 'movie-467905', unmatched: false }, MOVIE)).toBe('[Movies · How to Make a Killing (2026) · M-23T4]\ncast?');
    expect(moviesChatMessage('cast?', { title: 'movie-467905', unmatched: false }, { ...MOVIE, movie_id: null })).toBe('[Movies · How to Make a Killing (2026) · movie-467905]\ncast?');
    expect(moviesChatMessage('cast?', { title: 'movie-467905', unmatched: false }, SERIES)).toBe('[Movies · movie-467905]\ncast?');
  });
});

describe('where the owner is in a title', () => {
  it('is the followed VLC when it shows this title, else a film\'s resume point; nothing for a finished title, a stopped VLC or an idle series', () => {
    expect(watchPosition(MOVIE, PLAYER_IDLE)).toEqual({ at: 2700, of: 6720 });
    expect(watchPosition(MOVIE, { ...PLAYING, current: { ...PLAYING.current!, position: 2715 } })).toEqual({ at: 2715, of: 6720 });
    expect(watchPosition(MOVIE, { ...PLAYING, current: { ...PLAYING.current!, position: 0, state: 'stopped' } })).toEqual({ at: 2700, of: 6720 });
    expect(watchPosition(MOVIE, { ...PLAYING, current: { ...PLAYING.current!, title_id: 'tv-247718', position: 99 } })).toEqual({ at: 2700, of: 6720 });
    expect(watchPosition({ ...MOVIE, state: 'finished' }, PLAYING)).toBeNull();
    expect(watchPosition({ ...MOVIE, watched: true }, PLAYING)).toBeNull();
    expect(watchPosition({ ...MOVIE, files: [makeFile(11, { title_id: MOVIE.id })] }, PLAYER_IDLE)).toBeNull();
    expect(watchPosition(SERIES, PLAYER_IDLE)).toBeNull();
    expect(watchPosition(SERIES, { ...PLAYING, current: { ...PLAYING.current!, title_id: SERIES.id, position: 610, duration: 3000 } })).toEqual({ at: 610, of: 3000 });
    expect(watchPosition(null, PLAYING)).toBeNull();
    expect(moviesChatMessage('who dies?', { title: 'movie-467905', unmatched: false }, MOVIE, { position: { at: 2715, of: 6720 }, hint: 'person 4' })).toBe(
      '[Movies · How to Make a Killing (2026) · M-23T4 · at 45:15 of 1:52:00 · person 4]\nwho dies?',
    );
  });
});

describe('entity links', () => {
  it('groups the credits as things to ask about, and words a series question as a series', () => {
    expect(creditGroups(MOVIE).map((g) => [g.label, g.entities.map((e) => e.name), g.more])).toEqual([
      ['Studios', ['Blumhouse Productions'], 0],
      ['Directed by', ['Ava Director'], 0],
      ['Written by', ['Ava Director'], 0],
      ['Produced by', ['Pat Producer'], 0],
    ]);
    expect(entityQuestion({ kind: 'genre', name: 'Drama' }, SERIES)).toMatch(/^Recommend other Drama series similar to /);
    expect(entityQuestion({ kind: 'person', name: 'X Y', personId: 9, role: null, cast: true }, MOVIE)).toBe('Tell me about X Y and list their other films and series. Mark the ones in my library.');
    expect(entitySearchQuery({ kind: 'genre', name: 'Crime' }, MOVIE)).toBe('Crime films like How to Make a Killing 2026');
    expect(entitySearchQuery({ kind: 'company', name: 'StudioCanal' }, MOVIE)).toBe('StudioCanal films and series');
  });
});

describe('moviesPillPlaceholder', () => {
  it('names the open title once its detail is loaded, and the library everywhere else', () => {
    expect(moviesPillPlaceholder({ title: null, unmatched: false }, null)).toBe('Ask about your movies');
    expect(moviesPillPlaceholder({ title: null, unmatched: true }, MOVIE)).toBe('Ask about your movies');
    expect(moviesPillPlaceholder({ title: 'movie-467905', unmatched: false }, null)).toBe('Ask about your movies');
    expect(moviesPillPlaceholder({ title: 'movie-467905', unmatched: false }, SERIES)).toBe('Ask about your movies');
    expect(moviesPillPlaceholder({ title: 'movie-467905', unmatched: false }, MOVIE)).toBe('Ask about How to Make a Killing');
  });
});

describe('grid order and filter', () => {
  it('puts in-progress titles first (newest play first) and titles with no file left last', () => {
    expect(sortTitles(TITLES).map((t) => t.id)).toEqual(['movie-467905', 'tv-247718', 'movie-9001']);
  });

  it('on the Stream side puts the title played last first, whatever its state, and never-played titles after', () => {
    const at = (id: string, last: string | null, created: string, state: 'in_progress' | 'finished' | 'unwatched') => ({ ...TITLES[0]!, id, state, last_played_at: last, created_at: created });
    const list = [
      at('old-in-progress', '2026-11-10T10:00:00.000Z', '2026-11-01T00:00:00.000Z', 'in_progress'),
      at('probed-older', null, '2026-11-12T00:00:00.000Z', 'unwatched'),
      at('just-finished', '2026-11-15T23:59:00.000Z', '2026-11-02T00:00:00.000Z', 'finished'),
      at('probed-newer', null, '2026-11-14T00:00:00.000Z', 'unwatched'),
    ];
    expect(sortTitles(list, 'stream').map((t) => t.id)).toEqual(['just-finished', 'old-in-progress', 'probed-newer', 'probed-older']);
  });

  it('on the Stream side shows a not-interested title only under that filter, and the library ignores the mark', () => {
    const list = [{ ...TITLES[0]!, id: 'kept', not_interested: false }, { ...TITLES[0]!, id: 'dropped', not_interested: true }];
    const shown = (f: MoviesFilter, side: 'stream' | 'library') => list.filter((t) => matchesFilter(t, f, side)).map((t) => t.id);
    expect(shown(NO_MOVIES_FILTER, 'stream')).toEqual(['kept']);
    expect(shown({ ...NO_MOVIES_FILTER, state: 'not_interested' }, 'stream')).toEqual(['dropped']);
    expect(shown(NO_MOVIES_FILTER, 'library')).toEqual(['kept', 'dropped']);
    expect(stateCounts(list, NO_MOVIES_FILTER, 'stream')).toMatchObject({ all: 1, not_interested: 1 });
    expect(stateFilters('stream').map((s) => s.key)).toEqual(['all', 'unwatched', 'in_progress', 'finished', 'not_interested']);
    expect(stateFilters('library').map((s) => s.key)).toEqual(['all', 'unwatched', 'in_progress', 'finished', 'gone']);
  });

  it('filters by state, kind and text, and counts each state under the other filters', () => {
    expect(ids({ ...NO_MOVIES_FILTER, state: 'gone' })).toEqual(['movie-9001']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'in_progress' })).toEqual(['tv-247718', 'movie-467905']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'unwatched' })).toEqual([]);
    expect(ids({ ...NO_MOVIES_FILTER, kind: 'tv' })).toEqual(['tv-247718']);
    expect(ids({ ...NO_MOVIES_FILTER, text: 'KILL' })).toEqual(['movie-467905']);
    expect(stateCounts(TITLES, NO_MOVIES_FILTER)).toEqual({ all: 3, unwatched: 0, in_progress: 2, finished: 0, gone: 1, not_interested: 0 });
    expect(stateCounts(TITLES, { ...NO_MOVIES_FILTER, kind: 'movie' })).toEqual({ all: 2, unwatched: 0, in_progress: 1, finished: 0, gone: 1, not_interested: 0 });
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
    const base: MoviesView = { titles: TITLES, listError: null, detail: null, detailError: null, unmatched: null, unmatchedError: null, status: STATUS, stream: null, streamError: null };
    expect(moviesCountLine(base, { title: null, unmatched: false })).toBe('3 titles: 2 films, 1 series. 2 in progress.');
    expect(moviesCountLine({ ...base, detail: MOVIE }, { title: 'movie-467905', unmatched: false })).toBe('2026 · film · 1h 52m · in progress.');
    expect(moviesCountLine({ ...base, listError: 'movies_off' }, { title: null, unmatched: false })).toBe('Movies are off on this daemon.');
    expect(emptyLibraryText({ ...STATUS, roots: [] })).toContain('NOTESD_MOVIES_ROOTS');
    expect(emptyLibraryText(STATUS)).toContain('/lib');
  });
});

describe('playErrorText', () => {
  it('shows the server\'s reason for player_unavailable, and the generic label without one', () => {
    expect(playErrorText('player_unavailable', 'VLC HTTP ports 47318-47327 are all in use.')).toBe('VLC HTTP ports 47318-47327 are all in use.');
    expect(playErrorText('player_unavailable')).toBe(PLAYER_OFF_LABEL);
    expect(playErrorText('file_missing', 'A.mkv is no longer on disk.')).toBe('the file is gone from disk; rescan to update the library');
  });
});

describe('movie ids on the page', () => {
  it('a detail answers its title id, its movie id and its episodes\' movie ids', () => {
    expect(detailIsFor(SERIES, 'tv-247718')).toBe(true);
    expect(detailIsFor(SERIES, 'm-8tr4')).toBe(true);
    expect(detailIsFor(SERIES, 'M-0S12')).toBe(true);
    expect(detailIsFor(SERIES, 'M-23T4')).toBe(false);
    expect(detailIsFor(null, 'M-8TR4')).toBe(false);
    expect(episodeByMovieId(SERIES, 'M-0S12')?.name).toBe('Episode Two');
    expect(episodeByMovieId(SERIES, 'M-8TR4')).toBeNull();
  });

  it('a focused episode keeps its season on the page even when no machine holds a file of it', () => {
    expect(seasonsShown(SERIES).seasons.map((s) => s.season)).toEqual([1]);
    expect(seasonsShown(SERIES, 'M-0S21').seasons.map((s) => s.season)).toEqual([1, 2]);
  });
});

describe('stream decisions', () => {
  it('file first: a film with a file here plays it, and the fresh stream is the second icon (R5.5)', () => {
    const a = titleAction(MOVIE_STREAMABLE, 'stream');
    expect(a.kind).toBe('vlc');
    if (a.kind !== 'vlc') return;
    expect(a.plan).toEqual({ kind: 'file', file: MOVIE_STREAMABLE.files[0] });
    expect(a.stream?.ref).toEqual({ kind: 'movie', tmdb_id: 467905 });
    expect(titleAction(MOVIE, 'stream')).toMatchObject({ kind: 'vlc', stream: null });
  });

  it('no file here: Stream side streams; Library side streams only with a fresh source', () => {
    expect(titleAction(FIGHT_CLUB, 'stream')).toMatchObject({ kind: 'stream', target: { ref: { kind: 'movie', tmdb_id: 550 }, code: '' } });
    expect(titleAction(FIGHT_CLUB, 'library').kind).toBe('stream');
    const stale = { ...FIGHT_CLUB, stream_sources: [makeSource(0, 0, { fresh: false, stale_at: '2026-11-14T10:00:00.000Z' })] };
    expect(titleAction(stale, 'library')).toEqual({ kind: 'idle', plan: { kind: 'none' } });
    expect(titleAction(stale, 'stream').kind).toBe('stream');
  });

  it('names the provider, the quality and the English subtitle', () => {
    expect(streamLine(FIGHT_CLUB, 'stream')).toBe('Stream: VidFast · 2160p · English subtitle');
    expect(streamLine(MOVIE, 'library')).toBeNull();
    expect(streamLine(MOVIE, 'stream')).toBe('Stream: not verified yet; Play checks it');
    const target = streamTarget(FIGHT_CLUB);
    expect(target).not.toBeNull();
    if (target === null) return;
    expect(streamLabel(target, true)).toEqual({ label: 'Stream (VidFast · 2160p · English subtitle)', disabled: false });
    expect(streamLabel(target, false)).toEqual({ label: 'Direct streaming is off on this machine', disabled: true });
    expect(streamLine({ ...FIGHT_CLUB, stream_sources: [makeSource(0, 0, { en_subtitle: false, best_height: null })] }, 'stream')).toBe('Stream: VidFast · no English subtitle');
  });
});

describe('magnetQuality', () => {
  const NOW = Date.parse('2026-11-17T12:00:00Z');
  const title = (probe: TrendingTitle['trending']['probe']): TrendingTitle =>
    ({ trending: { kind_rank: 1, seeds: 8401, index: 'apibay', release: 'x', size_bytes: null, listed_at: '2026-11-17T06:00:00Z', probe } }) as TrendingTitle;

  it('is "not confirmed" until the swarm was opened: seeds alone are never the verdict', () => {
    const q = magnetQuality(title(null), NOW);
    expect(q.state).toBe('unconfirmed');
    expect(q.label).toBe('not confirmed');
    expect(q.tip).toContain('8,401 seeds listed by apibay');
    expect(q.tip).toContain('has not been opened');
  });

  it('says confirmed, and when, only for a swarm a peer answered', () => {
    const q = magnetQuality(title({ outcome: 'confirmed', detail: '1 video file of 2, 4 peers connected', at: '2026-11-17T09:00:00Z' }), NOW);
    expect(q).toMatchObject({ state: 'confirmed', label: 'confirmed 3 h ago' });
    expect(q.tip).toContain('4 peers connected');
  });

  it('marks a listed swarm nobody answered as dead, with the listing named as possibly stale', () => {
    const q = magnetQuality(title({ outcome: 'no_peers', detail: 'no peer sent a file list within 20 s', at: '2026-11-17T11:50:00Z' }), NOW);
    expect(q).toMatchObject({ state: 'dead', label: 'no peer answered 10 min ago' });
    expect(q.tip).toContain('may be stale');
  });

  it('reads a failed check as unconfirmed, not dead', () => {
    expect(magnetQuality(title({ outcome: 'error', detail: 'x', at: '2026-11-17T11:59:30Z' }), NOW).state).toBe('unconfirmed');
    expect(magnetQuality(title({ outcome: 'no_video', detail: null, at: '2026-11-17T11:59:30Z' }), NOW).state).toBe('dead');
  });
});

describe('agoText', () => {
  it('rounds to the unit a person says', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(agoText('2026-11-17T11:59:00Z', now)).toBe('just now');
    expect(agoText('2026-11-17T11:00:00Z', now)).toBe('60 min ago');
    expect(agoText('2026-11-17T04:00:00Z', now)).toBe('8 h ago');
    expect(agoText('2026-11-14T12:00:00Z', now)).toBe('3 days ago');
  });
});
