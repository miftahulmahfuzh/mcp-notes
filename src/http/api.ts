import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ChatBackend, ChatBrain, ChatTurnImage } from '../chat/backend.js';
import { CitationFilter } from '../chat/citation.js';
import type { ChatChange } from '../chat/events.js';
import { normalizeMessageId } from '../chat/ids.js';
import { projectKeySchema } from '../chat/project.js';
import {
  ChatImageLookupError,
  chatImageStoreFor,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  resolveTurnImages,
  type ChatImageLookupErrorCode,
} from '../chat/images.js';
import type { UserTurnStart } from '../chat/service.js';
import { createStubChatBackend } from '../chat/stub.js';
import { resolveTurnNoteImages } from '../chat/noteImages.js';
import { composeWallTurn } from '../chat/turn.js';
import { imageDeps } from '../images/ingest.js';
import type { AppDeps } from '../deps.js';
import type { NoteEvent } from '../notes/events.js';
import { normalizeId } from '../notes/ids.js';
import { MAX_LIMIT } from '../notes/repo.js';
import { NoteError } from '../notes/types.js';
import { chatErrorResponse } from './chatApi.js';
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

/** `message` may be empty only when images come with it (phase 3). */
const chatSchema = z
  .object({
    /** Defaults to '' (P3): an image-only message may omit it. */
    message: z.string().trim().default(''),
    thread_id: z.string().trim().min(1).max(200).optional(),
    reply_to: z.string().trim().min(1).max(32).optional(),
    /** Chat image ids from POST /api/chat/images, in paste order (phase 3). */
    image_ids: z.array(z.string().trim().min(1).max(16)).max(MAX_CHAT_IMAGES_PER_MESSAGE).default([]),
    /** Ids of pictures that already live in notes ("chat about this image"): referenced, never copied. */
    note_image_ids: z.array(z.string().trim().min(1).max(16)).max(MAX_CHAT_IMAGES_PER_MESSAGE).default([]),
    /** Repo key from the Projects page (phase 12). Absent: wall chat. A thread never changes project. */
    project: projectKeySchema.optional(),
  })
  .refine((body) => body.message.length > 0 || body.image_ids.length > 0 || body.note_image_ids.length > 0, {
    message: 'a message or at least one image is required',
    path: ['message'],
  })
  .refine((body) => body.image_ids.length + body.note_image_ids.length <= MAX_CHAT_IMAGES_PER_MESSAGE, {
    message: `at most ${MAX_CHAT_IMAGES_PER_MESSAGE} images per message`,
    path: ['note_image_ids'],
  });

/** `event: done` of POST /api/chat. */
interface ChatDone {
  /** OUR thread id (chat_threads.id). */
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  /** The bubble the answer replies to (leading `[msg:ID]`), or null. */
  reply_to: string | null;
  brain?: ChatBrain;
}

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

