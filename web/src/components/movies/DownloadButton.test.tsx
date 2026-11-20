// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DownloadView, TorrentCandidateView } from '../../moviesApi';
import { downloadId, makeDownload } from '../../testing/downloadFixtures';
import { MOVIE, SERIES } from '../../testing/movieFixtures';
import { DownloadButton, type DownloadButtonProps } from './DownloadButton';

const HASH = 'b'.repeat(40);
const CANDIDATE: TorrentCandidateView = {
  info_hash: HASH,
  name: 'How.to.Make.a.Killing.2026.1080p.WEB.h264-ETHEL',
  height: 1080,
  size_bytes: 1_500_000_000,
  seeds: 40,
  scrape: { seeders: 12, leechers: 3 },
  from: ['torrentio'],
  audio: { languages: ['en'], how: 'tags', heard_probability: null },
  worked: false,
  failed: null,
  blacklisted: null,
  dub_group: null,
  heard_dub: false,
  dub_named: false,
  left_out: null,
  remembered: false,
  on_disk: false,
};

let calls: Array<{ url: string; method: string; body: unknown }>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (url.startsWith('/api/stream/torrents?')) return json({ original_language: 'en', listed_at: '2026-11-20T08:00:00Z', cached: true, candidates: [CANDIDATE] });
      if (method === 'POST' && url === '/api/stream/downloads') return json({ ok: true, created: 1, whole: 0, not_aired: 0, downloads: [makeDownload({ state: 'queued', progress: 0, source: null })] }, 202);
      if (method === 'DELETE' && url.startsWith('/api/stream/downloads/')) return json({ ok: true });
      return new Response('not found', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function props(over: Partial<DownloadButtonProps> = {}): DownloadButtonProps {
  return { detail: MOVIE, scope: { kind: 'movie' }, rows: [], size: 'page', onNotice: vi.fn(), onChanged: vi.fn(), ...over };
}
const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/stream/downloads').map((c) => c.body);
const labels = (menu: HTMLElement) => [...menu.querySelectorAll('.mv-menu-label')].map((n) => n.textContent);

describe('DownloadButton: a film on its title page', () => {
  it('queues the film with no source named on a click, and says so', async () => {
    const p = props();
    render(<DownloadButton {...p} />);
    const button = screen.getByRole('button', { name: 'Download How to Make a Killing' });
    expect(button.getAttribute('data-tip')).toBe('Download How to Make a Killing to this machine: a 1080p torrent, else a cloud provider');
    fireEvent.click(button);
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([{ kind: 'movie', tmdb_id: 467905, via: 'auto' }]);
    expect(p.onNotice).toHaveBeenCalledWith('How to Make a Killing: download queued');
  });

  it('opens "Choose how to download <name>" with three choices, and each sends only its own source', async () => {
    const p = props();
    render(<DownloadButton {...p} />);
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Choose how to download How to Make a Killing' }));
    openMenu();
    const menu = screen.getByRole('menu', { name: 'Choose how to download How to Make a Killing' });
    expect(menu.querySelector('.mv-menu-head')?.textContent).toBe('Choose how to download How to Make a Killing');
    expect(labels(menu)).toEqual(['Best torrent (1080p)', 'Cloud', 'Pick a torrent…']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Best torrent/ }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('menu')).toBeNull();

    openMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Cloud/ }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(2));

    openMenu();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Pick a torrent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Torrents of How to Make a Killing' });
    await waitFor(() => expect(dialog.querySelectorAll('.mt-row')).toHaveLength(1));
    expect(calls.some((c) => c.url === '/api/stream/torrents?kind=movie&tmdb_id=467905')).toBe(true);
    expect(within(dialog).queryByRole('button', { name: /^Play / })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: `Download ${CANDIDATE.name}` }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(posts()).toEqual([
      { kind: 'movie', tmdb_id: 467905, via: 'torrent' },
      { kind: 'movie', tmdb_id: 467905, via: 'cloud' },
      { kind: 'movie', tmdb_id: 467905, via: 'torrent', info_hash: HASH },
    ]);
  });

  it('closes the menu on Esc and on a click outside, sending nothing', () => {
    render(<DownloadButton {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download How to Make a Killing' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download How to Make a Killing' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe('DownloadButton: a season and an episode', () => {
  it('queues a whole season with no episode named, and its menu has no pick row', async () => {
    const p = props({ detail: SERIES, scope: { kind: 'season', season: 1 }, size: 'season' });
    render(<DownloadButton {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download MobLand season 1' }));
    expect(labels(screen.getByRole('menu', { name: 'Choose how to download MobLand season 1' }))).toEqual(['Best torrent (1080p)', 'Cloud']);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Download MobLand season 1' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([{ kind: 'tv', tmdb_id: 247718, season: 1, via: 'auto' }]);
  });

  it('still queues the season when one of its episodes already downloads; a film that downloads is not asked again', async () => {
    const running = makeDownload({ title_id: SERIES.id, kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode: 2, state: 'running', progress: 0.3 });
    const p = props({ detail: SERIES, scope: { kind: 'season', season: 1 }, size: 'season', rows: [running] });
    const view = render(<DownloadButton {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download MobLand season 1' }));
    await waitFor(() => expect(posts()).toEqual([{ kind: 'tv', tmdb_id: 247718, season: 1, via: 'auto' }]));
    view.unmount();

    const film = props({ rows: [makeDownload({ state: 'running' })] });
    render(<DownloadButton {...film} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download How to Make a Killing' }));
    expect(film.onChanged).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
  });

  it('queues one episode from its row, and its pick lists that episode', async () => {
    const p = props({ detail: SERIES, scope: { kind: 'episode', season: 1, episode: 3 }, size: 'row' });
    render(<DownloadButton {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download MobLand S01E03' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([{ kind: 'tv', tmdb_id: 247718, season: 1, episode: 3, via: 'auto' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to download MobLand S01E03' }));
    expect(screen.getByRole('menu').className).toBe('mv-menu-list right');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pick a torrent/ }));
    await screen.findByRole('dialog', { name: 'Torrents of MobLand S01E03' });
    expect(calls.some((c) => c.url === '/api/stream/torrents?kind=tv&tmdb_id=247718&season=1&episode=3')).toBe(true);
  });
});

describe('DownloadButton: what it shows', () => {
  it('shows a bar and the percentage while downloading, and its X cancels', async () => {
    const p = props({ rows: [makeDownload({ id: downloadId(7), state: 'running', progress: 0.42 })] });
    render(<DownloadButton {...p} />);
    const bar = screen.getByRole('progressbar', { name: 'Download of How to Make a Killing' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByRole('button', { name: 'Download How to Make a Killing' }).getAttribute('data-tip')).toBe('How to Make a Killing: downloading from a torrent, 42%');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the download of How to Make a Killing' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/stream/downloads/7']);
    expect(p.onNotice).toHaveBeenCalledWith('How to Make a Killing: download cancelled');
    expect(posts()).toEqual([]);
  });

  it('shows a queued download as an empty bar with its X', () => {
    render(<DownloadButton {...props({ rows: [makeDownload({ state: 'queued', progress: 0, source: null })] })} />);
    const bar = screen.getByRole('progressbar', { name: 'Download of How to Make a Killing' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.className).toBe('mv-dl-bar queued');
    expect(screen.getByRole('button', { name: 'Download How to Make a Killing' }).getAttribute('data-tip')).toBe('How to Make a Killing: download queued, 0%');
    expect(screen.getByRole('button', { name: 'Cancel the download of How to Make a Killing' })).toBeTruthy();
  });

  it('says a whole download is on this machine, and a failed one why; a click then asks again', async () => {
    const p = props({ rows: [makeDownload({ state: 'done', progress: 1, bytes_total: 1.5 * 1024 ** 3 })] });
    const view = render(<DownloadButton {...p} />);
    const here = screen.getByRole('button', { name: 'Download How to Make a Killing' });
    expect(here.className.split(' ')).toContain('on');
    expect(here.getAttribute('data-tip')).toBe('How to Make a Killing is on this machine (torrent, 1.5 GB)');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull();
    fireEvent.click(here);
    expect(p.onNotice).toHaveBeenCalledWith('How to Make a Killing is already on this machine');
    expect(posts()).toEqual([]);

    view.rerender(<DownloadButton {...p} rows={[makeDownload({ state: 'failed', progress: 0, error: 'no_source' })]} />);
    const failed = screen.getByRole('button', { name: 'Download How to Make a Killing' });
    expect(failed.getAttribute('data-tip')).toBe('How to Make a Killing: the download failed (no torrent and no cloud source could be downloaded). Click to try again');
    fireEvent.click(failed);
    await waitFor(() => expect(posts()).toEqual([{ kind: 'movie', tmdb_id: 467905, via: 'auto' }]));
  });

  it("draws a season's bar as the mean of its episodes' rows", () => {
    const ep = (episode: number, over: Partial<DownloadView> = {}) => makeDownload({ title_id: SERIES.id, kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode, ...over });
    const rows = [ep(1, { state: 'done', progress: 1 }), ep(2, { state: 'running', progress: 0.5 }), ep(3, { state: 'queued', progress: 0, source: null })];
    render(<DownloadButton {...props({ detail: SERIES, scope: { kind: 'season', season: 1 }, size: 'season', rows })} />);
    expect(screen.getByRole('progressbar', { name: 'Download of MobLand season 1' }).getAttribute('aria-valuenow')).toBe('50');
  });
});
