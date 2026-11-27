// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PlayerState, TitleDetail } from '../../moviesApi';
import { MOVIES_OFF_TEXT } from '../../lib/movies';
import { FIGHT_CLUB, MOVIE, PLAYER_IDLE, PLAYING, SERIES } from '../../testing/movieFixtures';
import { MovieModal } from './MovieModal';

/** The movie pop-up a movie id in chat opens (docs/guide/movies.md, "Movie ids"): what it names, with Play. */

let calls: { method: string; url: string; body: unknown }[];
let byId: Record<string, TitleDetail | { status: number; error: string }>;
let player: PlayerState;
let streamFails: string | null;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** A fake EventSource the test can fire `changed` on: the pop-up re-reads on it. */
class FakeEvents {
  static last: FakeEvents | null = null;
  readonly listeners = new Map<string, () => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEvents.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  fire(type: string) {
    this.listeners.get(type)?.();
  }
}

beforeEach(() => {
  calls = [];
  player = PLAYER_IDLE;
  streamFails = null;
  byId = { 'M-23T4': MOVIE, 'M-8TR4': SERIES, 'M-0S12': SERIES, 'M-0S13': SERIES, 'M-0S11': SERIES, 'M-FC55': FIGHT_CLUB };
  FakeEvents.last = null;
  vi.stubGlobal('EventSource', FakeEvents);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (url === '/api/movies/player') return json(player);
      if (method === 'POST' && url === '/api/stream/play') return streamFails === null ? json({ ok: true }) : json({ error: streamFails }, 404);
      if (method === 'POST') return json({}, 202);
      const d = byId[decodeURIComponent(url.replace('/api/movies/', ''))];
      if (d === undefined) return json({ error: 'not_found' }, 404);
      if ('error' in d) return json({ error: d.error }, d.status);
      return json(d);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(movieId: string) {
  const onClose = vi.fn();
  const onOpenPage = vi.fn();
  render(<MovieModal movieId={movieId} onClose={onClose} onOpenPage={onOpenPage} />);
  return { onClose, onOpenPage, d: within(screen.getByRole('dialog', { name: `Movie ${movieId}` })) };
}

const playButton = (d: ReturnType<typeof show>['d']) => d.getAllByRole('button').find((b) => b.classList.contains('mv-play')) as HTMLButtonElement;
const factsOf = (d: ReturnType<typeof show>['d']) => [...d.getByRole('heading', { level: 2 }).parentElement!.querySelectorAll('.mv-facts > span')].map((s) => s.textContent);
const posts = () => calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]);

