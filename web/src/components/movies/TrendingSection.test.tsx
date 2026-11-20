// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrendingListResponse } from '../../moviesApi';
import { TrendingSection } from './TrendingSection';

const list = (over: Partial<Extract<TrendingListResponse, { enabled: true }>> = {}): TrendingListResponse => ({
  enabled: true,
  titles: [],
  listed_at: '2026-11-17T06:30:00Z',
  running: false,
  ...over,
});
const props = { running: false, onOpen: vi.fn(), onMark: vi.fn(), onRefresh: vi.fn(), onPlayTorrent: vi.fn() };

afterEach(cleanup);

describe('TrendingSection', () => {
  it('shows the seeds the index lists and no swarm state', () => {
    const title = { id: 'movie-1', kind: 'movie', title: 'Film', watched: false, not_interested: false, trending: { kind_rank: 1, seeds: 8401, index: 'apibay', release: 'x', size_bytes: null, listed_at: '2026-11-17T06:00:00Z' } };
    render(<TrendingSection {...props} trending={list({ titles: [title as never] })} />);
    expect(screen.getByText('8,401 seeds')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/confirmed/);
  });

  it('says off with its reason', () => {
    render(<TrendingSection {...props} trending={{ enabled: false, reason: 'torrent_off', titles: [], listed_at: null }} />);
    expect(screen.getByText(/needs torrents/)).toBeTruthy();
  });
});
