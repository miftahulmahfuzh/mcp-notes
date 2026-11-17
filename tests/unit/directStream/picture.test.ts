import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import {
  PICTURE_BAD_TTL_MS,
  PICTURE_CLEAN_TTL_MS,
  PICTURE_SYSTEM_PROMPT,
  PictureCheck,
  PictureVerdicts,
  createPictureJudge,
  firstFrameOf,
  hlsStreamReach,
  firstVariant,
  isBadPicture,
  parsePictureAnswer,
  passesOver,
  segmentAt,
  tsSyncOffset,
  type PictureFinding,
  type PictureJudge,
} from '../../../src/directStream/picture.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 1419406 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 787 };
const source = (provider: string): ResolvedSource => ({
  provider,
  embed_url: `https://${provider.toLowerCase()}.example/e`,
  manifest_url: `https://cdn-${provider.toLowerCase()}.example/master.m3u8`,
  manifest_kind: 'hls',
  headers: { referer: 'https://embed.example/', origin: null, user_agent: 'UA/1' },
  subtitles: [],
  best_height: 1080,
  en_subtitle: false,
  took_s: 5,
});

let dir: string;
let now: Date;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'picture-'));
  now = new Date('2026-11-16T12:00:00Z');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const verdicts = () => new PictureVerdicts(path.join(dir, 'movies', 'stream-pictures.json'), () => now);
const judgeOf = (answer: (frames: readonly Buffer[], title: string) => PictureFinding | Promise<PictureFinding>): PictureJudge & { calls: [number, string][] } => {
  const calls: [number, string][] = [];
  return {
    model: 'haiku',
    calls,
    judge: async (frames, title) => {
      calls.push([frames.length, title]);
      return answer(frames, title);
    },
  };
};

describe("reading the model's answer", () => {
  it('takes the one line of JSON, with or without words around it', () => {
    expect(parsePictureAnswer('{"verdict": "watermark", "reason": "1XBET logo top right"}')).toEqual({ verdict: 'watermark', reason: '1XBET logo top right' });
    expect(parsePictureAnswer('Here you go:\n```json\n{"verdict":"clean","reason":"proper copy"}\n```')).toEqual({ verdict: 'clean', reason: 'proper copy' });
    expect(parsePictureAnswer('{"verdict":"recording"}')).toEqual({ verdict: 'recording', reason: '' });
  });

  it('is unsure about anything else', () => {
    for (const text of ['', 'It looks fine to me.', '{"verdict": "great"}', '{verdict: clean}']) expect(parsePictureAnswer(text).verdict).toBe('unsure');
    expect(isBadPicture('watermark') && isBadPicture('recording')).toBe(true);
    expect(isBadPicture('clean') || isBadPicture('unsure')).toBe(false);
  });

  it('tells the model what is not a fault', () => {
    expect(PICTURE_SYSTEM_PROMPT).toMatch(/subtitles in any language/);
    expect(PICTURE_SYSTEM_PROMPT).toMatch(/belongs to the scene/);
  });
});

describe('the kept verdicts', () => {
  it('keeps one per title and provider on disk, an episode apart from another', async () => {
    const first = verdicts();
    await first.set(FILM, 'NexaStream', { verdict: 'watermark', reason: '1XBET logo' }, 'haiku');
    await first.set(FILM, 'VidLink', { verdict: 'clean', reason: '' }, 'haiku');
    await first.set(EPISODE, 'VidLink', { verdict: 'recording', reason: 'tilted' }, 'haiku');
    const again = verdicts();
    expect(await again.get(FILM, 'nexastream')).toMatchObject({ verdict: 'watermark', reason: '1XBET logo', provider: 'NexaStream', model: 'haiku' });
    expect(await again.badFor(FILM)).toEqual(['NexaStream']);
    expect(await again.badFor(EPISODE)).toEqual(['VidLink']);
    expect(await again.get({ ...EPISODE, episode: 788 }, 'VidLink')).toBeNull();
    expect(Object.keys(JSON.parse(await readFile(path.join(dir, 'movies', 'stream-pictures.json'), 'utf8')))).toHaveLength(3);
  });

  it('forgets a rejected stream after 14 days and a clean one after 60', async () => {
    const v = verdicts();
    await v.set(FILM, 'Bad', { verdict: 'recording', reason: '' }, 'haiku');
    await v.set(FILM, 'Good', { verdict: 'clean', reason: '' }, 'haiku');
    now = new Date(now.getTime() + PICTURE_BAD_TTL_MS + 1000);
    expect(await v.get(FILM, 'Bad')).toBeNull();
    expect(await v.badFor(FILM)).toEqual([]);
    expect((await v.get(FILM, 'Good'))?.verdict).toBe('clean');
    now = new Date(now.getTime() + PICTURE_CLEAN_TTL_MS);
    expect(await v.get(FILM, 'Good')).toBeNull();
  });
});

