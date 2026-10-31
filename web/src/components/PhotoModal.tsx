import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { ArrowsOut, CaretLeft, CaretRight, ChatCircleDots, Check, Copy, Trash, X } from '@phosphor-icons/react';
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
  /**
   * The note text is click-to-edit; blur saves the draft (the whole body, hashtags included) when
   * it changed. App's `save`, the same writer the text editor uses. Absent = read-only text.
   */
  onSave?: (note: Note, draft: string) => void;
  /** "Chat about this image": opens the chat history with this image attached by id (no copy). Absent = no icon. */
  onChatAbout?: (imageId: string) => void;
}

/**
 * The note text of the photo modal. Read mode shows the body without its #hashtags (they appear as
 * chips below); a click swaps in a textarea holding the RAW body, so saving never drops a tag.
 * Blur saves when the draft changed, then returns to read mode. `exitRef` lets the modal's Esc
 * handler leave edit mode without closing the modal; `editingRef` tells it (and the arrow keys)
 * that a caret is in the text.
 */
function NoteText({
  note,
  onSave,
  editingRef,
  exitRef,
}: {
  note: Note;
  onSave?: (note: Note, draft: string) => void;
  editingRef: { current: boolean };
  exitRef: { current: (() => void) | null };
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const finish = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    const text = draftRef.current;
    if (text !== noteRef.current.body) onSave?.(noteRef.current, text);
  };
  exitRef.current = editing ? finish : null;

  useEffect(
    () => () => {
      // Unmounted mid-edit (another photo, the modal closing): the blur never fires, so save here.
      if (editingRef.current) {
        editingRef.current = false;
        if (draftRef.current !== noteRef.current.body) onSave?.(noteRef.current, draftRef.current);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!editing || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  useEffect(() => {
    const el = taRef.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const begin = () => {
    if (!onSave || editingRef.current) return;
    setDraft(noteRef.current.body);
    draftRef.current = noteRef.current.body;
    editingRef.current = true;
    setEditing(true);
  };

  const textStyle: CSSProperties = { margin: 0, fontSize: 15, lineHeight: 1.45, color: '#e4e3dc', textWrap: 'pretty' } as CSSProperties;

  if (editing) {
    return (
      <textarea
        ref={taRef}
        data-pm-edit=""
        aria-label="Note text"
        className="pm-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={finish}
        style={{ ...textStyle, width: '100%', boxSizing: 'border-box', resize: 'none', overflow: 'hidden', font: 'inherit', fontSize: 15 }}
      />
    );
  }
  const shown = stripTags(note.body);
  return (
    <p
      data-pm-text=""
      className={onSave ? 'pm-text pm-text-editable' : 'pm-text'}
      role={onSave ? 'button' : undefined}
      tabIndex={onSave ? 0 : undefined}
      aria-label={onSave ? 'Edit note text' : undefined}
      onClick={begin}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onSave) {
          e.preventDefault();
          begin();
        }
      }}
      style={{ ...textStyle, ...(shown === '' ? { color: '#8a897f' } : {}) }}
    >
      {shown === '' ? (onSave ? 'Add a description…' : '') : shown}
    </p>
  );
}

export function PhotoModal({ items, index, onIndex, onClose, copiedId, onCopy, onDelete, onSave, onChatAbout }: PhotoModalProps) {
  const len = items.length;
  const editingRef = useRef(false);
  const exitEditRef = useRef<(() => void) | null>(null);
  const item = index >= 0 && index < len ? items[index] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + preventDefault + stopPropagation: Esc closes only the modal, never the
      // chat panel behind it.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Editing the text: Esc saves and leaves the textarea; the modal stays.
        if (editingRef.current) exitEditRef.current?.();
        else onClose();
      } else if (editingRef.current) {
        // A caret is in the text: the arrows move it instead of changing photo.
        return;
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
          {onChatAbout && (
            <button
              type="button"
              className="pm-btn"
              data-tip="Chat about this image"
              aria-label="Chat about this image"
              onClick={() => onChatAbout(image.id)}
              style={toolBtn}
            >
              <ChatCircleDots weight="duotone" />
            </button>
          )}
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
          <NoteText key={note.id} note={note} onSave={onSave} editingRef={editingRef} exitRef={exitEditRef} />
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
            {image.id !== note.id && (
              <span data-image-id="" style={{ color: '#8a897f' }}>
                img {image.id}
              </span>
            )}
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
