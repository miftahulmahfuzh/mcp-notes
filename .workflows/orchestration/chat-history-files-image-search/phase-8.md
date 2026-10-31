# Phase 8: Claude Code capture: hook, ingest endpoint, install, `/n` pasted images

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R1 (the `/n` half of "paste an image into the chat query bar": a pasted image reaches `similar_images`), R3 (Claude Code capture into the chat history)
**Depends on:** Phase 6 (`similar_images` with `upload_id` / `pasted_image`), Phase 7 (`ChatService`, chat tables, chat events). Transitively Phase 3 (chat image store, `POST /api/chat/images`).
**Difficulty:** HARD
**Package:** `claude/hooks` (new), `src/http`, `src/chat`, `scripts`

---

## Goal

After this phase every `/n` exchange typed in Claude Code (prompt as typed, final answer, prompt and answer timestamps, pasted images) lands in our own DB as a single-turn `source: 'claude_code'` chat thread, through an async Stop hook that never blocks or bothers the model, spools to an outbox when the daemon is down, and is idempotent on `<claude_session>:<user entry uuid>`. A `/n` user can paste an image and the model calls `similar_images({pasted_image: 1})`: a PreToolUse hook uploads that pasted image into the chat image store and rewrites the call to `upload_id`. `scripts/install.sh` registers both hooks in `~/.claude/settings.json` idempotently and `scripts/uninstall.sh` removes exactly them.

## Assumptions (what Phases 3, 6 and 7 are expected to have landed)

These phases were planned in parallel; their plan files (`phase-3.md`, `phase-6.md`, `phase-7.md`) appeared while this plan was written, and every row below is taken from them. Each row is still a reconciliation point if those plans change. P8 code calls only these symbols, so aligning a name is a mechanical rename inside the P8 files listed against it.

| # | From | Assumed symbol / behaviour | Used in (P8) |
|---|---|---|---|
| A1 | P3 (confirmed in `phase-3.md`) | `src/chat/images.ts` exports `chatImageStoreFor(app: AppDeps): ChatImageStoreDeps`, `ingestChatImage(deps: ChatImageStoreDeps, input: { bytes: Uint8Array; originalName: string \| null; source: ChatImageSource; maxBytes?: number }): Promise<{ image: ChatImage; created: boolean }>` (sha256 dedupe, a lost insert race returns the winner), `ChatImageInputError` with `code: 'not_an_image' \| 'too_large'`, `MAX_CHAT_IMAGE_BYTES` (50 MB), `type ChatImageSource = 'wall' \| 'claude_code'`. | `src/chat/capture.ts` |
| A2 | P3 (confirmed) | `chat_images.source` is `text not null` with check `in ('wall', 'claude_code')`. | `src/chat/capture.ts`, tests |
| A3 | P3 (confirmed) | `src/http/chatImages.ts` `chatImageRoutes`: `POST /api/chat/images` has no Origin guard and answers `{image, created}` (201/200). It accepts an optional multipart `source` field (`wall` default \| `claude_code`, else 400 `invalid_source`); P3 owns that field and its tests (reconciler moved it out of this phase). | `claude/hooks/notes-paste.mjs` |
| A4 | P6 (confirmed in `phase-6.md`) | `src/mcp/similarTools.ts` exports `PASTED_IMAGE_NEEDS_HOOK` (provisional text), the handler answers `if (args.pasted_image !== undefined) return fail(PASTED_IMAGE_NEEDS_HOOK);`, the `pasted_image` field is `z.number().int().min(1).max(20).optional().describe(...)`; `upload_id` resolves any `chat_images` row. `tests/integration/similarImages.mcp.int.test.ts` has the case "pasted_image explains that the Claude Code hook is needed"; `tests/unit/similarTools.test.ts` asserts the constant contains `scripts/install.sh` and `image_id`. P6's `/n` skill bullet for pasted images and its README `similar_images` row mention the hook (named `notes-paste` after reconciliation). | Steps 15, 16, 26, 28 |
| A5 | P7 (confirmed in `phase-7.md`) | `src/db/schema.ts`: `chatThreads` (`id` text PK, `source` check `wall \| claude_code`, `external_key` unique, nullable), `chatMessages`, `chatMessageAttachments`; `ChatSource = 'wall' \| 'claude_code'`. Migration 0006 is the latest. | none directly |
| A6 | P7 (confirmed) | `ChatService.recordExchange(input: RecordExchangeInput): Promise<RecordedExchange>` with `RecordExchangeInput = { source: ChatSource; externalKey: string; brain?: string \| null; user: { text; createdAt: Date; attachments?: readonly AttachmentRef[] }; assistant: { text; createdAt: Date } \| null }`, `AttachmentRef = { kind: 'chat_image' \| 'note_file' \| 'note_image'; id }`, `RecordedExchange = { created: boolean; thread: ChatThreadView; messageIds: string[] }` (ascending). Idempotent on the key, race-safe, emits `event: chat created` per written message. | `src/chat/capture.ts` |
| A8 | P7 (confirmed) | `AppDeps.chat: ChatService`; `src/daemon.ts` and `tests/integration/imageHarness.ts` build it (`chat: new ChatService({ db })`); `createApp` mounts `chatHistoryRoutes`; `truncateAll` lists the chat tables. | `src/chat/capture.ts`, integration tests |
| A9 | P7 (confirmed) | `GET /api/chat/threads/:id` → `ChatThreadDetail { thread: { id, source, brain, created_at, updated_at }, messages: ChatMessageView[] }`; `GET /api/chat/messages` → `ChatTimelinePage { messages (ascending), next_before }`; `ChatMessageView` has `id, thread_id, role, text, source, brain, reply_to, created_at, edited_at, deleted_at, attachments: { kind, id, url, thumb_url }[]`. | integration tests only |
| A10 | P3/P4/P6/P7 | Migrations 0003-0006 exist. **This phase adds no migration.** | — |

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `claude/hooks/lib/transcript.mjs`: `parseTranscript`, `isHumanPrompt`, `typedFromCommandXml`, `promptText`, `isNotesPrompt`, `extractImages`, `findTurn`, `findLatestImagePrompt`, `pickPastedImage` (+ `transcript.d.mts`)
- `claude/hooks/lib/state.mjs`: `DEFAULT_PORT`, `daemonBaseUrl`, `stateDir`, `writeLog`, `readStdin`, `errorText`, `isMainModule` (+ `state.d.mts`)
- `claude/hooks/notes-capture.mjs` (Stop hook): re-exports `parseTranscript, findTurn, extractImages, isNotesPrompt, promptText`; `CAPTURE_PATH`, `buildPayload`, `capturePayload`, `turnSettled`, `deliver`, `spool`, `outboxDir`, `drainOutbox`, `runCapture` (+ `.d.mts`)
- `claude/hooks/notes-paste.mjs` (PreToolUse hook): `TOOL_NAME`, `UPLOAD_PATH`, `DEFAULT_STRATEGY`, `pastedImageNumber`, `strategyFrom`, `allowUnchanged`, `rewriteOutput`, `denyOutput`, `uploadIdFrom`, `uploadImage`, `findPastedImage`, `runPaste` (+ `.d.mts`)
- `scripts/claude-hooks.mjs`: `mergeHooks`, `removeHooks`, `isOurHandler`, `hookCommand`, `shQuote`, `readSettings`, `writeSettings`, CLI `install|uninstall|status` (+ `.d.mts`)
- `scripts/verify-paste-hook.mjs` (opt-in live check), npm script `verify:paste-hook`
- `src/chat/capture.ts`: `CAPTURE_SOURCE`, `MAX_CAPTURED_IMAGE_BYTES`, `captureExternalKey`, `captureClaudeCodeExchange`, `CaptureImageError`, `ClaudeCodeCaptureInput`, `CaptureResult`
- `src/http/capture.ts`: `captureRoutes`, `captureGuard`, `CAPTURE_PATH`, `CAPTURE_HEADER`, `MAX_CAPTURE_BODY_BYTES`, `MAX_CAPTURE_IMAGES`, `MAX_CAPTURE_IMAGE_BYTES`, `CAPTURE_MEDIA_TYPES`, `decodeImageBase64`
- HTTP route `POST /api/capture/claude-code`
- `similar_images`: P6's `PASTED_IMAGE_NEEDS_HOOK` keeps its name, gets its final text (Step 15)
- install switches: `scripts/install.sh --skip-hooks`, env `NOTES_SKIP_HOOKS=1`, env `NOTES_PASTE_STRATEGY=deny`; `install.sh`/`uninstall.sh` run `main` only when executed, not when sourced
**Signature changes:** none in existing code. `createApp` mounts one more router.
**Requires (from earlier phases):** A1-A10 above, all read from the P3, P6 and P7 plan files.
**Leaves alone (owned by others):** every `web/` file (P9-P11 render captured threads); `ChatService` and every chat table (P7; P8 only calls `recordExchange`); `similar_images` search logic and the image embedder (P6); `src/http/chatImages.ts` and `POST /api/chat/images` including its `source` field (P3); `claude/mods/note-links/*` (untouched).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/hooks/lib/transcript.mjs` | create | transcript JSONL parsing shared by both hooks |
| `claude/hooks/lib/transcript.d.mts` | create | types for the TS tests |
| `claude/hooks/lib/state.mjs` | create | port, state dir, log, stdin, main-module check |
| `claude/hooks/lib/state.d.mts` | create | types |
| `claude/hooks/notes-capture.mjs` | create | Stop hook: capture, spool, outbox drain |
| `claude/hooks/notes-capture.d.mts` | create | types |
| `claude/hooks/notes-paste.mjs` | create | PreToolUse hook: `pasted_image` → `upload_id` |
| `claude/hooks/notes-paste.d.mts` | create | types |
| `scripts/claude-hooks.mjs` | create | settings.json merge / remove / status |
| `scripts/claude-hooks.d.mts` | create | types |
| `scripts/install.sh` | modify | header (l.1-15), vars (after l.35), `check_preconditions` (l.71-92), new `parse_args`, `register_hooks`, `verify` (l.243-271), `main` (l.273-290) |
| `scripts/uninstall.sh` | rewrite | functions + `unregister_hooks` + source guard |
| `scripts/verify-paste-hook.mjs` | create | opt-in live check of the `updatedInput` rewrite |
| `src/chat/capture.ts` | create | images → P3 store, then P7 `recordExchange` |
| `src/http/capture.ts` | create | the endpoint and its guard |
| `src/http/app.ts` | modify | import + mount `captureRoutes` (next to `revealRoutes`, l.71 today) |
| `src/mcp/similarTools.ts` | modify | P6's `PASTED_IMAGE_NEEDS_HOOK` gets its final text; `pasted_image` field description |
| `tests/unit/hooks/fixtures.ts` | create | synthetic transcript entries in the real 2.1.314 shapes |
| `tests/unit/hooks/transcript.test.ts` | create | parser |
| `tests/unit/hooks/notesCapture.test.ts` | create | capture + outbox with a fake fetch |
| `tests/unit/hooks/notesPaste.test.ts` | create | paste hook with a fake fetch |
| `tests/unit/scripts/claudeHooks.test.ts` | create | merge/remove, CLI, `install.sh`/`uninstall.sh` against a temp `HOME` |
| `tests/unit/captureGuard.test.ts` | create | guard without a DB |
| `tests/integration/capture.int.test.ts` | create | endpoint: validation, idempotency, images, single-turn thread, timeline |
| `tests/integration/capture.hook.int.test.ts` | create | hook → real endpoint, daemon down → outbox → later delivery |
| `tests/integration/similarImages.mcp.int.test.ts` | modify | P6's pasted_image case asserts the final text (Step 26a) |
| `claude/skills/n/SKILL.md` | modify | Images: pasted images; captured history |
| `README.md` | modify | Using it from Claude Code, install steps, HTTP API, storage, layout |
| `CHANGELOG.md` | modify | one line under Unreleased |
| `package.json` | modify | `verify:paste-hook` script |

## Design notes (decided here)

- **Turn detection.** Walk the transcript back to the latest *human prompt entry*: `type: 'user'`, not `isMeta`, not `isSidechain`, not `isCompactSummary`, no `toolUseResult`, `origin.kind` absent or `'human'`, `message.role: 'user'`, and content that is either a non-empty string not starting with a local-command wrapper (`<local-command-stdout>` etc.) or an array with a `text`/`image` block and no `tool_result` block. This skips tool results, the skill body (`isMeta: true`) that follows a `/n` command entry, and local-command caveats.
- **"Is it `/n`".** `promptText(entry)` turns a command wrapper (`<command-message>n</command-message>\n<command-name>/n</command-name>\n<command-args>X</command-args>`, either tag order) into `/n X`, and joins array-form `text` blocks (each converted the same way). The turn is a notes turn when that text, left-trimmed, matches `^/n(\s|$)`. `/notes`, `/new` and a text that merely mentions `/n` later do not match.
- **Answer.** `last_assistant_message` from the Stop input wins. The transcript answer (assistant `text` blocks after the last `tool_use` that follows the prompt) is the fallback and the "settled" probe: the hook polls the transcript every 250 ms for up to 3 s until the turn's transcript answer contains the first 200 chars of `last_assistant_message` (or, with no `last_assistant_message`, until any answer text exists). After 3 s it proceeds with what it has. A turn with an empty answer is still captured (user message only).
- **Timestamps.** `prompt_timestamp` = the prompt entry's `timestamp`; `answered_at` = the hook's own clock at capture time (Stop fires at the end of the answer; it is spooled with the payload, so a later outbox retry keeps it). The server clamps `answered_at` to at least `prompt_timestamp + 1 ms` so the timeline order is always question, then answer.
- **Spool first.** The payload is written to the outbox before the first POST, so an async hook killed by a closing Claude Code (e.g. `claude -p`) still leaves the capture for the next run. Order per run: build + spool current → drain older outbox files (oldest first, at most 20 attempts, stop at the first retryable failure, drop files older than 14 days) → POST the current one unless the drain hit a retryable failure.
- **Delivery outcomes.** 2xx → delete. Network error, timeout, 5xx, 429, 404, 405 → keep (404/405 = a daemon older than the route, temporary because `install.sh` rebuilds the daemon before registering hooks). Any other 4xx (400 validation, 403 guard, 413, 415) → log and delete. This deviates from "drop on 4xx other than 429" only for 404/405, deliberately.
- **Idempotency.** P7's `recordExchange` keys the thread on `external_key = <claude_session>:<user_uuid>` (unique index, find-or-insert in one transaction, a lost race re-reads the winner). A replay answers `duplicate` with the first capture's ids; deleting the captured bubbles on the history page does not let a replay resurrect them, because the thread row stays.
- **Images.** Stored via P3's store *before* the transaction (file writes do not belong in a DB transaction); P3 dedupes by sha, so a replay or a race stores nothing new. Caps: ≤ 8 images, each ≤ 20 MB decoded, media types png/jpeg/gif/webp; the hook additionally keeps the total base64 under 48 MB so the 64 MB body limit is never the reason a capture is dropped.
- **Paste strategy switch.** `DEFAULT_STRATEGY = 'updatedInput'` in `notes-paste.mjs` is the single switch. The env var `NOTES_PASTE_STRATEGY=deny` overrides it per process; `NOTES_PASTE_STRATEGY=deny scripts/install.sh` bakes that env prefix into the registered hook command. `deny` mode uploads the image, then returns `permissionDecision: 'deny'` with a reason naming the `upload_id` and the exact arguments to call again with. The hook never touches a call without `pasted_image`, so the model's retry with `upload_id` passes through untouched. `allow` is returned only for a call this hook handled (rewritten, or `pasted_image` with no resolvable image); `similar_images` is read-only, so skipping the permission prompt is harmless.
- **Wall chat is unaffected.** The daemon's Agent SDK runs with `settingSources: []`, so user-scope hooks never fire for wall chat turns.
- **Hook entries.** Recognised by the script basename `notes-capture.mjs` / `notes-paste.mjs` in the handler `command`, so an entry pointing at another checkout is replaced, not duplicated. Commands are single-quoted absolute paths: `'/abs/node' '/abs/repo/claude/hooks/notes-capture.mjs'`.

## Implementation Steps

### Step 1: Transcript library
**File:** `claude/hooks/lib/transcript.mjs` (new)
**Code:**
```js
/**
 * Claude Code transcript reading for the mcp-notes hooks (Claude Code 2.1.x JSONL).
 * Node >= 22 built-ins only (here: none). Pure functions; the hooks do the I/O.
 *
 * Shapes this relies on (verified on 2.1.314 transcripts):
 * - A typed `/n args` prompt is a `type: 'user'` entry whose `message.content` is the string
 *   `<command-message>n</command-message>\n<command-name>/n</command-name>\n<command-args>args</command-args>`,
 *   with uuid, parentUuid, promptId, timestamp (ISO UTC), sessionId, cwd and origin {kind:'human'}.
 * - A prompt with pasted images has `message.content` as an array of {type:'text',text} and
 *   {type:'image',source:{type:'base64',media_type,data}} blocks, and the entry has
 *   `imagePasteIds: [1, ...]`, one per image block in order.
 * - Tool results are `type: 'user'` entries too (content array of tool_result blocks), and the
 *   skill body that follows a `/n` command entry is a `type: 'user'` entry with `isMeta: true`.
 */

const LOCAL_WRAPPERS = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];

const COMMAND_START = /^\s*<command-(?:message|name)>/;
const COMMAND_NAME = /<command-name>\s*\/?([^<\s]*)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const NOTES_PROMPT = /^\/n(?:\s|$)/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every JSON-object line of a JSONL transcript, in file order. Torn or malformed lines are skipped. */
export function parseTranscript(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const value = JSON.parse(trimmed);
      if (isObject(value)) entries.push(value);
    } catch {
      // A line still being written, or not JSON at all.
    }
  }
  return entries;
}

