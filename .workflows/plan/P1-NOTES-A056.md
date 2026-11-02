> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 8. Source: `.workflows/plan/project-session-graph/phase-8.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 8: Node ids in prompts resolve to context

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R5 — typing an existing node id (e.g. `A0-3G`) into any Claude Code prompt injects that node's summary, plan docs, commits and transcript path; near-zero cost otherwise
**Depends on:** Phase 7 (`GET /api/sessions/context?ids=`), which itself sits on Phase 1 (node ids, `cc_sessions`)
**Difficulty:** NORMAL
**Package:** `claude/hooks`

---

## Goal

`claude/hooks/notes-prompt.mjs` stops being a `/n`-only hook. For every prompt it runs one pure
regex test for node-id candidates. With no candidate and no `/n` it returns `null` before any I/O,
exactly as today. With candidates it asks the daemon's `GET /api/sessions/context?ids=...` (1.5 s
timeout, fail soft) and adds the context of the ids that exist. On a `/n` prompt that also names a
node, the image context and the node context go out together in one `hookSpecificOutput`.

## Interface Contract

**Deletes:** the private helper `pendingOutput(n)` (`claude/hooks/notes-prompt.mjs:277`). It is not exported and nothing outside the file uses it. `imageContext` returns `buildPendingContext(n)` directly instead.
**Renames:** none
**Creates (all in `claude/hooks/notes-prompt.mjs`, typed in `notes-prompt.d.mts`):**
- `NODE_ID_CANDIDATE` (RegExp, global; its `.source` equals Phase 1's `NODE_ID_CANDIDATE_SOURCE`),
  `MAX_NODE_IDS = 5` (= Phase 1 `MAX_NODE_ID_CANDIDATES`), `CONTEXT_TIMEOUT_MS = 1500`,
  `MAX_NODE_CONTEXT_CHARS = 9000`, `NODE_CONTEXT_HEADER` (same text as Phase 7's `CONTEXT_HEADER`), `NODE_TOOLS_HINT`
- `nodeIdCandidates(prompt: unknown): string[]` (pure; same result as Phase 1's `findNodeIdCandidates`)
- `contextUrl(baseUrl, ids): string`
- `parseNodeContext(body: unknown, asked: string[]): ParsedNodeContext` (`{nodes: NodeContext[], context: string}`)
- `buildNodeContext(parsed: ParsedNodeContext): string | null`
- `fetchNodeContext(ids, {fetchImpl, baseUrl, timeoutMs?}): Promise<ParsedNodeContext>`
- `resolveNodeIds(ids, {env, fetchImpl, timeoutMs?}): Promise<string | null>` (never throws)
- `imageContext({input, env, fetchImpl, readText, sleep, now}): Promise<string | null>`: the old
  `runPrompt` body, unchanged in behaviour, now returning the context text and not the output object
- types `NodeContext` (`{node_id, text}`) and `ParsedNodeContext` in the `.d.mts`

**Signature changes:** `runPrompt(opts)` gains the optional `contextTimeoutMs?: number` (default
`CONTEXT_TIMEOUT_MS`). Its return type stays `Promise<UserPromptSubmitOutput | null>`. For inputs
with no node-id candidate the output is byte-for-byte what it was before.

**Requires (from earlier phases):**
- **Phase 7:** `GET /api/sessions/context?ids=<id>,<id>,...` is mounted in `createApp`
  (`src/http/app.ts`), so `tests/integration/imageHarness.ts` serves it. Response shape, as
  Phase 7 publishes it (reconciled; Phase 7 owns it):
  ```
  200 application/json   (always 200; unknown ids only go to `missing`)
  { "nodes":   [ { "node_id": "A0-3G", "session_id": "b7c1…", "text": "Session A0-3G \"…\" (repo …)\nSummary: …\nPlan docs: …\nCommits: …\nTranscript: …" } ],
    "missing": [ "ZZ-9Q" ],
    "context": "<CONTEXT_HEADER>\n\n<text>\n\n<text>"   // '' when nodes is empty
  }
  ```
  - `nodes` is in request order, each `text` at most 4000 chars and already carries the summary,
    plan docs, commits and transcript path (or "on <host>, not readable from this machine").
  - `ids` is comma-separated; the server considers at most 10. The hook sends at most 5, upper
    case, with the dash.
  - Guard: `loopbackReadGuard` (request URL must be loopback; an `Origin`, when present, must be
    loopback). A plain Node GET with no `Origin` passes. The hook's `X-Notes-Capture: 1` header is
    not required and is harmless.
  - The hook uses `context` verbatim when every returned node was asked for; it still drops any
    `nodes[]` row whose `node_id` it did not ask for (and then rebuilds the text from the kept
    rows), so "only existing, asked-for ids resolve" holds on the hook side even if the server is lax.
- **Phase 1:** node ids are `[0-9A-Z]{2}-[0-9A-Z]{2}` (`src/sessions/ids.ts` `NODE_ID_PATTERN`),
  never all digits (`generateNodeId` redraws them), and `NODE_ID_CANDIDATE_SOURCE` /
  `findNodeIdCandidates` implement exactly this phase's candidate rule (reconciled). The hook's
  regex literal is that source verbatim; a unit test asserts equality.

**Leaves alone (owned by others):**
- every file under `src/` (Phase 7 owns the endpoint; this phase touches no server code)
- `claude/hooks/notes-session.mjs`, `claude/hooks/notes-spawn.mjs`, and the `ourGroups`/`OUR_SCRIPT` in `scripts/claude-hooks.mjs` (Phase 5)
- `src/sessions/ids.ts` `findNodeIdCandidates` (Phase 1)
- `scripts/claude-hooks.mjs` `PROMPT_TIMEOUT_S` (stays 20 s, see Step 6)
- `scripts/verify-prompt-hook.mjs` (see Step 6)
- `README.md` / `CHANGELOG.md` (Phase 14)

## Files

| File | Action | What changes |
|---|---|---|
| `claude/hooks/notes-prompt.mjs` | modify | header comment (`:1-23`); node-id section inserted after `buildContext` (`:275`); `pendingOutput` + `runPrompt` (`:277-348`) replaced by `imageContext` + new `runPrompt` |
| `claude/hooks/notes-prompt.d.mts` | modify | `NodeContext` type after `PromptIo` (`:39`); new exports; `runPrompt` opts gain `contextTimeoutMs` (`:79-86`) |
| `tests/unit/hooks/notesPrompt.test.ts` | modify | imports (`:10-27`); node fixtures/fakes after `contextOf` (`:120`); new `describe` blocks after `:419`; two process tests inside the process `describe` (before `:486`) |
| `tests/integration/prompt.hook.int.test.ts` | modify | imports (`:1`, `:11`); one test against the real `/api/sessions/context` after the "not /n" test (`:278`) |

## Implementation Steps

### Step 1: Rewrite the module header to describe the two jobs
**File:** `claude/hooks/notes-prompt.mjs:1-23`
**Change:** Replace lines 1-23 (shebang plus the doc comment) with the version below. Lines 24-66
(imports, existing constants, `pastedCall`, `buildPendingContext`, regexes) stay as they are. The
imports already have everything the new code needs (`daemonBaseUrl`, `errorText`, `stateDir`, `writeLog`).
**Code:**
```js
#!/usr/bin/env node
/**
 * notes-prompt: Claude Code UserPromptSubmit hook for mcp-notes. It does two jobs, and on a prompt
 * that needs neither it returns at once: no transcript read, no network, no log, no output.
 *
 * A. Node ids (any prompt). A prompt that quotes a Claude Code session node id such as A0-3G
 *    (see the "Node ids" section below for what counts as one) gets that node's summary, plan
 *    docs, commits and transcript path from GET /api/sessions/context?ids=... (CONTEXT_TIMEOUT_MS,
 *    fail soft). Ids the daemon does not know add nothing. Finding candidates is one regex test on
 *    the prompt, so a prompt without one costs nothing.
 *
 * B. Pasted images (`/n` prompts only). A picture pasted into Claude Code has no file path, and the
 *    Stop hook stores it only after the turn. On a `/n` prompt this hook stores the session's pasted
 *    pictures now and tells the model their ids, so "make that image a note" becomes
 *    create_image({image_id}) in the same turn:
 *    1. It reads the transcript once (the current prompt is not in it yet; a picture pasted in this
 *       very prompt is handed to the notes-paste PreToolUse hook via `pasted_image N`), and gathers
 *       the pictures of EVERY human prompt of the session (not only `/n` ones), newest MAX_IMAGES,
 *       with the Stop hook's caps.
 *    2. Pictures not uploaded before (per-session memo, prompt-images/<session>.json) are uploaded
 *       newest first to POST /api/chat/images (source claude_code, sha-deduped by the daemon, so the
 *       Stop hook's later capture of the same bytes gets the same ids) within UPLOAD_BUDGET_MS.
 *    3. It names "[Image #N] = <id>" oldest first, the newest marked "(latest)". When the newest
 *       picture could not be stored the context says so and marks no older picture as latest.
 *
 * Both run in parallel and their texts go out as ONE
 * {hookSpecificOutput:{hookEventName:'UserPromptSubmit', additionalContext}}, image text first,
 * then a blank line, then the node text.
 *
 * Always exits 0; stdout carries only the hook JSON (or nothing). Problems go to
 * ${XDG_STATE_HOME:-~/.local/state}/notes-capture/prompt.log. Node >= 22 built-ins only.
 */
