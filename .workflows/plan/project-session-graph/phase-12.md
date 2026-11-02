# Phase 12: Per-project chat and project chat history

**Plan set:** `docs/plans/PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R7 (per-project chat: `project-pill-query-input`, `project` on chat threads, graph <-> `project-chat-history` toggle)
**Depends on:** Phase 11 (and through it 1, 7, 10)
**Difficulty:** NORMAL
**Package:** `src/chat`, `src/http`, `web/src/components/projectChat`

---

## Goal

A chat thread can belong to a project (a repo key). `POST /api/chat` accepts `project`, stores it on
`chat_threads.project`, never lets a thread change project, and tells the brain in a `<project>`
block to answer from that repo's Claude Code sessions with `sessions_search` / `session_get`.
`GET /api/chat/messages?project=` lists only that project's messages. On the wall's Projects page a
`project-pill-query-input` sits at the bottom of the graph, and an icon-only toggle in the project
header switches the body between the graph and `project-chat-history` (the history page scoped to
the project). Wall chat and `/history` behave exactly as before (project null, no filter).

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `src/chat/project.ts`: `PROJECT_KEY_MAX`, `isProjectKey(value)`, `projectKeySchema` (zod).
- `src/chat/context.ts`: `renderProjectBlock(project)`; `TurnContextInput.project?: string | null`; `<project>` added to the neutralized block tags.
- `src/chat/prompt.ts`: one new system-prompt paragraph explaining the `<project>` block.
- `ChatThreadView.project: string | null` (`src/chat/types.ts`) — new field on the wire of `GET /api/chat/threads/:id` (additive).
- `POST /api/chat` body field `project?: string` (repo key).
- `GET /api/chat/messages` query `project=<repo>` (absent: unchanged, every thread).
- `web/src/components/projectChat/ProjectPillQueryInput.tsx` (`ProjectPillQueryInput`, `projectPlaceholder`; testid `project-pill-query-input`).
- `web/src/components/projectChat/ProjectChatHistory.tsx` (`ProjectChatHistory`; testid `project-chat-history`).
- `web/src/components/projectChat/ProjectViewToggle.tsx` (`ProjectViewToggle`, `type ProjectView = 'graph' | 'chat'`; testid `project-view-toggle`).
- `web/src/components/projectChat/ProjectChat.tsx` (`ProjectChat`: owns the project's `useHistory` store).
- `web/src/components/projectChat/ProjectChat.css`.

**Signature changes (all additive, optional, defaults preserve today's behaviour):**
- `AddUserMessageInput.project?: string | null` (`src/chat/service.ts:33`).
- `ChatService.listTimeline(options)` gains `project?: string | null`.
- `ChatService.loadTurnContext(...)` now also returns `project` (from the thread row).
- `repo.InsertThread.project?: string | null`; `repo.listTimelineRows(ex, options)` gains `project?: string | null` (`src/chat/repo.ts:49,176`).
- `ChatBarProps.placeholder?: string` (default `'Ask about your notes'`, also used as aria-label).
- `HistoryPageProps.placeholder?: string` (passed to its composer's ChatBar).
- `HistoryOptions.project?: string | null` (`web/src/hooks/useHistory.ts:13`).
- `ChatPageQuery.project?: string | null`, `StreamChatRequest.project?: string` (`web/src/chatHistoryApi.ts`).

**Requires (from earlier phases):**
- Phase 1: `chatThreads` in `src/db/schema.ts` has `project: text('project')` (nullable, Drizzle property `project`, so `ChatThreadRow['project']` is `string | null`) and an index on it. This phase writes no migration.
- Phase 7 (as published): `sessions_search` (args `query`, optional `repo`, `limit`) and `session_get` (`node_id`) are registered MCP tools and in `allowedChatTools()` via `SESSION_TOOL_NAMES`.
- Phase 10 (as published): `web/src/pages/ProjectsPage.tsx` with props `repo: string | null` and `node: string | null` (the `?node=` id); its JSX is `<section className="proj">` > `<div className="proj-bar">` (the project header bar; holds `<div className="proj-tools">`) then `<div className="proj-body">` (`.proj-graph` + the `.proj-panel` aside). Phase 10's handoff reserves the graph <-> chat toggle for `.proj-bar`, left of `.proj-tools`, and the pill for after `.proj-body`.
- Phase 11 (as published): the `NodePanel` is the default of phase 10's `renderPanel` slot inside `.proj-body` (`{selectedNode !== null && <aside className="proj-panel">{panel(selectedNode, close)}</aside>}`).

**Leaves alone (owned by others):** graph layout and SVG renderer (`web/src/lib/sessionGraph.ts`, `web/src/components/graph/*`, Phase 10), `NodePanel` internals / Tree-Timeline (Phase 11), unfinished badge (Phase 13), `allowedChatTools` / session MCP tools (Phase 7), schema + migration (Phase 1), wall `useChat` / `AnswerPanel` / `postChat` (unchanged), `App.tsx` (unchanged), docs (Phase 14).

## Files

| File | Action | What changes |
|---|---|---|
| `src/chat/project.ts` | create | repo-key validation shared by both chat routes |
| `src/chat/repo.ts:49,58,176` | modify | `project` on thread insert; project filter in `listTimelineRows` |
| `src/chat/types.ts:40,100` | modify | `ChatThreadView.project`, `toThreadView` |
| `src/chat/service.ts:33,124,260,316` | modify | `project` through `addUserMessage`, `listTimeline`, `loadTurnContext` |
| `src/chat/context.ts:42,89,113` | modify | `TurnContextInput.project`, `<project>` block, tag neutralization |
| `src/chat/prompt.ts:34` | modify | new paragraph after the layout paragraph |
| `src/http/api.ts:50,316,343` | modify | `project` in `chatSchema` and into `addUserMessage` |
| `src/http/chatApi.ts:46,64` | modify | `?project=` on `GET /api/chat/messages` |
| `web/src/chatHistoryApi.ts:18,39,55,68` | modify | `project` query param and POST field |
| `web/src/hooks/useHistory.ts:13,84,112,195,280` | modify | `project` option carried into fetch and send |
| `web/src/components/ChatBar.tsx:48,62,165` | modify | optional `placeholder` |
| `web/src/pages/HistoryPage.tsx:25,50,93,127,236` | modify | optional `placeholder` passed to the composer |
| `web/src/components/projectChat/ProjectPillQueryInput.tsx` | create | the pill |
| `web/src/components/projectChat/ProjectChatHistory.tsx` | create | project-scoped history view |
| `web/src/components/projectChat/ProjectViewToggle.tsx` | create | icon-only header toggle |
| `web/src/components/projectChat/ProjectChat.tsx` | create | owns the project store, renders pill or history |
| `web/src/components/projectChat/ProjectChat.css` | create | pill / toggle styling |
| `web/src/pages/ProjectsPage.tsx` (after Phase 11) | modify | view state, toggle in `.proj-bar`, `.proj-body` wrapped, `ProjectChat` mounted |
| `web/src/components/graph/SessionGraph.css` | modify | `.graph-scroll` max height leaves room for the pill |
| `tests/unit/chat-project.test.ts` | create | key validation, `<project>` block, prompt paragraph |
| `tests/integration/chat.project.int.test.ts` | create | project threads, isolation, `?project=` filter + paging, validation |
| `web/src/components/projectChat/ProjectPillQueryInput.test.tsx` | create | jsdom: pill |
| `web/src/components/projectChat/ProjectChat.test.tsx` | create | jsdom: toggle, scoped fetch, send flips to history |

## Implementation Steps

### Step 1: Repo-key validation
**File:** `src/chat/project.ts` (new)
**Change:** One definition of what a project key may be, used by `POST /api/chat` and `GET /api/chat/messages`. The key is written into the model's `<project>` block, so control characters and angle brackets are refused (the block text is also neutralized in Step 5; this is the first line of defence).
**Code:**
```ts
import { z } from 'zod';

/**
 * Project scoping of chat threads (phase 12). A project is a repo key as resolved by the session
 * ingester (`cc_sessions.repo`, e.g. `mcp-notes`): a directory basename, so it is short and has no
 * line breaks. It is stored on `chat_threads.project` and written into the model's <project> block.
 */

