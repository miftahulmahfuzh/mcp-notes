import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AdversaryReader } from '../adversary/read.js';
import { AdversaryReadError, findPairing, pairRoster, readRoster } from '../adversary/readSql.js';
import type { ReviewNowResult } from '../adversary/readTypes.js';
import { reasonOf } from '../connectors/errors.js';
import { createSeerConnector } from '../connectors/seer/index.js';
import { ConnectorError, type ReadOnlySource } from '../connectors/types.js';
import type { AppDeps } from '../deps.js';
import { describeIssues } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * /api/adversary/* (SEER_ADVERSARIAL_PLAN phase 5): the read model over Seer's DB, and the toggle and
 * "Review now" of phase 4's reviewer. Reads need no reviewer (they work with NOTESD_ADVERSARY=off);
 * writes to the reviewer are same-origin only. Inputs are validated here once.
 */

export interface AdversaryApiOptions {
  /** Seer's database, read-only. Omitted: the Seer connector (SEER_DIR/.env.local, re-read per query). */
  seer?: ReadOnlySource;
}

const idParam = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const toggleBody = z.object({ on: z.boolean() }).strict();
const reviewNowBody = z.object({ strategy_id: idParam.optional() }).strict();

const REVIEWER_OFF = {
  error: 'reviewer_off',
  message: 'The Seer Adversarial reviewer is not running on this machine (NOTESD_ADVERSARY=off).',
} as const;

export type SeerUnavailableDetail = 'not_reachable' | 'not_migrated' | 'query_failed';

/** The 503 body for a Seer that cannot be read (repo, .env.local, DB, or migration 027 missing). */
export function seerUnavailable(err: ConnectorError): { error: 'seer_unavailable'; detail: SeerUnavailableDetail; reason: string } {
  const m = err.message;
  const detail: SeerUnavailableDetail = / is not reachable: /.test(m) ? 'not_reachable' : /does not exist/.test(m) ? 'not_migrated' : 'query_failed';
  return { error: 'seer_unavailable', detail, reason: m };
}

export function adversaryApiRoutes(deps: Pick<AppDeps, 'adversary'>, options: AdversaryApiOptions = {}): Hono {
  const api = new Hono();
  const seer = options.seer ?? createSeerConnector();
  const reader = new AdversaryReader(seer);
  const reviewer = deps.adversary ?? null;

  function failure(c: Context, err: unknown): Response {
    if (err instanceof AdversaryReadError) return c.json({ error: err.code, message: err.message }, err.code === 'not_found' ? 404 : 400);
    if (err instanceof ConnectorError) return c.json(seerUnavailable(err), 503);
    throw err;
  }

  async function answer(c: Context, fn: () => Promise<unknown>): Promise<Response> {
    try {
      return c.json((await fn()) as Record<string, unknown>);
    } catch (err) {
      return failure(c, err);
    }
  }

  function idOf(c: Context): string | null {
    const p = idParam.safeParse(c.req.param('id'));
    return p.success ? p.data : null;
  }

  api.get('/api/adversary/overview', (c) =>
    answer(c, async () => reader.overview(reviewer !== null ? await reviewer.status().catch(() => null) : null)),
  );

  api.get('/api/adversary/methods/:id', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    return answer(c, () => reader.method(id));
  });

  api.get('/api/adversary/methods/:id/decisions/:session', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    return answer(c, () => reader.decision(id, c.req.param('session')));
  });

  api.get('/api/adversary/daily/:id', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    const session = c.req.query('session');
    return answer(c, () => reader.daily(id, session === undefined || session === '' ? undefined : session));
  });

  api.get('/api/adversary/scorecard/:id', (c) => {
    const id = idOf(c);
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    return answer(c, () => reader.scorecard(id));
  });

  api.get('/api/adversary/toggle', async (c) => {
    if (reviewer === null) return c.json(REVIEWER_OFF, 503);
    return c.json(await reviewer.getToggle());
  });

  api.put('/api/adversary/toggle', sameOriginOnly, async (c) => {
    if (reviewer === null) return c.json(REVIEWER_OFF, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = toggleBody.safeParse(body);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    return c.json(await reviewer.setToggle(parsed.data.on, reviewer.host));
  });

  /** Starts one manual pass (it runs even while the toggle is off) and answers before it finishes. */
  api.post('/api/adversary/review-now', sameOriginOnly, async (c) => {
    if (reviewer === null) return c.json(REVIEWER_OFF, 503);
    const text = await c.req.text();
    let body: unknown = {};
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }
    const parsed = reviewNowBody.safeParse(body);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    let strategyId: string | undefined;
    if (parsed.data.strategy_id !== undefined) {
      try {
        const pair = findPairing(pairRoster(await readRoster(seer)), parsed.data.strategy_id);
        if (pair === null) return c.json({ error: 'not_found', message: `no Seer Adversarial method "${parsed.data.strategy_id}"` }, 404);
        strategyId = pair.original.id;
      } catch (err) {
        return failure(c, err);
      }
    }
    const status = await reviewer.status().catch(() => null);
    void reviewer
      .reviewNow(strategyId !== undefined ? { strategyId } : {})
      .catch((err: unknown) => console.error(`[notesd] adversary review-now failed: ${reasonOf(err)}`));
    const result: ReviewNowResult = {
      started: true,
      reason: status?.running ? `queued behind the ${status.running} pass already running` : null,
    };
    return c.json(result, 202);
  });

  return api;
}
