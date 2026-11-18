import { useCallback, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowsClockwise, ArrowSquareOut, ChatCircleText, CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { ApiError } from '../../api';
import { ensureTitle, fetchCompanyGuide, fetchGenreGuide, fetchPersonGuide, writeGenreGuide, type EntityGuide, type GuideTitle, type TitleDetail } from '../../moviesApi';
import { GUIDE_MARK_LABEL, GUIDE_WRITING_TEXT, guideCountLine, guideErrorText, guideHeading, guideTitleLine, type GuideEntityRef } from '../../lib/movies';
import { MovieLinkContext } from '../ChatText';
import { Poster } from './Poster';
import './MovieModal.css';

export interface EntityModalProps {
  /** The name clicked on the title's page: a person, a studio or a genre. */
  entity: GuideEntityRef;
  /** The title whose page it was clicked on: a genre's guide is written for this title. */
  detail: TitleDetail;
  onClose: () => void;
  /** Sends the old question about the name through the page's pill. Absent: the pop-up has no chat icon. */
  onAsk?: ((e: GuideEntityRef) => void) | undefined;
  /** Opens a listed title's pop-up by its movie id. Default: the wall's movie pop-up (MovieLinkContext). */
  onOpenTitle?: (movieId: string) => void;
}

type Phase = { at: 'loading' } | { at: 'writing' } | { at: 'done'; guide: EntityGuide } | { at: 'failed'; text: string };

/** Whether a movie pop-up lies over this one: its Esc and its clicks are its own. */
const movieModalOpen = (): boolean => document.querySelector('[data-modal="movie"]') !== null;

function failedText(err: unknown): string {
  return guideErrorText(err instanceof ApiError ? err.message : 'error', err instanceof ApiError ? err.detail : err instanceof Error ? err.message : null);
}

/**
 * A name clicked on a title's page, as a pop-up over it: the person's photo or the studio's logo,
 * a short description, and their films and series newest first, each tagged with what the owner
 * did with it (watched, started, not interested, a file here). A genre opens what it means for
 * this title: collated once with web search on the first click (about a minute), then stored. A
 * listed title opens the movie pop-up; one the library does not hold is stored first.
 * Esc and a click outside close it, unless the movie pop-up lies over it.
 */
export function EntityModal({ entity, detail, onClose, onAsk, onOpenTitle }: EntityModalProps) {
  const [phase, setPhase] = useState<Phase>({ at: 'loading' });
  const [whole, setWhole] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const movies = useContext(MovieLinkContext);
  const open = onOpenTitle ?? movies?.open;
  const key = entity.kind === 'person' ? `person ${entity.personId}` : entity.kind === 'company' ? `company ${entity.companyId}` : `genre ${detail.id} ${entity.name}`;

  useEffect(() => {
    const ac = new AbortController();
    setPhase({ at: 'loading' });
    setWhole(false);
    setNotice(null);
    const load = async (): Promise<EntityGuide> => {
      if (entity.kind === 'person') return fetchPersonGuide(entity.personId, ac.signal);
      if (entity.kind === 'company') return fetchCompanyGuide(entity.companyId, ac.signal);
      const stored = again > 0 ? null : await fetchGenreGuide(detail.id, entity.name, ac.signal);
      if (stored !== null) return stored;
      if (!ac.signal.aborted) setPhase({ at: 'writing' });
      return writeGenreGuide(detail.id, entity.name, again > 0);
    };
    load().then(
      (guide) => {
        if (!ac.signal.aborted) setPhase({ at: 'done', guide });
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setPhase({ at: 'failed', text: failedText(err) });
      },
    );
    return () => ac.abort();
    // `key` names the entity; `again` asks a genre's guide to be collated anew.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, again]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || movieModalOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const openTitle = useCallback(
    async (t: GuideTitle) => {
      if (open === undefined) return;
      if (t.movie_id !== null) {
        open(t.movie_id);
        return;
      }
      setOpening(t.title_id);
      setNotice(null);
      try {
        const movieId = await ensureTitle(t.kind, t.tmdb_id);
        setPhase((p) => (p.at !== 'done' ? p : { at: 'done', guide: { ...p.guide, titles: p.guide.titles.map((x) => (x.title_id === t.title_id ? { ...x, movie_id: movieId } : x)) } }));
        open(movieId);
      } catch (err) {
        setNotice(`${t.title} could not be opened: ${failedText(err)}`);
      } finally {
        setOpening(null);
      }
    },
    [open],
  );

  const guide = phase.at === 'done' ? phase.guide : null;
  const name = guide?.entity.name ?? entity.name;
  const description = guide?.entity.description ?? '';
  const long = description.length > 420;

  return createPortal(
    <div className="mm" data-modal="entity" onClick={() => !movieModalOpen() && onClose()}>
      <div className="mm-panel mm-entity" role="dialog" aria-label={`About ${name}`} data-entity={entity.kind} onClick={(e) => e.stopPropagation()}>
        <header className="mm-head">
          <span className="mm-notice">{guideHeading(entity, detail)}</span>
          <span className="mm-head-actions">
            {entity.kind === 'genre' && guide !== null && (
              <button type="button" className="ibtn hov" data-tip="Search the web again and rewrite this" data-tip-side="below" aria-label="Rewrite this guide" onClick={() => setAgain((n) => n + 1)}>
                <ArrowsClockwise weight="duotone" />
              </button>
            )}
            {onAsk !== undefined && (
              <button
                type="button"
                className="ibtn hov"
                data-tip={`Ask the chat about ${name}`}
                data-tip-side="below"
                aria-label={`Ask the chat about ${name}`}
                onClick={() => {
                  onAsk(entity);
                  onClose();
                }}
              >
                <ChatCircleText weight="duotone" />
              </button>
            )}
            {guide !== null && guide.entity.link !== null && (
              <a className="ibtn hov" href={guide.entity.link} target="_blank" rel="noopener noreferrer" data-tip="Open its page" data-tip-side="below" aria-label="Open its page">
                <ArrowSquareOut weight="duotone" />
              </a>
            )}
            <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
              <X weight="duotone" />
            </button>
          </span>
        </header>
        {(phase.at === 'loading' || phase.at === 'writing') && (
          <p className="mm-empty mm-story-wait" role="status">
            <CircleNotch className="mm-spin" weight="bold" />
            {phase.at === 'writing' ? GUIDE_WRITING_TEXT : `Reading about ${entity.name}…`}
          </p>
        )}
        {phase.at === 'failed' && (
          <p className="mm-empty mm-story-wait" role="alert">
            <WarningCircle weight="duotone" />
            {phase.text}
          </p>
        )}
        {guide !== null && (
          <div className="mm-ent-scroll">
            <div className={guide.entity.image_url === null ? 'mm-ent-top bare' : 'mm-ent-top'}>
              {guide.entity.image_url !== null && (
                <div className={`mm-ent-img ${guide.entity.kind}`}>
                  <img src={guide.entity.image_url} alt={name} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                </div>
              )}
              <div className="mm-info">
                <h2 className="mm-title">{name}</h2>
                {guide.entity.facts.length > 0 && (
                  <p className="mv-facts">
                    {guide.entity.facts.map((f, i) => (
                      <span key={i}>{f}</span>
                    ))}
                  </p>
                )}
                {description !== '' && (
                  <p className={long && !whole ? 'mm-overview mm-ent-desc clamp' : 'mm-overview mm-ent-desc'} data-testid="entity-description">
                    {description}
                  </p>
                )}
                {long && (
                  <button type="button" className="mv-ent mm-ent-more" onClick={() => setWhole((w) => !w)}>
                    {whole ? 'less' : 'more'}
                  </button>
                )}
              </div>
            </div>
            <p className="mm-notice mm-ent-count" role="status">
              {notice ?? `${guideCountLine(guide.titles)} · newest first`}
            </p>
            {guide.titles.length === 0 ? (
              <p className="mm-empty">No films or series are listed.</p>
            ) : (
              <ol className="mm-ent-list" aria-label={`Films and series of ${name}`}>
                {guide.titles.map((t) => (
                  <li key={t.title_id}>
                    <button type="button" className="mm-ent-row" data-testid="guide-title" data-title={t.title_id} data-mark={t.mark ?? undefined} disabled={opening !== null || open === undefined} onClick={() => void openTitle(t)}>
                      <span className="mm-ent-poster">
                        <Poster key={t.poster_url ?? 'none'} url={t.poster_url} title={t.title} year={t.year} />
                      </span>
                      <span className="mm-ent-t">
                        <span className="mm-ent-name">{t.title}</span>
                        <span className="mm-ent-line">{guideTitleLine(t)}</span>
                      </span>
                      <span className="mm-ent-tags">
                        {opening === t.title_id && <CircleNotch className="mm-spin" weight="bold" />}
                        {t.mark !== null && <span className={`mv-flag mm-tag ${t.mark}`}>{GUIDE_MARK_LABEL[t.mark]}</span>}
                        {t.has_file && <span className="mv-flag">file here</span>}
                        {t.movie_id !== null && <span className="mv-code">{t.movie_id}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {guide.entity.kind === 'genre' && guide.written_at != null && (
              <p className="mm-notice mm-ent-foot">
                collated{guide.model == null ? '' : ` by ${guide.model}`} from a web search · stored
              </p>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
