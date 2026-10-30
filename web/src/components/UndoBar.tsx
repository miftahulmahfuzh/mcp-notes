import { ArrowCounterClockwise } from '@phosphor-icons/react';
import type { UndoItem } from '../hooks/useUndo';
import './UndoBar.css';

export interface UndoBarProps {
  entry: UndoItem | null;
  onUndo: () => void;
}

/**
 * Fixed above the right end of the chat bar: a Geist Mono label and one icon button, like the
 * "copied" label. Right-aligned so it stays clear of the answer panel, which is anchored at the
 * chat bar's left edge and at most 680px wide (phase 11 keeps that geometry).
 */
export function UndoBar({ entry, onUndo }: UndoBarProps) {
  if (!entry) return null;
  return (
    <div key={entry.seq} className="undo" role="status" data-undo="">
      <span className="undo-label">{entry.label}</span>
      <button type="button" className="copybtn" data-tip="Undo" aria-label="Undo" onClick={onUndo}>
        <ArrowCounterClockwise weight="duotone" />
      </button>
    </div>
  );
}
