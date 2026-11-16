import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STREAM_PROBER_CONFIG, loadConfig, type StreamProberConfig } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { StreamProbeListSource } from '../../../src/db/schema.js';
import type { ListedCandidate } from '../../../src/directStream/candidates.js';
import type { IdleReader } from '../../../src/directStream/idle.js';
import {
  BACKOFF_BASE_MS,
  buildStreamProber,
  classifyResolve,
  DisabledProber,
  interleave,
  StreamProber,
  type ProbeOutcome,
  type ProbeRecord,
  type ProbeRef,
  type ProbeStore,
  type ProbeTarget,
} from '../../../src/directStream/prober.js';
import type { MoviesService } from '../../../src/movies/service.js';
import type { TitleKind, TmdbCatalog, TmdbSearchHit } from '../../../src/movies/tmdb.js';

const HOST = 'host-a';
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-15T00:00:00Z');

class Clock {
  constructor(public t: number) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

interface Src { titleId: string; kind: TitleKind; tmdbId: number; season: number; episode: number; verifiedAt: Date | null; staleAt: Date | null }
interface Row { kind: TitleKind; tmdbId: number; listSource: StreamProbeListSource | null; listRank: number | null; listedAt: Date | null; outcome: ProbeOutcome | null; failures: number; retryAfter: Date | null }

/** ProbeRepo's rules in memory; tests/integration/streamProber.int.test.ts proves the SQL keeps the same ones. */
class MemoryStore implements ProbeStore {
  sources: Src[] = [];
  rows = new Map<string, Row>();
  playOpen = false;
  private key(kind: TitleKind, id: number): string {
    return `${kind}-${id}`;
  }
  /** Phase 5's isFreshStreamSource rule: verified inside the window and not stale. */
  private isFresh(s: Src, since: Date): boolean {
    return s.verifiedAt !== null && s.verifiedAt >= since && s.staleAt === null;
  }
  row(kind: TitleKind, tmdbId: number): Row {
    const k = this.key(kind, tmdbId);
    let r = this.rows.get(k);
    if (r === undefined) {
      r = { kind, tmdbId, listSource: null, listRank: null, listedAt: null, outcome: null, failures: 0, retryAfter: null };
      this.rows.set(k, r);
    }
    return r;
  }
  verify(kind: TitleKind, tmdbId: number, at: Date, season = 0, episode = 0): void {
    const titleId = this.key(kind, tmdbId);
    const s = this.sources.find((x) => x.titleId === titleId && x.season === season && x.episode === episode);
    if (s === undefined) this.sources.push({ titleId, kind, tmdbId, season, episode, verifiedAt: at, staleAt: null });
    else Object.assign(s, { verifiedAt: at, staleAt: null });
  }
  stale(kind: TitleKind, tmdbId: number, at: Date): void {
    for (const s of this.sources) if (s.titleId === this.key(kind, tmdbId)) s.staleAt = at;
  }
  async freshCount(_host: string, since: Date): Promise<number> {
    return new Set(this.sources.filter((s) => this.isFresh(s, since)).map((s) => s.titleId)).size;
  }
  async dueRechecks(_host: string, dueBefore: Date, limit: number): Promise<ProbeTarget[]> {
    return this.sources
      .filter((s) => s.verifiedAt !== null && s.verifiedAt <= dueBefore && s.staleAt === null)
      .sort((a, b) => a.verifiedAt!.getTime() - b.verifiedAt!.getTime())
      .slice(0, limit)
      .map((s) => ({ kind: s.kind, tmdbId: s.tmdbId, season: s.kind === 'tv' ? s.season : null, episode: s.kind === 'tv' ? s.episode : null }));
  }
  async listedAt(): Promise<Date | null> {
    const times = [...this.rows.values()].map((r) => r.listedAt?.getTime() ?? Number.NEGATIVE_INFINITY);
    const latest = Math.max(Number.NEGATIVE_INFINITY, ...times);
    return Number.isFinite(latest) ? new Date(latest) : null;
  }
  async replaceListing(_host: string, entries: readonly ListedCandidate[], at: Date): Promise<void> {
    for (const r of this.rows.values()) Object.assign(r, { listSource: null, listRank: null, listedAt: null });
    for (const e of entries) Object.assign(this.row(e.kind, e.tmdbId), { listSource: e.source, listRank: e.rank, listedAt: at });
  }
  async eligible(_host: string, kind: TitleKind, now: Date, since: Date, limit: number): Promise<ProbeTarget[]> {
    return [...this.rows.values()]
      .filter((r) => r.kind === kind && r.listSource !== null && (r.retryAfter === null || r.retryAfter <= now))
      .filter((r) => !this.sources.some((s) => s.titleId === this.key(r.kind, r.tmdbId) && this.isFresh(s, since)))
      .sort((a, b) => a.listRank! - b.listRank!)
      .slice(0, limit)
      .map((r) => ({ kind: r.kind, tmdbId: r.tmdbId, season: null, episode: null }));
  }
  async failures(_host: string, kind: TitleKind, tmdbId: number): Promise<number> {
    return this.rows.get(this.key(kind, tmdbId))?.failures ?? 0;
  }
  async record(_host: string, r: ProbeRecord): Promise<void> {
    Object.assign(this.row(r.kind, r.tmdbId), { outcome: r.outcome, failures: r.failures, retryAfter: r.retryAfter });
  }
  async activePlay(): Promise<boolean> {
    return this.playOpen;
  }
}

function hit(kind: TitleKind, tmdbId: number): TmdbSearchHit {
  return { kind, tmdbId, title: `T${tmdbId}`, originalTitle: `T${tmdbId}`, releaseDate: '2020-01-01', year: 2020, overview: '', posterPath: null, popularity: 1 };
}

function fakeTmdb(films: number[], series: number[]): TmdbCatalog & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async list(name, kind, page = 1) {
      calls.push(`${name}:${kind}:${page}`);
      return page > 1 ? [] : (kind === 'movie' ? films : series).map((id) => hit(kind, id));
    },
    async genres(kind) {
      calls.push(`genres:${kind}`);
      return [];
    },
    async discoverByGenre() {
      return [];
    },
    async recommendations() {
      return [];
    },
  };
}

