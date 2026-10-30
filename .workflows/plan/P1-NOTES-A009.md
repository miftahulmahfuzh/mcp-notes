> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/chat-bar-brain/PLAN.md` phase 2. Source: `.workflows/plan/chat-bar-brain/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Agent SDK backend: Claude, GLM, fallback, threads, guardrails

**Plan set:** `CHAT_BAR_BRAIN_PLAN.md`
**Analysis:** `docs/analyzer/20261030-105357-UWUH_code_analyzer.md`
**Satisfies:** R1, R2, R3, R4, R6. The chat bar gets a real brain: Claude through the Agent SDK on the owner's login, streamed, with tool captions, resumable threads, a one-shot GLM fallback, and guardrails. All of it is covered by unit tests against a fake `query`.
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/chat`

---

## Goal

After this phase `startDaemon(config)` serves `POST /api/chat` from a real `ChatBackend` built on `@anthropic-ai/claude-agent-sdk@0.3.311`. The backend has these properties:

- One SDK run per message, against the daemon's own `/mcp`.
- The run is isolated from the owner's settings, hooks, plugins and other MCP servers.
- It streams top-level text as `delta` and tool use as `status` captions.
- It resumes `thread_id` as an SDK session.
- It stops on client abort, on a newer `reply()`, on wall-clock timeout and at max turns.
- It retries once on GLM after a pre-text Claude auth or usage-limit failure, or runs GLM only when `CHAT_BRAIN=glm`.

The stub stays in the tree for tests and for callers that inject it.

## Interface Contract

**Deletes:** nothing. (`src/daemon.ts` stops importing `createStubChatBackend`. The stub itself stays: `src/http/api.ts` and the int-test harness still use it.)
**Renames:** none
**Creates:**
- `src/chat/agent.ts`: `createAgentChatBackend(options: AgentChatOptions): AgentChatBackend`, plus `interface AgentChatOptions`, `interface AgentChatBackend extends ChatBackend { close(): void }`, `type QueryFn`, `type AgentChatConfig = Config['chat']`, and the constants `FALLBACK_ERRORS` and `FALLBACK_TEXT`
- `src/chat/prompt.ts`: `buildChatSystemPrompt(now?: Date, timeZone?: string): string`
- `src/chat/status.ts`: `NOTES_MCP_SERVER`, `NOTES_TOOL_NAMES`, `WEB_TOOL_NAMES`, `allowedChatTools(): string[]`, `captionForToolUse(name: string, input: unknown): string | null`
- `src/chat/env.ts`: `ChildEnv`, `GlmTarget`, `STRIPPED_ENV_KEYS` (key/base-url/model overrides plus the parent-session markers `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`), `STRIPPED_ENV_PREFIX = 'CLAUDE_CODE_'`, `CLIENT_APP`, `claudeEnv(base)`, `glmEnv(base, glm)`, `resolveExecutable(bin, pathEnv)`
- Tests: `tests/unit/chat-agent.test.ts`, `tests/unit/chat-status.test.ts`, `tests/unit/chat-env.test.ts`, `tests/unit/chat-prompt.test.ts`
- Dependencies: `@anthropic-ai/claude-agent-sdk` `0.3.311`, `@anthropic-ai/sdk` `0.135.0`, both exact

**Signature changes:** none of mine. `startDaemon(config, options?)` keeps Phase 1's signature. Only its *default* changes: no `options.chat` now means the real agent backend instead of the stub.
**Requires (from earlier phases):**
- Phase 1, `src/chat/backend.ts`: exactly the Contract in the index (`ChatBrain`, `ChatEvent`, `ChatTurnEnd`, `ChatRequest`, `ChatTurn { events; end() }`, `ChatBackend`).
- Phase 1, `src/config.ts`: `Config.chat` is a **required** field shaped `{ brain: 'claude'|'glm'; maxTurns: number; timeoutMs: number; claudeBin: string; glm: { baseUrl: string; apiKey: string; model: string } | null }`. I reference it only as `Config['chat']`, so the name of any exported alias does not matter.
- Phase 1, `src/daemon.ts`: `DATA_SUBDIRS` contains `'chat'`, so `<dataDir>/chat` exists before the first run. Also `startDaemon(config, options: { chat?: ChatBackend } = {})` and `createApp(deps, { chat })`.
- Phase 1, `src/http/api.ts`: it iterates `turn.events` and calls `turn.end()` only after a clean finish. If a throw arrives while `request.signal.aborted` is true, it ends the stream silently. Otherwise it sends `event: error` with `err.message`.
- Phase 1, `src/daemon.ts`: exports `CHAT_SUBDIR = 'chat'` and `StartDaemonOptions { chat?: ChatBackend }`, and `startDaemon` contains exactly the line `const chat = options.chat ?? createStubChatBackend();` followed by `const app = createApp(deps, { chat });`. Step 6 edits from that text.
- Phase 1: `tests/integration/daemon.int.test.ts` builds its `Config` literals with `chat: DEFAULT_CHAT_CONFIG`, its shared `beforeAll` daemon is started with no `chat` option, and its test "serves the stub chat backend when none is injected" posts to `/api/chat`. After this phase that default is the real agent, so Step 6e (below) changes that file: the shared daemon gets the stub injected, and the default-backend test asserts construction without a post. This phase owns that edit.

**Leaves alone (owned by others):** `src/chat/backend.ts` contract shape, `src/chat/stub.ts`, `src/http/*`, `src/config.ts` (Phase 1); `web/` (Phase 3); `deploy/`, `scripts/`, `vitest.config.ts`, `tests/live/`, `docs/INSTALL.md`, the `test:live` script (Phase 4).

## Files

| File | Action | What changes |
|---|---|---|
| `package.json` (`dependencies`, lines 9–24 today) | modify | add `@anthropic-ai/claude-agent-sdk` `0.3.311` and `@anthropic-ai/sdk` `0.135.0` |
| `package-lock.json` | modify | regenerated by `npm install` |
| `src/chat/status.ts` | create | tool names, allow-list, tool_use → caption |
| `src/chat/env.ts` | create | child env for claude/glm, executable resolution |
| `src/chat/prompt.ts` | create | system prompt with date, time, tz |
| `src/chat/agent.ts` | create | `createAgentChatBackend` |
| `src/daemon.ts` (as Phase 1 Step 6 leaves it: imports, `StartDaemonOptions` doc, the `const chat = …` line, `stop`) | modify | build the agent backend when no `chat` option is given; lazy MCP url; close on stop |
| `tests/integration/daemon.int.test.ts` (as Phase 1 Step 12 leaves it) | modify | shared daemon gets the stub injected; the stub-by-default test becomes an agent-by-default construction test |
| `tests/unit/chat-status.test.ts` | create | caption table, allow-list |
| `tests/unit/chat-env.test.ts` | create | env stripping, glm env, PATH lookup |
| `tests/unit/chat-prompt.test.ts` | create | prompt content, date/tz |
| `tests/unit/chat-agent.test.ts` | create | the backend against a fake `query` |

## Design notes (read before the steps)

- **SDK types used** (checked against `sdk.d.ts` of 0.3.311):
  - `query({ prompt, options }): Query`, where `Query extends AsyncGenerator<SDKMessage, void>`.
  - `Options` fields: `abortController`, `cwd`, `env` (it *replaces* the child env), `includePartialMessages`, `maxTurns`, `mcpServers`, `model`, `pathToClaudeCodeExecutable`, `permissionMode` (`'dontAsk'`), `resume`, `settingSources`, `strictMcpConfig`, `systemPrompt` (a plain string means a custom prompt), `tools`, `allowedTools`.
  - Message variants: `type: 'stream_event'` (`SDKPartialAssistantMessage`, `event: BetaRawMessageStreamEvent`, `parent_tool_use_id`), `type: 'assistant'` (`message: BetaMessage`, `parent_tool_use_id`, `error?: SDKAssistantMessageError`), and `type: 'result'`. The last is either `SDKResultSuccess` (`subtype: 'success'`, `is_error`, `result: string`, `session_id`) or `SDKResultError` (`subtype: 'error_max_turns' | 'error_during_execution' | …`, `errors: string[]`, `session_id`).
  - The `type` discriminants `'stream_event'`, `'assistant'` and `'result'` belong only to those types, so narrowing is safe.
- **`McpHttpServerConfig.alwaysLoad: true`** is added on top of the index's `{type:'http', url}`. By default Claude Code defers MCP tools behind ToolSearch, and `tools: ['WebSearch','WebFetch']` leaves ToolSearch out of the base set. Without `alwaysLoad` the notes tools could be unreachable. Setting it also makes the run wait (max 5 s) until `/mcp` connects, which it always does on loopback. The index's Decisions "SDK isolation" row now includes it.
- **Thread id** comes from the `result` message's `session_id` of the attempt that succeeded. The `system/init` message is not needed, because every `result` carries `session_id`. `end()` returns `{ threadId, brain }`.
- **Aborts all surface as a throw** from `events`. Stop reasons are `client`, `superseded`, `timeout` and `closed`, each with its own message. When the client disconnected, `request.signal` is aborted and Phase 1's api.ts stays silent. A supersede or timeout reaches the client as `event: error` with a readable message.
- **Fallback window.** The first attempt (Claude) fails with an `AttemptError` whose `fallbackable` is true. That flag is set when the last top-level `assistant.error` is in `FALLBACK_ERRORS`, or when the failure text matches `FALLBACK_TEXT`. The retry happens only if `chat.glm !== null`, no `delta` has been emitted, and no stop reason is set. Then the same message runs once on GLM with the same `resume`. Max-turns failures are never fallbackable. With `brain === 'glm'` there is never a retry.
- **Paragraph join.** Top-level text deltas stream as-is. A delta that arrives after a `tool_use`, when text was already emitted, is prefixed with `"\n\n"` (its own leading whitespace is trimmed). The first delta after a non-empty caption is preceded by `status ""`.
- **The child process is never left running.** If iteration of an attempt ends early (throw, consumer `return()`), the attempt's own `AbortController` is aborted in `finally`. A clean drain does not abort. The loop does not break on `result`: it drains until the CLI exits, so the session transcript is fully flushed for later `resume`.

## Implementation Steps

### Step 1: Add the SDK dependencies
**File:** `package.json:9` (`"dependencies"` block)
**Change:** run, from the worktree root:

```bash
npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.311 @anthropic-ai/sdk@0.135.0
```

The resulting `dependencies` block must read:

```json
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.311",
    "@anthropic-ai/sdk": "0.135.0",
    "@hono/node-server": "2.1.5",
    "@modelcontextprotocol/sdk": "1.32.2",
    "@neondatabase/serverless": "1.1.0",
    "chokidar": "6.0.0",
    "dotenv": "17.4.2",
    "drizzle-orm": "0.45.2",
    "exifr": "7.1.3",
    "file-type": "22.3.0",
    "heic-convert": "2.1.0",
    "hono": "4.13.14",
    "pg": "8.23.1",
    "sharp": "0.35.3",
    "ws": "8.22.0",
    "zod": "4.4.3"
  },
```

**Impact:**
- `@anthropic-ai/sdk@0.135.0` (published 2026-10-15) satisfies the peer `>=0.93.0`. It provides `resources/beta/messages/messages.mjs` with `BetaRawMessageStreamEvent`, `BetaMessage` and `BetaToolUseBlock`, which `sdk.d.ts` imports (verified in the 0.135.0 tarball). 1.x is newer than two weeks, and 0.136/0.137 are newer than two weeks too.
- The other peers are already satisfied: `zod` 4.4.3 and `@modelcontextprotocol/sdk` 1.32.2.
- npm also installs the optional `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.311` native binary. It is unused, because the backend always passes `pathToClaudeCodeExecutable`, but it is harmless. Do not pass `--omit=optional`.

### Step 2: Tool names and status captions
**File:** `src/chat/status.ts` (new)
**Code:**
```ts
/**
 * The chat agent's tool surface and the terse captions the answer panel shows while a tool runs.
 * Tool names match src/mcp/tools.ts and src/mcp/imageTools.ts. Claude Code exposes them as
 * `mcp__notes__<name>` because the daemon registers its MCP server under the name `notes`.
 */
