import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowSquareOut, Broom, CaretDown, CaretRight, CheckCircle, Cloud, DownloadSimple, EyeSlash, FilmSlate, MagnetStraight, Trash } from '@phosphor-icons/react';
import {
  deleteStreamDisk,
  errorCode,
  fetchStreamDisk,
  undoStreamDisk,
  type DiskDeletion,
  type DiskDownloadState,
  type DiskEpisode,
  type DiskKind,
  type DiskScope,
  type DiskSeason,
  type DiskTitle,
  type DiskView,
  type DiskWhy,
} from '../../moviesApi';
import './CachePage.css';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** "154 MB", "4.2 GB": the daemon's own wording. */
export function sizeText(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / MIB))} MB`;
}

const gb = (bytes: number): string => (bytes / GIB).toFixed(1);

/** "41.2 of 40 GB · torrents 35.8 · cloud 5.4"; under a gigabyte in all, every figure in its own unit ("154 MB of 40 GB · torrents 120 MB · cloud 34 MB"). */
export function totalLine(v: DiskView): string {
  const budget = v.budget_bytes === null ? null : `${Math.round(v.budget_bytes / GIB)} GB`;
  if (v.total_bytes < GIB) {
    return `${sizeText(v.total_bytes)}${budget === null ? '' : ` of ${budget}`} · torrents ${sizeText(v.torrent_bytes)} · cloud ${sizeText(v.cloud_bytes)}`;
  }
  return `${gb(v.total_bytes)}${budget === null ? ' GB' : ` of ${budget}`} · torrents ${gb(v.torrent_bytes)} · cloud ${gb(v.cloud_bytes)}`;
}

const sxe = (s: number, e?: number): string => `S${String(s).padStart(2, '0')}${e === undefined ? '' : `E${String(e).padStart(2, '0')}`}`;

/** The key a row is hidden under while its deletion is on its way. */
const keyOf = (scope: DiskScope): string => ('bulk' in scope ? `bulk:${scope.bulk}` : [scope.title_id, scope.season, scope.episode].filter((x) => x !== undefined).join(':'));

/** How often the page reads the disk again while it is open (a play that started or stopped, a download that grew). */
const REFRESH_MS = 15_000;
/** How often while anything downloads: the bars move. */
export const FAST_REFRESH_MS = 3_000;

const WHY_TIP: Record<DiskWhy, string> = {
  asked: 'You asked for this download (a Download button or direct_stream_cache): it is kept until you delete it',
  ahead: 'The next episode, fetched while this one plays',
  pause: 'Cached on a pause in the player',
};
const STATE_TEXT: Record<DiskDownloadState, string> = {
  running: 'downloading',
  queued: 'waiting its turn',
  paused: 'paused while a torrent plays',
};

const flip = (prev: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

interface Toast {
  text: string;
  deletion: DiskDeletion | null;
}

export interface CachePageProps {
  /** Open a title's page on the Stream side. */
  onOpen: (id: string) => void;
}

function Kinds({ kinds }: { kinds: DiskKind[] }) {
  return (
    <span className="cp-kinds">
      {kinds.includes('torrent') && (
        <span className="cp-kind" data-tip="Torrent download" aria-label="torrent">
          <MagnetStraight weight="duotone" />
        </span>
      )}
      {kinds.includes('cloud') && (
        <span className="cp-kind" data-tip="Cloud stream cache" aria-label="cloud">
          <Cloud weight="duotone" />
        </span>
      )}
    </span>
  );
}

function Tags({ watched, notInterested = false, playing, inUse }: { watched: boolean; notInterested?: boolean; playing: boolean; inUse: boolean }) {
  return (
    <span className="cp-tags">
      {watched && <span className="mv-chip cp-tag">watched</span>}
      {notInterested && <span className="mv-chip cp-tag">not interested</span>}
      {inUse && (
        <span className="mv-chip cp-tag cp-live" data-tip={playing ? 'Playing on screen now: it cannot be deleted until the play ends' : 'Being fetched now (a download, the next episode, or a torrent held open): it cannot be deleted until that stops'}>
          {playing ? 'playing' : 'in use'}
        </span>
      )}
    </span>
  );
}

/** Why a row downloads (one chip per reason), and how far it is: a bar the page refreshes every 3 s. */
function Downloading({ d, label }: { d: { progress: number; state: DiskDownloadState; why: DiskWhy | DiskWhy[] }; label: string }) {
  const pct = Math.round(d.progress * 100);
  const why = Array.isArray(d.why) ? d.why : [d.why];
  return (
    <span className="cp-dl" data-state={d.state}>
      {why.map((w) => (
        <span key={w} className="mv-chip cp-tag cp-why" data-why={w} data-tip={WHY_TIP[w]}>
          {w}
        </span>
      ))}
      <span className="mv-meter-bar cp-bar" role="progressbar" aria-label={`${label} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-tip={`${pct}% · ${STATE_TEXT[d.state]}`}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="cp-pct">{pct}%</span>
    </span>
  );
}

