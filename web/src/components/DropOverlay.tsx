import type { Note } from '../types';

export interface DropOverlayProps {
  /** Call once per note returned by POST /api/images. App inserts it and switches text -> all. */
  onImageAdded: (note: Note) => void;
}

/** Phase 7 stub. Phase 8 owns drag/drop/paste listeners, upload, and the dashed overlay. */
export function DropOverlay(_props: DropOverlayProps) {
  return null;
}