export const NOTES_MCP_SERVER = 'notes';

export const NOTES_TOOL_NAMES = [
  'create',
  'get',
  'update',
  'append',
  'delete',
  'restore',
  'list',
  'search',
  'tags',
  'revisions',
  'revert',
  'create_image',
  'view_images',
] as const;

export type NotesToolName = (typeof NOTES_TOOL_NAMES)[number];

export const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;

const MCP_PREFIX = `mcp__${NOTES_MCP_SERVER}__`;

/** Exactly the 13 notes tools plus WebSearch and WebFetch (plan invariant 4). */
export function allowedChatTools(): string[] {
  return [...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`), ...WEB_TOOL_NAMES];
}

function idCount(input: unknown): number | null {
  if (typeof input !== 'object' || input === null) return null;
  const ids = (input as { ids?: unknown }).ids;
  return Array.isArray(ids) ? ids.length : null;
}

function counted(n: number | null, one: string, many: (n: number) => string, unknown: string): string {
  if (n === 1) return one;
  if (n !== null && n > 1) return many(n);
  return unknown;
}

/**
 * The caption for one top-level `tool_use` block, or null for a tool the panel does not name.
 * `input` is the block's raw input; only `ids` (get, view_images) is read.
 */
export function captionForToolUse(name: string, input: unknown): string | null {
  if (name === 'WebSearch') return 'searching the web';
  if (name === 'WebFetch') return 'reading a web page';
  if (!name.startsWith(MCP_PREFIX)) return null;
  switch (name.slice(MCP_PREFIX.length)) {
    case 'search':
    case 'list':
    case 'tags':
      return 'searching notes';
    case 'get':
      return counted(idCount(input), 'reading a note', (n) => `reading ${n} notes`, 'reading notes');
    case 'view_images':
      return counted(idCount(input), 'looking at a photo', (n) => `looking at ${n} photos`, 'looking at photos');
    case 'revisions':
      return 'reading history';
    case 'create':
    case 'create_image':
      return 'saving a note';
    case 'update':
    case 'append':
    case 'revert':
      return 'editing a note';
    case 'delete':
      return 'deleting a note';
    case 'restore':
      return 'restoring a note';
    default:
      return null;
  }
}
```
**Impact:** new module, no callers yet.

### Step 3: Child environment and executable lookup
**File:** `src/chat/env.ts` (new)
**Code:**
```ts
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** The SDK's `options.env` shape. It replaces the child's environment wholesale. */
export type ChildEnv = Record<string, string | undefined>;

export interface GlmTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Never inherited by an SDK child. A Claude run must use the owner's OAuth login, never a key or
 * a redirected base URL (plan invariant 3). The model overrides are dropped so a GLM model name
 * can never reach Anthropic. LLM_API_KEY is dropped in case someone exported it.
 * CLAUDECODE, CLAUDE_PID and CLAUDE_EFFORT are the markers a parent Claude Code session exports
 * to its shell: a daemon started from a Claude Code terminal (`npm run dev`, the live suite)
 * would otherwise hand them to the child, which then believes it is nested in that session.
 */
export const STRIPPED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'LLM_API_KEY',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

/**
 * Every `CLAUDE_CODE_*` key is dropped too: the parent session's markers (CLAUDE_CODE_ENTRYPOINT,
 * CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_EXECPATH, ...), its
 * CLAUDE_CODE_PLUGIN_DIRS (plugins would break invariant 4), and provider switches such as
 * CLAUDE_CODE_USE_BEDROCK (which would bypass the login, invariant 3). CLAUDE_CONFIG_DIR is kept:
 * it is where the login lives when the owner moved it.
 */
export const STRIPPED_ENV_PREFIX = 'CLAUDE_CODE_';

function isStripped(key: string): boolean {
  return STRIPPED_ENV_KEYS.includes(key) || key.startsWith(STRIPPED_ENV_PREFIX);
}

/** Sent in the SDK's User-Agent so these runs are recognisable. */
export const CLIENT_APP = 'mcp-notes-chat/0.1.0';

function baseChildEnv(base: NodeJS.ProcessEnv): ChildEnv {
  const env: ChildEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isStripped(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
  return env;
}

/** Env for a Claude run: the daemon's env (PATH, HOME, ...) minus every key/base-url/model override. */
export function claudeEnv(base: NodeJS.ProcessEnv): ChildEnv {
  return baseChildEnv(base);
}

/** Env for a GLM run: the same code pointed at an Anthropic-compatible endpoint. */
export function glmEnv(base: NodeJS.ProcessEnv, glm: GlmTarget): ChildEnv {
  return {
    ...baseChildEnv(base),
    ANTHROPIC_BASE_URL: glm.baseUrl,
    ANTHROPIC_AUTH_TOKEN: glm.apiKey,
    ANTHROPIC_MODEL: glm.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: glm.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: glm.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: glm.model,
  };
}

/**
 * Absolute path for `bin`. A path containing "/" is resolved against the cwd. A bare name
 * ("claude", the config default) is looked up on `pathEnv`. When nothing is found the name
 * comes back unchanged, and the SDK's own "executable not found" error names it.
 */
export function resolveExecutable(bin: string, pathEnv: string | undefined): string {
  if (bin.includes('/')) return path.resolve(bin);
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; try the next PATH entry
    }
  }
  return bin;
}
```
**Impact:** new module. `GlmTarget` is structurally identical to `NonNullable<Config['chat']['glm']>` from Phase 1, so the config value passes straight in.

### Step 4: System prompt
**File:** `src/chat/prompt.ts` (new)
**Code:**
```ts
import { localTimeZone } from '../mcp/instructions.js';

function part(now: Date, timeZone: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(now);
}

/**
 * The chat agent's whole system prompt (it replaces Claude Code's default prompt). It is built
 * per run so "today" is always current. The notes MCP server adds its own instructions about
 * tools, ids and dates on top.
 */
export function buildChatSystemPrompt(now: Date = new Date(), timeZone: string = localTimeZone()): string {
  const isoDate = part(now, timeZone, 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = part(now, timeZone, 'en-US', { weekday: 'long' });
  const longDate = part(now, timeZone, 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const time = part(now, timeZone, 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  const sections = [
    `You are the chat bar of mcp-notes, the personal note store of the person typing to you. They are the owner of every note in it, and you answer only them. A note is a plain-text body with #hashtag tags written into it; some notes are image notes (photos and screenshots). You reach the notes only through the notes tools (mcp__notes__*). You may also use WebSearch and WebFetch when the owner asks about something outside their notes.`,

    `Today is ${weekday} ${isoDate} (${longDate}), ${time} in ${timeZone}. Resolve relative dates such as "today", "this week", "last week", "last month" or "30 oct" against that date in that timezone; weeks start on Monday. When a notes tool takes a date, pass YYYY-MM-DD; the server reads it in ${timeZone}.`,

    `Whenever you use a note, quote its id in your answer exactly in the form A-B32: one character, a dash, three characters, upper case. The page highlights notes by finding those ids in your answer text, so every note you relied on must appear by id. Never invent an id.`,

    `You may change notes when the owner asks: edit, append, tag, untag, delete or restore. To tag a note, write the #hashtag into its body. Read a note with get before you update it, and send the whole new body. Do not create a note unless the owner asks for one, and never save your own answer as a note.`,

    `To look at pictures, find the image notes first (list with has_image, or search), then call view_images with their ids and comment on what you actually see.`,

    `Write plain prose for a small panel: short paragraphs separated by one blank line. No markdown headings, no tables, no bold or italics, no code blocks unless the owner asks for code. Use a list only when the owner asks for one. Answer first, then the supporting detail. If the notes do not hold the answer, say so plainly.`,
  ];
  return sections.join('\n\n');
}
```
**Impact:** new module. It reuses `localTimeZone` from `src/mcp/instructions.ts:2`, which is unchanged.

### Step 5: The backend
**File:** `src/chat/agent.ts` (new)
**Code:**
```ts
import {
  query as sdkQuery,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { ChatBackend, ChatBrain, ChatEvent, ChatRequest, ChatTurn, ChatTurnEnd } from './backend.js';
import { claudeEnv, glmEnv, resolveExecutable } from './env.js';
import { buildChatSystemPrompt } from './prompt.js';
import { NOTES_MCP_SERVER, WEB_TOOL_NAMES, allowedChatTools, captionForToolUse } from './status.js';

/** `config.chat` from Phase 1's loadConfig. */
export type AgentChatConfig = Config['chat'];

/** The slice of the SDK's `query` the backend uses. Tests inject a fake. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

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
}

export interface AgentChatBackend extends ChatBackend {
  /** Stops the in-flight run, if any (daemon shutdown). */
  close(): void;
}

