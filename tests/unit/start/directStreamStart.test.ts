import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVIES_CONFIG, type Config } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { StreamCache } from '../../../src/directStream/cache/service.js';
import { StreamEvidence } from '../../../src/directStream/evidence.js';
import type { PlayLog } from '../../../src/directStream/playLog/log.js';
import type { DirectStreamService, SyncSeedResult } from '../../../src/directStream/service.js';
import { movieStreamHooks, startDirectStreaming, type DirectStreamStartIo } from '../../../src/directStream/start.js';
import type { TorrentStreams } from '../../../src/directStream/torrent/service.js';
import type { MoviesService } from '../../../src/movies/service.js';
import { StreamLive } from '../../../src/movies/streamLive.js';
import type { MovieStreams } from '../../../src/movies/streams.js';
import { startConfig, streamConfig } from '../../helpers/startConfig.js';

const db = {} as Db;
const movies = { host: 'pc' } as unknown as MoviesService;
const moviesOn = (c: Config): Config => ({ ...c, movies: { ...DEFAULT_MOVIES_CONFIG, enabled: true } });

function seed(over: Partial<SyncSeedResult> = {}): SyncSeedResult {
  return { total: 12, inserted: 0, updated: 0, removed: [], reset: [], ...over };
}

/** Every builder that would touch the database, a script or the network, faked; `order` records what ran. */
function fakes(o: { seed?: SyncSeedResult | Error; service?: boolean; closed?: number; torrents?: boolean } = {}) {
  const order: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const service = {
    host: 'pc',
    syncSeed: vi.fn(async () => {
      order.push('syncSeed');
      if (o.seed instanceof Error) throw o.seed;
      return o.seed ?? seed();
    }),
    evidenceSource: vi.fn(() => null),
  } as unknown as DirectStreamService;
  const cache = { player: vi.fn(() => null) } as unknown as StreamCache;
  const torrents = { host: 'pc', dropOriginals: vi.fn() } as unknown as TorrentStreams;
  const playLog = {
    closeLeftOpen: vi.fn(async () => {
      order.push('playLog.closeLeftOpen');
      return o.closed ?? 0;
    }),
  } as unknown as PlayLog;
  let serviceWiring: Parameters<NonNullable<DirectStreamStartIo['service']>>[2] | null = null;
  const io = {
    checks: { judge: () => null, canRun: async () => false, log: () => {} },
    subtitles: { sweep: async () => 0, cloudWhisper: async () => null, log: () => {} },
    torrentSubtitles: { whisperTier: async () => null },
    service: vi.fn((_c: Config, _d: Db, w: Parameters<NonNullable<DirectStreamStartIo['service']>>[2]) => {
      order.push('service');
      serviceWiring = w;
      return o.service === false ? null : service;
    }),
    cache: vi.fn((_c: Config, ds: unknown, _r: unknown, _o: { sweepOrphans?: boolean }) => {
      order.push('cache');
      return ds === null ? null : cache;
    }),
    torrents: vi.fn((_c: Config, ds: unknown, _d: Db, _o: { sweepOrphans?: boolean }) => {
      order.push('torrents');
      return ds === null || o.torrents === false ? null : torrents;
    }),
    playLog: vi.fn(() => playLog),
    log: (l: string) => lines.push(l),
    error: (l: string) => errors.push(l),
  } as unknown as DirectStreamStartIo & { service: ReturnType<typeof vi.fn>; cache: ReturnType<typeof vi.fn>; torrents: ReturnType<typeof vi.fn>; playLog: ReturnType<typeof vi.fn> };
  return { io, order, lines, errors, service, cache, torrents, playLog, serviceWiring: () => serviceWiring };
}

