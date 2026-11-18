import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { TitleCandidate, TitleLibrary } from '../../src/directStream/lookup.js';
import type { CheckResult } from '../../src/directStream/subtitleCheck/checker.js';
import { CheckError } from '../../src/directStream/subtitleCheck/subjects.js';
import type { StreamRef } from '../../src/directStream/types.js';
import type { DirectStreamToolDeps } from '../../src/mcp/directStreamTools.js';
import { CHECK_ANSWER_MS, registerSubtitleCheckTools, sessionIdOf, SUBTITLE_CHECK_OFF, type SubtitleCheckApi, type SubtitleCheckToolDeps } from '../../src/mcp/subtitleCheckTools.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');
const json = (r: ToolResult): any => JSON.parse(text(r));

const SALTBURN: TitleCandidate = { kind: 'movie', tmdbId: 930564, title: 'Saltburn', originalTitle: 'Saltburn', year: 2023, movieId: 'M-5A1T' };
const THE_BEAR: TitleCandidate = { kind: 'tv', tmdbId: 136315, title: 'The Bear', originalTitle: 'The Bear', year: 2022, movieId: 'M-0BEA' };
const SESSION = 'PAhM8Lh_Quy1ETptJPTuy2KkKWhtHAcy';

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
    play: vi.fn(),
    freshSource: async () => null,
    marks: async () => new Map(),
    freshTitles: async () => new Set<string>(),
    dialogue: vi.fn(),
    providers: vi.fn(async () => []),
    updateSource: vi.fn(),
  };
}

function result(over: Partial<CheckResult> = {}): CheckResult {
  return {
    verdict: 'ok',
    changed: false,
    title: 'Saltburn',
    mode: 'live',
    source: 'torrent',
    provider: 'Torrent',
    session_id: SESSION,
    heard: { task: 'transcribe', lines: 82, windows: [] },
    current: null,
    tried: [],
    chosen: null,
    notes: [],
    took_s: 38,
    ...over,
  };
}

function fake(over: Partial<SubtitleCheckApi> = {}) {
  const check = vi.fn<SubtitleCheckApi['check']>(async () => result());
  const api: SubtitleCheckApi = { onScreen: () => null, check, ...over };
  return { deps: { lookup: lookup(), check: api } satisfies SubtitleCheckToolDeps, check: api.check as typeof check };
}

