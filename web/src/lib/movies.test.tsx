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
  playMenu,
  playPlan,
  playProgressText,
  startingStage,
  methodDoing,
  applyMark,
  undoMark,
  GUIDE_ACTIONS,
  guideActionLabel,
  guideActionOn,
  guideTitleAfter,
  guideCountLine,
  guideTitleLine,
  opensGuide,
  detailSide,
  reasonText,
  releaseText,
  seasonsShown,
  sortTitles,
  stateCounts,
  stateFilters,
  type MoviesFilter,
  type MoviesView,
  channelText,
  playedLine,
  siteTitleCaption,
  siteTitleNext,
  streamLabel,
  streamLine,
  streamTarget,
  titleAction,
  agoText,
} from './movies';
import type { SiteTitle } from '../moviesApi';

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
    expect(entitySearchQuery({ kind: 'company', name: 'StudioCanal', companyId: 694 }, MOVIE)).toBe('StudioCanal films and series');
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
    expect(stateFilters('stream').map((s) => s.key)).toEqual(['all', 'unwatched', 'in_progress', 'finished', 'interested', 'not_interested']);
    expect(stateFilters('library').map((s) => s.key)).toEqual(['all', 'unwatched', 'in_progress', 'finished', 'gone']);
  });

  it('the interested filter is the Stream side\'s watch list: marked and not finished yet, verified source or not', () => {
    const base = { ...TITLES[0]!, state: 'unwatched' as const, watched: false, not_interested: false };
    const list = [
      { ...base, id: 'plain' },
      { ...base, id: 'wanted', interested: true },
      { ...base, id: 'wanted-unverified', interested: true, interested_only: true },
      { ...base, id: 'wanted-done', interested: true, state: 'finished' as const },
      { ...base, id: 'wanted-flagged', interested: true, watched: true, state: 'finished' as const },
    ];
    const shown = (f: MoviesFilter, side: 'stream' | 'library') => list.filter((t) => matchesFilter(t, f, side)).map((t) => t.id);
    expect(shown({ ...NO_MOVIES_FILTER, state: 'interested' }, 'stream')).toEqual(['wanted', 'wanted-unverified']);
    // A title listed for the mark alone has no verified source: it is on no other pill.
    expect(shown(NO_MOVIES_FILTER, 'stream')).toEqual(['plain', 'wanted', 'wanted-done']);
    expect(shown({ ...NO_MOVIES_FILTER, state: 'unwatched' }, 'stream')).toEqual(['plain', 'wanted']);
    expect(shown({ ...NO_MOVIES_FILTER, state: 'interested' }, 'library')).toEqual([]);
    expect(stateCounts(list, NO_MOVIES_FILTER, 'stream')).toMatchObject({ all: 3, interested: 2 });
  });

  it('a mark laid over a title keeps interested and not interested apart, and undoMark takes it back', () => {
    const t = { ...TITLES[0]!, interested: true, not_interested: false };
    expect(applyMark(t, { not_interested: true })).toMatchObject({ not_interested: true, interested: false });
    expect(applyMark({ ...t, interested: false, not_interested: true }, { interested: true })).toMatchObject({ interested: true, not_interested: false });
    expect(applyMark(t, { interested: false })).toMatchObject({ interested: false, not_interested: false });
    expect(applyMark(t, { watched: true })).toMatchObject({ watched: true, state: 'finished', interested: true });
    expect(undoMark({ interested: true })).toEqual({ interested: false });
    expect(undoMark({ not_interested: false })).toEqual({ not_interested: true });
    expect(undoMark({ watched: true })).toEqual({ watched: false });
  });

  it('filters by state, kind and text, and counts each state under the other filters', () => {
    expect(ids({ ...NO_MOVIES_FILTER, state: 'gone' })).toEqual(['movie-9001']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'in_progress' })).toEqual(['tv-247718', 'movie-467905']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'unwatched' })).toEqual([]);
    expect(ids({ ...NO_MOVIES_FILTER, kind: 'tv' })).toEqual(['tv-247718']);
    expect(ids({ ...NO_MOVIES_FILTER, text: 'KILL' })).toEqual(['movie-467905']);
    expect(stateCounts(TITLES, NO_MOVIES_FILTER)).toEqual({ all: 3, unwatched: 0, in_progress: 2, finished: 0, gone: 1, interested: 0, not_interested: 0 });
    expect(stateCounts(TITLES, { ...NO_MOVIES_FILTER, kind: 'movie' })).toEqual({ all: 2, unwatched: 0, in_progress: 1, finished: 0, gone: 1, interested: 0, not_interested: 0 });
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

  it('a title no machine holds a file of is shown as on the Stream side, whatever the address says', () => {
    expect(detailSide('library', { file_count: 0, deleted_file_count: 0 })).toBe('stream');
    // A file anywhere, or one that was deleted, is library history: the address decides.
    expect(detailSide('library', { file_count: 2, deleted_file_count: 0 })).toBe('library');
    expect(detailSide('library', { file_count: 0, deleted_file_count: 1 })).toBe('library');
    expect(detailSide('stream', { file_count: 2, deleted_file_count: 0 })).toBe('stream');
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

describe('how a title was last played', () => {
  const AT = '2026-11-18T10:00:00.000Z';
  const through = (channel: 'vlc' | 'cloud' | 'torrent' | 'site', provider: string | null = null, season: number | null = null, episode: number | null = null) => ({ channel, provider, played_at: AT, season, episode });

  it('names each source the way the owner does', () => {
    expect(channelText(through('vlc'))).toBe('VLC (Downloaded File)');
    expect(channelText(through('cloud', 'VidRock'))).toBe('VidRock (Non Torrent)');
    expect(channelText(through('torrent'))).toBe('Magnet (Torrent)');
    expect(channelText(through('site', 'dramacool'))).toBe('Dramacool');
    expect(channelText(through('site', 'lk21'))).toBe('Lk21');
  });

  it('says what it was played through, with the episode and the day', () => {
    expect(playedLine({ ...FIGHT_CLUB, played_through: through('cloud', 'VidRock') })).toBe('Previously played through VidRock (Non Torrent) · Nov 18, 2026');
    expect(playedLine({ ...SERIES, played_through: through('site', 'dramacool', 1, 3) })).toBe('Previously played through Dramacool · S01E03 · Nov 18, 2026');
    expect(playedLine({ ...FIGHT_CLUB, played_through: through('torrent'), stream_failed: { cloud_at: '2026-11-17T10:00:00.000Z', torrent_at: null } })).toBe(
      'Previously played through Magnet (Torrent) · Nov 18, 2026 · Non Torrent found nothing on Nov 17, 2026',
    );
  });

  it('says a title was never played, and which kinds of stream failed, with the day', () => {
    expect(playedLine({ ...FIGHT_CLUB, state: 'unwatched' })).toBe('Never been played before');
    // Finished by a mark, or on the other machine: it was played, only not here.
    expect(playedLine({ ...FIGHT_CLUB, state: 'finished' })).toBe('Not played on this machine yet');
    expect(playedLine({ ...FIGHT_CLUB, stream_failed: { cloud_at: AT, torrent_at: null } })).toBe('Never been played before · all Non Torrent stream methods failed on Nov 18, 2026');
    expect(playedLine({ ...FIGHT_CLUB, stream_failed: { cloud_at: null, torrent_at: AT } })).toBe('Never been played before · all Torrent stream methods failed on Nov 18, 2026');
    expect(playedLine({ ...FIGHT_CLUB, stream_failed: { cloud_at: '2026-11-16T10:00:00.000Z', torrent_at: AT } })).toBe(
      'Never been played before · all Direct (Non Torrent and Torrent) stream methods failed, last on Nov 18, 2026',
    );
  });

  it('a stream button says where the play goes again; a file play changes nothing', () => {
    const onSite = streamTarget({ ...FIGHT_CLUB, played_through: through('site', 'flicksy') });
    expect(onSite && streamLabel(onSite, true).label).toBe('Stream on Flicksy, where it played last time');
    const torrent = streamTarget({ ...FIGHT_CLUB, played_through: through('torrent') });
    expect(torrent && streamLabel(torrent, true).label).toBe('Stream from a torrent, as last time');
    const file = streamTarget({ ...FIGHT_CLUB, played_through: through('vlc') });
    expect(file && streamLabel(file, true).label).toBe('Stream (VidFast · 2160p · English subtitle)');
  });

  it('a series last played on a site carries on with the episode after that one', () => {
    const episodes = SERIES.seasons.flatMap((s) => s.episodes);
    const [first, second] = episodes;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const next = streamTarget({ ...SERIES, played_through: through('site', 'dramacool', first.season, first.episode) });
    expect(next?.ref).toEqual({ kind: 'tv', tmdb_id: SERIES.tmdb_id, season: second.season, episode: second.episode });
    const last = episodes[episodes.length - 1]!;
    expect(streamTarget({ ...SERIES, played_through: through('site', 'dramacool', last.season, last.episode) })?.ref).toMatchObject({ season: last.season, episode: last.episode });
  });
});

describe('a title TMDB does not list', () => {
  const DRAMA: SiteTitle = { id: 1, site: 'dramacool', site_url: 'https://dramacool9.com.ro/x-2026', kind: 'series', name: 'X', year: 2026, poster_url: null, overview: '', country: null, status: null, genres: [], also_known: null, season: 1, episode: 3, played_at: '2026-11-18T10:00:00.000Z' };

  it('says where it is from and which episode was played, and plays the one after it', () => {
    expect(siteTitleCaption(DRAMA)).toBe('2026 · Dramacool · episode 3');
    expect(siteTitleNext(DRAMA)).toEqual({ episode: 4, label: 'Play episode 4 of X on Dramacool' });
    const film: SiteTitle = { ...DRAMA, kind: 'movie', year: null, season: null, episode: null };
    expect(siteTitleCaption(film)).toBe('Dramacool');
    expect(siteTitleNext(film)).toEqual({ episode: null, label: 'Play X on Dramacool' });
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

describe('playMenu', () => {
  const keys = (m: ReturnType<typeof playMenu>) => m.items.map((i) => i.key);

  it('a film with a file here: the file, the two kinds of stream, then every site', () => {
    const m = playMenu(MOVIE, null, PLAYER_IDLE, true);
    expect(m.code).toBe('');
    expect(keys(m)).toEqual(['file', 'cloud', 'torrent', 'idlix', 'lk21', 'flicksy', 'dramacool']);
    expect(m.items.every((i) => !i.disabled)).toBe(true);
  });

  it('without a file here the first row finds the download on pahe, and says where a file is', () => {
    const m = playMenu(FIGHT_CLUB, null, PLAYER_IDLE, true);
    expect(m.items[0]).toMatchObject({ key: 'pahe', label: 'Find the download on pahe.ink', disabled: false });
    const far = playMenu({ ...MOVIE, files: MOVIE.files.map((f) => ({ ...f, available: false, host: 'host-b' })) }, null, PLAYER_IDLE, true);
    expect(far.items[0]).toMatchObject({ key: 'pahe', hint: 'a file is on host-b, none here' });
  });

  it('each row says what it remembers: the provider, the same torrent, a site, a failure; and which played last', () => {
    const d = {
      ...FIGHT_CLUB,
      played_through: { channel: 'cloud' as const, provider: 'VidRock', played_at: '2026-11-18T10:00:00.000Z', season: null, episode: null },
      played_methods: [
        { method: 'cloud', provider: 'VidRock', played_at: '2026-11-18T10:00:00.000Z', season: null, episode: null },
        { method: 'torrent', provider: null, played_at: '2026-11-17T10:00:00.000Z', season: null, episode: null },
        { method: 'lk21', provider: null, played_at: '2026-11-16T10:00:00.000Z', season: null, episode: null },
      ],
    };
    const by = Object.fromEntries(playMenu(d, null, PLAYER_IDLE, true).items.map((i) => [i.key, i]));
    expect(by.cloud).toMatchObject({ hint: 'VidRock first, as on Nov 18, 2026', last: true });
    expect(by.torrent).toMatchObject({ hint: 'the same torrent as on Nov 17, 2026', last: false });
    expect(by.lk21?.hint).toBe('played Nov 16, 2026');
    expect(by.idlix?.hint).toBeNull();
    const failed = playMenu({ ...FIGHT_CLUB, stream_failed: { cloud_at: '2026-11-15T10:00:00.000Z', torrent_at: null } }, null, PLAYER_IDLE, true);
    expect(failed.items.find((i) => i.key === 'cloud')?.hint).toBe('found nothing on Nov 15, 2026');
  });

  it("an episode's menu names the episode, keeps only the sites that play episodes, and a torrent of another episode is not the same torrent", () => {
    const e = SERIES.seasons[0]!.episodes[1]!;
    const d = { ...SERIES, played_methods: [{ method: 'torrent', provider: null, played_at: '2026-11-17T10:00:00.000Z', season: e.season, episode: e.episode + 1 }] };
    const m = playMenu(d, e, PLAYER_IDLE, true);
    expect(m.code).toBe('S01E02');
    expect(keys(m).slice(1)).toEqual(['cloud', 'torrent', 'idlix', 'dramacool']);
    expect(m.items.find((i) => i.key === 'torrent')?.hint).toBe('last from a torrent on Nov 17, 2026');
    expect(m.target?.ref).toEqual({ kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode: 2 });
  });

  it('with direct streaming off the two stream rows say so; the sites still play', () => {
    const by = Object.fromEntries(playMenu(MOVIE, null, PLAYER_IDLE, false).items.map((i) => [i.key, i]));
    expect(by.cloud).toMatchObject({ disabled: true, hint: 'direct streaming is off on this machine' });
    expect(by.torrent?.disabled).toBe(true);
    expect(by.idlix?.disabled).toBe(false);
  });
});

describe('the pop-up of a name', () => {
  const t = (over: object) => ({ kind: 'movie' as const, tmdb_id: 1, title_id: 'movie-1', title: 'T', year: 2020, release_date: null, poster_url: null, note: null, movie_id: null, mark: null, interested: false, has_file: false, ...over });

  it('a person, a studio and a genre open it; a character does not', () => {
    expect(opensGuide({ kind: 'genre', name: 'Crime' })).toBe(true);
    expect(opensGuide({ kind: 'company', name: 'A24', companyId: 41077 })).toBe(true);
    expect(opensGuide({ kind: 'character', name: 'Ruth', actor: 'X', personId: 1 })).toBe(false);
  });

  it('counts the marks and writes a title line', () => {
    expect(guideCountLine([t({ mark: 'watched' }), t({ mark: 'watched' }), t({ mark: 'not_interested' }), t({})])).toBe('4 titles · 2 watched · 1 not interested');
    expect(guideCountLine([t({})])).toBe('1 title');
    expect(guideCountLine([t({ mark: 'watched', interested: true }), t({ interested: true }), t({ mark: 'not_interested' })])).toBe('3 titles · 1 watched · 2 interested · 1 not interested');
    expect(guideTitleLine(t({ kind: 'tv', note: 'as Ruth' }))).toBe('2020 · series · as Ruth');
    expect(guideTitleLine(t({ year: null }))).toBe('undated');
  });
});

describe('the three mark buttons of a listed title', () => {
  const t = { kind: 'tv' as const, tmdb_id: 1, title_id: 'tv-1', title: 'T', year: 2020, release_date: null, poster_url: null, note: null, movie_id: null, mark: null, interested: false, has_file: false };
  const d = { movie_id: 'M-0001', state: 'unwatched' as const, watched: false, not_interested: false, interested: false };

  it('each button is on from the row, and says what a click does', () => {
    expect(GUIDE_ACTIONS).toEqual(['watched', 'interested', 'not_interested']);
    expect(GUIDE_ACTIONS.map((a) => guideActionOn(t, a))).toEqual([false, false, false]);
    expect(GUIDE_ACTIONS.map((a) => guideActionOn({ ...t, mark: 'watched', interested: true }, a))).toEqual([true, true, false]);
    expect(guideActionOn({ ...t, mark: 'started' }, 'watched')).toBe(false);
    expect(guideActionLabel(t, 'watched')).toBe('Mark T as watched, every season');
    expect(guideActionLabel({ ...t, interested: true }, 'interested')).toBe('T: interested (click to take it off the list)');
    expect(guideActionLabel(t, 'not_interested')).toBe('Not interested in T');
  });

  it('after a save the row shows what the server answered, and keeps the movie id the title got', () => {
    expect(guideTitleAfter(t, { ...d, interested: true })).toMatchObject({ movie_id: 'M-0001', mark: null, interested: true });
    expect(guideTitleAfter(t, { ...d, not_interested: true })).toMatchObject({ mark: 'not_interested', interested: false });
    expect(guideTitleAfter(t, { ...d, watched: true, state: 'finished' })).toMatchObject({ mark: 'watched' });
    // A title finished by playing it stays watched when its flag is cleared.
    expect(guideTitleAfter(t, { ...d, state: 'finished' })).toMatchObject({ mark: 'watched' });
    expect(guideTitleAfter(t, { ...d, state: 'in_progress' })).toMatchObject({ mark: 'started' });
    expect(guideTitleAfter({ ...t, movie_id: 'M-0009' }, { ...d, movie_id: null })).toMatchObject({ movie_id: 'M-0009' });
  });
});

describe('a play being started', () => {
  const starting = (tmdb_id: number, stage: string) => ({ kind: 'movie' as const, tmdb_id, season: null, episode: null, title: 'T', provider: null, since: '2026-11-18T12:00:00.000Z', stage });

  it("reads this title's stage from the player state, the newest when it has two, and none of another title's", () => {
    expect(startingStage(null, 'movie', 5)).toBeNull();
    expect(startingStage(PLAYER_IDLE, 'movie', 5)).toBeNull();
    const p = { ...PLAYER_IDLE, starting: [starting(5, 'asking the torrent indexes'), starting(6, 'asking VidRock'), starting(5, 'opening 3 torrents')] };
    expect(startingStage(p, 'movie', 5)).toBe('opening 3 torrents');
    expect(startingStage(p, 'tv', 5)).toBeNull();
    expect(startingStage(p, 'movie', 7)).toBeNull();
  });

  it('says what was asked until a stage is named, with the seconds once it takes a moment', () => {
    expect(playProgressText('asking the torrents', null, 0)).toBe('asking the torrents');
    expect(playProgressText('asking the torrents', null, 3)).toBe('asking the torrents · 3 s');
    expect(playProgressText('asking the torrents', 'opening 3 torrents', 7)).toBe('opening 3 torrents · 7 s');
    expect(methodDoing('torrent', 'Torrent stream')).toBe('asking the torrents');
    expect(methodDoing('idlix', 'Idlix')).toMatch(/^starting it on Idlix/);
  });
});
