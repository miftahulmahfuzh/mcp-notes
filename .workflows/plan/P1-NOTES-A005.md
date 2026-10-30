> Adopted from `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` phase 6. Source: `.workflows/plan/notes-spine-images-ui/phase-6.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 6: UI JSON API, SSE events, chat stub, static SPA serving

**Plan set:** `NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R3. This phase builds the server half of the web UI: the JSON API the SPA calls, live updates, the streaming chat stub, and serving the built SPA.
**Depends on:** Phase 2 (and Phase 1 transitively)
**Difficulty:** NORMAL
**Package:** `src/http`, `src/chat`

---

## Goal

After this phase, `notesd` answers the whole P6 HTTP contract. That covers notes CRUD as JSON (with tag-AND and 3-way `has_image` filters), tag counts, an SSE stream of note changes from the in-process event bus, and `POST /api/chat`, which streams a fixed "iteration 4" reply through a `ChatBackend` interface. It also serves `web/dist` as an SPA without shadowing `/api`, `/mcp` or `/health`. Every endpoint has a test that runs in-process through `app.request()`.

## Course correction applied (coordinator, owner commit 30a58fd)

Note visibility in the UI has three modes: text only (the default), images only, and all. So
`GET /api/notes` accepts an optional `has_image=true|false`. When the parameter is omitted, the
endpoint returns every note. The value goes to Phase 2's repo/service list option
`hasImage?: boolean`, which Phase 2 now owns. `GET /api/notes` also accepts repeated `tag`
params with AND semantics (`?tag=a&tag=b`). Tests cover all three `has_image` values.

## Phase 1 / Phase 2 exports this plan uses (reconciled against their plans)

| Symbol | File | Shape |
|---|---|---|
| `AppDeps` | `src/deps.ts` (P2) | `{ config: Config; db: Db; events: NoteEvents; service: NotesService }` |
| router factories | `src/http/app.ts` (P2) | `app.route('/', apiRoutes(deps))` before `imageRoutes(deps)`, `app.route('/', staticRoutes(deps))` last; each is `(deps: AppDeps) => Hono`. Extra optional parameters are fine. |
| `NotesService` | `src/notes/service.ts` (P2) | `create({ body, origin?, allowEmpty? }): Promise<Note>`; `getOne(id): Promise<Note \| null>` (null for unknown or soft-deleted); `update(id, body, { allowEmpty? }): Promise<Note>`; `delete(id): Promise<Note>` (soft, idempotent); `list(filter: NoteFilter): Promise<{ notes; next_cursor }>`; `tags(): Promise<{ tag; count; last_used }[]>`. Failures are `NoteError { code }`. |
| `NoteFilter` | `src/notes/repo.ts` (P2) | `{ tagsAll?, hasImage?, limit? (1..5000, P2's MAX_LIMIT), cursor? }`; excludes soft-deleted by default; `created_at desc, id desc`. An undecodable cursor throws `NoteError('invalid_input')`. |
| `NoteError` codes | `src/notes/types.ts` (P2) | `invalid_id`, `invalid_input`, `empty_body`, `invalid_revision` → 400; `not_found`, `deleted` → 404; `conflict`, `duplicate_image` → 409 |
| `NoteEvents` | `src/notes/events.ts` (P2) | `on(listener): () => void` (returns unsubscribe), `listenerCount(): number`; events `{ type: 'note', op, id }` |
| `normalizeId`, `generateId` | `src/notes/ids.ts` (P1) | `normalizeId(raw): string \| null` |
| test helpers | `tests/integration/setup.ts` (P1) | `openTestDb()`, `closeTestDb(db)`, `testDatabaseUrl()` |

