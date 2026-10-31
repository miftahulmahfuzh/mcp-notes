import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentChatBackend, type QueryFn } from '../../src/chat/agent.js';
import { DEFAULT_CHAT_CONFIG } from '../../src/config.js';
import type { ChatMessageView, ChatTimelinePage } from '../../src/chat/types.js';
import { createApp } from '../../src/http/app.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse, readUntil, waitFor, type SseMessage } from './helpers/sse.js';
import { makeImage, startHarness } from './imageHarness.js';
import { truncateAll } from './setup.js';

interface Accepted {
  thread_id: string;
  user_message_id: string;
}
interface Done extends Accepted {
  assistant_message_id: string;
  reply_to: string | null;
  brain?: string;
}

let f: ApiHarness;
let fake: ScriptedChatBackend;

beforeAll(async () => {
  fake = createScriptedChatBackend();
  f = await createApiHarness({ chat: fake, sseHeartbeatMs: 50 });
});

afterAll(async () => {
  await f.close();
});

beforeEach(async () => {
  await truncateAll(f.deps.db);
});

async function chat(h: ApiHarness, payload: unknown): Promise<SseMessage[]> {
  const res = await h.sendJson('POST', '/api/chat', payload);
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

function acceptedOf(messages: SseMessage[]): Accepted {
  expect(messages[0]?.event).toBe('accepted');
  return messages[0]!.data as Accepted;
}

function doneOf(messages: SseMessage[]): Done {
  const last = messages.at(-1);
  expect(last?.event).toBe('done');
  return last!.data as Done;
}

function deltaText(messages: SseMessage[]): string {
  return messages
    .filter((m) => m.event === 'delta')
    .map((m) => (m.data as { text: string }).text)
    .join('');
}

async function ask(h: ApiHarness, backend: ScriptedChatBackend, payload: Record<string, unknown>, answer: string): Promise<Done> {
  backend.push({ steps: [{ type: 'delta', text: answer }], end: { brain: 'claude' } });
  return doneOf(await chat(h, payload));
}

describe('POST /api/chat: persistence and context', () => {
  it('persists a two-turn conversation and rebuilds the second prompt from our rows', async () => {
    const d1 = await ask(f, fake, { message: 'what did I save?' }, 'You saved A-B32.');
    const d2 = await ask(f, fake, { message: 'and last month?', thread_id: d1.thread_id }, 'Nothing.');
    expect(d2.thread_id).toBe(d1.thread_id);

    const turn = fake.requests.at(-1)!.turn;
    expect(turn.text).toMatch(/^<chat_history>\n/);
    expect(turn.text).toContain(`[msg:${d1.user_message_id}] user (`);
    expect(turn.text).toContain('): what did I save?');
    expect(turn.text).toContain(`[msg:${d1.assistant_message_id}] assistant (`);
    expect(turn.text).toContain('): You saved A-B32.');
    expect(turn.text).toMatch(
      new RegExp(`<message>\\n\\[msg:${d2.user_message_id}\\] user \\(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} WIB\\): and last month\\?\\n</message>$`),
    );
    expect(fake.requests.at(-1)).not.toHaveProperty('threadId');

    const thread = await f.chat.getThread(d1.thread_id);
    expect(thread?.messages.map((m) => [m.id, m.role, m.text, m.brain])).toEqual([
      [d1.user_message_id, 'user', 'what did I save?', null],
      [d1.assistant_message_id, 'assistant', 'You saved A-B32.', 'claude'],
      [d2.user_message_id, 'user', 'and last month?', null],
      [d2.assistant_message_id, 'assistant', 'Nothing.', 'claude'],
    ]);
  });

  it('keeps the context across a restart (a new service and app on the same database)', async () => {
    const d1 = await ask(f, fake, { message: 'remember the word kestrel' }, 'Noted.');
    const fake2 = createScriptedChatBackend();
    const g = await createApiHarness({ chat: fake2 });
    try {
      await ask(g, fake2, { message: 'which word?', thread_id: d1.thread_id }, 'kestrel');
      const text = fake2.requests[0]!.turn.text;
      expect(text).toContain('remember the word kestrel');
      expect(text).toContain('Noted.');
    } finally {
      await g.close();
    }
  });

  it('starts a new thread for a thread_id it does not know (an old SDK session id)', async () => {
    const d = await ask(f, fake, { message: 'hello', thread_id: '6f1c7a52-0000-4000-8000-000000000000' }, 'hi');
    expect(d.thread_id).not.toBe('6f1c7a52-0000-4000-8000-000000000000');
    expect(fake.requests.at(-1)!.turn.text).not.toContain('<chat_history>');
  });

  it('leaves deleted messages out of the context and uses edited text', async () => {
    const d1 = await ask(f, fake, { message: 'typo qestion' }, 'first answer');
    const d2 = await ask(f, fake, { message: 'secret detour', thread_id: d1.thread_id }, 'detour answer');
    expect((await f.sendJson('PATCH', `/api/chat/messages/${d1.user_message_id}`, { text: 'fixed question' }, SAME_ORIGIN)).status).toBe(200);
    const del = await f.request(`/api/chat/messages/${d2.user_message_id}?with_answer=1`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(await del.json()).toEqual({ deleted: [d2.user_message_id, d2.assistant_message_id] });

    await ask(f, fake, { message: 'third', thread_id: d1.thread_id }, 'ok');
    const text = fake.requests.at(-1)!.turn.text;
    expect(text).toContain('fixed question');
    expect(text).not.toContain('typo qestion');
    expect(text).not.toContain('secret detour');
    expect(text).not.toContain('detour answer');

    expect((await f.request(`/api/chat/messages/${d2.user_message_id}/restore`, { method: 'POST', headers: SAME_ORIGIN })).status).toBe(200);
    await ask(f, fake, { message: 'fourth', thread_id: d1.thread_id }, 'ok');
    expect(fake.requests.at(-1)!.turn.text).toContain('secret detour');
  });

  it('injects a reply_to target from another thread and records it on the question', async () => {
    const other = await ask(f, fake, { message: 'find my red top photo' }, 'That is the red one in A-B32.');
    const here = await ask(f, fake, { message: 'unrelated start' }, 'ok');
    const d = await ask(
      f,
      fake,
      { message: 'is it the same shade?', thread_id: here.thread_id, reply_to: `[msg:${other.assistant_message_id.toLowerCase()}]` },
      'Yes.',
    );
    const text = fake.requests.at(-1)!.turn.text;
    expect(text).toContain(`<reply_to>\n[msg:${other.assistant_message_id}] assistant (`);
    expect(text).toContain('That is the red one in A-B32.\n</reply_to>');
    const question = await f.chat.getMessage(d.user_message_id);
    expect(question?.reply_to).toEqual({ id: other.assistant_message_id, role: 'assistant', text: 'That is the red one in A-B32.', deleted: false });
  });

  it('persists nothing for the answer when the client disconnects', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'partial ' }, { type: 'hang' }] });
    const res = await f.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'slow' }),
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes('event: delta'));
    const accepted = parseSse(text)[0]!.data as Accepted;
    const req = fake.requests.at(-1)!;
    await reader.cancel();
    await waitFor(() => req.signal.aborted);
    await new Promise((r) => setTimeout(r, 50));
    const thread = await f.chat.getThread(accepted.thread_id);
    expect(thread?.messages.map((m) => m.id)).toEqual([accepted.user_message_id]);
  });
});

