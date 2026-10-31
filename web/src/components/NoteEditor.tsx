import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react';
import { Check, Copy, Crosshair, Paperclip, Trash, X } from '@phosphor-icons/react';
import type { Note, NoteFile, NoteImage as NoteImageData, TagCount } from '../types';
import { tagsOf, tagQueryAt, suggestTags } from '../lib/text';
import { NoteImage, aspectOf } from './NoteImage';
import { RevealButton } from './RevealButton';
import { Lightbox, isLightboxOpen, noteImageItems } from './Lightbox';
import { FileChips } from './FileChips';
import { NoteRevealButton } from './NoteRevealButton';
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
  /** Existing tags (App's store) offered while typing `#…`. Absent = no autocomplete. */
  tags?: TagCount[];
  /** Bumped by App to close this editor the normal way (draft saved, empty rule), e.g. a deep link to another note. The value at mount never closes it. */
  closeSignal?: number;
  /** Phase 5 (R2): files picked with the paperclip, in order. App routes images to `/images` and the rest to `/files`. Absent = no paperclip. */
  onAttachFiles?: (files: File[]) => void;
  /** Phase 5 (R2): a file chip's remove icon (soft remove; App offers a 6 s undo). Absent = no remove icon on chips. */
  onRemoveFile?: (file: NoteFile) => void;
  /** Phase 11: the "Show on wall" icon. The editor first closes the normal way (draft saved, empty rule), then this runs. Absent = no icon. */
  onShowOnWall?: (note: Note) => void;
  /** "Chat about this image" in the image viewer: the editor first closes the normal way (draft saved), then this runs with the note image id. Absent = no icon. */
  onChatAbout?: (imageId: string) => void;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function NoteEditor({ note, copied, notice, onCopy, onSave, onClose, onRemoveImage, onDelete, onAttachFiles, onRemoveFile, onShowOnWall, onChatAbout, tags: knownTags = [], closeSignal = 0 }: NoteEditorProps) {
  const [draft, setDraft] = useState(note.body);
  const draftRef = useRef(note.body);
  const savedRef = useRef(note.body);
  const closedRef = useRef(false);
  const noteRef = useRef(note);
  noteRef.current = note;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(note.body.length);
  const [active, setActive] = useState(0);
  // Start index of the `#…` token whose popup Esc dismissed; a new token reopens it.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  // Phase 5: the hidden multi-file input the paperclip clicks.
  const pickerRef = useRef<HTMLInputElement>(null);
  const files = note.files ?? [];
  // Id of the strip image shown in the lightbox (R4), or null. An id, not an index: attaches and
  // removes while it is open must not shift it onto another image.
  const [viewing, setViewing] = useState<string | null>(null);

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

  const mountSignal = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal !== mountSignal.current) close();
  }, [closeSignal, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A lightbox over the editor owns Esc. It registers its own window capture listener after this
      // one, so its stopPropagation cannot keep this listener from running: yield while it is open.
      if (isLightboxOpen()) return;
      if (popupRef.current !== null) {
        // Esc with the tag popup open closes the popup only.
        e.preventDefault();
        e.stopPropagation();
        setDismissed(popupRef.current);
        return;
      }
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
  // Nothing to show on the wall: close() would delete it under the empty rule.
  const blank = draft.trim() === '' && note.images.length === 0 && (note.files?.length ?? 0) === 0;

  const query = tagQueryAt(draft, caret);
  const suggestions = query && query.start !== dismissed ? suggestTags(knownTags, query.text) : [];
  const open = suggestions.length > 0;
  const activeIdx = Math.min(active, Math.max(suggestions.length - 1, 0));
  const popupRef = useRef<number | null>(null);
  popupRef.current = open && query ? query.start : null;

  const available = note.images.filter((img) => img.available);
  const lightboxItems = noteImageItems(note.images);
  const viewIndex = viewing === null ? -1 : lightboxItems.findIndex((item) => item.id === viewing);

  // The viewed image left the note (removed here or elsewhere, or no longer on this machine): close
  // the lightbox rather than let it reappear if that image comes back.
  useEffect(() => {
    if (viewing !== null && viewIndex < 0) setViewing(null);
  }, [viewing, viewIndex]);

  useEffect(() => {
    if (pendingCaret.current === null) return;
    taRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const accept = (tag: string) => {
    if (!query) return;
    const next = `${draft.slice(0, query.start)}#${tag} ${draft.slice(caret)}`;
    const pos = query.start + tag.length + 2;
    draftRef.current = next;
    setDraft(next);
    setCaret(pos);
    pendingCaret.current = pos;
    setActive(0);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = suggestions.length;
      setActive((activeIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(suggestions[activeIdx].tag);
    }
  };

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
          <NoteRevealButton note={note} className="ed-btn" />
          {onAttachFiles && (
            <>
              <button type="button" className="ed-btn" data-tip="Attach files" aria-label="Attach files" onClick={() => pickerRef.current?.click()}>
                <Paperclip weight="duotone" />
              </button>
              <input
                ref={pickerRef}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                aria-hidden="true"
                data-picker=""
                onChange={(e) => {
                  const input = e.currentTarget;
                  // Copy first: clearing the value empties the live FileList. Clearing lets the same file be picked again.
                  const picked = Array.from(input.files ?? []);
                  input.value = '';
                  if (picked.length > 0) onAttachFiles(picked);
                }}
              />
            </>
          )}
          {onShowOnWall && (
            <button
              type="button"
              className="ed-btn"
              data-tip="Show on wall"
              aria-label="Show on wall"
              disabled={blank}
              onClick={() => {
                if (closedRef.current) return;
                close();
                onShowOnWall(noteRef.current);
              }}
            >
              <Crosshair weight="duotone" />
            </button>
          )}
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
        <div className="ed-field">
        <textarea
          ref={taRef}
          className="ed-text"
          aria-label="Note text"
          value={draft}
          onChange={(e) => {
            draftRef.current = e.target.value;
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
            setActive(0);
          }}
          // A programmatic value swap reports the stale caret first; accept() already knows the real one.
          onSelect={(e) => pendingCaret.current === null && setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        {open && (
          <ul className="ed-suggest" role="listbox" aria-label="Tag suggestions">
            {suggestions.map((t, i) => (
              <li
                key={t.tag}
                role="option"
                aria-selected={i === activeIdx}
                className={i === activeIdx ? 'on' : undefined}
                // mousedown, not click: keep textarea focus so no blur-save fires mid-pick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(t.tag);
                }}
              >
                #{t.tag}
                <span className="ed-suggest-n">{t.count}</span>
              </li>
            ))}
          </ul>
        )}
        </div>
        {tags.length > 0 && (
          <div className="ed-tags">
            {tags.map((t) => (
              <span key={t} className="ed-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
        <FileChips files={files} onRemove={onRemoveFile} />
        {available.length > 0 && (
          <div className="ed-strip" data-strip="">
            {available.map((img) => (
              <div key={img.id} className="ed-thumb" data-image={img.id} style={{ aspectRatio: aspectOf(img).css }}>
                <button
                  type="button"
                  className="ed-open"
                  data-open={img.id}
                  aria-label={`View image ${img.id}`}
                  onClick={() => setViewing(img.id)}
                >
                  <NoteImage image={img} variant="thumb" className="ed-thumb-img" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </button>
                <RevealButton image={img} className="ed-rm ed-reveal" />
                <button type="button" className="ed-rm" data-tip="Remove image" aria-label="Remove image" onClick={() => onRemoveImage(img)}>
                  <X weight="duotone" />
                </button>
              </div>
            ))}
          </div>
        )}
        {viewIndex >= 0 && (
          <Lightbox
            items={lightboxItems}
            index={viewIndex}
            onIndex={(i) => setViewing(lightboxItems[i].id)}
            onClose={() => setViewing(null)}
            onChatAbout={
              onChatAbout
                ? (item) => {
                    if (closedRef.current) return;
                    close();
                    onChatAbout(item.id);
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
