import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentChatBackend, type QueryFn } from '../../src/chat/agent.js';
import type { ChatBackend } from '../../src/chat/backend.js';
import { DEFAULT_CHAT_CONFIG } from '../../src/config.js';
import { chatImageRoutes } from '../../src/http/chatImages.js';
import { ID_PATTERN } from '../../src/notes/ids.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse } from './helpers/sse.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

const MSG_ID = /^[0-9A-Z]{4}$/;
type Done = { thread_id: string; user_message_id: string; assistant_message_id: string; reply_to: string | null; brain?: string };
const doneOf = (body: string): Done => {
  const last = parseSse(body).at(-1);
  if (last?.event !== 'done') throw new Error(`expected done, got ${JSON.stringify(last)}`);
  return last.data as Done;
};

interface WireChatImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  original_name: string | null;
  host: string | null;
  source: string;
  created_at: string;
  available: boolean;
  urls: Record<'original' | 'display' | 'thumb' | 'preview', string>;
}
interface UploadBody {
  image: WireChatImage;
  created: boolean;
}

let h: Harness;
let scripted: ScriptedChatBackend;
/** What POST /api/chat talks to; a test may swap in the real agent backend over a fake `query`. */
let backend: ChatBackend;

beforeAll(async () => {
  scripted = createScriptedChatBackend();
  backend = scripted;
  const chat: ChatBackend = { reply: (request) => backend.reply(request) };
  h = await startHarness({ chat });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  backend = scripted;
  await h.reset();
});

async function upload(bytes: Buffer, name: string, type: string, app: Hono = h.app): Promise<Response> {
  const fd = new FormData();
  fd.append('file', new File([bytes], name, { type }));
  return app.request('/api/chat/images', { method: 'POST', body: fd });
}

async function uploaded(rgb = { r: 200, g: 10, b: 10 }): Promise<WireChatImage> {
  const res = await upload(await makeImage('png', 40, 30, rgb), 'shot.png', 'image/png');
  expect(res.status).toBe(201);
  return ((await res.json()) as UploadBody).image;
}

async function originalOf(id: string): Promise<string> {
  const res = await h.deps.db.execute<{ path: string }>(sql`select path from chat_images where id = ${id}`);
  const rel = res.rows[0]?.path;
  if (rel === undefined) throw new Error(`no chat image ${id}`);
  return path.join(h.dataDir, rel);
}

