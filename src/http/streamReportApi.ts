import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { PageReport } from '../directStream/report.js';
import { describeIssues } from './api.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * POST /api/stream/sessions/:id/report (STREAM_CACHE_AND_BUG_REPORT phase 4): the player page's
 * report button. Same-origin only: it opens a window in the owner's tmux.
 */

const LINE_MAX = 500;
const LINES_MAX = 50;

export const REPORT_OFF = {
  error: 'report_off',
  message: 'Stream reports are off in this daemon (no evidence log).',
} as const;

/**
 * A page line with the query and fragment of every address dropped: stream addresses carry signed
 * tokens, and a report folder holds host and path only. Capped at 500 characters.
 */
export function scrubLine(line: string): string {
  return line.replace(/((?:https?:\/\/|\/api\/stream\/)[^\s?#]*)[?#]\S*/g, '$1').slice(0, LINE_MAX);
}

const pageLines = z
  .array(z.string().max(4_000))
  .max(500)
  .transform((lines) => lines.slice(-LINES_MAX).map(scrubLine));

export const reportBody = z.object({
  page: z
    .object({
      stage: z.string().max(40),
      error: z
        .string()
        .max(4_000)
        .nullable()
        .transform((v) => (v === null ? null : scrubLine(v))),
      errors: pageLines,
      log: pageLines,
      title: z
        .string()
        .max(300)
        .nullish()
        .transform((v) => v ?? null),
      position_s: z
        .number()
        .min(0)
        .max(172_800)
        .nullish()
        .transform((v) => v ?? null),
    })
    .nullish(),
});

export function streamReportRoutes(deps: Pick<AppDeps, 'directStream' | 'streamReporter'>): Hono {
  const r = new Hono();

  // 200 {ok, dir, window, complete} | 409 already_reported {dir} | 409 no_tmux {dir, complete}
  // | 500 spawn_failed {dir, message, complete} | 500 snapshot_failed | 403 unknown_session
  // | 503 direct_stream_off / report_off | 400 invalid_json / invalid_body | 403 forbidden_origin.
  r.post('/api/stream/sessions/:id/report', sameOriginOnly, async (c) => {
    if ((deps.directStream ?? null) === null) return c.json(DIRECT_STREAM_OFF, 503);
    const reporter = deps.streamReporter ?? null;
    if (reporter === null) return c.json(REPORT_OFF, 503);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = reportBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: describeIssues(body.error) }, 400);
    const page: PageReport | null = body.data.page ?? null;
    const out = await reporter.report(c.req.param('id'), page);
    return c.json(out.body, out.status);
  });

  return r;
}
