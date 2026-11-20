import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUBTITLE_RANK, SubtitleShelf, keptTier, subtitleRank, vttFromBytes } from '../../../../../src/directStream/torrent/subtitles/disk.js';

const HASH = 'a'.repeat(40);
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello.\n';
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-subs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SubtitleShelf', () => {
  it('keeps a saved track under <hash>/.notesd-subs and answers it as the chosen one', async () => {
    const shelf = new SubtitleShelf(dir);
    const view = await shelf.save(HASH, 'file-1.vtt', VTT, { lang: 'en', label: 'English' });
    expect(view).toEqual({ url: `/api/stream/torrent/${HASH}/sub/file-1.vtt`, lang: 'en', label: 'English' });
    expect(await readFile(path.join(dir, HASH, '.notesd-subs', 'file-1.vtt'), 'utf8')).toBe(VTT);
    expect(await shelf.kept(HASH)).toEqual([view]);
    expect(await keptTier(shelf).find({ infoHash: HASH } as never)).toEqual([view]);
  });

  it('answers nothing kept when the chosen file is gone or chosen.json is not ours', async () => {
    const shelf = new SubtitleShelf(dir);
    await shelf.save(HASH, 'file-1.vtt', VTT, { lang: 'en', label: 'English' });
    await rm(path.join(dir, HASH, '.notesd-subs', 'file-1.vtt'));
    expect(await shelf.kept(HASH)).toEqual([]);
    await writeFile(path.join(dir, HASH, '.notesd-subs', 'chosen.json'), '[{"name":"../../etc/passwd","lang":null,"label":""}]');
    expect(await shelf.kept(HASH)).toEqual([]);
  });

  it('a choice from outside the release never takes the place of a file of the release or a checked one', async () => {
    const shelf = new SubtitleShelf(dir);
    const own = await shelf.save(HASH, 'file-1.vtt', VTT, { lang: 'en', label: 'English' });
    await shelf.save(HASH, 'synced-0.vtt', VTT, { lang: 'en', label: 'English (Wyzie, synced)' });
    await shelf.save(HASH, 'service-wyzie-1.vtt', VTT, { lang: 'en', label: 'English (Wyzie)' });
    expect(await shelf.kept(HASH)).toEqual([own]);
    const checked = await shelf.save(HASH, 'checked-0-ab12.vtt', VTT, { lang: 'en', label: 'English (checked)' });
    await shelf.save(HASH, 'file-2.vtt', VTT, { lang: 'en', label: 'English' });
    expect(await shelf.kept(HASH)).toEqual([checked]);
  });

  it('a kept choice from outside the release is provisional; the release\'s own or a checked one is not', async () => {
    const shelf = new SubtitleShelf(dir);
    const tier = keptTier(shelf);
    expect(tier.provisional?.([{ url: `/api/stream/torrent/${HASH}/sub/synced-0.vtt`, lang: 'en', label: '' }])).toBe(true);
    expect(tier.provisional?.([{ url: `/api/stream/torrent/${HASH}/sub/file-3.vtt`, lang: 'en', label: '' }])).toBe(false);
    expect(tier.provisional?.([{ url: `/api/stream/torrent/${HASH}/sub/checked-3-ab.vtt`, lang: 'en', label: '' }])).toBe(false);
    expect(subtitleRank(`/api/stream/torrent/${HASH}/cues/embedded-0-2`)).toBe(SUBTITLE_RANK.embedded);
    expect(subtitleRank(`/api/stream/torrent/${HASH}/cues/whisper-0`)).toBe(SUBTITLE_RANK.outside);
  });

  it('never names a file outside the folder', () => {
    const shelf = new SubtitleShelf(dir);
    expect(shelf.file(HASH, '../x.vtt')).toBeNull();
    expect(shelf.file(HASH, 'chosen.json')).toBeNull();
    expect(shelf.file('../../etc', 'file-1.vtt')).toBeNull();
    expect(shelf.file(HASH, 'service-3871796.vtt')).toBe(path.join(dir, HASH, '.notesd-subs', 'service-3871796.vtt'));
  });
});

describe('vttFromBytes', () => {
  it('converts SubRip, reads Windows-1252, and refuses a file without cues', () => {
    expect(vttFromBytes(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi.\r\n'))).toContain('00:00:01.000 --> 00:00:02.000');
    expect(vttFromBytes(Buffer.from([0x31, 0x0a, ...Buffer.from('00:00:01,000 --> 00:00:02,000\n'), 0x43, 0x61, 0x66, 0xe9, 0x0a]))).toContain('Café');
    expect(vttFromBytes(Buffer.from('not a subtitle'))).toBeNull();
  });
});
