import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { NoteFilter } from '../notes/repo.js';
import type { NotesService } from '../notes/service.js';
import { NoteError } from '../notes/types.js';

export interface ToolDeps {
  service: NotesService;
  dataDir: string;
  /** Read-only use by phase 5's image tools (raw image records); writes still go through `service`. */
  db: Db;
}

export const MCP_MAX_LIMIT = 200;
export const MCP_DEFAULT_LIMIT = 50;

const idField = z
  .string()
  .min(1)
  .describe('Note id like A-B32. Case-insensitive; the dash may be omitted ("ab32" works).');

const originField = z
  .object({
    cwd: z.string().optional().describe('Absolute working directory of the Claude Code session.'),
    repo: z.string().optional().describe('Repository name or remote, e.g. "seer" or "github.com/me/seer".'),
    claude_session: z.string().optional().describe('Claude Code session id, if known.'),
  })
  .optional()
  .describe('Where this note is being saved from. Pass it whenever you save from inside a repository.');

/**
 * Filter fields shared by list and search. Phase 5 adds has_image, taken_from and taken_to here
 * and maps them in `toFilter`.
 */
export const noteFilterShape = {
  tags_any: z
    .array(z.string())
    .optional()
    .describe('Notes that carry at least one of these tags. "seer" and "#seer" are the same.'),
  tags_all: z.array(z.string()).optional().describe('Notes that carry every one of these tags.'),
  date_field: z
    .enum(['created', 'updated'])
    .optional()
    .describe('Which date from/to filter on, and (for list) the sort order. Default "created".'),
  from: z
    .string()
    .optional()
    .describe('Inclusive start: YYYY-MM-DD (start of that local day) or an ISO 8601 datetime.'),
  to: z
    .string()
    .optional()
    .describe('Inclusive end: YYYY-MM-DD (the whole local day is included) or an ISO 8601 datetime.'),
  deleted: z
    .enum(['exclude', 'include', 'only'])
    .optional()
    .describe('Soft-deleted notes: "exclude" (default), "include", or "only" (to find something to restore).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(`Page size, 1-${MCP_MAX_LIMIT}. Default ${MCP_DEFAULT_LIMIT}.`),
  cursor: z
    .string()
    .optional()
    .describe('next_cursor from the previous page, unchanged. Omit for the first page.'),
};

export interface FilterArgs {
  tags_any?: string[] | undefined;
  tags_all?: string[] | undefined;
  date_field?: 'created' | 'updated' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  deleted?: 'exclude' | 'include' | 'only' | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** Maps MCP snake_case filter args to the repo filter. */
export function toFilter(args: FilterArgs): NoteFilter {
  const filter: NoteFilter = { limit: args.limit ?? MCP_DEFAULT_LIMIT };
  if (args.tags_any !== undefined) filter.tagsAny = args.tags_any;
  if (args.tags_all !== undefined) filter.tagsAll = args.tags_all;
  if (args.date_field !== undefined) filter.dateField = args.date_field;
  if (args.from !== undefined) filter.from = args.from;
  if (args.to !== undefined) filter.to = args.to;
  if (args.deleted !== undefined) filter.deleted = args.deleted;
  if (args.cursor !== undefined) filter.cursor = args.cursor;
  return filter;
}

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const text = err instanceof NoteError ? `${err.code}: ${err.message}` : `error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Runs a handler and turns any thrown error into an MCP error result Claude can read. */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

export function registerNoteTools(server: McpServer, deps: ToolDeps): void {
  const { service } = deps;

  server.registerTool(
    'create',
    {
      title: 'Create note',
      description:
        'Save a new note. The body is plain text; put #hashtags in it to tag the note (tags are parsed from the body). Returns the created note with its new id (like A-B32) - quote that id to the user. Pass origin when saving from inside a repository.',
      inputSchema: {
        body: z.string().min(1).describe('The full note text, including any #hashtags. Must not be empty.'),
        origin: originField,
      },
    },
    async ({ body, origin }) =>
      run(async () => ({ note: await service.create({ body, origin: { ...origin, source: 'mcp' } }) })),
  );

  server.registerTool(
    'get',
    {
      title: 'Get notes',
      description:
        'Fetch one or several notes by id. Returns { notes, missing, deleted }: missing lists inputs that are not ids or match no note; deleted lists ids of soft-deleted notes (pass include_deleted=true to see their bodies, or restore them).',
      inputSchema: {
        ids: z.array(idField).min(1).max(100).describe('One or more note ids, e.g. ["A-B32"] or ["ab32", "7-QX0"].'),
        include_deleted: z.boolean().optional().describe('Also return soft-deleted notes (they carry deleted_at). Default false.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, include_deleted }) => run(() => service.get(ids, { includeDeleted: include_deleted ?? false })),
  );

  server.registerTool(
    'update',
    {
      title: 'Replace note body',
      description:
        'Replace the whole body of a note with new text. Read the note with get first and send the complete new text: anything you leave out is removed. Tags are re-parsed from the new body, so keep the #hashtags you want (add one to tag the note). The previous body is kept as a revision. Fails on a deleted note.',
      inputSchema: {
        id: idField,
        body: z.string().min(1).describe('The complete new note text. Must not be empty; use delete to remove a note.'),
        origin: originField,
      },
      annotations: { idempotentHint: true },
    },
    async ({ id, body, origin }) =>
      run(async () => ({
        note: await service.update(id, body, origin === undefined ? {} : { origin: { ...origin, source: 'mcp' } }),
      })),
  );

  server.registerTool(
    'append',
    {
      title: 'Append to note',
      description:
        'Add text to the end of a note, after a blank line, leaving the existing text untouched. Hashtags in the appended text become tags. The previous body is kept as a revision. Fails on a deleted note.',
      inputSchema: {
        id: idField,
        text: z.string().min(1).describe('Text to add at the end.'),
      },
    },
    async ({ id, text }) => run(async () => ({ note: await service.append(id, text) })),
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete note',
      description:
        'Soft-delete a note: it disappears from list, search and tags, but its text is kept and restore brings it back. Deleting an already deleted note changes nothing.',
      inputSchema: { id: idField },
      annotations: { idempotentHint: true },
    },
    async ({ id }) => run(async () => ({ note: await service.delete(id) })),
  );

  server.registerTool(
    'restore',
    {
      title: 'Restore note',
      description:
        'Undo a delete. Use list with deleted="only" to find deleted notes. Restoring a note that is not deleted changes nothing.',
      inputSchema: { id: idField },
      annotations: { idempotentHint: true },
    },
    async ({ id }) => run(async () => ({ note: await service.restore(id) })),
  );

  server.registerTool(
    'list',
    {
      title: 'List notes',
      description:
        'List notes newest first, optionally filtered by tags and a date range. Use it for "my notes on #seer this week", "my last note about #v250" (tags_any=["v250"], limit=1) or one side of a comparison (call it once per side, then compare yourself). Returns { notes, next_cursor }; when next_cursor is not null there are more notes - pass it back as cursor to get the next page.',
      inputSchema: noteFilterShape,
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => service.list(toFilter(args))),
  );

  server.registerTool(
    'search',
    {
      title: 'Search notes',
      description:
        'Full-text search over note bodies, with the same tag and date filters as list. Words match exactly (no stemming), so code identifiers and version strings work; supports "quoted phrases", OR, and -word to exclude. Results are ranked by relevance, then recency. Returns { notes, next_cursor }.',
      inputSchema: {
        query: z.string().min(1).describe('Words to look for, e.g. "retry backoff" or "\\"connection pool\\" -redis".'),
        ...noteFilterShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, ...filter }) => run(() => service.search(query, toFilter(filter))),
  );

  server.registerTool(
    'tags',
    {
      title: 'List tags',
      description:
        'Every tag used by a live note, most used first, with its note count and last_used (the newest updated_at among its notes). Use it to discover what the user tags things with before filtering.',
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => ({ tags: await service.tags() })),
  );

  server.registerTool(
    'revisions',
    {
      title: 'List revisions',
      description:
        'Earlier bodies of a note, newest first. Each has a revision number, the body as it was, and saved_at (when it was replaced). Pass a revision number to revert to restore that text.',
      inputSchema: { id: idField },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => run(async () => ({ revisions: await service.revisions(id) })),
  );

  server.registerTool(
    'revert',
    {
      title: 'Revert to revision',
      description:
        'Make a note\'s body equal to one of its earlier revisions (numbers come from revisions). The body being replaced is kept as a new revision, so a revert can itself be undone.',
      inputSchema: {
        id: idField,
        revision: z.number().int().positive().describe('Revision number from revisions(id).'),
      },
    },
    async ({ id, revision }) => run(async () => ({ note: await service.revert(id, revision) })),
  );
}
