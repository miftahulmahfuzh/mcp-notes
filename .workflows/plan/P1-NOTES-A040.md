> Adopted from `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` phase 7. Source: `.workflows/plan/chat-history-files-image-search/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: Chat persistence: schema, context rebuild, reply_to, edit/delete API

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R3 (the backend half: the wall chat is persisted in our own DB, context is rebuilt from our rows, `reply_to`, edit/delete/restore and the history API that P8-P11 build on)
**Depends on:** Phase 3 (chat images, `image_ids`, `composeUserTurn`, migration 0003), Phase 6 (migration 0005; this phase's migration is 0006)
**Difficulty:** HARD
**Package:** `src/chat`, `src/http`, `src/db`

---

## Goal

Our database becomes the source of truth for the wall chat. Every `POST /api/chat` writes the
user row first and the assistant row on a clean finish. Each turn's model prompt is rebuilt from
our rows: the thread's live messages with their edited text, plus any `reply_to` target, even
from another thread. The Agent SDK no longer resumes or persists sessions, so `claude` and the
`glm` fallback get the same composed prompt. Messages carry 4-character ids shown as
`[msg:K7F2]`. An answer that starts with `[msg:ID]` becomes a reply to that bubble. A history API
(timeline, thread, edit, delete, restore) and an `event: chat` on `/api/events` are ready for the
history UI (P9-P11) and for the Claude Code capture (P8).

## Interface Contract

**Deletes:**
- `ChatRequest.message`, `ChatRequest.threadId` and P3's `ChatRequest.images` (`src/chat/backend.ts`). Replaced by `ChatRequest.turn: ComposedTurn` (whose `images` are P3's `ChatTurnImage`s). Every reader is updated here: `src/chat/agent.ts` (`userTurn`, `attempt`), `src/chat/stub.ts`, `src/http/api.ts`, `tests/integration/helpers/scripted-chat.ts`, `tests/unit/chat-agent.test.ts`, `tests/unit/chat-stub.test.ts`, `tests/live/chat.live.test.ts`, and P3's `tests/integration/chat.images.int.test.ts`.
- `ChatTurnEnd.threadId` (`src/chat/backend.ts:19`). The SDK session id is no longer surfaced.
- `resume` in `optionsFor` (`src/chat/agent.ts:304`) and the `resume` parameter of `RunDeps.optionsFor` (`agent.ts:112`).
- `chatEventName` (`src/http/api.ts:90`). The chat route now writes events inline.
- The stub's `stub-<uuid>` thread ids (`src/chat/stub.ts:51`).

**Renames:** none. Inside `apiRoutes` the local `chat` (the backend) becomes `backend`, because `deps.chat` is now the `ChatService`.

**Creates:**
- Tables (migration `drizzle/0006_chat_history.sql`): `chat_threads`, `chat_messages`, `chat_message_revisions`, `chat_message_attachments`. Drizzle symbols `chatThreads`, `chatMessages`, `chatMessageRevisions`, `chatMessageAttachments`, constants `CHAT_SOURCES`, `CHAT_ROLES`, `CHAT_ATTACHMENT_KINDS`, types `ChatSource`, `ChatRole`, `ChatAttachmentKind`, `ChatThreadRow`, `ChatMessageRow`, `ChatMessageRevisionRow`, `ChatMessageAttachmentRow` (`src/db/schema.ts`).
- `src/chat/ids.ts`: `MESSAGE_ID_PATTERN`, `generateMessageId`, `isMessageId`, `normalizeMessageId`, `messageLabel`.
- `src/chat/events.ts`: `ChatEvents`, `ChatChange`, `ChatOp`.
- `src/chat/types.ts`: `AttachmentRef`, `ChatAttachmentView`, `ChatReplyPreview`, `ChatMessageView`, `ChatThreadView`, `ChatThreadDetail`, `ChatTimelinePage`, `ChatError`, `ChatErrorCode`, `REPLY_SNIPPET_CHARS`, `snippet`, `attachmentView`, `toThreadView`, `toMessageView`.
- `src/chat/repo.ts`: SQL helpers and `encodeTimelineCursor`/`decodeTimelineCursor`.
- `src/chat/service.ts`: `ChatService` (`createThread`, `addUserMessage`, `addAssistantMessage`, `editMessage`, `deleteMessage`, `restoreMessage`, `listTimeline`, `getThread`, `getMessage`, `listRevisions`, `loadTurnContext`, `liveMessageExists`, `recordExchange` (the idempotent `external_key` helper for P8), `requireMessageId`), plus `DEFAULT_TIMELINE_LIMIT`, `MAX_TIMELINE_LIMIT`, `UserTurnStart`, `RecordExchangeInput`, `RecordedExchange`.
- `src/chat/context.ts` (pure): `buildTurnContext`, `renderMessageLine`, `formatWib`, `attachmentLabel`, `CONTEXT_CHAR_BUDGET`, `CONTEXT_LINE_CHAR_CAP`, `OMITTED_LINE`, `CHAT_TIME_ZONE`, `ContextMessage`, `TurnContextInput`, `TurnContext`.
- `src/chat/citation.ts`: `CitationFilter`, `parseLeadingCitation`, `CITATION_LOOKAHEAD`.
- `src/chat/turn.ts`: `composeWallTurn`.
- `src/chat/backend.ts`: `ComposedTurn`.
- `src/chat/compose.ts` (P3's file): `imageLabel`, `composeLabelledText`.
- `src/http/chatApi.ts`: `chatHistoryRoutes`, `chatErrorResponse`. (Chat image lookup errors on `POST /api/chat` keep P3's `chatImageErrorStatus` in `src/http/api.ts`: 400 `unknown_image`, 409 `not_on_this_machine`, 422 `unreadable_image`, body `{error, id, message}`.)
- `AppDeps.chat: ChatService` (`src/deps.ts`).
- HTTP: `GET /api/chat/messages`, `GET /api/chat/threads/:id`, `PATCH /api/chat/messages/:id`, `DELETE /api/chat/messages/:id`, `POST /api/chat/messages/:id/restore`. SSE `event: accepted` on `POST /api/chat`; `event: chat {op, thread_id, id}` on `GET /api/events`.
- Test helpers: `ApiHarness.chat`, `ApiHarness.deps`, `SAME_ORIGIN`, a 4th `headers` argument on `ApiHarness.sendJson`.

**Signature changes:**
- `interface ChatRequest { message; threadId; signal }` (plus P3's image field) -> `interface ChatRequest { turn: ComposedTurn; signal: AbortSignal }`.
- `interface ChatTurnEnd { threadId: string; brain?: ChatBrain }` -> `interface ChatTurnEnd { brain?: ChatBrain }`.
- `RunDeps.optionsFor(brain, resume, abortController)` -> `optionsFor(brain, abortController)`.
- `ChatScript.end` default `{ threadId: request.threadId ?? 'fake-thread' }` -> `{}` (`tests/integration/helpers/scripted-chat.ts`).
- P3's `ChatTurnImage` (`src/chat/backend.ts`) gains an optional `messageId?: string`; P3's `ComposeInput.images` (`src/chat/compose.ts`) accepts it, and `composeUserTurn` then writes the image labels as `[image upload:ID] from [msg:ID]` (`composeLabelledText`). Without `messageId` the output is byte-identical to P3's. This extends P3's compose.ts; it does not fork it.
- `POST /api/chat` body: `{message, thread_id?, image_ids?}` -> `{message, thread_id?, reply_to?, image_ids?}`. SSE `done` changes from `{thread_id, brain?}` to `{thread_id, user_message_id, assistant_message_id, reply_to, brain?}`, and `thread_id` is now OUR thread id.
- `export` added to `describeIssues` and `readJson` in `src/http/api.ts`. They stay where they are.

**Requires (from earlier phases):**
- Phase 3 (exact names, from `phase-3.md`):
  - `src/chat/backend.ts`: `interface ChatTurnImage { id; previewPath; previewMime: 'image/jpeg'; width; height; originalName }` and `ChatRequest.images: readonly ChatTurnImage[]` (replaced here).
  - `src/chat/images.ts`: `ChatImageStoreDeps`, `chatImageStoreFor(app)`, `MAX_CHAT_IMAGES_PER_MESSAGE` (4), `resolveTurnImages(deps: Pick<ChatImageStoreDeps,'db'|'dataDir'>, rawIds): Promise<ChatTurnImage[]>` (dedupes, keeps order, derives the preview), `ChatImageLookupError` (`code: 'unknown_image' | 'not_on_this_machine' | 'unreadable_image'`, `imageId`), `ChatImageLookupErrorCode`.
  - `src/chat/compose.ts`: `uploadTag`, `ComposedImage`, `UserTurn {text, images}`, `ComposeInput`, `composePromptText`, `composeUserTurn(input, previews)`, `userTurnContent`, `toSdkPrompt(turn)`.
  - `src/chat/agent.ts`: `QueryFn` takes `prompt: string | AsyncIterable<SDKUserMessage>`; `AgentChatOptions.readPreview`; `ChatRun.userTurn()` reads previews and composes; `attempt` sends `toSdkPrompt(turn)`; `optionsFor` still has `resume` (removed here).
  - `src/http/api.ts`: `chatSchema` with `image_ids` (max 4, ids max 16 chars), refine message-or-images; `chatImageErrorStatus` (400 `unknown_image`, 409 `not_on_this_machine`, 422 `unreadable_image`, JSON `{error, id, message}` before any SSE).
  - Routes `POST /api/chat/images` (multipart `file` + optional `source`) answering 201/200 `{image: ChatImage, created}`, and `GET /api/chat/images/:id/{original,display,thumb,preview}`. `chat_images` is in `truncateAll`. `startHarness(options: { chat?: ChatBackend } = {})`.
- Phase 4: `note_files` in `truncateAll`; `files` in `DATA_SUBDIRS`; `fileRoutes` mounted in `src/http/app.ts`; one files sentence in `src/chat/prompt.ts`.
- Phase 6: `AppDeps.imageEmbedder: ImageEmbedder | null` (`src/deps.ts`) and in every `AppDeps` literal; `note_image_embeddings` in `truncateAll`; `startHarness(options: { chat?: ChatBackend; imageEmbedder?: ImageEmbedder | null } = {})`; `mcpToolDeps` passes `imageEmbedder` and `chatUploads`; the `similar_images` sentence in `src/chat/prompt.ts`. This phase only adds to those lists.
- Phase 6: migration 0005 is the latest entry in `drizzle/meta/_journal.json`.

**Leaves alone (owned by others):**
- `web/**`. P9/P10/P11 consume this API. The current web client keeps working: it ignores `event: accepted` and reads `done.thread_id`, which is now our id.
- `src/chat/status.ts` (P6 allowlist and captions). `src/mcp/**`.
- The Claude Code hook and the capture endpoint (`claude/hooks/*`, `src/http/capture.ts`, P8). P8 calls `ChatService.recordExchange`.
- The chat image store (`src/chat/images.ts`) and routes (`src/http/chatImages.ts`), P3: only called. The compose extension is in `src/chat/compose.ts` (Step 11).

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | header comment (P6's text + the 0006 sentence); imports `primaryKey`, `AnyPgColumn` (`check` is P3's); four chat tables, constants and row types appended at the end |
| `drizzle/0006_chat_history.sql`, `drizzle/meta/0006_snapshot.json`, `drizzle/meta/_journal.json` | create/modify | generated by `npm run db:generate -- --name chat_history`, never hand-edited |
| `src/chat/ids.ts` | create | 4-char message ids |
| `src/chat/events.ts` | create | `ChatEvents` bus |
| `src/chat/types.ts` | create | wire types, `ChatError`, row-to-view mapping |
| `src/chat/repo.ts` | create | SQL for threads, messages, revisions, attachments, timeline cursor |
| `src/chat/service.ts` | create | `ChatService` |
| `src/chat/context.ts` | create | pure context builder |
| `src/chat/citation.ts` | create | leading `[msg:ID]` parser and streaming filter |
| `src/chat/turn.ts` | create | `composeWallTurn` (rows -> context -> image blocks) |
| `src/chat/backend.ts` | modify (whole file) | `ComposedTurn`; `ChatTurnImage.messageId?`; `ChatRequest`/`ChatTurnEnd` lose thread ids and `images` |
| `src/chat/agent.ts` | modify | `userTurn()` reads `request.turn`; no `resume`; `persistSession: false`; `optionsFor` signature; `outcome = { brain }` |
| `src/chat/stub.ts` | modify (whole file) | no thread id |
| `src/chat/prompt.ts` | modify | two new sections: context layout and `[msg:ID]` replies |
| `src/chat/compose.ts` (P3's file) | modify | `ComposeInput` image `messageId?`; `imageLabel`, `composeLabelledText`; `composeUserTurn` picks the labelled text |
| `src/http/api.ts` | modify | chat schema and route rewritten; `/api/events` also emits `chat`; `describeIssues`/`readJson` exported; `chatEventName` removed |
| `src/http/chatApi.ts` | create | history routes and `ChatError` mapping |
| `src/http/app.ts` | modify | mount `chatHistoryRoutes` |
| `src/deps.ts` | modify | `chat: ChatService` |
| `src/daemon.ts` | modify | construct `ChatService`; `CHAT_SUBDIR` comment |
| `tests/integration/setup.ts` | modify | `truncateAll` gains four tables |
| `tests/integration/imageHarness.ts` | modify | `chat: new ChatService({ db })` |
| `tests/integration/helpers/api-harness.ts` | modify (whole file) | ChatService, history routes, `headers` arg, `SAME_ORIGIN` |
| `tests/integration/helpers/scripted-chat.ts` | modify (whole file) | new `ChatRequest`/`ChatTurnEnd` |
| `tests/integration/connectors/mcp.int.test.ts`, `embeddings.worker.int.test.ts`, `related.int.test.ts`, `mcp.tools.int.test.ts`, `images.int.test.ts` | modify | `AppDeps` literals gain `chat` |
| `tests/integration/api.int.test.ts` | modify | the two `POST /api/chat` describe blocks are rewritten for the new contract |
| `tests/integration/chat.images.int.test.ts` (P3's file) | modify | its chat-turn cases read `request.turn` and the new `done` (Step 22d) |
| `tests/integration/daemon.int.test.ts` | modify | chat assertions updated for `accepted`/`done` |
| `tests/integration/chat.service.int.test.ts` | create | service: ids, edit, delete/restore, timeline, recordExchange, cascade, restart |
| `tests/integration/chat.api.int.test.ts` | create | route: two turns, restart, fallback, reply_to, citation, edit/delete, paging, SSE, validation, abort, images |
| `tests/unit/chat-ids.test.ts`, `chat-citation.test.ts`, `chat-context.test.ts` | create | pure units |
| `tests/unit/chat-agent.test.ts`, `chat-stub.test.ts`, `chat-prompt.test.ts`, `chat-compose.test.ts` | modify | new contract; compose labels |
| `tests/live/chat.live.test.ts` | modify | `reply({ turn, signal })`, no `threadId` |
| `README.md`, `CHANGELOG.md` | modify | chat bar paragraph, HTTP table, storage block; one Unreleased line |

## Implementation Steps

Worktree setup (Invariant 10): `npm ci` if `node_modules` is missing; `ln -s ~/mcp-notes/.env.local .env.local` if missing (drizzle-kit's config needs a URL to load, even for `generate`).

### Step 1: Schema: four chat tables

**File:** `src/db/schema.ts`. There are three edits: the header comment (lines 4-11), the import line (line 2), and new code appended after the last table that Phases 3/4/6 added (today after `noteEmbeddings`, line 173), just before the `export type ...Row` block (today line 175).

**Change 1, imports (line 2).** After P3 (P4 and P6 leave it alone) the line reads `import { bigserial, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core'`. Add `primaryKey` and `type AnyPgColumn`:
```ts
import {
  type AnyPgColumn,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core'
```

**Change 2, header comment.** Replace the whole block comment (P4's text with P6's 0005 sentence) with:
```ts
/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`; migration 0002 (iteration 7, wall editing) adds `note_images` and copies every
 * legacy `notes.image_path` / `image_meta` image into it (hand-appended INSERT...SELECT, the same
 * SQL as src/images/legacy.ts `LEGACY_COPY_SQL`); migration 0003 (chat images) adds
 * `chat_images`, the images pasted into a chat; migration 0004 (note files) adds `note_files`:
 * non-image files attached to a note, stored under `files/<noteId>/<safeName>`, with
 * `extracted_text` / `extraction_status` ready for a later text extraction (v1 writes only
 * 'none'). Migration 0005 (image similarity search) adds `note_image_embeddings`. Migration 0006
 * (chat history) adds `chat_threads`, `chat_messages`, `chat_message_revisions` and
 * `chat_message_attachments`: our own record of every wall chat turn and every captured Claude
 * Code `/n` exchange (src/chat/service.ts is the only writer). Change a table here, then
 * `npm run db:generate`; never edit an applied migration. drizzle-kit does not emit
 * `CREATE EXTENSION`, so 0001 carries a hand-prepended `CREATE EXTENSION IF NOT EXISTS vector`.
 */
```

**Change 3, tables (append after the last table, before the `export type` block).**
```ts
/** Where a chat thread came from: the wall's chat bar, or a captured Claude Code `/n` exchange (phase 8). */
export const CHAT_SOURCES = ['wall', 'claude_code'] as const
export type ChatSource = (typeof CHAT_SOURCES)[number]

export const CHAT_ROLES = ['user', 'assistant'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

/** `chat_image`: a chat_images row (phase 3); `note_image`: a note_images row; `note_file`: a note_files row (phase 4). */
export const CHAT_ATTACHMENT_KINDS = ['chat_image', 'note_file', 'note_image'] as const
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number]

/**
 * One conversation (migration 0006). Wall threads hold many turns; a captured Claude Code exchange
 * is one single-turn thread whose `external_key` (`<claude_session>:<user entry uuid>`) makes the
 * capture idempotent. Ids are random UUIDs; they never reach the model.
 */
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    source: text('source').$type<ChatSource>().notNull(),
    /** The brain of the latest answer (`claude`, `glm`, ...), or null before any answer. */
    brain: text('brain'),
    /** Idempotency key for captured exchanges (phase 8). Null for wall threads. */
    externalKey: text('external_key'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Bumped (never lowered) by every message written to the thread. */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_threads_external_key_uniq').on(t.externalKey),
    index('chat_threads_updated_at_idx').on(t.updatedAt),
    check('chat_threads_source_check', sql`${t.source} in ('wall', 'claude_code')`),
  ],
)

/**
 * One chat bubble. `id` is 4 characters from [0-9A-Z] (src/chat/ids.ts), shown to the model as
 * `[msg:K7F2]`. `seq` breaks ties in `created_at` so the timeline order is total and stable.
 * `text` is the current text; an edit (user rows only) keeps the old text in
 * `chat_message_revisions`. `deleted_at` is a soft delete: deleted rows leave the model context and
 * the default timeline, and restore brings them back. `reply_to` names the bubble this one replies
 * to, possibly in another thread; it becomes null if that row is ever removed for good.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: text('role').$type<ChatRole>().notNull(),
    text: text('text').notNull(),
    /** Copied from the thread at insert, so the timeline needs no join. */
    source: text('source').$type<ChatSource>().notNull(),
    /** Assistant rows: the brain that answered. Null for user rows. */
    brain: text('brain'),
    replyTo: text('reply_to').references((): AnyPgColumn => chatMessages.id, { onDelete: 'set null' }),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    /** UTC. Always written by ChatService from its clock (or the captured transcript's timestamp). */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('chat_messages_timeline_idx').on(t.createdAt, t.seq),
    index('chat_messages_thread_idx').on(t.threadId, t.createdAt, t.seq),
    index('chat_messages_reply_to_idx').on(t.replyTo),
    uniqueIndex('chat_messages_seq_uniq').on(t.seq),
    check('chat_messages_role_check', sql`${t.role} in ('user', 'assistant')`),
    check('chat_messages_source_check', sql`${t.source} in ('wall', 'claude_code')`),
  ],
)

/** The text of a chat message BEFORE an edit replaced it. */
export const chatMessageRevisions = pgTable(
  'chat_message_revisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('chat_message_revisions_message_saved_idx').on(t.messageId, t.savedAt.desc())],
)

/**
 * What a chat message carries, in order. `ref_id` names a row of the table `kind` points at; it is
 * not a foreign key because the kinds live in different tables.
 */
export const chatMessageAttachments = pgTable(
  'chat_message_attachments',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').$type<ChatAttachmentKind>().notNull(),
    refId: text('ref_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.position] }),
    index('chat_message_attachments_ref_idx').on(t.kind, t.refId),
    check('chat_message_attachments_kind_check', sql`${t.kind} in ('chat_image', 'note_file', 'note_image')`),
  ],
)
```
Append these to the `export type` block at the end of the file:
```ts
export type ChatThreadRow = typeof chatThreads.$inferSelect
export type ChatMessageRow = typeof chatMessages.$inferSelect
export type ChatMessageRevisionRow = typeof chatMessageRevisions.$inferSelect
export type ChatMessageAttachmentRow = typeof chatMessageAttachments.$inferSelect
```
**Impact:** schema only. Nothing reads these yet.

### Step 2: Generate migration 0006

**Files:** `drizzle/0006_chat_history.sql`, `drizzle/meta/0006_snapshot.json`, `drizzle/meta/_journal.json` (new entry `idx: 6`).
**Command:**
```bash
npm run db:generate -- --name chat_history
```
**Check, without editing the file:** the generated SQL must contain `CREATE TABLE "chat_threads"`,
`"chat_messages"`, `"chat_message_revisions"`, `"chat_message_attachments"`, the three
`ON DELETE cascade` FKs, `chat_messages_reply_to_chat_messages_id_fk ... ON DELETE set null`, the
composite PK `chat_message_attachments_message_id_position_pk`, the four `CHECK` constraints, and
all indexes named in Step 1. The journal must list 0003, 0004, 0005 and then 0006. If the file is
named anything other than `0006_...`, an earlier phase's migration is missing from the branch.
Stop and fix the chain; do not renumber by hand. Run `npm run db:check`.
**Impact:** `migrateTestDb` (globalSetup) applies it in `test:int`. Production applies it with `npm run db:migrate` when the set merges (not part of this phase).

### Step 3: Message ids

**File:** `src/chat/ids.ts` (new)
**Code:**
```ts
import { randomInt } from 'node:crypto';
import { ID_ALPHABET } from '../notes/ids.js';