/** `SDKAssistantMessage.error` values that mean "this login cannot answer right now". */
export const FALLBACK_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set<SDKAssistantMessageError>([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'rate_limit',
]);

/** Error text that names a usage limit or an auth problem. */
export const FALLBACK_TEXT =
  /usage limit|limit reached|rate.?limit|credit balance|billing|not logged in|\/login|authenticat|oauth|invalid api key|unauthori[sz]ed|\b(401|403|429)\b/i;

type StopReason = 'client' | 'superseded' | 'timeout' | 'closed';

class AttemptError extends Error {
  override name = 'AttemptError';
  constructor(
    message: string,
    readonly fallbackable: boolean,
  ) {
    super(message);
  }
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function stopMessage(reason: StopReason, timeoutMs: number): string {
  switch (reason) {
    case 'client':
      return 'Chat stopped: the request was closed.';
    case 'superseded':
      return 'Chat stopped: a newer message replaced this one.';
    case 'timeout':
      return `Chat stopped: no answer within ${formatDuration(timeoutMs)}.`;
    case 'closed':
      return 'Chat stopped: notesd is shutting down.';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFallbackable(text: string, lastError: SDKAssistantMessageError | null): boolean {
  return (lastError !== null && FALLBACK_ERRORS.has(lastError)) || FALLBACK_TEXT.test(text);
}

function resultFailure(
  message: SDKResultMessage,
  lastError: SDKAssistantMessageError | null,
  maxTurns: number,
): AttemptError {
  if (message.subtype === 'error_max_turns') {
    return new AttemptError(
      `Chat stopped: the agent hit its ${maxTurns}-turn cap before finishing. Try a narrower question.`,
      false,
    );
  }
  const text =
    message.subtype === 'success'
      ? message.result.trim() || 'The agent failed without saying why.'
      : message.errors.join('; ').trim() || `The agent failed (${message.subtype}).`;
  return new AttemptError(text, isFallbackable(text, lastError));
}

interface RunDeps {
  chat: AgentChatConfig;
  query: QueryFn;
  log: (line: string) => void;
  optionsFor: (brain: ChatBrain, resume: string | null, abortController: AbortController) => Options;
}

/** One `reply()`: up to two SDK attempts (claude, then glm) behind one event stream. */
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

  constructor(
    private readonly deps: RunDeps,
    private readonly request: ChatRequest,
  ) {
    this.timer = setTimeout(() => this.stop('timeout'), deps.chat.timeoutMs);
    this.timer.unref();
    if (request.signal.aborted) this.stop('client');
    else request.signal.addEventListener('abort', this.onClientAbort, { once: true });
  }

  get active(): boolean {
    return !this.finished;
  }

  stop(reason: StopReason): void {
    if (this.finished || this.reason !== null) return;
    this.reason = reason;
    this.controller.abort(reason);
  }

  end(): ChatTurnEnd {
    if (this.outcome === null) throw new Error('ChatTurn.end() called before events finished cleanly');
    return this.outcome;
  }

  async *events(): AsyncGenerator<ChatEvent> {
    try {
      yield* this.runWithFallback();
    } catch (err) {
      if (this.reason !== null) throw new Error(stopMessage(this.reason, this.deps.chat.timeoutMs));
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    this.finished = true;
    clearTimeout(this.timer);
    this.request.signal.removeEventListener('abort', this.onClientAbort);
  }

  private async *runWithFallback(): AsyncGenerator<ChatEvent> {
    const first = this.deps.chat.brain;
    try {
      yield* this.attempt(first);
      return;
    } catch (err) {
      if (!this.canFallBack(first, err)) throw err;
      this.deps.log(`notesd chat: claude failed before answering (${errorText(err)}); retrying once on glm`);
    }
    if (this.caption !== '') {
      this.caption = '';
      yield { type: 'status', text: '' };
    }
    yield* this.attempt('glm');
  }

  private canFallBack(brain: ChatBrain, err: unknown): boolean {
    return (
      brain === 'claude' &&
      this.deps.chat.glm !== null &&
      err instanceof AttemptError &&
      err.fallbackable &&
      !this.emittedText &&
      this.reason === null
    );
  }

  private async *attempt(brain: ChatBrain): AsyncGenerator<ChatEvent> {
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
        prompt: this.request.message,
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
}

/**
 * The real chat brain: one Claude Agent SDK run per message (plan R1-R4).
 * Single user, so at most one run is in flight; a new reply() stops the previous one.
 */
export function createAgentChatBackend(options: AgentChatOptions): AgentChatBackend {
  const { chat, cwd, mcpUrl } = options;
  const query: QueryFn = options.query ?? sdkQuery;
  const now = options.now ?? (() => new Date());
  const baseEnv = options.baseEnv ?? process.env;
  const log = options.log ?? ((line: string) => console.warn(line));
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

  const deps: RunDeps = { chat, query, log, optionsFor };
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

**Notes on the code (for the implementer, not for the file):**
- `optionsFor` runs inside `attempt`'s `try`, so a `mcpUrl()` throw (daemon not listening) or the GLM-null `AttemptError` becomes `event: error`.
- `ChatRun.events()` is lazy. Nothing spawns until Phase 1's api.ts starts iterating, but the timeout clock starts at `reply()`.
- Phase 1's api.ts receives the plain `Error` for a stop. When the client disconnected it does not send it, because `request.signal.aborted` is true. When the reason was supersede, timeout or shutdown, it sends `event: error`.
- `if (this.reason !== null) break;` stops yielding at once after a stop, even if the SDK still has buffered messages. The `finally` then aborts the child, because `drained` stays false.

**Impact:** new module. Nothing calls it until Step 6.

### Step 6: Daemon builds the real backend
**File:** `src/daemon.ts`, exactly as Phase 1 Step 6 leaves it. Four edits; everything else in the file (including `CHAT_SUBDIR`, `DATA_SUBDIRS`, `RunningDaemon`, `ensureDataDirs`, `listen`, `closeServer`, the host guard) stays as Phase 1 wrote it.
**Change:**
- Swap the stub import for the agent import.
- Update the `StartDaemonOptions.chat` doc.
- When `options.chat` is undefined, build the agent backend with `cwd = join(config.dataDir, CHAT_SUBDIR)` and a lazy `mcpUrl` getter that reads the port bound by `listen`.
- Record the bound port after `listen`, and call `agent?.close()` first in `stop`.

**Edit 6a — imports.** Phase 1's lines
```ts
import type { ChatBackend } from './chat/backend.js';
import { createStubChatBackend } from './chat/stub.js';
```
become
```ts
import { createAgentChatBackend, type AgentChatBackend } from './chat/agent.js';
import type { ChatBackend } from './chat/backend.js';
```

**Edit 6b — `StartDaemonOptions`.** Phase 1's
```ts
export interface StartDaemonOptions {
  /** The brain behind POST /api/chat. Omitted: the stub (tests inject a scripted fake here). */
  chat?: ChatBackend;
}
```
becomes
```ts
export interface StartDaemonOptions {
  /** The brain behind POST /api/chat. Omitted: the Agent SDK backend built from config.chat (tests inject the stub or a scripted fake). */
  chat?: ChatBackend;
}
```

**Edit 6c — build the backend.** Phase 1's two lines
```ts
  const chat = options.chat ?? createStubChatBackend();
  const app = createApp(deps, { chat });
```
become
```ts
  // The agent reaches notes through this daemon's own /mcp. The port is known only after
  // listen() (config.port may be 0), and the first chat run can only start after that.
  let boundPort: number | null = null;
  let agent: AgentChatBackend | null = null;
  let chat: ChatBackend;
  if (options.chat !== undefined) {
    chat = options.chat;
  } else {
    agent = createAgentChatBackend({
      chat: config.chat,
      cwd: join(config.dataDir, CHAT_SUBDIR),
      mcpUrl: () => {
        if (boundPort === null) throw new Error('notesd is not listening yet.');
        return `http://${config.host}:${boundPort}/mcp`;
      },
    });
    chat = agent;
  }
  const app = createApp(deps, { chat });
```

**Edit 6d — bound port and shutdown.** Phase 1's
```ts
  const stopBackground = await startBackground(deps);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await stopBackground();
```
becomes
```ts
  boundPort = port;
  const stopBackground = await startBackground(deps);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      agent?.close();
      await stopBackground();
```

**Resulting `startDaemon`** (for reading; the four edits above are the change):
```ts
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

