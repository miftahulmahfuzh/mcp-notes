import { useEffect, useRef, type MouseEvent } from 'react';
import { Trash, X } from '@phosphor-icons/react';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const SELECTOR = '[data-modal="confirm"]';

/** True while a confirm dialog is mounted. Window Esc listeners registered before it yield via this (Lightbox's seam). */
export function isConfirmOpen(doc: Document = document): boolean {
  return doc.querySelector(SELECTOR) !== null;
}

// mousedown, not click, keeps focus where it is: an open editor must not blur-save mid-delete.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** A small question over everything: trash confirms (Enter), X or the backdrop cancels (Esc). */
export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
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
          <button type="button" className="cf-btn cf-yes" data-tip="Delete anyway" aria-label="Delete anyway" onMouseDown={keepFocus} onClick={onConfirm}>
            <Trash weight="duotone" />
          </button>
        </div>
      </div>
    </div>
  );
}
