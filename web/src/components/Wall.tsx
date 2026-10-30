import type { Note } from '../types';
import { NoteCard } from './NoteCard';

export interface WallProps {
  notes: Note[];
  now: Date;
  editingId: string | null;
  /** null = no chat highlight; else the set of used ids. */
  usedIds: Set<string> | null;
  copiedId: string | null;
  onCopy: (id: string) => void;
  onEdit: (id: string) => void;
  onCommit: (note: Note, draft: string) => void;
  onToggleTag: (tag: string) => void;
  /** Open the big editor on a note (phase 7). */
  onExpand: (note: Note, draft: string | null) => void;
}

export function Wall({ notes, now, editingId, usedIds, copiedId, onCopy, onEdit, onCommit, onToggleTag, onExpand }: WallProps) {
  return (
    <section className="wall">
      {notes.map((n) => (
        <NoteCard
          key={n.id}
          note={n}
          now={now}
          editing={editingId === n.id}
          dim={usedIds !== null && !usedIds.has(n.id)}
          used={usedIds !== null && usedIds.has(n.id)}
          copied={copiedId === n.id}
          onCopy={onCopy}
          onEdit={onEdit}
          onCommit={onCommit}
          onToggleTag={onToggleTag}
          onExpand={onExpand}
        />
      ))}
    </section>
  );
}
