// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../api';
import type { StoryView } from '../../moviesApi';
import { PLAYER_IDLE, SERIES } from '../../testing/movieFixtures';
import { EpisodeList, type EpisodeListProps } from './EpisodeList';
import { StoryModal, storyErrorText } from './StoryModal';

afterEach(cleanup);

const STORY: StoryView = { season: 18, episode: 760, text: 'Jack gasses Zou.\n\nSanji arrives the next day.', model: 'sonnet', written_at: '2026-11-16T06:00:00.000Z', provider: 'VidNest Anime', cues: 292 };
const noop = () => {};

describe('StoryModal', () => {
  it('asks for the story when it opens, says it is being written, then shows it as paragraphs with where it came from', async () => {
    let answer: (r: { story: StoryView; cached: boolean }) => void = () => {};
    const load = vi.fn(() => new Promise<{ story: StoryView; cached: boolean }>((resolve) => { answer = resolve; }));
    render(<StoryModal titleId="tv-37854" season={18} episode={760} name="One Piece S18E760" stored={false} onClose={noop} load={load} />);
    expect(load).toHaveBeenCalledWith('tv-37854', 18, 760);
    expect(screen.getByRole('status').textContent).toMatch(/Reading the subtitle of this episode, then writing its story/);
    answer({ story: STORY, cached: false });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const dialog = screen.getByRole('dialog', { name: 'Story of One Piece S18E760' });
    expect([...dialog.querySelectorAll('.mm-story-text p')].map((p) => p.textContent)).toEqual([
      'Jack gasses Zou.',
      'Sanji arrives the next day.',
      'written by sonnet from 292 subtitle lines (VidNest Anime) · just now, and stored',
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('opens a stored story without the long wait text, and says why when there is none', async () => {
    const stored = render(<StoryModal titleId="tv-1" season={1} episode={1} name="X S01E01" stored onClose={noop} load={async () => ({ story: STORY, cached: true })} />);
    expect(screen.getByRole('status').textContent).toBe('Opening the story…');
    await waitFor(() => expect(stored.baseElement.querySelector('.mm-story-foot')?.textContent).toMatch(/· stored$/));
    cleanup();
    render(<StoryModal titleId="tv-1" season={1} episode={1} name="X S01E01" stored={false} onClose={noop} load={async () => Promise.reject(new ApiError(502, 'no_subtitle', 'VidFast streams it without an English subtitle.'))} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A stream of this episode was found, but it has no English subtitle to write the story from.'));
    expect(storyErrorText('story_failed', 'The story could not be written: no story within 240 s')).toBe('The story could not be written: no story within 240 s');
    expect(storyErrorText('weird', null)).toBe('The story could not be written (weird).');
  });

  it('closes on Esc, on its button and on a click outside', () => {
    const onClose = vi.fn();
    render(<StoryModal titleId="tv-1" season={1} episode={1} name="X" stored onClose={onClose} load={() => new Promise(() => {})} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(document.querySelector('[data-modal="story"]')!);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('EpisodeList: the story button', () => {
  const props = (over: Partial<EpisodeListProps> = {}): EpisodeListProps => ({
    detail: SERIES, player: PLAYER_IDLE, busy: false, side: 'library', streamEnabled: false, onPlay: noop, onStream: noop, onWatched: noop, onSeasonWatched: noop, onEpisodeWatched: noop, onTrailer: noop, ...over,
  });

  it('sits between the episode code and its name, opens that episode, and is filled once a story is stored', () => {
    const [first, second] = SERIES.seasons[0]!.episodes;
    const detail = { ...SERIES, seasons: [{ ...SERIES.seasons[0]!, episodes: SERIES.seasons[0]!.episodes.map((e, i) => (i === 1 ? { ...e, has_story: true } : e)) }] };
    const onStory = vi.fn();
    render(<EpisodeList {...props({ detail, onStory })} />);
    const row = document.querySelector('[data-testid="movie-file"]')!;
    expect([...row.children].slice(0, 3).map((c) => c.className.split(' ')[0])).toEqual(['mv-code', 'pbtn', 'mv-row-t']);
    const write = screen.getByRole('button', { name: /^Write the story of S01E01$/ });
    expect(write.getAttribute('data-stored')).toBeNull();
    expect(screen.getByRole('button', { name: /^The story of S01E02$/ }).getAttribute('data-stored')).toBe('true');
    fireEvent.click(write);
    expect(onStory).toHaveBeenCalledWith(expect.objectContaining({ season: first!.season, episode: first!.episode }));
    expect(second).toBeDefined();
  });

  it('is not there when the page gives no handler', () => {
    render(<EpisodeList {...props()} />);
    expect(screen.queryByRole('button', { name: /story/i })).toBeNull();
  });
});
