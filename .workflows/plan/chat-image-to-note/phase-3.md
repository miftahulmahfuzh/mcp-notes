# Phase 3: Claude Code `UserPromptSubmit` hook + registration + skill

**Plan set:** `CHAT_IMAGE_TO_NOTE_PLAN.md`
**Analysis:** `docs/analyzer/20261031-122441-Q7MX_code_analyzer.md`
**Satisfies:** R2, R3, R4, R5. A `/n` prompt in Claude Code arrives with the session's pasted images already stored in `chat_images` and named by id in `additionalContext` (R2), with "that image" pinned to the latest one (R3), back-filled from any earlier turn under the 8 / 20 MB / 48 MB caps, never blocking the prompt (R4), all pinned by unit tests (R5)
**Depends on:** none (runs in parallel with phase 1; nothing here calls the daemon's `image_id`, the hook only writes the words)
**Difficulty:** HARD
**Package:** `claude/hooks`, `scripts`, `claude/skills/n`

---

## Goal

After this phase a third Claude Code hook, `claude/hooks/notes-prompt.mjs`, is registered on `UserPromptSubmit`. On a `/n` prompt it reads the session transcript (waiting up to 2.5 s for the current prompt's pasted images to appear), uploads the session's newest ≤8 pasted images that are not yet stored to `POST /api/chat/images` (newest first, 8 s budget, per-session memo so nothing is uploaded twice), and injects the C2 `additionalContext` naming each `[Image #N]`'s chat image id with the latest marked. On every other prompt it returns at once with no I/O and prints nothing. `scripts/claude-hooks.mjs`, `install.sh` and `uninstall.sh` install / remove / report three hooks; the `/n` skill tells the model to use `create_image` / `attach_image` with `image_id` from that context.

## Facts this plan relies on (checked in the code / on this machine)

- `imagePasteIds` is a **per-session running counter**. Checked on real transcripts in `~/.claude/projects/*/*.jsonl` (2026-10-31): session `106b93e9…` has prompts with `[1]` then `[2]`; `1eefc442…` has `[2]` then `[3]`; `8bcf47c1…` has `[1,2,3]` in one prompt. So `[Image #N]` in a new prompt names a paste id that no earlier prompt carries. The "settled" test below relies on this.
- A pasted-image prompt is written as array content whose text block is what the user typed, including the `[Image #N]` placeholders (`8bcf47c1…`: `"additional requirements: … [Image #1]…"`; the `fixtures.ts` `imagePromptEntry` mirrors it).
- `uploadImage(image, {fetchImpl, baseUrl, n})` in `claude/hooks/notes-paste.mjs:98-117` posts multipart `file` + `source=claude_code` with header `x-notes-capture: 1` and its own `AbortSignal.timeout(15_000)`; it returns the id or throws. Imported, not edited.
- `notes-capture.mjs:32-35` exports `MAX_IMAGES`, `MAX_IMAGE_BYTES`, `MAX_IMAGES_BASE64_CHARS`, `IMAGE_MEDIA_TYPES`; `selectImages` (`:52-64`) is private. Phase 3 imports the four constants (one source of truth for invariant 7) and applies the same rules in its own selector. `notes-capture.mjs` runs `main()` only under `isMainModule`, so importing it has no side effect.
- `scripts/claude-hooks.mjs` `mergeHooks`, `removeHooks`, `ourHandlers`, `stripOurs` iterate events generically; only `OUR_SCRIPT` (`:22`), `ourGroups` (`:66-90`), the script-existence loop (`:206`) and the `status` lines (`:224-225`) know the hook set.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `claude/hooks/notes-prompt.mjs` (new, executable) exporting: constants `HOOK_EVENT`, `TRANSCRIPT_WAIT_MS` (2500), `TRANSCRIPT_POLL_MS` (250), `UPLOAD_BUDGET_MS` (8000), `MIN_UPLOAD_TIMEOUT_MS` (1000), `MEMO_DIR` (`'prompt-images'`), `MEMO_MAX_AGE_MS` (14 days), `LOG_FILE` (`'prompt.log'`), `CONTEXT_HEADER`, `TOOLS_HINT`, re-exports `MAX_IMAGES`, `MAX_IMAGE_BYTES`, `MAX_IMAGES_BASE64_CHARS`, `IMAGE_MEDIA_TYPES`; functions `isNotesPromptInput`, `placeholderNumbers`, `imagesSettled`, `readSettled`, `collectImages`, `selectForContext`, `memoFile`, `readMemo`, `writeMemo`, `pruneMemos`, `uploadMissing`, `buildContext`, `runPrompt({input, env, fetchImpl, readText, sleep, now})` (C3).
- `claude/hooks/notes-prompt.d.mts` (new).
- `claude/hooks/lib/transcript.mjs`: `isNotesPromptText(text)`, `listImagePrompts(entries)` → `[{entry, images}]` (C3).
- `scripts/claude-hooks.mjs`: `PROMPT_TIMEOUT_S` (20); `ourGroups` returns a third key `UserPromptSubmit`.
- State: `${XDG_STATE_HOME:-~/.local/state}/notes-capture/prompt-images/<session_id>.json` (0600, dir 0700): `{"<user_uuid>:<k>": "G-0NC", …}` where `k` is the 0-based index in `extractImages(entry)`. Files older than 14 days are deleted on each `/n` run. Log: `.../notes-capture/prompt.log`.
- C2 text (exact, owned here; phases 2 and 4 rely on its shape):
  ```
  Pasted images in this Claude Code session, oldest first: [Image #1] = G-AAA; [Image #2] = G-BBB; [Image #3] = G-0NC (latest).
  "That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].
  To save one as a new note call create_image with image_id (never path); to add one to an existing note call attach_image with id and image_id; to search with one call similar_images with upload_id.
  ```
  Newest not stored variant, emitted only when **at least one older image was stored** (line 2 replaced, no `(latest)` anywhere). When no image at all could be stored (daemon down, every upload failed) `runPrompt` returns `null` and the hook prints nothing (reconciled, index Decisions D1). "Settled" = the last human prompt carries every `[Image #N]` typed in the `/n` prompt (index Decisions D2):
  ```
  Pasted images in this Claude Code session, oldest first: [Image #1] = G-AAA.
  The latest pasted image ([Image #2]) could not be stored (it was not readable in time or its upload failed), so it has no id. If the user means that image, tell them it could not be stored and ask them to paste it again with the request; do not use an older image in its place.
  To save one as a new note call create_image with image_id (never path); …
  ```
  Hook stdout: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}` + `\n`, or nothing.
**Signature changes:** `ourGroups(options)` return type `Record<'Stop' | 'PreToolUse', …>` → `Record<'Stop' | 'PreToolUse' | 'UserPromptSubmit', …>` (`.d.mts`). `OUR_SCRIPT` regex widens to `notes-(?:capture|paste|prompt)\.mjs`.
**Requires (from earlier phases):** nothing at build/test time. At run time the model's `create_image({image_id})` / `attach_image({id, image_id})` calls need phase 1 (C1); phase 4's integration test proves the pair.
**Leaves alone (owned by others):** `src/**` (phases 1, 2), `claude/hooks/notes-capture.mjs` and `claude/hooks/notes-paste.mjs` (imported only, not edited), `tests/integration/**`, `scripts/verify-*.mjs`, `package.json`, `README.md`, `docs/INSTALL.md`, `CHANGELOG.md` (phase 4).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/hooks/lib/transcript.mjs` | modify | add `isNotesPromptText` (after `isNotesPrompt`, `:95`) and `listImagePrompts` (after `findLatestImagePrompt`, `:167`) |
| `claude/hooks/lib/transcript.d.mts` | modify | declare `ImagePrompt`, `isNotesPromptText`, `listImagePrompts` (`:16-24`) |
| `claude/hooks/notes-prompt.mjs` | create | the hook (complete file below), `chmod 755` |
| `claude/hooks/notes-prompt.d.mts` | create | type declarations for the typecheck |
| `scripts/claude-hooks.mjs` | modify | header (`:3-4`, `:10-11`), `OUR_SCRIPT` (`:22`), `PROMPT_TIMEOUT_S` (after `:26`), `ourGroups` (`:65-90`), `mergeHooks` comment (`:92`), install script check (`:206`), status (`:224-225`) |
| `scripts/claude-hooks.d.mts` | modify | `PROMPT_TIMEOUT_S`, `ourGroups` return type (`:12-20`) |
| `scripts/install.sh` | modify | header comment (`:4-5`), file check (`:110`), comment (`:247`), log line (`:255`) |
| `scripts/uninstall.sh` | modify | header comment (`:3-5`), messages (`:63`, `:66`, `:68`) |
| `claude/skills/n/SKILL.md` | modify | image tools paragraph (`:41-43`), Images section bullet on pasted images (`:198-205`) |
| `tests/unit/hooks/notesPrompt.test.ts` | create | unit + spawned-process tests for the hook |
| `tests/unit/hooks/transcript.test.ts` | modify | imports (`:2-11`), two new `describe` blocks appended |
| `tests/unit/scripts/claudeHooks.test.ts` | modify | three-group expectations, upgrade test, status test, install.sh path check |

12 files.

## Implementation Steps

### Step 1: `isNotesPromptText` and `listImagePrompts` in the transcript library
**File:** `claude/hooks/lib/transcript.mjs:95` (insert after `isNotesPrompt`) and `:167` (insert after `findLatestImagePrompt`)
**Change:** two new pure exports. `isNotesPrompt` itself is **not** changed (notes-capture behaviour stays byte for byte). `isNotesPromptText` uses the same `NOTES_PROMPT` regex on a raw string (the hook's `input.prompt`), accepting the typed form and the command-XML form.
**Code (insert after line 95):**
```js

/**
 * True when a raw prompt string is a `/n` prompt: `/n` then whitespace or the end, after leading
 * whitespace. Accepts the typed form (`/n save this`) and the command XML Claude Code writes for a
 * typed slash command. Pure: the UserPromptSubmit hook calls it before any I/O.
 */
export function isNotesPromptText(text) {
  if (typeof text !== 'string') return false;
  return NOTES_PROMPT.test(typedFromCommandXml(text).trimStart());
}
```
**Code (insert after line 167, i.e. after the closing brace of `findLatestImagePrompt`):**
```js

/**
 * Every human prompt that carries at least one base64 image, oldest first, with its images
 * (`extractImages`). An entry whose uuid was already seen (a rewritten line) is listed once.
 */
export function listImagePrompts(entries) {
  const prompts = [];
  if (!Array.isArray(entries)) return prompts;
  const seen = new Set();
  for (const entry of entries) {
    if (!isHumanPrompt(entry)) continue;
    if (typeof entry.uuid === 'string' && entry.uuid !== '') {
      if (seen.has(entry.uuid)) continue;
      seen.add(entry.uuid);
    }
    const images = extractImages(entry);
    if (images.length > 0) prompts.push({ entry, images });
  }
  return prompts;
}
```
**Impact:** additive only.

### Step 2: transcript type declarations
**File:** `claude/hooks/lib/transcript.d.mts` (whole file; additions are `ImagePrompt`, `isNotesPromptText`, `listImagePrompts`)
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

export interface ImagePrompt {
  entry: TranscriptEntry;
  images: PastedImage[];
}

export function parseTranscript(text: string): TranscriptEntry[];
export function isHumanPrompt(entry: unknown): boolean;
export function typedFromCommandXml(text: string): string;
export function promptText(entry: unknown): string;
export function isNotesPrompt(entry: unknown): boolean;
export function isNotesPromptText(text: unknown): boolean;
export function extractImages(entry: unknown): PastedImage[];
export function findTurn(entries: TranscriptEntry[]): Turn | null;
export function findLatestImagePrompt(entries: TranscriptEntry[]): TranscriptEntry | null;
export function listImagePrompts(entries: TranscriptEntry[]): ImagePrompt[];
export function pickPastedImage(images: PastedImage[], n: number): PastedImage | null;
```

### Step 3: the hook `claude/hooks/notes-prompt.mjs`
**File:** `claude/hooks/notes-prompt.mjs` (new). After writing: `chmod 755 claude/hooks/notes-prompt.mjs` (the other two hooks are `-rwxr-xr-x`; git records the mode).

Behaviour, precisely:
1. `isNotesPromptInput(input)` false (input not an object, `prompt` not a string, or not `/n`) → return `null` **before** computing any path, reading anything, logging, sleeping or calling `now`. `main()` still reads stdin (it must, to see the prompt) and prints nothing.
2. `/n`: `wanted = placeholderNumbers(input.prompt)` (distinct N of `[Image #N]`, ascending). `readSettled` reads the transcript, parses it, and returns as soon as `imagesSettled(entries, wanted)`: true when `wanted` is empty, or the **last human prompt** in the transcript carries every wanted N among its paste ids. Otherwise it sleeps `TRANSCRIPT_POLL_MS` and retries until `now() >= start + TRANSCRIPT_WAIT_MS` (11 reads at most with the defaults). A read that throws keeps the last good parse. No good read at all → log, `null`.
3. `collectImages(entries)`: every image of every `listImagePrompts` entry, oldest first, each with memo key `<uuid>:<k>` (null when the entry has no uuid). Empty → `null`.
4. `pruneMemos(<state>/prompt-images, now())`, then `readMemo(memoFile(env, input.session_id))` (`null` file when the session id is not `[A-Za-z0-9-]{1,100}`: no memo read or written, uploads still happen). `selectForContext(candidates, memo)` walks newest first: skip media types outside png/jpeg/gif/webp, skip decoded size > 20 MB, stop at `MAX_IMAGES` (8) selected; images not in the memo must also fit, together, in 48 MB of base64 (memoised ones transfer nothing and do not count). Each selected image carries `order` (its index in the candidates) and `id` (memo value or null).
5. `uploadMissing` walks the selection newest first, uploads each `id === null` image through `uploadImage` (imported from `./notes-paste.mjs`) with a fetch wrapper whose abort signal is the earlier of uploadImage's own 15 s and the remaining budget (min 1 s); stops when `now() >= start + UPLOAD_BUDGET_MS` (logs how many were left). A failed upload is logged (`image #N: …`) and skipped. Successes go into the memo, written atomically (tmp + rename, 0600) once.
6. The newest pasted image is "stored" only when the transcript settled **and** the last candidate (`order === candidates.length - 1`) has an id. Otherwise `missing = {paste_id}`: the newest candidate's paste id when settled, else the largest wanted N.
7. `buildContext(stored oldest first, missing)`: dedupes by id keeping the newest occurrence, labels `[Image #<paste_id>]`, marks the last one `(latest)` only when `missing === null`, and returns `null` when nothing was stored. `runPrompt` returns `{hookSpecificOutput:{hookEventName:'UserPromptSubmit', additionalContext}}` or `null`.
8. Everything inside a `try`; any throw → log `hook: …`, `null`. `main()` always `process.exit(0)` and writes only the JSON line.

Worst-case wall time on `/n`: 2.5 s poll + 8 s uploads (+ ≤1 s grace for the last request's minimum timeout) ≈ 11.5 s, under the 20 s hook timeout.

**Code:**
```js
#!/usr/bin/env node
/**
 * notes-prompt: Claude Code UserPromptSubmit hook for mcp-notes.
 *
 * A picture pasted into Claude Code has no file path, and the Stop hook stores it only after the
 * turn. On a `/n` prompt this hook stores the session's pasted pictures now and tells the model
 * their ids, so "make that image a note" becomes create_image({image_id}) in the same turn:
 *
 * 1. Any prompt that is not `/n` returns at once: no transcript read, no network, no log, no
 *    output.
 * 2. On `/n` it reads the transcript, waiting up to TRANSCRIPT_WAIT_MS for the current prompt's
 *    "[Image #N]" pictures to be written, and gathers the pictures of EVERY human prompt of the
 *    session (not only `/n` ones), newest MAX_IMAGES, with the Stop hook's caps.
 * 3. Pictures not uploaded before (per-session memo, prompt-images/<session>.json) are uploaded
 *    newest first to POST /api/chat/images (source claude_code, sha-deduped by the daemon, so the
 *    Stop hook's later capture of the same bytes gets the same ids) within UPLOAD_BUDGET_MS.
 * 4. It prints {hookSpecificOutput:{hookEventName:'UserPromptSubmit', additionalContext}} naming
 *    "[Image #N] = <id>" oldest first, the newest marked "(latest)". When the newest picture could
 *    not be stored the context says so and marks no older picture as latest.
 *
 * Always exits 0; stdout carries only the hook JSON (or nothing). Problems go to
 * ${XDG_STATE_HOME:-~/.local/state}/notes-capture/prompt.log. Node >= 22 built-ins only.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';
import { extractImages, isHumanPrompt, isNotesPromptText, listImagePrompts, parseTranscript } from './lib/transcript.mjs';
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_BASE64_CHARS } from './notes-capture.mjs';
import { uploadImage } from './notes-paste.mjs';

export { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_BASE64_CHARS };

export const HOOK_EVENT = 'UserPromptSubmit';
export const TRANSCRIPT_WAIT_MS = 2500;
export const TRANSCRIPT_POLL_MS = 250;
export const UPLOAD_BUDGET_MS = 8000;
export const MIN_UPLOAD_TIMEOUT_MS = 1000;
export const MEMO_DIR = 'prompt-images';
export const MEMO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const LOG_FILE = 'prompt.log';
export const CONTEXT_HEADER = 'Pasted images in this Claude Code session, oldest first: ';
export const TOOLS_HINT =
  'To save one as a new note call create_image with image_id (never path); to add one to an existing note ' +
  'call attach_image with id and image_id; to search with one call similar_images with upload_id.';

const IMAGE_PLACEHOLDER = /\[Image #(\d{1,4})\]/g;
const CHAT_IMAGE_ID = /^[0-9A-Z]-[0-9A-Z]{3}$/;
const SAFE_NAME = /^[A-Za-z0-9-]{1,100}$/;

/** True for a UserPromptSubmit input whose prompt is `/n ...`. Pure: no I/O. */
export function isNotesPromptInput(input) {
  return input !== null && typeof input === 'object' && typeof input.prompt === 'string' && isNotesPromptText(input.prompt);
}

/** The distinct N of every "[Image #N]" in the typed prompt, ascending. */
export function placeholderNumbers(prompt) {
  const found = new Set();
  for (const match of String(prompt).matchAll(IMAGE_PLACEHOLDER)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The transcript shows the current prompt's pictures: nothing is wanted, or the last human prompt
 * carries every wanted paste id. Paste ids are a per-session counter, so an earlier prompt never
 * carries the current prompt's numbers.
 */
export function imagesSettled(entries, wanted) {
  if (wanted.length === 0) return true;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!isHumanPrompt(entries[i])) continue;
    const pasteIds = new Set(extractImages(entries[i]).map((image) => image.paste_id));
    return wanted.every((n) => pasteIds.has(n));
  }
  return false;
}

/** Reads and parses the transcript until `imagesSettled` or the wait is over. Null when it was never readable. */
export async function readSettled(transcriptPath, wanted, { readText, sleep, now }) {
  const deadline = now() + TRANSCRIPT_WAIT_MS;
  let entries = null;
  for (;;) {
    try {
      entries = parseTranscript(await readText(transcriptPath));
    } catch {
      // Unreadable this time: keep the last good parse and poll again.
    }
    if (entries !== null && imagesSettled(entries, wanted)) return { entries, settled: true };
    if (now() >= deadline) break;
    await sleep(TRANSCRIPT_POLL_MS);
  }
  return entries === null ? null : { entries, settled: false };
}

/** Every picture of every image-carrying human prompt, oldest first, with its memo key `<uuid>:<k>`. */
export function collectImages(entries) {
  const images = [];
  for (const { entry, images: own } of listImagePrompts(entries)) {
    const uuid = typeof entry.uuid === 'string' && entry.uuid !== '' ? entry.uuid : null;
    own.forEach((image, k) => {
      images.push({
        key: uuid === null ? null : `${uuid}:${k}`,
        media_type: image.media_type,
        data_base64: image.data_base64,
        paste_id: image.paste_id,
      });
    });
  }
  return images;
}

/**
 * The pictures to name, newest first: at most MAX_IMAGES, png/jpeg/gif/webp, at most
 * MAX_IMAGE_BYTES each; the ones still to upload must fit together in MAX_IMAGES_BASE64_CHARS.
 * `order` is the index in `candidates`; `id` is the memoised chat image id or null.
 */
export function selectForContext(candidates, memo) {
  const selected = [];
  let total = 0;
  for (let i = candidates.length - 1; i >= 0 && selected.length < MAX_IMAGES; i -= 1) {
    const image = candidates[i];
    if (!IMAGE_MEDIA_TYPES.has(image.media_type)) continue;
    if (Math.floor((image.data_base64.length * 3) / 4) > MAX_IMAGE_BYTES) continue;
    const known = image.key !== null && memo.has(image.key) ? memo.get(image.key) : null;
    if (known === null) {
      if (total + image.data_base64.length > MAX_IMAGES_BASE64_CHARS) continue;
      total += image.data_base64.length;
    }
    selected.push({ ...image, order: i, id: known });
  }
  return selected;
}

/** `<state>/prompt-images/<session>.json`, or null when the session id is not a safe file name. */
export function memoFile(env, session) {
  if (typeof session !== 'string' || !SAFE_NAME.test(session)) return null;
  return path.join(stateDir(env), MEMO_DIR, `${session}.json`);
}

/** The memo as a Map key -> chat image id; empty when absent, unreadable or not an object. */
export async function readMemo(file) {
  const memo = new Map();
  if (file === null) return memo;
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, id] of Object.entries(value)) {
        if (typeof id === 'string' && CHAT_IMAGE_ID.test(id)) memo.set(key, id);
      }
    }
  } catch {
    // No memo yet, or a torn one: start empty.
  }
  return memo;
}

/** Writes the memo atomically (0600, directory 0700). */
export async function writeMemo(file, memo) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(Object.fromEntries(memo)), { mode: 0o600 });
  await rename(tmp, file);
}

/** Deletes memo (and stray temp) files older than MEMO_MAX_AGE_MS. Returns how many went. Never throws. */
export async function pruneMemos(dir, nowMs) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
    const file = path.join(dir, name);
    try {
      if (nowMs - (await stat(file)).mtimeMs > MEMO_MAX_AGE_MS) {
        await unlink(file);
        removed += 1;
      }
    } catch {
      // Removed meanwhile.
    }
  }
  return removed;
}

/** A fetch whose abort signal also fires after `remainingMs` (at least MIN_UPLOAD_TIMEOUT_MS). */
function withDeadline(fetchImpl, remainingMs) {
  return (url, init) => {
    const limit = AbortSignal.timeout(Math.max(MIN_UPLOAD_TIMEOUT_MS, remainingMs));
    const signal = init !== undefined && init.signal ? AbortSignal.any([init.signal, limit]) : limit;
    return fetchImpl(url, { ...init, signal });
  };
}

/**
 * Uploads the selected pictures that have no id yet, newest first (the order of `selected`),
 * until `deadline`. Sets `id` on each success and returns the newly stored ones.
 */
export async function uploadMissing(selected, { fetchImpl, baseUrl, now, log, deadline }) {
  const stored = [];
  const pending = selected.filter((image) => image.id === null);
  for (let i = 0; i < pending.length; i += 1) {
    const image = pending[i];
    const remaining = deadline - now();
    if (remaining <= 0) {
      await log(`upload budget spent; ${pending.length - i} pasted image(s) not stored`);
      break;
    }
    try {
      image.id = await uploadImage(image, { fetchImpl: withDeadline(fetchImpl, remaining), baseUrl, n: image.paste_id });
      stored.push(image);
    } catch (err) {
      await log(`image #${image.paste_id}: ${errorText(err)}`);
    }
  }
  return stored;
}

