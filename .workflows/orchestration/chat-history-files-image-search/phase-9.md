# Phase 9: History page, sidebar icon, full-screen button, timeline, thumbnails

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Design:** `docs/plans/2026-10-31-chat-history-files-image-search-design.md` (agreed, not re-litigated)
**Satisfies:** R3: the chat history gets its own page (`/history`), reached from a sidebar icon and from a "chat in full screen" button on the answer panel. Every bubble shows a Jakarta-time timestamp, and pasted images appear as thumbnails that open in the shared lightbox.
**Depends on:** Phase 2 (Lightbox), Phase 3 (ChatBar paste and chat image URLs), Phase 5 (last edit to `App.tsx` before this one), Phase 7 (chat persistence API and `event: chat`)
**Difficulty:** NORMAL
**Package:** `web`

---

## Goal

After this phase the web app has a third view, `history`, kept in sync with the URL (`/history`, `/history?thread=ID`, back and forward). It shows one timeline of every persisted chat message (wall and Claude Code) in ascending time order. It pages older messages as you scroll up, stays pinned to the bottom for new ones, puts a divider where the thread changes and a "claude code" badge on captured exchanges, shows a UTC+7 timestamp on every bubble, and renders chat-image thumbnails that open the Phase 2 Lightbox. The bottom pill is Phase 3's `ChatBar` in its `page` variant, rendered by the page with its own draft and pasted images. Sending from it streams the reply into an optimistic bubble, and both wall exchanges and captured `/n` exchanges appear live through `event: chat` on the existing `/api/events` connection, which is now shared instead of duplicated. The rail and the sidebar get a chat-history icon above the recycle bin, and the answer panel gets a "Chat in full screen" button that opens the page on the current thread.

## Assumptions (state of the tree after Phases 2, 3, 5, 7)

Reconciled against the final `phase-2.md`, `phase-3.md`, `phase-5.md` and `phase-7.md`. Every name below is theirs.

1. **Phase 2:** `web/src/components/Lightbox.tsx` exports
   `interface LightboxItem { id: string; src: string; label?: string; width?: number; height?: number; film?: boolean }`,
   `interface LightboxProps { items: LightboxItem[]; index: number; onIndex: (index: number) => void; onClose: () => void }`,
   and `function Lightbox(props)`, portaled to `document.body` with `data-lightbox=""`. Its window capture keydown listener handles ArrowLeft/ArrowRight/Escape with `preventDefault`, `stopPropagation` and `stopImmediatePropagation`, so App's document Esc listener never sees it. "Next image" / "Previous image" disable at the ends.
2. **Phase 3:**
   - `web/src/components/ChatBar.tsx`: `ChatBarProps { left?; value; onChange; onSubmit; images?: readonly ChatBarImage[]; onPasteFiles?; onRemoveImage?; sendBlocked?; variant?: 'wall' | 'page' }`. The form is `form.chatbar` (`chatbar chatbar-page` for the page variant, which ignores `left` and does not publish `--chatbar-h`), carries `data-chatbar={variant}`, and the textarea keeps `aria-label="Ask about your notes"`. Styling `.chatbar-page` is this phase's (Step 20).
   - `web/src/hooks/useChatImages.ts`: `useChatImages(upload?) => ChatImages { images: PendingChatImage[]; readyIds: string[]; blocked: boolean; add(files); remove(key); clear() }`. App holds the wall's instance as `chatImages`; `HistoryPage` creates its own for the page composer.
   - `web/src/api.ts`: `chatImageUrl(id, variant)`, `uploadChatImage`, `postChat(message, threadId, signal, imageIds = [])`. `useChat` (Phase 3 rewrite): `ChatState` has `images: string[]`; `ask(message, imageIds = [])`. `AnswerPanel` has `images?: readonly string[]` and an inert `.answer-images` thumbnail row (this phase wires it to the Lightbox).
   - Chat image variants are served at `GET /api/chat/images/:id/{thumb,display,original,preview}`.
