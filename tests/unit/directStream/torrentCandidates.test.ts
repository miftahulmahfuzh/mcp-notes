import { describe, expect, it, vi } from 'vitest';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, type PlayResult } from '../../../src/directStream/service.js';
import type { RememberedChannel } from '../../../src/directStream/types.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { candidateFrom, parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import { MemoryTorrentMarks } from '../../../src/directStream/torrent/marks.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import type { StreamRef } from '../../../src/directStream/types.js';

/*
 * The torrent candidates of a title (the candidates list, direct_stream_torrents) and the owner's blacklist: what is
 * listed and how each row is tagged, and what a blacklist does to plays, memory and a play on screen.
 */

const EPISODE: StreamRef = { kind: 'tv', tmdbId: 313630, season: 1, episode: 7 };
const COLD = '67b07b417f6f8f7d367bbded3cd797a0840724b6';
const h = (n: number): string => n.toString(16).padStart(40, '0');
const PROBE: MediaProbe = { container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 2_400, direct: true };
const QUERY = { kind: 'tv' as const, imdbId: 'tt0000001', season: 1, episode: 7, title: 'Eternally Yours', originalLanguage: 'en' };

const candidate = (n: number, name = `Eternally.Yours.S01E07.${n === 1 ? '1080p' : '720p'}.WEB.h264-G${n}`): TorrentCandidate => ({
  infoHash: h(n),
  name,
  fileName: null,
  fileIdx: null,
  seeds: 50 - n,
  sizeBytes: 1_500_000_000,
  index: 'torrentio',
  listedBy: ['torrentio', 'knaben'],
  site: null,
  trackers: [],
  scoped: true,
  release: parseRelease(name, { title: 'Eternally Yours', originalLanguage: 'en' }),
});

function setup(o: { remembered?: string | null } = {}) {
  const logged: string[] = [];
  const forgotten: string[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => ({ infoHash: pick.infoHash, files: [{ index: 0, path: 'e07.mkv', name: 'e07.mkv', length: 1_000_000_000 }] }),
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
    stats: () => ({ peers: 9, down_kbps: 9_000 }),
    downloadsOf: async () => [{ infoHash: h(9), name: 'Old.Release', release: 'Eternally.Yours.S01E07.480p.Old', state: 'failed', error: 'no file list', playedAt: null, fileLength: 300_000_000 }],
  };
  const cold = candidateFrom({ infoHash: COLD, name: 'Eternally.Yours.S01E07.1080p.ColdFilm.mkv', seeds: 90, sizeBytes: 1_200_000_000 }, 'torrentio', QUERY, true);
  const finds = vi.fn(async (): Promise<FindAnswer> => ({
    candidates: [candidate(1), candidate(2)],
    indexes: [{ index: 'torrentio', outcome: 'ok', detail: '3 listed', took_s: 1, listed: 3 }],
    excluded: [{ infoHash: COLD, name: cold.name, index: 'torrentio', seeds: 90, reason: 'dubbed' }, { infoHash: h(7), name: 'Eternally.Yours.S01E07.CAM', index: 'apibay', seeds: 3, reason: 'cam' }],
    lastResort: [cold],
  }));
  const marks = new MemoryTorrentMarks();
  const torrent = new TorrentSource({ swarm, find: finds, probe: async () => PROBE, tiers: [], localBase: () => 'http://127.0.0.1:4321', marks, log: (l) => void logged.push(l) });
  const remembered = { hash: o.remembered === undefined ? COLD : o.remembered };
  const channel = async (): Promise<RememberedChannel | null> =>
    remembered.hash === null
      ? null
      : ({ channel: 'torrent', provider: null, infoHash: remembered.hash, siteUrl: null, season: 1, episode: 7, playedAt: new Date(), cloudFailedAt: null, torrentFailedAt: null, methods: { torrent: { provider: null, infoHash: remembered.hash, siteUrl: null, season: 1, episode: 7, playedAt: new Date() } } } as RememberedChannel);
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => (args[0] === 'open' ? { ok: true } : { ok: false, error: 'no_source', detail: '', attempts: [] }),
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: {
      originalLanguage: async () => 'en',
      imdbId: async () => 'tt0000001',
      channel,
      forgetTorrent: async (hash) => {
        forgotten.push(hash);
        if (remembered.hash === hash) remembered.hash = null;
        return ['M-8CBH'];
      },
    },
    checkHeadMs: 5,
    torrent: () => torrent,
    sessions: new SessionStore(),
    log: (line) => void logged.push(line),
  });
  return { svc, marks, finds, forgotten, logged, remembered };
}

