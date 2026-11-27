import type { ResolveAttempt, ResolveOutcome, StreamRef } from '../../types.js';
import type { IndexAttempt } from '../find/index.js';
import type { FindQuery, TitleNames } from './types.js';

/** The key a film or episode's in-memory state goes by (failures, pasted magnets, listings): `movie:<id>`, `tv:<id>:<s>:<e>`. */
export const refKey = (ref: StreamRef): string => (ref.kind === 'tv' ? `tv:${ref.tmdbId}:${ref.season}:${ref.episode}` : `movie:${ref.tmdbId}`);

/** An index's outcome as an attempt's: an index that listed torrents `resolved`, an empty one `no_stream`. */
const INDEX_OUTCOMES: Record<IndexAttempt['outcome'], ResolveOutcome> = { ok: 'resolved', empty: 'no_stream', error: 'error', bot_check: 'bot_check', skipped: 'skipped' };

/** One `Index: <name>` attempt per index the finder asked. */
export function indexAttempt(a: IndexAttempt): ResolveAttempt {
  return { provider: `Index: ${a.index}`, outcome: INDEX_OUTCOMES[a.outcome], took_s: a.took_s, detail: a.detail };
}

/** The finder's query: the IMDb id, the title's names and year, its original language, and the episode for a series. */
export function queryOf(ref: StreamRef, imdbId: string | null, names: TitleNames | null, audioLang: string | null): FindQuery {
  const common = { imdbId, title: names?.title ?? null, originalTitle: names?.originalTitle ?? null, year: names?.year ?? null, originalLanguage: audioLang };
  if (ref.kind === 'movie') return { ...common, kind: 'movie' };
  // TMDB's number runs on across seasons (a long anime): the indexes and many releases count within the season.
  const place = names?.episodeInSeason ?? null;
  const runsOn = place !== null && place >= 1 && place < ref.episode;
  return { ...common, kind: 'tv', season: ref.season, episode: ref.episode, ...(runsOn ? { absoluteEpisode: ref.episode, alt: { season: ref.season, episode: place } } : {}) };
}
