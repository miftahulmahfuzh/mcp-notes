import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The names the file route serves. cache.json, plain-file chunks and *.part writes are never served. */
export const SERVED_NAME =
  /^(?:master|video|audio)\.m3u8$|^[va]-init-\d+\.mp4$|^[va]-key-\d+\.key$|^[va]-\d{5,}\.(?:ts|m4s|aac)$|^subtitle\.vtt$|^video\.mp4$/;

export const META_FILE = 'cache.json';

/** What a cache folder says about the source its files came from. No address: they carry tokens. */
export interface CacheMeta {
  version: 1;
  signature: string;
  provider: string;
  kind: 'hls' | 'mp4';
}

/** `<root>/<cache id>/`. Every write goes to a temporary name and is renamed, so a file is whole or absent. */
export class CacheStore {
  constructor(readonly root: string) {}

  dir(id: string): string {
    return path.join(this.root, id);
  }

  file(id: string, name: string): string {
    return path.join(this.root, id, name);
  }

  /** Makes the folder and drops writes a stopped run left half done. */
  async prepare(id: string): Promise<void> {
    await mkdir(this.dir(id), { recursive: true });
    for (const name of await readdir(this.dir(id))) if (name.endsWith('.part')) await rm(this.file(id, name), { force: true });
  }

  async write(id: string, name: string, data: Buffer | string): Promise<void> {
    const final = this.file(id, name);
    const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
    await writeFile(tmp, data);
    await rename(tmp, final);
  }

  async has(id: string, name: string): Promise<boolean> {
    try {
      return (await stat(this.file(id, name))).isFile();
    } catch {
      return false;
    }
  }

  async size(id: string, name: string): Promise<number> {
    try {
      return (await stat(this.file(id, name))).size;
    } catch {
      return 0;
    }
  }

  /** The whole files in the folder; empty when there is no folder. */
  async names(id: string): Promise<Set<string>> {
    try {
      return new Set((await readdir(this.dir(id))).filter((name) => !name.endsWith('.part')));
    } catch {
      return new Set();
    }
  }

  async readMeta(id: string): Promise<CacheMeta | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(id, META_FILE), 'utf8')) as Partial<CacheMeta>;
      return raw.version === 1 && typeof raw.signature === 'string' && typeof raw.provider === 'string' && (raw.kind === 'hls' || raw.kind === 'mp4')
        ? { version: 1, signature: raw.signature, provider: raw.provider, kind: raw.kind }
        : null;
    } catch {
      return null;
    }
  }

  async writeMeta(id: string, meta: CacheMeta): Promise<void> {
    await this.write(id, META_FILE, `${JSON.stringify(meta)}\n`);
  }

  /** Empties the folder: the source changed, so what is on disk no longer matches it. */
  async clear(id: string): Promise<void> {
    for (const name of await readdir(this.dir(id))) await rm(this.file(id, name), { recursive: true, force: true });
  }

  /** The names of the folders under the root; empty when there is no root yet. Files beside the folders are not listed. */
  async folders(): Promise<string[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** When anything in a folder was last written: the newest of the folder's own time and its files'. Null when it is gone. */
  async writtenAt(id: string): Promise<Date | null> {
    try {
      let newest = (await stat(this.dir(id))).mtimeMs;
      for (const name of await readdir(this.dir(id))) newest = Math.max(newest, (await stat(this.file(id, name))).mtimeMs);
      return new Date(newest);
    } catch {
      return null;
    }
  }

  /** The bytes the cache's folder takes on disk (allocated blocks, as the torrent budget counts); 0 when there is no folder. */
  async diskSize(id: string): Promise<number> {
    let total = 0;
    let names: string[];
    try {
      names = await readdir(this.dir(id));
    } catch {
      return 0;
    }
    for (const name of names) {
      try {
        const s = await stat(this.file(id, name));
        if (s.isFile()) total += s.blocks > 0 ? s.blocks * 512 : s.size;
      } catch {
        // gone meanwhile
      }
    }
    return total;
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  /** Joins chunk files in order into `name` (temporary name, then rename), then deletes the chunks. */
  async join(id: string, parts: readonly string[], name: string): Promise<void> {
    const final = this.file(id, name);
    const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
    const out = await open(tmp, 'w');
    try {
      for (const part of parts) await out.appendFile(await readFile(this.file(id, part)));
    } finally {
      await out.close();
    }
    await rename(tmp, final);
    for (const part of parts) await rm(this.file(id, part), { force: true });
  }
}
