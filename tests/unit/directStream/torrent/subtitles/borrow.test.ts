import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { borrowTier } from '../../../../../src/directStream/torrent/subtitles/borrow.js';
import { SubtitleShelf } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import { REST_OF_CONTEXT } from './context.js';

const HASH = 'd'.repeat(40);
let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-borrow-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const ctx = (cloudTried = false): SubtitleContext => ({
  ...REST_OF_CONTEXT,
  ref: { kind: 'movie', tmdbId: 7 }, imdbId: 'tt0000007', infoHash: HASH, release: 'Film', files: [], fileIndex: 0, subtitleIndexes: [], handle: null, cloudTried,
});

describe('borrowTier (R3.3)', () => {
  it('keeps a cloud provider\'s English subtitle as borrow.vtt, labelled with the provider, with one WEBVTT header', async () => {
    const asked: number[] = [];
    const tier = borrowTier({
      shelf: new SubtitleShelf(dir),
      lend: () => async (_ref, o) => (asked.push(o.deadlineS), { provider: 'VidLink', label: 'English', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne.\n\nWEBVTT\n\n00:00:03.000 --> 00:00:04.000\nTwo.\n' }),
    });
    expect(await tier.find(ctx())).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/borrow.vtt`, lang: 'en', label: 'English (VidLink)' }]);
    expect(asked).toEqual([45]);
    const saved = await readFile(path.join(dir, HASH, '.notesd-subs', 'borrow.vtt'), 'utf8');
    expect(saved.match(/WEBVTT/g)).toHaveLength(1);
    expect(saved).toContain('Two.');
  });

  it('asks nothing after a cloud no_source, or without direct streaming', async () => {
    let asked = 0;
    const lend = async () => (asked++, { provider: 'X', label: 'English', vtt: '' });
    expect(await borrowTier({ shelf: new SubtitleShelf(dir), lend: () => lend }).find(ctx(true))).toEqual([]);
    expect(await borrowTier({ shelf: new SubtitleShelf(dir), lend: () => null }).find(ctx())).toEqual([]);
    expect(asked).toBe(0);
  });

  it('throws on a failed or late borrow (the chain records it; the play goes on)', async () => {
    await expect(borrowTier({ shelf: new SubtitleShelf(dir), lend: () => async () => { throw new Error('no_source'); } }).find(ctx())).rejects.toThrow('no_source');
    await expect(borrowTier({ shelf: new SubtitleShelf(dir), deadlineS: 0, graceMs: 5, lend: () => () => new Promise(() => undefined) }).find(ctx())).rejects.toThrow(/no subtitle within/);
  });
});