/**
 * The additionalContext text. `images` are the stored pictures oldest first ({paste_id, id});
 * `missing` is null when the last of them is the session's newest picture, else {paste_id}
 * (paste id of the newest picture, or null when unknown). Null when nothing was stored.
 */
export function buildContext(images, missing) {
  const seen = new Set();
  const unique = [];
  for (let i = images.length - 1; i >= 0; i -= 1) {
    const image = images[i];
    if (seen.has(image.id)) continue;
    seen.add(image.id);
    unique.unshift(image);
  }
  if (unique.length === 0) return null;
  const last = unique[unique.length - 1];
  const named = unique.map((image) => `[Image #${image.paste_id}] = ${image.id}${missing === null && image === last ? ' (latest)' : ''}`);
  const lines = [`${CONTEXT_HEADER}${named.join('; ')}.`];
  if (missing === null) {
    lines.push(`"That image" or "this image" means the latest one, ${last.id}, unless the user names another id or [Image #N].`);
  } else {
    const which = missing.paste_id === null ? 'The latest pasted image' : `The latest pasted image ([Image #${missing.paste_id}])`;
    lines.push(
      `${which} could not be stored (it was not readable in time or its upload failed), so it has no id. ` +
        'If the user means that image, tell them it could not be stored and ask them to paste it again with the request; ' +
        'do not use an older image in its place.',
    );
  }
  lines.push(TOOLS_HINT);
  return lines.join('\n');
}