/** True for an entry the user typed (or pasted) as a prompt: not a tool result, not meta, not a sidechain. */
export function isHumanPrompt(entry) {
  if (!isObject(entry)) return false;
  if (entry.type !== 'user') return false;
  if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true) return false;
  if (entry.toolUseResult !== undefined) return false;
  const kind = isObject(entry.origin) ? entry.origin.kind : undefined;
  if (kind !== undefined && kind !== 'human') return false;
  const message = entry.message;
  if (!isObject(message) || message.role !== 'user') return false;
  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trimStart();
    return text.length > 0 && !LOCAL_WRAPPERS.some((prefix) => text.startsWith(prefix));
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  if (content.some((block) => isObject(block) && block.type === 'tool_result')) return false;
  return content.some((block) => isObject(block) && (block.type === 'text' || block.type === 'image'));
}

/** `<command-message>n</command-message><command-name>/n</command-name><command-args>x</command-args>` -> `/n x`. Other text is returned as is. */
export function typedFromCommandXml(text) {
  if (typeof text !== 'string' || !COMMAND_START.test(text)) return typeof text === 'string' ? text : '';
  const name = COMMAND_NAME.exec(text);
  if (!name || name[1] === undefined || name[1] === '') return text;
  const argsMatch = COMMAND_ARGS.exec(text);
  const args = argsMatch && argsMatch[1] !== undefined ? argsMatch[1].trim() : '';
  return args === '' ? `/${name[1]}` : `/${name[1]} ${args}`;
}

/** The prompt as the user typed it: `/n args` for a command entry, the joined text blocks for an array entry. */
export function promptText(entry) {
  const content = isObject(entry) && isObject(entry.message) ? entry.message.content : undefined;
  if (typeof content === 'string') return typedFromCommandXml(content).trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => typedFromCommandXml(block.text))
    .join('\n')
    .trim();
}

/** A human prompt whose typed text starts with `/n` (then whitespace or the end). */
export function isNotesPrompt(entry) {
  return isHumanPrompt(entry) && NOTES_PROMPT.test(promptText(entry).trimStart());
}

/**
 * The base64 image blocks of an entry, in block order. `paste_id` is the matching
 * `imagePasteIds` value (the N of "[Image #N]"), or the 1-based image position when absent.
 */
export function extractImages(entry) {
  const content = isObject(entry) && isObject(entry.message) ? entry.message.content : undefined;
  if (!Array.isArray(content)) return [];
  const pasteIds = Array.isArray(entry.imagePasteIds) ? entry.imagePasteIds : [];
  const images = [];
  let position = 0;
  for (const block of content) {
    if (!isObject(block) || block.type !== 'image') continue;
    const index = position;
    position += 1;
    const source = block.source;
    if (!isObject(source) || source.type !== 'base64') continue;
    if (typeof source.data !== 'string' || source.data === '' || typeof source.media_type !== 'string') continue;
    const pasteId = Number.isInteger(pasteIds[index]) ? pasteIds[index] : index + 1;
    images.push({ media_type: source.media_type, data_base64: source.data, paste_id: pasteId });
  }
  return images;
}

/**
 * The latest human prompt and what the assistant said after it. `answer` is the text after the
 * last tool_use that follows the prompt (the final message); `answeredAt` is the timestamp of the
 * last entry contributing to it. Null when the transcript has no human prompt.
 */
export function findTurn(entries) {
  let promptIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isHumanPrompt(entries[i])) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex < 0) return null;
  let segment = [];
  let answeredAt = null;
  const seen = new Set();
  for (let i = promptIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isObject(entry) || entry.isSidechain === true || entry.type !== 'assistant') continue;
    if (typeof entry.uuid === 'string') {
      if (seen.has(entry.uuid)) continue;
      seen.add(entry.uuid);
    }
    const content = isObject(entry.message) ? entry.message.content : undefined;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_use') {
        segment = [];
        answeredAt = null;
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        segment.push(block.text);
        if (typeof entry.timestamp === 'string') answeredAt = entry.timestamp;
      }
    }
  }
  return { prompt: entries[promptIndex], promptIndex, answer: segment.join('\n\n').trim(), answeredAt };
}

/** The latest human prompt entry that carries at least one base64 image, or null. */
export function findLatestImagePrompt(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (isHumanPrompt(entry) && extractImages(entry).length > 0) return entry;
  }
  return null;
}

/** "[Image #n]": the image whose paste id is n, else the n-th image in block order, else null. */
export function pickPastedImage(images, n) {
  if (!Number.isInteger(n) || n < 1) return null;
  const byPasteId = images.find((image) => image.paste_id === n);
  if (byPasteId !== undefined) return byPasteId;
  return images[n - 1] ?? null;
}
```
**Impact:** none on existing code.

### Step 2: Transcript types
**File:** `claude/hooks/lib/transcript.d.mts` (new)
**Code:**
```ts
export type TranscriptEntry = Record<string, unknown>;

export interface PastedImage {
  media_type: string;
  data_base64: string;
  /** The N of "[Image #N]". */
  paste_id: number;
}

export interface Turn {
  prompt: TranscriptEntry;
  promptIndex: number;
  answer: string;
  answeredAt: string | null;
}

export function parseTranscript(text: string): TranscriptEntry[];
export function isHumanPrompt(entry: unknown): boolean;
export function typedFromCommandXml(text: string): string;
export function promptText(entry: unknown): string;
export function isNotesPrompt(entry: unknown): boolean;
export function extractImages(entry: unknown): PastedImage[];
export function findTurn(entries: TranscriptEntry[]): Turn | null;
export function findLatestImagePrompt(entries: TranscriptEntry[]): TranscriptEntry | null;
export function pickPastedImage(images: PastedImage[], n: number): PastedImage | null;
```

### Step 3: Hook state helpers
**File:** `claude/hooks/lib/state.mjs` (new)
**Code:**
```js
/**
 * Shared plumbing for the mcp-notes Claude Code hooks: where the daemon is, where the hooks keep
 * their state (outbox, logs), and safe logging. Node >= 22 built-ins only. Nothing here throws.
 */
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 7317;
export const LOG_MAX_BYTES = 1024 * 1024;

/** `http://127.0.0.1:<NOTESD_PORT or 7317>`. The daemon only ever listens on 127.0.0.1. */
export function daemonBaseUrl(env) {
  const raw = typeof env.NOTESD_PORT === 'string' ? env.NOTESD_PORT.trim() : '';
  const port = /^\d{1,5}$/.test(raw) && Number(raw) > 0 && Number(raw) < 65536 ? Number(raw) : DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/** `${XDG_STATE_HOME:-$HOME/.local/state}/notes-capture` (a relative XDG_STATE_HOME is ignored, per the spec). */
export function stateDir(env) {
  const xdg = typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME : '';
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir();
  const base = xdg !== '' && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'state');
  return path.join(base, 'notes-capture');
}

/** Appends one timestamped line to `<dir>/<file>`, rotating to `<file>.1` past 1 MB. Never throws. */
export async function writeLog(dir, file, message) {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, file);
    try {
      const info = await stat(target);
      if (info.size > LOG_MAX_BYTES) await rename(target, `${target}.1`);
    } catch {
      // No log yet.
    }
    const line = String(message).replace(/\s+/g, ' ').slice(0, 2000);
    await appendFile(target, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // Logging must never break a hook.
  }
}

export function errorText(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** The whole of stdin as UTF-8. */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** True when the module at `moduleUrl` is the script node was started with (symlinks resolved). */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}
```

**File:** `claude/hooks/lib/state.d.mts` (new)
```ts
export type Env = Record<string, string | undefined>;
export const DEFAULT_PORT: number;
export const LOG_MAX_BYTES: number;
export function daemonBaseUrl(env: Env): string;
export function stateDir(env: Env): string;
export function writeLog(dir: string, file: string, message: string): Promise<void>;
export function errorText(err: unknown): string;
export function readStdin(): Promise<string>;
export function isMainModule(moduleUrl: string): boolean;
```

### Step 4: The Stop hook
**File:** `claude/hooks/notes-capture.mjs` (new)
**Code:**
```js
#!/usr/bin/env node
/**
 * notes-capture: Claude Code Stop hook (registered with `async: true`) for mcp-notes.
 *
 * At the end of every turn it reads the session transcript. When the turn's prompt was a `/n ...`
 * request it sends {prompt as typed, final answer, prompt/answer timestamps, cwd, pasted images}
 * to the local notesd, POST /api/capture/claude-code, which stores the exchange as a single-turn
 * `claude_code` chat thread. The daemon is idempotent on `<claude_session>:<user_uuid>`.
 *
 * Rules:
 * - Always exits 0 and never writes to stdout or stderr. Problems go to
 *   ${XDG_STATE_HOME:-~/.local/state}/notes-capture/capture.log.
 * - The payload is spooled to .../notes-capture/outbox/<user uuid>.json (0600) before it is sent,
 *   and removed once the daemon took it (201) or already had it (200 duplicate).
 * - Every run first retries older outbox files: oldest first, at most OUTBOX_MAX_PER_RUN attempts,
 *   stopping at the first network error / 5xx / 429 / 404 / 405 (kept for later), dropping (and
 *   logging) any other 4xx and anything older than OUTBOX_MAX_AGE_MS.
 *
 * Node >= 22 built-ins only. Installed by scripts/install.sh (scripts/claude-hooks.mjs).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';
import { extractImages, findTurn, isNotesPrompt, parseTranscript, promptText } from './lib/transcript.mjs';

export { extractImages, findTurn, isNotesPrompt, parseTranscript, promptText };

export const CAPTURE_PATH = '/api/capture/claude-code';
export const CAPTURE_HEADER = 'x-notes-capture';
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES_BASE64_CHARS = 48 * 1024 * 1024;
export const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const TRANSCRIPT_WAIT_MS = 3000;
export const TRANSCRIPT_POLL_MS = 250;
export const SETTLE_PROBE_CHARS = 200;
export const FETCH_TIMEOUT_MS = 10_000;
export const OUTBOX_MAX_PER_RUN = 20;
export const OUTBOX_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const LOG_FILE = 'capture.log';

const SAFE_NAME = /^[A-Za-z0-9-]{1,100}$/;

function validIso(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function selectImages(images) {
  const selected = [];
  let total = 0;
  for (const image of images) {
    if (selected.length >= MAX_IMAGES) break;
    if (!IMAGE_MEDIA_TYPES.has(image.media_type)) continue;
    if (Math.floor((image.data_base64.length * 3) / 4) > MAX_IMAGE_BYTES) continue;
    if (total + image.data_base64.length > MAX_IMAGES_BASE64_CHARS) continue;
    total += image.data_base64.length;
    selected.push({ media_type: image.media_type, data_base64: image.data_base64 });
  }
  return selected;
}

/** The capture payload for a `/n` turn, or null when the entry lacks the ids the daemon keys on. */
export function buildPayload(hookInput, turn, answer, nowIso) {
  const prompt = turn.prompt;
  const userUuid = typeof prompt.uuid === 'string' && prompt.uuid !== '' ? prompt.uuid : null;
  const session =
    typeof hookInput.session_id === 'string' && hookInput.session_id !== ''
      ? hookInput.session_id
      : typeof prompt.sessionId === 'string' && prompt.sessionId !== ''
        ? prompt.sessionId
        : null;
  if (userUuid === null || session === null) return null;
  const cwd =
    typeof prompt.cwd === 'string' && prompt.cwd !== ''
      ? prompt.cwd
      : typeof hookInput.cwd === 'string' && hookInput.cwd !== ''
        ? hookInput.cwd
        : null;
  return {
    claude_session: session,
    user_uuid: userUuid,
    prompt: promptText(prompt),
    answer,
    prompt_timestamp: validIso(prompt.timestamp) ?? nowIso,
    answered_at: nowIso,
    cwd,
    images: selectImages(extractImages(prompt)),
  };
}

/** The transcript caught up: its answer contains the start of the hook's final message (or has any text when there is none). */
export function turnSettled(turn, lastAssistantMessage) {
  if (lastAssistantMessage === '') return turn.answer !== '';
  return turn.answer.includes(lastAssistantMessage.slice(0, SETTLE_PROBE_CHARS));
}

/** Reads the transcript (polling while it lags) and returns the payload for a `/n` turn, else null. */
export async function capturePayload(input, { now, sleep, readText }) {
  if (input === null || typeof input !== 'object' || typeof input.transcript_path !== 'string') return null;
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
  const deadline = now() + TRANSCRIPT_WAIT_MS;
  let turn = null;
  for (;;) {
    let text = null;
    try {
      text = await readText(input.transcript_path);
    } catch {
      text = null;
    }
    if (text !== null) {
      turn = findTurn(parseTranscript(text));
      if (turn !== null && turnSettled(turn, last)) break;
    }
    if (now() >= deadline) break;
    await sleep(TRANSCRIPT_POLL_MS);
  }
  if (turn === null || !isNotesPrompt(turn.prompt)) return null;
  const answer = last !== '' ? last : turn.answer;
  return buildPayload(input, turn, answer, new Date(now()).toISOString());
}

/** One POST. `delivered` (2xx), `retry` (keep the file) or `drop` (the daemon will never take it). */
export async function deliver(payload, { fetchImpl, baseUrl }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}${CAPTURE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CAPTURE_HEADER]: '1' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { outcome: 'retry', detail: errorText(err) };
  }
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  const status = res.status;
  if (status >= 200 && status < 300) return { outcome: 'delivered', status, detail };
  if (status === 429 || status === 404 || status === 405 || status >= 500) return { outcome: 'retry', status, detail };
  return { outcome: 'drop', status, detail };
}

function describe(result) {
  return result.status !== undefined ? `HTTP ${result.status} ${result.detail ?? ''}`.trim() : (result.detail ?? 'no detail');
}

async function removeQuietly(file) {
  try {
    await unlink(file);
  } catch {
    // Already gone (another hook run delivered it).
  }
}

export function outboxDir(env) {
  return path.join(stateDir(env), 'outbox');
}

/** Writes the payload atomically to `<dir>/<user_uuid>.json` (0600) and returns that path. */
export async function spool(dir, payload) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${SAFE_NAME.test(payload.user_uuid) ? payload.user_uuid : randomUUID()}.json`;
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
  await rename(tmp, target);
  return target;
}

/** Retries spooled captures, oldest first, within the per-run and age bounds. */
export async function drainOutbox({ dir, fetchImpl, baseUrl, now, log, skip }) {
  const summary = { delivered: 0, dropped: 0, kept: 0, stoppedEarly: false };
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
  } catch {
    return summary;
  }
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (skip !== undefined && skip !== null && file === skip) continue;
    try {
      files.push({ file, mtimeMs: (await stat(file)).mtimeMs });
    } catch {
      // Removed meanwhile.
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let attempts = 0;
  for (const { file, mtimeMs } of files) {
    const base = path.basename(file);
    if (now() - mtimeMs > OUTBOX_MAX_AGE_MS) {
      await log(`drop ${base}: older than ${Math.round(OUTBOX_MAX_AGE_MS / 86_400_000)} days`);
      await removeQuietly(file);
      summary.dropped += 1;
      continue;
    }
    if (summary.stoppedEarly || attempts >= OUTBOX_MAX_PER_RUN) {
      summary.kept += 1;
      continue;
    }
    attempts += 1;
    let payload;
    try {
      payload = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      await log(`drop ${base}: unreadable (${errorText(err)})`);
      await removeQuietly(file);
      summary.dropped += 1;
      continue;
    }
    const result = await deliver(payload, { fetchImpl, baseUrl });
    if (result.outcome === 'delivered') {
      await removeQuietly(file);
      summary.delivered += 1;
    } else if (result.outcome === 'drop') {
      await log(`drop ${base}: ${describe(result)}`);
      await removeQuietly(file);
      summary.dropped += 1;
    } else {
      await log(`keep ${base}: ${describe(result)}`);
      summary.kept += 1;
      summary.stoppedEarly = true;
    }
  }
  return summary;
}

/** The whole hook run, with every dependency injectable for tests. Never throws. */
export async function runCapture({
  input,
  env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = delay,
  readText = (file) => readFile(file, 'utf8'),
}) {
  const dir = stateDir(env);
  const outbox = path.join(dir, 'outbox');
  const baseUrl = daemonBaseUrl(env);
  const log = (message) => writeLog(dir, LOG_FILE, message);
  let payload = null;
  let spooled = null;
  try {
    payload = await capturePayload(input, { now, sleep, readText });
    if (payload !== null) spooled = await spool(outbox, payload);
  } catch (err) {
    await log(`capture: ${errorText(err)}`);
  }
  const drained = await drainOutbox({ dir: outbox, fetchImpl, baseUrl, now, log, skip: spooled });
  if (payload === null) return { outcome: 'skipped', drained };
  if (spooled === null) {
    const direct = await deliver(payload, { fetchImpl, baseUrl });
    if (direct.outcome !== 'delivered') await log(`lost ${payload.user_uuid}: could not spool, ${describe(direct)}`);
    return { outcome: direct.outcome === 'delivered' ? 'delivered' : 'dropped', drained };
  }
  if (drained.stoppedEarly) return { outcome: 'spooled', drained };
  const result = await deliver(payload, { fetchImpl, baseUrl });
  if (result.outcome === 'delivered') {
    await removeQuietly(spooled);
    return { outcome: 'delivered', drained };
  }
  if (result.outcome === 'drop') {
    await log(`drop ${path.basename(spooled)}: ${describe(result)}`);
    await removeQuietly(spooled);
    return { outcome: 'dropped', drained };
  }
  await log(`keep ${path.basename(spooled)}: ${describe(result)}`);
  return { outcome: 'spooled', drained };
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    await runCapture({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
```
**Impact:** none until registered (Step 8).

