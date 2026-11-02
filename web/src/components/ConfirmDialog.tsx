import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { Trash, X } from '@phosphor-icons/react';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirm button's tooltip and accessible name. Default "Delete anyway" (every delete confirm). */
  confirmLabel?: string;
  /** The confirm button's icon. Default the duotone trash. */
  confirmIcon?: ReactNode;
}

const SELECTOR = '[data-modal="confirm"]';

/** True while a confirm dialog is mounted. Window Esc listeners registered before it yield via this (Lightbox's seam). */
export function isConfirmOpen(doc: Document = document): boolean {
  return doc.querySelector(SELECTOR) !== null;
}

// mousedown, not click, keeps focus where it is: an open editor must not blur-save mid-delete.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** A small question over everything: the confirm icon (trash unless told otherwise) confirms (Enter), X or the backdrop cancels (Esc). */
export function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = 'Delete anyway', confirmIcon }: ConfirmDialogProps) {
  const live = useRef({ onConfirm, onCancel });
  live.current = { onConfirm, onCancel };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === 'Enter') live.current.onConfirm();
      else live.current.onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="cf" data-modal="confirm" onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="cf-box" role="alertdialog" aria-label={message} onClick={(e) => e.stopPropagation()}>
        <p className="cf-msg">{message}</p>
        <div className="cf-actions">
          <button type="button" className="cf-btn" data-tip="Cancel" aria-label="Cancel" onMouseDown={keepFocus} onClick={onCancel}>
            <X weight="duotone" />
          </button>
          <button type="button" className="cf-btn cf-yes" data-tip={confirmLabel} aria-label={confirmLabel} onMouseDown={keepFocus} onClick={onConfirm}>
            {confirmIcon ?? <Trash weight="duotone" />}
          </button>
        </div>
      </div>
    </div>
  );
}
