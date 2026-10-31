import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_PATH, MAX_CAPTURE_IMAGES } from '../../src/http/capture.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

beforeEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h.close();
});

interface WireMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  text: string;
  source: string;
  created_at: string;
  attachments: { kind: string; id: string }[];
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claude_session: 'sess-capture',
    user_uuid: randomUUID(),
    prompt: '/n show me the notes tagged #agentic',
    answer: 'Two notes are tagged #agentic: A-B32 and C-D45.',
    prompt_timestamp: '2026-10-30T11:53:23.611Z',
    answered_at: '2026-10-30T11:53:41.002Z',
    cwd: '/tmp/notes-demo',
    images: [],
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    h.app.request(`http://127.0.0.1${CAPTURE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function thread(id: string): Promise<{ thread: { id: string; source: string }; messages: WireMessage[] }> {
  const res = await h.app.request(`http://127.0.0.1/api/chat/threads/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { thread: { id: string; source: string }; messages: WireMessage[] };
}

async function count(table: 'chat_threads' | 'chat_messages' | 'chat_images'): Promise<number> {
  const result = await h.deps.db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return Number((result.rows[0] as { n: number }).n);
}

describe('POST /api/capture/claude-code', () => {
  it('stores one single-turn claude_code thread: user then assistant, with the given timestamps', async () => {
    const res = await post(payload());
    expect(res.status).toBe(201);
    const ids = (await res.json()) as { thread_id: string; user_message_id: string; assistant_message_id: string };
    expect(ids.user_message_id).toMatch(/^[0-9A-Z]{4}$/);
    const t = await thread(ids.thread_id);
    expect(t.thread.source).toBe('claude_code');
    expect(t.messages.map((m) => [m.role, m.source, m.text, m.created_at])).toEqual([
      ['user', 'claude_code', '/n show me the notes tagged #agentic', '2026-10-30T11:53:23.611Z'],
      ['assistant', 'claude_code', 'Two notes are tagged #agentic: A-B32 and C-D45.', '2026-10-30T11:53:41.002Z'],
    ]);
    expect(await count('chat_threads')).toBe(1);
  });

  it('a replay is a no-op answered 200 duplicate with the same ids', async () => {
    const body = payload();
    const first = (await (await post(body)).json()) as Record<string, string>;
    const again = await post({ ...body, answer: 'different text on replay' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true, ...first });
    expect(await count('chat_threads')).toBe(1);
    expect(await count('chat_messages')).toBe(2);
  });

  it('two concurrent posts of the same exchange write one thread', async () => {
    const body = payload();
    const statuses = (await Promise.all([post(body), post(body)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 201]);
    expect(await count('chat_threads')).toBe(1);
    expect(await count('chat_messages')).toBe(2);
  });

  it('stores pasted images in the chat image store (claude_code, sha-deduped) and attaches them to the user message', async () => {
    const red = (await makeImage('png', 16, 16, { r: 220, g: 40, b: 40 })).toString('base64');
    const blue = (await makeImage('jpeg', 16, 16, { r: 30, g: 60, b: 200 })).toString('base64');
    const res = await post(
      payload({
        images: [
          { media_type: 'image/png', data_base64: red },
          { media_type: 'image/jpeg', data_base64: blue },
          { media_type: 'image/png', data_base64: red },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const ids = (await res.json()) as { thread_id: string };
    const user = (await thread(ids.thread_id)).messages.find((m) => m.role === 'user')!;
    expect(user.attachments.map((a) => a.kind)).toEqual(['chat_image', 'chat_image']);
    expect(await count('chat_images')).toBe(2);
    const sources = await h.deps.db.execute(sql`select distinct source from chat_images`);
    expect(sources.rows).toEqual([{ source: 'claude_code' }]);
    const second = await post(payload({ images: [{ media_type: 'image/png', data_base64: red }] }));
    expect(second.status).toBe(201);
    expect(await count('chat_images')).toBe(2);
  });

  it('an empty answer stores the question only', async () => {
    const res = await post(payload({ answer: '' }));
    const ids = (await res.json()) as { thread_id: string; assistant_message_id: string | null };
    expect(ids.assistant_message_id).toBeNull();
    expect((await thread(ids.thread_id)).messages.map((m) => m.role)).toEqual(['user']);
  });

  it('an answer timestamp before the prompt is clamped after it', async () => {
    const res = await post(payload({ answered_at: '2026-10-30T11:00:00.000Z' }));
    const ids = (await res.json()) as { thread_id: string };
    const [user, assistant] = (await thread(ids.thread_id)).messages;
    expect(Date.parse(assistant!.created_at)).toBeGreaterThan(Date.parse(user!.created_at));
  });

  it('timeline: captures land by their own timestamps, not by arrival order', async () => {
    await post(payload({ prompt: '/n later', prompt_timestamp: '2026-10-30T12:00:00.000Z', answered_at: '2026-10-30T12:00:05.000Z' }));
    await post(payload({ prompt: '/n earlier', prompt_timestamp: '2026-10-30T09:00:00.000Z', answered_at: '2026-10-30T09:00:05.000Z' }));
    const res = await h.app.request('http://127.0.0.1/api/chat/messages');
    const { messages } = (await res.json()) as { messages: WireMessage[] };
    expect(messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['/n earlier', '/n later']);
  });

  it('validates the body', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post(payload({ prompt: '   ' }))).status).toBe(400);
    expect((await post(payload({ prompt_timestamp: 'yesterday' }))).status).toBe(400);
    expect((await post(payload({ claude_session: '' }))).status).toBe(400);
    const tooMany = Array.from({ length: MAX_CAPTURE_IMAGES + 1 }, () => ({ media_type: 'image/png', data_base64: 'aGk=' }));
    expect((await post(payload({ images: tooMany }))).status).toBe(400);
    expect((await post(payload({ images: [{ media_type: 'image/svg+xml', data_base64: 'aGk=' }] }))).status).toBe(400);
    const bad = await post(payload({ images: [{ media_type: 'image/png', data_base64: 'not*base64' }] }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_base64', index: 0 });
    expect(await count('chat_threads')).toBe(0);
  });

  it('refuses bytes the image store cannot read with 415 and writes nothing', async () => {
    const res = await post(payload({ images: [{ media_type: 'image/png', data_base64: Buffer.from('not an image at all').toString('base64') }] }));
    expect(res.status).toBe(415);
    expect(await count('chat_threads')).toBe(0);
  });

  it('is guarded: foreign Origin, missing header, non-loopback host', async () => {
    expect((await post(payload(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(payload(), { 'x-notes-capture': '' })).status).toBe(403);
    const foreign = await h.app.request(`http://notes.example${CAPTURE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify(payload()),
    });
    expect(foreign.status).toBe(403);
    expect(await count('chat_threads')).toBe(0);
  });
});
