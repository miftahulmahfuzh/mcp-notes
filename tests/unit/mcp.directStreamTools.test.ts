import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_STREAM_TOOL_NAMES } from '../../src/chat/status.js';
import type { EpisodeProgress } from '../../src/directStream/episodePick.js';
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

const ep = (season: number, episode: number, state: EpisodeProgress['state'] = 'unwatched', lastPlayedAt: string | null = null, airDate: string | null = '2022-06-23'): EpisodeProgress => ({
  season, episode, state, lastPlayedAt, airDate,
});

function fakeDeps(
  over: Partial<DirectStreamToolDeps> & { stored?: TitleCandidate[]; seasons?: SeasonCount[]; tmdbMovies?: TmdbSearchHit[]; tmdbTv?: TmdbSearchHit[]; tmdbEpisodes?: { season: number; episode: number; airDate: string | null }[] } = {},
) {
  const stored = over.stored ?? [SALTBURN, THE_BEAR];
  const library: TitleLibrary = {
    search: async (_name, kind) => stored.filter((t) => kind === null || t.kind === kind),
    byKey: async (kind, tmdbId) => stored.find((t) => t.kind === kind && t.tmdbId === tmdbId) ?? null,
    byMovieId: async (id) => (id === 'M-0E23' ? { kind: 'tv' as const, tmdbId: 136315, episode: { season: 2, episode: 3 } } : null),
    seasons: async () => over.seasons ?? [{ season: 1, episodes: 8 }, { season: 2, episodes: 10 }],
  };
  const tmdb = {
    searchMovie: async () => over.tmdbMovies ?? [],
    searchTv: async () => over.tmdbTv ?? [],
    tvDetails: vi.fn(async () => ({ episodes: over.tmdbEpisodes ?? [] })),
  } as unknown as TmdbClient;
  const play = vi.fn<(t: StreamTarget) => Promise<unknown>>(async () => ({ session_id: 's1', source: { provider: 'VidFast', subtitles: [{ lang: 'en' }] } }));
  const freshSource = vi.fn<(t: StreamTarget) => Promise<FreshSource | null>>(async () => null);
  const rememberAlias = vi.fn<(c: TitleCandidate, name: string) => Promise<boolean>>(async () => true);
  const deps: DirectStreamToolDeps = {
    library,
    tmdb,
    play,
    freshSource,
    progress: async () => [],
    rememberAlias,
    now: () => new Date('2026-11-16T03:00:00Z'),
    providers: vi.fn(async () => []),
    updateSource: vi.fn(),
    ...over,
  };
  return { deps, tmdb, play: deps.play as typeof play, freshSource: deps.freshSource as typeof freshSource, rememberAlias: deps.rememberAlias as typeof rememberAlias };
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

  it('starts a series named without an episode at season 1, episode 1 when nothing was played', async () => {
    const f = fakeDeps({ progress: async () => [ep(0, 1), ep(1, 1), ep(1, 2)] });
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'the bear' }));
    expect(out).toMatchObject({ started: true, season: 1, episode: 1, picked: 'first', title: { title: 'The Bear', title_key: 'tv-136315' } });
    expect(f.play.mock.calls).toEqual([[{ kind: 'tv', tmdbId: 136315, season: 1, episode: 1 }]]);
    await c.close();
  });

  it('carries a series on: the unfinished episode played last, else the one after the last finished', async () => {
    const resume = fakeDeps({ progress: async () => [ep(1, 1, 'finished', '2026-11-10T12:00:00.000Z'), ep(1, 2, 'in_progress', '2026-11-11T12:00:00.000Z'), ep(1, 3)] });
    let c = await connect(resume.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear' }))).toMatchObject({ started: true, season: 1, episode: 2, picked: 'resume' });
    await c.close();

    // Season 1 is done: the next one is the first episode of season 2. An older half-watched episode is not gone back to.
    const next = fakeDeps({ progress: async () => [ep(1, 1, 'in_progress', '2026-11-01T12:00:00.000Z'), ep(1, 2, 'finished', '2026-11-11T12:00:00.000Z'), ep(2, 1)] });
    c = await connect(next.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear' }))).toMatchObject({ started: true, season: 2, episode: 1, picked: 'next' });
    expect(next.play.mock.calls).toEqual([[{ kind: 'tv', tmdbId: 136315, season: 2, episode: 1 }]]);
    await c.close();
  });

  it('asks TMDB for newer episodes before saying a series is caught up, and says when the next one has not aired', async () => {
    const played = [ep(1, 1, 'finished', '2026-11-10T12:00:00.000Z'), ep(1, 2, 'finished', '2026-11-11T12:00:00.000Z')];
    const newer = fakeDeps({ progress: async () => played, tmdbEpisodes: [{ season: 1, episode: 2, airDate: '2026-10-16' }, { season: 1, episode: 3, airDate: '2026-11-13' }] });
    let c = await connect(newer.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear' }))).toMatchObject({ started: true, season: 1, episode: 3, picked: 'next' });
    await c.close();

    const waiting = fakeDeps({ progress: async () => played, tmdbEpisodes: [{ season: 1, episode: 3, airDate: '2026-11-20' }] });
    c = await connect(waiting.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear' }))).toMatchObject({ started: false, skipped_play: 'not_aired', season: 1, episode: 3, air_date: '2026-11-20' });
    expect(waiting.play).not.toHaveBeenCalled();
    await c.close();

    const done = fakeDeps({ progress: async () => played });
    c = await connect(done.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear' }))).toMatchObject({ started: false, skipped_play: 'caught_up', last: { season: 1, episode: 2 }, seasons: [{ season: 1, episodes: 8 }, { season: 2, episodes: 10 }] });
    expect(done.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('reads TMDB only when the stored episodes do not decide, and refuses half an episode', async () => {
    const f = fakeDeps({ progress: async () => [ep(1, 1, 'finished', '2026-11-10T12:00:00.000Z'), ep(1, 2)] });
    const c = await connect(f.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear' }))).toMatchObject({ started: true, season: 1, episode: 2 });
    expect(f.tmdb.tvDetails).not.toHaveBeenCalled();
    const r = await c.call('direct_stream_play', { title: 'the bear', season: 2 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_input: The Bear \(2022\) is a series: pass both season and episode/);
    await c.close();
  });

  it('lists near misses on no_match, and remembers the name the owner used once they pick one', async () => {
    const mafia = hit({ kind: 'tv', title: 'Doctor X: Mafia in White', tmdbId: 293610, year: 2026 });
    const f = fakeDeps({ stored: [], tmdbTv: [mafia] });
    const c = await connect(f.deps);
    const miss = json(await c.call('direct_stream_play', { title: 'Doctor X: Age of the White Mafia', kind: 'tv' }));
    expect(miss).toMatchObject({ started: false, skipped_play: 'no_match', did_you_mean: [{ title: 'Doctor X: Mafia in White', year: 2026, kind: 'tv', title_key: 'tv-293610' }] });
    expect(f.play).not.toHaveBeenCalled();
    expect(f.rememberAlias).not.toHaveBeenCalled();
    expect(json(await c.call('direct_stream_find', { title: 'Doctor X: Age of the White Mafia', kind: 'tv' }))).toMatchObject({ status: 'none', matches: [], did_you_mean: [{ title_key: 'tv-293610' }] });

    const out = json(await c.call('direct_stream_play', { title: 'tv-293610', asked_as: 'Doctor X: Age of the White Mafia' }));
    expect(out).toMatchObject({ started: true, season: 1, episode: 1, picked: 'first', remembered_as: 'Doctor X: Age of the White Mafia' });
    expect(f.rememberAlias.mock.calls).toEqual([[expect.objectContaining({ kind: 'tv', tmdbId: 293610 }), 'Doctor X: Age of the White Mafia']]);
    await c.close();
  });

  it('does not store the name a title already has', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'movie-930564', asked_as: 'saltburn' }));
    expect(out.started).toBe(true);
    expect(out.remembered_as).toBeUndefined();
    expect(f.rememberAlias).not.toHaveBeenCalled();
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
