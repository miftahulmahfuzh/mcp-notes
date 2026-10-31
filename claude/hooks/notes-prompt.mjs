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
 * 2. On `/n` it reads the transcript once (the current prompt is not in it yet; a picture pasted in
 *    this very prompt is handed to the notes-paste PreToolUse hook via `pasted_image N`), and gathers the pictures of EVERY human prompt of the
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
// Claude Code writes the current prompt to the transcript only after the UserPromptSubmit hooks
// finish (measured live, headless and interactive: the entry never appears while a hook blocks), so
// waiting for it cannot succeed. The wait stays a parameter, at 0: one read, no polling.
export const TRANSCRIPT_WAIT_MS = 0;
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

/** The tool-call advice for a picture pasted in the current prompt, which has no id until a tool call carries it. */
export function pastedCall(n) {
  return (
    `call create_image with pasted_image ${n} (never path or image_id) to save it as a new note, attach_image with id and ` +
    `pasted_image ${n} to add it to a note, or similar_images with pasted_image ${n} to search with it; the notes-paste hook ` +
    'uploads it when the call runs.'
  );
}

/** The context for a `/n` prompt whose pasted picture is not in the transcript yet and no earlier picture exists. */
export function buildPendingContext(n) {
  return `This prompt pastes [Image #${n}], which has no id yet. If the user means it, ${pastedCall(n)}`;
}

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
      missing.pending === true && missing.paste_id !== null
        ? `${which} has no id yet: it is the picture pasted in this very prompt. If the user means that image, ` +
            `${pastedCall(missing.paste_id)} Do not use an older image in its place.`
        : `${which} could not be stored (it was not readable in time or its upload failed), so it has no id. ` +
            'If the user means that image, tell them it could not be stored and ask them to paste it again with the request; ' +
            'do not use an older image in its place.',
    );
  }
  lines.push(TOOLS_HINT);
  return lines.join('\n');
}

function pendingOutput(n) {
  return { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: buildPendingContext(n) } };
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
      // A session's first prompt: Claude Code creates the file only after the hooks finish.
      return wanted.length === 0 ? null : pendingOutput(wanted[wanted.length - 1]);
    }
    const { entries, settled } = read;
    if (!settled) await log(`[Image #${wanted[wanted.length - 1]}] not in the transcript yet; the context points the model at pasted_image`);
    const candidates = collectImages(entries);
    if (candidates.length === 0) {
      return wanted.length === 0 ? null : pendingOutput(wanted[wanted.length - 1]);
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
