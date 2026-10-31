> Adopted from `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` phase 3. Source: `.workflows/plan/chat-history-files-image-search/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Chat image store, paste into the bar, wall chat sends images

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R1 (wall-chat half only): paste an image into the chat query bar, and the global paste handler yields to the focused ChatBar. The `/n` half of R1 is Phase 8.
**Depends on:** none
**Difficulty:** HARD
**Package:** `src/chat`, `src/http`, `src/db`, `web/src`

---

## Goal

A screenshot pasted into the focused wall chat bar uploads at once to a new `chat_images` store (sha256-deduped, never a note) and sits in the pill as a removable thumbnail with an uploading/failed state. Sending the question (with or without text) passes the image ids to `POST /api/chat`, and the Agent SDK run gets one user message whose content holds an image block per image (from the `preview` derivative) followed by the text, which names each image as `[image upload:ID]`. Pasting anywhere else still makes a photo note, pasting into the open big editor still attaches, and the answer panel shows the thumbnails that were sent.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- DB: table `chat_images` (migration `drizzle/0003_chat_images.sql`, generated), `schema.chatImages`, types `ChatImageSource`, `ChatImageRow`, `NewChatImageRow` (`src/db/schema.ts`).
- `src/chat/images.ts`: `CHAT_IMAGES_SUBDIR = 'chat-images'`, `MAX_CHAT_IMAGE_BYTES` (50 MB), `MAX_CHAT_IMAGES_PER_MESSAGE` (4), `ChatImageStoreDeps`, `chatImageStoreFor(app: AppDeps)`, `chatImageRelPath`, `chatImageCacheId` (`c_<id>`), `ChatImageVariant`, `chatImageUrl`, wire type `ChatImage`, `toChatImage`, `ChatImageInputError` (`not_an_image` | `too_large`), `ChatImageLookupError` (`unknown_image` | `not_on_this_machine` | `unreadable_image`), `findChatImage`, `ingestChatImage(deps, {bytes, originalName, source, maxBytes?})`, `LocatedChatImage`, `locateChatImage`, `resolveTurnImages`.
- `src/chat/compose.ts`: `UserContentBlock`, `uploadTag`, `ComposedImage`, `UserTurn`, `ComposeInput`, `composePromptText`, `composeUserTurn`, `userTurnContent`, `toSdkPrompt`.
- `src/chat/backend.ts`: `ChatTurnImage`.
- `src/http/chatImages.ts`: `chatImageRoutes(deps, {maxUploadBytes?})` serving `POST /api/chat/images` (multipart `file`, optional `source`: `wall` default | `claude_code`, else 400 `invalid_source`), `GET /api/chat/images/:id`, `GET /api/chat/images/:id/{original,display,thumb,preview}`.
- `src/images/store.ts`: `DataDirs.chatImages`.
- Data dir: `<dataDir>/chat-images/YYYY/MM/<id>.<ext>`; derivatives in `<dataDir>/cache/c_<id>/`.
- Web: `useChatImages`, `MAX_CHAT_IMAGES`, `PendingChatImage` (`web/src/hooks/useChatImages.ts`); `ChatBarImage`, `ChatBarImageState`, `CHAT_THUMBS_PX` (`ChatBar.tsx`); `chatBarHasFocus` (`DropOverlay.tsx`); `ChatImage` (`web/src/types.ts`); `ChatImageUpload`, `uploadChatImage`, `chatImageUrl` (`web/src/api.ts`).
- Tests: `tests/integration/chat.images.int.test.ts`, `tests/unit/chat-compose.test.ts`, `tests/unit/chat-images.test.ts`, `web/src/hooks/useChatImages.test.tsx`.

**Signature changes:**
- `ChatRequest` gains required `images: readonly ChatTurnImage[]`; `message` may be `''` only when `images` is non-empty.
- `QueryFn` (`src/chat/agent.ts`): `prompt: string` -> `prompt: string | AsyncIterable<SDKUserMessage>` (a text-only turn still passes the plain string).
- `AgentChatOptions` gains optional `readPreview?: (absPath: string) => Promise<Uint8Array>`.
- `chatSchema` (`src/http/api.ts`): `message` defaults to `''`, new `image_ids?: string[]` (max 4); refine: message non-empty or image_ids non-empty. New error responses before streaming: 400 `unknown_image`, 409 `not_on_this_machine`, 422 `unreadable_image`, each `{error, id, message}`.
- `startHarness()` (`tests/integration/imageHarness.ts`) -> `startHarness(options: { chat?: ChatBackend } = {})`.
- Web: `postChat(message, threadId, signal)` -> `postChat(message, threadId, signal, imageIds = [])`; `useChat().ask(message)` -> `ask(message, imageIds = [])`; `ChatState` gains `images: string[]`; `ChatBarProps.left` becomes optional and gains `images`, `onPasteFiles`, `onRemoveImage`, `sendBlocked`, `variant: 'wall' | 'page'`; `AnswerPanelProps` gains optional `images`.

**Requires (from earlier phases):** nothing (first phase of the migration chain; it takes number 0003).

**Leaves alone (owned by others):**
- `resume`, `threadId`, `persistSession`, history tables, the context builder (Phase 7). `composeUserTurn` is the seam Phase 7 extends.
- `similar_images` and any `upload_id` tool input (Phase 6). This phase only puts `[image upload:ID]` in the prompt text.
- Claude Code capture / `ingestChatImage(..., source: 'claude_code')` callers (Phase 8).
- `src/chat/prompt.ts` (Phase 7 edits the system prompt), `src/mcp/*`, `claude/skills/n/SKILL.md`.
- `NoteEditor`, `NoteCard`, `RevealButton`, Lightbox (Phases 1, 2, 5). The thumbnails here do not open a lightbox; Phase 9 wires that.
- Note-file paste routing in `DropOverlay` (Phase 5) beyond the one `chatBarHasFocus()` guard added here.

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | header comment; `check` import; `chatImages` table + row types |
| `drizzle/0003_chat_images.sql` | create (generated) | `npm run db:generate -- --name chat_images` |
| `drizzle/meta/0003_snapshot.json` | create (generated) | same command |
| `drizzle/meta/_journal.json` | modify (generated) | same command |
| `src/chat/backend.ts` | modify | `ChatTurnImage`; `ChatRequest.images`; doc of `message` |
| `src/chat/images.ts` | create | chat image store: ingest (dedupe, heal), locate, resolve for a turn |
| `src/chat/compose.ts` | create | pure user-turn composition and SDK prompt shape |
| `src/chat/agent.ts` | modify | `QueryFn` prompt type; `readPreview`; `ChatRun.userTurn()`; `attempt` sends `toSdkPrompt` |
| `src/http/chatImages.ts` | create | upload + metadata + variant routes |
| `src/http/api.ts` | modify | `chatSchema`; `POST /api/chat` resolves `image_ids` before streaming |
| `src/http/app.ts` | modify | mount `chatImageRoutes` |
| `src/daemon.ts` | modify | `DATA_SUBDIRS` gains `chat-images` |
| `src/images/store.ts` | modify | `DataDirs.chatImages`, `ensureDataDirs` creates it |
| `tests/integration/setup.ts` | modify | `truncateAll` adds `chat_images` |
| `tests/integration/imageHarness.ts` | modify | `startHarness({chat})`; `reset()` clears `chat-images/` |
| `tests/integration/chat.images.int.test.ts` | create | schema, upload 201/200/413/415/400, `source` field (default `wall`, `claude_code`, invalid 400), heal, variants, chat validation, composed prompt via fake `query` |
| `tests/integration/daemon.int.test.ts` | modify | data dir list includes `chat-images` |
| `tests/unit/chat-compose.test.ts` | create | composition unit tests |
| `tests/unit/chat-images.test.ts` | create | paths, cache id, wire shape |
| `tests/unit/chat-agent.test.ts` | modify | `QueryFn` call type, `req()` images, new image tests |
| `tests/unit/chat-stub.test.ts` | modify | requests carry `images: []` |
| `tests/unit/images/store.test.ts` | modify | layout includes `chatImages` |
| `tests/live/chat.live.test.ts` | modify | `images: []`; one opt-in Claude image case |
| `web/src/types.ts` | modify | `ChatImage` |
| `web/src/api.ts` | modify | `uploadChatImage`, `chatImageUrl`, `postChat(…, imageIds)` |
| `web/src/hooks/useChatImages.ts` | create | pending-image state owned by App (reusable by Phase 9) |
| `web/src/hooks/useChatImages.test.tsx` | create | hook tests |
| `web/src/hooks/useChat.ts` | modify | `ask(message, imageIds)`, `images` state |
| `web/src/hooks/useChat.test.tsx` | modify | image-id posts |
| `web/src/components/ChatBar.tsx` | modify | paste handling, thumbnails, generic props, `data-chatbar` |
| `web/src/components/ChatBar.css` | modify | thumbnail row, disabled send, answer thumbnails |
| `web/src/components/ChatBar.test.tsx` | modify | paste/thumb/blocked/variant tests |
| `web/src/components/DropOverlay.tsx` | modify | `chatBarHasFocus`; global paste yields |
| `web/src/components/DropOverlay.test.tsx` | modify | helper + yield tests |
| `web/src/components/AnswerPanel.tsx` | modify | thumbnails of the sent images; image-only label |
| `web/src/components/AnswerPanel.test.tsx` | modify | thumbnail tests |
| `web/src/App.tsx` | modify | `useChatImages`, `send`, ChatBar/AnswerPanel props |
| `web/src/App.test.tsx` | modify | paste into focused bar vs elsewhere |
| `CHANGELOG.md` | modify | Unreleased line |
| `README.md` | modify | "The chat bar": pasting images |

## Implementation Steps

Worktree setup first (Invariant 10): `npm ci` if `node_modules` is missing; `ln -s ~/mcp-notes/.env.local .env.local` if missing (drizzle-kit loads it even for `generate`).

### Step 1: `chat_images` table in the schema
**File:** `src/db/schema.ts:1-12` (imports and header comment), append after `noteEmbeddings` (`:173`) and after the row types (`:180`)
**Change:** add `check` to the pg-core import, mention migration 0003 in the header, add the table and its types.
**Code:**

Replace line 2:
```ts
import { bigserial, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core'
```

Replace the header comment (lines 4-12):
```ts
/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`; migration 0002 (iteration 7, wall editing) adds `note_images` and copies every
 * legacy `notes.image_path` / `image_meta` image into it (hand-appended INSERT...SELECT, the same
 * SQL as src/images/legacy.ts `LEGACY_COPY_SQL`); migration 0003 (chat images) adds
 * `chat_images`, the images pasted into a chat. Change a table here, then `npm run db:generate`;
 * never edit an applied migration. drizzle-kit does not emit `CREATE EXTENSION`, so 0001 carries a
 * hand-prepended `CREATE EXTENSION IF NOT EXISTS vector`.
 */
```

Insert after the `noteEmbeddings` table (after line 173):
```ts
/** Where a chat image came from: pasted into the wall's chat bar, or captured from a Claude Code `/n` exchange. */
export type ChatImageSource = 'wall' | 'claude_code'

/**
 * One row per image pasted into a chat (migration 0003). Not a note image: a query image never
 * shows on the wall and never joins `note_images`. Stored once per byte content (sha256 unique,
 * no soft delete), so the same screenshot pasted twice is one row. Ids have the `A-B32` shape but
 * live in their own space and are always written `upload:ID`; their derivatives go to
 * `cache/c_<id>/` (src/chat/images.ts `chatImageCacheId`) so they can never meet a note image's
 * `cache/<id>/`.
 */
export const chatImages = pgTable(
  'chat_images',
  {
    /** `A-B32`, unique within this table only. */
    id: text('id').primaryKey(),
    /** Relative to the data dir: `chat-images/YYYY/MM/<id>.<ext>`. */
    path: text('path').notNull(),
    /** Lower-case hex sha256 of the original bytes. Unique: an upload of known bytes returns the existing row. */
    sha256: text('sha256').notNull(),
    /** Sniffed from magic bytes. */
    mime: text('mime').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Original size in bytes (the 50 MB chat cap fits int4). */
    bytes: integer('bytes').notNull(),
    originalName: text('original_name'),
    /** `os.hostname()` of the machine that first stored the file. */
    host: text('host'),
    source: text('source').$type<ChatImageSource>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_images_sha256_uniq').on(t.sha256),
    uniqueIndex('chat_images_path_uniq').on(t.path),
    index('chat_images_created_at_idx').on(t.createdAt),
    check('chat_images_source_check', sql`${t.source} in ('wall', 'claude_code')`),
  ],
)
```

Append after the last type export (line 180):
```ts
export type ChatImageRow = typeof chatImages.$inferSelect
export type NewChatImageRow = typeof chatImages.$inferInsert
```
**Impact:** none until the migration exists; `Db` (`src/db/client.ts`) picks the table up through `import * as schema`.

### Step 2: Generate migration 0003
**File:** `drizzle/0003_chat_images.sql`, `drizzle/meta/0003_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** run, from the worktree root:
```bash
npm run db:generate -- --name chat_images
```
Never hand-edit the result. Check it: `git status drizzle` shows exactly the three paths above; the SQL should read (drizzle-kit formatting may differ in whitespace only):
```sql
CREATE TABLE "chat_images" (
	"id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"original_name" text,
	"host" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_images_source_check" CHECK ("chat_images"."source" in ('wall', 'claude_code'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_images_sha256_uniq" ON "chat_images" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_images_path_uniq" ON "chat_images" USING btree ("path");--> statement-breakpoint
CREATE INDEX "chat_images_created_at_idx" ON "chat_images" USING btree ("created_at");
```
If the generated SQL touches any other table, stop: the snapshot chain is wrong. Do **not** run `npm run db:migrate` (that targets the shared Neon database); the integration tests apply it to Docker.
**Impact:** Phases 4, 6, 7 generate 0004-0006 on top of this snapshot.

### Step 3: `ChatTurnImage` and `ChatRequest.images`
**File:** `src/chat/backend.ts:24-31`
**Change:** replace the `ChatRequest` interface with the two declarations below.
**Code:**
```ts
/** One pasted image of a turn, resolved by the HTTP layer from `image_ids` (src/chat/images.ts `resolveTurnImages`). */
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
}

export interface ChatRequest {
  /** The user's message, trimmed. Empty only when `images` is non-empty. */
  message: string;
  /** Images pasted with this message, in the order the user sent them. Empty for a text-only message. */
  images: readonly ChatTurnImage[];
  /** The thread the client wants to continue, or null to start a new one. */
  threadId: string | null;
  /** Aborted when the HTTP client disconnects. Backends must stop yielding promptly. */
  signal: AbortSignal;
}
```
**Impact:** every `ChatRequest` literal must now pass `images` (api.ts route, chat-agent/chat-stub unit tests, live test); all updated in this phase. The stub and scripted backends ignore it.