**File:** `claude/hooks/notes-capture.d.mts` (new)
```ts
import type { Turn } from './lib/transcript.mjs';
export { extractImages, findTurn, isNotesPrompt, parseTranscript, promptText } from './lib/transcript.mjs';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CapturePayload {
  claude_session: string;
  user_uuid: string;
  prompt: string;
  answer: string;
  prompt_timestamp: string;
  answered_at: string;
  cwd: string | null;
  images: { media_type: string; data_base64: string }[];
}

export interface DeliverResult {
  outcome: 'delivered' | 'retry' | 'drop';
  status?: number;
  detail?: string;
}

export interface DrainSummary {
  delivered: number;
  dropped: number;
  kept: number;
  stoppedEarly: boolean;
}

export interface PayloadIo {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  readText: (file: string) => Promise<string>;
}

export const CAPTURE_PATH: string;
export const CAPTURE_HEADER: string;
export const MAX_IMAGES: number;
export const MAX_IMAGE_BYTES: number;
export const MAX_IMAGES_BASE64_CHARS: number;
export const IMAGE_MEDIA_TYPES: Set<string>;
export const TRANSCRIPT_WAIT_MS: number;
export const TRANSCRIPT_POLL_MS: number;
export const SETTLE_PROBE_CHARS: number;
export const FETCH_TIMEOUT_MS: number;
export const OUTBOX_MAX_PER_RUN: number;
export const OUTBOX_MAX_AGE_MS: number;
export const LOG_FILE: string;

export function buildPayload(hookInput: Record<string, unknown>, turn: Turn, answer: string, nowIso: string): CapturePayload | null;
export function turnSettled(turn: Turn, lastAssistantMessage: string): boolean;
export function capturePayload(input: unknown, io: PayloadIo): Promise<CapturePayload | null>;
export function deliver(payload: unknown, opts: { fetchImpl: FetchLike; baseUrl: string }): Promise<DeliverResult>;
export function outboxDir(env: Env): string;
export function spool(dir: string, payload: CapturePayload): Promise<string>;
export function drainOutbox(opts: {
  dir: string;
  fetchImpl: FetchLike;
  baseUrl: string;
  now: () => number;
  log: (message: string) => Promise<void>;
  skip?: string | null;
}): Promise<DrainSummary>;
export function runCapture(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  readText?: (file: string) => Promise<string>;
}): Promise<{ outcome: 'skipped' | 'delivered' | 'dropped' | 'spooled'; drained: DrainSummary }>;
```

### Step 5: The PreToolUse hook
**File:** `claude/hooks/notes-paste.mjs` (new)
**Code:**
```js
#!/usr/bin/env node
/**
 * notes-paste: Claude Code PreToolUse hook for `mcp__notes__similar_images` (mcp-notes).
 *
 * A pasted image in Claude Code has no file path, so `/n` asks the model to call
 * similar_images({pasted_image: N}) for "[Image #N]". This hook finds the latest human prompt in
 * the transcript that carries images, takes image N (by imagePasteIds, else block order),
 * uploads it to notesd (POST /api/chat/images, source claude_code) and hands the call on with
 * `upload_id` instead of `pasted_image`.
 *
 * THE SWITCH: DEFAULT_STRATEGY below.
 * - 'updatedInput' (default): permissionDecision 'allow' + updatedInput {…, upload_id}.
 * - 'deny': upload, then deny the call with a reason that gives the model the upload_id and the
 *   exact arguments to call again with. Use it if Claude Code stops honouring updatedInput for MCP
 *   tools (check with `npm run verify:paste-hook`). Per process: NOTES_PASTE_STRATEGY=deny; for
 *   the installed hook: `NOTES_PASTE_STRATEGY=deny scripts/install.sh`.
 * When no image can be found or uploaded the call is allowed unchanged, and the server answers
 * with its explanatory pasted_image error. Calls without pasted_image are not touched.
 *
 * Always exits 0; stdout carries only the hook JSON. Problems go to
 * ${XDG_STATE_HOME:-~/.local/state}/notes-capture/paste.log. Node >= 22 built-ins only.
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';
import { extractImages, findLatestImagePrompt, parseTranscript, pickPastedImage } from './lib/transcript.mjs';

export const TOOL_NAME = 'mcp__notes__similar_images';
export const UPLOAD_PATH = '/api/chat/images';
export const DEFAULT_STRATEGY = 'updatedInput';
export const UPLOAD_TIMEOUT_MS = 15_000;
export const TRANSCRIPT_RETRY_MS = 500;
export const LOG_FILE = 'paste.log';

const UPLOAD_ID = /^[0-9A-Z]-[0-9A-Z]{3}$/;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The N of `pasted_image`, accepting 2 and "2"; null for anything else. */
export function pastedImageNumber(toolInput) {
  const value = toolInput !== null && typeof toolInput === 'object' ? toolInput.pasted_image : undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d{1,4}$/.test(value.trim()) && Number(value.trim()) > 0) return Number(value.trim());
  return null;
}

export function strategyFrom(env) {
  if (env.NOTES_PASTE_STRATEGY === 'deny') return 'deny';
  if (env.NOTES_PASTE_STRATEGY === 'updatedInput') return 'updatedInput';
  return DEFAULT_STRATEGY;
}

export function allowUnchanged() {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
}

function withoutPasted(toolInput, uploadId) {
  const next = {};
  for (const [key, value] of Object.entries(toolInput)) {
    if (key !== 'pasted_image') next[key] = value;
  }
  next.upload_id = uploadId;
  return next;
}

export function rewriteOutput(toolInput, uploadId) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: withoutPasted(toolInput, uploadId),
    },
  };
}

export function denyOutput(toolInput, uploadId) {
  const args = JSON.stringify(withoutPasted(toolInput, uploadId));
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `The pasted image was uploaded as upload_id ${uploadId}. Call ${TOOL_NAME} again with exactly ` +
        `these arguments: ${args}. Do not pass pasted_image.`,
    },
  };
}

/** The upload id in P3's response: `id`, `upload_id` or `image.id`, in the A-B32 form. */
export function uploadIdFrom(body) {
  if (body === null || typeof body !== 'object') return null;
  const nested = body.image !== null && typeof body.image === 'object' ? body.image.id : undefined;
  for (const candidate of [body.id, body.upload_id, nested]) {
    if (typeof candidate === 'string' && UPLOAD_ID.test(candidate)) return candidate;
  }
  return null;
}

export async function uploadImage(image, { fetchImpl, baseUrl, n }) {
  const bytes = Buffer.from(image.data_base64, 'base64');
  const ext = EXTENSIONS[image.media_type] ?? 'bin';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: image.media_type }), `pasted-image-${n}.${ext}`);
  form.append('source', 'claude_code');
  const res = await fetchImpl(`${baseUrl}${UPLOAD_PATH}`, {
    method: 'POST',
    headers: { 'x-notes-capture': '1' },
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const id = uploadIdFrom(await res.json());
  if (id === null) throw new Error('upload answered without an upload id');
  return id;
}

/** Image N of the latest image-carrying human prompt, re-reading once if the transcript lags. */
export async function findPastedImage(transcriptPath, n, { readText, sleep }) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(TRANSCRIPT_RETRY_MS);
    let text;
    try {
      text = await readText(transcriptPath);
    } catch {
      continue;
    }
    const entry = findLatestImagePrompt(parseTranscript(text));
    if (entry !== null) return pickPastedImage(extractImages(entry), n);
  }
  return null;
}

/** The hook decision for one PreToolUse input, or null to stay out of it. Never throws. */
export async function runPaste({
  input,
  env,
  fetchImpl = globalThis.fetch,
  readText = (file) => readFile(file, 'utf8'),
  sleep = delay,
}) {
  const log = (message) => writeLog(stateDir(env), LOG_FILE, message);
  try {
    if (input === null || typeof input !== 'object' || input.tool_name !== TOOL_NAME) return null;
    const toolInput = input.tool_input !== null && typeof input.tool_input === 'object' ? input.tool_input : {};
    const n = pastedImageNumber(toolInput);
    if (n === null) return null;
    const image = await findPastedImage(input.transcript_path, n, { readText, sleep });
    if (image === null) {
      await log(`no pasted image ${n} in ${String(input.transcript_path)}`);
      return allowUnchanged();
    }
    let uploadId;
    try {
      uploadId = await uploadImage(image, { fetchImpl, baseUrl: daemonBaseUrl(env), n });
    } catch (err) {
      await log(`pasted image ${n}: ${errorText(err)}`);
      return allowUnchanged();
    }
    return strategyFrom(env) === 'deny' ? denyOutput(toolInput, uploadId) : rewriteOutput(toolInput, uploadId);
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
    return null;
  }
}

async function main() {
  let output = null;
  try {
    const input = JSON.parse(await readStdin());
    output = await runPaste({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
```

**File:** `claude/hooks/notes-paste.d.mts` (new)
```ts
import type { PastedImage } from './lib/transcript.mjs';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export const TOOL_NAME: string;
export const UPLOAD_PATH: string;
export const DEFAULT_STRATEGY: 'updatedInput' | 'deny';
export const UPLOAD_TIMEOUT_MS: number;
export const TRANSCRIPT_RETRY_MS: number;
export const LOG_FILE: string;

export function pastedImageNumber(toolInput: unknown): number | null;
export function strategyFrom(env: Env): 'updatedInput' | 'deny';
export function allowUnchanged(): PreToolUseOutput;
export function rewriteOutput(toolInput: Record<string, unknown>, uploadId: string): PreToolUseOutput;
export function denyOutput(toolInput: Record<string, unknown>, uploadId: string): PreToolUseOutput;
export function uploadIdFrom(body: unknown): string | null;
export function uploadImage(image: PastedImage, opts: { fetchImpl: FetchLike; baseUrl: string; n: number }): Promise<string>;
export function findPastedImage(
  transcriptPath: unknown,
  n: number,
  io: { readText: (file: string) => Promise<string>; sleep: (ms: number) => Promise<unknown> },
): Promise<PastedImage | null>;
export function runPaste(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  readText?: (file: string) => Promise<string>;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<PreToolUseOutput | null>;
```

### Step 6: Settings merge helper
**File:** `scripts/claude-hooks.mjs` (new)
**Code:**
```js
#!/usr/bin/env node
/**
 * Adds, removes or reports the two mcp-notes Claude Code hooks in a settings.json
 * (normally ~/.claude/settings.json), leaving every other key and every other hook as it was.
 *
 *   node scripts/claude-hooks.mjs install   --settings FILE --node /abs/node --hooks-dir /abs/repo/claude/hooks [--paste-strategy updatedInput|deny]
 *   node scripts/claude-hooks.mjs uninstall --settings FILE
 *   node scripts/claude-hooks.mjs status    --settings FILE
 *
 * Our handlers are recognised by the script name in their command (notes-capture.mjs,
 * notes-paste.mjs), so an entry left by another checkout is replaced, never duplicated. install is
 * idempotent: a second run leaves the file byte-identical. Before the first change to an existing
 * file a copy is kept at FILE.bak-notes-hooks (once; never overwritten). Writes are atomic
 * (temp file + rename) on the symlink target, keeping the file's mode.
 */
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const OUR_SCRIPT = /notes-(?:capture|paste)\.mjs(?=['"\s]|$)/;
export const PASTE_MATCHER = 'mcp__notes__similar_images';
export const BACKUP_SUFFIX = '.bak-notes-hooks';
export const STOP_TIMEOUT_S = 60;
export const PASTE_TIMEOUT_S = 30;
export const PASTE_STRATEGIES = ['updatedInput', 'deny'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** POSIX single-quoting: safe for any path. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(nodeBin, script, env = {}) {
  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shQuote(value)} `)
    .join('');
  return `${prefix}${shQuote(nodeBin)} ${shQuote(script)}`;
}

export function isOurHandler(handler) {
  return isPlainObject(handler) && typeof handler.command === 'string' && OUR_SCRIPT.test(handler.command);
}

function stripOurs(groups) {
  const kept = [];
  let removed = 0;
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = group.hooks.filter((handler) => !isOurHandler(handler));
    removed += group.hooks.length - handlers.length;
    if (handlers.length === group.hooks.length) kept.push(group);
    else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
  }
  return { groups: kept, removed };
}

/** The two matcher groups this repo installs. */
export function ourGroups({ nodeBin, hooksDir, pasteStrategy = 'updatedInput' }) {
  const pasteEnv = pasteStrategy === 'deny' ? { NOTES_PASTE_STRATEGY: 'deny' } : {};
  return {
    Stop: {
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodeBin, path.join(hooksDir, 'notes-capture.mjs')),
          async: true,
          timeout: STOP_TIMEOUT_S,
        },
      ],
    },
    PreToolUse: {
      matcher: PASTE_MATCHER,
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodeBin, path.join(hooksDir, 'notes-paste.mjs'), pasteEnv),
          timeout: PASTE_TIMEOUT_S,
        },
      ],
    },
  };
}

/** `settings` with our handlers removed from every event and our two groups appended last. */
export function mergeHooks(settings, options) {
  const base = isPlainObject(settings) ? settings : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  for (const [event, group] of Object.entries(ourGroups(options))) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...stripOurs(existing).groups, group];
  }
  return { ...base, hooks };
}

/** `settings` without our handlers; events and `hooks` emptied by the removal are dropped. Same object when nothing is ours. */
export function removeHooks(settings) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return settings;
  const hooks = { ...settings.hooks };
  let touched = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const { groups, removed } = stripOurs(hooks[event]);
    if (removed === 0) continue;
    touched = true;
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }
  if (!touched) return settings;
  const out = { ...settings };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  else out.hooks = hooks;
  return out;
}

/** `{event: command}` for each of our handlers present. */
export function ourHandlers(settings) {
  const found = {};
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return found;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (isOurHandler(handler)) found[event] = handler.command;
      }
    }
  }
  return found;
}

export async function readSettings(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, text: null, value: {} };
    throw err;
  }
  if (text.trim() === '') return { exists: true, text, value: {} };
  const value = JSON.parse(text);
  if (!isPlainObject(value)) throw new Error(`${file} does not hold a JSON object`);
  return { exists: true, text, value };
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 'unchanged' when `next` equals what is there; otherwise backs up once, writes atomically, 'written'. */
export async function writeSettings(file, current, next) {
  if (current.exists && JSON.stringify(current.value) === JSON.stringify(next)) return 'unchanged';
  const target = current.exists ? await realpath(file).catch(() => file) : file;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  if (current.exists) {
    mode = (await stat(target)).mode & 0o777;
    const backup = `${file}${BACKUP_SUFFIX}`;
    if (!existsSync(backup)) await copyFile(target, backup);
  }
  const tmp = `${target}.tmp-notes-hooks-${process.pid}`;
  await writeFile(tmp, serialize(next), { mode });
  await rename(tmp, target);
  return 'written';
}

