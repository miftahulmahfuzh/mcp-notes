import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT } from '../chat/service.js';
import { ChatError } from '../chat/types.js';
import type { AppDeps } from '../deps.js';
import { sameOriginOnly } from './sameOrigin.js';

/** The one ChatError -> HTTP mapping. Anything else is rethrown (Hono answers 500). */
export function chatErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof ChatError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'thread_not_found':
    case 'reply_not_found':
      return c.json({ error: err.code }, 404);
    case 'conflict':
      return c.json({ error: err.code }, 409);
    case 'invalid_id':
    case 'not_editable':
    case 'empty_text':
    case 'invalid_cursor':
      return c.json({ error: err.code }, 400);
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

const flag = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true');

const timelineQuery = z.object({
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TIMELINE_LIMIT).default(DEFAULT_TIMELINE_LIMIT),
  include_deleted: flag,
});

const editBody = z.object({ text: z.string() });

/**
 * Chat history (phase 7). Reads are open like the rest of /api; mutations are same-origin only,
 * like purge and reveal. Every timestamp is UTC ISO; the page renders WIB.
 */
export function chatHistoryRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  const chat = deps.chat;

  /** The unified timeline: `{messages (ascending), next_before}`; follow next_before for older pages. */
  api.get('/api/chat/messages', async (c) => {
    const parsed = timelineQuery.safeParse({
      before: c.req.query('before'),
      limit: c.req.query('limit'),
      include_deleted: c.req.query('include_deleted'),
    });
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    try {
      return c.json(
        await chat.listTimeline({
          before: parsed.data.before ?? null,
          limit: parsed.data.limit,
          includeDeleted: parsed.data.include_deleted,
        }),
      );
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  api.get('/api/chat/threads/:id', async (c) => {
    const include = flag.safeParse(c.req.query('include_deleted'));
    if (!include.success) return c.json({ error: describeIssues(include.error) }, 400);
    const detail = await chat.getThread(c.req.param('id'), { includeDeleted: include.data });
    if (detail === null) return c.json({ error: 'not_found' }, 404);
    return c.json(detail);
  });

  /** Edit a user message: `{text}`, non-blank. The old text is kept as a revision. */
  api.patch('/api/chat/messages/:id', sameOriginOnly, async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
    const parsed = editBody.safeParse(json.value);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    try {
      return c.json(await chat.editMessage(c.req.param('id'), parsed.data.text));
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  /** Soft delete; `?with_answer=1` on a question deletes its answer too. `{deleted: [ids]}`. */
  api.delete('/api/chat/messages/:id', sameOriginOnly, async (c) => {
    const withAnswer = flag.safeParse(c.req.query('with_answer'));
    if (!withAnswer.success) return c.json({ error: describeIssues(withAnswer.error) }, 400);
    try {
      return c.json(await chat.deleteMessage(c.req.param('id'), { withAnswer: withAnswer.data }));
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  api.post('/api/chat/messages/:id/restore', sameOriginOnly, async (c) => {
    try {
      return c.json(await chat.restoreMessage(c.req.param('id')));
    } catch (err) {
      return chatErrorResponse(c, err);
    }
  });

  return api;
}