/** The hook output for one UserPromptSubmit input, or null to add nothing. Never throws. */
export async function runPrompt({
  input,
  env,
  fetchImpl = globalThis.fetch,
  readText = (file) => readFile(file, 'utf8'),
  sleep = delay,
  now = Date.now,
}) {
  if (!isNotesPromptInput(input)) return null;
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
      return null;
    }
    const { entries, settled } = read;
    if (!settled) await log(`[Image #${wanted[wanted.length - 1]}] not in the transcript after ${TRANSCRIPT_WAIT_MS} ms`);
    const candidates = collectImages(entries);
    if (candidates.length === 0) return null;

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
      : { paste_id: settled ? candidates[newestOrder].paste_id : (wanted[wanted.length - 1] ?? null) };
    const context = buildContext(
      stored.map((image) => ({ paste_id: image.paste_id, id: image.id })),
      missing,
    );
    if (context === null) return null;
    return { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: context } };
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
    return null;
  }
}

async function main() {
  let output = null;
  try {
    const input = JSON.parse(await readStdin());
    output = await runPrompt({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
```
**Impact:** new file; no existing behaviour changes. Logs never carry prompt text or image bytes (only paste numbers, counts, HTTP status, the transcript path).

Note on the "settled but missing" case: when `wanted` is empty (the `/n` prompt pasted nothing), `settled` is true at once and "latest" is the newest picture of any earlier turn, which is the R3 default. When the newest picture fails the caps (e.g. a `.bmp` or > 20 MB), it is the last candidate but not selected, so `missing` names it and nothing is marked latest.

### Step 4: hook type declarations
**File:** `claude/hooks/notes-prompt.d.mts` (new)
**Code:**
```ts
import type { PastedImage, TranscriptEntry } from './lib/transcript.mjs';
export { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_BASE64_CHARS } from './notes-capture.mjs';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One pasted picture of the session, with its memo key `<user_uuid>:<k>` (null without a uuid). */
export interface PromptImage extends PastedImage {
  key: string | null;
}

export interface SelectedImage extends PromptImage {
  /** Index in the `collectImages` list (transcript order). */
  order: number;
  /** Chat image id once stored (memo or upload), else null. */
  id: string | null;
}

export interface ContextImage {
  paste_id: number;
  id: string;
}

export interface MissingLatest {
  paste_id: number | null;
}

export interface UserPromptSubmitOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export interface PromptIo {
  readText: (file: string) => Promise<string>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}

export const HOOK_EVENT: 'UserPromptSubmit';
export const TRANSCRIPT_WAIT_MS: number;
export const TRANSCRIPT_POLL_MS: number;
export const UPLOAD_BUDGET_MS: number;
export const MIN_UPLOAD_TIMEOUT_MS: number;
export const MEMO_DIR: string;
export const MEMO_MAX_AGE_MS: number;
export const LOG_FILE: string;
export const CONTEXT_HEADER: string;
export const TOOLS_HINT: string;

export function isNotesPromptInput(input: unknown): boolean;
export function placeholderNumbers(prompt: string): number[];
export function imagesSettled(entries: TranscriptEntry[], wanted: number[]): boolean;
export function readSettled(
  transcriptPath: string,
  wanted: number[],
  io: PromptIo,
): Promise<{ entries: TranscriptEntry[]; settled: boolean } | null>;
export function collectImages(entries: TranscriptEntry[]): PromptImage[];
export function selectForContext(candidates: PromptImage[], memo: Map<string, string>): SelectedImage[];
export function memoFile(env: Env, session: unknown): string | null;
export function readMemo(file: string | null): Promise<Map<string, string>>;
export function writeMemo(file: string, memo: Map<string, string>): Promise<void>;
export function pruneMemos(dir: string, nowMs: number): Promise<number>;
export function uploadMissing(
  selected: SelectedImage[],
  opts: {
    fetchImpl: FetchLike;
    baseUrl: string;
    now: () => number;
    log: (message: string) => Promise<void>;
    deadline: number;
  },
): Promise<SelectedImage[]>;
export function buildContext(images: ContextImage[], missing: MissingLatest | null): string | null;
export function runPrompt(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  readText?: (file: string) => Promise<string>;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}): Promise<UserPromptSubmitOutput | null>;
```

### Step 5: register the third hook in `scripts/claude-hooks.mjs`
**File:** `scripts/claude-hooks.mjs`

5a. Header, lines 3-4 and 10-11, become:
```js
 * Adds, removes or reports the three mcp-notes Claude Code hooks in a settings.json
 * (normally ~/.claude/settings.json), leaving every other key and every other hook as it was.
```
```js
 * Our handlers are recognised by the script name in their command (notes-capture.mjs,
 * notes-paste.mjs, notes-prompt.mjs), so an entry left by another checkout is replaced, never duplicated. install is
```

5b. Line 22, `OUR_SCRIPT`, and a new constant after line 26 (`PASTE_TIMEOUT_S`):
```js
export const OUR_SCRIPT = /notes-(?:capture|paste|prompt)\.mjs(?=['"\s]|$)/;
```
```js
export const PROMPT_TIMEOUT_S = 20;
```

5c. Lines 65-90, `ourGroups`, replaced whole (the `UserPromptSubmit` group is synchronous: no `async`, no `matcher`, which `UserPromptSubmit` ignores anyway):
```js
/** The three matcher groups this repo installs. */
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
    UserPromptSubmit: {
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodeBin, path.join(hooksDir, 'notes-prompt.mjs')),
          timeout: PROMPT_TIMEOUT_S,
        },
      ],
    },
  };
}
```

5d. Line 92 comment: `/** \`settings\` with our handlers removed from every event and our groups appended last. */` (function body unchanged).

5e. Line 206, script existence check:
```js
    for (const script of ['notes-capture.mjs', 'notes-paste.mjs', 'notes-prompt.mjs']) {
```

5f. Lines 224-225, `status`:
```js
    process.stdout.write(`Stop notes-capture: ${found.Stop ?? 'not registered'}\n`);
    process.stdout.write(`PreToolUse notes-paste: ${found.PreToolUse ?? 'not registered'}\n`);
    process.stdout.write(`UserPromptSubmit notes-prompt: ${found.UserPromptSubmit ?? 'not registered'}\n`);
```
**Impact:** an existing two-hook install gains the third group on the next `scripts/install.sh`; `removeHooks` already strips any handler matching `OUR_SCRIPT`, so uninstall removes all three and drops the then-empty `UserPromptSubmit` key. A user's own `UserPromptSubmit` hooks are kept (generic `stripOurs`).

### Step 6: `scripts/claude-hooks.d.mts`
**File:** `scripts/claude-hooks.d.mts` (whole file)
**Code:**
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
export const PROMPT_TIMEOUT_S: number;
export const PASTE_STRATEGIES: string[];
export function shQuote(value: string): string;
export function hookCommand(nodeBin: string, script: string, env?: Record<string, string>): string;
export function isOurHandler(handler: unknown): boolean;
export function ourGroups(options: HookOptions): Record<'Stop' | 'PreToolUse' | 'UserPromptSubmit', Record<string, unknown>>;
export function mergeHooks(settings: unknown, options: HookOptions): Record<string, unknown>;
export function removeHooks<T>(settings: T): T;
export function ourHandlers(settings: unknown): Record<string, string>;
export function readSettings(file: string): Promise<SettingsFile>;
export function serialize(value: unknown): string;
export function writeSettings(file: string, current: SettingsFile, next: unknown): Promise<'unchanged' | 'written'>;
```

### Step 7: `scripts/install.sh`
**File:** `scripts/install.sh`

Lines 3-5 (header) become:
```bash
# `notes` MCP server (user scope), link the /n skill into ~/.claude/skills/n, and register the
# three mcp-notes Claude Code hooks (notes-capture: Stop, saves /n exchanges to the chat history;
# notes-paste: PreToolUse on similar_images, uploads a pasted image; notes-prompt:
# UserPromptSubmit on /n prompts, stores the session's pasted images and names their ids) in
# ~/.claude/settings.json.
```
(Line 2, `# Install or refresh notesd as a systemd user service, register it with Claude Code as the`, stays; the old lines 3-5 are replaced by these five.)

Line 110:
```bash
  for hk in "$HOOKS_DIR/notes-capture.mjs" "$HOOKS_DIR/notes-paste.mjs" "$HOOKS_DIR/notes-prompt.mjs" "$HOOKS_HELPER"; do
```

Line 247:
```bash
# Merge the three hook entries into ~/.claude/settings.json (user scope: every repo). Everything
```

Line 255:
```bash
  log "registering the three Claude Code hooks (notes-capture, notes-paste, notes-prompt) in $CLAUDE_SETTINGS"
```

### Step 8: `scripts/uninstall.sh`
**File:** `scripts/uninstall.sh`

Lines 3-5 become:
```bash
# `notes` MCP server (user scope), remove the /n skill symlink, and remove the three hook entries
# (notes-capture, notes-paste, notes-prompt) from ~/.claude/settings.json (every other setting and
# hook is kept). Keeps the data dir (~/mcp-notes-data), linger, the hooks' outbox, pasted-image memos and logs
```
(line 6 `# (~/.local/state/notes-capture) and settings.json.bak-notes-hooks. The Windows keepalive task is` is unchanged.)

Lines 63, 66, 68:
```bash
    warn "node not found; remove the notes-capture, notes-paste and notes-prompt entries from $CLAUDE_SETTINGS by hand"
```
```bash
  log "removing the three Claude Code hooks (notes-capture, notes-paste, notes-prompt) from $CLAUDE_SETTINGS"
```
```bash
    || warn "could not edit $CLAUDE_SETTINGS; remove the notes-capture, notes-paste and notes-prompt entries by hand"
```

### Step 9: the `/n` skill
**File:** `claude/skills/n/SKILL.md`

9a. Lines 41-43 (inside the "spine tools" paragraph) become:
```markdown
`revisions` and `revert`. The image tools are `create_image` (a new note from a local file
path, or from a pasted image's id), `attach_image` (add a local file or a pasted image to an
existing note), `remove_image` and
```
(line 44 onwards, `` `restore_image` (take one image out of its note, softly, and put it back), `view_images` (see ``, unchanged.)

9b. Lines 198-205 (the pasted-image bullet) are replaced by these two bullets (the second keeps the old `pasted_image` text for `similar_images`, minus the "never save it as a note" clause that the first bullet now governs):
```markdown
- Pasted images and `/n`: when your `/n` request comes with a note that starts "Pasted images
  in this Claude Code session", a hook has already stored those pictures and lists each one as
  `[Image #N] = <id>` (ids look like `G-0NC`), the newest marked "(latest)". "Make that image a
  new note", "save this picture" → `create_image` with `image_id` set to the latest id (or the
  one the user names: another `[Image #N]`, "the first image", or an explicit id), a short body
  with hashtags, and `origin`. "Add it to A-B32" → `attach_image` with `id` and `image_id`.
  `created: false` / `attached: false` mean that picture is already in a note: say which note.
  Never ask for a file path for a pasted image and never pass one. If the note says the latest
  image could not be stored, tell the user in one line and ask them to paste it again with the
  request; do not use an older image instead. With no such note there is no id: ask the user to
  paste the image again together with the `/n` request. Save a pasted image as a note only when
  asked.
- An image the user pasted into this conversation shows as `[Image #1]`, `[Image #2]`, … in
  their message and has no file path. "Find photos like this", "do I have similar pictures" →
  call `similar_images` with `pasted_image: 1` (the number in `[Image #N]`; 1 for the first or
  only one), or with `upload_id` set to its id when the pasted-images note gives one. A hook
  uploads that image and the server searches with it. Then call `view_images` on the top hits
  (their note ids or image ids) so you actually see them, and say how each one matches. If
  `similar_images` answers that the pasted image could not be resolved, tell the user in one
  line and ask them to paste the image again together with the request. Never ask for a file
  path for a pasted image.
```
**Impact:** wording only; the `similar_images({pasted_image})` path and its PreToolUse hook are unchanged.

### Step 10: transcript tests
**File:** `tests/unit/hooks/transcript.test.ts`

10a. Import block, lines 2-11, becomes:
```ts
import {
  extractImages,
  findLatestImagePrompt,
  findTurn,
  isHumanPrompt,
  isNotesPrompt,
  isNotesPromptText,
  listImagePrompts,
  parseTranscript,
  pickPastedImage,
  promptText,
} from '../../../claude/hooks/lib/transcript.mjs';
```

10b. Append at the end of the file (after line 163):
```ts

describe('isNotesPromptText', () => {
  it('accepts /n typed or as command XML, nothing else', () => {
    expect(isNotesPromptText('/n')).toBe(true);
    expect(isNotesPromptText('/n make that image a note')).toBe(true);
    expect(isNotesPromptText('  /n leading spaces')).toBe(true);
    expect(isNotesPromptText('/n\n[Image #1]')).toBe(true);
    expect(isNotesPromptText('<command-message>n</command-message>\n<command-name>/n</command-name>\n<command-args>save it</command-args>')).toBe(true);
    expect(isNotesPromptText('/notes list')).toBe(false);
    expect(isNotesPromptText('/new thing')).toBe(false);
    expect(isNotesPromptText('please run /n later')).toBe(false);
    expect(isNotesPromptText('')).toBe(false);
    expect(isNotesPromptText(undefined)).toBe(false);
    expect(isNotesPromptText(42)).toBe(false);
  });
});

describe('listImagePrompts', () => {
  it('lists every image-carrying human prompt oldest first, /n or not', () => {
    const first = imagePromptEntry('look [Image #1] [Image #2]', [
      { media_type: 'image/png', data: RED_PNG_16 },
      { media_type: 'image/jpeg', data: BLUE_DATA },
    ]);
    const second = imagePromptEntry('/n and this [Image #3]', [{ media_type: 'image/png', data: BLUE_DATA }], [3]);
    const entries = parseTranscript(
      jsonl([
        first,
        assistantText('ok'),
        plainPromptEntry('no picture here'),
        toolResultEntry('t1', 'result'),
        imagePromptEntry('sub [Image #9]', [{ media_type: 'image/png', data: RED_PNG_16 }], [9], { isSidechain: true }),
        second,
        attachmentEntry(),
      ]),
    );
    const listed = listImagePrompts(entries);
    expect(listed.map((p) => p.entry.uuid)).toEqual([first.uuid, second.uuid]);
    expect(listed[0]!.images.map((i) => i.paste_id)).toEqual([1, 2]);
    expect(listed[0]!.images[1]!.media_type).toBe('image/jpeg');
    expect(listed[1]!.images).toEqual([{ media_type: 'image/png', data_base64: BLUE_DATA, paste_id: 3 }]);
  });

  it('lists a rewritten line (same uuid) once, and is empty without images', () => {
    const entry = imagePromptEntry('x [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]);
    expect(listImagePrompts(parseTranscript(jsonl([entry, entry])))).toHaveLength(1);
    expect(listImagePrompts(parseTranscript(jsonl([commandEntry('hi'), assistantText('ok')])))).toEqual([]);
  });
});
```
(`attachmentEntry`, `toolResultEntry`, `assistantText`, `commandEntry`, `plainPromptEntry`, `imagePromptEntry`, `jsonl`, `BLUE_DATA`, `RED_PNG_16` are already imported at lines 12-25.)

### Step 11: hook tests
**File:** `tests/unit/hooks/notesPrompt.test.ts` (new)
**Code:**
```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTranscript } from '../../../claude/hooks/lib/transcript.mjs';
import {
  CONTEXT_HEADER,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MEMO_MAX_AGE_MS,
  TOOLS_HINT,
  TRANSCRIPT_POLL_MS,
  TRANSCRIPT_WAIT_MS,
  buildContext,
  imagesSettled,
  isNotesPromptInput,
  placeholderNumbers,
  runPrompt,
  selectForContext,
  type FetchLike,
  type PromptImage,
} from '../../../claude/hooks/notes-prompt.mjs';
import { RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl, plainPromptEntry } from './fixtures.js';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../claude/hooks/notes-prompt.mjs');

let tmp: string;
let transcript: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-prompt-'));
  transcript = path.join(tmp, 's.jsonl');
  env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499' };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const stateRoot = (): string => path.join(tmp, 'state', 'notes-capture');
const memoDir = (): string => path.join(stateRoot(), 'prompt-images');
const memoPath = (): string => path.join(memoDir(), `${SESSION}.json`);
const logPath = (): string => path.join(stateRoot(), 'prompt.log');

/** Distinct fake picture bytes (the hook never decodes them). */
const pic = (label: string): string => Buffer.from(`pasted-picture-${label}`).toString('base64');
const A = pic('a');
const B = pic('b');
const C = pic('c');

function png(data: string): { media_type: string; data: string } {
  return { media_type: 'image/png', data };
}

interface Daemon {
  fetchImpl: FetchLike;
  uploads: string[];
  urls: string[];
  sources: unknown[];
}

/** A fake POST /api/chat/images: answers {id} by the uploaded bytes, 500 for `fail`, 415 for unknown bytes. */
function fakeDaemon(ids: Record<string, string>, opts: { fail?: Set<string>; onUpload?: () => void; throws?: boolean } = {}): Daemon {
  const uploads: string[] = [];
  const urls: string[] = [];
  const sources: unknown[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (opts.throws === true) throw new TypeError('fetch failed');
    const form = init.body as FormData;
    const file = form.get('file') as File;
    const data = Buffer.from(await file.arrayBuffer()).toString('base64');
    uploads.push(data);
    urls.push(url);
    sources.push(form.get('source'));
    opts.onUpload?.();
    if (opts.fail?.has(data) === true) return new Response('{"error":"boom"}', { status: 500 });
    const id = ids[data];
    if (id === undefined) return new Response('{"error":"unknown"}', { status: 415 });
    return new Response(JSON.stringify({ id }), { status: 201 });
  };
  return { fetchImpl, uploads, urls, sources };
}

/** A fake clock: `sleep` advances it, so polling loops run instantly. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = Date.now();
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function hookInput(prompt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: transcript,
    cwd: '/tmp/notes-demo',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    ...extra,
  };
}

function contextOf(out: unknown): string {
  const output = out as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  return output.hookSpecificOutput.additionalContext;
}

describe('pure helpers', () => {
  it('isNotesPromptInput takes only /n prompts', () => {
    expect(isNotesPromptInput({ prompt: '/n save that image' })).toBe(true);
    expect(isNotesPromptInput({ prompt: '/n' })).toBe(true);
    expect(isNotesPromptInput({ prompt: 'hello' })).toBe(false);
    expect(isNotesPromptInput({ prompt: '/notes' })).toBe(false);
    expect(isNotesPromptInput({ prompt: 3 })).toBe(false);
    expect(isNotesPromptInput(null)).toBe(false);
  });

  it('placeholderNumbers returns the distinct [Image #N] numbers ascending', () => {
    expect(placeholderNumbers('/n save [Image #3] and [Image #1] [Image #3]')).toEqual([1, 3]);
    expect(placeholderNumbers('/n no pictures')).toEqual([]);
  });

  it('imagesSettled looks at the last human prompt and its paste ids', () => {
    const older = imagePromptEntry('x [Image #1]', [png(A)], [1]);
    const current = imagePromptEntry('/n y [Image #2]', [png(B)], [2]);
    expect(imagesSettled(parseTranscript(jsonl([older])), [])).toBe(true);
    expect(imagesSettled(parseTranscript(jsonl([older])), [2])).toBe(false);
    expect(imagesSettled(parseTranscript(jsonl([older, assistantText('ok'), current, assistantText('…')])), [2])).toBe(true);
    expect(imagesSettled(parseTranscript(jsonl([older, plainPromptEntry('later')])), [1])).toBe(false);
  });

  it('selectForContext keeps the caps: type, 20 MB each, 48 MB base64 for uploads only, 8 overall', () => {
    const big = 'A'.repeat(26_000_000);
    const tooBig = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
    const c = (key: string, data: string, media = 'image/png', paste = 1): PromptImage => ({ key, media_type: media, data_base64: data, paste_id: paste });
    expect(selectForContext([c('u:0', A), c('u:1', A, 'image/bmp')], new Map()).map((s) => s.key)).toEqual(['u:0']);
    expect(selectForContext([c('u:0', A), c('u:1', tooBig)], new Map()).map((s) => s.key)).toEqual(['u:0']);
    expect(selectForContext([c('u:0', big), c('u:1', big)], new Map()).map((s) => s.key)).toEqual(['u:1']);
    const withMemo = selectForContext([c('u:0', big), c('u:1', big)], new Map([['u:0', 'G-AAA']]));
    expect(withMemo.map((s) => [s.key, s.id])).toEqual([
      ['u:1', null],
      ['u:0', 'G-AAA'],
    ]);
    const many = Array.from({ length: 12 }, (_, i) => c(`u:${i}`, pic(String(i)), 'image/png', i + 1));
    const picked = selectForContext(many, new Map());
    expect(picked).toHaveLength(MAX_IMAGES);
    expect(picked.map((s) => s.order)).toEqual([11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it('buildContext dedupes ids, marks the latest, or says the latest is missing', () => {
    expect(buildContext([], null)).toBeNull();
    expect(
      buildContext(
        [
          { paste_id: 1, id: 'G-0NC' },
          { paste_id: 2, id: 'G-AAA' },
          { paste_id: 3, id: 'G-0NC' },
        ],
        null,
      ),
    ).toBe(
      [
        `${CONTEXT_HEADER}[Image #2] = G-AAA; [Image #3] = G-0NC (latest).`,
        '"That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].',
        TOOLS_HINT,
      ].join('\n'),
    );
    const missing = buildContext([{ paste_id: 1, id: 'G-AAA' }], { paste_id: null });
    expect(missing).toContain('The latest pasted image could not be stored');
    expect(missing).not.toContain('(latest)');
  });
});

describe('runPrompt: not /n', () => {
  it('does no I/O at all and returns null', async () => {
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
    for (const input of [hookInput('hello'), hookInput('/notes list'), hookInput('please /n save'), hookInput(''), { prompt: 1 }, {}, null, 'text']) {
      expect(await runPrompt({ input, env, ...io })).toBeNull();
    }
    expect(reads).toBe(0);
    expect(fetches).toBe(0);
    expect(ticks).toBe(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });
});

describe('runPrompt: /n', () => {
  it('stores the image pasted with /n and names it as the latest', async () => {
    const entry = imagePromptEntry('/n make that image a new note\n[Image #1]', [png(RED_PNG_16)]);
    await writeFile(transcript, jsonl([entry]));
    const daemon = fakeDaemon({ [RED_PNG_16]: 'G-0NC' });
    const clock = fakeClock();
    const out = await runPrompt({ input: hookInput('/n make that image a new note\n[Image #1]'), env, fetchImpl: daemon.fetchImpl, ...clock });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          `${CONTEXT_HEADER}[Image #1] = G-0NC (latest).`,
          '"That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].',
          TOOLS_HINT,
        ].join('\n'),
      },
    });
    expect(daemon.urls).toEqual(['http://127.0.0.1:7499/api/chat/images']);
    expect(daemon.sources).toEqual(['claude_code']);
    expect(JSON.parse(await readFile(memoPath(), 'utf8'))).toEqual({ [`${String(entry.uuid)}:0`]: 'G-0NC' });
  });

  it('back-fills pictures from earlier non-/n turns, uploading newest first', async () => {
    await writeFile(
      transcript,
      jsonl([
        imagePromptEntry('look at these [Image #1] [Image #2]', [png(A), png(B)], [1, 2]),
        assistantText('Nice.'),
        plainPromptEntry('thanks'),
        assistantText('Any time.'),
        commandEntry('make the second image a note'),
      ]),
    );
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const out = await runPrompt({ input: hookInput('/n make the second image a note'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toEqual([B, A]);
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA; [Image #2] = G-BBB (latest).`);
  });

  it('the memo prevents a second upload of the same pictures', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2]', [png(A), png(B)])]));
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const first = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    const second = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('waits for a lagging transcript until the current prompt\'s picture is written', async () => {
    const older = imagePromptEntry('look [Image #1]', [png(A)], [1]);
    const current = imagePromptEntry('/n save this [Image #2]', [png(B)], [2]);
    const texts = [jsonl([older, assistantText('ok')]), jsonl([older, assistantText('ok')]), jsonl([older, assistantText('ok'), current])];
    let reads = 0;
    const readText = async (): Promise<string> => texts[Math.min(reads++, texts.length - 1)]!;
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const out = await runPrompt({ input: hookInput('/n save this [Image #2]'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(reads).toBe(3);
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA; [Image #2] = G-BBB (latest).`);
  });

  it('never calls an older picture the latest when the current one never shows up', async () => {
    const older = imagePromptEntry('look [Image #1]', [png(A)], [1]);
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      return jsonl([older, assistantText('ok')]);
    };
    const daemon = fakeDaemon({ [A]: 'G-AAA' });
    const out = await runPrompt({ input: hookInput('/n save this [Image #2]'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(reads).toBe(TRANSCRIPT_WAIT_MS / TRANSCRIPT_POLL_MS + 1);
    const context = contextOf(out);
    expect(context.split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA.`);
    expect(context).toContain('The latest pasted image ([Image #2]) could not be stored');
    expect(context).not.toContain('(latest)');
    expect(await readFile(logPath(), 'utf8')).toContain('[Image #2] not in the transcript');
  });

  it('says the latest could not be stored when its upload fails, and marks no older one', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2]', [png(A), png(B)])]));
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' }, { fail: new Set([B]) });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    const context = contextOf(out);
    expect(context.split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA.`);
    expect(context).toContain('([Image #2]) could not be stored');
    expect(context).not.toContain('(latest)');
    expect(await readFile(logPath(), 'utf8')).toContain('image #2: Error: upload failed: HTTP 500');
    const memo = JSON.parse(await readFile(memoPath(), 'utf8')) as Record<string, string>;
    expect(Object.values(memo)).toEqual(['G-AAA']);
  });

  it('a newest picture outside the caps (bmp) is reported missing, not skipped silently', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2]', [png(A), { media_type: 'image/bmp', data: B }])]));
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toEqual([A]);
    expect(contextOf(out)).toContain('([Image #2]) could not be stored');
  });

  it('names at most 8 pictures, the newest, across turns', async () => {
    const data = Array.from({ length: 10 }, (_, i) => pic(`n${i}`));
    const ids = Object.fromEntries(data.map((d, i) => [d, `G-00${i}`]));
    await writeFile(
      transcript,
      jsonl([
        imagePromptEntry('first five', data.slice(0, 5).map(png), [1, 2, 3, 4, 5]),
        assistantText('ok'),
        imagePromptEntry('five more', data.slice(5).map(png), [6, 7, 8, 9, 10]),
        assistantText('ok'),
        commandEntry('save the last one'),
      ]),
    );
    const daemon = fakeDaemon(ids);
    const out = await runPrompt({ input: hookInput('/n save the last one'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toEqual(data.slice(2).reverse());
    expect(contextOf(out).split('\n')[0]).toBe(
      `${CONTEXT_HEADER}${[3, 4, 5, 6, 7, 8, 9].map((n) => `[Image #${n}] = G-00${n - 1}`).join('; ')}; [Image #10] = G-009 (latest).`,
    );
  });

  it('the same bytes pasted twice are named once, by their newest paste', async () => {
    await writeFile(
      transcript,
      jsonl([imagePromptEntry('a [Image #1] [Image #2]', [png(RED_PNG_16), png(A)], [1, 2]), assistantText('ok'), imagePromptEntry('/n again [Image #3]', [png(RED_PNG_16)], [3])]),
    );
    const daemon = fakeDaemon({ [RED_PNG_16]: 'G-0NC', [A]: 'G-AAA' });
    const out = await runPrompt({ input: hookInput('/n again [Image #3]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #2] = G-AAA; [Image #3] = G-0NC (latest).`);
  });

  it('stops uploading when the time budget is spent, newest stored first', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2] [Image #3]', [png(A), png(B), png(C)])]));
    const clock = fakeClock();
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB', [C]: 'G-CCC' }, { onUpload: () => clock.advance(5000) });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2] [Image #3]'), env, fetchImpl: daemon.fetchImpl, ...clock });
    expect(daemon.uploads).toEqual([C, B]);
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #2] = G-BBB; [Image #3] = G-CCC (latest).`);
    expect(await readFile(logPath(), 'utf8')).toContain('upload budget spent; 1 pasted image(s) not stored');
  });

  it('returns null when nothing could be stored (daemon down) or there are no pictures', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1]', [png(A)])]));
    const down = fakeDaemon({}, { throws: true });
    expect(await runPrompt({ input: hookInput('/n save [Image #1]'), env, fetchImpl: down.fetchImpl, ...fakeClock() })).toBeNull();
    expect(await readFile(logPath(), 'utf8')).toContain('image #1: TypeError: fetch failed');
    await writeFile(transcript, jsonl([commandEntry('list my notes')]));
    const daemon = fakeDaemon({});
    expect(await runPrompt({ input: hookInput('/n list my notes'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() })).toBeNull();
    expect(daemon.uploads).toEqual([]);
  });

  it('returns null and logs when the transcript is missing or unreadable', async () => {
    const daemon = fakeDaemon({});
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      throw new Error('ENOENT');
    };
    expect(await runPrompt({ input: hookInput('/n save it'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() })).toBeNull();
    expect(reads).toBe(TRANSCRIPT_WAIT_MS / TRANSCRIPT_POLL_MS + 1);
    expect(await runPrompt({ input: hookInput('/n save it', { transcript_path: undefined }), env, fetchImpl: daemon.fetchImpl, ...fakeClock() })).toBeNull();
    const log = await readFile(logPath(), 'utf8');
    expect(log).toContain('transcript unreadable');
    expect(log).toContain('no transcript_path');
  });

  it('prunes memo files older than 14 days and keeps fresh ones', async () => {
    await mkdir(memoDir(), { recursive: true });
    const old = path.join(memoDir(), 'old-session.json');
    const fresh = path.join(memoDir(), 'fresh-session.json');
    await writeFile(old, '{}');
    await writeFile(fresh, '{}');
    const past = new Date(Date.now() - MEMO_MAX_AGE_MS - 60_000);
    await utimes(old, past, past);
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1]', [png(A)])]));
    await runPrompt({ input: hookInput('/n save [Image #1]'), env, fetchImpl: fakeDaemon({ [A]: 'G-AAA' }).fetchImpl, ...fakeClock() });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(memoPath())).toBe(true);
  });

  it('an unsafe session id still answers but keeps no memo', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1]', [png(A)])]));
    const out = await runPrompt({
      input: hookInput('/n save [Image #1]', { session_id: '../escape' }),
      env,
      fetchImpl: fakeDaemon({ [A]: 'G-AAA' }).fetchImpl,
      ...fakeClock(),
    });
    expect(contextOf(out)).toContain('[Image #1] = G-AAA (latest)');
    expect(existsSync(memoDir())).toBe(false);
  });
});

describe('notes-prompt.mjs as a process', () => {
  function runHook(stdin: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  it('prints nothing and touches no state for a prompt that is not /n', async () => {
    const run = await runHook(JSON.stringify(hookInput('what is the weather')));
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('prints exactly one JSON line with the context on /n', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save that [Image #1]', [png(RED_PNG_16)])]));
    let hits = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits += 1;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'G-0NC', created: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const run = await runHook(JSON.stringify(hookInput('/n save that [Image #1]')), { NOTESD_PORT: String(port) });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      const lines = run.stdout.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[Image #1] = G-0NC (latest)');
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('exits 0 with empty stdout when the daemon is down, and logs', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save that [Image #1]', [png(RED_PNG_16)])]));
    const run = await runHook(JSON.stringify(hookInput('/n save that [Image #1]')), { NOTESD_PORT: '1' });
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await readFile(logPath(), 'utf8')).toContain('image #1:');
  });

  it('exits 0 with empty stdout on garbage stdin', async () => {
    const run = await runHook('{ not json');
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((await readdir(stateRoot())).includes('prompt.log')).toBe(true);
  });
});
```
Notes for the implementer:
- `fixtures.ts` needs no change: `imagePromptEntry`, `commandEntry`, `plainPromptEntry`, `assistantText`, `jsonl`, `RED_PNG_16`, `SESSION` cover every case.
- The spawned-process tests rely on the hook file being directly runnable by `node` (no chmod needed for `node file.mjs`) and on `isMainModule` matching the realpath.

### Step 12: `claudeHooks.test.ts` updates
**File:** `tests/unit/scripts/claudeHooks.test.ts`

12a. Line 8 import:
```ts
import { hookCommand, mergeHooks, ourGroups, removeHooks, shQuote } from '../../../scripts/claude-hooks.mjs';
```

12b. Test `'adds our two groups and keeps everything else'` (lines 58-71) replaced by:
```ts
  it('adds our three groups and keeps everything else', () => {
    const merged = mergeHooks(EXISTING, opts) as typeof EXISTING & { hooks: { UserPromptSubmit: unknown[] } };
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
    expect(merged.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: "'/opt/node/bin/node' '/home/u/mcp-notes/claude/hooks/notes-prompt.mjs'", timeout: 20 }] },
    ]);
    expect(Object.keys(ourGroups(opts))).toEqual(['Stop', 'PreToolUse', 'UserPromptSubmit']);
  });

  it('keeps a user UserPromptSubmit hook and upgrades a two-hook install in place', () => {
    const userHook = { hooks: [{ type: 'command', command: '/home/u/prompt-guard.sh' }] };
    const twoHookInstall = {
      ...EXISTING,
      hooks: {
        Stop: [...EXISTING.hooks.Stop, { hooks: [{ type: 'command', command: "'/old/node' '/old/claude/hooks/notes-capture.mjs'", async: true, timeout: 60 }] }],
        PreToolUse: [
          ...EXISTING.hooks.PreToolUse,
          { matcher: 'mcp__notes__similar_images', hooks: [{ type: 'command', command: "'/old/node' '/old/claude/hooks/notes-paste.mjs'", timeout: 30 }] },
        ],
        UserPromptSubmit: [userHook],
      },
    };
    const merged = mergeHooks(twoHookInstall, opts) as { hooks: Record<string, unknown[]> };
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.UserPromptSubmit).toHaveLength(2);
    expect(merged.hooks.UserPromptSubmit![0]).toEqual(userHook);
    expect(JSON.stringify(merged)).not.toContain('/old/');
    expect(mergeHooks(merged, opts)).toEqual(merged);
    const removed = removeHooks(merged) as { hooks: Record<string, unknown[]> };
    expect(removed.hooks.UserPromptSubmit).toEqual([userHook]);
    expect(removed.hooks.Stop).toEqual(EXISTING.hooks.Stop);
  });
```

12c. Test `'creates the file (0600) when there is none, without a backup'` line 106:
```ts
    expect(Object.keys(value.hooks)).toEqual(['Stop', 'PreToolUse', 'UserPromptSubmit']);
```

12d. Test `'status reports both hooks'` (lines 133-138) replaced by:
```ts
  it('status reports all three hooks', async () => {
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const out = cli('status', '--settings', settings);
    expect(out).toMatch(/Stop notes-capture: .*notes-capture\.mjs/);
    expect(out).toMatch(/PreToolUse notes-paste: .*notes-paste\.mjs/);
    expect(out).toMatch(/UserPromptSubmit notes-prompt: .*notes-prompt\.mjs/);
    cli('uninstall', '--settings', settings);
    expect(cli('status', '--settings', settings)).toMatch(/UserPromptSubmit notes-prompt: not registered/);
  });
```

12e. In `'register_hooks merges into ~/.claude/settings.json, twice = identical, uninstall restores'`, after line 146 add:
```ts
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-prompt.mjs'));
```

The existing tests `'is idempotent and replaces an entry left by another checkout'`, `'works without a hooks key and removeHooks restores the original exactly'` (`removeHooks(mergeHooks(EXISTING))` drops the then-empty `UserPromptSubmit` key, so it still equals `EXISTING`), `'the deny strategy…'` and the byte-identical second-run test pass unchanged.

## Verification

**Build:** `npm run typecheck`
**Tests:**
```
npx vitest run tests/unit/hooks/notesPrompt.test.ts tests/unit/hooks/transcript.test.ts tests/unit/scripts/claudeHooks.test.ts
npx vitest run tests/unit/hooks
npm test
```
**Shell syntax:** `bash -n scripts/install.sh && bash -n scripts/uninstall.sh`
**Manual check:**
- `ls -l claude/hooks/notes-prompt.mjs` shows `-rwxr-xr-x`.
- `printf '{"prompt":"hello"}' | node claude/hooks/notes-prompt.mjs; echo "exit=$?"` prints only `exit=0`, and no `prompt.log` appears.
- In a temp HOME: `node scripts/claude-hooks.mjs install --settings /tmp/x/settings.json --node "$(command -v node)" --hooks-dir "$PWD/claude/hooks" && node scripts/claude-hooks.mjs status --settings /tmp/x/settings.json` lists three hooks; `uninstall` removes them.
- Live end-to-end (Claude Code really honouring `additionalContext` at `UserPromptSubmit`) is phase 4's `verify:prompt-hook`; not required to close this phase.

**Exit criteria (from the index):** the hook returns the C2 context for `/n` prompts with images in any session turn, nothing otherwise; uploads newest-first within a time budget; the memo prevents re-upload; a failure that leaves no image stored (no transcript, daemon down, every upload failed, exception) returns null and logs, and a newest image that could not be stored while older ones were is reported in the context, never replaced by an older one as "latest"; the installer registers exactly three groups idempotently and uninstall removes them; `npm run typecheck` and `npm test` green.

## Handoffs

- **Phase 4 (R2, R4, R6):** integration test `tests/integration/prompt.hook.int.test.ts` should drive `runPrompt` (import from `claude/hooks/notes-prompt.mjs`) against the real daemon with `env.NOTESD_PORT` set to the test server's port, then run `runCapture` for the same transcript and assert the same chat image ids and no extra `chat_images` rows; the memo lives under `env.XDG_STATE_HOME`. `scripts/verify-prompt-hook.mjs` checks that Claude Code passes `prompt`/`transcript_path` and that the transcript holds the current prompt's image within `TRANSCRIPT_WAIT_MS`. Docs must name: the third hook and its 20 s timeout, the `/n`-only scope with back-fill of earlier turns (privacy), `prompt-images/` memos (14-day prune) and `prompt.log` in the state dir, and that `uninstall.sh` removes three hooks.
- **Phase 2 (R1, R3):** the wall prompt and MCP instructions may quote the C2 header "Pasted images in this Claude Code session" when describing the Claude Code path; the wording is fixed by `CONTEXT_HEADER` / `TOOLS_HINT` here.
- **Not done, recorded:** extracting `uploadImage` and the cap constants into a shared `lib/` module (they stay imported from `notes-paste.mjs` / `notes-capture.mjs` per the index's Decisions). A stale memo after a daemon database reset (memo id no longer in `chat_images`) is not detected; the 14-day prune bounds it and phase 1's error text ("no pasted image X") makes it visible. Both are follow-ups, not this phase.

## Risks

- **Paste-id numbering:** settling relies on `imagePasteIds` being a per-session counter (verified on this machine's transcripts). If a future Claude Code restarts numbering per prompt, an earlier prompt with the same N could settle the wait early and the previous picture would be named latest; phase 4's live verify script should assert the counter.
- **`input.prompt` shape:** assumed to be the typed text (`/n …`) or the command XML; `isNotesPromptText` accepts both. If Claude Code sends something else, the hook stays silent (safe failure).
- **Process-level timeout:** a single `uploadImage` cannot exceed the remaining budget (min 1 s) thanks to the combined abort signal; worst case ≈ 11.5 s < 20 s timeout.

## Rollback

`git revert` this phase's commit: removes `notes-prompt.mjs(.d.mts)`, the two transcript helpers, the third group and the skill wording. On a machine where it was installed, re-run `scripts/install.sh` from the reverted checkout (the narrower `OUR_SCRIPT` no longer recognises the `notes-prompt` entry, so remove it first with the current `scripts/uninstall.sh`, or delete the `UserPromptSubmit` notes-prompt entry from `~/.claude/settings.json` by hand). `~/.local/state/notes-capture/prompt-images/` and `prompt.log` can be deleted; chat images already stored stay (sha-deduped, harmless).