  // The agent reaches notes through this daemon's own /mcp. The port is known only after
  // listen() (config.port may be 0), and the first chat run can only start after that.
  let boundPort: number | null = null;
  let agent: AgentChatBackend | null = null;
  let chat: ChatBackend;
  if (options.chat !== undefined) {
    chat = options.chat;
  } else {
    agent = createAgentChatBackend({
      chat: config.chat,
      cwd: join(config.dataDir, CHAT_SUBDIR),
      mcpUrl: () => {
        if (boundPort === null) throw new Error('notesd is not listening yet.');
        return `http://${config.host}:${boundPort}/mcp`;
      },
    });
    chat = agent;
  }
  const app = createApp(deps, { chat });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    await closeDb(db);
    throw err;
  }
  boundPort = port;
  const stopBackground = await startBackground(deps);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      agent?.close();
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
- `config.host` is always `'127.0.0.1'`, which the guard enforces, so the url is `http://127.0.0.1:<port>/mcp` and passes `/mcp`'s `loopbackOnly` guard.
- `src/main.ts` calls `startDaemon(config)` unchanged and now gets the real brain.
- `src/daemon.ts` no longer imports the stub. The stub stays exported for `src/http/api.ts`'s default, the int harness, `daemon.int.test.ts` (Step 6e) and Phase 4's live suite.
- `tests/integration/daemon.int.test.ts` would now spawn a real `claude` from its "serves the stub chat backend when none is injected" test. Step 6e fixes that in this phase.