The UI API maps onto these: `POST` creates with `allowEmpty: true`, `PATCH` updates with
`{ allowEmpty: true }` (index Decisions: HTTP allows empty bodies, MCP does not), and `DELETE`
returns 404 for a note that is not live (checked with `getOne` first, since P2's `delete` is
idempotent).

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `apiRoutes(deps: AppDeps, options?: ApiOptions): Hono`, `ApiOptions { chat?; sseHeartbeatMs? }`, `DEFAULT_LIST_LIMIT` (2000), `MAX_LIST_LIMIT` (5000, = P2's repo `MAX_LIMIT`), `SSE_HEARTBEAT_MS` (25000) in `src/http/api.ts` (replaces phase 2's empty router body)
- `staticRoutes(deps?: AppDeps, options?: StaticOptions): Hono`, `StaticOptions`, `DEFAULT_WEB_DIST`, `WEB_NOT_BUILT_TEXT` in `src/http/static.ts` (replaces phase 2's empty router body)
- `ChatBackend`, `ChatRequest`, `ChatTurn` in `src/chat/backend.ts`
- `createStubChatBackend(options?)`, `STUB_REPLY`, `splitIntoDeltas` in `src/chat/stub.ts`
- tests: `tests/unit/chat-stub.test.ts`, `tests/unit/static.test.ts`, `tests/integration/helpers/api-harness.ts`, `tests/integration/helpers/sse.ts`, `tests/integration/api.int.test.ts`, `tests/integration/events.int.test.ts`

**HTTP contract (exact, for Phase 7/8):**

| Method + path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/notes` | `?limit=1..5000` (default 2000), `?cursor=<opaque>`, `?has_image=true\|false` (omitted = all), `?tag=x` repeatable (AND; leading `#` stripped, lower-cased) | 200 `{ notes: Note[], next_cursor: string \| null }`, non-deleted, `created_at desc` | 400 `{error}` bad limit/has_image/cursor |
| `GET /api/notes/:id` | id case/dash tolerant | 200 `Note` | 400 `{error:'invalid_id'}`, 404 `{error:'not_found'}` (also for soft-deleted) |
| `POST /api/notes` | `{ body: string }` (may be `''`) | 201 `Note` with `origin: { source: 'web' }` | 400 `{error}` |
| `PATCH /api/notes/:id` | `{ body: string }` (may be `''`) | 200 `Note` | 400, 404 |
| `DELETE /api/notes/:id` | — | 200 `Note` (with `deleted_at`) | 400, 404 (missing or already deleted) |
| `GET /api/tags` | — | 200 `[{ tag, count, last_used }]` | — |
| `GET /api/events` | — | 200 `text/event-stream`: first `: connected` comment, then `event: note` / `data: {"op","id"}` per change, `: heartbeat` comment every 25 s | — |
| `POST /api/chat` | `{ message: string (non-empty after trim), thread_id?: string }` | 200 `text/event-stream`: `event: delta` / `data: {"text"}` …, then `event: done` / `data: {"thread_id"}`. A backend failure mid-stream sends `event: error` / `data: {"error"}` instead of `done` | 400 `{error}` (JSON, before any streaming) |

Invalid JSON bodies return 400 `{ error: 'invalid_json' }`. A validation failure returns 400 `{ error: '<path>: <message>; …' }`.

**Static contract:** `GET /` → `web/dist/index.html` (`Cache-Control: no-cache`).
`GET /full/:id` → `web/dist/fullscreen.html`, or `index.html` if that file is absent.
`GET /assets/*` → the file, with `Cache-Control: public, max-age=31536000, immutable`, or 404 if
missing (never `index.html`). Any other GET serves a regular file under `web/dist` if one exists
(for example `/favicon.svg`), and otherwise `index.html`. `/api`, `/api/*`, `/mcp`, `/mcp/*`,
`/health` and `/health/*` are never served by static and get `c.notFound()`. When `index.html`
is missing, every static GET returns 503 `text/plain` `web UI not built: run npm run build`.
`web/dist` is resolved from the module's own location (`src/http` and `dist/http` are both two
levels below the repo root), never from cwd.

**Requires (from earlier phases):**
- Phase 2: every row of the exports table above, including `list` accepting `hasImage`, `tagsAll`, and `limit` up to 5000.
- Phase 2: `src/http/app.ts` mounts `apiRoutes(deps)` before `imageRoutes(deps)` and `staticRoutes(deps)` last, all at `'/'`.
- Phase 2: `src/http/api.ts` and `src/http/static.ts` exist. This phase rewrites them in full.
- Phase 1: `hono`, `zod` (v4) and `@hono/node-server` in `package.json`. `hono/streaming` (`streamSSE`) ships with `hono` 4.x. No new dependency.
- Phase 1: vitest picks up `tests/unit/**/*.test.ts` in `npm test` and `tests/integration/**/*.int.test.ts` in `npm run test:int`.

**Leaves alone (owned by others):** `package.json`, `package-lock.json`, `drizzle/*` (P1);
`src/http/app.ts`, `src/notes/*`, `src/mcp/*`, `src/main.ts` (P2); `src/images/*` (P4);
`src/http/images.ts`, the `hasImage` implementation in `src/notes/repo.ts` (P2/P5); `web/**` (P7/P8).

## Files

| File | Action | What changes |
|---|---|---|
| `src/chat/backend.ts` | create | `ChatBackend` interface (the iteration-4 swap point) |
| `src/chat/stub.ts` | create | fixed-reply backend streamed word by word with a delay |
| `src/http/api.ts` | rewrite (P2 ships an empty router, whole file replaced from line 1) | notes CRUD, tags, SSE, chat |
| `src/http/static.ts` | rewrite (P2 ships an empty router, whole file replaced from line 1) | `web/dist` SPA serving |
| `tests/unit/chat-stub.test.ts` | create | stub chunking, thread ids, abort |
| `tests/unit/static.test.ts` | create | static routing against a temp `web/dist` |
| `tests/integration/helpers/api-harness.ts` | create | builds service + bus + `apiRoutes` on the test DB |
| `tests/integration/helpers/sse.ts` | create | `readUntil`, `parseSse`, `waitFor` |
| `tests/integration/api.int.test.ts` | create | notes CRUD, filters, tags, chat |
| `tests/integration/events.int.test.ts` | create | SSE event after a service write, heartbeat, unsubscribe on abort |

## Implementation Steps

### Step 1: Chat backend interface
**File:** `src/chat/backend.ts:1` (new)
**Change:** Defines the seam that iteration 4 implements. `reply` is async so a real backend can create or load a thread before it streams.
**Code:**
```ts
/**
 * The chat brain seam. Iteration 3 ships a stub (src/chat/stub.ts); iteration 4 replaces
 * only the implementation passed to apiRoutes(). The HTTP layer streams whatever
 * `deltas` yields as `event: delta` and then sends `event: done` with `threadId`.
 */
export interface ChatRequest {
  /** The user's message, already trimmed and non-empty. */
  message: string;
  /** The thread the client wants to continue, or null to start a new one. */
  threadId: string | null;
  /** Aborted when the HTTP client disconnects. Backends must stop yielding promptly. */
  signal: AbortSignal;
}

export interface ChatTurn {
  /** The thread this reply belongs to (new or continued). Sent in `event: done`. */
  threadId: string;
  /** Text fragments in order. Their concatenation is the full reply. */
  deltas: AsyncIterable<string>;
}

export interface ChatBackend {
  reply(request: ChatRequest): Promise<ChatTurn>;
}
```
**Impact:** none. New file.

