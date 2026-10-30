import type { Note } from '../types';

export interface PhotoModalProps {
  photos: Note[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  copiedId: string | null;
  onCopy: (id: string) => void;
}

/** Phase 7 stub. Phase 8 implements the modal; its keydown listener must use capture + preventDefault. */
export function PhotoModal(_props: PhotoModalProps) {
  return null;
}
