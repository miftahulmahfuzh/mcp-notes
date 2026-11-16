import { Fragment, useEffect, useState } from 'react';
import { CaretUp, CheckCircle, DotsThree, EyeSlash, Play } from '@phosphor-icons/react';
import { continueTitle, errorCode, errorDetail, playFile, saveTitleUser, setEpisodesWatched, setFileWatched, streamPlay, type CastCredit, type EpisodeView, type FileView, type PlayerState, type TitleDetail } from '../../moviesApi';
import type { NoticeAction } from '../../hooks/useNotice';
import {
  CAST_LIMIT,
  continueNotice,
  creditGroups,
  kindLabel,
  playErrorText,
  playLabel,
  releaseText,
  runtimeText,
  seasonsText,
  startedNotice,
  STATE_LABEL,
  STREAM_OPENING_NOTICE,
  streamErrorText,
  streamLabel,
  streamLine,
  TILE_LIVE_LABEL,
  tileLive,
  titleAction,
  trailerTarget,
  type MovieEntity,
  type MoviesSide,
  type StreamTarget,
  type TrailerTarget,
  streamLive,
  episodeCode,
} from '../../lib/movies';
import { EpisodeList } from './EpisodeList';
import { EntityLink, FileRow, LiveStatus, StreamAltButton, TrailerButton } from './parts';
import { Poster } from './Poster';
import { ReviewField } from './ReviewField';
import { Stars } from './Stars';
import { StoryModal } from './StoryModal';
import { TrailerModal } from './TrailerModal';

export interface MovieDetailProps {
  detail: TitleDetail;
  player: PlayerState | null;
  /** The movie id in the address (`/movies/M-0T77`): an episode's id scrolls the page to that episode. */
  focus?: string | null;
  /** Re-read the store after a write (the server's state wins). */
  onChanged: () => void;
  /** A quiet notice; with an action it offers that beside the text (Undo). */
  onNotice: (text: string, action?: NoticeAction) => void;
  /** Asks about a person, studio, character or genre through the page's pill. Absent: the names are plain text. */
  onEntity?: (e: MovieEntity) => void;
  /** An answer is streaming: entity links wait. */
  asking?: boolean;
  /** The side the title was opened from: on `stream`, Play streams when no file is on this machine. */
  side?: MoviesSide;
  /** False when GET /api/movies/stream said direct streaming is off: the stream buttons say so and are disabled. */
  streamEnabled?: boolean;
}

/**
 * One title (`/movies/<id>`, `/movies/<id>?side=stream`), a film or a series: poster, facts (release
 * date, runtime or seasons, genres), the stream source line, the Play button (VLC on a file here;
 * else the stream player), a second stream icon when both exist, the trailer, the watched flag,
 * stars, synopsis, the review, credits, the cast with character names, then the film's files or
 * the series' episodes, each with progress, its deleted / other-machine flag and its stream icon.
 */