describe('POST /api/chat: brain fallback sees the identical prompt', () => {
  const SESSION = 'sess-x';
  const delta = (text: string): SDKMessage =>
    ({ type: 'stream_event', parent_tool_use_id: null, uuid: randomUUID(), session_id: SESSION, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }) as unknown as SDKMessage;
  const success = (): SDKMessage =>
    ({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, duration_ms: 1, duration_api_ms: 1, session_id: SESSION, uuid: randomUUID() }) as unknown as SDKMessage;
  const limited = (): SDKMessage =>
    ({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached', num_turns: 1, duration_ms: 1, duration_api_ms: 1, session_id: SESSION, uuid: randomUUID() }) as unknown as SDKMessage;

  it('claude hits its limit, glm answers, and both got the same composed prompt with no resume', async () => {
    const calls: Parameters<QueryFn>[0][] = [];
    const scripts: SDKMessage[][] = [[success()], [limited()], [delta('From GLM.'), success()]];
    const query: QueryFn = (params) => {
      calls.push(params);
      const script = scripts[calls.length - 1] ?? [];
      return (async function* () {
        for (const m of script) yield m;
      })();
    };
    const agent = createAgentChatBackend({
      chat: { ...DEFAULT_CHAT_CONFIG, claudeBin: '/nonexistent/claude', glm: { baseUrl: 'https://glm.invalid', apiKey: 'k', model: 'glm-test' } },
      cwd: '/nonexistent/chat',
      mcpUrl: () => 'http://127.0.0.1:1/mcp',
      query,
      log: () => {},
    });
    const g = await createApiHarness({ chat: agent });
    try {
      const first = doneOf(await chat(g, { message: 'first question' }));
      expect(first.brain).toBe('claude');
      const second = await chat(g, { message: 'second question', thread_id: first.thread_id });
      const done = doneOf(second);
      expect(done.brain).toBe('glm');
      expect(deltaText(second)).toBe('From GLM.');
      expect(calls).toHaveLength(3);
      expect(calls[1]!.prompt).toBe(calls[2]!.prompt);
      expect(calls[2]!.prompt).toContain('first question');
      for (const call of calls) {
        const options: Options = call.options;
        expect(options.resume).toBeUndefined();
        expect(options.persistSession).toBe(false);
      }
      const thread = await g.chat.getThread(first.thread_id);
      expect(thread?.thread.brain).toBe('glm');
      expect(thread?.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'From GLM.', brain: 'glm' });
    } finally {
      agent.close();
      await g.close();
    }
  });
});

describe('POST /api/chat: leading [msg:ID] citation', () => {
  it('strips a streamed, split marker, never emits it, and records reply_to', async () => {
    const target = await ask(f, fake, { message: 'target question' }, 'target answer');
    const id = target.user_message_id;
    fake.push({
      steps: [
        { type: 'status', text: 'searching notes' },
        { type: 'status', text: '' },
        { type: 'delta', text: '[' },
        { type: 'delta', text: 'msg:' },
        { type: 'delta', text: id.slice(0, 2) },
        { type: 'delta', text: `${id.slice(2)}] Here` },
        { type: 'delta', text: ' it is.' },
      ],
      end: { brain: 'claude' },
    });
    const messages = await chat(f, { message: 'which one?', thread_id: target.thread_id });
    const deltas = messages.filter((m) => m.event === 'delta').map((m) => (m.data as { text: string }).text);
    expect(deltas).toEqual(['Here', ' it is.']);
    const done = doneOf(messages);
    expect(done.reply_to).toBe(id);
    const answer = await f.chat.getMessage(done.assistant_message_id);
    expect(answer?.text).toBe('Here it is.');
    expect(answer?.reply_to).toMatchObject({ id, role: 'user', deleted: false });
  });

  it('drops an unknown or deleted citation silently but still strips the marker', async () => {
    fake.push({ steps: [{ type: 'delta', text: '[msg:ZZZZ] Hi there.' }] });
    const unknown = await chat(f, { message: 'x' });
    expect(deltaText(unknown)).toBe('Hi there.');
    expect(doneOf(unknown).reply_to).toBeNull();
    expect((await f.chat.getMessage(doneOf(unknown).assistant_message_id))?.text).toBe('Hi there.');

    const gone = await ask(f, fake, { message: 'soon deleted' }, 'a');
    await f.chat.deleteMessage(gone.user_message_id);
    fake.push({ steps: [{ type: 'delta', text: `[msg:${gone.user_message_id}] About that.` }] });
    const deleted = await chat(f, { message: 'y' });
    expect(acceptedOf(deleted).user_message_id).toMatch(/^[0-9A-Z]{4}$/);
    expect(deltaText(deleted)).toBe('About that.');
    expect(doneOf(deleted).reply_to).toBeNull();
  });

  it('streams an answer without a marker straight through', async () => {
    fake.push({ steps: [{ type: 'delta', text: 'Hello' }, { type: 'delta', text: ' world' }] });
    const messages = await chat(f, { message: 'hi' });
    expect(messages.filter((m) => m.event === 'delta').map((m) => (m.data as { text: string }).text)).toEqual(['Hello', ' world']);
    expect(doneOf(messages).reply_to).toBeNull();
  });
});

describe('POST /api/chat: validation', () => {
  it('rejects a malformed reply_to (400) and an unknown one (404) before writing anything', async () => {
    const bad = await f.sendJson('POST', '/api/chat', { message: 'x', reply_to: 'not an id' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_reply_to' });
    const missing = await f.sendJson('POST', '/api/chat', { message: 'x', reply_to: 'ZZZZ' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'reply_not_found' });
    expect((await f.chat.listTimeline({ includeDeleted: true })).messages).toEqual([]);
  });

  it('rejects an unknown image id (phase 3 validation) before writing anything', async () => {
    const res = await f.sendJson('POST', '/api/chat', { message: 'look', image_ids: ['Z-ZZZ'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_image', id: 'Z-ZZZ' });
    expect((await f.chat.listTimeline({ includeDeleted: true })).messages).toEqual([]);
  });
});

describe('history routes', () => {
  it('pages the timeline over HTTP with attachments and reply previews', async () => {
    const done: Done[] = [];
    for (let i = 0; i < 3; i += 1) done.push(await ask(f, fake, { message: `q${i}` }, `a${i}`));
    const res = await f.request('/api/chat/messages?limit=4');
    expect(res.status).toBe(200);
    const page = (await res.json()) as ChatTimelinePage;
    expect(page.messages.map((m) => m.text)).toEqual(['q1', 'a1', 'q2', 'a2']);
    expect(page.messages.every((m) => /Z$/.test(m.created_at))).toBe(true);
    const older = (await (await f.request(`/api/chat/messages?limit=4&before=${encodeURIComponent(page.next_before!)}`)).json()) as ChatTimelinePage;
    expect(older.messages.map((m) => m.text)).toEqual(['q0', 'a0']);
    expect(older.next_before).toBeNull();

    expect((await f.request('/api/chat/messages?limit=0')).status).toBe(400);
    const badCursor = await f.request('/api/chat/messages?before=nope');
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toEqual({ error: 'invalid_cursor' });
  });

  it('serves one thread and 404s an unknown one', async () => {
    const d = await ask(f, fake, { message: 'q' }, 'a');
    const res = await f.request(`/api/chat/threads/${d.thread_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thread: { id: string; source: string }; messages: ChatMessageView[] };
    expect(body.thread).toMatchObject({ id: d.thread_id, source: 'wall' });
    expect(body.messages.map((m) => m.id)).toEqual([d.user_message_id, d.assistant_message_id]);
    expect((await f.request('/api/chat/threads/nope')).status).toBe(404);
  });

  it('edits user bubbles only, demands same-origin and non-blank text', async () => {
    const d = await ask(f, fake, { message: 'old' }, 'a');
    expect((await f.sendJson('PATCH', `/api/chat/messages/${d.user_message_id}`, { text: 'new' })).status).toBe(403);
    const blank = await f.sendJson('PATCH', `/api/chat/messages/${d.user_message_id}`, { text: '  ' }, SAME_ORIGIN);
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: 'empty_text' });
    const answer = await f.sendJson('PATCH', `/api/chat/messages/${d.assistant_message_id}`, { text: 'x' }, SAME_ORIGIN);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: 'not_editable' });
    const ok = await f.sendJson('PATCH', `/api/chat/messages/${d.user_message_id}`, { text: 'new' }, SAME_ORIGIN);
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as ChatMessageView;
    expect(view.text).toBe('new');
    expect(view.edited_at).toMatch(/Z$/);
    expect((await f.chat.listRevisions(d.user_message_id)).map((r) => r.text)).toEqual(['old']);
    expect((await f.sendJson('PATCH', '/api/chat/messages/ZZZZ', { text: 'x' }, SAME_ORIGIN)).status).toBe(404);
    expect((await f.sendJson('PATCH', '/api/chat/messages/bad-id', { text: 'x' }, SAME_ORIGIN)).status).toBe(400);
  });

  it('deletes and restores over HTTP, same-origin only, with include_deleted on the timeline', async () => {
    const d = await ask(f, fake, { message: 'q' }, 'a');
    expect((await f.request(`/api/chat/messages/${d.user_message_id}`, { method: 'DELETE' })).status).toBe(403);
    const del = await f.request(`/api/chat/messages/${d.user_message_id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(await del.json()).toEqual({ deleted: [d.user_message_id] });
    const live = (await (await f.request('/api/chat/messages')).json()) as ChatTimelinePage;
    expect(live.messages.map((m) => m.id)).toEqual([d.assistant_message_id]);
    const all = (await (await f.request('/api/chat/messages?include_deleted=1')).json()) as ChatTimelinePage;
    expect(all.messages.find((m) => m.id === d.user_message_id)?.deleted_at).toMatch(/Z$/);
    expect((await f.request(`/api/chat/messages/${d.user_message_id}/restore`, { method: 'POST' })).status).toBe(403);
    const restored = await f.request(`/api/chat/messages/${d.user_message_id}/restore`, { method: 'POST', headers: SAME_ORIGIN });
    expect(((await restored.json()) as ChatMessageView).deleted_at).toBeNull();
    expect((await f.request('/api/chat/messages/ZZZZ/restore', { method: 'POST', headers: SAME_ORIGIN })).status).toBe(404);
  });
});

describe('GET /api/events: chat changes', () => {
  it('emits event: chat for each write next to the untouched note events, and unsubscribes on abort', async () => {
    const res = await f.request('/api/events');
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes(': connected'));
    const listeners = f.chat.events.listenerCount();
    expect(listeners).toBeGreaterThanOrEqual(1);

    const start = await f.chat.addUserMessage({ threadId: null, source: 'wall', text: 'sse' });
    const created = await readUntil(reader, (t) => t.includes(start.message.id));
    expect(parseSse(created)).toContainEqual({ event: 'chat', data: { op: 'created', thread_id: start.thread.id, id: start.message.id } });

    await f.chat.editMessage(start.message.id, 'sse edited');
    const updated = await readUntil(reader, (t) => t.includes('"updated"'));
    expect(parseSse(updated)).toContainEqual({ event: 'chat', data: { op: 'updated', thread_id: start.thread.id, id: start.message.id } });

    const note = await f.notes.create({ body: 'still notes', origin: null });
    const noteEvent = await readUntil(reader, (t) => t.includes(note.id));
    expect(parseSse(noteEvent)).toContainEqual({ event: 'note', data: { op: 'created', id: note.id } });

    await reader.cancel();
    await waitFor(() => f.chat.events.listenerCount() === listeners - 1);
  });
});

describe('POST /api/chat with phase 3 chat images', () => {
  it('writes chat_image attachments for the sent images and sends them as image blocks', async () => {
    const h = await startHarness();
    const imgFake = createScriptedChatBackend();
    const app = createApp(h.deps, { chat: imgFake });
    try {
      await h.reset();
      const form = new FormData();
      form.append('file', new Blob([await makeImage('png', 16, 16, { r: 200, g: 10, b: 10 })], { type: 'image/png' }), 'red.png');
      const up = await app.request('/api/chat/images', { method: 'POST', body: form });
      expect(up.status).toBe(201);
      const { image } = (await up.json()) as { image: { id: string }; created: boolean };
      const imageId = image.id;

      imgFake.push({ steps: [{ type: 'delta', text: 'A red square.' }], end: { brain: 'claude' } });
      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '', image_ids: [imageId] }),
      });
      const messages = parseSse(await res.text());
      const done = doneOf(messages);
      const question = await h.deps.chat.getMessage(done.user_message_id);
      expect(question?.text).toBe('');
      expect(question?.attachments).toEqual([
        { kind: 'chat_image', id: imageId, url: `/api/chat/images/${imageId}/display`, thumb_url: `/api/chat/images/${imageId}/thumb` },
      ]);
      const turn = imgFake.requests[0]!.turn;
      expect(turn.text).toContain(`[image upload:${imageId}]`);
      expect(turn.images.map((i) => [i.id, i.messageId])).toEqual([[imageId, done.user_message_id]]);
    } finally {
      await h.close();
    }
  });
});
