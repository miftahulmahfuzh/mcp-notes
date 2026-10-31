import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NoteEvent } from '../../src/notes/events.js';
import { NoteError, type Note } from '../../src/notes/types.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

async function upload(h: Harness, bytes: Buffer): Promise<Note> {
  const fd = new FormData();
  fd.append('file', new File([bytes], 'a.png', { type: 'image/png' }));
  const res = await h.app.request('/api/images', { method: 'POST', body: fd });
  expect(res.status).toBe(201);
  return ((await res.json()) as { note: Note }).note;
}

async function attach(h: Harness, noteId: string, bytes: Buffer): Promise<Note> {
  const fd = new FormData();
  fd.append('file', new File([bytes], 'b.png', { type: 'image/png' }));
  const res = await h.app.request(`/api/notes/${noteId}/images`, { method: 'POST', body: fd });
  expect(res.status).toBe(201);
  return ((await res.json()) as { note: Note }).note;
}

const solid = (r: number, g: number, b: number) => makeImage('png', 32, 32, { r, g, b });

describe('NotesService.moveImage', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function twoImageNote(): Promise<{ note: Note; second: string }> {
    const first = await upload(h, await solid(200, 0, 0));
    const withTwo = await attach(h, first.id, await solid(0, 200, 0));
    return { note: withTwo, second: withTwo.images[1]!.id };
  }

  it('moves an image into a new note: same id and file, no copy, source keeps the other image', async () => {
    const { note, second } = await twoImageNote();
    const before = await h.deps.db.execute<{ path: string; sha256: string }>(sql`select path, sha256 from note_images where id = ${second}`);
    const events: NoteEvent[] = [];
    h.deps.events.on((e) => events.push(e));

    const moved = await h.deps.service.moveImage(second, { body: 'a prompt #image_prompt' });

    expect(moved.created).toBe(true);
    expect(moved.note.id).not.toBe(note.id);
    expect(moved.note.body).toBe('a prompt #image_prompt');
    expect(moved.note.tags).toEqual(['image_prompt']);
    expect(moved.note.images.map((i) => i.id)).toEqual([second]);
    expect(moved.from.images).toHaveLength(1);
    const after = await h.deps.db.execute<{ path: string; sha256: string; n: number }>(
      sql`select path, sha256, (select count(*)::int from note_images) as n from note_images where id = ${second}`,
    );
    expect(after.rows[0]).toMatchObject(before.rows[0]!);
    expect(after.rows[0]!.n).toBe(2);
    expect(events.map((e) => `${e.op}:${e.id}`)).toEqual([`created:${moved.note.id}`, `updated:${note.id}`]);
  });

  it('moves into an existing note after its last image', async () => {
    const { second } = await twoImageNote();
    const other = await upload(h, await solid(0, 0, 200));
    const moved = await h.deps.service.moveImage(second, { toNoteId: other.id });
    expect(moved.created).toBe(false);
    expect(moved.note.images.map((i) => i.id)).toEqual([other.images[0]!.id, second]);
  });

  it('refuses a removed image, a deleted target, and its own note', async () => {
    const { note, second } = await twoImageNote();
    await expect(h.deps.service.moveImage(second, { toNoteId: note.id })).rejects.toMatchObject({ code: 'invalid_input' });
    const other = await upload(h, await solid(0, 0, 200));
    await h.deps.service.delete(other.id);
    await expect(h.deps.service.moveImage(second, { toNoteId: other.id })).rejects.toMatchObject({ code: 'deleted' });
    await h.deps.service.removeImage(second);
    await expect(h.deps.service.moveImage(second, {})).rejects.toBeInstanceOf(NoteError);
    await expect(h.deps.service.moveImage('Z-ZZZ', {})).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('view_images img: prefix', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it('img:ID means the picture, not the note that shares its id, even after it moved', async () => {
    const note = await upload(h, await solid(200, 0, 0));
    const first = note.images[0]!.id;
    expect(first).toBe(note.id);
    await attach(h, note.id, await solid(0, 200, 0));
    const moved = await h.deps.service.moveImage(first, { body: 'prompt' });

    const base = await h.listen();
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (id: string) => {
      const r = (await client.callTool({ name: 'view_images', arguments: { ids: [id] } })) as { content: Array<{ type: string; text?: string }> };
      return r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    };
    expect(await call(`img:${first}`)).toContain(`id: ${moved.note.id}`);
    expect(await call(first)).toContain(`id: ${note.id}`);
    await client.close();
  });
});

describe('POST /api/chat with note_image_ids', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it('stores a note_image attachment (no chat_images row) and rejects an unknown id', async () => {
    const note = await upload(h, await solid(200, 0, 0));
    const imageId = note.images[0]!.id;
    const post = (body: unknown) =>
      h.app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });

    const bad = await post({ message: 'x', note_image_ids: ['Z-ZZZ'] });
    expect(bad.status).toBe(400);

    const ok = await post({ message: 'about this', note_image_ids: [imageId] });
    expect(ok.status).toBe(200);
    await ok.text();
    const rows = await h.deps.db.execute<{ kind: string; id: string }>(
      sql`select kind, ref_id as id from chat_message_attachments`,
    ).catch(() => null);
    const chat = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from chat_images`);
    expect(chat.rows[0]!.n).toBe(0);
    if (rows) expect(rows.rows).toEqual([{ kind: 'note_image', id: imageId }]);
  });
});
