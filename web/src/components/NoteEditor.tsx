import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Check, Copy, Trash, X } from '@phosphor-icons/react';
import type { Note, NoteImage as NoteImageData } from '../types';
import { tagsOf } from '../lib/text';
import { NoteImage, aspectOf } from './NoteImage';
import './NoteEditor.css';

export interface NoteEditorProps {
  /** The live note from App's store: images update in place as attaches land. */
  note: Note;
  /** App's `useCopied` state for this note. */
  copied: boolean;
  /** Quiet status label, e.g. "already in K-F07" after a dedupe hit. */
  notice: string | null;
  onCopy: (id: string) => void;
  /** Blur only, and only when the draft changed since the last save. May be an empty body. */
  onSave: (note: Note, draft: string) => void;
  /** Exactly once per editor: X, backdrop or Esc. `dirty` = draft differs from the last saved text. */
  onClose: (note: Note, draft: string, dirty: boolean) => void;
  /** The strip's remove icon (soft remove; App offers a 6 s undo). */
  onRemoveImage: (image: NoteImageData) => void;
  /** Soft-delete this note with the current draft, then close without the close-time save or empty rule (R3). Absent = no trash icon. */
  onDelete?: (note: Note, draft: string) => void;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage, onDelete }: NoteEditorProps) {
  const [draft, setDraft] = useState(note.body);
  const draftRef = useRef(note.body);
  const savedRef = useRef(note.body);
  const closedRef = useRef(false);
  const noteRef = useRef(note);
  noteRef.current = note;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(noteRef.current, draftRef.current, draftRef.current !== savedRef.current);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase + preventDefault + stopPropagation (PhotoModal's seam): Esc closes only the
      // editor, never the chat panel behind it.
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const onBlur = () => {
    if (closedRef.current) return;
    if (draftRef.current === savedRef.current) return;
    savedRef.current = draftRef.current;
    onSave(noteRef.current, draftRef.current);
  };

  const tags = tagsOf(draft);

  return (
    <div className="ed" data-modal="editor" onClick={close}>
      <div className="ed-panel" role="dialog" aria-label={`Edit note ${note.id}`} onClick={stop}>
        <div className="ed-top">
          <span className="ed-id">{note.id}</span>
          <button type="button" className="copybtn" data-tip="Copy ID" aria-label="Copy ID" onClick={() => onCopy(note.id)}>
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          <span className={notice ? 'ed-notice on' : 'ed-notice'} data-notice="" aria-live="polite">
            {notice ?? ''}
          </span>
          <span className="ed-spacer" />
          {onDelete && (
            <button
              type="button"
              className="ed-btn"
              data-tip="Delete note"
              aria-label="Delete note"
              // No blur-save: App saves the draft (if changed) and deletes in one ordered sequence.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // The editor is about to unmount without close(): mark it closed so a blur fired
                // on unmount cannot onSave the note back into the store after it was deleted.
                closedRef.current = true;
                onDelete(noteRef.current, draftRef.current);
              }}
            >
              <Trash weight="duotone" />
            </button>
          )}
          <button type="button" className="ed-btn" data-tip="Close" aria-label="Close" onClick={close}>
            <X weight="duotone" />
          </button>
        </div>
        <textarea
          ref={taRef}
          className="ed-text"
          aria-label="Note text"
          value={draft}
          onChange={(e) => {
            draftRef.current = e.target.value;
            setDraft(e.target.value);
          }}
          onBlur={onBlur}
        />
        {tags.length > 0 && (
          <div className="ed-tags">
            {tags.map((t) => (
              <span key={t} className="ed-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
        {note.images.length > 0 && (
          <div className="ed-strip" data-strip="">
            {note.images.map((img) => (
              <div key={img.id} className="ed-thumb" data-image={img.id} style={{ aspectRatio: aspectOf(img).css }}>
                <NoteImage image={img} variant="thumb" className="ed-thumb-img" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button type="button" className="ed-rm" data-tip="Remove image" aria-label="Remove image" onClick={() => onRemoveImage(img)}>
                  <X weight="duotone" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
