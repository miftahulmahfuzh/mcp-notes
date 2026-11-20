import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANARY_DEADLINE_S, DisabledCanary, StreamCanary, canaryProviders, type CanaryProvider } from '../../../src/directStream/canary.js';
import type { ResolveOutput, StreamRef } from '../../../src/directStream/types.js';
import type { KnownTitle } from '../../../src/directStream/updateSource.js';

const TITLES: KnownTitle[] = [
  { label: 'Breaking Bad S02E03', ref: { kind: 'tv', tmdbId: 1396, season: 2, episode: 3 } },
  { label: 'Fight Club (1999)', ref: { kind: 'movie', tmdbId: 550 } },
];
const PROVIDERS: CanaryProvider[] = [
  { name: 'VidFast', idKind: 'tmdb', browserOnly: false },
  { name: 'VidNest Anime', idKind: 'anilist', browserOnly: false },
  { name: 'Clicky', idKind: 'tmdb', browserOnly: true },
  { name: 'VidRock', idKind: 'imdb', browserOnly: false },
];

const resolved = (provider: string): ResolveOutput => ({ ok: true, source: { provider } as never, attempts: [] }) as unknown as ResolveOutput;
const failed = (): ResolveOutput => ({ ok: false, source: null, error: 'no_source', detail: '', attempts: [] }) as ResolveOutput;

function canary(over: { busy?: () => boolean; resolve?: (ref: StreamRef, o: { only: string; deadlineS: number }) => Promise<ResolveOutput> } = {}) {
  const calls: Array<{ ref: StreamRef; only: string; deadlineS: number }> = [];
  const lines: string[] = [];
  const c = new StreamCanary({
    providers: async () => PROVIDERS,
    knownTitles: async () => TITLES,
    resolve: async (ref, o) => {
      calls.push({ ref, ...o });
      return over.resolve ? over.resolve(ref, o) : o.only === 'VidFast' ? resolved(o.only) : failed();
    },
    busy: over.busy ?? (() => false),
    log: (l) => lines.push(l),
    initialDelayMs: 10,
    everyMs: 1000,
    busyRetryMs: 100,
  });
  return { c, calls, lines };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the stream canary', () => {
  it('asks only the providers a script can resolve by TMDB or IMDb id', () => {
    expect(canaryProviders(PROVIDERS)).toEqual(['VidFast', 'VidRock']);
  });

  it('asks each one for the first known film, with --only and a deadline, and logs one line', async () => {
    const { c, calls, lines } = canary();
    const pass = await c.pass();
    expect(calls).toEqual([
      { ref: { kind: 'movie', tmdbId: 550 }, only: 'VidFast', deadlineS: CANARY_DEADLINE_S },
      { ref: { kind: 'movie', tmdbId: 550 }, only: 'VidRock', deadlineS: CANARY_DEADLINE_S },
    ]);
    expect(pass).toMatchObject({ asked: 2, resolved: 1, stopped: 'done', left: 0 });
    expect(lines).toEqual(['[notesd] stream canary: 1 of 2 providers resolved; done']);
  });

  it('asks nothing while something plays, and stops between providers when a play starts', async () => {
    const idle = canary({ busy: () => true });
    expect(await idle.c.pass()).toMatchObject({ asked: 0, stopped: 'busy', left: 2 });
    expect(idle.calls).toEqual([]);

    let playing = false;
    const cut = canary({
      busy: () => playing,
      resolve: async () => {
        playing = true;
        return failed();
      },
    });
    expect(await cut.c.pass()).toMatchObject({ asked: 1, stopped: 'busy', left: 1 });
  });

  it('a provider that throws is logged and the others are still asked', async () => {
    const { c, calls, lines } = canary({
      resolve: async (_ref, o) => {
        if (o.only === 'VidFast') throw new Error('chrome gone');
        return resolved(o.only);
      },
    });
    expect(await c.pass()).toMatchObject({ asked: 2, resolved: 1 });
    expect(calls.map((x) => x.only)).toEqual(['VidFast', 'VidRock']);
    expect(lines[0]).toBe('[notesd] stream canary: VidFast: chrome gone');
  });

  it('runs after its first delay, then again a day later (an hour after a busy pass)', async () => {
    vi.useFakeTimers();
    let playing = true;
    const { c, calls } = canary({ busy: () => playing });
    c.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(0);
    playing = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(4);
    await c.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(4);
  });

  it('off says why and starts nothing', () => {
    const off = new DisabledCanary('setting_off');
    off.start();
    expect(off.enabled).toBe(false);
    expect(off.startLine()).toBe('[notesd] stream canary off: NOTESD_STREAM_CANARY=off');
  });
});
