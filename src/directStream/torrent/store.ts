import { createReadStream } from 'node:fs';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { TorrentFileInfo, TorrentHandle, TorrentStats } from './types.js';

/** fs-chunk-store 5 (webtorrent's disk store) drops these characters from a file's last name; disk paths must match. */
const RESERVED_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * `<root>/<info hash>/`: where one torrent's files are written, at the paths webtorrent's store uses.
 * Other phases may keep their own files under a torrent's folder (subtitles, a remux); this class only
 * ever deletes the torrent's own files by path, or the whole folder when the download is cleared.
 */
export class TorrentFolder {
  constructor(readonly root: string) {}

  /** The info hash is checked (40 hex) before it gets here, so the folder never leaves the root. */
  dirOf(infoHash: string): string {
    return path.join(this.root, infoHash);
  }

  /**
   * Where webtorrent writes a torrent file: `resolve(join(dir, dirname(path)))` plus the last name without
   * reserved characters, exactly as fs-chunk-store does. Null when that would not be inside the folder.
   */
  diskPath(infoHash: string, filePath: string): string | null {
    const dir = this.dirOf(infoHash);
    const target = path.join(path.resolve(path.join(dir, path.dirname(filePath))), path.basename(filePath).replace(RESERVED_NAME_CHARS, ''));
    return target.startsWith(`${dir}${path.sep}`) ? target : null;
  }

  contains(infoHash: string, filePath: string): boolean {
    return this.diskPath(infoHash, filePath) !== null;
  }

  /** The file's absolute path when it is on disk at its full size, else null. */
  async complete(infoHash: string, filePath: string, length: number): Promise<string | null> {
    const target = this.diskPath(infoHash, filePath);
    if (target === null) return null;
    try {
      const s = await stat(target);
      return s.isFile() && s.size === length ? target : null;
    } catch {
      return null;
    }
  }

  /**
   * Deletes these files of the torrent (those not chosen: the edge bytes of pieces they share with a chosen
   * file), then the folders they leave empty. Anything else under the folder is left. Returns how many went.
   */
  async dropFiles(infoHash: string, filePaths: readonly string[]): Promise<number> {
    const dir = this.dirOf(infoHash);
    let removed = 0;
    for (const filePath of filePaths) {
      const target = this.diskPath(infoHash, filePath);
      if (target === null) continue;
      try {
        await rm(target);
      } catch {
        continue; // never written
      }
      removed += 1;
      let parent = path.dirname(target);
      while (parent.startsWith(`${dir}${path.sep}`)) {
        try {
          await rmdir(parent);
        } catch {
          break; // not empty
        }
        parent = path.dirname(parent);
      }
    }
    return removed;
  }

  /**
   * The info hashes that have a folder under the root. Anything else there (trackers.json, tracker-lists.json, a
   * folder not named as an info hash) is never listed, so never deleted by a sweep.
   */
  async hashes(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && /^[0-9a-f]{40}$/.test(e.name)).map((e) => e.name);
  }

  /**
   * The bytes the torrent's folder takes on disk, everything in it: the downloaded files, a remux's segments,
   * subtitle cue files. Counted by allocated blocks, so a sparse file of an unfinished download counts what it
   * holds, not its length. 0 when there is no folder.
   */
  async size(infoHash: string): Promise<number> {
    const walk = async (dir: string): Promise<number> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      let total = 0;
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) total += await walk(full);
        else if (e.isFile()) {
          try {
            const s = await stat(full);
            total += s.blocks > 0 ? s.blocks * 512 : s.size;
          } catch {
            // gone meanwhile
          }
        }
      }
      return total;
    };
    return walk(this.dirOf(infoHash));
  }

  /**
   * Every file under the torrent's folder with the bytes it takes on disk (allocated blocks, as `size` counts them), by its
   * path relative to the folder, with `/` between names. Empty when there is no folder.
   */
  async usage(infoHash: string): Promise<{ rel: string; bytes: number }[]> {
    const out: { rel: string; bytes: number }[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.isDirectory()) await walk(full, rel);
        else if (e.isFile()) {
          try {
            const s = await stat(full);
            out.push({ rel, bytes: s.blocks > 0 ? s.blocks * 512 : s.size });
          } catch {
            // gone meanwhile
          }
        }
      }
    };
    await walk(this.dirOf(infoHash), '');
    return out;
  }

  /**
   * Deletes these entries (files or folders) of the torrent's folder, named by their path relative to it (as `usage`
   * lists them), then the folders they leave empty. A path that would leave the folder is skipped. Returns how many went.
   */
  async removeInside(infoHash: string, rels: readonly string[]): Promise<number> {
    const dir = this.dirOf(infoHash);
    let removed = 0;
    for (const rel of rels) {
      const target = path.resolve(dir, ...rel.split('/'));
      if (!target.startsWith(`${dir}${path.sep}`)) continue;
      try {
        await stat(target);
      } catch {
        continue;
      }
      await rm(target, { recursive: true, force: true });
      removed += 1;
      let parent = path.dirname(target);
      while (parent.startsWith(`${dir}${path.sep}`)) {
        try {
          await rmdir(parent);
        } catch {
          break; // not empty
        }
        parent = path.dirname(parent);
      }
    }
    return removed;
  }

  /** Whether the torrent has a folder here. */
  async exists(infoHash: string): Promise<boolean> {
    try {
      return (await stat(this.dirOf(infoHash))).isDirectory();
    } catch {
      return false;
    }
  }

  /** Deletes the torrent's folder and everything in it. */
  async remove(infoHash: string): Promise<void> {
    await rm(this.dirOf(infoHash), { recursive: true, force: true });
  }
}

/** A finished download read from disk: no swarm, no engine. Its files are the chosen ones only. */
export class DiskHandle implements TorrentHandle {
  readonly live = false;

  constructor(
    readonly infoHash: string,
    readonly name: string,
    readonly files: readonly TorrentFileInfo[],
    private readonly paths: ReadonlyMap<number, string>,
  ) {}

  select(): void {}

  read(index: number, range: { start: number; end: number }): Readable {
    const file = this.paths.get(index);
    if (file === undefined) throw new RangeError(`file ${index} of ${this.infoHash} is not on disk`);
    return createReadStream(file, { start: range.start, end: range.end });
  }

  stats(): TorrentStats {
    return { peers: 0, down_kbps: 0, up_kbps: 0 };
  }

  ranges(index: number): [number, number][] {
    const file = this.files.find((f) => f.index === index);
    return file !== undefined && file.length > 0 ? [[0, file.length]] : [];
  }

  done(index: number): boolean {
    return this.paths.has(index);
  }
}
