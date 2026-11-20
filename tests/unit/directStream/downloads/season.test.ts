import { describe, expect, it } from 'vitest';
import { finishFromDisk, PACK_STALL_MS, SeasonDownloads, type PackSwarm, type SeasonEpisode, type SeasonPacks, type SeasonRow, type SeasonRows } from '../../../../src/directStream/downloads/season.js';
import type { DownloadVia } from '../../../../src/directStream/downloads/types.js';
import type { PackFetch } from '../../../../src/directStream/torrent/source.js';
import type { StreamRef } from '../../../../src/directStream/types.js';

const TMDB = 1399;
const PACK = 'facade'.padEnd(40, '2');
const EPISODES: SeasonEpisode[] = [
  { episode: 1, airDate: '2026-10-01' },
  { episode: 2, airDate: '2026-10-08' },
  { episode: 3, airDate: '2026-10-15' },
  { episode: 4, airDate: '2026-11-27' },
  { episode: 5, airDate: null },
];

type Stored = SeasonRow & { state: 'queued' | 'running' | 'paused' | 'done' | 'failed'; error: string | null };

class MemoryRows implements SeasonRows {
  readonly stored: Stored[] = [];
  private next = 1;

  add(episode: number, via: DownloadVia, batch: string, infoHash: string | null = null): Stored {
    const row: Stored = { id: `d${this.next++}`, ref: { kind: 'tv', tmdbId: TMDB, season: 1, episode }, via, infoHash, batch, sourceId: null, state: 'queued', error: null };
    this.stored.push(row);
    return row;
  }

  get(id: string): Stored {
    const row = this.stored.find((r) => r.id === id);
    if (row === undefined) throw new Error(`no row ${id}`);
    return row;
  }

  async open(batch: string): Promise<SeasonRow[]> {
    return this.stored.filter((r) => r.batch === batch && ['queued', 'running', 'paused'].includes(r.state)).sort((a, b) => a.ref.episode - b.ref.episode);
  }
  async wanted(id: string): Promise<boolean> {
    return ['queued', 'running', 'paused'].includes(this.get(id).state);
  }
  async running(id: string, infoHash: string): Promise<void> {
    Object.assign(this.get(id), { state: 'running', sourceId: infoHash });
  }
  async paused(id: string): Promise<void> {
    this.get(id).state = 'paused';
  }
  async done(id: string, infoHash: string): Promise<void> {
    Object.assign(this.get(id), { state: 'done', sourceId: infoHash });
  }
  async failed(id: string, code: string): Promise<void> {
    Object.assign(this.get(id), { state: 'failed', error: code });
  }
}

class FakeSwarm implements PackSwarm {
  readonly calls: string[] = [];
  readonly wholeFiles = new Set<number>();
  receivedBytes: number | null = null;
  async whole(_infoHash: string, index: number): Promise<boolean> {
    return this.wholeFiles.has(index);
  }
  async bytes(_infoHash: string, index: number): Promise<{ done: number; total: number }> {
    return { done: this.wholeFiles.has(index) ? 100 : 10, total: 100 };
  }
  received(): number | null {
    return this.receivedBytes;
  }
  async release(): Promise<void> {
    this.calls.push('release');
  }
  async releaseSlot(_infoHash: string, ref: StreamRef): Promise<void> {
    this.calls.push(`releaseSlot E${ref.kind === 'tv' ? ref.episode : 0}`);
  }
  async keep(): Promise<void> {
    this.calls.push('keep');
  }
}

const NO_PACK: PackFetch = { ok: false, error: 'no_pack', attempts: [] };
const packOf = (episodes: number[], lacking: number[] = []): PackFetch => ({
  ok: true,
  pack: { infoHash: PACK, name: 'Fixture.Show.S01.1080p', episodes: episodes.map((episode, i) => ({ episode, video: i, subtitles: [] })), lacking, attempts: [] },
});

function setup(o: { episodes?: SeasonEpisode[] | null; whole?: number[]; pack?: PackFetch; office?: boolean } = {}) {
  const rows = new MemoryRows();
  const swarm = new FakeSwarm();
  const fetches: { episodes: number[]; heights: string; known: string | null }[] = [];
  const packs: SeasonPacks = {
    fetch: async (_tmdbId, _season, episodes, options) => {
      fetches.push({ episodes: [...episodes], heights: options.heights, known: options.known ?? null });
      return o.pack ?? NO_PACK;
    },
  };
  let clock = Date.parse('2026-11-20T12:00:00Z');
  const seasons = new SeasonDownloads<Stored>({
    episodes: async () => (o.episodes === undefined ? EPISODES : o.episodes),
    whole: async (ref) => (o.whole ?? []).includes(ref.episode),
    request: async (ref, { via, batch }) => rows.add(ref.episode, via, batch),
    rows,
    packs,
    swarm,
    office: async () => o.office === true,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    newBatch: () => 'batch-1',
    log: () => undefined,
  });
  return { seasons, rows, swarm, fetches };
}

