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
  probe: 200,
  network_blocked: false,
  ...over,
});
const props = { running: false, onOpen: vi.fn(), onMark: vi.fn(), onRefresh: vi.fn(), onPlayTorrent: vi.fn() };

afterEach(cleanup);

describe('TrendingSection', () => {
  it('says the network cannot reach peers when the control torrent found none, instead of judging swarms', () => {
    render(<TrendingSection {...props} trending={list({ network_blocked: true })} />);
    expect(screen.getByRole('status').textContent).toContain('cannot reach torrent peers');
  });

  it('says nothing about the network normally, and says off with its reason', () => {
    const { rerender } = render(<TrendingSection {...props} trending={list()} />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<TrendingSection {...props} trending={{ enabled: false, reason: 'torrent_off', titles: [], listed_at: null }} />);
    expect(screen.getByText(/needs torrents/)).toBeTruthy();
  });
});
