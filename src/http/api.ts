import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ChatBackend, ChatBrain, ChatEvent, ChatTurnImage } from '../chat/backend.js';
import {
  ChatImageLookupError,
  chatImageStoreFor,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  resolveTurnImages,
  type ChatImageLookupErrorCode,
} from '../chat/images.js';
import { createStubChatBackend } from '../chat/stub.js';
import type { AppDeps } from '../deps.js';
import type { NoteEvent } from '../notes/events.js';
import { normalizeId } from '../notes/ids.js';
import { MAX_LIMIT } from '../notes/repo.js';
import { NoteError } from '../notes/types.js';
import { sameOriginOnly } from './sameOrigin.js';

export const DEFAULT_LIST_LIMIT = 2000;
export const MAX_LIST_LIMIT = MAX_LIMIT; // 5000, P2's repo cap
export const SSE_HEARTBEAT_MS = 25_000;

export interface ApiOptions {
  /** The chat brain. Defaults to the stub; the daemon passes its configured backend. */
  chat?: ChatBackend;
  /** Defaults to SSE_HEARTBEAT_MS. Tests pass a small value. */
  sseHeartbeatMs?: number;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  cursor: z.string().min(1).optional(),
  has_image: z.enum(['true', 'false']).optional(),
});

const noteBodySchema = z.object({
  body: z.string(),
});

const chatSchema = z
  .object({
    message: z.string().trim().default(''),
    thread_id: z.string().trim().min(1).max(200).optional(),
    /** Chat image ids from POST /api/chat/images, in paste order. */
    image_ids: z.array(z.string().trim().min(1).max(16)).max(MAX_CHAT_IMAGES_PER_MESSAGE).optional(),
  })
  .refine((v) => v.message.length > 0 || (v.image_ids?.length ?? 0) > 0, {
    message: 'a message or at least one image is required',
    path: ['message'],
  });

/** ChatImageLookupError -> HTTP status, answered as JSON before any SSE. */
function chatImageErrorStatus(code: ChatImageLookupErrorCode): 400 | 409 | 422 {
  switch (code) {
    case 'unknown_image':
      return 400;
    case 'not_on_this_machine':
      return 409;
    case 'unreadable_image':
      return 422;
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

function badRequest(c: Context, error: string): Response {
  return c.json({ error }, 400);
}

function notFound(c: Context): Response {
  return c.json({ error: 'not_found' }, 404);
}

/** The one NoteError → HTTP mapping. Anything else is rethrown (Hono answers 500). */
function noteErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof NoteError)) throw err;
  switch (err.code) {
    case 'not_found':
    case 'deleted':
      return notFound(c);
    case 'conflict':
    case 'duplicate_image':
    case 'not_deleted':
      return c.json({ error: err.code }, 409);
    case 'invalid_id':
      return badRequest(c, 'invalid_id');
    default:
      return badRequest(c, `${err.code}: ${err.message}`);
  }
}

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

/** `?tag=a&tag=%23B` -> ['a', 'b']: leading '#' stripped, lower-cased, deduped, empties dropped. */
function parseTagParams(raw: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const value of raw ?? []) {
    const tag = value.trim().replace(/^#/, '').toLowerCase();
    if (tag.length > 0) seen.add(tag);
  }
  return [...seen];
}

/** The SSE event name for a chat event. One per `ChatEvent` variant; both carry `{text}`. */
function chatEventName(event: ChatEvent): 'delta' | 'status' {
  switch (event.type) {
    case 'delta':
      return 'delta';
    case 'status':
      return 'status';
  }
}

