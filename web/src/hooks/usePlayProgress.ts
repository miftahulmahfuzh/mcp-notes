import { useEffect, useState } from 'react';
import { fetchPlayer, type TitleKind } from '../moviesApi';
import { playProgressText, startingStage } from '../lib/movies';

/** How often the daemon is asked what a play being started is doing. */
export const PLAY_PROGRESS_MS = 1000;

/**
 * The line to show while a play is being started: what was asked (`doing`), replaced by the stage
 * the daemon names for this title's stream as soon as it has one ("asking the torrent indexes",
 * "opening 3 torrents", "opening the player page"), with the seconds it has taken. Null while
 * nothing is being started (`doing` null). It asks `GET /api/movies/player` once a second, and
 * only while a play is being started.
 */
export function usePlayProgress(doing: string | null, kind: TitleKind, tmdbId: number): string | null {
  const [stage, setStage] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setStage(null);
    setSeconds(0);
    if (doing === null) return;
    const began = Date.now();
    let gone = false;
    const tick = () => {
      setSeconds(Math.round((Date.now() - began) / 1000));
      fetchPlayer().then(
        (p) => {
          const now = startingStage(p, kind, tmdbId);
          // A stage that was named stays until the next one: between two of them the daemon lists none.
          if (!gone && now !== null) setStage(now);
        },
        () => {},
      );
    };
    tick();
    const timer = window.setInterval(tick, PLAY_PROGRESS_MS);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [doing, kind, tmdbId]);
  return doing === null ? null : playProgressText(doing, stage, seconds);
}