/** Longest repo key a chat thread may carry. */
export const PROJECT_KEY_MAX = 200;

/** Non-empty, at most PROJECT_KEY_MAX characters, no control characters, no `<` or `>`. */
export function isProjectKey(value: string): boolean {
  if (value.length === 0 || value.length > PROJECT_KEY_MAX) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '<' || ch === '>') return false;
  }
  return true;
}

/** Trimmed, then `isProjectKey`. Shared by POST /api/chat (`project`) and GET /api/chat/messages (`?project=`). */
export const projectKeySchema = z.string().trim().refine(isProjectKey, { message: 'not a project key' });
```
**Impact:** none on its own.

### Step 2: Thread insert carries `project`; timeline filter
**File:** `src/chat/repo.ts:49` (`InsertThread`), `:58` (`insertThread`), `:176` (`listTimelineRows`)
**Change:** `project` is optional on insert (default null, so `createThread` and `recordExchange` are unchanged). The timeline accepts an optional project and keeps only messages whose thread has it; the subquery uses Phase 1's `chat_threads.project` index.
**Code:** replace `InsertThread` and `insertThread`:
```ts
export interface InsertThread {
  id: string;
  source: ChatSource;
  brain: string | null;
  externalKey: string | null;
  /** Repo key of a project-scoped thread (phase 12). Absent or null: not a project thread. */
  project?: string | null;
  createdAt: Date;
}

/** Null when the id or the external key is already taken. */
export async function insertThread(ex: Executor, values: InsertThread): Promise<ChatThreadRow | null> {
  const rows = await ex
    .insert(chatThreads)
    .values({
      id: values.id,
      source: values.source,
      brain: values.brain,
      externalKey: values.externalKey,
      project: values.project ?? null,
      createdAt: values.createdAt,
      updatedAt: values.createdAt,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}
```
Replace `listTimelineRows`:
```ts
/** Newest first, strictly older than `before` when given; only threads of `project` when given (phase 12). */
export async function listTimelineRows(
  ex: Executor,
  options: { before: TimelineCursor | null; limit: number; includeDeleted: boolean; project?: string | null },
): Promise<TimelineRow[]> {
  const conds: SQL[] = [];
  if (!options.includeDeleted) conds.push(isNull(chatMessages.deletedAt));
  if (options.project !== undefined && options.project !== null) {
    conds.push(
      sql`${chatMessages.threadId} in (select ${chatThreads.id} from ${chatThreads} where ${chatThreads.project} = ${options.project})`,
    );
  }
  if (options.before !== null) {
    conds.push(
      sql`(${chatMessages.createdAt}, ${chatMessages.seq}) < (${options.before.ts}::timestamptz, ${options.before.seq}::bigint)`,
    );
  }
  const rows = await ex
    .select({ ...getTableColumns(chatMessages), cursorTs: CURSOR_TS_SQL })
    .from(chatMessages)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.seq))
    .limit(options.limit);
  return rows.map(({ cursorTs, ...row }) => ({ row, cursorTs }));
}
```
**Impact:** none for existing callers (new fields optional). Imports unchanged (`sql`, `chatThreads` already imported).

### Step 3: `project` on the thread view
**File:** `src/chat/types.ts:40` (`ChatThreadView`), `:100` (`toThreadView`)
**Code:**
```ts
export interface ChatThreadView {
  id: string;
  source: ChatSource;
  brain: string | null;
  /** Repo key of a thread started from the Projects page (phase 12); null for wall chat and captures. */
  project: string | null;
  created_at: string;
  updated_at: string;
}
```
```ts
export function toThreadView(row: ChatThreadRow): ChatThreadView {
  return {
    id: row.id,
    source: row.source,
    brain: row.brain,
    project: row.project ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
```
**Impact:** `GET /api/chat/threads/:id` gains `thread.project`. No existing test pins the full thread object (checked: `capture.int.test.ts` reads `{id, source}` only).

### Step 4: `ChatService` carries `project`
**File:** `src/chat/service.ts:33` (`AddUserMessageInput`), `:124` (`addUserMessage`), `:260` (`listTimeline`), `:316` (`loadTurnContext`)
**Change:** A thread never changes project: continuing a thread whose project differs from the request (either direction, null included) starts a new thread, exactly like the existing source-mismatch rule. So a wall turn that names a project thread (e.g. the `/history` composer picking the newest wall-source thread, which may now be a project thread) starts a fresh null-project thread, and the wall's behaviour is unchanged.
**Code:** `AddUserMessageInput`:
```ts
export interface AddUserMessageInput {
  /** The thread to continue. Null, unknown, of another source or of another project: a new thread is created. */
  threadId: string | null;
  source: ChatSource;
  /** Trimmed by the caller. May be '' only when attachments are given. */
  text: string;
  attachments?: readonly AttachmentRef[];
  /** Canonical message id of a live message (any thread), or null. */
  replyTo?: string | null;
  /** Repo key from the Projects page (phase 12). Absent or null: wall chat. A thread never changes project. */
  project?: string | null;
  createdAt?: Date;
}
```
`addUserMessage`:
```ts
  /** Writes the user row (and its attachments) before anything else happens to the turn. */
  async addUserMessage(input: AddUserMessageInput): Promise<UserTurnStart> {
    const attachments = input.attachments ?? [];
    if (input.text === '' && attachments.length === 0) {
      throw new ChatError('empty_text', 'A chat message needs text or an image.');
    }
    const at = input.createdAt ?? this.now();
    const replyTo = input.replyTo ?? null;
    const project = input.project ?? null;
    const result = await this.db.transaction(async (tx) => {
      let thread: ChatThreadRow | null = input.threadId === null ? null : await repo.lockThread(tx, input.threadId);
      if (thread !== null && (thread.source !== input.source || (thread.project ?? null) !== project)) thread = null;
      let threadCreated = false;
      if (thread === null) {
        thread = await repo.insertThread(tx, {
          id: randomUUID(),
          source: input.source,
          brain: null,
          externalKey: null,
          project,
          createdAt: at,
        });
        if (thread === null) throw new ChatError('conflict', 'Could not create a chat thread.');
        threadCreated = true;
      }
      if (replyTo !== null) {
        const target = await repo.findMessage(tx, replyTo);
        if (target === null || target.deletedAt !== null) {
          throw new ChatError('reply_not_found', `No live chat message ${replyTo} to reply to.`);
        }
      }
      const message = await this.insertWithFreshId(tx, {
        threadId: thread.id,
        role: 'user',
        text: input.text,
        source: input.source,
        brain: null,
        replyTo,
        createdAt: at,
      });
      await repo.insertAttachments(tx, message.id, attachments);
      await repo.touchThread(tx, thread.id, at);
      const touched = await repo.findThread(tx, thread.id);
      return { thread: touched ?? thread, message, threadCreated };
    });
    this.events.emit('created', result.thread.id, result.message.id);
    const [view] = await this.viewsFor([result.message]);
    return { thread: toThreadView(result.thread), message: view as ChatMessageView, threadCreated: result.threadCreated };
  }
```
`listTimeline`:
```ts
  /**
   * One page of the unified timeline (every thread, every source), or of one project's threads when
   * `project` is given (phase 12). The page holds the newest `limit` messages older than `before`,
   * returned ascending; `next_before` fetches the page before it.
   */
  async listTimeline(
    options: { before?: string | null; limit?: number; includeDeleted?: boolean; project?: string | null } = {},
  ): Promise<ChatTimelinePage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_TIMELINE_LIMIT), 1), MAX_TIMELINE_LIMIT);
    let before: repo.TimelineCursor | null = null;
    if (options.before !== undefined && options.before !== null && options.before !== '') {
      before = repo.decodeTimelineCursor(options.before);
      if (before === null) throw new ChatError('invalid_cursor', 'Unknown timeline cursor.');
    }
    const rows = await repo.listTimelineRows(this.db, {
      before,
      limit: limit + 1,
      includeDeleted: options.includeDeleted ?? false,
      project: options.project ?? null,
    });
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    const next_before =
      rows.length > limit && oldest !== undefined
        ? repo.encodeTimelineCursor({ ts: oldest.cursorTs, seq: oldest.row.seq })
        : null;
    const messages = await this.viewsFor(page.map((entry) => entry.row).reverse());
    return { messages, next_before };
  }