describe('the picture check', () => {
  it('reads the frames, asks once, keeps the verdict and answers it without asking again', async () => {
    const grab = vi.fn(async (_s: ResolvedSource, at: number) => Buffer.from(`frame@${at}`));
    const judge = judgeOf(() => ({ verdict: 'watermark', reason: '1XBET logo top right' }));
    const check = new PictureCheck({ verdicts: verdicts(), grab, judge, log: () => undefined });
    expect(await check.check(FILM, source('NexaStream'), "The Shadow's Edge (2025)")).toEqual({ verdict: 'watermark', reason: '1XBET logo top right', kept: false, unreadable: false });
    expect(grab.mock.calls.map((c) => c[1])).toEqual([240, 900]);
    expect(judge.calls).toEqual([[2, "The Shadow's Edge (2025)"]]);
    expect(await check.check(FILM, source('NexaStream'), 'x')).toMatchObject({ verdict: 'watermark', kept: true });
    expect(judge.calls).toHaveLength(1);
    expect(await check.badFor(FILM)).toEqual(['NexaStream']);
  });

  it('judges the one frame it could read, and is unsure without any, without a call', async () => {
    const judge = judgeOf(() => ({ verdict: 'clean', reason: '' }));
    const one = new PictureCheck({ verdicts: verdicts(), grab: async (_s, at) => (at === 240 ? null : Buffer.from('f')), judge, log: () => undefined });
    expect((await one.check(FILM, source('A'), 't')).verdict).toBe('clean');
    expect(judge.calls).toEqual([[1, 't']]);
    const none = new PictureCheck({ verdicts: verdicts(), grab: async () => null, judge, log: () => undefined });
    const unread = await none.check(FILM, source('B'), 't');
    expect(unread).toMatchObject({ verdict: 'unsure', kept: false, unreadable: true });
    // A stream nothing can be read from is passed over like a rejected one, a stream the model could not judge is not.
    expect(passesOver(unread)).toBe(true);
    expect(passesOver({ verdict: 'unsure', reason: 'black frame', kept: false, unreadable: false })).toBe(false);
    expect(passesOver({ verdict: 'recording', reason: '', kept: true, unreadable: false })).toBe(true);
    expect(judge.calls).toHaveLength(1);
  });

  it('plays a stream no frame could be decoded from when its host hands out a segment, and passes over one it does not', async () => {
    const judge = judgeOf(() => ({ verdict: 'clean', reason: '' }));
    const reach = vi.fn(async (s: ResolvedSource, _atS: number) => s.provider === 'VidNest');
    const check = new PictureCheck({ verdicts: verdicts(), grab: async () => null, reach, judge, log: () => undefined });
    // Fake Profile S02E01: VidNest's stream played well, and four other providers were asked first for 129 s.
    const decoded = await check.check(EPISODE, source('VidNest'), 't');
    expect(decoded).toEqual({ verdict: 'unsure', reason: 'no frame could be decoded, and the stream host delivers', kept: false, unreadable: false });
    expect(passesOver(decoded)).toBe(false);
    expect(passesOver(await check.check(EPISODE, source('HyperLink'), 't'))).toBe(true);
    expect(reach.mock.calls.map((c) => c[1])).toEqual([240, 240]);
    expect(await check.badFor(EPISODE)).toEqual(['HyperLink']);
    expect(judge.calls).toHaveLength(0);
  });

  it('reaches an HLS stream by the first bytes of a segment, with the captured headers', async () => {
    const asked: [string, unknown][] = [];
    const host = (segment: () => Response): typeof fetch => async (input, init) => {
      const url = String(input);
      asked.push([url, (init?.headers as Record<string, string>).referer]);
      if (url.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n1080/index.m3u8\n');
      if (url.endsWith('index.m3u8')) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:300,\nseg0.m4s\n#EXTINF:300,\nseg1.m4s\n');
      return segment();
    };
    // Fragmented MP4, encrypted: nothing ffmpeg reads here, and the host delivers it all the same.
    expect(await hlsStreamReach({ fetch: host(() => new Response(new Uint8Array(64))) })(source('A'), 400)).toBe(true);
    expect(asked.at(-1)).toEqual(['https://cdn-a.example/1080/seg1.m4s', 'https://embed.example/']);
    expect(await hlsStreamReach({ fetch: host(() => new Response('', { status: 403 })) })(source('A'), 400)).toBe(false);
    expect(await hlsStreamReach({ fetch: async () => { throw new Error('ENOTFOUND'); } })(source('A'), 400)).toBe(false);
    expect(await hlsStreamReach({ fetch: host(() => new Response(new Uint8Array(64))) })({ ...source('A'), manifest_kind: 'dash' }, 400)).toBe(false);
  });

  it('never keeps unsure and never throws: a model that fails is unsure, and the next play asks again', async () => {
    let fail = true;
    const judge = judgeOf(() => {
      if (fail) throw new Error('the model answered nothing');
      return { verdict: 'unsure', reason: 'black frame' };
    });
    const check = new PictureCheck({ verdicts: verdicts(), grab: async () => Buffer.from('f'), judge, log: () => undefined });
    expect(await check.check(FILM, source('A'), 't')).toEqual({ verdict: 'unsure', reason: 'the model answered nothing', kept: false, unreadable: false });
    fail = false;
    expect((await check.check(FILM, source('A'), 't')).verdict).toBe('unsure');
    expect(judge.calls).toHaveLength(2);
    expect(await check.badFor(FILM)).toEqual([]);
  });
});

describe('reading a frame from a segment', () => {
  it('finds the segment that holds a second, the last one for a shorter film, and the first rendition of a master', () => {
    const media = ['#EXTM3U', '#EXTINF:10.4,', 'a.ts', '#EXTINF:10.4,', '/abs/b.ts', '#EXTINF:5,', 'https://img.example/obj/c'].join('\n');
    expect(segmentAt(media, 'https://cdn.example/v/index.m3u8', 0)).toBe('https://cdn.example/v/a.ts');
    expect(segmentAt(media, 'https://cdn.example/v/index.m3u8', 12)).toBe('https://cdn.example/abs/b.ts');
    expect(segmentAt(media, 'https://cdn.example/v/index.m3u8', 900)).toBe('https://img.example/obj/c');
    expect(segmentAt('#EXTM3U', 'https://cdn.example/x.m3u8', 0)).toBeNull();
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080', '', '1080/index.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2', '720/index.m3u8'].join('\n');
    expect(firstVariant(master, 'https://cdn.example/m/master.m3u8')).toBe('https://cdn.example/m/1080/index.m3u8');
    expect(firstVariant(media, 'https://cdn.example/v/index.m3u8')).toBeNull();
  });

  it('finds the transport stream behind a picture file put in front of it', () => {
    const ts = new Uint8Array(188 * 4);
    for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
    expect(tsSyncOffset(ts)).toBe(0);
    const wrapped = new Uint8Array(120 + ts.length);
    wrapped.set([0x89, 0x50, 0x4e, 0x47], 0);
    wrapped.set(ts, 120);
    expect(tsSyncOffset(wrapped)).toBe(120);
    expect(tsSyncOffset(new Uint8Array(4000))).toBe(-1);
  });

  it('asks each grabber in turn until one reads the frame', async () => {
    const asked: string[] = [];
    const grab = firstFrameOf(
      async () => (asked.push('ffmpeg'), null),
      async () => (asked.push('segment'), Buffer.from('f')),
      async () => (asked.push('never'), null),
    );
    expect((await grab(source('A'), 240))?.toString()).toBe('f');
    expect(asked).toEqual(['ffmpeg', 'segment']);
  });
});

describe('the judge on the Agent SDK', () => {
  it('sends the frames as images with the title, with no tools and one turn, and reads the answer', async () => {
    const seen: { content: unknown; options: Record<string, unknown> }[] = [];
    const query: QueryFn = ({ prompt, options }) =>
      (async function* run() {
        for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) seen.push({ content: message.message.content, options: options as Record<string, unknown> });
        yield { type: 'result', subtype: 'success', is_error: false, result: '{"verdict":"recording","reason":"screen edge visible"}' } as never;
      })();
    const judge = createPictureJudge({ claudeBin: process.execPath, cwd: path.join(dir, 'cwd'), model: 'haiku', query });
    expect(judge).not.toBeNull();
    expect(await judge?.judge([Buffer.from('one'), Buffer.from('two')], 'Fake Film (2026)')).toEqual({ verdict: 'recording', reason: 'screen edge visible' });
    const content = seen[0]?.content;
    const options = seen[0]?.options;
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('one').toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('two').toString('base64') } },
      { type: 'text', text: '2 frames from a stream of Fake Film (2026). Is it a proper copy?' },
    ]);
    expect(options).toMatchObject({ model: 'haiku', tools: [], allowedTools: [], maxTurns: 1, persistSession: false, systemPrompt: PICTURE_SYSTEM_PROMPT });
  });

  it('rejects when the model fails, and is null without a claude binary', async () => {
    const query: QueryFn = () =>
      (async function* run() {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['overloaded'] } as never;
      })();
    const judge = createPictureJudge({ claudeBin: process.execPath, cwd: path.join(dir, 'cwd'), model: 'haiku', query });
    await expect(judge?.judge([Buffer.from('f')], 't')).rejects.toThrow('overloaded');
    expect(createPictureJudge({ claudeBin: path.join(dir, 'no-such-claude'), cwd: dir, model: 'haiku', baseEnv: { PATH: dir } })).toBeNull();
  });
});