### Step 2: Stub chat backend
**File:** `src/chat/stub.ts:1` (new)
**Change:** Streams the fixed reply in word-sized deltas with a short delay, so the UI's streaming path gets exercised. It respects abort.
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import type { ChatBackend, ChatRequest, ChatTurn } from './backend.js';

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
): AsyncGenerator<string> {
  for (const part of parts) {
    if (signal.aborted) return;
    if (delayMs > 0) await sleep(delayMs, signal);
    if (signal.aborted) return;
    yield part;
  }
}

export function createStubChatBackend(options: StubChatOptions = {}): ChatBackend {
  const delayMs = options.delayMs ?? 40;
  return {
    async reply(request: ChatRequest): Promise<ChatTurn> {
      const threadId = request.threadId ?? `stub-${randomUUID()}`;
      return {
        threadId,
        deltas: streamDeltas(splitIntoDeltas(STUB_REPLY), delayMs, request.signal),
      };
    },
  };
}
```
**Impact:** none. New file.

### Step 3: JSON API, SSE and chat routes
**File:** `src/http/api.ts:1`. This replaces the whole file. Phase 2 ships it as an empty `Hono` router, and this phase replaces every line.
**Change:** `apiRoutes(deps, options)` factory with all P6 routes at full `/api/...` paths. Validation uses zod. Errors are `{ error }`; `NoteError` codes map to statuses in one place (`noteErrorResponse`). Ids go through `normalizeId`. `GET /api/notes/:id` matches exactly one segment after `notes/`, so `/api/notes/:id/{original,display,thumb,preview}` fall through to phase 5's `imageRoutes`.
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ChatBackend } from '../chat/backend.js';
import { createStubChatBackend } from '../chat/stub.js';
import type { AppDeps } from '../deps.js';
import type { NoteEvent } from '../notes/events.js';
import { normalizeId } from '../notes/ids.js';
import { MAX_LIMIT } from '../notes/repo.js';
import { NoteError } from '../notes/types.js';

export const DEFAULT_LIST_LIMIT = 2000;
export const MAX_LIST_LIMIT = MAX_LIMIT; // 5000, P2's repo cap
export const SSE_HEARTBEAT_MS = 25_000;

export interface ApiOptions {
  /** Defaults to the iteration-3 stub. Iteration 4 passes the real backend here. */
  chat?: ChatBackend;
  /** Defaults to SSE_HEARTBEAT_MS. Tests pass a small value. */
  sseHeartbeatMs?: number;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  cursor: z.string().min(1).optional(),
  has_image: z.enum(['true', 'false']).optional(),
});

const noteBodySchema = z.object({
  body: z.string(),
});

const chatSchema = z.object({
  message: z.string().trim().min(1),
  thread_id: z.string().trim().min(1).max(200).optional(),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

function badRequest(c: Context, error: string): Response {
  return c.json({ error }, 400);
}

function notFound(c: Context): Response {
  return c.json({ error: 'not_found' }, 404);
}

/** The one NoteError → HTTP mapping. Anything else is rethrown (Hono answers 500). */
function noteErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof NoteError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'deleted':
      return notFound(c);
    case 'conflict':
    case 'duplicate_image':
      return c.json({ error: err.code }, 409);
    case 'invalid_id':
      return badRequest(c, 'invalid_id');
    default:
      return badRequest(c, `${err.code}: ${err.message}`);
  }
}

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

/** `?tag=a&tag=%23B` -> ['a', 'b']: leading '#' stripped, lower-cased, deduped, empties dropped. */
function parseTagParams(raw: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const value of raw ?? []) {
    const tag = value.trim().replace(/^#/, '').toLowerCase();
    if (tag.length > 0) seen.add(tag);
  }
  return [...seen];
}

export function apiRoutes(deps: AppDeps, options: ApiOptions = {}): Hono {
  const api = new Hono();
  const service = deps.service;
  const chat = options.chat ?? createStubChatBackend();
  const heartbeatMs = options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;

  api.get('/api/notes', async (c) => {
    const parsed = listQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      has_image: c.req.query('has_image'),
    });
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    const { limit, cursor, has_image } = parsed.data;
    const tags = parseTagParams(c.req.queries('tag'));
    try {
      const page = await service.list({
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(tags.length > 0 ? { tagsAll: tags } : {}),
        ...(has_image !== undefined ? { hasImage: has_image === 'true' } : {}),
      });
      return c.json({ notes: page.notes, next_cursor: page.next_cursor });
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.get('/api/notes/:id', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    const note = await service.getOne(id);
    if (note === null) return notFound(c);
    return c.json(note);
  });

  api.post('/api/notes', async (c) => {
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = noteBodySchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    try {
      const note = await service.create({ body: parsed.data.body, origin: { source: 'web' }, allowEmpty: true });
      return c.json(note, 201);
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.patch('/api/notes/:id', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = noteBodySchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    try {
      return c.json(await service.update(id, parsed.data.body, { allowEmpty: true }));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.delete('/api/notes/:id', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    // P2's delete is idempotent; the UI contract is 404 for a note that is not live.
    if ((await service.getOne(id)) === null) return notFound(c);
    try {
      return c.json(await service.delete(id));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.get('/api/tags', async (c) => {
    return c.json(await service.tags());
  });

  api.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      const listener = (event: NoteEvent): void => {
        if (closed) return;
        void stream
          .writeSSE({ event: 'note', data: JSON.stringify({ op: event.op, id: event.id }) })
          .catch(() => undefined);
      };
      const unsubscribe = deps.events.on(listener);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(timer);
          unsubscribe();
          resolve();
        });
        void stream.write(': connected\n\n').catch(() => undefined);
      });
    }),
  );

  api.post('/api/chat', async (c) => {
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = chatSchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    const { message, thread_id } = parsed.data;

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      try {
        const turn = await chat.reply({
          message,
          threadId: thread_id ?? null,
          signal: controller.signal,
        });
        for await (const text of turn.deltas) {
          if (controller.signal.aborted) return;
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) });
        }
        if (controller.signal.aborted) return;
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ thread_id: turn.threadId }) });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error }) });
      }
    });
  });

  return api;
}
```
**Impact:** phase 2's `app.ts` already calls `apiRoutes(deps)`; the options default to the stub chat backend and a 25 s heartbeat. The SSE listener is removed when the client disconnects, through `stream.onAbort`. Both `@hono/node-server` socket close and `reader.cancel()` in `app.request()` trigger it. `stream.write` is used for comment lines because `writeSSE` always emits a `data:` field. A whole SSE message is written in one call, so heartbeats and events cannot interleave mid-message.

