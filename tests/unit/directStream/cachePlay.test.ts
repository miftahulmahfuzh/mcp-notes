import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { CachePlayView, PlayableCaches } from '../../../src/directStream/cachePlay.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, type DirectStreamHooks } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import type { StreamRef } from '../../../src/directStream/types.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';
import { streamCachePlayRoutes } from '../../../src/http/streamCachePlayApi.js';

const HOST = 'host-a';
const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' };
const FILM: StreamRef = { kind: 'movie', tmdbId: 550 };
const EP787: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 787 };
const CACHE_A = '0b6c7a52-6a0e-4d1e-9d8e-1f2a3b4c5d6e';
const CACHE_B = '7d1f2e3a-4b5c-4d6e-8f90-a1b2c3d4e5f6';
const PLAY_FILM = { kind: 'movie', tmdb_id: 550 };

const RESOLVED = {
  ok: true,
  source: {
    provider: 'Alpha',
    manifest_url: 'https://up.example/hls/master.m3u8',
    manifest_kind: 'hls',
    subtitles: [{ url: 'https://up.example/en.vtt', lang: 'en', label: 'English' }],
    best_height: 1080,
  },
  attempts: [{ provider: 'Alpha', outcome: 'resolved', took_s: 1, detail: '' }],
};
const NO_SOURCE = { ok: false, error: 'no_source', detail: '', attempts: [{ provider: 'Alpha', outcome: 'no_stream', took_s: 2, detail: '' }] };

function view(over: Partial<CachePlayView> = {}): CachePlayView {
  const id = over.id ?? CACHE_A;
  return {
    id,
    ref: FILM,
    host: HOST,
    state: 'ready',
    provider: 'HyperLink',
    height: 720,
    manifestKind: 'hls',
    manifestUrl: `/api/stream/cache/${id}/f/master.m3u8`,
    subtitles: [{ url: `/api/stream/cache/${id}/f/subtitle.vtt`, lang: 'en', label: 'English' }],
    audioLang: 'en',
    audio: { languages: ['en'], tracks: 0, original: true, track: null },
    ...over,
  };
}

const sameRef = (a: StreamRef, b: StreamRef): boolean =>
  a.kind === b.kind && a.tmdbId === b.tmdbId && (a.kind === 'movie' || (b.kind === 'tv' && a.season === b.season && a.episode === b.episode));

/** A cache store over `views`. `find` does not filter by host, so the service's own host check is what is tested. */
function cachesOf(views: CachePlayView[]): PlayableCaches {
  return {
    find: async (ref) => views.find((v) => sameRef(v.ref, ref)) ?? null,
    get: async (id) => views.find((v) => v.id === id) ?? null,
  };
}

interface Setup {
  views?: CachePlayView[];
  /** null: no cache wiring at all. Default: cachesOf(views). */
  caches?: PlayableCaches | null;
  resolve?: unknown;
  hooks?: DirectStreamHooks;
}

