import { isValidElement, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowsClockwise, Books, Broadcast, FilmSlate, Question, Warning } from '@phosphor-icons/react';
import { MovieDetail } from '../components/movies/MovieDetail';
import { MoviesGrid } from '../components/movies/MoviesGrid';
import { MoviesPill } from '../components/movies/MoviesPill';
import { UnmatchedList } from '../components/movies/UnmatchedList';
import { useNotice } from '../hooks/useNotice';
import type { MoviesStore } from '../hooks/useMovies';
import { errorCode, startSync } from '../moviesApi';
import {
  detailIsFor,
  emptyLibraryText,
  entityHint,
  entityQuestion,
  entitySearchQuery,
  isMoviesOff,
  MOVIES_OFF_TEXT,
  moviesErrorText,
  moviesPillPlaceholder,
  NO_MOVIES_FILTER,
  normalizeMovieId,
  sideOf,
  stalledText,
  STREAM_OFF_TEXT,
  streamEmptyText,
  unmatchedCount,
  type MovieEntity,
  type MoviesFilter,
} from '../lib/movies';
import { NO_MOVIES_ROUTE, STREAM_ROUTE, type MoviesRoute } from '../lib/route';
import '../components/movies/Movies.css';

export interface MoviesPageProps {
  store: MoviesStore;
  route: MoviesRoute;
  /** Push another movies URL (grid, a title, the unmatched list, either side). */
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
 *   controls    icon-only: the Library / Stream switch, then Back (on a title or the unmatched
 *               list), and on the Library side Unmatched files (with a count) and Rescan. Over a
 *               grid they sit in the grid's filter row (one row of controls); elsewhere they are
 *               the .mv-tools toolbar
 *   content     grid / detail / unmatched list, or an empty state (subsystem off, empty library or
 *               Stream side, direct streaming off, error)
 *   pill        "Ask about your movies"; "Ask about <title>" on a title's page
 * Each side keeps its own filter here, so it survives opening a title and coming back.
 * The Stream side has no entry in the rail or sidebar: it is this switch only (D3).
 */
export function MoviesPage({ store, route, onRoute, onAsk, asking = false }: MoviesPageProps) {
  const { notice, show } = useNotice(6000);
  const [filter, setFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [streamFilter, setStreamFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [busy, setBusy] = useState(false);
  const side = sideOf(route);
  const off = isMoviesOff(store);
  const stalled = off ? null : stalledText(store.player);
  const waiting = unmatchedCount(store.status);
  const unmatchedTip = waiting === null || waiting === 0 ? 'Unmatched files' : `Unmatched files (${waiting})`;
  const backLabel = side === 'stream' ? 'Back to Stream' : 'Back to the library';

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

  // The switch and the tool buttons are built once: a grid takes them into its filter row, so the
  // page has one row of controls; without a grid (a title, the unmatched list, an empty state)
  // they are the toolbar.
  const sideSwitch = (
    <div className="mv-side" role="group" aria-label="Library or Stream">
      <button
        type="button"
        className={side === 'library' ? 'ibtn on' : 'ibtn hov'}
        data-tip="Library: the files on your machines"
        data-tip-side="below"
        aria-label="Library"
        aria-pressed={side === 'library'}
        disabled={off}
        onClick={() => onRoute(NO_MOVIES_ROUTE)}
      >
        <Books weight="duotone" />
      </button>
      <button
        type="button"
        className={side === 'stream' ? 'ibtn on' : 'ibtn hov'}
        data-tip="Stream: titles verified to play on this machine"
        data-tip-side="below"
        aria-label="Stream"
        aria-pressed={side === 'stream'}
        disabled={off}
        onClick={() => onRoute(STREAM_ROUTE)}
      >
        <Broadcast weight="duotone" />
      </button>
    </div>
  );
  const tools = (
    <>
    {notice && (
      <span className="mv-note" role="status">
        {notice}
      </span>
    )}
    {(route.title !== null || route.unmatched) && (
      <button type="button" className="ibtn hov" data-tip={backLabel} data-tip-side="below" aria-label={backLabel} onClick={() => onRoute(side === 'stream' ? STREAM_ROUTE : NO_MOVIES_ROUTE)}>
        <ArrowLeft weight="duotone" />
      </button>
    )}
    {side === 'library' && (
      <>
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
      </>
    )}
    </>
  );
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
        <MovieDetail
          detail={detail}
          player={store.player}
          focus={normalizeMovieId(route.title)}
          side={side}
          streamEnabled={store.stream?.enabled ?? true}
          onChanged={store.refresh}
          onNotice={show}
          onEntity={askEntity}
          asking={asking}
        />
      );
    }
  } else if (side === 'stream') {
    const list = store.stream;
    if (store.streamError !== null) content = <MoviesEmpty text={moviesErrorText(store.streamError)} />;
    else if (list === null) content = <p className="mv-empty mv-content">loading the Stream titles</p>;
    else if (!list.enabled) content = <MoviesEmpty text={STREAM_OFF_TEXT} />;
    else if (list.titles.length === 0) content = <MoviesEmpty text={streamEmptyText(list.fresh_days)} />;
    else
      content = (
        <MoviesGrid side="stream" lead={sideSwitch} tail={tools} titles={list.titles} player={store.player} filter={streamFilter} onFilter={setStreamFilter} onOpen={(id) => onRoute({ title: id, unmatched: false, stream: true })} />
      );
  } else if (store.listError !== null) content = <MoviesEmpty text={moviesErrorText(store.listError)} />;
  else if (store.titles === null) content = <p className="mv-empty mv-content">loading the library</p>;
  else if (store.titles.length === 0) content = <MoviesEmpty text={emptyLibraryText(store.status)} />;
  else content = <MoviesGrid lead={sideSwitch} tail={tools} titles={store.titles} player={store.player} filter={filter} onFilter={setFilter} onOpen={(id) => onRoute({ title: id, unmatched: false })} />;

  const inGrid = isValidElement(content) && content.type === MoviesGrid;

  return (
    <section className="mv" aria-label="Movies">
      {!inGrid && (
        <div className="mv-tools">
          {sideSwitch}
          {tools}
        </div>
      )}
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
