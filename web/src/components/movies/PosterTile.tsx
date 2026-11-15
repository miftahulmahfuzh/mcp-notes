import type { MouseEvent } from 'react';
import type { TitleListItem } from '../../moviesApi';
import { isGone, kindLabel, stateBadge, TILE_LIVE_LABEL, tileProgress, type LivePlace, type MoviesSide, type TileLive } from '../../lib/movies';
import { moviesHref } from '../../lib/route';
import { Poster } from './Poster';

export interface PosterTileProps {
  title: TitleListItem;
  /** This title is on screen: in the VLC notesd follows, or in the stream player. */
  live?: TileLive | null;
  /** Where `live` is playing. */
  livePlace?: LivePlace;
  /** The Stream side: never dimmed as gone, and the link opens the title on the Stream side. */
  side?: MoviesSide;
  onOpen: (titleId: string) => void;
}

/** One poster: state chip, progress bar while in progress, caption below. A real link, so a middle click opens a tab. */
export function PosterTile({ title: t, live = null, livePlace = 'VLC', side = 'library', onOpen }: PosterTileProps) {
  const gone = isGone(t, side);
  const badge = stateBadge(t.state);
  const progress = tileProgress(t);
  const titleId = t.movie_id ?? t.id;
  const href = moviesHref(side === 'stream' ? { title: titleId, unmatched: false, stream: true } : { title: titleId, unmatched: false });
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(titleId);
  };
  return (
    <a href={href} className={['mv-tile', gone ? 'gone' : '', live !== null ? `now ${live}` : ''].filter((c) => c !== '').join(' ')} data-title={titleId} onClick={open}>
      <span className="mv-art">
        <Poster key={t.poster_url ?? 'none'} url={t.poster_url} title={t.title} year={t.year} />
        {live === null && badge !== null && <span className={`mv-badge ${t.state}`}>{badge}</span>}
        {live !== null && (
          <span className={`mv-badge mv-now ${live}`} role="status" aria-label={`${t.title}: ${TILE_LIVE_LABEL[live]} in ${livePlace}`}>
            {TILE_LIVE_LABEL[live]}
          </span>
        )}
        {progress !== null && (
          <span className="mv-progress" aria-hidden="true">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="mv-cap">
        <span className="mv-cap-t">{t.title}</span>
        <span className="mv-cap-m">
          {[t.year === null ? '' : String(t.year), kindLabel(t.kind), gone ? 'no file left' : ''].filter((s) => s !== '').join(' · ')}
        </span>
      </span>
    </a>
  );
}
