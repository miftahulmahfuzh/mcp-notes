import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddedSubtitles,
  VttCueReader,
  chooseEmbeddedTrack,
  embeddedTier,
  extractArgs,
  trackLabel,
  type EmbeddedTrackInfo,
  type ExtractorProcess,
} from '../../../../../src/directStream/torrent/subtitles/embedded.js';
import { CueFeeds } from '../../../../../src/directStream/torrent/subtitles/feed.js';

const HASH = 'b'.repeat(40);
const sub = (index: number, codec: string, lang: string | null, extra: Partial<EmbeddedTrackInfo> = {}): EmbeddedTrackInfo => ({ index, codec, lang, ...extra });

class FakeFfmpeg extends EventEmitter implements ExtractorProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** ffmpeg writes, then exits: stdout ends before `close`, as with a real child. */
  async exit(code: number, stderrText = ''): Promise<void> {
    if (stderrText !== '') this.stderr.write(stderrText);
    this.stdout.end();
    this.stderr.end();
    await new Promise((r) => setImmediate(r));
    this.emit('close', code, null);
  }
}

describe('chooseEmbeddedTrack', () => {
  it('takes no picture track, whatever its language (R3.5)', () => {
    expect(chooseEmbeddedTrack([sub(2, 'hdmv_pgs_subtitle', 'eng'), sub(3, 'dvd_subtitle', 'eng'), sub(4, 'dvb_subtitle', 'en')])).toBeNull();
    expect(chooseEmbeddedTrack([])).toBeNull();
  });

  it('takes English text tracks only', () => {
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'fre'), sub(3, 'hdmv_pgs_subtitle', 'eng')])).toBeNull();
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'fre'), sub(3, 'hdmv_pgs_subtitle', 'eng'), sub(4, 'subrip', 'eng')])?.index).toBe(4);
    expect(chooseEmbeddedTrack([sub(5, 'mov_text', null, { title: 'English' })])?.index).toBe(5);
  });

  it('prefers a full track over SDH, SubRip over ASS, and leaves a forced track unless it is the only one', () => {
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { hearingImpaired: true }), sub(3, 'subrip', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { title: 'English SDH' }), sub(3, 'ass', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'ass', 'eng'), sub(3, 'subrip', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { forced: true }), sub(3, 'subrip', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { title: 'Forced' })])?.index).toBe(2);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { forced: true }), sub(3, 'ass', 'eng', { forced: true })])).toBeNull();
  });

  it('names the track by its title when it says something', () => {
    expect(trackLabel(sub(2, 'subrip', 'eng', { title: 'English SDH' }))).toBe('English SDH');
    expect(trackLabel(sub(2, 'subrip', 'eng', { title: 'eng' }))).toBe('English');
    expect(trackLabel(sub(2, 'subrip', 'eng'))).toBe('English');
  });
});

describe('VttCueReader', () => {
  it('gives each cue once its block has ended, across chunk boundaries', () => {
    const reader = new VttCueReader();
    expect(reader.push('WEBVTT\n\n00:01.000 --> 00:03.000\n<i>Line 1</i> & more\n')).toEqual([]);
    expect(reader.push('\n00:04.000 --> 00:0')).toEqual([{ start_s: 1, end_s: 3, text: '<i>Line 1</i> & more' }]);
    expect(reader.push('6.000\nLine 2\nsecond row\n\n01:02:03.500 --> 01:02:05.000\nLate')).toEqual([{ start_s: 4, end_s: 6, text: 'Line 2\nsecond row' }]);
    expect(reader.end()).toEqual([{ start_s: 3723.5, end_s: 3725, text: 'Late' }]);
  });
});

describe('extractArgs', () => {
  it('keeps the file\'s own times and waits out a slow route, over HTTP only', () => {
    const http = extractArgs('http://127.0.0.1:7317/api/stream/torrent/x/f/0', 2, 300);
    expect(http).toEqual(['-v', 'error', '-nostdin', '-copyts', '-reconnect', '1', '-reconnect_delay_max', '30', '-rw_timeout', '300000000', '-i', 'http://127.0.0.1:7317/api/stream/torrent/x/f/0', '-map', '0:2', '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', 'pipe:1']);
    expect(extractArgs('/data/film.mkv', 3)).toEqual(['-v', 'error', '-nostdin', '-copyts', '-i', '/data/film.mkv', '-map', '0:3', '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', 'pipe:1']);
  });
});

