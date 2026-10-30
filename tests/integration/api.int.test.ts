import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STUB_REPLY } from '../../src/chat/stub.js';
import { generateId } from '../../src/notes/ids.js';
import type { Note } from '../../src/notes/types.js';
import { createApiHarness, uniqueTag, type ApiHarness } from './helpers/api-harness.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';

interface ListResponse {
  notes: Note[];
  next_cursor: string | null;
}

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

async function listIds(query: string): Promise<string[]> {
  const res = await h.request(`/api/notes?${query}`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as ListResponse;
  return json.notes.map((n) => n.id);
}

describe('POST /api/notes', () => {
  it('creates a note with origin source web', async () => {
    const tag = uniqueTag();
    const res = await h.sendJson('POST', '/api/notes', { body: `hello #${tag}` });
    expect(res.status).toBe(201);
    const note = (await res.json()) as Note;
    expect(note.body).toBe(`hello #${tag}`);
    expect(note.tags).toContain(tag);
    expect(note.origin).toMatchObject({ source: 'web' });
  });

  it('allows an empty body', async () => {
    const res = await h.sendJson('POST', '/api/notes', { body: '' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Note).body).toBe('');
  });

  it('rejects a missing body and invalid json with {error}', async () => {
    const missing = await h.sendJson('POST', '/api/notes', {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toHaveProperty('error');
    const bad = await h.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_json' });
  });
});

describe('GET /api/notes/:id', () => {
  it('returns the note for canonical, lower-case and dashless ids', async () => {
    const note = await h.notes.create({ body: 'lookup', origin: null });
    for (const variant of [note.id, note.id.toLowerCase(), note.id.replace(/-/g, '').toLowerCase()]) {
      const res = await h.request(`/api/notes/${variant}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Note).id).toBe(note.id);
    }
  });

  it('400s a malformed id and 404s an unknown one', async () => {
    const bad = await h.request('/api/notes/!!!');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_id' });
    const missing = await h.request(`/api/notes/${generateId()}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('does not swallow image sub-paths', async () => {
    const note = await h.notes.create({ body: 'sub', origin: null });
    const res = await h.request(`/api/notes/${note.id}/thumb`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/notes/:id', () => {
  it('updates the body and re-parses tags', async () => {
    const tag = uniqueTag();
    const note = await h.notes.create({ body: 'before', origin: null });
    const res = await h.sendJson('PATCH', `/api/notes/${note.id.toLowerCase()}`, { body: `after #${tag}` });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Note;
    expect(updated.body).toBe(`after #${tag}`);
    expect(updated.tags).toEqual([tag]);
  });

  it('allows emptying the body', async () => {
    const note = await h.notes.create({ body: 'to empty', origin: null });
    const res = await h.sendJson('PATCH', `/api/notes/${note.id}`, { body: '' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Note).body).toBe('');
  });

  it('validates and 404s', async () => {
    const note = await h.notes.create({ body: 'x', origin: null });
    expect((await h.sendJson('PATCH', `/api/notes/${note.id}`, { body: 5 })).status).toBe(400);
    expect((await h.sendJson('PATCH', `/api/notes/${generateId()}`, { body: 'y' })).status).toBe(404);
  });
});

describe('DELETE /api/notes/:id', () => {
  it('soft-deletes, hides from get and list, and 404s a second delete', async () => {
    const tag = uniqueTag();
    const note = await h.notes.create({ body: `bye #${tag}`, origin: null });
    const res = await h.request(`/api/notes/${note.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const deleted = (await res.json()) as Note;
    expect(deleted.deleted_at).toBeTruthy();
    expect((await h.request(`/api/notes/${note.id}`)).status).toBe(404);
    expect(await listIds(`tag=${tag}`)).toEqual([]);
    expect((await h.request(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /api/notes', () => {
  it('lists newest first and paginates with an opaque cursor', async () => {
    const tag = uniqueTag();
    const a = await h.notes.create({ body: `one #${tag}`, origin: null });
    const b = await h.notes.create({ body: `two #${tag}`, origin: null });
    const c = await h.notes.create({ body: `three #${tag}`, origin: null });

    const first = await h.request(`/api/notes?tag=${tag}&limit=2`);
    const page1 = (await first.json()) as ListResponse;
    expect(page1.notes.map((n) => n.id)).toEqual([c.id, b.id]);
    expect(page1.next_cursor).toEqual(expect.any(String));

    const second = await h.request(
      `/api/notes?tag=${tag}&limit=2&cursor=${encodeURIComponent(page1.next_cursor as string)}`,
    );
    const page2 = (await second.json()) as ListResponse;
    expect(page2.notes.map((n) => n.id)).toEqual([a.id]);
    expect(page2.next_cursor).toBeNull();
  });

  it('applies repeated tag params with AND semantics, tolerating # and case', async () => {
    const u = uniqueTag();
    await h.notes.create({ body: `#${u} #alpha`, origin: null });
    await h.notes.create({ body: `#${u} #beta`, origin: null });
    const both = await h.notes.create({ body: `#${u} #alpha #beta`, origin: null });
    expect(await listIds(`tag=${u}&tag=alpha&tag=beta`)).toEqual([both.id]);
    expect(await listIds(`tag=%23${u.toUpperCase()}&tag=ALPHA&tag=beta`)).toEqual([both.id]);
    expect((await listIds(`tag=${u}`)).length).toBe(3);
  });

  it('filters by has_image: omitted = all, true = images only, false = text only', async () => {
    const tag = uniqueTag();
    const text = await h.notes.create({ body: `words #${tag}`, origin: null });
    const imageId = await h.insertImageNote(tag);

    expect(new Set(await listIds(`tag=${tag}`))).toEqual(new Set([text.id, imageId]));
    expect(await listIds(`tag=${tag}&has_image=true`)).toEqual([imageId]);
    expect(await listIds(`tag=${tag}&has_image=false`)).toEqual([text.id]);

    const res = await h.request(`/api/notes?tag=${tag}&has_image=true`);
    const [imageNote] = ((await res.json()) as ListResponse).notes;
    expect(imageNote?.images[0]).toMatchObject({ id: imageId, mime: 'image/jpeg', available: false });
  });

  it('rejects bad query params with {error}', async () => {
    for (const q of ['has_image=maybe', 'limit=0', 'limit=abc', 'limit=5001', 'cursor=%25%25garbage']) {
      const res = await h.request(`/api/notes?${q}`);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
  });

  it('defaults to returning many notes in one page', async () => {
    const res = await h.request('/api/notes');
    expect(res.status).toBe(200);
    const json = (await res.json()) as ListResponse;
    expect(Array.isArray(json.notes)).toBe(true);
    expect(json.notes.every((n) => !n.deleted_at)).toBe(true);
  });
});

describe('GET /api/tags', () => {
  it('returns tag, count and last_used', async () => {
    const tag = uniqueTag();
    await h.notes.create({ body: `#${tag} a`, origin: null });
    await h.notes.create({ body: `#${tag} b`, origin: null });
    const res = await h.request('/api/tags');
    expect(res.status).toBe(200);
    const tags = (await res.json()) as Array<{ tag: string; count: number; last_used: string }>;
    const entry = tags.find((t) => t.tag === tag);
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(2);
    expect(Number.isNaN(Date.parse(entry?.last_used ?? ''))).toBe(false);
  });
});

describe('POST /api/chat', () => {
  it('streams the stub reply as deltas then done with a new thread id', async () => {
    const res = await h.sendJson('POST', '/api/chat', { message: 'what did I save?' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const messages = parseSse(await res.text());
    const deltas = messages.filter((m) => m.event === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((m) => (m.data as { text: string }).text).join('')).toBe(STUB_REPLY);
    const last = messages[messages.length - 1];
    expect(last?.event).toBe('done');
    expect((last?.data as { thread_id: string } | undefined)?.thread_id).toMatch(/^stub-/);
  });

  it('echoes a given thread_id in done', async () => {
    const res = await h.sendJson('POST', '/api/chat', { message: 'again', thread_id: 'thread-42' });
    const messages = parseSse(await res.text());
    expect(messages[messages.length - 1]).toEqual({ event: 'done', data: { thread_id: 'thread-42' } });
  });

  it('rejects an empty message with a JSON {error} before streaming', async () => {
    for (const payload of [{}, { message: '   ' }, { message: 3 }]) {
      const res = await h.sendJson('POST', '/api/chat', payload);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(await res.json()).toHaveProperty('error');
    }
  });
});

describe('POST /api/chat with an injected backend', () => {
  let f: ApiHarness;
  let fake: ScriptedChatBackend;

  beforeAll(async () => {
    fake = createScriptedChatBackend();
    f = await createApiHarness({ chat: fake });
  });

  afterAll(async () => {
    await f.close();
  });

  async function chat(payload: unknown) {
    const res = await f.sendJson('POST', '/api/chat', payload);
    expect(res.status).toBe(200);
    return parseSse(await res.text());
  }

  it('streams status and delta events in backend order, then done with thread_id and brain', async () => {
    fake.push({
      steps: [
        { type: 'status', text: 'searching notes' },
        { type: 'status', text: 'reading 3 notes' },
        { type: 'status', text: '' },
        { type: 'delta', text: 'You saved ' },
        { type: 'delta', text: 'A-B32.' },
      ],
      end: { threadId: 'sess-1', brain: 'claude' },
    });
    const messages = await chat({ message: 'what did I save?' });
    expect(messages).toEqual([
      { event: 'status', data: { text: 'searching notes' } },
      { event: 'status', data: { text: 'reading 3 notes' } },
      { event: 'status', data: { text: '' } },
      { event: 'delta', data: { text: 'You saved ' } },
      { event: 'delta', data: { text: 'A-B32.' } },
      { event: 'done', data: { thread_id: 'sess-1', brain: 'claude' } },
    ]);
    const req = fake.requests.at(-1);
    expect(req?.message).toBe('what did I save?');
    expect(req?.threadId).toBeNull();
  });

  it('passes thread_id to the backend and reports the thread and brain the backend ended with', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'ok' }], end: { threadId: 'sess-2', brain: 'glm' } });
    const messages = await chat({ message: 'and last month?', thread_id: 'sess-1' });
    expect(fake.requests.at(-1)?.threadId).toBe('sess-1');
    expect(messages.at(-1)).toEqual({ event: 'done', data: { thread_id: 'sess-2', brain: 'glm' } });
  });

  it('omits brain from done when the backend reports none', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'hi' }], end: { threadId: 'sess-3' } });
    const messages = await chat({ message: 'hi' });
    const done = messages.at(-1);
    expect(done).toEqual({ event: 'done', data: { thread_id: 'sess-3' } });
    expect(done?.data).not.toHaveProperty('brain');
  });

  it('sends event: error and no done when the events stream throws mid-turn', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'partial ' }, { type: 'throw', message: 'usage limit reached' }] });
    const messages = await chat({ message: 'x' });
    expect(messages).toEqual([
      { event: 'delta', data: { text: 'partial ' } },
      { event: 'error', data: { error: 'usage limit reached' } },
    ]);
  });

  it('sends event: error when reply() itself rejects', async () => {
    fake.push({ steps: [], rejectWith: 'claude not found' });
    const messages = await chat({ message: 'x' });
    expect(messages).toEqual([{ event: 'error', data: { error: 'claude not found' } }]);
  });

  it('aborts the backend request signal when the client disconnects', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'first ' }, { type: 'hang' }] });
    const res = await f.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'slow one' }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes('event: delta'));
    expect(parseSse(text)[0]).toEqual({ event: 'delta', data: { text: 'first ' } });
    const req = fake.requests.at(-1);
    expect(req?.message).toBe('slow one');
    expect(req?.signal.aborted).toBe(false);
    await reader.cancel();
    await waitFor(() => req?.signal.aborted === true);
  });
});
