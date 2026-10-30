import { useState, type CSSProperties, type MouseEvent } from 'react';
import { ImageBroken } from '@phosphor-icons/react';
import { imageUrl } from '../api';
import type { NoteImage as NoteImageData } from '../types';

/** Film tone from the design (Notes Wall.dc.html:282). Wall, gallery and modal only. */
export const FILM_FILTER = 'sepia(.14) saturate(1.12) contrast(1.05) brightness(.97)';

/** The subset of the wire `NoteImage` this file reads. Any wire `NoteImage` is assignable. */
export type ImageInfo = Pick<NoteImageData, 'id' | 'width' | 'height' | 'available' | 'host'>;

export type ImageVariant = 'thumb' | 'display';

/** Aspect ratio of an image, falling back to 3:2 when dimensions are missing or zero. */
export function aspectOf(image: Pick<ImageInfo, 'width' | 'height'> | null | undefined): {
  w: number;
  h: number;
  ratio: number;
  css: string;
} {
  const w = image && image.width > 0 ? image.width : 3;
  const h = image && image.height > 0 ? image.height : 2;
  return { w, h, ratio: w / h, css: `${w} / ${h}` };
}

type PlaceholderProps = {
  aspect: string;
  caption: string;
  host?: string | null;
  width?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
};

/**
 * A box at the image's aspect ratio: a duotone icon and a tiny Geist Mono status caption.
 * The caption is a status label, not a control.
 */
export function ImagePlaceholder({ aspect, caption, host, width, onClick }: PlaceholderProps) {
  return (
    <div
      role="img"
      aria-label={host ? `${caption}, ${host}` : caption}
      data-placeholder="image"
      onClick={onClick}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: width ?? '100%',
        aspectRatio: aspect,
        background: '#1c1c1a',
        color: '#8a897f',
        boxSizing: 'border-box',
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' }}>
        <ImageBroken weight="duotone" size={28} color="#bdbcb4" />
        <span style={{ fontFamily: "'Geist Mono',monospace", fontSize: 10.5, letterSpacing: '.03em', lineHeight: 1.3 }}>
          {caption}
        </span>
        {host ? (
          <span style={{ fontFamily: "'Geist Mono',monospace", fontSize: 10.5, letterSpacing: '.03em', lineHeight: 1.3, opacity: 0.7 }}>
            {host}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** `variant` defaults to 'thumb' (wall cover, gallery tile); the modal passes 'display'. */
export type NoteImageProps = {
  image: ImageInfo;
  variant?: ImageVariant;
  className?: string;
  style?: CSSProperties;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
};

/**
 * One image, with the film tone, fetched by its image id.
 * - `thumb`: wall cover and gallery tile (Notes Wall.dc.html:72, 97): full width, height from the aspect ratio.
 * - `display`: the modal (Notes Wall.dc.html:135): the display derivative, never a downscaled guess.
 */
export function NoteImage({ image, variant = 'thumb', className = variant === 'thumb' ? 'card-img' : undefined, style, onClick }: NoteImageProps) {
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const key = `${image.id}/${variant}`;
  const { ratio, css } = aspectOf(image);
  const placeholderWidth = variant === 'display' ? `min(100%, calc((100vh - 48px) * ${ratio.toFixed(4)}))` : undefined;

  if (!image.available) {
    return (
      <ImagePlaceholder aspect={css} caption="not on this machine" host={image.host ?? null} width={placeholderWidth} onClick={onClick} />
    );
  }
  if (failedKey === key) {
    return <ImagePlaceholder aspect={css} caption="unavailable" width={placeholderWidth} onClick={onClick} />;
  }

  const base: CSSProperties =
    variant === 'thumb'
      ? { display: 'block', width: '100%', height: 'auto', aspectRatio: css, filter: FILM_FILTER, background: '#1c1c1a' }
      : { display: 'block', maxWidth: '100%', maxHeight: 'calc(100vh - 48px)', aspectRatio: css, filter: FILM_FILTER };

  return (
    <img
      className={className}
      src={imageUrl(image.id, variant)}
      alt=""
      draggable={false}
      loading={variant === 'thumb' ? 'lazy' : undefined}
      decoding="async"
      onClick={onClick}
      onError={() => setFailedKey(key)}
      style={{ ...base, ...style }}
    />
  );
}
