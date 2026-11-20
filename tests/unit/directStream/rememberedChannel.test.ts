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
import { siteFallback, sitesToAsk } from '../../../src/streaming/fallback.js';

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
  /** Torrents whose swarm answers nothing. */
  deadHashes?: string[];
  /** What the streaming command answers, or answers per site and arguments; unset: no streaming runner, so no site is asked. */
  site?: unknown;
  /** Held until opened: the streaming command's answer. */
  holdSite?: Promise<void>;
}

function setup(o: Setup = {}) {
  const resolves: string[][] = [];
  const failed: string[] = [];
  const recorded: unknown[] = [];
  const siteRuns: Array<[string, string[]]> = [];
  const opened: string[] = [];
  const sitePlays: unknown[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      opened.push(pick.infoHash);
      if ((o.deadHashes ?? []).includes(pick.infoHash)) throw new Error('no peers');
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.720p.mp4', name: 'Film.2026.720p.mp4', length: 1_000_000 }] };
    },
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
  const channel = async (): Promise<RememberedChannel | null> => (o.known === null || o.known === undefined ? null : { ...NOTHING, ...o.known });
  const siteLog: string[] = [];
  const fallback =
    o.site === undefined
      ? null
      : siteFallback({
          runner: async (site, args) => {
            siteRuns.push([site, args]);
            await o.holdSite;
            return typeof o.site === 'function' ? (o.site as (site: string, args: string[]) => unknown)(site, args) : o.site;
          },
          remembered: channel,
          title: async () => ({ title: 'Summer Vacation', year: 2026 }),
          streams: {
            recordSitePlay: async (ref, site, url) => {
              sitePlays.push([ref, site, url]);
              return { titleId: 'tv-335951', playId: 1 };
            },
          },
          now: () => NOW.getTime(),
          log: (line) => void siteLog.push(line),
        });
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
      channel,
      channelFailed: async (_ref, kind) => {
        failed.push(kind);
      },
    },
    torrent: () => torrent,
    siteFallback: fallback,
    sessions: new SessionStore(() => NOW),
    now: () => NOW,
    log: () => undefined,
  });
  const app = new Hono();
  const movies = { host: 'host-a', repo: {}, tmdb: null, events: { changed: () => undefined } } as unknown as NonNullable<AppDeps['movies']>;
  app.route('/', directStreamRoutes({ directStream: svc, movies }));
  const flag = (args: string[], name: string): string | null => (args.includes(name) ? args[args.indexOf(name) + 1]! : null);
  return { app, svc, finds, failed, recorded, siteRuns, sitePlays, siteLog, opened, asked: () => resolves.map((a) => ({ only: flag(a, '--only'), skip: flag(a, '--skip') })) };
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
    const t = setup({ known: { channel: 'torrent', playedAt: daysAgo(1) }, resolve: { all: resolved('Alpha') } });
    const { status, json } = await post(t.app, PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Torrent');
    expect(t.asked()).toEqual([]);
    expect(t.finds).toHaveBeenCalledTimes(1);
  });

  it('opens the very torrent that played the film last time, with no index asked; the indexes only when its swarm is gone', async () => {
    const same = setup({ known: { channel: 'torrent', infoHash: h(9), playedAt: daysAgo(1) } });
    const { json } = await post(same.app, PLAY_FILM);
    expect(json.session.torrent.info_hash).toBe(h(9));
    expect(same.finds).not.toHaveBeenCalled();
    expect(same.asked()).toEqual([]);

    const gone = setup({ known: { channel: 'torrent', infoHash: h(9), playedAt: daysAgo(1) }, deadHashes: [h(9)] });
    const after = await post(gone.app, PLAY_FILM);
    expect(after.json.session.torrent.info_hash).toBe(h(1));
    expect(gone.finds).toHaveBeenCalledTimes(1);
    expect(gone.opened[0]).toBe(h(9));

    // Another episode than the one that torrent held: the indexes are asked for this one.
    const other = setup({ known: { channel: 'torrent', infoHash: h(9), season: 1, episode: 3, playedAt: daysAgo(1) } });
    await post(other.app, PLAY_EPISODE);
    expect(other.opened).not.toContain(h(9));
    expect(other.finds).toHaveBeenCalledTimes(1);
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

describe('a named method goes to what last played the title through that method', () => {
  const method = (over: Partial<NonNullable<RememberedChannel['methods']>[string]>) => ({ provider: null, infoHash: null, siteUrl: null, season: null, episode: null, playedAt: daysAgo(3), ...over });

  it('"torrent" opens the torrent that played the film, though a cloud provider played it since; the indexes only when its swarm is gone', async () => {
    const known = { channel: 'cloud' as const, provider: 'Beta', playedAt: daysAgo(1), methods: { torrent: method({ infoHash: h(9) }), cloud: method({ provider: 'Beta' }) } };
    const same = setup({ known });
    const { json } = await post(same.app, { ...PLAY_FILM, provider: 'torrent' });
    expect(json.session.torrent.info_hash).toBe(h(9));
    expect(same.finds).not.toHaveBeenCalled();
    expect(same.asked()).toEqual([]);

    const gone = setup({ known, deadHashes: [h(9)] });
    expect((await post(gone.app, { ...PLAY_FILM, provider: 'torrent' })).json.session.torrent.info_hash).toBe(h(1));
    expect(gone.opened[0]).toBe(h(9));
    expect(gone.finds).toHaveBeenCalledTimes(1);

    // The torrent of another episode does not hold this one: the indexes are asked.
    const other = setup({ known: { ...known, methods: { torrent: method({ infoHash: h(9), season: 1, episode: 3 }) } } });
    await post(other.app, { ...PLAY_EPISODE, provider: 'torrent' });
    expect(other.opened).not.toContain(h(9));
    expect(other.finds).toHaveBeenCalledTimes(1);
  });

  it('"cloud" asks the provider that streamed it first, though a torrent played it since; then the others, without it, and never a torrent', async () => {
    const known = { channel: 'torrent' as const, infoHash: h(9), playedAt: daysAgo(1), methods: { cloud: method({ provider: 'Beta' }), torrent: method({ infoHash: h(9) }) } };
    const again = setup({ known, resolve: { Beta: resolved('Beta'), all: resolved('Alpha') } });
    expect((await post(again.app, { ...PLAY_FILM, provider: 'cloud' })).json.session.provider).toBe('Beta');
    expect(again.asked()).toEqual([{ only: 'Beta', skip: null }]);

    const moved = setup({ known, resolve: { Beta: noSource('Beta'), all: resolved('Alpha') } });
    expect((await post(moved.app, { ...PLAY_FILM, provider: 'cloud' })).json.session.provider).toBe('Alpha');
    expect(moved.asked()).toEqual([{ only: 'Beta', skip: null }, { only: null, skip: 'Beta' }]);
    expect(moved.opened).toEqual([]);

    const none = setup({ known, resolve: { Beta: noSource('Beta'), all: noSource('Alpha') } });
    expect((await post(none.app, { ...PLAY_FILM, provider: 'cloud' })).status).toBe(502);
    expect(none.finds).not.toHaveBeenCalled();
    expect(none.failed).toEqual(['cloud']);
  });
});

const PLAYING = { ok: true, play: { playing: true, fullscreen: true } };
const EPISODE_REF = { kind: 'tv' as const, tmdbId: 335951, season: 1, episode: 4 };
const sitesOf = (attempts: Array<{ provider: string; outcome: string }>): string[] => attempts.filter((a) => a.provider.startsWith('Site: ')).map((a) => `${a.provider} ${a.outcome}`);

describe('the streaming sites are the last resort, after direct streaming found nothing', () => {
  const SITE = { channel: 'site' as const, provider: 'dramacool', siteUrl: 'https://dramacool9.com.ro/summer-vacation-2026', season: 1, episode: 3, playedAt: daysAgo(1) };

  it('a title last played on a site plays from a cloud provider that has it, and no site is asked', async () => {
    const t = setup({ known: SITE, site: PLAYING, resolve: { all: resolved('Alpha') } });
    const { status, json } = await post(t.app, PLAY_EPISODE);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Alpha');
    // The site channel remembers nothing for direct streaming: every cloud provider is asked, none skipped.
    expect(t.asked()).toEqual([{ only: null, skip: null }]);
    expect(t.siteRuns).toEqual([]);
  });

  it('a site channel does not keep the torrents from being asked when no cloud provider has it', async () => {
    const t = setup({ known: SITE, site: PLAYING, resolve: { all: noSource('Alpha') } });
    const { json } = await post(t.app, PLAY_EPISODE);
    expect(json.session.provider).toBe('Torrent');
    expect(t.finds).toHaveBeenCalledTimes(1);
    expect(t.siteRuns).toEqual([]);
  });

  it('when every cloud provider and every torrent found nothing, the site it was last played on plays it from its page there', async () => {
    const t = setup({ known: SITE, site: PLAYING, torrentHasIt: false });
    const { status, json } = await post(t.app, PLAY_EPISODE);
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, site: 'dramacool', site_url: SITE.siteUrl, site_play: { playing: true, fullscreen: true } });
    expect(json.session).toBeUndefined();
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Alpha', 'Index: torrentio', 'Site: dramacool']);
    expect(t.siteRuns).toEqual([['dramacool', ['--play-from', SITE.siteUrl, '--episode', '4', '--season', '1', '--no-report']]]);
    // A play from a remembered page is kept here; the command was told not to report it.
    expect(t.sitePlays).toEqual([[EPISODE_REF, 'dramacool', SITE.siteUrl]]);
    expect(t.failed).toEqual(['cloud', 'torrent']);
    expect(t.siteLog).toEqual(['[notesd] streaming: asked dramacool for Summer Vacation (2026) S1E4 at the page it played from last time: playing after 0 s']);
  });

  it('with no site remembered, the sites are searched in order and the first single match plays; several matches are never guessed', async () => {
    const t = setup({
      known: null,
      torrentHasIt: false,
      site: (site: string) =>
        site === 'idlix'
          ? { ok: true, play: { playing: false, skipped_play: 'several_matches' } }
          : { ok: true, play: { playing: true, fullscreen: true, url: `https://${site}.example/summer-vacation-2026` } },
    });
    const { status, json } = await post(t.app, PLAY_FILM);
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, site: 'lk21', site_url: 'https://lk21.example/summer-vacation-2026' });
    expect(t.siteRuns).toEqual([
      ['idlix', ['--play', 'Summer Vacation', '2026']],
      ['lk21', ['--play', 'Summer Vacation', '2026']],
    ]);
    expect(sitesOf(json.attempts)).toEqual(['Site: idlix skipped', 'Site: lk21 resolved']);
    // A search play is reported by the command itself, not here.
    expect(t.sitePlays).toEqual([]);
  });

  it('when no site starts it either, the play fails no_source with every site in its attempts', async () => {
    const t = setup({ known: null, torrentHasIt: false, site: { ok: true, play: { playing: false, skipped_play: 'no_match' } } });
    const { status, json } = await post(t.app, PLAY_EPISODE);
    expect(status).toBe(502);
    expect(json.error).toBe('no_source');
    // An episode: idlix, then dramacool; lk21 and flicksy start no episode.
    expect(t.siteRuns.map(([site]) => site)).toEqual(['idlix', 'dramacool']);
    expect(sitesOf(json.attempts)).toEqual(['Site: idlix no_stream', 'Site: dramacool no_stream']);
  });

  it('a remembered page that no longer plays is searched on that site, then the others follow', async () => {
    const t = setup({
      known: { channel: 'site', provider: 'flicksy', siteUrl: 'https://flicksy.pro/watch/movie/467905', playedAt: daysAgo(1) },
      torrentHasIt: false,
      site: (site: string, args: string[]) => (site === 'idlix' && args[0] === '--play' ? PLAYING : { ok: false, play: { playing: false, skipped_play: 'no_match' } }),
    });
    const { json } = await post(t.app, PLAY_FILM);
    expect(json.site).toBe('idlix');
    expect(t.siteRuns).toEqual([
      ['flicksy', ['--play-url', 'https://flicksy.pro/watch/movie/467905', '--no-report']],
      ['flicksy', ['--play', 'Summer Vacation', '2026']],
      ['idlix', ['--play', 'Summer Vacation', '2026']],
    ]);
  });

  it('a named provider, a codename kind or a magnet never asks a site', async () => {
    for (const named of [{ provider: 'Alpha' }, { provider: 'cloud' }, { provider: 'torrent' }, { magnet: `magnet:?xt=urn:btih:${h(7)}` }]) {
      const t = setup({ known: SITE, site: PLAYING, torrentHasIt: false, deadHashes: [h(7)] });
      const { status } = await post(t.app, { ...PLAY_EPISODE, ...named });
      expect(status).toBe(502);
      expect(t.siteRuns).toEqual([]);
    }
  });

  it('without the streaming tools a play that found nothing fails as before', async () => {
    const t = setup({ known: SITE, torrentHasIt: false });
    const { status, json } = await post(t.app, PLAY_EPISODE);
    expect(status).toBe(502);
    expect(json.error).toBe('no_source');
    expect(sitesOf(json.attempts)).toEqual([]);
  });

  it('a pending play that fails later still goes to the sites; an ask meanwhile joins it, and the next ask reads its outcome', async () => {
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const t = setup({ known: SITE, site: PLAYING, torrentHasIt: false, holdSite: held });
    const first = await t.svc.playWithin(EPISODE_REF, {}, 0);
    expect(first.pending).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    // Direct streaming has failed and the site is being asked: still starting, so the daemon is busy.
    expect(t.svc.starting().map((s) => s.stage)).toEqual(['asking dramacool, which played it last time: no cloud provider or torrent could stream it']);
    const joined = await t.svc.playWithin(EPISODE_REF, {}, 0);
    expect(joined.pending).toBe(true);
    expect(t.siteRuns).toHaveLength(1);
    open();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.siteRuns).toHaveLength(1);
    expect(t.svc.starting()).toEqual([]);
    const outcome = await t.svc.playWithin(EPISODE_REF, {}, 0);
    expect(outcome.pending).toBe(false);
    expect(!outcome.pending && outcome.result).toMatchObject({ site: 'dramacool', site_url: SITE.siteUrl });
    expect(t.finds).toHaveBeenCalledTimes(1);
  });
});

describe('sitesToAsk', () => {
  const at = (days: number, siteUrl: string | null) => ({ provider: null, infoHash: null, siteUrl, season: null, episode: null, playedAt: daysAgo(days) });

  it("puts the site last played on first, with its page, then the fixed order with each site's own remembered page", () => {
    expect(sitesToAsk({ kind: 'movie', tmdbId: 1 }, null)).toEqual([
      { site: 'idlix', known: null },
      { site: 'lk21', known: null },
      { site: 'flicksy', known: null },
    ]);
    expect(sitesToAsk({ kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, null).map((s) => s.site)).toEqual(['idlix', 'dramacool']);
    const known: RememberedChannel = { ...NOTHING, channel: 'cloud', provider: 'Beta', methods: { lk21: at(5, 'https://lk21.example/a'), idlix: at(9, 'https://idlix.example/a'), cloud: at(1, null) } };
    expect(sitesToAsk({ kind: 'movie', tmdbId: 1 }, known)).toEqual([
      { site: 'lk21', known: 'https://lk21.example/a' },
      { site: 'idlix', known: 'https://idlix.example/a' },
      { site: 'flicksy', known: null },
    ]);
  });
});