### Step 4: The chat image store
**File:** `src/chat/images.ts` (new)
**Change:** store module reusing `probeImage`, `sha256Hex`, `writeNewFile`, `resolveInDataDir`, `fileExists`, `getPreview`. Derivatives keyed by `c_<id>` (one path segment: `path.basename('c_A-B32') === 'c_A-B32'`, and it never matches `ID_PATTERN`, so it cannot equal a note-image cache dir; `removeImageFiles` for notes never touches it).
**Code:**
```ts
import os from 'node:os';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chatImages, type ChatImageRow, type ChatImageSource } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { getPreview, OriginalMissingError, type ImageSource } from '../images/derive.js';
import { probeImage, sha256Hex, UnsupportedImageError, type ImageProbe } from '../images/probe.js';
import { DestinationExistsError, fileExists, removeQuietly, resolveInDataDir, writeNewFile } from '../images/store.js';
import { generateId, normalizeId } from '../notes/ids.js';
import type { ChatTurnImage } from './backend.js';

/** `<dataDir>/chat-images/`: originals of pasted chat images. */
export const CHAT_IMAGES_SUBDIR = 'chat-images';
/** Upload cap for one pasted chat image. */
export const MAX_CHAT_IMAGE_BYTES = 50 * 1024 * 1024;
/** At most this many images go with one chat message. */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 4;
const MAX_ID_ATTEMPTS = 20;

export interface ChatImageStoreDeps {
  db: Db;
  dataDir: string;
  /** Defaults to os.hostname(). */
  hostname?: () => string;
  /** Defaults to `() => new Date()`. Names the YYYY/MM folder and `created_at`. */
  now?: () => Date;
  /** Passed to generateId. Defaults to crypto.randomInt. */
  random?: (max: number) => number;
}

/** The store over the daemon's own db and data dir. No AppDeps field: built from `deps.db` + `config.dataDir`. */
export function chatImageStoreFor(app: AppDeps): ChatImageStoreDeps {
  return { db: app.db, dataDir: app.config.dataDir };
}

/** `chat-images/YYYY/MM/<id>.<ext>`, forward slashes, YYYY/MM in process-local time of `savedAt`. */
export function chatImageRelPath(id: string, ext: string, savedAt: Date): string {
  const yyyy = String(savedAt.getFullYear()).padStart(4, '0');
  const mm = String(savedAt.getMonth() + 1).padStart(2, '0');
  return `${CHAT_IMAGES_SUBDIR}/${yyyy}/${mm}/${id}.${ext}`;
}

/** The derivative cache key: `cache/c_<id>/`. Prefixed so it never equals a note image's `cache/<id>/`. */
export function chatImageCacheId(id: string): string {
  return `c_${id}`;
}

export type ChatImageVariant = 'original' | 'display' | 'thumb' | 'preview';

export function chatImageUrl(id: string, variant: ChatImageVariant): string {
  return `/api/chat/images/${id}/${variant}`;
}

/** The wire shape of a chat image (upload result, `GET /api/chat/images/:id`). */
export interface ChatImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  original_name: string | null;
  host: string | null;
  source: ChatImageSource;
  created_at: string;
  /** The original exists under this machine's data dir. */
  available: boolean;
  urls: Record<ChatImageVariant, string>;
}

export function toChatImage(row: ChatImageRow, available: boolean): ChatImage {
  return {
    id: row.id,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    original_name: row.originalName,
    host: row.host,
    source: row.source,
    created_at: row.createdAt.toISOString(),
    available,
    urls: {
      original: chatImageUrl(row.id, 'original'),
      display: chatImageUrl(row.id, 'display'),
      thumb: chatImageUrl(row.id, 'thumb'),
      preview: chatImageUrl(row.id, 'preview'),
    },
  };
}

export type ChatImageInputErrorCode = 'not_an_image' | 'too_large';

/** The uploaded bytes cannot become a chat image. HTTP: too_large -> 413, not_an_image -> 415. */
export class ChatImageInputError extends Error {
  override name = 'ChatImageInputError';
  constructor(
    readonly code: ChatImageInputErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ChatImageLookupErrorCode = 'unknown_image' | 'not_on_this_machine' | 'unreadable_image';

/** An `image_ids` entry of a chat request cannot be sent. HTTP: 400 / 409 / 422. */
export class ChatImageLookupError extends Error {
  override name = 'ChatImageLookupError';
  constructor(
    readonly code: ChatImageLookupErrorCode,
    readonly imageId: string,
    message: string,
  ) {
    super(message);
  }
}

export async function findChatImage(db: Db, id: string): Promise<ChatImageRow | null> {
  const rows = await db.select().from(chatImages).where(eq(chatImages.id, id)).limit(1);
  return rows[0] ?? null;
}

async function findChatImageBySha(db: Db, sha256: string): Promise<ChatImageRow | null> {
  const rows = await db.select().from(chatImages).where(eq(chatImages.sha256, sha256)).limit(1);
  return rows[0] ?? null;
}

/** Serialises ingests of the same bytes inside this process (the unique index covers other hosts). */
const shaLocks = new Map<string, Promise<unknown>>();

async function withShaLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const prev = shaLocks.get(sha256) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  shaLocks.set(sha256, tail);
  try {
    return await run;
  } finally {
    if (shaLocks.get(sha256) === tail) shaLocks.delete(sha256);
  }
}

/**
 * Known bytes whose original is missing here (stored by the other laptop, or deleted by hand):
 * the identical bytes go back to the row's path, so this machine can serve and send it. True when
 * the original is on disk afterwards.
 */
async function ensureLocalCopy(deps: ChatImageStoreDeps, row: ChatImageRow, bytes: Uint8Array): Promise<boolean> {
  const abs = resolveInDataDir(deps.dataDir, row.path);
  if (await fileExists(abs)) return true;
  try {
    await writeNewFile(abs, bytes);
  } catch (err) {
    if (!(err instanceof DestinationExistsError)) throw err;
  }
  return true;
}

export interface IngestChatImageInput {
  bytes: Uint8Array;
  /** The client's file name, kept for display only. */
  originalName: string | null;
  source: ChatImageSource;
  /** Default MAX_CHAT_IMAGE_BYTES. */
  maxBytes?: number;
}

export interface IngestChatImageResult {
  image: ChatImage;
  /** False when the same bytes were already stored: `image` is that row. */
  created: boolean;
}

/**
 * Store one pasted image: sha256 dedupe (existing row returned, its file healed when missing),
 * probe by magic bytes, write `chat-images/YYYY/MM/<id>.<ext>`, insert. A new id is free in
 * `chat_images` only (its own id space). A lost insert race (same bytes from another process or
 * host) removes this process's file and returns the winner.
 */
export async function ingestChatImage(deps: ChatImageStoreDeps, input: IngestChatImageInput): Promise<IngestChatImageResult> {
  const maxBytes = input.maxBytes ?? MAX_CHAT_IMAGE_BYTES;
  const size = input.bytes.byteLength;
  if (size === 0) throw new ChatImageInputError('not_an_image', 'the uploaded file is empty');
  if (size > maxBytes) throw new ChatImageInputError('too_large', `file is ${size} bytes; the limit is ${maxBytes}`);
  const sha256 = sha256Hex(input.bytes);

  return withShaLock(sha256, async (): Promise<IngestChatImageResult> => {
    const existing = await findChatImageBySha(deps.db, sha256);
    if (existing !== null) {
      return { image: toChatImage(existing, await ensureLocalCopy(deps, existing, input.bytes)), created: false };
    }

    let probe: ImageProbe;
    try {
      probe = await probeImage(input.bytes);
    } catch (err) {
      if (err instanceof UnsupportedImageError) throw new ChatImageInputError('not_an_image', `not an image: ${err.message}`);
      throw err;
    }

    const savedAt = (deps.now ?? (() => new Date()))();
    const host = (deps.hostname ?? os.hostname)();
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = generateId(deps.random);
      if ((await findChatImage(deps.db, id)) !== null) continue;
      const rel = chatImageRelPath(id, probe.mimeExt, savedAt);
      const abs = resolveInDataDir(deps.dataDir, rel);
      try {
        await writeNewFile(abs, input.bytes);
      } catch (err) {
        if (err instanceof DestinationExistsError) continue; // a stray file from a crashed run: take another id
        throw err;
      }
      let inserted: ChatImageRow[];
      try {
        inserted = await deps.db
          .insert(chatImages)
          .values({
            id,
            path: rel,
            sha256,
            mime: probe.mime,
            width: probe.width,
            height: probe.height,
            bytes: size,
            originalName: input.originalName,
            host,
            source: input.source,
            createdAt: savedAt,
          })
          .onConflictDoNothing()
          .returning();
      } catch (err) {
        await removeQuietly(abs);
        throw err;
      }
      const row = inserted[0];
      if (row !== undefined) return { image: toChatImage(row, true), created: true };
      // Conflict: the same bytes landed meanwhile (sha256), or the id was just taken. Either way this file goes.
      await removeQuietly(abs);
      const holder = await findChatImageBySha(deps.db, sha256);
      if (holder !== null) {
        return { image: toChatImage(holder, await ensureLocalCopy(deps, holder, input.bytes)), created: false };
      }
    }
    throw new Error('Could not find a free chat image id.');
  });
}

export interface LocatedChatImage {
  row: ChatImageRow;
  /** What the derive.ts getters take; `id` is the `c_<id>` cache key. */
  source: ImageSource;
  available: boolean;
}

/** A chat image by id (any spelling `normalizeId` accepts), or null. */
export async function locateChatImage(
  deps: Pick<ChatImageStoreDeps, 'db' | 'dataDir'>,
  rawId: string,
): Promise<LocatedChatImage | null> {
  const id = normalizeId(rawId);
  if (id === null) return null;
  const row = await findChatImage(deps.db, id);
  if (row === null) return null;
  const originalPath = resolveInDataDir(deps.dataDir, row.path);
  return {
    row,
    source: { id: chatImageCacheId(row.id), mime: row.mime, originalPath },
    available: await fileExists(originalPath),
  };
}

/**
 * The images of one chat request, deduped (first spelling wins), in request order, each with its
 * `preview` derivative generated. Throws ChatImageLookupError for an unknown id, an original that
 * is not on this machine, or a preview that cannot be made.
 */
export async function resolveTurnImages(
  deps: Pick<ChatImageStoreDeps, 'db' | 'dataDir'>,
  rawIds: readonly string[],
): Promise<ChatTurnImage[]> {
  const out: ChatTurnImage[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = normalizeId(raw);
    if (id === null) throw new ChatImageLookupError('unknown_image', raw, `no pasted image ${raw}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const loc = await locateChatImage(deps, id);
    if (loc === null) throw new ChatImageLookupError('unknown_image', id, `no pasted image ${id}`);
    if (!loc.available) {
      throw new ChatImageLookupError(
        'not_on_this_machine',
        id,
        `pasted image ${id} is stored on ${loc.row.host ?? 'another machine'}, not on this one`,
      );
    }
    let previewPath: string;
    try {
      previewPath = await getPreview(deps.dataDir, loc.source);
    } catch (err) {
      if (err instanceof OriginalMissingError) {
        throw new ChatImageLookupError('not_on_this_machine', id, `pasted image ${id} is not on this machine`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new ChatImageLookupError('unreadable_image', id, `could not prepare pasted image ${id}: ${reason}`);
    }
    out.push({
      id,
      previewPath,
      previewMime: 'image/jpeg',
      width: loc.row.width,
      height: loc.row.height,
      originalName: loc.row.originalName,
    });
  }
  return out;
}
```
**Impact:** new module; Phase 6 (`upload_id`) and Phase 8 (capture) are expected to call `locateChatImage`/`getPreview` and `ingestChatImage(…, source: 'claude_code')`.

### Step 5: Pure user-turn composition
**File:** `src/chat/compose.ts` (new)
**Change:** the one place the user turn is shaped. Phase 7 extends `composeUserTurn` with history; keep everything here pure (no fs, no db).
**Code:**
```ts
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatTurnImage } from './backend.js';

/** One content block of a user message, as the Agent SDK takes it (an Anthropic `ContentBlockParam`). */
export type UserContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number];

/** How a chat image is named to the model and in chat text: `[image upload:A-B32]`. */
export function uploadTag(id: string): string {
  return `[image upload:${id}]`;
}

export interface ComposedImage {
  id: string;
  mediaType: ChatTurnImage['previewMime'];
  /** Base64 of the preview file. */
  data: string;
}

/** What the model receives for one turn: image blocks (in order) and then this text. */
export interface UserTurn {
  text: string;
  images: readonly ComposedImage[];
}

export interface ComposeInput {
  message: string;
  images: readonly Pick<ChatTurnImage, 'id' | 'previewMime'>[];
}

/**
 * The text block: the message, then a short note and one `[image upload:ID]` line per image so
 * the model can pass the id to tools. A text-only turn is the message unchanged.
 */
export function composePromptText(message: string, imageIds: readonly string[]): string {
  if (imageIds.length === 0) return message;
  const header =
    imageIds.length === 1
      ? 'The owner attached 1 image to this message. It is shown above, and its upload id is:'
      : `The owner attached ${imageIds.length} images to this message. They are shown above in this order, with these upload ids:`;
  const block = [header, ...imageIds.map(uploadTag)].join('\n');
  return message === '' ? block : `${message}\n\n${block}`;
}

/** Pure. `previews[i]` is the base64 of `input.images[i]`'s preview file. */
export function composeUserTurn(input: ComposeInput, previews: readonly string[]): UserTurn {
  if (previews.length !== input.images.length) {
    throw new Error(`composeUserTurn: ${input.images.length} images but ${previews.length} previews`);
  }
  return {
    text: composePromptText(
      input.message,
      input.images.map((image) => image.id),
    ),
    images: input.images.map((image, i) => ({ id: image.id, mediaType: image.previewMime, data: previews[i] as string })),
  };
}

/** Image blocks first (the order the owner pasted them), then the text block. */
export function userTurnContent(turn: UserTurn): UserContentBlock[] {
  const blocks = turn.images.map(
    (image): UserContentBlock => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    }),
  );
  blocks.push({ type: 'text', text: turn.text });
  return blocks;
}

/**
 * The `prompt` for the SDK's `query`: the plain string for a text-only turn (unchanged behaviour),
 * else a stream of exactly one user message. The SDK closes the CLI's stdin when the stream ends
 * (this run has no hooks, no canUseTool and no in-process MCP server), and the CLI finishes that
 * one turn. A stream can be read once: build a fresh one per attempt.
 */
