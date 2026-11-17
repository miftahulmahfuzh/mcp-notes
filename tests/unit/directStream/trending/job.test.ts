import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../../src/config.js';
import type { StreamTrendingRow, TrendingProbeOutcome } from '../../../../src/db/schema.js';
import { buildTrending, DisabledTrending, isFreshForTrending, TrendingJob, type PeekResult, type TrendingJobOptions } from '../../../../src/directStream/trending/job.js';
import type { TrendingEntry, TrendingStore } from '../../../../src/directStream/trending/repo.js';
import type { TrendRow } from '../../../../src/directStream/trending/sources.js';
import { TorrentError } from '../../../../src/directStream/torrent/types.js';
import type { TitleListItem } from '../../../../src/movies/read.js';

const CONTROL = '08ada5a7a6183aae1e09d831df6748d566095a10';
const NOW = new Date('2026-11-17T06:00:00Z');
const hash = (n: number): string => n.toString(16).padStart(40, 'b');

class MemoryStore implements TrendingStore {
  data: StreamTrendingRow[] = [];
  replaced = 0;
  async replace(host: string, entries: readonly TrendingEntry[], at: Date): Promise<void> {
    this.replaced += 1;
    this.data = entries.map((e) => ({
      host,
      titleId: e.titleId,
      kind: e.kind,
      imdbId: e.imdbId,
      rank: e.rank,
      seeds: e.seeds,
      index: e.index,
      infoHash: e.infoHash,
      releaseName: e.releaseName,
      sizeBytes: e.sizeBytes,
      listedAt: at,
      probeOutcome: e.probe?.outcome ?? null,
      probeDetail: e.probe?.detail ?? null,
      probedAt: e.probe?.at ?? null,
    }));
  }
  async rows(): Promise<StreamTrendingRow[]> {
    return this.data;
  }
  async listedAt(): Promise<Date | null> {
    return this.data[0]?.listedAt ?? null;
  }
  async recordProbe(_h: string, titleId: string, infoHash: string, outcome: TrendingProbeOutcome, detail: string | null, at: Date): Promise<void> {
    const r = this.data.find((d) => d.titleId === titleId && d.infoHash === infoHash);
    if (r !== undefined) Object.assign(r, { probeOutcome: outcome, probeDetail: detail, probedAt: at });
  }
}

const listing = (n: number, kind: 'movie' | 'tv', seeds: number): TrendRow => ({
  kind,
  imdbId: `tt${1000000 + n}`,
  infoHash: hash(n),
  name: kind === 'movie' ? `Film ${n} 2026 1080p WEB-DL` : `Show ${n} S01E01 1080p`,
  seeds,
  sizeBytes: 1e9,
  index: 'apibay',
});

const item = (id: string, over: Partial<TitleListItem> = {}): TitleListItem =>
  ({ id, state: 'unwatched', watched: false, not_interested: false, ...over }) as TitleListItem;

function make(rows: TrendRow[], over: Partial<TrendingJobOptions> & { states?: Record<string, Partial<TitleListItem>> } = {}) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const peeked: string[] = [];
  const { states = {}, ...rest } = over;
  const job = new TrendingJob({
    config: { size: 2, probe: 10 },
    host: 'laptop',
    store,
    tmdb: {
      findByImdb: async (imdb) => {
        asked.push(imdb);
        const n = Number(imdb.slice(2)) - 1000000;
        return n === 99 ? null : { kind: n >= 50 ? 'tv' : 'movie', tmdbId: n };
      },
    },
    ensureTitle: async (t) => `${t.kind}-${t.tmdbId}`,
    titles: async (ids) => ids.map((id) => item(id, states[id] ?? {})),
    peek: async (h): Promise<PeekResult> => {
      if (h !== CONTROL) peeked.push(h);
      return { files: 2, videos: 1, peers: 4, live: true };
    },
    busy: () => false,
    changed: () => undefined,
    fetchTrends: async () => ({ rows, attempts: [{ index: 'apibay', outcome: 'ok', detail: '', listed: rows.length }] }),
    now: () => NOW,
    log: () => undefined,
    ...rest,
  });
  return { job, store, asked, peeked };
}