export function apiRoutes(deps: AppDeps, options: ApiOptions = {}): Hono {
  const api = new Hono();
  const service = deps.service;
  const chat = options.chat ?? createStubChatBackend();
  const heartbeatMs = options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;

  api.get('/api/notes', async (c) => {
    const parsed = listQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      has_image: c.req.query('has_image'),
    });
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    const { limit, cursor, has_image } = parsed.data;
    const tags = parseTagParams(c.req.queries('tag'));
    try {
      const page = await service.list({
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(tags.length > 0 ? { tagsAll: tags } : {}),
        ...(has_image !== undefined ? { hasImage: has_image === 'true' } : {}),
      });
      return c.json({ notes: page.notes, next_cursor: page.next_cursor });
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.get('/api/notes/:id', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    const note = await service.getOne(id);
    if (note === null) return notFound(c);
    return c.json(note);
  });

  api.post('/api/notes', async (c) => {
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = noteBodySchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    try {
      const note = await service.create({ body: parsed.data.body, origin: { source: 'web' }, allowEmpty: true });
      return c.json(note, 201);
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.patch('/api/notes/:id', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = noteBodySchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    try {
      return c.json(await service.update(id, parsed.data.body, { allowEmpty: true }));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.delete('/api/notes/:id', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    // P2's delete is idempotent; the UI contract is 404 for a note that is not live.
    if ((await service.getOne(id)) === null) return notFound(c);
    try {
      return c.json(await service.delete(id));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  /** The recycle bin: deleted notes and binned images, newest-deleted first. `?tag=` is AND. */
  api.get('/api/bin', async (c) => {
    const tags = parseTagParams(c.req.queries('tag'));
    try {
      return c.json(await service.listBin(tags.length > 0 ? { tagsAll: tags } : {}));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  /** Undo a soft delete. Restoring a live note is a no-op that returns it. */
  api.post('/api/notes/:id/restore', async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    try {
      return c.json(await service.restore(id));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  /** Delete forever (UI only): a deleted note, its rows and every file of its images. */
  api.delete('/api/bin/notes/:id', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('id'));
    if (id === null) return badRequest(c, 'invalid_id');
    try {
      return c.json(await service.purgeNote(id));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  /** Delete forever (UI only): one image removed from its note, its row and its files. */
  api.delete('/api/bin/images/:imageId', sameOriginOnly, async (c) => {
    const imageId = normalizeId(c.req.param('imageId'));
    if (imageId === null) return badRequest(c, 'invalid_id');
    try {
      return c.json(await service.purgeImage(imageId));
    } catch (err) {
      return noteErrorResponse(c, err);
    }
  });

  api.get('/api/tags', async (c) => {
    return c.json(await service.tags());
  });

  api.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      const listener = (event: NoteEvent): void => {
        if (closed) return;
        void stream
          .writeSSE({ event: 'note', data: JSON.stringify({ op: event.op, id: event.id }) })
          .catch(() => undefined);
      };
      const unsubscribe = deps.events.on(listener);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(timer);
          unsubscribe();
          resolve();
        });
        void stream.write(': connected\n\n').catch(() => undefined);
      });
    }),
  );

  api.post('/api/chat', async (c) => {
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = chatSchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    const { message, thread_id, image_ids } = parsed.data;

    // Resolve (and derive the preview of) every pasted image before the stream opens, so a bad id
    // is a plain JSON error the client can show.
    let images: ChatTurnImage[] = [];
    if (image_ids !== undefined && image_ids.length > 0) {
      try {
        images = await resolveTurnImages(chatImageStoreFor(deps), image_ids);
      } catch (err) {
        if (!(err instanceof ChatImageLookupError)) throw err;
        return c.json({ error: err.code, id: err.imageId, message: err.message }, chatImageErrorStatus(err.code));
      }
    }

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      try {
        const turn = await chat.reply({
          message,
          images,
          threadId: thread_id ?? null,
          signal: controller.signal,
        });
        for await (const event of turn.events) {
          if (controller.signal.aborted) return;
          await stream.writeSSE({ event: chatEventName(event), data: JSON.stringify({ text: event.text }) });
        }
        if (controller.signal.aborted) return;
        const end = turn.end();
        const done: { thread_id: string; brain?: ChatBrain } = { thread_id: end.threadId };
        if (end.brain !== undefined) done.brain = end.brain;
        await stream.writeSSE({ event: 'done', data: JSON.stringify(done) });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error }) });
      }
    });
  });

  return api;
}
