// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeVideo } from '../testing/streamFakes';
import { fakeHost } from './fakeHost';
import { torrentView } from './playerState';
import { onDisk, scaleRanges, TorrentWait } from './torrentWait';

describe('the map of a torrent on disk', () => {
  it("puts the map on the film's own clock when the daemon counted it against another length", () => {
    expect(scaleRanges([[0, 100], [500, 1000]], 1000, 500)).toEqual([[0, 50], [250, 500]]);
    expect(scaleRanges([[0, 100]], null, 500)).toEqual([[0, 100]]);
    expect(scaleRanges([[0, 100]], 1000, 0)).toEqual([[0, 100]]);
    // Within half a second the lengths agree: the map is used as it came.
    expect(scaleRanges([[0, 100]], 1000, 1000.4)).toEqual([[0, 100]]);
    expect(onDisk([[0, 60]], 59.9)).toBe(true);
    expect(onDisk([[0, 60]], 61)).toBe(false);
    // The half second of slack before a stretch.
    expect(onDisk([[10, 60]], 9.6)).toBe(true);
    expect(onDisk([[10, 60]], 9.4)).toBe(false);
  });
});

describe('TorrentWait.markFetching', () => {
  const info = { infoHash: 'a'.repeat(40), name: 'Film.1080p', index: null, seeds: 9, state: 'downloading' as const };

  function setup(currentTime: number) {
    const { video } = fakeVideo({ currentTime });
    const host = fakeHost(video);
    host.current = { ...host.current, stage: 'ready', torrent: torrentView(info) };
    return { host, wait: new TorrentWait(host) };
  }

  it('waits for a part not on disk, counts the wait once, and ends it when the part arrives', () => {
    const { host, wait } = setup(120);
    host.current = { ...host.current, cachedRanges: [[0, 60]] };
    wait.markFetching(true);
    wait.markFetching(true);
    expect(host.current.torrent?.fetching).toBe(true);
    expect(host.notes).toEqual(['waiting for the torrent at 120 s']);
    expect(host.stats().report().waits).toBe(1);
    wait.arrived();
    expect(host.current.torrent?.fetching).toBe(false);
  });

  it('never waits for a part on disk, a complete torrent, or a session that is not a torrent', () => {
    const { host, wait } = setup(30);
    host.current = { ...host.current, cachedRanges: [[0, 60]] };
    wait.markFetching(true);
    expect(host.current.torrent?.fetching).toBe(false);
    host.current = { ...host.current, cachedRanges: [], torrent: torrentView({ ...info, state: 'ready' }) };
    wait.markFetching(true);
    expect(host.current.torrent?.fetching).toBe(false);
    host.current = { ...host.current, torrent: null };
    wait.markFetching(true);
    expect(host.current.torrent).toBeNull();
    expect(host.notes).toEqual([]);
  });
});
