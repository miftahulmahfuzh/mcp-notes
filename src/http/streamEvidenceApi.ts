import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { DEFAULT_EVIDENCE_LIMIT, MAX_EVIDENCE_LIMIT, playerRecord, type StreamEvidence } from '../directStream/evidence.js';
import { SESSION_ID_PATTERN } from '../directStream/sessions.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Stream evidence (stream-cache-and-bug-report phase 1): the player page's log lines, a snapshot of
 * one session's evidence, and a read of the log. The two POSTs write, so they are same-origin only;
 * a script without a browser (the /report-stream-bug skill) sends `Origin` equal to the address it
 * calls, e.g. `curl -H "Origin: http://127.0.0.1:7317" http://127.0.0.1:7317/...`. Mounted after
 * directStreamRoutes, whose `/api/stream/*` guard answers 503 direct_stream_off first.
 */

const MAX_SECONDS = 1_000_000;

const eventLine = z.object({
  text: z.string().min(1).max(2000),
  at: z.string().max(40).optional(),
  stage: z.string().max(40).optional(),
  position_s: z.number().finite().min(0).max(MAX_SECONDS).nullable().optional(),
  buffer_s: z.number().finite().min(0).max(MAX_SECONDS).nullable().optional(),
});

export const eventsBody = z.object({ lines: z.array(eventLine).min(1).max(50) });
export const snapshotBody = z.object({ session_id: z.string().regex(SESSION_ID_PATTERN).nullable().optional() });

const issues = (e: z.ZodError): string => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
const INVALID_SESSION = { error: 'invalid_session', message: 'That is not a stream session id.' } as const;
const INVALID_JSON = { error: 'invalid_json', message: 'The body is not JSON.' } as const;

export function streamEvidenceRoutes(deps: Pick<AppDeps, 'directStream' | 'streamEvidence'>): Hono {
  const r = new Hono();
  const evidence = (): StreamEvidence | null => ((deps.directStream ?? null) === null ? null : (deps.streamEvidence ?? null));

  // R2.2: the page's log lines, appended under the session id. The session need not be live: a page
  // whose session ended still says so.
  r.post('/api/stream/sessions/:id/events', sameOriginOnly, async (c) => {
    const ev = evidence();
    if (ev === null) return c.json(DIRECT_STREAM_OFF, 503);
    const id = c.req.param('id');
    if (!SESSION_ID_PATTERN.test(id)) return c.json(INVALID_SESSION, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(INVALID_JSON, 400);
    }
    const body = eventsBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: issues(body.error) }, 400);
    for (const line of body.data.lines) ev.record(playerRecord(id, line));
    return c.json({ ok: true, recorded: body.data.lines.length });
  });

  // R2.3: one session's evidence copied into a new folder on this host.
  r.post('/api/stream/evidence/snapshot', sameOriginOnly, async (c) => {
    const ev = evidence();
    if (ev === null) return c.json(DIRECT_STREAM_OFF, 503);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(INVALID_JSON, 400);
      }
    }
    const body = snapshotBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: issues(body.error) }, 400);
    try {
      return c.json({ ok: true, ...(await ev.snapshot(body.data.session_id ?? null)) });
    } catch (err) {
      return c.json({ error: 'snapshot_failed', message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Reads only: no Origin needed.
  r.get('/api/stream/evidence', async (c) => {
    const ev = evidence();
    if (ev === null) return c.json(DIRECT_STREAM_OFF, 503);
    const session = c.req.query('session') ?? null;
    if (session !== null && !SESSION_ID_PATTERN.test(session)) return c.json(INVALID_SESSION, 400);
    const limitText = c.req.query('limit');
    const limit = limitText === undefined ? DEFAULT_EVIDENCE_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_LIMIT) {
      return c.json({ error: 'invalid_limit', message: `limit must be a whole number from 1 to ${MAX_EVIDENCE_LIMIT}.` }, 400);
    }
    return c.json({ host: ev.host, file: ev.file, records: await ev.query({ session, limit }) });
  });

  return r;
}
