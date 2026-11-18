import { describe, expect, it, vi } from 'vitest';
import type { LookupDeps, TitleCandidate } from '../../src/directStream/lookup.js';
import type { TmdbSearchHit } from '../../src/movies/tmdb.js';
import { recordSitePlay, siteTitleKeeper, type SitePlayReport } from '../../src/streaming/sitePlays.js';

const hit = (kind: 'movie' | 'tv', tmdbId: number, title: string, year: number): TmdbSearchHit =>
  ({ kind, tmdbId, title, originalTitle: title, year, popularity: 1, posterPath: null, overview: '' }) as unknown as TmdbSearchHit;

function setup(o: { tv?: TmdbSearchHit[]; movie?: TmdbSearchHit[]; stored?: TitleCandidate[]; tmdb?: boolean } = {}) {
  const searches: string[] = [];
  const lookup: LookupDeps = {
    library: { search: async () => o.stored ?? [], byKey: async () => null, byMovieId: async () => null, seasons: async () => [] },
    tmdb:
      o.tmdb === false
        ? null
        : {
            searchTv: async (name: string, year: number | null) => {
              searches.push(`tv ${name} ${year}`);
              return (o.tv ?? []).filter((h) => year === null || h.year === year);
            },
            searchMovie: async (name: string, year: number | null) => {
              searches.push(`movie ${name} ${year}`);
              return (o.movie ?? []).filter((h) => year === null || h.year === year);
            },
          },
  };
  const recordSite = vi.fn(async (target: { kind: string; tmdbId: number }) => ({ titleId: `${target.kind}-${target.tmdbId}`, playId: 1 }));
  const run = (report: SitePlayReport) => recordSitePlay(report, { lookup, streams: { recordSitePlay: recordSite as never }, log: () => undefined });
  return { run, recordSite, searches };
}

const DRAMA: SitePlayReport = { site: 'dramacool', url: 'https://dramacool9.com.ro/summer-vacation-2026', name: 'Summer Vacation', original_name: null, year: 2026, kind: 'series', season: 1, episode: 3 };

describe('recordSitePlay', () => {
  it("keeps an episode played on a site under the series TMDB lists by that name and year, with the site's page", async () => {
    const t = setup({ tv: [hit('tv', 335951, 'Summer Vacation', 2026), hit('tv', 7, 'Summer Vacation', 2011)] });
    expect(await t.run(DRAMA)).toEqual({ recorded: true, title_id: 'tv-335951', season: 1, episode: 3 });
    expect(t.recordSite).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 335951, season: 1, episode: 3 }, 'dramacool', DRAMA.url);
  });

  it('keeps a film under the film of that name and year', async () => {
    const t = setup({ movie: [hit('movie', 572468, 'Impetigore', 2019)] });
    const kept = await t.run({ site: 'flicksy', url: 'https://flicksy.pro/watch/movie/572468', name: 'Impetigore', year: 2019, kind: 'movie' });
    expect(kept).toEqual({ recorded: true, title_id: 'movie-572468', season: null, episode: null });
    expect(t.recordSite).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 572468 }, 'flicksy', 'https://flicksy.pro/watch/movie/572468');
  });

  it('looks a later season up without its own year, and a one-episode "series" up as a film', async () => {
    const season2 = setup({ tv: [hit('tv', 9, 'Love Wins All', 2025)] });
    expect(await season2.run({ ...DRAMA, name: 'Love Wins All', original_name: 'Love Wins All Season 2', season: 2, episode: 5 })).toEqual({ recorded: true, title_id: 'tv-9', season: 2, episode: 5 });

    const film = setup({ movie: [hit('movie', 11, 'Devil River', 2025)] });
    expect(await film.run({ ...DRAMA, name: 'Devil River', year: 2025, episode: 1 })).toEqual({ recorded: true, title_id: 'movie-11', season: null, episode: null });
    expect(film.recordSite).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 11 }, 'dramacool', DRAMA.url);
    // An episode other than the first is no film.
    expect(await setup({ movie: [hit('movie', 11, 'Summer Vacation', 2026)] }).run(DRAMA)).toEqual({ recorded: false, reason: 'no_match' });
  });

  it('keeps nothing when no title, or more than one, carries the name, and says which', async () => {
    expect(await setup().run(DRAMA)).toEqual({ recorded: false, reason: 'no_match' });
    const two = setup({ tv: [hit('tv', 1, 'Summer Vacation', 2026), hit('tv', 2, 'Summer Vacation', 2026)] });
    expect(await two.run(DRAMA)).toEqual({ recorded: false, reason: 'several_matches', candidates: ['tv-1', 'tv-2'] });
    expect(two.recordSite).not.toHaveBeenCalled();
  });

  it('keeps nothing for a play that names no title, and without TMDB', async () => {
    expect(await setup().run({ site: 'lk21', url: 'https://tv12.lk21official.cc/x-2020' })).toEqual({ recorded: false, reason: 'no_name' });
    expect(await setup({ tmdb: false }).run(DRAMA)).toEqual({ recorded: false, reason: 'tmdb_unavailable' });
  });

  it('a title TMDB does not list is kept by what the site says of it, when a keeper is given', async () => {
    const t = setup();
    const kept = await recordSitePlay(DRAMA, { lookup: { library: { search: async () => [], byKey: async () => null, byMovieId: async () => null, seasons: async () => [] }, tmdb: { searchTv: async () => [], searchMovie: async () => [] } }, streams: { recordSitePlay: t.recordSite as never }, siteTitles: async () => 7, log: () => undefined });
    expect(kept).toEqual({ recorded: true, title_id: null, site_title_id: 7, season: 1, episode: 3 });
    expect(t.recordSite).not.toHaveBeenCalled();
  });
});

