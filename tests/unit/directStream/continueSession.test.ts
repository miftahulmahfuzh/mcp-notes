import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { CachePlayView, PlayableCaches } from '../../../src/directStream/cachePlay.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';

/*
 * A daemon restart ends every session (they live in memory). The player page then asks
 * POST /api/stream/continue with what it was playing, and gets a fresh session for the same source.
 */

const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' };
const EPISODE = { kind: 'tv', tmdb_id: 37854, season: 18, episode: 787 };
const FILM = { kind: 'movie', tmdb_id: 550 };
const LOST = 'L'.repeat(32);
const CACHE_ID = '0b6c7a52-6a0e-4d1e-9d8e-1f2a3b4c5d6e';
const h = (n: number): string => n.toString(16).padStart(40, '0');
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };

const resolved = (provider: string) => ({
  ok: true,
  source: { provider, manifest_url: `https://${provider.toLowerCase()}.example/hls/master.m3u8`, manifest_kind: 'hls', subtitles: [], best_height: 1080 },
  attempts: [{ provider, outcome: 'resolved', took_s: 1, detail: '' }],
});
const noSource = (provider: string) => ({ ok: false, error: 'no_source', detail: '', attempts: [{ provider, outcome: 'no_stream', took_s: 2, detail: '' }] });

function cacheView(over: Partial<CachePlayView> = {}): CachePlayView {
  return {
    id: CACHE_ID,
    ref: { kind: 'movie', tmdbId: 550 },
    host: 'host-a',
    state: 'ready',
    provider: 'HyperLink',
    height: 720,
    manifestKind: 'hls',
    manifestUrl: `/api/stream/cache/${CACHE_ID}/f/master.m3u8`,
    subtitles: [],
    audioLang: 'en',
    audio: { languages: ['en'], tracks: 0, original: true, track: null },
    ...over,
  };
}

interface Setup {
  /** By the provider `--only` names, or `all`. */
  resolve?: Record<string, unknown>;
  cache?: CachePlayView | null;
}

