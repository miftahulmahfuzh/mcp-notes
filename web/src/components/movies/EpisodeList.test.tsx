// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EpisodeList, type EpisodeListProps } from './EpisodeList';
import { PLAYER_IDLE, SERIES } from '../../testing/movieFixtures';

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
