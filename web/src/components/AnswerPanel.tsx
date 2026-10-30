import { Fragment } from 'react';
import type { MouseEvent } from 'react';
import { CaretDown, CaretUp, PushPin, X } from '@phosphor-icons/react';
import { segmentLinks } from '../lib/links';
import { oneLine } from '../lib/oneLine';

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
  /** Folded to the header line alone (R6). */
  collapsed: boolean;
  usedIds: string[];
  onTogglePin: () => void;
  onToggleCollapse: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

export function AnswerPanel({
  left,
  query,
  text,
  done,
  status,
  brain,
  pinned,
  collapsed,
  usedIds,
  onTogglePin,
  onToggleCollapse,
  onClose,
  onJump,
}: AnswerPanelProps) {
  const parts = text.split('\n\n');
  const caption = done ? (brain ?? '') : status;

  // Collapsed, the whole line expands the panel; the icon buttons keep their own meaning.
  const onHeadClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!collapsed) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    onToggleCollapse();
  };

  return (
    <div className={collapsed ? 'answer collapsed' : 'answer'} style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head" onClick={onHeadClick}>
        <span className="answer-q" data-tip={query}>
          {oneLine(query)}
        </span>
        {caption && <span className="answer-status">{caption}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="pbtn hov"
          data-tip={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? <CaretUp weight="duotone" /> : <CaretDown weight="duotone" />}
        </button>
        <button type="button" className={pinned ? 'pbtn on' : 'pbtn'} data-tip={pinned ? 'Unpin' : 'Pin'} aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          <PushPin weight="duotone" />
        </button>
        <button type="button" className="pbtn hov" data-tip="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X weight="duotone" />
        </button>
      </div>
      {!collapsed && (
        <div className="answer-body">
          {parts.map((t, i) => {
            const streaming = !done && i === parts.length - 1;
            return (
              <p key={i}>
                {segmentLinks(t, { streaming }).map((s, j) =>
                  s.kind === 'link' ? (
                    <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
                      {s.text}
                    </a>
                  ) : (
                    <Fragment key={j}>{s.text}</Fragment>
                  ),
                )}
                {streaming ? ' ▍' : ''}
              </p>
            );
          })}
        </div>
      )}
      {!collapsed && done && usedIds.length > 0 && (
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