function setup(o: Setup = {}) {
  const resolves: Array<{ only: string | null; skip: string | null }> = [];
  const opened: string[] = [];
  let pages = 0;
  let cache = o.cache ?? null;
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      opened.push(pick.infoHash);
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.1999.720p.mp4', name: 'Film.1999.720p.mp4', length: 1_000_000 }] };
    },
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const candidate: TorrentCandidate = {
    infoHash: h(9), name: 'Film.1999.720p.WEB-DL.x264.AAC-A', fileName: null, fileIdx: null, seeds: 30, sizeBytes: 700_000_000, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: false, release: parseRelease('Film.1999.720p.WEB-DL.x264.AAC-A'),
  };
  const finds = vi.fn(async (): Promise<FindAnswer> => ({ candidates: [candidate], indexes: [], excluded: [], lastResort: [] }));
  const torrent = new TorrentSource({ swarm, find: finds, probe: async () => MP4_EN, tiers: [], localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const caches: PlayableCaches = { find: async () => cache, get: async (id) => (cache?.id === id ? cache : null) };
  const flag = (args: string[], name: string): string | null => (args.includes(name) ? args[args.indexOf(name) + 1]! : null);
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      if (args[0] === 'open') {
        pages += 1;
        return { ok: true };
      }
      resolves.push({ only: flag(args, '--only'), skip: flag(args, '--skip') });
      const only = flag(args, '--only') ?? 'all';
      return (o.resolve ?? {})[only] ?? noSource(only);
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'en', imdbId: async () => 'tt0137523' },
    caches: () => caches,
    torrent: () => torrent,
    sessions: new SessionStore(),
    log: () => undefined,
  });
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  return { app, svc, resolves, opened, finds, pages: () => pages, dropCache: () => void (cache = null) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: Hono, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe('a play carries on after the daemon restarts', () => {
  it('a cloud play asks the provider it streamed from alone, starts where the film was, and opens no page', async () => {
    const t = setup({ resolve: { Beta: resolved('Beta'), all: resolved('Alpha') } });
    const { status, json } = await post(t.app, '/api/stream/continue', { ...EPISODE, session_id: LOST, provider: 'Beta', position_s: 1312.4 });
    expect(status).toBe(200);
    expect(json).toMatchObject({ continued: true, provider: 'Beta', kind: 'tv', tmdb_id: 37854, season: 18, episode: 787, resume_s: 1312.4 });
    expect(json.session_id).not.toBe(LOST);
    expect(t.resolves).toEqual([{ only: 'Beta', skip: null }]);
    expect(t.pages()).toBe(0);
    // The page asks again (a second tab, a retry after a slow answer): the same new session, no second resolve.
    const again = await post(t.app, '/api/stream/continue', { ...EPISODE, session_id: LOST, provider: 'Beta', position_s: 1320 });
    expect(again.json.session_id).toBe(json.session_id);
    expect(t.resolves).toHaveLength(1);
  });

  it('a provider with nothing now hands over to the others, without it', async () => {
    const t = setup({ resolve: { all: resolved('Alpha') } });
    const { json } = await post(t.app, '/api/stream/continue', { ...EPISODE, session_id: LOST, provider: 'Beta', position_s: 600 });
    expect(json).toMatchObject({ continued: true, provider: 'Alpha', resume_s: 600 });
    expect(t.resolves).toEqual([
      { only: 'Beta', skip: null },
      { only: null, skip: 'Beta' },
    ]);
  });

  it('a title cached on this machine plays from the cache with no resolve', async () => {
    const t = setup({ cache: cacheView(), resolve: { all: resolved('Alpha') } });
    const { json } = await post(t.app, '/api/stream/continue', { ...FILM, session_id: LOST, provider: 'HyperLink', position_s: 4000 });
    expect(json).toMatchObject({ continued: true, cached: { id: CACHE_ID, state: 'ready', height: 720 }, resume_s: 4000 });
    expect(t.resolves).toEqual([]);
  });

  it('a torrent play opens that very torrent again, with no index asked', async () => {
    const t = setup();
    const { status, json } = await post(t.app, '/api/stream/continue', { ...FILM, session_id: LOST, provider: 'Torrent', info_hash: h(7).toUpperCase(), position_s: 2000 });
    expect(status).toBe(200);
    expect(json.continued).toBe(true);
    expect(json.torrent.info_hash).toBe(h(7));
    expect(json.resume_s).toBe(2000);
    expect(t.opened).toEqual([h(7)]);
    expect(t.finds).not.toHaveBeenCalled();
    expect(t.resolves).toEqual([]);
  });

  it('a session the daemon still holds is answered as it is', async () => {
    const t = setup({ resolve: { all: resolved('Alpha') } });
    const play = await post(t.app, '/api/stream/play', FILM);
    const id = play.json.session.session_id as string;
    const { json } = await post(t.app, '/api/stream/continue', { ...FILM, session_id: id, provider: 'Alpha', position_s: 30 });
    expect(json).toMatchObject({ continued: false, session_id: id });
    expect(t.resolves).toHaveLength(1);
  });

  it('refuses a body that names no title; with no cloud stream left it goes on as a play would, to a torrent', async () => {
    const t = setup();
    expect((await post(t.app, '/api/stream/continue', { session_id: LOST })).status).toBe(400);
    expect((await post(t.app, '/api/stream/continue', { ...FILM, info_hash: 'not-a-hash' })).status).toBe(400);
    const none = await post(t.app, '/api/stream/continue', { ...EPISODE, session_id: LOST, provider: 'Beta' });
    expect(none.status).toBe(200);
    expect(none.json.torrent.info_hash).toBe(h(9));
    expect(t.finds).toHaveBeenCalledTimes(1);
  });
});

describe('a cached play that keeps stalling leaves the cache', () => {
  it('moves the session, under the same id, to the live stream of the provider the cache came from', async () => {
    const t = setup({ cache: cacheView(), resolve: { HyperLink: resolved('HyperLink'), all: resolved('Alpha') } });
    const play = await post(t.app, '/api/stream/play', FILM);
    const id = play.json.session.session_id as string;
    expect(play.json.session.cached).not.toBeNull();
    // The plain ask keeps a cached session where it is.
    expect((await post(t.app, `/api/stream/sessions/${id}/source`, {})).json).toMatchObject({ switched: false, reason: 'cached' });
    const { status, json } = await post(t.app, `/api/stream/sessions/${id}/source`, { leave_cache: true });
    expect(status).toBe(200);
    expect(json).toMatchObject({ switched: true, reason: null, from: 'cache', session_id: id, provider: 'HyperLink', cached: null });
    expect(json.manifest_url).toContain('/api/stream/sessions/');
    expect(t.resolves).toEqual([{ only: 'HyperLink', skip: null }]);
  });

  it('stays on the cache when no provider streams the title now', async () => {
    const t = setup({ cache: cacheView() });
    const play = await post(t.app, '/api/stream/play', FILM);
    const id = play.json.session.session_id as string;
    const { json } = await post(t.app, `/api/stream/sessions/${id}/source`, { leave_cache: true });
    expect(json).toMatchObject({ switched: false, reason: 'no_other_source', from: 'cache', cached: { id: CACHE_ID } });
    expect((await post(t.app, `/api/stream/sessions/${id}/source`, { leave_cache: 'yes' })).status).toBe(400);
  });
});
