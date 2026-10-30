import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { NoteImage, aspectOf, type ImageInfo, type ImageNote } from './NoteImage';
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

/** Phase 7's stub props; `photos` widened to `ImageNote` (phase 7's `Note` is assignable). They arrive tag-filtered (phase 7's `photosOf`). */
export interface GalleryProps {
  photos: ImageNote[];
  copiedId: string | null;
  onCopy: (id: string) => void;
}

export function Gallery({ photos, copiedId, onCopy }: GalleryProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const index = openId === null ? -1 : photos.findIndex((p) => p.id === openId);

  const onIndex = useCallback(
    (i: number) => {
      const p = photos[i];
      setOpenId(p ? p.id : null);
    },
    [photos],
  );
  const onClose = useCallback(() => setOpenId(null), []);

  return (
    <>
      {/* className kept from phase 7's stub: App.test.tsx finds the gallery by `.gallery`. */}
      <section className="gallery" data-gallery="" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 30 }}>
        {photos.map((p) => {
          const t = galleryTile(p.image);
          return (
            <div
              key={p.id}
              data-photo={p.id}
              data-note={p.id}
              onClick={() => setOpenId(p.id)}
              style={{ flex: `${t.grow} 1 ${t.basis}px`, cursor: 'zoom-in', background: '#1c1c1a' }}
            >
              <NoteImage note={p} variant="thumb" />
            </div>
          );
        })}
        <div data-gallery-spacer="" style={{ flex: '999 1 0px' }} />
      </section>
      {index >= 0
        ? createPortal(
            <PhotoModal photos={photos} index={index} onIndex={onIndex} onClose={onClose} copiedId={copiedId} onCopy={onCopy} />,
            document.body,
          )
        : null}
    </>
  );
}
