> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/chat-bar-brain/PLAN.md` phase 1. Source: `.workflows/plan/chat-bar-brain/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Chat seam v2: status events, brain, config, daemon injection

**Plan set:** `docs/plans/CHAT_BAR_BRAIN_PLAN.md`
**Analysis:** `docs/analyzer/20261030-105357-UWUH_code_analyzer.md`
**Satisfies:** R3 (the `brain` field on the wire + `config.chat.brain`/`glm`), R4 (`event: status` on the wire), R6 (`/api/chat` int tests with an injected scripted fake backend)
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/chat`, `src/http`, `src` (+ `tests/unit`, `tests/integration`)

---

## Goal

The `ChatBackend` seam carries the contract from the plan index: a turn is an ordered stream of `delta`/`status` events plus an end-of-turn `{threadId, brain?}`. `POST /api/chat` sends `event: status` and an optional `brain` in `event: done`. `createApp` and `startDaemon` accept an injected backend (the stub stays the default), the daemon creates `<dataDir>/chat`, and `loadConfig()` returns a `chat` block. The integration harness can run `/api/chat` against a scripted fake backend, and the tests cover status ordering, brain, error and client abort.

## Interface Contract

**Deletes:** `ChatTurn.threadId` and `ChatTurn.deltas` (`src/chat/backend.ts:15-20`), replaced by `ChatTurn.events` + `ChatTurn.end()`.
**Renames:** none
**Creates:**
- `src/chat/backend.ts`: `ChatBrain`, `ChatEvent`, `ChatTurnEnd`. `ChatRequest`, `ChatTurn` and `ChatBackend` keep their names, but `ChatTurn` gets a new shape (byte-for-byte the index's Contract).
- `src/config.ts`: `ChatConfig`, `GlmConfig`, `DEFAULT_CHAT_MAX_TURNS = 24`, `DEFAULT_CHAT_TIMEOUT_MS = 180_000`, `DEFAULT_CLAUDE_BIN = 'claude'`, `DEFAULT_CHAT_CONFIG: ChatConfig`, and `Config.chat: ChatConfig` (required).
- `src/http/app.ts`: `CreateAppOptions { chat?: ChatBackend }`
- `src/daemon.ts`: `CHAT_SUBDIR = 'chat'`, `StartDaemonOptions { chat?: ChatBackend }`. `DATA_SUBDIRS` gains `'chat'`.
- `tests/integration/helpers/scripted-chat.ts`: `createScriptedChatBackend()`, `ScriptedChatBackend`, `ChatScript`, `ScriptStep`
- `tests/integration/helpers/api-harness.ts`: `ApiHarnessOptions.chat?: ChatBackend`

**Signature changes:**
- `createApp(deps: AppDeps): Hono` -> `createApp(deps: AppDeps, options: CreateAppOptions = {}): Hono`
- `startDaemon(config: Config): Promise<RunningDaemon>` -> `startDaemon(config: Config, options: StartDaemonOptions = {}): Promise<RunningDaemon>`
- `ChatTurn` shape (see Deletes/Creates)

**Exact shapes other phases consume:**

```ts
// src/chat/backend.ts (verbatim from the index Contract)
export type ChatBrain = 'claude' | 'glm';
export type ChatEvent = { type: 'delta'; text: string } | { type: 'status'; text: string };
export interface ChatTurnEnd { threadId: string; brain?: ChatBrain }
export interface ChatRequest { message: string; threadId: string | null; signal: AbortSignal }
export interface ChatTurn { events: AsyncIterable<ChatEvent>; end(): ChatTurnEnd }
export interface ChatBackend { reply(request: ChatRequest): Promise<ChatTurn> }

// src/config.ts
export interface GlmConfig { baseUrl: string; apiKey: string; model: string }
export interface ChatConfig {
  brain: ChatBrain          // CHAT_BRAIN, default 'claude'
  maxTurns: number          // CHAT_MAX_TURNS, default 24, integer >= 1
  timeoutMs: number         // CHAT_TIMEOUT_MS, default 180000, integer >= 1
  claudeBin: string         // NOTESD_CLAUDE_BIN, default 'claude' (bare name = PATH lookup; a path is ~-expanded and made absolute)
  glm: GlmConfig | null     // all three LLM_* set -> object; otherwise null
}
// Config gains: chat: ChatConfig

// src/daemon.ts
export const CHAT_SUBDIR = 'chat';                 // <dataDir>/chat, created at startup
export interface StartDaemonOptions { chat?: ChatBackend }
export async function startDaemon(config: Config, options?: StartDaemonOptions): Promise<RunningDaemon>

// src/http/app.ts
export interface CreateAppOptions { chat?: ChatBackend }
export function createApp(deps: AppDeps, options?: CreateAppOptions): Hono

