import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { CLOUD_FAILURE_KEEP_MS, DirectStreamService } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import type { RememberedChannel } from '../../../src/directStream/types.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';

const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' };
const PLAY_FILM = { kind: 'movie', tmdb_id: 467905 };
const PLAY_EPISODE = { kind: 'tv', tmdb_id: 335951, season: 1, episode: 4 };
const NOW = new Date('2026-11-18T12:00:00Z');
const h = (n: number): string => n.toString(16).padStart(40, '0');
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };
const NOTHING: RememberedChannel = { channel: null, provider: null, infoHash: null, siteUrl: null, season: null, episode: null, playedAt: null, cloudFailedAt: null, torrentFailedAt: null };

const resolved = (provider: string) => ({
  ok: true,
  source: { provider, manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', subtitles: [], best_height: 1080 },
  attempts: [{ provider, outcome: 'resolved', took_s: 1, detail: '' }],
});
const noSource = (...providers: string[]) => ({ ok: false, error: 'no_source', detail: '', attempts: providers.map((provider) => ({ provider, outcome: 'no_stream', took_s: 2, detail: '' })) });

const candidate = (infoHash: string, name: string): TorrentCandidate => ({
  infoHash, name, fileName: null, fileIdx: null, seeds: 30, sizeBytes: 700_000_000, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: false, release: parseRelease(name),
});

interface Setup {
  known?: Partial<RememberedChannel> | null;
  /** What a resolve answers: by the provider `--only` names, or `all` for every provider. */
  resolve?: Record<string, unknown>;
  /** false: no torrent has the title. */
  torrentHasIt?: boolean;
  /** What the streaming command answers; unset: no streaming runner. */
  site?: unknown;
}

function setup(o: Setup = {}) {
  const resolves: string[][] = [];
  const failed: string[] = [];
  const recorded: unknown[] = [];
  const siteRuns: Array<[string, string[]]> = [];
  const sitePlays: unknown[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => ({ infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.720p.mp4', name: 'Film.2026.720p.mp4', length: 1_000_000 }] }),
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const answer: FindAnswer = {
    candidates: o.torrentHasIt === false ? [] : [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')],
    indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: o.torrentHasIt === false ? 0 : 1 }],
    excluded: [],
    lastResort: [],
  };
  const finds = vi.fn(async () => answer);
  const torrent = new TorrentSource({ swarm, find: finds, probe: async () => MP4_EN, tiers: [], localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      if (args[0] === 'open') return { ok: true };
      resolves.push(args);
      const only = args.includes('--only') ? args[args.indexOf('--only') + 1]! : 'all';
      return (o.resolve ?? {})[only] ?? noSource('Alpha');
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: {
      originalLanguage: async () => 'en',
      imdbId: async () => 'tt0467905',
      recordResolve: async (_ref, result) => {
        recorded.push(result.ok);
      },
      channel: async () => (o.known === null || o.known === undefined ? null : { ...NOTHING, ...o.known }),
      channelFailed: async (_ref, kind) => {
        failed.push(kind);
      },
    },
    torrent: () => torrent,
    sessions: new SessionStore(() => NOW),
    now: () => NOW,
    log: () => undefined,
  });
  const app = new Hono();
  const movies = { host: 'host-a', repo: {}, tmdb: null, events: { changed: () => undefined } } as unknown as NonNullable<AppDeps['movies']>;
  app.route(
    '/',
    directStreamRoutes({
      directStream: svc,
      movies,
      ...(o.site === undefined
        ? {}
        : {
            streaming: async (site: string, args: string[]) => {
              siteRuns.push([site, args]);
              return o.site;
            },
          }),
    }),
  );
  const flag = (args: string[], name: string): string | null => (args.includes(name) ? args[args.indexOf(name) + 1]! : null);
  return { app, finds, failed, recorded, siteRuns, sitePlays, asked: () => resolves.map((a) => ({ only: flag(a, '--only'), skip: flag(a, '--skip') })) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: Hono, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request('/api/stream/play', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

describe('a play with no provider named asks what streamed the title last time', () => {
  it('asks the remembered cloud provider alone, and no other when it has a stream', async () => {
    const t = setup({ known: { channel: 'cloud', provider: 'Beta', playedAt: daysAgo(2) }, resolve: { Beta: resolved('Beta'), all: resolved('Alpha') } });
    const { status, json } = await post(t.app, PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Beta');
    expect(t.asked()).toEqual([{ only: 'Beta', skip: null }]);
    expect(t.recorded).toEqual([true]);
    expect(t.finds).not.toHaveBeenCalled();
  });

  it('asks the others, without it, when the remembered provider has no stream now, and marks nothing stale for that', async () => {
    const t = setup({ known: { channel: 'cloud', provider: 'Beta', playedAt: daysAgo(2) }, resolve: { Beta: noSource('Beta'), all: resolved('Alpha') } });
    const { status, json } = await post(t.app, PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Alpha');
    expect(t.asked()).toEqual([{ only: 'Beta', skip: null }, { only: null, skip: 'Beta' }]);
    expect(json.attempts.map((a: { provider: string; outcome: string }) => `${a.provider} ${a.outcome}`)).toEqual(['Beta no_stream', 'Alpha resolved']);
    // Only the search that found a source is recorded: the remembered provider's failure says nothing of the title.
    expect(t.recorded).toEqual([true]);
    expect(t.failed).toEqual([]);
  });

  it('goes to the torrents first when a torrent streamed it last time, and asks no cloud provider', async () => {
    const t = setup({ known: { channel: 'torrent', infoHash: h(9), playedAt: daysAgo(1) }, resolve: { all: resolved('Alpha') } });
    const { status, json } = await post(t.app, PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Torrent');
    expect(t.asked()).toEqual([]);
    expect(t.finds).toHaveBeenCalledTimes(1);
  });

  it('asks the cloud providers when the remembered torrents have nothing now, and keeps that the torrents failed', async () => {
    const t = setup({ known: { channel: 'torrent', playedAt: daysAgo(1) }, torrentHasIt: false, resolve: { all: resolved('Alpha') } });
    const { status, json } = await post(t.app, PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Alpha');
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Index: torrentio', 'Alpha']);
    expect(t.failed).toEqual(['torrent']);
  });

  it('a title never streamed whose cloud search just found nothing goes to the torrents first; an old failure does not count', async () => {
    const recent = setup({ known: { cloudFailedAt: daysAgo(1) }, resolve: { all: resolved('Alpha') } });
    expect((await post(recent.app, PLAY_FILM)).json.session.provider).toBe('Torrent');
    expect(recent.asked()).toEqual([]);

    const old = setup({ known: { cloudFailedAt: new Date(NOW.getTime() - CLOUD_FAILURE_KEEP_MS - 1000) }, resolve: { all: resolved('Alpha') } });
    expect((await post(old.app, PLAY_FILM)).json.session.provider).toBe('Alpha');

    // The torrents failed after the cloud providers did: nothing says they are the better try.
    const both = setup({ known: { cloudFailedAt: daysAgo(2), torrentFailedAt: daysAgo(1) }, resolve: { all: resolved('Alpha') } });
    expect((await post(both.app, PLAY_FILM)).json.session.provider).toBe('Alpha');
  });

  it('keeps that every cloud provider, and then every torrent, found nothing', async () => {
    const t = setup({ known: null, torrentHasIt: false });
    const { status, json } = await post(t.app, PLAY_FILM);
    expect(status).toBe(502);
    expect(json.error).toBe('no_source');
    expect(t.failed).toEqual(['cloud', 'torrent']);
  });

  it('a named source is asked whatever is remembered', async () => {
    const t = setup({ known: { channel: 'torrent', playedAt: daysAgo(1) }, resolve: { all: resolved('Alpha') } });
    const { json } = await post(t.app, { ...PLAY_FILM, provider: 'cloud' });
    expect(json.session.provider).toBe('Alpha');
    expect(t.finds).not.toHaveBeenCalled();

    const cloud = setup({ known: { channel: 'cloud', provider: 'Beta', playedAt: daysAgo(1) }, resolve: { Beta: resolved('Beta') } });
    expect((await post(cloud.app, { ...PLAY_FILM, provider: 'torrent' })).json.session.provider).toBe('Torrent');
    expect(cloud.asked()).toEqual([]);
  });
});

describe('a title last played on a streaming site', () => {
  const SITE = { channel: 'site' as const, provider: 'dramacool', siteUrl: 'https://dramacool9.com.ro/summer-vacation-2026', season: 1, episode: 3, playedAt: daysAgo(1) };

  it('plays there again: the episode asked for, from the title page the site returned', async () => {
    const t = setup({ known: SITE, site: { ok: true, play: { playing: true, fullscreen: true } }, resolve: { all: resolved('Alpha') } });
    const { status, json } = await post(t.app, PLAY_EPISODE);
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, site: 'dramacool', site_url: SITE.siteUrl, site_play: { playing: true, fullscreen: true } });
    expect(t.siteRuns).toEqual([['dramacool', ['--play-from', SITE.siteUrl, '--episode', '4', '--season', '1', '--no-report']]]);
    expect(t.asked()).toEqual([]);
  });

  it('is streamed the usual way when the site does not start it, when a source is named, and when the streaming tools are off', async () => {
    const stopped = setup({ known: SITE, site: { ok: false, play: { playing: false, skipped_play: 'no_episode' } }, resolve: { all: resolved('Alpha') } });
    expect((await post(stopped.app, PLAY_EPISODE)).json.session.provider).toBe('Alpha');
    expect(stopped.siteRuns).toHaveLength(1);

    const named = setup({ known: SITE, site: { ok: true, play: { playing: true } }, resolve: { all: resolved('Alpha') } });
    expect((await post(named.app, { ...PLAY_EPISODE, provider: 'torrent' })).json.session.provider).toBe('Torrent');
    expect(named.siteRuns).toEqual([]);

    const off = setup({ known: SITE, resolve: { all: resolved('Alpha') } });
    expect((await post(off.app, PLAY_EPISODE)).json.session.provider).toBe('Alpha');
  });
});
