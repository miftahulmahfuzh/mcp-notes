import { PushPin, X } from '@phosphor-icons/react';

export interface AnswerPanelProps {
  left: number;
  query: string;
  text: string;
  done: boolean;
  /** Tool caption while streaming; '' for none. */
  status: string;
  /** Brain that answered, shown once done; null for none. */
  brain: string | null;
  pinned: boolean;
  usedIds: string[];
  onTogglePin: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

export function AnswerPanel({ left, query, text, done, status, brain, pinned, usedIds, onTogglePin, onClose, onJump }: AnswerPanelProps) {
  const parts = text.split('\n\n');
  const caption = done ? (brain ?? '') : status;
  return (
    <div className="answer" style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head">
        <span className="answer-q">{query}</span>
        {caption && <span className="answer-status">{caption}</span>}
        <span className="spacer" />
        <button type="button" className={pinned ? 'pbtn on' : 'pbtn'} data-tip={pinned ? 'Unpin' : 'Pin'} aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          <PushPin weight="duotone" />
        </button>
        <button type="button" className="pbtn hov" data-tip="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X weight="duotone" />
        </button>
      </div>
      <div className="answer-body">
        {parts.map((t, i) => (
          <p key={i}>{t + (!done && i === parts.length - 1 ? ' ▍' : '')}</p>
        ))}
      </div>
      {done && usedIds.length > 0 && (
        <div className="used-row">
          {usedIds.map((id) => (
            <button key={id} type="button" className="usedchip" data-tip="Show on wall" onClick={() => onJump(id)}>
              {id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