// tests/integration/helpers/api-harness.ts
export interface ApiHarnessOptions { sseHeartbeatMs?: number; chat?: ChatBackend }
```

**Config rules:**
- `CHAT_BRAIN` is trimmed and lower-cased. Empty or unset gives `claude`. Anything other than `claude`/`glm` is a `ConfigError`.
- `CHAT_BRAIN=glm` with `glm === null` is a `ConfigError` that names the missing `LLM_*` keys.
- When `brain` is `claude` and the `LLM_*` keys are missing or partial, `glm` is `null`, which means no fallback.
- All keys are read from `.env.local` merged under the real env, the same as every other key.

**Wire (SSE) after this phase:**
- `event: delta {"text"}`
- `event: status {"text"}`, where `""` clears the caption
- `event: done {"thread_id", "brain"?}`. `brain` is present only when `end().brain !== undefined`.
- `event: error {"error"}`
- Nothing is written after a client abort.

**Requires (from earlier phases):** none.
**Leaves alone (owned by others):**
- `package.json`/`package-lock.json`, any `src/chat/agent*.ts`/`prompt.ts`/`status.ts`/`env.ts`, and the real-backend construction in `src/daemon.ts` (Phase 2)
- `web/**` (Phase 3)
- `deploy/**`, `scripts/**`, `vitest.config.ts`, `tests/live/**`, `docs/INSTALL.md` (Phase 4)

## Files

| File | Action | What changes |
|---|---|---|
| `src/chat/backend.ts:1-24` | rewrite | the Contract types |
| `src/chat/stub.ts:1-57` | rewrite | yields `ChatEvent` deltas, `end()` returns `{threadId}` (no brain) |
| `tests/unit/chat-stub.test.ts:1-53` | rewrite | follows the new seam; asserts there is no status and no brain |
| `src/http/api.ts:1-21, 191-219` | modify | import `ChatBrain`, option doc, `/api/chat` loop writes `status`, `done.brain` |
| `src/http/app.ts:1-6, 34-55` | modify | `CreateAppOptions`, passes `chat` to `apiRoutes` |
| `src/daemon.ts:1-78` | modify | `CHAT_SUBDIR` in `DATA_SUBDIRS`, `StartDaemonOptions`, stub default passed to `createApp` |
| `src/config.ts:1-132` | modify | `chat` block, parsers, defaults |
| `tests/unit/config.test.ts:6, 28-36, +new tests before line 111` | modify | defaults include `chat`, plus chat parsing tests |
| `tests/integration/helpers/scripted-chat.ts` | create | scripted fake `ChatBackend` |
| `tests/integration/helpers/api-harness.ts:7-48` | modify | `chat` option, `config.chat` in the literal |
| `tests/integration/api.int.test.ts:1-6, after 230` | modify | a new describe for the injected backend (status/brain/error/reject/abort) |
| `tests/integration/daemon.int.test.ts:1-58` | rewrite | `config.chat`, `chat` subdir, stub-by-default and injected-backend tests |
| `tests/integration/imageHarness.ts:33-34` | modify | `chat: DEFAULT_CHAT_CONFIG` in the `Config` literal (type fix only) |
| `tests/integration/mcp.tools.int.test.ts:9, 20` | modify | the same type fix |
| `tests/integration/images.int.test.ts:~120` | modify | the same type fix |

15 files.

## Implementation Steps

### Step 1: The seam contract
**File:** `src/chat/backend.ts:1-24` (whole file)
**Change:** Replace the whole file with the index's Contract and its docs.
**Code:**
```ts
/**
 * The chat brain seam. The HTTP layer (src/http/api.ts POST /api/chat) is the only consumer:
 * it writes each `ChatEvent` as an SSE event of the same name, then `event: done` with
 * `end()`, or `event: error` when `events` throws. Implementations: the stub
 * (src/chat/stub.ts) and the Agent SDK backend (src/chat/agent.ts, iteration 4).
 */

/** Which model family answered. The stub reports none. */
export type ChatBrain = 'claude' | 'glm';

export type ChatEvent =
  /** -> `event: delta {"text": "..."}`. Concatenated, the deltas are the full reply. */
  | { type: 'delta'; text: string }
  /** -> `event: status {"text": "searching notes"}`. `""` clears the caption. */
  | { type: 'status'; text: string };

export interface ChatTurnEnd {
  /** The thread this reply belongs to (new or continued). -> `done.thread_id`. */
  threadId: string;
  /** The brain that answered. -> `done.brain`; omitted from `done` when undefined. */
  brain?: ChatBrain;
}

