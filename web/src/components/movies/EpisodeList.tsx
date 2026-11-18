import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpenText, CaretDown, CaretRight, CheckCircle, Checks } from '@phosphor-icons/react';
import type { EpisodeView, FileView, PlayerState, TitleDetail } from '../../moviesApi';
import { episodeAction, episodeCode, episodeLive, filePlayLabel, primaryFile, seasonsShown, streamLabel, streamSourceText, TILE_LIVE_LABEL, trailerTarget, type MoviesSide, type PlayButtonState, type StreamTarget, type TrailerTarget } from '../../lib/movies';
import { FileFlags, FileRow, Meter, PlayButton, StreamAltButton, TrailerButton, WatchedButton } from './parts';
import { PlayMenu, type PlayMenuProps } from './PlayMenu';

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
  /** Runs a play chosen in an episode's play menu. Left out, the rows have no menu. */
  onRun?: PlayMenuProps['onRun'];
  onWatched: (f: FileView) => void;
  /** Marks every episode of a season finished, or clears the marks (the page offers an undo). */
  onSeasonWatched: (season: number, watched: boolean) => void;
  /** Marks one episode that has no file finished, or clears its mark. */
  onEpisodeWatched: (e: EpisodeView, watched: boolean) => void;
  /** Plays a season's trailer in the page's pop-up. */
  onTrailer: (t: TrailerTarget) => void;
  /** Opens an episode's story (StoryModal). Left out, the rows have no book icon. */
  onStory?: (e: EpisodeView) => void;
}

/** A season counts as finished when every episode is, by a play, a file flag or the owner's mark. */
function seasonFinished(episodes: readonly EpisodeView[]): boolean {
  return episodes.length > 0 && episodes.every((e) => e.state === 'finished');
}

function SeasonWatchedButton({ name, episodes, busy, onChange }: { name: string; episodes: readonly EpisodeView[]; busy: boolean; onChange: (watched: boolean) => void }) {
  const on = seasonFinished(episodes);
  const label = on ? `${name} is finished (click to clear its marks)` : `Mark all of ${name} finished`;
  return (
    <button type="button" className={on ? 'pbtn on' : 'pbtn hov'} data-tip={label} aria-label={label} aria-pressed={on} disabled={busy} onClick={() => onChange(!on)}>
      <Checks weight="duotone" />
    </button>
  );
}

const collapsedKey = (titleId: string): string => `movies.collapsed.${titleId}`;

/** The seasons the owner folded on this title's page, kept in this browser; none when nothing was kept or storage is not there. */
function readCollapsed(titleId: string): Set<number> {
  try {
    const kept: unknown = JSON.parse(window.localStorage.getItem(collapsedKey(titleId)) ?? '[]');
    return new Set(Array.isArray(kept) ? kept.filter((n): n is number => Number.isInteger(n)) : []);
  } catch {
    return new Set();
  }
}

function keepCollapsed(titleId: string, seasons: ReadonlySet<number>): void {
  try {
    if (seasons.size === 0) window.localStorage.removeItem(collapsedKey(titleId));
    else window.localStorage.setItem(collapsedKey(titleId), JSON.stringify([...seasons].sort((a, b) => a - b)));
  } catch {
    // A private window: the fold lasts as long as the page.
  }
}

/** What a folded season says in place of its episodes. */
function foldedSummary(episodes: readonly EpisodeView[]): string {
  const finished = episodes.filter((e) => e.state === 'finished').length;
  const count = `${episodes.length} ${episodes.length === 1 ? 'episode' : 'episodes'}`;
  return finished === 0 ? count : `${count}, ${finished === episodes.length ? 'all' : finished} finished`;
}

function SeasonFoldButton({ name, folded, onToggle }: { name: string; folded: boolean; onToggle: () => void }) {
  const label = folded ? `Show the episodes of ${name}` : `Hide the episodes of ${name}`;
  return (
    <button type="button" className="pbtn hov" data-tip={label} aria-label={label} aria-expanded={!folded} onClick={onToggle}>
      {folded ? <CaretRight weight="duotone" /> : <CaretDown weight="duotone" />}
    </button>
  );
}

