import { useCallback, useEffect, useRef, useState } from 'react';
import {
  errorCode,
  fetchMovie,
  fetchMovies,
  fetchPlayer,
  fetchStatus,
  fetchUnmatched,
  MOVIES_EVENTS_URL,
  type MoviesStatusResponse,
  type PlayerState,
  type TitleDetail,
  type TitleListItem,
  type UnmatchedFile,
} from '../moviesApi';
import { isPageVisible, onBecameVisible, startAdaptivePoll } from '../lib/pageActive';
import { detailIsFor } from '../lib/movies';
import type { MoviesRoute } from '../lib/route';

/** Every minute while the tab is visible: picks up a sync or a play on the other laptop (its events never reach this daemon). */
export const MOVIES_POLL_MS = 60_000;
/** While a VLC that notesd started is playing: the player and the open title, so the position moves on the page. */
export const PLAY_POLL_MS = 5_000;

export interface MoviesStore {
  titles: TitleListItem[] | null;
  listError: string | null;
  /** The detail of the title asked for (null while loading, and on the grid or unmatched page). */
  detail: TitleDetail | null;
  detailError: string | null;
  unmatched: UnmatchedFile[] | null;
  unmatchedError: string | null;
  status: MoviesStatusResponse | null;
  player: PlayerState | null;
  /** Re-read everything the page shows. Called after every write: the server's state wins. */
  refresh: () => void;
}

function quiet(what: string, e: unknown): void {
  if (errorCode(e) !== 'movies_off') console.error(`movies: ${what} failed`, e);
}

/**
 * The Movies page's data. Fetches only while `enabled` (the page is shown): the library (grid and
 * header), the status (unmatched badge, empty state), the player, and the title or unmatched list
 * the route asks for. Refreshes on `GET /api/movies/events` `changed`, every minute while visible,
 * and, while a play is active, the player and the open title every 5 s (one full refresh when it ends).
 */
export function useMovies(enabled: boolean, route: MoviesRoute): MoviesStore {
  const [titles, setTitles] = useState<TitleListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<UnmatchedFile[] | null>(null);
  const [unmatchedError, setUnmatchedError] = useState<string | null>(null);
  const [status, setStatus] = useState<MoviesStatusResponse | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [tick, setTick] = useState(0);
  const [playTick, setPlayTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** A `changed` event arrived while the tab was hidden: refresh once on becoming visible. */
  const staleRef = useRef(false);
  const wasPlaying = useRef(false);
  const title = route.title;
  const wantUnmatched = route.unmatched;
  const playing = player !== null && player.current !== null;

  useEffect(() => {
    if (!enabled) return;
    const onChanged = () => {
      if (isPageVisible()) refresh();
      else staleRef.current = true;
    };
    const es = typeof EventSource === 'undefined' ? null : new EventSource(MOVIES_EVENTS_URL);
    es?.addEventListener('changed', onChanged);
    const offVisible = onBecameVisible(() => {
      if (staleRef.current) {
        staleRef.current = false;
        refresh();
      }
    });
    const poll = startAdaptivePoll({
      baseMs: MOVIES_POLL_MS,
      run: async () => {
        refresh();
        return true;
      },
    });
    return () => {
      es?.close();
      offVisible();
      poll.stop();
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetchMovies(ac.signal).then(
      (t) => {
        if (ac.signal.aborted) return;
        setTitles(t);
        setListError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setListError(errorCode(e));
      },
    );
    fetchStatus(ac.signal).then(
      (s) => {
        if (!ac.signal.aborted) setStatus(s);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) quiet('status GET', e);
      },
    );
    return () => ac.abort();
  }, [enabled, tick]);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetchPlayer(ac.signal).then(
      (p) => {
        if (!ac.signal.aborted) setPlayer(p);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) quiet('player GET', e);
      },
    );
    return () => ac.abort();
  }, [enabled, tick, playTick]);

  useEffect(() => {
    if (!enabled || !playing) return;
    const timer = window.setInterval(() => {
      if (isPageVisible()) setPlayTick((t) => t + 1);
    }, PLAY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, playing]);

  // The play ended (VLC closed): states, progress and the grid changed, so read everything once.
  useEffect(() => {
    if (wasPlaying.current && !playing) refresh();
    wasPlaying.current = playing;
  }, [playing, refresh]);

  // A switch to another title drops the old detail at once, so its facts never show under the new heading.
  useEffect(() => {
    setDetail((d) => (detailIsFor(d, title) ? d : null));
    setDetailError(null);
  }, [title]);

  useEffect(() => {
    if (!enabled || title === null) return;
    const ac = new AbortController();
    fetchMovie(title, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setDetail(d);
        setDetailError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setDetailError(errorCode(e));
      },
    );
    return () => ac.abort();
  }, [enabled, title, tick, playTick]);

  useEffect(() => {
    if (!enabled || !wantUnmatched) return;
    const ac = new AbortController();
    fetchUnmatched(ac.signal).then(
      (f) => {
        if (ac.signal.aborted) return;
        setUnmatched(f);
        setUnmatchedError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setUnmatchedError(errorCode(e));
      },
    );
    return () => ac.abort();
  }, [enabled, wantUnmatched, tick]);

  return { titles, listError, detail, detailError, unmatched, unmatchedError, status, player, refresh };
}