### Step 6e: `daemon.int.test.ts` no longer chats with the default backend
**File:** `tests/integration/daemon.int.test.ts`, exactly as Phase 1 Step 12 leaves it. Three edits. The test file never spawns `claude`: the shared daemon gets the stub injected, and the one daemon started without a `chat` option is only started and stopped (the agent backend spawns nothing until `reply()`).

**Edit 1 — imports.** Phase 1's
```ts
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
```
becomes
```ts
import { createStubChatBackend } from '../../src/chat/stub.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
```

**Edit 2 — shared daemon.** Phase 1's
```ts
beforeAll(async () => {
  // Port 0: never the installed daemon's 7317.
  daemon = await startDaemon(config(dataDir));
});
```
becomes
```ts
beforeAll(async () => {
  // Port 0: never the installed daemon's 7317. The stub is injected: the default backend is the
  // real Agent SDK, and these tests must never spawn claude.
  daemon = await startDaemon(config(dataDir), { chat: createStubChatBackend({ delayMs: 0 }) });
});
```

**Edit 3 — the default-backend test.** Phase 1's
```ts
  it('serves the stub chat backend when none is injected', async () => {
    const messages = await postChat(daemon.port, 'hello');
    expect(messages.every((m) => m.event === 'delta' || m.event === 'done')).toBe(true);
    expect(messages.at(-1)?.event).toBe('done');
    expect((messages.at(-1)?.data as { thread_id: string }).thread_id).toMatch(/^stub-/);
  });
```
becomes
```ts
  it('serves an injected stub over real HTTP', async () => {
    const messages = await postChat(daemon.port, 'hello');
    expect(messages.every((m) => m.event === 'delta' || m.event === 'done')).toBe(true);
    expect(messages.at(-1)?.event).toBe('done');
    expect((messages.at(-1)?.data as { thread_id: string }).thread_id).toMatch(/^stub-/);
  });

  it('starts and stops with the default (Agent SDK) backend without spawning anything', async () => {
    // No chat option: startDaemon builds createAgentChatBackend. Nothing is posted, so no claude runs.
    const plainDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
    const plain = await startDaemon(config(plainDir));
    try {
      expect(plain.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${plain.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await plain.stop();
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
```
The "serves an injected chat backend" and "refuses a non-loopback host" tests stay as Phase 1 wrote them (the latter throws before any backend is built).

### Step 7: Status and allow-list tests
**File:** `tests/unit/chat-status.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { NOTES_TOOL_NAMES, allowedChatTools, captionForToolUse } from '../../src/chat/status.js';

const n = (name: string): string => `mcp__notes__${name}`;

describe('allowedChatTools', () => {
  it('is exactly the 13 notes tools plus WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(13);
    expect(tools).toHaveLength(15);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });
});

describe('captionForToolUse', () => {
  it.each([
    [n('search'), {}, 'searching notes'],
    [n('list'), {}, 'searching notes'],
    [n('tags'), {}, 'searching notes'],
    [n('get'), { ids: ['A-B32'] }, 'reading a note'],
    [n('get'), { ids: ['A-B32', 'B-C43', 'C-D54'] }, 'reading 3 notes'],
    [n('get'), {}, 'reading notes'],
    [n('view_images'), { ids: ['A-B32'] }, 'looking at a photo'],
    [n('view_images'), { ids: ['A-B32', 'B-C43', 'C-D54', 'D-E65'] }, 'looking at 4 photos'],
    [n('view_images'), null, 'looking at photos'],
    [n('revisions'), {}, 'reading history'],
    [n('create'), {}, 'saving a note'],
    [n('create_image'), {}, 'saving a note'],
    [n('update'), {}, 'editing a note'],
    [n('append'), {}, 'editing a note'],
    [n('revert'), {}, 'editing a note'],
    [n('delete'), {}, 'deleting a note'],
    [n('restore'), {}, 'restoring a note'],
    ['WebSearch', { query: 'Verity' }, 'searching the web'],
    ['WebFetch', { url: 'https://example.com' }, 'reading a web page'],
  ])('%s %j -> %s', (name, input, caption) => {
    expect(captionForToolUse(name, input)).toBe(caption);
  });

  it('names nothing outside the surface', () => {
    expect(captionForToolUse('Bash', { command: 'ls' })).toBeNull();
    expect(captionForToolUse('mcp__other__search', {})).toBeNull();
    expect(captionForToolUse(n('unknown'), {})).toBeNull();
  });
});
```

### Step 8: Env tests
**File:** `tests/unit/chat-env.test.ts` (new)
**Code:**
```ts
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_APP, claudeEnv, glmEnv, resolveExecutable } from '../../src/chat/env.js';

const BASE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/owner',
  ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  ANTHROPIC_AUTH_TOKEN: 'tok-should-not-leak',
  ANTHROPIC_MODEL: 'glm-5.3',
  LLM_API_KEY: 'glm-should-not-leak',
};

const GLM = { baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'glm-key', model: 'glm-5.3' };

describe('claudeEnv', () => {
  it('keeps PATH and HOME and strips every key, base url and model override', () => {
    const env = claudeEnv(BASE);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/owner');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(CLIENT_APP);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'LLM_API_KEY']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('does not mutate its input', () => {
    claudeEnv(BASE);
    expect(BASE.ANTHROPIC_API_KEY).toBe('sk-ant-should-not-leak');
  });

  it('drops the markers of a parent Claude Code session but keeps CLAUDE_CONFIG_DIR', () => {
    const env = claudeEnv({
      ...BASE,
      CLAUDECODE: '1',
      CLAUDE_PID: '4242',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_PLUGIN_DIRS: '/home/owner/plugins',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/home/owner/.claude',
    });
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_PLUGIN_DIRS',
      'CLAUDE_CODE_USE_BEDROCK',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/owner/.claude');
    expect(glmEnv({ ...BASE, CLAUDECODE: '1' }, GLM)).not.toHaveProperty('CLAUDECODE');
  });
});

describe('glmEnv', () => {
  it('points the child at the GLM endpoint with the GLM token and model', () => {
    const env = glmEnv(BASE, GLM);
    expect(env.ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    expect(env.ANTHROPIC_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('LLM_API_KEY');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });
});

describe('resolveExecutable', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('finds a bare name on PATH', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chat-env-'));
    dirs.push(dir);
    const bin = path.join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    expect(resolveExecutable('claude', `/nonexistent${path.delimiter}${dir}`)).toBe(bin);
  });

  it('keeps an absolute path', () => {
    expect(resolveExecutable('/opt/claude/bin/claude', '/usr/bin')).toBe('/opt/claude/bin/claude');
  });

  it('returns the bare name when nothing on PATH matches', () => {
    expect(resolveExecutable('claude-not-installed-here', '/nonexistent')).toBe('claude-not-installed-here');
  });
});
```

