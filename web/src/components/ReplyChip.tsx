import { useEffect } from 'react';
import { ArrowBendUpLeft, X } from '@phosphor-icons/react';
import { authorOf, snippetOf } from '../lib/chatReply';
import type { ChatMessage } from '../types';
import './MessageItem.css';

export interface ReplyChipProps {
  target: ChatMessage;
  onCancel: () => void;
}

/**
 * "replying to <author> <snippet> [x]", rendered by P9's HistoryComposer above its page ChatBar.
 * Esc anywhere clears it, unless something else already handled that Esc (the Lightbox prevents it).
 */
export function ReplyChip({ target, onCancel }: ReplyChipProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const author = authorOf(target);
  const snippet = snippetOf(target.text);
  return (
    <div className="reply-chip" role="group" aria-label={`Replying to ${author}: ${snippet}`} data-reply-chip={target.id}>
      <ArrowBendUpLeft weight="duotone" aria-hidden="true" />
      <span className="reply-chip-author">{author}</span>
      <span className="reply-chip-text">{snippet}</span>
      <button type="button" className="copybtn" data-tip="Cancel reply" aria-label="Cancel reply" onClick={onCancel}>
        <X weight="duotone" />
      </button>
    </div>
  );
}
