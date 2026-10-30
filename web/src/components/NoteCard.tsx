import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowsOutSimple, Check, Copy, Trash } from '@phosphor-icons/react';
import type { Note } from '../types';
import { fontSizeFor, letterSpacingFor, rowsFor, segmentBody } from '../lib/text';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';
import { RevealButton } from './RevealButton';

export interface NoteCardProps {
  note: Note;
  now: Date;
  editing: boolean;
  /** Chat highlight active and this note not used: opacity .22. */
  dim: boolean;
  /** Chat highlight active and this note used: outline ring. */
  used: boolean;
  copied: boolean;
  onCopy: (id: string) => void;
  onEdit: (id: string) => void;
  onCommit: (note: Note, draft: string) => void;
  /** Soft delete, no confirmation (R3). Absent = no trash icon. */
  onDelete?: (note: Note) => void;
  onToggleTag: (tag: string) => void;
  /** Open the big editor. `draft` = the unsaved inline text when the card is being edited, else null. */
  onExpand: (note: Note, draft: string | null) => void;
}

function CardEditor({
  note,
  draftRef,
  onCommit,
}: {
  note: Note;
  draftRef: MutableRefObject<string>;
  onCommit: (note: Note, draft: string) => void;
}) {
  const [draft, setDraft] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    draftRef.current = note.body;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    // Mount only: the draft is seeded once, like the textarea itself.
  }, []);
  return (
    <textarea
      ref={ref}
      className="card-edit"
      value={draft}
      rows={rowsFor(draft.length)}
      style={{ fontSize: fontSizeFor(draft, note.images.length > 0) }}
      onChange={(e) => {
        draftRef.current = e.target.value;
        setDraft(e.target.value);
      }}
      onBlur={() => onCommit(note, draft)}
    />
  );
}

function NoteCardImpl({ note, now, editing, dim, used, copied, onCopy, onEdit, onCommit, onDelete, onToggleTag, onExpand }: NoteCardProps) {
  // Images whose file is not on this machine are hidden: a placeholder cover only eats space.
  const shown = note.images.filter((img) => img.available);
  const count = shown.length;
  const cover = count > 0 ? shown[0] : undefined;
  const hasImg = cover !== undefined;
  const fs = fontSizeFor(note.body, hasImg);
  const cls = ['card', hasImg ? 'img' : '', dim ? 'dim' : '', used ? 'used' : ''].filter(Boolean).join(' ');
  const draftRef = useRef(note.body);
  return (
    <article className={cls} data-note={note.id}>
      {cover && (
        <div className="card-cover">
          <NoteImage image={cover} />
          {count > 1 && (
            <span className="card-count" data-count={count}>
              {count}
            </span>
          )}
        </div>
      )}
      <div className="card-body">
        {editing ? (
          <CardEditor note={note} draftRef={draftRef} onCommit={onCommit} />
        ) : (
          <p className="card-text" style={{ fontSize: fs, letterSpacing: letterSpacingFor(fs) }} onClick={() => onEdit(note.id)}>
            {segmentBody(note.body).map((s, i) =>
              s.kind === 'tag' ? (
                <span
                  key={i}
                  className="tagchip"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleTag(s.tag);
                  }}
                >
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
        )}
        <div className="card-meta">
          <span className="card-id">{note.id}</span>
          <button
            type="button"
            className="copybtn"
            data-tip="Copy ID"
            aria-label="Copy ID"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(note.id);
            }}
          >
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          {note.images.length > 0 && <RevealButton image={note.images[0]} />}
          <span className="card-date">{relativeDate(note.created_at, now)}</span>
          <button
            type="button"
            className="copybtn"
            data-tip="Expand note"
            aria-label="Expand note"
            onMouseDown={(e) => {
              // Keep focus in the inline editor: a blur here would commit (and delete an empty new note).
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onExpand(note, editing ? draftRef.current : null);
            }}
          >
            <ArrowsOutSimple weight="duotone" />
          </button>
          {onDelete && (
            <button
              type="button"
              className="copybtn"
              data-tip="Delete note"
              aria-label="Delete note"
              // Keep focus where it is: an open inline editor must not blur-commit (or empty-delete) the note being deleted.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(note);
              }}
            >
              <Trash weight="duotone" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export const NoteCard = memo(NoteCardImpl);
