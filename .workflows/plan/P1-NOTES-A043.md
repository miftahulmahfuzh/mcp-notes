> Adopted from `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` phase 10. Source: `.workflows/plan/chat-history-files-image-search/phase-10.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 10: Bubble actions: reply_to, edit, delete, restore

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R3 (chat history: reply_to, edit/delete). The user can reply to a bubble, jump to the quoted message, edit their own questions in place, and delete or restore any bubble from the history page.
**Depends on:** Phase 9 (directly). Phase 9 in turn depends on 2, 3, 5 and 7; this phase assumes all of them have landed.
**Difficulty:** NORMAL
**Package:** `web`

---

## Goal

Every bubble on the history page gets keyboard-reachable Reply, Edit (user bubbles only) and Delete actions. Reply puts a quote chip above the composer, and sending carries `reply_to`, following the thread rule in Decisions. Reply bubbles show a clickable quoted header that scrolls to and highlights the target, loading older pages if needed. Edit is in place, optimistic and rolled back on error. Delete is soft, optimistic, offers "delete the answer too" for questions, and gets the app's 6 s undo bar. A "Show deleted" toggle lists deleted bubbles dimmed, each with a Restore action. The wall's `AnswerPanel`, `ChatBar` and every server file stay unchanged.


## Interface Contract

Coded against the reconciled `phase-9.md` (history page, `useHistory`, `Bubble`, `chatHistoryApi.ts`, `chatFixtures.ts`) and `phase-7.md` (chat HTTP wire). Every name below that belongs to P9 or P7 is quoted from those plans.

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `web/src/lib/chatReply.ts`: `SNIPPET_CHARS`, `COMPOSER_SELECTOR`, `snippetOf`, `authorOf`, `threadForReply`, `messageSelector`, `answerMap`, `resolveReply`, `ResolvedReply`
- `web/src/hooks/useShowDeleted.ts`: `useShowDeleted`, `SHOW_DELETED_KEY`
- `web/src/hooks/useMessageActions.ts`: `useMessageActions`, `MutateMessages`, `MessageActions`, `MessageActionsDeps`
- `web/src/hooks/useJumpToMessage.ts`: `useJumpToMessage`, `JUMP_MAX_PAGES`, `JUMP_WAIT_MS`, `NOT_FOUND_NOTICE`
- `web/src/hooks/useHistoryActions.ts`: `useHistoryActions`, `HistorySource`, `HistoryActions`, `MessageItemWiring`
- `web/src/components/MessageItem.tsx` (+ `MessageItem.css`): `MessageItem`, `MessageItemProps`. It renders P9's `<Bubble>` itself (no wrapper element), filling the bubble's new slots.
- `web/src/components/ReplyChip.tsx`: `ReplyChip`
- `web/src/components/HistoryTools.tsx`: `HistoryTools`
- `web/src/chatHistoryApi.ts` (P9's module): `editChatMessage`, `deleteChatMessage`, `restoreChatMessage`
- `web/src/components/Bubble.tsx` (P9's component): `BubbleSlots`
- DOM contract: each history message stays exactly one `li.bubble[data-msg="<id>"]` (P9's root; P10 adds `tabIndex=-1` to it when it carries actions). Action buttons carry `data-action="reply|edit|delete|restore"`. A deleted message's `li` also has class `msg-deleted`.

**Signature changes (all in P9 files, additive):**
- `BubbleProps` gains optional `slots?: BubbleSlots` (`{ quote?, editor?, foot?, className?, label? }`). Without `slots` the bubble renders exactly as in P9.
- `StreamChatRequest` gains optional `replyTo?: string`, sent as `reply_to` (P7 accepts `K7F2` or `[msg:K7F2]`; P10 sends the bare id).
- `HistoryStore.send(text, imageIds)` -> `send(text, imageIds, replyTo?: ChatMessage)`. With a reply target the thread rule is "a wall target continues its thread, a claude_code target starts a new thread"; without one P9's `threadForSend` rule is unchanged.
- `HistoryPageProps` gains `pushUndo?: (entry: UndoEntry) => void` (App always passes it; optional only so P9's page tests compile unchanged).
- `historyCountLine` (`lib/timeline.ts`) counts live messages only (it already skipped error bubbles).
- App calls `useHistory(view === 'history', { includeDeleted: true })`: the page always holds deleted rows (fetched with `include_deleted=1`, kept on `op: 'deleted'`), and the "Show deleted" toggle filters on the client.

`postChat` (`web/src/api.ts`), `web/src/types.ts`, `ChatBar`, `AnswerPanel` and `useChat` are not touched.

**Requires (from earlier phases), as the reconciled plans state them:**
- P7: `PATCH /api/chat/messages/:id {text}` edits user rows only (400 `not_editable` / `empty_text`, 404 `not_found`), keeps a revision, sets `edited_at`, returns the bare `ChatMessageView`. `DELETE /api/chat/messages/:id[?with_answer=1]` returns `{deleted: string[]}`, the ids that call changed, question first. `POST /api/chat/messages/:id/restore` restores one id and returns the message; restoring a live row is a 200 no-op. `GET /api/chat/messages?include_deleted=1` includes deleted rows with `deleted_at` set. `POST /api/chat` takes `reply_to`; a missing or unknown `thread_id` starts a new thread. Mutations are same-origin only (the browser's same-origin `fetch` qualifies).
- P7 (via P9's `web/src/types.ts`): `ChatMessage` = `{id, thread_id, role, text, source, brain, reply_to, created_at, edited_at, deleted_at, attachments}`; `reply_to: ChatReplyPreview | null` with `ChatReplyPreview = {id, role: ChatRole | null, text, deleted}` (`text` is already a server snippet, empty when deleted). No change to P7 is needed: `role` is already on the preview.
- P9: `useHistory(enabled, { includeDeleted })` returning `HistoryStore` with `items`, `messages`, `loadOlder(): Promise<ChatMessage[]>` (resolves the prepended page, `[]` at the start, shares an in-flight load), `mutate(fn)`, `send`. `HistoryPage({store, focusThread, now})` renders `<ol className="hist-list">` with one `<Bubble item now focused onOpenImages/>` per `TimelineItem` and an internal `HistoryComposer` (`div.hist-composer` around `<ChatBar variant="page">`). `lib/chatTime.ts` exports `chatTime(iso, now)` and `chatTimeTitle(iso)`. `testing/chatFixtures.ts` exports `makeMessage(id, over)` (P9 is its only creator; P10 imports it).
- P2/P9: the Lightbox's Escape handler calls `preventDefault()`, so the reply chip's document-level Escape (which checks `defaultPrevented`) never fires with it.

**Leaves alone (owned by others):**
- every `src/**` server file (P7)
- `web/src/api.ts`, `web/src/types.ts`, `web/src/components/AnswerPanel.tsx`, `useChat.ts`, `ChatBar.tsx` (P3/P9)
- `Bubble.tsx`'s text rendering (the `parts.map(…)` block, P11 replaces it with `<ChatInline>`) and its thumbnails
- `lib/links.ts`, `NoteEditor.tsx` (P2/P5/P11)
- `lib/flash.ts`: only imported (`pulse`), not edited

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/chatHistoryApi.ts` | modify (P9 file) | `StreamChatRequest.replyTo`; new `editChatMessage`, `deleteChatMessage`, `restoreChatMessage` |
| `web/src/lib/chatReply.ts` | create | pure helpers: snippet, author, thread rule, answer map, reply resolution, selector |
| `web/src/hooks/useShowDeleted.ts` | create | sessionStorage-persisted toggle |
| `web/src/hooks/useMessageActions.ts` | create | optimistic edit/delete/restore with rollback and undo |
| `web/src/hooks/useJumpToMessage.ts` | create | scroll to and pulse a message, loading older pages first |
| `web/src/hooks/useHistoryActions.ts` | create | page-level controller: reply state, visibility, focus management, item wiring |
| `web/src/components/Bubble.tsx` | modify (P9 file) | `BubbleSlots` / `slots` prop: quote first, editor instead of the body, foot after the meta, extra class, label, `tabIndex=-1` |
| `web/src/components/MessageItem.tsx` | create | renders the P9 `Bubble` with quote header, in-place editor, edited mark, actions, delete confirm, restore |
| `web/src/components/MessageItem.css` | create | action, quote, editor, chip and tools styles, plus a touch breakpoint |
| `web/src/components/ReplyChip.tsx` | create | quoted-reply chip at the top of the history composer |
| `web/src/components/HistoryTools.tsx` | create | "Show deleted" toggle and quiet notice line |
| `web/src/hooks/useHistory.ts` | modify (P9 file) | `send(text, imageIds, replyTo?)`: thread rule for replies, `reply_to` on the POST |
| `web/src/lib/timeline.ts` | modify (P9 file) | `historyCountLine` skips deleted rows |
| `web/src/lib/timeline.test.tsx` | modify (P9 file, append) | count line ignores deleted rows |
| `web/src/pages/HistoryPage.tsx` | modify (P9 file) | `pushUndo` prop, `useHistoryActions`, tools, `MessageItem` for server rows, reply chip in `HistoryComposer` |
| `web/src/App.tsx` | modify | `useHistory(…, { includeDeleted: true })`; `pushUndo` on `<HistoryPage>` |
| `web/src/lib/chatReply.test.tsx` | create | pure helper tests |
| `web/src/api.chatActions.test.tsx` | create | endpoint shapes and errors |
| `web/src/components/MessageItem.test.tsx` | create | component behaviour with callbacks |
| `web/src/components/BubbleActions.flow.test.tsx` | create | end-to-end with mocked fetch: every action, rollback, undo, show-deleted, jump, keyboard |
| `web/src/hooks/useJumpToMessage.test.tsx` | create | pagination loop and give-up |
| `web/src/hooks/useHistory.reply.test.tsx` | create | `include_deleted`, `reply_to` payload, thread rule |
| `CHANGELOG.md` | modify | one line under `## [Unreleased]` → `### Added` |
| `README.md` | modify | one paragraph after P9's "The history page" section |

## Implementation Steps

Worktree setup first (Invariant 10): `npm ci` if `node_modules` is missing; `ln -s ~/mcp-notes/.env.local .env.local` if missing.

### Step 1: API helpers
**File:** `web/src/chatHistoryApi.ts` (P9's module, Step 15 there). `web/src/api.ts` and `postChat` are not touched: the history page sends through `streamChat`.
**Change:**

(a) `StreamChatRequest`: replace P9's doc line and interface
```ts
/** Phase 10 adds `replyTo?: string` (sent as `reply_to`); phase 9 never sets it. */
export interface StreamChatRequest {
  message: string;
  /** Our thread id (phase 7, a UUID); absent (or unknown to the server) = a new thread. */
  threadId?: string;
  /** Phase 3 chat image ids, already uploaded. */
  imageIds?: string[];
  signal: AbortSignal;
}
```
with
```ts
export interface StreamChatRequest {
  message: string;
  /** Our thread id (phase 7, a UUID); absent (or unknown to the server) = a new thread. */
  threadId?: string;
  /** Phase 3 chat image ids, already uploaded. */
  imageIds?: string[];
  /** Phase 10: the bubble this message replies to (a 4-char message id), sent as `reply_to`. */
  replyTo?: string;
  signal: AbortSignal;
}
```

(b) In `streamChat`, replace the two payload lines
```ts
  const payload: { message: string; thread_id?: string; image_ids?: string[] } = { message: r.message };
  if (r.threadId) payload.thread_id = r.threadId;
