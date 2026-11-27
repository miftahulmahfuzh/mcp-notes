// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { NoticeAction } from '../../hooks/useNotice';
import type { CastCredit, CrewCredit, PlayerState, TitleDetail } from '../../moviesApi';
import type { MovieEntity, MoviesSide } from '../../lib/movies';
import { FIGHT_CLUB, makeSource, MOVIE, MOVIE_STREAMABLE, PLAYER_IDLE, SERIES } from '../../testing/movieFixtures';
import { MovieDetail } from './MovieDetail';

/** One title's page (docs/guide/movies.md, "A title's page", "The Stream side"), rendered on its own. */

let calls: { method: string; url: string; body: unknown }[];
/** POST url → the error the fake daemon answers with. */
let fails: Record<string, { status: number; error: string; message?: string }>;
/** POST url → its answer. */
let answers: Record<string, unknown>;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  fails = {};
  answers = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      const f = fails[url];
      if (method === 'POST' && f !== undefined) return json({ error: f.error, message: f.message }, f.status);
      if (url.startsWith('/api/stream/downloads')) return json({ host: 'lenovo', active: false, downloads: [] });
      if (url === '/api/movies/player') return json(PLAYER_IDLE);
      if (method === 'POST') return json(answers[url] ?? {});
      return json({ error: 'not_found' }, 404);
    }),
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  window.localStorage.clear();
});

interface Shown {
  onChanged: ReturnType<typeof vi.fn>;
  notices: { text: string; action?: NoticeAction }[];
  onEntity: ReturnType<typeof vi.fn>;
  a: ReturnType<typeof within>;
}

function show(detail: TitleDetail, opts: { side?: MoviesSide; player?: PlayerState | null; streamEnabled?: boolean; entity?: boolean; asking?: boolean } = {}): Shown {
  const onChanged = vi.fn();
  const notices: Shown['notices'] = [];
  const onEntity = vi.fn();
  render(
    <MovieDetail
      detail={detail}
      player={opts.player === undefined ? PLAYER_IDLE : opts.player}
      side={opts.side ?? 'library'}
      streamEnabled={opts.streamEnabled ?? true}
      onChanged={onChanged}
      onNotice={(text, action) => notices.push({ text, action })}
      onEntity={opts.entity === false ? undefined : (onEntity as (e: MovieEntity) => void)}
      asking={opts.asking}
    />,
  );
  return { onChanged, notices, onEntity, a: within(screen.getByRole('article', { name: detail.title })) };
}

const playButton = () => document.querySelector('.mv-actions .mv-play') as HTMLButtonElement;
const posts = (url?: string) => calls.filter((c) => c.method === 'POST' && (url === undefined || c.url === url)).map((c) => (url === undefined ? [c.url, c.body] : c.body));
const lastNotice = (s: Shown) => s.notices[s.notices.length - 1]?.text;

