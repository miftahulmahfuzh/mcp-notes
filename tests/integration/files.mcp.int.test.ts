import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function firstText(r: ToolResult): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

describe('MCP sees note files', () => {
  let h: Harness;
  let client: Client;

  beforeAll(async () => {
    h = await startHarness();
    const base = await h.listen();
    client = new Client({ name: 'p4-files-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  afterAll(async () => {
    await client.close();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function attach(noteId: string, bytes: Buffer, name: string): Promise<void> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name));
    const res = await h.app.request(`/api/notes/${noteId}/${name.endsWith('.png') ? 'images' : 'files'}`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
  }

  it('get and list return each note with its files (name, mime, bytes)', async () => {
    await insertTextNote(h, 'A-B32', 'quarterly');
    await attach('A-B32', Buffer.from('a,b\n1,2\n'), 'q3.csv');
    const got = JSON.parse(firstText(await call('get', { ids: ['A-B32'] }))) as { notes: Note[] };
    expect(got.notes[0]!.files).toEqual([
      expect.objectContaining({ name: 'q3.csv', mime: 'text/csv', bytes: 8, extraction_status: 'none', available: true }),
    ]);
    const listed = JSON.parse(firstText(await call('list', {}))) as { notes: Note[] };
    expect(listed.notes.find((n) => n.id === 'A-B32')!.files.map((f) => f.name)).toEqual(['q3.csv']);
  });

  it('view_images names the files of a text note and of an image note', async () => {
    await insertTextNote(h, 'A-B32', 'text with a file');
    await attach('A-B32', Buffer.from('hello'), 'notes.txt');
    const text = await call('view_images', { ids: ['A-B32'] });
    expect(firstText(text)).toContain('files: notes.txt (text/plain, 5 B)');
    expect(firstText(text)).toContain('(text note: it has no image)');

    await insertTextNote(h, 'C-D45', 'photo with a file');
    await attach('C-D45', await makeImage('png', 8, 8, { r: 5, g: 5, b: 5 }), 'p.png');
    await attach('C-D45', Buffer.from('%PDF-1.4\n'), 'spec.pdf');
    const pic = await call('view_images', { ids: ['C-D45'] });
    expect(firstText(pic)).toMatch(/files: spec\.pdf \(application\/pdf, \d+ B\)/);
  });
});