```
with
```ts
  const payload: { message: string; thread_id?: string; image_ids?: string[]; reply_to?: string } = { message: r.message };
  if (r.threadId) payload.thread_id = r.threadId;
  if (r.replyTo) payload.reply_to = r.replyTo;
```

(c) Insert after `streamChat` (before `export type ChatImageVariant`). They reuse the module's private `enc`, `failure` and `normalize`.
```ts
/** Phase 7: `PATCH /api/chat/messages/:id {text}`, user messages only. Returns the updated message; the old text is kept as a revision server-side. */
export async function editChatMessage(id: string, text: string): Promise<ChatMessage> {
  const res = await fetch(`/api/chat/messages/${enc(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw await failure(res);
  return normalize((await res.json()) as ChatMessage);
}

/**
 * Phase 7: soft delete, `?with_answer=1` also deletes the question's answer. Resolves to the ids
 * the server deleted (`{deleted}`, question first); a row that was already deleted is not listed.
 */
export async function deleteChatMessage(id: string, withAnswer: boolean): Promise<string[]> {
  const res = await fetch(`/api/chat/messages/${enc(id)}${withAnswer ? '?with_answer=1' : ''}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { deleted?: unknown };
  return Array.isArray(j.deleted) ? j.deleted.filter((x): x is string => typeof x === 'string') : [];
}

/** Phase 7: `POST /api/chat/messages/:id/restore`, one id per call. Restoring a live message is a 200 no-op. */
export async function restoreChatMessage(id: string): Promise<ChatMessage> {
  const res = await fetch(`/api/chat/messages/${enc(id)}/restore`, { method: 'POST' });
  if (!res.ok) throw await failure(res);
  return normalize((await res.json()) as ChatMessage);
}
```
**Impact:** additive. P9's `useHistory` calls `streamChat` without `replyTo` until Step 12.

### Step 2: Pure helpers
**File:** `web/src/lib/chatReply.ts` (new)
**Code:**
```ts
import type { ChatMessage, ChatReplyPreview, ChatRole } from '../types';

/** Characters of a quoted message shown in a reply header or the composer chip. */
export const SNIPPET_CHARS = 80;

/** The history composer's textarea (P9's `HistoryComposer` renders `div.hist-composer` around ChatBar); focus goes here after Reply or a delete with nothing left. */
export const COMPOSER_SELECTOR = '.hist-composer textarea';

/** Whitespace collapsed to single spaces, cut at `max` characters with an ellipsis. */
export function snippetOf(text: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The author label of a bubble in a quote: the user is "you", every assistant row (either brain, either source) is "claude". */
export function authorOf(m: { role: ChatRole }): string {
  return m.role === 'user' ? 'you' : 'claude';
}

/**
 * Decision (plan index): replying to a bubble in a wall thread continues that thread; replying to a
 * claude_code bubble starts a new thread (null: send no thread_id) that carries reply_to.
 */
export function threadForReply(target: Pick<ChatMessage, 'source' | 'thread_id'>): string | null {
  return target.source === 'wall' && target.thread_id ? target.thread_id : null;
}

/** One history message: P9's bubble root `li.bubble[data-msg]`. */
export function messageSelector(id: string): string {
  return `[data-msg="${id.replace(/["\\]/g, '\\$&')}"]`;
}

const byCreated = (a: ChatMessage, b: ChatMessage): number =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;

/**
 * Question id -> its live answer: within each thread, in time order, the first live assistant row
 * after a user row and before the next user row. A question whose answer is deleted (or that has
 * none yet) is not in the map.
 */
export function answerMap(messages: readonly ChatMessage[]): Map<string, ChatMessage> {
  const threads = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const list = threads.get(m.thread_id);
    if (list) list.push(m);
    else threads.set(m.thread_id, [m]);
  }
  const out = new Map<string, ChatMessage>();
  for (const list of threads.values()) {
    list.sort(byCreated);
    let open: ChatMessage | null = null;
    for (const m of list) {
      if (m.role === 'user') {
        open = m;
      } else if (open && !m.deleted_at) {
        out.set(open.id, m);
        open = null;
      }
    }
  }
  return out;
}

/** What a reply header shows. */
export interface ResolvedReply {
  id: string;
  author: string;
  snippet: string;
  deleted: boolean;
}

/**
 * Prefer the loaded target (its current text and deleted state, including this session's edits,
 * deletes and restores) over the server's preview in `reply_to` (P7: `{id, role, text, deleted}`,
 * `role` null when the target row is gone).
 */
export function resolveReply(ref: ChatReplyPreview, byId: ReadonlyMap<string, ChatMessage>): ResolvedReply {
  const local = byId.get(ref.id);
  if (local) {
    return { id: ref.id, author: authorOf(local), snippet: snippetOf(local.text), deleted: Boolean(local.deleted_at) };
  }
  return {
    id: ref.id,
    author: ref.role ? authorOf({ role: ref.role }) : 'message',
    snippet: snippetOf(ref.text),
    deleted: ref.deleted,
  };
}
```
**Impact:** New file. No other file changes.

### Step 3: Show-deleted toggle state
**File:** `web/src/hooks/useShowDeleted.ts` (new)
**Code:**
```ts
import { useCallback, useEffect, useState } from 'react';

/** sessionStorage key: the toggle survives reloads and view switches in this tab, not new tabs. */
export const SHOW_DELETED_KEY = 'mcp-notes:history:show-deleted';

function readFlag(): boolean {
  try {
    return window.sessionStorage.getItem(SHOW_DELETED_KEY) === '1';
  } catch {
    return false;
  }
}

/** [on, toggle]. Storage failures (blocked storage, private mode) leave a working in-memory toggle. */
export function useShowDeleted(): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(readFlag);
  useEffect(() => {
    try {
      if (on) window.sessionStorage.setItem(SHOW_DELETED_KEY, '1');
      else window.sessionStorage.removeItem(SHOW_DELETED_KEY);
    } catch {
      // storage unavailable: the toggle still works for this page
    }
  }, [on]);
  const toggle = useCallback(() => setOn((v) => !v), []);
  return [on, toggle];
}
```


### Step 4: Optimistic edit, delete and restore
**File:** `web/src/hooks/useMessageActions.ts` (new)
**Code:**
```ts
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
```
**Impact:** New file. The undo entry follows `App.removeNote`'s pattern (`useUndo`'s `UndoEntry {label, run}`): the bar is pushed at once, and `run` awaits the delete before restoring.

### Step 5: Jump to a quoted message
**File:** `web/src/hooks/useJumpToMessage.ts` (new)
**Code:**
```ts
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
```
**Impact:** New file. It reuses `pulse` (`lib/flash.ts:27`) unchanged.


### Step 6: Page-level controller
**File:** `web/src/hooks/useHistoryActions.ts` (new)
**Code:**
```ts
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
```

### Step 7: Bubble slots (P9 file)
**File:** `web/src/components/Bubble.tsx` (P9 Step 18). P9's root is an `li` inside `ol.hist-list`, so P10 adds no wrapper element: `MessageItem` (Step 8) renders the bubble and fills these optional slots. Everything not quoted here, in particular the `parts.map(…)` text block that P11 replaces, stays exactly as P9 wrote it.
**Change:**

(a) Replace the first import line
```tsx
import { Fragment } from 'react';
```
with
```tsx
import { Fragment, type ReactNode } from 'react';
```

(b) Replace P9's `BubbleProps` with
```tsx
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
```

(c) Replace the signature and the class line
```tsx
export function Bubble({ item, now, focused, onOpenImages }: BubbleProps) {
```
```tsx
  const cls = ['bubble', mine ? 'mine' : 'theirs', local?.error ? 'error' : '', focused ? 'focus' : ''].filter(Boolean).join(' ');
```
with
```tsx
export function Bubble({ item, now, focused, onOpenImages, slots }: BubbleProps) {
```
```tsx
  const cls = ['bubble', mine ? 'mine' : 'theirs', local?.error ? 'error' : '', focused ? 'focus' : '', slots?.className ?? '']
    .filter(Boolean)
    .join(' ');
  const editing = slots?.editor !== undefined;
```

(d) Replace the root opening and the body opening
```tsx
    <li className={cls} data-msg={msg.id || undefined} data-msg-key={item.key} data-thread={msg.thread_id || undefined}>
      <div className="bubble-body">
```
with
```tsx
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
      <div className="bubble-body" hidden={editing || undefined}>
```

(e) Replace the end of the component
```tsx
        {caption && <span className="bubble-caption">{caption}</span>}
      </div>
    </li>
```
with
```tsx
        {caption && <span className="bubble-caption">{caption}</span>}
      </div>
      {slots?.foot}
    </li>
```
**Impact:** P9's call sites (`HistoryPage`, tests) pass no `slots` and render as before. Post-P10 Bubble differs from P9's only in: the `react` import, `BubbleSlots`/`BubbleProps.slots`, the signature, the `cls`/`editing` lines, the `li` opening (now multi-line with `tabIndex`/`aria-label`), the two slot lines and `hidden` on `.bubble-body`, and `{slots?.foot}` before `</li>`. The `parts.map(…)` text block is byte-for-byte P9's (P11 Step 6c replaces it).

### Step 8: `MessageItem`
**File:** `web/src/components/MessageItem.tsx` (new)
**Code:**
```tsx
import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { ArrowBendUpLeft, ArrowCounterClockwise, PencilSimple, Trash } from '@phosphor-icons/react';
import { Bubble, type BubbleProps } from './Bubble';
import type { MessageItemWiring } from '../hooks/useHistoryActions';
import type { ResolvedReply } from '../lib/chatReply';
import { chatTimeTitle } from '../lib/chatTime';
import './MessageItem.css';

export interface MessageItemProps extends MessageItemWiring {
  /** P9's bubble props for this message (`item`, `now`, `focused`, `onOpenImages`); MessageItem adds the slots. */
  bubble: BubbleProps;
}

function ReplyQuote({ reply, onJump }: { reply: ResolvedReply; onJump: (id: string) => void }) {
  if (reply.deleted) {
    return (
      <div className="msg-quote msg-quote-deleted" data-reply-to={reply.id}>
        message deleted
      </div>
    );
  }
  return (
    <button
      type="button"
      className="msg-quote"
      data-reply-to={reply.id}
      aria-label={`Go to the quoted message from ${reply.author}: ${reply.snippet}`}
      onClick={() => onJump(reply.id)}
    >
      <span className="msg-quote-author">{reply.author}</span>
      <span className="msg-quote-text">{reply.snippet}</span>
    </button>
  );
}

function BubbleEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Enter that confirms an IME candidate must not save (same rule as ChatBar).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!value.trim()) {
      setError('a message cannot be empty');
      return;
    }
    onSave(value);
  };

  return (
    <div className="msg-edit">
      <textarea
        ref={ta}
        value={value}
        rows={Math.min(8, Math.max(2, value.split('\n').length))}
        aria-label="Edit message"
        aria-describedby={hintId}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError('');
        }}
        onKeyDown={onKeyDown}
      />
      <p id={hintId} className="msg-edit-hint">
        Enter saves · Esc cancels · only future replies see the edit; the answer stays as it is
      </p>
      {error && (
        <p className="msg-edit-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One server message on the history page: P9's bubble (still the `li`) with the quoted header, the
 * in-place editor, the "edited" mark and the actions in its slots. Actions are real buttons (Tab
 * reaches them); they fade in on hover or focus-within, and are always shown on narrow or touch
 * screens (MessageItem.css).
 */
export function MessageItem({
  message,
  bubble,
  reply,
  hasAnswer,
  onReply,
  onJump,
  onEdit,
  onDelete,
  onRestore,
}: MessageItemProps) {
  const { id, role } = message;
  const deleted = Boolean(message.deleted_at);
  const short = `[msg:${id}]`;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editBtn = useRef<HTMLButtonElement>(null);
  const deleteBtn = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const refocus = useRef<'edit' | 'delete' | null>(null);

  // Return focus to the button that opened the editor / the confirm, once it is rendered again.
  useEffect(() => {
    const r = refocus.current;
    if (!r) return;
    refocus.current = null;
    (r === 'edit' ? editBtn.current : deleteBtn.current)?.focus();
  });

  useEffect(() => {
    if (confirming) firstChoice.current?.focus();
  }, [confirming]);

  const endEdit = () => {
    refocus.current = 'edit';
    setEditing(false);
  };
  const save = (text: string) => {
    endEdit();
    void onEdit(id, text);
  };

  const askDelete = () => {
    if (role === 'user' && hasAnswer) setConfirming(true);
    else onDelete(id, false);
  };
  const choose = (withAnswer: boolean) => {
    setConfirming(false);
    onDelete(id, withAnswer);
  };
  const onConfirmKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    refocus.current = 'delete';
    setConfirming(false);
  };
  const onConfirmBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setConfirming(false);
  };

  let actions: ReactNode = null;
  if (deleted) {
    actions = (
      <button
        type="button"
        className="copybtn msg-btn"
        data-action="restore"
        data-tip="Restore"
        aria-label={`Restore message ${short}`}
        onClick={() => onRestore(id)}
      >
        <ArrowCounterClockwise weight="duotone" />
      </button>
    );
  } else if (confirming) {
    actions = (
      <div className="msg-confirm" role="group" aria-label="Delete the answer too?" onKeyDown={onConfirmKey} onBlur={onConfirmBlur}>
        <span className="msg-confirm-q">Delete the answer too?</span>
        <button ref={firstChoice} type="button" onClick={() => choose(false)}>
          Question only
        </button>
        <button type="button" onClick={() => choose(true)}>
          Question and answer
        </button>
      </div>
    );
  } else if (!editing) {
    actions = (
      <>
        <button
          type="button"
          className="copybtn msg-btn"
          data-action="reply"
          data-tip="Reply"
          aria-label={`Reply to message ${short}`}
          onClick={() => onReply(message)}
        >
          <ArrowBendUpLeft weight="duotone" />
        </button>
        {role === 'user' && (
          <button
            ref={editBtn}
            type="button"
            className="copybtn msg-btn"
            data-action="edit"
            data-tip="Edit"
            aria-label={`Edit message ${short}`}
            onClick={() => {
              setConfirming(false);
              setEditing(true);
            }}
          >
            <PencilSimple weight="duotone" />
          </button>
        )}
        <button
          ref={deleteBtn}
          type="button"
          className="copybtn msg-btn"
          data-action="delete"
          data-tip="Delete"
          aria-label={`Delete message ${short}`}
          onClick={askDelete}
        >
          <Trash weight="duotone" />
        </button>
      </>
    );
  }

  // Invariant 7: the full UTC+7 timestamp, P9's formatter.
  const editedTip = message.edited_at ? `edited ${chatTimeTitle(message.edited_at)}` : '';

  return (
    <Bubble
      {...bubble}
      slots={{
        className: deleted ? 'msg-deleted' : undefined,
        label: deleted ? `deleted message ${short}` : undefined,
        quote: reply ? <ReplyQuote reply={reply} onJump={onJump} /> : undefined,
        editor: editing ? <BubbleEditor initial={message.text} onSave={save} onCancel={endEdit} /> : undefined,
        foot: (
          <div className="msg-foot">
            {message.edited_at && (
              <span className="msg-edited" tabIndex={0} data-tip={editedTip} aria-label={editedTip}>
                edited
              </span>
            )}
            {actions}
          </div>
        ),
      }}
    />
  );
}
```
**Impact:** New file. One `li` per message, so `ol.hist-list` stays valid and P9's `[data-msg]`, `.bubble`, `.focus` and alignment rules keep working.

### Step 9: Styles
**File:** `web/src/components/MessageItem.css` (new)
**Code:**
```css
/* Phase 10: bubble actions on the history page. They live inside P9's li.bubble (slots), so P9's
   alignment (.bubble.mine / .bubble.theirs) and look stay; these rules only add to them. */
