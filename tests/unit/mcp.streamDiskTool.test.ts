import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ShelfError, type DeletionScope, type PendingView, type ShelfTitle, type ShelfView } from '../../src/directStream/cacheShelf.js';
import { streamDiskRoutes } from '../../src/http/streamDiskApi.js';
import { matchTitles, registerStreamDiskTool, type StreamDiskApi } from '../../src/mcp/streamDiskTool.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const json = (r: ToolResult): any => JSON.parse(r.content.map((c) => c.text ?? '').join('\n'));
const GIB = 1024 ** 3;

function title(over: Partial<ShelfTitle>): ShelfTitle {
  return {
    title_id: 'movie-1',
    movie_id: 'M-AAAA',
    kind: 'movie',
    tmdb_id: 1,
    title: 'Barbie',
    year: 2023,
    poster_url: null,
    stored: true,
    bytes: GIB,
    torrent_bytes: GIB,
    cloud_bytes: 0,
    kinds: ['torrent'],
    watched: true,
    not_interested: false,
    playing: false,
    in_use: false,
    seasons: [],
    shared_bytes: 0,
    downloading: null,
    ...over,
  };
}

const DANDADAN = title({
  title_id: 'tv-240411',
  movie_id: 'M-DDDN',
  kind: 'tv',
  tmdb_id: 240411,
  title: 'Dandadan',
  bytes: 3 * GIB,
  torrent_bytes: 3 * GIB,
  watched: false,
  seasons: [
    {
      season: 1,
      bytes: 3 * GIB,
      shared_bytes: 0,
      kinds: ['torrent'],
      watched: false,
      playing: false,
      in_use: false,
      downloading: null,
      episodes: [{ season: 1, episode: 4, movie_id: 'M-DD04', name: 'Kicking', bytes: 3 * GIB, kinds: ['torrent'], watched: false, playing: false, in_use: false, downloading: null }],
    },
  ],
});

function fake(): { api: StreamDiskApi; asked: DeletionScope[]; undone: string[] } {
  const asked: DeletionScope[] = [];
  const undone: string[] = [];
  const view: ShelfView = {
    host: 'here',
    total_bytes: 4 * GIB,
    torrent_bytes: 4 * GIB,
    cloud_bytes: 0,
    unnamed_bytes: 0,
    budget_bytes: 40 * GIB,
    titles: [DANDADAN, title({})],
    downloading: 0,
    bulk: { watched: { bytes: GIB, titles: 1 }, not_interested: { bytes: 0, titles: 0 } },
    pending: [],
    undo_ms: 10_000,
  };
  const pending = (label: string): PendingView => ({ id: 'abcdef012345', label, bytes: GIB, execute_at: '2026-11-20T00:00:10.000Z', skipped: [] });
  return {
    asked,
    undone,
    api: {
      view: async () => view,
      remove: async (scope) => {
        asked.push(scope);
        if ('title_id' in scope && scope.title_id === 'tv-240411' && scope.episode === 9) throw new ShelfError('in_use', 'plays');
        return pending('bulk' in scope ? 'Watched (1 title)' : 'Dandadan S01E04');
      },
      undo: async (id) => {
        undone.push(id);
        return pending('Dandadan S01E04');
      },
    },
  };
}

