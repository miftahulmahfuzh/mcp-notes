import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepAudioLeftovers } from '../../../src/directStream/leftovers.js';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-leftovers-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sweepAudioLeftovers', () => {
  it('deletes leftover WAVs and empty notesd-sync folders, and nothing else', async () => {
    const torrents = path.join(dir, 'torrents');
    const hash = path.join(torrents, 'a'.repeat(40));
    await mkdir(path.join(hash, 'notesd-sync'), { recursive: true });
    await mkdir(path.join(hash, 'notesd-whisper'), { recursive: true });
    await mkdir(path.join(hash, '.notesd-subs'), { recursive: true });
    await writeFile(path.join(hash, 'notesd-sync', 'x-0.wav'), '');
    await writeFile(path.join(hash, 'notesd-whisper', 'x-300.wav'), '');
    await writeFile(path.join(hash, 'notesd-whisper', 'x-0.json'), '{}');
    await writeFile(path.join(hash, '.notesd-subs', 'file-1.vtt'), 'WEBVTT');
    await writeFile(path.join(hash, 'Film.wav'), 'a file of the torrent');
    const titles = path.join(dir, 'stream-subs');
    await mkdir(path.join(titles, 'movie-550', 'notesd-sync'), { recursive: true });
    await writeFile(path.join(titles, 'movie-550', 'notesd-sync', 'movie-550-0.wav'), '');
    const check = path.join(dir, 'subtitle-check');
    await mkdir(check, { recursive: true });
    await writeFile(path.join(check, 'movie-550-60-1.wav'), '');
    const lines: string[] = [];
    expect(await sweepAudioLeftovers({ perItem: [torrents, titles, path.join(dir, 'missing')], flat: [check] }, (l) => lines.push(l))).toBe(6);
    expect((await readdir(hash)).sort()).toEqual(['.notesd-subs', 'Film.wav', 'notesd-whisper']);
    expect(await readdir(path.join(hash, 'notesd-whisper'))).toEqual(['x-0.json']);
    expect(await readdir(path.join(titles, 'movie-550'))).toEqual([]);
    expect(await readdir(check)).toEqual([]);
    expect(lines).toEqual(['[notesd] swept 4 leftover WAV file(s) and 2 empty notesd-sync folder(s)']);
  });
});