.bubble[data-msg]:focus { outline: none; }
.bubble[data-msg]:focus-visible .bubble-body { outline-color: var(--line-25); }
.bubble.msg-deleted > :not(.msg-foot) { opacity: .4; }

/* quoted header of a reply bubble */
.msg-quote { display: flex; align-items: baseline; gap: 6px; max-width: min(560px, 100%); margin: 0 0 4px; padding: 3px 8px; border: 0; border-left: 2px solid var(--line-25); background: transparent; color: var(--dim); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.msg-quote:hover, .msg-quote:focus-visible { color: var(--muted); border-left-color: var(--ring); outline: none; }
.msg-quote-author { font-family: var(--mono); font-size: 10.5px; color: var(--id); flex-shrink: 0; }
.msg-quote-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-quote-deleted { cursor: default; font-family: var(--mono); font-size: 10.5px; font-style: italic; }

/* edited mark + action buttons */
.msg-foot { display: flex; align-items: center; gap: 2px; min-height: 24px; font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--dim); }
.msg-edited { padding: 0 4px; cursor: default; outline: none; }
.msg-edited:focus-visible { color: var(--muted); }
.msg-btn { opacity: 0; transition: opacity .12s ease-out; }
.bubble:hover .msg-btn, .bubble:focus-within .msg-btn, .msg-deleted .msg-btn { opacity: 1; }