describe('TrendingJob', () => {
  it('lists the top of each kind by seeds, ranked, and probes them', async () => {
    const { job, store, peeked } = make([listing(1, 'movie', 100), listing(2, 'movie', 900), listing(3, 'movie', 500), listing(50, 'tv', 300), listing(51, 'tv', 800)]);
    await job.pass(false);
    expect(store.data.map((r) => [r.titleId, r.rank, r.seeds])).toEqual([
      ['movie-2', 1, 900],
      ['movie-3', 2, 500],
      ['tv-51', 1, 800],
      ['tv-50', 2, 300],
    ]);
    expect(store.data.every((r) => r.probeOutcome === 'confirmed')).toBe(true);
    expect(peeked).toHaveLength(4);
    expect(job.status().last_pass).toMatchObject({ movies: 2, series: 2, probed: 4, confirmed: 4, stopped: 'done' });
  });

  it('never lists a title the owner has seen, started, or marked, and fills the place from further down', async () => {
    const { job, store } = make(
      [listing(1, 'movie', 900), listing(2, 'movie', 800), listing(3, 'movie', 700), listing(4, 'movie', 600)],
      { states: { 'movie-1': { state: 'finished' }, 'movie-2': { not_interested: true }, 'movie-3': { watched: true } } },
    );
    await job.pass(false);
    expect(store.data.map((r) => r.titleId)).toEqual(['movie-4']);
  });

  it('keeps the old list and probes nothing when the indexes list nothing', async () => {
    const { job, store, peeked } = make([listing(1, 'movie', 100)]);
    await job.pass(false);
    const before = store.data.map((r) => r.titleId);
    const again = make([], { fetchTrends: async () => ({ rows: [], attempts: [{ index: 'apibay', outcome: 'error', detail: 'HTTP 503', listed: 0 }] }) });
    again.store.data = store.data;
    peeked.length = 0;
    await again.job.pass(false);
    expect(again.store.data.map((r) => r.titleId)).toEqual(before);
    expect(again.store.replaced).toBe(0);
    expect(again.job.status().last_pass).toMatchObject({ stopped: 'no_listing' });
    expect(peeked).toEqual([]);
  });

  it('skips a title TMDB does not know, and asks TMDB once per IMDb id that is new', async () => {
    const { job, store, asked } = make([listing(99, 'movie', 999), listing(1, 'movie', 100)]);
    await job.pass(false);
    expect(store.data.map((r) => r.titleId)).toEqual(['movie-1']);
    await job.pass(false);
    expect(asked.filter((i) => i === 'tt1000001')).toHaveLength(1);
  });

  it('says confirmed only for a swarm that answered, and tells why one did not', async () => {
    const answers: Record<string, () => Promise<PeekResult>> = {
      [hash(1)]: async () => ({ files: 3, videos: 1, peers: 2, live: true }),
      [hash(2)]: async () => {
        throw new TorrentError('no_metadata', 'no peers');
      },
      [hash(3)]: async () => ({ files: 2, videos: 0, peers: 1, live: true }),
      [hash(4)]: async () => {
        throw new Error('engine exploded');
      },
    };
    const { job, store } = make([listing(1, 'movie', 400), listing(2, 'movie', 300), listing(3, 'movie', 200), listing(4, 'movie', 100)], {
      config: { size: 4, probe: 10 },
      peek: (h) => (answers[h] as () => Promise<PeekResult>)(),
    });
    await job.pass(false);
    expect(store.data.map((r) => r.probeOutcome)).toEqual(['confirmed', 'no_peers', 'no_video', 'error']);
    expect(store.data[1]?.probeDetail).toContain('20 s');
    expect(store.data.every((r) => r.probedAt?.getTime() === NOW.getTime())).toBe(true);
  });

  it('opens no more swarms than NOTESD_TRENDING_PROBE, alternating films and series', async () => {
    const { job, store, peeked } = make([listing(1, 'movie', 900), listing(2, 'movie', 800), listing(50, 'tv', 700), listing(51, 'tv', 600)], { config: { size: 2, probe: 3 } });
    await job.pass(false);
    expect(peeked).toEqual([hash(1), hash(50), hash(2)]);
    expect(store.data.filter((r) => r.probeOutcome === null).map((r) => r.titleId)).toEqual(['tv-51']);
  });

  it('judges no swarm when the control torrent finds no peer either, records nothing, and says so', async () => {
    const { job, store, peeked } = make([listing(1, 'movie', 900), listing(2, 'movie', 800)], {
      peek: async (h) => {
        peeked.push(h);
        throw new TorrentError('no_metadata', 'no peers');
      },
    });
    await job.pass(false);
    expect(peeked).toEqual([CONTROL]);
    expect(store.data.every((r) => r.probeOutcome === null)).toBe(true);
    expect(job.status().last_pass).toMatchObject({ stopped: 'no_peers_here', probed: 0 });
  });

  it('judges the swarms once the control answers, and an engine error on the control is not a verdict on the network', async () => {
    const hashes: string[] = [];
    const { job, store } = make([listing(1, 'movie', 900)], {
      peek: async (h) => {
        hashes.push(h);
        if (h === CONTROL) throw new Error('engine exploded');
        return { files: 1, videos: 1, peers: 2, live: true };
      },
    });
    await job.pass(false);
    expect(hashes).toHaveLength(2);
    expect(store.data[0]?.probeOutcome).toBe('confirmed');
  });

  it('opens none with probe 0', async () => {
    const { job, peeked } = make([listing(1, 'movie', 900)], { config: { size: 2, probe: 0 } });
    await job.pass(false);
    expect(peeked).toEqual([]);
  });

  it('stops probing while something plays, and says so', async () => {
    const { job, peeked } = make([listing(1, 'movie', 900), listing(2, 'movie', 800)], { busy: () => true });
    await job.pass(false);
    expect(peeked).toEqual([]);
    expect(job.status().last_pass?.stopped).toBe('busy');
  });

  it('carries a recent probe of the same torrent into a new list and probes the rest', async () => {
    const { job, store, peeked } = make([listing(1, 'movie', 900), listing(2, 'movie', 800)]);
    await job.pass(false);
    expect(peeked).toHaveLength(2);
    peeked.length = 0;
    await job.pass(true);
    expect(peeked).toEqual([]);
    expect(store.data.every((r) => r.probeOutcome === 'confirmed')).toBe(true);
  });

  it('probes a fresh list again at the next check when a play cut the probes short, without listing again', async () => {
    let busy = true;
    let clock = NOW.getTime();
    const { job, store, peeked } = make([listing(1, 'movie', 900), listing(2, 'movie', 800)], { busy: () => busy, now: () => new Date(clock), initialDelayMs: 1, checkMs: 5 });
    job.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(store.replaced).toBe(1);
    expect(peeked).toEqual([]);
    busy = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(store.replaced).toBe(1);
    expect(peeked).toHaveLength(2);
    expect(store.data.every((r) => r.probeOutcome === 'confirmed')).toBe(true);
    await job.close();
  });

  it('a pass never throws: a store failure is the pass\'s error', async () => {
    const { job } = make([listing(1, 'movie', 900)], {
      titles: async () => {
        throw new Error('db down');
      },
    });
    await job.pass(false);
    expect(job.status().last_pass).toMatchObject({ stopped: 'error', error: 'db down' });
  });

  it('runs a pass when the list is a day old or missing, not before', async () => {
    let clock = NOW.getTime();
    const { job, store } = make([listing(1, 'movie', 900)], { now: () => new Date(clock), initialDelayMs: 1, checkMs: 5, everyMs: 1000 });
    job.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(store.replaced).toBe(1);
    clock += 500;
    await new Promise((r) => setTimeout(r, 30));
    expect(store.replaced).toBe(1);
    clock += 1000;
    await new Promise((r) => setTimeout(r, 30));
    expect(store.replaced).toBeGreaterThanOrEqual(2);
    await job.close();
  });
});

