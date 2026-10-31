import { useCallback, useMemo, useRef, useState } from 'react';
import { answerMap, COMPOSER_SELECTOR, messageSelector, resolveReply, type ResolvedReply } from '../lib/chatReply';
import type { ChatMessage } from '../types';
import { useJumpToMessage } from './useJumpToMessage';
import { useMessageActions, type MutateMessages } from './useMessageActions';
import { useNotice } from './useNotice';
import { useShowDeleted } from './useShowDeleted';
import type { UndoEntry } from './useUndo';

/** The slice of P9's `HistoryStore` this phase needs. */
export interface HistorySource {
  /** Every loaded server row, deleted ones included (App fetches with include_deleted=1), ascending. */
  messages: readonly ChatMessage[];
  loadOlder: () => Promise<ChatMessage[]>;
  mutate: MutateMessages;
}

/** Everything a MessageItem needs except the P9 bubble props. */
export interface MessageItemWiring {
  message: ChatMessage;
  reply: ResolvedReply | null;
  /** A user question with a live answer: Delete asks "Delete the answer too?". */
  hasAnswer: boolean;
  onReply: (m: ChatMessage) => void;
  onJump: (id: string) => void;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string, withAnswer: boolean) => void;
  onRestore: (id: string) => void;
}

export interface HistoryActions {
  /** Whether a server row is listed: live rows always, deleted ones only with "Show deleted" on. */
  isShown: (m: ChatMessage) => boolean;
  /** The bubble the composer replies to (shown as the chip), or null. */
  replyTo: ChatMessage | null;
  cancelReply: () => void;
  showDeleted: boolean;
  toggleShowDeleted: () => void;
  notice: string | null;
  itemProps: (m: ChatMessage) => MessageItemWiring;
}

function focusLater(pick: () => HTMLElement | null): void {
  window.setTimeout(() => pick()?.focus(), 0);
}

/** The nearest rendered message after `id` (else before it) that is not about to disappear. */
function neighbourOf(id: string, skip: ReadonlySet<string>): string | null {
  const ids = Array.from(document.querySelectorAll<HTMLElement>('[data-msg]'), (el) => el.dataset.msg ?? '');
  const i = ids.indexOf(id);
  if (i < 0) return null;
  for (let k = i + 1; k < ids.length; k += 1) if (!skip.has(ids[k])) return ids[k];
  for (let k = i - 1; k >= 0; k -= 1) if (!skip.has(ids[k])) return ids[k];
  return null;
}

export function useHistoryActions({
  history,
  pushUndo,
}: {
  history: HistorySource;
  pushUndo: (entry: UndoEntry) => void;
}): HistoryActions {
  const { messages, loadOlder, mutate } = history;

  const [replyTo, setReplyState] = useState<ChatMessage | null>(null);
  const replyRef = useRef<ChatMessage | null>(null);
  const setReply = useCallback((m: ChatMessage | null) => {
    replyRef.current = m;
    setReplyState(m);
  }, []);

  const [showDeleted, toggleShowDeleted] = useShowDeleted();
  const showRef = useRef(showDeleted);
  showRef.current = showDeleted;

  const { notice, show: notify } = useNotice(4000);
  const actions = useMessageActions({ messages, mutate, pushUndo, notify });
  const jump = useJumpToMessage({ messages, loadOlder, notify, showDeleted });

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const answers = useMemo(() => answerMap(messages), [messages]);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const isShown = useCallback((m: ChatMessage) => showDeleted || !m.deleted_at, [showDeleted]);

  const startReply = useCallback(
    (m: ChatMessage) => {
      setReply(m);
      focusLater(() => document.querySelector<HTMLElement>(COMPOSER_SELECTOR));
    },
    [setReply],
  );
  const cancelReply = useCallback(() => setReply(null), [setReply]);

  const onDelete = useCallback(
    (id: string, withAnswer: boolean) => {
      const answer = withAnswer ? answersRef.current.get(id) : undefined;
      const gone = new Set(answer ? [id, answer.id] : [id]);
      const next = neighbourOf(id, gone);
      const cur = replyRef.current;
      if (cur && gone.has(cur.id)) setReply(null);
      void actions.remove(id, withAnswer);
      // Focus management: with "Show deleted" on the bubble stays (dimmed) -> its Restore button;
      // otherwise the nearest remaining bubble, else the composer.
      focusLater(() => {
        if (showRef.current) {
          return document.querySelector<HTMLElement>(`${messageSelector(id)} [data-action="restore"]`);
        }
        const el = next ? document.querySelector<HTMLElement>(messageSelector(next)) : null;
        return el ?? document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
      });
    },
    [actions, setReply],
  );

  const onRestore = useCallback(
    (id: string) => {
      void actions.restore(id);
    },
    [actions],
  );

  const onJump = useCallback(
    (id: string) => {
      void jump(id);
    },
    [jump],
  );

  const itemProps = useCallback(
    (m: ChatMessage): MessageItemWiring => ({
      message: m,
      reply: m.reply_to ? resolveReply(m.reply_to, byId) : null,
      hasAnswer: answers.has(m.id),
      onReply: startReply,
      onJump,
      onEdit: actions.edit,
      onDelete,
      onRestore,
    }),
    [byId, answers, startReply, onJump, actions, onDelete, onRestore],
  );

  return { isShown, replyTo, cancelReply, showDeleted, toggleShowDeleted, notice, itemProps };
}
