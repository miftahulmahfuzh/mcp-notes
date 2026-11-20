import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../../src/config.js';
import type { StreamTrendingRow } from '../../../../src/db/schema.js';
import { buildTrending, DisabledTrending, isFreshForTrending, isSkippedLanguage, TrendingJob, type TrendingJobOptions } from '../../../../src/directStream/trending/job.js';
import type { TrendingEntry, TrendingStore } from '../../../../src/directStream/trending/repo.js';
import type { TrendRow } from '../../../../src/directStream/trending/sources.js';
import type { TitleListItem } from '../../../../src/movies/read.js';

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
    }));
  }
  async rows(): Promise<StreamTrendingRow[]> {
    return this.data;
  }
  async listedAt(): Promise<Date | null> {
    return this.data[0]?.listedAt ?? null;
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
  const { states = {}, ...rest } = over;
  const job = new TrendingJob({
    config: { size: 2 },
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
    changed: () => undefined,
    fetchTrends: async () => ({ rows, attempts: [{ index: 'apibay', outcome: 'ok', detail: '', listed: rows.length }] }),
    now: () => NOW,
    log: () => undefined,
    ...rest,
  });
  return { job, store, asked };
}

describe('TrendingJob', () => {
  it('lists the top of each kind by seeds, ranked, and joins no swarm', async () => {
    const { job, store } = make([listing(1, 'movie', 100), listing(2, 'movie', 900), listing(3, 'movie', 500), listing(50, 'tv', 300), listing(51, 'tv', 800)]);
    await job.pass(false);
    expect(store.data.map((r) => [r.titleId, r.rank, r.seeds])).toEqual([
      ['movie-2', 1, 900],
      ['movie-3', 2, 500],
      ['tv-51', 1, 800],
      ['tv-50', 2, 300],
    ]);
    expect(job.status().last_pass).toMatchObject({ movies: 2, series: 2, stopped: 'done' });
  });

  it('never lists a title the owner has seen, started, or marked, and fills the place from further down', async () => {
    const { job, store } = make(
      [listing(1, 'movie', 900), listing(2, 'movie', 800), listing(3, 'movie', 700), listing(4, 'movie', 600)],
      { states: { 'movie-1': { state: 'finished' }, 'movie-2': { not_interested: true }, 'movie-3': { watched: true } } },
    );
    await job.pass(false);
    expect(store.data.map((r) => r.titleId)).toEqual(['movie-4']);
  });

  it('never lists a title whose original language is skipped (Hindi), and fills the place from further down', async () => {
    const lang: Record<string, string | null> = { 'movie-1': 'hi', 'movie-2': null, 'movie-3': 'en' };
    const { job, store } = make([listing(1, 'movie', 900), listing(2, 'movie', 800), listing(3, 'movie', 700)], {
      config: { size: 2, skipLanguages: ['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa'] },
      languages: async (ids) => new Map(ids.map((id) => [id, lang[id] ?? null])),
    });
    await job.pass(false);
    expect(store.data.map((r) => r.titleId)).toEqual(['movie-2', 'movie-3']);
  });

  it('asks TMDB for a title with no language, keeps the answer, and skips it when it is Hindi', async () => {
    const saved: [string, string][] = [];
    const { job, store } = make([listing(1, 'movie', 900), listing(2, 'movie', 800)], {
      config: { size: 5, skipLanguages: ['hi'] },
      languages: async () => new Map(),
      tmdb: { findByImdb: async (imdb) => ({ kind: 'movie', tmdbId: Number(imdb.slice(2)) - 1000000 }), originalLanguage: async (_k, id) => (id === 1 ? 'hi' : 'en') },
      saveLanguage: async (id, language) => {
        saved.push([id, language]);
      },
    });
    await job.pass(false);
    expect(saved).toEqual([['movie-1', 'hi'], ['movie-2', 'en']]);
    expect(store.data.map((r) => r.titleId)).toEqual(['movie-2']);
  });

  it('skips a title with no known language whose release names only a skipped one', async () => {
    const rows = [{ ...listing(1, 'movie', 900), name: 'Scene (2026) 1080p Telugu DVDScr x264 AAC' }, listing(2, 'movie', 800)];
    const { job, store } = make(rows, { config: { size: 5, skipLanguages: ['te'] }, languages: async () => new Map() });
    await job.pass(false);
    expect(store.data.map((r) => r.titleId)).toEqual(['movie-2']);
  });

  it('keeps the old list when the indexes list nothing', async () => {
    const { job, store } = make([listing(1, 'movie', 100)]);
    await job.pass(false);
    const before = store.data.map((r) => r.titleId);
    const again = make([], { fetchTrends: async () => ({ rows: [], attempts: [{ index: 'apibay', outcome: 'error', detail: 'HTTP 503', listed: 0 }] }) });
    again.store.data = store.data;
    await again.job.pass(false);
    expect(again.store.data.map((r) => r.titleId)).toEqual(before);
    expect(again.store.replaced).toBe(0);
    expect(again.job.status().last_pass).toMatchObject({ stopped: 'no_listing' });
  });

  it('skips a title TMDB does not know, and asks TMDB once per IMDb id that is new', async () => {
    const { job, store, asked } = make([listing(99, 'movie', 999), listing(1, 'movie', 100)]);
    await job.pass(false);
    expect(store.data.map((r) => r.titleId)).toEqual(['movie-1']);
    await job.pass(false);
    expect(asked.filter((i) => i === 'tt1000001')).toHaveLength(1);
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

describe('isSkippedLanguage', () => {
  const skip = new Set(['hi', 'te']);
  it('goes by TMDB\'s original language when it is known', () => {
    expect(isSkippedLanguage('hi', 'Film 2026 1080p', skip)).toBe(true);
    expect(isSkippedLanguage('en', 'Film 2026 Hindi 1080p', skip)).toBe(false);
  });
  it('goes by a release that names only skipped languages when the language is unknown', () => {
    expect(isSkippedLanguage(null, 'Scene (2026) 1080p Telugu DVDScr x264 AAC', skip)).toBe(true);
    expect(isSkippedLanguage(undefined, 'Film 2026 1080p Hindi WEB-DL', skip)).toBe(true);
  });
  it('does not skip a dual-audio release, a release naming no language, or an empty skip list', () => {
    expect(isSkippedLanguage(null, 'Film 2026 1080p English Hindi DUAL', skip)).toBe(false);
    expect(isSkippedLanguage(null, 'Film 2026 1080p WEB-DL', skip)).toBe(false);
    expect(isSkippedLanguage('hi', 'Film 2026', new Set())).toBe(false);
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
  const inputs = { db: {} as never };

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
    expect(config({}).directStream?.trending).toEqual({ enabled: true, size: 100, skipLanguages: ['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa'] });
    expect(config({ NOTESD_TRENDING_SIZE: '40' }).directStream?.trending).toEqual({ enabled: true, size: 40, skipLanguages: ['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa'] });
    expect(() => config({ NOTESD_TRENDING_SIZE: '0' })).toThrow(/NOTESD_TRENDING_SIZE/);
  });
});
