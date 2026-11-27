import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { allowedChatTools } from '../../src/chat/status.js';
import type { Db } from '../../src/db/client.js';
import { dueFrom, parseRemindArgs, registerRemindTool, REMIND_TOOL_NAME } from '../../src/mcp/remindTool.js';

const NOW = new Date('2026-11-27T01:00:00.000Z');
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

describe('parseRemindArgs', () => {
  it('add takes in_days from now, trims, and keeps a null repo when none is given', () => {
    expect(parseRemindArgs({ action: 'add', body: '  look at it  ', in_days: 7 }, NOW)).toEqual({
      action: 'add',
      body: 'look at it',
      dueAt: new Date('2026-12-04T01:00:00.000Z'),
      repo: null,
    });
    expect(parseRemindArgs({ action: 'add', body: 'x', in_days: 0, repo: ' mcp-notes ' }, NOW)).toMatchObject({ dueAt: NOW, repo: 'mcp-notes' });
  });

  it('add takes a date as local midnight and a datetime with its offset', () => {
    expect(parseRemindArgs({ action: 'add', body: 'x', due: '2026-12-04' }, NOW)).toMatchObject({ dueAt: new Date(2026, 11, 4) });
    expect(parseRemindArgs({ action: 'add', body: 'x', due: '2026-12-04T09:00:00+07:00' }, NOW)).toMatchObject({
      dueAt: new Date('2026-12-04T02:00:00.000Z'),
    });
  });

  it('add refuses a missing body, both or neither of due and in_days, a bad date, and in_days out of range', () => {
    expect(() => parseRemindArgs({ action: 'add', body: ' ', in_days: 1 }, NOW)).toThrow(/invalid_input: add needs body/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x' }, NOW)).toThrow(/exactly one of due and in_days/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', in_days: 1, due: '2026-12-04' }, NOW)).toThrow(/exactly one/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', due: '2026-02-30' }, NOW)).toThrow(/is not a date/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', due: '2026-12-04T09:00:00' }, NOW)).toThrow(/with its offset/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', in_days: -1 }, NOW)).toThrow(/in_days/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x'.repeat(2001), in_days: 1 }, NOW)).toThrow(/2000/);
  });

  it('done takes 12 or "#12" and refuses anything else', () => {
    expect(parseRemindArgs({ action: 'done', id: 12 }, NOW)).toEqual({ action: 'done', id: 12 });
    expect(parseRemindArgs({ action: 'done', id: '#12' }, NOW)).toEqual({ action: 'done', id: 12 });
    for (const id of [0, -3, 1.5, 'twelve', '', undefined]) {
      expect(() => parseRemindArgs({ action: 'done', id }, NOW)).toThrow(/invalid_input: done needs id/);
    }
  });

  it('dueFrom rejects free text', () => {
    expect(() => dueFrom('next week')).toThrow(/ISO date/);
  });
});

describe('the remind tool', () => {
  async function connect() {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    // Invalid input is refused before the database is touched, so no database is needed here.
    registerRemindTool(server, { db: {} as Db }, { now: () => NOW });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientSide);
    return { client, close: async () => (await client.close(), await server.close()) };
  }

  it('is registered as a writing tool with a description that names its actions', async () => {
    const c = await connect();
    const { tools } = await c.client.listTools();
    const tool = tools.find((t) => t.name === REMIND_TOOL_NAME);
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    for (const word of ['add', 'list', 'done', '20 hours', 'in_days']) expect(tool?.description).toContain(word);
    await c.close();
  });

  it('answers invalid_input as a tool error', async () => {
    const c = await connect();
    const r = (await c.client.callTool({ name: REMIND_TOOL_NAME, arguments: { action: 'add', body: 'x' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content.map((x) => x.text).join('')).toContain('invalid_input');
    await c.close();
  });

  it('is not one of the chat bar\'s tools', () => {
    expect(allowedChatTools()).not.toContain(`mcp__notes__${REMIND_TOOL_NAME}`);
  });
});