export interface ChatRequest {
  /** The user's message, already trimmed and non-empty. */
  message: string;
  /** The thread the client wants to continue, or null to start a new one. */
  threadId: string | null;
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
**Impact:** This breaks `stub.ts`, `api.ts` and `chat-stub.test.ts` until Steps 2–4. All of them land in this phase.

### Step 2: The stub follows the seam
**File:** `src/chat/stub.ts:1-57` (whole file)
**Change:** The generator yields `{type:'delta', text}`. `end()` returns `{ threadId }` with no `brain`. The stub never emits `status`.
**Code:**
```ts
import { randomUUID } from 'node:crypto';
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

/** A fixed reply as word deltas. No status events, no brain: `done` carries only the thread id. */
export function createStubChatBackend(options: StubChatOptions = {}): ChatBackend {
  const delayMs = options.delayMs ?? 40;
  return {
    async reply(request: ChatRequest): Promise<ChatTurn> {
      const threadId = request.threadId ?? `stub-${randomUUID()}`;
      return {
        events: streamDeltas(splitIntoDeltas(STUB_REPLY), delayMs, request.signal),
        end: () => ({ threadId }),
      };
    },
  };
}
```
**Impact:** none outside the seam.

### Step 3: Stub unit test
**File:** `tests/unit/chat-stub.test.ts:1-53` (whole file)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../src/chat/backend.js';
import { STUB_REPLY, createStubChatBackend, splitIntoDeltas } from '../../src/chat/stub.js';

async function collect(iterable: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function texts(events: ChatEvent[]): string {
  return events.map((e) => e.text).join('');
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

  it('streams the fixed reply as delta events only and starts a new thread when none is given', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({
      message: 'hello',
      threadId: null,
      signal: new AbortController().signal,
    });
    const events = await collect(turn.events);
    expect(events.every((e) => e.type === 'delta')).toBe(true);
    expect(texts(events)).toBe(STUB_REPLY);
    expect(turn.end().threadId).toMatch(/^stub-/);
  });

  it('reports no brain', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({ message: 'hi', threadId: null, signal: new AbortController().signal });
    await collect(turn.events);
    const end = turn.end();
    expect(end.brain).toBeUndefined();
    expect('brain' in end).toBe(false);
  });

  it('keeps a given thread id', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({
      message: 'hello',
      threadId: 'thread-1',
      signal: new AbortController().signal,
    });
    await collect(turn.events);
    expect(turn.end()).toEqual({ threadId: 'thread-1' });
  });

  it('stops yielding after abort', async () => {
    const backend = createStubChatBackend({ delayMs: 5 });
    const controller = new AbortController();
    const turn = await backend.reply({ message: 'x', threadId: null, signal: controller.signal });
    const out: ChatEvent[] = [];
    for await (const event of turn.events) {
      out.push(event);
      if (out.length === 2) controller.abort();
    }
    expect(out).toHaveLength(2);
  });
});
```

### Step 4: `/api/chat` writes status and done.brain
**File:** `src/http/api.ts:4` (import), `:16-21` (`ApiOptions`), `:191-219` (handler)
**Change:** Import `ChatBrain` with the existing `ChatBackend` type import. Update the `ApiOptions.chat` doc. Rewrite the handler body's streaming loop.

Line 4 becomes:
```ts
import type { ChatBackend, ChatBrain, ChatEvent } from '../chat/backend.js';
```

Lines 16-21 become:
```ts
export interface ApiOptions {
  /** The chat brain. Defaults to the stub; the daemon passes its configured backend. */
  chat?: ChatBackend;
  /** Defaults to SSE_HEARTBEAT_MS. Tests pass a small value. */
  sseHeartbeatMs?: number;
}
```

Add this module-level helper right after `parseTagParams` (after line 85):
```ts
/** The SSE event name for a chat event. One per `ChatEvent` variant; both carry `{text}`. */
function chatEventName(event: ChatEvent): 'delta' | 'status' {
  switch (event.type) {
    case 'delta':
      return 'delta';
    case 'status':
      return 'status';
  }
}
```

Lines 191-219 (the whole `api.post('/api/chat', …)` registration) become:
```ts
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
**Impact:** The wire changes only by adding things. The existing stub int tests still pass: the stub emits only deltas, and `done` stays `{thread_id}`. `turn.end()` throwing is reported as `event: error`.

### Step 5: `createApp` accepts a chat backend
**File:** `src/http/app.ts:1-6` (imports), `:34-55` (doc + function)
**Change:** Add a type import of `ChatBackend`. Add `CreateAppOptions`, and pass `chat` through to `apiRoutes`. `undefined` falls back to the stub inside `apiRoutes`.

Add after line 1:
```ts
import type { ChatBackend } from '../chat/backend.js';
```

Lines 34-55 become:
```ts
export interface CreateAppOptions {
  /** The brain behind POST /api/chat. Omitted: apiRoutes' default (the stub). */
  chat?: ChatBackend;
}

/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), imageRoutes (P5), staticRoutes (P6, last: it owns the SPA fallback).
 */
export function createApp(deps: AppDeps, options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const toolDeps = { service: deps.service, dataDir: deps.config.dataDir, db: deps.db };

  app.get('/health', (c) => c.json({ ok: true, service: 'notesd' }));

  app.use('/mcp', loopbackOnly);
  app.post('/mcp', (c) => handleMcpRequest(c.req.raw, toolDeps));
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.route('/', apiRoutes(deps, { chat: options.chat }));
  app.route('/', imageRoutes(deps));
  app.route('/', staticRoutes(deps));
  return app;
}
```
**Impact:** Existing `createApp(deps)` callers (imageHarness, mcp.tools int test) compile unchanged.