async function connect(subtitleCheck: SubtitleCheckToolDeps | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSubtitleCheckTools(server, { subtitleCheck, wallUrl: 'http://localhost:7317' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (args: Record<string, unknown>) => (await client.callTool({ name: 'direct_stream_sync_subtitle', arguments: args })) as ToolResult,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('sessionIdOf', () => {
  it('reads an id from the id itself or from the player page address', () => {
    expect(sessionIdOf(SESSION)).toBe(SESSION);
    expect(sessionIdOf('http://localhost:7317/stream/' + SESSION)).toBe(SESSION);
    expect(sessionIdOf('http://localhost:7317/stream/' + SESSION + '/?muted=1')).toBe(SESSION);
    expect(sessionIdOf('http://localhost:7317/movies/M-NT38')).toBeNull();
  });
});

describe('direct_stream_sync_subtitle', () => {
  it('is registered with a full description, and answers subtitle_check_off without the check', async () => {
    const c = await connect(null);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['direct_stream_sync_subtitle']);
    expect(tools[0]?.description?.length ?? 0).toBeGreaterThan(400);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(false);
    const off = await c.call({});
    expect(off.isError).toBe(true);
    expect(text(off)).toBe(SUBTITLE_CHECK_OFF);
    await c.close();
  });

  it('checks a session named by its player page address', async () => {
    const f = fake();
    const c = await connect(f.deps);
    const out = json(await c.call({ session: 'http://localhost:7317/stream/' + SESSION }));
    expect(f.check).toHaveBeenCalledWith({ session: SESSION }, CHECK_ANSWER_MS);
    expect(out).toMatchObject({ verdict: 'ok', changed: false });
    expect(out.next).toContain('Nothing was changed');
    await c.close();
  });

  it('checks the stream on screen when nothing is named, and says so when nothing plays', async () => {
    const on: { sessionId: string; ref: StreamRef } = { sessionId: SESSION, ref: { kind: 'movie', tmdbId: 930564 } };
    const live = fake({ onScreen: () => on });
    const a = await connect(live.deps);
    await a.call({});
    expect(live.check).toHaveBeenCalledWith({ session: SESSION }, CHECK_ANSWER_MS);
    await a.close();
    const idle = fake();
    const b = await connect(idle.deps);
    expect(json(await b.call({}))).toMatchObject({ skipped: 'nothing_playing' });
    expect(idle.check).not.toHaveBeenCalled();
    await b.close();
  });

  it('checks a title by name, an episode by season and episode, with the source asked for', async () => {
    const f = fake();
    const c = await connect(f.deps);
    await c.call({ title: 'saltburn', year: 2023 });
    expect(f.check).toHaveBeenLastCalledWith({ ref: { kind: 'movie', tmdbId: 930564 } }, CHECK_ANSWER_MS);
    await c.call({ title: 'the bear', season: 2, episode: 3, source: 'cloud' });
    expect(f.check).toHaveBeenLastCalledWith({ ref: { kind: 'tv', tmdbId: 136315, season: 2, episode: 3 }, source: 'cloud' }, CHECK_ANSWER_MS);
    await c.close();
  });

  it('takes a series named without an episode as the episode on screen, and asks for one otherwise', async () => {
    const on: { sessionId: string; ref: StreamRef } = { sessionId: SESSION, ref: { kind: 'tv', tmdbId: 136315, season: 1, episode: 4 } };
    const live = fake({ onScreen: () => on });
    const a = await connect(live.deps);
    await a.call({ title: 'the bear' });
    expect(live.check).toHaveBeenCalledWith({ session: SESSION }, CHECK_ANSWER_MS);
    await a.close();
    const idle = fake();
    const b = await connect(idle.deps);
    expect(json(await b.call({ title: 'the bear' }))).toMatchObject({ skipped: 'needs_episode' });
    await b.close();
  });

  it('says what changed, by verdict and mode', async () => {
    const chosen = { from: 'wyzie', name: 'Show.S01E02.WEB', label: 'English (checked)', retimed: false, shift_s: null, stretch: null, url: '/x.vtt' };
    const f = fake({ check: async () => result({ verdict: 'replaced', changed: true, mode: 'idle', chosen }) });
    const c = await connect(f.deps);
    const out = json(await c.call({ title: 'saltburn' }));
    expect(out.next).toContain('replaced by chosen.from');
    expect(out.next).toContain('the next play of it on this machine starts with it');
    await c.close();
  });

  it('passes a pending check on with what to do next', async () => {
    const f = fake({ check: async () => ({ pending: true, since: '2026-11-18T16:00:00.000Z', waited_s: 45, stage: 'trying other subtitles (2 so far)' }) });
    const c = await connect(f.deps);
    const out = json(await c.call({ title: 'saltburn' }));
    expect(out).toMatchObject({ pending: true, stage: 'trying other subtitles (2 so far)' });
    expect(out.next).toContain('exactly the same arguments');
    await c.close();
  });

  it('answers a session that ended, and a title with no audio here, as errors', async () => {
    const gone = fake({ check: async () => Promise.reject(new CheckError('unknown_session', 'No live stream session has this id.')) });
    const a = await connect(gone.deps);
    const out = await a.call({ session: SESSION });
    expect(out.isError).toBe(true);
    expect(json(out)).toMatchObject({ error: 'unknown_session' });
    await a.close();
    const f = fake();
    const b = await connect(f.deps);
    expect(json(await b.call({ session: 'not an id!' }))).toMatchObject({ error: 'invalid_input' });
    await b.close();
  });
});
