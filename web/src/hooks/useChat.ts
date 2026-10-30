import { useCallback, useEffect, useRef, useState } from 'react';
import { postChat } from '../api';
import { readSSE } from '../lib/sse';

export interface ChatState {
  open: boolean;
  pinned: boolean;
  query: string;
  text: string;
  done: boolean;
  /** Terse tool caption while the brain works ("searching notes"); '' when there is none. */
  status: string;
  /** Which brain answered ('claude' | 'glm'), from `done.brain`; null when the server named none. */
  brain: string | null;
}

export interface Chat extends ChatState {
  ask: (message: string) => Promise<void>;
  close: () => void;
  togglePin: () => void;
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
    query: '',
    text: '',
    done: false,
    status: '',
    brain: null,
  });
  const threadId = useRef<string | undefined>(undefined);
  const ctrl = useRef<AbortController | null>(null);

  const ask = useCallback(async (message: string) => {
    const q = message.trim();
    if (!q) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setSt((s) => ({ ...s, open: true, query: q, text: '', done: false, status: '', brain: null }));

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
      const res = await postChat(q, threadId.current, c.signal);
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
    setSt((s) => ({ ...s, open: false, pinned: false, text: '', done: false, status: '', brain: null }));
  }, []);

  const togglePin = useCallback(() => setSt((s) => ({ ...s, pinned: !s.pinned })), []);

  useEffect(() => () => ctrl.current?.abort(), []);

  return { ...st, ask, close, togglePin };
}