async function queued(s: ReturnType<typeof setup>, via: DownloadVia = 'auto'): Promise<Stored[]> {
  const answer = await s.seasons.request(TMDB, 1, { via });
  if (!answer.ok) throw new Error(answer.detail);
  return answer.queued;
}

describe('SeasonDownloads.request', () => {
  it('queues every aired episode not whole on this machine, in episode order, under one batch', async () => {
    const s = setup({ whole: [2] });
    const answer = await s.seasons.request(TMDB, 1, { via: 'auto' });
    expect(answer).toMatchObject({
      ok: true,
      batch: 'batch-1',
      left_out: [
        { episode: 2, why: 'whole' },
        { episode: 4, why: 'not_aired' },
        { episode: 5, why: 'no_air_date' },
      ],
    });
    expect(answer.ok && answer.queued.map((r) => [r.ref.episode, r.state, r.batch])).toEqual([
      [1, 'queued', 'batch-1'],
      [3, 'queued', 'batch-1'],
    ]);
  });

  it('leaves out an episode that has not aired, and never looks for it in a pack', async () => {
    const s = setup({ pack: packOf([1, 2, 3]) });
    const [first] = await queued(s);
    expect(s.rows.stored.map((r) => r.ref.episode)).toEqual([1, 2, 3]);
    const job = await s.seasons.take(first!);
    expect(s.fetches.map((f) => f.episodes)).toEqual([[1, 2, 3]]);
    // The job's loop ends only once every carried file is whole.
    for (const index of [0, 1, 2]) s.swarm.wholeFiles.add(index);
    await job!.done;
  });

  it('answers unknown_season when the stored title lists no episode of the season, and queues nothing when all are whole', async () => {
    expect(await setup({ episodes: [] }).seasons.request(TMDB, 1, { via: 'auto' })).toMatchObject({ ok: false, error: 'unknown_season' });
    const all = setup({ whole: [1, 2, 3] });
    expect(await all.seasons.request(TMDB, 1, { via: 'auto' })).toMatchObject({ ok: true, batch: null, queued: [] });
    expect(all.rows.stored).toEqual([]);
  });
});

describe('SeasonDownloads.take', () => {
  it('downloads a season from its pack: one look, every row carried and kept, each done when its file is whole', async () => {
    const s = setup({ pack: packOf([1, 2, 3]) });
    const rows = await queued(s);
    const job = await s.seasons.take(rows[0]!);
    expect(job?.rowIds).toEqual(['d1', 'd2', 'd3']);
    expect(s.swarm.calls).toEqual(['keep']);
    expect(s.rows.stored.map((r) => [r.state, r.sourceId])).toEqual([
      ['running', PACK],
      ['running', PACK],
      ['running', PACK],
    ]);
    for (const index of [0, 1, 2]) s.swarm.wholeFiles.add(index);
    await job!.done;
    expect(s.rows.stored.map((r) => [r.state, r.sourceId])).toEqual([
      ['done', PACK],
      ['done', PACK],
      ['done', PACK],
    ]);
    expect(s.swarm.calls.filter((c) => c === 'release')).toHaveLength(3);
    expect(await s.seasons.take(rows[1]!)).toBeNull();
    expect(s.fetches).toHaveLength(1);
  });

  it('leaves an episode the pack lacks queued, to download on its own after the pack', async () => {
    const s = setup({ pack: packOf([1, 3], [2]) });
    const rows = await queued(s);
    const job = await s.seasons.take(rows[0]!);
    expect(job?.rowIds).toEqual(['d1', 'd3']);
    s.swarm.wholeFiles.add(0);
    s.swarm.wholeFiles.add(1);
    await job!.done;
    expect(s.rows.stored.map((r) => [r.ref.episode, r.state])).toEqual([
      [1, 'done'],
      [2, 'queued'],
      [3, 'done'],
    ]);
    expect(await s.seasons.take(rows[1]!)).toBeNull();
  });

  it('with no pack, every row downloads on its own, in order, and the batch is looked at once', async () => {
    const s = setup();
    const rows = await queued(s);
    expect(await s.seasons.take(rows[0]!)).toBeNull();
    expect(await s.seasons.take(rows[1]!)).toBeNull();
    expect(s.fetches).toHaveLength(1);
    expect(s.rows.stored.map((r) => r.state)).toEqual(['queued', 'queued', 'queued']);
  });

  it('looks for no pack for a cloud download, a torrent picked by hand, or on the office network', async () => {
    const cloud = setup({ pack: packOf([1, 2, 3]) });
    expect(await cloud.seasons.take((await queued(cloud, 'cloud'))[0]!)).toBeNull();
    const office = setup({ pack: packOf([1, 2, 3]), office: true });
    expect(await office.seasons.take((await queued(office))[0]!)).toBeNull();
    const picked = setup({ pack: packOf([1, 2, 3]) });
    expect(await picked.seasons.take(picked.rows.add(1, 'torrent', 'b-hand', PACK))).toBeNull();
    expect([...cloud.fetches, ...office.fetches, ...picked.fetches]).toEqual([]);
  });

  it('asks for a 1080p pack with no source named, any height for a torrent, and the pack it had before a restart', async () => {
    const auto = setup();
    await auto.seasons.take((await queued(auto, 'auto'))[0]!);
    const torrent = setup();
    const rows = await queued(torrent, 'torrent');
    torrent.rows.get('d2').sourceId = PACK;
    await torrent.seasons.take(rows[0]!);
    expect([auto.fetches[0], torrent.fetches[0]]).toEqual([
      { episodes: [1, 2, 3], heights: 'preferred', known: null },
      { episodes: [1, 2, 3], heights: 'any', known: PACK },
    ]);
  });
});