describe('isFreshForTrending', () => {
  it.each([
    [{ state: 'unwatched', watched: false, not_interested: false }, true],
    [{ state: 'removed_unwatched', watched: false, not_interested: false }, true],
    [{ state: 'finished', watched: false, not_interested: false }, false],
    [{ state: 'seen', watched: false, not_interested: false }, false],
    [{ state: 'in_progress', watched: false, not_interested: false }, false],
    [{ state: 'dropped', watched: false, not_interested: false }, false],
    [{ state: 'unwatched', watched: true, not_interested: false }, false],
    [{ state: 'unwatched', watched: false, not_interested: true }, false],
  ] as const)('%j is %s', (i, expected) => {
    expect(isFreshForTrending(i)).toBe(expected);
  });
});

describe('buildTrending', () => {
  const config = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/a', ...env }, envFile: false });
  const inputs = { db: {} as never, busy: () => false };

  it('is a DisabledTrending that says why, and does nothing', async () => {
    const off = buildTrending({ ...inputs, config: config({ NOTESD_TRENDING: 'off' }), movies: {} as never, torrents: {} as never });
    expect(off).toBeInstanceOf(DisabledTrending);
    expect(off.status()).toMatchObject({ enabled: false, off_reason: 'setting_off' });
    expect(off.askPass()).toBe(false);
    expect(off.startLine()).toContain('NOTESD_TRENDING=off');
    off.start();
    await off.close();
  });

  it('is on by default and names the first thing missing', () => {
    const reason = (env: Record<string, string>, movies: object | null, torrents: object | null) =>
      buildTrending({ ...inputs, config: config(env), movies: movies as never, torrents: torrents as never }).status().off_reason;
    expect(reason({}, null, null)).toBe('movies_off');
    expect(reason({ NOTESD_DIRECT_STREAM: 'off' }, {}, {})).toBe('direct_stream_off');
    expect(reason({}, {}, null)).toBe('torrent_off');
    expect(reason({}, {}, {})).toBe('no_tmdb');
  });

  it('reads its settings', () => {
    expect(config({}).directStream?.trending).toEqual({ enabled: true, size: 100, probe: 200 });
    expect(config({ NOTESD_TRENDING_SIZE: '40', NOTESD_TRENDING_PROBE: '0' }).directStream?.trending).toEqual({ enabled: true, size: 40, probe: 0 });
    expect(() => config({ NOTESD_TRENDING_PROBE: '-1' })).toThrow(/NOTESD_TRENDING_PROBE/);
    expect(() => config({ NOTESD_TRENDING_SIZE: '0' })).toThrow(/NOTESD_TRENDING_SIZE/);
  });
});
