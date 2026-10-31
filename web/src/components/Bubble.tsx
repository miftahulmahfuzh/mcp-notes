import { useMemo, type ReactNode } from 'react';
import type { LightboxItem } from './Lightbox';
import { ChatInline, ImageLinkContext, type ImageLinks } from './ChatText';
import { chatImageSrc } from '../chatHistoryApi';
import { chatTime, chatTimeTitle } from '../lib/chatTime';
import type { TimelineItem } from '../lib/timeline';
import type { ChatAttachment } from '../types';

/** Thumbnail box in px: square, the image is `object-fit: cover` inside it (P7's wire carries no dimensions, so nothing can jump on load). */
export const THUMB_H = 96;

/** Width of a thumbnail box. Optional dimensions are honoured if a later wire adds them; P7's attachments have none. */
export function thumbWidth(a: object): number {
  const { width, height } = a as { width?: number | null; height?: number | null };
  const w = width ?? 0;
  const h = height ?? 0;
  if (w > 0 && h > 0) return Math.min(240, Math.max(48, Math.round((THUMB_H * w) / h)));
  return THUMB_H;
}

/** A message's image attachments as P2 lightbox items, in message order (`url` is the display variant). */
export function lightboxItemsOf(images: ChatAttachment[]): LightboxItem[] {
  return images.map((a) => ({
    id: a.id,
    src: a.url || chatImageSrc(a.id, 'display'),
    label: a.kind === 'chat_image' ? `upload:${a.id}` : a.kind === 'note_image' ? `img:${a.id}` : a.id,
  }));
}

/** Phase 10: what MessageItem puts into a history bubble. All optional; absent = P9's bubble unchanged. */
export interface BubbleSlots {
  /** Quoted header of a reply, first inside the bubble. */
  quote?: ReactNode;
  /** In-place editor; while set, `.bubble-body` is hidden and this is shown in its place. */
  editor?: ReactNode;
  /** The "edited" mark and the action buttons, after `.bubble-meta`. */
  foot?: ReactNode;
  /** Extra root classes (`msg-deleted`). */
  className?: string;
  /** Root aria-label (a deleted message). */
  label?: string;
}

export interface BubbleProps {
  item: TimelineItem;
  now: Date;
  /** Part of the thread the page was opened on (`/history?thread=`): briefly outlined. */
  focused: boolean;
  onOpenImages: (items: LightboxItem[], index: number) => void;
  /** Phase 10: actions, reply quote and editor (server rows on the history page only). */
  slots?: BubbleSlots;
}

const CHIP_KIND: Record<ChatAttachment['kind'], string> = { chat_image: 'upload', note_image: 'img', note_file: 'file' };

/** Pictures show as clickable thumbnails: pasted uploads and pictures attached from a note alike. */
const isPicture = (a: ChatAttachment): boolean => a.kind === 'chat_image' || a.kind === 'note_image';

export function Bubble({ item, now, focused, onOpenImages, slots }: BubbleProps) {
  const { msg, local } = item;
  const mine = msg.role === 'user';
  const streaming = local?.streaming ?? false;
  const images = msg.attachments.filter(isPicture);
  const chips = msg.attachments.filter((a) => !isPicture(a));
  // `img:ID` / `upload:ID` written in the text open the picture in the lightbox.
  const imageLinks = useMemo<ImageLinks>(
    () => ({
      open: (source, id) =>
        onOpenImages(
          [{ id, src: source === 'img' ? `/api/images/${id}/display` : chatImageSrc(id, 'display'), label: `${source}:${id}` }],
          0,
        ),
    }),
    [onOpenImages],
  );
  const parts = msg.text ? msg.text.split('\n\n') : [];
  const cls = ['bubble', mine ? 'mine' : 'theirs', local?.error ? 'error' : '', focused ? 'focus' : '', slots?.className ?? '']
    .filter(Boolean)
    .join(' ');
  const editing = slots?.editor !== undefined;
  const caption = streaming ? (local?.status ?? '') : msg.role === 'assistant' ? (msg.brain ?? '') : '';

  return (
    <li
      className={cls}
      data-msg={msg.id || undefined}
      data-msg-key={item.key}
      data-thread={msg.thread_id || undefined}
      tabIndex={slots ? -1 : undefined}
      aria-label={slots?.label}
    >
      {slots?.quote}
      {slots?.editor}
      <ImageLinkContext.Provider value={imageLinks}>
      <div className="bubble-body" hidden={editing || undefined}>
        {msg.source === 'claude_code' && <span className="bubble-badge">claude code</span>}
        {images.length > 0 && (
          <div className="bubble-thumbs">
            {images.map((a, i) => {
              const w = thumbWidth(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  className="bubble-thumb"
                  data-tip={a.kind === 'note_image' ? `img:${a.id}` : `upload:${a.id}`}
                  aria-label={a.kind === 'note_image' ? `View image img:${a.id}` : `View image upload:${a.id}`}
                  onClick={() => onOpenImages(lightboxItemsOf(images), i)}
                >
                  <img src={a.thumb_url ?? chatImageSrc(a.id, 'thumb')} alt="" width={w} height={THUMB_H} style={{ width: w, height: THUMB_H, objectFit: 'cover' }} loading="lazy" decoding="async" draggable={false} />
                </button>
              );
            })}
          </div>
        )}
        {parts.map((t, i) => {
          const tail = streaming && i === parts.length - 1;
          return (
            <p key={i}>
              <ChatInline text={t} streaming={tail} />
              {tail ? ' ▍' : ''}
            </p>
          );
        })}
        {streaming && parts.length === 0 && <p className="bubble-wait">{local?.status || 'thinking'} ▍</p>}
        {local?.error && <p className="bubble-error">{local.error}</p>}
        {chips.length > 0 && (
          <div className="bubble-chips">
            {chips.map((a) => (
              <span key={`${a.kind}:${a.id}`} className="bubble-chip">
                {CHIP_KIND[a.kind]} {a.id}
              </span>
            ))}
          </div>
        )}
      </div>
      </ImageLinkContext.Provider>
      <div className="bubble-meta">
        <time dateTime={msg.created_at} data-tip={chatTimeTitle(msg.created_at)}>
          {chatTime(msg.created_at, now)}
        </time>
        {caption && <span className="bubble-caption">{caption}</span>}
      </div>
      {slots?.foot}
    </li>
  );
}
