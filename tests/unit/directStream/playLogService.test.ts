import { describe, expect, it } from 'vitest';
import { PlayLog } from '../../../src/directStream/playLog/log.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, type DirectStreamHooks, type PlayResult } from '../../../src/directStream/service.js';
import { SESSION_IDLE_MS, SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { DirectStreamError } from '../../../src/directStream/types.js';
import { MemoryPlayLog } from '../../helpers/memoryPlayLog.js';

const FILM = { kind: 'movie' as const, tmdbId: 818647 };
const EPISODE = { kind: 'tv' as const, tmdbId: 1399, season: 1, episode: 1 };
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

function setup(o: { resolve?: unknown; failOpen?: boolean; hooks?: DirectStreamHooks; failWrites?: boolean } = {}) {
  let now = Date.parse('2026-11-27T10:00:00.000Z');
  const clock = (): Date => new Date(now);
  const logged: string[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
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
    indexes: [{ index: 'torrentio', outcome: 'ok', detail: '53 listed', took_s: 0.3, listed: 53 }],
    excluded: [],
    lastResort: [],
  };
  const torrent = new TorrentSource({ swarm, find: async () => answer, probe: async () => MP4, tiers: [], subtitleHeadMs: 5, localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const repo = new MemoryPlayLog();
  if (o.failWrites === true) repo.failWith = new Error('connect ECONNREFUSED 127.0.0.1:55437');
  const playLog = new PlayLog({ repo, host: 'host-a', now: clock, log: (line) => void logged.push(line) });
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => (args[0] === 'open' ? { ok: true } : (o.resolve ?? RESOLVED)),
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'es', imdbId: async () => 'tt11703710', titleLabel: async () => 'Through My Window (2022)', ...o.hooks },
    torrent: () => torrent,
    sessions: new SessionStore(clock),
    playLog,
    now: clock,
    log: (line) => void logged.push(line),
  });
  return { svc, repo, playLog, logged, advance: (ms: number) => void (now += ms) };
}

describe('the service writes the play log', () => {
  it('a cloud play answered: one row with the ask, the session, the channel, the provider and the height', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    await t.playLog.settled();
    expect(t.repo.rows).toEqual([
      expect.objectContaining({ via: 'play', kind: 'movie', tmdbId: 818647, asked: 'cloud', outcome: 'no_picture', session: played.session.session_id, channel: 'cloud', providerFirst: 'Alpha', height: 1080, resolveMs: 0 }),
    ]);
  });

  it('a torrent play answered: its info hash, the index that listed it, the seeds listed and the height', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'torrent' })) as PlayResult;
    await t.playLog.settled();
    expect(t.repo.bySession(played.session.session_id)).toMatchObject({ asked: 'torrent', channel: 'torrent', infoHash: h(1), torrentIndex: 'torrentio', seeds: 16, height: 800 });
  });

  it('a cloud play that found nothing: a failed row, the cloud word, the torrents not asked', async () => {
    const t = setup({ resolve: NO_SOURCE });
    await expect(t.svc.play(FILM, { provider: 'cloud' })).rejects.toBeInstanceOf(DirectStreamError);
    await t.playLog.settled();
    expect(t.repo.rows).toEqual([expect.objectContaining({ outcome: 'failed', failure: 'no_source', asked: 'cloud', cloudFailure: 'no_stream', torrentFailure: null })]);
  });

  it('a torrent play whose torrent did not open: a failed row with the torrent word and no cloud word', async () => {
    const t = setup({ failOpen: true });
    await expect(t.svc.play(FILM, { provider: 'torrent' })).rejects.toBeInstanceOf(DirectStreamError);
    await t.playLog.settled();
    const row = t.repo.rows[0];
    expect(row).toMatchObject({ outcome: 'failed', asked: 'torrent', cloudFailure: null });
    expect(row?.torrentFailure ?? null).not.toBeNull();
  });

  it('a page carrying on after a restart is a continue row; the next episode is an episode row', async () => {
    const t = setup({ hooks: { neighbors: async () => ({ prev: null, next: { season: 1, episode: 2 } }) } });
    const going = await t.svc.continueSession(FILM, { was: 'lost-session', provider: 'Alpha', positionS: 600 });
    const episode = (await t.svc.play(EPISODE, { provider: 'cloud' })) as PlayResult;
    const next = await t.svc.switchEpisode(episode.session.session_id, 'next');
    await t.playLog.settled();
    expect(t.repo.bySession(going.session.session_id)).toMatchObject({ via: 'continue', asked: null, providerFirst: 'Alpha' });
    expect(t.repo.bySession(next.session_id)).toMatchObject({ via: 'episode', kind: 'tv', season: 1, episode: 2 });
  });

  it('the owner asking for another source counts as an owner switch', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    expect((await t.svc.switchSource(played.session.session_id)).switched).toBe(true);
    await t.playLog.settled();
    expect(t.repo.bySession(played.session.session_id)).toMatchObject({ ownerSwitches: 1, autoSwitches: 0 });
  });

  it('a session the store drops is closed as expired', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    t.advance(SESSION_IDLE_MS);
    expect(t.svc.session(played.session.session_id)).toBeNull();
    await t.playLog.settled();
    expect(t.repo.bySession(played.session.session_id)).toMatchObject({ ended: 'expired' });
  });

  it('a log whose database is down never fails, delays or changes the play', async () => {
    const t = setup({ failWrites: true });
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    expect(played.session.provider).toBe('Alpha');
    await t.playLog.settled();
    expect(t.logged.filter((l) => l.startsWith('[notesd] play log:'))).toEqual(['[notesd] play log: an answered play was not written: connect ECONNREFUSED 127.0.0.1:55437']);
  });
});