type Answer = 'ok' | 'no_source' | 'error' | 'no_chrome' | 'deadline';

function setup(opts: { config?: Partial<StreamProberConfig>; films?: number[]; series?: number[]; resolveSeconds?: number } = {}) {
  const clock = new Clock(T0);
  const store = new MemoryStore();
  const idle = { seconds: 3600, reads: 0, fail: false };
  const reader: IdleReader = async () => {
    idle.reads += 1;
    return idle.fail ? { kind: 'error', message: 'boom' } : { kind: 'ok', idleSeconds: idle.seconds };
  };
  const answers = new Map<string, Answer>();
  const calls: ProbeRef[] = [];
  const deadlines: number[] = [];
  const hooks: { afterCall?: (ref: ProbeRef) => void } = {};
  // Phase 3's DirectStreamService.resolve: phase 5's hook writes verified (or stale on no_source) before it answers;
  // a failure rejects like DirectStreamError (code no_source, or resolve_failed with a reason).
  const resolve = async (ref: ProbeRef, options: { deadlineS: number }): Promise<unknown> => {
    calls.push(ref);
    deadlines.push(options.deadlineS);
    clock.advance((opts.resolveSeconds ?? 3) * 1000);
    hooks.afterCall?.(ref);
    const answer = answers.get(`${ref.kind}-${ref.tmdbId}`) ?? 'ok';
    if (answer === 'ok') {
      store.verify(ref.kind, ref.tmdbId, clock.now(), ref.season ?? 0, ref.episode ?? 0);
      return { session_id: 's' };
    }
    if (answer === 'no_source') {
      store.stale(ref.kind, ref.tmdbId, clock.now());
      throw Object.assign(new Error(answer), { code: 'no_source' });
    }
    if (answer === 'error') throw Object.assign(new Error(answer), { code: 'resolve_failed', reason: 'script_failed' });
    throw Object.assign(new Error(answer), { code: 'resolve_failed', reason: answer });
  };
  const tmdb = fakeTmdb(opts.films ?? [], opts.series ?? []);
  const vlc = { playing: false };
  const logs: string[] = [];
  const prober = new StreamProber({
    config: { ...DEFAULT_STREAM_PROBER_CONFIG, enabled: true, ...opts.config },
    freshDays: 7,
    host: HOST,
    store,
    tmdb,
    seeds: async () => [],
    resolve,
    idle: reader,
    vlcPlaying: () => vlc.playing,
    now: clock.now,
    log: (line) => logs.push(line),
  });
  return { clock, store, idle, answers, calls, deadlines, hooks, tmdb, vlc, logs, prober };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('R6.2: off opens nothing', () => {
  const DB_ENV = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/a' };

  for (const [label, env] of [
    ['unset', DB_ENV],
    ['off', { ...DB_ENV, NOTESD_STREAM_PROBER: 'off' }],
  ] as const) {
    it(`off starts nothing with NOTESD_STREAM_PROBER ${label}: no timer, no resolve, no idle read, no TMDB call in two days`, async () => {
      vi.useFakeTimers();
      const config = loadConfig({ env, envFile: false });
      const { calls, idle, tmdb, store } = setup();
      let resolves = 0;
      const handle = await buildStreamProber(
        {
          config,
          db: {} as Db,
          movies: { host: HOST } as unknown as MoviesService,
          moviesPlayer: null,
          directStream: {
            resolve: async () => {
              resolves += 1;
              return {};
            },
          },
        },
        { idle: { available: true, read: async () => ({ kind: 'ok', idleSeconds: 99_999 }) }, tmdb, store },
      );
      handle.start();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * DAY);
      expect(handle.enabled).toBe(false);
      expect(resolves + calls.length + idle.reads + tmdb.calls.length).toBe(0);
      expect(await handle.status()).toMatchObject({ enabled: false, off_reason: 'setting_off', last_pass: null });
      expect(handle.startLine()).toBe('[notesd] stream prober off: NOTESD_STREAM_PROBER is off (the default)');
    });
  }

  it('on, it is the setting alone that builds the loop; without powershell.exe it stays off and says why', async () => {
    const config = loadConfig({ env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/a', NOTESD_STREAM_PROBER: 'on', TMDB_API_KEY: 'k' }, envFile: false });
    const base = { config, db: {} as Db, movies: { host: HOST } as unknown as MoviesService, moviesPlayer: null, directStream: { resolve: async () => ({}) } };
    const { tmdb, store } = setup();
    const on = await buildStreamProber(base, { idle: { available: true, read: async () => ({ kind: 'ok', idleSeconds: 0 }) }, tmdb, store });
    expect(on.enabled).toBe(true);
    await on.close();
    const off = await buildStreamProber(base, { idle: { available: false, reason: 'no_powershell' }, tmdb, store });
    expect(await off.status()).toMatchObject({ enabled: false, off_reason: 'no_powershell' });
    expect(await buildStreamProber({ ...base, directStream: null }, { tmdb, store })).toMatchObject({ enabled: false, reason: 'direct_stream_off' });
  });
});

describe('R6.3: no probe while the laptop is in use', () => {
  it('not idle starts nothing', async () => {
    const t = setup({ films: [1, 2, 3] });
    t.idle.seconds = 30;
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([]);
    expect(pass).toMatchObject({ stopped: 'not_idle', idle_s: 30, probed: 0, rechecked: 0 });
    expect(pass.listed).toBe(3);
  });

  it('an idle time that cannot be read counts as not idle', async () => {
    const t = setup({ films: [1] });
    t.idle.fail = true;
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'not_idle', probed: 0, error: 'idle time unreadable: boom' });
    expect(t.calls).toEqual([]);
  });

  it('a VLC play or an open stream play starts nothing', async () => {
    const t = setup({ films: [1] });
    t.vlc.playing = true;
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'busy', busy: 'vlc' });
    t.vlc.playing = false;
    t.store.playOpen = true;
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'busy', busy: 'play' });
    expect(t.calls).toEqual([]);
  });

  it('an asked pass does not wait for idle, still stops for a play, and rebuilds the listing whatever its age', async () => {
    const t = setup({ films: [1, 2] });
    t.idle.seconds = 0;
    await t.prober.passNow();
    expect(t.calls).toEqual([]);
    const listed = t.tmdb.calls.length;
    // Asked: the owner is at the laptop and pressed refresh.
    const asked = await t.prober.passNow(true);
    expect(asked).toMatchObject({ asked: true, probed: 2, probe_verified: 2, idle_s: null });
    expect(asked.listed).toBe(2);
    expect(t.tmdb.calls.length).toBeGreaterThan(listed);
    t.vlc.playing = true;
    expect(await t.prober.passNow(true)).toMatchObject({ asked: true, stopped: 'busy', busy: 'vlc' });
    // askPass starts one and answers at once; a prober that is off refuses.
    t.vlc.playing = false;
    expect(t.prober.askPass()).toBe(true);
    expect((await t.prober.status()).running).toBe(true);
    await t.prober.passNow();
    expect(new DisabledProber('setting_off').askPass()).toBe(false);
  });

  it('stops between probes as soon as the laptop is no longer idle', async () => {
    const t = setup({ films: [1, 2, 3] });
    t.hooks.afterCall = () => {
      t.idle.seconds = 5;
    };
    const pass = await t.prober.passNow();
    expect(t.calls).toHaveLength(1);
    expect(pass).toMatchObject({ stopped: 'not_idle', probed: 1, probe_verified: 1 });
  });
});

