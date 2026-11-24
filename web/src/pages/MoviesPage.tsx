import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowsClockwise, Books, Broadcast, FilmSlate, HardDrives, Question, Warning } from '@phosphor-icons/react';
import { CachePage } from '../components/movies/CachePage';
import { restoreScroll } from '../lib/scrollMemory';
import { MovieDetail } from '../components/movies/MovieDetail';
import { MoviesGrid } from '../components/movies/MoviesGrid';
import { MoviesPill } from '../components/movies/MoviesPill';
import { SiteTitlesSection } from '../components/movies/SiteTitlesSection';
import { TrendingSection } from '../components/movies/TrendingSection';
import { UnmatchedList } from '../components/movies/UnmatchedList';
import { useNotice } from '../hooks/useNotice';
import type { MoviesStore } from '../hooks/useMovies';
import { askTrendingRefresh, errorCode, playSiteTitle, removeSiteTitle, saveTitleUser, startSync, streamPlay, type SiteTitle, type TitleListItem, type TrendingTitle } from '../moviesApi';
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
  undoMark,
  detailSide,
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
import { CACHE_ROUTE, NO_MOVIES_ROUTE, STREAM_ROUTE, type MoviesRoute } from '../lib/route';
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

/** How often the Stream side re-reads the list while a trending pass runs. */
const TRENDING_POLL_MS = 5000;

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

  // Where the grid was scrolled to, kept per side. It is recorded as the grid scrolls: by the time
  // a title's page has replaced the grid the browser has already clamped the offset to the shorter
  // page, so reading it then is too late. Coming back (the Back arrow, the browser's Back) scrolls
  // there again once the grid and the sections under it are tall enough (lib/scrollMemory).
  const isGrid = route.title === null && !route.unmatched && !route.cache;
  const scrollPos = useRef<{ library: number; stream: number }>({ library: 0, stream: 0 });
  const cameBack = useRef(false);
  useLayoutEffect(() => {
    if (!isGrid) {
      cameBack.current = true;
      return;
    }
    const pos = scrollPos.current;
    let restoring = false;
    let stopRestore = () => {};
    if (cameBack.current) {
      cameBack.current = false;
      if (pos[side] > 0) {
        restoring = true;
        stopRestore = restoreScroll(pos[side], () => {
          restoring = false;
        });
      }
    }
    const onScroll = () => {
      if (!restoring) pos[side] = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      stopRestore();
    };
  }, [isGrid, side]);

  const refreshStore = store.refresh;

  // The Trending section's refresh: a new list, now. The page asks again every few seconds while it runs.
  const [trendBusy, setTrendBusy] = useState(false);
  const trendRunning = trendBusy || store.trending?.enabled === true && store.trending.running;
  useEffect(() => {
    if (!trendRunning) return;
    const t = window.setInterval(() => refreshStore(), TRENDING_POLL_MS);
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
  // A title TMDB does not list plays on its streaming site again: there is no other source for it.
  const [siteBusy, setSiteBusy] = useState(false);
  const playOnSite = async (t: SiteTitle, episode?: number) => {
    setSiteBusy(true);
    show(`${t.name}: opening on ${t.site}`);
    try {
      const played = await playSiteTitle(t.id, episode);
      show(played.episode === null ? `${t.name}: playing on ${t.site} in the streaming Chrome window` : `${t.name}: episode ${played.episode} is playing on ${t.site} in the streaming Chrome window`);
    } catch (e) {
      show(errorCode(e) === 'no_episode' ? `${t.name}: ${t.site} lists no later episode yet` : `${t.name}: could not play on ${t.site} (${errorCode(e)})`);
    } finally {
      setSiteBusy(false);
      refreshStore();
    }
  };
  const removeFromSites = async (t: SiteTitle) => {
    try {
      await removeSiteTitle(t.id);
    } catch (e) {
      show(`${t.name}: could not take it off the list (${errorCode(e)})`);
    } finally {
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
    const back = undoMark(patch);
    const text =
      'watched' in patch
        ? patch.watched
          ? `${t.title}: watched${t.kind === 'tv' ? ', every season' : ''}, under finished`
          : `${t.title}: not watched`
        : 'interested' in patch
          ? patch.interested
            ? `${t.title}: interested, on the Stream side's interested list`
            : `${t.title}: off the interested list`
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
  // The Cache page's button: after the Films / Series buttons on the Stream grid, else in the toolbar.
  const onCache = route.cache === true;
  const cacheButton = (
    <button
      type="button"
      className={onCache ? 'ibtn on cp-cachebtn' : 'ibtn hov cp-cachebtn'}
      data-tip="Cache: what this machine keeps on disk for streaming"
      data-tip-side="below"
      aria-label="Cache"
      aria-pressed={onCache}
      disabled={off}
      onClick={() => onRoute(onCache ? STREAM_ROUTE : CACHE_ROUTE)}
    >
      <HardDrives weight="duotone" />
    </button>
  );
  const streamGrid = side === 'stream' && route.title === null && !onCache && !off && store.streamError === null && store.stream !== null && store.stream.enabled && store.stream.titles.length > 0;
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
    {side === 'stream' && !streamGrid && cacheButton}
    {(route.title !== null || route.unmatched || onCache) && (
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
  else if (onCache) content = <CachePage onOpen={(id) => onRoute({ title: id, unmatched: false, stream: true })} />;
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
          side={detailSide(side, detail)}
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
        <MoviesGrid side="stream" lead={sideSwitch} tail={tools} afterKinds={cacheButton} titles={withMarks(list.titles, marks)} player={store.player} filter={streamFilter} onFilter={setStreamFilter} onOpen={(id) => onRoute({ title: id, unmatched: false, stream: true })} onMark={(t, p) => void mark(t, p)} />
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
      {side === 'stream' && route.title === null && !route.unmatched && !onCache && !off && store.stream?.enabled === true && (
        <SiteTitlesSection titles={store.stream.site_titles ?? []} busy={siteBusy} onPlay={(t, episode) => void playOnSite(t, episode)} onRemove={(t) => void removeFromSites(t)} />
      )}
      {side === 'stream' && route.title === null && !route.unmatched && !onCache && !off && store.streamError === null && (
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
