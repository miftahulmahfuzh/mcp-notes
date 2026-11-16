import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';

const H = 'ab'.repeat(20);
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'torrent-folder-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function listing(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(`${path.relative(base, full)}/`, ...(await listing(full, base)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

describe('TorrentFolder', () => {
  it('names the path webtorrent writes a file to: the last name without reserved characters', () => {
    const f = new TorrentFolder('/data/torrents');
    expect(f.diskPath(H, 'Dune: Part Two (2024)/Dune: Part Two.mkv')).toBe(`/data/torrents/${H}/Dune: Part Two (2024)/Dune Part Two.mkv`);
    expect(f.diskPath(H, 'Film/Film.en.srt')).toBe(`/data/torrents/${H}/Film/Film.en.srt`);
    // fs-chunk-store joins, so a leading slash stays inside the folder.
    expect(f.diskPath(H, '/etc/passwd')).toBe(`/data/torrents/${H}/etc/passwd`);
  });

  it('refuses a path that would leave the torrent folder', () => {
    const f = new TorrentFolder('/data/torrents');
    expect(f.diskPath(H, '../../etc/passwd')).toBeNull();
    expect(f.diskPath(H, 'Film/../../x.mp4')).toBeNull();
    expect(f.diskPath(H, '..')).toBeNull();
    expect(f.contains(H, 'Film/Film.mp4')).toBe(true);
    expect(f.contains(H, '../Film.mp4')).toBe(false);
  });

  it('finds a file only when it is whole', async () => {
    const f = new TorrentFolder(tmp);
    const file = f.diskPath(H, 'Film/Film.mp4')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(10));
    expect(await f.complete(H, 'Film/Film.mp4', 10)).toBe(file);
    expect(await f.complete(H, 'Film/Film.mp4', 11)).toBeNull();
    expect(await f.complete(H, 'Film/Missing.mp4', 10)).toBeNull();
  });

  it('drops the named files and the folders they leave empty, and nothing else', async () => {
    const f = new TorrentFolder(tmp);
    for (const p of ['Film/Film.mp4', 'Film/Sample/sample.mp4', 'Film/README.txt']) {
      const file = f.diskPath(H, p)!;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'x');
    }
    await mkdir(path.join(f.dirOf(H), '.notesd-subs'), { recursive: true });
    await writeFile(path.join(f.dirOf(H), '.notesd-subs', 'en.vtt'), 'WEBVTT');
    expect(await f.dropFiles(H, ['Film/Sample/sample.mp4', 'Film/README.txt', 'Film/setup.exe', '../outside.txt'])).toBe(2);
    expect(await listing(f.dirOf(H))).toEqual(['.notesd-subs/', '.notesd-subs/en.vtt', 'Film/', 'Film/Film.mp4']);
    await f.remove(H);
    await expect(stat(f.dirOf(H))).rejects.toThrow();
  });
});
