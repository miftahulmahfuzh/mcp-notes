import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';
import { ArrowRight, CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { imageFiles } from './DropOverlay';
import './ChatBar.css';

/** One text line in px; must match `.chatbar textarea { line-height }` in ChatBar.css. */
export const CHAT_LINE_PX = 20;
/** Textarea vertical padding, top + bottom, in px; must match ChatBar.css (10px + 10px). */
export const CHAT_PAD_Y_PX = 20;
/** Lines the bar grows to before it scrolls inside (R7: "about six"). */
export const CHAT_MAX_LINES = 6;
/** Height the thumbnail row adds inside the pill: 48px thumbs + 4px margin above and below (ChatBar.css). */
export const CHAT_THUMBS_PX = 56;
/** Form padding top + bottom around the textarea (7px + 7px in styles.css `.chatbar`). */
const BAR_PAD_Y_PX = 14;
/** The one-line pill: 40px textarea / send button + 14px padding. */
const BAR_MIN_PX = 54;

export type ChatBarImageState = 'uploading' | 'ready' | 'failed';

/** One pasted image waiting in the bar. */
export interface ChatBarImage {
  key: string;
  /** File name, for the tooltip and the remove button's label. */
  label: string;
  state: ChatBarImageState;
  /** Thumb URL once uploaded. */
  thumbUrl: string | null;
  /** Why it failed. */
  error: string | null;
}

export interface ChatBarProps {
  /** Left edge of the fixed wall bar. Ignored by the page variant. */
  left?: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** Pasted images, shown as removable thumbnails above the text. */
  images?: readonly ChatBarImage[];
  /** Image files pasted while the bar has focus. Omitted: the bar takes no images. */
  onPasteFiles?: (files: File[]) => void;
  onRemoveImage?: (key: string) => void;
  /** Disables send (an image is still uploading or failed). */
  sendBlocked?: boolean;
  /** 'wall' (default): the fixed pill that publishes --chatbar-h. 'page': laid out by its parent. */
  variant?: 'wall' | 'page';
  /** Placeholder and accessible name of the textarea. Default 'Ask about your notes'. */
  placeholder?: string;
}

export const CHAT_PLACEHOLDER = 'Ask about your notes';

const NO_IMAGES: readonly ChatBarImage[] = [];

export function ChatBar({
  left,
  value,
  onChange,
  onSubmit,
  images = NO_IMAGES,
  onPasteFiles,
  onRemoveImage,
  sendBlocked = false,
  variant = 'wall',
  placeholder = CHAT_PLACEHOLDER,
}: ChatBarProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  // Read by the stable `fit` so the resize listener is never re-subscribed (its cleanup clears --chatbar-h).
  const thumbsPx = useRef(0);
  thumbsPx.current = images.length > 0 ? CHAT_THUMBS_PX : 0;
  const publishes = useRef(variant === 'wall');
  publishes.current = variant === 'wall';

  // Grow with the content one line at a time up to CHAT_MAX_LINES, then scroll inside. The wall
  // bar's height (thumbnail row included) is published as --chatbar-h so the answer panel (and the
  // undo bar) sit above it.
  const fit = useCallback(() => {
    const el = ta.current;
    if (!el) return;
    const min = CHAT_LINE_PX + CHAT_PAD_Y_PX;
    const max = CHAT_LINE_PX * CHAT_MAX_LINES + CHAT_PAD_Y_PX;
    el.style.height = 'auto';
    const full = el.scrollHeight;
    const h = Math.min(Math.max(full, min), max);
    el.style.height = `${h}px`;
    el.style.overflowY = full > max ? 'auto' : 'hidden';
    if (publishes.current) {
      document.documentElement.style.setProperty('--chatbar-h', `${Math.max(BAR_MIN_PX, h + BAR_PAD_Y_PX + thumbsPx.current)}px`);
    }
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [value, left, images.length, fit]);

  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      if (publishes.current) document.documentElement.style.removeProperty('--chatbar-h');
    };
  }, [fit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Enter that confirms an IME candidate must not send (keyCode 229 covers Safari / older Chrome).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (sendBlocked) return;
    e.currentTarget.form?.requestSubmit();
  };

  // Image files go to the owner of the bar; text (or a paste with no image) stays the browser's.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPasteFiles) return;
    const files = imageFiles(e.clipboardData?.files);
    if (files.length === 0) return;
    e.preventDefault();
    onPasteFiles(files);
  };

  const remove = (key: string) => {
    onRemoveImage?.(key);
    // The button unmounts; keep focus in the bar so the next paste still lands here.
    ta.current?.focus();
  };

  return (
    <form
      className={variant === 'page' ? 'chatbar chatbar-page' : 'chatbar'}
      style={variant === 'wall' ? { left } : undefined}
      onSubmit={onSubmit}
      data-chatbar={variant}
    >
      <div className="chatbar-input">
        {images.length > 0 && (
          <ul className="chatbar-thumbs" aria-label="Pasted images">
            {images.map((img) => (
              <li
                key={img.key}
                className={`chatbar-thumb ${img.state}`}
                data-image-state={img.state}
                data-tip={img.state === 'failed' ? (img.error ?? 'upload failed') : img.label}
              >
                {img.state === 'ready' && img.thumbUrl ? (
                  <img src={img.thumbUrl} alt={img.label} />
                ) : img.state === 'uploading' ? (
                  <CircleNotch className="spin" aria-label="uploading" />
                ) : (
                  <WarningCircle aria-label="upload failed" />
                )}
                {onRemoveImage && (
                  <button type="button" className="chatbar-thumb-x" aria-label={`Remove ${img.label}`} onClick={() => remove(img.key)}>
                    <X />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      <button type="submit" className="sendbtn" data-tip="Send" aria-label="Send" disabled={sendBlocked}>
        <ArrowRight weight="duotone" />
      </button>
    </form>
  );
}
