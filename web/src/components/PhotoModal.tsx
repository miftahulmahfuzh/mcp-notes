import { useEffect, type CSSProperties, type MouseEvent } from 'react';
import { ArrowsOut, CaretLeft, CaretRight, Check, Copy, Trash, X } from '@phosphor-icons/react';
import type { Note, PhotoItem } from '../types';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';
import { RevealButton } from './RevealButton';
import './PhotoModal.css';

/** (i + d) modulo len, wrapping both ways. -1 when there is nothing to show. */
export function stepIndex(i: number, d: number, len: number): number {
  if (len <= 0) return -1;
  return (((i + d) % len) + len) % len;
}

/** Body text with #hashtags removed and whitespace collapsed (Notes Wall.dc.html:317). */
export function stripTags(body: string): string {
  return body
    .replace(/(?<![\w])#[A-Za-z0-9_-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `3 / 7  2/3  Today`: position in the whole list, then (only for multi-image notes) which image of the note. */
export function metaLine(index: number, len: number, item: Pick<PhotoItem, 'k' | 'n'>, when: string): string {
  const parts = [`${index + 1} / ${len}`];
  if (item.n > 1) parts.push(`${item.k}/${item.n}`);
  parts.push(when);
  return parts.join('  ');
}

const stop = (e: MouseEvent) => e.stopPropagation();

const navBtn: CSSProperties = {
  width: 44,
  height: 44,
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  color: '#ecebe4',
  fontSize: 22,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
};

const toolBtn: CSSProperties = { ...navBtn, width: 40, height: 40, fontSize: 19 };

/** `items` is the gallery's flattened list (one per image). Copy state is App's (`useCopied`); `onCopy` gets the note id. */
export interface PhotoModalProps {
  items: PhotoItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  copiedId: string | null;
  onCopy: (id: string) => void;
  /** Soft-delete the shown photo's note (R3), then close. Absent = no trash icon. */
  onDelete?: (note: Note) => void;
}

export function PhotoModal({ items, index, onIndex, onClose, copiedId, onCopy, onDelete }: PhotoModalProps) {
  const len = items.length;
  const item = index >= 0 && index < len ? items[index] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + preventDefault + stopPropagation: Esc closes only the modal, never the
      // chat panel behind it.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        onIndex(stepIndex(index, 1, len));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        onIndex(stepIndex(index, -1, len));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, len, onIndex, onClose]);

  if (!item) return null;
  const { note, image } = item;

  const copy = () => onCopy(note.id);
  const full = () => {
    window.open(`/full/${encodeURIComponent(image.id)}`, '_blank', 'noopener');
  };
  const copied = copiedId === note.id;
  const meta = metaLine(index, len, item, relativeDate(note.created_at, new Date()));

  return (
    <div
      data-modal="photo"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,9,.94)',
        zIndex: 60,
        display: 'grid',
        gridTemplateColumns: '56px minmax(0,1fr) 300px 56px',
        // One row exactly as tall as the viewport minus padding: a long description scrolls inside
        // its column instead of stretching the row (which pushed the photo off-screen).
        gridTemplateRows: 'minmax(0,1fr)',
        alignItems: 'center',
        gap: 16,
        padding: '24px 16px',
        boxSizing: 'border-box',
      }}
    >
      <button
        type="button"
        className="pm-btn"
        data-tip="Previous"
        aria-label="Previous"
        onClick={(e) => {
          e.stopPropagation();
          onIndex(stepIndex(index, -1, len));
        }}
        style={navBtn}
      >
        <CaretLeft weight="duotone" />
      </button>

      <div style={{ height: '100%', display: 'grid', placeItems: 'center', minWidth: 0, minHeight: 0 }}>
        <NoteImage key={image.id} image={image} variant="display" onClick={stop} />
      </div>

      <div onClick={stop} style={{ alignSelf: 'stretch', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 4 }}>
        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button type="button" className="pm-btn" data-tip="Copy ID" aria-label="Copy ID" onClick={copy} style={toolBtn}>
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <RevealButton image={image} className="pm-btn" style={toolBtn} />
          <button type="button" className="pm-btn" data-tip="Show full screen" aria-label="Show full screen" onClick={full} style={toolBtn}>
            <ArrowsOut weight="duotone" />
          </button>
          {onDelete && (
            <button
              type="button"
              className="pm-btn"
              data-tip="Delete note"
              aria-label="Delete note"
              onClick={() => {
                onDelete(note);
                onClose();
              }}
              style={toolBtn}
            >
              <Trash weight="duotone" />
            </button>
          )}
          <button type="button" className="pm-btn" data-tip="Close" aria-label="Close" onClick={onClose} style={toolBtn}>
            <X weight="duotone" />
          </button>
        </div>
        <div className="pm-scroll" data-pm-scroll="">
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, color: '#e4e3dc', textWrap: 'pretty' } as CSSProperties}>
            {stripTags(note.body)}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {note.tags.map((t) => (
              <span key={t} style={{ fontSize: 11, padding: '3px 8px 4px', borderRadius: 999, background: '#2a2a27', color: '#d6d5cd' }}>
                #{t}
              </span>
            ))}
          </div>
          <div style={{ height: 1, background: 'rgba(236,235,228,.1)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'Geist Mono',monospace", fontSize: 11, color: '#bdbcb4' }}>
            <span>{note.id}</span>
            <span style={{ opacity: copied ? 1 : 0, color: '#8a897f', transition: 'opacity .25s' }}>copied</span>
            <span data-meta="" style={{ marginLeft: 'auto', color: '#8a897f' }}>
              {meta}
            </span>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="pm-btn"
        data-tip="Next"
        aria-label="Next"
        onClick={(e) => {
          e.stopPropagation();
          onIndex(stepIndex(index, 1, len));
        }}
        style={navBtn}
      >
        <CaretRight weight="duotone" />
      </button>
    </div>
  );
}
