import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVIES_CONFIG } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import { GenreGuides } from '../../../src/movies/guides.js';
import type { MoviePlayer, PlaybackOverrides } from '../../../src/movies/player.js';
import type { MoviesService } from '../../../src/movies/service.js';
import { buildMovieWriters, startMovies, startMoviesHealth } from '../../../src/movies/start.js';
import { MovieStories } from '../../../src/movies/story.js';
import type { MovieStreams } from '../../../src/movies/streams.js';
import type { HealthMonitor, VlcHealthOptions } from '../../../src/movies/vlc/health.js';
import { startConfig } from '../../helpers/startConfig.js';

const db = {} as Db;
const movies = { host: 'pc', repo: {}, tmdb: null } as unknown as MoviesService;
const config = startConfig({ movies: { ...DEFAULT_MOVIES_CONFIG, enabled: true } });

/** Every builder faked; `order` records the calls that touch the database or VLC, in order. */
function fakes(o: { closed?: number | Error; available?: boolean; streamsClosed?: number | Error; finder?: boolean } = {}) {
  const order: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const health = { start: vi.fn(), close: vi.fn() } as unknown as HealthMonitor;
  let healthOptions: VlcHealthOptions | null = null;
  let playbackOverrides: PlaybackOverrides | null = null;
  const view = { pid: 1 };
  const player = {
    start: vi.fn(async () => {
      order.push('player.start');
      if (o.closed instanceof Error) throw o.closed;
      return o.closed ?? 0;
    }),
    availability: vi.fn(async () => {
      order.push('player.availability');
      return o.available === false ? { available: false, reason: 'no vlc.exe' } : { available: true };
    }),
    healthView: () => view,
  } as unknown as MoviePlayer;
  const streams = {
    closeLeftOpen: vi.fn(async () => {
      order.push('streams.closeLeftOpen');
      if (o.streamsClosed instanceof Error) throw o.streamsClosed;
      return o.streamsClosed ?? 0;
    }),
  } as unknown as MovieStreams;
  const finder = async () => [];
  const io = {
    build: vi.fn(() => movies),
    health: vi.fn((h: VlcHealthOptions) => {
      healthOptions = h;
      return health;
    }),
    finder: vi.fn(() => (o.finder === false ? null : finder)),
    playback: vi.fn((_m: MoviesService, _c: unknown, p: PlaybackOverrides) => {
      playbackOverrides = p;
      return player;
    }),
    foreground: vi.fn(() => ({}) as NonNullable<PlaybackOverrides['foreground']>),
    streams: vi.fn(() => streams),
    log: (l: string) => lines.push(l),
    error: (l: string) => errors.push(l),
  };
  return { io, order, lines, errors, health, player, streams, finder, view, healthOptions: () => healthOptions, playbackOverrides: () => playbackOverrides };
}

describe('startMovies', () => {
  it('builds nothing else with NOTESD_MOVIES=off', async () => {
    const f = fakes();
    f.io.build.mockReturnValue(null as unknown as MoviesService);
    expect(await startMovies(startConfig(), db, f.io)).toEqual({ movies: null, moviesHealth: null, moviesPlayer: null, movieStreams: null });
    expect(f.io.health).not.toHaveBeenCalled();
    expect(f.io.playback).not.toHaveBeenCalled();
    expect(f.io.streams).not.toHaveBeenCalled();
  });

  it('builds the health log before the player, which it reads back through the player', async () => {
    const f = fakes();
    const wired = await startMovies(config, db, f.io);
    expect(wired).toEqual({ movies, moviesHealth: f.health, moviesPlayer: f.player, movieStreams: f.streams });
    const h = f.healthOptions()!;
    expect(h.host).toBe('pc');
    expect(h.dataDir).toBe(config.dataDir);
    expect(h.tracked()).toBe(f.view);
    expect(f.playbackOverrides()!.health).toBe(f.health);
    expect(f.playbackOverrides()!.findVlcs).toBe(f.finder);
  });

  it('closes VLC plays, says how playback runs, then closes the stream plays: in that order', async () => {
    const f = fakes({ closed: 2, streamsClosed: 1 });
    await startMovies(config, db, f.io);
    expect(f.order).toEqual(['player.start', 'player.availability', 'streams.closeLeftOpen']);
    expect(f.lines).toEqual([
      '[notesd] movies: closed 2 play(s) left open by the previous run at their last position',
      `[notesd] movies: playback via ${config.movies.vlc.bin} on ports ${config.movies.vlc.httpPort}+`,
      '[notesd] direct stream: closed 1 stream play(s) left open by the previous run at their last position',
    ]);
  });

  it('says nothing of closes when nothing was left open, and why playback is off', async () => {
    const f = fakes({ available: false, finder: false });
    await startMovies(config, db, f.io);
    expect(f.lines).toEqual(['[notesd] movies: playback off (no vlc.exe)']);
    expect(f.playbackOverrides()).not.toHaveProperty('findVlcs');
  });

  it('a failed close is logged and never fails the start', async () => {
    const f = fakes({ closed: new Error('db down'), streamsClosed: new Error('still down') });
    const wired = await startMovies(config, db, f.io);
    expect(wired.moviesPlayer).toBe(f.player);
    expect(f.errors).toEqual(['[notesd] movies: could not close stale plays: db down', '[notesd] direct stream: could not close stale stream plays: still down']);
    expect(f.order).toEqual(['player.start', 'player.availability', 'streams.closeLeftOpen']);
  });
});

describe('startMoviesHealth', () => {
  it('starts nothing without the library', async () => {
    await expect(startMoviesHealth(null)).resolves.toBeUndefined();
  });

  it('starts sampling, and a failure is one log line', async () => {
    const ok = { start: vi.fn(async () => {}) };
    await startMoviesHealth(ok);
    expect(ok.start).toHaveBeenCalledTimes(1);
    const errors: string[] = [];
    await startMoviesHealth({ start: async () => Promise.reject(new Error('no powershell')) }, (l) => errors.push(l));
    expect(errors).toEqual(['[notesd] vlc health: could not start: no powershell']);
  });
});

describe('buildMovieWriters', () => {
  it('builds neither without the library', () => {
    expect(buildMovieWriters(config, db, null, null)).toEqual({ movieStories: null, genreGuides: null });
  });

  it('builds the stories and the genre guides with the library, with or without a story model', () => {
    for (const storyModel of [null, 'sonnet']) {
      const built = buildMovieWriters({ ...config, movies: { ...config.movies, storyModel } }, db, movies, null);
      expect(built.movieStories).toBeInstanceOf(MovieStories);
      expect(built.genreGuides).toBeInstanceOf(GenreGuides);
    }
  });
});