3. **Phase 5:** edits `App.tsx` (the empty-note rules in `commit`/`closeEditor`, `attachFiles`, `onAttachFailed`, `removeFileWithUndo`, the `NoteEditor` and `DropOverlay` props). None of this phase's anchors (imports, `view` state, `toggleBin`, the Esc effect, `<Rail`, `<Sidebar`, `<Header`, the main-content conditional, `<AnswerPanel`, `<ChatBar`) is one Phase 5 edits.
4. **Phase 7 (final wire, `src/chat/types.ts`, `src/chat/events.ts`, `src/http/chatApi.ts`, `src/http/api.ts`):**
   - `GET /api/chat/messages?before=<cursor>&limit=<1..200, default 50>&include_deleted=<0|1|true|false>` → `{ messages: ChatMessageView[] (ascending), next_before: string | null }`.
   - `ChatMessageView` = `{ id, thread_id, role: 'user'|'assistant', text, source: 'wall'|'claude_code', brain: string|null, reply_to: {id, role: 'user'|'assistant'|null, text, deleted} | null, created_at, edited_at, deleted_at, attachments: {kind: 'chat_image'|'note_image'|'note_file', id, url, thumb_url: string|null}[] }`. Times are UTC ISO. Thread ids are UUIDs.
   - `POST /api/chat` body `{message, thread_id?, reply_to?, image_ids?}`; an absent or unknown `thread_id` starts a new thread. SSE: `accepted {thread_id, user_message_id}` first, then `delta {text}` / `status {text}`, then `done {thread_id, user_message_id, assistant_message_id, reply_to: string|null, brain?}` or `error {error}`. `thread_id` is OUR thread id.
   - `GET /api/events` emits `event: chat` with data `{op: 'created'|'updated'|'deleted'|'restored', thread_id, id}`.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/lib/chatTime.ts`: `CHAT_TZ`, `interface WallClock`, `jakartaParts(t)`, `chatTime(iso, now = Date.now())`, `chatTimeTitle(iso)` (there is no `formatChatTime`)
- `web/src/lib/route.ts`: `HISTORY_PATH`, `interface Route`, `routeFromLocation(loc)`, `historyHref(thread)`, `hrefForView(view, thread, loc)`
- `web/src/lib/events.ts`: `EVENTS_URL`, `subscribeEvents(type, fn): () => void` (one shared, ref-counted `EventSource` on `/api/events`)
- `web/src/lib/timeline.ts`: `HISTORY_HEADING`, `HISTORY_HINT`, `interface LocalBubble`, `interface TimelineItem`, `timeOf`, `sortMessages`, `mergeMessages`, `oldestMs`, `localToMessage`, `timelineOf`, `pruneLocal`, `threadForSend`, `historyCountLine`
- `web/src/chatHistoryApi.ts`: `fetchChatMessages(q)`, `streamChat(r)`, `chatImageSrc(id, variant)`, `interface ChatPageQuery`, `interface StreamChatRequest`
- `web/src/hooks/useHistory.ts`: `HISTORY_PAGE` (50), `interface HistoryOptions`, `interface HistoryStore`, `useHistory(enabled, options?)`
- `web/src/components/Bubble.tsx`: `THUMB_H`, `thumbWidth(a)`, `lightboxItemsOf(images)`, `interface BubbleProps`, `Bubble` (P10 wraps it, P11 edits its text rendering)
- `web/src/pages/HistoryPage.tsx` + `HistoryPage.css`: `interface HistoryPageProps`, `HistoryPage` (renders the timeline, the Lightbox and its own page-variant composer)
- `web/src/testing/chatFixtures.ts`: `makeMessage(id, over)` (the only creator of this file; P10 and P11 import it)
- `web/src/types.ts`: `ChatRole`, `ChatSource`, `ChatAttachmentKind`, `ChatAttachment`, `ChatReplyPreview`, `ChatMessage`, `ChatPage`, `ChatOp`, `ChatChange`
- CSS classes `.hist-composer`, `.chatbar.chatbar-page` (HistoryPage.css), `.answer-image` (ChatBar.css)
- `web/src/components/Rail.tsx`: `HISTORY_TIP`
- Tests: `lib/chatTime.test.tsx`, `lib/route.test.tsx`, `lib/events.test.tsx`, `lib/timeline.test.tsx`, `hooks/useHistory.test.tsx`, `pages/HistoryPage.test.tsx`, `components/Rail.test.tsx`, `App.history.test.tsx`

**Signature changes:**
- `type View = 'wall' | 'bin'` → `'wall' | 'bin' | 'history'`
- `BIN_TIP: Record<View, string>` gains `history: 'Recycle bin'`
- `RailProps` and `SidebarProps` gain the required `onToggleHistory: () => void`
- `HeaderProps` gains the optional `history?: boolean`
- `AnswerPanelProps` gains the optional `onFullScreen?: () => void`; Phase 3's sent thumbnails become `button.answer-image[aria-label="View image upload:<id>"]` that open the Lightbox
- `ChatState` (useChat) gains `threadId: string | null`
- `useNotes` subscribes through `subscribeEvents` instead of `new EventSource`. Its public `NotesStore` is unchanged.

**Requires (from earlier phases):** the `Lightbox` and `LightboxItem` exports (Phase 2); `useChatImages`, `ChatBar`'s image props and `variant`, `chatImageUrl`, `useChat`'s `images`/`ask(message, imageIds)` and `AnswerPanel`'s `images` (Phase 3); the `/api/chat/messages` page, `accepted`/`done`, and `event: chat` (Phase 7). Exact shapes in Assumptions.

**Contract for Phases 10 and 11 (final; code against these names, add no duplicates):**
- `useHistory(enabled: boolean, options: HistoryOptions = {}): HistoryStore`, owned by `App` (`const history = useHistory(view === 'history')`) and passed to `HistoryPage` as `store`.
  ```ts
  interface HistoryOptions { includeDeleted?: boolean }   // fetch with include_deleted=1, keep rows on op 'deleted'; P9 never sets it
  interface HistoryStore {
    items: TimelineItem[];                // server rows + local optimistic bubbles, ascending
    messages: ChatMessage[];              // server rows only, ascending
    loaded: boolean; error: string | null; hasMore: boolean; loadingOlder: boolean; sending: boolean;
    loadOlder: () => Promise<ChatMessage[]>;   // the prepended page; [] at the start; awaits an in-flight load
    refresh: () => void;
    mutate: (fn: (messages: ChatMessage[]) => ChatMessage[]) => void;  // optimistic change of server rows
    send: (text: string, imageIds: string[]) => boolean;               // P10 adds a trailing replyTo
  }
  ```
- `HistoryPage({ store, focusThread, now }: HistoryPageProps)` with `HistoryPageProps { store: HistoryStore; focusThread: string | null; now: Date }`. Structure: `<section className="history" aria-label="Chat history">` → optional `button.hist-older` → `<ol className="hist-list">` whose children are, per timeline item, `<Fragment key={it.key}>{divider && <ThreadDivider …/>}<Bubble item={it} now={now} focused={…} onOpenImages={…} /></Fragment>` → `<HistoryComposer store={store} />` (internal; `div.hist-composer` holding `<ChatBar variant="page" value onChange onSubmit images onPasteFiles onRemoveImage sendBlocked />` with its own `useState` draft and `useChatImages()`; submit calls `store.send(draft, images.readyIds)`) → the page's `<Lightbox>`. **The history composer is rendered by `HistoryPage`, not by App**; App renders no ChatBar while `view === 'history'`. App renders `<HistoryPage store={history} focusThread={historyThread} now={now} />` in the main-content conditional.
- `Bubble({ item, now, focused, onOpenImages }: BubbleProps)` with `BubbleProps { item: TimelineItem; now: Date; focused: boolean; onOpenImages: (items: LightboxItem[], index: number) => void }`. Its root is `<li className="bubble mine|theirs [error] [focus]" data-msg={msg.id || undefined} data-msg-key={item.key} data-thread=…>`, so a wrapper P10 adds must keep the `<ol>` valid (wrap in an `<li>` or render the bubble's content, not a `div` around an `li`). It renders `msg.text` like this (P11 replaces exactly this block with `<ChatInline>`):
  ```tsx
  const parts = msg.text ? msg.text.split('\n\n') : [];
  …
  {parts.map((t, i) => {
    const tail = streaming && i === parts.length - 1;
    return (
      <p key={i}>
        {segmentLinks(t, { streaming: tail }).map((s, j) =>
          s.kind === 'link' ? (
            <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
              {s.text}
            </a>
          ) : (
            <Fragment key={j}>{s.text}</Fragment>
          ),
        )}
        {tail ? ' ▍' : ''}
      </p>
    );
  })}
  ```
- `web/src/chatHistoryApi.ts`: `fetchChatMessages(q: ChatPageQuery = {}): Promise<ChatPage>` with `ChatPageQuery { before?: string | null; limit?: number; includeDeleted?: boolean }` (sends `include_deleted=1`); `streamChat(r: StreamChatRequest): Promise<Response>` with `StreamChatRequest { message: string; threadId?: string; imageIds?: string[]; signal: AbortSignal }` (P10 adds `replyTo?: string` → `reply_to`); `chatImageSrc(id, 'thumb' | 'display')`. P10's edit/delete/restore helpers belong in this module too, not in `api.ts`.
- `web/src/lib/chatTime.ts`: `CHAT_TZ`, `WallClock`, `jakartaParts`, `chatTime(iso, now)`, `chatTimeTitle(iso)`.
- `web/src/types.ts`: `ChatRole`, `ChatSource`, `ChatAttachmentKind`, `ChatAttachment {kind, id, url, thumb_url}`, `ChatReplyPreview {id, role: ChatRole | null, text, deleted}`, `ChatMessage`, `ChatPage {messages, next_before}`, `ChatOp`, `ChatChange`. No `ChatReplyRef`.
- `web/src/testing/chatFixtures.ts`: `makeMessage(id: string, over: Partial<ChatMessage> = {}): ChatMessage` (wall user message, thread `T1`, `2026-10-31T01:00:00.000Z`, no reply, no attachments).
- URL sync: App's single view→URL effect uses `hrefForView` (pathname guard); `/?note=ID` survives a switch to the wall or the bin. Phase 11 adds no URL-sync code.

**Leaves alone (owned by others):** the reply, edit, delete, restore and "show deleted" UI (Phase 10); note-id links in bubbles and `AnswerPanel`, and the show-on-wall modal button (Phase 11); all server code (Phases 3, 7, 8); `Lightbox.tsx` (Phase 2); `ChatBar.tsx` and `useChatImages.ts` (Phase 3; only used, plus `.chatbar-page` CSS here); `useBin.ts`, which keeps its own `EventSource` (see Handoffs).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/types.ts` | modify (`View` declaration; append at end, after P3/P4's types) | `View` gains `history`; chat wire types |
| `web/src/lib/chatTime.ts` | create | Jakarta (UTC+7) formatting |
| `web/src/lib/chatTime.test.tsx` | create | date-boundary tests |
| `web/src/lib/route.ts` | create | `/history[?thread=]` ↔ view |
| `web/src/lib/route.test.tsx` | create | route tests |
| `web/src/lib/events.ts` | create | one shared `/api/events` EventSource |
| `web/src/lib/events.test.tsx` | create | sharing, fan-out, close on last unsubscribe |
| `web/src/hooks/useNotes.ts` | modify (`:71-85`) | use `subscribeEvents` |
| `web/src/lib/timeline.ts` | create | merge, local bubbles, thread rule, count line |
| `web/src/lib/timeline.test.tsx` | create | pure tests |
| `web/src/chatHistoryApi.ts` | create | `GET /api/chat/messages`, streaming `POST /api/chat`, chat image URLs |
| `web/src/hooks/useHistory.ts` | create | paging, SSE refresh, optimistic send, thread rule |
| `web/src/hooks/useHistory.test.tsx` | create | fetch and EventSource mocks |
| `web/src/testing/chatFixtures.ts` | create | `makeMessage` |
| `web/src/components/Bubble.tsx` | create | one bubble |
| `web/src/pages/HistoryPage.tsx` | create | timeline page and its page-variant composer |
| `web/src/pages/HistoryPage.css` | create | history styles, `.chatbar-page` layout |
| `web/src/pages/HistoryPage.test.tsx` | create | rendering, badges, timestamps, thumbnails → Lightbox, composer |
| `web/src/hooks/useChat.ts` | modify (as Phase 3 rewrote it: `ChatState`, initial state, SSE handler, `close`) | expose our `threadId` |
| `web/src/hooks/useChat.test.tsx` | modify (append a test) | `threadId` from `accepted`/`done`, cleared on close |
| `web/src/components/Rail.tsx` | modify (whole file) | history icon above the trash |
| `web/src/components/Sidebar.tsx` | modify (whole file) | history icon above (before) the trash |
| `web/src/components/Rail.test.tsx` | create | order, pressed state, clicks (Rail and Sidebar) |
| `web/src/components/Header.tsx` | modify (whole file) | `history` prop: hint, no "Last edited" |
| `web/src/components/AnswerPanel.tsx` | modify (as Phase 3 rewrote it: imports, props, head buttons, `.answer-images` row) | "Chat in full screen" button; sent thumbnails open the Lightbox |
| `web/src/components/AnswerPanel.test.tsx` | modify (append) | the button, thumbnail → Lightbox |
| `web/src/components/ChatBar.css` | modify (append) | `.answer-image` button reset |
| `web/src/App.tsx` | modify (text anchors after Phases 3 and 5: imports, `view` state, after `toggleBin`, Esc effect, `<Rail>`/`<Sidebar>`/`<Header>`, main conditional, `<AnswerPanel>`, wall `<ChatBar>` guard) | view `history`, URL sync, full screen, wall bar hidden on the page |
| `web/src/App.history.test.tsx` | create | view switching, popstate, full screen, `/?note=` kept, page composer |
| `tests/unit/static.test.ts` | modify (append inside `describe`) | `/history` deep link served by the SPA fallback |
| `CHANGELOG.md` | modify | one line under `[Unreleased]` |
| `README.md` | modify (`## The chat bar`, before `## Connectors`) | "### The history page" |

## Implementation Steps

### Step 1: `View` and chat wire types
**File:** `web/src/types.ts` (the `View` declaration, today's last two lines; after Phase 3 (`ChatImage`) and Phase 4 (`NoteFile`, `Note.files?`) the file ends with their appended types. Keep theirs and add these at the very end.)
**Change:** replace the `View` declaration and append the chat types.
**Code:** replace
```ts
/** What the main area shows: the wall (text / images / all modes) or the recycle bin. */
export type View = 'wall' | 'bin';
```
with
```ts
/** What the main area shows: the wall (text / images / all modes), the recycle bin, or the chat history page (phase 9). */
export type View = 'wall' | 'bin' | 'history';
```
and append at the end of the file:
```ts
/** Phase 7 wire: who wrote a chat message. */
export type ChatRole = 'user' | 'assistant';

/** Phase 7 wire: where an exchange happened. `claude_code` = captured `/n` exchange (phase 8). */
export type ChatSource = 'wall' | 'claude_code';

/** Phase 7 wire: what a message attachment points at. */
export type ChatAttachmentKind = 'chat_image' | 'note_image' | 'note_file';

/**
 * Phase 7 wire (`src/chat/types.ts` `ChatAttachmentView`): one attachment of a chat message.
 * `url` is the large form (lightbox / download); `thumb_url` is null for files. No dimensions.
 */
export interface ChatAttachment {
  kind: ChatAttachmentKind;
  id: string;
  url: string;
  thumb_url: string | null;
}

/**
 * Phase 7 wire (`ChatReplyPreview`): the quoted header of a reply (rendered by phase 10). A
 * deleted or vanished target has `deleted: true`, empty `text` and possibly `role: null`.
 */
export interface ChatReplyPreview {
  id: string;
  role: ChatRole | null;
  text: string;
  deleted: boolean;
}

/** Phase 7 wire: one persisted chat message (`GET /api/chat/messages`). Times are UTC ISO. */
export interface ChatMessage {
  /** 4-char `[0-9A-Z]` id, shown to the model as `[msg:ID]`. */
  id: string;
  thread_id: string;
  role: ChatRole;
  text: string;
  source: ChatSource;
  /** 'claude' | 'glm' for wall answers; null otherwise. */
  brain: string | null;
  reply_to: ChatReplyPreview | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: ChatAttachment[];
}

/** Phase 7 wire (`ChatTimelinePage`): one page, ascending. `next_before` is the cursor for older messages; null when there are none. */
export interface ChatPage {
  messages: ChatMessage[];
  next_before: string | null;
}

/** Phase 7 wire: `op` of `event: chat` on `/api/events` (`src/chat/events.ts` `ChatOp`). Past tense. */
export type ChatOp = 'created' | 'updated' | 'deleted' | 'restored';

/** Phase 7 wire: data of `event: chat` on `/api/events`. */
export interface ChatChange {
  op: ChatOp;
  thread_id: string;
  id: string;
}
```
**Impact:** `BIN_TIP: Record<View, string>` in `Rail.tsx` stops compiling until Step 11 adds `history`. Steps 1 and 11 must land in the same commit. `lib/reveal.ts` keeps compiling, because `planReveal` always returns `'wall'`, which also takes the page out of `history` on a jump or deep link, as intended.

### Step 2: Jakarta time formatting
**File:** `web/src/lib/chatTime.ts` (new)
**Code:**
```ts
/**
 * Chat timestamps (R3, invariant 7): stored UTC, shown in Asia/Jakarta (UTC+7, no DST). Pure, so
 * the date-boundary cases are unit-tested: 17:30 UTC is 00:30 the NEXT day in Jakarta.
 */
export const CHAT_TZ = 'Asia/Jakarta';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: CHAT_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

/** A wall-clock reading in Jakarta. `month` is 1-12. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function msOf(t: number | string | Date): number {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/** Jakarta wall clock of an instant; null for an unparseable input. */
export function jakartaParts(t: number | string | Date): WallClock | null {
  const ms = msOf(t);
  if (!Number.isFinite(ms)) return null;
  const p: Record<string, number> = {};
  for (const part of PARTS.formatToParts(ms)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    year: p.year ?? 0,
    month: p.month ?? 0,
    day: p.day ?? 0,
    // Some ICU builds still print midnight as 24 with h23; normalise.
    hour: (p.hour ?? 0) % 24,
    minute: p.minute ?? 0,
    second: p.second ?? 0,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The bubble's timestamp: `HH:mm` on the same Jakarta day as `now`; `D Mon HH:mm` on another day
 * of the same year; `D Mon YYYY HH:mm` in another year. '' for an unparseable time.
 */
export function chatTime(iso: string, now: number | Date = Date.now()): string {
  const t = jakartaParts(iso);
  const n = jakartaParts(now);
  if (!t || !n) return '';
  const hm = `${pad(t.hour)}:${pad(t.minute)}`;
  if (t.year === n.year && t.month === n.month && t.day === n.day) return hm;
  const date = `${t.day} ${MONTHS[t.month - 1] ?? '?'}`;
  return t.year === n.year ? `${date} ${hm}` : `${date} ${t.year} ${hm}`;
}

/** The bubble timestamp's tooltip: full ISO wall time with the offset, e.g. `2026-10-31T00:30:00+07:00 (UTC+7)`. */
export function chatTimeTitle(iso: string): string {
  const t = jakartaParts(iso);
  if (!t) return iso;
  return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}+07:00 (UTC+7)`;
}
```
**Impact:** none (new).

### Step 3: chatTime tests
**File:** `web/src/lib/chatTime.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { chatTime, chatTimeTitle, jakartaParts } from './chatTime';

// 2026-10-31 08:00 in Jakarta.
const NOW = Date.parse('2026-10-31T01:00:00Z');

describe('chatTime (Asia/Jakarta, UTC+7)', () => {
  it('17:30 UTC is 00:30 the next day in Jakarta, so it reads as today', () => {
    expect(chatTime('2026-10-30T17:30:00Z', NOW)).toBe('00:30');
  });

  it('the same instant seen late on the 30th (Jakarta) is tomorrow, so it shows the date', () => {
    const late30th = Date.parse('2026-10-30T16:00:00Z'); // 23:00 WIB on 30 Oct
    expect(chatTime('2026-10-30T17:30:00Z', late30th)).toBe('31 Oct 00:30');
  });

  it('16:59 UTC is still the previous Jakarta day', () => {
    expect(chatTime('2026-10-30T16:59:00Z', NOW)).toBe('30 Oct 23:59');
  });

  it('midnight prints as 00, never 24', () => {
    expect(chatTime('2026-10-30T17:00:00Z', NOW)).toBe('00:00');
  });

  it('a new year in Jakarta starts at 17:00 UTC on 31 Dec', () => {
    expect(chatTime('2025-12-31T17:00:00Z', NOW)).toBe('1 Jan 00:00');
    expect(chatTime('2025-12-31T16:59:00Z', NOW)).toBe('31 Dec 2025 23:59');
  });

  it('accepts a Date for now and returns empty for garbage', () => {
    expect(chatTime('2026-10-31T00:05:00Z', new Date(NOW))).toBe('07:05');
    expect(chatTime('not a time', NOW)).toBe('');
  });

  it('the tooltip is the full Jakarta wall time with its offset', () => {
    expect(chatTimeTitle('2026-10-30T17:30:00.000Z')).toBe('2026-10-31T00:30:00+07:00 (UTC+7)');
    expect(chatTimeTitle('nope')).toBe('nope');
  });

  it('jakartaParts reads the wall clock', () => {
    expect(jakartaParts('2026-10-30T17:30:45Z')).toEqual({ year: 2026, month: 10, day: 31, hour: 0, minute: 30, second: 45 });
  });
});
```

### Step 4: URL ↔ view
**File:** `web/src/lib/route.ts` (new)
**Code:**
```ts
import type { View } from '../types';

/**
 * The history page's URL (phase 9): `/history`, or `/history?thread=<id>` to open it on one thread.
 * The wall and the bin have no path of their own: they live at `/` (and `/?note=<id>` deep links,
 * lib/deepLink.ts), so leaving the history page pushes `/` and nothing else is touched.
 */
export const HISTORY_PATH = '/history';

export interface Route {
  history: boolean;
  thread: string | null;
}

/** What the URL asks for. A trailing slash is tolerated; an empty `thread` is no thread. */
export function routeFromLocation(loc: Pick<Location, 'pathname' | 'search'>): Route {
  const path = loc.pathname.length > 1 ? loc.pathname.replace(/\/+$/, '') : loc.pathname;
  if (path !== HISTORY_PATH) return { history: false, thread: null };
  const t = new URLSearchParams(loc.search).get('thread');
  const thread = t !== null && t.trim() !== '' ? t.trim() : null;
  return { history: true, thread };
}

export function historyHref(thread: string | null): string {
  return thread ? `${HISTORY_PATH}?thread=${encodeURIComponent(thread)}` : HISTORY_PATH;
}

/**
 * The URL to push so the address bar matches `view`, or null when it already does. Wall and bin
 * accept any non-history URL as it is (a `/?note=` link stays put); only leaving `/history` pushes `/`.
 */
export function hrefForView(view: View, thread: string | null, loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const r = routeFromLocation(loc);
  if (view === 'history') return r.history && r.thread === thread ? null : historyHref(thread);
  return r.history ? '/' : null;
}
```

### Step 5: route tests
**File:** `web/src/lib/route.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { historyHref, hrefForView, routeFromLocation } from './route';

const loc = (url: string) => {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname, search: u.search };
};