/* inline "Delete the answer too?" */
.msg-confirm { display: flex; align-items: center; gap: 6px; }
.msg-confirm-q { color: var(--muted); }
.msg-confirm button { height: 24px; padding: 0 8px; border: 1px solid var(--line-14); background: transparent; color: var(--muted); font-family: var(--mono); font-size: 10.5px; cursor: pointer; }
.msg-confirm button:hover, .msg-confirm button:focus-visible { color: var(--fg); border-color: var(--line-25); outline: none; }

/* in-place editor (shown in place of .bubble-body) */
.msg-edit { width: min(560px, 100%); }
.msg-edit textarea { display: block; width: 100%; box-sizing: border-box; margin: 0; padding: 8px 10px; border: 1px solid var(--line-25); background: var(--card); color: var(--text); font: inherit; font-size: 14px; line-height: 20px; resize: vertical; outline: none; }
.msg-edit textarea:focus { border-color: var(--ring); }
.msg-edit-hint, .msg-edit-error { margin: 4px 0 0; font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.msg-edit-error { color: var(--muted); }

/* reply chip: first row of P9's .hist-composer, right above the page ChatBar */
.reply-chip { display: flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; margin: 0 0 6px; padding: 0 3px 0 10px; box-sizing: border-box; background: var(--bg); border: 1px solid var(--line-14); font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--dim); }
.reply-chip-author { color: var(--id); flex-shrink: 0; }
.reply-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--sans); font-size: 12px; letter-spacing: 0; color: var(--muted); }

/* page tools: Show deleted toggle + quiet notice */
.history-tools { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-height: 28px; margin-bottom: 12px; font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--dim); }
.history-notice { color: var(--id); }
.history-toggle { height: 24px; padding: 0 8px; border: 1px solid var(--line-14); background: transparent; color: var(--dim); font: inherit; cursor: pointer; }
.history-toggle:hover, .history-toggle:focus-visible { color: var(--fg); border-color: var(--line-25); outline: none; }
.history-toggle[aria-pressed="true"] { color: var(--fg); background: var(--chip-bg); }

/* touch / narrow: no hover, so the actions are always visible */
@media (max-width: 720px), (hover: none) {
  .msg-btn { opacity: 1; }
}
```

### Step 10: Reply chip
**File:** `web/src/components/ReplyChip.tsx` (new)
**Code:**
```tsx
import { useEffect } from 'react';
import { ArrowBendUpLeft, X } from '@phosphor-icons/react';
import { authorOf, snippetOf } from '../lib/chatReply';
import type { ChatMessage } from '../types';
import './MessageItem.css';

export interface ReplyChipProps {
  target: ChatMessage;
  onCancel: () => void;
}

/**
 * "replying to <author> <snippet> [x]", rendered by P9's HistoryComposer above its page ChatBar.
 * Esc anywhere clears it, unless something else already handled that Esc (the Lightbox prevents it).
 */
export function ReplyChip({ target, onCancel }: ReplyChipProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const author = authorOf(target);
  const snippet = snippetOf(target.text);
  return (
    <div className="reply-chip" role="group" aria-label={`Replying to ${author}: ${snippet}`} data-reply-chip={target.id}>
      <ArrowBendUpLeft weight="duotone" aria-hidden="true" />
      <span className="reply-chip-author">{author}</span>
      <span className="reply-chip-text">{snippet}</span>
      <button type="button" className="copybtn" data-tip="Cancel reply" aria-label="Cancel reply" onClick={onCancel}>
        <X weight="duotone" />
      </button>
    </div>
  );
}
```

### Step 11: Page tools
**File:** `web/src/components/HistoryTools.tsx` (new)
**Code:**
```tsx
import './MessageItem.css';

export interface HistoryToolsProps {
  showDeleted: boolean;
  onToggleDeleted: () => void;
  /** Quiet one-line notice (jump gave up, an action failed); null hides it. */
  notice: string | null;
}

/** The history page header's right side: the quiet notice and the "Show deleted" toggle. */
export function HistoryTools({ showDeleted, onToggleDeleted, notice }: HistoryToolsProps) {
  return (
    <div className="history-tools">
      {notice && (
        <span className="history-notice" role="status">
          {notice}
        </span>
      )}
      <button type="button" className="history-toggle" aria-pressed={showDeleted} onClick={onToggleDeleted}>
        Show deleted
      </button>
    </div>
  );
}
```


### Step 12: `useHistory` sends replies; the count line skips deleted rows (P9 files)
**File:** `web/src/hooks/useHistory.ts` (P9 Step 16). P9 already provides `messages`, `mutate`, `loadOlder(): Promise<ChatMessage[]>` (resolves the prepended page, `[]` at the start, shares an in-flight load) and the `includeDeleted` option, so only `send` changes.
**Change:**

(a) Imports: add after P9's `../lib/timeline` import
```ts
import { threadForReply } from '../lib/chatReply';
```

(b) `HistoryStore`: replace
```ts
  /** Send from the history composer. False when refused (empty, or a reply still streaming): keep the draft. */
  send: (text: string, imageIds: string[]) => boolean;
```
with
```ts
  /**
   * Send from the history composer. False when refused (empty, or a reply still streaming): keep the
   * draft. `replyTo` (phase 10): the bubble this message answers; a wall bubble continues its thread,
   * a claude_code bubble starts a new one (Decision), and the POST carries `reply_to`.
   */
  send: (text: string, imageIds: string[], replyTo?: ChatMessage) => boolean;
