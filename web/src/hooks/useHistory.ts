import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatImageSrc, fetchChatMessages, streamChat } from '../chatHistoryApi';
import { threadForReply } from '../lib/chatReply';
import { subscribeEvents } from '../lib/events';
import { readSSE } from '../lib/sse';
import { mergeMessages, oldestMs, pruneLocal, threadForSend, timelineOf, type LocalBubble, type TimelineItem } from '../lib/timeline';
import type { ChatMessage } from '../types';

/** Messages per request, latest page and each older page. */
export const HISTORY_PAGE = 50;
const REFRESH_DEBOUNCE_MS = 150;

export interface HistoryOptions {
  /**
   * Fetch with `include_deleted=1` and keep deleted rows (dimmed) instead of dropping them on
   * `op: 'deleted'`. Phase 9 never sets it; it is the seam for phase 10's "show deleted" toggle.
   */
  includeDeleted?: boolean;
  /**
   * Phase 12: scope the store to one project (repo key): pages come from `?project=` and every send
   * carries `project`. Fixed for the hook's life; mount a new store (a `key`) per project.
   */
  project?: string | null;
}

export interface HistoryStore {
  items: TimelineItem[];
  /** The server rows, ascending (no local bubbles). */
  messages: ChatMessage[];
  loaded: boolean;
  error: string | null;
  /** Older messages exist past the oldest loaded one. */
  hasMore: boolean;
  loadingOlder: boolean;
  /** A reply is streaming; the composer refuses a second send until it ends. */
  sending: boolean;
  /**
   * Prepend the next older page. Resolves to the messages that page held, or `[]` when nothing
   * older remains (or before the first load). A call while a load is in flight awaits that load.
   */
  loadOlder: () => Promise<ChatMessage[]>;
  /** Re-read the latest page now. */
  refresh: () => void;
  /** Local optimistic change of the server rows (phase 10: edit, delete, restore). The next refresh wins. */
  mutate: (fn: (messages: ChatMessage[]) => ChatMessage[]) => void;
  /**
   * Send from the history composer. False when refused (empty, or a reply still streaming): keep the
   * draft. `replyTo` (phase 10): the bubble this message answers; a wall bubble continues its thread,
   * a claude_code bubble starts a new one (Decision), and the POST carries `reply_to`.
   */
  send: (text: string, imageIds: string[], replyTo?: ChatMessage, noteImageIds?: string[]) => boolean;
}

interface State {
  server: ChatMessage[];
  local: LocalBubble[];
  loaded: boolean;
  error: string | null;
  cursor: string | null;
  loadingOlder: boolean;
  sending: boolean;
}

const INITIAL: State = { server: [], local: [], loaded: false, error: null, cursor: null, loadingOlder: false, sending: false };

