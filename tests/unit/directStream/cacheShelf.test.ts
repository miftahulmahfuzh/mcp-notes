import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamCacheRow } from '../../../src/db/schema.js';
import { CacheShelf, ShelfError, type LiveSlot, type ShelfCaches, type ShelfTorrents } from '../../../src/directStream/cacheShelf.js';
import { TorrentStreams } from '../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../src/directStream/torrent/store.js';
import { TorrentError } from '../../../src/directStream/torrent/types.js';
import type { SeasonView, TitleListItem } from '../../../src/movies/read.js';
import { FakeTorrentEngine } from '../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../helpers/memoryTorrentRecords.js';

const HOST = 'host-a';
const PACK = 'aaaa'.padEnd(40, '1');
const FILM = 'bbbb'.padEnd(40, '2');
const KIB = 1024;
const SHOW = 'Show.S01';
const MADE = new Date('2026-11-19T10:00:00Z');

let root: string;
let cacheRoot: string;
let pendingFile: string;
let clock: number;

/** Bytes on disk the way the shelf counts them (blocks). */
async function onDisk(file: string): Promise<number> {
  const s = await stat(file);
  return s.blocks > 0 ? s.blocks * 512 : s.size;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function put(file: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 7));
}

/** A season pack with E01 and E02 chosen, a shared kept subtitle, E01's remux and cues, and an unchosen file's edge; and a film. */
async function seed(records: MemoryTorrentRecords, folder: TorrentFolder): Promise<void> {
  const files = [
    { index: 0, path: `${SHOW}/Show.S01E01.mkv`, length: 64 * KIB },
    { index: 1, path: `${SHOW}/Show.S01E02.mkv`, length: 32 * KIB },
    { index: 3, path: `${SHOW}/Show.S01.en.srt`, length: 4 * KIB },
  ];
  for (const [episode, video] of [
    [1, 0],
    [2, 1],
  ] as const) {
    const ref = { kind: 'tv' as const, tmdbId: 500, season: 1, episode };
    await records.record(HOST, { infoHash: PACK, ref, name: SHOW, release: SHOW, trackers: [] }, MADE);
    const chosen = [files[video]!, files[2]!];
    await records.chosen(HOST, { infoHash: PACK, season: 1, episode }, { files: chosen, fileIndex: video, fileLength: files[video]!.length }, MADE);
    await records.ready(HOST, { infoHash: PACK, season: 1, episode }, files[video]!.length, MADE);
  }
  await put(folder.diskPath(PACK, files[0]!.path)!, 64 * KIB);
  await put(folder.diskPath(PACK, files[1]!.path)!, 32 * KIB);
  await put(folder.diskPath(PACK, files[2]!.path)!, 4 * KIB);
  await put(path.join(folder.dirOf(PACK), 'notesd-remux', '0', 'seg-00000.m4s'), 16 * KIB);
  await put(path.join(folder.dirOf(PACK), 'notesd-cues', 'whisper-0.jsonl'), 4 * KIB);
  await put(path.join(folder.dirOf(PACK), '.notesd-subs', 'file-3.vtt'), 4 * KIB);
  await put(folder.diskPath(PACK, `${SHOW}/sample.mkv`)!, 8 * KIB);
  // The film: one torrent, one row.
  await records.record(HOST, { infoHash: FILM, ref: { kind: 'movie', tmdbId: 77 }, name: 'Film', release: 'Film', trackers: [] }, MADE);
  await records.chosen(HOST, { infoHash: FILM, season: 0, episode: 0 }, { files: [{ index: 0, path: 'Film/Film.mp4', length: 128 * KIB }], fileIndex: 0, fileLength: 128 * KIB }, MADE);
  await records.ready(HOST, { infoHash: FILM, season: 0, episode: 0 }, 128 * KIB, MADE);
  await put(folder.diskPath(FILM, 'Film/Film.mp4')!, 128 * KIB);
}

function item(id: string, kind: 'movie' | 'tv', title: string, marks: { watched?: boolean; not_interested?: boolean; finished?: boolean } = {}): TitleListItem {
  return {
    id,
    movie_id: kind === 'tv' ? 'M-SHOW' : 'M-FILM',
    kind,
    tmdb_id: Number(id.split('-')[1]),
    title,
    year: 2024,
    poster_url: null,
    state: marks.finished === true || marks.watched === true ? 'finished' : 'in_progress',
    watched: marks.watched ?? false,
    watched_at: null,
    not_interested: marks.not_interested ?? false,
    interested: false,
    rating: null,
    progress: { kind: 'movie', position_s: null, duration_s: null, ratio: null },
    last_played_at: null,
    finished_at: null,
    present_here: false,
    file_count: 0,
    deleted_file_count: 0,
    created_at: MADE.toISOString(),
  } as TitleListItem;
}