function setup(o: Setup = {}) {
  const views = o.views ?? [];
  const calls: string[][] = [];
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      calls.push(args);
      return args[0] === 'open' ? { ok: true } : (o.resolve ?? RESOLVED);
    },
    host: HOST,
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'en', ...o.hooks },
    caches: () => (o.caches === undefined ? cachesOf(views) : o.caches),
    sessions: new SessionStore(),
    log: () => undefined,
  });
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  app.route('/', streamCachePlayRoutes({ directStream: svc }));
  const count = (verb: string): number => calls.filter((a) => a[0] === verb).length;
  return { app, views, resolves: () => count('resolve'), opens: () => count('open') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: Hono, path: string, body: unknown = {}, headers: Record<string, string> = HEADERS): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe('playing from the stream cache', () => {
  it('plays a ready cache with no resolve: its local playlist, its subtitle and provider, one page opened', async () => {
    const t = setup({ views: [view()], resolve: NO_SOURCE });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.cached).toEqual({ id: CACHE_A, state: 'ready', height: 720 });
    expect(json.session.manifest_url).toBe(`/api/stream/cache/${CACHE_A}/f/master.m3u8`);
    expect(json.session.subtitles).toEqual([{ url: `/api/stream/cache/${CACHE_A}/f/subtitle.vtt`, lang: 'en', label: 'English', format: 'vtt', source: 'request', english: true }]);
    expect(json.session).toMatchObject({ provider: 'HyperLink', manifest_kind: 'hls', best_height: 720, audio_lang: 'en' });
    expect(json.attempts).toEqual([]);
    expect([t.resolves(), t.opens()]).toEqual([0, 1]);
    const read = await t.app.request(`/api/stream/sessions/${json.session.session_id}`);
    expect(((await read.json()) as { cached: unknown }).cached).toEqual({ id: CACHE_A, state: 'ready', height: 720 });
    // The pass-through serves nothing for it: a cached session may reach no stream host.
    const through = await t.app.request(`/api/stream/sessions/${json.session.session_id}/p?u=${encodeURIComponent('https://up.example/hls/seg1.ts')}`);
    expect(through.status).toBe(403);
    expect(((await through.json()) as { error: string }).error).toBe('forbidden_host');
  });

  it('plays a downloading cache from the same local playlist, with no resolve', async () => {
    const t = setup({ views: [view({ state: 'downloading' })], resolve: NO_SOURCE });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.cached).toEqual({ id: CACHE_A, state: 'downloading', height: 720 });
    expect(json.session.manifest_url).toBe(`/api/stream/cache/${CACHE_A}/f/master.m3u8`);
    expect(t.resolves()).toBe(0);
  });

  it('resolves as before when the cache failed, is on the other machine, was made for another language, or cannot be read', async () => {
    const cases: Setup[] = [
      { views: [view({ state: 'failed' })] },
      { views: [view({ host: 'host-b' })] },
      { views: [view({ audioLang: 'en' })], hooks: { originalLanguage: async () => 'ko' } },
      { views: [view({ audioLang: null })] },
      { caches: { find: async () => { throw new Error('db down'); }, get: async () => null } },
      { caches: null },
      {},
    ];
    for (const c of cases) {
      const t = setup(c);
      const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
      expect(status).toBe(200);
      expect(json.session.cached).toBeNull();
      expect(String(json.session.manifest_url).startsWith(`/api/stream/sessions/${json.session.session_id}/p?u=`)).toBe(true);
      expect(json.session.provider).toBe('Alpha');
      expect([t.resolves(), t.opens()]).toEqual([1, 1]);
    }
  });

  it('starts a cached play where the last one stopped, or where it is asked to', async () => {
    const t = setup({ views: [view()], hooks: { resumeS: async () => 754 } });
    expect((await post(t.app, '/api/stream/play', PLAY_FILM)).json.session.resume_s).toBe(754);
    expect((await post(t.app, '/api/stream/play', { ...PLAY_FILM, resume_s: 30 })).json.session.resume_s).toBe(30);
  });

  it('POST /api/stream/cache/:id/play plays one cache by id, and refuses one it cannot play', async () => {
    const t = setup({ views: [view(), view({ id: CACHE_B, host: 'host-b' })], resolve: NO_SOURCE });
    const played = await post(t.app, `/api/stream/cache/${CACHE_A}/play`, { resume_s: 12 });
    expect(played.status).toBe(200);
    expect(played.json).toMatchObject({ ok: true, attempts: [], session: { cached: { id: CACHE_A, state: 'ready' }, resume_s: 12 } });
    const bare = await t.app.request(`/api/stream/cache/${CACHE_A}/play`, { method: 'POST', headers: HEADERS });
    expect(bare.status).toBe(200);
    const other = await post(t.app, `/api/stream/cache/${CACHE_B}/play`);
    expect(other.status).toBe(404);
    expect(other.json).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    const unknown = await post(t.app, '/api/stream/cache/00000000-0000-4000-8000-000000000000/play');
    expect([unknown.status, unknown.json.error]).toEqual([404, 'unknown_cache']);
    expect((await post(t.app, '/api/stream/cache/a.b/play')).json.error).toBe('unknown_cache');
    expect((await post(t.app, `/api/stream/cache/${CACHE_A}/play`, { resume_s: -1 })).status).toBe(400);
    expect((await post(t.app, `/api/stream/cache/${CACHE_A}/play`, {}, { 'content-type': 'application/json' })).status).toBe(403);
    expect(t.resolves()).toBe(0);
    const failed = setup({ views: [view({ state: 'failed' })] });
    const refused = await post(failed.app, `/api/stream/cache/${CACHE_A}/play`);
    expect([refused.status, refused.json.error]).toEqual([409, 'cache_failed']);
    const korean = setup({ views: [view()], hooks: { originalLanguage: async () => 'ko' } });
    const dub = await post(korean.app, `/api/stream/cache/${CACHE_A}/play`);
    expect([dub.status, dub.json.error]).toEqual([409, 'cache_language']);
    expect(failed.opens() + korean.opens()).toBe(0);
  });

  it('a refresh keeps a cache that can still be played, and resolves once it is gone', async () => {
    const t = setup({ views: [view({ state: 'downloading' })] });
    const sid = (await post(t.app, '/api/stream/play', PLAY_FILM)).json.session.session_id as string;
    t.views[0] = view({ state: 'ready' });
    const kept = await post(t.app, `/api/stream/sessions/${sid}/refresh`);
    expect(kept.status).toBe(200);
    expect(kept.json).toMatchObject({ session_id: sid, cached: { id: CACHE_A, state: 'ready', height: 720 } });
    expect(t.resolves()).toBe(0);
    t.views.length = 0;
    const gone = await post(t.app, `/api/stream/sessions/${sid}/refresh`);
    expect(gone.status).toBe(200);
    expect(gone.json.session_id).toBe(sid);
    expect(gone.json.cached).toBeNull();
    expect(String(gone.json.manifest_url).startsWith(`/api/stream/sessions/${sid}/p?u=`)).toBe(true);
    expect(t.resolves()).toBe(1);
  });

  it('the previous and next episode buttons play a neighbour from its cache when it has one', async () => {
    const neighbors: NonNullable<DirectStreamHooks['neighbors']> = async (ref) =>
      ref.kind === 'tv' && ref.episode === 787 ? { prev: null, next: { season: 18, episode: 788 } } : { prev: { season: 18, episode: 787 }, next: null };
    const t = setup({ views: [view({ ref: EP787 })], hooks: { neighbors } });
    const first = await post(t.app, '/api/stream/play', { kind: 'tv', tmdb_id: 37854, season: 18, episode: 787 });
    expect(first.json.session.cached.id).toBe(CACHE_A);
    const next = await post(t.app, `/api/stream/sessions/${first.json.session.session_id}/episode`, { to: 'next' });
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({ episode: 788, cached: null });
    expect(t.resolves()).toBe(1);
    const back = await post(t.app, `/api/stream/sessions/${next.json.session_id}/episode`, { to: 'prev' });
    expect(back.json).toMatchObject({ episode: 787, cached: { id: CACHE_A, state: 'ready' } });
    expect(t.resolves()).toBe(1);
  });
});
