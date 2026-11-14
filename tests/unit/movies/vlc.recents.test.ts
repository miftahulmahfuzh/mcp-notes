import { describe, expect, it, vi } from 'vitest';
import { fileRow, playRow, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';
import type { NewMovieFile } from '../../../src/movies/types.js';
import {
  fileUrlToWslPath,
  parseRecents,
  recentsRelPath,
  recentsSyncHook,
  shouldRecord,
  splitQtList,
  type RecentsFs,
  type RecentsRepo,
  type TitleResolver,
} from '../../../src/movies/vlc/recents.js';

/** The real file's shape (synthetic names), including -1 and 0 times and a non-file MRL. */
const INI = [
  '[General]',
  'filedialog-path=@Variant(\\0\\0\\0\\x11\\0\\0\\0\\x10)',
  '',
  '[RecentsMRL]',
  'list=file:///C:/Users/u/Videos/Pak%20Bernard/Absolutely%20Anything%20(2015)/Absolutely%20Anything.mkv, file:///C:/Users/u/Downloads/Telegram%20Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv, "file:///C:/Users/u/Videos/a,b.mkv", https://example.com/live, file:///C:/Users/u/Videos/Opened.Only.2024.mkv',
  'times=1307375, 6684192, 0, -1',
  '',
  '[MainWindow]',
  'geometry=@ByteArray(x)',
].join('\r\n');

describe('parseRecents', () => {
  it('zips list= and times=, decodes paths and maps 0 / -1 / missing to unknown', () => {
    expect(parseRecents(INI)).toEqual([
      { url: 'file:///C:/Users/u/Videos/Pak%20Bernard/Absolutely%20Anything%20(2015)/Absolutely%20Anything.mkv', path: '/mnt/c/Users/u/Videos/Pak Bernard/Absolutely Anything (2015)/Absolutely Anything.mkv', positionS: 1307.375 },
      { url: 'file:///C:/Users/u/Downloads/Telegram%20Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', path: '/mnt/c/Users/u/Downloads/Telegram Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', positionS: 6684.192 },
      { url: 'file:///C:/Users/u/Videos/a,b.mkv', path: '/mnt/c/Users/u/Videos/a,b.mkv', positionS: null },
      { url: 'https://example.com/live', path: null, positionS: null },
      { url: 'file:///C:/Users/u/Videos/Opened.Only.2024.mkv', path: '/mnt/c/Users/u/Videos/Opened.Only.2024.mkv', positionS: null },
    ]);
  });

  it('reads nothing from a file without the section or with @Invalid()', () => {
    expect(parseRecents('[General]\nx=1')).toEqual([]);
    expect(parseRecents('[RecentsMRL]\nlist=@Invalid()\ntimes=@Invalid()')).toEqual([]);
  });
});

describe('helpers', () => {
  it('splitQtList keeps positions and unquotes', () => {
    expect(splitQtList('a, "b, c", d')).toEqual(['a', 'b, c', 'd']);
  });
  it('fileUrlToWslPath rejects non-drive URLs and lowercases the drive', () => {
    expect(fileUrlToWslPath('file:///D:/x%20y.mkv')).toBe('/mnt/d/x y.mkv');
    expect(fileUrlToWslPath('file://server/share/x.mkv')).toBeNull();
    expect(fileUrlToWslPath('file:///C:/bad%E0%A4%A.mkv')).toBeNull();
  });
  it('recentsRelPath is relative to a root, else parent/name', () => {
    expect(recentsRelPath('/mnt/c/V/Pak Bernard/A (2015)/A.mkv', ['/mnt/c/V'])).toBe('Pak Bernard/A (2015)/A.mkv');
    expect(recentsRelPath('/mnt/e/usb/A (2015)/A.mkv', ['/mnt/c/V'])).toBe('A (2015)/A.mkv');
  });
  it('shouldRecord skips a position within 10 s of the last play and an unknown one after any play', () => {
    expect(shouldRecord(null, null)).toBe(true);
    expect(shouldRecord({ positionS: 1300 }, 1307)).toBe(false);
    expect(shouldRecord({ positionS: 1200 }, 1307)).toBe(true);
    expect(shouldRecord({ positionS: 1200 }, null)).toBe(false);
    expect(shouldRecord({ positionS: null }, 50)).toBe(true);
  });
});

class MemRecentsRepo {
  files: FileRow[] = [];
  plays: PlayRow[] = [];
  titles = new Map<string, { id: string; runtimeMin: number | null }>();
  upserted: unknown[] = [];

  async findTrackedFile(host: string, p: string, name: string): Promise<FileRow | null> {
    return this.files.find((f) => f.host === host && f.path === p) ?? this.files.find((f) => f.host === host && f.name === name) ?? null;
  }
  async lastPlay(fileId: number): Promise<PlayRow | null> {
    return [...this.plays].filter((p) => p.fileId === fileId).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;
  }
  async recordObservation(i: { fileId: number; host: string; positionS: number | null; durationS: number | null; observedAt: Date }): Promise<PlayRow> {
    const row = playRow({ id: this.plays.length + 1, fileId: i.fileId, host: i.host, source: 'vlc_recents', startedAt: i.observedAt, endedAt: i.observedAt, positionS: i.positionS, durationS: i.durationS });
    this.plays.push(row);
    return row;
  }
  async titleById(id: string) {
    return (this.titles.get(id) ?? null) as never;
  }
  async upsertTitle(meta: unknown) {
    this.upserted.push(meta);
    this.titles.set('movie-1001', { id: 'movie-1001', runtimeMin: 120 });
  }
  async upsertFile(i: NewMovieFile): Promise<{ file: FileRow; created: boolean }> {
    const titleId = i.classification.status === 'matched' ? i.classification.titleId : null;
    const row = fileRow({ id: 100 + this.files.length, host: i.host, path: i.path, name: i.name, titleId, deletedAt: i.deletedAt ?? null, source: i.source, durationS: null });
    this.files.push(row);
    return { file: row, created: true };
  }
}

const MTIME = new Date('2026-11-14T04:20:00Z');
function memFs(text: string): RecentsFs {
  return { readFile: async () => text, mtime: async () => MTIME, exists: async () => false };
}

describe('recentsSyncHook', () => {
  it('observes a tracked file, backfills a gone one under a freshly fetched title, and is idempotent', async () => {
    const repo = new MemRecentsRepo();
    repo.files.push(fileRow({ id: 1, path: '/mnt/c/Users/u/Videos/Pak Bernard/Absolutely Anything (2015)/Absolutely Anything.mkv', name: 'Absolutely Anything.mkv', durationS: 5100 }));
    const resolver: TitleResolver = {
      match: vi.fn(async () => ({ kind: 'matched', tmdbKind: 'movie', tmdbId: 1001, confidence: 0.95 }) as never),
      details: vi.fn(async () => ({ opaque: 'metadata' }) as never),
    };
    const hook = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver, fs: memFs(INI), log: () => {} });

    const first = await hook.run();
    expect(first).toMatchObject({ observed: 4, created: 3 });
    expect(repo.plays.find((p) => p.fileId === 1)).toMatchObject({ positionS: 1307.375, durationS: 5100, startedAt: MTIME });
    const dog = repo.files.find((f) => f.name.startsWith('The.Dog.Stars'))!;
    expect(dog).toMatchObject({ titleId: 'movie-1001', source: 'vlc_recents' });
    expect(dog.deletedAt).not.toBeNull();
    expect(repo.plays.find((p) => p.fileId === dog.id)).toMatchObject({ positionS: 6684.192, durationS: 7200, startedAt: new Date(MTIME.getTime() - 1000) });
    expect(repo.upserted).toEqual([{ opaque: 'metadata' }]);

    const before = repo.plays.length;
    expect((await hook.run()).observed).toBe(0);
    const fresh = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver, fs: memFs(INI), log: () => {} });
    expect((await fresh.run()).observed).toBe(0);
    expect(repo.plays.length).toBe(before);
  });

  it('retries gone files next pass when the resolver fails or there are no credentials', async () => {
    const repo = new MemRecentsRepo();
    const failing: TitleResolver = { match: async () => { throw new Error('TMDB unreachable'); }, details: async () => ({}) as never };
    const hook = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver: failing, fs: memFs(INI), log: () => {} });
    expect(await hook.run()).toMatchObject({ observed: 0, created: 0, retry: 4 });
    const none = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver: null, fs: memFs(INI), log: () => {} });
    expect(await none.run()).toMatchObject({ observed: 0, retry: 4 });
    expect(repo.files).toEqual([]);
  });

  it('a missing ini is a quiet no-op, and afterScan never throws into the sync pass', async () => {
    const repo = new MemRecentsRepo();
    const fs: RecentsFs = { readFile: async () => { throw new Error('ENOENT'); }, mtime: async () => MTIME, exists: async () => false };
    const hook = recentsSyncHook({ iniPath: '/none.ini', roots: [], host: 'h', repo: repo as unknown as RecentsRepo, resolver: null, fs });
    expect(await hook.run()).toEqual({ observed: 0, created: 0, skipped: 0, unmatched: 0, retry: 0 });
    const broken = { ...repo, findTrackedFile: async () => { throw new Error('db down'); } } as unknown as RecentsRepo;
    const lines: string[] = [];
    const bad = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'h', repo: broken, resolver: null, fs: memFs(INI), log: (l) => lines.push(l) });
    await expect(bad.afterScan!({} as never)).resolves.toBe(0);
    expect(lines.join('\n')).toContain('recents pass failed: db down');
  });
});