export function toSdkPrompt(turn: UserTurn): string | AsyncIterable<SDKUserMessage> {
  if (turn.images.length === 0) return turn.text;
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: userTurnContent(turn) },
    parent_tool_use_id: null,
  };
  return (async function* oneMessage(): AsyncGenerator<SDKUserMessage> {
    yield message;
  })();
}
```
**Impact:** none by itself.

### Step 6: The agent sends image blocks
**File:** `src/chat/agent.ts:1-12` (imports), `:18` (`QueryFn`), `:20-34` (`AgentChatOptions`), `:108-113` (`RunDeps`), `:116-128` (`ChatRun` fields), new `userTurn()` after `end()` (`:150-153`), `:199-268` (`attempt`), `:275-325` (`createAgentChatBackend`)
**Change:** verified against `node_modules/@anthropic-ai/claude-agent-sdk@0.3.311/sdk.d.ts:3330`: `query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`; `SDKUserMessage` requires only `type: 'user'`, `message: MessageParam`, `parent_tool_use_id: string | null` (`session_id`, `uuid` are optional). `streamInput` writes each message, then calls `transport.endInput()` unless the run has bidirectional needs (ours has none), so one yielded message is one turn.

Imports (replace lines 1-12):
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

`QueryFn` (replace line 18):
```ts
/** The slice of the SDK's `query` the backend uses. Tests inject a fake. A turn with images passes a one-message stream. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;
```

`AgentChatOptions` (replace lines 20-34):
```ts
export interface AgentChatOptions {
  chat: AgentChatConfig;
  /** Fixed cwd of every run (`<dataDir>/chat`), so sessions live in one ~/.claude/projects dir. */
  cwd: string;
  /** The daemon's own MCP endpoint. Read at the start of each run; the port is known only after listen. */
  mcpUrl: () => string;
  /** Default: the SDK's `query`. */
  query?: QueryFn;
  /** Default: `() => new Date()`. */
  now?: () => Date;
  /** Env the child env is derived from. Default: `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** One-line operational log (fallbacks). Default: console.warn. */
  log?: (line: string) => void;
  /** Reads a pasted image's preview file (sent base64 in the prompt). Default: fs.readFile. */
  readPreview?: (absPath: string) => Promise<Uint8Array>;
}
```

`RunDeps` (replace lines 108-113):
```ts
interface RunDeps {
  chat: AgentChatConfig;
  query: QueryFn;
  log: (line: string) => void;
  optionsFor: (brain: ChatBrain, resume: string | null, abortController: AbortController) => Options;
  readPreview: (absPath: string) => Promise<Uint8Array>;
}
```

`ChatRun` fields (replace lines 116-128; constructor unchanged):
```ts
class ChatRun {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onClientAbort = (): void => this.stop('client');
  private reason: StopReason | null = null;
  private finished = false;
  private outcome: ChatTurnEnd | null = null;
  /** True once any `delta` went out. After that a failure is final (no duplicate output). */
  private emittedText = false;
  /** True when a tool_use came after the last emitted text: the next text starts a new paragraph. */
  private toolSinceText = false;
  /** The caption currently shown by the panel ("" = none). */
  private caption = '';
  /** The composed user turn, built once per run (the GLM retry reuses it). */
  private turnLoad: Promise<UserTurn> | null = null;
```

New method, insert right after `end()` (after line 153):
```ts
  /** Reads each pasted image's preview once and composes the turn. A missing file fails the turn without a fallback. */
  private userTurn(): Promise<UserTurn> {
    this.turnLoad ??= (async (): Promise<UserTurn> => {
      const previews: string[] = [];
      for (const image of this.request.images) {
        let bytes: Uint8Array;
        try {
          bytes = await this.deps.readPreview(image.previewPath);
        } catch (err) {
          throw new AttemptError(`Could not read pasted image ${image.id}: ${errorText(err)}`, false);
        }
        previews.push(Buffer.from(bytes).toString('base64'));
      }
      return composeUserTurn(this.request, previews);
    })();
    return this.turnLoad;
  }
```

`attempt` (replace lines 199-268 in full):
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
        prompt: toSdkPrompt(turn),
        options: this.deps.optionsFor(brain, this.request.threadId, controller),
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
            this.outcome = { threadId: message.session_id, brain };
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

`createAgentChatBackend` (replace lines 275-325 in full; `optionsFor` body unchanged, `resume` kept, Phase 7 removes it):
```ts
export function createAgentChatBackend(options: AgentChatOptions): AgentChatBackend {
  const { chat, cwd, mcpUrl } = options;
  const query: QueryFn = options.query ?? sdkQuery;
  const now = options.now ?? (() => new Date());
  const baseEnv = options.baseEnv ?? process.env;
  const log = options.log ?? ((line: string) => console.warn(line));
  const readPreview = options.readPreview ?? ((absPath: string): Promise<Uint8Array> => readFile(absPath));
  const claudeBin = resolveExecutable(chat.claudeBin, baseEnv.PATH);
  const allowedTools = allowedChatTools();

  function optionsFor(brain: ChatBrain, resume: string | null, abortController: AbortController): Options {
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
      resume: resume ?? undefined,
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
**Impact:** text-only turns are byte-for-byte unchanged (`prompt` is still the message string). Image turns use SDK streaming-input mode. The GLM fallback rebuilds a fresh stream with the same blocks. Whether GLM's Anthropic-compatible endpoint accepts image blocks is not verified; if it rejects them the error surfaces as today's `event: error` (risk noted).

### Step 7: Chat image HTTP routes
**File:** `src/http/chatImages.ts` (new)
**Change:** upload, metadata and variants. Serving mirrors `src/http/images.ts` `sendResolved` (same headers, CSP, ETag/304, immutable originals). `src/http/images.ts` is deliberately not refactored (Handoffs).
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ChatImageInputError,
  chatImageStoreFor,
  ingestChatImage,
  locateChatImage,
  MAX_CHAT_IMAGE_BYTES,
  toChatImage,
  type ChatImageStoreDeps,
  type ChatImageVariant,
} from '../chat/images.js';
import type { ChatImageSource } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { getDisplay, getPreview, getThumb, OriginalMissingError } from '../images/derive.js';
import { etagMatches } from './imageAccess.js';

export interface ChatImageRouteOptions {
  /** Upload cap in bytes. Default MAX_CHAT_IMAGE_BYTES (50 MB). Tests lower it. */
  maxUploadBytes?: number;
}

/** Room for multipart boundaries on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

const VARIANTS: readonly ChatImageVariant[] = ['original', 'display', 'thumb', 'preview'];

const DERIVED_MIME = { thumb: 'image/webp', preview: 'image/jpeg' } as const;

interface ServedChatFile {
  absPath: string;
  mime: string;
  etag: string;
  size: number;
  /** true for originals: bytes behind this URL never change. */
  immutable: boolean;
  /** Set when the original itself is served: becomes an inline Content-Disposition filename. */
  downloadName: string | null;
}

type VariantResult =
  | { status: 'ok'; file: ServedChatFile }
  | { status: 'not_found' }
  | { status: 'not_on_this_machine'; host: string | null };

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** One variant of a chat image as a file. Derivatives are generated into `cache/c_<id>/` on first request. */
async function resolveVariant(store: ChatImageStoreDeps, rawId: string, variant: ChatImageVariant): Promise<VariantResult> {
  const loc = await locateChatImage(store, rawId);
  if (loc === null) return { status: 'not_found' };
  const host = loc.row.host;
  if (!loc.available) return { status: 'not_on_this_machine', host };
  const sha = loc.row.sha256;
  try {
    let absPath: string;
    let mime: string;
    let servedOriginal = false;
    if (variant === 'original') {
      absPath = loc.source.originalPath;
      mime = loc.row.mime;
      servedOriginal = true;
    } else if (variant === 'display') {
      const d = await getDisplay(store.dataDir, loc.source);
      absPath = d.path;
      mime = d.mime;
      servedOriginal = d.path === loc.source.originalPath;
    } else if (variant === 'thumb') {
      absPath = await getThumb(store.dataDir, loc.source);
      mime = DERIVED_MIME.thumb;
    } else {
      absPath = await getPreview(store.dataDir, loc.source);
      mime = DERIVED_MIME.preview;
    }
    const st = await stat(absPath);
    return {
      status: 'ok',
      file: {
        absPath,
        mime,
        etag: servedOriginal ? `"${sha}"` : `"${sha}-${variant}"`,
        size: st.size,
        immutable: servedOriginal,
        downloadName: servedOriginal ? loc.row.originalName : null,
      },
    };
  } catch (err) {
    if (err instanceof OriginalMissingError) return { status: 'not_on_this_machine', host };
    throw err;
  }
}

function sendVariant(c: Context, r: VariantResult): Response {
  if (r.status === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (r.status === 'not_on_this_machine') return c.json({ error: 'not_on_this_machine', host: r.host }, 404);
  const f = r.file;
  const headers: Record<string, string> = {
    'Content-Type': f.mime,
    ETag: f.etag,
    'Cache-Control': f.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  if (f.downloadName) headers['Content-Disposition'] = contentDisposition(f.downloadName);
  if (etagMatches(c.req.header('if-none-match'), f.etag)) {
    return c.body(null, 304, headers);
  }
  headers['Content-Length'] = String(f.size);
  const stream = Readable.toWeb(createReadStream(f.absPath)) as unknown as ReadableStream<Uint8Array>;
  return c.body(stream, 200, headers);
}

/**
 * Chat image routes (pasted into the chat bar; never notes):
 * - POST /api/chat/images: multipart `file` (+ optional `source`: `wall` default | `claude_code`,
 *   sent by the Claude Code notes-paste hook, phase 8) -> 201 `{image, created: true}`, or 200
 *   `{image, created: false}` when the same bytes are already stored (the first upload's `source`
 *   is kept). 400 invalid_source, 413 too_large, 415 not_an_image.
 * - GET /api/chat/images/:id: the wire `ChatImage`.
 * - GET /api/chat/images/:id/{original|display|thumb|preview}: the file.
 */
export function chatImageRoutes(deps: AppDeps, opts: ChatImageRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_CHAT_IMAGE_BYTES;
  const store = chatImageStoreFor(deps);
  const r = new Hono();

  r.post(
    '/api/chat/images',
    bodyLimit({
      maxSize: maxUpload + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: 'too_large', max_bytes: maxUpload }, 413),
    }),
    async (c) => {
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'bad_multipart' }, 400);
      }
      const fileField = Array.isArray(form['file']) ? form['file'][0] : form['file'];
      if (!(fileField instanceof File)) return c.json({ error: 'file_required' }, 400);
      const sourceField = Array.isArray(form['source']) ? form['source'][0] : form['source'];
      let source: ChatImageSource = 'wall';
      if (sourceField !== undefined) {
        if (sourceField !== 'wall' && sourceField !== 'claude_code') {
          return c.json({ error: 'invalid_source', message: 'source must be wall or claude_code' }, 400);
        }
        source = sourceField;
      }
      if (fileField.size > maxUpload) {
        return c.json(
          { error: 'too_large', message: `file is ${fileField.size} bytes; the limit is ${maxUpload}`, max_bytes: maxUpload },
          413,
        );
      }
      const bytes = Buffer.from(await fileField.arrayBuffer());
      try {
        const result = await ingestChatImage(store, {
          bytes,
          originalName: fileField.name || null,
          source,
          maxBytes: maxUpload,
        });
        return c.json(result, result.created ? 201 : 200);
      } catch (err) {
        if (err instanceof ChatImageInputError) {
          return c.json({ error: err.code, message: err.message }, err.code === 'too_large' ? 413 : 415);
        }
        throw err;
      }
    },
  );

  r.get('/api/chat/images/:id', async (c) => {
    const loc = await locateChatImage(store, c.req.param('id') ?? '');
    if (loc === null) return c.json({ error: 'not_found' }, 404);
    return c.json(toChatImage(loc.row, loc.available));
  });

  for (const variant of VARIANTS) {
    r.get(`/api/chat/images/:id/${variant}`, async (c) =>
      sendVariant(c, await resolveVariant(store, c.req.param('id') ?? '', variant)),
    );
  }

  return r;
}
```
**Impact:** no `sameOriginOnly` guard, consistent with `POST /api/images` (the Vite dev proxy and the wall both upload there today). The wall sends no `source` and gets `wall`; Phase 8's paste hook sends `source=claude_code` (field owned here so Phase 8 never edits this file). A dedupe hit keeps the first upload's `source`: it is provenance, not access control.

### Step 8: `POST /api/chat` takes `image_ids`
**File:** `src/http/api.ts:1-11` (imports), `:34-37` (`chatSchema`), `:246-277` (route)
**Change:**

Imports (replace lines 4-5):
```ts
import type { ChatBackend, ChatBrain, ChatEvent, ChatTurnImage } from '../chat/backend.js';
import {
  ChatImageLookupError,
  chatImageStoreFor,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  resolveTurnImages,
  type ChatImageLookupErrorCode,
} from '../chat/images.js';
import { createStubChatBackend } from '../chat/stub.js';
```

`chatSchema` (replace lines 34-37) plus a status helper right after it:
```ts
const chatSchema = z
  .object({
    message: z.string().trim().default(''),
    thread_id: z.string().trim().min(1).max(200).optional(),
    /** Chat image ids from POST /api/chat/images, in paste order. */
    image_ids: z.array(z.string().trim().min(1).max(16)).max(MAX_CHAT_IMAGES_PER_MESSAGE).optional(),
  })
  .refine((v) => v.message.length > 0 || (v.image_ids?.length ?? 0) > 0, {
    message: 'a message or at least one image is required',
    path: ['message'],
  });

/** ChatImageLookupError -> HTTP status, answered as JSON before any SSE. */
function chatImageErrorStatus(code: ChatImageLookupErrorCode): 400 | 409 | 422 {
  switch (code) {
    case 'unknown_image':
      return 400;
    case 'not_on_this_machine':
      return 409;
    case 'unreadable_image':
      return 422;
  }
}
```

Route (replace lines 246-277 in full):
```ts
  api.post('/api/chat', async (c) => {
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = chatSchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    const { message, thread_id, image_ids } = parsed.data;

    // Resolve (and derive the preview of) every pasted image before the stream opens, so a bad id
    // is a plain JSON error the client can show.
    let images: ChatTurnImage[] = [];
    if (image_ids !== undefined && image_ids.length > 0) {
      try {
        images = await resolveTurnImages(chatImageStoreFor(deps), image_ids);
      } catch (err) {
        if (!(err instanceof ChatImageLookupError)) throw err;
        return c.json({ error: err.code, id: err.imageId, message: err.message }, chatImageErrorStatus(err.code));
      }
    }

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      try {
        const turn = await chat.reply({
          message,
          images,
          threadId: thread_id ?? null,
          signal: controller.signal,
        });
        for await (const event of turn.events) {
          if (controller.signal.aborted) return;
          await stream.writeSSE({ event: chatEventName(event), data: JSON.stringify({ text: event.text }) });
        }
        if (controller.signal.aborted) return;
        const end = turn.end();
        const done: { thread_id: string; brain?: ChatBrain } = { thread_id: end.threadId };
        if (end.brain !== undefined) done.brain = end.brain;
        await stream.writeSSE({ event: 'done', data: JSON.stringify(done) });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error }) });
      }
    });
  });
