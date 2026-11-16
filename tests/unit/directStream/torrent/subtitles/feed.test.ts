import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CUES_DIR, CUES_PER_READ, CueFeeds, cleanCue, cueFeedUrl, parseFeedFile } from '../../../../../src/directStream/torrent/subtitles/feed.js';

const HASH = 'c'.repeat(40);
let dir: string;
let feeds: CueFeeds;
const lines: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-cues-'));
  lines.length = 0;
  feeds = new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: (l) => lines.push(l) });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a cue feed', () => {
  it('answers what was appended, from an index on, and says when it is complete', async () => {
    const feed = await feeds.start(HASH, 'embedded-2');
    void feed.append([{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }]);
    expect(feed.read(0)).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: false });
    void feed.append([{ start_s: 7, end_s: 9, text: 'Line 3' }]);
    expect(feed.read(2)).toEqual({ cues: [{ start_s: 7, end_s: 9, text: 'Line 3' }], next: 3, complete: false });
    await feed.complete();
    expect(feed.read(3)).toEqual({ cues: [], next: 3, complete: true });
    // A complete feed takes nothing more.
    await feed.append([{ start_s: 10, end_s: 11, text: 'late' }]);
    expect(feed.size).toBe(3);
  });

  it('never moves a reader back, even past the end', async () => {
    const feed = await feeds.start(HASH, 'whisper');
    await feed.append([{ start_s: 1, end_s: 2, text: 'a' }]);
    expect(feed.read(5)).toEqual({ cues: [], next: 5, complete: false });
  });

  it('answers at most CUES_PER_READ cues and is not complete until the reader has them all', async () => {
    const feed = await feeds.start(HASH, 'embedded-3');
    await feed.append(Array.from({ length: CUES_PER_READ + 5 }, (_, i) => ({ start_s: i, end_s: i + 0.5, text: `c${i}` })));
    await feed.complete();
    const first = feed.read(0);
    expect(first.cues).toHaveLength(CUES_PER_READ);
    expect(first.complete).toBe(false);
    expect(feed.read(first.next)).toMatchObject({ next: CUES_PER_READ + 5, complete: true });
  });

  it('keeps only cues with text and length, to the millisecond', () => {
    expect(cleanCue({ start_s: 1.00049, end_s: 2.5, text: ' Hi\r\nthere ' })).toEqual({ start_s: 1, end_s: 2.5, text: 'Hi\nthere' });
    expect(cleanCue({ start_s: 2, end_s: 2, text: 'zero' })).toBeNull();
    expect(cleanCue({ start_s: 1, end_s: 2, text: '  ' })).toBeNull();
    expect(cleanCue({ start_s: Number.NaN, end_s: 2, text: 'x' })).toBeNull();
  });

  it('is on disk in the torrent folder, and a new CueFeeds reads it back for a replay', async () => {
    const feed = await feeds.start(HASH, 'embedded-2');
    await feed.append([{ start_s: 1, end_s: 3, text: '<i>Line 1</i>' }]);
    await feed.complete();
    const file = path.join(dir, HASH, CUES_DIR, 'embedded-2.jsonl');
    expect(await readFile(file, 'utf8')).toBe('{"start_s":1,"end_s":3,"text":"<i>Line 1</i>"}\n{"complete":true}\n');
    const again = await new CueFeeds({ folderOf: (hash) => path.join(dir, hash) }).get(HASH, 'embedded-2');
    expect(again?.read(0)).toEqual({ cues: [{ start_s: 1, end_s: 3, text: '<i>Line 1</i>' }], next: 1, complete: true });
  });

  it('reads a file cut off mid-line as an incomplete feed, and start() empties it', async () => {
    await mkdir(path.join(dir, HASH, CUES_DIR), { recursive: true });
    await writeFile(path.join(dir, HASH, CUES_DIR, 'embedded-2.jsonl'), '{"start_s":1,"end_s":3,"text":"a"}\n{"start_s":4,"end_s');
    expect(parseFeedFile('{"start_s":1,"end_s":3,"text":"a"}\n{"start_s":4,"end_s')).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'a' }], complete: false });
    const torn = await feeds.get(HASH, 'embedded-2');
    expect(torn?.isComplete).toBe(false);
    const fresh = await feeds.start(HASH, 'embedded-2');
    expect(fresh.size).toBe(0);
    expect(await feeds.get(HASH, 'embedded-2')).toBe(fresh);
  });

  it('answers null for a feed this machine does not have', async () => {
    expect(await feeds.get(HASH, 'embedded-9')).toBeNull();
    expect(cueFeedUrl(HASH, 'whisper')).toBe(`/api/stream/torrent/${HASH}/cues/whisper`);
  });
});
