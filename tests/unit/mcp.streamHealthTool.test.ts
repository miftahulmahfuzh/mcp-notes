import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { readHealth, type PlayLogReader, type StreamHealthReader } from '../../src/directStream/playLog/health.js';
import { streamHealthRoutes } from '../../src/http/streamHealthApi.js';
import { registerStreamHealthTool } from '../../src/mcp/streamHealthTool.js';
import { NOW, SEED } from '../helpers/playLogRows.js';

const body = async (res: Response): Promise<any> => res.json();
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const json = (r: ToolResult): any => JSON.parse(r.content.map((c) => c.text ?? '').join('\n'));

function readerOf(rows = SEED): StreamHealthReader {
  const log: PlayLogReader = { healthRows: async () => rows, firstAskedAt: async () => null, unhandled: async () => [] };
  return { read: (days) => readHealth(log, 'pc', days, NOW) };
}

async function connect(reader: StreamHealthReader | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerStreamHealthTool(server, { streamHealth: reader, wallUrl: 'http://localhost:7317' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (args: Record<string, unknown>) => (await client.callTool({ name: 'direct_stream_health', arguments: args })) as ToolResult,
    list: async () => (await client.listTools()).tools,
  };
}

const deps = { db: {} as never, movies: null };

describe('direct_stream_health and GET /api/stream/health', () => {
  it('answer the same figures', async () => {
    const reader = readerOf();
    const app = streamHealthRoutes(deps, { reader });
    const res = await app.request('/api/stream/health?days=30');
    expect(res.status).toBe(200);
    const route = await body(res);
    const tool = json(await (await connect(reader)).call({ days: 30 }));
    const { link, next, ...figures } = tool;
    expect(figures).toEqual(route);
    expect(link).toBe('http://localhost:7317/movies/health');
    expect(next).toContain('success_rate');
    expect(route.days).toBe(30);
    expect(route.totals.torrent.success_rate).toBe(0.5);
  });

  it('defaults to 7 days and refuses a period outside 1 to 90', async () => {
    const app = streamHealthRoutes(deps, { reader: readerOf() });
    expect((await body(await app.request('/api/stream/health'))).days).toBe(7);
    for (const bad of ['0', '91', '2.5', 'week']) {
      const res = await app.request(`/api/stream/health?days=${bad}`);
      expect(res.status).toBe(400);
      expect((await body(res)).error).toBe('invalid_query');
    }
  });

  it('says nothing was played when nothing is logged', async () => {
    const body = json(await (await connect(readerOf([]))).call({}));
    expect(body.totals.all).toMatchObject({ asks: 0, median_first_frame_ms: null });
    expect(body.next).toBe('Say nothing was played on this machine in the last 7 days.');
  });

  it('is read-only, and answers direct_stream_off without the movie library', async () => {
    const c = await connect(null);
    const tools = await c.list();
    expect(tools.find((t) => t.name === 'direct_stream_health')?.annotations?.readOnlyHint).toBe(true);
    const r = await c.call({});
    expect(r.isError).toBe(true);
    expect(json(r).error).toBe('direct_stream_off');
    const res = await streamHealthRoutes(deps).request('/api/stream/health');
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe('direct_stream_off');
  });
});