describe('startDirectStreaming', () => {
  it('without the library: no play log, no stream on screen, no evidence log', async () => {
    const f = fakes({ service: false });
    const s = await startDirectStreaming({ config: startConfig(), db, movies: null, movieStreams: null, importPending: false, boundPort: () => null }, f.io);
    expect(s).toMatchObject({ playLog: null, streamLive: null, streamEvidence: null, directStream: null, streamCache: null, torrents: null, torrentRemux: null, sharedWhisper: null });
    expect(f.io.playLog).not.toHaveBeenCalled();
    expect(s.trackerLists.lists).toBeNull();
    // The service builder itself says null for a config with direct streaming off; nothing is seeded.
    expect(f.order).toEqual(['service', 'cache', 'torrents']);
  });

  it('with direct streaming on: closes the play log rows of the last run first, then seeds the providers', async () => {
    const f = fakes({ closed: 2, seed: seed({ inserted: 3, updated: 1, removed: ['Old'], reset: ['VidFast'] }) });
    const config = moviesOn(streamConfig());
    const s = await startDirectStreaming({ config, db, movies, movieStreams: null, importPending: false, boundPort: () => 41000 }, f.io);
    expect(f.io.playLog).toHaveBeenCalledWith(db, 'pc');
    expect(s.playLog).toBe(f.playLog);
    expect(s.streamLive).toBeInstanceOf(StreamLive);
    expect(s.streamEvidence).toBeInstanceOf(StreamEvidence);
    expect(s.directStream).toBe(f.service);
    expect(f.order).toEqual(['playLog.closeLeftOpen', 'service', 'syncSeed', 'cache', 'torrents']);
    expect(f.lines).toEqual([
      '[notesd] play log: closed 2 play(s) left open by the previous run (restart)',
      '[notesd] direct stream: on, 12 providers in the seed (3 new, 1 updated, Old removed, VidFast asked again)',
    ]);
  });

  it('a seed that cannot be loaded is one error line, never a failed start', async () => {
    const f = fakes({ seed: new Error('stream_providers is locked') });
    const s = await startDirectStreaming({ config: moviesOn(streamConfig()), db, movies, movieStreams: null, importPending: false, boundPort: () => null }, f.io);
    expect(s.directStream).toBe(f.service);
    expect(f.errors).toEqual(['[notesd] direct stream: could not load the provider seed: stream_providers is locked']);
  });

  it('while the old shared database is still to be merged, no cache or torrent folder is swept', async () => {
    for (const importPending of [true, false]) {
      const f = fakes();
      await startDirectStreaming({ config: moviesOn(streamConfig()), db, movies, movieStreams: null, importPending, boundPort: () => null }, f.io);
      expect(f.io.cache.mock.calls[0]![3]).toEqual({ sweepOrphans: !importPending });
      expect(f.io.torrents.mock.calls[0]![3]).toEqual({ sweepOrphans: !importPending });
    }
  });

  it('the service reads the player page at the bound port, and the stream cache only at play time', async () => {
    const f = fakes();
    let port: number | null = null;
    const s = await startDirectStreaming({ config: moviesOn(streamConfig()), db, movies, movieStreams: null, importPending: false, boundPort: () => port }, f.io);
    const w = f.serviceWiring()!;
    expect(w.pageBase()).toBe('http://localhost:7999');
    port = 41000;
    expect(w.pageBase()).toBe('http://localhost:41000');
    expect(w.caches!()).toBeNull();
    expect(f.cache.player).toHaveBeenCalledTimes(1);
    expect(s.streamCache).toBe(f.cache);
    expect(w.playLog).toBe(f.playLog);
    expect(w.hooks).toBeUndefined();
    // No streaming sites without movieStreams.
    expect(w.siteFallback).toBeNull();
    // The torrent source is not built at boot: torrents are off in this config.
    expect(w.torrent!()).toBeNull();
  });

  it('the evidence log reads the live session back through the service, built after it', async () => {
    const f = fakes();
    const s = await startDirectStreaming({ config: moviesOn(streamConfig()), db, movies, movieStreams: null, importPending: false, boundPort: () => null }, f.io);
    const evidence = s.streamEvidence as unknown as { opts: { source: (id: string) => unknown; onScreen: () => unknown } };
    expect(evidence.opts.source('sid')).toBeNull();
    expect(f.service.evidenceSource).toHaveBeenCalledWith('sid');
    expect(evidence.opts.onScreen()).toBeNull();
  });

  it('with movieStreams, the service records every resolve and reads every title through it, and the sites stand behind', async () => {
    const f = fakes();
    const movieStreams = { recordResolve: vi.fn(), channel: vi.fn(), titleNames: vi.fn() } as unknown as MovieStreams;
    const config: Config = { ...moviesOn(streamConfig()), streaming: { enabled: true } };
    const s = await startDirectStreaming({ config, db, movies, movieStreams, importPending: false, boundPort: () => null }, f.io);
    const w = f.serviceWiring()!;
    expect(w.hooks).toBeDefined();
    expect(s.streaming).not.toBeNull();
    expect(w.siteFallback).not.toBeNull();
    const ref = { kind: 'movie', tmdb_id: 550 } as never;
    w.hooks!.recordResolve!(ref, {} as never);
    expect(movieStreams.recordResolve).toHaveBeenCalledWith(ref, {});
  });

  it('NOTESD_STREAMING=off leaves the streaming sites out', async () => {
    const f = fakes();
    const movieStreams = {} as MovieStreams;
    const config: Config = { ...moviesOn(streamConfig()), streaming: { enabled: false } };
    const s = await startDirectStreaming({ config, db, movies, movieStreams, importPending: false, boundPort: () => null }, f.io);
    expect(s.streaming).toBeNull();
    expect(f.serviceWiring()!.siteFallback).toBeNull();
  });
});

describe('movieStreamHooks', () => {
  it('passes each hook straight through to MovieStreams', async () => {
    const names = ['recordResolve', 'resumeS', 'originalLanguage', 'setAudioLanguage', 'titleLabel', 'neighbors', 'imdbId', 'titleNames', 'channel', 'channelFailed', 'forgetTorrent', 'releaseDate'] as const;
    const fake: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const n of names) fake[n] = vi.fn(() => n);
    fake.animeRef = vi.fn(() => 'anime');
    const mapper = {} as never;
    const hooks = movieStreamHooks(fake as unknown as MovieStreams, mapper) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const n of names) {
      expect(hooks[n]!('a', 'b')).toBe(n);
      expect(fake[n]).toHaveBeenCalled();
    }
    expect(hooks.anime!('ref')).toBe('anime');
    expect(fake.animeRef).toHaveBeenCalledWith('ref', mapper);
  });
});