```
**Impact:** Comment only.

### Step 2: Add the node-id section
**File:** `claude/hooks/notes-prompt.mjs`. Insert right after `buildContext` ends (`:275`,
the closing `}` of `buildContext`) and before the current `pendingOutput` (`:277`).
**Change:** New constants and functions. All pure except `fetchNodeContext` and `resolveNodeIds`.

**Candidate rule (decided here, justified):**
- **Upper case only, dash required.** Ids appear upper case everywhere (wall, SessionStart context,
  MCP output), so a user who copies one gets it upper case. Accepting lower case would send ordinary
  prose (`to-do`, `co-op`, `re-do`, `go-to`) to the daemon. Worse, it could match a real id by
  chance and inject an unrelated session. Dropping the dash would make every 4-letter word a
  candidate.
- **Bounded on both sides by something that is not part of a larger token.** The character before
  the id may not be a letter, digit, `_`, `-`, `/`, `\`, `.` or `:`. The character after it may not
  be a letter, digit, `_`, `-`, `/` or `\`, and may not be a `.` or `:` that is followed by a letter
  or digit. This rules out dates (`2026-11-02`), times (`10:30-11:00`), versions (`1.12-RC1`), paths
  (`a/A0-3G`, `C:\x\A0-3G`), file names (`A0-3G.md`), ticket keys (`UATP-2960`), `SHA-256` and
  `COVID-19`. It still accepts `A0-3G.` at the end of a sentence, and `(A0-3G)`, `` `A0-3G` ``,
  `"A0-3G"`, `**A0-3G**` and `…&node=A0-3G` (the wall URL). I checked these with node against this
  exact regex while planning.
- **At least one letter.** All-digit pairs are page ranges and scores (`10-15`, `20-30`), which
  are very common in prompts. Phase 1's `generateNodeId` never produces an all-digit id
  (reconciled), so no real node is lost by this rule.
- **At most `MAX_NODE_IDS` (5) distinct ids per prompt**, in the order they first appear.
- A candidate is only a question for the daemon. Ids that do not exist resolve to nothing, which
  is the settled decision. Note ids (`A-B32`) and chat image ids (`G-0NC`) have the 1-3 shape, so
  they never match.

**Code:**
```js
// ---------------------------------------------------------------------------------------------
// Node ids (R5). Any prompt, not only `/n`, may quote Claude Code session node ids such as A0-3G.
// The rule is src/sessions/ids.ts NODE_ID_CANDIDATE_SOURCE + findNodeIdCandidates; hooks are plain
// .mjs and cannot import TypeScript, so the regex is duplicated here verbatim. A unit test asserts
// NODE_ID_CANDIDATE.source === NODE_ID_CANDIDATE_SOURCE; change both together.
//
// Prompts are full of 2-2 dashed tokens that are not ids, so a candidate must be:
//  - upper case as typed, with the dash: ids are shown upper case everywhere, and lower-case prose
//    ("to-do", "co-op") would otherwise reach the daemon and could hit a real id by chance;
//  - a whole token: no letter, digit, _, -, /, \, . or : before it; no letter, digit, _, -, / or \
//    after it, and no "." or ":" followed by a letter or digit. Dates 2026-11-02, times
//    10:30-11:00, versions 1.12-RC1, paths a/A0-3G, files A0-3G.md and keys UATP-2960 never match;
//    "A0-3G." ending a sentence does;
//  - carrying at least one letter: all-digit pairs are ranges and scores ("10-15"); generated ids
//    are never all digits.
// A candidate is only a question for the daemon: ids that do not exist resolve to nothing.
// ---------------------------------------------------------------------------------------------