### Step 9: Prompt tests
**File:** `tests/unit/chat-prompt.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { buildChatSystemPrompt } from '../../src/chat/prompt.js';

describe('buildChatSystemPrompt', () => {
  // 2026-10-29T18:30Z is already Friday 30 October, 01:30, in Jakarta (UTC+7).
  const prompt = buildChatSystemPrompt(new Date('2026-10-29T18:30:00Z'), 'Asia/Jakarta');

  it("states today's date, time and timezone in the owner's zone", () => {
    expect(prompt).toContain('Friday 2026-10-30');
    expect(prompt).toContain('30 October 2026');
    expect(prompt).toContain('01:30 in Asia/Jakarta');
  });

  it('says what mcp-notes is and who is typing', () => {
    expect(prompt).toContain('mcp-notes');
    expect(prompt).toMatch(/owner of every note/);
  });

  it('requires note ids quoted as A-B32', () => {
    expect(prompt).toContain('A-B32');
    expect(prompt).toMatch(/quote its id/);
  });

  it('asks for plain prose without headings or tables', () => {
    expect(prompt).toMatch(/plain prose/);
    expect(prompt).toMatch(/No markdown headings, no tables/);
  });

  it('forbids saving the answer as a note', () => {
    expect(prompt).toMatch(/never save your own answer as a note/);
  });

  it('uses the daemon timezone by default', () => {
    expect(buildChatSystemPrompt(new Date('2026-10-30T03:00:00Z'))).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });
});
```

### Step 10: Backend tests against a fake `query`
**File:** `tests/unit/chat-agent.test.ts` (new)
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  createAgentChatBackend,
  type AgentChatConfig,
  type QueryFn,
} from '../../src/chat/agent.js';
import type { ChatEvent, ChatRequest, ChatTurn } from '../../src/chat/backend.js';
import { allowedChatTools } from '../../src/chat/status.js';

// ---------- fake SDK messages ----------

const SESSION = 'sess-claude-1';

function textDelta(text: string, parent: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: SESSION,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  } as unknown as SDKMessage;
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}, parent: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: SESSION,
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    ...extra,
  } as unknown as SDKMessage;
}

function toolUse(name: string, input: unknown, parent: string | null = null): SDKMessage {
  return assistant([{ type: 'tool_use', id: `toolu_${randomUUID()}`, name, input }], {}, parent);
}

function assistantError(error: string, text: string): SDKMessage {
  return assistant([{ type: 'text', text }], { error });
}

function success(sessionId = SESSION): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: sessionId,
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

function errorResult(text: string, sessionId = SESSION): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: text,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: sessionId,
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

function maxTurnsResult(sessionId = SESSION): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    errors: [],
    num_turns: 24,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: sessionId,
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

// ---------- fake query ----------

type Script = (options: Options) => AsyncGenerator<SDKMessage>;

function scripted(messages: SDKMessage[]): Script {
  return async function* () {
    for (const m of messages) yield m;
  };
}

/** Yields `before`, then waits for the run's abort, then throws like the SDK does. */
function hangs(before: SDKMessage[]): Script {
  return async function* (options) {
    for (const m of before) yield m;
    const signal = options.abortController?.signal;
    if (!signal) throw new Error('fake query: no abortController passed');
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const err = new Error('Claude Code process aborted by user');
    err.name = 'AbortError';
    throw err;
  };
}

function throwsAfter(before: SDKMessage[], message: string): Script {
  return async function* () {
    for (const m of before) yield m;
    throw new Error(message);
  };
}

function fakeQuery(...scripts: Script[]): { query: QueryFn; calls: { prompt: string; options: Options }[] } {
  const calls: { prompt: string; options: Options }[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const script = scripts[calls.length - 1];
    if (!script) throw new Error(`fake query: unexpected call #${calls.length}`);
    return script(params.options);
  };
  return { query, calls };
}

function optionsOf(calls: { options: Options }[], i: number): Options {
  const call = calls[i];
  if (!call) throw new Error(`no query call #${i}`);
  return call.options;
}

// ---------- backend under test ----------

const GLM = { baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'glm-key', model: 'glm-5.3' };
const CHAT: AgentChatConfig = { brain: 'claude', maxTurns: 24, timeoutMs: 180_000, claudeBin: '/opt/claude/bin/claude', glm: GLM };
const MCP_URL = 'http://127.0.0.1:7317/mcp';

function backend(query: QueryFn, chat: Partial<AgentChatConfig> = {}) {
  return createAgentChatBackend({
    chat: { ...CHAT, ...chat },
    cwd: '/data/chat',
    mcpUrl: () => MCP_URL,
    query,
    now: () => new Date('2026-10-30T03:00:00Z'),
    baseEnv: { PATH: '/usr/bin', HOME: '/home/owner', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak' },
    log: () => {},
  });
}

function req(message: string, threadId: string | null = null, signal = new AbortController().signal): ChatRequest {
  return { message, threadId, signal };
}

async function collect(turn: ChatTurn): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of turn.events) out.push(e);
  return out;
}

async function collectUntilError(turn: ChatTurn): Promise<{ events: ChatEvent[]; error: Error }> {
  const events: ChatEvent[] = [];
  try {
    for await (const e of turn.events) events.push(e);
  } catch (err) {
    return { events, error: err as Error };
  }
  throw new Error('expected the turn to fail');
}

const deltas = (events: ChatEvent[]): string =>
  events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

// ---------- tests ----------

describe('agent chat backend: streaming', () => {
  it('streams top-level text deltas in order and reports the session as the thread', async () => {
    const { query } = fakeQuery(
      scripted([textDelta('You saved '), textDelta('A-B32 '), textDelta('sub', 'toolu_sub'), textDelta('on Monday.'), success()]),
    );
    const turn = await backend(query).reply(req('what did i save?'));
    const events = await collect(turn);
    expect(events).toEqual([
      { type: 'delta', text: 'You saved ' },
      { type: 'delta', text: 'A-B32 ' },
      { type: 'delta', text: 'on Monday.' },
    ]);
    expect(turn.end()).toEqual({ threadId: SESSION, brain: 'claude' });
  });

  it('passes note ids through untouched', async () => {
    const { query } = fakeQuery(scripted([textDelta('See A-B32 and 7-QX0.'), success()]));
    const turn = await backend(query).reply(req('ids'));
    expect(deltas(await collect(turn))).toBe('See A-B32 and 7-QX0.');
  });

  it('end() refuses before the events finished', async () => {
    const { query } = fakeQuery(scripted([success()]));
    const turn = await backend(query).reply(req('x'));
    expect(() => turn.end()).toThrow(/before events finished/);
  });

  it('fails when the agent ends without a result', async () => {
    const { query } = fakeQuery(scripted([textDelta('half')]));
    const { error } = await collectUntilError(await backend(query).reply(req('x')));
    expect(error.message).toMatch(/without an answer/);
  });
});

