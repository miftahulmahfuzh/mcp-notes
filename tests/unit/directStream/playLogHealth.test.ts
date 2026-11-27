import { describe, expect, it } from 'vitest';
import { buildHealth, channelsOf, median, readHealth, type HealthRow, type PlayLogReader, type UnhandledEntry } from '../../../src/directStream/playLog/health.js';
import { ago, NOW, row, SEED, UNHANDLED } from '../../helpers/playLogRows.js';

const build = (rows: HealthRow[], unhandled: UnhandledEntry[] = []) => buildHealth({ host: 'pc', days: 7, since: ago(7 * 1440), rows, firstLoggedAt: rows.length === 0 ? null : ago(20 * 1440), unhandled });

describe('the Health answer', () => {
  it('leads per channel with start success, first frame, stalls and the share at 1080p; a short play is a success', () => {
    const h = build(SEED, UNHANDLED);
    expect(h.totals.all).toMatchObject({ asks: 5, failed: 2, played: 3, no_picture: 0, success_rate: 0.6 });
    expect(h.totals.torrent).toEqual({
      asks: 4,
      failed: 2,
      no_picture: 0,
      played: 2,
      success_rate: 0.5,
      median_resolve_ms: 10_000,
      median_first_frame_ms: 4000,
      played_hours: 0.52,
      stalls_per_hour: 3.87,
      stalled_share: 0.0032,
      hd_share: 0.5,
    });
    expect(h.totals.cloud).toMatchObject({ asks: 2, failed: 1, played: 1, success_rate: 0.5, median_resolve_ms: 20_000, median_first_frame_ms: 2000, hd_share: 1 });
    expect(h.by_source.map((s) => [s.channel, s.source, s.asks, s.played, s.success_rate])).toEqual([
      ['torrent', 'apibay', 2, 2, 1],
      ['cloud', 'VidFast', 1, 1, 1],
    ]);
    expect(h.failures).toEqual([
      { channel: 'torrent', failure: 'no_source', count: 2 },
      { channel: 'cloud', failure: 'no_stream', count: 1 },
    ]);
    // The one-minute play of Film B is a played row, ended closed, never a failure.
    expect(h.recent.find((p) => p.id === 2)).toMatchObject({ outcome: 'played', ended: 'closed', source: 'apibay' });
    expect(h.recent[0]).toMatchObject({ id: 4, title: 'Health Series', season: 1, episode: 2, outcome: 'failed', source: null });
    expect(h.unhandled).toEqual(UNHANDLED);
  });

  it('answers zero counts and null medians with nothing logged', () => {
    const h = build([]);
    for (const c of ['all', 'cloud', 'torrent']) {
      expect(h.totals[c]).toEqual({ asks: 0, failed: 0, no_picture: 0, played: 0, success_rate: null, median_resolve_ms: null, median_first_frame_ms: null, played_hours: 0, stalls_per_hour: null, stalled_share: null, hd_share: null });
    }
    expect(h.by_source).toEqual([]);
    expect(h.failures).toEqual([]);
    expect(h.recent).toEqual([]);
    expect(h.first_logged_at).toBeNull();
  });

  it('counts a failed ask under each channel it asked, and a site play as played', () => {
    expect(channelsOf(row({ outcome: 'failed', cloud_failure: 'bot_check', torrent_failure: 'no_source' }))).toEqual(['cloud', 'torrent']);
    expect(channelsOf(row({ outcome: 'failed', asked: 'provider' }))).toEqual(['cloud']);
    expect(channelsOf(row({ outcome: 'failed' }))).toEqual(['none']);
    const h = build([row({ outcome: 'site', channel: 'site', provider_first: 'idlix' })]);
    expect(h.totals.site).toMatchObject({ asks: 1, played: 1, success_rate: 1 });
  });

  it('takes the middle value', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);
  });

  it('reads the period before now from the reader', async () => {
    const asked: Array<[string, string]> = [];
    const reader: PlayLogReader = {
      healthRows: async (host, since) => {
        asked.push([host, since.toISOString()]);
        return SEED;
      },
      firstAskedAt: async () => ago(20 * 1440),
      unhandled: async (_host, limit) => {
        expect(limit).toBe(200);
        return UNHANDLED;
      },
    };
    const h = await readHealth(reader, 'pc', 7, NOW);
    expect(asked).toEqual([['pc', '2026-11-20T12:00:00.000Z']]);
    expect(h.since).toBe('2026-11-20T12:00:00.000Z');
    expect(h.totals.all!.asks).toBe(5);
  });
});
