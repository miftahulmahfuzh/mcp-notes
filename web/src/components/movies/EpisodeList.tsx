import type { EpisodeView, FileView, PlayerState, TitleDetail } from '../../moviesApi';
import { episodeCode, filePlayLabel, primaryFile, seasonsShown, type PlayButtonState } from '../../lib/movies';
import { FileFlags, FileRow, Meter, PlayButton, WatchedButton } from './parts';

export interface EpisodeListProps {
  detail: TitleDetail;
  player: PlayerState | null;
  busy: boolean;
  onPlay: (f: FileView) => void;
  onWatched: (f: FileView) => void;
}

/** A series' seasons (those with a file on any machine), each episode with its progress and flags; then files with no episode. */
export function EpisodeList({ detail, player, busy, onPlay, onWatched }: EpisodeListProps) {
  const { seasons, hidden } = seasonsShown(detail);
  return (
    <section className="mv-sec" aria-label="Episodes">
      <h2 className="mv-h2">Episodes</h2>
      {seasons.map((s) => (
        <div key={s.season} className="mv-season">
          <h3 className="mv-season-h">{s.season === 0 ? 'Specials' : `Season ${s.season}`}</h3>
          <ol className="mv-eps">
            {s.episodes.map((e) => (
              <EpisodeItem key={e.episode} episode={e} player={player} busy={busy} onPlay={onPlay} onWatched={onWatched} />
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
  episode: EpisodeView;
  player: PlayerState | null;
  busy: boolean;
  onPlay: (f: FileView) => void;
  onWatched: (f: FileView) => void;
}

function EpisodeItem({ episode: e, player, busy, onPlay, onWatched }: EpisodeItemProps) {
  const code = episodeCode(e.season, e.episode);
  const file = primaryFile(e);
  const play: PlayButtonState = file !== null ? filePlayLabel(file, player, code) : { label: `${code} has no file`, disabled: true };
  const cls = !e.has_file ? 'mv-row none' : e.deleted ? 'mv-row del' : 'mv-row';
  return (
    <li
      className={cls}
      data-episode={code}
      data-testid="movie-file"
      data-file-id={file?.id}
      data-deleted={String(e.has_file && e.deleted)}
      data-state={e.state}
    >
      <span className="mv-code">{code}</span>
      <span className="mv-row-t">
        <span className="mv-row-name">{e.name ?? code}</span>
        {file !== null ? <FileFlags file={file} /> : <span className="mv-flag">no file</span>}
      </span>
      <Meter state={e.state} progress={e.progress} />
      {file !== null ? <WatchedButton file={file} what={code} onWatched={onWatched} /> : <span />}
      <PlayButton
        state={play}
        busy={busy}
        onClick={() => {
          if (file !== null) onPlay(file);
        }}
      />
    </li>
  );
}
