import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { sessionsApiRoutes } from '../../../src/http/sessionsApi.js';

const OWN = 'http://localhost';
const HOST = 'this-host';
const REQUESTED_AT = '2026-11-03T08:00:00.000Z';

type StateRow = {
  session_id: string;
  node_id: string;
  host: string;
  has_summary: boolean;
  total_tokens: number;
  summary_requested_at: string | null;
};

/** One session row behind the state query; requestSummary sets the request like SessionsRepo does (only when null). */
function harness(row: StateRow | null) {
  const state = { row };
  const execute = vi.fn(async () => ({ rows: state.row === null ? [] : [{ ...state.row }] }));
  const requestSummary = vi.fn(async (_sessionId: string): Promise<void> => {
    if (state.row !== null && state.row.summary_requested_at === null) state.row.summary_requested_at = REQUESTED_AT;
  });
  const deps = {
    config: { port: 7317, sessions: { claudeHome: '/nonexistent-claude-home', swarmScript: null } },
    db: { execute },
    embedder: null,
  } as unknown as AppDeps;
  const app = sessionsApiRoutes(deps, {
    host: HOST,
    requestSummary,
    live: async () => [],
    commitLinks: async () => new Map(),
    unfinished: { annotate: async (nodes) => nodes },
  });
  return { app, execute, requestSummary, state };
}

/** `origin: null` sends no Origin header. */
function post(app: ReturnType<typeof sessionsApiRoutes>, nodeId: string, origin: string | null = OWN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.Origin = origin;
  return Promise.resolve(app.request(`/api/sessions/${nodeId}/summarize`, { method: 'POST', headers }));
}

const idleRow: StateRow = {
  session_id: 'sess-b1',
  node_id: 'B1-22',
  host: HOST,
  has_summary: false,
  total_tokens: 30,
  summary_requested_at: null,
};

describe('POST /api/sessions/:nodeId/summarize', () => {
  it('refuses a missing or foreign Origin before reading or writing anything', async () => {
    const h = harness({ ...idleRow });
    for (const origin of [null, 'http://evil.example', 'http://localhost:5173']) {
      const res = await post(h.app, 'B1-22', origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it('400 invalid_node_id for something that is not a node id', async () => {
    const h = harness({ ...idleRow });
    const res = await post(h.app, 'A-B32');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_node_id' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('404 not_found for an unknown node', async () => {
    const h = harness(null);
    const res = await post(h.app, 'ZZ-ZZ');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it('409 empty_session for a session with no tokens, without a write', async () => {
    const h = harness({ ...idleRow, total_tokens: 0 });
    const res = await post(h.app, 'B1-22');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'empty_session', node_id: 'B1-22' });
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it('records a request once (case-insensitive, dash optional) and is idempotent', async () => {
    const h = harness({ ...idleRow });
    const first = await post(h.app, 'b122');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ node_id: 'B1-22', summary_state: 'requested', summary_requested_at: REQUESTED_AT });
    expect(h.requestSummary).toHaveBeenCalledWith('sess-b1');

    const again = await post(h.app, 'B1-22');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ node_id: 'B1-22', summary_state: 'requested', summary_requested_at: REQUESTED_AT });
    expect(h.requestSummary).toHaveBeenCalledTimes(1);
  });

  it('a summarized node answers ready and records nothing', async () => {
    const h = harness({ ...idleRow, has_summary: true });
    const res = await post(h.app, 'B1-22');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ node_id: 'B1-22', summary_state: 'ready', summary_requested_at: null });
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it("another host's node can be requested (its own worker serves it)", async () => {
    const h = harness({ ...idleRow, host: 'gpd' });
    const res = await post(h.app, 'B1-22');
    expect(await res.json()).toEqual({ node_id: 'B1-22', summary_state: 'requested', summary_requested_at: REQUESTED_AT });
  });
});
