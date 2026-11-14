import type { MouseEvent } from 'react';
import type { TitleListItem } from '../../moviesApi';
import { isGone, kindLabel, stateBadge, tileProgress } from '../../lib/movies';
import { moviesHref } from '../../lib/route';
import { Poster } from './Poster';

export interface PosterTileProps {
  title: TitleListItem;
  onOpen: (titleId: string) => void;
}

/** One poster: state chip, progress bar while in progress, caption below. A real link, so a middle click opens a tab. */
export function PosterTile({ title: t, onOpen }: PosterTileProps) {
  const gone = isGone(t);
  const badge = stateBadge(t.state);
  const progress = tileProgress(t);
  const titleId = t.movie_id ?? t.id;
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(titleId);
  };
  return (
    <a href={moviesHref({ title: titleId, unmatched: false })} className={gone ? 'mv-tile gone' : 'mv-tile'} data-title={titleId} onClick={open}>
      <span className="mv-art">
        <Poster key={t.poster_url ?? 'none'} url={t.poster_url} title={t.title} year={t.year} />
        {badge !== null && <span className={`mv-badge ${t.state}`}>{badge}</span>}
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