### Step 6: `startDaemon` accepts a chat backend; `chat` data subdir
**File:** `src/daemon.ts` (whole file; changes at the imports, line 13 and lines 46-56)
**Code:**
```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { startBackground } from './background.js';
import type { ChatBackend } from './chat/backend.js';
import { createStubChatBackend } from './chat/stub.js';
import type { Config } from './config.js';
import { closeDb, createDb } from './db/client.js';
import type { AppDeps } from './deps.js';
import { createApp } from './http/app.js';
import { NoteEvents } from './notes/events.js';
import { NotesService } from './notes/service.js';

/** `<dataDir>/chat`: the fixed cwd of every chat brain run, so SDK sessions resume across restarts. */
export const CHAT_SUBDIR = 'chat';

export const DATA_SUBDIRS = ['images', 'cache', 'inbox', join('inbox', 'failed'), CHAT_SUBDIR] as const;

export interface RunningDaemon {
  deps: AppDeps;
  /** The bound port (useful when config.port is 0). */
  port: number;
  stop: () => Promise<void>;
}

export interface StartDaemonOptions {
  /** The brain behind POST /api/chat. Omitted: the stub (tests inject a scripted fake here). */
  chat?: ChatBackend;
}

export async function ensureDataDirs(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  for (const sub of DATA_SUBDIRS) await mkdir(join(dataDir, sub), { recursive: true });
}

function listen(server: ServerType): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

/** config -> data dirs -> db -> service -> chat -> app -> listen on loopback -> background jobs. */
export async function startDaemon(config: Config, options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  if (config.host !== '127.0.0.1') {
    throw new Error(`notesd binds 127.0.0.1 only (got host ${config.host}).`);
  }
  await ensureDataDirs(config.dataDir);
  const db = createDb(config.databaseUrl);
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir: config.dataDir, events });
  const deps: AppDeps = { config, db, events, service };
  const chat = options.chat ?? createStubChatBackend();
  const app = createApp(deps, { chat });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    await closeDb(db);
    throw err;
  }
  const stopBackground = await startBackground(deps);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await stopBackground();
      await closeServer(server);
      await closeDb(db);
    })();
    return stopping;
  };
  return { deps, port, stop };
}
```
**Impact:**
- `src/main.ts` is unchanged: `startDaemon(config)` still compiles.
- `const chat = options.chat ?? createStubChatBackend();` is the one line Phase 2 replaces with the real backend.
- `src/images/store.ts` has its own `ensureDataDirs`, which is not touched.

### Step 7: `config.chat`
**File:** `src/config.ts` (no semicolons, matching the file). The changes are at the imports (line 5), the constants (after line 17), `Config` (lines 19-28), new parsers (after `parseHost`, line 103), and the `loadConfig` doc and return (lines 105-132).

Add after line 5:
```ts
import type { ChatBrain } from './chat/backend.js'
```

Add after line 17 (`DEFAULT_DATA_DIR`):
```ts
export const DEFAULT_CHAT_MAX_TURNS = 24
export const DEFAULT_CHAT_TIMEOUT_MS = 180_000
/** A bare name is looked up on PATH by the SDK; the systemd unit sets an absolute path. */
export const DEFAULT_CLAUDE_BIN = 'claude'

/** The GLM endpoint for the fallback brain (z.ai), from `.env.local`'s `LLM_*` keys. */
export interface GlmConfig {
  /** `LLM_BASE_URL` -> the child's `ANTHROPIC_BASE_URL`. */
  baseUrl: string
  /** `LLM_API_KEY` -> the child's `ANTHROPIC_AUTH_TOKEN`. Never logged. */
  apiKey: string
  /** `LLM_MODEL`, e.g. `glm-5.3`. */
  model: string
}

export interface ChatConfig {
  /** `CHAT_BRAIN`, default `claude`. `glm` runs GLM only (no fallback). */
  brain: ChatBrain
  /** `CHAT_MAX_TURNS`, default 24. Integer >= 1. */
  maxTurns: number
  /** `CHAT_TIMEOUT_MS`, default 180000. Wall clock per chat message. Integer >= 1. */
  timeoutMs: number
  /** `NOTESD_CLAUDE_BIN`, default `claude`. A path is ~-expanded and made absolute. */
  claudeBin: string
  /** Set when all three `LLM_*` keys are; null otherwise (Claude runs then have no fallback). */
  glm: GlmConfig | null
}

/** What `loadConfig` returns for `chat` when no chat key is set. Tests build `Config` literals with it. */
export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  brain: 'claude',
  maxTurns: DEFAULT_CHAT_MAX_TURNS,
  timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  claudeBin: DEFAULT_CLAUDE_BIN,
  glm: null,
}
```

Lines 19-28 (`Config`) become:
```ts
export interface Config {
  /** Runtime connection string: the pooled Neon host in production (see `loadConfig`). */
  databaseUrl: string
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
  /** The chat bar brain (POST /api/chat). */
  chat: ChatConfig
}
```

Add after `parseHost` (after line 103):
```ts
function parseBrain(raw: string | undefined): ChatBrain {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'claude') return 'claude'
  if (value === 'glm') return 'glm'
  throw new ConfigError(`CHAT_BRAIN must be "claude" or "glm", got "${raw}"`)
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || !Number.isSafeInteger(Number(trimmed))) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`)
  }
  return Number(trimmed)
}

function parseClaudeBin(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_CLAUDE_BIN
  // A bare command name stays a PATH lookup; anything with a slash is a path.
  return value.includes('/') ? path.resolve(expandHome(value)) : value
}

const GLM_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const

