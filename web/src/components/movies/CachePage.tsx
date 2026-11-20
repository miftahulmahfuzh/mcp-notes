import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowSquareOut, Broom, CaretDown, CaretRight, CheckCircle, Cloud, EyeSlash, FilmSlate, MagnetStraight, Trash } from '@phosphor-icons/react';
import { deleteStreamDisk, errorCode, fetchStreamDisk, undoStreamDisk, type DiskDeletion, type DiskEpisode, type DiskKind, type DiskScope, type DiskSeason, type DiskTitle, type DiskView } from '../../moviesApi';
import './CachePage.css';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** "154 MB", "4.2 GB": the daemon's own wording. */
export function sizeText(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / MIB))} MB`;
}

const gb = (bytes: number): string => (bytes / GIB).toFixed(1);

/** "41.2 of 40 GB · torrents 35.8 · cloud 5.4". */
export function totalLine(v: DiskView): string {
  const of = v.budget_bytes === null ? `${gb(v.total_bytes)} GB` : `${gb(v.total_bytes)} of ${Math.round(v.budget_bytes / GIB)} GB`;
  return `${of} · torrents ${gb(v.torrent_bytes)} · cloud ${gb(v.cloud_bytes)}`;
}

const sxe = (s: number, e?: number): string => `S${String(s).padStart(2, '0')}${e === undefined ? '' : `E${String(e).padStart(2, '0')}`}`;

/** The key a row is hidden under while its deletion is on its way. */
const keyOf = (scope: DiskScope): string => ('bulk' in scope ? `bulk:${scope.bulk}` : [scope.title_id, scope.season, scope.episode].filter((x) => x !== undefined).join(':'));

/** How often the page reads the disk again while it is open (a play that started or stopped, a download that grew). */
const REFRESH_MS = 15_000;

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
      {inUse && <span className="mv-chip cp-tag cp-live">{playing ? 'playing' : 'in use'}</span>}
    </span>
  );
}

function TrashButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  const tip = disabled ? `${label}: in use now` : `Delete ${label}`;
  return (
    <button type="button" className="ibtn hov cp-trash" data-tip={tip} data-tip-side="left" aria-label={tip} disabled={disabled} onClick={onClick}>
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
 * The Cache page (`/movies/cache`): everything this machine keeps on disk for streaming, largest first. A series unfolds
 * to its seasons and a season to its episodes. Every trash button and both bulk buttons delete with no confirmation:
 * the rows go at once and a toast offers Undo while the daemon waits out its window (`undo_ms`).
 */
export function CachePage({ onOpen }: CachePageProps) {
  const [view, setView] = useState<DiskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const v = await fetchStreamDisk();
      setView(v);
      setError(null);
      setHidden(new Set());
    } catch (e) {
      setError(errorCode(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = (t: Toast, ms: number) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
    const titles = view.titles.filter((t) => visible({ title_id: t.title_id }));
    body = (
      <>
        <div className="cp-head">
          <span className={view.budget_bytes !== null && view.total_bytes > view.budget_bytes ? 'cp-total over' : 'cp-total'} data-testid="cp-total">
            {totalLine(view)}
          </span>
          <div className="cp-bulk">
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
          <p className="mv-empty">Nothing is kept on this machine for streaming.</p>
        ) : (
          <ul className="cp-list" aria-label="Titles on disk">
            {titles.map((t) => (
              <TitleRow key={t.title_id} t={t} open={open} toggle={toggle} visible={visible} remove={(s) => void remove(s)} onOpen={onOpen} />
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
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
  visible: (scope: DiskScope) => boolean;
  remove: (scope: DiskScope) => void;
}

function TitleRow({ t, open, toggle, visible, remove, onOpen }: RowProps & { t: DiskTitle; onOpen: (id: string) => void }) {
  const isOpen = open.has(t.title_id);
  const seasons = t.seasons.filter((s) => visible({ title_id: t.title_id, season: s.season }));
  const name = t.year === null ? t.title : `${t.title} (${t.year})`;
  return (
    <li className="cp-title" data-title={t.title_id}>
      <div className="cp-row">
        {t.kind === 'tv' ? <Caret open={isOpen} label={t.title} onClick={() => toggle(t.title_id)} /> : <span className="cp-caret-gap" />}
        {t.poster_url !== null ? <img className="cp-poster" src={t.poster_url} alt="" loading="lazy" /> : <span className="cp-poster cp-noposter"><FilmSlate weight="duotone" /></span>}
        <span className="cp-name">{name}</span>
        <Kinds kinds={t.kinds} />
        <Tags watched={t.watched} notInterested={t.not_interested} playing={t.playing} inUse={t.in_use} />
        <span className="cp-size">{sizeText(t.bytes)}</span>
        {t.stored ? (
          <button type="button" className="ibtn hov" data-tip="Go to the title page" data-tip-side="left" aria-label={`Open ${t.title}`} onClick={() => onOpen(t.movie_id ?? t.title_id)}>
            <ArrowSquareOut weight="duotone" />
          </button>
        ) : (
          <span className="cp-btn-gap" />
        )}
        <TrashButton label={t.title} disabled={t.in_use} onClick={() => remove({ title_id: t.title_id })} />
      </div>
      {t.kind === 'tv' && isOpen && (
        <ul className="cp-seasons" aria-label={`${t.title} seasons`}>
          {seasons.map((s) => (
            <SeasonRow key={s.season} t={t} s={s} open={open} toggle={toggle} visible={visible} remove={remove} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SeasonRow({ t, s, open, toggle, visible, remove }: RowProps & { t: DiskTitle; s: DiskSeason }) {
  const key = `${t.title_id}:${s.season}`;
  const isOpen = open.has(key);
  const episodes = s.episodes.filter((e) => visible({ title_id: t.title_id, season: e.season, episode: e.episode }));
  return (
    <li className="cp-season" data-season={s.season}>
      <div className="cp-row">
        <Caret open={isOpen} label={`season ${s.season}`} onClick={() => toggle(key)} />
        <span className="cp-name">Season {s.season}</span>
        <Kinds kinds={s.kinds} />
        <Tags watched={s.watched} playing={s.playing} inUse={s.in_use} />
        <span className="cp-size" data-tip={s.shared_bytes > 0 ? `${sizeText(s.shared_bytes)} the season's episodes share` : undefined}>
          {sizeText(s.bytes)}
        </span>
        <span className="cp-btn-gap" />
        <TrashButton label={`${t.title} ${sxe(s.season)}`} disabled={s.in_use} onClick={() => remove({ title_id: t.title_id, season: s.season })} />
      </div>
      {isOpen && (
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
        <span className="cp-size">{sizeText(e.bytes)}</span>
        <span className="cp-btn-gap" />
        <TrashButton label={`${t.title} ${sxe(e.season, e.episode)}`} disabled={e.in_use} onClick={() => remove({ title_id: t.title_id, season: e.season, episode: e.episode })} />
      </div>
    </li>
  );
}
