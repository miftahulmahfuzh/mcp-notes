import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, PLAY_OUTCOME_KEEP_MS, PLAY_OUTCOMES_MAX, PLAY_PAGE_GRACE_MS, playKey, type PlayResult } from '../../../src/directStream/service.js';
import type { CacheSubtitleView } from '../../../src/directStream/cachePlay.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import type { SubtitleTier } from '../../../src/directStream/torrent/subtitles/chain.js';
import { SUBTITLES_PENDING, TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { DirectStreamError } from '../../../src/directStream/types.js';
import { moviesPlayRoutes } from '../../../src/http/moviesPlayApi.js';
import { StreamLive } from '../../../src/movies/streamLive.js';
import type { AppDeps } from '../../../src/deps.js';

const FILM = { kind: 'movie' as const, tmdbId: 818647 };
const h = (n: number): string => n.toString(16).padStart(40, '0');
const MP4: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 800 }, audio: [{ codec: 'aac', lang: 'spa' }], subtitles: [], durationS: 6802, direct: true };
const RESOLVED = {
  ok: true,
  source: { provider: 'Alpha', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', subtitles: [], best_height: 1080 },
  attempts: [{ provider: 'Alpha', outcome: 'resolved', took_s: 1, detail: '' }],
};
const NO_SOURCE = { ok: false, error: 'no_source', detail: '', attempts: [{ provider: 'Alpha', outcome: 'no_stream', took_s: 2, detail: 'nothing' }] };

const candidate = (infoHash: string, name: string): TorrentCandidate => ({
  infoHash, name, fileName: null, fileIdx: null, seeds: 16, sizeBytes: 2_244_598_101, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: false, release: parseRelease(name),
});

function gate(): { open: () => void; wait: Promise<void> } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

interface Setup {
  /** Held until opened: the cloud resolve, or the torrent's file list. */
  hold?: Promise<void>;
  resolve?: unknown;
  failOpen?: boolean;
  tiers?: SubtitleTier[];
}

function setup(o: Setup = {}) {
  let now = Date.parse('2026-11-16T20:46:14.000Z');
  const logged: string[] = [];
  const runs: string[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      await o.hold;
      if (o.failOpen === true) throw new Error('no metadata within 20 s');
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.mp4', name: 'Film.mp4', length: 2_244_598_101 }] };
    },
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const answer: FindAnswer = {
    candidates: [candidate(h(1), 'Through My Window 2022 1080p WEBRip')],
    indexes: [
      { index: 'torrentio', outcome: 'ok', detail: '53 listed', took_s: 0.3, listed: 53 },
      { index: 'yts', outcome: 'error', detail: 'timed out after 6 s', took_s: 6, listed: 0 },
    ],
    excluded: [],
    lastResort: [],
  };
  const torrent = new TorrentSource({ swarm, find: async () => answer, probe: async () => MP4, tiers: o.tiers ?? [], subtitleHeadMs: 5, localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      runs.push(args[0] ?? '');
      if (args[0] === 'open') return { ok: true };
      await o.hold;
      return o.resolve ?? RESOLVED;
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'es', imdbId: async () => 'tt11703710', titleLabel: async () => 'Through My Window (2022)' },
    torrent: () => torrent,
    now: () => new Date(now),
    log: (line) => void logged.push(line),
  });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return { svc, logged, runs, tick, advance: (ms: number) => void (now += ms) };
}

describe('a play that is being started counts as busy', () => {
  it('lists a torrent play in flight in starting, with the title, since when and what is being tried', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    expect(t.svc.starting()).toEqual([]);
    const play = t.svc.play(FILM, { provider: 'torrent' });
    await t.tick();
    expect(t.svc.starting()).toEqual([
      { kind: 'movie', tmdb_id: 818647, season: null, episode: null, title: 'Through My Window (2022)', provider: 'torrent', since: '2026-11-16T20:46:14.000Z', stage: 'opening 1 torrent: Through My Window 2022 1080p WEBRip' },
    ]);
    held.open();
    const played = (await play) as PlayResult;
    // Opened, and the page has not reported yet: still starting, until it reports or the grace is over.
    expect(t.svc.starting().map((s) => s.stage)).toEqual(['opened: waiting for the player page']);
    expect(t.svc.starting(played.session.session_id)).toEqual([]);
  });

  it('a cloud resolve in flight is starting too, and stops being so a while after its page opened', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    const play = t.svc.play(FILM, { provider: 'cloud' });
    await t.tick();
    expect(t.svc.starting().map((s) => [s.provider, s.stage])).toEqual([['cloud', 'asking the cloud providers']]);
    held.open();
    await play;
    t.advance(PLAY_PAGE_GRACE_MS - 1);
    expect(t.svc.starting()).toHaveLength(1);
    t.advance(1);
    expect(t.svc.starting()).toEqual([]);
  });

  it('a page that says it closed has reported: its play is not starting any more', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'torrent' })) as PlayResult;
    expect(t.svc.starting()).toHaveLength(1);
    t.svc.letGo(played.session.session_id);
    expect(t.svc.starting()).toEqual([]);
  });

  it('a play that failed is not starting any more', async () => {
    const t = setup({ failOpen: true });
    await expect(t.svc.play(FILM, { provider: 'torrent' })).rejects.toMatchObject({ code: 'no_source' });
    expect(t.svc.starting()).toEqual([]);
  });

  it('GET /api/movies/player answers starting and busy while no stream reports yet', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    const app = new Hono();
    app.route('/', moviesPlayRoutes({ db: {} as AppDeps['db'], moviesPlayer: null, streamLive: new StreamLive(), directStream: t.svc }));
    const read = async (): Promise<{ stream: unknown; starting: Array<{ title: string }>; busy: boolean }> => (await (await app.request('/api/movies/player')).json()) as { stream: unknown; starting: Array<{ title: string }>; busy: boolean };
    expect(await read()).toMatchObject({ stream: null, starting: [], busy: false });
    const play = t.svc.play(FILM, { provider: 'torrent' });
    await t.tick();
    const during = await read();
    expect(during.stream).toBeNull();
    expect(during.busy).toBe(true);
    expect(during.starting.map((s) => s.title)).toEqual(['Through My Window (2022)']);
    held.open();
    await play;
  });
});