function parseGlm(env: Record<string, string | undefined>): { glm: GlmConfig | null; missing: string[] } {
  const values = GLM_KEYS.map((key) => env[key]?.trim() ?? '')
  const missing = GLM_KEYS.filter((_, i) => values[i] === '')
  if (missing.length > 0) return { glm: null, missing }
  const [baseUrl = '', apiKey = '', model = ''] = values
  return { glm: { baseUrl, apiKey, model }, missing }
}

function parseChat(env: Record<string, string | undefined>): ChatConfig {
  const brain = parseBrain(env.CHAT_BRAIN)
  const { glm, missing } = parseGlm(env)
  if (brain === 'glm' && glm === null) {
    throw new ConfigError(
      `CHAT_BRAIN=glm needs ${missing.join(', ')} (set them in ${path.join(REPO_ROOT, '.env.local')}).`,
    )
  }
  return {
    brain,
    maxTurns: parsePositiveInt('CHAT_MAX_TURNS', env.CHAT_MAX_TURNS, DEFAULT_CHAT_MAX_TURNS),
    timeoutMs: parsePositiveInt('CHAT_TIMEOUT_MS', env.CHAT_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS),
    claudeBin: parseClaudeBin(env.NOTESD_CLAUDE_BIN),
    glm,
  }
}
```

Lines 105-132 (`loadConfig` doc + body) become:
```ts
/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Chat keys: CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS, NOTESD_CLAUDE_BIN, LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL. Unknown keys (OPENROUTER_API_KEY) are ignored.
 * Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port, on a non-loopback host, on a bad chat key, or on CHAT_BRAIN=glm without LLM_*.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fromFile = readEnvFile(options.envFile ?? path.join(REPO_ROOT, '.env.local'))
  const realEnv: Record<string, string | undefined> = options.env ?? process.env
  const env: Record<string, string | undefined> = { ...fromFile, ...realEnv }

  const databaseUrl = pickDatabaseUrl(realEnv, env)
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is not set. Put the Neon connection strings in ${path.join(REPO_ROOT, '.env.local')} ` +
        'or export DATABASE_URL.',
    )
  }

  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR

  return {
    databaseUrl,
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir: path.resolve(expandHome(dataDirRaw)),
    chat: parseChat(env),
  }
}
```
**Impact:**
- `Config.chat` is required, so every hand-built `Config` literal in tests needs `chat`. Steps 9 and 11–13 add it.
- `ConfigError` messages never echo `LLM_API_KEY`.
- The owner's `.env.local` has all three `LLM_*` keys, so the installed daemon gets `glm` non-null and the fallback becomes available once Phase 2 lands.

### Step 8: Config unit tests
**File:** `tests/unit/config.test.ts`
**Change:** Line 6 import gains `DEFAULT_CHAT_CONFIG`. In `applies defaults` (lines 28-36), the expected object gains `chat`. Append a new `describe('loadConfig chat', …)` after line 111, at the end of the file.

Line 6 becomes:
```ts
import { ConfigError, DEFAULT_CHAT_CONFIG, DEFAULT_PORT, loadConfig, REPO_ROOT } from '../../src/config.js'
```

Lines 28-36 become:
```ts
  it('applies defaults', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false })
    expect(cfg).toEqual({
      databaseUrl: URL_A,
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      dataDir: path.join(homedir(), 'mcp-notes-data'),
      chat: DEFAULT_CHAT_CONFIG,
    })
    expect(cfg.chat).toEqual({ brain: 'claude', maxTurns: 24, timeoutMs: 180_000, claudeBin: 'claude', glm: null })
  })
```

