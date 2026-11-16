import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { ApiError } from '../../api';
import { writeStory, type StoryView } from '../../moviesApi';
import './MovieModal.css';

export interface StoryModalProps {
  titleId: string;
  season: number;
  episode: number;
  /** What the story is of: "One Piece S18E760 · Destruction of the Capital". */
  name: string;
  /** A story is stored: it opens at once and no model is called. */
  stored: boolean;
  onClose: () => void;
  /** Default: the daemon's story route. Tests pass a fake. */
  load?: typeof writeStory;
}

/** Why there is no story, in words. */
export function storyErrorText(code: string, detail: string | null): string {
  switch (code) {
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

type Phase = { at: 'writing' } | { at: 'done'; story: StoryView; cached: boolean } | { at: 'failed'; text: string };

/**
 * The whole story of one episode, every spoiler included, in a pop-up over the title's page.
 * Opening it is the request: the daemon reads the episode's dialogue (the English subtitle of a
 * stream source, out of sight) and has Claude write the story from it, once; after that the
 * stored story opens at once. Esc and a click outside close it; a story being written is still
 * finished and kept by the daemon.
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
            {stored ? 'Opening the story…' : 'Reading the subtitle of this episode, then writing its story. This takes a minute, once; after that it opens at once.'}
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
            {phase.story.text.split(/\n\s*\n/).map((paragraph, i) => (
              <p key={i}>{paragraph.trim()}</p>
            ))}
            <p className="mm-notice mm-story-foot">
              written{phase.story.model === null ? '' : ` by ${phase.story.model}`} from {phase.story.cues} subtitle lines ({phase.story.provider})
              {phase.cached ? ' · stored' : ' · just now, and stored'}
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