```
`loadTurnContext`:
```ts
  /**
   * The rows behind one wall turn: the thread's live messages before `currentMessageId` (edited
   * text, deleted ones left out), the current message, its live reply target from any thread, and
   * the thread's project (phase 12; null for wall chat).
   */
  async loadTurnContext(threadId: string, currentMessageId: string): Promise<TurnContextInput> {
    const thread = await repo.findThread(this.db, threadId);
    const rows = await repo.listThreadMessages(this.db, threadId, false);
    const index = rows.findIndex((row) => row.id === currentMessageId);
    const current = rows[index];
    if (index < 0 || current === undefined) {
      throw new ChatError('not_found', `Chat message ${currentMessageId} is not a live message of thread ${threadId}.`);
    }
    const before = rows.slice(0, index);
    const target = current.replyTo === null ? null : await repo.findMessage(this.db, current.replyTo);
    const liveTarget = target !== null && target.deletedAt === null ? target : null;
    const attachments = await repo.attachmentsFor(
      this.db,
      [...before, current, ...(liveTarget !== null ? [liveTarget] : [])].map((row) => row.id),
    );
    const toContext = (row: ChatMessageRow) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      createdAt: row.createdAt,
      attachments: attachments.get(row.id) ?? [],
    });
    return {
      history: before.map(toContext),
      current: toContext(current),
      replyTarget: liveTarget !== null ? toContext(liveTarget) : null,
      project: thread?.project ?? null,
    };
  }
```
**Impact:** existing service tests unaffected (`project` absent = null on both sides; `ctx.history` / `ctx.replyTarget` assertions unchanged).

### Step 5: The `<project>` block in the turn context
**File:** `src/chat/context.ts:42` (`TurnContextInput`), `:89` (`BLOCK_TAG`), new `renderProjectBlock` after `neutralize`, `:113` (`buildTurnContext`); also update the layout doc comment at the top of the file.
**Change:** The brain is stateless per turn and both brains (Claude, GLM) receive the same `turn.text`, so the project goes into the turn text as the first block. A wall turn (project null) renders exactly as today — `chat.api.int.test.ts` asserts `turn.text` starts with `<chat_history>`, which still holds.
**Code:** layout doc comment, add after the `Layout (...)` line, before `<chat_history>`:
```ts
 *   <project>                       (phase 12: only for a thread started on the Projects page)
 *   repo: mcp-notes
 *   The owner is asking from the page of the repository "mcp-notes" ...
 *   </project>
 *
```
`TurnContextInput`:
```ts
export interface TurnContextInput {
  /** Live messages of the thread before the current one, ascending. */
  history: readonly ContextMessage[];
  /** The user message being answered now. */
  current: ContextMessage;
  /** The live message the current one replies to (any thread), or null. */
  replyTarget: ContextMessage | null;
  /** Repo key of a project-scoped thread (phase 12). Null or absent: wall chat, no <project> block. */
  project?: string | null;
  /** Default CONTEXT_CHAR_BUDGET. */
  budgetChars?: number;
}
```
`BLOCK_TAG`:
```ts
const BLOCK_TAG = /<(\/?)(chat_history|reply_to|message|project)>/gi;
```
New function, placed right after `neutralize`:
```ts
/**
 * Phase 12: the first block of a project-scoped turn. It names the repo and says how to reach its
 * sessions (phase 7's tools). The key is validated at the route; it is neutralized here as well.
 */
export function renderProjectBlock(project: string): string {
  const repo = neutralize(project);
  return [
    '<project>',
    `repo: ${repo}`,
    `The owner is asking from the page of the repository "${repo}" in the wall's Projects view. Their questions are about the Claude Code sessions run in that repository: find them with sessions_search restricted to repo "${repo}", read one with session_get before you describe it, and quote each session by its node id (like A0-3G).`,
    '</project>',
  ].join('\n');
}
```
`buildTurnContext`:
```ts
export function buildTurnContext(input: TurnContextInput): TurnContext {
  const budget = input.budgetChars ?? CONTEXT_CHAR_BUDGET;
  const lines = input.history.map((message) => renderMessageLine(message));
  const kept: string[] = [];
  const keptIds = new Set<string>();
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    const cost = line.length + 1;
    if (used + cost > budget) break;
    kept.unshift(line);
    keptIds.add((input.history[i] as ContextMessage).id);
    used += cost;
  }
  const omitted = lines.length - kept.length;

  const sections: string[] = [];
  const project = input.project ?? null;
  if (project !== null && project !== '') sections.push(renderProjectBlock(project));
  if (lines.length > 0) {
    sections.push(['<chat_history>', ...(omitted > 0 ? [OMITTED_LINE] : []), ...kept, '</chat_history>'].join('\n'));
  }
  const target = input.replyTarget;
  if (target !== null) {
    const body = keptIds.has(target.id)
      ? `The owner is replying to [msg:${target.id}] above.`
      : renderMessageLine(target);
    sections.push(['<reply_to>', body, '</reply_to>'].join('\n'));
  }
  sections.push(['<message>', renderMessageLine(input.current, null), '</message>'].join('\n'));

  const images: Array<{ id: string; messageId: string }> = [];
  const seen = new Set<string>();
  for (const image of [...chatImages(input.current), ...(target !== null ? chatImages(target) : [])]) {
    if (seen.has(image.id)) continue;
    seen.add(image.id);
    images.push(image);
  }
  return { text: sections.join('\n\n'), images, omitted };
}
```
**Impact:** `src/chat/turn.ts` needs no change: it passes `loadTurnContext`'s result (now with `project`) straight into `buildTurnContext`. The `<project>` block is not counted against the history budget (it is ~400 chars).

### Step 6: System prompt explains the block
**File:** `src/chat/prompt.ts:34`
**Change:** Insert one new array element directly after the `Every message from the owner reaches you in the same layout...` element (and before the `You may reply to one particular earlier message...` element).
**Code:**
```ts
    `A turn may start with a <project> block that names a repository (repo: mcp-notes). The owner is then chatting from that repository's page in the wall's Projects view, where each node of the graph is one Claude Code session they ran there, with a node id like A0-3G (two characters, a dash, two characters; a note id like A-B32 has a different shape). Read their questions as being about that repository's sessions unless they clearly ask about notes or their apps. Find sessions with sessions_search, passing that repository as repo, and read the ones you rely on with session_get before you describe them. Quote every session you rely on by its node id in the form A0-3G, and never invent one. Without a <project> block, use the session tools only when the owner asks about their Claude Code sessions.`,