describe('R6.1: candidates become verified titles within the budget', () => {
  it('turns TMDB candidates into verified titles, films first, a series by its first episode', async () => {
    const t = setup({ films: [1, 2, 3, 4], series: [9] });
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([
      { kind: 'movie', tmdbId: 1 },
      { kind: 'movie', tmdbId: 2 },
      { kind: 'movie', tmdbId: 3 },
      { kind: 'tv', tmdbId: 9, season: 1, episode: 1 },
      { kind: 'movie', tmdbId: 4 },
    ]);
    expect(pass).toMatchObject({ probed: 5, probe_verified: 5, catalog_fresh: 5, stopped: 'no_candidates' });
    expect(t.logs.at(-1)).toContain('5 probed (5 verified)');
  });

  it('the catalog stops at its size', async () => {
    const t = setup({ films: [1, 2, 3, 4, 5], config: { catalogSize: 2 } });
    t.store.verify('movie', 99, new Date(T0 - DAY));
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([{ kind: 'movie', tmdbId: 1 }]);
    expect(pass).toMatchObject({ stopped: 'catalog_full', catalog_fresh: 2 });
  });

  it('a pass stays inside its probe budget', async () => {
    const t = setup({ films: [1, 2, 3, 4, 5, 6], config: { probeBudget: 3 } });
    expect(await t.prober.passNow()).toMatchObject({ probed: 3, stopped: 'probe_budget' });
    expect(t.calls).toHaveLength(3);
  });

  it('a pass stays inside its seconds: half of NOTESD_STREAM_PROBE_MS', async () => {
    const t = setup({ films: [1, 2, 3, 4], config: { probeMs: 60_000 }, resolveSeconds: 20 });
    expect(await t.prober.passNow()).toMatchObject({ probed: 2, stopped: 'time_budget' });
  });

  it('gives each resolve the seconds left in the pass, and a resolve cut by that deadline blames no title', async () => {
    const t = setup({ films: [1, 2], config: { probeMs: 60_000 }, resolveSeconds: 10 });
    t.answers.set('movie-2', 'deadline');
    const pass = await t.prober.passNow();
    expect(t.deadlines).toEqual([30, 20]);
    expect(pass).toMatchObject({ probed: 1, probe_verified: 1, failed: 0, stopped: 'time_budget' });
    expect(t.store.row('movie', 2)).toMatchObject({ outcome: null, failures: 0 });
  });

  it('a source older than the freshness window is re-checked first, then those nearest its end; recent ones are not', async () => {
    const t = setup({ films: [50] });
    t.store.verify('movie', 10, new Date(T0 - 6 * DAY));
    t.store.verify('movie', 11, new Date(T0 - 8 * DAY));
    t.store.verify('tv', 12, new Date(T0 - 5 * DAY), 2, 3);
    t.store.verify('movie', 13, new Date(T0 - 1 * DAY));
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([
      { kind: 'movie', tmdbId: 11 },
      { kind: 'movie', tmdbId: 10 },
      { kind: 'tv', tmdbId: 12, season: 2, episode: 3 },
      { kind: 'movie', tmdbId: 50 },
    ]);
    expect(pass).toMatchObject({ rechecked: 3, recheck_verified: 3, probed: 1 });
  });

  it('never probes a title already verified fresh', async () => {
    const t = setup({ films: [1, 2] });
    t.store.verify('movie', 1, new Date(T0 - DAY));
    await t.prober.passNow();
    expect(t.calls).toEqual([{ kind: 'movie', tmdbId: 2 }]);
  });

  it('a title that fails waits out its backoff, which doubles', async () => {
    const t = setup({ films: [1] });
    t.answers.set('movie-1', 'no_source');
    expect(await t.prober.passNow()).toMatchObject({ probed: 1, failed: 1 });
    expect(t.store.row('movie', 1)).toMatchObject({ outcome: 'no_source', failures: 1 });
    t.clock.advance(20 * 60_000);
    await t.prober.passNow();
    expect(t.calls).toHaveLength(1);
    t.clock.advance(BACKOFF_BASE_MS);
    await t.prober.passNow();
    expect(t.calls).toHaveLength(2);
    expect(t.store.row('movie', 1).failures).toBe(2);
    expect(t.store.row('movie', 1).retryAfter!.getTime() - t.clock.t).toBe(2 * BACKOFF_BASE_MS);
  });

  it('a resolve that cannot reach Chrome ends the pass and blames no title', async () => {
    const t = setup({ films: [1, 2] });
    t.answers.set('movie-1', 'no_chrome');
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'chrome_unavailable', probed: 0, failed: 0 });
    expect(t.store.row('movie', 1)).toMatchObject({ outcome: null, failures: 0 });
  });

  it('reads both shapes of a failed resolve, and interleaves one series in four', () => {
    expect(classifyResolve({ ok: true, value: { ok: false, error: 'no_source' } })).toBe('no_source');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'chrome_not_reachable' }) })).toBe('chrome_unavailable');
    expect(classifyResolve({ ok: false, error: new Error('boom') })).toBe('error');
    expect(classifyResolve({ ok: true, value: { session_id: 's' } })).toBe('verified');
    // Phase 3's DirectStreamError: resolve_failed names its cause in `reason`.
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'resolve_failed', reason: 'no_chrome' }) })).toBe('chrome_unavailable');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'resolve_failed', reason: 'deadline' }) })).toBe('deadline');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'resolve_failed', reason: 'script_failed' }) })).toBe('error');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'no_source', attempts: [] }) })).toBe('no_source');
    expect(interleave(['a', 'b', 'c', 'd', 'e'], ['X', 'Y'], 4)).toEqual(['a', 'b', 'c', 'X', 'd', 'e', 'Y']);
  });

  it('rebuilds the listing once a day, not every pass', async () => {
    const t = setup({ films: [1] });
    await t.prober.passNow();
    const listCalls = t.tmdb.calls.length;
    t.clock.advance(60 * 60_000);
    await t.prober.passNow();
    expect(t.tmdb.calls.length).toBe(listCalls);
    t.clock.advance(DAY);
    await t.prober.passNow();
    expect(t.tmdb.calls.length).toBeGreaterThan(listCalls);
  });
});
