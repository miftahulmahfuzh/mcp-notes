import { FilmSlate, MagnifyingGlass, SquaresFour, Television } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { TitleListItem } from '../../moviesApi';
import { KIND_FILTERS, matchesFilter, sortTitles, stateCounts, STATE_FILTERS, type KindFilter, type MoviesFilter } from '../../lib/movies';
import { PosterTile } from './PosterTile';

const KIND_ICON: Record<KindFilter, Icon> = { all: SquaresFour, movie: FilmSlate, tv: Television };

export interface MoviesGridProps {
  titles: TitleListItem[];
  filter: MoviesFilter;
  onFilter: (f: MoviesFilter) => void;
  onOpen: (titleId: string) => void;
}

/** The library: a filter row (state pills with counts, kind icons, a text filter), then one poster per title. */
export function MoviesGrid({ titles, filter, onFilter, onOpen }: MoviesGridProps) {
  const counts = stateCounts(titles, filter);
  const shown = sortTitles(titles.filter((t) => matchesFilter(t, filter)));
  return (
    <section className="mv-lib mv-content" aria-label="Library">
      <div className="mv-filter">
        <div className="mv-fstates" role="group" aria-label="State">
          {STATE_FILTERS.map((s) => (
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
      </div>
      {shown.length === 0 ? (
        <p className="mv-empty">Nothing matches this filter.</p>
      ) : (
        <div className="mv-grid" role="list" aria-label="Posters">
          {shown.map((t) => (
            <div key={t.id} role="listitem">
              <PosterTile title={t} onOpen={onOpen} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
