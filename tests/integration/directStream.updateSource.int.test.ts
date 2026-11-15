import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamProviders } from '../../src/db/schema.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { updateSource, type KnownTitle, type ProbeResult, type UpdateSourceDeps } from '../../src/directStream/updateSource.js';
import { closeTestDb, openTestDb } from './setup.js';

const SITE = 'https://ww6-fmovies.example/';
const ORIGIN = 'https://ww6-fmovies.example';
const FILMS: KnownTitle[] = [
  { label: 'Fight Club (1999)', ref: { kind: 'movie', tmdbId: 550 } },
  { label: 'A recent film', ref: { kind: 'movie', tmdbId: 1_100_000 } },
];
const EPISODE: KnownTitle = { label: 'A series S01E01', ref: { kind: 'tv', tmdbId: 1399, season: 1, episode: 1 } };
const KNOWN: KnownTitle[] = [...FILMS, EPISODE];

const READ = {
  ok: true,
  site: SITE,
  scripts_read: 2,
  skipped: [],
  providers: [
    // The registry has it under another query string: known, not added.
    { name: 'VidFast', movie: 'https://vidfast.pro/movie/{id}?autoPlay=false', tv: null, found_in: null },
    // The name is taken by another host: added as "VidSrc (vidsrc.xyz)".
    { name: 'VidSrc', movie: 'https://vidsrc.xyz/embed/movie/{id}', tv: 'https://vidsrc.xyz/embed/tv/{id}/{season}/{episode}', found_in: null },
    { name: 'Fresh', movie: 'https://fresh.example/movie/{id}', tv: null, found_in: null },
  ],
};

let db: Db;
let repo: DirectStreamRepo;

async function rows() {
  return (await db.select().from(streamProviders)).sort((a, b) => a.name.localeCompare(b.name));
}

function probeFake() {
  return vi.fn(async (provider: string, title: KnownTitle): Promise<ProbeResult> =>
    provider === 'Fresh'
      ? { title: title.label, outcome: 'no_stream', took_s: 35, manifest_kind: null, best_height: null, en_subtitle: null, detail: 'nothing in 35 s' }
      : { title: title.label, outcome: 'resolved', took_s: 2.5, manifest_kind: 'hls', best_height: 1080, en_subtitle: true, detail: '' },
  );
}

function deps(runnerAnswer: unknown, probe = probeFake()): UpdateSourceDeps & { probe: ReturnType<typeof probeFake>; runner: ReturnType<typeof vi.fn> } {
  const runner = vi.fn(async (args: string[]) => {
    expect(args).toEqual(['templates', SITE]);
    if (runnerAnswer instanceof Error) throw runnerAnswer;
    return runnerAnswer;
  });
  return {
    runner,
    registry: { list: () => repo.providers(), insert: (r) => repo.insertProviders(r) },
    knownTitles: async () => KNOWN,
    probe,
  };
}

beforeAll(() => {
  db = openTestDb();
  repo = new DirectStreamRepo(db);
});

afterAll(async () => {
  await db.delete(streamProviders);
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.delete(streamProviders);
  await repo.insertProviders(
    [
      { name: 'VidFast', movie: 'https://vidfast.pro/movie/{id}?autoPlay=true', tv: null, originSite: null },
      { name: 'VidSrc', movie: 'https://vidsrc.me/embed/movie?tmdb={id}', tv: null, originSite: null },
    ],
    new Date('2026-11-01T00:00:00.000Z'),
  );
});

describe('/update-cloud-source against the registry', () => {
  it('adds only what the registry lacks, leaves existing rows untouched, and probes each new one', async () => {
    const before = await rows();
    const d = deps(READ);
    const answer = await updateSource(SITE, d);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.known).toEqual([{ name: 'VidFast', registry_name: 'VidFast' }]);
    expect(answer.added.map((a) => [a.name, a.renamed_from, a.resolves])).toEqual([
      ['VidSrc (vidsrc.xyz)', 'VidSrc', true],
      ['Fresh', null, false],
    ]);

    const after = await rows();
    expect(after).toHaveLength(4);
    for (const old of before) expect(after.find((r) => r.name === old.name)).toEqual(old);
    const fresh = after.find((r) => r.name === 'Fresh');
    expect(fresh).toMatchObject({ movie: 'https://fresh.example/movie/{id}', tv: null, originSite: ORIGIN, browserOnly: false });
    expect(fresh?.addedAt).toBeInstanceOf(Date);
    expect(after.find((r) => r.name === 'VidSrc (vidsrc.xyz)')).toMatchObject({ tv: 'https://vidsrc.xyz/embed/tv/{id}/{season}/{episode}', originSite: ORIGIN });

    // Films for both; the episode only for the one that has an episode template and resolved a film.
    expect(d.probe.mock.calls.map(([provider, title]) => [provider, title.label])).toEqual([
      ['VidSrc (vidsrc.xyz)', 'Fight Club (1999)'],
      ['VidSrc (vidsrc.xyz)', 'A recent film'],
      ['VidSrc (vidsrc.xyz)', 'A series S01E01'],
      ['Fresh', 'Fight Club (1999)'],
      ['Fresh', 'A recent film'],
    ]);
    expect(answer.added[1]?.probes.map((p) => p.outcome)).toEqual(['no_stream', 'no_stream']);
  });

  it('inserts once: a second read of the same site adds and probes nothing', async () => {
    await updateSource(SITE, deps(READ));
    const once = await rows();
    const d = deps(READ);
    const again = await updateSource(SITE, d);
    expect(again).toMatchObject({ ok: true, added: [] });
    if (again.ok) expect(again.known.map((k) => k.registry_name).sort()).toEqual(['Fresh', 'VidFast', 'VidSrc (vidsrc.xyz)']);
    expect(d.probe).not.toHaveBeenCalled();
    expect(await rows()).toEqual(once);
  });

  it.each([
    ['a bot check', { ok: false, site: SITE, error: 'bot_check', detail: 'the page answered HTTP 403 with a bot check', scripts_read: 0 }, 'bot_check'],
    ['no template', { ok: false, site: SITE, error: 'no_templates', detail: 'read the page and 12 scripts and found no provider template', scripts_read: 12 }, 'no_templates'],
    ['a reader that crashed', new Error('direct stream script failed: timeout'), 'reader_failed'],
    ['a reader that printed something else', { hello: 'world' }, 'reader_failed'],
  ])('says so and leaves the registry unchanged on %s', async (_label, runnerAnswer, error) => {
    const before = await rows();
    const d = deps(runnerAnswer);
    const answer = await updateSource(SITE, d);
    expect(answer).toMatchObject({ ok: false, error, registry_changed: false });
    expect(await rows()).toEqual(before);
    expect(d.probe).not.toHaveBeenCalled();
  });

  it('writes nothing when the known titles cannot be read', async () => {
    const before = await rows();
    const d = { ...deps(READ), knownTitles: async () => Promise.reject(new Error('ENOENT known-titles.json')) };
    await expect(updateSource(SITE, d)).rejects.toThrow('ENOENT');
    expect(await rows()).toEqual(before);
    expect(d.runner).not.toHaveBeenCalled();
  });
});