export function describeIssues(error: z.ZodError): string {
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

export async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
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

export function apiRoutes(deps: AppDeps, options: ApiOptions = {}): Hono {
  const api = new Hono();
  const service = deps.service;
  const history = deps.chat;
  const backend = options.chat ?? createStubChatBackend();
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
        // The wall shows the most recently edited note first.
        dateField: 'updated',
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
      const onNote = (event: NoteEvent): void => {
        if (closed) return;
        void stream
          .writeSSE({ event: 'note', data: JSON.stringify({ op: event.op, id: event.id }) })
          .catch(() => undefined);
      };
      const onChat = (change: ChatChange): void => {
        if (closed) return;
        void stream
          .writeSSE({
            event: 'chat',
            data: JSON.stringify({ op: change.op, thread_id: change.thread_id, id: change.id }),
          })
          .catch(() => undefined);
      };
      const unsubscribeNote = deps.events.on(onNote);
      const unsubscribeChat = history.events.on(onChat);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(timer);
          unsubscribeNote();
          unsubscribeChat();
          resolve();
        });
        void stream.write(': connected\n\n').catch(() => undefined);
      });
    }),
  );

  /**
   * One wall chat turn. Order: validate -> write the user row (it survives any later failure) ->
   * `event: accepted` -> rebuild context from our rows -> stream (a leading `[msg:ID]` is held back
   * and stripped) -> on a clean finish only, write the assistant row -> `event: done`. A client
   * abort persists nothing for the answer. An unknown thread_id (e.g. an Agent SDK session id from
   * before phase 7) starts a new thread. A `project` (repo key) scopes the thread to that project
   * and puts a <project> block first in the prompt (phase 12).
   */
  api.post('/api/chat', async (c) => {
    const json = await readJson(c);
    if (!json.ok) return badRequest(c, 'invalid_json');
    const parsed = chatSchema.safeParse(json.value);
    if (!parsed.success) return badRequest(c, describeIssues(parsed.error));
    const { message, thread_id, reply_to, image_ids, note_image_ids, project } = parsed.data;

    let replyTo: string | null = null;
    if (reply_to !== undefined) {
      replyTo = normalizeMessageId(reply_to);
      if (replyTo === null) return badRequest(c, 'invalid_reply_to');
    }
    let currentImages: ChatTurnImage[] = [];
    if (image_ids.length > 0) {
      try {
        currentImages = await resolveTurnImages(chatImageStoreFor(deps), image_ids);
      } catch (err) {
        if (!(err instanceof ChatImageLookupError)) throw err;
        return c.json({ error: err.code, id: err.imageId, message: err.message }, chatImageErrorStatus(err.code));
      }
    }
    let currentNoteImages: ChatTurnImage[] = [];
    if (note_image_ids.length > 0) {
      try {
        currentNoteImages = await resolveTurnNoteImages(imageDeps(deps), note_image_ids);
      } catch (err) {
        if (!(err instanceof ChatImageLookupError)) throw err;
        return c.json({ error: err.code, id: err.imageId, message: err.message }, chatImageErrorStatus(err.code));
      }
    }
    let start: UserTurnStart;
    try {
      start = await history.addUserMessage({
        threadId: thread_id ?? null,
        source: 'wall',
        text: message,
        attachments: [
          ...currentImages.map((image) => ({ kind: 'chat_image' as const, id: image.id })),
          ...currentNoteImages.map((image) => ({ kind: 'note_image' as const, id: image.id })),
        ],
        replyTo,
        project: project ?? null,
      });
    } catch (err) {
      return chatErrorResponse(c, err);
    }
    const threadId = start.thread.id;
    const userMessageId = start.message.id;

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const send = (event: string, data: unknown): Promise<void> =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      try {
        await send('accepted', { thread_id: threadId, user_message_id: userMessageId });
        const composed = await composeWallTurn(history, chatImageStoreFor(deps), {
          threadId,
          currentMessageId: userMessageId,
          currentImages,
          currentNoteImages,
        });
        if (controller.signal.aborted) return;
        const turn = await backend.reply({ turn: composed, signal: controller.signal });
        const citation = new CitationFilter();
        for await (const event of turn.events) {
          if (controller.signal.aborted) return;
          if (event.type === 'delta') {
            const text = citation.push(event.text);
            if (text !== '') await send('delta', { text });
          } else {
            const held = citation.flush();
            if (held !== '') await send('delta', { text: held });
            await send('status', { text: event.text });
          }
        }
        if (controller.signal.aborted) return;
        const tail = citation.end();
        if (tail !== '') await send('delta', { text: tail });
        const end = turn.end();
        const cited = citation.replyTo;
        const answerReplyTo =
          cited !== null && cited !== userMessageId && (await history.liveMessageExists(cited)) ? cited : null;
        if (controller.signal.aborted) return;
        const answer = await history.addAssistantMessage({
          threadId,
          text: citation.text,
          brain: end.brain ?? null,
          replyTo: answerReplyTo,
        });
        const done: ChatDone = {
          thread_id: threadId,
          user_message_id: userMessageId,
          assistant_message_id: answer.id,
          reply_to: answerReplyTo,
        };
        if (end.brain !== undefined) done.brain = end.brain;
        await send('done', done);
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        await send('error', { error });
      }
    });
  });

  return api;
}