function parse(data: unknown): Record<string, unknown> {
  if (typeof data !== 'string') return {};
  try {
    const j: unknown = JSON.parse(data);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The history page's store (phase 9). Lives in App for the page's whole life, so a reply keeps
 * streaming when the user leaves the page; it fetches and listens only while `enabled`.
 * - latest page on enable, on every `event: chat` (debounced) and after each send;
 * - `loadOlder` pages back with the server's `next_before` cursor;
 * - `send` shows the question and a streaming reply at once (optimistic), then swaps them for the
 *   server rows by id; the thread is chosen by `threadForSend` (Decision: newest exchange rules).
 */
export function useHistory(enabled: boolean, options: HistoryOptions = {}): HistoryStore {
  const includeDeleted = options.includeDeleted === true;
  const [st, setSt] = useState<State>(INITIAL);
  const stRef = useRef(st);
  stRef.current = st;
  const deletedRef = useRef(includeDeleted);
  deletedRef.current = includeDeleted;
  const projectRef = useRef<string | null>(options.project ?? null);
  projectRef.current = options.project ?? null;
  const alive = useRef(true);
  const seq = useRef(0);
  const sendingRef = useRef(false);
  const olderRef = useRef<Promise<ChatMessage[]> | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const loadRef = useRef<() => void>(() => {});
  const scheduleRef = useRef<() => void>(() => {});

  // The latest-page loader: one in flight, a request during it runs once more afterwards.
  useEffect(() => {
    alive.current = true;
    let inFlight = false;
    let again = false;
    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    };

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        const page = await fetchChatMessages({ limit: HISTORY_PAGE, includeDeleted: deletedRef.current, project: projectRef.current });
        if (!alive.current) return;
        setSt((s) => {
          const from = page.next_before === null ? Number.NEGATIVE_INFINITY : oldestMs(page.messages);
          const server = mergeMessages(s.server, page.messages, from);
          return {
            ...s,
            server,
            local: pruneLocal(s.local, server),
            loaded: true,
            error: null,
            // The cursor belongs to the oldest page loaded; only the first load sets it.
            cursor: s.loaded ? s.cursor : page.next_before,
          };
        });
      } catch (e) {
        if (alive.current) setSt((s) => ({ ...s, loaded: true, error: errText(e) }));
      } finally {
        inFlight = false;
        if (alive.current && again) {
          again = false;
          schedule();
        }
      }
    };

    loadRef.current = () => void load();
    scheduleRef.current = schedule;
    return () => {
      alive.current = false;
      window.clearTimeout(timer);
      loadRef.current = () => {};
      scheduleRef.current = () => {};
      ctrl.current?.abort();
    };
  }, []);

  // While the page is shown: load now, then follow `event: chat` (wall turns, /n captures, edits).
  useEffect(() => {
    if (!enabled) return;
    loadRef.current();
    const offChat = subscribeEvents('chat', (e) => {
      const d = parse((e as { data?: unknown } | undefined)?.data);
      const id = str(d.id);
      // P7's ops are past tense: created | updated | deleted | restored.
      if (d.op === 'deleted' && id !== null && !deletedRef.current) {
        setSt((s) => ({ ...s, server: s.server.filter((m) => m.id !== id) }));
      }
      scheduleRef.current();
    });
    // Reconnected after a daemon restart: catch up.
    const offOpen = subscribeEvents('open', () => scheduleRef.current());
    return () => {
      offChat();
      offOpen();
    };
  }, [enabled]);

  // Toggling include_deleted (phase 10) re-reads the latest page in the new mode (not on mount:
  // the effect above already loads).
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    if (enabledRef.current) loadRef.current();
  }, [includeDeleted]);

  const loadOlder = useCallback((): Promise<ChatMessage[]> => {
    if (olderRef.current !== null) return olderRef.current;
    const s = stRef.current;
    if (!s.loaded || s.cursor === null) return Promise.resolve([]);
    const cursor = s.cursor;
    setSt((x) => ({ ...x, loadingOlder: true }));
    const run = (async (): Promise<ChatMessage[]> => {
      try {
        const page = await fetchChatMessages({ before: cursor, limit: HISTORY_PAGE, includeDeleted: deletedRef.current, project: projectRef.current });
        if (!alive.current) return [];
        setSt((x) => ({ ...x, server: mergeMessages(x.server, page.messages, null), cursor: page.next_before, loadingOlder: false }));
        return page.messages;
      } catch (e) {
        if (alive.current) setSt((x) => ({ ...x, loadingOlder: false, error: errText(e) }));
        return [];
      } finally {
        olderRef.current = null;
      }
    })();
    olderRef.current = run;
    return run;
  }, []);

  const refresh = useCallback(() => loadRef.current(), []);

  const mutate = useCallback((fn: (messages: ChatMessage[]) => ChatMessage[]) => {
    setSt((s) => {
      const server = fn(s.server);
      return server === s.server ? s : { ...s, server };
    });
  }, []);

  const send = useCallback((text: string, imageIds: string[], replyTo?: ChatMessage, noteImageIds: string[] = []): boolean => {
    const message = text.trim();
    if (sendingRef.current) return false;
    if (!message && imageIds.length === 0 && noteImageIds.length === 0) return false;
    const now = stRef.current;
    const threadId = replyTo
      ? (threadForReply(replyTo) ?? undefined)
      : threadForSend(timelineOf(now.server, now.local));
    const n = ++seq.current;
    const createdAt = new Date().toISOString();
    const userKey = `local-${n}-u`;
    const botKey = `local-${n}-a`;
    const user: LocalBubble = {
      key: userKey,
      role: 'user',
      serverId: null,
      threadId: threadId ?? null,
      text: message,
      createdAt,
      attachments: [
        ...imageIds.map((id) => ({
          kind: 'chat_image' as const,
          id,
          url: chatImageSrc(id, 'display'),
          thumb_url: chatImageSrc(id, 'thumb'),
        })),
        ...noteImageIds.map((id) => ({
          kind: 'note_image' as const,
          id,
          url: `/api/images/${id}/display`,
          thumb_url: `/api/images/${id}/thumb`,
        })),
      ],
      streaming: false,
      status: '',
      brain: null,
      error: null,
    };
    const bot: LocalBubble = { ...user, key: botKey, role: 'assistant', text: '', attachments: [], streaming: true };
    sendingRef.current = true;
    setSt((s) => ({ ...s, sending: true, local: [...s.local, user, bot] }));

    const patch = (key: string, fn: (b: LocalBubble) => LocalBubble) =>
      setSt((s) => ({ ...s, local: s.local.map((b) => (b.key === key ? fn(b) : b)) }));

    const c = new AbortController();
    ctrl.current = c;
    let accepted = false;
    let ended = false;
    const fail = (why: string) => {
      ended = true;
      patch(botKey, (b) => ({ ...b, streaming: false, status: '', error: why }));
      if (!accepted) patch(userKey, (u) => ({ ...u, error: 'not sent' }));
    };
    const adoptThread = (t: string | null) => {
      if (t === null) return;
      patch(userKey, (u) => ({ ...u, threadId: t }));
      patch(botKey, (b) => ({ ...b, threadId: t }));
    };

    void (async () => {
      try {
        const project = projectRef.current;
        const res = await streamChat({
          message,
          threadId,
          imageIds,
          ...(noteImageIds.length > 0 ? { noteImageIds } : {}),
          replyTo: replyTo?.id,
          ...(project ? { project } : {}),
          signal: c.signal,
        });
        if (!res.ok || !res.body) {
          fail(`Chat failed: ${res.status} ${res.statusText}`.trim());
          return;
        }
        await readSSE(res.body, (ev) => {
          if (ctrl.current !== c) return;
          const d = parse(ev.data);
          if (ev.event === 'accepted') {
            accepted = true;
            const uid = str(d.user_message_id);
            if (uid !== null) patch(userKey, (u) => ({ ...u, serverId: uid }));
            adoptThread(str(d.thread_id));
          } else if (ev.event === 'delta') {
            const t = d.text;
            if (typeof t === 'string' && t) patch(botKey, (b) => ({ ...b, text: b.text + t }));
          } else if (ev.event === 'status') {
            const t = d.text;
            if (typeof t === 'string') patch(botKey, (b) => ({ ...b, status: t }));
          } else if (ev.event === 'done') {
            accepted = true;
            ended = true;
            const uid = str(d.user_message_id);
            const aid = str(d.assistant_message_id);
            if (uid !== null) patch(userKey, (u) => ({ ...u, serverId: u.serverId ?? uid }));
            adoptThread(str(d.thread_id));
            patch(botKey, (b) => ({ ...b, serverId: aid, brain: str(d.brain), streaming: false, status: '' }));
          } else if (ev.event === 'error') {
            const m = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : ev.data;
            fail(`Chat failed: ${m}`);
          }
        });
        if (!ended) fail('Chat failed: the reply stopped before it finished');
      } catch (e) {
        if (c.signal.aborted) return;
        fail(`Chat failed: ${errText(e)}`);
      } finally {
        if (ctrl.current === c) {
          ctrl.current = null;
          sendingRef.current = false;
          if (alive.current) setSt((s) => ({ ...s, sending: false }));
          loadRef.current();
        }
      }
    })();
    return true;
  }, []);

  const items = useMemo(() => timelineOf(st.server, st.local), [st.server, st.local]);

  return {
    items,
    messages: st.server,
    loaded: st.loaded,
    error: st.error,
    hasMore: st.cursor !== null,
    loadingOlder: st.loadingOlder,
    sending: st.sending,
    loadOlder,
    refresh,
    mutate,
    send,
  };
}