```
**Impact:** existing `chat-prompt.test.ts` assertions all still match (nothing removed).

### Step 7: `POST /api/chat` accepts `project`
**File:** `src/http/api.ts:50` (`chatSchema`), `:316` (destructure), `:343` (`addUserMessage` call); add the import.
**Code:** import, next to the other `../chat/*` imports:
```ts
import { projectKeySchema } from '../chat/project.js';
```
`chatSchema`:
```ts
/** `message` may be empty only when images come with it (phase 3). */
const chatSchema = z
  .object({
    /** Defaults to '' (P3): an image-only message may omit it. */
    message: z.string().trim().default(''),
    thread_id: z.string().trim().min(1).max(200).optional(),
    reply_to: z.string().trim().min(1).max(32).optional(),
    /** Chat image ids from POST /api/chat/images, in paste order (phase 3). */
    image_ids: z.array(z.string().trim().min(1).max(16)).max(MAX_CHAT_IMAGES_PER_MESSAGE).default([]),
    /** Ids of pictures that already live in notes ("chat about this image"): referenced, never copied. */
    note_image_ids: z.array(z.string().trim().min(1).max(16)).max(MAX_CHAT_IMAGES_PER_MESSAGE).default([]),
    /** Repo key from the Projects page (phase 12). Absent: wall chat. A thread never changes project. */
    project: projectKeySchema.optional(),
  })
  .refine((body) => body.message.length > 0 || body.image_ids.length > 0 || body.note_image_ids.length > 0, {
    message: 'a message or at least one image is required',
    path: ['message'],
  })
  .refine((body) => body.image_ids.length + body.note_image_ids.length <= MAX_CHAT_IMAGES_PER_MESSAGE, {
    message: `at most ${MAX_CHAT_IMAGES_PER_MESSAGE} images per message`,
    path: ['note_image_ids'],
  });
```
Destructure (line 316):
```ts
    const { message, thread_id, reply_to, image_ids, note_image_ids, project } = parsed.data;
```
`addUserMessage` call (line 343):
```ts
      start = await history.addUserMessage({
        threadId: thread_id ?? null,
        source: 'wall',
        text: message,
        attachments: [
          ...currentImages.map((image) => ({ kind: 'chat_image' as const, id: image.id })),
          ...currentNoteImages.map((image) => ({ kind: 'note_image' as const, id: image.id })),
        ],
        replyTo,
        project: project ?? null,
      });
```
Also extend the route's doc comment (line ~305) with one sentence: `A \`project\` (repo key) scopes the thread to that project and puts a <project> block first in the prompt (phase 12).`
**Impact:** body without `project` behaves exactly as before. A bad key is a 400 before any row is written.

### Step 8: `GET /api/chat/messages?project=`
**File:** `src/http/chatApi.ts:46` (`timelineQuery`), `:64` (route); add the import.
**Code:** import:
```ts
import { projectKeySchema } from '../chat/project.js';
```
`timelineQuery`:
```ts
const timelineQuery = z.object({
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TIMELINE_LIMIT).default(DEFAULT_TIMELINE_LIMIT),
  include_deleted: flag,
  /** Phase 12: only threads of this project. Absent: every thread (the unified timeline, unchanged). */
  project: projectKeySchema.optional(),
});
```
Route:
```ts
  /**
   * The unified timeline: `{messages (ascending), next_before}`; follow next_before for older pages.
   * `?project=<repo>` keeps only that project's threads (phase 12's project chat history).
   */
  api.get('/api/chat/messages', async (c) => {
    const parsed = timelineQuery.safeParse({
      before: c.req.query('before'),
      limit: c.req.query('limit'),
      include_deleted: c.req.query('include_deleted'),
      project: c.req.query('project'),
    });
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    try {
      return c.json(
        await chat.listTimeline({
          before: parsed.data.before ?? null,
          limit: parsed.data.limit,
          includeDeleted: parsed.data.include_deleted,
          project: parsed.data.project ?? null,
        }),
      );
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });
```
**Impact:** `?project=` empty or with `<`/`>` is a 400. No `project` param: unchanged.

### Step 9: Web API client carries `project`
**File:** `web/src/chatHistoryApi.ts:18` (`ChatPageQuery`), `:39` (`fetchChatMessages`), `:55` (`StreamChatRequest`), `:68` (`streamChat`)
**Code:**
```ts
export interface ChatPageQuery {
  /** Opaque cursor from a previous page's `next_before`; absent = the latest page. */
  before?: string | null;
  limit?: number;
  /** Phase 10's "show deleted" toggle. */
  includeDeleted?: boolean;
  /** Project chat history (phase 12): only this repo's threads. Absent/null: every thread. */
  project?: string | null;
}
```
```ts
/** Phase 7: `GET /api/chat/messages?before&limit&include_deleted=1&project=` → one page of the timeline (ascending; the hook re-sorts anyway). */
export async function fetchChatMessages(q: ChatPageQuery = {}): Promise<ChatPage> {
  const p = new URLSearchParams();
  if (q.before) p.set('before', q.before);
  if (q.limit) p.set('limit', String(q.limit));
  if (q.includeDeleted) p.set('include_deleted', '1');
  if (q.project) p.set('project', q.project);
  const qs = p.toString();
  const res = await fetch(`/api/chat/messages${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { messages?: unknown; next_before?: unknown };
  const messages = Array.isArray(j.messages) ? (j.messages as ChatMessage[]).map(normalize) : [];
  const next = typeof j.next_before === 'string' && j.next_before !== '' ? j.next_before : null;
  return { messages, next_before: next };
}
```
```ts
export interface StreamChatRequest {
  message: string;
  /** Our thread id (phase 7, a UUID); absent (or unknown to the server) = a new thread. */
  threadId?: string;
  /** Phase 3 chat image ids, already uploaded. */
  imageIds?: string[];
  /** Ids of pictures that already live in notes ("chat about this image"): referenced, not uploaded. */
  noteImageIds?: string[];
  /** Phase 10: the bubble this message replies to (a 4-char message id), sent as `reply_to`. */
  replyTo?: string;
  /** Phase 12: the repo key of the Projects page this was asked from, sent as `project`. */
  project?: string;
  signal: AbortSignal;
}

