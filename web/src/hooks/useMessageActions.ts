import { useCallback, useMemo, useRef } from 'react';
import { deleteChatMessage, editChatMessage, restoreChatMessage } from '../chatHistoryApi';
import { answerMap } from '../lib/chatReply';
import type { ChatMessage } from '../types';
import type { UndoEntry } from './useUndo';

/** P9's `HistoryStore.mutate`: a functional update of the loaded server rows. */
export type MutateMessages = (fn: (msgs: ChatMessage[]) => ChatMessage[]) => void;

export interface MessageActionsDeps {
  messages: readonly ChatMessage[];
  mutate: MutateMessages;
  pushUndo: (entry: UndoEntry) => void;
  /** Quiet one-line notice ("edit failed: …"). */
  notify: (text: string) => void;
}

export interface MessageActions {
  /** User rows only. Optimistic; rolled back with a notice on error. Resolves true when saved (or unchanged). */
  edit: (id: string, text: string) => Promise<boolean>;
  /** Soft delete (and the answer when `withAnswer`), optimistic, with a 6 s undo that restores. */
  remove: (id: string, withAnswer: boolean) => Promise<boolean>;
  /** Restore one deleted row (the "Show deleted" Restore action). */
  restore: (id: string) => Promise<boolean>;
}

function setFields(ids: readonly string[], fields: Partial<ChatMessage>) {
  return (msgs: ChatMessage[]): ChatMessage[] => msgs.map((m) => (ids.includes(m.id) ? { ...m, ...fields } : m));
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useMessageActions({ messages, mutate, pushUndo, notify }: MessageActionsDeps): MessageActions {
  // Same pattern as App's notesRef: callbacks read the latest list without re-binding.
  const ref = useRef(messages);
  ref.current = messages;

  const edit = useCallback(
    async (id: string, text: string): Promise<boolean> => {
      const prev = ref.current.find((m) => m.id === id);
      // Only the ends are trimmed: newlines inside a multi-line question stay.
      const next = text.trim();
      if (!prev || prev.role !== 'user' || prev.deleted_at || !next) return false;
      if (next === prev.text) return true;
      mutate(setFields([id], { text: next, edited_at: new Date().toISOString() }));
      try {
        const saved = await editChatMessage(id, next);
        mutate((ms) => ms.map((m) => (m.id === id ? { ...m, ...saved } : m)));
        return true;
      } catch (e) {
        mutate(setFields([id], { text: prev.text, edited_at: prev.edited_at }));
        notify(`edit failed: ${reason(e)}`);
        return false;
      }
    },
    [mutate, notify],
  );

  const remove = useCallback(
    async (id: string, withAnswer: boolean): Promise<boolean> => {
      const target = ref.current.find((m) => m.id === id);
      if (!target || target.deleted_at) return false;
      const answer = withAnswer ? (answerMap(ref.current).get(id) ?? null) : null;
      const ids = answer ? [id, answer.id] : [id];
      mutate(setFields(ids, { deleted_at: new Date().toISOString() }));
      // Resolves to the ids the server deleted (P7 `{deleted}`), or null when the DELETE failed.
      const done: Promise<string[] | null> = deleteChatMessage(id, answer !== null).then(
        (deleted) => deleted,
        (e: unknown) => {
          mutate(setFields(ids, { deleted_at: null }));
          notify(`delete failed: ${reason(e)}`);
          return null;
        },
      );
      pushUndo({
        label: answer ? `deleted [msg:${id}] and its answer` : `deleted [msg:${id}]`,
        run: async () => {
          const deleted = await done;
          if (deleted === null) return;
          // P7 restores one id per call (a live row is a 200 no-op): restore exactly what was deleted.
          for (const x of deleted) await restoreChatMessage(x);
          mutate(setFields(deleted, { deleted_at: null }));
        },
      });
      return (await done) !== null;
    },
    [mutate, notify, pushUndo],
  );

  const restore = useCallback(
    async (id: string): Promise<boolean> => {
      const m = ref.current.find((x) => x.id === id);
      if (!m || !m.deleted_at) return false;
      const was = m.deleted_at;
      mutate(setFields([id], { deleted_at: null }));
      try {
        await restoreChatMessage(id);
        return true;
      } catch (e) {
        mutate(setFields([id], { deleted_at: was }));
        notify(`restore failed: ${reason(e)}`);
        return false;
      }
    },
    [mutate, notify],
  );

  return useMemo(() => ({ edit, remove, restore }), [edit, remove, restore]);
}