### Step 4: Static SPA serving
**File:** `src/http/static.ts:1`. This replaces the whole file. Phase 2 ships it as an empty `Hono` router.
**Change:** `staticRoutes(deps?, options?)`, a single `GET *` handler. It checks `web/dist` on every request, so building the UI after the daemon has started works without a restart. It guards against path traversal and never answers reserved prefixes.
**Code:**
```ts
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import type { AppDeps } from '../deps.js';

/** `<repo>/web/dist`: src/http/static.ts (tsx/vitest) and dist/http/static.js (built) are both two levels down. */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export const WEB_NOT_BUILT_TEXT = 'web UI not built: run npm run build';

export interface StaticOptions {
  /** Absolute path of the built SPA. Defaults to DEFAULT_WEB_DIST. */
  webDist?: string;
}

const RESERVED_PREFIXES = ['/api', '/mcp', '/health'];
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=3600';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function isReserved(pathname: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Reads `<root>/<urlPath>` if it is a regular file inside root; null otherwise (missing, dir, traversal). */
async function readInside(root: string, urlPath: string): Promise<Buffer | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(root, decoded.replace(/^\/+/, ''));
  if (!full.startsWith(root + path.sep)) return null;
  try {
    const info = await stat(full);
    if (!info.isFile()) return null;
    return await readFile(full);
  } catch {
    return null;
  }
}

function sendFile(c: Context, bytes: Buffer, filePath: string, cacheControl: string): Response {
  return c.body(new Uint8Array(bytes), 200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': cacheControl,
  });
}

function sendHtml(c: Context, bytes: Buffer): Response {
  return sendFile(c, bytes, 'page.html', 'no-cache');
}

/** `deps` is unused (P2's factory shape); tests call `staticRoutes(undefined, { webDist })`. */
export function staticRoutes(deps?: AppDeps, options: StaticOptions = {}): Hono {
  void deps;
  const root = path.resolve(options.webDist ?? DEFAULT_WEB_DIST);
  const app = new Hono();

  app.get('*', async (c) => {
    const pathname = c.req.path;
    if (isReserved(pathname)) return c.notFound();

    const index = await readInside(root, 'index.html');
    if (index === null) {
      return c.text(WEB_NOT_BUILT_TEXT, 503, { 'Cache-Control': 'no-store' });
    }

    if (pathname.startsWith('/assets/')) {
      const asset = await readInside(root, pathname);
      if (asset === null) return c.text('not found', 404);
      return sendFile(c, asset, pathname, IMMUTABLE);
    }

    if (/^\/full\/[^/]+\/?$/.test(pathname)) {
      const fullscreen = await readInside(root, 'fullscreen.html');
      return sendHtml(c, fullscreen ?? index);
    }

    if (pathname !== '/') {
      const file = await readInside(root, pathname);
      if (file !== null) {
        if (pathname.toLowerCase().endsWith('.html')) return sendHtml(c, file);
        return sendFile(c, file, pathname, SHORT_CACHE);
      }
    }

    return sendHtml(c, index);
  });

  return app;
}
```
**Impact:** Mounted last by `app.ts`, it catches every unmatched GET. Reserved prefixes return Hono's 404, so a missing `/api/...` route never comes back as HTML. `/mcp` GET and POST are matched earlier by phase 2's route in any case.

