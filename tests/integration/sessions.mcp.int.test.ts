import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_TOOL_NAMES } from '../../src/chat/status.js';
import { mcpToolDeps } from '../../src/http/app.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { SESSIONS_OFF } from '../../src/mcp/sessionTools.js';
import type { SessionsReadOverrides } from '../../src/sessions/readModel.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { clearSessions, OTHER_HOST, seedGraph, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  live: async () => [{ sessionId: 'sess-b1', status: 'idle', tmux: null }],
  search: async () => ({ mode: 'hybrid', fallback: null, hits: [{ sessionId: 'sess-root', score: 0.7 }] }),
};

let h: ApiHarness;
let client: Client;
let transcript: { file: string; cleanup: () => Promise<void> };

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(name, args);
  expect(r.isError ?? false).toBe(false);
  return JSON.parse(text(r)) as T;
}

beforeAll(async () => {
  h = await createApiHarness();
  transcript = await writeTranscript();
  const server = createMcpServer(mcpToolDeps(h.deps, overrides));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'sessions-in-process', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await clearSessions(h.deps.db);
  await transcript.cleanup();
  await h.close();
});

beforeEach(async () => {
  await clearSessions(h.deps.db);
  await seedGraph(h.deps.db, transcript.file);
});

describe('session MCP tools', () => {
  it('registers exactly the read-only session tools, and the instructions explain them', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of SESSION_TOOL_NAMES) expect(names).toContain(name);
    for (const t of tools.filter((x) => (SESSION_TOOL_NAMES as readonly string[]).includes(x.name))) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
    }
    expect(client.getInstructions() ?? '').toContain('Sessions.');
  });

  it('sessions_search returns hits with wall links', async () => {
    const res = await callJson<{ mode: string; hits: Array<{ node_id: string; url: string; summary: string }> }>('sessions_search', { query: 'photo delete' });
    expect(res.mode).toBe('hybrid');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ node_id: 'A0-3G', url: 'http://localhost:7317/projects?repo=mcp-notes&node=A0-3G' });
    expect(res.hits[0]!.summary).toContain('photo delete');
  });

  it('session_get returns the detail with urls on the session, parent and children', async () => {
    const res = await callJson<{
      session: { node_id: string; url: string };
      children: Array<{ node_id: string; url: string; live: boolean }>;
      plan_docs: string[];
    }>('session_get', { node_id: 'a0-3g' });
    expect(res.session).toMatchObject({ node_id: 'A0-3G', url: 'http://localhost:7317/projects?repo=mcp-notes&node=A0-3G' });
    expect(res.children.map((c) => [c.node_id, c.live])).toEqual([
      ['B1-22', true],
      ['C2-33', false],
    ]);
    expect(res.children[0]!.url).toContain('node=B1-22');
    expect(res.plan_docs).toEqual(['docs/plans/WALL_EDITING_PLAN.md']);
  });

  it('session_get rejects note ids and unknown node ids', async () => {
    const bad = await call('session_get', { node_id: 'A-B32' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^invalid_node_id:/);
    const missing = await call('session_get', { node_id: 'ZZ-ZZ' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^not_found: no session ZZ-ZZ/);
  });

  it('session_transcript searches on the owning host and refuses another host', async () => {
    const res = await callJson<{ total_matches: number; matches: Array<{ excerpt: string }> }>('session_transcript', {
      node_id: 'A0-3G',
      query: 'recycle bin',
    });
    expect(res.total_matches).toBe(1);
    expect(res.matches[0]!.excerpt).toContain('recycle bin');

    const remote = await call('session_transcript', { node_id: 'C2-33', query: 'x' });
    expect(remote.isError).toBe(true);
    expect(text(remote)).toMatch(new RegExp(`^not_on_this_machine: session C2-33 ran on ${OTHER_HOST}`));
  });

  it('sessions_usage by node carries urls; by month defaults', async () => {
    const byNode = await callJson<{ by: string; rows: Array<{ node_id: string; url: string | null }> }>('sessions_usage', { by: 'node', limit: 2 });
    expect(byNode.rows.map((r) => r.node_id)).toEqual(['D4-44', 'A0-3G']);
    expect(byNode.rows[0]!.url).toBe('http://localhost:7317/projects?repo=seer&node=D4-44');
    const byMonth = await callJson<{ by: string; rows: Array<{ month: string }> }>('sessions_usage', {});
    expect(byMonth.by).toBe('month');
    expect(byMonth.rows.map((r) => r.month)).toEqual(['2026-11', '2026-09']);
  });

  it('answers SESSIONS_OFF when the server has no session read model', async () => {
    const deps = mcpToolDeps(h.deps, overrides);
    delete deps.sessions;
    const server = createMcpServer(deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name: 'sessions-off', version: '0.0.0' });
    await c.connect(a);
    const r = (await c.callTool({ name: 'session_get', arguments: { node_id: 'A0-3G' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(SESSIONS_OFF);
    await c.close();
  });
});