export const NODE_ID_CANDIDATE = /(?<![0-9A-Za-z_.\/:\\-])([0-9A-Z]{2}-[0-9A-Z]{2})(?![0-9A-Za-z_\/\\-]|[.:][0-9A-Za-z])/g;
const HAS_LETTER = /[A-Z]/;
export const MAX_NODE_IDS = 5;
export const CONTEXT_TIMEOUT_MS = 1500;
export const MAX_NODE_CONTEXT_CHARS = 9000;
/** Same text as src/sessions/view.ts CONTEXT_HEADER (Phase 7), used when the hook rebuilds the context. */
export const NODE_CONTEXT_HEADER =
  'Claude Code session nodes mentioned in this prompt (from mcp-notes; node ids look like A0-3G):';
export const NODE_TOOLS_HINT =
  'For more about one of them call session_get with node_id, or session_transcript with node_id and a query ' +
  '(only on the machine that holds its transcript).';

/** The distinct node-id candidates in a prompt, in order of first appearance, at most MAX_NODE_IDS. Pure: no I/O. */
export function nodeIdCandidates(prompt) {
  if (typeof prompt !== 'string' || prompt.length < 5 || !prompt.includes('-')) return [];
  const found = [];
  for (const match of prompt.matchAll(NODE_ID_CANDIDATE)) {
    const id = match[1];
    if (!HAS_LETTER.test(id) || found.includes(id)) continue;
    found.push(id);
    if (found.length === MAX_NODE_IDS) break;
  }
  return found;
}

