import { describe, expect, it } from 'vitest';
import type { StreamTorrentRow } from '../../../../../src/db/schema.js';
import { secondsOf } from '../../../../../src/directStream/torrent/streams/files.js';
import { budgetOrder, lastActivity, type BudgetCandidate } from '../../../../../src/directStream/torrent/streams/prune.js';
import { episodeOf, gb, keptHashes, sameRef, slotKey, sumRanges } from '../../../../../src/directStream/torrent/streams/util.js';

const at = (iso: string): Date => new Date(iso);
const row = (over: Partial<StreamTorrentRow>): StreamTorrentRow =>
  ({
    host: 'h',
    infoHash: 'a'.repeat(40),
    kind: 'movie',
    tmdbId: 1,
    season: 0,
    episode: 0,
    name: 'Film',
    release: null,
    trackers: [],
    fileIndex: 0,
    files: [],
    fileLength: null,
    bytesDone: 0,
    durationS: null,
    state: 'ready',
    error: null,
    createdAt: at('2026-01-01T00:00:00Z'),
    updatedAt: at('2026-01-01T00:00:00Z'),
    completedAt: null,
    playedAt: null,
    keptAt: null,
    ...over,
  }) as StreamTorrentRow;

describe('lastActivity: per torrent over all its episodes', () => {
  it('takes the latest play and touch across a pack\'s rows, and the first row\'s name', () => {
    const rows = [
      row({ season: 1, episode: 1, kind: 'tv', name: 'Pack', playedAt: at('2026-02-01T00:00:00Z') }),
      row({ season: 1, episode: 2, kind: 'tv', name: 'Other', completedAt: at('2026-03-01T00:00:00Z') }),
      row({ infoHash: 'b'.repeat(40), name: 'Never' }),
    ];
    const out = lastActivity(rows);
    expect(out.get('a'.repeat(40))).toEqual({ played: at('2026-02-01T00:00:00Z').getTime(), touched: at('2026-03-01T00:00:00Z').getTime(), name: 'Pack' });
    expect(out.get('b'.repeat(40))).toEqual({ played: null, touched: at('2026-01-01T00:00:00Z').getTime(), name: 'Never' });
  });
});

describe('budgetOrder: what the budget deletes first', () => {
  const c = (hash: string, over: Partial<BudgetCandidate>): BudgetCandidate => ({ hash, played: null, touched: 0, name: hash, recent: false, dismissed: false, ...over });

  it('watched or not interested first, then old before recent, then never played (oldest first), then least recently played', () => {
    const order = budgetOrder([
      c('recent-never', { recent: true, touched: 1 }),
      c('played-late', { played: 50, touched: 50 }),
      c('never-new', { touched: 20 }),
      c('played-early', { played: 10, touched: 10 }),
      c('never-old', { touched: 5 }),
      c('dismissed-recent', { dismissed: true, recent: true, played: 99, touched: 99 }),
    ]).map((x) => x.hash);
    expect(order).toEqual(['dismissed-recent', 'never-old', 'never-new', 'played-early', 'played-late', 'recent-never']);
  });

  it('leaves its input alone', () => {
    const input = [c('b', { touched: 2 }), c('a', { touched: 1 })];
    budgetOrder(input);
    expect(input.map((x) => x.hash)).toEqual(['b', 'a']);
  });
});

describe('the map in seconds', () => {
  it('turns byte stretches into seconds, and none when the length or duration is unknown', () => {
    expect(secondsOf([[0, 500], [750, 1000]], 1000, 100)).toEqual([[0, 50], [75, 100]]);
    expect(secondsOf([[0, 1]], 3, 1)).toEqual([[0, 0.3]]);
    expect(secondsOf([[0, 1]], null, 100)).toEqual([]);
    expect(secondsOf([[0, 1]], 0, 100)).toEqual([]);
    expect(secondsOf([[0, 1]], 10, null)).toEqual([]);
  });
});

describe('TorrentStreams helpers', () => {
  it('sameRef: the same film, or the same episode', () => {
    expect(sameRef({ kind: 'movie', tmdbId: 1 }, { kind: 'movie', tmdbId: 1 })).toBe(true);
    expect(sameRef({ kind: 'movie', tmdbId: 1 }, { kind: 'tv', tmdbId: 1, season: 0, episode: 0 })).toBe(false);
    expect(sameRef({ kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, { kind: 'tv', tmdbId: 1, season: 1, episode: 2 })).toBe(true);
    expect(sameRef({ kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, { kind: 'tv', tmdbId: 1, season: 1, episode: 3 })).toBe(false);
  });

  it('episodeOf, slotKey, gb, sumRanges, keptHashes', () => {
    expect(episodeOf({ kind: 'tv', season: 1, episode: 2 })).toBe(' S01E02');
    expect(episodeOf({ kind: 'movie', season: 0, episode: 0 })).toBe('');
    expect(slotKey({ season: 3, episode: 4 })).toBe('3x4');
    expect(gb(1024 ** 3 * 1.5)).toBe('1.5 GB');
    expect(gb(5 * 1_048_576)).toBe('5 MB');
    expect(sumRanges([[0, 10], [20, 25]])).toBe(15);
    expect([...keptHashes([row({ keptAt: at('2026-01-02T00:00:00Z') }), row({ infoHash: 'b'.repeat(40) })])]).toEqual(['a'.repeat(40)]);
  });
});
