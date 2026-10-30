import type { Note } from '../types';

export interface GalleryProps {
  /** Image notes passing the tag filter, in wall order. */
  photos: Note[];
  copiedId: string | null;
  onCopy: (id: string) => void;
}

/** Phase 7 stub. Phase 8 renders the justified grid and owns PhotoModal state. */
export function Gallery({ photos }: GalleryProps) {
  return <section className="gallery" data-count={photos.length} style={{ paddingTop: 30 }} />;
}