```

(c) In `send`, replace the signature and the thread line
```ts
  const send = useCallback((text: string, imageIds: string[]): boolean => {
```
```ts
    const threadId = threadForSend(timelineOf(now.server, now.local));
```
with
```ts
  const send = useCallback((text: string, imageIds: string[], replyTo?: ChatMessage): boolean => {
```
```ts
    const threadId = replyTo
      ? (threadForReply(replyTo) ?? undefined)
      : threadForSend(timelineOf(now.server, now.local));
```

(d) Replace the POST line
```ts
        const res = await streamChat({ message, threadId, imageIds, signal: c.signal });
```
with
```ts
        const res = await streamChat({ message, threadId, imageIds, replyTo: replyTo?.id, signal: c.signal });
```
The optimistic local bubbles stay as P9 builds them (no quote header): the server row, with its `reply_to` preview, replaces them on the refresh after `accepted`/`done`.

**File:** `web/src/lib/timeline.ts` (P9 Step 9). With App fetching deleted rows (Step 14), the header count must skip them. In `historyCountLine` replace
```ts
  const shown = items.filter((i) => !i.local?.error);
```
with
```ts
  // Phase 10 keeps deleted rows loaded for "Show deleted"; the header counts live messages only.
  const shown = items.filter((i) => !i.local?.error && !i.msg.deleted_at);
```
`threadForSend` already skips deleted rows (P9), so the default thread rule is unaffected.

**File:** `web/src/lib/timeline.test.tsx` (P9 Step 10). Append:
```tsx
describe('historyCountLine (phase 10)', () => {
  it('does not count deleted rows', () => {
    const items = timelineOf(
      [makeMessage('A001'), makeMessage('A002', { deleted_at: '2026-10-31T02:00:00.000Z' })],
      [],
    );
    expect(historyCountLine(items, false)).toBe('1 messages in 1 threads.');
  });
});
```
(`historyCountLine`, `timelineOf` and `makeMessage` are already imported by P9's test file; add any of them to its import lines if missing.)
**Impact:** P9's `useHistory` callers that pass two arguments are unchanged; P9's count tests use no deleted rows.

### Step 13: `HistoryPage` wiring (P9 file)
**File:** `web/src/pages/HistoryPage.tsx` (P9 Step 19)
**Change:**

(a) Imports: replace P9's import block
```tsx
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Bubble } from '../components/Bubble';
import { ChatBar } from '../components/ChatBar';
import { Lightbox, type LightboxItem } from '../components/Lightbox';
import { useChatImages } from '../hooks/useChatImages';
import { chatTime } from '../lib/chatTime';
import type { TimelineItem } from '../lib/timeline';
import type { HistoryStore } from '../hooks/useHistory';
import './HistoryPage.css';
```
with
```tsx
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bubble, type BubbleProps } from '../components/Bubble';
import { ChatBar } from '../components/ChatBar';
import { HistoryTools } from '../components/HistoryTools';
import { Lightbox, type LightboxItem } from '../components/Lightbox';
import { MessageItem } from '../components/MessageItem';
import { ReplyChip } from '../components/ReplyChip';
import { useChatImages } from '../hooks/useChatImages';
import { useHistoryActions } from '../hooks/useHistoryActions';
import type { UndoEntry } from '../hooks/useUndo';
import { chatTime } from '../lib/chatTime';
import type { TimelineItem } from '../lib/timeline';
import type { HistoryStore } from '../hooks/useHistory';
import type { ChatMessage } from '../types';
import './HistoryPage.css';
```

(b) `HistoryPageProps`: add after `now: Date;`
```tsx
  /**
   * App's single undo store (one UndoBar on screen): bubble deletes push their restore here. App
   * always passes it; optional only so P9's `HistoryPage.test.tsx` renders keep compiling (no undo bar there).
   */
  pushUndo?: (entry: UndoEntry) => void;
```
and add above `export function HistoryPage`:
```tsx
const NO_UNDO = (): void => {};
```

(c) Replace P9's whole `HistoryComposer` function with
```tsx
function HistoryComposer({
  store,
  replyTo,
  onCancelReply,
}: {
  store: HistoryStore;
  /** Phase 10: the bubble being replied to (the chip above the bar), or null. */
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
}) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // An image still uploading (or failed and not removed) holds the message back, as on the wall.
    if (images.blocked) return;
    const ids = images.readyIds;
    if (!draft.trim() && ids.length === 0) return;
    if (store.send(draft, ids, replyTo ?? undefined)) {
      setDraft('');
      images.clear();
      onCancelReply();
    }
  };
  return (
    <div className="hist-composer">
      {replyTo && <ReplyChip target={replyTo} onCancel={onCancelReply} />}
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
      />
    </div>
  );
}
```
(P9's doc comment above it stays.)

(d) Replace the first two lines of `HistoryPage`
```tsx
export function HistoryPage({ store, focusThread, now }: HistoryPageProps) {
  const { items, loaded, error, hasMore, loadingOlder, loadOlder } = store;
```
with
```tsx
export function HistoryPage({ store, focusThread, now, pushUndo = NO_UNDO }: HistoryPageProps) {
  const { items, loaded, error, hasMore, loadingOlder, loadOlder } = store;
  const ha = useHistoryActions({ history: store, pushUndo });
  // Deleted server rows are loaded (App fetches include_deleted=1) and shown only with "Show deleted".
  const shown = useMemo(() => items.filter((it) => it.local !== null || ha.isShown(it.msg)), [items, ha.isShown]);
```
P9's scroll and focus effects keep reading `items` (a hidden deleted row moves nothing on screen).

(e) Replace P9's JSX from `<section …>` through `</ol>`:
```tsx
    <section className="history" aria-label="Chat history">
      {hasMore && (
```
→ insert the tools line right after the `<section …>` opening line:
```tsx
    <section className="history" aria-label="Chat history">
      <HistoryTools showDeleted={ha.showDeleted} onToggleDeleted={ha.toggleShowDeleted} notice={ha.notice} />
      {hasMore && (
```
and replace the list
```tsx
      <ol className="hist-list" ref={listRef}>
        {items.map((it, i) => {
          const prev = i > 0 ? items[i - 1] : undefined;
          const divider = prev === undefined || prev.msg.thread_id !== it.msg.thread_id;
          return (
            <Fragment key={it.key}>
              {divider && <ThreadDivider item={it} now={now} />}
              <Bubble
                item={it}
                now={now}
                focused={flash !== null && it.msg.thread_id === flash}
                onOpenImages={(lbItems, index) => setBox({ items: lbItems, index })}
              />
            </Fragment>
          );
        })}
      </ol>
      <HistoryComposer store={store} />
```
with
```tsx
      <ol className="hist-list" ref={listRef}>
        {shown.map((it, i) => {
          const prev = i > 0 ? shown[i - 1] : undefined;
          const divider = prev === undefined || prev.msg.thread_id !== it.msg.thread_id;
          const bubble: BubbleProps = {
            item: it,
            now,
            focused: flash !== null && it.msg.thread_id === flash,
            onOpenImages: (lbItems, index) => setBox({ items: lbItems, index }),
          };
          return (
            <Fragment key={it.key}>
              {divider && <ThreadDivider item={it} now={now} />}
              {/* Server rows get the phase 10 actions; local (sending / streaming / failed) bubbles stay plain. */}
              {it.local === null ? <MessageItem {...ha.itemProps(it.msg)} bubble={bubble} /> : <Bubble {...bubble} />}
            </Fragment>
          );
        })}
      </ol>
      <HistoryComposer store={store} replyTo={ha.replyTo} onCancelReply={ha.cancelReply} />
```
The `{box && <Lightbox …/>}` block and `</section>` stay.
**Impact:** P9's `HistoryPage.test.tsx` renders `<HistoryPage store focusThread now />` with a complete fake `HistoryStore` (it already has `messages`, `mutate`, `loadOlder`), which still compiles and passes: no row there is deleted and `pushUndo` is optional. P9's assertions on `[data-msg]`, `.bubble time`, thumbnails and `[data-msg-key]` still hold: each server row is still one `li.bubble[data-msg]`, now with an action foot.

### Step 14: App: deleted rows loaded, undo store passed
**File:** `web/src/App.tsx` (as P9 Step 24 left it)
**Change:** replace P9's hook line
```ts
  const history = useHistory(view === 'history');
```
with
```ts
  // Deleted rows are loaded too: the page's "Show deleted" toggle (phase 10) filters on the client.
  const history = useHistory(view === 'history', { includeDeleted: true });
```
and P9's main-content element
```tsx
            <HistoryPage store={history} focusThread={historyThread} now={now} />
```
with
```tsx
            <HistoryPage store={history} focusThread={historyThread} now={now} pushUndo={pushUndo} />
```
`pushUndo` is App's existing `useUndo()` push (`const { entry: undoEntry, push: pushUndo, undo: runUndo } = useUndo();`).
**Impact:** one `UndoBar` serves wall and history deletes, so two bars never stack at the same fixed spot. P9's `App.history.test.tsx` fetch stubs answer every `GET /api/chat/messages…` the same way, so the extra `include_deleted=1` query parameter changes none of its assertions.

### Step 15: Pure helper tests
**File:** `web/src/lib/chatReply.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { answerMap, authorOf, messageSelector, resolveReply, snippetOf, threadForReply } from './chatReply';
import { makeMessage } from '../testing/chatFixtures';

describe('chatReply', () => {
  it('snippetOf collapses whitespace and cuts with an ellipsis', () => {
    expect(snippetOf('  a\n\n b  ')).toBe('a b');
    const long = 'x'.repeat(100);
    const s = snippetOf(long);
    expect(s.length).toBe(80);
    expect(s.endsWith('…')).toBe(true);
  });

  it('authorOf names the user "you" and every assistant "claude"', () => {
    expect(authorOf({ role: 'user' })).toBe('you');
    expect(authorOf({ role: 'assistant' })).toBe('claude');
  });

  it('threadForReply: a wall bubble continues its thread, a claude_code bubble starts a new one', () => {
    expect(threadForReply(makeMessage('W001', { source: 'wall', thread_id: 'TW01' }))).toBe('TW01');
    expect(threadForReply(makeMessage('C001', { source: 'claude_code', thread_id: 'TC01' }))).toBeNull();
  });

  it('answerMap pairs each question with the next live assistant row of its thread', () => {
    const q1 = makeMessage('Q001', { created_at: '2026-10-31T01:00:00.000Z' });
    const a1 = makeMessage('A001', { role: 'assistant', created_at: '2026-10-31T01:01:00.000Z' });
    const q2 = makeMessage('Q002', { created_at: '2026-10-31T01:02:00.000Z' });
    const a2 = makeMessage('A002', { role: 'assistant', created_at: '2026-10-31T01:03:00.000Z', deleted_at: '2026-10-31T02:00:00.000Z' });
    const other = makeMessage('Q003', { thread_id: 'TW02', created_at: '2026-10-31T00:59:00.000Z' });
    const m = answerMap([a2, q2, a1, q1, other]);
    expect(m.get('Q001')?.id).toBe('A001');
    expect(m.has('Q002')).toBe(false);
    expect(m.has('Q003')).toBe(false);
  });

  it('resolveReply prefers the loaded target, else the server preview (role null reads "message")', () => {
    const t = makeMessage('A001', { role: 'assistant', text: 'new text', deleted_at: '2026-10-31T02:00:00.000Z' });
    const byId = new Map([[t.id, t]]);
    expect(resolveReply({ id: 'A001', role: 'assistant', text: 'old', deleted: false }, byId)).toEqual({
      id: 'A001',
      author: 'claude',
      snippet: 'new text',
      deleted: true,
    });
    expect(resolveReply({ id: 'Z001', role: null, text: 'far back', deleted: false }, byId)).toEqual({
      id: 'Z001',
      author: 'message',
      snippet: 'far back',
      deleted: false,
    });
    expect(resolveReply({ id: 'Z001', role: 'user', text: 'far back', deleted: false }, byId).author).toBe('you');
  });

  it('messageSelector targets the bubble root', () => {
    expect(messageSelector('K7F2')).toBe('[data-msg="K7F2"]');
  });
});
```

### Step 16: API tests
**File:** `web/src/api.chatActions.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { deleteChatMessage, editChatMessage, fetchChatMessages, restoreChatMessage, streamChat } from './chatHistoryApi';
import { makeMessage } from './testing/chatFixtures';

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function stub(status: number, body: unknown): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('chat message actions API (phase 7 wire)', () => {
  it('editChatMessage PATCHes {text} and returns the bare message', async () => {
    const msg = makeMessage('K7F2', { text: 'fixed', edited_at: '2026-10-31T02:00:00.000Z' });
    const seen = stub(200, msg);
    expect(await editChatMessage('K7F2', 'fixed')).toEqual(msg);
    expect(seen[0]).toEqual({ url: '/api/chat/messages/K7F2', method: 'PATCH', body: { text: 'fixed' } });
  });

  it('deleteChatMessage adds with_answer=1 only when asked and returns the deleted ids', async () => {
    const seen = stub(200, { deleted: ['K7F2', 'K7F3'] });
    expect(await deleteChatMessage('K7F2', false)).toEqual(['K7F2', 'K7F3']);
    await deleteChatMessage('K7F2', true);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'DELETE /api/chat/messages/K7F2',
      'DELETE /api/chat/messages/K7F2?with_answer=1',
    ]);
  });

  it('restoreChatMessage POSTs to /restore', async () => {
    const seen = stub(200, makeMessage('K7F2'));
    expect((await restoreChatMessage('K7F2')).id).toBe('K7F2');
    expect(`${seen[0].method} ${seen[0].url}`).toBe('POST /api/chat/messages/K7F2/restore');
  });

  it('fetchChatMessages sends include_deleted=1 when asked', async () => {
    const seen = stub(200, { messages: [], next_before: null });
    await fetchChatMessages({ includeDeleted: true });
    expect(seen[0].url).toContain('include_deleted=1');
  });

  it('streamChat sends reply_to only when replyTo is set', async () => {
    const seen = stub(200, {});
    const signal = new AbortController().signal;
    await streamChat({ message: 'more', threadId: 'T1', replyTo: 'A001', signal });
    await streamChat({ message: 'more', signal });
    expect(seen[0].body).toEqual({ message: 'more', thread_id: 'T1', reply_to: 'A001' });
    expect(seen[1].body).toEqual({ message: 'more' });
  });

  it('errors surface as ApiError with the server error code', async () => {
    stub(400, { error: 'not_editable' });
    await expect(editChatMessage('K7F2', 'x')).rejects.toEqual(new ApiError(400, 'not_editable'));
  });
});
```

### Step 17: Component tests
**File:** `web/src/components/MessageItem.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import type { BubbleProps } from './Bubble';
import type { MessageItemWiring } from '../hooks/useHistoryActions';
import type { ChatMessage } from '../types';
import { makeMessage } from '../testing/chatFixtures';

afterEach(cleanup);

const NOW = new Date('2026-10-31T05:00:00.000Z');

function wiring(message: ChatMessage, over: Partial<MessageItemWiring> = {}): MessageItemWiring {
  return {
    message,
    reply: null,
    hasAnswer: false,
    onReply: vi.fn(),
    onJump: vi.fn(),
    onEdit: vi.fn(async () => true),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    ...over,
  };
}

const bubbleFor = (m: ChatMessage): BubbleProps => ({ item: { key: m.id, msg: m, local: null }, now: NOW, focused: false, onOpenImages: vi.fn() });

function renderItem(w: MessageItemWiring) {
  return render(
    <ol>
      <MessageItem {...w} bubble={bubbleFor(w.message)} />
    </ol>,
  );
}

describe('MessageItem', () => {
  it('is the bubble li itself ([data-msg], focusable) and offers Reply/Edit/Delete on a user bubble', () => {
    const w = wiring(makeMessage('Q001'));
    const { container } = renderItem(w);
    const li = container.querySelector('[data-msg="Q001"]') as HTMLElement;
    expect(li.tagName).toBe('LI');
    expect(li.classList.contains('bubble')).toBe(true);
    expect(li.tabIndex).toBe(-1);
    expect(container.querySelectorAll('ol > li')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reply to message [msg:Q001]' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit message [msg:Q001]' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reply to message [msg:Q001]' }));
    expect(w.onReply).toHaveBeenCalledWith(w.message);
  });

  it('an assistant bubble has no Edit', () => {
    renderItem(wiring(makeMessage('A001', { role: 'assistant' })));
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete message [msg:A001]' })).toBeTruthy();
  });

  it('edit: Enter saves, Shift+Enter is left to the textarea, the hint explains future-only', () => {
    const w = wiring(makeMessage('Q001', { text: 'old' }));
    const { container } = renderItem(w);
    fireEvent.click(screen.getByRole('button', { name: 'Edit message [msg:Q001]' }));
    const ta = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
    expect((container.querySelector('.bubble-body') as HTMLElement).hidden).toBe(true);
    expect(screen.getByText(/only future replies see the edit/)).toBeTruthy();
    expect(fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.change(ta, { target: { value: 'new\nlines' } });
    expect(fireEvent.keyDown(ta, { key: 'Enter' })).toBe(false);
    expect(w.onEdit).toHaveBeenCalledWith('Q001', 'new\nlines');
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect((container.querySelector('.bubble-body') as HTMLElement).hidden).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit message [msg:Q001]' }));
  });

  it('edit: blank text is rejected client-side, Esc cancels', () => {
    const w = wiring(makeMessage('Q001', { text: 'old' }));
    renderItem(w);
    fireEvent.click(screen.getByRole('button', { name: 'Edit message [msg:Q001]' }));
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('a message cannot be empty');
    expect(w.onEdit).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect(screen.getByText('old')).toBeTruthy();
    expect(w.onEdit).not.toHaveBeenCalled();
  });

  it('delete without an answer deletes at once', () => {
    const w = wiring(makeMessage('Q001'));
    renderItem(w);
    fireEvent.click(screen.getByRole('button', { name: 'Delete message [msg:Q001]' }));
    expect(w.onDelete).toHaveBeenCalledWith('Q001', false);
  });

  it('delete of a question with an answer asks first; both choices work; Esc cancels back to Delete', () => {
    const w = wiring(makeMessage('Q001'), { hasAnswer: true });
    renderItem(w);
    const del = screen.getByRole('button', { name: 'Delete message [msg:Q001]' });
    fireEvent.click(del);
    const group = screen.getByRole('group', { name: 'Delete the answer too?' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Question only' }));
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Delete the answer too?' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete message [msg:Q001]' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete message [msg:Q001]' }));
    fireEvent.click(screen.getByRole('button', { name: 'Question and answer' }));
    expect(w.onDelete).toHaveBeenCalledWith('Q001', true);
  });

  it('a deleted bubble is dimmed and offers only Restore', () => {
    const w = wiring(makeMessage('Q001', { deleted_at: '2026-10-31T02:00:00.000Z' }));
    const { container } = renderItem(w);
    const li = container.querySelector('[data-msg="Q001"]') as HTMLElement;
    expect(li.classList.contains('msg-deleted')).toBe(true);
    expect(li.getAttribute('aria-label')).toBe('deleted message [msg:Q001]');
    expect(screen.queryByRole('button', { name: /^Reply/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore message [msg:Q001]' }));
    expect(w.onRestore).toHaveBeenCalledWith('Q001');
  });

  it('reply header: live target is a button that jumps; deleted target reads "message deleted" and is not clickable', () => {
    const live = wiring(makeMessage('Q002'), { reply: { id: 'A001', author: 'claude', snippet: 'You noted v250.', deleted: false } });
    renderItem(live);
    fireEvent.click(screen.getByRole('button', { name: /Go to the quoted message from claude/ }));
    expect(live.onJump).toHaveBeenCalledWith('A001');
    cleanup();
    renderItem(wiring(makeMessage('Q003'), { reply: { id: 'A009', author: 'claude', snippet: 'gone', deleted: true } }));
    const dead = screen.getByText('message deleted');
    expect(dead.closest('button')).toBeNull();
  });

  it('an edited bubble shows "edited" with the edit time in its tip', () => {
    renderItem(wiring(makeMessage('Q001', { edited_at: '2026-10-31T02:00:00.000Z' })));
    const mark = screen.getByText('edited');
    expect(mark.getAttribute('data-tip')).toMatch(/^edited .+/);
  });
});
```

### Step 18: Flow tests with mocked fetch
**File:** `web/src/components/BubbleActions.flow.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatMessage } from '../types';
import { useUndo } from '../hooks/useUndo';
import { useHistoryActions } from '../hooks/useHistoryActions';
import { SHOW_DELETED_KEY } from '../hooks/useShowDeleted';
import { chatTimeTitle } from '../lib/chatTime';
import type { BubbleProps } from './Bubble';
import { MessageItem } from './MessageItem';
import { ReplyChip } from './ReplyChip';
import { HistoryTools } from './HistoryTools';
import { UndoBar } from './UndoBar';
import { makeMessage } from '../testing/chatFixtures';

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[];
let fail: { method: string; status: number } | null;
let sent: Array<string | null>;
let scroll: ReturnType<typeof vi.fn>;
let animate: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  fail = null;
  sent = [];
  window.sessionStorage.clear();
  scroll = vi.fn();
  animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });
      if (fail && fail.method === method) {
        const s = fail.status;
        fail = null;
        return json({ error: 'boom' }, s);
      }
      const path = url.split('?')[0] ?? url;
      if (method === 'PATCH') {
        const id = path.split('/').pop() ?? '';
        return json(makeMessage(id, { text: (body as { text: string }).text, edited_at: '2026-10-31T02:00:00.000Z' }));
      }
      if (method === 'DELETE') {
        // P7: `{deleted}` lists what this call changed, question first. In these tests Q001's answer is A001.
        const id = path.split('/').pop() ?? '';
        return json({ deleted: url.includes('with_answer=1') ? [id, 'A001'] : [id] });
      }
      if (method === 'POST' && path.endsWith('/restore')) {
        return json(makeMessage(path.split('/').at(-2) ?? ''));
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
});

const Q1 = makeMessage('Q001', { text: 'what did I note about seer?', created_at: '2026-10-31T01:00:00.000Z' });
const A1 = makeMessage('A001', { role: 'assistant', text: 'You noted the v250 run.', created_at: '2026-10-31T01:01:00.000Z' });
const Q2 = makeMessage('Q002', {
  text: 'and the leaderboard?',
  created_at: '2026-10-31T01:02:00.000Z',
  reply_to: { id: 'A001', role: 'assistant', text: 'You noted the v250 run.', deleted: false },
});

const NOW = new Date('2026-10-31T05:00:00.000Z');
const bubbleFor = (m: ChatMessage): BubbleProps => ({ item: { key: m.id, msg: m, local: null }, now: NOW, focused: false, onOpenImages: () => {} });

let loadOlderCalls = 0;

/** The page-level wiring P9's HistoryPage gets in Step 13, with a stand-in for P9's HistoryComposer form. */
function Harness({ initial, older = [] }: { initial: ChatMessage[]; older?: ChatMessage[][] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const pages = useRef<ChatMessage[][]>([...older]);
  const loadOlder = useCallback(async () => {
    loadOlderCalls += 1;
    const page = pages.current.shift() ?? [];
    setMessages((ms) => [...page, ...ms]);
    return page;
  }, []);
  const undo = useUndo();
  const ha = useHistoryActions({ history: { messages, loadOlder, mutate: setMessages }, pushUndo: undo.push });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // HistoryComposer (Step 13): send with the reply target, then clear the chip.
    sent.push(ha.replyTo?.id ?? null);
    ha.cancelReply();
  };
  return (
    <>
      <HistoryTools showDeleted={ha.showDeleted} onToggleDeleted={ha.toggleShowDeleted} notice={ha.notice} />
      <ol className="hist-list">
        {messages.filter(ha.isShown).map((m) => (
          <MessageItem key={m.id} {...ha.itemProps(m)} bubble={bubbleFor(m)} />
        ))}
      </ol>
      <div className="hist-composer">
        {ha.replyTo && <ReplyChip target={ha.replyTo} onCancel={ha.cancelReply} />}
        <form className="chatbar" onSubmit={submit}>
          <textarea aria-label="Ask about your notes" />
          <button type="submit">Send</button>
        </form>
      </div>
      <UndoBar entry={undo.entry} onUndo={undo.undo} />
    </>
  );
}

const btn = (name: string | RegExp) => screen.getByRole('button', { name });
const bubble = (id: string) => document.querySelector(`[data-msg="${id}"]`);

describe('bubble actions (history page wiring, mocked API)', () => {
  it('reply: chip with author and snippet, composer focused, X and Esc clear it, send takes the target', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Reply to message [msg:A001]'));
    const chip = screen.getByRole('group', { name: /^Replying to claude/ });
    expect(chip.textContent).toContain('You noted the v250 run.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask about your notes')));
    fireEvent.click(within(chip).getByRole('button', { name: 'Cancel reply' }));
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull();

    fireEvent.click(btn('Reply to message [msg:Q001]'));
    expect(screen.getByRole('group', { name: /^Replying to you/ })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull();

    fireEvent.click(btn('Reply to message [msg:A001]'));
    fireEvent.click(btn('Send'));
    expect(sent).toEqual(['A001']);
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull();
  });

  it('edit: optimistic text, PATCH {text}, "edited" mark with the UTC+7 time', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Edit message [msg:Q001]'));
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(ta, { target: { value: 'what about seer v250?' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(screen.getByText('what about seer v250?')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toEqual({ method: 'PATCH', url: '/api/chat/messages/Q001', body: { text: 'what about seer v250?' } });
    await waitFor(() =>
      expect(screen.getByText('edited').getAttribute('data-tip')).toBe(`edited ${chatTimeTitle('2026-10-31T02:00:00.000Z')}`),
    );
  });

  it('edit rollback: a failed PATCH puts the old text back and says so', async () => {
    fail = { method: 'PATCH', status: 500 };
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Edit message [msg:Q001]'));
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(ta, { target: { value: 'changed' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.history-notice')?.textContent).toBe('edit failed: boom'));
    expect(screen.getByText('what did I note about seer?')).toBeTruthy();
    expect(screen.queryByText('edited')).toBeNull();
  });

  it('delete an answer: gone at once, DELETE without with_answer, Undo restores it', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:A001]'));
    expect(bubble('A001')).toBeNull();
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('DELETE /api/chat/messages/A001'));
    expect(document.querySelector('.undo')?.textContent).toBe('deleted [msg:A001]');
    fireEvent.click(btn('Undo'));
    await waitFor(() => expect(bubble('A001')).not.toBeNull());
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('POST /api/chat/messages/A001/restore');
  });

  it('delete a question with its answer: confirm, DELETE ?with_answer=1, Undo restores both', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:Q001]'));
    fireEvent.click(btn('Question and answer'));
    expect(bubble('Q001')).toBeNull();
    expect(bubble('A001')).toBeNull();
    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('DELETE /api/chat/messages/Q001?with_answer=1'),
    );
    expect(document.querySelector('.undo')?.textContent).toBe('deleted [msg:Q001] and its answer');
    fireEvent.click(btn('Undo'));
    await waitFor(() => expect(bubble('Q001')).not.toBeNull());
    expect(bubble('A001')).not.toBeNull();
    const restores = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(restores).toEqual(['/api/chat/messages/Q001/restore', '/api/chat/messages/A001/restore']);
  });

  it('delete "Question only" keeps the answer', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:Q001]'));
    fireEvent.click(btn('Question only'));
    expect(bubble('Q001')).toBeNull();
    expect(bubble('A001')).not.toBeNull();
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('DELETE /api/chat/messages/Q001'));
  });

  it('delete rollback: a failed DELETE brings the bubble back and says so', async () => {
    fail = { method: 'DELETE', status: 500 };
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:A001]'));
    expect(bubble('A001')).toBeNull();
    await waitFor(() => expect(bubble('A001')).not.toBeNull());
    expect(document.querySelector('.history-notice')?.textContent).toBe('delete failed: boom');
  });

  it('a reply whose target gets deleted reads "message deleted" and is not clickable', async () => {
    render(<Harness initial={[Q1, A1, Q2]} />);
    expect(btn(/Go to the quoted message from claude/)).toBeTruthy();
    fireEvent.click(btn('Delete message [msg:A001]'));
    const dead = screen.getByText('message deleted');
    expect(dead.closest('button')).toBeNull();
  });

  it('show deleted: lists deleted bubbles dimmed with Restore, persists in sessionStorage', async () => {
    const D = makeMessage('D001', { text: 'deleted one', deleted_at: '2026-10-31T03:00:00.000Z' });
    const { unmount } = render(<Harness initial={[Q1, D]} />);
    expect(bubble('D001')).toBeNull();
    const toggle = btn('Show deleted');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(bubble('D001')?.classList.contains('msg-deleted')).toBe(true);
    expect(window.sessionStorage.getItem(SHOW_DELETED_KEY)).toBe('1');
    fireEvent.click(btn('Restore message [msg:D001]'));
    expect(bubble('D001')?.classList.contains('msg-deleted')).toBe(false);
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('POST /api/chat/messages/D001/restore'));
    unmount();
    render(<Harness initial={[Q1, makeMessage('D002', { deleted_at: '2026-10-31T03:00:00.000Z' })]} />);
    expect(bubble('D002')).not.toBeNull();
  });

  it('jump: clicking a quote loads older pages until the target is there, then scrolls to and pulses it', async () => {
    loadOlderCalls = 0;
    const far = makeMessage('Z001', { text: 'a far older question', created_at: '2026-10-01T01:00:00.000Z' });
    const mid = makeMessage('Y001', { text: 'somewhat older', created_at: '2026-10-20T01:00:00.000Z' });
    const q = makeMessage('Q009', { reply_to: { id: 'Z001', role: 'user', text: 'a far older question', deleted: false } });
    render(<Harness initial={[q]} older={[[mid], [far]]} />);
    fireEvent.click(btn(/Go to the quoted message from you/));
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    expect(loadOlderCalls).toBe(2);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(animate.mock.contexts[0]).toBe(bubble('Z001'));
    expect(document.activeElement).toBe(bubble('Z001'));
  });

  it('jump gives up quietly when the target never turns up', async () => {
    const q = makeMessage('Q009', { reply_to: { id: 'Z999', role: null, text: 'lost', deleted: false } });
    render(<Harness initial={[q]} older={[[makeMessage('Y001')]]} />);
    fireEvent.click(btn(/Go to the quoted message from message/));
    await waitFor(() => expect(document.querySelector('.history-notice')?.textContent).toBe('original message not found'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('keyboard: actions are reachable with Tab, the confirm is keyboard-driven, focus moves to the next bubble after delete', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[Q1, A1]} />);
    await user.tab(); // Show deleted
    await user.tab();
    expect(document.activeElement).toBe(btn('Reply to message [msg:Q001]'));
    await user.tab();
    expect(document.activeElement).toBe(btn('Edit message [msg:Q001]'));
    await user.tab();
    expect(document.activeElement).toBe(btn('Delete message [msg:Q001]'));
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(btn('Question only'));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(btn('Delete message [msg:Q001]'));
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}'); // "Question only"
    await waitFor(() => expect(document.activeElement).toBe(bubble('A001')));

    btn('Delete message [msg:A001]').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask about your notes')));
  });

  it('keyboard: Edit by Enter, save by Enter, focus returns to Edit', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[Q1, A1]} />);
    btn('Edit message [msg:Q001]').focus();
    await user.keyboard('{Enter}');
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    expect(document.activeElement).toBe(ta);
    await user.keyboard(' now{Enter}');
    expect(screen.getByText('what did I note about seer? now')).toBeTruthy();
    expect(document.activeElement).toBe(btn('Edit message [msg:Q001]'));
  });
});
```

### Step 19: Jump hook unit tests
**File:** `web/src/hooks/useJumpToMessage.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { JUMP_MAX_PAGES, NOT_FOUND_NOTICE, useJumpToMessage } from './useJumpToMessage';
import { makeMessage } from '../testing/chatFixtures';