describe('siteTitleKeeper', () => {
  const AT = new Date('2026-11-18T12:00:00Z');
  function keeper(answer: unknown) {
    const kept: unknown[] = [];
    const runs: Array<[string, string[]]> = [];
    const keep = siteTitleKeeper({
      repo: { keepSiteTitle: async (input: unknown) => (kept.push(input), { id: 3 }) } as never,
      host: 'host-a',
      runner: async (site, args) => {
        runs.push([site, args]);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      now: () => AT,
      log: () => undefined,
    });
    return { keep, kept, runs };
  }

  it("asks the site's own page for the poster and the words, and keeps them with the play", async () => {
    const t = keeper({ ok: true, details: { poster_url: 'https://dramacool9.com.ro/p.jpg', overview: 'A girl and her summer.', country: 'South Korea', status: 'Ongoing', year: 2026, genres: ['Drama', '', 7], also_known: 'Yeoreumbanghak' } });
    expect(await t.keep(DRAMA)).toBe(3);
    expect(t.runs).toEqual([['dramacool', ['--details', DRAMA.url]]]);
    expect(t.kept).toEqual([
      { host: 'host-a', site: 'dramacool', siteUrl: DRAMA.url, kind: 'series', name: 'Summer Vacation', year: 2026, posterUrl: 'https://dramacool9.com.ro/p.jpg', overview: 'A girl and her summer.', country: 'South Korea', status: 'Ongoing', genres: ['Drama'], alsoKnown: 'Yeoreumbanghak', season: 1, episode: 3, at: AT },
    ]);
  });

  it('keeps the title by its name alone when the page cannot be read, says nothing, or names a poster that is not https', async () => {
    for (const answer of [new Error('HTTP 503'), { ok: true, details: null }, { ok: true, details: { poster_url: 'http://dramacool9.com.ro/p.jpg' } }]) {
      const t = keeper(answer);
      expect(await t.keep({ ...DRAMA, kind: 'movie', season: null, episode: null })).toBe(3);
      expect(t.kept[0]).toMatchObject({ kind: 'movie', name: 'Summer Vacation', posterUrl: null, overview: null, genres: [], season: null, episode: null });
    }
    expect(await keeper({}).keep({ site: 'dramacool', url: DRAMA.url })).toBeNull();
  });
});