describe('route', () => {
  it('reads /history with and without a thread', () => {
    expect(routeFromLocation(loc('/history'))).toEqual({ history: true, thread: null });
    expect(routeFromLocation(loc('/history/'))).toEqual({ history: true, thread: null });
    expect(routeFromLocation(loc('/history?thread=T-1'))).toEqual({ history: true, thread: 'T-1' });
    expect(routeFromLocation(loc('/history?thread=%20'))).toEqual({ history: true, thread: null });
  });

  it('anything else is not the history page', () => {
    expect(routeFromLocation(loc('/'))).toEqual({ history: false, thread: null });
    expect(routeFromLocation(loc('/?note=A-B32'))).toEqual({ history: false, thread: null });
    expect(routeFromLocation(loc('/historyx'))).toEqual({ history: false, thread: null });
  });

  it('builds the history href, encoding the thread', () => {
    expect(historyHref(null)).toBe('/history');
    expect(historyHref('a b')).toBe('/history?thread=a%20b');
  });

  it('pushes only when the URL disagrees with the view', () => {
    expect(hrefForView('history', null, loc('/'))).toBe('/history');
    expect(hrefForView('history', 'T-1', loc('/history'))).toBe('/history?thread=T-1');
    expect(hrefForView('history', 'T-1', loc('/history?thread=T-1'))).toBeNull();
    expect(hrefForView('wall', null, loc('/history?thread=T-1'))).toBe('/');
    expect(hrefForView('bin', null, loc('/history'))).toBe('/');
    expect(hrefForView('wall', 'T-1', loc('/?note=A-B32'))).toBeNull();
    expect(hrefForView('bin', null, loc('/'))).toBeNull();
  });

  it('never rewrites a wall deep link: /?note=ID survives a switch to the wall (phase 11 relies on this)', () => {
    expect(hrefForView('wall', null, loc('/?note=A-B32'))).toBeNull();
    expect(hrefForView('bin', null, loc('/?note=A-B32'))).toBeNull();
  });
});
```

### Step 6: one shared `/api/events` connection
**File:** `web/src/lib/events.ts` (new)
**Code:**
```ts
/**
 * One EventSource on /api/events for the whole page (phase 9). The wall store (`note` events) and
 * the history page (`chat` events) subscribe here instead of each opening a connection. The source
 * opens on the first subscriber and closes when the last one leaves; a test that stubs
 * `EventSource` and unmounts gets a fresh source next time. Without `EventSource` (jsdom) it is a no-op.
 *
 * Handlers get the raw Event; a `MessageEvent` carries `data`. Fakes in tests may call with nothing.
 */
export const EVENTS_URL = '/api/events';

type Listener = (e: Event | undefined) => void;

let source: EventSource | null = null;
const listeners = new Map<string, Set<Listener>>();
const bound = new Set<string>();

function subscriberCount(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}

export function subscribeEvents(type: string, fn: (e: Event | undefined) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  if (source === null) source = new EventSource(EVENTS_URL);
  // A fresh wrapper per subscription: the same function subscribed twice counts twice.
  const entry: Listener = (e) => fn(e);
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(entry);
  if (!bound.has(type)) {
    bound.add(type);
    source.addEventListener(type, (e?: Event) => {
      for (const l of Array.from(listeners.get(type) ?? [])) l(e);
    });
  }
  let off = false;
  return () => {
    if (off) return;
    off = true;
    listeners.get(type)?.delete(entry);
    if (subscriberCount() === 0) {
      source?.close();
      source = null;
      listeners.clear();
      bound.clear();
    }
  };
}
```
**Impact:** none until Step 7 switches `useNotes` to it.

### Step 7: `useNotes` uses the shared connection
**File:** `web/src/hooks/useNotes.ts:1-3` (imports) and `:71-85` (the EventSource block and cleanup)
**Change:** replace the local `EventSource` with two subscriptions. The behavior is identical: `note` and `open` both schedule a refetch.
**Code:** the whole file after the change:
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNotes, fetchTags } from '../api';
import { subscribeEvents } from '../lib/events';
import type { Note, TagCount } from '../types';

export interface NotesStore {
  notes: Note[];
  tags: TagCount[];
  loaded: boolean;
  error: string | null;
  /** Debounced (250 ms) refetch of notes + tags. */
  refetch: () => void;
  /** Replace a note in place, or insert it (at the top when `atTop`). */
  upsertLocal: (note: Note, atTop?: boolean) => void;
  removeLocal: (id: string) => void;
}

interface State {
  notes: Note[];
  tags: TagCount[];
  loaded: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 250;
const POLL_MS = 60_000;

export function useNotes(): NotesStore {
  const [state, setState] = useState<State>({ notes: [], tags: [], loaded: false, error: null });
  // Bumped on every local mutation; a fetch that started before a mutation is discarded and retried.
  const gen = useRef(0);
  const refetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let again = false;
    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), DEBOUNCE_MS);
    };

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      const g = gen.current;
      try {
        const [notes, tags] = await Promise.all([fetchNotes(), fetchTags()]);
        if (!alive) return;
        if (gen.current === g) setState({ notes, tags, loaded: true, error: null });
        else again = true;
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        inFlight = false;
        if (alive && again) {
          again = false;
          schedule();
        }
      }
    };

    refetchRef.current = schedule;
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);

    // The page's one /api/events connection (lib/events.ts), shared with the history page.
    const offNote = subscribeEvents('note', schedule);
    // After a daemon restart the browser reconnects; refetch what was missed.
    const offOpen = subscribeEvents('open', schedule);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      offNote();
      offOpen();
      refetchRef.current = () => {};
    };
  }, []);

  const refetch = useCallback(() => refetchRef.current(), []);

  const upsertLocal = useCallback((note: Note, atTop = false) => {
    gen.current += 1;
    setState((s) => {
      const i = s.notes.findIndex((n) => n.id === note.id);
      if (i >= 0) {
        const notes = s.notes.slice();
        notes[i] = note;
        return { ...s, notes };
      }
      return { ...s, notes: atTop ? [note, ...s.notes] : [...s.notes, note] };
    });
  }, []);

  const removeLocal = useCallback((id: string) => {
    gen.current += 1;
    setState((s) => ({ ...s, notes: s.notes.filter((n) => n.id !== id) }));
  }, []);

  return { ...state, refetch, upsertLocal, removeLocal };
}
```
**Impact:** `App.deeplink.test.tsx` ("a background refetch (SSE note event)…") still passes. Its `FakeES.last` is the shared source, and `emit('note')` reaches `schedule` through the fan-out listener.

### Step 8: events tests
**File:** `web/src/lib/events.test.tsx` (new)
**Code:**
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENTS_URL, subscribeEvents } from './events';

class FakeES {
  static all: FakeES[] = [];
  closed = false;
  private l = new Map<string, Array<(e?: unknown) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data });
  }
}

afterEach(() => {
  FakeES.all = [];
  vi.unstubAllGlobals();
});

describe('subscribeEvents', () => {
  it('shares one connection between subscribers and fans each event out', () => {
    vi.stubGlobal('EventSource', FakeES);
    const notes = vi.fn();
    const chats = vi.fn();
    const offA = subscribeEvents('note', notes);
    const offB = subscribeEvents('chat', chats);
    expect(FakeES.all).toHaveLength(1);
    expect(FakeES.all[0]?.url).toBe(EVENTS_URL);
    FakeES.all[0]?.emit('chat', '{"op":"created"}');
    expect(chats).toHaveBeenCalledWith({ data: '{"op":"created"}' });
    expect(notes).not.toHaveBeenCalled();
    offA();
    offB();
  });

  it('closes on the last unsubscribe and opens a fresh source next time', () => {
    vi.stubGlobal('EventSource', FakeES);
    const offA = subscribeEvents('note', vi.fn());
    const offB = subscribeEvents('note', vi.fn());
    offA();
    offA(); // idempotent
    expect(FakeES.all[0]?.closed).toBe(false);
    offB();
    expect(FakeES.all[0]?.closed).toBe(true);
    const fn = vi.fn();
    const offC = subscribeEvents('note', fn);
    expect(FakeES.all).toHaveLength(2);
    FakeES.all[1]?.emit('note');
    expect(fn).toHaveBeenCalledTimes(1);
    offC();
  });

  it('is a no-op without EventSource', () => {
    vi.stubGlobal('EventSource', undefined);
    const off = subscribeEvents('note', vi.fn());
    expect(() => off()).not.toThrow();
  });
});
```

### Step 9: Timeline logic (pure)
**File:** `web/src/lib/timeline.ts` (new)
**Code:**
```ts
import type { ChatAttachment, ChatMessage } from '../types';

export const HISTORY_HEADING = 'History.';
export const HISTORY_HINT = 'Every wall chat and /n exchange, oldest at the top. Times are Jakarta time (UTC+7).';

/**
 * A message the history page shows before (or instead of) its server row: the user's question
 * right after send, the assistant reply while it streams, or an error bubble. `serverId` is set
 * from `accepted` / `done`; once the server list holds that id the local bubble is hidden and pruned.
 */
export interface LocalBubble {
  key: string;
  role: 'user' | 'assistant';
  serverId: string | null;
  threadId: string | null;
  text: string;
  createdAt: string;
  attachments: ChatAttachment[];
  streaming: boolean;
  /** Tool caption while streaming; '' for none. */
  status: string;
  brain: string | null;
  /** Shown instead of (or after) the text: 'Chat failed: …' on the reply, 'not sent' on a question that never reached the server. */
  error: string | null;
}

/** One row of the page. `local` is null for a server message. */
export interface TimelineItem {
  key: string;
  msg: ChatMessage;
  local: LocalBubble | null;
}

/** ms since epoch; an unparseable time sorts first. */
export function timeOf(m: Pick<ChatMessage, 'created_at'>): number {
  const t = Date.parse(m.created_at);
  return Number.isFinite(t) ? t : 0;
}

const roleRank = (m: ChatMessage): number => (m.role === 'user' ? 0 : 1);

/** Ascending time; same instant: question before answer, then id. */
export function sortMessages(ms: ChatMessage[]): ChatMessage[] {
  return ms.slice().sort((a, b) => timeOf(a) - timeOf(b) || roleRank(a) - roleRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Oldest `created_at` in a page, as ms; +Infinity for an empty page. */
export function oldestMs(ms: ChatMessage[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const m of ms) min = Math.min(min, timeOf(m));
  return min;
}

/**
 * Merge a fetched page into what is loaded, by id (the fetched copy wins). `authoritativeFrom`
 * (ms) says the page is the complete truth for everything newer than that instant: loaded messages
 * newer than it that the page lacks were deleted and are dropped. `-Infinity` = the page is the
 * whole history; null = an older page, nothing is dropped.
 */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[], authoritativeFrom: number | null): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) {
    if (authoritativeFrom !== null && timeOf(m) > authoritativeFrom) continue;
    byId.set(m.id, m);
  }
  for (const m of incoming) byId.set(m.id, m);
  return sortMessages([...byId.values()]);
}

/** A local bubble as a wire message, so one component renders both. */
export function localToMessage(l: LocalBubble): ChatMessage {
  return {
    id: l.serverId ?? '',
    thread_id: l.threadId ?? '',
    role: l.role,
    text: l.text,
    source: 'wall',
    brain: l.brain,
    reply_to: null,
    created_at: l.createdAt,
    edited_at: null,
    deleted_at: null,
    attachments: l.attachments,
  };
}

/** Server messages in order, then the local bubbles the server does not hold yet. */
export function timelineOf(server: ChatMessage[], local: LocalBubble[]): TimelineItem[] {
  const ids = new Set(server.map((m) => m.id));
  const items: TimelineItem[] = server.map((m) => ({ key: m.id, msg: m, local: null }));
  for (const l of local) {
    if (l.serverId !== null && ids.has(l.serverId)) continue;
    items.push({ key: l.key, msg: localToMessage(l), local: l });
  }
  return items;
}

/** Drop local bubbles whose server row has arrived (never one still streaming). */
export function pruneLocal(local: LocalBubble[], server: ChatMessage[]): LocalBubble[] {
  const ids = new Set(server.map((m) => m.id));
  const kept = local.filter((l) => l.streaming || l.serverId === null || !ids.has(l.serverId));
  return kept.length === local.length ? local : kept;
}

/**
 * Decision "which thread a history-page message joins": the newest live message of the timeline
 * decides. A wall message → continue its thread; a claude_code message (or nothing) → new thread.
 * Error-only local bubbles and deleted messages do not count.
 */
export function threadForSend(items: TimelineItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (it.local?.error) continue;
    if (it.msg.deleted_at) continue;
    return it.msg.source === 'wall' && it.msg.thread_id ? it.msg.thread_id : undefined;
  }
  return undefined;
}

/** Header count line on the history page. */
export function historyCountLine(items: TimelineItem[], hasMore: boolean): string {
  const shown = items.filter((i) => !i.local?.error);
  const threads = new Set(shown.map((i) => i.msg.thread_id).filter((t) => t !== '')).size;
  const lead = hasMore ? `Latest ${shown.length} messages` : `${shown.length} messages`;
  return `${lead} in ${threads} threads.`;
}
```

### Step 10: Test fixtures and timeline tests
**File:** `web/src/testing/chatFixtures.ts` (new)
**Code:**
```ts
import type { ChatMessage } from '../types';

/** A wire `ChatMessage`: a wall user message in thread T1 at 2026-10-31 01:00 UTC unless overridden. */
export function makeMessage(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    thread_id: 'T1',
    role: 'user',
    text: `message ${id}`,
    source: 'wall',
    brain: null,
    reply_to: null,
    created_at: '2026-10-31T01:00:00.000Z',
    edited_at: null,
    deleted_at: null,
    attachments: [],
    ...over,
  };
}
```
**File:** `web/src/lib/timeline.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { makeMessage } from '../testing/chatFixtures';
import { historyCountLine, mergeMessages, pruneLocal, sortMessages, threadForSend, timelineOf, type LocalBubble } from './timeline';

const at = (min: number) => new Date(Date.UTC(2026, 9, 31, 1, min)).toISOString();

const local = (over: Partial<LocalBubble>): LocalBubble => ({
  key: 'local-1-u',
  role: 'user',
  serverId: null,
  threadId: null,
  text: 'hi',
  createdAt: at(30),
  attachments: [],
  streaming: false,
  status: '',
  brain: null,
  error: null,
  ...over,
});