let animate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('useJumpToMessage', () => {
  it('a loaded target is pulsed without loading anything', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div data-msg="K7F2" tabindex="-1"></div>');
    const loadOlder = vi.fn(async () => []);
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useJumpToMessage({ messages: [makeMessage('K7F2')], loadOlder, notify, showDeleted: false }),
    );
    await act(() => result.current('K7F2'));
    expect(loadOlder).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('stops after JUMP_MAX_PAGES non-empty pages and says so', async () => {
    const loadOlder = vi.fn(async () => [makeMessage('Y001')]);
    const notify = vi.fn();
    const { result } = renderHook(() => useJumpToMessage({ messages: [], loadOlder, notify, showDeleted: false }));
    await act(() => result.current('Z001'));
    expect(loadOlder).toHaveBeenCalledTimes(JUMP_MAX_PAGES);
    expect(notify).toHaveBeenCalledWith(NOT_FOUND_NOTICE);
  });

  it('a deleted target with "Show deleted" off is reported, not scrolled to', async () => {
    const loadOlder = vi.fn(async () => []);
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useJumpToMessage({
        messages: [makeMessage('K7F2', { deleted_at: '2026-10-31T02:00:00.000Z' })],
        loadOlder,
        notify,
        showDeleted: false,
      }),
    );
    await act(() => result.current('K7F2'));
    expect(notify).toHaveBeenCalledWith('message deleted');
    expect(animate).not.toHaveBeenCalled();
  });

  it('a failed page load is a quiet notice', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadOlder = vi.fn(async () => {
      throw new Error('offline');
    });
    const notify = vi.fn();
    const { result } = renderHook(() => useJumpToMessage({ messages: [], loadOlder, notify, showDeleted: false }));
    await act(() => result.current('Z001'));
    expect(notify).toHaveBeenCalledWith('could not load older messages');
    err.mockRestore();
  });
});
```


### Step 20: `useHistory` reply contract tests
**File:** `web/src/hooks/useHistory.reply.test.tsx` (new). Same fakes as P9's `useHistory.test.tsx` (a stub `EventSource` for `lib/events`, a `fetch` stub for `/api/chat/messages` and `POST /api/chat`).
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useHistory } from './useHistory';
import { makeMessage } from '../testing/chatFixtures';

const W_Q = makeMessage('W001', { thread_id: 'TW01', source: 'wall', created_at: '2026-10-31T01:00:00.000Z' });
const W_A = makeMessage('W002', { role: 'assistant', thread_id: 'TW01', source: 'wall', created_at: '2026-10-31T01:01:00.000Z' });
const C_Q = makeMessage('C001', { thread_id: 'TC01', source: 'claude_code', created_at: '2026-10-31T01:02:00.000Z' });
const C_A = makeMessage('C002', { role: 'assistant', thread_id: 'TC01', source: 'claude_code', created_at: '2026-10-31T01:03:00.000Z' });

let gets: string[];
let posts: Array<Record<string, unknown>>;

class FakeES {
  constructor(public url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const sse = (frames: Array<{ event: string; data: unknown }>) =>
  frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');

beforeEach(() => {
  gets = [];
  posts = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        gets.push(url);
        return new Response(JSON.stringify({ messages: [W_Q, W_A, C_Q, C_A], next_before: null }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = sse([
        { event: 'accepted', data: { thread_id: 'TNEW', user_message_id: 'N001' } },
        { event: 'done', data: { thread_id: 'TNEW', user_message_id: 'N001', assistant_message_id: 'N002', reply_to: null, brain: 'claude' } },
      ]);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => renderHook(() => useHistory(true, { includeDeleted: true }));

describe('useHistory (phase 10 contract)', () => {
  it('fetches with include_deleted=1 and loadOlder resolves [] when nothing older remains', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.every((u) => u.includes('include_deleted=1'))).toBe(true);
    let page: unknown;
    await act(async () => {
      page = await result.current.loadOlder();
    });
    expect(page).toEqual([]);
  });

  it('a reply to a wall bubble continues its thread and carries reply_to', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    act(() => {
      expect(result.current.send('more on that', [], W_A)).toBe(true);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ message: 'more on that', thread_id: 'TW01', reply_to: 'W002' });
  });

  it('a reply to a claude_code bubble starts a new thread (no thread_id) with reply_to', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    act(() => {
      result.current.send('follow up', [], C_A);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].reply_to).toBe('C002');
    expect(posts[0]).not.toHaveProperty('thread_id');
  });

  it('without a reply target P9 rule applies and no reply_to is sent', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    act(() => {
      result.current.send('new question', []);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    // Newest live message is a claude_code answer: a new thread (P9 threadForSend).
    expect(posts[0]).not.toHaveProperty('thread_id');
    expect(posts[0]).not.toHaveProperty('reply_to');
  });
});
```

