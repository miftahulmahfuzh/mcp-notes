import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { allowedChatTools, WARP_TOOL_NAME } from '../../src/chat/status.js';
import { registerWarpTool, WARP_OFF } from '../../src/mcp/warpTool.js';
import type { WarpSwitch } from '../../src/streaming/warp.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function connect(warp: WarpSwitch | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerWarpTool(server, { warp });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (args: Record<string, unknown>) => (await client.callTool({ name: WARP_TOOL_NAME, arguments: args })) as ToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');

describe('the warp MCP tool', () => {
  it('reads by default and switches on and off only when asked', async () => {
    const sw = { status: vi.fn(async () => ({ ok: true, warp: 'disconnected' as const, ssid: 'Employee' })), set: vi.fn(async (on: boolean) => ({ ok: true, warp: on ? ('connected' as const) : ('disconnected' as const), ssid: 'Employee', changed: true })) };
    const c = await connect(sw);
    expect(JSON.parse(text(await c.call({})))).toEqual({ ok: true, warp: 'disconnected', ssid: 'Employee' });
    expect(sw.set).not.toHaveBeenCalled();
    expect(JSON.parse(text(await c.call({ action: 'on' })))).toMatchObject({ warp: 'connected', changed: true });
    expect(sw.set).toHaveBeenCalledWith(true);
    await c.call({ action: 'off' });
    expect(sw.set).toHaveBeenLastCalledWith(false);
    await c.close();
  });

  it('answers warp_off without a switch', async () => {
    const c = await connect(null);
    const r = await c.call({ action: 'status' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(WARP_OFF);
    await c.close();
  });

  it('is one of the chat bar\'s tools', () => {
    expect(allowedChatTools()).toContain(`mcp__notes__${WARP_TOOL_NAME}`);
  });
});