/**
 * Chat message ids: 4 characters from [0-9A-Z], e.g. `K7F2`, always shown as `[msg:K7F2]` so they
 * never read as a note id (`A-B32`) or a chat image id (`upload:A-B32`). 36^4 = 1,679,616 ids;
 * ChatService retries on a primary-key clash.
 */
export const MESSAGE_ID_PATTERN = /^[0-9A-Z]{4}$/;

const LOOSE_MESSAGE_ID = /^(?:\[msg:([0-9A-Z]{4})\]|msg:([0-9A-Z]{4})|([0-9A-Z]{4}))$/i;

/** A random id in canonical form. `random(n)` returns an integer in [0, n); injectable for tests. */
export function generateMessageId(random: (max: number) => number = randomInt): string {
  let id = '';
  for (let i = 0; i < 4; i += 1) {
    const ch = ID_ALPHABET[random(ID_ALPHABET.length)];
    if (ch === undefined) throw new RangeError('generateMessageId: random() returned an out-of-range index');
    id += ch;
  }
  return id;
}

export function isMessageId(value: string): boolean {
  return MESSAGE_ID_PATTERN.test(value);
}

/** `k7f2`, `msg:K7F2`, `[msg:k7f2]`, ` K7F2 ` -> `K7F2`; anything else -> null. */
export function normalizeMessageId(input: string): string | null {
  const m = LOOSE_MESSAGE_ID.exec(input.trim());
  if (m === null) return null;
  const id = m[1] ?? m[2] ?? m[3];
  return id === undefined ? null : id.toUpperCase();
}

/** The form the model and the page see: `[msg:K7F2]`. */
export function messageLabel(id: string): string {
  return `[msg:${id}]`;
}
```

### Step 4: Chat change bus

**File:** `src/chat/events.ts` (new)
**Code:**
```ts
import { EventEmitter } from 'node:events';

export type ChatOp = 'created' | 'updated' | 'deleted' | 'restored';

/** One chat row change. `GET /api/events` writes it as `event: chat {op, thread_id, id}`. */
export interface ChatChange {
  type: 'chat';
  op: ChatOp;
  thread_id: string;
  /** The message id. */
  id: string;
}

export type ChatChangeListener = (change: ChatChange) => void;

