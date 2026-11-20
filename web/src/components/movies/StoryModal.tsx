import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { ApiError } from '../../api';
import { writeStory, type StorySection, type StoryView } from '../../moviesApi';
import { episodeCode } from '../../lib/movies';
import './MovieModal.css';

export interface StoryModalProps {
  titleId: string;
  season: number;
  /** The episode; null: the whole season's story, one section per episode. */
  episode: number | null;
  /** What the story is of: "One Piece S18E760 · Destruction of the Capital", "MobLand S01". */
  name: string;
  /** A story is stored: it opens at once and no model is called. */
  stored: boolean;
  onClose: () => void;
  /** Default: the daemon's story route. Tests pass a fake. */
  load?: typeof writeStory;
}

/** What an episode of a season's story says when no web source told it. */
export const STORY_NOT_FOUND_TEXT = 'No published recap was found for this episode.';

/** Why there is no story, in words. */
export function storyErrorText(code: string, detail: string | null): string {
  switch (code) {
    case 'no_story_source':
      return 'No published recap of this was found on the web, and no subtitle could stand in for it, so no story was written.';
    case 'no_subtitle':
      return 'A stream of this episode was found, but it has no English subtitle to write the story from.';
    case 'no_source':
      return 'No stream provider has this episode, so its subtitle could not be read.';
    case 'story_off':
      return 'Stories are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, or Claude Code is not installed here).';
    case 'no_dialogue':
    case 'direct_stream_off':
      return 'The dialogue of this episode is not stored, and direct streaming is off on this machine, so it cannot be read here.';
    case 'resolve_failed':
      return 'The streaming Chrome could not be used to read the subtitle.';
    default:
      return detail ?? `The story could not be written (${code}).`;
  }
}

/** What the pop-up says while the story opens or is being written. */
export function storyWaitText(episode: number | null, stored: boolean): string {
  if (stored) return 'Opening the story…';
  return episode === null
    ? 'Searching the web for published recaps of this season, then writing its story episode by episode. This can take a minute or two, once; after that it opens at once.'
    : 'Searching the web for a published recap of this episode, then writing its story (from its subtitle only when the web has none). This can take a minute or two, once; after that it opens at once.';
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function sectionHeading(season: number, s: StorySection): string {
  const code = episodeCode(season, s.episode);
  return s.name === null ? code : `${code} · ${s.name}`;
}

/** Who wrote it, from what, and whether it was just written. */
function storyFoot(story: StoryView, cached: boolean): string {
  const by = story.model === null ? 'written' : `written by ${story.model}`;
  const from =
    story.origin === 'web'
      ? `from ${story.sources.length} web ${story.sources.length === 1 ? 'source' : 'sources'}`
      : `from ${story.cues ?? 0} subtitle lines${story.provider === null ? '' : ` (${story.provider})`}`;
  return `${by} ${from}${cached ? ' · stored' : ' · just now, and stored'}`;
}

type Phase = { at: 'writing' } | { at: 'done'; story: StoryView; cached: boolean } | { at: 'failed'; text: string };

/**
 * The whole story of one episode, or of a whole season, every spoiler included, in a pop-up over
 * the title's page. Opening it is the request: the daemon writes the story once from published
 * recaps on the web (an episode falls back to its subtitle when the web has none) and keeps it;
 * after that the stored story opens at once. A season's story has one section per episode; the
 * pages it was written from are listed as links under it. Esc and a click outside close it; a
 * story being written is still finished and kept by the daemon.
 */
export function StoryModal({ titleId, season, episode, name, stored, onClose, load = writeStory }: StoryModalProps) {
  const [phase, setPhase] = useState<Phase>({ at: 'writing' });
  useEffect(() => {
    let gone = false;
    setPhase({ at: 'writing' });
    load(titleId, season, episode).then(
      (r) => {
        if (!gone) setPhase({ at: 'done', story: r.story, cached: r.cached });
      },
      (err: unknown) => {
        if (gone) return;
        const code = err instanceof ApiError ? err.message : 'story_failed';
        setPhase({ at: 'failed', text: storyErrorText(code, err instanceof ApiError ? err.detail : err instanceof Error ? err.message : null) });
      },
    );
    return () => {
      gone = true;
    };
  }, [titleId, season, episode, load]);

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

  return createPortal(
    <div className="mm" data-modal="story" onClick={onClose}>
      <div className="mm-panel mm-story" role="dialog" aria-label={`Story of ${name}`} onClick={(e) => e.stopPropagation()}>
        <header className="mm-head">
          <span className="mm-notice">story · full spoilers · {name}</span>
          <span className="mm-head-actions">
            <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
              <X weight="duotone" />
            </button>
          </span>
        </header>
        {phase.at === 'writing' && (
          <p className="mm-empty mm-story-wait" role="status">
            <CircleNotch className="mm-spin" weight="bold" />
            {storyWaitText(episode, stored)}
          </p>
        )}
        {phase.at === 'failed' && (
          <p className="mm-empty mm-story-wait" role="alert">
            <WarningCircle weight="duotone" />
            {phase.text}
          </p>
        )}
        {phase.at === 'done' && (
          <div className="mm-story-text">
            {phase.story.sections.length > 0
              ? phase.story.sections.map((s) => {
                  const heading = sectionHeading(phase.story.season, s);
                  return (
                    <section key={s.episode} className="mm-story-sec" aria-label={heading} data-found={s.found ? undefined : 'false'}>
                      <h3 className="mm-story-h">{heading}</h3>
                      {s.found ? paragraphs(s.text).map((p, i) => <p key={i}>{p}</p>) : <p className="mm-story-none">{STORY_NOT_FOUND_TEXT}</p>}
                    </section>
                  );
                })
              : paragraphs(phase.story.text).map((p, i) => <p key={i}>{p}</p>)}
            {phase.story.sources.length > 0 && (
              <section className="mm-story-sources" aria-label="Sources">
                <h3 className="mm-story-h">Sources</h3>
                <ul>
                  {phase.story.sources.map((src) => (
                    <li key={src.url}>
                      <a href={src.url} target="_blank" rel="noreferrer">
                        {src.title}
                      </a>
                      <span className="mm-notice"> · {src.site}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="mm-notice mm-story-foot">{storyFoot(phase.story, phase.cached)}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
