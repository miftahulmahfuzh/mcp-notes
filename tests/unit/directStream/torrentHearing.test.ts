import { describe, expect, it, vi } from 'vitest';
import type { AudioFinding } from '../../../src/directStream/audioLang.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, type PlayResult } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import { MemoryTorrentMarks } from '../../../src/directStream/torrent/marks.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { hearAt, TORRENT_HEAR_AFTER_S, TorrentSource, type FindAnswer, type TorrentHearer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

/*
 * The torrent audio check: a torrent whose file tags no audio language is heard behind the play (Whisper's detect,
 * faked here), what was heard is kept on the torrent, and a dub moves the play by itself; a pasted torrent stays.
 */

const EPISODE: StreamRef = { kind: 'tv', tmdbId: 313630, season: 1, episode: 7 };
const h = (n: number): string => n.toString(16).padStart(40, '0');
const untagged = (lang: string | null): MediaProbe => ({ container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang }], subtitles: [], durationS: 2_400, direct: true });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const candidate = (n: number): TorrentCandidate => {
  const name = `Eternally.Yours.S01E07.1080p.WEB.h264-G${n}`;
  return { infoHash: h(n), name, fileName: null, fileIdx: null, seeds: 50 - n, sizeBytes: 2_000_000_000, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: true, release: parseRelease(name) };
};

function setup(o: { heard?: Record<string, string>; tags?: string | null; torrents?: number } = {}) {
  const logged: string[] = [];
  const heardAt: Array<{ hash: string; atS: number }> = [];
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const hear: TorrentHearer = {
    async hear(source: ResolvedSource, audioLang: string, atS: number): Promise<AudioFinding> {
      const hash = /torrent\/([0-9a-f]{40})\//.exec(source.manifest_url)?.[1] ?? '';
      heardAt.push({ hash, atS });
      await gate;
      const spoken = o.heard?.[hash] ?? audioLang;
      return spoken === audioLang
        ? { verdict: 'original', detected: spoken, probability: 0.95, reason: `the audio is spoken ${spoken}, the original` }
        : { verdict: 'dubbed', detected: spoken, probability: 0.97, reason: `the audio is spoken ${spoken}, not the original ${audioLang}` };
    },
  };
  const swarm: TorrentSwarm = {
    open: async (pick) => ({ infoHash: pick.infoHash, files: [{ index: 0, path: 'Eternally.Yours.S01E07.mkv', name: 'Eternally.Yours.S01E07.mkv', length: 1_000_000_000 }] }),
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
    stats: () => ({ peers: 2, down_kbps: 50 }),
  };
  const listed = Array.from({ length: o.torrents ?? 3 }, (_, i) => candidate(i + 1));
  const finds = vi.fn(async (): Promise<FindAnswer> => ({ candidates: listed, indexes: [], excluded: [], lastResort: [] }));
  const marks = new MemoryTorrentMarks();
  const torrent = new TorrentSource({ swarm, find: finds, probe: async () => untagged(o.tags === undefined ? 'und' : o.tags), tiers: [], localBase: () => 'http://127.0.0.1:4321', marks, hear, log: (l) => void logged.push(l) });
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => (args[0] === 'open' ? { ok: true } : { ok: false, error: 'no_source', detail: '', attempts: [] }),
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'en', imdbId: async () => 'tt0000001' },
    checkHeadMs: 5,
    torrent: () => torrent,
    sessions: new SessionStore(),
    log: (line) => void logged.push(line),
  });
  return { svc, torrent, marks, logged, heardAt, open, finds };
}

describe('the torrent audio check', () => {
  it('hears a torrent whose file tags no language, keeps the dub on it, and moves the play by itself to the next torrent', async () => {
    const t = setup({ heard: { [h(1)]: 'ru' } });
    const played = (await t.svc.play(EPISODE, { provider: 'torrent' })) as PlayResult;
    const id = played.session.session_id;
    expect(played.session.torrent?.info_hash).toBe(h(1));
    // Heard behind the play: the answer did not wait for it.
    expect(t.heardAt.map((x) => x.hash)).toEqual([h(1)]);
    expect(t.heardAt[0]?.atS).toBe(TORRENT_HEAR_AFTER_S);
    t.open();
    await vi.waitFor(() => expect(t.marks.rows.get(h(1))?.heardLanguage).toBe('ru'));
    await tick();
    const attempt = t.svc.session(id)?.attempts.find((a) => a.provider.startsWith('Torrent: ') && a.outcome === 'resolved');
    expect(attempt?.detail).toContain('audio heard: dubbed (the audio is spoken ru, not the original en)');
    // The move waits for a report of the film playing.
    t.svc.reported(id, { paused: true, over: false });
    await tick();
    expect(t.svc.session(id)?.torrent?.infoHash).toBe(h(1));
    t.svc.reported(id, { paused: false, over: false });
    await vi.waitFor(() => expect(t.svc.session(id)?.torrent?.infoHash).toBe(h(2)));
    expect(await t.svc.info(id)).toMatchObject({ source_rev: 1, source_note: 'dubbed audio (heard ru)' });
    // The next play of the title never tries the dub again.
    const again = (await t.svc.play(EPISODE, { provider: 'torrent' })) as PlayResult;
    expect(again.session.torrent?.info_hash).not.toBe(h(1));
  });

  it('keeps a pasted torrent heard as a dub, says so in its attempt, and records it on the torrent', async () => {
    const t = setup({ heard: { [h(1)]: 'ru' } });
    const played = (await t.svc.play(EPISODE, { magnet: h(1) })) as PlayResult;
    const id = played.session.session_id;
    t.open();
    await vi.waitFor(() => expect(t.logged.some((l) => l.includes('keeps the pasted torrent'))).toBe(true));
    expect(t.marks.rows.get(h(1))?.heardLanguage).toBe('ru');
    t.svc.reported(id, { paused: false, over: false });
    await tick();
    expect(t.svc.session(id)).toMatchObject({ torrent: { infoHash: h(1) }, sourceRev: 0 });
    expect(t.svc.session(id)?.attempts.some((a) => a.detail.includes('audio heard: dubbed'))).toBe(true);
  });

  it('hears nothing when the file tags its language, and the original plays on', async () => {
    const t = setup({ tags: 'eng' });
    await t.svc.play(EPISODE, { provider: 'torrent' });
    t.open();
    await tick();
    expect(t.heardAt).toEqual([]);
  });

  it('answers from the marks for a torrent heard before, without listening again', async () => {
    const t = setup();
    await t.marks.noteHeard(h(1), null, 'en', 0.9);
    t.open();
    expect(await t.torrent.hearAudio({ infoHash: h(1), fileIndex: 0, name: 'x', durationS: 100 }, 'en', null)).toMatchObject({ verdict: 'original', kept: true });
    expect(t.heardAt).toEqual([]);
  });

  it('never tries a blacklisted torrent, and keeps the tags each probed file named', async () => {
    const t = setup();
    await t.marks.blacklist(h(1), null, 'a Russian dub');
    const played = (await t.svc.play(EPISODE, { provider: 'torrent' })) as PlayResult;
    expect(played.session.torrent?.info_hash).toBe(h(2));
    await vi.waitFor(() => expect(t.marks.rows.get(h(2))?.tagLanguages).toEqual([]));
  });

  it('hears a few minutes after where the play starts, never past the middle of the film', () => {
    expect(hearAt(null, null)).toBe(TORRENT_HEAR_AFTER_S);
    expect(hearAt(3_000, 600)).toBe(600 + TORRENT_HEAR_AFTER_S);
    expect(hearAt(400, null)).toBe(200);
  });
});