function fail(message) {
  process.stderr.write(`claude-hooks: ${message}\n`);
  process.exit(1);
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      settings: { type: 'string' },
      node: { type: 'string' },
      'hooks-dir': { type: 'string' },
      'paste-strategy': { type: 'string' },
    },
  });
  const command = positionals[0];
  const file = values.settings;
  if (file === undefined || file === '') fail('--settings is required');
  let current;
  try {
    current = await readSettings(file);
  } catch (err) {
    fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (command === 'install') {
    const nodeBin = values.node;
    const hooksDir = values['hooks-dir'];
    const pasteStrategy = values['paste-strategy'] ?? 'updatedInput';
    if (nodeBin === undefined || !path.isAbsolute(nodeBin)) fail('--node must be an absolute path');
    if (hooksDir === undefined || !path.isAbsolute(hooksDir)) fail('--hooks-dir must be an absolute path');
    if (!PASTE_STRATEGIES.includes(pasteStrategy)) fail(`--paste-strategy must be one of ${PASTE_STRATEGIES.join(', ')}`);
    for (const script of ['notes-capture.mjs', 'notes-paste.mjs']) {
      if (!existsSync(path.join(hooksDir, script))) fail(`missing ${path.join(hooksDir, script)}`);
    }
    const result = await writeSettings(file, current, mergeHooks(current.value, { nodeBin, hooksDir, pasteStrategy }));
    process.stdout.write(`${result}: ${file}\n`);
    return;
  }
  if (command === 'uninstall') {
    if (!current.exists) {
      process.stdout.write(`unchanged: ${file} (absent)\n`);
      return;
    }
    const result = await writeSettings(file, current, removeHooks(current.value));
    process.stdout.write(`${result}: ${file}\n`);
    return;
  }
  if (command === 'status') {
    const found = ourHandlers(current.value);
    process.stdout.write(`Stop notes-capture: ${found.Stop ?? 'not registered'}\n`);
    process.stdout.write(`PreToolUse notes-paste: ${found.PreToolUse ?? 'not registered'}\n`);
    return;
  }
  fail('usage: claude-hooks.mjs install|uninstall|status --settings FILE [--node ABS --hooks-dir ABS --paste-strategy updatedInput|deny]');
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
```

**File:** `scripts/claude-hooks.d.mts` (new)
```ts
export interface HookOptions {
  nodeBin: string;
  hooksDir: string;
  pasteStrategy?: 'updatedInput' | 'deny';
}
export interface SettingsFile {
  exists: boolean;
  text: string | null;
  value: Record<string, unknown>;
}
export const OUR_SCRIPT: RegExp;
export const PASTE_MATCHER: string;
export const BACKUP_SUFFIX: string;
export const STOP_TIMEOUT_S: number;
export const PASTE_TIMEOUT_S: number;
export const PASTE_STRATEGIES: string[];
export function shQuote(value: string): string;
export function hookCommand(nodeBin: string, script: string, env?: Record<string, string>): string;
export function isOurHandler(handler: unknown): boolean;
export function ourGroups(options: HookOptions): Record<'Stop' | 'PreToolUse', Record<string, unknown>>;
export function mergeHooks(settings: unknown, options: HookOptions): Record<string, unknown>;
export function removeHooks<T>(settings: T): T;
export function ourHandlers(settings: unknown): Record<string, string>;
export function readSettings(file: string): Promise<SettingsFile>;
export function serialize(value: unknown): string;
export function writeSettings(file: string, current: SettingsFile, next: unknown): Promise<'unchanged' | 'written'>;
```

### Step 7: `install.sh` registers the hooks
**File:** `scripts/install.sh`

**7a. Header (replace l.1-15):**
```bash
#!/usr/bin/env bash
# Install or refresh notesd as a systemd user service, register it with Claude Code as the
# `notes` MCP server (user scope), link the /n skill into ~/.claude/skills/n, and register the
# mcp-notes Claude Code hooks (notes-capture: Stop, saves /n exchanges to the chat history;
# notes-paste: PreToolUse on similar_images, uploads a pasted image) in ~/.claude/settings.json.
#
# Idempotent: run it again after every pull. The unit runs code from the checkout this script
# lives in, so run it from the checkout you want the daemon to use (normally ~/mcp-notes).
#
# Flags:
#   --skip-hooks    do not touch ~/.claude/settings.json (same as NOTES_SKIP_HOOKS=1)
#
# Env overrides:
#   NODE_BIN        absolute path to a Node >= 22 binary (default: `node` on PATH, then
#                   ~/tools/node-v22.23.1-linux-x64/bin/node)
#   CLAUDE_BIN      path to the claude CLI (default: `claude` on PATH, then next to node). The
#                   unit gets its real path (readlink -f) as NOTESD_CLAUDE_BIN for the chat bar.
#   NOTES_DATA_DIR  data dir (default: ~/mcp-notes-data)
#   SKIP_CHAT_CHECK set to 1 to skip the chat smoke check in the verification (offline runs)
#   NOTES_SKIP_HOOKS set to 1 to leave ~/.claude/settings.json alone
#   NOTES_PASTE_STRATEGY  `deny` registers the paste hook in its fallback mode (see
#                   claude/hooks/notes-paste.mjs); default `updatedInput`
set -euo pipefail
```

**7b. New variables (insert after l.35, the `CHAT_SMOKE_MESSAGE=` line):**
```bash
HOOKS_DIR="$REPO_DIR/claude/hooks"
HOOKS_HELPER="$REPO_DIR/scripts/claude-hooks.mjs"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
SKIP_HOOKS="${NOTES_SKIP_HOOKS:-0}"
PASTE_STRATEGY="${NOTES_PASTE_STRATEGY:-updatedInput}"
```

**7c. New function `parse_args` (insert after `die()`, l.39):**
```bash
parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --skip-hooks) SKIP_HOOKS=1 ;;
      -h|--help)
        sed -n '2,26p' "${BASH_SOURCE[0]}"
        exit 0
        ;;
      *) die "unknown argument: $arg (try --help)" ;;
    esac
  done
}
```

**7d. `check_preconditions` (replace l.71-92 whole function):**
```bash
check_preconditions() {
  command -v curl >/dev/null || die "curl is required."
  command -v systemctl >/dev/null || die "systemctl not found: systemd is required (WSL: [boot] systemd=true in /etc/wsl.conf)."
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "cannot reach the systemd user manager (systemctl --user). Is systemd enabled in this distro?"
  [[ -f "$UNIT_TEMPLATE" ]] || die "missing $UNIT_TEMPLATE."
  local sk
  for sk in "${SKILL_NAMES[@]}"; do
    [[ -f "$SKILLS_SRC_DIR/$sk/SKILL.md" ]] || die "missing $SKILLS_SRC_DIR/$sk/SKILL.md."
  done
  [[ -f "$REPO_DIR/package-lock.json" ]] || die "missing $REPO_DIR/package-lock.json."
  local hk
  for hk in "$HOOKS_DIR/notes-capture.mjs" "$HOOKS_DIR/notes-paste.mjs" "$HOOKS_HELPER"; do
    [[ -f "$hk" ]] || die "missing $hk."
  done
  [[ "$PASTE_STRATEGY" == "updatedInput" || "$PASTE_STRATEGY" == "deny" ]] \
    || die "NOTES_PASTE_STRATEGY must be updatedInput or deny (got $PASTE_STRATEGY)."
  local p
  for p in "$REPO_DIR" "$NODE_BIN" "$NODE_DIR" "$DATA_DIR" "$CLAUDE_REAL" "$HOME"; do
    [[ "$p" != *'|'* && "$p" != *'&'* && "$p" != *'\'* ]] \
      || die "path contains a character the unit renderer cannot handle (| & \\): $p"
  done
  for sk in "${SKILL_NAMES[@]}"; do
    if [[ -e "$SKILLS_DIR/$sk" && ! -L "$SKILLS_DIR/$sk" ]]; then
      die "$SKILLS_DIR/$sk exists and is not a symlink. Move it away, then re-run (refusing to clobber a real directory)."
    fi
  done
}
```

**7e. New function `register_hooks` (insert after `link_skill`, after l.212):**
```bash
# Merge the two hook entries into ~/.claude/settings.json (user scope: every repo). Everything
# else in the file is kept; a copy of the original is kept once at settings.json.bak-notes-hooks.
# A failure here warns and leaves the file alone: the daemon install is not undone for it.
register_hooks() {
  if [[ "$SKIP_HOOKS" == 1 ]]; then
    log "skipping Claude Code hooks (--skip-hooks / NOTES_SKIP_HOOKS=1)"
    return 0
  fi
  log "registering Claude Code hooks (notes-capture, notes-paste) in $CLAUDE_SETTINGS"
  "$NODE_BIN" "$HOOKS_HELPER" install \
    --settings "$CLAUDE_SETTINGS" \
    --node "$NODE_BIN" \
    --hooks-dir "$HOOKS_DIR" \
    --paste-strategy "$PASTE_STRATEGY" \
    || warn "could not update $CLAUDE_SETTINGS; /n exchanges will not be captured. Fix the file and re-run, or pass --skip-hooks."
}
```

**7f. `verify` (replace l.243-271 whole function; one block added after the skill lines):**
```bash
verify() {
  local ok=1 active health mcp_line
  printf '\n--- verification ---\n'
  active="$(systemctl --user is-active "$UNIT_NAME" 2>&1 || true)"
  printf 'systemctl --user is-active %s: %s\n' "$UNIT_NAME" "$active"
  [[ "$active" == "active" ]] || ok=0
  if health="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>&1)"; then
    printf 'GET %s: %s\n' "$HEALTH_URL" "$health"
  else
    printf 'GET %s: FAILED (%s)\n' "$HEALTH_URL" "$health"
    ok=0
  fi
  mcp_line="$("$CLAUDE_BIN" mcp list 2>&1 | grep -E '^notes: ' || true)"
  printf 'claude mcp list: %s\n' "${mcp_line:-<notes not listed>}"
  [[ "$mcp_line" == *Connected* ]] || ok=0
  printf 'chat bar claude: %s (%s)\n' "$CLAUDE_REAL" "$("$CLAUDE_REAL" --version 2>/dev/null || echo 'version unknown')"
  chat_smoke || ok=0
  for sk in "${SKILL_NAMES[@]}"; do
    printf 'skill: %s -> %s\n' "$SKILLS_DIR/$sk" "$(readlink "$SKILLS_DIR/$sk")"
  done
  if [[ "$SKIP_HOOKS" == 1 ]]; then
    printf 'claude hooks: skipped\n'
  else
    "$NODE_BIN" "$HOOKS_HELPER" status --settings "$CLAUDE_SETTINGS" 2>&1 | sed 's/^/claude hook: /' || true
  fi
  printf 'linger: %s\n' "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
  printf 'unit runs: %s/dist/main.js\n' "$REPO_DIR"
  if [[ "$REPO_DIR" == "$HOME/.worktrees/"* ]]; then
    warn "the unit, the skill and the hooks point at a worktree ($REPO_DIR). After the branch lands, re-run: cd ~/mcp-notes && git pull && scripts/install.sh"
  fi
  printf 'Windows side (keeps WSL up at logon): see docs/INSTALL.md, scripts/windows/install-wsl-keepalive.ps1\n'
  (( ok == 1 )) || die "verification failed."
  printf 'OK\n'
}
```

**7g. `main` and the source guard (replace l.273-290):**
```bash
main() {
  parse_args "$@"
  resolve_node
  resolve_claude
  check_preconditions
  check_claude_login
  check_env_file
  install_deps
  build
  make_data_dir
  install_unit
  enable_linger
  wait_for_health
  register_mcp
  link_skill
  register_hooks
  verify
}

# Run only when executed; `source scripts/install.sh` (the tests) just defines the functions.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```
**Impact:** `install.sh` now edits `~/.claude/settings.json`. Hooks are registered after the daemon has been rebuilt and restarted, so a fresh hook never talks to a daemon without the route.

### Step 8: `uninstall.sh` removes exactly our entries
**File:** `scripts/uninstall.sh` (rewrite whole file)
**Code:**
```bash
#!/usr/bin/env bash
# Undo scripts/install.sh on the WSL side: stop and remove the notesd user unit, unregister the
# `notes` MCP server (user scope), remove the /n skill symlink, and remove the notes-capture and
# notes-paste hook entries from ~/.claude/settings.json (every other setting and hook is kept).
# Keeps the data dir (~/mcp-notes-data), linger, the hooks' outbox and logs
# (~/.local/state/notes-capture) and settings.json.bak-notes-hooks. The Windows keepalive task is
# removed by scripts/windows/install-wsl-keepalive.ps1 -Uninstall.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_NAME="notesd.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SKILL_DST="$HOME/.claude/skills/n"
DATA_DIR="${NOTES_DATA_DIR:-$HOME/mcp-notes-data}"
DEFAULT_CLAUDE="$HOME/tools/node-v22.23.1-linux-x64/bin/claude"
DEFAULT_NODE="$HOME/tools/node-v22.23.1-linux-x64/bin/node"
HOOKS_HELPER="$REPO_DIR/scripts/claude-hooks.mjs"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

remove_unit() {
  if [[ -f "$UNIT_DIR/$UNIT_NAME" ]]; then
    log "stopping and disabling $UNIT_NAME"
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT_NAME"
    systemctl --user daemon-reload
    systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
  else
    log "no unit at $UNIT_DIR/$UNIT_NAME"
  fi
}

remove_mcp() {
  local claude_bin="${CLAUDE_BIN:-$(command -v claude || true)}"
  if [[ -z "$claude_bin" && -x "$DEFAULT_CLAUDE" ]]; then claude_bin="$DEFAULT_CLAUDE"; fi
  if [[ -n "$claude_bin" ]]; then
    log "removing MCP server 'notes' (user scope)"
    "$claude_bin" mcp remove --scope user notes >/dev/null 2>&1 || log "'notes' was not registered"
  else
    warn "claude CLI not found; remove the MCP server by hand: claude mcp remove --scope user notes"
  fi
}

remove_skill() {
  if [[ -L "$SKILL_DST" ]]; then
    log "removing skill symlink $SKILL_DST"
    rm -f "$SKILL_DST"
  elif [[ -e "$SKILL_DST" ]]; then
    warn "$SKILL_DST is not a symlink; left alone"
  fi
}

unregister_hooks() {
  if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
    log "no $CLAUDE_SETTINGS; no hooks to remove"
    return 0
  fi
  local node_bin="${NODE_BIN:-$(command -v node || true)}"
  if [[ -z "$node_bin" && -x "$DEFAULT_NODE" ]]; then node_bin="$DEFAULT_NODE"; fi
  if [[ -z "$node_bin" ]]; then
    warn "node not found; remove the notes-capture and notes-paste entries from $CLAUDE_SETTINGS by hand"
    return 0
  fi
  log "removing the notes-capture and notes-paste hooks from $CLAUDE_SETTINGS"
  "$node_bin" "$HOOKS_HELPER" uninstall --settings "$CLAUDE_SETTINGS" \
    || warn "could not edit $CLAUDE_SETTINGS; remove the notes-capture and notes-paste entries by hand"
}

main() {
  remove_unit
  remove_mcp
  remove_skill
  unregister_hooks
  printf '\nKept: data dir %s (delete by hand if you mean it), linger (sudo loginctl disable-linger %s).\n' "$DATA_DIR" "${USER:-$(id -un)}"
  printf 'Windows: powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-wsl-keepalive.ps1 -Uninstall\n'
}

# Run only when executed; `source scripts/uninstall.sh` (the tests) just defines the functions.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```
**Impact:** same observable behaviour as today plus the hook removal.

### Steps 9-11: No table, no migration — P7's `recordExchange` is the ledger
P7 (`phase-7.md`) already gives `chat_threads.external_key` (unique) and
`ChatService.recordExchange(input: RecordExchangeInput): Promise<RecordedExchange>`, which in one
transaction finds the thread by key or inserts it (`insertThread` returning null on a lost race →
re-read the winner), inserts the user message with its attachments and the assistant message, and
emits `event: chat created` per message only when it wrote. That is exactly the idempotent,
atomic write this phase needs, so P8 adds **no** table, migration, repo module or `ChatService`
method, and does not touch `tests/integration/setup.ts`. Thread rows are never hard-deleted by P7
(messages are soft-deleted), so a replay of a capture whose bubbles were deleted on the history
page stays a duplicate and does not resurrect them.

### Step 12: Capture service
**File:** `src/chat/capture.ts` (new)
**Code:**
```ts
import type { AppDeps } from '../deps.js';
import { ChatImageInputError, chatImageStoreFor, ingestChatImage } from './images.js';

/** Per-image cap for captures (below P3's 50 MB upload cap; Claude Code pastes are a few MB). */
export const MAX_CAPTURED_IMAGE_BYTES = 20 * 1024 * 1024;

export const CAPTURE_SOURCE = 'claude_code' as const;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface ClaudeCodeCaptureInput {
  claudeSession: string;
  userUuid: string;
  /** The prompt as typed, `/n ...`. */
  prompt: string;
  /** The final answer; '' when there was none (no assistant message is written). */
  answer: string;
  promptAt: Date;
  answeredAt: Date;
  images: { mediaType: string; bytes: Buffer }[];
}

export interface CaptureResult {
  /** True when this exchange was captured before: nothing was written now. */
  duplicate: boolean;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string | null;
}

/** An image the chat image store refused; `index` is its position in the request. */
export class CaptureImageError extends Error {
  constructor(
    readonly index: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureImageError';
  }
}

export function captureExternalKey(claudeSession: string, userUuid: string): string {
  return `${claudeSession}:${userUuid}`;
}

/**
 * Stores a Claude Code `/n` exchange as a single-turn `claude_code` thread. Pasted images go
 * into P3's chat image store first (sha-deduped, so a replay stores nothing new; outside the DB
 * transaction because it writes files), then P7's `recordExchange` writes thread, messages and
 * attachments atomically and idempotently on `<claude_session>:<user_uuid>`.
 */
export async function captureClaudeCodeExchange(deps: AppDeps, input: ClaudeCodeCaptureInput): Promise<CaptureResult> {
  const externalKey = captureExternalKey(input.claudeSession, input.userUuid);
  const store = chatImageStoreFor(deps);
  const imageIds: string[] = [];
  for (const [index, image] of input.images.entries()) {
    try {
      const stored = await ingestChatImage(store, {
        bytes: image.bytes,
        originalName: `claude-code-paste-${index + 1}.${EXTENSIONS[image.mediaType] ?? 'bin'}`,
        source: CAPTURE_SOURCE,
        maxBytes: MAX_CAPTURED_IMAGE_BYTES,
      });
      if (!imageIds.includes(stored.image.id)) imageIds.push(stored.image.id);
    } catch (err) {
      if (err instanceof ChatImageInputError) throw new CaptureImageError(index, err.code, err.message);
      throw err;
    }
  }

  const minAnswerMs = input.promptAt.getTime() + 1;
  const assistantAt = input.answeredAt.getTime() < minAnswerMs ? new Date(minAnswerMs) : input.answeredAt;
  const recorded = await deps.chat.recordExchange({
    source: CAPTURE_SOURCE,
    externalKey,
    brain: null,
    user: {
      text: input.prompt,
      createdAt: input.promptAt,
      attachments: imageIds.map((id) => ({ kind: 'chat_image' as const, id })),
    },
    assistant: input.answer.trim() !== '' ? { text: input.answer, createdAt: assistantAt } : null,
  });
  const [userMessageId, assistantMessageId] = recorded.messageIds;
  if (userMessageId === undefined) throw new Error(`captured thread ${recorded.thread.id} has no messages`);
  return {
    duplicate: !recorded.created,
    threadId: recorded.thread.id,
    userMessageId,
    assistantMessageId: assistantMessageId ?? null,
  };
}
```
**Impact:** `deps.chat` is P7's `ChatService` (P7 renames the old backend local to `backend` inside `apiRoutes`). `recordExchange` returns the thread's message ids ascending (deleted included), so for a captured thread `[user, assistant?]`.

### Step 13: Endpoint
**File:** `src/http/capture.ts` (new)
**Code:**
```ts
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { CaptureImageError, MAX_CAPTURED_IMAGE_BYTES, captureClaudeCodeExchange } from '../chat/capture.js';
import type { AppDeps } from '../deps.js';
import { isLoopbackUrl } from './sameOrigin.js';

export const CAPTURE_PATH = '/api/capture/claude-code';
/** Lower-case header name. A custom header forces a CORS preflight, which notesd never answers. */
export const CAPTURE_HEADER = 'x-notes-capture';
export const MAX_CAPTURE_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_CAPTURE_IMAGES = 8;
export const MAX_CAPTURE_IMAGE_BYTES = MAX_CAPTURED_IMAGE_BYTES;
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_ANSWER_CHARS = 1_000_000;
export const CAPTURE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isoInstant = z
  .string()
  .regex(ISO_INSTANT, 'expected an ISO 8601 UTC or offset datetime')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a valid datetime');

const captureSchema = z.object({
  claude_session: z.string().trim().min(1).max(200),
  user_uuid: z.string().trim().min(1).max(200),
  prompt: z
    .string()
    .max(MAX_PROMPT_CHARS)
    .refine((value) => value.trim().length > 0, 'prompt is empty'),
  answer: z.string().max(MAX_ANSWER_CHARS),
  prompt_timestamp: isoInstant,
  answered_at: isoInstant,
  /** Accepted for forward compatibility; P7's thread has no column for it, so it is not stored. */
  cwd: z.string().max(4096).nullable().optional(),
  images: z
    .array(z.object({ media_type: z.enum(CAPTURE_MEDIA_TYPES), data_base64: z.string().min(1) }))
    .max(MAX_CAPTURE_IMAGES)
    .default([]),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

/** Strict standard base64 (whitespace ignored) -> bytes; null when it is not base64. */
export function decodeImageBase64(data: string): Buffer | null {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

/**
 * Who may post a capture: a loopback request URL (DNS-rebinding guard, as /mcp), no Origin or a
 * loopback one (a page elsewhere cannot post), the `X-Notes-Capture: 1` header (a browser cannot
 * add it cross-origin without a preflight that is never answered), and a JSON body.
 */
export const captureGuard: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url)) return c.json({ error: 'forbidden_host' }, 403);
  const origin = c.req.header('origin');
  if (origin !== undefined && !isLoopbackUrl(origin)) return c.json({ error: 'forbidden_origin' }, 403);
  if (c.req.header(CAPTURE_HEADER) !== '1') return c.json({ error: 'capture_header_required' }, 403);
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== 'application/json') return c.json({ error: 'json_required' }, 415);
  await next();
};

/**
 * POST /api/capture/claude-code: one `/n` exchange from the notes-capture Stop hook.
 * 201 {thread_id, user_message_id, assistant_message_id} when stored; 200 {duplicate: true, ...}
 * when `<claude_session>:<user_uuid>` was captured before (nothing written). 400 bad JSON /
 * validation / base64, 403 guard, 413 body or image too large, 415 not JSON or an image the store
 * refuses.
 */
export function captureRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.post(
    CAPTURE_PATH,
    captureGuard,
    bodyLimit({
      maxSize: MAX_CAPTURE_BODY_BYTES,
      onError: (c) => c.json({ error: 'too_large', max_bytes: MAX_CAPTURE_BODY_BYTES }, 413),
    }),
    async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = captureSchema.safeParse(json);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const body = parsed.data;

      const images: { mediaType: string; bytes: Buffer }[] = [];
      for (const [index, image] of body.images.entries()) {
        const bytes = decodeImageBase64(image.data_base64);
        if (bytes === null || bytes.length === 0) return c.json({ error: 'invalid_base64', index }, 400);
        if (bytes.length > MAX_CAPTURE_IMAGE_BYTES) {
          return c.json({ error: 'image_too_large', index, max_bytes: MAX_CAPTURE_IMAGE_BYTES }, 413);
        }
        images.push({ mediaType: image.media_type, bytes });
      }

      try {
        const result = await captureClaudeCodeExchange(deps, {
          claudeSession: body.claude_session,
          userUuid: body.user_uuid,
          prompt: body.prompt,
          answer: body.answer,
          promptAt: new Date(body.prompt_timestamp),
          answeredAt: new Date(body.answered_at),
          images,
        });
        const ids = {
          thread_id: result.threadId,
          user_message_id: result.userMessageId,
          assistant_message_id: result.assistantMessageId,
        };
        return result.duplicate ? c.json({ duplicate: true, ...ids }, 200) : c.json(ids, 201);
      } catch (err) {
        if (err instanceof CaptureImageError) {
          const tooLarge = err.code === 'too_large';
          return c.json(
            { error: tooLarge ? 'image_too_large' : 'unsupported_image', index: err.index, message: err.message },
            tooLarge ? 413 : 415,
          );
        }
        throw err;
      }
    },
  );
  return r;
}
```

### Step 14: Mount the route
**File:** `src/http/app.ts`, as P3 (Step 9), P4 (Step 13), P6 (`mcpToolDeps`) and P7 (Step 18) left it.
**Change 1:** add the import after P4's `import { fileRoutes } from './files.js';`:
```ts
import { captureRoutes } from './capture.js';
```
**Change 2:** the `createApp` doc comment, as P4 wrote it plus P7's `chatHistoryRoutes` insertion, becomes:
```ts
/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), chatHistoryRoutes (chat history phase 7), imageRoutes (P5),
 * chatImageRoutes (pasted chat images), fileRoutes (note files), revealRoutes (iteration 7:
 * capabilities + reveal; note files add file and note reveal), captureRoutes (Claude Code `/n`
 * capture, loopback + X-Notes-Capture only), staticRoutes (P6, last: it owns the SPA fallback; it
 * reserves /api, so the order is for clarity).
 */
```
**Change 3:** the mount block after P3/P4/P7 reads as below; the only new line is `captureRoutes`:
```ts
  app.route('/', apiRoutes(deps, { chat: options.chat }));
  app.route('/', chatHistoryRoutes(deps));
  app.route('/', imageRoutes(deps));
  app.route('/', chatImageRoutes(deps));
  app.route('/', fileRoutes(deps));
  app.route('/', revealRoutes(deps, { reveal: options.reveal }));
  app.route('/', captureRoutes(deps));
  app.route('/', staticRoutes(deps));
```
`mcpToolDeps` (P6: passes `imageEmbedder` and `chatUploads`) is not touched.

### Step 15: Final `pasted_image` text in `similar_images`
**File:** `src/mcp/similarTools.ts` (P6; A4). Keep P6's constant name `PASTED_IMAGE_NEEDS_HOOK` and its use (`if (args.pasted_image !== undefined) return fail(PASTED_IMAGE_NEEDS_HOOK);`) so no import changes; replace its doc comment and text, and the `pasted_image` field's `.describe(...)`. Locate both by name (the `export const PASTED_IMAGE_NEEDS_HOOK =` declaration with the doc comment line above it, and the `pasted_image: z` entry of `inputSchema`) and replace them whole, whatever P6's exact wording (P6's provisional text names the `notes-paste` hook and asks for `scripts/install.sh`).
**Code (constant, replaces P6's definition):**
```ts
/**
 * Answer to a similar_images call that still carries pasted_image. With the notes-paste
 * PreToolUse hook installed (phase 8) the daemon never sees pasted_image: the hook uploads the
 * pasted image and rewrites the call to upload_id. Reaching this means the hook is missing, found
 * no pasted image, or could not upload it.
 */
export const PASTED_IMAGE_NEEDS_HOOK =
  'pasted_image could not be resolved: the call reached the server without an upload_id, so the ' +
  "Claude Code notes-paste hook did not upload a pasted image. Either the user's recent messages carry " +
  'no pasted image, or the hook is not installed (run scripts/install.sh in ~/mcp-notes, then restart ' +
  'Claude Code). Ask the user to paste the image again in the same message as the request, or call ' +
  'similar_images with image_id (a picture already in a note) or query (words) instead.';
```
**Code (field, replaces P6's `pasted_image` entry in `inputSchema`):**
```ts
        pasted_image: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            'Claude Code only: N of "[Image #N]" for an image pasted into the conversation, 1 for the first. ' +
              'A pasted image has no file path; the notes-paste hook uploads it and replaces this with upload_id ' +
              'before the call arrives.',
          ),
```
**Impact:** P6's `tests/unit/similarTools.test.ts` assertions (`toContain('scripts/install.sh')`, `toContain('image_id')`) still hold. P6's integration case is updated in Step 26. P6's instructions paragraph (`src/mcp/instructions.ts`) describes `pasted_image` neutrally and needs no change.

### Step 16: `/n` skill
**File:** `claude/skills/n/SKILL.md`, section `## Images`. **Replace** P6's bullet that starts "- An image the user pasted into this conversation plus "find similar" → `similar_images` with `pasted_image: 1` …" (locate it by those opening words; P6's bullet goes on to say what to do if the notes-paste hook is not installed) with:
```markdown
- An image the user pasted into this conversation shows as `[Image #1]`, `[Image #2]`, … in
  their message and has no file path. "Find photos like this", "do I have similar pictures" →
  call `similar_images` with `pasted_image: 1` (the number in `[Image #N]`; 1 for the first or
  only one). A hook uploads that image and the server searches with it. Then call
  `view_images` on the top hits (their note ids or image ids) so you actually see them, and say
  how each one matches. If `similar_images` answers that the pasted image could not be resolved,
  tell the user in one line and ask them to paste the image again together with the request.
  Never ask for a file path for a pasted image, and never save it as a note unless asked.
```
And add a short section before `## Deleting`:
```markdown
## Chat history

Every `/n` exchange (the prompt as typed, your final answer and any pasted images) is saved to
the wall's chat history by a Claude Code hook after you answer. You do not save it yourself and
need not mention it, unless the user asks where their `/n` conversations go: the wall's chat
history page, badged "claude code".
```

### Step 17: Test setup
No change: P8 adds no table, and P7 already lists `chat_threads` and friends in `truncateAll`.

### Step 18: Unit test fixtures
**File:** `tests/unit/hooks/fixtures.ts` (new)
**Code:**
```ts
import { randomUUID } from 'node:crypto';

/** Shapes copied from real Claude Code 2.1.314 transcripts (values made up). */
export const SESSION = '0ef363d6-0bdd-4a15-aff7-71f0821bd6ee';
export const CWD = '/tmp/notes-demo';
/** A valid 16x16 red PNG (sharp-generated). */
export const RED_PNG_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWO4o6FBEmIY1aAxGkp3hmvSAAAyBCwQ7wckpgAAAABJRU5ErkJggg==';
export const BLUE_DATA = 'Ymx1ZS1pbWFnZS1ieXRlcw==';

type Entry = Record<string, unknown>;

let clock = Date.parse('2026-10-30T11:53:23.611Z');
function ts(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function base(overrides: Entry): Entry {
  return {
    parentUuid: randomUUID(),
    isSidechain: false,
    uuid: randomUUID(),
    timestamp: ts(),
    userType: 'external',
    entrypoint: 'cli',
    cwd: CWD,
    sessionId: SESSION,
    version: '2.1.314',
    gitBranch: 'HEAD',
    ...overrides,
  };
}

/** `/n args` as Claude Code writes a typed slash command (string content). */
export function commandEntry(args: string, overrides: Entry = {}): Entry {
  return base({
    promptId: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: `<command-message>n</command-message>\n<command-name>/n</command-name>\n<command-args>${args}</command-args>`,
    },
    origin: { kind: 'human' },
    turnOrigin: 'human',
    ...overrides,
  });
}

/** The skill body Claude Code injects after a slash command (isMeta). */
export function skillBodyEntry(): Entry {
  return base({
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/u/.claude/skills/n\n\n# /n — mcp-notes' }] },
  });
}

/** A typed prompt with pasted images (array content, imagePasteIds). */
export function imagePromptEntry(
  text: string,
  images: { media_type: string; data: string }[],
  pasteIds: number[] | null = images.map((_, i) => i + 1),
  overrides: Entry = {},
): Entry {
  return base({
    promptId: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
      ],
    },
    ...(pasteIds !== null ? { imagePasteIds: pasteIds } : {}),
    origin: { kind: 'human' },
    promptSource: 'typed',
    ...overrides,
  });
}

/** A plain typed prompt (string content). */
export function plainPromptEntry(text: string, overrides: Entry = {}): Entry {
  return base({ promptId: randomUUID(), type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' }, ...overrides });
}

export function assistantText(text: string, overrides: Entry = {}): Entry {
  return base({
    type: 'assistant',
    message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text }] },
    ...overrides,
  });
}

export function assistantToolUse(id: string, name: string, input: Record<string, unknown>): Entry {
  return base({
    type: 'assistant',
    message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

/** A tool result: also a `type: 'user'` entry. */
export function toolResultEntry(toolUseId: string, text: string): Entry {
  return base({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] },
    toolUseResult: [{ type: 'text', text }],
  });
}

/** What `/clear` leaves: a meta caveat and a command entry without origin. */
export function localCommandEntries(): Entry[] {
  return [
    base({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code…</local-command-caveat>' } }),
    base({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' } }),
  ];
}

export function attachmentEntry(): Entry {
  return { type: 'attachment', uuid: randomUUID(), timestamp: ts() };
}

export function jsonl(entries: Entry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}
```

### Step 19: Transcript tests
**File:** `tests/unit/hooks/transcript.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  extractImages,
  findLatestImagePrompt,
  findTurn,
  isHumanPrompt,
  isNotesPrompt,
  parseTranscript,
  pickPastedImage,
  promptText,
} from '../../../claude/hooks/lib/transcript.mjs';
import {
  BLUE_DATA,
  RED_PNG_16,
  assistantText,
  assistantToolUse,
  attachmentEntry,
  commandEntry,
  imagePromptEntry,
  jsonl,
  localCommandEntries,
  plainPromptEntry,
  skillBodyEntry,
  toolResultEntry,
} from './fixtures.js';

describe('parseTranscript', () => {
  it('skips blank, malformed and torn lines', () => {
    const text = `${jsonl([commandEntry('a')])}\nnot json\n{"type":"user","message":{"ro`;
    const entries = parseTranscript(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('user');
  });
});

describe('promptText / isNotesPrompt', () => {
  it('turns the string-form /n command entry into what was typed', () => {
    const entry = commandEntry('show me the notes tagged #agentic');
    expect(isHumanPrompt(entry)).toBe(true);
    expect(promptText(entry)).toBe('/n show me the notes tagged #agentic');
    expect(isNotesPrompt(entry)).toBe(true);
  });

  it('handles /n with no args and the other tag order', () => {
    expect(promptText(commandEntry(''))).toBe('/n');
    const swapped = commandEntry('x', {
      message: { role: 'user', content: '<command-name>/n</command-name>\n<command-message>n</command-message>\n<command-args>find red cars</command-args>' },
    });
    expect(promptText(swapped)).toBe('/n find red cars');
    expect(isNotesPrompt(swapped)).toBe(true);
  });

  it('reads an array-form prompt typed as /n with a pasted image', () => {
    const entry = imagePromptEntry('/n find photos like this\n[Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]);
    expect(promptText(entry)).toBe('/n find photos like this\n[Image #1]');
    expect(isNotesPrompt(entry)).toBe(true);
  });

  it('does not take other commands or a mid-text /n for /n', () => {
    expect(isNotesPrompt(plainPromptEntry('/notes list'))).toBe(false);
    expect(isNotesPrompt(plainPromptEntry('/new thing'))).toBe(false);
    expect(isNotesPrompt(plainPromptEntry('please run /n later'))).toBe(false);
    expect(isNotesPrompt(plainPromptEntry('  /n leading spaces'))).toBe(true);
    const other = commandEntry('x', { message: { role: 'user', content: '<command-message>migrate</command-message>\n<command-name>/migrate</command-name>\n<command-args>dir #t</command-args>' } });
    expect(isNotesPrompt(other)).toBe(false);
  });

  it('never treats tool results, meta entries, sidechains or compact summaries as prompts', () => {
    expect(isHumanPrompt(toolResultEntry('t1', 'ok'))).toBe(false);
    expect(isHumanPrompt(skillBodyEntry())).toBe(false);
    expect(isHumanPrompt(commandEntry('x', { isSidechain: true }))).toBe(false);
    expect(isHumanPrompt(plainPromptEntry('summary', { isCompactSummary: true }))).toBe(false);
    expect(isHumanPrompt(plainPromptEntry('<local-command-stdout>done</local-command-stdout>'))).toBe(false);
    expect(isHumanPrompt(commandEntry('x', { origin: { kind: 'task-notification' } }))).toBe(false);
  });
});

describe('extractImages / pickPastedImage', () => {
  it('pairs image blocks with imagePasteIds in order', () => {
    const entry = imagePromptEntry('two', [
      { media_type: 'image/png', data: RED_PNG_16 },
      { media_type: 'image/jpeg', data: BLUE_DATA },
    ], [3, 4]);
    const images = extractImages(entry);
    expect(images.map((i) => [i.media_type, i.paste_id])).toEqual([['image/png', 3], ['image/jpeg', 4]]);
    expect(pickPastedImage(images, 4)?.data_base64).toBe(BLUE_DATA);
    expect(pickPastedImage(images, 1)?.data_base64).toBe(RED_PNG_16);
    expect(pickPastedImage(images, 2)?.data_base64).toBe(BLUE_DATA);
    expect(pickPastedImage(images, 9)).toBeNull();
    expect(pickPastedImage(images, 0)).toBeNull();
  });

  it('falls back to block order without imagePasteIds', () => {
    const entry = imagePromptEntry('two', [
      { media_type: 'image/png', data: RED_PNG_16 },
      { media_type: 'image/jpeg', data: BLUE_DATA },
    ], null);
    expect(extractImages(entry).map((i) => i.paste_id)).toEqual([1, 2]);
  });
});

describe('findTurn', () => {
  it('finds the /n command across the skill body, tool calls and attachments, and keeps only the final text', () => {
    const entries = parseTranscript(
      jsonl([
        ...localCommandEntries(),
        commandEntry('show me the notes tagged #agentic'),
        skillBodyEntry(),
        attachmentEntry(),
        assistantText('Let me look.'),
        assistantToolUse('t1', 'mcp__notes__list', { tags_any: ['agentic'] }),
        toolResultEntry('t1', '{"notes":[]}'),
        assistantText('Two notes are tagged #agentic.'),
        assistantText('A-B32 and C-D45.'),
      ]),
    );
    const turn = findTurn(entries);
    expect(turn).not.toBeNull();
    expect(promptText(turn!.prompt)).toBe('/n show me the notes tagged #agentic');
    expect(turn!.answer).toBe('Two notes are tagged #agentic.\n\nA-B32 and C-D45.');
    expect(turn!.answeredAt).not.toBeNull();
  });

  it('picks the latest prompt: a later non-/n turn is not a notes turn', () => {
    const entries = parseTranscript(
      jsonl([commandEntry('first'), assistantText('one'), plainPromptEntry('thanks, now fix the build'), assistantText('done')]),
    );
    const turn = findTurn(entries)!;
    expect(isNotesPrompt(turn.prompt)).toBe(false);
    expect(turn.answer).toBe('done');
  });

  it('a later /n turn after an ordinary one is found', () => {
    const entries = parseTranscript(jsonl([plainPromptEntry('hello'), assistantText('hi'), commandEntry('second'), assistantText('two')]));
    const turn = findTurn(entries)!;
    expect(promptText(turn.prompt)).toBe('/n second');
    expect(turn.answer).toBe('two');
  });

  it('a lagging transcript (prompt written, answer not yet) gives an empty answer', () => {
    const turn = findTurn(parseTranscript(jsonl([commandEntry('x'), skillBodyEntry()])))!;
    expect(turn.answer).toBe('');
    expect(turn.answeredAt).toBeNull();
  });

  it('ignores sidechain assistant text', () => {
    const turn = findTurn(parseTranscript(jsonl([commandEntry('x'), assistantText('sub', { isSidechain: true }), assistantText('main')])))!;
    expect(turn.answer).toBe('main');
  });

  it('returns null without any human prompt', () => {
    expect(findTurn(parseTranscript(jsonl([skillBodyEntry(), toolResultEntry('t', 'r')])))).toBeNull();
  });
});

describe('findLatestImagePrompt', () => {
  it('returns the latest image-carrying human prompt even when later prompts have none', () => {
    const older = imagePromptEntry('old [Image #1]', [{ media_type: 'image/png', data: BLUE_DATA }]);
    const newer = imagePromptEntry('/n like this [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]);
    const entries = parseTranscript(jsonl([older, assistantText('ok'), newer, assistantText('ok'), plainPromptEntry('and now?')]));
    expect(findLatestImagePrompt(entries)?.uuid).toBe(newer.uuid);
  });
});
```

### Step 20: Capture hook tests
**File:** `tests/unit/hooks/notesCapture.test.ts` (new)
**Code:**
```ts
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTBOX_MAX_PER_RUN,
  runCapture,
  spool,
  type CapturePayload,
  type FetchLike,
} from '../../../claude/hooks/notes-capture.mjs';
import { RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl, plainPromptEntry, skillBodyEntry } from './fixtures.js';

let tmp: string;
let env: Record<string, string>;
let transcript: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-capture-'));
  env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499' };
  transcript = path.join(tmp, 'session.jsonl');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const outbox = (): string => path.join(tmp, 'state', 'notes-capture', 'outbox');
const logFile = (): string => path.join(tmp, 'state', 'notes-capture', 'capture.log');

async function outboxFiles(): Promise<string[]> {
  try {
    return (await readdir(outbox())).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: CapturePayload;
}

function fakeFetch(responder: (call: Call, n: number) => Response | Promise<Response>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)) as CapturePayload,
    };
    calls.push(call);
    return responder(call, calls.length);
  };
  return { fetchImpl, calls };
}

