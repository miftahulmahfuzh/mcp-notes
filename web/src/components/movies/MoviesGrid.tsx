import { FilmSlate, MagnifyingGlass, SquaresFour, Television } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { PlayerState, TitleListItem } from '../../moviesApi';
import { KIND_FILTERS, matchesFilter, sortTitles, stateCounts, stateFilters, tileLive, tileLivePlace, type KindFilter, type MoviesFilter, type MoviesSide } from '../../lib/movies';
import { PosterTile } from './PosterTile';

const KIND_ICON: Record<KindFilter, Icon> = { all: SquaresFour, movie: FilmSlate, tv: Television };

export interface MoviesGridProps {
  titles: TitleListItem[];
  /** The followed play marks its title's poster. */
  player?: PlayerState | null;
  filter: MoviesFilter;
  onFilter: (f: MoviesFilter) => void;
  onOpen: (titleId: string) => void;
  /** `stream`: the Stream side's grid. A title there has no file by design, so nothing is "gone" and there is no gone pill. */
  side?: MoviesSide;
  /** Shown first in the filter row, before a separator: the page's Library / Stream switch. */
  lead?: ReactNode;
  /** Shown last in the filter row, after the text filter: the page's tool buttons. */
  tail?: ReactNode;
}

/** The library or the Stream side: one row of controls (the page's switch, state pills with counts, kind icons, a text filter, the page's tools), then one poster per title. */
export function MoviesGrid({ titles, player = null, filter, onFilter, onOpen, side = 'library', lead = null, tail = null }: MoviesGridProps) {
  const counts = stateCounts(titles, filter, side);
  const shown = sortTitles(
    titles.filter((t) => matchesFilter(t, filter, side)),
    side,
  );
  return (
    <section className="mv-lib mv-content" aria-label={side === 'stream' ? 'Stream' : 'Library'}>
      <div className="mv-filter">
        {lead !== null && (
          <>
            {lead}
            <span className="mv-fsep" aria-hidden="true" />
          </>
        )}
        <div className="mv-fstates" role="group" aria-label="State">
          {stateFilters(side).map((s) => (
            <button
              key={s.key}
              type="button"
              className={filter.state === s.key ? 'mv-fpill on' : 'mv-fpill'}
              aria-pressed={filter.state === s.key}
              onClick={() => onFilter({ ...filter, state: s.key })}
            >
              {s.label}
              <span className="mv-fn">{counts[s.key]}</span>
            </button>
          ))}
        </div>
        <div className="mv-fkinds" role="group" aria-label="Kind">
          {KIND_FILTERS.map((k) => {
            const I = KIND_ICON[k.key];
            const on = filter.kind === k.key;
            return (
              <button
                key={k.key}
                type="button"
                className={on ? 'ibtn on' : 'ibtn hov'}
                data-tip={k.label}
                data-tip-side="below"
                aria-label={k.label}
                aria-pressed={on}
                onClick={() => onFilter({ ...filter, kind: k.key })}
              >
                <I weight="duotone" />
              </button>
            );
          })}
        </div>
        <label className="mv-ftext">
          <MagnifyingGlass weight="duotone" />
          <input type="search" value={filter.text} placeholder="Filter titles" aria-label="Filter titles" onChange={(e) => onFilter({ ...filter, text: e.target.value })} />
        </label>
        {tail !== null && <div className="mv-ftools">{tail}</div>}
      </div>
      {shown.length === 0 ? (
        <p className="mv-empty">Nothing matches this filter.</p>
      ) : (
        <div className="mv-grid" role="list" aria-label="Posters">
          {shown.map((t) => (
            <div key={t.id} role="listitem">
              <PosterTile title={t} side={side} live={tileLive(t.id, player)} livePlace={tileLivePlace(t.id, player)} onOpen={onOpen} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
