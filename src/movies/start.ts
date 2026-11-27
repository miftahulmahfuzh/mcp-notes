import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { DirectStreamService } from '../directStream/service.js';
import { loadDialogue } from '../directStream/dialogueStore.js';
import { createGuideWriter, GenreGuides } from './guides.js';
import { buildMoviePlayback, type MoviePlayer, type PlaybackOverrides } from './player.js';
import { buildMoviesService, type MoviesService } from './service.js';
import { createStoryWriter, MovieStories } from './story.js';
import { MovieStreams } from './streams.js';
import { windowsForegrounder } from './vlc/foreground.js';
import { buildVlcFinder, buildVlcHealth, type HealthMonitor, type VlcHealthOptions } from './vlc/health.js';
import { createWebStoryWriter } from './webStory.js';

/** What the movies library is at start: every part null with NOTESD_MOVIES=off. */
export interface MoviesWiring {
  /** Sync, matching and the store; started and closed by startBackground. */
  movies: MoviesService | null;
  /** The VLC health log (phase 9): sampling starts once the daemon serves (startMoviesHealth). */
  moviesHealth: HealthMonitor | null;
  /** VLC playback and the [RecentsMRL] hook (phase 5). */
  moviesPlayer: MoviePlayer | null;
  /** Stream plays and verified sources, written to the movies store (direct streaming phase 5). */
  movieStreams: MovieStreams | null;
}

export interface StartMoviesIo {
  build?: (config: Config, db: Db) => MoviesService | null;
  health?: (o: VlcHealthOptions) => HealthMonitor;
  finder?: (config: Config['movies']) => PlaybackOverrides['findVlcs'] | null;
  playback?: (movies: MoviesService, config: Config['movies'], overrides: PlaybackOverrides) => MoviePlayer;
  foreground?: () => NonNullable<PlaybackOverrides['foreground']>;
  streams?: (movies: MoviesService) => MovieStreams;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The movies library and its VLC playback. The health log is built before the player, whose hang rule asks it whether
 * a silent VLC still exists; it reads the followed play back through the player. The plays the previous run left open
 * (VLC's, then the stream plays: player sessions live in memory) are closed at their last position here, each failure
 * logged and never failing the start.
 */
export async function startMovies(config: Config, db: Db, io: StartMoviesIo = {}): Promise<MoviesWiring> {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const movies = (io.build ?? buildMoviesService)(config, db);
  if (movies === null) return { movies: null, moviesHealth: null, moviesPlayer: null, movieStreams: null };
  let moviesPlayer: MoviePlayer | null = null;
  const moviesHealth = (io.health ?? buildVlcHealth)({ config: config.movies, dataDir: config.dataDir, host: movies.host, tracked: () => moviesPlayer?.healthView() ?? null });
  const findVlcs = (io.finder ?? buildVlcFinder)(config.movies);
  moviesPlayer = (io.playback ?? buildMoviePlayback)(movies, config.movies, {
    foreground: (io.foreground ?? windowsForegrounder)(),
    health: moviesHealth,
    ...(findVlcs == null ? {} : { findVlcs }),
  });
  try {
    const closed = await moviesPlayer.start();
    if (closed > 0) log(`[notesd] movies: closed ${closed} play(s) left open by the previous run at their last position`);
  } catch (err) {
    error(`[notesd] movies: could not close stale plays: ${messageOf(err)}`);
  }
  const playback = await moviesPlayer.availability();
  log(playback.available ? `[notesd] movies: playback via ${config.movies.vlc.bin} on ports ${config.movies.vlc.httpPort}+` : `[notesd] movies: playback off (${playback.reason})`);
  const movieStreams = (io.streams ?? ((m: MoviesService) => new MovieStreams(m)))(movies);
  try {
    const closed = await movieStreams.closeLeftOpen();
    if (closed > 0) log(`[notesd] direct stream: closed ${closed} stream play(s) left open by the previous run at their last position`);
  } catch (err) {
    error(`[notesd] direct stream: could not close stale stream plays: ${messageOf(err)}`);
  }
  return { movies, moviesHealth, moviesPlayer, movieStreams };
}

/** Movies phase 9: sampling starts once the daemon serves; the incident of a crashed run is written in the background. */
export async function startMoviesHealth(health: Pick<HealthMonitor, 'start'> | null, error: (line: string) => void = (line) => console.error(line)): Promise<void> {
  if (health === null) return;
  try {
    await health.start();
  } catch (err) {
    error(`[notesd] vlc health: could not start: ${messageOf(err)}`);
  }
}

/**
 * The story of a film, an episode or a whole season (from published recaps found with WebSearch first; an episode or a
 * film the web has none of, from its dialogue), and what a genre means for one title (collated with web search). One
 * model run each on the owner's click, then kept. Both null without the library; their writers null with no story model.
 */
export function buildMovieWriters(
  config: Pick<Config, 'movies' | 'chat' | 'dataDir'>,
  db: Db,
  movies: MoviesService | null,
  directStream: DirectStreamService | null,
): { movieStories: MovieStories | null; genreGuides: GenreGuides | null } {
  if (movies === null) return { movieStories: null, genreGuides: null };
  const storyModel = config.movies.storyModel ?? null;
  const claudeBin = config.chat.claudeBin;
  const movieStories = new MovieStories({
    repo: movies.repo,
    dialogue: (target) => loadDialogue(movies.repo, directStream, target),
    writer: storyModel === null ? null : createStoryWriter({ claudeBin, model: storyModel, cwd: join(config.dataDir, 'movies-story') }),
    webWriter: storyModel === null ? null : createWebStoryWriter({ claudeBin, model: storyModel, cwd: join(config.dataDir, 'movies-web-story') }),
  });
  const genreGuides = new GenreGuides({
    db,
    repo: movies.repo,
    tmdb: movies.tmdb,
    writer: storyModel === null ? null : createGuideWriter({ claudeBin, model: storyModel, cwd: join(config.dataDir, 'movies-guide') }),
  });
  return { movieStories, genreGuides };
}