### Step 5: Unit test for the chat stub
**File:** `tests/unit/chat-stub.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { STUB_REPLY, createStubChatBackend, splitIntoDeltas } from '../../src/chat/stub.js';

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const part of iterable) out.push(part);
  return out;
}

describe('chat stub', () => {
  it('splits text into word deltas that rejoin exactly', () => {
    const parts = splitIntoDeltas(STUB_REPLY);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join('')).toBe(STUB_REPLY);
  });

  it('mentions iteration 4', () => {
    expect(STUB_REPLY).toMatch(/iteration 4/);
  });

  it('streams the fixed reply and starts a new thread when none is given', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({
      message: 'hello',
      threadId: null,
      signal: new AbortController().signal,
    });
    expect(turn.threadId).toMatch(/^stub-/);
    expect((await collect(turn.deltas)).join('')).toBe(STUB_REPLY);
  });

  it('keeps a given thread id', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({
      message: 'hello',
      threadId: 'thread-1',
      signal: new AbortController().signal,
    });
    expect(turn.threadId).toBe('thread-1');
  });

  it('stops yielding after abort', async () => {
    const backend = createStubChatBackend({ delayMs: 5 });
    const controller = new AbortController();
    const turn = await backend.reply({ message: 'x', threadId: null, signal: controller.signal });
    const out: string[] = [];
    for await (const part of turn.deltas) {
      out.push(part);
      if (out.length === 2) controller.abort();
    }
    expect(out).toHaveLength(2);
  });
});
```

### Step 6: Unit test for static serving
**File:** `tests/unit/static.test.ts:1` (new)
**Change:** Mounts `staticRoutes(undefined, { webDist })` on a bare `Hono` against temp dirs. No DB is needed.
**Code:**
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_NOT_BUILT_TEXT, staticRoutes } from '../../src/http/static.js';

let tmp: string;
let dist: string;

