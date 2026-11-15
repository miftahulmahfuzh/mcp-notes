import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_STREAM_OFF, registerDirectStreamTools } from '../../src/mcp/directStreamTools.js';
import type { UpdateSourceAnswer } from '../../src/directStream/updateSource.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type RegisterDeps = Parameters<typeof registerDirectStreamTools>[1];

const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');

async function connect(directStream: unknown) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerDirectStreamTools(server, { directStream } as RegisterDeps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const ADDED: UpdateSourceAnswer = {
  ok: true,
  site: 'https://ww6-fmovies.com/',
  scripts_read: 40,
  found: 25,
  added: [{ name: 'Fresh', movie: 'https://fresh.example/movie/{id}', tv: null, renamed_from: null, resolves: false, probes: [] }],
  known: [{ name: 'VidFast', registry_name: 'VidFast' }],
  skipped: [],
};

describe('direct-stream registry tools', () => {
  it('registers direct_stream_sources read-only and direct_stream_update_source as a write', async () => {
    const c = await connect(null);
    const { tools } = await c.client.listTools();
    const sources = tools.find((t) => t.name === 'direct_stream_sources');
    const update = tools.find((t) => t.name === 'direct_stream_update_source');
    expect(sources?.annotations?.readOnlyHint).toBe(true);
    expect(update?.annotations?.readOnlyHint).toBe(false);
    for (const t of [sources, update]) expect(t?.description?.length ?? 0).toBeGreaterThan(200);
    await c.close();
  });

  it('answers direct_stream_off from both without a service', async () => {
    const c = await connect(null);
    for (const [name, args] of [
      ['direct_stream_sources', {}],
      ['direct_stream_update_source', { site: 'https://ww6-fmovies.com/' }],
    ] as const) {
      const r = await c.call(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(DIRECT_STREAM_OFF);
    }
    await c.close();
  });

  it('direct_stream_update_source passes the address and returns the report, failures included', async () => {
    const updateSource = vi
      .fn<(site: string) => Promise<UpdateSourceAnswer>>()
      .mockResolvedValueOnce(ADDED)
      .mockResolvedValueOnce({ ok: false, site: 'https://cf.example/', error: 'bot_check', detail: 'HTTP 403', registry_changed: false });
    const c = await connect({ updateSource, providers: vi.fn() });
    const ok = await c.call('direct_stream_update_source', { site: '  https://ww6-fmovies.com/ ' });
    expect(updateSource).toHaveBeenNthCalledWith(1, 'https://ww6-fmovies.com/');
    expect(JSON.parse(text(ok))).toEqual(ADDED);
    const refused = await c.call('direct_stream_update_source', { site: 'https://cf.example/' });
    expect(refused.isError).not.toBe(true);
    expect(JSON.parse(text(refused))).toMatchObject({ ok: false, error: 'bot_check', registry_changed: false });
    await c.close();
  });

  it('refuses an address that is not http or https, and calls nothing', async () => {
    const updateSource = vi.fn();
    const c = await connect({ updateSource, providers: vi.fn() });
    for (const site of ['not a url', 'ftp://ww6-fmovies.com/']) {
      expect((await c.call('direct_stream_update_source', { site })).isError).toBe(true);
    }
    expect(updateSource).not.toHaveBeenCalled();
    await c.close();
  });

  it('direct_stream_sources returns the registry with its count', async () => {
    const providers = vi.fn(async () => [{ name: 'VidFast' }, { name: 'Fresh' }]);
    const c = await connect({ providers, updateSource: vi.fn() });
    expect(JSON.parse(text(await c.call('direct_stream_sources', {})))).toEqual({ count: 2, providers: [{ name: 'VidFast' }, { name: 'Fresh' }] });
    await c.close();
  });
});