describe('playWithin: the caller is answered before it gives up', () => {
  it('answers pending with the stage and the attempts so far, and the play goes on and opens the page by itself', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    const first = await t.svc.playWithin(FILM, { provider: 'torrent' }, 20);
    expect(first).toMatchObject({ pending: true, since: '2026-11-16T20:46:14.000Z', stage: 'opening 1 torrent: Through My Window 2022 1080p WEBRip' });
    expect(first.pending && first.attempts.map((a) => [a.provider, a.outcome])).toEqual([['Index: torrentio', 'resolved'], ['Index: yts', 'error']]);
    expect(t.runs).toEqual([]);
    held.open();
    await t.tick();
    await t.tick();
    expect(t.runs).toEqual(['open']);
    // Asked again: the outcome of that play, not a second play.
    const second = await t.svc.playWithin(FILM, { provider: 'torrent' }, 20);
    expect(second.pending).toBe(false);
    expect(!second.pending && (second.result as PlayResult).session.provider).toBe('Torrent');
    expect(t.runs).toEqual(['open']);
  });

  it('the same call while the play is in flight joins it: one resolve, one page', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    const a = await t.svc.playWithin(FILM, {}, 10);
    const b = t.svc.playWithin(FILM, {}, 5_000);
    expect(a.pending).toBe(true);
    held.open();
    const done = await b;
    expect(done.pending).toBe(false);
    expect(t.runs).toEqual(['resolve', 'open']);
  });

  it('a play fast enough is answered as before', async () => {
    const t = setup();
    const out = await t.svc.playWithin(FILM, { provider: 'cloud' }, 5_000);
    expect(!out.pending && (out.result as PlayResult).session.provider).toBe('Alpha');
  });

  it('a pending play that fails keeps its error for the next ask, and its attempts are in the log either way', async () => {
    const held = gate();
    const t = setup({ hold: held.wait, failOpen: true });
    expect((await t.svc.playWithin(FILM, { provider: 'torrent' }, 10)).pending).toBe(true);
    held.open();
    await t.tick();
    await t.tick();
    expect(t.logged).toEqual([
      '[notesd] direct stream: play of TMDB movie 818647 (torrent) started nothing after 0 s: no_source, 4 attempt(s)',
      '[notesd] direct stream:   attempt Index: torrentio: resolved after 0.3 s (53 listed)',
      '[notesd] direct stream:   attempt Index: yts: error after 6 s (timed out after 6 s)',
      '[notesd] direct stream:   attempt Torrent: Through My Window 2022 1080p WEBRip: no_stream after 0 s (no file list from the swarm in time (no metadata within 20 s))',
      '[notesd] direct stream:   attempt Torrents: not tried yet: skipped (every torrent found was tried; asking again starts over with the ones whose swarm did not deliver)',
    ]);
    const again = t.svc.playWithin(FILM, { provider: 'torrent' }, 10);
    await expect(again).rejects.toBeInstanceOf(DirectStreamError);
    await expect(again).rejects.toMatchObject({ code: 'no_source' });
  });

  it('a failed play nobody waited for is logged with every attempt too (a cloud no_source, then the torrents)', async () => {
    const t = setup({ resolve: NO_SOURCE, failOpen: true });
    await expect(t.svc.play(FILM)).rejects.toMatchObject({ code: 'no_source' });
    const lines = t.logged.filter((l) => l.includes('attempt ') || l.includes('started nothing'));
    expect(lines[0]).toBe('[notesd] direct stream: play of TMDB movie 818647 started nothing after 0 s: no_source, 5 attempt(s)');
    expect(lines[1]).toBe('[notesd] direct stream:   attempt Alpha: no_stream after 2 s (nothing)');
    expect(lines).toHaveLength(6);
  });
});

