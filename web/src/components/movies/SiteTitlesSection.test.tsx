// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteTitle } from '../../moviesApi';
import { SiteTitlesSection } from './SiteTitlesSection';

const DRAMA: SiteTitle = { id: 4, site: 'dramacool', site_url: 'https://dramacool9.com.ro/x-2026', kind: 'series', name: 'Hidden Summer', year: 2026, poster_url: null, overview: 'A girl and her summer.', country: 'South Korea', status: 'Ongoing', genres: ['Drama'], also_known: null, season: 1, episode: 3, played_at: '2026-11-18T10:00:00.000Z' };
const FILM: SiteTitle = { ...DRAMA, id: 5, kind: 'movie', name: 'Devil River', season: null, episode: null };

afterEach(cleanup);

describe('SiteTitlesSection', () => {
  it('shows nothing when no such title was played', () => {
    const { container } = render(<SiteTitlesSection titles={[]} busy={false} onPlay={() => undefined} onRemove={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('a poster plays the next episode; the icons play the last one again and take the title off', () => {
    const onPlay = vi.fn();
    const onRemove = vi.fn();
    render(<SiteTitlesSection titles={[DRAMA, FILM]} busy={false} onPlay={onPlay} onRemove={onRemove} />);
    expect(screen.getByText('2026 · Dramacool · episode 3')).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText('Play episode 4 of Hidden Summer on Dramacool')[0]!);
    expect(onPlay).toHaveBeenLastCalledWith(DRAMA);
    fireEvent.click(screen.getByLabelText('Play episode 3 of Hidden Summer again'));
    expect(onPlay).toHaveBeenLastCalledWith(DRAMA, 3);
    fireEvent.click(screen.getByLabelText('Take Devil River off this list'));
    expect(onRemove).toHaveBeenCalledWith(FILM);
    // A film has nothing to play "again".
    expect(screen.queryByLabelText(/Devil River again/)).toBeNull();
  });

  it('starts nothing while a play is being started', () => {
    const onPlay = vi.fn();
    render(<SiteTitlesSection titles={[DRAMA]} busy onPlay={onPlay} onRemove={() => undefined} />);
    fireEvent.click(screen.getAllByLabelText('Play episode 4 of Hidden Summer on Dramacool')[0]!);
    expect(onPlay).not.toHaveBeenCalled();
  });
});
