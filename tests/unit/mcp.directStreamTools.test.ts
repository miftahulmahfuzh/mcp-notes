import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_STREAM_TOOL_NAMES } from '../../src/chat/status.js';
import type { SeasonCount, StreamTarget, TitleCandidate, TitleLibrary } from '../../src/directStream/lookup.js';
import { DirectStreamError } from '../../src/directStream/types.js';
import type { AppDeps } from '../../src/deps.js';
import { DIRECT_STREAM_OFF, directStreamToolDeps, registerDirectStreamTools, type DirectStreamToolDeps, type FreshSource } from '../../src/mcp/directStreamTools.js';
import type { TmdbClient, TmdbSearchHit } from '../../src/movies/tmdb.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');
const json = (r: ToolResult): any => JSON.parse(text(r));

const SALTBURN: TitleCandidate = { kind: 'movie', tmdbId: 930564, title: 'Saltburn', originalTitle: 'Saltburn', year: 2023, movieId: 'M-5A1T' };
const THE_BEAR: TitleCandidate = { kind: 'tv', tmdbId: 136315, title: 'The Bear', originalTitle: 'The Bear', year: 2022, movieId: 'M-0BEA' };

const hit = (over: Partial<TmdbSearchHit> & Pick<TmdbSearchHit, 'title' | 'tmdbId'>): TmdbSearchHit => ({
  kind: 'movie', originalTitle: over.title, releaseDate: null, year: null, overview: '', posterPath: null, popularity: 1, ...over,
});

function fakeDeps(over: Partial<DirectStreamToolDeps> & { stored?: TitleCandidate[]; seasons?: SeasonCount[]; tmdbMovies?: TmdbSearchHit[] } = {}) {
  const stored = over.stored ?? [SALTBURN, THE_BEAR];
  const library: TitleLibrary = {
    search: async (_name, kind) => stored.filter((t) => kind === null || t.kind === kind),
    byKey: async (kind, tmdbId) => stored.find((t) => t.kind === kind && t.tmdbId === tmdbId) ?? null,
    byMovieId: async (id) => (id === 'M-0E23' ? { kind: 'tv' as const, tmdbId: 136315, episode: { season: 2, episode: 3 } } : null),
    seasons: async () => over.seasons ?? [{ season: 1, episodes: 8 }, { season: 2, episodes: 10 }],
  };
  const tmdb = { searchMovie: async () => over.tmdbMovies ?? [], searchTv: async () => [], tvDetails: async () => ({ episodes: [] }) } as unknown as TmdbClient;
  const play = vi.fn<(t: StreamTarget) => Promise<unknown>>(async () => ({ session_id: 's1', source: { provider: 'VidFast', subtitles: [{ lang: 'en' }] } }));
  const freshSource = vi.fn<(t: StreamTarget) => Promise<FreshSource | null>>(async () => null);
  const deps: DirectStreamToolDeps = { library, tmdb, play, freshSource, ...over };
  return { deps, play: deps.play as typeof play, freshSource: deps.freshSource as typeof freshSource };
}

