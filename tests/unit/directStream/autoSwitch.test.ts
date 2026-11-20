import { describe, expect, it, vi } from 'vitest';
import type { AudioLangCheck, AudioLook, AudioVerdict } from '../../../src/directStream/audioLang.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, MAX_AUTO_SWITCHES, type PlayResult } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

/*
 * A play moves to the next good source by itself (autoSwitch in service.ts): when a check that finished behind the play
 * rejects the stream on screen (A), and when a torrent keeps stalling while its swarm cannot keep up (B).
 */

const FILM: StreamRef = { kind: 'movie', tmdbId: 818647 };
const h = (n: number): string => n.toString(16).padStart(40, '0');
/** 62 s of a 1 MB file: a film of about 129 kbit/s. */
const MP4_ES: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'spa' }], subtitles: [], durationS: 62, direct: true };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const candidate = (n: number): TorrentCandidate => {
  const name = `Film.2025.1080p.WEB-DL.x264.AAC-G${n}`;
  return { infoHash: h(n), name, fileName: null, fileIdx: null, seeds: 50 - n, sizeBytes: 2_000_000_000, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: false, release: parseRelease(name) };
};

interface Opts {
  /** The cloud providers in the resolver's order; [] for none. */
  order?: string[];
  /** Each provider's audio verdict (default: original). */
  audio?: Record<string, AudioVerdict>;
  /** The torrents the indexes list. */
  torrents?: number;
  /** The swarm's rate for every torrent, kbit/s. */
  downKbps?: number;
}

