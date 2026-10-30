import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import type { Note } from '../types';
import { fontSizeFor, letterSpacingFor, rowsFor, segmentBody } from '../lib/text';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';

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
  onToggleTag: (tag: string) => void;
}

function CardEditor({ note, onCommit }: { note: Note; onCommit: (note: Note, draft: string) => void }) {
  const [draft, setDraft] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  return (
    <textarea
      ref={ref}
      className="card-edit"
      value={draft}
      rows={rowsFor(draft.length)}
      style={{ fontSize: fontSizeFor(draft, !!note.image) }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(note, draft)}
    />
  );
}

function NoteCardImpl({ note, now, editing, dim, used, copied, onCopy, onEdit, onCommit, onToggleTag }: NoteCardProps) {
  const hasImg = !!note.image;
  const fs = fontSizeFor(note.body, hasImg);
  const cls = ['card', hasImg ? 'img' : '', dim ? 'dim' : '', used ? 'used' : ''].filter(Boolean).join(' ');
  return (
    <article className={cls} data-note={note.id}>
      {hasImg && <NoteImage note={note} />}
      <div className="card-body">
        {editing ? (
          <CardEditor note={note} onCommit={onCommit} />
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
          <span className="card-date">{relativeDate(note.created_at, now)}</span>
        </div>
      </div>
    </article>
  );
}

export const NoteCard = memo(NoteCardImpl);