describe('timeline', () => {
  it('sorts ascending, question before answer at the same instant', () => {
    const a = makeMessage('AAA1', { role: 'assistant', created_at: at(1) });
    const u = makeMessage('ZZZ1', { role: 'user', created_at: at(1) });
    const old = makeMessage('BBB1', { created_at: at(0) });
    expect(sortMessages([a, u, old]).map((m) => m.id)).toEqual(['BBB1', 'ZZZ1', 'AAA1']);
  });

  it('a latest page replaces its window: missing newer rows were deleted, older rows stay', () => {
    const old = makeMessage('OLD1', { created_at: at(0) });
    const gone = makeMessage('GONE', { created_at: at(5) });
    const kept = makeMessage('KEPT', { created_at: at(4), text: 'v1' });
    const fresh = { ...kept, text: 'v2' };
    const merged = mergeMessages([old, kept, gone], [fresh], Date.parse(at(4)));
    expect(merged.map((m) => [m.id, m.text])).toEqual([
      ['OLD1', 'message OLD1'],
      ['KEPT', 'v2'],
    ]);
  });

  it('an older page only adds; -Infinity means the page is everything', () => {
    const a = makeMessage('A001', { created_at: at(3) });
    const b = makeMessage('B001', { created_at: at(1) });
    expect(mergeMessages([a], [b], null).map((m) => m.id)).toEqual(['B001', 'A001']);
    expect(mergeMessages([a], [], Number.NEGATIVE_INFINITY)).toEqual([]);
  });

  it('hides a local bubble once the server holds its id, and prunes it', () => {
    const server = [makeMessage('U001')];
    const l = local({ serverId: 'U001' });
    const pending = local({ key: 'local-1-a', role: 'assistant', streaming: true });
    expect(timelineOf(server, [l, pending]).map((i) => i.key)).toEqual(['U001', 'local-1-a']);
    expect(pruneLocal([l, pending], server)).toEqual([pending]);
  });

  it('thread rule: the newest wall message continues its thread, claude code starts a new one', () => {
    const wall = makeMessage('W001', { thread_id: 'T1', created_at: at(1) });
    const cc = makeMessage('C001', { thread_id: 'T9', source: 'claude_code', created_at: at(2) });
    expect(threadForSend(timelineOf([wall], []))).toBe('T1');
    expect(threadForSend(timelineOf([wall, cc], []))).toBeUndefined();
    expect(threadForSend([])).toBeUndefined();
  });

  it('thread rule skips error bubbles and deleted messages', () => {
    const wall = makeMessage('W001', { thread_id: 'T1', created_at: at(1) });
    const del = makeMessage('C001', { source: 'claude_code', deleted_at: at(3), created_at: at(2) });
    const err = local({ key: 'local-2-a', role: 'assistant', error: 'Chat failed: boom' });
    expect(threadForSend(timelineOf([wall, del], [err]))).toBe('T1');
  });

  it('count line', () => {
    const items = timelineOf([makeMessage('A001'), makeMessage('B001', { thread_id: 'T2' })], []);
    expect(historyCountLine(items, false)).toBe('2 messages in 2 threads.');
    expect(historyCountLine(items, true)).toBe('Latest 2 messages in 2 threads.');
  });
});
```

### Step 11: Rail: history icon above the recycle bin
**File:** `web/src/components/Rail.tsx` (whole file; Phases 1, 2, 3 and 5 do not edit it)
**Code:**
```tsx
import { ChatsCircle, Images, NotePencil, SidebarSimple, SquaresFour, TextAa, Trash, XCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Mode, View } from '../types';
import { MODE_TIP } from '../lib/filter';

export const MODE_ICON: Record<Mode, Icon> = { text: TextAa, images: Images, all: SquaresFour };

/** Tooltip / label of the Trash toggle, by the view it is pressed from. */
export const BIN_TIP: Record<View, string> = { wall: 'Recycle bin', bin: 'Back to the wall', history: 'Recycle bin' };

/** Tooltip / label of the chat-history toggle (phase 9). Pressed state says when it is open; a second press returns to the wall. */
export const HISTORY_TIP = 'Chat history';

export interface RailProps {
  mode: Mode;
  view: View;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleHistory: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, view, active, onToggleSide, onAdd, onCycleMode, onToggleHistory, onToggleBin, onToggleTag, onClear }: RailProps) {
  const ModeIcon = MODE_ICON[mode];
  return (
    <nav className="rail">
      <button type="button" className="ibtn hov" data-tip="Toggle sidebar" data-tip-side="right" aria-label="Toggle sidebar" onClick={onToggleSide}>
        <SidebarSimple weight="duotone" />
      </button>
      <button type="button" className="ibtn hov" data-tip="New note" data-tip-side="right" aria-label="New note" onClick={onAdd}>
        <NotePencil weight="duotone" />
      </button>
      <button
        type="button"
        className={mode === 'text' ? 'ibtn' : 'ibtn on'}
        data-tip={`${MODE_TIP[mode]} (click to switch)`}
        data-tip-side="right"
        aria-label={`${MODE_TIP[mode]} (click to switch)`}
        onClick={onCycleMode}
      >
        <ModeIcon weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'history' ? 'ibtn on' : 'ibtn hov'}
        data-tip={HISTORY_TIP}
        data-tip-side="right"
        aria-label={HISTORY_TIP}
        aria-pressed={view === 'history'}
        onClick={onToggleHistory}
      >
        <ChatsCircle weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'bin' ? 'ibtn on' : 'ibtn hov'}
        data-tip={BIN_TIP[view]}
        data-tip-side="right"
        aria-label={BIN_TIP[view]}
        aria-pressed={view === 'bin'}
        onClick={onToggleBin}
      >
        <Trash weight="duotone" />
      </button>
      <div className="rail-sep" />
      {active.map((t) => (
        <button key={t} type="button" className="rail-chip" data-tip="Remove filter" data-tip-side="right" onClick={() => onToggleTag(t)}>
          #{t}
        </button>
      ))}
      {active.length > 0 && (
        <button type="button" className="ibtn hov clear" data-tip="Clear filters" data-tip-side="right" aria-label="Clear filters" onClick={onClear}>
          <XCircle weight="duotone" />
        </button>
      )}
    </nav>
  );
}
```
The rail is vertical, so "above the recycle bin" means immediately before the Trash button in DOM order.

### Step 12: Sidebar: history icon before the recycle bin
**File:** `web/src/components/Sidebar.tsx` (whole file)
**Code:**
```tsx
import { ChatsCircle, Trash } from '@phosphor-icons/react';
import type { Mode, TagCount, View } from '../types';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { BIN_TIP, HISTORY_TIP, MODE_ICON } from './Rail';

export interface SidebarProps {
  mode: Mode;
  view: View;
  photoCount: number;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleHistory: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
}

