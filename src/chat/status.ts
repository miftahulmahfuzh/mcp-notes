import {
  ALL_CONNECTOR_TOOL_NAMES,
  CONNECTOR_SYSTEMS,
  CONNECTOR_TOOL_NAMES,
  SYSTEM_META,
  type SystemId,
} from '../connectors/names.js';

/**
 * The chat agent's tool surface and the terse captions the answer panel shows while a tool runs.
 * Notes tool names match src/mcp/tools.ts and src/mcp/imageTools.ts; session tool names match
 * src/mcp/sessionTools.ts; connector tool names come from src/connectors/names.ts. Claude Code
 * exposes all of them as `mcp__notes__<name>` because the daemon registers its one MCP server
 * under the name `notes`.
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
  'related',
  'revisions',
  'revert',
  'create_image',
  'view_images',
  'attach_image',
  'remove_image',
  'restore_image',
  'move_image',
  'similar_images',
] as const;

export type NotesToolName = (typeof NOTES_TOOL_NAMES)[number];

/** Read-only Claude Code session tools (PROJECT_SESSION_GRAPH_PLAN phase 7; phase 9 appends session_resume). */
export const SESSION_TOOL_NAMES = [
  'sessions_search',
  'session_get',
  'session_transcript',
  'sessions_usage',
  'session_resume',
] as const;

export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

/** Read-only Seer Adversarial tools (SEER_ADVERSARIAL_PLAN phase 5): src/mcp/adversaryTools.ts registers them under these names. */
export const ADVERSARY_TOOL_NAMES = ['adversary_overview', 'adversary_verdicts', 'adversary_scorecard'] as const;

export type AdversaryToolName = (typeof ADVERSARY_TOOL_NAMES)[number];

/**
 * The movie library tools (MOVIES_LIBRARY_PLAN phase 7): src/mcp/movieTools.ts registers them under
 * these names, in this order. movies_continue and movies_mark write (VLC opens; marks are stored);
 * the other four only read.
 */
export const MOVIE_TOOL_NAMES = [
  'movies_list',
  'movies_get',
  'movies_history',
  'movies_continue',
  'movies_person',
  'movies_mark',
] as const;

export type MovieToolName = (typeof MOVIE_TOOL_NAMES)[number];

/**
 * The four curated dword (daily-words) tools (DWORD_CONNECTOR_PLAN phases 3/4: src/mcp/dwordVocabTools.ts,
 * src/mcp/dwordJournalTools.ts). Named here only so `captionForToolUse` can give each one its own caption
 * and so this file's tests can assert on them by name. Unlike ADVERSARY_TOOL_NAMES/SESSION_TOOL_NAMES,
 * this array is deliberately NOT spread into `allowedChatTools()`'s return value: dword is a
 * `CONNECTOR_SYSTEMS` member (DWORD_CONNECTOR_PLAN phase 1), so all six of its tool names (these four
 * plus the generic `dword_schema`/`dword_sql`) already reach `allowedChatTools()` through
 * `ALL_CONNECTOR_TOOL_NAMES` below. Spreading this array too would list the same four names twice and
 * fail the no-duplicates assertion in tests/unit/chat-status.test.ts.
 */
export const DWORD_TOOL_NAMES = [
  'dword_vocab_lookup',
  'dword_vocab_add',
  'dword_journal_find_similar',
  'dword_journal_add',
] as const;

export type DwordToolName = (typeof DWORD_TOOL_NAMES)[number];

export const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;

/** Status-line caption for every tool of one read-only system ('reading expenses' / 'reading runs' / 'reading seer'). */
export const CONNECTOR_CAPTIONS = Object.fromEntries(
  CONNECTOR_SYSTEMS.map((id) => [id, SYSTEM_META[id].caption]),
) as Record<SystemId, string>;

const MCP_PREFIX = `mcp__${NOTES_MCP_SERVER}__`;

/**
 * Exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 6 movie tools, the 21
 * connector tools and WebSearch + WebFetch (CONNECTORS_PLAN invariant 8, which supersedes
 * CHAT_BAR_BRAIN_PLAN invariant 4; SEMANTIC_SEARCH_PLAN phase 5 adds `related`; WALL_EDITING_PLAN
 * phase 3 adds `attach_image`, `remove_image` and `restore_image`; CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN
 * phase 6 adds `similar_images`; PROJECT_SESSION_GRAPH_PLAN phase 7 adds the session tools;
 * PROJECT_SESSION_GRAPH_PLAN phase 9 adds `session_resume`; SEER_ADVERSARIAL_PLAN phase 5 adds the
 * adversary tools; MOVIES_LIBRARY_PLAN phase 7 adds the movie tools; DWORD_CONNECTOR_PLAN phases
 * 1/3/4 add dword's six tool names to `ALL_CONNECTOR_TOOL_NAMES`, 15 -> 21, with no change needed to
 * this function's body).
 */
