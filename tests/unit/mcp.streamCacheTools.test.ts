import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { CacheError, type StreamCacheView } from '../../src/directStream/cache/types.js';
import type { StreamTarget, TitleCandidate, TitleLibrary } from '../../src/directStream/lookup.js';
import { DIRECT_STREAM_OFF, type DirectStreamToolDeps } from '../../src/mcp/directStreamTools.js';
import { registerStreamCacheTool, type StreamCacheApi, type StreamCacheToolDeps } from '../../src/mcp/streamCacheTools.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');
const json = (r: ToolResult): any => JSON.parse(text(r));

const SALTBURN: TitleCandidate = { kind: 'movie', tmdbId: 930564, title: 'Saltburn', originalTitle: 'Saltburn', year: 2023, movieId: 'M-5A1T' };
const THE_BEAR: TitleCandidate = { kind: 'tv', tmdbId: 136315, title: 'The Bear', originalTitle: 'The Bear', year: 2022, movieId: 'M-0BEA' };
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function view(over: Partial<StreamCacheView> = {}): StreamCacheView {
  return {
    id: ID,
    kind: 'movie',
    tmdb_id: 930564,
    season: null,
    episode: null,
    host: 'here',
    available: true,
    state: 'downloading',
    running: true,
    queued: false,
    provider: null,
    manifest_kind: null,
    height: null,
    max_height: null,
    audio_lang: null,
    subtitle: false,
    segments_total: 0,
    segments_done: 0,
    progress: 0,
    bytes: 0,
    duration_s: null,
    resolves: 0,
    error: null,
    error_detail: null,
    auto: false,
    playlist_url: null,
    subtitle_url: null,
    created_at: '2026-11-16T00:00:00.000Z',
    updated_at: '2026-11-16T00:00:00.000Z',
    completed_at: null,
    ...over,
  };
}

function lookup(): DirectStreamToolDeps {
  const stored = [SALTBURN, THE_BEAR];
  const library: TitleLibrary = {
    search: async (_name, kind) => stored.filter((t) => kind === null || t.kind === kind),
    byKey: async (kind, tmdbId) => stored.find((t) => t.kind === kind && t.tmdbId === tmdbId) ?? null,
    byMovieId: async () => null,
    seasons: async () => [{ season: 1, episodes: 8 }],
  };
  return {
    library,
    tmdb: null,
    progress: async () => [],
    rememberAlias: async () => false,
    now: () => new Date('2026-11-16T03:00:00Z'),
    play: vi.fn(),
    freshSource: async () => null,
    marks: async () => new Map(),
    freshTitles: async () => new Set<string>(),
    providers: vi.fn(async () => []),
    updateSource: vi.fn(),
  };
}

function fakeCache(over: Partial<StreamCacheApi> = {}) {
  const request = vi.fn<StreamCacheApi['request']>(async () => ({ cache: view(), started: true }));
  const remove = vi.fn<StreamCacheApi['remove']>(async () => undefined);
  const forRef = vi.fn<StreamCacheApi['forRef']>(async () => [view()]);
  const cache: StreamCacheApi = { host: 'here', request, list: async () => [view()], get: async () => view(), forRef, remove, ...over };
  return { cache, request, remove, forRef };
}

async function connect(streamCache: StreamCacheToolDeps | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerStreamCacheTool(server, { streamCache, wallUrl: 'http://localhost:7317' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (args: Record<string, unknown>) => (await client.callTool({ name: 'direct_stream_cache', arguments: args })) as ToolResult,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('direct_stream_cache', () => {
  it('is registered with a full description and is not read-only', async () => {
    const c = await connect(null);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['direct_stream_cache']);
    expect(tools[0]?.description?.length ?? 0).toBeGreaterThan(200);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(false);
    await c.close();
  });

  it('answers direct_stream_off without the cache and starts nothing', async () => {
    const c = await connect(null);
    const r = await c.call({ action: 'start', title: 'saltburn' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(DIRECT_STREAM_OFF);
    await c.close();
  });

  it('starts a film with its max_height', async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    const r = await c.call({ action: 'start', title: 'saltburn', max_height: 720 });
    expect(r.isError).toBeFalsy();
    expect(f.request).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 930564 } satisfies StreamTarget, { maxHeight: 720 });
    expect(json(r)).toMatchObject({ started: true, title: { title: 'Saltburn', tmdb_id: 930564 }, cache: { id: ID, state: 'downloading' } });
    await c.close();
  });

  it("starts a series named without an episode on the episode a play would take", async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    const r = await c.call({ action: 'start', title: 'the bear' });
    expect(f.request).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 136315, season: 1, episode: 1 }, { maxHeight: null });
    expect(json(r)).toMatchObject({ started: true, season: 1, episode: 1, picked: 'first' });
    await c.close();
  });

  it('asks for the episode before a status of a series', async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    expect(json(await c.call({ action: 'status', title: 'the bear' }))).toMatchObject({ skipped: 'needs_episode' });
    expect(f.forRef).not.toHaveBeenCalled();
    await c.close();
  });

  it('answers cache_exists with the cache that is there', async () => {
    const f = fakeCache({
      request: async () => {
        throw new CacheError('cache_exists', 'already at 1080p', { cache: view({ state: 'ready', max_height: 1080 }) });
      },
    });
    const c = await connect({ lookup: lookup(), cache: f.cache });
    const r = await c.call({ action: 'start', title: 'saltburn', max_height: 720 });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'cache_exists', cache: { max_height: 1080 } });
    await c.close();
  });

  it("clears this machine's cache, and refuses one only the other laptop holds", async () => {
    const f = fakeCache({ forRef: async () => [view({ host: 'other', available: false, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), view()] });
    const c = await connect({ lookup: lookup(), cache: f.cache });
    expect(json(await c.call({ action: 'clear', title: 'saltburn' }))).toMatchObject({ cleared: true, id: ID });
    expect(f.remove).toHaveBeenCalledWith(ID);
    await c.close();
    const g = fakeCache({ forRef: async () => [view({ host: 'other', available: false })] });
    const d = await connect({ lookup: lookup(), cache: g.cache });
    const r = await d.call({ action: 'clear', title: 'saltburn' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'not_on_this_machine', host: 'other' });
    expect(g.remove).not.toHaveBeenCalled();
    await d.close();
  });

  it('lists every cache of both machines', async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    expect(json(await c.call({ action: 'list' }))).toMatchObject({ host: 'here', count: 1, caches: [{ id: ID }] });
    await c.close();
  });
});