/** `POST /api/chat` for the history composer; the caller reads the SSE body (lib/sse `readSSE`). */
export function streamChat(r: StreamChatRequest): Promise<Response> {
  const payload: {
    message: string;
    thread_id?: string;
    image_ids?: string[];
    note_image_ids?: string[];
    reply_to?: string;
    project?: string;
  } = { message: r.message };
  if (r.threadId) payload.thread_id = r.threadId;
  if (r.replyTo) payload.reply_to = r.replyTo;
  if (r.imageIds && r.imageIds.length > 0) payload.image_ids = r.imageIds;
  if (r.noteImageIds && r.noteImageIds.length > 0) payload.note_image_ids = r.noteImageIds;
  if (r.project) payload.project = r.project;
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: r.signal,
  });
}
```
**Impact:** without `project`, URLs and payloads are byte-identical to today (existing `useHistory.test.tsx` expectations hold).

### Step 10: `useHistory` takes a project
**File:** `web/src/hooks/useHistory.ts:13` (`HistoryOptions`), `:84` (refs), `:112` (latest load), `:195` (`loadOlder`), `:280` (send)
**Change:** The project is fixed for the life of a hook instance; the owner remounts the store per project (`ProjectChat` is keyed by repo, Step 14). It is read through a ref like `includeDeleted`.
**Code:** `HistoryOptions`:
```ts
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
```
Right after the existing two lines `const deletedRef = useRef(includeDeleted);` / `deletedRef.current = includeDeleted;` add:
```ts
  const projectRef = useRef<string | null>(options.project ?? null);
  projectRef.current = options.project ?? null;
```
Latest-page load (line 112), replace the fetch line with:
```ts
        const page = await fetchChatMessages({ limit: HISTORY_PAGE, includeDeleted: deletedRef.current, project: projectRef.current });
```
`loadOlder` (line 195), replace the fetch line with:
```ts
        const page = await fetchChatMessages({ before: cursor, limit: HISTORY_PAGE, includeDeleted: deletedRef.current, project: projectRef.current });
```
`send` (line 280), replace the `streamChat` line with:
```ts
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
```
**Impact:** App's `useHistory(view === 'history', { includeDeleted: true })` passes no project: unchanged.

### Step 11: ChatBar and HistoryPage take a placeholder
**File:** `web/src/components/ChatBar.tsx:48,62,165`
**Code:** add to `ChatBarProps` after `variant`:
```ts
  /** Placeholder and accessible name of the textarea. Default 'Ask about your notes'. */
  placeholder?: string;
```
Add above `const NO_IMAGES`:
```ts
export const CHAT_PLACEHOLDER = 'Ask about your notes';
```
Destructure `placeholder = CHAT_PLACEHOLDER,` after `variant = 'wall',`, and replace the textarea's two attributes:
```tsx
          placeholder={placeholder}
          aria-label={placeholder}
```
**File:** `web/src/pages/HistoryPage.tsx:25,50,93,127,236`
**Code:** `HistoryPageProps`, add after `seedImage`:
```ts
  /** The composer's placeholder (phase 12's project chat names the repo). Default: ChatBar's. */
  placeholder?: string;
```
`HistoryComposer` signature becomes:
```tsx
function HistoryComposer({
  store,
  replyTo,
  onCancelReply,
  seedImage = null,
  placeholder,
}: {
  store: HistoryStore;
  seedImage?: { imageId: string; nonce: number } | null;
  /** Phase 10: the bubble being replied to (the chip above the bar), or null. */
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  placeholder?: string;
}) {
```
Its `<ChatBar ... sendBlocked={images.blocked}` gains `placeholder={placeholder}` (ChatBar defaults when undefined). `HistoryPage` signature:
```tsx
export function HistoryPage({ store, focusThread, now, pushUndo = NO_UNDO, seedImage = null, placeholder }: HistoryPageProps) {
```
and line 236:
```tsx
      <HistoryComposer store={store} replyTo={ha.replyTo} onCancelReply={ha.cancelReply} seedImage={seedImage} placeholder={placeholder} />
```
**Impact:** none for existing callers (`'Ask about your notes'` stays the label every existing test queries).

### Step 12: The pill
**File:** `web/src/components/projectChat/ProjectPillQueryInput.tsx` (new)
**Code:**
```tsx
import { useState, type FormEvent } from 'react';
import { useChatImages } from '../../hooks/useChatImages';
import { ChatBar } from '../ChatBar';
import './ProjectChat.css';

/** Placeholder (and accessible name) of the project composer. */
export function projectPlaceholder(repo: string): string {
  return `Ask about ${repo}`;
}

export interface ProjectPillQueryInputProps {
  /** The selected repo key; named in the placeholder. */
  repo: string;
  /**
   * Sends one question in this project (the project store's `send`). False when refused (blank, or a
   * reply still streaming): the draft is kept.
   */
  onSend: (text: string, imageIds: string[], noteImageIds: string[]) => boolean;
}

/**
 * `project-pill-query-input`: the dark chat pill pinned to the bottom of the Projects page while the
 * graph is shown. Same ChatBar (page variant) and paste-an-image flow as the history composer, with
 * its own draft, so the wall bar's draft is untouched.
 */
export function ProjectPillQueryInput({ repo, onSend }: ProjectPillQueryInputProps) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (images.blocked) return;
    const ids = images.readyIds;
    const noteIds = images.noteIds;
    if (!draft.trim() && ids.length === 0 && noteIds.length === 0) return;
    if (onSend(draft, ids, noteIds)) {
      setDraft('');
      images.clear();
    }
  };
  return (
    <div className="project-pill-query-input" data-testid="project-pill-query-input" data-project={repo}>
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
        placeholder={projectPlaceholder(repo)}
      />
    </div>
  );
}
```

### Step 13: Project chat history and the toggle
**File:** `web/src/components/projectChat/ProjectChatHistory.tsx` (new)
**Code:**
```tsx
import type { HistoryStore } from '../../hooks/useHistory';
import type { UndoEntry } from '../../hooks/useUndo';
import { HistoryPage } from '../../pages/HistoryPage';
import { projectPlaceholder } from './ProjectPillQueryInput';
import './ProjectChat.css';

export interface ProjectChatHistoryProps {
  repo: string;
  /** A `useHistory` store created with `{ project: repo }`. */
  store: HistoryStore;
  now: Date;
  /** App's undo store, when the page has one; without it bubble deletes have no undo bar. */
  pushUndo?: (entry: UndoEntry) => void;
}

/**
 * `project-chat-history`: the history page (bubbles, edit/delete/restore, replies, its own composer)
 * fed by a store scoped to one project, so it lists only that project's threads.
 */
export function ProjectChatHistory({ repo, store, now, pushUndo }: ProjectChatHistoryProps) {
  return (
    <div className="project-chat-history" data-testid="project-chat-history" data-project={repo}>
      <HistoryPage store={store} focusThread={null} now={now} pushUndo={pushUndo} placeholder={projectPlaceholder(repo)} />
    </div>
  );
}
```
**File:** `web/src/components/projectChat/ProjectViewToggle.tsx` (new)
**Code:**
```tsx
import { ChatsCircle, Graph } from '@phosphor-icons/react';
import './ProjectChat.css';

/** What the Projects page body shows: the session graph or the project's chat history. */
export type ProjectView = 'graph' | 'chat';

export interface ProjectViewToggleProps {
  view: ProjectView;
  onToggle: (next: ProjectView) => void;
}

