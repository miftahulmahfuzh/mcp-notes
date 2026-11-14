import { useEffect, useState } from 'react';
import { CaretUp, CheckCircle, DotsThree, Play } from '@phosphor-icons/react';
import { continueTitle, errorCode, playFile, saveTitleUser, setFileWatched, type CastCredit, type FileView, type PlayerState, type TitleDetail } from '../../moviesApi';
import { CAST_LIMIT, clock, continueNotice, creditRows, kindLabel, playErrorText, playLabel, playPlan, releaseText, runtimeText, seasonsText, startedNotice, STATE_LABEL } from '../../lib/movies';
import { EpisodeList } from './EpisodeList';
import { FileRow } from './parts';
import { Poster } from './Poster';
import { ReviewField } from './ReviewField';
import { Stars } from './Stars';

export interface MovieDetailProps {
  detail: TitleDetail;
  player: PlayerState | null;
  /** Re-read the store after a write (the server's state wins). */
  onChanged: () => void;
  onNotice: (text: string) => void;
}

/**
 * One title (`/movies/<id>`), a film or a series: poster, facts (release date, runtime or seasons,
 * genres), the Play/Resume button, the watched flag, stars, synopsis, the review, credits (studios,
 * directors, writers, producers; creators for a series), the cast with character names, then the
 * film's files or the series' episodes, each with progress and its deleted / other-machine flag.
 */
export function MovieDetail({ detail: d, player, onChanged, onNotice }: MovieDetailProps) {
  const [watched, setWatched] = useState(d.watched);
  const [rating, setRating] = useState<number | null>(d.rating);
  const [busy, setBusy] = useState(false);
  useEffect(() => setWatched(d.watched), [d.watched]);
  useEffect(() => setRating(d.rating), [d.rating]);

  const plan = playPlan(d);
  const play = playLabel(plan, player);
  const current = player?.current ?? null;
  const live = current !== null && current.title_id === d.id ? current : null;

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      onNotice(await action());
    } catch (e) {
      onNotice(playErrorText(errorCode(e)));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const playOne = (f: FileView) => {
    void run(async () => {
      await playFile(f.id);
      return startedNotice(f);
    });
  };

  const start = () => {
    if (plan.kind === 'continue') void run(async () => continueNotice(await continueTitle(d.id)));
    else if (plan.kind === 'file') playOne(plan.file);
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

  const watchedLabel = watched ? 'Watched (click to unmark)' : 'Mark as watched';
  const facts = [
    d.release_date !== null ? `Released ${releaseText(d.release_date)}` : d.year !== null ? String(d.year) : '',
    d.kind === 'tv' ? seasonsText(d.season_count) : runtimeText(d.runtime_min),
    d.genres.join(', '),
  ].filter((s) => s !== '');
  const credits = creditRows(d);

  return (
    <article className="mv-detail mv-content" aria-label={d.title} data-title={d.id}>
      {d.backdrop_url !== null && (
        <div className="mv-hero" aria-hidden="true">
          <img src={d.backdrop_url} alt="" loading="lazy" />
        </div>
      )}
      <div className="mv-detail-grid">
        <div className="mv-detail-art">
          <Poster key={d.poster_url ?? 'none'} url={d.poster_url} title={d.title} year={d.year} />
        </div>
        <div className="mv-detail-info">
          <p className="mv-facts">
            {facts.map((f, i) => (
              <span key={i}>{f}</span>
            ))}
            <span className="mv-chip">
              {kindLabel(d.kind)} · {STATE_LABEL[d.state]}
            </span>
          </p>
          <div className="mv-actions">
            <button type="button" className="ibtn on mv-play" data-tip={play.label} data-tip-side="below" aria-label={play.label} disabled={play.disabled || busy} onClick={start}>
              <Play weight="duotone" />
            </button>
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
            <Stars value={rating} onRate={(v) => void rate(v)} />
            {live !== null && (
              <span className="mv-live">
                playing in VLC
                {` · ${clock(live.position)}`}
                {live.duration !== null ? ` / ${clock(live.duration)}` : ''}
              </span>
            )}
          </div>
          {d.overview !== '' && <p className="mv-overview">{d.overview}</p>}
          <ReviewField key={d.id} titleId={d.id} saved={d.review} onSaved={onChanged} onNotice={onNotice} />
          {credits.length > 0 && (
            <dl className="mv-credits" aria-label="Credits">
              {credits.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      <CastList cast={d.cast} />
      {d.kind === 'tv' ? (
        <EpisodeList detail={d} player={player} busy={busy} onPlay={playOne} onWatched={(f) => void toggleFileWatched(f)} />
      ) : (
        <section className="mv-sec" aria-label="Files">
          <h2 className="mv-h2">Files</h2>
          <ul className="mv-files">
            {d.files.map((f) => (
              <FileRow key={f.id} file={f} player={player} busy={busy} onPlay={playOne} onWatched={(x) => void toggleFileWatched(x)} />
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

/** The cast with their character names; the first CAST_LIMIT, then an icon to show the rest. */
function CastList({ cast }: { cast: CastCredit[] }) {
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
            <span className="mv-cast-n">{c.name}</span>
            {c.character !== null && c.character !== '' && <span className="mv-cast-c">{c.character}</span>}
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