/** `<base>/api/sessions/context?ids=A0-3G,B1-2C`. */
export function contextUrl(baseUrl, ids) {
  return `${baseUrl}/api/sessions/context?ids=${ids.map((id) => encodeURIComponent(id)).join(',')}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function clip(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The asked-for nodes of a /api/sessions/context answer ({nodes, missing, context}), in the order
 * of `asked`, plus the server's `context` text. Rows for ids not asked for, rows without node_id or
 * text, and repeats are dropped, so only ids that were asked for AND exist come back. When a row
 * was dropped, `context` is '' so the caller rebuilds the text from the kept rows.
 */
export function parseNodeContext(body, asked) {
  const rows = isRecord(body) && Array.isArray(body.nodes) ? body.nodes : [];
  const serverContext = isRecord(body) && typeof body.context === 'string' ? body.context : '';
  const wanted = new Set(asked);
  const byId = new Map();
  let returned = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const raw = nonEmpty(row.node_id);
    const text = nonEmpty(row.text);
    if (raw === null || text === null) continue;
    returned += 1;
    const id = raw.toUpperCase();
    if (!wanted.has(id) || byId.has(id)) continue;
    byId.set(id, { node_id: id, text });
  }
  const nodes = asked.filter((id) => byId.has(id)).map((id) => byId.get(id));
  return { nodes, context: nodes.length === returned ? serverContext.trim() : '' };
}

/** The additionalContext text for resolved nodes, or null when there are none. */
export function buildNodeContext({ nodes, context }) {
  if (nodes.length === 0) return null;
  const text = context !== '' ? context : [NODE_CONTEXT_HEADER, ...nodes.map((node) => node.text)].join('\n\n');
  return `${clip(text, MAX_NODE_CONTEXT_CHARS)}\n${NODE_TOOLS_HINT}`;
}

/** GET /api/sessions/context for `ids`; throws on a network error, timeout, non-2xx or bad JSON. */
export async function fetchNodeContext(ids, { fetchImpl, baseUrl, timeoutMs = CONTEXT_TIMEOUT_MS }) {
  const res = await fetchImpl(contextUrl(baseUrl, ids), {
    method: 'GET',
    headers: { accept: 'application/json', 'x-notes-capture': '1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`context failed: HTTP ${res.status}`);
  return parseNodeContext(await res.json(), ids);
}

/** The node context text for `ids`, or null (none exist, or the daemon failed: logged). Never throws. */
export async function resolveNodeIds(ids, { env, fetchImpl, timeoutMs = CONTEXT_TIMEOUT_MS }) {
  if (ids.length === 0) return null;
  try {
    return buildNodeContext(await fetchNodeContext(ids, { fetchImpl, baseUrl: daemonBaseUrl(env), timeoutMs }));
  } catch (err) {
    await writeLog(stateDir(env), LOG_FILE, `node ids ${ids.join(',')}: ${errorText(err)}`);
    return null;
  }
}
```
**Impact:** Additive. Nothing calls these until Step 3.

### Step 3: Split the `/n` image path out of `runPrompt`, and route both jobs
**File:** `claude/hooks/notes-prompt.mjs:277-348`
**Change:** Replace `pendingOutput` and `runPrompt` (lines 277-348, from `function pendingOutput(n) {`
through the closing `}` of `runPrompt`) with the code below. `imageContext` is the old body with
these differences:
- it returns context strings, not output objects (`pendingOutput(n)` becomes `buildPendingContext(n)`)
- it reads its io from one object

Every branch keeps its log lines and its null/pending/context result. `main()` (`:350-360`) and the
`isMainModule` line stay as they are.
**Code:**
```js
/**
 * The pasted-image context for a `/n` prompt (job B), or null to add none. Never throws. The caller
 * has checked isNotesPromptInput(input).
 */
export async function imageContext({ input, env, fetchImpl, readText, sleep, now }) {
  const dir = stateDir(env);
  const log = (message) => writeLog(dir, LOG_FILE, message);
  try {
    if (typeof input.transcript_path !== 'string' || input.transcript_path === '') {
      await log('no transcript_path in the hook input');
      return null;
    }
    const wanted = placeholderNumbers(input.prompt);
    const read = await readSettled(input.transcript_path, wanted, { readText, sleep, now });
    if (read === null) {
      await log(`transcript unreadable: ${input.transcript_path}`);
      // A session's first prompt: Claude Code creates the file only after the hooks finish.
      return wanted.length === 0 ? null : buildPendingContext(wanted[wanted.length - 1]);
    }
    const { entries, settled } = read;
    if (!settled) await log(`[Image #${wanted[wanted.length - 1]}] not in the transcript yet; the context points the model at pasted_image`);
    const candidates = collectImages(entries);
    if (candidates.length === 0) {
      return wanted.length === 0 ? null : buildPendingContext(wanted[wanted.length - 1]);
    }

    await pruneMemos(path.join(dir, MEMO_DIR), now());
    const file = memoFile(env, input.session_id);
    const memo = await readMemo(file);
    const selected = selectForContext(candidates, memo);
    const fresh = await uploadMissing(selected, {
      fetchImpl,
      baseUrl: daemonBaseUrl(env),
      now,
      log,
      deadline: now() + UPLOAD_BUDGET_MS,
    });
    if (file !== null && fresh.some((image) => image.key !== null)) {
      for (const image of fresh) if (image.key !== null) memo.set(image.key, image.id);
      try {
        await writeMemo(file, memo);
      } catch (err) {
        await log(`memo: ${errorText(err)}`);
      }
    }

    const stored = selected.filter((image) => image.id !== null).sort((a, b) => a.order - b.order);
    const newestOrder = candidates.length - 1;
    const newestStored = settled && stored.length > 0 && stored[stored.length - 1].order === newestOrder;
    const missing = newestStored
      ? null
      : { paste_id: settled ? candidates[newestOrder].paste_id : (wanted[wanted.length - 1] ?? null), pending: !settled };
    return buildContext(
      stored.map((image) => ({ paste_id: image.paste_id, id: image.id })),
      missing,
    );
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
    return null;
  }
}

/**
 * The hook output for one UserPromptSubmit input, or null to add nothing. Never throws.
 * Neither `/n` nor a node-id candidate: null before any I/O (no read, no fetch, no clock, no log).
 */
export async function runPrompt({
  input,
  env,
  fetchImpl = globalThis.fetch,
  readText = (file) => readFile(file, 'utf8'),
  sleep = delay,
  now = Date.now,
  contextTimeoutMs = CONTEXT_TIMEOUT_MS,
}) {
  const prompt = input !== null && typeof input === 'object' && typeof input.prompt === 'string' ? input.prompt : '';
  const nodeIds = nodeIdCandidates(prompt);
  const notes = isNotesPromptInput(input);
  if (!notes && nodeIds.length === 0) return null;
  const [images, nodes] = await Promise.all([
    notes ? imageContext({ input, env, fetchImpl, readText, sleep, now }) : Promise.resolve(null),
    resolveNodeIds(nodeIds, { env, fetchImpl, timeoutMs: contextTimeoutMs }),
  ]);
  const parts = [images, nodes].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: parts.join('\n\n') } };
}
```
**Impact:**
- When the prompt has no candidate, `resolveNodeIds([])` returns null at once with no I/O, so the
  `/n` output is identical to before. All existing unit and integration tests keep passing; none of
  their prompts contains a candidate (checked: `'/n make that image a new note [Image #2]'`,
  `'/new idea [Image #1]'`, `'please /n save'`, etc.).
- The two jobs run in parallel, so a `/n` prompt with an id takes at most
  max(UPLOAD_BUDGET_MS 8 s, CONTEXT_TIMEOUT_MS 1.5 s), well under `PROMPT_TIMEOUT_S` 20 s.

### Step 4: Types
**File:** `claude/hooks/notes-prompt.d.mts`
**Change (a):** Insert after the `PromptIo` interface (ends `:39`):
```ts
/** One resolved Claude Code session node: Phase 7's `nodes[]` row, reduced to what the hook uses. */
export interface NodeContext {
  node_id: string;
  /** Phase 7's per-node context text (summary, plan docs, commits, transcript path). */
  text: string;
}