/** A series' seasons (Library: those with a file on any machine; Stream: all), each with its trailer and every episode with its progress, flags and play icons; then files with no episode. */
export function EpisodeList({ detail, player, focus = null, busy, side, streamEnabled, onPlay, onStream, onRun, onWatched, onSeasonWatched, onEpisodeWatched, onTrailer, onStory }: EpisodeListProps) {
  const { seasons, hidden } = seasonsShown(detail, focus, side);
  const list = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => readCollapsed(detail.id));
  useEffect(() => setCollapsed(readCollapsed(detail.id)), [detail.id]);
  const toggleSeason = useCallback(
    (season: number) => {
      setCollapsed((was) => {
        const next = new Set(was);
        if (!next.delete(season)) next.add(season);
        keepCollapsed(detail.id, next);
        return next;
      });
    },
    [detail.id],
  );
  // The season of the episode the address names stays open, so the page can scroll to it.
  const isFolded = (s: { season: number; episodes: readonly EpisodeView[] }): boolean =>
    collapsed.has(s.season) && !(focus !== null && s.episodes.some((e) => e.movie_id === focus));
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
        <div key={s.season} className="mv-season" data-season={s.season} data-folded={isFolded(s) ? 'true' : undefined}>
          <div className="mv-season-head">
            <SeasonFoldButton name={s.season === 0 ? 'Specials' : `season ${s.season}`} folded={isFolded(s)} onToggle={() => toggleSeason(s.season)} />
            <h3 className="mv-season-h">{s.season === 0 ? 'Specials' : `Season ${s.season}`}</h3>
            {s.season > 0 && <TrailerButton target={trailerTarget(detail, s.season)} onWatch={onTrailer} />}
            <SeasonWatchedButton name={s.season === 0 ? 'Specials' : `season ${s.season}`} episodes={s.episodes} busy={busy} onChange={(watched) => onSeasonWatched(s.season, watched)} />
            {isFolded(s) && <span className="mv-dim mv-season-sum">{foldedSummary(s.episodes)}</span>}
          </div>
          <ol className="mv-eps" hidden={isFolded(s)}>
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
                onRun={onRun}
                onWatched={onWatched}
                onEpisodeWatched={onEpisodeWatched}
                onStory={onStory}
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
  onRun?: PlayMenuProps['onRun'] | undefined;
  onWatched: (f: FileView) => void;
  onEpisodeWatched: (e: EpisodeView, watched: boolean) => void;
  onStory?: ((e: EpisodeView) => void) | undefined;
}

function EpisodeItem({ detail, episode: e, focused, player, busy, side, streamEnabled, onPlay, onStream, onRun, onWatched, onEpisodeWatched, onStory }: EpisodeItemProps) {
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
      {onStory !== undefined && (
        <button
          type="button"
          className="pbtn hov mv-story"
          data-tip={e.has_story === true ? `The story of ${code} (stored; full spoilers)` : `Write the story of ${code} from its subtitle (full spoilers; Claude writes it once)`}
          aria-label={e.has_story === true ? `The story of ${code}` : `Write the story of ${code}`}
          data-stored={e.has_story === true ? 'true' : undefined}
          onClick={() => onStory(e)}
        >
          <BookOpenText weight={e.has_story === true ? 'fill' : 'duotone'} />
        </button>
      )}
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
      {file !== null ? (
        <WatchedButton file={file} what={code} onWatched={onWatched} />
      ) : (
        <button
          type="button"
          className={e.watched ? 'pbtn on' : 'pbtn hov'}
          data-tip={e.watched ? `${code} marked finished (click to unmark)` : `Mark ${code} finished`}
          aria-label={e.watched ? `${code} marked finished (click to unmark)` : `Mark ${code} finished`}
          aria-pressed={e.watched}
          onClick={() => onEpisodeWatched(e, !e.watched)}
        >
          <CheckCircle weight="duotone" />
        </button>
      )}
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
        {onRun !== undefined && <PlayMenu detail={detail} episode={e} player={player} busy={busy} streamEnabled={streamEnabled} onRun={onRun} />}
      </span>
    </li>
  );
}
