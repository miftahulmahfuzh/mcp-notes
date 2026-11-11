#!/usr/bin/env node
/**
 * notes-link: Claude Code PostToolUse hook for the mcp-notes write tools (the session graph).
 *
 * After `create`, `create_image`, `update`, `append` or `attach_image` succeeds, it links the note
 * to this session's node (POST /api/sessions/hook/link-note {session, note}), so every note written
 * in a Claude Code session shows up under that node on the Projects page without anyone asking for
 * `link_note`. The note id comes from `tool_input.id` (update / append / attach_image) or from the
 * tool's JSON result, `note.id` (create / create_image). Linking twice is harmless, and the link
 * never changes the note itself.
 *
 * Skipped: other tools, failed calls, non-`cli` sessions, inputs without a session id or note id.
 * It never decides anything: it prints nothing and always exits 0. Problems go to
 * ${XDG_STATE_HOME:-~/.local/state}/notes-capture/link.log. Node >= 22 built-ins only.
 */
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';
import { isCliSession, sessionIdOf } from './notes-session.mjs';

/** The tool whose input carries the note id ('id'), or whose result does ('result'). */
export const TOOL_NOTE_ID = {
  mcp__notes__create: 'result',
  mcp__notes__create_image: 'result',
  mcp__notes__update: 'id',
  mcp__notes__append: 'id',
  mcp__notes__attach_image: 'id',
};
export const LINK_PATH = '/api/sessions/hook/link-note';
export const POST_TIMEOUT_MS = 3000;
export const LOG_FILE = 'link.log';

const NOTE_ID = /^[0-9A-Za-z]-?[0-9A-Za-z]{3}$/;

function asNoteId(value) {
  return typeof value === 'string' && NOTE_ID.test(value.trim()) ? value.trim() : null;
}

/** The text blocks of an MCP tool result as Claude Code hands it over: blocks, {content}, or a string. */
function resultTexts(response) {
  if (typeof response === 'string') return [response];
  const blocks = Array.isArray(response)
    ? response
    : response !== null && typeof response === 'object' && Array.isArray(response.content)
      ? response.content
      : [];
  return blocks.filter((b) => b !== null && typeof b === 'object' && typeof b.text === 'string').map((b) => b.text);
}

/** The JSON objects in a tool result. A failed call answers in plain text (or isError), so it has none. */
export function resultObjects(response) {
  if (response !== null && typeof response === 'object' && !Array.isArray(response) && response.isError === true) return [];
  const objects = [];
  for (const text of resultTexts(response)) {
    try {
      const value = JSON.parse(text);
      if (value !== null && typeof value === 'object') objects.push(value);
    } catch {
      // a refusal or error message, not a result
    }
  }
  return objects;
}

/** The note id one PostToolUse input wrote, or null when the call is not ours or did not succeed. */
export function noteIdOf(input) {
  if (input === null || typeof input !== 'object' || !Object.hasOwn(TOOL_NOTE_ID, input.tool_name)) return null;
  const objects = resultObjects(input.tool_response);
  if (objects.length === 0) return null;
  if (TOOL_NOTE_ID[input.tool_name] === 'id') {
    return input.tool_input !== null && typeof input.tool_input === 'object' ? asNoteId(input.tool_input.id) : null;
  }
  for (const value of objects) {
    const id = value.note !== null && typeof value.note === 'object' ? asNoteId(value.note.id) : null;
    if (id !== null) return id;
  }
  return null;
}

/** Links the note one PostToolUse input wrote to this session. Always resolves to null (no hook output). */
export async function runLink({ input, env, fetchImpl = globalThis.fetch }) {
  const note = noteIdOf(input);
  if (note === null || !isCliSession(env)) return null;
  const session = sessionIdOf(input);
  if (session === null) return null;
  const log = (message) => writeLog(stateDir(env), LOG_FILE, message);
  try {
    const res = await fetchImpl(`${daemonBaseUrl(env)}${LINK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify({ session, note }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await log(`link ${note} to ${session}: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
  }
  return null;
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    await runLink({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