/** Icon-only header button: shows the icon of the view it switches to, named by its tooltip. */
export function ProjectViewToggle({ view, onToggle }: ProjectViewToggleProps) {
  const toChat = view === 'graph';
  const label = toChat ? 'Project chat history' : 'Session graph';
  return (
    <button
      type="button"
      className="project-view-toggle"
      data-testid="project-view-toggle"
      data-view={view}
      aria-label={label}
      data-tip={label}
      onClick={() => onToggle(toChat ? 'chat' : 'graph')}
    >
      {toChat ? <ChatsCircle weight="duotone" /> : <Graph weight="duotone" />}
    </button>
  );
}
```

### Step 14: `ProjectChat` owns the project store
**File:** `web/src/components/projectChat/ProjectChat.tsx` (new)
**Change:** One store per project for both surfaces, so a question asked in the pill streams into the history view the page flips to. The store fetches only while the history view is shown (`enabled = view === 'chat'`); in graph view it does no I/O until a question is sent. A pill question asked before the history was ever opened starts a new thread (the store has no timeline yet), like the wall bar after a dismiss; inside the history view the composer continues the newest project thread (`threadForSend`).
**Code:**
```tsx
import { useCallback } from 'react';
import { useHistory } from '../../hooks/useHistory';
import { useNow } from '../../hooks/useNow';
import type { UndoEntry } from '../../hooks/useUndo';
import { ProjectChatHistory } from './ProjectChatHistory';
import { ProjectPillQueryInput } from './ProjectPillQueryInput';
import type { ProjectView } from './ProjectViewToggle';

export interface ProjectChatProps {
  /** The selected repo key. Mount with `key={repo}`: the store is scoped to one project for its life. */
  repo: string;
  view: ProjectView;
  /** A question was sent from the pill: the page switches to the chat view to show the answer streaming. */
  onAsked: () => void;
  pushUndo?: (entry: UndoEntry) => void;
}

/** Graph view: the pill at the bottom. Chat view: the project's chat history (with its own composer). */
export function ProjectChat({ repo, view, onAsked, pushUndo }: ProjectChatProps) {
  const store = useHistory(view === 'chat', { project: repo, includeDeleted: true });
  const now = useNow();
  const { send } = store;
  const ask = useCallback(
    (text: string, imageIds: string[], noteImageIds: string[]): boolean => {
      const ok = noteImageIds.length > 0 ? send(text, imageIds, undefined, noteImageIds) : send(text, imageIds);
      if (ok) onAsked();
      return ok;
    },
    [send, onAsked],
  );
  if (view === 'chat') return <ProjectChatHistory repo={repo} store={store} now={now} pushUndo={pushUndo} />;
  return <ProjectPillQueryInput repo={repo} onSend={ask} />;
}
```
**File:** `web/src/components/projectChat/ProjectChat.css` (new)
**Code:**
```css
/* Phase 12: the project's chat. The pill is ChatBar's page variant (the wall's dark pill), pinned to
   the bottom of the Projects column instead of the wall's fixed position; it publishes no
   --chatbar-h. The toggle is a hairline circle like the rest of the wall's icon buttons. */
.project-pill-query-input { position: sticky; bottom: 16px; z-index: 41; max-width: 760px; margin: 24px auto 0; }
.project-pill-query-input .chatbar.chatbar-page { position: relative; left: auto; right: auto; bottom: auto; width: 100%; }
.project-chat-history { min-width: 0; }
.project-view-toggle { width: 32px; height: 32px; flex-shrink: 0; display: grid; place-items: center; padding: 0; border: 1px solid var(--line-25); border-radius: 999px; background: transparent; color: var(--fg); font-size: 17px; cursor: pointer; }
.project-view-toggle:hover { background: var(--fg); color: var(--bg); }
.project-view-toggle:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; }
```

### Step 15: Mount in `ProjectsPage`
**File:** `web/src/pages/ProjectsPage.tsx` as left by Phase 11 (Phase 10 Step 12 + Phase 11 Step 8).
**Change:** Four insertions, bound to Phase 10/11's names: the props `repo` and `node`, the header
bar `.proj-bar`, and the body `.proj-body` (graph + panel). Nothing inside the graph or `NodePanel`
changes; `.proj-body` is only wrapped in a `view === 'graph'` condition.

1. Imports (`useCallback`, `useEffect`, `useState` are already in Phase 10's `react` import):
```tsx
import { ProjectChat } from '../components/projectChat/ProjectChat';
import { ProjectViewToggle, type ProjectView } from '../components/projectChat/ProjectViewToggle';
```
2. State, at the top of the `ProjectsPage` body (after `const graph = useSessionGraph(repo);`):
```tsx
  const [view, setView] = useState<ProjectView>('graph');
  const showChat = useCallback(() => setView('chat'), []);
  // Opening a node (click or ?node= deep link) always shows the graph it lives in.
  useEffect(() => {
    if (node !== null) setView('graph');
  }, [node]);
```
3. In `.proj-bar`, before `<div className="proj-tools">` (so the toggle sits left of the expand/collapse tools):
```tsx
        {repo !== null && <ProjectViewToggle view={view} onToggle={setView} />}
```
and, so the graph-only tools do not show over the chat history, render `.proj-tools` only in graph view:
`{view === 'graph' && <div className="proj-tools">…phase 10's two buttons, unchanged…</div>}`.
4. Wrap Phase 10's `.proj-body` element in the view condition and mount the chat right after it,
still inside `<section className="proj">`:
```tsx
      {view === 'graph' && (
        <div className="proj-body">
          <div className="proj-graph">{content}</div>
          {selectedNode !== null && <aside className="proj-panel">{panel(selectedNode, close)}</aside>}
        </div>
      )}
      {repo !== null && <ProjectChat key={repo} repo={repo} view={view} onAsked={showChat} />}
```
(`ProjectsPage` receives no `pushUndo`, so `ProjectChat` is mounted without it.) In
`SessionGraph.css`, replace Phase 10's
`.graph-scroll { position: relative; height: max(360px, calc(100vh - 140px)); ... }` height with
`height: max(360px, calc(100vh - 196px));` (the 56 px pill row; Phase 10 handoff).
**Impact:** Phase 10/11 tests keep passing: in graph view the chat adds only the pill (no fetch: the store is disabled), and the graph/panel render exactly as before.

### Step 16: Tests

**File:** `tests/unit/chat-project.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { buildTurnContext, renderProjectBlock, type ContextMessage } from '../../src/chat/context.js';
import { PROJECT_KEY_MAX, isProjectKey, projectKeySchema } from '../../src/chat/project.js';
import { buildChatSystemPrompt } from '../../src/chat/prompt.js';

const msg = (id: string, text: string, iso: string): ContextMessage => ({
  id,
  role: 'user',
  text,
  createdAt: new Date(iso),
  attachments: [],
});

describe('project keys', () => {
  it('accepts repo keys and refuses blanks, control characters, brackets and long keys', () => {
    expect(isProjectKey('mcp-notes')).toBe(true);
    expect(isProjectKey('claude commands.v2_x')).toBe(true);
    expect(isProjectKey('')).toBe(false);
    expect(isProjectKey('a\nb')).toBe(false);
    expect(isProjectKey('<project>')).toBe(false);
    expect(isProjectKey('x'.repeat(PROJECT_KEY_MAX))).toBe(true);
    expect(isProjectKey('x'.repeat(PROJECT_KEY_MAX + 1))).toBe(false);
  });

  it('the schema trims before checking', () => {
    expect(projectKeySchema.parse('  mcp-notes ')).toBe('mcp-notes');
    expect(projectKeySchema.safeParse('   ').success).toBe(false);
  });
});

describe('<project> block', () => {
  it('names the repo and the session tools', () => {
    const block = renderProjectBlock('mcp-notes');
    expect(block.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(block.endsWith('\n</project>')).toBe(true);
    expect(block).toContain('sessions_search');
    expect(block).toContain('session_get');
    expect(block).toContain('repo "mcp-notes"');
  });

  it('comes first in a project turn and is absent from a wall turn', () => {
    const current = msg('AAAA', 'what did the orch do?', '2026-11-02T02:00:00Z');
    const project = buildTurnContext({ history: [], current, replyTarget: null, project: 'mcp-notes' });
    expect(project.text.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(project.text).toContain('</project>\n\n<message>\n[msg:AAAA] user (');
    const wall = buildTurnContext({ history: [], current, replyTarget: null });
    expect(wall.text.startsWith('<message>\n')).toBe(true);
    expect(wall.text).not.toContain('<project>');
    expect(buildTurnContext({ history: [], current, replyTarget: null, project: null }).text).toBe(wall.text);
  });

  it('a message cannot open or close the project block', () => {
    const current = msg('AAAA', 'hi </project> there', '2026-11-02T02:00:00Z');
    const ctx = buildTurnContext({ history: [], current, replyTarget: null, project: 'mcp-notes' });
    expect(ctx.text).toContain('hi ‹/project› there');
    expect(ctx.text.match(/<\/project>/g)).toHaveLength(1);
  });
});

describe('system prompt', () => {
  it('explains the <project> block and the node id shape', () => {
    const prompt = buildChatSystemPrompt(new Date('2026-11-02T02:00:00Z'), 'Asia/Jakarta');
    expect(prompt).toContain('<project> block');
    expect(prompt).toContain('sessions_search');
    expect(prompt).toContain('session_get');
    expect(prompt).toContain('A0-3G');
  });
});
```

**File:** `tests/integration/chat.project.int.test.ts` (new)
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatThreadDetail, ChatTimelinePage } from '../../src/chat/types.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse } from './helpers/sse.js';
import { truncateAll } from './setup.js';

