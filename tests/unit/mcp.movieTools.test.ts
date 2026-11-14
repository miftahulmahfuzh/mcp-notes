import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { MOVIE_TOOL_NAMES } from '../../src/chat/status.js';
import type { Db } from '../../src/db/client.js';
import { MOVIES_OFF, registerMovieTools, type MovieToolDeps } from '../../src/mcp/movieTools.js';
import type { ContinueResult } from '../../src/movies/continue.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function fakeMovies(over: Partial<MovieToolDeps> = {}): MovieToolDeps {
  return {
    host: 'this-host',
    imageBase: 'https://image.tmdb.org/t/p',
    tmdb: null,
    setTitleUser: vi.fn(async () => {}),
    setFileWatched: vi.fn(async () => {}),
    saveReview: vi.fn(async () => null),
    continueTitle: vi.fn(async (): Promise<ContinueResult> => ({ action: 'no_match', query: null })),
    ...over,
  };
}

async function connect(movies: MovieToolDeps | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMovieTools(server, { db: {} as Db, movies, wallUrl: 'http://localhost:7317/' });
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

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  movies_list: {},
  movies_get: { title: 'mobland' },
  movies_history: {},
  movies_continue: {},
  movies_person: { name: 'Margaret Qualley' },
  movies_mark: { title: 'mobland', watched: true },
};

describe('movie MCP tools without a database', () => {
  it('registers exactly the six names; only movies_continue and movies_mark write', async () => {
    const c = await connect(fakeMovies());
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MOVIE_TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(t.name !== 'movies_continue' && t.name !== 'movies_mark');
      expect(t.description?.length ?? 0).toBeGreaterThan(200);
    }
    expect(tools.find((t) => t.name === 'movies_continue')?.description).toContain("VLC on the owner's screen");
    await c.close();
  });

  it('answers movies_off from every tool while the library is off', async () => {
    const c = await connect(null);
    for (const name of MOVIE_TOOL_NAMES) {
      const r = await c.call(name, MINIMAL_ARGS[name]!);
      expect(r.isError, name).toBe(true);
      expect(text(r)).toBe(MOVIES_OFF);
    }
    await c.close();
  });

  it('movies_continue passes the title or null, and adds a message and the wall link', async () => {
    const continueTitle = vi.fn(
      async (): Promise<ContinueResult> => ({
        action: 'resumed',
        title: { id: 'movie-1002', title: 'A Film', kind: 'movie', year: 2025 },
        file: { file_id: 7, season: null, episode: null, absolute_episode: null, name: null },
        position: 1500,
        play: { play_id: 1, file_id: 7, title_id: 'movie-1002', name: 'A.Film.mkv', start_position: 1500, port: 47318, tracking: true, note: null },
      }),
    );
    const c = await connect(fakeMovies({ continueTitle }));
    const withTitle = await c.call('movies_continue', { title: '  A Film ' });
    expect(withTitle.isError ?? false).toBe(false);
    const body = JSON.parse(text(withTitle)) as { action: string; url: string; message: string; position: number };
    expect(body).toMatchObject({ action: 'resumed', position: 1500, url: 'http://localhost:7317/movies/movie-1002' });
    expect(body.message).toContain('25:00');
    await c.call('movies_continue', {});
    expect(continueTitle.mock.calls).toEqual([['A Film'], [null]]);
    await c.close();
  });

  it('turns a player error into its code with what to do', async () => {
    const continueTitle = vi.fn(async (): Promise<ContinueResult> => {
      throw Object.assign(new Error('file 7 is on gpd'), { code: 'not_on_this_machine' });
    });
    const c = await connect(fakeMovies({ continueTitle }));
    const r = await c.call('movies_continue', { title: 'mobland' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('not_on_this_machine: file 7 is on gpd The file is on the other laptop (its host); play it there.');
    await c.close();
  });

  it('movies_mark refuses contradictory or empty marks before writing anything', async () => {
    const movies = fakeMovies();
    const c = await connect(movies);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ title: 'mobland', file_id: 3, watched: true }, /^invalid_input: pass exactly one of title/],
      [{ watched: true }, /^invalid_input: pass exactly one of title/],
      [{ file_id: 3, rating: 4 }, /^invalid_input: rating and review belong to a title/],
      [{ file_id: 3 }, /^invalid_input: file_id needs watched/],
      [{ title: 'mobland' }, /^invalid_input: nothing to change/],
    ];
    for (const [args, expected] of cases) {
      const r = await c.call('movies_mark', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toMatch(expected);
    }
    const outOfRange = await c.call('movies_mark', { title: 'mobland', rating: 6 });
    expect(outOfRange.isError).toBe(true);
    expect(movies.setTitleUser).not.toHaveBeenCalled();
    expect(movies.setFileWatched).not.toHaveBeenCalled();
    expect(movies.saveReview).not.toHaveBeenCalled();
    await c.close();
  });

  it('movies_person says when there are no TMDB credentials', async () => {
    const c = await connect(fakeMovies({ tmdb: null }));
    const r = await c.call('movies_person', { name: 'Margaret Qualley' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^tmdb_unavailable: /);
    await c.close();
  });

  it('movies_list rejects a date that is not one', async () => {
    const c = await connect(fakeMovies());
    const r = await c.call('movies_list', { finished_from: '2026-13-45' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_input: /);
    await c.close();
  });
});
