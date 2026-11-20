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
    marks: async () => new Map(),
    freshTitles: async () => new Set<string>(),
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

  it('direct_stream_play answers a play that outlasted its wait as pending, not as an error and not with silence', async () => {
    const attempts = [{ provider: 'Index: yts', outcome: 'error', took_s: 6, detail: 'timed out after 6 s' }];
    const f = fakeDeps({ play: vi.fn(async () => ({ pending: true, since: '2026-11-16T20:49:31.000Z', waited_s: 45, stage: 'opening 3 torrents: A; B; C', attempts })) });
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn', provider: 'torrent' });
    expect(r.isError).not.toBe(true);
    const out = json(r);
    expect(out).toMatchObject({ started: false, pending: true, title: { title: 'Saltburn' }, since: '2026-11-16T20:49:31.000Z', waited_s: 45, stage: 'opening 3 torrents: A; B; C', attempts });
    expect(out.next).toMatch(/call direct_stream_play again with exactly the same arguments/);
    expect(out).not.toHaveProperty('play');
    await c.close();
  });

  it("direct_stream_play says when the play came from this machine's cache", async () => {
    const f = fakeDeps({
      play: vi.fn(async () => ({ page_url: 'http://localhost:7317/stream/s1', session: { session_id: 's1', provider: 'HyperLink', cached: { id: 'c1', state: 'ready', height: 720 } }, attempts: [] })),
    });
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'saltburn' }));
    expect(out.play.session.cached).toEqual({ id: 'c1', state: 'ready', height: 720 });
    expect(out.next).toContain("from this machine's cache (no provider was asked)");
    await c.close();
    const plain = await connect(fakeDeps().deps);
    expect(json(await plain.call('direct_stream_play', { title: 'saltburn' })).next).not.toContain('cache');
    await plain.close();
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
    const r = await c.call('direct_stream_play', { title: 'the bear', episode: 2 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_input: The Bear \(2022\) is a series: pass the season with the episode/);
    await c.close();
  });

  it('starts a season named without an episode at its first unfinished episode, and a finished season again at its first', async () => {
    // Season 1 was marked finished and never played; season 2 is untouched.
    const marked = fakeDeps({ progress: async () => [ep(1, 1, 'finished'), ep(1, 2, 'finished'), ep(2, 1), ep(2, 2)] });
    let c = await connect(marked.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 2 }))).toMatchObject({ started: true, season: 2, episode: 1, picked: 'first' });
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 1 }))).toMatchObject({ started: true, season: 1, episode: 1, picked: 'first' });
    expect(marked.tmdb.tvDetails).toHaveBeenCalledTimes(1);
    await c.close();

    const partway = fakeDeps({ progress: async () => [ep(2, 1, 'finished', '2026-11-10T12:00:00.000Z'), ep(2, 2, 'in_progress', '2026-11-11T12:00:00.000Z'), ep(2, 3)] });
    c = await connect(partway.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 2, provider: 'torrent' }))).toMatchObject({ started: true, season: 2, episode: 2, picked: 'resume' });
    expect(partway.play.mock.calls).toEqual([[{ kind: 'tv', tmdbId: 136315, season: 2, episode: 2 }, 'torrent']]);
    await c.close();

    // Not stored: TMDB's list names the season's episodes. A season no list holds starts nothing.
    const listed = fakeDeps({ tmdbEpisodes: [{ season: 1, episode: 1, airDate: '2022-08-21' }, { season: 2, episode: 1, airDate: '2024-06-16' }, { season: 3, episode: 1, airDate: '2027-01-01' }] });
    c = await connect(listed.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 2 }))).toMatchObject({ started: true, season: 2, episode: 1, picked: 'first' });
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 3 }))).toMatchObject({ started: false, skipped_play: 'not_aired', season: 3, episode: 1, air_date: '2027-01-01' });
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 9 }))).toMatchObject({ started: false, skipped_play: 'no_such_season', season: 9 });
    expect(listed.play).toHaveBeenCalledTimes(1);
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

  it('passes provider "torrent" through to the service, and answers torrent_off when torrents are off', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    await c.call('direct_stream_play', { title: 'saltburn', provider: 'torrent' });
    expect(f.play.mock.calls).toEqual([[{ kind: 'movie', tmdbId: 930564 }, 'torrent']]);
    await c.close();
    const off = fakeDeps({ play: vi.fn(async () => { throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).'); }) });
    const o = await connect(off.deps);
    const r = await o.call('direct_stream_play', { title: 'saltburn', provider: 'torrent' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'torrent_off', started: false, title: { title: 'Saltburn' } });
    expect(json(r).next).toContain('without provider');
    await o.close();
  });

  it('passes a pasted magnet through to the service, for the title the owner also named', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const magnet = 'magnet:?xt=urn:btih:f5ab15bfb22915770a14eca1a15e1d1dc375f83a&dn=Saltburn 2023 1080p&tr=udp://tracker.example:1337/announce';
    const out = json(await c.call('direct_stream_play', { title: 'saltburn', magnet }));
    expect(out).toMatchObject({ started: true, title: { title: 'Saltburn', movie_id: 'M-5A1T' } });
    // The target (from the named title) and the magnet reach the service; the provider slot is left empty.
    expect(f.play.mock.calls).toEqual([[{ kind: 'movie', tmdbId: 930564 }, undefined, magnet]]);
    await c.close();
  });

  it('stores audio_lang as the title\'s audio language before the play, and "original" clears it', async () => {
    const order: string[] = [];
    const setAudioLanguage = vi.fn(async (_t: StreamTarget, _l: string | null) => { order.push('set'); return true; });
    const play = vi.fn(async () => { order.push('play'); return { session_id: 's1' }; });
    const f = fakeDeps({ setAudioLanguage, play });
    const c = await connect(f.deps);
    expect(json(await c.call('direct_stream_play', { title: 'saltburn', audio_lang: 'EN' }))).toMatchObject({ started: true });
    expect(setAudioLanguage.mock.calls).toEqual([[{ kind: 'movie', tmdbId: 930564 }, 'en']]);
    expect(order).toEqual(['set', 'play']);
    await c.call('direct_stream_play', { title: 'saltburn', audio_lang: 'original' });
    await c.call('direct_stream_play', { title: 'saltburn', audio_lang: '' });
    expect(setAudioLanguage.mock.calls.slice(1)).toEqual([[{ kind: 'movie', tmdbId: 930564 }, null], [{ kind: 'movie', tmdbId: 930564 }, null]]);
    // Without audio_lang nothing is stored.
    await c.call('direct_stream_play', { title: 'saltburn' });
    expect(setAudioLanguage).toHaveBeenCalledTimes(3);
    // A word that is not a language code starts nothing.
    const bad = await c.call('direct_stream_play', { title: 'saltburn', audio_lang: 'english' });
    expect(bad.isError).toBe(true);
    expect(json(bad)).toMatchObject({ error: 'invalid_input' });
    expect(play).toHaveBeenCalledTimes(4);
    await c.close();
  });

  it('starts nothing when the audio language cannot be stored', async () => {
    const f = fakeDeps({ setAudioLanguage: vi.fn(async () => false) });
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn', audio_lang: 'en' });
    expect(r.isError).toBe(true);
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('passes provider "cloud" through (NTM, NTS: never a torrent), and its no_source says no torrent was tried', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    expect(json(await c.call('direct_stream_play', { title: 'saltburn', provider: 'cloud' }))).toMatchObject({ started: true });
    expect(f.play.mock.calls).toEqual([[{ kind: 'movie', tmdbId: 930564 }, 'cloud']]);
    await c.close();
    const none = fakeDeps({ play: vi.fn(async () => { throw new DirectStreamError('no_source', 'No provider could stream it.', { attempts: [{ provider: 'Alpha', outcome: 'no_stream', took_s: 2, detail: '' }] }); }) });
    const n = await connect(none.deps);
    const r = await n.call('direct_stream_play', { title: 'saltburn', provider: 'Cloud' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'no_source', started: false, attempts: [{ provider: 'Alpha' }] });
    expect(json(r).next).toContain('no torrent was tried');
    await n.close();
  });

  it('names the six codenames in the play tool, so every client reads them', async () => {
    const c = await connect(fakeDeps().deps);
    const { tools } = await c.client.listTools();
    const play = tools.find((t) => t.name === 'direct_stream_play')?.description ?? '';
    for (const word of ['TM', 'TS', 'NTM', 'NTS', 'DM', 'DS']) expect(play).toMatch(new RegExp(`\\b${word}\\b`));
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

  describe('absolute episode numbers', () => {
    const range = (season: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ep(season, from + i, 'unwatched', null, '2001-01-01'));
    const ONE_PIECE: TitleCandidate = { kind: 'tv', tmdbId: 37854, title: 'One Piece', originalTitle: 'ワンピース', year: 1999, movieId: 'M-0P1E' };

    it('maps "episode 730" to the season and episode TMDB lists and says which was chosen', async () => {
      const f = fakeDeps({ stored: [ONE_PIECE], progress: async () => [...range(1, 1, 61), ...range(2, 62, 700), ...range(3, 701, 800)] });
      const c = await connect(f.deps);
      const out = json(await c.call('direct_stream_play', { title: 'one piece', absolute_episode: 730 }));
      expect(out).toMatchObject({ started: true, season: 3, episode: 730, picked: 'absolute', absolute_episode: 730 });
      expect(out.next).toMatch(/episode 730 counted from the first/);
      expect(f.play.mock.calls).toEqual([[{ kind: 'tv', tmdbId: 37854, season: 3, episode: 730 }]]);
      await c.close();
    });

    it('reads TMDB\'s list when the series is not stored, and counts over seasons that restart at 1', async () => {
      const listed = [...range(1, 1, 8), ...range(2, 1, 10)].map((e) => ({ season: e.season, episode: e.episode, airDate: e.airDate }));
      const f = fakeDeps({ tmdbEpisodes: listed });
      const c = await connect(f.deps);
      expect(json(await c.call('direct_stream_play', { title: 'the bear', absolute_episode: 11 }))).toMatchObject({ started: true, season: 2, episode: 3, picked: 'absolute' });
      await c.close();
    });

    it('lists both readings and starts nothing when they differ; says so when the series is shorter or the episode has not aired', async () => {
      const f = fakeDeps({ progress: async () => [...range(1, 1, 8), ...range(2, 1, 10), ep(3, 1, 'unwatched', null, '2027-01-01')] });
      const c = await connect(f.deps);
      expect(json(await c.call('direct_stream_play', { title: 'the bear', absolute_episode: 9 }))).toMatchObject({
        started: false,
        skipped_play: 'episode_unclear',
        candidates: [
          { season: 2, episode: 1, reading: 'count', air_date: '2001-01-01' },
          { season: 2, episode: 9, reading: 'number' },
        ],
      });
      expect(json(await c.call('direct_stream_play', { title: 'the bear', absolute_episode: 19 }))).toMatchObject({ started: false, skipped_play: 'not_aired', season: 3, episode: 1, air_date: '2027-01-01' });
      expect(json(await c.call('direct_stream_play', { title: 'the bear', absolute_episode: 400 }))).toMatchObject({ started: false, skipped_play: 'no_such_episode', episodes: 19 });
      expect(f.play).not.toHaveBeenCalled();
      await c.close();
    });

    it('refuses an absolute episode for a film, or together with a season and episode', async () => {
      const f = fakeDeps();
      const c = await connect(f.deps);
      expect(text(await c.call('direct_stream_play', { title: 'saltburn', absolute_episode: 3 }))).toMatch(/^invalid_input: Saltburn \(2023\) is a film/);
      expect(text(await c.call('direct_stream_play', { title: 'the bear', season: 1, episode: 2, absolute_episode: 3 }))).toMatch(/^invalid_input: pass absolute_episode alone/);
      expect(f.play).not.toHaveBeenCalled();
      await c.close();
    });
  });

  describe('direct_stream_discover', () => {
    const discoverTmdb = (over: Record<string, unknown> = {}) => {
      const discover = vi.fn(async (kind: 'movie' | 'tv', _filter: unknown) =>
        kind === 'tv'
          ? [
              hit({ kind: 'tv', title: 'Old Hit', tmdbId: 1, releaseDate: '2026-01-10', popularity: 90, originalLanguage: 'es', overview: 'A hit.' }),
              hit({ kind: 'tv', title: 'New One', originalTitle: 'La Nueva', tmdbId: 2, releaseDate: '2026-09-01', popularity: 20, originalLanguage: 'es' }),
            ]
          : [hit({ title: 'A Film', tmdbId: 3, releaseDate: '2026-05-05', popularity: 50, originalLanguage: 'es' })],
      );
      const searchCompany = vi.fn(async () => [
        { id: 7, name: 'Blumhouse Television', country: 'US' },
        { id: 3172, name: 'Blumhouse Productions', country: 'US' },
        { id: 8, name: 'Blumhouse', country: null },
      ]);
      const watchProviders = vi.fn(async () => [
        { id: 8, name: 'Netflix', country: null },
        { id: 204, name: 'Shudder Amazon Channel', country: null },
        { id: 99, name: 'Shudder', country: null },
      ]);
      const tmdb = {
        searchMovie: async () => [],
        searchTv: async () => [],
        searchPerson: vi.fn(async () => [
          { personId: 85, name: 'Johnny Depp', knownFor: 'Acting', profilePath: null, popularity: 30 },
          { personId: 86, name: 'Johnny Deep', knownFor: 'Crew', profilePath: null, popularity: 1 },
        ]),
        personCredits: vi.fn(async () => [
          { kind: 'movie', tmdbId: 10, title: 'Newest', releaseDate: '2026-03-01', year: 2026, posterPath: null, popularity: 5, credit: 'cast', character: 'Jack', job: null, department: null, episodeCount: null, originalLanguage: 'en' },
          { kind: 'movie', tmdbId: 11, title: 'Classic', releaseDate: '2003-07-09', year: 2003, posterPath: null, popularity: 80, credit: 'cast', character: 'Sparrow', job: null, department: null, episodeCount: null, originalLanguage: 'en' },
          { kind: 'movie', tmdbId: 12, title: 'Directed', releaseDate: '2024-01-01', year: 2024, posterPath: null, popularity: 9, credit: 'crew', character: null, job: 'Director', department: 'Directing', episodeCount: null, originalLanguage: 'en' },
          { kind: 'movie', tmdbId: 13, title: 'Not Out Yet', releaseDate: '2027-02-02', year: 2027, posterPath: null, popularity: 99, credit: 'cast', character: null, job: null, department: null, episodeCount: null },
          { kind: 'movie', tmdbId: 14, title: 'Undated', releaseDate: null, year: null, posterPath: null, popularity: 99, credit: 'cast', character: null, job: null, department: null, episodeCount: null },
          { kind: 'tv', tmdbId: 15, title: 'A Series', releaseDate: '2010-01-01', year: 2010, posterPath: null, popularity: 3, credit: 'cast', character: null, job: null, department: null, episodeCount: 2 },
        ]),
        discover,
        searchCompany,
        watchProviders,
        genres: vi.fn(async (kind: 'movie' | 'tv') =>
          kind === 'movie'
            ? [{ id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }, { id: 27, name: 'Horror' }, { id: 878, name: 'Science Fiction' }]
            : [{ id: 10759, name: 'Action & Adventure' }, { id: 35, name: 'Comedy' }, { id: 10765, name: 'Sci-Fi & Fantasy' }],
        ),
        searchKeyword: vi.fn(async (query: string) =>
          query === 'mafia'
            ? [{ id: 10391, name: 'mafia', country: null }, { id: 155538, name: 'sicilian mafia', country: null }, { id: 1, name: 'mafiaboss', country: null }]
            : query === 'gangster'
              ? [{ id: 3149, name: 'gangster', country: null }]
              : [],
        ),
        ...over,
      } as unknown as NonNullable<DirectStreamToolDeps['tmdb']>;
      return { tmdb, discover, searchCompany, watchProviders };
    };

    it('lists Spanish series of this year, most popular first, marked against the library and this host\'s verified sources', async () => {
      const t = discoverTmdb();
      const f = fakeDeps({
        tmdb: t.tmdb,
        marks: async () => new Map([['tv-1', { movieId: 'M-0LD1', state: 'finished' as const, notInterested: false, interested: false }]]),
        freshTitles: async () => new Set(['tv-2']),
      });
      const c = await connect(f.deps);
      const out = json(await c.call('direct_stream_discover', { kind: 'tv', language: 'Spanish', year: 2026 }));
      expect(t.discover.mock.calls).toEqual([['tv', { dateFrom: '2026-01-01', dateTo: '2026-11-16', originalLanguage: 'es', genreIds: null, keywordIds: null, companyIds: null, providerId: null, watchRegion: 'US', sort: 'popular' }]]);
      expect(out.filters).toMatchObject({ kind: 'tv', released_from: '2026-01-01', released_to: '2026-11-16', language: 'es', sort: 'popular' });
      expect(out.titles).toEqual([
        {
          kind: 'tv', tmdb_id: 1, title_key: 'tv-1', movie_id: 'M-0LD1', title: 'Old Hit', release_date: '2026-01-10', original_language: 'es', overview: 'A hit.',
          in_library: true, state: 'finished', seen: true, started: false, not_interested: false, interested: false, stream: { verified: false },
          url: 'http://localhost:7317/movies/M-0LD1', tmdb_url: 'https://www.themoviedb.org/tv/1',
        },
        {
          kind: 'tv', tmdb_id: 2, title_key: 'tv-2', movie_id: null, title: 'New One', original_title: 'La Nueva', release_date: '2026-09-01', original_language: 'es',
          in_library: false, state: null, seen: false, started: false, not_interested: false, interested: false, stream: { verified: true },
          url: null, tmdb_url: 'https://www.themoviedb.org/tv/2',
        },
      ]);
      expect(out.next).toMatch(/Nothing was started/);
      const unseen = json(await c.call('direct_stream_discover', { kind: 'tv', language: 'es', unseen_only: true, sort: 'newest' }));
      expect(unseen.titles.map((x: any) => x.title_key)).toEqual(['tv-2']);
      // Choosing for the owner: what they have seen is not in the list at all, and is counted.
      expect(unseen.left_out).toEqual({ seen: out.titles.filter((x: any) => x.seen).length, not_interested: 0 });
      expect(unseen.left_out.seen).toBeGreaterThan(0);
      expect(unseen.next).toMatch(/title\(s\) the owner has seen or marked not interested were left out/);
      // A rewatch, or a question: the same call without unseen_only still lists the seen ones, marked, and says how to choose.
      expect(out.left_out).toBeUndefined();
      expect(out.titles.some((x: any) => x.seen)).toBe(true);
      expect(out.next).toMatch(/call again with unseen_only true and choose from that list/);
      // Everything that fits was seen: nothing to choose, and the answer says a rewatch is the call without unseen_only.
      const allSeen = fakeDeps({
        tmdb: t.tmdb,
        marks: async () => new Map([['tv-1', { movieId: 'M-0LD1', state: 'finished' as const, notInterested: false, interested: false }], ['tv-2', { movieId: null, state: null, notInterested: true, interested: false }]]),
      });
      const c2 = await connect(allSeen.deps);
      const none = json(await c2.call('direct_stream_discover', { kind: 'tv', language: 'es', unseen_only: true }));
      expect(none).toMatchObject({ count: 0, titles: [], left_out: { seen: 1, not_interested: 1 } });
      expect(none.next).toMatch(/Every title that fits \(2\) is one the owner has seen or marked not interested.*a rewatch is this call without unseen_only/);
      expect(json(await c2.call('direct_stream_discover', { kind: 'tv', language: 'es' })).titles).toHaveLength(2);
      await c2.close();
      expect(f.play).not.toHaveBeenCalled();
      await c.close();
    });

    it('resolves a company and a service by name, lists the others, and takes an id to pick one', async () => {
      const t = discoverTmdb();
      const c = await connect(fakeDeps({ tmdb: t.tmdb }).deps);
      // One company is called exactly that: it alone.
      const blumhouse = json(await c.call('direct_stream_discover', { company: 'Blumhouse', year: 2026 }));
      expect(blumhouse.filters.companies).toEqual([{ id: 8, name: 'Blumhouse' }]);
      expect(blumhouse.other_companies).toEqual([
        { id: 7, name: 'Blumhouse Television', country: 'US' },
        { id: 3172, name: 'Blumhouse Productions', country: 'US' },
      ]);
      expect(t.discover.mock.calls.map((x) => [x[0], (x[1] as any).companyIds])).toEqual([['movie', [8]], ['tv', [8]]]);
      // Both kinds, merged by popularity.
      expect(blumhouse.titles.map((x: any) => x.title_key)).toEqual(['tv-1', 'movie-3', 'tv-2']);

      const picked = json(await c.call('direct_stream_discover', { company: 'Blumhouse', company_id: 3172, kind: 'movie' }));
      expect(picked.filters.companies).toEqual([{ id: 3172, name: 'Blumhouse Productions', country: 'US' }]);

      // No company is called exactly "Blumhouse" (as on TMDB): the name stands for every company that starts with it.
      const real = discoverTmdb({
        searchCompany: vi.fn(async () => [
          { id: 68884, name: 'Blumhouse Television', country: 'US' },
          { id: 3172, name: 'Blumhouse Productions', country: 'US' },
          { id: 5, name: 'Not Blumhouse', country: null },
        ]),
      });
      const rc = await connect(fakeDeps({ tmdb: real.tmdb }).deps);
      const all = json(await rc.call('direct_stream_discover', { company: 'blumhouse', kind: 'movie' }));
      expect(all.filters.companies.map((x: any) => x.id)).toEqual([68884, 3172]);
      expect(all.other_companies).toEqual([{ id: 5, name: 'Not Blumhouse' }]);
      expect((real.discover.mock.calls[0]?.[1] as any).companyIds).toEqual([68884, 3172]);
      await rc.close();

      t.discover.mockClear();
      const shudder = json(await c.call('direct_stream_discover', { kind: 'movie', service: 'shudder', sort: 'newest' }));
      expect(shudder.filters).toMatchObject({ service: { id: 99, name: 'Shudder' }, region: 'US', sort: 'newest' });
      expect(shudder.other_services).toEqual([{ id: 204, name: 'Shudder Amazon Channel' }]);
      expect(t.discover.mock.calls[0]?.[1]).toMatchObject({ providerId: 99, watchRegion: 'US', sort: 'newest' });

      const none = await c.call('direct_stream_discover', { service: 'tvN' });
      expect(none.isError).toBe(true);
      expect(text(none)).toMatch(/^not_found: TMDB lists no streaming service called "tvN" in US \(it lists Netflix, .*try company/);
      await c.close();
    });

    it('lists a person\'s released titles by role, kind, year and language, newest first when asked', async () => {
      const t = discoverTmdb();
      const c = await connect(fakeDeps({ tmdb: t.tmdb }).deps);
      const depp = json(await c.call('direct_stream_discover', { person: 'johnny depp', role: 'cast', kind: 'movie', sort: 'newest' }));
      expect(depp.filters).toMatchObject({ person: { id: 85, name: 'Johnny Depp', known_for: 'Acting' }, role: 'cast' });
      expect(depp.other_people).toEqual([{ id: 86, name: 'Johnny Deep', known_for: 'Crew' }]);
      expect(depp.titles.map((x: any) => [x.title, x.roles])).toEqual([['Newest', ['cast as Jack']], ['Classic', ['cast as Sparrow']]]);
      expect(t.discover).not.toHaveBeenCalled();
      const popular = json(await c.call('direct_stream_discover', { person: 'johnny depp' }));
      expect(popular.titles.map((x: any) => x.title)).toEqual(['Classic', 'Directed', 'Newest', 'A Series']);
      expect(json(await c.call('direct_stream_discover', { person: 'johnny depp', role: 'director' })).titles.map((x: any) => x.title)).toEqual(['Directed']);
      expect(json(await c.call('direct_stream_discover', { person: 'johnny depp', year_from: 2020, year_to: 2025 })).titles.map((x: any) => x.title)).toEqual(['Directed']);
      await c.close();
    });

    it('filters by genre, read per kind, and by keywords any of which may fit; Chinese is both of TMDB\'s codes', async () => {
      const t = discoverTmdb();
      const c = await connect(fakeDeps({ tmdb: t.tmdb }).deps);
      const action = json(await c.call('direct_stream_discover', { language: 'Chinese', genre: 'action' }));
      expect(action.filters).toMatchObject({ language: ['zh', 'cn'], genres: { movie: [{ id: 28, name: 'Action' }], tv: [{ id: 10759, name: 'Action & Adventure' }] } });
      expect(t.discover.mock.calls.map((x) => [x[0], (x[1] as any).originalLanguage, (x[1] as any).genreIds])).toEqual([['movie', 'zh|cn', [28]], ['tv', 'zh|cn', [10759]]]);

      // A genre series do not have leaves series out when films have it, and is refused for series alone.
      t.discover.mockClear();
      const horror = json(await c.call('direct_stream_discover', { genre: ['Horror', 'comedies'] }));
      expect(horror.filters.genres).toEqual({ movie: [{ id: 27, name: 'Horror' }, { id: 35, name: 'Comedy' }] });
      expect(t.discover.mock.calls.map((x) => [x[0], (x[1] as any).genreIds])).toEqual([['movie', [27, 35]]]);
      const refused = await c.call('direct_stream_discover', { kind: 'tv', genre: 'horror' });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/^invalid_input: TMDB has no series genre called "horror" \(it has Action & Adventure, Comedy, Sci-Fi & Fantasy\)\. Pass what is not a genre there as keyword/);

      t.discover.mockClear();
      const mafia = json(await c.call('direct_stream_discover', { kind: 'movie', language: 'Korean', keyword: ['mafia', 'gangster', 'nothing-like-it'], year: 2026 }));
      expect(mafia.filters.keywords).toEqual([{ id: 10391, name: 'mafia' }, { id: 155538, name: 'sicilian mafia' }, { id: 3149, name: 'gangster' }]);
      expect(mafia.filters.keywords_dropped).toBeUndefined();
      expect(t.discover.mock.calls.map((x) => (x[1] as any).keywordIds)).toEqual([[10391, 155538, 3149]]);
      await c.close();
    });

    it('lists without the keyword, and says so, when no title carries it', async () => {
      const t = discoverTmdb();
      t.discover.mockImplementation(async (_kind, filter) => ((filter as any).keywordIds === null ? [hit({ title: 'A Film', tmdbId: 3, releaseDate: '2026-05-05' })] : []));
      const c = await connect(fakeDeps({ tmdb: t.tmdb }).deps);
      const out = json(await c.call('direct_stream_discover', { kind: 'movie', keyword: 'mafia' }));
      expect(t.discover.mock.calls.map((x) => (x[1] as any).keywordIds)).toEqual([[10391, 155538], null]);
      expect(out.filters.keywords_dropped).toBe(true);
      expect(out.titles.map((x: any) => x.title)).toEqual(['A Film']);
      expect(out.next).toContain('NOT filtered');
      // A word TMDB has no keyword for goes straight to the list without it.
      t.discover.mockClear();
      const unknown = json(await c.call('direct_stream_discover', { kind: 'movie', keyword: 'zzz' }));
      expect(t.discover.mock.calls.map((x) => (x[1] as any).keywordIds)).toEqual([null]);
      expect(unknown.filters).toMatchObject({ keywords: [], keywords_dropped: true });
      await c.close();
    });

    it('filters a person\'s titles by genre, and finds a person whose name is a letter off', async () => {
      const credit = (tmdbId: number, title: string, releaseDate: string, genreIds: number[]) => ({ kind: 'movie', tmdbId, title, releaseDate, year: Number(releaseDate.slice(0, 4)), posterPath: null, popularity: 1, credit: 'cast', character: null, job: null, department: null, episodeCount: null, originalLanguage: 'cn', genreIds });
      const searchPerson = vi.fn(async (query: string) =>
        query === 'jackie chan'
          ? [{ personId: 18897, name: 'Jackie Chan', knownFor: 'Acting', profilePath: null, popularity: 20 }]
          : query === 'park bo y'
          ? [
              { personId: 7, name: 'Park Bo-yeon', knownFor: 'Acting', profilePath: null, popularity: 9 },
              { personId: 83036, name: 'Park Bo-young', knownFor: 'Acting', profilePath: null, popularity: 2 },
            ]
          : [],
      );
      const t = discoverTmdb({ searchPerson, personCredits: vi.fn(async () => [credit(1, 'Fists', '2025-08-16', [28, 80]), credit(2, 'Jokes', '2025-05-08', [35]), credit(3, 'Kicks', '2024-07-05', [28])]) });
      const c = await connect(fakeDeps({ tmdb: t.tmdb }).deps);
      const action = json(await c.call('direct_stream_discover', { person: 'jackie chan', kind: 'movie', genre: 'action', language: 'chinese', sort: 'newest' }));
      expect(action.titles.map((x: any) => [x.title, x.release_date])).toEqual([['Fists', '2025-08-16'], ['Kicks', '2024-07-05']]);

      const park = json(await c.call('direct_stream_discover', { person: 'park bo yeung', sort: 'newest' }));
      expect(searchPerson.mock.calls.map((x) => x[0]).slice(1)).toEqual(['park bo yeung', 'park bo y']);
      expect(park.other_people).toEqual([{ id: 7, name: 'Park Bo-yeon', known_for: 'Acting' }]);
      expect(park.filters.person).toEqual({ id: 83036, name: 'Park Bo-young', known_for: 'Acting', asked_as: 'park bo yeung' });
      const nobody = await c.call('direct_stream_discover', { person: 'zed zedson' });
      expect(text(nobody)).toMatch(/^not_found: TMDB knows no person named "zed zedson", nor one a letter or two away/);
      await c.close();
    });

    it('refuses what it cannot answer, and is off without the service', async () => {
      const t = discoverTmdb();
      const c = await connect(fakeDeps({ tmdb: t.tmdb }).deps);
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ person: 'johnny depp', company: 'Blumhouse' }, /^invalid_input: person cannot be combined/],
        [{ role: 'cast' }, /^invalid_input: role belongs to person/],
        [{ person: 'johnny depp', keyword: 'pirates' }, /^invalid_input: keyword cannot be combined with person/],
        [{ language: 'klingonese' }, /^invalid_input: "klingonese" is not a language/],
        [{ year_from: 2026, year_to: 2020 }, /^invalid_input: year_from is after year_to/],
      ];
      for (const [args, expected] of cases) {
        const r = await c.call('direct_stream_discover', args);
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(text(r)).toMatch(expected);
      }
      await c.close();
      const noTmdb = await connect(fakeDeps({ tmdb: null }).deps);
      expect(text(await noTmdb.call('direct_stream_discover', { kind: 'tv' }))).toMatch(/^tmdb_unavailable/);
      await noTmdb.close();
      const off = await connect(null);
      expect(text(await off.call('direct_stream_discover', { kind: 'tv' }))).toBe(DIRECT_STREAM_OFF);
      await off.close();
    });
  });
});
