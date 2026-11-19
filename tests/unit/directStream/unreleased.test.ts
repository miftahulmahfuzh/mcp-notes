import { describe, expect, it } from 'vitest';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, NOT_RELEASED } from '../../../src/directStream/service.js';
import { DirectStreamError } from '../../../src/directStream/types.js';

const FILM = { kind: 'movie' as const, tmdbId: 806704 };
const EPISODE = { kind: 'tv' as const, tmdbId: 95480, season: 6, episode: 6 };
const RESOLVED = {
  ok: true,
  source: { provider: 'Alpha', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', subtitles: [], best_height: 1080 },
  attempts: [{ provider: 'Alpha', outcome: 'resolved', took_s: 1, detail: '' }],
};

function setup(releaseDate: string | null | Error) {
  const runs: string[] = [];
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      runs.push(args[0] ?? '');
      return args[0] === 'open' ? { ok: true } : RESOLVED;
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: {
      releaseDate: async () => {
        if (releaseDate instanceof Error) throw releaseDate;
        return releaseDate;
      },
    },
    now: () => new Date('2026-11-19T15:00:00.000Z'),
    log: () => undefined,
  });
  return { svc, runs };
}
const refused = async (work: Promise<unknown>): Promise<DirectStreamError> => {
  try {
    await work;
  } catch (err) {
    if (err instanceof DirectStreamError) return err;
    throw err;
  }
  throw new Error('the play was not refused');
};

describe('a title that is not out yet', () => {
  it('a film whose day is still to come: no_source, one attempt that says why, and nothing was asked', async () => {
    const t = setup('2028-10-01');
    const err = await refused(t.svc.play(FILM));
    expect(err.code).toBe('no_source');
    expect(err.message).toContain('is not released yet (2028-10-01)');
    expect(err.attempts).toEqual([expect.objectContaining({ provider: NOT_RELEASED, outcome: 'skipped' })]);
    expect(err.attempts[0]?.detail).toContain('TMDB gives 2028-10-01');
    expect(t.runs).toEqual([]);
  });

  it('holds whatever source is named: cloud, torrent or one provider', async () => {
    for (const provider of ['cloud', 'torrent', 'Alpha']) {
      const t = setup('2026-12-18');
      expect((await refused(t.svc.play(FILM, { provider }))).attempts[0]?.provider).toBe(NOT_RELEASED);
      expect(t.runs).toEqual([]);
    }
  });

  it('an episode that has not aired says so', async () => {
    const t = setup('2026-11-25');
    expect((await refused(t.svc.play(EPISODE))).message).toContain('has not aired yet (2026-11-25)');
  });

  it('a vetted resolve (a cache) is refused too; a plain resolve (a probe, a subtitle read) is not', async () => {
    const t = setup('2028-10-01');
    expect((await refused(t.svc.resolve(FILM, { vet: true }))).code).toBe('no_source');
    expect(t.runs).toEqual([]);
    await t.svc.resolve(FILM);
    expect(t.runs).toEqual(['resolve']);
  });

  it('plays as usual when the day is today, is past, is unknown, or cannot be read', async () => {
    for (const day of ['2026-11-19', '1999-03-31', null, 'soon', new Error('TMDB is down')]) {
      const t = setup(day);
      const played = await t.svc.play(FILM);
      expect(played.session.provider).toBe('Alpha');
      expect(t.runs).toEqual(['resolve', 'open']);
    }
  });
});
