import { useCallback, useEffect, useRef, useState } from 'react';
import { postChat } from '../api';
import { readSSE } from '../lib/sse';

export interface ChatState {
  open: boolean;
  pinned: boolean;
  /** Panel folded to its header line (R6). Every new answer and every dismiss reset it to false. */
  collapsed: boolean;
  query: string;
  /** Chat image ids sent with `query` (shown as thumbnails in the panel). */
  images: string[];
  text: string;
  done: boolean;
  /** Terse tool caption while the brain works ("searching notes"); '' when there is none. */
  status: string;
  /** Which brain answered ('claude' | 'glm'), from `done.brain`; null when the server named none. */
  brain: string | null;
}

export interface Chat extends ChatState {
  /** Sends the message with any pasted image ids. Needs text or at least one image. */
  ask: (message: string, imageIds?: readonly string[]) => Promise<void>;
  close: () => void;
  togglePin: () => void;
  toggleCollapsed: () => void;
}

function parse(data: string): Record<string, unknown> {
  try {
    const j: unknown = JSON.parse(data);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function useChat(): Chat {
  const [st, setSt] = useState<ChatState>({
    open: false,
    pinned: false,
    collapsed: false,
    query: '',
    images: [],
    text: '',
    done: false,
    status: '',
    brain: null,
  });
  const threadId = useRef<string | undefined>(undefined);
  const ctrl = useRef<AbortController | null>(null);

  const ask = useCallback(async (message: string, imageIds: readonly string[] = []) => {
    // Only the ends are trimmed: newlines inside a multi-line message (R7) reach /api/chat intact.
    const q = message.trim();
    const ids = [...imageIds];
    if (!q && ids.length === 0) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setSt((s) => ({ ...s, open: true, collapsed: false, query: q, images: ids, text: '', done: false, status: '', brain: null }));

    const finish = (extra?: string, brain: string | null = null) => {
      if (ctrl.current !== c) return;
      setSt((s) => ({
        ...s,
        done: true,
        status: '',
        brain,
        text: extra ? (s.text ? `${s.text}\n\n${extra}` : extra) : s.text,
      }));
    };

    try {
      const res = await postChat(q, threadId.current, c.signal, ids);
      if (!res.ok || !res.body) {
        finish(`Chat failed: ${res.status} ${res.statusText}`.trim());
        return;
      }
      let ended = false;
      await readSSE(res.body, (ev) => {
        if (ctrl.current !== c) return;
        if (ev.event === 'delta') {
          const t = parse(ev.data).text;
          if (typeof t === 'string' && t) setSt((s) => ({ ...s, text: s.text + t }));
        } else if (ev.event === 'status') {
          const t = parse(ev.data).text;
          if (typeof t === 'string') setSt((s) => ({ ...s, status: t }));
        } else if (ev.event === 'done') {
          const d = parse(ev.data);
          if (typeof d.thread_id === 'string' && d.thread_id) threadId.current = d.thread_id;
          ended = true;
          finish(undefined, typeof d.brain === 'string' && d.brain ? d.brain : null);
        } else if (ev.event === 'error') {
          const d = parse(ev.data);
          const m = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : ev.data;
          ended = true;
          finish(`Chat failed: ${m}`);
        }
      });
      if (!ended) finish();
    } catch (e) {
      if (c.signal.aborted) return;
      finish(`Chat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const close = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    // Dismissing ends the conversation: the next message starts a new thread.
    threadId.current = undefined;
    setSt((s) => ({ ...s, open: false, pinned: false, collapsed: false, images: [], text: '', done: false, status: '', brain: null }));
  }, []);

  const togglePin = useCallback(() => setSt((s) => ({ ...s, pinned: !s.pinned })), []);

  const toggleCollapsed = useCallback(() => setSt((s) => ({ ...s, collapsed: !s.collapsed })), []);

  useEffect(() => () => ctrl.current?.abort(), []);

  return { ...st, ask, close, togglePin, toggleCollapsed };
}