### Step 21: Docs
**File:** `CHANGELOG.md`. Add under `## [Unreleased]` → `### Added`; create `## [Unreleased]` (above `## [v0.1.0]`) or `### Added` only if missing (earlier phases normally created both; on merge there is exactly one of each).
**Code:**
```markdown
- **Chat history bubble actions**: reply to any bubble (quote chip above the composer, `reply_to` sent, quoted header jumps to the original), edit your questions in place (kept as a revision, marked "edited"; the answer is not regenerated), delete any bubble with a 6 s undo and an option to drop its answer, and a "Show deleted" toggle with restore.
```
**File:** `README.md`. Insert right after P9's `### The history page` paragraph (it ends "Back and forward move between the wall and this page."), before `## Connectors: spending, runs, Seer`:
```markdown

Hover or Tab onto a bubble for **Reply**, **Edit** (your own messages) and **Delete**. A reply shows a quote of the original; click it to jump there. Replying to a wall bubble continues that conversation; replying to a "claude code" bubble starts a new one. Edits only change what later turns see. Deletes can be undone for 6 seconds, and **Show deleted** lists them with a Restore button.
```

## Verification

**Build:** `npm run typecheck && npm run build`

**Tests:**
```bash
npx vitest run web/src/lib/chatReply.test.tsx web/src/api.chatActions.test.tsx \
  web/src/components/MessageItem.test.tsx web/src/components/BubbleActions.flow.test.tsx \
  web/src/hooks/useJumpToMessage.test.tsx web/src/hooks/useHistory.reply.test.tsx \
  web/src/lib/timeline.test.tsx web/src/pages/HistoryPage.test.tsx web/src/hooks/useHistory.test.tsx web/src/App.history.test.tsx
npm test
npm run test:int    # unchanged by this phase; Invariant 1
```