describe('agent chat backend: status captions', () => {
  it('maps tool_use to captions, clears them when text resumes, and starts a new paragraph after a tool', async () => {
    const { query } = fakeQuery(
      scripted([
        textDelta('Let me look.'),
        toolUse('mcp__notes__search', { query: 'seer' }),
        toolUse('mcp__notes__search', { query: 'seer week' }),
        toolUse('mcp__notes__get', { ids: ['A-B32', 'B-C43', 'C-D54'] }),
        toolUse('Read', { file_path: '/etc/passwd' }, 'toolu_sub'),
        textDelta(' Found A-B32.'),
        toolUse('mcp__notes__view_images', { ids: ['A-B32', 'B-C43', 'C-D54', 'D-E65'] }),
        toolUse('WebSearch', { query: 'Verity' }),
        textDelta('Done.'),
        success(),
      ]),
    );
    const events = await collect(await backend(query).reply(req('summarize #seer')));
    expect(events).toEqual([
      { type: 'delta', text: 'Let me look.' },
      { type: 'status', text: 'searching notes' },
      { type: 'status', text: 'reading 3 notes' },
      { type: 'status', text: '' },
      { type: 'delta', text: '\n\nFound A-B32.' },
      { type: 'status', text: 'looking at 4 photos' },
      { type: 'status', text: 'searching the web' },
      { type: 'status', text: '' },
      { type: 'delta', text: '\n\nDone.' },
    ]);
  });

  it('does not add a paragraph break before the first text', async () => {
    const { query } = fakeQuery(
      scripted([toolUse('mcp__notes__list', {}), textDelta('Nothing this week.'), success()]),
    );
    const events = await collect(await backend(query).reply(req('this week?')));
    expect(events).toEqual([
      { type: 'status', text: 'searching notes' },
      { type: 'status', text: '' },
      { type: 'delta', text: 'Nothing this week.' },
    ]);
  });
});

describe('agent chat backend: run options', () => {
  it('isolates the run to the notes MCP server plus web tools, on the owner login', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    await collect(await backend(query).reply(req('hello')));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe('hello');
    const o = optionsOf(calls, 0);
    expect(o.cwd).toBe('/data/chat');
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({ notes: { type: 'http', url: MCP_URL, alwaysLoad: true } });
    expect(o.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(o.allowedTools).toEqual(allowedChatTools());
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.includePartialMessages).toBe(true);
    expect(o.maxTurns).toBe(24);
    expect(o.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude');
    expect(o.resume).toBeUndefined();
    expect(o.model).toBeUndefined();
    expect(o.systemPrompt).toEqual(expect.stringContaining('2026-10-30'));
    expect(o.env?.HOME).toBe('/home/owner');
    expect(o.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(o.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(o.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(o.abortController).toBeInstanceOf(AbortController);
  });

  it('resumes the given thread and reports the session the SDK returns', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('Same thread.'), success('sess-old')]));
    const turn = await backend(query).reply(req('and last month?', 'sess-old'));
    await collect(turn);
    expect(optionsOf(calls, 0).resume).toBe('sess-old');
    expect(turn.end()).toEqual({ threadId: 'sess-old', brain: 'claude' });
  });

  it('reads the MCP url at run time, not at construction', async () => {
    let port: number | null = null;
    const { query, calls } = fakeQuery(scripted([success()]));
    const b = createAgentChatBackend({
      chat: CHAT,
      cwd: '/data/chat',
      mcpUrl: () => {
        if (port === null) throw new Error('not listening');
        return `http://127.0.0.1:${port}/mcp`;
      },
      query,
      log: () => {},
    });
    port = 40123;
    await collect(await b.reply(req('x')));
    expect(optionsOf(calls, 0).mcpServers).toEqual({
      notes: { type: 'http', url: 'http://127.0.0.1:40123/mcp', alwaysLoad: true },
    });
  });
});

describe('agent chat backend: guardrails', () => {
  it('stops the run when the client disconnects', async () => {
    const { query, calls } = fakeQuery(hangs([textDelta('Working')]));
    const client = new AbortController();
    const turn = await backend(query).reply(req('x', null, client.signal));
    const it = turn.events[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ done: false, value: { type: 'delta', text: 'Working' } });
    const pending = it.next();
    client.abort();
    await expect(pending).rejects.toThrow(/request was closed/);
    expect(optionsOf(calls, 0).abortController?.signal.aborted).toBe(true);
  });

  it('never starts a run for an already-closed request', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('x'), success()]));
    const client = new AbortController();
    client.abort();
    const { events, error } = await collectUntilError(await backend(query).reply(req('x', null, client.signal)));
    expect(events).toEqual([]);
    expect(error.message).toMatch(/request was closed/);
    expect(calls).toHaveLength(0);
  });

  it('a newer reply() supersedes the run in flight', async () => {
    const { query, calls } = fakeQuery(hangs([textDelta('first')]), scripted([textDelta('second'), success('sess-2')]));
    const b = backend(query);
    const first = await b.reply(req('one'));
    const it = first.events[Symbol.asyncIterator]();
    await it.next();
    const pending = it.next();
    const second = await b.reply(req('two'));
    await expect(pending).rejects.toThrow(/newer message/);
    expect(optionsOf(calls, 0).abortController?.signal.aborted).toBe(true);
    expect(deltas(await collect(second))).toBe('second');
    expect(second.end().threadId).toBe('sess-2');
  });

  it('stops at the wall-clock timeout', async () => {
    const { query, calls } = fakeQuery(hangs([textDelta('slow')]));
    const { events, error } = await collectUntilError(await backend(query, { timeoutMs: 30 }).reply(req('x')));
    expect(deltas(events)).toBe('slow');
    expect(error.message).toMatch(/no answer within 30 ms/);
    expect(optionsOf(calls, 0).abortController?.signal.aborted).toBe(true);
  });

  it('close() stops the run in flight', async () => {
    const { query } = fakeQuery(hangs([]));
    const b = backend(query);
    const turn = await b.reply(req('x'));
    const pending = collectUntilError(turn);
    await new Promise((r) => setTimeout(r, 5));
    b.close();
    expect((await pending).error.message).toMatch(/shutting down/);
  });

  it('passes maxTurns and reports the cap without a fallback', async () => {
    const { query, calls } = fakeQuery(scripted([maxTurnsResult()]));
    const { error } = await collectUntilError(await backend(query, { maxTurns: 7 }).reply(req('x')));
    expect(optionsOf(calls, 0).maxTurns).toBe(7);
    expect(error.message).toMatch(/7-turn cap/);
    expect(calls).toHaveLength(1);
  });
});

