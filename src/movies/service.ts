import type { MoviesRepo } from './repo.js';

/**
 * Forward declaration (MOVIES_LIBRARY_PLAN phase 1) so `AppDeps.movies` has a type before the
 * service exists. Phase 3 replaces this file with the real `class MoviesService` (which must keep
 * at least these members) and `buildMoviesService`; until then `deps.movies` is always null.
 */
export interface MoviesService {
  /** os.hostname() of this daemon: the host whose files it scans and plays. */
  readonly host: string;
  readonly repo: MoviesRepo;
  start(): void;
  close(): Promise<void>;
}