describe('MovieDetail: Play', () => {
  it('a film with its file here resumes it in VLC and says so', async () => {
    const s = show(MOVIE);
    expect(playButton().getAttribute('aria-label')).toBe('Resume at 45:00');
    fireEvent.click(playButton());
    await waitFor(() => expect(lastNotice(s)).toBe('resuming at 45:00'));
    expect(posts()).toEqual([['/api/movies/files/11/play', {}]]);
    expect(s.onChanged).toHaveBeenCalled();
  });

  it('is disabled with the reason as its label when the only file is on the other machine (not_on_this_machine)', () => {
    show({ ...MOVIE, files: [{ ...MOVIE.files[0]!, host: 'gpd', available: false, unavailable_reason: 'not_on_this_machine' }] });
    expect(playButton().getAttribute('aria-label')).toBe('On gpd: play it on that machine');
    expect(playButton().disabled).toBe(true);
    // The file's row says where it is, and its own play icon is off too.
    const row = screen.getByTestId('movie-file');
    expect(within(row).getByText('on gpd')).toBeTruthy();
    expect((within(row).getByRole('button', { name: 'this file is on gpd' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is disabled when no file is left, and the deleted file is flagged', () => {
    show({ ...MOVIE, files: [{ ...MOVIE.files[0]!, deleted: true, deleted_at: '2026-11-01T10:00:00.000Z', available: false, unavailable_reason: 'deleted' }] });
    expect(playButton().getAttribute('aria-label')).toBe('No file left to play');
    expect(playButton().disabled).toBe(true);
    expect(within(screen.getByTestId('movie-file')).getByText('deleted')).toBeTruthy();
  });

  it('is disabled when VLC cannot be started here', () => {
    show(MOVIE, { player: { available: false, reason: 'no vlc.exe', current: null } });
    expect(playButton().getAttribute('aria-label')).toBe('VLC is not available on this machine');
    expect(playButton().disabled).toBe(true);
  });

  it('a play VLC refuses says why', async () => {
    fails['/api/movies/files/11/play'] = { status: 409, error: 'not_on_this_machine' };
    const s = show(MOVIE);
    fireEvent.click(playButton());
    await waitFor(() => expect(lastNotice(s)).toBe('that file is on another machine'));
  });

  it('a series continues: the daemon picks the episode', async () => {
    answers['/api/movies/continue'] = { action: 'resumed', title: { id: 'tv-247718', title: 'MobLand', kind: 'tv', year: 2025 }, file: { file_id: 22, season: 1, episode: 2, absolute_episode: null, name: null }, position: 1200, play: {} };
    const s = show(SERIES);
    expect(playButton().getAttribute('aria-label')).toBe('Continue: resume the open episode or play the next one');
    fireEvent.click(playButton());
    await waitFor(() => expect(lastNotice(s)).toBe('resuming S01E02 at 20:00'));
    expect(posts()).toEqual([['/api/movies/continue', { title: 'tv-247718' }]]);
  });

  it('a file here and a fresh stream: Play stays VLC, and the second icon streams', async () => {
    const s = show(MOVIE_STREAMABLE);
    expect(playButton().getAttribute('aria-label')).toBe('Resume at 45:00');
    fireEvent.click(s.a.getByRole('button', { name: 'Stream (VidLink · 1080p · English subtitle)' }));
    await waitFor(() => expect(lastNotice(s)).toBe('opening in the streaming Chrome'));
    expect(posts()).toEqual([['/api/stream/play', { kind: 'movie', tmdb_id: 467905 }]]);
  });

  it('the Library side streams a title with no file here only when its source is fresh', () => {
    show(FIGHT_CLUB);
    expect(playButton().getAttribute('aria-label')).toBe('Stream (VidFast · 2160p · English subtitle)');
    cleanup();
    show({ ...FIGHT_CLUB, stream_sources: [] });
    expect(playButton().getAttribute('aria-label')).toBe('No file left to play');
  });

  it('a title last played on a streaming site goes there again, and the notice names the site', async () => {
    answers['/api/stream/play'] = { site: 'Dramacool' };
    const s = show({ ...FIGHT_CLUB, stream_sources: [], played_through: { channel: 'site', provider: 'dramacool', played_at: '2026-11-18T10:00:00.000Z', season: null, episode: null } }, { side: 'stream' });
    expect(playButton().getAttribute('aria-label')).toBe('Stream on Dramacool, where it played last time');
    fireEvent.click(playButton());
    await waitFor(() => expect(lastNotice(s)).toBe('Playing on Dramacool in the streaming Chrome window'));
  });

  it('with direct streaming off a stream Play is disabled and says so', () => {
    show(FIGHT_CLUB, { side: 'stream', streamEnabled: false });
    expect(playButton().getAttribute('aria-label')).toBe('Direct streaming is off on this machine');
    expect(playButton().disabled).toBe(true);
  });

  it('every play button waits while a play is being started', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await hold;
      return json({});
    });
    show(MOVIE_STREAMABLE);
    fireEvent.click(playButton());
    await waitFor(() => expect(playButton().disabled).toBe(true));
    expect((screen.getByRole('button', { name: 'Choose how to play How to Make a Killing' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Stream \(VidLink/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('play-progress').textContent).toBe('opening VLC');
    release();
    await waitFor(() => expect(playButton().disabled).toBe(false));
    expect(screen.queryByTestId('play-progress')).toBeNull();
  });
});

describe('MovieDetail: the stream lines', () => {
  it('the Library side shows no stream line for a title nothing verified; the Stream side says Play checks it', () => {
    show(MOVIE);
    expect(screen.queryByTestId('stream-source')).toBeNull();
    cleanup();
    show({ ...FIGHT_CLUB, stream_sources: [] }, { side: 'stream' });
    expect(screen.getByTestId('stream-source').textContent).toBe('Stream: not verified yet; Play checks it');
  });

  it('a film whose source failed names the day; a series counts its verified episodes', () => {
    show({ ...FIGHT_CLUB, stream_sources: [makeSource(0, 0, { fresh: false, stale_at: '2026-11-20T10:00:00.000Z' })] }, { side: 'stream' });
    expect(screen.getByTestId('stream-source').textContent).toBe('Stream: no source answered on Nov 20, 2026');
    cleanup();
    show({ ...SERIES, stream_sources: [makeSource(1, 2), makeSource(1, 3), makeSource(1, 4, { fresh: false })] });
    expect(screen.getByTestId('stream-source').textContent).toBe('Stream: 2 episodes verified on this machine; any other episode is checked when you play it');
  });

  it('says how the title was last played here', () => {
    show({ ...MOVIE, played_through: { channel: 'cloud', provider: 'VidRock', played_at: '2026-11-18T10:00:00.000Z', season: null, episode: null }, stream_failed: { cloud_at: null, torrent_at: '2026-11-17T10:00:00.000Z' } });
    expect(screen.getByTestId('played-through').textContent).toBe('Previously played through VidRock (Non Torrent) · Nov 18, 2026 · Torrent found nothing on Nov 17, 2026');
    cleanup();
    show({ ...FIGHT_CLUB, state: 'unwatched' });
    expect(screen.getByTestId('played-through').textContent).toBe('Never been played before');
  });
});

describe('MovieDetail: the marks', () => {
  it('the watched flag is set at once and saved; a failed save puts it back and says so', async () => {
    const s = show(MOVIE);
    fireEvent.click(s.a.getByRole('button', { name: 'Mark as watched' }));
    expect(s.a.getByRole('button', { name: 'Watched (click to unmark)' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(posts('/api/movies/movie-467905/user')).toEqual([{ watched: true }]));
    fails['/api/movies/movie-467905/user'] = { status: 503, error: 'movies_off' };
    fireEvent.click(s.a.getByRole('button', { name: 'Watched (click to unmark)' }));
    await waitFor(() => expect(lastNotice(s)).toBe('could not save (movies_off)'));
    expect(s.a.getByRole('button', { name: 'Watched (click to unmark)' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a star saves the rating; a failed save puts the old one back', async () => {
    const s = show({ ...MOVIE, rating: 2 });
    fireEvent.click(s.a.getByRole('button', { name: 'Rate 4 of 5' }));
    expect(s.a.getByRole('group', { name: 'Rating: 4 of 5' })).toBeTruthy();
    await waitFor(() => expect(posts('/api/movies/movie-467905/user')).toEqual([{ rating: 4 }]));
    fails['/api/movies/movie-467905/user'] = { status: 500, error: 'internal' };
    fireEvent.click(s.a.getByRole('button', { name: 'Rate 5 of 5' }));
    await waitFor(() => expect(lastNotice(s)).toBe('could not save the rating (internal)'));
    expect(s.a.getByRole('group', { name: 'Rating: 4 of 5' })).toBeTruthy();
  });

  it('the Library side shows no interested or not-interested icon on a title with neither mark', () => {
    const s = show(MOVIE);
    expect(s.a.queryByRole('button', { name: /^Interested/ })).toBeNull();
    expect(s.a.queryByRole('button', { name: /^Not interested/ })).toBeNull();
  });

  it('on the Library side a title carrying a mark shows its icon lit, and a click clears it', async () => {
    const s = show({ ...MOVIE, interested: true });
    const b = s.a.getByRole('button', { name: 'Interested (click to take it off the list)' });
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(s.a.queryByRole('button', { name: /^Not interested/ })).toBeNull();
    fireEvent.click(b);
    await waitFor(() => expect(lastNotice(s)).toBe('off the interested list'));
    expect(posts('/api/movies/movie-467905/user')).toEqual([{ interested: false }]);
  });

  it("the Stream side's interested icon puts the title on the watch list, with an undo of exactly that", async () => {
    const s = show(FIGHT_CLUB, { side: 'stream' });
    fireEvent.click(s.a.getByRole('button', { name: "Interested: keep it on the Stream side's interested list" }));
    await waitFor(() => expect(lastNotice(s)).toBe("interested: on the Stream side's interested list"));
    const undo = s.notices[s.notices.length - 1]!.action!;
    expect(undo.label).toBe('undo');
    undo.run();
    await waitFor(() => expect(posts('/api/movies/movie-550/user')).toEqual([{ interested: true }, { interested: false }]));
  });

  it('not interested takes the title off the Stream grid, with an undo; a failed save says so', async () => {
    const s = show(FIGHT_CLUB, { side: 'stream' });
    fireEvent.click(s.a.getByRole('button', { name: 'Not interested: take it off the Stream grid' }));
    await waitFor(() => expect(lastNotice(s)).toBe('not interested: off the Stream grid'));
    s.notices[s.notices.length - 1]!.action!.run();
    await waitFor(() => expect(posts('/api/movies/movie-550/user')).toEqual([{ not_interested: true }, { not_interested: false }]));
    fails['/api/movies/movie-550/user'] = { status: 503, error: 'movies_off' };
    fireEvent.click(s.a.getByRole('button', { name: 'Not interested: take it off the Stream grid' }));
    await waitFor(() => expect(lastNotice(s)).toBe('could not save (movies_off)'));
  });

  it("a file's watched icon writes that file's flag", async () => {
    const s = show(MOVIE);
    fireEvent.click(within(screen.getByTestId('movie-file')).getByRole('button', { name: 'Mark this file watched' }));
    await waitFor(() => expect(posts('/api/movies/files/11/watched')).toEqual([{ watched: true }]));
    expect(s.onChanged).toHaveBeenCalled();
  });
});

describe("MovieDetail: a season's marks", () => {
  const seasonButton = () => screen.getByRole('button', { name: 'Mark all of season 1 finished' });

  it('a season with nothing left to mark says so, and offers no undo', async () => {
    answers['/api/movies/tv-247718/episodes/watched'] = { changed: [] };
    const s = show(SERIES);
    fireEvent.click(seasonButton());
    await waitFor(() => expect(lastNotice(s)).toBe('Season 1: nothing left to mark'));
    expect(s.notices[s.notices.length - 1]!.action).toBeUndefined();
    expect(posts('/api/movies/tv-247718/episodes/watched')).toEqual([{ season: 1, watched: true }]);
  });

  it('marking a season counts what it changed, and the undo takes back exactly those episodes', async () => {
    answers['/api/movies/tv-247718/episodes/watched'] = { changed: [{ season: 1, episode: 3 }, { season: 1, episode: 4 }] };
    const s = show(SERIES);
    fireEvent.click(seasonButton());
    await waitFor(() => expect(lastNotice(s)).toBe('Season 1 marked finished (2 episodes)'));
    s.notices[s.notices.length - 1]!.action!.run();
    await waitFor(() => expect(lastNotice(s)).toBe('Season 1: undone'));
    expect(posts('/api/movies/tv-247718/episodes/watched')).toEqual([
      { season: 1, watched: true },
      { episodes: [{ season: 1, episode: 3 }, { season: 1, episode: 4 }], watched: false },
    ]);
  });
});

describe('MovieDetail: names, credits and cast', () => {
  const cast = (n: number): CastCredit[] => Array.from({ length: n }, (_, i) => ({ person_id: 100 + i, name: `Actor ${i}`, profile_url: null, character: i === 0 ? '' : `Role ${i}` }));
  const producers = (n: number): CrewCredit[] => Array.from({ length: n }, (_, i) => ({ person_id: 500 + i, name: `Producer ${i}`, profile_url: null, job: 'Producer' }));

  it('shows the first 18 cast, and an icon for the rest', () => {
    const s = show({ ...MOVIE, cast: cast(20) });
    const list = within(s.a.getByRole('region', { name: 'Cast' }));
    expect(list.getAllByRole('listitem')).toHaveLength(18);
    fireEvent.click(list.getByRole('button', { name: 'Show all 20 cast' }));
    expect(list.getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(list.getByRole('button', { name: 'Show less cast' }));
    expect(list.getAllByRole('listitem')).toHaveLength(18);
  });

  it('a cast member with no character name has no character link', () => {
    const s = show({ ...MOVIE, cast: cast(2) });
    const items = within(s.a.getByRole('region', { name: 'Cast' })).getAllByRole('listitem');
    expect(within(items[0]!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Actor 0']);
    expect(within(items[1]!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Actor 1', 'Role 1']);
  });

  it('producers past eight are counted, not listed', () => {
    const s = show({ ...MOVIE, producers: producers(11) });
    const credits = within(s.a.getByLabelText('Credits'));
    expect(credits.getByText('Produced by').nextElementSibling?.textContent).toMatch(/Producer 7 and 3 more$/);
    expect(credits.queryByRole('button', { name: 'Producer 8' })).toBeNull();
  });

  it('a person, a studio and a genre open their pop-up; a character asks the chat at once', async () => {
    const s = show(MOVIE);
    fireEvent.click(s.a.getByRole('button', { name: 'Crime' }));
    expect(screen.getByRole('dialog', { name: 'About Crime' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(s.a.getByRole('button', { name: 'Blumhouse Productions' }));
    expect(screen.getByRole('dialog', { name: 'About Blumhouse Productions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(s.onEntity).not.toHaveBeenCalled();
    fireEvent.click(s.a.getByRole('button', { name: 'Julia' }));
    expect(s.onEntity).toHaveBeenCalledWith({ kind: 'character', name: 'Julia', actor: 'Mara Example', personId: 4 });
  });

  it('with no chat to ask, a character is plain text', () => {
    const s = show(MOVIE, { entity: false });
    const items = within(s.a.getByRole('region', { name: 'Cast' })).getAllByRole('listitem');
    expect(within(items[1]!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mara Example']);
    expect(items[1]!.textContent).toContain('Julia');
  });

  it('while an answer streams, a character waits; a name still opens its pop-up, without its chat icon', () => {
    const s = show(MOVIE, { asking: true });
    expect((s.a.getByRole('button', { name: 'Julia' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(s.a.getByRole('button', { name: 'Mara Example' }));
    const pop = within(screen.getByRole('dialog', { name: 'About Mara Example' }));
    expect(pop.queryByRole('button', { name: /^Ask the chat/ })).toBeNull();
  });
});

describe('MovieDetail: files and downloads', () => {
  it('the Library side lists a film\'s files even when it has none; the Stream side leaves the empty section out', () => {
    show({ ...FIGHT_CLUB, stream_sources: [] });
    expect(screen.getByRole('region', { name: 'Files' })).toBeTruthy();
    cleanup();
    show(FIGHT_CLUB, { side: 'stream' });
    expect(screen.queryByRole('region', { name: 'Files' })).toBeNull();
  });

  it('a film on the Stream side with streaming on has a download icon; not on the Library side, not with streaming off', async () => {
    show(FIGHT_CLUB, { side: 'stream' });
    expect(screen.getByRole('button', { name: /^Download Fight Club/ })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/stream/downloads?title=movie-550')).toBe(true));
    cleanup();
    calls = [];
    show(FIGHT_CLUB);
    expect(screen.queryByRole('button', { name: /^Download Fight Club/ })).toBeNull();
    cleanup();
    show(FIGHT_CLUB, { side: 'stream', streamEnabled: false });
    expect(screen.queryByRole('button', { name: /^Download Fight Club/ })).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url.startsWith('/api/stream/downloads'))).toBe(false);
  });
});
