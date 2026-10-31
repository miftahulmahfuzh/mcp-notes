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
 * True when a raw prompt string is a `/n` prompt: `/n` then whitespace or the end, after leading
 * whitespace. Accepts the typed form (`/n save this`) and the command XML Claude Code writes for a
 * typed slash command. Pure: the UserPromptSubmit hook calls it before any I/O.
 */
export function isNotesPromptText(text) {
  if (typeof text !== 'string') return false;
  return NOTES_PROMPT.test(typedFromCommandXml(text).trimStart());
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

/** "[Image #n]": the image whose paste id is n, else the n-th image in block order, else null. */
export function pickPastedImage(images, n) {
  if (!Number.isInteger(n) || n < 1) return null;
  const byPasteId = images.find((image) => image.paste_id === n);
  if (byPasteId !== undefined) return byPasteId;
  return images[n - 1] ?? null;
}
