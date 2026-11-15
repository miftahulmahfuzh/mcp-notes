import { useEffect, useRef } from 'react';
import type { EpisodeView, FileView, PlayerState, TitleDetail } from '../../moviesApi';
import { episodeAction, episodeCode, episodeLive, filePlayLabel, primaryFile, seasonsShown, streamLabel, streamSourceText, TILE_LIVE_LABEL, trailerTarget, type MoviesSide, type PlayButtonState, type StreamTarget, type TrailerTarget } from '../../lib/movies';
import { FileFlags, FileRow, Meter, PlayButton, StreamAltButton, TrailerButton, WatchedButton } from './parts';

export interface EpisodeListProps {
  detail: TitleDetail;
  player: PlayerState | null;
  /** An episode's movie id from the address: its row is marked, its season shown even without a file, and scrolled to once. */
  focus?: string | null;
  busy: boolean;
  /** `stream`: every season is listed and an episode without a file here streams (verified when clicked). */
  side: MoviesSide;
  streamEnabled: boolean;
  onPlay: (f: FileView) => void;
  onStream: (t: StreamTarget) => void;
  onWatched: (f: FileView) => void;
  /** Plays a season's trailer in the page's pop-up. */
  onTrailer: (t: TrailerTarget) => void;
}

/** A series' seasons (Library: those with a file on any machine; Stream: all), each with its trailer and every episode with its progress, flags and play icons; then files with no episode. */
export function EpisodeList({ detail, player, focus = null, busy, side, streamEnabled, onPlay, onStream, onWatched, onTrailer }: EpisodeListProps) {
  const { seasons, hidden } = seasonsShown(detail, focus, side);
  const list = useRef<HTMLElement>(null);
  // Once per (title, focus): a refresh of the detail must not pull the page back to the episode.
  const found = focus !== null && seasons.some((s) => s.episodes.some((e) => e.movie_id === focus));
  useEffect(() => {
    if (!found || focus === null) return;
    list.current?.querySelector(`[data-movie-id="${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [detail.id, focus, found]);
  return (
    <section className="mv-sec" aria-label="Episodes" ref={list}>
      <h2 className="mv-h2">Episodes</h2>
      {seasons.map((s) => (
        <div key={s.season} className="mv-season">
          <div className="mv-season-head">
            <h3 className="mv-season-h">{s.season === 0 ? 'Specials' : `Season ${s.season}`}</h3>
            {s.season > 0 && <TrailerButton target={trailerTarget(detail, s.season)} onWatch={onTrailer} />}
          </div>
          <ol className="mv-eps">
            {s.episodes.map((e) => (
              <EpisodeItem
                key={e.episode}
                detail={detail}
                episode={e}
                focused={focus !== null && e.movie_id === focus}
                player={player}
                busy={busy}
                side={side}
                streamEnabled={streamEnabled}
                onPlay={onPlay}
                onStream={onStream}
                onWatched={onWatched}
              />
            ))}
          </ol>
        </div>
      ))}
      {hidden > 0 && <p className="mv-dim">{hidden === 1 ? '1 more season has' : `${hidden} more seasons have`} no file on any machine.</p>}
      {detail.unplaced_files.length > 0 && (
        <div className="mv-season">
          <h3 className="mv-season-h">Other files</h3>
          <ul className="mv-files">
            {detail.unplaced_files.map((f) => (
              <FileRow key={f.id} file={f} player={player} busy={busy} onPlay={onPlay} onWatched={onWatched} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface EpisodeItemProps {
  detail: TitleDetail;
  episode: EpisodeView;
  focused: boolean;
  player: PlayerState | null;
  busy: boolean;
  side: MoviesSide;
  streamEnabled: boolean;
  onPlay: (f: FileView) => void;
  onStream: (t: StreamTarget) => void;
  onWatched: (f: FileView) => void;
}

function EpisodeItem({ detail, episode: e, focused, player, busy, side, streamEnabled, onPlay, onStream, onWatched }: EpisodeItemProps) {
  const code = episodeCode(e.season, e.episode);
  const file = primaryFile(e);
  const act = episodeAction(detail, e, side);
  const play: PlayButtonState =
    act.kind === 'stream' ? streamLabel(act.target, streamEnabled) : file !== null ? filePlayLabel(file, player, code) : { label: `${code} has no file`, disabled: true };
  /** The stream behind a file here (R5.5: the file stays the default). */
  const alt = act.kind === 'vlc' ? act.stream : null;
  const source = act.kind === 'stream' ? act.target.source : alt !== null ? alt.source : null;
  /** This episode is the one on screen, in VLC or in the stream player. */
  const live = episodeLive(detail.id, e, player);
  const cls = `${!e.has_file && side === 'library' ? 'mv-row none' : e.deleted ? 'mv-row del' : 'mv-row'}${focused ? ' focus' : ''}`;
  return (
    <li
      className={cls}
      data-episode={code}
      data-movie-id={e.movie_id ?? undefined}
      data-focused={focused ? 'true' : undefined}
      data-testid="movie-file"
      data-file-id={file?.id}
      data-deleted={String(e.has_file && e.deleted)}
      data-state={e.state}
    >
      <span className="mv-code">{code}</span>
      <span className="mv-row-t">
        <span className="mv-row-name">{e.name ?? code}</span>
        {e.movie_id !== null && (
          <span className="mv-code mv-row-id" data-testid="episode-id">
            {e.movie_id}
          </span>
        )}
        {file !== null ? <FileFlags file={file} /> : side === 'library' && <span className="mv-flag">no file</span>}
        {live !== null && (
          <span className={`mv-flag mv-now ${live}`} role="status" aria-label={`${code}: ${TILE_LIVE_LABEL[live]}`}>
            {TILE_LIVE_LABEL[live]}
          </span>
        )}
        {source !== null && source.fresh && (
          <span className="mv-flag" data-tip={streamSourceText(source)}>
            verified
          </span>
        )}
      </span>
      <Meter state={e.state} progress={e.progress} />
      {file !== null ? <WatchedButton file={file} what={code} onWatched={onWatched} /> : <span />}
      <span className="mv-row-play">
        <PlayButton
          state={play}
          busy={busy}
          onClick={() => {
            if (act.kind === 'stream') onStream(act.target);
            else if (act.kind === 'vlc') onPlay(act.file);
          }}
        />
        {alt !== null && <StreamAltButton state={streamLabel(alt, streamEnabled)} busy={busy} onClick={() => onStream(alt)} />}
      </span>
    </li>
  );
}
