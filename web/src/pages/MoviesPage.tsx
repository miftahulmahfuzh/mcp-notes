import { isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowsClockwise, Books, Broadcast, FilmSlate, Question, Warning } from '@phosphor-icons/react';
import { MovieDetail } from '../components/movies/MovieDetail';
import { MoviesGrid } from '../components/movies/MoviesGrid';
import { MoviesPill } from '../components/movies/MoviesPill';
import { TrendingSection } from '../components/movies/TrendingSection';
import { UnmatchedList } from '../components/movies/UnmatchedList';
import { useNotice } from '../hooks/useNotice';
import type { MoviesStore } from '../hooks/useMovies';
import { askProberPass, askTrendingRefresh, errorCode, fetchProber, saveTitleUser, startSync, streamPlay, type ProberState, type TitleListItem, type TrendingTitle } from '../moviesApi';
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
  pendingMarks,
  sideOf,
  stalledText,
  STREAM_OFF_TEXT,
  streamEmptyText,
  unmatchedCount,
  withMarks,
  type MovieEntity,
  type MoviesFilter,
  type TitleMark,
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

/** How often the Stream side re-reads the prober while a pass runs. */
const PROBER_POLL_MS = 5000;

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
  const { notice, action, show } = useNotice(6000);
  const [filter, setFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [streamFilter, setStreamFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [busy, setBusy] = useState(false);
  const side = sideOf(route);
  const off = isMoviesOff(store);
  const stalled = off ? null : stalledText(store.player);
  const waiting = unmatchedCount(store.status);
  const unmatchedTip = waiting === null || waiting === 0 ? 'Unmatched files' : `Unmatched files (${waiting})`;
  const backLabel = side === 'stream' ? 'Back to Stream' : 'Back to the library';

  // The Stream side's refresh: one prober pass now. While it runs the page asks again every few
  // seconds, and reloads the grid when it ends.
  const [prober, setProber] = useState<ProberState | null>(null);
  const wasRunning = useRef(false);
  const refreshStore = store.refresh;
  const readProber = useCallback(async () => {
    try {
      const p = await fetchProber();
      setProber(p);
      if (wasRunning.current && !p.running) {
        const found = p.last_pass?.probe_verified ?? 0;
        const tried = (p.last_pass?.probed ?? 0) + (p.last_pass?.rechecked ?? 0);
        show(p.last_pass?.stopped === 'busy' ? 'nothing probed: something is playing' : `${found} new ${found === 1 ? 'title' : 'titles'} from ${tried} tried`);
        refreshStore();
      }
      wasRunning.current = p.running;
    } catch {
      setProber(null);
    }
  }, [show, refreshStore]);
  useEffect(() => {
    if (side !== 'stream' || off) return;
    void readProber();
  }, [side, off, readProber]);
  const probing = prober?.running === true;
  useEffect(() => {
    if (!probing) return;
    const t = window.setInterval(() => void readProber(), PROBER_POLL_MS);
    return () => window.clearInterval(t);
  }, [probing, readProber]);
  const findMore = async () => {
    try {
      const p = await askProberPass();
      wasRunning.current = true;
      setProber(p ?? { enabled: true, running: true, last_pass: null, settings: null });
      const budget = p?.settings?.probe_budget;
      show(budget === undefined ? 'looking for more titles' : `looking for more titles: up to ${budget}, out of sight`);
    } catch (e) {
      show(errorCode(e) === 'prober_off' ? 'the prober is off: set NOTESD_STREAM_PROBER=on and restart notesd' : `refresh refused: ${errorCode(e)}`);
    }
  };
  const findMoreTip = probing ? 'Looking for more titles to stream' : 'Find more titles to stream';

  // The Trending section's refresh: a new list and its swarm probes, now. The page asks again every few seconds while it runs.
  const [trendBusy, setTrendBusy] = useState(false);
  const trendRunning = trendBusy || store.trending?.enabled === true && store.trending.running;
  useEffect(() => {
    if (!trendRunning) return;
    const t = window.setInterval(() => refreshStore(), PROBER_POLL_MS);
    return () => window.clearInterval(t);
  }, [trendRunning, refreshStore]);
  const refreshTrending = async () => {
    setTrendBusy(true);
    try {
      await askTrendingRefresh();
      show('building the trending list');
    } catch (e) {
      show(errorCode(e) === 'trending_off' ? 'the trending list is off: set NOTESD_TRENDING=on and restart notesd' : `refresh refused: ${errorCode(e)}`);
    } finally {
      setTrendBusy(false);
      refreshStore();
    }
  };
  const playTorrent = async (t: TrendingTitle) => {
    show(`${t.title}: opening from its torrent`);
    try {
      await streamPlay({ kind: 'movie', tmdb_id: t.tmdb_id, provider: 'torrent' });
    } catch (e) {
      show(`${t.title}: could not play from its torrent (${errorCode(e)})`);
    }
  };

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

  // A poster's hover buttons: the mark is laid over the lists at the click, so the poster leaves
  // the grid at once, and is dropped when a list read shows it (or the save fails).
  const [marks, setMarks] = useState<ReadonlyMap<string, TitleMark>>(new Map());
  const setMark = (id: string, m: TitleMark | null) =>
    setMarks((prev) => {
      const next = new Map(prev);
      if (m === null) next.delete(id);
      else next.set(id, m);
      return next;
    });
  const streamTitles = store.stream?.titles ?? null;
  const trendingTitles = store.trending?.titles ?? null;
  useEffect(() => {
    setMarks((prev) => {
      const next = pendingMarks(prev, [store.titles, streamTitles, trendingTitles]);
      return next.size === prev.size ? prev : next;
    });
  }, [store.titles, streamTitles, trendingTitles]);
  /** Saved at once, no confirmation; the notice offers an undo. */
  const mark = async (t: TitleListItem, patch: TitleMark) => {
    const back: TitleMark = 'watched' in patch ? { watched: !patch.watched } : { not_interested: !patch.not_interested };
    const text =
      'watched' in patch
        ? patch.watched
          ? `${t.title}: watched${t.kind === 'tv' ? ', every season' : ''}, under finished`
          : `${t.title}: not watched`
        : patch.not_interested
          ? `${t.title}: not interested, off the Stream grid`
          : `${t.title}: back on the Stream grid`;
    setMark(t.id, patch);
    try {
      await saveTitleUser(t.id, patch);
      show(text, {
        label: 'undo',
        run: () => {
          setMark(t.id, back);
          void saveTitleUser(t.id, back)
            .catch((e: unknown) => {
              setMark(t.id, null);
              show(`could not undo (${errorCode(e)})`);
            })
            .finally(store.refresh);
        },
      });
    } catch (e) {
      setMark(t.id, null);
      show(`could not save (${errorCode(e)})`);
    } finally {
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
        {action !== null && (
          <button type="button" className="mv-undo" onClick={action.run}>
            {action.label}
          </button>
        )}
      </span>
    )}
    {(route.title !== null || route.unmatched) && (
      <button type="button" className="ibtn hov" data-tip={backLabel} data-tip-side="below" aria-label={backLabel} onClick={() => onRoute(side === 'stream' ? STREAM_ROUTE : NO_MOVIES_ROUTE)}>
        <ArrowLeft weight="duotone" />
      </button>
    )}
    {side === 'stream' && route.title === null && (
      <button
        type="button"
        className={probing ? 'ibtn on mv-spin' : 'ibtn hov'}
        data-tip={findMoreTip}
        data-tip-side="below"
        aria-label={findMoreTip}
        aria-busy={probing}
        disabled={off || probing || store.stream?.enabled === false}
        onClick={() => void findMore()}
      >
        <ArrowsClockwise weight="duotone" />
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
    else if (list.titles.length === 0 && store.trending?.enabled !== true) content = <MoviesEmpty text={streamEmptyText(list.fresh_days)} />;
    else if (list.titles.length === 0) content = <p className="mv-empty mv-content">{streamEmptyText(list.fresh_days)}</p>;
    else
      content = (
        <MoviesGrid side="stream" lead={sideSwitch} tail={tools} titles={withMarks(list.titles, marks)} player={store.player} filter={streamFilter} onFilter={setStreamFilter} onOpen={(id) => onRoute({ title: id, unmatched: false, stream: true })} onMark={(t, p) => void mark(t, p)} />
      );
  } else if (store.listError !== null) content = <MoviesEmpty text={moviesErrorText(store.listError)} />;
  else if (store.titles === null) content = <p className="mv-empty mv-content">loading the library</p>;
  else if (store.titles.length === 0) content = <MoviesEmpty text={emptyLibraryText(store.status)} />;
  else content = <MoviesGrid lead={sideSwitch} tail={tools} titles={withMarks(store.titles, marks)} player={store.player} filter={filter} onFilter={setFilter} onOpen={(id) => onRoute({ title: id, unmatched: false })} onMark={(t, p) => void mark(t, p)} />;

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
      {side === 'stream' && route.title === null && !route.unmatched && !off && store.streamError === null && (
        <TrendingSection
          trending={store.trending === null ? null : { ...store.trending, titles: withMarks(store.trending.titles, marks) }}
          running={trendRunning}
          onOpen={(id) => onRoute({ title: id, unmatched: false, stream: true })}
          onMark={(t, p) => void mark(t, p)}
          onRefresh={() => void refreshTrending()}
          onPlayTorrent={(t) => void playTorrent(t)}
        />
      )}
      <MoviesPill onAsk={onAsk} placeholder={moviesPillPlaceholder(route, store.detail)} />
    </section>
  );
}