describe('agent chat backend: GLM fallback', () => {
  it('retries once on GLM after a usage-limit error before any text, on the same thread', async () => {
    const { query, calls } = fakeQuery(
      scripted([
        toolUse('mcp__notes__search', {}),
        assistantError('rate_limit', 'Claude AI usage limit reached'),
        errorResult('Claude AI usage limit reached'),
      ]),
      scripted([textDelta('From GLM: A-B32.'), success('sess-glm')]),
    );
    const turn = await backend(query).reply(req('summarize', 'sess-old'));
    const events = await collect(turn);
    expect(events).toEqual([
      { type: 'status', text: 'searching notes' },
      { type: 'status', text: '' },
      { type: 'delta', text: 'From GLM: A-B32.' },
    ]);
    expect(calls).toHaveLength(2);
    const glm = optionsOf(calls, 1);
    expect(glm.env?.ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(glm.env?.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    expect(glm.env?.ANTHROPIC_MODEL).toBe('glm-5.3');
    expect(glm.model).toBe('glm-5.3');
    expect(glm.resume).toBe('sess-old');
    expect(calls[1]?.prompt).toBe('summarize');
    expect(turn.end()).toEqual({ threadId: 'sess-glm', brain: 'glm' });
  });

  it('retries on an auth failure named only in the result text', async () => {
    const { query, calls } = fakeQuery(
      scripted([errorResult('Not logged in · Please run /login')]),
      scripted([textDelta('ok'), success('sess-glm')]),
    );
    const turn = await backend(query).reply(req('x'));
    await collect(turn);
    expect(calls).toHaveLength(2);
    expect(turn.end().brain).toBe('glm');
  });

  it('retries when the SDK throws an auth error before any text', async () => {
    const { query, calls } = fakeQuery(
      throwsAfter([], 'Claude Code process exited with code 1: Invalid API key · Fix external API key'),
      scripted([textDelta('ok'), success('sess-glm')]),
    );
    const turn = await backend(query).reply(req('x'));
    await collect(turn);
    expect(calls).toHaveLength(2);
    expect(turn.end().brain).toBe('glm');
  });

  it('never retries after text has streamed', async () => {
    const { query, calls } = fakeQuery(
      scripted([textDelta('Partial answer'), assistantError('rate_limit', 'usage limit reached'), errorResult('usage limit reached')]),
      scripted([textDelta('dup'), success()]),
    );
    const { events, error } = await collectUntilError(await backend(query).reply(req('x')));
    expect(deltas(events)).toBe('Partial answer');
    expect(error.message).toMatch(/usage limit/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry an error that is not auth or a limit', async () => {
    const { query, calls } = fakeQuery(
      scripted([assistantError('overloaded', 'Overloaded'), errorResult('API Error: 529 Overloaded')]),
      scripted([textDelta('dup'), success()]),
    );
    const { error } = await collectUntilError(await backend(query).reply(req('x')));
    expect(error.message).toMatch(/Overloaded/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry when GLM is not configured', async () => {
    const { query, calls } = fakeQuery(scripted([assistantError('rate_limit', 'limit'), errorResult('Claude AI usage limit reached')]));
    const { error } = await collectUntilError(await backend(query, { glm: null }).reply(req('x')));
    expect(error.message).toMatch(/usage limit/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry after a stop', async () => {
    const { query, calls } = fakeQuery(hangs([]), scripted([success()]));
    const client = new AbortController();
    const turn = await backend(query).reply(req('x', null, client.signal));
    const pending = collectUntilError(turn);
    await new Promise((r) => setTimeout(r, 5));
    client.abort();
    expect((await pending).error.message).toMatch(/request was closed/);
    expect(calls).toHaveLength(1);
  });
});

describe('agent chat backend: CHAT_BRAIN=glm', () => {
  it('runs on GLM only and labels the turn glm', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('glm here'), success('sess-g')]));
    const turn = await backend(query, { brain: 'glm' }).reply(req('x'));
    await collect(turn);
    const o = optionsOf(calls, 0);
    expect(o.env?.ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(o.env?.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    expect(o.model).toBe('glm-5.3');
    expect(turn.end()).toEqual({ threadId: 'sess-g', brain: 'glm' });
  });

  it('never falls back from GLM', async () => {
    const { query, calls } = fakeQuery(
      scripted([assistantError('rate_limit', 'limit'), errorResult('rate limit exceeded')]),
      scripted([success()]),
    );
    const { error } = await collectUntilError(await backend(query, { brain: 'glm' }).reply(req('x')));
    expect(error.message).toMatch(/rate limit/);
    expect(calls).toHaveLength(1);
  });

  it('fails clearly when glm is selected but not configured', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    const { error } = await collectUntilError(await backend(query, { brain: 'glm', glm: null }).reply(req('x')));
    expect(error.message).toMatch(/LLM_BASE_URL/);
    expect(calls).toHaveLength(0);
  });
});
```
**Impact:** new unit tests. They run under the existing `tests/unit/**/*.test.ts` include. All of them use a fake `query` and spawn nothing. The longest wait is the 30 ms timeout test.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (unit, including the four new files) and `npm run test:int` (Phase 1's `/api/chat` int tests with the injected fake, plus `daemon.int.test.ts` as edited in Step 6e: the shared daemon runs the injected stub, and one daemon is started and stopped on the default agent backend without spawning). Sweep: `grep -n "startDaemon(" tests` — every call either injects `chat` or never posts to `/api/chat`.
**Manual check (optional, not an exit gate; Phase 4 does it through the installed unit):** from the worktree, run `NOTESD_PORT=7399 npx tsx src/main.ts`, then `curl -N -X POST http://127.0.0.1:7399/api/chat -H 'content-type: application/json' -d '{"message":"what tags do i use most?"}'`. Expect:
- `event: status` `{"text":"searching notes"}`
- `delta` events with ids like `A-B32`
- `done` with `"brain":"claude"` and a UUID `thread_id`

Then re-post with that `thread_id` and "and the least?", and the answer should keep context. Check `ls ~/mcp-notes-data/chat` (empty dir, the cwd), and look for the session under `~/.claude/projects/` with a slug of `<dataDir>/chat`.
**Exit criteria:**
- typecheck, build, unit and int tests are green.
- `chat-agent.test.ts` covers deltas, statuses, ids, resume, client/supersede/timeout/close abort, max turns, every fallback rule and `CHAT_BRAIN=glm`.
- `startDaemon(config)` with no `chat` option wires `createAgentChatBackend` with `cwd = join(dataDir, CHAT_SUBDIR)` and an MCP url read after `listen`.
- No integration test spawns `claude` (`daemon.int.test.ts` injects the stub for every chat post).
- `chat-env.test.ts` proves a Claude Code parent session's `CLAUDECODE` / `CLAUDE_CODE_*` markers never reach the child env.

## Handoffs

- **Phase 4 (R5): `NOTESD_CLAUDE_BIN`.** Set `NOTESD_CLAUDE_BIN` to the absolute real path in the unit. `resolveExecutable` does a PATH lookup for the bare default `claude`, but the unit should not depend on that.
- **Phase 4 (R1/R6): live checks of SDK behaviour the fakes assume.** Confirm each of these in `tests/live` or the acceptance run:
  - With `alwaysLoad: true` the `mcp__notes__*` tools are callable, not deferred.
  - `tools: ['WebSearch','WebFetch']` plus `dontAsk` lets WebSearch run.
  - A usage-limit or auth failure surfaces *before any `text_delta`*. The fallback assumes the CLI's synthetic API-error message is not streamed as `stream_event` text. If it is, Phase 4 should note it, and the fix belongs in `src/chat/agent.ts` (ignore deltas until the first `message_start` of a real response, or buffer).
- **Phase 4 (R5): the session location.** The session dir is `~/.claude/projects/<slug of NOTES_DATA_DIR/chat>`. INSTALL.md may mention it, because deleting it loses threads.
- **Phase 3 (R2/R4): nothing new.** Status texts are exactly the Decisions-table captions plus `""`. `done.brain` is `"claude"` or `"glm"`.
- **Phase 4 (R6): the backend's options object** is exactly `AgentChatOptions = { chat, cwd, mcpUrl: () => string, query?, now?, baseEnv?, log? }`, and `createAgentChatBackend` returns an `AgentChatBackend` synchronously with `close()`. The child env already drops `CLAUDECODE` and every `CLAUDE_CODE_*` key (Step 3), so the live suite needs no env workaround of its own.
- **Index Decisions:** the "SDK isolation" row carries `alwaysLoad: true` on the notes server (recorded by the reconciler).
- **Unassigned follow-up, not R-scoped: stale thread ids.** A stale `thread_id` whose session file is gone fails with the CLI's "No conversation found" error as `event: error`. Silently starting a fresh thread would be friendlier, but it is not asked for. Leave it for a later card.

## Rollback

Revert this phase's commit. That removes the four `src/chat/*` modules, the four unit test files, the two dependencies (and the lock changes), the daemon change, which restores Phase 1's stub default, and the Step 6e edit to `daemon.int.test.ts`, which restores Phase 1's stub-by-default test. No data migration. Session files written under `~/.claude/projects/` are inert.
