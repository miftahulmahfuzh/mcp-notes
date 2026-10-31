import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { CaptureImageError, MAX_CAPTURED_IMAGE_BYTES, captureClaudeCodeExchange } from '../chat/capture.js';
import type { AppDeps } from '../deps.js';
import { isLoopbackUrl } from './sameOrigin.js';

export const CAPTURE_PATH = '/api/capture/claude-code';
/** Lower-case header name. A custom header forces a CORS preflight, which notesd never answers. */
export const CAPTURE_HEADER = 'x-notes-capture';
export const MAX_CAPTURE_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_CAPTURE_IMAGES = 8;
export const MAX_CAPTURE_IMAGE_BYTES = MAX_CAPTURED_IMAGE_BYTES;
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_ANSWER_CHARS = 1_000_000;
export const CAPTURE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isoInstant = z
  .string()
  .regex(ISO_INSTANT, 'expected an ISO 8601 UTC or offset datetime')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a valid datetime');

const captureSchema = z.object({
  claude_session: z.string().trim().min(1).max(200),
  user_uuid: z.string().trim().min(1).max(200),
  prompt: z
    .string()
    .max(MAX_PROMPT_CHARS)
    .refine((value) => value.trim().length > 0, 'prompt is empty'),
  answer: z.string().max(MAX_ANSWER_CHARS),
  prompt_timestamp: isoInstant,
  answered_at: isoInstant,
  /** Accepted for forward compatibility; P7's thread has no column for it, so it is not stored. */
  cwd: z.string().max(4096).nullable().optional(),
  images: z
    .array(z.object({ media_type: z.enum(CAPTURE_MEDIA_TYPES), data_base64: z.string().min(1) }))
    .max(MAX_CAPTURE_IMAGES)
    .default([]),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

/** Strict standard base64 (whitespace ignored) -> bytes; null when it is not base64. */
export function decodeImageBase64(data: string): Buffer | null {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

/**
 * Who may post a capture: a loopback request URL (DNS-rebinding guard, as /mcp), no Origin or a
 * loopback one (a page elsewhere cannot post), the `X-Notes-Capture: 1` header (a browser cannot
 * add it cross-origin without a preflight that is never answered), and a JSON body.
 */
export const captureGuard: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url)) return c.json({ error: 'forbidden_host' }, 403);
  const origin = c.req.header('origin');
  if (origin !== undefined && !isLoopbackUrl(origin)) return c.json({ error: 'forbidden_origin' }, 403);
  if (c.req.header(CAPTURE_HEADER) !== '1') return c.json({ error: 'capture_header_required' }, 403);
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== 'application/json') return c.json({ error: 'json_required' }, 415);
  await next();
};

/**
 * POST /api/capture/claude-code: one `/n` exchange from the notes-capture Stop hook.
 * 201 {thread_id, user_message_id, assistant_message_id} when stored; 200 {duplicate: true, ...}
 * when `<claude_session>:<user_uuid>` was captured before (nothing written). 400 bad JSON /
 * validation / base64, 403 guard, 413 body or image too large, 415 not JSON or an image the store
 * refuses.
 */
export function captureRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.post(
    CAPTURE_PATH,
    captureGuard,
    bodyLimit({
      maxSize: MAX_CAPTURE_BODY_BYTES,
      onError: (c) => c.json({ error: 'too_large', max_bytes: MAX_CAPTURE_BODY_BYTES }, 413),
    }),
    async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = captureSchema.safeParse(json);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const body = parsed.data;

      const images: { mediaType: string; bytes: Buffer }[] = [];
      for (const [index, image] of body.images.entries()) {
        const bytes = decodeImageBase64(image.data_base64);
        if (bytes === null || bytes.length === 0) return c.json({ error: 'invalid_base64', index }, 400);
        if (bytes.length > MAX_CAPTURE_IMAGE_BYTES) {
          return c.json({ error: 'image_too_large', index, max_bytes: MAX_CAPTURE_IMAGE_BYTES }, 413);
        }
        images.push({ mediaType: image.media_type, bytes });
      }

      try {
        const result = await captureClaudeCodeExchange(deps, {
          claudeSession: body.claude_session,
          userUuid: body.user_uuid,
          prompt: body.prompt,
          answer: body.answer,
          promptAt: new Date(body.prompt_timestamp),
          answeredAt: new Date(body.answered_at),
          images,
        });
        const ids = {
          thread_id: result.threadId,
          user_message_id: result.userMessageId,
          assistant_message_id: result.assistantMessageId,
        };
        return result.duplicate ? c.json({ duplicate: true, ...ids }, 200) : c.json(ids, 201);
      } catch (err) {
        if (err instanceof CaptureImageError) {
          const tooLarge = err.code === 'too_large';
          return c.json(
            { error: tooLarge ? 'image_too_large' : 'unsupported_image', index: err.index, message: err.message },
            tooLarge ? 413 : 415,
          );
        }
        throw err;
      }
    },
  );
  return r;
}
