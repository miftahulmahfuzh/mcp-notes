import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_TOOL_NAMES } from '../../../src/connectors/names.js';
import { registerSeerCurated } from '../../../src/connectors/seer/curated.js';
import type { SeerLeaderboard } from '../../../src/connectors/seer/leaderboard.js';
import { ConnectorError, type Connector, type QueryResult } from '../../../src/connectors/types.js';

const EMPTY: QueryResult = { columns: [], rows: [], row_count: 0, truncated: false };

function stub(query: Connector['query'], lab?: Connector['lab']): Connector {
  const c: Connector = { id: 'seer', label: 'seer', query };
  if (lab !== undefined) c.lab = lab;
  return c;
}

async function connect(connector: Connector): Promise<Client> {
  const server = new McpServer({ name: 'seer-curated-test', version: '0.0.0' });
  registerSeerCurated(server, connector);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'seer-curated-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function text(result: unknown): string {
  const first = (result as CallToolResult).content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describe('registerSeerCurated', () => {
  it('registers exactly the three curated seer tools from the contract', async () => {
    const client = await connect(stub(async () => EMPTY));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CONNECTOR_TOOL_NAMES.seer.slice(2)].sort());
    const sera = tools.find((t) => t.name === 'seer_sera_best');
    expect(sera?.description).toContain('AS OF THE RUN DATE');
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('returns an empty, unranked board when Seer has no data', async () => {
    const client = await connect(stub(async () => EMPTY));
    const result = (await client.callTool({ name: 'seer_leaderboard', arguments: {} })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const board = JSON.parse(text(result)) as SeerLeaderboard;
    expect(board.window).toBeNull();
    expect(board.ranked).toEqual([]);
    expect(board.not_ranked).toEqual([]);
  });

  it('turns a connector failure into a tool error', async () => {
    const client = await connect(
      stub(async () => {
        throw new ConnectorError('seer is not reachable: no .env.local');
      }),
    );
    const result = (await client.callTool({ name: 'seer_leaderboard', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('seer is not reachable: no .env.local');
  });

  it('fails soft when the lab is not available', async () => {
    const client = await connect(stub(async () => EMPTY));
    const result = (await client.callTool({ name: 'seer_sera_best', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('seer is not reachable: lab.sqlite is not available');
  });

  it('names the known strategies when asked for an unknown one', async () => {
    const strategies: QueryResult = {
      columns: ['id', 'name', 'engine', 'is_benchmark', 'status', 'sort', 'equity_usd', 'last_session', 'pending_session', 'pending_decision'],
      rows: [['A', 'A · Quant', 'bracket', false, 'active', 2, null, null, null, false]],
      row_count: 1,
      truncated: false,
    };
    const client = await connect(stub(async () => strategies));
    const result = (await client.callTool({ name: 'seer_positions', arguments: { strategy: 'NOPE' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('seer has no strategy "NOPE"; known ids: A');
  });
});
