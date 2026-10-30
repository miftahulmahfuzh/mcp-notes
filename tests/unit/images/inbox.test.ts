import { statSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isIgnoredInboxName, startInboxWatcher, type InboxWatcher } from '../../../src/images/inbox.js';
import { ingestImage, type ImageDeps } from '../../../src/images/ingest.js';
import { ensureDataDirs, fileExists, type DataDirs } from '../../../src/images/store.js';
import { FakeNotes } from '../../helpers/fakeNotes.js';
import { JPEG_EXIF, PNG_PLAIN, tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
let dirs: DataDirs;
let notes: FakeNotes;
let deps: ImageDeps;
let watcher: InboxWatcher | null;
let logs: string[];

const FAST = { stabilityThresholdMs: 150, pollIntervalMs: 30 };

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  dirs = await ensureDataDirs(dir);
  notes = new FakeNotes();
  deps = { dataDir: dir, notes, records: notes, hostname: () => 'lenovo' };
  watcher = null;
  logs = [];
});
afterEach(async () => {
  await watcher?.close();
  await cleanup();
});

function start(ingest = (p: string) => ingestImage(deps, { path: p, move: true, origin: { source: 'inbox' } })) {
  return startInboxWatcher({
    inboxDir: dirs.inbox,
    failedDir: dirs.failed,
    ingest,
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...FAST,
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

describe('isIgnoredInboxName', () => {
  it('skips dotfiles and partial downloads', () => {
    for (const n of ['.DS_Store', '.x.jpg', 'a.jpg.crdownload', 'b.PART', 'c.tmp', 'd.jpg.download', '~$e.png']) {
      expect(isIgnoredInboxName(n)).toBe(true);
    }
    for (const n of ['IMG_1.HEIC', 'shot.png', 'a.partial.jpg']) expect(isIgnoredInboxName(n)).toBe(false);
  });
});

describe('startInboxWatcher', () => {
  it('ingests files already present at startup', async () => {
    await copyFile(JPEG_EXIF, path.join(dirs.inbox, 'early.jpg'));
    watcher = await start();
    await until(() => notes.rows.size === 1);
    await watcher.idle();
    expect(await fileExists(path.join(dirs.inbox, 'early.jpg'))).toBe(false);
    const [row] = [...notes.rows.values()];
    expect(row!.origin).toEqual({ source: 'inbox' });
    expect(row!.image_meta!.original_name).toBe('early.jpg');
  });

  it('ingests a dropped image and moves it into the store', async () => {
    watcher = await start();
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'drop.png'));
    await until(() => notes.rows.size === 1);
    await watcher.idle();
    expect(await readdir(dirs.inbox)).toEqual(['failed']);
    const [row] = [...notes.rows.values()];
    expect(await fileExists(path.join(dir, row!.image_path!))).toBe(true);
  });

  it('waits for a growing file to settle', async () => {
    const seen: number[] = [];
    watcher = await start(async (p) => {
      seen.push(statSync(p).size);
      return ingestImage(deps, { path: p, move: true });
    });
    const target = path.join(dirs.inbox, 'slow.png');
    const full = await readFile(PNG_PLAIN);
    await writeFile(target, full.subarray(0, 20));
    for (let i = 20; i < full.length; i += 20) {
      await sleep(40);
      await appendFile(target, full.subarray(i, i + 20));
    }
    await until(() => notes.rows.size === 1);
    expect(seen).toEqual([full.length]);
  });

  it('ignores non-images, dotfiles, partial downloads and the failed/ folder', async () => {
    watcher = await start();
    await writeFile(path.join(dirs.inbox, 'notes.txt'), 'plain text');
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, '.hidden.png'));
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'big.png.crdownload'));
    await copyFile(PNG_PLAIN, path.join(dirs.failed, 'old.png'));
    await mkdir(path.join(dirs.inbox, 'sub'));
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'sub', 'nested.png'));
    await sleep(600);
    await watcher.idle();
    expect(notes.rows.size).toBe(0);
    expect((await readdir(dirs.inbox)).sort()).toEqual(
      ['.hidden.png', 'big.png.crdownload', 'failed', 'notes.txt', 'sub'].sort(),
    );
    expect(logs.some((l) => l.includes('ignored notes.txt'))).toBe(true);
  });

  it('moves a file whose ingest fails to inbox/failed/ and logs it', async () => {
    watcher = await start(async () => {
      throw new Error('database unreachable');
    });
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'boom.png'));
    await until(() => fileExists(path.join(dirs.failed, 'boom.png')));
    await watcher.idle();
    expect(await fileExists(path.join(dirs.inbox, 'boom.png'))).toBe(false);
    expect(logs.some((l) => l.includes('failed boom.png: database unreachable -> inbox/failed/boom.png'))).toBe(true);
  });

  it('a duplicate dropped later is consumed without a second note', async () => {
    watcher = await start();
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'one.png'));
    await until(() => notes.rows.size === 1);
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'two.png'));
    await until(async () => !(await fileExists(path.join(dirs.inbox, 'two.png'))));
    await watcher.idle();
    expect(notes.rows.size).toBe(1);
    expect(logs.some((l) => l.includes('(already stored)'))).toBe(true);
  });
});
