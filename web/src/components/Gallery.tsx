import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Note, PhotoItem } from '../types';
import { NoteImage, aspectOf, type ImageInfo } from './NoteImage';
import { PhotoModal } from './PhotoModal';

export const GALLERY_ROW_HEIGHT = 230;

/** Flex values for one gallery tile (Notes Wall.dc.html:313). */
export function galleryTile(image: Pick<ImageInfo, 'width' | 'height'> | null): {
  grow: string;
  basis: number;
  ar: string;
} {
  const { ratio, css } = aspectOf(image);
  return { grow: ratio.toFixed(3), basis: Math.round(ratio * GALLERY_ROW_HEIGHT), ar: css };
}

/** `items` arrive tag-filtered and flattened, one per image (`photosOf`). */
export interface GalleryProps {
  items: PhotoItem[];
  copiedId: string | null;
  onCopy: (id: string) => void;
  /** Passed to the photo modal's trash icon. */
  onDelete?: (note: Note) => void;
}

export function Gallery({ items: all, copiedId, onCopy, onDelete }: GalleryProps) {
  /** Photos whose file is not on this machine are left out: a placeholder tile is a hole in the grid. */
  const items = useMemo(() => all.filter((it) => it.image.available), [all]);
  /** The open image's id; the modal hides itself when that image leaves `items`. */
  const [openId, setOpenId] = useState<string | null>(null);
  const index = openId === null ? -1 : items.findIndex((it) => it.image.id === openId);

  const onIndex = useCallback(
    (i: number) => {
      const it = items[i];
      setOpenId(it ? it.image.id : null);
    },
    [items],
  );
  const onClose = useCallback(() => setOpenId(null), []);

  return (
    <>
      {/* App.test.tsx finds the gallery by `.gallery`. */}
      <section className="gallery" data-gallery="" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 30 }}>
        {items.map((it) => {
          const t = galleryTile(it.image);
          return (
            <div
              key={it.image.id}
              data-photo={it.image.id}
              data-note={it.note.id}
              onClick={() => setOpenId(it.image.id)}
              style={{ flex: `${t.grow} 1 ${t.basis}px`, cursor: 'zoom-in', background: '#1c1c1a' }}
            >
              <NoteImage image={it.image} variant="thumb" />
            </div>
          );
        })}
        <div data-gallery-spacer="" style={{ flex: '999 1 0px' }} />
      </section>
      {index >= 0
        ? createPortal(
            <PhotoModal items={items} index={index} onIndex={onIndex} onClose={onClose} copiedId={copiedId} onCopy={onCopy} onDelete={onDelete} />,
            document.body,
          )
        : null}
    </>
  );
}
