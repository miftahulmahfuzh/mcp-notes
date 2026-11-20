import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, TORRENT_IDLE_MS } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';
import { WARP_ATTEMPT, type TorrentWarp } from '../../../src/directStream/torrentWarp.js';
import { TorrentError } from '../../../src/directStream/torrent/types.js';
import type { WarpState, WarpSwitch } from '../../../src/streaming/warp.js';

const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' };
const PLAY_FILM = { kind: 'movie', tmdb_id: 467905 };
const h = (n: number): string => n.toString(16).padStart(40, '0');
const NO_SOURCE = { ok: false, error: 'no_source', detail: '', attempts: [{ provider: 'Alpha', outcome: 'no_stream', took_s: 2, detail: '' }] };
const NO_CHROME = { ok: false, error: 'no_chrome', detail: 'chrome.exe was not found', attempts: [] };
const RESOLVED = {
  ok: true,
  source: { provider: 'Alpha', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', subtitles: [], best_height: 1080 },
  attempts: [{ provider: 'Alpha', outcome: 'resolved', took_s: 1, detail: '' }],
};
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };

const candidate = (infoHash: string, name: string): TorrentCandidate => ({
  infoHash, name, fileName: null, fileIdx: null, seeds: 30, sizeBytes: 700_000_000, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: false, release: parseRelease(name),
});

interface Setup {
  resolve?: unknown;
  /** false: torrents off (no torrent source). */
  torrents?: boolean;
  candidates?: TorrentCandidate[];
  disk?: DownloadOnDisk | null;
  ready?: string[];
  now?: () => Date;
  /** True while no peer answers: every open then fails as the engine's no_metadata does. */
  peerless?: () => boolean;
  warp?: TorrentWarp | null;
}

