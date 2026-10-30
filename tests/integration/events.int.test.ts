import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness({ sseHeartbeatMs: 50 });
});

afterAll(async () => {
  await h.close();
});

describe('GET /api/events', () => {
  it('streams note events from service writes and unsubscribes on abort', async () => {
    const res = await h.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();

    await readUntil(reader, (t) => t.includes(': connected'));
    const listenersWhileOpen = h.events.listenerCount();
    expect(listenersWhileOpen).toBeGreaterThanOrEqual(1);

    const note = await h.notes.create({ body: 'live #sse', origin: null });
    const created = await readUntil(reader, (t) => t.includes(note.id));
    expect(parseSse(created)).toContainEqual({ event: 'note', data: { op: 'created', id: note.id } });

    await h.notes.update(note.id, 'live edited');
    const updated = await readUntil(reader, (t) => t.includes('"updated"'));
    expect(parseSse(updated)).toContainEqual({ event: 'note', data: { op: 'updated', id: note.id } });

    await h.notes.delete(note.id);
    const deleted = await readUntil(reader, (t) => t.includes('"deleted"'));
    expect(parseSse(deleted)).toContainEqual({ event: 'note', data: { op: 'deleted', id: note.id } });

    await reader.cancel();
    await waitFor(() => h.events.listenerCount() === listenersWhileOpen - 1);
  });

  it('sends heartbeat comments', async () => {
    const res = await h.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    const text = await readUntil(reader, (t) => t.includes(': heartbeat'), 2000);
    expect(text).toContain(': heartbeat');
    await reader.cancel();
  });

  it('sees writes made through the HTTP API too', async () => {
    const res = await h.request('/api/events');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    const post = await h.sendJson('POST', '/api/notes', { body: 'from web' });
    const { id } = (await post.json()) as { id: string };
    const text = await readUntil(reader, (t) => t.includes(id));
    expect(parseSse(text)).toContainEqual({ event: 'note', data: { op: 'created', id } });
    await reader.cancel();
  });
});