describe('SeasonPackJob', () => {
  it('lets go of the pack while a torrent plays (its rows wait, paused, the pack their source) and opens the same pack by its hash after; a cancel stops that episode alone', async () => {
    const s = setup({ pack: packOf([1, 2, 3]) });
    const rows = await queued(s);
    const job = (await s.seasons.take(rows[0]!))!;
    expect(await job.cancel('d2')).toBe(true);
    s.rows.get('d2').state = 'failed';
    await job.pause();
    await job.done;
    expect(s.rows.stored.map((r) => [r.state, r.sourceId])).toEqual([
      ['paused', PACK],
      ['failed', PACK],
      ['paused', PACK],
    ]);
    expect(s.swarm.calls).toEqual(['keep', 'releaseSlot E2', 'release', 'release']);
    // The play ended: the queue reaches d1 again; d1 and d3 still name the pack, so it is opened again by its hash.
    const again = (await s.seasons.take(s.rows.get('d1')))!;
    expect(s.fetches.map((f) => f.known)).toEqual([null, PACK]);
    expect(again.rowIds).toEqual(['d1', 'd3']);
    s.swarm.wholeFiles.add(0);
    s.swarm.wholeFiles.add(2);
    await again.done;
    expect(s.rows.stored.map((r) => r.state)).toEqual(['done', 'failed', 'done']);
    expect(await again.progress('d1')).toEqual({ done: 100, total: 100 });
  });

  it('fails what is left when the swarm sends nothing for two hours', async () => {
    const s = setup({ pack: packOf([1, 2]) });
    s.swarm.receivedBytes = 0;
    const job = (await s.seasons.take((await queued(s))[0]!))!;
    await job.done;
    expect(PACK_STALL_MS).toBe(2 * 3_600_000);
    expect(s.rows.stored.map((r) => [r.ref.episode, r.state, r.error])).toEqual([
      [1, 'failed', 'download_failed'],
      [2, 'failed', 'download_failed'],
      [3, 'queued', null],
    ]);
  });
});

describe('finishFromDisk: a pack episode made ready to play offline', () => {
  it('looks again until the episode reads from disk, waits for its remux and subtitle, then lets it go', async () => {
    const calls: string[] = [];
    const torrent = { infoHash: PACK } as never;
    let reads = 0;
    let looks = 0;
    const source = {
      fromDisk: async () => {
        calls.push('fromDisk');
        reads += 1;
        return reads < 3 ? null : ({ torrent, source: {} as never, attempts: [] } as never);
      },
      keptState: async () => {
        looks += 1;
        return { file: 'whole' as const, remux: looks < 2 ? ('running' as const) : ('whole' as const), subtitles: 'done' as const };
      },
      release: () => void calls.push('release'),
    };
    const finish = finishFromDisk(() => source, async () => ({ audioLang: 'en' }), { sleep: async () => undefined, log: () => undefined });
    await finish({ kind: 'tv', tmdbId: TMDB, season: 1, episode: 1 });
    expect(calls).toEqual(['fromDisk', 'fromDisk', 'fromDisk', 'release']);
    expect(looks).toBe(2);
  });
});
