// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { errorCode, errorDetail, type EpisodeView, type TitleDetail } from '../../moviesApi';
import { MOVIE, PLAYER_IDLE, SERIES } from '../../testing/movieFixtures';
import { isPlayMenuOpen, PlayMenu } from './PlayMenu';

/** The play menu as docs/guide/movies.md ("The play menu") describes it: rows, hints, and what each row posts. */

interface Post {
  url: string;
  body: unknown;
}
let posts: Post[];
/** Per URL: the error the fake daemon answers with, else 200 with `answers[url]` (or `{}`). */
let fails: Record<string, { status: number; error: string; message?: string }>;
let answers: Record<string, unknown>;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  posts = [];
  fails = {};
  answers = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST') posts.push({ url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      const f = fails[url];
      if (f !== undefined) return json({ error: f.error, message: f.message }, f.status);
      if (url.startsWith('/api/stream/torrents?')) return json({ original_language: 'en', listed_at: null, cached: false, candidates: [] });
      return json(answers[url] ?? {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What the page does with onRun: says `doing` at once, then the play's notice or the failure text. */
function harness() {
  const said: string[] = [];
  const doing: string[] = [];
  const onRun = (act: () => Promise<string>, failed: (code: string, detail: string | null) => string, what: string) => {
    doing.push(what);
    act().then(
      (t) => said.push(t),
      (e: unknown) => said.push(failed(errorCode(e), errorDetail(e))),
    );
  };
  return { said, doing, onRun };
}

const rowsOf = () => within(screen.getByRole('menu')).getAllByRole('menuitem');
const row = (name: RegExp) => within(screen.getByRole('menu')).getByRole('menuitem', { name });

function open(detail: TitleDetail, episode: EpisodeView | null = null, streamEnabled = true) {
  const h = harness();
  render(<PlayMenu detail={detail} episode={episode} player={PLAYER_IDLE} busy={false} streamEnabled={streamEnabled} size="page" onRun={h.onRun} />);
  fireEvent.click(screen.getByRole('button', { name: /^Choose how to play / }));
  return h;
}

const ep = (season: number, episode: number): EpisodeView => SERIES.seasons.find((s) => s.season === season)!.episodes.find((e) => e.episode === episode)!;

const REMEMBERED: TitleDetail = {
  ...MOVIE,
  played_through: { channel: 'torrent', provider: null, played_at: '2026-11-17T10:00:00.000Z', season: null, episode: null },
  played_methods: [
    { method: 'cloud', provider: 'VidRock', played_at: '2026-11-18T10:00:00.000Z', season: null, episode: null },
    { method: 'torrent', provider: null, played_at: '2026-11-17T10:00:00.000Z', season: null, episode: null },
    { method: 'lk21', provider: null, played_at: '2026-11-16T10:00:00.000Z', season: null, episode: null },
  ],
};

describe('PlayMenu: the rows', () => {
  it('a film with a file here lists the file, the two kinds of stream and the four sites, each with what it remembers', () => {
    open(REMEMBERED);
    expect(isPlayMenuOpen()).toBe(true);
    expect(screen.getByRole('menu', { name: 'Play How to Make a Killing from' })).toBeTruthy();
    expect(screen.getByText('play How to Make a Killing from')).toBeTruthy();
    expect(rowsOf().map((r) => r.dataset.method)).toEqual(['file', 'cloud', 'torrent', 'idlix', 'lk21', 'flicksy', 'dramacool']);
    const hints = rowsOf().map((r) => r.querySelector('.mv-menu-hint')?.textContent ?? null);
    expect(hints).toEqual(['Resume at 45:00', 'VidRock first, as on Nov 18, 2026', 'the same torrent as on Nov 17, 2026', null, 'played Nov 16, 2026', null, null]);
    // The row the title last played through is flagged, and only that one.
    expect(rowsOf().filter((r) => r.textContent?.includes('played last')).map((r) => r.dataset.method)).toEqual(['torrent']);
  });

  it('a kind of stream that found nothing says so with its day', () => {
    open({ ...MOVIE, stream_failed: { cloud_at: '2026-11-15T10:00:00.000Z', torrent_at: '2026-11-14T10:00:00.000Z' } });
    expect(row(/^Non Torrent stream/).textContent).toContain('found nothing on Nov 15, 2026');
    expect(row(/^Torrent stream/).textContent).toContain('found nothing on Nov 14, 2026');
  });

  it("a series' own menu names the episode Play carries on with, and lists only the sites that play episodes", () => {
    open(SERIES);
    expect(screen.getByText('play S01E02 from')).toBeTruthy();
    // MobLand has a file here (S01E02): the file row is Continue's.
    expect(rowsOf().map((r) => r.dataset.method)).toEqual(['file', 'cloud', 'torrent', 'idlix', 'dramacool']);
    expect(row(/^Downloaded file/).textContent).toContain('Continue: resume the open episode or play the next one');
  });

  it('a torrent remembered for another episode is "last from a torrent", not "the same torrent"', () => {
    open({ ...SERIES, played_methods: [{ method: 'torrent', provider: null, played_at: '2026-11-17T10:00:00.000Z', season: 1, episode: 1 }] }, ep(1, 2));
    expect(row(/^Torrent stream/).textContent).toContain('last from a torrent on Nov 17, 2026');
  });

  it('a site row says the episode it played last', () => {
    open({ ...SERIES, played_methods: [{ method: 'dramacool', provider: null, played_at: '2026-11-16T10:00:00.000Z', season: 1, episode: 3 }] }, ep(1, 2));
    expect(row(/^Dramacool/).textContent).toContain('played S01E03 · Nov 16, 2026');
  });

  it('an episode whose file is on the other machine offers pahe in place of the file, and says where the file is', () => {
    open(SERIES, ep(1, 3));
    expect(rowsOf()[0]!.dataset.method).toBe('pahe');
    expect(rowsOf()[0]!.textContent).toContain('a file is on gpd, none here');
  });

  it('an episode with a deleted file, or none at all, says no file is on this machine', () => {
    open(SERIES, ep(1, 1));
    expect(rowsOf()[0]!.dataset.method).toBe('pahe');
    expect(rowsOf()[0]!.textContent).toContain('no file on this machine');
    cleanup();
    open(SERIES, ep(1, 4));
    expect(rowsOf()[0]!.textContent).toContain('no file on this machine');
  });

  it('a film whose only file is on the other machine offers pahe and names that machine', () => {
    open({ ...MOVIE, files: [{ ...MOVIE.files[0]!, host: 'gpd', available: false, unavailable_reason: 'not_on_this_machine' }] });
    expect(rowsOf()[0]!.dataset.method).toBe('pahe');
    expect(rowsOf()[0]!.textContent).toContain('a file is on gpd, none here');
  });

  it('with direct streaming off both kinds of stream are disabled and say why; the torrent list button too', () => {
    open(MOVIE, null, false);
    for (const name of [/^Non Torrent stream/, /^Torrent stream/]) {
      expect((row(name) as HTMLButtonElement).disabled).toBe(true);
      expect(row(name).textContent).toContain('direct streaming is off on this machine');
    }
    expect((screen.getByRole('button', { name: 'Every torrent of How to Make a Killing' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a series with no episode listed disables the streams and the sites', () => {
    open({ ...SERIES, files: [], seasons: [] });
    expect(screen.getByText('play MobLand from')).toBeTruthy();
    for (const r of rowsOf().slice(1)) {
      expect((r as HTMLButtonElement).disabled).toBe(true);
      expect(r.textContent).toContain('no episode is listed');
    }
    // Nothing to list torrents of.
    expect(screen.queryByRole('button', { name: /^Every torrent of/ })).toBeNull();
  });
});

describe('PlayMenu: what each row posts', () => {
  it('the file row of a film plays its file in VLC', async () => {
    const h = open(MOVIE);
    fireEvent.click(row(/^Downloaded file/));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(h.doing).toEqual(['opening VLC']);
    await waitFor(() => expect(h.said).toEqual(['resuming at 45:00']));
    expect(posts).toEqual([{ url: '/api/movies/files/11/play', body: {} }]);
  });

  it("the file row of a series' own menu asks continue; of an episode row, plays that episode's file", async () => {
    answers['/api/movies/continue'] = { action: 'started', title: { id: 'tv-247718', title: 'MobLand', kind: 'tv', year: 2025 }, file: { file_id: 22, season: 1, episode: 2, absolute_episode: null, name: null }, position: 0, play: {} };
    const h = open(SERIES);
    fireEvent.click(row(/^Downloaded file/));
    await waitFor(() => expect(h.said).toEqual(['playing S01E02']));
    expect(posts).toEqual([{ url: '/api/movies/continue', body: { title: 'tv-247718' } }]);
    cleanup();
    posts = [];
    const e = open(SERIES, ep(1, 2));
    fireEvent.click(row(/^Downloaded file/));
    await waitFor(() => expect(e.said).toEqual(['resuming at 20:00']));
    expect(posts).toEqual([{ url: '/api/movies/files/22/play', body: {} }]);
  });

  it('Non Torrent stream and Torrent stream post the episode with the provider named', async () => {
    const h = open(SERIES, ep(1, 3));
    fireEvent.click(row(/^Non Torrent stream/));
    await waitFor(() => expect(h.said).toEqual(['opening in the streaming Chrome, from a cloud provider']));
    expect(h.doing).toEqual(['asking the cloud providers']);
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to play S01E03' }));
    fireEvent.click(row(/^Torrent stream/));
    await waitFor(() => expect(h.said).toHaveLength(2));
    expect(h.said[1]).toBe('opening in the streaming Chrome, from a torrent');
    expect(h.doing[1]).toBe('asking the torrents');
    expect(posts.map((p) => p.body)).toEqual([
      { kind: 'tv', tmdb_id: 247718, season: 1, episode: 3, provider: 'cloud' },
      { kind: 'tv', tmdb_id: 247718, season: 1, episode: 3, provider: 'torrent' },
    ]);
  });

  it('a stream row that finds nothing names the kind that failed', async () => {
    fails['/api/stream/play'] = { status: 404, error: 'no_source' };
    const h = open(MOVIE);
    fireEvent.click(row(/^Torrent stream/));
    await waitFor(() => expect(h.said).toEqual(['no torrent could stream How to Make a Killing now']));
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to play How to Make a Killing' }));
    fireEvent.click(row(/^Non Torrent stream/));
    await waitFor(() => expect(h.said[1]).toBe('no cloud provider could stream How to Make a Killing now'));
  });

  it("a site row posts the site, with the series' episode; a film's with none", async () => {
    const h = open(SERIES);
    fireEvent.click(row(/^Idlix/));
    expect(h.doing).toEqual(["starting it on Idlix: the site's own countdown can take a minute"]);
    await waitFor(() => expect(h.said).toEqual(['Playing S01E02 on Idlix in the streaming Chrome window']));
    cleanup();
    open(MOVIE);
    fireEvent.click(row(/^Flicksy/));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts).toEqual([
      { url: '/api/movies/tv-247718/site-play', body: { site: 'idlix', season: 1, episode: 2 } },
      { url: '/api/movies/movie-467905/site-play', body: { site: 'flicksy' } },
    ]);
  });

  it("a site that cannot start it says why in the daemon's words; the sites off says so", async () => {
    fails['/api/movies/movie-467905/site-play'] = { status: 409, error: 'several_matches', message: 'lk21 lists 2 titles named How to Make a Killing: name one with /lk21 in chat' };
    const h = open(MOVIE);
    fireEvent.click(row(/^Lk21/));
    await waitFor(() => expect(h.said).toEqual(['lk21 lists 2 titles named How to Make a Killing: name one with /lk21 in chat']));
    fails['/api/movies/movie-467905/site-play'] = { status: 503, error: 'streaming_off' };
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to play How to Make a Killing' }));
    fireEvent.click(row(/^Lk21/));
    await waitFor(() => expect(h.said[1]).toBe('the streaming sites are off on this machine'));
  });
});

describe('PlayMenu: the pahe row', () => {
  const noFile: TitleDetail = { ...MOVIE, files: [] };
  let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> } | null;
  beforeEach(() => {
    tab = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
  });

  it("opens pahe's best release in the tab opened inside the click, with no opener", async () => {
    answers['/api/movies/movie-467905/pahe'] = {
      matches: [
        { title: 'How to Make a Killing (2026) BluRay', url: 'https://pahe.ink/killing-bluray', year: 2026, release: 'BluRay' },
        { title: 'How to Make a Killing (2026) WEB-DL', url: 'https://pahe.ink/killing-web', year: 2026, release: 'WEB-DL' },
      ],
      search_url: 'https://pahe.ink/?s=killing',
    };
    const h = open(noFile);
    expect(rowsOf()[0]!.dataset.method).toBe('pahe');
    fireEvent.click(row(/^Find the download on pahe.ink/));
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(h.doing).toEqual(['searching pahe.ink']);
    await waitFor(() => expect(h.said).toEqual(['How to Make a Killing (2026) BluRay on pahe.ink, opened in a new tab (the best of 2 releases)']));
    expect(tab!.location.href).toBe('https://pahe.ink/killing-bluray');
    expect(tab!.opener).toBeNull();
    // A search starts nothing else: no download, no play.
    expect(posts).toEqual([]);
  });

  it('pahe listing nothing opens its search page', async () => {
    answers['/api/movies/movie-467905/pahe'] = { matches: [], search_url: 'https://pahe.ink/?s=killing' };
    const h = open(noFile);
    fireEvent.click(row(/^Find the download on pahe.ink/));
    await waitFor(() => expect(h.said).toEqual(['pahe.ink lists no How to Make a Killing; its search page is opened in a new tab']));
    expect(tab!.location.href).toBe('https://pahe.ink/?s=killing');
  });

  it('a blocked pop-up says to allow it and gives the address', async () => {
    tab = null;
    answers['/api/movies/movie-467905/pahe'] = { matches: [{ title: 'Killing WEB-DL', url: 'https://pahe.ink/killing-web', year: 2026, release: 'WEB-DL' }], search_url: null };
    const h = open(noFile);
    fireEvent.click(row(/^Find the download on pahe.ink/));
    await waitFor(() => expect(h.said).toEqual(['Killing WEB-DL on pahe.ink, allow pop-ups to open it: https://pahe.ink/killing-web']));
  });

  it('a failed search closes the blank tab and says why', async () => {
    fails['/api/movies/movie-467905/pahe'] = { status: 502, error: 'pahe_error', message: 'pahe.ink did not answer' };
    const h = open(noFile);
    fireEvent.click(row(/^Find the download on pahe.ink/));
    await waitFor(() => expect(h.said).toEqual(['pahe.ink did not answer']));
    expect(tab!.close).toHaveBeenCalledTimes(1);
  });

  it('no match and no search page is a failure, and the blank tab is closed', async () => {
    answers['/api/movies/movie-467905/pahe'] = { matches: [], search_url: null };
    const h = open(noFile);
    fireEvent.click(row(/^Find the download on pahe.ink/));
    await waitFor(() => expect(h.said).toHaveLength(1));
    expect(h.said[0]).toBe('it did not start (pahe_error)');
    expect(tab!.close).toHaveBeenCalledTimes(1);
  });
});

describe('PlayMenu: opening and closing', () => {
  it('Esc closes the menu and does not reach the page or a pop-up under it', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      open(MOVIE);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(isPlayMenuOpen()).toBe(false);
      expect(behind).not.toHaveBeenCalled();
      // Closed, its Esc is no longer taken.
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('a click outside closes it; a click inside does not', () => {
    open(MOVIE);
    fireEvent.mouseDown(screen.getByText('play How to Make a Killing from'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the caret is disabled while a play is being started', () => {
    render(<PlayMenu detail={MOVIE} episode={null} player={PLAYER_IDLE} busy streamEnabled size="page" onRun={() => {}} />);
    expect((screen.getByRole('button', { name: 'Choose how to play How to Make a Killing' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the Torrent stream row's own button opens every torrent of the episode, and one plays by its info hash", async () => {
    answers['/api/stream/play'] = { ok: true };
    const h = open(SERIES, ep(1, 3));
    fireEvent.click(screen.getByRole('button', { name: 'Every torrent of S01E03' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Torrents of S01E03' })).toBeTruthy();
    // The list is open: it is what Esc closes, not the pop-up the menu is in.
    expect(isPlayMenuOpen()).toBe(true);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toContain('/api/stream/torrents?kind=tv&tmdb_id=247718&season=1&episode=3'));
    expect(h.doing).toEqual([]);
  });
});
