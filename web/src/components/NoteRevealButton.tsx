import type { CSSProperties, MouseEvent } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import { revealNote } from '../api';
import { useCapabilities } from '../hooks/useCapabilities';
import { noteRevealable, type Attachable } from '../lib/files';

export interface NoteRevealButtonProps {
  /** Structural so the wire `Note` and test fixtures fit. */
  note: { id: string } & Attachable;
  /** Icon-button class of the host toolbar: `copybtn` on cards (default), `ed-btn` in the editor top bar. */
  className?: string;
  style?: CSSProperties;
}

/**
 * The note-level "Show in Explorer" (R2). notesd opens the folder that holds this note's files, or
 * selects its first image when it has none (a note with neither is 404 there). It renders only when
 * notesd can reveal and `noteRevealable` says the route has something local to show.
 */
export function NoteRevealButton({ note, className = 'copybtn', style }: NoteRevealButtonProps) {
  const caps = useCapabilities();
  if (!caps.reveal || !noteRevealable(note)) return null;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    revealNote(note.id).catch((err: unknown) => {
      console.warn(`reveal note ${note.id} failed:`, err instanceof Error ? err.message : err);
    });
  };

  return (
    <button
      type="button"
      className={className}
      data-tip="Show in Explorer"
      aria-label="Show in Explorer"
      data-reveal-note={note.id}
      onClick={onClick}
      style={style}
    >
      <FolderOpen weight="duotone" />
    </button>
  );
}
