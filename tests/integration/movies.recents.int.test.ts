import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { movieFiles, moviePlays } from '../../src/db/schema.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { nodeRecentsFs, recentsSyncHook, type TitleResolver } from '../../src/movies/vlc/recents.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { seedFile, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HOST = 'this-host';
const INI = [
  '[RecentsMRL]',
  'list=file:///C:/Users/u/Videos/Known.Film.2026.1080p.mkv, file:///C:/Users/u/Downloads/Telegram%20Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv, file:///C:/Users/u/Downloads/Telegram%20Desktop/Moved.Film.2025.mkv, https://example.com/live',
  'times=1307375, 6684192, -1, 0',
].join('\n');

const resolver: TitleResolver = {
  match: async () => ({ kind: 'matched', tmdbKind: 'movie', tmdbId: 1001, confidence: 0.97 }) as never,
  details: async () => {
    throw new Error('the title is seeded; details must not be fetched');
  },
};

describe('[RecentsMRL] sync hook', () => {
  let h: ApiHarness;
  let dir: string;

  beforeAll(async () => {
    h = await createApiHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateMovies(h.deps.db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'movies-recents-'));
  });

  it('records positions for known files, keeps a gone film under its title, and records nothing twice (R4.4)', async () => {
    const db = h.deps.db;
    await seedTitle(db, { id: 'movie-1', kind: 'movie', tmdbId: 1, title: 'Known Film', year: 2026 });
    await seedTitle(db, { id: 'movie-1001', kind: 'movie', tmdbId: 1001, title: 'The Dog Stars', year: 2026, runtimeMin: 120 });
    await seedTitle(db, { id: 'movie-2', kind: 'movie', tmdbId: 2, title: 'Moved Film', year: 2025 });
    const known = await seedFile(db, { titleId: 'movie-1', host: HOST, path: '/mnt/c/Users/u/Videos/Known.Film.2026.1080p.mkv', durationS: 7200 });
    const moved = await seedFile(db, { titleId: 'movie-2', host: HOST, path: '/mnt/c/Users/u/Videos/Done/Moved.Film.2025.mkv', durationS: 6000 });
    const iniPath = path.join(dir, 'vlc-qt-interface.ini');
    await writeFile(iniPath, INI);
    const deps = { iniPath, roots: ['/mnt/c/Users/u/Videos', '/mnt/c/Users/u/Downloads/Telegram Desktop'], host: HOST, repo: new MoviesRepo(db), resolver, fs: { ...nodeRecentsFs, exists: async () => false }, log: () => {} };

    const first = await recentsSyncHook(deps).run();
    expect(first).toMatchObject({ observed: 3, created: 1 });

    const plays = await db.select().from(moviePlays).orderBy(asc(moviePlays.id));
    expect(plays.find((p) => p.fileId === known)).toMatchObject({ source: 'vlc_recents', positionS: 1307.375, durationS: 7200 });
    expect(plays.find((p) => p.fileId === moved)).toMatchObject({ source: 'vlc_recents', positionS: null });
    const [dog] = await db.select().from(movieFiles).where(eq(movieFiles.titleId, 'movie-1001'));
    expect(dog).toMatchObject({ host: HOST, source: 'vlc_recents', name: 'The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv' });
    expect(dog!.deletedAt).not.toBeNull();
    expect(plays.find((p) => p.fileId === dog!.id)).toMatchObject({ positionS: 6684.192, durationS: 7200 });
    expect(await db.select().from(movieFiles)).toHaveLength(3); // the moved file was found by name, no duplicate

    expect((await recentsSyncHook(deps).run()).observed).toBe(0); // a fresh process: positions unchanged
    expect(await db.select().from(moviePlays)).toHaveLength(plays.length);
    await rm(dir, { recursive: true, force: true });
  });
});