async function connect(api: StreamDiskApi | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerStreamDiskTool(server, { streamDisk: api, wallUrl: 'http://localhost:7317' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return { call: async (args: Record<string, unknown>) => (await client.callTool({ name: 'stream_disk', arguments: args })) as ToolResult };
}

describe('stream_disk', () => {
  it('answers stream_disk_off without the shelf', async () => {
    const c = await connect(null);
    const r = await c.call({ action: 'list' });
    expect(r.isError).toBe(true);
    expect(json(r).error).toBe('stream_disk_off');
  });

  it('says how much one title takes, by season', async () => {
    const c = await connect(fake().api);
    const body = json(await c.call({ action: 'list', title: 'dandadan' }));
    expect(body.titles).toHaveLength(1);
    expect(body.titles[0]).toMatchObject({ title: 'Dandadan', size: '3.0 GB', seasons: [{ season: 1, size: '3.0 GB' }] });
    expect(body.total).toBe('4.0 GB');
  });

  it('deletes an episode named by its movie id, the watched ones, and undoes by id', async () => {
    const f = fake();
    const c = await connect(f.api);
    expect(json(await c.call({ action: 'delete', title: 'm-dd04' })).deletion.label).toBe('Dandadan S01E04');
    expect(f.asked[0]).toEqual({ title_id: 'tv-240411', season: 1, episode: 4 });
    expect(json(await c.call({ action: 'delete_watched' })).deletion.size).toBe('1.0 GB');
    expect(f.asked[1]).toEqual({ bulk: 'watched' });
    expect(json(await c.call({ action: 'undo', id: 'abcdef012345' })).undone).toBe(true);
    expect(f.undone).toEqual(['abcdef012345']);
    const refused = await c.call({ action: 'delete', title: 'Dandadan', season: 1, episode: 9 });
    expect(refused.isError).toBe(true);
    expect(json(refused).error).toBe('in_use');
  });

  it('matches names loosely and keys exactly', () => {
    const view = { titles: [DANDADAN, title({})] } as ShelfView;
    expect(matchTitles(view, 'DanDaDan').titles.map((t) => t.title)).toEqual(['Dandadan']);
    expect(matchTitles(view, 'tv-240411').titles).toHaveLength(1);
    expect(matchTitles(view, 'barb').titles.map((t) => t.title)).toEqual(['Barbie']);
    expect(matchTitles(view, 'nothing').titles).toEqual([]);
  });

  it('says what downloads now, with its progress and why', async () => {
    const oppenheimer = title({ title_id: 'movie-872585', movie_id: 'M-OPPN', title: 'Oppenheimer', bytes: 0, torrent_bytes: 0, kinds: [], watched: false, downloading: { count: 1, progress: 0.42, why: ['asked'], state: 'running' } });
    const base = await fake().api.view();
    const api: StreamDiskApi = {
      view: async () => ({ ...base, titles: [oppenheimer], downloading: 1 }),
      remove: async () => {
        throw new Error('unused');
      },
      undo: async () => {
        throw new Error('unused');
      },
    };
    const body = json(await (await connect(api)).call({ action: 'list' }));
    expect(body.downloading).toBe(1);
    expect(body.titles[0]).toMatchObject({ title: 'Oppenheimer', size: '0 MB', downloading: { count: 1, progress: 0.42, why: ['asked'], state: 'running' } });
  });
});

describe('the Cache page routes', () => {
  const app = (api: StreamDiskApi | null): Hono => {
    const a = new Hono();
    a.route('/', streamDiskRoutes({ cacheShelf: api as never }));
    return a;
  };
  const post = (body: unknown, origin = 'http://127.0.0.1:7317') =>
    new Request('http://127.0.0.1:7317/api/stream/disk/delete', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin === '' ? {} : { origin }) }, body: JSON.stringify(body) });

  it('reads, deletes same-origin only, refuses what is in use, and undoes', async () => {
    const f = fake();
    const a = app(f.api);
    expect((await a.request('http://127.0.0.1:7317/api/stream/disk')).status).toBe(200);
    expect((await a.request(post({ title_id: 'tv-240411', season: 1, episode: 4 }, ''))).status).toBe(403);
    const ok = await a.request(post({ title_id: 'tv-240411', season: 1, episode: 4 }));
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { deletion: { id: string } }).deletion.id).toBe('abcdef012345');
    expect((await a.request(post({ title_id: 'tv-240411', season: 1, episode: 9 }))).status).toBe(409);
    expect((await a.request(post({ title_id: 'tv-240411', episode: 4 }))).status).toBe(400);
    expect((await a.request(post({ bulk: 'everything' }))).status).toBe(400);
    const undo = await a.request(new Request('http://127.0.0.1:7317/api/stream/disk/deletions/abcdef012345', { method: 'DELETE', headers: { origin: 'http://127.0.0.1:7317' } }));
    expect(undo.status).toBe(200);
  });

  it('answers stream_disk_off with neither torrents nor the cache', async () => {
    const r = await app(null).request('http://127.0.0.1:7317/api/stream/disk');
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe('stream_disk_off');
  });
});
