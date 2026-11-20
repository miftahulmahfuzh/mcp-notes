// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TorrentCandidateView } from '../../moviesApi';
import { candidateFacts, candidateTags, isTorrentsModalOpen, TorrentsModal } from './TorrentsModal';

const COLD = '67b07b417f6f8f7d367bbded3cd797a0840724b6';
const row = (over: Partial<TorrentCandidateView>): TorrentCandidateView => ({
  info_hash: 'a'.repeat(40),
  name: 'Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL',
  height: 1080,
  size_bytes: 1_500_000_000,
  seeds: 40,
  scrape: { seeders: 12, leechers: 3 },
  from: ['torrentio', 'knaben'],
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
  ...over,
});
const COLD_ROW = row({ info_hash: COLD, name: 'Eternally.Yours.S01E07.1080p.ColdFilm.mkv', seeds: 90, scrape: null, from: ['magnet'], audio: { languages: ['ru'], how: 'heard', heard_probability: 0.97 }, worked: true, dub_group: 'ColdFilm', heard_dub: true, dub_named: true, remembered: true });
const TARGET = { kind: 'tv' as const, tmdb_id: 313630, season: 1, episode: 7 };

let calls: Array<{ url: string; method: string; body: unknown }>;
let blacklisted: Set<string>;

beforeEach(() => {
  calls = [];
  blacklisted = new Set();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      const hash = /torrents\/([0-9a-f]{40})\/blacklist/.exec(url)?.[1];
      if (hash !== undefined) {
        if (method === 'POST') blacklisted.add(hash);
        else blacklisted.delete(hash);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const candidates = [row({}), { ...COLD_ROW, blacklisted: blacklisted.has(COLD) ? { at: '2026-11-20T08:00:00Z', reason: 'dub group ColdFilm' } : null }];
      return new Response(JSON.stringify({ original_language: 'en', listed_at: '2026-11-20T08:00:00Z', cached: url.includes('fresh=1') ? false : true, candidates }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TorrentsModal', () => {
  it('lists every candidate of the episode with its facts and tags', async () => {
    render(<TorrentsModal target={TARGET} what="Eternally Yours S01E07" onPlay={() => {}} onClose={() => {}} />);
    expect(isTorrentsModalOpen()).toBe(true);
    const dialog = screen.getByRole('dialog', { name: 'Torrents of Eternally Yours S01E07' });
    await waitFor(() => expect(dialog.querySelectorAll('.mt-row')).toHaveLength(2));
    expect(calls[0]?.url).toBe('/api/stream/torrents?kind=tv&tmdb_id=313630&season=1&episode=7');
    const [first, cold] = [...dialog.querySelectorAll('.mt-row')];
    expect(first?.querySelector('.mt-facts')?.textContent).toBe('1080p · 1.5 GB · seeds 40 listed · 12 seeding · torrentio, knaben · audio en (file tags)');
    expect([...(cold?.querySelectorAll('.mt-tag') ?? [])].map((t) => t.textContent)).toEqual(['played last', 'worked', 'heard dub', 'dub group ColdFilm']);
    expect(cold?.querySelector('.mt-facts')?.textContent).toContain('audio ru (heard)');
    expect(dialog.querySelector('.mm-notice')?.textContent).toBe('torrents · Eternally Yours S01E07 · original en · indexes asked earlier');
  });

  it('blacklists a row and takes it off again, asks the indexes anew on refresh, and plays one by its hash', async () => {
    const onPlay = vi.fn();
    render(<TorrentsModal target={TARGET} what="Eternally Yours S01E07" onPlay={onPlay} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Blacklist Eternally.Yours.S01E07.1080p.ColdFilm.mkv' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take Eternally.Yours.S01E07.1080p.ColdFilm.mkv off the blacklist' })).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: `/api/stream/torrents/${COLD}/blacklist`, method: 'POST', body: { reason: 'dub group ColdFilm', name: 'Eternally.Yours.S01E07.1080p.ColdFilm.mkv' } });
    const coldRow = document.querySelector(`[data-hash="${COLD}"]`);
    expect(coldRow?.className).toBe('mt-row out');
    expect((screen.getByRole('button', { name: 'Play Eternally.Yours.S01E07.1080p.ColdFilm.mkv' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Take Eternally.Yours.S01E07.1080p.ColdFilm.mkv off the blacklist' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the indexes again' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('&fresh=1'))).toBe(true));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Play Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Play Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL' }));
    expect(onPlay).toHaveBeenCalledWith('a'.repeat(40), 'Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL');
  });

  it('closes on Esc and on a click outside', async () => {
    const onClose = vi.fn();
    render(<TorrentsModal target={TARGET} what="X" onPlay={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-modal="torrents"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('downloads a row by its hash when opened for a download, and offers no Play there', async () => {
    const onDownload = vi.fn();
    render(<TorrentsModal target={TARGET} what="Eternally Yours S01E07" onDownload={onDownload} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /^Play / })).toBeNull();
    expect((screen.getByRole('button', { name: 'Download Eternally.Yours.S01E07.1080p.ColdFilm.mkv' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Download Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL' }));
    expect(onDownload).toHaveBeenCalledWith('a'.repeat(40), 'Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL');
  });

  it('says other heights, a failure and a left-out release plainly', () => {
    expect(candidateFacts(row({ height: null, size_bytes: null, seeds: null, scrape: null, from: ['played before'], audio: { languages: [], how: 'unknown', heard_probability: null } }))).toEqual(['other', 'played before', 'audio unknown']);
    expect(candidateTags(row({ failed: 'no_stream: the swarm stalled', left_out: 'few_seeds', dub_named: true }))).toEqual([
      { label: 'failed', kind: 'bad', tip: 'no_stream: the swarm stalled' },
      { label: 'dub-named', kind: 'bad', tip: 'tried only after every other release' },
      { label: 'left out: few seeds', kind: 'plain' },
    ]);
  });
});
