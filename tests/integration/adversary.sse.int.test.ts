import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiRoutes } from '../../src/http/api.js';
import { fakeAdversary } from './helpers/adversaryFake.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness({ sseHeartbeatMs: 50 });
});

afterAll(async () => {
  await h.close();
});

describe('GET /api/events relays the Seer Adversarial reviewer', () => {
  it('writes event: adversary for each change and unsubscribes on abort', async () => {
    const fake = fakeAdversary();
    const app = new Hono();
    app.route('/', apiRoutes({ ...h.deps, adversary: fake.service }, { sseHeartbeatMs: 50 }));
    const res = await app.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    expect(fake.events.listenerCount()).toBe(1);

    fake.emit({ op: 'verdict', strategy_id: 'A-GT', session_date: '2026-10-05' });
    const verdict = await readUntil(reader, (t) => t.includes('event: adversary'));
    expect(parseSse(verdict)).toContainEqual({ event: 'adversary', data: { op: 'verdict', strategy_id: 'A-GT', session_date: '2026-10-05' } });

    fake.emit({ op: 'run' });
    const run = await readUntil(reader, (t) => t.includes('"run"'));
    expect(parseSse(run)).toContainEqual({ event: 'adversary', data: { op: 'run', strategy_id: null, session_date: null } });

    await reader.cancel();
    await waitFor(() => fake.events.listenerCount() === 0);
  });

  it('still streams note events when the reviewer is off (adversary: null)', async () => {
    const app = new Hono();
    app.route('/', apiRoutes({ ...h.deps, adversary: null }, { sseHeartbeatMs: 50 }));
    const res = await app.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    const note = await h.notes.create({ body: 'still live #sse', origin: null });
    const text = await readUntil(reader, (t) => t.includes(note.id));
    expect(parseSse(text)).toContainEqual({ event: 'note', data: { op: 'created', id: note.id } });
    await reader.cancel();
  });
});