function TrashButton({ label, disabled, empty = false, onClick }: { label: string; disabled: boolean; empty?: boolean; onClick: () => void }) {
  const tip = empty ? `${label}: nothing on disk yet` : disabled ? `${label}: in use now` : `Delete ${label}`;
  return (
    <button type="button" className="ibtn hov cp-trash" data-tip={tip} aria-label={tip} disabled={disabled || empty} onClick={onClick}>
      <Trash weight="duotone" />
    </button>
  );
}

function Caret({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  const tip = open ? `Fold ${label}` : `Unfold ${label}`;
  return (
    <button type="button" className="ibtn hov cp-caret" aria-label={tip} aria-expanded={open} data-tip={tip} data-tip-side="right" onClick={onClick}>
      {open ? <CaretDown weight="bold" /> : <CaretRight weight="bold" />}
    </button>
  );
}

/**
 * The Cache page (`/movies/cache`): everything this machine keeps on disk for streaming, largest first, and what is
 * downloading to it, each with a bar and why it downloads. A series unfolds to its seasons and a season to its episodes.
 * The Downloading toggle lists only what downloads now, unfolded; clicked again it is the default view. Every trash button
 * and both bulk buttons delete with no confirmation: the rows go at once and a toast offers Undo while the daemon waits
 * out its window (`undo_ms`).
 */
export function CachePage({ onOpen }: CachePageProps) {
  const [view, setView] = useState<DiskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The default view: what is unfolded (everything is folded at first). */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** The Downloading view: what is folded (everything is unfolded at first). */
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const [only, setOnly] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  /** Bumped by every read: only the newest read's answer is shown. */
  const readSeq = useRef(0);
  const load = useCallback(async () => {
    // The timer never awaits a read, so two can overlap (a slow disk, a busy daemon). One that answers
    // after a newer one started is stale: it would put back an older view, and with it the old pace.
    const seq = ++readSeq.current;
    try {
      const v = await fetchStreamDisk();
      if (seq !== readSeq.current) return;
      setView(v);
      setError(null);
      setHidden(new Set());
    } catch (e) {
      if (seq === readSeq.current) setError(errorCode(e));
    }
  }, []);

  const fast = (view?.downloading ?? 0) > 0;
  useEffect(() => {
    void load();
  }, [load]);
  // A layout effect: the pace changes in the same commit as the "Downloading · N" it follows. A passive
  // effect runs some time after the screen already shows the new count (React's scheduler, setImmediate
  // in Node), so for that moment the old pace still ran; a test that read the screen and then moved the
  // clock saw no read on a loaded machine.
  useLayoutEffect(() => {
    const t = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') void load();
      },
      fast ? FAST_REFRESH_MS : REFRESH_MS,
    );
    return () => window.clearInterval(t);
  }, [load, fast]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = (t: Toast, ms: number) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  const isOpen = (key: string): boolean => (only ? !shut.has(key) : open.has(key));
  const toggle = (key: string) => {
    if (only) setShut((prev) => flip(prev, key));
    else setOpen((prev) => flip(prev, key));
  };

  const remove = async (scope: DiskScope) => {
    const key = keyOf(scope);
    setHidden((prev) => new Set(prev).add(key));
    try {
      const deletion = await deleteStreamDisk(scope);
      showToast({ text: `Deleted ${deletion.label} · ${sizeText(deletion.bytes)}`, deletion }, view?.undo_ms ?? 10_000);
    } catch (e) {
      const code = errorCode(e);
      showToast({ text: code === 'in_use' ? 'It plays or is being fetched now: kept' : `Could not delete (${code})`, deletion: null }, 6000);
    } finally {
      await load();
    }
  };

  const undo = async (d: DiskDeletion) => {
    setToast(null);
    try {
      await undoStreamDisk(d.id);
      showToast({ text: `Kept ${d.label}`, deletion: null }, 4000);
    } catch (e) {
      showToast({ text: errorCode(e) === 'unknown_deletion' ? `${d.label} is deleted already` : `Could not undo (${errorCode(e)})`, deletion: null }, 6000);
    } finally {
      await load();
    }
  };

  const visible = (scope: DiskScope): boolean => {
    const key = keyOf(scope);
    for (const h of hidden) if (key === h || key.startsWith(`${h}:`)) return false;
    return true;
  };

  let body;
  if (error !== null) body = <p className="mv-empty">{error === 'stream_disk_off' ? 'Neither torrents nor the stream cache are on on this machine.' : `Could not read the cache (${error}).`}</p>;
  else if (view === null) body = <p className="mv-empty">reading the disk</p>;
  else {
    const titles = view.titles.filter((t) => visible({ title_id: t.title_id }) && (!only || t.downloading !== null));
    const filterLabel = `Downloading · ${view.downloading}`;
    body = (
      <>
        <div className="cp-head">
          <span className={view.budget_bytes !== null && view.total_bytes > view.budget_bytes ? 'cp-total over' : 'cp-total'} data-testid="cp-total">
            {totalLine(view)}
          </span>
          <div className="cp-bulk">
            <button
              type="button"
              className={only ? 'ibtn on cp-bulkbtn' : 'ibtn hov cp-bulkbtn'}
              data-tip={only ? `${filterLabel} · show everything` : `${filterLabel} · show only these`}
              data-tip-side="below"
              aria-label={filterLabel}
              aria-pressed={only}
              disabled={!only && view.downloading === 0}
              onClick={() => setOnly((x) => !x)}
            >
              <DownloadSimple weight="duotone" />
              <span className="cp-n">{view.downloading}</span>
            </button>
            <button
              type="button"
              className="ibtn hov cp-bulkbtn"
              data-tip={`Delete Watched · ${sizeText(view.bulk.watched.bytes)}`}
              data-tip-side="below"
              aria-label={`Delete Watched · ${sizeText(view.bulk.watched.bytes)}`}
              disabled={view.bulk.watched.bytes <= 0 || hidden.has('bulk:watched')}
              onClick={() => void remove({ bulk: 'watched' })}
            >
              <CheckCircle weight="duotone" />
              <Broom weight="duotone" />
              <span className="cp-n">{sizeText(view.bulk.watched.bytes)}</span>
            </button>
            <button
              type="button"
              className="ibtn hov cp-bulkbtn"
              data-tip={`Delete Not interested · ${sizeText(view.bulk.not_interested.bytes)}`}
              data-tip-side="below"
              aria-label={`Delete Not interested · ${sizeText(view.bulk.not_interested.bytes)}`}
              disabled={view.bulk.not_interested.bytes <= 0 || hidden.has('bulk:not_interested')}
              onClick={() => void remove({ bulk: 'not_interested' })}
            >
              <EyeSlash weight="duotone" />
              <Broom weight="duotone" />
              <span className="cp-n">{sizeText(view.bulk.not_interested.bytes)}</span>
            </button>
          </div>
        </div>
        {titles.length === 0 ? (
          <p className="mv-empty">{only ? 'Nothing downloads now.' : 'Nothing is kept on this machine for streaming.'}</p>
        ) : (
          <ul className="cp-list" aria-label="Titles on disk">
            {titles.map((t) => (
              <TitleRow key={t.title_id} t={t} isOpen={isOpen} toggle={toggle} visible={visible} remove={(s) => void remove(s)} only={only} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="cp mv-content" aria-label="Cache">
      {body}
      {toast !== null && (
        <div className="cp-toast" role="status">
          <span>{toast.text}</span>
          {toast.deletion !== null && (
            <button type="button" className="mv-undo" onClick={() => void undo(toast.deletion!)}>
              Undo
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface RowProps {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  visible: (scope: DiskScope) => boolean;
  remove: (scope: DiskScope) => void;
  /** The Downloading view: only rows that download now. */
  only: boolean;
}

function TitleRow({ t, isOpen, toggle, visible, remove, only, onOpen }: RowProps & { t: DiskTitle; onOpen: (id: string) => void }) {
  const unfolded = isOpen(t.title_id);
  const seasons = t.seasons.filter((s) => visible({ title_id: t.title_id, season: s.season }) && (!only || s.downloading !== null));
  const name = t.year === null ? t.title : `${t.title} (${t.year})`;
  return (
    <li className="cp-title" data-title={t.title_id}>
      <div className="cp-row">
        {t.kind === 'tv' ? <Caret open={unfolded} label={t.title} onClick={() => toggle(t.title_id)} /> : <span className="cp-caret-gap" />}
        {t.poster_url !== null ? <img className="cp-poster" src={t.poster_url} alt="" loading="lazy" /> : <span className="cp-poster cp-noposter"><FilmSlate weight="duotone" /></span>}
        <span className="cp-name">{name}</span>
        <Kinds kinds={t.kinds} />
        <Tags watched={t.watched} notInterested={t.not_interested} playing={t.playing} inUse={t.in_use} />
        {t.downloading !== null && <Downloading d={t.downloading} label={t.title} />}
        <span className="cp-size">{sizeText(t.bytes)}</span>
        {t.stored ? (
          <button type="button" className="ibtn hov" data-tip="Go to the title page" aria-label={`Open ${t.title}`} onClick={() => onOpen(t.movie_id ?? t.title_id)}>
            <ArrowSquareOut weight="duotone" />
          </button>
        ) : (
          <span className="cp-btn-gap" />
        )}
        <TrashButton label={t.title} disabled={t.in_use} empty={t.bytes === 0} onClick={() => remove({ title_id: t.title_id })} />
      </div>
      {t.kind === 'tv' && unfolded && (
        <ul className="cp-seasons" aria-label={`${t.title} seasons`}>
          {seasons.map((s) => (
            <SeasonRow key={s.season} t={t} s={s} isOpen={isOpen} toggle={toggle} visible={visible} remove={remove} only={only} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SeasonRow({ t, s, isOpen, toggle, visible, remove, only }: RowProps & { t: DiskTitle; s: DiskSeason }) {
  const key = `${t.title_id}:${s.season}`;
  const unfolded = isOpen(key);
  const episodes = s.episodes.filter((e) => visible({ title_id: t.title_id, season: e.season, episode: e.episode }) && (!only || e.downloading !== null));
  return (
    <li className="cp-season" data-season={s.season}>
      <div className="cp-row">
        <Caret open={unfolded} label={`season ${s.season}`} onClick={() => toggle(key)} />
        <span className="cp-name">Season {s.season}</span>
        <Kinds kinds={s.kinds} />
        <Tags watched={s.watched} playing={s.playing} inUse={s.in_use} />
        {s.downloading !== null && <Downloading d={s.downloading} label={`${t.title} ${sxe(s.season)}`} />}
        <span className="cp-size" data-tip={s.shared_bytes > 0 ? `${sizeText(s.shared_bytes)} the season's episodes share` : undefined}>
          {sizeText(s.bytes)}
        </span>
        <span className="cp-btn-gap" />
        <TrashButton label={`${t.title} ${sxe(s.season)}`} disabled={s.in_use} empty={s.bytes === 0} onClick={() => remove({ title_id: t.title_id, season: s.season })} />
      </div>
      {unfolded && (
        <ul className="cp-episodes" aria-label={`Season ${s.season} episodes`}>
          {episodes.map((e) => (
            <EpisodeRow key={e.episode} t={t} e={e} remove={remove} />
          ))}
        </ul>
      )}
    </li>
  );
}

function EpisodeRow({ t, e, remove }: { t: DiskTitle; e: DiskEpisode; remove: (scope: DiskScope) => void }) {
  return (
    <li className="cp-episode" data-episode={e.episode}>
      <div className="cp-row">
        <span className="cp-caret-gap" />
        <span className="cp-name">
          <span className="cp-sxe">{sxe(e.season, e.episode)}</span>
          {e.name !== null && <span className="cp-epname">{e.name}</span>}
        </span>
        <Kinds kinds={e.kinds} />
        <Tags watched={e.watched} playing={e.playing} inUse={e.in_use} />
        {e.downloading !== null && <Downloading d={e.downloading} label={`${t.title} ${sxe(e.season, e.episode)}`} />}
        <span className="cp-size">{sizeText(e.bytes)}</span>
        <span className="cp-btn-gap" />
        <TrashButton label={`${t.title} ${sxe(e.season, e.episode)}`} disabled={e.in_use} empty={e.bytes === 0} onClick={() => remove({ title_id: t.title_id, season: e.season, episode: e.episode })} />
      </div>
    </li>
  );
}