describe('MovieModal: what the id names', () => {
  it('a film: its name and year, facts, state, synopsis, and Play resumes its file in VLC', async () => {
    const { d } = show('M-23T4');
    expect(d.getByText('loading')).toBeTruthy();
    expect(d.getByTestId('movie-modal-id').textContent).toBe('M-23T4');
    expect((await d.findByRole('heading', { level: 2 })).textContent).toBe('How to Make a Killing (2026)');
    expect(factsOf(d)).toEqual(['Released Feb 20, 2026', '1h 52m', 'Comedy, Crime', 'film · in progress']);
    expect(d.getByText('A disinherited heir plots his way back into the family fortune.')).toBeTruthy();
    expect(playButton(d).getAttribute('aria-label')).toBe('Resume at 45:00');
    // With nothing started, the line beside Play says what it does.
    expect(d.getByRole('status').textContent).toBe('Resume at 45:00');
    fireEvent.click(playButton(d));
    await waitFor(() => expect(d.getByRole('status').textContent).toBe('resuming at 45:00'));
    expect(posts()).toEqual([['/api/movies/files/11/play', {}]]);
  });

  it("an episode's id shows that episode under its series, and Play plays that episode's file", async () => {
    const { d, onOpenPage } = show('M-0S12');
    expect((await d.findByRole('heading', { level: 2 })).textContent).toBe('Episode Two');
    expect(d.getByText('MobLand (2025)')).toBeTruthy();
    expect(factsOf(d)).toEqual(['S01E02', '50m', 'episode · in progress']);
    expect(playButton(d).getAttribute('aria-label')).toBe('Resume S01E02 at 20:00');
    fireEvent.click(playButton(d));
    await waitFor(() => expect(posts()).toEqual([['/api/movies/files/22/play', {}]]));
    fireEvent.click(d.getByRole('button', { name: 'Open the page at S01E02' }));
    expect(onOpenPage).toHaveBeenCalledWith('M-0S12');
  });

  it("a series' own id continues it, as the title's Play does", async () => {
    const { d } = show('M-8TR4');
    expect((await d.findByRole('heading', { level: 2 })).textContent).toBe('MobLand (2025)');
    expect(factsOf(d)).toEqual(['Released Mar 30, 2025', '2 seasons', 'series · in progress']);
    expect(playButton(d).getAttribute('aria-label')).toBe('Continue: resume the open episode or play the next one');
    fireEvent.click(playButton(d));
    await waitFor(() => expect(posts()).toEqual([['/api/movies/continue', { title: 'tv-247718' }]]));
    expect(d.getByRole('button', { name: 'Open the movie page' })).toBeTruthy();
  });

  it('an episode whose file is on the other machine streams that episode instead (not_on_this_machine)', async () => {
    const { d } = show('M-0S13');
    await d.findByRole('heading', { level: 2, name: 'Episode Three' });
    expect(playButton(d).getAttribute('aria-label')).toBe('Stream S01E03: checked when it starts');
    expect(playButton(d).disabled).toBe(false);
    fireEvent.click(playButton(d));
    await waitFor(() => expect(d.getByRole('status').textContent).toBe('opening in the streaming Chrome'));
    expect(posts()).toEqual([['/api/stream/play', { kind: 'tv', tmdb_id: 247718, season: 1, episode: 3 }]]);
  });

  it('an episode whose file was deleted streams too', async () => {
    const { d } = show('M-0S11');
    await d.findByRole('heading', { level: 2, name: 'Stick or Twist' });
    expect(playButton(d).getAttribute('aria-label')).toBe('Stream S01E01: checked when it starts');
  });

  it('a film with no file anywhere streams from its verified source; a source that answers nothing says it leaves the Stream grid', async () => {
    streamFails = 'no_source';
    const { d } = show('M-FC55');
    await d.findByRole('heading', { level: 2, name: 'Fight Club (1999)' });
    expect(playButton(d).getAttribute('aria-label')).toBe('Stream (VidFast · 2160p · English subtitle)');
    fireEvent.click(playButton(d));
    await waitFor(() => expect(d.getByRole('status').textContent).toBe('no provider could stream Fight Club now; it leaves the Stream grid'));
    expect(posts()).toEqual([['/api/stream/play', { kind: 'movie', tmdb_id: 550 }]]);
  });

  it('a VLC that cannot start here disables Play with the reason', async () => {
    player = { available: false, reason: 'no vlc.exe', current: null };
    const { d } = show('M-23T4');
    await d.findByRole('heading', { level: 2 });
    await waitFor(() => expect(playButton(d).getAttribute('aria-label')).toBe('VLC is not available on this machine'));
    expect(playButton(d).disabled).toBe(true);
  });

  it('an unknown id says no film or episode has it; movies off says so', async () => {
    const { d } = show('M-ZZZZ');
    expect(await d.findByText('No film or episode has the id M-ZZZZ.')).toBeTruthy();
    expect((d.getByRole('button', { name: 'Open the movie page' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    byId['M-23T4'] = { status: 503, error: 'movies_off' };
    const off = show('M-23T4');
    expect(await off.d.findByText(MOVIES_OFF_TEXT)).toBeTruthy();
  });
});

describe('MovieModal: following the play', () => {
  it("while VLC has the film open the poster is framed and badged, and the line beside Play gives its position", async () => {
    player = PLAYING;
    const { d } = show('M-23T4');
    await d.findByRole('heading', { level: 2 });
    await waitFor(() => expect(d.getByRole('status').textContent).toBe('playing in VLC · 45:10 / 1:52:00'));
    expect(document.querySelector('.mm-art')?.className).toBe('mm-art now playing');
    expect(document.querySelector('.mm-art .mv-badge')?.textContent).toBe('playing');
  });

  it("a series' pop-up names the episode VLC has open; another episode's pop-up does not follow it", async () => {
    player = { ...PLAYING, current: { ...PLAYING.current!, file_id: 22, title_id: 'tv-247718', position: 1300, duration: 3000 } };
    const series = show('M-8TR4');
    await waitFor(() => expect(series.d.getByRole('status').textContent).toBe('S01E02 · playing in VLC · 21:40 / 50:00'));
    cleanup();
    const other = show('M-0S13');
    await other.d.findByRole('heading', { level: 2, name: 'Episode Three' });
    expect(other.d.getByRole('status').textContent).toBe('Stream S01E03: checked when it starts');
    expect(document.querySelector('.mm-art')?.className).toBe('mm-art');
  });

  it('a stream on screen in the player page is followed the same way, for its own episode only', async () => {
    player = { ...PLAYER_IDLE, stream: { session_id: 's', title_id: 'tv-247718', season: 1, episode: 3, provider: 'VidFast', state: 'paused', position: 600, duration: 3000, last_report_at: '2026-11-27T00:00:00.000Z' } };
    const ep3 = show('M-0S13');
    await waitFor(() => expect(ep3.d.getByRole('status').textContent).toBe('paused in the stream player · 10:00 / 50:00'));
    cleanup();
    const ep2 = show('M-0S12');
    await ep2.d.findByRole('heading', { level: 2, name: 'Episode Two' });
    expect(ep2.d.getByRole('status').textContent).toBe('Resume S01E02 at 20:00');
    cleanup();
    const series = show('M-8TR4');
    await waitFor(() => expect(series.d.getByRole('status').textContent).toBe('S01E03 · paused in the stream player · 10:00 / 50:00'));
  });

  it('re-reads on a change event, and a failed re-read keeps what is shown', async () => {
    const { d } = show('M-23T4');
    await d.findByRole('heading', { level: 2, name: 'How to Make a Killing (2026)' });
    expect(FakeEvents.last?.url).toBe('/api/movies/events');
    byId['M-23T4'] = { ...MOVIE, title: 'Renamed' };
    act(() => FakeEvents.last!.fire('changed'));
    await d.findByRole('heading', { level: 2, name: 'Renamed (2026)' });
    byId['M-23T4'] = { status: 500, error: 'internal' };
    act(() => FakeEvents.last!.fire('changed'));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/movies/M-23T4')).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(d.getByRole('heading', { level: 2 }).textContent).toBe('Renamed (2026)');
  });
});

describe('MovieModal: closing', () => {
  it('Esc, the X and a click outside close it; a click inside does not', async () => {
    const { d, onClose } = show('M-23T4');
    await d.findByRole('heading', { level: 2 });
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(d.getByRole('button', { name: 'Close' }));
    fireEvent.click(document.querySelector('[data-modal="movie"]')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('with its play menu open, Esc closes the menu first', async () => {
    const { d, onClose } = show('M-23T4');
    await d.findByRole('heading', { level: 2 });
    fireEvent.click(d.getByRole('button', { name: 'Choose how to play How to Make a Killing' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes its event stream when it closes', async () => {
    const { d } = show('M-23T4');
    await d.findByRole('heading', { level: 2 });
    const es = FakeEvents.last!;
    cleanup();
    expect(es.closed).toBe(true);
  });
});
