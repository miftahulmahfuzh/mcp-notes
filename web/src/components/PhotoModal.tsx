import { useEffect, type CSSProperties, type MouseEvent } from 'react';
import { ArrowsOut, CaretLeft, CaretRight, Check, Copy, X } from '@phosphor-icons/react';
import { relativeDate } from '../lib/dates';
import { NoteImage, type ImageNote } from './NoteImage';
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

/** Phase 7's stub props; `photos` widened to the structural `ImageNote` (phase 7's `Note` is assignable). Copy state is App's (`useCopied`). */
export interface PhotoModalProps {
  photos: ImageNote[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  copiedId: string | null;
  onCopy: (id: string) => void;
}

export function PhotoModal({ photos, index, onIndex, onClose, copiedId, onCopy }: PhotoModalProps) {
  const len = photos.length;
  const photo = index >= 0 && index < len ? photos[index] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + preventDefault (phase 7's keyboard seam) + stopPropagation: Esc closes
      // only the modal, never the chat panel behind it.
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

  if (!photo) return null;

  const copy = () => onCopy(photo.id);
  const full = () => {
    window.open(`/full/${encodeURIComponent(photo.id)}`, '_blank', 'noopener');
  };
  const copied = copiedId === photo.id;
  const meta = `${index + 1} / ${len}  ${relativeDate(photo.created_at, new Date())}`;

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

      <div style={{ height: '100%', display: 'grid', placeItems: 'center', minWidth: 0 }}>
        <NoteImage key={photo.id} note={photo} variant="display" onClick={stop} />
      </div>

      <div onClick={stop} style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 4 }}>
        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
          <button type="button" className="pm-btn" data-tip="Copy ID" aria-label="Copy ID" onClick={copy} style={toolBtn}>
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <button type="button" className="pm-btn" data-tip="Show full screen" aria-label="Show full screen" onClick={full} style={toolBtn}>
            <ArrowsOut weight="duotone" />
          </button>
          <button type="button" className="pm-btn" data-tip="Close" aria-label="Close" onClick={onClose} style={toolBtn}>
            <X weight="duotone" />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, color: '#e4e3dc', textWrap: 'pretty' } as CSSProperties}>
          {stripTags(photo.body)}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {photo.tags.map((t) => (
            <span key={t} style={{ fontSize: 11, padding: '3px 8px 4px', borderRadius: 999, background: '#2a2a27', color: '#d6d5cd' }}>
              #{t}
            </span>
          ))}
        </div>
        <div style={{ height: 1, background: 'rgba(236,235,228,.1)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'Geist Mono',monospace", fontSize: 11, color: '#bdbcb4' }}>
          <span>{photo.id}</span>
          <span style={{ opacity: copied ? 1 : 0, color: '#8a897f', transition: 'opacity .25s' }}>copied</span>
          <span data-meta="" style={{ marginLeft: 'auto', color: '#8a897f' }}>
            {meta}
          </span>
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