**Manual check:** `npm run dev` + `npm run dev:web`, then open `/history`:
- Hover a bubble: Reply, Edit (yours only) and Delete appear. Tab also reaches them.
- Reply: the chip appears above the page pill and Esc clears it. Send, and the new bubble shows the quote once the server row arrives. A reply to a claude-code bubble starts a new thread divider.
- Click a quote whose original is several pages back: older pages load, then the original pulses.
- Edit, then press Enter: the "edited" mark appears, and its tooltip shows the WIB time.
- Delete a question that has an answer: the two-button prompt appears. Undo brings both back.
- "Show deleted" lists deleted bubbles dimmed, each with Restore. The setting survives a reload. The header count does not include deleted bubbles.
- Narrow the window below 720px: the actions stay visible without hover.

**Exit criteria:** All new test files pass inside `npm test`, and `typecheck`, `build` and `test:int` are green. P9's `HistoryPage`, `useHistory`, `timeline` and `App.history` tests still pass. The flow test covers each action, edit and delete rollback, undo restore, show-deleted, jump with pagination, deleted-target text and keyboard paths. `AnswerPanel`, `ChatBar`, `api.ts` and `types.ts` are unchanged (`git diff --stat` touches none of them).

## Handoffs

- **P7:** nothing requested. The reply preview already carries `role` (nullable), a missing `thread_id` starts a new thread, DELETE returns `{deleted}`, restore is one id per call and idempotent, PATCH returns the bare message. No revisions route is needed (the UI shows only "edited" with its time).
- **P11:** P10 changes `Bubble.tsx` only as Step 7 lists (slots; the `parts.map(…)` text block is untouched), so P11 Step 6c replaces that block exactly as P9 wrote it. Quoted headers (`.msg-quote-text`) and the reply chip show plain snippets and are deliberately not linkified; P11 leaves them alone. `MessageItem` passes P9's `bubble` props through, so anything P11 adds inside `Bubble` (note links via context) also works for server rows on the history page.
- **Not done (out of scope):** the `/n` capture of edits, a revision-browsing UI, and a quote header on the optimistic (still local) bubble of a reply in flight; the server row shows it a moment later.

## Risks

- Valid list markup: each message is still one `li` (Step 7 slots); a future wrapper must not put a `div` between `ol.hist-list` and the `li`.
- Fetching with `include_deleted=1` puts deleted rows in every page. A page made mostly of deleted rows still loads older content through P9's "Earlier messages" button and top-of-page scroll, which can just fire again.
- `COMPOSER_SELECTOR` (`.hist-composer textarea`) assumes P9's composer keeps that wrapper class and that ChatBar renders one `textarea`.

## Rollback

Revert this phase's commits. The phase adds no migration or server change, so nothing needs a manual DB step. Reverting restores P9's `Bubble`, `HistoryPage`, `useHistory`, `timeline`, `chatHistoryApi` and the App line `useHistory(view === 'history')`, so deleted rows are no longer fetched. The `sessionStorage` key `mcp-notes:history:show-deleted` is harmless if left behind.
