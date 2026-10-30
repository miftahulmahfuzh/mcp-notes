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
