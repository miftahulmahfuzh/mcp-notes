import { CheckCircle, Desktop, MonitorPlay, Play, Trash } from '@phosphor-icons/react';
import type { FileView, PlayerSnapshot, PlayerState, ProgressView, WatchState } from '../../moviesApi';
import { clock, dayText, entityTip, filePlayLabel, meterRatio, meterText, sizeText, TILE_LIVE_LABEL, type MovieEntity, type PlayButtonState, type TileLive, type TrailerTarget } from '../../lib/movies';

/** The followed play beside the Play button: its state (`now` null = stopped) and position. `what` names the episode (`S01E02`). */
export function LiveStatus({ live, now, what = null }: { live: PlayerSnapshot; now: TileLive | null; what?: string | null }) {
  return (
    <span className={`mv-live ${now ?? 'stopped'}`} role="status">
      {what !== null ? `${what} · ` : ''}
      {now === null ? 'stopped' : TILE_LIVE_LABEL[now]} in VLC
      {` · ${clock(live.position)}`}
      {live.duration !== null ? ` / ${clock(live.duration)}` : ''}
    </span>
  );
}

/** R5.3: a deleted file says so; a present file on the other laptop says where it is. */
export function FileFlags({ file }: { file: FileView }) {
  if (file.deleted) {
    return (
      <span className="mv-flag del" data-tip={file.deleted_at ? `Deleted ${dayText(file.deleted_at)}` : 'Deleted'}>
        <Trash weight="duotone" />
        deleted
      </span>
    );
  }
  if (!file.available) {
    return (
      <span className="mv-flag far" data-tip="On another machine">
        <Desktop weight="duotone" />
        on {file.host}
      </span>
    );
  }
  return null;
}

export function Meter({ state, progress }: { state: WatchState; progress: ProgressView }) {
  return (
    <span className="mv-meter">
      <span>{meterText(state, progress)}</span>
      <span className="mv-meter-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(meterRatio(state, progress) * 100)}%` }} />
      </span>
    </span>
  );
}

/** The per-file manual "watched" flag (covers skipping the credits at 95%). `what` names the row. */
export function WatchedButton({ file, what, onWatched }: { file: FileView; what: string; onWatched: (f: FileView) => void }) {
  const on = file.watched_at !== null;
  const label = on ? `${what} marked watched (click to unmark)` : `Mark ${what} watched`;
  return (
    <button type="button" className={on ? 'pbtn on' : 'pbtn hov'} data-tip={label} aria-label={label} aria-pressed={on} onClick={() => onWatched(file)}>
      <CheckCircle weight="duotone" />
    </button>
  );
}

export function PlayButton({ state, busy, onClick }: { state: PlayButtonState; busy: boolean; onClick: () => void }) {
  return (
    <button type="button" className="pbtn hov" data-tip={state.label} aria-label={state.label} disabled={state.disabled || busy} onClick={onClick}>
      <Play weight="duotone" />
    </button>
  );
}

export interface FileRowProps {
  file: FileView;
  player: PlayerState | null;
  busy: boolean;
  onPlay: (f: FileView) => void;
  onWatched: (f: FileView) => void;
}

/** One file of a film, or a series file with no season/episode: size, name with its flags, progress, watched, play. */
export function FileRow({ file: f, player, busy, onPlay, onWatched }: FileRowProps) {
  return (
    <li className={f.deleted ? 'mv-row del' : 'mv-row'} data-testid="movie-file" data-file-id={f.id} data-deleted={String(f.deleted)} data-state={f.state}>
      <span className="mv-code">{sizeText(f.size)}</span>
      <span className="mv-row-t">
        <span className="mv-row-name">{f.name}</span>
        <FileFlags file={f} />
      </span>
      <Meter state={f.state} progress={f.progress} />
      <WatchedButton file={f} what="this file" onWatched={onWatched} />
      <PlayButton state={filePlayLabel(f, player, 'this file')} busy={busy} onClick={() => onPlay(f)} />
    </li>
  );
}

export interface EntityLinkProps {
  entity: MovieEntity;
  /** Absent: plain text (the pop-up, which has no pill to ask through). */
  onAsk?: ((e: MovieEntity) => void) | undefined;
  /** An answer is still streaming: one question at a time. */
  busy?: boolean;
}

/** A name on a title's page that asks about itself when clicked: looks like the text it replaces, underlined on hover. */
export function EntityLink({ entity, onAsk, busy = false }: EntityLinkProps) {
  if (onAsk === undefined) return <>{entity.name}</>;
  return (
    <button type="button" className="mv-ent" data-tip={entityTip(entity)} disabled={busy} onClick={() => onAsk(entity)}>
      {entity.name}
    </button>
  );
}

/** The trailer icon: plays the trailer TMDB lists in the pop-up, or opens a YouTube search in a new tab when it lists none. */
export function TrailerButton({ target, onWatch }: { target: TrailerTarget; onWatch: (t: TrailerTarget) => void }) {
  return (
    <button
      type="button"
      className="ibtn hov mv-trailer"
      data-tip={target.label}
      data-tip-side="below"
      aria-label={target.label}
      onClick={() => {
        if (target.key !== null) onWatch(target);
        else window.open(target.searchUrl, '_blank', 'noopener');
      }}
    >
      <MonitorPlay weight="duotone" />
    </button>
  );
}
