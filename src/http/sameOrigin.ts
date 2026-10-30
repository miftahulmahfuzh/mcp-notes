import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when `value` parses as a URL whose host is loopback. */
export function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** True when the Origin header names exactly the request URL's origin (scheme, host, port). */
export function isSameOrigin(originHeader: string | undefined, requestUrl: string): boolean {
  if (originHeader === undefined || originHeader === '') return false;
  try {
    return new URL(originHeader).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Guard for endpoints only notesd's own page may call (purge, reveal). The request must come to a
 * loopback host, and carry an Origin equal to that host's origin. A missing, foreign or
 * unparseable Origin (`null` included) is refused with 403 `{ error: 'forbidden_origin' }`.
 */
export const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url) || !isSameOrigin(c.req.header('origin'), c.req.url)) {
    return c.json({ error: 'forbidden_origin' }, 403);
  }
  await next();
};
