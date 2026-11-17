import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AHEAD_AFTER_WATCHED_MS,
  AHEAD_RETRY_MS,
  AHEAD_TORRENT_MAX_MS,
  AHEAD_TORRENT_POLL_MS,
  EpisodeAhead,
  type AheadSession,
} from '../../../src/directStream/ahead.js';
import type { StreamRef } from '../../../src/directStream/types.js';

const E788: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 788 };
const E789: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 789 };
const cloudSession: AheadSession = { id: 'S1', ref: E788, via: 'cloud' };
const torrentSession: AheadSession = { id: 'T1', ref: E788, via: 'torrent' };
const PLAYING = { paused: false, over: false };

interface Fakes {
  next?: StreamRef | null;
  onDisk?: boolean;
  cloud?: boolean;
  torrent?: boolean;
  torrentHas?: boolean;
  noTorrent?: boolean;
  cloudStarted?: boolean;
}

function setup(o: Fakes = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const logged: string[] = [];
  const state = { onDisk: o.onDisk ?? false, torrentReady: false };
  const ahead = new EpisodeAhead({
    next: async () => (o.next === undefined ? E789 : o.next),
    onDisk: async () => state.onDisk,
    cloud: () =>
      o.cloud === false
        ? null
        : {
            start: async (ref, options) => {
              calls.push(`cache S${ref.kind === 'tv' ? ref.season : 0}E${ref.kind === 'tv' ? ref.episode : 0}${options.gentle ? ' gentle' : ''}`);
              return { started: o.cloudStarted ?? true, state: 'downloading' };
            },
            pause: async () => {
              calls.push('pause');
              return true;
            },
          },
    torrent: () =>
      o.torrent === false
        ? null
        : {
            has: async () => o.torrentHas ?? false,
            fetch: async () => {
              calls.push('fetch');
              return o.noTorrent === true ? null : { name: 'One.Piece.789.1080p', ready: async () => state.torrentReady, release: () => void calls.push('release') };
            },
          },
    now: () => now,
    log: (line) => void logged.push(line),
  });
  /** `seconds` of playing, reported every 5 s. */
  const watch = async (session: AheadSession, seconds: number, report = PLAYING): Promise<void> => {
    for (let s = 0; s < seconds; s += 5) {
      now += 5_000;
      ahead.watched(session, report);
    }
    await flush();
  };
  const tick = (ms: number): void => {
    now += ms;
  };
  return { ahead, calls, logged, watch, tick, state };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

describe('the next episode, fetched ahead', () => {
  it('caches the next episode once this one was watched for two minutes, and only once', async () => {
    const t = setup({ onDisk: true });
    t.ahead.watched(cloudSession, PLAYING);
    await t.watch(cloudSession, AHEAD_AFTER_WATCHED_MS / 1000 - 5);
    expect(t.calls).toEqual([]);
    await t.watch(cloudSession, 5);
    expect(t.calls).toEqual(['cache S18E789']);
    expect(t.logged).toEqual(['[notesd] stream ahead: caching TMDB tv 37854 S18E789 while TMDB tv 37854 S18E788 plays']);
    await t.watch(cloudSession, 600);
    expect(t.calls).toEqual(['cache S18E789']);
  });

  it('counts only playing time: a pause, a gap between reports and a film start nothing', async () => {
    const t = setup();
    t.ahead.watched(cloudSession, PLAYING);
    await t.watch(cloudSession, 600, { paused: true, over: false });
    // The laptop slept: the next report is an hour later.
    t.tick(3_600_000);
    await t.watch(cloudSession, 60);
    expect(t.calls).toEqual([]);
    const film: AheadSession = { id: 'F1', ref: { kind: 'movie', tmdbId: 550 }, via: 'cloud' };
    t.ahead.watched(film, PLAYING);
    await t.watch(film, 600);
    expect(t.calls).toEqual([]);
    await t.watch(cloudSession, 70);
    expect(t.calls).toEqual(['cache S18E789 gentle']);
  });

  it('fetches one file at a time while the episode on screen still streams, and stops when it stalls', async () => {
    const t = setup({ onDisk: false });
    t.ahead.watched(cloudSession, PLAYING);
    await t.watch(cloudSession, 120);
    expect(t.calls).toEqual(['cache S18E789 gentle']);
    expect(t.logged[0]).toContain('one file at a time');
    t.ahead.stalled('S1');
    await flush();
    expect(t.calls).toEqual(['cache S18E789 gentle', 'pause']);
    expect(t.logged[1]).toBe('[notesd] stream ahead: stopped fetching TMDB tv 37854 S18E789: TMDB tv 37854 S18E788 keeps stalling, and it comes first');
    await t.watch(cloudSession, 600);
    expect(t.calls).toHaveLength(2);
  });

  it('starts nothing without a next episode, without a cache, or for a cache that is already there', async () => {
    for (const fakes of [{ next: null }, { cloud: false }] as Fakes[]) {
      const t = setup(fakes);
      t.ahead.watched(cloudSession, PLAYING);
      await t.watch(cloudSession, 300);
      expect(t.calls).toEqual([]);
    }
    const there = setup({ cloudStarted: false });
    there.ahead.watched(cloudSession, PLAYING);
    await there.watch(cloudSession, 300);
    expect(there.calls).toEqual(['cache S18E789 gentle']);
    expect(there.logged).toEqual([]);
    // Nothing was started for this session, so a stall stops nothing.
    there.ahead.stalled('S1');
    await flush();
    expect(there.calls).toHaveLength(1);
  });

  it('a torrent play waits until its own file is whole, then fetches the next from a torrent and lets it go once on disk', async () => {
    vi.useFakeTimers();
    const t = setup({ onDisk: false });
    t.ahead.watched(torrentSession, PLAYING);
    await t.watch(torrentSession, 120);
    expect(t.calls).toEqual([]);
    // Asked again half a minute later, not at every report.
    await t.watch(torrentSession, AHEAD_RETRY_MS / 1000 - 5);
    expect(t.calls).toEqual([]);
    t.state.onDisk = true;
    await t.watch(torrentSession, 10);
    expect(t.calls).toEqual(['fetch']);
    expect(t.logged).toEqual(['[notesd] stream ahead: fetching TMDB tv 37854 S18E789 from the torrent One.Piece.789.1080p while TMDB tv 37854 S18E788 plays']);
    await vi.advanceTimersByTimeAsync(AHEAD_TORRENT_POLL_MS);
    expect(t.calls).toEqual(['fetch']);
    t.state.torrentReady = true;
    await vi.advanceTimersByTimeAsync(AHEAD_TORRENT_POLL_MS);
    expect(t.calls).toEqual(['fetch', 'release']);
    expect(t.logged[1]).toBe('[notesd] stream ahead: TMDB tv 37854 S18E789 is on disk (One.Piece.789.1080p)');
    await vi.advanceTimersByTimeAsync(AHEAD_TORRENT_POLL_MS * 4);
    expect(t.calls).toEqual(['fetch', 'release']);
  });

  it('lets a torrent go that is not whole after three hours, and when the daemon stops', async () => {
    vi.useFakeTimers();
    const t = setup({ onDisk: true });
    t.ahead.watched(torrentSession, PLAYING);
    await t.watch(torrentSession, 120);
    t.tick(AHEAD_TORRENT_MAX_MS);
    await vi.advanceTimersByTimeAsync(AHEAD_TORRENT_POLL_MS);
    expect(t.calls).toEqual(['fetch', 'release']);
    expect(t.logged[1]).toContain('is not whole after 3 h');

    const stopped = setup({ onDisk: true });
    stopped.ahead.watched(torrentSession, PLAYING);
    await stopped.watch(torrentSession, 120);
    stopped.ahead.close();
    expect(stopped.calls).toEqual(['fetch', 'release']);
  });

  it('a torrent play fetches nothing with torrents off, with the next episode on disk, or when no torrent opens', async () => {
    for (const fakes of [{ torrent: false }, { torrentHas: true }] as Fakes[]) {
      const t = setup({ onDisk: true, ...fakes });
      t.ahead.watched(torrentSession, PLAYING);
      await t.watch(torrentSession, 300);
      expect(t.calls).toEqual([]);
    }
    const none = setup({ onDisk: true, noTorrent: true });
    none.ahead.watched(torrentSession, PLAYING);
    await none.watch(torrentSession, 300);
    expect(none.calls).toEqual(['fetch']);
    expect(none.logged).toEqual(['[notesd] stream ahead: no torrent of TMDB tv 37854 S18E789 could be opened; it is found when it is played']);
  });

  it('forgets a session that ended, and goes on with what it started', async () => {
    const t = setup({ onDisk: true });
    t.ahead.watched(cloudSession, PLAYING);
    await t.watch(cloudSession, 120);
    t.ahead.watched(cloudSession, { paused: false, over: true });
    t.ahead.stalled('S1');
    await flush();
    expect(t.calls).toEqual(['cache S18E789']);
  });
});
