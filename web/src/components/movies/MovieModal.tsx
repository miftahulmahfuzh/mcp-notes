import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, Play, X } from '@phosphor-icons/react';
import { continueTitle, errorCode, errorDetail, fetchMovie, fetchPlayer, MOVIES_EVENTS_URL, playFile, streamPlay, type PlayerState, type TitleDetail } from '../../moviesApi';
import {
  continueNotice,
  episodeAction,
  episodeByMovieId,
  episodeCode,
  filePlayLabel,
  kindLabel,
  moviesErrorText,
  playErrorText,
  playLabel,
  primaryFile,
  releaseText,
  runtimeText,
  seasonsText,
  startedNotice,
  STATE_LABEL,
  STREAM_OPENING_NOTICE,
  streamErrorText,
  streamLabel,
  TILE_LIVE_LABEL,
  tileLive,
  titleAction,
  type PlayButtonState,
  anyLive,
  streamLive,
} from '../../lib/movies';
import { isConfirmOpen } from '../ConfirmDialog';
import { isLightboxOpen } from '../Lightbox';
import { isEditorOpen } from '../NoteEditor';
import { PLAY_POLL_MS } from '../../hooks/useMovies';
import { isPageVisible } from '../../lib/pageActive';
import { LiveStatus } from './parts';
import { isPlayMenuOpen, PlayMenu } from './PlayMenu';
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
 * While VLC has it open the poster and the line beside Play follow the play, as on the title's page:
 * re-read on `/api/movies/events` `changed`, and every 5 s while a play is followed.
 * Esc and a click outside close it, except while the editor, a lightbox or a confirm is up.
 */
export function MovieModal({ movieId, onClose, onOpenPage }: MovieModalProps) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const playing = anyLive(player);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setNotice(null);
  }, [movieId]);

  useEffect(() => {
    const ac = new AbortController();
    fetchMovie(movieId, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setDetail(d);
        setError(null);
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
  }, [movieId, tick]);

  useEffect(() => {
    const es = typeof EventSource === 'undefined' ? null : new EventSource(MOVIES_EVENTS_URL);
    es?.addEventListener('changed', () => setTick((t) => t + 1));
    return () => es?.close();
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (isPageVisible()) setTick((t) => t + 1);
    }, PLAY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isEditorOpen() || isLightboxOpen() || isConfirmOpen() || isPlayMenuOpen()) return;
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
  /** What Play does: the file on this machine in VLC; without one, the stream (a title the library does not hold plays this way). */
  const action = detail === null ? null : episode !== null ? episodeAction(detail, episode, 'stream') : titleAction(detail, 'stream');
  let play: PlayButtonState = { label: 'Loading', disabled: true };
  if (detail !== null && action !== null) {
    if (action.kind === 'stream') play = streamLabel(action.target, true);
    else if (episode !== null) play = file !== null ? filePlayLabel(file, player, code ?? 'this episode') : { label: `${code} has no file`, disabled: true };
    else if (action.kind === 'vlc' || action.kind === 'idle') play = playLabel('plan' in action ? action.plan : { kind: 'none' }, player);
  }

  /** One play: its notice beside the button, or why it did not start; the pop-up re-reads either way. */
  const run = async (act: () => Promise<string>, failed: (code: string, detail: string | null) => string = playErrorText) => {
    setBusy(true);
    try {
      setNotice(await act());
    } catch (e) {
      setNotice(failed(errorCode(e), errorDetail(e)));
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  const start = () => {
    if (detail === null || action === null) return;
    if (action.kind === 'stream') {
      const target = action.target;
      void run(
        async () => {
          const { site } = await streamPlay(target.ref);
          return site === null ? STREAM_OPENING_NOTICE : `Playing on ${site} in the streaming Chrome window`;
        },
        (c, d) => streamErrorText(c, d, target, detail.title),
      );
    } else if (action.kind === 'vlc') {
      if ('file' in action) void run(async () => startedNotice(action.file, await playFile(action.file.id)));
      else if (action.plan.kind === 'continue') void run(async () => continueNotice(await continueTitle(detail.id)));
      else {
        const f = action.plan.file;
        void run(async () => startedNotice(f, await playFile(f.id)));
      }
    }
  };

  /** The followed play, when it is what the pop-up shows: the title, or for an episode's id that episode's file. */
  const current = player?.current ?? null;
  const live = detail !== null && current !== null && current.title_id === detail.id && (episode === null || episode.files.some((f) => f.id === current.file_id)) ? current : null;
  /** This title's stream on screen (for an episode's id: that episode's), when VLC does not show it. */
  const shown = live !== null || detail === null ? null : streamLive(detail.id, player);
  const streaming = shown !== null && (episode === null || (shown.season === episode.season && shown.episode === episode.episode)) ? shown : null;
  /** playing / paused / stalled, as on the poster in the grid; null when it is not on screen (or VLC is stopped). */
  const now = detail === null ? null : live !== null ? tileLive(detail.id, player) : (streaming?.state ?? null);
  /** A series' pop-up names the episode VLC has open. */
  const liveEpisode = live === null || detail === null || episode !== null ? null : (detail.seasons.flatMap((s) => s.episodes).find((e) => e.files.some((f) => f.id === live.file_id)) ?? null);

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
        {/* A failed re-read keeps what is shown. */}
        {error !== null && detail === null ? (
          <p className="mm-empty">{error === 'not_found' ? `No film or episode has the id ${movieId}.` : moviesErrorText(error)}</p>
        ) : detail === null ? (
          <p className="mm-empty">loading</p>
        ) : (
          <div className="mm-body">
            <div className={now === null ? 'mm-art' : `mm-art now ${now}`}>
              <Poster key={detail.poster_url ?? 'none'} url={detail.poster_url} title={detail.title} year={detail.year} />
              {now !== null && <span className={`mv-badge mv-now ${now}`}>{TILE_LIVE_LABEL[now]}</span>}
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
                <button type="button" className="ibtn on mv-play" data-tip={play.label} data-tip-side="below" aria-label={play.label} disabled={play.disabled || busy} onClick={start}>
                  <Play weight="duotone" />
                </button>
                <PlayMenu detail={detail} episode={episode} player={player} busy={busy} streamEnabled size="page" onRun={(act, failed) => void run(act, failed)} />
                {live !== null ? (
                  <LiveStatus live={live} now={now} what={liveEpisode !== null ? episodeCode(liveEpisode.season, liveEpisode.episode) : null} />
                ) : streaming !== null ? (
                  <LiveStatus live={streaming} now={streaming.state} place="the stream player" what={episode === null ? episodeCode(streaming.season, streaming.episode) || null : null} />
                ) : (
                  <span className="mm-notice" role="status">
                    {notice ?? play.label}
                  </span>
                )}
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
