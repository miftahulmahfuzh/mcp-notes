import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import './ChatBar.css';

/** One text line in px; must match `.chatbar textarea { line-height }` in ChatBar.css. */
export const CHAT_LINE_PX = 20;
/** Textarea vertical padding, top + bottom, in px; must match ChatBar.css (10px + 10px). */
export const CHAT_PAD_Y_PX = 20;
/** Lines the bar grows to before it scrolls inside (R7: "about six"). */
export const CHAT_MAX_LINES = 6;
/** Form padding top + bottom around the textarea (7px + 7px in styles.css `.chatbar`). */
const BAR_PAD_Y_PX = 14;
/** The one-line pill: 40px textarea / send button + 14px padding. */
const BAR_MIN_PX = 54;

export interface ChatBarProps {
  left: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function ChatBar({ left, value, onChange, onSubmit }: ChatBarProps) {
  const ta = useRef<HTMLTextAreaElement>(null);

  // Grow with the content one line at a time up to CHAT_MAX_LINES, then scroll inside. The bar's
  // height is published as --chatbar-h so the answer panel (and the undo bar) sit above it.
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
    document.documentElement.style.setProperty('--chatbar-h', `${Math.max(BAR_MIN_PX, h + BAR_PAD_Y_PX)}px`);
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [value, left, fit]);

  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      document.documentElement.style.removeProperty('--chatbar-h');
    };
  }, [fit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Enter that confirms an IME candidate must not send (keyCode 229 covers Safari / older Chrome).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  };

  return (
    <form className="chatbar" style={{ left }} onSubmit={onSubmit}>
      <textarea
        ref={ta}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask about your notes"
        aria-label="Ask about your notes"
      />
      <button type="submit" className="sendbtn" data-tip="Send" aria-label="Send">
        <ArrowRight weight="duotone" />
      </button>
    </form>
  );
}
