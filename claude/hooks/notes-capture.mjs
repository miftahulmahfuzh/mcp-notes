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
    images: selectImages(Array.isArray(turn.images) ? turn.images : extractImages(prompt)),
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