function setup(o: Opts = {}) {
  const order = o.order ?? ['Alpha', 'Beta', 'Gamma'];
  const logged: string[] = [];
  const resolves: string[][] = [];
  const audioChecks: string[] = [];
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  // The first look waits until the test opens the gate (it outlasts the play's head), every later one answers at once.
  let looks = 0;
  const audio = {
    async check(_ref: StreamRef, source: ResolvedSource): Promise<AudioLook> {
      audioChecks.push(source.provider);
      if (looks++ === 0) await gate;
      const verdict = o.audio?.[source.provider] ?? 'original';
      return { verdict, detected: verdict === 'dubbed' ? 'en' : 'es', probability: 0.9, reason: `heard ${verdict}`, kept: false };
    },
    async badFor() {
      return [];
    },
  } as unknown as AudioLangCheck;
  const rate = { downKbps: o.downKbps ?? 50 };
  const swarm: TorrentSwarm = {
    open: async (pick) => ({ infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2025.1080p.mp4', name: 'Film.2025.1080p.mp4', length: 1_000_000 }] }),
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
    stats: () => ({ peers: 2, down_kbps: rate.downKbps }),
  };
  const listed = Array.from({ length: o.torrents ?? 0 }, (_, i) => candidate(i + 1));
  const finds = vi.fn(async (): Promise<FindAnswer> => ({ candidates: listed, indexes: [], excluded: [], lastResort: [] }));
  const torrent = new TorrentSource({ swarm, find: finds, probe: async () => MP4_ES, tiers: [], localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const flag = (args: string[], name: string): string | null => (args.includes(name) ? args[args.indexOf(name) + 1]! : null);
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      if (args[0] === 'open') return { ok: true };
      const skip = flag(args, '--skip')?.split(',') ?? [];
      const only = flag(args, '--only');
      resolves.push(skip);
      const pick = only ?? order.find((p) => !skip.includes(p));
      if (pick === undefined) return { ok: false, error: 'no_source', detail: '', attempts: [] };
      return { ok: true, source: { provider: pick, manifest_url: `https://cdn.example/${pick}.m3u8`, manifest_kind: 'hls', subtitles: [], best_height: 1080 }, attempts: [{ provider: pick, outcome: 'resolved', took_s: 1, detail: '' }] };
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'es', imdbId: async () => 'tt0000001' },
    audioCheck: audio,
    checkHeadMs: 5,
    torrent: () => torrent,
    sessions: new SessionStore(),
    log: (line) => void logged.push(line),
  });
  return { svc, logged, resolves, audioChecks, open, finds, rate, order };
}

const switchedLines = (logged: string[]): string[] => logged.filter((l) => l.includes('switched by itself'));

describe('A: a check behind the play rejects the stream on screen', () => {
  it('moves to the next cloud provider at the first report of the film playing, never while it is paused, under the same session id', async () => {
    const t = setup({ audio: { Alpha: 'dubbed' } });
    const played = (await t.svc.play(FILM)) as PlayResult;
    const id = played.session.session_id;
    expect(played.session).toMatchObject({ provider: 'Alpha', source_rev: 0, source_note: null });
    t.open();
    await tick();
    await tick();
    // Paused: the move waits.
    t.svc.reported(id, { paused: true, over: false });
    await tick();
    expect(t.svc.session(id)?.source.provider).toBe('Alpha');
    t.svc.reported(id, { paused: false, over: false });
    await vi.waitFor(() => expect(t.svc.session(id)?.source.provider).toBe('Beta'));
    const info = await t.svc.info(id);
    expect(info).toMatchObject({ session_id: id, provider: 'Beta', source_rev: 1, source_note: 'dubbed audio' });
    expect(switchedLines(t.logged)).toEqual(['[notesd] direct stream: TMDB movie 818647 switched by itself from Alpha to Beta (dubbed audio; 1 of 2)']);
    // The rejected provider is passed over, and the move happens once.
    expect(t.resolves.at(-1)).toEqual(['Alpha']);
    t.svc.reported(id, { paused: false, over: false });
    await tick();
    expect(switchedLines(t.logged)).toHaveLength(1);
  });

  it('goes to a torrent when no other cloud provider has the title', async () => {
    const t = setup({ order: ['Alpha'], audio: { Alpha: 'dubbed' }, torrents: 2 });
    const id = ((await t.svc.play(FILM)) as PlayResult).session.session_id;
    t.open();
    await tick();
    await tick();
    t.svc.reported(id, { paused: false, over: false });
    await vi.waitFor(() => expect(t.svc.session(id)?.torrent).not.toBeNull());
    expect(t.svc.session(id)).toMatchObject({ source: { provider: 'Torrent' }, sourceRev: 1, sourceNote: 'dubbed audio', cache: null });
  });

  it('a play named NTM (cloud) stays among the cloud providers: with none left it is kept, and the log says why', async () => {
    const t = setup({ order: ['Alpha'], audio: { Alpha: 'dubbed' }, torrents: 2 });
    const id = ((await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult).session.session_id;
    t.open();
    await tick();
    await tick();
    t.svc.reported(id, { paused: false, over: false });
    await vi.waitFor(() => expect(t.logged.some((l) => l.includes('stays on Alpha (dubbed audio): no other source plays it now'))).toBe(true));
    expect(t.svc.session(id)).toMatchObject({ source: { provider: 'Alpha' }, torrent: null, sourceRev: 0 });
    expect(t.finds).not.toHaveBeenCalled();
  });

  it('a provider the owner named never moves by itself', async () => {
    const t = setup({ order: ['Alpha', 'Beta'] });
    const id = ((await t.svc.play(FILM, { provider: 'Alpha' })) as PlayResult).session.session_id;
    const answer = await t.svc.switchSource(id, { auto: 'stalled' });
    expect(answer).toMatchObject({ switched: false, reason: 'named_provider' });
    expect(t.svc.session(id)?.source.provider).toBe('Alpha');
  });
});

describe('B: a torrent that keeps stalling', () => {
  async function torrentPlay(o: Opts, provider: string | null = 'torrent') {
    const t = setup({ order: [], torrents: 4, ...o });
    const played = (await t.svc.play(FILM, provider === null ? {} : { provider })) as PlayResult;
    expect(played.session.provider).toBe('Torrent');
    return { ...t, id: played.session.session_id, first: played.session.torrent?.info_hash ?? '' };
  }

  it('moves to the next torrent when the swarm delivers less than the film needs, and leaves the stalled one out', async () => {
    const t = await torrentPlay({ downKbps: 50 });
    const answer = await t.svc.switchSource(t.id, { auto: 'stalled' });
    expect(answer.switched).toBe(true);
    expect(answer.from).toMatch(/^Torrent: Film\.2025\.1080p/);
    expect(answer.session).toMatchObject({ session_id: t.id, source_rev: 1, source_note: 'the torrent kept stalling' });
    expect(answer.session.torrent?.info_hash).not.toBe(t.first);
    expect(switchedLines(t.logged)).toHaveLength(1);
    expect(switchedLines(t.logged)[0]).toContain('(the torrent kept stalling; 1 of 2)');
  });

  it('is not moved while its swarm keeps up with the film', async () => {
    const t = await torrentPlay({ downKbps: 5_000 });
    const answer = await t.svc.switchSource(t.id, { auto: 'stalled' });
    expect(answer).toMatchObject({ switched: false, reason: 'delivering' });
    expect(answer.session.torrent?.info_hash).toBe(t.first);
  });

  it(`moves at most ${MAX_AUTO_SWITCHES} times by itself, then leaves the play and logs it`, async () => {
    const t = await torrentPlay({ downKbps: 50, torrents: 6 });
    for (let n = 1; n <= MAX_AUTO_SWITCHES; n++) expect((await t.svc.switchSource(t.id, { auto: 'stalled' })).switched).toBe(true);
    const last = await t.svc.switchSource(t.id, { auto: 'stalled' });
    expect(last).toMatchObject({ switched: false, reason: 'limit' });
    expect(t.logged.some((l) => l.includes(`it was moved ${MAX_AUTO_SWITCHES} times by itself already`))).toBe(true);
  });

  it('a TM play with no other torrent stays on its torrent; a play with no source named goes to a cloud provider', async () => {
    const tm = await torrentPlay({ downKbps: 50, torrents: 1, order: ['Alpha'] });
    expect(await tm.svc.switchSource(tm.id, { auto: 'stalled' })).toMatchObject({ switched: false, reason: 'no_other_source' });
    expect(tm.resolves).toEqual([]);
    // No source named: the cloud providers had nothing at first (`order` empty), so the play went to the torrent;
    // now one answers.
    const t = setup({ order: [], torrents: 1, downKbps: 50 });
    const played = (await t.svc.play(FILM)) as PlayResult;
    expect(played.session.provider).toBe('Torrent');
    t.open();
    t.order.push('Alpha');
    const answer = await t.svc.switchSource(played.session.session_id, { auto: 'stalled' });
    expect(answer).toMatchObject({ switched: true, session: { provider: 'Alpha', torrent: null, source_rev: 1 } });
  });
});