const created = (): Response => new Response(JSON.stringify({ thread_id: 't', user_message_id: 'U', assistant_message_id: 'A' }), { status: 201 });
const down = (): never => {
  throw new TypeError('fetch failed');
};

function fakeClock(start = Date.parse('2026-10-31T01:00:00.000Z')): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: SESSION, transcript_path: transcript, cwd: '/tmp/notes-demo', hook_event_name: 'Stop', ...extra };
}

function payload(uuid: string): CapturePayload {
  return {
    claude_session: SESSION,
    user_uuid: uuid,
    prompt: '/n x',
    answer: 'y',
    prompt_timestamp: '2026-10-30T11:53:23.611Z',
    answered_at: '2026-10-30T11:53:30.000Z',
    cwd: null,
    images: [],
  };
}

describe('runCapture', () => {
  it('posts a /n turn with the typed prompt, the final answer, timestamps and the header', async () => {
    const prompt = commandEntry('show me the notes tagged #agentic');
    await writeFile(transcript, jsonl([prompt, skillBodyEntry(), assistantText('Two notes: A-B32, C-D45.')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    const clock = fakeClock();
    const result = await runCapture({ input: input({ last_assistant_message: 'Two notes: A-B32, C-D45.' }), env, fetchImpl, ...clock });
    expect(result.outcome).toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:7499/api/capture/claude-code');
    expect(calls[0]!.headers['x-notes-capture']).toBe('1');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({
      claude_session: SESSION,
      user_uuid: prompt.uuid,
      prompt: '/n show me the notes tagged #agentic',
      answer: 'Two notes: A-B32, C-D45.',
      prompt_timestamp: prompt.timestamp,
      answered_at: '2026-10-31T01:00:00.000Z',
      cwd: '/tmp/notes-demo',
      images: [],
    });
    expect(await outboxFiles()).toEqual([]);
  });

  it('sends pasted images, at most 8, supported types only', async () => {
    const images = [
      { media_type: 'image/svg+xml', data: 'PHN2Zz4=' },
      ...Array.from({ length: 9 }, () => ({ media_type: 'image/png', data: RED_PNG_16 })),
    ];
    await writeFile(transcript, jsonl([imagePromptEntry('/n like this [Image #1]', images), assistantText('Found 3.')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input({ last_assistant_message: 'Found 3.' }), env, fetchImpl, ...fakeClock() });
    expect(calls[0]!.body.images).toHaveLength(8);
    expect(calls[0]!.body.images.every((i) => i.media_type === 'image/png' && i.data_base64 === RED_PNG_16)).toBe(true);
  });

  it('ignores a turn that is not /n (no POST, nothing spooled)', async () => {
    await writeFile(transcript, jsonl([plainPromptEntry('fix the build'), assistantText('done')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    const result = await runCapture({ input: input({ last_assistant_message: 'done' }), env, fetchImpl, ...fakeClock() });
    expect(result.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(await outboxFiles()).toEqual([]);
  });

  it('waits for a lagging transcript and takes the answer from last_assistant_message', async () => {
    const prompt = commandEntry('x');
    await writeFile(transcript, jsonl([prompt]));
    const clock = fakeClock();
    let reads = 0;
    const readText = async (file: string): Promise<string> => {
      reads += 1;
      if (reads === 3) await writeFile(transcript, jsonl([prompt, assistantText('The final answer.')]));
      return readFile(file, 'utf8');
    };
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input({ last_assistant_message: 'The final answer.' }), env, fetchImpl, readText, ...clock });
    expect(reads).toBe(3);
    expect(calls[0]!.body.answer).toBe('The final answer.');
  });

  it('uses the transcript answer when the hook input has none', async () => {
    await writeFile(transcript, jsonl([commandEntry('x'), assistantText('From the transcript.')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input(), env, fetchImpl, ...fakeClock() });
    expect(calls[0]!.body.answer).toBe('From the transcript.');
  });

  it('gives up waiting after 3 s and still captures', async () => {
    await writeFile(transcript, jsonl([commandEntry('x')]));
    const clock = fakeClock();
    const start = clock.now();
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input({ last_assistant_message: 'never written' }), env, fetchImpl, ...clock });
    expect(clock.now() - start).toBeGreaterThanOrEqual(3000);
    expect(clock.now() - start).toBeLessThan(3500);
    expect(calls[0]!.body.answer).toBe('never written');
  });

  it('a missing transcript posts nothing and does not throw', async () => {
    const { fetchImpl, calls } = fakeFetch(() => created());
    const result = await runCapture({ input: input({ last_assistant_message: 'x' }), env, fetchImpl, ...fakeClock() });
    expect(result.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('daemon down: spools to the outbox (0600), and a later run delivers it', async () => {
    const prompt = commandEntry('remember me');
    await writeFile(transcript, jsonl([prompt, assistantText('ok')]));
    const first = await runCapture({ input: input({ last_assistant_message: 'ok' }), env, fetchImpl: fakeFetch(down).fetchImpl, ...fakeClock() });
    expect(first.outcome).toBe('spooled');
    expect(await outboxFiles()).toEqual([`${String(prompt.uuid)}.json`]);
    const file = path.join(outbox(), `${String(prompt.uuid)}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).prompt).toBe('/n remember me');

    await writeFile(transcript, jsonl([prompt, assistantText('ok'), plainPromptEntry('unrelated'), assistantText('sure')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    const second = await runCapture({ input: input({ last_assistant_message: 'sure' }), env, fetchImpl, ...fakeClock() });
    expect(second.outcome).toBe('skipped');
    expect(second.drained.delivered).toBe(1);
    expect(calls.map((c) => c.body.user_uuid)).toEqual([prompt.uuid]);
    expect(await outboxFiles()).toEqual([]);
  });

  it('removes on 200 duplicate, keeps on 503/429/404, drops and logs on 400', async () => {
    const cases: [number, boolean][] = [[200, false], [503, true], [429, true], [404, true], [400, false]];
    for (const [status, kept] of cases) {
      await rm(outbox(), { recursive: true, force: true });
      await spool(outbox(), payload(`u-${status}`));
      const { fetchImpl } = fakeFetch(() => new Response('{"error":"x"}', { status }));
      await runCapture({ input: {}, env, fetchImpl, ...fakeClock() });
      expect(await outboxFiles()).toEqual(kept ? [`u-${status}.json`] : []);
    }
    expect(await readFile(logFile(), 'utf8')).toMatch(/drop u-400\.json: HTTP 400/);
  });

  it('stops draining at the first network failure', async () => {
    for (const id of ['a1', 'a2', 'a3']) await spool(outbox(), payload(id));
    const { fetchImpl, calls } = fakeFetch(down);
    const result = await runCapture({ input: {}, env, fetchImpl, ...fakeClock() });
    expect(calls).toHaveLength(1);
    expect(result.drained).toMatchObject({ kept: 3, stoppedEarly: true });
    expect(await outboxFiles()).toHaveLength(3);
  });

  it(`attempts at most ${OUTBOX_MAX_PER_RUN} files per run, oldest first`, async () => {
    const t0 = Date.now() / 1000 - 3600;
    for (let i = 0; i < 25; i += 1) {
      const file = await spool(outbox(), payload(`f${String(i).padStart(2, '0')}`));
      await utimes(file, t0 + i, t0 + i);
    }
    const { fetchImpl, calls } = fakeFetch(() => created());
    const result = await runCapture({ input: {}, env, fetchImpl, now: Date.now, sleep: async () => undefined });
    expect(calls).toHaveLength(OUTBOX_MAX_PER_RUN);
    expect(calls[0]!.body.user_uuid).toBe('f00');
    expect(result.drained).toMatchObject({ delivered: 20, kept: 5 });
    expect(await outboxFiles()).toEqual(['f20.json', 'f21.json', 'f22.json', 'f23.json', 'f24.json']);
  });

  it('drops outbox files older than 14 days without posting them', async () => {
    const file = await spool(outbox(), payload('old'));
    const fifteenDaysAgo = Date.now() / 1000 - 15 * 86_400;
    await utimes(file, fifteenDaysAgo, fifteenDaysAgo);
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: {}, env, fetchImpl, now: Date.now, sleep: async () => undefined });
    expect(calls).toHaveLength(0);
    expect(await outboxFiles()).toEqual([]);
    expect(await readFile(logFile(), 'utf8')).toMatch(/drop old\.json: older than 14 days/);
  });

  it('a replayed turn reuses the same outbox name (idempotent spool)', async () => {
    const prompt = commandEntry('again');
    await writeFile(transcript, jsonl([prompt, assistantText('ok')]));
    const { fetchImpl } = fakeFetch(down);
    await runCapture({ input: input({ last_assistant_message: 'ok' }), env, fetchImpl, ...fakeClock() });
    await runCapture({ input: input({ last_assistant_message: 'ok' }), env, fetchImpl, ...fakeClock() });
    expect(await outboxFiles()).toEqual([`${String(prompt.uuid)}.json`]);
  });
});
```

### Step 21: Paste hook tests
**File:** `tests/unit/hooks/notesPaste.test.ts` (new)
**Code:**
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, runPaste, uploadIdFrom, type FetchLike } from '../../../claude/hooks/notes-paste.mjs';
import { BLUE_DATA, RED_PNG_16, SESSION, assistantText, imagePromptEntry, jsonl, plainPromptEntry } from './fixtures.js';

let tmp: string;
let transcript: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-paste-'));
  transcript = path.join(tmp, 's.jsonl');
  env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499' };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Upload {
  url: string;
  header: string | null;
  bytes: Buffer;
  type: string;
  source: unknown;
}

function fakeUpload(response: () => Response): { fetchImpl: FetchLike; uploads: Upload[] } {
  const uploads: Upload[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const form = init.body as FormData;
    const file = form.get('file') as File;
    uploads.push({
      url,
      header: new Headers(init.headers).get('x-notes-capture'),
      bytes: Buffer.from(await file.arrayBuffer()),
      type: file.type,
      source: form.get('source'),
    });
    return response();
  };
  return { fetchImpl, uploads };
}

const ok = (id = 'C-K7F'): Response => new Response(JSON.stringify({ id }), { status: 201 });

function hookInput(toolInput: Record<string, unknown>, toolName = 'mcp__notes__similar_images'): Record<string, unknown> {
  return { session_id: SESSION, transcript_path: transcript, hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput };
}

async function twoImageTranscript(pasteIds: number[] | null = [1, 2]): Promise<void> {
  await writeFile(
    transcript,
    jsonl([
      imagePromptEntry('/n like these [Image #1] [Image #2]', [
        { media_type: 'image/png', data: RED_PNG_16 },
        { media_type: 'image/jpeg', data: BLUE_DATA },
      ], pasteIds),
      assistantText('Looking.'),
    ]),
  );
}

const noSleep = async (): Promise<void> => undefined;

describe('runPaste', () => {
  it('defaults to the updatedInput strategy', () => {
    expect(DEFAULT_STRATEGY).toBe('updatedInput');
  });

  it('uploads image N and rewrites pasted_image to upload_id', async () => {
    await twoImageTranscript();
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    const out = await runPaste({ input: hookInput({ pasted_image: 2, limit: 5 }), env, fetchImpl, sleep: noSleep });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.url).toBe('http://127.0.0.1:7499/api/chat/images');
    expect(uploads[0]!.header).toBe('1');
    expect(uploads[0]!.type).toBe('image/jpeg');
    expect(uploads[0]!.bytes.equals(Buffer.from(BLUE_DATA, 'base64'))).toBe(true);
    expect(uploads[0]!.source).toBe('claude_code');
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { limit: 5, upload_id: 'C-K7F' } },
    });
  });

  it('accepts "1" and falls back to block order when the paste ids do not match', async () => {
    await twoImageTranscript([3, 4]);
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    await runPaste({ input: hookInput({ pasted_image: '1' }), env, fetchImpl, sleep: noSleep });
    expect(uploads[0]!.bytes.equals(Buffer.from(RED_PNG_16, 'base64'))).toBe(true);
  });

  it('uses the latest image-carrying prompt even after a text-only prompt', async () => {
    await writeFile(
      transcript,
      jsonl([
        imagePromptEntry('/n like this [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]),
        assistantText('Found some.'),
        plainPromptEntry('/n and with more results?'),
      ]),
    );
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    const out = await runPaste({ input: hookInput({ pasted_image: 1, limit: 20 }), env, fetchImpl, sleep: noSleep });
    expect(uploads).toHaveLength(1);
    expect(out?.hookSpecificOutput.updatedInput).toEqual({ limit: 20, upload_id: 'C-K7F' });
  });

  it('allows the call unchanged when there is no pasted image (the server explains)', async () => {
    await writeFile(transcript, jsonl([plainPromptEntry('/n find similar'), assistantText('…')]));
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    const out = await runPaste({ input: hookInput({ pasted_image: 1 }), env, fetchImpl, sleep: noSleep });
    expect(uploads).toHaveLength(0);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });

  it('allows the call unchanged when the upload fails', async () => {
    await twoImageTranscript();
    const { fetchImpl } = fakeUpload(() => new Response('{"error":"boom"}', { status: 500 }));
    const out = await runPaste({ input: hookInput({ pasted_image: 1 }), env, fetchImpl, sleep: noSleep });
    expect(out?.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(out?.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('deny strategy: uploads, then denies with the upload_id and the exact arguments', async () => {
    await twoImageTranscript();
    const { fetchImpl } = fakeUpload(() => ok('D-0Q1'));
    const out = await runPaste({ input: hookInput({ pasted_image: 1, limit: 3 }), env: { ...env, NOTES_PASTE_STRATEGY: 'deny' }, fetchImpl, sleep: noSleep });
    expect(out?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain('upload_id D-0Q1');
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain('{"limit":3,"upload_id":"D-0Q1"}');
  });

  it('stays out of other tools and of calls without pasted_image', async () => {
    await twoImageTranscript();
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    expect(await runPaste({ input: hookInput({ pasted_image: 1 }, 'mcp__notes__search'), env, fetchImpl, sleep: noSleep })).toBeNull();
    expect(await runPaste({ input: hookInput({ upload_id: 'C-K7F' }), env, fetchImpl, sleep: noSleep })).toBeNull();
    expect(await runPaste({ input: hookInput({ pasted_image: 0 }), env, fetchImpl, sleep: noSleep })).toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it('reads the upload id from the response shapes P3 may use', () => {
    expect(uploadIdFrom({ id: 'A-B32' })).toBe('A-B32');
    expect(uploadIdFrom({ upload_id: 'A-B32' })).toBe('A-B32');
    expect(uploadIdFrom({ image: { id: 'A-B32' } })).toBe('A-B32');
    expect(uploadIdFrom({ id: 'nope' })).toBeNull();
  });
});
```

### Step 22: Install merge tests (temp `HOME`)
**File:** `tests/unit/scripts/claudeHooks.test.ts` (new)
**Code:**
```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookCommand, mergeHooks, removeHooks, shQuote } from '../../../scripts/claude-hooks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HELPER = path.join(REPO, 'scripts', 'claude-hooks.mjs');
const HOOKS_DIR = path.join(REPO, 'claude', 'hooks');
const NODE = process.execPath;

const EXISTING = {
  model: 'opus',
  env: { CLAUDE_CODE_PLUGIN_DIRS: '/home/u/mods' },
  enabledPlugins: { 'superpowers@market': true },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/u/guard.sh' }] }],
  },
};

let home: string;
let settings: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'notes-hooks-home-'));
  settings = path.join(home, '.claude', 'settings.json');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeSettings(value: unknown): Promise<string> {
  await mkdir(path.dirname(settings), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(settings, text, { mode: 0o644 });
  return text;
}

function cli(...args: string[]): string {
  return execFileSync(NODE, [HELPER, ...args], { encoding: 'utf8' });
}

function sourced(script: 'install.sh' | 'uninstall.sh', body: string, extraEnv: Record<string, string> = {}): void {
  execFileSync('bash', ['-c', `source "$1"; ${body}`, '_', path.join(REPO, 'scripts', script)], {
    env: { ...process.env, HOME: home, NODE_BIN: NODE, ...extraEnv },
    encoding: 'utf8',
  });
}

describe('mergeHooks / removeHooks', () => {
  const opts = { nodeBin: '/opt/node/bin/node', hooksDir: '/home/u/mcp-notes/claude/hooks' };

  it('adds our two groups and keeps everything else', () => {
    const merged = mergeHooks(EXISTING, opts) as typeof EXISTING;
    expect(merged.env).toEqual(EXISTING.env);
    expect(merged.enabledPlugins).toEqual(EXISTING.enabledPlugins);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0]).toEqual(EXISTING.hooks.Stop[0]);
    expect(merged.hooks.Stop[1]).toEqual({
      hooks: [{ type: 'command', command: "'/opt/node/bin/node' '/home/u/mcp-notes/claude/hooks/notes-capture.mjs'", async: true, timeout: 60 }],
    });
    expect(merged.hooks.PreToolUse[1]).toEqual({
      matcher: 'mcp__notes__similar_images',
      hooks: [{ type: 'command', command: "'/opt/node/bin/node' '/home/u/mcp-notes/claude/hooks/notes-paste.mjs'", timeout: 30 }],
    });
  });

  it('is idempotent and replaces an entry left by another checkout', () => {
    const once = mergeHooks(EXISTING, { nodeBin: '/old/node', hooksDir: '/old/checkout/claude/hooks' });
    const twice = mergeHooks(once, opts);
    expect(mergeHooks(twice, opts)).toEqual(twice);
    expect(JSON.stringify(twice)).not.toContain('/old/checkout');
    expect((twice as typeof EXISTING).hooks.Stop).toHaveLength(2);
  });

  it('works without a hooks key and removeHooks restores the original exactly', () => {
    const plain = { model: 'opus', env: { A: '1' } };
    const merged = mergeHooks(plain, opts);
    expect(Object.keys(merged)).toEqual(['model', 'env', 'hooks']);
    expect(removeHooks(merged)).toEqual(plain);
    expect(removeHooks(mergeHooks(EXISTING, opts))).toEqual(EXISTING);
    expect(removeHooks(EXISTING)).toBe(EXISTING);
  });

  it('the deny strategy bakes the env prefix into the paste command only', () => {
    const merged = mergeHooks({}, { ...opts, pasteStrategy: 'deny' }) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(merged.hooks.PreToolUse![0]!.hooks[0]!.command.startsWith("NOTES_PASTE_STRATEGY='deny' ")).toBe(true);
    expect(merged.hooks.Stop![0]!.hooks[0]!.command.startsWith("'/opt/node")).toBe(true);
  });

  it('quotes paths with single quotes safely', () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(hookCommand('/n', "/x y/notes-capture.mjs")).toBe(`'/n' '/x y/notes-capture.mjs'`);
  });
});

describe('scripts/claude-hooks.mjs against a temp HOME', () => {
  it('creates the file (0600) when there is none, without a backup', async () => {
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const value = JSON.parse(await readFile(settings, 'utf8'));
    expect(Object.keys(value.hooks)).toEqual(['Stop', 'PreToolUse']);
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${settings}.bak-notes-hooks`)).toBe(false);
  });

  it('second run leaves the file byte-identical; backup kept once with the original', async () => {
    const original = await writeSettings(EXISTING);
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const first = await readFile(settings, 'utf8');
    expect(cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR)).toMatch(/^unchanged/);
    expect(await readFile(settings, 'utf8')).toBe(first);
    expect(await readFile(`${settings}.bak-notes-hooks`, 'utf8')).toBe(original);
    expect((await stat(settings)).mode & 0o777).toBe(0o644);
    cli('uninstall', '--settings', settings);
    expect(await readFile(settings, 'utf8')).toBe(original);
    expect(await readFile(`${settings}.bak-notes-hooks`, 'utf8')).toBe(original);
  });

  it('refuses invalid JSON and leaves the file alone', async () => {
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, '{ not json');
    const run = spawnSync(NODE, [HELPER, 'install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/cannot read/);
    expect(await readFile(settings, 'utf8')).toBe('{ not json');
  });

  it('status reports both hooks', async () => {
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const out = cli('status', '--settings', settings);
    expect(out).toMatch(/Stop notes-capture: .*notes-capture\.mjs/);
    expect(out).toMatch(/PreToolUse notes-paste: .*notes-paste\.mjs/);
  });
});

describe('install.sh / uninstall.sh (sourced, temp HOME)', () => {
  it('register_hooks merges into ~/.claude/settings.json, twice = identical, uninstall restores', async () => {
    const original = await writeSettings(EXISTING);
    sourced('install.sh', 'register_hooks');
    const first = await readFile(settings, 'utf8');
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-capture.mjs'));
    expect(first).toContain(NODE);
    sourced('install.sh', 'register_hooks');
    expect(await readFile(settings, 'utf8')).toBe(first);
    sourced('uninstall.sh', 'unregister_hooks');
    expect(await readFile(settings, 'utf8')).toBe(original);
  });

  it('--skip-hooks and NOTES_SKIP_HOOKS=1 leave settings.json alone', async () => {
    sourced('install.sh', 'parse_args --skip-hooks; register_hooks');
    expect(existsSync(settings)).toBe(false);
    sourced('install.sh', 'register_hooks', { NOTES_SKIP_HOOKS: '1' });
    expect(existsSync(settings)).toBe(false);
  });

  it('sourcing does not run main', () => {
    expect(() => sourced('install.sh', 'true')).not.toThrow();
    expect(() => sourced('uninstall.sh', 'true')).not.toThrow();
  });
});
```

### Step 23: Guard unit test
**File:** `tests/unit/captureGuard.test.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { captureGuard, decodeImageBase64 } from '../../src/http/capture.js';

function app(): Hono {
  const a = new Hono();
  a.use('/c', captureGuard);
  a.post('/c', (c) => c.json({ ok: true }));
  return a;
}

async function post(url: string, headers: Record<string, string>): Promise<Response> {
  return app().request(url, { method: 'POST', headers, body: '{}' });
}

const good = { 'content-type': 'application/json', 'x-notes-capture': '1' };

describe('captureGuard', () => {
  it('lets the hook through: loopback, no Origin, header, JSON', async () => {
    expect((await post('http://127.0.0.1:7317/c', good)).status).toBe(200);
    expect((await post('http://localhost:7317/c', { ...good, 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    expect((await post('http://127.0.0.1:7317/c', { ...good, origin: 'http://localhost:7317' })).status).toBe(200);
  });

  it('refuses a non-loopback host, a foreign Origin, a missing header, non-JSON', async () => {
    expect(await (await post('http://notes.example/c', good)).json()).toEqual({ error: 'forbidden_host' });
    expect(await (await post('http://127.0.0.1:7317/c', { ...good, origin: 'https://evil.example' })).json()).toEqual({ error: 'forbidden_origin' });
    expect((await post('http://127.0.0.1:7317/c', { ...good, origin: 'null' })).status).toBe(403);
    const noHeader = await post('http://127.0.0.1:7317/c', { 'content-type': 'application/json' });
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toEqual({ error: 'capture_header_required' });
    expect((await post('http://127.0.0.1:7317/c', { ...good, 'x-notes-capture': '0' })).status).toBe(403);
    expect((await post('http://127.0.0.1:7317/c', { ...good, 'content-type': 'text/plain' })).status).toBe(415);
  });
});

describe('decodeImageBase64', () => {
  it('decodes strict base64 and refuses anything else', () => {
    expect(decodeImageBase64('aGk=')?.toString()).toBe('hi');
    expect(decodeImageBase64('aG\nk=')?.toString()).toBe('hi');
    expect(decodeImageBase64('aGk')).toBeNull();
    expect(decodeImageBase64('a$k=')).toBeNull();
    expect(decodeImageBase64('')).toBeNull();
  });
});
```

### Step 24: Endpoint integration tests
**File:** `tests/integration/capture.int.test.ts` (new)
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_PATH, MAX_CAPTURE_IMAGES } from '../../src/http/capture.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

beforeEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h.close();
});

interface WireMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  text: string;
  source: string;
  created_at: string;
  attachments: { kind: string; id: string }[];
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claude_session: 'sess-capture',
    user_uuid: randomUUID(),
    prompt: '/n show me the notes tagged #agentic',
    answer: 'Two notes are tagged #agentic: A-B32 and C-D45.',
    prompt_timestamp: '2026-10-30T11:53:23.611Z',
    answered_at: '2026-10-30T11:53:41.002Z',
    cwd: '/tmp/notes-demo',
    images: [],
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    h.app.request(`http://127.0.0.1${CAPTURE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function thread(id: string): Promise<{ thread: { id: string; source: string }; messages: WireMessage[] }> {
  const res = await h.app.request(`http://127.0.0.1/api/chat/threads/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { thread: { id: string; source: string }; messages: WireMessage[] };
}

async function count(table: 'chat_threads' | 'chat_messages' | 'chat_images'): Promise<number> {
  const result = await h.deps.db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return Number((result.rows[0] as { n: number }).n);
}

describe('POST /api/capture/claude-code', () => {
  it('stores one single-turn claude_code thread: user then assistant, with the given timestamps', async () => {
    const res = await post(payload());
    expect(res.status).toBe(201);
    const ids = (await res.json()) as { thread_id: string; user_message_id: string; assistant_message_id: string };
    expect(ids.user_message_id).toMatch(/^[0-9A-Z]{4}$/);
    const t = await thread(ids.thread_id);
    expect(t.thread.source).toBe('claude_code');
    expect(t.messages.map((m) => [m.role, m.source, m.text, m.created_at])).toEqual([
      ['user', 'claude_code', '/n show me the notes tagged #agentic', '2026-10-30T11:53:23.611Z'],
      ['assistant', 'claude_code', 'Two notes are tagged #agentic: A-B32 and C-D45.', '2026-10-30T11:53:41.002Z'],
    ]);
    expect(await count('chat_threads')).toBe(1);
  });

  it('a replay is a no-op answered 200 duplicate with the same ids', async () => {
    const body = payload();
    const first = (await (await post(body)).json()) as Record<string, string>;
    const again = await post({ ...body, answer: 'different text on replay' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true, ...first });
    expect(await count('chat_threads')).toBe(1);
    expect(await count('chat_messages')).toBe(2);
  });

  it('two concurrent posts of the same exchange write one thread', async () => {
    const body = payload();
    const statuses = (await Promise.all([post(body), post(body)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 201]);
    expect(await count('chat_threads')).toBe(1);
    expect(await count('chat_messages')).toBe(2);
  });

  it('stores pasted images in the chat image store (claude_code, sha-deduped) and attaches them to the user message', async () => {
    const red = (await makeImage('png', 16, 16, { r: 220, g: 40, b: 40 })).toString('base64');
    const blue = (await makeImage('jpeg', 16, 16, { r: 30, g: 60, b: 200 })).toString('base64');
    const res = await post(
      payload({
        images: [
          { media_type: 'image/png', data_base64: red },
          { media_type: 'image/jpeg', data_base64: blue },
          { media_type: 'image/png', data_base64: red },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const ids = (await res.json()) as { thread_id: string };
    const user = (await thread(ids.thread_id)).messages.find((m) => m.role === 'user')!;
    expect(user.attachments.map((a) => a.kind)).toEqual(['chat_image', 'chat_image']);
    expect(await count('chat_images')).toBe(2);
    const sources = await h.deps.db.execute(sql`select distinct source from chat_images`);
    expect(sources.rows).toEqual([{ source: 'claude_code' }]);
    const second = await post(payload({ images: [{ media_type: 'image/png', data_base64: red }] }));
    expect(second.status).toBe(201);
    expect(await count('chat_images')).toBe(2);
  });

  it('an empty answer stores the question only', async () => {
    const res = await post(payload({ answer: '' }));
    const ids = (await res.json()) as { thread_id: string; assistant_message_id: string | null };
    expect(ids.assistant_message_id).toBeNull();
    expect((await thread(ids.thread_id)).messages.map((m) => m.role)).toEqual(['user']);
  });

  it('an answer timestamp before the prompt is clamped after it', async () => {
    const res = await post(payload({ answered_at: '2026-10-30T11:00:00.000Z' }));
    const ids = (await res.json()) as { thread_id: string };
    const [user, assistant] = (await thread(ids.thread_id)).messages;
    expect(Date.parse(assistant!.created_at)).toBeGreaterThan(Date.parse(user!.created_at));
  });

  it('timeline: captures land by their own timestamps, not by arrival order', async () => {
    await post(payload({ prompt: '/n later', prompt_timestamp: '2026-10-30T12:00:00.000Z', answered_at: '2026-10-30T12:00:05.000Z' }));
    await post(payload({ prompt: '/n earlier', prompt_timestamp: '2026-10-30T09:00:00.000Z', answered_at: '2026-10-30T09:00:05.000Z' }));
    const res = await h.app.request('http://127.0.0.1/api/chat/messages');
    const { messages } = (await res.json()) as { messages: WireMessage[] };
    expect(messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['/n earlier', '/n later']);
  });

  it('validates the body', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post(payload({ prompt: '   ' }))).status).toBe(400);
    expect((await post(payload({ prompt_timestamp: 'yesterday' }))).status).toBe(400);
    expect((await post(payload({ claude_session: '' }))).status).toBe(400);
    const tooMany = Array.from({ length: MAX_CAPTURE_IMAGES + 1 }, () => ({ media_type: 'image/png', data_base64: 'aGk=' }));
    expect((await post(payload({ images: tooMany }))).status).toBe(400);
    expect((await post(payload({ images: [{ media_type: 'image/svg+xml', data_base64: 'aGk=' }] }))).status).toBe(400);
    const bad = await post(payload({ images: [{ media_type: 'image/png', data_base64: 'not*base64' }] }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_base64', index: 0 });
    expect(await count('chat_threads')).toBe(0);
  });

  it('refuses bytes the image store cannot read with 415 and writes nothing', async () => {
    const res = await post(payload({ images: [{ media_type: 'image/png', data_base64: Buffer.from('not an image at all').toString('base64') }] }));
    expect(res.status).toBe(415);
    expect(await count('chat_threads')).toBe(0);
  });

  it('is guarded: foreign Origin, missing header, non-loopback host', async () => {
    expect((await post(payload(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(payload(), { 'x-notes-capture': '' })).status).toBe(403);
    const foreign = await h.app.request(`http://notes.example${CAPTURE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify(payload()),
    });
    expect(foreign.status).toBe(403);
    expect(await count('chat_threads')).toBe(0);
  });
});
```

### Step 25: Hook → endpoint integration test
**File:** `tests/integration/capture.hook.int.test.ts` (new)
**Code:**
```ts
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCapture } from '../../claude/hooks/notes-capture.mjs';
import { RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl, plainPromptEntry, skillBodyEntry } from '../unit/hooks/fixtures.js';
import { startHarness, type Harness } from './imageHarness.js';

let h: Harness;
let livePort: string;
let tmp: string;

beforeAll(async () => {
  h = await startHarness();
  livePort = new URL(await h.listen()).port;
});

beforeEach(async () => {
  await h.reset();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-capture-int-'));
});

afterAll(async () => {
  await h.close();
});

function closedPort(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 1;
      server.close(() => resolve(String(port)));
    });
  });
}

async function count(table: string): Promise<number> {
  const result = await h.deps.db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return Number((result.rows[0] as { n: number }).n);
}

const fast = { sleep: async (): Promise<void> => undefined };

describe('notes-capture hook against the real endpoint', () => {
  it('a string-form /n turn and an array-form /n turn with an image each become one claude_code thread', async () => {
    const transcript = path.join(tmp, 's.jsonl');
    const env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: livePort };
    await writeFile(transcript, jsonl([commandEntry('list #agentic'), skillBodyEntry(), assistantText('Two notes.')]));
    const first = await runCapture({ input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Two notes.' }, env, ...fast });
    expect(first.outcome).toBe('delivered');

    await writeFile(
      transcript,
      jsonl([
        commandEntry('list #agentic'),
        assistantText('Two notes.'),
        imagePromptEntry('/n photos like this [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]),
        assistantText('Three look alike.'),
      ]),
    );
    const second = await runCapture({ input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Three look alike.' }, env, ...fast });
    expect(second.outcome).toBe('delivered');
    expect(await count('chat_threads')).toBe(2);
    expect(await count('chat_images')).toBe(1);

    const replay = await runCapture({ input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Three look alike.' }, env, ...fast });
    expect(replay.outcome).toBe('delivered');
    expect(await count('chat_threads')).toBe(2);
    await rm(tmp, { recursive: true, force: true });
  });

  it('daemon down spools to the outbox; a later run (any turn) delivers it', async () => {
    const transcript = path.join(tmp, 's.jsonl');
    const stateHome = path.join(tmp, 'state');
    const prompt = commandEntry('save me later');
    await writeFile(transcript, jsonl([prompt, assistantText('ok')]));
    const down = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'ok' },
      env: { HOME: tmp, XDG_STATE_HOME: stateHome, NOTESD_PORT: await closedPort() },
      ...fast,
    });
    expect(down.outcome).toBe('spooled');
    expect(await readdir(path.join(stateHome, 'notes-capture', 'outbox'))).toEqual([`${String(prompt.uuid)}.json`]);
    expect(await count('chat_threads')).toBe(0);

    await writeFile(transcript, jsonl([prompt, assistantText('ok'), plainPromptEntry('something else'), assistantText('fine')]));
    const up = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'fine' },
      env: { HOME: tmp, XDG_STATE_HOME: stateHome, NOTESD_PORT: livePort },
      ...fast,
    });
    expect(up.drained.delivered).toBe(1);
    expect(await readdir(path.join(stateHome, 'notes-capture', 'outbox'))).toEqual([]);
    expect(await count('chat_threads')).toBe(1);
    await rm(tmp, { recursive: true, force: true });
  });
});
```

### Step 26: `pasted_image` test
**26a. File:** `tests/integration/similarImages.mcp.int.test.ts` (P6). Replace the body of the case `it('pasted_image explains that the Claude Code hook is needed', …)` and rename it:
```ts
  it('pasted_image that reached the server (the hook did not rewrite it) gets the final explanation', async () => {
    const r = await call({ pasted_image: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(PASTED_IMAGE_NEEDS_HOOK);
    expect(text(r)).toMatch(/notes-paste hook/);
    expect(text(r)).toMatch(/scripts\/install\.sh/);
  });
```
(add `PASTED_IMAGE_NEEDS_HOOK` to that file's import from `../../src/mcp/similarTools.js` if it is not imported yet).

### Step 27: Opt-in live check of the rewrite
**File:** `scripts/verify-paste-hook.mjs` (new)
**Code:**
```js
#!/usr/bin/env node
/**
 * Opt-in live check, never part of npm test / test:int: does Claude Code honour the notes-paste
 * PreToolUse hook for the MCP tool mcp__notes__similar_images?
 *
 *   npm run verify:paste-hook -- [--port 7400] [--strategy updatedInput|deny] [--model sonnet] [--claude claude]
 *
 * Needs a running notesd built from this checkout on --port (default NOTESD_PORT, else 7317; a
 * demo daemon is fine: NOTESD_PORT=7400 NOTES_DATA_DIR=/tmp/notes-demo npm start), and the claude
 * CLI logged in. Runs one short headless session (`claude -p --input-format stream-json`) with a
 * throwaway --settings file that registers only this repo's paste hook, and --strict-mcp-config
 * pointing at that daemon. Bills one small model call and leaves one transcript under
 * ~/.claude/projects (cwd is a temp dir). The upload lands in chat_images (source claude_code).
 *
 * Exit 0: the tool received an upload_id (the strategy works). 1: it did not (with
 * updatedInput: flip DEFAULT_STRATEGY in claude/hooks/notes-paste.mjs to 'deny', or reinstall with
 * NOTES_PASTE_STRATEGY=deny scripts/install.sh, and re-run this with --strategy deny). 2: could not run.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'claude', 'hooks', 'notes-paste.mjs');
const TOOL = 'mcp__notes__similar_images';
const UNRESOLVED = 'pasted_image could not be resolved';
const RED_PNG_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWO4o6FBEmIY1aAxGkp3hmvSAAAyBCwQ7wckpgAAAABJRU5ErkJggg==';
const TIMEOUT_MS = 180_000;

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      strategy: { type: 'string', default: 'updatedInput' },
      model: { type: 'string', default: 'sonnet' },
      claude: { type: 'string', default: 'claude' },
    },
  });
  const port = values.port ?? process.env.NOTESD_PORT ?? '7317';
  const strategy = values.strategy === 'deny' ? 'deny' : 'updatedInput';
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`notesd is not answering on 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'verify-paste-hook-'));
  try {
    const settingsFile = path.join(tmp, 'settings.json');
    const mcpFile = path.join(tmp, 'mcp.json');
    const command = `NOTESD_PORT=${quote(port)} NOTES_PASTE_STRATEGY=${quote(strategy)} ${quote(process.execPath)} ${quote(HOOK)}`;
    await writeFile(
      settingsFile,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: TOOL, hooks: [{ type: 'command', command, timeout: 30 }] }] } }),
    );
    await writeFile(mcpFile, JSON.stringify({ mcpServers: { notes: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }));

    const prompt =
      `[Image #1]\nCall the tool ${TOOL} with exactly the arguments {"pasted_image": 1, "limit": 3}. ` +
      'If the call is denied with instructions, follow them once. Then reply with only the first 300 characters of the last tool result.';
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG_16 } },
        ],
      },
    };
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--settings', settingsFile,
      '--mcp-config', mcpFile,
      '--strict-mcp-config',
      '--allowedTools', TOOL,
      '--model', values.model,
    ];
    console.log(`running: ${values.claude} ${args.join(' ')}  (strategy ${strategy}, port ${port})`);
    const lines = await new Promise((resolve, reject) => {
      const child = spawn(values.claude, args, { cwd: tmp, stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`claude did not finish within ${TIMEOUT_MS / 1000}s`));
      }, TIMEOUT_MS);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out.split('\n').filter((line) => line.trim() !== ''));
      });
      child.stdin.end(`${JSON.stringify(message)}\n`);
    });

    const calls = new Map();
    const results = [];
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const content = event?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === TOOL) calls.set(block.id, block.input);
        if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
          results.push({ input: calls.get(block.tool_use_id), text: textOf(block.content), isError: block.is_error === true });
        }
      }
    }
    if (results.length === 0) {
      console.error('the model never called the tool; inconclusive');
      return 2;
    }
    for (const r of results) console.log(`call ${JSON.stringify(r.input)} -> ${r.isError ? 'error' : 'ok'}: ${r.text.slice(0, 200)}`);
    const reached = results.some((r) => !r.text.includes(UNRESOLVED) && !/permission|denied/i.test(r.text) && !r.text.includes('pasted_image'));
    console.log(reached ? `PASS: similar_images received an upload_id (${strategy})` : `FAIL: the ${strategy} strategy did not reach the tool with an upload_id`);
    return reached ? 0 : 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
```

**File:** `package.json` — add to `scripts` after `"embed:backfill"` (and after any script P6 added):
```json
    "verify:paste-hook": "node scripts/verify-paste-hook.mjs"
```

### Step 28: README
**File:** `README.md`

**28a.** In "Using it from Claude Code" (after the `/migrate` example block, l.284 today) add:
```markdown
`install.sh` also registers two Claude Code hooks in `~/.claude/settings.json` (every repo; pass
`--skip-hooks` to leave the file alone):

- **notes-capture** (Stop, runs in the background): after every `/n` turn it saves the prompt as
  you typed it, Claude's final answer and any pasted images to the chat history, as a
  single-turn thread badged "claude code". If the daemon is down the exchange waits in
  `~/.local/state/notes-capture/outbox/` and goes in on a later turn. Saving twice is harmless.
- **notes-paste** (before `similar_images`): paste an image and ask `/n find photos like this`.
  Claude calls `similar_images` with `pasted_image: 1`; the hook uploads `[Image #1]` and the
  search runs on it. `npm run verify:paste-hook` checks this against a running daemon (one
  short, billed Claude call).
```

**28b.** In "Install on WSL", replace items 7-8 of the numbered list (l.512-514 today) with:
```markdown
7. symlinks the `/n` and `/migrate` skills into `~/.claude/skills`,
8. merges the notes-capture and notes-paste hooks into `~/.claude/settings.json`, keeping
   everything else (a copy of the original is kept once as `settings.json.bak-notes-hooks`;
   `--skip-hooks` or `NOTES_SKIP_HOOKS=1` skips this),
9. exits non-zero unless the unit is active, `/health` answers and `claude mcp list` shows
   `notes` connected.
```
and change "Undo with `scripts/uninstall.sh` (it keeps your data)." to "Undo with `scripts/uninstall.sh` (it keeps your data and removes only our two hook entries)."

**28c.** "HTTP API" table: add after the `POST /api/chat` row:
```markdown
| `POST /api/capture/claude-code` | One `/n` exchange from the notes-capture hook (JSON, header `X-Notes-Capture: 1`, loopback only). 201 with the thread and message ids, 200 `duplicate` when it was saved before |
```

**28d.** "Where things are stored": add after the `~/mcp-notes-data/` block:
```markdown
~/.local/state/notes-capture/      the Claude Code hooks: outbox/ (captures waiting for the daemon), capture.log, paste.log
```
(inside the same code block, as its last line).

**28e.** "Repository layout": add the line
```
claude/hooks    the Claude Code hooks (notes-capture: saves /n exchanges; notes-paste: pasted image -> similar_images)
```
**28g.** In the "MCP tools" table row for `similar_images` (P6's row), replace P6's closing sentence about `pasted_image` (P6 writes "`pasted_image` (Claude Code) needs the notes-paste hook"; locate it as the last sentence of the row, starting "`pasted_image` (Claude Code)") with "`pasted_image: N` (Claude Code: `[Image #N]` pasted into the conversation, uploaded by the notes-paste hook)".

**28f.** "Tests": add `npm run verify:paste-hook     # opt-in: one real claude -p run checks the paste hook rewrite` to the command block.

### Step 29: CHANGELOG
**File:** `CHANGELOG.md` — under `## [Unreleased]` → `### Added` (create both headings above `## [v0.1.0]` if no earlier phase did):
```markdown
- **Claude Code capture**: a Stop hook saves every `/n` exchange (prompt, final answer, pasted images) to the chat history as a `claude_code` thread through `POST /api/capture/claude-code` (loopback, header-guarded, idempotent, with an outbox when the daemon is down); a PreToolUse hook lets `/n` search with a pasted image via `similar_images({pasted_image: 1})`; `install.sh` merges both hooks into `~/.claude/settings.json` (`--skip-hooks`), `uninstall.sh` removes them.
```

## Verification

**Build:** `npm run typecheck && npm run build`
**Migration chain:** `npm run db:check` (P8 adds no migration; the chain must still end at 0006)
**Shell syntax:** `bash -n scripts/install.sh && bash -n scripts/uninstall.sh`
**Tests:** `npm test` (includes `tests/unit/hooks/*`, `tests/unit/scripts/claudeHooks.test.ts`, `tests/unit/captureGuard.test.ts`, P6's `tests/unit/similarTools.test.ts`) and `npm run test:int` (includes `capture.int.test.ts`, `capture.hook.int.test.ts`, `similarImages.mcp.int.test.ts`)
**Manual check (no install, no real settings):**
```sh
T=$(mktemp -d)
printf '%s\n' '{"type":"user","uuid":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-31T01:00:00.000Z","sessionId":"s1","cwd":"/tmp","origin":{"kind":"human"},"message":{"role":"user","content":"<command-message>n</command-message>\n<command-name>/n</command-name>\n<command-args>hello</command-args>"}}' > "$T/t.jsonl"
echo "{\"session_id\":\"s1\",\"transcript_path\":\"$T/t.jsonl\",\"last_assistant_message\":\"hi\"}" \
  | XDG_STATE_HOME="$T/state" NOTESD_PORT=7400 node claude/hooks/notes-capture.mjs; echo "exit $?"
ls "$T/state/notes-capture/outbox"   # one file when nothing listens on 7400; empty when a demo daemon does
HOME="$T" bash -c 'source scripts/install.sh; NODE_BIN=$(command -v node) register_hooks' && cat "$T/.claude/settings.json"
```
**Pre-merge manual check (opt-in, billed; not a blocker for the phase or its exit criteria):** the docs do not confirm that a PreToolUse hook's `updatedInput` rewrites an MCP tool's input. The default strategy is `updatedInput`, with `deny` as the fallback. Run the check below once before the set merges to main and record the result in the PR. With a demo daemon on 7400 built from the branch: `npm run verify:paste-hook -- --port 7400`; if it prints FAIL, run `-- --strategy deny` and, if that passes, flip `DEFAULT_STRATEGY` (or install with `NOTES_PASTE_STRATEGY=deny`).
**Exit criteria:** a synthetic transcript (string-form `/n` entry; array-form entry with image blocks and `imagePasteIds`) fed to the Stop hook produces exactly one single-turn `claude_code` thread with its images in `chat_images` (source `claude_code`) attached to the user message; replaying it is answered `duplicate` and writes nothing; with the daemon down the payload sits in the outbox and the next hook run delivers it; `register_hooks` against a temp `HOME` merges both entries, a second run leaves the file byte-identical, `unregister_hooks` restores the original; a `similar_images` call still carrying `pasted_image` returns the final `PASTED_IMAGE_NEEDS_HOOK` text; all four invariant commands pass.

## Handoffs

- **To the reconciler (P3):** A1-A3 were read from `phase-3.md` and used as written there (`chatImageStoreFor`, `ingestChatImage` → `{image, created}`, `ChatImageInputError` `not_an_image | too_large`, `chat_images.source` check). Reconciled: the optional `source` form field of `POST /api/chat/images` and its test cases now live in P3 (Step 7 and `chat.images.int.test.ts`); P8 does not edit `src/http/chatImages.ts`. The hook still sends `source=claude_code` (and would tolerate a server that ignored it).
- **To the reconciler (P6):** A4 was read from `phase-6.md`. P8 keeps `PASTED_IMAGE_NEEDS_HOOK` as the name, replaces its text (Step 15), replaces P6's `/n` skill bullet about pasted images (Step 16), P6's pasted_image integration case (Step 26a) and P6's README `similar_images` row wording (Step 28g). Reconciled: P6's provisional texts name the `notes-paste` hook (the one that rewrites `pasted_image`; notes-capture is the Stop hook), and every P8 replacement locates P6's text by the constant name, the bullet's opening words, the test title or the row's `pasted_image` sentence, not by the hook name.
- **To the reconciler (P7):** A5-A9 were read from `phase-7.md` and used as written (`deps.chat.recordExchange`, `RecordedExchange.messageIds`, `ChatThreadDetail`, `ChatTimelinePage`). P8 adds nothing to P7's files. P7's handoff sentence passes `brain`; P8 passes `brain: null` (the Claude Code model is not known from the transcript).
- **To P9 (history UI):** captured threads carry `source: 'claude_code'`, a user message whose text starts with `/n` and may contain `[Image #N]` markers, images as `chat_image` attachments, `brain: null`, and possibly no assistant message (empty answer). The hook sends `cwd`, but P7's thread has no column for it, so it is accepted and dropped; showing the repo would need a later change to P7's schema.
- **Noticed, not fixed:** `scripts/uninstall.sh` removes only the `n` skill symlink, not `migrate` (pre-existing; a one-line follow-up outside R1/R3).

## Risks

- **`updatedInput` for MCP tools is not confirmed by the docs.** Mitigated by the single switch (`DEFAULT_STRATEGY = 'updatedInput'`, fallback `NOTES_PASTE_STRATEGY=deny`) and `npm run verify:paste-hook`, which settles it on the real CLI in one billed call. Listed in the plan index as a pre-merge manual check: run it once before merging; a FAIL means flipping to `deny`, not reworking the phase.
- **Cross-phase names (A1-A9).** P8 is written against the P3/P6/P7 plan files as drafted; a mismatch is a compile error, not a silent bug, and every use is listed in the Assumptions table.
- **Concurrent identical images** (two captures at once with the same bytes) rely on P3's store returning the winner of a lost insert race (A1, which P3 states); the concurrency test still uses no images so it does not depend on it.
- **Async hook killed early** (e.g. `claude -p` exits): covered by spool-before-send; the capture is delivered by the next hook run on this machine.
- **Transcript format drift** in a future Claude Code: the parser is defensive (unknown entries are skipped); the worst case is that a `/n` turn is not recognised and nothing is captured, never a broken session.

## Rollback

Revert this phase's commits. Then:
- `scripts/uninstall.sh` is not needed just to drop the hooks: `node scripts/claude-hooks.mjs uninstall --settings ~/.claude/settings.json` (from a checkout that still has the script), or restore `~/.claude/settings.json.bak-notes-hooks`, or delete the two entries whose command contains `notes-capture.mjs` / `notes-paste.mjs`.
- DB: nothing to drop (P8 adds no table). Captured threads are ordinary `chat_threads` rows with `source = 'claude_code'`; delete them by hand only if unwanted.
- State: `rm -rf ~/.local/state/notes-capture` (outbox and logs).