Append at end of file:
```ts
describe('loadConfig chat', () => {
  const GLM = { LLM_BASE_URL: 'https://api.z.ai/api/anthropic', LLM_API_KEY: 'k-123', LLM_MODEL: 'glm-5.3' }

  function chat(env: Record<string, string>) {
    return loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).chat
  }

  it('reads CHAT_BRAIN case-insensitively, default claude', () => {
    expect(chat({}).brain).toBe('claude')
    expect(chat({ CHAT_BRAIN: '' }).brain).toBe('claude')
    expect(chat({ CHAT_BRAIN: ' Claude ' }).brain).toBe('claude')
    expect(chat({ CHAT_BRAIN: 'GLM', ...GLM }).brain).toBe('glm')
  })

  it.each(['gpt', 'claude,glm', 'opus'])('rejects CHAT_BRAIN=%j', (brain) => {
    expect(() => chat({ CHAT_BRAIN: brain })).toThrow(/CHAT_BRAIN must be "claude" or "glm"/)
  })

  it('builds glm only when all three LLM_* keys are set', () => {
    expect(chat(GLM).glm).toEqual({ baseUrl: GLM.LLM_BASE_URL, apiKey: 'k-123', model: 'glm-5.3' })
    expect(chat({ LLM_API_KEY: 'k', LLM_MODEL: 'm' }).glm).toBeNull()
    expect(chat({ ...GLM, LLM_MODEL: '  ' }).glm).toBeNull()
  })

  it('reads LLM_* from the env file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-config-'))
    try {
      const file = path.join(dir, '.env.local')
      writeFileSync(file, `DATABASE_URL=${URL_A}\nLLM_BASE_URL=https://x\nLLM_API_KEY=k\nLLM_MODEL=glm-5.3\n`)
      expect(loadConfig({ env: {}, envFile: file }).chat.glm).toEqual({ baseUrl: 'https://x', apiKey: 'k', model: 'glm-5.3' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses CHAT_BRAIN=glm without the LLM_* keys and names the missing ones, not the key value', () => {
    expect(() => chat({ CHAT_BRAIN: 'glm' })).toThrow(ConfigError)
    expect(() => chat({ CHAT_BRAIN: 'glm', LLM_API_KEY: 'secret-key' })).toThrow(/LLM_BASE_URL, LLM_MODEL/)
    try {
      chat({ CHAT_BRAIN: 'glm', LLM_API_KEY: 'secret-key' })
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-key')
    }
  })

  it('parses CHAT_MAX_TURNS and CHAT_TIMEOUT_MS as positive integers', () => {
    expect(chat({ CHAT_MAX_TURNS: ' 8 ', CHAT_TIMEOUT_MS: '60000' })).toMatchObject({ maxTurns: 8, timeoutMs: 60_000 })
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      expect(() => chat({ CHAT_MAX_TURNS: bad })).toThrow(/CHAT_MAX_TURNS must be a positive integer/)
      expect(() => chat({ CHAT_TIMEOUT_MS: bad })).toThrow(/CHAT_TIMEOUT_MS must be a positive integer/)
    }
  })

  it('keeps a bare NOTESD_CLAUDE_BIN as a PATH name and resolves a path', () => {
    expect(chat({ NOTESD_CLAUDE_BIN: 'claude' }).claudeBin).toBe('claude')
    expect(chat({ NOTESD_CLAUDE_BIN: '/opt/node/bin/claude' }).claudeBin).toBe('/opt/node/bin/claude')
    expect(chat({ NOTESD_CLAUDE_BIN: '~/tools/bin/claude' }).claudeBin).toBe(path.join(homedir(), 'tools', 'bin', 'claude'))
  })
})
```

### Step 9: Scripted fake backend for integration tests
**File:** `tests/integration/helpers/scripted-chat.ts` (create)
**Code:**
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
  /** What `end()` returns. Default: `{ threadId: request.threadId ?? 'fake-thread' }` (no brain). */
  end?: ChatTurnEnd;
  /** When set, `reply()` itself rejects with this message before any event. */
  rejectWith?: string;
}

export interface ScriptedChatBackend extends ChatBackend {
  /** Queues a script for the next `reply()`. A reply with nothing queued gets an empty script. */
  push(script: ChatScript): void;
  /** Every request received, in arrival order (signals included, so tests can see aborts). */
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
      const end: ChatTurnEnd = script.end ?? { threadId: request.threadId ?? 'fake-thread' };
      return { events: play(script.steps, request.signal), end: () => end };
    },
  };
}
```

### Step 10: API harness accepts an injected backend
**File:** `tests/integration/helpers/api-harness.ts:7-48`
**Change:**
- Add imports for `ChatBackend` and `DEFAULT_CHAT_CONFIG`.
- Add a `chat` option.
- Add `chat: DEFAULT_CHAT_CONFIG` to the `Config` literal.
- Use the injected backend, falling back to the 0-delay stub.

Lines 7-9 become:
```ts
import type { ChatBackend } from '../../../src/chat/backend.js';
import { createStubChatBackend } from '../../../src/chat/stub.js';
import { DEFAULT_CHAT_CONFIG } from '../../../src/config.js';
import type { AppDeps } from '../../../src/deps.js';
import { apiRoutes } from '../../../src/http/api.js';
```

Lines 25-27 become:
```ts
export interface ApiHarnessOptions {
  sseHeartbeatMs?: number;
  /** The chat backend behind /api/chat. Default: the stub with no delay. */
  chat?: ChatBackend;
}
```

Lines 34-48 become:
```ts
export async function createApiHarness(options: ApiHarnessOptions = {}): Promise<ApiHarness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-api-'));
  const db = openTestDb();
  const events = new NoteEvents();
  const notes = new NotesService({ db, events, dataDir });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG },
    db,
    events,
    service: notes,
  };
  const app = new Hono();
  app.route(
    '/',
    apiRoutes(deps, {
      chat: options.chat ?? createStubChatBackend({ delayMs: 0 }),
      ...(options.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: options.sseHeartbeatMs } : {}),
    }),
  );
```
The rest of the file (the returned object, lines 50-87) is unchanged.

### Step 11: `/api/chat` integration tests with the fake
**File:** `tests/integration/api.int.test.ts`
**Change:** Extend the imports (lines 1-6). Append a new describe after the existing `describe('POST /api/chat', …)` (after line 230, at the end of the file). The existing stub tests (lines 202-230) stay unchanged and keep passing.

