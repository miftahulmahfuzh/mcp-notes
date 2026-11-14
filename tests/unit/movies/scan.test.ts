import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProbeError, probeDuration, walkRoots, type ScanEntryKind, type ScanFs } from '../../../src/movies/scan.js';

type Node = { kind: 'dir' } | { kind: 'file'; size: number } | { kind: 'other' };

function memFs(nodes: Record<string, Node>, broken: readonly string[] = []): ScanFs {
  return {
    async list(dir) {
      if (broken.includes(dir) || nodes[dir]?.kind !== 'dir') throw new Error(`EACCES: ${dir}`);
      const prefix = `${dir}/`;
      return Object.entries(nodes)
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, n]) => ({ name: p.slice(prefix.length), kind: n.kind as ScanEntryKind }));
    },
    async stat(file) {
      const n = nodes[file];
      if (n?.kind !== 'file') throw new Error(`ENOENT: ${file}`);
      return { size: n.size, mtimeMs: 1_700_000_000_000 };
    },
  };
}

const TREE: Record<string, Node> = {
  '/lib': { kind: 'dir' },
  '/lib/Videos': { kind: 'dir' },
  '/lib/Videos/Oldboy (2003)': { kind: 'dir' },
  '/lib/Videos/Oldboy (2003)/Oldboy.mkv': { kind: 'file', size: 10 },
  '/lib/Videos/Oldboy (2003)/Oldboy.srt': { kind: 'file', size: 1 },
  '/lib/Videos/clip.mp4': { kind: 'file', size: 5 },
  '/lib/Videos/link-to-elsewhere': { kind: 'other' },
  '/lib/Telegram': { kind: 'dir' },
  '/lib/Telegram/Film.2026.mkv': { kind: 'file', size: 20 },
  '/elsewhere': { kind: 'dir' },
  '/elsewhere/Secret.2020.mkv': { kind: 'file', size: 30 },
};

describe('walkRoots', () => {
  it('walks exactly the given roots, recursively, and returns only video files', async () => {
    const result = await walkRoots(['/lib/Videos', '/lib/Telegram'], { fs: memFs(TREE) });
    expect(result.files.map((f) => [f.path, f.relPath, f.size])).toEqual([
      ['/lib/Telegram/Film.2026.mkv', 'Film.2026.mkv', 20],
      ['/lib/Videos/Oldboy (2003)/Oldboy.mkv', 'Oldboy (2003)/Oldboy.mkv', 10],
      ['/lib/Videos/clip.mp4', 'clip.mp4', 5],
    ]);
    expect(result.unreadable).toEqual([]);
  });

  it('reports a root or directory it cannot read instead of throwing', async () => {
    const result = await walkRoots(['/lib/Videos', '/missing'], { fs: memFs(TREE, ['/lib/Videos/Oldboy (2003)']) });
    expect(result.unreadable.sort()).toEqual(['/lib/Videos/Oldboy (2003)', '/missing']);
    expect(result.files.map((f) => f.path)).toEqual(['/lib/Videos/clip.mp4']);
  });

  it('lists a file under two nested roots once', async () => {
    const result = await walkRoots(['/lib', '/lib/Videos'], { fs: memFs(TREE) });
    const paths = result.files.map((f) => f.path);
    expect(paths).toHaveLength(new Set(paths).size);
    expect(paths).toContain('/lib/Videos/clip.mp4');
  });
});

describe('probeDuration', () => {
  let dir: string;

  async function fakeFfprobe(name: string, script: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${script}\n`);
    await chmod(file, 0o755);
    return file;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-probe-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the duration ffprobe prints', async () => {
    const bin = await fakeFfprobe('ok', 'echo 7198.750000');
    await expect(probeDuration(bin, '/x/Oldboy.mkv')).resolves.toBe(7198.75);
  });

  it('fails a file whose duration is unknown', async () => {
    const bin = await fakeFfprobe('na', 'echo N/A');
    await expect(probeDuration(bin, '/x/a.mkv')).rejects.toMatchObject({ code: 'failed' });
  });

  it('fails a file ffprobe cannot read', async () => {
    const bin = await fakeFfprobe('bad', 'echo "Invalid data found" >&2; exit 1');
    await expect(probeDuration(bin, '/x/a.mkv')).rejects.toBeInstanceOf(ProbeError);
    await expect(probeDuration(bin, '/x/a.mkv')).rejects.toMatchObject({ code: 'failed' });
  });

  it('tells a missing ffprobe apart from a bad file', async () => {
    await expect(probeDuration(path.join(dir, 'no-such-ffprobe'), '/x/a.mkv')).rejects.toMatchObject({ code: 'missing_binary' });
  });

  it('gives up on a stuck probe after the timeout', async () => {
    const bin = await fakeFfprobe('stuck', 'sleep 5');
    await expect(probeDuration(bin, '/x/a.mkv', { timeoutMs: 200 })).rejects.toMatchObject({ code: 'failed' });
  });
});
