import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, CaretRight, ChatCircleDots, X } from '@phosphor-icons/react';
import { imageUrl } from '../api';
import type { NoteImage as NoteImageData } from '../types';
import { FILM_FILTER, ImagePlaceholder, aspectOf } from './NoteImage';
import './Lightbox.css';

/**
 * One image the lightbox can show. Generic on purpose: note images (`noteImageItems`) and chat
 * images (Phase 9: `src` = `/api/chat/images/<id>/display`) both fit.
 */
export interface LightboxItem {
  /** Stable identity (note image id or chat image id); also the React key of the `<img>`. */
  id: string;
  /** URL of the large rendition. */
  src: string;
  /** Short caption under the image (Geist Mono) and the image's alt text, e.g. the original file name. */
  label?: string;
  /** Natural size, for the aspect ratio of the image box and the error placeholder. 0/absent = 3:2. */
  width?: number;
  height?: number;
  /** Apply the wall's film tone (note images). Chat uploads leave it off. */
  film?: boolean;
}

export interface LightboxProps {
  items: LightboxItem[];
  /** The shown item. Out of range renders nothing (the host should then drop its "viewing" state). */
  index: number;
  /** Called with the adjacent index only; never with a wrapped or out-of-range index. */
  onIndex: (index: number) => void;
  /** Esc, a backdrop click or the X. The host unmounts the lightbox. */
  onClose: () => void;
  /** "Chat about this image": gets the shown item (its `id` is the note image id). Absent = no icon. */
  onChatAbout?: (item: LightboxItem) => void;
}

/** The lightbox root carries `data-lightbox`; its presence in the DOM means "a lightbox is open". */
export const LIGHTBOX_SELECTOR = '[data-lightbox]';

/**
 * True while a lightbox is mounted. Every other modal key listener that runs before the lightbox's
 * own (an earlier-registered window capture listener, e.g. NoteEditor's Esc) must return early when
 * this is true: stopPropagation in the lightbox cannot stop a listener on the same target that
 * already ran.
 */
export function isLightboxOpen(doc: Document = document): boolean {
  return doc.querySelector(LIGHTBOX_SELECTOR) !== null;
}

/** i + d when it stays inside [0, len), else -1. No wraparound: the lightbox stops at the ends. */
export function adjacentIndex(i: number, d: -1 | 1, len: number): number {
  const j = i + d;
  return j >= 0 && j < len ? j : -1;
}

/** A note's images as lightbox items: only those whose bytes are on this machine, in note order. */
export function noteImageItems(images: NoteImageData[]): LightboxItem[] {
  return images
    .filter((img) => img.available)
    .map((img) => ({
      id: img.id,
      src: imageUrl(img.id, 'display'),
      label: img.original_name ?? img.id,
      width: img.width,
      height: img.height,
      film: true,
    }));
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function Lightbox({ items, index, onIndex, onClose, onChatAbout }: LightboxProps) {
  const len = items.length;
  const item = index >= 0 && index < len ? items[index] : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // The one window listener reads the latest props through this ref, so it is registered once and
  // keeps its place in the listener order for the lightbox's whole life.
  const live = useRef({ index, len, onIndex, onClose });
  live.current = { index, len, onIndex, onClose };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      if (e.key !== 'Escape' && !arrow) return;
      // Alt/Ctrl/Meta + arrow is the browser's (history, word jumps): leave it alone.
      if (arrow && (e.altKey || e.ctrlKey || e.metaKey)) return;
      // Capture phase + preventDefault + stopPropagation (PhotoModal's seam) so the chat panel's
      // document listener never sees it, + stopImmediatePropagation for window capture listeners
      // registered after this one. Listeners registered before it yield via isLightboxOpen().
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const s = live.current;
      if (e.key === 'Escape') {
        s.onClose();
        return;
      }
      const j = adjacentIndex(s.index, e.key === 'ArrowLeft' ? -1 : 1, s.len);
      if (j >= 0) s.onIndex(j);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    // Take focus so keyboard users are inside the viewer; give it back to the opener (e.g. the strip
    // thumbnail) on close, if it is still in the document.
    const opener = document.activeElement;
    rootRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  if (!item) return null;

  const { css } = aspectOf({ width: item.width ?? 0, height: item.height ?? 0 });
  const prev = adjacentIndex(index, -1, len);
  const next = adjacentIndex(index, 1, len);
  const close = (e: MouseEvent) => {
    // Stop first: React bubbles through portals, and a host modal's backdrop handler (NoteEditor's
    // `.ed` onClick) must not see this click.
    e.stopPropagation();
    onClose();
  };

  return createPortal(
    <div
      ref={rootRef}
      className="lb"
      data-lightbox=""
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      onClick={close}
    >
      <div className="lb-top">
        {onChatAbout && (
          <button
            type="button"
            className="lb-btn"
            data-tip="Chat about this image"
            data-tip-side="below"
            aria-label="Chat about this image"
            onClick={(e) => {
              e.stopPropagation();
              onChatAbout(item);
            }}
          >
            <ChatCircleDots weight="duotone" />
          </button>
        )}
        <button type="button" className="lb-btn" data-tip="Close" data-tip-side="below" aria-label="Close image viewer" onClick={close}>
          <X weight="duotone" />
        </button>
      </div>

      <div className="lb-nav lb-nav-prev" onClick={stop}>
        <button
          type="button"
          className="lb-btn"
          data-tip="Previous"
          aria-label="Previous image"
          disabled={prev < 0}
          onClick={() => {
            if (prev >= 0) onIndex(prev);
          }}
        >
          <CaretLeft weight="duotone" />
        </button>
      </div>

      <div className="lb-stage">
        {failedSrc === item.src ? (
          <ImagePlaceholder aspect={css} caption="unavailable" width="min(100%, 480px)" onClick={stop} />
        ) : (
          <img
            key={item.id}
            className="lb-img"
            src={item.src}
            alt={item.label ?? ''}
            draggable={false}
            decoding="async"
            onClick={stop}
            onError={() => setFailedSrc(item.src)}
            style={{ aspectRatio: css, filter: item.film ? FILM_FILTER : undefined }}
          />
        )}
      </div>

      <div className="lb-nav lb-nav-next" onClick={stop}>
        <button
          type="button"
          className="lb-btn"
          data-tip="Next"
          aria-label="Next image"
          disabled={next < 0}
          onClick={() => {
            if (next >= 0) onIndex(next);
          }}
        >
          <CaretRight weight="duotone" />
        </button>
      </div>

      <div className="lb-meta" onClick={stop}>
        <span data-lightbox-count="">
          {index + 1} / {len}
        </span>
        {item.label ? <span className="lb-label">{item.label}</span> : null}
      </div>
    </div>,
    document.body,
  );
}