function postChat(payload: unknown): Promise<Response> {
  return Promise.resolve(
    h.app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

function successMessage(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: 'sess-int',
    uuid: '00000000-0000-4000-8000-000000000000',
  } as unknown as SDKMessage;
}

describe('chat_images schema', () => {
  it('keeps sha256 and path unique and source to wall | claude_code', async () => {
    const insert = (id: string, sha: string, p: string, source: string) =>
      h.deps.db.execute(
        sql`insert into chat_images (id, path, sha256, mime, width, height, bytes, source)
            values (${id}, ${p}, ${sha}, 'image/png', 1, 1, 1, ${source})`,
      );
    await insert('A-AAA', 'a'.repeat(64), 'chat-images/2026/10/A-AAA.png', 'wall');
    await expect(insert('B-BBB', 'a'.repeat(64), 'chat-images/2026/10/B-BBB.png', 'wall')).rejects.toThrow();
    await expect(insert('C-CCC', 'c'.repeat(64), 'chat-images/2026/10/A-AAA.png', 'wall')).rejects.toThrow();
    await expect(insert('D-DDD', 'd'.repeat(64), 'chat-images/2026/10/D-DDD.png', 'web')).rejects.toThrow();
    await insert('E-EEE', 'e'.repeat(64), 'chat-images/2026/10/E-EEE.png', 'claude_code');
    const created = await h.deps.db.execute<{ ok: boolean }>(
      sql`select created_at is not null as ok from chat_images where id = 'E-EEE'`,
    );
    expect(created.rows[0]?.ok).toBe(true);
  });
});

describe('POST /api/chat/images', () => {
  it('stores a pasted image as a chat image (201), never as a note', async () => {
    const png = await makeImage('png', 40, 30, { r: 200, g: 10, b: 10 });
    const res = await upload(png, 'shot.png', 'image/png');
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadBody;
    expect(body.created).toBe(true);
    expect(body.image).toMatchObject({
      mime: 'image/png',
      width: 40,
      height: 30,
      bytes: png.byteLength,
      original_name: 'shot.png',
      source: 'wall',
      available: true,
    });
    expect(ID_PATTERN.test(body.image.id)).toBe(true);
    expect(body.image.urls.thumb).toBe(`/api/chat/images/${body.image.id}/thumb`);
    const abs = await originalOf(body.image.id);
    expect(path.relative(h.dataDir, abs)).toMatch(new RegExp(`^chat-images/\\d{4}/\\d{2}/${body.image.id}\\.png$`));
    expect(Buffer.compare(await readFile(abs), png)).toBe(0);
    const counts = await h.deps.db.execute<{ notes: number; images: number }>(
      sql`select (select count(*) from notes)::int as notes, (select count(*) from note_images)::int as images`,
    );
    expect(counts.rows[0]).toEqual({ notes: 0, images: 0 });
  });

  it('returns the stored row (200) for the same bytes, and heals a missing original', async () => {
    const png = await makeImage('png', 40, 30, { r: 1, g: 2, b: 3 });
    const first = (await (await upload(png, 'a.png', 'image/png')).json()) as UploadBody;
    const abs = await originalOf(first.image.id);
    await rm(abs);
    const res = await upload(png, 'b.png', 'image/png');
    expect(res.status).toBe(200);
    const again = (await res.json()) as UploadBody;
    expect(again.created).toBe(false);
    expect(again.image.id).toBe(first.image.id);
    expect(again.image.original_name).toBe('a.png');
    expect(again.image.available).toBe(true);
    expect(Buffer.compare(await readFile(abs), png)).toBe(0);
  });

  it('two concurrent uploads of the same bytes make one row', async () => {
    const png = await makeImage('png', 20, 20, { r: 9, g: 9, b: 9 });
    const [a, b] = await Promise.all([upload(png, 'a.png', 'image/png'), upload(png, 'b.png', 'image/png')]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const ja = (await a.json()) as UploadBody;
    const jb = (await b.json()) as UploadBody;
    expect(ja.image.id).toBe(jb.image.id);
    const n = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from chat_images`);
    expect(n.rows[0]?.n).toBe(1);
  });

  it('records the optional source field: wall by default, claude_code from the paste hook', async () => {
    const withSource = (bytes: Buffer, source: string): Promise<Response> => {
      const fd = new FormData();
      fd.append('file', new File([bytes], 'pasted-image-1.png', { type: 'image/png' }));
      fd.append('source', source);
      return Promise.resolve(h.app.request('/api/chat/images', { method: 'POST', body: fd }));
    };
    const wall = await uploaded({ r: 10, g: 20, b: 30 });
    expect(wall.source).toBe('wall');
    const res = await withSource(await makeImage('png', 16, 16, { r: 200, g: 20, b: 30 }), 'claude_code');
    expect(res.status).toBe(201);
    const pasted = ((await res.json()) as UploadBody).image;
    expect(pasted.source).toBe('claude_code');
    const row = await h.deps.db.execute<{ source: string }>(sql`select source from chat_images where id = ${pasted.id}`);
    expect(row.rows[0]?.source).toBe('claude_code');

    const bad = await withSource(await makeImage('png', 16, 16, { r: 1, g: 1, b: 1 }), 'browser');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_source');
    const n = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from chat_images`);
    expect(n.rows[0]?.n).toBe(2);
  });

  it('refuses a file that is not an image (415) and an empty file (415)', async () => {
    const txt = await upload(Buffer.from('hello, not an image'), 'a.txt', 'text/plain');
    expect(txt.status).toBe(415);
    expect(await txt.json()).toMatchObject({ error: 'not_an_image' });
    const empty = await upload(Buffer.alloc(0), 'e.png', 'image/png');
    expect(empty.status).toBe(415);
    const n = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from chat_images`);
    expect(n.rows[0]?.n).toBe(0);
  });

  it('refuses a file over the cap (413)', async () => {
    const small = new Hono().route('/', chatImageRoutes(h.deps, { maxUploadBytes: 1024 }));
    const res = await upload(Buffer.alloc(4096, 7), 'big.png', 'image/png', small);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'too_large', max_bytes: 1024 });
  });

  it('needs a file field (400)', async () => {
    const fd = new FormData();
    fd.append('other', 'x');
    const res = await h.app.request('/api/chat/images', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'file_required' });
  });
});

describe('GET /api/chat/images/:id[/variant]', () => {
  it('serves the metadata and every variant; derivatives go to cache/c_<id>/', async () => {
    const image = await uploaded();
    const meta = await h.app.request(`/api/chat/images/${image.id.toLowerCase().replace('-', '')}`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual(image);

    const thumb = await h.app.request(`/api/chat/images/${image.id}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(thumb.headers.get('x-content-type-options')).toBe('nosniff');
    expect(existsSync(path.join(h.dataDir, 'cache', `c_${image.id}`, 'thumb.webp'))).toBe(true);
    expect(existsSync(path.join(h.dataDir, 'cache', image.id))).toBe(false);

    const preview = await h.app.request(`/api/chat/images/${image.id}/preview`);
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
    expect(existsSync(path.join(h.dataDir, 'cache', `c_${image.id}`, 'preview.jpg'))).toBe(true);

    const original = await h.app.request(`/api/chat/images/${image.id}/original`);
    expect(original.status).toBe(200);
    expect(original.headers.get('content-type')).toBe('image/png');
    expect(original.headers.get('content-disposition')).toContain('shot.png');
    expect(original.headers.get('cache-control')).toContain('immutable');
    const etag = original.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const notModified = await h.app.request(`/api/chat/images/${image.id}/original`, { headers: { 'if-none-match': etag ?? '' } });
    expect(notModified.status).toBe(304);

    const display = await h.app.request(`/api/chat/images/${image.id}/display`);
    expect(display.headers.get('content-type')).toBe('image/png');
  });

  it('404s an unknown or malformed id', async () => {
    expect((await h.app.request('/api/chat/images/Z-ZZZ')).status).toBe(404);
    expect((await h.app.request('/api/chat/images/Z-ZZZ/thumb')).status).toBe(404);
    expect((await h.app.request('/api/chat/images/not-an-id/thumb')).status).toBe(404);
  });

  it('answers not_on_this_machine when the original is missing here', async () => {
    const image = await uploaded();
    await rm(await originalOf(image.id));
    const res = await h.app.request(`/api/chat/images/${image.id}/thumb`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine' });
    const meta = (await (await h.app.request(`/api/chat/images/${image.id}`)).json()) as WireChatImage;
    expect(meta.available).toBe(false);
  });
});

describe('POST /api/chat with image_ids', () => {
  it('hands the resolved images to the backend, previews derived under cache/c_<id>/', async () => {
    const image = await uploaded();
    scripted.push({ steps: [{ type: 'delta', text: 'red' }] });
    const res = await postChat({ message: 'what is it?', image_ids: [image.id.toLowerCase().replace('-', '')] });
    expect(res.status).toBe(200);
    const done = doneOf(await res.text());
    expect(done.user_message_id).toMatch(MSG_ID);
    expect(done.assistant_message_id).toMatch(MSG_ID);
    const req = scripted.requests.at(-1);
    expect(req?.turn.text).toContain('what is it?');
    expect(req?.turn.text).toContain(`[image upload:${image.id}]`);
    const previewPath = path.join(h.dataDir, 'cache', `c_${image.id}`, 'preview.jpg');
    expect(req?.turn.images).toEqual([
      { id: image.id, previewPath, previewMime: 'image/jpeg', width: 40, height: 30, originalName: 'shot.png', messageId: done.user_message_id },
    ]);
    expect(existsSync(previewPath)).toBe(true);
  });

  it('accepts images with no text, and dedupes repeated ids', async () => {
    const image = await uploaded();
    scripted.push({ steps: [] });
    const res = await postChat({ image_ids: [image.id, image.id.toLowerCase()] });
    expect(res.status).toBe(200);
    await res.text();
    const req = scripted.requests.at(-1);
    expect(req?.turn.images.map((i) => i.id)).toEqual([image.id]);
  });

  it('a text-only message carries no images', async () => {
    scripted.push({ steps: [] });
    const res = await postChat({ message: 'hello' });
    await res.text();
    expect(scripted.requests.at(-1)?.turn.images).toEqual([]);
  });

  it('rejects, as JSON before any stream: no text and no images, too many images, unknown ids, missing originals', async () => {
    const before = scripted.requests.length;
    for (const payload of [{ message: '' }, { message: '  ', image_ids: [] }]) {
      const res = await postChat(payload);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    }
    const five = await postChat({ message: 'x', image_ids: ['A-AAA', 'B-BBB', 'C-CCC', 'D-DDD', 'E-EEE'] });
    expect(five.status).toBe(400);

    const unknown = await postChat({ message: 'x', image_ids: ['Z-ZZZ'] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_image', id: 'Z-ZZZ' });

    const image = await uploaded();
    await rm(await originalOf(image.id));
    const gone = await postChat({ message: 'x', image_ids: [image.id] });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ error: 'not_on_this_machine', id: image.id });
    expect(scripted.requests.length).toBe(before);
  });
});

describe('the agent backend sends pasted images to the model', () => {
  function agentWith(prompts: Array<Parameters<QueryFn>[0]['prompt']>): ChatBackend {
    const query: QueryFn = (params) => {
      prompts.push(params.prompt);
      return (async function* () {
        yield successMessage();
      })();
    };
    return createAgentChatBackend({
      chat: { ...DEFAULT_CHAT_CONFIG, claudeBin: '/opt/claude/bin/claude', glm: null },
      cwd: path.join(h.dataDir, 'chat'),
      mcpUrl: () => 'http://127.0.0.1:9/mcp',
      query,
      log: () => {},
    });
  }

  it('composes one user message: the preview as an image block, then the text with [image upload:ID]', async () => {
    const image = await uploaded();
    const prompts: Array<Parameters<QueryFn>[0]['prompt']> = [];
    backend = agentWith(prompts);
    const res = await postChat({ message: 'what colour is this?', image_ids: [image.id] });
    expect(res.status).toBe(200);
    expect(doneOf(await res.text()).brain).toBe('claude');
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    if (prompt === undefined || typeof prompt === 'string') throw new Error('expected a user-message stream');
    const sent: SDKUserMessage[] = [];
    for await (const m of prompt) sent.push(m);
    expect(sent).toHaveLength(1);
    const content = sent[0]?.message.content;
    if (!Array.isArray(content)) throw new Error('expected content blocks');
    const preview = await readFile(path.join(h.dataDir, 'cache', `c_${image.id}`, 'preview.jpg'));
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: preview.toString('base64') },
    });
    const text = content[1];
    expect(text?.type).toBe('text');
    const body = text?.type === 'text' ? text.text : '';
    expect(body).toContain('what colour is this?');
    expect(body).toMatch(new RegExp(`\\n\\nThe picture shown above is:\\n\\[image upload:${image.id}\\] from \\[msg:[0-9A-Z]{4}\\]$`));
  });

  it('a text-only message still reaches the SDK as a plain string', async () => {
    const prompts: Array<Parameters<QueryFn>[0]['prompt']> = [];
    backend = agentWith(prompts);
    const res = await postChat({ message: 'hello' });
    await res.text();
    expect(prompts).toHaveLength(1);
    expect(typeof prompts[0]).toBe('string');
    expect(prompts[0]).toContain('<message>');
    expect(prompts[0]).toContain('hello');
  });
});