```
**Impact:** existing validation behaviour holds (`{}`, `{message:'   '}`, `{message:3}` are still 400 JSON; verified with zod 4.4.3).

### Step 9: Mount the routes
**File:** `src/http/app.ts:5-8` (imports), `:51-54` (doc comment), `:69` (route)
**Change:** add the import after `import { imageRoutes } from './images.js';`:
```ts
import { chatImageRoutes } from './chatImages.js';
```
Replace the `createApp` doc comment:
```ts
/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), imageRoutes (P5), chatImageRoutes (pasted chat images),
 * revealRoutes (iteration 7: capabilities + reveal), staticRoutes (P6, last: it owns the SPA
 * fallback; it reserves /api, so the order is for clarity).
 */
```
Insert after `app.route('/', imageRoutes(deps));`:
```ts
  app.route('/', chatImageRoutes(deps));
```
**Impact:** `AppDeps` unchanged; every harness gets the routes through `createApp`.

### Step 10: Data dirs
**File:** `src/daemon.ts:6-15` (imports), `:20`
**Change:** add the import `import { CHAT_IMAGES_SUBDIR } from './chat/images.js';` (after the `./chat/backend.js` import) and replace line 20:
```ts
export const DATA_SUBDIRS = ['images', 'cache', 'inbox', join('inbox', 'failed'), CHAT_SUBDIR, CHAT_IMAGES_SUBDIR] as const;
```

**File:** `src/images/store.ts:5-29`
**Change:** replace `DataDirs`, `dataDirs` and `ensureDataDirs`. (A literal, not `CHAT_IMAGES_SUBDIR`: `src/chat/images.ts` imports this module.)
```ts
export type DataDirs = {
  root: string;
  images: string;
  cache: string;
  inbox: string;
  failed: string;
  /** Originals of images pasted into a chat (src/chat/images.ts CHAT_IMAGES_SUBDIR). */
  chatImages: string;
};

export function dataDirs(dataDir: string): DataDirs {
  const root = path.resolve(dataDir);
  return {
    root,
    images: path.join(root, 'images'),
    cache: path.join(root, 'cache'),
    inbox: path.join(root, 'inbox'),
    failed: path.join(root, 'inbox', 'failed'),
    chatImages: path.join(root, 'chat-images'),
  };
}

/** Create images/, cache/, inbox/, inbox/failed/ and chat-images/ under the data dir if missing. */
export async function ensureDataDirs(dataDir: string): Promise<DataDirs> {
  const dirs = dataDirs(dataDir);
  for (const d of [dirs.images, dirs.cache, dirs.failed, dirs.chatImages]) await mkdir(d, { recursive: true });
  return dirs;
}
```
**Impact:** `writeNewFile` already creates parent dirs, so the store works even where these were never made (api harness).

### Step 11: Test infra
**File:** `tests/integration/setup.ts:50`
```ts
  await db.execute(sql`truncate table chat_images, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```

**File:** `tests/integration/imageHarness.ts:1-15` (imports), `:27-43`, `:60-66`
Add the import `import type { ChatBackend } from '../../src/chat/backend.js';` and replace `startHarness`'s signature/app line and `reset()`:
```ts
export interface HarnessOptions {
  /** The brain behind POST /api/chat. Omitted: createApp's default (the stub). */
  chat?: ChatBackend;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-p5-'));
  for (const sub of ['images', 'cache', 'inbox', 'inbox/failed', 'chat-images']) {
    await mkdir(path.join(dataDir, sub), { recursive: true });
  }
  const db = openTestDb();
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir, events });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG },
    db,
    events,
    service,
    embedder: null,
  };
  const app = createApp(deps, options.chat !== undefined ? { chat: options.chat } : {});
  let server: ServerType | undefined;
```
(the returned object is unchanged except `reset`):
```ts
    async reset() {
      await truncateAll(db);
      for (const sub of ['images', 'cache', 'chat-images']) {
        await rm(path.join(dataDir, sub), { recursive: true, force: true });
        await mkdir(path.join(dataDir, sub), { recursive: true });
      }
    },
```

**File:** `tests/integration/daemon.int.test.ts:45`
```ts
    for (const sub of ['images', 'cache', 'inbox', 'inbox/failed', 'chat', 'chat-images']) expect(existsSync(join(dataDir, sub))).toBe(true);
```

**File:** `tests/unit/images/store.test.ts:37-42`
```ts
  it('ensureDataDirs creates the layout', async () => {
    const dirs = await ensureDataDirs(dir);
    for (const d of [dirs.images, dirs.cache, dirs.inbox, dirs.failed, dirs.chatImages]) {
      expect(statSync(d).isDirectory()).toBe(true);
    }
    expect(dirs.chatImages).toBe(path.join(path.resolve(dir), 'chat-images'));
  });
```

**File:** `tests/unit/chat-stub.test.ts:28-32, 41, 50-54, 62`
Every `backend.reply({...})` literal gains `images: []`, e.g.:
```ts
    const turn = await backend.reply({
      message: 'hello',
      images: [],
      threadId: null,
      signal: new AbortController().signal,
    });
```
```ts
    const turn = await backend.reply({ message: 'hi', images: [], threadId: null, signal: new AbortController().signal });
```
```ts
    const turn = await backend.reply({
      message: 'hello',
      images: [],
      threadId: 'thread-1',
      signal: new AbortController().signal,
    });
```
```ts
    const turn = await backend.reply({ message: 'x', images: [], threadId: null, signal: controller.signal });
```

### Step 12: Agent unit tests
**File:** `tests/unit/chat-agent.test.ts:1-10`, `:129-138`, `:152-166`, append a describe at the end
**Change:** the fake records the union prompt type; `req()` passes `images`; `backend()` accepts extra options; new image tests.

Imports (replace lines 1-10):
```ts
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  createAgentChatBackend,
  type AgentChatConfig,
  type AgentChatOptions,
  type QueryFn,
} from '../../src/chat/agent.js';
import type { ChatEvent, ChatRequest, ChatTurn, ChatTurnImage } from '../../src/chat/backend.js';
import { allowedChatTools } from '../../src/chat/status.js';
```

`fakeQuery` (replace lines 129-138):
```ts
type QueryCall = Parameters<QueryFn>[0];

function fakeQuery(...scripts: Script[]): { query: QueryFn; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const script = scripts[calls.length - 1];
    if (!script) throw new Error(`fake query: unexpected call #${calls.length}`);
    return script(params.options);
  };
  return { query, calls };
}
```

`backend` and `req` (replace lines 152-166):
```ts
function backend(query: QueryFn, chat: Partial<AgentChatConfig> = {}, extra: Partial<AgentChatOptions> = {}) {
  return createAgentChatBackend({
    chat: { ...CHAT, ...chat },
    cwd: '/data/chat',
    mcpUrl: () => MCP_URL,
    query,
    now: () => new Date('2026-10-30T03:00:00Z'),
    baseEnv: { PATH: '/usr/bin', HOME: '/home/owner', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak' },
    log: () => {},
    ...extra,
  });
}

function req(
  message: string,
  threadId: string | null = null,
  signal = new AbortController().signal,
  images: ChatTurnImage[] = [],
): ChatRequest {
  return { message, images, threadId, signal };
}
```

Append at the end of the file:
```ts
// ---------- pasted images ----------

const RED: ChatTurnImage = { id: 'U-PL1', previewPath: '/cache/c_U-PL1/preview.jpg', previewMime: 'image/jpeg', width: 40, height: 30, originalName: 'red.png' };
const BLUE: ChatTurnImage = { id: 'V-QM2', previewPath: '/cache/c_V-QM2/preview.jpg', previewMime: 'image/jpeg', width: 8, height: 8, originalName: null };
const PREVIEWS: Record<string, Uint8Array> = {
  [RED.previewPath]: new Uint8Array([1, 2, 3]),
  [BLUE.previewPath]: new Uint8Array([4, 5, 6, 7]),
};

async function readPreview(absPath: string): Promise<Uint8Array> {
  const bytes = PREVIEWS[absPath];
  if (bytes === undefined) throw new Error(`ENOENT: no such file, open '${absPath}'`);
  return bytes;
}

async function sentMessages(prompt: QueryCall['prompt'] | undefined): Promise<SDKUserMessage[]> {
  if (prompt === undefined || typeof prompt === 'string') throw new Error('expected a user-message stream');
  const out: SDKUserMessage[] = [];
  for await (const m of prompt) out.push(m);
  return out;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('agent chat backend: pasted images', () => {
  it('sends one user message: an image block per image in order, then the text naming each upload id', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('Red and blue.'), success()]));
    const turn = await backend(query, {}, { readPreview }).reply(req('what are these?', null, undefined, [RED, BLUE]));
    expect(deltas(await collect(turn))).toBe('Red and blue.');
    const sent = await sentMessages(calls[0]?.prompt);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('user');
    expect(sent[0]?.parent_tool_use_id).toBeNull();
    expect(sent[0]?.message.role).toBe('user');
    expect(sent[0]?.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PREVIEWS[RED.previewPath]!) } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PREVIEWS[BLUE.previewPath]!) } },
      {
        type: 'text',
        text:
          'what are these?\n\nThe owner attached 2 images to this message. They are shown above in this order, with these upload ids:\n' +
          '[image upload:U-PL1]\n[image upload:V-QM2]',
      },
    ]);
  });

  it('sends an image with no text', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    await collect(await backend(query, {}, { readPreview }).reply(req('', null, undefined, [RED])));
    const sent = await sentMessages(calls[0]?.prompt);
    const content = sent[0]?.message.content;
    expect(Array.isArray(content) ? content.at(-1) : null).toEqual({
      type: 'text',
      text: 'The owner attached 1 image to this message. It is shown above, and its upload id is:\n[image upload:U-PL1]',
    });
  });

  it('keeps a text-only message a plain string prompt', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    await collect(await backend(query, {}, { readPreview }).reply(req('hello')));
    expect(calls[0]?.prompt).toBe('hello');
  });

  it('the GLM retry sends the same images again on a fresh stream, reading each preview once', async () => {
    const reads: string[] = [];
    const counting = async (p: string): Promise<Uint8Array> => {
      reads.push(p);
      return readPreview(p);
    };
    const { query, calls } = fakeQuery(
      scripted([assistantError('rate_limit', 'You have hit your usage limit'), errorResult('usage limit reached')]),
      scripted([textDelta('From GLM.'), success('sess-glm')]),
    );
    const turn = await backend(query, {}, { readPreview: counting }).reply(req('look', null, undefined, [RED]));
    expect(deltas(await collect(turn))).toBe('From GLM.');
    expect(calls).toHaveLength(2);
    const first = await sentMessages(calls[0]?.prompt);
    const second = await sentMessages(calls[1]?.prompt);
    expect(second).toEqual(first);
    expect(reads).toEqual([RED.previewPath]);
    expect(turn.end()).toEqual({ threadId: 'sess-glm', brain: 'glm' });
  });

  it('fails the turn before any SDK call when a preview cannot be read, without a fallback', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    const missing: ChatTurnImage = { ...RED, id: 'W-RN3', previewPath: '/cache/c_W-RN3/preview.jpg' };
    const { events, error } = await collectUntilError(
      await backend(query, {}, { readPreview }).reply(req('x', null, undefined, [missing])),
    );
    expect(events).toEqual([]);
    expect(error.message).toMatch(/Could not read pasted image W-RN3/);
    expect(calls).toHaveLength(0);
  });
});
```
(`assistantError`, `errorResult`, `success`, `textDelta`, `scripted`, `collect`, `collectUntilError`, `deltas` already exist in the file. The existing `calls[0]?.prompt).toBe('hello')` and `calls[1]?.prompt).toBe('summarize')` assertions stay valid.)

### Step 13: Compose and store unit tests
**File:** `tests/unit/chat-compose.test.ts` (new)
```ts
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { composePromptText, composeUserTurn, toSdkPrompt, uploadTag, userTurnContent } from '../../src/chat/compose.js';

const IMG = { id: 'U-PL1', previewMime: 'image/jpeg' as const };
const IMG2 = { id: 'V-QM2', previewMime: 'image/jpeg' as const };

describe('composePromptText', () => {
  it('leaves a text-only message unchanged', () => {
    expect(composePromptText('what did I save?', [])).toBe('what did I save?');
  });
  it('appends one [image upload:ID] line per image after a blank line', () => {
    expect(composePromptText('what is this?', ['U-PL1'])).toBe(
      'what is this?\n\nThe owner attached 1 image to this message. It is shown above, and its upload id is:\n[image upload:U-PL1]',
    );
    expect(composePromptText('compare', ['U-PL1', 'V-QM2']).split('\n').slice(-2)).toEqual([
      '[image upload:U-PL1]',
      '[image upload:V-QM2]',
    ]);
  });
  it('an image-only message is the image block alone', () => {
    expect(composePromptText('', ['U-PL1']).startsWith('The owner attached 1 image')).toBe(true);
  });
  it('uploadTag is the one spelling', () => {
    expect(uploadTag('A-B32')).toBe('[image upload:A-B32]');
  });
});

describe('composeUserTurn', () => {
  it('pairs each image with its preview, in order', () => {
    const turn = composeUserTurn({ message: 'hi', images: [IMG, IMG2] }, ['AAA', 'BBB']);
    expect(turn.images).toEqual([
      { id: 'U-PL1', mediaType: 'image/jpeg', data: 'AAA' },
      { id: 'V-QM2', mediaType: 'image/jpeg', data: 'BBB' },
    ]);
    expect(turn.text).toContain('[image upload:V-QM2]');
  });
  it('refuses a preview count that does not match', () => {
    expect(() => composeUserTurn({ message: 'hi', images: [IMG] }, [])).toThrow(/1 images but 0 previews/);
  });
});

