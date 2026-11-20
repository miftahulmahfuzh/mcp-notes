// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../api';
import { normalizeStory, writeStory, type StoryView } from '../../moviesApi';
import { PLAYER_IDLE, SERIES } from '../../testing/movieFixtures';
import { EpisodeList, type EpisodeListProps } from './EpisodeList';
import { STORY_NOT_FOUND_TEXT, StoryModal, storyErrorText } from './StoryModal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STORY: StoryView = {
  season: 18,
  episode: 760,
  text: 'Jack gasses Zou.\n\nSanji arrives the next day.',
  model: 'sonnet',
  written_at: '2026-11-16T06:00:00.000Z',
  origin: 'dialogue',
  sources: [],
  sections: [],
  provider: 'VidNest Anime',
  cues: 292,
};
const SEASON_STORY: StoryView = {
  season: 1,
  episode: 0,
  text: 'Harry is called in.\n\nThe families clash.',
  model: 'sonnet',
  written_at: '2026-11-20T10:00:00.000Z',
  origin: 'web',
  sources: [
    { url: 'https://en.wikipedia.org/wiki/MobLand', title: 'MobLand - Wikipedia', site: 'Wikipedia' },
    { url: 'https://www.vulture.com/article/mobland-recap-season-1-episode-1.html', title: 'MobLand Recap: Stick or Twist', site: 'Vulture' },
  ],
  sections: [
    { episode: 1, name: 'Stick or Twist', text: 'Harry Da Souza is called in.\n\nA body turns up.', found: true },
    { episode: 2, name: 'Eye for an Eye', text: 'The families clash.', found: true },
    { episode: 3, name: 'Lie Down with Dogs', text: '', found: false },
  ],
  provider: null,
  cues: null,
};
const noop = () => {};

