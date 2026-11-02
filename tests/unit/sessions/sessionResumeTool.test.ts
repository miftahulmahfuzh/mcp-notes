import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerSessionResumeTool } from '../../../src/mcp/sessionTools.js';
import type { ResumeOutcome, ResumeRequest, SessionResumer } from '../../../src/sessions/resume.js';

async function connect(resumer: SessionResumer | undefined) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSessionResumeTool(server, resumer !== undefined ? { sessionResume: resumer } : {});
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

describe('session_resume tool', () => {
  it('returns the action as JSON and passes prompt / fresh through', async () => {
    const resume = vi.fn(
      async (_id: string, _req: ResumeRequest): Promise<ResumeOutcome> => ({
        status: 200,
        body: { action: 'messaged', window: 'note:1' },
      }),
    );
    const { client, close } = await connect({ resume });
    const res = await client.callTool({ name: 'session_resume', arguments: { node_id: 'a03g', prompt: 'go on' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({ action: 'messaged', window: 'note:1' });
    expect(resume).toHaveBeenCalledWith('a03g', { prompt: 'go on', fresh: undefined });
    await close();
  });

  it('not_on_this_machine names the host', async () => {
    const { client, close } = await connect({
      resume: async () => ({ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } }),
    });
    const res = await client.callTool({ name: 'session_resume', arguments: { node_id: 'A0-3G' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('not_on_this_machine: session A0-3G ran on GPD; resume it on that machine');
    await close();
  });

  it('without a resumer the tool says it is unavailable', async () => {
    const { client, close } = await connect(undefined);
    const res = await client.callTool({ name: 'session_resume', arguments: { node_id: 'A0-3G' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('not available');
    await close();
  });
});
