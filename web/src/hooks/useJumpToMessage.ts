import { useCallback, useEffect, useRef } from 'react';
import { pulse } from '../lib/flash';
import { messageSelector } from '../lib/chatReply';
import type { ChatMessage } from '../types';

/** Older pages loaded at most while looking for a quoted message, before giving up quietly. */
export const JUMP_MAX_PAGES = 20;
/** How long to wait for the target's element to render after it is in the list. */
export const JUMP_WAIT_MS = 1500;
export const NOT_FOUND_NOTICE = 'original message not found';
const POLL_MS = 50;

export interface JumpDeps {
  messages: readonly ChatMessage[];
  /** P9 contract: resolves to the page it prepended, [] when nothing older remains. */
  loadOlder: () => Promise<ChatMessage[]>;
  notify: (text: string) => void;
  showDeleted: boolean;
}

function waitForElement(selector: string, ms: number, alive: () => boolean): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let left = Math.ceil(ms / POLL_MS);
    const look = (): void => {
      if (!alive()) return resolve(null);
      const el = document.querySelector<HTMLElement>(selector);
      if (el || left <= 0) return resolve(el);
      left -= 1;
      window.setTimeout(look, POLL_MS);
    };
    look();
  });
}

/** Returns `jump(id)`: load older pages until `id` is in the list, then scroll to it, pulse it (lib/flash) and focus it. */
export function useJumpToMessage({ messages, loadOlder, notify, showDeleted }: JumpDeps): (id: string) => Promise<void> {
  const msgs = useRef(messages);
  msgs.current = messages;
  const shown = useRef(showDeleted);
  shown.current = showDeleted;
  const alive = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  return useCallback(
    async (id: string) => {
      if (busy.current) return;
      busy.current = true;
      try {
        let target = msgs.current.find((m) => m.id === id);
        let pages = 0;
        while (!target && pages < JUMP_MAX_PAGES) {
          const page = await loadOlder();
          pages += 1;
          if (!alive.current) return;
          if (page.length === 0) break;
          target = page.find((m) => m.id === id);
        }
        if (!target) {
          notify(NOT_FOUND_NOTICE);
          return;
        }
        if (target.deleted_at && !shown.current) {
          notify('message deleted');
          return;
        }
        const el = await waitForElement(messageSelector(id), JUMP_WAIT_MS, () => alive.current);
        if (!alive.current) return;
        if (!el) {
          notify(NOT_FOUND_NOTICE);
          return;
        }
        pulse(el);
        el.focus({ preventScroll: true });
      } catch (e) {
        console.error('jump to message failed', e);
        notify('could not load older messages');
      } finally {
        busy.current = false;
      }
    },
    [loadOlder, notify],
  );
}