describe('the torrent candidates of a title', () => {
  it('lists the indexes\' candidates, the dub-named ones, this machine\'s rows and the left-out ones, each tagged', async () => {
    const t = setup();
    await t.marks.noteHeard(COLD, null, 'ru', 0.97);
    const list = await t.svc.torrentCandidates(EPISODE);
    expect(list).toMatchObject({ ref: EPISODE, original_language: 'en', cached: false, indexes: [{ index: 'torrentio' }] });
    expect(list.candidates.map((c) => c.info_hash)).toEqual([h(1), h(2), COLD, h(9), h(7)]);
    const [first, , cold, old, cam] = list.candidates;
    expect(first).toMatchObject({ height: 1080, seeds: 49, from: ['torrentio', 'knaben'], worked: false, failed: null, blacklisted: null, dub_named: false, left_out: null, remembered: false });
    expect(cold).toMatchObject({ dub_group: 'ColdFilm', dub_named: true, heard_dub: true, remembered: true, worked: true, audio: { languages: ['ru'], how: 'heard' } });
    expect(old).toMatchObject({ from: ['played before'], failed: 'no file list', height: 480, size_bytes: 300_000_000 });
    expect(cam).toMatchObject({ left_out: 'cam', seeds: 3, from: ['apibay'] });
    // The indexes' answer is reused for ten minutes; fresh asks again.
    expect((await t.svc.torrentCandidates(EPISODE)).cached).toBe(true);
    expect(t.finds).toHaveBeenCalledTimes(1);
    await t.svc.torrentCandidates(EPISODE, { fresh: true });
    expect(t.finds).toHaveBeenCalledTimes(2);
  });

  it('a blacklist keeps the torrent out of every play and makes the title forget it', async () => {
    const t = setup();
    const done = await t.svc.blacklistTorrent(COLD.toUpperCase(), { reason: 'a Russian voice-over', name: 'Eternally.Yours.S01E07.1080p.ColdFilm.mkv' });
    expect(done).toMatchObject({ forgotten: ['M-8CBH'], moving: [], mark: { infoHash: COLD, blacklistReason: 'a Russian voice-over' } });
    expect(t.forgotten).toEqual([COLD]);
    const list = await t.svc.torrentCandidates(EPISODE);
    expect(list.candidates.find((c) => c.info_hash === COLD)?.blacklisted).toMatchObject({ reason: 'a Russian voice-over' });
    expect((await t.svc.blacklistedTorrents()).map((m) => m.infoHash)).toEqual([COLD]);
    expect(await t.svc.unblacklistTorrent(COLD)).toBe(true);
    expect(await t.svc.unblacklistTorrent(COLD)).toBe(false);
    await expect(t.svc.blacklistTorrent('nope')).rejects.toMatchObject({ code: 'bad_info_hash' });
  });

  it('a blacklisted remembered torrent is not opened again: Torrent Stream asks the indexes', async () => {
    const t = setup({ remembered: h(1) });
    await t.marks.blacklist(h(1), null, null);
    const played = (await t.svc.play(EPISODE, { provider: 'torrent' })) as PlayResult;
    expect(played.session.torrent?.info_hash).toBe(h(2));
    expect(t.logged.some((l) => l.includes('is blacklisted or was heard as a dub; asking the indexes'))).toBe(true);
  });

  it('blacklisting the torrent on screen moves the play at the next report, even a pasted one, and currentTorrent names it', async () => {
    const t = setup({ remembered: null });
    const played = (await t.svc.play(EPISODE, { magnet: h(1) })) as PlayResult;
    const id = played.session.session_id;
    expect(await t.svc.currentTorrent(EPISODE)).toEqual({ infoHash: h(1), name: expect.any(String) });
    const done = await t.svc.blacklistTorrent(h(1));
    expect(done.moving).toEqual([id]);
    t.svc.reported(id, { paused: false, over: false });
    await vi.waitFor(() => expect(t.svc.session(id)?.torrent?.infoHash).toBe(h(2)));
    expect(await t.svc.info(id)).toMatchObject({ source_note: 'the torrent was blacklisted' });
  });

  it('lists a pasted magnet with how its play went', async () => {
    const t = setup({ remembered: null });
    await t.svc.play(EPISODE, { magnet: h(5) });
    const row = (await t.svc.torrentCandidates(EPISODE)).candidates.find((c) => c.info_hash === h(5));
    expect(row).toMatchObject({ from: ['magnet'], worked: true, failed: null });
  });
});