describe('StoryModal', () => {
  it('asks for an episode\'s story when it opens, says it searches the web, then shows it as paragraphs with where it came from', async () => {
    let answer: (r: { story: StoryView; cached: boolean }) => void = () => {};
    const load = vi.fn(() => new Promise<{ story: StoryView; cached: boolean }>((resolve) => { answer = resolve; }));
    render(<StoryModal titleId="tv-37854" season={18} episode={760} name="One Piece S18E760" stored={false} onClose={noop} load={load} />);
    expect(load).toHaveBeenCalledWith('tv-37854', 18, 760);
    expect(screen.getByRole('status').textContent).toMatch(/Searching the web for a published recap of this episode/);
    expect(screen.getByRole('status').textContent).toMatch(/a minute or two/);
    answer({ story: STORY, cached: false });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const dialog = screen.getByRole('dialog', { name: 'Story of One Piece S18E760' });
    expect([...dialog.querySelectorAll('.mm-story-text p')].map((p) => p.textContent)).toEqual([
      'Jack gasses Zou.',
      'Sanji arrives the next day.',
      'written by sonnet from 292 subtitle lines (VidNest Anime) · just now, and stored',
    ]);
    expect(within(dialog).queryByRole('region', { name: 'Sources' })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks for a whole season, then shows one section per episode under its heading, the not-found line, and the sources as links', async () => {
    let answer: (r: { story: StoryView; cached: boolean }) => void = () => {};
    const load = vi.fn(() => new Promise<{ story: StoryView; cached: boolean }>((resolve) => { answer = resolve; }));
    render(<StoryModal titleId="tv-247718" season={1} episode={null} name="MobLand S01" stored={false} onClose={noop} load={load} />);
    expect(load).toHaveBeenCalledWith('tv-247718', 1, null);
    expect(screen.getByRole('status').textContent).toMatch(/Searching the web for published recaps of this season/);
    answer({ story: SEASON_STORY, cached: false });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const dialog = screen.getByRole('dialog', { name: 'Story of MobLand S01' });
    expect([...dialog.querySelectorAll('.mm-story-sec > h3')].map((h) => h.textContent)).toEqual([
      'S01E01 · Stick or Twist',
      'S01E02 · Eye for an Eye',
      'S01E03 · Lie Down with Dogs',
    ]);
    expect([...within(dialog).getByRole('region', { name: 'S01E01 · Stick or Twist' }).querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Harry Da Souza is called in.',
      'A body turns up.',
    ]);
    const third = within(dialog).getByRole('region', { name: 'S01E03 · Lie Down with Dogs' });
    expect(third.textContent).toContain(STORY_NOT_FOUND_TEXT);
    expect(third.getAttribute('data-found')).toBe('false');
    // The season's flat text is not shown beside its sections.
    expect(dialog.textContent).not.toContain('Harry is called in.');
    const links = within(within(dialog).getByRole('region', { name: 'Sources' })).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['MobLand - Wikipedia', 'https://en.wikipedia.org/wiki/MobLand', '_blank', 'noreferrer'],
      ['MobLand Recap: Stick or Twist', 'https://www.vulture.com/article/mobland-recap-season-1-episode-1.html', '_blank', 'noreferrer'],
    ]);
    expect(dialog.querySelector('.mm-story-foot')?.textContent).toBe('written by sonnet from 2 web sources · just now, and stored');
  });

  it('opens a stored story without the long wait text, and says why when there is none', async () => {
    const stored = render(<StoryModal titleId="tv-1" season={1} episode={1} name="X S01E01" stored onClose={noop} load={async () => ({ story: STORY, cached: true })} />);
    expect(screen.getByRole('status').textContent).toBe('Opening the story…');
    await waitFor(() => expect(stored.baseElement.querySelector('.mm-story-foot')?.textContent).toMatch(/· stored$/));
    cleanup();
    render(<StoryModal titleId="tv-1" season={1} episode={1} name="X S01E01" stored={false} onClose={noop} load={async () => Promise.reject(new ApiError(502, 'no_subtitle', 'VidFast streams it without an English subtitle.'))} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A stream of this episode was found, but it has no English subtitle to write the story from.'));
    cleanup();
    render(<StoryModal titleId="tv-1" season={2} episode={null} name="X S02" stored={false} onClose={noop} load={async () => Promise.reject(new ApiError(502, 'no_story_source', 'nothing found'))} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(storyErrorText('no_story_source', null)));
    expect(storyErrorText('no_story_source', null)).toMatch(/No published recap of this was found on the web/);
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

describe('writeStory and the story read off the wire', () => {
  const answering = (story: unknown) => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ story, cached: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const sent = (fetchMock: ReturnType<typeof answering>) => {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    return [url, JSON.parse(init.body) as unknown];
  };

  it('posts {season} for a season and {season, episode} for an episode', async () => {
    let f = answering({ season: 2, episode: 0, text: '' });
    await writeStory('tv-1', 2, null);
    expect(sent(f)).toEqual(['/api/movies/tv-1/story', { season: 2 }]);
    vi.unstubAllGlobals();
    f = answering({ season: 2, episode: 3, text: 'x' });
    await writeStory('tv-1', 2, 3);
    expect(sent(f)).toEqual(['/api/movies/tv-1/story', { season: 2, episode: 3 }]);
  });

  it('keeps only web links, each once, puts sections in episode order, and reads an older daemon\'s story as a subtitle one', async () => {
    answering({
      season: 2,
      episode: 0,
      text: 'x',
      origin: 'web',
      sources: [
        { url: 'javascript:alert(1)', title: 'bad', site: 'x' },
        { url: 'https://example.org/a', title: '', site: '' },
        { url: 'https://example.org/a', title: 'again', site: 'Example' },
      ],
      sections: [
        { episode: 2, name: 'Two', text: '   ', found: true },
        { episode: 1, name: '', text: 'One.', found: true },
        { name: 'no number', text: 'y', found: true },
      ],
    });
    const { story } = await writeStory('tv-1', 2, null);
    expect(story.sources).toEqual([{ url: 'https://example.org/a', title: 'https://example.org/a', site: 'example.org' }]);
    expect(story.sections).toEqual([
      { episode: 1, name: null, text: 'One.', found: true },
      { episode: 2, name: 'Two', text: '   ', found: false },
    ]);
    expect(normalizeStory({ season: 1, episode: 1, text: 't', provider: 'VidFast', cues: 10 })).toEqual({
      season: 1, episode: 1, text: 't', model: null, written_at: null, origin: 'dialogue', sources: [], sections: [], provider: 'VidFast', cues: 10,
    });
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
    expect(write.getAttribute('data-tip')).toMatch(/published recaps on the web/);
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