export function MovieDetail({ detail: d, player, focus = null, onChanged, onNotice, onEntity, asking = false, side = 'library', streamEnabled = true }: MovieDetailProps) {
  const [watched, setWatched] = useState(d.watched);
  const [rating, setRating] = useState<number | null>(d.rating);
  const [busy, setBusy] = useState(false);
  useEffect(() => setWatched(d.watched), [d.watched]);
  useEffect(() => setRating(d.rating), [d.rating]);
  /** The trailer playing in the pop-up. It has a video id: a title without one searches YouTube in a new tab instead. */
  const [trailer, setTrailer] = useState<TrailerTarget | null>(null);
  /** The episode whose story is open in the pop-up. */
  const [story, setStory] = useState<EpisodeView | null>(null);
  useEffect(() => setTrailer(null), [d.id]);

  const action = titleAction(d, side);
  const play = action.kind === 'stream' ? streamLabel(action.target, streamEnabled) : playLabel(action.plan, player);
  /** The stream behind a Play that plays a file here (R5.5: the file stays the default). */
  const alt = action.kind === 'vlc' ? action.stream : null;
  const line = streamLine(d, side);
  const current = player?.current ?? null;
  const live = current !== null && current.title_id === d.id ? current : null;
  /** This title's stream on screen in the player page, when VLC does not show the title. */
  const streaming = live === null ? streamLive(d.id, player) : null;
  /** playing / paused / stalled, as on the poster in the grid; null when nothing of this title is on screen (or VLC is stopped). */
  const now = tileLive(d.id, player);

  const run = async (act: () => Promise<string>, failed: (code: string, detail: string | null) => string = playErrorText) => {
    setBusy(true);
    try {
      onNotice(await act());
    } catch (e) {
      onNotice(failed(errorCode(e), errorDetail(e)));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const playOne = (f: FileView) => {
    void run(async () => {
      return startedNotice(f, await playFile(f.id));
    });
  };

  /** One request: the daemon resolves and opens the player full screen in the streaming Chrome. A refresh follows either way. */
  const streamOne = (t: StreamTarget) => {
    void run(
      async () => {
        await streamPlay(t.ref);
        return STREAM_OPENING_NOTICE;
      },
      (code, detail) => streamErrorText(code, detail, t, d.title),
    );
  };

  const start = () => {
    if (action.kind === 'stream') streamOne(action.target);
    else if (action.kind === 'vlc') {
      if (action.plan.kind === 'continue') void run(async () => continueNotice(await continueTitle(d.id)));
      else playOne(action.plan.file);
    }
  };

  const toggleWatched = async () => {
    const next = !watched;
    setWatched(next);
    try {
      await saveTitleUser(d.id, { watched: next });
    } catch (e) {
      setWatched(!next);
      onNotice(`could not save (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  const rate = async (value: number) => {
    const before = rating;
    setRating(value);
    try {
      await saveTitleUser(d.id, { rating: value });
    } catch (e) {
      setRating(before);
      onNotice(`could not save the rating (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  const toggleFileWatched = async (f: FileView) => {
    try {
      await setFileWatched(f.id, f.watched_at === null);
    } catch (e) {
      onNotice(`could not save (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  /** A season or one episode: the notice offers an undo of exactly what this click changed. */
  const markEpisodes = async (target: { season: number } | { episodes: { season: number; episode: number }[] }, next: boolean, what: string) => {
    try {
      const changed = await setEpisodesWatched(d.id, target, next);
      if (changed.length === 0) {
        onNotice(next ? `${what}: nothing left to mark` : `${what}: no marks to clear (a play or a file finished it)`);
        return;
      }
      const count = changed.length === 1 ? '1 episode' : `${changed.length} episodes`;
      onNotice(next ? `${what} marked finished (${count})` : `${what}: marks cleared (${count})`, {
        label: 'undo',
        run: () => {
          void setEpisodesWatched(d.id, { episodes: changed }, !next)
            .then(() => onNotice(`${what}: undone`))
            .catch((e: unknown) => onNotice(`could not undo (${errorCode(e)})`))
            .finally(onChanged);
        },
      });
    } catch (e) {
      onNotice(`could not save (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  const toggleNotInterested = async () => {
    const next = !d.not_interested;
    try {
      await saveTitleUser(d.id, { not_interested: next });
      onNotice(next ? 'not interested: off the Stream grid' : 'back on the Stream grid', {
        label: 'undo',
        run: () => {
          void saveTitleUser(d.id, { not_interested: !next })
            .catch((e: unknown) => onNotice(`could not undo (${errorCode(e)})`))
            .finally(onChanged);
        },
      });
    } catch (e) {
      onNotice(`could not save (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  const watchedLabel = watched ? 'Watched (click to unmark)' : 'Mark as watched';
  const notInterestedLabel = d.not_interested ? 'Not interested (click to put it back on the Stream grid)' : 'Not interested: take it off the Stream grid';
  const facts = [
    d.release_date !== null ? `Released ${releaseText(d.release_date)}` : d.year !== null ? String(d.year) : '',
    d.kind === 'tv' ? seasonsText(d.season_count) : runtimeText(d.runtime_min),
  ].filter((s) => s !== '');
  const credits = creditGroups(d);

  return (
    <article className="mv-detail mv-content" aria-label={d.title} data-title={d.id}>
      {d.backdrop_url !== null && (
        <div className="mv-hero" aria-hidden="true">
          <img src={d.backdrop_url} alt="" loading="lazy" />
        </div>
      )}
      <div className="mv-detail-grid">
        <div className={now === null ? 'mv-detail-art' : `mv-detail-art now ${now}`}>
          <Poster key={d.poster_url ?? 'none'} url={d.poster_url} title={d.title} year={d.year} />
          {now !== null && <span className={`mv-badge mv-now ${now}`}>{TILE_LIVE_LABEL[now]}</span>}
        </div>
        <div className="mv-detail-info">
          <p className="mv-facts">
            {d.movie_id !== null && (
              <span className="mv-code" data-testid="movie-id" data-tip="Movie id: name it to Claude" data-tip-side="below">
                {d.movie_id}
              </span>
            )}
            {facts.map((f, i) => (
              <span key={i}>{f}</span>
            ))}
            {d.genres.length > 0 && (
              <span className="mv-genres">
                {d.genres.map((g, i) => (
                  <Fragment key={g}>
                    {i > 0 && ', '}
                    <EntityLink entity={{ kind: 'genre', name: g }} onAsk={onEntity} busy={asking} />
                  </Fragment>
                ))}
              </span>
            )}
            <span className="mv-chip">
              {kindLabel(d.kind)} · {STATE_LABEL[d.state]}
            </span>
          </p>
          {line !== null && (
            <p className="mv-stream-line" data-testid="stream-source">
              {line}
            </p>
          )}
          <div className="mv-actions">
            <button type="button" className="ibtn on mv-play" data-tip={play.label} data-tip-side="below" aria-label={play.label} disabled={play.disabled || busy} onClick={start}>
              <Play weight="duotone" />
            </button>
            {alt !== null && <StreamAltButton size="page" state={streamLabel(alt, streamEnabled)} busy={busy} onClick={() => streamOne(alt)} />}
            <TrailerButton target={trailerTarget(d)} onWatch={setTrailer} />
            <button
              type="button"
              className={watched ? 'ibtn on' : 'ibtn hov'}
              data-tip={watchedLabel}
              data-tip-side="below"
              aria-label={watchedLabel}
              aria-pressed={watched}
              onClick={() => void toggleWatched()}
            >
              <CheckCircle weight="duotone" />
            </button>
            {(side === 'stream' || d.not_interested) && (
              <button
                type="button"
                className={d.not_interested ? 'ibtn on' : 'ibtn hov'}
                data-tip={notInterestedLabel}
                data-tip-side="below"
                aria-label={notInterestedLabel}
                aria-pressed={d.not_interested}
                onClick={() => void toggleNotInterested()}
              >
                <EyeSlash weight="duotone" />
              </button>
            )}
            <Stars value={rating} onRate={(v) => void rate(v)} />
            {live !== null && <LiveStatus live={live} now={now} />}
            {streaming !== null && <LiveStatus live={streaming} now={streaming.state} place="the stream player" what={episodeCode(streaming.season, streaming.episode) || null} />}
          </div>
          {d.overview !== '' && <p className="mv-overview">{d.overview}</p>}
          <ReviewField key={d.id} titleId={d.id} saved={d.review} onSaved={onChanged} onNotice={onNotice} />
          {credits.length > 0 && (
            <dl className="mv-credits" aria-label="Credits">
              {credits.map((g) => (
                <div key={g.label}>
                  <dt>{g.label}</dt>
                  <dd>
                    {g.entities.map((e, i) => (
                      <Fragment key={`${e.name}-${i}`}>
                        {i > 0 && ', '}
                        <EntityLink entity={e} onAsk={onEntity} busy={asking} />
                      </Fragment>
                    ))}
                    {g.more > 0 && ` and ${g.more} more`}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      <CastList cast={d.cast} onEntity={onEntity} asking={asking} />
      {d.kind === 'tv' ? (
        <EpisodeList
          detail={d}
          player={player}
          focus={focus}
          busy={busy}
          side={side}
          streamEnabled={streamEnabled}
          onPlay={playOne}
          onStream={streamOne}
          onWatched={(f) => void toggleFileWatched(f)}
          onSeasonWatched={(season, next) => void markEpisodes({ season }, next, season === 0 ? 'Specials' : `Season ${season}`)}
          onEpisodeWatched={(e: EpisodeView, next) => void markEpisodes({ episodes: [{ season: e.season, episode: e.episode }] }, next, episodeCode(e.season, e.episode))}
          onTrailer={setTrailer}
          onStory={setStory}
        />
      ) : (
        (side === 'library' || d.files.length > 0) && (
          <section className="mv-sec" aria-label="Files">
            <h2 className="mv-h2">Files</h2>
            <ul className="mv-files">
              {d.files.map((f) => (
                <FileRow key={f.id} file={f} player={player} busy={busy} onPlay={playOne} onWatched={(x) => void toggleFileWatched(x)} />
              ))}
            </ul>
          </section>
        )
      )}
      {trailer !== null && trailer.key !== null && <TrailerModal videoKey={trailer.key} name={trailer.name} onClose={() => setTrailer(null)} />}
      {story !== null && (
        <StoryModal
          titleId={d.id}
          season={story.season}
          episode={story.episode}
          name={`${d.title} ${episodeCode(story.season, story.episode)}${story.name === null ? '' : ` · ${story.name}`}`}
          stored={story.has_story === true}
          onClose={() => setStory(null)}
        />
      )}
    </article>
  );
}

/** The cast with their character names; the first CAST_LIMIT, then an icon to show the rest. */
function CastList({ cast, onEntity, asking }: { cast: CastCredit[]; onEntity: ((e: MovieEntity) => void) | undefined; asking: boolean }) {
  const [all, setAll] = useState(false);
  if (cast.length === 0) return null;
  const shown = all ? cast : cast.slice(0, CAST_LIMIT);
  const label = all ? 'Show less cast' : `Show all ${cast.length} cast`;
  return (
    <section className="mv-sec" aria-label="Cast">
      <h2 className="mv-h2">Cast</h2>
      <ul className="mv-cast">
        {shown.map((c) => (
          <li key={c.person_id}>
            <span className="mv-cast-n">
              <EntityLink entity={{ kind: 'person', name: c.name, personId: c.person_id, role: c.character === '' ? null : c.character, cast: true }} onAsk={onEntity} busy={asking} />
            </span>
            {c.character !== null && c.character !== '' && (
              <span className="mv-cast-c">
                <EntityLink entity={{ kind: 'character', name: c.character, actor: c.name, personId: c.person_id }} onAsk={onEntity} busy={asking} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {cast.length > CAST_LIMIT && (
        <button type="button" className="ibtn hov" data-tip={label} aria-label={label} onClick={() => setAll((a) => !a)}>
          {all ? <CaretUp weight="duotone" /> : <DotsThree weight="duotone" />}
        </button>
      )}
    </section>
  );
}