function setup(o: Setup = {}) {
  const runs: string[][] = [];
  const swarmCalls: string[] = [];
  const recorded: unknown[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      swarmCalls.push(`open ${pick.infoHash}`);
      if (o.peerless?.() === true) throw new TorrentError('no_metadata', 'No peer sent the file list within 20 s.');
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.720p.mp4', name: 'Film.2026.720p.mp4', length: 1_000_000 }] };
    },
    use: (infoHash) => {
      swarmCalls.push(`use ${infoHash}`);
    },
    release: (infoHash) => {
      swarmCalls.push(`release ${infoHash}`);
    },
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/t/${infoHash}/${index}` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const answer: FindAnswer = { candidates: o.candidates ?? [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: 1 }], excluded: [], lastResort: [] };
  const finds = vi.fn(async () => answer);
  const torrent = new TorrentSource({ swarm, find: finds, probe: async () => MP4_EN, tiers: [], localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const sessions = new SessionStore(o.now);
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      runs.push(args);
      return args[0] === 'open' ? { ok: true } : (o.resolve ?? NO_SOURCE);
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: {
      originalLanguage: async () => 'en',
      imdbId: async () => 'tt0467905',
      recordResolve: async (_ref, result) => {
        recorded.push(result);
      },
    },
    torrent: () => (o.torrents === false ? null : torrent),
    warp: o.warp ?? null,
    sessions,
    ...(o.now === undefined ? {} : { now: o.now }),
    log: () => undefined,
  });
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  const count = (verb: string): number => runs.filter((a) => a[0] === verb).length;
  const settled = async (): Promise<string[]> => {
    await new Promise((r) => setTimeout(r, 0));
    return swarmCalls;
  };
  return { app, svc, finds, recorded, settled, resolves: () => count('resolve'), resolveArgs: () => runs.filter((a) => a[0] === 'resolve'), opens: () => count('open') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: Hono, path: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe('a torrent session', () => {
  it('provider "Torrent" (any case) plays a torrent and asks no cloud provider: the local file route, provider Torrent (R2.4)', async () => {
    const t = setup({ resolve: RESOLVED });
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'TORRENT' });
    expect(status).toBe(200);
    expect(json.session).toMatchObject({
      provider: 'Torrent',
      manifest_kind: 'mp4',
      manifest_url: `/api/stream/torrent/${h(1)}/f/0`,
      cached: null,
      torrent: { info_hash: h(1), file_index: 0, name: 'Film.2026.720p.WEB-DL.x264.AAC-A', index: 'torrentio', state: 'downloading', seeds: 30 },
    });
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Index: torrentio', 'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A']);
    expect([t.resolves(), t.opens()]).toEqual([0, 1]);
    expect(t.recorded).toEqual([]);
    // The pass-through serves nothing for it, as for a cache.
    const through = await t.app.request(`/api/stream/sessions/${json.session.session_id}/p?u=${encodeURIComponent('https://up.example/x.ts')}`);
    expect(through.status).toBe(403);
    expect(t.svc.evidenceSource(json.session.session_id)?.torrent).toEqual({ info_hash: h(1), name: 'Film.2026.720p.WEB-DL.x264.AAC-A', file_index: 0, index: 'torrentio', state: 'downloading' });
  });

  it('answers 503 torrent_off to a named torrent play while torrents are off, and runs nothing (R2.6)', async () => {
    const t = setup({ torrents: false });
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' });
    expect(status).toBe(503);
    expect(json.error).toBe('torrent_off');
    expect([t.resolves(), t.opens()]).toEqual([0, 0]);
    expect(t.finds).not.toHaveBeenCalled();
  });

  it('with torrents off, a cloud no_source answers exactly as before: no index, no torrent in attempts (R2.6)', async () => {
    const t = setup({ torrents: false });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(502);
    expect(json).toMatchObject({ error: 'no_source', attempts: NO_SOURCE.attempts });
    expect(t.finds).not.toHaveBeenCalled();
  });

  it('tries the torrent source after a cloud no_source: attempts are the cloud\'s, then the index, then the torrent (R2.5)', async () => {
    const t = setup();
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Torrent');
    expect(json.attempts.map((a: { provider: string; outcome: string }) => `${a.provider} ${a.outcome}`)).toEqual([
      'Alpha no_stream',
      'Index: torrentio resolved',
      'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A resolved',
    ]);
    expect(t.resolves()).toBe(1);
    // The cloud no_source was recorded (the title is stale on the Stream side); the torrent resolve was not.
    expect(t.recorded).toEqual([expect.objectContaining({ ok: false, error: 'no_source' })]);
  });

  it('answers no_source with the cloud, index and torrent attempts when no torrent plays either (R2.5)', async () => {
    const t = setup({ candidates: [] });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(502);
    expect(json.error).toBe('no_source');
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Alpha', 'Index: torrentio']);
  });

  it('goes on to the torrent source when the cloud resolve cannot run, and keeps that error when no torrent plays', async () => {
    const plays = setup({ resolve: NO_CHROME });
    expect((await post(plays.app, '/api/stream/play', PLAY_FILM)).json.session.provider).toBe('Torrent');
    const none = setup({ resolve: NO_CHROME, candidates: [] });
    const { status, json } = await post(none.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(502);
    expect(json).toMatchObject({ error: 'resolve_failed', reason: 'no_chrome' });
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Index: torrentio']);
  });

  it('provider "cloud" (any case) never plays a torrent: a cloud no_source is the answer, and no index is asked', async () => {
    const t = setup();
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'Cloud' });
    expect(status).toBe(502);
    expect(json).toMatchObject({ error: 'no_source', attempts: NO_SOURCE.attempts });
    expect(t.resolves()).toBe(1);
    expect(t.finds).not.toHaveBeenCalled();
    expect(await t.settled()).toEqual([]);
  });

  it('provider "cloud" passes over a finished torrent download and asks every cloud provider', async () => {
    const t = setup({ resolve: RESOLVED, disk: { infoHash: h(7), name: 'Film.2026.720p.WEB-DL.x264.AAC-D', fileIndex: 0, state: 'ready' }, ready: [h(7)] });
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'cloud' });
    expect(status).toBe(200);
    expect(json.session).toMatchObject({ provider: 'Alpha', torrent: null });
    expect(t.resolves()).toBe(1);
    // Every provider, not one named "cloud": the resolver was given no --only.
    expect(t.resolveArgs()[0]).not.toContain('--only');
    expect(t.finds).not.toHaveBeenCalled();
  });

  it('plays a finished download from disk first: no resolve, no index, no swarm (R2.9)', async () => {
    const t = setup({ resolve: RESOLVED, disk: { infoHash: h(7), name: 'Film.2026.720p.WEB-DL.x264.AAC-D', fileIndex: 0, state: 'ready' }, ready: [h(7)] });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.attempts).toEqual([]);
    expect(json.session.torrent).toMatchObject({ info_hash: h(7), state: 'ready', index: null, seeds: null });
    expect(t.resolves()).toBe(0);
    expect(t.finds).not.toHaveBeenCalled();
    expect(await t.settled()).toEqual([]);
  });

  it('the shuffle button moves to the next candidate and releases the old torrent; with none left it stays', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')] });
    const sid = (await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' })).json.session.session_id;
    const moved = await post(t.app, `/api/stream/sessions/${sid}/source`);
    expect(moved.json).toMatchObject({ switched: true, from: 'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A', torrent: { info_hash: h(2) }, manifest_url: `/api/stream/torrent/${h(2)}/f/0` });
    expect(await t.settled()).toContain(`release ${h(1)}`);
    const stuck = await post(t.app, `/api/stream/sessions/${sid}/source`);
    expect(stuck.json).toMatchObject({ switched: false, reason: 'no_other_source', torrent: { info_hash: h(2) } });
    expect(t.resolves()).toBe(0);
  });

  it('never caches a torrent session', async () => {
    const t = setup();
    const sid = (await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' })).json.session.session_id;
    const answer = await post(t.app, `/api/stream/sessions/${sid}/cache`, { start: true });
    expect(answer.json).toMatchObject({ moved: false, cache: null, provider: 'Torrent' });
  });

  it('lets go of the torrent when the page closes, takes it again when the page comes back, and after an idle spell', async () => {
    let now = new Date('2026-11-16T12:00:00Z');
    const t = setup({ now: () => now });
    const sid = (await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' })).json.session.session_id;
    t.svc.letGo(sid);
    expect((await t.settled()).filter((c) => c === `release ${h(1)}`)).toHaveLength(1);
    const back = await t.app.request(`/api/stream/sessions/${sid}`);
    expect(back.status).toBe(200);
    expect((await t.settled()).slice(-2)).toEqual([`open ${h(1)}`, `use ${h(1)}`]);
    now = new Date(now.getTime() + TORRENT_IDLE_MS + 1_000);
    t.svc.sweepTorrents();
    expect((await t.settled()).filter((c) => c === `release ${h(1)}`)).toHaveLength(2);
    const refreshed = await post(t.app, `/api/stream/sessions/${sid}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.torrent.info_hash).toBe(h(1));
    expect((await t.settled()).slice(-2)).toEqual([`open ${h(1)}`, `use ${h(1)}`]);
  });
});

