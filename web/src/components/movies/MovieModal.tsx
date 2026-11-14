import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, Play, X } from '@phosphor-icons/react';
import { continueTitle, errorCode, errorDetail, fetchMovie, fetchPlayer, playFile, type PlayerState, type TitleDetail } from '../../moviesApi';
import {
  continueNotice,
  episodeByMovieId,
  episodeCode,
  filePlayLabel,
  kindLabel,
  moviesErrorText,
  playErrorText,
  playLabel,
  playPlan,
  primaryFile,
  releaseText,
  runtimeText,
  seasonsText,
  startedNotice,
  STATE_LABEL,
  type PlayButtonState,
} from '../../lib/movies';
import { isConfirmOpen } from '../ConfirmDialog';
import { isLightboxOpen } from '../Lightbox';
import { isEditorOpen } from '../NoteEditor';
import { Poster } from './Poster';
import './MovieModal.css';

export interface MovieModalProps {
  /** The movie id clicked in chat text, canonical (`M-23T4`): a title, or one episode of a series. */
  movieId: string;
  onClose: () => void;
  /** The top-right button: the title's page, scrolled to the episode when the id is an episode's. */
  onOpenPage: (movieId: string) => void;
}

/**
 * A movie id clicked in chat (`M-23T4`): what it names, with Play, as a pop-up over the current
 * page, the way a node id opens the node pop-up. An episode's id shows that episode and plays it.
 * Esc and a click outside close it, except while the editor, a lightbox or a confirm is up.
 */
export function MovieModal({ movieId, onClose, onOpenPage }: MovieModalProps) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setDetail(null);
    setError(null);
    setNotice(null);
    fetchMovie(movieId, ac.signal).then(
      (d) => {
        if (!ac.signal.aborted) setDetail(d);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setError(errorCode(e));
      },
    );
    fetchPlayer(ac.signal).then(
      (p) => {
        if (!ac.signal.aborted) setPlayer(p);
      },
      () => {},
    );
    return () => ac.abort();
  }, [movieId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isEditorOpen() || isLightboxOpen() || isConfirmOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const episode = detail === null ? null : episodeByMovieId(detail, movieId);
  const code = episode === null ? null : episodeCode(episode.season, episode.episode);
  const file = episode === null ? null : primaryFile(episode);
  const plan = detail === null ? null : playPlan(detail);
  let play: PlayButtonState = { label: 'Loading', disabled: true };
  if (detail !== null && plan !== null) {
    if (episode === null) play = playLabel(plan, player);
    else play = file !== null ? filePlayLabel(file, player, code ?? 'this episode') : { label: `${code} has no file`, disabled: true };
  }

  const start = async () => {
    if (detail === null || plan === null) return;
    setBusy(true);
    try {
      if (episode !== null) {
        if (file === null) return;
        await playFile(file.id);
        setNotice(startedNotice(file));
      } else if (plan.kind === 'continue') {
        setNotice(continueNotice(await continueTitle(detail.id)));
      } else if (plan.kind === 'file') {
        await playFile(plan.file.id);
        setNotice(startedNotice(plan.file));
      }
    } catch (e) {
      setNotice(playErrorText(errorCode(e), errorDetail(e)));
    } finally {
      setBusy(false);
    }
  };

  const facts =
    detail === null
      ? []
      : episode !== null
        ? [code ?? '', episode.air_date !== null ? `Aired ${releaseText(episode.air_date)}` : '', episode.runtime_min !== null ? runtimeText(episode.runtime_min) : ''].filter((s) => s !== '')
        : [
            detail.release_date !== null ? `Released ${releaseText(detail.release_date)}` : detail.year !== null ? String(detail.year) : '',
            detail.kind === 'tv' ? seasonsText(detail.season_count) : runtimeText(detail.runtime_min),
            detail.genres.join(', '),
          ].filter((s) => s !== '');
  const state = detail === null ? null : episode !== null ? episode.state : detail.state;
  const overview = detail === null ? '' : episode !== null ? (episode.overview ?? '') : detail.overview;
  const name = detail === null ? movieId : `${detail.title}${detail.year !== null ? ` (${detail.year})` : ''}`;

  return createPortal(
    <div className="mm" data-modal="movie" onClick={onClose}>
      <div className="mm-panel" role="dialog" aria-label={`Movie ${movieId}`} data-movie-id={movieId} onClick={(e) => e.stopPropagation()}>
        <header className="mm-head">
          <span className="mv-code" data-testid="movie-modal-id">
            {movieId}
          </span>
          <span className="mm-head-actions">
            <button
              type="button"
              className="ibtn hov"
              data-tip={episode !== null ? `Open the page at ${code}` : 'Open the movie page'}
              data-tip-side="below"
              aria-label={episode !== null ? `Open the page at ${code}` : 'Open the movie page'}
              disabled={detail === null}
              onClick={() => onOpenPage(movieId)}
            >
              <ArrowSquareOut weight="duotone" />
            </button>
            <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
              <X weight="duotone" />
            </button>
          </span>
        </header>
        {error !== null ? (
          <p className="mm-empty">{error === 'not_found' ? `No film or episode has the id ${movieId}.` : moviesErrorText(error)}</p>
        ) : detail === null ? (
          <p className="mm-empty">loading</p>
        ) : (
          <div className="mm-body">
            <div className="mm-art">
              <Poster key={detail.poster_url ?? 'none'} url={detail.poster_url} title={detail.title} year={detail.year} />
            </div>
            <div className="mm-info">
              <h2 className="mm-title">{episode !== null ? (episode.name ?? code) : name}</h2>
              {episode !== null && <p className="mm-of">{name}</p>}
              <p className="mv-facts">
                {facts.map((f, i) => (
                  <span key={i}>{f}</span>
                ))}
                {state !== null && (
                  <span className="mv-chip">
                    {episode !== null ? 'episode' : kindLabel(detail.kind)} · {STATE_LABEL[state]}
                  </span>
                )}
              </p>
              <div className="mm-actions">
                <button type="button" className="ibtn on mv-play" data-tip={play.label} data-tip-side="below" aria-label={play.label} disabled={play.disabled || busy} onClick={() => void start()}>
                  <Play weight="duotone" />
                </button>
                <span className="mm-notice" role="status">
                  {notice ?? play.label}
                </span>
              </div>
              {overview !== '' && <p className="mm-overview">{overview}</p>}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