async function connect(directStream: DirectStreamToolDeps | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerDirectStreamTools(server, { directStream, wallUrl: 'http://localhost:7317' });
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

describe('direct-stream MCP tools', () => {
  it('registers every DIRECT_STREAM_TOOL_NAMES name (phase 8 adds two); find is read-only, play is not', async () => {
    const c = await connect(fakeDeps().deps);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...DIRECT_STREAM_TOOL_NAMES].sort());
    expect(tools.find((t) => t.name === 'direct_stream_find')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'direct_stream_play')?.annotations?.readOnlyHint).toBe(false);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(200);
    await c.close();
  });

  it('answers direct_stream_off from both tools without the service, and starts nothing', async () => {
    const c = await connect(null);
    for (const [name, args] of [
      ['direct_stream_find', { title: 'saltburn' }],
      ['direct_stream_play', { title: 'saltburn' }],
    ] as const) {
      const r = await c.call(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(DIRECT_STREAM_OFF);
    }
    await c.close();
  });

  it('builds no tool deps while direct streaming or the movie library is off', () => {
    const base = { db: {}, movies: { tmdb: null, host: 'h', repo: {} }, directStream: { play: vi.fn() }, config: { directStream: { enabled: true, freshDays: 7 } } };
    expect(directStreamToolDeps({ ...base, directStream: null } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps({ ...base, movies: null } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps({ ...base, config: { directStream: { enabled: false, freshDays: 7 } } } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps({ ...base, config: {} } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps(base as unknown as AppDeps)).not.toBeNull();
  });

  it('direct_stream_play starts exactly one matching film through the service', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'saltburn' }));
    expect(f.play.mock.calls).toEqual([[{ kind: 'movie', tmdbId: 930564 }]]);
    expect(out).toMatchObject({ started: true, title: { title: 'Saltburn', year: 2023, movie_id: 'M-5A1T', url: 'http://localhost:7317/movies/M-5A1T' }, play: { session_id: 's1' } });
    await c.close();
  });

  it('direct_stream_play starts a named episode, by season and episode or by its movie id', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 2, episode: 3 })).started).toBe(true);
    expect(json(await c.call('direct_stream_play', { title: 'M-0E23' })).started).toBe(true);
    expect(f.play.mock.calls).toEqual([[{ kind: 'tv', tmdbId: 136315, season: 2, episode: 3 }], [{ kind: 'tv', tmdbId: 136315, season: 2, episode: 3 }]]);
    await c.close();
  });

  it('lists the candidates and starts nothing when several titles match', async () => {
    const f = fakeDeps({ stored: [], tmdbMovies: [hit({ title: 'Dune', tmdbId: 841, year: 1984 }), hit({ title: 'Dune', tmdbId: 438631, year: 2021, popularity: 9 })] });
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'dune' }));
    expect(out).toMatchObject({ started: false, skipped_play: 'several_matches' });
    expect(out.candidates.map((x: any) => [x.title, x.year])).toEqual([['Dune', 2021], ['Dune', 1984]]);
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('lists the seasons and starts nothing for a series without an episode', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'the bear' }));
    expect(out).toMatchObject({ started: false, skipped_play: 'series', title: { title: 'The Bear' }, seasons: [{ season: 1, episodes: 8 }, { season: 2, episodes: 10 }] });
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 2 })).skipped_play).toBe('series');
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('answers no_source with each provider outcome when no provider resolves, and nothing starts', async () => {
    const attempts = [
      { provider: 'VidFast', outcome: 'no_stream', took_s: 35, detail: '' },
      { provider: 'Videasy', outcome: 'bot_check', took_s: 4, detail: 'Just a moment' },
      { provider: 'VidLink', outcome: 'skipped_browser_only', took_s: 0, detail: '' },
    ];
    const f = fakeDeps({ play: vi.fn(async () => { throw new DirectStreamError('no_source', 'No provider could stream TMDB movie 930564.', { attempts: attempts as never }); }) });
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn', year: 2023 });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'no_source', started: false, title: { title: 'Saltburn' }, attempts });
    await c.close();
  });

  it('answers a resolve that could not run with its code and reason, and nothing starts', async () => {
    const f = fakeDeps({ play: vi.fn(async () => { throw new DirectStreamError('resolve_failed', 'chrome.exe was not found', { reason: 'no_chrome' }); }) });
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'resolve_failed', reason: 'no_chrome', started: false, title: { title: 'Saltburn' }, attempts: [] });
    await c.close();
  });

  it('refuses a season or episode for a film', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn', season: 1, episode: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_input: Saltburn \(2023\) is a film/);
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('direct_stream_find says per match whether this host has a fresh verified source, and never plays', async () => {
    const verifiedAt = new Date('2026-11-14T10:00:00Z');
    const f = fakeDeps({
      freshSource: vi.fn(async (t: StreamTarget) => (t.kind === 'movie' ? { provider: 'VidFast', manifestKind: 'hls', bestHeight: 2160, enSubtitle: true, verifiedAt } : null)),
    });
    const c = await connect(f.deps);
    const film = json(await c.call('direct_stream_find', { title: 'saltburn' }));
    expect(film).toMatchObject({ status: 'one', matches: [{ title: 'Saltburn', stream: { verified: true, provider: 'VidFast', best_height: 2160, en_subtitle: true, verified_at: verifiedAt.toISOString() } }] });
    const series = json(await c.call('direct_stream_find', { title: 'the bear' }));
    expect(series.matches[0].stream.verified).toBeNull();
    const episode = json(await c.call('direct_stream_find', { title: 'M-0E23' }));
    expect(episode.matches[0]).toMatchObject({ episode: { season: 2, episode: 3 }, stream: { verified: false } });
    expect(json(await c.call('direct_stream_find', { title: 'nothing like it' }))).toMatchObject({ status: 'none', matches: [] });
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });
});