describe('userTurnContent / toSdkPrompt', () => {
  it('puts the image blocks before the text block', () => {
    const turn = composeUserTurn({ message: 'hi', images: [IMG] }, ['AAA']);
    expect(userTurnContent(turn).map((b) => b.type)).toEqual(['image', 'text']);
  });
  it('is the plain string for a text-only turn', () => {
    expect(toSdkPrompt(composeUserTurn({ message: 'hi', images: [] }, []))).toBe('hi');
  });
  it('is a one-message stream for a turn with images, each call a fresh stream', async () => {
    const turn = composeUserTurn({ message: 'hi', images: [IMG] }, ['AAA']);
    const read = async (p: string | AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage[]> => {
      if (typeof p === 'string') throw new Error('expected a stream');
      const out: SDKUserMessage[] = [];
      for await (const m of p) out.push(m);
      return out;
    };
    const a = await read(toSdkPrompt(turn));
    const b = await read(toSdkPrompt(turn));
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
    expect(a[0]).toEqual({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: userTurnContent(turn) },
    });
  });
});
```

**File:** `tests/unit/chat-images.test.ts` (new)
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatImageCacheId, chatImageRelPath, chatImageUrl, toChatImage } from '../../src/chat/images.js';
import type { ChatImageRow } from '../../src/db/schema.js';
import { cacheDirFor } from '../../src/images/store.js';
import { ID_PATTERN } from '../../src/notes/ids.js';

describe('chat image paths', () => {
  it('stores originals under chat-images/YYYY/MM in local time of the save', () => {
    expect(chatImageRelPath('A-B32', 'png', new Date(2026, 9, 31, 10))).toBe('chat-images/2026/10/A-B32.png');
    expect(chatImageRelPath('A-B32', 'jpg', new Date(2027, 0, 1, 0))).toBe('chat-images/2027/01/A-B32.jpg');
  });
  it('keys derivatives by c_<id>: one path segment that no note image id can equal', () => {
    const key = chatImageCacheId('A-B32');
    expect(key).toBe('c_A-B32');
    expect(path.basename(key)).toBe(key);
    expect(ID_PATTERN.test(key)).toBe(false);
    expect(cacheDirFor('/data', key)).toBe(path.join(path.resolve('/data'), 'cache', 'c_A-B32'));
  });
  it('names the variant urls under /api/chat/images', () => {
    expect(chatImageUrl('A-B32', 'thumb')).toBe('/api/chat/images/A-B32/thumb');
  });
});

describe('toChatImage', () => {
  it('is the wire shape', () => {
    const row: ChatImageRow = {
      id: 'A-B32',
      path: 'chat-images/2026/10/A-B32.png',
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      width: 40,
      height: 30,
      bytes: 123,
      originalName: 'shot.png',
      host: 'lenovo',
      source: 'wall',
      createdAt: new Date('2026-10-31T01:02:03.000Z'),
    };
    expect(toChatImage(row, true)).toEqual({
      id: 'A-B32',
      mime: 'image/png',
      width: 40,
      height: 30,
      bytes: 123,
      original_name: 'shot.png',
      host: 'lenovo',
      source: 'wall',
      created_at: '2026-10-31T01:02:03.000Z',
      available: true,
      urls: {
        original: '/api/chat/images/A-B32/original',
        display: '/api/chat/images/A-B32/display',
        thumb: '/api/chat/images/A-B32/thumb',
        preview: '/api/chat/images/A-B32/preview',
      },
    });
  });
});
```

### Step 14: Integration tests
**File:** `tests/integration/chat.images.int.test.ts` (new)
```ts
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentChatBackend, type QueryFn } from '../../src/chat/agent.js';
import type { ChatBackend } from '../../src/chat/backend.js';
import { DEFAULT_CHAT_CONFIG } from '../../src/config.js';
import { chatImageRoutes } from '../../src/http/chatImages.js';
import { ID_PATTERN } from '../../src/notes/ids.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse } from './helpers/sse.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

interface WireChatImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  original_name: string | null;
  host: string | null;
  source: string;
  created_at: string;
  available: boolean;
  urls: Record<'original' | 'display' | 'thumb' | 'preview', string>;
}
interface UploadBody {
  image: WireChatImage;
  created: boolean;
}

let h: Harness;
let scripted: ScriptedChatBackend;
/** What POST /api/chat talks to; a test may swap in the real agent backend over a fake `query`. */
let backend: ChatBackend;

beforeAll(async () => {
  scripted = createScriptedChatBackend();
  backend = scripted;
  const chat: ChatBackend = { reply: (request) => backend.reply(request) };
  h = await startHarness({ chat });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  backend = scripted;
  await h.reset();
});

async function upload(bytes: Buffer, name: string, type: string, app: Hono = h.app): Promise<Response> {
  const fd = new FormData();
  fd.append('file', new File([bytes], name, { type }));
  return app.request('/api/chat/images', { method: 'POST', body: fd });
}

async function uploaded(rgb = { r: 200, g: 10, b: 10 }): Promise<WireChatImage> {
  const res = await upload(await makeImage('png', 40, 30, rgb), 'shot.png', 'image/png');
  expect(res.status).toBe(201);
  return ((await res.json()) as UploadBody).image;
}

async function originalOf(id: string): Promise<string> {
  const res = await h.deps.db.execute<{ path: string }>(sql`select path from chat_images where id = ${id}`);
  const rel = res.rows[0]?.path;
  if (rel === undefined) throw new Error(`no chat image ${id}`);
  return path.join(h.dataDir, rel);
}

function postChat(payload: unknown): Promise<Response> {
  return Promise.resolve(
    h.app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

function successMessage(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: 'sess-int',
    uuid: '00000000-0000-4000-8000-000000000000',
  } as unknown as SDKMessage;
}

describe('chat_images schema', () => {
  it('keeps sha256 and path unique and source to wall | claude_code', async () => {
    const insert = (id: string, sha: string, p: string, source: string) =>
      h.deps.db.execute(
        sql`insert into chat_images (id, path, sha256, mime, width, height, bytes, source)
            values (${id}, ${p}, ${sha}, 'image/png', 1, 1, 1, ${source})`,
      );
    await insert('A-AAA', 'a'.repeat(64), 'chat-images/2026/10/A-AAA.png', 'wall');
    await expect(insert('B-BBB', 'a'.repeat(64), 'chat-images/2026/10/B-BBB.png', 'wall')).rejects.toThrow();
    await expect(insert('C-CCC', 'c'.repeat(64), 'chat-images/2026/10/A-AAA.png', 'wall')).rejects.toThrow();
    await expect(insert('D-DDD', 'd'.repeat(64), 'chat-images/2026/10/D-DDD.png', 'web')).rejects.toThrow();
    await insert('E-EEE', 'e'.repeat(64), 'chat-images/2026/10/E-EEE.png', 'claude_code');
    const created = await h.deps.db.execute<{ ok: boolean }>(
      sql`select created_at is not null as ok from chat_images where id = 'E-EEE'`,
    );
    expect(created.rows[0]?.ok).toBe(true);
  });
});

describe('POST /api/chat/images', () => {
  it('stores a pasted image as a chat image (201), never as a note', async () => {
    const png = await makeImage('png', 40, 30, { r: 200, g: 10, b: 10 });
    const res = await upload(png, 'shot.png', 'image/png');
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadBody;
    expect(body.created).toBe(true);
    expect(body.image).toMatchObject({
      mime: 'image/png',
      width: 40,
      height: 30,
      bytes: png.byteLength,
      original_name: 'shot.png',
      source: 'wall',
      available: true,
    });
    expect(ID_PATTERN.test(body.image.id)).toBe(true);
    expect(body.image.urls.thumb).toBe(`/api/chat/images/${body.image.id}/thumb`);
    const abs = await originalOf(body.image.id);
    expect(path.relative(h.dataDir, abs)).toMatch(new RegExp(`^chat-images/\\d{4}/\\d{2}/${body.image.id}\\.png$`));
    expect(Buffer.compare(await readFile(abs), png)).toBe(0);
    const counts = await h.deps.db.execute<{ notes: number; images: number }>(
      sql`select (select count(*) from notes)::int as notes, (select count(*) from note_images)::int as images`,
    );
    expect(counts.rows[0]).toEqual({ notes: 0, images: 0 });
  });

  it('returns the stored row (200) for the same bytes, and heals a missing original', async () => {
    const png = await makeImage('png', 40, 30, { r: 1, g: 2, b: 3 });
    const first = (await (await upload(png, 'a.png', 'image/png')).json()) as UploadBody;
    const abs = await originalOf(first.image.id);
    await rm(abs);
    const res = await upload(png, 'b.png', 'image/png');
    expect(res.status).toBe(200);
    const again = (await res.json()) as UploadBody;
    expect(again.created).toBe(false);
    expect(again.image.id).toBe(first.image.id);
    expect(again.image.original_name).toBe('a.png');
    expect(again.image.available).toBe(true);
    expect(Buffer.compare(await readFile(abs), png)).toBe(0);
  });

  it('two concurrent uploads of the same bytes make one row', async () => {
    const png = await makeImage('png', 20, 20, { r: 9, g: 9, b: 9 });
    const [a, b] = await Promise.all([upload(png, 'a.png', 'image/png'), upload(png, 'b.png', 'image/png')]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const ja = (await a.json()) as UploadBody;
    const jb = (await b.json()) as UploadBody;
    expect(ja.image.id).toBe(jb.image.id);
    const n = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from chat_images`);
    expect(n.rows[0]?.n).toBe(1);
  });

  it('records the optional source field: wall by default, claude_code from the paste hook', async () => {
    const withSource = (bytes: Buffer, source: string): Promise<Response> => {
      const fd = new FormData();
      fd.append('file', new File([bytes], 'pasted-image-1.png', { type: 'image/png' }));
      fd.append('source', source);
      return Promise.resolve(h.app.request('/api/chat/images', { method: 'POST', body: fd }));
    };
    const wall = await uploaded({ r: 10, g: 20, b: 30 });
    expect(wall.source).toBe('wall');
    const res = await withSource(await makeImage('png', 16, 16, { r: 200, g: 20, b: 30 }), 'claude_code');
    expect(res.status).toBe(201);
    const pasted = ((await res.json()) as UploadBody).image;
    expect(pasted.source).toBe('claude_code');
    const row = await h.deps.db.execute<{ source: string }>(sql`select source from chat_images where id = ${pasted.id}`);
    expect(row.rows[0]?.source).toBe('claude_code');

    const bad = await withSource(await makeImage('png', 16, 16, { r: 1, g: 1, b: 1 }), 'browser');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_source');
    const n = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from chat_images`);
    expect(n.rows[0]?.n).toBe(2);
  });

  it('refuses a file that is not an image (415) and an empty file (415)', async () => {
    const txt = await upload(Buffer.from('hello, not an image'), 'a.txt', 'text/plain');
    expect(txt.status).toBe(415);
    expect(await txt.json()).toMatchObject({ error: 'not_an_image' });
    const empty = await upload(Buffer.alloc(0), 'e.png', 'image/png');
    expect(empty.status).toBe(415);
    const n = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from chat_images`);
    expect(n.rows[0]?.n).toBe(0);
  });

  it('refuses a file over the cap (413)', async () => {
    const small = new Hono().route('/', chatImageRoutes(h.deps, { maxUploadBytes: 1024 }));
    const res = await upload(Buffer.alloc(4096, 7), 'big.png', 'image/png', small);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'too_large', max_bytes: 1024 });
  });

  it('needs a file field (400)', async () => {
    const fd = new FormData();
    fd.append('other', 'x');
    const res = await h.app.request('/api/chat/images', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'file_required' });
  });
});

