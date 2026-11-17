import { describe, expect, it } from 'vitest';
import { fetchTrends, selectTrends, type TrendRow } from '../../../../src/directStream/trending/sources.js';

const hash = (n: number): string => n.toString(16).padStart(40, 'a').toUpperCase();
const row = (over: Partial<TrendRow> & { n: number }): TrendRow => {
  const { n, ...rest } = over;
  return { kind: 'movie', imdbId: `tt${String(1000000 + n)}`, infoHash: hash(n), name: `Film ${n} 2026 1080p WEB-DL`, seeds: 100, sizeBytes: 2e9, index: 'apibay', ...rest };
};

describe('selectTrends', () => {
  it('keeps the best-seeded listing per IMDb id, most seeded first', () => {
    const out = selectTrends([row({ n: 1, seeds: 50 }), row({ n: 2, imdbId: 'tt1000001', seeds: 900 }), row({ n: 3, seeds: 70 })]);
    expect(out.map((t) => [t.imdbId, t.seeds])).toEqual([
      ['tt1000001', 900],
      ['tt1000003', 70],
    ]);
  });

  it('leaves out cinema recordings, dubs, 3D, dead swarms, unusable hashes and a film too big', () => {
    const out = selectTrends([
      row({ n: 1, name: 'Film 1 2026 HDCAM x264' }),
      row({ n: 2, name: 'Film 2 2026 1080p Hindi Dubbed' }),
      row({ n: 3, name: 'Film 3 2026 1080p 3D HSBS' }),
      row({ n: 4, seeds: 2 }),
      row({ n: 5, infoHash: '0'.repeat(40) }),
      row({ n: 6, sizeBytes: 40 * 1024 ** 3 }),
      row({ n: 7 }),
    ]);
    expect(out.map((t) => t.imdbId)).toEqual(['tt1000007']);
  });

  it('keeps a series by its best-seeded episode or pack, and a big pack stays', () => {
    const out = selectTrends([
      row({ n: 1, kind: 'tv', imdbId: 'tt9', name: 'Show S01E01 1080p', seeds: 300 }),
      row({ n: 2, kind: 'tv', imdbId: 'tt9', name: 'Show S01E02 1080p', seeds: 800, sizeBytes: 60 * 1024 ** 3 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'tv', seeds: 800, name: 'Show S01E02 1080p' });
  });

  it('lower-cases the info hash', () => {
    expect(selectTrends([row({ n: 1 })])[0]?.infoHash).toBe(hash(1).toLowerCase());
  });
});

function fakeFetch(answers: Record<string, unknown | number>): { fetch: typeof fetch; urls: string[]; agents: string[] } {
  const urls: string[] = [];
  const agents: string[] = [];
  const f = (async (url: string, init: { headers: Headers }) => {
    urls.push(url);
    agents.push(init.headers.get('user-agent') ?? '');
    const hit = Object.entries(answers).find(([k]) => url.includes(k));
    const body = hit?.[1];
    if (typeof body === 'number') return new Response('nope', { status: body });
    return new Response(JSON.stringify(body ?? []), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: f, urls, agents };
}

describe('fetchTrends', () => {
  it('reads apibay top lists and EZTV pages with notesd as the user agent, naming each IMDb id', async () => {
    const f = fakeFetch({
      data_top100_207: [{ info_hash: hash(1), name: 'Film 1 (2026) 1080p', seeders: '500', size: 1e9, imdb: 'tt0000001' }, { info_hash: hash(2), name: 'No id', seeders: 9, imdb: null }],
      data_top100_208: [{ info_hash: hash(3), name: 'Show S01E01', seeders: 700, size: 1e9, imdb: 'tt0000002' }],
      'api/get-torrents': { torrents: [{ hash: hash(4), title: 'Other S02E01', seeds: 80, size_bytes: '1000', imdb_id: '3333333' }] },
    });
    const got = await fetchTrends({ fetch: f.fetch });
    expect(got.rows.map((r) => [r.kind, r.imdbId, r.seeds, r.index]).sort()).toEqual([
      ['movie', 'tt0000001', 500, 'apibay'],
      ['tv', 'tt0000002', 700, 'apibay'],
      ['tv', 'tt3333333', 80, 'eztv'],
    ]);
    expect(got.attempts.map((a) => [a.index, a.outcome]).sort()).toEqual([
      ['apibay', 'ok'],
      ['eztv', 'ok'],
    ]);
    expect(new Set(f.agents)).toEqual(new Set([expect.stringContaining('notesd')]));
  });

  it('reports an index that fails and keeps the other one', async () => {
    const f = fakeFetch({ precompiled: 503, 'api/get-torrents': { torrents: [{ hash: hash(4), title: 'Other S02E01', seeds: 80, imdb_id: '3333333' }] } });
    const got = await fetchTrends({ fetch: f.fetch });
    expect(got.attempts.find((a) => a.index === 'apibay')?.outcome).toBe('error');
    expect(got.rows).toHaveLength(1);
  });

  it('asks no index that is off', async () => {
    const f = fakeFetch({});
    const got = await fetchTrends({ fetch: f.fetch, apibay: null, eztv: null });
    expect(f.urls).toEqual([]);
    expect(got).toEqual({ rows: [], attempts: [] });
  });
});