function seasons(finished: number[]): SeasonView[] {
  return [
    {
      season: 1,
      trailer_key: null,
      has_story: false,
      episodes: [1, 2, 3].map((episode) => ({ season: 1, episode, movie_id: `M-E00${episode}`, name: `Episode ${episode}`, state: finished.includes(episode) ? 'finished' : 'unwatched' }) as SeasonView['episodes'][number]),
    },
  ];
}

function cloudRow(id: string, tmdbId: number): StreamCacheRow {
  return { id, host: HOST, kind: 'movie', tmdbId, season: 0, episode: 0 } as StreamCacheRow;
}

interface Built {
  shelf: CacheShelf;
  streams: TorrentStreams;
  records: MemoryTorrentRecords;
  folder: TorrentFolder;
  fire: () => Promise<void>;
  removedCaches: string[];
  lines: string[];
}

function build(o: { records?: MemoryTorrentRecords; finished?: number[]; filmWatched?: boolean; filmNotInterested?: boolean; live?: LiveSlot[]; busyHash?: string; busyCache?: string } = {}): Built {
  const records = o.records ?? new MemoryTorrentRecords();
  const folder = new TorrentFolder(root);
  const lines: string[] = [];
  const streams = new TorrentStreams({ engine: new FakeTorrentEngine([]), repo: records, folder, host: HOST, uploadKbps: 100, keepDays: 7, budgetBytes: 1024 * KIB, discovery: false, now: () => new Date(clock), log: (l) => lines.push(l), every: () => () => undefined });
  const torrents: ShelfTorrents = {
    diskUsage: () => streams.diskUsage(),
    inUse: (h) => h === o.busyHash || streams.inUse(h),
    removeSlots: async (h, s) => {
      if (h === o.busyHash) throw new TorrentError('in_use', 'held');
      return streams.removeSlots(h, s);
    },
  };
  const removedCaches: string[] = [];
  const cloud = new Map<string, number>([['c0ffee00-0000-4000-8000-000000000001', 40 * KIB]]);
  const caches: ShelfCaches = {
    diskUsage: async () => [...cloud].map(([id, bytes]) => ({ row: cloudRow(id, 88), bytes })),
    busy: (id) => id === o.busyCache,
    remove: async (id) => {
      removedCaches.push(id);
      cloud.delete(id);
    },
  };
  const timers: (() => void)[] = [];
  const shelf = new CacheShelf({
    host: HOST,
    torrents,
    caches,
    titles: async (ids) =>
      new Map<string, { item: TitleListItem; seasons: SeasonView[] }>(
        ids.flatMap((id): [string, { item: TitleListItem; seasons: SeasonView[] }][] =>
          id === 'tv-500'
            ? [[id, { item: item(id, 'tv', 'The Show'), seasons: seasons(o.finished ?? []) }]]
            : id === 'movie-77'
              ? [[id, { item: item(id, 'movie', 'Film', { watched: o.filmWatched, not_interested: o.filmNotInterested }), seasons: [] }]]
              : [],
        ),
      ),
    live: () => o.live ?? [],
    pendingFile,
    undoMs: 10_000,
    now: () => new Date(clock),
    log: (l) => lines.push(l),
    later: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const fire = async (): Promise<void> => {
    clock += 10_000;
    for (const fn of timers.splice(0)) fn();
    // execute() is chained: wait for it to settle.
    await new Promise((r) => setTimeout(r, 30));
  };
  return { shelf, streams, records, folder, fire, removedCaches, lines };
}

beforeEach(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'cache-shelf-'));
  root = path.join(base, 'torrents');
  cacheRoot = path.join(base, 'stream-cache');
  pendingFile = path.join(base, 'cache-deletions.json');
  await mkdir(root, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe('the Cache page reading', () => {
  it('lists every title largest first, splits a season pack between its episodes and the season, and totals torrents and cloud', async () => {
    const b = build({ finished: [1] });
    await seed(b.records, b.folder);
    const view = await b.shelf.view();
    const dir = b.folder.dirOf(PACK);
    const e1 = (await onDisk(b.folder.diskPath(PACK, `${SHOW}/Show.S01E01.mkv`)!)) + (await onDisk(path.join(dir, 'notesd-remux/0/seg-00000.m4s'))) + (await onDisk(path.join(dir, 'notesd-cues/whisper-0.jsonl')));
    const e2 = await onDisk(b.folder.diskPath(PACK, `${SHOW}/Show.S01E02.mkv`)!);
    const shared = (await onDisk(b.folder.diskPath(PACK, `${SHOW}/Show.S01.en.srt`)!)) + (await onDisk(path.join(dir, '.notesd-subs/file-3.vtt'))) + (await onDisk(b.folder.diskPath(PACK, `${SHOW}/sample.mkv`)!));
    const film = await onDisk(b.folder.diskPath(FILM, 'Film/Film.mp4')!);

    const show = view.titles.find((t) => t.title_id === 'tv-500')!;
    expect(show.kinds).toEqual(['torrent']);
    expect(show.bytes).toBe(e1 + e2 + shared);
    expect(show.seasons).toHaveLength(1);
    const season = show.seasons[0]!;
    expect(season.shared_bytes).toBe(shared);
    expect(season.episodes.map((e) => [e.episode, e.bytes, e.watched])).toEqual([
      [1, e1, true],
      [2, e2, false],
    ]);
    expect(season.watched).toBe(false);
    const filmTitle = view.titles.find((t) => t.title_id === 'movie-77')!;
    expect(filmTitle.bytes).toBe(film);
    const cloud = view.titles.find((t) => t.title_id === 'movie-88')!;
    expect(cloud).toMatchObject({ kinds: ['cloud'], stored: false, title: 'TMDB movie 88', cloud_bytes: 40 * KIB });
    // Largest first.
    const sizes = view.titles.map((t) => t.bytes);
    expect([...sizes].sort((x, y) => y - x)).toEqual(sizes);
    expect(view.torrent_bytes).toBe(e1 + e2 + shared + film);
    expect(view.cloud_bytes).toBe(40 * KIB);
    expect(view.total_bytes).toBe(view.torrent_bytes + view.cloud_bytes);
    expect(view.budget_bytes).toBe(1024 * KIB);
    // Delete Watched frees E01 only (the series is not marked watched, E02 is not watched).
    expect(view.bulk.watched).toEqual({ bytes: e1, titles: 1 });
    expect(view.bulk.not_interested).toEqual({ bytes: 0, titles: 0 });
  });

  it('tags what plays: the episode on screen is playing, and its whole pack is in use', async () => {
    const b = build({ live: [{ titleId: 'tv-500', season: 1, episode: 2 }], busyHash: PACK });
    await seed(b.records, b.folder);
    const show = (await b.shelf.view()).titles.find((t) => t.title_id === 'tv-500')!;
    const [e1, e2] = [...show.seasons[0]!.episodes].sort((x, y) => x.episode - y.episode);
    expect(e2).toMatchObject({ playing: true, in_use: true });
    expect(e1).toMatchObject({ playing: false, in_use: true });
    expect(show).toMatchObject({ playing: true, in_use: true });
    await expect(b.shelf.remove({ title_id: 'tv-500', season: 1, episode: 1 })).rejects.toMatchObject({ code: 'in_use' });
    await expect(b.shelf.remove({ title_id: 'movie-77' })).resolves.toMatchObject({ label: 'Film' });
  });

  it('refuses a cloud cache that downloads now', async () => {
    const b = build({ busyCache: 'c0ffee00-0000-4000-8000-000000000001' });
    await expect(b.shelf.remove({ title_id: 'movie-88' })).rejects.toBeInstanceOf(ShelfError);
  });
});

describe('deleting with an undo window', () => {
  it('hides an episode at once, brings it back on undo, and deletes only its own files when the window closes', async () => {
    const b = build();
    await seed(b.records, b.folder);
    const e1File = b.folder.diskPath(PACK, `${SHOW}/Show.S01E01.mkv`)!;
    const deletion = await b.shelf.remove({ title_id: 'tv-500', season: 1, episode: 1 });
    expect(deletion.label).toBe('The Show S01E01');
    let show = (await b.shelf.view()).titles.find((t) => t.title_id === 'tv-500')!;
    expect(show.seasons[0]!.episodes.map((e) => e.episode)).toEqual([2]);
    expect((await b.shelf.view()).pending.map((p) => p.id)).toEqual([deletion.id]);
    expect(await exists(e1File)).toBe(true);

    await b.shelf.undo(deletion.id);
    show = (await b.shelf.view()).titles.find((t) => t.title_id === 'tv-500')!;
    expect(show.seasons[0]!.episodes.map((e) => e.episode).sort()).toEqual([1, 2]);
    await b.fire();
    expect(await exists(e1File)).toBe(true);
    await expect(b.shelf.undo(deletion.id)).rejects.toMatchObject({ code: 'unknown_deletion' });

    await b.shelf.remove({ title_id: 'tv-500', season: 1, episode: 1 });
    await b.fire();
    const dir = b.folder.dirOf(PACK);
    expect(await exists(e1File)).toBe(false);
    expect(await exists(path.join(dir, 'notesd-remux'))).toBe(false);
    expect(await exists(path.join(dir, 'notesd-cues/whisper-0.jsonl'))).toBe(false);
    // E02's video and the pack's shared subtitle stay; only E01's row went.
    expect(await exists(b.folder.diskPath(PACK, `${SHOW}/Show.S01E02.mkv`)!)).toBe(true);
    expect(await exists(b.folder.diskPath(PACK, `${SHOW}/Show.S01.en.srt`)!)).toBe(true);
    expect(b.records.rows.filter((r) => r.infoHash === PACK).map((r) => r.episode)).toEqual([2]);
    expect((await b.shelf.view()).pending).toEqual([]);

    // The last episode of the pack takes the whole folder.
    await b.shelf.remove({ title_id: 'tv-500', season: 1 });
    await b.fire();
    expect(await exists(dir)).toBe(false);
    expect(b.records.rows.some((r) => r.infoHash === PACK)).toBe(false);
  });

  it('carries out at start what a restart left pending', async () => {
    const b = build();
    await seed(b.records, b.folder);
    await b.shelf.remove({ title_id: 'movie-77' });
    expect(JSON.parse(await readFile(pendingFile, 'utf8'))).toHaveLength(1);
    b.shelf.close();
    // A new daemon, same records and folders, before the window closed.
    const again = build({ records: b.records });
    expect(await again.shelf.start()).toBe(1);
    expect(await exists(b.folder.dirOf(FILM))).toBe(false);
    expect(b.records.rows.some((r) => r.infoHash === FILM)).toBe(false);
    expect(JSON.parse(await readFile(pendingFile, 'utf8'))).toEqual([]);
  });

  it('deletes every watched title and every watched episode in one batch, and undoes it as one', async () => {
    const b = build({ finished: [1], filmWatched: true });
    await seed(b.records, b.folder);
    const view = await b.shelf.view();
    const deletion = await b.shelf.remove({ bulk: 'watched' });
    expect(deletion.bytes).toBe(view.bulk.watched.bytes);
    expect(deletion.label).toBe('Watched (2 titles)');
    expect((await b.shelf.view()).titles.map((t) => t.title_id).sort()).toEqual(['movie-88', 'tv-500']);
    await b.shelf.undo(deletion.id);
    expect((await b.shelf.view()).titles).toHaveLength(3);
    await b.shelf.remove({ bulk: 'watched' });
    await b.fire();
    expect(await exists(b.folder.dirOf(FILM))).toBe(false);
    expect(b.records.rows.filter((r) => r.infoHash === PACK).map((r) => r.episode)).toEqual([2]);
  });

  it('deletes the titles marked not interested whole, the cloud cache through the stream cache', async () => {
    const b = build({ filmNotInterested: true });
    await seed(b.records, b.folder);
    await expect(b.shelf.remove({ bulk: 'not_interested' })).resolves.toMatchObject({ label: 'Not interested (1 title)' });
    await b.fire();
    expect(await exists(b.folder.dirOf(FILM))).toBe(false);
    await b.shelf.remove({ title_id: 'movie-88' });
    await b.fire();
    expect(b.removedCaches).toEqual(['c0ffee00-0000-4000-8000-000000000001']);
  });

  it('keeps a torrent that started playing inside the window', async () => {
    const o: { busyHash?: string } = {};
    const b = build(o);
    await seed(b.records, b.folder);
    await b.shelf.remove({ title_id: 'movie-77' });
    // A play took the torrent meanwhile.
    o.busyHash = FILM;
    await b.fire();
    expect(await exists(b.folder.dirOf(FILM))).toBe(true);
    expect(b.lines.some((l) => l.includes('kept the torrent'))).toBe(true);
  });
});