describe('GET /api/chat/images/:id[/variant]', () => {
  it('serves the metadata and every variant; derivatives go to cache/c_<id>/', async () => {
    const image = await uploaded();
    const meta = await h.app.request(`/api/chat/images/${image.id.toLowerCase().replace('-', '')}`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual(image);

    const thumb = await h.app.request(`/api/chat/images/${image.id}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(thumb.headers.get('x-content-type-options')).toBe('nosniff');
    expect(existsSync(path.join(h.dataDir, 'cache', `c_${image.id}`, 'thumb.webp'))).toBe(true);
    expect(existsSync(path.join(h.dataDir, 'cache', image.id))).toBe(false);

    const preview = await h.app.request(`/api/chat/images/${image.id}/preview`);
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
    expect(existsSync(path.join(h.dataDir, 'cache', `c_${image.id}`, 'preview.jpg'))).toBe(true);

    const original = await h.app.request(`/api/chat/images/${image.id}/original`);
    expect(original.status).toBe(200);
    expect(original.headers.get('content-type')).toBe('image/png');
    expect(original.headers.get('content-disposition')).toContain('shot.png');
    expect(original.headers.get('cache-control')).toContain('immutable');
    const etag = original.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const notModified = await h.app.request(`/api/chat/images/${image.id}/original`, { headers: { 'if-none-match': etag ?? '' } });
    expect(notModified.status).toBe(304);

    const display = await h.app.request(`/api/chat/images/${image.id}/display`);
    expect(display.headers.get('content-type')).toBe('image/png');
  });

  it('404s an unknown or malformed id', async () => {
    expect((await h.app.request('/api/chat/images/Z-ZZZ')).status).toBe(404);
    expect((await h.app.request('/api/chat/images/Z-ZZZ/thumb')).status).toBe(404);
    expect((await h.app.request('/api/chat/images/not-an-id/thumb')).status).toBe(404);
  });

  it('answers not_on_this_machine when the original is missing here', async () => {
    const image = await uploaded();
    await rm(await originalOf(image.id));
    const res = await h.app.request(`/api/chat/images/${image.id}/thumb`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine' });
    const meta = (await (await h.app.request(`/api/chat/images/${image.id}`)).json()) as WireChatImage;
    expect(meta.available).toBe(false);
  });
});

describe('POST /api/chat with image_ids', () => {
  it('hands the resolved images to the backend, previews derived under cache/c_<id>/', async () => {
    const image = await uploaded();
    scripted.push({ steps: [{ type: 'delta', text: 'red' }], end: { threadId: 't1' } });
    const res = await postChat({ message: 'what is it?', image_ids: [image.id.toLowerCase().replace('-', '')] });
    expect(res.status).toBe(200);
    expect(parseSse(await res.text()).at(-1)).toEqual({ event: 'done', data: { thread_id: 't1' } });
    const req = scripted.requests.at(-1);
    expect(req?.message).toBe('what is it?');
    const previewPath = path.join(h.dataDir, 'cache', `c_${image.id}`, 'preview.jpg');
    expect(req?.images).toEqual([
      { id: image.id, previewPath, previewMime: 'image/jpeg', width: 40, height: 30, originalName: 'shot.png' },
    ]);
    expect(existsSync(previewPath)).toBe(true);
  });

  it('accepts images with no text, and dedupes repeated ids', async () => {
    const image = await uploaded();
    scripted.push({ steps: [], end: { threadId: 't2' } });
    const res = await postChat({ image_ids: [image.id, image.id.toLowerCase()] });
    expect(res.status).toBe(200);
    await res.text();
    const req = scripted.requests.at(-1);
    expect(req?.message).toBe('');
    expect(req?.images.map((i) => i.id)).toEqual([image.id]);
  });

  it('a text-only message carries no images', async () => {
    scripted.push({ steps: [], end: { threadId: 't3' } });
    const res = await postChat({ message: 'hello' });
    await res.text();
    expect(scripted.requests.at(-1)?.images).toEqual([]);
  });

  it('rejects, as JSON before any stream: no text and no images, too many images, unknown ids, missing originals', async () => {
    const before = scripted.requests.length;
    for (const payload of [{ message: '' }, { message: '  ', image_ids: [] }]) {
      const res = await postChat(payload);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    }
    const five = await postChat({ message: 'x', image_ids: ['A-AAA', 'B-BBB', 'C-CCC', 'D-DDD', 'E-EEE'] });
    expect(five.status).toBe(400);

    const unknown = await postChat({ message: 'x', image_ids: ['Z-ZZZ'] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_image', id: 'Z-ZZZ' });

    const image = await uploaded();
    await rm(await originalOf(image.id));
    const gone = await postChat({ message: 'x', image_ids: [image.id] });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ error: 'not_on_this_machine', id: image.id });
    expect(scripted.requests.length).toBe(before);
  });
});

describe('the agent backend sends pasted images to the model', () => {
  function agentWith(prompts: Array<Parameters<QueryFn>[0]['prompt']>): ChatBackend {
    const query: QueryFn = (params) => {
      prompts.push(params.prompt);
      return (async function* () {
        yield successMessage();
      })();
    };
    return createAgentChatBackend({
      chat: { ...DEFAULT_CHAT_CONFIG, claudeBin: '/opt/claude/bin/claude', glm: null },
      cwd: path.join(h.dataDir, 'chat'),
      mcpUrl: () => 'http://127.0.0.1:9/mcp',
      query,
      log: () => {},
    });
  }

  it('composes one user message: the preview as an image block, then the text with [image upload:ID]', async () => {
    const image = await uploaded();
    const prompts: Array<Parameters<QueryFn>[0]['prompt']> = [];
    backend = agentWith(prompts);
    const res = await postChat({ message: 'what colour is this?', image_ids: [image.id] });
    expect(res.status).toBe(200);
    expect(parseSse(await res.text()).at(-1)).toEqual({ event: 'done', data: { thread_id: 'sess-int', brain: 'claude' } });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    if (prompt === undefined || typeof prompt === 'string') throw new Error('expected a user-message stream');
    const sent: SDKUserMessage[] = [];
    for await (const m of prompt) sent.push(m);
    expect(sent).toHaveLength(1);
    const content = sent[0]?.message.content;
    if (!Array.isArray(content)) throw new Error('expected content blocks');
    const preview = await readFile(path.join(h.dataDir, 'cache', `c_${image.id}`, 'preview.jpg'));
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: preview.toString('base64') },
    });
    const text = content[1];
    expect(text?.type).toBe('text');
    expect(text?.type === 'text' ? text.text : '').toBe(
      `what colour is this?\n\nThe owner attached 1 image to this message. It is shown above, and its upload id is:\n[image upload:${image.id}]`,
    );
  });

  it('a text-only message still reaches the SDK as a plain string', async () => {
    const prompts: Array<Parameters<QueryFn>[0]['prompt']> = [];
    backend = agentWith(prompts);
    const res = await postChat({ message: 'hello' });
    await res.text();
    expect(prompts).toEqual(['hello']);
  });
});
```

### Step 15: Live test (opt-in, billed)
**File:** `tests/live/chat.live.test.ts:14-24` (imports), `:67-91` (`ask`), append one `it` inside `describe('chat brain, live')`
**Change:** add `import sharp from 'sharp';` and `import type { ChatBrain, ChatTurnEnd, ChatTurnImage } from '../../src/chat/backend.js';` (replacing the existing backend type import). `ask` gains an `images` parameter:
```ts
async function ask(brain: ChatBrain, message: string, images: ChatTurnImage[] = []): Promise<LiveAnswer> {
  if (daemon === undefined) throw new Error('daemon did not start');
  const chat: Config['chat'] = { ...config.chat, brain };
  const mcpUrl = `http://127.0.0.1:${daemon.port}/mcp`;
  const backend = createAgentChatBackend({
    chat,
    cwd: join(dataDir, CHAT_SUBDIR),
    mcpUrl: () => mcpUrl,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const turn = await backend.reply({ message, images, threadId: null, signal: controller.signal });
    let text = '';
    const statuses: string[] = [];
    for await (const event of turn.events) {
      if (event.type === 'delta') text += event.text;
      else if (event.text !== '') statuses.push(event.text);
    }
    return { text, statuses, end: turn.end() };
  } finally {
    clearTimeout(timer);
    backend.close();
  }
}
```
New case (Claude only; GLM image support is unverified):
```ts
  it('sees an image pasted into the chat bar and names its upload id (Claude)', async () => {
    const previewPath = join(root, 'red-preview.jpg');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 20, b: 20 } } })
      .jpeg()
      .toFile(previewPath);
    const answer = await ask(
      'claude',
      'What single colour fills the image I attached? Answer in one short sentence and quote its upload id.',
      [{ id: 'L-IV1', previewPath, previewMime: 'image/jpeg', width: 64, height: 64, originalName: 'red.jpg' }],
    );
    expect(answer.end.brain).toBe('claude');
    expect(answer.text).toMatch(/red/i);
    expect(answer.text.toUpperCase()).toContain('L-IV1');
  });
```
**Impact:** never part of `npm test`/`test:int`; the only end-to-end proof of SDK streaming-input with image blocks. Run it once before merging the phase.

### Step 16: Web types and API client
**File:** `web/src/types.ts` (append at end)
```ts
/** A pasted chat image as the server sends it (`POST /api/chat/images`; src/chat/images.ts `ChatImage`). */
export interface ChatImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  original_name: string | null;
  host: string | null;
  source: 'wall' | 'claude_code';
  created_at: string;
  available: boolean;
  /** `/api/chat/images/<id>/<variant>`. */
  urls: { thumb: string; display: string; original: string; preview: string };
}
```

**File:** `web/src/api.ts:1` (import), `:184-193` (`postChat`), insert after `imageInfoUrl` (`:205`)
```ts
import type { Bin, ChatImage, Note, TagCount } from './types';
```
```ts
export function postChat(
  message: string,
  threadId: string | undefined,
  signal: AbortSignal,
  imageIds: readonly string[] = [],
): Promise<Response> {
  const payload: { message: string; thread_id?: string; image_ids?: string[] } = { message };
  if (threadId) payload.thread_id = threadId;
  if (imageIds.length > 0) payload.image_ids = [...imageIds];
  return fetch('/api/chat', {
    method: 'POST',
    headers: { ...JSON_HEADERS, accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
}
```
```ts
/** `/api/chat/images/<id>/<variant>`: a pasted chat image's file. */
export function chatImageUrl(imageId: string, variant: ImageFileVariant): string {
  return `/api/chat/images/${enc(imageId)}/${variant}`;
}

/** `POST /api/chat/images` → 201 `{ image, created: true }` or 200 `{ image, created: false }` (same bytes already stored). */
export interface ChatImageUpload {
  image: ChatImage;
  created: boolean;
}

/** Upload one image pasted into the chat bar (multipart `file`). Throws ApiError (`too_large`, `not_an_image`, …). */
export async function uploadChatImage(file: File): Promise<ChatImageUpload> {
  const form = new FormData();
  form.append('file', file, file.name || 'pasted-image');
  const res = await check(await fetch('/api/chat/images', { method: 'POST', body: form }));
  return (await res.json()) as ChatImageUpload;
}
```

### Step 17: Pending chat images hook
**File:** `web/src/hooks/useChatImages.ts` (new). Owned by App so the Phase 9 page composer can reuse `ChatBar` with its own instance.
```ts
import { useCallback, useMemo, useRef, useState } from 'react';
import { chatImageUrl, uploadChatImage, type ChatImageUpload } from '../api';
import type { ChatBarImage } from '../components/ChatBar';

/** Images per message; matches the server's MAX_CHAT_IMAGES_PER_MESSAGE. */
export const MAX_CHAT_IMAGES = 4;

const TOO_MANY = `at most ${MAX_CHAT_IMAGES} images per message`;

export interface PendingChatImage extends ChatBarImage {
  /** The chat image id once uploaded. */
  id: string | null;
}

export interface ChatImages {
  images: PendingChatImage[];
  /** Ids of the uploaded images, in paste order, without repeats. */
  readyIds: string[];
  /** True while any image is uploading or failed: the message waits (or the failed one is removed). */
  blocked: boolean;
  /** Upload each file at once; past MAX_CHAT_IMAGES a file shows as failed. */
  add: (files: File[]) => void;
  remove: (key: string) => void;
  /** After sending. */
  clear: () => void;
}

let keySeq = 0;
const nextKey = (): string => `chat-img-${++keySeq}`;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useChatImages(upload: (file: File) => Promise<ChatImageUpload> = uploadChatImage): ChatImages {
  const [images, setImages] = useState<PendingChatImage[]>([]);
  // Synchronous mirror: add() counts against the cap and late upload results check membership.
  const ref = useRef<PendingChatImage[]>([]);

  const commit = useCallback((next: PendingChatImage[]) => {
    ref.current = next;
    setImages(next);
  }, []);

  /** Apply an upload's outcome, unless the image was removed (or the bar cleared) meanwhile. */
  const patch = useCallback(
    (key: string, change: Partial<PendingChatImage>) => {
      if (!ref.current.some((i) => i.key === key)) return;
      commit(ref.current.map((i) => (i.key === key ? { ...i, ...change } : i)));
    },
    [commit],
  );

  const add = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const next = [...ref.current];
      for (const file of files) {
        const key = nextKey();
        const label = file.name || 'pasted image';
        if (next.length >= MAX_CHAT_IMAGES) {
          next.push({ key, label, state: 'failed', id: null, thumbUrl: null, error: TOO_MANY });
          continue;
        }
        next.push({ key, label, state: 'uploading', id: null, thumbUrl: null, error: null });
        upload(file).then(
          (r) => patch(key, { state: 'ready', id: r.image.id, thumbUrl: chatImageUrl(r.image.id, 'thumb'), error: null }),
          (err: unknown) => patch(key, { state: 'failed', error: messageOf(err) }),
        );
      }
      commit(next);
    },
    [upload, patch, commit],
  );

  const remove = useCallback((key: string) => commit(ref.current.filter((i) => i.key !== key)), [commit]);

  const clear = useCallback(() => commit([]), [commit]);

  const readyIds = useMemo(() => {
    const ids: string[] = [];
    for (const i of images) if (i.state === 'ready' && i.id !== null && !ids.includes(i.id)) ids.push(i.id);
    return ids;
  }, [images]);

  const blocked = images.some((i) => i.state !== 'ready');

  return { images, readyIds, blocked, add, remove, clear };
}
```
Orphaned uploads (removed before sending) stay in `chat_images`; no delete endpoint (Handoffs).

### Step 18: `useChat` sends image ids
**File:** `web/src/hooks/useChat.ts` (whole file)
```ts
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
```
A `400 unknown_image`/`409 not_on_this_machine` comes back as `!res.ok` and shows "Chat failed: 400 Bad Request" (existing behaviour for non-2xx).

### Step 19: ChatBar takes pastes and shows thumbnails
**File:** `web/src/components/ChatBar.tsx` (whole file)
```tsx
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';
import { ArrowRight, CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { imageFiles } from './DropOverlay';
import './ChatBar.css';

/** One text line in px; must match `.chatbar textarea { line-height }` in ChatBar.css. */
export const CHAT_LINE_PX = 20;
/** Textarea vertical padding, top + bottom, in px; must match ChatBar.css (10px + 10px). */
export const CHAT_PAD_Y_PX = 20;
/** Lines the bar grows to before it scrolls inside (R7: "about six"). */
export const CHAT_MAX_LINES = 6;
/** Height the thumbnail row adds inside the pill: 48px thumbs + 4px margin above and below (ChatBar.css). */
export const CHAT_THUMBS_PX = 56;
/** Form padding top + bottom around the textarea (7px + 7px in styles.css `.chatbar`). */
const BAR_PAD_Y_PX = 14;
/** The one-line pill: 40px textarea / send button + 14px padding. */
const BAR_MIN_PX = 54;

export type ChatBarImageState = 'uploading' | 'ready' | 'failed';

/** One pasted image waiting in the bar. */
export interface ChatBarImage {
  key: string;
  /** File name, for the tooltip and the remove button's label. */
  label: string;
  state: ChatBarImageState;
  /** Thumb URL once uploaded. */
  thumbUrl: string | null;
  /** Why it failed. */
  error: string | null;
}

export interface ChatBarProps {
  /** Left edge of the fixed wall bar. Ignored by the page variant. */
  left?: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** Pasted images, shown as removable thumbnails above the text. */
  images?: readonly ChatBarImage[];
  /** Image files pasted while the bar has focus. Omitted: the bar takes no images. */
  onPasteFiles?: (files: File[]) => void;
  onRemoveImage?: (key: string) => void;
  /** Disables send (an image is still uploading or failed). */
  sendBlocked?: boolean;
  /** 'wall' (default): the fixed pill that publishes --chatbar-h. 'page': laid out by its parent. */
  variant?: 'wall' | 'page';
}

const NO_IMAGES: readonly ChatBarImage[] = [];

export function ChatBar({
  left,
  value,
  onChange,
  onSubmit,
  images = NO_IMAGES,
  onPasteFiles,
  onRemoveImage,
  sendBlocked = false,
  variant = 'wall',
}: ChatBarProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  // Read by the stable `fit` so the resize listener is never re-subscribed (its cleanup clears --chatbar-h).
  const thumbsPx = useRef(0);
  thumbsPx.current = images.length > 0 ? CHAT_THUMBS_PX : 0;
  const publishes = useRef(variant === 'wall');
  publishes.current = variant === 'wall';

  // Grow with the content one line at a time up to CHAT_MAX_LINES, then scroll inside. The wall
  // bar's height (thumbnail row included) is published as --chatbar-h so the answer panel (and the
  // undo bar) sit above it.
  const fit = useCallback(() => {
    const el = ta.current;
    if (!el) return;
    const min = CHAT_LINE_PX + CHAT_PAD_Y_PX;
    const max = CHAT_LINE_PX * CHAT_MAX_LINES + CHAT_PAD_Y_PX;
    el.style.height = 'auto';
    const full = el.scrollHeight;
    const h = Math.min(Math.max(full, min), max);
    el.style.height = `${h}px`;
    el.style.overflowY = full > max ? 'auto' : 'hidden';
    if (publishes.current) {
      document.documentElement.style.setProperty('--chatbar-h', `${Math.max(BAR_MIN_PX, h + BAR_PAD_Y_PX + thumbsPx.current)}px`);
    }
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [value, left, images.length, fit]);

  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      if (publishes.current) document.documentElement.style.removeProperty('--chatbar-h');
    };
  }, [fit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Enter that confirms an IME candidate must not send (keyCode 229 covers Safari / older Chrome).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (sendBlocked) return;
    e.currentTarget.form?.requestSubmit();
  };

  // Image files go to the owner of the bar; text (or a paste with no image) stays the browser's.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPasteFiles) return;
    const files = imageFiles(e.clipboardData?.files);
    if (files.length === 0) return;
    e.preventDefault();
    onPasteFiles(files);
  };

  const remove = (key: string) => {
    onRemoveImage?.(key);
    // The button unmounts; keep focus in the bar so the next paste still lands here.
    ta.current?.focus();
  };

  return (
    <form
      className={variant === 'page' ? 'chatbar chatbar-page' : 'chatbar'}
      style={variant === 'wall' ? { left } : undefined}
      onSubmit={onSubmit}
      data-chatbar={variant}
    >
      <div className="chatbar-input">
        {images.length > 0 && (
          <ul className="chatbar-thumbs" aria-label="Pasted images">
            {images.map((img) => (
              <li
                key={img.key}
                className={`chatbar-thumb ${img.state}`}
                data-image-state={img.state}
                data-tip={img.state === 'failed' ? (img.error ?? 'upload failed') : img.label}
              >
                {img.state === 'ready' && img.thumbUrl ? (
                  <img src={img.thumbUrl} alt={img.label} />
                ) : img.state === 'uploading' ? (
                  <CircleNotch className="spin" aria-label="uploading" />
                ) : (
                  <WarningCircle aria-label="upload failed" />
                )}
                {onRemoveImage && (
                  <button type="button" className="chatbar-thumb-x" aria-label={`Remove ${img.label}`} onClick={() => remove(img.key)}>
                    <X />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Ask about your notes"
          aria-label="Ask about your notes"
        />
      </div>
      <button type="submit" className="sendbtn" data-tip="Send" aria-label="Send" disabled={sendBlocked}>
        <ArrowRight weight="duotone" />
      </button>
    </form>
  );
}
```
Two `ChatBarImage` items with the same `key` never exist (keys come from `useChatImages`). Phase 9 passes `variant="page"` and its own `useChatImages()` instance.

**File:** `web/src/components/ChatBar.css` (append)
```css
/* pasted images (R1): a thumbnail row above the text, inside the pill. 48px + 4px + 4px = CHAT_THUMBS_PX. */
.chatbar-input { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.chatbar-input textarea { flex: none; width: 100%; }
.chatbar-thumbs { display: flex; gap: 8px; margin: 4px 0; padding: 0; list-style: none; height: 48px; }
.chatbar-thumb { position: relative; width: 48px; height: 48px; flex-shrink: 0; border-radius: 8px; overflow: hidden; display: grid; place-items: center; background: rgba(18,18,17,.08); color: var(--bg); font-size: 18px; }
.chatbar-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.chatbar-thumb.failed { outline: 1px solid #c0473a; outline-offset: -1px; color: #c0473a; }
.chatbar-thumb-x { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 999px; display: grid; place-items: center; font-size: 11px; background: rgba(18,18,17,.75); color: #ecebe4; cursor: pointer; }
.chatbar .spin { animation: chatbar-spin 1s linear infinite; }
@keyframes chatbar-spin { to { transform: rotate(360deg); } }
.sendbtn:disabled { opacity: .45; cursor: default; }

/* the images sent with the current question, above the answer */
.answer-images { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.answer-images img { width: 64px; height: 64px; object-fit: cover; display: block; border: 1px solid var(--line-14); }
```

### Step 20: Global paste yields to the focused chat bar
**File:** `web/src/components/DropOverlay.tsx:26-28` (insert after `hasFiles`), `:99-104` (`onPaste`)
**Code:** insert after `hasFiles`:
```ts
/**
 * True when the focused element sits inside a chat bar (`[data-chatbar]`). The bar's own paste
 * handler owns the clipboard then: a pasted image goes with the next question, never into a note.
 */
export function chatBarHasFocus(active: Element | null = document.activeElement): boolean {
  return active !== null && active.closest('[data-chatbar]') !== null;
}
```
Replace `onPaste`:
```ts
    const onPaste = (e: ClipboardEvent) => {
      if (chatBarHasFocus()) return;
      const file = firstImageFile(e.clipboardData?.files);
      if (!file) return;
      e.preventDefault();
      enqueue([file]);
    };
```
**Impact:** drop and drag handling unchanged; paste with the big editor open and focus inside it still attaches (`target` path); paste with focus on the page body still creates a note. Phase 5 extends this handler for non-image files and must keep the guard first.

### Step 21: Answer panel shows the sent images
**File:** `web/src/components/AnswerPanel.tsx` (whole file)
```tsx
import { Fragment } from 'react';
import type { MouseEvent } from 'react';
import { CaretDown, CaretUp, PushPin, X } from '@phosphor-icons/react';
import { chatImageUrl } from '../api';
import { segmentLinks } from '../lib/links';
import { oneLine } from '../lib/oneLine';

export interface AnswerPanelProps {
  left: number;
  query: string;
  /** Chat image ids sent with the query; shown as thumbnails above the answer. */
  images?: readonly string[];
  text: string;
  done: boolean;
  /** Tool caption while streaming; '' for none. */
  status: string;
  /** Brain that answered, shown once done; null for none. */
  brain: string | null;
  pinned: boolean;
  /** Folded to the header line alone (R6). */
  collapsed: boolean;
  usedIds: string[];
  onTogglePin: () => void;
  onToggleCollapse: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

const NO_IMAGES: readonly string[] = [];

/** The header's question line: the text, or for an image-only question its image count. */
function questionLabel(query: string, imageCount: number): string {
  if (query !== '') return query;
  if (imageCount === 0) return '';
  return imageCount === 1 ? '1 image' : `${imageCount} images`;
}

export function AnswerPanel({
  left,
  query,
  images = NO_IMAGES,
  text,
  done,
  status,
  brain,
  pinned,
  collapsed,
  usedIds,
  onTogglePin,
  onToggleCollapse,
  onClose,
  onJump,
}: AnswerPanelProps) {
  const parts = text.split('\n\n');
  const caption = done ? (brain ?? '') : status;
  const label = questionLabel(query, images.length);

  // Collapsed, the whole line expands the panel; the icon buttons keep their own meaning.
  const onHeadClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!collapsed) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    onToggleCollapse();
  };

  return (
    <div className={collapsed ? 'answer collapsed' : 'answer'} style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head" onClick={onHeadClick}>
        <span className="answer-q" data-tip={label}>
          {oneLine(label)}
        </span>
        {caption && <span className="answer-status">{caption}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="pbtn hov"
          data-tip={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? <CaretUp weight="duotone" /> : <CaretDown weight="duotone" />}
        </button>
        <button type="button" className={pinned ? 'pbtn on' : 'pbtn'} data-tip={pinned ? 'Unpin' : 'Pin'} aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          <PushPin weight="duotone" />
        </button>
        <button type="button" className="pbtn hov" data-tip="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X weight="duotone" />
        </button>
      </div>
      {!collapsed && images.length > 0 && (
        <div className="answer-images">
          {images.map((id) => (
            <img key={id} src={chatImageUrl(id, 'thumb')} alt={`pasted image ${id}`} />
          ))}
        </div>
      )}
      {!collapsed && (
        <div className="answer-body">
          {parts.map((t, i) => {
            const streaming = !done && i === parts.length - 1;
            return (
              <p key={i}>
                {segmentLinks(t, { streaming }).map((s, j) =>
                  s.kind === 'link' ? (
                    <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
                      {s.text}
                    </a>
                  ) : (
                    <Fragment key={j}>{s.text}</Fragment>
                  ),
                )}
                {streaming ? ' ▍' : ''}
              </p>
            );
          })}
        </div>
      )}
      {!collapsed && done && usedIds.length > 0 && (
        <div className="used-row">
          {usedIds.map((id) => (
            <button key={id} type="button" className="usedchip" data-tip="Show on wall" onClick={() => onJump(id)}>
              {id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

### Step 22: App wires it together
**File:** `web/src/App.tsx:8` (import), `:48` (hook), `:355-361` (`send`), `:434-451` (render)
**Change:** add after `import { useChat } from './hooks/useChat';`:
```ts
import { useChatImages } from './hooks/useChatImages';
```
After `const chat = useChat();`:
```ts
  const chatImages = useChatImages();
```
Replace `send`:
```tsx
  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // An image still uploading (or failed and not yet removed) holds the message back.
    if (chatImages.blocked) return;
    const imageIds = chatImages.readyIds;
    if (!q.trim() && imageIds.length === 0) return;
    setMode((m) => (m === 'images' ? 'all' : m));
    void chat.ask(q, imageIds);
    setQ('');
    chatImages.clear();
  };
```
In the `AnswerPanel` element add the prop right after `query={chat.query}`:
```tsx
            images={chat.images}
```
Replace the `ChatBar` element:
```tsx
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
```
**Impact:** nothing else in App changes; `DropOverlay` props unchanged.

### Step 23: Web tests
**File:** `web/src/components/ChatBar.test.tsx`
Change the import (line 5) and append a describe:
```tsx
import { CHAT_LINE_PX, CHAT_MAX_LINES, CHAT_PAD_Y_PX, CHAT_THUMBS_PX, ChatBar, type ChatBarImage } from './ChatBar';
```
```tsx
describe('ChatBar images (R1)', () => {
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const txt = new File(['t'], 'a.txt', { type: 'text/plain' });
  const ready: ChatBarImage = { key: 'k2', label: 'b.png', state: 'ready', thumbUrl: '/api/chat/images/U-PL1/thumb', error: null };

  it('marks the form with data-chatbar', () => {
    render(<Harness onSend={vi.fn()} />);
    expect(document.querySelector('form.chatbar')?.getAttribute('data-chatbar')).toBe('wall');
  });

  it('hands pasted image files over and keeps them out of the textarea', () => {
    const onPasteFiles = vi.fn();
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} onPasteFiles={onPasteFiles} />);
    const notCancelled = fireEvent.paste(textarea(), { clipboardData: { files: [txt, png] } });
    expect(notCancelled).toBe(false);
    expect(onPasteFiles).toHaveBeenCalledWith([png]);
  });

  it('leaves a paste without images to the browser', () => {
    const onPasteFiles = vi.fn();
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} onPasteFiles={onPasteFiles} />);
    expect(fireEvent.paste(textarea(), { clipboardData: { files: [txt] } })).toBe(true);
    expect(fireEvent.paste(textarea(), { clipboardData: { files: [] } })).toBe(true);
    expect(onPasteFiles).not.toHaveBeenCalled();
  });

  it('takes no images when it has no onPasteFiles', () => {
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(fireEvent.paste(textarea(), { clipboardData: { files: [png] } })).toBe(true);
  });

  it('shows uploading, ready and failed thumbnails, each removable, and keeps focus in the bar', () => {
    const onRemove = vi.fn();
    const images: ChatBarImage[] = [
      { key: 'k1', label: 'a.png', state: 'uploading', thumbUrl: null, error: null },
      ready,
      { key: 'k3', label: 'c.png', state: 'failed', thumbUrl: null, error: 'too_large' },
    ];
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} images={images} onRemoveImage={onRemove} />);
    const items = [...document.querySelectorAll('.chatbar-thumb')];
    expect(items.map((li) => li.getAttribute('data-image-state'))).toEqual(['uploading', 'ready', 'failed']);
    expect(items[1]?.querySelector('img')?.getAttribute('src')).toBe('/api/chat/images/U-PL1/thumb');
    expect(items[2]?.getAttribute('data-tip')).toBe('too_large');
    fireEvent.click(screen.getByLabelText('Remove b.png'));
    expect(onRemove).toHaveBeenCalledWith('k2');
    expect(document.activeElement).toBe(textarea());
  });

  it('adds the thumbnail row to the published bar height', () => {
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} images={[ready]} />);
    expect(barH()).toBe(`${54 + CHAT_THUMBS_PX}px`);
  });

  it('sendBlocked disables the button and Enter does not submit', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(<ChatBar left={0} value="hi" onChange={vi.fn()} onSubmit={onSubmit} sendBlocked />);
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
    expect(fireEvent.keyDown(textarea(), { key: 'Enter' })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('the page variant is marked as such and does not publish --chatbar-h', () => {
    render(<ChatBar variant="page" value="" onChange={vi.fn()} onSubmit={vi.fn()} images={[ready]} />);
    const form = document.querySelector('form.chatbar');
    expect(form?.getAttribute('data-chatbar')).toBe('page');
    expect(form?.className).toContain('chatbar-page');
    expect(barH()).toBe('');
  });
});
```

**File:** `web/src/components/DropOverlay.test.tsx`
Change the import (line 5) and append:
```tsx
import { DropOverlay, chatBarHasFocus, firstImageFile, hasFiles, imageFiles } from './DropOverlay';
```
```tsx
function chatBarFixture(): { form: HTMLFormElement; ta: HTMLTextAreaElement } {
  const form = document.createElement('form');
  form.setAttribute('data-chatbar', 'wall');
  const ta = document.createElement('textarea');
  form.appendChild(ta);
  document.body.appendChild(form);
  return { form, ta };
}

describe('chatBarHasFocus', () => {
  it('is true only for an element inside [data-chatbar]', () => {
    const { form, ta } = chatBarFixture();
    const other = document.createElement('textarea');
    document.body.appendChild(other);
    try {
      expect(chatBarHasFocus(ta)).toBe(true);
      expect(chatBarHasFocus(form)).toBe(true);
      expect(chatBarHasFocus(other)).toBe(false);
      expect(chatBarHasFocus(document.body)).toBe(false);
      expect(chatBarHasFocus(null)).toBe(false);
      ta.focus();
      expect(chatBarHasFocus()).toBe(true);
      other.focus();
      expect(chatBarHasFocus()).toBe(false);
    } finally {
      form.remove();
      other.remove();
    }
  });
});

describe('DropOverlay and the chat bar', () => {
  it('a paste while the chat bar is focused is left to the chat bar', async () => {
    const onImageAdded = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} />);
    const { form, ta } = chatBarFixture();
    try {
      ta.focus();
      const e = eventWith('paste', 'clipboardData', { files: [png] });
      ta.dispatchEvent(e);
      await flush();
      expect(e.defaultPrevented).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onImageAdded).not.toHaveBeenCalled();
    } finally {
      form.remove();
    }
  });

  it('with an editor target, a paste in the focused chat bar does not attach either', async () => {
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={vi.fn()} target="A-B32" onAttached={onAttached} />);
    const { form, ta } = chatBarFixture();
    try {
      ta.focus();
      ta.dispatchEvent(eventWith('paste', 'clipboardData', { files: [png] }));
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onAttached).not.toHaveBeenCalled();
    } finally {
      form.remove();
    }
  });
});
```
(The existing paste tests dispatch on `document` with focus on `body`, so they still create/attach.)

**File:** `web/src/hooks/useChat.test.tsx`
Replace the `Posted` interface (lines 10-13) and append inside `describe('useChat')`:
```ts
interface Posted {
  message: string;
  thread_id?: string;
  image_ids?: string[];
}
```
```ts
  it('sends pasted image ids with the message and keeps them on the state', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('  what is this? ', ['U-PL1', 'V-QM2']);
    });
    expect(posted[0]).toEqual({ message: 'what is this?', image_ids: ['U-PL1', 'V-QM2'] });
    expect(result.current.images).toEqual(['U-PL1', 'V-QM2']);
    expect(result.current.query).toBe('what is this?');
  });

  it('sends an image-only message with empty text', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('   ', ['U-PL1']);
    });
    expect(posted[0]).toEqual({ message: '', image_ids: ['U-PL1'] });
    expect(result.current.open).toBe(true);
  });

  it('sends nothing without text or images, and a text-only message carries no image_ids', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('  ', []);
    });
    expect(posted).toHaveLength(0);
    await act(async () => {
      await result.current.ask('hello');
    });
    expect(posted[0]).toEqual({ message: 'hello' });
    expect(result.current.images).toEqual([]);
  });

  it('dismissing clears the images', async () => {
    stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('x', ['U-PL1']);
    });
    act(() => result.current.close());
    expect(result.current.images).toEqual([]);
  });
```

**File:** `web/src/hooks/useChatImages.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ChatImageUpload } from '../api';
import { MAX_CHAT_IMAGES, useChatImages } from './useChatImages';

afterEach(cleanup);

function uploadOf(id: string, created = true): ChatImageUpload {
  return {
    created,
    image: {
      id,
      mime: 'image/png',
      width: 1,
      height: 1,
      bytes: 1,
      original_name: 'a.png',
      host: 'lenovo',
      source: 'wall',
      created_at: '2026-10-31T01:00:00.000Z',
      available: true,
      urls: {
        thumb: `/api/chat/images/${id}/thumb`,
        display: `/api/chat/images/${id}/display`,
        original: `/api/chat/images/${id}/original`,
        preview: `/api/chat/images/${id}/preview`,
      },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const png = (name = 'a.png') => new File(['png'], name, { type: 'image/png' });

describe('useChatImages', () => {
  it('uploads a pasted file at once: uploading, then ready with its thumb', async () => {
    const d = deferred<ChatImageUpload>();
    const upload = vi.fn(() => d.promise);
    const { result } = renderHook(() => useChatImages(upload));
    act(() => result.current.add([png()]));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.current.images).toMatchObject([{ state: 'uploading', label: 'a.png', id: null }]);
    expect(result.current.blocked).toBe(true);
    expect(result.current.readyIds).toEqual([]);
    await act(async () => {
      d.resolve(uploadOf('U-PL1'));
      await d.promise;
    });
    expect(result.current.images).toMatchObject([{ state: 'ready', id: 'U-PL1', thumbUrl: '/api/chat/images/U-PL1/thumb' }]);
    expect(result.current.readyIds).toEqual(['U-PL1']);
    expect(result.current.blocked).toBe(false);
  });

  it('marks a failed upload, which blocks sending until removed', async () => {
    const d = deferred<ChatImageUpload>();
    const { result } = renderHook(() => useChatImages(() => d.promise));
    act(() => result.current.add([png()]));
    await act(async () => {
      d.reject(new Error('too_large'));
      await d.promise.catch(() => undefined);
    });
    expect(result.current.images).toMatchObject([{ state: 'failed', error: 'too_large' }]);
    expect(result.current.blocked).toBe(true);
    act(() => result.current.remove(result.current.images[0]!.key));
    expect(result.current.images).toEqual([]);
    expect(result.current.blocked).toBe(false);
  });

  it(`caps a message at ${MAX_CHAT_IMAGES} images; the rest show as failed and are not uploaded`, () => {
    const upload = vi.fn(() => new Promise<ChatImageUpload>(() => {}));
    const { result } = renderHook(() => useChatImages(upload));
    act(() => result.current.add([png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png')]));
    expect(upload).toHaveBeenCalledTimes(MAX_CHAT_IMAGES);
    expect(result.current.images.map((i) => i.state)).toEqual(['uploading', 'uploading', 'uploading', 'uploading', 'failed']);
    expect(result.current.images[4]?.error).toBe(`at most ${MAX_CHAT_IMAGES} images per message`);
  });

  it('a removed image ignores its late upload result; clear empties the bar', async () => {
    const d = deferred<ChatImageUpload>();
    const { result } = renderHook(() => useChatImages(() => d.promise));
    act(() => result.current.add([png()]));
    act(() => result.current.remove(result.current.images[0]!.key));
    await act(async () => {
      d.resolve(uploadOf('U-PL1'));
      await d.promise;
    });
    expect(result.current.images).toEqual([]);
    act(() => result.current.add([png()]));
    act(() => result.current.clear());
    expect(result.current.images).toEqual([]);
  });

  it('the same bytes pasted twice are sent once', async () => {
    const { result } = renderHook(() => useChatImages(async () => uploadOf('U-PL1', false)));
    act(() => result.current.add([png('a.png'), png('b.png')]));
    await waitFor(() => expect(result.current.images.every((i) => i.state === 'ready')).toBe(true));
    expect(result.current.images).toHaveLength(2);
    expect(result.current.readyIds).toEqual(['U-PL1']);
  });
});
```

**File:** `web/src/components/AnswerPanel.test.tsx` (append)
```tsx
describe('AnswerPanel pasted images', () => {
  it('shows the thumbnails sent with the query', () => {
    const { container } = renderPanel({ images: ['U-PL1', 'V-QM2'] });
    const srcs = [...container.querySelectorAll('.answer-images img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(['/api/chat/images/U-PL1/thumb', '/api/chat/images/V-QM2/thumb']);
  });

  it('labels an image-only question by its image count', () => {
    const { container } = renderPanel({ query: '', images: ['U-PL1'] });
    expect(container.querySelector('.answer-q')?.textContent).toBe('1 image');
  });

  it('hides the thumbnails when collapsed, and shows none without images', () => {
    const collapsed = renderPanel({ images: ['U-PL1'], collapsed: true });
    expect(collapsed.container.querySelector('.answer-images')).toBeNull();
    collapsed.unmount();
    const plain = renderPanel();
    expect(plain.container.querySelector('.answer-images')).toBeNull();
  });
});
```

**File:** `web/src/App.test.tsx` (append a describe at the end)
```tsx
describe('App chat images (R1)', () => {
  type Call = { method: string; url: string; body?: unknown };
  let calls: Call[];
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const uploaded = {
    created: true,
    image: {
      id: 'U-PL1',
      mime: 'image/png',
      width: 10,
      height: 10,
      bytes: 3,
      original_name: 'shot.png',
      host: 'lenovo',
      source: 'wall',
      created_at: iso,
      available: true,
      urls: {
        thumb: '/api/chat/images/U-PL1/thumb',
        display: '/api/chat/images/U-PL1/display',
        original: '/api/chat/images/U-PL1/original',
        preview: '/api/chat/images/U-PL1/preview',
      },
    },
  };

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (url === '/api/chat/images') {
          return new Response(JSON.stringify(uploaded), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('/api/chat')) {
          return new Response('event: delta\ndata: {"text":"A red square."}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        if (url.startsWith('/api/notes')) return json({ notes, next_cursor: null });
        if (url.startsWith('/api/tags')) return json(tags);
        return new Response('not found', { status: 404 });
      }),
    );
  });

  it('a paste into the focused chat bar uploads a chat image, never a note, and sends its id', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    const ta = screen.getByLabelText('Ask about your notes') as HTMLTextAreaElement;
    ta.focus();
    fireEvent.paste(ta, { clipboardData: { files: [png] } });
    await waitFor(() =>
      expect(document.querySelector('.chatbar-thumb img')?.getAttribute('src')).toBe('/api/chat/images/U-PL1/thumb'),
    );
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/chat/images')).toHaveLength(1);
    expect(calls.some((c) => c.url === '/api/images')).toBe(false);

    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    await screen.findByText('A red square.');
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/chat')?.body).toEqual({ message: '', image_ids: ['U-PL1'] });
    expect(document.querySelector('.chatbar-thumb')).toBeNull();
    expect(document.querySelector('.answer-images img')?.getAttribute('src')).toBe('/api/chat/images/U-PL1/thumb');
    expect(document.querySelector('.answer-q')?.textContent).toBe('1 image');
  });

  it('a paste with the chat bar not focused still makes a new photo note', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await screen.findByText('onboarding is long');
    (document.activeElement as HTMLElement | null)?.blur();
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files: [png] } });
    document.dispatchEvent(e);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/images')).toBe(true));
    expect(calls.some((c) => c.url === '/api/chat/images')).toBe(false);
    quiet.mockRestore();
  });
});
```
(The 404 for `/api/images` here only exercises routing; `DropOverlay` logs it.)

### Step 24: Docs
**File:** `CHANGELOG.md:7` (insert before `## [v0.1.0] - 2026-10-30`)
```markdown
## [Unreleased]

### Added

- **Paste images into the chat bar**: with the bar focused, a pasted image uploads to a separate chat image store (`chat_images`, sha256-deduped, never a note) and shows as a removable thumbnail; the question goes out with up to four images, even with no text, and the agent receives them as image blocks named `[image upload:ID]`.

```
Create `## [Unreleased]` and `### Added` only if they are missing (Phases 1 and 2 run in the same wave and may have added `## [Unreleased]` first); otherwise add only the bullet. When the wave merges, the integrator keeps exactly one `## [Unreleased]` with one `### Added` and one `### Fixed`.

**File:** `README.md:394` (after the "The bar takes several lines…" paragraph in "## The chat bar")
```markdown
Paste a screenshot or photo while the bar has focus and it goes with your next question instead
of becoming a note. A small thumbnail appears inside the pill: a spinner while it uploads, a
warning mark if it failed, and an × to take it out. Up to four images go with one question, and
a question may be images alone. The answer panel shows them above the answer, and the agent sees
them, each named by an upload id (`upload:A-B32`). Pasted chat images are stored once by sha256
under `~/mcp-notes-data/chat-images/` and never appear on the wall. Pasting anywhere else still
makes a new photo note, and pasting into the open big editor still attaches to that note.
```

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test && npm run test:int`
- unit: `npx vitest run tests/unit/chat-agent.test.ts tests/unit/chat-compose.test.ts tests/unit/chat-images.test.ts tests/unit/chat-stub.test.ts tests/unit/images/store.test.ts web/src/components/ChatBar.test.tsx web/src/components/DropOverlay.test.tsx web/src/components/AnswerPanel.test.tsx web/src/hooks/useChat.test.tsx web/src/hooks/useChatImages.test.tsx web/src/App.test.tsx`
- integration only this phase's file: `npm run test:int -- tests/integration/chat.images.int.test.ts`
- live (opt-in, billed, once before merge): `npm run test:live` (the new Claude image case proves SDK streaming input with image blocks end to end).

**Migration check:** `git status --short drizzle` shows only `drizzle/0003_chat_images.sql`, `drizzle/meta/0003_snapshot.json`, `drizzle/meta/_journal.json`; `npm run db:check` passes.

**Manual check:** none required in the phase (the daemon on 7317 runs the installed build against Neon; `npm run db:migrate` must not run from the worktree). After merge and `npm run db:migrate`: focus the chat bar on the wall, Win+Shift+S a region, Ctrl+V: a thumbnail spins then shows; Enter sends; the panel shows the thumbnail and the answer describes the image. Click the page body and Ctrl+V again: a new photo note appears.

**Exit criteria:** pasting an image into the focused bar uploads to `POST /api/chat/images` and shows a removable thumbnail; sending posts `image_ids`; the SDK receives one user message with an image block per image and `[image upload:ID]` lines; pasting with focus elsewhere still creates a note and pasting in the open editor still attaches; `chat.images.int.test.ts` covers upload 201/200 (dedupe, heal, concurrent), 413, 415, 400, variant serving under `cache/c_<id>/`, chat request validation (400/409) and prompt composition through a fake `query`; typecheck, unit, integration and build all green.

## Handoffs

- **Phase 4 (R2):** also edits `src/db/schema.ts` header, `DATA_SUBDIRS` (`src/daemon.ts:20`), `DataDirs`/`dataDirs`/`ensureDataDirs` (`src/images/store.ts`), and `truncateAll` (`tests/integration/setup.ts:50`). Textual merges only; its migration must be generated on top of 0003 (it is 0004).
- **Phase 5 (R2):** extends `DropOverlay`'s paste/drop routing; keep `if (chatBarHasFocus()) return;` as the first line of `onPaste`.
- **Phase 6 (R5):** `similar_images({upload_id})` resolves with `locateChatImage(deps, id)` and `getPreview(dataDir, loc.source)` (then re-encodes to PNG itself). Adding the tool to the chat allowlist and teaching the model to pass `upload_id` from the `[image upload:ID]` lines is Phase 6's (`src/chat/status.ts`, instructions).
- **Phase 7 (R3):** extends `composeUserTurn` (`src/chat/compose.ts`) with rebuilt history and reply targets; replaces `threadId`/`resume`; persists `ChatRequest.images` ids as `chat_message_attachments` rows referencing `chat_images.id`; earlier-turn images become `uploadTag` placeholders only.
- **Phase 8 (R1, R3):** the capture endpoint stores transcript images with `ingestChatImage(store, {bytes, originalName, source: 'claude_code'})`. The paste hook uploads through `POST /api/chat/images` with the multipart field `source=claude_code`, which this phase already accepts (moved here from Phase 8 by the reconciler, so Phase 8 never edits `src/http/chatImages.ts`).
- **Phase 9 (R3):** the history page composer reuses `<ChatBar variant="page" …>` with its own `useChatImages()`; thumbnails in bubbles and in `AnswerPanel` open the Phase 2 Lightbox (not done here); styling for `.chatbar-page`.
- **Any phase / cleanup:** `src/http/images.ts` `sendResolved` and `src/http/chatImages.ts` `sendVariant` duplicate ~25 lines of file serving; fold them into one helper when convenient. No garbage collection of chat images that were uploaded but never sent (or removed before sending); not in the design. Dragging an image onto the chat bar still makes a note (the design covers paste only). GLM's support for image blocks is unverified (the live test runs the image case on Claude only).

## Rollback

Revert this phase's commits. The table is additive; to drop it on a database where 0003 was applied:
```sql
DROP TABLE IF EXISTS chat_images;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations);
```
(the second statement only when 0003 is the newest applied migration). On disk: `rm -rf ~/mcp-notes-data/chat-images ~/mcp-notes-data/cache/c_*`.
