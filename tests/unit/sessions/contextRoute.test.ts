import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { sessionsApiRoutes } from '../../../src/http/sessionsApi.js';
import { contextBand } from '../../../src/sessions/contextWindow.js';
import { SessionEvents } from '../../../src/sessions/events.js';
import type { SessionContextPayload } from '../../../src/sessions/view.js';
import { parseSse, readUntil, waitFor } from '../../integration/helpers/sse.js';

const HOST = 'this-host';

type Row = {
  session_id: string;
  node_id: string;
  host: string;
  context_tokens: number | null;
  context_model: string | null;
  context_at: string | null;
  context_peak_tokens: number | null;
  context_long_beta: boolean;
};

const baseRow: Row = {
  session_id: 'sess-b1',
  node_id: 'B1-22',
  host: HOST,
  context_tokens: 50_000,
  context_model: 'glm-5.3',
  context_at: '2026-11-12T02:00:00.000Z',
  context_peak_tokens: 50_000,
  context_long_beta: false,
};

function harness(row: Row | null, opts: { bus?: boolean; heartbeatMs?: number } = {}) {
  const state = { row };
  const execute = vi.fn(async () => ({ rows: state.row === null ? [] : [{ ...state.row }] }));
  const sessionEvents = opts.bus === false ? undefined : new SessionEvents();
  const deps = {
    config: { port: 7317, sessions: { claudeHome: '/nonexistent-claude-home', swarmScript: null } },
    db: { execute },
    embedder: null,
    ...(sessionEvents !== undefined ? { sessionEvents } : {}),
  } as unknown as AppDeps;
  const app = sessionsApiRoutes(deps, {
    host: HOST,
    live: async () => [],
    commitLinks: async () => new Map(),
    unfinished: { annotate: async (nodes) => nodes },
    contextDebounceMs: 10,
    sseHeartbeatMs: opts.heartbeatMs ?? 60_000,
  });
  return { app, execute, state, sessionEvents };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const contextEvents = (text: string): SessionContextPayload[] =>
  parseSse(text)
    .filter((m) => m.event === 'context')
    .map((m) => m.data as SessionContextPayload);

describe('GET /api/sessions/:nodeId/context', () => {
  it('answers the node context of any host, inferred from the stored evidence', async () => {
    const h = harness({ ...baseRow, host: 'gpd' });
    const res = await h.app.request('/api/sessions/b122/context');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      node_id: 'B1-22',
      host: 'gpd',
      available: false,
      context: {
        tokens: 50_000,
        window: 200_000,
        percent: 25,
        band: contextBand(25),
        model: 'glm-5.3',
        at: '2026-11-12T02:00:00.000Z',
        window_source: 'default',
        peak_tokens: 50_000,
      },
    });
  });

  it('context is null while nothing was captured', async () => {
    const h = harness({ ...baseRow, context_tokens: null, context_model: null, context_at: null, context_peak_tokens: null });
    expect(await (await h.app.request('/api/sessions/B1-22/context')).json()).toEqual({
      node_id: 'B1-22',
      host: HOST,
      available: true,
      context: null,
    });
  });

  it('400 invalid_node_id, 404 not_found', async () => {
    const h = harness(null);
    const bad = await h.app.request('/api/sessions/A-B32/context');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_node_id' });
    const missing = await h.app.request('/api/sessions/ZZ-ZZ/context');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });
});

describe('GET /api/sessions/:nodeId/context/stream', () => {
  it('sends the context on connect, then once per change of its own session, debounced, and unsubscribes on close', async () => {
    const h = harness({ ...baseRow });
    const bus = h.sessionEvents!;
    const res = await h.app.request('/api/sessions/B1-22/context/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = await readUntil(reader, (t) => contextEvents(t).length >= 1);
    expect(contextEvents(text)[0]).toMatchObject({ node_id: 'B1-22', available: true, context: { tokens: 50_000 } });
    expect(bus.listenerCount()).toBe(1);

    // Another session's write and an unchanged re-read send nothing.
    bus.emitContext('sess-other');
    bus.emitContext('sess-b1');
    await sleep(60);

    // A burst of writes that moved the context sends one event.
    h.state.row = { ...baseRow, context_tokens: 60_000, context_peak_tokens: 60_000, context_at: '2026-11-12T02:01:00.000Z' };
    for (let i = 0; i < 5; i += 1) bus.emitContext('sess-b1');
    text += await readUntil(reader, (t) => contextEvents(t).length >= 1);
    await sleep(60);
    const events = contextEvents(text);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ node_id: 'B1-22', context: { tokens: 60_000, percent: 30 } });

    await reader.cancel();
    await waitFor(() => bus.listenerCount() === 0);
  });

  it('a model change alone is an event; a context that disappears is sent as null', async () => {
    const h = harness({ ...baseRow });
    const bus = h.sessionEvents!;
    const reader = (await h.app.request('/api/sessions/B1-22/context/stream')).body!.getReader();
    await readUntil(reader, (t) => contextEvents(t).length >= 1);
    h.state.row = { ...baseRow, context_model: 'glm-5.4' };
    bus.emitContext('sess-b1');
    const second = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1));
    expect(second[0]?.context?.model).toBe('glm-5.4');
    h.state.row = { ...baseRow, context_tokens: null, context_peak_tokens: null };
    bus.emitContext('sess-b1');
    const third = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1));
    expect(third[0]?.context).toBeNull();
    await reader.cancel();
    await waitFor(() => bus.listenerCount() === 0);
  });

  it('without a bus it still sends the first event and heartbeats', async () => {
    const h = harness({ ...baseRow }, { bus: false, heartbeatMs: 20 });
    const reader = (await h.app.request('/api/sessions/B1-22/context/stream')).body!.getReader();
    const text = await readUntil(reader, (t) => contextEvents(t).length >= 1 && t.includes(': heartbeat'));
    expect(contextEvents(text)[0]?.context?.tokens).toBe(50_000);
    await reader.cancel();
  });

  it('400 / 404 answer JSON, not a stream', async () => {
    const h = harness(null);
    const bad = await h.app.request('/api/sessions/A-B32/context/stream');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_node_id' });
    const missing = await h.app.request('/api/sessions/ZZ-ZZ/context/stream');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
    expect(h.sessionEvents!.listenerCount()).toBe(0);
  });
});
