import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { STREAMING_TOOL_NAMES } from '../../src/chat/status.js';
import { STREAMING_OFF, STREAMING_OTHERS_LIMIT, registerStreamingTools } from '../../src/mcp/streamingTools.js';
import { STREAMING_SITES, type StreamingRunner } from '../../src/streaming/service.js';
// @ts-expect-error -- a plain .mjs registry without type declarations
import { SITES } from '../../claude/streaming/sites/index.mjs';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function connect(streaming: StreamingRunner | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerStreamingTools(server, { streaming });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');
const json = (r: ToolResult): any => JSON.parse(text(r));

const match = (site: string) => ({ title: 'No Other Choice (2025)', kind: 'movie', year: 2025, url: `https://${site}.example/no-other-choice-2025` });

describe('streaming MCP tools', () => {
  it('knows exactly the sites the script knows', () => {
    expect([...STREAMING_SITES].sort()).toEqual(Object.keys(SITES).sort());
  });

  it('registers exactly the two names; only streaming_play is not read-only', async () => {
    const c = await connect(vi.fn(async () => ({})));
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...STREAMING_TOOL_NAMES].sort());
    expect(tools.find((t) => t.name === 'streaming_find')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'streaming_play')?.annotations?.readOnlyHint).toBe(false);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(200);
    await c.close();
  });

  it('answers streaming_off from both tools without a runner, and runs nothing', async () => {
    const c = await connect(null);
    for (const [name, args] of [
      ['streaming_find', { title: 'x' }],
      ['streaming_play', { site: 'idlix', title: 'x' }],
    ] as const) {
      const r = await c.call(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(STREAMING_OFF);
    }
    await c.close();
  });

  it('streaming_find asks every site, passes the year last, and keeps a failing site apart', async () => {
    const runner = vi.fn<StreamingRunner>(async (site) => {
      if (site === 'idlix') throw new Error('cdp_failed: no chrome');
      return { ok: true, site, matches: [match(site)], others: [] };
    });
    const c = await connect(runner);
    const out = json(await c.call('streaming_find', { title: 'no other choice', year: 2025 }));
    expect(runner.mock.calls.map(([site, args]) => [site, args])).toEqual(STREAMING_SITES.map((site) => [site, ['no other choice', '2025']]));
    expect(out.sites).toHaveLength(STREAMING_SITES.length);
    expect(out.sites.find((s: any) => s.site === 'idlix')).toEqual({ ok: false, site: 'idlix', error: 'cdp_failed: no chrome' });
    expect(out.sites.find((s: any) => s.site === 'lk21').matches[0].url).toBe('https://lk21.example/no-other-choice-2025');
    await c.close();
  });

  it('streaming_find asks one site when one is named, and never plays', async () => {
    const runner = vi.fn<StreamingRunner>(async (site) => ({ ok: true, site, matches: [], others: [] }));
    const c = await connect(runner);
    await c.call('streaming_find', { title: 'la brea', site: 'lk21' });
    expect(runner.mock.calls).toEqual([['lk21', ['la brea']]]);
    await c.close();
  });

  it('cuts the unrelated results down and says how many were left out', async () => {
    const others = Array.from({ length: STREAMING_OTHERS_LIMIT + 7 }, (_, i) => ({ title: `Other ${i}` }));
    const c = await connect(async (site) => ({ ok: true, site, matches: [], others }));
    const out = json(await c.call('streaming_find', { title: 'pilot', site: 'idlix' }));
    expect(out.sites[0].others).toHaveLength(STREAMING_OTHERS_LIMIT);
    expect(out.sites[0].others_omitted).toBe(7);
    await c.close();
  });

  it('streaming_play plays by title with --play, and by url with --play-url', async () => {
    const runner = vi.fn<StreamingRunner>(async (site) => ({ ok: true, site, play: { playing: true, fullscreen: true } }));
    const c = await connect(runner);
    expect(json(await c.call('streaming_play', { site: 'lk21', title: 'ready or not', year: 2019 })).play.playing).toBe(true);
    await c.call('streaming_play', { site: 'idlix', url: 'https://z2.idlixku.com/movie/pilot-2024', title: 'ignored' });
    expect(runner.mock.calls).toEqual([
      ['lk21', ['--play', 'ready or not', '2019']],
      ['idlix', ['--play-url', 'https://z2.idlixku.com/movie/pilot-2024']],
    ]);
    await c.close();
  });

  it('passes an episode, and its season when named, to the script; a season without an episode is left out', async () => {
    const runner = vi.fn<StreamingRunner>(async (site) => ({ ok: true, site, episode: { season: 18, episode: 787 }, play: { playing: true } }));
    const c = await connect(runner);
    expect(json(await c.call('streaming_play', { site: 'idlix', title: 'one piece', episode: 787 })).episode.season).toBe(18);
    await c.call('streaming_play', { site: 'idlix', title: 'la brea', year: 2021, season: 2, episode: 3 });
    await c.call('streaming_play', { site: 'idlix', title: 'la brea', season: 2 });
    await c.call('streaming_find', { site: 'idlix', title: 'one piece', episode: 787 });
    expect(runner.mock.calls).toEqual([
      ['idlix', ['--play', 'one piece', '--episode', '787']],
      ['idlix', ['--play', 'la brea', '2021', '--episode', '3', '--season', '2']],
      ['idlix', ['--play', 'la brea']],
      ['idlix', ['one piece', '--episode', '787']],
    ]);
    expect((await c.call('streaming_play', { site: 'idlix', title: 'x', episode: 0 })).isError).toBe(true);
    await c.close();
  });

  it('streaming_play refuses a call with neither title nor url, and an unknown site', async () => {
    const runner = vi.fn<StreamingRunner>(async () => ({}));
    const c = await connect(runner);
    const neither = await c.call('streaming_play', { site: 'idlix' });
    expect(neither.isError).toBe(true);
    expect(text(neither)).toContain('give a title or a url');
    const unknown = await c.call('streaming_play', { site: 'netflix', title: 'x' });
    expect(unknown.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    await c.close();
  });
});
