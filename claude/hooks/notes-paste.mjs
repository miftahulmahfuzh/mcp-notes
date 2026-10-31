#!/usr/bin/env node
/**
 * notes-paste: Claude Code PreToolUse hook for `similar_images`, `create_image` and `attach_image` (mcp-notes).
 *
 * A pasted image in Claude Code has no file path, so `/n` asks the model to call
 * similar_images({pasted_image: N}) for "[Image #N]". This hook finds the latest human prompt in
 * the transcript that carries images, takes image N (by imagePasteIds, else block order),
 * uploads it to notesd (POST /api/chat/images, source claude_code) and hands the call on with
 * `upload_id` instead of `pasted_image`. For create_image / attach_image the call is handed on with
 * `image_id` (the chat image id) instead: this is how an image pasted in the very `/n` prompt is
 * saved, since the UserPromptSubmit hook cannot see that image in the transcript yet (Claude Code
 * writes the prompt there only after the hooks finish) but a tool call can.
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
import { findLatestPromptImages, parseTranscript, pickPastedImage } from './lib/transcript.mjs';

export const TOOL_NAME = 'mcp__notes__similar_images';
/** Every tool the hook rewrites, and the argument its `pasted_image` becomes. */
export const TOOL_KEYS = {
  mcp__notes__similar_images: 'upload_id',
  mcp__notes__create_image: 'image_id',
  mcp__notes__attach_image: 'image_id',
};
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

function withoutPasted(toolInput, uploadId, key = 'upload_id') {
  const next = {};
  for (const [name, value] of Object.entries(toolInput)) {
    if (name !== 'pasted_image') next[name] = value;
  }
  next[key] = uploadId;
  return next;
}

export function rewriteOutput(toolInput, uploadId, key = 'upload_id') {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: withoutPasted(toolInput, uploadId, key),
    },
  };
}

export function denyOutput(toolInput, uploadId, toolName = TOOL_NAME, key = 'upload_id') {
  const args = JSON.stringify(withoutPasted(toolInput, uploadId, key));
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `The pasted image was uploaded as ${key} ${uploadId}. Call ${toolName} again with exactly ` +
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
    const latest = findLatestPromptImages(parseTranscript(text));
    if (latest !== null) return pickPastedImage(latest.images, n);
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
    if (input === null || typeof input !== 'object' || !Object.hasOwn(TOOL_KEYS, input.tool_name)) return null;
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
    const key = TOOL_KEYS[input.tool_name];
    return strategyFrom(env) === 'deny'
      ? denyOutput(toolInput, uploadId, input.tool_name, key)
      : rewriteOutput(toolInput, uploadId, key);
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