describe('EmbeddedSubtitles with a fake ffmpeg', () => {
  let dir: string;
  let feeds: CueFeeds;
  let spawned: { bin: string; args: string[]; child: FakeFfmpeg }[];
  let lines: string[];
  let subs: EmbeddedSubtitles;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-embedded-'));
    feeds = new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} });
    spawned = [];
    lines = [];
    subs = new EmbeddedSubtitles({
      ffmpegBin: '/bin/ffmpeg-fake',
      feeds,
      input: async (hash, index) => `http://127.0.0.1:1/api/stream/torrent/${hash}/f/${index}`,
      spawn: (bin, args) => {
        const child = new FakeFfmpeg();
        spawned.push({ bin, args, child });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      log: (l) => lines.push(l),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fills the feed as ffmpeg writes, and marks it complete when ffmpeg ends cleanly (R3.4)', async () => {
    const feed = await subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    expect(feed?.track).toBe('embedded-0-2');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain(`http://127.0.0.1:1/api/stream/torrent/${HASH}/f/0`);
    const child = spawned[0]!.child;
    child.stdout.write('WEBVTT\n\n00:01.000 --> 00:03.000\nLine 1\n\n');
    await vi.waitFor(() => expect(feed?.read(0).cues).toEqual([{ start_s: 1, end_s: 3, text: 'Line 1' }]));
    expect(feed?.isComplete).toBe(false);
    child.stdout.write('00:04.000 --> 00:06.000\nLine 2\n');
    await child.exit(0);
    await vi.waitFor(() => expect(feed?.read(0)).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: true }));
  });

  it('runs one extraction per track, and a replay reuses a complete feed without ffmpeg', async () => {
    const [a, b] = await Promise.all([subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng')), subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'))]);
    expect(a).toBe(b);
    expect(spawned).toHaveLength(1);
    await spawned[0]!.child.exit(0);
    await vi.waitFor(() => expect(a?.isComplete).toBe(true));
    // complete() on a complete feed answers its pending disk write: the file is whole after this.
    await a?.complete();
    const fresh = new EmbeddedSubtitles({ ffmpegBin: 'x', feeds: new CueFeeds({ folderOf: (hash) => path.join(dir, hash) }), input: async () => 'x', spawn: () => { throw new Error('ffmpeg must not run'); } });
    const kept = await fresh.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    expect(kept?.isComplete).toBe(true);
  });

  it('leaves a stopped extraction incomplete and starts it over on the next play', async () => {
    const first = await subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    spawned[0]!.child.stdout.write('00:01.000 --> 00:03.000\nLine 1\n\n');
    await spawned[0]!.child.exit(1, 'http://127.0.0.1/...: Server returned 404 Not Found\n');
    await vi.waitFor(() => expect(lines.some((l) => l.includes('stopped after 1 cues (exit 1: http://127.0.0.1/...: Server returned 404 Not Found)'))).toBe(true));
    expect(first?.isComplete).toBe(false);
    const second = await subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    expect(spawned).toHaveLength(2);
    expect(second?.size).toBe(0);
  });

  it('answers null when ffmpeg cannot start', async () => {
    const broken = new EmbeddedSubtitles({
      ffmpegBin: '/nowhere/ffmpeg',
      feeds,
      input: async () => '/data/film.mkv',
      spawn: () => {
        const child = new FakeFfmpeg();
        queueMicrotask(() => child.emit('error', new Error('spawn /nowhere/ffmpeg ENOENT')));
        return child;
      },
      log: () => {},
    });
    expect(await broken.feedOf(HASH, 0, sub(2, 'subrip', 'eng'))).toBeNull();
  });

  it('the tier answers the feed as a growing English subtitle', async () => {
    const tier = embeddedTier(subs);
    const views = await tier.find({ infoHash: HASH, fileIndex: 0, probe: { subtitles: [sub(2, 'hdmv_pgs_subtitle', 'eng'), sub(3, 'subrip', 'eng', { title: 'English SDH', hearingImpaired: true })] } } as never);
    expect(views).toEqual([{ url: `/api/stream/torrent/${HASH}/cues/embedded-0-3`, lang: 'en', label: 'English SDH', growing: true }]);
  });

  it('the tier answers nothing for picture tracks only, so the chain goes on, and runs no ffmpeg (R3.5)', async () => {
    const tier = embeddedTier(subs);
    const views = await tier.find({ infoHash: HASH, fileIndex: 0, probe: { subtitles: [sub(2, 'hdmv_pgs_subtitle', 'eng'), sub(3, 'dvd_subtitle', 'eng')] } } as never);
    expect(views).toEqual([]);
    expect(spawned).toHaveLength(0);
    expect(lines).toContain(`[notesd] torrent: no English text subtitle track in bbbbbbbb (hdmv_pgs_subtitle/eng, dvd_subtitle/eng); the next subtitle tier is asked`);
    expect(await tier.find({ infoHash: HASH, fileIndex: 0, probe: { subtitles: [] } } as never)).toEqual([]);
    expect(tier.blocks).toBe(false);
  });
});