describe('a torrent play on the office network that found no peer at all', () => {
  const officeWarp = (): WarpSwitch & { on: () => boolean; calls: string[] } => {
    let warp: WarpState['warp'] = 'disconnected';
    const calls: string[] = [];
    return {
      calls,
      on: () => warp === 'connected',
      status: async () => ({ ok: true, warp, ssid: 'Employee' }),
      set: async (on) => {
        calls.push(on ? 'on' : 'off');
        warp = on ? 'connected' : 'disconnected';
        return { ok: true, warp, ssid: 'Employee', changed: true };
      },
    };
  };

  it('says WARP may help, and switches nothing, without the automatic flip', async () => {
    const sw = officeWarp();
    const t = setup({ peerless: () => true, warp: { switch: sw, auto: false } });
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' });
    expect(status).toBe(502);
    expect(json.attempts.at(-1)).toMatchObject({ provider: WARP_ATTEMPT, outcome: 'skipped' });
    expect(sw.calls).toEqual([]);
  });

  it('with the flip: WARP on, the same torrent asked again, and it plays', async () => {
    const sw = officeWarp();
    const t = setup({ resolve: RESOLVED, peerless: () => !sw.on(), warp: { switch: sw, auto: true } });
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' });
    expect(status).toBe(200);
    expect(sw.calls).toEqual(['on']);
    const providers = json.attempts.map((a: { provider: string }) => a.provider);
    expect(providers).toContain(WARP_ATTEMPT);
    // The first round's "not tried yet" is no longer true once WARP asked again.
    expect(providers).not.toContain('Torrents: not tried yet');
    expect(providers.filter((p: string) => p.startsWith('Torrent: Film')).length).toBeGreaterThanOrEqual(2);
  });
});
