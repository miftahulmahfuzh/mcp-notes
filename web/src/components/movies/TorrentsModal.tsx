import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowClockwise, ArrowUUpLeft, CircleNotch, Play, Prohibit, X } from '@phosphor-icons/react';
import { blacklistTorrent, fetchTorrentCandidates, unblacklistTorrent, type StreamRef, type TorrentCandidateView } from '../../moviesApi';
import './MovieModal.css';

export interface TorrentsModalProps {
  /** The film or episode the list is of (`what` names it: "Eternally Yours S01E07"). */
  target: StreamRef;
  what: string;
  /** Plays one torrent for the title, as a pasted magnet; the page shows the play's notice. */
  onPlay: (infoHash: string, name: string) => void;
  onClose: () => void;
}

/** Whether the torrent candidates list is open: its Esc closes it, not the pop-up under it. */
export const isTorrentsModalOpen = (): boolean => document.querySelector('[data-modal="torrents"]') !== null;

const HOW: Record<TorrentCandidateView['audio']['how'], string> = { heard: 'heard', tags: 'file tags', name: 'name says', unknown: 'unknown' };

function size(bytes: number | null): string | null {
  if (bytes === null) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** The row's facts, in one mono line: height, size, seeds (listed and scraped), where from, audio. */
export function candidateFacts(c: TorrentCandidateView): string[] {
  const seeds = [c.seeds === null ? null : `${c.seeds} listed`, c.scrape === null ? null : `${c.scrape.seeders} seeding`].filter((x) => x !== null).join(' · ');
  const audio = c.audio.languages.length === 0 ? 'audio unknown' : `audio ${c.audio.languages.join('+')} (${HOW[c.audio.how]})`;
  return [c.height === null ? 'other' : `${c.height}p`, size(c.size_bytes), seeds === '' ? null : `seeds ${seeds}`, c.from.join(', '), audio].filter((x): x is string => x !== null && x !== '');
}

/** The row's status tags: [label, kind, title]. */
export function candidateTags(c: TorrentCandidateView): Array<{ label: string; kind: 'good' | 'bad' | 'plain'; tip?: string }> {
  const tags: Array<{ label: string; kind: 'good' | 'bad' | 'plain'; tip?: string }> = [];
  if (c.remembered) tags.push({ label: 'played last', kind: 'plain', tip: 'Torrent Stream opens this one again first' });
  if (c.worked) tags.push({ label: 'worked', kind: 'good' });
  if (c.on_disk) tags.push({ label: 'on disk', kind: 'good' });
  if (c.failed !== null) tags.push({ label: 'failed', kind: 'bad', tip: c.failed });
  if (c.blacklisted !== null) tags.push({ label: 'blacklisted', kind: 'bad', ...(c.blacklisted.reason === null ? {} : { tip: c.blacklisted.reason }) });
  if (c.heard_dub) tags.push({ label: 'heard dub', kind: 'bad' });
  if (c.dub_group !== null) tags.push({ label: `dub group ${c.dub_group}`, kind: 'bad' });
  else if (c.dub_named) tags.push({ label: 'dub-named', kind: 'bad', tip: 'tried only after every other release' });
  if (c.left_out !== null) tags.push({ label: `left out: ${c.left_out.replace(/_/g, ' ')}`, kind: 'plain' });
  return tags;
}

/**
 * Every candidate torrent of a film or episode, opened from the play menu's Torrent stream row: what the indexes list
 * (their answer of the last ten minutes, or asked again with the refresh button), the torrents this machine opened
 * for it and the magnets pasted for it. Per row its facts and status, and two buttons: play that very torrent, and
 * blacklist it (for every title) or take it off the blacklist. Listing joins no swarm.
 */
export function TorrentsModal({ target, what, onPlay, onClose }: TorrentsModalProps) {
  const [rows, setRows] = useState<TorrentCandidateView[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (fresh: boolean) => {
      setLoading(true);
      try {
        const list = await fetchTorrentCandidates(target, fresh);
        setRows(list.candidates);
        setNote(list.original_language === null ? null : `original ${list.original_language}${list.cached ? ' · indexes asked earlier' : ''}`);
      } catch (e) {
        setNote(e instanceof Error ? `could not list the torrents: ${e.message}` : 'could not list the torrents');
      } finally {
        setLoading(false);
      }
    },
    [target],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const toggle = async (c: TorrentCandidateView) => {
    setBusy(c.info_hash);
    try {
      if (c.blacklisted === null) await blacklistTorrent(c.info_hash, c.dub_group !== null ? `dub group ${c.dub_group}` : c.heard_dub ? 'heard as a dub' : null, c.name);
      else await unblacklistTorrent(c.info_hash);
      await load(false);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'the blacklist could not be changed');
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="mm" data-modal="torrents" onClick={onClose}>
      <div className="mm-panel mm-torrents" role="dialog" aria-label={`Torrents of ${what}`} onClick={(e) => e.stopPropagation()}>
        <header className="mm-head">
          <span className="mm-notice">
            torrents · {what}
            {note !== null && <span className="mt-note"> · {note}</span>}
          </span>
          <span className="mm-head-actions">
            <button type="button" className="ibtn hov" data-tip="Ask the indexes again" data-tip-side="below" aria-label="Ask the indexes again" disabled={loading} onClick={() => void load(true)}>
              {loading ? <CircleNotch weight="bold" className="mm-spin" /> : <ArrowClockwise weight="duotone" />}
            </button>
            <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
              <X weight="duotone" />
            </button>
          </span>
        </header>
        {rows === null ? (
          <p className="mm-empty">{loading ? 'asking the torrent indexes…' : 'nothing could be listed'}</p>
        ) : rows.length === 0 ? (
          <p className="mm-empty">no torrent of {what} is listed, played or pasted</p>
        ) : (
          <ul className="mt-list">
            {rows.map((c) => (
              <li key={c.info_hash} className={c.blacklisted !== null ? 'mt-row out' : 'mt-row'} data-hash={c.info_hash}>
                <span className="mt-main">
                  <span className="mt-name" title={c.info_hash}>
                    {c.name}
                  </span>
                  <span className="mt-facts">{candidateFacts(c).join(' · ')}</span>
                  <span className="mt-tags">
                    {candidateTags(c).map((t) => (
                      <span key={t.label} className={`mt-tag ${t.kind}`} title={t.tip}>
                        {t.label}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="mt-acts">
                  <button
                    type="button"
                    className="ibtn hov"
                    data-tip="Play this one"
                    aria-label={`Play ${c.name}`}
                    disabled={c.blacklisted !== null || busy !== null}
                    onClick={() => onPlay(c.info_hash, c.name)}
                  >
                    <Play weight="duotone" />
                  </button>
                  <button
                    type="button"
                    className="ibtn hov"
                    data-tip={c.blacklisted === null ? 'Blacklist, for every title' : 'Take off the blacklist'}
                    aria-label={c.blacklisted === null ? `Blacklist ${c.name}` : `Take ${c.name} off the blacklist`}
                    disabled={busy !== null}
                    onClick={() => void toggle(c)}
                  >
                    {busy === c.info_hash ? <CircleNotch weight="bold" className="mm-spin" /> : c.blacklisted === null ? <Prohibit weight="duotone" /> : <ArrowUUpLeft weight="duotone" />}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
