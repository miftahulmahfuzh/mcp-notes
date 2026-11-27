// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EntityGuide, GuideTitle } from '../../moviesApi';
import { GUIDE_WRITING_TEXT, type GuideEntityRef } from '../../lib/movies';
import { MOVIE } from '../../testing/movieFixtures';
import { EntityModal, GUIDE_ROWS_STEP } from './EntityModal';

/** The person, studio and genre pop-ups of docs/guide/movies.md ("Names you can click"). */

const gt = (over: Partial<GuideTitle>): GuideTitle => ({ kind: 'movie', tmdb_id: 1, title_id: 'movie-1', title: 'T', year: 2020, release_date: '2020-01-01', poster_url: null, note: null, movie_id: null, mark: null, interested: false, has_file: false, ...over });

const KILLING = gt({ tmdb_id: 467905, title_id: 'movie-467905', title: 'How to Make a Killing', year: 2026, note: 'as Julia', movie_id: 'M-23T4', mark: 'started', has_file: true });
const OLDER = gt({ tmdb_id: 900, title_id: 'movie-900', title: 'Older Film', year: 2019, note: 'as Ann', movie_id: 'M-9AAA', mark: 'watched' });
const SERIES_ROW = gt({ kind: 'tv', tmdb_id: 901, title_id: 'tv-901', title: 'A Series', year: null, note: 'as Herself', movie_id: null });
const PERSON: EntityGuide = {
  entity: { kind: 'person', name: 'Mara Example', image_url: 'https://img.test/mara.jpg', description: 'An actor.', facts: ['Acting', 'Born 1990 in Leeds'], link: 'https://www.themoviedb.org/person/4' },
  titles: [KILLING, OLDER, SERIES_ROW],
};
const MARA: GuideEntityRef = { kind: 'person', name: 'Mara Example', personId: 4, role: 'Julia', cast: true };
const STUDIO: GuideEntityRef = { kind: 'company', name: 'Blumhouse Productions', companyId: 3172 };
const CRIME: GuideEntityRef = { kind: 'genre', name: 'Crime' };
const CRIME_GUIDE: EntityGuide = { entity: { kind: 'genre', name: 'Crime', image_url: null, description: 'A con that curdles.', facts: [], link: null }, titles: [gt({ title: 'Close Cousin', note: 'the same cold humour' })], written_at: '2026-11-26T00:00:00.000Z', model: 'sonnet' };

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body: unknown) => Response | Promise<Response>>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  routes = {
    'GET /api/movies/people/4': () => json(PERSON),
    'GET /api/movies/companies/3172': () => json({ entity: { kind: 'company', name: 'Blumhouse Productions', image_url: null, description: '', facts: ['US'], link: null }, titles: [] }),
    'GET /api/movies/movie-467905/genres/Crime': () => json({ guide: CRIME_GUIDE, cached: true }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      calls.push({ method, url, body });
      const r = routes[`${method} ${url}`];
      return r === undefined ? json({ error: 'not_found' }, 404) : r(body);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(entity: GuideEntityRef, opts: { onAsk?: (e: GuideEntityRef) => void; open?: boolean } = {}) {
  const onClose = vi.fn();
  const onOpenTitle = vi.fn();
  render(<EntityModal entity={entity} detail={MOVIE} onClose={onClose} onAsk={opts.onAsk} onOpenTitle={opts.open === false ? undefined : onOpenTitle} />);
  return { onClose, onOpenTitle };
}

const dialog = () => within(screen.getByRole('dialog'));
const rowOf = (title: string) => screen.getAllByTestId('guide-title').find((r) => r.querySelector('.mm-ent-name')?.textContent === title)!;
const marksOf = (title: string) => within(rowOf(title).closest('li') as HTMLElement);
const posted = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body);

describe('EntityModal: a person', () => {
  it("shows the photo, the facts, the biography, the count line and every credit with its role and the owner's tags", async () => {
    show(MARA);
    expect(dialog().getByRole('status').textContent).toBe('Reading about Mara Example…');
    await dialog().findByText('An actor.');
    expect(dialog().getByText('person')).toBeTruthy();
    expect(dialog().getByRole('img', { name: 'Mara Example' }).getAttribute('src')).toBe('https://img.test/mara.jpg');
    expect(dialog().getByText('Born 1990 in Leeds')).toBeTruthy();
    expect(dialog().getByRole('link', { name: 'Open its page' }).getAttribute('href')).toBe('https://www.themoviedb.org/person/4');
    expect(screen.getByRole('status').textContent).toBe('3 titles · 1 watched · 1 started · newest first');
    // started, a file here, and the movie id when it is stored; an undated series says so.
    expect([...rowOf('How to Make a Killing').querySelectorAll('.mm-ent-tags > span')].map((s) => s.textContent)).toEqual(['started', 'file here', 'M-23T4']);
    expect(rowOf('Older Film').querySelector('.mm-ent-tags')?.textContent).toBe('M-9AAA');
    expect(rowOf('A Series').querySelector('.mm-ent-line')?.textContent).toBe('undated · series · as Herself');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/movies/people/4']);
  });

  it('a long biography is cut with "more", which shows the whole of it and turns to "less"', async () => {
    const long = 'A long life in film. '.repeat(30);
    routes['GET /api/movies/people/4'] = () => json({ ...PERSON, entity: { ...PERSON.entity, description: long } });
    show(MARA);
    const desc = await screen.findByTestId('entity-description');
    expect(desc.className).toContain('clamp');
    fireEvent.click(dialog().getByRole('button', { name: 'more' }));
    expect(desc.className).not.toContain('clamp');
    fireEvent.click(dialog().getByRole('button', { name: 'less' }));
    expect(desc.className).toContain('clamp');
  });

  it('the chat icon asks about the name and closes the pop-up; without onAsk there is no chat icon', async () => {
    const onAsk = vi.fn();
    const { onClose } = show(MARA, { onAsk });
    fireEvent.click(dialog().getByRole('button', { name: 'Ask the chat about Mara Example' }));
    expect(onAsk).toHaveBeenCalledWith(MARA);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    show(MARA);
    await dialog().findByText('An actor.');
    expect(dialog().queryByRole('button', { name: /^Ask the chat/ })).toBeNull();
  });

  it('TMDB with no credentials, or a name TMDB does not know, says so', async () => {
    routes['GET /api/movies/people/4'] = () => json({ error: 'tmdb_off' }, 503);
    show(MARA);
    expect((await screen.findByRole('alert')).textContent).toBe('No TMDB credentials are configured, so this cannot be read.');
    cleanup();
    routes['GET /api/movies/people/4'] = () => json({ error: 'not_found' }, 404);
    show(MARA);
    expect((await screen.findByRole('alert')).textContent).toBe('TMDB does not know this one.');
    cleanup();
    routes['GET /api/movies/people/4'] = () => json({ error: 'tmdb_error', message: 'TMDB answered 502' }, 502);
    show(MARA);
    expect((await screen.findByRole('alert')).textContent).toBe('TMDB answered 502');
  });
});

describe('EntityModal: a studio', () => {
  it('a studio with no description and no titles shows neither, and says nothing is listed', async () => {
    show(STUDIO);
    expect(await dialog().findByText('No films or series are listed.')).toBeTruthy();
    expect(dialog().getByText('studio')).toBeTruthy();
    expect(screen.queryByTestId('entity-description')).toBeNull();
    expect(dialog().queryByRole('link', { name: 'Open its page' })).toBeNull();
    expect(dialog().queryByRole('button', { name: 'Rewrite this guide' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('0 titles · newest first');
  });

  it(`draws the first ${GUIDE_ROWS_STEP} rows of a long list, and more as it is scrolled near the end`, async () => {
    const titles = Array.from({ length: 2 * GUIDE_ROWS_STEP + 20 }, (_, i) => gt({ tmdb_id: 10_000 + i, title_id: `movie-${10_000 + i}`, title: `Film ${i}` }));
    routes['GET /api/movies/companies/3172'] = () => json({ entity: { kind: 'company', name: 'Blumhouse Productions', image_url: null, description: '', facts: [], link: null }, titles });
    show(STUDIO);
    await waitFor(() => expect(screen.getAllByTestId('guide-title')).toHaveLength(GUIDE_ROWS_STEP));
    // The count line counts every title, not only the drawn ones.
    expect(screen.getByRole('status').textContent).toBe(`${titles.length} titles · newest first`);
    const scroller = document.querySelector('.mm-ent-scroll') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 10_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    // Far from the end: nothing more.
    expect(screen.getAllByTestId('guide-title')).toHaveLength(GUIDE_ROWS_STEP);
    scroller.scrollTop = 8500;
    fireEvent.scroll(scroller);
    expect(screen.getAllByTestId('guide-title')).toHaveLength(2 * GUIDE_ROWS_STEP);
    fireEvent.scroll(scroller);
    expect(screen.getAllByTestId('guide-title')).toHaveLength(titles.length);
  });
});

describe('EntityModal: a genre', () => {
  it('a stored guide opens at once, with no model asked, for this title', async () => {
    show(CRIME);
    await dialog().findByText('A con that curdles.');
    expect(dialog().getByText('genre · for How to Make a Killing')).toBeTruthy();
    expect(dialog().getByText('collated by sonnet from a web search · stored')).toBeTruthy();
    expect(posted('/api/movies/movie-467905/genres/Crime')).toEqual([]);
  });

  it('a guide never written says it is being collated, then asks for it once', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    routes['GET /api/movies/movie-467905/genres/Crime'] = () => json({ guide: null, cached: false });
    routes['POST /api/movies/movie-467905/genres/Crime'] = async () => {
      await hold;
      return json({ guide: CRIME_GUIDE, cached: false });
    };
    show(CRIME);
    await waitFor(() => expect(dialog().getByRole('status').textContent).toBe(GUIDE_WRITING_TEXT));
    release();
    await dialog().findByText('A con that curdles.');
    expect(posted('/api/movies/movie-467905/genres/Crime')).toEqual([{}]);
  });

  it('the refresh icon searches and writes it again, skipping the stored one', async () => {
    routes['POST /api/movies/movie-467905/genres/Crime'] = () => json({ guide: { ...CRIME_GUIDE, entity: { ...CRIME_GUIDE.entity, description: 'Rewritten.' } }, cached: false });
    show(CRIME);
    await dialog().findByText('A con that curdles.');
    fireEvent.click(dialog().getByRole('button', { name: 'Rewrite this guide' }));
    await dialog().findByText('Rewritten.');
    expect(posted('/api/movies/movie-467905/genres/Crime')).toEqual([{ refresh: true }]);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('guides off says how they are turned off', async () => {
    routes['GET /api/movies/movie-467905/genres/Crime'] = () => json({ guide: null, cached: false });
    routes['POST /api/movies/movie-467905/genres/Crime'] = () => json({ error: 'guide_off' }, 503);
    show(CRIME);
    expect((await screen.findByRole('alert')).textContent).toBe('Genre guides are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, no claude binary, or no TMDB credentials).');
  });
});

describe('EntityModal: the three mark buttons', () => {
  it('clears the watched flag of a stored title without storing it again; a title finished by playing stays watched and says so', async () => {
    routes['POST /api/movies/movie-900/user'] = () => json({ ...MOVIE, id: 'movie-900', movie_id: 'M-9AAA', watched: false, state: 'finished', interested: false, not_interested: false });
    show(MARA);
    await dialog().findByText('An actor.');
    expect(marksOf('Older Film').getByTestId('guide-mark-watched').getAttribute('aria-label')).toBe('Older Film: watched (click to unmark)');
    fireEvent.click(marksOf('Older Film').getByTestId('guide-mark-watched'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Older Film stays watched: it was finished by playing it'));
    expect(posted('/api/movies/movie-900/user')).toEqual([{ watched: false }]);
    expect(posted('/api/movies/ensure')).toEqual([]);
    expect(marksOf('Older Film').getByTestId('guide-mark-watched').getAttribute('aria-pressed')).toBe('true');
  });

  it('a series not held is stored first, then marked watched (every season), and its row takes the movie id', async () => {
    routes['POST /api/movies/ensure'] = () => json({ title_id: 'tv-901', movie_id: 'M-SER1' });
    routes['POST /api/movies/tv-901/user'] = () => json({ ...MOVIE, id: 'tv-901', kind: 'tv', movie_id: 'M-SER1', watched: true, state: 'finished', interested: false, not_interested: false });
    show(MARA);
    await dialog().findByText('An actor.');
    expect(marksOf('A Series').getByTestId('guide-mark-watched').getAttribute('aria-label')).toBe('Mark A Series as watched, every season');
    fireEvent.click(marksOf('A Series').getByTestId('guide-mark-watched'));
    await waitFor(() => expect(marksOf('A Series').getByTestId('guide-mark-watched').getAttribute('aria-pressed')).toBe('true'));
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([
      ['/api/movies/ensure', { kind: 'tv', tmdb_id: 901 }],
      ['/api/movies/tv-901/user', { watched: true }],
    ]);
    expect(rowOf('A Series').querySelector('.mv-code')?.textContent).toBe('M-SER1');
    expect(screen.getByRole('status').textContent).toBe('3 titles · 2 watched · 1 started · newest first');
  });

  it('"interested" and "not interested" never stand together: the row shows what the server answered', async () => {
    routes['POST /api/movies/movie-467905/user'] = (body) => {
      const b = body as { interested?: boolean; not_interested?: boolean };
      return json({ ...MOVIE, state: 'in_progress', watched: false, interested: b.interested === true, not_interested: b.not_interested === true });
    };
    show(MARA);
    await dialog().findByText('An actor.');
    const pressed = () => ['watched', 'interested', 'not_interested'].map((m) => marksOf('How to Make a Killing').getByTestId(`guide-mark-${m}`).getAttribute('aria-pressed'));
    fireEvent.click(marksOf('How to Make a Killing').getByTestId('guide-mark-interested'));
    await waitFor(() => expect(pressed()).toEqual(['false', 'true', 'false']));
    expect(screen.getByRole('status').textContent).toBe('3 titles · 1 watched · 1 started · 1 interested · newest first');
    fireEvent.click(marksOf('How to Make a Killing').getByTestId('guide-mark-not_interested'));
    await waitFor(() => expect(pressed()).toEqual(['false', 'false', 'true']));
    expect(rowOf('How to Make a Killing').dataset.mark).toBe('not_interested');
    expect(posted('/api/movies/movie-467905/user')).toEqual([{ interested: true }, { not_interested: true }]);
  });

  it('a mark that fails says so and leaves the row as it was; the buttons wait while one saves', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    routes['POST /api/movies/movie-900/user'] = async () => {
      await hold;
      return json({ error: 'movies_off' }, 503);
    };
    show(MARA);
    await dialog().findByText('An actor.');
    fireEvent.click(marksOf('Older Film').getByTestId('guide-mark-interested'));
    await waitFor(() => expect((marksOf('How to Make a Killing').getByTestId('guide-mark-watched') as HTMLButtonElement).disabled).toBe(true));
    release();
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Older Film could not be marked: /));
    expect(marksOf('Older Film').getByTestId('guide-mark-interested').getAttribute('aria-pressed')).toBe('false');
    expect((marksOf('Older Film').getByTestId('guide-mark-interested') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('EntityModal: opening a listed title', () => {
  it('a stored title opens its pop-up by movie id at once; one not held is stored first, once', async () => {
    routes['POST /api/movies/ensure'] = () => json({ title_id: 'tv-901', movie_id: 'M-SER1' });
    const { onOpenTitle } = show(MARA);
    await dialog().findByText('An actor.');
    fireEvent.click(rowOf('Older Film'));
    expect(onOpenTitle).toHaveBeenCalledWith('M-9AAA');
    fireEvent.click(rowOf('A Series'));
    await waitFor(() => expect(onOpenTitle).toHaveBeenLastCalledWith('M-SER1'));
    fireEvent.click(rowOf('A Series'));
    expect(onOpenTitle).toHaveBeenCalledTimes(3);
    expect(posted('/api/movies/ensure')).toEqual([{ kind: 'tv', tmdb_id: 901 }]);
  });

  it('a title that cannot be stored says why and opens nothing', async () => {
    routes['POST /api/movies/ensure'] = () => json({ error: 'tmdb_off' }, 503);
    const { onOpenTitle } = show(MARA);
    await dialog().findByText('An actor.');
    fireEvent.click(rowOf('A Series'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('A Series could not be opened: No TMDB credentials are configured, so this cannot be read.'));
    expect(onOpenTitle).not.toHaveBeenCalled();
  });

  it('with nowhere to open a title, the rows are not buttons that do anything', async () => {
    show(MARA, { open: false });
    await dialog().findByText('An actor.');
    for (const r of screen.getAllByTestId('guide-title')) expect((r as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('EntityModal: closing', () => {
  it('Esc, the X and a click outside close it; a click inside does not', async () => {
    const { onClose } = show(MARA);
    await dialog().findByText('An actor.');
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog().getByRole('button', { name: 'Close' }));
    fireEvent.click(document.querySelector('[data-modal="entity"]')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('while the movie pop-up lies over it, its Esc and a click outside are the movie pop-up\'s', async () => {
    const { onClose } = show(MARA);
    await dialog().findByText('An actor.');
    const movie = document.createElement('div');
    movie.dataset.modal = 'movie';
    document.body.appendChild(movie);
    try {
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(document.querySelector('[data-modal="entity"]')!);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      movie.remove();
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
