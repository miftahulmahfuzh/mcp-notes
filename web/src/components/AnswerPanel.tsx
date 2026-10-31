import { Fragment } from 'react';
import type { MouseEvent } from 'react';
import { CaretDown, CaretUp, PushPin, X } from '@phosphor-icons/react';
import { chatImageUrl } from '../api';
import { segmentLinks } from '../lib/links';
import { oneLine } from '../lib/oneLine';

export interface AnswerPanelProps {
  left: number;
  query: string;
  /** Chat image ids sent with the query; shown as thumbnails above the answer. */
  images?: readonly string[];
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

const NO_IMAGES: readonly string[] = [];

/** The header's question line: the text, or for an image-only question its image count. */
function questionLabel(query: string, imageCount: number): string {
  if (query !== '') return query;
  if (imageCount === 0) return '';
  return imageCount === 1 ? '1 image' : `${imageCount} images`;
}

export function AnswerPanel({
  left,
  query,
  images = NO_IMAGES,
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
  const label = questionLabel(query, images.length);

  // Collapsed, the whole line expands the panel; the icon buttons keep their own meaning.
  const onHeadClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!collapsed) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    onToggleCollapse();
  };

  return (
    <div className={collapsed ? 'answer collapsed' : 'answer'} style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head" onClick={onHeadClick}>
        <span className="answer-q" data-tip={label}>
          {oneLine(label)}
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
      {!collapsed && images.length > 0 && (
        <div className="answer-images">
          {images.map((id) => (
            <img key={id} src={chatImageUrl(id, 'thumb')} alt={`pasted image ${id}`} />
          ))}
        </div>
      )}
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
