import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, X } from '@phosphor-icons/react';
import { trailerEmbedUrl, trailerWatchUrl } from '../../lib/movies';
import './MovieModal.css';

export interface TrailerModalProps {
  /** YouTube video id, as TMDB lists it. */
  videoKey: string;
  /** What the trailer is of: "How to Make a Killing (2026)", "MobLand, season 1". */
  name: string;
  onClose: () => void;
}

/**
 * A trailer, played from YouTube in a pop-up over the title's page. It starts at once. The header
 * opens the same video on YouTube, for the ones whose owner does not allow playing elsewhere.
 * Esc and a click outside close it, which also stops the video.
 */
export function TrailerModal({ videoKey, name, onClose }: TrailerModalProps) {
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
    <div className="mm" data-modal="trailer" onClick={onClose}>
      <div className="mm-panel mm-trailer" role="dialog" aria-label={`Trailer of ${name}`} onClick={(e) => e.stopPropagation()}>
        <header className="mm-head">
          <span className="mm-notice">trailer · {name}</span>
          <span className="mm-head-actions">
            <a className="ibtn hov" href={trailerWatchUrl(videoKey)} target="_blank" rel="noopener noreferrer" data-tip="Open on YouTube" data-tip-side="below" aria-label="Open on YouTube">
              <ArrowSquareOut weight="duotone" />
            </a>
            <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
              <X weight="duotone" />
            </button>
          </span>
        </header>
        <iframe
          className="mm-frame"
          src={trailerEmbedUrl(videoKey)}
          title={`Trailer of ${name}`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </div>,
    document.body,
  );
}
