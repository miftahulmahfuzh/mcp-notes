import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ChatUploadSource } from '../embeddings/chatUploads.js';
import type { ImageEmbedder } from '../embeddings/imageEmbedder.js';
import type { NoteFilter } from '../notes/repo.js';
import type { NotesService } from '../notes/service.js';
import { NoteError } from '../notes/types.js';
import { ConnectorError, type Connectors } from '../connectors/types.js';

export interface ToolDeps {
  service: NotesService;
  dataDir: string;
  /** Read-only use by phase 5's image tools (raw image records); writes still go through `service`. */
  db: Db;
  /** Connectors for the connector tools. Omitted: defaultConnectors() (sibling repos, read per call). Tests inject their own. */
  connectors?: Connectors;
  /**
   * The wall's base URL (`http://localhost:<port>`, no trailing slash) named in the instructions'
   * Links paragraph. Omitted: `DEFAULT_WALL_URL` (port 7317), e.g. a daemon on port 0 in tests.
   */
  wallUrl?: string;
  /** Image embedder behind `similar_images`. Omitted or null: image search off (existing vectors still answer image_id). */
  imageEmbedder?: ImageEmbedder | null;
  /** Reads a wall-chat upload for `similar_images` upload_id. Omitted: upload_id answers that uploads are unavailable. */
  chatUploads?: ChatUploadSource;
}

/** Appended to the `list` and `search` descriptions. */
export const IMAGE_FILTER_HINT =
  ' Filter notes with images by has_image (true = at least one image), and by when a photo was taken with taken_from/taken_to (EXIF; a note matches when any of its images does). To look at the pictures, pass the note ids to view_images.';

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
  has_image: z
    .boolean()
    .optional()
    .describe('true: only notes with at least one image (photos, screenshots). false: only notes with no image. Omit for both.'),
  taken_from: z
    .string()
    .optional()
    .describe(
      'Earliest EXIF "taken" date: YYYY-MM-DD (start of that local day) or an ISO 8601 datetime. A note matches when any of its images was taken in range; images without a camera date never match. For the day a picture was SAVED use from/to instead.',
    ),
  taken_to: z
    .string()
    .optional()
    .describe('Latest EXIF "taken" date, inclusive: YYYY-MM-DD (the whole local day) or an ISO 8601 datetime. Same any-image rule as taken_from.'),
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
  has_image?: boolean | undefined;
  taken_from?: string | undefined;
  taken_to?: string | undefined;
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
  if (args.has_image !== undefined) filter.hasImage = args.has_image;
  if (args.taken_from !== undefined) filter.takenFrom = args.taken_from;
  if (args.taken_to !== undefined) filter.takenTo = args.taken_to;
  return filter;
}

/** compact: no indentation (connector rows are arrays; indenting them multiplies the size). */
export function jsonResult(value: unknown, compact = false): CallToolResult {
  return { content: [{ type: 'text', text: compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const text =
    err instanceof NoteError
      ? `${err.code}: ${err.message}`
      : err instanceof ConnectorError
        ? err.message
        : `error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

export interface RunOptions {
  /** Compact JSON (connector tools). Default false. */
  compact?: boolean;
}

/** Runs a handler and turns any thrown error into an MCP error result Claude can read. */
export async function run(fn: () => Promise<unknown>, options: RunOptions = {}): Promise<CallToolResult> {
  try {
    return jsonResult(await fn(), options.compact ?? false);
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
        'List notes newest first, optionally filtered by tags and a date range. Use it for "my notes on #seer this week", "my last note about #v250" (tags_any=["v250"], limit=1) or one side of a comparison (call it once per side, then compare yourself). Returns { notes, next_cursor }; when next_cursor is not null there are more notes - pass it back as cursor to get the next page.' +
        IMAGE_FILTER_HINT,
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
        'Search notes by meaning as well as by words, with the same tag and date filters as list. By default (mode "hybrid") it understands what the query means, not only its words: "ArangoDB credentials" finds a note saying "arango root password is in the vault", so pass the question in plain words. Results blend word matches, closeness in meaning, matching tags and recency; a note id, code identifier or version string that appears word for word still ranks first. mode "text" is exact-word full-text search only: no stemming; supports "quoted phrases", OR, and -word to exclude; ranked by relevance, then recency. Returns { notes, next_cursor, mode, fallback? }: mode is the ranking actually used; fallback is present when meaning search was unavailable and the results are word matches only - tell the user.' +
        IMAGE_FILTER_HINT,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'What to look for: a plain question ("have we seen auth failures after resume?") or exact terms ("retry backoff", "\\"connection pool\\" -redis").',
          ),
        mode: z
          .enum(['hybrid', 'text'])
          .optional()
          .describe('"hybrid" (default): meaning + words + tags + recency. "text": exact-word full-text search only.'),
        ...noteFilterShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, mode, ...filter }) => run(() => service.search(query, toFilter(filter), { mode })),
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
    'related',
    {
      title: 'Related notes',
      description:
        'Notes closest in meaning to one note, most similar first, each with a similarity score (1 = same meaning, near 0 = unrelated). Finds notes that share no words with it. Never includes the note itself or deleted notes. Use it for "what else do I have on this?" or "notes related to A-B32" after finding a note with get, list or search. Returns { note_id, related: [{ note, similarity }] }. Fails on a deleted note and on a photo that has no text.',
      inputSchema: {
        id: idField,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many related notes to return, 1-50. Default 10.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit }) => run(() => service.related(id, limit === undefined ? {} : { limit })),
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