Lines 1-6 become:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STUB_REPLY } from '../../src/chat/stub.js';
import { generateId } from '../../src/notes/ids.js';
import type { Note } from '../../src/notes/types.js';
import { createApiHarness, uniqueTag, type ApiHarness } from './helpers/api-harness.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';
```

Append at end of file:
```ts
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

  it('streams status and delta events in backend order, then done with thread_id and brain', async () => {
    fake.push({
      steps: [
        { type: 'status', text: 'searching notes' },
        { type: 'status', text: 'reading 3 notes' },
        { type: 'status', text: '' },
        { type: 'delta', text: 'You saved ' },
        { type: 'delta', text: 'A-B32.' },
      ],
      end: { threadId: 'sess-1', brain: 'claude' },
    });
    const messages = await chat({ message: 'what did I save?' });
    expect(messages).toEqual([
      { event: 'status', data: { text: 'searching notes' } },
      { event: 'status', data: { text: 'reading 3 notes' } },
      { event: 'status', data: { text: '' } },
      { event: 'delta', data: { text: 'You saved ' } },
      { event: 'delta', data: { text: 'A-B32.' } },
      { event: 'done', data: { thread_id: 'sess-1', brain: 'claude' } },
    ]);
    const req = fake.requests.at(-1);
    expect(req?.message).toBe('what did I save?');
    expect(req?.threadId).toBeNull();
  });

  it('passes thread_id to the backend and reports the thread and brain the backend ended with', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'ok' }], end: { threadId: 'sess-2', brain: 'glm' } });
    const messages = await chat({ message: 'and last month?', thread_id: 'sess-1' });
    expect(fake.requests.at(-1)?.threadId).toBe('sess-1');
    expect(messages.at(-1)).toEqual({ event: 'done', data: { thread_id: 'sess-2', brain: 'glm' } });
  });

  it('omits brain from done when the backend reports none', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'hi' }], end: { threadId: 'sess-3' } });
    const messages = await chat({ message: 'hi' });
    const done = messages.at(-1);
    expect(done).toEqual({ event: 'done', data: { thread_id: 'sess-3' } });
    expect(done?.data).not.toHaveProperty('brain');
  });

  it('sends event: error and no done when the events stream throws mid-turn', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'partial ' }, { type: 'throw', message: 'usage limit reached' }] });
    const messages = await chat({ message: 'x' });
    expect(messages).toEqual([
      { event: 'delta', data: { text: 'partial ' } },
      { event: 'error', data: { error: 'usage limit reached' } },
    ]);
  });

  it('sends event: error when reply() itself rejects', async () => {
    fake.push({ steps: [], rejectWith: 'claude not found' });
    const messages = await chat({ message: 'x' });
    expect(messages).toEqual([{ event: 'error', data: { error: 'claude not found' } }]);
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
    expect(parseSse(text)[0]).toEqual({ event: 'delta', data: { text: 'first ' } });
    const req = fake.requests.at(-1);
    expect(req?.message).toBe('slow one');
    expect(req?.signal.aborted).toBe(false);
    await reader.cancel();
    await waitFor(() => req?.signal.aborted === true);
  });
});
```
**Impact:** This needs `parseSse`, `readUntil` and `waitFor`, which already exist in `helpers/sse.ts`. Cancelling a reader on the in-process `app.request` body reaches `stream.onAbort`, because hono's `StreamingApi` readable `cancel` calls `abort()` (`node_modules/hono/dist/utils/stream.js:33`).

### Step 12: Daemon integration test
**File:** `tests/integration/daemon.int.test.ts` (whole file)
**Change:**
- `Config` literals gain `chat`.
- The subdir list gains `chat`.
- Two new tests: the stub serves `/api/chat` by default over real HTTP, and an injected backend is used.
**Code:**
```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_CONFIG, type Config } from '../../src/config.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { createScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse } from './helpers/sse.js';
import { testDatabaseUrl } from './setup.js';

const url = testDatabaseUrl();

const dataDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
let daemon: RunningDaemon;

function config(dir: string): Config {
  return { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG };
}