/** The asked-for nodes plus the server's `context` ('' when the hook must rebuild it). */
export interface ParsedNodeContext {
  nodes: NodeContext[];
  context: string;
}
```
**Change (b):** Replace the `runPrompt` declaration (`:79-86`) with the block below (the new exports followed by the new `runPrompt`):
```ts
export const NODE_ID_CANDIDATE: RegExp;
export const MAX_NODE_IDS: number;
export const CONTEXT_TIMEOUT_MS: number;
export const MAX_NODE_CONTEXT_CHARS: number;
export const NODE_CONTEXT_HEADER: string;
export const NODE_TOOLS_HINT: string;

export function nodeIdCandidates(prompt: unknown): string[];
export function contextUrl(baseUrl: string, ids: string[]): string;
export function parseNodeContext(body: unknown, asked: string[]): ParsedNodeContext;
export function buildNodeContext(parsed: ParsedNodeContext): string | null;
export function fetchNodeContext(
  ids: string[],
  opts: { fetchImpl: FetchLike; baseUrl: string; timeoutMs?: number },
): Promise<ParsedNodeContext>;
export function resolveNodeIds(
  ids: string[],
  opts: { env: Env; fetchImpl: FetchLike; timeoutMs?: number },
): Promise<string | null>;
export function imageContext(opts: {
  input: { prompt: string; transcript_path?: unknown; session_id?: unknown };
  env: Env;
  fetchImpl: FetchLike;
  readText: (file: string) => Promise<string>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}): Promise<string | null>;
export function runPrompt(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  readText?: (file: string) => Promise<string>;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  contextTimeoutMs?: number;
}): Promise<UserPromptSubmitOutput | null>;
```
**Impact:** Typecheck of the tests that import the hook (`tsconfig.json` covers `tests/`).

### Step 5: Unit tests
**File:** `tests/unit/hooks/notesPrompt.test.ts`

**Change (a), imports `:10-27`:** replace the import block from `notes-prompt.mjs` with:
```ts
import {
  CONTEXT_HEADER,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_NODE_CONTEXT_CHARS,
  MAX_NODE_IDS,
  MEMO_MAX_AGE_MS,
  NODE_ID_CANDIDATE,
  NODE_CONTEXT_HEADER,
  NODE_TOOLS_HINT,
  TOOLS_HINT,
  TRANSCRIPT_POLL_MS,
  TRANSCRIPT_WAIT_MS,
  buildNodeContext,
  buildPendingContext,
  buildContext,
  imagesSettled,
  isNotesPromptInput,
  nodeIdCandidates,
  parseNodeContext,
  placeholderNumbers,
  runPrompt,
  selectForContext,
  type FetchLike,
  type PromptImage,
} from '../../../claude/hooks/notes-prompt.mjs';
import { NODE_ID_CANDIDATE_SOURCE, findNodeIdCandidates } from '../../../src/sessions/ids.js';
import { CONTEXT_HEADER as SERVER_CONTEXT_HEADER } from '../../../src/sessions/view.js';
```

**Change (b): fixtures and fake, inserted after `contextOf` (ends `:120`):**
```ts
/** Prompts with 2-2 dashed tokens that are NOT node-id candidates. */
const NEAR_MISSES = [
  'released on 2026-11-02',
  'meet at 10:30-11:00',
  'bump to 1.12-RC1 then v1.2.3-RC',
  'lower case a0-3g',
  'note A-B32 and image G-0NC',
  'pages 10-15',
  'AB-CD-EF',
  'see /p/A0-3G and C:\\x\\A0-3G',
  'open A0-3G.md',
  'SHA-256 COVID-19 UATP-2960',
  'x A0-3GZ',
  '_A0-3G',
];

/** /api/sessions/context `nodes[]` rows in the shape Phase 7 serves (text as its formatContext renders it). */
const NODE_TEXT = [
  'Session A0-3G "orch-project-session-graph-p8" (repo mcp-notes, branch main, host wsl; 2026-11-01 09:00-10:00)',
  'Summary: Planned phase 8: node ids in prompts resolve to context.',
  'Plan docs: docs/plans/PROJECT_SESSION_GRAPH_PLAN.md',
  'Commits: 8c259df chore(CLAUDE): add shortcut',
  'Transcript: /home/u/.claude/projects/-home-u-mcp-notes/b7c1.jsonl (resume with: claude --resume b7c1a2d3-0000-4000-8000-000000000001)',
].join('\n');
const NODE: Record<string, unknown> = { node_id: 'A0-3G', session_id: 'b7c1a2d3-0000-4000-8000-000000000001', text: NODE_TEXT };

const OTHER_HOST_TEXT = [
  'Session B1-2C "B1-2C" (repo mcp-notes, host gpd; 2026-10-30 07:00-08:00)',
  'Summary: not summarized yet.',
  'Transcript: on gpd, not readable from this machine.',
].join('\n');
const OTHER_HOST_NODE: Record<string, unknown> = { node_id: 'B1-2C', session_id: 'c9d8e7f6-0000-4000-8000-000000000002', text: OTHER_HOST_TEXT };

const NODE_BLOCK = [NODE_CONTEXT_HEADER, '', NODE_TEXT].join('\n') + `\n${NODE_TOOLS_HINT}`;

interface ContextDaemon {
  fetchImpl: FetchLike;
  urls: string[];
  methods: string[];
}

/**
 * A fake GET /api/sessions/context: answers {nodes, missing, context} with the rows whose node_id
 * was asked for (`lax`: every row), `status` as an error, or throws. Other URLs go to `images`
 * (the chat image fake). `context` is built the way Phase 7 builds it.
 */
