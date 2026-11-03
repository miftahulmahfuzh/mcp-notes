import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/db/client.js';
import { SESSIONS_OFF, registerSessionTools } from '../../../src/mcp/sessionTools.js';
import type { NotesService, SessionLinkResult } from '../../../src/notes/service.js';
import { NoteError } from '../../../src/notes/types.js';
import type { SessionsReadDeps } from '../../../src/sessions/readModel.js';

type LinkFn = (noteIdInput: string, nodeId: string) => Promise<SessionLinkResult | null>;

const RESULT: SessionLinkResult = {
  note_id: 'A-B32',
  node_id: 'A0-3G',
  session_id: 'sess-root',
  linked: true,
  changed: true,
  made: false,
};

async function connect(link: LinkFn, unlink: LinkFn, sessions: SessionsReadDeps | undefined) {
  const service = { linkSession: link, unlinkSession: unlink } as unknown as NotesService;
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSessionTools(server, {
    service,
    dataDir: '/nowhere',
    db: {} as Db,
    ...(sessions !== undefined ? { sessions } : {}),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function text(res: unknown): string {
  return ((res as { content: Array<{ text: string }> }).content[0] ?? { text: '' }).text;
}

const rd = { wallUrl: 'http://localhost:7317' } as SessionsReadDeps;

describe('link_note / unlink_note tools', () => {
  it('link_note gives the service the raw note id and the canonical node id, and returns its result', async () => {
    const link = vi.fn<LinkFn>(async () => RESULT);
    const { client, close } = await connect(link, vi.fn<LinkFn>(), rd);
    const res = await client.callTool({ name: 'link_note', arguments: { note_id: 'ab32', node_id: 'a03g' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual(RESULT);
    expect(link).toHaveBeenCalledWith('ab32', 'A0-3G');
    await close();
  });

  it('unlink_note returns the service result', async () => {
    const unlink = vi.fn<LinkFn>(async () => ({ ...RESULT, linked: false, changed: false }));
    const { client, close } = await connect(vi.fn<LinkFn>(), unlink, rd);
    const res = await client.callTool({ name: 'unlink_note', arguments: { note_id: 'A-B32', node_id: 'A0-3G' } });
    expect(JSON.parse(text(res))).toMatchObject({ linked: false, changed: false });
    expect(unlink).toHaveBeenCalledWith('A-B32', 'A0-3G');
    await close();
  });

  it('an unknown node answers not_found: no session', async () => {
    const { client, close } = await connect(vi.fn<LinkFn>(async () => null), vi.fn<LinkFn>(async () => null), rd);
    for (const name of ['link_note', 'unlink_note']) {
      const res = await client.callTool({ name, arguments: { note_id: 'A-B32', node_id: 'zz-zz' } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/^not_found: no session ZZ-ZZ/);
    }
    await close();
  });

  it('a malformed node id answers invalid_node_id without reaching the service', async () => {
    const link = vi.fn<LinkFn>();
    const { client, close } = await connect(link, vi.fn<LinkFn>(), rd);
    const res = await client.callTool({ name: 'link_note', arguments: { note_id: 'A-B32', node_id: 'A-B32' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^invalid_node_id:/);
    expect(link).not.toHaveBeenCalled();
    await close();
  });

  it('service errors come back as code: message', async () => {
    const link = vi.fn<LinkFn>(async () => {
      throw new NoteError('deleted', 'Note A-B32 is deleted, so it cannot be linked to a session. Call restore("A-B32") first.');
    });
    const { client, close } = await connect(link, vi.fn<LinkFn>(), rd);
    const res = await client.callTool({ name: 'link_note', arguments: { note_id: 'A-B32', node_id: 'A0-3G' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^deleted: Note A-B32 is deleted/);
    await close();
  });

  it('without the session read model both tools answer SESSIONS_OFF', async () => {
    const link = vi.fn<LinkFn>();
    const { client, close } = await connect(link, vi.fn<LinkFn>(), undefined);
    for (const name of ['link_note', 'unlink_note']) {
      const res = await client.callTool({ name, arguments: { note_id: 'A-B32', node_id: 'A0-3G' } });
      expect(res.isError).toBe(true);
      expect(text(res)).toBe(SESSIONS_OFF);
    }
    expect(link).not.toHaveBeenCalled();
    await close();
  });

  it('both tools are writes, idempotent, not destructive', async () => {
    const { client, close } = await connect(vi.fn<LinkFn>(), vi.fn<LinkFn>(), rd);
    const { tools } = await client.listTools();
    for (const name of ['link_note', 'unlink_note']) {
      const t = tools.find((x) => x.name === name);
      expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
    await close();
  });
});
