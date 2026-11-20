// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { EpisodeList, type EpisodeListProps } from './EpisodeList';
import { PLAYER_IDLE, SERIES } from '../../testing/movieFixtures';
import { makeDownload } from '../../testing/downloadFixtures';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const noop = () => {};
function props(over: Partial<EpisodeListProps> = {}): EpisodeListProps {
  return { detail: SERIES, player: PLAYER_IDLE, busy: false, side: 'library', streamEnabled: false, onPlay: noop, onStream: noop, onWatched: noop, onSeasonWatched: noop, onEpisodeWatched: noop, onTrailer: noop, ...over };
}
const season = SERIES.seasons[0]!;
const rows = () => document.querySelectorAll('[data-testid="movie-file"]');
const list = () => document.querySelector('.mv-eps') as HTMLElement;

describe('EpisodeList: folding a season', () => {
  it('hides a season\'s episodes behind its button and says how many there are; another press shows them again', () => {
    render(<EpisodeList {...props()} />);
    expect(rows()).toHaveLength(season.episodes.length);
    expect(list().hidden).toBe(false);
    const fold = screen.getByRole('button', { name: `Hide the episodes of season ${season.season}` });
    expect(fold.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(fold);
    expect(list().hidden).toBe(true);
    const finished = season.episodes.filter((e) => e.state === 'finished').length;
    expect(document.querySelector('.mv-season-sum')?.textContent).toBe(
      finished === 0 ? `${season.episodes.length} episodes` : `${season.episodes.length} episodes, ${finished === season.episodes.length ? 'all' : finished} finished`,
    );
    // The season's other buttons stay: it can still be marked finished while folded.
    expect(screen.getByRole('button', { name: new RegExp(`season ${season.season}.*finished`, 'i') })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: `Show the episodes of season ${season.season}` }));
    expect(list().hidden).toBe(false);
    expect(document.querySelector('.mv-season-sum')).toBeNull();
  });

  it('remembers the fold for this title in this browser, and keeps none for another title', () => {
    const first = render(<EpisodeList {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Hide the episodes/ }));
    expect(window.localStorage.getItem(`movies.collapsed.${SERIES.id}`)).toBe(`[${season.season}]`);
    first.unmount();
    render(<EpisodeList {...props()} />);
    expect(list().hidden).toBe(true);
    cleanup();
    render(<EpisodeList {...props({ detail: { ...SERIES, id: 'tv-1' } })} />);
    expect(list().hidden).toBe(false);
    cleanup();
    // Unfolding everything leaves nothing behind.
    render(<EpisodeList {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Show the episodes/ }));
    expect(window.localStorage.getItem(`movies.collapsed.${SERIES.id}`)).toBeNull();
  });

  it('keeps the season of the episode in the address open, whatever was folded', () => {
    window.localStorage.setItem(`movies.collapsed.${SERIES.id}`, JSON.stringify([season.season]));
    const focus = season.episodes.find((e) => e.movie_id !== null)?.movie_id ?? null;
    Element.prototype.scrollIntoView = noop;
    render(<EpisodeList {...props({ focus })} />);
    if (focus !== null) expect(list().hidden).toBe(false);
    // Storage that holds something else is read as nothing folded.
    cleanup();
    window.localStorage.setItem(`movies.collapsed.${SERIES.id}`, '{"not":"a list"}');
    render(<EpisodeList {...props()} />);
    expect(list().hidden).toBe(false);
  });
});

describe('EpisodeList: a play started from a row', () => {
  it('names its row to the page, and only that row shows what the play is doing', () => {
    const onStream = vi.fn();
    const first = season.episodes[0]!;
    const code = `S${String(first.season).padStart(2, '0')}E${String(first.episode).padStart(2, '0')}`;
    const view = render(<EpisodeList {...props({ side: 'stream', streamEnabled: true, onStream })} />);
    expect(document.querySelector('[data-testid="episode-progress"]')).toBeNull();
    fireEvent.click(document.querySelector(`[data-episode="${code}"] .mv-row-play button`) as HTMLElement);
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream.mock.calls[0]![1]).toBe(code);

    view.rerender(<EpisodeList {...props({ side: 'stream', streamEnabled: true, onStream, busy: true, starting: { at: code, text: 'asking the cloud providers · 3 s' } })} />);
    const lines = document.querySelectorAll('[data-testid="episode-progress"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closest('[data-episode]')?.getAttribute('data-episode')).toBe(code);
    expect(lines[0]!.textContent).toBe('asking the cloud providers · 3 s');
    expect(lines[0]!.getAttribute('role')).toBe('status');
  });
});

