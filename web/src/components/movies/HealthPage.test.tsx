// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HealthFigures, StreamHealth } from '../../moviesApi';
import { endedText, failureText, HealthPage } from './HealthPage';

const zero: HealthFigures = { asks: 0, failed: 0, no_picture: 0, played: 0, success_rate: null, median_resolve_ms: null, median_first_frame_ms: null, played_hours: 0, stalls_per_hour: null, stalled_share: null, hd_share: null };
const AT = new Date(Date.now() - 30 * 60_000).toISOString();

function seeded(days: number): StreamHealth {
  return {
    host: 'pc',
    days,
    since: '',
    first_logged_at: AT,
    totals: {
      all: { ...zero, asks: 5, failed: 2, played: 3, success_rate: 0.6, median_first_frame_ms: 3000 },
      cloud: { ...zero, asks: 2, failed: 1, played: 1, success_rate: 0.5, median_first_frame_ms: 2000, hd_share: 1 },
      torrent: { ...zero, asks: 4, failed: 2, played: 2, success_rate: 0.5, median_resolve_ms: 10_000, median_first_frame_ms: 4000, played_hours: 0.52, stalls_per_hour: 3.87, stalled_share: 0.0032, hd_share: 0.5 },
    },
    by_source: [{ channel: 'torrent', source: 'apibay', ...zero, asks: 2, played: 2, success_rate: 1, hd_share: 0.5 }],
    failures: [{ channel: 'torrent', failure: 'no_source', count: 2 }],
    recent: [
      { id: 4, asked_at: AT, title: 'Health Series', movie_id: null, season: 1, episode: 2, channel: null, source: null, outcome: 'failed', failure: 'no_source', height: null, resolve_ms: 30_000, first_frame_ms: null, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, ended: null },
      { id: 2, asked_at: AT, title: 'Health Film B', movie_id: 'M-BBBB', season: null, episode: null, channel: 'torrent', source: 'apibay', outcome: 'played', failure: null, height: 720, resolve_ms: 12_000, first_frame_ms: 5000, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, ended: 'closed' },
      { id: 1, asked_at: AT, title: 'Health Film A', movie_id: 'M-AAAA', season: null, episode: null, channel: 'torrent', source: 'apibay', outcome: 'played', failure: null, height: 1080, resolve_ms: 8000, first_frame_ms: 3000, stalls: 2, stalled_ms: 6000, waits: 0, waited_ms: 0, ended: 'finished' },
    ],
    unhandled: [{ title: 'Health Series', movie_id: 'M-SER2', kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, asks: 2, last_asked_at: AT, cloud_failure: 'no_stream', torrent_failure: 'no_source' }],
  };
}

const empty = (days: number): StreamHealth => ({ host: 'pc', days, since: '', first_logged_at: null, totals: { all: zero, cloud: zero, torrent: zero }, by_source: [], failures: [], recent: [], unhandled: [] });

let urls: string[];
let answer: (days: number) => StreamHealth;
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

beforeEach(() => {
  urls = [];
  answer = seeded;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const days = Number(new URL(url, 'http://x').searchParams.get('days'));
      return new Response(JSON.stringify(answer(days)), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Stream health page', () => {
  it('leads per channel with start success, first frame, stalls and 1080p, then the sources and failures', async () => {
    render(<HealthPage onOpen={() => {}} />);
    const torrents = await screen.findByTestId('hp-channel-Torrents');
    expect(torrents.textContent).toContain('2/4');
    expect(torrents.textContent).toContain('50%');
    expect(torrents.textContent).toContain('4.0 s');
    expect(torrents.textContent).toContain('3.9');
    expect(within(screen.getByRole('list', { name: 'Torrents sources' })).getByText('apibay')).toBeTruthy();
    expect(screen.getByText('no torrent found ×2')).toBeTruthy();
    expect(urls[0]).toBe('/api/stream/health?days=7');
  });

  it('lists what could not be played, with what the cloud and the torrents last answered', async () => {
    const open = vi.fn();
    render(<HealthPage onOpen={open} />);
    const list = await screen.findByRole('list', { name: 'Could not be played' });
    const item = within(list).getAllByRole('listitem')[0]!;
    expect(item.textContent).toContain('Health Series S01E02');
    expect(item.textContent).toContain('no cloud source');
    expect(item.textContent).toContain('no torrent found');
    expect(item.textContent).toContain('2 asks');
    fireEvent.click(within(item).getByRole('button', { name: 'Open Health Series S01E02' }));
    expect(open).toHaveBeenCalledWith('M-SER2');
  });

  it('names each latest play with its source, first frame, stalls and how it ended; a short play is not a failure', async () => {
    render(<HealthPage onOpen={() => {}} />);
    const items = within(await screen.findByRole('list', { name: 'Latest plays' })).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-outcome'))).toEqual(['failed', 'played', 'played']);
    expect(items[1]!.textContent).toContain('Health Film B');
    expect(items[1]!.textContent).toContain('apibay');
    expect(items[1]!.textContent).toContain('5.0 s');
    expect(items[1]!.textContent).toContain('closed');
    expect(items[1]!.textContent).not.toContain('failed');
    expect(items[2]!.textContent).toContain('2 stalls · 6.0 s');
    expect(items[2]!.textContent).toContain('finished');
    expect(items[0]!.textContent).toContain('failed · no source');
  });

  it('says nothing was played in an empty period, and asks again for another period', async () => {
    answer = empty;
    render(<HealthPage onOpen={() => {}} />);
    expect((await screen.findByTestId('hp-nothing')).textContent).toBe('Nothing was played in the last 7 days.');
    expect(screen.queryByRole('list', { name: 'Latest plays' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await settle();
    expect(urls).toContain('/api/stream/health?days=30');
    expect((await screen.findByTestId('hp-nothing')).textContent).toBe('Nothing was played in the last 30 days.');
  });

  it('words outcome words as what was missing', () => {
    expect(failureText('no_source', 'torrent')).toBe('no torrent found');
    expect(failureText('no_stream', 'cloud')).toBe('no cloud source');
    expect(failureText('bot_check', 'cloud')).toBe('bot check');
    expect(failureText('dubbed', 'torrent')).toBe('dub only');
    expect(failureText('resolved', 'cloud')).toBe('found, did not play');
    expect(failureText('skipped_browser_only', 'cloud')).toBe('not tried');
    expect(failureText('cache_language', null)).toBe('cache is a dub');
    // Every word phase 1 can write has its own wording (none falls through to the underscore fallback).
    for (const w of ['no_source', 'resolve_failed', 'open_failed', 'unknown_session', 'no_episode', 'no_subtitle', 'torrent_off', 'bad_info_hash', 'not_on_this_machine', 'cache_failed', 'cache_language', 'error', 'resolved', 'no_stream', 'bot_check', 'dubbed', 'unplayable', 'skipped', 'skipped_browser_only', 'skipped_no_template']) {
      expect(failureText(w, 'cloud')).not.toContain('_');
    }
    expect(failureText('something_new', null)).toBe('something new');
    expect(endedText({ ...seeded(7).recent[1]!, ended: 'replaced' })).toBe('replaced by another play');
  });
});
