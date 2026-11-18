import { ArrowCounterClockwise, Play, X } from '@phosphor-icons/react';
import type { SiteTitle } from '../../moviesApi';
import { siteTitleCaption, siteTitleNext } from '../../lib/movies';
import { Poster } from './Poster';

export interface SiteTitlesSectionProps {
  titles: SiteTitle[];
  /** A play is being started. */
  busy: boolean;
  /** Plays the film, or the episode named; no episode: the one after the last played. */
  onPlay: (title: SiteTitle, episode?: number) => void;
  onRemove: (title: SiteTitle) => void;
}

/**
 * Titles played on a streaming site that TMDB does not list. They have no page of their own: the
 * poster and the words are the site's, and a click plays the next episode there again.
 */
export function SiteTitlesSection({ titles, busy, onPlay, onRemove }: SiteTitlesSectionProps) {
  if (titles.length === 0) return null;
  return (
    <section className="mv-trend mv-content" aria-label="From streaming sites">
      <h2 className="mv-trend-h">From streaming sites</h2>
      <p className="mv-trend-sub">Played on a streaming site and not listed by TMDB, so all there is of them is what the site says. A poster plays the next episode there.</p>
      <div className="mv-grid" role="list" aria-label="Streaming site posters">
        {titles.map((t) => {
          const next = siteTitleNext(t);
          const again = t.kind === 'series' && t.episode !== null ? `Play episode ${t.episode} of ${t.name} again` : null;
          const remove = `Take ${t.name} off this list`;
          return (
            <div key={t.id} role="listitem" className="mv-cell">
              <button type="button" className="mv-tile mv-site-tile" data-site-title={t.id} title={t.overview === '' ? undefined : t.overview} aria-label={next.label} disabled={busy} onClick={() => onPlay(t)}>
                <span className="mv-art">
                  <Poster key={t.poster_url ?? 'none'} url={t.poster_url} title={t.name} year={t.year} />
                </span>
                <span className="mv-cap">
                  <span className="mv-cap-t">{t.name}</span>
                  <span className="mv-cap-m">{siteTitleCaption(t)}</span>
                </span>
              </button>
              <span className="mv-tile-acts">
                <button type="button" className="ibtn" data-tip={next.label} data-tip-side="below" aria-label={next.label} disabled={busy} onClick={() => onPlay(t)}>
                  <Play weight="duotone" />
                </button>
                {again !== null && (
                  <button type="button" className="ibtn" data-tip={again} data-tip-side="below" aria-label={again} disabled={busy} onClick={() => onPlay(t, t.episode ?? undefined)}>
                    <ArrowCounterClockwise weight="duotone" />
                  </button>
                )}
                <button type="button" className="ibtn" data-tip={remove} data-tip-side="below" aria-label={remove} onClick={() => onRemove(t)}>
                  <X weight="duotone" />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
