import { useEffect, useRef, useState } from 'react';
import { CaretDown, Cloud, DownloadSimple, ListMagnifyingGlass, Magnet, X } from '@phosphor-icons/react';
import { cancelDownload, errorCode, requestDownload, type DownloadVia, type DownloadView, type TitleDetail } from '../../moviesApi';
import { downloadBody, downloadErrorText, downloadName, downloadNotice, downloadRef, downloadStatus, downloadTip, type DownloadScope } from '../../lib/downloads';
import { TorrentsModal } from './TorrentsModal';

/** The page's downloads, handed to every Download button on it (MovieDetail reads them once for the whole page). */
export interface DownloadsBinding {
  rows: readonly DownloadView[];
  onNotice: (text: string) => void;
  /** Read the downloads again now (after a click or a cancel). */
  onChanged: () => void;
}

/** `page`: an ibtn beside a film's Play; `season`: a pbtn on a season head; `row`: a pbtn in an episode row (its menu opens to the left). */
export type DownloadSize = 'page' | 'season' | 'row';

export interface DownloadButtonProps extends DownloadsBinding {
  detail: TitleDetail;
  scope: DownloadScope;
  size: DownloadSize;
}

/**
 * Download a film, a season or an episode to this machine's stream store (Stream side only). The
 * click asks for it with no source named (`via: auto`: a 1080p torrent with live seeds, else a cloud
 * provider, else a lower torrent). The caret names the source by hand: the best torrent, a cloud
 * provider, or one torrent picked from the candidates list (a film or an episode). While its
 * download is queued, running or paused a thin bar shows its progress (a season's: the mean of its
 * episodes) and an X cancels it; once whole the icon is filled; a failure says why, and a click asks again.
 */
export function DownloadButton({ detail: d, scope, rows, size, onNotice, onChanged }: DownloadButtonProps) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open]);

  const name = downloadName(d, scope);
  const status = downloadStatus(d, scope, rows);
  const tip = downloadTip(name, status);
  const menuLabel = `Choose how to download ${name}`;
  const ref = downloadRef(d, scope);
  const page = size === 'page';
  const btn = page ? 'ibtn' : 'pbtn';
  const side = page ? 'below' : undefined;
  const pct = status.state === 'active' ? Math.round(status.progress * 100) : null;
  const barClass = status.state === 'active' && status.phase !== 'running' ? `mv-dl-bar ${status.phase}` : 'mv-dl-bar';

  const send = async (via: DownloadVia, infoHash: string | null = null) => {
    setOpen(false);
    setSending(true);
    try {
      const queued = await requestDownload(downloadBody(d, scope, via, infoHash));
      onNotice(downloadNotice(name, via, queued));
    } catch (e) {
      onNotice(`could not download ${name}: ${downloadErrorText(errorCode(e))}`);
    } finally {
      setSending(false);
      onChanged();
    }
  };

  const cancel = async () => {
    if (status.state !== 'active') return;
    try {
      await Promise.all(status.ids.map((id) => cancelDownload(id)));
      onNotice(`${name}: download cancelled`);
    } catch (e) {
      onNotice(`could not cancel the download of ${name}: ${downloadErrorText(errorCode(e))}`);
    } finally {
      onChanged();
    }
  };

  const click = () => {
    if (status.state === 'here') onNotice(`${name} is already on this machine`);
    // A season with an episode already downloading still asks for the season (R2.1: every aired episode not whole
    // here); the daemon leaves out what is queued or whole. A film or an episode that downloads is only read again.
    else if (status.state === 'active' && scope.kind !== 'season') onChanged();
    else void send('auto');
  };

  return (
    <span className={`mv-dl ${size}`} ref={box} data-download={status.state}>
      <button
        type="button"
        className={`${btn} ${status.state === 'here' ? 'on' : 'hov'}${status.state === 'failed' ? ' mv-dl-failed' : ''}`}
        data-tip={open ? undefined : tip}
        data-tip-side={side}
        aria-label={`Download ${name}`}
        disabled={sending}
        onClick={click}
      >
        <DownloadSimple weight={status.state === 'here' ? 'fill' : 'duotone'} />
      </button>
      <button
        type="button"
        className={`${btn} hov mv-menu-btn`}
        data-tip={open ? undefined : menuLabel}
        data-tip-side={side}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={sending}
        onClick={() => setOpen((o) => !o)}
      >
        <CaretDown weight="bold" />
      </button>
      {status.state === 'active' && (
        <button type="button" className={`${btn} hov mv-dl-cancel`} data-tip={`Cancel the download of ${name}`} data-tip-side={side} aria-label={`Cancel the download of ${name}`} onClick={() => void cancel()}>
          <X weight="bold" />
        </button>
      )}
      {pct !== null && (
        <span className={barClass} role="progressbar" aria-label={`Download of ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {open && (
        <span className={size === 'row' ? 'mv-menu-list right' : 'mv-menu-list'} role="menu" aria-label={menuLabel}>
          <span className="mv-menu-head">{menuLabel}</span>
          <button type="button" role="menuitem" className="mv-menu-item" data-via="torrent" onClick={() => void send('torrent')}>
            <Magnet weight="duotone" />
            <span className="mv-menu-t">
              <span className="mv-menu-label">Best torrent (1080p)</span>
              <span className="mv-menu-hint">a torrent only: the 1080p release with live seeds, a lower one when there is none</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="mv-menu-item" data-via="cloud" onClick={() => void send('cloud')}>
            <Cloud weight="duotone" />
            <span className="mv-menu-t">
              <span className="mv-menu-label">Cloud</span>
              <span className="mv-menu-hint">a cloud provider at 1080p or lower, never a torrent</span>
            </span>
          </button>
          {ref !== null && (
            <button
              type="button"
              role="menuitem"
              className="mv-menu-item"
              data-via="pick"
              onClick={() => {
                setOpen(false);
                setPicking(true);
              }}
            >
              <ListMagnifyingGlass weight="duotone" />
              <span className="mv-menu-t">
                <span className="mv-menu-label">Pick a torrent…</span>
                <span className="mv-menu-hint">every torrent of {name}: the one picked, and no other</span>
              </span>
            </button>
          )}
        </span>
      )}
      {picking && ref !== null && (
        <TorrentsModal
          target={ref}
          what={name}
          onDownload={(infoHash) => {
            setPicking(false);
            void send('torrent', infoHash);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </span>
  );
}
