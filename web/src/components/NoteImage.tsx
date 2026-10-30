import type { CSSProperties } from 'react';
import { thumbUrl } from '../api';
import type { Note } from '../types';

export interface NoteImageProps {
  note: Note;
  className?: string;
  style?: CSSProperties;
}

/** Phase 7 stub: always the thumbnail. Phase 8 adds the "not on this machine" placeholder when !note.image.available. */
export function NoteImage({ note, className = 'card-img', style }: NoteImageProps) {
  if (!note.image) return null;
  return (
    <img
      className={className}
      src={thumbUrl(note.id)}
      alt=""
      draggable={false}
      loading="lazy"
      style={{ aspectRatio: `${note.image.width} / ${note.image.height}`, ...style }}
    />
  );
}
