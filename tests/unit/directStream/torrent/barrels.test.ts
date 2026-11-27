import { describe, expect, it } from 'vitest';
import * as service from '../../../../src/directStream/torrent/service.js';
import * as source from '../../../../src/directStream/torrent/source.js';

/**
 * source.ts and service.ts were split into source/ and streams/ (2026-11-27); every name they exported is still
 * importable from them, and nothing internal leaked out. A new public name belongs in this list on purpose.
 */
describe('the torrent barrels export what they always did', () => {
  it('source.ts', () => {
    expect(Object.keys(source).sort()).toEqual([
      'FILE_FAILURE_KEEP_MS',
      'HEALTHY_PEERS',
      'HEIGHT_SETTLE_MS',
      'MAX_PACK_TRIES',
      'MAX_TORRENT_TRIES',
      'NO_FILE_LIST',
      'PEERS_ALONE_MAX_FILM_KBPS',
      'PREFERRED_TORRENT_HEIGHT',
      'PROBE_SAMPLE_MS',
      'PROBE_STALL_BYTES',
      'PROBE_STALL_MS',
      'REMUX_STARVED_BYTES',
      'SUBTITLES_PENDING',
      'SUBTITLE_HEAD_MS',
      'SWARM_FAILURE_KEEP_MS',
      'TORRENTS_LEFT',
      'TORRENT_DEADLINE_MS',
      'TORRENT_HEAR_AFTER_S',
      'TORRENT_OPEN_TIMEOUT_MS',
      'TORRENT_PROBE_TIMEOUT_MS',
      'TORRENT_PROVIDER',
      'TORRENT_RACE_WIDTH',
      'TORRENT_SETTLE_MS',
      'TRACKER_PROBE_MS',
      'TorrentSource',
      'buildTorrentSource',
      'chooseOrder',
      'delivers',
      'hearAt',
      'indexesOf',
      'keptFailure',
      'namesCloud',
      'namesTorrent',
      'remuxTimeoutOutcome',
      'torrentLabel',
    ]);
  });

  it('service.ts', () => {
    expect(Object.keys(service).sort()).toEqual(['TORRENT_RECENT_MS', 'TorrentStreams', 'buildTorrentStreams']);
  });

  it('the values did not change in the move', () => {
    expect(source.TORRENT_DEADLINE_MS).toBe(90_000);
    expect(source.TORRENT_RACE_WIDTH).toBe(3);
    expect(source.MAX_TORRENT_TRIES).toBe(6);
    expect(source.NO_FILE_LIST).toBe('no file list from the swarm in time');
    expect(source.torrentLabel('X')).toBe('Torrent: X');
    expect(source.namesTorrent(' Torrent ')).toBe(true);
    expect(source.namesCloud('CLOUD')).toBe(true);
    expect(service.TORRENT_RECENT_MS).toBe(86_400_000);
  });
});
