import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { ArrowBendUpLeft, ArrowCounterClockwise, PencilSimple, Trash } from '@phosphor-icons/react';
import { Bubble, type BubbleProps } from './Bubble';
import type { MessageItemWiring } from '../hooks/useHistoryActions';
import type { ResolvedReply } from '../lib/chatReply';
import { chatTimeTitle } from '../lib/chatTime';
import './MessageItem.css';

export interface MessageItemProps extends MessageItemWiring {
  /** P9's bubble props for this message (`item`, `now`, `focused`, `onOpenImages`); MessageItem adds the slots. */
  bubble: BubbleProps;
}

function ReplyQuote({ reply, onJump }: { reply: ResolvedReply; onJump: (id: string) => void }) {
  if (reply.deleted) {
    return (
      <div className="msg-quote msg-quote-deleted" data-reply-to={reply.id}>
        message deleted
      </div>
    );
  }
  return (
    <button
      type="button"
      className="msg-quote"
      data-reply-to={reply.id}
      aria-label={`Go to the quoted message from ${reply.author}: ${reply.snippet}`}
      onClick={() => onJump(reply.id)}
    >
      <span className="msg-quote-author">{reply.author}</span>
      <span className="msg-quote-text">{reply.snippet}</span>
    </button>
  );
}

function BubbleEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Enter that confirms an IME candidate must not save (same rule as ChatBar).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!value.trim()) {
      setError('a message cannot be empty');
      return;
    }
    onSave(value);
  };

  return (
    <div className="msg-edit">
      <textarea
        ref={ta}
        value={value}
        rows={Math.min(8, Math.max(2, value.split('\n').length))}
        aria-label="Edit message"
        aria-describedby={hintId}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError('');
        }}
        onKeyDown={onKeyDown}
      />
      <p id={hintId} className="msg-edit-hint">
        Enter saves · Esc cancels · only future replies see the edit; the answer stays as it is
      </p>
      {error && (
        <p className="msg-edit-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One server message on the history page: P9's bubble (still the `li`) with the quoted header, the
 * in-place editor, the "edited" mark and the actions in its slots. Actions are real buttons (Tab
 * reaches them); they fade in on hover or focus-within, and are always shown on narrow or touch
 * screens (MessageItem.css).
 */
export function MessageItem({
  message,
  bubble,
  reply,
  hasAnswer,
  onReply,
  onJump,
  onEdit,
  onDelete,
  onRestore,
}: MessageItemProps) {
  const { id, role } = message;
  const deleted = Boolean(message.deleted_at);
  const short = `[msg:${id}]`;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editBtn = useRef<HTMLButtonElement>(null);
  const deleteBtn = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const refocus = useRef<'edit' | 'delete' | null>(null);

  // Return focus to the button that opened the editor / the confirm, once it is rendered again.
  useEffect(() => {
    const r = refocus.current;
    if (!r) return;
    refocus.current = null;
    (r === 'edit' ? editBtn.current : deleteBtn.current)?.focus();
  });

  useEffect(() => {
    if (confirming) firstChoice.current?.focus();
  }, [confirming]);

  const endEdit = () => {
    refocus.current = 'edit';
    setEditing(false);
  };
  const save = (text: string) => {
    endEdit();
    void onEdit(id, text);
  };

  const askDelete = () => {
    if (role === 'user' && hasAnswer) setConfirming(true);
    else onDelete(id, false);
  };
  const choose = (withAnswer: boolean) => {
    setConfirming(false);
    onDelete(id, withAnswer);
  };
  const onConfirmKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    refocus.current = 'delete';
    setConfirming(false);
  };
  const onConfirmBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setConfirming(false);
  };

  let actions: ReactNode = null;
  if (deleted) {
    actions = (
      <button
        type="button"
        className="copybtn msg-btn"
        data-action="restore"
        data-tip="Restore"
        aria-label={`Restore message ${short}`}
        onClick={() => onRestore(id)}
      >
        <ArrowCounterClockwise weight="duotone" />
      </button>
    );
  } else if (confirming) {
    actions = (
      <div className="msg-confirm" role="group" aria-label="Delete the answer too?" onKeyDown={onConfirmKey} onBlur={onConfirmBlur}>
        <span className="msg-confirm-q">Delete the answer too?</span>
        <button ref={firstChoice} type="button" onClick={() => choose(false)}>
          Question only
        </button>
        <button type="button" onClick={() => choose(true)}>
          Question and answer
        </button>
      </div>
    );
  } else if (!editing) {
    actions = (
      <>
        <button
          type="button"
          className="copybtn msg-btn"
          data-action="reply"
          data-tip="Reply"
          aria-label={`Reply to message ${short}`}
          onClick={() => onReply(message)}
        >
          <ArrowBendUpLeft weight="duotone" />
        </button>
        {role === 'user' && (
          <button
            ref={editBtn}
            type="button"
            className="copybtn msg-btn"
            data-action="edit"
            data-tip="Edit"
            aria-label={`Edit message ${short}`}
            onClick={() => {
              setConfirming(false);
              setEditing(true);
            }}
          >
            <PencilSimple weight="duotone" />
          </button>
        )}
        <button
          ref={deleteBtn}
          type="button"
          className="copybtn msg-btn"
          data-action="delete"
          data-tip="Delete"
          aria-label={`Delete message ${short}`}
          onClick={askDelete}
        >
          <Trash weight="duotone" />
        </button>
      </>
    );
  }

  // Invariant 7: the full UTC+7 timestamp, P9's formatter.
  const editedTip = message.edited_at ? `edited ${chatTimeTitle(message.edited_at)}` : '';

  return (
    <Bubble
      {...bubble}
      slots={{
        className: deleted ? 'msg-deleted' : undefined,
        label: deleted ? `deleted message ${short}` : undefined,
        quote: reply ? <ReplyQuote reply={reply} onJump={onJump} /> : undefined,
        editor: editing ? <BubbleEditor initial={message.text} onSave={save} onCancel={endEdit} /> : undefined,
        foot: (
          <div className="msg-foot">
            {message.edited_at && (
              <span className="msg-edited" tabIndex={0} data-tip={editedTip} aria-label={editedTip}>
                edited
              </span>
            )}
            {actions}
          </div>
        ),
      }}
    />
  );
}
