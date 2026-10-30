import type { CSSProperties, MouseEvent } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import { revealImage } from '../api';
import { useCapabilities } from '../hooks/useCapabilities';

export interface RevealButtonProps {
  /** The image to reveal. Structural so the wire `NoteImage` (and test fixtures) fit. */
  image: { id: string; available: boolean };
  /** Icon-button class of the host toolbar: `copybtn` on cards (default), `pm-btn` in the modal. */
  className?: string;
  style?: CSSProperties;
}

/** "Show in Explorer": rendered only when notesd can reveal files and this image's original is on this machine. */
export function RevealButton({ image, className = 'copybtn', style }: RevealButtonProps) {
  const caps = useCapabilities();
  if (!caps.reveal || !image.available) return null;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    revealImage(image.id).catch((err: unknown) => {
      console.warn(`reveal ${image.id} failed:`, err instanceof Error ? err.message : err);
    });
  };

  return (
    <button
      type="button"
      className={className}
      data-tip="Show in Explorer"
      aria-label="Show in Explorer"
      data-reveal={image.id}
      onClick={onClick}
      style={style}
    >
      <FolderOpen weight="duotone" />
    </button>
  );
}