function appFor(webDist: string): Hono {
  const app = new Hono();
  app.route('/', staticRoutes(undefined, { webDist }));
  return app;
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-static-'));
  dist = path.join(tmp, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>index</title>');
  await writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1);');
  await writeFile(path.join(dist, 'favicon.svg'), '<svg></svg>');
  await writeFile(path.join(tmp, 'secret.txt'), 'secret');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('staticRoutes', () => {
  it('returns 503 text when web/dist is missing', async () => {
    const res = await appFor(path.join(tmp, 'nope')).request('/');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(WEB_NOT_BUILT_TEXT);
  });

  it('serves index.html at / with no-cache', async () => {
    const res = await appFor(dist).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>index</title>');
  });

  it('falls back to index.html for client routes', async () => {
    const res = await appFor(dist).request('/some/client/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>index</title>');
  });

  it('serves index.html for /full/:id until fullscreen.html exists, then fullscreen.html', async () => {
    const app = appFor(dist);
    expect(await (await app.request('/full/A-B32CD')).text()).toContain('<title>index</title>');
    await writeFile(path.join(dist, 'fullscreen.html'), '<!doctype html><title>full</title>');
    try {
      const res = await app.request('/full/A-B32CD');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>full</title>');
    } finally {
      await rm(path.join(dist, 'fullscreen.html'));
    }
  });

  it('serves assets with a long immutable cache and the right type', async () => {
    const res = await appFor(dist).request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log(1);');
  });

  it('404s a missing asset instead of returning html', async () => {
    const res = await appFor(dist).request('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it('serves other root files such as favicon.svg', async () => {
    const res = await appFor(dist).request('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
  });

  it.each(['/api', '/api/notes', '/api/nope/x', '/mcp', '/health'])('does not serve %s', async (p) => {
    const res = await appFor(dist).request(p);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<title>index</title>');
  });

  it('does not escape web/dist', async () => {
    const res = await appFor(dist).request('/..%2Fsecret.txt');
    expect(await res.text()).not.toBe('secret');
    const asset = await appFor(dist).request('/assets/..%2F..%2Fsecret.txt');
    expect(await asset.text()).not.toBe('secret');
  });
});
```

### Step 7: SSE test helpers
**File:** `tests/integration/helpers/sse.ts:1` (new)
**Code:**
```ts
export interface SseMessage {
  event: string;
  data: unknown;
}

/** Reads from the stream until `done(accumulatedText)` is true. Throws after `timeoutMs`. */
export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!done(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`readUntil timed out; got: ${JSON.stringify(text)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`readUntil timed out; got: ${JSON.stringify(text)}`)),
        remaining,
      );
    });
    try {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }
  return text;
}

/** Parses `event:`/`data:` blocks; comment-only blocks (`: heartbeat`) are dropped. */
export function parseSse(text: string): SseMessage[] {
  const messages: SseMessage[] = [];
  for (const block of text.split('\n\n')) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (data.length > 0) messages.push({ event, data: JSON.parse(data.join('\n')) as unknown });
  }
  return messages;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

### Step 8: Integration harness
**File:** `tests/integration/helpers/api-harness.ts:1` (new)
**Change:** Builds the real service and event bus on the Docker test Postgres (phase 1's `openTestDb`), then mounts `apiRoutes` on a bare `Hono`, without phase 2's `createApp`, so the file depends only on the service seams. Isolation comes from a **unique tag per test** (`uniqueTag()`) and `?tag=` filtering rather than truncation (integration files run serially under phase 1's config; other files truncate in their own `beforeEach`). `insertImageNote` writes an image row straight into SQL, because phase 4's ingest is not a dependency of this phase.
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createStubChatBackend } from '../../../src/chat/stub.js';
import type { AppDeps } from '../../../src/deps.js';
import { apiRoutes } from '../../../src/http/api.js';
import { NoteEvents } from '../../../src/notes/events.js';
import { generateId } from '../../../src/notes/ids.js';
import { NotesService } from '../../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl } from '../setup.js';

export interface ApiHarness {
  app: Hono;
  notes: NotesService;
  events: NoteEvents;
  request(pathname: string, init?: RequestInit): Promise<Response>;
  sendJson(method: string, pathname: string, payload: unknown): Promise<Response>;
  insertImageNote(tag: string): Promise<string>;
  close(): Promise<void>;
}

export interface ApiHarnessOptions {
  sseHeartbeatMs?: number;
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
  const deps: AppDeps = { config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir }, db, events, service: notes };
  const app = new Hono();
  app.route(
    '/',
    apiRoutes(deps, {
      chat: createStubChatBackend({ delayMs: 0 }),
      ...(options.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: options.sseHeartbeatMs } : {}),
    }),
  );

  return {
    app,
    notes,
    events,
    request: (pathname, init) => Promise.resolve(app.request(pathname, init)),
    sendJson: (method, pathname, payload) =>
      Promise.resolve(
        app.request(pathname, {
          method,
          headers: { 'content-type': 'application/json' },
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
        INSERT INTO notes (id, body, tags, image_path, image_meta, origin, created_at, updated_at)
        VALUES (${id}, ${`photo #${tag}`}, ARRAY[${tag}]::text[], ${`images/2026/10/${id}.jpg`},
                ${JSON.stringify(meta)}::jsonb, ${JSON.stringify({ source: 'test' })}::jsonb, now(), now())
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

### Step 9: API integration tests
**File:** `tests/integration/api.int.test.ts:1` (new)
**Code:**
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STUB_REPLY } from '../../src/chat/stub.js';
import { generateId } from '../../src/notes/ids.js';
import type { Note } from '../../src/notes/types.js';
import { createApiHarness, uniqueTag, type ApiHarness } from './helpers/api-harness.js';
import { parseSse } from './helpers/sse.js';

interface ListResponse {
  notes: Note[];
  next_cursor: string | null;
}

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

async function listIds(query: string): Promise<string[]> {
  const res = await h.request(`/api/notes?${query}`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as ListResponse;
  return json.notes.map((n) => n.id);
}

describe('POST /api/notes', () => {
  it('creates a note with origin source web', async () => {
    const tag = uniqueTag();
    const res = await h.sendJson('POST', '/api/notes', { body: `hello #${tag}` });
    expect(res.status).toBe(201);
    const note = (await res.json()) as Note;
    expect(note.body).toBe(`hello #${tag}`);
    expect(note.tags).toContain(tag);
    expect(note.origin).toMatchObject({ source: 'web' });
  });

  it('allows an empty body', async () => {
    const res = await h.sendJson('POST', '/api/notes', { body: '' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Note).body).toBe('');
  });

  it('rejects a missing body and invalid json with {error}', async () => {
    const missing = await h.sendJson('POST', '/api/notes', {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toHaveProperty('error');
    const bad = await h.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_json' });
  });
});

describe('GET /api/notes/:id', () => {
  it('returns the note for canonical, lower-case and dashless ids', async () => {
    const note = await h.notes.create({ body: 'lookup', origin: null });
    for (const variant of [note.id, note.id.toLowerCase(), note.id.replace(/-/g, '').toLowerCase()]) {
      const res = await h.request(`/api/notes/${variant}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Note).id).toBe(note.id);
    }
  });

  it('400s a malformed id and 404s an unknown one', async () => {
    const bad = await h.request('/api/notes/!!!');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_id' });
    const missing = await h.request(`/api/notes/${generateId()}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('does not swallow image sub-paths', async () => {
    const note = await h.notes.create({ body: 'sub', origin: null });
    const res = await h.request(`/api/notes/${note.id}/thumb`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/notes/:id', () => {
  it('updates the body and re-parses tags', async () => {
    const tag = uniqueTag();
    const note = await h.notes.create({ body: 'before', origin: null });
    const res = await h.sendJson('PATCH', `/api/notes/${note.id.toLowerCase()}`, { body: `after #${tag}` });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Note;
    expect(updated.body).toBe(`after #${tag}`);
    expect(updated.tags).toEqual([tag]);
  });

  it('allows emptying the body', async () => {
    const note = await h.notes.create({ body: 'to empty', origin: null });
    const res = await h.sendJson('PATCH', `/api/notes/${note.id}`, { body: '' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Note).body).toBe('');
  });

  it('validates and 404s', async () => {
    const note = await h.notes.create({ body: 'x', origin: null });
    expect((await h.sendJson('PATCH', `/api/notes/${note.id}`, { body: 5 })).status).toBe(400);
    expect((await h.sendJson('PATCH', `/api/notes/${generateId()}`, { body: 'y' })).status).toBe(404);
  });
});

describe('DELETE /api/notes/:id', () => {
  it('soft-deletes, hides from get and list, and 404s a second delete', async () => {
    const tag = uniqueTag();
    const note = await h.notes.create({ body: `bye #${tag}`, origin: null });
    const res = await h.request(`/api/notes/${note.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const deleted = (await res.json()) as Note;
    expect(deleted.deleted_at).toBeTruthy();
    expect((await h.request(`/api/notes/${note.id}`)).status).toBe(404);
    expect(await listIds(`tag=${tag}`)).toEqual([]);
    expect((await h.request(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /api/notes', () => {
  it('lists newest first and paginates with an opaque cursor', async () => {
    const tag = uniqueTag();
    const a = await h.notes.create({ body: `one #${tag}`, origin: null });
    const b = await h.notes.create({ body: `two #${tag}`, origin: null });
    const c = await h.notes.create({ body: `three #${tag}`, origin: null });

    const first = await h.request(`/api/notes?tag=${tag}&limit=2`);
    const page1 = (await first.json()) as ListResponse;
    expect(page1.notes.map((n) => n.id)).toEqual([c.id, b.id]);
    expect(page1.next_cursor).toEqual(expect.any(String));

    const second = await h.request(
      `/api/notes?tag=${tag}&limit=2&cursor=${encodeURIComponent(page1.next_cursor as string)}`,
    );
    const page2 = (await second.json()) as ListResponse;
    expect(page2.notes.map((n) => n.id)).toEqual([a.id]);
    expect(page2.next_cursor).toBeNull();
  });

  it('applies repeated tag params with AND semantics, tolerating # and case', async () => {
    const u = uniqueTag();
    await h.notes.create({ body: `#${u} #alpha`, origin: null });
    await h.notes.create({ body: `#${u} #beta`, origin: null });
    const both = await h.notes.create({ body: `#${u} #alpha #beta`, origin: null });
    expect(await listIds(`tag=${u}&tag=alpha&tag=beta`)).toEqual([both.id]);
    expect(await listIds(`tag=%23${u.toUpperCase()}&tag=ALPHA&tag=beta`)).toEqual([both.id]);
    expect((await listIds(`tag=${u}`)).length).toBe(3);
  });

  it('filters by has_image: omitted = all, true = images only, false = text only', async () => {
    const tag = uniqueTag();
    const text = await h.notes.create({ body: `words #${tag}`, origin: null });
    const imageId = await h.insertImageNote(tag);

    expect(new Set(await listIds(`tag=${tag}`))).toEqual(new Set([text.id, imageId]));
    expect(await listIds(`tag=${tag}&has_image=true`)).toEqual([imageId]);
    expect(await listIds(`tag=${tag}&has_image=false`)).toEqual([text.id]);

    const res = await h.request(`/api/notes?tag=${tag}&has_image=true`);
    const [imageNote] = ((await res.json()) as ListResponse).notes;
    expect(imageNote.image).toMatchObject({ mime: 'image/jpeg', available: false });
  });

  it('rejects bad query params with {error}', async () => {
    for (const q of ['has_image=maybe', 'limit=0', 'limit=abc', 'limit=5001', 'cursor=%25%25garbage']) {
      const res = await h.request(`/api/notes?${q}`);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
  });

  it('defaults to returning many notes in one page', async () => {
    const res = await h.request('/api/notes');
    expect(res.status).toBe(200);
    const json = (await res.json()) as ListResponse;
    expect(Array.isArray(json.notes)).toBe(true);
    expect(json.notes.every((n) => !n.deleted_at)).toBe(true);
  });
});

describe('GET /api/tags', () => {
  it('returns tag, count and last_used', async () => {
    const tag = uniqueTag();
    await h.notes.create({ body: `#${tag} a`, origin: null });
    await h.notes.create({ body: `#${tag} b`, origin: null });
    const res = await h.request('/api/tags');
    expect(res.status).toBe(200);
    const tags = (await res.json()) as Array<{ tag: string; count: number; last_used: string }>;
    const entry = tags.find((t) => t.tag === tag);
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(2);
    expect(Number.isNaN(Date.parse(entry?.last_used ?? ''))).toBe(false);
  });
});

describe('POST /api/chat', () => {
  it('streams the stub reply as deltas then done with a new thread id', async () => {
    const res = await h.sendJson('POST', '/api/chat', { message: 'what did I save?' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const messages = parseSse(await res.text());
    const deltas = messages.filter((m) => m.event === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((m) => (m.data as { text: string }).text).join('')).toBe(STUB_REPLY);
    const last = messages[messages.length - 1];
    expect(last.event).toBe('done');
    expect((last.data as { thread_id: string }).thread_id).toMatch(/^stub-/);
  });

  it('echoes a given thread_id in done', async () => {
    const res = await h.sendJson('POST', '/api/chat', { message: 'again', thread_id: 'thread-42' });
    const messages = parseSse(await res.text());
    expect(messages[messages.length - 1]).toEqual({ event: 'done', data: { thread_id: 'thread-42' } });
  });

  it('rejects an empty message with a JSON {error} before streaming', async () => {
    for (const payload of [{}, { message: '   ' }, { message: 3 }]) {
      const res = await h.sendJson('POST', '/api/chat', payload);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(await res.json()).toHaveProperty('error');
    }
  });
});
```
**Note on `cursor=%25%25garbage`:** phase 2's `decodeCursor` throws `NoteError('invalid_input')` for a cursor it cannot decode; `noteErrorResponse` turns it into 400.

### Step 10: SSE integration tests
**File:** `tests/integration/events.int.test.ts:1` (new)
**Code:**
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness({ sseHeartbeatMs: 50 });
});

afterAll(async () => {
  await h.close();
});

describe('GET /api/events', () => {
  it('streams note events from service writes and unsubscribes on abort', async () => {
    const res = await h.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();

    await readUntil(reader, (t) => t.includes(': connected'));
    const listenersWhileOpen = h.events.listenerCount();
    expect(listenersWhileOpen).toBeGreaterThanOrEqual(1);

    const note = await h.notes.create({ body: 'live #sse', origin: null });
    const created = await readUntil(reader, (t) => t.includes(note.id));
    expect(parseSse(created)).toContainEqual({ event: 'note', data: { op: 'created', id: note.id } });

    await h.notes.update(note.id, 'live edited');
    const updated = await readUntil(reader, (t) => t.includes('"updated"'));
    expect(parseSse(updated)).toContainEqual({ event: 'note', data: { op: 'updated', id: note.id } });

    await h.notes.delete(note.id);
    const deleted = await readUntil(reader, (t) => t.includes('"deleted"'));
    expect(parseSse(deleted)).toContainEqual({ event: 'note', data: { op: 'deleted', id: note.id } });

    await reader.cancel();
    await waitFor(() => h.events.listenerCount() === listenersWhileOpen - 1);
  });

  it('sends heartbeat comments', async () => {
    const res = await h.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    const text = await readUntil(reader, (t) => t.includes(': heartbeat'), 2000);
    expect(text).toContain(': heartbeat');
    await reader.cancel();
  });

  it('sees writes made through the HTTP API too', async () => {
    const res = await h.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    const post = await h.sendJson('POST', '/api/notes', { body: 'from web' });
    const { id } = (await post.json()) as { id: string };
    const text = await readUntil(reader, (t) => t.includes(id));
    expect(parseSse(text)).toContainEqual({ event: 'note', data: { op: 'created', id } });
    await reader.cancel();
  });
});
```

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (adds `tests/unit/chat-stub.test.ts` and `tests/unit/static.test.ts`), then `npm run test:int` (adds `api.int.test.ts` and `events.int.test.ts` against `mcp-notes-pg-test`)
**Manual check (optional, never on port 7317):**
```bash
npm run build && NOTESD_PORT=7399 NOTES_DATA_DIR=$(mktemp -d) node dist/main.js &
curl -s localhost:7399/                       # 503 "web UI not built..." until phase 7 builds web/dist
curl -s localhost:7399/api/notes?has_image=false | head -c 300
curl -sN localhost:7399/api/events &          # leave open
curl -s -XPOST localhost:7399/api/notes -H 'content-type: application/json' -d '{"body":"hi #t"}'  # event appears in the stream
curl -sN -XPOST localhost:7399/api/chat -H 'content-type: application/json' -d '{"message":"hi"}'
curl -s localhost:7399/health ; curl -s -o /dev/null -w '%{http_code}\n' localhost:7399/api/nope   # 404, not html
```
Killing the `curl -sN .../api/events` process should drop the listener. To check, add a temporary log locally, or rely on the abort test.
**Exit criteria:** every route in the P6 contract (`GET/POST /api/notes`, `GET/PATCH/DELETE /api/notes/:id`, `GET /api/tags`, `GET /api/events`, `POST /api/chat`) and the static rules have a passing test. `has_image` is tested for omitted, `true` and `false`. `npm run typecheck`, `npm test` and `npm run test:int` are green.

## Handoffs

- **Phase 2 (resolved by the reconciler):** `app.ts` already calls `apiRoutes(deps)` and `staticRoutes(deps)` as factories; this plan uses P2's real service API (`getOne`, `create/update` with `allowEmpty`, `NoteError` codes, `list` with `tagsAll`/`hasImage`/`limit` ≤ 5000, `events.on` returning an unsubscribe).
- **Phase 1 (resolved):** `vitest.config.ts` sets `fileParallelism: !integration`, so integration files run serially.
- **Phase 5 (R2):** `imageRoutes` must register `/api/notes/:id/{original,display,thumb,preview}` and `POST /api/images`. `apiRoutes` registers no route for those paths. Its `/api/notes/:id` matches one segment only. That is covered by the "does not swallow image sub-paths" test.
- **Phase 7 (R3):** consumes the HTTP contract table above. Points to note: `GET /api/notes` returns `{ notes, next_cursor }`, not a bare array. Text-only mode (the default) is `?has_image=false`, images only is `?has_image=true`, and all omits the param. SSE starts with a `: connected` comment. Chat may end in `event: error` `{error}` instead of `done`. `POST /api/notes {body:''}` is how "+" creates a note.
- **Phase 8 (R3):** `/full/:id` serves `web/dist/fullscreen.html` once the Vite build emits it at the dist root (second input `fullscreen.html`). Until then it serves `index.html`.
- **Full-app mount test:** there is no `createApp` test in this phase, because its signature is phase 2's to define. A smoke test through `createApp` (GET `/api/nope` → 404 JSON-or-text, never HTML, and `/health` still OK with static mounted) would belong in phase 2's `app` tests or in a reconciliation fix-up.

## Rollback

Revert this phase's commit. That restores `src/http/api.ts` and `src/http/static.ts` to phase 2's empty router factories (which `app.ts` keeps calling) and deletes `src/chat/` and the six test files.