export function allowedChatTools(): string[] {
  return [
    ...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...SESSION_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...ADVERSARY_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...MOVIE_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    // dword's six tool names (dword_schema, dword_sql, and DWORD_TOOL_NAMES above) arrive here
    // already, because CONNECTOR_SYSTEMS includes 'dword' (DWORD_CONNECTOR_PLAN phase 1).
    ...ALL_CONNECTOR_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...WEB_TOOL_NAMES,
  ];
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

/** The caption for a connector tool name (without the MCP prefix), or null if it is not one. */
function connectorCaption(tool: string): string | null {
  for (const system of CONNECTOR_SYSTEMS) {
    const names: readonly string[] = CONNECTOR_TOOL_NAMES[system];
    if (names.includes(tool)) return CONNECTOR_CAPTIONS[system];
  }
  return null;
}

/** True when a tool input carries a non-empty `image_id` string (a pasted chat image on create_image / attach_image). */
function hasImageId(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const imageId = (input as { image_id?: unknown }).image_id;
  return typeof imageId === 'string' && imageId.trim() !== '';
}

/**
 * The caption for one top-level `tool_use` block, or null for a tool the panel does not name.
 * `input` is the block's raw input; only `ids` (get, view_images) and `image_id` (create_image,
 * attach_image: a pasted chat image rather than a file path) are read.
 */
export function captionForToolUse(name: string, input: unknown): string | null {
  if (name === 'WebSearch') return 'searching the web';
  if (name === 'WebFetch') return 'reading a web page';
  if (!name.startsWith(MCP_PREFIX)) return null;
  const tool = name.slice(MCP_PREFIX.length);
  switch (tool) {
    case 'search':
    case 'list':
    case 'tags':
      return 'searching notes';
    case 'related':
      return 'finding related notes';
    case 'similar_images':
      return 'finding similar photos';
    case 'get':
      return counted(idCount(input), 'reading a note', (n) => `reading ${n} notes`, 'reading notes');
    case 'view_images':
      return counted(idCount(input), 'looking at a photo', (n) => `looking at ${n} photos`, 'looking at photos');
    case 'revisions':
      return 'reading history';
    case 'create':
      return 'saving a note';
    case 'create_image':
      return hasImageId(input) ? 'saving the pasted photo as a note' : 'saving a note';
    case 'update':
    case 'append':
    case 'revert':
      return 'editing a note';
    case 'delete':
      return 'deleting a note';
    case 'restore':
      return 'restoring a note';
    case 'attach_image':
      return hasImageId(input) ? 'attaching the pasted photo' : 'attaching a photo';
    case 'remove_image':
      return 'removing a photo';
    case 'restore_image':
      return 'restoring a photo';
    case 'move_image':
      return 'moving a photo to its own note';
    case 'sessions_search':
      return 'searching sessions';
    case 'session_get':
      return 'reading a session';
    case 'session_transcript':
      return 'reading a session transcript';
    case 'sessions_usage':
      return 'counting session tokens';
    case 'session_resume':
      return 'opening a session in tmux';
    case 'adversary_overview':
      return 'reading Seer Adversarial';
    case 'adversary_verdicts':
      return "reading Claude's verdicts";
    case 'adversary_scorecard':
      return "reading Claude's record";
    case 'movies_list':
      return 'searching movies';
    case 'movies_get':
      return 'reading a title';
    case 'movies_history':
      return 'reading watch history';
    case 'movies_continue':
      return 'opening VLC';
    case 'movies_person':
      return 'reading a filmography';
    case 'movies_mark':
      return 'marking a title';
    case 'dword_vocab_lookup':
      return 'looking up a word';
    case 'dword_vocab_add':
      return 'saving a word';
    case 'dword_journal_find_similar':
      return 'checking for a similar saying';
    case 'dword_journal_add':
      return 'saving a saying';
    default:
      return connectorCaption(tool);
  }
}