describe('EpisodeList: the season story button', () => {
  // Stream side lists every season with episodes; a Specials season is added to prove it gets no button.
  const specials = { ...SERIES.seasons[1]!, season: 0, episodes: SERIES.seasons[1]!.episodes.map((e) => ({ ...e, season: 0 })) };
  const detail = { ...SERIES, seasons: [specials, { ...SERIES.seasons[0]!, has_story: true }, SERIES.seasons[1]!] };

  it('puts a book icon on each numbered season head, named in the owner\'s words, filled when the season\'s story is stored, and opens that season', () => {
    const onSeasonStory = vi.fn();
    render(<EpisodeList {...props({ detail, side: 'stream', onSeasonStory })} />);
    const s1 = screen.getByRole('button', { name: 'Narrate the full story of S01' });
    const s2 = screen.getByRole('button', { name: 'Narrate the full story of S02' });
    expect(s1.closest('.mv-season-head')).toBe(document.querySelector('[data-season="1"] .mv-season-head'));
    expect(s1.getAttribute('data-stored')).toBe('true');
    expect(s1.getAttribute('data-tip')).toMatch(/^Narrate the full story of S01 \(stored/);
    expect(s2.getAttribute('data-stored')).toBeNull();
    expect(s2.getAttribute('data-tip')).toMatch(/^Narrate the full story of S02 \(full spoilers/);
    expect(s1.className).toBe('pbtn hov mv-season-story');
    expect(document.querySelector('[data-season="0"] .mv-season-story')).toBeNull();
    fireEvent.click(s2);
    expect(onSeasonStory).toHaveBeenCalledTimes(1);
    expect(onSeasonStory).toHaveBeenCalledWith(expect.objectContaining({ season: 2 }));
  });

  it('stays on a folded season and is not there when the page gives no handler', () => {
    const { unmount } = render(<EpisodeList {...props({ detail, side: 'stream', onSeasonStory: noop })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the episodes of season 1' }));
    expect(screen.getByRole('button', { name: 'Narrate the full story of S01' })).toBeTruthy();
    unmount();
    render(<EpisodeList {...props({ detail, side: 'stream' })} />);
    expect(screen.queryByRole('button', { name: /Narrate the full story/ })).toBeNull();
  });
});

describe('EpisodeList: downloads', () => {
  const binding = (rows = [] as ReturnType<typeof makeDownload>[]) => ({ rows, onNotice: noop, onChanged: noop });
  const rowOf = (code: string) => document.querySelector(`[data-episode="${code}"]`) as HTMLElement;

  it('puts a Download button on every season head and episode row only when the page hands it the downloads', () => {
    render(<EpisodeList {...props({ side: 'stream', streamEnabled: true })} />);
    expect(screen.queryByRole('button', { name: /^Download / })).toBeNull();
    cleanup();
    render(<EpisodeList {...props({ side: 'stream', streamEnabled: true, downloads: binding() })} />);
    for (const s of SERIES.seasons) expect(screen.getByRole('button', { name: `Download MobLand season ${s.season}` })).toBeTruthy();
    for (const e of season.episodes) {
      const code = `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
      expect(within(rowOf(code)).getByRole('button', { name: `Download MobLand ${code}` })).toBeTruthy();
    }
  });

  it('draws the bar on the season head and on the episode row the download belongs to, and nowhere else', () => {
    const rows = [makeDownload({ title_id: SERIES.id, kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode: 2, state: 'running', progress: 0.3 })];
    render(<EpisodeList {...props({ side: 'stream', streamEnabled: true, downloads: binding(rows) })} />);
    expect(screen.getByRole('progressbar', { name: 'Download of MobLand season 1' }).getAttribute('aria-valuenow')).toBe('30');
    // Phase 9's drive finds the season's bar inside the season head.
    expect(screen.getByRole('progressbar', { name: 'Download of MobLand season 1' }).closest('.mv-season-head')).not.toBeNull();
    expect(within(rowOf('S01E02')).getByRole('progressbar', { name: 'Download of MobLand S01E02' }).getAttribute('aria-valuenow')).toBe('30');
    expect(within(rowOf('S01E01')).queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Download of MobLand season 2' })).toBeNull();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });
});
