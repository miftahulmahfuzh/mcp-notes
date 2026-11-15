import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowsClockwise, FilmSlate, Question, Warning } from '@phosphor-icons/react';
import { MovieDetail } from '../components/movies/MovieDetail';
import { MoviesGrid } from '../components/movies/MoviesGrid';
import { MoviesPill } from '../components/movies/MoviesPill';
import { UnmatchedList } from '../components/movies/UnmatchedList';
import { useNotice } from '../hooks/useNotice';
import type { MoviesStore } from '../hooks/useMovies';
import { errorCode, startSync } from '../moviesApi';
import { emptyLibraryText, isMoviesOff, MOVIES_OFF_TEXT, detailIsFor, moviesErrorText, moviesPillPlaceholder, normalizeMovieId, NO_MOVIES_FILTER, stalledText, unmatchedCount, entityHint, entityQuestion, entitySearchQuery, type MovieEntity, type MoviesFilter } from '../lib/movies';
import { NO_MOVIES_ROUTE, type MoviesRoute } from '../lib/route';
import '../components/movies/Movies.css';

export interface MoviesPageProps {
  store: MoviesStore;
  route: MoviesRoute;
  /** Push another movies URL (grid, a title, the unmatched list). */
  onRoute: (r: MoviesRoute) => void;
  onAsk: (text: string, imageIds: string[], entity?: MoviesEntityAsk) => void;
  /** An answer is still streaming in the wall's answer panel: entity links wait for it. */
  asking?: boolean;
}

/** What an entity link adds to its question: the person id for the agent, and what the Google icon under the answer searches. */
export interface MoviesEntityAsk {
  hint: string | null;
  search: string;
}

function MoviesEmpty({ text }: { text: string }) {
  return (
    <div className="mv-off mv-content">
      <FilmSlate weight="duotone" />
      <p>{text}</p>
    </div>
  );
}

/**
 * The movies view's main area:
 *   .mv-tools   toolbar, icon-only: Back (on a title or the unmatched list), Unmatched files (with a count), Rescan
 *   content     grid / detail / unmatched list, or an empty state (subsystem off, empty library, error)
 *   pill        "Ask about your movies"; "Ask about <title>" on a title's page
 * The filter lives here, so it survives opening a title and coming back.
 */
export function MoviesPage({ store, route, onRoute, onAsk, asking = false }: MoviesPageProps) {
  const { notice, show } = useNotice(6000);
  const [filter, setFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [busy, setBusy] = useState(false);
  const off = isMoviesOff(store);
  const stalled = off ? null : stalledText(store.player);
  const waiting = unmatchedCount(store.status);
  const unmatchedTip = waiting === null || waiting === 0 ? 'Unmatched files' : `Unmatched files (${waiting})`;

  const rescan = async () => {
    setBusy(true);
    try {
      await startSync();
      show('rescan started');
    } catch (e) {
      show(`rescan refused: ${errorCode(e)}`);
    } finally {
      setBusy(false);
      store.refresh();
    }
  };

  let content: ReactNode;
  if (off) content = <MoviesEmpty text={MOVIES_OFF_TEXT} />;
  else if (route.unmatched)
    content = (
      <UnmatchedList
        files={store.unmatched}
        error={store.unmatchedError}
        onAssigned={(_id, name) => {
          show(`assigned to ${name}`);
          store.refresh();
        }}
      />
    );
  else if (route.title !== null) {
    if (store.detailError !== null) content = <MoviesEmpty text={moviesErrorText(store.detailError, route.title)} />;
    else if (!detailIsFor(store.detail, route.title)) content = <p className="mv-empty mv-content">loading</p>;
    else {
      const detail = store.detail;
      const askEntity = (e: MovieEntity) => onAsk(entityQuestion(e, detail), [], { hint: entityHint(e), search: entitySearchQuery(e, detail) });
      content = (
        <MovieDetail detail={detail} player={store.player} focus={normalizeMovieId(route.title)} onChanged={store.refresh} onNotice={show} onEntity={askEntity} asking={asking} />
      );
    }
  } else if (store.listError !== null) content = <MoviesEmpty text={moviesErrorText(store.listError)} />;
  else if (store.titles === null) content = <p className="mv-empty mv-content">loading the library</p>;
  else if (store.titles.length === 0) content = <MoviesEmpty text={emptyLibraryText(store.status)} />;
  else content = <MoviesGrid titles={store.titles} player={store.player} filter={filter} onFilter={setFilter} onOpen={(id) => onRoute({ title: id, unmatched: false })} />;

  return (
    <section className="mv" aria-label="Movies">
      <div className="mv-tools">
        {notice && (
          <span className="mv-note" role="status">
            {notice}
          </span>
        )}
        {(route.title !== null || route.unmatched) && (
          <button type="button" className="ibtn hov" data-tip="Back to the library" data-tip-side="below" aria-label="Back to the library" onClick={() => onRoute(NO_MOVIES_ROUTE)}>
            <ArrowLeft weight="duotone" />
          </button>
        )}
        <button
          type="button"
          className={route.unmatched ? 'ibtn on' : 'ibtn hov'}
          data-tip={unmatchedTip}
          data-tip-side="below"
          aria-label="Unmatched files"
          aria-pressed={route.unmatched}
          disabled={off}
          onClick={() => onRoute(route.unmatched ? NO_MOVIES_ROUTE : { title: null, unmatched: true })}
        >
          <Question weight="duotone" />
          {waiting !== null && waiting > 0 && <span className="mv-count">{waiting}</span>}
        </button>
        <button type="button" className="ibtn hov" data-tip="Rescan the library" data-tip-side="below" aria-label="Rescan the library" disabled={off || busy} onClick={() => void rescan()}>
          <ArrowsClockwise weight="duotone" />
        </button>
      </div>
      {stalled !== null && (
        <p className="mv-stalled mv-content" role="alert">
          <Warning weight="duotone" />
          <span>{stalled}</span>
        </p>
      )}
      {content}
      <MoviesPill onAsk={onAsk} placeholder={moviesPillPlaceholder(route, store.detail)} />
    </section>
  );
}