async function postChat(port: number, message: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

beforeAll(async () => {
  // Port 0: never the installed daemon's 7317.
  daemon = await startDaemon(config(dataDir));
});

afterAll(async () => {
  await daemon.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('startDaemon', () => {
  it('creates the data dirs, including the chat cwd', () => {
    for (const sub of ['images', 'cache', 'inbox', 'inbox/failed', 'chat']) expect(existsSync(join(dataDir, sub))).toBe(true);
  });

  it('listens on 127.0.0.1 and answers /health', async () => {
    expect(daemon.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'notesd' });
  });

  it('answers an MCP initialize over real HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string }; instructions?: string } };
    expect(body.result?.serverInfo?.name).toBe('mcp-notes');
    expect(body.result?.instructions).toContain('A-B32');
  });

  it('serves the stub chat backend when none is injected', async () => {
    const messages = await postChat(daemon.port, 'hello');
    expect(messages.every((m) => m.event === 'delta' || m.event === 'done')).toBe(true);
    expect(messages.at(-1)?.event).toBe('done');
    expect((messages.at(-1)?.data as { thread_id: string }).thread_id).toMatch(/^stub-/);
  });

  it('serves an injected chat backend', async () => {
    const otherDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
    const fake = createScriptedChatBackend();
    fake.push({
      steps: [{ type: 'status', text: 'searching notes' }, { type: 'delta', text: 'injected' }],
      end: { threadId: 'sess-d', brain: 'claude' },
    });
    const other = await startDaemon(config(otherDir), { chat: fake });
    try {
      expect(await postChat(other.port, 'hi')).toEqual([
        { event: 'status', data: { text: 'searching notes' } },
        { event: 'delta', data: { text: 'injected' } },
        { event: 'done', data: { thread_id: 'sess-d', brain: 'claude' } },
      ]);
      expect(fake.requests).toHaveLength(1);
    } finally {
      await other.stop();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('refuses a non-loopback host', async () => {
    // Config types host as the literal '127.0.0.1'; the cast simulates a hand-built bad config.
    const bad = { ...config(dataDir), host: '0.0.0.0' } as unknown as Config;
    await expect(startDaemon(bad)).rejects.toThrow(/127\.0\.0\.1/);
  });
});
```

### Step 13: Type-only fixes in other integration files
The `Config` literals need `chat` now that it is required. No behaviour changes.

**File:** `tests/integration/imageHarness.ts:33-34`
Add an import beside the existing `AppDeps` import:
```ts
import { DEFAULT_CHAT_CONFIG } from '../../src/config.js';
```
and the `config` line in the `deps` literal becomes:
```ts
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG },
```

**File:** `tests/integration/mcp.tools.int.test.ts:9, 20`
Line 9 becomes:
```ts
import { DEFAULT_CHAT_CONFIG, type Config } from '../../src/config.js';
```
Line 20 becomes:
```ts
const config: Config = { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG };
```

**File:** `tests/integration/images.int.test.ts:~120` (inside `describe('inbox via startBackground')`)
Add `import { DEFAULT_CHAT_CONFIG } from '../../src/config.js';` with the other `../../src/*` imports. The `config:` line becomes:
```ts
      config: { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG },
```

Before finishing, run a sweep: `grep -rn "host: '127.0.0.1'" tests src`. Every `Config`/`AppDeps.config` literal it finds must carry `chat`. `npm run typecheck` is the backstop.

## Verification

**Build:** `npm run typecheck && npm run build:server`
**Tests:** `npm test` (unit: `chat-stub`, `config`) and `npm run test:int` (`api.int`, `daemon.int`, plus the whole integration suite for the type-fixed files)
**Manual check:**
- `grep -rn "deltas\|turn.threadId" src tests` returns nothing.
- `npm run dev`, then `curl -N -X POST localhost:7317/api/chat -H 'content-type: application/json' -d '{"message":"hi"}'` (or a test port) still streams the stub, and `done` has no `brain`.

**Exit criteria:** The contract types in `src/chat/backend.ts` match the index's Contract verbatim and compile. The stub unit tests pass. `api.int.test.ts` covers status ordering, `done.brain` present and absent, a mid-stream error, a `reply()` rejection, and client abort reaching `request.signal`, all through `/api/chat` with the scripted fake. `daemon.int.test.ts` proves the stub is the default and that an injected backend is used. `loadConfig()` returns `chat` per the Decisions table. All three gates are green.

## Handoffs

- **Phase 2 (R1/R2/R3):** Replace `const chat = options.chat ?? createStubChatBackend();` in `src/daemon.ts` with the real backend built from `config.chat`.
  - **Port:** the MCP url needs the bound port, but `createApp(deps, { chat })` runs before `listen()`. Phase 2 has two options. It can build the backend with a lazily read url (for example a `() => string` getter, or a mutable `let port` captured by the backend, which is only read inside `reply()`). Or it can build the backend after `listen()` and route through a small forwarding `ChatBackend`.
  - **cwd:** use `join(config.dataDir, CHAT_SUBDIR)` (exported from `src/daemon.ts`).
  - **Tests:** after that swap, `daemon.int.test.ts`'s "serves the stub chat backend when none is injected" would spawn the real SDK. Phase 2 owns the fix (its Step 6e, with code): the shared `beforeAll` daemon gets `createStubChatBackend({ delayMs: 0 })` injected, that test becomes "serves an injected stub over real HTTP", and a new test starts/stops a daemon on the default backend without posting. This phase writes Step 12 as shown; Phase 2 edits from that exact text.
- **Phase 2 (R6):** It may reuse `tests/integration/helpers/scripted-chat.ts` for anything integration-level. Its backend unit tests fake `query`, not `ChatBackend`, so they do not need it.
- **Phase 3 (R3/R4):** The wire contract is final after this phase:
  - `event: status {"text"}`, where `""` clears.
  - `event: done {"thread_id", "brain"?: "claude"|"glm"}`.
  - The stub sends neither status nor brain, so in dev the panel shows no label.
- **Phase 4 (R5):** The config key for the binary is `NOTESD_CLAUDE_BIN`. A value containing `/` is resolved to an absolute path, and a bare name is left for a PATH lookup. `CHAT_BRAIN`, `CHAT_MAX_TURNS` and `CHAT_TIMEOUT_MS` are optional env keys that it may document in `docs/INSTALL.md`.
- **Not done here (scope):** `src/main.ts` still calls `startDaemon(config)` with no options, which is intended. No change to `web/`.

## Rollback

`git revert <phase-1 commit>`. Nothing outside the repo changes. The `<dataDir>/chat` directory that a running dev daemon may have created is empty and harmless. Phases 2 and 3 depend on this contract and must be reverted first if they have landed.