export function Sidebar({ mode, view, photoCount, tags, active, onMode, onToggleHistory, onToggleBin, onToggleTag }: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return (
    <aside className="side">
      <div className="side-modes">
        {MODE_ORDER.map((m) => {
          const I = MODE_ICON[m];
          return (
            <button
              key={m}
              type="button"
              className={view === 'wall' && m === mode ? 'ibtn on' : 'ibtn'}
              data-tip={MODE_TIP[m]}
              aria-label={MODE_TIP[m]}
              onClick={() => onMode(m)}
            >
              <I weight="duotone" />
            </button>
          );
        })}
        <button
          type="button"
          className={view === 'history' ? 'ibtn on' : 'ibtn'}
          data-tip={HISTORY_TIP}
          aria-label={HISTORY_TIP}
          aria-pressed={view === 'history'}
          onClick={onToggleHistory}
        >
          <ChatsCircle weight="duotone" />
        </button>
        <button
          type="button"
          className={view === 'bin' ? 'ibtn on' : 'ibtn'}
          data-tip={BIN_TIP[view]}
          aria-label={BIN_TIP[view]}
          aria-pressed={view === 'bin'}
          onClick={onToggleBin}
        >
          <Trash weight="duotone" />
        </button>
        <span className="side-count">{photoCount} photos</span>
      </div>
      <div className="side-sep" />
      <div className="side-tags">
        {sorted.map((t) => (
          <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
            <span>#{t.tag}</span>
            <span className="n">{t.count}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
```
The sidebar's icon row is horizontal, so the history icon goes directly before the trash, in the same order as the rail.

### Step 13: Rail and Sidebar tests
**File:** `web/src/components/Rail.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { View } from '../types';
import { Rail } from './Rail';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

const rail = (view: View, onToggleHistory = vi.fn()) =>
  render(
    <Rail
      mode="text"
      view={view}
      active={[]}
      onToggleSide={vi.fn()}
      onAdd={vi.fn()}
      onCycleMode={vi.fn()}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      onClear={vi.fn()}
    />,
  );

const side = (view: View, onToggleHistory = vi.fn()) =>
  render(
    <Sidebar
      mode="text"
      view={view}
      photoCount={0}
      tags={[]}
      active={[]}
      onMode={vi.fn()}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
    />,
  );

/** Labels of the icon buttons in DOM order. */
const order = (root: Element) => Array.from(root.querySelectorAll('button.ibtn')).map((b) => b.getAttribute('aria-label'));

describe('chat-history icon', () => {
  it('sits directly above the recycle bin in the rail', () => {
    const { container } = rail('wall');
    const labels = order(container.querySelector('.rail') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Recycle bin') - 1);
  });

  it('sits directly before the recycle bin in the sidebar', () => {
    const { container } = side('wall');
    const labels = order(container.querySelector('.side-modes') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Recycle bin') - 1);
  });

  it('is pressed on the history page and calls the toggle', () => {
    const toggle = vi.fn();
    rail('history', toggle);
    const btn = screen.getByRole('button', { name: 'Chat history' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toBe('ibtn on');
    expect(btn.getAttribute('data-tip')).toBe('Chat history');
    expect(screen.getByRole('button', { name: 'Recycle bin' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('is not pressed on the wall; the sidebar mirrors the rail', () => {
    const toggle = vi.fn();
    side('history', toggle);
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    cleanup();
    rail('wall');
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('false');
  });
});
```

### Step 14: Header knows the history page
**File:** `web/src/components/Header.tsx` (whole file)
**Code:**
```tsx
import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';
import { HISTORY_HINT } from '../lib/timeline';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  /** The recycle bin is showing: no "Last edited" link, and the hint explains the bin. */
  bin?: boolean;
  /** The chat history page is showing (phase 9): no "Last edited" link, and the hint explains the page. */
  history?: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

const WALL_HINT = 'Drop or paste an image anywhere to make a photo note.';
const BIN_HINT = 'Restore brings a note or an image back. Delete forever removes it and its files.';

export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, history = false, onJumpLast, onAdd }: HeaderProps) {
  const hint = bin ? BIN_HINT : history ? HISTORY_HINT : WALL_HINT;
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {!bin && !history && last && (
          <>
            {' '}Last edited{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onJumpLast();
              }}
            >
              {last.id}
            </a>{' '}
            {lastWhen}.
          </>
        )}{' '}
        {hint}
      </p>
      <h1>{heading}</h1>
      {showSticker && (
        <button type="button" className="sticker" data-tip="New note" aria-label="New note" onClick={onAdd}>
          <Plus weight="duotone" />
        </button>
      )}
    </header>
  );
}
```
**Impact:** the strings are byte-identical for the wall and the bin, so existing tests that match them still pass.

### Step 15: History API client
**File:** `web/src/chatHistoryApi.ts` (new; a separate module so it never collides with Phase 3's or Phase 10's appends to `api.ts`)
**Code:**
```ts
import { ApiError } from './api';
import type { ChatAttachment, ChatMessage, ChatPage } from './types';

const enc = encodeURIComponent;

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') msg = (j as { error: string }).error;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg);
}

export interface ChatPageQuery {
  /** Opaque cursor from a previous page's `next_before`; absent = the latest page. */
  before?: string | null;
  limit?: number;
  /** Phase 10's "show deleted" toggle. */
  includeDeleted?: boolean;
}

function normalize(m: ChatMessage): ChatMessage {
  return {
    ...m,
    text: typeof m.text === 'string' ? m.text : '',
    brain: m.brain ?? null,
    reply_to: m.reply_to ?? null,
    edited_at: m.edited_at ?? null,
    deleted_at: m.deleted_at ?? null,
    attachments: Array.isArray(m.attachments) ? (m.attachments as ChatAttachment[]) : [],
  };
}

/** Phase 7: `GET /api/chat/messages?before&limit&include_deleted=1` → one page of the unified timeline (ascending; the hook re-sorts anyway). */
export async function fetchChatMessages(q: ChatPageQuery = {}): Promise<ChatPage> {
  const p = new URLSearchParams();
  if (q.before) p.set('before', q.before);
  if (q.limit) p.set('limit', String(q.limit));
  if (q.includeDeleted) p.set('include_deleted', '1');
  const qs = p.toString();
  const res = await fetch(`/api/chat/messages${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { messages?: unknown; next_before?: unknown };
  const messages = Array.isArray(j.messages) ? (j.messages as ChatMessage[]).map(normalize) : [];
  const next = typeof j.next_before === 'string' && j.next_before !== '' ? j.next_before : null;
  return { messages, next_before: next };
}

/** Phase 10 adds `replyTo?: string` (sent as `reply_to`); phase 9 never sets it. */
export interface StreamChatRequest {
  message: string;
  /** Our thread id (phase 7, a UUID); absent (or unknown to the server) = a new thread. */
  threadId?: string;
  /** Phase 3 chat image ids, already uploaded. */
  imageIds?: string[];
  signal: AbortSignal;
}

/** `POST /api/chat` for the history composer; the caller reads the SSE body (lib/sse `readSSE`). */
export function streamChat(r: StreamChatRequest): Promise<Response> {
  const payload: { message: string; thread_id?: string; image_ids?: string[] } = { message: r.message };
  if (r.threadId) payload.thread_id = r.threadId;
  if (r.imageIds && r.imageIds.length > 0) payload.image_ids = r.imageIds;
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: r.signal,
  });
}

export type ChatImageVariant = 'thumb' | 'display';

/** Phase 3: `/api/chat/images/<id>/<variant>`. */
export function chatImageSrc(id: string, variant: ChatImageVariant): string {
  return `/api/chat/images/${enc(id)}/${variant}`;
}
```

### Step 16: `useHistory`
**File:** `web/src/hooks/useHistory.ts` (new)
**Code:**
```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatImageSrc, fetchChatMessages, streamChat } from '../chatHistoryApi';
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
  /** Send from the history composer. False when refused (empty, or a reply still streaming): keep the draft. */
  send: (text: string, imageIds: string[]) => boolean;
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
        const page = await fetchChatMessages({ limit: HISTORY_PAGE, includeDeleted: deletedRef.current });
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
        const page = await fetchChatMessages({ before: cursor, limit: HISTORY_PAGE, includeDeleted: deletedRef.current });
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

  const send = useCallback((text: string, imageIds: string[]): boolean => {
    const message = text.trim();
    if (sendingRef.current) return false;
    if (!message && imageIds.length === 0) return false;
    const now = stRef.current;
    const threadId = threadForSend(timelineOf(now.server, now.local));
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
      attachments: imageIds.map((id) => ({
        kind: 'chat_image' as const,
        id,
        url: chatImageSrc(id, 'display'),
        thumb_url: chatImageSrc(id, 'thumb'),
      })),
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
        const res = await streamChat({ message, threadId, imageIds, signal: c.signal });
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
```
**Notes:**
- A `chat` event can race the `accepted` SSE frame and briefly show the question twice: the server row appears before the local bubble learns its id. `accepted` is the first frame and P7 writes it right after inserting the user row, so the overlap lasts milliseconds and the next merge removes it.
- The streamed reply can start with `[msg:ID]`, which the server strips into `reply_to` (Decision). The refresh after `done` replaces the local text with the server row's.

### Step 17: `useHistory` tests
**File:** `web/src/hooks/useHistory.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ChatPage } from '../types';
import { makeMessage } from '../testing/chatFixtures';
import { useHistory } from './useHistory';

interface Frame {
  event: string;
  data: unknown;
}

const enc = new TextEncoder();
const sseText = (frames: Frame[]): string => frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

function handStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  return { body, send: (frames: Frame[]) => ctl.enqueue(enc.encode(sseText(frames))), end: () => ctl.close() };
}

class FakeES {
  static all: FakeES[] = [];
  private l = new Map<string, Array<(e?: unknown) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    for (const fn of this.l.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

let latest: ChatPage;
let older: Record<string, ChatPage>;
let calls: string[];
let posted: Array<Record<string, unknown>>;
let bodies: Array<string | ReadableStream<Uint8Array>>;

beforeEach(() => {
  latest = { messages: [], next_before: null };
  older = {};
  calls = [];
  posted = [];
  bodies = [];
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url.startsWith('/api/chat/messages')) {
        const before = new URL(url, 'http://x').searchParams.get('before');
        return json(before ? (older[before] ?? { messages: [], next_before: null }) : latest);
      }
      if (method === 'POST' && url === '/api/chat') {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(bodies.shift() ?? '', { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ids = (r: { current: ReturnType<typeof useHistory> }) => r.current.items.map((i) => i.msg.id || i.key);
const m = (id: string, min: number, over = {}) => makeMessage(id, { created_at: new Date(Date.UTC(2026, 9, 31, 1, min)).toISOString(), ...over });

describe('useHistory', () => {
  it('does nothing while disabled, loads when enabled', async () => {
    latest = { messages: [m('A001', 1)], next_before: null };
    const { result, rerender } = renderHook(({ on }) => useHistory(on), { initialProps: { on: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    rerender({ on: true });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(ids(result)).toEqual(['A001']);
  });

  it('shows the latest page ascending and pages older with the cursor', async () => {
    latest = { messages: [m('D004', 4), m('C003', 3)], next_before: 'c1' };
    older = { c1: { messages: [m('B002', 2), m('A001', 1)], next_before: null } };
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(calls).toContain('GET /api/chat/messages?limit=50');
    expect(ids(result)).toEqual(['C003', 'D004']);
    expect(result.current.hasMore).toBe(true);
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(calls).toContain('GET /api/chat/messages?before=c1&limit=50');
    expect(ids(result)).toEqual(['A001', 'B002', 'C003', 'D004']);
    expect(result.current.hasMore).toBe(false);
  });

  it('refreshes on event: chat without a second connection, and drops a deleted message', async () => {
    latest = { messages: [m('A001', 1)], next_before: null };
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    latest = { messages: [m('A001', 1), m('B002', 2, { source: 'claude_code', thread_id: 'T9' })], next_before: null };
    act(() => FakeES.all[0]?.emit('chat', { op: 'created', thread_id: 'T9', id: 'B002' }));
    await waitFor(() => expect(ids(result)).toEqual(['A001', 'B002']));
    latest = { messages: [m('A001', 1)], next_before: null };
    act(() => FakeES.all[0]?.emit('chat', { op: 'deleted', thread_id: 'T9', id: 'B002' }));
    expect(ids(result)).toEqual(['A001']);
    expect(FakeES.all).toHaveLength(1);
  });

  it('loadOlder resolves to the prepended page, [] at the start, and shares an in-flight load', async () => {
    latest = { messages: [m('C003', 3)], next_before: 'c1' };
    older = { c1: { messages: [m('A001', 1)], next_before: null } };
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let a: unknown;
    let b: unknown;
    await act(async () => {
      const p1 = result.current.loadOlder();
      const p2 = result.current.loadOlder();
      [a, b] = await Promise.all([p1, p2]);
    });
    expect((a as Array<{ id: string }>).map((x) => x.id)).toEqual(['A001']);
    expect(b).toEqual(a);
    expect(calls.filter((c) => c.includes('before=c1'))).toHaveLength(1);
    await act(async () => {
      expect(await result.current.loadOlder()).toEqual([]);
    });
  });

  it('mutate changes the server rows locally; includeDeleted fetches with include_deleted=1 and keeps deleted rows', async () => {
    latest = { messages: [m('A001', 1)], next_before: null };
    const { result } = renderHook(() => useHistory(true, { includeDeleted: true }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(calls).toContain('GET /api/chat/messages?limit=50&include_deleted=1');
    act(() => result.current.mutate((ms) => ms.map((x) => ({ ...x, text: 'edited' }))));
    expect(result.current.messages[0]?.text).toBe('edited');
    act(() => FakeES.all[0]?.emit('chat', { op: 'deleted', thread_id: 'T1', id: 'A001' }));
    expect(ids(result)).toEqual(['A001']);
  });

  it('send: optimistic question + streaming reply, continues the newest wall thread, then swaps in server rows', async () => {
    latest = { messages: [m('A001', 1, { thread_id: 'T1' }), m('A002', 2, { thread_id: 'T1', role: 'assistant' })], next_before: null };
    const s = handStream();
    bodies.push(s.body);
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let ok = false;
    act(() => {
      ok = result.current.send('  next one  ', []);
    });
    expect(ok).toBe(true);
    expect(result.current.sending).toBe(true);
    const tail = result.current.items.slice(-2);
    expect(tail.map((i) => [i.msg.role, i.msg.text, i.local?.streaming])).toEqual([
      ['user', 'next one', false],
      ['assistant', '', true],
    ]);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ message: 'next one', thread_id: 'T1' });

    s.send([
      { event: 'accepted', data: { thread_id: 'T1', user_message_id: 'U009' } },
      { event: 'status', data: { text: 'searching notes' } },
      { event: 'delta', data: { text: 'Hel' } },
      { event: 'delta', data: { text: 'lo' } },
    ]);
    await waitFor(() => expect(result.current.items.at(-1)?.msg.text).toBe('Hello'));
    expect(result.current.items.at(-1)?.local?.status).toBe('searching notes');

    latest = {
      messages: [...latest.messages, m('U009', 3, { thread_id: 'T1', text: 'next one' }), m('R009', 4, { thread_id: 'T1', role: 'assistant', text: 'Hello', brain: 'glm' })],
      next_before: null,
    };
    s.send([{ event: 'done', data: { thread_id: 'T1', user_message_id: 'U009', assistant_message_id: 'R009', reply_to: null, brain: 'glm' } }]);
    s.end();
    await waitFor(() => expect(ids(result)).toEqual(['A001', 'A002', 'U009', 'R009']));
    expect(result.current.items.every((i) => i.local === null)).toBe(true);
    expect(result.current.sending).toBe(false);
  });

  it('starts a new thread when the newest exchange came from Claude Code, and sends pasted image ids', async () => {
    latest = { messages: [m('A001', 1, { thread_id: 'T1' }), m('C001', 2, { thread_id: 'T9', source: 'claude_code' })], next_before: null };
    bodies.push(sseText([{ event: 'done', data: { thread_id: 'T2', user_message_id: 'U1', assistant_message_id: 'R1', reply_to: null, brain: 'claude' } }]));
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.send('look', ['U-AA1']);
    });
    expect(result.current.items.at(-2)?.msg.attachments).toEqual([
      { kind: 'chat_image', id: 'U-AA1', url: '/api/chat/images/U-AA1/display', thumb_url: '/api/chat/images/U-AA1/thumb' },
    ]);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ message: 'look', image_ids: ['U-AA1'] });
  });

  it('turns the reply into an error bubble on failure; refuses a second send while streaming', async () => {
    const s = handStream();
    bodies.push(s.body);
    const { result } = renderHook(() => useHistory(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.send('first', []);
    });
    let second = true;
    act(() => {
      second = result.current.send('second', []);
    });
    expect(second).toBe(false);
    expect(result.current.send('   ', [])).toBe(false);
    s.send([{ event: 'error', data: { error: 'boom' } }]);
    s.end();
    await waitFor(() => expect(result.current.sending).toBe(false));
    const [q, a] = result.current.items.slice(-2);
    expect(a?.local?.error).toBe('Chat failed: boom');
    expect(a?.local?.streaming).toBe(false);
    expect(q?.local?.error).toBe('not sent');
  });
});
```

### Step 18: Bubble component
**File:** `web/src/components/Bubble.tsx` (new; Phases 10 and 11 extend it)
**Code:**
```tsx
import { Fragment } from 'react';
import type { LightboxItem } from './Lightbox';
import { chatImageSrc } from '../chatHistoryApi';
import { chatTime, chatTimeTitle } from '../lib/chatTime';
import { segmentLinks } from '../lib/links';
import type { TimelineItem } from '../lib/timeline';
import type { ChatAttachment } from '../types';

/** Thumbnail box in px: square, the image is `object-fit: cover` inside it (P7's wire carries no dimensions, so nothing can jump on load). */
export const THUMB_H = 96;

/** Width of a thumbnail box. Optional dimensions are honoured if a later wire adds them; P7's attachments have none. */
export function thumbWidth(a: { width?: number | null; height?: number | null }): number {
  const w = a.width ?? 0;
  const h = a.height ?? 0;
  if (w > 0 && h > 0) return Math.min(240, Math.max(48, Math.round((THUMB_H * w) / h)));
  return THUMB_H;
}

/** A message's image attachments as P2 lightbox items, in message order (`url` is the display variant). */
export function lightboxItemsOf(images: ChatAttachment[]): LightboxItem[] {
  return images.map((a) => ({
    id: a.id,
    src: a.url || chatImageSrc(a.id, 'display'),
    label: a.kind === 'chat_image' ? `upload:${a.id}` : a.id,
  }));
}

export interface BubbleProps {
  item: TimelineItem;
  now: Date;
  /** Part of the thread the page was opened on (`/history?thread=`): briefly outlined. */
  focused: boolean;
  onOpenImages: (items: LightboxItem[], index: number) => void;
}

const CHIP_KIND: Record<ChatAttachment['kind'], string> = { chat_image: 'upload', note_image: 'image', note_file: 'file' };

export function Bubble({ item, now, focused, onOpenImages }: BubbleProps) {
  const { msg, local } = item;
  const mine = msg.role === 'user';
  const streaming = local?.streaming ?? false;
  const images = msg.attachments.filter((a) => a.kind === 'chat_image');
  const chips = msg.attachments.filter((a) => a.kind !== 'chat_image');
  const parts = msg.text ? msg.text.split('\n\n') : [];
  const cls = ['bubble', mine ? 'mine' : 'theirs', local?.error ? 'error' : '', focused ? 'focus' : ''].filter(Boolean).join(' ');
  const caption = streaming ? (local?.status ?? '') : msg.role === 'assistant' ? (msg.brain ?? '') : '';

  return (
    <li className={cls} data-msg={msg.id || undefined} data-msg-key={item.key} data-thread={msg.thread_id || undefined}>
      <div className="bubble-body">
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
                  data-tip={`upload:${a.id}`}
                  aria-label={`View image upload:${a.id}`}
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
              {segmentLinks(t, { streaming: tail }).map((s, j) =>
                s.kind === 'link' ? (
                  <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
                    {s.text}
                  </a>
                ) : (
                  <Fragment key={j}>{s.text}</Fragment>
                ),
              )}
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
      <div className="bubble-meta">
        <time dateTime={msg.created_at} data-tip={chatTimeTitle(msg.created_at)}>
          {chatTime(msg.created_at, now)}
        </time>
        {caption && <span className="bubble-caption">{caption}</span>}
      </div>
    </li>
  );
}
```

### Step 19: HistoryPage
**File:** `web/src/pages/HistoryPage.tsx` (new)
**Code:**
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

/** Within this many px of the bottom counts as "at the bottom": new messages keep the page pinned there. */
const STICK_PX = 80;
/** Scrolling within this many px of the top pages older messages. */
const OLDER_PX = 240;
/** Older pages fetched at most while looking for the `?thread=` target. */
const FOCUS_PAGES = 5;
const FLASH_MS = 2400;

export interface HistoryPageProps {
  store: HistoryStore;
  /** `/history?thread=ID`: scroll to that thread and outline it once it is loaded. */
  focusThread: string | null;
  now: Date;
}

/**
 * The page's composer: Phase 3's `ChatBar` in its `page` variant (laid out here, sticky at the
 * bottom of the column; it does not publish --chatbar-h), with its own draft and its own
 * `useChatImages()` instance, so the wall bar's draft and pasted images are untouched by a visit.
 * The draft lives as long as the page is shown.
 */
function HistoryComposer({ store }: { store: HistoryStore }) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // An image still uploading (or failed and not removed) holds the message back, as on the wall.
    if (images.blocked) return;
    const ids = images.readyIds;
    if (!draft.trim() && ids.length === 0) return;
    if (store.send(draft, ids)) {
      setDraft('');
      images.clear();
    }
  };
  return (
    <div className="hist-composer">
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

function ThreadDivider({ item, now }: { item: TimelineItem; now: Date }) {
  const label = item.msg.source === 'claude_code' ? 'claude code' : item.local && !item.msg.thread_id ? 'new thread' : 'wall chat';
  return (
    <li className="hist-divider" role="separator" data-thread-start={item.msg.thread_id || undefined}>
      <span>
        {label} · {chatTime(item.msg.created_at, now)}
      </span>
    </li>
  );
}

const atBottom = (): boolean => {
  const el = document.documentElement;
  return window.innerHeight + window.scrollY >= el.scrollHeight - STICK_PX;
};

const scrollToBottom = (): void => {
  window.scrollTo(0, document.documentElement.scrollHeight);
};

export function HistoryPage({ store, focusThread, now }: HistoryPageProps) {
  const { items, loaded, error, hasMore, loadingOlder, loadOlder } = store;
  const [box, setBox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const ready = useRef(false);
  const anchor = useRef<{ first: string | null; height: number }>({ first: null, height: 0 });
  const focus = useRef<{ thread: string | null; tries: number; done: boolean }>({ thread: null, tries: 0, done: true });
  const older = useRef(loadOlder);
  older.current = loadOlder;

  // Track "pinned to the bottom" and page older messages near the top.
  useEffect(() => {
    const onScroll = () => {
      stick.current = atBottom();
      if (ready.current && window.scrollY < OLDER_PX) void older.current();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A new ?thread= target (declared before the scroll effect so it is in place when that runs).
  useLayoutEffect(() => {
    focus.current = { thread: focusThread, tries: 0, done: focusThread === null };
  }, [focusThread]);

  // After each change of the list: keep the reading position when older messages were prepended,
  // follow new messages when pinned, or bring the focused thread into view once it is loaded.
  useLayoutEffect(() => {
    if (!loaded) return;
    const el = document.documentElement;
    const first = items[0]?.key ?? null;
    const prev = anchor.current;
    const prepended = prev.first !== null && first !== prev.first && items.some((it, i) => i > 0 && it.key === prev.first);
    const f = focus.current;
    if (!f.done && f.thread !== null) {
      let target = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]?.msg.thread_id === f.thread) {
          target = i;
          break;
        }
      }
      if (target >= 0) {
        f.done = true;
        const node = listRef.current?.querySelector<HTMLElement>(`[data-msg-key="${items[target]?.key ?? ''}"]`);
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
        stick.current = target === items.length - 1;
        setFlash(f.thread);
      } else if (hasMore && f.tries < FOCUS_PAGES) {
        f.tries += 1;
        void older.current();
      } else {
        f.done = true;
        scrollToBottom();
      }
    } else if (prepended) {
      window.scrollTo(0, window.scrollY + (el.scrollHeight - prev.height));
    } else if (stick.current) {
      scrollToBottom();
    }
    anchor.current = { first, height: el.scrollHeight };
    ready.current = true;
  }, [items, loaded, hasMore]);

  useEffect(() => {
    if (flash === null) return;
    const t = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flash]);

  return (
    <section className="history" aria-label="Chat history">
      {hasMore && (
        <button type="button" className="hist-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? 'Loading earlier messages' : 'Earlier messages'}
        </button>
      )}
      {error && (
        <p className="hist-note" role="status">
          Could not load the chat history: {error}
        </p>
      )}
      {!loaded && <p className="hist-note">Loading…</p>}
      {loaded && items.length === 0 && !error && <p className="hist-note">No chats yet. Ask something below.</p>}
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
      {box && (
        <Lightbox
          items={box.items}
          index={box.index}
          onIndex={(index) => setBox((b) => (b ? { ...b, index } : b))}
          onClose={() => setBox(null)}
        />
      )}
    </section>
  );
}
```

### Step 20: History CSS
**File:** `web/src/pages/HistoryPage.css` (new)
**Code:**
```css
/* Chat history page (phase 9). The wall's dark mono language: hairlines, Geist Mono meta, no
   shadows. Bubbles are the one rounded thing, echoing the chat pill. Chat uploads carry no film tone
   (the lightbox shows them untoned too). The page scrolls with the window like the wall; .main's
   150px bottom padding keeps the last bubble above the pill. */
.history { max-width: 760px; margin: 0 auto; padding-top: 30px; }
.hist-older { display: block; margin: 0 auto 18px; border: 1px solid var(--line-25); background: transparent; color: var(--fg); font-family: var(--mono); font-size: 10.5px; padding: 4px 10px; border-radius: 999px; cursor: pointer; }
.hist-older:hover:not(:disabled) { background: var(--fg); color: var(--bg); }
.hist-older:disabled { opacity: .5; cursor: default; }
.hist-note { margin: 30px 0 0; font-family: var(--mono); font-size: 11px; color: var(--dim); text-align: center; }
.hist-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.hist-divider { display: flex; align-items: center; gap: 10px; margin: 18px 0 4px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); white-space: nowrap; }
.hist-divider::before, .hist-divider::after { content: ""; flex: 1; height: 1px; background: var(--line-12); }

.bubble { display: flex; flex-direction: column; max-width: min(620px, 82%); }
.bubble.mine { align-self: flex-end; align-items: flex-end; }
.bubble.theirs { align-self: flex-start; align-items: flex-start; }
.bubble-body { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; font-size: 15px; line-height: 1.5; color: var(--text); text-wrap: pretty; overflow-wrap: anywhere; outline: 1px solid transparent; outline-offset: 3px; transition: outline-color .35s; }
.bubble.mine .bubble-body { background: var(--chip-bg); border-radius: 16px 16px 4px 16px; }
.bubble.theirs .bubble-body { background: var(--panel); border: 1px solid var(--line-14); border-radius: 16px 16px 16px 4px; }
.bubble.focus .bubble-body { outline-color: var(--ring); }
.bubble-body p { margin: 0; white-space: pre-wrap; }
.bubble-badge { align-self: flex-start; font-family: var(--mono); font-size: 10px; line-height: 1; padding: 3px 7px 4px; border-radius: 999px; background: var(--fg); color: var(--bg); letter-spacing: .02em; }
.bubble.mine .bubble-badge { align-self: flex-end; }
.bubble-thumbs { display: flex; flex-wrap: wrap; gap: 4px; }
.bubble.mine .bubble-thumbs { justify-content: flex-end; }
.bubble-thumb { display: block; padding: 0; border: 0; background: var(--img-bg); cursor: zoom-in; line-height: 0; }
.bubble-thumb img { display: block; object-fit: cover; background: var(--img-bg); }
.bubble-thumb:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; }
.bubble-wait { color: var(--dim); font-family: var(--mono); font-size: 11px; }
.bubble-error { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.bubble.error .bubble-body { border-color: var(--line-25); }
.bubble-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.bubble-chip { font-family: var(--mono); font-size: 10.5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line-25); color: var(--chip); }
.bubble-meta { display: flex; gap: 8px; margin-top: 4px; padding: 0 6px; font-family: var(--mono); font-size: 10px; color: var(--dim); }
.bubble-meta time { cursor: default; }
.bubble-caption::before { content: "·"; margin-right: 8px; }

/* The page composer: Phase 3's ChatBar with variant="page" (class .chatbar-page, no inline left,
   does not publish --chatbar-h). It sticks to the bottom of the column instead of the wall's
   fixed pill; .main's 150px bottom padding leaves room under the last bubble. */
.hist-composer { position: sticky; bottom: 16px; margin-top: 24px; z-index: 41; }
.chatbar.chatbar-page { position: relative; left: auto; right: auto; bottom: auto; width: 100%; }
```

### Step 21: HistoryPage tests
**File:** `web/src/pages/HistoryPage.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage } from '../types';
import type { HistoryStore } from '../hooks/useHistory';
import type { LocalBubble, TimelineItem } from '../lib/timeline';
import { localToMessage } from '../lib/timeline';
import { makeMessage } from '../testing/chatFixtures';
import { HistoryPage } from './HistoryPage';

// 2026-10-31 12:00 in Jakarta.
const NOW = new Date('2026-10-31T05:00:00Z');

const item = (m: ChatMessage): TimelineItem => ({ key: m.id, msg: m, local: null });
const localItem = (l: LocalBubble): TimelineItem => ({ key: l.key, msg: localToMessage(l), local: l });

function store(items: TimelineItem[], over: Partial<HistoryStore> = {}): HistoryStore {
  return {
    items,
    messages: items.filter((i) => i.local === null).map((i) => i.msg),
    loaded: true,
    error: null,
    hasMore: false,
    loadingOlder: false,
    sending: false,
    loadOlder: vi.fn(async () => []),
    refresh: vi.fn(),
    mutate: vi.fn(),
    send: vi.fn(() => true),
    ...over,
  };
}

const q1 = makeMessage('Q001', { thread_id: 'T1', text: 'what about seer?', created_at: '2026-10-30T17:30:00Z' });
const a1 = makeMessage('A001', { thread_id: 'T1', role: 'assistant', text: 'Seer is fine.', brain: 'claude', created_at: '2026-10-30T17:31:00Z' });
const q2 = makeMessage('Q002', {
  thread_id: 'T2',
  source: 'claude_code',
  text: '/n find photos like this',
  created_at: '2026-10-29T03:00:00Z',
  attachments: [
    { kind: 'chat_image', id: 'U-AA1', url: '/api/chat/images/U-AA1/display', thumb_url: '/api/chat/images/U-AA1/thumb' },
    { kind: 'chat_image', id: 'U-BB2', url: '/api/chat/images/U-BB2/display', thumb_url: '/api/chat/images/U-BB2/thumb' },
    { kind: 'note_image', id: 'K-F07', url: '/api/images/K-F07/display', thumb_url: '/api/images/K-F07/thumb' },
    { kind: 'note_file', id: 'F-Z11', url: '/api/files/F-Z11/download', thumb_url: null },
  ],
});

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

const bubble = (id: string) => document.querySelector(`[data-msg="${id}"]`) as HTMLElement;

describe('HistoryPage', () => {
  it('puts user bubbles right and answers left, with a Jakarta timestamp on every bubble', () => {
    render(<HistoryPage store={store([item(q2), item(q1), item(a1)])} focusThread={null} now={NOW} />);
    expect(bubble('Q001').className).toContain('mine');
    expect(bubble('A001').className).toContain('theirs');
    const times = Array.from(document.querySelectorAll('.bubble time'));
    expect(times).toHaveLength(3);
    // 17:30 UTC on the 30th is 00:30 on the 31st in Jakarta: today, so time only.
    expect(within(bubble('Q001')).getByText('00:30').getAttribute('data-tip')).toBe('2026-10-31T00:30:00+07:00 (UTC+7)');
    expect(within(bubble('Q002')).getByText('29 Oct 10:00')).toBeTruthy();
    expect(within(bubble('A001')).getByText('claude')).toBeTruthy();
  });

  it('badges claude code bubbles and draws a divider where the thread changes', () => {
    render(<HistoryPage store={store([item(q2), item(q1), item(a1)])} focusThread={null} now={NOW} />);
    expect(within(bubble('Q002')).getByText('claude code')).toBeTruthy();
    expect(within(bubble('Q001')).queryByText('claude code')).toBeNull();
    const seps = screen.getAllByRole('separator');
    expect(seps).toHaveLength(2);
    expect(seps[0]?.textContent).toContain('claude code');
    expect(seps[1]?.textContent).toContain('wall chat');
  });

  it('reserves a square thumbnail box per chat image (the wire has no dimensions) and shows note attachments as id chips', () => {
    render(<HistoryPage store={store([item(q2)])} focusThread={null} now={NOW} />);
    const imgs = Array.from(bubble('Q002').querySelectorAll('.bubble-thumb img')) as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/chat/images/U-AA1/thumb', '/api/chat/images/U-BB2/thumb']);
    expect([imgs[0]?.getAttribute('width'), imgs[0]?.getAttribute('height')]).toEqual(['96', '96']);
    expect([imgs[1]?.getAttribute('width'), imgs[1]?.getAttribute('height')]).toEqual(['96', '96']);
    const chips = Array.from(bubble('Q002').querySelectorAll('.bubble-chip')).map((c) => c.textContent);
    expect(chips).toEqual(['image K-F07', 'file F-Z11']);
  });

  it('a thumbnail opens the lightbox on it; arrows move across the message images', () => {
    render(<HistoryPage store={store([item(q2)])} focusThread={null} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'View image upload:U-BB2' }));
    const shown = () => document.querySelector('[data-lightbox] img')?.getAttribute('src');
    expect(shown()).toBe('/api/chat/images/U-BB2/display');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(shown()).toBe('/api/chat/images/U-AA1/display');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-lightbox]')).toBeNull();
  });

  it('streams into an optimistic bubble and shows an error bubble on failure', () => {
    const base: LocalBubble = {
      key: 'local-1-a',
      role: 'assistant',
      serverId: null,
      threadId: 'T1',
      text: '',
      createdAt: '2026-10-31T04:59:00Z',
      attachments: [],
      streaming: true,
      status: 'searching notes',
      brain: null,
      error: null,
    };
    const { rerender } = render(<HistoryPage store={store([item(q1), localItem(base)])} focusThread={null} now={NOW} />);
    const pending = document.querySelector('[data-msg-key="local-1-a"]') as HTMLElement;
    expect(pending.textContent).toContain('searching notes');
    rerender(<HistoryPage store={store([item(q1), localItem({ ...base, streaming: false, status: '', error: 'Chat failed: boom' })])} focusThread={null} now={NOW} />);
    const failed = document.querySelector('[data-msg-key="local-1-a"]') as HTMLElement;
    expect(failed.className).toContain('error');
    expect(failed.textContent).toContain('Chat failed: boom');
  });

  it('offers earlier messages when there are more', () => {
    const s = store([item(q1)], { hasMore: true });
    render(<HistoryPage store={s} focusThread={null} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier messages' }));
    expect(s.loadOlder).toHaveBeenCalled();
  });

  it('opened on a thread, scrolls to it and outlines its bubbles', () => {
    render(<HistoryPage store={store([item(q2), item(q1), item(a1)])} focusThread="T1" now={NOW} />);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(bubble('A001').className).toContain('focus');
    expect(bubble('Q001').className).toContain('focus');
    expect(bubble('Q002').className).not.toContain('focus');
  });

  it('opened on a thread that is not loaded yet, pages older to find it', () => {
    const s = store([item(q1)], { hasMore: true });
    render(<HistoryPage store={s} focusThread="T-OLD" now={NOW} />);
    expect(s.loadOlder).toHaveBeenCalledTimes(1);
  });

  it('renders its own page-variant ChatBar; Enter sends through store.send and clears the draft', () => {
    const s = store([item(q1)]);
    render(<HistoryPage store={s} focusThread={null} now={NOW} />);
    const form = document.querySelector('form.chatbar') as HTMLFormElement;
    expect(form.className).toContain('chatbar-page');
    expect(form.getAttribute('data-chatbar')).toBe('page');
    const ta = screen.getByLabelText('Ask about your notes') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'and now?' } });
    fireEvent.submit(form);
    expect(s.send).toHaveBeenCalledWith('and now?', []);
    expect(ta.value).toBe('');
  });
});
```
**Notes:** the arrow and Esc assertions depend on Phase 2's window capture listener, which exists per `phase-2.md`. P7's attachments carry no dimensions, so every thumbnail box is `THUMB_H` square (`object-fit: cover`).

### Step 22: `useChat` exposes our thread id
**File:** `web/src/hooks/useChat.ts` (as Phase 3 Step 18 rewrote it whole: `ChatState` has `images`, `ask(message, imageIds)`; these edits do not touch `ask`'s signature)
**Change 22a**, `ChatState`: add the field after `brain`:
```ts
  /** Which brain answered ('claude' | 'glm'), from `done.brain`; null when the server named none. */
  brain: string | null;
  /** OUR thread id (phase 7: `accepted.thread_id`, then `done.thread_id`); null before the first answer starts and after dismiss. The answer panel's full-screen button opens `/history?thread=<it>`. */
  threadId: string | null;
}
```
**Change 22b**, initial state in `useState<ChatState>({...})`: add `threadId: null,` after `brain: null,`.
**Change 22c**, the SSE handler inside `ask`: replace the `done` branch
```ts
        } else if (ev.event === 'done') {
          const d = parse(ev.data);
          if (typeof d.thread_id === 'string' && d.thread_id) threadId.current = d.thread_id;
          ended = true;
          finish(undefined, typeof d.brain === 'string' && d.brain ? d.brain : null);
```
with
```ts
        } else if (ev.event === 'accepted') {
          const d = parse(ev.data);
          if (typeof d.thread_id === 'string' && d.thread_id) {
            const t = d.thread_id;
            threadId.current = t;
            setSt((s) => ({ ...s, threadId: t }));
          }
        } else if (ev.event === 'done') {
          const d = parse(ev.data);
          if (typeof d.thread_id === 'string' && d.thread_id) {
            const t = d.thread_id;
            threadId.current = t;
            setSt((s) => ({ ...s, threadId: t }));
          }
          ended = true;
          finish(undefined, typeof d.brain === 'string' && d.brain ? d.brain : null);
```
**Change 22d**, `close`: replace its `setSt` (Phase 3's, which already clears `images`) with:
```ts
    setSt((s) => ({ ...s, open: false, pinned: false, collapsed: false, images: [], text: '', done: false, status: '', brain: null, threadId: null }));
```
**Impact:** wall behavior is unchanged: the ref already carried the thread for follow-ups. Since Phase 7, `accepted` arrives first, so a turn that errors after it still keeps the thread for the next message.

**File:** `web/src/hooks/useChat.test.tsx`. Append inside `describe('useChat', …)`. The test uses the file's existing `handStream`/`stubChat` helpers. Phase 3 may have changed `stubChat` and `Posted`; the test below needs only that each queued body is returned for a POST.
```tsx
  it('exposes our thread id from accepted, keeps it on done, clears it on close', async () => {
    const s = handStream();
    stubChat(s.body);
    const { result } = renderHook(() => useChat());
    expect(result.current.threadId).toBeNull();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('hello');
    });
    s.send([{ event: 'accepted', data: { thread_id: 'T-7', user_message_id: 'U001' } }]);
    await waitFor(() => expect(result.current.threadId).toBe('T-7'));
    s.send([{ event: 'done', data: { thread_id: 'T-7', user_message_id: 'U001', assistant_message_id: 'A001', reply_to: null, brain: 'claude' } }]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.threadId).toBe('T-7');
    act(() => result.current.close());
    expect(result.current.threadId).toBeNull();
  });
```

### Step 23: AnswerPanel "Chat in full screen" and thumbnails into the Lightbox
**File:** `web/src/components/AnswerPanel.tsx` (as Phase 3 Step 21 rewrote it: `images?: readonly string[]` prop and an `.answer-images` row of `<img>` thumbnails)
**Change 23a**, imports: replace Phase 3's first and third import lines
```ts
import { Fragment } from 'react';
```
```ts
import { CaretDown, CaretUp, PushPin, X } from '@phosphor-icons/react';
```
with
```ts
import { Fragment, useState } from 'react';
```
```ts
import { ArrowsOut, CaretDown, CaretUp, PushPin, X } from '@phosphor-icons/react';
import { Lightbox } from './Lightbox';
```
**Change 23b**, `AnswerPanelProps`: add after `onJump`:
```ts
  /** Phase 9: open the history page on this conversation's thread. Absent = no button. */
  onFullScreen?: () => void;
```
and add `onFullScreen,` to the destructured parameters after `onJump,`. As the first line of the function body add:
```ts
  // Phase 3 left the sent thumbnails inert; they open the Phase 2 Lightbox over the panel.
  const [viewing, setViewing] = useState<number | null>(null);
```
**Change 23c**, head buttons: insert directly before the Collapse/Expand `<button` (the one with `aria-expanded`):
```tsx
        {onFullScreen && (
          <button type="button" className="pbtn hov" data-tip="Chat in full screen" aria-label="Chat in full screen" onClick={onFullScreen}>
            <ArrowsOut weight="duotone" />
          </button>
        )}
```
**Change 23d**, Phase 3's thumbnail row: replace
```tsx
      {!collapsed && images.length > 0 && (
        <div className="answer-images">
          {images.map((id) => (
            <img key={id} src={chatImageUrl(id, 'thumb')} alt={`pasted image ${id}`} />
          ))}
        </div>
      )}
```
with
```tsx
      {!collapsed && images.length > 0 && (
        <div className="answer-images">
          {images.map((id, i) => (
            <button key={id} type="button" className="answer-image" aria-label={`View image upload:${id}`} onClick={() => setViewing(i)}>
              <img src={chatImageUrl(id, 'thumb')} alt={`pasted image ${id}`} />
            </button>
          ))}
        </div>
      )}
      {viewing !== null && viewing < images.length && (
        <Lightbox
          items={images.map((id) => ({ id, src: chatImageUrl(id, 'display'), label: `upload:${id}` }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
```
The Lightbox's Esc handler calls `preventDefault()` and stops propagation (Phase 2's seam), so App's document Esc listener (`if (e.defaultPrevented) return;`) never dismisses the panel behind it.

**File:** `web/src/components/ChatBar.css` (Phase 3 added `.answer-images img`): append
```css
.answer-image { display: block; padding: 0; border: 0; background: none; cursor: zoom-in; line-height: 0; }
.answer-image:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; }
```
**Impact:** the collapsed header's click handler already ignores clicks on buttons, so pressing it never toggles the collapse. The thumbnails keep Phase 3's look; they are now buttons that open the shared lightbox (R4: "one shared lightbox, chat + note modal").

**File:** `web/src/components/AnswerPanel.test.tsx`. Append:
```tsx
describe('AnswerPanel full screen', () => {
  it('shows a "Chat in full screen" button only when the host passes onFullScreen', () => {
    const onFullScreen = vi.fn();
    const { rerender } = render(<AnswerPanel {...props()} />);
    expect(screen.queryByRole('button', { name: 'Chat in full screen' })).toBeNull();
    rerender(<AnswerPanel {...props({ onFullScreen })} />);
    const btn = screen.getByRole('button', { name: 'Chat in full screen' });
    expect(btn.getAttribute('data-tip')).toBe('Chat in full screen');
    fireEvent.click(btn);
    expect(onFullScreen).toHaveBeenCalledTimes(1);
  });

  it('works from the collapsed header without expanding it', () => {
    const onFullScreen = vi.fn();
    const onToggleCollapse = vi.fn();
    render(<AnswerPanel {...props({ collapsed: true, onFullScreen, onToggleCollapse })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat in full screen' }));
    expect(onFullScreen).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});

describe('AnswerPanel sent thumbnails', () => {
  it('a thumbnail opens the shared Lightbox; Esc closes only the lightbox', () => {
    const onClose = vi.fn();
    render(<AnswerPanel {...props({ images: ['U-AA1', 'U-BB2'], onClose })} />);
    fireEvent.click(screen.getByRole('button', { name: 'View image upload:U-BB2' }));
    expect(document.querySelector('[data-lightbox] img')?.getAttribute('src')).toBe('/api/chat/images/U-BB2/display');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-lightbox]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

### Step 24: App: the `history` view, URL sync, composer, full screen
**File:** `web/src/App.tsx`, as it is after Phase 3 Step 22 (`import { useChatImages } …`, `const chatImages = useChatImages();`, the `send` that passes `chatImages.readyIds`, `images={chat.images}` on `AnswerPanel`, the wall `<ChatBar … images={chatImages.images} … sendBlocked={chatImages.blocked} />`) and Phase 5 Step 13 (`attachFiles`, `onAttachFailed`, `removeFileWithUndo`, the `hasAttachments` empty rule, `DropOverlay`/`NoteEditor` props). Every anchor below is quoted text; line numbers are not used because Phases 3 and 5 move them. None of the anchors is one Phase 3 or Phase 5 edits, except where the quote says so.

**24a, imports**: add these lines next to the existing imports (Phase 3's `useChatImages` import stays; the history composer's own instance lives in `HistoryPage`, Step 19):
```ts
import { useHistory } from './hooks/useHistory';
import { hrefForView, routeFromLocation } from './lib/route';
import { HISTORY_HEADING, historyCountLine } from './lib/timeline';
import { HistoryPage } from './pages/HistoryPage';
```

**24b, view state**: replace
```ts
  const [view, setView] = useState<View>('wall');
```
with
```ts
  // `/history[?thread=ID]` opens straight into the chat history page (served by the SPA fallback).
  const [view, setView] = useState<View>(() => (routeFromLocation(window.location).history ? 'history' : 'wall'));
  const [historyThread, setHistoryThread] = useState<string | null>(() => routeFromLocation(window.location).thread);
  // Lives in App so a reply keeps streaming while the user is on the wall; fetches only while shown.
  const history = useHistory(view === 'history');
```

**24c, toggles and URL sync**: insert directly after
```ts
  const toggleBin = useCallback(() => setView((v) => (v === 'bin' ? 'wall' : 'bin')), []);
```
the following:
```ts
  /** Rail / sidebar chat-history icon: open the page (no thread focus); a second press returns to the wall. */
  const toggleHistory = useCallback(() => {
    setHistoryThread(null);
    setView((v) => (v === 'history' ? 'wall' : 'history'));
  }, []);

  /** Answer panel "Chat in full screen": the history page on this conversation's thread. */
  const openHistoryThread = useCallback(() => {
    setHistoryThread(chat.threadId);
    setView('history');
  }, [chat.threadId]);

  // The address bar follows the view (pathname guard, lib/route.ts hrefForView): entering the
  // history page pushes /history[?thread=]; leaving it pushes / only when the path is /history.
  // Wall and bin never rewrite a non-history URL, so /?note=ID survives a switch to the wall
  // (Phase 11's show-on-wall relies on this). This is the one URL-sync owner; no other phase adds one.
  useEffect(() => {
    const href = hrefForView(view, historyThread, window.location);
    if (href !== null) window.history.pushState(null, '', href);
  }, [view, historyThread]);

  // Back / forward between /history and the wall. A /?note= target is handled by useDeepLink's own
  // popstate listener (planReveal moves the view to the wall).
  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation(window.location);
      setHistoryThread(r.thread);
      setView((v) => (r.history ? 'history' : v === 'history' ? 'wall' : v));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
```

**24d, history send**: none in App. The history composer (draft, pasted images, submit) is `HistoryPage`'s own (Step 19); the wall's `send` and `chatImages` are untouched.

**24e, Esc effect** (the `useEffect` whose listener closes the chat on Escape unless pinned): replace with
```ts
  const { open: chatOpen, pinned, close: closeChat } = chat;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // The answer panel is hidden on the history page; Esc there must not end the wall conversation.
      if (e.key === 'Escape' && chatOpen && !pinned && view !== 'history') closeChat();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chatOpen, pinned, closeChat, view]);
```

**24f, Rail and Sidebar** (the `<Rail …>` and `<Sidebar …>` elements): add `onToggleHistory={toggleHistory}` to both. In `<Rail …>`, put it right before `onToggleBin={toggleBin}`. In `<Sidebar …>`, put it right before `onToggleBin={toggleBin}`.

**24g, Header**: replace the `<Header … />` element with
```tsx
          <Header
            heading={view === 'history' ? HISTORY_HEADING : view === 'bin' ? BIN_HEADING : headingFor(mode, active)}
            countLine={
              view === 'history'
                ? historyCountLine(history.items, history.hasMore)
                : view === 'bin'
                  ? binCountLine(binStore.bin, active)
                  : countLineFor(mode, active, notes, visible, photos)
            }
            last={last}
            lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
            showSticker={view === 'wall' && mode !== 'images'}
            bin={view === 'bin'}
            history={view === 'history'}
            onJumpLast={() => last && jump(last.id)}
            onAdd={() => void addNote()}
          />
```

**24h, main content**: replace the opening of the conditional
```tsx
          {view === 'bin' ? (
            <Bin store={binStore} now={now} onRestored={onRestored} />
```
with
```tsx
          {view === 'history' ? (
            <HistoryPage store={history} focusThread={historyThread} now={now} />
          ) : view === 'bin' ? (
            <Bin store={binStore} now={now} onRestored={onRestored} />
```
(The `Gallery`/`Wall` branches are unchanged.)

**24i, AnswerPanel** (the element Phase 3 gave `images={chat.images}`): change the guard `{chat.open && (` to `{chat.open && view !== 'history' && (` and add the prop `onFullScreen={openHistoryThread}` after `onJump={jump}`. The wall conversation stays in `useChat` and the panel comes back when the user returns to the wall.

**24j, ChatBar**: the wall bar is not rendered on the history page (the page renders its own `variant="page"` bar, Step 19). Wrap Phase 3's wall element in a guard, props unchanged:
```tsx
        {view !== 'history' && (
          <ChatBar
            left={chatLeft}
            value={q}
            onChange={setQ}
            onSubmit={send}
            images={chatImages.images}
            onPasteFiles={chatImages.add}
            onRemoveImage={chatImages.remove}
            sendBlocked={chatImages.blocked}
          />
        )}
```
The wall bar's draft `q` and `chatImages` live in App, so they survive a visit to the history page. While it is unmounted `--chatbar-h` is removed (Phase 3's cleanup) and the undo bar falls back to its 54px default, just above the page composer's single line.

**Impact:**
- `planReveal` returns `view: 'wall'`, so a "Last edited" jump, a `/?note=` link or a used-id chip leaves the history page. The push effect then writes `/` only if the URL was `/history…`.
- `pickMode`, `onCycleMode`, `addNote`, `onImageAdded` and `toggleBin` already set the view, so they leave the history page too.
- `useBin(active, view === 'bin')` is unchanged.

### Step 25: App tests
**File:** `web/src/App.history.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatPage, Note } from './types';
import { makeNote } from './testing/fixtures';
import { makeMessage } from './testing/chatFixtures';
import { App } from './App';

const iso = new Date().toISOString();
const notes: Note[] = [makeNote('A-B32', '#seer onboarding is long', { created: iso }), makeNote('C-D45', 'buy fennel #kitchen', { created: iso })];
const page: ChatPage = {
  messages: [
    makeMessage('Q001', { thread_id: 'T-1', text: 'what about seer?', created_at: iso }),
    makeMessage('A001', { thread_id: 'T-1', role: 'assistant', text: 'Seer is fine.', created_at: iso }),
  ],
  next_before: null,
};
const CHAT_SSE =
  'event: accepted\ndata: {"thread_id":"T-1","user_message_id":"Q001"}\n\n' +
  'event: delta\ndata: {"text":"Seer is fine."}\n\n' +
  'event: done\ndata: {"thread_id":"T-1","user_message_id":"Q001","assistant_message_id":"A001","reply_to":null,"brain":"claude"}\n\n';

let calls: string[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/notes/')) {
        const id = decodeURIComponent(url.slice('/api/notes/'.length));
        const hit = notes.find((n) => n.id === id);
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
      }
      if (url.startsWith('/api/tags')) return json([]);
      if (url.startsWith('/api/chat/messages')) return json(page);
      if (method === 'POST' && url === '/api/chat') return new Response(CHAT_SSE, { headers: { 'content-type': 'text/event-stream' } });
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: () => ({}) as Animation });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  window.history.replaceState(null, '', '/');
});

const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const at = (url: string) => window.history.replaceState(null, '', url);
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
const where = () => window.location.pathname + window.location.search;
const rail = () => document.querySelector('.rail') as HTMLElement;

describe('App: chat history page', () => {
  it('the rail icon opens /history with the timeline; a second press returns to the wall at /', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(rail().querySelector('[aria-label="Chat history"]') as HTMLElement);
    expect(h1()).toBe('History.');
    expect(where()).toBe('/history');
    await waitFor(() => expect(document.querySelector('[data-msg="A001"]')).not.toBeNull());
    expect(screen.getByText(/2 messages in 1 threads\./)).toBeTruthy();
    expect(document.querySelector('.sticker')).toBeNull();
    fireEvent.click(rail().querySelector('[aria-label="Chat history"]') as HTMLElement);
    expect(h1()).toBe('Notes.');
    expect(where()).toBe('/');
    // The notes store survived the round trip.
    expect(screen.getByText('onboarding is long')).toBeTruthy();
  });

  it('loads straight into the page from /history?thread=ID', async () => {
    at('/history?thread=T-1');
    render(<App />);
    expect(h1()).toBe('History.');
    await waitFor(() => expect(document.querySelector('[data-msg="Q001"]')?.className).toContain('focus'));
    expect(where()).toBe('/history?thread=T-1');
  });

  it('back and forward switch between the wall and the history page', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    pop('/history');
    expect(h1()).toBe('History.');
    pop('/');
    expect(h1()).toBe('Notes.');
    pop('/history?thread=T-1');
    expect(h1()).toBe('History.');
  });

  it('a /?note= link reached with back from the history page still opens the wall on the note', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    pop('/history');
    expect(h1()).toBe('History.');
    pop('/?note=c-d45');
    await waitFor(() => expect(h1()).not.toBe('History.'));
    expect(where()).toBe('/?note=c-d45');
    expect(document.querySelector('[data-note="C-D45"]')).not.toBeNull();
  });

  it('the answer panel "Chat in full screen" opens the page on the current thread and hides the panel', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'what about seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    await waitFor(() => expect(document.querySelector('.answer-body')?.textContent).toContain('Seer is fine.'));
    fireEvent.click(screen.getByRole('button', { name: 'Chat in full screen' }));
    expect(h1()).toBe('History.');
    expect(where()).toBe('/history?thread=T-1');
    expect(document.querySelector('.answer')).toBeNull();
    // Back on the wall the conversation is still there.
    fireEvent.click(rail().querySelector('[aria-label="Chat history"]') as HTMLElement);
    expect(document.querySelector('.answer')).not.toBeNull();
  });

  it('switching to the bin and back to the wall never rewrites a /?note= URL', async () => {
    at('/?note=c-d45');
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(rail().querySelector('[aria-label="Recycle bin"]') as HTMLElement);
    expect(where()).toBe('/?note=c-d45');
    fireEvent.click(rail().querySelector('[aria-label="Back to the wall"]') as HTMLElement);
    expect(h1()).toBe('Notes.');
    expect(where()).toBe('/?note=c-d45');
  });

  it('the history page renders only its own page-variant composer and sends into a new optimistic bubble', async () => {
    at('/history');
    render(<App />);
    await waitFor(() => expect(document.querySelector('[data-msg="A001"]')).not.toBeNull());
    expect(document.querySelectorAll('form.chatbar')).toHaveLength(1);
    expect(document.querySelector('form.chatbar')?.getAttribute('data-chatbar')).toBe('page');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'and kitchen?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    expect(Array.from(document.querySelectorAll('.bubble.mine')).some((b) => b.textContent?.includes('and kitchen?'))).toBe(true);
    await waitFor(() => expect(calls).toContain('POST /api/chat'));
    expect((screen.getByLabelText('Ask about your notes') as HTMLTextAreaElement).value).toBe('');
  });
});
```
**Note:** the bin test uses Step 11's `BIN_TIP` labels (`Recycle bin` on the wall, `Back to the wall` in the bin). In the last test the fake server answers with the same ids (`Q001`/`A001`). After `done` and the refresh, the local bubbles are pruned against them. The test only asserts the optimistic bubble and the POST.

### Step 26: SPA fallback serves `/history`
**File:** `tests/unit/static.test.ts`. Append inside `describe('staticRoutes', …)` after the "falls back to index.html for client routes" test (`:46-50`):
```ts
  it('serves index.html for the chat history page and its thread deep link', async () => {
    const app = appFor(dist);
    for (const url of ['/history', '/history/', '/history?thread=T-1']) {
      const res = await app.request(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>index</title>');
    }
  });
```
`src/http/static.ts` needs no change: `/history` is not in `RESERVED_PREFIXES`, and no `history` file exists in `web/dist`.

### Step 27: Docs
**File:** `CHANGELOG.md`. Under `## [Unreleased]` → `### Added`, add the bullet below. Create `## [Unreleased]` (above `## [v0.1.0]`) only if it is missing, and `### Added` under it only if that is missing; earlier phases normally created both, and on merge there is exactly one of each:
```markdown
- **Chat history page** (`/history`): every wall chat and captured `/n` exchange on one timeline in Jakarta time, with thread dividers, a "claude code" badge, image thumbnails that open the lightbox, live updates, and a pill at the bottom to keep chatting (paste images there too). It opens from a new sidebar icon above the recycle bin and from a "Chat in full screen" button on the answer panel.
```
**File:** `README.md`. Insert before `## Connectors: spending, runs, Seer`:
```markdown
### The history page

Every wall chat and every `/n` exchange from Claude Code is kept. The chat-history icon above the
recycle bin (or the full-screen icon on the answer panel, which opens it on the conversation you
are in) shows them all on one page at `/history`: oldest at the top, a divider where a new
conversation starts, and a "claude code" badge on exchanges captured from the terminal. Every
bubble carries its time in Jakarta (UTC+7); hover it for the full timestamp. Pasted images show as
thumbnails; click one to view it large and use the arrow keys to move between that message's
images. Scroll up for older messages. New ones, including a `/n` you just ran in another window,
appear without a reload. The pill at the bottom works as on the wall and accepts pasted images. A
message continues the newest conversation when that one came from the wall, and starts a new one
otherwise. Back and forward move between the wall and this page.
```

## Verification

**Setup (Invariant 10):** `[ -d node_modules ] || npm ci`; `[ -e .env.local ] || ln -s ~/mcp-notes/.env.local .env.local`
**Build:** `npm run typecheck && npm run build`
**Tests:**
- `npx vitest run web/src/lib/chatTime.test.tsx web/src/lib/route.test.tsx web/src/lib/events.test.tsx web/src/lib/timeline.test.tsx web/src/hooks/useHistory.test.tsx web/src/pages/HistoryPage.test.tsx web/src/components/Rail.test.tsx web/src/components/AnswerPanel.test.tsx web/src/hooks/useChat.test.tsx web/src/App.history.test.tsx web/src/App.deeplink.test.tsx web/src/App.bin.test.tsx tests/unit/static.test.ts`
- then the full suite: `npm test` and `npm run test:int` (no server change, but invariant 1 requires both)

**Manual check** (`npm run build && npm start`, open http://localhost:7317):
1. The rail shows the chat icon directly above the trash. Clicking it sets the URL to `/history` and shows earlier wall chats. A pasted-image bubble shows a thumbnail. Clicking the thumbnail opens the lightbox, the arrow keys move between images, and Esc closes only the lightbox.
2. Ask on the wall, then press the full-screen icon. The URL becomes `/history?thread=…`, the thread is outlined, and the timestamps read in WIB.
3. Run `/n hello` in Claude Code (with Phase 8 installed). The exchange appears with the "claude code" badge without a reload.
4. Send from the history page's pill (it sits at the bottom of the page column). The question appears at once and the reply streams. Back goes to `/` and forward returns. On the answer panel, clicking a sent thumbnail opens the lightbox; Esc closes only the lightbox.
5. Open a `/?note=ID` link, press the recycle-bin icon twice: the URL still reads `/?note=ID`.
6. Exactly one `/api/events` request stays open in the network tab, both on the wall and on the history page.

**Exit criteria:** all of the above tests pass, and typecheck, build and the full unit and integration suites are green. Both a new wall exchange and a captured `/n` exchange appear on the open history page without a reload. Switching wall ↔ history (by icon, full-screen button, back/forward or a `/?note=` link) keeps the notes store loaded and does not refetch the notes page.

## Handoffs

- **Phase 10:** code against "Contract for Phases 10 and 11" above. `Bubble` is wrapped (not edited) for reply/edit/delete actions and the reply header (`msg.reply_to` is `ChatReplyPreview {id, role|null, text, deleted}`; `msg.edited_at` is typed but not shown here). The "show deleted" toggle passes `useHistory(view === 'history', { includeDeleted })` from App; `useHistory` already fetches with `include_deleted=1` and keeps rows on `op: 'deleted'` in that mode. `mutate`, `messages` and `loadOlder(): Promise<ChatMessage[]>` already exist. P10 adds: `replyTo` on `StreamChatRequest`, a trailing `replyTo?` on `HistoryStore.send`, the quote chip inside `HistoryPage`'s `HistoryComposer` (the composer is in `HistoryPage`, not App), a `pushUndo` prop on `HistoryPage`, and edit/delete/restore helpers in `chatHistoryApi.ts`. P7: `PATCH` returns the bare message, `DELETE` returns `{deleted: string[]}`, restore takes one id and is an idempotent 200 on a live row. `makeMessage` exists (`testing/chatFixtures.ts`); do not create it again.
- **Phase 11:** note-id link segments replace the paragraph block quoted in the contract (`Bubble`) and the same idiom in `AnswerPanel`'s `.answer-body` (this phase changes only `AnswerPanel`'s head buttons and `.answer-images` row, not the body map). The view→URL sync and its `/?note=` guard are owned here; P11 adds none. App keeps the notes store across the view switch, and App renders `NoteEditor`/`LinkNotice`/`AnswerPanel` at its root for every view (the panel is hidden on the history page).
- **Unowned follow-up:** `useBin.ts` still opens its own `EventSource`. Switching it to `subscribeEvents` would reach one connection in the bin view too. That is out of R3 scope and is noted here instead of done. `Bin.test.tsx` asserts that its `FakeES` closes on unmount, so the change must keep that test passing.
- **Unowned follow-up:** on the history page, pasting an image outside the pill still makes a new photo note and switches to the wall (`DropOverlay`, unchanged). The design is silent on this, so it is left as it is.

## Rollback

Revert this phase's commits. No server state, migrations or stored data are involved. The created files go away, and `types.ts`, `Rail.tsx`, `Sidebar.tsx`, `Header.tsx`, `AnswerPanel.tsx`, `useChat.ts`, `useNotes.ts`, `App.tsx`, the tests, `CHANGELOG.md` `ChatBar.css` and `README.md` return to their Phase 5/7 state. `View` loses `history`, so revert `types.ts` and `Rail.tsx` together. A browser left at `/history` after the rollback simply loads the wall: the SPA fallback serves `index.html`, and without the route logic the view starts as `wall`.