describe('one play in flight per title, named provider and pasted magnet', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  it('keys a pasted magnet by its info hash, however it is written', () => {
    expect(playKey(FILM, null, A)).toBe(playKey(FILM, null, `magnet:?xt=urn:btih:${A.toUpperCase()}&dn=Film&tr=udp%3A%2F%2Ft.example%3A1337`));
    expect(playKey(FILM, null, A)).not.toBe(playKey(FILM, null, B));
    expect(playKey(FILM, null, A)).not.toBe(playKey(FILM, null));
    expect(playKey(FILM, 'Torrent')).toBe(playKey(FILM, ' torrent '));
    expect(playKey({ kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, null)).not.toBe(playKey({ kind: 'tv', tmdbId: 1, season: 1, episode: 3 }, null));
  });

  it('a second pasted magnet for the same title is its own play; the same magnet again joins the first', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    const first = t.svc.play(FILM, { magnet: A });
    const same = t.svc.play(FILM, { magnet: `magnet:?xt=urn:btih:${A}` });
    const other = t.svc.play(FILM, { magnet: B });
    await t.tick();
    expect(t.svc.starting()).toHaveLength(2);
    held.open();
    const [one, again, two] = await Promise.all([first, same, other]);
    expect(again).toBe(one);
    expect((one as PlayResult).session.torrent?.info_hash).toBe(A);
    expect((two as PlayResult).session.torrent?.info_hash).toBe(B);
    expect(t.runs).toEqual(['open', 'open']);
  });
});

describe('the outcomes kept for plays answered pending', () => {
  const film = (n: number) => ({ kind: 'movie' as const, tmdbId: 1000 + n });
  const settle = async (t: ReturnType<typeof setup>, opens: number): Promise<void> => {
    for (let i = 0; i < 500 && t.runs.filter((r) => r === 'open').length < opens; i++) await t.tick();
  };

  it('keeps at most PLAY_OUTCOMES_MAX of them, the oldest going first', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    const many = PLAY_OUTCOMES_MAX + 5;
    for (let n = 0; n < many; n++) expect((await t.svc.playWithin(film(n), { provider: 'cloud' }, 0)).pending).toBe(true);
    held.open();
    await settle(t, many);
    await t.tick();
    const resolves = () => t.runs.filter((r) => r === 'resolve').length;
    expect(resolves()).toBe(many);
    // Past the grace: none of them counts as starting any more, so an ask reads the kept outcome or plays anew.
    t.advance(PLAY_PAGE_GRACE_MS);
    expect(t.svc.starting()).toEqual([]);
    // The newest outcome is still kept: asked again, it answers with no second play.
    expect((await t.svc.playWithin(film(many - 1), { provider: 'cloud' }, 5_000)).pending).toBe(false);
    expect(resolves()).toBe(many);
    // The oldest was dropped: asked again, the title is played anew.
    expect((await t.svc.playWithin(film(0), { provider: 'cloud' }, 5_000)).pending).toBe(false);
    expect(resolves()).toBe(many + 1);
  });

  it('forgets an outcome nobody asked for again within PLAY_OUTCOME_KEEP_MS', async () => {
    const held = gate();
    const t = setup({ hold: held.wait });
    expect((await t.svc.playWithin(film(1), { provider: 'cloud' }, 0)).pending).toBe(true);
    held.open();
    await settle(t, 1);
    await t.tick();
    t.advance(PLAY_OUTCOME_KEEP_MS);
    expect(t.svc.starting()).toEqual([]);
    expect((await t.svc.playWithin(film(1), { provider: 'cloud' }, 5_000)).pending).toBe(false);
    expect(t.runs.filter((r) => r === 'resolve')).toHaveLength(2);
  });
});

describe('a torrent session answered before its subtitles', () => {
  it("replaces Subtitles: pending in the session's attempts once the chain has ended", async () => {
    const view: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/service-wyzie-1.vtt`, lang: 'en', label: 'English (Wyzie)' };
    const slow: SubtitleTier = { name: 'service', blocks: true, find: async () => (await new Promise((r) => setTimeout(r, 40)), [view]) };
    const t = setup({ tiers: [slow] });
    const played = (await t.svc.play(FILM, { provider: 'torrent' })) as PlayResult;
    expect(played.attempts.map((a) => a.provider)).toContain(SUBTITLES_PENDING);
    expect(played.session.subtitles).toEqual([]);
    expect(played.session.subtitle_rev).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    const info = await t.svc.info(played.session.session_id);
    expect(info?.subtitle_rev).toBe(1);
    expect(info?.subtitles.map((s) => s.label)).toEqual(['English (Wyzie)']);
    expect(t.svc.session(played.session.session_id)?.attempts.map((a) => a.provider)).toEqual(['Index: torrentio', 'Index: yts', 'Torrent: Through My Window 2022 1080p WEBRip', 'Subtitles: service']);
  });
});