function fakeContextDaemon(
  rows: Array<Record<string, unknown>>,
  opts: { status?: number; throws?: boolean; lax?: boolean; images?: Daemon } = {},
): ContextDaemon {
  const urls: string[] = [];
  const methods: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (!url.includes('/api/sessions/context')) {
      if (opts.images !== undefined) return opts.images.fetchImpl(url, init);
      throw new Error(`unexpected fetch ${url}`);
    }
    urls.push(url);
    methods.push(String(init.method));
    if (opts.throws === true) throw new TypeError('fetch failed');
    if (opts.status !== undefined) return new Response('{"error":"nope"}', { status: opts.status });
    const asked = (new URL(url).searchParams.get('ids') ?? '').split(',');
    const nodes = opts.lax === true ? rows : asked.flatMap((id) => rows.filter((row) => row.node_id === id));
    const missing = asked.filter((id) => !rows.some((row) => row.node_id === id));
    const context = nodes.length === 0 ? '' : [NODE_CONTEXT_HEADER, ...nodes.map((row) => String(row.text))].join('\n\n');
    return new Response(JSON.stringify({ nodes, missing, context }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, urls, methods };
}
```

**Change (c): new `describe` blocks, inserted after the `runPrompt: /n` describe closes (`:419`) and before `describe('notes-prompt.mjs as a process'`:**
```ts
describe('node ids: candidates', () => {
  it('finds upper-case, whole-token 2-2 ids with a letter, distinct, in order, at most MAX_NODE_IDS', () => {
    expect(nodeIdCandidates('what did A0-3G decide?')).toEqual(['A0-3G']);
    expect(nodeIdCandidates('(A0-3G), B1-2C and A0-3G.')).toEqual(['A0-3G', 'B1-2C']);
    expect(nodeIdCandidates('`A0-3G` "B1-2C" [C2-3D] **D3-4E**')).toEqual(['A0-3G', 'B1-2C', 'C2-3D', 'D3-4E']);
    expect(nodeIdCandidates('http://localhost:7317/projects?repo=mcp-notes&node=A0-3G')).toEqual(['A0-3G']);
    expect(nodeIdCandidates('A0-3G.\nnext line')).toEqual(['A0-3G']);
    expect(MAX_NODE_IDS).toBe(5);
    expect(nodeIdCandidates('AA-1A AB-1B AC-1C AD-1D AE-1E AF-1F AG-1G')).toEqual(['AA-1A', 'AB-1B', 'AC-1C', 'AD-1D', 'AE-1E']);
  });

  it('is the same rule as src/sessions/ids.ts (Phase 1)', () => {
    expect(NODE_ID_CANDIDATE.source).toBe(NODE_ID_CANDIDATE_SOURCE);
    expect(NODE_CONTEXT_HEADER).toBe(SERVER_CONTEXT_HEADER);
    const corpus = [...NEAR_MISSES, 'what did A0-3G decide?', '(A0-3G), B1-2C and A0-3G.', 'AA-1A AB-1B AC-1C AD-1D AE-1E AF-1F AG-1G'];
    for (const prompt of corpus) expect(nodeIdCandidates(prompt), prompt).toEqual(findNodeIdCandidates(prompt));
  });

  it('ignores dates, times, versions, paths, file names, lower case, note ids and all-digit pairs', () => {
    for (const prompt of NEAR_MISSES) expect(nodeIdCandidates(prompt), prompt).toEqual([]);
    expect(nodeIdCandidates(3)).toEqual([]);
    expect(nodeIdCandidates(undefined)).toEqual([]);
    expect(nodeIdCandidates('')).toEqual([]);
  });
});

describe('node ids: parse and render', () => {
  it('parseNodeContext keeps only asked ids, in asked order, and keeps the server context only when nothing was dropped', () => {
    const both = { nodes: [OTHER_HOST_NODE, NODE], missing: [], context: 'SERVER' };
    expect(parseNodeContext(both, ['B1-2C', 'A0-3G'])).toEqual({
      nodes: [
        { node_id: 'B1-2C', text: OTHER_HOST_TEXT },
        { node_id: 'A0-3G', text: NODE_TEXT },
      ],
      context: 'SERVER',
    });
    expect(parseNodeContext({ nodes: [{ node_id: 'a0-3g', text: 'x' }, { node_id: 'ZZ-9Q', text: 'not asked' }, { text: 'no id' }], context: 'SERVER' }, ['A0-3G'])).toEqual({
      nodes: [{ node_id: 'A0-3G', text: 'x' }],
      context: '',
    });
    expect(parseNodeContext({ nope: true }, ['A0-3G'])).toEqual({ nodes: [], context: '' });
    expect(parseNodeContext(null, ['A0-3G'])).toEqual({ nodes: [], context: '' });
  });

  it('buildNodeContext uses the server context, rebuilds it when rows were dropped, caps it, and is null for none', () => {
    expect(buildNodeContext({ nodes: [], context: '' })).toBeNull();
    const node = { node_id: 'A0-3G', text: NODE_TEXT };
    expect(buildNodeContext({ nodes: [node], context: 'SERVER' })).toBe(`SERVER\n${NODE_TOOLS_HINT}`);
    expect(buildNodeContext({ nodes: [node], context: '' })).toBe(NODE_BLOCK);
    const text = buildNodeContext({ nodes: [{ node_id: 'A0-3G', text: 'x'.repeat(20_000) }], context: '' })!;
    expect(text.length).toBe(MAX_NODE_CONTEXT_CHARS + 1 + NODE_TOOLS_HINT.length);
  });
});

describe('runPrompt: node ids', () => {
  it('a prompt with no candidate does no I/O at all, near misses included', async () => {
    let reads = 0;
    let fetches = 0;
    let ticks = 0;
    const io = {
      readText: async (): Promise<string> => {
        reads += 1;
        return '';
      },
      fetchImpl: (async () => {
        fetches += 1;
        return new Response('{}');
      }) as FetchLike,
      sleep: async (): Promise<void> => {
        ticks += 1;
      },
      now: (): number => {
        ticks += 1;
        return 0;
      },
    };
    for (const prompt of NEAR_MISSES) {
      expect(await runPrompt({ input: hookInput(prompt), env, ...io }), prompt).toBeNull();
    }
    expect(reads).toBe(0);
    expect(fetches).toBe(0);
    expect(ticks).toBe(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('an existing node id adds its context: one GET, no transcript read, no state', async () => {
    const daemon = fakeContextDaemon([NODE]);
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      return '';
    };
    const out = await runPrompt({ input: hookInput('continue what A0-3G started'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: NODE_BLOCK } });
    expect(daemon.urls).toEqual(['http://127.0.0.1:7499/api/sessions/context?ids=A0-3G']);
    expect(daemon.methods).toEqual(['GET']);
    expect(reads).toBe(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('a node id that does not exist adds nothing, even when the daemon answers with other rows', async () => {
    const strict = fakeContextDaemon([NODE]);
    expect(await runPrompt({ input: hookInput('what about ZZ-9Q?'), env, fetchImpl: strict.fetchImpl, ...fakeClock() })).toBeNull();
    expect(strict.urls).toEqual(['http://127.0.0.1:7499/api/sessions/context?ids=ZZ-9Q']);
    const lax = fakeContextDaemon([NODE], { lax: true });
    expect(await runPrompt({ input: hookInput('what about ZZ-9Q?'), env, fetchImpl: lax.fetchImpl, ...fakeClock() })).toBeNull();
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('several ids: one request, existing ones only, in prompt order, other-host transcript marked', async () => {
    const daemon = fakeContextDaemon([NODE, OTHER_HOST_NODE]);
    const out = await runPrompt({ input: hookInput('compare B1-2C with ZZ-9Q and A0-3G'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.urls).toEqual(['http://127.0.0.1:7499/api/sessions/context?ids=B1-2C,ZZ-9Q,A0-3G']);
    expect(contextOf(out)).toBe([NODE_CONTEXT_HEADER, OTHER_HOST_TEXT, NODE_TEXT].join('\n\n') + `\n${NODE_TOOLS_HINT}`);
  });

  it('fails soft: HTTP error, network error or timeout give null and a log line', async () => {
    const notFound = fakeContextDaemon([], { status: 404 });
    expect(await runPrompt({ input: hookInput('A0-3G?'), env, fetchImpl: notFound.fetchImpl, ...fakeClock() })).toBeNull();
    const down = fakeContextDaemon([], { throws: true });
    expect(await runPrompt({ input: hookInput('A0-3G?'), env, fetchImpl: down.fetchImpl, ...fakeClock() })).toBeNull();
    const hang: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    expect(await runPrompt({ input: hookInput('A0-3G?'), env, fetchImpl: hang, contextTimeoutMs: 20, ...fakeClock() })).toBeNull();
    const log = await readFile(logPath(), 'utf8');
    expect(log).toContain('node ids A0-3G: Error: context failed: HTTP 404');
    expect(log).toContain('node ids A0-3G: TypeError: fetch failed');
    expect(log).toContain('TimeoutError');
  });

  it('/n with a picture and a node id: one output, pictures first, then the node', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] for A0-3G', [png(RED_PNG_16)])]));
    const images = fakeDaemon({ [RED_PNG_16]: 'G-0NC' });
    const daemon = fakeContextDaemon([NODE], { images });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] for A0-3G'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(contextOf(out)).toBe(
      [
        `${CONTEXT_HEADER}[Image #1] = G-0NC (latest).`,
        '"That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].',
        TOOLS_HINT,
        '',
        NODE_BLOCK,
      ].join('\n'),
    );
    expect(images.uploads).toEqual([RED_PNG_16]);
    expect(daemon.urls).toHaveLength(1);
  });

  it('/n with a node id and no picture adds only the node; an unknown node leaves /n output as before', async () => {
    const daemon = fakeContextDaemon([NODE]);
    const nodeOnly = await runPrompt({
      input: hookInput('/n note what A0-3G did'),
      env,
      fetchImpl: daemon.fetchImpl,
      readText: async () => jsonl([assistantText('hi')]),
      ...fakeClock(),
    });
    expect(contextOf(nodeOnly)).toBe(NODE_BLOCK);
    const noFile = async (): Promise<string> => {
      throw new Error('ENOENT');
    };
    const pending = await runPrompt({ input: hookInput('/n save [Image #1] for ZZ-9Q'), env, fetchImpl: daemon.fetchImpl, readText: noFile, ...fakeClock() });
    expect(contextOf(pending)).toBe(buildPendingContext(1));
  });
});
```

**Change (d): two process tests**, appended inside `describe('notes-prompt.mjs as a process', ...)`
after the `'exits 0 with empty stdout on garbage stdin'` test (before the closing `});` at `:486`):
```ts
  it('prints one JSON line with the node context for a prompt naming an existing node', async () => {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(String(req.url));
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nodes: [NODE], missing: [], context: [NODE_CONTEXT_HEADER, NODE_TEXT].join('\n\n') }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const run = await runHook(JSON.stringify(hookInput('pick up where A0-3G left off')), { NOTESD_PORT: String(port) });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      const lines = run.stdout.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(parsed.hookSpecificOutput.additionalContext).toBe(NODE_BLOCK);
      expect(asked).toEqual(['/api/sessions/context?ids=A0-3G']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('exits 0 with empty stdout when the daemon is down for a node id, and logs', async () => {
    const run = await runHook(JSON.stringify(hookInput('pick up where A0-3G left off')), { NOTESD_PORT: '1' });
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await readFile(logPath(), 'utf8')).toContain('node ids A0-3G:');
  });
```
**Impact:** The existing tests are unchanged and still pass. `'runPrompt: not /n' > 'does no I/O at
all'` still covers the original inputs. The new near-miss test covers the R5 "no candidate means no
I/O" exit criterion.

### Step 6: Integration test against the real endpoint; scripts left alone
**File:** `tests/integration/prompt.hook.int.test.ts`
**Change (a):** Add `import { existsSync } from 'node:fs';` as the first import line (`:1`). Then
replace the hook import line (`:11`) `import { runPrompt } from '../../claude/hooks/notes-prompt.mjs';`
with:
```ts
import { NODE_CONTEXT_HEADER, runPrompt } from '../../claude/hooks/notes-prompt.mjs';
```
**Change (b):** Insert after the `'a prompt that is not /n does no I/O and prints nothing'` test
(which ends at `:278`):
```ts
  it('a node id that does not exist adds nothing: one GET to the real /api/sessions/context, no failure, /n unchanged', async () => {
    const plain = await writeTranscript([assistantText('hi')]);
    const net = countingFetch();
    const disk = countingRead();
    const out = await submit(plain, 'what did ZZ-9Q decide?', { fetchImpl: net.fetchImpl, readText: disk.readText });
    expect(out).toBeNull();
    expect(net.calls()).toBe(1);
    expect(disk.reads()).toBe(0);
    // The route answered 2xx with a parseable body: the hook logged no failure.
    expect(existsSync(path.join(tmp, 'state', 'notes-capture', 'prompt.log'))).toBe(false);

    const transcript = await writeTranscript(twoTurnSession());
    const ctx = contextOf(await submit(transcript, `${N_PROMPT} ZZ-9Q`));
    expect(ctx).toContain('(latest)');
    expect(ctx).not.toContain(NODE_CONTEXT_HEADER);
  });
```
**Impact:** This test checks the Phase 7 contract end to end. If the route is missing, guarded
same-origin, or answers 404 for unknown ids, the hook logs a failure and the `existsSync` assertion
fails. `twoTurnSession` already ends with a `/n` entry carrying `[Image #2]`, so appending
` ZZ-9Q` to the typed prompt still settles.

A positive end-to-end case (a seeded `cc_sessions` row resolving) is optional here: Phase 7's
`tests/integration/helpers/sessionsSeed.ts` can seed one row if the executor wants it. The
positive path is covered in unit tests and in the process test against a real HTTP server.

**Not changed, and why:**
- `scripts/verify-prompt-hook.mjs`: an opt-in, billed live check of the pasted-image path only. It
  does not list hook behaviours, and its `/n [Image #1]` prompt has no node-id candidate, so it is
  unaffected.
- `scripts/claude-hooks.mjs` `PROMPT_TIMEOUT_S = 20`: the node fetch (1.5 s) runs in parallel with
  the 8 s upload budget, so 20 s is still ample. The hook command and matcher are the same
  `UserPromptSubmit` entry, which already fires for every prompt.

## Verification

**Build:** `npm run typecheck`
**Tests:**
- `npx vitest run tests/unit/hooks/notesPrompt.test.ts`
- `npm test`
- `npm run test:int` (needs Phase 7 merged: the new int test hits `/api/sessions/context`)

**Manual check:** with the daemon from this branch running and at least one ingested session, open
a Claude Code session and type `what did <real node id> do?`. The model should cite that node's
summary or commits. Then type `released 2026-11-02, pages 10-15`. The prompt log
(`~/.local/state/notes-capture/prompt.log`) should get no new line and nothing should be added.
`/n` image flows behave as before.

**Exit criteria:**
- A prompt with no candidate does no I/O: the unit test asserts zero reads, fetches and clock calls
  and no state dir.
- An existing node id adds its summary, plan docs, commits and transcript path.
- A non-existent id adds nothing (unit test with a strict and a lax daemon; int test against the real route).
- A `/n` prompt with both gets one `hookSpecificOutput`.
- All pre-existing `/n` tests pass unchanged.

## Handoffs

- **Phase 7 / Phase 1 (reconciled):** the hook parses Phase 7's `{nodes, missing, context}` as
  published; the candidate rule is Phase 1's `NODE_ID_CANDIDATE_SOURCE` verbatim and
  `generateNodeId` never yields all-digit ids. If either side changes, the equality tests in
  Step 5 fail first.
- **Phase 7 or a later test phase:** a positive integration case for `notes-prompt` (seed one
  `cc_sessions` row through `SessionsRepo`, then assert that `runPrompt` adds its context). Phase 7's
  int tests own seeding helpers for sessions. Phase 8 can add this case once a helper exists; it is
  not required for R5's exit criteria.
- **Phase 14 (docs):** README hooks section. `notes-prompt.mjs` now runs for every prompt and
  resolves node ids. Describe the candidate rule and the 1.5 s fail-soft fetch.

## Rollback

Revert this phase's commit. It touches only `claude/hooks/notes-prompt.mjs`, its `.d.mts`, and two
test files. The hook returns to `/n`-only behaviour, and no schema, server or install change needs
undoing. Installed machines pick up the reverted hook on the next `scripts/install.sh` (the
`~/.claude/settings.json` hook entry points at the same file path and does not change).
