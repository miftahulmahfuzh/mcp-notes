import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubtitleShelf } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import { filesTier, orderByFileLists, rankSubtitleFiles, subtitleFlavor, subtitleLanguage, type CandidateFileList } from '../../../../../src/directStream/torrent/subtitles/files.js';
import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import { REST_OF_CONTEXT } from './context.js';
import type { TorrentFileInfo } from '../../../../../src/directStream/torrent/types.js';

const VIDEO = 'Film.2010.1080p.mp4';
const file = (index: number, p: string, length = 1000): TorrentFileInfo => ({ index, path: p, name: p.split('/').pop()!, length });

describe('subtitleLanguage', () => {
  it.each([
    ['Film/Film.2010.1080p.en.srt', 'en'],
    ['Film/Film.2010.1080p.eng.srt', 'en'],
    ['Film/English.srt', 'en'],
    ['Film/Subs/2_English.srt', 'en'],
    ['Film/Subs/Film.2010.1080p/3_English.srt', 'en'],
    ['Film/Subs/English/1.srt', 'en'],
    ['Film/Film.2010.1080p.en.sdh.srt', 'en'],
    ['Film/Film.2010.1080p.fr.srt', 'other'],
    ['Film/Subs/4_French.srt', 'other'],
    ['Film/Film.2010.1080p.srt', null],
  ])('%s -> %s', (p, want) => {
    expect(subtitleLanguage(p, VIDEO)).toBe(want);
  });

  it('does not read the title as a language', () => {
    expect(subtitleLanguage('The.French.Dispatch.2021.srt', 'The.French.Dispatch.2021.mp4')).toBeNull();
    expect(subtitleLanguage('The.French.Dispatch.2021.en.srt', 'The.French.Dispatch.2021.mp4')).toBe('en');
  });

  it('reads the flavour', () => {
    expect(subtitleFlavor('Film.en.sdh.srt')).toBe('sdh');
    expect(subtitleFlavor('Film.eng.forced.srt')).toBe('forced');
    expect(subtitleFlavor('Film.en.srt')).toBe('plain');
  });
});

describe('rankSubtitleFiles (R3.1)', () => {
  it('puts plain English first, SubRip before ASS, SDH after, and never a forced file', () => {
    const files = [file(0, 'Film/Film.mp4', 9e8), file(1, 'Film/Film.en.sdh.srt', 900), file(2, 'Film/Film.en.srt', 500), file(3, 'Film/Film.fr.srt'), file(4, 'Film/Film.en.forced.srt'), file(5, 'Film/Film.en.ass')];
    const picks = rankSubtitleFiles(files, [1, 2, 3, 4, 5], 'Film.mp4');
    expect(picks.map((p) => [p.file.index, p.lang, p.label])).toEqual([
      [2, 'en', 'English'],
      [5, 'en', 'English'],
      [1, 'en', 'English SDH'],
    ]);
  });

  it('takes the one subtitle file that names no language, and nothing when there are two or it names another', () => {
    expect(rankSubtitleFiles([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.srt')], [1], 'Film.mp4')).toEqual([{ file: file(1, 'Film/Film.srt'), lang: null, label: '' }]);
    expect(rankSubtitleFiles([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.srt'), file(2, 'Film/Film.2.srt')], [1, 2], 'Film.mp4')).toEqual([]);
    expect(rankSubtitleFiles([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.fr.srt')], [1], 'Film.mp4')).toEqual([]);
  });
});

describe('orderByFileLists (R3.2)', () => {
  const list = (subs: string[]): CandidateFileList => ({ files: [file(0, 'Film/Film.mp4'), ...subs.map((s, i) => file(i + 1, s))], video: 0, subtitles: subs.map((_, i) => i + 1) });
  const cands = [{ infoHash: 'a', name: 'A' }, { infoHash: 'b', name: 'B' }, { infoHash: 'c', name: 'C' }, { infoHash: 'd', name: 'D' }];

  it('moves the first of the best three with an English file to the front and releases the others', async () => {
    const released: string[] = [];
    const lists: Record<string, CandidateFileList | null> = { a: list([]), b: null, c: list(['Film/Film.en.srt']), d: list(['Film/Film.en.srt']) };
    const out = await orderByFileLists(cands, { listFiles: async (c) => lists[c.infoHash] ?? null, release: (h) => void released.push(h) });
    expect(out.map((c) => c.infoHash)).toEqual(['c', 'a', 'b', 'd']);
    expect(released.sort()).toEqual(['a', 'b']);
  });

  it('keeps the order when the first already has one, or none has', async () => {
    const released: string[] = [];
    const out = await orderByFileLists(cands, { listFiles: async (c) => (c.infoHash === 'a' ? list(['Film/English.srt']) : list([])), release: (h) => void released.push(h) });
    expect(out.map((c) => c.infoHash)).toEqual(['a', 'b', 'c', 'd']);
    expect(released.sort()).toEqual(['b', 'c']);
    expect((await orderByFileLists(cands, { listFiles: async () => list([]), release: () => undefined })).map((c) => c.infoHash)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('opens nothing for a single candidate', async () => {
    let opened = 0;
    await orderByFileLists([cands[0]!], { listFiles: async () => (opened++, null), release: () => undefined });
    expect(opened).toBe(0);
  });
});

describe('filesTier', () => {
  const HASH = 'b'.repeat(40);
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-files-'));
    await mkdir(path.join(dir, 'dl'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = (files: TorrentFileInfo[], subs: number[]): SubtitleContext => ({
    ...REST_OF_CONTEXT,
    ref: { kind: 'movie', tmdbId: 1 }, imdbId: 'tt0000001', infoHash: HASH, release: 'Film.2010', files, fileIndex: 0, subtitleIndexes: subs, handle: null, cloudTried: false,
  });

  it('waits for the English file to complete, converts it and keeps it', async () => {
    const srt = path.join(dir, 'dl', 'Film.en.srt');
    await writeFile(srt, '1\r\n00:00:01,000 --> 00:00:30,000\r\nTorrent subtitle line one\r\n');
    let asks = 0;
    const tier = filesTier({
      torrents: { filePath: (_h, i) => (i === 1 && ++asks >= 3 ? srt : null) },
      shelf: new SubtitleShelf(path.join(dir, 'torrents')),
      convertAss: async () => null,
      pollMs: 1,
    });
    const found = await tier.find(ctx([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.en.srt')], [1]));
    expect(found).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/file-1.vtt`, lang: 'en', label: 'English' }]);
    expect(asks).toBeGreaterThanOrEqual(3);
  });

  it('reads ASS through the converter', async () => {
    const ass = path.join(dir, 'dl', 'Film.eng.ass');
    await writeFile(ass, '[Script Info]\n');
    const seen: string[] = [];
    const tier = filesTier({
      torrents: { filePath: () => ass },
      shelf: new SubtitleShelf(path.join(dir, 'torrents')),
      convertAss: async (f) => (seen.push(f), 'WEBVTT\n\n00:01.000 --> 00:02.000\nASS subtitle line\n'),
    });
    expect(await tier.find(ctx([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.eng.ass')], [1]))).toHaveLength(1);
    expect(seen).toEqual([ass]);
  });

  it('gives up after the bounded wait and answers nothing', async () => {
    let clock = 0;
    const tier = filesTier({
      torrents: { filePath: () => null },
      shelf: new SubtitleShelf(path.join(dir, 'torrents')),
      convertAss: async () => null,
      waitMs: 1000,
      pollMs: 250,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    expect(await tier.find(ctx([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.en.srt')], [1]))).toEqual([]);
    expect(clock).toBe(1000);
  });
});