/** In-process bus for chat writes. ChatService is the only emitter, always after commit. */
export class ChatEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(op: ChatOp, threadId: string, id: string): void {
    const change: ChatChange = { type: 'chat', op, thread_id: threadId, id };
    this.emitter.emit('chat', change);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: ChatChangeListener): () => void {
    this.emitter.on('chat', listener);
    return () => {
      this.emitter.off('chat', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('chat');
  }
}
```

### Step 5: Wire types and mapping

**File:** `src/chat/types.ts` (new)
**Code:**
```ts
import type { ChatAttachmentKind, ChatMessageRow, ChatRole, ChatSource, ChatThreadRow } from '../db/schema.js';

/** One attachment by reference: what is stored in chat_message_attachments. */
export interface AttachmentRef {
  kind: ChatAttachmentKind;
  id: string;
}

/** An attachment on the wire. `url` is the large form (lightbox / download); `thumb_url` is null for files. */
export interface ChatAttachmentView {
  kind: ChatAttachmentKind;
  id: string;
  url: string;
  thumb_url: string | null;
}

/** The quoted header of a reply bubble. A deleted (or vanished) target has `deleted: true` and empty text. */
export interface ChatReplyPreview {
  id: string;
  role: ChatRole | null;
  text: string;
  deleted: boolean;
}

/** A chat message on the wire. Every timestamp is a UTC ISO string. */
export interface ChatMessageView {
  id: string;
  thread_id: string;
  role: ChatRole;
  text: string;
  source: ChatSource;
  brain: string | null;
  reply_to: ChatReplyPreview | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: ChatAttachmentView[];
}

export interface ChatThreadView {
  id: string;
  source: ChatSource;
  brain: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatThreadDetail {
  thread: ChatThreadView;
  /** Ascending (created_at, seq). */
  messages: ChatMessageView[];
}

/** One timeline page: ascending for display; `next_before` fetches the page of older messages, null at the start. */
export interface ChatTimelinePage {
  messages: ChatMessageView[];
  next_before: string | null;
}

export type ChatErrorCode =
  | 'invalid_id'
  | 'not_found'
  | 'thread_not_found'
  | 'reply_not_found'
  | 'not_editable'
  | 'empty_text'
  | 'invalid_cursor'
  | 'conflict';

export class ChatError extends Error {
  override name = 'ChatError';
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const REPLY_SNIPPET_CHARS = 140;

/** Whitespace collapsed to single spaces, cut with an ellipsis at `max` characters. */
export function snippet(text: string, max: number = REPLY_SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** URLs per kind: phase 3 chat image routes, note image routes, phase 4 file download. */
export function attachmentView(ref: AttachmentRef): ChatAttachmentView {
  switch (ref.kind) {
    case 'chat_image':
      return { kind: ref.kind, id: ref.id, url: `/api/chat/images/${ref.id}/display`, thumb_url: `/api/chat/images/${ref.id}/thumb` };
    case 'note_image':
      return { kind: ref.kind, id: ref.id, url: `/api/images/${ref.id}/display`, thumb_url: `/api/images/${ref.id}/thumb` };
    case 'note_file':
      return { kind: ref.kind, id: ref.id, url: `/api/files/${ref.id}/download`, thumb_url: null };
  }
}

export function toThreadView(row: ChatThreadRow): ChatThreadView {
  return {
    id: row.id,
    source: row.source,
    brain: row.brain,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** `target` is the row `row.replyTo` names, or null when it is gone (or `row.replyTo` is null). */
export function toMessageView(
  row: ChatMessageRow,
  attachments: readonly AttachmentRef[],
  target: ChatMessageRow | null,
): ChatMessageView {
  let reply: ChatReplyPreview | null = null;
  if (row.replyTo !== null) {
    if (target === null) {
      reply = { id: row.replyTo, role: null, text: '', deleted: true };
    } else {
      const deleted = target.deletedAt !== null;
      reply = { id: target.id, role: target.role, text: deleted ? '' : snippet(target.text), deleted };
    }
  }
  return {
    id: row.id,
    thread_id: row.threadId,
    role: row.role,
    text: row.text,
    source: row.source,
    brain: row.brain,
    reply_to: reply,
    created_at: row.createdAt.toISOString(),
    edited_at: row.editedAt === null ? null : row.editedAt.toISOString(),
    deleted_at: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    attachments: attachments.map(attachmentView),
  };
}
```

### Step 6: Repository

**File:** `src/chat/repo.ts` (new)
**Code:**
```ts
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  chatMessageAttachments,
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  type ChatMessageRevisionRow,
  type ChatMessageRow,
  type ChatRole,
  type ChatSource,
  type ChatThreadRow,
} from '../db/schema.js';
import type { AttachmentRef } from './types.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/** Timeline position: the row's exact created_at (microseconds, UTC text) and its seq. */
export interface TimelineCursor {
  ts: string;
  seq: number;
}

/**
 * Exact text of created_at. A JS Date keeps milliseconds only, so a cursor built from one could
 * skip rows written within the same millisecond; the text form round-trips exactly.
 */
const CURSOR_TS_SQL = sql<string>`to_char(${chatMessages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_TEXT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(\d{1,18})$/;

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(`${cursor.ts}|${cursor.seq}`, 'utf8').toString('base64url');
}

/** Null for anything encodeTimelineCursor did not produce. */
export function decodeTimelineCursor(raw: string): TimelineCursor | null {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const m = CURSOR_TEXT.exec(decoded);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq) || Number.isNaN(Date.parse(m[1]))) return null;
  return { ts: m[1], seq };
}

// ---------- threads ----------

export interface InsertThread {
  id: string;
  source: ChatSource;
  brain: string | null;
  externalKey: string | null;
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
      createdAt: values.createdAt,
      updatedAt: values.createdAt,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function findThread(ex: Executor, id: string): Promise<ChatThreadRow | null> {
  const rows = await ex.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function lockThread(tx: Tx, id: string): Promise<ChatThreadRow | null> {
  const rows = await tx.select().from(chatThreads).where(eq(chatThreads.id, id)).for('update');
  return rows[0] ?? null;
}

export async function findThreadByExternalKey(ex: Executor, key: string): Promise<ChatThreadRow | null> {
  const rows = await ex.select().from(chatThreads).where(eq(chatThreads.externalKey, key)).limit(1);
  return rows[0] ?? null;
}

/** updated_at = greatest(updated_at, at); brain replaced when given. */
export async function touchThread(ex: Executor, id: string, at: Date, brain: string | null = null): Promise<void> {
  await ex
    .update(chatThreads)
    .set({
      updatedAt: sql`greatest(${chatThreads.updatedAt}, ${at.toISOString()}::timestamptz)`,
      ...(brain !== null ? { brain } : {}),
    })
    .where(eq(chatThreads.id, id));
}

// ---------- messages ----------

export interface InsertMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  text: string;
  source: ChatSource;
  brain: string | null;
  replyTo: string | null;
  createdAt: Date;
}

/** Null when the id is taken (the caller retries with a fresh id). */
export async function insertMessage(ex: Executor, values: InsertMessage): Promise<ChatMessageRow | null> {
  const rows = await ex
    .insert(chatMessages)
    .values(values)
    .onConflictDoNothing({ target: chatMessages.id })
    .returning();
  return rows[0] ?? null;
}

export async function findMessage(ex: Executor, id: string): Promise<ChatMessageRow | null> {
  const rows = await ex.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function lockMessage(tx: Tx, id: string): Promise<ChatMessageRow | null> {
  const rows = await tx.select().from(chatMessages).where(eq(chatMessages.id, id)).for('update');
  return rows[0] ?? null;
}

export async function findMessagesByIds(ex: Executor, ids: readonly string[]): Promise<ChatMessageRow[]> {
  if (ids.length === 0) return [];
  return ex.select().from(chatMessages).where(inArray(chatMessages.id, [...ids]));
}

/** The message right after `row` in its thread (any state), or null. */
export async function nextMessageInThread(tx: Tx, row: ChatMessageRow): Promise<ChatMessageRow | null> {
  const rows = await tx
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, row.threadId),
        sql`(${chatMessages.createdAt}, ${chatMessages.seq}) > (select m.created_at, m.seq from chat_messages m where m.id = ${row.id})`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.seq))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/** A thread's messages, ascending (created_at, seq). */
export async function listThreadMessages(
  ex: Executor,
  threadId: string,
  includeDeleted: boolean,
): Promise<ChatMessageRow[]> {
  const conds: SQL[] = [eq(chatMessages.threadId, threadId)];
  if (!includeDeleted) conds.push(isNull(chatMessages.deletedAt));
  return ex
    .select()
    .from(chatMessages)
    .where(and(...conds))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.seq));
}

export interface TimelineRow {
  row: ChatMessageRow;
  cursorTs: string;
}

/** Newest first, strictly older than `before` when given. */
export async function listTimelineRows(
  ex: Executor,
  options: { before: TimelineCursor | null; limit: number; includeDeleted: boolean },
): Promise<TimelineRow[]> {
  const conds: SQL[] = [];
  if (!options.includeDeleted) conds.push(isNull(chatMessages.deletedAt));
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

export async function setMessageText(tx: Tx, id: string, text: string, at: Date): Promise<ChatMessageRow> {
  const rows = await tx.update(chatMessages).set({ text, editedAt: at }).where(eq(chatMessages.id, id)).returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`chat message ${id} vanished inside its own transaction`);
  return row;
}

export async function setMessageDeleted(tx: Tx, id: string, at: Date | null): Promise<ChatMessageRow> {
  const rows = await tx.update(chatMessages).set({ deletedAt: at }).where(eq(chatMessages.id, id)).returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`chat message ${id} vanished inside its own transaction`);
  return row;
}

// ---------- revisions ----------

export async function insertMessageRevision(tx: Tx, messageId: string, text: string, at: Date): Promise<void> {
  await tx.insert(chatMessageRevisions).values({ messageId, text, savedAt: at });
}

/** Newest first. */
export async function listMessageRevisions(ex: Executor, messageId: string): Promise<ChatMessageRevisionRow[]> {
  return ex
    .select()
    .from(chatMessageRevisions)
    .where(eq(chatMessageRevisions.messageId, messageId))
    .orderBy(desc(chatMessageRevisions.savedAt), desc(chatMessageRevisions.id));
}

// ---------- attachments ----------

export async function insertAttachments(ex: Executor, messageId: string, refs: readonly AttachmentRef[]): Promise<void> {
  if (refs.length === 0) return;
  await ex
    .insert(chatMessageAttachments)
    .values(refs.map((ref, position) => ({ messageId, position, kind: ref.kind, refId: ref.id })));
}

/** message id -> its attachments in position order. Messages without any are absent. */
export async function attachmentsFor(ex: Executor, messageIds: readonly string[]): Promise<Map<string, AttachmentRef[]>> {
  const out = new Map<string, AttachmentRef[]>();
  if (messageIds.length === 0) return out;
  const rows = await ex
    .select()
    .from(chatMessageAttachments)
    .where(inArray(chatMessageAttachments.messageId, [...messageIds]))
    .orderBy(asc(chatMessageAttachments.messageId), asc(chatMessageAttachments.position));
  for (const row of rows) {
    const list = out.get(row.messageId) ?? [];
    list.push({ kind: row.kind, id: row.refId });
    out.set(row.messageId, list);
  }
  return out;
}
```

### Step 7: Pure context builder

**File:** `src/chat/context.ts` (new)
**Code:**
```ts
import type { ChatRole } from '../db/schema.js';
import type { AttachmentRef } from './types.js';

/**
 * Rebuilds the model's prompt for one wall turn from our own rows (the Agent SDK keeps no session).
 * Pure: ChatService.loadTurnContext supplies the rows, src/chat/turn.ts loads the image bytes.
 *
 * Layout (the system prompt in src/chat/prompt.ts explains it to the model):
 *
 *   <chat_history>
 *   [earlier messages omitted]
 *   [msg:K7F2] user (2026-10-31 09:12 WIB): what did I save? [image upload:C-AB12]
 *   [msg:P0Q1] assistant (2026-10-31 09:12 WIB): You saved A-B32.
 *   </chat_history>
 *
 *   <reply_to>
 *   [msg:Z1Y2] assistant (2026-10-30 20:01 WIB): ...
 *   </reply_to>
 *
 *   <message>
 *   [msg:N3W4] user (2026-10-31 09:15 WIB): and last month?
 *   </message>
 */

/** History characters kept per turn (about 6k tokens). The newest lines win. */
export const CONTEXT_CHAR_BUDGET = 24_000;
/** One history or reply-target line is cut to this many characters of text. The current message is never cut. */
export const CONTEXT_LINE_CHAR_CAP = 4_000;
export const OMITTED_LINE = '[earlier messages omitted]';
/** Chat times are always shown in WIB, whatever the daemon's own zone (Invariant 7). */
export const CHAT_TIME_ZONE = 'Asia/Jakarta';

export interface ContextMessage {
  id: string;
  role: ChatRole;
  /** The current (edited) text. */
  text: string;
  createdAt: Date;
  attachments: readonly AttachmentRef[];
}

export interface TurnContextInput {
  /** Live messages of the thread before the current one, ascending. */
  history: readonly ContextMessage[];
  /** The user message being answered now. */
  current: ContextMessage;
  /** The live message the current one replies to (any thread), or null. */
  replyTarget: ContextMessage | null;
  /** Default CONTEXT_CHAR_BUDGET. */
  budgetChars?: number;
}

export interface TurnContext {
  text: string;
  /** Chat images to send as image blocks: the current message's, then the reply target's. Deduped. */
  images: Array<{ id: string; messageId: string }>;
  /** History messages dropped by the budget. */
  omitted: number;
}

const TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHAT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `2026-10-31 09:15 WIB`. */
export function formatWib(date: Date): string {
  const parts = TIME_FORMAT.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} WIB`;
}

export function attachmentLabel(ref: AttachmentRef): string {
  switch (ref.kind) {
    case 'chat_image':
      return `[image upload:${ref.id}]`;
    case 'note_image':
      return `[note image:${ref.id}]`;
    case 'note_file':
      return `[note file:${ref.id}]`;
  }
}

const BLOCK_TAG = /<(\/?)(chat_history|reply_to|message)>/gi;

/** A message cannot close or open one of our blocks: `<message>` in text becomes `‹message›`. */
function neutralize(text: string): string {
  return text.replace(BLOCK_TAG, (_match, slash: string, name: string) => `‹${slash}${name}›`);
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)} [cut]`;
}

/** `[msg:ID] role (YYYY-MM-DD HH:mm WIB): text [image upload:X] ...`. `cap` null: never cut. */
export function renderMessageLine(message: ContextMessage, cap: number | null = CONTEXT_LINE_CHAR_CAP): string {
  const body = neutralize(cap === null ? message.text : clip(message.text, cap));
  const tail = [body, ...message.attachments.map(attachmentLabel)].filter((part) => part !== '').join(' ');
  return `[msg:${message.id}] ${message.role} (${formatWib(message.createdAt)}): ${tail}`;
}

function chatImages(message: ContextMessage): Array<{ id: string; messageId: string }> {
  return message.attachments
    .filter((ref) => ref.kind === 'chat_image')
    .map((ref) => ({ id: ref.id, messageId: message.id }));
}

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

### Step 8: Citation parser and streaming filter

**File:** `src/chat/citation.ts` (new)
**Code:**
```ts
/**
 * The model replies to a bubble by STARTING its answer with `[msg:ID]`. The server strips that
 * marker into `reply_to`; a `[msg:ID]` anywhere else is just text. Streaming: the filter holds back
 * the start of the answer until it knows whether a marker is there, so the marker never flashes
 * in the panel. Text that cannot start a marker is released at once.
 */

/** The longest start of an answer held back while it could still be a marker. */
export const CITATION_LOOKAHEAD = 16;

const MARKER = /^\[msg:([0-9a-z]{4})\]/i;
/** Any proper prefix of a marker: `[`, `[m`, ..., `[msg:K7F2` (without the closing bracket). */
const MARKER_PREFIX = /^\[(?:m(?:s(?:g(?::[0-9a-z]{0,4})?)?)?)?$/i;

/** Whole-text form: the leading marker's id (upper case) and the text without it. */
export function parseLeadingCitation(text: string): { replyTo: string | null; text: string } {
  const lead = text.replace(/^\s+/, '');
  const m = MARKER.exec(lead);
  if (m === null || m[1] === undefined) return { replyTo: null, text };
  return { replyTo: m[1].toUpperCase(), text: lead.slice(m[0].length).replace(/^\s+/, '') };
}

type State = 'buffering' | 'stripping' | 'passthrough';

export class CitationFilter {
  private state: State = 'buffering';
  private pending = '';
  private emitted = '';
  private cited: string | null = null;

  /** Feeds one delta; returns the text to send now (may be ''). */
  push(chunk: string): string {
    let out: string;
    switch (this.state) {
      case 'passthrough':
        out = chunk;
        break;
      case 'stripping':
        out = chunk.replace(/^\s+/, '');
        if (out !== '') this.state = 'passthrough';
        break;
      case 'buffering':
        out = this.scan(chunk);
        break;
    }
    this.emitted += out;
    return out;
  }

  /**
   * A non-text event (a status caption) arrived. Held text that is not just whitespace goes out
   * now, to keep the order; with nothing (or only whitespace) held, keep waiting for a marker,
   * because answers usually start after the tool calls.
   */
  flush(): string {
    if (this.state !== 'buffering' || this.pending.trim() === '') return '';
    const out = this.release();
    this.emitted += out;
    return out;
  }

  /** The stream ended: whatever is still held goes out as text. */
  end(): string {
    if (this.state !== 'buffering' || this.pending === '') return '';
    const out = this.release();
    this.emitted += out;
    return out;
  }

  /** The cited id (syntactically valid, upper case), or null. Not checked against the database. */
  get replyTo(): string | null {
    return this.cited;
  }

  /** Everything sent so far: the answer without its marker. */
  get text(): string {
    return this.emitted;
  }

  private scan(chunk: string): string {
    this.pending += chunk;
    const lead = this.pending.replace(/^\s+/, '');
    const m = MARKER.exec(lead);
    if (m !== null && m[1] !== undefined) {
      this.cited = m[1].toUpperCase();
      this.pending = '';
      const rest = lead.slice(m[0].length).replace(/^\s+/, '');
      this.state = rest === '' ? 'stripping' : 'passthrough';
      return rest;
    }
    if ((lead === '' || MARKER_PREFIX.test(lead)) && this.pending.length < CITATION_LOOKAHEAD) return '';
    return this.release();
  }

  private release(): string {
    const out = this.pending;
    this.pending = '';
    this.state = 'passthrough';
    return out;
  }
}
```

### Step 9: ChatService

**File:** `src/chat/service.ts` (new)
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { ChatMessageRow, ChatSource, ChatThreadRow } from '../db/schema.js';
import type { TurnContextInput } from './context.js';
import { ChatEvents } from './events.js';
import { generateMessageId, normalizeMessageId } from './ids.js';
import * as repo from './repo.js';
import {
  ChatError,
  toMessageView,
  toThreadView,
  type AttachmentRef,
  type ChatMessageView,
  type ChatThreadDetail,
  type ChatThreadView,
  type ChatTimelinePage,
} from './types.js';

export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 200;
const MAX_MESSAGE_ID_ATTEMPTS = 20;

export interface ChatServiceDeps {
  db: Db;
  /** Default: a fresh bus. */
  events?: ChatEvents;
  /** Default: `() => new Date()`. Every created_at / edited_at / deleted_at comes from here. */
  now?: () => Date;
  /** Index source for message ids. Default: crypto.randomInt. */
  random?: (max: number) => number;
}

export interface AddUserMessageInput {
  /** The thread to continue. Null, unknown, or a thread of another source: a new thread is created. */
  threadId: string | null;
  source: ChatSource;
  /** Trimmed by the caller. May be '' only when attachments are given. */
  text: string;
  attachments?: readonly AttachmentRef[];
  /** Canonical message id of a live message (any thread), or null. */
  replyTo?: string | null;
  createdAt?: Date;
}

export interface UserTurnStart {
  thread: ChatThreadView;
  message: ChatMessageView;
  threadCreated: boolean;
}

export interface AddAssistantMessageInput {
  threadId: string;
  text: string;
  brain: string | null;
  /** Validated by the caller; a target that is gone by now is dropped silently. */
  replyTo?: string | null;
  createdAt?: Date;
}

/** One captured exchange (phase 8): one single-turn thread, idempotent on `externalKey`. */
export interface RecordExchangeInput {
  source: ChatSource;
  /** `<claude_session>:<user entry uuid>`. */
  externalKey: string;
  brain?: string | null;
  user: { text: string; createdAt: Date; attachments?: readonly AttachmentRef[] };
  assistant: { text: string; createdAt: Date } | null;
}

export interface RecordedExchange {
  /** False when the key was already recorded: nothing was written. */
  created: boolean;
  thread: ChatThreadView;
  /** The thread's message ids, ascending. */
  messageIds: string[];
}

export interface IncludeDeleted {
  includeDeleted?: boolean;
}

/**
 * The only writer of the chat tables (Invariant 3). Every write is one transaction that locks the
 * thread or message row first; ChatEvents fire after commit. Routes never touch rows directly.
 */
export class ChatService {
  readonly events: ChatEvents;
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly random: ((max: number) => number) | undefined;

  constructor(deps: ChatServiceDeps) {
    this.db = deps.db;
    this.events = deps.events ?? new ChatEvents();
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random;
  }

  /** Canonical message id or ChatError('invalid_id'). */
  requireMessageId(input: string): string {
    const id = normalizeMessageId(input);
    if (id === null) throw new ChatError('invalid_id', `"${input}" is not a chat message id. Ids look like K7F2.`);
    return id;
  }

  async createThread(input: {
    source: ChatSource;
    brain?: string | null;
    externalKey?: string | null;
    createdAt?: Date;
  }): Promise<ChatThreadView> {
    const row = await repo.insertThread(this.db, {
      id: randomUUID(),
      source: input.source,
      brain: input.brain ?? null,
      externalKey: input.externalKey ?? null,
      createdAt: input.createdAt ?? this.now(),
    });
    if (row === null) throw new ChatError('conflict', 'A thread with this id or external key already exists.');
    return toThreadView(row);
  }

  /** Writes the user row (and its attachments) before anything else happens to the turn. */
  async addUserMessage(input: AddUserMessageInput): Promise<UserTurnStart> {
    const attachments = input.attachments ?? [];
    if (input.text === '' && attachments.length === 0) {
      throw new ChatError('empty_text', 'A chat message needs text or an image.');
    }
    const at = input.createdAt ?? this.now();
    const replyTo = input.replyTo ?? null;
    const result = await this.db.transaction(async (tx) => {
      let thread: ChatThreadRow | null = input.threadId === null ? null : await repo.lockThread(tx, input.threadId);
      if (thread !== null && thread.source !== input.source) thread = null;
      let threadCreated = false;
      if (thread === null) {
        thread = await repo.insertThread(tx, {
          id: randomUUID(),
          source: input.source,
          brain: null,
          externalKey: null,
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

  async addAssistantMessage(input: AddAssistantMessageInput): Promise<ChatMessageView> {
    const at = input.createdAt ?? this.now();
    const message = await this.db.transaction(async (tx) => {
      const thread = await repo.lockThread(tx, input.threadId);
      if (thread === null) throw new ChatError('thread_not_found', `No chat thread ${input.threadId}.`);
      let replyTo = input.replyTo ?? null;
      if (replyTo !== null) {
        const target = await repo.findMessage(tx, replyTo);
        if (target === null || target.deletedAt !== null) replyTo = null;
      }
      const row = await this.insertWithFreshId(tx, {
        threadId: thread.id,
        role: 'assistant',
        text: input.text,
        source: thread.source,
        brain: input.brain,
        replyTo,
        createdAt: at,
      });
      await repo.touchThread(tx, thread.id, at, input.brain);
      return row;
    });
    this.events.emit('created', message.threadId, message.id);
    const [view] = await this.viewsFor([message]);
    return view as ChatMessageView;
  }

  /** User messages only. The old text becomes a revision; the answer is not regenerated. */
  async editMessage(idInput: string, textInput: string): Promise<ChatMessageView> {
    const id = this.requireMessageId(idInput);
    const text = textInput.trim();
    if (text === '') throw new ChatError('empty_text', 'The new text is blank.');
    const at = this.now();
    const result = await this.db.transaction(async (tx) => {
      const row = await repo.lockMessage(tx, id);
      if (row === null || row.deletedAt !== null) throw new ChatError('not_found', `No live chat message ${id}.`);
      if (row.role !== 'user') throw new ChatError('not_editable', 'Only your own messages can be edited.');
      if (row.text === text) return { row, changed: false };
      await repo.insertMessageRevision(tx, row.id, row.text, at);
      return { row: await repo.setMessageText(tx, row.id, text, at), changed: true };
    });
    if (result.changed) this.events.emit('updated', result.row.threadId, result.row.id);
    const [view] = await this.viewsFor([result.row]);
    return view as ChatMessageView;
  }

  /**
   * Soft delete. With `withAnswer` on a user message, the assistant message that directly follows
   * it in its thread is deleted too. Returns the ids this call changed (already-deleted rows are
   * left alone and not listed).
   */
  async deleteMessage(idInput: string, options: { withAnswer?: boolean } = {}): Promise<{ deleted: string[] }> {
    const id = this.requireMessageId(idInput);
    const at = this.now();
    const changed = await this.db.transaction(async (tx) => {
      const row = await repo.lockMessage(tx, id);
      if (row === null) throw new ChatError('not_found', `No chat message ${id}.`);
      const out: ChatMessageRow[] = [];
      if (row.deletedAt === null) out.push(await repo.setMessageDeleted(tx, row.id, at));
      if (options.withAnswer === true && row.role === 'user') {
        const next = await repo.nextMessageInThread(tx, row);
        if (next !== null && next.role === 'assistant' && next.deletedAt === null) {
          out.push(await repo.setMessageDeleted(tx, next.id, at));
        }
      }
      return out;
    });
    for (const row of changed) this.events.emit('deleted', row.threadId, row.id);
    return { deleted: changed.map((row) => row.id) };
  }

  /** Undo a soft delete. Restoring a live message is a no-op that returns it. */
  async restoreMessage(idInput: string): Promise<ChatMessageView> {
    const id = this.requireMessageId(idInput);
    const result = await this.db.transaction(async (tx) => {
      const row = await repo.lockMessage(tx, id);
      if (row === null) throw new ChatError('not_found', `No chat message ${id}.`);
      if (row.deletedAt === null) return { row, changed: false };
      return { row: await repo.setMessageDeleted(tx, row.id, null), changed: true };
    });
    if (result.changed) this.events.emit('restored', result.row.threadId, result.row.id);
    const [view] = await this.viewsFor([result.row]);
    return view as ChatMessageView;
  }

  /**
   * One page of the unified timeline (every thread, every source). The page holds the newest
   * `limit` messages older than `before`, returned ascending; `next_before` fetches the page before it.
   */
  async listTimeline(
    options: { before?: string | null; limit?: number; includeDeleted?: boolean } = {},
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

  async getThread(id: string, options: IncludeDeleted = {}): Promise<ChatThreadDetail | null> {
    const thread = await repo.findThread(this.db, id);
    if (thread === null) return null;
    const rows = await repo.listThreadMessages(this.db, id, options.includeDeleted ?? false);
    return { thread: toThreadView(thread), messages: await this.viewsFor(rows) };
  }

  async getMessage(idInput: string, options: IncludeDeleted = {}): Promise<ChatMessageView | null> {
    const id = normalizeMessageId(idInput);
    if (id === null) return null;
    const row = await repo.findMessage(this.db, id);
    if (row === null || (row.deletedAt !== null && options.includeDeleted !== true)) return null;
    const [view] = await this.viewsFor([row]);
    return view ?? null;
  }

  /** Older texts of a message, newest first. */
  async listRevisions(idInput: string): Promise<Array<{ text: string; saved_at: string }>> {
    const id = this.requireMessageId(idInput);
    const rows = await repo.listMessageRevisions(this.db, id);
    return rows.map((row) => ({ text: row.text, saved_at: row.savedAt.toISOString() }));
  }

  async liveMessageExists(id: string): Promise<boolean> {
    const row = await repo.findMessage(this.db, id);
    return row !== null && row.deletedAt === null;
  }

  /**
   * The rows behind one wall turn: the thread's live messages before `currentMessageId` (edited
   * text, deleted ones left out), the current message, and its live reply target from any thread.
   */
  async loadTurnContext(threadId: string, currentMessageId: string): Promise<TurnContextInput> {
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
    };
  }

  /**
   * Phase 8's capture: one single-turn thread per external key. A second call with the same key
   * (a replayed hook, a retry from the outbox, a race with another laptop) writes nothing and
   * returns the existing thread.
   */
  async recordExchange(input: RecordExchangeInput): Promise<RecordedExchange> {
    const key = input.externalKey.trim();
    if (key === '') throw new ChatError('invalid_id', 'externalKey is blank.');
    const attachments = input.user.attachments ?? [];
    if (input.user.text === '' && attachments.length === 0) {
      throw new ChatError('empty_text', 'A captured question needs text or an image.');
    }
    const brain = input.brain ?? null;
    const result = await this.db.transaction(async (tx) => {
      const existing = await repo.findThreadByExternalKey(tx, key);
      if (existing !== null) {
        return { created: false, thread: existing, messages: await repo.listThreadMessages(tx, existing.id, true) };
      }
      const inserted = await repo.insertThread(tx, {
        id: randomUUID(),
        source: input.source,
        brain,
        externalKey: key,
        createdAt: input.user.createdAt,
      });
      if (inserted === null) {
        // Another writer committed the same key between our read and our insert.
        const winner = await repo.findThreadByExternalKey(tx, key);
        if (winner === null) throw new ChatError('conflict', 'Could not record the exchange.');
        return { created: false, thread: winner, messages: await repo.listThreadMessages(tx, winner.id, true) };
      }
      const user = await this.insertWithFreshId(tx, {
        threadId: inserted.id,
        role: 'user',
        text: input.user.text,
        source: input.source,
        brain: null,
        replyTo: null,
        createdAt: input.user.createdAt,
      });
      await repo.insertAttachments(tx, user.id, attachments);
      const messages: ChatMessageRow[] = [user];
      if (input.assistant !== null) {
        const answer = await this.insertWithFreshId(tx, {
          threadId: inserted.id,
          role: 'assistant',
          text: input.assistant.text,
          source: input.source,
          brain,
          replyTo: null,
          createdAt: input.assistant.createdAt,
        });
        messages.push(answer);
        await repo.touchThread(tx, inserted.id, input.assistant.createdAt, brain);
      }
      const thread = (await repo.findThread(tx, inserted.id)) ?? inserted;
      return { created: true, thread, messages };
    });
    if (result.created) {
      for (const message of result.messages) this.events.emit('created', result.thread.id, message.id);
    }
    return {
      created: result.created,
      thread: toThreadView(result.thread),
      messageIds: result.messages.map((message) => message.id),
    };
  }

  private async insertWithFreshId(tx: repo.Tx, values: Omit<repo.InsertMessage, 'id'>): Promise<ChatMessageRow> {
    for (let attempt = 0; attempt < MAX_MESSAGE_ID_ATTEMPTS; attempt += 1) {
      const id = generateMessageId(this.random);
      const row = await repo.insertMessage(tx, { ...values, id });
      if (row !== null) return row;
    }
    throw new ChatError('conflict', 'Could not find a free chat message id.');
  }

  private async viewsFor(rows: readonly ChatMessageRow[]): Promise<ChatMessageView[]> {
    if (rows.length === 0) return [];
    const attachments = await repo.attachmentsFor(this.db, rows.map((row) => row.id));
    const replyIds = [...new Set(rows.map((row) => row.replyTo).filter((id): id is string => id !== null))];
    const targets = new Map((await repo.findMessagesByIds(this.db, replyIds)).map((row) => [row.id, row]));
    return rows.map((row) =>
      toMessageView(row, attachments.get(row.id) ?? [], row.replyTo === null ? null : (targets.get(row.replyTo) ?? null)),
    );
  }
}
```
Note: `generateMessageId(this.random)` with `this.random === undefined` uses the default parameter (`randomInt`), which is intended.

### Step 10: Backend contract

**File:** `src/chat/backend.ts` (replace the whole file; it replaces P3's version)
**Code:**
```ts
/**
 * The chat brain seam. The HTTP layer (src/http/api.ts POST /api/chat) is the only consumer: it
 * writes the user row, composes the turn from our own rows (src/chat/turn.ts), streams each
 * `ChatEvent` as an SSE event of the same name, then writes the assistant row and `event: done`,
 * or `event: error` when `events` throws. Implementations: the stub (src/chat/stub.ts) and the
 * Agent SDK backend (src/chat/agent.ts). Backends keep no conversation state: everything the
 * model should know about earlier turns is in `turn.text`.
 */

/**
 * One pasted image of a turn, resolved from `chat_images` (src/chat/images.ts `resolveTurnImages`).
 * Phase 3's declaration, kept as is, plus `messageId` (phase 7).
 */
export interface ChatTurnImage {
  /** `chat_images.id` (`A-B32`). The model sees it as `[image upload:ID]`. */
  id: string;
  /** Absolute path of the `preview` derivative (`cache/c_<id>/preview.jpg`: long edge <= 1568 px, under 3.75 MB). */
  previewPath: string;
  /** Mime of the preview file. */
  previewMime: 'image/jpeg';
  /** Size of the original, display-oriented. */
  width: number;
  height: number;
  originalName: string | null;
  /** The chat message this image belongs to (phase 7). Set: its label reads `[image upload:ID] from [msg:K7F2]`. */
  messageId?: string;
}

/** Which model family answered. The stub reports none. */
export type ChatBrain = 'claude' | 'glm';

export type ChatEvent =
  /** -> `event: delta {"text": "..."}`. Concatenated, the deltas are the full reply. */
  | { type: 'delta'; text: string }
  /** -> `event: status {"text": "searching notes"}`. `""` clears the caption. */
  | { type: 'status'; text: string };

export interface ChatTurnEnd {
  /** The brain that answered. -> `done.brain`; omitted from `done` when undefined. */
  brain?: ChatBrain;
}

/**
 * One composed user turn: the whole prompt text (context blocks + current message) and the images
 * sent as image blocks. The agent reads each image's preview and shapes the SDK message with
 * phase 3's src/chat/compose.ts (`composeUserTurn` -> `toSdkPrompt`).
 */
export interface ComposedTurn {
  /** src/chat/context.ts layout. Identical for every brain and every attempt. */
  text: string;
  /** Current-turn images, then reply-target images, each with `messageId`. Earlier images are only labels inside `text`. */
  images: readonly ChatTurnImage[];
}

export interface ChatRequest {
  turn: ComposedTurn;
  /** Aborted when the HTTP client disconnects. Backends must stop yielding promptly. */
  signal: AbortSignal;
}

export interface ChatTurn {
  /** Events in order. Ends normally, or throws (-> `event: error`). */
  events: AsyncIterable<ChatEvent>;
  /** Valid only after `events` finished without throwing. */
  end(): ChatTurnEnd;
}

export interface ChatBackend {
  reply(request: ChatRequest): Promise<ChatTurn>;
}
```

### Step 11: Extend P3's `composeUserTurn` (do not fork it)

**File:** `src/chat/compose.ts` (P3's file, Step 5 there). `ChatTurnImage.messageId?` is added in Step 10 (backend.ts). Three edits; `uploadTag`, `ComposedImage`, `UserTurn`, `composePromptText`, `userTurnContent` and `toSdkPrompt` stay exactly as P3 wrote them.

**Change 1:** `ComposeInput` (replace P3's interface) lets an image carry the message it belongs to:
```ts
export interface ComposeInput {
  message: string;
  /** `messageId` (phase 7): the chat message the image belongs to; it is then labelled `from [msg:ID]`. */
  images: readonly Pick<ChatTurnImage, 'id' | 'previewMime' | 'messageId'>[];
}
```
**Change 2:** add after `composePromptText`:
```ts
/** `[image upload:ID]`, plus ` from [msg:K7F2]` when the image belongs to a known chat message (phase 7). */
export function imageLabel(image: { id: string; messageId?: string }): string {
  return image.messageId === undefined ? uploadTag(image.id) : `${uploadTag(image.id)} from [msg:${image.messageId}]`;
}

/**
 * The text block of a rebuilt wall turn (phase 7): the context text, then one label per image in
 * the order the image blocks are shown. The context lines already name every image; this tells the
 * model which picture above is which, including reply-target pictures from another message.
 */
export function composeLabelledText(message: string, images: readonly { id: string; messageId?: string }[]): string {
  if (images.length === 0) return message;
  const header =
    images.length === 1
      ? 'The picture shown above is:'
      : `The ${images.length} pictures shown above are, in this order:`;
  return `${message}\n\n${[header, ...images.map(imageLabel)].join('\n')}`;
}
```
**Change 3:** in `composeUserTurn`, choose the text: P3's wording when no image carries a `messageId` (every P3 caller and test), the labelled form otherwise. Replace P3's `text: composePromptText(...)` property with:
```ts
    text: input.images.some((image) => image.messageId !== undefined)
      ? composeLabelledText(input.message, input.images)
      : composePromptText(
          input.message,
          input.images.map((image) => image.id),
        ),
```
**Impact:** P3's `tests/unit/chat-compose.test.ts` still passes unchanged (no `messageId` in its inputs). Every rebuilt wall turn sets `messageId` on its images (Step 15), so the model reads `[image upload:C-AB12] from [msg:K7F2]`.

### Step 12: Agent backend: composed prompt, no resume, no session persistence

**File:** `src/chat/agent.ts`. The edits are against the file as P3 left it (P3 Step 6: `readPreview`, `ChatRun.userTurn()`, `toSdkPrompt` in `attempt`). Line numbers are main's, as P3's Step 6 cites them.

**12a, imports.** P3's import block stays as it is except the `./backend.js` line, which no longer needs anything new (the request now carries `turn`); P3's block already reads:
```ts
import { readFile } from 'node:fs/promises';
import {
  query as sdkQuery,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { ChatBackend, ChatBrain, ChatEvent, ChatRequest, ChatTurn, ChatTurnEnd } from './backend.js';
import { composeUserTurn, toSdkPrompt, type UserTurn } from './compose.js';
import { claudeEnv, glmEnv, resolveExecutable } from './env.js';
import { buildChatSystemPrompt } from './prompt.js';
import { NOTES_MCP_SERVER, WEB_TOOL_NAMES, allowedChatTools, captionForToolUse } from './status.js';
```
No change to it.
**12b, `QueryFn`.** Unchanged from P3:
```ts
/** The slice of the SDK's `query` the backend uses. Tests inject a fake. A turn with images passes a one-message stream. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;
```
**12c, `AgentChatOptions.cwd` doc** (in P3's `AgentChatOptions`; `readPreview` stays):
```ts
  /** Fixed cwd of every run (`<dataDir>/chat`). Sessions are not persisted (`persistSession: false`); the cwd only keeps the child out of the daemon's own directory. */
  cwd: string;
```
**12d, `ChatRun.userTurn()`** (P3's method, after `end()`). Replace it: the turn now comes composed from our rows, and its images carry `messageId`:
```ts
  /**
   * Reads each image's preview once and shapes the turn with phase 3's composeUserTurn. Built once
   * per run, so the GLM fallback gets exactly the prompt claude got. A missing file fails the turn
   * without a fallback.
   */
  private userTurn(): Promise<UserTurn> {
    this.turnLoad ??= (async (): Promise<UserTurn> => {
      const { text, images } = this.request.turn;
      const previews: string[] = [];
      for (const image of images) {
        let bytes: Uint8Array;
        try {
          bytes = await this.deps.readPreview(image.previewPath);
        } catch (err) {
          throw new AttemptError(`Could not read pasted image ${image.id}: ${errorText(err)}`, false);
        }
        previews.push(Buffer.from(bytes).toString('base64'));
      }
      return composeUserTurn({ message: text, images }, previews);
    })();
    return this.turnLoad;
  }
```
**12e, `RunDeps`** (P3's version minus `resume`):
```ts
interface RunDeps {
  chat: AgentChatConfig;
  query: QueryFn;
  log: (line: string) => void;
  optionsFor: (brain: ChatBrain, abortController: AbortController) => Options;
  readPreview: (absPath: string) => Promise<Uint8Array>;
}
```
**12f, `ChatRun.attempt`** (P3's method). Replace the whole method; against P3 only two lines differ (`optionsFor(brain, controller)` and `this.outcome = { brain }`):
```ts
  private async *attempt(brain: ChatBrain): AsyncGenerator<ChatEvent> {
    if (this.reason !== null) throw new Error('stopped');
    const turn = await this.userTurn();
    // A stop during the preview read must not start a run: the relay below would never fire.
    if (this.reason !== null) throw new Error('stopped');
    const controller = new AbortController();
    const relay = (): void => controller.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener('abort', relay, { once: true });

    let lastError: SDKAssistantMessageError | null = null;
    let failure: AttemptError | null = null;
    let succeeded = false;
    let drained = false;
    try {
      const messages = this.deps.query({
        // A fresh one-message stream per attempt (a stream can be read once); text-only: the plain string.
        prompt: toSdkPrompt(turn),
        options: this.deps.optionsFor(brain, controller),
      });
      for await (const message of messages) {
        if (this.reason !== null) break;
        if (message.type === 'stream_event') {
          if (message.parent_tool_use_id !== null) continue;
          const event = message.event;
          if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;
          let text = event.delta.text;
          if (text === '') continue;
          if (this.caption !== '') {
            this.caption = '';
            yield { type: 'status', text: '' };
          }
          if (this.emittedText && this.toolSinceText) text = `\n\n${text.replace(/^\s+/, '')}`;
          this.toolSinceText = false;
          this.emittedText = true;
          yield { type: 'delta', text };
        } else if (message.type === 'assistant') {
          if (message.parent_tool_use_id !== null) continue;
          if (message.error !== undefined) lastError = message.error;
          for (const block of message.message.content) {
            if (block.type !== 'tool_use') continue;
            this.toolSinceText = true;
            const caption = captionForToolUse(block.name, block.input);
            if (caption !== null && caption !== this.caption) {
              this.caption = caption;
              yield { type: 'status', text: caption };
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && !message.is_error) {
            this.outcome = { brain };
            succeeded = true;
          } else {
            failure = resultFailure(message, lastError, this.deps.chat.maxTurns);
          }
        }
      }
      drained = this.reason === null;
    } catch (err) {
      if (this.reason !== null) throw err;
      // A CLI that exits non-zero after its result still produced that result: trust the result.
      if (!succeeded && failure === null) {
        const text = errorText(err);
        failure = new AttemptError(text, isFallbackable(text, lastError));
      }
    } finally {
      this.controller.signal.removeEventListener('abort', relay);
      if (!drained) controller.abort();
    }
    if (this.reason !== null) throw new Error('stopped');
    if (failure !== null) throw failure;
    if (!succeeded) {
      throw new AttemptError('The agent ended without an answer.', lastError !== null && FALLBACK_ERRORS.has(lastError));
    }
  }
```
**12g, `createAgentChatBackend`** (P3's version). Replace the whole function; against P3 it drops `resume` and adds `persistSession: false`:
```ts
/**
 * The real chat brain: one Claude Agent SDK run per message. The run is stateless: no `resume`,
 * no session written to ~/.claude/projects (`persistSession: false`). Continuity comes from the
 * composed turn, which src/chat/turn.ts rebuilds from our own rows, so claude and the glm fallback
 * see the same conversation. Single user: a new reply() stops the run in flight.
 */
export function createAgentChatBackend(options: AgentChatOptions): AgentChatBackend {
  const { chat, cwd, mcpUrl } = options;
  const query: QueryFn = options.query ?? sdkQuery;
  const now = options.now ?? (() => new Date());
  const baseEnv = options.baseEnv ?? process.env;
  const log = options.log ?? ((line: string) => console.warn(line));
  const readPreview = options.readPreview ?? ((absPath: string): Promise<Uint8Array> => readFile(absPath));
  const claudeBin = resolveExecutable(chat.claudeBin, baseEnv.PATH);
  const allowedTools = allowedChatTools();

  function optionsFor(brain: ChatBrain, abortController: AbortController): Options {
    const glm = chat.glm;
    if (brain === 'glm' && glm === null) {
      throw new AttemptError('CHAT_BRAIN=glm needs LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.', false);
    }
    return {
      abortController,
      cwd,
      env: brain === 'glm' && glm !== null ? glmEnv(baseEnv, glm) : claudeEnv(baseEnv),
      model: brain === 'glm' && glm !== null ? glm.model : undefined,
      pathToClaudeCodeExecutable: claudeBin,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { [NOTES_MCP_SERVER]: { type: 'http', url: mcpUrl(), alwaysLoad: true } },
      tools: [...WEB_TOOL_NAMES],
      allowedTools,
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      maxTurns: chat.maxTurns,
      systemPrompt: buildChatSystemPrompt(now()),
      persistSession: false,
    };
  }

  const deps: RunDeps = { chat, query, log, optionsFor, readPreview };
  let current: ChatRun | null = null;

  return {
    async reply(request: ChatRequest): Promise<ChatTurn> {
      if (current !== null && current.active) current.stop('superseded');
      const run = new ChatRun(deps, request);
      current = run;
      return {
        events: run.events(),
        end: () => run.end(),
      };
    },
    close(): void {
      if (current !== null && current.active) current.stop('closed');
    },
  };
}
```
**SDK check (done during planning):** `persistSession?: boolean` exists in the installed `@anthropic-ai/claude-agent-sdk@0.3.311` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1863`, "When false, disables session persistence to disk ... cannot be resumed later"). The cwd stays.
**Impact:** `ChatRun.end()` now returns `{ brain }`. No caller reads `threadId` after Steps 13-16. P3's preview reading, `composeUserTurn` and `toSdkPrompt` path is reused as is, so a text-only turn still passes the plain string (now the composed context text) and an image turn a fresh one-message stream per attempt.

### Step 13: Stub backend

**File:** `src/chat/stub.ts` (replace the whole file)
**Code:**
```ts
import type { ChatBackend, ChatEvent, ChatRequest, ChatTurn } from './backend.js';

export const STUB_REPLY =
  'The chat brain arrives in iteration 4. Until then this panel only echoes that fact.';

export interface StubChatOptions {
  /** Delay before each delta, in ms. Default 40. Tests pass 0. */
  delayMs?: number;
}

/** Splits text into word-sized pieces that keep their trailing whitespace. */
export function splitIntoDeltas(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function* streamDeltas(
  parts: string[],
  delayMs: number,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  for (const part of parts) {
    if (signal.aborted) return;
    if (delayMs > 0) await sleep(delayMs, signal);
    if (signal.aborted) return;
    yield { type: 'delta', text: part };
  }
}

/** A fixed reply as word deltas. No status events and no brain; the turn's text is ignored. */
export function createStubChatBackend(options: StubChatOptions = {}): ChatBackend {
  const delayMs = options.delayMs ?? 40;
  return {
    async reply(request: ChatRequest): Promise<ChatTurn> {
      return {
        events: streamDeltas(splitIntoDeltas(STUB_REPLY), delayMs, request.signal),
        end: () => ({}),
      };
    },
  };
}
```

### Step 14: System prompt teaches the layout and `[msg:ID]`

**File:** `src/chat/prompt.ts`
**Change 1, import (line 1).** Add `import { OMITTED_LINE } from './context.js';` after the existing import.
**Change 2.** In `buildChatSystemPrompt`, add these two entries to the end of the `sections` array, after the "Write plain prose..." entry (today line 31). P4 and P6 only rewrote the pictures element (line 27, files sentence and `similar_images`/`[image upload:ID]` sentence); leave it as they left it:
```ts
    `Every message from the owner reaches you in the same layout. <chat_history>, when present, holds the earlier messages of this conversation, oldest first; a line "${OMITTED_LINE}" means older ones were left out to save space. <reply_to>, when present, is the message the owner is replying to, possibly from another conversation. <message> is what the owner is asking now: answer that. Each message is one line that starts with its label, its role and its time in WIB (Asia/Jakarta), for example [msg:K7F2] user (2026-10-31 09:15 WIB): ... You see only the text of earlier answers, not the tool results behind them, so call the tools again when you need the data. Pictures appear as [image upload:ID]: you see the pictures of the current message and of the message being replied to; earlier pictures appear only by that label.`,

    `You may reply to one particular earlier message by starting your answer with its label exactly, for example "[msg:K7F2] " followed by your answer. The page hides the label and shows your answer as a reply to that message. Replying is optional: do it only when your answer is about one specific earlier message, never for the current message, and never invent a label. Do not write message labels anywhere else in your answer.`,
```

### Step 15: Turn composition (rows -> prompt -> image blocks)

**File:** `src/chat/turn.ts` (new)
**Code:**
```ts
import type { ChatTurnImage, ComposedTurn } from './backend.js';
import { buildTurnContext } from './context.js';
import { resolveTurnImages, type ChatImageStoreDeps } from './images.js';
import type { ChatService } from './service.js';

export type ImageSource = Pick<ChatImageStoreDeps, 'db' | 'dataDir'>;

export interface WallTurnInput {
  threadId: string;
  /** The user row just written by ChatService.addUserMessage. */
  currentMessageId: string;
  /** That row's images, already resolved (and validated) by the route with phase 3's resolveTurnImages. */
  currentImages: readonly ChatTurnImage[];
}

/**
 * Our rows -> context text (src/chat/context.ts) -> the images sent as blocks. Images of the reply
 * target are resolved here; one that cannot be (not on this machine, gone, unreadable) stays a label
 * in the text only. Preview bytes are read later by the agent (phase 3's `readPreview`).
 */
export async function composeWallTurn(chat: ChatService, source: ImageSource, input: WallTurnInput): Promise<ComposedTurn> {
  const context = await chat.loadTurnContext(input.threadId, input.currentMessageId);
  const built = buildTurnContext(context);
  const byId = new Map<string, ChatTurnImage>(input.currentImages.map((image) => [image.id, image]));
  for (const wanted of built.images) {
    if (byId.has(wanted.id)) continue;
    try {
      const [loaded] = await resolveTurnImages(source, [wanted.id]);
      if (loaded !== undefined) byId.set(wanted.id, loaded);
    } catch {
      // Label only: the model is told the picture exists but cannot see it.
    }
  }
  const images: ChatTurnImage[] = [];
  for (const wanted of built.images) {
    const loaded = byId.get(wanted.id);
    if (loaded !== undefined) images.push({ ...loaded, messageId: wanted.messageId });
  }
  return { text: built.text, images };
}
```

### Step 16: HTTP: `POST /api/chat` and `event: chat`

**File:** `src/http/api.ts`

**16a, imports (lines 1-11 of main, as P3 Step 8 left them).** Replace them with the following. P4 and P6 add no import to this file; P3's chat-image imports are kept, `ChatEvent`/`ChatTurnImage` move as shown:
```ts
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ChatBackend, ChatBrain, ChatTurnImage } from '../chat/backend.js';
import { CitationFilter } from '../chat/citation.js';
import type { ChatChange } from '../chat/events.js';
import { normalizeMessageId } from '../chat/ids.js';
import {
  ChatImageLookupError,
  chatImageStoreFor,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  resolveTurnImages,
  type ChatImageLookupErrorCode,
} from '../chat/images.js';
import type { UserTurnStart } from '../chat/service.js';
import { createStubChatBackend } from '../chat/stub.js';
import { composeWallTurn } from '../chat/turn.js';
import type { AppDeps } from '../deps.js';
import type { NoteEvent } from '../notes/events.js';
import { normalizeId } from '../notes/ids.js';
import { MAX_LIMIT } from '../notes/repo.js';
import { NoteError } from '../notes/types.js';
import { chatErrorResponse } from './chatApi.js';
import { sameOriginOnly } from './sameOrigin.js';
```
**16b, `chatSchema` (as P3 Step 8 left it).** Replace P3's `chatSchema` with the one below. Keep P3's `chatImageErrorStatus` helper that follows it unchanged (400 `unknown_image`, 409 `not_on_this_machine`, 422 `unreadable_image`):
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
  })
  .refine((body) => body.message.length > 0 || body.image_ids.length > 0, {
    message: 'a message or at least one image is required',
    path: ['message'],
  });

/** `event: done` of POST /api/chat. */
interface ChatDone {
  /** OUR thread id (chat_threads.id). */
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  /** The bubble the answer replies to (leading `[msg:ID]`), or null. */
  reply_to: string | null;
  brain?: ChatBrain;
}
```
**16c.** Add `export` to `function describeIssues` (line 39) and to `async function readJson` (line 71). The bodies do not change.
**16d.** Delete `chatEventName` (lines 89-97).
**16e, start of `apiRoutes` (lines 99-103).**
```ts
export function apiRoutes(deps: AppDeps, options: ApiOptions = {}): Hono {
  const api = new Hono();
  const service = deps.service;
  const history = deps.chat;
  const backend = options.chat ?? createStubChatBackend();
  const heartbeatMs = options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;
```
**16f, `/api/events` (lines 221-244).** Replace the whole route:
```ts
  api.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      const onNote = (event: NoteEvent): void => {
        if (closed) return;
        void stream
          .writeSSE({ event: 'note', data: JSON.stringify({ op: event.op, id: event.id }) })
          .catch(() => undefined);
      };
      const onChat = (change: ChatChange): void => {
        if (closed) return;
        void stream
          .writeSSE({
            event: 'chat',
            data: JSON.stringify({ op: change.op, thread_id: change.thread_id, id: change.id }),
          })
          .catch(() => undefined);
      };
      const unsubscribeNote = deps.events.on(onNote);
      const unsubscribeChat = history.events.on(onChat);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(timer);
          unsubscribeNote();
          unsubscribeChat();
          resolve();
        });
        void stream.write(': connected\n\n').catch(() => undefined);
      });
    }),
  );
```
**16g, `POST /api/chat` (P3 Step 8's route).** Replace the whole route. Image resolution and its JSON errors are P3's, unchanged, and still happen before anything is written or streamed:
```ts
  /**
   * One wall chat turn. Order: validate -> write the user row (it survives any later failure) ->
   * `event: accepted` -> rebuild context from our rows -> stream (a leading `[msg:ID]` is held back
   * and stripped) -> on a clean finish only, write the assistant row -> `event: done`. A client
   * abort persists nothing for the answer. An unknown thread_id (e.g. an Agent SDK session id from
   * before phase 7) starts a new thread.
   */
  api.post('/api/chat', async (c) => {
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = chatSchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    const { message, thread_id, reply_to, image_ids } = parsed.data;

    let replyTo: string | null = null;
    if (reply_to !== undefined) {
      replyTo = normalizeMessageId(reply_to);
      if (replyTo === null) return badRequest(c, 'invalid_reply_to');
    }
    let currentImages: ChatTurnImage[] = [];
    if (image_ids.length > 0) {
      try {
        currentImages = await resolveTurnImages(chatImageStoreFor(deps), image_ids);
      } catch (err) {
        if (!(err instanceof ChatImageLookupError)) throw err;
        return c.json({ error: err.code, id: err.imageId, message: err.message }, chatImageErrorStatus(err.code));
      }
    }
    let start: UserTurnStart;
    try {
      start = await history.addUserMessage({
        threadId: thread_id ?? null,
        source: 'wall',
        text: message,
        attachments: currentImages.map((image) => ({ kind: 'chat_image' as const, id: image.id })),
        replyTo,
      });
    } catch (err) {
      return chatErrorResponse(c, err);
    }
    const threadId = start.thread.id;
    const userMessageId = start.message.id;

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const send = (event: string, data: unknown): Promise<void> =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      try {
        await send('accepted', { thread_id: threadId, user_message_id: userMessageId });
        const composed = await composeWallTurn(history, chatImageStoreFor(deps), {
          threadId,
          currentMessageId: userMessageId,
          currentImages,
        });
        if (controller.signal.aborted) return;
        const turn = await backend.reply({ turn: composed, signal: controller.signal });
        const citation = new CitationFilter();
        for await (const event of turn.events) {
          if (controller.signal.aborted) return;
          if (event.type === 'delta') {
            const text = citation.push(event.text);
            if (text !== '') await send('delta', { text });
          } else {
            const held = citation.flush();
            if (held !== '') await send('delta', { text: held });
            await send('status', { text: event.text });
          }
        }
        if (controller.signal.aborted) return;
        const tail = citation.end();
        if (tail !== '') await send('delta', { text: tail });
        const end = turn.end();
        const cited = citation.replyTo;
        const answerReplyTo =
          cited !== null && cited !== userMessageId && (await history.liveMessageExists(cited)) ? cited : null;
        if (controller.signal.aborted) return;
        const answer = await history.addAssistantMessage({
          threadId,
          text: citation.text,
          brain: end.brain ?? null,
          replyTo: answerReplyTo,
        });
        const done: ChatDone = {
          thread_id: threadId,
          user_message_id: userMessageId,
          assistant_message_id: answer.id,
          reply_to: answerReplyTo,
        };
        if (end.brain !== undefined) done.brain = end.brain;
        await send('done', done);
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        await send('error', { error });
      }
    });
  });
```
**Impact:** the SSE stream gains `accepted` first and a richer `done`. The web client ignores `accepted` and reads `done.thread_id`, which is now our thread id, so a follow-up continues our thread.

### Step 17: History routes

**File:** `src/http/chatApi.ts` (new)
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT } from '../chat/service.js';
import { ChatError } from '../chat/types.js';
import type { AppDeps } from '../deps.js';
import { sameOriginOnly } from './sameOrigin.js';

/** The one ChatError -> HTTP mapping. Anything else is rethrown (Hono answers 500). */
export function chatErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof ChatError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'thread_not_found':
    case 'reply_not_found':
      return c.json({ error: err.code }, 404);
    case 'conflict':
      return c.json({ error: err.code }, 409);
    case 'invalid_id':
    case 'not_editable':
    case 'empty_text':
    case 'invalid_cursor':
      return c.json({ error: err.code }, 400);
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

const flag = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true');

const timelineQuery = z.object({
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TIMELINE_LIMIT).default(DEFAULT_TIMELINE_LIMIT),
  include_deleted: flag,
});

const editBody = z.object({ text: z.string() });

/**
 * Chat history (phase 7). Reads are open like the rest of /api; mutations are same-origin only,
 * like purge and reveal. Every timestamp is UTC ISO; the page renders WIB.
 */
export function chatHistoryRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  const chat = deps.chat;

  /** The unified timeline: `{messages (ascending), next_before}`; follow next_before for older pages. */
  api.get('/api/chat/messages', async (c) => {
    const parsed = timelineQuery.safeParse({
      before: c.req.query('before'),
      limit: c.req.query('limit'),
      include_deleted: c.req.query('include_deleted'),
    });
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    try {
      return c.json(
        await chat.listTimeline({
          before: parsed.data.before ?? null,
          limit: parsed.data.limit,
          includeDeleted: parsed.data.include_deleted,
        }),
      );
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  api.get('/api/chat/threads/:id', async (c) => {
    const include = flag.safeParse(c.req.query('include_deleted'));
    if (!include.success) return c.json({ error: describeIssues(include.error) }, 400);
    const detail = await chat.getThread(c.req.param('id'), { includeDeleted: include.data });
    if (detail === null) return c.json({ error: 'not_found' }, 404);
    return c.json(detail);
  });

  /** Edit a user message: `{text}`, non-blank. The old text is kept as a revision. */
  api.patch('/api/chat/messages/:id', sameOriginOnly, async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
    const parsed = editBody.safeParse(json.value);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    try {
      return c.json(await chat.editMessage(c.req.param('id'), parsed.data.text));
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  /** Soft delete; `?with_answer=1` on a question deletes its answer too. `{deleted: [ids]}`. */
  api.delete('/api/chat/messages/:id', sameOriginOnly, async (c) => {
    const withAnswer = flag.safeParse(c.req.query('with_answer'));
    if (!withAnswer.success) return c.json({ error: describeIssues(withAnswer.error) }, 400);
    try {
      return c.json(await chat.deleteMessage(c.req.param('id'), { withAnswer: withAnswer.data }));
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  api.post('/api/chat/messages/:id/restore', sameOriginOnly, async (c) => {
    try {
      return c.json(await chat.restoreMessage(c.req.param('id')));
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  return api;
}
```

### Step 18: Mount the routes

**File:** `src/http/app.ts`
The file as P3 (chatImageRoutes), P4 (fileRoutes) and P6 (`mcpToolDeps` passes `imageEmbedder`/`chatUploads`) left it.
**Change 1:** add `import { chatHistoryRoutes } from './chatApi.js';` after the `apiRoutes` import.
**Change 2:** after `app.route('/', apiRoutes(deps, { chat: options.chat }));`, add:
```ts
  app.route('/', chatHistoryRoutes(deps));
```
**Change 3:** the `createApp` doc comment (P4's text) becomes:
```ts
/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), chatHistoryRoutes (chat history phase 7), imageRoutes (P5),
 * chatImageRoutes (pasted chat images), fileRoutes (note files), revealRoutes (iteration 7:
 * capabilities + reveal; note files add file and note reveal), staticRoutes (P6, last: it owns the
 * SPA fallback; it reserves /api, so the order is for clarity).
 */
```
Order among the `/api` routers does not matter: `/api/chat/images/*` (P3) and `/api/chat/messages*`, `/api/chat/threads/*` (here) do not overlap. `mcpToolDeps` (P6) is untouched.

### Step 19: AppDeps and daemon

**File:** `src/deps.ts` (whole file; P6's version plus `chat`. P3 and P4 add no field):
```ts
import type { ChatService } from './chat/service.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Embedder } from './embeddings/embedder.js';
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
import type { NoteEvents } from './notes/events.js';
import type { NotesService } from './notes/service.js';

/** Everything the daemon wires together once at startup and hands to routes and background jobs. */
export interface AppDeps {
  config: Config;
  db: Db;
  events: NoteEvents;
  service: NotesService;
  /** Null without OPENROUTER_API_KEY (or when a test injects null): semantic features off. */
  embedder: Embedder | null;
  /** Gemini image embedder for `similar_images` and the image worker. Null: image search off. */
  imageEmbedder: ImageEmbedder | null;
  /** Chat history: threads, messages, edits, deletes (phase 7). The only writer of the chat tables. */
  chat: ChatService;
}
```
**File:** `src/daemon.ts`
- Add `import { ChatService } from './chat/service.js';`.
- Replace the `CHAT_SUBDIR` comment (line 17):
```ts
/** `<dataDir>/chat`: the fixed cwd of every chat brain run. Sessions are not persisted there (persistSession: false). */
```
- After `const service = new NotesService(...)` (line 74):
```ts
  const chatHistory = new ChatService({ db });
```
- In the `AppDeps` literal (P6 left it as `{ config, db, events, service, embedder, imageEmbedder }`), add `chat: chatHistory`:
```ts
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory };
```

### Step 20: Test infrastructure

**20a.** In `tests/integration/setup.ts` `truncateAll`, prepend `chat_message_attachments, chat_message_revisions, chat_messages, chat_threads` to the list P6 left (`note_image_embeddings, note_files, chat_images, note_images, note_embeddings, note_revisions, notes`). After this phase the statement reads:
```ts
  await db.execute(sql`truncate table chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, note_files, chat_images, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```
`restart identity` also resets `chat_messages.seq` and the revision ids.

**20b.** For `tests/integration/imageHarness.ts`, `tests/integration/connectors/mcp.int.test.ts`, `tests/integration/embeddings.worker.int.test.ts`, `tests/integration/related.int.test.ts`, `tests/integration/mcp.tools.int.test.ts` and `tests/integration/images.int.test.ts` (two literals): add `import { ChatService } from '<relative>/src/chat/service.js';` and the field `chat: new ChatService({ db })` after P6's `imageEmbedder` in every `AppDeps` literal. The literals after this phase:
- `tests/integration/connectors/mcp.int.test.ts` and `tests/integration/mcp.tools.int.test.ts`: `const deps: AppDeps = { config, db, events, service, embedder: null, imageEmbedder: null, chat: new ChatService({ db }) };`
- `tests/integration/related.int.test.ts`: `const deps: AppDeps = { config, db, events, service, embedder: fake, imageEmbedder: null, chat: new ChatService({ db }) };`
- `tests/integration/images.int.test.ts` (both literals): after `imageEmbedder: null,` add `chat: new ChatService({ db }),`.
- `tests/integration/embeddings.worker.int.test.ts` `deps(embedder)`: after `imageEmbedder: null,` add `chat: new ChatService({ db }),`.
- `tests/integration/imageHarness.ts` (P3's `startHarness(options)` as P6 merged it, `options: { chat?: ChatBackend; imageEmbedder?: ImageEmbedder | null }`; P4 added `files` to its subdirs): the literal becomes
```ts
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG },
    db,
    events,
    service,
    embedder: null,
    imageEmbedder: options.imageEmbedder ?? null,
    chat: new ChatService({ db }),
  };
```
  Nothing else in the harness changes; `options.chat` (the `ChatBackend` passed to `createApp`) is unrelated to `deps.chat` (the `ChatService`).
`tests/unit/mcp.instructions.test.ts:125` casts through `unknown` and needs no change.

**20c.** `tests/integration/helpers/api-harness.ts` (replace the whole file; the only earlier change to it is P6's `imageEmbedder: null`, kept below):
```ts
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ChatBackend } from '../../../src/chat/backend.js';
import { ChatService } from '../../../src/chat/service.js';
import { createStubChatBackend } from '../../../src/chat/stub.js';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG } from '../../../src/config.js';
import type { AppDeps } from '../../../src/deps.js';
import { apiRoutes } from '../../../src/http/api.js';
import { chatHistoryRoutes } from '../../../src/http/chatApi.js';
import { NoteEvents } from '../../../src/notes/events.js';
import { generateId } from '../../../src/notes/ids.js';
import { NotesService } from '../../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl } from '../setup.js';

/** The Origin `app.request('/api/...')` counts as same-origin (its URL is http://localhost/...). */
export const SAME_ORIGIN = { origin: 'http://localhost' } as const;

export interface ApiHarness {
  app: Hono;
  deps: AppDeps;
  notes: NotesService;
  events: NoteEvents;
  chat: ChatService;
  request(pathname: string, init?: RequestInit): Promise<Response>;
  sendJson(method: string, pathname: string, payload: unknown, headers?: Record<string, string>): Promise<Response>;
  insertImageNote(tag: string): Promise<string>;
  close(): Promise<void>;
}

export interface ApiHarnessOptions {
  sseHeartbeatMs?: number;
  /** The chat backend behind /api/chat. Default: the stub with no delay. */
  chat?: ChatBackend;
}

/** A tag no other test uses, e.g. `t3f9a1c2e`. */
export function uniqueTag(): string {
  return `t${randomBytes(5).toString('hex')}`;
}

export async function createApiHarness(options: ApiHarnessOptions = {}): Promise<ApiHarness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-api-'));
  const db = openTestDb();
  const events = new NoteEvents();
  const notes = new NotesService({ db, events, dataDir });
  const chat = new ChatService({ db });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG },
    db,
    events,
    service: notes,
    embedder: null,
    imageEmbedder: null,
    chat,
  };
  const app = new Hono();
  app.route(
    '/',
    apiRoutes(deps, {
      chat: options.chat ?? createStubChatBackend({ delayMs: 0 }),
      ...(options.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: options.sseHeartbeatMs } : {}),
    }),
  );
  app.route('/', chatHistoryRoutes(deps));

  return {
    app,
    deps,
    notes,
    events,
    chat,
    request: (pathname, init) => Promise.resolve(app.request(pathname, init)),
    sendJson: (method, pathname, payload, headers = {}) =>
      Promise.resolve(
        app.request(pathname, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
        }),
      ),
    async insertImageNote(tag: string): Promise<string> {
      const id = generateId();
      const meta = {
        sha256: randomBytes(32).toString('hex'),
        mime: 'image/jpeg',
        width: 10,
        height: 10,
        bytes: 100,
        taken_at: null,
        original_name: 'x.jpg',
        host: 'test-host',
      };
      await db.execute(sql`
        INSERT INTO notes (id, body, tags, origin, created_at, updated_at)
        VALUES (${id}, ${`photo #${tag}`}, ARRAY[${tag}]::text[], ${JSON.stringify({ source: 'test' })}::jsonb, now(), now())
      `);
      await db.execute(sql`
        INSERT INTO note_images (id, note_id, path, sha256, mime, width, height, bytes, taken_at, original_name, host, position, created_at)
        VALUES (${id}, ${id}, ${`images/2026/10/${id}.jpg`}, ${meta.sha256}, ${meta.mime}, ${meta.width}, ${meta.height},
                ${meta.bytes}, null, ${meta.original_name}, ${meta.host}, 0, now())
      `);
      return id;
    },
    async close(): Promise<void> {
      await closeTestDb(db);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
```
P3 and P4 do not change this harness (their routes are tested through `startHarness`).

**20d.** `tests/integration/helpers/scripted-chat.ts` (replace the whole file):
```ts
import type {
  ChatBackend,
  ChatEvent,
  ChatRequest,
  ChatTurn,
  ChatTurnEnd,
} from '../../../src/chat/backend.js';

/** One scripted step: an event to yield, an error to throw, or "wait until the request aborts". */
export type ScriptStep = ChatEvent | { type: 'throw'; message: string } | { type: 'hang' };

export interface ChatScript {
  steps: ScriptStep[];
  /** What `end()` returns. Default: `{}` (no brain). */
  end?: ChatTurnEnd;
  /** When set, `reply()` itself rejects with this message before any event. */
  rejectWith?: string;
}

export interface ScriptedChatBackend extends ChatBackend {
  /** Queues a script for the next `reply()`. A reply with nothing queued gets an empty script. */
  push(script: ChatScript): void;
  /** Every request received, in arrival order (composed turn and signal), so tests can read the prompt. */
  readonly requests: ChatRequest[];
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function* play(steps: ScriptStep[], signal: AbortSignal): AsyncGenerator<ChatEvent> {
  for (const step of steps) {
    if (signal.aborted) return;
    if (step.type === 'throw') throw new Error(step.message);
    if (step.type === 'hang') {
      await untilAborted(signal);
      return;
    }
    yield step;
  }
}

/** A `ChatBackend` that replays queued scripts: the fake injected into /api/chat tests. */
export function createScriptedChatBackend(): ScriptedChatBackend {
  const queue: ChatScript[] = [];
  const requests: ChatRequest[] = [];
  return {
    requests,
    push(script: ChatScript): void {
      queue.push(script);
    },
    async reply(request: ChatRequest): Promise<ChatTurn> {
      requests.push(request);
      const script = queue.shift() ?? { steps: [] };
      if (script.rejectWith !== undefined) throw new Error(script.rejectWith);
      const end: ChatTurnEnd = script.end ?? {};
      return { events: play(script.steps, request.signal), end: () => end };
    },
  };
}
```

### Step 21: Unit tests

**21a.** `tests/unit/chat-ids.test.ts` (new):
```ts
import { describe, expect, it } from 'vitest';
import { generateMessageId, isMessageId, messageLabel, normalizeMessageId } from '../../src/chat/ids.js';
import { ID_ALPHABET } from '../../src/notes/ids.js';

describe('chat message ids', () => {
  it('generates 4 characters from [0-9A-Z]', () => {
    for (let i = 0; i < 200; i += 1) expect(generateMessageId()).toMatch(/^[0-9A-Z]{4}$/);
  });

  it('uses the injected random source', () => {
    const picks = ['K', '7', 'F', '2'].map((ch) => ID_ALPHABET.indexOf(ch));
    expect(generateMessageId(() => picks.shift() ?? 0)).toBe('K7F2');
  });

  it('refuses an out-of-range random index', () => {
    expect(() => generateMessageId(() => 99)).toThrow(RangeError);
  });

  it('normalizes the forms people and models write', () => {
    expect(normalizeMessageId('k7f2')).toBe('K7F2');
    expect(normalizeMessageId(' K7F2 ')).toBe('K7F2');
    expect(normalizeMessageId('msg:k7f2')).toBe('K7F2');
    expect(normalizeMessageId('[msg:K7F2]')).toBe('K7F2');
  });

  it('rejects anything else, including note ids', () => {
    for (const bad of ['', 'K7F', 'K7F23', 'A-B32', '[msg:K7F2', 'msg K7F2', '[MSG:K7F]']) {
      expect(normalizeMessageId(bad)).toBeNull();
    }
    expect(isMessageId('K7F2')).toBe(true);
    expect(isMessageId('k7f2')).toBe(false);
  });

  it('labels ids as [msg:ID]', () => {
    expect(messageLabel('K7F2')).toBe('[msg:K7F2]');
  });
});
```

**21b.** `tests/unit/chat-citation.test.ts` (new):
```ts
import { describe, expect, it } from 'vitest';
import { CITATION_LOOKAHEAD, CitationFilter, parseLeadingCitation } from '../../src/chat/citation.js';

function run(chunks: string[]) {
  const filter = new CitationFilter();
  const out = chunks.map((chunk) => filter.push(chunk));
  const tail = filter.end();
  return { out, tail, text: filter.text, replyTo: filter.replyTo };
}

describe('parseLeadingCitation', () => {
  it('strips a leading marker and its following whitespace', () => {
    expect(parseLeadingCitation('[msg:k7f2]  Yes, that one.')).toEqual({ replyTo: 'K7F2', text: 'Yes, that one.' });
    expect(parseLeadingCitation('\n [msg:K7F2]Hi')).toEqual({ replyTo: 'K7F2', text: 'Hi' });
  });

  it('leaves text without a leading marker untouched', () => {
    expect(parseLeadingCitation('See [msg:K7F2] too')).toEqual({ replyTo: null, text: 'See [msg:K7F2] too' });
    expect(parseLeadingCitation('[1] first')).toEqual({ replyTo: null, text: '[1] first' });
    expect(parseLeadingCitation('[msg:K7F] short')).toEqual({ replyTo: null, text: '[msg:K7F] short' });
  });
});

describe('CitationFilter (streamed)', () => {
  it('strips a marker split across deltas and never emits any part of it', () => {
    const r = run(['[', 'msg:', 'K7', 'F2] Here', ' it is.']);
    expect(r.out).toEqual(['', '', '', 'Here', ' it is.']);
    expect(r.tail).toBe('');
    expect(r.replyTo).toBe('K7F2');
    expect(r.text).toBe('Here it is.');
  });

  it('releases an answer that does not start with [ immediately', () => {
    const r = run(['Hello', ' world']);
    expect(r.out).toEqual(['Hello', ' world']);
    expect(r.replyTo).toBeNull();
    expect(r.text).toBe('Hello world');
  });

  it('skips whitespace around the marker, also when it arrives in separate deltas', () => {
    const r = run(['  ', '[msg:k7f2]', '  ', '\n', 'Hi']);
    expect(r.out).toEqual(['', '', '', '', 'Hi']);
    expect(r.replyTo).toBe('K7F2');
    expect(r.text).toBe('Hi');
  });

  it('releases a bracket that cannot be a marker as soon as that is clear', () => {
    expect(run(['[1] first']).out).toEqual(['[1] first']);
    const r = run(['[msg:K7', '!']);
    expect(r.out).toEqual(['', '[msg:K7!']);
    expect(r.replyTo).toBeNull();
  });

  it('a marker later in the text is just text', () => {
    const r = run(['See ', '[msg:K7F2] too']);
    expect(r.out).toEqual(['See ', '[msg:K7F2] too']);
    expect(r.replyTo).toBeNull();
  });

  it('flushes a partial marker when the stream ends', () => {
    const r = run(['[ms']);
    expect(r.out).toEqual(['']);
    expect(r.tail).toBe('[ms');
    expect(r.text).toBe('[ms');
    expect(r.replyTo).toBeNull();
  });

  it('releases whitespace-only text once it passes the lookahead', () => {
    const r = run([' '.repeat(CITATION_LOOKAHEAD + 2)]);
    expect(r.out).toEqual([' '.repeat(CITATION_LOOKAHEAD + 2)]);
  });

  it('flush() with nothing held keeps waiting (tools usually run before the answer)', () => {
    const filter = new CitationFilter();
    expect(filter.flush()).toBe('');
    expect(filter.push('[msg:K7F2] ok')).toBe('ok');
    expect(filter.replyTo).toBe('K7F2');
  });

  it('flush() mid-prefix releases the held text and gives up on a marker', () => {
    const filter = new CitationFilter();
    expect(filter.push('[ms')).toBe('');
    expect(filter.flush()).toBe('[ms');
    expect(filter.push('g:K7F2]')).toBe('g:K7F2]');
    expect(filter.replyTo).toBeNull();
    expect(filter.text).toBe('[msg:K7F2]');
  });

  it('handles a marker glued to the text', () => {
    expect(run(['[msg:K7F2]Hello']).text).toBe('Hello');
  });
});
```

**21c.** `tests/unit/chat-context.test.ts` (new):
```ts
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LINE_CHAR_CAP,
  OMITTED_LINE,
  buildTurnContext,
  formatWib,
  renderMessageLine,
  type ContextMessage,
} from '../../src/chat/context.js';
import type { AttachmentRef } from '../../src/chat/types.js';

function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  iso: string,
  attachments: AttachmentRef[] = [],
): ContextMessage {
  return { id, role, text, createdAt: new Date(iso), attachments };
}

describe('formatWib', () => {
  it('renders Asia/Jakarta wall time with a WIB suffix', () => {
    expect(formatWib(new Date('2026-10-31T02:15:00Z'))).toBe('2026-10-31 09:15 WIB');
    expect(formatWib(new Date('2026-10-31T18:30:00Z'))).toBe('2026-11-01 01:30 WIB');
  });
});

describe('buildTurnContext', () => {
  it('renders history, then the current message, with labels and WIB times', () => {
    const ctx = buildTurnContext({
      history: [
        msg('K7F2', 'user', 'what did I save?', '2026-10-31T02:12:00Z'),
        msg('P0Q1', 'assistant', 'You saved A-B32.', '2026-10-31T02:12:30Z'),
      ],
      current: msg('Z9Z9', 'user', 'and last month?', '2026-10-31T02:15:00Z'),
      replyTarget: null,
    });
    expect(ctx.text).toBe(
      [
        '<chat_history>',
        '[msg:K7F2] user (2026-10-31 09:12 WIB): what did I save?',
        '[msg:P0Q1] assistant (2026-10-31 09:12 WIB): You saved A-B32.',
        '</chat_history>',
        '',
        '<message>',
        '[msg:Z9Z9] user (2026-10-31 09:15 WIB): and last month?',
        '</message>',
      ].join('\n'),
    );
    expect(ctx.images).toEqual([]);
    expect(ctx.omitted).toBe(0);
  });

  it('a first turn is only the message block', () => {
    const ctx = buildTurnContext({ history: [], current: msg('AAAA', 'user', 'hi', '2026-10-31T00:00:00Z'), replyTarget: null });
    expect(ctx.text).toBe('<message>\n[msg:AAAA] user (2026-10-31 07:00 WIB): hi\n</message>');
  });

  it('drops the oldest lines first when over budget and says so', () => {
    const history = [
      msg('AAA1', 'user', 'oldest '.repeat(10), '2026-10-31T00:00:00Z'),
      msg('AAA2', 'assistant', 'middle '.repeat(10), '2026-10-31T00:01:00Z'),
      msg('AAA3', 'user', 'newest '.repeat(10), '2026-10-31T00:02:00Z'),
    ];
    const budget = renderMessageLine(history[1]!).length + 1 + renderMessageLine(history[2]!).length + 1;
    const ctx = buildTurnContext({
      history,
      current: msg('CUR1', 'user', 'now', '2026-10-31T00:03:00Z'),
      replyTarget: null,
      budgetChars: budget,
    });
    expect(ctx.omitted).toBe(1);
    expect(ctx.text.startsWith(`<chat_history>\n${OMITTED_LINE}\n[msg:AAA2]`)).toBe(true);
    expect(ctx.text).not.toContain('[msg:AAA1]');
    expect(ctx.text).toContain('[msg:AAA3]');
  });

  it('keeps the omitted line even when nothing of the history fits', () => {
    const ctx = buildTurnContext({
      history: [msg('AAA1', 'user', 'x'.repeat(100), '2026-10-31T00:00:00Z')],
      current: msg('CUR1', 'user', 'now', '2026-10-31T00:03:00Z'),
      replyTarget: null,
      budgetChars: 10,
    });
    expect(ctx.text).toContain(`<chat_history>\n${OMITTED_LINE}\n</chat_history>`);
  });

  it('renders a reply target from another thread in full, with its images as blocks', () => {
    const ctx = buildTurnContext({
      history: [msg('H001', 'user', 'earlier', '2026-10-31T00:00:00Z', [{ kind: 'chat_image', id: 'C-OLD1' }])],
      current: msg('CUR1', 'user', 'like this one?', '2026-10-31T00:05:00Z', [{ kind: 'chat_image', id: 'C-NEW1' }]),
      replyTarget: msg('T001', 'assistant', 'That photo is red.', '2026-10-30T13:00:00Z', [
        { kind: 'chat_image', id: 'C-TGT1' },
        { kind: 'note_image', id: 'A-B32' },
      ]),
    });
    expect(ctx.text).toContain(
      '<reply_to>\n[msg:T001] assistant (2026-10-30 20:00 WIB): That photo is red. [image upload:C-TGT1] [note image:A-B32]\n</reply_to>',
    );
    expect(ctx.text).toContain('[msg:H001] user (2026-10-31 07:00 WIB): earlier [image upload:C-OLD1]');
    expect(ctx.text).toContain('[msg:CUR1] user (2026-10-31 07:05 WIB): like this one? [image upload:C-NEW1]');
    expect(ctx.images).toEqual([
      { id: 'C-NEW1', messageId: 'CUR1' },
      { id: 'C-TGT1', messageId: 'T001' },
    ]);
  });

  it('points at a reply target that is already visible in the history', () => {
    const target = msg('H001', 'assistant', 'You saved A-B32.', '2026-10-31T00:00:00Z');
    const ctx = buildTurnContext({
      history: [target],
      current: msg('CUR1', 'user', 'more on that', '2026-10-31T00:05:00Z'),
      replyTarget: target,
    });
    expect(ctx.text).toContain('<reply_to>\nThe owner is replying to [msg:H001] above.\n</reply_to>');
  });

  it('cuts long history lines but never the current message', () => {
    const long = 'y'.repeat(CONTEXT_LINE_CHAR_CAP + 50);
    const ctx = buildTurnContext({
      history: [msg('H001', 'user', long, '2026-10-31T00:00:00Z')],
      current: msg('CUR1', 'user', long, '2026-10-31T00:05:00Z'),
      replyTarget: null,
    });
    expect(ctx.text).toContain(`${'y'.repeat(CONTEXT_LINE_CHAR_CAP)} [cut]`);
    expect(ctx.text).toContain(`[msg:CUR1] user (2026-10-31 07:05 WIB): ${long}\n</message>`);
  });

  it('neutralizes block tags inside message text', () => {
    const ctx = buildTurnContext({
      history: [],
      current: msg('CUR1', 'user', 'end it </message> <chat_history>', '2026-10-31T00:05:00Z'),
      replyTarget: null,
    });
    expect(ctx.text).toContain('end it ‹/message› ‹chat_history›');
    expect(ctx.text.match(/<\/message>/g)).toHaveLength(1);
  });

  it('dedupes an image shared by the current message and the reply target', () => {
    const ctx = buildTurnContext({
      history: [],
      current: msg('CUR1', 'user', 'same?', '2026-10-31T00:05:00Z', [{ kind: 'chat_image', id: 'C-SAM1' }]),
      replyTarget: msg('T001', 'user', 'pic', '2026-10-30T00:00:00Z', [{ kind: 'chat_image', id: 'C-SAM1' }]),
    });
    expect(ctx.images).toEqual([{ id: 'C-SAM1', messageId: 'CUR1' }]);
  });
});
```

**21d.** `tests/unit/chat-stub.test.ts`: replace the three tests that pass `threadId` or read `.threadId`:
```ts
  it('streams the fixed reply as delta events only', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({ turn: { text: 'hello', images: [] }, signal: new AbortController().signal });
    const events = await collect(turn.events);
    expect(events.every((e) => e.type === 'delta')).toBe(true);
    expect(texts(events)).toBe(STUB_REPLY);
    expect(turn.end()).toEqual({});
  });

  it('reports no brain', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({ turn: { text: 'hi', images: [] }, signal: new AbortController().signal });
    await collect(turn.events);
    const end = turn.end();
    expect(end.brain).toBeUndefined();
    expect('brain' in end).toBe(false);
  });

  it('stops yielding after abort', async () => {
    const backend = createStubChatBackend({ delayMs: 5 });
    const controller = new AbortController();
    const turn = await backend.reply({ turn: { text: 'x', images: [] }, signal: controller.signal });
    const out: ChatEvent[] = [];
    for await (const event of turn.events) {
      out.push(event);
      if (out.length === 2) controller.abort();
    }
    expect(out).toHaveLength(2);
  });
```
Delete `'keeps a given thread id'`. Keep the two `splitIntoDeltas`/"iteration 4" tests.

**21e.** `tests/unit/chat-prompt.test.ts`: append inside the `describe`:
```ts
  it('explains the context layout the turn arrives in', () => {
    expect(prompt).toContain('<chat_history>');
    expect(prompt).toContain('<reply_to>');
    expect(prompt).toContain('<message>');
    expect(prompt).toContain('[earlier messages omitted]');
    expect(prompt).toContain('WIB (Asia/Jakarta)');
    expect(prompt).toContain('[image upload:ID]');
  });

  it('teaches the optional leading [msg:ID] reply', () => {
    expect(prompt).toContain('[msg:K7F2]');
    expect(prompt).toMatch(/starting your answer with its label/);
    expect(prompt).toMatch(/Replying is optional/);
    expect(prompt).toMatch(/never for the current message, and never invent a label/);
  });
```

**21f.** `tests/unit/chat-agent.test.ts`, edited against the file as P3 left it (P3 Step 12: imports with `ChatTurnImage` and `SDKUserMessage`, `QueryCall`/`fakeQuery` recording the union prompt, `backend(query, chat, extra)`, the `pasted images` describe with `RED`, `BLUE`, `readPreview`, `sentMessages`, `b64`):
- Imports: unchanged (P3's already has `SDKUserMessage`, `AgentChatOptions` and `ChatTurnImage`).
- `fakeQuery`: unchanged (P3's records `Parameters<QueryFn>[0]`).
- `req` helper (P3's 4-argument version) becomes:
```ts
function req(text: string, signal = new AbortController().signal, images: ChatTurnImage[] = []): ChatRequest {
  return { turn: { text, images }, signal };
}
```
  Change every `req(<text>, null, <signal>)` call to `req(<text>, <signal>)`. These are in "stops the run when the client disconnects", "never starts a run for an already-closed request" and "does not retry after a stop". In P3's `pasted images` describe, change `req(<text>, null, undefined, [<images>])` to `req(<text>, undefined, [<images>])` (four calls). Change `req('summarize', 'sess-old')` to `req('summarize')`, and `req('and last month?', 'sess-old')` is deleted along with its test.
- P3's `'the GLM retry sends the same images again on a fresh stream, reading each preview once'`: its last line becomes `expect(turn.end()).toEqual({ brain: 'glm' });`. P3's other image tests are unchanged: their images carry no `messageId`, so `composeUserTurn` writes P3's text.
- `'streams top-level text deltas ... reports the session as the thread'`: rename it to `'streams top-level text deltas in order and reports the brain'`, and its last line becomes `expect(turn.end()).toEqual({ brain: 'claude' });`.
- `'isolates the run ...'`: add `expect(o.persistSession).toBe(false);` after the `resume` assertion. Keep `expect(o.resume).toBeUndefined();`.
- Replace the test `'resumes the given thread and reports the session the SDK returns'` with:
```ts
  it('never resumes: the composed turn text is the whole prompt', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('ok'), success('sess-new')]));
    const text = '<chat_history>\n[msg:K7F2] user (2026-10-31 09:12 WIB): hi\n</chat_history>\n\n<message>\n[msg:P0Q1] user (2026-10-31 09:13 WIB): again\n</message>';
    const turn = await backend(query).reply(req(text));
    await collect(turn);
    expect(calls[0]?.prompt).toBe(text);
    expect(optionsOf(calls, 0).resume).toBeUndefined();
    expect(optionsOf(calls, 0).persistSession).toBe(false);
    expect(turn.end()).toEqual({ brain: 'claude' });
  });
```
- Append inside P3's `describe('agent chat backend: pasted images', ...)`:
```ts
  it('labels rebuilt-turn images with their message, identically for each attempt', async () => {
    const { query, calls } = fakeQuery(
      scripted([assistantError('rate_limit', 'usage limit reached'), errorResult('Claude AI usage limit reached')]),
      scripted([textDelta('From GLM.'), success('sess-glm')]),
    );
    const mine: ChatTurnImage = { ...RED, messageId: 'P0Q1' };
    const turn = await backend(query, {}, { readPreview }).reply(req('look [image upload:U-PL1]', undefined, [mine]));
    await collect(turn);
    expect(calls).toHaveLength(2);
    const first = await sentMessages(calls[0]?.prompt);
    const second = await sentMessages(calls[1]?.prompt);
    expect(second).toEqual(first);
    expect(first[0]?.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PREVIEWS[RED.previewPath]!) } },
      { type: 'text', text: 'look [image upload:U-PL1]\n\nThe picture shown above is:\n[image upload:U-PL1] from [msg:P0Q1]' },
    ]);
  });
```
- `'a newer reply() supersedes the run in flight'`: the last line becomes `expect(second.end()).toEqual({ brain: 'claude' });`.
- `'retries once on GLM after a usage-limit error ...'`: rename it to `'retries once on GLM after a usage-limit error before any text, with the identical prompt'`. Replace `expect(glm.resume).toBe('sess-old');` with `expect(glm.resume).toBeUndefined(); expect(glm.persistSession).toBe(false);`. Replace `expect(calls[1]?.prompt).toBe('summarize');` with `expect(calls[1]?.prompt).toBe('summarize'); expect(calls[1]?.prompt).toBe(calls[0]?.prompt);`. Replace the last line with `expect(turn.end()).toEqual({ brain: 'glm' });`.
- `'runs on GLM only and labels the turn glm'`: the last line becomes `expect(turn.end()).toEqual({ brain: 'glm' });`.

**21g.** `tests/unit/chat-compose.test.ts` (P3's file): add `composeLabelledText, imageLabel` to the `../../src/chat/compose.js` import and append:
```ts
describe('phase 7 labels', () => {
  it('imageLabel names the message when known', () => {
    expect(imageLabel({ id: 'U-PL1' })).toBe('[image upload:U-PL1]');
    expect(imageLabel({ id: 'U-PL1', messageId: 'K7F2' })).toBe('[image upload:U-PL1] from [msg:K7F2]');
  });

  it('composeUserTurn uses the labelled text once any image has a messageId', () => {
    const turn = composeUserTurn(
      { message: '<message>...</message>', images: [{ ...IMG, messageId: 'K7F2' }, { ...IMG2, messageId: 'Z1Y2' }] },
      ['AAA', 'BBB'],
    );
    expect(turn.text).toBe(
      '<message>...</message>\n\nThe 2 pictures shown above are, in this order:\n' +
        '[image upload:U-PL1] from [msg:K7F2]\n[image upload:V-QM2] from [msg:Z1Y2]',
    );
    expect(turn.images.map((i) => i.id)).toEqual(['U-PL1', 'V-QM2']);
    expect(composeLabelledText('x', [])).toBe('x');
  });
});
```

### Step 22: Integration tests: existing files

**22a.** `tests/integration/api.int.test.ts`: replace both `describe('POST /api/chat', ...)` (today lines 203-231) and `describe('POST /api/chat with an injected backend', ...)` (lines 233-321) with:
```ts
const MSG_ID = /^[0-9A-Z]{4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /api/chat', () => {
  it('accepts, streams the stub reply as deltas, then done with our thread and message ids', async () => {
    const res = await h.sendJson('POST', '/api/chat', { message: 'what did I save?' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const messages = parseSse(await res.text());
    const accepted = messages[0];
    expect(accepted?.event).toBe('accepted');
    const { thread_id, user_message_id } = accepted?.data as { thread_id: string; user_message_id: string };
    expect(thread_id).toMatch(UUID);
    expect(user_message_id).toMatch(MSG_ID);
    const deltas = messages.filter((m) => m.event === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((m) => (m.data as { text: string }).text).join('')).toBe(STUB_REPLY);
    expect(messages.at(-1)).toEqual({
      event: 'done',
      data: { thread_id, user_message_id, assistant_message_id: expect.stringMatching(MSG_ID), reply_to: null },
    });
  });

  it('continues a thread it created and starts a new one for an unknown thread_id', async () => {
    const first = parseSse(await (await h.sendJson('POST', '/api/chat', { message: 'one' })).text());
    const threadId = (first.at(-1)?.data as { thread_id: string }).thread_id;
    const again = parseSse(await (await h.sendJson('POST', '/api/chat', { message: 'two', thread_id: threadId })).text());
    expect((again.at(-1)?.data as { thread_id: string }).thread_id).toBe(threadId);
    const legacy = parseSse(await (await h.sendJson('POST', '/api/chat', { message: 'old', thread_id: 'thread-42' })).text());
    const legacyThread = (legacy.at(-1)?.data as { thread_id: string }).thread_id;
    expect(legacyThread).not.toBe('thread-42');
    expect(legacyThread).toMatch(UUID);
  });

  it('rejects an empty message with a JSON {error} before streaming', async () => {
    for (const payload of [{}, { message: '   ' }, { message: 3 }, { message: '   ', image_ids: [] }]) {
      const res = await h.sendJson('POST', '/api/chat', payload);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(await res.json()).toHaveProperty('error');
    }
  });
});

describe('POST /api/chat with an injected backend', () => {
  let f: ApiHarness;
  let fake: ScriptedChatBackend;

  beforeAll(async () => {
    fake = createScriptedChatBackend();
    f = await createApiHarness({ chat: fake });
  });

  afterAll(async () => {
    await f.close();
  });

  async function chat(payload: unknown) {
    const res = await f.sendJson('POST', '/api/chat', payload);
    expect(res.status).toBe(200);
    return parseSse(await res.text());
  }

  it('streams accepted, status and delta events in backend order, then done with ids and brain', async () => {
    fake.push({
      steps: [
        { type: 'status', text: 'searching notes' },
        { type: 'status', text: 'reading 3 notes' },
        { type: 'status', text: '' },
        { type: 'delta', text: 'You saved ' },
        { type: 'delta', text: 'A-B32.' },
      ],
      end: { brain: 'claude' },
    });
    const messages = await chat({ message: 'what did I save?' });
    const accepted = messages[0]?.data as { thread_id: string; user_message_id: string };
    expect(messages).toEqual([
      { event: 'accepted', data: { thread_id: expect.stringMatching(UUID), user_message_id: expect.stringMatching(MSG_ID) } },
      { event: 'status', data: { text: 'searching notes' } },
      { event: 'status', data: { text: 'reading 3 notes' } },
      { event: 'status', data: { text: '' } },
      { event: 'delta', data: { text: 'You saved ' } },
      { event: 'delta', data: { text: 'A-B32.' } },
      {
        event: 'done',
        data: {
          thread_id: accepted.thread_id,
          user_message_id: accepted.user_message_id,
          assistant_message_id: expect.stringMatching(MSG_ID),
          reply_to: null,
          brain: 'claude',
        },
      },
    ]);
    const turn = fake.requests.at(-1)?.turn;
    expect(turn?.text).toContain(`[msg:${accepted.user_message_id}] user (`);
    expect(turn?.text).toContain('what did I save?');
    expect(turn?.images).toEqual([]);
  });

  it('omits brain from done when the backend reports none', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'hi' }] });
    const done = (await chat({ message: 'hi' })).at(-1);
    expect(done?.event).toBe('done');
    expect(done?.data).not.toHaveProperty('brain');
  });

  it('sends event: error and no done when the events stream throws mid-turn; the question is kept', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'partial ' }, { type: 'throw', message: 'usage limit reached' }] });
    const messages = await chat({ message: 'x' });
    expect(messages.map((m) => m.event)).toEqual(['accepted', 'delta', 'error']);
    expect(messages[2]).toEqual({ event: 'error', data: { error: 'usage limit reached' } });
    const { thread_id } = messages[0]?.data as { thread_id: string };
    const thread = await f.chat.getThread(thread_id);
    expect(thread?.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('sends event: error when reply() itself rejects', async () => {
    fake.push({ steps: [], rejectWith: 'claude not found' });
    const messages = await chat({ message: 'x' });
    expect(messages.map((m) => m.event)).toEqual(['accepted', 'error']);
    expect(messages[1]).toEqual({ event: 'error', data: { error: 'claude not found' } });
  });

  it('aborts the backend request signal when the client disconnects', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'first ' }, { type: 'hang' }] });
    const res = await f.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'slow one' }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes('event: delta'));
    expect(parseSse(text).find((m) => m.event === 'delta')).toEqual({ event: 'delta', data: { text: 'first ' } });
    const req = fake.requests.at(-1);
    expect(req?.turn.text).toContain('slow one');
    expect(req?.signal.aborted).toBe(false);
    await reader.cancel();
    await waitFor(() => req?.signal.aborted === true);
  });
});
```
Also: `import { createApiHarness, uniqueTag, type ApiHarness } from './helpers/api-harness.js';` stays as it is. Add no other import changes; `readUntil`, `waitFor` and `parseSse` are already imported.

**22b.** `tests/integration/daemon.int.test.ts`:
- Replace `'serves an injected stub over real HTTP'`:
```ts
  it('serves an injected stub over real HTTP', async () => {
    const messages = await postChat(daemon.port, 'hello');
    expect(messages[0]?.event).toBe('accepted');
    expect(messages.slice(1, -1).every((m) => m.event === 'delta')).toBe(true);
    expect(messages.at(-1)?.event).toBe('done');
    const accepted = messages[0]?.data as { thread_id: string };
    expect((messages.at(-1)?.data as { thread_id: string }).thread_id).toBe(accepted.thread_id);
  });
```
- In `'serves an injected chat backend'`, change the fake push `end` to `{ brain: 'claude' }` and the expectation to:
```ts
      expect(await postChat(other.port, 'hi')).toEqual([
        { event: 'accepted', data: { thread_id: expect.any(String), user_message_id: expect.stringMatching(/^[0-9A-Z]{4}$/) } },
        { event: 'status', data: { text: 'searching notes' } },
        { event: 'delta', data: { text: 'injected' } },
        {
          event: 'done',
          data: {
            thread_id: expect.any(String),
            user_message_id: expect.stringMatching(/^[0-9A-Z]{4}$/),
            assistant_message_id: expect.stringMatching(/^[0-9A-Z]{4}$/),
            reply_to: null,
            brain: 'claude',
          },
        },
      ]);
```
- Add one assertion to `'creates the data dirs ...'`: `expect(daemon.deps.chat).toBeDefined();`.

**22c.** `tests/live/chat.live.test.ts` (as P3 and P6 left it: P3's `ask(brain, message, images = [])` and its Claude image case; P6's `imageEmbedder: null` in `startDaemon`):
- In `ask`: replace P3's `backend.reply({ message, images, threadId: null, signal: controller.signal })` with `const turn = await backend.reply({ turn: { text: message, images }, signal: controller.signal });`. P3's image case is unchanged (its image has no `messageId`, so the prompt text is P3's).
- In `expectNotesAnswer`: delete `expect(answer.end.threadId).toMatch(/\S/);`.
- Update the header comment's description of the run to mention that no session is persisted.

**22d.** `tests/integration/chat.images.int.test.ts` (P3's file, Step 14 there). Its upload, variant and validation cases are untouched. Its two chat-turn describes read P3's `ChatRequest` (`message`, `images`, `threadId`) and the old `done`; rewrite those assertions for `ChatRequest.turn` and the new `done`:
- Add a helper after `parseSse`'s import block:
```ts
const MSG_ID = /^[0-9A-Z]{4}$/;
type Done = { thread_id: string; user_message_id: string; assistant_message_id: string; reply_to: string | null; brain?: string };
const doneOf = (body: string): Done => {
  const last = parseSse(body).at(-1);
  if (last?.event !== 'done') throw new Error(`expected done, got ${JSON.stringify(last)}`);
  return last.data as Done;
};
```
- `'hands the resolved images to the backend, previews derived under cache/c_<id>/'`: push `{ steps: [{ type: 'delta', text: 'red' }] }` (no `end`), then
```ts
    const done = doneOf(await res.text());
    expect(done.user_message_id).toMatch(MSG_ID);
    expect(done.assistant_message_id).toMatch(MSG_ID);
    const req = scripted.requests.at(-1);
    expect(req?.turn.text).toContain('what is it?');
    expect(req?.turn.text).toContain(`[image upload:${image.id}]`);
    const previewPath = path.join(h.dataDir, 'cache', `c_${image.id}`, 'preview.jpg');
    expect(req?.turn.images).toEqual([
      { id: image.id, previewPath, previewMime: 'image/jpeg', width: 40, height: 30, originalName: 'shot.png', messageId: done.user_message_id },
    ]);
    expect(existsSync(previewPath)).toBe(true);
```
- `'accepts images with no text, and dedupes repeated ids'`: push `{ steps: [] }`; replace the two `req` assertions with `expect(req?.turn.images.map((i) => i.id)).toEqual([image.id]);`.
- `'a text-only message carries no images'`: push `{ steps: [] }`; assert `expect(scripted.requests.at(-1)?.turn.images).toEqual([]);`.
- `'composes one user message: ...'`: replace the `done` assertion with `expect(doneOf(await res.text()).brain).toBe('claude');` and the final text assertion with
```ts
    const body = text?.type === 'text' ? text.text : '';
    expect(body).toContain('what colour is this?');
    expect(body).toMatch(new RegExp(`\\n\\nThe picture shown above is:\\n\\[image upload:${image.id}\\] from \\[msg:[0-9A-Z]{4}\\]$`));
```
- `'a text-only message still reaches the SDK as a plain string'`: replace `expect(prompts).toEqual(['hello']);` with
```ts
    expect(prompts).toHaveLength(1);
    expect(typeof prompts[0]).toBe('string');
    expect(prompts[0]).toContain('<message>');
    expect(prompts[0]).toContain('hello');
```

### Step 23: New integration tests: service

**File:** `tests/integration/chat.service.int.test.ts` (new)
**Code:**
```ts
import { randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatChange } from '../../src/chat/events.js';
import { ChatService } from '../../src/chat/service.js';
import { ID_ALPHABET } from '../../src/notes/ids.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const db = openTestDb();

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
});

/** A clock that advances one second per call, from 2026-10-31T00:00:00Z. */
function steppingClock(startIso = '2026-10-31T00:00:00Z'): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

/** Message ids come out of this queue first, then at random. */
function scriptedRandom(ids: string[]): (max: number) => number {
  const queue = ids.join('').split('').map((ch) => ID_ALPHABET.indexOf(ch));
  return (max) => queue.shift() ?? randomInt(max);
}

async function exchange(chat: ChatService, threadId: string | null, question: string, answer: string) {
  const start = await chat.addUserMessage({ threadId, source: 'wall', text: question });
  const reply = await chat.addAssistantMessage({ threadId: start.thread.id, text: answer, brain: 'claude' });
  return { threadId: start.thread.id, userId: start.message.id, answerId: reply.id, threadCreated: start.threadCreated };
}

describe('ChatService: threads and messages', () => {
  it('creates a wall thread on the first message and continues it after', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const first = await exchange(chat, null, 'what did I save?', 'You saved A-B32.');
    expect(first.threadCreated).toBe(true);
    const second = await exchange(chat, first.threadId, 'and last month?', 'Nothing.');
    expect(second.threadCreated).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    const thread = await chat.getThread(first.threadId);
    expect(thread?.thread).toMatchObject({ source: 'wall', brain: 'claude' });
    expect(thread?.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'what did I save?'],
      ['assistant', 'You saved A-B32.'],
      ['user', 'and last month?'],
      ['assistant', 'Nothing.'],
    ]);
    expect(thread?.messages[0]?.created_at).toBe('2026-10-31T00:00:00.000Z');
    expect(thread?.thread.updated_at).toBe('2026-10-31T00:00:03.000Z');
  });

  it('starts a new thread for an unknown id and for a thread of another source', async () => {
    const chat = new ChatService({ db });
    const unknown = await chat.addUserMessage({ threadId: 'sess-from-the-sdk', source: 'wall', text: 'hi' });
    expect(unknown.threadCreated).toBe(true);
    expect(unknown.thread.id).not.toBe('sess-from-the-sdk');
    const captured = await chat.createThread({ source: 'claude_code' });
    const wall = await chat.addUserMessage({ threadId: captured.id, source: 'wall', text: 'hi' });
    expect(wall.threadCreated).toBe(true);
    expect(wall.thread.id).not.toBe(captured.id);
  });

  it('retries a message id that is already taken', async () => {
    const chat = new ChatService({ db, random: scriptedRandom(['AAAA', 'AAAA', 'BBBB']) });
    const one = await chat.addUserMessage({ threadId: null, source: 'wall', text: 'one' });
    const two = await chat.addUserMessage({ threadId: one.thread.id, source: 'wall', text: 'two' });
    expect(one.message.id).toBe('AAAA');
    expect(two.message.id).toBe('BBBB');
  });

  it('refuses a reply to a missing or deleted message and writes nothing', async () => {
    const chat = new ChatService({ db });
    const a = await exchange(chat, null, 'q', 'a');
    await chat.deleteMessage(a.answerId);
    await expect(chat.addUserMessage({ threadId: null, source: 'wall', text: 'x', replyTo: 'ZZZZ' })).rejects.toMatchObject({ code: 'reply_not_found' });
    await expect(chat.addUserMessage({ threadId: null, source: 'wall', text: 'x', replyTo: a.answerId })).rejects.toMatchObject({ code: 'reply_not_found' });
    const page = await chat.listTimeline({ includeDeleted: true });
    expect(page.messages).toHaveLength(2);
  });

  it('records attachments in order and shows them with urls', async () => {
    const chat = new ChatService({ db });
    const start = await chat.addUserMessage({
      threadId: null,
      source: 'wall',
      text: '',
      attachments: [
        { kind: 'chat_image', id: 'C-AB12' },
        { kind: 'note_image', id: 'A-B32' },
        { kind: 'note_file', id: 'F-1LE' },
      ],
    });
    expect(start.message.attachments).toEqual([
      { kind: 'chat_image', id: 'C-AB12', url: '/api/chat/images/C-AB12/display', thumb_url: '/api/chat/images/C-AB12/thumb' },
      { kind: 'note_image', id: 'A-B32', url: '/api/images/A-B32/display', thumb_url: '/api/images/A-B32/thumb' },
      { kind: 'note_file', id: 'F-1LE', url: '/api/files/F-1LE/download', thumb_url: null },
    ]);
    await expect(chat.addUserMessage({ threadId: null, source: 'wall', text: '' })).rejects.toMatchObject({ code: 'empty_text' });
  });

  it('emits created events after commit', async () => {
    const chat = new ChatService({ db });
    const seen: ChatChange[] = [];
    const off = chat.events.on((c) => seen.push(c));
    const ex = await exchange(chat, null, 'q', 'a');
    off();
    expect(seen).toEqual([
      { type: 'chat', op: 'created', thread_id: ex.threadId, id: ex.userId },
      { type: 'chat', op: 'created', thread_id: ex.threadId, id: ex.answerId },
    ]);
  });
});

describe('ChatService: edit, delete, restore', () => {
  it('edits user messages only, keeps the old text as a revision, and is a no-op for the same text', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const ex = await exchange(chat, null, 'what did I sav?', 'You saved A-B32.');
    const edited = await chat.editMessage(ex.userId.toLowerCase(), '  what did I save?  ');
    expect(edited.text).toBe('what did I save?');
    expect(edited.edited_at).not.toBeNull();
    expect((await chat.listRevisions(ex.userId)).map((r) => r.text)).toEqual(['what did I sav?']);
    await chat.editMessage(ex.userId, 'what did I save?');
    expect(await chat.listRevisions(ex.userId)).toHaveLength(1);
    await expect(chat.editMessage(ex.answerId, 'nope')).rejects.toMatchObject({ code: 'not_editable' });
    await expect(chat.editMessage(ex.userId, '   ')).rejects.toMatchObject({ code: 'empty_text' });
    await expect(chat.editMessage('A-B32', 'x')).rejects.toMatchObject({ code: 'invalid_id' });
    await chat.deleteMessage(ex.userId);
    await expect(chat.editMessage(ex.userId, 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deletes a question with its answer, leaves an unanswered question alone, and restores', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const ex = await exchange(chat, null, 'q1', 'a1');
    const lone = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'q2 (no answer)' });
    const later = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'q3' });

    expect(await chat.deleteMessage(ex.userId, { withAnswer: true })).toEqual({ deleted: [ex.userId, ex.answerId] });
    expect(await chat.deleteMessage(lone.message.id, { withAnswer: true })).toEqual({ deleted: [lone.message.id] });
    expect(await chat.deleteMessage(lone.message.id)).toEqual({ deleted: [] });

    const live = await chat.getThread(ex.threadId);
    expect(live?.messages.map((m) => m.id)).toEqual([later.message.id]);
    const all = await chat.getThread(ex.threadId, { includeDeleted: true });
    expect(all?.messages.filter((m) => m.deleted_at !== null).map((m) => m.id)).toEqual([ex.userId, ex.answerId, lone.message.id]);

    const restored = await chat.restoreMessage(ex.answerId);
    expect(restored.deleted_at).toBeNull();
    expect((await chat.restoreMessage(ex.answerId)).id).toBe(ex.answerId);
    await expect(chat.deleteMessage('ZZZZ')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('builds turn context from live rows with edited text, and the live reply target from another thread', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const other = await exchange(chat, null, 'red top photo?', 'That one is red.');
    const ex = await exchange(chat, null, 'typo qestion', 'answer one');
    await chat.editMessage(ex.userId, 'fixed question');
    const gone = await exchange(chat, ex.threadId, 'deleted q', 'deleted a');
    await chat.deleteMessage(gone.userId, { withAnswer: true });
    const now = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'now', replyTo: other.answerId });

    const ctx = await chat.loadTurnContext(ex.threadId, now.message.id);
    expect(ctx.history.map((m) => m.text)).toEqual(['fixed question', 'answer one']);
    expect(ctx.current.id).toBe(now.message.id);
    expect(ctx.replyTarget?.id).toBe(other.answerId);
    expect(now.message.reply_to).toEqual({ id: other.answerId, role: 'assistant', text: 'That one is red.', deleted: false });

    await chat.deleteMessage(other.answerId);
    expect((await chat.loadTurnContext(ex.threadId, now.message.id)).replyTarget).toBeNull();
    expect((await chat.getMessage(now.message.id))?.reply_to).toEqual({ id: other.answerId, role: 'assistant', text: '', deleted: true });
  });

  it('a new service on the same database sees the same conversation (restart)', async () => {
    const before = new ChatService({ db });
    const ex = await exchange(before, null, 'remember kestrel', 'Noted.');
    const after = new ChatService({ db });
    const next = await after.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'what word?' });
    expect(next.threadCreated).toBe(false);
    const ctx = await after.loadTurnContext(ex.threadId, next.message.id);
    expect(ctx.history.map((m) => m.text)).toEqual(['remember kestrel', 'Noted.']);
  });
});

describe('ChatService: timeline', () => {
  it('pages newest-first, returns each page ascending, across threads, and hides deleted rows by default', async () => {
    const chat = new ChatService({ db, now: steppingClock() });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const ex = await exchange(chat, null, `q${i}`, `a${i}`);
      ids.push(ex.userId, ex.answerId);
    }
    const p1 = await chat.listTimeline({ limit: 4 });
    expect(p1.messages.map((m) => m.id)).toEqual(ids.slice(6, 10));
    expect(p1.next_before).not.toBeNull();
    const p2 = await chat.listTimeline({ limit: 4, before: p1.next_before });
    expect(p2.messages.map((m) => m.id)).toEqual(ids.slice(2, 6));
    const p3 = await chat.listTimeline({ limit: 4, before: p2.next_before });
    expect(p3.messages.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(p3.next_before).toBeNull();

    await chat.deleteMessage(ids[9]!);
    expect((await chat.listTimeline({ limit: 2 })).messages.map((m) => m.id)).toEqual([ids[7], ids[8]]);
    expect((await chat.listTimeline({ limit: 2, includeDeleted: true })).messages.map((m) => m.id)).toEqual([ids[8], ids[9]]);
  });

  it('orders by created_at then seq, so equal timestamps keep insert order', async () => {
    const fixed = new Date('2026-10-31T00:00:00Z');
    const chat = new ChatService({ db, now: () => fixed });
    const ex = await exchange(chat, null, 'same', 'time');
    const extra = await chat.addUserMessage({ threadId: ex.threadId, source: 'wall', text: 'third' });
    const p1 = await chat.listTimeline({ limit: 2 });
    expect(p1.messages.map((m) => m.id)).toEqual([ex.answerId, extra.message.id]);
    const p2 = await chat.listTimeline({ limit: 2, before: p1.next_before });
    expect(p2.messages.map((m) => m.id)).toEqual([ex.userId]);
  });

  it('rejects a cursor it did not issue', async () => {
    const chat = new ChatService({ db });
    await expect(chat.listTimeline({ before: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
});

describe('ChatService.recordExchange (phase 8 capture)', () => {
  const input = {
    source: 'claude_code' as const,
    externalKey: 'sess-1:entry-1',
    brain: 'claude',
    user: { text: '/n find red tops', createdAt: new Date('2026-10-30T10:00:00Z'), attachments: [{ kind: 'chat_image' as const, id: 'C-AB12' }] },
    assistant: { text: 'Found A-B32.', createdAt: new Date('2026-10-30T10:00:20Z') },
  };

  it('writes one single-turn thread and is a no-op on replay', async () => {
    const chat = new ChatService({ db });
    const first = await chat.recordExchange(input);
    expect(first.created).toBe(true);
    expect(first.thread.source).toBe('claude_code');
    expect(first.messageIds).toHaveLength(2);
    const again = await chat.recordExchange(input);
    expect(again).toEqual({ ...first, created: false });
    const thread = await chat.getThread(first.thread.id);
    expect(thread?.messages.map((m) => [m.role, m.source, m.created_at])).toEqual([
      ['user', 'claude_code', '2026-10-30T10:00:00.000Z'],
      ['assistant', 'claude_code', '2026-10-30T10:00:20.000Z'],
    ]);
    expect(thread?.messages[0]?.attachments.map((a) => a.id)).toEqual(['C-AB12']);
  });

  it('survives two concurrent captures of the same exchange', async () => {
    const a = new ChatService({ db });
    const b = new ChatService({ db });
    const [x, y] = await Promise.all([a.recordExchange(input), b.recordExchange(input)]);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(x.thread.id).toBe(y.thread.id);
    const count = await db.execute(sql`select count(*)::int as n from chat_threads where external_key = ${input.externalKey}`);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });
});

describe('chat tables: foreign keys', () => {
  it('cascades a thread to its messages and nulls reply_to when a target row is removed for good', async () => {
    const chat = new ChatService({ db });
    const a = await exchange(chat, null, 'q', 'a');
    const b = await chat.addUserMessage({ threadId: null, source: 'wall', text: 'reply', replyTo: a.answerId });
    await db.execute(sql`delete from chat_threads where id = ${a.threadId}`);
    expect(await chat.getMessage(a.userId, { includeDeleted: true })).toBeNull();
    const after = await chat.getMessage(b.message.id);
    expect(after?.reply_to).toBeNull();
  });
});
```

### Step 24: New integration tests: route

**File:** `tests/integration/chat.api.int.test.ts` (new)
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentChatBackend, type QueryFn } from '../../src/chat/agent.js';
import { DEFAULT_CHAT_CONFIG } from '../../src/config.js';
import type { ChatMessageView, ChatTimelinePage } from '../../src/chat/types.js';
import { createApp } from '../../src/http/app.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse, readUntil, waitFor, type SseMessage } from './helpers/sse.js';
import { makeImage, startHarness } from './imageHarness.js';
import { truncateAll } from './setup.js';

interface Accepted {
  thread_id: string;
  user_message_id: string;
}
interface Done extends Accepted {
  assistant_message_id: string;
  reply_to: string | null;
  brain?: string;
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

async function chat(h: ApiHarness, payload: unknown): Promise<SseMessage[]> {
  const res = await h.sendJson('POST', '/api/chat', payload);
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

function acceptedOf(messages: SseMessage[]): Accepted {
  expect(messages[0]?.event).toBe('accepted');
  return messages[0]!.data as Accepted;
}

function doneOf(messages: SseMessage[]): Done {
  const last = messages.at(-1);
  expect(last?.event).toBe('done');
  return last!.data as Done;
}

function deltaText(messages: SseMessage[]): string {
  return messages
    .filter((m) => m.event === 'delta')
    .map((m) => (m.data as { text: string }).text)
    .join('');
}

async function ask(h: ApiHarness, backend: ScriptedChatBackend, payload: Record<string, unknown>, answer: string): Promise<Done> {
  backend.push({ steps: [{ type: 'delta', text: answer }], end: { brain: 'claude' } });
  return doneOf(await chat(h, payload));
}

describe('POST /api/chat: persistence and context', () => {
  it('persists a two-turn conversation and rebuilds the second prompt from our rows', async () => {
    const d1 = await ask(f, fake, { message: 'what did I save?' }, 'You saved A-B32.');
    const d2 = await ask(f, fake, { message: 'and last month?', thread_id: d1.thread_id }, 'Nothing.');
    expect(d2.thread_id).toBe(d1.thread_id);

    const turn = fake.requests.at(-1)!.turn;
    expect(turn.text).toMatch(/^<chat_history>\n/);
    expect(turn.text).toContain(`[msg:${d1.user_message_id}] user (`);
    expect(turn.text).toContain('): what did I save?');
    expect(turn.text).toContain(`[msg:${d1.assistant_message_id}] assistant (`);
    expect(turn.text).toContain('): You saved A-B32.');
    expect(turn.text).toMatch(
      new RegExp(`<message>\\n\\[msg:${d2.user_message_id}\\] user \\(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} WIB\\): and last month\\?\\n</message>$`),
    );
    expect(fake.requests.at(-1)).not.toHaveProperty('threadId');

    const thread = await f.chat.getThread(d1.thread_id);
    expect(thread?.messages.map((m) => [m.id, m.role, m.text, m.brain])).toEqual([
      [d1.user_message_id, 'user', 'what did I save?', null],
      [d1.assistant_message_id, 'assistant', 'You saved A-B32.', 'claude'],
      [d2.user_message_id, 'user', 'and last month?', null],
      [d2.assistant_message_id, 'assistant', 'Nothing.', 'claude'],
    ]);
  });

  it('keeps the context across a restart (a new service and app on the same database)', async () => {
    const d1 = await ask(f, fake, { message: 'remember the word kestrel' }, 'Noted.');
    const fake2 = createScriptedChatBackend();
    const g = await createApiHarness({ chat: fake2 });
    try {
      await ask(g, fake2, { message: 'which word?', thread_id: d1.thread_id }, 'kestrel');
      const text = fake2.requests[0]!.turn.text;
      expect(text).toContain('remember the word kestrel');
      expect(text).toContain('Noted.');
    } finally {
      await g.close();
    }
  });

  it('starts a new thread for a thread_id it does not know (an old SDK session id)', async () => {
    const d = await ask(f, fake, { message: 'hello', thread_id: '6f1c7a52-0000-4000-8000-000000000000' }, 'hi');
    expect(d.thread_id).not.toBe('6f1c7a52-0000-4000-8000-000000000000');
    expect(fake.requests.at(-1)!.turn.text).not.toContain('<chat_history>');
  });

  it('leaves deleted messages out of the context and uses edited text', async () => {
    const d1 = await ask(f, fake, { message: 'typo qestion' }, 'first answer');
    const d2 = await ask(f, fake, { message: 'secret detour', thread_id: d1.thread_id }, 'detour answer');
    expect((await f.sendJson('PATCH', `/api/chat/messages/${d1.user_message_id}`, { text: 'fixed question' }, SAME_ORIGIN)).status).toBe(200);
    const del = await f.request(`/api/chat/messages/${d2.user_message_id}?with_answer=1`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(await del.json()).toEqual({ deleted: [d2.user_message_id, d2.assistant_message_id] });

    await ask(f, fake, { message: 'third', thread_id: d1.thread_id }, 'ok');
    const text = fake.requests.at(-1)!.turn.text;
    expect(text).toContain('fixed question');
    expect(text).not.toContain('typo qestion');
    expect(text).not.toContain('secret detour');
    expect(text).not.toContain('detour answer');

    expect((await f.request(`/api/chat/messages/${d2.user_message_id}/restore`, { method: 'POST', headers: SAME_ORIGIN })).status).toBe(200);
    await ask(f, fake, { message: 'fourth', thread_id: d1.thread_id }, 'ok');
    expect(fake.requests.at(-1)!.turn.text).toContain('secret detour');
  });

  it('injects a reply_to target from another thread and records it on the question', async () => {
    const other = await ask(f, fake, { message: 'find my red top photo' }, 'That is the red one in A-B32.');
    const here = await ask(f, fake, { message: 'unrelated start' }, 'ok');
    const d = await ask(
      f,
      fake,
      { message: 'is it the same shade?', thread_id: here.thread_id, reply_to: `[msg:${other.assistant_message_id.toLowerCase()}]` },
      'Yes.',
    );
    const text = fake.requests.at(-1)!.turn.text;
    expect(text).toContain(`<reply_to>\n[msg:${other.assistant_message_id}] assistant (`);
    expect(text).toContain('That is the red one in A-B32.\n</reply_to>');
    const question = await f.chat.getMessage(d.user_message_id);
    expect(question?.reply_to).toEqual({ id: other.assistant_message_id, role: 'assistant', text: 'That is the red one in A-B32.', deleted: false });
  });

  it('persists nothing for the answer when the client disconnects', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'partial ' }, { type: 'hang' }] });
    const res = await f.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'slow' }),
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes('event: delta'));
    const accepted = parseSse(text)[0]!.data as Accepted;
    const req = fake.requests.at(-1)!;
    await reader.cancel();
    await waitFor(() => req.signal.aborted);
    await new Promise((r) => setTimeout(r, 50));
    const thread = await f.chat.getThread(accepted.thread_id);
    expect(thread?.messages.map((m) => m.id)).toEqual([accepted.user_message_id]);
  });
});

describe('POST /api/chat: brain fallback sees the identical prompt', () => {
  const SESSION = 'sess-x';
  const delta = (text: string): SDKMessage =>
    ({ type: 'stream_event', parent_tool_use_id: null, uuid: randomUUID(), session_id: SESSION, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }) as unknown as SDKMessage;
  const success = (): SDKMessage =>
    ({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, duration_ms: 1, duration_api_ms: 1, session_id: SESSION, uuid: randomUUID() }) as unknown as SDKMessage;
  const limited = (): SDKMessage =>
    ({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached', num_turns: 1, duration_ms: 1, duration_api_ms: 1, session_id: SESSION, uuid: randomUUID() }) as unknown as SDKMessage;

  it('claude hits its limit, glm answers, and both got the same composed prompt with no resume', async () => {
    const calls: Parameters<QueryFn>[0][] = [];
    const scripts: SDKMessage[][] = [[success()], [limited()], [delta('From GLM.'), success()]];
    const query: QueryFn = (params) => {
      calls.push(params);
      const script = scripts[calls.length - 1] ?? [];
      return (async function* () {
        for (const m of script) yield m;
      })();
    };
    const agent = createAgentChatBackend({
      chat: { ...DEFAULT_CHAT_CONFIG, claudeBin: '/nonexistent/claude', glm: { baseUrl: 'https://glm.invalid', apiKey: 'k', model: 'glm-test' } },
      cwd: '/nonexistent/chat',
      mcpUrl: () => 'http://127.0.0.1:1/mcp',
      query,
      log: () => {},
    });
    const g = await createApiHarness({ chat: agent });
    try {
      const first = doneOf(await chat(g, { message: 'first question' }));
      expect(first.brain).toBe('claude');
      const second = await chat(g, { message: 'second question', thread_id: first.thread_id });
      const done = doneOf(second);
      expect(done.brain).toBe('glm');
      expect(deltaText(second)).toBe('From GLM.');
      expect(calls).toHaveLength(3);
      expect(calls[1]!.prompt).toBe(calls[2]!.prompt);
      expect(calls[2]!.prompt).toContain('first question');
      for (const call of calls) {
        const options: Options = call.options;
        expect(options.resume).toBeUndefined();
        expect(options.persistSession).toBe(false);
      }
      const thread = await g.chat.getThread(first.thread_id);
      expect(thread?.thread.brain).toBe('glm');
      expect(thread?.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'From GLM.', brain: 'glm' });
    } finally {
      agent.close();
      await g.close();
    }
  });
});

describe('POST /api/chat: leading [msg:ID] citation', () => {
  it('strips a streamed, split marker, never emits it, and records reply_to', async () => {
    const target = await ask(f, fake, { message: 'target question' }, 'target answer');
    const id = target.user_message_id;
    fake.push({
      steps: [
        { type: 'status', text: 'searching notes' },
        { type: 'status', text: '' },
        { type: 'delta', text: '[' },
        { type: 'delta', text: 'msg:' },
        { type: 'delta', text: id.slice(0, 2) },
        { type: 'delta', text: `${id.slice(2)}] Here` },
        { type: 'delta', text: ' it is.' },
      ],
      end: { brain: 'claude' },
    });
    const messages = await chat(f, { message: 'which one?', thread_id: target.thread_id });
    const deltas = messages.filter((m) => m.event === 'delta').map((m) => (m.data as { text: string }).text);
    expect(deltas).toEqual(['Here', ' it is.']);
    const done = doneOf(messages);
    expect(done.reply_to).toBe(id);
    const answer = await f.chat.getMessage(done.assistant_message_id);
    expect(answer?.text).toBe('Here it is.');
    expect(answer?.reply_to).toMatchObject({ id, role: 'user', deleted: false });
  });

  it('drops an unknown or deleted citation silently but still strips the marker', async () => {
    fake.push({ steps: [{ type: 'delta', text: '[msg:ZZZZ] Hi there.' }] });
    const unknown = await chat(f, { message: 'x' });
    expect(deltaText(unknown)).toBe('Hi there.');
    expect(doneOf(unknown).reply_to).toBeNull();
    expect((await f.chat.getMessage(doneOf(unknown).assistant_message_id))?.text).toBe('Hi there.');

    const gone = await ask(f, fake, { message: 'soon deleted' }, 'a');
    await f.chat.deleteMessage(gone.user_message_id);
    fake.push({ steps: [{ type: 'delta', text: `[msg:${gone.user_message_id}] About that.` }] });
    const deleted = await chat(f, { message: 'y' });
    expect(acceptedOf(deleted).user_message_id).toMatch(/^[0-9A-Z]{4}$/);
    expect(deltaText(deleted)).toBe('About that.');
    expect(doneOf(deleted).reply_to).toBeNull();
  });

  it('streams an answer without a marker straight through', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'Hello' }, { type: 'delta', text: ' world' }] });
    const messages = await chat(f, { message: 'hi' });
    expect(messages.filter((m) => m.event === 'delta').map((m) => (m.data as { text: string }).text)).toEqual(['Hello', ' world']);
    expect(doneOf(messages).reply_to).toBeNull();
  });
});

describe('POST /api/chat: validation', () => {
  it('rejects a malformed reply_to (400) and an unknown one (404) before writing anything', async () => {
    const bad = await f.sendJson('POST', '/api/chat', { message: 'x', reply_to: 'not an id' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_reply_to' });
    const missing = await f.sendJson('POST', '/api/chat', { message: 'x', reply_to: 'ZZZZ' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'reply_not_found' });
    expect((await f.chat.listTimeline({ includeDeleted: true })).messages).toEqual([]);
  });

  it('rejects an unknown image id (phase 3 validation) before writing anything', async () => {
    const res = await f.sendJson('POST', '/api/chat', { message: 'look', image_ids: ['Z-ZZZ'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_image', id: 'Z-ZZZ' });
    expect((await f.chat.listTimeline({ includeDeleted: true })).messages).toEqual([]);
  });
});

describe('history routes', () => {
  it('pages the timeline over HTTP with attachments and reply previews', async () => {
    const done: Done[] = [];
    for (let i = 0; i < 3; i += 1) done.push(await ask(f, fake, { message: `q${i}` }, `a${i}`));
    const res = await f.request('/api/chat/messages?limit=4');
    expect(res.status).toBe(200);
    const page = (await res.json()) as ChatTimelinePage;
    expect(page.messages.map((m) => m.text)).toEqual(['q1', 'a1', 'q2', 'a2']);
    expect(page.messages.every((m) => /Z$/.test(m.created_at))).toBe(true);
    const older = (await (await f.request(`/api/chat/messages?limit=4&before=${encodeURIComponent(page.next_before!)}`)).json()) as ChatTimelinePage;
    expect(older.messages.map((m) => m.text)).toEqual(['q0', 'a0']);
    expect(older.next_before).toBeNull();

    expect((await f.request('/api/chat/messages?limit=0')).status).toBe(400);
    const badCursor = await f.request('/api/chat/messages?before=nope');
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toEqual({ error: 'invalid_cursor' });
  });

  it('serves one thread and 404s an unknown one', async () => {
    const d = await ask(f, fake, { message: 'q' }, 'a');
    const res = await f.request(`/api/chat/threads/${d.thread_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thread: { id: string; source: string }; messages: ChatMessageView[] };
    expect(body.thread).toMatchObject({ id: d.thread_id, source: 'wall' });
    expect(body.messages.map((m) => m.id)).toEqual([d.user_message_id, d.assistant_message_id]);
    expect((await f.request('/api/chat/threads/nope')).status).toBe(404);
  });

  it('edits user bubbles only, demands same-origin and non-blank text', async () => {
    const d = await ask(f, fake, { message: 'old' }, 'a');
    expect((await f.sendJson('PATCH', `/api/chat/messages/${d.user_message_id}`, { text: 'new' })).status).toBe(403);
    const blank = await f.sendJson('PATCH', `/api/chat/messages/${d.user_message_id}`, { text: '  ' }, SAME_ORIGIN);
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: 'empty_text' });
    const answer = await f.sendJson('PATCH', `/api/chat/messages/${d.assistant_message_id}`, { text: 'x' }, SAME_ORIGIN);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: 'not_editable' });
    const ok = await f.sendJson('PATCH', `/api/chat/messages/${d.user_message_id}`, { text: 'new' }, SAME_ORIGIN);
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as ChatMessageView;
    expect(view.text).toBe('new');
    expect(view.edited_at).toMatch(/Z$/);
    expect((await f.chat.listRevisions(d.user_message_id)).map((r) => r.text)).toEqual(['old']);
    expect((await f.sendJson('PATCH', '/api/chat/messages/ZZZZ', { text: 'x' }, SAME_ORIGIN)).status).toBe(404);
    expect((await f.sendJson('PATCH', '/api/chat/messages/bad-id', { text: 'x' }, SAME_ORIGIN)).status).toBe(400);
  });

  it('deletes and restores over HTTP, same-origin only, with include_deleted on the timeline', async () => {
    const d = await ask(f, fake, { message: 'q' }, 'a');
    expect((await f.request(`/api/chat/messages/${d.user_message_id}`, { method: 'DELETE' })).status).toBe(403);
    const del = await f.request(`/api/chat/messages/${d.user_message_id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(await del.json()).toEqual({ deleted: [d.user_message_id] });
    const live = (await (await f.request('/api/chat/messages')).json()) as ChatTimelinePage;
    expect(live.messages.map((m) => m.id)).toEqual([d.assistant_message_id]);
    const all = (await (await f.request('/api/chat/messages?include_deleted=1')).json()) as ChatTimelinePage;
    expect(all.messages.find((m) => m.id === d.user_message_id)?.deleted_at).toMatch(/Z$/);
    expect((await f.request(`/api/chat/messages/${d.user_message_id}/restore`, { method: 'POST' })).status).toBe(403);
    const restored = await f.request(`/api/chat/messages/${d.user_message_id}/restore`, { method: 'POST', headers: SAME_ORIGIN });
    expect(((await restored.json()) as ChatMessageView).deleted_at).toBeNull();
    expect((await f.request('/api/chat/messages/ZZZZ/restore', { method: 'POST', headers: SAME_ORIGIN })).status).toBe(404);
  });
});

describe('GET /api/events: chat changes', () => {
  it('emits event: chat for each write next to the untouched note events, and unsubscribes on abort', async () => {
    const res = await f.request('/api/events');
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    const listeners = f.chat.events.listenerCount();
    expect(listeners).toBeGreaterThanOrEqual(1);

    const start = await f.chat.addUserMessage({ threadId: null, source: 'wall', text: 'sse' });
    const created = await readUntil(reader, (t) => t.includes(start.message.id));
    expect(parseSse(created)).toContainEqual({ event: 'chat', data: { op: 'created', thread_id: start.thread.id, id: start.message.id } });

    await f.chat.editMessage(start.message.id, 'sse edited');
    const updated = await readUntil(reader, (t) => t.includes('"updated"'));
    expect(parseSse(updated)).toContainEqual({ event: 'chat', data: { op: 'updated', thread_id: start.thread.id, id: start.message.id } });

    const note = await f.notes.create({ body: 'still notes', origin: null });
    const noteEvent = await readUntil(reader, (t) => t.includes(note.id));
    expect(parseSse(noteEvent)).toContainEqual({ event: 'note', data: { op: 'created', id: note.id } });

    await reader.cancel();
    await waitFor(() => f.chat.events.listenerCount() === listeners - 1);
  });
});

describe('POST /api/chat with phase 3 chat images', () => {
  it('writes chat_image attachments for the sent images and sends them as image blocks', async () => {
    const h = await startHarness();
    const imgFake = createScriptedChatBackend();
    const app = createApp(h.deps, { chat: imgFake });
    try {
      await h.reset();
      const form = new FormData();
      form.append('file', new Blob([await makeImage('png', 16, 16, { r: 200, g: 10, b: 10 })], { type: 'image/png' }), 'red.png');
      const up = await app.request('/api/chat/images', { method: 'POST', body: form });
      expect(up.status).toBe(201);
      const { image } = (await up.json()) as { image: { id: string }; created: boolean };
      const imageId = image.id;

      imgFake.push({ steps: [{ type: 'delta', text: 'A red square.' }], end: { brain: 'claude' } });
      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '', image_ids: [imageId] }),
      });
      const messages = parseSse(await res.text());
      const done = doneOf(messages);
      const question = await h.deps.chat.getMessage(done.user_message_id);
      expect(question?.text).toBe('');
      expect(question?.attachments).toEqual([
        { kind: 'chat_image', id: imageId, url: `/api/chat/images/${imageId}/display`, thumb_url: `/api/chat/images/${imageId}/thumb` },
      ]);
      const turn = imgFake.requests[0]!.turn;
      expect(turn.text).toContain(`[image upload:${imageId}]`);
      expect(turn.images.map((i) => [i.id, i.messageId])).toEqual([[imageId, done.user_message_id]]);
    } finally {
      await h.close();
    }
  });
});
```
The last describe uses P3's upload contract: `POST /api/chat/images`, multipart field `file`, 201 `{image, created: true}`. The error case above uses P3's mapping (`chatImageErrorStatus`: 400 `unknown_image` with the id).

### Step 25: Docs

**README.md**
- "The chat bar" section, the paragraph that starts "Behind it is the Claude Agent SDK" (today line 400). Replace the sentences "A follow-up continues the same thread. Dismissing the panel starts a new one. Answers are not saved as notes." with:
  > A follow-up continues the same thread. Dismissing the panel starts a new one. Every question and answer is kept in notesd's own database (not as notes). Each turn rebuilds the conversation from there, so Claude and the GLM fallback see the same history and nothing depends on Claude Code's saved sessions. The agent may start an answer with `[msg:K7F2]` to reply to one earlier message; the page hides the label and keeps the link.
- HTTP API table (today lines 658-680). Replace the `POST /api/chat` row and add rows after it:
```
| `POST /api/chat` | `{message, thread_id?, reply_to?, image_ids?}`. Streams `accepted {thread_id, user_message_id}`, then `status` and `delta` events, then `done {thread_id, user_message_id, assistant_message_id, reply_to, brain}`. The question is saved before the answer starts; the answer only when it finishes |
| `GET /api/chat/messages?before=&limit=&include_deleted=` | The chat timeline, all threads, `{messages, next_before}`, each page ascending |
| `GET /api/chat/threads/:id` | One thread and its messages |
| `PATCH /api/chat/messages/:id` | Edit your own message (`{text}`); the old text is kept. Same-origin only |
| `DELETE /api/chat/messages/:id?with_answer=1` | Delete a message (soft), optionally with its answer. Same-origin only |
| `POST /api/chat/messages/:id/restore` | Bring a deleted message back. Same-origin only |
```
  Change the `GET /api/events` row to: `Server-sent events, \`event: note\` on every note change and \`event: chat {op, thread_id, id}\` on every chat change`.
- "Where things are stored" block: add after the `note_embeddings` line (and after whatever P3/P4/P6 added):
```
           chat_threads(id, source, brain, external_key, created_at, updated_at)
           chat_messages(id [msg:K7F2], thread_id, role, text, source, brain, reply_to, seq,
                         created_at, edited_at, deleted_at)
           chat_message_revisions(message_id, text, saved_at)
           chat_message_attachments(message_id, position, kind, ref_id)
```

**CHANGELOG.md**: under `## [Unreleased]` (add the heading above `## [v0.1.0]` if no earlier phase did), under `### Added`:
```
- **Chat history (backend)**: wall chat turns are stored in our own tables (migration 0006) and each turn's context is rebuilt from them; Agent SDK `resume` and session files are gone, so Claude and GLM see the same prompt. `[msg:ID]` labels, a leading `[msg:ID]` in an answer becomes `reply_to`, edit/delete/restore and a paged timeline API, `event: chat` on `/api/events`.
```

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test && npm run test:int`
**Migration chain:** `npm run db:check`. `drizzle/meta/_journal.json` lists `0003_*`, `0004_*`, `0005_*`, `0006_chat_history` in order.
**Targeted runs while working:**
- `npx vitest run tests/unit/chat-ids.test.ts tests/unit/chat-citation.test.ts tests/unit/chat-context.test.ts tests/unit/chat-agent.test.ts tests/unit/chat-stub.test.ts tests/unit/chat-prompt.test.ts`
- `bash scripts/test-int.sh tests/integration/chat.service.int.test.ts tests/integration/chat.api.int.test.ts tests/integration/api.int.test.ts tests/integration/daemon.int.test.ts tests/integration/events.int.test.ts`

**Manual check (optional, billed):** `npm run test:live` still answers on both brains. Then confirm that nothing new appears under `~/.claude/projects/*mcp-notes-data-chat*` after a turn (`persistSession: false`).
**Exit criteria:** A two-turn wall conversation survives a restart: a new `ChatService` and app on the same DB rebuild the same context. The GLM fallback gets a byte-identical prompt with no `resume`. A `reply_to` naming a bubble in another thread appears in `<reply_to>`. An edit keeps a revision and changes future context. Deleted messages leave context and the default timeline, and restore brings them back. A leading `[msg:ID]` split across deltas never reaches the client and becomes `done.reply_to`. Every test above passes, and typecheck and build are green.

## Assumptions

- **P3 seam (aligned with `phase-3.md`).** This phase codes against P3's real names: `ChatTurnImage` (`src/chat/backend.ts`), `resolveTurnImages`, `ChatImageLookupError`, `chatImageStoreFor`, `MAX_CHAT_IMAGES_PER_MESSAGE` (`src/chat/images.ts`), `composeUserTurn(input, previews)`/`toSdkPrompt` (`src/chat/compose.ts`), the agent's `readPreview` and `userTurn()`, and P3's `chatImageErrorStatus` in `src/http/api.ts`. Upload is `POST /api/chat/images` (multipart `file`) -> 201/200 `{image, created}`; variants `original`, `display`, `thumb`, `preview`.
- **Where preview bytes are read:** in the agent, as P3 does (`ChatRun.userTurn()` via `readPreview`), once per run, so the GLM fallback reuses the same composed turn. `composeWallTurn` only resolves which images go (current turn + reply target) and sets `messageId`.
- **P3's `ChatRequest.images` and `chatSchema`** are replaced here, not extended. P3's route-level image validation moves into Step 16's flow unchanged (resolve before the user row is written; same status codes and body).
- **P6** leaves migration 0005 as the head of the chain and edited `src/chat/status.ts` (allowlist) and the pictures element of `src/chat/prompt.ts`. This phase only appends prompt sections.
- **P3/P4/P6** added `chat_images`, `note_files`, `note_image_embeddings` to `truncateAll` and P6 added `imageEmbedder` to every `AppDeps` literal. Step 20 quotes those lists and only adds to them.
- Chat image ids use the `A-B32` shape (Invariant 6); `image_ids` items keep P3's `max(16)`.

## Handoffs

- **P8 (R1, R3):** capture calls `deps.chat.recordExchange({ source: 'claude_code', externalKey: '<claude_session>:<user entry uuid>', brain, user: { text, createdAt, attachments: [{kind:'chat_image', id}] }, assistant: { text, createdAt } | null })`. It is idempotent, emits `event: chat created` for each message, and returns `{created, thread, messageIds}`. P8 owns copying pasted images into the chat image store before calling it.
- **P9 (R3), exact wire:**
  - `ChatMessageView = { id, thread_id, role: 'user'|'assistant', text, source: 'wall'|'claude_code', brain: string|null, reply_to: ChatReplyPreview|null, created_at, edited_at: string|null, deleted_at: string|null, attachments: ChatAttachmentView[] }` (UTC ISO strings); `ChatReplyPreview = { id, role: 'user'|'assistant'|null, text, deleted }` (`text` is a 140-char snippet, `''` and `role: null` when the target is gone); `ChatAttachmentView = { kind: 'chat_image'|'note_image'|'note_file', id, url, thumb_url: string|null }` (no width/height/name). Mirror them in `web/src/types.ts`.
  - `GET /api/chat/messages?before=<cursor>&limit=<1..200, default 50>&include_deleted=<0|1|true|false>` -> `{ messages (ascending), next_before: string|null }`; follow `next_before` for older pages and prepend them. No `next_cursor`.
  - `GET /api/chat/threads/:id[?include_deleted=1]` -> `{ thread: ChatThreadView, messages }`, 404 `not_found`. Thread ids are UUIDs.
  - `POST /api/chat` SSE: `accepted {thread_id, user_message_id}` first, then `status`/`delta`, then `done {thread_id, user_message_id, assistant_message_id, reply_to: string|null, brain?}` or `error {error}`. Read `accepted.thread_id` so a turn that errors still keeps the thread. Omitting `thread_id`, or sending an unknown one or one of a `claude_code` thread, starts a new wall thread. Errors before the stream are JSON: 400 (validation, `invalid_reply_to`, `unknown_image`), 404 `reply_not_found`, 409 `not_on_this_machine`, 422 `unreadable_image`.
  - `GET /api/events` adds `event: chat` with data `{op: 'created'|'updated'|'deleted'|'restored', thread_id, id}`.
  - Thread choice rule (Decisions): the client sends the latest wall thread's id, or none.
- **P10 (R3), exact wire:** `reply_to` in the request body accepts `K7F2` or `[msg:K7F2]`; a deleted or unknown target is 404 `{error: 'reply_not_found'}`. `PATCH /api/chat/messages/:id` `{text}` (user rows only; 400 `not_editable` / `empty_text`, 404 `not_found`) returns the bare updated `ChatMessageView` with `edited_at`. `DELETE /api/chat/messages/:id[?with_answer=1]` returns `{deleted: [ids]}` (only rows this call changed). `POST /api/chat/messages/:id/restore` takes one id, has no `with_answer`, and returns the bare `ChatMessageView`; restoring a live message is a no-op 200. The undo bar restores each id from `deleted` in turn. `reply_to` previews already carry `role` (nullable): P10's request for it needs no server change. Old texts stay available only through `ChatService.listRevisions`; there is no revisions HTTP route and P10 does not need one. Mutations are same-origin only (403 otherwise).
- **P11 (R3):** none.
- **Drive-by, not done:** `README.md`'s chat bar recordings and the `docs/readme` GIFs predate history. Leave them for P9's README update.

## Risks

- **drizzle-kit and `check(...)`:** if `npm run db:generate` renders a check constraint Postgres rejects, remove the three `check(...)` entries from Step 1 and regenerate. The TS union types still guard every writer, because all writes go through `ChatService`. Do not hand-edit the SQL.
- **Streaming-input prompt with images:** this is P3's path (`readPreview` -> `composeUserTurn` -> `toSdkPrompt`), reused here unchanged. Text-only turns still pass a plain string (now the composed context text). The only end-to-end proof remains P3's opt-in billed `npm run test:live` image case.
- **4-char id space:** about 1.68M ids for a single user, with retries on collision. The limit is not a concern for years.
- **Context size:** the 24k-character history budget (about 6k tokens) and the 4k-character per-line cap are constants in `context.ts`, so they can be tuned without a migration.

## Rollback

Revert this phase's commits. That restores `resume`-based threads and the old `done` shape. The tables are additive, so if 0006 was already applied somewhere, leaving them in place is harmless. To drop them by hand:
```sql
DROP TABLE IF EXISTS chat_message_attachments, chat_message_revisions, chat_messages, chat_threads;
```
Then remove the `0006_chat_history` entry from `drizzle/meta/_journal.json`, plus `drizzle/0006_chat_history.sql` and `drizzle/meta/0006_snapshot.json`, if they were reverted along with the code. Also delete the row with that migration's hash from `drizzle.__drizzle_migrations` in any database where it was applied.