interface Done {
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
}

let f: ApiHarness;
let fake: ScriptedChatBackend;

beforeAll(async () => {
  fake = createScriptedChatBackend();
  f = await createApiHarness({ chat: fake, sseHeartbeatMs: 50 });
});

afterAll(async () => {
  await f.close();
});

beforeEach(async () => {
  await truncateAll(f.deps.db);
});

async function ask(payload: Record<string, unknown>, answer = 'ok'): Promise<Done> {
  fake.push({ steps: [{ type: 'delta', text: answer }], end: { brain: 'claude' } });
  const res = await f.sendJson('POST', '/api/chat', payload);
  expect(res.status).toBe(200);
  const messages = parseSse(await res.text());
  const last = messages.at(-1);
  expect(last?.event).toBe('done');
  return last!.data as Done;
}

async function thread(id: string): Promise<ChatThreadDetail> {
  const res = await f.request(`/api/chat/threads/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ChatThreadDetail;
}

async function timeline(query: string): Promise<ChatTimelinePage> {
  const res = await f.request(`/api/chat/messages${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ChatTimelinePage;
}

describe('POST /api/chat with a project', () => {
  it('creates a project thread, continues it, and tells the brain the project', async () => {
    const d1 = await ask({ message: 'what did the orch do?', project: 'mcp-notes' }, 'It landed p3.');
    expect((await thread(d1.thread_id)).thread.project).toBe('mcp-notes');
    const first = fake.requests.at(-1)!.turn.text;
    expect(first.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(first).toContain('sessions_search');

    const d2 = await ask({ message: 'and p4?', thread_id: d1.thread_id, project: 'mcp-notes' });
    expect(d2.thread_id).toBe(d1.thread_id);
    const second = fake.requests.at(-1)!.turn.text;
    expect(second.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(second).toContain('): It landed p3.');
  });

  it('leaves wall chat alone: no project, no block', async () => {
    const d = await ask({ message: 'what did I save?' });
    expect((await thread(d.thread_id)).thread.project).toBeNull();
    expect(fake.requests.at(-1)!.turn.text).not.toContain('<project>');
  });

  it('never moves a thread to another project', async () => {
    const p = await ask({ message: 'p', project: 'mcp-notes' });
    const other = await ask({ message: 'q', thread_id: p.thread_id, project: 'seer' });
    expect(other.thread_id).not.toBe(p.thread_id);
    expect((await thread(other.thread_id)).thread.project).toBe('seer');

    const wallFromProject = await ask({ message: 'r', thread_id: p.thread_id });
    expect(wallFromProject.thread_id).not.toBe(p.thread_id);
    expect((await thread(wallFromProject.thread_id)).thread.project).toBeNull();

    const projectFromWall = await ask({ message: 's', thread_id: wallFromProject.thread_id, project: 'mcp-notes' });
    expect(projectFromWall.thread_id).not.toBe(wallFromProject.thread_id);
    expect((await thread(projectFromWall.thread_id)).thread.project).toBe('mcp-notes');
  });

  it('refuses a bad project key before writing anything', async () => {
    for (const project of ['', '   ', '<x>', 'a\nb', 'x'.repeat(201)]) {
      const res = await f.sendJson('POST', '/api/chat', { message: 'hi', project });
      expect(res.status).toBe(400);
    }
    expect((await timeline('?include_deleted=1')).messages).toEqual([]);
  });
});

describe('GET /api/chat/messages?project=', () => {
  it("lists only that project's threads, pages inside the project, and leaves the unfiltered timeline whole", async () => {
    await ask({ message: 'w1' }, 'wa1');
    const p1 = await ask({ message: 'p1', project: 'mcp-notes' }, 'pa1');
    await ask({ message: 's1', project: 'seer' }, 'sa1');
    await ask({ message: 'p2', thread_id: p1.thread_id, project: 'mcp-notes' }, 'pa2');
    await ask({ message: 'w2' }, 'wa2');

    const all = await timeline('?project=mcp-notes');
    expect(all.messages.map((m) => m.text)).toEqual(['p1', 'pa1', 'p2', 'pa2']);
    expect(new Set(all.messages.map((m) => m.thread_id))).toEqual(new Set([p1.thread_id]));
    expect(all.next_before).toBeNull();

    const page1 = await timeline('?project=mcp-notes&limit=2');
    expect(page1.messages.map((m) => m.text)).toEqual(['p2', 'pa2']);
    expect(page1.next_before).not.toBeNull();
    const page2 = await timeline(`?project=mcp-notes&limit=2&before=${encodeURIComponent(page1.next_before!)}`);
    expect(page2.messages.map((m) => m.text)).toEqual(['p1', 'pa1']);
    expect(page2.next_before).toBeNull();

    expect((await timeline('?project=seer')).messages.map((m) => m.text)).toEqual(['s1', 'sa1']);
    expect((await timeline('?project=nothing-here')).messages).toEqual([]);
    expect((await timeline('')).messages.map((m) => m.text)).toEqual(['w1', 'wa1', 'p1', 'pa1', 's1', 'sa1', 'p2', 'pa2', 'w2', 'wa2']);
  });

  it('refuses a bad project filter', async () => {
    for (const q of ['?project=', '?project=%3Cx%3E', '?project=a%0Ab']) {
      expect((await f.request(`/api/chat/messages${q}`)).status).toBe(400);
    }
  });
});
```

**File:** `web/src/components/projectChat/ProjectPillQueryInput.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectPillQueryInput } from './ProjectPillQueryInput';

afterEach(() => {
  cleanup();
});

function textarea(): HTMLTextAreaElement {
  const el = screen.getByLabelText('Ask about mcp-notes');
  if (!(el instanceof HTMLTextAreaElement)) throw new Error('pill is not a textarea');
  return el;
}

describe('ProjectPillQueryInput', () => {
  it('renders the pill under its test id, named after the repo', () => {
    render(<ProjectPillQueryInput repo="mcp-notes" onSend={vi.fn(() => true)} />);
    const pill = screen.getByTestId('project-pill-query-input');
    expect(pill.getAttribute('data-project')).toBe('mcp-notes');
    expect(textarea().placeholder).toBe('Ask about mcp-notes');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('Enter sends the draft and clears it', () => {
    const onSend = vi.fn(() => true);
    render(<ProjectPillQueryInput repo="mcp-notes" onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: 'what did the orch do?' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('what did the orch do?', [], []);
    expect(textarea().value).toBe('');
  });

  it('keeps the draft when the send is refused, and never sends a blank', () => {
    const onSend = vi.fn(() => false);
    render(<ProjectPillQueryInput repo="mcp-notes" onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: '   ' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(textarea(), { target: { value: 'again' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('again');
  });
});
```
Note for the implementer: if jsdom's `HTMLFormElement.requestSubmit` is missing in this repo's jsdom version, switch the two Enter presses to `fireEvent.submit(textarea().closest('form')!)`; `ChatBar.test.tsx` shows which one the repo uses.

**File:** `web/src/components/projectChat/ProjectChat.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { ChatPage } from '../../types';
import { makeMessage } from '../../testing/chatFixtures';
import { ProjectChat } from './ProjectChat';
import { ProjectViewToggle, type ProjectView } from './ProjectViewToggle';

const sse = (frames: Array<{ event: string; data: unknown }>): string =>
  frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

let latest: ChatPage;
let gets: URL[];
let posted: Array<Record<string, unknown>>;

beforeEach(() => {
  latest = { messages: [], next_before: null };
  gets = [];
  posted = [];
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.startsWith('/api/chat/messages')) {
        gets.push(new URL(url, 'http://x'));
        return json(latest);
      }
      if (method === 'POST' && url === '/api/chat') {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          sse([
            { event: 'accepted', data: { thread_id: 'T-P', user_message_id: 'Q100' } },
            { event: 'delta', data: { text: 'It landed p3.' } },
            { event: 'done', data: { thread_id: 'T-P', user_message_id: 'Q100', assistant_message_id: 'A100', reply_to: null } },
          ]),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

/** Stands in for ProjectsPage: the header toggle, the graph, and the project chat. */
function Page({ repo }: { repo: string }) {
  const [view, setView] = useState<ProjectView>('graph');
  return (
    <div>
      <header>
        <ProjectViewToggle view={view} onToggle={setView} />
      </header>
      {view === 'graph' && <div data-testid="graph" />}
      <ProjectChat key={repo} repo={repo} view={view} onAsked={() => setView('chat')} />
    </div>
  );
}

describe('ProjectViewToggle + ProjectChat', () => {
  it('starts on the graph with the pill and fetches nothing', () => {
    render(<Page repo="mcp-notes" />);
    expect(screen.getByTestId('graph')).toBeTruthy();
    expect(screen.getByTestId('project-pill-query-input')).toBeTruthy();
    expect(screen.queryByTestId('project-chat-history')).toBeNull();
    const toggle = screen.getByTestId('project-view-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Project chat history');
    expect(toggle.textContent).toBe('');
    expect(gets).toEqual([]);
  });

  it("toggles to the project's chat history, scoped by ?project=, and back", async () => {
    latest = { messages: [makeMessage('Q001', { thread_id: 'T1', text: 'earlier project question' })], next_before: null };
    render(<Page repo="mcp-notes" />);
    fireEvent.click(screen.getByTestId('project-view-toggle'));
    expect(screen.getByTestId('project-chat-history')).toBeTruthy();
    expect(screen.queryByTestId('graph')).toBeNull();
    expect(screen.queryByTestId('project-pill-query-input')).toBeNull();
    expect(screen.getByLabelText('Ask about mcp-notes')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('earlier project question')).toBeTruthy());
    expect(gets.length).toBeGreaterThan(0);
    for (const u of gets) expect(u.searchParams.get('project')).toBe('mcp-notes');
    expect(screen.getByTestId('project-view-toggle').getAttribute('aria-label')).toBe('Session graph');

    fireEvent.click(screen.getByTestId('project-view-toggle'));
    expect(screen.getByTestId('graph')).toBeTruthy();
    expect(screen.getByTestId('project-pill-query-input')).toBeTruthy();
  });

  it('a question in the pill is sent with the project and opens the history with the answer', async () => {
    render(<Page repo="mcp-notes" />);
    const pill = screen.getByLabelText('Ask about mcp-notes');
    fireEvent.change(pill, { target: { value: 'what did the orch do?' } });
    fireEvent.keyDown(pill, { key: 'Enter' });
    expect(screen.getByTestId('project-chat-history')).toBeTruthy();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ message: 'what did the orch do?', project: 'mcp-notes' });
    await waitFor(() => expect(screen.getByText('It landed p3.')).toBeTruthy());
  });
});
```
Note: `makeMessage` (web/src/testing/chatFixtures.ts) defaults are a wall user message; if its default `thread_id` or `source` differs, the assertions above do not depend on them.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:**
- `npx vitest run tests/unit/chat-project.test.ts tests/unit/chat-context.test.ts tests/unit/chat-prompt.test.ts`
- `npx vitest run web/src/components/projectChat web/src/hooks/useHistory.test.tsx web/src/pages/HistoryPage.test.tsx web/src/components/ChatBar.test.tsx`
- `npm test`
- `npm run test:int` (includes `tests/integration/chat.project.int.test.ts`, `chat.api.int.test.ts`, `chat.service.int.test.ts`)

**Manual check:** `npm run dev` + `npm run dev:web`, open `/projects`, pick `mcp-notes`: the pill shows "Ask about mcp-notes" at the bottom; ask "what did the last orch session do?" — the page flips to the chat view, the answer streams and quotes node ids. Toggle back to the graph and again to chat: only `mcp-notes` threads are listed. `/history` and the wall bar behave as before (the project thread also appears in `/history`, which is the unfiltered timeline).
**Exit criteria:** threads created from the project view carry `project` (`GET /api/chat/threads/:id` shows it); `GET /api/chat/messages?project=X` lists only X's threads and pages correctly; the brain's turn text starts with `<project>` only for project threads; the Projects page shows `project-pill-query-input` under the graph and the header toggle switches graph <-> `project-chat-history`; all suites green.

## Handoffs

- **Phase 14 (docs, R7):** README HTTP API table: `POST /api/chat` field `project`, `GET /api/chat/messages?project=`, `thread.project` on `GET /api/chat/threads/:id`; CHANGELOG line for per-project chat.
- **Phase 13:** edits `ProjectsPage.tsx` after this phase. The graph + `NodePanel` now sit inside `{view === 'graph' && (...)}`; the badge belongs inside the graph and needs no awareness of the toggle.
- **Phase 7 (already landed, check only):** the chat brain can reach `sessions_search` / `session_get` only if they are in `allowedChatTools()`; this phase only instructs the brain to use them. If `sessions_search` has no `repo` argument, the reconciler should either have Phase 7 add one or soften the wording in `renderProjectBlock` / the prompt paragraph (text-only change here).
- **Not done, no owner (follow-up card if wanted):** `/history` thread dividers do not label project threads ("wall chat" is shown for them); App's `pushUndo` is not wired into the project chat unless `ProjectsPage` already receives it, so a bubble delete there has no undo bar.

## Rollback

Revert this phase's commit. No migration is involved (the `chat_threads.project` column belongs to
Phase 1 and stays, holding null for every thread written before or after the revert). Rows already
written with a project remain valid and simply show up in the unfiltered `/history` like any thread.
